import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { fingerprint, prepareBuild } from '../scripts/dev/build.mjs';
import { MemoryCredentials } from './helpers.mjs';

async function fixture(t) {
  await mkdir('work', { recursive: true });
  const root = await mkdtemp(resolve('work/dev-test-'));
  for (const name of ['src', 'docs', 'scripts', 'package.json', 'package-lock.json', 'cordis.patch.yml']) {
    await cp(resolve(name), join(root, name), { recursive: true });
  }
  await mkdir(join(root, 'native'));
  await writeFile(join(root, 'native/fixture.txt'), 'native-generation-1');
  await symlink(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, runtime: join(root, 'work/dev-plugin') };
}
async function waitFor(predicate, timeout = 10000) {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > timeout) throw new Error('等待开发构建超时');
    await delay(50);
  }
}

test('development generation reloads nested Host code and only publishes Client after Host activation', async t => {
  const { root, runtime } = await fixture(t);
  const first = await prepareBuild(root, runtime); await first.publish();
  const initialClient = await readFile(join(runtime, 'dist/client.js'), 'utf8');
  const source = join(root, 'src/asr/config.mjs');
  await writeFile(source, (await readFile(source, 'utf8')).replace("name: '声云 ASR'", "name: '热更新声云'"));
  await writeFile(join(root, 'src/client/styles.css'), (await readFile(join(root, 'src/client/styles.css'), 'utf8')) + '\n.dev-test { color: red; }\n');
  const second = await prepareBuild(root, runtime); await second.publish();
  assert.equal(await readFile(join(runtime, 'dist/client.js'), 'utf8'), initialClient);
  const ctx = new Context();
  const credentials = new MemoryCredentials(); ctx.provide('credentials', credentials);
  const notifications = []; ctx.provide('clientModules', { rebuilt: id => notifications.push(id) });
  try {
    await ctx.plugin(TypertRegistry);
    const plugin = await import(pathToFileURL(join(runtime, 'host.mjs')).href);
    const fiber = ctx.plugin(plugin); await fiber;
    assert.deepEqual(notifications, ['dsh-sonicloud-device']);
    assert.equal(JSON.parse(await readFile(join(runtime, 'applied.json'), 'utf8')).revision, second.revision);
    assert.match(await readFile(join(runtime, 'dist/client.js'), 'utf8'), /dev-test/);
    assert.ok(ctx.typert.local.get('asr/watch'));
    assert.equal((await ctx.sinicloudAsr.catalog()).services[0].name, '热更新声云');
    await fiber.dispose();
    assert.equal(ctx.typert.local.get('asr/watch'), undefined);
    assert.equal(await readFile(join(first.generation, 'native/fixture.txt'), 'utf8'), 'native-generation-1');
    assert.match(await readFile(join(runtime, 'host.mjs'), 'utf8'), /src\/devices\/native\.mjs/);
  } finally { await ctx.fiber.dispose(); }
});

test('failed client, Host and worker builds leave committed generation intact', async t => {
  const { root, runtime } = await fixture(t);
  const good = await prepareBuild(root, runtime); await good.publish();
  const host = await readFile(join(runtime, 'host.mjs'), 'utf8');
  const client = await readFile(join(runtime, 'dist/client.js'), 'utf8');
  for (const relative of ['src/client/index.jsx', 'src/host/index.mjs', 'src/devices/native-worker.mjs']) {
    const path = join(root, relative), original = await readFile(path, 'utf8');
    await writeFile(path, 'export const broken = ;');
    await assert.rejects(prepareBuild(root, runtime));
    assert.equal(await readFile(join(runtime, 'host.mjs'), 'utf8'), host);
    assert.equal(await readFile(join(runtime, 'dist/client.js'), 'utf8'), client);
    assert.deepEqual(await readdir(join(runtime, 'generations')), [good.revision]);
    await writeFile(path, original);
  }
});

test('source polling detects atomic replacement, additions and deletion but ignores generated files', async t => {
  const { root, runtime } = await fixture(t);
  let before = await fingerprint(root);
  await mkdir(runtime, { recursive: true }); await writeFile(join(runtime, 'host.mjs'), 'output');
  assert.equal(await fingerprint(root), before);
  const path = join(root, 'src/new-source.mjs'); await writeFile(path, 'export default 1;');
  assert.notEqual(await fingerprint(root), before); before = await fingerprint(root);
  await writeFile(`${path}.tmp`, 'export default 2;'); await rename(`${path}.tmp`, path);
  assert.notEqual(await fingerprint(root), before); before = await fingerprint(root);
  await rm(path); assert.notEqual(await fingerprint(root), before);
});

test('watch command rebuilds on save, survives syntax errors and releases its lock on stop', { timeout: 20000 }, async t => {
  const { root, runtime } = await fixture(t);
  let output = '';
  const child = spawn(process.execPath, [join(root, 'scripts/dev.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  try {
    await waitFor(() => output.includes('构建成功'));
    const path = join(root, 'src/host/index.mjs'), original = await readFile(path, 'utf8');
    const committed = await readFile(join(runtime, 'host.mjs'), 'utf8');
    await writeFile(path, 'export const invalid = ;');
    await waitFor(() => output.includes('构建失败'));
    assert.equal(await readFile(join(runtime, 'host.mjs'), 'utf8'), committed);
    await writeFile(path, original + '\nexport const saveMarker = "watch-recovered";\n');
    await waitFor(async () => (await readFile(join(runtime, 'host.mjs'), 'utf8')).includes('watch-recovered'));
    assert.equal((output.match(/构建成功/g) ?? []).length, 2);
  } finally { child.kill('SIGTERM'); await exited; }
  await assert.rejects(readFile(join(runtime, 'watch.lock')), { code: 'ENOENT' });
});
