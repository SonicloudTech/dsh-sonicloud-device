import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { LOCALES } from '../src/shared/i18n.mjs';

export async function buildPluginMetadata(root = new URL('../', import.meta.url)) {
  const intro = async file => (await readFile(new URL(file, root), 'utf8')).split(/\r?\n\s*\r?\n/).find(part => part.trim() && !/^(#|<)/.test(part.trim()));
  const [zh, en] = await Promise.all([intro('README.zh.md'), intro('README.md')]);
  if (!zh || !en) throw new Error('README introduction is missing');
  await mkdir(new URL('locale/', root), { recursive: true });
  for (const language of LOCALES) {
    const dict = JSON.parse(await readFile(new URL(`src/shared/locales/${language}.json`, root), 'utf8'));
    const meta = { title: dict['app.plugin'], description: language === 'zh' ? zh : en, detail: language === 'zh' ? 'README.zh.md' : 'README.md' };
    await writeFile(new URL(`locale/${language}.json`, root), JSON.stringify({ meta }, null, 2) + '\n');
  }
}
