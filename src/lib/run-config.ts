import { canonicalJson, sha256 } from "./canonical-json.ts";

export interface RunConfigV1 {
  schema_version: "run-config-v1";
  prompt_set_id: string;
  prompt_set_hash: string;
  phase: "baseline" | "followup";
  prompt_locales: string[];
  sampling: { default: number; by_engine: Record<string, number> };
  engines: Array<{ name: string; config: unknown }>;
}

function integerAtLeastZero(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`run config ${label} 必须是非负整数`);
  }
  return value as number;
}

export function parseRunConfig(json: string): RunConfigV1 {
  const raw = JSON.parse(json) as Partial<RunConfigV1>;
  if (raw.schema_version !== "run-config-v1") throw new Error("不支持的 run config schema");
  if (!raw.prompt_set_id || !raw.prompt_set_hash) throw new Error("run config 缺少 prompt set 标识");
  if (raw.phase !== "baseline" && raw.phase !== "followup") throw new Error("run config phase 无效");
  if (!Array.isArray(raw.prompt_locales) || !raw.prompt_locales.every((v) => typeof v === "string")) {
    throw new Error("run config prompt_locales 无效");
  }
  if (!raw.sampling || typeof raw.sampling !== "object") throw new Error("run config sampling 无效");
  const defaultRuns = integerAtLeastZero(raw.sampling.default, "sampling.default");
  const byEngine: Record<string, number> = {};
  for (const [engine, value] of Object.entries(raw.sampling.by_engine ?? {})) {
    byEngine[engine] = integerAtLeastZero(value, `sampling.by_engine.${engine}`);
  }
  if (!Array.isArray(raw.engines) || !raw.engines.length) throw new Error("run config 没有引擎");
  const engines = raw.engines.map((row) => {
    if (!row || typeof row.name !== "string" || !row.name.trim()) {
      throw new Error("run config engine name 无效");
    }
    return { name: row.name, config: row.config ?? {} };
  });
  if (new Set(engines.map((row) => row.name)).size !== engines.length) {
    throw new Error("run config 引擎重复");
  }
  for (const engine of engines) {
    const runs = byEngine[engine.name] ?? defaultRuns;
    if (runs < 1) throw new Error(`run config 引擎 ${engine.name} 的采样次数小于 1`);
  }
  return {
    schema_version: "run-config-v1",
    prompt_set_id: raw.prompt_set_id,
    prompt_set_hash: raw.prompt_set_hash,
    phase: raw.phase,
    prompt_locales: [...raw.prompt_locales].sort(),
    sampling: { default: defaultRuns, by_engine: byEngine },
    engines,
  };
}

export function verifyRunConfig(json: string, hash: string): RunConfigV1 {
  if (sha256(json) !== hash) throw new Error("run config hash 不匹配");
  const config = parseRunConfig(json);
  if (canonicalJson(config) !== json) throw new Error("run config 不是 canonical JSON");
  return config;
}

export function runsForEngine(config: RunConfigV1, engine: string): number {
  return config.sampling.by_engine[engine] ?? config.sampling.default;
}

export function expectedObservationCount(config: RunConfigV1, promptCount: number): number {
  return config.engines.reduce(
    (sum, engine) => sum + runsForEngine(config, engine.name) * promptCount,
    0,
  );
}

/** 前后轮次只允许 phase 不同；其余实验条件必须逐字相同。 */
export function comparableRunConfig(config: RunConfigV1): string {
  const { phase: _phase, ...rest } = config;
  return canonicalJson(rest);
}
