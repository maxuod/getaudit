import type { Ledger } from "../db/index.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";

export const REPORT_EVIDENCE_SCHEMA = "geo-proof-report-v1";
const REPORT_DOCUMENT_HASH_PLACEHOLDER = "__GEO_PROOF_DOCUMENT_SHA256__";

export type ReportPublicationStatus = "descriptive-only" | "internal-only";
export type PublicationGate = "pass" | "block";

type SurfaceClass = "api_model" | "consumer_web" | "serp_feature" | "unknown";

interface KnownEngineSurface {
  label: string;
  provider: string;
  productSurface: string;
  surfaceClass: Exclude<SurfaceClass, "consumer_web" | "unknown">;
  collectionMode: "api";
  provenancePrefixes: readonly string[];
}

const KNOWN_ENGINE_SURFACES: Readonly<Record<string, KnownEngineSurface>> = {
  perplexity_sonar: {
    label: "Perplexity Sonar API",
    provider: "Perplexity",
    productSurface: "Sonar API",
    surfaceClass: "api_model",
    collectionMode: "api",
    provenancePrefixes: ["perplexity:sonar:"],
  },
  dataforseo_chat_gpt: {
    label: "ChatGPT model via DataForSEO LLM Responses API",
    provider: "DataForSEO",
    productSurface: "LLM Responses API proxy — ChatGPT model",
    surfaceClass: "api_model",
    collectionMode: "api",
    provenancePrefixes: ["dataforseo:chat_gpt:llm_responses/live"],
  },
  openai_gpt: {
    label: "OpenAI Responses API + web_search",
    provider: "OpenAI",
    productSurface: "Responses API with web_search",
    surfaceClass: "api_model",
    collectionMode: "api",
    provenancePrefixes: ["openai:responses:"],
  },
  dataforseo_gemini: {
    label: "Gemini model via DataForSEO LLM Responses API",
    provider: "DataForSEO",
    productSurface: "LLM Responses API proxy — Gemini model",
    surfaceClass: "api_model",
    collectionMode: "api",
    provenancePrefixes: ["dataforseo:gemini:llm_responses/live"],
  },
  google_gemini: {
    label: "Google Gemini API + google_search",
    provider: "Google",
    productSurface: "Gemini generateContent API with google_search",
    surfaceClass: "api_model",
    collectionMode: "api",
    provenancePrefixes: ["google:generativelanguage:"],
  },
  dataforseo_claude: {
    label: "Claude model via DataForSEO LLM Responses API",
    provider: "DataForSEO",
    productSurface: "LLM Responses API proxy — Claude model",
    surfaceClass: "api_model",
    collectionMode: "api",
    provenancePrefixes: ["dataforseo:claude:llm_responses/live"],
  },
  anthropic_claude: {
    label: "Anthropic Messages API + web_search",
    provider: "Anthropic",
    productSurface: "Messages API with web_search",
    surfaceClass: "api_model",
    collectionMode: "api",
    provenancePrefixes: ["anthropic:messages:"],
  },
  dataforseo_perplexity: {
    label: "Perplexity model via DataForSEO LLM Responses API",
    provider: "DataForSEO",
    productSurface: "LLM Responses API proxy — Perplexity model",
    surfaceClass: "api_model",
    collectionMode: "api",
    provenancePrefixes: ["dataforseo:perplexity:llm_responses/live"],
  },
  dataforseo_google_aio: {
    label: "Google AI Overview via DataForSEO SERP API",
    provider: "DataForSEO",
    productSurface: "Google organic SERP API — AI Overview",
    surfaceClass: "serp_feature",
    collectionMode: "api",
    provenancePrefixes: ["dataforseo:serp:google/organic/live/advanced:aio:"],
  },
};

export interface EvidenceCohort {
  engine: string;
  label: string;
  provider: string;
  productSurface: string;
  surfaceClass: SurfaceClass;
  collectionMode: string;
  provenance: string;
  modelVersions: string[];
  accountState: string;
  personalizationState: string;
  targetCountry: string;
  exitCountry: string;
  geoVerification: string;
  locationStatus: string;
  browserLocale: string;
  timezoneId: string;
  observations: number;
  successful: number;
  errors: number;
  contextRows: number;
  captureReferences: number;
  evidenceHashes: number;
  verifiedArtifacts: number;
  observedFrom: string;
  observedTo: string;
  evidenceTier:
    | "ui-ip-artifact-verified"
    | "ui-provider-artifact-verified"
    | "serp-provider-response"
    | "api-response"
    | "context-incomplete";
}

export interface SamplingDiagnostics {
  promptEngineCells: number;
  cellsWithErrors: number;
  repeatedSuccessfulCells: number;
  alwaysOwnedCitationCells: number;
  mixedOwnedCitationCells: number;
  neverOwnedCitationCells: number;
  minSuccessfulPerCell: number;
  maxSuccessfulPerCell: number;
}

export interface ReportCredibility {
  cohorts: EvidenceCohort[];
  sampling: SamplingDiagnostics;
  claimBoundary: string;
  blockers: string[];
}

interface CohortRow {
  engine: string;
  provenance: string;
  model_versions: string | null;
  surface_class: string | null;
  provider: string | null;
  product_surface: string | null;
  collection_mode: string | null;
  account_state: string | null;
  personalization_state: string | null;
  target_country: string | null;
  exit_country: string | null;
  geo_verification: string | null;
  location_status: string | null;
  browser_locale: string | null;
  timezone_id: string | null;
  observations: number;
  successful: number;
  errors: number;
  context_rows: number;
  capture_references: number;
  evidence_hashes: number;
  verified_artifacts: number;
  observed_from: string;
  observed_to: string;
}

interface SamplingRow {
  prompt_id: string;
  engine: string;
  successful: number;
  errors: number;
  owned_hits: number;
}

function scope(options: { runIds?: string[]; excludeEngines?: string[] }): {
  sql: string;
  args: string[];
} {
  const runIds = options.runIds?.filter(Boolean) ?? [];
  const excluded = options.excludeEngines?.filter(Boolean) ?? [];
  return {
    sql:
      (runIds.length ? ` AND o.run_id IN (${runIds.map(() => "?").join(",")})` : "") +
      (excluded.length ? ` AND o.engine NOT IN (${excluded.map(() => "?").join(",")})` : ""),
    args: [...runIds, ...excluded],
  };
}

function requestedLocation(provenance: string): string {
  const value = provenance.match(/(?:^|:)loc=([^:]+)/)?.[1];
  return value ? `requested:${value}` : "not-recorded";
}

export function engineSurfaceLabel(engine: string, productSurface?: string | null): string {
  if (productSurface?.trim()) return productSurface.trim();
  return KNOWN_ENGINE_SURFACES[engine]?.label ?? `Unclassified surface (${engine})`;
}

function toCohort(row: CohortRow): EvidenceCohort {
  const declared = KNOWN_ENGINE_SURFACES[row.engine];
  const known = declared?.provenancePrefixes.some((prefix) => row.provenance.startsWith(prefix))
    ? declared
    : undefined;
  const hasContext = row.context_rows > 0;
  const hasCompleteConsumerContext =
    row.context_rows === row.observations &&
    row.capture_references === row.observations &&
    row.evidence_hashes === row.observations &&
    row.verified_artifacts === row.observations;
  const surfaceClass = (row.surface_class as SurfaceClass | null) ?? known?.surfaceClass ?? "unknown";
  const productSurface = row.product_surface ?? known?.productSurface ?? "not-recorded";
  const geoVerification = row.geo_verification ?? (known ? "request-parameter-only" : "unknown");
  const locationStatus = row.location_status ?? (known ? "not-independently-verified" : "unknown");

  let evidenceTier: EvidenceCohort["evidenceTier"] = "context-incomplete";
  if (surfaceClass === "consumer_web" && hasContext && hasCompleteConsumerContext) {
    if (row.geo_verification === "ip_observed" && row.location_status === "matched") {
      evidenceTier = "ui-ip-artifact-verified";
    } else if (row.geo_verification === "provider_asserted" && row.location_status === "matched") {
      evidenceTier = "ui-provider-artifact-verified";
    }
  } else if (surfaceClass === "serp_feature" && known) {
    evidenceTier = "serp-provider-response";
  } else if (surfaceClass === "api_model" && known) {
    evidenceTier = "api-response";
  }

  return {
    engine: row.engine,
    label:
      row.product_surface?.trim() ??
      known?.label ??
      `Unclassified surface (${row.engine}; provenance mismatch or unknown)`,
    provider: row.provider ?? known?.provider ?? "unknown",
    productSurface,
    surfaceClass,
    collectionMode: row.collection_mode ?? known?.collectionMode ?? "unknown",
    provenance: row.provenance,
    modelVersions: (row.model_versions ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .sort(),
    accountState: row.account_state ?? (known ? "not-applicable" : "unknown"),
    personalizationState:
      row.personalization_state ?? (known ? "not-applicable" : "unknown"),
    targetCountry: row.target_country ?? requestedLocation(row.provenance),
    exitCountry: row.exit_country ?? (known ? "not-applicable" : "unknown"),
    geoVerification,
    locationStatus,
    browserLocale: row.browser_locale ?? (known ? "not-applicable" : "unknown"),
    timezoneId: row.timezone_id ?? (known ? "not-applicable" : "unknown"),
    observations: row.observations,
    successful: row.successful,
    errors: row.errors,
    contextRows: row.context_rows,
    captureReferences: row.capture_references,
    evidenceHashes: row.evidence_hashes,
    verifiedArtifacts: row.verified_artifacts,
    observedFrom: row.observed_from,
    observedTo: row.observed_to,
    evidenceTier,
  };
}

export function buildReportCredibility(
  db: Ledger,
  promptSetId: string,
  options: { runIds?: string[]; excludeEngines?: string[] } = {},
): ReportCredibility {
  const scoped = scope(options);
  const cohortRows = db
    .prepare(
      `SELECT o.engine, o.provenance,
              GROUP_CONCAT(DISTINCT o.model_version) AS model_versions,
              s.surface_class, s.provider, s.product_surface, s.collection_mode,
              s.account_state, s.personalization_state, s.target_country, s.exit_country,
              s.geo_verification, s.location_status, s.browser_locale, s.timezone_id,
              COUNT(*) AS observations,
              SUM(CASE WHEN o.fidelity != 'error' THEN 1 ELSE 0 END) AS successful,
              SUM(CASE WHEN o.fidelity = 'error' THEN 1 ELSE 0 END) AS errors,
              COUNT(s.observation_id) AS context_rows,
              SUM(CASE WHEN s.capture_reference IS NOT NULL THEN 1 ELSE 0 END) AS capture_references,
              SUM(CASE WHEN s.evidence_sha256 IS NOT NULL THEN 1 ELSE 0 END) AS evidence_hashes,
              COUNT(av.observation_id) AS verified_artifacts,
              MIN(o.observed_at) AS observed_from,
              MAX(o.observed_at) AS observed_to
         FROM observation o
         JOIN prompt p ON p.id = o.prompt_id
         LEFT JOIN observation_surface_context s ON s.observation_id = o.id
         LEFT JOIN evidence_artifact_verification av ON av.observation_id = o.id
        WHERE p.prompt_set_id = ?${scoped.sql}
        GROUP BY o.engine, o.provenance, s.surface_class, s.provider, s.product_surface,
                 s.collection_mode, s.account_state, s.personalization_state,
                 s.target_country, s.exit_country, s.geo_verification, s.location_status,
                 s.browser_locale, s.timezone_id
        ORDER BY o.engine, o.provenance, s.product_surface`,
    )
    .all(promptSetId, ...scoped.args) as unknown as CohortRow[];

  const samplingRows = db
    .prepare(
      `SELECT o.prompt_id, o.engine,
              SUM(CASE WHEN o.fidelity != 'error' THEN 1 ELSE 0 END) AS successful,
              SUM(CASE WHEN o.fidelity = 'error' THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN o.fidelity != 'error' AND EXISTS (
                    SELECT 1 FROM citation c
                     WHERE c.observation_id = o.id AND c.ownership = 'owned'
                  ) THEN 1 ELSE 0 END) AS owned_hits
         FROM observation o
         JOIN prompt p ON p.id = o.prompt_id
        WHERE p.prompt_set_id = ?${scoped.sql}
        GROUP BY o.prompt_id, o.engine
        ORDER BY o.prompt_id, o.engine`,
    )
    .all(promptSetId, ...scoped.args) as unknown as SamplingRow[];

  const cohorts = cohortRows.map(toCohort);
  const repeated = samplingRows.filter((row) => row.successful >= 2);
  const successes = samplingRows.map((row) => row.successful);
  const sampling: SamplingDiagnostics = {
    promptEngineCells: samplingRows.length,
    cellsWithErrors: samplingRows.filter((row) => row.errors > 0).length,
    repeatedSuccessfulCells: repeated.length,
    alwaysOwnedCitationCells: repeated.filter((row) => row.owned_hits === row.successful).length,
    mixedOwnedCitationCells: repeated.filter(
      (row) => row.owned_hits > 0 && row.owned_hits < row.successful,
    ).length,
    neverOwnedCitationCells: repeated.filter((row) => row.owned_hits === 0).length,
    minSuccessfulPerCell: successes.length ? Math.min(...successes) : 0,
    maxSuccessfulPerCell: successes.length ? Math.max(...successes) : 0,
  };

  const blockers: string[] = [];
  if (!cohorts.length) blockers.push("报告范围内没有观测");
  for (const cohort of cohorts) {
    if (cohort.surfaceClass === "unknown") {
      blockers.push(`${cohort.engine} 的产品表面未分类`);
    }
    if (cohort.locationStatus === "mismatched") {
      blockers.push(`${cohort.engine} 的请求目标地域与实际执行地域不匹配`);
    }
    if (cohort.surfaceClass === "consumer_web") {
      if (cohort.contextRows !== cohort.observations) {
        blockers.push(`${cohort.engine} 的网页表面上下文覆盖不完整`);
      }
      if (cohort.locationStatus === "unverified" || cohort.locationStatus === "unknown") {
        blockers.push(`${cohort.engine} 的目标地域未匹配`);
      }
      if (cohort.captureReferences !== cohort.observations) {
        blockers.push(`${cohort.engine} 缺少逐条捕获引用`);
      }
      if (cohort.evidenceHashes !== cohort.observations) {
        blockers.push(`${cohort.engine} 缺少逐条证据 hash`);
      }
      if (cohort.verifiedArtifacts !== cohort.observations) {
        blockers.push(`${cohort.engine} 的本地捕获 artifact 尚未逐条通过文件 SHA 校验`);
      }
    }
  }

  const surfaceClasses = [...new Set(cohorts.map((cohort) => cohort.surfaceClass))];
  const claimBoundary =
    surfaceClasses.length === 1 && surfaceClasses[0] === "consumer_web"
      ? "消费级网页产品表面的描述性观测；不等于总体用户体验、排名、推荐、流量或因果提升。"
      : surfaceClasses.length === 1 && surfaceClasses[0] === "api_model"
        ? "API/模型代理表面的描述性观测；不能外推为对应消费级网页产品的覆盖率或排名。"
        : surfaceClasses.length === 1 && surfaceClasses[0] === "serp_feature"
          ? "SERP 功能表面的描述性观测；不能外推为聊天产品、自然排名、流量或因果提升。"
          : "多个产品表面的合并描述；表面间差异可能影响结果，不能把合并比例当作任一消费产品的覆盖率。";

  return { cohorts, sampling, claimBoundary, blockers: [...new Set(blockers)] };
}

export interface ReportEvidenceEnvelope {
  schemaVersion: typeof REPORT_EVIDENCE_SCHEMA;
  reportKind: "attribution" | "landscape";
  publicationStatus: ReportPublicationStatus;
  publicationGate: PublicationGate;
  blockers: string[];
  promptSetId: string;
  promptSetHash: string | null;
  parserVersion: string;
  denominator: "all-successful-observations";
  scope: { runIds?: string[]; excludedEngines?: string[] };
  metrics: Record<string, number | string | null>;
  credibility: ReportCredibility;
}

export function createReportEvidenceEnvelope(input: {
  reportKind: ReportEvidenceEnvelope["reportKind"];
  promptSetId: string;
  promptSetHash?: string | null;
  parserVersion: string;
  scope: ReportEvidenceEnvelope["scope"];
  metrics: ReportEvidenceEnvelope["metrics"];
  credibility: ReportCredibility;
}): { envelope: ReportEvidenceEnvelope; canonical: string; fingerprint: string } {
  const blockers = [...input.credibility.blockers];
  if (!input.promptSetHash) blockers.push("prompt 集未冻结或未提供 hash");
  if (!input.scope.runIds?.length) blockers.push("报告未显式固定 run IDs");
  const uniqueBlockers = [...new Set(blockers)];
  const envelope: ReportEvidenceEnvelope = {
    schemaVersion: REPORT_EVIDENCE_SCHEMA,
    reportKind: input.reportKind,
    publicationStatus: uniqueBlockers.length ? "internal-only" : "descriptive-only",
    publicationGate: uniqueBlockers.length ? "block" : "pass",
    blockers: uniqueBlockers,
    promptSetId: input.promptSetId,
    promptSetHash: input.promptSetHash ?? null,
    parserVersion: input.parserVersion,
    denominator: "all-successful-observations",
    scope: input.scope,
    metrics: input.metrics,
    credibility: input.credibility,
  };
  const canonical = canonicalJson(envelope);
  return { envelope, canonical, fingerprint: sha256(canonical) };
}

export function reportEvidenceHead(input: {
  envelope: ReportEvidenceEnvelope;
  canonical: string;
  fingerprint: string;
}): string {
  const safeJson = input.canonical.replace(/</g, "\\u003c");
  return [
    `<meta name="geo-proof-report-schema" content="${REPORT_EVIDENCE_SCHEMA}">`,
    `<meta name="geo-proof-report-status" content="${input.envelope.publicationStatus}">`,
    `<meta name="geo-proof-publication-gate" content="${input.envelope.publicationGate}">`,
    `<meta name="geo-proof-evidence-sha256" content="${input.fingerprint}">`,
    `<script type="application/json" id="geo-proof-evidence">${safeJson}</script>`,
  ].join("\n");
}

function documentHashMeta(hash: string): string {
  return `<meta name="geo-proof-document-sha256" content="${hash}">`;
}

/**
 * 给整份 HTML 加可复算指纹。已存在指纹时会刷新，所以 publish 注入 noindex 后
 * 仍能生成一份自洽文件。该指纹防止可见文案被单独改写，但不证明上游响应真实。
 */
export function finalizeReportDocument(html: string): string {
  let normalized = html.replace(
    /<meta\s+name=["']geo-proof-document-sha256["']\s+content=["'][a-f0-9]{64}["']\s*>/i,
    documentHashMeta(REPORT_DOCUMENT_HASH_PLACEHOLDER),
  );
  if (!normalized.includes(REPORT_DOCUMENT_HASH_PLACEHOLDER)) {
    if (!/<head[^>]*>/i.test(normalized)) throw new Error("报告 HTML 缺少 <head>");
    normalized = normalized.replace(
      /<head[^>]*>/i,
      (match) => `${match}\n${documentHashMeta(REPORT_DOCUMENT_HASH_PLACEHOLDER)}`,
    );
  }
  const fingerprint = sha256(normalized);
  return normalized.replace(REPORT_DOCUMENT_HASH_PLACEHOLDER, fingerprint);
}

export function assertReportDocumentFingerprint(html: string): void {
  const match = html.match(
    /<meta\s+name=["']geo-proof-document-sha256["']\s+content=["']([a-f0-9]{64})["']\s*>/i,
  );
  if (!match?.[1]) throw new Error("报告缺少整份 HTML 指纹；请重新生成");
  const normalized = html.replace(match[0], documentHashMeta(REPORT_DOCUMENT_HASH_PLACEHOLDER));
  if (sha256(normalized) !== match[1]) {
    throw new Error("整份 HTML 指纹不匹配；可见内容可能被改写或文件已损坏");
  }
}

export function parseReportEvidenceEnvelope(html: string): ReportEvidenceEnvelope {
  const script = html.match(
    /<script\s+type=["']application\/json["']\s+id=["']geo-proof-evidence["']>([\s\S]*?)<\/script>/i,
  )?.[1];
  if (!script) throw new Error("报告缺少机器可读证据封套");
  let parsed: unknown;
  try {
    parsed = JSON.parse(script);
  } catch {
    throw new Error("报告证据封套不是有效 JSON");
  }
  const record = parsed as Partial<ReportEvidenceEnvelope>;
  if (
    record.schemaVersion !== REPORT_EVIDENCE_SCHEMA ||
    (record.reportKind !== "attribution" && record.reportKind !== "landscape") ||
    typeof record.promptSetId !== "string" ||
    typeof record.parserVersion !== "string" ||
    !record.credibility ||
    !record.metrics ||
    !record.scope
  ) {
    throw new Error("报告证据封套字段不完整或版本不受支持");
  }
  return parsed as ReportEvidenceEnvelope;
}
