export class MemoryCredentials {
  records = new Map();
  pending = Promise.resolve();
  async readRecord(key) { await this.pending; return structuredClone(this.records.get(key)); }
  modifyRecord(key, mutate) {
    const operation = this.pending.then(async () => {
      const value = await mutate(structuredClone(this.records.get(key)));
      if (value !== undefined) this.records.set(key, value);
      return structuredClone(this.records.get(key));
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
export class AsyncItems {
  items = []; ended = false;
  push(value) { this.items.push(value); this.wake?.(); }
  end() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) yield this.items.shift();
      else if (this.ended) return;
      else await new Promise(resolve => { this.wake = resolve; });
    }
  }
}
export const tick = () => new Promise(resolve => setTimeout(resolve, 0));
export async function until(predicate, ms = 1000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > ms) throw new Error('Condition timed out'); await tick(); }
}
