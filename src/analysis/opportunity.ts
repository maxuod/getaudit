import type { Ledger } from "../db/index.ts";
import { buildAttributionReport } from "./attribution.ts";

/**
 * 机会评分 —— 哪些查询你能赢，哪些别浪费钱。
 *
 * 核心思想：难度不靠猜，从「谁在占据这个位置」反推。
 *
 * 一个软件公司永远赢不过省政府官网回答劳动法问题（信任层级），
 * 但如果赢家里有 rostershare.me 这种小站，说明门槛低、可以插进去。
 * 同理：引用位越多、越分散，挤进去越容易。
 *
 * 评分只覆盖已测量的 prompt —— 没有观测数据就没有评分。
 * 要评估新关键词，先用 discover 挖出来、跑一轮 N=3，再评分。
 */

export type Tier = "easy" | "moderate" | "hard" | "structural";

export interface OpportunityRow {
  text: string;
  score: number;
  tier: Tier;
  /** 你当前的命中率 */
  ownRate: number;
  usable: number;
  /** 该查询平均引用几个来源 —— 位子越多越容易挤 */
  slots: number;
  /** 被锁死的位子数：出现率 ≥50% 的第三方域名个数 */
  lockedSlots: number;
  /** 空位 = 平均引用数 − 锁死数。这才是真正的机会指标 */
  freeSlots: number;
  topDomain: string;
  /** 引用了官方来源的观测占比（按观测去重，不是域名累加） */
  institutionalShare: number;
  /** 赢家里有没有小众站 —— 有则说明门槛低 */
  hasNicheWinner: boolean;
  reasons: string[];
}

/**
 * 域名分类。这个列表决定评分的准确性，
 * 加新品类时要维护它（尤其 institutional —— 误判会让可打的查询被劝退）。
 */
const INSTITUTIONAL =
  /(^|\.)(gc\.ca|canada\.ca|ontario\.ca|alberta\.ca|novascotia\.ca|gov\.bc\.ca|saskatchewan\.ca|quebec\.ca|manitoba\.ca)$|\.gov$|\.gov\.|justice\.gc\.ca|cra-arc/i;

const BIG_PLATFORM =
  /(^|\.)(microsoft\.com|google\.com|apple\.com|amazon\.com|indeed\.com|linkedin\.com|wikipedia\.org|youtube\.com|facebook\.com|reddit\.com|apps\.apple\.com|play\.google\.com|excel\.cloud\.microsoft|zapier\.com)$/i;

/** 出现率低于这个阈值的域名视为「小众站」——它们在榜说明门槛不高。 */
const NICHE_MAX_SHARE = 0.15;

export interface OpportunityOptions {
  parserVersion: string;
  runIds?: readonly string[];
  engines?: readonly string[];
  excludeEngines?: readonly string[];
}

export function buildOpportunity(
  db: Ledger,
  promptSetId: string,
  options: OpportunityOptions,
): OpportunityRow[] {
  const runIds = options.runIds?.filter(Boolean) ?? [];
  const include = options.engines?.filter(Boolean) ?? [];
  const exclude = options.excludeEngines?.filter(Boolean) ?? [];

  const scopeSql =
    (runIds.length ? ` AND o.run_id IN (${runIds.map(() => "?").join(",")})` : "") +
    (include.length
      ? ` AND o.engine IN (${include.map(() => "?").join(",")})`
      : exclude.length
        ? ` AND o.engine NOT IN (${exclude.map(() => "?").join(",")})`
        : "");
  const scopeArgs = [...runIds, ...(include.length ? include : exclude)];
  buildAttributionReport(db, promptSetId, {
    parserVersion: options.parserVersion,
    runIds: [...runIds],
    excludeEngines: include.length ? [] : [...exclude],
  });

  const prompts = db
    .prepare(
      `SELECT p.id, p.text,
              SUM(CASE WHEN o.fidelity != 'error' THEN 1 ELSE 0 END) AS usable,
              SUM(CASE WHEN o.fidelity != 'error' AND EXISTS (
                    SELECT 1 FROM citation c
                     WHERE c.observation_id = o.id AND c.ownership = 'owned'
                  ) THEN 1 ELSE 0 END) AS own_hits
         FROM prompt p
         LEFT JOIN observation o ON o.prompt_id = p.id${scopeSql}
        WHERE p.prompt_set_id = ?
        GROUP BY p.id`,
    )
    .all(...scopeArgs, promptSetId) as unknown as Array<{
    id: string;
    text: string;
    usable: number;
    own_hits: number;
  }>;

  const domainStmt = db.prepare(
    `SELECT c.domain, COUNT(DISTINCT o.id) AS obs, COUNT(*) AS cites
       FROM citation c
       JOIN observation o ON o.id = c.observation_id
      WHERE o.prompt_id = ? AND o.fidelity != 'error'
        AND c.ownership = 'third_party'${scopeSql}
      GROUP BY c.domain ORDER BY obs DESC`,
  );

  const rows: OpportunityRow[] = [];

  for (const prompt of prompts) {
    if (prompt.usable === 0) continue;

    const domains = domainStmt.all(prompt.id, ...scopeArgs) as unknown as Array<{
      domain: string;
      obs: number;
      cites: number;
    }>;
    if (!domains.length) continue;

    const totalCites = domains.reduce((sum, d) => sum + d.cites, 0);
    const slots = totalCites / prompt.usable;
    const top = domains[0];
    const ownRate = prompt.own_hits / prompt.usable;

    // 被锁死的位子：出现率 ≥50% 的域名。
    // 不能用「第一名占多少」衡量垄断 —— AIO 对同一查询的回答高度确定，
    // 十次采样结果几乎一致，第一名天然接近 100%，那不代表没有空位。
    const lockedSlots = domains.filter((d) => d.obs / prompt.usable >= 0.5).length;
    const freeSlots = Math.max(0, slots - lockedSlots);

    // 官方来源占比按观测去重，不能把多个机构域名的观测数相加（会超过 100%）
    const institutionalObs = new Set<string>();
    const instDomains = domains.filter((d) => INSTITUTIONAL.test(d.domain)).map((d) => d.domain);
    if (instDomains.length) {
      const rows2 = db
        .prepare(
          `SELECT DISTINCT o.id FROM observation o
             JOIN citation c ON c.observation_id = o.id
            WHERE o.prompt_id = ? AND o.fidelity != 'error'
              AND c.domain IN (${instDomains.map(() => "?").join(",")})${scopeSql}`,
        )
        .all(prompt.id, ...instDomains, ...scopeArgs) as Array<{ id: string }>;
      for (const r of rows2) institutionalObs.add(r.id);
    }
    const institutionalShare = institutionalObs.size / prompt.usable;

    const hasNicheWinner = domains
      .slice(0, 6)
      .some(
        (d) =>
          !INSTITUTIONAL.test(d.domain) &&
          !BIG_PLATFORM.test(d.domain) &&
          d.obs / prompt.usable <= NICHE_MAX_SHARE,
      );

    // ---- 评分 ----
    let score = 50;
    const reasons: string[] = [];

    // 已有基础是最强的正信号：AI 已经认可你的相关性，只是不稳定
    if (ownRate >= 0.5) {
      score += 25;
      reasons.push(`已稳定命中 ${(ownRate * 100).toFixed(0)}%，守住即可`);
    } else if (ownRate > 0) {
      score += 22;
      reasons.push(`已偶尔命中 ${(ownRate * 100).toFixed(0)}% —— 推到稳定比从零开始容易`);
    }

    // 空位是核心指标：位子总数减去被锁死的
    if (freeSlots >= 5) {
      score += 18;
      reasons.push(`约 ${freeSlots.toFixed(1)} 个位子在轮换（共 ${slots.toFixed(1)} 个），空间大`);
    } else if (freeSlots >= 2.5) {
      score += 8;
      reasons.push(`约 ${freeSlots.toFixed(1)} 个位子在轮换`);
    } else {
      score -= 15;
      reasons.push(
        `${lockedSlots} 个域名锁死了几乎全部 ${slots.toFixed(1)} 个位子，格局固化`,
      );
    }

    // 机构垄断 —— 这是结构性的，不是努力能解决的
    if (institutionalShare >= 0.5) {
      score -= 45;
      reasons.push(
        `${(institutionalShare * 100).toFixed(0)}% 的回答引用官方来源 —— 商业站赢不过信任层级`,
      );
    } else if (institutionalShare >= 0.25) {
      score -= 18;
      reasons.push(`${(institutionalShare * 100).toFixed(0)}% 的回答引用官方来源`);
    }

    // 小众站在榜 = 门槛低
    if (hasNicheWinner) {
      score += 14;
      reasons.push("赢家里有小众站，说明门槛不高");
    }

    // 位子少 = 天然难挤
    if (slots <= 4) {
      score -= 12;
      reasons.push(`每个回答只引用 ${slots.toFixed(1)} 个来源，位子本身就少`);
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    // 已经赢下的查询不可能是「结构性劣势」——实证胜过启发式规则。
    // 官方来源占比高只说明这类问题 AI 偏好权威源，
    // 但既然你已经稳定在场，那个门槛对你已经不存在了。
    const alreadyWinning = ownRate >= 0.5;
    if (alreadyWinning && institutionalShare >= 0.5) {
      reasons.unshift(
        `⚑ 官方来源占比高，但你已稳定命中 ${(ownRate * 100).toFixed(0)}% —— 门槛对你不成立，守住即可`,
      );
      score = Math.max(score, 72);
    }

    const tier: Tier = alreadyWinning
      ? score >= 72
        ? "easy"
        : "moderate"
      : institutionalShare >= 0.5
        ? "structural"
        : score >= 72
          ? "easy"
          : score >= 52
            ? "moderate"
            : "hard";

    rows.push({
      text: prompt.text,
      score,
      tier,
      ownRate,
      usable: prompt.usable,
      slots,
      lockedSlots,
      freeSlots,
      topDomain: top?.domain ?? "",
      institutionalShare,
      hasNicheWinner,
      reasons,
    });
  }

  return rows.sort((a, b) => b.score - a.score);
}

const TIER_LABEL: Record<Tier, string> = {
  easy: "🟢 唾手可得 —— 优先做",
  moderate: "🟡 值得投入 —— 需要好内容",
  hard: "🟠 需要硬打 —— 权衡投入产出",
  structural: "🔴 结构性劣势 —— 建议放弃",
};

export function renderOpportunity(rows: OpportunityRow[]): string {
  const out: string[] = [];
  out.push("机会评分 —— 哪些查询能赢，哪些别浪费钱");
  out.push("=".repeat(88));
  out.push("");
  out.push("评分依据：引用位数量、格局集中度、赢家的权威类型、你已有的基础。");
  out.push("分数高 = 更容易插进去，不代表流量大 —— 商业价值要你自己判断。");
  out.push("");

  const tiers: Tier[] = ["easy", "moderate", "hard", "structural"];
  for (const tier of tiers) {
    const group = rows.filter((r) => r.tier === tier);
    if (!group.length) continue;

    out.push(`${TIER_LABEL[tier]}（${group.length} 条）`);
    out.push("-".repeat(88));
    for (const row of group) {
      out.push(
        `  ${String(row.score).padStart(3)} 分  ` +
          `[你 ${(row.ownRate * 100).toFixed(0).padStart(3)}%]  ` +
          `${row.text.slice(0, 58)}`,
      );
      out.push(
        `         第一名 ${row.topDomain} · 位子 ${row.slots.toFixed(1)}（锁死 ${row.lockedSlots}）`,
      );
      for (const reason of row.reasons.slice(0, 2)) {
        out.push(`         · ${reason}`);
      }
    }
    out.push("");
  }

  const easy = rows.filter((r) => r.tier === "easy").length;
  const structural = rows.filter((r) => r.tier === "structural").length;
  out.push("=".repeat(88));
  out.push(
    `合计 ${rows.length} 条：唾手可得 ${easy} · ` +
      `值得投入 ${rows.filter((r) => r.tier === "moderate").length} · ` +
      `需硬打 ${rows.filter((r) => r.tier === "hard").length} · ` +
      `建议放弃 ${structural}`,
  );
  if (structural) {
    out.push("");
    out.push(`⚠️  ${structural} 条被判为结构性劣势 —— 赢家是政府或官方来源。`);
    out.push("    这类查询上，内容质量再高也赢不过信任层级。主动告诉客户别投，");
    out.push("    这条建议本身就是最强的信任信号。");
  }
  return out.join("\n");
}
