import type { EngineAdapter, EngineObservation, QueryOptions, RawCitation } from "./types.ts";
import { errorObservation } from "./types.ts";
import { resolveCountry } from "../lib/locale.ts";
import { apiSurfaceContext } from "./surface-context.ts";

/**
 * OpenAI 直连 —— Responses API + web_search 工具。
 *
 * 与 dataforseo_chat_gpt 是同一个底层模型家族的两条观测通道，
 * 刻意都保留：直连观测的是「API 用户视角」，DataForSEO 观测的是其代理面。
 * 两边引用行为若长期背离，本身就是值得写进报告的发现。
 *
 * 与 Perplexity 适配器同一原则：不加任何「请引用来源」引导，
 * 只把 web_search 工具放在桌上，搜不搜由模型决定 —— 这才是用户真实提问时的行为。
 */

const ENGINE = "openai_gpt";

interface ResponsesAnnotation {
  type?: string;
  url?: string;
  title?: string;
}

interface ResponsesContent {
  type?: string;
  text?: string;
  annotations?: ResponsesAnnotation[];
}

interface ResponsesOutputItem {
  type?: string;
  content?: ResponsesContent[];
}

interface ResponsesPayload {
  model?: string;
  output?: ResponsesOutputItem[];
}

export class OpenAiAdapter implements EngineAdapter {
  readonly name = ENGINE;

  getRunConfig(): Readonly<Record<string, string | number | boolean | null>> {
    const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    return {
      endpoint: `${base}/responses`,
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      tool: "web_search",
      location_policy: "prompt_locale_to_country",
    };
  }

  getSurfaceContext(locale?: string) {
    return apiSurfaceContext({
      provider: "OpenAI",
      productSurface: "OpenAI Responses API + web_search",
      locale,
      countryApplied: Boolean(resolveCountry(locale)),
    });
  }

  isConfigured(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  async query({ prompt, locale, signal }: QueryOptions): Promise<EngineObservation> {
    const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    const timeoutMs = Number.parseInt(process.env.OPENAI_TIMEOUT_MS ?? "60000", 10);
    const endpoint = `${base}/responses`;
    // 地域钉扎必须写进 provenance：不同地域的观测不属于同一个实验
    const country = resolveCountry(locale);
    const provenance = `openai:responses:${endpoint}:${model}:web_search${country ? `:loc=${country}` : ""}`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: prompt,
          tools: [
            {
              type: "web_search",
              ...(country ? { user_location: { type: "approximate", country } } : {}),
            },
          ],
        }),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`OpenAI HTTP ${response.status}: ${detail.slice(0, 300)}`);
      }

      const payload = (await response.json()) as ResponsesPayload;

      const parts: string[] = [];
      const sink = new Map<string, RawCitation>();

      for (const item of payload.output ?? []) {
        if (item.type !== "message") continue;
        for (const content of item.content ?? []) {
          if (content.type !== "output_text") continue;
          if (content.text?.trim()) parts.push(content.text.trim());
          for (const annotation of content.annotations ?? []) {
            // url_citation 是「正文实际引用」，不是检索候选 —— 正是要测的信号
            if (annotation.type !== "url_citation" || !annotation.url) continue;
            if (!sink.has(annotation.url)) {
              sink.set(annotation.url, { url: annotation.url, title: annotation.title });
            }
          }
        }
      }
      const citations = [...sink.values()];

      return {
        engine: ENGINE,
        provenance,
        fidelity: citations.length > 0 ? "web_grounded" : "weights_only",
        modelVersion: payload.model ?? model,
        answerText: parts.join("\n\n"),
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
