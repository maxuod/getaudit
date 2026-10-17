-- Additive Console contract. Every parent remains an existing Lab identity.
CREATE TABLE IF NOT EXISTS console_command (
 id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS console_plan (
 id TEXT PRIMARY KEY,
 prompt_set_id TEXT NOT NULL REFERENCES prompt_set(id),
 run_id TEXT NOT NULL UNIQUE REFERENCES collection_run(id),
 label TEXT NOT NULL, config_json TEXT NOT NULL, config_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS console_slot (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES console_plan(id),
 prompt_id TEXT NOT NULL REFERENCES prompt(id), surface TEXT NOT NULL,
 window TEXT NOT NULL, run_idx INTEGER NOT NULL,
 UNIQUE(plan_id,prompt_id,surface,window,run_idx)
);
CREATE TABLE IF NOT EXISTS console_artifact (
 hash TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS console_attempt (
 id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES console_slot(id),
 sequence INTEGER NOT NULL, capture_json TEXT NOT NULL, capture_hash TEXT NOT NULL,
 artifact_hash TEXT REFERENCES console_artifact(hash),
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(slot_id,sequence)
);
CREATE TABLE IF NOT EXISTS console_review (
 attempt_id TEXT PRIMARY KEY REFERENCES console_attempt(id),
 decision TEXT NOT NULL CHECK(decision IN ('accept','reject')),
 note TEXT NOT NULL, observation_id TEXT UNIQUE REFERENCES observation(id),
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS console_restriction (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('stop','release')),
 reason TEXT NOT NULL, attempt_id TEXT REFERENCES console_attempt(id),
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS console_question_source (
 prompt_id TEXT PRIMARY KEY REFERENCES prompt(id), source TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('business','hypothesis','ai_draft'))
);
CREATE TRIGGER IF NOT EXISTS console_slot_parent BEFORE INSERT ON console_slot
WHEN (SELECT prompt_set_id FROM prompt WHERE id=NEW.prompt_id)
 IS NOT (SELECT prompt_set_id FROM console_plan WHERE id=NEW.plan_id)
BEGIN SELECT RAISE(ABORT,'任务与问题必须来自同一问题集'); END;

-- Brand directory changes are reversible; evidence and parent identities remain intact.
CREATE TABLE IF NOT EXISTS console_brand_change (
 id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brand(id),
 action TEXT NOT NULL CHECK(action IN ('edit','delete','restore')),
 before_json TEXT NOT NULL, after_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS console_brand_change_by_brand ON console_brand_change(brand_id);

-- Local question discovery is additive; it never edits a frozen prompt set.
CREATE TABLE IF NOT EXISTS console_question_document (
 id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brand(id),
 label TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS console_question_candidate (
 id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brand(id),
 normalized TEXT NOT NULL, text TEXT NOT NULL, stage TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(brand_id,normalized)
);
CREATE TABLE IF NOT EXISTS console_question_evidence (
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES console_question_candidate(id),
 source_key TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL,
 UNIQUE(candidate_id,source_key)
);
CREATE TABLE IF NOT EXISTS console_question_scan (
 source_key TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brand(id),
 source_hash TEXT NOT NULL, payload TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS console_question_candidate_prompt (
 prompt_id TEXT PRIMARY KEY REFERENCES prompt(id),
 candidate_id TEXT NOT NULL REFERENCES console_question_candidate(id),
 payload TEXT NOT NULL, hash TEXT NOT NULL
);
