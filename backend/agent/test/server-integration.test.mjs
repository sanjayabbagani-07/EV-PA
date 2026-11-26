// Boots the REAL backend/server.js as a child process and talks to it over HTTP.
// Proves the /api/agent wiring works and that existing endpoints are untouched. No network access needed.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'integration passphrase 123';
let child;

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: { PATH: process.env.PATH, PORT: String(PORT), EV_SESSION_SECRET: 'z'.repeat(48), EV_OWNER_PASSPHRASE: PASS, ALLOWED_ORIGIN: 'https://example.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
  });
});
after(() => child?.kill());

const req = async (method, path, { body, token } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
};

test('existing endpoints still work', async () => {
  const health = await req('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal((await req('GET', '/api/tools')).status, 200);
  assert.equal((await req('GET', '/api/does-not-exist')).status, 404);
});

test('CORS preflight allows the Authorization header', async () => {
  const res = await fetch(`${BASE}/api/agent/tasks`, { method: 'OPTIONS', headers: { Origin: 'https://example.test' } });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
});

test('agent routes: auth required, bad JSON handled, login works', async () => {
  assert.equal((await req('GET', '/api/agent/status')).status, 401);
  const badJson = await fetch(`${BASE}/api/agent/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).code, 'INVALID_JSON');
  assert.equal((await req('POST', '/api/agent/login', { body: { passphrase: 'wrong' } })).status, 401);
  const login = await req('POST', '/api/agent/login', { body: { passphrase: PASS } });
  assert.equal(login.status, 200);
  const status = await req('GET', '/api/agent/status', { token: login.json.token });
  assert.equal(status.status, 200);
  assert.equal(status.json.model.configured, false, 'no GEMINI_API_KEY in this test environment');
  assert.ok(status.json.tools.some((t) => t.name === 'get_time' && t.available));
  assert.equal(status.json.tools.find((t) => t.name === 'web_search').available, false);
});

test('Android pairing endpoints are mounted on the existing backend', async () => {
  const { json: { token: ownerToken } } = await req('POST', '/api/agent/login', { body: { passphrase: PASS } });
  const pairing = await req('POST', '/api/agent/devices/pairings', { token: ownerToken, body: {} });
  assert.equal(pairing.status, 200);
  const paired = await req('POST', '/api/agent/device/pair', {
    body: { code: pairing.json.code, name: 'Integration phone', platform: 'android' },
  });
  assert.equal(paired.status, 201);
  const status = await req('GET', '/api/agent/device/status', { token: paired.json.deviceToken });
  assert.equal(status.status, 200);
  assert.equal(status.json.device.name, 'Integration phone');
  const disconnected = await req('POST', '/api/agent/device/disconnect', { token: paired.json.deviceToken, body: {} });
  assert.equal(disconnected.json.disconnected, true);
  assert.equal((await req('GET', '/api/agent/device/status', { token: paired.json.deviceToken })).status, 401);
});

test('agent task runs through the real server and fails honestly when Gemini is not configured', async () => {
  const { json: { token } } = await req('POST', '/api/agent/login', { body: { passphrase: PASS } });
  const r = await req('POST', '/api/agent/tasks', { token, body: { text: 'what time is it?', wait: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.task.status, 'failed');
  assert.equal(r.json.task.error.code, 'MODEL_NOT_CONFIGURED');
});
