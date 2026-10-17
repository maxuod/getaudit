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
  PARSER_VERSION,
} from "../src/ledger/repo.ts";
import { buildOpportunity } from "../src/analysis/opportunity.ts";

let dir: string;
let db: ReturnType<typeof openLedger>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "geo-opp-"));
  closeLedger();
  db = openLedger(join(dir, "test.db"));
});

afterEach(() => {
  closeLedger();
  rmSync(dir, { recursive: true, force: true });
});

/** 造一条 prompt，每次观测的引用列表由 fixture 决定 */
function scenario(
  promptText: string,
  citationsPerObs: string[][],
): ReturnType<typeof buildOpportunity> {
  const brandId = createBrand(db, { name: "Acme", ownedDomains: ["acme.example"] });
  const setId = createPromptSet(db, { brandId, label: "opp" });
  addPrompts(db, setId, [{ text: promptText }]);
  freezePromptSet(db, setId);
  const brand = getBrand(db, brandId);
  const [prompt] = listPrompts(db, setId);
  const runId = startRun(db, { promptSetId: setId, phase: "baseline", runsPerPrompt: 10 });

  citationsPerObs.forEach((urls, i) => {
    recordObservation(db, {
      runId,
      promptId: prompt!.id,
      runIdx: i + 1,
      brand,
      observation: {
        engine: "test",
        provenance: "test",
        fidelity: "web_grounded",
        answerText: "x",
        citations: urls.map((url) => ({ url })),
        raw: null,
      },
    });
  });

  return buildOpportunity(db, setId, { parserVersion: PARSER_VERSION, runIds: [runId] });
}

const rep = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

describe("机会评分", () => {
  it("官方来源垄断 → 结构性劣势", () => {
    const rows = scenario(
      "overtime pay ontario",
      rep(10, [
        "https://ontario.ca/a",
        "https://canada.ca/b",
        "https://lawfirm.example/c",
      ]),
    );
    expect(rows[0]?.tier).toBe("structural");
    expect(rows[0]?.institutionalShare).toBeCloseTo(1, 2);
  });

  it("官方占比不超过 100% —— 多个机构域名不重复累加", () => {
    const rows = scenario(
      "stat holiday",
      rep(10, [
        "https://ontario.ca/a",
        "https://alberta.ca/b",
        "https://canada.ca/c",
        "https://novascotia.ca/d",
      ]),
    );
    expect(rows[0]?.institutionalShare).toBeLessThanOrEqual(1);
  });

  it("已稳定命中的查询不判为结构性劣势 —— 实证胜过启发式", () => {
    // 官方来源满屏，但自有域名同样每次都在
    const rows = scenario(
      "tip pooling policy canada",
      rep(10, [
        "https://acme.example/tips",
        "https://ontario.ca/a",
        "https://canada.ca/b",
      ]),
    );
    expect(rows[0]?.ownRate).toBe(1);
    expect(rows[0]?.tier).not.toBe("structural");
    expect(rows[0]?.score).toBeGreaterThanOrEqual(72);
  });

  it("位子多且轮换 → 高分", () => {
    // 每次引用 10 个来源，但只有 2 个固定，其余每次都变
    const obs = Array.from({ length: 10 }, (_, i) => [
      "https://fixed1.example/a",
      "https://fixed2.example/b",
      ...Array.from({ length: 8 }, (_, j) => `https://rotating${i}-${j}.com/x`),
    ]);
    const rows = scenario("free scheduling app", obs);
    expect(rows[0]?.lockedSlots).toBe(2);
    expect(rows[0]?.freeSlots).toBeGreaterThan(5);
    expect(rows[0]?.tier).toBe("easy");
  });

  it("少数域名锁死全部位子 → 低分", () => {
    const rows = scenario(
      "niche query",
      rep(10, ["https://a.example/1", "https://b.example/2", "https://c.example/3"]),
    );
    expect(rows[0]?.lockedSlots).toBe(3);
    expect(rows[0]?.freeSlots).toBeLessThan(1);
    expect(rows[0]?.tier).toBe("hard");
  });

  it("偶尔命中的查询得分高于完全不在场的", () => {
    const base = rep(10, [
      "https://rival1.example/a",
      "https://rival2.example/b",
      "https://rival3.example/c",
      "https://rival4.example/d",
      "https://rival5.example/e",
    ]);
    const absent = scenario("q absent", base);

    closeLedger();
    db = openLedger(join(dir, "test2.db"));
    const partial = scenario(
      "q partial",
      base.map((urls, i) => (i < 3 ? ["https://acme.example/x", ...urls] : urls)),
    );

    expect(partial[0]!.score).toBeGreaterThan(absent[0]!.score);
  });
});
