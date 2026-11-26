import { LOCALES, resolveLocale } from '../shared/i18n.mjs';

// Host 配置 revision 是跨窗口的权威顺序；客户端 locale revision 仅在单个窗口有效。
export class HostLocale {
  constructor(apply) { this.apply = apply; this.locale = 'en'; this.revision = undefined; this.automatic = undefined; }
  attach(read) { this.read = read; this.refresh(); }
  refresh() {
    const state = this.read?.();
    if (!state || !Number.isInteger(state.revision)) return undefined;
    if (state.revision !== this.revision) {
      this.revision = state.revision;
      this.automatic = undefined;
      this.preference = typeof state.value?.preference === 'string' ? state.value.preference : undefined;
      if (this.preference) this.set(resolveLocale(this.preference));
    }
    return state;
  }
  set(locale) {
    if (locale === this.locale) return;
    this.locale = locale; this.apply(locale);
  }
  accept({ active, resolved, revision }) {
    const state = this.refresh();
    if (!state || revision !== state.revision || !LOCALES.includes(resolved)) return false;
    if (LOCALES.includes(active.toLowerCase()) && resolved !== active.toLowerCase()) return false;
    if (this.preference) {
      if (active.toLowerCase() !== this.preference.toLowerCase()) return false;
    } else {
      if (this.automatic && this.automatic !== `${active}:${resolved}`) return false;
      this.automatic = `${active}:${resolved}`;
    }
    this.set(resolved); return true;
  }
}
export function attachHostLocale(ctx, controller) {
  return ctx.inject(['settings'], scope => {
    const sync = () => controller.locale.refresh();
    controller.locale.attach(() => scope.settings.describe().find(item => item.ns === 'locale'));
    scope.on('settings/document-updated', ns => { if (ns === 'locale') queueMicrotask(sync); });
    scope.effect(() => () => { controller.locale.read = undefined; });
  });
}
