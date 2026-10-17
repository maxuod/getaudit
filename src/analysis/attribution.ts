import type { Ledger } from "../db/index.ts";

export interface DomainStat {
  domain: string;
  citations: number;
  observationsWithDomain: number;
  shareOfObservations: number;
}

export interface EngineStat {
  engine: string;
  observations: number;
  successful: number;
  retrievalKnown: number;
  retrievalUsed: number;
  surfaceKnown: number;
  surfacePresent: number;
  errors: number;
  brandMentionRate: number;
  ownedCitationRate: number;
  conditionalOwnedCitationRate: number | null;
  avgCitationsPerObservation: number;
}

export interface AttributionReport {
  promptSetId: string;
  brandName: string;
  parserVersion: string;
  totalObservations: number;
  successfulObservations: number;
  /** 兼容旧渲染器；语义已改为全部成功调用，不再是 web_grounded。 */
  usableObservations: number;
  errors: number;
  retrievalKnownObservations: number;
  retrievalUsedObservations: number;
  surfaceKnownObservations: number;
  surfacePresentObservations: number;
  interpretationBreakdown: Record<string, number>;
  brandMentionRate: number;
  /** 主指标：出现自有引用的回答 / 全部成功调用。 */
  ownedCitationRate: number;
  /** 条件指标：出现自有引用且发生检索 / 明确发生检索。 */
  conditionalOwnedCitationRate: number | null;
  /** AIO 条件指标：出现自有引用且 AIO 展示 / AIO 展示。 */
  surfaceConditionalOwnedCitationRate: number | null;
  ownedCitationShare: number;
  topThirdPartyDomains: DomainStat[];
  perEngine: EngineStat[];
  scope: { runIds?: string[]; excludedEngines?: string[] };
}

export interface AttributionOptions {
  /** 必填：报告必须把解释口径固定到一个可复现的 parser 版本。 */
  parserVersion: string;
  topN?: number;
  runIds?: string[];
  excludeEngines?: string[];
}

interface ObservationRow {
  id: string;
  engine: string;
  fidelity: string;
  brand_mentioned: number;
  retrieval_used: number | null;
  surface_present: number | null;
  extraction_status: string | null;
  owned_hit: number;
  citation_count: number;
}

const rate = (numerator: number, denominator: number): number =>
  denominator > 0 ? numerator / denominator : 0;

export function buildAttributionReport(
  db: Ledger,
  promptSetId: string,
  options: AttributionOptions,
): AttributionReport {
  if (!options?.parserVersion?.trim()) throw new Error("报告必须显式指定 parserVersion");
  const topN = options.topN ?? 25;
  const runIds = options.runIds?.filter(Boolean) ?? [];
  const excluded = options.excludeEngines?.filter(Boolean) ?? [];
  const scopeSql =
    (runIds.length ? ` AND o.run_id IN (${runIds.map(() => "?").join(",")})` : "") +
    (excluded.length ? ` AND o.engine NOT IN (${excluded.map(() => "?").join(",")})` : "");
  const scopeArgs = [...runIds, ...excluded];

  const meta = db
    .prepare(
      `SELECT ps.id AS prompt_set_id, b.name AS brand_name
         FROM prompt_set ps JOIN brand b ON b.id = ps.brand_id WHERE ps.id = ?`,
    )
    .get(promptSetId) as { prompt_set_id: string; brand_name: string } | undefined;
  if (!meta) throw new Error(`prompt 集不存在: ${promptSetId}`);

  const rows = db
    .prepare(
      `SELECT o.id, o.engine, o.fidelity, o.brand_mentioned,
              i.retrieval_used, i.surface_present, i.extraction_status,
              EXISTS(SELECT 1 FROM citation c
                       WHERE c.observation_id = o.id AND c.ownership = 'owned') AS owned_hit,
              (SELECT COUNT(*) FROM citation c WHERE c.observation_id = o.id) AS citation_count
         FROM observation o
         JOIN prompt p ON p.id = o.prompt_id
         LEFT JOIN observation_interpretation i
           ON i.observation_id = o.id AND i.parser_version = ?
        WHERE p.prompt_set_id = ?${scopeSql}
        ORDER BY o.engine, o.id`,
    )
    .all(options.parserVersion, promptSetId, ...scopeArgs) as unknown as ObservationRow[];

  const missing = rows.filter((row) => row.extraction_status === null).length;
  if (missing) {
    throw new Error(
      `parser ${options.parserVersion} 缺少 ${missing}/${rows.length} 条解释；先运行 backfill，报告不会静默剔除`,
    );
  }

  const successful = rows.filter((row) => row.fidelity !== "error");
  const retrievalKnown = successful.filter((row) => row.retrieval_used !== null);
  const retrievalUsed = successful.filter((row) => row.retrieval_used === 1);
  const surfaceKnown = successful.filter((row) => row.surface_present !== null);
  const surfacePresent = successful.filter((row) => row.surface_present === 1);
  const owned = successful.filter((row) => row.owned_hit === 1);

  const breakdown: Record<string, number> = {};
  for (const row of rows) {
    const key = row.extraction_status ?? "missing";
    breakdown[key] = (breakdown[key] ?? 0) + 1;
  }

  const domainRows = db
    .prepare(
      `SELECT c.domain, COUNT(*) AS citations, COUNT(DISTINCT o.id) AS observations_with_domain
         FROM citation c
         JOIN observation o ON o.id = c.observation_id
         JOIN prompt p ON p.id = o.prompt_id
         JOIN observation_interpretation i
           ON i.observation_id = o.id AND i.parser_version = ?
        WHERE p.prompt_set_id = ? AND o.fidelity != 'error'
          AND c.ownership = 'third_party'${scopeSql}
        GROUP BY c.domain ORDER BY citations DESC LIMIT ?`,
    )
    .all(options.parserVersion, promptSetId, ...scopeArgs, topN) as unknown as Array<{
    domain: string;
    citations: number;
    observations_with_domain: number;
  }>;

  const citationSplit = db
    .prepare(
      `SELECT c.ownership, COUNT(*) AS n
         FROM citation c
         JOIN observation o ON o.id = c.observation_id
         JOIN prompt p ON p.id = o.prompt_id
         JOIN observation_interpretation i
           ON i.observation_id = o.id AND i.parser_version = ?
        WHERE p.prompt_set_id = ? AND o.fidelity != 'error'${scopeSql}
        GROUP BY c.ownership`,
    )
    .all(options.parserVersion, promptSetId, ...scopeArgs) as Array<{ ownership: string; n: number }>;
  const ownedCitations = citationSplit.find((row) => row.ownership === "owned")?.n ?? 0;
  const thirdPartyCitations = citationSplit.find((row) => row.ownership === "third_party")?.n ?? 0;

  const engineNames = [...new Set(rows.map((row) => row.engine))].sort();
  const perEngine: EngineStat[] = engineNames.map((engine) => {
    const engineRows = rows.filter((row) => row.engine === engine);
    const engineSuccessful = engineRows.filter((row) => row.fidelity !== "error");
    const engineRetrievalKnown = engineSuccessful.filter((row) => row.retrieval_used !== null);
    const engineRetrievalUsed = engineSuccessful.filter((row) => row.retrieval_used === 1);
    const engineSurfaceKnown = engineSuccessful.filter((row) => row.surface_present !== null);
    const engineSurfacePresent = engineSuccessful.filter((row) => row.surface_present === 1);
    const engineOwned = engineSuccessful.filter((row) => row.owned_hit === 1);
    const retrievalOwned = engineRetrievalUsed.filter((row) => row.owned_hit === 1);
    return {
      engine,
      observations: engineRows.length,
      successful: engineSuccessful.length,
      retrievalKnown: engineRetrievalKnown.length,
      retrievalUsed: engineRetrievalUsed.length,
      surfaceKnown: engineSurfaceKnown.length,
      surfacePresent: engineSurfacePresent.length,
      errors: engineRows.length - engineSuccessful.length,
      brandMentionRate: rate(
        engineSuccessful.filter((row) => row.brand_mentioned === 1).length,
        engineSuccessful.length,
      ),
      ownedCitationRate: rate(engineOwned.length, engineSuccessful.length),
      conditionalOwnedCitationRate: engineRetrievalUsed.length
        ? rate(retrievalOwned.length, engineRetrievalUsed.length)
        : null,
      avgCitationsPerObservation: rate(
        engineSuccessful.reduce((sum, row) => sum + row.citation_count, 0),
        engineSuccessful.length,
      ),
    };
  });

  return {
    promptSetId,
    brandName: meta.brand_name,
    parserVersion: options.parserVersion,
    totalObservations: rows.length,
    successfulObservations: successful.length,
    usableObservations: successful.length,
    errors: rows.length - successful.length,
    retrievalKnownObservations: retrievalKnown.length,
    retrievalUsedObservations: retrievalUsed.length,
    surfaceKnownObservations: surfaceKnown.length,
    surfacePresentObservations: surfacePresent.length,
    interpretationBreakdown: breakdown,
    brandMentionRate: rate(
      successful.filter((row) => row.brand_mentioned === 1).length,
      successful.length,
    ),
    ownedCitationRate: rate(owned.length, successful.length),
    conditionalOwnedCitationRate: retrievalUsed.length
      ? rate(retrievalUsed.filter((row) => row.owned_hit === 1).length, retrievalUsed.length)
      : null,
    surfaceConditionalOwnedCitationRate: surfacePresent.length
      ? rate(surfacePresent.filter((row) => row.owned_hit === 1).length, surfacePresent.length)
      : null,
    ownedCitationShare: rate(ownedCitations, ownedCitations + thirdPartyCitations),
    topThirdPartyDomains: domainRows.map((row) => ({
      domain: row.domain,
      citations: row.citations,
      observationsWithDomain: row.observations_with_domain,
      shareOfObservations: rate(row.observations_with_domain, successful.length),
    })),
    perEngine,
    scope: {
      runIds: runIds.length ? runIds : undefined,
      excludedEngines: excluded.length ? excluded : undefined,
    },
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const maybePct = (value: number | null): string => (value === null ? "不可判定" : pct(value));

export function renderAttributionReport(report: AttributionReport): string {
  const lines: string[] = [];
  lines.push(`引用面归属报告 —— ${report.brandName}`);
  lines.push("=".repeat(72));
  lines.push(`parser 版本     ${report.parserVersion}`);
  if (report.scope.runIds?.length) lines.push(`采集轮次        ${report.scope.runIds.join(", ")}`);
  if (report.scope.excludedEngines?.length) {
    lines.push(`已排除引擎      ${report.scope.excludedEngines.join(", ")}`);
  }
  lines.push(`总观测          ${report.totalObservations}`);
  lines.push(`成功调用        ${report.successfulObservations}（主指标分母）`);
  lines.push(`失败调用        ${report.errors}（单独披露，不进入成功分母）`);
  lines.push(
    `检索状态覆盖    ${report.retrievalKnownObservations}/${report.successfulObservations}；` +
      `明确检索 ${report.retrievalUsedObservations}`,
  );
  if (report.surfaceKnownObservations) {
    lines.push(
      `表面展示        ${report.surfacePresentObservations}/${report.surfaceKnownObservations}`,
    );
  }
  lines.push("");
  lines.push("核心指标（分母不可互换）");
  lines.push("-".repeat(72));
  lines.push(`品牌提及率 / 全部成功调用                ${pct(report.brandMentionRate)}`);
  lines.push(`自有引用率 / 全部成功调用（主指标）      ${pct(report.ownedCitationRate)}`);
  lines.push(
    `自有引用率 / 明确发生检索（条件指标）  ${maybePct(report.conditionalOwnedCitationRate)}`,
  );
  if (report.surfaceKnownObservations) {
    lines.push(
      `自有引用率 / AIO 已展示（条件指标）   ${maybePct(report.surfaceConditionalOwnedCitationRate)}`,
    );
  }
  lines.push(`自有链接 / 全部提取引用                  ${pct(report.ownedCitationShare)}`);
  lines.push("");
  lines.push("这些是描述性基线。第三方域名分布可生成待验证假设，不能单独证明渠道或页面造成引用。\n");

  lines.push(`第三方引用面 TOP ${report.topThirdPartyDomains.length}`);
  lines.push("-".repeat(72));
  for (const domain of report.topThirdPartyDomains) {
    lines.push(
      domain.domain.slice(0, 40).padEnd(42) +
        String(domain.citations).padStart(7) +
        pct(domain.shareOfObservations).padStart(10),
    );
  }
  lines.push("");
  lines.push("分引擎（成功分母 / 检索条件分母分开）");
  lines.push("-".repeat(72));
  for (const engine of report.perEngine) {
    lines.push(
      `${engine.engine}: 成功 ${engine.successful}/${engine.observations}；` +
        `检索 ${engine.retrievalUsed}/${engine.retrievalKnown}；` +
        `主引用率 ${pct(engine.ownedCitationRate)}；` +
        `检索条件引用率 ${maybePct(engine.conditionalOwnedCitationRate)}`,
    );
  }
  return lines.join("\n");
}
