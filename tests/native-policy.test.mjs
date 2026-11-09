import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = promisify(execFile);

test('macOS compatibility rejects target/activity changes and preserves newer clipboard writes', { skip: process.platform !== 'darwin' }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sonicloud-policy-'));
  try {
    const binary = join(temporary, 'policy-tests');
    await run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(temporary, 'modules'),
      'native/desktop/CompatibilityPolicy.swift', 'tests/compatibility-policy.swift', '-o', binary], { timeout: 60000 });
    const result = await run(binary, [], { timeout: 5000 });
    assert.match(result.stdout, /Default paste guards passed/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
