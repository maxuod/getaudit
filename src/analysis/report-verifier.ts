import { readFileSync } from "node:fs";
import type { Ledger } from "../db/index.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import { getPromptSet } from "../ledger/repo.ts";
import { assertReportHtmlPublishable } from "../publish.ts";
import { buildAttributionReport } from "./attribution.ts";
import {
  buildReportCredibility,
  parseReportEvidenceEnvelope,
  type ReportEvidenceEnvelope,
} from "./report-credibility.ts";

export interface LedgerReportVerification {
  reportKind: ReportEvidenceEnvelope["reportKind"];
  promptSetId: string;
  runIds: string[];
  ledgerEvidenceSha256: string;
  checks: string[];
}

function expectedLandscapeMetrics(
  db: Ledger,
  envelope: ReportEvidenceEnvelope,
): Record<string, number> {
  const runIds = envelope.scope.runIds ?? [];
  const excluded = envelope.scope.excludedEngines ?? [];
  const scopeSql =
    (runIds.length ? ` AND o.run_id IN (${runIds.map(() => "?").join(",")})` : "") +
    (excluded.length ? ` AND o.engine NOT IN (${excluded.map(() => "?").join(",")})` : "");
  const scopeArgs = [...runIds, ...excluded];
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN o.fidelity != 'error' THEN 1 ELSE 0 END) AS successful,
              SUM(CASE WHEN o.fidelity != 'error' THEN (
                SELECT COUNT(*) FROM citation c WHERE c.observation_id = o.id
              ) ELSE 0 END) AS citations
         FROM observation o
         JOIN prompt p ON p.id = o.prompt_id
        WHERE p.prompt_set_id = ?${scopeSql}`,
    )
    .get(envelope.promptSetId, ...scopeArgs) as {
    total: number;
    successful: number | null;
    citations: number | null;
  };
  const promptCount = db
    .prepare(`SELECT COUNT(*) AS n FROM prompt WHERE prompt_set_id = ?`)
    .get(envelope.promptSetId) as { n: number };
  return {
    totalObservations: counts.total,
    successfulObservations: counts.successful ?? 0,
    totalCitations: counts.citations ?? 0,
    promptCount: promptCount.n,
  };
}

function expectedAttributionMetrics(
  db: Ledger,
  envelope: ReportEvidenceEnvelope,
): Record<string, number> {
  const report = buildAttributionReport(db, envelope.promptSetId, {
    parserVersion: envelope.parserVersion,
    runIds: envelope.scope.runIds,
    excludeEngines: envelope.scope.excludedEngines,
  });
  return {
    totalObservations: report.totalObservations,
    successfulObservations: report.successfulObservations,
    errors: report.errors,
    ownedCitationRate: report.ownedCitationRate,
    brandMentionRate: report.brandMentionRate,
    ownedCitationShare: report.ownedCitationShare,
  };
}

/**
 * 在发布前把报告封套重新对照当前台账。文件指纹只能发现文件改写；这里额外
 * 证明封套中的 prompt hash、run scope、聚合指标和上下文可以由指定台账复算。
 */
export function verifyReportHtmlAgainstLedger(
  db: Ledger,
  html: string,
): LedgerReportVerification {
  assertReportHtmlPublishable(html);
  const envelope = parseReportEvidenceEnvelope(html);
  const runIds = envelope.scope.runIds ?? [];
  if (!runIds.length) throw new Error("台账复算要求报告显式固定 run IDs");

  const set = getPromptSet(db, envelope.promptSetId);
  if (!set.frozen_hash || set.frozen_hash !== envelope.promptSetHash) {
    throw new Error("报告 prompt hash 与当前台账不一致");
  }
  const runRows = db
    .prepare(
      `SELECT id, prompt_set_id, finished_at FROM collection_run
        WHERE id IN (${runIds.map(() => "?").join(",")}) ORDER BY id`,
    )
    .all(...runIds) as Array<{ id: string; prompt_set_id: string; finished_at: string | null }>;
  if (
    runRows.length !== runIds.length ||
    runRows.some((row) => row.prompt_set_id !== envelope.promptSetId)
  ) {
    throw new Error("报告包含不存在或属于其他 prompt 集的 run");
  }
  if (runRows.some((row) => !row.finished_at)) {
    throw new Error("报告包含尚未封存的 run；不能进入发布门禁");
  }

  const expectedMetrics =
    envelope.reportKind === "attribution"
      ? expectedAttributionMetrics(db, envelope)
      : expectedLandscapeMetrics(db, envelope);
  if (canonicalJson(expectedMetrics) !== canonicalJson(envelope.metrics)) {
    throw new Error(
      `报告指标不能由台账复算：expected=${canonicalJson(expectedMetrics)} actual=${canonicalJson(envelope.metrics)}`,
    );
  }

  const expectedCredibility = buildReportCredibility(db, envelope.promptSetId, {
    runIds,
    excludeEngines: envelope.scope.excludedEngines,
  });
  if (canonicalJson(expectedCredibility) !== canonicalJson(envelope.credibility)) {
    throw new Error("报告证据上下文不能由台账复算");
  }

  const ledgerEvidenceSha256 = sha256(
    canonicalJson({
      reportKind: envelope.reportKind,
      promptSetId: envelope.promptSetId,
      promptSetHash: envelope.promptSetHash,
      parserVersion: envelope.parserVersion,
      scope: envelope.scope,
      metrics: expectedMetrics,
      credibility: expectedCredibility,
    }),
  );
  return {
    reportKind: envelope.reportKind,
    promptSetId: envelope.promptSetId,
    runIds,
    ledgerEvidenceSha256,
    checks: [
      "document-fingerprint",
      "evidence-envelope-fingerprint",
      "prompt-set-hash",
      "run-scope",
      "ledger-metrics",
      "surface-context",
    ],
  };
}

export function verifyReportFileAgainstLedger(
  db: Ledger,
  filePath: string,
): LedgerReportVerification {
  return verifyReportHtmlAgainstLedger(db, readFileSync(filePath, "utf8"));
}
