import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { requiredFiles } from '../scripts/ci/policy.mjs';

test('截图安装资源与来源记录校验一致，发布清单覆盖全部运行依赖', async () => {
  const root = new URL('../native/screenshot/', import.meta.url);
  const source = JSON.parse(await readFile(new URL('SOURCE.json', root), 'utf8'));
  assert.equal(source.version, '1.2.2');
  assert.equal(new Set(source.files.map(file => file.path)).size, source.files.length);
  for (const { path, sha256 } of source.files) {
    assert.ok(!path.includes('..') && !path.startsWith('/') && !path.includes('\\'));
    assert.ok(requiredFiles.includes(`native/screenshot/${path}`), `发布清单遗漏 ${path}`);
    const bytes = await readFile(new URL(path, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `${path} 已变更`);
    if (path.endsWith('.exe') || path.endsWith('.dll')) assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
    if (path.endsWith('.zip')) {
      assert.equal(bytes.readUInt32LE(0), 0x04034b50);
      const upstream = source.sources.find(item => item.platform === 'darwin-arm64');
      const derived = source.derivedMacos;
      assert.equal(derived?.outputSha256 ?? upstream.sha256, sha256);
      if (derived) {
        assert.equal(derived.upstreamArchiveSha256, upstream.sha256);
        assert.equal(derived.output, path);
        assert.equal(derived.teamId, 'F3TYM6YPF7');
        assert.equal(derived.bundleId, 'com.clawmouse.screenhelper');
        assert.equal(derived.sameDesignatedRequirement, true);
        assert.equal(derived.codesignVerified, true);
        assert.equal(derived.archiveCodesignVerified, true);
        const patch = await readFile(new URL(derived.patch, root));
        assert.equal(createHash('sha256').update(patch).digest('hex'), derived.patchSha256);
        for (const applied of derived.appliedPatches ?? []) {
          assert.ok(requiredFiles.includes(`native/screenshot/${applied.path}`));
          const bytes = await readFile(new URL(applied.path, root));
          assert.equal(createHash('sha256').update(bytes).digest('hex'), applied.sha256);
        }
      }
    }
  }
  assert.ok(source.files.some(file => file.path.endsWith('/screentool.dll')));
  assert.ok(source.files.some(file => file.path.endsWith('/screenhelper.exe')));
  assert.ok(source.files.some(file => file.path.endsWith('/screentool-macos-1.2.2.zip')));
});
