/**
 * 地域解析。
 *
 * 优先级：每次调用传入的 locale（将来 CLI 的 --country/--locale 选项）
 * > 环境变量 SEARCH_USER_COUNTRY > 不钉（跟随各家引擎默认）。
 *
 * 钉住地域 = 改测量定义（「该国用户提问时谁被引用」）。
 * provenance 里必须带上生效的地域，两次采集地域不同就不是同一个实验。
 */

/** 接受 "CA" / "en-CA" / "fr_CA" 等形式，抽出 ISO 3166-1 alpha-2 国家码。 */
export function resolveCountry(locale?: string): string | undefined {
  const fromCall = extract(locale);
  if (fromCall) return fromCall;
  return extract(process.env.SEARCH_USER_COUNTRY);
}

function extract(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();

  const match = trimmed.match(/^[A-Za-z]{2,3}[-_]([A-Za-z]{2})$/);
  if (match?.[1]) return match[1].toUpperCase();

  return undefined;
}
