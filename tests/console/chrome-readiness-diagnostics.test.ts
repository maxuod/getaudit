import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { captureSchema } from '../../src/console/contracts.ts';
import { connectLedger } from '../../src/db/index.ts';
import { LabService } from '../../src/console/service.ts';
import { BrowserJobs } from '../../src/console/browser-jobs.ts';

const require = createRequire(import.meta.url);
const collectorSource = readFileSync(new URL('../../desktop/chrome-collector.cjs', import.meta.url), 'utf8');
const question = 'Which scheduling tools suit a small Canadian restaurant?';
const source = { url: 'https://guide.example/scheduling', title: 'Scheduling guide', placement: 'answer_link' };
const reply = 'A completed response about employee scheduling for a small Canadian restaurant, with a cited guide.';
type Options = { surface?: string; inputAfter?: number; editableAfter?: number; neverInput?: boolean; replacedInput?: boolean;
  partial?: boolean; sourceThrows?: boolean; noAccount?: boolean; captchaAfter?: number; navigationError?: boolean;
  hungDiagnostic?: boolean; hungGeolocation?: boolean; accessNoticeAfterSubmit?: 'login'; accessNoticeBeforeSubmit?: 'login';
  accessNoticeSource?: string; accessNoticeMessage?: string; bodyText?: string };

// Synthetic browser and deterministic clock only. No consumer requests or real accounts.
function fixture(options: Options = {}) {
  const surface = options.surface || 'chatgpt_search', base = Date.now();
  let now = base, submitted = 0, filled = 0, openedSources = false, closed = false, replacedInput = false;
  let pendingHungRead = false, releaseInputs: ((value: unknown[]) => void) | undefined, releasePermission: ((value: string) => void) | undefined;
  const visited: string[] = [], launchOptions: unknown[] = [], stages: string[] = [];
  let destination = 'https://chatgpt.com/';
  class Clock extends Date { static now() { return now; } }
  const empty: any = { all: async () => [], or() { return this; }, filter() { return this; }, last() { return this; } };
  const locate = (...controls: any[]) => ({ ...empty, all: async () => controls });
  const input = { isVisible: async () => true, isEnabled: async () => true,
    isEditable: async ({timeout}: {timeout: number}) => {
      expect(timeout).toBe(500);
      if(options.replacedInput&&!replacedInput){replacedInput=true;throw new Error('Composer replaced during hydration');}
      return now - base >= (options.editableAfter || 0);
    },
    fill: async (value: string) => { expect(value).toBe(question); filled++; },
    press: async () => { submitted++; } };
  const selected = { isVisible: async () => true };
  const sourceControl = { isVisible: async () => true, click: async () => {
    if (options.sourceThrows) throw new Error('Synthetic source control failure with PRIVATE COOKIE TOKEN');
    openedSources = true;
  }, getAttribute: async () => null };
  const page: any = { isClosed: () => closed, close: async () => { closed = true; }, url: () => destination,
    goto: async (url: string) => { destination = url; visited.push(url); if (options.navigationError) { destination = 'chrome-error://chromewebdata/'; throw new Error('Navigation failed at PRIVATE AUTH URL'); } },
    locator: (selector: string) => {
      if (options.hungDiagnostic && stages.at(-1) === 'capturing') return { ...empty, all: () => {
        pendingHungRead = true;
        return new Promise<unknown[]>(resolve => { releaseInputs = resolve; });
      } };
      return selector.includes('model-response') ? { ...empty, getByRole: () => empty }
        : locate(...(options.neverInput || now - base < (options.inputAfter || 0) ? [] : [input]));
    },
    getByRole: (_role: string, { name }: { name: RegExp }) => {
      if (name.test('Search (remove)')) return locate(selected);
      if (name.test('Sources')) return locate(sourceControl);
      return empty;
    },
    getByText: () => empty,
    evaluate: async (_fn: unknown, args?: unknown) => {
      if (!args && String(_fn).includes('navigator.permissions')) {
        if (options.hungGeolocation) { pendingHungRead = true; return await new Promise<string>(resolve => { releasePermission = resolve; }); }
        return 'denied';
      }
      if (!args) return { readyState: 'complete', bodyChars: submitted ? 250 : options.neverInput || options.navigationError ? 0 : 90 };
      const restriction = options.captchaAfter !== undefined && now - base >= options.captchaAfter;
      const accessNotice = submitted ? options.accessNoticeAfterSubmit || null : options.accessNoticeBeforeSubmit || null;
      const accessNoticeSource = accessNotice ? options.accessNoticeSource || 'current_reply' : null;
      const accessNoticeMessage = accessNotice ? options.accessNoticeMessage || (accessNoticeSource === 'login_dialog' ? 'Sign in to continue using Perplexity' : 'Sign up and repeat your request.') : null;
      return { body: restriction ? 'Verify you are human' : options.bodyText ?? (submitted ? 'Answer page, PRIVATE SIDEBAR TITLE, account@example.test, Continue with Google' : options.neverInput || options.navigationError ? '' : 'Guest composer loading'),
        controls: ['PRIVATE SIDEBAR TITLE', 'account@example.test', 'PRIVATE COOKIE TOKEN'],
        answer: submitted && !accessNotice ? reply : '', citations: submitted && !accessNotice ? [source] : [], accessNotice, accessNoticeSource, accessNoticeMessage,
        signedOut: !options.noAccount, signedIn: false, model: 'unknown',
        containerFound: !!submitted && !accessNotice, responseComplete: !!submitted && !options.partial && !accessNotice, generating: !!submitted && !!options.partial && !accessNotice,
        sourcePanel: openedSources, unresolvedCitations: 0, citationOverflow: 0 };
    } };
  const context = { grantPermissions: async () => {}, newPage: async () => page, close: async () => { closed = true; } };
  const browser = { isConnected: () => true, version: () => 'synthetic', newContext: async () => context, close: async () => {} };
  const module = { exports: {} as any };
  runInNewContext(collectorSource, { module, Date: Clock, require: (name: string) => {
    if (name === 'playwright-core') return { chromium: { launch: async (config: unknown) => { launchOptions.push(config); return browser; } } };
    if (name === 'node:timers/promises') return { setTimeout: async (ms: number) => {
      if (ms === 2000) {
        if (pendingHungRead) { pendingHungRead = false; now += ms; return null; }
        return await new Promise(() => {}); // Bounded diagnostic timers lose to the synchronous synthetic read.
      }
      now += ms;
    } };
    if (name.startsWith('./')) return require('../../desktop/' + name.slice(2));
    return require(name);
  }, AbortController, Buffer, URL });
  const task = { planId: 'synthetic-plan', slotId: '0f9d5bd5-042f-4a97-b33c-d69692cb11d9', surface, prompt: question,
    config: { accountMode: 'signed_out', locale: 'en-CA', timezone: 'UTC' }, timeoutSeconds: 45,
    captureScreenshot: false, browserMode: 'silent', verifiedCountry: null };
  return { run: () => module.exports.createChromeCollector().collect(task, new AbortController().signal, (stage: string) => stages.push(stage)),
    releaseLateReads: async () => { releaseInputs?.([input]); releasePermission?.('denied'); for (let i = 0; i < 8; i++) await Promise.resolve(); },
    counts: () => ({ submitted, filled, visited, launchOptions, stages, closed, elapsed: now - base }) };
}
const rawEvidence = (capture: any) => JSON.parse(Buffer.from(capture.artifact.base64, 'base64').toString());

describe('Chrome readiness and failure evidence — synthetic fixtures', () => {
  for (const surface of ['chatgpt_search', 'gemini', 'google_aio']) {
    it(`${surface}: waits for delayed native input hydration before one submission`, async () => {
      const f = fixture({ surface, inputAfter: 8500 });
      const result = await f.run();
      expect(result.status).toBe('observed');
      expect(f.counts()).toMatchObject({ submitted: 1, filled: 1, visited: [surface === 'chatgpt_search' ? 'https://chatgpt.com/' : surface === 'gemini' ? 'https://gemini.google.com/app' : 'https://www.google.com/'] });
      expect(f.counts().elapsed).toBeGreaterThan(8500);
      expect(result.browser.notes.some((note: string) => note.includes('PRIVATE'))).toBe(false);
    });
  }
  it('waits until a visible read-only composer becomes editable', async () => {
    const f = fixture({ editableAfter: 7500 });
    const result = await f.run();
    expect(result.status).toBe('observed'); expect(f.counts().submitted).toBe(1);
    expect(f.counts().elapsed).toBeGreaterThan(7500);
  });
  it('continues readiness polling when hydration replaces the input before its editability check', async () => {
    const f = fixture({ replacedInput: true });
    const result = await f.run();
    expect(result.status).toBe('observed');
    expect(f.counts()).toMatchObject({submitted:1,filled:1});
  });
  it('ends a blank page after a bounded readiness wait without submitting, raising a window, or switching mode', async () => {
    const f = fixture({ neverInput: true });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'error', answer: '', citations: [], browser: { mode: 'silent', answerComplete: false } });
    expect(result.reason).toContain('未显示可读取的正文');
    expect(f.counts()).toMatchObject({ submitted: 0, filled: 0, visited: ['https://chatgpt.com/'], launchOptions: [{ headless: true }], closed: true });
    expect(f.counts().elapsed).toBeLessThanOrEqual(22500);
    expect(rawEvidence(result).failureEvidence.diagnostics).toMatchObject({ submitted: false, documentReadyState: 'complete', bodyChars: 0, readyInputCount: 0 });
  });
  it('stops CAPTCHA during readiness immediately, preserving terminal state without submission', async () => {
    const f = fixture({ inputAfter: 12000, captchaAfter: 4500 });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'unavailable', restriction: 'captcha' });
    expect(f.counts().submitted).toBe(0); expect(f.counts().elapsed).toBeLessThan(10000);
  });
  it('preserves a partial reply and normalized citation candidates only as excluded failure evidence, with no retry', async () => {
    const f = fixture({ partial: true });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'error', answer: '', citations: [], browser: { answerComplete: false, citationsComplete: false } });
    const raw = rawEvidence(result);
    expect(raw.failureEvidence).toMatchObject({ answerCandidate: reply, answerComplete: false, citationCandidates: [source],
      diagnostics: { submitted: true, responseFound: true, responseComplete: false, generating: true, loginPromptTextPresent: true } });
    expect(JSON.stringify(raw)).not.toMatch(/PRIVATE|account@example/);
    expect(f.counts().submitted).toBe(1); expect(f.counts().visited).toHaveLength(1);
    expect(captureSchema.safeParse(result).success).toBe(true);
  });
  it('retains an already stable completed reply when ChatGPT sources fail, while excluding incomplete source coverage', async () => {
    const f = fixture({ sourceThrows: true });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'observed', answer: reply, citations: [source], browser: { answerComplete: true, citationsComplete: false } });
    expect(f.counts().submitted).toBe(1); expect(rawEvidence(result).answer).toBe(reply);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|account@example/);
    expect(captureSchema.safeParse(result).success).toBe(true);
  });
  it('saves a navigation failure as text diagnostics with the official source origin and no private error message', async () => {
    const f = fixture({ navigationError: true });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'error', sourceUrl: 'https://chatgpt.com', answer: '', citations: [] });
    expect(rawEvidence(result).failureEvidence.diagnostics.submitted).toBe(false);
    expect(f.counts().submitted).toBe(0); expect(f.counts().visited).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|chrome-error/);
    expect(captureSchema.safeParse(result).success).toBe(true);
  });
  it('bounds a hung failure input probe and permissions read, and ignores their late results', async () => {
    const f = fixture({ partial: true, hungDiagnostic: true, hungGeolocation: true });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'error', geolocation: 'unknown' });
    expect(rawEvidence(result).failureEvidence.diagnostics).toMatchObject({ inputProbeComplete: false, visibleInputCount: null, readyInputCount: null });
    expect(f.counts()).toMatchObject({ submitted: 1, closed: true });
    expect(f.counts().elapsed).toBeLessThanOrEqual(51000); // 45-second question budget, one polling interval, two bounded reads.
    const frozen = JSON.stringify(result);
    await f.releaseLateReads();
    expect(JSON.stringify(result)).toBe(frozen);
    expect(captureSchema.safeParse(result).success).toBe(true);
  });
  it('records a current Perplexity reply login notice immediately after one submission, without repeating it', async () => {
    const f = fixture({ surface: 'perplexity', accessNoticeAfterSubmit: 'login' });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'unavailable', restriction: 'login', answer: '', citations: [], browser: { answerComplete: false } });
    expect(result.reason).toContain('平台当前回复要求注册或登录');
    expect(f.counts()).toMatchObject({ submitted: 1, filled: 1, visited: ['https://www.perplexity.ai/'], closed: true });
    expect(f.counts().elapsed).toBeLessThan(10000);
    expect(rawEvidence(result).failureEvidence).toMatchObject({ accessNotice: { kind: 'login', source: 'current_reply', message: 'Sign up and repeat your request.' }, diagnostics: { currentResponseAccessNotice: 'login', accessNoticeSource: 'current_reply', submitted: true } });
    expect(captureSchema.safeParse(result).success).toBe(true);
  });
  it('does not infer a Perplexity login restriction from signup text outside the bounded current reply', async () => {
    const f = fixture({ surface: 'perplexity', bodyText: 'Sidebar marketing: Sign up and repeat your request. Continue with Google.' });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'observed', restriction: 'none', answer: reply });
    expect(f.counts().submitted).toBe(1);
  });
  it('records a strictly recognized Perplexity login dialog after one submission with its fixed message', async () => {
    const f = fixture({ surface: 'perplexity', accessNoticeAfterSubmit: 'login', accessNoticeSource: 'login_dialog' });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'unavailable', restriction: 'login', answer: '', citations: [] });
    expect(rawEvidence(result).failureEvidence).toMatchObject({ accessNotice: { kind: 'login', source: 'login_dialog', message: 'Sign in to continue using Perplexity' }, diagnostics: { accessNoticeSource: 'login_dialog', submitted: true } });
    expect(JSON.stringify(rawEvidence(result))).not.toContain('Sign up and repeat your request.');
    expect(f.counts().submitted).toBe(1); expect(f.counts().elapsed).toBeLessThan(10000);
  });
  it('preserves a recognized login dialog before submission without sending the question', async () => {
    const f = fixture({ surface: 'perplexity', accessNoticeBeforeSubmit: 'login', accessNoticeSource: 'login_dialog' });
    const result = await f.run();
    expect(result).toMatchObject({ status: 'unavailable', restriction: 'login' });
    expect(rawEvidence(result).failureEvidence).toMatchObject({ accessNotice: { source: 'login_dialog', message: 'Sign in to continue using Perplexity' }, diagnostics: { submitted: false } });
    expect(f.counts()).toMatchObject({ submitted: 0, filled: 0 });
  });
  it('does not classify or retain arbitrary access-notice messages or unknown notice sources', async () => {
    for (const options of [{ accessNoticeSource: 'login_dialog', accessNoticeMessage: 'PRIVATE AUTH TOKEN' }, { accessNoticeSource: 'PRIVATE SOURCE', accessNoticeMessage: 'Sign in to continue using Perplexity' }]) {
      const f = fixture({ surface: 'perplexity', accessNoticeAfterSubmit: 'login', ...options });
      const result = await f.run(), raw = rawEvidence(result);
      expect(result).toMatchObject({ status: 'error', restriction: 'none' });
      expect(raw.failureEvidence.diagnostics.accessNoticeSource).toBeNull();
      expect(raw.failureEvidence.accessNotice).toBeUndefined();
      expect(JSON.stringify(raw)).not.toContain('PRIVATE');
      expect(f.counts().submitted).toBe(1);
    }
  });
  it('saves the submitted Perplexity login notice and blocks the remaining unsent queue positions', async () => {
    const f = fixture({ surface: 'perplexity', accessNoticeAfterSubmit: 'login' }), result = await f.run();
    const folder = mkdtempSync(join(tmpdir(), 'geo-login-notice-test-'));
    const lab = new LabService(connectLedger(join(folder, 'ledger.db')));
    let jobs: BrowserJobs | undefined, calls = 0;
    try {
      const brandId = lab.createBrand(randomUUID(), { name: 'Synthetic Restaurant', aliases: [], ownedDomains: ['restaurant.example'] }).id;
      const promptSetId = lab.createSet(randomUUID(), { brandId, label: 'Synthetic current reply gate', locale: 'en-CA', source: 'Synthetic fixtures only', kind: 'hypothesis',
        prompts: [question, question + ' Question two.', question + ' Question three.'].map(text => ({ text, intent: 'discovery' })) }).id;
      lab.freeze(randomUUID(), promptSetId);
      const planId = lab.createPlan(randomUUID(), { promptSetId, label: 'Synthetic login gate', surfaces: ['perplexity'], accountMode: 'signed_out', windows: [new Date().toISOString().slice(0, 10)], country: 'CA', locale: 'en-CA', timezone: 'UTC', device: 'desktop' }).id;
      jobs = new BrowserJobs(lab, { available: () => ({ available: true, message: 'Synthetic only' }), show: async () => {}, close: async () => {},
        collect: async task => { calls++; return { ...result, slotId: task.slotId, prompt: task.prompt }; } }, async () => {});
      const job = jobs.create(randomUUID(), { planId, transmissionAcknowledged: true, intervalSeconds: 5 });
      await jobs.active.get(job.id)?.promise;
      expect(calls).toBe(1);
      expect(jobs.items(job.id).map(item => item.state)).toEqual(['captured', 'blocked', 'blocked']);
      expect(lab.db.prepare('SELECT COUNT(*) AS total FROM console_attempt').get()).toEqual({ total: 1 });
      expect(jobs.job(job.id).status).toBe('needs_attention');
      expect(f.counts().submitted).toBe(1);
    } finally { await jobs?.pauseAll(); lab.db.close(); rmSync(folder, { recursive: true, force: true }); }
  });
});
