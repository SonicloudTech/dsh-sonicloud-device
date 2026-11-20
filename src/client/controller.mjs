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
  refreshScreenshotPermissions(action = 'check', options) { return this.refreshPermissionStatus('screenshot', action, options); }
  refreshTypingPermissions(action = 'check', options) { return this.refreshPermissionStatus('typing', action, options); }
  async refreshPermissionStatus(kind, action, { automatic = false } = {}) {
    const method = `${kind}Permissions`, requestKey = `${kind}PermissionRequest`;
    const busyKey = `${kind}PermissionBusy`, errorKey = `${kind}PermissionError`, messageKey = `${kind}PermissionMessage`;
    const isTyping = kind === 'typing';
    const helper = isTyping ? 'Sonicloud Voice' : 'screenhelper';
    const fallback = `${isTyping ? '打字' : '截图'}权限检查失败，请重试`;
    if (this.lifetime.signal.aborted || typeof this.api[method] !== 'function') return undefined;
    const epoch = this.permissionEpoch ?? 0;
    if (this[requestKey]?.epoch === epoch) return this[requestKey].promise;
    this.publish({ [busyKey]: true, [errorKey]: undefined });
    const current = { epoch };
    current.promise = Promise.resolve().then(async () => {
      try {
        const result = await this.api[method](action);
        if (this.lifetime.signal.aborted || (this.permissionEpoch ?? 0) !== epoch) return undefined;
        const permissions = result?.value;
        const fields = isTyping ? ['supported', 'accessibility'] : ['supported', 'screenRecording', 'accessibility'];
        if (!result?.ok || !permissions || fields.some(key => typeof permissions[key] !== 'boolean')
          || typeof permissions.helperApp !== 'string') throw new Error(result?.error?.message || fallback);
        let message;
        const missing = !permissions.accessibility || (!isTyping && !permissions.screenRecording);
        if (action === 'screen' || action === 'accessibility') message = `请在系统弹窗或“隐私与安全性”中为 ${helper} 完成授权，再点击“已授权，重新检查”。如系统要求重启，请按提示操作。`;
        else if (action === 'refresh' && permissions.supported && (isTyping ? !permissions.accessibility : !permissions.screenRecording)) message = '尚未获得所需权限；如刚完成授权，请按系统提示重启后再检查。';
        this.publish({ [method]: permissions, [messageKey]: message });
        if (automatic && permissions.supported && missing && !this.permissionPrompted) {
          this.permissionPrompted = true;
          this.notice('macOS 首次使用时，请到“声云设备”查看并完成所需的系统授权。', 'info');
        }
        return permissions;
      } catch (error) {
        if (!this.lifetime.signal.aborted && (this.permissionEpoch ?? 0) === epoch) {
          this.publish({ [method]: undefined, [errorKey]: error?.message || fallback });
          if (!automatic) this.notice(error?.message || fallback);
        }
        return undefined;
      } finally {
        if (this[requestKey] === current) this[requestKey] = undefined;
        if (!this.lifetime.signal.aborted && (this.permissionEpoch ?? 0) === epoch) this.publish({ [busyKey]: false });
      }
    });
    this[requestKey] = current;
    return current.promise;
  }
  async captureScreenshot() {
    if (this.lifetime.signal.aborted || this.state.screenshotBusy) return false;
    if (this.state.screenshotPermissionError || (this.state.screenshotPermissions?.supported && !this.state.screenshotPermissions.screenRecording)) {
      this.notice(this.state.screenshotPermissionError || '请先为 screenhelper 授予屏幕录制权限，再重新检查'); return false;
    }
    this.publish({ screenshotBusy: true });
    try {
      const result = await this.api.captureScreenshot();
      if (!result.ok || !result.value) throw new Error(result.error?.message || '截图启动失败，请重试');
      return true;
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.notice(error.message || '截图启动失败，请重试');
      return false;
    } finally {
      if (!this.lifetime.signal.aborted) this.publish({ screenshotBusy: false });
    }
  }
  connect() { return this.connecting ??= this.watchLoop(); }
  async watchLoop() {
    const signal = this.lifetime.signal;
    while (!signal.aborted) {
      this.permissionEpoch = (this.permissionEpoch ?? 0) + 1;
      this.permissionPrompted = false;
      void this.refreshScreenshotPermissions('check', { automatic: true });
      void this.refreshTypingPermissions('check', { automatic: true });
      try {
        this.stream = this.api.watch(this.clientId, signal);
        for await (const event of this.stream) {
          if (signal.aborted) return;
          await this.event(event);
        }
      } catch { /* Host reloads and transient transport failures are retried below. */ }
      finally { this.stream?.dispose?.(); this.stream = undefined; }
      if (signal.aborted) return;
      this.permissionEpoch++;
      this.publish({ status: '设备服务连接中断，正在重新连接…', devices: [],
        ...(typeof this.api.screenshotPermissions === 'function' ? { screenshotPermissions: undefined,
          screenshotPermissionBusy: false, screenshotPermissionError: '设备服务连接中断，连接恢复后会重新检查截图权限' } : {}),
        ...(typeof this.api.typingPermissions === 'function' ? { typingPermissions: undefined,
          typingPermissionBusy: false, typingPermissionError: '设备服务连接中断，连接恢复后会重新检查打字权限' } : {}) });
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
