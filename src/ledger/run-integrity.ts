import type { Ledger } from "../db/index.ts";
import {
  comparableRunConfig,
  expectedObservationCount,
  runsForEngine,
  verifyRunConfig,
  type RunConfigV1,
} from "../lib/run-config.ts";

export interface RunIntegrityResult {
  runId: string;
  valid: boolean;
  sealed: boolean;
  expectedObservations: number | null;
  actualObservations: number;
  config: RunConfigV1 | null;
  comparableConfig: string | null;
  errors: string[];
}

export function inspectRunIntegrity(
  db: Ledger,
  runId: string,
  options: { requireSealed?: boolean } = {},
): RunIntegrityResult {
  const row = db
    .prepare(
      `SELECT id, prompt_set_id, phase, finished_at, config_json, config_hash
         FROM collection_run WHERE id = ?`,
    )
    .get(runId) as
    | {
        id: string;
        prompt_set_id: string;
        phase: string;
        finished_at: string | null;
        config_json: string | null;
        config_hash: string | null;
      }
    | undefined;
  if (!row) {
    return {
      runId,
      valid: false,
      sealed: false,
      expectedObservations: null,
      actualObservations: 0,
      config: null,
      comparableConfig: null,
      errors: ["run 不存在"],
    };
  }

  const errors: string[] = [];
  const sealed = row.finished_at !== null;
  if (options.requireSealed !== false && !sealed) errors.push("run 尚未封存");
  const actualObservations = (
    db.prepare(`SELECT COUNT(*) AS n FROM observation WHERE run_id = ?`).get(runId) as { n: number }
  ).n;
  if (!row.config_json || !row.config_hash) {
    errors.push("run 缺少 canonical config/hash");
    return {
      runId,
      valid: false,
      sealed,
      expectedObservations: null,
      actualObservations,
      config: null,
      comparableConfig: null,
      errors,
    };
  }

  let config: RunConfigV1;
  try {
    config = verifyRunConfig(row.config_json, row.config_hash);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return {
      runId,
      valid: false,
      sealed,
      expectedObservations: null,
      actualObservations,
      config: null,
      comparableConfig: null,
      errors,
    };
  }

  const set = db
    .prepare(`SELECT frozen_hash FROM prompt_set WHERE id = ?`)
    .get(row.prompt_set_id) as { frozen_hash: string | null } | undefined;
  if (!set?.frozen_hash) errors.push("run 对应 prompt 集不存在或未冻结");
  if (config.prompt_set_id !== row.prompt_set_id) errors.push("config prompt_set_id 与 run 不一致");
  if (config.prompt_set_hash !== set?.frozen_hash) errors.push("config prompt_set_hash 与当前冻结 hash 不一致");
  if (config.phase !== row.phase) errors.push("config phase 与 run 不一致");

  const prompts = db
    .prepare(`SELECT id, locale FROM prompt WHERE prompt_set_id = ? ORDER BY id`)
    .all(row.prompt_set_id) as Array<{ id: string; locale: string }>;
  const locales = [...new Set(prompts.map((prompt) => prompt.locale))].sort();
  if (JSON.stringify(locales) !== JSON.stringify(config.prompt_locales)) {
    errors.push("config prompt_locales 与冻结集合不一致");
  }
  const expectedObservations = expectedObservationCount(config, prompts.length);
  if (actualObservations !== expectedObservations) {
    errors.push(`观测不完整：计划 ${expectedObservations}，实际 ${actualObservations}`);
  }

  const actualCells = db
    .prepare(
      `SELECT o.prompt_id, o.engine, COUNT(*) AS n, MIN(o.run_idx) AS min_idx, MAX(o.run_idx) AS max_idx
         FROM observation o WHERE o.run_id = ? GROUP BY o.prompt_id, o.engine`,
    )
    .all(runId) as Array<{
    prompt_id: string;
    engine: string;
    n: number;
    min_idx: number;
    max_idx: number;
  }>;
  const actual = new Map(actualCells.map((cell) => [`${cell.prompt_id}|${cell.engine}`, cell]));
  let missingOrMalformed = 0;
  for (const prompt of prompts) {
    for (const engine of config.engines) {
      const expectedRuns = runsForEngine(config, engine.name);
      const key = `${prompt.id}|${engine.name}`;
      const cell = actual.get(key);
      if (!cell || cell.n !== expectedRuns || cell.min_idx !== 1 || cell.max_idx !== expectedRuns) {
        missingOrMalformed += 1;
      }
      actual.delete(key);
    }
  }
  if (missingOrMalformed) errors.push(`${missingOrMalformed} 个 prompt×engine 单元缺失或 run_idx 不完整`);
  if (actual.size) errors.push(`${actual.size} 个未计划的 prompt×engine 单元`);

  const crossSet = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM observation o
          JOIN prompt p ON p.id = o.prompt_id
         WHERE o.run_id = ? AND p.prompt_set_id != ?`,
      )
      .get(runId, row.prompt_set_id) as { n: number }
  ).n;
  if (crossSet) errors.push(`${crossSet} 条观测来自其他 prompt 集`);

  return {
    runId,
    valid: errors.length === 0,
    sealed,
    expectedObservations,
    actualObservations,
    config,
    comparableConfig: comparableRunConfig(config),
    errors,
  };
}
