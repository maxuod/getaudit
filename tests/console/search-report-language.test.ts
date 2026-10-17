import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { shareReport } from '../../src/console/gsc-report.ts';
import { encryptedReport } from '../../apps/console/gsc-report.ts';
import type { GscEvidence } from '../../src/console/gsc.ts';

const evidence: GscEvidence = {
  hash: 'unchanged-evidence-hash',
  snapshot: {
    id: 'synthetic-snapshot', property: 'sc-domain:example.test', capturedAt: '2026-10-12T12:00:00Z',
    startDate: '2026-09-01', endDate: '2026-09-28', country: 'CAN', timeZone: 'America/Los_Angeles',
    type: 'web', dataState: 'final', source: 'Original source 原始来源', requests: [], raw: [], totals: null,
    queries: [{ keys: ['原始查询 <script>unsafe()</script>'], clicks: 1, impressions: 10, ctr: .1, position: 12 }],
    pages: [], limitations: ['Original diagnostic 原始说明'],
  },
};

describe('English-first search report interfaces', () => {
  it('defaults and falls back to English, preserves original records, and adapts only interface labels', () => {
    const before = JSON.stringify(evidence);
    const english = shareReport(evidence), unsupported = shareReport(evidence, 'fr'), chinese = shareReport(evidence, 'zh-CN');
    expect(english).toBe(unsupported);
    expect(english).toContain('<html lang="en">');
    expect(chinese).toContain('<html lang="zh-CN">');
    expect(english).toContain('getaudit · Search performance report');
    expect(chinese).toContain('getaudit · 搜索表现报告');
    for (const html of [english, chinese]) {
      expect(html).toContain('Original source 原始来源');
      expect(html).toContain('Original diagnostic 原始说明');
      expect(html).toContain('原始查询 &lt;script&gt;unsafe()&lt;/script&gt;');
      expect(html).toContain(evidence.hash);
      const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
      expect(html).toContain("script-src 'sha256-" + createHash('sha256').update(script).digest('base64') + "'");
      expect(script).not.toContain('原始查询');
      expect(script).not.toContain('unchanged-evidence-hash');
      expect(script).not.toMatch(/fetch\(|XMLHttpRequest|innerHTML|\.reload\(/);
    }
    expect(JSON.stringify(evidence)).toBe(before);
  });

  it('keeps the encrypted envelope English-first with a bilingual switch and no plaintext evidence', async () => {
    const html = await encryptedReport(evidence, 'synthetic report password');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('getaudit · Encrypted search report');
    expect(html).toContain('data-language');
    expect(html).not.toContain('sc-domain:example.test');
    expect(html).not.toContain('Original source 原始来源');
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
    expect(html).toContain("script-src 'sha256-" + createHash('sha256').update(script).digest('base64') + "'");
    await expect(encryptedReport(evidence, 'short')).rejects.toThrow('Use a password with at least 8 characters.');
  });
});
