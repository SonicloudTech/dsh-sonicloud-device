import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

// Poll metadata rather than fs.watch so atomic saves, directory additions and Windows work alike.
export async function fingerprint(root) {
  const entries = [];
  async function walk(relative) {
    const path = join(root, relative);
    let info;
    try { info = await stat(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') { entries.push([relative, 'missing']); return; } throw error; }
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(`${relative}/${name}`);
    } else entries.push([relative, String(info.mtimeNs), String(info.ctimeNs), String(info.size), String(info.ino)]);
  }
  for (const path of ['src', 'docs', 'native', 'package.json', 'package-lock.json', 'cordis.patch.yml']) await walk(path);
  return JSON.stringify(entries);
}

export async function prepareBuild(root, runtime) {
  const { clientBuildOptions } = await import('../client-build.mjs');
  const revision = randomUUID();
  const generation = join(runtime, 'generations', revision);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await mkdir(generation, { recursive: true });
  try {
    const entry = `
import { copyFile, rename, writeFile } from 'node:fs/promises';
import * as plugin from './src/host/index.mjs';
export * from './src/host/index.mjs';
export const inject = [...plugin.inject, 'clientModules'];
export async function apply(ctx, config) {
  const cleanup = await plugin.apply(ctx, config);
  const client = new URL('./dist/client.js', import.meta.url);
  const pending = new URL('./dist/client.next.js', import.meta.url);
  await copyFile(new URL('./generations/${revision}/client.js', import.meta.url), pending);
  await rename(pending, client);
  ctx.clientModules.rebuilt('@sonicloud/dsh-sonicloud-device');
  await writeFile(new URL('./applied.json', import.meta.url), JSON.stringify({ revision: '${revision}', pid: process.pid }));
  ctx.logger.info('智能鼠标开发版本已重载：${revision}');
  return cleanup;
}
`;
    const common = { absWorkingDir: root, bundle: true, write: false, logLevel: 'silent' };
    const results = await Promise.allSettled([
      build({ ...common, ...clientBuildOptions, outfile: join(generation, 'client.js') }),
      build({ ...common, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
        stdin: { contents: entry, resolveDir: root, sourcefile: 'dev-host.mjs' }, outfile: join(generation, 'host.mjs'),
        plugins: [{ name: 'development-native-location', setup(builder) {
          builder.onLoad({ filter: /[/\\](?:devices[/\\]native|desktop[/\\]presentation)\.mjs$/ }, async ({ path }) => ({
            contents: (await readFile(path, 'utf8')).replaceAll('import.meta.url',
              JSON.stringify(pathToFileURL(join(generation, path.endsWith('presentation.mjs') ? 'src/desktop/presentation.mjs' : 'src/devices/native.mjs')).href)), loader: 'js',
          }));
        } }],
      }),
      build({ ...common, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
        entryPoints: ['src/devices/native-worker.mjs'], outfile: join(generation, 'src/devices/native-worker.mjs') }),
    ]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    for (const result of results) for (const file of result.value.outputFiles) await atomicWrite(file.path, file.contents);
    await cp(join(root, 'native'), join(generation, 'native'), { recursive: true });
    return { revision, generation, async publish() {
      await mkdir(join(runtime, 'dist'), { recursive: true });
      await cp(join(root, 'src/client/assets'), join(runtime, 'src/client/assets'), { recursive: true });
      // The client entry must exist before Harness composes the package for the first time.
      try { await stat(join(runtime, 'dist/client.js')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await cp(join(generation, 'client.js'), join(runtime, 'dist/client.js')); }
      try { await symlink(join(root, 'node_modules'), join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const developmentManifest = { name: manifest.name, version: manifest.version, description: manifest.description,
        icon: manifest.icon, private: true, type: 'module',
        main: './host.mjs', exports: { '.': './host.mjs', './client': './dist/client.js', './package.json': './package.json' },
        dsh: manifest.dsh, dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies, engines: manifest.engines };
      await writeIfChanged(join(runtime, 'package.json'), JSON.stringify(developmentManifest, null, 2) + '\n');
      const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
      await writeIfChanged(join(runtime, 'cordis.patch.yml'), `${patch}\n- id: hmr\n  disabled: false\n  config:\n    root: [${JSON.stringify(join(runtime, 'host.mjs'))}]\n`);
      // One stable bundled module lets HMR evict all plugin code; workers/libraries remain immutable per generation.
      await atomicWrite(join(runtime, 'host.mjs'), await readFile(join(generation, 'host.mjs')));
    }, discard: () => rm(generation, { recursive: true, force: true }) };
  } catch (error) { await rm(generation, { recursive: true, force: true }); throw error; }
}

async function writeIfChanged(path, contents) {
  try { if (await readFile(path, 'utf8') === contents) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomicWrite(path, contents);
}

export async function pruneGenerations(runtime, revision, previous) {
  for (const name of await readdir(join(runtime, 'generations'))) {
    if (name === revision || name === previous) continue;
    await rm(join(runtime, 'generations', name), { recursive: true, force: true }).catch(() => {});
  }
}
