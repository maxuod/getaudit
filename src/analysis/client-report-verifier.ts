import {
  assertClientReportHasNoSourceLeak,
  buildClientEvidenceManifest,
  type ClientLightReportMode,
  type ClientLightReportSnapshot,
} from "./client-light-report.ts";
import { assertReportDocumentFingerprint } from "./report-credibility.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";

export interface ClientReportVerification {
  mode: ClientLightReportMode;
  evidenceSha256: string;
  checks: string[];
  limitations: string[];
}

function parseManifest(html: string): unknown {
  const raw = html.match(
    /<script\s+type=["']application\/json["']\s+id=["']client-evidence-manifest["']>([\s\S]*?)<\/script>/i,
  )?.[1];
  if (!raw) throw new Error("Client report is missing its evidence manifest");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Client report evidence manifest is not valid JSON");
  }
}

function assertSnapshotInvariants(snapshot: ClientLightReportSnapshot): void {
  const geo = snapshot.geo;
  const seo = snapshot.seo;
  if (geo.successfulObservations + geo.failedObservations !== geo.totalObservations) {
    throw new Error("GEO successful and failed observations do not add to the total");
  }
  if (geo.ownedResponseHits < 0 || geo.ownedResponseHits > geo.successfulObservations) {
    throw new Error("GEO website-citation numerator is outside its denominator");
  }
  if (geo.brandMentionCount < 0 || geo.brandMentionCount > geo.successfulObservations) {
    throw new Error("GEO brand-mention numerator is outside its denominator");
  }
  if (
    geo.highRepeatQuestions + geo.mixedQuestions + geo.zeroOwnedCitationQuestions !==
    geo.questionCount
  ) {
    throw new Error("Question-level GEO categories do not add to the question total");
  }
  if (geo.surfaceCount !== 1) {
    throw new Error("Lightweight client reports must not pool multiple answer surfaces");
  }
  if (
    seo.questionsCovered + seo.questionsPartial + seo.questionsMissing !==
    seo.questionsEvaluated
  ) {
    throw new Error("SEO question-coverage categories do not add to the reviewed total");
  }
  if (seo.questionPagesChecked < 1) {
    throw new Error("SEO question review does not identify any checked public pages");
  }
  const provenanceTotal =
    seo.questionProvenance.websiteDerived +
    seo.questionProvenance.researchHypotheses +
    seo.questionProvenance.publicMarketResearch +
    seo.questionProvenance.privateFirstParty;
  if (provenanceTotal !== seo.questionsEvaluated) {
    throw new Error("SEO question provenance does not add to the reviewed total");
  }
  if (seo.evidenceMode === "prospect-public") {
    if (
      !seo.questionProvenance.publicOnlyAtSource ||
      seo.questionProvenance.privateFirstParty !== 0 ||
      seo.firstPartySearchAvailable ||
      seo.firstPartyAnalyticsAvailable
    ) {
      throw new Error("Prospect report is not isolated from first-party search or analytics");
    }
  }
}

export function verifyClientReportHtml(
  snapshot: ClientLightReportSnapshot,
  mode: ClientLightReportMode,
  html: string,
): ClientReportVerification {
  assertReportDocumentFingerprint(html);
  assertClientReportHasNoSourceLeak(html);
  assertSnapshotInvariants(snapshot);

  const expected = buildClientEvidenceManifest(snapshot, mode);
  const actual = parseManifest(html);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("Client report claims do not recompute from the selected evidence sources");
  }
  if (!snapshot.geo.executionLocationVerified && !/not independently verified/i.test(html)) {
    throw new Error("Unverified execution location is not disclosed near the GEO claim");
  }
  if (snapshot.geo.captureQuality === "legacy-limited" && !/predates the current full capture checks/i.test(html)) {
    throw new Error("Legacy capture limitation is not disclosed near the GEO claim");
  }

  return {
    mode,
    evidenceSha256: sha256(canonicalJson(expected)),
    checks: [
      "document-fingerprint",
      "source-leak-guard",
      "manifest-recomputation",
      "metric-denominators",
      "question-grain",
      "single-surface-scope",
      "public-source-isolation",
      "location-disclosure",
    ],
    limitations: snapshot.geo.captureLimitations,
  };
}
