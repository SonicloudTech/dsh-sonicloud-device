import { message as msg } from '../shared/i18n.mjs';
import { randomUUID } from 'node:crypto';
import { AsyncQueue, PcmPackets } from './queue.mjs';
import { DeviceStore } from './store.mjs';
import { isStableSn, languageKey, searchAddress } from '../shared/devices.mjs';
import { recognitionQuery, formatTranscript, DEFAULT_LANGUAGES } from './recognition.mjs';
import { Transcript } from '../shared/transcript.mjs';
import { MouseSdk } from './native.mjs';
import { systemAction } from './actions.mjs';
import { translateText } from './translate.mjs';

const VOICE = new Set(['voice_input', 'translate', 'speechSearch', 'ai_input']);
export class DeviceManager {
  constructor({ credentials, recognize, prepare = async () => undefined, sdk = new MouseSdk(), action = systemAction, translate = translateText, desktop, screenshot, aiConversation, config = {} }) {
    Object.assign(this, { sdk, recognize, prepare, action, translate, desktop, screenshot, aiConversation, config });
    this.store = new DeviceStore(credentials);
    this.devices = new Map(); this.clients = new Set(); this.pressed = new Map(); this.pending = Promise.resolve();
    this.status = msg('status.connecting'); this.disposed = false;
    this.languages = config.recognitionLanguages ?? DEFAULT_LANGUAGES;
    this.dpiLevels = config.dpiLevels ?? { '800': 21, '1200': 32, '1600': 42, '2400': 63 };
    this.dpiReportLevels = config.dpiReportLevels ?? { '800': 0, '1200': 1, '1600': 2, '2400': 3 };
    this.onEvent = event => {
      // Audio is copied in the worker. Process it synchronously in IPC order; commands are serialized separately.
      if (event.type === 'audio') { this.audio(event); return; }
      this.pending = this.pending.then(() => this.event(event)).catch(() => this.publish({ type: 'notice', message: msg('error.device') }));
    };
    this.onFault = message => {
      this.status = message; this.cancel();
      this.devices.clear(); this.pressed.clear(); this.snapshot();
    };
    if (desktop) {
      desktop.onCancel = id => this.cancel(id);
      desktop.onFault = () => this.cancel(undefined, msg('error.panel'));
    }
    this.onScreenshotNotice = message => { if (!this.disposed) this.publish({ type: 'notice', message }); };
    screenshot?.on('notice', this.onScreenshotNotice);
    sdk.on('event', this.onEvent); sdk.on('fault', this.onFault);
  }
  async start() {
    if (this.started) return this.started;
    this.started = (async () => {
      try { this.desktop?.start?.(); } catch { /* Key press reports unsupported native presentation. */ }
      try { await this.sdk.start(); this.status = this.devices.size ? msg('status.connected') : msg('status.searching'); }
      catch (error) { this.status = error.message; }
      this.snapshot();
    })();
    return this.started;
  }
  publish(event) {
    this.desktop?.event(event);
    if (this.desktop && !['devices', 'notice'].includes(event.type)) return;
    for (const queue of this.clients) {
      try { queue.push(event); } catch { queue.end(true); this.clients.delete(queue); if (!this.desktop) this.cancel(); }
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
    if (!this.desktop && this.owner) { yield { type: 'notice', message: msg('error.busy') }; return; }
    const queue = new AsyncQueue(256); if (!this.desktop) this.owner = clientId; this.clients.add(queue);
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
    switch (event.type) {
      case 'connected': return this.connectDevice(event);
      case 'disconnected': return this.disconnectDevice(event);
      case 'message': return this.deviceMessage(event);
      case 'overflow': return this.cancelFor(event.id, msg('error.audio'));
      case 'warning': return this.publish({ type: 'notice', message: event.message });
      case 'diagnostic':
        if (!this.devices.size) { this.status = event.message; this.snapshot(); }
    }
  }
  async connectDevice(event) {
    const { id } = event;
    if (this.devices.has(id)) this.cancelFor(id);
    const stable = isStableSn(id);
    const category = event.deviceType ?? 'smart-mouse';
    const saved = stable && category === 'smart-mouse' ? await this.store.get(id) : null;
    const device = { id, sn: stable ? id : '', type: category, name: event.name || '', defaultName: !event.name,
      connection: event.mode === 1 ? 'ble' : 'usb', connectionId: randomUUID(), battery: null,
      identityConfirmed: stable, dpiState: 'unknown', ...saved };
    this.devices.set(id, device);
    this.clearPressed(id);
    this.status = msg('status.connected');
    if (saved?.revision > 0) await this.applyDpi(device);
    this.snapshot();
  }
  disconnectDevice({ id, mode }) {
    const device = this.devices.get(id);
    if (!device || device.connection !== (mode === 1 ? 'ble' : 'usb')) return;
    this.cancelFor(id, msg('error.device')); this.devices.delete(id); this.clearPressed(id);
    if (!this.devices.size) this.status = msg('status.searching');
    this.snapshot();
  }
  async deviceMessage({ id, message }) {
    const device = this.devices.get(id);
    if (message.type === 'warning') { this.publish({ type: 'notice', message: message.text || msg('error.device') }); return; }
    if (message.type === 'queueOverflow') { this.cancel(undefined, msg('error.audio')); return; }
    if (!device) return;
    switch (message.type) {
      case 'deviceInfo': return this.updateDeviceInfo(device, message);
      case 'dpiChanged': return this.reportDpi(device, message.level);
      case 'keyEvent': return this.key(device, message);
    }
  }
  async updateDeviceInfo(device, message) {
    if (isStableSn(message.sn) && message.sn !== device.sn) {
      // 只补全临时身份，不合并已确认的设备。
      if (device.identityConfirmed || this.devices.has(message.sn)) {
        device.identityConfirmed = false; this.cancelFor(device.id, msg('error.device'));
      } else {
        this.devices.delete(device.id); device.sn = message.sn; device.identityConfirmed = true;
        if (device.type === 'smart-mouse') Object.assign(device, await this.store.get(message.sn));
        this.devices.set(device.id, device);
      }
    }
    if (Number.isFinite(message.battery) && message.battery >= 0 && message.battery <= 100) device.battery = message.battery;
    this.snapshot();
  }
  async reportDpi(device, level) {
    if (!Number.isInteger(level) || level < 0 || level > 255) return;
    device.dpiRaw = level;
    // 硬件上报映射与软件下发字节独立。
    const matches = Object.entries(this.dpiReportLevels).filter(([, value]) => value === level);
    if (matches.length === 1 && device.type === 'smart-mouse' && device.identityConfirmed) {
      Object.assign(device, await this.store.reportDpi(device.sn, matches[0][0]));
      device.dpiState = 'reported';
    } else if (device.dpiState === 'reported') device.dpiState = 'unknown';
    this.snapshot();
  }
  clearPressed(id) { for (const key of this.pressed.keys()) if (key.startsWith(id + ':')) this.pressed.delete(key); }
  save(sn, revision, preferences) {
    // Keep UI saves and hardware reports in order so neither overwrites newer state.
    const saving = this.pending.then(() => this.savePreferences(sn, revision, preferences));
    this.pending = saving.catch(() => {});
    return saving;
  }
  async savePreferences(sn, revision, preferences) {
    const device = [...this.devices.values()].find(item => item.sn === sn && item.identityConfirmed);
    if (!device || device.type !== 'smart-mouse') throw new Error(msg('error.settings'));
    const connectionId = device.connectionId;
    const dpiChanged = preferences.dpi !== device.preferences.dpi || device.dpiState === 'failed';
    const saved = await this.store.save(sn, revision, preferences);
    if (this.devices.get(device.id)?.connectionId !== connectionId) { this.snapshot(); return { ...saved, message: msg('settings.savedOffline') }; }
    Object.assign(device, saved);
    let message = msg('settings.saved');
    if (dpiChanged) {
      message = msg('settings.savedDpi', { reason: await this.applyDpi(device) });
    }
    this.snapshot(); return { ...saved, message };
  }
  async applyDpi(device) {
    const level = this.dpiLevels[device.preferences.dpi];
    try {
      if (!Number.isInteger(level) || level < 0 || level > 255) throw new Error(msg('keys.dpiFailed'));
      if (await this.sdk.dpi(device.id, level) !== 1) throw new Error(msg('keys.dpiFailed'));
      device.dpiState = 'sent'; return msg('settings.dpiSent');
    } catch (error) { device.dpiState = 'failed'; return error.message; }
  }
  async key(device, event) {
    if (this.disposed || device.type !== 'smart-mouse') return;
    if (event.key !== 'capture' && !this.owner && !this.desktop) return;
    if (!device.identityConfirmed) {
      if (event.action === 'down' || event.action === 'click') this.publish({ type: 'notice', message: msg('error.device') });
      return;
    }
    const key = `${device.id}:${event.key}:${event.index ?? 0}`;
    if (event.key === 'capture') {
      const pressed = this.pressed.get(key);
      if (event.action === 'up') {
        if (pressed) pressed.releasedAt = Date.now();
        return;
      }
      if (event.action !== 'click' && event.action !== 'down') return;
      // SDK 固件可能同时上报 down 与 click；松键后短暂保留标记以吸收尾随 click。
      if (pressed && (!pressed.releasedAt || (event.action === 'click' && Date.now() - pressed.releasedAt < 300))) return;
      if (event.action === 'down') this.pressed.set(key, { capture: true });
      else this.pressed.delete(key);
      void this.captureScreenshot('mouse').catch(error => this.onScreenshotNotice(error.message));
      return;
    }
    if (event.action === 'up') {
      const pressed = this.pressed.get(key); this.pressed.delete(key);
      if (this.run?.key === key) this.release(this.run);
      else if (pressed && event.key === 'm' && !VOICE.has(pressed.mAction)) {
        void this.execute(pressed.mAction, pressed.linkUrl);
      }
      return;
    }
    // Click/hold follow the same physical press and must not create another conversation.
    if (event.action !== 'down' || !['speech', 'translation', 'm', 'ai'].includes(event.key) || this.pressed.has(key)) return;
    this.pressed.set(key, structuredClone(device.preferences));
    const action = event.key === 'ai' ? 'ai_input' : event.key === 'm' ? device.preferences.mAction : event.key === 'translation' ? 'translate' : device.preferences.speechAction;
    if (!VOICE.has(action)) return;
    if (this.run) { this.publish({ type: 'notice', message: msg('error.busy') }); return; }
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
    if (!this.desktop) run.captureTimer = setTimeout(() => this.fail(run, msg('error.connection')), 5000);
    run.durationTimer = setTimeout(() => this.release(run), 600000);
    // Opening the app/client must not block key-up or device-disconnect events.
    if (action === 'ai_input') void this.begin(run, device);
    else await this.begin(run, device);
  }
  async captureScreenshot(trigger = 'ui') {
    if (this.disposed) throw new Error(msg('error.closed'));
    if (!this.screenshot) throw new Error(msg('error.screenshot'));
    return this.screenshot.capture(trigger);
  }
  async screenshotPermissions(action = 'check') {
    if (this.disposed) throw new Error(msg('error.closed'));
    if (!this.screenshot?.permissions) throw new Error(msg('error.permission'));
    return this.screenshot.permissions(action);
  }
  async typingPermissions(action = 'check') {
    if (this.disposed) throw new Error(msg('error.closed'));
    if (!this.desktop?.permissions) throw new Error(msg('error.permission'));
    return this.desktop.permissions(action);
  }
  async prepareAi(run) {
    try {
      if (!this.aiConversation || !this.desktop) throw new Error(msg('error.ai'));
      // Activation failure alone must not abort: with the window tray-hidden the renderer lives on and insertion still works.
      try { await this.action('openAi'); } catch { run.aiActivateFailed = true; }
      run.lifetime.signal.throwIfAborted();
      await this.aiConversation.prepare(run);
      return {};
    } catch (error) { return { error }; }
  }
  async begin(run, device) {
    try {
      if (run.action === 'ai_input') run.aiReady = this.prepareAi(run);
      if (run.action === 'ai_input' && !this.desktop) throw new Error(msg('error.ai'));
      if (this.desktop) await this.desktop.begin(run);
      if (this.run !== run || run.closing) return;
      run.service = await this.prepare();
      if (this.run !== run || run.closing) return;
      if (await this.sdk.source(device.id) !== 1) throw new Error(msg('error.audio'));
      if (this.run !== run || run.closing) return;
      if (this.desktop) { run.started = true; void this.process(run); }
      else this.publish({ type: 'request', sessionId: run.id, sn: run.sn, action: run.action });
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
      if (buffer.toString('base64') !== event.data || buffer.length > 320000) throw new Error(msg('error.audio'));
      run.bytes += buffer.length;
      if (!run.ready && run.bytes > 320000) throw new Error(msg('error.audio'));
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
  assertOwner(clientId) { if (!this.owner || this.owner !== clientId) throw new Error(msg('error.busy')); }
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
    run.uploadTimer = setTimeout(() => this.fail(run, msg('error.timeout')), 15000);
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
      if (!complete || !run.released) throw new Error(msg('error.connection'));
      await this.complete(run);
    } catch (error) { this.fail(run, error.message || msg('error.generic')); }
  }
  async complete(run) {
    let text = formatTranscript(run.transcript.finalText(), run.preferences, run.action);
    if (!text.trim()) {
      this.publish({ type: 'finished', sessionId: run.id });
      await this.finish(run);
      return;
    }
    if (run.action === 'translate') {
      this.publish({ type: 'phase', sessionId: run.id, phase: 'translating' });
      text = await this.translate({ sn: run.sn, service: run.service, text, from: run.preferences.from, to: run.preferences.to, signal: run.lifetime.signal, config: this.config.translation });
    }
    if (this.run !== run || run.closing) return;
    if (run.action === 'ai_input') {
      const prepared = await run.aiReady;
      if (this.run !== run || run.closing) return;
      // Keep the complete text available in the native panel if target preparation/insertion fails.
      this.publish({ type: 'preview', sessionId: run.id, text });
      try {
        if (prepared.error) throw prepared.error;
        await this.aiConversation.insert(run, text);
        if (this.run !== run || run.closing) return;
        this.publish(run.aiActivateFailed
          ? { type: 'failed', sessionId: run.id, message: msg('error.aiWindow') }
          : { type: 'finished', sessionId: run.id });
      } catch (error) {
        // On Windows the panel keeps the text so the user can focus any input and submit it there.
        if (this.desktop?.platform === 'win32') {
          this.publish({ type: 'submitOffer', sessionId: run.id, text, message: msg('panel.openInput') });
          await this.finish(run);
          return;
        }
        throw error;
      }
    } else if (run.action === 'speechSearch') {
      await this.action('openUrl', searchAddress(run.preferences.searchUrl, text));
      if (this.run !== run || run.closing) return;
      this.publish({ type: 'finished', sessionId: run.id });
    } else if (this.desktop) {
      await this.desktop.complete(run, text);
    } else this.publish({ type: 'result', sessionId: run.id, text });
    await this.finish(run);
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
    if (run.action === 'ai_input') this.aiConversation?.release(run.id);
    try { await this.sdk.source(''); } catch { /* SDK may already be offline. */ }
    if (this.run === run) this.run = undefined;
  }
  async close() {
    this.disposed = true;
    if (this.run) await this.finish(this.run);
    for (const queue of this.clients) queue.end(true);
    this.clients.clear(); this.owner = undefined;
    this.sdk.off('event', this.onEvent); this.sdk.off('fault', this.onFault);
    this.screenshot?.off('notice', this.onScreenshotNotice);
    this.aiConversation?.close();
    try { await this.screenshot?.close(); } catch { /* 截图进程退出失败不阻断设备和语音清理。 */ }
    await this.desktop?.close();
    await this.sdk.close();
  }
}
