import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceController } from '../src/client/controller.mjs';
function setup(insert = () => true) {
  const calls = [], writes = [];
  const c = new DeviceController({ accept: async (...args) => { calls.push(['accept', ...args]); return { ok: true, value: true }; }, cancel: async (...args) => { calls.push(['cancel', ...args]); return { ok: true, value: true }; } });
  const unbind = c.bindTarget({ valid: () => true, capture: () => ({ draftRev: 1, start: 2, end: 4 }), insert: (text, span) => { writes.push([text, span]); return insert(); } });
  return { c, calls, writes, unbind };
}
const request = (sessionId = 's', action = 'voice_input') => ({ type: 'request', sessionId, sn: '001', action });
test('hardware request captures insertion once; previews never write and duplicate final results are ignored', async () => {
  const { c, writes } = setup();
  await c.event(request());
  await c.event({ type: 'preview', sessionId: 's', text: '临时' }); assert.equal(writes.length, 0);
  await c.event({ type: 'result', sessionId: 's', text: '最终' });
  await c.event({ type: 'result', sessionId: 's', text: '重复' });
  assert.deepEqual(writes, [['最终', { draftRev: 1, start: 2, end: 4 }]]); assert.equal(c.state.message, '');
});
test('draft conflict preserves text; unmount and cancellation reject late translated results', async () => {
  const { c, writes, unbind } = setup(() => false);
  await c.event(request()); await c.event({ type: 'result', sessionId: 's', text: '保留' });
  assert.equal(c.state.phase, 'result'); assert.equal(c.state.preview, '保留');
  await c.event(request('next', 'translate')); unbind();
  await c.event({ type: 'result', sessionId: 'next', text: '不能回填' }); assert.equal(writes.length, 1);
});
test('search works without an input target; typing cannot start without one', async () => {
  const { c, unbind, calls } = setup(); unbind();
  await c.event(request()); assert.equal(c.run, undefined); assert.equal(calls.at(-1)[0], 'cancel');
  await c.event(request('search', 'speechSearch')); assert.equal(c.run.id, 'search');
  await c.event({ type: 'finished', sessionId: 'search' }); assert.equal(c.state.phase, 'idle');
});
test('cancel, unrelated and late device results cannot write into the active input', async () => {
  const { c, writes } = setup(); await c.event(request());
  await c.event({ type: 'result', sessionId: 'other', text: '错误' }); assert.ok(c.run);
  c.cancel(); await c.event({ type: 'result', sessionId: 's', text: '迟到' });
  assert.equal(writes.length, 0); assert.equal(c.state.preview, '');
});

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
  assert.equal(c.state.phase, 'idle');
  const retry = new DeviceController({ watch: async function* () {} }, { retryDelayMs: 10000 });
  const running = retry.connect();
  await new Promise(resolve => setTimeout(resolve, 0));
  retry.dispose(); await running;
});


test('terminal failure creates one toast; duplicate and cancelled-session failures stay silent', async () => {
  const { c } = setup();
  const notices = [];
  c.subscribe(() => { if (c.state.toast && notices.at(-1) !== c.state.toast.id) notices.push(c.state.toast.id); });
  await c.event(request());
  await c.event({ type: 'preview', sessionId: 's', text: '识别原文' });
  await c.event({ type: 'failed', sessionId: 's', message: '翻译认证失败，请稍后重试' });
  assert.equal(notices.length, 1); assert.equal(c.state.preview, '识别原文');
  await c.event({ type: 'failed', sessionId: 's', message: '重复失败' });
  assert.equal(notices.length, 1);
  c.dismissToast(c.state.toast.id); assert.equal(c.state.toast, undefined);
  await c.event(request('next')); c.cancel();
  await c.event({ type: 'failed', sessionId: 'next', message: '取消后的失败' });
  assert.equal(notices.length, 1); assert.equal(c.state.phase, 'idle');
  c.dispose();
});
