/**
 * Prompt 发现 —— 从 Google SERP 挖出真实用户在问什么。
 *
 * 为什么不手写 prompt：手写会带上撰写者对品类的偏见，
 * 而且一个客户能写、十个客户就成了瓶颈。
 * PAA（People Also Ask）和相关搜索是 Google 从真实搜索行为里聚合出来的，
 * 比任何人的想象更接近用户实际的提问方式。
 *
 * 为什么不自动导入台账：发现结果一定有噪音
 * （问「加拿大最好用的排班 app」会带出「加拿大最大的连锁餐厅是什么」）。
 * 本命令只产出候选文件，人工审核后再 prompts:add —— 冻结集的质量决定整个实验的质量。
 *
 * 数据来源：DataForSEO SERP google/organic/live/advanced，
 * 一次调用同时返回 organic / people_also_ask / related_searches /
 * discussions_and_forums，不需要额外的关键词工具。
 */

export type Intent = "recommendation" | "comparison" | "factual" | "howto" | "discovery";

/** 漏斗层：决定这条 prompt 的商业价值。越靠前的层越难赢，但获客价值越高。 */
export type FunnelLayer = "L1_category" | "L2_evaluation" | "L3_brand" | "L4_usage";

export interface Candidate {
  text: string;
  intent: Intent;
  layer: FunnelLayer;
  /** paa | related | seed */
  source: string;
  seed: string;
}

export interface ForumThread {
  title: string;
  url: string;
  seed: string;
}

export interface DiscoverResult {
  candidates: Candidate[];
  forums: ForumThread[];
  costUsd: number;
  errors: string[];
}

interface SerpItem {
  type?: string;
  title?: string;
  url?: string;
  items?: SerpItem[] | string[];
}

/**
 * 意图分类。刻意用规则不用 LLM：
 * 规则可审计、零成本、结果稳定 —— 分类口径变了会让前后轮次的报告不可比。
 */
export function classifyIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/\b(vs|versus|compare|comparison|alternative|better than|or\b.*\?)/.test(t))
    return "comparison";
  if (/\b(best|top|recommend|should i use|which .*(app|tool|software))/.test(t))
    return "recommendation";
  if (/^(how (do|to|can)|what'?s the (easiest|fastest|best) way)/.test(t)) return "howto";
  if (/^(what is|what are|is there|does|do |can |how (much|many|long))/.test(t)) return "factual";
  return "discovery";
}

/**
 * 漏斗层判定。品牌词出现 = 用户已经知道你（L3，获客价值低）；
 * 选型意图 = L2（主战场）；纯品类探索 = L1（最难但最值钱）。
 */
export function classifyLayer(text: string, brandAliases: readonly string[]): FunnelLayer {
  const t = text.toLowerCase();
  if (brandAliases.some((alias) => alias.trim() && t.includes(alias.trim().toLowerCase())))
    return "L3_brand";

  const intent = classifyIntent(text);
  if (intent === "howto") return "L4_usage";
  if (intent === "recommendation" || intent === "comparison") return "L2_evaluation";
  return "L1_category";
}

/** 过滤明显偏题的候选：SERP 会带出同品类但不同意图的噪音。 */
function isRelevant(text: string, mustInclude: readonly string[]): boolean {
  if (text.length < 8 || text.length > 200) return false;
  if (!mustInclude.length) return true;
  const t = text.toLowerCase();
  return mustInclude.some((term) => t.includes(term.toLowerCase()));
}

function collectFromItems(
  node: SerpItem,
  seed: string,
  out: { candidates: Candidate[]; forums: ForumThread[] },
  mustInclude: readonly string[],
  brandAliases: readonly string[],
): void {
  const push = (text: string, source: string): void => {
    const clean = text.trim();
    if (!clean || !isRelevant(clean, mustInclude)) return;
    if (out.candidates.some((c) => c.text.toLowerCase() === clean.toLowerCase())) return;
    out.candidates.push({
      text: clean,
      intent: classifyIntent(clean),
      layer: classifyLayer(clean, brandAliases),
      source,
      seed,
    });
  };

  if (node.type === "people_also_ask") {
    for (const item of (node.items ?? []) as SerpItem[]) {
      if (typeof item === "object" && item.title) push(item.title, "paa");
    }
    return;
  }

  if (node.type === "related_searches") {
    for (const item of (node.items ?? []) as unknown[]) {
      if (typeof item === "string") push(item, "related");
      else if (item && typeof item === "object" && "title" in item) {
        const title = (item as SerpItem).title;
        if (title) push(title, "related");
      }
    }
    return;
  }

  if (node.type === "discussions_and_forums") {
    for (const item of (node.items ?? []) as SerpItem[]) {
      if (typeof item === "object" && item.url && item.title) {
        if (!out.forums.some((f) => f.url === item.url)) {
          out.forums.push({ title: item.title, url: item.url, seed });
        }
      }
    }
  }
}

/**
 * 从台账已有的 SERP 原始响应里提取，不发新请求。
 *
 * 这是 append-only + 原始响应整条入库的直接回报：
 * 采集 AIO 时 Google 顺带返回的 PAA / 相关搜索 / 论坛讨论当时没用上，
 * 但因为 raw 存了下来，现在可以零成本重新解析。
 * 解析逻辑将来改进了，历史观测同样能重跑。
 */
export function discoverFromLedger(
  db: { prepare: (sql: string) => { all: (...args: string[]) => unknown[] } },
  options: {
    mustInclude?: readonly string[];
    brandAliases?: readonly string[];
    runIds?: readonly string[];
  } = {},
): DiscoverResult {
  const runIds = options.runIds?.filter(Boolean) ?? [];
  const scope = runIds.length ? ` AND run_id IN (${runIds.map(() => "?").join(",")})` : "";

  const rows = db
    .prepare(
      `SELECT raw_response FROM observation
        WHERE raw_response IS NOT NULL
          AND engine LIKE '%aio%'${scope}`,
    )
    .all(...runIds) as Array<{ raw_response: string }>;

  const out: { candidates: Candidate[]; forums: ForumThread[] } = { candidates: [], forums: [] };

  for (const row of rows) {
    let payload: {
      tasks?: Array<{ result?: Array<{ keyword?: string; items?: SerpItem[] }> }>;
    };
    try {
      payload = JSON.parse(row.raw_response);
    } catch {
      continue;
    }

    for (const task of payload.tasks ?? []) {
      for (const result of task.result ?? []) {
        const seed = result.keyword ?? "(台账)";
        for (const item of result.items ?? []) {
          collectFromItems(
            item,
            seed,
            out,
            options.mustInclude ?? [],
            options.brandAliases ?? [],
          );
        }
      }
    }
  }

  return { ...out, costUsd: 0, errors: [] };
}

export async function discover(
  seeds: readonly string[],
  options: {
    mustInclude?: readonly string[];
    brandAliases?: readonly string[];
    locationCode?: number;
    languageCode?: string;
  } = {},
): Promise<DiscoverResult> {
  const base = process.env.DATAFORSEO_BASE_URL ?? "https://api.dataforseo.com/v3";
  const endpoint = `${base}/serp/google/organic/live/advanced`;
  const locationCode =
    options.locationCode ??
    Number.parseInt(process.env.DATAFORSEO_SERP_LOCATION_CODE ?? "2124", 10);
  const languageCode =
    options.languageCode ?? process.env.DATAFORSEO_SERP_LANGUAGE_CODE ?? "en";
  const timeoutMs = Number.parseInt(process.env.DATAFORSEO_TIMEOUT_MS ?? "120000", 10);

  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
  ).toString("base64");

  const out: { candidates: Candidate[]; forums: ForumThread[] } = { candidates: [], forums: [] };
  const errors: string[] = [];
  let costUsd = 0;

  // 一个种子一次调用。串行是刻意的：发现阶段量很小（通常 5~10 个种子），
  // 并发省不下多少时间，却更容易触发限速。
  for (const seed of seeds) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify([
          {
            keyword: seed,
            location_code: locationCode,
            language_code: languageCode,
            device: "desktop",
            people_also_ask_click_depth: 2,
          },
        ]),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        errors.push(`${seed}: HTTP ${response.status}`);
        continue;
      }

      const payload = (await response.json()) as {
        cost?: number;
        tasks?: Array<{
          status_code?: number;
          status_message?: string;
          cost?: number;
          result?: Array<{ items?: SerpItem[] }>;
        }>;
      };

      const task = payload.tasks?.[0];
      if (!task || (task.status_code ?? 0) >= 40000) {
        errors.push(`${seed}: ${task?.status_code} ${task?.status_message ?? ""}`);
        continue;
      }
      costUsd += task.cost ?? payload.cost ?? 0;

      for (const result of task.result ?? []) {
        for (const item of result.items ?? []) {
          collectFromItems(
            item,
            seed,
            out,
            options.mustInclude ?? [],
            options.brandAliases ?? [],
          );
        }
      }
    } catch (error) {
      errors.push(`${seed}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ...out, costUsd, errors };
}

const LAYER_LABEL: Record<FunnelLayer, string> = {
  L1_category: "L1 品类探索 —— 用户还不知道有哪些产品（最难赢，获客价值最高）",
  L2_evaluation: "L2 选型对比 —— 用户在比较方案（主战场）",
  L3_brand: "L3 品牌验证 —— 用户已经知道你，在核实（赢了也不算获客）",
  L4_usage: "L4 使用问题 —— 操作类，多为已有用户",
};

const INTENT_LABEL: Record<Intent, string> = {
  recommendation: "推荐型",
  comparison: "对比型",
  factual: "事实型",
  howto: "操作型",
  discovery: "发现型",
};

/** 输出成可直接编辑、审核后 prompts:add 的文件。 */
export function renderCandidateFile(result: DiscoverResult, note: string): string {
  const lines: string[] = [];
  lines.push(`# Prompt 候选池 —— ${note}`);
  lines.push(`#`);
  lines.push(`# 来源：Google PAA + 相关搜索（DataForSEO SERP），成本 $${result.costUsd.toFixed(4)}`);
  lines.push(`# 共 ${result.candidates.length} 条候选。`);
  lines.push(`#`);
  lines.push(`# ⚠️ 这是候选池，不是 prompt 集。导入前必须人工审核：`);
  lines.push(`#   1. 删掉偏题的（SERP 一定会带出噪音）`);
  lines.push(`#   2. 把关键词式的改写成用户真会对 AI 说的完整问句`);
  lines.push(`#   3. L1/L2 优先保留 —— L3 品牌词赢了也不算获客`);
  lines.push(`#   4. 冻结后不可增删，所以宁可少而准`);
  lines.push("");

  const layers: FunnelLayer[] = ["L1_category", "L2_evaluation", "L4_usage", "L3_brand"];
  for (const layer of layers) {
    const group = result.candidates.filter((c) => c.layer === layer);
    if (!group.length) continue;
    lines.push(`# ${"=".repeat(70)}`);
    lines.push(`# ${LAYER_LABEL[layer]}  (${group.length} 条)`);
    lines.push(`# ${"=".repeat(70)}`);
    for (const c of group) {
      lines.push(`${c.text}    # ${INTENT_LABEL[c.intent]} · ${c.source}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** 社区讨论线索 —— 这是「打进第三方引用面」的具体落点。 */
export function renderForumFile(result: DiscoverResult): string {
  const lines: string[] = [];
  lines.push(`# 社区讨论线索（${result.forums.length} 条）`);
  lines.push(`#`);
  lines.push(`# Google 认为这些讨论与你的品类高度相关，AI 也常引用它们。`);
  lines.push(`# 用法：真实参与讨论，不要伪造账号或买水军 ——`);
  lines.push(`# 台账留痕的项目最忌讳这个，被发现的损失远大于收益。`);
  lines.push("");
  for (const f of result.forums) {
    lines.push(`- ${f.title}`);
    lines.push(`  ${f.url}`);
    lines.push(`  （来自种子：${f.seed}）`);
    lines.push("");
  }
  return lines.join("\n");
}
