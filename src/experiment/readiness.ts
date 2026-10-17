import type { Ledger } from "../db/index.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import { inspectRunIntegrity } from "../ledger/run-integrity.ts";
import { STRONG_ANCHOR_TYPES } from "./manifest.ts";
import { ASSIGN_ALGO_VERSION, readBaselines, stratifiedAssign } from "./assign.ts";

export type ReadinessStage = "baseline" | "intervention" | "analysis";
export type ReadinessCheckStatus = "pass" | "fail" | "warning";

export interface ReadinessCheck {
  id: string;
  status: ReadinessCheckStatus;
  detail: string;
  requiredFor: ReadinessStage[];
}

export interface ExperimentReadiness {
  promptSetId: string;
  parserVersion: string;
  promptCount: number;
  eligibleBaselineRunIds: string[];
  eligibleFollowupRunIds: string[];
  manifestHash: string | null;
  stages: Record<ReadinessStage, boolean>;
  checks: ReadinessCheck[];
}

interface ManifestShape {
  parser_version?: string;
  prompt_set?: { id?: string; hash?: string };
  baseline_runs?: Array<{ id?: string; config_hash?: string }>;
  assignment?: {
    algorithm_version?: string;
    seed?: string;
    rows?: Array<{ prompt_id?: string; arm?: string; stratum?: string }>;
  };
  plan?: { planned_followup_rounds?: number };
}

function coverage(db: Ledger, runId: string, parserVersion: string): { total: number; covered: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN i.observation_id IS NOT NULL THEN 1 ELSE 0 END) AS covered
         FROM observation o
         LEFT JOIN observation_interpretation i
           ON i.observation_id = o.id AND i.parser_version = ?
        WHERE o.run_id = ?`,
    )
    .get(parserVersion, runId) as { total: number; covered: number | null };
  return { total: row.total, covered: row.covered ?? 0 };
}

function stageReady(checks: readonly ReadinessCheck[], stage: ReadinessStage): boolean {
  return !checks.some((check) => check.requiredFor.includes(stage) && check.status === "fail");
}

export function inspectExperimentReadiness(
  db: Ledger,
  input: { promptSetId: string; parserVersion: string; manifestHash?: string },
): ExperimentReadiness {
  const checks: ReadinessCheck[] = [];
  const add = (
    id: string,
    status: ReadinessCheckStatus,
    detail: string,
    requiredFor: ReadinessStage[],
  ): void => {
    checks.push({ id, status, detail, requiredFor });
  };
  const allStages: ReadinessStage[] = ["baseline", "intervention", "analysis"];

  const set = db
    .prepare(`SELECT frozen_hash, frozen_at FROM prompt_set WHERE id = ?`)
    .get(input.promptSetId) as { frozen_hash: string | null; frozen_at: string | null } | undefined;
  const promptCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM prompt WHERE prompt_set_id = ?`).get(input.promptSetId) as {
      n: number;
    }
  ).n;
  add(
    "prompt_set_frozen",
    set?.frozen_hash && set.frozen_at ? "pass" : "fail",
    set?.frozen_hash ? `已冻结；hash ${set.frozen_hash}` : "prompt 集不存在或尚未冻结",
    allStages,
  );
  add(
    "minimum_prompt_pool",
    promptCount >= 16 ? "pass" : "fail",
    `${promptCount} 条 prompt；正式推断最低门槛为每组 8 条，功效模拟可能要求更多`,
    allStages,
  );

  const runs = db
    .prepare(`SELECT id, phase FROM collection_run WHERE prompt_set_id = ? ORDER BY started_at`)
    .all(input.promptSetId) as Array<{ id: string; phase: "baseline" | "followup" }>;
  const validByPhase: Record<"baseline" | "followup", Array<ReturnType<typeof inspectRunIntegrity>>> = {
    baseline: [],
    followup: [],
  };
  for (const run of runs) {
    const integrity = inspectRunIntegrity(db, run.id);
    const parser = coverage(db, run.id, input.parserVersion);
    if (integrity.valid && parser.total > 0 && parser.covered === parser.total) {
      validByPhase[run.phase].push(integrity);
    }
  }

  const baselineGroups = new Map<string, Array<ReturnType<typeof inspectRunIntegrity>>>();
  for (const run of validByPhase.baseline) {
    const key = run.comparableConfig!;
    baselineGroups.set(key, [...(baselineGroups.get(key) ?? []), run]);
  }
  const selectedBaselineGroup = [...baselineGroups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const eligibleBaselineRunIds = selectedBaselineGroup.map((run) => run.runId);
  add(
    "two_comparable_baselines",
    eligibleBaselineRunIds.length >= 2 ? "pass" : "fail",
    eligibleBaselineRunIds.length >= 2
      ? `${eligibleBaselineRunIds.length} 个已封存、完整、parser 全覆盖且配置可比较的 baseline`
      : `只有 ${eligibleBaselineRunIds.length} 个合格 baseline；需要至少 2 个`,
    allStages,
  );

  const badRuns = runs.filter(
    (run) => !validByPhase[run.phase].some((candidate) => candidate.runId === run.id),
  );
  add(
    "invalid_or_legacy_runs",
    badRuns.length ? "warning" : "pass",
    badRuns.length
      ? `${badRuns.length} 个 run 因未封存、legacy config、矩阵不完整或 parser 覆盖不足而不具 formal 资格`
      : "所有 run 均通过 formal 完整性检查",
    [],
  );

  const contamination = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM intervention WHERE prompt_set_id = ?) AS interventions,
         (SELECT COUNT(*) FROM collection_run WHERE prompt_set_id = ? AND phase = 'followup') AS followups,
         (SELECT MIN(started_at) FROM collection_run WHERE prompt_set_id = ? AND phase = 'followup') AS first_followup,
         (SELECT MIN(published_at) FROM intervention WHERE prompt_set_id = ?) AS first_intervention,
         (SELECT MAX(published_at) FROM intervention WHERE prompt_set_id = ?) AS last_intervention`,
    )
    .get(
      input.promptSetId,
      input.promptSetId,
      input.promptSetId,
      input.promptSetId,
      input.promptSetId,
    ) as {
    interventions: number;
    followups: number;
    first_followup: string | null;
    first_intervention: string | null;
    last_intervention: string | null;
  };

  const assignmentRows = db
    .prepare(
      `SELECT prompt_id, arm, stratum, rng_seed, algo_version
         FROM assignment WHERE prompt_set_id = ? ORDER BY prompt_id`,
    )
    .all(input.promptSetId) as Array<{
    prompt_id: string;
    arm: string;
    stratum: string;
    rng_seed: string;
    algo_version: string | null;
  }>;
  const treatment = assignmentRows.filter((row) => row.arm === "treatment").length;
  const control = assignmentRows.filter((row) => row.arm === "control").length;
  const assignmentConsistent =
    assignmentRows.length > 0 &&
    new Set(assignmentRows.map((row) => row.rng_seed)).size === 1 &&
    new Set(assignmentRows.map((row) => row.algo_version)).size === 1;
  add(
    "assignment",
    assignmentConsistent && Math.min(treatment, control) >= 8 ? "pass" : "fail",
    assignmentRows.length
      ? `干预 ${treatment}、对照 ${control}；seed/algorithm ${assignmentConsistent ? "一致" : "不一致"}`
      : "尚未写入 assignment",
    ["intervention", "analysis"],
  );

  const manifestRow = input.manifestHash
    ? (db
        .prepare(`SELECT canonical_json, content_hash FROM experiment_manifest WHERE content_hash = ? AND prompt_set_id = ?`)
        .get(input.manifestHash, input.promptSetId) as
        | { canonical_json: string; content_hash: string }
        | undefined)
    : (db
        .prepare(`SELECT canonical_json, content_hash FROM experiment_manifest WHERE prompt_set_id = ?`)
        .get(input.promptSetId) as { canonical_json: string; content_hash: string } | undefined);
  let manifest: ManifestShape | null = null;
  let manifestValid = false;
  if (manifestRow) {
    try {
      manifest = JSON.parse(manifestRow.canonical_json) as ManifestShape;
      const manifestBaselines = (manifest.baseline_runs ?? [])
        .map((run) => run.id)
        .filter((id): id is string => Boolean(id));
      const manifestBaselineRows = manifestBaselines
        .map((runId) => validByPhase.baseline.find((run) => run.runId === runId))
        .filter((run): run is ReturnType<typeof inspectRunIntegrity> => Boolean(run));
      const baselinesValid =
        manifestBaselines.length >= 2 &&
        manifestBaselineRows.length === manifestBaselines.length &&
        new Set(manifestBaselineRows.map((run) => run.comparableConfig)).size === 1;
      const assignmentSnapshot = (manifest.assignment?.rows ?? [])
        .map((row) => ({ prompt_id: row.prompt_id, arm: row.arm, stratum: row.stratum }))
        .sort((a, b) => (a.prompt_id ?? "").localeCompare(b.prompt_id ?? ""));
      const persistedSnapshot = assignmentRows
        .map((row) => ({ prompt_id: row.prompt_id, arm: row.arm, stratum: row.stratum }))
        .sort((a, b) => a.prompt_id.localeCompare(b.prompt_id));
      const recomputed =
        manifest.assignment?.algorithm_version === ASSIGN_ALGO_VERSION && manifest.assignment.seed
          ? stratifiedAssign(
              readBaselines(db, input.promptSetId, {
                parserVersion: input.parserVersion,
                runIds: manifestBaselines,
              }),
              manifest.assignment.seed,
            ).assignments
              .map((row) => ({
                prompt_id: row.promptId,
                arm: row.arm,
                stratum: row.stratum,
              }))
              .sort((a, b) => a.prompt_id.localeCompare(b.prompt_id))
          : [];
      const assignmentsValid =
        canonicalJson(assignmentSnapshot) === canonicalJson(persistedSnapshot) &&
        canonicalJson(recomputed) === canonicalJson(persistedSnapshot);
      manifestValid =
        sha256(manifestRow.canonical_json) === manifestRow.content_hash &&
        manifest.prompt_set?.id === input.promptSetId &&
        manifest.prompt_set?.hash === set?.frozen_hash &&
        manifest.parser_version === input.parserVersion &&
        baselinesValid &&
        assignmentsValid;
    } catch {
      manifestValid = false;
    }
  }
  add(
    "manifest",
    manifestValid ? "pass" : "fail",
    manifestValid
      ? `canonical manifest 已绑定 parser、分组和 ${manifest!.baseline_runs!.length} 个合格 baseline`
      : "没有与当前 parser、prompt hash、分组及合格 baseline 一致的 manifest",
    ["intervention", "analysis"],
  );

  const manifestHash = manifestRow?.content_hash ?? null;
  const strongAnchorCount = manifestHash
    ? (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM manifest_anchor
              WHERE manifest_hash = ? AND anchor_type IN (${STRONG_ANCHOR_TYPES.map(() => "?").join(",")})`,
          )
          .get(manifestHash, ...STRONG_ANCHOR_TYPES) as { n: number }
      ).n
    : 0;
  add(
    "strong_anchor",
    strongAnchorCount > 0 ? "pass" : "fail",
    strongAnchorCount > 0 ? `${strongAnchorCount} 个强外部锚点` : "尚无 email/contract/RFC3161/OpenTimestamps 强锚点",
    ["intervention", "analysis"],
  );

  const prereg = db
    .prepare(`SELECT manifest_hash, registered_at FROM preregistration WHERE prompt_set_id = ?`)
    .get(input.promptSetId) as { manifest_hash: string; registered_at: string } | undefined;
  add(
    "preregistration",
    prereg?.manifest_hash === manifestHash && manifestHash !== null ? "pass" : "fail",
    prereg ? `预注册绑定 ${prereg.manifest_hash}` : "尚未预注册",
    ["intervention", "analysis"],
  );

  add(
    "intervention_recorded",
    contamination.interventions > 0 ? "pass" : "fail",
    contamination.interventions > 0 ? `${contamination.interventions} 条干预记录` : "尚无干预记录",
    ["analysis"],
  );

  const manifestBaselineConfig = manifestValid
    ? validByPhase.baseline.find((run) => run.runId === manifest!.baseline_runs![0]!.id)
        ?.comparableConfig
    : null;
  const eligibleFollowupRunIds = validByPhase.followup
    .filter((run) => manifestBaselineConfig !== null && run.comparableConfig === manifestBaselineConfig)
    .map((run) => run.runId);
  const plannedFollowups = manifest?.plan?.planned_followup_rounds ?? 0;
  add(
    "planned_followups",
    plannedFollowups > 0 && eligibleFollowupRunIds.length === plannedFollowups ? "pass" : "fail",
    plannedFollowups > 0
      ? `${eligibleFollowupRunIds.length}/${plannedFollowups} 个已封存、完整、parser 全覆盖且配置匹配的 follow-up`
      : "manifest 未规定有效 follow-up 轮数",
    ["analysis"],
  );

  const chronologyValid =
    contamination.followups === 0 ||
    (prereg !== undefined &&
      contamination.interventions > 0 &&
      contamination.first_followup !== null &&
      contamination.first_intervention !== null &&
      contamination.last_intervention !== null &&
      (db
        .prepare(
          `SELECT datetime(?) >= datetime(?)
               AND date(?) >= date(?) AS ok`,
        )
        .get(
          contamination.first_followup,
          contamination.last_intervention,
          contamination.first_intervention,
          prereg.registered_at,
        ) as { ok: number }).ok ===
        1);
  add(
    "chronology",
    chronologyValid ? "pass" : "fail",
    contamination.followups === 0
      ? "尚无 follow-up"
      : chronologyValid
        ? "manifest/预注册/干预/follow-up 顺序成立"
        : "follow-up 缺少事前预注册/干预，或早于最后一项干预",
    ["intervention", "analysis"],
  );

  return {
    promptSetId: input.promptSetId,
    parserVersion: input.parserVersion,
    promptCount,
    eligibleBaselineRunIds,
    eligibleFollowupRunIds,
    manifestHash,
    stages: {
      baseline: stageReady(checks, "baseline"),
      intervention: stageReady(checks, "intervention"),
      analysis: stageReady(checks, "analysis"),
    },
    checks,
  };
}

export function renderExperimentReadiness(result: ExperimentReadiness): string {
  const icon = (status: ReadinessCheckStatus): string =>
    status === "pass" ? "✓" : status === "warning" ? "△" : "✗";
  const yesNo = (ready: boolean): string => (ready ? "READY" : "NOT READY");
  return [
    "正式实验 readiness",
    "=".repeat(84),
    `prompt set  ${result.promptSetId}`,
    `parser      ${result.parserVersion}`,
    `baseline    ${yesNo(result.stages.baseline)}`,
    `intervene   ${yesNo(result.stages.intervention)}`,
    `analyze     ${yesNo(result.stages.analysis)}`,
    "",
    ...result.checks.map((check) => `${icon(check.status)} ${check.id.padEnd(28)} ${check.detail}`),
    "",
    `合格 baseline：${result.eligibleBaselineRunIds.join(", ") || "无"}`,
    `合格 follow-up：${result.eligibleFollowupRunIds.join(", ") || "无"}`,
    `manifest：${result.manifestHash ?? "无"}`,
  ].join("\n");
}
