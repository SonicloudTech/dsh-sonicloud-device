import koffi from 'koffi';
import { dirname } from 'node:path';
const path = process.argv[2];
if (process.platform === 'win32') process.env.PATH = dirname(path) + ';' + process.env.PATH;
let library, api, shuttingDown = false, queued = 0;
const callbacks = [];
const notify = message => {
  if (!process.connected || shuttingDown) return;
  if (message.type === 'audio' && queued > 100) return;
  queued++;
  process.send(message, () => { queued--; });
};
function bind(name, declaration, callback) {
  const proto = koffi.proto(declaration);
  const pointer = koffi.register(callback, koffi.pointer(proto)); callbacks.push(pointer);
  library.func(`void ${name}(void *callback)`)(pointer);
}
const asyncCall = (fn, ...args) => new Promise((resolve, reject) => fn.async(...args, (error, value) => error ? reject(error) : resolve(value)));
try {
  library = koffi.load(path);
  api = {
    init: library.func('void um_sdk_init(int debug)'), close: library.func('void um_sdk_close(void)'),
    source: library.func('int um_set_audio_source(const char *device_id)'),
    dpi: library.func('int um_set_dpi(const char *device_id, int level)'),
  };
  library.func('void um_enable_crash_report(int enable)')(0);
  library.func('int um_set_audio_output_mode(int mode)')(0);
  library.func('int um_set_device_limit(const char *rule_id, int max_devices)')('', 4);
  bind('um_register_connected', 'void MouseConnected(const char *id, int mode)', (id, mode) => notify({ type: 'connected', id, mode }));
  bind('um_register_disconnected', 'void MouseDisconnected(const char *id, int mode)', (id, mode) => notify({ type: 'disconnected', id, mode }));
  bind('um_register_message', 'void MouseMessage(const char *id, const char *json)', (id, json) => {
    try { notify({ type: 'message', id, message: JSON.parse(json) }); } catch { notify({ type: 'warning', message: '鼠标返回无效设备信息' }); }
  });
  bind('um_register_audio', 'void MouseAudio(const char *id, const void *pcm, int len)', (id, pcm, len) => {
    if (len <= 0 || len > 320000 || len % 2) { notify({ type: 'warning', message: '鼠标音频格式无效' }); return; }
    // The SDK buffer expires as soon as this callback returns.
    const audio = Buffer.from(koffi.decode(pcm, 'uint8_t', len));
    if (queued > 100) { notify({ type: 'overflow', id }); return; }
    notify({ type: 'audio', id, data: audio.toString('base64') });
  });
  process.on('message', async message => {
    if (shuttingDown) return;
    if (message.command === 'close') { await close(); return; }
    try {
      const result = message.command === 'source' ? api.source(message.sn || '')
        : message.command === 'dpi' ? api.dpi(message.sn, message.level) : 0;
      notify({ type: 'reply', requestId: message.requestId, result });
    } catch { notify({ type: 'reply', requestId: message.requestId, result: 0 }); }
  });
  process.on('disconnect', () => { void close(); });
  await asyncCall(api.init, 0);
  notify({ type: 'ready', version: library.func('const char *um_sdk_version(void)')() });
} catch {
  notify({ type: 'fatal', message: '鼠标 SDK 加载失败，请检查系统架构、动态库和运行依赖' });
  process.exitCode = 1; setTimeout(() => process.exit(1), 50);
}
async function close() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (api) await asyncCall(api.close); } finally {
    callbacks.forEach(callback => koffi.unregister(callback));
    process.disconnect?.(); process.exit(0);
  }
}
