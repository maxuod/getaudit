import { createHash } from "node:crypto";
import type { Ledger } from "../db/index.ts";
import { canonicalJson } from "../lib/canonical-json.ts";
import { ANALYSIS_VERSION, getManifest } from "../experiment/manifest.ts";
import { buildAttributionReport } from "./attribution.ts";

export interface PromptDelta {
  promptId: string;
  text: string;
  arm: "treatment" | "control";
  stratum: string;
  preRate: number;
  postRate: number;
  delta: number;
  preUsable: number;
  postUsable: number;
}

export interface ArmStats {
  arm: "treatment" | "control";
  prompts: number;
  preUsable: number;
  preHits: number;
  preRate: number;
  postUsable: number;
  postHits: number;
  postRate: number;
  /** prompt 级 delta 的未加权均值。 */
  delta: number;
}

export interface RandomizationInference {
  method: "prompt-level-stratified-fisher-randomization-v1";
  testable: boolean;
  reason: string | null;
  pValue: number | null;
  assignmentsEvaluated: number;
  exact: boolean;
  seed: string;
}

export interface DidReport {
  brandName: string;
  parserVersion: string;
  treatment: ArmStats;
  control: ArmStats;
  did: number;
  inference: RandomizationInference;
  claimStatus: "experimental" | "descriptive";
  perPrompt: PromptDelta[];
  interventions: Array<{ assetType: string; url: string | null; publishedAt: string }>;
  clientChanges: Array<{ occurredAt: string; kind: string; description: string }>;
  preRuns: string[];
  postRuns: string[];
  warnings: string[];
}

interface RunRow {
  id: string;
  phase: string;
  prompt_set_id: string;
  finished_at: string | null;
  config_json: string | null;
  config_hash: string | null;
}

interface DeltaRow {
  prompt_id: string;
  text: string;
  arm: "treatment" | "control";
  stratum: string;
  rng_seed: string;
  algo_version: string | null;
  pre_usable: number;
  pre_hits: number;
  post_usable: number;
  post_hits: number;
}

const mean = (values: readonly number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

/** 描述单个二项比例时使用；不用于 DiD 的显著性推断。 */
export function wilsonInterval(hits: number, total: number, z = 1.96): [number, number] {
  if (total === 0) return [0, 0];
  const p = hits / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function engineScope(
  includeEngines: readonly string[],
  excludeEngines: readonly string[],
): { sql: string; args: string[] } {
  if (includeEngines.length) {
    return {
      sql: ` AND o.engine IN (${includeEngines.map(() => "?").join(",")})`,
      args: [...includeEngines],
    };
  }
  if (excludeEngines.length) {
    return {
      sql: ` AND o.engine NOT IN (${excludeEngines.map(() => "?").join(",")})`,
      args: [...excludeEngines],
    };
  }
  return { sql: "", args: [] };
}

function experimentalConfig(json: string): string {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const { phase: _phase, ...rest } = parsed;
  return canonicalJson(rest);
}

function validateRuns(
  db: Ledger,
  promptSetId: string,
  runIds: readonly string[],
  phase: "baseline" | "followup",
): RunRow[] {
  const rows = runIds.map((id) =>
    db.prepare(`SELECT * FROM collection_run WHERE id = ?`).get(id) as RunRow | undefined,
  );
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const id = runIds[index];
    if (!row || row.prompt_set_id !== promptSetId || row.phase !== phase) {
      throw new Error(`${phase} run 无效、跨集合或 phase 不符：${id}`);
    }
    if (!row.finished_at) throw new Error(`${phase} run 尚未封存：${id}`);
    if (!row.config_json || !row.config_hash) throw new Error(`${phase} run 缺少 canonical config：${id}`);
  }
  return rows as RunRow[];
}

function chooseCount(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 1; i <= Math.min(k, n - k); i += 1) out = (out * (n - i + 1)) / i;
  return Math.round(out);
}

function combinations<T>(items: readonly T[], k: number): T[][] {
  const result: T[][] = [];
  const pick = (start: number, current: T[]): void => {
    if (current.length === k) {
      result.push([...current]);
      return;
    }
    for (let i = start; i <= items.length - (k - current.length); i += 1) {
      const item = items[i];
      if (item !== undefined) pick(i + 1, [...current, item]);
    }
  };
  pick(0, []);
  return result;
}

function makeRng(seed: string): () => number {
  const digest = createHash("sha256").update(seed).digest();
  let a = digest.readUInt32LE(0);
  let b = digest.readUInt32LE(4);
  let c = digest.readUInt32LE(8);
  let d = digest.readUInt32LE(12);
  return () => {
    const t = a ^ (a << 11);
    a = b;
    b = c;
    c = d;
    d = (d ^ (d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return d / 0x100000000;
  };
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function effect(rows: readonly PromptDelta[], treatmentIds: ReadonlySet<string>): number {
  const treatment = rows.filter((row) => treatmentIds.has(row.promptId)).map((row) => row.delta);
  const control = rows.filter((row) => !treatmentIds.has(row.promptId)).map((row) => row.delta);
  return mean(treatment) - mean(control);
}

export function fisherRandomizationInference(
  rows: readonly PromptDelta[],
  input: { seed: string; iterations: number; minPromptsPerArm?: number; exactLimit?: number },
): RandomizationInference {
  const method = "prompt-level-stratified-fisher-randomization-v1" as const;
  const treatmentRows = rows.filter((row) => row.arm === "treatment");
  const controlRows = rows.filter((row) => row.arm === "control");
  const minimum = input.minPromptsPerArm ?? 8;
  if (Math.min(treatmentRows.length, controlRows.length) < minimum) {
    return {
      method,
      testable: false,
      reason: `每组至少需要 ${minimum} 条 prompt；当前干预 ${treatmentRows.length}、对照 ${controlRows.length}`,
      pValue: null,
      assignmentsEvaluated: 0,
      exact: false,
      seed: input.seed,
    };
  }

  const strata = [...new Set(rows.map((row) => row.stratum))].sort().map((stratum) => {
    const members = rows.filter((row) => row.stratum === stratum);
    const treatmentCount = members.filter((row) => row.arm === "treatment").length;
    return { stratum, members, treatmentCount };
  });
  const totalAssignments = strata.reduce(
    (product, stratum) => product * chooseCount(stratum.members.length, stratum.treatmentCount),
    1,
  );
  const observedIds = new Set(treatmentRows.map((row) => row.promptId));
  const observed = effect(rows, observedIds);
  const threshold = Math.abs(observed) - 1e-12;
  const exactLimit = input.exactLimit ?? 100_000;

  if (totalAssignments <= exactLimit) {
    const choices = strata.map((stratum) =>
      combinations(stratum.members, stratum.treatmentCount).map(
        (set) => new Set(set.map((row) => row.promptId)),
      ),
    );
    let evaluated = 0;
    let extreme = 0;
    const walk = (index: number, selected: Set<string>): void => {
      if (index === choices.length) {
        evaluated += 1;
        if (Math.abs(effect(rows, selected)) >= threshold) extreme += 1;
        return;
      }
      for (const choice of choices[index] ?? []) walk(index + 1, new Set([...selected, ...choice]));
    };
    walk(0, new Set());
    return {
      method,
      testable: evaluated > 1,
      reason: evaluated > 1 ? null : "随机化机制只有一种合法分配，无法形成检验分布",
      pValue: evaluated > 1 ? extreme / evaluated : null,
      assignmentsEvaluated: evaluated,
      exact: true,
      seed: input.seed,
    };
  }

  const iterations = Math.max(1_000, input.iterations);
  const rng = makeRng(input.seed);
  let extreme = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const selected = new Set<string>();
    for (const stratum of strata) {
      for (const row of shuffled(stratum.members, rng).slice(0, stratum.treatmentCount)) {
        selected.add(row.promptId);
      }
    }
    if (Math.abs(effect(rows, selected)) >= threshold) extreme += 1;
  }
  return {
    method,
    testable: true,
    reason: null,
    pValue: (extreme + 1) / (iterations + 1),
    assignmentsEvaluated: iterations,
    exact: false,
    seed: input.seed,
  };
}

function armStats(rows: readonly PromptDelta[], arm: "treatment" | "control"): ArmStats {
  const selected = rows.filter((row) => row.arm === arm);
  return {
    arm,
    prompts: selected.length,
    preUsable: selected.reduce((sum, row) => sum + row.preUsable, 0),
    preHits: Math.round(selected.reduce((sum, row) => sum + row.preRate * row.preUsable, 0)),
    preRate: mean(selected.map((row) => row.preRate)),
    postUsable: selected.reduce((sum, row) => sum + row.postUsable, 0),
    postHits: Math.round(selected.reduce((sum, row) => sum + row.postRate * row.postUsable, 0)),
    postRate: mean(selected.map((row) => row.postRate)),
    delta: mean(selected.map((row) => row.delta)),
  };
}

export function buildDidReport(
  db: Ledger,
  promptSetId: string,
  options: {
    parserVersion: string;
    preRuns: readonly string[];
    postRuns: readonly string[];
    excludeEngines?: readonly string[];
    includeEngines?: readonly string[];
    randomizationIterations?: number;
  },
): DidReport {
  if (!options.preRuns.length || !options.postRuns.length) throw new Error("DiD 需要 preRuns 和 postRuns");
  const warnings: string[] = [];
  const exclude = options.excludeEngines?.filter(Boolean) ?? [];
  const include = options.includeEngines?.filter(Boolean) ?? [];
  const scope = engineScope(include, exclude);

  const assignmentCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM assignment WHERE prompt_set_id = ?`).get(promptSetId) as {
      n: number;
    }
  ).n;
  if (!assignmentCount) throw new Error("该 prompt 集没有分组记录，无法做 DiD；先运行 assign");

  const preRows = validateRuns(db, promptSetId, options.preRuns, "baseline");
  const postRows = validateRuns(db, promptSetId, options.postRuns, "followup");
  const referenceConfig = experimentalConfig(preRows[0]!.config_json!);
  for (const row of [...preRows, ...postRows]) {
    if (experimentalConfig(row.config_json!) !== referenceConfig) {
      throw new Error(`pre/post 实验配置不一致：${row.id}`);
    }
  }

  buildAttributionReport(db, promptSetId, {
    parserVersion: options.parserVersion,
    runIds: [...options.preRuns, ...options.postRuns],
    excludeEngines: include.length ? [] : [...exclude],
  });

  const prePlaceholders = options.preRuns.map(() => "?").join(",");
  const postPlaceholders = options.postRuns.map(() => "?").join(",");
  const deltaRows = db
    .prepare(
      `SELECT a.prompt_id, p.text, a.arm, a.stratum, a.rng_seed, a.algo_version,
              SUM(CASE WHEN o.run_id IN (${prePlaceholders}) AND o.fidelity != 'error' THEN 1 ELSE 0 END) AS pre_usable,
              SUM(CASE WHEN o.run_id IN (${prePlaceholders}) AND o.fidelity != 'error' AND EXISTS (
                    SELECT 1 FROM citation c WHERE c.observation_id = o.id AND c.ownership = 'owned'
                  ) THEN 1 ELSE 0 END) AS pre_hits,
              SUM(CASE WHEN o.run_id IN (${postPlaceholders}) AND o.fidelity != 'error' THEN 1 ELSE 0 END) AS post_usable,
              SUM(CASE WHEN o.run_id IN (${postPlaceholders}) AND o.fidelity != 'error' AND EXISTS (
                    SELECT 1 FROM citation c WHERE c.observation_id = o.id AND c.ownership = 'owned'
                  ) THEN 1 ELSE 0 END) AS post_hits
         FROM assignment a
         JOIN prompt p ON p.id = a.prompt_id
         LEFT JOIN observation o ON o.prompt_id = a.prompt_id${scope.sql}
        WHERE a.prompt_set_id = ?
        GROUP BY a.prompt_id ORDER BY a.stratum, a.prompt_id`,
    )
    .all(
      ...options.preRuns,
      ...options.preRuns,
      ...options.postRuns,
      ...options.postRuns,
      ...scope.args,
      promptSetId,
    ) as unknown as DeltaRow[];
  if (!deltaRows.length) throw new Error("没有 assignment，无法计算 prompt-level DiD");
  const missingPeriods = deltaRows.filter((row) => !row.pre_usable || !row.post_usable);
  if (missingPeriods.length) {
    throw new Error(`${missingPeriods.length} 条已分组 prompt 在 pre 或 post 没有成功观测，拒绝静默剔除`);
  }

  const perPrompt: PromptDelta[] = deltaRows.map((row) => {
    const preRate = row.pre_hits / row.pre_usable;
    const postRate = row.post_hits / row.post_usable;
    return {
      promptId: row.prompt_id,
      text: row.text,
      arm: row.arm,
      stratum: row.stratum,
      preRate,
      postRate,
      delta: postRate - preRate,
      preUsable: row.pre_usable,
      postUsable: row.post_usable,
    };
  });

  const assignmentSeeds = [...new Set(deltaRows.map((row) => row.rng_seed))];
  const assignmentAlgorithms = [...new Set(deltaRows.map((row) => row.algo_version ?? "legacy-unknown"))];
  if (assignmentSeeds.length !== 1 || assignmentAlgorithms.length !== 1) {
    throw new Error("assignment seed/algorithm 不一致，无法复现随机化推断");
  }

  const prereg = db
    .prepare(`SELECT manifest_hash, registered_at FROM preregistration WHERE prompt_set_id = ?`)
    .get(promptSetId) as { manifest_hash: string | null; registered_at: string } | undefined;
  let iterations = Math.max(1_000, options.randomizationIterations ?? 20_000);
  let manifestMatches = false;
  let plannedFollowupRounds: number | null = null;
  if (prereg?.manifest_hash) {
    const manifest = getManifest(db, prereg.manifest_hash);
    if (manifest) {
      const doc = JSON.parse(manifest.canonicalJson) as {
        parser_version?: string;
        analysis_version?: string;
        inference?: { randomization_iterations?: number; method?: string };
        baseline_runs?: Array<{ id?: string }>;
        plan?: { planned_followup_rounds?: number };
      };
      if (doc.parser_version !== options.parserVersion) {
        throw new Error("报告 parserVersion 与预注册 manifest 不一致");
      }
      if (doc.analysis_version !== ANALYSIS_VERSION) {
        throw new Error("报告 analysis version 与预注册 manifest 不一致");
      }
      if (doc.inference?.method !== "prompt-level-stratified-fisher-randomization-v1") {
        throw new Error("manifest 的推断方法与实现不一致");
      }
      const manifestBaselines = (doc.baseline_runs ?? [])
        .map((run) => run.id)
        .filter((id): id is string => Boolean(id))
        .sort();
      const requestedBaselines = [...options.preRuns].sort();
      if (JSON.stringify(manifestBaselines) !== JSON.stringify(requestedBaselines)) {
        throw new Error("报告 preRuns 与预注册 manifest 绑定的 baseline runs 不一致");
      }
      plannedFollowupRounds = doc.plan?.planned_followup_rounds ?? null;
      iterations = doc.inference.randomization_iterations ?? iterations;
      manifestMatches = true;
    }
  } else {
    warnings.push("无有效预注册 manifest：结果只能标记为描述性，不能声称事前锁定。");
  }

  const inferenceSeed = [
    assignmentSeeds[0],
    assignmentAlgorithms[0],
    options.parserVersion,
    [...options.preRuns].sort().join(","),
    [...options.postRuns].sort().join(","),
    iterations,
  ].join("|");
  const inference = fisherRandomizationInference(perPrompt, {
    seed: inferenceSeed,
    iterations,
  });
  if (!inference.testable && inference.reason) warnings.push(inference.reason);
  if (options.preRuns.length < 2) warnings.push("基线少于 2 轮，无法检查干预前平行趋势。");
  const followupPlanComplete =
    plannedFollowupRounds !== null && options.postRuns.length === plannedFollowupRounds;
  if (manifestMatches && !followupPlanComplete) {
    warnings.push(
      `follow-up 轮数与 manifest 不一致：计划 ${plannedFollowupRounds ?? "未知"}，报告使用 ${options.postRuns.length}。`,
    );
  }

  const interventions = db
    .prepare(
      `SELECT asset_type, url, published_at FROM intervention
        WHERE prompt_set_id = ? ORDER BY published_at`,
    )
    .all(promptSetId) as unknown as Array<{
    asset_type: string;
    url: string | null;
    published_at: string;
  }>;
  if (!interventions.length) warnings.push("无干预登记，变化不能归因到具体动作。");
  const postPlaceholdersForChronology = options.postRuns.map(() => "?").join(",");
  const chronology = prereg
    ? (db
        .prepare(
          `SELECT
             date(MIN(i.published_at)) >= date(?)
             AND datetime(MIN(r.started_at)) >= datetime(MAX(i.published_at)) AS ok
           FROM intervention i, collection_run r
          WHERE i.prompt_set_id = ? AND r.id IN (${postPlaceholdersForChronology})`,
        )
        .get(prereg.registered_at, promptSetId, ...options.postRuns) as { ok: number | null })
    : { ok: 0 };
  const chronologyValid = chronology.ok === 1;
  if (!chronologyValid) {
    warnings.push("预注册、干预和所选 follow-up 的时间顺序不成立；结果只能作描述性使用。");
  }

  const clientChanges = db
    .prepare(
      `SELECT occurred_at, kind, description FROM client_change
        WHERE prompt_set_id = ? ORDER BY occurred_at`,
    )
    .all(promptSetId) as unknown as Array<{
    occurred_at: string;
    kind: string;
    description: string;
  }>;

  const treatment = armStats(perPrompt, "treatment");
  const control = armStats(perPrompt, "control");
  const claimStatus =
    manifestMatches &&
    inference.testable &&
    interventions.length > 0 &&
    options.preRuns.length >= 2 &&
    followupPlanComplete &&
    chronologyValid
      ? "experimental"
      : "descriptive";
  return {
    brandName:
      (
        db
          .prepare(`SELECT b.name FROM prompt_set ps JOIN brand b ON b.id = ps.brand_id WHERE ps.id = ?`)
          .get(promptSetId) as { name: string } | undefined
      )?.name ?? "(未知品牌)",
    parserVersion: options.parserVersion,
    treatment,
    control,
    did: treatment.delta - control.delta,
    inference,
    claimStatus,
    perPrompt,
    interventions: interventions.map((row) => ({
      assetType: row.asset_type,
      url: row.url,
      publishedAt: row.published_at,
    })),
    clientChanges: clientChanges.map((row) => ({
      occurredAt: row.occurred_at,
      kind: row.kind,
      description: row.description,
    })),
    preRuns: [...options.preRuns],
    postRuns: [...options.postRuns],
    warnings,
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const signed = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;

export function renderDidReport(report: DidReport): string {
  const lines: string[] = [];
  lines.push(`实验差分报告 —— ${report.brandName}`);
  lines.push("=".repeat(84));
  lines.push(`结论等级   ${report.claimStatus === "experimental" ? "预注册实验结果" : "描述性结果"}`);
  lines.push(`parser     ${report.parserVersion}`);
  lines.push(`基线轮次   ${report.preRuns.join(", ")}`);
  lines.push(`后续轮次   ${report.postRuns.join(", ")}`);
  lines.push("");
  for (const [label, stats] of [
    ["干预组", report.treatment],
    ["对照组", report.control],
  ] as const) {
    lines.push(
      `${label}: ${stats.prompts} 条 prompt；平均引用率 ${pct(stats.preRate)} → ${pct(stats.postRate)}；` +
        `prompt 平均变化 ${signed(stats.delta)}`,
    );
  }
  lines.push(`DiD = ${signed(report.did)}（以 prompt 为统计与随机化单位）`);
  lines.push("");
  lines.push("Fisher 分层随机化推断");
  lines.push("-".repeat(84));
  if (report.inference.testable) {
    lines.push(
      `双侧 p=${report.inference.pValue?.toFixed(4)}；` +
        `${report.inference.exact ? "穷举" : "确定性 Monte Carlo"} ` +
        `${report.inference.assignmentsEvaluated} 个合法分配`,
    );
    lines.push("p 值衡量在零效应下观察到同等或更极端 DiD 的随机化概率，不等于效应大小或商业价值。");
  } else {
    lines.push(`不输出 p 值：${report.inference.reason}`);
  }
  lines.push("");
  lines.push("方法边界：该设计通过干预/对照与事前随机化降低混淆，但仍依赖平行趋势、无组间污染及配置稳定。\n");

  if (report.warnings.length) {
    lines.push("限制与门禁");
    lines.push("-".repeat(84));
    for (const warning of report.warnings) lines.push(`· ${warning}`);
  }
  return lines.join("\n");
}
