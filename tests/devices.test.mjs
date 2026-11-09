import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DeviceManager } from '../src/devices/manager.mjs';
import { DeviceStore } from '../src/devices/store.mjs';
import { defaultPreferences, searchAddress, languageKey, REC_LANG_LIST, TRANS_FROM_LANG_LIST, TRANS_TO_LANG_LIST } from '../src/shared/devices.mjs';
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
  const key = (id, action, key = 'speech') => send({ type: 'message', id, message: { type: 'keyEvent', key, action } });
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
