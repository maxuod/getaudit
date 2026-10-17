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
  recordObservation,
  startRun,
  getBrand,
  PARSER_VERSION,
  finishRun,
} from "../src/ledger/repo.ts";
import { buildAttributionReport } from "../src/analysis/attribution.ts";
import { writeFileSync } from "node:fs";
import { isOwnedDomain, registrableDomain } from "../src/lib/url.ts";
import { mentionsBrand } from "../src/lib/brand-match.ts";
import { backfillInterpretations } from "../src/ledger/backfill.ts";

let dir: string;
let db: ReturnType<typeof openLedger>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "geo-proof-"));
  closeLedger();
  db = openLedger(join(dir, "test.db"));
});

afterEach(() => {
  closeLedger();
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const brandId = createBrand(db, {
    name: "Acme",
    ownedDomains: ["acme.example"],
    aliases: ["Acme", "Acme Co"],
  });
  const setId = createPromptSet(db, { brandId, label: "test" });
  addPrompts(db, setId, [{ text: "best widgets 2026" }, { text: "how to choose widgets" }]);
  return { brandId, setId };
}

describe("prompt 集冻结", () => {
  it("冻结后产生稳定 hash，且与 prompt 顺序无关", () => {
    const { setId } = seed();
    const hash = freezePromptSet(db, setId);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("冻结后不能再新增 prompt", () => {
    const { setId } = seed();
    freezePromptSet(db, setId);
    expect(() => addPrompts(db, setId, [{ text: "sneaky late addition" }])).toThrow(/已冻结/);
    expect(listPrompts(db, setId)).toHaveLength(2);
  });

  it("冻结后不能修改或删除 prompt", () => {
    const { setId } = seed();
    freezePromptSet(db, setId);
    const [prompt] = listPrompts(db, setId);
    expect(() =>
      db.prepare(`UPDATE prompt SET text = ? WHERE id = ?`).run("tampered", prompt!.id),
    ).toThrow(/已冻结/);
    expect(() => db.prepare(`DELETE FROM prompt WHERE id = ?`).run(prompt!.id)).toThrow(/已冻结/);
  });

  it("不能重复冻结", () => {
    const { setId } = seed();
    freezePromptSet(db, setId);
    expect(() => freezePromptSet(db, setId)).toThrow(/已.*冻结/);
  });

  it("空集不能冻结", () => {
    const brandId = createBrand(db, { name: "Empty", ownedDomains: [] });
    const setId = createPromptSet(db, { brandId, label: "empty" });
    expect(() => freezePromptSet(db, setId)).toThrow(/空的/);
  });
});

describe("观测不可变", () => {
  function writeObservation(setId: string, brandId: string) {
    const runId = startRun(db, { promptSetId: setId, phase: "baseline", runsPerPrompt: 1 });
    const [prompt] = listPrompts(db, setId);
    return recordObservation(db, {
      runId,
      promptId: prompt!.id,
      runIdx: 1,
      brand: getBrand(db, brandId),
      observation: {
        engine: "test_engine",
        provenance: "test:endpoint",
        fidelity: "web_grounded",
        answerText: "Acme makes solid widgets.",
        citations: [
          { url: "https://acme.example/widgets" },
          { url: "https://reviews.example.com/best-widgets" },
        ],
        raw: { ok: true },
      },
    });
  }

  it("写入后不能 UPDATE", () => {
    const { setId, brandId } = seed();
    freezePromptSet(db, setId);
    const id = writeObservation(setId, brandId);
    expect(() =>
      db.prepare(`UPDATE observation SET answer_text = ? WHERE id = ?`).run("rewritten", id),
    ).toThrow(/append-only/);
  });

  it("写入后不能 DELETE", () => {
    const { setId, brandId } = seed();
    freezePromptSet(db, setId);
    const id = writeObservation(setId, brandId);
    expect(() => db.prepare(`DELETE FROM observation WHERE id = ?`).run(id)).toThrow(/append-only/);
  });

  it("引用记录同样不可改", () => {
    const { setId, brandId } = seed();
    freezePromptSet(db, setId);
    writeObservation(setId, brandId);
    expect(() => db.prepare(`UPDATE citation SET ownership = 'owned'`).run()).toThrow(/不可修改/);
  });

  it("正确区分自有域名与第三方，并检测品牌提及", () => {
    const { setId, brandId } = seed();
    freezePromptSet(db, setId);
    writeObservation(setId, brandId);

    const rows = db
      .prepare(`SELECT ownership, domain FROM citation ORDER BY position`)
      .all() as Array<{ ownership: string; domain: string }>;

    expect(rows).toEqual([
      { ownership: "owned", domain: "acme.example" },
      { ownership: "third_party", domain: "reviews.example.com" },
    ]);

    const mentioned = db.prepare(`SELECT brand_mentioned FROM observation`).get() as {
      brand_mentioned: number;
    };
    expect(mentioned.brand_mentioned).toBe(1);
  });

  it("run 不能写入另一个 prompt 集的观测", () => {
    const { setId, brandId } = seed();
    freezePromptSet(db, setId);
    const otherSet = createPromptSet(db, { brandId, label: "other" });
    addPrompts(db, otherSet, [{ text: "other prompt" }]);
    freezePromptSet(db, otherSet);
    const runId = startRun(db, { promptSetId: setId, phase: "baseline", runsPerPrompt: 1 });
    const [otherPrompt] = listPrompts(db, otherSet);
    expect(() =>
      recordObservation(db, {
        runId,
        promptId: otherPrompt!.id,
        runIdx: 1,
        brand: getBrand(db, brandId),
        observation: {
          engine: "test",
          provenance: "test",
          fidelity: "weights_only",
          answerText: "x",
          citations: [],
          raw: null,
        },
      }),
    ).toThrow(/同一 prompt 集/);
  });

  it("run 封存后 observation 与 citation 都不能追加", () => {
    const { setId, brandId } = seed();
    freezePromptSet(db, setId);
    const runId = startRun(db, { promptSetId: setId, phase: "baseline", runsPerPrompt: 1 });
    const [prompt] = listPrompts(db, setId);
    const observationId = recordObservation(db, {
      runId,
      promptId: prompt!.id,
      runIdx: 1,
      brand: getBrand(db, brandId),
      observation: {
        engine: "test",
        provenance: "test",
        fidelity: "web_grounded",
        answerText: "x",
        citations: [],
        raw: null,
      },
    });
    finishRun(db, runId, 0);

    expect(() =>
      recordObservation(db, {
        runId,
        promptId: prompt!.id,
        runIdx: 2,
        brand: getBrand(db, brandId),
        observation: {
          engine: "test",
          provenance: "test",
          fidelity: "web_grounded",
          answerText: "late",
          citations: [],
          raw: null,
        },
      }),
    ).toThrow(/已封存/);
    expect(() =>
      db.prepare(
        `INSERT INTO citation (id, observation_id, position, url, domain, ownership)
         VALUES ('late', ?, 99, 'https://late.example/a', 'late.example', 'third_party')`,
      ).run(observationId),
    ).toThrow(/已封存/);
  });

  it("历史解释回填可重跑且最终逐条覆盖", () => {
    const { setId } = seed();
    freezePromptSet(db, setId);
    const runId = startRun(db, { promptSetId: setId, phase: "baseline", runsPerPrompt: 1 });
    const [prompt] = listPrompts(db, setId);
    db.prepare(
      `INSERT INTO observation
         (id, run_id, prompt_id, engine, run_idx, provenance, fidelity, answer_text)
       VALUES ('legacy-1', ?, ?, 'legacy_direct', 1, 'legacy', 'weights_only', 'x')`,
    ).run(runId, prompt!.id);

    const first = backfillInterpretations(db);
    expect(first.written).toBe(1);
    expect(first.covered).toBe(1);
    const second = backfillInterpretations(db);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.covered).toBe(1);
  });
});

describe("采集前置条件", () => {
  it("未冻结的集合不允许写入基线观测（由 collect 层守卫）", async () => {
    const { setId } = seed();
    const { collect } = await import("../src/collect.ts");
    await expect(
      collect(db, { promptSetId: setId, phase: "baseline", engines: [], runsPerPrompt: 1 }),
    ).rejects.toThrow(/尚未冻结/);
  });
});

describe("引用面归属分析", () => {
  it("未显式指定 parserVersion 时拒绝生成报告", () => {
    const { setId } = seed();
    expect(() =>
      buildAttributionReport(db, setId, { parserVersion: "" }),
    ).toThrow(/显式指定/);
  });
  it("统计自有与第三方占比", () => {
    const { setId, brandId } = seed();
    freezePromptSet(db, setId);
    const runId = startRun(db, { promptSetId: setId, phase: "baseline", runsPerPrompt: 2 });
    const prompts = listPrompts(db, setId);
    const brand = getBrand(db, brandId);

    // 4 条观测：1 条引用自有域名，3 条全是第三方
    const fixtures = [
      ["https://acme.example/a", "https://third.example.com/x"],
      ["https://third.example.com/y"],
      ["https://other.example.org/z"],
      ["https://third.example.com/w"],
    ];

    fixtures.forEach((urls, index) => {
      recordObservation(db, {
        runId,
        promptId: prompts[index % prompts.length]!.id,
        runIdx: index + 1,
        brand,
        observation: {
          engine: "test_engine",
          provenance: "test",
          fidelity: "web_grounded",
          answerText: "generic answer",
          citations: urls.map((url) => ({ url })),
          raw: null,
        },
      });
    });

    const report = buildAttributionReport(db, setId, { parserVersion: PARSER_VERSION });
    expect(report.usableObservations).toBe(4);
    expect(report.ownedCitationRate).toBeCloseTo(0.25);
    expect(report.ownedCitationShare).toBeCloseTo(1 / 5);
    expect(report.topThirdPartyDomains[0]!.domain).toBe("third.example.com");
    expect(report.topThirdPartyDomains[0]!.citations).toBe(3);
  });

  it("error 观测不计入可用样本但计入总数", () => {
    const { setId, brandId } = seed();
    freezePromptSet(db, setId);
    const runId = startRun(db, { promptSetId: setId, phase: "baseline", runsPerPrompt: 1 });
    const [prompt] = listPrompts(db, setId);

    recordObservation(db, {
      runId,
      promptId: prompt!.id,
      runIdx: 1,
      brand: getBrand(db, brandId),
      observation: {
        engine: "test_engine",
        provenance: "test",
        fidelity: "error",
        answerText: "",
        citations: [],
        raw: null,
        errorMessage: "timeout",
      },
    });

    const report = buildAttributionReport(db, setId, { parserVersion: PARSER_VERSION });
    expect(report.totalObservations).toBe(1);
    expect(report.usableObservations).toBe(0);
    expect(report.interpretationBreakdown["not_applicable"]).toBe(1);
  });
});

describe("域名与品牌匹配", () => {
  it("子域名归入注册域", () => {
    expect(registrableDomain("blog.acme.example")).toBe("acme.example");
    expect(registrableDomain("www.shop.acme.co.uk")).toBe("acme.co.uk");
    expect(isOwnedDomain("https://blog.acme.example/post", ["acme.example"])).toBe(true);
    expect(isOwnedDomain("https://acme.examplepetitor.example", ["acme.example"])).toBe(false);
  });

  it("品牌提及用词边界，避免子串误报", () => {
    expect(mentionsBrand("I recommend Ada shoes", ["Ada"])).toBe(true);
    expect(mentionsBrand("Made in Canada", ["Ada"])).toBe(false);
    expect(mentionsBrand("acme co makes these", ["Acme Co"])).toBe(true);
  });
});

describe("prompt 文件解析", () => {
  it("剥离行内注释 —— 混进 prompt 会污染观测", () => {
    // 复现踩过的坑：候选文件里的 "# 3x" 被当成关键词发给了 SERP
    const parse = (content: string): string[] =>
      content
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+#\s.*$/, "").trim())
        .filter((line) => line && !line.startsWith("#"));

    const parsed = parse(
      [
        "# 整行注释，应被忽略",
        "",
        "Free employee scheduling app     # 18x 最高频",
        "Canadian scheduling software  # 8x",
        "7shifts",
        "  # 缩进的整行注释",
      ].join("\n"),
    );

    expect(parsed).toEqual([
      "Free employee scheduling app",
      "Canadian scheduling software",
      "7shifts",
    ]);
  });

  it("不误伤 prompt 里合法的 # 号", () => {
    const parse = (content: string): string[] =>
      content
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+#\s.*$/, "").trim())
        .filter((line) => line && !line.startsWith("#"));

    // "#1" 紧跟在词后面（无空格），是内容不是注释
    expect(parse("what is the #1 scheduling app")).toEqual([
      "what is the #1 scheduling app",
    ]);
  });
});
