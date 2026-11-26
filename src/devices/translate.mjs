import { message as msg } from '../shared/i18n.mjs';
import { BUILTIN_ASR } from '../asr/config.mjs';
import { TRANS_FROM_LANG_LIST, TRANS_TO_LANG_LIST } from '../shared/languages.mjs';

export const TRANSLATE_URL = BUILTIN_ASR.translateUrl;

export async function translateText({ text, from, to, signal, getToken, userId, config = {}, fetchImpl = globalThis.fetch, url = TRANSLATE_URL }) {
  signal.throwIfAborted();
  if (typeof text !== 'string' || !text.trim()) throw new Error(msg('error.noSpeech'));
  if ([...text].length > 5000) throw new Error(msg('error.translationLength'));
  if (!TRANS_FROM_LANG_LIST.some(item => item.value === from) || !TRANS_TO_LANG_LIST.some(item => item.value === to)) throw new Error(msg('error.language'));
  const payload = { text, from: from === 'cn' ? 'zh' : from, to: to === 'cn' ? 'zh' : to };
  if (payload.from === payload.to) throw new Error(msg('error.sameLanguage'));
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
      throw new Error(msg('error.translation'));
    }
    if (String(body?.code) === '1004') {
      getToken.invalidate(token);
      if (attempt === 0) continue;
      throw new Error(msg('error.auth'));
    }
    if (!response.ok || body?.code !== 0) {
      const messages = { 1001: msg('error.translation'), 1003: msg('error.quota'), 1005: msg('error.busy'),
        1006: msg('error.translation'), 1007: msg('error.translation'), 3005: msg('error.timeout') };
      throw new Error(messages[body?.code] ?? msg('error.translation'));
    }
    const result = body.data?.resultText;
    if (typeof result !== 'string' || !result.trim() || result.length > 65536) throw new Error(msg('error.translation'));
    signal.throwIfAborted(); return result;
  }
}
