import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/db/index.ts";
import { importConsumerWebEvidence } from "../src/evidence/consumer-web.ts";
import { verifyArtifactsForRun } from "../src/evidence/artifact-verifier.ts";
import { sha256 } from "../src/lib/canonical-json.ts";
import {
  addPrompts,
  createBrand,
  createPromptSet,
  freezePromptSet,
  listPrompts,
} from "../src/ledger/repo.ts";

let dir: string;
let db: ReturnType<typeof openLedger>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "geo-web-evidence-"));
  closeLedger();
  db = openLedger(join(dir, "test.db"));
});

afterEach(() => {
  closeLedger();
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const brandId = createBrand(db, {
    name: "Acme",
    ownedDomains: ["acme.example"],
    aliases: ["Acme"],
  });
  const setId = createPromptSet(db, { brandId, label: "web evidence" });
  addPrompts(db, setId, [
    { text: "best widgets", locale: "en-US" },
    { text: "widget suppliers", locale: "en-US" },
  ]);
  freezePromptSet(db, setId);
  return setId;
}

function bundle(setId: string) {
  return {
    schema_version: "consumer-web-evidence-v1",
    prompt_set_id: setId,
    phase: "baseline",
    note: "U.S. anonymous reference",
    surface: {
      engine: "consumer_web_chatgpt",
      provider: "OpenAI",
      product_surface: "ChatGPT Search web",
      collection_mode: "manual_capture",
      account_state: "logged_out",
      personalization_state: "fresh",
      search_mode: "explicit_search",
      target_country: "US",
      exit_country: "US",
      geo_verification: "ip_observed",
      browser_locale: "en-US",
      timezone_id: "America/New_York",
      geolocation_policy: "city_emulated",
      device: "desktop",
    },
    observations: listPrompts(db, setId).map((prompt, index) => ({
      prompt_id: prompt.id,
      observed_at: `2026-08-14T12:0${index}:00-04:00`,
      answer_text: index === 0 ? "Acme is one option." : "Compare several suppliers.",
      citations:
        index === 0
          ? [{ url: "https://acme.example/widgets", title: "Acme widgets" }]
          : [],
      retrieval_used: index === 0,
      capture_reference: `capture-${index + 1}.png`,
    })),
  };
}

describe("消费级网页版证据导入", () => {
  it("写入完整、封存且地域分层明确的 run", () => {
    const setId = seed();
    const result = importConsumerWebEvidence(db, bundle(setId));

    expect(result.observations).toBe(2);
    expect(result.locationStatus).toBe("matched");
    expect(result.bundleSha256).toMatch(/^[a-f0-9]{64}$/);

    const run = db
      .prepare(`SELECT finished_at, config_hash FROM collection_run WHERE id = ?`)
      .get(result.runId) as { finished_at: string | null; config_hash: string | null };
    expect(run.finished_at).not.toBeNull();
    expect(run.config_hash).toMatch(/^[a-f0-9]{64}$/);

    const contexts = db
      .prepare(
        `SELECT account_state, target_country, exit_country, geo_verification, location_status
           FROM observation_surface_context ORDER BY observation_id`,
      )
      .all();
    expect(contexts).toEqual([
      {
        account_state: "logged_out",
        target_country: "US",
        exit_country: "US",
        geo_verification: "ip_observed",
        location_status: "matched",
      },
      {
        account_state: "logged_out",
        target_country: "US",
        exit_country: "US",
        geo_verification: "ip_observed",
        location_status: "matched",
      },
    ]);

    const times = db
      .prepare(`SELECT observed_at FROM observation ORDER BY observed_at`)
      .all() as Array<{ observed_at: string }>;
    expect(times.map((row) => row.observed_at)).toEqual([
      "2026-08-14T12:00:00-04:00",
      "2026-08-14T12:01:00-04:00",
    ]);
  });

  it("不完整证据在创建 run 前失败", () => {
    const setId = seed();
    const input = bundle(setId);
    input.observations.pop();

    expect(() => importConsumerWebEvidence(db, input)).toThrow(/未完整覆盖/);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM collection_run`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("登录账号要求匿名队列别名，禁止邮箱", () => {
    const setId = seed();
    const input = bundle(setId);
    input.surface.account_state = "logged_in";
    input.surface.personalization_state = "active";
    (input.surface as Record<string, unknown>).account_label = "person@example.com";

    expect(() => importConsumerWebEvidence(db, input)).toThrow(/不得使用邮箱/);
  });

  it("错区证据在写入台账前被拒绝", () => {
    const setId = seed();
    const input = bundle(setId);
    input.surface.exit_country = "CA";
    expect(() => importConsumerWebEvidence(db, input)).toThrow(/出口国家 CA.*目标国家 US/);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM collection_run`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("同一证据包不能重复导入", () => {
    const setId = seed();
    const input = bundle(setId);
    importConsumerWebEvidence(db, input);
    expect(() => importConsumerWebEvidence(db, input)).toThrow(/已导入/);
  });

  it("逐条复算本地捕获文件，只有文件 SHA 匹配才写入校验台账", () => {
    const setId = seed();
    const input = bundle(setId);
    for (const [index, observation] of input.observations.entries()) {
      const bytes = `artifact-${index + 1}`;
      writeFileSync(join(dir, observation.capture_reference), bytes);
      (observation as Record<string, unknown>).screenshot_sha256 = sha256(bytes);
    }
    const imported = importConsumerWebEvidence(db, input);
    const result = verifyArtifactsForRun(db, imported.runId, dir);
    expect(result.verified).toBe(2);
    expect(result.alreadyVerified).toBe(0);
    expect(result.verificationEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);

    const repeated = verifyArtifactsForRun(db, imported.runId, dir);
    expect(repeated).toMatchObject({ verified: 0, alreadyVerified: 2 });
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM evidence_artifact_verification`)
      .get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("捕获文件内容与声明 SHA 不一致时拒绝写入任何校验记录", () => {
    const setId = seed();
    const input = bundle(setId);
    for (const [index, observation] of input.observations.entries()) {
      writeFileSync(join(dir, observation.capture_reference), `actual-${index}`);
      (observation as Record<string, unknown>).screenshot_sha256 = sha256(`expected-${index}`);
    }
    const imported = importConsumerWebEvidence(db, input);
    expect(() => verifyArtifactsForRun(db, imported.runId, dir)).toThrow(/artifact SHA 不匹配/);
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM evidence_artifact_verification`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});
