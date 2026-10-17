import { inTransaction, type Ledger } from "./db/index.ts";
import type { EngineAdapter } from "./engines/types.ts";
import { canonicalJson, sha256 } from "./lib/canonical-json.ts";
import {
  finishRun,
  getBrand,
  getPromptSet,
  listPrompts,
  listRunObservationKeys,
  recordObservation,
  startRun,
  updateRunSpend,
} from "./ledger/repo.ts";

export interface CollectOptions {
  promptSetId: string;
  phase: "baseline" | "followup";
  engines: EngineAdapter[];
  /** 默认采样次数；被 runsByEngine 中的同名项覆盖。 */
  runsPerPrompt: number;
  /**
   * 按引擎指定采样次数。
   *
   * 为什么需要：不同引擎的「每条可用观测成本」相差 30 倍以上。
   * 需要 N=10 的是要测引用率变化的主战场；
   * 确认「某引擎根本不检索」这种二元事实，N=2~3 就足够，
   * 再多花的钱买不到信息。
   *
   * 注意：改变某引擎的 N 会改变该引擎观测的统计功效 ——
   * 同一实验窗口内不要调整，否则前后轮次不可比。
   */
  runsByEngine?: Record<string, number>;
  concurrency?: number;
  note?: string;
  /** 本轮美元预算上限。缺省读 COLLECT_MAX_COST_USD，再缺省 10。 */
  maxCostUsd?: number;
  /**
   * 续跑已中断的 run：沿用该 run_id，跳过其中已入账的观测。
   * 中断（断路器 / 关终端 / 断网）后补齐用，避免一轮白跑。
   * 续的是同一个 run —— 分析按 run 聚合，拆成两个 run 会让样本量看起来不对。
   */
  resumeRunId?: string;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Service-owned durable lifecycle hooks; all are synchronous ledger writes. */
  onStarted?: (runId: string) => void;
  beforeQuery?: (job: { promptId: string; engine: string; runIdx: number }) => void;
  onRecorded?: (job: { promptId: string; engine: string; runIdx: number }) => void;
  shouldPause?: () => boolean;
}

export interface CollectResult {
  runId: string;
  /** 计划的观测总数 */
  total: number;
  /** 实际完成的观测数（断路后小于 total） */
  completed: number;
  /** 本轮累计成本（DataForSEO 报告值 + 其他引擎的兜底估算） */
  spentUsd: number;
  /** true = 成本断路器触发，本轮提前终止 */
  tripped: boolean;
  /** 因连续报错被熔断跳过的引擎（配额耗尽、密钥失效等，剩余任务不再派发） */
  skippedEngines: string[];
  /** 续跑时已存在、本次跳过的观测数 */
  alreadyDone: number;
}

interface Job {
  promptId: string;
  promptText: string;
  locale: string;
  engine: EngineAdapter;
  runIdx: number;
}

/**
 * 采集一轮观测。
 *
 * 每个 prompt 跑 N 次是刻意的：LLM 是非确定性的，
 * 单次观测的「有没有被引用」是个抛硬币的结果。
 * 我们要的是引用率（N 次里中了几次），那才是能做统计检验的量。
 *
 * 成本断路器：累计花费达到预算上限即停止派发新任务。
 * DataForSEO 每次响应报告精确成本；直连引擎不报告，
 * 用 COLLECT_COST_FALLBACK_USD 兜底（宁可估高提前断，不可估低爆预算）。
 * 断路是「软停」：在途任务照常完成并入账，只是不再派新的 ——
 * 半截轮次也是有效观测，丢弃才是偏移。
 */
export async function collect(db: Ledger, options: CollectOptions): Promise<CollectResult> {
  const set = getPromptSet(db, options.promptSetId);

  if (!set.frozen_at) {
    throw new Error(
      "prompt 集尚未冻结。基线采集前必须先 freeze —— 否则无法证明集合没有被事后调整。",
    );
  }

  const brand = getBrand(db, set.brand_id);
  const prompts = listPrompts(db, options.promptSetId);

  if (!options.engines.length) {
    throw new Error("没有可用引擎：检查 .env 里的 API 密钥是否已配置");
  }

  const runsFor = (engineName: string): number =>
    Math.max(1, options.runsByEngine?.[engineName] ?? options.runsPerPrompt);

  const allJobs: Job[] = [];
  for (const prompt of prompts) {
    for (const engine of options.engines) {
      for (let runIdx = 1; runIdx <= runsFor(engine.name); runIdx += 1) {
        allJobs.push({
          promptId: prompt.id,
          promptText: prompt.text,
          locale: prompt.locale,
          engine,
          runIdx,
        });
      }
    }
  }

  // runs_per_prompt 存有效值：分引擎时取实际用到的最大 N。
  // 存 options.runsPerPrompt（default 值）会在 "default=0,x=3" 时记成 0，
  // 那是错误的实验条件记录。
  const effectiveRuns = Math.max(
    ...options.engines.map((engine) => runsFor(engine.name)),
    0,
  );
  const runsConfig =
    Object.keys(options.runsByEngine ?? {}).length > 0
      ? [
          `default=${options.runsPerPrompt}`,
          ...Object.entries(options.runsByEngine ?? {}).map(([k, v]) => `${k}=${v}`),
        ].join(",")
      : String(options.runsPerPrompt);

  const configJson = canonicalJson({
    schema_version: "run-config-v1",
    prompt_set_id: options.promptSetId,
    prompt_set_hash: set.frozen_hash,
    phase: options.phase,
    prompt_locales: [...new Set(prompts.map((prompt) => prompt.locale))].sort(),
    sampling: {
      default: options.runsPerPrompt,
      by_engine: Object.fromEntries(
        Object.entries(options.runsByEngine ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    engines: options.engines
      .map((engine) => ({ name: engine.name, config: engine.getRunConfig?.() ?? {} }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
  const configHash = sha256(configJson);

  // 续跑前校验：配置不一致的续跑会把两组不同条件的观测混进同一个 run，
  // 而数据库完整性检查发现不了 —— 必须在发出任何请求之前失败。
  if (options.resumeRunId) {
    const prior = db
      .prepare(
        `SELECT prompt_set_id, phase, runs_config, config_hash, finished_at
           FROM collection_run WHERE id = ?`,
      )
      .get(options.resumeRunId) as
      | {
          prompt_set_id: string;
          phase: string;
          runs_config: string | null;
          config_hash: string | null;
          finished_at: string | null;
        }
      | undefined;

    if (!prior) throw new Error(`要续跑的 run 不存在：${options.resumeRunId}`);
    if (prior.finished_at) {
      throw new Error(`run ${options.resumeRunId} 已封存，不能继续写入；请新建轮次`);
    }
    if (prior.prompt_set_id !== options.promptSetId) {
      throw new Error(
        `run ${options.resumeRunId} 属于另一个 prompt 集，不能跨集合续跑`,
      );
    }
    if (prior.phase !== options.phase) {
      throw new Error(
        `run 的 phase 是 ${prior.phase}，本次是 ${options.phase} —— ` +
          `混合不同阶段的观测会让前后对比失效`,
      );
    }
    if (prior.runs_config && prior.runs_config !== runsConfig) {
      throw new Error(
        `采样配置不一致：原轮次「${prior.runs_config}」，本次「${runsConfig}」。\n` +
          `续跑必须沿用相同配置，否则同一个 run 里会混入不同密度的观测。`,
      );
    }
    if (!prior.config_hash) {
      throw new Error(
        "旧轮次没有 canonical config，无法证明模型/端点/地域一致，禁止续跑；请新建轮次",
      );
    }
    if (prior.config_hash !== configHash) {
      throw new Error(
        `实验配置不一致：原轮次 ${prior.config_hash}，本次 ${configHash}。` +
          "引擎集合、模型、端点、地域、locale 与采样密度必须全部一致",
      );
    }
  }

  const runId = inTransaction(db, () => { const id =
    options.resumeRunId ??
    startRun(db, {
      promptSetId: options.promptSetId,
      phase: options.phase,
      runsPerPrompt: effectiveRuns,
      runsConfig,
      configJson,
      configHash,
      note: options.note,
    });
    options.onStarted?.(id);
    return id;
  });
  const priorSpend = (db.prepare(`SELECT spent_usd FROM collection_run WHERE id = ?`).get(runId) as { spent_usd: number | null }).spent_usd ?? 0;

  // 续跑：跳过该 run 里已入账的 (prompt, engine, run_idx) 组合。
  // 唯一约束本就会挡住重复写入，这里提前过滤是为了不白花 API 调用。
  const existing = new Set(
    (
      listRunObservationKeys(db, runId) as ReadonlyArray<{
        prompt_id: string;
        engine: string;
        run_idx: number;
      }>
    ).map((row) => `${row.prompt_id}|${row.engine}|${row.run_idx}`),
  );

  const jobs = existing.size
    ? allJobs.filter((job) => !existing.has(`${job.promptId}|${job.engine.name}|${job.runIdx}`))
    : allJobs;

  // 顺序打散：中断后剩下的若按字母序截断，prompt 覆盖会有系统性偏差。
  // 用 run_idx 轮转，保证任何时刻中断，各 prompt 的采样数都大致均衡。
  jobs.sort((a, b) => a.runIdx - b.runIdx || a.engine.name.localeCompare(b.engine.name));

  const concurrency = Math.max(1, options.concurrency ?? 4);
  const maxCostUsd =
    options.maxCostUsd ?? Number.parseFloat(process.env.COLLECT_MAX_COST_USD ?? "10");
  const fallbackCostUsd = Number.parseFloat(process.env.COLLECT_COST_FALLBACK_USD ?? "0.01");
  // 引擎熔断阈值：同一引擎连续 N 次 error 后跳过它的剩余任务。
  // 配额耗尽 / 密钥失效的引擎会把整轮拖成报错流水，熔断掉省时间也省台账噪音。
  const errorTrip = Math.max(
    1,
    Number.parseInt(process.env.COLLECT_ENGINE_ERROR_TRIP ?? "5", 10),
  );

  let cursor = 0;
  let done = 0;
  let spentUsd = 0;
  let tripped = false;
  const consecutiveErrors = new Map<string, number>();
  const skippedEngines = new Set<string>();

  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      // 派发前检查预算。在途任务不中断：半截轮次也是有效观测。
      if (options.shouldPause?.()) break;
      if (priorSpend + spentUsd >= maxCostUsd) {
        tripped = true;
        break;
      }

      const job = jobs[cursor];
      cursor += 1;
      if (!job) break;
      if (skippedEngines.has(job.engine.name)) continue;

      const identity = { promptId: job.promptId, engine: job.engine.name, runIdx: job.runIdx };
      options.beforeQuery?.(identity);
      const observation = await job.engine.query({
        prompt: job.promptText,
        locale: job.locale,
      });
      const surfaceDescriptor = job.engine.getSurfaceContext?.(job.locale);
      const surfaceContext = surfaceDescriptor
        ? {
            ...surfaceDescriptor,
            evidenceSha256: sha256(
              canonicalJson({
                schema_version: "native-observation-evidence-v1",
                run_id: runId,
                prompt_id: job.promptId,
                run_idx: job.runIdx,
                locale: job.locale,
                surface: surfaceDescriptor,
                observation,
              }),
            ),
          }
        : undefined;

      spentUsd += observation.costUsd ?? fallbackCostUsd;

      if (observation.fidelity === "error") {
        const streak = (consecutiveErrors.get(job.engine.name) ?? 0) + 1;
        consecutiveErrors.set(job.engine.name, streak);
        if (streak >= errorTrip) skippedEngines.add(job.engine.name);
      } else {
        consecutiveErrors.set(job.engine.name, 0);
      }

      // 失败也入账。静默丢弃失败样本会让引用率系统性偏高。
      inTransaction(db, () => {
      recordObservation(db, {
        runId,
        promptId: job.promptId,
        runIdx: job.runIdx,
        locale: job.locale,
        brand,
        observation,
        surfaceContext,
      });
      updateRunSpend(db, runId, priorSpend + spentUsd);
      options.onRecorded?.(identity);
      });

      done += 1;
      options.onProgress?.(done, jobs.length, `${job.engine.name} · ${job.promptText.slice(0, 40)}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  // 续跑时累加到已有花费上，而不是覆盖
  const cumulativeDone = existing.size + done;
  if (cumulativeDone >= allJobs.length) {
    finishRun(db, runId, priorSpend + spentUsd);
  } else {
    updateRunSpend(db, runId, priorSpend + spentUsd);
  }

  return {
    runId,
    total: allJobs.length,
    completed: done,
    spentUsd,
    tripped,
    skippedEngines: [...skippedEngines],
    alreadyDone: existing.size,
  };
}
