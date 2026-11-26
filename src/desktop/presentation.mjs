import { message as msg, nativeDictionary, resolveLocale, safeMessage } from '../shared/i18n.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync } from 'node:fs';

// Private stdio IPC: transcripts never appear in process arguments, files, or logs.
export class DesktopPresentation {
  constructor({ platform = process.platform, arch = process.arch, launch = spawn, timeoutMs = 10000 } = {}) {
    Object.assign(this, { platform, arch, launch, timeoutMs });
    this.requests = new Map(); this.sequence = 0; this.locale = 'en';
  }
  start() {
    if (this.closed) throw new Error(msg('error.closed'));
    if (this.child) return;
    const root = new URL('../../native/desktop/', import.meta.url);
    let file, args = [];
    if (this.platform === 'darwin') {
      file = fileURLToPath(new URL(`darwin-${this.arch}/Sonicloud Voice.app/Contents/MacOS/sonicloud-voice`, root));
      // Windows 生成的 npm 包不保留 Unix 执行位，启动前恢复随包程序权限。
      if (existsSync(file)) chmodSync(file, 0o755);
    }
    else if (this.platform === 'win32') {
      file = 'powershell.exe'; args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('windows.ps1', root))];
    } else throw new Error(msg('error.panel'));
    const child = this.launch(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (this.child !== child || line.length > 300000) return;
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.event === 'cancel' && message.sessionId === this.sessionId) this.onCancel?.(message.sessionId);
      const pending = this.requests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer); this.requests.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.message || msg('error.panel')));
      }
    });
    const failed = () => {
      if (this.child !== child) return;
      this.child = undefined; lines.close();
      for (const { reject, timer } of this.requests.values()) { clearTimeout(timer); reject(new Error(msg('error.panel'))); }
      this.requests.clear();
      if (!this.closed) this.onFault?.();
    };
    child.once('error', failed); child.once('exit', failed);
    child.stdin.on('error', failed);
    child.stderr.resume();
    this.setLocale(this.locale);
  }
  setLocale(locale) {
    this.locale = resolveLocale(locale);
    this.send({ command: 'locale', language: this.locale, dictionary: nativeDictionary(this.locale) });
  }
  send(message) {
    if (!this.child || this.closed) return;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(message, { killOnTimeout = true } = {}) {
    this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id); reject(new Error(msg('error.timeout')));
        if (killOnTimeout) this.child?.kill();
      }, this.timeoutMs);
      this.requests.set(id, { resolve, reject, timer }); this.send({ ...message, id });
    });
  }
  async begin(run) {
    this.sessionId = run.id;
    await this.request({ command: 'begin', sessionId: run.id, action: run.action });
  }
  async permissions(action = 'check') {
    if (!['check', 'accessibility', 'refresh'].includes(action)) throw new Error(msg('error.permission'));
    if (this.closed) throw new Error(msg('error.closed'));
    if (this.platform !== 'darwin') return { supported: false, accessibility: true, helperApp: '' };
    const value = await this.request({ command: 'permissions', action }, { killOnTimeout: false });
    if (!value || value.supported !== true || typeof value.accessibility !== 'boolean' || typeof value.helperApp !== 'string')
      throw new Error(msg('error.permission'));
    return value;
  }
  event(event) {
    if (event.type === 'devices' || event.type === 'request' || event.type === 'result') return;
    if (event.sessionId && event.sessionId !== this.sessionId) return;
    // Do not launch a native window for background device discovery messages.
    if (!this.child) return;
    this.send({ command: 'event', ...event, ...(event.message ? { message: safeMessage(event.message) } : {}) });
  }
  async complete(run, text) {
    return this.request({ command: 'result', sessionId: run.id, text });
  }
  async close() {
    this.closed = true;
    for (const { reject, timer } of this.requests.values()) { clearTimeout(timer); reject(new Error(msg('error.closed'))); }
    this.requests.clear();
    const child = this.child; this.child = undefined;
    if (child) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
      const timer = setTimeout(() => { child.kill(); done(); }, 1000);
      child.once('exit', done);
      // EOF lets the native helper restore a temporary clipboard before it exits.
      child.stdin.end();
    });
  }
}
