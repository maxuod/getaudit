import { readFileSync } from "node:fs";
import { verifySnapshot } from "./snapshots.ts";
const [jsonPath, htmlPath] = process.argv.slice(2);
if (!jsonPath) {
  console.error("用法：npm run console:verify -- snapshot.json [report.html]");
  process.exitCode = 1;
} else {
  try {
    const result = verifySnapshot(
      readFileSync(jsonPath, "utf8"),
      htmlPath ? readFileSync(htmlPath, "utf8") : undefined,
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
