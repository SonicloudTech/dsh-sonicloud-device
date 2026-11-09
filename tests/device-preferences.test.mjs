import test from 'node:test';
import assert from 'node:assert/strict';
import { DevicePreferences } from '../src/client/device-preferences.mjs';
import { DeviceController } from '../src/client/controller.mjs';
import { defaultPreferences } from '../src/shared/devices.mjs';

const device = (sn = '0001') => ({ sn, revision: 0, preferences: defaultPreferences() });
const saved = (revision, preferences) => ({ ok: true, value: { revision, preferences, message: '已保存' } });
function deferredApi() {
  const requests = [];
  return { requests, saveDevice: (sn, revision, preferences) => new Promise(resolve => requests.push({ sn, revision, preferences, resolve })) };
}

test('autosave serializes and coalesces rapid changes using the latest revision', async () => {
  const api = deferredApi(), editor = new DevicePreferences(api, device());
  const saving = editor.change('punctuation', false);
  editor.change('dpi', '800');
  editor.change('dpi', '2400');
  assert.equal(api.requests.length, 1);
  api.requests[0].resolve(saved(1, api.requests[0].preferences));
  await Promise.resolve();
  assert.equal(api.requests.length, 2);
  assert.equal(api.requests[1].revision, 1);
  assert.equal(api.requests[1].preferences.dpi, '2400');
  assert.equal(api.requests[1].preferences.punctuation, false);
  api.requests[1].resolve(saved(2, api.requests[1].preferences));
  await saving;
  assert.equal(editor.snapshot().busy, false);
  assert.equal(editor.snapshot().form.dpi, '2400');
});

test('restore defaults stays queued for its SN across device switches', async () => {
  const api = deferredApi(), controller = new DeviceController(api);
  const first = controller.preferences(device('0001'));
  const second = controller.preferences(device('0002'));
  const saving = first.change('mAction', 'speechSearch');
  first.reset();
  assert.equal(controller.preferences(device('0001')), first);
  api.requests[0].resolve(saved(1, api.requests[0].preferences));
  await Promise.resolve();
  assert.equal(api.requests[1].sn, '0001');
  assert.deepEqual(api.requests[1].preferences, defaultPreferences());
  api.requests[1].resolve(saved(2, api.requests[1].preferences));
  await saving;
  assert.deepEqual(first.snapshot().form, defaultPreferences());
  assert.deepEqual(second.snapshot().form, defaultPreferences());
  controller.dispose();
});

test('link drafts are validated and saved only on confirmation, including action and trimmed address', async () => {
  const calls = [], editor = new DevicePreferences({ saveDevice: async (...args) => {
    calls.push(args); return saved(args[1] + 1, args[2]);
  } }, device());
  await editor.change('mAction', 'openWebUrl');
  await editor.change('linkUrl', 'https://');
  assert.equal(calls.length, 0);
  assert.equal(editor.snapshot().error, '');
  await editor.commitLink();
  assert.equal(editor.snapshot().invalid, true);
  await editor.change('linkUrl', '  https://example.com  ');
  assert.equal(calls.length, 0);
  await editor.commitLink();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].mAction, 'openWebUrl');
  assert.equal(calls[0][2].linkUrl, 'https://example.com');
  assert.equal(editor.snapshot().error, '');
});

test('failed autosave rolls back to confirmed settings and permits retry', async () => {
  const api = deferredApi(), editor = new DevicePreferences(api, device());
  const first = editor.change('punctuation', false);
  editor.change('dpi', '800');
  const external = { ...device(), revision: 1, preferences: { ...defaultPreferences(), dpi: '1200' } };
  editor.sync(external);
  api.requests[0].resolve({ ok: false, error: { message: '配置冲突' } });
  await first;
  assert.equal(api.requests.length, 1);
  assert.deepEqual(editor.snapshot().form, external.preferences);
  assert.match(editor.snapshot().error, /未保存.*配置冲突/);
  const retry = editor.change('punctuation', false);
  assert.equal(api.requests[1].revision, 1);
  api.requests[1].resolve(saved(2, api.requests[1].preferences));
  await retry;
  assert.equal(editor.snapshot().error, '');
});

test('late save replies cannot erase invalid drafts or send queued changes after disposal', async () => {
  const api = deferredApi(), editor = new DevicePreferences(api, device());
  const saving = editor.change('punctuation', false);
  editor.change('mAction', 'openWebUrl');
  editor.commitLink();
  api.requests[0].resolve(saved(1, api.requests[0].preferences));
  await saving;
  assert.equal(editor.snapshot().form.mAction, 'openWebUrl');
  assert.equal(editor.snapshot().invalid, true);
  editor.change('linkUrl', 'https://example.com');
  const next = editor.commitLink();
  editor.reset();
  editor.dispose();
  api.requests[1].resolve(saved(2, api.requests[1].preferences));
  await next;
  assert.equal(api.requests.length, 2);
});

test('editing a saved Baidu URL preserves drafts through device snapshots and rejects invalid addresses on confirmation', async () => {
  const original = { ...device(), preferences: { ...defaultPreferences(), mAction: 'openWebUrl', linkUrl: 'https://www.baidu.com' } };
  const api = deferredApi(), editor = new DevicePreferences(api, original);
  editor.change('linkUrl', 'https://');
  editor.sync(original);
  assert.equal(editor.snapshot().form.linkUrl, 'https://');
  assert.equal(editor.snapshot().error, '');
  editor.commitLink();
  assert.match(editor.snapshot().error, /当前修改尚未生效/);
  assert.equal(api.requests.length, 0);
  editor.sync(original);
  assert.equal(editor.snapshot().form.linkUrl, 'https://');
  editor.change('linkUrl', 'www.google.com');
  editor.sync(original);
  assert.equal(editor.snapshot().form.linkUrl, 'www.google.com');
  assert.equal(api.requests.length, 0);
  const saving = editor.commitLink();
  assert.equal(api.requests[0].preferences.linkUrl, 'www.google.com');
  api.requests[0].resolve(saved(1, api.requests[0].preferences));
  await saving;
  assert.equal(editor.confirmed.preferences.linkUrl, 'www.google.com');
});

test('a late successful or failed save cannot erase or auto-save a newer link draft', async () => {
  for (const ok of [true, false]) {
    const api = deferredApi(), editor = new DevicePreferences(api, { ...device(), preferences: {
      ...defaultPreferences(), mAction: 'openWebUrl', linkUrl: 'https://www.baidu.com',
    } });
    const saving = editor.change('punctuation', false);
    editor.change('linkUrl', 'https://www.google.com');
    api.requests[0].resolve(ok ? saved(1, api.requests[0].preferences) : { ok: false, error: { message: '网络错误' } });
    await saving;
    editor.sync(editor.confirmed);
    assert.equal(editor.snapshot().form.linkUrl, 'https://www.google.com');
    assert.equal(api.requests.length, 1);
    const next = editor.commitLink();
    assert.equal(api.requests[1].preferences.linkUrl, 'https://www.google.com');
    assert.equal(api.requests[1].revision, ok ? 1 : 0);
    api.requests[1].resolve(saved(ok ? 2 : 1, api.requests[1].preferences));
    await next;
  }
});

test('switching M action or restoring defaults discards an uncommitted link draft', async () => {
  const calls = [], editor = new DevicePreferences({ saveDevice: async (...args) => {
    calls.push(args); return saved(args[1] + 1, args[2]);
  } }, device());
  editor.change('mAction', 'openWebUrl'); editor.change('linkUrl', 'invalid'); editor.commitLink();
  await editor.change('mAction', 'backspace');
  assert.equal(calls[0][2].mAction, 'backspace');
  assert.equal(calls[0][2].linkUrl, '');
  editor.change('mAction', 'openWebUrl'); editor.change('linkUrl', 'https://example.com');
  await editor.reset();
  assert.deepEqual(calls[1][2], defaultPreferences());
  assert.equal(editor.snapshot().linkDirty, false);
});

test('link confirmation toasts report validation, server failure and success only after saving', async () => {
  const api = deferredApi(), notices = [];
  const editor = new DevicePreferences(api, device(), (...args) => notices.push(args));
  editor.change('mAction', 'openWebUrl'); editor.change('linkUrl', 'https://');
  editor.commitLink(); editor.commitLink();
  assert.equal(api.requests.length, 0);
  assert.equal(notices.length, 2);
  assert.ok(notices.every(([message, kind]) => kind === 'error' && /设置未生效/.test(message)));
  editor.change('linkUrl', 'https://www.google.com');
  const failed = editor.commitLink();
  assert.equal(notices.length, 2);
  api.requests[0].resolve({ ok: false, error: { message: '保存失败' } });
  await failed;
  assert.match(notices[2][0], /保存失败/);
  assert.equal(notices[2][1], 'error');
  assert.equal(editor.confirmed.preferences.mAction, 'enter');
  editor.change('mAction', 'openWebUrl'); editor.change('linkUrl', 'https://www.google.com');
  const success = editor.commitLink();
  assert.equal(notices.length, 3);
  api.requests[1].resolve(saved(1, api.requests[1].preferences));
  await success;
  assert.deepEqual(notices[3], ['链接设置成功，已生效', 'success']);
  assert.equal(editor.confirmed.preferences.linkUrl, 'https://www.google.com');
});

test('selecting one-click link with an existing URL still requires confirmation', async () => {
  const api = deferredApi(), editor = new DevicePreferences(api, { ...device(), preferences: {
    ...defaultPreferences(), linkUrl: 'https://example.com',
  } });
  editor.change('mAction', 'openWebUrl');
  assert.equal(api.requests.length, 0);
  assert.equal(editor.confirmed.preferences.mAction, 'enter');
  const saving = editor.commitLink();
  api.requests[0].resolve(saved(1, api.requests[0].preferences));
  await saving;
  assert.equal(editor.confirmed.preferences.mAction, 'openWebUrl');
});
