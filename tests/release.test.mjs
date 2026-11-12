import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE, REPOSITORY, compareVersions, developmentVersion, escapeHtml, publicationDecision,
  releaseNotes, requiredFiles, validateFileList, validateManifest, validateText } from '../scripts/ci/policy.mjs';
import { awaitPublication, context, inspectTarball, registryMetadata, verifyBundle, verifyRegistry } from '../scripts/ci/release.mjs';

const run = promisify(execFile);
const ctx = { repository: REPOSITORY, sha: 'a'.repeat(40), runId: '123', attempt: '2' };
const record = { ...ctx, name: PACKAGE, version: '0.1.0', integrity: 'sha512-fixture' };
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: ctx.sha,
  GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '123', GITHUB_RUN_NUMBER: '4', GITHUB_RUN_ATTEMPT: '2' };
const metadata = (version = '0.1.0', integrity = record.integrity) => ({ name: PACKAGE,
  versions: { [version]: { name: PACKAGE, version, dist: { integrity } } }, 'dist-tags': { latest: version } });
const logs = (zhBody = '- 中文变更', enBody = '- English change') => [
  `# 更新日志\n\n## 未发布\n\n### 新增\n${zhBody}\n\n## 0.1.0 - 2026-11-09\n\n### 修复\n- 中文修复\n`,
  `# Changelog\n\n## Unreleased\n\n### Added\n${enBody}\n\n## 0.1.0 - 2026-11-09\n\n### Fixed\n- English fix\n`,
];

test('发布版本、测试版本及触发上下文有严格边界', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(developmentVersion('0.1.0', '42', '3'), '0.1.0-dev.42.3');
  for (const version of ['01.0.0', '1.0', '1.0.0-beta.1', '1.0.0+build']) assert.throws(() => developmentVersion(version, '1', '1'));
  assert.equal(context(env).branch, 'main');
  for (const patch of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/tags/v0.1.0' },
    { GITHUB_REPOSITORY: 'fork/repo' }, { GITHUB_RUN_ID: '1\nmalicious=true' }]) assert.throws(() => context({ ...env, ...patch }));
});

test('双语日志核对全部章节、日期、分类与条目数量并选择本次说明', () => {
  const [zh, en] = logs();
  assert.match(releaseNotes(zh, en, '0.1.0', 'dev'), /中文变更/);
  assert.match(releaseNotes(zh, en, '0.1.0', 'main'), /中文修复/);
  for (const changed of [en.replace('2026-11-09', '2026-11-08'), en.replace('### Fixed', '### Added'),
    en.replace('- English fix', '- First\n- Second'), en.replace('## Unreleased', '## Pending'),
    en.replace('2026-11-09', '2026-02-30')]) assert.throws(() => releaseNotes(zh, changed, '0.1.0', 'main'));
  assert.throws(() => releaseNotes(...logs('', ''), '0.1.0', 'dev'));
  assert.match(releaseNotes(zh, en, '0.2.0', 'main'), /中文变更/);
  assert.throws(() => releaseNotes(...logs('', ''), '0.2.0', 'main'));
  assert.throws(() => releaseNotes(zh.replace('0.1.0 - 2026-11-09', '0.1.0 - 2026-11-09 [已撤回]'),
    en.replace('0.1.0 - 2026-11-09', '0.1.0 - 2026-11-09 [YANKED]'), '0.1.0', 'main'));
});

test('新版本可发布，重复版本只能使用同次运行且完整性一致的恢复记录', () => {
  assert.equal(publicationDecision(null, '0.1.0', null, ctx), 'publish');
  assert.equal(publicationDecision(metadata(), '0.2.0', null, ctx), 'publish');
  assert.equal(publicationDecision(metadata(), '0.1.0', record, ctx), 'verify');
  for (const [data, version, saved, execution] of [
    [metadata(), '0.1.0', null, ctx], [metadata(), '0.1.0', record, { ...ctx, attempt: '1' }],
    [metadata(), '0.1.0', { ...record, runId: 'another' }, ctx],
    [metadata(), '0.1.0', { ...record, sha: 'b'.repeat(40) }, ctx],
    [metadata('0.1.0', 'wrong'), '0.1.0', record, ctx],
    [metadata('0.2.0'), '0.1.0', record, ctx],
    [{ ...metadata(), 'dist-tags': { latest: '0.2.0' } }, '0.1.0', record, ctx],
  ]) assert.throws(() => publicationDecision(data, version, saved, execution));
});

test('仅 registry 404 代表新包，鉴权、限流与服务故障不会放行发布', async () => {
  assert.equal(await registryMetadata(async () => ({ status: 404 })), null);
  for (const status of [401, 403, 429, 500]) await assert.rejects(registryMetadata(async () => ({ status, ok: false })));
  await assert.rejects(registryMetadata(async () => { throw new Error('network unavailable'); }));
});

test('安装包缺失原生库、混入开发文件或凭据时失败', () => {
  validateFileList(requiredFiles);
  for (const files of [requiredFiles.slice(1), [...requiredFiles, 'work/dev-plugin/host.mjs'],
    [...requiredFiles, 'src/.env'], [...requiredFiles, 'src/host/../../secret'],
    [...requiredFiles, 'native/secret.key'], [...requiredFiles, requiredFiles[0]]]) assert.throws(() => validateFileList(files));
  validateText('src/asr/config.mjs', "tokenUrl: 'https://service.example/token'");
  assert.throws(() => validateText('src/asr/config.mjs', "token: 'fixture-secret-123'"));
  assert.throws(() => validateText('src/a.mjs', `const value = 'npm_${'a'.repeat(36)}'`));
  assert.equal(escapeHtml('<script>&</script>'), '&lt;script&gt;&amp;&lt;/script&gt;');
});

test('项目元数据、锁文件与插件实例 ID 在迁移后保持一致', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  // dev 构建会先设置临时版本，再运行本测试。
  pkg.version = pkg.version.replace(/-dev\.\d+\.\d+$/, '');
  lock.version = lock.packages[''].version = pkg.version;
  validateManifest(pkg, lock);
  assert.throws(() => validateManifest(pkg, { ...lock, version: '9.9.9' }));
  const patch = await readFile('cordis.patch.yml', 'utf8');
  assert.match(patch, /id: dsh-sonicloud-device/);
  assert.match(patch, /name: "@sonicloud\/dsh-sonicloud-device"/);
});

test('tarball 检查真实归档、恢复记录和被篡改的哈希', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sonicloud-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of requiredFiles) {
    const path = join(directory, 'package', file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture');
  }
  const pkg = { name: PACKAGE, version: '0.1.0', license: 'MIT', main: 'src/host/index.mjs',
    exports: { './client': './dist/client.js' }, repository: { url: `git+https://github.com/${REPOSITORY}.git` } };
  await writeFile(join(directory, 'package/package.json'), JSON.stringify(pkg));
  await writeFile(join(directory, 'package/dist/build.json'), JSON.stringify({ plugin: 'dsh-sonicloud-device', version: '0.1.0' }));
  await writeFile(join(directory, 'package/cordis.patch.yml'), '- insert:\n    - id: dsh-sonicloud-device\n      name: "@sonicloud/dsh-sonicloud-device"\n');
  const filename = 'fixture.tgz';
  await run('tar', ['-czf', join(directory, filename), '-C', directory, 'package']);
  const buffer = await readFile(join(directory, filename));
  const saved = { ...record, schemaVersion: 1, filename, sha256: createHash('sha256').update(buffer).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(buffer).digest('base64')}` };
  await writeFile(join(directory, 'release.json'), JSON.stringify(saved));
  await writeFile(join(directory, 'SHA256SUMS'), `${saved.sha256}  ${filename}\n`);
  await verifyBundle(directory, record);
  await assert.rejects(verifyBundle(directory, { ...record, runId: '456' }));
  await writeFile(join(directory, filename), 'corrupted');
  await assert.rejects(verifyBundle(directory, record), /SHA-256/);
  await writeFile(join(directory, 'package/.env'), 'SECRET=fixture');
  await run('tar', ['-czf', join(directory, filename), '-C', directory, 'package']);
  await assert.rejects(inspectTarball(join(directory, filename), record), /不允许的路径/);
});

test('发布后同时核对 latest、SRI 和下载内容，不能只相信 registry 元数据', async () => {
  const buffer = Buffer.from('fixture tarball');
  const saved = { ...record, sha256: createHash('sha256').update(buffer).digest('hex') };
  const data = metadata(); data.versions['0.1.0'].dist.tarball = 'https://registry.npmjs.org/package/-/fixture.tgz';
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => buffer });
  await verifyRegistry(saved, data, fetchImpl);
  await assert.rejects(verifyRegistry({ ...saved, sha256: 'bad' }, data, fetchImpl), /SHA-256/);
  data['dist-tags'].latest = '0.2.0';
  await assert.rejects(verifyRegistry(saved, data, fetchImpl), /latest/);
});

test('等待 npm 异步处理，但完整性错误立即失败且不会重复发布', async () => {
  const reads = [null, { ...metadata(), 'dist-tags': { latest: '0.0.9' } }, metadata()];
  let pauses = 0, verifications = 0;
  assert.equal(await awaitPublication(record, {
    readMetadata: async () => reads.shift(), pause: async () => { pauses++; },
    verify: async () => { verifications++; return 'verified'; }, attempts: 3,
  }), 'verified');
  assert.equal(pauses, 2); assert.equal(verifications, 1);
  await assert.rejects(awaitPublication(record, {
    readMetadata: async () => null, pause: async () => {}, attempts: 2,
  }), /未确认版本/);
  await assert.rejects(awaitPublication(record, {
    readMetadata: async () => metadata(), verify: async () => { throw new Error('integrity mismatch'); },
    pause: async () => assert.fail('完整性错误不应等待重试'),
  }), /integrity mismatch/);
});

test('init 在独立工作副本生成测试版本，保持源码日志不变', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sonicloud-init-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  pkg.version = lock.version = lock.packages[''].version = '0.1.0';
  await writeFile(join(directory, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify(lock));
  const [zh, en] = logs('- 内容包含 `$(touch SHOULD_NOT_EXIST)` 与 ${{ secrets.EXAMPLE }}');
  await writeFile(join(directory, 'CHANGELOG.zh.md'), zh); await writeFile(join(directory, 'CHANGELOG.md'), en);
  await run(process.execPath, [resolve('scripts/ci/release.mjs'), 'init'], {
    cwd: directory, env: { ...process.env, ...env, GITHUB_REF: 'refs/heads/dev', GITHUB_OUTPUT: join(directory, 'outputs') },
  });
  assert.equal(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version, '0.1.0-dev.4.2');
  assert.equal(JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8')).packages[''].version, '0.1.0-dev.4.2');
  assert.equal(await readFile(join(directory, 'CHANGELOG.zh.md'), 'utf8'), zh);
  await assert.rejects(readFile(join(directory, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
});
