#!/usr/bin/env node
/**
 * One-shot, public consumer-web capability probe. No ledger, server, credentials,
 * model API, paid collection service, login preparation, retry or resume path.
 *
 * node --experimental-strip-types --no-warnings scripts/verify-guest-platforms.mjs \
 *   --output-dir /tmp/getgeo-guest-2026-10-15
 * Optional: --surface chatgpt_search,duckduckgo_search_assist --browser-mode silent --plan-only
 * An explicit output directory must not already exist. Each invocation is a new
 * probe; this runner never automatically repeats a submitted question.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessCapture } from '../src/console/auto-quality.ts';
import { captureSchema, planSchema, surfaceIds, surfaces } from '../src/console/contracts.ts';
import { canonicalJson } from '../src/lib/canonical-json.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PROMPT = 'What is the difference between weather and climate? Use authoritative web sources and include source links.';
const TIMEZONE = 'America/Halifax';
const TIMEOUT_SECONDS = 150;
const SOURCE_FILES = [
  'scripts/verify-guest-platforms.mjs', 'desktop/chrome-collector.cjs',
  'desktop/browser-platforms.cjs', 'desktop/browser-extract.cjs',
  'desktop/capture-artifact.cjs', 'desktop/egress-check.cjs',
  'src/console/contracts.ts', 'src/console/auto-quality.ts',
  'src/console/sources.ts', 'src/lib/canonical-json.ts', 'package.json',
];
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceHashes = () => Object.fromEntries(SOURCE_FILES.map(path => [path, digest(readFileSync(join(ROOT, path)))]));
const localDate = date => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const within = (path, parent) => { const rel = relative(parent, path); return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)); };

function help() {
  console.log(`Usage: node --experimental-strip-types --no-warnings scripts/verify-guest-platforms.mjs [options]

  --output-dir PATH   Fresh evidence directory; existing paths are never reused.
  --surface ID[,ID]   Selected consumer surfaces (repeatable).
  --browser-mode MODE Browser mode: silent (default) or explicitly visible.
  --plan-only         Save the frozen manifest without opening Chrome or sending a question.
  --help              Show this help without writing files or making requests.

Surfaces: ${surfaceIds.join(', ')}

Each selected surface receives the same fixed neutral question at most once.
Strict signed-out policy, background temporary Chrome contexts by default, no screenshots,
no login or credentials, no paid interfaces, no retries and no automatic replay.
Visible mode is an explicit operator troubleshooting option. No background
restriction or launch failure automatically opens a visible window.
Geography remains unverified: no IP lookup is made and all observations are
excluded from region-matched GEO metrics. Public websites load their own assets.
An interrupted submission remains uncertain; inspect receipts before a new run.`);
}

function options(argv) {
  let output, planOnly = false, browserMode = 'silent', browserModeSupplied = false;
  const selected = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') { help(); return null; }
    if (flag === '--plan-only') { planOnly = true; continue; }
    if (flag !== '--output-dir' && flag !== '--surface' && flag !== '--browser-mode') throw new Error(`Unknown option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--output-dir') {
      if (output) throw new Error('--output-dir can only be supplied once.');
      output = resolve(value);
    } else if (flag === '--browser-mode') {
      if (browserModeSupplied) throw new Error('--browser-mode can only be supplied once.');
      if (!['silent', 'visible'].includes(value)) throw new Error('--browser-mode must be silent or visible.');
      browserMode = value; browserModeSupplied = true;
    } else selected.push(...value.split(',').map(id => id.trim()));
  }
  if (new Set(selected).size !== selected.length) throw new Error('A surface cannot be repeated within one probe.');
  for (const id of selected) if (!surfaceIds.includes(id)) throw new Error(`Unsupported surface: ${id}`);
  return { output, planOnly, browserMode, selected: selected.length ? selected : [...surfaceIds] };
}

function destination(output) {
  if (!output) return mkdtempSync(join(tmpdir(), 'getgeo-strict-guest-'));
  if (existsSync(output)) throw new Error('Output directory already exists. Historical evidence is never overwritten or resumed.');
  let parent = dirname(output);
  while (!existsSync(parent)) parent = dirname(parent);
  const physical = resolve(realpathSync(parent), relative(parent, output));
  const prohibited = [join(homedir(), 'Library', 'Application Support'), join(ROOT, 'data')];
  if (prohibited.some(path => within(physical, path)) || physical.split(sep).some(part => part.endsWith('.app')))
    throw new Error('Evidence output must be outside application bundles, production data and application-support directories.');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  return output;
}

function saveJson(path, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  if (digest(readFileSync(path)) !== digest(bytes)) throw new Error('Saved evidence failed its hash read-back.');
  return { path: path.split(sep).at(-1), sha256: digest(bytes), bytes: bytes.length };
}

async function main() {
  const args = options(process.argv.slice(2));
  if (!args) return;
  const output = destination(args.output);
  const startedAt = new Date().toISOString();
  const runId = randomUUID(), frozenHash = digest(canonicalJson({ prompt: PROMPT, intent: 'guest_capability', locale: 'en-CA' }));
  const config = planSchema.parse({
    promptSetId: runId, label: `Strict guest public-web capability verification (${args.browserMode})`,
    surfaces: args.selected, accountMode: 'signed_out', guestPolicy: 'no_login_v1',
    repetitions: 1, egressPolicy: 'unverified', windows: [localDate(new Date())],
    country: 'CA', locale: 'en-CA', timezone: TIMEZONE, device: 'desktop',
  });
  const implementation = sourceHashes(), implementationHash = digest(canonicalJson(implementation));
  const cohort = { label: `strict-guest-${args.browserMode}`, browserMode: args.browserMode,
    accountMode: config.accountMode, guestPolicy: config.guestPolicy, promptHash: frozenHash,
    locale: config.locale, timezone: config.timezone, device: config.device, geography: 'unverified' };
  const cohortHash = digest(canonicalJson(cohort));
  const slots = args.selected.map(surface => ({ surface, slotId: randomUUID() }));
  const frozen = {
    schema: 'strict-guest-probe-manifest-v1', runId, startedAt, prompt: PROMPT, frozenHash,
    config, configHash: digest(canonicalJson(config)), slots, implementation, implementationHash, cohort, cohortHash,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    execution: { mode: 'serial', browserMode: args.browserMode, timeoutSeconds: TIMEOUT_SECONDS, captureScreenshot: false, attemptsPerSurface: 1, automaticRetries: false, automaticReplay: false, automaticVisibleFallback: false },
    boundaries: { productionDataAccess: false, loginPreparation: false, paidProviderInterfaces: false, geographyVerified: false, metricEligibility: false,
      note: 'Capability verification only. CA is a requested comparison label, not observed geography. No egress lookup, production ledger, settings, credential store, API jobs or analysis service is used. Consumer pages may load their normal assets and web backends. No CAPTCHA or login wall is bypassed.' },
  };
  const manifest = saveJson(join(output, 'manifest.json'), frozen);
  console.log(JSON.stringify({ event: 'manifest', output, surfaces: args.selected, browserMode: args.browserMode, cohortHash, promptHash: frozenHash, manifestSha256: manifest.sha256, planOnly: args.planOnly }));
  if (args.planOnly) return;

  const require = createRequire(import.meta.url);
  const { createChromeCollector } = require('../desktop/chrome-collector.cjs');
  const collector = createChromeCollector();
  const available = collector.available();
  if (!available.available) throw new Error('Standard Google Chrome is unavailable; no question was sent.');
  const controller = new AbortController();
  let stopping = false, activeSurface = null;
  const eventsPath = join(output, 'stages.jsonl');
  const event = detail => appendFileSync(eventsPath, JSON.stringify({ at: new Date().toISOString(), ...detail }) + '\n', { mode: 0o600 });
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    event({ event: 'interrupted', signal, surface: activeSurface, note: 'No submitted question will be replayed; unstarted surfaces remain unexecuted.' });
    controller.abort();
  };
  const onInterrupt = () => stop('SIGINT'), onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  const records = [];
  try {
    for (const slot of slots) {
      if (stopping) break;
      if (digest(canonicalJson(sourceHashes())) !== implementationHash) throw new Error('Collector source changed after the manifest was frozen; remaining questions were not sent.');
      if (localDate(new Date()) !== config.windows[0]) throw new Error('The frozen local date window ended; remaining questions were not sent.');
      activeSurface = slot.surface;
      const directory = join(output, slot.surface);
      mkdirSync(directory, { mode: 0o700 });
      const itemStartedAt = new Date().toISOString();
      let lastStage = 'not_started', submissionCheckpointReached = false;
      event({ event: 'platform_start', ...slot });
      const itemController = new AbortController();
      const abortItem = () => itemController.abort();
      controller.signal.addEventListener('abort', abortItem, { once: true });
      // Includes the collector's bounded source-reading grace period. Aborting
      // never retries; an already submitted request may have an unknown result.
      const watchdog = setTimeout(() => itemController.abort(), (TIMEOUT_SECONDS + 90) * 1000);
      let receipt;
      try {
        const capture = await collector.collect({
          planId: runId, ...slot, prompt: PROMPT, config, timeoutSeconds: TIMEOUT_SECONDS,
          browserMode: args.browserMode, captureScreenshot: false, verifiedCountry: null,
          geoVerificationNote: 'Geography intentionally unverified in this isolated public-web capability probe; excluded from region-matched GEO metrics.',
        }, itemController.signal, stage => {
          lastStage = stage;
          if (stage === 'submitting') submissionCheckpointReached = true;
          event({ event: 'stage', ...slot, stage, submissionCheckpointReached });
          console.log(JSON.stringify({ event: 'stage', surface: slot.surface, stage }));
        });
        const parsed = captureSchema.safeParse(capture);
        const artifact = capture.artifact;
        const artifactBytes = artifact ? Buffer.from(artifact.base64, 'base64') : null;
        const artifactHash = artifactBytes ? digest(artifactBytes) : null;
        const integrityIssues = [];
        if (!parsed.success) integrityIssues.push('Capture does not match the canonical capture schema.');
        if (capture.browser?.mode !== args.browserMode) integrityIssues.push('Capture browser mode does not match the frozen execution cohort.');
        if (!artifact || artifact.mime !== 'text/plain' || !artifactBytes?.length || artifactBytes.length > 4 * 1024 * 1024 || artifactBytes.toString('base64') !== artifact.base64)
          integrityIssues.push('Expected a nonempty, valid plain-text artifact no larger than 4 MiB.');
        if (digest(canonicalJson(sourceHashes())) !== implementationHash) integrityIssues.push('Collector source changed during this observation.');
        const { artifact: _artifact, ...fields } = capture;
        const record = { ...fields, artifactHash };
        const captureHash = digest(canonicalJson(record));
        const files = {};
        let raw = null;
        if (artifactBytes) {
          writeFileSync(join(directory, 'artifact.txt'), artifactBytes, { flag: 'wx', mode: 0o600 });
          if (digest(readFileSync(join(directory, 'artifact.txt'))) !== artifactHash) integrityIssues.push('Artifact failed its saved-byte hash read-back.');
          files.artifact = { path: 'artifact.txt', mime: artifact.mime, bytes: artifactBytes.length, sha256: artifactHash };
          if (artifact.mime === 'text/plain') { try { raw = JSON.parse(artifactBytes.toString('utf8')); } catch { integrityIssues.push('Plain-text browser artifact is not readable JSON.'); } }
        }
        files.capture = saveJson(join(directory, 'capture.json'), record);
        const quality = assessCapture({
          capture: record, captureHash, integrity: integrityIssues.length === 0,
          context: { config, configHash: frozen.configHash, frozenHash, prompt: PROMPT, slotId: slot.slotId,
            surface: slot.surface, window: config.windows[0], integrityIssues },
        });
        const guestConditionsConfirmed = capture.account === 'logged_out' && capture.session === 'fresh' &&
          capture.privacy?.mode === 'signed_out' && capture.privacy?.newConversation === true;
        files.quality = saveJson(join(directory, 'quality.json'), quality);
        receipt = {
          ...slot, name: surfaces[slot.surface].name, startedAt: itemStartedAt, finishedAt: new Date().toISOString(), cohortHash,
          status: capture.status, restriction: capture.restriction, reason: capture.reason, lastStage,
          submission: { checkpointReached: submissionCheckpointReached, state: capture.status === 'observed' || capture.status === 'not_triggered' ? 'response_observed' : submissionCheckpointReached ? 'may_have_been_submitted' : 'not_submitted',
            responseOutcomeUncertain: submissionCheckpointReached && !['observed', 'not_triggered'].includes(capture.status), automaticReplay: false },
          answerCharacters: capture.answer.length, citationCount: capture.citations.length,
          answerComplete: capture.browser?.answerComplete === true, citationsComplete: capture.browser?.citationsComplete === true,
          citationControls: capture.browser?.citationControls ?? null, citationControlsOpened: capture.browser?.citationControlsOpened ?? null,
          sourceCountExpected: raw?.sourceCountExpected ?? null, unresolvedCitations: capture.browser?.unresolvedCitations ?? null, citationOverflow: capture.browser?.citationOverflow ?? null,
          account: capture.account, session: capture.session, privacy: capture.privacy ?? null,
          geo: capture.geo, exitCountry: capture.exitCountry, locale: capture.locale, timezone: capture.timezone, device: capture.device, geolocation: capture.geolocation,
          searchMode: capture.searchMode, browser: capture.browser ?? null,
          contentQualified: quality.contentQualified, metricEligible: quality.metricEligible,
          guestConditionsConfirmed, completeGuestObservation: quality.contentQualified && guestConditionsConfirmed,
          qualityStatus: quality.status, qualityReasons: quality.reasons, integrityIssues,
          hashes: { captureCanonicalSha256: captureHash, artifactSha256: artifactHash, qualityAssessmentSha256: quality.assessmentHash }, files,
        };
      } catch (error) {
        receipt = {
          ...slot, name: surfaces[slot.surface].name, startedAt: itemStartedAt, finishedAt: new Date().toISOString(), cohortHash,
          status: 'runner_error', reason: String(error?.message || 'Collector failed.').slice(0, 1500), lastStage,
          submission: { checkpointReached: submissionCheckpointReached, state: submissionCheckpointReached ? 'may_have_been_submitted' : 'not_submitted', responseOutcomeUncertain: submissionCheckpointReached, automaticReplay: false },
          answerComplete: false, citationsComplete: false, contentQualified: false, metricEligible: false,
          guestConditionsConfirmed: false, completeGuestObservation: false,
          geographyVerified: false, note: 'No capture was returned. No response was invented and no question was retried.',
        };
      } finally {
        clearTimeout(watchdog);
        controller.signal.removeEventListener('abort', abortItem);
      }
      const receiptFile = saveJson(join(directory, 'receipt.json'), receipt);
      records.push({ ...receipt, receiptFile: { ...receiptFile, path: slot.surface + '/' + receiptFile.path } });
      event({ event: 'platform_finish', ...slot, status: receipt.status, contentQualified: receipt.contentQualified, metricEligible: receipt.metricEligible });
      console.log(JSON.stringify({ event: 'result', surface: slot.surface, status: receipt.status, answerComplete: receipt.answerComplete, citationsComplete: receipt.citationsComplete, citations: receipt.citationCount ?? 0, contentQualified: receipt.contentQualified, completeGuestObservation: receipt.completeGuestObservation, metricEligible: receipt.metricEligible, submission: receipt.submission.state }));
    }
  } finally {
    await collector.close();
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
    const completed = new Set(records.map(record => record.surface));
    const unexecuted = slots.filter(slot => !completed.has(slot.surface));
    const summary = {
      schema: 'strict-guest-probe-summary-v1', runId, startedAt, finishedAt: new Date().toISOString(),
      interrupted: stopping, selected: slots.length, captured: records.length,
      completeGuestObservations: records.filter(record => record.completeGuestObservation).length,
      metricEligibleObservations: records.filter(record => record.metricEligible).length,
      geography: 'unverified', paidProviderInterfacesUsed: false, productionLedgerUsed: false,
      manifest, frozenHash, configHash: frozen.configHash, implementationHash, cohort, cohortHash,
      implementationUnchanged: digest(canonicalJson(sourceHashes())) === implementationHash,
      scope: 'One neutral question per selected public consumer surface, strictly signed out. Complete means mechanically qualified visible answer and current source range, not verified answer truth. Unverified geography excludes all results from region-matched GEO metrics. Failed or uncertain submissions are never automatically repeated.',
      records, unexecuted: unexecuted.map(slot => ({ ...slot, status: 'not_started', submission: 'not_submitted' })),
    };
    const summaryFile = saveJson(join(output, 'summary.json'), summary);
    saveJson(join(output, 'checksums.json'), { schema: 'strict-guest-probe-checksums-v1', algorithm: 'sha256', manifest, summary: summaryFile,
      stages: existsSync(eventsPath) ? { path: 'stages.jsonl', sha256: digest(readFileSync(eventsPath)) } : null,
      platforms: records.map(record => ({ surface: record.surface, receipt: record.receiptFile, files: record.files ?? {} })) });
    console.log(JSON.stringify({ event: 'summary', output, completed: records.length, completeGuestObservations: summary.completeGuestObservations, metricEligibleObservations: summary.metricEligibleObservations, unexecuted: unexecuted.length, sha256: summaryFile.sha256 }));
  }
  if (stopping) process.exitCode = 130;
}

main().catch(error => { console.error(String(error?.message || error)); process.exitCode = 1; });
