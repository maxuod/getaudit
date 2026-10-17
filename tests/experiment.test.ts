import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, closeLedger } from "../src/db/index.ts";
import {
  addPrompts,
  createBrand,
  createPromptSet,
  freezePromptSet,
  listPrompts,
  startRun,
  recordObservation,
  getBrand,
  finishRun,
  PARSER_VERSION,
} from "../src/ledger/repo.ts";
import {
  stratifiedAssign,
  persistAssignments,
  readBaselines,
  type PromptBaseline,
} from "../src/experiment/assign.ts";
import {
  computeContentHash,
  registerPrereg,
  recordIntervention,
  recordClientChange,
} from "../src/experiment/prereg.ts";
import {
  wilsonInterval,
  buildDidReport,
  fisherRandomizationInference,
  type PromptDelta,
} from "../src/analysis/did.ts";
import {
  createExperimentManifest,
  recordManifestAnchor,
  type ManifestPlan,
} from "../src/experiment/manifest.ts";
import { canonicalJson, sha256 } from "../src/lib/canonical-json.ts";
import { simulatePromptLevelPower } from "../src/analysis/power.ts";
import { inspectExperimentReadiness } from "../src/experiment/readiness.ts";

let dir: string;
let db: ReturnType<typeof openLedger>;

/** Keep chronology tests valid after their original fixture date has passed. */
function utcDate(offsetDays = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "geo-exp-"));
  closeLedger();
  db = openLedger(join(dir, "test.db"));
});

afterEach(() => {
  closeLedger();
  rmSync(dir, { recursive: true, force: true });
});

function makeBaselines(rates: number[]): PromptBaseline[] {
  return rates.map((rate, index) => ({
    promptId: `p${index}`,
    text: `prompt ${index}`,
    usable: 10,
    ownedHits: Math.round(rate * 10),
    rate,
  }));
}

function configuredRun(
  setId: string,
  phase: "baseline" | "followup",
  runsPerPrompt = 10,
): string {
  const configJson = canonicalJson({
    schema_version: "run-config-v1",
    prompt_set_id: setId,
    prompt_set_hash: (db.prepare(`SELECT frozen_hash FROM prompt_set WHERE id = ?`).get(setId) as {
      frozen_hash: string;
    }).frozen_hash,
    phase,
    prompt_locales: ["en-US"],
    sampling: { default: runsPerPrompt, by_engine: {} },
    engines: [{ name: "test", config: { endpoint: "test://fixed", model: "test-v1" } }],
  });
  return startRun(db, {
    promptSetId: setId,
    phase,
    runsPerPrompt,
    runsConfig: String(runsPerPrompt),
    configJson,
    configHash: sha256(configJson),
  });
}

function fillConfiguredRun(
  setId: string,
  runId: string,
  runsPerPrompt = 1,
  ownedHitsPerPrompt = 0,
): void {
  const brandId = (
    db.prepare(`SELECT brand_id FROM prompt_set WHERE id = ?`).get(setId) as { brand_id: string }
  ).brand_id;
  const brand = getBrand(db, brandId);
  for (const prompt of listPrompts(db, setId)) {
    for (let runIdx = 1; runIdx <= runsPerPrompt; runIdx += 1) {
      recordObservation(db, {
        runId,
        promptId: prompt.id,
        runIdx,
        brand,
        observation: {
          engine: "test",
          provenance: "test",
          fidelity: runIdx <= ownedHitsPerPrompt ? "web_grounded" : "weights_only",
          answerText: "x",
          citations: runIdx <= ownedHitsPerPrompt ? [{ url: "https://acme.example/evidence" }] : [],
          raw: null,
        },
      });
    }
  }
}

function completeConfiguredRun(
  setId: string,
  phase: "baseline" | "followup",
  runsPerPrompt = 1,
  ownedHitsPerPrompt = 0,
): string {
  const runId = configuredRun(setId, phase, runsPerPrompt);
  fillConfiguredRun(setId, runId, runsPerPrompt, ownedHitsPerPrompt);
  finishRun(db, runId, 0);
  return runId;
}

function manifestPlan(setId: string, baselineRunIds: string[]): ManifestPlan {
  return {
    promptSetId: setId,
    parserVersion: PARSER_VERSION,
    baselineRunIds,
    hypothesis: "结构化改写提高全部成功调用中的自有引用率",
    primaryMetric: {
      id: "owned_citation_rate_all_success",
      numerator: "successful responses with an owned citation",
      denominator: "all successful calls",
    },
    secondaryMetrics: [],
    plannedFollowupRounds: 1,
    stopRule: "collect exactly one sealed follow-up round",
    exclusionRules: ["failed calls are disclosed and excluded only from the success denominator"],
    interventionPlan: "publish assigned treatment assets only",
    powerAnalysis: {
      effect: 0.2,
      promptDeltaSd: 0.2,
      alpha: 0.05,
      targetPower: 0.8,
      simulations: 500,
      recommendedPromptsPerArm: 8,
      seed: "power-test-seed",
    },
    randomizationIterations: 5000,
  };
}

function anchorAndPreregister(setId: string, baselineRunIds: string[]): string {
  const manifest = createExperimentManifest(db, manifestPlan(setId, baselineRunIds));
  recordManifestAnchor(db, {
    manifestHash: manifest.contentHash,
    type: "email",
    reference: "message-id:test@example.invalid",
    anchoredAt: "2026-08-10T12:00:00Z",
  });
  registerPrereg(db, { promptSetId: setId, manifestHash: manifest.contentHash });
  return manifest.contentHash;
}

describe("分层随机分组", () => {
  it("同样的种子产生同样的分组（可复现，客户能自行验算）", () => {
    const baselines = makeBaselines([0.1, 0.15, 0.2, 0.3, 0.35, 0.45, 0.5, 0.6]);
    const a = stratifiedAssign(baselines, "seed-abc");
    const b = stratifiedAssign(baselines, "seed-abc");
    expect(a.assignments).toEqual(b.assignments);
  });

  it("种子确实驱动随机性（多种子会产生多种分组）", () => {
    // 注意：小样本下两个特定种子撞出同一分组是正常的
    //（每层 2~3 个元素，交替分配后可能结果很少）。
    // 有意义的检验是「多个种子会产生多于一种分组」。
    const baselines = makeBaselines([
      0.1, 0.12, 0.15, 0.18, 0.2, 0.22, 0.28, 0.3, 0.33, 0.36, 0.45, 0.5, 0.55, 0.6,
    ]);
    const signatures = new Set(
      Array.from({ length: 10 }, (_, i) =>
        stratifiedAssign(baselines, `seed-${i}`)
          .assignments.map((row) => `${row.promptId}:${row.arm}`)
          .sort()
          .join("|"),
      ),
    );
    expect(signatures.size).toBeGreaterThan(3);
  });

  it("每层内两组数量差不超过 1（防止分层失衡）", () => {
    const baselines = makeBaselines([
      0.1, 0.12, 0.15, 0.18, 0.2, 0.22, 0.28, 0.3, 0.33, 0.36, 0.45, 0.5, 0.55, 0.6,
    ]);
    const result = stratifiedAssign(baselines, "balance-test");
    for (const row of result.strataSummary) {
      expect(Math.abs(row.treatment - row.control)).toBeLessThanOrEqual(1);
    }
  });

  it("零命中进入独立分层，接近满格的 prompt 仍被排除", () => {
    const baselines = makeBaselines([0, 0.3, 0.9]);
    const result = stratifiedAssign(baselines, "exclude-test");
    const excludedTexts = result.excluded.map((e) => e.text);
    expect(result.assignments.find((row) => row.text === "prompt 0")?.stratum).toBe("zero");
    expect(excludedTexts).toContain("prompt 2"); // 90%
    expect(result.assignments).toHaveLength(2);
  });

  it("全零 baseline 仍能做可复现且平衡的随机分组", () => {
    const result = stratifiedAssign(makeBaselines(Array.from({ length: 21 }, () => 0)), "zero-seed");
    const treatment = result.assignments.filter((row) => row.arm === "treatment");
    const control = result.assignments.filter((row) => row.arm === "control");
    expect(result.assignments).toHaveLength(21);
    expect(result.excluded).toHaveLength(0);
    expect(result.strataSummary).toEqual([
      { stratum: "zero", treatment: treatment.length, control: control.length },
    ]);
    expect(Math.abs(treatment.length - control.length)).toBeLessThanOrEqual(1);
  });

  it("可用观测不足的被排除", () => {
    const baselines: PromptBaseline[] = [
      { promptId: "a", text: "few", usable: 2, ownedHits: 1, rate: 0.5 },
      { promptId: "b", text: "enough", usable: 10, ownedHits: 3, rate: 0.3 },
    ];
    const result = stratifiedAssign(baselines, "min-usable");
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]?.text).toBe("enough");
    expect(result.excluded.some((e) => e.text === "few")).toBe(true);
  });

  it("两组基线均值在多个种子上平均无偏（分层的意义所在）", () => {
    // 单个 seed 的均值差是随机波动，不该断言。
    // 有意义的是：跨多个 seed 平均后，两组均值的差应该收敛到 0。
    const rates = Array.from({ length: 30 }, (_, i) => 0.08 + i * 0.02);
    const baselines = makeBaselines(rates);

    let sumDiff = 0;
    const seeds = 40;
    for (let i = 0; i < seeds; i += 1) {
      const result = stratifiedAssign(baselines, `mean-test-${i}`);
      const mean = (arm: string): number => {
        const group = result.assignments.filter((a) => a.arm === arm);
        return group.reduce((s, r) => s + r.rate, 0) / group.length;
      };
      sumDiff += mean("treatment") - mean("control");
    }
    expect(Math.abs(sumDiff / seeds)).toBeLessThan(0.02);
  });

  it("奇数层不再固定偏向干预组（P0-4）", () => {
    // 每层 3 个 → 交替分配后必然是 2:1，关键是多出的那个不能总进 treatment
    const baselines = makeBaselines([
      0.1, 0.15, 0.2, // low 层 3 个
      0.28, 0.32, 0.36, // mid 层 3 个
      0.45, 0.5, 0.55, // high 层 3 个
    ]);

    let treatmentHeavy = 0;
    const seeds = 60;
    for (let i = 0; i < seeds; i += 1) {
      const result = stratifiedAssign(baselines, `odd-${i}`);
      const t = result.assignments.filter((a) => a.arm === "treatment").length;
      const c = result.assignments.filter((a) => a.arm === "control").length;
      if (t > c) treatmentHeavy += 1;
    }
    // 旧算法这里会是 60/60。新算法应接近一半。
    expect(treatmentHeavy).toBeGreaterThan(seeds * 0.25);
    expect(treatmentHeavy).toBeLessThan(seeds * 0.75);
  });
});

describe("分组持久化", () => {
  function seedSet(): string {
    const brandId = createBrand(db, { name: "Acme", ownedDomains: ["acme.example"] });
    const setId = createPromptSet(db, { brandId, label: "exp" });
    addPrompts(
      db,
      setId,
      Array.from({ length: 6 }, (_, i) => ({ text: `q${i}` })),
    );
    freezePromptSet(db, setId);
    return setId;
  }

  it("分组写入后不可重做", () => {
    const setId = seedSet();
    const prompts = listPrompts(db, setId);
    const baselines: PromptBaseline[] = prompts.map((p, i) => ({
      promptId: p.id,
      text: p.text,
      usable: 10,
      ownedHits: 2 + i,
      rate: (2 + i) / 10,
    }));
    const result = stratifiedAssign(baselines, "persist-test");
    persistAssignments(db, setId, result);

    expect(() => persistAssignments(db, setId, result)).toThrow(/不可重做|已有/);
  });

  it("分组记录不可修改、不可删除（触发器）", () => {
    const setId = seedSet();
    const prompts = listPrompts(db, setId);
    const baselines: PromptBaseline[] = prompts.map((p, i) => ({
      promptId: p.id,
      text: p.text,
      usable: 10,
      ownedHits: 2 + i,
      rate: (2 + i) / 10,
    }));
    persistAssignments(db, setId, stratifiedAssign(baselines, "immutable"));

    expect(() => db.exec(`UPDATE assignment SET arm = 'control'`)).toThrow();
    expect(() => db.exec(`DELETE FROM assignment`)).toThrow();
  });
});

describe("预注册", () => {
  const input = {
    promptSetId: "set-1",
    manifestHash: "abc123",
  };

  it("方案指纹是确定性的", () => {
    expect(computeContentHash(input)).toBe(computeContentHash(input));
  });

  it("更换 manifest 会改变预注册指纹", () => {
    expect(computeContentHash({ ...input, manifestHash: "different" })).not.toBe(
      computeContentHash(input),
    );
  });

  it("没有分组时拒绝预注册", () => {
    const brandId = createBrand(db, { name: "Acme", ownedDomains: ["acme.example"] });
    const setId = createPromptSet(db, { brandId, label: "no-assign" });
    addPrompts(db, setId, [{ text: "q1" }]);
    freezePromptSet(db, setId);

    expect(() =>
      registerPrereg(db, { ...input, promptSetId: setId }),
    ).toThrow(/先完成分组/);
  });
});

describe("干预登记", () => {
  it("拒绝把干预指向对照组的 prompt", () => {
    const brandId = createBrand(db, { name: "Acme", ownedDomains: ["acme.example"] });
    const setId = createPromptSet(db, { brandId, label: "guard" });
    addPrompts(
      db,
      setId,
      Array.from({ length: 6 }, (_, i) => ({ text: `q${i}` })),
    );
    freezePromptSet(db, setId);

    const prompts = listPrompts(db, setId);
    const baselines: PromptBaseline[] = prompts.map((p, i) => ({
      promptId: p.id,
      text: p.text,
      usable: 10,
      ownedHits: 2 + i,
      rate: (2 + i) / 10,
    }));
    const result = stratifiedAssign(baselines, "guard-seed");
    persistAssignments(db, setId, result);

    const controlId = result.assignments.find((a) => a.arm === "control")?.promptId;
    expect(controlId).toBeDefined();

    expect(() =>
      recordIntervention(db, {
        promptSetId: setId,
        assetType: "comparison_page",
        publishedAt: utcDate(),
        targetPromptIds: [controlId as string],
      }),
    ).toThrow(/对照组/);
  });
});

describe("Wilson 置信区间", () => {
  it("零命中时下界为 0，不会出现负数", () => {
    const [low, high] = wilsonInterval(0, 20);
    expect(low).toBe(0);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(0.2);
  });

  it("满命中时上界为 1", () => {
    const [low, high] = wilsonInterval(20, 20);
    expect(high).toBe(1);
    expect(low).toBeGreaterThan(0.8);
  });

  it("样本越大区间越窄", () => {
    const [lowSmall, highSmall] = wilsonInterval(5, 10);
    const [lowBig, highBig] = wilsonInterval(500, 1000);
    expect(highBig - lowBig).toBeLessThan(highSmall - lowSmall);
  });

  it("零样本返回 [0,0]", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });
});

describe("prompt 级 Fisher 随机化推断", () => {
  const rows = (count: number): PromptDelta[] =>
    Array.from({ length: count }, (_, index) => ({
      promptId: `p${index}`,
      text: `q${index}`,
      arm: index % 2 === 0 ? "treatment" : "control",
      stratum: index < count / 2 ? "low" : "high",
      preRate: 0.2,
      postRate: index % 2 === 0 ? 0.5 : 0.3,
      delta: index % 2 === 0 ? 0.3 : 0.1,
      preUsable: 10,
      postUsable: 10,
    }));

  it("每组少于 8 条时不输出 p 值", () => {
    const result = fisherRandomizationInference(rows(12), { seed: "small", iterations: 2000 });
    expect(result.testable).toBe(false);
    expect(result.pValue).toBeNull();
    expect(result.reason).toMatch(/至少需要 8/);
  });

  it("确定性 Monte Carlo 同 seed 得到同一 p 值", () => {
    const input = { seed: "reproducible", iterations: 3000, exactLimit: 1 };
    const first = fisherRandomizationInference(rows(20), input);
    const second = fisherRandomizationInference(rows(20), input);
    expect(first.exact).toBe(false);
    expect(first.pValue).toBe(second.pValue);
    expect(first.assignmentsEvaluated).toBe(3000);
  });

  it("Monte Carlo 功效模拟可复现并给出样本量结果", () => {
    const input = {
      effect: 0.4,
      promptDeltaSd: 0.1,
      minPromptsPerArm: 8,
      maxPromptsPerArm: 8,
      simulations: 100,
      randomizationIterations: 500,
      seed: "power-reproducible",
    };
    const first = simulatePromptLevelPower(input);
    const second = simulatePromptLevelPower(input);
    expect(first.points).toEqual(second.points);
    expect(first.recommendedPromptsPerArm).toBe(8);
  });
});

describe("manifest 与外部锚定", () => {
  function seedForManifest(): { setId: string; baselineRuns: string[]; treatmentId: string } {
    const brandId = createBrand(db, { name: "Acme", ownedDomains: ["acme.example"] });
    const setId = createPromptSet(db, { brandId, label: "manifest" });
    addPrompts(db, setId, Array.from({ length: 20 }, (_, index) => ({ text: `q${index}` })));
    freezePromptSet(db, setId);
    const baselineRuns = [
      completeConfiguredRun(setId, "baseline", 5, 1),
      completeConfiguredRun(setId, "baseline", 5, 1),
    ];
    const result = stratifiedAssign(
      readBaselines(db, setId, { parserVersion: PARSER_VERSION, runIds: baselineRuns }),
      "manifest-seed",
    );
    persistAssignments(db, setId, result);
    return {
      setId,
      baselineRuns,
      treatmentId: result.assignments.find((row) => row.arm === "treatment")!.promptId,
    };
  }

  it("manifest 缺必填字段时拒绝创建", () => {
    const { setId, baselineRuns } = seedForManifest();
    expect(() =>
      createExperimentManifest(db, {
        ...manifestPlan(setId, baselineRuns),
        stopRule: "",
      }),
    ).toThrow(/stopRule/);
  });

  it("manifest 拒绝单轮 baseline", () => {
    const { setId, baselineRuns } = seedForManifest();
    expect(() =>
      createExperimentManifest(db, manifestPlan(setId, [baselineRuns[0]!])),
    ).toThrow(/至少要绑定两个 baseline/);
  });

  it("canonical run 观测矩阵不完整时不能封存", () => {
    const brandId = createBrand(db, { name: "Incomplete", ownedDomains: ["incomplete.test"] });
    const setId = createPromptSet(db, { brandId, label: "incomplete" });
    addPrompts(db, setId, [{ text: "q1" }, { text: "q2" }]);
    freezePromptSet(db, setId);
    const runId = configuredRun(setId, "baseline", 1);
    expect(() => finishRun(db, runId, 0)).toThrow(/观测不完整/);
  });

  it("只有 GitHub commit 锚点时仍拒绝预注册", () => {
    const { setId, baselineRuns } = seedForManifest();
    const manifest = createExperimentManifest(db, manifestPlan(setId, baselineRuns));
    recordManifestAnchor(db, {
      manifestHash: manifest.contentHash,
      type: "github_commit",
      reference: "https://github.com/sample/geo-proof-lab/commit/test",
      anchoredAt: "2026-08-10T12:00:00Z",
    });
    expect(() =>
      registerPrereg(db, { promptSetId: setId, manifestHash: manifest.contentHash }),
    ).toThrow(/强外部锚点/);
  });

  it("遗留库已有 intervention 时不能事后补预注册", () => {
    const { setId, baselineRuns, treatmentId } = seedForManifest();
    const manifest = createExperimentManifest(db, manifestPlan(setId, baselineRuns));
    recordManifestAnchor(db, {
      manifestHash: manifest.contentHash,
      type: "email",
      reference: "message-id:legacy@example.invalid",
      anchoredAt: "2026-08-10T12:00:00Z",
    });
    // 模拟升级前已经存在的污染状态；新库本身会由 intervention_requires_prereg 拦住。
    db.exec(`DROP TRIGGER intervention_requires_prereg`);
    db.prepare(
      `INSERT INTO intervention
         (id, prompt_set_id, asset_type, published_at, target_prompt_ids)
       VALUES ('legacy-intervention', ?, 'blog', '2026-08-09', ?)`,
    ).run(setId, JSON.stringify([treatmentId]));
    expect(() =>
      registerPrereg(db, { promptSetId: setId, manifestHash: manifest.contentHash }),
    ).toThrow(/事后补预注册/);
  });

  it("readiness 从 baseline 到预注册再到可分析逐级解锁", () => {
    const { setId, baselineRuns, treatmentId } = seedForManifest();
    const beforeManifest = inspectExperimentReadiness(db, {
      promptSetId: setId,
      parserVersion: PARSER_VERSION,
    });
    expect(beforeManifest.stages).toEqual({
      baseline: true,
      intervention: false,
      analysis: false,
    });

    const manifest = createExperimentManifest(db, manifestPlan(setId, baselineRuns));
    recordManifestAnchor(db, {
      manifestHash: manifest.contentHash,
      type: "opentimestamps",
      reference: "test-proof.ots",
      anchoredAt: "2026-08-10T12:00:00Z",
    });
    registerPrereg(db, { promptSetId: setId, manifestHash: manifest.contentHash });
    const beforeIntervention = inspectExperimentReadiness(db, {
      promptSetId: setId,
      parserVersion: PARSER_VERSION,
    });
    expect(beforeIntervention.stages.intervention).toBe(true);
    expect(beforeIntervention.stages.analysis).toBe(false);

    recordIntervention(db, {
      promptSetId: setId,
      assetType: "test_asset",
      publishedAt: utcDate(),
      targetPromptIds: [treatmentId],
    });
    completeConfiguredRun(setId, "followup", 5, 2);
    const complete = inspectExperimentReadiness(db, {
      promptSetId: setId,
      parserVersion: PARSER_VERSION,
    });
    expect(complete.stages.analysis).toBe(true);
  });
});

describe("DiD 计算", () => {
  it("效应 = 干预组变化 − 对照组变化", () => {
    // 构造：干预组 20%→50%（+30pp），对照组 20%→30%（+10pp），DiD 应为 +20pp
    const brandId = createBrand(db, { name: "Acme", ownedDomains: ["acme.example"] });
    const setId = createPromptSet(db, { brandId, label: "did" });
    addPrompts(
      db,
      setId,
      Array.from({ length: 16 }, (_, i) => ({ text: `q${i}` })),
    );
    freezePromptSet(db, setId);
    const brand = getBrand(db, brandId);
    const prompts = listPrompts(db, setId);

    const emit = (runId: string, promptId: string, hits: number, total: number): void => {
      for (let i = 1; i <= total; i += 1) {
        recordObservation(db, {
          runId,
          promptId,
          runIdx: i,
          brand,
          observation: {
            engine: "test",
            provenance: "test",
            fidelity: "web_grounded",
            answerText: "x",
            citations: i <= hits ? [{ url: "https://acme.example/a" }] : [],
            raw: null,
          },
        });
      }
    };

    const preRun = configuredRun(setId, "baseline");
    const preRun2 = configuredRun(setId, "baseline");

    for (const prompt of prompts) {
      emit(preRun, prompt.id, 2, 10); // 两组基线都是 20%
      emit(preRun2, prompt.id, 2, 10);
    }
    finishRun(db, preRun, 0);
    finishRun(db, preRun2, 0);
    // 全部基线率相同 → 都落进同一层，按真实两轮 baseline 重算分组
    const assign = stratifiedAssign(
      readBaselines(db, setId, {
        parserVersion: PARSER_VERSION,
        runIds: [preRun, preRun2],
      }),
      "did-seed",
    );
    persistAssignments(db, setId, assign);
    const armOf = new Map(assign.assignments.map((a) => [a.promptId, a.arm]));
    anchorAndPreregister(setId, [preRun, preRun2]);
    recordIntervention(db, {
      promptSetId: setId,
      assetType: "test_asset",
      publishedAt: utcDate(),
      targetPromptIds: assign.assignments
        .filter((row) => row.arm === "treatment")
        .map((row) => row.promptId),
    });
    const postRun = configuredRun(setId, "followup");
    for (const prompt of prompts) {
      const arm = armOf.get(prompt.id);
      if (!arm) continue;
      emit(postRun, prompt.id, arm === "treatment" ? 5 : 3, 10); // 干预 50%，对照 30%
    }
    finishRun(db, postRun, 0);

    const report = buildDidReport(db, setId, {
      parserVersion: PARSER_VERSION,
      preRuns: [preRun, preRun2],
      postRuns: [postRun],
    });

    expect(report.treatment.preRate).toBeCloseTo(0.2, 5);
    expect(report.treatment.postRate).toBeCloseTo(0.5, 5);
    expect(report.control.preRate).toBeCloseTo(0.2, 5);
    expect(report.control.postRate).toBeCloseTo(0.3, 5);
    expect(report.did).toBeCloseTo(0.2, 5);
    expect(report.claimStatus).toBe("experimental");
    expect(() =>
      buildDidReport(db, setId, {
        parserVersion: PARSER_VERSION,
        preRuns: [preRun],
        postRuns: [postRun],
      }),
    ).toThrow(/preRuns 与预注册 manifest/);
  });

  it("没有分组时拒绝出 DiD 报告", () => {
    const brandId = createBrand(db, { name: "Acme", ownedDomains: ["acme.example"] });
    const setId = createPromptSet(db, { brandId, label: "no-assign-did" });
    addPrompts(db, setId, [{ text: "q1" }]);
    freezePromptSet(db, setId);

    expect(() =>
      buildDidReport(db, setId, {
        parserVersion: PARSER_VERSION,
        preRuns: ["a"],
        postRuns: ["b"],
      }),
    ).toThrow(/没有分组/);
  });
});

describe("实验完整性约束（P0-5/P0-6）", () => {
  function seedAssigned(): { setId: string; treatmentId: string } {
    const brandId = createBrand(db, { name: "Acme", ownedDomains: ["acme.example"] });
    const setId = createPromptSet(db, { brandId, label: "guard" });
    addPrompts(
      db,
      setId,
      Array.from({ length: 18 }, (_, i) => ({ text: `q${i}` })),
    );
    freezePromptSet(db, setId);
    const baselineRuns = [
      completeConfiguredRun(setId, "baseline", 5, 1),
      completeConfiguredRun(setId, "baseline", 5, 1),
    ];
    const result = stratifiedAssign(
      readBaselines(db, setId, { parserVersion: PARSER_VERSION, runIds: baselineRuns }),
      "guard-seed",
    );
    persistAssignments(db, setId, result);
    anchorAndPreregister(setId, baselineRuns);
    const t = result.assignments.find((a) => a.arm === "treatment");
    return { setId, treatmentId: t!.promptId };
  }

  it("干预记录不可修改、不可删除", () => {
    const { setId, treatmentId } = seedAssigned();
    recordIntervention(db, {
      promptSetId: setId,
      assetType: "comparison_page",
      publishedAt: utcDate(),
      targetPromptIds: [treatmentId],
    });
    expect(() => db.exec(`UPDATE intervention SET asset_type = 'x'`)).toThrow();
    expect(() => db.exec(`DELETE FROM intervention`)).toThrow();
  });

  it("干预必须有目标 —— 空目标无法归因", () => {
    const { setId } = seedAssigned();
    expect(() =>
      recordIntervention(db, {
        promptSetId: setId,
        assetType: "blog",
        publishedAt: utcDate(),
        targetPromptIds: [],
      }),
    ).toThrow(/必须指定目标/);
  });

  it("没有干预登记时不能开始 follow-up", () => {
    const { setId } = seedAssigned();
    expect(() => configuredRun(setId, "followup", 1)).toThrow(/登记干预/);
  });

  it("干预日期不能早于预注册", () => {
    const { setId, treatmentId } = seedAssigned();
    expect(() =>
      recordIntervention(db, {
        promptSetId: setId,
        assetType: "blog",
        publishedAt: utcDate(-1),
        targetPromptIds: [treatmentId],
      }),
    ).toThrow(/不能早于预注册/);
  });

  it("已有 follow-up 后不能补写第二项干预", () => {
    const { setId, treatmentId } = seedAssigned();
    recordIntervention(db, {
      promptSetId: setId,
      assetType: "blog",
      publishedAt: utcDate(),
      targetPromptIds: [treatmentId],
    });
    configuredRun(setId, "followup", 1);
    expect(() =>
      recordIntervention(db, {
        promptSetId: setId,
        assetType: "late_change",
        publishedAt: utcDate(),
        targetPromptIds: [treatmentId],
      }),
    ).toThrow(/不能事后补写干预/);
  });

  it("follow-up 不能早于已登记干预的发布日期", () => {
    const { setId, treatmentId } = seedAssigned();
    recordIntervention(db, {
      promptSetId: setId,
      assetType: "scheduled_asset",
      publishedAt: utcDate(1),
      targetPromptIds: [treatmentId],
    });
    expect(() => configuredRun(setId, "followup", 1)).toThrow(/不能早于.*发布日期/);
  });

  it("客户变更登记不可修改、不可删除", () => {
    const { setId } = seedAssigned();
    recordClientChange(db, {
      promptSetId: setId,
      occurredAt: "2026-08-11",
      kind: "unknown",
      description: "客户发了新闻稿",
    });
    expect(() => db.exec(`UPDATE client_change SET description = 'x'`)).toThrow();
    expect(() => db.exec(`DELETE FROM client_change`)).toThrow();
  });

  it("轮次的实验条件不可修改", () => {
    const { setId } = seedAssigned();
    const runId = startRun(db, {
      promptSetId: setId,
      phase: "baseline",
      runsPerPrompt: 10,
    });
    expect(() =>
      db.prepare(`UPDATE collection_run SET phase = 'followup' WHERE id = ?`).run(runId),
    ).toThrow(/不可修改/);
    expect(() =>
      db.prepare(`UPDATE collection_run SET runs_per_prompt = 3 WHERE id = ?`).run(runId),
    ).toThrow(/不可修改/);
  });

  it("观测解释不可修改、不可删除（parser 改进请写新版本）", () => {
    const { setId } = seedAssigned();
    const brand = getBrand(db, (db.prepare(`SELECT brand_id FROM prompt_set WHERE id = ?`).get(setId) as { brand_id: string }).brand_id);
    const runId = startRun(db, { promptSetId: setId, phase: "baseline", runsPerPrompt: 1 });
    const [prompt] = listPrompts(db, setId);
    recordObservation(db, {
      runId,
      promptId: prompt!.id,
      runIdx: 1,
      brand,
      observation: {
        engine: "test",
        provenance: "test",
        fidelity: "web_grounded",
        answerText: "x",
        citations: [{ url: "https://acme.example/a" }],
        raw: null,
        interpretation: { retrievalUsed: true, extractionStatus: "extracted" },
      },
    });
    expect(() =>
      db.exec(`UPDATE observation_interpretation SET extraction_status = 'no_extraction'`),
    ).toThrow(/不可修改/);
    expect(() => db.exec(`DELETE FROM observation_interpretation`)).toThrow(/不可删除/);
  });
});
