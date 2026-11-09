import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { diagnoseUsb } from './diagnostics.mjs';
export class MouseSdk extends EventEmitter {
  constructor(config = {}) { super(); this.config = config; this.pending = new Map(); this.serial = 0; }
  async start() {
    if (this.child) return this.starting;
    const target = `${process.platform}-${process.arch}`;
    const filename = process.platform === 'win32' ? 'uMouseSdk.dll' : 'libuMouseSdk.dylib';
    const path = this.config.libraryPath ?? fileURLToPath(new URL(`../../native/${target}/${filename}`, import.meta.url));
    if (!existsSync(path)) throw new Error(`当前平台 ${target} 缺少鼠标 SDK，请配置匹配的动态库`);
    const child = fork(fileURLToPath(new URL('./native-worker.mjs', import.meta.url)), [path], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
    });
    this.child = child;
    const connected = new Set();
    let diagnosing = false;
    const diagnose = async () => {
      if (diagnosing || connected.size || this.stopping || this.child !== child) return;
      diagnosing = true;
      try {
        const message = await diagnoseUsb(child.pid);
        if (message && !connected.size && !this.stopping && this.child === child) this.emit('event', { type: 'diagnostic', message });
      } catch { /* Diagnosis must never interrupt SDK discovery. */ }
      finally { diagnosing = false; }
    };
    this.starting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('鼠标 SDK 启动超时')); }, 15000);
      child.on('message', message => {
        if (message.type === 'ready') {
          clearTimeout(timer); resolve(message.version);
          if (process.platform === 'darwin') {
            this.diagnosticTimer = setInterval(diagnose, 5000); this.diagnosticTimer.unref(); void diagnose();
          }
        }
        else if (message.type === 'fatal') { clearTimeout(timer); reject(new Error(message.message)); this.emit('fault', message.message); }
        else if (message.type === 'reply') {
          const pending = this.pending.get(message.requestId);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(message.requestId); pending.resolve(message.result); }
        } else {
          if (message.type === 'connected') connected.add(message.id);
          if (message.type === 'disconnected') connected.delete(message.id);
          this.emit('event', message);
        }
      });
      const failed = () => {
        clearInterval(this.diagnosticTimer);
        clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('鼠标 SDK 已停止')); }
        this.pending.clear();
        reject(new Error('鼠标 SDK 未能启动'));
        if (!this.stopping) this.emit('fault', '鼠标 SDK 已停止，请重新启用插件');
      };
      child.once('exit', failed); child.once('error', failed);
    });
    return this.starting;
  }
  command(command, fields = {}) {
    if (!this.child?.connected) return Promise.reject(new Error('鼠标 SDK 未连接'));
    const requestId = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('鼠标指令超时')); }, 3000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.send({ command, requestId, ...fields }, error => {
        if (error) { clearTimeout(timer); this.pending.delete(requestId); reject(new Error('鼠标指令发送失败')); }
      });
    });
  }
  source(sn) { return this.command('source', { sn }); }
  dpi(sn, level) { return this.command('dpi', { sn, level }); }
  async close() {
    this.stopping = true;
    clearInterval(this.diagnosticTimer);
    const child = this.child;
    if (!child) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ command: 'close' }, () => {}); else { clearTimeout(timer); resolve(); }
    });
    this.child = undefined;
  }
}
