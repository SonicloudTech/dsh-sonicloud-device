import { DevicePreferences } from './device-preferences.mjs';

export class DeviceController {
  editors = new Map();
  listeners = new Set();
  settled = new Set();
  state = { phase: 'idle', message: '', preview: '', warning: '', status: '正在连接设备服务…', devices: [], recognitionLanguages: [], translationReady: false };
  constructor(api, { retryDelayMs = 1000 } = {}) { this.api = api; this.retryDelayMs = retryDelayMs; this.clientId = crypto.randomUUID(); this.lifetime = new AbortController(); }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  preferences(device) {
    if (!this.editors.has(device.sn)) this.editors.set(device.sn, new DevicePreferences(this.api, device));
    return this.editors.get(device.sn);
  }
  publish(patch) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  notice(message) { this.publish({ toast: { id: crypto.randomUUID(), message } }); }
  dismissToast(id) { if (this.state.toast?.id === id) this.publish({ toast: undefined }); }
  settle(id) {
    this.settled.add(id);
    if (this.settled.size > 128) this.settled.delete(this.settled.values().next().value);
  }
  async call(promise) {
    const result = await promise;
    if (!result.ok) throw new Error(result.error?.message || '设备操作失败');
    return result.value;
  }
  connect() { return this.connecting ??= this.watchLoop(); }
  async watchLoop() {
    const signal = this.lifetime.signal;
    while (!signal.aborted) {
      try {
        this.stream = this.api.watch(this.clientId, signal);
        for await (const event of this.stream) {
          if (signal.aborted) return;
          if (event.type === 'devices' && this.reconnecting) {
            this.reconnecting = false;
            this.publish({ phase: 'idle', message: '', preview: '', warning: '' });
          }
          await this.event(event);
        }
      } catch { /* Host reloads and transient transport failures are retried below. */ }
      finally { this.run = undefined; this.stream?.dispose?.(); this.stream = undefined; }
      if (signal.aborted) return;
      this.reconnecting = true;
      this.publish({ status: '设备服务连接中断，正在重新连接…', devices: [], phase: 'error', message: '正在重新连接设备服务…', preview: '', warning: '' });
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, this.retryDelayMs);
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  bindTarget(target) {
    this.target = target;
    this.publish({});
    return () => {
      if (this.target === target) this.target = undefined;
      if (this.run?.target === target) this.cancel();
      else this.publish({});
    };
  }
  async event(event) {
    if (event.type === 'devices') {
      const { type, ...state } = event;
      for (const device of event.devices) this.editors.get(device.sn)?.sync(device);
      this.publish(state); return;
    }
    if (event.sessionId && this.settled.has(event.sessionId)) return;
    if (event.type === 'notice') { this.notice(event.message); this.publish(this.run ? { warning: event.message } : { message: event.message, phase: 'error' }); return; }
    if (event.type === 'request') {
      const target = this.target;
      if (this.run || (event.action !== 'speechSearch' && (!target || !target.valid()))) {
        this.settle(event.sessionId);
        void this.call(this.api.cancel(this.clientId, event.sessionId)).catch(() => {});
        this.publish({ phase: 'error', message: '请先进入可编辑的对话输入框，再按鼠标语音键' }); return;
      }
      let span;
      try { if (event.action !== 'speechSearch') span = target.capture(); }
      catch { void this.call(this.api.cancel(this.clientId, event.sessionId)).catch(() => {}); return; }
      this.run = { id: event.sessionId, target: event.action === 'speechSearch' ? undefined : target, span };
      this.publish({ phase: 'connecting', message: '', preview: '', warning: '' });
      try { if (!await this.call(this.api.accept(this.clientId, event.sessionId))) throw new Error('语音会话已结束，请重新触发'); }
      catch (error) { this.cancel(); this.publish({ phase: 'error', message: error.message }); }
      return;
    }
    const run = this.run;
    if (!run && event.type === 'failed') { this.settle(event.sessionId); this.notice(event.message); this.publish({ phase: 'error', message: event.message }); return; }
    if (!run || run.id !== event.sessionId) return;
    if (event.type === 'preview') this.publish({ preview: event.text });
    if (event.type === 'phase') this.publish({ phase: event.phase, message: ({ finishing: '正在整理…', translating: '正在翻译…' })[event.phase] ?? '' });
    if (event.type === 'result') {
      this.settle(event.sessionId);
      this.run = undefined;
      let inserted = false;
      try { inserted = run.target?.valid() && run.target.insert(event.text, run.span); } catch { /* Preserve result for copying. */ }
      this.publish(inserted ? { phase: 'idle', preview: '', message: '', warning: '' }
        : { phase: 'result', preview: event.text, message: '输入内容已变化，可复制结果', warning: '' });
    }
    if (['failed', 'cancelled', 'finished'].includes(event.type)) {
      this.settle(event.sessionId);
      if (event.type === 'failed') this.notice(event.message);
      this.run = undefined;
      this.publish(event.type === 'failed' ? { phase: 'error', message: event.message, warning: '' }
        : { phase: 'idle', preview: '', message: '', warning: '' });
    }
  }
  cancel() {
    const run = this.run; this.run = undefined;
    if (run) { this.settle(run.id); void this.call(this.api.cancel(this.clientId, run.id)).catch(() => {}); }
    this.publish({ phase: 'idle', preview: '', message: '', warning: '' });
  }
  dismiss() { if (!this.run) this.publish({ phase: 'idle', preview: '', message: '', warning: '' }); }
  dispose() {
    this.cancel(); this.lifetime.abort(); this.stream?.dispose?.(); this.listeners.clear();
    for (const editor of this.editors.values()) editor.dispose();
    this.editors.clear();
  }
}
