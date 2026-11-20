import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceController } from '../src/client/controller.mjs';
import { AsyncItems } from './helpers.mjs';
test('device stream reconnects after Host reload and cancels retry when disposed', async () => {
  let attempts = 0;
  const c = new DeviceController({ watch: async function* () {
    attempts++;
    if (attempts === 1) throw new Error('Host reloaded');
    yield { type: 'devices', status: '设备已连接', devices: [{ id: 'mouse' }] };
    c.dispose();
  } }, { retryDelayMs: 5 });
  await c.connect();
  assert.equal(attempts, 2);
  assert.equal(c.state.status, '设备已连接');
  assert.equal(c.state.devices[0].id, 'mouse');
  const retry = new DeviceController({ watch: async function* () {} }, { retryDelayMs: 10000 });
  const running = retry.connect();
  await new Promise(resolve => setTimeout(resolve, 0));
  retry.dispose(); await running;
});

test('settings client ignores speech events and never owns or cancels a desktop session', async () => {
  const c = new DeviceController({});
  const initial = c.snapshot();
  for (const event of [
    { type: 'request', sessionId: 's', action: 'voice_input' },
    { type: 'preview', sessionId: 's', text: '临时文字' },
    { type: 'result', sessionId: 's', text: '最终结果' },
  ]) await c.event(event);
  assert.equal(c.snapshot(), initial);
  await c.event({ type: 'notice', message: '设备错误' });
  assert.equal(c.state.toast.message, '设备错误');
  c.dispose();
});

test('截图按钮合并在途点击，失败显示提示，销毁后不再提交', async () => {
  let finish, calls = 0;
  const c = new DeviceController({ captureScreenshot: () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  } });
  const first = c.captureScreenshot();
  assert.equal(c.state.screenshotBusy, true);
  assert.equal(await c.captureScreenshot(), false);
  assert.equal(calls, 1);
  finish({ ok: false, error: { message: '截图正在进行' } });
  assert.equal(await first, false);
  assert.equal(c.state.screenshotBusy, false);
  assert.equal(c.state.toast.message, '截图正在进行');
  const second = c.captureScreenshot();
  finish({ ok: true, value: true });
  assert.equal(await second, true);
  c.dispose();
  assert.equal(await c.captureScreenshot(), false);
  assert.equal(calls, 2);
});

test('截图启动时卸载界面不再发布状态或错误', async () => {
  let finish;
  const c = new DeviceController({ captureScreenshot: () => new Promise(resolve => { finish = resolve; }) });
  const capturing = c.captureScreenshot();
  c.dispose();
  const before = c.snapshot();
  finish({ ok: false, error: { message: '进程已退出' } });
  assert.equal(await capturing, false);
  assert.equal(c.snapshot(), before);
});

const permissionState = patch => ({ supported: true, screenRecording: false, accessibility: false,
  helperApp: '/cache/screenhelper.app', ...patch });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('首次权限检查不阻塞设备流，缺权限只提醒一次且不会自动申请', async () => {
  const events = new AsyncItems(), calls = [];
  let finish;
  const c = new DeviceController({ watch: () => events, screenshotPermissions: action => {
    calls.push(action); return new Promise(resolve => { finish = resolve; });
  } });
  const running = c.connect();
  events.push({ type: 'devices', status: '鼠标已就绪', devices: [], recognitionLanguages: [], translationReady: true });
  await tick();
  assert.equal(c.state.status, '鼠标已就绪');
  assert.equal(c.state.screenshotPermissionBusy, true);
  assert.deepEqual(calls, ['check']);
  finish({ ok: true, value: permissionState() });
  await tick();
  assert.equal(c.state.screenshotPermissions.screenRecording, false);
  assert.match(c.state.toast.message, /macOS 首次使用.*声云设备.*授权/);
  const firstToast = c.state.toast;
  const recheck = c.refreshScreenshotPermissions('check', { automatic: true });
  await tick(); finish({ ok: true, value: permissionState() }); await recheck;
  assert.strictEqual(c.state.toast, firstToast);
  c.dispose(); events.end(); await running;
});

test('授权请求成功保持未授权状态，辅助功能缺失不阻止普通截图', async () => {
  const actions = []; let captures = 0;
  let current = permissionState();
  const c = new DeviceController({ screenshotPermissions: async action => {
    actions.push(action); return { ok: true, value: { ...current } };
  }, captureScreenshot: async () => { captures++; return { ok: true, value: true }; } });
  await c.refreshScreenshotPermissions();
  assert.equal(await c.captureScreenshot(), false); assert.equal(captures, 0);
  await c.refreshScreenshotPermissions('screen');
  assert.equal(c.state.screenshotPermissions.screenRecording, false);
  assert.match(c.state.screenshotPermissionMessage, /完成授权.*重新检查/);
  current = permissionState({ screenRecording: true });
  await c.refreshScreenshotPermissions('refresh');
  assert.equal(await c.captureScreenshot(), true); assert.equal(captures, 1);
  assert.equal(c.state.screenshotPermissions.accessibility, false);
  assert.deepEqual(actions, ['check', 'screen', 'refresh']); c.dispose();
});

test('权限检查失败保留未知状态，可重新检查；卸载后忽略迟到结果', async () => {
  let finish, fail = true;
  const c = new DeviceController({ screenshotPermissions: () => {
    if (fail) throw new Error('组件暂未就绪');
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.equal(await c.refreshScreenshotPermissions(), undefined);
  assert.equal(c.state.screenshotPermissions, undefined);
  assert.equal(c.state.screenshotPermissionBusy, false);
  assert.equal(c.state.screenshotPermissionError, '组件暂未就绪');
  fail = false;
  const checking = c.refreshScreenshotPermissions('refresh'); await tick();
  finish({ ok: true, value: permissionState({ screenRecording: true }) });
  await checking;
  assert.equal(c.state.screenshotPermissionError, undefined);
  const late = c.refreshScreenshotPermissions('refresh'); await tick();
  c.dispose(); const before = c.snapshot();
  finish({ ok: true, value: permissionState({ screenRecording: false }) });
  await late; assert.strictEqual(c.snapshot(), before);
});

test('服务重连重新检查权限，旧连接的迟到授权状态不能覆盖新结果', async () => {
  const streams = [new AsyncItems(), new AsyncItems()], pending = [];
  let attempts = 0;
  const c = new DeviceController({ watch: () => streams[attempts++],
    screenshotPermissions: () => new Promise(resolve => pending.push(resolve)),
  }, { retryDelayMs: 1 });
  const running = c.connect(); await tick();
  streams[0].end();
  for (let i = 0; i < 20 && pending.length < 2; i++) await tick();
  assert.equal(pending.length, 2);
  pending[1]({ ok: true, value: permissionState() }); await tick();
  pending[0]({ ok: true, value: permissionState({ screenRecording: true, accessibility: true }) }); await tick();
  assert.equal(c.state.screenshotPermissions.screenRecording, false);
  c.dispose(); streams[1].end(); await running;
});

test('两类权限并行检查每连接只提示一次，打字缺权限不阻挡截图', async () => {
  const streams = [new AsyncItems(), new AsyncItems()], typingCalls = [], toasts = new Set();
  let attempts = 0, captures = 0;
  const c = new DeviceController({ watch: () => streams[attempts++],
    screenshotPermissions: async () => ({ ok: true, value: permissionState({ screenRecording: true }) }),
    typingPermissions: async action => { typingCalls.push(action); return { ok: true,
      value: { supported: true, accessibility: false, helperApp: '/cache/Sonicloud Voice.app' } }; },
    captureScreenshot: async () => { captures++; return { ok: true, value: true }; },
  }, { retryDelayMs: 1 });
  c.subscribe(() => { if (c.state.toast) toasts.add(c.state.toast.id); });
  const running = c.connect(); await tick();
  assert.equal(c.state.screenshotPermissions.screenRecording, true);
  assert.equal(c.state.typingPermissions.accessibility, false);
  assert.equal(toasts.size, 1);
  await c.refreshTypingPermissions('accessibility');
  assert.deepEqual(typingCalls, ['check', 'accessibility']);
  assert.equal(c.state.typingPermissions.accessibility, false);
  assert.match(c.state.typingPermissionMessage, /Sonicloud Voice.*完成授权/);
  assert.equal(await c.captureScreenshot(), true); assert.equal(captures, 1);
  streams[0].end();
  for (let i = 0; i < 20 && typingCalls.filter(action => action === 'check').length < 2; i++) await tick();
  assert.equal(toasts.size, 2);
  c.dispose(); streams[1].end(); await running;
});

test('打字权限检查失败不伪造授权，也不阻止独立截图', async () => {
  const c = new DeviceController({ typingPermissions: async () => ({ ok: false, error: { message: '打字组件未就绪' } }),
    captureScreenshot: async () => ({ ok: true, value: true }),
  });
  await c.refreshTypingPermissions();
  assert.equal(c.state.typingPermissions, undefined);
  assert.equal(c.state.typingPermissionError, '打字组件未就绪');
  assert.equal(await c.captureScreenshot(), true); c.dispose();
});
