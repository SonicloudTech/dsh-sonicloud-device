import zh from './locales/zh.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };
import ja from './locales/ja.json' with { type: 'json' };
import es from './locales/es.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };
import de from './locales/de.json' with { type: 'json' };
import ru from './locales/ru.json' with { type: 'json' };
import pt from './locales/pt.json' with { type: 'json' };

export const NAMESPACE = 'sonicloud.device';
export const dictionaries = { zh, en, ja, es, fr, de, ru, pt };
export const LOCALES = Object.keys(dictionaries);
const PREFIX = 'sonicloud:';
// 消息在进程、Remote 和状态缓存中保留语义键，到展示时才翻译。
export function message(key, params = {}) { return PREFIX + JSON.stringify({ key, params }); }
export function decodeMessage(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return undefined;
  try {
    const data = JSON.parse(value.slice(PREFIX.length));
    return data && typeof data.key === 'string' && data.params && typeof data.params === 'object' && !Array.isArray(data.params) ? data : undefined;
  } catch { return undefined; }
}
export function resolveLocale(active, locales = []) {
  const seen = new Set();
  while (typeof active === 'string' && !seen.has(active.toLowerCase())) {
    const key = active.toLowerCase();
    if (Object.hasOwn(dictionaries, key)) return key;
    seen.add(key);
    active = locales.find(item => item.id.toLowerCase() === key)?.fallback;
  }
  return 'en';
}
export function translate(locale, key, params = {}) {
  const dict = dictionaries[resolveLocale(locale)];
  const template = Object.hasOwn(dict, key) ? dict[key] : Object.hasOwn(en, key) ? en[key] : dict['error.generic'];
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}
export function renderMessage(value, t = (key, params) => translate('en', key, params), depth = 0) {
  if (!value) return '';
  const data = decodeMessage(value);
  if (!data || depth > 4) return t('error.generic');
  const params = Object.fromEntries(Object.entries(data.params).map(([key, val]) => [key,
    decodeMessage(val) ? renderMessage(val, t, depth + 1) : typeof val === 'string' || typeof val === 'number' ? val : '']));
  return t(data.key, params);
}
export const safeMessage = (value, fallback = 'error.generic') => decodeMessage(value) ? value : message(fallback);
export function nativeDictionary(locale) { return { ...en, ...dictionaries[resolveLocale(locale)] }; }
