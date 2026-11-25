// Dynamic tool registry. A tool is:
//   { name, description, parameters (schema), permission: 'auto'|'confirm'|'deny', sideEffects, timeoutMs,
//     available?(ctx) -> true | string(reason), assess?(args, ctx) -> {decision, reason, category},
//     summarize?(args) -> string, scanArgs?, scanFields?, run(args, ctx) -> {ok, data?, error?, verified?, verification?} }
import { assertValidSchema, validate, toGeminiSchema } from './schema.mjs';
import { ToolError } from './errors.mjs';
import { redact, redactDeep } from './redact.mjs';

const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
const PERMISSIONS = new Set(['auto', 'confirm', 'deny']);
export const MAX_RESULT_CHARS = 6000;

export class ToolRegistry {
  #tools = new Map();

  register(def) {
    if (!def || !NAME_RE.test(def.name || '')) throw new Error(`Invalid tool name: ${def?.name}`);
    if (this.#tools.has(def.name)) throw new Error(`Tool already registered: ${def.name}`);
    if (!def.description || def.description.length < 10) throw new Error(`${def.name}: description is required`);
    if (typeof def.run !== 'function') throw new Error(`${def.name}: run() is required`);
    const permission = def.permission ?? 'confirm'; // safe default: ask
    if (!PERMISSIONS.has(permission)) throw new Error(`${def.name}: invalid permission "${permission}"`);
    const parameters = def.parameters ?? { type: 'object', properties: {} };
    if (parameters.type !== 'object') throw new Error(`${def.name}: parameters must be an object schema`);
    assertValidSchema(parameters, `${def.name}.parameters`);
    const timeoutMs = def.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error(`${def.name}: timeoutMs out of range`);
    this.#tools.set(def.name, Object.freeze({ sideEffects: false, ...def, permission, parameters, timeoutMs }));
    return this;
  }

  unregister(name) { return this.#tools.delete(name); }
  has(name) { return this.#tools.has(name); }
  get(name) { return this.#tools.get(name); }
  names() { return [...this.#tools.keys()]; }

  availability(tool, ctx = {}) {
    if (tool.permission === 'deny') return { available: false, reason: 'Disabled by policy.' };
    if (!tool.available) return { available: true };
    let r;
    try { r = tool.available(ctx); } catch { r = 'Availability check failed.'; }
    return r === true ? { available: true } : { available: false, reason: typeof r === 'string' ? r : 'Not available.' };
  }

  list(ctx = {}) {
    return [...this.#tools.values()].map((t) => ({
      name: t.name, description: t.description, permission: t.permission, sideEffects: t.sideEffects,
      timeoutMs: t.timeoutMs, ...this.availability(t, ctx),
    }));
  }

  unavailable(ctx = {}) {
    return this.list(ctx).filter((t) => !t.available && t.permission !== 'deny').map((t) => ({ name: t.name, reason: t.reason }));
  }

  // Only tools that are usable right now are offered to the model.
  declarations(ctx = {}) {
    return [...this.#tools.values()]
      .filter((t) => this.availability(t, ctx).available)
      .map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) }));
  }

  validateArgs(name, rawArgs) {
    const tool = this.#tools.get(name);
    if (!tool) return { ok: false, errors: [`No tool named "${name}"`] };
    return validate(tool.parameters, rawArgs ?? {});
  }

  // Always resolves to a structured result; never throws.
  async execute(name, rawArgs, ctx = {}) {
    const started = Date.now();
    const done = (r) => ({ tool: name, durationMs: Date.now() - started, ...r });
    const fail = (code, message, retryable = false) => done({ ok: false, error: { code, message, retryable }, verified: null });
    const tool = this.#tools.get(name);
    if (!tool) return fail('UNKNOWN_TOOL', `No tool named "${name}".`);
    const v = validate(tool.parameters, rawArgs ?? {});
    if (!v.ok) return fail('INVALID_ARGUMENTS', v.errors.join('; '));
    const avail = this.availability(tool, ctx);
    if (!avail.available) return fail('TOOL_UNAVAILABLE', avail.reason || 'Tool is not available.');
    try {
      const raw = await this.#runWithTimeout(tool, v.value, ctx);
      if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean') {
        return fail('BAD_TOOL_RESULT', `Tool "${name}" returned an invalid result.`);
      }
      if (!raw.ok) {
        const e = raw.error || {};
        return done({ ok: false, error: { code: String(e.code || 'TOOL_FAILED'), message: redact(String(e.message || 'Tool failed.')).slice(0, 500), retryable: !!e.retryable }, verified: raw.verified ?? null, verification: raw.verification ?? null, data: capData(raw.data) });
      }
      return done({ ok: true, data: capData(raw.data), verified: raw.verified ?? null, verification: raw.verification ?? null });
    } catch (e) {
      if (e instanceof ToolError) return fail(e.code, redact(e.message).slice(0, 500), e.retryable);
      return fail('TOOL_EXCEPTION', `Tool "${name}" failed unexpectedly.`);
    }
  }

  async #runWithTimeout(tool, args, ctx) {
    const controller = new AbortController();
    let timer;
    let onAbort;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new ToolError('TIMEOUT', `Tool "${tool.name}" timed out after ${tool.timeoutMs} ms.`, { retryable: true });
        controller.abort(e);
        reject(e);
      }, tool.timeoutMs);
      if (ctx.signal) {
        onAbort = () => {
          const e = new ToolError('CANCELLED', 'The task was cancelled.');
          controller.abort(e);
          reject(e);
        };
        if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([Promise.resolve().then(() => tool.run(args, { ...ctx, signal: controller.signal })), guard]);
    } finally {
      clearTimeout(timer);
      if (ctx.signal && onAbort) ctx.signal.removeEventListener('abort', onAbort);
    }
  }
}

function capData(data) {
  if (data === undefined) return null;
  const safe = redactDeep(data);
  let text;
  try { text = JSON.stringify(safe); } catch { return { truncated: true, preview: '[unserializable result]' }; }
  if (text.length <= MAX_RESULT_CHARS) return safe;
  return { truncated: true, preview: text.slice(0, MAX_RESULT_CHARS) };
}
