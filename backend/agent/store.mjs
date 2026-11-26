// In-memory task / approval / memory store. Everything is async so a durable backend
// (Cloudflare KV/D1/Durable Objects, Redis, Postgres) can replace it without engine changes.
// NOTE: state is lost on restart (Render free plan sleeps). Swap this adapter before relying on history.
const DAY = 24 * 60 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

export class InMemoryStore {
  #tasks = new Map();
  #approvals = new Map();
  #memories = new Map();
  #pairings = new Map();
  #devices = new Map();
  constructor({ now = () => Date.now(), maxTasksPerUser = 100, maxMemoriesPerUser = 100, finishedTtlMs = DAY } = {}) {
    this.now = now;
    this.maxTasksPerUser = maxTasksPerUser;
    this.maxMemoriesPerUser = maxMemoriesPerUser;
    this.finishedTtlMs = finishedTtlMs;
  }

  async createTask(task) {
    await this.sweep();
    this.#tasks.set(task.id, task);
    const mine = [...this.#tasks.values()].filter((t) => t.userId === task.userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let excess = mine.length - this.maxTasksPerUser;
    for (const t of mine) {
      if (excess <= 0) break;
      if (TERMINAL.has(t.status)) { this.#tasks.delete(t.id); excess -= 1; }
    }
    return task;
  }
  async getTask(id) { return this.#tasks.get(id) ?? null; }
  async saveTask(task) { task.updatedAt = new Date(this.now()).toISOString(); this.#tasks.set(task.id, task); return task; }
  async listTasks(userId, limit = 30) {
    return [...this.#tasks.values()].filter((t) => t.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async createApproval(approval) { this.#approvals.set(approval.id, approval); return approval; }
  async getApproval(id) { return this.#approvals.get(id) ?? null; }
  async saveApproval(approval) { this.#approvals.set(approval.id, approval); return approval; }
  // Atomic compare-and-set: one decision per approval, only by its owner, only before expiry.
  async claimApproval(id, userId, decision, now = this.now()) {
    const a = this.#approvals.get(id);
    if (!a || a.userId !== userId) return { ok: false, code: 'APPROVAL_NOT_FOUND' };
    if (a.status !== 'pending') return { ok: false, code: 'APPROVAL_ALREADY_RESOLVED', approval: a };
    a.decidedAt = new Date(now).toISOString();
    if (now > a.expiresAt) { a.status = 'expired'; return { ok: false, code: 'APPROVAL_EXPIRED', approval: a }; }
    a.status = decision === 'approve' ? 'approved' : 'rejected';
    return { ok: true, approval: a };
  }
  async expireApprovalsForTask(taskId, status = 'expired') {
    for (const a of this.#approvals.values()) {
      if (a.taskId === taskId && a.status === 'pending') { a.status = status; a.decidedAt = new Date(this.now()).toISOString(); }
    }
  }

  async addMemory(userId, text) {
    const list = this.#memories.get(userId) ?? [];
    if (list.length >= this.maxMemoriesPerUser) return null;
    const mem = { id: crypto.randomUUID(), text, createdAt: new Date(this.now()).toISOString() };
    list.push(mem);
    this.#memories.set(userId, list);
    return mem;
  }
  async listMemories(userId) { return [...(this.#memories.get(userId) ?? [])]; }
  async hasMemory(userId, id) { return (this.#memories.get(userId) ?? []).some((m) => m.id === id); }
  async deleteMemory(userId, id) {
    const list = this.#memories.get(userId) ?? [];
    const next = list.filter((m) => m.id !== id);
    this.#memories.set(userId, next);
    return next.length !== list.length;
  }

  async createPairing(pairing) {
    for (const [id, current] of this.#pairings) {
      if (current.expiresAt <= pairing.createdAt || current.status !== 'pending') this.#pairings.delete(id);
    }
    this.#pairings.set(pairing.id, pairing);
    return pairing;
  }
  async consumePairing(codeHash, now = this.now()) {
    for (const pairing of this.#pairings.values()) {
      if (pairing.status !== 'pending' || pairing.codeHash !== codeHash) continue;
      if (pairing.expiresAt <= now) {
        pairing.status = 'expired';
        return null;
      }
      pairing.status = 'consumed';
      pairing.consumedAt = new Date(now).toISOString();
      return pairing;
    }
    return null;
  }
  async createDevice(device) { this.#devices.set(device.id, device); return device; }
  async getDevice(id) { return this.#devices.get(id) ?? null; }
  async getDeviceByTokenHash(tokenHash) {
    return [...this.#devices.values()].find((device) => device.status === 'active' && device.tokenHash === tokenHash) ?? null;
  }
  async listDevices(userId) {
    return [...this.#devices.values()]
      .filter((device) => device.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async touchDevice(id, now = this.now()) {
    const device = this.#devices.get(id);
    if (!device || device.status !== 'active') return null;
    device.lastSeenAt = new Date(now).toISOString();
    return device;
  }
  async revokeDevice(userId, id, now = this.now()) {
    const device = this.#devices.get(id);
    if (!device || device.userId !== userId || device.status !== 'active') return false;
    device.status = 'revoked';
    device.tokenHash = null;
    device.revokedAt = new Date(now).toISOString();
    return true;
  }

  async sweep() {
    const cutoff = this.now() - this.finishedTtlMs;
    for (const [id, t] of this.#tasks) {
      if (TERMINAL.has(t.status) && Date.parse(t.finishedAt || t.updatedAt) < cutoff) this.#tasks.delete(id);
    }
    for (const [id, a] of this.#approvals) {
      if (a.status !== 'pending' && Date.parse(a.decidedAt || a.createdAt) < cutoff) this.#approvals.delete(id);
    }
  }
}
