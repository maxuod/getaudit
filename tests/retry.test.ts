import { describe, expect, it, vi } from "vitest";
import {
  isTransientUpstreamError,
  retryAfterMs,
  withTransientRetry,
} from "../src/engines/retry.ts";

describe("瞬时上游错误重试", () => {
  it("429 会重试并尊重 Retry-After，随后使用指数退避", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Perplexity HTTP 429 retry-after-ms=1500: busy"))
      .mockRejectedValueOnce(new Error("Perplexity HTTP 429 retry-after-ms=500: busy"))
      .mockResolvedValue("ok");
    const delays: number[] = [];

    const result = await withTransientRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1500, 2000]);
  });

  it("配置或鉴权错误不重试", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("Perplexity HTTP 401"));
    await expect(
      withTransientRetry(fn, { maxAttempts: 3, sleep: async () => undefined }),
    ).rejects.toThrow(/401/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("识别 5xx、DataForSEO 40101 和 Retry-After 毫秒", () => {
    expect(isTransientUpstreamError(new Error("HTTP 503"))).toBe(true);
    expect(isTransientUpstreamError(new Error("task error 40101"))).toBe(true);
    expect(retryAfterMs(new Error("HTTP 429 retry-after-ms=4250"))).toBe(4250);
  });
});
