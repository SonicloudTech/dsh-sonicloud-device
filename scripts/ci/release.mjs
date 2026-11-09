import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { PACKAGE, REPOSITORY, REGISTRY, developmentVersion, escapeHtml, publicationDecision,
  releaseNotes, validateFileList, validateManifest, validateText } from './policy.mjs';

const run = promisify(execFile);
const artifactDir = 'artifacts/release';
const statePath = 'work/release-state.json';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const hash = (buffer, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(buffer).digest(encoding);

export function context(env = process.env) {
  assert.equal(env.GITHUB_EVENT_NAME, 'push', '仅支持 push 事件');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, '仅允许正式仓库发布');
  assert.ok(['refs/heads/dev', 'refs/heads/main'].includes(env.GITHUB_REF), '仅支持 dev/main 分支');
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT']) {
    assert.match(env[name] ?? '', /^[1-9]\d*$/, `${name} 无效`);
  }
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/, '提交 SHA 无效');
  return { repository: REPOSITORY, sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    runNumber: env.GITHUB_RUN_NUMBER, attempt: env.GITHUB_RUN_ATTEMPT,
    branch: env.GITHUB_REF.slice('refs/heads/'.length),
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` };
}

async function output(values) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

export async function registryMetadata(fetchImpl = fetch) {
  const response = await fetchImpl(`${REGISTRY}/${encodeURIComponent(PACKAGE)}`, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  assert.ok(response.ok, `npm 查询失败：HTTP ${response.status}，不视为新包`);
  const metadata = await response.json();
  assert.equal(metadata.name, PACKAGE, 'npm 返回了不同的包');
  assert.ok(metadata.versions && typeof metadata.versions === 'object', 'npm 版本信息无效');
  return metadata;
}

async function initialize() {
  const ctx = context();
  const pkg = await json('package.json'), lock = await json('package-lock.json');
  validateManifest(pkg, lock);
  const notes = releaseNotes(await readFile('CHANGELOG.zh.md', 'utf8'), await readFile('CHANGELOG.md', 'utf8'), pkg.version, ctx.branch);
  const version = ctx.branch === 'dev' ? developmentVersion(pkg.version, ctx.runNumber, ctx.attempt) : pkg.version;
  const state = { ...ctx, name: pkg.name, version, notes,
    artifactName: ctx.branch === 'main' ? `release-${ctx.runId}` : `dev-${ctx.runId}-${ctx.attempt}` };
  await mkdir('work', { recursive: true });
  await writeJson(statePath, state);
  if (ctx.branch === 'dev') {
    pkg.version = lock.version = lock.packages[''].version = version;
    await writeJson('package.json', pkg); await writeJson('package-lock.json', lock);
  }
  await output({ version, artifact_name: state.artifactName });
  console.log(`发布准备：${pkg.name}@${version}`);
}

async function findArtifact() {
  const state = await json(statePath);
  if (state.branch !== 'main' || Number(state.attempt) === 1) return;
  assert.ok(process.env.GH_TOKEN, '恢复原产物需要 Actions 只读权限');
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/actions/runs/${state.runId}/artifacts?per_page=100`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `查询原产物失败：HTTP ${response.status}`);
  const { artifacts } = await response.json();
  const found = artifacts.find(item => item.name === state.artifactName);
  if (found) {
    assert.ok(!found.expired, '原发布产物已过期，无法安全恢复');
    assert.equal(found.workflow_run?.head_sha, state.sha, '原产物提交不匹配');
    await output({ artifact_id: found.id, artifact_url: `${state.runUrl}/artifacts/${found.id}` });
  }
}

export async function verifyBundle(directory, expected) {
  const record = await json(join(directory, 'release.json'));
  for (const key of ['name', 'version', 'repository', 'sha', 'runId']) assert.equal(record[key], expected[key], `产物记录 ${key} 不匹配`);
  assert.equal(record.schemaVersion, 1, '不支持的产物记录格式');
  assert.ok(/^[a-zA-Z0-9_.-]+\.tgz$/.test(record.filename) && basename(record.filename) === record.filename, '产物文件名无效');
  const buffer = await readFile(join(directory, record.filename));
  assert.equal(hash(buffer), record.sha256, '产物 SHA-256 不一致');
  assert.equal(`sha512-${hash(buffer, 'sha512', 'base64')}`, record.integrity, '产物 SRI 不一致');
  assert.equal(await readFile(join(directory, 'SHA256SUMS'), 'utf8'), `${record.sha256}  ${record.filename}\n`, '校验文件不一致');
  await inspectTarball(join(directory, record.filename), record);
  return record;
}

export async function inspectTarball(filename, expected) {
  // npm 自己生成的包也检查目录与类型，避免意外带入链接或开发文件。
  const { stdout: listing } = await run('tar', ['-tzf', filename], { maxBuffer: 8 * 1024 * 1024 });
  const entries = listing.trim().split('\n');
  assert.ok(entries.every(path => path.startsWith('package/')), 'tar 包必须以 package/ 为根');
  assert.ok(entries.every(path => !path.split('/').includes('..') && !path.includes('\\')), 'tar 包包含目录穿越路径');
  const files = entries.filter(path => !path.endsWith('/')).map(path => path.slice(8));
  validateFileList(files);
  const { stdout: verbose } = await run('tar', ['-tvzf', filename], { maxBuffer: 8 * 1024 * 1024 });
  assert.ok(verbose.trim().split('\n').every(line => ['-', 'd'].includes(line[0])), 'tar 包不允许符号链接、硬链接或特殊文件');
  const temporary = await mkdtemp(join(tmpdir(), 'sonicloud-pack-'));
  try {
    await run('tar', ['-xzf', resolve(filename), '-C', temporary]);
    const root = join(temporary, 'package'), pkg = await json(join(root, 'package.json'));
    assert.equal(pkg.name, expected.name); assert.equal(pkg.version, expected.version);
    assert.equal(pkg.repository?.url, `git+https://github.com/${REPOSITORY}.git`);
    assert.equal(pkg.license, 'MIT'); assert.ok(!pkg.private);
    assert.equal(pkg.main, 'src/host/index.mjs');
    assert.equal(pkg.exports?.['./client'], './dist/client.js');
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /id: dsh-sonicloud-device\s/);
    assert.match(patch, /name: ["']?@sonicloud\/dsh-sonicloud-device["']?\s/);
    const build = await json(join(root, 'dist/build.json'));
    assert.equal(build.plugin, 'dsh-sonicloud-device'); assert.equal(build.version, pkg.version);
    for (const path of files) {
      if (/\.(?:m?js|jsx|json|ya?ml|md|txt|css|html|ps1|cs|swift)$/i.test(path)) {
        validateText(path, await readFile(join(root, path), 'utf8'));
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function preflight() {
  const state = await json(statePath);
  if (state.branch === 'dev') return;
  let record;
  if (process.env.RESTORED_ARTIFACT_ID) record = await verifyBundle(artifactDir, state);
  publicationDecision(await registryMetadata(), state.version, record, state);
}

async function pack() {
  const state = await json(statePath);
  await mkdir(artifactDir, { recursive: true });
  assert.equal((await readdir(artifactDir)).length, 0, '打包目录必须为空');
  const { stdout } = await run('npm', ['pack', '--json', '--pack-destination', artifactDir], { maxBuffer: 8 * 1024 * 1024 });
  // npm --json 仍可能把 prepack 的 stdout 放在最终 JSON 数组之前。
  const packages = JSON.parse(stdout.slice(stdout.lastIndexOf('\n[') + 1));
  assert.equal(packages.length, 1);
  const result = packages[0];
  assert.equal(result.name, state.name); assert.equal(result.version, state.version);
  validateFileList(result.files.map(file => file.path));
  assert.equal(basename(result.filename), result.filename);
  const buffer = await readFile(join(artifactDir, result.filename));
  const record = { schemaVersion: 1, ...state, filename: result.filename, sha256: hash(buffer),
    integrity: `sha512-${hash(buffer, 'sha512', 'base64')}`, createdAt: new Date().toISOString() };
  assert.equal(record.integrity, result.integrity);
  await inspectTarball(join(artifactDir, result.filename), record);
  await writeJson(join(artifactDir, 'release.json'), record);
  await writeFile(join(artifactDir, 'SHA256SUMS'), `${record.sha256}  ${record.filename}\n`);
  console.log(`已检查 ${result.files.length} 个文件；SHA-256：${record.sha256}`);
}

export async function verifyRegistry(record, metadata, fetchImpl = fetch) {
  const version = metadata?.versions?.[record.version];
  assert.equal(version?.name, record.name, 'npm 包尚不可见或包名错误');
  assert.equal(version.version, record.version, 'npm 版本错误');
  assert.equal(metadata['dist-tags']?.latest, record.version, 'npm latest 不匹配');
  assert.equal(version.dist?.integrity, record.integrity, 'npm 完整性不匹配');
  const url = new URL(version.dist.tarball);
  assert.equal(url.origin, REGISTRY, 'npm tarball 地址必须属于官方 registry');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  assert.ok(response.ok, `下载 npm 产物失败：HTTP ${response.status}`);
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), record.sha256, 'npm 实际安装包 SHA-256 不匹配');
  return url.href;
}

export async function awaitPublication(record, { readMetadata = registryMetadata, verify = verifyRegistry,
  pause = delay, attempts = 37 } = {}) {
  // npm 接受上传后可能异步处理数分钟；只有版本和标签可见后才核对实际 tarball。
  for (let attempt = 0; attempt < attempts; attempt++) {
    const metadata = await readMetadata();
    if (metadata?.versions?.[record.version] && metadata['dist-tags']?.latest === record.version) {
      return verify(record, metadata);
    }
    if (attempt + 1 < attempts) await pause(5000);
  }
  throw new Error('npm 已接受发布，但在 3 分钟内未确认版本和 latest；请重跑以核对原产物，不要重复手动发布。');
}

async function publish() {
  const ctx = context();
  assert.equal(ctx.branch, 'main', '仅 main 可发布 npm');
  const pkg = await json('package.json');
  const record = await verifyBundle(artifactDir, { ...ctx, name: pkg.name, version: pkg.version });
  const decision = publicationDecision(await registryMetadata(), record.version, record, ctx);
  if (decision === 'publish') {
    // 不安装依赖、不执行生命周期脚本；只发布 build job 检查过的同一份 tarball。
    const { stdout } = await run('npm', ['publish', resolve(artifactDir, record.filename), '--ignore-scripts',
      '--access', 'public', '--tag', 'latest', `--registry=${REGISTRY}/`], { maxBuffer: 4 * 1024 * 1024, timeout: 180000 });
    console.log(stdout.trim());
  }
  const tarball = await awaitPublication(record);
  await mkdir('work', { recursive: true });
  await writeJson('work/published.json', { version: record.version, name: record.name, tarball,
    page: `https://www.npmjs.com/package/${record.name}/v/${record.version}`, recovered: decision === 'verify' });
  console.log(decision === 'verify' ? '已核对原发布结果，没有重复发布。' : 'npm 发布及完整性验证通过。');
}

export async function summary(env = process.env) {
  const ctx = context(env);
  const steps = JSON.parse(env.STEP_RESULTS || '{}');
  const failures = Object.entries(steps).filter(([, step]) => ['failure', 'cancelled'].includes(step.outcome)).map(([name]) => name);
  const lines = [`## ${env.RELEASE_JOB === 'publish' ? 'npm 发布' : '构建与检查'}：${env.JOB_STATUS || '未知'}`,
    `提交：\`${ctx.sha}\` · [工作流](${ctx.runUrl})`,
    `[本次提交的完整更新日志](https://github.com/${REPOSITORY}/blob/${ctx.sha}/CHANGELOG.zh.md)`];
  if (failures.length) lines.push(`失败阶段：${failures.join('、')}。请查看对应步骤日志。`);
  let state;
  try { state = await json(statePath); } catch { /* 初始化或检出失败时仍生成摘要。 */ }
  if (!state) {
    try { state = await json(join(artifactDir, 'release.json')); } catch { /* 无已检查产物。 */ }
  }
  if (state) lines.push(`版本：\`${state.name}@${state.version}\``,
    `### ${ctx.branch === 'dev' ? '本轮累计变更' : '本版本变更'}`, `<pre>${escapeHtml(state.notes)}</pre>`);
  if (env.ARTIFACT_URL && /^https:\/\/github\.com\/SonicloudTech\/dsh-sonicloud-device\/actions\/runs\/\d+\/artifacts\/\d+$/.test(env.ARTIFACT_URL)) {
    lines.push(`[下载已检查产物](${env.ARTIFACT_URL})（上传后保留 30 天；重跑不延长保留期；需登录 GitHub，下载后解压外层归档获取 .tgz）。`);
    try { const record = await json(join(artifactDir, 'release.json')); lines.push(`SHA-256：\`${record.sha256}\``); } catch { /* 仅有原产物链接。 */ }
  }
  try {
    const published = await json('work/published.json');
    lines.push(`[npm ${published.version}](${published.page}) · [下载 .tgz](${published.tarball})`,
      published.recovered ? '重跑已核对原发布结果。' : '已验证版本、latest 与包完整性。');
  } catch { if (env.RELEASE_JOB === 'publish') lines.push('本次未完成 npm 发布验证；不展示未经核验的 npm 下载链接。'); }
  const result = lines.join('\n\n') + '\n';
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, result);
  else console.log(result);
  return result;
}

const commands = { init: initialize, find: findArtifact, preflight, pack, publish, summary };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = commands[process.argv[2]];
    assert.ok(command, '用法：node scripts/ci/release.mjs init|find|preflight|pack|publish|summary');
    await command();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
