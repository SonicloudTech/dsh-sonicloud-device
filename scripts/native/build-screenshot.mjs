import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const options = { qt: 'C:/Qt/5.15.2/msvc2019_64', cmake: 'cmake' };
for (let i = 0; i < args.length; i++) {
  if (!['--source', '--qt', '--cmake'].includes(args[i]) || !args[i + 1])
    throw new Error('用法：node scripts/native/build-screenshot.mjs --source SDK源码目录 [--qt Qt5目录] [--cmake CMake路径]');
  options[args[i].slice(2)] = args[++i];
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此脚本仅构建 Windows x64；macOS 请运行 scripts/native/build-screenshot-macos.mjs');
if (!options.source) throw new Error('请通过 --source 指定原始 ScreenTool 1.2.2 源码，不修改该目录');
const upstream = resolve(options.source);
const native = join(root, 'native/screenshot');
const patch = join(native, 'patches/hide-cloud-actions.patch');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = JSON.parse(await readFile(join(native, 'patches/upstream-files.json'), 'utf8'));
for (const file of sourceFiles) {
  if (sha256(await readFile(join(upstream, file.path))) !== file.sha256)
    throw new Error(`SDK 源码版本不匹配：${file.path}`);
}
await mkdir(join(root, 'work'), { recursive: true });
const work = await mkdtemp(join(root, 'work/screenshot-helper-'));
const source = join(work, 'source'), build = join(work, 'build');
await mkdir(source);
for (const name of ['CMakeLists.txt', 'helper_main.cpp', 'core', 'ipc', 'client', 'host', 'demo', 'res', 'tests', 'translations'])
  await cp(join(upstream, name), join(source, name), { recursive: true });
for (const name of ['include', 'windows/x64'])
  await cp(join(upstream, 'pixpin', name), join(source, 'pixpin', name), { recursive: true });
for (const { path } of sourceFiles) {
  const copied = join(source, path);
  await writeFile(copied, (await readFile(copied, 'utf8')).replaceAll('\r\n', '\n'));
}
const run = (file, parameters, extra = {}) => execFileSync(file, parameters, {
  cwd: root, stdio: 'inherit', windowsHide: true, ...extra,
});
const preparedPatch = join(work, 'hide-cloud-actions.patch');
await writeFile(preparedPatch, (await readFile(patch, 'utf8')).replaceAll('\r\n', '\n'));
const applyArgs = ['apply', '--directory', relative(root, source).replaceAll('\\', '/'), preparedPatch];
run('git', [...applyArgs.slice(0, 1), '--check', ...applyArgs.slice(1)]);
run('git', applyArgs);
run(options.cmake, ['-S', source, '-B', build, '-G', 'Visual Studio 17 2022', '-A', 'x64',
  `-DCMAKE_PREFIX_PATH=${resolve(options.qt)}`, '-DENABLE_PIXPIN=ON', '-DSCREENTOOL_BUILD_TESTS=ON']);
run(options.cmake, ['--build', build, '--config', 'Release', '--target', 'screenhelper', 'test_cloud_actions', 'test_helper_config', '--parallel', '4']);
const output = join(build, 'Release');
const env = { ...process.env, QT_QPA_PLATFORM: 'offscreen', PATH: [join(resolve(options.qt), 'bin'), join(native, 'win32-x64'), output, process.env.PATH].join(';') };
const tests = [];
for (const test of ['test_cloud_actions', 'test_helper_config']) {
  const reportPath = join(work, `${test}.txt`);
  run(join(output, `${test}.exe`), ['-o', `${reportPath},txt`], { env });
  const report = await readFile(reportPath, 'utf8');
  const totals = /Totals:\s+(\d+) passed,\s+(\d+) failed,\s+(\d+) skipped/.exec(report);
  if (!totals || Number(totals[2]) !== 0) throw new Error(`原生测试失败：${reportPath}`);
  tests.push({ name: test, passed: Number(totals[1]), failed: Number(totals[2]), skipped: Number(totals[3]) });
  console.log(`${test}: ${totals[0]}`);
}
const target = join(native, 'win32-x64/screenhelper.exe');
await copyFile(join(output, 'screenhelper.exe'), target);
const manifestPath = join(native, 'SOURCE.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const outputHash = sha256(await readFile(target));
const original = manifest.files.find(file => file.path === 'win32-x64/screenhelper.exe');
manifest.derived = {
  patch: 'patches/hide-cloud-actions.patch', patchSha256: sha256(await readFile(patch)),
  upstreamFiles: 'patches/upstream-files.json',
  upstreamBinarySha256: manifest.derived?.upstreamBinarySha256 ?? original.sha256,
  output: 'win32-x64/screenhelper.exe', outputSha256: outputHash,
  build: 'Windows x64 / Qt 5.15.2 / MSVC 2022 / Release',
  tests,
};
original.sha256 = outputHash;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(work, 'build-receipt.json'), JSON.stringify({ source: upstream, work, derived: manifest.derived }, null, 2) + '\n');
console.log(`已构建并替换 ${relative(root, target)}（${outputHash}）；构建记录：${relative(root, join(work, 'build-receipt.json'))}`);
