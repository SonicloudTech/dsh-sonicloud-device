import { waitForRetry } from './retry.mjs';

// Only public Harness session/navigation/input services are used; no DOM focus required.
export class AiConversationClient {
  constructor(api, services, { retryDelayMs = 1000, view } = {}) {
    Object.assign(this, { api, services, retryDelayMs, view });
    this.clientId = crypto.randomUUID(); this.lifetime = new AbortController(); this.targets = new Map();
  }
  current() {
    return Object.values(this.services.sessions.list.getSnapshot().byId)
      .find(row => (row.retainedBy.mainView ?? 0) > 0);
  }
  async workspace(current, signal) {
    const { workspaces, sessions } = this.services;
    const items = workspaces.list.getSnapshot().items;
    const associated = items.find(item => item.sessionIds.includes(current?.id))
      ?? items.find(item => item.path === current?.cwd);
    if (associated) return associated;
    const { byId } = sessions.list.getSnapshot();
    let recent, recentTime = -Infinity;
    for (const item of items) {
      const times = item.sessionIds.flatMap(id => byId[id] ? [byId[id].updatedAt] : []);
      const time = times.length ? Math.max(...times) : Date.parse(item.createdAt);
      if (!recent || time > recentTime) { recent = item; recentTime = time; }
    }
    const workspace = recent ?? await workspaces.initializeDefault(signal);
    if (!workspace) throw new Error('没有可用的工作区');
    return workspace;
  }
  async prepare(sessionId, expiresAt = Infinity) {
    if (this.targets.has(sessionId)) return;
    const target = { lifetime: new AbortController() };
    this.targets.set(sessionId, target);
    const signal = target.lifetime.signal;
    const { sessions, layout, uiWorkspace, workspaces } = this.services;
    const current = this.current();
    const currentWorkspace = workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(current?.id));
    const reuse = !this.view?.settingsOpen() && layout.panelInfo.getSnapshot().activePanelId === null
      && current && (!current.blank || currentWorkspace);
    await this.view?.closeSettings(signal, expiresAt);
    signal.throwIfAborted();
    const workspace = reuse ? undefined : await this.workspace(current, signal);
    signal.throwIfAborted();
    if (Date.now() >= expiresAt) throw new Error('AI 对话准备超时');
    const id = reuse ? current.id : await sessions.create({ workspaceId: workspace.workspaceId });
    signal.throwIfAborted();
    if (Date.now() >= expiresAt) throw new Error('AI 对话准备超时');
    target.reference = sessions.retain(id, { source: 'controllerOperation', signal });
    await target.reference.ready;
    signal.throwIfAborted();
    if (Date.now() >= expiresAt) throw new Error('AI 对话准备超时');
    if (!reuse) uiWorkspace.openSession(id);
    await this.view?.ready(id, signal, expiresAt);
  }
  insert(sessionId, text, expiresAt = Infinity, autoSend = false) {
    const target = this.targets.get(sessionId);
    if (!target?.reference || target.lifetime.signal.aborted || !text?.trim()) return Promise.resolve(false);
    target.insertion ??= this.writeTarget(target, text, expiresAt, autoSend);
    return target.insertion;
  }
  async writeTarget(target, text, expiresAt, autoSend) {
    const { conversation, uiWorkspace, layout } = this.services;
    const reference = target.reference;
    await this.view?.closeSettings(target.lifetime.signal, expiresAt);
    // Restore the captured conversation if navigation changed while recognizing.
    if (this.current()?.id !== reference.sessionId || layout.panelInfo.getSnapshot().activePanelId !== null) {
      uiWorkspace.openSession(reference.sessionId);
    }
    await this.view?.ready(reference.sessionId, target.lifetime.signal, expiresAt);
    target.lifetime.signal.throwIfAborted();
    if (Date.now() >= expiresAt) throw new Error('AI 对话填充超时');
    const result = conversation.input.requestDraftInitialization(reference.binding, { prompt: text, whenDraftExists: 'append' });
    target.inserted = result === 'applied';
    if (target.inserted && autoSend) {
      target.lifetime.signal.throwIfAborted();
      if (Date.now() >= expiresAt) throw new Error('AI 对话自动发送超时');
      if (!this.view?.submit(reference.sessionId)) throw new Error('AI 对话自动发送不可用');
    }
    return target.inserted;
  }
  release(sessionId) {
    const target = this.targets.get(sessionId);
    this.targets.delete(sessionId);
    target?.lifetime.abort(); target?.reference?.release();
  }
  async handle(event) {
    if (event.operation === 'release') { this.release(event.sessionId); return; }
    let ok = false;
    try {
      if (Date.now() >= event.expiresAt) throw new Error('AI 对话请求已过期');
      if (event.operation === 'prepare') { await this.prepare(event.sessionId, event.expiresAt); ok = this.targets.has(event.sessionId); }
      else if (event.operation === 'insert') ok = await this.insert(event.sessionId, event.text, event.expiresAt, event.autoSend === true);
    } catch { this.release(event.sessionId); }
    if (this.lifetime.signal.aborted) return;
    try { await this.api.answerAi(this.clientId, event.requestId, ok); }
    catch { this.release(event.sessionId); }
  }
  async connect() {
    const signal = this.lifetime.signal;
    while (!signal.aborted) {
      try {
        this.stream = this.api.watchAi(this.clientId, signal);
        for await (const event of this.stream) {
          if (signal.aborted) break;
          // Release must be processed even while Session.create/open is pending.
          void this.handle(event);
        }
      } catch { /* Reconnect after host reload without replaying text insertion. */ }
      finally {
        this.stream?.dispose?.(); this.stream = undefined;
        for (const id of this.targets.keys()) this.release(id);
      }
      if (signal.aborted) return;
      await waitForRetry(signal, this.retryDelayMs);
    }
  }
  dispose() {
    this.lifetime.abort(); this.stream?.dispose?.();
    for (const id of this.targets.keys()) this.release(id);
  }
}
