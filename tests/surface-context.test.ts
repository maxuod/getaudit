import { afterEach, describe, expect, it } from "vitest";
import { dataForSeoAioSurfaceContext } from "../src/engines/surface-context.ts";

afterEach(() => {
  delete process.env.DATAFORSEO_SERP_LOCATION_CODE;
  delete process.env.DATAFORSEO_SERP_TARGET_COUNTRY;
  delete process.env.DATAFORSEO_SERP_LANGUAGE_CODE;
});

describe("SERP 表面地域上下文", () => {
  it("默认加拿大 location 与 en-CA prompt 匹配", () => {
    expect(dataForSeoAioSurfaceContext("en-CA")).toMatchObject({
      targetCountry: "CA",
      exitCountry: "CA",
      geoVerification: "provider_asserted",
      locationStatus: "matched",
    });
  });

  it("加拿大 location 与 en-US prompt 冲突时明确标记 mismatched", () => {
    expect(dataForSeoAioSurfaceContext("en-US")).toMatchObject({
      targetCountry: "US",
      exitCountry: "CA",
      geoVerification: "provider_asserted",
      locationStatus: "mismatched",
    });
  });
});
