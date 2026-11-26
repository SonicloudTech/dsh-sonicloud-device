const actions = { enter: 'keys.enter', backspace: 'keys.backspace', translate: 'voice.translate', voice_input: 'voice.input', speechSearch: 'voice.search', openWebUrl: 'keys.link' };
export const actionOptions = (options, t) => options.map(item => ({ ...item, label: t(actions[item.value]) }));
const dialects = { dongbeiese: 'Dongbei', gansunese: 'Gansu', cantonese: 'Cantonese', guizhounese: 'Guizhou', hebeinese: 'Hebei', henannese: 'Henan', minnanese: 'Minnan', ningxianese: 'Ningxia', shandongnese: 'Shandong', shanxinese: 'Shaanxi', shanghainese: 'Shanghai', lmz: 'Sichuan', tianjinese: 'Tianjin', yunnanese: 'Yunnan' };
export function languageLabel(item, locale) {
  if (locale.language === 'zh') return item.label;
  if (item.language === 'zh_cn') {
    if (item.accent === 'mandarin') return locale.t(item.rlang ? 'language.traditional' : 'language.mandarin');
    return locale.t('language.dialect', { name: dialects[item.accent] ?? item.accent }) + ` (${item.label})`;
  }
  if (item.value === 'cn') return new Intl.DisplayNames([locale.language], { type: 'language' }).of('zh');
  return item.label;
}
