import type { Ledger } from "../db/index.ts";
import { buildAttributionReport } from "./attribution.ts";

/**
 * Prompt 级别报告 —— 逐条问题看谁赢了。
 *
 * 聚合指标（引用率 12%）告诉客户「有问题」，
 * 这份告诉客户「问题在哪一条上、输给了谁」——那才是能直接转成动作的东西。
 * 也是最好的内容素材：具体的问题 + 具体的赢家，比任何百分比都有说服力。
 */

export interface PromptRow {
  text: string;
  usable: number;
  ownedHits: number;
  hitRate: number;
  mentions: number;
  /** 该问题下被引用最多的第三方域名 */
  topRivals: Array<{ domain: string; citations: number }>;
  /** 有引用该问题的引擎（用于判断是不是只在某一个面上赢） */
  enginesWithHit: string[];
}

export interface PromptsReport {
  brandName: string;
  rows: PromptRow[];
  totalUsable: number;
}

export function buildPromptsReport(
  db: Ledger,
  promptSetId: string,
  options: {
    parserVersion: string;
    runIds?: readonly string[];
    excludeEngines?: readonly string[];
    topRivals?: number;
  },
): PromptsReport {
  const runIds = options.runIds?.filter(Boolean) ?? [];
  const excluded = options.excludeEngines?.filter(Boolean) ?? [];
  const scopeSql =
    (runIds.length ? ` AND o.run_id IN (${runIds.map(() => "?").join(",")})` : "") +
    (excluded.length ? ` AND o.engine NOT IN (${excluded.map(() => "?").join(",")})` : "");
  const scopeArgs = [...runIds, ...excluded];
  const topN = options.topRivals ?? 3;
  buildAttributionReport(db, promptSetId, {
    parserVersion: options.parserVersion,
    runIds: [...runIds],
    excludeEngines: [...excluded],
  });

  const meta = db
    .prepare(
      `SELECT b.name FROM prompt_set ps JOIN brand b ON b.id = ps.brand_id WHERE ps.id = ?`,
    )
    .get(promptSetId) as { name: string } | undefined;

  // 不 JOIN citation：用 EXISTS 判断有无自有引用，避免行数膨胀
  const base = db
    .prepare(
      `SELECT p.id, p.text,
              SUM(CASE WHEN o.fidelity != 'error' THEN 1 ELSE 0 END) AS usable,
              SUM(CASE WHEN o.fidelity != 'error' AND EXISTS (
                    SELECT 1 FROM citation c
                     WHERE c.observation_id = o.id AND c.ownership = 'owned'
                  ) THEN 1 ELSE 0 END) AS owned_hits,
              SUM(CASE WHEN o.fidelity != 'error' AND o.brand_mentioned = 1
                       THEN 1 ELSE 0 END) AS mentions
         FROM prompt p
         LEFT JOIN observation o ON o.prompt_id = p.id${scopeSql.replace(/ AND /g, " AND ")}
        WHERE p.prompt_set_id = ?
        GROUP BY p.id
        ORDER BY owned_hits DESC, usable DESC`,
    )
    .all(...scopeArgs, promptSetId) as Array<{
    id: string;
    text: string;
    usable: number;
    owned_hits: number;
    mentions: number;
  }>;

  const rivalStmt = db.prepare(
    `SELECT c.domain, COUNT(*) AS citations
       FROM citation c
       JOIN observation o ON o.id = c.observation_id
      WHERE o.prompt_id = ? AND o.fidelity != 'error'
        AND c.ownership = 'third_party'${scopeSql}
      GROUP BY c.domain ORDER BY citations DESC LIMIT ?`,
  );

  const engineStmt = db.prepare(
    `SELECT DISTINCT o.engine
       FROM observation o
      WHERE o.prompt_id = ? AND o.fidelity != 'error'
        AND EXISTS (SELECT 1 FROM citation c
                     WHERE c.observation_id = o.id AND c.ownership = 'owned')${scopeSql}`,
  );

  const rows: PromptRow[] = base.map((row) => ({
    text: row.text,
    usable: row.usable,
    ownedHits: row.owned_hits,
    hitRate: row.usable > 0 ? row.owned_hits / row.usable : 0,
    mentions: row.mentions,
    topRivals: rivalStmt.all(row.id, ...scopeArgs, topN) as unknown as Array<{
      domain: string;
      citations: number;
    }>,
    enginesWithHit: (
      engineStmt.all(row.id, ...scopeArgs) as unknown as Array<{ engine: string }>
    ).map((e) => e.engine),
  }));

  return {
    brandName: meta?.name ?? "(未知品牌)",
    rows,
    totalUsable: rows.reduce((sum, row) => sum + row.usable, 0),
  };
}

export function renderPromptsReport(report: PromptsReport): string {
  const lines: string[] = [];
  lines.push(`逐问题报告 —— ${report.brandName}`);
  lines.push("=".repeat(88));
  lines.push("");

  const won = report.rows.filter((r) => r.hitRate >= 0.5 && r.usable > 0);
  const partial = report.rows.filter((r) => r.ownedHits > 0 && r.hitRate < 0.5);
  const lost = report.rows.filter((r) => r.ownedHits === 0);

  const block = (title: string, rows: PromptRow[], showRivals: boolean): void => {
    if (!rows.length) return;
    lines.push(title);
    lines.push("-".repeat(88));
    for (const row of rows) {
      const rate = row.usable > 0 ? `${row.ownedHits}/${row.usable}` : "无可用观测";
      lines.push(`${rate.padStart(7)}  ${row.text}`);
      if (showRivals && row.topRivals.length) {
        lines.push(
          `         输给：${row.topRivals.map((r) => `${r.domain}(${r.citations})`).join("  ")}`,
        );
      } else if (row.enginesWithHit.length) {
        lines.push(`         命中引擎：${row.enginesWithHit.join(", ")}`);
      }
    }
    lines.push("");
  };

  block(`✅ 本轮高命中（描述性引用率 ≥50%）—— ${won.length} 条`, won, false);
  block(`⚠️  偶尔命中（<50%）—— ${partial.length} 条`, partial, true);
  block(`❌ 完全不在场 —— ${lost.length} 条`, lost, true);

  lines.push("=".repeat(88));
  lines.push(
    `合计 ${report.rows.length} 条问题：本轮高命中 ${won.length} · 偶尔 ${partial.length} · 零命中 ${lost.length}`,
  );
  return lines.join("\n");
}
