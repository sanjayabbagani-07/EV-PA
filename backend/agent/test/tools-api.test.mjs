import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../registry.mjs';
import { InMemoryStore } from '../store.mjs';
import { BUILTIN_TOOLS } from '../tools/builtin.mjs';
import { createAgentRuntime } from '../index.mjs';
import { signToken } from '../auth.mjs';
import { scriptedModel, makeClock, jsonResponse } from './helpers.mjs';

// ---------- built-in tools (network is faked; the code paths are the real ones) ----------
function toolsHarness(fetchImpl, env = {}) {
  const registry = new ToolRegistry();
  BUILTIN_TOOLS.forEach((t) => registry.register(t));
  const store = new InMemoryStore();
  const ctx = { userId: 'owner', env, fetch: fetchImpl, store, now: () => Date.parse('2026-11-25T10:00:00Z') };
  return { registry, store, ctx, run: (name, args) => registry.execute(name, args, ctx) };
}

test('get_time: real clock output, timezone handling, bad zone', async () => {
  const h = toolsHarness(async () => { throw new Error('no network expected'); });
  const r = await h.run('get_time', { timeZone: 'Asia/Kolkata' });
  assert.equal(r.ok, true);
  assert.equal(r.data.iso, '2026-11-25T10:00:00.000Z');
  assert.match(r.data.formatted, /15:30/);
  assert.equal((await h.run('get_time', { timeZone: 'Mars/Base' })).error.code, 'INVALID_TIME_ZONE');
});

test('get_weather: geocodes then forecasts; handles unknown place and upstream failure', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('geocoding')) return String(url).includes('Nowhereville') ? jsonResponse({}) : jsonResponse({ results: [{ name: 'Pune', admin1: 'Maharashtra', country: 'India', latitude: 18.5, longitude: 73.8 }] });
    return jsonResponse({ current: { temperature_2m: 27, apparent_temperature: 29, relative_humidity_2m: 60, precipitation: 0, weather_code: 2, wind_speed_10m: 9 }, daily: { time: ['2026-11-25'], temperature_2m_max: [31], temperature_2m_min: [19], precipitation_probability_max: [10], weather_code: [1] } });
  };
  const h = toolsHarness(fetchImpl);
  const r = await h.run('get_weather', { location: 'Pune' });
  assert.equal(r.ok, true);
  assert.equal(r.data.place, 'Pune, Maharashtra, India');
  assert.equal(r.data.current.conditions, 'partly cloudy');
  assert.equal(r.data.forecast[0].maxC, 31);
  assert.ok(urls[1].includes('latitude=18.5') && urls[1].includes('open-meteo.com'));
  assert.equal((await h.run('get_weather', { location: 'Nowhereville' })).error.code, 'LOCATION_NOT_FOUND');
  assert.equal((await h.run('get_weather', { location: 'X' })).error.code, 'INVALID_ARGUMENTS');
  const down = toolsHarness(async () => jsonResponse({}, 503));
  const d = await down.run('get_weather', { location: 'Pune' });
  assert.deepEqual([d.ok, d.error.code, d.error.retryable], [false, 'UPSTREAM_ERROR', true]);
  const offline = toolsHarness(async () => { throw new TypeError('fetch failed'); });
  assert.equal((await offline.run('get_weather', { location: 'Pune' })).error.code, 'UPSTREAM_UNREACHABLE');
});

test('get_news: fetches top stories from Hacker News', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('topstories.json')) return jsonResponse([11, 22, 33]);
    const id = Number(/item\/(\d+)\.json/.exec(u)[1]);
    return jsonResponse({ id, title: `Story ${id}`, url: `https://example.com/${id}`, score: id * 2, by: 'u' });
  };
  const h = toolsHarness(fetchImpl);
  const r = await h.run('get_news', { limit: 2 });
  assert.deepEqual(r.data.stories.map((s) => s.title), ['Story 11', 'Story 22']);
  assert.equal((await h.run('get_news', { limit: 99 })).error.code, 'INVALID_ARGUMENTS');
});

test('web_search: unavailable without a key (never faked); uses the key server-side when set', async () => {
  const none = toolsHarness(async () => { throw new Error('should not be called'); });
  assert.equal((await none.run('web_search', { query: 'ev charging' })).error.code, 'TOOL_UNAVAILABLE');
  assert.deepEqual(none.registry.unavailable(none.ctx).map((u) => u.name), ['web_search']);
  let seen;
  const h = toolsHarness(async (url, init) => { seen = { url, init }; return jsonResponse({ results: [{ title: 'T', url: 'https://x.test', content: 'snippet' }] }); }, { TAVILY_API_KEY: 'tvly-TESTKEY123456' });
  const r = await h.run('web_search', { query: 'ev charging', maxResults: 3 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.results[0], { title: 'T', url: 'https://x.test', snippet: 'snippet' });
  assert.equal(seen.init.headers.Authorization, 'Bearer tvly-TESTKEY123456');
  assert.ok(!seen.init.body.includes('tvly-'), 'key is not in the body');
  assert.ok(!JSON.stringify(r).includes('tvly-'));
});

test('save_memory: really writes and verifies; refuses secrets; reports a full store', async () => {
  const h = toolsHarness(async () => {});
  const r = await h.run('save_memory', { text: 'I prefer green tea' });
  assert.deepEqual([r.ok, r.verified], [true, true]);
  assert.deepEqual((await h.store.listMemories('owner')).map((m) => m.text), ['I prefer green tea']);
  const small = toolsHarness(async () => {});
  small.store.maxMemoriesPerUser = 0;
  assert.equal((await small.run('save_memory', { text: 'anything at all' })).error.code, 'MEMORY_FULL');
});

// ---------- HTTP API ----------
const SECRET = 'k'.repeat(48);
const PASS = 'correct horse battery';
const GEM = 'AIzaSyAPITESTKEY123456789012345678';

function apiHarness(script = [], envOverride = {}) {
  const clock = makeClock();
  const model = scriptedModel(script);
  const pending = [];
  const env = { GEMINI_API_KEY: GEM, EV_SESSION_SECRET: SECRET, EV_OWNER_PASSPHRASE: PASS, ...envOverride };
  const rt = createAgentRuntime({ env, generate: model, now: clock.now, sleep: async () => {}, logger: { error() {}, warn() {} }, waitUntil: (p) => pending.push(p) });
  const call = (method, pathname, { body, token, ip = '1.1.1.1' } = {}) => rt.api({ method, pathname, body, ip, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const login = async () => (await call('POST', '/api/agent/login', { body: { passphrase: PASS } })).json.token;
  return { rt, call, login, model, clock, settle: () => Promise.all(pending.splice(0)) };
}

test('api: ignores non-agent paths so the host server keeps routing', async () => {
  const h = apiHarness();
  assert.equal(await h.rt.api({ method: 'GET', pathname: '/api/chat' }), null);
  assert.equal(await h.rt.api({ method: 'GET', pathname: '/api/agentx' }), null);
});

test('api: refuses to run when auth is not configured', async () => {
  const h = apiHarness([], { EV_SESSION_SECRET: 'short', EV_OWNER_PASSPHRASE: '' });
  const r = await h.call('POST', '/api/agent/login', { body: { passphrase: PASS } });
  assert.deepEqual([r.status, r.json.code], [503, 'AUTH_NOT_CONFIGURED']);
});

test('api: login, bad credentials, brute-force throttle', async () => {
  const h = apiHarness();
  const bad = await h.call('POST', '/api/agent/login', { body: { passphrase: 'wrong' }, ip: '9.9.9.9' });
  assert.deepEqual([bad.status, bad.json.code], [401, 'INVALID_CREDENTIALS']);
  assert.equal((await h.call('POST', '/api/agent/login', { body: {}, ip: '9.9.9.9' })).status, 401);
  assert.equal((await h.call('GET', '/api/agent/login')).status, 405);
  for (let i = 0; i < 3; i++) await h.call('POST', '/api/agent/login', { body: { passphrase: 'x' }, ip: '9.9.9.9' });
  assert.equal((await h.call('POST', '/api/agent/login', { body: { passphrase: PASS }, ip: '9.9.9.9' })).status, 429, 'even the right passphrase is throttled');
  const ok = await h.call('POST', '/api/agent/login', { body: { passphrase: PASS }, ip: '2.2.2.2' });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token.startsWith('v1.') && ok.json.expiresAt > h.clock.now());
});

test('api: every other route requires a valid owner token', async () => {
  const h = apiHarness();
  for (const [m, p] of [['GET', '/api/agent/status'], ['GET', '/api/agent/tools'], ['GET', '/api/agent/tasks'], ['POST', '/api/agent/tasks'], ['GET', '/api/agent/tasks/abc'], ['POST', '/api/agent/approvals/abc'], ['GET', '/api/agent/memory']]) {
    assert.equal((await h.call(m, p)).status, 401, `${m} ${p}`);
  }
  const good = await h.login();
  assert.equal((await h.call('GET', '/api/agent/status', { token: good + 'x' })).status, 401, 'tampered');
  const android = (await signToken({ sub: 'owner', scope: 'android' }, SECRET, { now: h.clock.now() })).token;
  assert.equal((await h.call('GET', '/api/agent/status', { token: android })).status, 401, 'wrong scope');
  const stranger = (await signToken({ sub: 'someone', scope: 'owner' }, SECRET, { now: h.clock.now() })).token;
  assert.equal((await h.call('GET', '/api/agent/status', { token: stranger })).status, 401, 'unknown subject');
  h.clock.advance(13 * 3600 * 1000);
  assert.equal((await h.call('GET', '/api/agent/status', { token: good })).status, 401, 'expired');
});

test('api: status and tools expose capability state, never secrets', async () => {
  const h = apiHarness();
  const token = await h.login();
  const s = await h.call('GET', '/api/agent/status', { token });
  assert.equal(s.json.model.configured, true);
  assert.deepEqual(s.json.adapters, { browser: { state: 'not_configured' }, android: { state: 'not_configured' } });
  assert.equal(s.json.tools.find((t) => t.name === 'web_search').available, false);
  const dump = JSON.stringify(s.json);
  for (const secret of [GEM, SECRET, PASS]) assert.ok(!dump.includes(secret));
});

test('api: create task (wait mode) runs the full loop with real tool dispatch', async () => {
  const h = apiHarness([{ calls: [{ name: 'get_time', args: { timeZone: 'UTC' } }] }, { text: 'It is ten o clock UTC.' }]);
  const token = await h.login();
  const r = await h.call('POST', '/api/agent/tasks', { token, body: { text: 'what time is it?', wait: true, context: { timeZone: 'Not/AZone' } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.task.status, 'completed');
  assert.equal(r.json.task.result.text, 'It is ten o clock UTC.');
  assert.equal(r.json.task.executions[0].tool, 'get_time');
  assert.equal(r.json.task._internal, undefined);
  const list = await h.call('GET', '/api/agent/tasks', { token });
  assert.equal(list.json.tasks.length, 1);
  assert.equal((await h.call('GET', `/api/agent/tasks/${r.json.task.id}`, { token })).json.task.id, r.json.task.id);
  assert.equal((await h.call('GET', '/api/agent/tasks/nope', { token })).status, 404);
});

test('api: background mode returns 202 immediately and finishes via waitUntil', async () => {
  const h = apiHarness([{ text: 'hello' }]);
  const token = await h.login();
  const r = await h.call('POST', '/api/agent/tasks', { token, body: { text: 'hi' } });
  assert.equal(r.status, 202);
  await h.settle();
  assert.equal((await h.call('GET', `/api/agent/tasks/${r.json.task.id}`, { token })).json.task.status, 'completed');
});

test('api: request validation', async () => {
  const h = apiHarness();
  const token = await h.login();
  assert.equal((await h.call('POST', '/api/agent/tasks', { token, body: { text: '' } })).json.code, 'EMPTY_REQUEST');
  assert.equal((await h.call('POST', '/api/agent/tasks', { token, body: { text: 'x'.repeat(4001) } })).json.code, 'REQUEST_TOO_LONG');
  assert.equal((await h.call('POST', '/api/agent/approvals/xyz', { token, body: { decision: 'approve' } })).status, 404);
  assert.equal((await h.call('POST', '/api/agent/memory/delete', { token, body: {} })).status, 400);
  assert.equal((await h.call('GET', '/api/agent/nothing', { token })).status, 404);
});

test('api: approval flow end to end — reject saves nothing, approve saves and verifies, memory is listable/deletable', async () => {
  const saveCall = { calls: [{ name: 'save_memory', args: { text: 'I prefer green tea' } }] };
  const h = apiHarness([saveCall, { text: 'Not saved.' }, saveCall, { text: 'Saved.' }]);
  const token = await h.login();

  const t1 = await h.call('POST', '/api/agent/tasks', { token, body: { text: 'remember I like green tea', wait: true } });
  assert.equal(t1.json.task.status, 'awaiting_approval');
  assert.equal(t1.json.task.pendingApproval.summary, 'Remember: "I prefer green tea"');
  const rej = await h.call('POST', `/api/agent/approvals/${t1.json.task.pendingApproval.id}`, { token, body: { decision: 'reject', wait: true } });
  assert.equal(rej.json.task.status, 'completed');
  assert.equal((await h.call('GET', '/api/agent/memory', { token })).json.memories.length, 0);

  const t2 = await h.call('POST', '/api/agent/tasks', { token, body: { text: 'remember I like green tea', wait: true } });
  const id2 = t2.json.task.pendingApproval.id;
  const acc = await h.call('POST', `/api/agent/approvals/${id2}`, { token, body: { decision: 'approve', wait: true } });
  assert.equal(acc.json.task.status, 'completed');
  assert.equal(acc.json.task.executions[0].verified, true);
  assert.equal((await h.call('POST', `/api/agent/approvals/${id2}`, { token, body: { decision: 'approve' } })).status, 409, 'replay refused');
  const mems = (await h.call('GET', '/api/agent/memory', { token })).json.memories;
  assert.deepEqual(mems.map((m) => m.text), ['I prefer green tea']);
  assert.equal((await h.call('POST', '/api/agent/memory/delete', { token, body: { id: mems[0].id } })).json.deleted, true);
  assert.equal((await h.call('GET', '/api/agent/memory', { token })).json.memories.length, 0);
});

test('api: secrets are refused for memory and cancel works over HTTP', async () => {
  const h = apiHarness([{ calls: [{ name: 'save_memory', args: { text: 'my bank password is hunter2' } }] }, { text: 'I cannot store that.' }, { calls: [{ name: 'save_memory', args: { text: 'likes tea' } }] }]);
  const token = await h.login();
  const t = await h.call('POST', '/api/agent/tasks', { token, body: { text: 'remember my password', wait: true } });
  assert.equal(t.json.task.status, 'completed', 'denied by policy, no approval prompt');
  assert.equal(t.json.task.executions[0].status, 'denied');
  assert.equal((await h.call('GET', '/api/agent/memory', { token })).json.memories.length, 0);

  const t2 = await h.call('POST', '/api/agent/tasks', { token, body: { text: 'remember tea', wait: true } });
  assert.equal(t2.json.task.status, 'awaiting_approval');
  const c = await h.call('POST', `/api/agent/tasks/${t2.json.task.id}/cancel`, { token });
  assert.equal(c.json.task.status, 'cancelled');
});

test('api: model failures surface as a failed task with a safe code (and no key)', async () => {
  const { AgentError } = await import('../errors.mjs');
  const h = apiHarness([new AgentError('MODEL_KEY_REJECTED', 'The backend Gemini key was rejected. Check GEMINI_API_KEY on the server.', { details: { upstream: GEM } })]);
  const token = await h.login();
  const r = await h.call('POST', '/api/agent/tasks', { token, body: { text: 'hi', wait: true } });
  assert.equal(r.json.task.status, 'failed');
  assert.equal(r.json.task.error.code, 'MODEL_KEY_REJECTED');
  assert.ok(!JSON.stringify(r.json).includes(GEM));
});

test('api: global login cap holds even if every request spoofs a different IP', async () => {
  const h = apiHarness();
  let blocked = 0;
  for (let i = 0; i < 40; i++) {
    const r = await h.call('POST', '/api/agent/login', { body: { passphrase: 'nope' }, ip: `10.0.0.${i}` });
    if (r.status === 429) blocked += 1;
  }
  assert.ok(blocked >= 10, 'attempts beyond the global cap are refused');
  assert.equal((await h.call('POST', '/api/agent/login', { body: { passphrase: PASS }, ip: '10.9.9.9' })).status, 429);
});
