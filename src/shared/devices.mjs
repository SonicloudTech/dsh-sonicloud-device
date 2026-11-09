import { z } from 'zod';
import { REC_LANG_LIST, TRANS_FROM_LANG_LIST, TRANS_TO_LANG_LIST } from './languages.mjs';
import { DPI_LIST, M_KEY_FUNC_LIST, M_KEY_SEARCH_URL_LIST } from './mouse-settings.mjs';
export { REC_LANG_LIST, TRANS_FROM_LANG_LIST, TRANS_TO_LANG_LIST, DPI_LIST, M_KEY_FUNC_LIST, M_KEY_SEARCH_URL_LIST };
export const languageKey = ({ language, accent, rlang }) => JSON.stringify([language, accent, rlang]);
const choice = list => z.string().refine(value => list.some(item => item.value === value), '选项不存在');
const recognitionValueSchema = z.object({ language: z.string(), accent: z.string(), rlang: z.string() }).strict();
export const recognitionSchema = recognitionValueSchema
  .refine(value => REC_LANG_LIST.some(item => languageKey(item) === languageKey(value)), '识别语言不存在');
export function webUrl(value) {
  let text = value.trim();
  const hasProtocol = /^https?:\/\//i.test(text);
  if (!hasProtocol) {
    // A host followed by a numeric port is not a URI scheme. The prefix is for parsing only.
    if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^:/?#]+:\d+(?:[/?#]|$)/u.test(text)) {
      throw new Error('请填写有效的 HTTP/HTTPS 网址');
    }
    if (/^https?:/i.test(text)) throw new Error('请填写有效的网址');
    text = `https://${text}`;
  }
  if (!/^https?:\/\/[^/\\\s]/i.test(text) || value.trim().length > 4096) throw new Error('请填写有效的网址（最多 4096 字符）');
  let url;
  try { url = new URL(text); } catch { throw new Error('请填写完整 HTTP/HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\\\u0000-\u0020\u007f]/u.test(text)) {
    throw new Error('请填写不含凭据和空白字符的 HTTP/HTTPS 地址');
  }
  if (!hasProtocol && !url.hostname.includes('.') && !url.hostname.startsWith('[') && url.hostname !== 'localhost') {
    throw new Error('请填写有效的域名或 IP 地址');
  }
  if (!url.hostname.startsWith('[') && url.hostname.replace(/\.$/, '').split('.').some(label => !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) {
    throw new Error('请填写有效的域名或 IP 地址');
  }
  return value.trim();
}
export const preferencesSchema = z.object({
  recognition: recognitionSchema, punctuation: z.boolean(),
  from: choice(TRANS_FROM_LANG_LIST), to: choice(TRANS_TO_LANG_LIST),
  dpi: choice(DPI_LIST), mAction: choice(M_KEY_FUNC_LIST),
  searchUrl: choice(M_KEY_SEARCH_URL_LIST), linkUrl: z.string().max(4096),
  speechAction: z.enum(['voice_input', 'translate']), aiAction: z.literal('openAi'), aiAutoSend: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.linkUrl || value.mAction === 'openWebUrl') {
    try { webUrl(value.linkUrl); } catch (error) { ctx.addIssue({ code: 'custom', path: ['linkUrl'], message: error.message }); }
  }
});
// 读取旧语言值供用户重新选择；已移除的 M 键动作回退默认值，写入仍严格校验。
export const storedPreferencesSchema = preferencesSchema.safeExtend({
  recognition: recognitionValueSchema, from: z.string(), to: z.string(),
  mAction: choice(M_KEY_FUNC_LIST).catch(() => defaultPreferences().mAction),
  aiAutoSend: z.boolean().default(true),
});
export const defaultPreferences = () => ({
  recognition: { language: 'zh_cn', accent: 'mandarin', rlang: '' }, punctuation: true,
  from: 'cn', to: 'en', dpi: '1600', mAction: 'enter',
  searchUrl: M_KEY_SEARCH_URL_LIST[0].value, linkUrl: '', speechAction: 'voice_input', aiAction: 'openAi', aiAutoSend: true,
});
export const snSchema = z.string().min(1).max(128).refine(value =>
  !/^(usb-|ble-)/i.test(value) && !/[\u0000-\u0020]/u.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value), '设备 SN 未确认');
export const isStableSn = value => snSchema.safeParse(value).success;
export function searchAddress(prefix, text) {
  if (!M_KEY_SEARCH_URL_LIST.some(item => item.value === prefix)) throw new Error('搜索引擎不存在');
  if (!text.trim()) throw new Error('未识别到语音');
  return prefix + encodeURIComponent(text.trim());
}

export function sourceRecognitionLanguage(from) {
  const locale = TRANS_FROM_LANG_LIST.find(item => item.value === from)?.locale;
  return REC_LANG_LIST.find(item => item.language === locale && item.accent === 'mandarin' && item.rlang === '');
}
