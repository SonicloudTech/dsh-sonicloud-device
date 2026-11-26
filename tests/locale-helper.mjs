import { dictionaries, resolveLocale, translate } from '../src/shared/i18n.mjs';

// 模拟 Harness 的稳定快照、命名空间注册和配置加载阶段。
export function hostLocale(active = 'zh') {
  const listeners = new Set(), formListeners = new Set(), registered = new Map();
  let state = { active, locales: Object.keys(dictionaries).map(id => ({ id })), revision: 0 };
  let config = { status: 'ready', revision: 1, value: { preference: active } };
  const host = {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    register: (namespace, data) => { registered.set(namespace, data); return () => registered.delete(namespace); },
    bind: namespace => (key, params) => registered.has(namespace) ? translate(resolveLocale(state.active, state.locales), key, params) : key,
    update: patch => { state = { ...state, ...patch, revision: state.revision + 1 }; for (const fn of listeners) fn(); },
  };
  const form = {
    getSnapshot: () => config,
    subscribe: listener => { formListeners.add(listener); return () => formListeners.delete(listener); },
    update: patch => { config = { ...config, ...patch }; for (const fn of formListeners) fn(); },
  };
  return { host, form, registered, listeners, formListeners };
}
