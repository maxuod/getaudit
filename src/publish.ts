import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  REPORT_EVIDENCE_SCHEMA,
  assertReportDocumentFingerprint,
  finalizeReportDocument,
  parseReportEvidenceEnvelope,
} from "./analysis/report-credibility.ts";
import { canonicalJson, sha256 } from "./lib/canonical-json.ts";

/**
 * 报告发布 —— 把自包含 HTML 报告变成可以直接丢给客户的链接。
 *
 * 三条安全约束，不是可选项：
 * 1. URL 用足够长的随机串。客户报告里有域名、竞品数据、内部判断，
 *    不能被猜到，也不能被枚举。
 * 2. 每份报告注入 noindex/nofollow，站点级 robots.txt 全面 Disallow。
 *    客户的诊断出现在搜索结果里 = 事故。
 * 3. 永远不生成索引页。列出所有客户报告的页面一旦泄露，
 *    等于把整个客户名单交出去。
 */

const SITE_DIR = "site";
const PUBLIC_DIR = join(SITE_DIR, "public");

/** 22 字符的 base62 随机串：约 130 bit 熵，枚举不可行。 */
function makeSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(22);
  let slug = "";
  for (const byte of bytes) slug += alphabet[byte % alphabet.length];
  return slug;
}

/** 注入 noindex。已有的不重复加。 */
function withNoIndex(html: string): string {
  if (/name=["']robots["']/i.test(html)) return html;
  const tag = '<meta name="robots" content="noindex, nofollow, noarchive">';
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${tag}`);
  }
  return `${tag}\n${html}`;
}

export interface PublishResult {
  slug: string;
  path: string;
  url: string;
}

function metaContent(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta\\s+[^>]*name=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  return html.match(pattern)?.[1] ?? null;
}

/**
 * 发布门禁只校验本项目生成的机器可读封套和内部一致性。
 * SHA-256 不能证明上游响应真实，也不能替代第三方见证或网页 artifact 复核。
 */
export function assertReportHtmlPublishable(html: string): void {
  if (!/<html/i.test(html)) {
    throw new Error("只能发布自包含的 HTML 报告（report:html / report:landscape 的产物）");
  }

  assertReportDocumentFingerprint(html);
  const schema = metaContent(html, "geo-proof-report-schema");
  const status = metaContent(html, "geo-proof-report-status");
  const gate = metaContent(html, "geo-proof-publication-gate");
  const fingerprint = metaContent(html, "geo-proof-evidence-sha256");
  if (schema !== REPORT_EVIDENCE_SCHEMA) {
    throw new Error("报告缺少当前版本的证据封套；请重新生成报告后再发布");
  }
  if (gate !== "pass" || status !== "descriptive-only") {
    throw new Error(`报告发布门禁未通过（status=${status ?? "missing"}, gate=${gate ?? "missing"}）`);
  }

  if (!fingerprint) throw new Error("报告证据封套或指纹缺失");
  const parsed = parseReportEvidenceEnvelope(html);
  const record = parsed as unknown as Record<string, unknown>;
  if (
    record["schemaVersion"] !== schema ||
    record["publicationStatus"] !== status ||
    record["publicationGate"] !== gate
  ) {
    throw new Error("报告 meta 与证据封套不一致");
  }
  if (sha256(canonicalJson(parsed)) !== fingerprint) {
    throw new Error("报告证据封套指纹不匹配；文件可能被手工改写或损坏");
  }
}

export function assertReportFilePublishable(filePath: string): void {
  const source = resolve(filePath);
  if (!existsSync(source)) throw new Error(`报告文件不存在：${filePath}`);
  assertReportHtmlPublishable(readFileSync(source, "utf8"));
}

export function publishReport(
  filePath: string,
  options: { slug?: string; baseUrl?: string } = {},
): PublishResult {
  const source = resolve(filePath);
  if (!existsSync(source)) throw new Error(`报告文件不存在：${filePath}`);

  const html = readFileSync(source, "utf8");
  assertReportHtmlPublishable(html);

  const slug = options.slug?.trim() || makeSlug();
  const outPath = join(PUBLIC_DIR, "r", slug, "index.html");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, finalizeReportDocument(withNoIndex(html)), "utf8");

  const base = (options.baseUrl ?? process.env.PUBLISH_BASE_URL ?? "").replace(/\/+$/, "");
  return { slug, path: outPath, url: base ? `${base}/r/${slug}` : `/r/${slug}` };
}

/** 首次发布时创建站点骨架。已存在的文件不覆盖 —— 落地页是你会手改的。 */
export function ensureSiteScaffold(): string[] {
  const created: string[] = [];

  const write = (path: string, content: string): void => {
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    created.push(path);
  };

  // 全站禁止抓取。客户报告绝不能进搜索引擎。
  write(
    join(PUBLIC_DIR, "robots.txt"),
    `User-agent: *
Disallow: /

# 客户报告不进搜索引擎。要公开的内容（榜单等）单独建站或单独放行。
`,
  );

  write(
    join(SITE_DIR, "vercel.json"),
    JSON.stringify(
      {
        $schema: "https://openapi.vercel.sh/vercel.json",
        headers: [
          {
            source: "/r/(.*)",
            headers: [
              { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
              { key: "Referrer-Policy", value: "no-referrer" },
              { key: "Cache-Control", value: "private, max-age=0, must-revalidate" },
            ],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );

  write(
    join(PUBLIC_DIR, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Reports</title>
<style>
  body { margin:0; display:grid; place-items:center; min-height:100vh;
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         color:#6b7280; background:#fff; }
</style>
</head>
<body>
<p>Nothing here. Reports are shared by direct link.</p>
</body>
</html>
`,
  );

  write(
    join(SITE_DIR, ".gitignore"),
    `# 客户报告不进版本库 —— 里面有客户数据
public/r/
`,
  );

  return created;
}
