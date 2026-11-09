import { access, readFile, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let profile = 'desktop', cli = process.env.DSH_CLI;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (!['--profile', '--dsh'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
    throw new Error('用法：npm run dev:setup -- [--profile desktop] [--dsh CLI路径]');
  }
  if (args[i] === '--profile') profile = args[++i]; else cli = args[++i];
}
if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('profile 只能包含字母、数字、下划线和连字符');
if (!cli && process.platform === 'darwin') {
  const installed = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
  try { await access(installed); cli = installed; } catch { /* Try PATH. */ }
}
cli ??= process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
function run(command, args) {
  // Windows .cmd launchers need cmd.exe; reject expansion/metacharacters before quoting.
  if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
    const quote = value => {
      if (/[%!\r\n"&<>|^]/.test(value)) throw new Error('Windows CLI 参数含不支持的 shell 字符');
      return `"${value}"`;
    };
    const line = [command, ...args].map(quote).join(' ');
    command = process.env.ComSpec || 'cmd.exe'; args = ['/d', '/s', '/c', `"${line}"`];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`命令退出码：${code}`)));
  });
}
const profileDir = join(resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')), 'profiles', profile);
try {
  await stat(join(profileDir, 'lock'));
  throw new Error(`请先退出使用 ${profile} profile 的 Harness，再运行 dev:setup（检测到 profile 锁）。不要删除正在使用的锁。`);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const runtime = join(root, 'work/dev-plugin');
let watching = false;
try {
  const pid = Number(await readFile(join(runtime, 'watch.lock'), 'utf8'));
  if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); watching = true; }
} catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
if (watching) await access(join(runtime, 'host.mjs'));
else await run(process.execPath, [join(root, 'scripts/dev.mjs'), '--once']);
console.log(`[dev:setup] 将 ${profile} 的 dsh-sonicloud-device 切换为本地开发链接。`);
await run(cli, ['plugin', '--profile', profile, 'add', `link:${runtime}`]);
const linked = await realpath(join(profileDir, 'node_modules/dsh-sonicloud-device'));
if (linked !== await realpath(runtime)) throw new Error('CLI 未安装预期的本地链接，请检查 profile 中的 dsh-sonicloud-device');
console.log('[dev:setup] 开发链接已安装。运行 npm run dev 并启动 Harness；保持监听进程运行即可自动更新。');
