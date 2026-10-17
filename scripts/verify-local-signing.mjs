// Synthetic signing check only: no application launches, connection files,
// provider requests, installed bundles or user-data changes.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveSigningConfig, signDesktopApp } from "./mac-signing.mjs";

const config = resolveSigningConfig();
if (config.kind === "adhoc-qa") throw new Error("This test requires an actual fixed signing certificate.");
const destination = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "geo-stable-signing-"));
mkdirSync(destination, { recursive: true, mode: 0o700 });
const build = async version => {
  const bundle = join(destination, "Synthetic-" + version + ".app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true, mode: 0o700 });
  mkdirSync(join(bundle, "Contents", "Helpers"), { mode: 0o700 });
  mkdirSync(join(bundle, "Contents", "Resources"), { mode: 0o700 });
  writeFileSync(join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.getaudit.community</string><key>CFBundleExecutable</key><string>Synthetic</string><key>CFBundleName</key><string>Synthetic signing validation</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`, { mode: 0o600, flag: "wx" });
  const cSource = join(destination, "synthetic-" + version + ".c");
  writeFileSync(cSource, "int main(void) { return 0; }\n", { mode: 0o600, flag: "wx" });
  execFileSync("/usr/bin/xcrun", ["clang", cSource, "-o", join(bundle, "Contents", "MacOS", "Synthetic")], { stdio: "pipe" });
  execFileSync("/usr/bin/xcrun", ["clang", cSource, "-o", join(bundle, "Contents", "Helpers", "SyntheticHelper")], { stdio: "pipe" });
  writeFileSync(join(bundle, "Contents", "Resources", "payload.txt"), "Different synthetic content " + version, { mode: 0o600 });
  await signDesktopApp(bundle, config);
  const inspect = args => {
    const r = spawnSync("/usr/bin/codesign", args, { encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) throw new Error("Synthetic signature inspection failed.");
    return r.stdout + r.stderr;
  };
  const requirement = inspect(["-dr", "-", bundle]).match(/(?:#\s*)?designated\s*=>\s*([^\n]+)/)?.[1];
  const hash = inspect(["-dv", "--verbose=4", bundle]).match(/^CDHash=(.+)$/m)?.[1];
  if (!requirement || !hash) throw new Error("Synthetic signature metadata was incomplete.");
  return { bundle, requirement, cdHash: hash,
    payloadHash: createHash("sha256").update(readFileSync(join(bundle, "Contents", "Resources", "payload.txt"))).digest("hex") };
};
const first = await build("1.0.1"), second = await build("1.0.2");
if (first.requirement !== second.requirement || first.cdHash === second.cdHash || first.payloadHash === second.payloadHash)
  throw new Error("Different builds did not retain the same certificate-bound identity.");
for (const pair of [[first, second], [second, first]])
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R=" + pair[0].requirement, pair[1].bundle], { stdio: "pipe" });
const receipt = { schema: "synthetic-stable-signing-v1", synthetic: true, appLaunched: false,
  originalConnectionsAccessed: false, recordedAt: new Date().toISOString(), first, second,
  stableRequirement: true, certificateBound: true, bidirectionalRequirementVerification: true };
writeFileSync(join(destination, "signing-verification.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ stableRequirement: true, differentContents: true, receipt: join(destination, "signing-verification.json") }));
