// EV Agent engine.
//   request -> understand -> plan -> select tool -> check permission -> execute -> observe -> verify -> continue/finish
// The model proposes tool calls; this code validates them, applies policy, asks the user when needed,
// executes with timeouts, feeds the observation back, and enforces step/time limits.
import { AgentError } from './errors.mjs';
import { redact, redactDeep } from './redact.mjs';
import { evaluate } from './policy.mjs';
import { buildAgentSystemPrompt } from './prompt.mjs';
import { generate as geminiGenerate, DEFAULT_MODEL } from './gemini.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  maxSteps: 8,            // model calls per task
  maxToolCalls: 12,       // tool executions per task
  runBudgetMs: 60_000,    // active time per run segment (waiting for approval does not count)
  modelTimeoutMs: 25_000,
  modelRetries: 2,
  retryDelayMs: 500,
  approvalTtlMs: 5 * 60_000,
  maxHistoryMessages: 12,
  maxMessageChars: 4000,
  maxEvents: 120,
});

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

export class AgentEngine {
  #handles = new Map(); // taskId -> { abort: AbortController, cancelled: boolean }

  constructor({
    registry, store, env = {}, toolEnv = {}, fetchImpl = globalThis.fetch, generate = geminiGenerate,
    now = () => Date.now(), sleep = defaultSleep, config = {}, logger = console, newId = () => crypto.randomUUID(),
  }) {
    this.registry = registry;
    this.store = store;
    this.env = env;           // engine-only (model key lives here, never given to tools)
    this.toolEnv = Object.freeze({ ...toolEnv }); // the only env tools can see
    this.fetchImpl = fetchImpl;
    this.generate = generate;
    this.now = now;
    this.sleep = sleep;
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
    this.newId = newId;
  }

  // ---------- public API ----------

  async startTask({ userId, text, history = [], profile = {}, context = {} }) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new AgentError('EMPTY_REQUEST', 'Tell me what you need.', { status: 400 });
    if (clean.length > this.cfg.maxMessageChars) throw new AgentError('REQUEST_TOO_LONG', `Requests are limited to ${this.cfg.maxMessageChars} characters.`, { status: 400 });

    const memories = (await this.store.listMemories(userId)).map((m) => m.text);
    const systemInstruction = buildAgentSystemPrompt({
      profile, context, memories, unavailable: this.registry.unavailable(this.#toolContext({ userId })), now: this.now(),
    });
    const contents = this.#normalizeHistory(history);
    pushMerged(contents, 'user', clean);

    const t = iso(this.now());
    const task = {
      id: this.newId(), userId, status: 'queued', text: redact(clean, { numbers: true }).slice(0, 500),
      createdAt: t, updatedAt: t, startedAt: null, finishedAt: null,
      progress: { phase: 'queued', modelCalls: 0, maxSteps: this.cfg.maxSteps },
      events: [], executions: [], pendingApprovalId: null, result: null, error: null,
      _internal: { systemInstruction, contents, queue: [], responseParts: [], modelCalls: 0, malformed: 0 },
    };
    await this.store.createTask(task);
    this.#event(task, 'task', 'Task created');
    return task;
  }

  // Runs (or resumes) a task until it finishes, fails, or needs approval.
  async run(taskId) {
    const task = await this.store.getTask(taskId);
    if (!task) throw new AgentError('TASK_NOT_FOUND', 'Task not found.', { status: 404 });
    if (TERMINAL.has(task.status) || task.status === 'awaiting_approval') return task;
    if (this.#handles.has(task.id)) return task;
    return this.#drive(task);
  }

  // Records the user's decision. Fast; returns the task and a resume() that continues the loop.
  async resolveApproval({ approvalId, userId, decision }) {
    if (decision !== 'approve' && decision !== 'reject') throw new AgentError('INVALID_DECISION', 'Decision must be "approve" or "reject".', { status: 400 });
    const claim = await this.store.claimApproval(approvalId, userId, decision, this.now());
    if (!claim.ok && claim.code !== 'APPROVAL_EXPIRED') {
      throw new AgentError(claim.code, claim.code === 'APPROVAL_NOT_FOUND' ? 'Approval not found.' : 'This approval was already resolved.', { status: claim.code === 'APPROVAL_NOT_FOUND' ? 404 : 409 });
    }
    const approval = claim.approval;
    const task = await this.store.getTask(approval.taskId);
    const head = task?._internal?.queue?.[0];
    if (!task || task.status !== 'awaiting_approval' || task.pendingApprovalId !== approval.id || !head) {
      throw new AgentError('TASK_NOT_AWAITING', 'That task is no longer waiting for approval.', { status: 409 });
    }
    if (!claim.ok) {
      await this.#respond(task, head, failResult(head.name, 'APPROVAL_EXPIRED', 'The approval window expired, so the action was not performed.'), { status: 'rejected' });
      this.#event(task, 'approval', 'Approval expired');
    } else if (decision === 'reject') {
      await this.#respond(task, head, failResult(head.name, 'USER_REJECTED', 'The user declined this action. Do not retry it; offer an alternative.'), { status: 'rejected' });
      this.#event(task, 'approval', 'User declined the action');
    } else {
      head.approved = true;
      head.approvalId = approval.id;
      this.#event(task, 'approval', 'User approved the action');
    }
    task.pendingApprovalId = null;
    task.status = 'running';
    task.progress = { ...task.progress, phase: 'resuming' };
    await this.store.saveTask(task);
    return { task, resume: () => this.run(task.id) };
  }

  async cancel(taskId, userId) {
    const task = await this.store.getTask(taskId);
    if (!task || task.userId !== userId) throw new AgentError('TASK_NOT_FOUND', 'Task not found.', { status: 404 });
    if (TERMINAL.has(task.status)) return task;
    const h = this.#handles.get(taskId);
    if (h) { h.cancelled = true; h.abort.abort(new AgentError('CANCELLED', 'The task was cancelled.')); }
    await this.store.expireApprovalsForTask(taskId, 'cancelled');
    await this.#finish(task, 'cancelled', { result: { text: 'Task cancelled.' } });
    return task;
  }

  // Task as returned to clients: no internal model transcript, approval details inlined.
  async view(task) {
    const { _internal, ...pub } = task;
    if (task.status === 'awaiting_approval' && task.pendingApprovalId) {
      const a = await this.store.getApproval(task.pendingApprovalId);
      if (a) pub.pendingApproval = { id: a.id, tool: a.tool, summary: a.summary, category: a.category, reason: a.reason, args: a.argsPreview, expiresAt: iso(a.expiresAt) };
    }
    return pub;
  }

  // ---------- main loop ----------

  async #drive(task) {
    const h = { abort: new AbortController(), cancelled: false };
    this.#handles.set(task.id, h);
    const deadline = this.now() + this.cfg.runBudgetMs;
    const st = task._internal;
    try {
      task.status = 'running';
      task.startedAt ??= iso(this.now());
      await this.store.saveTask(task);

      for (;;) {
        const stop = this.#checkpoint(h, deadline);
        if (stop) return await this.#finishStopped(task, stop);

        if (st.queue.length) {
          const outcome = await this.#processQueue(task, h, deadline);
          if (outcome === 'awaiting_approval') return task;
          if (outcome === 'cancelled' || outcome === 'timed_out') return await this.#finishStopped(task, outcome);
        }
        // Commit buffered observations as ONE user turn once every call of the model turn is answered.
        // (Also covers rejection/expiry, where resolveApproval answers the last pending call itself.)
        if (!st.queue.length && st.responseParts.length) {
          const stop2 = this.#checkpoint(h, deadline);
          if (stop2) return await this.#finishStopped(task, stop2);
          st.contents.push({ role: 'user', parts: st.responseParts });
          st.responseParts = [];
          await this.store.saveTask(task);
        }

        if (st.modelCalls >= this.cfg.maxSteps) {
          return await this.#fail(task, 'STEP_LIMIT', `I stopped after ${this.cfg.maxSteps} steps without finishing. Try a smaller request.`);
        }

        const resp = await this.#callModel(task, h, deadline);
        st.modelCalls += 1;
        task.progress = { ...task.progress, modelCalls: st.modelCalls };

        if (resp.malformed) {
          st.malformed += 1;
          this.#event(task, 'model', 'Model produced a malformed tool call; retrying');
          if (st.malformed > 2) return await this.#fail(task, 'MODEL_MALFORMED_CALL', 'The AI produced invalid tool calls repeatedly.');
          continue;
        }
        if (resp.content) st.contents.push(resp.content);

        if (!resp.functionCalls.length) {
          if (!resp.text) return await this.#fail(task, 'EMPTY_RESPONSE', 'The AI returned an empty answer.');
          return await this.#finish(task, 'completed', { result: { text: resp.text } });
        }
        st.queue = resp.functionCalls.map((c, i) => ({
          callId: `${task.id.slice(0, 8)}-${st.modelCalls}-${i}`,
          name: this.registry.toolNameForModel(c.name) ?? c.name,
          modelName: c.name,
          args: c.args,
          geminiId: c.id,
        }));
        st.responseParts = [];
        this.#event(task, 'model', `Plan: ${st.queue.map((c) => c.name).join(', ')}`);
      }
    } catch (e) {
      if (h.cancelled) return await this.#finishStopped(task, 'cancelled');
      if (e instanceof AgentError && e.code === 'DEADLINE') return await this.#finishStopped(task, 'timed_out');
      if (e instanceof AgentError) return await this.#fail(task, e.code, e.message, e.details);
      this.logger.error?.('[agent] unexpected error:', redact(String(e?.stack || e)));
      return await this.#fail(task, 'INTERNAL_ERROR', 'Something went wrong inside the agent.');
    } finally {
      this.#handles.delete(task.id);
    }
  }

  async #callModel(task, h, deadline) {
    const st = task._internal;
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new AgentError('DEADLINE', 'Out of time.');
      try {
        this.#progress(task, 'thinking');
        const tools = this.registry.declarations(this.#toolContext(task, h));
        const resp = await this.generate({
          apiKey: this.env.GEMINI_API_KEY, model: this.env.GEMINI_MODEL || DEFAULT_MODEL,
          systemInstruction: st.systemInstruction, contents: st.contents, tools, fetchImpl: this.fetchImpl,
          timeoutMs: Math.min(this.cfg.modelTimeoutMs, remaining), signal: h.abort.signal,
        });
        if (h.cancelled) throw new AgentError('CANCELLED', 'The task was cancelled.');
        return resp;
      } catch (e) {
        if (h.cancelled) throw new AgentError('CANCELLED', 'The task was cancelled.');
        if (e instanceof AgentError && e.retryable && attempt < this.cfg.modelRetries) {
          this.#event(task, 'model', `AI service error (${e.code}); retrying`);
          await this.sleep(this.cfg.retryDelayMs * 2 ** attempt);
          continue;
        }
        throw e;
      }
    }
  }

  async #processQueue(task, h, deadline) {
    const st = task._internal;
    while (st.queue.length) {
      const stop = this.#checkpoint(h, deadline);
      if (stop) return stop;
      const call = st.queue[0];

      if (task.executions.length >= this.cfg.maxToolCalls) {
        await this.#respond(task, call, failResult(call.name, 'TOOL_BUDGET_EXHAUSTED', 'Tool-call limit reached for this task. Summarize what you have.'), { status: 'rejected' });
        continue;
      }
      const tool = this.registry.get(call.name);
      if (!tool) {
        await this.#respond(task, call, failResult(call.name, 'UNKNOWN_TOOL', `There is no tool named "${call.name}". Use only the tools you were given.`), { status: 'invalid' });
        continue;
      }
      const v = this.registry.validateArgs(call.name, call.args);
      if (!v.ok) {
        await this.#respond(task, call, failResult(call.name, 'INVALID_ARGUMENTS', v.errors.join('; ')), { status: 'invalid' });
        continue;
      }
      call.args = v.value;
      const tctx = this.#toolContext(task, h);
      const avail = this.registry.availability(tool, tctx);
      if (!avail.available) {
        await this.#respond(task, call, failResult(call.name, 'TOOL_UNAVAILABLE', avail.reason || 'Tool unavailable.'), { status: 'unavailable' });
        continue;
      }
      const verdict = evaluate(tool, call.args, tctx);
      if (verdict.decision === 'deny') {
        await this.#respond(task, call, failResult(call.name, 'POLICY_DENIED', verdict.reason || 'Blocked by policy.'), { status: 'denied' });
        this.#event(task, 'policy', `Blocked ${call.name}: ${verdict.category}`);
        continue;
      }
      if (verdict.decision === 'confirm' && !call.approved) {
        const approval = await this.#requestApproval(task, call, verdict);
        task.status = 'awaiting_approval';
        task.pendingApprovalId = approval.id;
        task.progress = { ...task.progress, phase: 'awaiting_approval' };
        this.#event(task, 'approval', `Waiting for approval: ${approval.summary}`);
        await this.store.saveTask(task);
        return 'awaiting_approval';
      }

      this.#progress(task, 'running_tool', call.name);
      this.#event(task, 'tool', `Running ${call.name}`);
      const startedAt = this.now();
      const result = await this.registry.execute(call.name, call.args, tctx);
      if (h.cancelled) return 'cancelled';

      let status = result.ok ? 'succeeded' : result.error?.code === 'TIMEOUT' ? 'timeout' : 'failed';
      if (result.ok && tool.sideEffects && result.verified !== true) { status = 'unverified'; result.verified = false; }
      await this.#respond(task, call, result, { status, startedAt, sideEffects: tool.sideEffects });
    }
    return 'done';
  }

  // ---------- helpers ----------

  async #respond(task, call, result, meta = {}) {
    const st = task._internal;
    st.queue.shift();
    const payload = {
      ok: !!result.ok, tool: call.name, verified: result.verified ?? null, verification: result.verification ?? null,
      error: result.error ?? null, untrusted_data: result.data ?? null,
    };
    if (meta.sideEffects) payload.note = 'This action counts as done only if ok is true and verified is true.';
    st.responseParts.push({ functionResponse: { name: call.modelName ?? call.name, ...(call.geminiId ? { id: call.geminiId } : {}), response: JSON.parse(JSON.stringify(payload)) } });

    const started = meta.startedAt ?? this.now();
    task.executions.push({
      id: call.callId, tool: call.name, status: meta.status ?? (result.ok ? 'succeeded' : 'failed'), ok: !!result.ok,
      verified: result.verified ?? null, sideEffects: !!meta.sideEffects,
      args: argsPreview(call.args, call.name), error: result.error ? { code: result.error.code, message: redact(String(result.error.message || '')).slice(0, 300) } : null,
      startedAt: iso(started), finishedAt: iso(this.now()), durationMs: Math.max(0, this.now() - started), approvalId: call.approvalId ?? null,
    });
    this.#event(task, 'tool', `${call.name}: ${meta.status ?? (result.ok ? 'succeeded' : 'failed')}`);
    await this.store.saveTask(task);
  }

  async #requestApproval(task, call, verdict) {
    const approval = {
      id: this.newId(), taskId: task.id, userId: task.userId, callId: call.callId, tool: call.name,
      summary: redact(verdict.summary || `Run ${call.name}`), category: verdict.category, reason: verdict.reason,
      argsPreview: argsPreview(call.args, call.name), status: 'pending', createdAt: iso(this.now()),
      expiresAt: this.now() + this.cfg.approvalTtlMs, decidedAt: null,
    };
    await this.store.createApproval(approval);
    return approval;
  }

  #checkpoint(h, deadline) {
    if (h.cancelled) return 'cancelled';
    if (this.now() > deadline) return 'timed_out';
    return null;
  }

  async #finishStopped(task, reason) {
    if (TERMINAL.has(task.status)) return task;
    if (reason === 'cancelled') return this.#finish(task, 'cancelled', { result: { text: 'Task cancelled.' } });
    return this.#finish(task, 'timed_out', { error: { code: 'TASK_TIMEOUT', message: 'The task ran out of time before finishing.' } });
  }

  async #fail(task, code, message, details) {
    if (details) this.logger.warn?.('[agent] task failed', task.id, code, redact(JSON.stringify(details)));
    return this.#finish(task, 'failed', { error: { code, message: redact(message) } });
  }

  async #finish(task, status, { result = null, error = null } = {}) {
    if (TERMINAL.has(task.status)) return task;
    const done = task.executions;
    task.status = status;
    task.finishedAt = iso(this.now());
    task.pendingApprovalId = null;
    task.progress = { ...task.progress, phase: status };
    task.error = error;
    task.result = result && {
      ...result,
      toolsUsed: [...new Set(done.map((e) => e.tool))],
      unverifiedActions: done.filter((e) => e.status === 'unverified').map((e) => ({ id: e.id, tool: e.tool })),
      failedActions: done.filter((e) => ['failed', 'timeout', 'denied', 'rejected'].includes(e.status)).map((e) => ({ id: e.id, tool: e.tool, code: e.error?.code ?? e.status })),
    };
    task._internal = null; // free the model transcript
    this.#event(task, 'task', `Task ${status}`);
    await this.store.expireApprovalsForTask(task.id, status === 'cancelled' ? 'cancelled' : 'expired');
    await this.store.saveTask(task);
    return task;
  }

  #toolContext(task, h) {
    return {
      userId: task.userId, taskId: task.id, env: this.toolEnv, fetch: this.fetchImpl, store: this.store,
      signal: h?.abort.signal, now: this.now,
    };
  }

  #progress(task, phase, detail) { task.progress = { ...task.progress, phase, detail: detail ?? null }; }

  #event(task, kind, message) {
    task.events.push({ at: iso(this.now()), kind, message: redact(message).slice(0, 300) });
    if (task.events.length > this.cfg.maxEvents) task.events.splice(0, task.events.length - this.cfg.maxEvents);
  }

  #normalizeHistory(history) {
    const out = [];
    for (const m of (Array.isArray(history) ? history : []).slice(-this.cfg.maxHistoryMessages)) {
      if (!m || typeof m !== 'object') continue;
      const role = m.role === 'user' ? 'user' : (m.role === 'model' || m.role === 'assistant') ? 'model' : null;
      const text = typeof m.text === 'string' ? m.text.trim().slice(0, this.cfg.maxMessageChars) : '';
      if (role && text) pushMerged(out, role, text);
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }
}

function pushMerged(contents, role, text) {
  const last = contents[contents.length - 1];
  if (last && last.role === role) last.parts[0].text += `\n\n${text}`;
  else contents.push({ role, parts: [{ text }] });
}

function failResult(tool, code, message) {
  return { tool, ok: false, error: { code, message, retryable: false }, verified: null, data: null };
}

function argsPreview(args, toolName) {
  if (toolName === 'android.type_text') {
    args = { target: args?.target, text: '[not stored]' };
  } else if (toolName === 'android.search_in_app') {
    args = { ...args, query: '[not stored]' };
  }
  let s;
  try { s = JSON.stringify(redactDeep(args, { numbers: true })); } catch { s = '{}'; }
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}
