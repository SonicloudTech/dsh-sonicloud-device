import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const teamId = 'F3TYM6YPF7';
const options = { qt: join(homedir(), 'Qt/Qt6.2.x/6.2.4/macos'), cmake: 'cmake' };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (!['--source', '--qt', '--cmake', '--sign-identity'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
    throw new Error('用法：node scripts/native/build-screenshot-macos.mjs --source SDK目录 [--qt Qt目录] [--cmake CMake路径] [--sign-identity Developer-ID指纹或名称]');
  options[args[i].slice(2)] = args[++i];
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('此脚本必须在 Apple 芯片 Mac 上运行');
if (!options.source) throw new Error('请通过 --source 指定 ScreenTool 1.2.2 源码目录');
if (options['sign-identity'] === '-') throw new Error('拒绝使用 ad-hoc 签名');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const expand = value => value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
const upstream = resolve(expand(options.source));
const qt = resolve(expand(options.qt));
const native = join(root, 'native/screenshot');
const originalArchive = join(native, 'darwin-arm64/screentool-macos-1.2.2.zip');
const patchPath = join(native, 'patches/hide-cloud-actions.patch');
const permissionPatchPath = join(native, 'patches/mac-permissions.patch');
function run(file, parameters, { capture = false, env = process.env } = {}) {
  const result = spawnSync(file, parameters, { cwd: root, env, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`无法执行 ${file}：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${file} 执行失败（${result.status ?? result.signal}）${capture ? '\n' + [result.stdout, result.stderr].filter(Boolean).join('\n') : ''}`);
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
const output = (file, parameters) => run(file, parameters, { capture: true }).stdout.trim();
const both = (file, parameters) => { const result = run(file, parameters, { capture: true }); return result.stdout + result.stderr; };

const identities = output('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])
  .split('\n').map(line => /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"/.exec(line))
  .filter(Boolean).map(match => ({ sha1: match[1].toUpperCase(), name: match[2] }))
  .filter(identity => identity.name.startsWith('Developer ID Application: ') && identity.name.endsWith(`(${teamId})`));
const requestedIdentity = options['sign-identity'];
const identity = requestedIdentity ? identities.find(item => item.sha1 === requestedIdentity.toUpperCase() || item.name === requestedIdentity) : identities[0];
if (!identity) throw new Error(`钥匙串中没有可用的 ${teamId} Developer ID Application 签名身份；不会降级为 ad-hoc`);
if (output(join(qt, 'bin/qmake'), ['-query', 'QT_VERSION']) !== '6.2.4')
  throw new Error('复用交付包的 Qt 运行时要求使用 Qt 6.2.4 编译');
run('/usr/bin/xcrun', ['--find', 'clang++'], { capture: true });
run(options.cmake, ['--version'], { capture: true });

const expectedFiles = JSON.parse(await readFile(join(native, 'patches/upstream-files.json'), 'utf8'));
const sourceChecks = [];
for (const entry of expectedFiles) {
  const bytes = await readFile(join(upstream, entry.path));
  const actual = sha256(bytes);
  const normalized = new TextDecoder('utf8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
  // Windows 来源记录可能使用 CRLF；只允许换行差异，不接受其他源码漂移。
  if (![actual, sha256(normalized), sha256(normalized.replaceAll('\n', '\r\n'))].includes(entry.sha256))
    throw new Error(`SDK 源码版本不匹配：${entry.path}`);
  sourceChecks.push({ path: entry.path, expectedSha256: entry.sha256, actualSha256: actual });
}

await mkdir(join(root, 'work'), { recursive: true });
const work = await mkdtemp(join(root, 'work/screenshot-macos-'));
const source = join(work, 'source'), build = join(work, 'build'), stage = join(work, 'stage');
await mkdir(source); await mkdir(stage);
console.log(`构建目录：${work}`);
for (const name of ['CMakeLists.txt', 'helper_main.cpp', 'core', 'ipc', 'client', 'host', 'demo', 'res', 'tests', 'translations'])
  await cp(join(upstream, name), join(source, name), { recursive: true });
for (const name of ['include', 'macos'])
  await cp(join(upstream, 'pixpin', name), join(source, 'pixpin', name), { recursive: true });
for (const { path } of expectedFiles) {
  const file = join(source, path);
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'));
}
const appliedPatches = [];
for (const file of [patchPath, permissionPatchPath]) {
  const bytes = await readFile(file);
  const preparedPatch = join(work, basename(file));
  await writeFile(preparedPatch, bytes.toString('utf8').replaceAll('\r\n', '\n'));
  const applyArgs = ['--directory', relative(root, source), preparedPatch];
  run('/usr/bin/git', ['apply', '--check', ...applyArgs]);
  run('/usr/bin/git', ['apply', ...applyArgs]);
  appliedPatches.push({ path: relative(native, file), sha256: sha256(bytes) });
}
run('/usr/bin/ditto', ['-x', '-k', originalArchive, stage]);
const packageRoot = join(stage, 'screentool');
const app = join(packageRoot, 'helper/screenhelper.app');
const helper = join(app, 'Contents/MacOS/screenhelper');
const frameworks = join(app, 'Contents/Frameworks');
const infoPath = join(app, 'Contents/Info.plist');
const client = join(packageRoot, 'libscreentool.1.2.2.dylib');
const originalInfoHash = sha256(await readFile(infoPath));
const originalClientHash = sha256(await readFile(client));
const bundleId = output('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleIdentifier', infoPath]);
if (bundleId !== 'com.clawmouse.screenhelper') throw new Error('原包 Bundle ID 与预期不符');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const previousSignature = both('/usr/bin/codesign', ['-d', '--verbose=4', app]);
if (!previousSignature.includes(`TeamIdentifier=${teamId}`)) throw new Error('原包签名 Team ID 不符');
const previousFlags = /\bflags=0x([0-9a-f]+)/i.exec(previousSignature)?.[1];
if (previousFlags === undefined) throw new Error('无法读取原包签名选项');
const previousRequirement = /designated => (.+)/.exec(both('/usr/bin/codesign', ['-d', '-r-', app]))?.[1];
if (!previousRequirement) throw new Error('无法读取原包签名身份要求');
const entitlementsOutput = run('/usr/bin/codesign', ['-d', '--entitlements', ':-', app], { capture: true }).stdout;
const plistStart = entitlementsOutput.search(/<\?xml|<plist/);
const entitlements = plistStart >= 0 ? entitlementsOutput.slice(plistStart).trim() : '';
if (entitlements && !entitlements.includes('</plist>')) throw new Error('原包 entitlement 格式不完整');
const loadCommands = output('/usr/bin/otool', ['-l', helper]);
const minimumVersion = /cmd LC_BUILD_VERSION[\s\S]*?\bminos\s+([\d.]+)/.exec(loadCommands)?.[1]
  ?? /cmd LC_VERSION_MIN_MACOSX[\s\S]*?\bversion\s+([\d.]+)/.exec(loadCommands)?.[1];
if (!minimumVersion) throw new Error('无法读取原包最低 macOS 版本');

const configure = ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_ARCHITECTURES=arm64',
  `-DCMAKE_OSX_DEPLOYMENT_TARGET=${minimumVersion}`, `-DCMAKE_PREFIX_PATH=${qt}`, '-DENABLE_PIXPIN=ON', '-DSCREENTOOL_BUILD_TESTS=ON'];
if (process.env.SDKROOT) configure.push(`-DCMAKE_OSX_SYSROOT=${process.env.SDKROOT}`);
const agl = join(homedir(), 'Qt/Qt6.2.x/agl-link-stub');
if (existsSync(join(agl, 'AGL.framework'))) {
  // CMake 将此缓存值交给构建 shell，故为单个编译参数使用 POSIX 引号。
  const quoted = "'" + agl.replaceAll("'", "'\\''") + "'";
  configure.push(`-DCMAKE_EXE_LINKER_FLAGS=-F${quoted}`);
}
run(options.cmake, configure);
run(options.cmake, ['--build', build, '--config', 'Release', '--target', 'screenhelper', 'test_cloud_actions', 'test_helper_config', 'test_mac_permissions', '--parallel', '4']);
const tests = [];
const testEnvironment = { ...process.env, QT_QPA_PLATFORM: 'offscreen', PATH: `${join(qt, 'bin')}:${process.env.PATH ?? ''}` };
for (const name of ['test_cloud_actions', 'test_helper_config', 'test_mac_permissions']) {
  const reportPath = join(work, `${name}.txt`);
  run(join(build, name), ['-o', `${reportPath},txt`], { env: testEnvironment });
  const report = await readFile(reportPath, 'utf8');
  const totals = /Totals:\s+(\d+) passed,\s+(\d+) failed,\s+(\d+) skipped/.exec(report);
  if (!totals || Number(totals[2]) !== 0 || Number(totals[1]) === 0) throw new Error(`原生测试未通过：${reportPath}`);
  tests.push({ name, passed: Number(totals[1]), failed: Number(totals[2]), skipped: Number(totals[3]), report: basename(reportPath) });
  console.log(`${name}: ${totals[0]}`);
}
const builtHelper = join(build, 'screenhelper');
if (output('/usr/bin/lipo', ['-archs', builtHelper]) !== 'arm64') throw new Error('新 helper 必须为 arm64 架构');
const unsignedHelperSha256 = sha256(await readFile(builtHelper));
const machoMagic = new Set(['cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe']);
const machoFiles = [];
await collect(packageRoot);
const vendorBaseline = new Map();
for (const file of machoFiles) {
  if (file === helper) continue;
  vendorBaseline.set(relative(packageRoot, file), { sha256: sha256(await readFile(file)), rpaths: rpaths(file) });
}
await writeFile(join(work, 'vendor-baseline.json'), JSON.stringify(Object.fromEntries(vendorBaseline), null, 2) + '\n');
await copyFile(builtHelper, helper); await chmod(helper, 0o755);

function rpaths(file) {
  return [...output('/usr/bin/otool', ['-l', file]).matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)].map(match => match[1]);
}
function dependencies(file) {
  return output('/usr/bin/otool', ['-L', file]).split('\n')
    .map(line => /^\s+(.+?)\s+\(compatibility version /.exec(line)?.[1]).filter(Boolean);
}
const systemDependency = value => value.startsWith('/System/Library/') || value.startsWith('/usr/lib/');
for (const dependency of new Set(dependencies(helper))) {
  if (!isAbsolute(dependency) || systemDependency(dependency)) continue;
  const frameworkPath = /(?:^|\/)(Qt[^/]+\.framework\/.+)$/.exec(dependency)?.[1];
  const suffix = frameworkPath ?? (basename(dependency) === 'libPixPinScrollCapture.dylib' ? basename(dependency) : undefined);
  if (!suffix || !existsSync(join(frameworks, suffix))) throw new Error(`新 helper 依赖包外组件：${dependency}`);
  run('/usr/bin/install_name_tool', ['-change', dependency, `@rpath/${suffix}`, helper]);
}
for (const path of rpaths(helper)) if (isAbsolute(path)) run('/usr/bin/install_name_tool', ['-delete_rpath', path, helper]);
if (!rpaths(helper).includes('@executable_path/../Frameworks'))
  run('/usr/bin/install_name_tool', ['-add_rpath', '@executable_path/../Frameworks', helper]);

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await collect(path); continue; }
    if (!entry.isFile()) continue;
    const file = await open(path, 'r');
    try { const magic = Buffer.alloc(4); await file.read(magic, 0, 4, 0); if (machoMagic.has(magic.toString('hex'))) machoFiles.push(path); }
    finally { await file.close(); }
  }
}
const dependencyAudit = [];
const preservedVendorRpaths = [];
for (const file of machoFiles) {
  const loads = dependencies(file), paths = rpaths(file);
  const vendor = vendorBaseline.get(relative(packageRoot, file));
  const currentSha256 = vendor ? sha256(await readFile(file)) : undefined;
  let ownIds = [];
  if (file.endsWith('.dylib') || file.includes('.framework/'))
    ownIds = output('/usr/bin/otool', ['-D', file]).split('\n').map(line => line.trim()).filter(line => line && !line.endsWith(':'));
  for (const path of new Set(paths)) {
    if (!isAbsolute(path) || systemDependency(path)) continue;
    if (!vendor || vendor.sha256 !== currentSha256 || !vendor.rpaths.includes(path))
      throw new Error(`包内存在未获基线确认的开发机 rpath：${relative(packageRoot, file)} -> ${path}`);
    // 原供应商框架保持原字节与签名；仅保留已核实的原始备用路径。
    // 下方仍独立要求所有实际加载依赖使用系统库或可在包内解析的路径。
    preservedVendorRpaths.push({ path: relative(packageRoot, file), rpath: path,
      baselineSha256: vendor.sha256, currentSha256, baselineRpaths: vendor.rpaths,
      reason: '原包既有的开发机构建备用路径；文件未修改，不依赖该路径解析包内组件' });
  }
  for (const dependency of loads) {
    if (ownIds.includes(dependency) || systemDependency(dependency)) continue;
    if (isAbsolute(dependency)) throw new Error(`包内存在开发机绝对依赖：${relative(packageRoot, file)} -> ${dependency}`);
    const candidate = dependency.startsWith('@rpath/') ? join(frameworks, dependency.slice(7))
      : dependency.startsWith('@executable_path/') ? resolve(dirname(helper), dependency.slice(17))
        : dependency.startsWith('@loader_path/') ? resolve(dirname(file), dependency.slice(13)) : undefined;
    if (!candidate || relative(packageRoot, candidate).startsWith('..') || !existsSync(candidate))
      throw new Error(`包内依赖无法解析：${relative(packageRoot, file)} -> ${dependency}`);
  }
  dependencyAudit.push({ path: relative(packageRoot, file), dependencies: loads, rpaths: paths });
}

const signingArguments = ['--force', '--timestamp=none', '--sign', identity.sha1, '--identifier', bundleId];
if (Number.parseInt(previousFlags, 16) !== 0) signingArguments.push('--options', `0x${previousFlags}`);
if (entitlements) {
  const file = join(work, 'original-entitlements.plist'); await writeFile(file, entitlements + '\n');
  signingArguments.push('--entitlements', file);
}
run('/usr/bin/codesign', [...signingArguments, app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const signature = both('/usr/bin/codesign', ['-d', '--verbose=4', app]);
const newFlags = /\bflags=0x([0-9a-f]+)/i.exec(signature)?.[1];
if (!signature.includes(`TeamIdentifier=${teamId}`) || Number.parseInt(newFlags, 16) !== Number.parseInt(previousFlags, 16))
  throw new Error('新签名的 Team ID 或签名选项与原包不一致');
const requirement = /designated => (.+)/.exec(both('/usr/bin/codesign', ['-d', '-r-', app]))?.[1];
if (requirement !== previousRequirement) throw new Error('新包签名身份要求与原包不同，停止交付以免影响既有授权');
if (sha256(await readFile(infoPath)) !== originalInfoHash || sha256(await readFile(client)) !== originalClientHash)
  throw new Error('原 Info.plist 或客户端库意外改变');
const helperSha256 = sha256(await readFile(helper));
const archivePath = join(work, 'screentool-macos-1.2.2.zip');
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', packageRoot, archivePath]);
const roundtrip = join(work, 'verify'); await mkdir(roundtrip);
run('/usr/bin/ditto', ['-x', '-k', archivePath, roundtrip]);
const unpackedRoot = join(roundtrip, 'screentool');
const unpackedApp = join(unpackedRoot, 'helper/screenhelper.app');
const unpackedHelper = join(unpackedApp, 'Contents/MacOS/screenhelper');
if (sha256(await readFile(unpackedHelper)) !== helperSha256 || !(await stat(unpackedHelper)).mode.toString(8).endsWith('755'))
  throw new Error('归档往返后 helper 内容或执行权限不一致');
for (const path of ['libscreentool.dylib', 'libscreentool.1.dylib', 'helper/screenhelper.app/Contents/Frameworks/QtCore.framework/Versions/Current'])
  if (!(await lstat(join(unpackedRoot, path))).isSymbolicLink()) throw new Error(`归档未保留软链接：${path}`);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', unpackedApp]);

const receipt = {
  platform: 'darwin-arm64', version: '1.2.2', source: upstream, sourceChecks,
  originalArchiveSha256: sha256(await readFile(originalArchive)), patch: 'native/screenshot/patches/hide-cloud-actions.patch',
  patchSha256: sha256(await readFile(patchPath)), appliedPatches, archivePath, archiveSha256: sha256(await readFile(archivePath)),
  unsignedHelperSha256, helperSha256, preservedClientSha256: originalClientHash,
  bundleId, teamId, signingIdentity: identity, signingFlags: `0x${newFlags}`,
  entitlementsSha256: entitlements ? sha256(entitlements) : null, designatedRequirement: requirement,
  sameDesignatedRequirement: true, codesignVerified: true, archiveCodesignVerified: true,
  notarizationPerformed: false, deploymentTarget: minimumVersion, qtVersion: '6.2.4', tests, dependencyAudit,
  vendorBaselineReport: 'vendor-baseline.json', preservedVendorRpaths,
};
await writeFile(join(work, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`已构建并验证 ${archivePath}`);
console.log(`SHA-256：${receipt.archiveSha256}`);
console.log(`构建回执：${join(work, 'build-receipt.json')}`);
