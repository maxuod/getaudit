import React, {act} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {KeywordHealthPanel, keywordHealthCsv, keywordHealthMarkdown, publicationRecords, type KeywordHealthPanelProps} from '../../apps/console/keyword-health-panel.tsx';
import {analyzeKeywordHealth} from '../../src/console/keyword-health.ts';
import type {GscEvidence, GscRow} from '../../src/console/gsc.ts';
import type {GscItem} from '../../src/console/gsc-workspace.ts';
import {setUiLanguage} from '../../apps/console/i18n.tsx';
import {downloadText} from '../../apps/console/download.ts';

vi.mock('../../apps/console/download.ts', () => ({downloadText: vi.fn()}));
const DAY = 86_400_000, property = 'sc-domain:sample-agency.example', owner = 'https://sample-agency.example/guide';
const date = (days: number) => new Date(Date.parse('2026-06-03') + days * DAY).toISOString().slice(0, 10);
const metric = (keys: string[], position: number): GscRow => ({keys, position, clicks: 0, impressions: 5, ctr: 0});
function fixture(): GscEvidence {
  const evidence: GscEvidence = {hash: 'preserved-source-hash', snapshot: {id: 'synthetic-health-snapshot', property, capturedAt: '2026-10-03T12:00:00Z', startDate: date(0), endDate: date(119), country: 'CAN', device: 'MOBILE', type: 'web', timeZone: 'America/Los_Angeles', dataState: 'final', source: 'Synthetic keyword health UI fixture', totals: null, queries: [], pages: [], queryDaily: [], queryPages: [], requests: [], raw: [], limitations: []}};
  for (const [keyword, position] of [['C++ tips 10% 原文', 35], ['restaurant scheduling software', 15], ['declining opportunity', 8]] as const) {
    evidence.snapshot.queries.push(metric([keyword], position));
    evidence.snapshot.queryPages!.push({...metric([keyword, owner], position), impressions: 600});
    for (let day = 0; day < 120; day++) evidence.snapshot.queryDaily!.push(metric([date(day), keyword], keyword === 'declining opportunity' && day >= 92 ? 15 : position));
  }
  return evidence;
}
function publication(extra: Partial<GscItem> = {}): GscItem {
  return {id: 'publication-one', property, kind: 'publication', payload: {url: owner, publishedAt: '2026-01-01', source: 'manual', sourceUrl: 'https://sample-agency.example/changes'}, created_at: '2026-10-01', updated_at: '2026-10-01', ...extra};
}
function props(extra: Partial<KeywordHealthPanelProps> = {}): KeywordHealthPanelProps {
  return {evidence: fixture(), items: [], connected: true, onReadHistory: vi.fn(async () => {}), onSavePublication: vi.fn(async () => {}), onOpenQuery: vi.fn(), onAudit: vi.fn(), ...extra};
}
async function mount(initial: KeywordHealthPanelProps) {
  const {window, document} = parseHTML('<html><body><main id="root"></main></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.getElementById('root')! as unknown as HTMLElement);
  const render = async (next: KeywordHealthPanelProps) => {await act(async () => root.render(React.createElement(KeywordHealthPanel, next)));};
  await render(initial);
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent?.includes(label));
    expect(button, label).toBeTruthy(); await act(async () => button!.dispatchEvent(new window.Event('click', {bubbles: true})));
  };
  return {root, window, document, render, click, close: async () => {await act(async () => root.unmount());}};
}
beforeEach(() => setUiLanguage('en'));
afterEach(() => {setUiLanguage('en'); vi.unstubAllGlobals(); vi.mocked(downloadText).mockClear();});

describe('keyword health evidence presentation', () => {
  it('shows a mature flat query with dated windows, source and a separate mapped URL scope', () => {
    const input = props(), before = JSON.stringify(input.evidence);
    const html = renderToStaticMarkup(React.createElement(KeywordHealthPanel, input));
    expect(html).toContain('Mature, little growth'); expect(html).toContain('C++ tips 10% 原文'); expect(html).toContain('35.0');
    expect(html).toContain('2026-09-03 to 2026-09-30'); expect(html).toContain('Synthetic keyword health UI fixture'); expect(html).toContain('preserved-source-hash');
    expect(html).toContain('does not establish that page’s ranking history'); expect(html).toContain('cannot identify the full set of keywords');
    expect(input.onReadHistory).not.toHaveBeenCalled(); expect(input.onSavePublication).not.toHaveBeenCalled(); expect(input.onAudit).not.toHaveBeenCalled(); expect(JSON.stringify(input.evidence)).toBe(before);
  });
  it('keeps a declining query discoverable among opportunities, with its decline diagnosis intact', async () => {
    const ui = await mount(props());
    try {
      await ui.click('Opportunity · 11–20');
      expect(ui.document.querySelectorAll('.health-query-row')).toHaveLength(2);
      const text = ui.document.querySelector('.health-table')!.textContent;
      expect(text).toContain('declining opportunity'); expect(text).toContain('Losing ground'); expect(text).toContain('restaurant scheduling software'); expect(text).not.toContain('C++ tips');
      expect(ui.document.querySelector('[aria-pressed="true"]')?.textContent).toBe('Opportunity · 11–202');
    } finally {await ui.close();}
  });
  it('shows low-data and full-period fallback warnings before detail expansion and avoids unsupported gain claims', () => {
    const evidence = fixture(); evidence.snapshot.queryDaily = undefined; evidence.snapshot.truncated = ['queryPages'];
    const html = renderToStaticMarkup(React.createElement(KeywordHealthPanel, props({evidence})));
    expect(html).toContain('displayed current metric covers the whole selected period'); expect(html).toContain('Low data volume limits the diagnosis');
    expect(html).toContain('URL mapping may be incomplete'); expect(html).toContain('No supported comparison'); expect(html).not.toContain('positions gained vs previous');
  });
  it('localizes authored diagnoses, limitations and exports while preserving source text, queries and dates', () => {
    setUiLanguage('zh-CN'); const evidence = fixture(), report = analyzeKeywordHealth(evidence, [{url: owner, publishedAt: '2026-01-01', source: 'manual'}]);
    const html = renderToStaticMarkup(React.createElement(KeywordHealthPanel, props({evidence})));
    expect(html).toContain('优先处理什么'); expect(html).toContain('长期停滞'); expect(html).toContain('不代表统计显著性');
    expect(html).not.toContain('Classification uses transparent'); expect(html).toContain('Synthetic keyword health UI fixture'); expect(html).toContain('C++ tips 10% 原文');
    const md = keywordHealthMarkdown(report), exported = keywordHealthCsv(report);
    expect(md).toContain('# getaudit 关键词诊断'); expect(md).toContain('不代表统计显著性'); expect(md).not.toContain('Classification uses transparent');
    expect(exported).toContain('用户声明'); expect(exported).toContain('preserved-source-hash'); expect(exported).toContain('C++ tips 10% 原文');
  });
  it('exports only the selected filter, including recorded source conditions and unaltered query text', async () => {
    const ui = await mount(props());
    try {
      await ui.click('Mature, little growth'); await ui.click('Export Markdown');
      expect(downloadText).toHaveBeenCalledOnce();
      const [name, content, type] = vi.mocked(downloadText).mock.calls[0]!;
      expect(name).toBe('getaudit-keyword-health-2026-09-30.md'); expect(type).toContain('markdown'); expect(content).toContain('C++ tips 10% 原文'); expect(content).not.toContain('## declining opportunity');
      expect(content).toContain('Market: CAN; Device: MOBILE; Search type: web'); expect(content).toContain('Synthetic keyword health UI fixture');
    } finally {await ui.close();}
  });
  it('guards spreadsheet exports against formula-like query text', () => {
    const report = analyzeKeywordHealth(fixture()); report.rows[0]!.keyword = '=CMD("unsafe")';
    expect(keywordHealthCsv(report)).toContain('"\'=CMD(""unsafe"")"');
  });
});

describe('keyword health actions and publication context', () => {
  it('expands the saved evidence inline; audit navigation is separate and never starts automatically', async () => {
    const input = props({onOpenQuery: undefined}), ui = await mount(input);
    try {
      await ui.click('Evidence & actions');
      expect(ui.document.querySelector('.health-detail')?.textContent).toContain('2026-06-03 to 2026-06-30');
      expect(ui.document.querySelector('.health-full-reason')?.textContent).toContain('after at least 90 days of observed history');
      expect(ui.document.querySelector('.health-detail')?.textContent).toContain('This is not a publication date'); expect(ui.document.querySelector('.health-query-open')).toBeNull();
      expect(ui.document.querySelectorAll('.health-audit-link')).toHaveLength(1); expect(ui.document.querySelector('.health-detail')?.textContent).not.toContain('Open five-keyword audit');
      expect(input.onAudit).not.toHaveBeenCalled(); await ui.click('Open five-keyword audit'); expect(input.onAudit).toHaveBeenCalledOnce();
    } finally {await ui.close();}
  });
  it('saves an explicit user-declared date only after form submission', async () => {
    const input = props({items: [publication()]}), ui = await mount(input);
    try {
      await ui.click('Evidence & actions'); expect(input.onSavePublication).not.toHaveBeenCalled();
      const form = ui.document.querySelector('.health-publication form')!;
      await act(async () => form.dispatchEvent(new ui.window.Event('submit', {bubbles: true, cancelable: true})));
      expect(input.onSavePublication).toHaveBeenCalledExactlyOnceWith({url: owner, publishedAt: '2026-01-01', source: 'manual', sourceUrl: 'https://sample-agency.example/changes'});
      expect(ui.document.body.textContent).toContain('saved as user-declared context');
      expect(input.onReadHistory).not.toHaveBeenCalled();
    } finally {await ui.close();}
  });
  it('disables publication writes and history reads when the displayed snapshot is stale', async () => {
    const evidence = fixture(); evidence.snapshot.queryDaily = undefined;
    const input = props({evidence, stale: true, items: [publication()]}), ui = await mount(input);
    try {
      await ui.click('Evidence & actions');
      expect(ui.document.querySelector('.health-publication button')?.hasAttribute('disabled')).toBe(true);
      expect(ui.document.querySelector('.health-read button')?.hasAttribute('disabled')).toBe(true);
      const form = ui.document.querySelector('.health-publication form')!;
      await act(async () => form.dispatchEvent(new ui.window.Event('submit', {bubbles: true, cancelable: true})));
      expect(input.onSavePublication).not.toHaveBeenCalled(); expect(input.onReadHistory).not.toHaveBeenCalled();
      expect(ui.document.body.textContent).toContain('earlier snapshot');
    } finally {await ui.close();}
  });
  it('requires a frozen initial GSC scope and explains the disabled history action', () => {
    const input = props({evidence: null}), html = renderToStaticMarkup(React.createElement(KeywordHealthPanel, input));
    const {document} = parseHTML(html);
    expect(document.querySelector('.health-read button')?.hasAttribute('disabled')).toBe(true);
    expect(html).toContain('Read the selected GSC conditions in the dashboard first'); expect(input.onReadHistory).not.toHaveBeenCalled();
  });
  it('reads longer history only on a click, without writing metadata or starting an audit', async () => {
    const evidence = fixture(); evidence.snapshot.queryDaily = undefined;
    const input = props({evidence}), ui = await mount(input);
    try {
      expect(input.onReadHistory).not.toHaveBeenCalled(); await ui.click('Read 120 days of GSC history');
      expect(input.onReadHistory).toHaveBeenCalledOnce(); expect(input.onSavePublication).not.toHaveBeenCalled(); expect(input.onAudit).not.toHaveBeenCalled();
    } finally {await ui.close();}
  });
  it('does not display an old save success after the property changes', async () => {
    let finish!: () => void;
    const onSavePublication = vi.fn(() => new Promise<void>(resolve => {finish = resolve;}));
    const input = props({items: [publication()], onSavePublication}), ui = await mount(input);
    try {
      await ui.click('Evidence & actions');
      await act(async () => ui.document.querySelector('form')!.dispatchEvent(new ui.window.Event('submit', {bubbles: true, cancelable: true})));
      const next = fixture(); next.hash = 'other-source'; next.snapshot.property = 'sc-domain:sample-studio.example';
      await ui.render({...input, evidence: next, items: []}); await act(async () => finish());
      expect(ui.document.body.textContent).not.toContain('saved as user-declared context'); expect(ui.document.querySelector('form')).toBeNull(); expect(onSavePublication).toHaveBeenCalledOnce();
    } finally {await ui.close();}
  });
  it('preserves the expanded evidence and publication input through an immediate language switch', async () => {
    const ui = await mount(props({items: [publication()]}));
    try {
      await ui.click('Evidence & actions');
      await act(async () => setUiLanguage('zh-CN'));
      expect(ui.document.querySelector('.health-detail')?.textContent).toContain('用户记录的发布日期');
      expect(ui.document.querySelector('input[type="date"]')?.getAttribute('value')).toBe('2026-01-01');
      expect(ui.document.querySelector('.health-detail')?.textContent).toContain('C++ tips 10% 原文');
    } finally {await ui.close();}
  });
  it('accepts only explicit publication items for the same property and never promotes notes or GSC first appearance', () => {
    expect(publicationRecords([publication(), publication({property: 'sc-domain:sample-studio.example'}), publication({kind: 'note'}), publication({payload: {url: owner, publishedAt: '2026-02-30', source: 'manual'}}), publication({payload: {url: owner, publishedAt: '2026-01-01', source: 'first_seen'}})], property)).toEqual([{url: owner, publishedAt: '2026-01-01', source: 'manual', sourceUrl: 'https://sample-agency.example/changes'}]);
  });
});
