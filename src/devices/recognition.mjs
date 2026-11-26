import { message as msg } from '../shared/i18n.mjs';
import { sourceRecognitionLanguage, languageKey, REC_LANG_LIST, TRANS_FROM_LANG_LIST, TRANS_TO_LANG_LIST } from '../shared/devices.mjs';
import { DEFAULT_LANGUAGES } from '../asr/languages.mjs';
export { DEFAULT_LANGUAGES };
export function recognitionQuery(preferences, action, mappings = DEFAULT_LANGUAGES) {
  let selected = preferences.recognition;
  if (action === 'translate') {
    if (!TRANS_FROM_LANG_LIST.some(item => item.value === preferences.from) || !TRANS_TO_LANG_LIST.some(item => item.value === preferences.to)) {
      throw new Error(msg('error.language'));
    }
    selected = sourceRecognitionLanguage(preferences.from);
  }
  if (!selected || !REC_LANG_LIST.some(item => languageKey(item) === languageKey(selected))) throw new Error(msg('error.language'));
  const mapping = selected && mappings.find(item => languageKey(item) === languageKey(selected));
  if (!mapping?.query) throw new Error(msg('error.language'));
  const query = {};
  for (const [key, value] of Object.entries(mapping.query)) {
    if (!['lid', 'lanid', 'role', 'language', 'accent', 'rlang'].includes(key) || !['string', 'number'].includes(typeof value)) throw new Error(msg('error.language'));
    query[key] = String(value);
  }
  return query;
}
export const formatTranscript = (text, preferences, action) => action !== 'translate' && !preferences.punctuation
  ? text.replace(/\p{P}/gu, '') : text;
