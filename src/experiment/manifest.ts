import { randomUUID } from "node:crypto";
import type { Ledger } from "../db/index.ts";
import { inTransaction } from "../db/index.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import { inspectRunIntegrity } from "../ledger/run-integrity.ts";
import {
  ASSIGN_ALGO_VERSION,
  readBaselines,
  stratifiedAssign,
} from "./assign.ts";

export const MANIFEST_SCHEMA_VERSION = "geo-proof-manifest-v1";
export const ANALYSIS_VERSION = "analysis-v1-2026-08-10";
export const STRONG_ANCHOR_TYPES = ["email", "contract", "rfc3161", "opentimestamps"] as const;
export type ManifestAnchorType =
  | (typeof STRONG_ANCHOR_TYPES)[number]
  | "github_commit"
  | "other";

export interface MetricDefinition {
  id: string;
  numerator: string;
  denominator: string;
}

export interface ManifestPlan {
  promptSetId: string;
  parserVersion: string;
  baselineRunIds: string[];
  hypothesis: string;
  primaryMetric: MetricDefinition;
  secondaryMetrics: MetricDefinition[];
  plannedFollowupRounds: number;
  stopRule: string;
  exclusionRules: string[];
  interventionPlan: string;
  powerAnalysis: {
    effect: number;
    promptDeltaSd: number;
    alpha: number;
    targetPower: number;
    simulations: number;
    recommendedPromptsPerArm: number;
    seed: string;
  };
  randomizationIterations?: number;
}

interface ManifestDocument {
  schema_version: string;
  prompt_set: { id: string; hash: string };
  parser_version: string;
  analysis_version: string;
  assignment: {
    algorithm_version: string;
    seed: string;
    rows: Array<{ prompt_id: string; arm: string; stratum: string }>;
  };
  baseline_runs: Array<{ id: string; config_hash: string; config: unknown }>;
  hypothesis: string;
  metrics: { primary: MetricDefinition; secondary: MetricDefinition[] };
  inference: { method: string; randomization_iterations: number };
  power_analysis: ManifestPlan["powerAnalysis"];
  plan: {
    planned_followup_rounds: number;
    stop_rule: string;
    exclusion_rules: string[];
    intervention: string;
  };
}

export interface ManifestRecord {
  id: string;
  promptSetId: string;
  schemaVersion: string;
  canonicalJson: string;
  contentHash: string;
  createdAt: string;
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`manifest 缺少 ${label}`);
  return trimmed;
}

function validateMetric(metric: MetricDefinition, label: string): MetricDefinition {
  return {
    id: nonEmpty(metric.id, `${label}.id`),
    numerator: nonEmpty(metric.numerator, `${label}.numerator`),
    denominator: nonEmpty(metric.denominator, `${label}.denominator`),
  };
}

export function createExperimentManifest(db: Ledger, input: ManifestPlan): ManifestRecord {
  if (input.baselineRunIds.length < 2) throw new Error("manifest 至少要绑定两个 baseline run");
  if (new Set(input.baselineRunIds).size !== input.baselineRunIds.length) {
    throw new Error("manifest baseline run 不能重复");
  }
  if (input.plannedFollowupRounds < 1) throw new Error("plannedFollowupRounds 必须至少为 1");

  const set = db
    .prepare(`SELECT frozen_hash FROM prompt_set WHERE id = ?`)
    .get(input.promptSetId) as { frozen_hash: string | null } | undefined;
  if (!set?.frozen_hash) throw new Error("prompt 集不存在或尚未冻结");

  const contaminated = db
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM intervention WHERE prompt_set_id = ?) AS has_intervention,
         EXISTS(SELECT 1 FROM collection_run WHERE prompt_set_id = ? AND phase = 'followup') AS has_followup`,
    )
    .get(input.promptSetId, input.promptSetId) as { has_intervention: number; has_followup: number };
  if (contaminated.has_intervention || contaminated.has_followup) {
    throw new Error("已有干预或 follow-up，不能事后创建 manifest");
  }

  const assignments = db
    .prepare(
      `SELECT prompt_id, arm, stratum, rng_seed, algo_version
         FROM assignment WHERE prompt_set_id = ? ORDER BY prompt_id`,
    )
    .all(input.promptSetId) as unknown as Array<{
    prompt_id: string;
    arm: string;
    stratum: string;
    rng_seed: string;
    algo_version: string | null;
  }>;
  if (!assignments.length) throw new Error("manifest 创建前必须完成 assignment");
  const seeds = new Set(assignments.map((row) => row.rng_seed));
  const algorithms = new Set(assignments.map((row) => row.algo_version ?? "legacy-unknown"));
  if (seeds.size !== 1 || algorithms.size !== 1) {
    throw new Error("assignment 的 seed 或算法版本不一致，不能生成单一 manifest");
  }
  const armCounts = assignments.reduce<Record<string, number>>((counts, row) => {
    counts[row.arm] = (counts[row.arm] ?? 0) + 1;
    return counts;
  }, {});
  const recommended = input.powerAnalysis.recommendedPromptsPerArm;
  if (
    !(input.powerAnalysis.effect > 0) ||
    !(input.powerAnalysis.promptDeltaSd > 0) ||
    !(input.powerAnalysis.alpha > 0 && input.powerAnalysis.alpha < 1) ||
    !(input.powerAnalysis.targetPower > 0 && input.powerAnalysis.targetPower < 1) ||
    !Number.isInteger(input.powerAnalysis.simulations) ||
    input.powerAnalysis.simulations < 100
  ) {
    throw new Error("powerAnalysis 参数无效");
  }
  if (!Number.isInteger(recommended) || recommended < 8) {
    throw new Error("powerAnalysis.recommendedPromptsPerArm 必须是至少 8 的整数");
  }
  if (Math.min(armCounts["treatment"] ?? 0, armCounts["control"] ?? 0) < recommended) {
    throw new Error(
      `assignment 未达到功效模拟建议：每组需 ${recommended}，当前干预 ${armCounts["treatment"] ?? 0}、对照 ${armCounts["control"] ?? 0}`,
    );
  }

  const parserVersion = nonEmpty(input.parserVersion, "parserVersion");
  const baselineRuns = input.baselineRunIds.map((runId) => {
    const row = db
      .prepare(
        `SELECT phase, prompt_set_id, config_hash, config_json
           FROM collection_run WHERE id = ?`,
      )
      .get(runId) as
      | {
          phase: string;
          prompt_set_id: string;
          config_hash: string | null;
          config_json: string | null;
        }
      | undefined;
    if (!row || row.prompt_set_id !== input.promptSetId || row.phase !== "baseline") {
      throw new Error(`manifest 的 baseline run 无效或跨集合：${runId}`);
    }
    const integrity = inspectRunIntegrity(db, runId);
    if (!integrity.valid || !integrity.config || !row.config_hash) {
      throw new Error(`baseline run 完整性不合格：${runId}；${integrity.errors.join("；")}`);
    }
    const coverage = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN i.observation_id IS NOT NULL THEN 1 ELSE 0 END) AS covered
           FROM observation o
           LEFT JOIN observation_interpretation i
             ON i.observation_id = o.id AND i.parser_version = ?
          WHERE o.run_id = ?`,
      )
      .get(parserVersion, runId) as { total: number; covered: number | null };
    if (coverage.total !== (coverage.covered ?? 0)) {
      throw new Error(
        `baseline run ${runId} 的 parser ${parserVersion} 覆盖不足：${coverage.covered ?? 0}/${coverage.total}`,
      );
    }
    return {
      id: runId,
      config_hash: row.config_hash,
      config: integrity.config,
      comparableConfig: integrity.comparableConfig!,
    };
  });
  const referenceConfig = baselineRuns[0]!.comparableConfig;
  if (baselineRuns.some((run) => run.comparableConfig !== referenceConfig)) {
    throw new Error("baseline runs 的模型、端点、地域、locale 或采样配置不一致");
  }
  const algorithm = [...algorithms][0]!;
  const seed = [...seeds][0]!;
  if (algorithm !== ASSIGN_ALGO_VERSION) {
    throw new Error(`assignment 算法 ${algorithm} 不是当前可复算版本 ${ASSIGN_ALGO_VERSION}`);
  }
  const recomputed = stratifiedAssign(
    readBaselines(db, input.promptSetId, {
      parserVersion,
      runIds: input.baselineRunIds,
    }),
    seed,
  ).assignments
    .map((row) => ({ prompt_id: row.promptId, arm: row.arm, stratum: row.stratum }))
    .sort((a, b) => a.prompt_id.localeCompare(b.prompt_id));
  const persisted = assignments.map((row) => ({
    prompt_id: row.prompt_id,
    arm: row.arm,
    stratum: row.stratum,
  }));
  if (canonicalJson(recomputed) !== canonicalJson(persisted)) {
    throw new Error("assignment 无法由 manifest baseline、parser、seed 和算法重算，拒绝锁定");
  }

  const document: ManifestDocument = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    prompt_set: { id: input.promptSetId, hash: set.frozen_hash },
    parser_version: parserVersion,
    analysis_version: ANALYSIS_VERSION,
    assignment: {
      algorithm_version: algorithm,
      seed,
      rows: assignments.map((row) => ({
        prompt_id: row.prompt_id,
        arm: row.arm,
        stratum: row.stratum,
      })),
    },
    baseline_runs: baselineRuns.map(({ comparableConfig: _comparable, ...run }) => run),
    hypothesis: nonEmpty(input.hypothesis, "hypothesis"),
    metrics: {
      primary: validateMetric(input.primaryMetric, "primaryMetric"),
      secondary: input.secondaryMetrics.map((metric, index) =>
        validateMetric(metric, `secondaryMetrics[${index}]`),
      ),
    },
    inference: {
      method: "prompt-level-stratified-fisher-randomization-v1",
      randomization_iterations: Math.max(1_000, input.randomizationIterations ?? 20_000),
    },
    power_analysis: {
      effect: input.powerAnalysis.effect,
      promptDeltaSd: input.powerAnalysis.promptDeltaSd,
      alpha: input.powerAnalysis.alpha,
      targetPower: input.powerAnalysis.targetPower,
      simulations: input.powerAnalysis.simulations,
      recommendedPromptsPerArm: recommended,
      seed: nonEmpty(input.powerAnalysis.seed, "powerAnalysis.seed"),
    },
    plan: {
      planned_followup_rounds: input.plannedFollowupRounds,
      stop_rule: nonEmpty(input.stopRule, "stopRule"),
      exclusion_rules: input.exclusionRules.map((rule, index) =>
        nonEmpty(rule, `exclusionRules[${index}]`),
      ),
      intervention: nonEmpty(input.interventionPlan, "interventionPlan"),
    },
  };

  const json = canonicalJson(document);
  const contentHash = sha256(json);
  const id = randomUUID();
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO experiment_manifest
         (id, prompt_set_id, schema_version, canonical_json, content_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.promptSetId, MANIFEST_SCHEMA_VERSION, json, contentHash);
  });
  const row = db
    .prepare(`SELECT created_at FROM experiment_manifest WHERE id = ?`)
    .get(id) as { created_at: string };
  return {
    id,
    promptSetId: input.promptSetId,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    canonicalJson: json,
    contentHash,
    createdAt: row.created_at,
  };
}

export function getManifest(db: Ledger, contentHash: string): ManifestRecord | null {
  const row = db
    .prepare(`SELECT * FROM experiment_manifest WHERE content_hash = ?`)
    .get(contentHash) as
    | {
        id: string;
        prompt_set_id: string;
        schema_version: string;
        canonical_json: string;
        content_hash: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  if (sha256(row.canonical_json) !== row.content_hash) {
    throw new Error("manifest hash 与 canonical JSON 不匹配");
  }
  return {
    id: row.id,
    promptSetId: row.prompt_set_id,
    schemaVersion: row.schema_version,
    canonicalJson: row.canonical_json,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

export function recordManifestAnchor(
  db: Ledger,
  input: { manifestHash: string; type: ManifestAnchorType; reference: string; anchoredAt: string },
): string {
  if (!getManifest(db, input.manifestHash)) throw new Error("manifest 不存在或 hash 无效");
  const id = randomUUID();
  db.prepare(
    `INSERT INTO manifest_anchor
       (id, manifest_hash, anchor_type, reference, anchored_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.manifestHash,
    input.type,
    nonEmpty(input.reference, "anchor reference"),
    nonEmpty(input.anchoredAt, "anchoredAt"),
  );
  return id;
}

export function hasStrongAnchor(db: Ledger, manifestHash: string): boolean {
  const placeholders = STRONG_ANCHOR_TYPES.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM manifest_anchor
        WHERE manifest_hash = ? AND anchor_type IN (${placeholders})`,
    )
    .get(manifestHash, ...STRONG_ANCHOR_TYPES) as { n: number };
  return row.n > 0;
}
