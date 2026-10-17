/**
 * 引擎适配器契约。
 *
 * 每个适配器必须回答一个问题：这条观测是从哪个表面取到的，
 * 以及它是不是带实时检索的（fidelity）。
 * 这不是元数据洁癖 —— 你只对检索层做 30 天承诺，
 * 用权重层的数据去支撑那个承诺，报告就是假的。
 */

/**
 * ⚠️ fidelity 是历史字段，语义过载（同时表达"是否检索"和"是否有引用"）。
 * 新代码请用 observation_interpretation 表的三个正交字段。
 * 保留它是因为观测不可变，历史行的这个值不能改。
 */
export type Fidelity = "web_grounded" | "weights_only" | "error";

/** 引用提取的结果状态。和"是否检索""表面是否展示"是三件独立的事。 */
export type ExtractionStatus =
  | "extracted" // 提取到了引用
  | "no_extraction" // 上游正常，但这次回答没有可归因的引用
  | "unrecoverable_legacy" // 历史观测，原始响应不足以判断
  | "not_applicable"; // 调用失败等，无从谈起

/**
 * 一次观测的三个正交事实。
 *
 * 分开的理由（踩过的坑）：
 * 原来用 citations.length > 0 同时推断"联网了吗"和"引用了吗"，
 * 于是「Google 没展示 AI Overview」和「展示了但没引用我们」被合并成同一个标签，
 * 又被一起排除出分母 —— 那是条件选择偏差，会让主指标系统性偏高。
 */
export interface Interpretation {
  /** 上游明确报告发生了联网检索。undefined = 上游没说，无法断言 */
  retrievalUsed?: boolean;
  /** 该表面是否出现（AIO 专用：Google 是否展示了 AI Overview 块） */
  surfacePresent?: boolean;
  extractionStatus: ExtractionStatus;
}

export interface RawCitation {
  url: string;
  title?: string;
  snippet?: string;
}

/**
 * 观测发生在哪个产品表面、以什么地域/账号条件取得。
 *
 * 这组字段刻意不包含密码、cookie、完整 IP 或账号邮箱。网页证据只需要
 * 可比较的实验条件，不需要把登录凭证复制进台账。
 */
export interface ObservationSurfaceContext {
  surfaceClass: "api_model" | "consumer_web" | "serp_feature";
  provider: string;
  productSurface: string;
  collectionMode: "api" | "manual_capture" | "managed_scraper" | "browser_automation";
  accountState: "logged_out" | "logged_in" | "unknown";
  personalizationState: "fresh" | "active" | "disabled" | "unknown";
  searchMode: "natural" | "explicit_search" | "forced_search" | "unknown";
  targetCountry: string;
  exitCountry?: string;
  geoVerification: "ip_observed" | "provider_asserted" | "unverified";
  locationStatus: "matched" | "mismatched" | "unverified";
  browserLocale: string;
  timezoneId: string;
  geolocationPolicy: "denied" | "unavailable" | "city_emulated" | "real" | "unknown";
  device: "desktop" | "mobile" | "tablet" | "unknown";
  /** 登录队列的匿名别名，例如 personal-paid-a；禁止使用邮箱。 */
  accountLabel?: string;
  /** 对共享上下文 + 单条捕获内容的 canonical SHA-256。 */
  evidenceSha256: string;
  /** 截图/导出文件的非秘密引用；原始 artifact 仍由用户自行保管。 */
  captureReference?: string;
}

/**
 * 适配器在发起请求前就能声明的产品表面。证据 hash 由 collect 把这份声明和
 * 实际响应一起做 canonical SHA-256 后补入，避免适配器自己漏掉观测身份。
 */
export type ObservationSurfaceDescriptor = Omit<
  ObservationSurfaceContext,
  "evidenceSha256" | "captureReference"
>;

export interface EngineObservation {
  engine: string;
  /** 这条观测怎么取到的：API 名 + 端点，写进台账供日后审计。 */
  provenance: string;
  fidelity: Fidelity;
  modelVersion?: string;
  answerText: string;
  citations: RawCitation[];
  /** 上游返回的完整原文，原样入库。 */
  raw: unknown;
  /**
   * 这次调用的美元成本。DataForSEO 在响应里报告精确值；
   * 直连引擎不报告，留空 —— 断路器会用 COLLECT_COST_FALLBACK_USD 兜底估算。
   */
  costUsd?: number;
  /**
   * 三个正交事实。适配器应尽量填 —— 缺省时 recordObservation 会从
   * fidelity 和 citations 退化推断，那是不得已的降级路径。
   */
  interpretation?: Interpretation;
  errorMessage?: string;
}

export interface QueryOptions {
  prompt: string;
  locale?: string;
  signal?: AbortSignal;
}

export interface EngineAdapter {
  readonly name: string;
  /**
   * 返回会改变观测表面的非秘密配置。不得包含 API key、Authorization 或 cookie。
   * collect 会把它写进 run 的 canonical config，用来阻止换模型/端点/地域续跑。
   */
  getRunConfig?(): Readonly<Record<string, string | number | boolean | null>>;
  /** 新采集必须在入账时固定表面边界；报告不应再靠 engine 名猜。 */
  getSurfaceContext?(locale?: string): ObservationSurfaceDescriptor;
  /** 未配置密钥时返回 false，CLI 会跳过而不是崩溃。 */
  isConfigured(): boolean;
  query(options: QueryOptions): Promise<EngineObservation>;
}

/** 把上游异常统一转成一条 error 观测 —— 失败也要入账，否则样本会被静默偏移。 */
export function errorObservation(
  engine: string,
  provenance: string,
  error: unknown,
): EngineObservation {
  return {
    engine,
    provenance,
    fidelity: "error",
    answerText: "",
    citations: [],
    raw: null,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}
