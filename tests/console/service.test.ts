import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { get } from "node:http";
import { connectLedger, inTransaction } from "../../src/db/index.ts";
import { acquireWriterLock } from "../../src/db/writer-lock.ts";
import {
  getBrand,
  getPromptSet,
  listPrompts,
  listRuns,
} from "../../src/ledger/repo.ts";
import { LabService } from "../../src/console/service.ts";
import { createSnapshot, verifySnapshot } from "../../src/console/snapshots.ts";
import { exportReport } from "../../src/console/report.ts";
import { AiAnalysis } from "../../src/console/ai-analysis.ts";
import {
  backupLedger,
  historicalFingerprint,
} from "../../src/console/backup.ts";
import { canonicalJson, sha256 } from "../../src/lib/canonical-json.ts";
import { ApiJobs } from "../../src/console/api-jobs.ts";
import type { EngineAdapter } from "../../src/engines/types.ts";
import { serveConsole } from "../../src/console/server.ts";
let root: string, lab: LabService, setId: string, planId: string;
const key = () => randomUUID();
function basePlan() {
  return {
    promptSetId: setId,
    label: "Test observation",
    surfaces: ["google_aio", "chatgpt_search"],
    windows: ["2026-09-25"],
    country: "CA",
    locale: "en-CA",
    timezone: "America/Halifax",
    device: "desktop",
  };
}
function capture(slotId: string, extra: Record<string, unknown> = {}) {
  const slot = lab.plan(planId).slots.find((s) => s.id === slotId)!;
  return {
    slotId,
    prompt: slot.prompt,
    status: "observed",
    reason: "",
    restriction: "none",
    observedAt: "2026-09-25T16:00:00Z",
    answer: "Compare Northstar scheduling.",
    citations: [{ url: "https://northstar.example/features" }],
    model: "unknown",
    account: "logged_out",
    session: "fresh",
    exitCountry: "CA",
    geo: "ip_observed",
    locale: "en-CA",
    timezone: "America/Halifax",
    device: "desktop",
    geolocation: "denied",
    searchMode: "explicit_search",
    collectionMode: "manual_capture",
    retrievalUsed: null,
    artifact: {
      mime: "text/plain",
      base64: Buffer.from(
        "Screenshot transcription: Compare Northstar scheduling.",
      ).toString("base64"),
    },
    ...extra,
  };
}
function accept(attemptId: string) {
  return lab.review(key(), {
    attemptId,
    decision: "accept",
    note: "Compared original and references; privacy reviewed",
    privacyReviewed: true,
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lab-console-test-"));
  lab = new LabService(connectLedger(join(root, "ledger.db")));
  const b = lab.createBrand(key(), {
    name: "Northstar",
    ownedDomains: ["northstar.example"],
    aliases: ["Northstar"],
  });
  setId = lab.createSet(key(), {
    brandId: b.id,
    label: "Frozen buyer questions",
    locale: "en-CA",
    source: "Test fixture",
    kind: "hypothesis",
    prompts: [
      { text: "What scheduling software is useful?", intent: "discovery" },
      { text: "How can restaurant staff swap shifts?", intent: "discovery" },
    ],
  }).id;
  lab.freeze(key(), setId);
  planId = lab.createPlan(key(), basePlan()).id;
});
afterEach(() => {
  lab.db.close();
  rmSync(root, { recursive: true, force: true });
});
describe("unified Lab identity, recovery and evidence semantics", () => {
  it("keeps session URLs private while exporting the provider origin and review limits", () => {
    const slot = lab.plan(planId).slots[0]!;
    accept(
      lab.capture(
        key(),
        capture(slot.id, {
          sourceUrl:
            "https://gemini.google.com/app/private-session-canary?q=private-challenge-canary",
        }),
      ).id,
    );
    const result = exportReport(lab, planId);
    expect(result.html).toContain("https://gemini.google.com");
    expect(result.html).not.toContain("private-session-canary");
    expect(result.html).not.toContain("private-challenge-canary");
    expect(
      result.json.report.records.find((r) => r.slotId === slot.id)?.reviewNote,
    ).toContain("privacy reviewed");
  });
  it("rejects a second console or CLI owner and releases ownership on close", () => {
    const target = join(root, "lock-test.db"),
      release = acquireWriterLock(target);
    expect(() => acquireWriterLock(target)).toThrow(/已有/);
    release();
    release();
    const next = acquireWriterLock(target);
    next();
  });
  it("keeps historical plan brand definitions stable after the brand changes", () => {
    const before = lab.report(planId);
    lab.db
      .prepare("UPDATE brand SET name=?,aliases=?,owned_domains=? WHERE id=?")
      .run(
        "Changed",
        "[]",
        '["changed.example"]',
        getPromptSet(lab.db, setId).brand_id,
      );
    accept(lab.capture(key(), capture(lab.plan(planId).slots[0]!.id)).id);
    const after = lab.report(planId);
    expect(after.brand).toBe(before.brand);
    expect(after.groups.reduce((n, g) => n + g.brandMentions, 0)).toBe(1);
    expect(after.groups.reduce((n, g) => n + g.ownedCitations, 0)).toBe(1);
  });
  it("excludes previously accepted answer text when its artifact becomes corrupt", () => {
    accept(lab.capture(key(), capture(lab.plan(planId).slots[0]!.id)).id);
    lab.db.exec("DROP TRIGGER console_artifact_immutable_UPDATE");
    lab.db
      .prepare("UPDATE console_artifact SET bytes=?")
      .run(Buffer.from("corrupt"));
    const exported = exportReport(lab, planId);
    expect(exported.html).not.toContain("Compare Northstar scheduling.");
    expect(
      exported.json.report.groups.reduce((n, g) => n + g.eligible, 0),
    ).toBe(0);
  });
  it("shares exact parent IDs and immutable observations with existing CLI repository", () => {
    const before = getPromptSet(lab.db, setId),
      prompts = listPrompts(lab.db, setId),
      brand = getBrand(lab.db, before.brand_id);
    const slot = lab.plan(planId).slots[0]!,
      a = lab.capture(key(), capture(slot.id));
    const accepted = accept(a.id);
    expect(
      lab.db
        .prepare("SELECT prompt_id FROM observation WHERE id=?")
        .get(accepted.observationId!),
    ).toEqual({ prompt_id: slot.prompt_id });
    expect(listRuns(lab.db, setId)[0]?.observations).toBe(1);
    expect(getPromptSet(lab.db, setId)).toEqual(before);
    expect(listPrompts(lab.db, setId)).toEqual(prompts);
    expect(getBrand(lab.db, brand.id)).toEqual(brand);
    expect(() =>
      lab.db
        .prepare("UPDATE observation SET answer_text=? WHERE id=?")
        .run("changed", accepted.observationId!),
    ).toThrow();
  });
  it("replays plan, capture and review requests without duplicate rows and rejects key reuse", () => {
    const k = key(),
      p = lab.createPlan(k, basePlan());
    expect(lab.createPlan(k, basePlan())).toEqual(p);
    expect(() =>
      lab.createPlan(k, { ...basePlan(), label: "different" }),
    ).toThrow(/另一操作/);
    const slot = lab.plan(planId).slots[0]!,
      input = capture(slot.id),
      req = key(),
      a = lab.capture(req, input);
    expect(lab.capture(req, input)).toEqual(a);
    const review = {
        attemptId: a.id,
        decision: "accept",
        note: "Reviewed",
        privacyReviewed: true,
      },
      r = key();
    expect(lab.review(r, review)).toEqual(lab.review(r, review));
    expect(
      listRuns(lab.db, setId).reduce((n, r) => n + r.observations, 0),
    ).toBe(1);
    expect(() => lab.capture(key(), input)).toThrow(/不能替换/);
  });
  it("keeps successful, absent, error and pending slots in separate denominators", () => {
    const slots = lab.plan(planId).slots,
      google = slots.filter((s) => s.surface === "google_aio"),
      chat = slots.filter((s) => s.surface === "chatgpt_search");
    accept(lab.capture(key(), capture(google[0]!.id)).id);
    accept(
      lab.capture(
        key(),
        capture(google[1]!.id, {
          status: "not_triggered",
          answer: "",
          citations: [],
          reason: "Search completed; no Overview",
        }),
      ).id,
    );
    accept(
      lab.capture(
        key(),
        capture(chat[0]!.id, {
          status: "error",
          answer: "",
          citations: [],
          reason: "Network timeout",
        }),
      ).id,
    );
    const report = lab.report(planId),
      g = report.groups.find((g) => g.surface === "google_aio")!,
      c = report.groups.find((g) => g.surface === "chatgpt_search")!;
    expect(g).toMatchObject({
      planned: 2,
      observed: 1,
      eligible: 1,
      brandMentions: 1,
      ownedCitations: 1,
      notTriggered: 1,
      pending: 0,
    });
    expect(c).toMatchObject({ planned: 2, errors: 1, pending: 1, eligible: 0 });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM observation").get()).toEqual({
      n: 1,
    });
  });
  it("does not call unknown account or geography conditions eligible", () => {
    const s = lab.plan(planId).slots[0]!;
    accept(
      lab.capture(
        key(),
        capture(s.id, {
          account: "unknown",
          geo: "unverified",
          exitCountry: null,
        }),
      ).id,
    );
    const g = lab.report(planId).groups.find((g) => g.surface === s.surface)!;
    expect(g.observed).toBe(1);
    expect(g.eligible).toBe(0);
  });
  it("persists access restrictions across duplicate plans and process reopen", () => {
    const s = lab.plan(planId).slots[0]!;
    lab.capture(
      key(),
      capture(s.id, {
        status: "unavailable",
        restriction: "captcha",
        reason: "CAPTCHA shown",
        answer: "",
        citations: [],
      }),
    );
    const other = lab.createPlan(key(), { ...basePlan(), label: "Renamed" });
    const slot = lab.plan(other.id).slots.find((x) => x.surface === s.surface)!;
    expect(slot.restriction?.action).toBe("stop");
    lab.db.close();
    lab = new LabService(connectLedger(join(root, "ledger.db")));
    expect(
      lab.plan(other.id).slots.find((x) => x.id === slot.id)?.restriction
        ?.action,
    ).toBe("stop");
    expect(() =>
      lab.capture(key(), {
        ...capture(s.id),
        slotId: slot.id,
        prompt: slot.prompt,
      }),
    ).toThrow(/未解除/);
    lab.release(key(), {
      scope: lab.scope(slot),
      reason:
        "Operator confirmed permitted access was restored after provider reset",
    });
    expect(
      lab.plan(other.id).slots.find((x) => x.id === slot.id)?.restriction
        ?.action,
    ).toBe("release");
  });
  it("rolls artifact and attempt back together on an interrupted capture transaction", () => {
    lab.db.exec(
      "CREATE TRIGGER fault_attempt BEFORE INSERT ON console_attempt BEGIN SELECT RAISE(ABORT,'fault'); END;",
    );
    expect(() =>
      lab.capture(key(), capture(lab.plan(planId).slots[0]!.id)),
    ).toThrow(/fault/);
    expect(
      lab.db.prepare("SELECT COUNT(*) n FROM console_artifact").get(),
    ).toEqual({ n: 0 });
    expect(
      lab.db.prepare("SELECT COUNT(*) n FROM console_attempt").get(),
    ).toEqual({ n: 0 });
  });
  it("rolls accepted observation back when review commit fails; can safely retry", () => {
    const a = lab.capture(key(), capture(lab.plan(planId).slots[0]!.id));
    lab.db.exec(
      "CREATE TRIGGER fault_review BEFORE INSERT ON console_review BEGIN SELECT RAISE(ABORT,'fault'); END;",
    );
    expect(() => accept(a.id)).toThrow(/fault/);
    expect(lab.db.prepare("SELECT COUNT(*) n FROM observation").get()).toEqual({
      n: 0,
    });
    lab.db.exec("DROP TRIGGER fault_review");
    accept(a.id);
    expect(lab.db.prepare("SELECT COUNT(*) n FROM observation").get()).toEqual({
      n: 1,
    });
  });
  it("detects corrupted bytes and refuses acceptance", () => {
    const a = lab.capture(key(), capture(lab.plan(planId).slots[0]!.id));
    lab.db.exec("DROP TRIGGER console_artifact_immutable_UPDATE");
    lab.db
      .prepare("UPDATE console_artifact SET bytes=?")
      .run(Buffer.from("tampered"));
    expect(() => accept(a.id)).toThrow(/完整性/);
    expect(lab.plan(planId).slots[0]!.latest?.integrity).toBe(false);
  });
  it("retains retries and prevents prompt rewriting or unsupported absent statuses", () => {
    const s = lab
      .plan(planId)
      .slots.find((s) => s.surface === "chatgpt_search")!;
    expect(() =>
      lab.capture(key(), capture(s.id, { prompt: "rewritten" })),
    ).toThrow(/逐字/);
    expect(() =>
      lab.capture(
        key(),
        capture(s.id, {
          status: "not_triggered",
          answer: "",
          citations: [],
          reason: "missing",
        }),
      ),
    ).toThrow(/Not triggered applies only/);
    const a = lab.capture(
      key(),
      capture(s.id, {
        status: "error",
        answer: "",
        citations: [],
        reason: "timeout",
      }),
    );
    accept(a.id);
    const b = lab.capture(key(), capture(s.id));
    accept(b.id);
    expect(
      lab.plan(planId).slots.find((x) => x.id === s.id)?.attempts,
    ).toHaveLength(2);
  });
  it("exports only accepted, escaped, redacted derivatives without raw artifact canaries", () => {
    const s = lab.plan(planId).slots[0]!;
    const original =
      "Northstar <script>alert(1)</script> owner@private.example sk-secretCanaryString123456789";
    accept(
      lab.capture(
        key(),
        capture(s.id, {
          answer: original,
          artifact: {
            mime: "text/plain",
            base64: Buffer.from("RAW_PRIVATE_CANARY").toString("base64"),
          },
        }),
      ).id,
    );
    const exp = exportReport(lab, planId);
    expect(exp.html).not.toContain("RAW_PRIVATE_CANARY");
    expect(exp.html).not.toContain("owner@private.example");
    expect(exp.html).not.toContain("sk-secretCanaryString123456789");
    expect(exp.html).not.toContain("<script>alert");
    expect(exp.html).toContain("&lt;script&gt;");
    expect(lab.db.prepare("SELECT answer_text FROM observation").get()).toEqual(
      { answer_text: original },
    );
    expect(exportReport(lab, planId).htmlHash).toBe(exp.htmlHash);
  });
  it("nested repository transactions remain atomic", () => {
    expect(() =>
      inTransaction(lab.db, () => {
        lab.createBrand(key(), {
          name: "Rollback",
          ownedDomains: ["rollback.example"],
          aliases: [],
        });
        throw new Error("outer fault");
      }),
    ).toThrow();
    expect(
      lab.db
        .prepare("SELECT COUNT(*) n FROM brand WHERE name='Rollback'")
        .get(),
    ).toEqual({ n: 0 });
  });
});
describe("loopback API security", () => {
  it("blocks mutations while the active ledger is being restored", async () => {
    const app = await serveConsole(lab, { canMutate: () => false });
    try {
      const response = await fetch(app.origin + "/api/brands", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + app.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: key(),
          input: {
            name: "Blocked",
            ownedDomains: ["blocked.example"],
            aliases: [],
          },
        }),
      });
      expect(response.status).toBe(503);
      expect(
        lab.db.prepare("SELECT id FROM brand WHERE name='Blocked'").get(),
      ).toBeUndefined();
    } finally {
      await new Promise<void>((r) => app.server.close(() => r()));
    }
  });
  it("protects reads and writes and rejects cross-origin or hostile Host requests", async () => {
    const app = await serveConsole(lab);
    try {
      expect((await fetch(app.origin + "/api/state")).status).toBe(401);
      const headers = { Authorization: "Bearer " + app.token };
      expect((await fetch(app.origin + "/api/state", { headers })).status).toBe(
        200,
      );
      expect(
        (
          await fetch(app.origin + "/api/state", {
            headers: { ...headers, Origin: "https://untrusted.example" },
          })
        ).status,
      ).toBe(403);
      const hostileHost = await new Promise<number | undefined>(
        (resolve, reject) => {
          get(
            app.origin + "/api/state",
            { headers: { ...headers, Host: "untrusted.example" } },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          ).on("error", reject);
        },
      );
      expect(hostileHost).toBe(403);
      expect(
        (
          await fetch(app.origin + "/api/brands", {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      ).toBe(415);
      expect((await fetch(app.origin + "/../package.json")).status).toBe(404);
    } finally {
      await new Promise<void>((r) => app.server.close(() => r()));
    }
  });
});

describe("durable API jobs with synthetic providers", () => {
  function engine(query: EngineAdapter["query"]): EngineAdapter {
    return {
      name: "fixture_api",
      isConfigured: () => true,
      getRunConfig: () => ({ model: "synthetic" }),
      query,
    };
  }
  it("persists run identity and cumulative budget before allowing a resume", async () => {
    let calls = 0;
    const jobs = new ApiJobs(lab, [
      engine(async () => {
        calls++;
        return {
          engine: "fixture_api",
          provenance: "SYNTHETIC",
          fidelity: "weights_only",
          answerText: "fixture",
          citations: [],
          raw: { fixture: true },
          costUsd: 0.1,
        };
      }),
    ]);
    const j = jobs.create(key(), {
      promptSetId: setId,
      engines: ["fixture_api"],
      runsPerPrompt: 1,
      maxCostUsd: 0.1,
      costAcknowledged: true,
    });
    await jobs.active.get(j.id)?.promise;
    expect(calls).toBe(1);
    expect(jobs.rows()[0]).toMatchObject({
      status: "paused",
      spent_usd: 0.1,
      completed: 1,
      uncertain: 0,
    });
    jobs.start(j.id);
    await jobs.active.get(j.id)?.promise;
    expect(calls).toBe(1);
    expect(jobs.rows()[0]?.spent_usd).toBe(0.1);
  });
  it("never resends an uncertain in-flight call after interruption or restart", async () => {
    let calls = 0;
    const e = engine(async () => {
      calls++;
      throw new Error("simulated process/network loss before recording");
    });
    const jobs = new ApiJobs(lab, [e]);
    const j = jobs.create(key(), {
      promptSetId: setId,
      engines: ["fixture_api"],
      runsPerPrompt: 1,
      maxCostUsd: 1,
      costAcknowledged: true,
    });
    await jobs.active.get(j.id)?.promise;
    expect(jobs.rows()[0]).toMatchObject({
      status: "interrupted",
      uncertain: 1,
    });
    const restarted = new ApiJobs(lab, [e]);
    expect(() => restarted.start(j.id)).toThrow(/未确认/);
    expect(calls).toBe(1);
  });
  it("completes one canonical run and makes a repeated create request inert", async () => {
    let calls = 0;
    const jobs = new ApiJobs(lab, [
      engine(async () => {
        calls++;
        return {
          engine: "fixture_api",
          provenance: "SYNTHETIC",
          fidelity: "weights_only",
          answerText: "fixture",
          citations: [],
          raw: { fixture: true },
          costUsd: 0.01,
        };
      }),
    ]);
    const requestId = key(),
      input = {
        promptSetId: setId,
        engines: ["fixture_api"],
        runsPerPrompt: 1,
        maxCostUsd: 1,
        costAcknowledged: true,
      };
    const j = jobs.create(requestId, input);
    await jobs.active.get(j.id)?.promise;
    expect(jobs.create(requestId, input)).toEqual(j);
    expect(calls).toBe(2);
    expect(jobs.rows()[0]).toMatchObject({
      status: "complete",
      completed: 2,
      uncertain: 0,
    });
  });
});

describe("AI drafts and complete backup recovery", () => {
  it("requires matching preview, exact evidence quotes, and keeps model output separate", async () => {
    const slot = lab.plan(planId).slots[0]!;
    accept(lab.capture(key(), capture(slot.id)).id);
    const oldKey = process.env.OPENAI_API_KEY,
      oldModel = process.env.OPENAI_MODEL;
    process.env.OPENAI_API_KEY = "synthetic-test-only";
    process.env.OPENAI_MODEL = "synthetic-model";
    try {
      let calls = 0;
      const send = (async (url, options) => {
        calls++;
        expect(url).toBe("https://api.openai.com/v1/responses");
        const body = JSON.parse(String(options?.body));
        expect(body.store).toBe(false);
        expect(body.tools).toEqual([]);
        return new Response(
          JSON.stringify({
            status: "completed",
            model: "synthetic-model",
            id: "synthetic-response",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      summary: "Synthetic observation only",
                      findings: [
                        {
                          kind: "observation",
                          claim: "Brand appears in saved answer",
                          nextAction: "Verify independently",
                          sources: [
                            {
                              slotId: slot.id,
                              quote: "Compare Northstar scheduling.",
                            },
                          ],
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;
      const ai = new AiAnalysis(lab, send),
        preview = ai.preview(planId);
      expect(() =>
        ai.create(key(), {
          planId,
          previewHash: "0".repeat(64),
          transmissionAcknowledged: true,
          costAcknowledged: true,
        }),
      ).toThrow(/证据已变化/);
      const requestId = key(),
        input = {
          planId,
          previewHash: sha256(canonicalJson(preview)),
          transmissionAcknowledged: true,
          costAcknowledged: true,
        },
        j = ai.create(requestId, input);
      await ai.active.get(j.id);
      expect(ai.rows(planId)[0]?.status).toBe("draft");
      expect(calls).toBe(1);
      expect(ai.create(requestId, input)).toEqual(j);
      expect(calls).toBe(1);
      expect(
        lab.db.prepare("SELECT COUNT(*) n FROM observation").get(),
      ).toEqual({ n: 1 });
      const bad = new AiAnalysis(
        lab,
        (async () =>
          new Response(
            JSON.stringify({
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({
                        summary: "Bad quote",
                        findings: [
                          {
                            kind: "hypothesis",
                            claim: "Unsupported",
                            nextAction: "Unsupported",
                            sources: [
                              {
                                slotId: slot.id,
                                quote: "This does not exist in the evidence",
                              },
                            ],
                          },
                        ],
                      }),
                    },
                  ],
                },
              ],
            }),
          )) as typeof fetch,
      );
      const failure = bad.create(key(), input);
      await bad.active.get(failure.id);
      expect(bad.rows(planId).find((r) => r.id === failure.id)?.status).toBe(
        "error",
      );
      expect(exportReport(lab, planId).json.report.analyses).toHaveLength(0);
      ai.review(key(), {
        id: j.id,
        decision: "accept",
        note: "Verified all quotes",
      });
      expect(exportReport(lab, planId).json.report.analyses).toHaveLength(1);
      const remaining = lab.plan(planId).slots.find((s) => !s.latest)!;
      accept(lab.capture(key(), capture(remaining.id)).id);
      expect(exportReport(lab, planId).json.report.analyses).toHaveLength(0);
    } finally {
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
      if (oldModel === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = oldModel;
    }
  });
  it("backs up committed WAL records including artifacts and restores the same report", async () => {
    accept(lab.capture(key(), capture(lab.plan(planId).slots[0]!.id)).id);
    const expected = lab.report(planId),
      fingerprint = historicalFingerprint(lab.db),
      dest = join(root, "backup.db");
    await backupLedger(lab.db, dest);
    const restored = new LabService(connectLedger(dest));
    try {
      expect(historicalFingerprint(restored.db)).toEqual(fingerprint);
      expect(restored.report(planId)).toEqual(expected);
      expect(restored.plan(planId).slots[0]!.latest?.integrity).toBe(true);
    } finally {
      restored.db.close();
    }
  });
});

it("verifies exported JSON and final HTML and detects either form of tampering", () => {
  const out = createSnapshot(lab, planId);
  expect(verifySnapshot(out.json, out.html).valid).toBe(true);
  expect(verifySnapshot(out.json, out.html + "changed").valid).toBe(false);
  const json = JSON.parse(out.json);
  json.report.brand = "changed";
  expect(verifySnapshot(JSON.stringify(json)).valid).toBe(false);
  expect(() =>
    lab.db
      .prepare("UPDATE console_report_snapshot SET html_hash=?")
      .run("changed"),
  ).toThrow();
});
