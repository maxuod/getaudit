import { describe, it, expect } from "vitest";
import { classifyIntent, classifyLayer } from "../src/discover.ts";

/**
 * 分类口径是报告的一部分：口径变了，前后轮次的漏斗分布就不可比。
 * 这些测试锁住口径，防止日后无意中改动。
 */

describe("意图分类", () => {
  it("识别对比型", () => {
    expect(classifyIntent("7shifts vs Homebase for a small restaurant")).toBe("comparison");
    expect(classifyIntent("free alternative to 7shifts")).toBe("comparison");
    expect(classifyIntent("Compare top shift scheduling brands")).toBe("comparison");
  });

  it("识别推荐型", () => {
    expect(classifyIntent("best free shift scheduling app in Canada")).toBe("recommendation");
    expect(classifyIntent("Which app is best for shift scheduling?")).toBe("recommendation");
  });

  it("识别操作型", () => {
    expect(classifyIntent("How do I make a weekly employee schedule")).toBe("howto");
    expect(classifyIntent("How to calculate overtime")).toBe("howto");
  });

  it("识别事实型", () => {
    expect(classifyIntent("Does Microsoft have a shift scheduling tool?")).toBe("factual");
    expect(classifyIntent("How many hours counts as full time in Alberta?")).toBe("factual");
  });

  it("其余归为发现型", () => {
    expect(classifyIntent("employee scheduling software canada")).toBe("discovery");
  });
});

describe("漏斗层", () => {
  const aliases = ["Sample Studio", "sampleShift"];

  it("含品牌词 → L3，即使意图是推荐型", () => {
    expect(classifyLayer("Is Sample Studio any good?", aliases)).toBe("L3_brand");
    expect(classifyLayer("best alternative to sampleShift", aliases)).toBe("L3_brand");
  });

  it("选型意图 → L2 主战场", () => {
    expect(classifyLayer("best free scheduling app for restaurants", aliases)).toBe(
      "L2_evaluation",
    );
    expect(classifyLayer("7shifts vs Homebase", aliases)).toBe("L2_evaluation");
  });

  it("操作型 → L4", () => {
    expect(classifyLayer("How do I split tips fairly?", aliases)).toBe("L4_usage");
  });

  it("纯品类词 → L1", () => {
    expect(classifyLayer("employee scheduling software canada", aliases)).toBe("L1_category");
  });

  it("品牌别名匹配不区分大小写", () => {
    expect(classifyLayer("what is sampleshift", aliases)).toBe("L3_brand");
  });
});
