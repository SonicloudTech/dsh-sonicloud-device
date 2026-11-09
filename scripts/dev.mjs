import { readFile, mkdir, open, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprint, prepareBuild, pruneGenerations } from './dev/build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = join(root, 'work/dev-plugin');
const once = process.argv.includes('--once');
if (process.argv.slice(2).some(arg => arg !== '--once')) throw new Error('用法：npm run dev [-- --once]');
await mkdir(runtime, { recursive: true });
const lockPath = join(runtime, 'watch.lock');
let lock;
try { lock = await open(lockPath, 'wx'); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const pid = Number(await readFile(lockPath, 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
  if (alive) throw new Error(`开发构建已在运行（PID ${pid}）。请先停止该进程；若锁文件损坏，确认没有开发进程后删除 ${lockPath}`);
  await rm(lockPath); lock = await open(lockPath, 'wx');
}
await lock.writeFile(String(process.pid));
const lifetime = new AbortController();
const stop = () => lifetime.abort();
process.on('SIGINT', stop); process.on('SIGTERM', stop);
let last, revision, previous, acknowledged, waitingSince;
try {
  console.log(`[dev] 构建目录：${resolve(runtime)}`);
  while (!lifetime.signal.aborted) {
    const current = await fingerprint(root);
    if (current !== last) {
      if (!once) {
        await delay(250, undefined, { signal: lifetime.signal });
        if (current !== await fingerprint(root)) continue;
      }
      last = current;
      let build;
      try {
        build = await prepareBuild(root, runtime);
        if (current !== await fingerprint(root)) { await build.discard(); last = undefined; continue; }
        if (lifetime.signal.aborted) { await build.discard(); break; }
        await build.publish();
        previous = revision; revision = build.revision; waitingSince = Date.now();
        console.log(`[dev] 构建成功 ${revision}，等待 Harness 重载。`);
      } catch (error) {
        await build?.discard();
        console.error('[dev] 构建失败，保留上一版运行代码：', error.message);
        if (once) process.exitCode = 1;
      }
      if (once) break;
    }
    try {
      const applied = JSON.parse(await readFile(join(runtime, 'applied.json'), 'utf8'));
      if (applied.revision === revision && acknowledged !== revision) {
        acknowledged = revision;
        console.log(`[dev] 后端已重载，前端更新已通知（Host PID ${applied.pid}）。`);
        await pruneGenerations(runtime, revision, previous);
      }
    } catch (error) { if (!['ENOENT', 'SyntaxError'].includes(error.code ?? error.name)) throw error; }
    if (waitingSince && Date.now() - waitingSince > 10000 && acknowledged !== revision) {
      console.log('[dev] 尚未收到重载确认。首次使用请退出 Harness，运行 npm run dev:setup，再启动 Harness；已安装时检查插件是否启用及宿主日志。');
      waitingSince = undefined;
    }
    await delay(300, undefined, { signal: lifetime.signal });
  }
} catch (error) { if (error.name !== 'AbortError') throw error; }
finally {
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  await lock.close(); await rm(lockPath, { force: true });
  console.log('[dev] 监听已停止，Harness 保留最后一次成功构建。');
}
