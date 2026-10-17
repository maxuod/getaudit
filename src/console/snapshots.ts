import { z } from "zod";
import type { LabService } from "./service.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import { exportReport } from "./report.ts";
import type { ReportLocale } from "./report-language.ts";
export function createSnapshot(lab: LabService, planId: string, locale: ReportLocale = "en") {
  const rendered = exportReport(lab, planId, locale);
  const snapshot = {
    schema: "geo-console-snapshot-v1",
    planId,
    report: rendered.json.report,
    dataHash: rendered.json.dataHash,
    htmlHash: rendered.htmlHash,
  };
  const json = canonicalJson(snapshot),
    hash = sha256(json);
  lab.db
    .exec(`CREATE TABLE IF NOT EXISTS console_report_snapshot(hash TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES console_plan(id),json TEXT NOT NULL,html_hash TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
 CREATE TRIGGER IF NOT EXISTS console_report_snapshot_immutable_update BEFORE UPDATE ON console_report_snapshot BEGIN SELECT RAISE(ABORT,'报告快照不可修改'); END;
 CREATE TRIGGER IF NOT EXISTS console_report_snapshot_immutable_delete BEFORE DELETE ON console_report_snapshot BEGIN SELECT RAISE(ABORT,'报告快照不可删除'); END;`);
  lab.db
    .prepare(
      "INSERT OR IGNORE INTO console_report_snapshot(hash,plan_id,json,html_hash) VALUES(?,?,?,?)",
    )
    .run(hash, planId, json, rendered.htmlHash);
  return { ...rendered, snapshot, json, hash };
}
export function verifySnapshot(json: string, html?: string) {
  const envelope = z
    .object({
      schema: z.literal("geo-console-snapshot-v1"),
      planId: z.string().uuid(),
      report: z
        .object({
          schema: z.literal("console-descriptive-report-v2"),
          planId: z.string().uuid(),
        })
        .passthrough(),
      dataHash: z.string().regex(/^[a-f0-9]{64}$/),
      htmlHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(JSON.parse(json));
  const issues: string[] = [];
  if (envelope.planId !== envelope.report.planId) issues.push("计划身份不一致");
  if (sha256(canonicalJson(envelope.report)) !== envelope.dataHash)
    issues.push("派生数据哈希不匹配");
  if (html !== undefined && sha256(html) !== envelope.htmlHash)
    issues.push("HTML 文件哈希不匹配");
  return {
    valid: issues.length === 0,
    issues,
    snapshotHash: sha256(canonicalJson(envelope)),
    htmlChecked: html !== undefined,
    note: "文件一致性检查不证明网页真实性；与原台账中的快照 hash 对照可验证本地记录。",
  };
}
