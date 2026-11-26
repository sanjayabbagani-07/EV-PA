// Runtime-neutral HTTP API. handle({method, pathname, headers, body, ip}) -> {status, json} | null.
// Returns null for paths outside /api/agent so the host server can continue routing.
// Auth: owner routes require a short-lived signed bearer; Android device routes use a one-time code or device credential.
import { AgentError } from './errors.mjs';
import { signToken, verifyToken, bearerFrom, safeEqual, RateLimiter } from './auth.mjs';
import { cleanLabel } from './prompt.mjs';

const OWNER = 'owner';
const DEVICE_ONLINE_MS = 90_000;
const ok = (json, status = 200) => ({ status, json: { ok: true, ...json } });
const err = (status, code, message) => ({ status, json: { ok: false, code, message } });
const hex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const randomHex = (length) => hex(crypto.getRandomValues(new Uint8Array(length)));
async function hashSecret(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
function publicDevice(device, now) {
  const lastSeen = Date.parse(device.lastSeenAt || '');
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    status: device.status,
    connected: device.status === 'active' && Number.isFinite(lastSeen) && now - lastSeen <= DEVICE_ONLINE_MS,
    accessibilityEnabled: device.accessibilityEnabled === true,
    appDiscoveryAvailable: device.appDiscoveryAvailable === true,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
  };
}
function deviceFromRequest(headers, store, hashSecret) {
  const token = bearerFrom(headers);
  return /^[a-f0-9]{64}$/.test(token)
    ? hashSecret(token).then((hash) => store.getDeviceByTokenHash(hash))
    : Promise.resolve(null);
}
function hasOnlyKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}
function validCommandResult(body) {
  if (!hasOnlyKeys(body, ['ok', 'data', 'error', 'verified', 'verification']) || typeof body.ok !== 'boolean') return false;
  if (body.verified !== undefined && typeof body.verified !== 'boolean') return false;
  if (body.verification !== undefined && (typeof body.verification !== 'string' || body.verification.length > 300)) return false;
  if (body.data !== undefined && body.data !== null) {
    if (typeof body.data !== 'object') return false;
    try { if (JSON.stringify(body.data).length > 24_000) return false; } catch { return false; }
  }
  if (body.error !== undefined && body.error !== null) {
    if (!hasOnlyKeys(body.error, ['code', 'message', 'retryable']) ||
        typeof body.error.code !== 'string' || body.error.code.length > 80 ||
        typeof body.error.message !== 'string' || body.error.message.length > 500) return false;
  }
  return true;
}

function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return '';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return ''; }
}

export function createAgentApi({ engine, store, registry, adapters, env = {}, waitUntil = (p) => { p.catch(() => {}); }, now = () => Date.now() }) {
  const loginLimiter = new RateLimiter({ limit: 5, windowMs: 60_000, now });
  // Backstop in case a client spoofs its IP: caps attempts across everyone (single-owner app).
  const globalLoginLimiter = new RateLimiter({ limit: 30, windowMs: 10 * 60_000, now });
  const taskLimiter = new RateLimiter({ limit: 15, windowMs: 60_000, now });
  const pairingLimiter = new RateLimiter({ limit: 5, windowMs: 60_000, now });
  const pairingCreationLimiter = new RateLimiter({ limit: 5, windowMs: 60_000, now });
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

    if (a === 'device' && b === 'pair' && seg.length === 2) {
      if (method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      if (!pairingLimiter.take(`pair:${ip}`)) return err(429, 'RATE_LIMITED', 'Too many pairing attempts. Wait a minute and try again.');
      if (!hasOnlyKeys(body, ['code', 'name', 'platform']) ||
          typeof body.code !== 'string' || !/^[a-f0-9]{48}$/.test(body.code) ||
          typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60 ||
          body.platform !== 'android') {
        return err(400, 'INVALID_PAIRING_REQUEST', 'Provide a valid one-time code, device name, and Android platform.');
      }
      const deviceName = body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (!deviceName) return err(400, 'INVALID_PAIRING_REQUEST', 'Device name must contain printable characters.');
      const pairing = await store.consumePairing(await hashSecret(body.code), now());
      if (!pairing) return err(401, 'PAIRING_INVALID', 'The pairing code is invalid, expired, or already used.');
      const deviceToken = randomHex(32);
      const device = {
        id: crypto.randomUUID(),
        userId: pairing.userId,
        name: deviceName.slice(0, 60),
        platform: 'android',
        tokenHash: await hashSecret(deviceToken),
        status: 'active',
        createdAt: new Date(now()).toISOString(),
        lastSeenAt: new Date(now()).toISOString(),
        revokedAt: null,
        accessibilityEnabled: false,
        appDiscoveryAvailable: true,
      };
      await store.createDevice(device);
      return ok({ deviceId: device.id, deviceToken, device: publicDevice(device, now()) }, 201);
    }

    if (a === 'device' && b === 'status' && seg.length === 2) {
      if (!['GET', 'POST'].includes(method)) return err(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
      if (method === 'POST' && (!hasOnlyKeys(body, ['accessibilityEnabled', 'appDiscoveryAvailable']) ||
          typeof body.accessibilityEnabled !== 'boolean' || typeof body.appDiscoveryAvailable !== 'boolean')) {
        return err(400, 'INVALID_DEVICE_STATUS', 'Provide boolean accessibilityEnabled and appDiscoveryAvailable status fields.');
      }
      const device = await deviceFromRequest(headers, store, hashSecret);
      if (!device) return err(401, 'UNAUTHORIZED_DEVICE', 'A valid paired Android device credential is required.');
      const capabilities = method === 'POST'
        ? { accessibilityEnabled: body.accessibilityEnabled, appDiscoveryAvailable: body.appDiscoveryAvailable }
        : undefined;
      const active = await store.touchDevice(device.id, now(), capabilities);
      if (!active) return err(401, 'UNAUTHORIZED_DEVICE', 'This Android device has been revoked.');
      return ok({ device: publicDevice(active, now()) });
    }

    if (a === 'device' && b === 'disconnect' && seg.length === 2) {
      if (method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      if (!hasOnlyKeys(body, [])) return err(400, 'INVALID_REQUEST', 'Device disconnect does not accept arguments.');
      const device = await deviceFromRequest(headers, store, hashSecret);
      if (!device) return err(401, 'UNAUTHORIZED_DEVICE', 'A valid paired Android device credential is required.');
      const revoked = await store.revokeDevice(device.userId, device.id, now());
      if (!revoked) return err(401, 'UNAUTHORIZED_DEVICE', 'This Android device has already been revoked.');
      return ok({ deviceId: device.id, disconnected: true });
    }

    if (a === 'device' && b === 'commands' && c === 'next' && seg.length === 3) {
      if (method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      const device = await deviceFromRequest(headers, store, hashSecret);
      if (!device) return err(401, 'UNAUTHORIZED_DEVICE', 'A valid paired Android device credential is required.');
      const active = await store.touchDevice(device.id, now());
      if (!active) return err(401, 'UNAUTHORIZED_DEVICE', 'This Android device has been revoked.');
      return ok({ command: await store.claimNextDeviceCommand(device.id, now()) });
    }

    if (a === 'device' && b === 'commands' && c && seg[3] === 'result' && seg.length === 4) {
      if (method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(c) || !validCommandResult(body)) {
        return err(400, 'INVALID_COMMAND_RESULT', 'Provide a valid command id and structured command result.');
      }
      const device = await deviceFromRequest(headers, store, hashSecret);
      if (!device) return err(401, 'UNAUTHORIZED_DEVICE', 'A valid paired Android device credential is required.');
      const accepted = await store.completeDeviceCommand(device.id, c, body, now());
      if (!accepted) return err(409, 'COMMAND_NOT_PENDING', 'This command is unknown, expired, or was already completed.');
      return ok({ commandId: c, accepted: true });
    }

    const claims = await verifyToken(bearerFrom(headers), secret, { scope: 'owner', now: now() });
    if (!claims || claims.sub !== OWNER) return err(401, 'UNAUTHORIZED', 'Sign in to use the agent.');
    const userId = claims.sub;

    if (a === 'status' && seg.length === 1) {
      if (method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      const ownerDevices = await store.listDevices(userId);
      const androidDevices = ownerDevices.filter((device) => device.platform === 'android' && device.status === 'active');
      const adapterStatus = adapters.status();
      adapterStatus.android = {
        state: store.hasConnectedDevice?.(userId) ? 'connected' : androidDevices.length ? 'disconnected' : 'not_configured',
      };
      return ok({
        model: {
          configured: Boolean(env.GEMINI_API_KEY),
          name: String(env.GEMINI_MODEL || 'gemini-3.8-flash'),
          functionCalling: 'gemini-function-declarations',
        },
        adapters: adapterStatus,
        tools: registry.list({ env: engine.toolEnv, userId }),
        limits: { maxSteps: engine.cfg.maxSteps, maxToolCalls: engine.cfg.maxToolCalls, approvalTtlMs: engine.cfg.approvalTtlMs },
        persistence: { type: 'in_memory', durable: false, note: 'Tasks, approvals, memories, pairings, device credentials, and pending Android commands are lost when the backend restarts.' },
      });
    }

    if (a === 'tools' && seg.length === 1) {
      if (method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      return ok({ tools: registry.list({ env: engine.toolEnv, userId }) });
    }

    if (a === 'devices' && seg.length === 1) {
      if (method !== 'GET') return err(405, 'METHOD_NOT_ALLOWED', 'Use GET.');
      const devices = await store.listDevices(userId);
      return ok({ devices: devices.map((device) => publicDevice(device, now())) });
    }

    if (a === 'devices' && b === 'pairings' && seg.length === 2) {
      if (method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      if (!hasOnlyKeys(body, [])) return err(400, 'INVALID_REQUEST', 'Pairing code requests do not accept arguments.');
      if (!pairingCreationLimiter.take(`pairing:${userId}`)) return err(429, 'RATE_LIMITED', 'Too many pairing codes were requested. Wait a minute and try again.');
      const code = randomHex(24);
      const createdAt = now();
      const expiresAt = createdAt + 5 * 60_000;
      await store.createPairing({
        id: crypto.randomUUID(), userId, codeHash: await hashSecret(code),
        status: 'pending', createdAt, expiresAt,
      });
      return ok({ code, expiresAt });
    }

    if (a === 'devices' && b && c === 'revoke' && seg.length === 3) {
      if (method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
      if (!hasOnlyKeys(body, [])) return err(400, 'INVALID_REQUEST', 'Device revocation does not accept arguments.');
      const revoked = await store.revokeDevice(userId, b, now());
      if (!revoked) return err(404, 'DEVICE_NOT_FOUND', 'No active device with that id belongs to this account.');
      return ok({ deviceId: b, revoked: true });
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
