/** Authored interface copy only. Evidence, collection locales and identifiers are never translated. */
import { reportEn as en } from './locales/report-en.ts';
import { reportZhCN as zh } from './locales/report-zh-CN.ts';
export type ReportLocale = 'en' | 'zh-CN';
export const reportLocale = (locale: unknown): ReportLocale => locale === 'zh-CN' ? 'zh-CN' : 'en';
export const reportCopies = { en, 'zh-CN': zh };
export const reportCopy = (locale: unknown = 'en') => reportCopies[reportLocale(locale)];
export type ReportCopyKey = keyof typeof en;
