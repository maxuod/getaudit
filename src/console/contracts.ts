import { z } from "zod";
export type SourceRule = {
  hosts: readonly string[];
  paths: readonly string[] | null;
  allowSubpaths?: boolean;
};
export type SurfaceCapabilities = {
  name: string;
  provider: string;
  url: string;
  mode: "explicit_search" | "natural";
  privateSupported: boolean;
  independentLoginSupported: boolean;
  privacyCheck: "temporary_chat" | "non_personalized_search" | "unsupported";
  sourceRules: readonly SourceRule[];
};
export const surfaces = {
  google_aio: {
    name: "Google AI Overview",
    provider: "Google",
    url: "https://www.google.com/search",
    mode: "explicit_search",
    privateSupported: true,
    independentLoginSupported: true,
    privacyCheck: "non_personalized_search",
    sourceRules: [{
      hosts: ["google.com", "www.google.com", "google.ca", "www.google.ca", "google.co.uk", "www.google.co.uk", "google.com.au", "www.google.com.au"],
      paths: ["/", "/search"],
    }],
  },
  chatgpt_search: {
    name: "ChatGPT Search",
    provider: "OpenAI",
    url: "https://chatgpt.com/",
    mode: "explicit_search",
    privateSupported: true,
    independentLoginSupported: true,
    privacyCheck: "temporary_chat",
    sourceRules: [{ hosts: ["chatgpt.com"], paths: null }],
  },
  gemini: {
    name: "Gemini",
    provider: "Google",
    url: "https://gemini.google.com/",
    mode: "natural",
    privateSupported: false,
    independentLoginSupported: true,
    privacyCheck: "unsupported",
    sourceRules: [{ hosts: ["gemini.google.com"], paths: null }],
  },
  bing_copilot: {
    name: "Microsoft Copilot (Bing)",
    provider: "Microsoft",
    url: "https://copilot.microsoft.com/",
    mode: "natural",
    privateSupported: false,
    independentLoginSupported: true,
    privacyCheck: "unsupported",
    sourceRules: [
      { hosts: ["copilot.microsoft.com", "copilot.com"], paths: null },
      { hosts: ["bing.com", "www.bing.com"], paths: ["/chat", "/copilot"], allowSubpaths: true },
      { hosts: ["m365.cloud.microsoft"], paths: ["/chat"], allowSubpaths: true },
    ],
  },
  perplexity: {
    name: "Perplexity",
    provider: "Perplexity",
    url: "https://www.perplexity.ai/",
    mode: "natural",
    privateSupported: false,
    independentLoginSupported: true,
    privacyCheck: "unsupported",
    sourceRules: [{ hosts: ["perplexity.ai", "www.perplexity.ai"], paths: null }],
  },
  grok: {
    name: "Grok",
    provider: "xAI",
    url: "https://grok.com/",
    mode: "natural",
    privateSupported: false,
    independentLoginSupported: true,
    privacyCheck: "unsupported",
    sourceRules: [{ hosts: ["grok.com"], paths: null }],
  },
  duckduckgo_search_assist: {
    name: "DuckDuckGo Search Assist",
    provider: "DuckDuckGo",
    url: "https://duckduckgo.com/",
    mode: "explicit_search",
    privateSupported: false,
    independentLoginSupported: false,
    privacyCheck: "unsupported",
    sourceRules: [{ hosts: ["duckduckgo.com", "www.duckduckgo.com"], paths: ["/"] }],
  },
} as const satisfies Record<string, SurfaceCapabilities>;
export type SurfaceId = keyof typeof surfaces;
export const surfaceIds = Object.keys(surfaces) as [SurfaceId, ...SurfaceId[]];
export const id = z.string().min(1).max(120);
const country = z.string().regex(/^[A-Z]{2}$/);
const locale = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);
const timezone = z
  .string()
  .max(80)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, "时区无效");
export const surface = z.enum(surfaceIds);
export const accountMode = z.enum(["signed_out", "signed_in_private", "isolated"]);
export const capturePrivacyMode = z.enum(["signed_out", "signed_in_private", "signed_in_independent"]);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) && new Date(v).toISOString().startsWith(v),
    "日期无效",
  );
export const planSchema = z
  .object({
    promptSetId: id,
    label: z.string().trim().min(1).max(160),
    surfaces: z.array(surface).min(1).max(surfaceIds.length),
    accountMode: accountMode.optional(),
    guestPolicy: z.literal("no_login_v1").optional(),
    repetitions: z.number().int().min(1).max(10).optional(),
    egressPolicy: z.enum(["unverified", "canada_fixed", "country_fixed"]).optional(),
    windows: z.array(date).min(1).max(14),
    country,
    locale,
    timezone,
    device: z.enum(["desktop", "mobile", "tablet"]),
  })
  .strict()
  .refine(v => !v.guestPolicy || !v.accountMode || v.accountMode === "signed_out", "Strict guest policy cannot be combined with a signed-in session mode.")
  .refine(v => v.egressPolicy !== "canada_fixed" || v.country === "CA", "固定加拿大出口的计划国家必须为 CA")
  .refine(v => v.accountMode !== "signed_in_private" || v.surfaces.every(s => surfaces[s].privateSupported), "所选入口暂不支持已核验的登录态临时采样；请使用未登录独立会话")
  .refine(v => v.accountMode !== "isolated" || v.surfaces.every(s => surfaces[s].independentLoginSupported), "Guest-only platforms require a strict signed-out plan.")
  .refine(
    (v) =>
      new Set(v.surfaces).size === v.surfaces.length &&
      new Set(v.windows).size === v.windows.length,
    "入口与窗口不可重复",
  );
export type PlanConfig = z.infer<typeof planSchema>;
const citation = z
  .object({
    url: z
      .url()
      .refine(
        (v) => ["https:", "http:"].includes(new URL(v).protocol),
        "引用必须是网页地址",
      ),
    title: z.string().max(500).optional(),
    placement: z.enum(["answer_link", "source_panel"]).optional(),
  })
  .strict();
export const captureSchema = z
  .object({
    slotId: id,
    prompt: z.string().min(1).max(10000),
    status: z.enum([
      "observed",
      "not_triggered",
      "unavailable",
      "error",
      "cancelled",
    ]),
    reason: z.string().trim().max(1500).default(""),
    restriction: z
      .enum(["none", "login", "captcha", "rate_limit", "region"])
      .default("none"),
    observedAt: z.iso.datetime({ offset: true }),
    answer: z.string().max(150000).default(""),
    citations: z.array(citation).max(100).default([]),
    model: z.string().max(120).default("unknown"),
    sourceUrl: z
      .url()
      .refine((v) => new URL(v).protocol === "https:", "来源必须是 HTTPS 地址")
      .optional(),
    sessionRef: z.string().max(100).optional(),
    account: z.enum(["logged_out", "logged_in", "unknown"]),
    session: z.enum(["fresh", "active", "unknown"]),
    privacy: z.object({
      mode: capturePrivacyMode,
      temporaryChat: z.enum(["verified", "not_applicable", "unknown"]),
      personalization: z.enum(["disabled", "enabled", "unknown"]),
      newConversation: z.boolean(),
    }).strict().optional(),
    exitCountry: country.nullable().default(null),
    geo: z.enum(["ip_observed", "unverified"]),
    locale,
    timezone,
    device: z.enum(["desktop", "mobile", "tablet", "unknown"]),
    geolocation: z.enum(["denied", "real", "unknown"]),
    searchMode: z.enum(["natural", "explicit_search", "unknown"]),
    collectionMode: z
      .enum(["manual_capture", "browser_capture", "fixture"])
      .default("manual_capture"),
    browser: z.object({
      name: z.literal("Google Chrome"),
      mode: z.enum(["silent", "visible"]).optional(),
      version: z.string().max(100),
      unresolvedCitations: z.number().int().min(0).optional(),
      citationOverflow: z.number().int().min(0).optional(),
      extractorVersion: z.string().max(60),
      answerComplete: z.boolean(),
      citationsComplete: z.boolean(),
      citationControls: z.number().int().min(0).optional(),
      citationControlsOpened: z.number().int().min(0).optional(),
      egress: z.object({country:z.string().regex(/^[A-Z]{2}$/),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),verifiedAt:z.iso.datetime(),provider:z.literal("cloudflare_trace")}).strict().optional(),
      notes: z.array(z.string().max(500)).max(10),
    }).strict().optional(),
    geoVerificationNote: z.string().max(500).optional(),
    retrievalUsed: z.boolean().nullable().default(null),
    artifact: z
      .object({
        mime: z.enum(["image/png", "image/jpeg", "image/webp", "text/plain"]),
        base64: z.string().max(5600000),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (c.status === "observed" && !c.answer.trim()) fail("完整答案需要正文");
    if (c.status !== "observed" && (c.answer || c.citations.length))
      fail("无完整答案时不能填写正文或引用");
    if (c.status !== "observed" && !c.reason) fail("请记录结束原因");
    if (c.status !== "cancelled" && !c.artifact)
      fail("请附上截图或文本原始证据");
    if (c.status === "unavailable" && c.restriction === "none")
      fail("请说明访问限制");
    if (c.status !== "unavailable" && c.restriction !== "none")
      fail("访问限制只适用于无法访问状态");
    if (c.geo === "ip_observed" && !c.exitCountry)
      fail("已核验出口时必须填写国家");
    if (Date.parse(c.observedAt) > Date.now() + 300000)
      fail("观测时间不能在未来");
  });
export type Capture = z.infer<typeof captureSchema>;
export type CaptureRecord = Omit<Capture, "artifact"> & {
  artifactHash: string | null;
};
export function conditionIssues(p: PlanConfig, c: CaptureRecord, productSurface?: keyof typeof surfaces) {
  const issues: string[] = [];
  if (p.accountMode === "signed_in_private") {
    if (productSurface && !surfaces[productSurface].privateSupported) issues.push("此入口不支持已核验的登录态临时采样");
    if (c.account !== "logged_in" || c.privacy?.mode !== "signed_in_private") issues.push("未确认登录态独立采样条件");
    if (c.privacy?.personalization !== "disabled") issues.push("个性化未确认关闭");
    if (!c.privacy?.newConversation) issues.push("未确认新对话或新搜索页面");
    if ((surfaces[productSurface ?? "chatgpt_search"].privacyCheck !== "non_personalized_search" && c.privacy?.temporaryChat !== "verified") || c.privacy?.temporaryChat === "unknown") issues.push("临时对话未确认");
  } else if (p.accountMode === "isolated") {
    // Isolated observations may use a fresh guest or a prepared logged-in
    // session. Compare the actual account conditions without claiming anonymity.
    if (c.account === "logged_in") {
      if (productSurface && !surfaces[productSurface].independentLoginSupported) issues.push("此入口不支持登录态独立观察");
      if (c.session !== "active" || c.privacy?.mode !== "signed_in_independent") issues.push("未确认独立采样会话");
    } else if (c.account === "logged_out") {
      if (c.session !== "fresh" || c.privacy?.mode !== "signed_out") issues.push("未确认独立采样会话");
    } else issues.push("账号状态未确认");
    if (!c.privacy?.newConversation) issues.push("未确认新对话或新搜索页面");
  } else {
    // New guest plans require explicit privacy proof. Legacy frozen plans keep
    // their original assessment contract and hashes.
    if (p.guestPolicy === "no_login_v1" && (c.privacy?.mode !== "signed_out" || c.privacy?.newConversation !== true))
      issues.push("Strict guest session and fresh conversation were not verified.");
    if (c.account !== "logged_out") issues.push("未确认退出账号");
    if (c.session !== "fresh") issues.push("未确认全新会话");
    if (c.privacy?.mode === "signed_in_private" || c.privacy?.mode === "signed_in_independent") issues.push("登录态样本不能混入未登录基线");
  }
  if (c.geo !== "ip_observed" || c.exitCountry !== p.country)
    issues.push("出口地区未核验或不匹配");
  if((p.egressPolicy === "canada_fixed" || p.egressPolicy === "country_fixed") && (!c.browser?.egress || c.browser.egress.country !== p.country))
    issues.push("缺少目标国家固定出口的逐题核验证据");
  if (
    c.locale !== p.locale ||
    c.timezone !== p.timezone ||
    c.device !== p.device
  )
    issues.push("语言、时区或设备与计划不符");
  if (c.geolocation !== "denied") issues.push("定位权限未确认关闭");
  if (c.collectionMode === "fixture") issues.push("合成演示数据");
  if (c.collectionMode === "browser_capture" && !c.browser?.answerComplete)
    issues.push("自动提取的正文完整性未确认");
  if (c.collectionMode === "browser_capture" && !c.browser?.citationsComplete)
    issues.push("自动提取的引用完整性未确认");
  return issues;
}
