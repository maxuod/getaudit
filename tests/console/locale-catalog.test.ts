import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { en, type MessageKey } from '../../apps/console/locales/en.ts';
import { zhCN } from '../../apps/console/locales/zh-CN.ts';
import { formatTemplate, translateAuthoredMessage, translateMessage, type MessageLanguage } from '../../apps/console/locales/format.ts';

describe('English-source Console messages', () => {
  it('keeps every English message covered by Chinese with the same named values', () => {
    const parameters = (message: string) => [...new Set([...message.matchAll(/\{(\w+)(?::[^{}]*\|[^{}]*)?\}/g)].map(match => match[1]))].sort();
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(en[key], key).not.toMatch(/[\u3400-\u9fff]/);
      expect(parameters(zhCN[key]), key).toEqual(parameters(en[key]));
    }
  });

  it('uses the English source for an unsupported or missing runtime locale', () => {
    for (const language of ['fr', '', undefined] as unknown as MessageLanguage[]) {
      expect(translateMessage(language, 'common.saveChanges')).toBe(en['common.saveChanges']);
    }
  });

  it('falls back to English if a Chinese resource is unexpectedly absent', () => {
    const messages = zhCN as Partial<Record<MessageKey, string>>;
    const previous = messages['common.saveChanges'];
    try {
      delete messages['common.saveChanges'];
      expect(translateMessage('zh-CN', 'common.saveChanges')).toBe(en['common.saveChanges']);
    } finally {
      messages['common.saveChanges'] = previous;
    }
  });

  it('keeps complete count sentences grammatical without moving their values into components', () => {
    const sentence = 'Keep {count:question|questions} with {platformCount:platform|platforms} in this plan.';
    expect(formatTemplate(sentence, { count: 1, platformCount: 1 })).toBe('Keep 1 question with 1 platform in this plan.');
    expect(formatTemplate(sentence, { count: 2, platformCount: 3 })).toBe('Keep 2 questions with 3 platforms in this plan.');
    expect(formatTemplate(sentence, { count: 0, platformCount: 2 })).toBe('Keep 0 questions with 2 platforms in this plan.');
    expect(formatTemplate('保留 {count} 个问题和 {platformCount} 个平台。', { count: 1, platformCount: 3 })).toBe('保留 1 个问题和 3 个平台。');
  });

  it('allows translated sentences to reorder named values and preserves their literal contents', () => {
    const values = Object.freeze({ projectName: 'Original project 原文 $&', sourceUrl: 'https://client.example/路径?q={source}&hash=$1' });
    const before = JSON.stringify(values);
    expect(formatTemplate('{projectName}: open {sourceUrl}.', values)).toBe('Original project 原文 $&: open https://client.example/路径?q={source}&hash=$1.');
    expect(formatTemplate('打开 {sourceUrl}，查看 {projectName}。', values)).toBe('打开 https://client.example/路径?q={source}&hash=$1，查看 Original project 原文 $&。');
    expect(JSON.stringify(values)).toBe(before);
  });

  it('re-renders known saved feedback without registering each new parameter combination', () => {
    const key = 'sources.rowCountPagesPagePageNumberPageCount';
    const values = { rowCount: 17, pageNumber: 2, pageCount: 4 };
    const english = translateMessage('en', key, values);
    const chinese = translateMessage('zh-CN', key, values);
    expect(translateAuthoredMessage(english, 'zh-CN')).toBe(chinese);
    expect(translateAuthoredMessage(chinese, 'en')).toBe(english);
    expect(translateAuthoredMessage('Original source excerpt: 原文 stays exactly here. frozen-hash-123', 'zh-CN')).toBeUndefined();
  });
});


describe('native known ledger diagnostic', () => {
  it('adapts only the known error and preserves unknown diagnostic wording', async () => {
    const require=createRequire(import.meta.url);
    const english=require('../../desktop/locales/en.cjs') as Record<string,string>;
    const chinese=require('../../desktop/locales/zh-CN.cjs') as Record<string,string>;
    expect(english.invalidLedger).toBe('This file is not a getaudit ledger.');
    expect(chinese.invalidLedger).toBe('此文件不是 getaudit 台账。');
    const source=readFileSync(new URL('../../desktop/main.cjs',import.meta.url),'utf8');
    const action=source.slice(source.indexOf('async function safeAction(action) {'),source.indexOf('async function exportBackup() {'));
    for (const catalog of [english,chinese]) {
      const shown:string[][]=[];
      const safeAction=new Function('dialog','nt','nativeEnglish',action+';return safeAction;')({showErrorBox:(...values:string[])=>shown.push(values)},(key:string)=>catalog[key],english) as (run:()=>Promise<void>)=>Promise<void>;
      await safeAction(async()=>{throw new Error(english.invalidLedger);});
      const original='Original diagnostic 原始信息 · unchanged';
      await safeAction(async()=>{throw new Error(original);});
      expect(shown).toEqual([[catalog.theActionCouldNotBeCompleted,catalog.invalidLedger],[catalog.theActionCouldNotBeCompleted,original]]);
    }
  });
});
