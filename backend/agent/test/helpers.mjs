import { ToolRegistry } from '../registry.mjs';
import { InMemoryStore } from '../store.mjs';
import { AgentEngine } from '../engine.mjs';

const quiet = { error() {}, warn() {}, info() {}, log() {} };

// Scripted stand-in for Gemini. Each step: {text} | {calls:[{name,args}]} | {malformed:true} | Error | (req)=>response
export function scriptedModel(script) {
  const seen = [];
  const fn = async (req) => {
    seen.push(structuredClone({ contents: req.contents, tools: req.tools, systemInstruction: req.systemInstruction }));
    const step = script.shift();
    if (!step) throw new Error('model script exhausted');
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(req);
    if (step.malformed) return { content: null, text: '', functionCalls: [], finishReason: 'MALFORMED_FUNCTION_CALL', malformed: true };
    const calls = step.calls || [];
    const parts = calls.length ? calls.map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } })) : [{ text: step.text ?? '' }];
    return { content: { role: 'model', parts }, text: calls.length ? '' : (step.text ?? ''), functionCalls: calls.map((c) => ({ name: c.name, args: c.args ?? {} })), finishReason: 'STOP', malformed: false };
  };
  fn.seen = seen;
  return fn;
}

export function makeClock(start = Date.parse('2026-11-25T10:00:00Z')) {
  const clock = { t: start, now: () => clock.t, advance(ms) { clock.t += ms; } };
  return clock;
}

export function makeEngine({ script = [], tools = [], config = {}, env = { GEMINI_API_KEY: 'test-key' }, clock = makeClock() } = {}) {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const store = new InMemoryStore({ now: clock.now });
  const model = scriptedModel(script);
  const engine = new AgentEngine({ registry, store, env, generate: model, now: clock.now, sleep: async () => {}, config, logger: quiet });
  return { engine, registry, store, model, clock };
}

export async function runTask(ctx, text = 'do it', extra = {}) {
  const task = await ctx.engine.startTask({ userId: 'owner', text, ...extra });
  await ctx.engine.run(task.id);
  return task;
}

// ---- reusable test tools ----
export function counterTool(name = 'do_action', overrides = {}) {
  const tool = {
    name, description: 'Performs a consequential test action.', permission: 'confirm', sideEffects: true, timeoutMs: 1000,
    parameters: { type: 'object', required: ['target'], properties: { target: { type: 'string', maxLength: 50 } } },
    summarize: ({ target }) => `Do the thing to ${target}`,
    runs: 0,
    async run() { tool.runs += 1; return { ok: true, data: { done: true }, verified: true, verification: 'checked' }; },
    ...overrides,
  };
  return tool;
}

export const echoTool = () => ({
  name: 'echo', description: 'Echoes text back (read-only test tool).', permission: 'auto', timeoutMs: 1000,
  parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 500 } } },
  async run({ text }) { return { ok: true, data: { echoed: text } }; },
});

export function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
