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

test('invalid link drafts are not sent, and completing the URL saves the action and address', async () => {
  const calls = [], editor = new DevicePreferences({ saveDevice: async (...args) => {
    calls.push(args); return saved(args[1] + 1, args[2]);
  } }, device());
  await editor.change('mAction', 'openWebUrl');
  await editor.change('linkUrl', 'https://');
  assert.equal(calls.length, 0);
  assert.equal(editor.snapshot().invalid, true);
  await editor.change('linkUrl', 'https://example.com');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].mAction, 'openWebUrl');
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
  api.requests[0].resolve(saved(1, api.requests[0].preferences));
  await saving;
  assert.equal(editor.snapshot().form.mAction, 'openWebUrl');
  assert.equal(editor.snapshot().invalid, true);
  const next = editor.change('linkUrl', 'https://example.com');
  editor.reset();
  editor.dispose();
  api.requests[1].resolve(saved(2, api.requests[1].preferences));
  await next;
  assert.equal(api.requests.length, 2);
});
