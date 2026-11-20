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
const errorMessage = rc => rc === -3 ? '截图正在进行，请先完成或取消当前截图'
  : rc === -2 ? '截图进程未连接，请重试' : '截图调用失败，请重试';

// 原生线程回调只保留事件文本并排队；所有 FFI 调用离开回调后异步执行。
function queueEvent(json) {
  const text = String(json || '');
  setImmediate(() => {
    let event; try { event = JSON.parse(text); } catch { notice('截图组件返回无效事件，请重试'); return; }
    if (event.type === 'disconnected') {
      connected = false; capabilities = new Set();
      finishState(new Error('截图进程已断开，请重新检查权限'));
      finishConnection(new Error('截图进程已断开，请重试'));
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
        if (rc !== 0) { connected = false; finishConnection(new Error('截图配置失败，请重试')); return; }
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
          ? '截图进程被其他程序占用，请关闭其他截图程序后重试' : '截图进程连接失败，请重试';
        if (connection) finishConnection(new Error(message)); else notice(message);
      } else if (event.type === 'error' || event.type === 'word_failed') {
        notice(event.code === 'permission_screen_required'
          ? '请先在“声云设备”中为 screenhelper 授权屏幕录制，再重新检查权限'
          : ['permission_busy', 'permission_request_busy'].includes(event.code) ? '请先完成当前截图或关闭贴图，再设置截图权限'
            : '截图操作失败，请检查系统权限后重试');
      } else if (['word_started', 'word_result', 'ocr_requested'].includes(event.type)) {
        notice('当前插件尚未接入截图文字识别和 Word 导出，请使用复制、保存或贴图');
      }
    }).catch(() => { connected = false; finishConnection(new Error('截图组件通信失败，请重试')); notice('截图组件通信失败，请重试'); });
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
  if (!handle) throw new Error('截图句柄创建失败');
  const eventProto = koffi.proto('void SonicloudScreenshotEvent(void *user, const char *json, const uint8_t *payload, int len)');
  const logProto = koffi.proto('void SonicloudScreenshotLog(void *user, int level, const char *message)');
  callbacks.push(koffi.register((_user, json) => queueEvent(json), koffi.pointer(eventProto)));
  callbacks.push(koffi.register(() => {}, koffi.pointer(logProto)));
  if (await call(api.setEvent, handle, callbacks[0], null) !== 0 ||
    await call(api.setLog, handle, callbacks[1], null) !== 0 ||
    await call(api.helper, handle, helperPath) !== 0) throw new Error('截图组件初始化失败');
}

async function ensureConnected() {
  if (closing) throw new Error('截图服务已关闭');
  if (connected) return;
  if (!connection) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    connection = { promise, resolve, reject, timer: setTimeout(() => finishConnection(new Error('截图进程连接超时，请重试')), 6500) };
    call(api.connect, handle, 5000).then(rc => { if (rc !== 0) finishConnection(new Error(errorMessage(rc))); },
      () => finishConnection(new Error('截图进程连接失败，请重试')));
  }
  return connection.promise;
}

async function queryState() {
  if (closing) throw new Error('截图服务已关闭');
  if (stateRequest) return stateRequest.promise;
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const request = { promise, resolve, reject,
    timer: setTimeout(() => finishState(new Error('截图权限检查超时，请先完成系统授权窗口后重试'), undefined, request), 2500) };
  stateRequest = request;
  call(api.query, handle).then(rc => {
    if (rc !== 0) finishState(new Error('截图权限检查失败，请重试'), undefined, request);
  }, () => finishState(new Error('截图权限检查失败，请重试'), undefined, request));
  return promise;
}

function permissionView(state) {
  if (typeof state.perm_screen !== 'boolean' || typeof state.perm_a11y !== 'boolean')
    throw new Error('截图组件未返回 macOS 权限状态，请更新插件');
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
    if (rc !== 0) throw new Error('截图进程未能退出，请稍后重新检查权限');
    if (!await stopped) throw new Error('截图进程正在退出，请稍后重新检查权限');
  } finally { clearTimeout(timer); disconnected = undefined; }
}

async function permissions(action) {
  if (!['check', 'screen', 'accessibility', 'refresh'].includes(action)) throw new Error('不支持的截图权限操作');
  if (process.platform !== 'darwin') return { supported: false, screenRecording: true, accessibility: true, helperApp: '' };
  let state = await queryState();
  let view = permissionView(state);
  if (action === 'refresh' && (!view.screenRecording || !view.accessibility) && idle(state)) {
    await stopHelper(); await ensureConnected();
    state = await queryState(); view = permissionView(state);
  }
  if (action === 'screen' || action === 'accessibility') {
    if (!idle(state)) throw new Error('请先完成当前截图或关闭贴图，再设置截图权限');
    if (!capabilities.has('permission_preflight')) throw new Error('截图组件尚不支持授权引导，请重新启用或更新插件');
    const rc = await call(api.config, handle, JSON.stringify({ permission_request: action }));
    if (rc !== 0) throw new Error('截图授权请求未能发送，请重试');
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
    if (closing) throw new Error('截图服务已关闭');
    if (message.command === 'permissions') {
      const value = await permissions(message.action ?? 'check');
      send({ type: 'reply', requestId: message.requestId, ok: true, value });
      return;
    }
    if (process.platform === 'darwin' && !permissionView(await queryState()).screenRecording)
      throw new Error('请先在“声云设备”中为 screenhelper 授权屏幕录制，再重新检查权限');
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
  finishConnection(new Error('截图服务已关闭'));
  finishState(new Error('截图服务已关闭'));
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
