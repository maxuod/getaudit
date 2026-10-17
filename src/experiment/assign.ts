import { createHash } from "node:crypto";
import type { Ledger } from "../db/index.ts";
import { inTransaction } from "../db/index.ts";
import { buildAttributionReport } from "../analysis/attribution.ts";

/**
 * 分层随机分组。
 *
 * 为什么必须分层：如果干预组恰好拿到更多「快要被引用」的 prompt，
 * 均值回归会给出一个假的漂亮结果 —— 这是本方法论的头号杀手。
 * 按基线引用率分层后组内随机，保证两组的起点分布可比。
 *
 * 为什么用种子随机而不是 Math.random：分组必须可复现。
 * 客户或第三方拿到 seed 和分层规则，能重算出同一套分组 ——
 * 这是「我们没有挑选样本」这句话的可验证凭证。
 */

export type Arm = "treatment" | "control";

export interface StratumBucket {
  name: string;
  min: number;
  max: number;
}

/**
 * 默认四层。零命中是「从未出现到出现」实验最重要的地板层，不能因为
 * baseline 为零就事后排除；高于 75% 的 prompt 仍因提升空间有限而排除。
 */
export const DEFAULT_STRATA: StratumBucket[] = [
  { name: "zero", min: 0, max: 0.05 },
  { name: "low", min: 0.05, max: 0.25 },
  { name: "mid", min: 0.25, max: 0.4 },
  { name: "high", min: 0.4, max: 0.75 },
];

export interface PromptBaseline {
  promptId: string;
  text: string;
  usable: number;
  ownedHits: number;
  rate: number;
}

export interface AssignmentRow {
  promptId: string;
  text: string;
  arm: Arm;
  stratum: string;
  rate: number;
}

export interface AssignResult {
  assignments: AssignmentRow[];
  excluded: Array<{ text: string; rate: number; reason: string }>;
  seed: string;
  strataSummary: Array<{ stratum: string; treatment: number; control: number }>;
}

/**
 * 确定性 PRNG（xorshift128），种子来自字符串 hash。
 * 不用 Math.random —— 那个没法复现，分组就无法被第三方验证。
 */
function makeRng(seed: string): () => number {
  const digest = createHash("sha256").update(seed).digest();
  let a = digest.readUInt32LE(0) || 1;
  let b = digest.readUInt32LE(4) || 2;
  let c = digest.readUInt32LE(8) || 3;
  let d = digest.readUInt32LE(12) || 4;

  return function next(): number {
    const t = a ^ (a << 11);
    a = b;
    b = c;
    c = d;
    d = (d ^ (d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return d / 0x100000000;
  };
}

/** Fisher-Yates，用给定 rng。 */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

/** 读取每条 prompt 的基线引用率。主分母为全部成功调用。 */
export function readBaselines(
  db: Ledger,
  promptSetId: string,
  options: {
    parserVersion: string;
    runIds?: readonly string[];
    excludeEngines?: readonly string[];
  },
): PromptBaseline[] {
  const runIds = options.runIds?.filter(Boolean) ?? [];
  const excluded = options.excludeEngines?.filter(Boolean) ?? [];
  const scopeSql =
    (runIds.length ? ` AND o.run_id IN (${runIds.map(() => "?").join(",")})` : "") +
    (excluded.length ? ` AND o.engine NOT IN (${excluded.map(() => "?").join(",")})` : "");
  buildAttributionReport(db, promptSetId, {
    parserVersion: options.parserVersion,
    runIds: [...runIds],
    excludeEngines: [...excluded],
  });

  const rows = db
    .prepare(
      `SELECT p.id AS prompt_id, p.text,
              SUM(CASE WHEN o.fidelity != 'error' THEN 1 ELSE 0 END) AS usable,
              SUM(CASE WHEN o.fidelity != 'error' AND EXISTS (
                    SELECT 1 FROM citation c
                     WHERE c.observation_id = o.id AND c.ownership = 'owned'
                  ) THEN 1 ELSE 0 END) AS owned_hits
         FROM prompt p
         LEFT JOIN observation o ON o.prompt_id = p.id${scopeSql}
        WHERE p.prompt_set_id = ?
        GROUP BY p.id
        ORDER BY p.text`,
    )
    .all(...runIds, ...excluded, promptSetId) as unknown as Array<{
    prompt_id: string;
    text: string;
    usable: number;
    owned_hits: number;
  }>;

  return rows.map((row) => ({
    promptId: row.prompt_id,
    text: row.text,
    usable: row.usable,
    ownedHits: row.owned_hits,
    rate: row.usable > 0 ? row.owned_hits / row.usable : 0,
  }));
}

/**
 * 分组算法版本。改变分配逻辑必须递增，并在 assignment 表里记录 ——
 * 否则历史分组无法被第三方复算，可验证性就失效了。
 *
 * v1：固定从 treatment 开始交替（奇数层有系统性偏向）
 * v2：起始 arm 由 hash(seed, stratum) 决定
 * v3：把 0% baseline 纳入独立 zero stratum；不再把地板效应误判为不可实验
 */
export const ASSIGN_ALGO_VERSION = "v3";

/**
 * 分层随机分配。纯函数 —— 同样的输入（含 seed）永远得到同样的分组。
 * 这是可验证性的基础，改动这个函数必须同时递增 ASSIGN_ALGO_VERSION。
 */
export function stratifiedAssign(
  baselines: readonly PromptBaseline[],
  seed: string,
  strata: readonly StratumBucket[] = DEFAULT_STRATA,
  minUsable = 5,
): AssignResult {
  const rng = makeRng(seed);
  const assignments: AssignmentRow[] = [];
  const excluded: Array<{ text: string; rate: number; reason: string }> = [];
  const strataSummary: Array<{ stratum: string; treatment: number; control: number }> = [];

  for (const item of baselines) {
    if (item.usable < minUsable) {
      excluded.push({
        text: item.text,
        rate: item.rate,
        reason: `可用观测不足（${item.usable} < ${minUsable}）`,
      });
    }
  }

  for (const bucket of strata) {
    const members = baselines.filter(
      (item) =>
        item.usable >= minUsable && item.rate >= bucket.min && item.rate < bucket.max,
    );
    if (!members.length) continue;

    // 层内按基线率排序后再洗牌：排序保证同样的输入顺序一致，
    // 不受上游查询返回顺序影响
    const ordered = [...members].sort(
      (a, b) => a.rate - b.rate || a.promptId.localeCompare(b.promptId),
    );
    const shuffled = shuffle(ordered, rng);

    // 交替分配。起始 arm 由 hash(seed, stratum) 决定 ——
    // 固定从 treatment 开始的话，每层人数为奇数时多出的那条永远进干预组，
    // 累积起来就是系统性偏向。这个偏向可复现但不等于无害。
    const startsWithTreatment =
      createHash("sha256").update(`${seed}|${bucket.name}`).digest()[0]! % 2 === 0;

    let treatment = 0;
    let control = 0;
    shuffled.forEach((item, index) => {
      const isTreatment = startsWithTreatment ? index % 2 === 0 : index % 2 === 1;
      const arm: Arm = isTreatment ? "treatment" : "control";
      if (arm === "treatment") treatment += 1;
      else control += 1;
      assignments.push({
        promptId: item.promptId,
        text: item.text,
        arm,
        stratum: bucket.name,
        rate: item.rate,
      });
    });
    strataSummary.push({ stratum: bucket.name, treatment, control });
  }

  // 落在所有层之外的（当前默认配置下主要是过高、接近天花板的 rate）
  const assignedIds = new Set(assignments.map((a) => a.promptId));
  for (const item of baselines) {
    if (assignedIds.has(item.promptId)) continue;
    if (item.usable < minUsable) continue;
    const reason = `基线率 ${(item.rate * 100).toFixed(0)}% 落在分层范围外`;
    excluded.push({ text: item.text, rate: item.rate, reason });
  }

  return { assignments, excluded, seed, strataSummary };
}

/** 写入台账。assignment 表有不可变触发器，写错只能新建 prompt 集重来。 */
export function persistAssignments(
  db: Ledger,
  promptSetId: string,
  result: AssignResult,
): number {
  const existing = db
    .prepare(`SELECT COUNT(*) AS n FROM assignment WHERE prompt_set_id = ?`)
    .get(promptSetId) as { n: number };
  if (existing.n > 0) {
    throw new Error(
      `该 prompt 集已有 ${existing.n} 条分组记录。分组不可重做 —— ` +
        `重新分组等于推翻实验。需要新分组请新建 prompt 集。`,
    );
  }

  const insert = db.prepare(
    `INSERT INTO assignment (prompt_id, prompt_set_id, arm, stratum, rng_seed, algo_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  return inTransaction(db, () => {
    let count = 0;
    for (const row of result.assignments) {
      insert.run(row.promptId, promptSetId, row.arm, row.stratum, result.seed, ASSIGN_ALGO_VERSION);
      count += 1;
    }
    return count;
  });
}

export function renderAssignReport(result: AssignResult): string {
  const lines: string[] = [];
  lines.push("分层随机分组");
  lines.push("=".repeat(80));
  lines.push(`随机种子：${result.seed}`);
  lines.push("（把这个种子和分层规则给客户，他可以自行重算验证分组未被挑选）");
  lines.push("");

  lines.push("分层平衡");
  lines.push("-".repeat(80));
  for (const row of result.strataSummary) {
    lines.push(
      `  ${row.stratum.padEnd(6)} 干预 ${String(row.treatment).padStart(3)} · ` +
        `对照 ${String(row.control).padStart(3)}`,
    );
  }
  lines.push("");

  const arms: Arm[] = ["treatment", "control"];
  for (const arm of arms) {
    const group = result.assignments.filter((a) => a.arm === arm);
    lines.push(`${arm === "treatment" ? "干预组" : "对照组"}（${group.length} 条）`);
    lines.push("-".repeat(80));
    for (const row of group) {
      lines.push(
        `  [${row.stratum}] ${(row.rate * 100).toFixed(0).padStart(3)}%  ${row.text.slice(0, 62)}`,
      );
    }
    lines.push("");
  }

  if (result.excluded.length) {
    lines.push(`未纳入实验（${result.excluded.length} 条）`);
    lines.push("-".repeat(80));
    for (const row of result.excluded) {
      lines.push(`  ${(row.rate * 100).toFixed(0).padStart(3)}%  ${row.text.slice(0, 50)}`);
      lines.push(`        ${row.reason}`);
    }
    lines.push("");
  }

  const treatment = result.assignments.filter((a) => a.arm === "treatment").length;
  const control = result.assignments.filter((a) => a.arm === "control").length;
  lines.push("=".repeat(80));
  lines.push(`纳入 ${result.assignments.length} 条：干预 ${treatment} · 对照 ${control}`);
  if (Math.min(treatment, control) < 8) {
    lines.push("");
    lines.push("⚠️  每组少于 8 条，统计功效不足 —— 只能检出很大的效应。");
    lines.push("    考虑扩充 prompt 集后重新开始，而不是硬跑。");
  }
  return lines.join("\n");
}
