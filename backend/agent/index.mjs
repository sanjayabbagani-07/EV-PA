// Wires registry + store + engine + HTTP API. Runtime-neutral: used by backend/server.js (Node) today and
// by a Cloudflare Worker wrapper later. Pass env explicitly; nothing reads process.env in here.
import { ToolRegistry } from './registry.mjs';
import { InMemoryStore } from './store.mjs';
import { AgentEngine } from './engine.mjs';
import { AdapterHub } from './adapters.mjs';
import { createAgentApi } from './http.mjs';
import { BUILTIN_TOOLS } from './tools/builtin.mjs';
import { ANDROID_TOOLS } from './tools/android.mjs';

export function createAgentRuntime({ env = {}, fetchImpl = globalThis.fetch, store = new InMemoryStore(), registry = new ToolRegistry(), adapters = new AdapterHub(), config = {}, logger = console, waitUntil, now, generate, sleep } = {}) {
  for (const t of [...BUILTIN_TOOLS, ...ANDROID_TOOLS]) if (!registry.has(t.name)) registry.register(t);
  const engine = new AgentEngine({
    registry, store, fetchImpl, config, logger, ...(now ? { now } : {}), ...(generate ? { generate } : {}), ...(sleep ? { sleep } : {}),
    env: { GEMINI_API_KEY: env.GEMINI_API_KEY, GEMINI_MODEL: env.GEMINI_MODEL },
    toolEnv: { TAVILY_API_KEY: env.TAVILY_API_KEY },
  });
  const api = createAgentApi({ engine, store, registry, adapters, env, waitUntil, ...(now ? { now } : {}) });
  return { engine, store, registry, adapters, api };
}

export { ToolRegistry, InMemoryStore, AgentEngine, AdapterHub, createAgentApi, BUILTIN_TOOLS, ANDROID_TOOLS };
