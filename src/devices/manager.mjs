import { randomUUID } from 'node:crypto';
import { AsyncQueue, PcmPackets } from './queue.mjs';
import { DeviceStore } from './store.mjs';
import { isStableSn, languageKey, searchAddress } from '../shared/devices.mjs';
import { recognitionQuery, formatTranscript, DEFAULT_LANGUAGES } from './recognition.mjs';
import { Transcript } from '../shared/transcript.mjs';
import { MouseSdk } from './native.mjs';
import { systemAction } from './actions.mjs';
import { translateText } from './translate.mjs';

const VOICE = new Set(['voice_input', 'translate', 'speechSearch']);
export class DeviceManager {
  constructor({ credentials, recognize, prepare = async () => undefined, sdk = new MouseSdk(), action = systemAction, translate = translateText, config = {} }) {
    Object.assign(this, { sdk, recognize, prepare, action, translate, config });
    this.store = new DeviceStore(credentials);
    this.devices = new Map(); this.clients = new Set(); this.pressed = new Map(); this.pending = Promise.resolve();
    this.status = '尚未连接 SDK'; this.disposed = false;
    this.languages = config.recognitionLanguages ?? DEFAULT_LANGUAGES;
    this.dpiLevels = config.dpiLevels ?? { '800': 21, '1200': 32, '1600': 42, '2400': 63 };
    this.onEvent = event => {
      // Audio is copied in the worker. Process it synchronously in IPC order; commands are serialized separately.
      if (event.type === 'audio') { this.audio(event); return; }
      this.pending = this.pending.then(() => this.event(event)).catch(() => this.publish({ type: 'notice', message: '设备事件处理失败，请重连设备' }));
    };
    this.onFault = message => {
      this.status = message; this.cancel();
      this.devices.clear(); this.pressed.clear(); this.snapshot();
    };
    sdk.on('event', this.onEvent); sdk.on('fault', this.onFault);
  }
  async start() {
    if (this.started) return this.started;
    this.started = (async () => {
      try { await this.sdk.start(); this.status = this.devices.size ? '设备已连接' : '设备服务已启动，正在查找智能鼠标…'; }
      catch (error) { this.status = error.message; }
      this.snapshot();
    })();
    return this.started;
  }
  publish(event) {
    for (const queue of this.clients) {
      try { queue.push(event); } catch { queue.end(true); this.clients.delete(queue); this.cancel(); }
    }
  }
  view() {
    return {
      status: this.status,
      devices: [...this.devices.values()].map(({ connectionId, ...device }) => structuredClone(device)),
      recognitionLanguages: this.languages.map(languageKey), translationReady: true,
    };
  }
  snapshot() { this.publish({ type: 'devices', ...this.view() }); }
  async *watch(clientId, signal) {
    if (this.owner) { yield { type: 'notice', message: '智能鼠标已由另一个窗口接管' }; return; }
    const queue = new AsyncQueue(256); this.owner = clientId; this.clients.add(queue);
    const abort = () => queue.end(true);
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted(); await this.start();
      queue.push({ type: 'devices', ...this.view() });
      yield* queue;
    } finally {
      signal.removeEventListener('abort', abort); queue.end(true); this.clients.delete(queue);
      if (this.owner === clientId) { this.owner = undefined; this.cancel(); }
    }
  }
  async event(event) {
    if (this.disposed) return;
    const id = event.id;
    if (event.type === 'diagnostic') {
      if (!this.devices.size) { this.status = event.message; this.snapshot(); }
    } else if (event.type === 'connected') {
      const previous = this.devices.get(id);
      if (previous) this.cancelFor(id);
      const stable = isStableSn(id);
      const category = event.deviceType ?? 'smart-mouse';
      const saved = stable && category === 'smart-mouse' ? await this.store.get(id) : null;
      this.devices.set(id, { id, sn: stable ? id : '', type: category, name: event.name || (category === 'smart-mouse' ? '智能鼠标' : '设备'),
        connection: event.mode === 1 ? 'ble' : 'usb', connectionId: randomUUID(), battery: null,
        identityConfirmed: stable, dpiState: 'unknown', ...saved });
      this.clearPressed(id);
      this.status = '设备已连接';
      if (saved?.revision > 0) await this.applyDpi(this.devices.get(id));
      this.snapshot();
    } else if (event.type === 'disconnected') {
      const device = this.devices.get(id);
      if (!device || device.connection !== (event.mode === 1 ? 'ble' : 'usb')) return;
      this.cancelFor(id, '设备已断开，语音已取消'); this.devices.delete(id); this.clearPressed(id);
      if (!this.devices.size) this.status = '设备已断开，正在重新查找智能鼠标…';
      this.snapshot();
    } else if (event.type === 'overflow') this.cancelFor(id, '鼠标音频处理过慢，本次识别已停止');
    else if (event.type === 'warning') this.publish({ type: 'notice', message: event.message });
    else if (event.type === 'message') {
      const device = this.devices.get(id), message = event.message;
      if (message.type === 'warning') { this.publish({ type: 'notice', message: message.text || '鼠标连接异常' }); return; }
      if (message.type === 'queueOverflow') { this.cancel(undefined, '鼠标音频丢失，请重新录音'); return; }
      if (!device) return;
      if (message.type === 'deviceInfo') {
        if (isStableSn(message.sn) && message.sn !== device.sn) {
          // Re-key only a temporary identity, never merge two real devices.
          if (device.identityConfirmed || this.devices.has(message.sn)) {
            device.identityConfirmed = false; this.cancelFor(id, '设备 SN 冲突，请重连');
          } else {
            this.devices.delete(id); device.sn = message.sn; device.identityConfirmed = true;
            if (device.type === 'smart-mouse') Object.assign(device, await this.store.get(message.sn)); this.devices.set(id, device);
          }
        }
        if (Number.isFinite(message.battery) && message.battery >= 0 && message.battery <= 100) device.battery = message.battery;
        this.snapshot();
      } else if (message.type === 'dpiChanged') {
        device.dpiRaw = message.level;
        // Broadcast encodings may differ from command encodings; do not infer applied state.
        this.snapshot();
      } else if (message.type === 'keyEvent') await this.key(device, message);
    }
  }
  clearPressed(id) { for (const key of this.pressed.keys()) if (key.startsWith(id + ':')) this.pressed.delete(key); }
  async save(sn, revision, preferences) {
    const device = [...this.devices.values()].find(item => item.sn === sn && item.identityConfirmed);
    if (!device || device.type !== 'smart-mouse') throw new Error('设备已离线、SN 未确认或不支持此配置');
    const connectionId = device.connectionId;
    const dpiChanged = preferences.dpi !== device.preferences.dpi || device.dpiState === 'failed';
    const saved = await this.store.save(sn, revision, preferences);
    if (this.devices.get(device.id)?.connectionId !== connectionId) { this.snapshot(); return { ...saved, message: '配置已保存，设备离线后需重连应用' }; }
    Object.assign(device, saved);
    let message = '已保存';
    if (dpiChanged) {
      message = '配置已保存，' + await this.applyDpi(device);
    }
    this.snapshot(); return { ...saved, message };
  }
  async applyDpi(device) {
    const level = this.dpiLevels[device.preferences.dpi];
    try {
      if (!Number.isInteger(level) || level < 0 || level > 255) throw new Error('此固件未配置 DPI 档位映射');
      if (await this.sdk.dpi(device.id, level) !== 1) throw new Error('DPI 下发失败');
      device.dpiState = 'sent'; return 'DPI 指令已下发（设备不返回生效确认）';
    } catch (error) { device.dpiState = 'failed'; return error.message; }
  }
  async key(device, event) {
    if (device.type !== 'smart-mouse' || !this.owner) return;
    if (!device.identityConfirmed) {
      if (event.action === 'down' || event.action === 'click') this.publish({ type: 'notice', message: '设备身份未确认，请重新连接鼠标' });
      return;
    }
    const key = `${device.id}:${event.key}:${event.index ?? 0}`;
    if (event.action === 'up') {
      const pressed = this.pressed.get(key); this.pressed.delete(key);
      if (this.run?.key === key) this.release(this.run);
      else if (pressed && event.key === 'm' && !VOICE.has(pressed.mAction)) {
        void this.execute(pressed.mAction, pressed.linkUrl);
      }
      return;
    }
    // Use SDK key names directly; AI activation is bound to click only.
    if (event.key === 'ai' && event.action === 'click') { void this.execute(device.preferences.aiAction); return; }
    if (event.action !== 'down' || !['speech', 'translation', 'm'].includes(event.key) || this.pressed.has(key)) return;
    this.pressed.set(key, structuredClone(device.preferences));
    const action = event.key === 'm' ? device.preferences.mAction : event.key === 'translation' ? 'translate' : device.preferences.speechAction;
    if (!VOICE.has(action)) return;
    if (this.run) { this.publish({ type: 'notice', message: '其他语音会话正在进行，请稍后重试' }); return; }
    let query;
    try {
      query = recognitionQuery(device.preferences, action, this.languages);
    } catch (error) { this.publish({ type: 'notice', message: error.message }); return; }
    const run = {
      id: randomUUID(), sn: device.sn, deviceId: device.id, connectionId: device.connectionId,
      key, action, preferences: structuredClone(device.preferences), query, queue: new AsyncQueue(100),
      lifetime: new AbortController(), transcript: new Transcript(), released: false, started: false, bytes: 0,
    };
    run.packets = new PcmPackets(chunk => run.queue.push(chunk));
    this.run = run;
    run.captureTimer = setTimeout(() => this.fail(run, '界面未响应，请重新打开宿主窗口'), 5000);
    run.durationTimer = setTimeout(() => this.release(run), 600000);
    try {
      run.service = await this.prepare();
      if (this.run !== run || run.closing) return;
      if (await this.sdk.source(device.id) !== 1) throw new Error('无法选定鼠标音频源');
      if (this.run !== run || run.closing) return;
      this.publish({ type: 'request', sessionId: run.id, sn: run.sn, action });
    } catch (error) { this.fail(run, error.message); }
  }
  async execute(action, value) {
    try { await this.action(action === 'openWebUrl' ? 'openUrl' : action, value); }
    catch (error) { this.publish({ type: 'notice', message: error.message }); }
  }
  audio(event) {
    const run = this.run;
    if (!run || run.deviceId !== event.id || run.audioEnded || this.devices.get(event.id)?.connectionId !== run.connectionId) return;
    try {
      const buffer = Buffer.from(event.data, 'base64');
      if (buffer.toString('base64') !== event.data || buffer.length > 320000) throw new Error('鼠标音频数据无效');
      run.bytes += buffer.length;
      if (!run.ready && run.bytes > 320000) throw new Error('连接等待的鼠标音频超过 10 秒，请重试');
      run.packets.write(buffer);
    } catch (error) { this.fail(run, error.message); }
  }
  accept(clientId, sessionId) {
    this.assertOwner(clientId);
    const run = this.run;
    if (!run || run.closing || run.id !== sessionId || run.started) return false;
    run.started = true; clearTimeout(run.captureTimer);
    void this.process(run); return true;
  }
  assertOwner(clientId) { if (!this.owner || this.owner !== clientId) throw new Error('此窗口未接管智能鼠标'); }
  release(run) {
    if (this.run !== run || run.released) return;
    run.released = true;
    this.publish({ type: 'phase', sessionId: run.id, phase: 'finishing' });
    // Allow the SDK's decoded tail to arrive; the owner remains locked throughout.
    run.tailTimer = setTimeout(() => {
      if (this.run !== run || run.closing) return;
      try { run.audioEnded = true; run.packets.flush(); run.queue.end(); }
      catch (error) { this.fail(run, error.message); }
    }, this.config.tailMs ?? 150);
    run.uploadTimer = setTimeout(() => this.fail(run, '音频上传结束超时'), 15000);
  }
  async process(run) {
    try {
      const events = this.recognize({ sn: run.sn, service: run.service, query: run.query, uplink: run.queue, signal: run.lifetime.signal });
      let complete = false;
      for await (const event of events) {
        if (this.run !== run || run.closing) return;
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'ready') { run.ready = true; this.publish({ type: 'phase', sessionId: run.id, phase: run.released ? 'finishing' : 'recording' }); }
        if (event.type === 'finishing') clearTimeout(run.uploadTimer);
        if (event.type === 'warning') this.publish({ type: 'notice', message: event.message });
        if (event.type === 'transcript') {
          run.transcript.update(event);
          this.publish({ type: 'preview', sessionId: run.id, text: formatTranscript(run.transcript.preview(), run.preferences, run.action) });
        }
        if (event.type === 'complete') { complete = true; break; }
      }
      if (this.run !== run || run.closing) return;
      if (!complete || !run.released) throw new Error('ASR 连接中断，识别结果未完成');
      let text = formatTranscript(run.transcript.finalText(), run.preferences, run.action);
      if (!text.trim()) throw new Error('未识别到语音');
      if (run.action === 'translate') {
        this.publish({ type: 'phase', sessionId: run.id, phase: 'translating' });
        text = await this.translate({ sn: run.sn, service: run.service, text, from: run.preferences.from, to: run.preferences.to, signal: run.lifetime.signal, config: this.config.translation });
      }
      if (this.run !== run || run.closing) return;
      if (run.action === 'speechSearch') {
        await this.action('openUrl', searchAddress(run.preferences.searchUrl, text));
        if (this.run !== run || run.closing) return;
        this.publish({ type: 'finished', sessionId: run.id });
      } else this.publish({ type: 'result', sessionId: run.id, text });
      await this.finish(run);
    } catch (error) { this.fail(run, error.message || '语音处理失败，请重试'); }
  }
  fail(run, message) {
    if (this.run !== run || run.closing) return;
    this.publish({ type: 'failed', sessionId: run.id, message });
    void this.finish(run);
  }
  cancel(sessionId, message) {
    const run = this.run;
    if (!run || run.closing || (sessionId && run.id !== sessionId)) return;
    this.publish({ type: message ? 'failed' : 'cancelled', sessionId: run.id, ...(message ? { message } : {}) });
    void this.finish(run);
  }
  cancelFor(deviceId, message) { if (this.run?.deviceId === deviceId) this.cancel(this.run.id, message); }
  async finish(run) {
    if (this.run !== run || run.closing) return;
    run.closing = true; run.audioEnded = true;
    for (const name of ['captureTimer', 'durationTimer', 'tailTimer', 'uploadTimer']) clearTimeout(run[name]);
    run.lifetime.abort(); run.queue.end(true);
    try { await this.sdk.source(''); } catch { /* SDK may already be offline. */ }
    if (this.run === run) this.run = undefined;
  }
  async close() {
    this.disposed = true;
    if (this.run) await this.finish(this.run);
    for (const queue of this.clients) queue.end(true);
    this.clients.clear(); this.owner = undefined;
    this.sdk.off('event', this.onEvent); this.sdk.off('fault', this.onFault);
    await this.sdk.close();
  }
}
