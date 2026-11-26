import { message as msg } from '../shared/i18n.mjs';
import koffi from 'koffi';
import { dirname } from 'node:path';

const [libraryPath, helperPath] = process.argv.slice(2);
if (process.platform === 'win32') process.env.PATH = dirname(libraryPath) + ';' + (process.env.PATH || '');
const inFlight = new Set();
const call = (fn, ...args) => {
  const pending = new Promise((resolve, reject) => fn.async(...args, (error, value) => error ? reject(error) : resolve(value)));
  inFlight.add(pending);
  pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
  return pending;
};
const callbacks = [];
let api, handle, closing = false, closePromise, connected = false, connection, disconnected, stateRequest;
let capabilities = new Set();
let commands = Promise.resolve(), events = Promise.resolve();
function send(message) {
  if (!process.connected) return;
  try { process.send(message, () => {}); } catch { /* 父进程可能已经退出。 */ }
}
const notice = message => { if (!closing) send({ type: 'notice', message }); };
function finishConnection(error) {
  if (!connection) return;
  clearTimeout(connection.timer);
  const pending = connection; connection = undefined;
  if (error) pending.reject(error); else pending.resolve();
}
function finishState(error, value, request = stateRequest) {
  if (!request || stateRequest !== request) return;
  stateRequest = undefined; clearTimeout(request.timer);
  if (error) request.reject(error); else request.resolve(value);
}
const errorMessage = rc => rc === -3 ? msg('error.busy')
  : rc === -2 ? msg('error.screenshot') : msg('error.screenshot');

// 原生线程回调只保留事件文本并排队；所有 FFI 调用离开回调后异步执行。
function queueEvent(json) {
  const text = String(json || '');
  setImmediate(() => {
    let event; try { event = JSON.parse(text); } catch { notice(msg('error.screenshot')); return; }
    if (event.type === 'disconnected') {
      connected = false; capabilities = new Set();
      finishState(new Error(msg('error.permission')));
      finishConnection(new Error(msg('error.screenshot')));
      disconnected?.();
    }
    if (closing) return;
    events = events.then(async () => {
      if (closing) return;
      if (['connected', 'disconnected', 'hello_ack', 'session_started', 'session_ended', 'pin_opened', 'pin_closed', 'state_report'].includes(event.type)) {
        send({ type: 'event', event });
      }
      if (event.type === 'connected') {
        const rc = await call(api.config, handle, JSON.stringify({ ocr_visible: false, trans_enabled: false }));
        if (rc !== 0) { connected = false; finishConnection(new Error(msg('error.screenshot'))); return; }
        connected = true; finishConnection();
      } else if (event.type === 'hello_ack') {
        capabilities = new Set(Array.isArray(event.capabilities) ? event.capabilities : []);
      } else if (event.type === 'state_report') {
        finishState(undefined, event);
      } else if (event.type === 'disconnected') {
        connected = false;
      } else if (event.type === 'connect_failed') {
        connected = false;
        const message = event.code === 'stale_helper_refused'
          ? msg('error.screenshotBusy') : msg('error.screenshot');
        if (connection) finishConnection(new Error(message)); else notice(message);
      } else if (event.type === 'error' || event.type === 'word_failed') {
        notice(event.code === 'permission_screen_required'
          ? msg('error.screenPermission')
          : ['permission_busy', 'permission_request_busy'].includes(event.code) ? msg('error.screenshotBusy')
            : msg('error.permission'));
      } else if (['word_started', 'word_result', 'ocr_requested'].includes(event.type)) {
        notice(msg('error.screenshotExport'));
      }
    }).catch(() => { connected = false; finishConnection(new Error(msg('error.screenshot'))); notice(msg('error.screenshot')); });
  });
}

async function initialize() {
  const library = koffi.load(libraryPath);
  api = {
    create: library.func('void *sct_create()'),
    destroy: library.func('void sct_destroy_wait(void *h)'),
    setEvent: library.func('int sct_set_event_callback(void *h, void *fn, void *user)'),
    setLog: library.func('int sct_set_log_callback(void *h, void *fn, void *user)'),
    helper: library.func('int sct_set_helper_path(void *h, const char *path)'),
    connect: library.func('int sct_connect_async(void *h, int timeout_ms)'),
    capture: library.func('int sct_start_capture(void *h, const char *trigger)'),
    query: library.func('int sct_query_state(void *h)'),
    config: library.func('int sct_set_config(void *h, const char *json)'),
    shutdown: library.func('int sct_shutdown(void *h, const char *policy)'),
  };
  handle = await call(api.create);
  if (!handle) throw new Error(msg('error.screenshot'));
  const eventProto = koffi.proto('void SonicloudScreenshotEvent(void *user, const char *json, const uint8_t *payload, int len)');
  const logProto = koffi.proto('void SonicloudScreenshotLog(void *user, int level, const char *message)');
  callbacks.push(koffi.register((_user, json) => queueEvent(json), koffi.pointer(eventProto)));
  callbacks.push(koffi.register(() => {}, koffi.pointer(logProto)));
  if (await call(api.setEvent, handle, callbacks[0], null) !== 0 ||
    await call(api.setLog, handle, callbacks[1], null) !== 0 ||
    await call(api.helper, handle, helperPath) !== 0) throw new Error(msg('error.screenshot'));
}

async function ensureConnected() {
  if (closing) throw new Error(msg('error.closed'));
  if (connected) return;
  if (!connection) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    connection = { promise, resolve, reject, timer: setTimeout(() => finishConnection(new Error(msg('error.timeout'))), 6500) };
    call(api.connect, handle, 5000).then(rc => { if (rc !== 0) finishConnection(new Error(errorMessage(rc))); },
      () => finishConnection(new Error(msg('error.screenshot'))));
  }
  return connection.promise;
}

async function queryState() {
  if (closing) throw new Error(msg('error.closed'));
  if (stateRequest) return stateRequest.promise;
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const request = { promise, resolve, reject,
    timer: setTimeout(() => finishState(new Error(msg('error.timeout')), undefined, request), 2500) };
  stateRequest = request;
  call(api.query, handle).then(rc => {
    if (rc !== 0) finishState(new Error(msg('error.permission')), undefined, request);
  }, () => finishState(new Error(msg('error.permission')), undefined, request));
  return promise;
}

function permissionView(state) {
  if (typeof state.perm_screen !== 'boolean' || typeof state.perm_a11y !== 'boolean')
    throw new Error(msg('error.permission'));
  return { supported: true, screenRecording: state.perm_screen, accessibility: state.perm_a11y,
    helperApp: typeof state.helper_app === 'string' ? state.helper_app.slice(0, 4096) : '' };
}
const idle = state => state.capturing === false && state.pins_alive === 0 && state.pin_editing !== true;

async function stopHelper() {
  let timer;
  const stopped = new Promise(resolve => {
    disconnected = () => resolve(true);
    timer = setTimeout(() => resolve(false), 2000);
  });
  try {
    const rc = await call(api.shutdown, handle, 'close_now');
    if (rc !== 0) throw new Error(msg('error.permission'));
    if (!await stopped) throw new Error(msg('error.permission'));
  } finally { clearTimeout(timer); disconnected = undefined; }
}

async function permissions(action) {
  if (!['check', 'screen', 'accessibility', 'refresh'].includes(action)) throw new Error(msg('error.permission'));
  if (process.platform !== 'darwin') return { supported: false, screenRecording: true, accessibility: true, helperApp: '' };
  let state = await queryState();
  let view = permissionView(state);
  if (action === 'refresh' && (!view.screenRecording || !view.accessibility) && idle(state)) {
    await stopHelper(); await ensureConnected();
    state = await queryState(); view = permissionView(state);
  }
  if (action === 'screen' || action === 'accessibility') {
    if (!idle(state)) throw new Error(msg('error.screenshotBusy'));
    if (!capabilities.has('permission_preflight')) throw new Error(msg('error.permission'));
    const rc = await call(api.config, handle, JSON.stringify({ permission_request: action }));
    if (rc !== 0) throw new Error(msg('error.permission'));
    // 系统授权由用户完成；写入请求只代表已受理，不能当作已授权。
  }
  return view;
}

process.on('message', message => {
  if (message?.command === 'close') { void close(); return; }
  if (closing || !['capture', 'permissions'].includes(message?.command)) return;
  commands = commands.then(async () => {
    await initialized;
    await ensureConnected();
    if (closing) throw new Error(msg('error.closed'));
    if (message.command === 'permissions') {
      const value = await permissions(message.action ?? 'check');
      send({ type: 'reply', requestId: message.requestId, ok: true, value });
      return;
    }
    if (process.platform === 'darwin' && !permissionView(await queryState()).screenRecording)
      throw new Error(msg('error.screenPermission'));
    const trigger = typeof message.trigger === 'string' ? message.trigger.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) : 'ui';
    const rc = await call(api.capture, handle, trigger || 'ui');
    if (rc !== 0) throw new Error(errorMessage(rc));
    send({ type: 'reply', requestId: message.requestId, ok: true });
  }).catch(error => { if (!closing) send({ type: 'reply', requestId: message.requestId, ok: false, message: error.message }); });
});
process.on('disconnect', () => { void close(); });
const initialized = initialize();
initialized.then(() => { if (!closing) send({ type: 'ready' }); }).catch(() => {
  send({ type: 'fatal' }); void close();
});

function close() {
  if (closePromise) return closePromise;
  closing = true; connected = false;
  finishConnection(new Error(msg('error.closed')));
  finishState(new Error(msg('error.closed')));
  closePromise = (async () => {
    await initialized.catch(() => {});
    await commands.catch(() => {}); await events.catch(() => {});
    // 包含尚未返回的 connect_async FFI 调用，避免销毁与外部调用并发使用句柄。
    await Promise.allSettled([...inFlight]);
    if (handle) {
      let timer;
      const helperExited = new Promise(resolve => { disconnected = resolve; timer = setTimeout(resolve, 2000); });
      try {
        const rc = await call(api.shutdown, handle, 'close_now');
        // 等待 helper 消费退出帧并断开，立即 destroy 会导致已写的帧被丢弃。
        if (rc === 0) await helperExited;
      } catch { /* 断连时仍继续完成销毁屏障。 */ }
      finally { clearTimeout(timer); disconnected = undefined; }
      await call(api.destroy, handle);
      handle = undefined;
    }
    // destroy_wait 已确认原生线程及在途回调全部退出。
    for (const callback of callbacks) koffi.unregister(callback);
    if (process.connected) process.disconnect();
  })().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
  return closePromise;
}
