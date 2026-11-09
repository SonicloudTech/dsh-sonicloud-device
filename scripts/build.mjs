import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { clientBuildOptions } from './client-build.mjs';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('dist', { recursive: true });
await build({
  ...clientBuildOptions, outfile: 'dist/client.js',
});
await writeFile('dist/build.json', JSON.stringify({ plugin: 'dsh-sonicloud-device', version, harness: '0.2.1-rc.5' }, null, 2) + '\n');
console.log('Built dist/client.js for DeepSeek Harness 0.2.1-rc.5');
