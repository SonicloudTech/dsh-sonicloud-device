import { DevicePreferences } from './device-preferences.mjs';
import { waitForRetry } from './retry.mjs';

export class DeviceController {
  editors = new Map();
  listeners = new Set();
  state = { status: '正在连接设备服务…', devices: [], recognitionLanguages: [], translationReady: false };
  constructor(api, { retryDelayMs = 1000 } = {}) { this.api = api; this.retryDelayMs = retryDelayMs; this.clientId = crypto.randomUUID(); this.lifetime = new AbortController(); }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  preferences(device) {
    if (!this.editors.has(device.sn)) this.editors.set(device.sn, new DevicePreferences(this.api, device, (message, kind) => this.notice(message, kind)));
    return this.editors.get(device.sn);
  }
  publish(patch) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  notice(message, kind = 'error') { this.publish({ toast: { id: crypto.randomUUID(), message, kind } }); }
  dismissToast(id) { if (this.state.toast?.id === id) this.publish({ toast: undefined }); }
  connect() { return this.connecting ??= this.watchLoop(); }
  async watchLoop() {
    const signal = this.lifetime.signal;
    while (!signal.aborted) {
      try {
        this.stream = this.api.watch(this.clientId, signal);
        for await (const event of this.stream) {
          if (signal.aborted) return;
          await this.event(event);
        }
      } catch { /* Host reloads and transient transport failures are retried below. */ }
      finally { this.stream?.dispose?.(); this.stream = undefined; }
      if (signal.aborted) return;
      this.publish({ status: '设备服务连接中断，正在重新连接…', devices: [] });
      await waitForRetry(signal, this.retryDelayMs);
    }
  }
  async event(event) {
    if (event.type === 'devices') {
      const { type, ...state } = event;
      for (const device of event.devices) this.editors.get(device.sn)?.sync(device);
      this.publish(state); return;
    }
    if (event.type === 'notice') this.notice(event.message);
  }
  dispose() {
    this.lifetime.abort(); this.stream?.dispose?.(); this.listeners.clear();
    for (const editor of this.editors.values()) editor.dispose();
    this.editors.clear();
  }
}
