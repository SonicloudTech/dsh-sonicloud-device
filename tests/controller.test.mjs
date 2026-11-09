import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceController } from '../src/client/controller.mjs';
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
