import { NAMESPACE, dictionaries, resolveLocale, translate, renderMessage } from '../shared/i18n.mjs';

export class ClientLocale {
  constructor(host, form) {
    this.host = host;
    this.form = form;
    this.read = () => host.getSnapshot();
    this.subscribe = listener => host.subscribe(listener);
    this.bound = host.bind(NAMESPACE);
  }
  get language() { const state = this.read(); return resolveLocale(state.active, state.locales); }
  t = (key, params = {}) => {
    if (!Object.hasOwn(dictionaries.en, key)) return translate(this.language, 'error.generic');
    const value = this.bound(key, params);
    return typeof value === 'string' && value !== key && value ? value : translate(this.language, key, params);
  };
  text = value => renderMessage(value, this.t);
  count = count => this.t(`device.count.${new Intl.PluralRules(this.language).select(count)}`, { count });
  // 只提交已经从 Host 读取成功的配置版本，后台再次核对，拒绝初始化临时值。
  sync = async api => {
    const state = this.read(), accepted = this.form?.getSnapshot();
    if (accepted?.status !== 'ready' || !Number.isInteger(accepted.revision)) return;
    if (accepted.value?.preference && accepted.value.preference.toLowerCase() !== state.active.toLowerCase()) return;
    await api.syncLocale({ active: state.active, resolved: this.language, revision: accepted.revision });
  };
}
export const fallbackLocale = {
  subscribe: () => () => {}, read: () => 'en', language: 'en',
  t: (key, params) => translate('en', key, params),
  text: value => renderMessage(value),
  count: count => translate('en', `device.count.${count === 1 ? 'one' : 'other'}`, { count }),
};
export function registerLocale(ctx) {
  ctx.effect(() => ctx.locale.register(NAMESPACE, dictionaries));
  return new ClientLocale(ctx.locale, ctx.configForms.get('locale'));
}
