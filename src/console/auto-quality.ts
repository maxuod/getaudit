import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import { captureSchema, conditionIssues, surfaces } from "./contracts.ts";
import type { CaptureRecord, PlanConfig, SourceRule } from "./contracts.ts";
import { normalizeSourceUrl } from './sources.ts';

/** This checks capture mechanics and sampling conditions, never answer truth. */
export const AUTO_QUALITY_VERSION = "capture-quality-v2";
export type QualityContext = {
  config: PlanConfig;
  configHash: string;
  frozenHash: string | null;
  prompt: string;
  slotId: string;
  surface: keyof typeof surfaces;
  window: string;
  integrityIssues: string[];
};
export type AutoQuality = {
  evaluatorVersion: string;
  assessmentHash: string;
  status: "passed" | "condition_mismatch" | "excluded" | "terminal";
  label: string;
  contentQualified: boolean;
  metricEligible: boolean;
  contentIssues: string[];
  conditionIssues: string[];
  reasons: string[];
  manualDecision: "accept" | "reject" | null;
  effectiveDecision: "auto_accept" | "manual_accept" | "manual_reject" | "excluded" | "terminal";
  retryable: boolean;
};

function sourceMatches(surface: keyof typeof surfaces, source?: string) {
  if (!source) return false;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    // Exact provider hosts prevent a different chatbot or impersonating domain
    // from satisfying this platform's capture provenance. Google/Bing paths
    // additionally distinguish their supported answer surface from other pages.
    const rules: readonly SourceRule[] = surfaces[surface].sourceRules;
    return rules.some(rule => rule.hosts.includes(url.hostname) &&
      (rule.paths === null || rule.paths.some(path => url.pathname === path ||
        (rule.allowSubpaths && url.pathname.startsWith(path + "/")))));
  } catch { return false; }
}

/** Pure, versioned evaluation. Reads do not write review rows or observations. */
export function assessCapture(input: {
  capture: CaptureRecord;
  captureHash: string;
  integrity: boolean;
  context: QualityContext;
  manualDecision?: string | null;
}): AutoQuality {
  const c = input.capture, context = input.context;
  const manualDecision = input.manualDecision === "accept" || input.manualDecision === "reject" ? input.manualDecision : null;
  const contentIssues = [...context.integrityIssues];
  if (!input.integrity) contentIssues.push("采集记录或原始证据完整性检查失败");
  const { artifactHash, ...record } = c;
  // Revalidate the persisted shape without reading or exposing artifact bytes.
  let shapeValid = false;
  try { shapeValid = captureSchema.safeParse({ ...record, artifact: artifactHash ? { mime: "text/plain", base64: "eA==" } : null }).success; }
  catch { /* URL/time refinements may throw on structurally corrupt old data. */ }
  if (!shapeValid) {
    contentIssues.push("保存的采集记录格式无效");
    if (manualDecision === "reject") contentIssues.push("可选人工检查已拒绝此记录");
    const result: Omit<AutoQuality, "assessmentHash"> = {
      evaluatorVersion: AUTO_QUALITY_VERSION, status: "excluded", label: "保存的采集记录格式无效", contentQualified: false, metricEligible: false,
      contentIssues: [...new Set(contentIssues)], conditionIssues: [], reasons: [...new Set(contentIssues)], manualDecision,
      effectiveDecision: manualDecision === "reject" ? "manual_reject" : "excluded", retryable: manualDecision !== "accept",
    };
    return { ...result, assessmentHash: sha256(canonicalJson({ captureHash: input.captureHash, configHash: context.configHash, frozenHash: context.frozenHash, slotId: context.slotId, result })) };
  }
  if (c.slotId !== context.slotId || c.prompt !== context.prompt) contentIssues.push("采集问题或位置与冻结计划不符");
  if (manualDecision === "reject") contentIssues.push("可选人工检查已拒绝此记录");
  if (c.collectionMode === "fixture") contentIssues.push("合成演示数据不能作为网页观测结果");
  if (c.status === "observed") {
    if (!c.answer.trim()) contentIssues.push("答案正文为空");
    if (!artifactHash) contentIssues.push("缺少原始证据");
    if (c.collectionMode === "browser_capture") {
      if (!c.browser?.answerComplete) contentIssues.push("自动提取的正文完整性未确认");
      if (!c.browser?.citationsComplete) contentIssues.push("自动提取的引用完整性未确认");
      if (!c.browser?.extractorVersion?.trim()) contentIssues.push("缺少正文与来源提取器版本");
      if (!sourceMatches(context.surface, c.sourceUrl)) contentIssues.push("未记录匹配采样入口的来源页面");
    } else if (c.collectionMode === "manual_capture" && manualDecision !== "accept") {
      // A pasted answer or a single URL cannot establish that its source range
      // is complete. Existing manual acceptance remains explicitly manual.
      if (!c.browser?.answerComplete || !c.browser?.citationsComplete)
        contentIssues.push("手动导入记录缺少正文与引用完整性元数据");
      if (!sourceMatches(context.surface, c.sourceUrl) || !c.browser?.extractorVersion?.trim())
        contentIssues.push("手动导入记录缺少匹配入口与提取器来源");
    }
    if ((c.browser?.unresolvedCitations ?? 0) > 0) contentIssues.push("仍有未解析引用");
    if ((c.browser?.citationOverflow ?? 0) > 0) contentIssues.push("引用数量超出提取上限");
    if (c.browser?.citationControls !== undefined &&
        (c.browser.citationControlsOpened ?? 0) < c.browser.citationControls)
      contentIssues.push("来源面板未全部读取");
    if (c.citations.some(link => !normalizeSourceUrl(link.url))) contentIssues.push("存在无法安全识别的引用网址");
  } else contentIssues.push(`没有完整答案：${c.status}${c.reason ? " · " + c.reason : ""}`);

  const conditions = conditionIssues(context.config, c, context.surface);
  if (c.sourceUrl && !sourceMatches(context.surface, c.sourceUrl)) conditions.push("采集来源页面与计划入口不符");
  if (c.searchMode !== surfaces[context.surface].mode) conditions.push("搜索模式与计划不符");
  if (c.status !== "cancelled") {
    try {
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: context.config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(c.observedAt));
      if (date !== context.window) conditions.push("观测时间不在计划窗口内");
    } catch { conditions.push("观测日期无法核验"); }
  }
  const distinctContent = [...new Set(contentIssues)], distinctConditions = [...new Set(conditions)];
  const contentQualified = c.status === "observed" && distinctContent.length === 0;
  const metricEligible = contentQualified && distinctConditions.length === 0;
  const mechanicallyValidTerminal = c.status !== "observed" && distinctContent.length === 1 && distinctContent[0]!.startsWith("没有完整答案：");
  const status = metricEligible ? "passed" : contentQualified ? "condition_mismatch" : mechanicallyValidTerminal ? "terminal" : "excluded";
  const effectiveDecision = manualDecision === "reject" ? "manual_reject" : contentQualified ? manualDecision === "accept" ? "manual_accept" : "auto_accept" : status === "terminal" ? "terminal" : "excluded";
  const label = status === "passed" ? "自动质检通过" : status === "condition_mismatch" ? "正文完整，采样条件未匹配" : status === "terminal" ? "结束状态已记录" : "自动质检已排除";
  const result: Omit<AutoQuality, "assessmentHash"> = {
    evaluatorVersion: AUTO_QUALITY_VERSION, status, label: manualDecision === "reject" ? "人工已拒绝" : manualDecision === "accept" ? `人工已接受 · ${label}` : label,
    contentQualified, metricEligible, contentIssues: distinctContent, conditionIssues: distinctConditions,
    reasons: [...new Set([...distinctContent, ...distinctConditions])], manualDecision, effectiveDecision,
    retryable: manualDecision === "reject" || ["error", "unavailable", "cancelled"].includes(c.status) || (manualDecision !== "accept" && c.status === "observed" && !contentQualified),
  };
  return { ...result, assessmentHash: sha256(canonicalJson({ captureHash: input.captureHash, configHash: context.configHash, frozenHash: context.frozenHash, slotId: context.slotId, surface: context.surface, window: context.window, promptHash: sha256(context.prompt), result })) };
}
