import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
execFileSync(
  "node",
  [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "false",
    "--outDir",
    "dist-node",
    "--rootDir",
    "src",
  ],
  { stdio: "inherit" },
);
for (const d of ["db", "console"]) {
  mkdirSync("dist-node/" + d, { recursive: true });
  copyFileSync("src/" + d + "/schema.sql", "dist-node/" + d + "/schema.sql");
}
