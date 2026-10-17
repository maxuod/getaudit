-- geo-proof-lab 实验台账
--
-- 设计原则：这是一本实验记录，不是应用状态。
-- 观测一旦写入永不修改；prompt 集合一旦冻结永不增删。
-- 这些约束写在数据库层而不是应用层，因为半年后改代码的是你自己，
-- 而那时你已经忘了为什么不能改。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 品牌 / 客户
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- 自有域名（JSON 数组）。引用面归属分析据此区分「自有 vs 第三方」。
  owned_domains TEXT NOT NULL DEFAULT '[]',
  -- 品牌名的匹配别名（JSON 数组），用于正文提及检测
  aliases       TEXT NOT NULL DEFAULT '[]',
  category      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Prompt 集合：可冻结对象
--
-- frozen_at 一旦写入，成员不可再增删，且 frozen_hash 固定。
-- 这是整套因果论证的地基：如果 prompt 集能被事后编辑，
-- 任何「干预组涨了」的结论都可以被质疑为事后挑选。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_set (
  id           TEXT PRIMARY KEY,
  brand_id     TEXT NOT NULL REFERENCES brand(id),
  label        TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  frozen_at    TEXT,
  -- 冻结时对全部成员 prompt 文本排序后计算的 sha256
  frozen_hash  TEXT,
  CHECK ((frozen_at IS NULL) = (frozen_hash IS NULL))
);

CREATE TABLE IF NOT EXISTS prompt (
  id            TEXT PRIMARY KEY,
  prompt_set_id TEXT NOT NULL REFERENCES prompt_set(id),
  text          TEXT NOT NULL,
  -- 引用面归属预判：owned / third_party / unknown（前置实验会用实测覆盖它）
  surface_guess TEXT NOT NULL DEFAULT 'unknown',
  intent        TEXT,
  locale        TEXT NOT NULL DEFAULT 'en-US',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (prompt_set_id, text)
);

-- 冻结后禁止新增成员
CREATE TRIGGER IF NOT EXISTS prompt_no_insert_after_freeze
BEFORE INSERT ON prompt
FOR EACH ROW
WHEN (SELECT frozen_at FROM prompt_set WHERE id = NEW.prompt_set_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'prompt_set 已冻结：不能新增 prompt');
END;

-- 冻结后禁止修改
CREATE TRIGGER IF NOT EXISTS prompt_no_update_after_freeze
BEFORE UPDATE ON prompt
FOR EACH ROW
WHEN (SELECT frozen_at FROM prompt_set WHERE id = OLD.prompt_set_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'prompt_set 已冻结：不能修改 prompt');
END;

-- 冻结后禁止删除
CREATE TRIGGER IF NOT EXISTS prompt_no_delete_after_freeze
BEFORE DELETE ON prompt
FOR EACH ROW
WHEN (SELECT frozen_at FROM prompt_set WHERE id = OLD.prompt_set_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'prompt_set 已冻结：不能删除 prompt');
END;

-- 冻结不可撤销
CREATE TRIGGER IF NOT EXISTS prompt_set_freeze_is_final
BEFORE UPDATE ON prompt_set
FOR EACH ROW
WHEN OLD.frozen_at IS NOT NULL
  AND (NEW.frozen_at IS NOT OLD.frozen_at OR NEW.frozen_hash IS NOT OLD.frozen_hash)
BEGIN
  SELECT RAISE(ABORT, 'prompt_set 冻结不可撤销或篡改');
END;

-- ---------------------------------------------------------------------------
-- 分组：干预组 / 对照组
--
-- 存 rng_seed 使分组可复现、可审计。
-- 客户或第三方拿到 seed 和 stratum 就能重算出同一套分组。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignment (
  prompt_id     TEXT PRIMARY KEY REFERENCES prompt(id),
  prompt_set_id TEXT NOT NULL REFERENCES prompt_set(id),
  arm           TEXT NOT NULL CHECK (arm IN ('treatment', 'control')),
  -- 配对层：按基线引用率分层后再随机，避免选择偏差
  stratum       TEXT NOT NULL,
  rng_seed      TEXT NOT NULL,
  assigned_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS assignment_immutable_update
BEFORE UPDATE ON assignment
BEGIN
  SELECT RAISE(ABORT, '分组不可修改：重新分组等于推翻实验');
END;

CREATE TRIGGER IF NOT EXISTS assignment_immutable_delete
BEFORE DELETE ON assignment
BEGIN
  SELECT RAISE(ABORT, '分组不可删除');
END;

-- ---------------------------------------------------------------------------
-- 采集轮次
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_run (
  id            TEXT PRIMARY KEY,
  prompt_set_id TEXT NOT NULL REFERENCES prompt_set(id),
  -- baseline（干预前）/ followup（干预后）
  phase         TEXT NOT NULL CHECK (phase IN ('baseline', 'followup')),
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  runs_per_prompt INTEGER NOT NULL,
  runs_config   TEXT,
  -- canonical JSON + sha256：包括引擎、模型、端点、地域策略、locale 和采样密度
  config_json   TEXT,
  config_hash   TEXT,
  spent_usd     REAL,
  note          TEXT
);

-- ---------------------------------------------------------------------------
-- 观测：append-only，这是全部证据
--
-- fidelity 是旧采集兼容字段：
--   web_grounded  适配器在采集时观察到实时引用
--   weights_only  适配器在采集时没有观察到实时引用
--   error         采集失败
-- 正式分析不得把它同时当成 retrieval/surface/citation；这些语义由
-- versioned observation_interpretation 分开记录，主分母为全部成功调用。
-- provenance 记录这条观测是怎么取到的（哪个 API、哪个端点）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observation (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES collection_run(id),
  prompt_id      TEXT NOT NULL REFERENCES prompt(id),
  engine         TEXT NOT NULL,
  run_idx        INTEGER NOT NULL,
  observed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  provenance     TEXT NOT NULL,
  fidelity       TEXT NOT NULL CHECK (fidelity IN ('web_grounded', 'weights_only', 'error')),
  model_version  TEXT,
  locale         TEXT,
  -- 原始响应全文。永远保留：任何聚合都可以从它重算
  raw_response   TEXT,
  answer_text    TEXT,
  -- 品牌名是否在正文出现（提及 ≠ 引用，两者分开统计）
  brand_mentioned INTEGER NOT NULL DEFAULT 0 CHECK (brand_mentioned IN (0, 1)),
  -- 这次调用的美元成本。DataForSEO 报告精确值；直连引擎为 NULL（断路器用估算兜底）
  cost_usd       REAL,
  error_message  TEXT,
  UNIQUE (run_id, prompt_id, engine, run_idx)
);

CREATE INDEX IF NOT EXISTS observation_by_prompt
  ON observation (prompt_id, engine, observed_at);
CREATE INDEX IF NOT EXISTS observation_by_run
  ON observation (run_id, engine);

CREATE TRIGGER IF NOT EXISTS observation_immutable_update
BEFORE UPDATE ON observation
BEGIN
  SELECT RAISE(ABORT, '观测不可修改：台账是 append-only');
END;

CREATE TRIGGER IF NOT EXISTS observation_immutable_delete
BEFORE DELETE ON observation
BEGIN
  SELECT RAISE(ABORT, '观测不可删除：台账是 append-only');
END;

CREATE TRIGGER IF NOT EXISTS observation_run_prompt_same_set
BEFORE INSERT ON observation
FOR EACH ROW
WHEN (SELECT prompt_set_id FROM collection_run WHERE id = NEW.run_id)
   IS NOT (SELECT prompt_set_id FROM prompt WHERE id = NEW.prompt_id)
BEGIN
  SELECT RAISE(ABORT, '观测的 run 与 prompt 必须属于同一 prompt 集');
END;

CREATE TRIGGER IF NOT EXISTS observation_no_insert_after_run_finish
BEFORE INSERT ON observation
FOR EACH ROW
WHEN (SELECT finished_at FROM collection_run WHERE id = NEW.run_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '轮次已封存：不能追加观测');
END;

-- ---------------------------------------------------------------------------
-- 观测表面上下文：网页证据的地域、账号和采集条件
--
-- 不能把“浏览器坐标设成美国”简写成“美国结果”：服务端常以出口 IP 定位，
-- 登录账号还会叠加历史和个性化。target/exit/location_status 分开保存，避免
-- 在报告阶段把未验证或错区的捕获误标为目标市场证据。
-- 不保存密码、cookie、完整 IP 或账号邮箱。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observation_surface_context (
  observation_id       TEXT PRIMARY KEY REFERENCES observation(id),
  surface_class        TEXT NOT NULL CHECK (
    surface_class IN ('api_model', 'consumer_web', 'serp_feature')
  ),
  provider             TEXT NOT NULL,
  product_surface      TEXT NOT NULL,
  collection_mode      TEXT NOT NULL CHECK (
    collection_mode IN ('api', 'manual_capture', 'managed_scraper', 'browser_automation')
  ),
  account_state        TEXT NOT NULL CHECK (
    account_state IN ('logged_out', 'logged_in', 'unknown')
  ),
  personalization_state TEXT NOT NULL CHECK (
    personalization_state IN ('fresh', 'active', 'disabled', 'unknown')
  ),
  search_mode          TEXT NOT NULL CHECK (
    search_mode IN ('natural', 'explicit_search', 'forced_search', 'unknown')
  ),
  target_country       TEXT NOT NULL CHECK (length(target_country) = 2),
  exit_country         TEXT CHECK (exit_country IS NULL OR length(exit_country) = 2),
  geo_verification     TEXT NOT NULL CHECK (
    geo_verification IN ('ip_observed', 'provider_asserted', 'unverified')
  ),
  location_status      TEXT NOT NULL CHECK (
    location_status IN ('matched', 'mismatched', 'unverified')
  ),
  browser_locale       TEXT NOT NULL,
  timezone_id          TEXT NOT NULL,
  geolocation_policy   TEXT NOT NULL CHECK (
    geolocation_policy IN ('denied', 'unavailable', 'city_emulated', 'real', 'unknown')
  ),
  device               TEXT NOT NULL CHECK (device IN ('desktop', 'mobile', 'tablet', 'unknown')),
  account_label        TEXT,
  evidence_sha256      TEXT NOT NULL UNIQUE CHECK (length(evidence_sha256) = 64),
  capture_reference    TEXT,
  recorded_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS surface_context_by_cohort
  ON observation_surface_context
    (product_surface, account_state, target_country, location_status);

CREATE TRIGGER IF NOT EXISTS surface_context_immutable_update
BEFORE UPDATE ON observation_surface_context
BEGIN
  SELECT RAISE(ABORT, '观测表面上下文不可修改');
END;

CREATE TRIGGER IF NOT EXISTS surface_context_immutable_delete
BEFORE DELETE ON observation_surface_context
BEGIN
  SELECT RAISE(ABORT, '观测表面上下文不可删除');
END;

CREATE TRIGGER IF NOT EXISTS surface_context_no_insert_after_run_finish
BEFORE INSERT ON observation_surface_context
FOR EACH ROW
WHEN (
  SELECT r.finished_at
    FROM observation o JOIN collection_run r ON r.id = o.run_id
   WHERE o.id = NEW.observation_id
) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '轮次已封存：不能追加观测表面上下文');
END;

-- ---------------------------------------------------------------------------
-- 捕获 artifact 校验：封存后追加“文件确实存在且内容匹配声明 SHA”的验证记录
--
-- observation_surface_context 的 evidence_sha256 证明证据包内部一致；它不证明引用的
-- 截图文件真的存在。这里保存本地逐文件复算结果，仍不把绝对路径或图片内容写入台账。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence_artifact_verification (
  observation_id              TEXT PRIMARY KEY REFERENCES observation(id),
  capture_reference           TEXT NOT NULL,
  artifact_sha256             TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  artifact_size_bytes         INTEGER NOT NULL CHECK (artifact_size_bytes >= 0),
  verifier_version            TEXT NOT NULL,
  verification_evidence_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(verification_evidence_sha256) = 64
  ),
  verified_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS artifact_verification_immutable_update
BEFORE UPDATE ON evidence_artifact_verification
BEGIN
  SELECT RAISE(ABORT, 'artifact 校验记录不可修改');
END;

CREATE TRIGGER IF NOT EXISTS artifact_verification_immutable_delete
BEFORE DELETE ON evidence_artifact_verification
BEGIN
  SELECT RAISE(ABORT, 'artifact 校验记录不可删除');
END;

-- ---------------------------------------------------------------------------
-- 观测解释：把「是否检索 / 表面是否展示 / 是否提取到引用」拆成三个正交事实
--
-- 为什么单独一张表而不是给 observation 加列：
-- 观测不可变，但「解释」会随 parser 改进而修正。
-- 版本化保存不同 parser 对同一条原始响应的解释，旧解释永不覆盖 ——
-- 这样历史报告仍可复现，同时新报告能用更准确的口径。
--
-- 这张表的存在源于一个真实错误：曾用 citations.length > 0 同时推断
-- 「联网了吗」和「引用了吗」，导致「Google 没展示 AI Overview」
-- 和「展示了但没引用我们」被合并，又被一起排除出分母 —— 条件选择偏差。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observation_interpretation (
  observation_id   TEXT NOT NULL REFERENCES observation(id),
  parser_version   TEXT NOT NULL,
  -- 上游明确报告发生了联网检索。NULL = 上游没提供该信息，不可断言
  retrieval_used   INTEGER CHECK (retrieval_used IN (0, 1)),
  -- 该表面是否出现（AIO 专用）。NULL = 不适用于该引擎
  surface_present  INTEGER CHECK (surface_present IN (0, 1)),
  extraction_status TEXT NOT NULL CHECK (
    extraction_status IN ('extracted', 'no_extraction', 'unrecoverable_legacy', 'not_applicable')
  ),
  derived_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (observation_id, parser_version)
);

CREATE INDEX IF NOT EXISTS interp_by_version
  ON observation_interpretation (parser_version, extraction_status);

CREATE TRIGGER IF NOT EXISTS interp_immutable_update
BEFORE UPDATE ON observation_interpretation
BEGIN
  SELECT RAISE(ABORT, '解释不可修改：parser 改进请写入新的 parser_version');
END;

CREATE TRIGGER IF NOT EXISTS interp_immutable_delete
BEFORE DELETE ON observation_interpretation
BEGIN
  SELECT RAISE(ABORT, '解释不可删除');
END;

-- ---------------------------------------------------------------------------
-- 引用：一条观测里出现的每个来源 URL
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS citation (
  id             TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES observation(id),
  position       INTEGER NOT NULL,
  url            TEXT NOT NULL,
  domain         TEXT NOT NULL,
  -- 归属：owned（客户自有域名）/ third_party
  ownership      TEXT NOT NULL CHECK (ownership IN ('owned', 'third_party')),
  title          TEXT,
  snippet        TEXT
);

CREATE INDEX IF NOT EXISTS citation_by_observation ON citation (observation_id);
CREATE INDEX IF NOT EXISTS citation_by_domain ON citation (domain);

CREATE TRIGGER IF NOT EXISTS citation_immutable_update
BEFORE UPDATE ON citation
BEGIN
  SELECT RAISE(ABORT, '引用记录不可修改');
END;

CREATE TRIGGER IF NOT EXISTS citation_immutable_delete
BEFORE DELETE ON citation
BEGIN
  SELECT RAISE(ABORT, '引用记录不可删除');
END;

CREATE TRIGGER IF NOT EXISTS citation_no_insert_after_run_finish
BEFORE INSERT ON citation
FOR EACH ROW
WHEN (
  SELECT r.finished_at
    FROM observation o JOIN collection_run r ON r.id = o.run_id
   WHERE o.id = NEW.observation_id
) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '轮次已封存：不能追加引用');
END;

-- ---------------------------------------------------------------------------
-- 干预：发布的资产
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intervention (
  id            TEXT PRIMARY KEY,
  prompt_set_id TEXT NOT NULL REFERENCES prompt_set(id),
  url           TEXT,
  asset_type    TEXT NOT NULL,
  published_at  TEXT NOT NULL,
  -- 目标 prompt（JSON 数组）。只允许指向 treatment 组，由应用层校验。
  target_prompt_ids TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS intervention_immutable_update
BEFORE UPDATE ON intervention
BEGIN
  SELECT RAISE(ABORT, '干预记录不可修改：改动等于事后重写实验时间线');
END;

CREATE TRIGGER IF NOT EXISTS intervention_immutable_delete
BEFORE DELETE ON intervention
BEGIN
  SELECT RAISE(ABORT, '干预记录不可删除');
END;

-- 干预必须有目标。空目标的干预无法归因，留着只会让报告看起来有据可依
CREATE TRIGGER IF NOT EXISTS intervention_requires_targets
BEFORE INSERT ON intervention
FOR EACH ROW
WHEN NEW.target_prompt_ids IS NULL OR TRIM(NEW.target_prompt_ids) IN ('', '[]')
BEGIN
  SELECT RAISE(ABORT, '干预必须指定目标 prompt —— 没有目标就无法归因');
END;

CREATE TRIGGER IF NOT EXISTS intervention_requires_prereg
BEFORE INSERT ON intervention
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM preregistration p WHERE p.prompt_set_id = NEW.prompt_set_id
)
BEGIN
  SELECT RAISE(ABORT, '必须先完成有外部锚定的预注册，才能登记干预');
END;

CREATE TRIGGER IF NOT EXISTS intervention_before_followup
BEFORE INSERT ON intervention
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM collection_run r
   WHERE r.prompt_set_id = NEW.prompt_set_id AND r.phase = 'followup'
)
BEGIN
  SELECT RAISE(ABORT, '已有 follow-up，不能事后补写干预');
END;

CREATE TRIGGER IF NOT EXISTS intervention_not_before_prereg
BEFORE INSERT ON intervention
FOR EACH ROW
WHEN date(NEW.published_at) IS NULL OR date(NEW.published_at) < date(
  (SELECT registered_at FROM preregistration p WHERE p.prompt_set_id = NEW.prompt_set_id)
)
BEGIN
  SELECT RAISE(ABORT, '干预日期不能早于预注册');
END;

-- ---------------------------------------------------------------------------
-- 客户侧变更登记：污染审计
--
-- 「未知/其他」也要记。实验期内客户做了什么你不知道的事，
-- 本身就是报告里必须披露的一部分。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_change (
  id            TEXT PRIMARY KEY,
  prompt_set_id TEXT NOT NULL REFERENCES prompt_set(id),
  occurred_at   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  description   TEXT NOT NULL,
  reported_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS client_change_immutable_update
BEFORE UPDATE ON client_change
BEGIN
  SELECT RAISE(ABORT, '客户变更登记不可修改：污染记录改了就失去披露意义');
END;

CREATE TRIGGER IF NOT EXISTS client_change_immutable_delete
BEFORE DELETE ON client_change
BEGIN
  SELECT RAISE(ABORT, '客户变更登记不可删除');
END;

-- 轮次的实验条件写入后不可改；只允许 finished_at 从 NULL 变为完成时间
CREATE TRIGGER IF NOT EXISTS run_conditions_immutable
BEFORE UPDATE ON collection_run
FOR EACH ROW
WHEN NEW.prompt_set_id IS NOT OLD.prompt_set_id
  OR NEW.phase IS NOT OLD.phase
  OR NEW.runs_per_prompt IS NOT OLD.runs_per_prompt
  OR NEW.started_at IS NOT OLD.started_at
  OR (OLD.finished_at IS NOT NULL AND NEW.finished_at IS NOT OLD.finished_at)
BEGIN
  SELECT RAISE(ABORT, '轮次的实验条件不可修改');
END;

-- ---------------------------------------------------------------------------
-- 预注册：干预前锁定的实验方案
--
-- 报告里那句「本方案在干预前已锁定，未做任何事后筛选」，
-- 靠的就是这张表 + prompt_set.frozen_hash。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS preregistration (
  id             TEXT PRIMARY KEY,
  prompt_set_id  TEXT NOT NULL REFERENCES prompt_set(id),
  registered_at  TEXT NOT NULL DEFAULT (datetime('now')),
  prompt_set_hash TEXT NOT NULL,
  primary_metric TEXT NOT NULL,
  engines        TEXT NOT NULL,
  runs_per_prompt INTEGER NOT NULL,
  planned_baseline_rounds INTEGER NOT NULL,
  planned_followup_rounds INTEGER NOT NULL,
  hypothesis     TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  manifest_hash  TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS prereg_immutable_update
BEFORE UPDATE ON preregistration
BEGIN
  SELECT RAISE(ABORT, '预注册不可修改：这是报告可信度的全部来源');
END;

CREATE TRIGGER IF NOT EXISTS prereg_immutable_delete
BEFORE DELETE ON preregistration
BEGIN
  SELECT RAISE(ABORT, '预注册不可删除');
END;


-- ---------------------------------------------------------------------------
-- 实验 manifest：把口径、分组、引擎配置、停止规则和干预计划锁进一个 hash
-- anchor 独立 append-only：manifest 本身创建后永不 UPDATE。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS experiment_manifest (
  id             TEXT PRIMARY KEY,
  prompt_set_id  TEXT NOT NULL UNIQUE REFERENCES prompt_set(id),
  schema_version TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  content_hash   TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS manifest_immutable_update
BEFORE UPDATE ON experiment_manifest
BEGIN
  SELECT RAISE(ABORT, '实验 manifest 不可修改：改方案请新建 prompt 集');
END;

CREATE TRIGGER IF NOT EXISTS manifest_immutable_delete
BEFORE DELETE ON experiment_manifest
BEGIN
  SELECT RAISE(ABORT, '实验 manifest 不可删除');
END;

CREATE TRIGGER IF NOT EXISTS manifest_before_intervention_or_followup
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

CREATE TABLE IF NOT EXISTS manifest_anchor (
  id            TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL REFERENCES experiment_manifest(content_hash),
  anchor_type   TEXT NOT NULL CHECK (
    anchor_type IN ('email', 'contract', 'rfc3161', 'opentimestamps', 'github_commit', 'other')
  ),
  reference     TEXT NOT NULL,
  anchored_at   TEXT NOT NULL,
  recorded_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (manifest_hash, anchor_type, reference)
);

CREATE TRIGGER IF NOT EXISTS manifest_anchor_immutable_update
BEFORE UPDATE ON manifest_anchor
BEGIN
  SELECT RAISE(ABORT, 'manifest 外部锚定记录不可修改');
END;

CREATE TRIGGER IF NOT EXISTS manifest_anchor_immutable_delete
BEFORE DELETE ON manifest_anchor
BEGIN
  SELECT RAISE(ABORT, 'manifest 外部锚定记录不可删除');
END;
