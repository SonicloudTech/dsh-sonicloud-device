import { BUILTIN_ASR } from '../asr/config.mjs';
import { TRANS_FROM_LANG_LIST, TRANS_TO_LANG_LIST } from '../shared/languages.mjs';

export const TRANSLATE_URL = BUILTIN_ASR.translateUrl;

export async function translateText({ text, from, to, signal, getToken, userId, config = {}, fetchImpl = globalThis.fetch, url = TRANSLATE_URL }) {
  signal.throwIfAborted();
  if (typeof text !== 'string' || !text.trim()) throw new Error('没有可翻译的文本');
  if ([...text].length > 5000) throw new Error('翻译文本超过 5000 字符，可复制原文');
  if (!TRANS_FROM_LANG_LIST.some(item => item.value === from) || !TRANS_TO_LANG_LIST.some(item => item.value === to)) throw new Error('翻译语言无效，请重新选择');
  const payload = { text, from: from === 'cn' ? 'zh' : from, to: to === 'cn' ? 'zh' : to };
  if (payload.from === payload.to) throw new Error('翻译源语言与目标语言不能相同');
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(signal);
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 15000)]);
    let response, body;
    try {
      response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-SC-Authorization': token, 'X-SC-User-Id': userId },
        body: JSON.stringify(payload),
      });
      body = await response.json();
      requestSignal.throwIfAborted();
    } catch {
      signal.throwIfAborted();
      throw new Error('翻译请求失败或响应无效，可复制原文后重试');
    }
    if (String(body?.code) === '1004') {
      getToken.invalidate(token);
      if (attempt === 0) continue;
      throw new Error('翻译认证失败，请稍后重试');
    }
    if (!response.ok || body?.code !== 0) {
      const messages = { 1001: '翻译参数错误', 1003: '翻译额度不足', 1005: '翻译请求过于频繁',
        1006: '翻译应用不可用', 1007: '翻译应用已下线', 3005: '翻译请求超时' };
      throw new Error((messages[body?.code] ?? '翻译服务调用失败') + '，可复制原文后重试');
    }
    const result = body.data?.resultText;
    if (typeof result !== 'string' || !result.trim() || result.length > 65536) throw new Error('翻译未返回有效译文，可复制原文后重试');
    signal.throwIfAborted(); return result;
  }
}
