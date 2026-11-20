import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ScreenshotService } from '../src/desktop/screenshot.mjs';

const initialState = { type: 'state_report', perm_screen: false, perm_a11y: false,
  helper_app: '/cache/screenhelper.app', capturing: false, pins_alive: 0, pin_editing: false };

async function fixture(t, state = {}, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sonicloud-permissions-'));
  const tracePath = join(directory, 'trace.jsonl'), statePath = join(directory, 'state.json');
  const fakePath = join(directory, 'koffi.mjs');
  const update = async patch => writeFile(statePath, JSON.stringify({ ...initialState, ...state, ...patch }));
  await update({});
  await writeFile(fakePath, `
    import { appendFileSync, readFileSync } from 'node:fs';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const trace = value => appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(value)+'\\n');
    const settings = ${JSON.stringify(settings)};
    let eventCallback, connections = 0;
    const emit = event => eventCallback(null, JSON.stringify(event), null, 0);
    export default {
      proto: value => value, pointer: value => value, register: value => value,
      unregister: () => trace({ name: 'unregister' }),
      load: () => ({ func(declaration) {
        const name = declaration.match(/sct_[a-z_]+/)[0];
        const fn = () => { throw new Error('FFI must be asynchronous'); };
        fn.async = (...args) => {
          const callback = args.pop();
          trace({ name, config: name === 'sct_set_config' ? JSON.parse(args[1]) : undefined });
          if (name === 'sct_set_event_callback') eventCallback = args[1];
          if (name === 'sct_connect_async') {
            connections++;
            setTimeout(() => {
              emit({ type: 'connected' });
              emit({ type: 'hello_ack', capabilities: settings.oldHelper ? [] : ['permission_preflight'] });
            }, 2);
          }
          if (name === 'sct_query_state') {
            const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
            if (!state.silent) setTimeout(() => {
              if (settings.grantOnRestart && connections > 1) state.perm_screen = state.perm_a11y = true;
              emit(state);
            }, 2);
          }
          if (name === 'sct_shutdown') setTimeout(() => emit({ type: 'disconnected' }), 2);
          setImmediate(() => callback(null, name === 'sct_create' ? 1 : 0));
        };
        return fn;
      } }),
    };
  `);
  const loader = 'data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'koffi') return { url: ${JSON.stringify(pathToFileURL(fakePath).href)}, shortCircuit: true };
      return next(specifier, context);
    }
  `);
  const service = new ScreenshotService({ platform: 'darwin', arch: 'arm64', libraryPath: '/fake.dylib', helperPath: '/cache/screenhelper.app/Contents/MacOS/screenhelper',
    exists: () => true, launch: (file, args, options) => fork(file, args, { ...options, execArgv: ['--experimental-loader', loader] }) });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const trace = async () => { try { return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { service, update, trace };
}

test('Windows 权限查询和授权操作不启动截图进程', async () => {
  const service = new ScreenshotService({ platform: 'win32', launch: () => assert.fail('不应启动 worker') });
  for (const action of ['check', 'screen', 'accessibility', 'refresh'])
    assert.deepEqual(await service.permissions(action), { supported: false, screenRecording: true, accessibility: true, helperApp: '' });
  await assert.rejects(service.permissions('unknown'), /不支持/);
  await service.close();
  await assert.rejects(service.permissions(), /已关闭/);
});

test('Mac 首次只查权限，缺屏幕录制权限不发截图命令，缺辅助功能仍可基本截图', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.permissions(), { supported: true, screenRecording: false, accessibility: false, helperApp: '/cache/screenhelper.app' });
  await assert.rejects(f.service.capture(), /授权屏幕录制/);
  assert.equal((await f.trace()).filter(event => event.name === 'sct_start_capture').length, 0);
  assert.equal((await f.trace()).filter(event => event.config?.permission_request).length, 0);
  await f.update({ perm_screen: true });
  assert.equal(await f.service.capture(), true);
  assert.equal((await f.trace()).filter(event => event.name === 'sct_start_capture').length, 1);
});

test('授权请求返回原状态，已有截图、贴图或编辑时不弹授权', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.permissions('screen')).screenRecording, false);
  assert.equal((await f.service.permissions('accessibility')).accessibility, false);
  assert.deepEqual((await f.trace()).filter(event => event.config?.permission_request).map(event => event.config.permission_request), ['screen', 'accessibility']);
  for (const activity of [{ capturing: true }, { pins_alive: 1 }, { pin_editing: true }]) {
    await f.update(activity);
    await assert.rejects(f.service.permissions('screen'), /完成当前截图或关闭贴图/);
  }
  assert.equal((await f.trace()).filter(event => event.config?.permission_request).length, 2);
});

test('重新检查仅在空闲时重启 helper，并在重连后读取新授权状态', async t => {
  const f = await fixture(t, {}, { grantOnRestart: true });
  const state = await f.service.permissions('refresh');
  assert.equal(state.screenRecording, true); assert.equal(state.accessibility, true);
  const trace = await f.trace();
  assert.equal(trace.filter(event => event.name === 'sct_connect_async').length, 2);
  assert.equal(trace.filter(event => event.name === 'sct_shutdown').length, 1);
  assert.equal(trace.filter(event => event.name === 'sct_query_state').length, 2);
  assert.equal(trace.filter(event => event.name === 'sct_start_capture').length, 0);
});

test('有贴图或截图时重新检查只查询，不关闭窗口；旧组件不假报已请求授权', async t => {
  const f = await fixture(t, { pins_alive: 1 });
  assert.equal((await f.service.permissions('refresh')).screenRecording, false);
  assert.equal((await f.trace()).filter(event => event.name === 'sct_shutdown').length, 0);
  const old = await fixture(t, {}, { oldHelper: true });
  await assert.rejects(old.service.permissions('screen'), /不支持授权引导/);
  assert.equal((await old.trace()).filter(event => event.config?.permission_request).length, 0);
});

test('权限查询超时可重试，关闭时取消在途查询', async t => {
  const f = await fixture(t, { silent: true });
  await assert.rejects(f.service.permissions(), /检查超时/);
  await f.update({ silent: false, perm_screen: true });
  assert.equal((await f.service.permissions()).screenRecording, true);
  await f.update({ silent: true });
  const pending = f.service.permissions();
  const rejected = assert.rejects(pending, /已关闭/);
  for (let i = 0; i < 100; i++) {
    if ((await f.trace()).filter(event => event.name === 'sct_query_state').length >= 3) break;
    await delay(5);
  }
  await f.service.close(); await rejected;
});
