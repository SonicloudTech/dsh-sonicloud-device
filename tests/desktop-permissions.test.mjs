import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DesktopPresentation } from '../src/desktop/presentation.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('打字权限组件及签名来源记录与实际 Swift 源码和二进制一致', async () => {
  const root = new URL('../native/desktop/', import.meta.url);
  const source = JSON.parse(await readFile(new URL('VOICE_SOURCE.json', root), 'utf8'));
  for (const [path, expected] of [[source.source, source.sourceSha256], [source.policy, source.policySha256], [source.binary, source.binarySha256]]) {
    const bytes = await readFile(new URL(path, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  }
  assert.equal(source.teamId, 'F3TYM6YPF7');
  assert.equal(source.bundleId, 'com.sonicloud.voice-panel');
  assert.equal(source.codesignVerified, true);
});

test('打字权限仅在 Mac 查询，只有显式授权操作才请求系统', async () => {
  const windows = new DesktopPresentation({ platform: 'win32', launch: () => assert.fail('Windows 无需权限进程') });
  assert.deepEqual(await windows.permissions(), { supported: false, accessibility: true, helperApp: '' });
  await windows.close();
  const calls = [], child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin.on('finish', () => child.emit('exit', 0));
  child.stdin.on('data', data => {
    const request = JSON.parse(data); calls.push(request);
    child.stdout.write(JSON.stringify({ id: request.id, ok: true, value: {
      supported: true, accessibility: false, helperApp: '/plugin/Sonicloud Voice.app',
    } }) + '\n');
  });
  const mac = new DesktopPresentation({ platform: 'darwin', launch: () => child });
  try {
    for (const action of ['check', 'accessibility', 'refresh']) {
      const status = await mac.permissions(action);
      assert.equal(status.accessibility, false);
      assert.equal(calls.at(-1).action, action);
      assert.equal(calls.at(-1).command, 'permissions');
    }
    assert.ok(calls.every(call => call.command !== 'begin'));
    await assert.rejects(mac.permissions('invalid'), /"key":"error\.permission"/);
  } finally { await mac.close(); }
  await assert.rejects(mac.permissions(), /"key":"error\.closed"/);
});

test('旧语音组件不会被误报为已获得打字权限', async () => {
  const panel = new DesktopPresentation({ platform: 'darwin' });
  panel.request = async () => true;
  await assert.rejects(panel.permissions(), /"key":"error\.permission"/);
});

test('打字权限查询超时不会终止正在使用的语音组件', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = false, faults = 0;
  child.kill = () => { killed = true; child.emit('exit', 1); };
  child.stdin.on('finish', () => child.emit('exit', 0));
  child.stdin.on('data', data => {
    const message = JSON.parse(data);
    if (message.command === 'begin') child.stdout.write(JSON.stringify({ id: message.id, ok: true, value: true }) + '\n');
  });
  const panel = new DesktopPresentation({ platform: 'darwin', launch: () => child, timeoutMs: 10 });
  panel.onFault = () => { faults++; };
  try {
    await panel.begin({ id: 'active', action: 'voice_input' });
    await assert.rejects(panel.permissions(), /"key":"error\.timeout"/);
    assert.equal(killed, false); assert.equal(faults, 0); assert.equal(panel.child, child);
  } finally { await panel.close(); }
});
