import type { EngineAdapter, EngineObservation, QueryOptions, RawCitation } from "./types.ts";
import { errorObservation } from "./types.ts";
import { apiSurfaceContext } from "./surface-context.ts";

/**
 * Anthropic 直连 —— Messages API + web_search 工具。
 *
 * 引用只取 text block 的 citations（web_search_result_location），
 * 即「正文实际引用」。web_search_tool_result 里是检索候选，
 * 检索到 ≠ 引用了 —— 把候选算作引用会系统性虚高份额，刻意不采。
 * 候选仍在 raw 里，日后要做「检索到但没引用」分析可直接复用历史观测。
 */

const ENGINE = "anthropic_claude";

interface TextCitation {
  type?: string;
  url?: string;
  title?: string;
  cited_text?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
  citations?: TextCitation[];
}

interface MessagesPayload {
  model?: string;
  content?: ContentBlock[];
}

export class AnthropicAdapter implements EngineAdapter {
  readonly name = ENGINE;

  getRunConfig(): Readonly<Record<string, string | number | boolean | null>> {
    const base = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
    return {
      endpoint: `${base}/v1/messages`,
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
      tool: "web_search_20250305",
      max_search_uses: 5,
    };
  }

  getSurfaceContext(locale?: string) {
    return apiSurfaceContext({
      provider: "Anthropic",
      productSurface: "Anthropic Messages API + web_search",
      locale,
      countryApplied: false,
    });
  }

  isConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async query({ prompt, signal }: QueryOptions): Promise<EngineObservation> {
    const base = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    const timeoutMs = Number.parseInt(process.env.ANTHROPIC_TIMEOUT_MS ?? "60000", 10);
    const endpoint = `${base}/v1/messages`;
    const provenance = `anthropic:messages:${endpoint}:${model}:web_search`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          messages: [{ role: "user", content: prompt }],
          // 同 Perplexity 适配器：只给工具不给引导，搜不搜由模型决定
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        }),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Anthropic HTTP ${response.status}: ${detail.slice(0, 300)}`);
      }

      const payload = (await response.json()) as MessagesPayload;

      const parts: string[] = [];
      const sink = new Map<string, RawCitation>();

      for (const block of payload.content ?? []) {
        if (block.type !== "text") continue;
        if (block.text?.trim()) parts.push(block.text.trim());
        for (const citation of block.citations ?? []) {
          if (citation.type !== "web_search_result_location" || !citation.url) continue;
          if (!sink.has(citation.url)) {
            sink.set(citation.url, {
              url: citation.url,
              title: citation.title,
              snippet: citation.cited_text?.slice(0, 500),
            });
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
