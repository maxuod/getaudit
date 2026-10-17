import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyClientReportHtml } from "../analysis/client-report-verifier.ts";
import {
  loadClientLightSnapshot,
  loadPreviewConfig,
} from "./client-previews.ts";

const configPath = process.argv[2];
if (!configPath) throw new Error("Provide your own report configuration file.");
const config = loadPreviewConfig(configPath);
const snapshot = loadClientLightSnapshot(config);
const reports = [
  ["combined", config.outputs.combined],
  ["geo-only", config.outputs.geo_only],
] as const;

for (const [mode, file] of reports) {
  const result = verifyClientReportHtml(
    snapshot,
    mode,
    readFileSync(resolve(file), "utf8"),
  );
  console.log(`${mode}: verified`);
  console.log(`  checks: ${result.checks.join(", ")}`);
  console.log(`  evidence fingerprint: ${result.evidenceSha256}`);
  if (result.limitations.length) {
    console.log(`  disclosed limitations: ${result.limitations.join("; ")}`);
  }
}
