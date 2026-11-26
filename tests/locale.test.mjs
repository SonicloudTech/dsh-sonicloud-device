import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import { dictionaries, LOCALES, translate, message, renderMessage, resolveLocale } from '../src/shared/i18n.mjs';
import { ClientLocale } from '../src/client/locale.mjs';
import { HostLocale, attachHostLocale } from '../src/host/locale.mjs';
import { DeviceController } from '../src/client/controller.mjs';
import { REC_LANG_LIST, TRANS_FROM_LANG_LIST } from '../src/shared/devices.mjs';
import { languageLabel } from '../src/client/locale-options.mjs';
import { hostLocale } from './locale-helper.mjs';

const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
test('8 语种资源覆盖全部静态键，参数一致且非中文品牌统一', async () => {
  assert.deepEqual(LOCALES, ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']);
  const keys = Object.keys(dictionaries.en).sort();
  for (const [language, data] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(data).sort(), keys, language);
    for (const key of keys) {
      assert.ok(data[key].trim(), `${language}:${key}`);
      assert.deepEqual(placeholders(data[key]), placeholders(dictionaries.en[key]), `${language}:${key}`);
      if (language !== 'zh') assert.doesNotMatch(data[key], /声云/);
    }
    assert.match(data['app.title'], language === 'zh' ? /声云/ : /Sonicloud/);
    const { host, form } = hostLocale(language); const locale = new ClientLocale(host, form);
    for (const item of [...REC_LANG_LIST, ...TRANS_FROM_LANG_LIST]) {
      assert.ok(languageLabel(item, locale));
      assert.doesNotMatch(languageLabel(item, locale), /undefined/);
    }
    for (const count of [0, 1, 2, 5, 21]) assert.ok(locale.count(count).includes(String(count)));
  }
  for (const directory of ['src', 'native/desktop']) {
    for (const file of await readdir(directory, { recursive: true })) {
      if (!/\.(mjs|jsx|swift|cs)$/.test(file)) continue;
      const content = await readFile(`${directory}/${file}`, 'utf8');
      for (const match of content.matchAll(/(?:\bt|\bmsg|\bencode|\bEncode)\(['"]([^'"]+)['"]/g)) {
        assert.ok(Object.hasOwn(dictionaries.en, match[1]), `${file}:${match[1]}`);
      }
    }
  }
});

test('额外语言沿宿主回退链解析，未知动态错误和递归消息不外露键', () => {
  assert.equal(resolveLocale('pt-PT', [{ id: 'pt-PT', fallback: 'pt' }]), 'pt');
  assert.equal(resolveLocale('xx', [{ id: 'xx', fallback: 'yy' }, { id: 'yy', fallback: 'xx' }]), 'en');
  assert.equal(resolveLocale('unknown'), 'en');
  assert.equal(translate('zh', 'toString'), dictionaries.zh['error.generic']);
  const saved = message('error.notSaved', { reason: message('error.url') });
  for (const language of LOCALES) {
    const t = (key, params) => translate(language, key, params);
    assert.equal(renderMessage('unknown SDK error', t), t('error.generic'));
    assert.equal(renderMessage(message('missing.key'), t), t('error.generic'));
    const text = renderMessage(saved, t);
    assert.ok(text.includes(t('error.url'))); assert.doesNotMatch(text, /sonicloud:|undefined|\{reason\}/);
  }
  assert.notEqual(translate('ru', 'device.count.one', { count: 1 }), translate('ru', 'device.count.few', { count: 1 }));
});

test('只提交已加载且与活动语言一致的宿主版本，卸载释放语言订阅', async () => {
  const { host, form, listeners, formListeners } = hostLocale('zh');
  const locale = new ClientLocale(host, form); const requests = [];
  form.update({ status: 'loading', revision: undefined });
  const controller = new DeviceController({ syncLocale: async value => { requests.push(value); } }, { locale });
  assert.equal(requests.length, 0);
  form.update({ status: 'ready', revision: 3, value: { preference: 'de' } });
  assert.equal(requests.length, 0);
  host.update({ active: 'de' });
  assert.deepEqual(requests, [{ active: 'de', resolved: 'de', revision: 3 }]);
  await controller.event({ type: 'devices', devices: [] });
  assert.equal(requests.length, 2, '重连设备快照会重同步语言');
  controller.dispose(); assert.equal(listeners.size, 0); assert.equal(formListeners.size, 0);
  host.update({ active: 'en' }); assert.equal(requests.length, 2);
});

test('后台以宿主配置版本为准，拒绝旧窗口、乱序回包和初始化临时语言', () => {
  const applied = []; let state;
  const locale = new HostLocale(value => applied.push(value)); locale.attach(() => state);
  assert.equal(locale.accept({ active: 'zh', resolved: 'zh', revision: 1 }), false);
  state = { revision: 1, value: { preference: 'zh' } }; locale.refresh();
  assert.deepEqual(applied, ['zh']);
  assert.equal(locale.accept({ active: 'en', resolved: 'en', revision: 1 }), false);
  state = { revision: 2, value: { preference: 'ja' } };
  assert.equal(locale.accept({ active: 'zh', resolved: 'zh', revision: 1 }), false);
  assert.equal(locale.locale, 'ja');
  assert.equal(locale.accept({ active: 'ja', resolved: 'en', revision: 2 }), false);
  assert.equal(locale.accept({ active: 'ja', resolved: 'ja', revision: 2 }), true);
  state = undefined; locale.refresh(); assert.equal(locale.locale, 'ja');
  assert.deepEqual(applied, ['zh', 'ja'], '重复快照与断连不重发浮层语言');
});

test('自动语言仅接受当前版本首个有效结果，关闭窗口保留结果', () => {
  let state = { revision: 5, value: {} }; const locale = new HostLocale(() => {}); locale.attach(() => state);
  assert.equal(locale.locale, 'en');
  assert.equal(locale.accept({ active: 'pt', resolved: 'pt', revision: 5 }), true);
  assert.equal(locale.accept({ active: 'en', resolved: 'en', revision: 5 }), false);
  assert.equal(locale.accept({ active: 'pt', resolved: 'en', revision: 5 }), false);
  locale.read = undefined; locale.refresh(); assert.equal(locale.locale, 'pt');
  state = { revision: 6, value: {} }; locale.attach(() => state);
  assert.equal(locale.accept({ active: 'custom', resolved: 'fr', revision: 6 }), true);
  assert.equal(locale.accept({ active: 'custom', resolved: 'de', revision: 6 }), false);
  assert.equal(locale.accept({ active: 'pt', resolved: 'pt', revision: 5 }), false);
});

test('Cordis 后台设置服务刷新语言且插件卸载释放订阅', async () => {
  const ctx = new Context(); let state = { ns: 'locale', revision: 1, value: { preference: 'es' } };
  ctx.provide('settings', { describe: () => [state] });
  const controller = { locale: new HostLocale(() => {}) };
  const fiber = attachHostLocale(ctx, controller); await fiber;
  assert.equal(controller.locale.locale, 'es');
  state = { ...state, revision: 2, value: { preference: 'ru' } };
  ctx.emit('settings/document-updated', 'locale', 2); await Promise.resolve();
  assert.equal(controller.locale.locale, 'ru');
  await fiber.dispose(); assert.equal(controller.locale.read, undefined);
  state = { ...state, revision: 3, value: { preference: 'zh' } };
  ctx.emit('settings/document-updated', 'locale', 3); await Promise.resolve();
  assert.equal(controller.locale.locale, 'ru'); await ctx.fiber.dispose();
});

test('发布元数据使用中文或英文 README，8 种语言均可从包导出', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(packageJson.exports['./locale/*.json'], './locale/*.json');
  assert.ok(packageJson.files.includes('locale'));
  for (const language of LOCALES) {
    const { meta } = JSON.parse(await readFile(`locale/${language}.json`, 'utf8'));
    assert.equal(meta.title, dictionaries[language]['app.plugin']);
    assert.equal(meta.detail, language === 'zh' ? 'README.zh.md' : 'README.md');
    assert.ok((await readFile(meta.detail, 'utf8')).includes(meta.description));
  }
});
