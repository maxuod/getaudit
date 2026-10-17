import type { Ledger } from "../db/index.ts";

/**
 * 成本效率分析 + 预算估算。
 *
 * 这里的辅助指标不是「每次调用多少钱」，而是「每条检索明确出现的观测多少钱」。
 * 一个 6.8% 检索率的引擎，单价再便宜，买到的信息也贵 30 倍。
 * 采集预算应该按这个指标分配，而不是平均分给每个引擎。
 */

export interface EngineCostStat {
  engine: string;
  calls: number;
  costUsd: number;
  costPerCall: number;
  usable: number;
  usableRate: number;
  /** 每条旧字段标记为 web_grounded 的成本；仅用于预算诊断，不是主效果分母 */
  costPerUsable: number;
  /** 该引擎贡献的自有域名引用观测数 */
  ownedHits: number;
}

/**
 * 直连引擎不报告成本时的兜底单价。
 * 必须和 collect.ts 用同一个值（COLLECT_COST_FALLBACK_USD），
 * 否则「估算」和「实际花费」会系统性对不上 —— 这个不一致踩过一次。
 */
function fallbackPerCall(): number {
  return Number.parseFloat(process.env.COLLECT_COST_FALLBACK_USD ?? "0.01");
}

export function analyzeCost(db: Ledger, runIds: string[]): EngineCostStat[] {
  const scope = runIds.length ? ` WHERE o.run_id IN (${runIds.map(() => "?").join(",")})` : "";

  // 不要 JOIN citation：一条观测有多条引用，JOIN 会让行数膨胀，
  // COUNT/SUM 随之被放大。owned_hits 用相关子查询单独算。
  const rows = db
    .prepare(
      `SELECT o.engine,
              COUNT(*) AS calls,
              COALESCE(SUM(o.cost_usd), 0) AS cost_usd,
              SUM(CASE WHEN o.fidelity = 'web_grounded' THEN 1 ELSE 0 END) AS usable,
              SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM citation c
                     WHERE c.observation_id = o.id AND c.ownership = 'owned'
                  ) THEN 1 ELSE 0 END) AS owned_hits
         FROM observation o
         ${scope}
         GROUP BY o.engine
         ORDER BY cost_usd DESC`,
    )
    .all(...runIds) as unknown as Array<{
    engine: string;
    calls: number;
    cost_usd: number;
    usable: number;
    owned_hits: number;
  }>;

  const fallback = fallbackPerCall();
  return rows.map((row) => {
    const cost = row.cost_usd > 0 ? row.cost_usd : row.calls * fallback;
    return {
      engine: row.engine,
      calls: row.calls,
      costUsd: cost,
      costPerCall: cost / Math.max(1, row.calls),
      usable: row.usable,
      usableRate: row.usable / Math.max(1, row.calls),
      costPerUsable: row.usable > 0 ? cost / row.usable : Number.POSITIVE_INFINITY,
      ownedHits: row.owned_hits,
    };
  });
}

export interface PlanLine {
  engine: string;
  runs: number;
  calls: number;
  estCostUsd: number;
}

/** 按历史单价估算一轮采集的花费。跑之前先知道要花多少。 */
export function estimateRun(
  history: EngineCostStat[],
  promptCount: number,
  runsByEngine: Record<string, number>,
  defaultRuns: number,
): { lines: PlanLine[]; totalUsd: number } {
  const lines = history.map((stat) => {
    const runs = Math.max(0, runsByEngine[stat.engine] ?? defaultRuns);
    const calls = runs * promptCount;
    return {
      engine: stat.engine,
      runs,
      calls,
      estCostUsd: calls * stat.costPerCall,
    };
  });
  return { lines, totalUsd: lines.reduce((sum, line) => sum + line.estCostUsd, 0) };
}

export function renderCostReport(
  stats: EngineCostStat[],
  plan?: { lines: PlanLine[]; totalUsd: number; promptCount: number },
): string {
  const out: string[] = [];
  const money = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(4)}` : "  ∞");

  out.push("成本效率 —— 已发生");
  out.push("=".repeat(78));
  out.push(
    "引擎".padEnd(26) +
      "调用".padStart(6) +
      "花费".padStart(9) +
      "单价".padStart(10) +
      "检索率".padStart(9) +
      "每条检索".padStart(11) +
      "自有命中".padStart(9),
  );
  out.push("-".repeat(78));

  let totalCost = 0;
  let totalCalls = 0;
  for (const s of stats) {
    totalCost += s.costUsd;
    totalCalls += s.calls;
    out.push(
      s.engine.slice(0, 24).padEnd(26) +
        String(s.calls).padStart(6) +
        `$${s.costUsd.toFixed(2)}`.padStart(9) +
        money(s.costPerCall).padStart(10) +
        `${(s.usableRate * 100).toFixed(1)}%`.padStart(9) +
        money(s.costPerUsable).padStart(11) +
        String(s.ownedHits).padStart(9),
    );
  }
  out.push("-".repeat(78));
  out.push(`合计 ${totalCalls} 次调用，$${totalCost.toFixed(2)}`);
  out.push("");
  out.push("读法：「每条检索」是预算诊断，不是效果报告分母；效果主分母仍是全部成功调用。");
  out.push("      对检索很少发生的表面，重复采样预算应谨慎配置。");

  if (plan) {
    out.push("");
    out.push("下一轮估算");
    out.push("=".repeat(78));
    out.push(
      "引擎".padEnd(26) + "N".padStart(4) + "调用".padStart(8) + "预计花费".padStart(12),
    );
    out.push("-".repeat(78));
    for (const line of plan.lines) {
      if (line.runs === 0) {
        out.push(line.engine.slice(0, 24).padEnd(26) + "跳过".padStart(4));
        continue;
      }
      out.push(
        line.engine.slice(0, 24).padEnd(26) +
          String(line.runs).padStart(4) +
          String(line.calls).padStart(8) +
          `$${line.estCostUsd.toFixed(2)}`.padStart(12),
      );
    }
    out.push("-".repeat(78));
    out.push(`${plan.promptCount} 条 prompt，预计合计 $${plan.totalUsd.toFixed(2)}`);
  }

  return out.join("\n");
}
