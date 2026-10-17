import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, closeLedger } from "../src/db/index.ts";
import { addPrompts, createBrand, createPromptSet, freezePromptSet } from "../src/ledger/repo.ts";
import { collect } from "../src/collect.ts";
import type { EngineAdapter, EngineObservation, QueryOptions } from "../src/engines/types.ts";
import { apiSurfaceContext } from "../src/engines/surface-context.ts";

let dir: string;
let db: ReturnType<typeof openLedger>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "geo-collect-"));
  closeLedger();
  db = openLedger(join(dir, "test.db"));
});

afterEach(() => {
  closeLedger();
  rmSync(dir, { recursive: true, force: true });
});

function seedFrozenSet(promptCount: number): string {
  const brandId = createBrand(db, { name: "Acme", ownedDomains: ["acme.example"] });
  const setId = createPromptSet(db, { brandId, label: "breaker-test" });
  addPrompts(
    db,
    setId,
    Array.from({ length: promptCount }, (_, i) => ({ text: `prompt ${i + 1}` })),
  );
  freezePromptSet(db, setId);
  return setId;
}

/** 假引擎：每次调用固定花费 costUsd，记录调用次数。 */
function fakeEngine(
  name: string,
  costUsd?: number,
  config: Readonly<Record<string, string | number | boolean | null>> = { model: "test-v1" },
): EngineAdapter & { calls: number } {
  const adapter = {
    name,
    calls: 0,
    getRunConfig: () => config,
    isConfigured: () => true,
    async query(_options: QueryOptions): Promise<EngineObservation> {
      adapter.calls += 1;
      return {
        engine: name,
        provenance: `test:${name}`,
        fidelity: "web_grounded",
        answerText: "answer",
        citations: [{ url: "https://example.com/a" }],
        raw: null,
        costUsd,
      };
    },
  };
  return adapter;
}

describe("成本断路器", () => {
  it("累计成本达到预算即停止派发，已完成的观测入账", async () => {
    const setId = seedFrozenSet(10);
    const engine = fakeEngine("fake_costly", 1); // 每次 $1

    const result = await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [engine],
      runsPerPrompt: 1,
      concurrency: 1,
      maxCostUsd: 3,
    });

    expect(result.tripped).toBe(true);
    expect(result.completed).toBe(3);
    expect(result.spentUsd).toBe(3);

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM observation WHERE run_id = ?`)
      .get(result.runId) as { n: number };
    expect(count.n).toBe(3);

    const cost = db
      .prepare(`SELECT SUM(cost_usd) AS total FROM observation WHERE run_id = ?`)
      .get(result.runId) as { total: number };
    expect(cost.total).toBe(3);
  });

  it("不报告成本的引擎按兜底估算计入", async () => {
    const setId = seedFrozenSet(4);
    const engine = fakeEngine("fake_free", undefined); // 不报告成本
    process.env.COLLECT_COST_FALLBACK_USD = "2";

    try {
      const result = await collect(db, {
        promptSetId: setId,
        phase: "baseline",
        engines: [engine],
        runsPerPrompt: 1,
        concurrency: 1,
        maxCostUsd: 4,
      });

      expect(result.tripped).toBe(true);
      expect(result.completed).toBe(2); // 2 × $2 = $4 触顶
    } finally {
      delete process.env.COLLECT_COST_FALLBACK_USD;
    }
  });

  it("引擎连续报错触发熔断，跳过该引擎剩余任务，健康引擎不受影响", async () => {
    const setId = seedFrozenSet(10);
    const healthy = fakeEngine("fake_healthy", 0.001);
    const broken: EngineAdapter & { calls: number } = {
      name: "fake_broken",
      calls: 0,
      isConfigured: () => true,
      async query(): Promise<EngineObservation> {
        broken.calls += 1;
        return {
          engine: "fake_broken",
          provenance: "test:fake_broken",
          fidelity: "error",
          answerText: "",
          citations: [],
          raw: null,
          errorMessage: "HTTP 429: quota exceeded",
        };
      },
    };
    process.env.COLLECT_ENGINE_ERROR_TRIP = "3";

    try {
      const result = await collect(db, {
        promptSetId: setId,
        phase: "baseline",
        engines: [broken, healthy],
        runsPerPrompt: 1,
        concurrency: 1,
        maxCostUsd: 100,
      });

      expect(result.skippedEngines).toEqual(["fake_broken"]);
      expect(broken.calls).toBe(3); // 3 次连续报错后熔断
      expect(healthy.calls).toBe(10); // 健康引擎跑满
      expect(result.completed).toBe(13);
    } finally {
      delete process.env.COLLECT_ENGINE_ERROR_TRIP;
    }
  });

  it("续跑跳过已入账的观测，只补缺口", async () => {
    const setId = seedFrozenSet(5);
    const first = fakeEngine("fake_resume", 1);

    // 第一次：$3 预算，跑 3 条后断路
    const partial = await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [first],
      runsPerPrompt: 1,
      concurrency: 1,
      maxCostUsd: 3,
    });
    expect(partial.completed).toBe(3);
    const partialState = db
      .prepare(`SELECT finished_at FROM collection_run WHERE id = ?`)
      .get(partial.runId) as { finished_at: string | null };
    expect(partialState.finished_at).toBeNull();

    // 续跑同一个 run：只补剩下的 2 条
    const second = fakeEngine("fake_resume", 1);
    const resumed = await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [second],
      runsPerPrompt: 1,
      concurrency: 1,
      maxCostUsd: 100,
      resumeRunId: partial.runId,
    });

    expect(resumed.runId).toBe(partial.runId);
    expect(resumed.alreadyDone).toBe(3);
    expect(resumed.completed).toBe(2);
    expect(second.calls).toBe(2); // 已有的没有重复调用

    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM observation WHERE run_id = ?`)
      .get(partial.runId) as { n: number };
    expect(total.n).toBe(5);
    const finalState = db
      .prepare(`SELECT finished_at FROM collection_run WHERE id = ?`)
      .get(partial.runId) as { finished_at: string | null };
    expect(finalState.finished_at).not.toBeNull();
  });

  it("已封存 run 在任何请求前拒绝 resume", async () => {
    const setId = seedFrozenSet(2);
    const firstEngine = fakeEngine("fake_sealed", 0.01);
    const complete = await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [firstEngine],
      runsPerPrompt: 1,
      maxCostUsd: 10,
    });
    const retryEngine = fakeEngine("fake_sealed", 0.01);
    await expect(
      collect(db, {
        promptSetId: setId,
        phase: "baseline",
        engines: [retryEngine],
        runsPerPrompt: 1,
        maxCostUsd: 10,
        resumeRunId: complete.runId,
      }),
    ).rejects.toThrow(/已封存/);
    expect(retryEngine.calls).toBe(0);
  });

  it("模型或端点变化即使采样次数相同，也在请求前拒绝 resume", async () => {
    const setId = seedFrozenSet(3);
    const partial = await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [fakeEngine("fake_model", 1, { model: "v1", endpoint: "test://one" })],
      runsPerPrompt: 1,
      concurrency: 1,
      maxCostUsd: 1,
    });
    const changed = fakeEngine("fake_model", 1, { model: "v2", endpoint: "test://one" });
    await expect(
      collect(db, {
        promptSetId: setId,
        phase: "baseline",
        engines: [changed],
        runsPerPrompt: 1,
        concurrency: 1,
        maxCostUsd: 10,
        resumeRunId: partial.runId,
      }),
    ).rejects.toThrow(/实验配置不一致/);
    expect(changed.calls).toBe(0);
  });

  it("分引擎采样次数：各引擎按各自的 N 派发", async () => {
    const setId = seedFrozenSet(4);
    const many = fakeEngine("fake_many", 0.001);
    const few = fakeEngine("fake_few", 0.001);

    const result = await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [many, few],
      runsPerPrompt: 5,
      runsByEngine: { fake_few: 2 },
      concurrency: 2,
      maxCostUsd: 100,
    });

    expect(many.calls).toBe(20); // 4 prompts × 默认 5
    expect(few.calls).toBe(8); //  4 prompts × 覆盖为 2
    expect(result.completed).toBe(28);
  });

  it("轮次记录里存有效 N 和完整采样配置（不能记成 0）", async () => {
    const setId = seedFrozenSet(3);
    const engine = fakeEngine("fake_cfg", 0.002);

    const result = await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [engine],
      runsPerPrompt: 0, // default=0
      runsByEngine: { fake_cfg: 3 }, // 但该引擎跑 3 次
      concurrency: 1,
      maxCostUsd: 100,
    });

    const row = db
      .prepare(`SELECT runs_per_prompt, runs_config, spent_usd FROM collection_run WHERE id = ?`)
      .get(result.runId) as {
      runs_per_prompt: number;
      runs_config: string;
      spent_usd: number;
    };

    expect(row.runs_per_prompt).toBe(3); // 有效 N，不是 default 的 0
    expect(row.runs_config).toContain("fake_cfg=3");
    expect(row.runs_config).toContain("default=0");
    expect(row.spent_usd).toBeCloseTo(0.018, 5); // 3 prompt × 3 次 × $0.002，成本已入库
  });

  it("续跑时花费累加而不是覆盖", async () => {
    const setId = seedFrozenSet(4);
    const first = await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [fakeEngine("fake_acc", 1)],
      runsPerPrompt: 1,
      concurrency: 1,
      maxCostUsd: 2,
    });
    expect(first.completed).toBe(2);

    await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [fakeEngine("fake_acc", 1)],
      runsPerPrompt: 1,
      concurrency: 1,
      maxCostUsd: 100,
      resumeRunId: first.runId,
    });

    const row = db
      .prepare(`SELECT spent_usd FROM collection_run WHERE id = ?`)
      .get(first.runId) as { spent_usd: number };
    expect(row.spent_usd).toBeCloseTo(4, 5); // 2 + 2，不是只有第二次的 2
  });

  it("预算充足时完整跑完，tripped 为 false", async () => {
    const setId = seedFrozenSet(3);
    const engine = fakeEngine("fake_cheap", 0.001);

    const result = await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [engine],
      runsPerPrompt: 2,
      concurrency: 2,
      maxCostUsd: 10,
    });

    expect(result.tripped).toBe(false);
    expect(result.completed).toBe(6);
    expect(engine.calls).toBe(6);
  });

  it("新 API 采集在入账时保存产品表面、地域状态和响应证据 hash", async () => {
    const setId = seedFrozenSet(1);
    const engine = fakeEngine("fake_surface", 0.001);
    engine.getSurfaceContext = (locale?: string) =>
      apiSurfaceContext({
        provider: "Test Provider",
        productSurface: "Test API + search",
        locale,
        countryApplied: true,
      });

    const result = await collect(db, {
      promptSetId: setId,
      phase: "baseline",
      engines: [engine],
      runsPerPrompt: 1,
      concurrency: 1,
      maxCostUsd: 1,
    });
    const row = db
      .prepare(
        `SELECT product_surface, target_country, geo_verification, location_status,
                evidence_sha256
           FROM observation_surface_context s
           JOIN observation o ON o.id = s.observation_id
          WHERE o.run_id = ?`,
      )
      .get(result.runId) as {
      product_surface: string;
      target_country: string;
      geo_verification: string;
      location_status: string;
      evidence_sha256: string;
    };

    expect(row).toMatchObject({
      product_surface: "Test API + search",
      target_country: "US",
      geo_verification: "provider_asserted",
      location_status: "matched",
    });
    expect(row.evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
