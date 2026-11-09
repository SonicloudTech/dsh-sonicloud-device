import { randomUUID } from 'node:crypto';
import { AsyncQueue } from '../devices/queue.mjs';

// A voice session belongs to one client connection; never retry insertion in another window.
export class AiConversationBridge {
  constructor({ timeoutMs = 10000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.clients = new Set(); this.sessions = new Map(); this.requests = new Map();
  }
  async *watch(clientId, signal) {
    if (this.closed) return;
    const client = { clientId, queue: new AsyncQueue(64) };
    const abort = () => client.queue.end(true);
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted(); this.clients.add(client);
      for (const pending of this.requests.values()) this.dispatch(pending);
      yield* client.queue;
    } finally {
      signal.removeEventListener('abort', abort); this.clients.delete(client); client.queue.end(true);
      for (const [id, session] of this.sessions) {
        if (session.client === client) this.release(id, 'AI 对话连接已断开，结果可复制');
      }
    }
  }
  dispatch(pending) {
    if (pending.sent) return;
    const session = this.sessions.get(pending.message.sessionId);
    if (!session) return;
    session.client ??= this.clients.values().next().value;
    if (!session.client) return;
    pending.sent = true;
    try { session.client.queue.push(pending.message); }
    catch { pending.reject(new Error('AI 对话连接繁忙，请重试')); }
  }
  request(sessionId, operation, signal, text, autoSend) {
    signal.throwIfAborted();
    if (this.closed || !this.sessions.has(sessionId)) return Promise.reject(new Error('AI 对话连接不可用'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.requests.delete(requestId); };
      const fail = error => { cleanup(); reject(error); };
      const abort = () => fail(new Error('AI 语音会话已取消'));
      const timer = setTimeout(() => {
        fail(new Error('AI 对话未响应，结果可复制'));
        this.release(sessionId);
      }, this.timeoutMs);
      const pending = { message: { requestId, sessionId, operation, expiresAt: Date.now() + this.timeoutMs, ...(text === undefined ? {} : { text, autoSend }) },
        resolve: () => { cleanup(); resolve(true); }, reject: fail };
      this.requests.set(requestId, pending);
      signal.addEventListener('abort', abort, { once: true });
      this.dispatch(pending);
    });
  }
  prepare(run) {
    this.sessions.set(run.id, {});
    return this.request(run.id, 'prepare', run.lifetime.signal);
  }
  insert(run, text) { return this.request(run.id, 'insert', run.lifetime.signal, text, run.preferences?.aiAutoSend ?? true); }
  answer(clientId, requestId, ok) {
    const pending = this.requests.get(requestId);
    const session = pending && this.sessions.get(pending.message.sessionId);
    if (!pending?.sent || session?.client?.clientId !== clientId) return false;
    if (ok) pending.resolve();
    else pending.reject(new Error('AI 对话无法创建、填充或自动发送，结果可复制'));
    return true;
  }
  release(sessionId, message = 'AI 语音会话已结束') {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    for (const pending of this.requests.values()) {
      if (pending.message.sessionId === sessionId) pending.reject(new Error(message));
    }
    try { session?.client?.queue.push({ requestId: randomUUID(), sessionId, operation: 'release' }); }
    catch { session?.client?.queue.end(true); }
  }
  close() {
    this.closed = true;
    for (const id of this.sessions.keys()) this.release(id);
    for (const client of this.clients) client.queue.end();
    this.clients.clear();
  }
}
