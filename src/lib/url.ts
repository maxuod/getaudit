/**
 * 域名归一化。
 *
 * 引用面归属分析的准确性完全取决于这里：
 * 如果 www.brand.com 和 brand.com 被算成两个域名，占比统计就是错的。
 */

/** 这些后缀是两段式 TLD，注册域要多取一段。列表不求全，覆盖常见即可。 */
const TWO_PART_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.kr", "co.nz", "co.za",
  "com.au", "com.br", "com.cn", "com.hk", "com.mx", "com.sg", "com.tw", "com.tr",
  "net.au", "org.au", "com.ar", "com.co",
]);

export function normalizeDomain(input: string): string {
  let host = input.trim().toLowerCase();

  // 允许直接传裸域名
  if (host.includes("/") || host.includes(":")) {
    try {
      host = new URL(host.startsWith("http") ? host : `https://${host}`).hostname;
    } catch {
      return "";
    }
  }

  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return host;
}

/** 取注册域（brand.com / brand.co.uk），用于归属判断。 */
export function registrableDomain(input: string): string {
  const host = normalizeDomain(input);
  if (!host || !host.includes(".")) return host;

  const parts = host.split(".");
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_TLDS.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

export function domainFromUrl(url: string): string {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return "";
  }
}

/**
 * 判断一个引用 URL 是否属于客户自有域名。
 * 子域名算自有（blog.brand.com 属于 brand.com）。
 */
export function isOwnedDomain(url: string, ownedDomains: readonly string[]): boolean {
  const domain = domainFromUrl(url);
  if (!domain) return false;

  const registrable = registrableDomain(domain);
  return ownedDomains.some((owned) => {
    const target = registrableDomain(owned);
    return Boolean(target) && (registrable === target || domain === normalizeDomain(owned));
  });
}
