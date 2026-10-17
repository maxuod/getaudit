import React, { useEffect, useSyncExternalStore } from 'react';
import { Languages } from 'lucide-react';
import { coreMessages, formatCoreMessage } from './core-messages.ts';
import { samplingMessagePairs, samplingMessage } from './sampling-messages.ts';
import { searchMessages, formatSearchMessage } from './search-messages.ts';
import { en, type MessageKey } from './locales/en.ts';
import { translateAuthoredMessage, translateMessage, type TranslationArguments } from './locales/format.ts';

export type { MessageKey } from './locales/en.ts';
export type { MessageParameters, SimpleMessageKey } from './locales/format.ts';

export type UiLanguage = 'en' | 'zh-CN';
export const uiLanguageStorageKey = 'getgeo.ui.language';
const supported = (value: unknown): UiLanguage => value === 'zh-CN' ? 'zh-CN' : 'en';
const listeners = new Set<() => void>();
const messages = new Map<string, readonly [string, string]>();
let language: UiLanguage = 'en';
try { if (typeof window !== 'undefined') language = supported(window.localStorage.getItem(uiLanguageStorageKey)); } catch { /* Switching remains available when preference storage is disabled. */ }

/** Only authored interface messages belong here. Evidence and collection locales never do. */
export function registerUiMessages(pairs: ReadonlyArray<readonly [string, string]>) {
  for (const pair of pairs) { messages.set(pair[0], pair); messages.set(pair[1], pair); }
}

export function t<Key extends MessageKey>(key: Key, ...args: TranslationArguments<Key>): string;
/** @deprecated Console text belongs in the English source catalog. Kept for external diagnostic adapters. */
export function t(english: string, chinese: string): string;
export function t(key: string, parameters?: Record<string, string | number | boolean | null | undefined> | string): string {
  if (Object.hasOwn(en, key)) return (translateMessage as (locale: UiLanguage, id: MessageKey, parameters?: object) => string)(language, key as MessageKey, typeof parameters === 'object' ? parameters : undefined);
  if (typeof parameters === 'string') {
    registerUiMessages([[key, parameters]]);
    return language === 'zh-CN' ? parameters : key;
  }
  return key;
}

/** Re-render saved interface feedback in the current language; unknown diagnostics retain their source text. */
export function uiMessage(message: string | null | undefined): string {
  if (!message) return '';
  const pair = messages.get(message);
  return pair ? pair[language === 'zh-CN' ? 1 : 0] : translateAuthoredMessage(message, language) ?? formatCoreMessage(message, language) ?? formatSearchMessage(message, language) ?? samplingMessage(message, language);
}

export const getUiLanguage = (): UiLanguage => language;
function applyDocumentLanguage() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.title = t('language.getgeoWorkspace');
}
export function setUiLanguage(next: UiLanguage) {
  const selected = supported(next);
  if (selected === language) { applyDocumentLanguage(); return; }
  language = selected;
  try { if (typeof window !== 'undefined') window.localStorage.setItem(uiLanguageStorageKey, language); } catch { /* In-memory preference still works. */ }
  applyDocumentLanguage();
  for (const notify of listeners) notify();
}
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };
export function useUiLanguage(): UiLanguage {
  const current = useSyncExternalStore(subscribe, getUiLanguage, getUiLanguage);
  useEffect(applyDocumentLanguage, [current]);
  return current;
}
export function LanguageSwitch() {
  const current = useUiLanguage();
  const target = current === 'en' ? 'zh-CN' : 'en';
  const action = t('language.switchToSimplifiedChinese');
  return <button type="button" className="language-switch" onClick={() => setUiLanguage(target)} aria-label={action} title={action}>
    <Languages size={16} aria-hidden="true" />
    <span lang={target} aria-hidden="true">{target === 'en' ? 'EN' : '中'}</span>
  </button>;
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== uiLanguageStorageKey && event.key !== null) return;
    const next = supported(event.newValue);
    if (next === language) return;
    language = next; applyDocumentLanguage(); for (const notify of listeners) notify();
  });
  applyDocumentLanguage();
}
registerUiMessages(coreMessages);
registerUiMessages(samplingMessagePairs);
registerUiMessages(searchMessages);
