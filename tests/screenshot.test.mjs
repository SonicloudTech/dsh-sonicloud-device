import { message as msg } from '../src/shared/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ScreenshotService, prepareMacScreenshot } from '../src/desktop/screenshot.mjs';

function fixture(options = {}) {
  const children = [], launches = [], messages = [];
  const launch = (...args) => {
    launches.push(args);
    const child = new EventEmitter(); child.connected = true;
    child.kill = () => { child.killed = true; child.connected = false; child.emit('exit', 1); };
    child.send = (message, callback) => {
      messages.push(message);
      if (options.sendError && message.command === 'capture') { callback(new Error('IPC closed')); return; }
      callback?.();
      if (message.command === 'close' && !options.hangClose) { child.connected = false; queueMicrotask(() => child.emit('exit', 0)); }
      else if (message.command === 'capture' && !options.silent) queueMicrotask(() => child.emit('message', {
        type: 'reply', requestId: message.requestId, ok: !options.busy, message: msg('error.busy'),
      }));
    };
    children.push(child);
    if (!options.noReady) queueMicrotask(() => child.emit('message', { type: 'ready' }));
    return child;
  };
  const service = new ScreenshotService({ platform: 'win32', arch: 'x64', launch, exists: () => true,
    timeoutMs: 30, startTimeoutMs: 30, closeTimeoutMs: 30, ...options });
  return { service, children, launches, messages };
}

test('截图按需共用后台进程，明确忙碌状态并正常退出', async () => {
  const f = fixture();
  assert.equal(f.launches.length, 0);
  assert.deepEqual(await Promise.all([f.service.capture('mouse'), f.service.capture()]), [true, true]);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0][2].windowsHide, true);
  assert.match(f.launches[0][1][0], /native[\\/]screenshot[\\/]win32-x64[\\/]screentool\.dll$/);
  assert.match(f.launches[0][1][1], /screenhelper\.exe$/);
  assert.deepEqual(f.messages.map(m => m.trigger).filter(Boolean), ['mouse', 'ui']);
  const closing = f.service.close(); assert.strictEqual(f.service.close(), closing); await closing;
  assert.equal(f.children[0].killed, undefined);
  await assert.rejects(f.service.capture(), /"key":"error\.closed"/);
  const busy = fixture({ busy: true });
  await assert.rejects(busy.service.capture(), /"key":"error\.busy"/); await busy.service.close();
});

test('子进程故障取消在途请求，并允许下一次截图重启', async () => {
  const f = fixture({ silent: true });
  const notices = []; f.service.on('notice', value => notices.push(value));
  await f.service.start();
  const pending = f.service.capture();
  await Promise.resolve();
  f.children[0].emit('exit', 1);
  await assert.rejects(pending, /"key":"error\.screenshot"/);
  assert.equal(f.service.pending.size, 0);
  await f.service.start(); assert.equal(f.launches.length, 2);
  f.children[0].emit('message', { type: 'fatal' });
  assert.equal(f.service.child, f.children[1]);
  f.children[1].emit('message', { type: 'notice', message: '请允许 screenhelper 使用屏幕录制' });
  assert.ok(notices.includes('请允许 screenhelper 使用屏幕录制'));
  await f.service.close();
});

test('启动失败、超时与通信失败均能收尾和重试', async () => {
  for (const [options, pattern] of [[{ noReady: true }, /"key":"error\.timeout"/], [{ silent: true }, /"key":"error\.timeout"/], [{ sendError: true }, /"key":"error\.screenshot"/]]) {
    const f = fixture(options);
    await assert.rejects(f.service.capture(), pattern);
    assert.equal(f.children[0].killed, true);
    assert.equal(f.service.pending.size, 0); await f.service.close();
  }
  const fatal = fixture({ noReady: true });
  const pending = fatal.service.capture();
  fatal.children[0].emit('message', { type: 'fatal' });
  await assert.rejects(pending, /"key":"error\.screenshot"/); await fatal.service.close();
});

test('关闭时阻止迟到启动和截图，失联子进程强制退出', async () => {
  const f = fixture({ noReady: true, hangClose: true });
  const capture = f.service.capture();
  const rejected = assert.rejects(capture, /"key":"error\.closed"/);
  await f.service.close(); await rejected;
  assert.equal(f.children[0].killed, true);
  assert.equal(f.messages.filter(m => m.command === 'capture').length, 0);
  let ready;
  const mac = fixture({ platform: 'darwin', arch: 'arm64', prepareMac: () => new Promise(resolve => { ready = resolve; }) });
  const late = mac.service.capture(); const lateRejected = assert.rejects(late, /"key":"error\.closed"/);
  await mac.service.close(); ready({ libraryPath: '/cache/lib.dylib', helperPath: '/cache/screenhelper' });
  await lateRejected; assert.equal(mac.launches.length, 0);
});

test('不支持的平台与缺失组件不启动后台进程，Mac使用已准备路径', async () => {
  const unsupported = fixture({ platform: 'linux' });
  await assert.rejects(unsupported.service.capture(), /"key":"error\.screenshot"/);
  const missing = fixture({ exists: () => false });
  await assert.rejects(missing.service.capture(), /"key":"error\.screenshot"/);
  assert.equal(missing.launches.length, 0);
  const brokenMac = fixture({ platform: 'darwin', arch: 'arm64', prepareMac: async () => { throw new Error('private path'); } });
  await assert.rejects(brokenMac.service.capture(), /"key":"error\.permission"/);
  const mac = fixture({ platform: 'darwin', arch: 'arm64', prepareMac: async () => ({ libraryPath: '/cache/lib.dylib', helperPath: '/cache/app/screenhelper' }) });
  await mac.service.capture(); assert.deepEqual(mac.launches[0][1], ['/cache/lib.dylib', '/cache/app/screenhelper']);
  await mac.service.close();
});

test('macOS使用ditto保留原包并按内容缓存，失败只清理本次临时目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sonicloud-screenshot-test-'));
  try {
    const archivePath = join(root, 'original.zip'), cacheRoot = join(root, 'cache');
    await writeFile(archivePath, 'signed zip fixture');
    let extractions = 0;
    const extract = async (file, args, options) => {
      assert.equal(file, '/usr/bin/ditto'); assert.deepEqual(args.slice(0, 3), ['-x', '-k', archivePath]);
      assert.ok(options.timeout > 0); extractions++;
      const library = join(args[3], 'screentool', 'libscreentool.dylib');
      const helper = join(args[3], 'screentool', 'helper', 'screenhelper.app', 'Contents', 'MacOS', 'screenhelper');
      await mkdir(dirname(helper), { recursive: true }); await writeFile(library, 'library'); await writeFile(helper, 'signed helper');
    };
    const first = await prepareMacScreenshot({ archivePath, cacheRoot, extract });
    assert.deepEqual(await prepareMacScreenshot({ archivePath, cacheRoot, extract }), first);
    assert.equal(extractions, 1); assert.equal(await readFile(first.helperPath, 'utf8'), 'signed helper');
    await rm(first.helperPath);
    const repaired = await prepareMacScreenshot({ archivePath, cacheRoot, extract });
    assert.deepEqual(repaired, first); assert.equal(extractions, 2);
    await writeFile(archivePath, 'new signed zip fixture');
    await assert.rejects(prepareMacScreenshot({ archivePath, cacheRoot, extract: async () => { throw new Error('ditto failed'); } }), /ditto failed/);
    assert.equal((await readdir(cacheRoot)).filter(name => name.startsWith('.screentool-')).length, 0);
    const next = await prepareMacScreenshot({ archivePath, cacheRoot, extract });
    assert.notEqual(next.libraryPath, first.libraryPath);
    assert.equal(await readFile(archivePath, 'utf8'), 'new signed zip fixture');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('并发Mac解压复用完整结果，不残留临时目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sonicloud-screenshot-test-'));
  try {
    const archivePath = join(root, 'original.zip'), cacheRoot = join(root, 'cache');
    await writeFile(archivePath, 'zip fixture');
    const extract = async (_file, args) => {
      const library = join(args[3], 'screentool', 'libscreentool.dylib');
      const helper = join(args[3], 'screentool', 'helper', 'screenhelper.app', 'Contents', 'MacOS', 'screenhelper');
      await mkdir(dirname(helper), { recursive: true }); await writeFile(library, 'library'); await writeFile(helper, 'helper');
    };
    const paths = await Promise.all([prepareMacScreenshot({ archivePath, cacheRoot, extract }), prepareMacScreenshot({ archivePath, cacheRoot, extract })]);
    assert.deepEqual(paths[0], paths[1]);
    assert.equal((await readdir(cacheRoot)).filter(name => name.startsWith('.screentool-')).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker退出等待在途FFI和helper断连，销毁屏障后才注销回调', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sonicloud-screenshot-worker-'));
  let service;
  try {
    const tracePath = join(root, 'trace.jsonl'), fakePath = join(root, 'koffi.mjs');
    await writeFile(fakePath, `
      import { appendFileSync } from 'node:fs';
      const trace = event => appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(event) + '\\n');
      let eventCallback, inCallback = false;
      const emit = event => { inCallback = true; eventCallback(null, JSON.stringify(typeof event === 'string' ? { type: event } : event), null, 0); inCallback = false; };
      export default {
        proto: value => value, pointer: value => value,
        register: value => value, unregister: () => trace('unregister'),
        load: () => ({ func(declaration) {
          const name = declaration.match(/sct_[a-z_]+/)[0];
          const fn = () => { throw new Error('FFI must be asynchronous'); };
          fn.async = (...args) => {
            if (inCallback) throw new Error('FFI called inside native callback');
            const callback = args.pop(); trace(name);
            if (name === 'sct_set_event_callback') eventCallback = args[1];
            if (name === 'sct_connect_async') {
              setTimeout(() => { trace('connected'); emit('connected'); }, 5);
              setTimeout(() => { trace('connect_return'); callback(null, 0); }, 80); return;
            }
            if (name === 'sct_query_state') setTimeout(() => emit({ type: 'state_report', perm_screen: true, perm_a11y: true }), 2);
            if (name === 'sct_set_config') {
              const config = JSON.parse(args[1]);
              if (config.ocr_visible !== false || config.trans_enabled !== false) throw new Error('unsupported menus visible');
            }
            if (name === 'sct_shutdown') {
              if (args[1] !== 'close_now') throw new Error('wrong shutdown policy');
              setTimeout(() => { trace('disconnected'); emit('disconnected'); }, 40);
            }
            if (name === 'sct_destroy_wait') { setTimeout(() => { trace('destroy_complete'); callback(null); }, 5); return; }
            setImmediate(() => callback(null, name === 'sct_create' ? 1 : 0));
          };
          return fn;
        } }),
      };
    `);
    const fakeUrl = pathToFileURL(fakePath).href;
    const loader = 'data:text/javascript,' + encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier === 'koffi') return { url: ${JSON.stringify(fakeUrl)}, shortCircuit: true };
        return next(specifier, context);
      }
    `);
    service = new ScreenshotService({ platform: 'win32', arch: 'x64', libraryPath: '/fake.dll', helperPath: '/helper.exe',
      exists: () => true, launch: (file, args, options) => fork(file, args, { ...options, execArgv: ['--experimental-loader', loader] }) });
    const events = []; service.on('event', event => events.push(event.type));
    assert.equal(await service.capture(), true);
    await service.close();
    const trace = (await readFile(tracePath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.includes('connected'));
    assert.ok(trace.indexOf('sct_set_config') < trace.indexOf('sct_start_capture'));
    assert.ok(trace.indexOf('connect_return') < trace.indexOf('sct_shutdown'));
    assert.ok(trace.indexOf('disconnected') < trace.indexOf('sct_destroy_wait'));
    assert.ok(trace.indexOf('destroy_complete') < trace.indexOf('unregister'));
    assert.equal(trace.filter(event => event === 'unregister').length, 2);
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
});
