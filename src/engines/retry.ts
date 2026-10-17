/**
 * 瞬时错误重试。
 *
 * 只重试明确的上游抽风（HTTP 429、DataForSEO 40101、HTTP 5xx）。
 * 40501 这类配置错误不重试 —— 重试掩盖不了错的模型名。
 * 适配器可选择尝试次数。重试发生在单条观测内部；只有最终响应/错误入账。
 */

const TRANSIENT = /40101|HTTP (?:429|5\d\d)/;
const RETRY_AFTER = /retry-after-ms=(\d+)/i;

export interface TransientRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export function isTransientUpstreamError(error: unknown): boolean {
  return error instanceof Error && TRANSIENT.test(error.message);
}

export function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = Number.parseInt(error.message.match(RETRY_AFTER)?.[1] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const attemptsInput = options.maxAttempts ?? 3;
  const baseInput = options.baseDelayMs ?? 1_000;
  const maxInput = options.maxDelayMs ?? 30_000;
  const maxAttempts = Number.isFinite(attemptsInput)
    ? Math.max(1, Math.floor(attemptsInput))
    : 3;
  const baseDelayMs = Number.isFinite(baseInput) ? Math.max(0, baseInput) : 1_000;
  const maxDelayMs = Number.isFinite(maxInput)
    ? Math.max(baseDelayMs, maxInput)
    : Math.max(baseDelayMs, 30_000);
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientUpstreamError(error) || attempt >= maxAttempts) throw error;
      const exponential = baseDelayMs * 2 ** (attempt - 1);
      const requested = retryAfterMs(error) ?? 0;
      await sleep(Math.min(maxDelayMs, Math.max(exponential, requested)));
    }
  }
  throw new Error("retry loop reached an impossible state");
}

export async function withOneRetry<T>(fn: () => Promise<T>, delayMs = 2000): Promise<T> {
  return withTransientRetry(fn, {
    maxAttempts: 2,
    baseDelayMs: delayMs,
    maxDelayMs: delayMs,
  });
}
