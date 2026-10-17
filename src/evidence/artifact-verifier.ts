import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Ledger } from "../db/index.ts";
import { inTransaction } from "../db/index.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";

export const ARTIFACT_VERIFIER_VERSION = "artifact-sha256-v1";

interface ArtifactCandidate {
  observation_id: string;
  capture_reference: string | null;
  raw_response: string | null;
}

export interface ArtifactVerificationResult {
  runId: string;
  verified: number;
  alreadyVerified: number;
  verificationEvidenceSha256: string;
}

function expectedScreenshotHash(rawResponse: string | null): string | undefined {
  if (!rawResponse) return undefined;
  try {
    const raw = JSON.parse(rawResponse) as { screenshot_sha256?: unknown };
    return typeof raw.screenshot_sha256 === "string" && /^[a-f0-9]{64}$/.test(raw.screenshot_sha256)
      ? raw.screenshot_sha256
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveCapture(root: string, captureReference: string): string {
  if (isAbsolute(captureReference)) {
    throw new Error(`capture_reference 必须是 artifact root 下的相对路径：${captureReference}`);
  }
  const absoluteRoot = resolve(root);
  const filePath = resolve(absoluteRoot, captureReference);
  const fromRoot = relative(absoluteRoot, filePath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`capture_reference 越过 artifact root：${captureReference}`);
  }
  return filePath;
}

/**
 * 复算消费级网页 run 的逐条截图 SHA，并写入 append-only 校验记录。
 * 这是“文件在校验时存在且字节匹配”的证据，不证明截图来自真实上游页面。
 */
export function verifyArtifactsForRun(
  db: Ledger,
  runId: string,
  artifactRoot: string,
): ArtifactVerificationResult {
  const run = db
    .prepare(`SELECT id, finished_at FROM collection_run WHERE id = ?`)
    .get(runId) as { id: string; finished_at: string | null } | undefined;
  if (!run) throw new Error(`run 不存在：${runId}`);
  if (!run.finished_at) throw new Error(`run 尚未封存：${runId}`);

  const candidates = db
    .prepare(
      `SELECT o.id AS observation_id, s.capture_reference, o.raw_response
         FROM observation o
         JOIN observation_surface_context s ON s.observation_id = o.id
        WHERE o.run_id = ? AND s.surface_class = 'consumer_web'
        ORDER BY o.prompt_id, o.run_idx`,
    )
    .all(runId) as unknown as ArtifactCandidate[];
  if (!candidates.length) throw new Error(`run ${runId} 没有消费级网页观测`);

  const existing = new Map(
    (db
      .prepare(
        `SELECT observation_id, artifact_sha256
           FROM evidence_artifact_verification
          WHERE observation_id IN (SELECT id FROM observation WHERE run_id = ?)`,
      )
      .all(runId) as Array<{ observation_id: string; artifact_sha256: string }>).map((row) => [
      row.observation_id,
      row.artifact_sha256,
    ]),
  );

  const prepared = candidates.map((candidate) => {
    if (!candidate.capture_reference) {
      throw new Error(`观测 ${candidate.observation_id} 缺少 capture_reference`);
    }
    const expected = expectedScreenshotHash(candidate.raw_response);
    if (!expected) {
      throw new Error(`观测 ${candidate.observation_id} 缺少有效 screenshot_sha256`);
    }
    const filePath = resolveCapture(artifactRoot, candidate.capture_reference);
    const bytes = readFileSync(filePath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      throw new Error(
        `artifact SHA 不匹配：${candidate.capture_reference} expected=${expected} actual=${actual}`,
      );
    }
    const size = statSync(filePath).size;
    const verificationEvidenceSha256 = sha256(
      canonicalJson({
        schema_version: ARTIFACT_VERIFIER_VERSION,
        observation_id: candidate.observation_id,
        capture_reference: candidate.capture_reference,
        artifact_sha256: actual,
        artifact_size_bytes: size,
      }),
    );
    return { ...candidate, actual, size, verificationEvidenceSha256 };
  });

  let verified = 0;
  let alreadyVerified = 0;
  const insert = db.prepare(
    `INSERT INTO evidence_artifact_verification
       (observation_id, capture_reference, artifact_sha256, artifact_size_bytes,
        verifier_version, verification_evidence_sha256)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  inTransaction(db, () => {
    for (const item of prepared) {
      const prior = existing.get(item.observation_id);
      if (prior) {
        if (prior !== item.actual) {
          throw new Error(`已有 artifact 校验与当前文件不一致：${item.capture_reference}`);
        }
        alreadyVerified += 1;
        continue;
      }
      insert.run(
        item.observation_id,
        item.capture_reference,
        item.actual,
        item.size,
        ARTIFACT_VERIFIER_VERSION,
        item.verificationEvidenceSha256,
      );
      verified += 1;
    }
  });

  return {
    runId,
    verified,
    alreadyVerified,
    verificationEvidenceSha256: sha256(
      canonicalJson(prepared.map((item) => item.verificationEvidenceSha256).sort()),
    ),
  };
}
