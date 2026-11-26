import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../index.mjs';
import { makeClock } from './helpers.mjs';

const SECRET = 'device-session-secret-'.padEnd(48, 'x');
const PASS = 'correct horse battery';

function harness() {
  const clock = makeClock();
  const runtime = createAgentRuntime({
    env: { EV_SESSION_SECRET: SECRET, EV_OWNER_PASSPHRASE: PASS },
    now: clock.now,
    generate: async () => ({ text: 'unused' }),
    logger: { error() {}, warn() {} },
  });
  const call = (method, pathname, { body = {}, token, ip = '1.2.3.4' } = {}) =>
    runtime.api({ method, pathname, body, ip, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const login = async () => (await call('POST', '/api/agent/login', { body: { passphrase: PASS } })).json.token;
  return { runtime, call, login, clock };
}

test('device pairing is authenticated, single-use, and returns a revocable credential', async () => {
  const h = harness();
  const ownerToken = await h.login();

  assert.equal((await h.call('GET', '/api/agent/devices')).status, 401);
  assert.equal((await h.call('POST', '/api/agent/device/pair', { body: {} })).status, 400);
  assert.equal((await h.call('GET', '/api/agent/device/status', { token: ownerToken })).status, 401);

  const pairing = await h.call('POST', '/api/agent/devices/pairings', { token: ownerToken });
  assert.equal(pairing.status, 200);
  assert.match(pairing.json.code, /^[a-f0-9]{48}$/);
  assert.equal(pairing.json.expiresAt, h.clock.now() + 5 * 60_000);

  const invalid = await h.call('POST', '/api/agent/device/pair', {
    body: { code: pairing.json.code, name: 'Phone', platform: 'android', unexpected: true },
  });
  assert.equal(invalid.json.code, 'INVALID_PAIRING_REQUEST');

  const paired = await h.call('POST', '/api/agent/device/pair', {
    body: { code: pairing.json.code, name: 'EV phone', platform: 'android' },
  });
  assert.equal(paired.status, 201);
  assert.match(paired.json.deviceToken, /^[a-f0-9]{64}$/);
  assert.equal(paired.json.device.name, 'EV phone');
  assert.equal(paired.json.device.connected, true);
  assert.ok(!JSON.stringify(paired.json.device).includes(paired.json.deviceToken));
  assert.equal((await h.call('POST', '/api/agent/device/status', { token: paired.json.deviceToken })).status, 405);
  assert.equal((await h.call('POST', '/api/agent/device/disconnect', {
    token: paired.json.deviceToken,
    body: { unexpected: true },
  })).status, 400);

  const replay = await h.call('POST', '/api/agent/device/pair', {
    body: { code: pairing.json.code, name: 'Second phone', platform: 'android' },
  });
  assert.deepEqual([replay.status, replay.json.code], [401, 'PAIRING_INVALID']);

  const devices = await h.call('GET', '/api/agent/devices', { token: ownerToken });
  assert.equal(devices.json.devices.length, 1);
  assert.equal(devices.json.devices[0].connected, true);
  assert.ok(!JSON.stringify(devices.json).includes(paired.json.deviceToken));

  h.clock.advance(DEVICE_ONLINE_WINDOW_MS);
  const stillPaired = await h.call('GET', '/api/agent/devices', { token: ownerToken });
  assert.equal(stillPaired.json.devices[0].connected, false);

  const status = await h.call('GET', '/api/agent/device/status', { token: paired.json.deviceToken });
  assert.equal(status.status, 200);
  assert.equal(status.json.device.connected, true);

  const revoked = await h.call('POST', `/api/agent/devices/${paired.json.deviceId}/revoke`, { token: ownerToken });
  assert.equal(revoked.json.revoked, true);
  const afterRevoke = await h.call('GET', '/api/agent/device/status', { token: paired.json.deviceToken });
  assert.deepEqual([afterRevoke.status, afterRevoke.json.code], [401, 'UNAUTHORIZED_DEVICE']);
});

test('device pairing expires and a device can revoke its own credential', async () => {
  const h = harness();
  const ownerToken = await h.login();
  const pairing = await h.call('POST', '/api/agent/devices/pairings', { token: ownerToken });

  h.clock.advance(5 * 60_000 + 1);
  const expired = await h.call('POST', '/api/agent/device/pair', {
    body: { code: pairing.json.code, name: 'EV phone', platform: 'android' },
  });
  assert.deepEqual([expired.status, expired.json.code], [401, 'PAIRING_INVALID']);

  const fresh = await h.call('POST', '/api/agent/devices/pairings', { token: ownerToken });
  const paired = await h.call('POST', '/api/agent/device/pair', {
    body: { code: fresh.json.code, name: 'EV phone', platform: 'android' },
  });
  const disconnected = await h.call('POST', '/api/agent/device/disconnect', { token: paired.json.deviceToken });
  assert.equal(disconnected.json.disconnected, true);
  assert.equal((await h.call('GET', '/api/agent/device/status', { token: paired.json.deviceToken })).status, 401);
  assert.equal((await h.call('POST', `/api/agent/devices/${paired.json.deviceId}/revoke`, { token: ownerToken })).status, 404);
});

test('device exchange rejects malformed and excessive pairing attempts', async () => {
  const h = harness();
  const malformed = await h.call('POST', '/api/agent/device/pair', {
    body: { code: 'short', name: 'Phone', platform: 'android' },
  });
  assert.equal(malformed.json.code, 'INVALID_PAIRING_REQUEST');

  let limited = false;
  for (let i = 0; i < 6; i++) {
    const result = await h.call('POST', '/api/agent/device/pair', {
      ip: '9.8.7.6',
      body: { code: 'a'.repeat(48), name: 'Phone', platform: 'android' },
    });
    if (result.status === 429) limited = true;
  }
  assert.equal(limited, true);
});

test('owner device routes never expose or revoke another account device', async () => {
  const h = harness();
  const ownerToken = await h.login();
  const foreignId = 'foreign-device-id';
  await h.runtime.store.createDevice({
    id: foreignId,
    userId: 'another-owner',
    name: 'Private phone',
    platform: 'android',
    tokenHash: 'f'.repeat(64),
    status: 'active',
    createdAt: new Date(h.clock.now()).toISOString(),
    lastSeenAt: new Date(h.clock.now()).toISOString(),
  });

  assert.deepEqual((await h.call('GET', '/api/agent/devices', { token: ownerToken })).json.devices, []);
  const revoke = await h.call('POST', `/api/agent/devices/${foreignId}/revoke`, { token: ownerToken });
  assert.deepEqual([revoke.status, revoke.json.code], [404, 'DEVICE_NOT_FOUND']);
  assert.equal((await h.runtime.store.getDevice(foreignId)).status, 'active');
});

test('pairing code creation is rate-limited per authenticated owner', async () => {
  const h = harness();
  const ownerToken = await h.login();
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await h.call('POST', '/api/agent/devices/pairings', { token: ownerToken }));
  }
  assert.deepEqual(results.map((result) => result.status), [200, 200, 200, 200, 200, 429]);
});

const DEVICE_ONLINE_WINDOW_MS = 91_000;
