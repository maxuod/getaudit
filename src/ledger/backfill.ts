import type { Ledger } from "../db/index.ts";
import { inTransaction } from "../db/index.ts";
import { PARSER_VERSION } from "./repo.ts";

/**
 * 为历史观测生成解释 —— 重新解析已保存的 raw_response。
 *
 * 这是 append-only + 原始响应整条入库的第二次回报：
 * 当初的解析逻辑有缺陷（用 citations 同时推断"是否检索"和"是否引用"），
 * 但因为原文还在，今天可以用正确的口径重新解释，而不必重新采集。
 *
 * 观测行本身一个字都不改 —— 解释写进独立的版本化表。
 */

interface RawRow {
  id: string;
  engine: string;
  fidelity: string;
  raw_response: string | null;
  citation_count: number;
}

export interface BackfillResult {
  totalObservations: number;
  scanned: number;
  written: number;
  skipped: number;
  covered: number;
  byStatus: Record<string, number>;
  /** 上游明确报告检索状态的比例 —— 越高说明结论越可靠 */
  withUpstreamRetrieval: number;
}

/** 从 DataForSEO llm_responses 的原文里取 web_search 字段。 */
function readWebSearch(payload: unknown): boolean | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const tasks = (payload as { tasks?: Array<{ result?: unknown }> }).tasks;
  for (const task of tasks ?? []) {
    for (const result of (task.result ?? []) as Array<Record<string, unknown>>) {
      if (typeof result?.["web_search"] === "boolean") return result["web_search"] as boolean;
    }
  }
  return undefined;
}

/** SERP 响应里是否存在 ai_overview 块。 */
function hasAioBlock(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const tasks = (payload as { tasks?: Array<{ result?: unknown }> }).tasks;
  for (const task of tasks ?? []) {
    for (const result of (task.result ?? []) as Array<{ items?: Array<{ type?: string }> }>) {
      for (const item of result?.items ?? []) {
        if (item?.type === "ai_overview") return true;
      }
    }
  }
  return false;
}

export function backfillInterpretations(db: Ledger): BackfillResult {
  const totalObservations = (
    db.prepare(`SELECT COUNT(*) AS n FROM observation`).get() as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT o.id, o.engine, o.fidelity, o.raw_response,
              (SELECT COUNT(*) FROM citation c WHERE c.observation_id = o.id) AS citation_count
         FROM observation o
        WHERE NOT EXISTS (
          SELECT 1 FROM observation_interpretation i
           WHERE i.observation_id = o.id AND i.parser_version = ?
        )`,
    )
    .all(PARSER_VERSION) as unknown as RawRow[];

  const insert = db.prepare(
    `INSERT INTO observation_interpretation
       (observation_id, parser_version, retrieval_used, surface_present, extraction_status)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const byStatus: Record<string, number> = {};
  let written = 0;
  const skipped = totalObservations - rows.length;
  let withUpstream = 0;

  inTransaction(db, () => {
    for (const row of rows) {
      let payload: unknown = null;
      if (row.raw_response) {
        try {
          payload = JSON.parse(row.raw_response);
        } catch {
          payload = null;
        }
      }

      let retrievalUsed: boolean | undefined;
      let surfacePresent: boolean | undefined;
      let status: string;

      if (row.fidelity === "error") {
        status = "not_applicable";
      } else if (row.engine.includes("aio")) {
        // AIO：SERP 调用成功即代表 Google 完成检索；AIO 展不展示是另一回事
        retrievalUsed = true;
        surfacePresent = payload ? hasAioBlock(payload) : undefined;
        status = !surfacePresent
          ? "not_applicable"
          : row.citation_count > 0
            ? "extracted"
            : "no_extraction";
      } else if (row.engine.startsWith("dataforseo_")) {
        // 上游明确报告了检索状态
        retrievalUsed = payload ? readWebSearch(payload) : undefined;
        if (retrievalUsed !== undefined) withUpstream += 1;
        status = row.citation_count > 0 ? "extracted" : "no_extraction";
      } else if (!payload) {
        // 直连引擎且原文缺失 —— 无法断言，如实标注
        status = "unrecoverable_legacy";
      } else {
        // 直连引擎：上游不报告检索状态，只能降级推断
        retrievalUsed = row.citation_count > 0 ? true : undefined;
        status = row.citation_count > 0 ? "extracted" : "no_extraction";
      }

      insert.run(
        row.id,
        PARSER_VERSION,
        retrievalUsed === undefined ? null : retrievalUsed ? 1 : 0,
        surfacePresent === undefined ? null : surfacePresent ? 1 : 0,
        status,
      );
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      written += 1;
    }
  });

  const covered = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM observation_interpretation WHERE parser_version = ?`,
      )
      .get(PARSER_VERSION) as { n: number }
  ).n;
  if (covered !== totalObservations) {
    throw new Error(
      `回填覆盖校验失败：parser ${PARSER_VERSION} 覆盖 ${covered}/${totalObservations} 条观测`,
    );
  }

  return {
    totalObservations,
    scanned: rows.length,
    written,
    skipped,
    covered,
    byStatus,
    withUpstreamRetrieval: withUpstream,
  };
}
