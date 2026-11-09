import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DesktopPresentation } from '../src/desktop/presentation.mjs';
import { DeviceManager } from '../src/devices/manager.mjs';
import { MemoryCredentials, until } from './helpers.mjs';
import { defaultPreferences } from '../src/shared/devices.mjs';

function nativeFixture(options = {}) {
  const messages = [], launches = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  child.stdin.on('finish', () => child.emit('exit', 0));
  child.stdin.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line); messages.push(message);
      if (message.id && !options.silent) child.stdout.write(JSON.stringify({ id: message.id, ok: true, value: true }) + '\n');
    }
  });
  const panel = new DesktopPresentation({ platform: 'darwin', launch: (...args) => { launches.push(args); return child; }, ...options });
  return { panel, child, messages, launches };
}
test('native IPC keeps transcripts out of arguments, guards sessions and releases the helper', async () => {
  const { panel, child, messages, launches } = nativeFixture();
  let cancelled;
  panel.onCancel = id => { cancelled = id; };
  await panel.begin({ id: 'one', action: 'voice_input' });
  panel.event({ type: 'preview', sessionId: 'old', text: '迟到' });
  panel.event({ type: 'preview', sessionId: 'one', text: '临时文字' });
  child.stdout.write('{invalid}\n');
  child.stdout.write(JSON.stringify({ event: 'cancel', sessionId: 'old' }) + '\n');
  assert.equal(cancelled, undefined);
  child.stdout.write(JSON.stringify({ event: 'cancel', sessionId: 'one' }) + '\n');
  assert.equal(cancelled, 'one');
  assert.equal(await panel.complete({ id: 'one' }, '最终结果'), true);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0][1], []);
  assert.ok(!messages.some(message => message.text === '迟到'));
  assert.ok(messages.some(message => message.text === '最终结果'));
  await panel.close(); assert.equal(child.stdin.writableEnded, true); assert.notEqual(child.killed, true); assert.equal(panel.requests.size, 0);
});
test('helper failure and timeout reject pending work; a closed helper cannot restart', async () => {
  const fixture = nativeFixture({ silent: true, timeoutMs: 10 });
  await assert.rejects(fixture.panel.begin({ id: 'timeout' }), /超时/);
  assert.equal(fixture.child.killed, true);
  await fixture.panel.close();
  await assert.rejects(fixture.panel.begin({ id: 'late' }), /已关闭/);
  const broken = nativeFixture({ silent: true });
  const pending = broken.panel.begin({ id: 'broken' });
  broken.child.emit('error', new Error('ENOENT'));
  await assert.rejects(pending, /不可用/); await broken.panel.close();
});
test('Windows helper runs hidden with only its script path in process arguments', async () => {
  const { panel, launches } = nativeFixture({ platform: 'win32' });
  await panel.begin({ id: 'windows', action: 'translate' });
  assert.equal(launches[0][0], 'powershell.exe');
  assert.ok(launches[0][1].includes('-STA'));
  assert.equal(launches[0][2].windowsHide, true);
  assert.match(launches[0][1].at(-1), /windows.ps1$/);
  await panel.close();
});
async function backgroundFixture(overrides = {}) {
  const sdk = new EventEmitter();
  sdk.start = async () => {}; sdk.source = async () => 1; sdk.dpi = async () => 1; sdk.close = async () => {};
  const events = [], results = [], starts = [];
  const desktop = { begin: async run => starts.push(run.id), event: event => events.push(event),
    complete: async (run, text) => results.push([run.id, text]), close: async () => { desktop.closed = true; } };
  const manager = new DeviceManager({ credentials: new MemoryCredentials(), sdk, desktop, config: { tailMs: 0 },
    recognize: async function* ({ uplink, signal }) {
      yield { type: 'ready' };
      yield { type: 'transcript', text: '中间文字', final: false, begin: 0, end: 1 };
      for await (const audio of uplink) { signal.throwIfAborted(); }
      yield { type: 'finishing' };
      yield { type: 'transcript', text: '最终文字', final: true, begin: 0, end: 1 };
      yield { type: 'complete' };
    }, translate: async () => '译文', ...overrides });
  await manager.start(); await manager.event({ type: 'connected', id: '0001', mode: 0 });
  const key = action => manager.event({ type: 'message', id: '0001', message: { type: 'keyEvent', key: 'speech', action } });
  return { manager, desktop, events, results, starts, key };
}
test('typing and translation run with no Harness renderer and keep previews in the native panel', async () => {
  const s = await backgroundFixture();
  try {
    assert.equal(s.manager.owner, undefined);
    for (const [revision, action, expected] of [[0, 'voice_input', '最终文字'], [1, 'translate', '译文']]) {
      await s.manager.save('0001', revision, { ...defaultPreferences(), speechAction: action });
      await s.key('down'); await until(() => s.events.some(e => e.type === 'preview'));
      assert.equal(s.results.length, revision);
      await s.key('up'); await until(() => !s.manager.run);
      assert.equal(s.results.at(-1)[1], expected);
    }
    assert.ok(s.events.some(e => e.type === 'phase' && e.phase === 'translating'));
    assert.equal(s.starts.length, 2);
  } finally { await s.manager.close(); }
  assert.equal(s.desktop.closed, true);
});
test('empty final recognition dismisses previews and skips insertion, translation and search', async () => {
  for (const action of ['voice_input', 'translate', 'speechSearch']) {
    for (const finalText of ['', ' \n\t']) {
      const downstream = [];
      const s = await backgroundFixture({
        recognize: async function* ({ uplink }) {
          yield { type: 'ready' };
          yield { type: 'transcript', text: '临时文字', final: false, begin: 0, end: 1 };
          for await (const audio of uplink) { }
          yield { type: 'transcript', text: finalText, final: true, begin: 0, end: 1 };
          yield { type: 'complete' };
        },
        translate: async () => { downstream.push('translate'); return '译文'; },
        action: async () => { downstream.push('search'); },
      });
      try {
        const preferences = { ...defaultPreferences() };
        const key = action === 'speechSearch' ? 'm' : 'speech';
        if (key === 'm') preferences.mAction = action;
        else preferences.speechAction = action;
        await s.manager.save('0001', 0, preferences);
        const press = action => s.manager.event({ type: 'message', id: '0001', message: { type: 'keyEvent', key, action } });
        await press('down'); const run = s.manager.run;
        await until(() => s.events.some(e => e.type === 'preview'));
        await press('up'); await until(() => !s.manager.run);
        assert.equal(s.events.filter(e => e.type === 'finished' && e.sessionId === run.id).length, 1);
        assert.ok(!s.events.some(e => e.type === 'failed' || e.type === 'notice'));
        assert.deepEqual(s.results, []);
        assert.deepEqual(downstream, []);
        assert.equal(run.lifetime.signal.aborted, true);
      } finally { await s.manager.close(); }
    }
  }
});
test('settings subscriptions are observers; disconnecting every renderer does not cancel speech', async () => {
  const s = await backgroundFixture();
  const a = new AbortController(), b = new AbortController(), received = [];
  const watches = [a, b].map((abort, index) => (async () => {
    for await (const event of s.manager.watch('window-' + index, abort.signal)) received.push(event);
  })());
  try {
    await until(() => received.length >= 2);
    await s.key('down'); const run = s.manager.run;
    a.abort(); b.abort(); await Promise.all(watches);
    assert.equal(s.manager.run, run); assert.equal(run.lifetime.signal.aborted, false);
    await s.key('up'); await until(() => !s.manager.run);
    assert.equal(s.results.length, 1);
    assert.ok(received.every(event => event.type === 'devices'));
  } finally { await s.manager.close(); }
});
test('native cancel and a helper crash stop speech and suppress late translation', async () => {
  let resolve;
  const s = await backgroundFixture({ translate: () => new Promise(done => { resolve = done; }) });
  try {
    await s.manager.save('0001', 0, { ...defaultPreferences(), speechAction: 'translate' });
    await s.key('down'); const run = s.manager.run; await s.key('up');
    await until(() => resolve);
    s.desktop.onCancel('old'); assert.equal(s.manager.run, run);
    s.desktop.onCancel(run.id); await until(() => !s.manager.run);
    resolve('迟到译文'); await new Promise(done => setImmediate(done));
    assert.deepEqual(s.results, []);
    await s.key('down'); s.desktop.onFault(); await until(() => !s.manager.run);
    assert.ok(s.events.some(e => e.type === 'failed' && /浮层/.test(e.message)));
  } finally { await s.manager.close(); }
});
test('failure to create the native panel releases capture without starting recognition', async () => {
  const s = await backgroundFixture();
  s.desktop.begin = async () => { throw new Error('浮层不可用'); };
  try {
    await s.key('down'); await until(() => !s.manager.run);
    assert.deepEqual(s.results, []);
    assert.ok(s.events.some(e => e.type === 'failed' && e.message === '浮层不可用'));
  } finally { await s.manager.close(); }
});
