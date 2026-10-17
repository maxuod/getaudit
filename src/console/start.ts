import { resolve, dirname } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";
import { acquireWriterLock } from "../db/writer-lock.ts";
import { connectLedger } from "../db/index.ts";
import { LabService } from "./service.ts";
import { serveConsole } from "./server.ts";
import { seedDemo } from "./demo.ts";
const demo = process.argv.includes("--demo");
const database = resolve(
  process.env.LEDGER_PATH ??
    (demo ? "./out/console-demo/ledger.db" : "./data/ledger.db"),
);
mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
const releaseWriter = acquireWriterLock(database);
const db = connectLedger(database);
chmodSync(database, 0o600);
const lab = new LabService(db);
if (demo) seedDemo(lab);
const { server, url, jobs, ai, browserJobs, keywordAudit } = await serveConsole(lab, {
  port: Number(process.env.CONSOLE_PORT ?? 0),
  demo,
});
console.log(
  `getaudit Workspace${demo ? " · Synthetic demo" : ""}\n${url}\nLedger: ${database}`,
);
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void Promise.all([keywordAudit.stop(), jobs.pauseAll(), browserJobs.pauseAll(), ...ai.active.values()]).then(() =>
    server.close(() => {
      db.close();
      releaseWriter();
      process.exit(0);
    }),
  );
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
