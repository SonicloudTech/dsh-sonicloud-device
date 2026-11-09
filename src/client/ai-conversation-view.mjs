// Settings is a modal layer, independent of layout.panelInfo. Composer readiness
// is reported by the session-scoped slot, not inferred from a navigation call.
export class AiConversationView {
  constructor({ document, closeTopModal }) {
    Object.assign(this, { document, closeTopModal });
    this.composers = new Map(); this.listeners = new Set();
  }
  settingsOpen() { return !!this.document.querySelector('[data-shortcut-modal="settings"]'); }
  mount(sessionId, inputActions) {
    this.composers.set(sessionId, inputActions); this.notify();
    return () => {
      if (this.composers.get(sessionId) === inputActions) this.composers.delete(sessionId);
      this.notify();
    };
  }
  notify() { for (const listener of this.listeners) listener(); }
  wait(check, signal, expiresAt) {
    signal.throwIfAborted();
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); observer.disconnect(); this.listeners.delete(changed);
        signal.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const changed = () => { if (check()) finish(); };
      const aborted = () => finish(new Error('AI 语音会话已取消'));
      const observer = new this.document.defaultView.MutationObserver(changed);
      const timer = setTimeout(() => finish(new Error('AI 对话输入框未就绪')), Math.max(0, Math.min(10000, expiresAt - Date.now())));
      observer.observe(this.document.body, { childList: true, subtree: true, attributes: true });
      this.listeners.add(changed); signal.addEventListener('abort', aborted, { once: true });
      changed();
    });
  }
  async closeSettings(signal, expiresAt) {
    if (!this.settingsOpen()) return;
    this.closeTopModal(this.document);
    await this.wait(() => !this.settingsOpen(), signal, expiresAt);
  }
  ready(sessionId, signal, expiresAt) {
    return this.wait(() => !this.settingsOpen() && this.composers.has(sessionId), signal, expiresAt);
  }
  submit(sessionId) {
    const actions = this.composers.get(sessionId);
    if (this.settingsOpen() || typeof actions?.submit !== 'function') return false;
    // The host owns submission validation, queueing, draft retention and error feedback.
    actions.submit();
    return true;
  }
}
