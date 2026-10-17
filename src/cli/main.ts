import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { openLedger } from "../db/index.ts";
import { resolveEngines, ALL_ENGINES } from "../engines/index.ts";
import {
  addPrompts,
  createBrand,
  createPromptSet,
  freezePromptSet,
  getBrand,
  getPromptSet,
  listPrompts,
  listRuns,
  PARSER_VERSION,
} from "../ledger/repo.ts";
import { backfillInterpretations } from "../ledger/backfill.ts";
import { collect } from "../collect.ts";
import { buildAttributionReport, renderAttributionReport } from "../analysis/attribution.ts";
import { buildHtmlReport } from "../analysis/html-report.ts";
import { buildLandscape, renderLandscapeHtml } from "../analysis/landscape.ts";
import { verifyReportFileAgainstLedger } from "../analysis/report-verifier.ts";
import {
  publishReport,
  ensureSiteScaffold,
} from "../publish.ts";
import { buildPromptsReport, renderPromptsReport } from "../analysis/prompts-report.ts";
import { buildOpportunity, renderOpportunity } from "../analysis/opportunity.ts";
import {
  readBaselines,
  stratifiedAssign,
  persistAssignments,
  renderAssignReport,
} from "../experiment/assign.ts";
import {
  registerPrereg,
  getPrereg,
  renderPrereg,
  recordIntervention,
  recordClientChange,
} from "../experiment/prereg.ts";
import { buildDidReport, renderDidReport } from "../analysis/did.ts";
import {
  createExperimentManifest,
  getManifest,
  recordManifestAnchor,
  type ManifestAnchorType,
  type ManifestPlan,
} from "../experiment/manifest.ts";
import { analyzeCost, estimateRun, renderCostReport } from "../analysis/cost.ts";
import { simulatePromptLevelPower, renderPowerSimulation } from "../analysis/power.ts";
import {
  inspectExperimentReadiness,
  renderExperimentReadiness,
  type ReadinessStage,
} from "../experiment/readiness.ts";
import {
  discover,
  discoverFromLedger,
  renderCandidateFile,
  renderForumFile,
} from "../discover.ts";
import { importConsumerWebEvidence } from "../evidence/consumer-web.ts";
import { verifyArtifactsForRun } from "../evidence/artifact-verifier.ts";
import { writeFileSync } from "node:fs";

/** 解析 --runs 的分引擎语法：`10` 或 `default=5,perplexity_sonar=10,openai_gpt=2` */
function parseRuns(
  spec: string | undefined,
  fallback: number,
): { defaultRuns: number; byEngine: Record<string, number> } {
  if (!spec) return { defaultRuns: fallback, byEngine: {} };
  if (/^\d+$/.test(spec.trim())) {
    return { defaultRuns: Number.parseInt(spec, 10), byEngine: {} };
  }

  let defaultRuns = fallback;
  const byEngine: Record<string, number> = {};
  for (const part of spec.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim();
    const value = Number.parseInt(rawValue ?? "", 10);
    if (!key || Number.isNaN(value)) continue;
    if (key === "default") defaultRuns = value;
    else byEngine[key] = value;
  }
  return { defaultRuns, byEngine };
}

try {
  process.loadEnvFile(".env");
} catch {
  // 没有 .env 时依赖进程环境变量
}

const HELP = `
geo-proof-lab —— 可证伪的 GEO 实验台账

用法：npm run lab -- <命令> [参数]

命令
  engines                              列出已配置的引擎
  doctor                               端点体检：观察本次探针是否检索及引用
  brand:add    --name --domains        新增品牌（domains/aliases 用逗号分隔）
               [--aliases] [--category]
  set:create   --brand --label         新建 prompt 集
  discover     --seeds                 从 Google PAA/相关搜索挖候选 prompt
               [--filter] [--aliases] [--out]
               --from-ledger            零成本：从台账已有的 SERP 响应提取
               产出候选池文件 + 社区讨论线索，人工审核后再导入
  prompts:add  --set --file            从文本文件导入 prompt（每行一条）
  set:freeze   --set                   冻结 prompt 集并输出 hash（不可撤销）
  evidence:web:import --file           导入消费级网页版答案、引用与地域/账号证据
                                       （JSON 必须完整覆盖已冻结 prompt 集）
  evidence:artifact:verify --run --root 逐条确认捕获文件存在且 SHA 与证据包一致
  runs         --set                   列出采集轮次（找回中断的 run）
  cost         [--set] [--run] [--runs] 成本效率分析 + 下一轮预算估算
  collect      --set --phase           采集一轮观测
               [--runs] [--engines] [--exclude]
               [--concurrency] [--resume <runId>]
               --runs 支持分引擎：10  或
               "default=3,perplexity_sonar=10,openai_gpt=0"
               （=0 表示本轮跳过该引擎）
  report:attribution --set --parser-version  引用面归属报告（终端文本）
               [--run <runId,...>] [--exclude <engine,...>]
  report:prompts --set --parser-version 逐问题描述性报告
  opportunity  --set --parser-version  机会评分：哪些查询能赢、哪些别浪费钱
               [--run] [--engines] [--exclude]
  backfill                             为历史观测重新生成解释（不改观测本身）
  power        --effect --sd [--seed]  Monte Carlo prompt-level 功效模拟
  experiment:status --set --parser-version  零成本正式实验 readiness gate
               [--manifest-hash] [--json] [--require baseline|intervention|analysis]

实验编排（降低混淆并进行预先规定的推断）
  assign       --set [--seed] [--dry-run]  分层随机分组（先 --dry-run 看平衡）
  manifest:create --set --file         从 JSON 计划生成 immutable canonical manifest
  manifest:anchor --hash --type --ref  记录外部锚点（email/contract/rfc3161/opentimestamps）
  preregister  --set --manifest-hash   只从已强锚定 manifest 派生预注册
  prereg:show  --set                   查看已锁定的方案
  intervention:add --set --type        登记干预（--url --targets --date）
  change:add   --set --type --note     登记客户侧变更（污染披露）
  report:did   --set --pre --post --parser-version  prompt 级随机化 DiD
               [--engines <白名单>] [--exclude <黑名单>]
  report:html  --set --parser-version  可视化 HTML 报告（给人看的那份）
               [--run] [--exclude] [--out <path>] [--note]
  report:default [--file]              生成并复算默认 Sample Studio 展示报告
                                       默认配置 templates/sample-studio/default-showcase.json
  report:check --file                  校验整份 HTML，并从当前台账复算指标/上下文
  publish      --file                  发布报告，得到可直接发给客户的链接
               [--slug] [--baseUrl]     先校验证据封套，再生成随机 noindex URL
  report:landscape --set --vendors --parser-version
                                       品类榜单（可公开发布的获客物料）
               [--target] [--category] [--publisher] [--run] [--out]
               同一批观测算出全品类份额，边际成本为零

示例
  npm run lab -- brand:add --name "Sample Studio" --domains "sample-studio.example"
  npm run lab -- set:create --brand <brandId> --label "sampleshift-formal-YYYY-MM"
  npm run lab -- prompts:add --set <setId> --file ./prompts.txt
  npm run lab -- set:freeze --set <setId>
  npm run lab -- collect --set <setId> --phase baseline --runs 10
  npm run lab -- report:attribution --set <setId> --parser-version ${PARSER_VERSION}
`;

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(value: string | undefined, flag: string): string {
  if (!value) {
    console.error(`缺少必需参数 ${flag}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return;
  }

  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      name: { type: "string" },
      domains: { type: "string" },
      aliases: { type: "string" },
      category: { type: "string" },
      brand: { type: "string" },
      label: { type: "string" },
      set: { type: "string" },
      file: { type: "string" },
      phase: { type: "string" },
      runs: { type: "string" },
      engines: { type: "string" },
      concurrency: { type: "string" },
      note: { type: "string" },
      locale: { type: "string" },
      exclude: { type: "string" },
      resume: { type: "string" },
      run: { type: "string" },
      out: { type: "string" },
      seeds: { type: "string" },
      filter: { type: "string" },
      "from-ledger": { type: "boolean" },
      vendors: { type: "string" },
      target: { type: "string" },
      publisher: { type: "string" },
      slug: { type: "string" },
      baseUrl: { type: "string" },
      seed: { type: "string" },
      "dry-run": { type: "boolean" },
      metric: { type: "string" },
      hypothesis: { type: "string" },
      "baseline-rounds": { type: "string" },
      "followup-rounds": { type: "string" },
      url: { type: "string" },
      type: { type: "string" },
      date: { type: "string" },
      targets: { type: "string" },
      by: { type: "string" },
      pre: { type: "string" },
      post: { type: "string" },
      "parser-version": { type: "string" },
      "manifest-hash": { type: "string" },
      hash: { type: "string" },
      ref: { type: "string" },
      at: { type: "string" },
      iterations: { type: "string" },
      effect: { type: "string" },
      sd: { type: "string" },
      alpha: { type: "string" },
      "target-power": { type: "string" },
      "min-prompts": { type: "string" },
      "max-prompts": { type: "string" },
      step: { type: "string" },
      simulations: { type: "string" },
      json: { type: "boolean" },
      require: { type: "string" },
      root: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const db = openLedger();

  switch (command) {
    case "engines": {
      for (const engine of ALL_ENGINES) {
        console.log(`${engine.isConfigured() ? "✓" : "✗"}  ${engine.name}`);
      }
      break;
    }

    case "doctor": {
      // 用单次探针观察端点是否报告检索及引用。
      // 这不是稳定性验证，也不能替代正式采样。
      const engines = resolveEngines();
      if (!engines.length) {
        console.log("没有已配置的引擎，先填 .env");
        break;
      }
      const probe = "What are the best running shoes for flat feet in 2026?";
      console.log(`端点体检（单次探针，仅作配置检查）—— prompt：\n  "${probe}"\n`);

      for (const engine of engines) {
        const observation = await engine.query({ prompt: probe });
        const verdict =
          observation.fidelity === "web_grounded"
            ? "✓ 本次响应含实时引用"
            : observation.fidelity === "weights_only"
              ? "○ 本次响应无实时引用；不能据单次探针推断端点永不检索"
              : `✗ error: ${observation.errorMessage}`;
        console.log(`${engine.name}`);
        console.log(`  ${verdict}`);
        console.log(`  引用数 ${observation.citations.length}`);
        console.log(
          observation.costUsd !== undefined
            ? `  成本 $${observation.costUsd.toFixed(4)}（上游报告值）`
            : `  成本 未报告（断路器按 COLLECT_COST_FALLBACK_USD 估算）`,
        );
        if (observation.citations.length) {
          for (const citation of observation.citations.slice(0, 3)) {
            console.log(`    · ${citation.url}`);
          }
        }
        console.log("");
      }
      break;
    }

    case "brand:add": {
      const id = createBrand(db, {
        name: required(values.name as string | undefined, "--name"),
        ownedDomains: splitList(values.domains as string | undefined),
        aliases: splitList(values.aliases as string | undefined),
        category: values.category as string | undefined,
      });
      console.log(`品牌已创建：${id}`);
      break;
    }

    case "set:create": {
      const id = createPromptSet(db, {
        brandId: required(values.brand as string | undefined, "--brand"),
        label: required(values.label as string | undefined, "--label"),
        note: values.note as string | undefined,
      });
      console.log(`prompt 集已创建：${id}`);
      break;
    }

    case "prompts:add": {
      const setId = required(values.set as string | undefined, "--set");
      const file = required(values.file as string | undefined, "--file");
      // 整行注释和行内注释都要剥掉。行内注释混进 prompt 会污染观测 ——
      // 踩过一次：候选文件里的 "# 3x" 被当成关键词一起发给了 SERP。
      // 要求 # 后必须跟空白，否则 "what is the #1 tool" 会被误伤。
      const texts = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+#\s.*$/, "").trim())
        .filter((line) => line && !line.startsWith("#"));

      // prompt 的 locale 会在采集时覆盖 SEARCH_USER_COUNTRY 的地域钉扎。
      // 不指定 --locale 时跟随 SEARCH_USER_COUNTRY 生成（如 en-CA），
      // 避免「.env 钉了加拿大、prompt 默认 en-US 钉回美国」的静默事故。
      const country = process.env.SEARCH_USER_COUNTRY?.trim();
      const locale =
        (values.locale as string | undefined) ?? (country ? `en-${country.toUpperCase()}` : "en-US");

      const added = addPrompts(db, setId, texts.map((text) => ({ text, locale })));
      console.log(`导入 ${added} 条（locale=${locale}，文件共 ${texts.length} 行，重复项已忽略）`);
      break;
    }

    case "set:freeze": {
      const setId = required(values.set as string | undefined, "--set");
      const count = listPrompts(db, setId).length;
      const hash = freezePromptSet(db, setId);
      console.log(`已冻结 ${count} 条 prompt`);
      console.log(`hash: ${hash}`);
      console.log("\n把这个 hash 写进给客户的方案里 —— 它是「未事后筛选」的可验证凭证。");
      break;
    }

    case "evidence:web:import": {
      const file = required(values.file as string | undefined, "--file");
      const result = importConsumerWebEvidence(
        db,
        JSON.parse(readFileSync(file, "utf8")) as unknown,
      );
      console.log(`网页版证据已导入并封存：run ${result.runId}`);
      console.log(`引擎：${result.engine}；观测：${result.observations}`);
      console.log(`bundle sha256：${result.bundleSha256}`);
      console.log(
        result.locationStatus === "matched"
          ? "地域状态：matched（仍需按 geo_verification 区分 IP 实测与供应商声明）"
          : result.locationStatus === "mismatched"
            ? "⚠️  地域状态：mismatched；不得作为目标国家结果"
            : "⚠️  地域状态：unverified；只能作为未验证地域的描述性观测",
      );
      break;
    }

    case "evidence:artifact:verify": {
      const result = verifyArtifactsForRun(
        db,
        required(values.run as string | undefined, "--run"),
        required(values.root as string | undefined, "--root"),
      );
      console.log(
        `artifact 校验通过：新增 ${result.verified} 条，已有 ${result.alreadyVerified} 条；` +
          `run ${result.runId}`,
      );
      console.log(`校验证据指纹：${result.verificationEvidenceSha256}`);
      console.log("边界：这证明校验时文件存在且字节匹配，不证明截图内容来自真实上游页面。");
      break;
    }

    case "collect": {
      const setId = required(values.set as string | undefined, "--set");
      const phase = (values.phase as string | undefined) ?? "baseline";
      if (phase !== "baseline" && phase !== "followup") {
        console.error("--phase 只能是 baseline 或 followup");
        process.exit(1);
      }

      const excluded = splitList(values.exclude as string | undefined);
      const engines = resolveEngines(splitList(values.engines as string | undefined)).filter(
        (engine) => !excluded.includes(engine.name),
      );
      const { defaultRuns, byEngine } = parseRuns(
        (values.runs as string | undefined) ?? process.env.RUNS_PER_PROMPT,
        10,
      );
      // runs=0 的引擎直接不参与本轮
      const activeEngines = engines.filter((engine) => (byEngine[engine.name] ?? defaultRuns) > 0);
      const concurrency = Number.parseInt(
        (values.concurrency as string | undefined) ?? process.env.COLLECT_CONCURRENCY ?? "4",
        10,
      );

      const promptCount = listPrompts(db, setId).length;
      const plannedCalls = activeEngines.reduce(
        (sum, engine) => sum + (byEngine[engine.name] ?? defaultRuns) * promptCount,
        0,
      );

      console.log(
        `引擎：${activeEngines
          .map((e) => `${e.name}×${byEngine[e.name] ?? defaultRuns}`)
          .join(", ")}`,
      );
      console.log(`${promptCount} 条 prompt，计划 ${plannedCalls} 次调用，并发 ${concurrency}`);

      // 用历史单价估算本轮花费，跑之前就知道要花多少
      const history = analyzeCost(db, []);
      if (history.length) {
        const { totalUsd } = estimateRun(
          history.filter((h) => activeEngines.some((e) => e.name === h.engine)),
          promptCount,
          byEngine,
          defaultRuns,
        );
        console.log(`按历史单价估算 ≈ $${totalUsd.toFixed(2)}（预算上限见 COLLECT_MAX_COST_USD）`);
      }
      console.log("");

      const result = await collect(db, {
        promptSetId: setId,
        phase,
        engines: activeEngines,
        runsPerPrompt: defaultRuns,
        runsByEngine: byEngine,
        concurrency,
        note: values.note as string | undefined,
        resumeRunId: values.resume as string | undefined,
        onProgress: (done, total, label) => {
          if (done % 10 === 0 || done === total) {
            process.stdout.write(`\r  ${done}/${total}  ${label.padEnd(50).slice(0, 50)}`);
          }
        },
      });

      console.log(
        `\n\n采集${result.tripped ? "被断路器终止" : "完成"}：run ${result.runId}，` +
          `本次新增 ${result.completed} 条` +
          (result.alreadyDone ? `（续跑，已有 ${result.alreadyDone} 条）` : "") +
          `，累计 ${result.alreadyDone + result.completed}/${result.total}，` +
          `本次成本 ≈ $${result.spentUsd.toFixed(2)}`,
      );
      if (result.alreadyDone + result.completed < result.total) {
        console.log(`   续跑补齐：--resume ${result.runId}`);
      }
      if (result.tripped) {
        console.log(
          `⚠️  已达预算上限（COLLECT_MAX_COST_USD）。已入账的观测有效；` +
            `该轮次保持未封存，提高预算后必须用上方 --resume 和完全相同的配置补齐。`,
        );
      }
      if (result.skippedEngines.length) {
        console.log(
          `⚠️  引擎熔断（连续报错 ≥ COLLECT_ENGINE_ERROR_TRIP 次，剩余任务已跳过）：` +
            `${result.skippedEngines.join(", ")}。修好配额/密钥后可单独补跑：--engines ${result.skippedEngines.join(",")}`,
        );
      }
      break;
    }

    case "runs": {
      const setId = required(values.set as string | undefined, "--set");
      const rows = listRuns(db, setId);
      if (!rows.length) {
        console.log("该 prompt 集还没有采集轮次");
        break;
      }
      console.log("run                                   phase     N   观测   成本      状态");
      console.log("-".repeat(78));
      for (const row of rows) {
        console.log(
          `${row.id}  ${row.phase.padEnd(9)} ${String(row.runs_per_prompt).padStart(2)}  ` +
            `${String(row.observations).padStart(5)}  $${row.cost_usd.toFixed(2).padStart(6)}  ` +
            `${row.finished_at ? "已完成" : "未完成（可 --resume）"}`,
        );
        // 分引擎配置单独一行 —— 不同 N 的轮次不能直接比引用率
        if (row.runs_config && row.runs_config !== String(row.runs_per_prompt)) {
          console.log(`${" ".repeat(38)}采样配置：${row.runs_config}`);
        }
      }
      break;
    }

    case "report:attribution": {
      const setId = required(values.set as string | undefined, "--set");
      const set = getPromptSet(db, setId);
      if (!set.frozen_at) {
        console.log("⚠️  该 prompt 集尚未冻结，报告仅供内部探索，不可对外。\n");
      }
      console.log(
        renderAttributionReport(
          buildAttributionReport(db, setId, {
            parserVersion: required(
              values["parser-version"] as string | undefined,
              "--parser-version",
            ),
            runIds: splitList(values.run as string | undefined),
            excludeEngines: splitList(values.exclude as string | undefined),
          }),
        ),
      );
      break;
    }

    case "discover": {
      const seeds = splitList(values.seeds as string | undefined);
      const fromLedger = Boolean(values["from-ledger"]);
      if (!seeds.length && !fromLedger) {
        console.error(
          '需要 --seeds "关键词1,关键词2"（3~8 个品类种子词，不要用长问句）\n' +
            "或 --from-ledger（零成本：从台账已有的 SERP 响应里提取）",
        );
        process.exit(1);
      }
      const out = (values.out as string | undefined) ?? "prompts-candidates.txt";
      const mustInclude = splitList(values.filter as string | undefined);
      const aliases = splitList(values.aliases as string | undefined);

      let result;
      if (fromLedger) {
        console.log("从台账已有的 SERP 原始响应提取（不发新请求）\n");
        result = discoverFromLedger(db, {
          mustInclude,
          brandAliases: aliases,
          runIds: splitList(values.run as string | undefined),
        });
      } else {
        console.log(`发现中：${seeds.length} 个种子词 → Google PAA + 相关搜索\n`);
        result = await discover(seeds, { mustInclude, brandAliases: aliases });
      }

      writeFileSync(out, renderCandidateFile(result, seeds.join(", ")), "utf8");
      console.log(`候选 prompt：${result.candidates.length} 条 → ${out}`);

      if (result.forums.length) {
        const forumOut = out.replace(/\.txt$/, "") + "-forums.md";
        writeFileSync(forumOut, renderForumFile(result), "utf8");
        console.log(`社区讨论线索：${result.forums.length} 条 → ${forumOut}`);
      }

      console.log(`成本：$${result.costUsd.toFixed(4)}`);
      if (result.errors.length) {
        console.log(`\n失败的种子词：`);
        for (const error of result.errors) console.log(`  ${error}`);
      }
      console.log(`\n⚠️  这是候选池，人工审核删改后再 prompts:add。冻结后不可增删。`);
      break;
    }

    case "cost": {
      const setId = values.set as string | undefined;
      const runIds = splitList(values.run as string | undefined);
      const stats = analyzeCost(db, runIds);
      if (!stats.length) {
        console.log("还没有观测数据");
        break;
      }

      let plan;
      if (setId) {
        const promptCount = listPrompts(db, setId).length;
        const { defaultRuns, byEngine } = parseRuns(values.runs as string | undefined, 10);
        const est = estimateRun(stats, promptCount, byEngine, defaultRuns);
        plan = { ...est, promptCount };
      }

      console.log(renderCostReport(stats, plan));
      break;
    }

    case "power": {
      const result = simulatePromptLevelPower({
        effect: Number.parseFloat(required(values.effect as string | undefined, "--effect")),
        promptDeltaSd: Number.parseFloat(required(values.sd as string | undefined, "--sd")),
        alpha: Number.parseFloat((values.alpha as string | undefined) ?? "0.05"),
        targetPower: Number.parseFloat(
          (values["target-power"] as string | undefined) ?? "0.8",
        ),
        minPromptsPerArm: Number.parseInt(
          (values["min-prompts"] as string | undefined) ?? "8",
          10,
        ),
        maxPromptsPerArm: Number.parseInt(
          (values["max-prompts"] as string | undefined) ?? "50",
          10,
        ),
        step: Number.parseInt((values.step as string | undefined) ?? "2", 10),
        simulations: Number.parseInt(
          (values.simulations as string | undefined) ?? "500",
          10,
        ),
        randomizationIterations: Number.parseInt(
          (values.iterations as string | undefined) ?? "1000",
          10,
        ),
        seed: (values.seed as string | undefined) ?? randomUUID(),
      });
      console.log(renderPowerSimulation(result));
      break;
    }

    case "experiment:status": {
      const result = inspectExperimentReadiness(db, {
        promptSetId: required(values.set as string | undefined, "--set"),
        parserVersion: required(
          values["parser-version"] as string | undefined,
          "--parser-version",
        ),
        manifestHash: values["manifest-hash"] as string | undefined,
      });
      console.log(values.json ? JSON.stringify(result, null, 2) : renderExperimentReadiness(result));
      const requiredStage = values.require as ReadinessStage | undefined;
      if (requiredStage) {
        if (!["baseline", "intervention", "analysis"].includes(requiredStage)) {
          throw new Error("--require 只能是 baseline、intervention 或 analysis");
        }
        if (!result.stages[requiredStage]) process.exitCode = 2;
      }
      break;
    }

    case "assign": {
      const setId = required(values.set as string | undefined, "--set");
      const seed = (values.seed as string | undefined) ?? randomUUID();
      const baselines = readBaselines(db, setId, {
        parserVersion: required(
          values["parser-version"] as string | undefined,
          "--parser-version",
        ),
        runIds: splitList(values.run as string | undefined),
        excludeEngines: splitList(values.exclude as string | undefined),
      });
      const result = stratifiedAssign(baselines, seed);

      console.log(renderAssignReport(result));

      if (values["dry-run"]) {
        console.log("\n（--dry-run：未写入台账。去掉该参数后写入，写入后不可更改）");
        break;
      }
      const count = persistAssignments(db, setId, result);
      console.log(`\n已写入 ${count} 条分组记录。分组不可修改或删除。`);
      break;
    }

    case "manifest:create": {
      const setId = required(values.set as string | undefined, "--set");
      const file = required(values.file as string | undefined, "--file");
      const plan = JSON.parse(readFileSync(file, "utf8")) as Omit<ManifestPlan, "promptSetId">;
      const record = createExperimentManifest(db, { ...plan, promptSetId: setId });
      console.log(`manifest 已锁定：${record.contentHash}`);
      console.log(`schema：${record.schemaVersion}`);
      console.log("下一步：先把 hash 通过 email/contract/RFC3161/OpenTimestamps 外部留痕，再执行 manifest:anchor。");
      console.log("GitHub commit 可并行佐证源码版本，但不能单独证明本地 SQLite 台账未被替换。");
      break;
    }

    case "manifest:anchor": {
      const manifestHash = required(values.hash as string | undefined, "--hash");
      const type = required(values.type as string | undefined, "--type") as ManifestAnchorType;
      const id = recordManifestAnchor(db, {
        manifestHash,
        type,
        reference: required(values.ref as string | undefined, "--ref"),
        anchoredAt: (values.at as string | undefined) ?? new Date().toISOString(),
      });
      console.log(`外部锚点已登记：${id}`);
      if (type === "github_commit" || type === "other") {
        console.log("⚠️  该类型不是强锚点，不能单独解锁预注册。");
      }
      break;
    }

    case "manifest:show": {
      const manifest = getManifest(db, required(values.hash as string | undefined, "--hash"));
      if (!manifest) console.log("manifest 不存在");
      else console.log(manifest.canonicalJson);
      break;
    }

    case "preregister": {
      const setId = required(values.set as string | undefined, "--set");
      const record = registerPrereg(db, {
        promptSetId: setId,
        manifestHash: required(
          values["manifest-hash"] as string | undefined,
          "--manifest-hash",
        ),
      });
      console.log(renderPrereg(record));
      break;
    }

    case "prereg:show": {
      const setId = required(values.set as string | undefined, "--set");
      const record = getPrereg(db, setId);
      if (!record) {
        console.log("该 prompt 集尚无预注册记录");
        break;
      }
      console.log(renderPrereg(record));
      break;
    }

    case "intervention:add": {
      const setId = required(values.set as string | undefined, "--set");
      const id = recordIntervention(db, {
        promptSetId: setId,
        url: values.url as string | undefined,
        assetType: required(values.type as string | undefined, "--type"),
        publishedAt:
          (values.date as string | undefined) ?? new Date().toISOString().slice(0, 10),
        targetPromptIds: splitList(values.targets as string | undefined),
        note: values.note as string | undefined,
      });
      console.log(`干预已登记：${id}`);
      break;
    }

    case "change:add": {
      const setId = required(values.set as string | undefined, "--set");
      const id = recordClientChange(db, {
        promptSetId: setId,
        occurredAt:
          (values.date as string | undefined) ?? new Date().toISOString().slice(0, 10),
        kind: required(values.type as string | undefined, "--type"),
        description: required(values.note as string | undefined, "--note"),
        reportedBy: values.by as string | undefined,
      });
      console.log(`客户侧变更已登记：${id}`);
      console.log("（不确定有没有影响的也要记 —— 那本身就是报告里要披露的部分）");
      break;
    }

    case "report:did": {
      const setId = required(values.set as string | undefined, "--set");
      const preRuns = splitList(values.pre as string | undefined);
      const postRuns = splitList(values.post as string | undefined);
      if (!preRuns.length || !postRuns.length) {
        console.error('需要 --pre "<基线runId,...>" 和 --post "<干预后runId,...>"');
        console.error("用 npm run lab -- runs --set <id> 查看可用轮次");
        process.exit(1);
      }
      console.log(
        renderDidReport(
          buildDidReport(db, setId, {
            parserVersion: required(
              values["parser-version"] as string | undefined,
              "--parser-version",
            ),
            preRuns,
            postRuns,
            excludeEngines: splitList(values.exclude as string | undefined),
            includeEngines: splitList(values.engines as string | undefined),
            randomizationIterations: Number.parseInt(
              (values.iterations as string | undefined) ?? "20000",
              10,
            ),
          }),
        ),
      );
      break;
    }

    case "backfill": {
      const result = backfillInterpretations(db);
      console.log(
        `总观测 ${result.totalObservations}；扫描 ${result.scanned} 条待解释观测，` +
          `写入 ${result.written}，已有 ${result.skipped}`,
      );
      console.log(`覆盖校验：${result.covered}/${result.totalObservations}`);
      console.log(`parser 版本：${PARSER_VERSION}`);
      console.log("\n提取状态分布：");
      for (const [status, n] of Object.entries(result.byStatus).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${status.padEnd(22)} ${n}`);
      }
      console.log(
        `\n其中 ${result.withUpstreamRetrieval} 条有上游明确报告的检索状态` +
          `（其余靠降级推断，报告里需说明）`,
      );
      break;
    }

    case "opportunity": {
      const setId = required(values.set as string | undefined, "--set");
      const rows = buildOpportunity(db, setId, {
        parserVersion: required(
          values["parser-version"] as string | undefined,
          "--parser-version",
        ),
        runIds: splitList(values.run as string | undefined),
        engines: splitList(values.engines as string | undefined),
        excludeEngines: splitList(values.exclude as string | undefined),
      });
      if (!rows.length) {
        console.log("没有可评分的 prompt —— 先跑一轮采集（N=3 即可）");
        break;
      }
      console.log(renderOpportunity(rows));
      break;
    }

    case "report:prompts": {
      const setId = required(values.set as string | undefined, "--set");
      console.log(
        renderPromptsReport(
          buildPromptsReport(db, setId, {
            parserVersion: required(
              values["parser-version"] as string | undefined,
              "--parser-version",
            ),
            runIds: splitList(values.run as string | undefined),
            excludeEngines: splitList(values.exclude as string | undefined),
          }),
        ),
      );
      break;
    }

    case "report:default": {
      const configPath =
        (values.file as string | undefined) ??
        required(undefined, "--file: provide your own sealed report configuration");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        schema_version?: string;
        expected_brand?: string;
        prompt_set_id?: string;
        run_ids?: string[];
        parser_version?: string;
        subtitle?: string;
        output?: string;
      };
      if (config.schema_version !== "geo-proof-default-showcase-v1") {
        throw new Error(`默认展示配置 schema 无效：${configPath}`);
      }
      const setId = required(config.prompt_set_id, "prompt_set_id");
      const runIds = config.run_ids?.filter(Boolean) ?? [];
      if (!runIds.length) throw new Error("默认展示配置必须固定至少一个 run id");
      const set = getPromptSet(db, setId);
      const brand = getBrand(db, set.brand_id);
      if (brand.name !== config.expected_brand) {
        throw new Error(
          `报告品牌须与配置匹配；配置期望 ${config.expected_brand ?? "missing"}，` +
            `台账实际 ${brand.name}`,
        );
      }
      const out = config.output ?? "reports/default.html";
      writeFileSync(
        out,
        buildHtmlReport(db, setId, {
          parserVersion: required(config.parser_version, "parser_version"),
          runIds,
          subtitle:
            config.subtitle ??
            "Saved evidence report · descriptive-only",
          promptSetHash: set.frozen_hash,
        }),
        "utf8",
      );
      const verified = verifyReportFileAgainstLedger(db, out);
      console.log(`默认展示已生成：${out}`);
      console.log(`品牌：${brand.name}；run：${verified.runIds.join(",")}`);
      console.log(`台账证据指纹：${verified.ledgerEvidenceSha256}`);
      console.log("状态：descriptive-only；不是当前排名、流量、转化或因果证明。");
      break;
    }

    case "report:check": {
      const file = required(values.file as string | undefined, "--file");
      const result = verifyReportFileAgainstLedger(db, file);
      console.log("报告门禁与台账复算通过：可按 descriptive-only 边界进入人工发布审批。");
      console.log(`复算检查：${result.checks.join(", ")}`);
      console.log(`台账证据指纹：${result.ledgerEvidenceSha256}`);
      console.log("注意：这些检查不证明上游响应真实性。");
      break;
    }

    case "publish": {
      const file = required(values.file as string | undefined, "--file");
      // 先检查再创建任何站点文件，避免被门禁拦截的报告产生发布副作用。
      verifyReportFileAgainstLedger(db, file);
      const created = ensureSiteScaffold();
      if (created.length) {
        console.log("已创建站点骨架：");
        for (const path of created) console.log(`  ${path}`);
        console.log("");
      }

      const result = publishReport(file, {
        slug: values.slug as string | undefined,
        baseUrl: values.baseUrl as string | undefined,
      });

      console.log(`已发布：${result.path}`);
      console.log(`链接：  ${result.url}`);
      if (!result.url.startsWith("http")) {
        console.log(`\n设置 PUBLISH_BASE_URL 后会直接输出完整 URL。`);
      }
      console.log(`\n部署：cd site && vercel --prod`);
      break;
    }

    case "report:landscape": {
      const setId = required(values.set as string | undefined, "--set");
      const vendors = splitList(values.vendors as string | undefined);
      if (!vendors.length) {
        console.error(
          '需要 --vendors "a.com,b.com,..."（视为厂商的域名；其余归入「其他来源」）\n' +
            "提示：先跑 report:attribution 看 TOP 域名表，从里面挑厂商域名",
        );
        process.exit(1);
      }
      const set = getPromptSet(db, setId);
      const out =
        (values.out as string | undefined) ?? `reports/landscape-${setId.slice(0, 8)}.html`;

      const report = buildLandscape(db, setId, {
        parserVersion: required(
          values["parser-version"] as string | undefined,
          "--parser-version",
        ),
        vendorDomains: vendors,
        targetDomains: splitList(values.target as string | undefined),
        category: (values.category as string | undefined) ?? "AI Citation Landscape",
        runIds: splitList(values.run as string | undefined),
        excludeEngines: splitList(values.exclude as string | undefined),
      });

      writeFileSync(
        out,
        renderLandscapeHtml(report, {
          promptSetHash: set.frozen_hash,
          date: new Date().toISOString().slice(0, 10),
          publisher: values.publisher as string | undefined,
        }),
        "utf8",
      );

      console.log(`品类榜单已生成：${out}`);
      console.log(
            `${report.vendors.length} 家厂商，${report.usableObservations} 条成功观测，` +
          `${report.totalCitations} 条引用`,
      );
      console.log("\n榜单（前 10）：");
      for (const vendor of report.vendors.slice(0, 10)) {
        console.log(
          `  ${String(vendor.rank).padStart(2)}. ${vendor.domain.padEnd(26)}` +
            `${(vendor.shareOfAnswers * 100).toFixed(1).padStart(5)}%  ` +
            `${vendor.citations} 次${vendor.isTarget ? "  ← 目标" : ""}`,
        );
      }
      break;
    }

    case "report:html": {
      const setId = required(values.set as string | undefined, "--set");
      const set = getPromptSet(db, setId);
      const out = (values.out as string | undefined) ?? `reports/report-${setId.slice(0, 8)}.html`;

      const html = buildHtmlReport(db, setId, {
        parserVersion: required(
          values["parser-version"] as string | undefined,
          "--parser-version",
        ),
        runIds: splitList(values.run as string | undefined),
        excludeEngines: splitList(values.exclude as string | undefined),
        subtitle: (values.note as string | undefined) ?? `基线快照 · ${new Date().toISOString().slice(0, 10)}`,
        promptSetHash: set.frozen_hash,
      });

      writeFileSync(out, html, "utf8");
      console.log(`HTML 报告已生成：${out}`);
      break;
    }

    default:
      console.error(`未知命令：${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
