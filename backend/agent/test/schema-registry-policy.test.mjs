import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, assertValidSchema, toGeminiSchema } from '../schema.mjs';
import { ToolRegistry, MAX_RESULT_CHARS } from '../registry.mjs';
import { evaluate, classifyConsequential } from '../policy.mjs';
import { redact, redactDeep, looksSensitive } from '../redact.mjs';
import { AdapterHub } from '../adapters.mjs';
import { echoTool } from './helpers.mjs';

const schema = {
  type: 'object', required: ['q'],
  properties: {
    q: { type: 'string', minLength: 2, maxLength: 5 },
    n: { type: 'integer', minimum: 1, maximum: 3, default: 2 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', maxItems: 2, items: { type: 'string' } },
  },
};

test('schema: accepts valid input, applies defaults, strips nothing it knows', () => {
  const r = validate(schema, { q: 'abc', mode: 'a' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { q: 'abc', n: 2, mode: 'a' });
});

test('schema: rejects missing, wrong type, range, enum, unknown keys', () => {
  assert.match(validate(schema, {}).errors.join(), /q is required/);
  assert.match(validate(schema, { q: 5 }).errors.join(), /must be a string/);
  assert.match(validate(schema, { q: 'abc', n: 9 }).errors.join(), /<= 3/);
  assert.match(validate(schema, { q: 'abc', n: 1.5 }).errors.join(), /integer/);
  assert.match(validate(schema, { q: 'abc', mode: 'z' }).errors.join(), /one of/);
  assert.match(validate(schema, { q: 'abc', tags: ['a', 'b', 'c'] }).errors.join(), /at most 2/);
  assert.match(validate(schema, { q: 'abc', evil: 1 }).errors.join(), /not an allowed parameter/);
  assert.match(validate(schema, { q: 'abc', ['__proto__']: 1 }.constructor === Object ? JSON.parse('{"q":"abc","__proto__":{"x":1}}') : {}).errors.join(), /not an allowed parameter/);
  assert.equal(validate(schema, 'nope').ok, false);
});

test('schema: definition errors are caught at registration time', () => {
  assert.throws(() => assertValidSchema({ type: 'weird' }), /type/);
  assert.throws(() => assertValidSchema({ type: 'object', required: ['x'], properties: {} }), /required key/);
});

test('schema: gemini conversion drops unsupported keywords', () => {
  const g = toGeminiSchema({ type: 'object', additionalProperties: false, required: ['q'], properties: { q: { type: 'string', pattern: '^a', default: 'a', description: 'd', maxLength: 5 } } });
  assert.deepEqual(g, { type: 'object', properties: { q: { type: 'string', description: 'd' } }, required: ['q'] });
});

test('registry: registration rules', () => {
  const r = new ToolRegistry();
  const run = async () => ({ ok: true });
  assert.throws(() => r.register({ name: 'Bad Name', description: 'long enough desc', run }), /Invalid tool name/);
  assert.throws(() => r.register({ name: 'ok_tool', description: 'short', run }), /description/);
  assert.throws(() => r.register({ name: 'ok_tool', description: 'long enough desc' }), /run\(\)/);
  assert.throws(() => r.register({ name: 'ok_tool', description: 'long enough desc', run, permission: 'sure' }), /permission/);
  assert.throws(() => r.register({ name: 'ok_tool', description: 'long enough desc', run, timeoutMs: 5 }), /timeoutMs/);
  r.register({ name: 'ok_tool', description: 'long enough desc', run });
  assert.equal(r.get('ok_tool').permission, 'confirm', 'defaults to the safe permission');
  assert.throws(() => r.register({ name: 'ok_tool', description: 'long enough desc', run }), /already registered/);
});

test('registry: only available tools are declared to the model', () => {
  const r = new ToolRegistry();
  r.register(echoTool());
  r.register({ name: 'needs_key', description: 'needs a key to work', permission: 'auto', available: (c) => (c.env?.K ? true : 'Set K'), run: async () => ({ ok: true }) });
  assert.deepEqual(r.declarations({ env: {} }).map((d) => d.name), ['echo']);
  assert.deepEqual(r.unavailable({ env: {} }), [{ name: 'needs_key', reason: 'Set K' }]);
  assert.deepEqual(r.declarations({ env: { K: 1 } }).map((d) => d.name), ['echo', 'needs_key']);
});

test('registry.execute: structured results for every failure mode', async () => {
  const r = new ToolRegistry();
  r.register(echoTool());
  r.register({ name: 'boom', description: 'always throws secret stuff', permission: 'auto', run: async () => { throw new Error('db password=hunter2 at /srv/x'); } });
  r.register({ name: 'badres', description: 'returns garbage result', permission: 'auto', run: async () => 'yes' });
  r.register({ name: 'big', description: 'returns a huge payload', permission: 'auto', run: async () => ({ ok: true, data: { blob: 'x'.repeat(MAX_RESULT_CHARS * 2) } }) });
  r.register({ name: 'slow', description: 'never finishes in time', permission: 'auto', timeoutMs: 100, run: (_, { signal }) => new Promise((res) => { const t = setTimeout(res, 3000); signal.addEventListener('abort', () => { clearTimeout(t); res({ ok: true }); }); }) });

  assert.equal((await r.execute('nope', {})).error.code, 'UNKNOWN_TOOL');
  assert.equal((await r.execute('echo', {})).error.code, 'INVALID_ARGUMENTS');
  const ok = await r.execute('echo', { text: 'hi' });
  assert.deepEqual([ok.ok, ok.data], [true, { echoed: 'hi' }]);
  const boom = await r.execute('boom', {});
  assert.equal(boom.error.code, 'TOOL_EXCEPTION');
  assert.ok(!JSON.stringify(boom).includes('hunter2'), 'internal error text must not leak');
  assert.equal((await r.execute('badres', {})).error.code, 'BAD_TOOL_RESULT');
  const big = await r.execute('big', {});
  assert.equal(big.data.truncated, true);
  const t0 = Date.now();
  const slow = await r.execute('slow', {});
  assert.equal(slow.error.code, 'TIMEOUT');
  assert.ok(Date.now() - t0 < 1500);
});

test('registry.execute: abort signal cancels a running tool', async () => {
  const r = new ToolRegistry();
  r.register({ name: 'wait', description: 'waits for abort signal', permission: 'auto', timeoutMs: 5000, run: (_, { signal }) => new Promise((res) => signal.addEventListener('abort', () => res({ ok: true }))) });
  const ac = new AbortController();
  const p = r.execute('wait', {}, { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  assert.equal((await p).error.code, 'CANCELLED');
});

test('policy: permission levels and backstops', () => {
  const base = { name: 't', parameters: { type: 'object' }, sideEffects: true };
  assert.equal(evaluate({ ...base, permission: 'auto' }, {}).decision, 'allow');
  assert.equal(evaluate({ ...base, permission: 'confirm' }, {}).decision, 'confirm');
  assert.equal(evaluate({ ...base, permission: 'deny' }, {}).decision, 'deny');
  const ui = { ...base, permission: 'auto', scanArgs: true };
  for (const [target, cat] of [['Follow button', 'follow'], ['Send message', 'send_message'], ['Post', 'post'], ['Delete account', 'delete'], ['Buy now', 'purchase'], ['Submit application', 'submit_form'], ['Privacy settings', 'change_settings']]) {
    const v = evaluate(ui, { action: 'click', target }, {});
    assert.equal(v.decision, 'confirm', target);
    assert.equal(classifyConsequential(target), cat);
  }
  assert.equal(evaluate(ui, { action: 'click', target: 'Next page' }, {}).decision, 'allow');
  assert.equal(evaluate(ui, { action: 'click', target: 'Solve the reCAPTCHA' }, {}).decision, 'deny');
  assert.equal(evaluate(ui, { action: 'type', target: 'Password field', text: 'x' }, {}).decision, 'deny');
  assert.equal(evaluate(ui, { action: 'type', target: 'Verification code', text: '123456' }, {}).decision, 'deny');
  assert.equal(evaluate(ui, { action: 'type', target: 'Search box', text: 'buy milk' }, {}).decision, 'allow', 'typed text is not scanned, only what is acted on');
});

test('policy: assess() can only tighten, and a throwing assess denies', () => {
  const t = { name: 't', permission: 'auto', parameters: { type: 'object' } };
  assert.equal(evaluate({ ...t, assess: () => ({ decision: 'confirm' }) }, {}).decision, 'confirm');
  assert.equal(evaluate({ ...t, permission: 'confirm', assess: () => ({ decision: 'allow' }) }, {}).decision, 'confirm');
  assert.equal(evaluate({ ...t, assess: () => { throw new Error('x'); } }, {}).decision, 'deny');
});

test('redact: secrets never survive', () => {
  const s = 'key AIzaSyA1234567890abcdefghijklmnop and Bearer abcdefghijklmnop1234 and tvly-abcdefghij123';
  const out = redact(s);
  assert.ok(!/AIza|abcdefghijklmnop1234|tvly-/.test(out));
  assert.equal(redact('card 4111 1111 1111 1111', { numbers: true }), 'card [redacted-number]');
  assert.deepEqual(redactDeep({ password: 'p', nested: { token: 't', ok: 'fine' } }), { password: '[redacted]', nested: { token: '[redacted]', ok: 'fine' } });
  assert.equal(looksSensitive('my password is hunter2'), true);
  assert.equal(looksSensitive('I prefer green tea'), false);
});

test('adapter hub: honest about missing and disconnected environments', async () => {
  const hub = new AdapterHub();
  assert.deepEqual(hub.status(), { browser: { state: 'not_configured' }, android: { state: 'not_configured' } });
  await assert.rejects(hub.execute('android', {}), { code: 'ADAPTER_NOT_CONFIGURED' });
  assert.throws(() => hub.register('x', {}), /status\(\) and execute\(\)/);
  let state = 'disconnected';
  hub.register('android', { status: () => ({ state }), execute: async (c) => ({ ok: true, data: c }) });
  await assert.rejects(hub.execute('android', {}), { code: 'ADAPTER_NOT_CONNECTED' });
  state = 'connected';
  assert.deepEqual((await hub.execute('android', { a: 1 })).data, { a: 1 });
});
