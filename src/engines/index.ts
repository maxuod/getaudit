import type { EngineAdapter } from "./types.ts";
import { PerplexityAdapter } from "./perplexity.ts";
import { DataForSeoAdapter } from "./dataforseo.ts";
import { DataForSeoAioAdapter } from "./dataforseo-aio.ts";
import { OpenAiAdapter } from "./openai.ts";
import { GoogleGeminiAdapter } from "./google-gemini.ts";
import { AnthropicAdapter } from "./anthropic.ts";

/**
 * 两类通道刻意并存：
 * - dataforseo_* 走代理面（观测第三方监测视角，且有的表面只有它有，如 AIO）
 * - openai_gpt / google_gemini / anthropic_claude 直连官方 API
 * 同一模型家族两条通道的引用行为若长期背离，本身就是报告素材。
 * 未配置密钥的引擎会被 resolveEngines 自动跳过，不会报错。
 */
export const ALL_ENGINES: EngineAdapter[] = [
  new PerplexityAdapter(),
  new DataForSeoAdapter("chat_gpt"),
  new DataForSeoAdapter("gemini"),
  new DataForSeoAdapter("claude"),
  new DataForSeoAioAdapter(),
  new OpenAiAdapter(),
  new GoogleGeminiAdapter(),
  new AnthropicAdapter(),
];

export function resolveEngines(names?: readonly string[]): EngineAdapter[] {
  const configured = ALL_ENGINES.filter((engine) => engine.isConfigured());
  if (!names?.length) return configured;
  return configured.filter((engine) => names.includes(engine.name));
}

export { type EngineAdapter } from "./types.ts";
