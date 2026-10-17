import { randomUUID } from "node:crypto";
import type { Ledger } from "../db/index.ts";
import { inTransaction } from "../db/index.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import { getManifest, hasStrongAnchor } from "./manifest.ts";

/**
 * 预注册 —— 干预前锁定实验方案。
 *
 * 报告里那句「本方案在干预前已锁定，未做任何事后筛选」，
 * 靠的就是这张表 + prompt_set.frozen_hash + assignment.rng_seed 三者绑定。
 *
 * content_hash 覆盖全部方案字段。客户拿到这个 hash，
 * 后面任何对方案的修改都会让它对不上。
 *
 * ⚠️ 关键操作：预注册产生的 hash 必须在干预开始前用带时间戳的方式送达客户
 * （邮件 / 合同附件 / 公开发布）。事后补发的 hash 没有任何证明力 ——
 * 因为你完全可以先看结果再构造一个好看的方案。
 */

export interface PreregInput {
  promptSetId: string;
  manifestHash: string;
}

export interface PreregRecord {
  id: string;
  promptSetId: string;
  registeredAt: string;
  manifestHash: string;
  promptSetHash: string;
  primaryMetric: string;
  engines: string[];
  runsPerPrompt: number;
  plannedBaselineRounds: number;
  plannedFollowupRounds: number;
  hypothesis: string;
  contentHash: string;
}

/** 预注册指纹绑定完整 manifest；方案字段只从 manifest 派生，不能提交两套真相。 */
export function computeContentHash(input: PreregInput): string {
  return sha256(canonicalJson({ prompt_set_id: input.promptSetId, manifest_hash: input.manifestHash }));
}

interface ManifestShape {
  prompt_set: { id: string; hash: string };
  hypothesis: string;
  metrics: { primary: { id: string; denominator: string } };
  baseline_runs: Array<{
    config: {
      sampling?: { default?: number; by_engine?: Record<string, number> };
      engines?: Array<{ name?: string }>;
    };
  }>;
  plan: { planned_followup_rounds: number };
}

export function registerPrereg(db: Ledger, input: PreregInput): PreregRecord {
  const existing = db
    .prepare(`SELECT COUNT(*) AS n FROM preregistration WHERE prompt_set_id = ?`)
    .get(input.promptSetId) as { n: number };
  if (existing.n > 0) {
    throw new Error(
      "该 prompt 集已有预注册记录。预注册不可重做 —— " +
        "改方案等于推翻「事前锁定」这个前提。",
    );
  }

  const assignmentCount = db
    .prepare(`SELECT COUNT(*) AS n FROM assignment WHERE prompt_set_id = ?`)
    .get(input.promptSetId) as { n: number };
  if (assignmentCount.n === 0) {
    throw new Error("请先完成分组（assign）再预注册 —— 方案里必须包含确定的分组。");
  }

  const contaminated = db
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM intervention WHERE prompt_set_id = ?) AS has_intervention,
         EXISTS(SELECT 1 FROM collection_run WHERE prompt_set_id = ? AND phase = 'followup') AS has_followup`,
    )
    .get(input.promptSetId, input.promptSetId) as { has_intervention: number; has_followup: number };
  if (contaminated.has_intervention || contaminated.has_followup) {
    throw new Error("已有干预或 follow-up，不能事后补预注册");
  }

  const manifest = getManifest(db, input.manifestHash);
  if (!manifest || manifest.promptSetId !== input.promptSetId) {
    throw new Error("manifest 不存在、hash 不匹配或属于另一个 prompt 集");
  }
  if (!hasStrongAnchor(db, input.manifestHash)) {
    throw new Error(
      "manifest 尚无强外部锚点。GitHub commit 可作源码佐证，但预注册还需要 email/contract/RFC3161/OpenTimestamps",
    );
  }
  const document = JSON.parse(manifest.canonicalJson) as ManifestShape;
  if (document.prompt_set.id !== input.promptSetId) throw new Error("manifest prompt_set 不匹配");
  const firstConfig = document.baseline_runs[0]?.config;
  const engines = [...new Set((firstConfig?.engines ?? []).map((row) => row.name).filter(Boolean))] as string[];
  const sampling = firstConfig?.sampling;
  const runsPerPrompt = Math.max(
    sampling?.default ?? 0,
    ...Object.values(sampling?.by_engine ?? {}),
    0,
  );
  const primaryMetric = `${document.metrics.primary.id}（分母：${document.metrics.primary.denominator}）`;

  const id = randomUUID();
  const contentHash = computeContentHash(input);

  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO preregistration
         (id, prompt_set_id, prompt_set_hash, primary_metric, engines,
          runs_per_prompt, planned_baseline_rounds, planned_followup_rounds,
          hypothesis, content_hash, manifest_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.promptSetId,
      document.prompt_set.hash,
      primaryMetric,
      JSON.stringify(engines),
      runsPerPrompt,
      document.baseline_runs.length,
      document.plan.planned_followup_rounds,
      document.hypothesis,
      contentHash,
      input.manifestHash,
    );
  });

  const row = db
    .prepare(`SELECT registered_at FROM preregistration WHERE id = ?`)
    .get(id) as { registered_at: string };

  return {
    id,
    promptSetId: input.promptSetId,
    registeredAt: row.registered_at,
    manifestHash: input.manifestHash,
    promptSetHash: document.prompt_set.hash,
    primaryMetric,
    engines,
    runsPerPrompt,
    plannedBaselineRounds: document.baseline_runs.length,
    plannedFollowupRounds: document.plan.planned_followup_rounds,
    hypothesis: document.hypothesis,
    contentHash,
  };
}

export function getPrereg(db: Ledger, promptSetId: string): PreregRecord | null {
  const row = db
    .prepare(`SELECT * FROM preregistration WHERE prompt_set_id = ?`)
    .get(promptSetId) as
    | {
        id: string;
        prompt_set_id: string;
        registered_at: string;
        prompt_set_hash: string;
        primary_metric: string;
        engines: string;
        runs_per_prompt: number;
        planned_baseline_rounds: number;
        planned_followup_rounds: number;
        hypothesis: string;
        content_hash: string;
        manifest_hash: string | null;
      }
    | undefined;
  if (!row) return null;

  return {
    id: row.id,
    promptSetId: row.prompt_set_id,
    registeredAt: row.registered_at,
    manifestHash: row.manifest_hash ?? "legacy-unanchored",
    promptSetHash: row.prompt_set_hash,
    primaryMetric: row.primary_metric,
    engines: JSON.parse(row.engines) as string[],
    runsPerPrompt: row.runs_per_prompt,
    plannedBaselineRounds: row.planned_baseline_rounds,
    plannedFollowupRounds: row.planned_followup_rounds,
    hypothesis: row.hypothesis,
    contentHash: row.content_hash,
  };
}

export function renderPrereg(record: PreregRecord): string {
  return [
    "预注册完成 —— 方案已锁定",
    "=".repeat(78),
    `注册时间   ${record.registeredAt}`,
    `方案指纹   ${record.contentHash}`,
    `Manifest   ${record.manifestHash}`,
    `问题集指纹 ${record.promptSetHash}`,
    "",
    `假设       ${record.hypothesis}`,
    `主指标     ${record.primaryMetric}`,
    `引擎       ${record.engines.join(", ")}`,
    `采样       每 prompt ${record.runsPerPrompt} 次`,
    `计划轮次   基线 ${record.plannedBaselineRounds} 轮 · 干预后 ${record.plannedFollowupRounds} 轮`,
    "",
    "=".repeat(78),
    "外部锚点已在 manifest_anchor 中记录；GitHub commit 不能单独充当强锚点。",
    "",
    "    停止规则：跑满计划轮次即出报告。",
    "    不因为「再等等可能更好看」而延长 —— 那就是事后挑选。",
  ].join("\n");
}

/** 干预登记。没记录的干预，最终报告里无法归因。 */
export function recordIntervention(
  db: Ledger,
  input: {
    promptSetId: string;
    url?: string;
    assetType: string;
    publishedAt: string;
    targetPromptIds: string[];
    note?: string;
  },
): string {
  if (!input.targetPromptIds.length) {
    throw new Error("干预必须指定目标 prompt —— 没有目标就无法归因");
  }
  // 干预只能指向 treatment 组 —— 动了对照组，对照就失效了
  const targetIds = [...new Set(input.targetPromptIds)];
  const placeholders = targetIds.map(() => "?").join(",");
  const valid = db
    .prepare(
      `SELECT COUNT(*) AS n FROM assignment
        WHERE prompt_set_id = ? AND prompt_id IN (${placeholders}) AND arm = 'treatment'`,
    )
    .get(input.promptSetId, ...targetIds) as { n: number };
  if (valid.n !== targetIds.length) {
    throw new Error(
      "干预目标必须全部存在、属于同一 prompt 集且已分到 treatment；对照组不能被干预",
    );
  }

  const id = randomUUID();
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO intervention
         (id, prompt_set_id, url, asset_type, published_at, target_prompt_ids, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.promptSetId,
      input.url ?? null,
      input.assetType,
      input.publishedAt,
      JSON.stringify(targetIds),
      input.note ?? null,
    );
  });
  return id;
}

/** 客户侧变更登记。「不确定有没有影响」的也要记 —— 那本身就是要披露的。 */
export function recordClientChange(
  db: Ledger,
  input: {
    promptSetId: string;
    occurredAt: string;
    kind: string;
    description: string;
    reportedBy?: string;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO client_change
       (id, prompt_set_id, occurred_at, kind, description, reported_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.promptSetId,
    input.occurredAt,
    input.kind,
    input.description,
    input.reportedBy ?? null,
  );
  return id;
}
