import { REC_LANG_LIST } from '../shared/languages.mjs';

// 来源：https://open.sinicloud.com/documents/webapi/stream-asr
// 显式映射完整三元组；不把方言、混合语种或简繁体折叠为中文默认值。
// 2026-11-04 实测：普通话繁体使用 100；控制台标注的 99 仍输出简体。
const foreign = {
  en_us: 1, ja_jp: 2, ko_kr: 3, 'ru-ru': 5, ar_il: 6,
  es_es: 7, it_IT: 8, vi_VN: 9, fr_fr: 10, de_DE: 11,
  pt_PT: 12, tr_TR: 13, pl_pl: 14, nl_NL: 16, sv_SE: 17,
  id_ID: 18, hi_in: 19, fi_fi: 20, he_il: 21, el_GR: 23,
  ms_MY: 24, cs_CZ: 25, da_DK: 27, th_TH: 31, fa_IR: 42,
  km_KH: 65, uz_UZ: 79,
};
const dialects = {
  mandarin: 0, cantonese: 4, minnanese: 101, lmz: 102,
  henannese: 105, shanxinese: 106, dongbeiese: 107, tianjinese: 108,
  gansunese: 109, guizhounese: 110, yunnanese: 111, ningxianese: 114,
  shandongnese: 116, shanghainese: 119, hebeinese: 122,
};
export const DEFAULT_LANGUAGES = REC_LANG_LIST.flatMap(({ language, accent, rlang }) => {
  let lanid;
  if (language === 'zh_cn') {
    if (rlang === 'zh-hk' && accent === 'mandarin') lanid = 100;
    else if (rlang === '') lanid = dialects[accent];
  } else if (accent === 'mandarin' && rlang === '') lanid = foreign[language];
  if (lanid === undefined) return [];
  return [{ language, accent, rlang, query: { lid: '0', lanid: String(lanid), role: '0' } }];
});
