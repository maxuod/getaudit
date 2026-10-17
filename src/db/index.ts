import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireWriterLock } from "./writer-lock.ts";

/**
 * 用 Node 内置的 node:sqlite，不是 better-sqlite3。
 *
 * 理由：零原生依赖。这个项目要在你的机器、客户现场、CI 上都能一条命令跑起来，
 * 而 better-sqlite3 每换一个平台就要重编译一次。台账工具的可靠性优先于生态便利。
 */
export type Ledger = DatabaseSync;

const HERE = dirname(fileURLToPath(import.meta.url));

let cached: Ledger | null = null;
let cachedPath: string | null = null;
let releaseWriter: (() => void) | null = null;

/**
 * 打开台账。schema 幂等，每次打开都重放一遍，
 * 保证不可变触发器始终存在 —— 即使有人手动动过库文件。
 */
export function openLedger(path?: string): Ledger {
  const target = resolve(path ?? process.env.LEDGER_PATH ?? "./data/ledger.db");
  if (cached) {
    if (target !== cachedPath) throw new Error("已有台账连接；请先关闭，再切换数据库");
    return cached;
  }
  mkdirSync(dirname(target), { recursive: true });
  releaseWriter = acquireWriterLock(target);
  try { cached = connectLedger(target); }
  catch (error) { releaseWriter(); releaseWriter = null; throw error; }
  cachedPath = target;
  return cached;
}

/** Explicit connection for a service that owns its lifetime. Never changes the CLI cache. */
export function connectLedger(target: string): Ledger {
  mkdirSync(dirname(target), { recursive: true });

  const db = new DatabaseSync(target);
  const schema = readFileSync(resolve(HERE, "schema.sql"), "utf8");
  db.exec(schema);
  migrate(db);

  return db;
}

/**
 * 增量迁移。schema.sql 的 CREATE TABLE IF NOT EXISTS 只对新库生效，
 * 已有的台账要在这里补列。只允许加列（append-only 精神同样适用于 schema）：
 * 改列/删列都等于篡改历史观测的语义。
 */
function migrate(db: DatabaseSync): void {
  const observationColumns = db
    .prepare(`SELECT name FROM pragma_table_info('observation')`)
    .all() as Array<{ name: string }>;

  if (!observationColumns.some((column) => column.name === "cost_usd")) {
    db.exec(`ALTER TABLE observation ADD COLUMN cost_usd REAL`);
  }

  const runColumns = db
    .prepare(`SELECT name FROM pragma_table_info('collection_run')`)
    .all() as Array<{ name: string }>;

  // runs_per_prompt 是单一整数，表达不了分引擎采样（"default=0,perplexity=3"）。
  // 存完整配置字符串，否则台账里记录的实验条件是错的。
  if (!runColumns.some((column) => column.name === "runs_config")) {
    db.exec(`ALTER TABLE collection_run ADD COLUMN runs_config TEXT`);
  }
  // 直连引擎不报告成本，SUM(cost_usd) 会漏掉它们。
  // 采集时的累计花费（含兜底估算）直接存轮次上。
  if (!runColumns.some((column) => column.name === "spent_usd")) {
    db.exec(`ALTER TABLE collection_run ADD COLUMN spent_usd REAL`);
  }
  if (!runColumns.some((column) => column.name === "config_json")) {
    db.exec(`ALTER TABLE collection_run ADD COLUMN config_json TEXT`);
  }
  if (!runColumns.some((column) => column.name === "config_hash")) {
    db.exec(`ALTER TABLE collection_run ADD COLUMN config_hash TEXT`);
  }

  // 分组算法版本：历史分组必须能用当初的算法复算，
  // 不记版本的话改进算法就等于让旧实验无法被第三方验证。
  const assignColumns = db
    .prepare(`SELECT name FROM pragma_table_info('assignment')`)
    .all() as Array<{ name: string }>;
  if (assignColumns.length && !assignColumns.some((c) => c.name === "algo_version")) {
    db.exec(`ALTER TABLE assignment ADD COLUMN algo_version TEXT`);
  }

  const preregColumns = db
    .prepare(`SELECT name FROM pragma_table_info('preregistration')`)
    .all() as Array<{ name: string }>;
  if (preregColumns.length && !preregColumns.some((c) => c.name === "manifest_hash")) {
    db.exec(`ALTER TABLE preregistration ADD COLUMN manifest_hash TEXT`);
  }

  installCurrentGuards(db);
}

/**
 * 旧库已有同名 trigger 时 CREATE IF NOT EXISTS 不会升级定义，因此迁移后显式替换。
 * 这些都是约束增强，不修改任何历史行。
 */
function installCurrentGuards(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS run_conditions_immutable;
    CREATE TRIGGER run_conditions_immutable
    BEFORE UPDATE ON collection_run
    FOR EACH ROW
    WHEN NEW.prompt_set_id IS NOT OLD.prompt_set_id
      OR NEW.phase IS NOT OLD.phase
      OR NEW.runs_per_prompt IS NOT OLD.runs_per_prompt
      OR NEW.runs_config IS NOT OLD.runs_config
      OR NEW.config_json IS NOT OLD.config_json
      OR NEW.config_hash IS NOT OLD.config_hash
      OR NEW.started_at IS NOT OLD.started_at
      OR (OLD.finished_at IS NOT NULL AND NEW.finished_at IS NOT OLD.finished_at)
    BEGIN
      SELECT RAISE(ABORT, '轮次的实验条件不可修改');
    END;

    DROP TRIGGER IF EXISTS prereg_requires_manifest_anchor;
    CREATE TRIGGER prereg_requires_manifest_anchor
    BEFORE INSERT ON preregistration
    FOR EACH ROW
    WHEN NEW.manifest_hash IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM experiment_manifest m
         WHERE m.prompt_set_id = NEW.prompt_set_id
           AND m.content_hash = NEW.manifest_hash
      )
      OR NOT EXISTS (
        SELECT 1 FROM manifest_anchor a
         WHERE a.manifest_hash = NEW.manifest_hash
           AND a.anchor_type IN ('email', 'contract', 'rfc3161', 'opentimestamps')
      )
    BEGIN
      SELECT RAISE(ABORT, '预注册需要匹配且已外部锚定的实验 manifest；GitHub commit 不能单独充当强锚点');
    END;

    DROP TRIGGER IF EXISTS prereg_before_intervention_or_followup;
    CREATE TRIGGER prereg_before_intervention_or_followup
    BEFORE INSERT ON preregistration
    FOR EACH ROW
    WHEN EXISTS (
      SELECT 1 FROM intervention i WHERE i.prompt_set_id = NEW.prompt_set_id
    ) OR EXISTS (
      SELECT 1 FROM collection_run r
       WHERE r.prompt_set_id = NEW.prompt_set_id AND r.phase = 'followup'
    )
    BEGIN
      SELECT RAISE(ABORT, '已有干预或 follow-up，不能事后补预注册');
    END;

    DROP TRIGGER IF EXISTS followup_requires_prereg;
    CREATE TRIGGER followup_requires_prereg
    BEFORE INSERT ON collection_run
    FOR EACH ROW
    WHEN NEW.phase = 'followup' AND NOT EXISTS (
      SELECT 1 FROM preregistration p WHERE p.prompt_set_id = NEW.prompt_set_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'follow-up 采集前必须完成有外部锚定的预注册');
    END;

    DROP TRIGGER IF EXISTS followup_requires_intervention;
    CREATE TRIGGER followup_requires_intervention
    BEFORE INSERT ON collection_run
    FOR EACH ROW
    WHEN NEW.phase = 'followup' AND NOT EXISTS (
      SELECT 1 FROM intervention i WHERE i.prompt_set_id = NEW.prompt_set_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'follow-up 采集前必须登记干预');
    END;

    DROP TRIGGER IF EXISTS followup_after_all_interventions;
    CREATE TRIGGER followup_after_all_interventions
    BEFORE INSERT ON collection_run
    FOR EACH ROW
    WHEN NEW.phase = 'followup' AND EXISTS (
      SELECT 1 FROM intervention i
       WHERE i.prompt_set_id = NEW.prompt_set_id AND date(i.published_at) > date('now')
    )
    BEGIN
      SELECT RAISE(ABORT, 'follow-up 不能早于已登记干预的发布日期');
    END;

    DROP TRIGGER IF EXISTS intervention_before_followup;
    CREATE TRIGGER intervention_before_followup
    BEFORE INSERT ON intervention
    FOR EACH ROW
    WHEN EXISTS (
      SELECT 1 FROM collection_run r
       WHERE r.prompt_set_id = NEW.prompt_set_id AND r.phase = 'followup'
    )
    BEGIN
      SELECT RAISE(ABORT, '已有 follow-up，不能事后补写干预');
    END;

    DROP TRIGGER IF EXISTS intervention_not_before_prereg;
    CREATE TRIGGER intervention_not_before_prereg
    BEFORE INSERT ON intervention
    FOR EACH ROW
    WHEN date(NEW.published_at) IS NULL OR date(NEW.published_at) < date(
      (SELECT registered_at FROM preregistration p WHERE p.prompt_set_id = NEW.prompt_set_id)
    )
    BEGIN
      SELECT RAISE(ABORT, '干预日期不能早于预注册');
    END;

    DROP TRIGGER IF EXISTS observation_run_prompt_same_set;
    CREATE TRIGGER observation_run_prompt_same_set
    BEFORE INSERT ON observation
    FOR EACH ROW
    WHEN (SELECT prompt_set_id FROM collection_run WHERE id = NEW.run_id)
       IS NOT (SELECT prompt_set_id FROM prompt WHERE id = NEW.prompt_id)
    BEGIN
      SELECT RAISE(ABORT, '观测的 run 与 prompt 必须属于同一 prompt 集');
    END;

    DROP TRIGGER IF EXISTS manifest_before_intervention_or_followup;
    CREATE TRIGGER manifest_before_intervention_or_followup
    BEFORE INSERT ON experiment_manifest
    FOR EACH ROW
    WHEN EXISTS (
      SELECT 1 FROM intervention i WHERE i.prompt_set_id = NEW.prompt_set_id
    ) OR EXISTS (
      SELECT 1 FROM collection_run r
       WHERE r.prompt_set_id = NEW.prompt_set_id AND r.phase = 'followup'
    )
    BEGIN
      SELECT RAISE(ABORT, '已有干预或 follow-up，不能事后创建实验 manifest');
    END;
  `);
}

export function closeLedger(): void {
  try {
    cached?.close();
  } catch {
    // 已关闭
  }
  cached = null;
  cachedPath = null;
  releaseWriter?.();
  releaseWriter = null;
}

/**
 * 事务助手。node:sqlite 没有 better-sqlite3 的 .transaction() 包装，
 * 这里手写一个：任何异常都回滚，避免留下半截记录。
 */
export function inTransaction<T>(db: Ledger, fn: () => T): T {
  // SAVEPOINT composes with repository methods inside a larger atomic command.
  const name = `lab_${++transactionSequence}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    } catch {
      // 回滚失败时保留原始异常
    }
    throw error;
  }
}
let transactionSequence = 0;

/** JSON 列的读写助手 —— 台账里所有数组列都以 JSON 文本存储。 */
export function readJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function writeJsonArray(values: readonly string[]): string {
  return JSON.stringify([...values]);
}
