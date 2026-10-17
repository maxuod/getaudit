import { resolveCountry } from "../lib/locale.ts";
import type { ObservationSurfaceDescriptor } from "./types.ts";

interface ApiSurfaceInput {
  provider: string;
  productSurface: string;
  locale?: string;
  /** 只有请求中真的把国家传给供应商时才可设 true。 */
  countryApplied?: boolean;
  collectionMode?: "api" | "managed_scraper";
}

/** 为 API/模型代理表面生成保守上下文；未传给供应商的 locale 只算 target。 */
export function apiSurfaceContext(input: ApiSurfaceInput): ObservationSurfaceDescriptor {
  const country = resolveCountry(input.locale);
  return {
    surfaceClass: "api_model",
    provider: input.provider,
    productSurface: input.productSurface,
    collectionMode: input.collectionMode ?? "api",
    accountState: "unknown",
    personalizationState: "unknown",
    searchMode: "natural",
    targetCountry: country ?? "XX",
    geoVerification: country && input.countryApplied ? "provider_asserted" : "unverified",
    locationStatus: country && input.countryApplied ? "matched" : "unverified",
    browserLocale: input.locale ?? "not-recorded",
    timezoneId: "not-applicable",
    geolocationPolicy: "unavailable",
    device: "unknown",
  };
}

/** DataForSEO Google AIO 表面；只有明确的 location code/country 映射才算供应商声明。 */
export function dataForSeoAioSurfaceContext(locale?: string): ObservationSurfaceDescriptor {
  const locationCode = Number.parseInt(process.env.DATAFORSEO_SERP_LOCATION_CODE ?? "2124", 10);
  const explicitCountry = process.env.DATAFORSEO_SERP_TARGET_COUNTRY?.trim().toUpperCase();
  const providerCountry =
    explicitCountry && /^[A-Z]{2}$/.test(explicitCountry)
      ? explicitCountry
      : locationCode === 2124
        ? "CA"
        : undefined;
  const requestedCountry = resolveCountry(locale);
  const targetCountry = requestedCountry ?? providerCountry ?? "XX";
  const language = process.env.DATAFORSEO_SERP_LANGUAGE_CODE ?? "en";
  return {
    surfaceClass: "serp_feature",
    provider: "DataForSEO",
    productSurface: "Google AI Overviews via DataForSEO SERP API",
    collectionMode: "managed_scraper",
    accountState: "logged_out",
    personalizationState: "disabled",
    searchMode: "explicit_search",
    targetCountry,
    exitCountry: providerCountry,
    geoVerification: providerCountry ? "provider_asserted" : "unverified",
    locationStatus: providerCountry
      ? requestedCountry && requestedCountry !== providerCountry
        ? "mismatched"
        : "matched"
      : "unverified",
    browserLocale: providerCountry ? `${language}-${providerCountry}` : locale ?? language,
    timezoneId: "provider-managed",
    geolocationPolicy: "unavailable",
    device: "desktop",
  };
}
