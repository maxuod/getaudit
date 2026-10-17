import { en, type MessageKey } from './en.ts';
import { zhCN } from './zh-CN.ts';

export type MessageLanguage = 'en' | 'zh-CN';
export type MessageValue = string | number | boolean | null | undefined;
type ParameterName<Part extends string> = Part extends `${infer Name}:${string}` ? Name : Part;
type ParametersIn<Text extends string> = Text extends `${string}{${infer Part}}${infer Rest}` ? ParameterName<Part> | ParametersIn<Rest> : never;
export type MessageParameters<Key extends MessageKey> = { [Name in ParametersIn<(typeof en)[Key]>]: MessageValue };
export type SimpleMessageKey = { [Key in MessageKey]: [ParametersIn<(typeof en)[Key]>] extends [never] ? Key : never }[MessageKey];
export type TranslationArguments<Key extends MessageKey> = [ParametersIn<(typeof en)[Key]>] extends [never] ? [] : [parameters: MessageParameters<Key>];

const token = /\{(\w+)(?::([^{}|]*)\|([^{}]*))?\}/g;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Count-unit syntax: {count:question|questions}. Other tokens interpolate verbatim. */
export function formatTemplate(template: string, parameters: Record<string, MessageValue> = {}): string {
  return template.replace(token, (original, name: string, singular?: string, plural?: string) => {
    if (!Object.hasOwn(parameters, name)) return original;
    const value = String(parameters[name]);
    return singular === undefined ? value : `${value} ${Number(parameters[name]) === 1 ? singular : plural}`;
  });
}

/** All authored interface text starts at a stable English message ID. */
export function translateMessage<Key extends MessageKey>(language: MessageLanguage, key: Key, ...args: TranslationArguments<Key>): string {
  const original = en[key];
  const template = language === 'zh-CN' ? zhCN[key] ?? original : original;
  return formatTemplate(template, args[0]);
}

const exact = new Map<string, MessageKey>();
const templates: { key: MessageKey; pattern: RegExp; parameters: string[] }[] = [];
for (const key of Object.keys(en) as MessageKey[]) {
  for (const template of [en[key], zhCN[key]]) {
    if (typeof template !== 'string') continue;
    const parameters: string[] = [];
    let pattern = '^', start = 0;
    for (const match of template.matchAll(token)) {
      pattern += escape(template.slice(start, match.index));
      parameters.push(match[1]);
      pattern += match[2] === undefined ? '([\\s\\S]*?)' : '(\\d+(?:\\.\\d+)?) (?:' + escape(match[2]) + '|' + escape(match[3]) + ')';
      start = match.index + match[0].length;
    }
    if (!parameters.length) exact.set(template, key);
    else templates.push({ key, pattern: new RegExp(pattern + escape(template.slice(start)) + '$'), parameters });
  }
}

/** For saved authored feedback only. Callers must render source material directly. */
export function translateAuthoredMessage(message: string, language: MessageLanguage): string | undefined {
  const key = exact.get(message);
  if (key) return formatTemplate(language === 'zh-CN' ? zhCN[key] ?? en[key] : en[key]);
  for (const entry of templates) {
    const match = message.match(entry.pattern);
    if (!match) continue;
    const parameters = Object.fromEntries(entry.parameters.map((name, index) => [name, match[index + 1]]));
    return formatTemplate(language === 'zh-CN' ? zhCN[entry.key] ?? en[entry.key] : en[entry.key], parameters);
  }
  return undefined;
}
