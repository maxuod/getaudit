import type { EngineAdapter, EngineObservation, QueryOptions, RawCitation } from "./types.ts";
import { errorObservation } from "./types.ts";
import { resolveCountry } from "../lib/locale.ts";
import { apiSurfaceContext } from "./surface-context.ts";
import { withTransientRetry } from "./retry.ts";

/**
 * Perplexity Sonar。
 *
 * 这是目前最干净的观测面：Sonar 本身就是检索型模型，
 * 每个响应直接带 citations 数组和 search_results 元数据，
 * 不需要猜「这条回答有没有联网」。
 */

const ENGINE = "perplexity_sonar";

interface SonarSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
}

interface SonarResponse {
  id?: string;
  model?: string;
  citations?: string[];
  search_results?: SonarSearchResult[];
  choices?: Array<{ message?: { content?: string } }>;
}

function extractCitations(payload: SonarResponse): RawCitation[] {
  // search_results 信息更全（带标题和片段），优先用它
  const structured = payload.search_results ?? [];
  if (structured.length) {
    return structured
      .filter((entry): entry is SonarSearchResult & { url: string } => Boolean(entry.url))
      .map((entry) => ({
        url: entry.url,
        title: entry.title,
        snippet: entry.snippet,
      }));
  }

  return (payload.citations ?? [])
    .filter((url) => typeof url === "string" && url.length > 0)
    .map((url) => ({ url }));
}

function responseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.ceil(Number.parseFloat(raw) * 1000));
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export class PerplexityAdapter implements EngineAdapter {
  readonly name = ENGINE;

  getRunConfig(): Readonly<Record<string, string | number | boolean | null>> {
    const baseUrl = process.env.PERPLEXITY_BASE_URL ?? "https://api.perplexity.ai";
    return {
      endpoint: `${baseUrl}/chat/completions`,
      model: process.env.PERPLEXITY_MODEL ?? "sonar",
      location_policy: "prompt_locale_to_country",
    };
  }

  getSurfaceContext(locale?: string) {
    return apiSurfaceContext({
      provider: "Perplexity",
      productSurface: "Perplexity Sonar API",
      locale,
      countryApplied: Boolean(resolveCountry(locale)),
    });
  }

  isConfigured(): boolean {
    return Boolean(process.env.PERPLEXITY_API_KEY);
  }

  async query({ prompt, locale, signal }: QueryOptions): Promise<EngineObservation> {
    const baseUrl = process.env.PERPLEXITY_BASE_URL ?? "https://api.perplexity.ai";
    const model = process.env.PERPLEXITY_MODEL ?? "sonar";
    const timeoutMs = Number.parseInt(process.env.PERPLEXITY_TIMEOUT_MS ?? "45000", 10);
    const endpoint = `${baseUrl}/chat/completions`;
    // 地域钉扎必须写进 provenance：不同地域的观测不属于同一个实验
    const country = resolveCountry(locale);
    const provenance = `perplexity:sonar:${endpoint}:${model}${country ? `:loc=${country}` : ""}`;

    try {
      return await withTransientRetry(
        async () => {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              // 不加任何「请引用来源」之类的引导。
              // 我们要测量的是用户真实提问时的自然行为，
              // 引导模型多给引用会系统性抬高所有观测，破坏可比性。
              messages: [{ role: "user", content: prompt }],
              ...(country ? { web_search_options: { user_location: { country } } } : {}),
            }),
            signal: signal ?? AbortSignal.timeout(timeoutMs),
          });

          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            const retryMs = responseRetryAfterMs(response);
            throw new Error(
              `Perplexity HTTP ${response.status}` +
                (retryMs === undefined ? "" : ` retry-after-ms=${retryMs}`) +
                `: ${detail.slice(0, 300)}`,
            );
          }

          const payload = (await response.json()) as SonarResponse;
          const citations = extractCitations(payload);

          return {
            engine: ENGINE,
            provenance,
            // Sonar 是检索型的；但若某次响应完全没有来源，
            // 不能当作 web_grounded 计入因果分析。
            fidelity: citations.length > 0 ? "web_grounded" : "weights_only",
            modelVersion: payload.model ?? model,
            answerText: payload.choices?.[0]?.message?.content ?? "",
            citations,
            raw: payload,
            interpretation: {
              // 直连 API 不报告是否触发了检索，只能从有无引用降级推断。
              // 「搜了但没引用」在这些引擎上无法与「没搜」区分 —— 报告里要说明这个局限。
              retrievalUsed: citations.length > 0 ? true : undefined,
              extractionStatus: citations.length > 0 ? "extracted" : "no_extraction",
            },
          } satisfies EngineObservation;
        },
        {
          maxAttempts: Number.parseInt(process.env.PERPLEXITY_RETRY_MAX_ATTEMPTS ?? "3", 10),
          baseDelayMs: Number.parseInt(process.env.PERPLEXITY_RETRY_BASE_DELAY_MS ?? "1000", 10),
          maxDelayMs: Number.parseInt(process.env.PERPLEXITY_RETRY_MAX_DELAY_MS ?? "30000", 10),
        },
      );
    } catch (error) {
      return errorObservation(ENGINE, provenance, error);
    }
  }
}
