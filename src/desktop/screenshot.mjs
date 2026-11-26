import { message as msg } from '../shared/i18n.mjs';
import { EventEmitter } from 'node:events';
import { fork, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const nativeRoot = fileURLToPath(new URL('../../native/screenshot/', import.meta.url));
const macPaths = directory => ({
  libraryPath: join(directory, 'screentool', 'libscreentool.dylib'),
  helperPath: join(directory, 'screentool', 'helper', 'screenhelper.app', 'Contents', 'MacOS', 'screenhelper'),
});
const complete = paths => existsSync(paths.libraryPath) && existsSync(paths.helperPath);

// ditto 在 macOS 上还原软链接、执行权限及原始签名；缓存不修改随包 app。
export async function prepareMacScreenshot({
  archivePath = join(nativeRoot, 'darwin-arm64', 'screentool-macos-1.2.2.zip'),
  cacheRoot = join(homedir(), 'Library', 'Caches', 'sonicloud-device'),
  extract = execute,
} = {}) {
  const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  const directory = join(cacheRoot, `screentool-${digest}`);
  const paths = macPaths(directory);
  if (complete(paths)) return paths;
  await mkdir(cacheRoot, { recursive: true });
  const lock = `${directory}.lock`;
  const deadline = Date.now() + 35000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (complete(paths)) return paths;
      // ditto 最多运行 30 秒；清理崩溃后留下的过期准备锁。
      try { if (Date.now() - (await stat(lock)).mtimeMs > 60000) { await rm(lock, { recursive: true, force: true }); continue; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() > deadline) throw new Error(msg('error.screenshot'));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  let temporary;
  try {
    if (complete(paths)) return paths;
    // 仅清理当前压缩包哈希对应的受控缓存目录，不触碰其他版本或原始 app。
    await rm(directory, { recursive: true, force: true });
    temporary = await mkdtemp(join(cacheRoot, '.screentool-'));
    await extract('/usr/bin/ditto', ['-x', '-k', archivePath, temporary], { timeout: 30000, maxBuffer: 8192 });
    if (!complete(macPaths(temporary))) throw new Error(msg('error.screenshot'));
    // 另一进程可能已完成相同版本；只清理本次创建的临时目录。
    if (!complete(paths)) {
      try { await rename(temporary, directory); }
      catch (error) { if (!complete(paths)) throw error; }
    }
    return paths;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export class ScreenshotService extends EventEmitter {
  constructor({ platform = process.platform, arch = process.arch, launch = fork,
    timeoutMs = 9000, startTimeoutMs = 10000, closeTimeoutMs = 5000,
    libraryPath, helperPath, prepareMac = prepareMacScreenshot, exists = existsSync } = {}) {
    super();
    Object.assign(this, { platform, arch, launch, timeoutMs, startTimeoutMs, closeTimeoutMs,
      libraryPath, helperPath, prepareMac, exists });
    this.pending = new Map(); this.sequence = 0;
  }

  start() {
    if (this.closed) return Promise.reject(new Error(msg('error.closed')));
    if (this.starting) return this.starting;
    const attempt = this.startWorker().catch(error => { if (this.starting === attempt) this.starting = undefined; throw error; });
    this.starting = attempt;
    return this.starting;
  }

  async startWorker() {
    const target = `${this.platform}-${this.arch}`;
    if (!['win32-x64', 'darwin-arm64'].includes(target)) throw new Error(msg('error.screenshot'));
    let paths = { libraryPath: this.libraryPath, helperPath: this.helperPath };
    if (!paths.libraryPath || !paths.helperPath) {
      try {
        const defaults = this.platform === 'darwin' ? await this.prepareMac() : {
          libraryPath: join(nativeRoot, target, 'screentool.dll'),
          helperPath: join(nativeRoot, target, 'screenhelper.exe'),
        };
        paths = { libraryPath: paths.libraryPath ?? defaults.libraryPath, helperPath: paths.helperPath ?? defaults.helperPath };
      } catch { throw new Error(msg('error.permission')); }
    }
    if (this.closed) throw new Error(msg('error.closed'));
    if (!this.exists(paths.libraryPath) || !this.exists(paths.helperPath)) throw new Error(msg('error.screenshot'));
    let child;
    try {
      child = this.launch(fileURLToPath(new URL('./screenshot-worker.mjs', import.meta.url)),
        [paths.libraryPath, paths.helperPath], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], windowsHide: true });
    } catch { throw new Error(msg('error.screenshot')); }
    this.child = child;
    return new Promise((resolve, reject) => {
      let ready = false, failed = false;
      const timer = setTimeout(() => { fail(msg('error.timeout')); child.kill(); }, this.startTimeoutMs);
      const fail = message => {
        if (failed) return;
        failed = true; clearTimeout(timer);
        if (this.child !== child) return;
        this.child = undefined; this.starting = undefined;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
        this.pending.clear(); reject(new Error(message));
        if (ready && !this.closed) this.emit('notice', message);
      };
      child.on('message', message => {
        if (this.child !== child || !message || typeof message !== 'object') return;
        if (message.type === 'ready') { clearTimeout(timer); ready = true; resolve(); }
        else if (message.type === 'fatal') { fail(msg('error.screenshot')); child.kill(); }
        else if (message.type === 'notice') { if (!this.closed && typeof message.message === 'string') this.emit('notice', message.message); }
        else if (message.type === 'event') { if (!this.closed && message.event && typeof message.event.type === 'string') this.emit('event', message.event); }
        else if (message.type === 'reply') {
          const pending = this.pending.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(message.requestId);
          if (message.ok) pending.resolve(message.value ?? true);
          else pending.reject(new Error(message.message || msg('error.screenshot')));
        }
      });
      child.once('exit', () => fail(this.closed ? msg('error.closed') : msg('error.screenshot')));
      child.once('error', () => { fail(msg('error.screenshot')); child.kill(); });
      child.once('disconnect', () => { fail(this.closed ? msg('error.closed') : msg('error.screenshot')); if (!this.closed) child.kill(); });
      this.rejectStarting = () => { clearTimeout(timer); reject(new Error(msg('error.closed'))); };
    });
  }

  capture(trigger = 'ui') { return this.command('capture', { trigger }); }

  async permissions(action = 'check') {
    if (!['check', 'screen', 'accessibility', 'refresh'].includes(action)) throw new Error(msg('error.permission'));
    if (this.closed) throw new Error(msg('error.closed'));
    if (this.platform !== 'darwin') return { supported: false, screenRecording: true, accessibility: true, helperApp: '' };
    const state = await this.command('permissions', { action }, Math.max(this.timeoutMs, 20000));
    if (!state || typeof state !== 'object' || state.supported !== true || typeof state.screenRecording !== 'boolean'
      || typeof state.accessibility !== 'boolean' || typeof state.helperApp !== 'string') throw new Error(msg('error.permission'));
    return state;
  }

  async command(command, fields = {}, timeoutMs = this.timeoutMs) {
    await this.start();
    if (this.closed) throw new Error(msg('error.closed'));
    const child = this.child;
    if (!child?.connected) throw new Error(msg('error.screenshot'));
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId); reject(new Error(msg('error.timeout'))); child.kill();
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        child.send({ command, ...fields, requestId }, error => {
          if (!error) return;
          const pending = this.pending.get(requestId);
          if (pending) { clearTimeout(timer); this.pending.delete(requestId); reject(new Error(msg('error.screenshot'))); child.kill(); }
        });
      } catch { clearTimeout(timer); this.pending.delete(requestId); reject(new Error(msg('error.screenshot'))); child.kill(); }
    });
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true; this.rejectStarting?.();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(msg('error.closed'))); }
    this.pending.clear();
    const child = this.child;
    this.closing = child ? new Promise(resolve => {
      let timer;
      const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
      timer = setTimeout(() => { child.kill(); done(); }, this.closeTimeoutMs);
      child.once('exit', done);
      try { if (child.connected) child.send({ command: 'close' }, error => { if (error) { child.kill(); done(); } }); else { child.kill(); done(); } }
      catch { child.kill(); done(); }
    }) : Promise.resolve();
    return this.closing;
  }
}
