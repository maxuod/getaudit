/**
 * 正文品牌提及检测。
 *
 * 提及（brand_mentioned）和引用（citation）是两个不同的指标，必须分开统计：
 * AI 可以推荐你却不给链接，也可以给链接却没提你的名字。
 * 客户通常更在意前者，而后者才是可归因到具体资产的。
 */

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 用词边界匹配，避免 "Ada" 命中 "Canada" 这类误报。
 * 对含非 ASCII 或空格的别名退化为大小写不敏感的子串匹配。
 */
export function mentionsBrand(text: string, names: readonly string[]): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();

  return names.some((rawName) => {
    const name = rawName.trim().toLowerCase();
    if (!name) return false;

    if (/^[a-z0-9][a-z0-9\-'&. ]*$/.test(name)) {
      const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(name)}(?![a-z0-9])`, "i");
      return pattern.test(haystack);
    }
    return haystack.includes(name);
  });
}

/** 返回命中的别名，便于人工抽查误报。 */
export function matchedAliases(text: string, names: readonly string[]): string[] {
  return names.filter((name) => mentionsBrand(text, [name]));
}
