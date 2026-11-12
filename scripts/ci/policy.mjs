import assert from 'node:assert/strict';

export const PACKAGE = '@sonicloud/dsh-sonicloud-device';
export const REPOSITORY = 'SonicloudTech/dsh-sonicloud-device';
export const REGISTRY = 'https://registry.npmjs.org';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function stableVersion(version) {
  assert.match(version, stable, '正式版本必须为稳定 SemVer（不含预发布或构建后缀）');
  return version.split('.').map(BigInt);
}

export function compareVersions(a, b) {
  const left = stableVersion(a), right = stableVersion(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export function developmentVersion(version, runNumber, attempt) {
  stableVersion(version);
  for (const value of [runNumber, attempt]) assert.match(String(value), /^[1-9]\d*$/, '运行编号无效');
  return `${version}-dev.${runNumber}.${attempt}`;
}

const categories = new Map([
  ['Added', 'Added'], ['新增', 'Added'], ['Changed', 'Changed'], ['变更', 'Changed'],
  ['Deprecated', 'Deprecated'], ['弃用', 'Deprecated'], ['Removed', 'Removed'], ['移除', 'Removed'],
  ['Fixed', 'Fixed'], ['修复', 'Fixed'], ['Security', 'Security'], ['安全', 'Security'],
]);

export function parseChangelog(text, language) {
  const sections = [];
  for (const match of text.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)) {
    const [, heading, body] = match;
    const unreleased = heading === (language === 'zh' ? '未发布' : 'Unreleased');
    const release = /^(\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})(?: (\[YANKED\]|\[已撤回\]))?$/.exec(heading);
    assert.ok(unreleased || release, `更新日志章节格式错误：${heading}`);
    if (release) {
      stableVersion(release[1]);
      const date = new Date(`${release[2]}T00:00:00Z`);
      assert.ok(!Number.isNaN(date.valueOf()) && date.toISOString().startsWith(release[2]), '更新日志日期无效');
    }
    const groups = [];
    let group;
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith('### ')) {
        const category = categories.get(line.slice(4));
        assert.ok(category, `未知更新日志分类：${line}`);
        assert.ok(!groups.some(item => item.category === category), '更新日志分类重复');
        group = { category, entries: 0 }; groups.push(group);
      } else if (/^-\s+\S/.test(line)) {
        assert.ok(group, '变更条目必须归入分类'); group.entries++;
      }
    }
    assert.ok(groups.every(item => item.entries > 0), '省略没有条目的更新日志分类');
    const version = unreleased ? 'Unreleased' : release[1];
    assert.ok(!sections.some(item => item.version === version), '更新日志版本重复');
    sections.push({ version, date: release?.[2] ?? null, yanked: Boolean(release?.[3]), groups, body: body.trim() });
  }
  if (sections.some(section => section.version === 'Unreleased'))
    assert.equal(sections[0]?.version, 'Unreleased', '未发布章节必须置顶');
  for (let i = 2; i < sections.length; i++) {
    assert.ok(compareVersions(sections[i - 1].version, sections[i].version) > 0, '已发布版本须按倒序排列');
  }
  return sections;
}

export function releaseNotes(zh, en, version, branch) {
  const chinese = parseChangelog(zh, 'zh'), english = parseChangelog(en, 'en');
  const structure = sections => sections.map(({ body, ...section }) => section);
  assert.deepEqual(structure(chinese), structure(english), '中英文更新日志版本、日期、分类或条目数量不一致');
  // main 无对应版本章节时回退采用未发布章节，dev 直接合并即可发布；已撤回的版本章节不回退。
  const wanted = branch === 'dev' || !chinese.some(section => section.version === version)
    ? 'Unreleased' : version;
  const selected = chinese.find(section => section.version === wanted);
  assert.ok(selected && !selected.yanked && selected.groups.some(group => group.entries), '缺少本次变更说明或版本已撤回');
  return selected.body;
}

export function validateManifest(pkg, lock) {
  assert.equal(pkg.name, PACKAGE, 'npm 包名错误');
  stableVersion(pkg.version);
  assert.equal(pkg.repository?.url, `git+https://github.com/${REPOSITORY}.git`, 'repository 元数据错误');
  assert.equal(pkg.license, 'MIT', '项目许可证必须为已确认的 MIT');
  assert.ok(!pkg.private, '发布包不能标为 private');
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.equal(pkg.publishConfig?.registry, `${REGISTRY}/`);
  for (const manifest of [lock, lock.packages?.['']]) {
    assert.equal(manifest?.name, pkg.name, '锁文件包名不一致');
    assert.equal(manifest?.version, pkg.version, '锁文件版本不一致');
  }
}

// 已存在版本仅可通过同一次运行保存的产物恢复，不允许按版本号静默跳过。
export function publicationDecision(metadata, version, record, context) {
  stableVersion(version);
  const versions = metadata?.versions ?? {};
  for (const published of Object.keys(versions).filter(value => stable.test(value))) {
    assert.ok(compareVersions(version, published) >= 0, `版本 ${version} 低于已发布正式版 ${published}`);
  }
  const latest = metadata?.['dist-tags']?.latest;
  if (latest) {
    stableVersion(latest);
    assert.ok(compareVersions(version, latest) >= 0, '禁止 latest 回退');
  }
  if (!versions[version]) return 'publish';
  assert.ok(Number(context.attempt) > 1 && record, '版本已发布，且没有同次运行的重试记录');
  for (const key of ['repository', 'sha', 'runId']) assert.equal(record[key], context[key], `发布记录 ${key} 不匹配`);
  assert.equal(record.version, version);
  assert.equal(record.name, PACKAGE);
  assert.equal(versions[version].dist?.integrity, record.integrity, 'npm 与保存产物的完整性不一致');
  assert.equal(latest, version, '重跑时 latest 与本版本不一致，不自动修改标签');
  return 'verify';
}

export const requiredFiles = [
  'package.json', 'LICENSE', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'CHANGELOG.zh.md', 'cordis.patch.yml',
  'dist/client.js', 'dist/build.json', 'src/host/index.mjs', 'src/devices/native.mjs',
  'src/devices/native-worker.mjs', 'src/asr/config.mjs', 'src/desktop/presentation.mjs',
  'native/THIRD_PARTY_LICENSES.txt', 'native/COPYING.LGPLv2.1', 'native/LICENSE.hidapi-bsd',
  'native/darwin-arm64/libuMouseSdk.dylib', 'native/darwin-arm64/libuMouseSdk.0.dylib',
  'native/darwin-arm64/libavcodec.62.dylib', 'native/darwin-arm64/libavutil.60.dylib',
  'native/win32-x64/uMouseSdk.dll', 'native/win32-x64/avcodec-58.dll', 'native/win32-x64/avutil-56.dll',
  'native/win32-x64/msvcp140.dll', 'native/win32-x64/vcruntime140.dll', 'native/win32-x64/vcruntime140_1.dll',
  'native/desktop/darwin-arm64/Sonicloud Voice.app/Contents/MacOS/sonicloud-voice', 'native/desktop/windows.ps1',
];

export function validateFileList(files) {
  const paths = new Set(files);
  assert.equal(paths.size, files.length, '安装包存在重复路径');
  for (const path of requiredFiles) assert.ok(paths.has(path), `安装包缺少 ${path}`);
  for (const path of paths) {
    assert.ok(!path.split('/').some(part => part.startsWith('.') || ['node_modules', 'work', 'tests', 'scripts', 'generations'].includes(part)), `安装包含不允许的路径：${path}`);
    assert.ok(!/[\\\r\n]/.test(path) && !path.startsWith('/'), '安装包路径无效');
    assert.ok(/^(?:src\/(?:asr|host|shared|devices|desktop|client\/assets)\/|native\/|docs\/|dist\/(?:client\.js|build\.json)$|(?:package\.json|cordis\.patch\.yml|README(?:\.zh)?\.md|CHANGELOG(?:\.zh)?\.md|LICENSE)$)/.test(path), `安装包含非发布文件：${path}`);
    assert.ok(!/\.(?:pem|key|p12|pfx|tgz|log|map)$/i.test(path), `安装包含敏感或临时文件：${path}`);
  }
}

export function validateText(path, contents) {
  const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bnpm_[A-Za-z0-9]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bAKIA[A-Z0-9]{16}\b|["']?(?:accessToken|apiKey|appSecret|clientSecret|password|token)["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i;
  assert.ok(!secret.test(contents), `安装包可能包含凭据：${path}（不输出匹配内容）`);
  assert.ok(!/work\/dev-plugin|watch\.lock|client\.next\.js/.test(path === 'dist/client.js' ? contents : ''), '客户端包含开发产物');
}

export function escapeHtml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
