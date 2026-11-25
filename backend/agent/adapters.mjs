// Contract for execution environments (Part 2: browser runner, Part 3: Android companion).
// An adapter is: { status() -> {state:'connected'|'disconnected'|'not_configured', detail?},
//                  execute(command, ctx) -> Promise<{ok, data?, error?, verified?, verification?}> }
// Tools for an environment check hub.isConnected(name) in their available() hook and call hub.execute().
// No adapter is registered in Part 1, so nothing here can pretend a browser or phone is connected.
import { ToolError } from './errors.mjs';

export class AdapterHub {
  #adapters = new Map();
  register(name, adapter) {
    if (typeof adapter?.status !== 'function' || typeof adapter?.execute !== 'function') throw new Error(`Adapter "${name}" must implement status() and execute()`);
    this.#adapters.set(name, adapter);
    return this;
  }
  has(name) { return this.#adapters.has(name); }
  isConnected(name) { return this.#adapters.get(name)?.status().state === 'connected'; }
  status() {
    const out = { browser: { state: 'not_configured' }, android: { state: 'not_configured' } };
    for (const [name, a] of this.#adapters) out[name] = a.status();
    return out;
  }
  async execute(name, command, ctx) {
    const a = this.#adapters.get(name);
    if (!a) throw new ToolError('ADAPTER_NOT_CONFIGURED', `The ${name} environment is not configured.`);
    if (a.status().state !== 'connected') throw new ToolError('ADAPTER_NOT_CONNECTED', `The ${name} environment is not connected.`);
    return a.execute(command, ctx);
  }
}
