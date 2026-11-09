import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DeviceManager } from '../src/devices/manager.mjs';
import { DeviceStore } from '../src/devices/store.mjs';
import { DevicePreferences } from '../src/client/device-preferences.mjs';
import { defaultPreferences, searchAddress, webUrl, languageKey, REC_LANG_LIST, TRANS_FROM_LANG_LIST, TRANS_TO_LANG_LIST } from '../src/shared/devices.mjs';
import { REMOTE } from '../src/shared/remote.mjs';
import { ServiceStore } from '../src/host/store.mjs';
import { recognitionQuery, DEFAULT_LANGUAGES } from '../src/devices/recognition.mjs';
import { PcmPackets } from '../src/devices/queue.mjs';
import { pluginConfigSchema } from '../src/devices/config.mjs';
import { systemAction } from '../src/devices/actions.mjs';
import { MemoryCredentials, until, tick } from './helpers.mjs';
export class FakeSdk extends EventEmitter {
  sources = []; dpis = [];
  async start() { return 'test'; }
  async source(sn) { this.sources.push(sn); return 1; }
  async dpi(sn, level) { this.dpis.push([sn, level]); return 1; }
  async close() {}
}
async function fixture(overrides = {}) {
  const sdk = new FakeSdk(), credentials = new MemoryCredentials(), events = [], audio = [], actions = [];
  const manager = new DeviceManager({ credentials, sdk, config: { tailMs: 0 },
    action: async (...args) => actions.push(args),
    recognize: async function* ({ sn, uplink, signal }) {
      yield { type: 'ready' };
      for await (const chunk of uplink) { if (signal.aborted) return; audio.push([sn, Buffer.from(chunk, 'base64')]); }
      if (signal.aborted) return;
      yield { type: 'finishing' }; yield { type: 'transcript', text: '你好 & 世界#', final: true, begin: 0, end: 1 }; yield { type: 'complete' };
    }, ...overrides });
  const life = new AbortController();
  const watching = (async () => { for await (const event of manager.watch('client', life.signal)) events.push(event); })();
  await until(() => events.length);
  const send = async event => { sdk.emit('event', event); await manager.pending; };
  const key = (id, action, key = 'speech') => send({ type: 'message', id, message: { type: 'keyEvent', key, action, index: key === 'm' ? 1 : 0 } });
  const connect = (id, mode = 0) => send({ type: 'connected', id, mode });
  const stop = async () => { life.abort(); await watching; await manager.close(); };
  return { manager, sdk, credentials, events, audio, actions, send, key, connect, stop };
}
test('SN preferences isolate devices, survive reconnect, reject stale writes and do not overwrite ASR credentials', async () => {
  const credentials = new MemoryCredentials(), store = new DeviceStore(credentials), services = new ServiceStore(credentials);
  const before = await services.catalog();
  const a = await store.get('0001'); a.preferences.mAction = 'speechSearch'; a.preferences.punctuation = false;
  await store.save('0001', 0, a.preferences);
  assert.equal((await store.get('0002')).preferences.mAction, 'enter');
  assert.equal((await new DeviceStore(credentials).get('0001')).preferences.punctuation, false);
  assert.deepEqual(await services.catalog(), before);
  await assert.rejects(store.save('0001', 0, defaultPreferences()), /已变更/);
  for (const sn of ['usb-temp', 'ble-aa', '__proto__', '']) await assert.rejects(store.get(sn));
});
test('legacy preferences enable AI auto-send and explicit false survives storage reload', async () => {
  const credentials = new MemoryCredentials(), store = new DeviceStore(credentials);
  const legacy = { ...defaultPreferences(), punctuation: false, dpi: '800' };
  delete legacy.aiAutoSend;
  await credentials.modifyRecord('dsh-asr/devices', () => ({ kind: 'grant', payload: {
    version: 1, devices: { '0001': { revision: 3, preferences: legacy } },
  } }));
  const loaded = await store.get('0001');
  assert.deepEqual(loaded, { revision: 3, preferences: { ...legacy, aiAutoSend: true } });
  await store.save('0001', 3, { ...loaded.preferences, aiAutoSend: false });
  assert.equal((await new DeviceStore(credentials).get('0001')).preferences.aiAutoSend, false);
  assert.equal((await store.get('0002')).preferences.aiAutoSend, true);
  await assert.rejects(store.save('0001', 4, { ...loaded.preferences, aiAutoSend: 'false' }));
});
test('temporary identities restore saved preferences and reject conflicting device information', async () => {
  const s = await fixture();
  try {
    const saved = await s.manager.store.save('0001', 0, { ...defaultPreferences(), punctuation: false });
    await s.connect('usb-temporary');
    await s.key('usb-temporary', 'down');
    assert.equal(s.manager.run, undefined);
    await s.send({ type: 'message', id: 'usb-temporary', message: { type: 'deviceInfo', sn: '0001', battery: 75 } });
    const device = s.manager.view().devices[0];
    assert.equal(device.id, 'usb-temporary');
    assert.equal(device.sn, '0001');
    assert.equal(device.identityConfirmed, true);
    assert.equal(device.battery, 75);
    assert.deepEqual(device.preferences, saved.preferences);
    await s.key('usb-temporary', 'down');
    assert.equal(s.manager.run.sn, '0001');
    await s.connect('0002');
    await s.send({ type: 'message', id: 'usb-temporary', message: { type: 'deviceInfo', sn: '0002', battery: 101 } });
    await until(() => !s.manager.run);
    const devices = s.manager.view().devices;
    assert.equal(devices.length, 2);
    assert.equal(devices[0].sn, '0001');
    assert.equal(devices[0].identityConfirmed, false);
    assert.equal(devices[0].battery, 75);
    assert.equal(devices[1].identityConfirmed, true);
    assert.deepEqual((await s.manager.store.get('0001')).preferences, saved.preferences);
    assert.ok(s.events.some(event => event.type === 'failed' && /SN 冲突/.test(event.message)));
  } finally { await s.stop(); }
});
test('unregistered SDK warnings are delivered and queue overflow cancels the active session', async () => {
  const s = await fixture();
  try {
    await s.connect('0001', 1);
    await s.send({ type: 'disconnected', id: '0001', mode: 0 });
    assert.equal(s.manager.view().devices.length, 1);
    await s.key('0001', 'down');
    await s.send({ type: 'message', id: 'unknown', message: { type: 'warning', text: 'SDK 警告' } });
    assert.ok(s.manager.run);
    assert.ok(s.events.some(event => event.type === 'notice' && event.message === 'SDK 警告'));
    await s.send({ type: 'message', id: 'unknown', message: { type: 'queueOverflow' } });
    await until(() => !s.manager.run);
    assert.ok(s.events.some(event => event.type === 'failed' && /音频丢失/.test(event.message)));
    assert.deepEqual(s.sdk.sources, ['0001', '']);
  } finally { await s.stop(); }
});
test('two devices share one session; B audio, key release and disconnect never complete A', async () => {
  const s = await fixture();
  try {
    await s.connect('0001'); await s.connect('0002'); await s.key('0001', 'down');
    const run = s.manager.run; s.manager.accept('client', run.id);
    await s.key('0002', 'down'); await s.key('0002', 'up');
    s.sdk.emit('event', { type: 'audio', id: '0002', data: Buffer.alloc(3200, 2).toString('base64') });
    s.sdk.emit('event', { type: 'audio', id: '0001', data: Buffer.alloc(3200, 1).toString('base64') });
    await s.send({ type: 'disconnected', id: '0002', mode: 0 });
    assert.equal(s.manager.run.id, run.id); assert.equal(run.released, false);
    await s.key('0001', 'up'); await until(() => !s.manager.run);
    assert.equal(s.audio.length, 1); assert.equal(s.audio[0][0], '0001'); assert.equal(s.audio[0][1][0], 1);
    assert.equal(s.events.filter(e => e.type === 'result').length, 1);
    assert.ok(s.events.some(e => e.type === 'notice' && /正在进行/.test(e.message)));
    assert.deepEqual(s.sdk.sources, ['0001', '']);
  } finally { await s.stop(); }
});
test('M voice search uses the originating device engine and encodes text exactly once', async () => {
  const s = await fixture();
  try {
    await s.connect('0001'); const prefs = { ...defaultPreferences(), mAction: 'speechSearch', searchUrl: 'https://www.bing.com/search?q=' };
    await s.manager.save('0001', 0, prefs);
    await s.key('0001', 'down', 'm'); const run = s.manager.run; s.manager.accept('client', run.id);
    await s.key('0001', 'hold', 'm');
    s.sdk.emit('event', { type: 'audio', id: '0001', data: Buffer.alloc(82).toString('base64') });
    await s.key('0001', 'up', 'm'); await s.key('0001', 'up', 'm'); await until(() => !s.manager.run);
    assert.deepEqual(s.actions, [['openUrl', 'https://www.bing.com/search?q=' + encodeURIComponent('你好 & 世界#')]]);
    assert.equal(s.events.some(e => e.type === 'result'), false);
  } finally { await s.stop(); }
});
test('one-click URL is per SN; duplicate releases cannot repeat system actions', async () => {
  const s = await fixture();
  try {
    await s.connect('0001'); await s.manager.save('0001', 0, { ...defaultPreferences(), mAction: 'openWebUrl', linkUrl: 'https://example.com/path?a=1' });
    await s.key('0001', 'down', 'm'); await s.key('0001', 'hold', 'm'); await s.key('0001', 'up', 'm'); await s.key('0001', 'up', 'm');
    assert.deepEqual(s.actions, [['openUrl', 'https://example.com/path?a=1']]); assert.equal(s.manager.run, undefined);
    await assert.rejects(s.manager.save('0001', 1, { ...defaultPreferences(), mAction: 'openWebUrl', linkUrl: 'javascript:alert(1)' }));
  } finally { await s.stop(); }
});
test('a confirmed valid link replaces Baidu for the next M press; invalid drafts never reach the device', async () => {
  const s = await fixture();
  try {
    await s.connect('0001');
    await s.manager.save('0001', 0, { ...defaultPreferences(), mAction: 'openWebUrl', linkUrl: 'https://www.baidu.com' });
    const editor = new DevicePreferences({ saveDevice: async (...args) => ({ ok: true, value: await s.manager.save(...args) }) }, s.manager.view().devices[0]);
    for (const url of ['not a url', 'https://', 'https:google.com', 'https:///google.com', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/a b', 'https://example.com/\\bad']) {
      editor.change('linkUrl', url);
      await editor.commitLink();
      assert.equal(editor.snapshot().invalid, true, url);
      assert.equal(s.manager.view().devices[0].revision, 1);
      await assert.rejects(s.manager.save('0001', 1, { ...editor.snapshot().form }));
    }
    editor.change('linkUrl', ' www.google.com/search?q=test&hl=zh-CN ');
    assert.equal(s.manager.view().devices[0].preferences.linkUrl, 'https://www.baidu.com');
    await editor.commitLink();
    await s.key('0001', 'down', 'm'); await s.key('0001', 'up', 'm');
    assert.deepEqual(s.actions, [['openUrl', 'www.google.com/search?q=test&hl=zh-CN']]);
    assert.equal((await s.manager.store.get('0001')).preferences.linkUrl, s.actions[0][1]);
    editor.dispose();
  } finally { await s.stop(); }
});
test('SDK m down/hold/up executes saved M actions once per device', async () => {
  const s = await fixture();
  try {
    await s.connect('0001'); await s.connect('0002', 1);
    let revision = 0;
    for (const mAction of ['enter', 'backspace', 'openWebUrl']) {
      const linkUrl = 'https://example.com/m';
      await s.manager.save('0001', revision++, { ...defaultPreferences(), mAction, linkUrl });
      s.actions.length = 0;
      await s.key('0001', 'down', 'm');
      for (let i = 0; i < 22; i++) await s.key('0001', 'hold', 'm');
      assert.deepEqual(s.actions, []);
      await s.key('0001', 'up', 'm'); await s.key('0001', 'up', 'm');
      assert.deepEqual(s.actions, [[mAction === 'openWebUrl' ? 'openUrl' : mAction, linkUrl]]);
      assert.equal(s.manager.run, undefined);
    }
    await s.key('0002', 'down', 'm'); await s.key('0002', 'up', 'm');
    assert.deepEqual(s.actions.at(-1), ['enter', '']);
    assert.deepEqual(s.sdk.sources, []);
  } finally { await s.stop(); }
});
test('SDK m starts and finishes each configured voice action without duplicate sessions', async () => {
  const s = await fixture({ translate: async () => 'translated' });
  try {
    await s.connect('0001');
    let revision = 0;
    for (const mAction of ['voice_input', 'translate', 'speechSearch']) {
      await s.manager.save('0001', revision++, { ...defaultPreferences(), mAction });
      await s.key('0001', 'down', 'm');
      const run = s.manager.run;
      assert.equal(run.action, mAction);
      s.manager.accept('client', run.id);
      await s.key('0001', 'down', 'm');
      assert.equal(s.manager.run, run);
      await s.key('0001', 'up', 'm'); await until(() => !s.manager.run);
      await until(() => s.events.some(e => e.sessionId === run.id && ['result', 'finished'].includes(e.type)));
    }
    assert.equal(s.events.filter(e => e.type === 'request').length, 3);
    assert.equal(s.actions.length, 1);
    assert.equal(s.actions[0][0], 'openUrl');
    assert.deepEqual(s.events.filter(e => e.type === 'result').map(e => e.text), ['你好 & 世界#', 'translated']);
  } finally { await s.stop(); }
});
test('AI click and raw releases cannot activate another action or start a voice session', async () => {
  const s = await fixture();
  try {
    await s.connect('0001');
    await s.manager.save('0001', 0, { ...defaultPreferences(), mAction: 'openWebUrl', linkUrl: 'https://example.com/' });
    await s.key('0001', 'click', 'ai');
    await s.send({ type: 'message', id: '0001', message: { type: 'keyEvent', key: 'raw', action: 'up', code: 50, index: 0 } });
    assert.deepEqual(s.actions, []);
    assert.equal(s.manager.run, undefined);
    assert.deepEqual(s.sdk.sources, []);
    await s.key('0001', 'click', 'm');
    assert.equal(s.actions.length, 0);
  } finally { await s.stop(); }
});
test('SDK m freezes settings on down and reconnect clears pending actions', async () => {
  const s = await fixture();
  try {
    await s.connect('0001'); await s.key('0001', 'down', 'm');
    await s.manager.save('0001', 0, { ...defaultPreferences(), mAction: 'backspace' });
    await s.key('0001', 'up', 'm');
    assert.deepEqual(s.actions, [['enter', '']]);
    await s.key('0001', 'down', 'm');
    await s.send({ type: 'disconnected', id: '0001', mode: 0 }); await s.connect('0001');
    await s.key('0001', 'up', 'm');
    assert.equal(s.actions.length, 1);
    await s.key('0001', 'down', 'm'); await s.key('0001', 'up', 'm');
    assert.deepEqual(s.actions.at(-1), ['backspace', '']);
  } finally { await s.stop(); }
});
test('translation uses final text and frozen from/to; cancellation discards a late translation', async () => {
  let resolve, request;
  const s = await fixture({ config: { tailMs: 0 },
    translate: input => { request = input; return new Promise(done => { resolve = done; }); } });
  try {
    await s.connect('0001'); await s.manager.save('0001', 0, { ...defaultPreferences(), speechAction: 'translate' });
    await s.key('0001', 'down'); const run = s.manager.run; s.manager.accept('client', run.id);
    await s.manager.save('0001', 1, { ...defaultPreferences(), to: 'ja' });
    await s.key('0001', 'up'); await until(() => request);
    assert.equal(request.text, '你好 & 世界#'); assert.equal(request.from, 'cn'); assert.equal(request.to, 'en');
    s.manager.cancel(run.id); resolve('Late English'); await until(() => !s.manager.run); await tick();
    assert.equal(request.signal.aborted, true); assert.equal(s.events.some(e => e.type === 'result'), false);
  } finally { await s.stop(); }
});
test('DPI uses firmware bytes, preserves failure state and retries; channel changes reuse SN preferences', async () => {
  const s = await fixture();
  try {
    await s.connect('0001'); s.sdk.dpi = async () => 0;
    const prefs = { ...defaultPreferences(), dpi: '800' };
    const saved = await s.manager.save('0001', 0, prefs); assert.match(saved.message, /下发失败/);
    s.sdk.dpi = FakeSdk.prototype.dpi;
    await s.manager.save('0001', 1, prefs); assert.deepEqual(s.sdk.dpis, [['0001', 21]]);
    await s.send({ type: 'disconnected', id: '0001', mode: 0 }); await s.connect('0001', 1);
    assert.equal(s.manager.view().devices.length, 1); assert.equal(s.manager.view().devices[0].preferences.dpi, '800');
    await s.connect('usb-temp'); assert.equal(s.manager.view().devices[1].identityConfirmed, false);
  } finally { await s.stop(); }
});
test('hardware DPI reports update only their device, persist, deduplicate and never send commands', async () => {
  const s = await fixture();
  try {
    await s.connect('0001'); await s.connect('0002');
    const editor = new DevicePreferences({}, s.manager.view().devices[0]);
    let revision = 0;
    for (const [level, dpi] of [[0, '800'], [1, '1200'], [2, '1600'], [3, '2400']]) {
      await s.send({ type: 'message', id: '0001', message: { type: 'dpiChanged', level } });
      const snapshot = s.events.filter(event => event.type === 'devices').at(-1);
      const device = snapshot.devices[0];
      editor.sync(device);
      assert.equal(editor.snapshot().form.dpi, dpi);
      assert.equal(device.dpiState, 'reported');
      assert.equal(device.revision, ++revision);
      assert.equal(snapshot.devices[1].preferences.dpi, '1600');
      assert.equal((await s.manager.store.get('0001')).preferences.dpi, dpi);
      await s.send({ type: 'message', id: '0001', message: { type: 'dpiChanged', level } });
      assert.equal(s.manager.view().devices[0].revision, revision);
    }
    assert.deepEqual(s.sdk.dpis, []);
    await assert.rejects(s.manager.save('0001', 0, defaultPreferences()), /已变更/);
    await s.send({ type: 'disconnected', id: '0001', mode: 0 }); await s.connect('0001', 1);
    assert.equal(s.manager.view().devices.find(device => device.sn === '0001').preferences.dpi, '2400');
    assert.deepEqual(s.sdk.dpis, [['0001', 63]]);
  } finally { await s.stop(); }
});
test('DPI reports reject unknown bytes and identities and use their own firmware mapping', async () => {
  const s = await fixture({ config: { dpiReportLevels: { '800': 9, '1200': 10 } } });
  try {
    await s.connect('0001'); await s.connect('usb-temp');
    for (const level of [0, 21, 255, -1, 256, 1.5, '9', null, undefined]) {
      await s.send({ type: 'message', id: '0001', message: { type: 'dpiChanged', level } });
      assert.equal(s.manager.view().devices[0].preferences.dpi, '1600');
      assert.equal(s.manager.view().devices[0].revision, 0);
    }
    await s.send({ type: 'message', id: 'usb-temp', message: { type: 'dpiChanged', level: 9 } });
    assert.equal(s.manager.view().devices[1].preferences, undefined);
    await s.send({ type: 'message', id: '0001', message: { type: 'dpiChanged', level: 9 } });
    assert.equal(s.manager.view().devices[0].preferences.dpi, '800');
    assert.deepEqual(s.sdk.dpis, []);
  } finally { await s.stop(); }
});
test('DPI reports preserve legacy language settings and recover a failed software setting', async () => {
  const s = await fixture();
  try {
    await s.connect('0001'); s.sdk.dpi = async () => 0;
    await s.manager.save('0001', 0, { ...defaultPreferences(), dpi: '800' });
    await s.send({ type: 'message', id: '0001', message: { type: 'dpiChanged', level: 0 } });
    assert.equal(s.manager.view().devices[0].dpiState, 'reported');
    await s.credentials.modifyRecord('dsh-asr/devices', record => {
      record.payload.devices['0001'].preferences.from = 'mn'; return record;
    });
    await s.send({ type: 'message', id: '0001', message: { type: 'dpiChanged', level: 1 } });
    assert.equal(s.manager.view().devices[0].preferences.from, 'mn');
    assert.equal(s.manager.view().devices[0].preferences.dpi, '1200');
  } finally { await s.stop(); }
});
test('software saves and hardware DPI reports are processed in arrival order', async () => {
  const s = await fixture();
  try {
    await s.connect('0001');
    let release;
    s.sdk.dpi = () => new Promise(resolve => { release = resolve; });
    const saving = s.manager.save('0001', 0, { ...defaultPreferences(), dpi: '800' });
    await until(() => release);
    const reporting = s.send({ type: 'message', id: '0001', message: { type: 'dpiChanged', level: 3 } });
    release(1); await saving; await reporting;
    assert.equal(s.manager.view().devices[0].preferences.dpi, '2400');
    assert.equal((await s.manager.store.get('0001')).preferences.dpi, '2400');
    assert.equal(s.manager.view().devices[0].dpiState, 'reported');
  } finally { await s.stop(); }
});
test('bounded PCM packets preserve callback boundaries and pad only the tail', () => {
  const values = [], p = new PcmPackets(chunk => values.push(Buffer.from(chunk, 'base64')));
  p.write(Buffer.alloc(3198, 1)); p.write(Buffer.alloc(8, 2)); p.flush();
  assert.deepEqual(values.map(v => v.length), [3200, 82]); assert.equal(values[0][3198], 2); assert.equal(values[1][5], 2); assert.equal(values[1][6], 0);
  assert.throws(() => p.write(Buffer.alloc(1)), /格式/);
});
test('language mapping preserves dialect and script distinctions, and never silently falls back to Chinese', () => {
  assert.deepEqual(recognitionQuery(defaultPreferences(), 'voice_input'), { lid: '0', lanid: '0', role: '0' });
  const traditional = REC_LANG_LIST.find(item => item.rlang === 'zh-hk');
  assert.notEqual(languageKey(traditional), languageKey(defaultPreferences().recognition));
  assert.equal(recognitionQuery({ ...defaultPreferences(), recognition: traditional }, 'voice_input').lanid, '100');
  assert.equal(recognitionQuery({ ...defaultPreferences(), from: 'en' }, 'translate').lanid, '1');
  const hakka = { language: 'zh_cn', accent: 'hakkanese', rlang: '' };
  assert.throws(() => recognitionQuery({ ...defaultPreferences(), recognition: hakka }, 'voice_input'), /重新选择/);
  assert.throws(() => recognitionQuery({ ...defaultPreferences(), from: 'mn' }, 'translate'), /重新选择/);
});
test('documented settings contain mapped recognition and translation sources, retaining Mongolian only as a target', () => {
  assert.equal(REC_LANG_LIST.length, 43);
  assert.equal(TRANS_FROM_LANG_LIST.length, 27);
  assert.equal(TRANS_TO_LANG_LIST.length, 28);
  for (const item of REC_LANG_LIST) assert.ok(recognitionQuery({ ...defaultPreferences(), recognition: item }, 'voice_input').lanid);
  for (const item of TRANS_FROM_LANG_LIST) assert.ok(recognitionQuery({ ...defaultPreferences(), from: item.value }, 'translate').lanid);
  assert.ok(TRANS_TO_LANG_LIST.some(item => item.value === 'mn'));
  assert.equal(recognitionQuery({ ...defaultPreferences(), to: 'mn' }, 'translate').lanid, '0');
});
test('removed saved languages remain readable but cannot be saved or executed, including with custom ASR mappings', async () => {
  const credentials = new MemoryCredentials(), store = new DeviceStore(credentials);
  const legacy = { ...defaultPreferences(), recognition: { language: 'zh_cn', accent: 'hakkanese', rlang: '' }, from: 'mn', to: 'ii', dpi: '800', punctuation: false };
  await credentials.modifyRecord('dsh-asr/devices', () => ({ kind: 'grant', payload: { version: 1, devices: { '0001': { revision: 4, preferences: legacy } } } }));
  const saved = await store.get('0001');
  assert.deepEqual(saved, { revision: 4, preferences: legacy });
  const device = { id: '0001', sn: '0001', type: 'smart-mouse', name: '智能鼠标', connection: 'usb', battery: null, identityConfirmed: true, dpiState: 'unknown', ...saved };
  REMOTE.descriptors.find(item => item.method === 'devices').result.create().parse({ status: '就绪', devices: [device], recognitionLanguages: [], translationReady: false });
  await assert.rejects(store.save('0001', 4, legacy));
  assert.throws(() => recognitionQuery(legacy, 'voice_input', [{ ...legacy.recognition, query: { lanid: '0' } }]), /重新选择/);
  assert.throws(() => recognitionQuery(legacy, 'speechSearch'), /重新选择/);
  assert.throws(() => recognitionQuery({ ...defaultPreferences(), from: 'mn' }, 'translate'), /重新选择/);
  assert.throws(() => recognitionQuery({ ...defaultPreferences(), to: 'ii' }, 'translate'), /重新选择/);
  const corrected = { ...legacy, recognition: defaultPreferences().recognition, from: 'cn', to: 'en' };
  assert.deepEqual(await store.save('0001', 4, corrected), { revision: 5, preferences: corrected });
  assert.deepEqual((await store.get('0002')).preferences, defaultPreferences());
});
test('URL and OS actions do not interpolate user input into shell commands', async () => {
  const calls = [], execute = async (...args) => calls.push(args);
  const url = searchAddress('https://www.google.com/search?q=', '中文 & # $(x)');
  await systemAction('openUrl', url, { platform: 'darwin', execute });
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/open', [url]]);
  await assert.rejects(systemAction('openUrl', 'file:///etc/passwd', { platform: 'darwin', execute }));
  await systemAction('backspace', undefined, { platform: 'darwin', execute });
  assert.match(calls[1][1][1], /key code 51/);
});

test('URLs allow omitted protocols without rewriting input, storage or browser arguments', async () => {
  const store = new DeviceStore(new MemoryCredentials());
  let revision = 0;
  for (const address of ['www.baidu.com', 'example.com/path?q=hello#part', 'example.com:8080/path', '127.0.0.1:8080', 'localhost:3000', '[::1]:8080/path', 'https://example.com', 'http://example.com']) {
    assert.equal(webUrl(` ${address} `), address);
    const saved = await store.save('0001', revision++, { ...defaultPreferences(), mAction: 'openWebUrl', linkUrl: address });
    assert.equal(saved.preferences.linkUrl, address);
  }
  for (const address of ['ftp://example.com', 'https:example.com', 'javascript:alert(1)', 'not a url', '/relative/path', '--bad.com', 'example..com']) assert.throws(() => webUrl(address));
  for (const platform of ['darwin', 'win32', 'linux']) {
    const calls = [];
    await systemAction('openUrl', 'www.baidu.com/path?q=hello', { platform, execute: async (...args) => {
      calls.push(args); return { stdout: 'com.google.Chrome\n' };
    } });
    const [file, args] = calls.at(-1);
    assert.equal(args.at(-1), 'www.baidu.com/path?q=hello');
    if (platform === 'darwin') {
      assert.equal(calls.length, 2);
      assert.equal(file, '/usr/bin/open');
      assert.deepEqual(args, ['-n', '-b', 'com.google.Chrome', '--args', 'www.baidu.com/path?q=hello']);
    }
  }
  await assert.rejects(systemAction('openUrl', 'example.com', {
    platform: 'darwin', execute: async () => ({ stdout: '' }),
  }), /浏览器打开失败/);
});

test('removed M actions fall back on read, preserve other preferences and cannot be saved or executed', async () => {
  const s = await fixture();
  try {
    const legacy = { ...defaultPreferences(), mAction: 'backHome', dpi: '800', punctuation: false };
    await s.credentials.modifyRecord('dsh-asr/devices', () => ({ kind: 'grant', payload: {
      version: 1, devices: { '0001': { revision: 4, preferences: legacy } },
    } }));
    await s.connect('0001');
    const device = s.manager.view().devices[0];
    assert.equal(device.revision, 4);
    assert.deepEqual(device.preferences, { ...legacy, mAction: 'enter' });
    await s.key('0001', 'down', 'm'); await s.key('0001', 'up', 'm');
    assert.deepEqual(s.actions, [['enter', '']]);
    await assert.rejects(s.manager.save('0001', 4, legacy));
    await s.manager.save('0001', 4, { ...device.preferences, mAction: 'backspace' });
    assert.equal((await s.manager.store.get('0001')).preferences.mAction, 'backspace');
    for (const platform of ['darwin', 'win32']) {
      let called = false;
      await assert.rejects(systemAction('backHome', undefined, {
        platform, execute: async () => { called = true; },
      }), /不支持此按键动作/);
      assert.equal(called, false);
    }
  } finally { await s.stop(); }
});

test('a disconnect cancels the pending session; reconnect does not admit old-session audio/results', async () => {
  const s = await fixture();
  try {
    await s.connect('0001'); await s.key('0001', 'down');
    const old = s.manager.run; s.manager.accept('client', old.id);
    await s.send({ type: 'disconnected', id: '0001', mode: 0 }); await until(() => !s.manager.run);
    s.sdk.emit('event', { type: 'audio', id: '0001', data: Buffer.alloc(3200).toString('base64') });
    await s.connect('0001', 1); await s.key('0001', 'down');
    assert.notEqual(s.manager.run.connectionId, old.connectionId);
    assert.equal(s.manager.accept('client', old.id), false);
    assert.equal(s.events.some(e => e.type === 'result'), false); assert.equal(s.audio.length, 0);
  } finally { await s.stop(); }
});
test('device categories coexist and unknown categories do not execute mouse bindings', async () => {
  const s = await fixture();
  try {
    await s.connect('0001');
    await s.send({ type: 'connected', id: '0002', mode: 1, deviceType: 'keyboard', name: '测试键盘' });
    const devices = s.manager.view().devices;
    assert.deepEqual(devices.map(d => d.type), ['smart-mouse', 'keyboard']);
    assert.equal(devices[1].preferences, undefined);
    await s.key('0002', 'down'); assert.equal(s.manager.run, undefined);
    await assert.rejects(s.manager.save('0002', 0, defaultPreferences()), /不支持/);
  } finally { await s.stop(); }
});
test('service configuration is captured when the hardware key starts the session', async () => {
  let active = { id: 'first' }, observed;
  const s = await fixture({ prepare: async () => structuredClone(active), recognize: async function* (request) {
    observed = request.service;
    yield { type: 'ready' }; for await (const item of request.uplink) void item;
    if (request.signal.aborted) return;
    yield { type: 'transcript', text: '完成', begin: 0, end: 1, final: true }; yield { type: 'complete' };
  } });
  try {
    await s.connect('0001'); await s.key('0001', 'down'); active = { id: 'second' };
    s.manager.accept('client', s.manager.run.id); await s.key('0001', 'up'); await until(() => !s.manager.run);
    assert.deepEqual(observed, { id: 'first' });
  } finally { await s.stop(); }
});

test('plugin configuration accepts documented language and firmware maps and rejects legacy translation settings', () => {
  const config = pluginConfigSchema.parse({ recognitionLanguages: [{ ...defaultPreferences().recognition, query: { lid: '0', lanid: '0', role: '0' } }], dpiLevels: { '800': 21 } });
  assert.equal(config.recognitionLanguages[0].query.lanid, '0');
  assert.equal(config.tailMs, 150);
  assert.throws(() => pluginConfigSchema.parse({ translation: { method: 'POST', headers: {}, resultPath: 'data.text' } }));
  assert.throws(() => pluginConfigSchema.parse({ dpiLevels: { '1600': 1600 } }));
});

test('official language IDs preserve dialects, scripts and distinct Indonesian/Malay recognition', () => {
  const lookup = (language, accent = 'mandarin', rlang = '') => DEFAULT_LANGUAGES.find(item => item.language === language && item.accent === accent && item.rlang === rlang)?.query.lanid;
  assert.equal(new Set(DEFAULT_LANGUAGES.map(languageKey)).size, DEFAULT_LANGUAGES.length);
  assert.equal(lookup('en_us'), '1'); assert.equal(lookup('fr_fr'), '10');
  assert.equal(lookup('zh_cn', 'cantonese'), '4'); assert.equal(lookup('zh_cn', 'lmz'), '102');
  assert.equal(lookup('zh_cn', 'shanxinese'), '106'); // specs 中的 shanxinese 是陕西话，不是山西话。
  assert.equal(lookup('zh_cn', 'mandarin', 'zh-hk'), '100');
  assert.equal(lookup('id_ID'), '18'); assert.equal(lookup('ms_MY'), '24');
  for (const accent of ['hakkanese', 'nankinese', 'cn_cantonese', 'cn_lmz', 'taiwanese', 'wuhanese', 'changshanese']) assert.equal(lookup('zh_cn', accent), undefined);
  assert.equal(lookup('zh_cn', 'cantonese', 'zh-hk'), undefined);
  assert.equal(lookup('mn_cn'), undefined); assert.equal(lookup('mn_MN'), undefined);
});
test('USB ownership diagnosis clears on connection and cannot overwrite an online device', async () => {
  const f = await fixture();
  try {
    await f.send({ type: 'diagnostic', message: '鼠标 USB 数据接口被 ClawMouse 占用' });
    assert.match(f.manager.view().status, /ClawMouse/);
    await f.connect('FF0E254204000933');
    assert.equal(f.manager.view().status, '设备已连接');
    await f.send({ type: 'diagnostic', message: '迟到的占用诊断' });
    assert.equal(f.manager.view().status, '设备已连接');
    assert.equal(f.manager.view().devices.length, 1);
    await f.send({ type: 'disconnected', id: 'FF0E254204000933', mode: 0 });
    assert.match(f.manager.view().status, /重新查找/);
  } finally { await f.stop(); }
});
