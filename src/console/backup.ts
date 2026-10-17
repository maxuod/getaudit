import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
const historicalTables = [
  "brand",
  "prompt_set",
  "prompt",
  "collection_run",
  "observation",
  "citation",
  "observation_surface_context",
  "observation_interpretation",
  "evidence_artifact_verification",
  "assignment",
  "preregistration",
  "intervention",
  "client_change",
  "experiment_manifest",
  "manifest_anchor",
];
export function historicalFingerprint(db: DatabaseSync) {
  return Object.fromEntries(
    historicalTables
      .filter((t) =>
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(t),
      )
      .map((t) => {
        const rows = db
          .prepare(`SELECT * FROM ${t}`)
          .all()
          .map((row) => canonicalJson(row))
          .sort();
        return [t, { rows: rows.length, hash: sha256(rows.join("\n")) }];
      }),
  );
}
export function validateLedger(db: DatabaseSync) {
  const check = db.prepare("PRAGMA quick_check").all();
  if (check.some((row) => Object.values(row)[0] !== "ok"))
    throw new Error("SQLite 完整性检查失败");
  for (const table of [
    "brand",
    "prompt_set",
    "prompt",
    "observation",
    "collection_run",
  ])
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      throw new Error("This file is not a getaudit ledger.");
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("台账外键关系检查失败");
}
/** SQLite online backup includes committed WAL records; never copies a bare live db file. */
export async function backupLedger(db: DatabaseSync, destination: string) {
  if (existsSync(destination))
    throw new Error("备份目标已存在，请选择新文件名");
  try {
    await backup(db, destination);
    chmodSync(destination, 0o600);
    const check = new DatabaseSync(destination, { readOnly: true });
    try {
      validateLedger(check);
      return historicalFingerprint(check);
    } finally {
      check.close();
    }
  } catch (error) {
    if (existsSync(destination)) unlinkSync(destination);
    throw error;
  }
}
