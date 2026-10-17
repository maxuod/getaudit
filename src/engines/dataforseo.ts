import type { EngineAdapter, EngineObservation, QueryOptions, RawCitation } from "./types.ts";
import { errorObservation } from "./types.ts";
import { withOneRetry } from "./retry.ts";
import { apiSurfaceContext } from "./surface-context.ts";

/**
 * DataForSEO AI Optimization API —— 覆盖 ChatGPT / Gemini / Claude。
 *
 * ⚠️ 上线前必须验证的一件事：
 * llm_responses 端点返回的到底是「联网检索后的响应」还是「纯模型响应」。
 * 本适配器用 web_search=true 请求联网，并在响应里找不到任何实时来源时
 * 把 fidelity 标记为 weights_only —— 这类观测不得进入因果报告。
 *
 * 响应字段结构以官方文档为准；这里的解析刻意写得宽容（深度遍历找 URL），
 * 因为不同引擎端点的嵌套形状不完全一致。raw 永远整条入库，
 * 所以即使解析逻辑日后修正，历史观测也能重新解析。
 */

const DEFAULT_BASE = "https://api.dataforseo.com/v3";

export type DataForSeoEngine = "chat_gpt" | "gemini" | "claude" | "perplexity";

interface DataForSeoTaskResponse {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: Array<{ web_search?: boolean } & Record<string, unknown>>;
  }>;
}

/**
 * Gemini 表面的引用是 vertexaisearch 跳转链，真实域名只在 title/domain 字段里。
 * 归属分析按 URL 域名匹配，不还原的话这些引用全会归到 google 名下。
 * title 形如裸域名时用它合成 URL，跳转链保留在 snippet 备查（与直连适配器同一策略）。
 */
const REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const BARE_DOMAIN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

/** 深度遍历响应，收集所有 http(s) URL 及其邻近的标题/片段。 */
function harvestCitations(node: unknown, sink: Map<string, RawCitation>, depth = 0): void {
  if (depth > 12 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) harvestCitations(item, sink, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  const url = record["url"] ?? record["link"] ?? record["source_url"];

  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    const title = record["title"] ?? record["source_title"] ?? record["name"] ?? record["domain"];
    const snippet = record["snippet"] ?? record["text"] ?? record["description"];

    let finalUrl = url;
    let finalSnippet = typeof snippet === "string" ? snippet.slice(0, 500) : undefined;
    try {
      if (
        new URL(url).hostname.endsWith(REDIRECT_HOST) &&
        typeof title === "string" &&
        BARE_DOMAIN.test(title.trim())
      ) {
        finalUrl = `https://${title.trim()}/`;
        finalSnippet = url; // 跳转链存 snippet，日后可回查真实落地页
      }
    } catch {
      // URL 解析失败就按原样入库
    }

    if (!sink.has(finalUrl)) {
      sink.set(finalUrl, {
        url: finalUrl,
        title: typeof title === "string" ? title : undefined,
        snippet: finalSnippet,
      });
    }
  }

  for (const value of Object.values(record)) {
    harvestCitations(value, sink, depth + 1);
  }
}

/** 收集响应中的正文片段，拼成完整回答。 */
function harvestText(node: unknown, parts: string[], depth = 0): void {
  if (depth > 12 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) harvestText(item, parts, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  const type = record["type"];
  const text = record["text"] ?? record["content"] ?? record["message"];

  if (typeof text === "string" && text.trim() && (type === undefined || type === "text" || type === "message")) {
    parts.push(text.trim());
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "text" || key === "content") continue;
    harvestText(value, parts, depth + 1);
  }
}

export class DataForSeoAdapter implements EngineAdapter {
  readonly name: string;
  // 不用 TS 参数属性语法：Node 的 --experimental-strip-types 只做类型擦除，
  // 不支持任何需要代码生成的语法。保持源码可直接被 node 运行。
  private readonly engine: DataForSeoEngine;

  constructor(engine: DataForSeoEngine) {
    this.engine = engine;
    this.name = `dataforseo_${engine}`;
  }

  getRunConfig(): Readonly<Record<string, string | number | boolean | null>> {
    const base = process.env.DATAFORSEO_BASE_URL ?? DEFAULT_BASE;
    return {
      endpoint: `${base}/ai_optimization/${this.engine}/llm_responses/live`,
      surface: this.engine,
      model: this.modelName() ?? null,
      web_search_requested: true,
    };
  }

  getSurfaceContext(locale?: string) {
    const names: Record<DataForSeoEngine, string> = {
      chat_gpt: "ChatGPT",
      gemini: "Gemini",
      claude: "Claude",
      perplexity: "Perplexity",
    };
    return apiSurfaceContext({
      provider: "DataForSEO",
      productSurface: `DataForSEO LLM Responses proxy (${names[this.engine]})`,
      locale,
      countryApplied: false,
      collectionMode: "managed_scraper",
    });
  }

  isConfigured(): boolean {
    return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
  }

  private modelName(): string | undefined {
    if (this.engine === "chat_gpt") return process.env.DATAFORSEO_CHATGPT_MODEL;
    if (this.engine === "gemini") return process.env.DATAFORSEO_GEMINI_MODEL;
    if (this.engine === "claude") return process.env.DATAFORSEO_CLAUDE_MODEL;
    return undefined;
  }

  async query({ prompt, signal }: QueryOptions): Promise<EngineObservation> {
    const base = process.env.DATAFORSEO_BASE_URL ?? DEFAULT_BASE;
    const endpoint = `${base}/ai_optimization/${this.engine}/llm_responses/live`;
    const model = this.modelName();
    const provenance = `dataforseo:${this.engine}:llm_responses/live${model ? `:${model}` : ""}`;
    const timeoutMs = Number.parseInt(process.env.DATAFORSEO_TIMEOUT_MS ?? "120000", 10);

    const auth = Buffer.from(
      `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
    ).toString("base64");

    const task: Record<string, unknown> = {
      user_prompt: prompt,
      // 要求联网检索。若上游忽略该参数，下面的 fidelity 判定会兜住。
      web_search: true,
    };
    if (model) task["model_name"] = model;

    try {
      // 40101/5xx 是上游抽风，重试一次；40501 等配置错不重试
      return await withOneRetry(async () => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([task]),
          signal: signal ?? AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`DataForSEO HTTP ${response.status}: ${detail.slice(0, 300)}`);
        }

        const payload = (await response.json()) as DataForSeoTaskResponse;

        const taskResult = payload.tasks?.[0];
        if (!taskResult || (taskResult.status_code ?? 0) >= 40000) {
          throw new Error(
            `DataForSEO task error ${taskResult?.status_code}: ${taskResult?.status_message ?? "unknown"}`,
          );
        }

        const sink = new Map<string, RawCitation>();
        harvestCitations(taskResult.result, sink);
        const citations = [...sink.values()];

        const parts: string[] = [];
        harvestText(taskResult.result, parts);

        const requireGrounded = process.env.REQUIRE_WEB_GROUNDED !== "false";
        const grounded = citations.length > 0;

        // 上游明确报告了检索状态 —— 用它，不要靠 citations 反推。
        // 「搜了但没引用」和「没搜」是两件事，混淆会让主指标失真。
        const webSearch = taskResult.result?.find((r) => typeof r.web_search === "boolean")
          ?.web_search;

        return {
          engine: this.name,
          provenance,
          fidelity: grounded ? "web_grounded" : requireGrounded ? "weights_only" : "web_grounded",
          modelVersion: model,
          answerText: parts.join("\n\n"),
          citations,
          raw: payload,
          costUsd: taskResult.cost ?? payload.cost,
          interpretation: {
            retrievalUsed: webSearch,
            extractionStatus: grounded ? "extracted" : "no_extraction",
          },
        };
      });
    } catch (error) {
      return errorObservation(this.name, provenance, error);
    }
  }
}
