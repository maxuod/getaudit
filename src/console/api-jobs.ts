import { randomUUID } from "node:crypto";
import { z } from "zod";
import { collect } from "../collect.ts";
import { ALL_ENGINES } from "../engines/index.ts";
import type { EngineAdapter } from "../engines/types.ts";
import { getPromptSet } from "../ledger/repo.ts";
import { canonicalJson } from "../lib/canonical-json.ts";
import type { LabService } from "./service.ts";
const schema = z
  .object({
    promptSetId: z.string().uuid(),
    engines: z.array(z.string()).min(1).max(8),
    runsPerPrompt: z.number().int().min(1).max(10),
    maxCostUsd: z.number().positive().max(100),
    costAcknowledged: z.literal(true),
  })
  .strict();
type Config = z.infer<typeof schema>;
type Job = {
  id: string;
  prompt_set_id: string;
  run_id: string | null;
  config_json: string;
  status: string;
  message: string;
  created_at: string;
};
export class ApiJobs {
  readonly lab: LabService;
  readonly engines: EngineAdapter[];
  readonly active = new Map<
    string,
    { pause: boolean; promise: Promise<void> }
  >();
  constructor(lab: LabService, engines = ALL_ENGINES) {
    this.lab = lab;
    this.engines = engines;
    lab.db
      .exec(`CREATE TABLE IF NOT EXISTS console_api_job(id TEXT PRIMARY KEY,prompt_set_id TEXT NOT NULL REFERENCES prompt_set(id),run_id TEXT UNIQUE REFERENCES collection_run(id),config_json TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now')));
  CREATE TABLE IF NOT EXISTS console_api_dispatch(job_id TEXT NOT NULL REFERENCES console_api_job(id),prompt_id TEXT NOT NULL REFERENCES prompt(id),engine TEXT NOT NULL,run_idx INTEGER NOT NULL,status TEXT NOT NULL,PRIMARY KEY(job_id,prompt_id,engine,run_idx));
  CREATE TRIGGER IF NOT EXISTS console_api_job_identity BEFORE UPDATE ON console_api_job WHEN NEW.id IS NOT OLD.id OR NEW.prompt_set_id IS NOT OLD.prompt_set_id OR NEW.config_json IS NOT OLD.config_json OR NEW.created_at IS NOT OLD.created_at OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id) BEGIN SELECT RAISE(ABORT,'API 任务条件不可修改'); END;
  CREATE TRIGGER IF NOT EXISTS console_api_job_no_delete BEFORE DELETE ON console_api_job BEGIN SELECT RAISE(ABORT,'API 任务历史不可删除'); END;
  CREATE TRIGGER IF NOT EXISTS console_api_dispatch_no_delete BEFORE DELETE ON console_api_dispatch BEGIN SELECT RAISE(ABORT,'调用历史不可删除'); END;
  UPDATE console_api_job SET status='interrupted',message='服务曾中断。已入账观测保留；未确认的在途调用不会自动重发。' WHERE status IN ('running','queued');
  UPDATE console_api_job SET status='complete',message='轮次已封存，已恢复完成状态' WHERE run_id IN (SELECT id FROM collection_run WHERE finished_at IS NOT NULL);`);
  }
  rows(setId?: string) {
    return (
      this.lab.db
        .prepare(
          `SELECT j.*,r.spent_usd,(SELECT COUNT(*) FROM observation o WHERE o.run_id=j.run_id) completed,(SELECT COUNT(*) FROM console_api_dispatch d WHERE d.job_id=j.id AND d.status='sent') uncertain FROM console_api_job j LEFT JOIN collection_run r ON r.id=j.run_id ${setId ? "WHERE j.prompt_set_id=?" : ""} ORDER BY j.created_at DESC`,
        )
        .all(...(setId ? [setId] : [])) as unknown as (Job & {
        spent_usd: number | null;
        completed: number;
        uncertain: number;
      })[]
    ).map((j) => ({ ...j, config: JSON.parse(j.config_json) as Config }));
  }
  create(requestId: string, input: unknown) {
    const c = schema.parse(input),
      set = this.lab.assertSetActive(c.promptSetId);
    if (!set.frozen_at) throw new Error("请先冻结问题集");
    if (new Set(c.engines).size !== c.engines.length)
      throw new Error("入口不能重复");
    for (const name of c.engines) {
      if (!this.engines.find((e) => e.name === name)?.isConfigured())
        throw new Error(`入口未配置：${name}`);
    }
    const result = this.lab.command(requestId, "api-job", c, () => {
      const id = randomUUID();
      this.lab.db
        .prepare(
          "INSERT INTO console_api_job(id,prompt_set_id,config_json,status) VALUES(?,?,?,?)",
        )
        .run(id, c.promptSetId, canonicalJson(c), "queued");
      return { id };
    });
    if (
      !this.active.size &&
      this.rows().find((j) => j.id === result.id)?.status === "queued"
    )
      this.start(result.id);
    return result;
  }
  start(id: string) {
    if (this.active.has(id)) return;
    if (this.active.size)
      throw new Error("已有 API 任务运行；请等待或暂停后再启动");
    const job = this.rows().find((j) => j.id === id);
    if (!job) throw new Error("API 任务不存在");
    if (["complete", "discarded"].includes(job.status)) return;
    this.lab.assertSetActive(job.prompt_set_id);
    if (job.uncertain)
      throw new Error(
        "有调用结果未确认，为避免重复计费，禁止自动续跑。可核对供应商后保留并结束此任务。",
      );
    const selected = job.config.engines
      .map((name) => this.engines.find((e) => e.name === name))
      .filter((e): e is EngineAdapter => !!e);
    if (
      selected.length !== job.config.engines.length ||
      selected.some((e) => !e.isConfigured())
    )
      throw new Error("部分入口未配置，不能静默跳过");
    this.lab.db
      .prepare(
        "UPDATE console_api_job SET status='running',message='' WHERE id=?",
      )
      .run(id);
    const running = { pause: false, promise: Promise.resolve() };
    this.active.set(id, running);
    running.promise = collect(this.lab.db, {
      promptSetId: job.prompt_set_id,
      phase: "baseline",
      engines: selected,
      runsPerPrompt: job.config.runsPerPrompt,
      maxCostUsd: job.config.maxCostUsd,
      concurrency: 1,
      resumeRunId: job.run_id ?? undefined,
      note: "Console durable API job " + id,
      onStarted: (runId) => {
        this.lab.db
          .prepare("UPDATE console_api_job SET run_id=? WHERE id=?")
          .run(runId, id);
      },
      shouldPause: () => running.pause,
      beforeQuery: (j) => {
        this.lab.db
          .prepare("INSERT INTO console_api_dispatch VALUES(?,?,?,?,'sent')")
          .run(id, j.promptId, j.engine, j.runIdx);
      },
      onRecorded: (j) => {
        this.lab.db
          .prepare(
            "UPDATE console_api_dispatch SET status='recorded' WHERE job_id=? AND prompt_id=? AND engine=? AND run_idx=?",
          )
          .run(id, j.promptId, j.engine, j.runIdx);
      },
    })
      .then((result) => {
        this.lab.db
          .prepare("UPDATE console_api_job SET status=?,message=? WHERE id=?")
          .run(
            result.completed === result.total ? "complete" : "paused",
            result.tripped
              ? "达到本轮累计预算，已停止派发"
              : result.skippedEngines.length
                ? "入口连续报错，已暂停"
                : running.pause
                  ? "已暂停，已完成在途调用"
                  : "",
            id,
          );
      })
      .catch((e) => {
        this.lab.db
          .prepare(
            "UPDATE console_api_job SET status='interrupted',message=? WHERE id=?",
          )
          .run(e instanceof Error ? e.message : "任务中断", id);
      })
      .finally(() => {
        this.active.delete(id);
      });
  }
  control(requestId: string, input: unknown) {
    const c = z
      .object({
        id: z.string().uuid(),
        action: z.enum(["pause", "resume", "discard"]),
      })
      .strict()
      .parse(input);
    if (!this.rows().some((j) => j.id === c.id)) throw new Error("任务不存在");
    if (c.action === "resume") {
      this.start(c.id);
      return { ok: true };
    }
    if (c.action === "pause") {
      const r = this.active.get(c.id);
      if (r) r.pause = true;
      return { ok: true };
    }
    if (this.active.has(c.id))
      throw new Error("先暂停并等待在途调用完成，再结束任务");
    return this.lab.command(requestId, "api-discard", c, () => {
      this.lab.db
        .prepare(
          "UPDATE console_api_job SET status='discarded',message='已保留并结束；未确认调用的实际成本需核对供应商' WHERE id=?",
        )
        .run(c.id);
      return { ok: true };
    });
  }
  async pauseAll() {
    for (const value of this.active.values()) value.pause = true;
    await Promise.all([...this.active.values()].map((j) => j.promise));
  }
}
