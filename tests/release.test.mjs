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
import { awaitPublication, context, inspectTarball, publishAndVerify, registryMetadata, verifyBundle, verifyRegistry } from '../scripts/ci/release.mjs';

const run = promisify(execFile);
const ctx = { repository: REPOSITORY, sha: 'a'.repeat(40), runId: '123', attempt: '2' };
const record = { ...ctx, name: PACKAGE, version: '0.1.0', integrity: 'sha512-fixture' };
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: ctx.sha,
  GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '123', GITHUB_RUN_NUMBER: '4', GITHUB_RUN_ATTEMPT: '2' };
const metadata = (version = '0.1.0', integrity = record.integrity) => ({ name: PACKAGE,
  versions: { [version]: { name: PACKAGE, version, dist: { integrity } } }, 'dist-tags': { latest: version } });
function publicationClock(timeoutMs = 10000) {
  let time = 0;
  return { timeoutMs, now: () => time, pause: async ms => { time += ms; }, log: () => {} };
}
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
  assert.equal(releaseNotes(zh, en), '### 新增\n- 中文变更');
  for (const changed of [en.replace('2026-11-09', '2026-11-08'), en.replace('### Fixed', '### Added'),
    en.replace('- English fix', '- First\n- Second'), en.replace('## Unreleased', '## Pending'),
    en.replace('2026-11-09', '2026-02-30')]) assert.throws(() => releaseNotes(zh, changed));
  assert.throws(() => releaseNotes(...logs('', '')), /省略没有条目/);
  assert.throws(() => releaseNotes('# 更新日志\n\n## 未发布\n', '# Changelog\n\n## Unreleased\n'), /缺少本次变更说明/);
});

test('读取顶部最新非空章节，兼容空未发布章节和仅版本章节', () => {
  const [zh, en] = logs();
  const foldedZh = zh.replace('## 未发布\n\n### 新增\n- 中文变更\n\n', '');
  const foldedEn = en.replace('## Unreleased\n\n### Added\n- English change\n\n', '');
  const emptyZh = zh.replace('### 新增\n- 中文变更\n\n', '');
  const emptyEn = en.replace('### Added\n- English change\n\n', '');
  for (const [chinese, english] of [[foldedZh, foldedEn], [emptyZh, emptyEn]]) {
    assert.equal(releaseNotes(chinese, english), '### 修复\n- 中文修复');
    assert.throws(() => releaseNotes(
      chinese.replace('0.1.0 - 2026-11-09', '0.1.0 - 2026-11-09 [已撤回]'),
      english.replace('0.1.0 - 2026-11-09', '0.1.0 - 2026-11-09 [YANKED]')), /版本已撤回/);
    assert.equal(releaseNotes(
      chinese.replace('## 0.1.0', '## 0.2.0 - 2026-11-25\n\n## 0.1.0'),
      english.replace('## 0.1.0', '## 0.2.0 - 2026-11-25\n\n## 0.1.0')), '### 修复\n- 中文修复');
  }
  for (const prefix of ['', '## 未发布\n\n']) {
    const versionedZh = zh.replace('## 未发布', `${prefix}## 0.2.0 - 2026-11-25`);
    const versionedEn = en.replace('## Unreleased', `${prefix.replace('未发布', 'Unreleased')}## 0.2.0 - 2026-11-25`);
    assert.equal(releaseNotes(versionedZh, versionedEn), '### 新增\n- 中文变更');
    assert.throws(() => releaseNotes(
      versionedZh.replace('0.2.0 - 2026-11-25', '0.2.0 - 2026-11-25 [已撤回]'),
      versionedEn.replace('0.2.0 - 2026-11-25', '0.2.0 - 2026-11-25 [YANKED]')), /版本已撤回/);
    assert.throws(() => releaseNotes(
      versionedZh.replace('0.2.0', '0.0.9'), versionedEn.replace('0.2.0', '0.0.9')), /倒序排列/);
  }
  const swappedZh = zh.replace('## 未发布\n\n### 新增\n- 中文变更\n\n## 0.1.0 - 2026-11-09',
    '## 0.1.0 - 2026-11-09\n\n### 修复\n- 临时条目\n\n## 未发布\n\n### 新增\n- 中文变更\n\n## 0.0.9 - 2026-11-08');
  assert.throws(() => releaseNotes(swappedZh, en), /未发布章节必须置顶/);
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
  let verifications = 0;
  const clock = publicationClock(15000);
  assert.equal(await awaitPublication(record, {
    ...clock, readMetadata: async () => reads.shift(),
    verify: async () => { verifications++; return 'verified'; },
  }), 'verified');
  assert.equal(clock.now(), 10000); assert.equal(verifications, 1);
  await assert.rejects(awaitPublication(record, {
    ...publicationClock(), readMetadata: async () => null,
  }), /未确认版本/);
  await assert.rejects(awaitPublication(record, {
    ...publicationClock(),
    readMetadata: async () => metadata(), verify: async () => { throw new Error('integrity mismatch'); },
    pause: async () => assert.fail('完整性错误不应等待重试'),
  }), /integrity mismatch/);
});

test('发布超过十分钟才可见仍能确认，查询耗时计入截止时间', async () => {
  const clock = publicationClock();
  delete clock.timeoutMs; // 使用实际默认窗口，避免退回 3 分钟后测试仍通过。
  assert.equal(await awaitPublication(record, {
    ...clock, readMetadata: async () => clock.now() < 10.5 * 60000 ? null : metadata(),
    verify: async () => 'verified',
  }), 'verified');
  assert.equal(clock.now(), 10.5 * 60000);
  const slow = publicationClock();
  let reads = 0;
  await assert.rejects(awaitPublication(record, {
    ...slow, readMetadata: async signal => {
      assert.ok(signal instanceof AbortSignal);
      reads++; await slow.pause(10000); return null;
    },
    pause: async () => assert.fail('查询已耗尽预算，不再等待'),
  }), /发布结果未确认/);
  assert.equal(reads, 1);
});

test('确认阶段重试查询、下载和响应体的临时故障，最终仍核对真实包', async () => {
  const buffer = Buffer.from('fixture tarball');
  const saved = { ...record, sha256: createHash('sha256').update(buffer).digest('hex') };
  const data = metadata();
  data.versions[record.version].dist.tarball = 'https://registry.npmjs.org/package/-/fixture.tgz';
  let reads = 0, downloads = 0;
  const networkError = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  const result = await awaitPublication(saved, {
    ...publicationClock(60000),
    readMetadata: signal => registryMetadata(async () => {
      reads++;
      if (reads === 1) throw new DOMException('timed out', 'TimeoutError');
      if (reads === 2) return { ok: false, status: 503 };
      if (reads === 3) return { ok: false, status: 429 };
      return { ok: true, json: async () => data };
    }, signal),
    verify: (value, meta, signal) => verifyRegistry(value, meta, async () => {
      downloads++;
      if (downloads === 1) return { ok: false, status: 404 };
      if (downloads === 2) return { ok: false, status: 502 };
      return { ok: true, arrayBuffer: async () => {
        if (downloads === 3) throw networkError;
        if (downloads === 4) throw new DOMException('body timed out', 'AbortError');
        return buffer;
      } };
    }, signal),
  });
  assert.equal(result, data.versions[record.version].dist.tarball);
  assert.equal(reads, 8); assert.equal(downloads, 5);
});

test('鉴权、无效元数据、错误 SRI 或 SHA-256 不会被重试掩盖', async () => {
  const noRetry = { ...publicationClock(), pause: async () => assert.fail('永久错误不得重试') };
  for (const status of [400, 401, 403]) {
    await assert.rejects(awaitPublication(record, {
      ...noRetry, readMetadata: () => registryMetadata(async () => ({ ok: false, status })),
    }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(awaitPublication(record, {
    ...noRetry, readMetadata: () => registryMetadata(async () => ({ ok: true, json: async () => ({ name: 'wrong' }) })),
  }), /不同的包/);
  await assert.rejects(awaitPublication(record, {
    ...noRetry, readMetadata: async () => ({ ...metadata(record.version, 'wrong'), 'dist-tags': {} }),
  }), /完整性/);
  const data = metadata(); data.versions[record.version].dist.tarball = 'https://registry.npmjs.org/fixture.tgz';
  await assert.rejects(awaitPublication({ ...record, sha256: 'wrong' }, {
    ...noRetry, readMetadata: async () => data,
    verify: (value, meta) => verifyRegistry(value, meta, async () => ({ ok: true, arrayBuffer: async () => Buffer.from('wrong') })),
  }), /SHA-256/);
});

test('上传成功、超时或断线均核对原包且只上传一次；永久失败立即退出', async () => {
  for (const error of [null, Object.assign(new Error('command timed out'), { killed: true, signal: 'SIGTERM' }),
    Object.assign(new Error('network failure'), { stderr: 'npm error code ETIMEDOUT' })]) {
    let uploads = 0, verifications = 0;
    const result = await publishAndVerify({ ...record, filename: 'fixture.tgz' }, {
      execute: async (command, args) => {
        uploads++; assert.equal(command, 'npm'); assert.equal(args[0], 'publish');
        assert.ok(args.includes('--ignore-scripts'));
        if (error) throw error;
        return { stdout: 'published', stderr: '' };
      },
      waitForPublication: async saved => {
        verifications++; assert.equal(saved.integrity, record.integrity); return 'verified';
      }, log: () => {}, warn: () => {},
    });
    assert.equal(result, 'verified'); assert.equal(uploads, 1); assert.equal(verifications, 1);
  }
  const denied = Object.assign(new Error('publish denied'), { stderr: 'npm error code E403' });
  await assert.rejects(publishAndVerify({ ...record, filename: 'fixture.tgz' }, {
    execute: async () => { throw denied; }, waitForPublication: async () => assert.fail('鉴权失败不等待'), log: () => {},
  }), error => error === denied);
  let uploads = 0;
  await assert.rejects(publishAndVerify({ ...record, filename: 'fixture.tgz' }, {
    execute: async () => { uploads++; throw Object.assign(new Error('timeout'), { killed: true }); },
    waitForPublication: saved => awaitPublication(saved, { ...publicationClock(), readMetadata: async () => null }),
    log: () => {}, warn: () => {},
  }), /发布结果未确认/);
  assert.equal(uploads, 1);
});

test('dev 和 main 初始化均读取最新变更，不依赖包版本或未发布标题', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sonicloud-latest-notes-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const [zh, en] = logs();
  const cases = [
    [zh, en],
    [zh.replace('## 未发布', '## 未发布\n\n## 0.2.0 - 2026-11-25'),
      en.replace('## Unreleased', '## Unreleased\n\n## 0.2.0 - 2026-11-25')],
    [zh.replace('## 未发布', '## 0.2.0 - 2026-11-25'),
      en.replace('## Unreleased', '## 0.2.0 - 2026-11-25')],
  ];
  for (const branch of ['dev', 'main']) {
    // 覆盖包版本指向旧章节和日志中没有对应包版本章节的情况。
    for (const version of ['0.1.0', '0.3.0']) {
      for (const [chinese, english] of cases) {
        pkg.version = lock.version = lock.packages[''].version = version;
        await writeFile(join(directory, 'package.json'), JSON.stringify(pkg));
        await writeFile(join(directory, 'package-lock.json'), JSON.stringify(lock));
        await writeFile(join(directory, 'CHANGELOG.zh.md'), chinese);
        await writeFile(join(directory, 'CHANGELOG.md'), english);
        await run(process.execPath, [resolve('scripts/ci/release.mjs'), 'init'], {
          cwd: directory, env: { ...process.env, ...env, GITHUB_REF: `refs/heads/${branch}`, GITHUB_OUTPUT: join(directory, 'outputs') },
        });
        const state = JSON.parse(await readFile(join(directory, 'work/release-state.json'), 'utf8'));
        assert.equal(state.notes, '### 新增\n- 中文变更');
        assert.equal(state.version, branch === 'dev' ? `${version}-dev.4.2` : version);
      }
    }
  }
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
