import type { EngineAdapter, EngineObservation, QueryOptions, RawCitation } from "./types.ts";
import { errorObservation } from "./types.ts";
import { apiSurfaceContext } from "./surface-context.ts";

/**
 * Google Gemini 直连 —— generateContent + google_search grounding。
 *
 * ⚠️ 已知坑：groundingChunks 里的 web.uri 是
 * vertexaisearch.cloud.google.com/grounding-api-redirect/... 跳转链，
 * 真实来源域名只出现在 web.title 里（Google 就是这么返回的）。
 * 台账的归属分析按 URL 域名匹配，直接存跳转链会让所有引用归到 google 名下。
 * 处理：title 形如裸域名时，用它合成 https://{domain}/ 作为引用 URL，
 * 跳转链保留在 snippet 里备查。这保住了域名级归属 —— 台账测的正是这个粒度。
 */

const ENGINE = "google_gemini";

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  groundingMetadata?: { groundingChunks?: GroundingChunk[] };
}

interface GeminiPayload {
  modelVersion?: string;
  candidates?: GeminiCandidate[];
}

const REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const BARE_DOMAIN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

function toCitation(chunk: GroundingChunk): RawCitation | null {
  const uri = chunk.web?.uri;
  const title = chunk.web?.title;
  if (!uri) return null;

  let isRedirect = false;
  try {
    isRedirect = new URL(uri).hostname.endsWith(REDIRECT_HOST);
  } catch {
    return null;
  }

  if (isRedirect && title && BARE_DOMAIN.test(title.trim())) {
    return { url: `https://${title.trim()}/`, title, snippet: uri };
  }
  return { url: uri, title };
}

export class GoogleGeminiAdapter implements EngineAdapter {
  readonly name = ENGINE;

  getRunConfig(): Readonly<Record<string, string | number | boolean | null>> {
    const base = process.env.GOOGLE_AI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
    const model = process.env.GOOGLE_AI_MODEL ?? "gemini-2.5-flash";
    return { endpoint: `${base}/models/${model}:generateContent`, model, tool: "google_search" };
  }

  getSurfaceContext(locale?: string) {
    return apiSurfaceContext({
      provider: "Google",
      productSurface: "Google Gemini API + Google Search grounding",
      locale,
      countryApplied: false,
    });
  }

  isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_AI_API_KEY);
  }

  async query({ prompt, signal }: QueryOptions): Promise<EngineObservation> {
    const base = process.env.GOOGLE_AI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
    const model = process.env.GOOGLE_AI_MODEL ?? "gemini-2.5-flash";
    const timeoutMs = Number.parseInt(process.env.GOOGLE_AI_TIMEOUT_MS ?? "60000", 10);
    const endpoint = `${base}/models/${model}:generateContent`;
    const provenance = `google:generativelanguage:${endpoint}:google_search`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-goog-api-key": process.env.GOOGLE_AI_API_KEY ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          // 同 Perplexity 适配器：只给工具不给引导，搜不搜由模型决定
          tools: [{ google_search: {} }],
        }),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Gemini HTTP ${response.status}: ${detail.slice(0, 300)}`);
      }

      const payload = (await response.json()) as GeminiPayload;
      const candidate = payload.candidates?.[0];

      const answerText = (candidate?.content?.parts ?? [])
        .map((part) => part.text?.trim() ?? "")
        .filter(Boolean)
        .join("\n\n");

      const sink = new Map<string, RawCitation>();
      for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
        const citation = toCitation(chunk);
        if (citation && !sink.has(citation.url)) sink.set(citation.url, citation);
      }
      const citations = [...sink.values()];

      return {
        engine: ENGINE,
        provenance,
        fidelity: citations.length > 0 ? "web_grounded" : "weights_only",
        modelVersion: payload.modelVersion ?? model,
        answerText,
        citations,
        raw: payload,
        interpretation: {
          // 直连 API 不报告是否触发了检索，只能从有无引用降级推断。
          // 「搜了但没引用」在这些引擎上无法与「没搜」区分 —— 报告里要说明这个局限。
          retrievalUsed: citations.length > 0 ? true : undefined,
          extractionStatus: citations.length > 0 ? "extracted" : "no_extraction",
        },
      };
    } catch (error) {
      return errorObservation(ENGINE, provenance, error);
    }
  }
}
