import type { EngineAdapter, EngineObservation, QueryOptions, RawCitation } from "./types.ts";
import { errorObservation } from "./types.ts";
import { withOneRetry } from "./retry.ts";
import { dataForSeoAioSurfaceContext } from "./surface-context.ts";

/**
 * Google AI Overviews —— 经 DataForSEO SERP API（google/organic/live/advanced）。
 *
 * 这是与其他引擎语义不同的表面：prompt 被当作 Google 搜索关键词，
 * 观测的是「这个查询下 Google 是否展示 AI Overview、引用了谁」。
 *
 * fidelity 语义（沿用全局约定 citations>0 → web_grounded）：
 * 这里的 weights_only 意为「该关键词没有触发 AI Overview 或 AIO 无引用」——
 * 表面缺席本身也是有效观测（份额为零），raw 原样入库可复查。
 *
 * load_async_ai_overview=true：很多 AIO 是异步加载的，不开这个开关会系统性漏采。
 */

const ENGINE = "dataforseo_google_aio";

interface SerpTaskResponse {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: Array<{ items?: Array<Record<string, unknown>> }>;
  }>;
}

/** 深度收集 ai_overview 节点里的 references（顶层 + 嵌套元素里都可能有）。 */
function harvestReferences(node: unknown, sink: Map<string, RawCitation>, depth = 0): void {
  if (depth > 10 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) harvestReferences(item, sink, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  const url = record["url"] ?? record["source_url"];
  if (typeof url === "string" && /^https?:\/\//i.test(url) && !sink.has(url)) {
    const title = record["title"] ?? record["source"] ?? record["domain"];
    const snippet = record["snippet"] ?? record["text"];
    sink.set(url, {
      url,
      title: typeof title === "string" ? title : undefined,
      snippet: typeof snippet === "string" ? snippet.slice(0, 500) : undefined,
    });
  }

  for (const value of Object.values(record)) {
    harvestReferences(value, sink, depth + 1);
  }
}

/** 收集 AIO 正文（markdown/text 字段）。 */
function harvestAioText(node: unknown, parts: string[], depth = 0): void {
  if (depth > 10 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) harvestAioText(item, parts, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  const text = record["markdown"] ?? record["text"];
  if (typeof text === "string" && text.trim()) parts.push(text.trim());

  for (const [key, value] of Object.entries(record)) {
    if (key === "markdown" || key === "text") continue;
    harvestAioText(value, parts, depth + 1);
  }
}

export class DataForSeoAioAdapter implements EngineAdapter {
  readonly name = ENGINE;

  getRunConfig(): Readonly<Record<string, string | number | boolean | null>> {
    const base = process.env.DATAFORSEO_BASE_URL ?? "https://api.dataforseo.com/v3";
    return {
      endpoint: `${base}/serp/google/organic/live/advanced`,
      location_code: Number.parseInt(process.env.DATAFORSEO_SERP_LOCATION_CODE ?? "2124", 10),
      language_code: process.env.DATAFORSEO_SERP_LANGUAGE_CODE ?? "en",
      device: "desktop",
      load_async_ai_overview: true,
    };
  }

  getSurfaceContext(locale?: string) {
    return dataForSeoAioSurfaceContext(locale);
  }

  isConfigured(): boolean {
    return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
  }

  async query({ prompt, signal }: QueryOptions): Promise<EngineObservation> {
    const base = process.env.DATAFORSEO_BASE_URL ?? "https://api.dataforseo.com/v3";
    const endpoint = `${base}/serp/google/organic/live/advanced`;
    const locationCode = Number.parseInt(process.env.DATAFORSEO_SERP_LOCATION_CODE ?? "2124", 10); // 2124 = Canada
    const languageCode = process.env.DATAFORSEO_SERP_LANGUAGE_CODE ?? "en";
    const timeoutMs = Number.parseInt(process.env.DATAFORSEO_TIMEOUT_MS ?? "120000", 10);
    const provenance = `dataforseo:serp:google/organic/live/advanced:aio:loc=${locationCode}:lang=${languageCode}`;

    const auth = Buffer.from(
      `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
    ).toString("base64");

    const task = {
      keyword: prompt,
      location_code: locationCode,
      language_code: languageCode,
      device: "desktop",
      load_async_ai_overview: true,
    };

    try {
      // 40101/5xx 是上游抽风，重试一次；配置错不重试
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

        const payload = (await response.json()) as SerpTaskResponse;
        const taskResult = payload.tasks?.[0];
        if (!taskResult || (taskResult.status_code ?? 0) >= 40000) {
          const hint =
            taskResult?.status_code === 40101 && prompt.split(/\s+/).length > 10
              ? "（提示：SERP 端点期待搜索关键词，当前输入是长问句 —— " +
                "AIO 表面请使用关键词版 prompt 集）"
              : "";
          throw new Error(
            `DataForSEO task error ${taskResult?.status_code}: ${taskResult?.status_message ?? "unknown"}${hint}`,
          );
        }

        // 只从 ai_overview 块取引用 —— 普通 organic 结果不是本表面的观测对象。
        const items = taskResult.result?.[0]?.items ?? [];
        const aioBlocks = items.filter((item) => item["type"] === "ai_overview");

        const sink = new Map<string, RawCitation>();
        const parts: string[] = [];
        for (const block of aioBlocks) {
          harvestReferences(block, sink);
          harvestAioText(block, parts);
        }
        const citations = [...sink.values()];

        // 「Google 没展示 AI Overview」是有效的零样本，不是缺失数据。
        // 把它和「展示了但没引用我们」合并，再一起排除出分母 = 条件选择偏差。
        const surfacePresent = aioBlocks.length > 0;

        return {
          engine: ENGINE,
          provenance,
          fidelity: citations.length > 0 ? "web_grounded" : "weights_only",
          answerText: parts.join("\n\n"),
          citations,
          raw: payload,
          costUsd: taskResult.cost ?? payload.cost,
          interpretation: {
            // SERP 调用成功即代表 Google 完成了检索；AIO 展不展示是另一回事
            retrievalUsed: true,
            surfacePresent,
            extractionStatus: !surfacePresent
              ? "not_applicable"
              : citations.length > 0
                ? "extracted"
                : "no_extraction",
          },
        };
      });
    } catch (error) {
      return errorObservation(ENGINE, provenance, error);
    }
  }
}
