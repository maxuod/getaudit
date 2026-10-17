import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { displayQuestionSetLabel } from '../../apps/console/question-set-labels.ts';
import { LanguageSwitch, setUiLanguage, uiLanguageStorageKey, useUiLanguage } from '../../apps/console/i18n.tsx';

afterEach(() => { vi.unstubAllGlobals(); setUiLanguage('en'); });

describe('generated question-set display labels', () => {
  it.each(['本地采集问题 · 2026-10-06', 'Locally collected questions · 2026-10-06'])('adapts the local generated template %s in both UI languages', original => {
    expect(displayQuestionSetLabel(original, 'en')).toBe('Locally collected questions · 2026-10-06');
    expect(displayQuestionSetLabel(original, 'zh-CN')).toBe('本地采集问题 · 2026-10-06');
  });

  it('adapts the GSC-generated template and preserves its date', () => {
    expect(displayQuestionSetLabel('GSC candidate questions · 2026-10-06', 'en')).toBe('GSC candidate questions · 2026-10-06');
    expect(displayQuestionSetLabel('GSC candidate questions · 2026-10-06', 'zh-CN')).toBe('GSC 候选问题 · 2026-10-06');
  });

  it.each([
    '客户自己的问题名称',
    'Locally collected questions · 2026-10-06 — client revision',
    'Audit 本地采集问题 · 2026-10-06',
    '本地采集问题 · 2026-02-30',
    'Locally collected questions · 2026-13-01',
    'GSC candidate questions · 2026-2-03',
    'Locally collected questions · 2025-02-29',
    '',
  ])('leaves a custom name or invalid generated date untouched: %s', original => {
    expect(displayQuestionSetLabel(original, 'en')).toBe(original);
    expect(displayQuestionSetLabel(original, 'zh-CN')).toBe(original);
  });

  it('accepts a real leap day and does not mutate saved identifiers or evidence', () => {
    const saved = Object.freeze({ id: 'frozen-set-id', label: '本地采集问题 · 2024-02-29', hash: 'original-frozen-hash', locale: 'fr-CA', source: 'Original source 原始证据' });
    const before = JSON.stringify(saved);
    expect(displayQuestionSetLabel(saved.label, 'en')).toBe('Locally collected questions · 2024-02-29');
    expect(JSON.stringify(saved)).toBe(before);
  });

  it('switches a selected generated name in place while retaining its ID, original title and custom names', async () => {
    const { window, document } = parseHTML('<html><head></head><body><main id="root"></main></body></html>');
    const values = new Map<string, string>();
    vi.stubGlobal('window', window); vi.stubGlobal('document', document);
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setUiLanguage('en');
    const rows = Object.freeze([
      Object.freeze({ id: 'saved-set', label: '本地采集问题 · 2026-10-06' }),
      Object.freeze({ id: 'custom-set', label: '客户名称 그대로 — Original' }),
    ]);
    const before = JSON.stringify(rows);
    function Picker() {
      const language = useUiLanguage();
      const [selected, select] = useState('saved-set');
      return <><LanguageSwitch/><select data-picker value={selected} onChange={event => select(event.target.value)}>{rows.map(row => <option key={row.id} value={row.id} title={row.label}>{displayQuestionSetLabel(row.label, language)}</option>)}</select><input defaultValue="Draft 原文"/></>;
    }
    const root = createRoot(document.getElementById('root')! as unknown as HTMLElement);
    try {
      await act(async () => root.render(<Picker/>));
      const picker = document.querySelector('select')!;
      const originalOption = picker.querySelector('option')!;
      const input = document.querySelector('input')!;
      expect(originalOption.textContent).toBe('Locally collected questions · 2026-10-06');
      expect((picker as unknown as HTMLSelectElement).value).toBe('saved-set');
      for (const language of ['zh-CN', 'en'] as const) {
        await act(async () => document.querySelector('.language-switch')!.dispatchEvent(new window.Event('click', { bubbles: true })));
        expect(document.querySelector('select')).toBe(picker);
        expect(picker.querySelector('option')).toBe(originalOption);
        expect(originalOption.textContent).toBe(language === 'en' ? 'Locally collected questions · 2026-10-06' : '本地采集问题 · 2026-10-06');
        expect(originalOption.getAttribute('title')).toBe(rows[0].label);
        expect((picker as unknown as HTMLSelectElement).value).toBe('saved-set');
        expect(document.querySelector('input')).toBe(input);
        expect(values.get(uiLanguageStorageKey)).toBe(language);
      }
      expect(picker.querySelectorAll('option')[1].textContent).toBe(rows[1].label);
      expect(JSON.stringify(rows)).toBe(before);
    } finally { await act(async () => root.unmount()); }
  });
});
