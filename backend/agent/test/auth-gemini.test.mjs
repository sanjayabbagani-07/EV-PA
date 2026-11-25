import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, bearerFrom, safeEqual, RateLimiter } from '../auth.mjs';
import { generate } from '../gemini.mjs';
import { jsonResponse } from './helpers.mjs';

const SECRET = 's'.repeat(40);

test('auth: sign/verify round trip, scope, expiry, tamper', async () => {
  const now = 1_800_000_000_000;
  const { token } = await signToken({ sub: 'owner', scope: 'owner' }, SECRET, { ttlSeconds: 60, now });
  assert.equal((await verifyToken(token, SECRET, { scope: 'owner', now }))?.sub, 'owner');
  assert.equal(await verifyToken(token, SECRET, { scope: 'android', now }), null, 'wrong scope');
  assert.equal(await verifyToken(token, SECRET, { scope: 'owner', now: now + 61_000 }), null, 'expired');
  assert.equal(await verifyToken(token, 'x'.repeat(40), { now }), null, 'wrong secret');
  const [v, body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'owner', scope: 'owner', exp: 9e9 })).toString('base64url');
  assert.equal(await verifyToken(`${v}.${forged}.${sig}`, SECRET, { now }), null, 'payload tamper');
  assert.equal(await verifyToken('garbage', SECRET), null);
  assert.equal(await verifyToken(token, 'short'), null);
  await assert.rejects(signToken({}, 'short'), /32 characters/);
});

test('auth: bearer parsing, safeEqual, rate limiter', async () => {
  assert.equal(bearerFrom({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(bearerFrom({ authorization: 'Basic abc' }), '');
  assert.equal(await safeEqual('a', 'a'), true);
  assert.equal(await safeEqual('a', 'b'), false);
  let t = 0;
  const rl = new RateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.deepEqual([rl.take('k'), rl.take('k'), rl.take('k')], [true, true, false]);
  t = 1500;
  assert.equal(rl.take('k'), true);
});

const KEY = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345';
const baseArgs = { apiKey: KEY, model: 'test-model', systemInstruction: 'sys', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

test('gemini: sends function declarations, key only in header, parses functionCall', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return jsonResponse({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'thinking' }, { functionCall: { name: 'get_weather', args: { location: 'Pune' } } }] } }] });
  };
  const tools = [{ name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { location: { type: 'string' } } } }];
  const r = await generate({ ...baseArgs, tools, fetchImpl });
  assert.match(captured.url, /\/v1beta\/models\/test-model:generateContent$/);
  assert.ok(!captured.url.includes(KEY) && !captured.init.body.includes(KEY), 'key must not be in URL or body');
  assert.equal(captured.init.headers['x-goog-api-key'], KEY);
  assert.deepEqual(captured.body.tools[0].functionDeclarations, tools);
  assert.equal(captured.body.toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.deepEqual(r.functionCalls, [{ name: 'get_weather', args: { location: 'Pune' }, id: undefined }]);
  assert.equal(r.content.role, 'model');
});

test('gemini: omits tools block when none, parses plain text', async () => {
  let body;
  const r = await generate({ ...baseArgs, fetchImpl: async (_, init) => { body = JSON.parse(init.body); return jsonResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Hello ' }, { text: 'there', thought: false }, { text: 'hidden', thought: true }] } }] }); } });
  assert.equal(body.tools, undefined);
  assert.equal(r.text, 'Hello there');
  assert.equal(r.functionCalls.length, 0);
});

test('gemini: HTTP errors are mapped, classified, and never leak the key', async () => {
  const cases = [
    [429, {}, 'RATE_LIMITED', true], [503, {}, 'MODEL_UNAVAILABLE', true], [401, {}, 'MODEL_KEY_REJECTED', false],
    [404, {}, 'MODEL_NOT_FOUND', false], [400, { error: { message: `API key not valid: ${KEY}` } }, 'MODEL_KEY_REJECTED', false],
    [400, { error: { message: 'bad schema' } }, 'MODEL_BAD_REQUEST', false],
  ];
  for (const [status, body, code, retryable] of cases) {
    const e = await generate({ ...baseArgs, fetchImpl: async () => jsonResponse(body, status) }).catch((x) => x);
    assert.equal(e.code, code, `status ${status}`);
    assert.equal(e.retryable, retryable);
    assert.ok(!JSON.stringify({ m: e.message, d: e.details }).includes(KEY), 'no key in error');
  }
});

test('gemini: config, timeout, network, blocked, malformed', async () => {
  assert.equal((await generate({ ...baseArgs, apiKey: '', fetchImpl: async () => {} }).catch((x) => x)).code, 'MODEL_NOT_CONFIGURED');
  assert.equal((await generate({ ...baseArgs, model: '../evil?x=1', fetchImpl: async () => {} }).catch((x) => x)).code, 'MODEL_NOT_CONFIGURED');
  const net = await generate({ ...baseArgs, fetchImpl: async () => { throw new TypeError('fetch failed'); } }).catch((x) => x);
  assert.deepEqual([net.code, net.retryable], ['MODEL_NETWORK', true]);
  // A real in-flight fetch keeps the event loop alive; AbortSignal.timeout's own timer is unref'd, so hold it open here.
  const hangingFetch = (_, { signal }) => new Promise((_, rej) => {
    const keepAlive = setTimeout(() => {}, 2000);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); rej(new Error('aborted')); });
  });
  const slow = await generate({ ...baseArgs, timeoutMs: 30, fetchImpl: hangingFetch }).catch((x) => x);
  assert.deepEqual([slow.code, slow.retryable], ['MODEL_TIMEOUT', true]);
  const ac = new AbortController();
  const p = generate({ ...baseArgs, signal: ac.signal, fetchImpl: hangingFetch }).catch((x) => x);
  ac.abort();
  assert.equal((await p).code, 'CANCELLED');
  assert.equal((await generate({ ...baseArgs, fetchImpl: async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }) }).catch((x) => x)).code, 'MODEL_BLOCKED');
  assert.equal((await generate({ ...baseArgs, fetchImpl: async () => jsonResponse({ candidates: [] }) }).catch((x) => x)).code, 'MODEL_EMPTY');
  const mal = await generate({ ...baseArgs, fetchImpl: async () => jsonResponse({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }) });
  assert.equal(mal.malformed, true);
});
