import { createContext, useContext, useSyncExternalStore } from 'react';
import { fallbackLocale } from './locale.mjs';
export const LocaleContext = createContext(fallbackLocale);
export function useLocale(provided) {
  const context = useContext(LocaleContext);
  const locale = provided ?? context;
  useSyncExternalStore(locale.subscribe, locale.read, locale.read);
  return locale;
}
