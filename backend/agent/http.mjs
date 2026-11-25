// Runtime-neutral HTTP API. handle({method, pathname, headers, body, ip}) -> {status, json} | null.
// Returns null for paths outside /api/agent so the host server can continue routing.
// Auth: owner passphrase -> short-lived signed bearer token (scope "owner"). Every route except login needs it.
import { AgentError } from './errors.mjs';
import { signToken, verifyToken, bearerFrom, safeEqual, RateLimiter } from './auth.mjs';
import { cleanLabel } from './prompt.mjs';

const OWNER = 'owner';
const ok = (json, status = 200) => ({ status, json: { ok: true, ...json } });
const err = (status, code, message) => ({ status, json: { ok: false, code, message } });

function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return '';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return ''; }
}

export function createAgentApi({ engine, store, registry, adapters, env = {}, waitUntil = (p) => { p.catch(() => {}); }, now = () => Date.now() }) {
  const loginLimiter = new RateLimiter({ limit: 5, windowMs: 60_000, now });
  // Backstop in case a client spoofs its IP: caps attempts across everyone (single-owner app).
  const globalLoginLimiter = new RateLimiter({ limit: 30, windowMs: 10 * 60_000, now });
  const taskLimiter = new RateLimiter({ limit: 15, windowMs: 60_000, now });
  const ttlSeconds = Math.min(72, Math.max(1, Number(env.EV_SESSION_TTL_HOURS) || 12)) * 3600;
  const secret = String(env.EV_SESSION_SECRET || '');
  const passphrase = String(env.EV_OWNER_PASSPHRASE || '');
  const authConfigured = secret.length >= 32 && passphrase.length >= 12;

  async function route({ method, pathname, headers, body, ip }) {
    const seg = pathname.replace(/\/+$/, '').slice('/api/agent'.length).split('/').filter(Boolean);
    const [a, b, c] = seg;

    if (!authConfigured) {
      return err(503, 'AUTH_NOT_CONFIGURED', 'Agent access is not configured. Set EV_SESSION_SECRET (32+ chars) and EV_OWNER_PASSPHRASE (12+ chars) on the server.');
    }

    if (a === 'login' && seg.length === 1) {
      if (method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      if (!globalLoginLimiter.take('login:*') || !loginLimiter.take(`login:${ip}`)) return err(429, 'RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
      const good = typeof body?.passphrase === 'string' && await safeEqual(body.passphrase, passphrase);
      if (!good) return err(401, 'INVALID_CREDENTIALS', 'Invalid credentials.');
      const { token, expiresAt } = await signToken({ sub: OWNER, scope: 'owner' }, secret, { ttlSeconds, now: now() });
      return ok({ token, expiresAt });
    }

    const claims = await verifyToken(bearerFrom(headers), secret, { scope: 'owner', now: now() });
    if (!claims || claims.sub !== OWNER) return err(401, 'UNAUTHORIZED', 'Sign in to use the agent.');
    const userId = claims.sub;

    if (a === 'status' && seg.length === 1) {
      if (method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      return ok({
        model: {
          configured: Boolean(env.GEMINI_API_KEY),
          name: String(env.GEMINI_MODEL || 'gemini-3.8-flash'),
          functionCalling: 'gemini-function-declarations',
        },
        adapters: adapters.status(),
        tools: registry.list({ env: engine.toolEnv, userId }),
        limits: { maxSteps: engine.cfg.maxSteps, maxToolCalls: engine.cfg.maxToolCalls, approvalTtlMs: engine.cfg.approvalTtlMs },
        persistence: { type: 'in_memory', durable: false, note: 'Tasks, approvals, and saved memories are lost when the backend restarts.' },
      });
    }

    if (a === 'tools' && seg.length === 1) {
      if (method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      return ok({ tools: registry.list({ env: engine.toolEnv, userId }) });
    }

    if (a === 'tasks') {
      if (seg.length === 1 && method === 'GET') {
        const tasks = await store.listTasks(userId, 30);
        return ok({ tasks: tasks.map((t) => ({ id: t.id, status: t.status, text: t.text, createdAt: t.createdAt, finishedAt: t.finishedAt, progress: t.progress })) });
      }
      if (seg.length === 1 && method === 'POST') {
        if (!taskLimiter.take(`task:${userId}`)) return err(429, 'RATE_LIMITED', 'Too many tasks. Slow down for a minute.');
        const task = await engine.startTask({
          userId, text: body?.text, history: Array.isArray(body?.history) ? body.history.slice(-20) : [],
          profile: { name: cleanLabel(body?.profile?.name), language: typeof body?.profile?.language === 'string' ? body.profile.language.slice(0, 5) : 'auto', style: body?.profile?.style === 'detailed' ? 'detailed' : 'short' },
          context: { timeZone: validTimeZone(body?.context?.timeZone), voice: body?.context?.voice === true },
        });
        if (body?.wait === true) {
          await engine.run(task.id);
          return ok({ task: await engine.view(task) });
        }
        waitUntil(engine.run(task.id));
        return ok({ task: await engine.view(task) }, 202);
      }
      if (b && seg.length === 2 && method === 'GET') {
        const task = await ownTask(b, userId);
        return ok({ task: await engine.view(task) });
      }
      if (b && c === 'cancel' && seg.length === 3 && method === 'POST') {
        await ownTask(b, userId);
        const task = await engine.cancel(b, userId);
        return ok({ task: await engine.view(task) });
      }
      return err(seg.length > 1 && !['GET', 'POST'].includes(method) ? 405 : 404, 'NOT_FOUND', 'No such route.');
    }

    if (a === 'approvals' && b && seg.length === 2 && method === 'POST') {
      const { task, resume } = await engine.resolveApproval({ approvalId: b, userId, decision: body?.decision });
      if (body?.wait === true) await resume(); else waitUntil(resume());
      return ok({ task: await engine.view(task) });
    }

    if (a === 'memory') {
      if (seg.length === 1 && method === 'GET') {
        return ok({ memories: (await store.listMemories(userId)).map(({ id, text, createdAt }) => ({ id, text, createdAt })) });
      }
      if (b === 'delete' && seg.length === 2 && method === 'POST') {
        if (typeof body?.id !== 'string' || !body.id) return err(400, 'INVALID_REQUEST', 'Provide the memory id.');
        return ok({ deleted: await store.deleteMemory(userId, body.id) });
      }
    }
    return err(404, 'NOT_FOUND', 'No such route.');
  }

  async function ownTask(id, userId) {
    const task = await store.getTask(id);
    if (!task || task.userId !== userId) throw new AgentError('TASK_NOT_FOUND', 'Task not found.', { status: 404 });
    return task;
  }

  return async function handle(req) {
    const pathname = String(req.pathname || '');
    if (pathname !== '/api/agent' && !pathname.startsWith('/api/agent/')) return null;
    try {
      return await route({ method: String(req.method || 'GET').toUpperCase(), pathname, headers: req.headers || {}, body: req.body && typeof req.body === 'object' ? req.body : {}, ip: req.ip || 'unknown' });
    } catch (e) {
      if (e instanceof AgentError) return err(e.status || 500, e.code, e.message);
      console.error('[agent-api] unexpected error:', String(e?.message || e).slice(0, 200));
      return err(500, 'AGENT_INTERNAL', 'The agent hit an internal error.');
    }
  };
}
