import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export const buildSigningDirectory = () => join(homedir(), "Library", "Application Support", "getaudit Community Build Signing");
export const buildSigningConfigPath = () => join(buildSigningDirectory(), "config.json");

export function assertPrivateFile(file, executable = false) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid()) || (executable && !(stat.mode & 0o100)))
    throw new Error("Build signing files must be owned by this user and private (600, or 700 for the helper).");
}

export function resolveSigningConfig(env = process.env, configPath = buildSigningConfigPath()) {
  let local;
  if (existsSync(configPath)) {
    assertPrivateFile(configPath);
    try { local = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { throw new Error("Private build signing configuration is invalid."); }
    if (!local || local.schema !== "geo-local-build-signing-v1" ||
        !/^[A-Fa-f0-9]{40}$/.test(local.identity) ||
        ![local.keychain, local.passwordFile, local.helper].every(p => typeof p === "string" && isAbsolute(p)))
      throw new Error("Private build signing configuration is invalid.");
  }
  const identity = (env.GEO_CODESIGN_IDENTITY || local?.identity || "").trim();
  if (!identity || identity === "-") {
    if (env.GEO_ALLOW_ADHOC === "1") return { kind: "adhoc-qa", identity: "-" };
    throw new Error("Stable macOS signing is required. Configure GEO_CODESIGN_IDENTITY (and optionally GEO_CODESIGN_KEYCHAIN), or initialize the private local build identity. Synthetic QA only may explicitly use GEO_ALLOW_ADHOC=1.");
  }
  if (/[\r\n\0]/.test(identity)) throw new Error("Invalid signing identity.");
  const keychain = env.GEO_CODESIGN_KEYCHAIN || (identity === local?.identity ? local.keychain : undefined);
  if (keychain && !isAbsolute(keychain)) throw new Error("GEO_CODESIGN_KEYCHAIN must be an absolute path.");
  const ownsLocalIdentity = identity === local?.identity && keychain === local.keychain;
  return { kind: ownsLocalIdentity ? "local-certificate" : "certificate", identity,
    ...(keychain ? { keychain } : {}),
    ...(ownsLocalIdentity ? { passwordFile: local.passwordFile, helper: local.helper } : {}) };
}

// Child-process failures may contain argv. Never propagate them for private-key operations.
export function unlockSigningKeychain(config, execute = execFileSync) {
  if (config.kind !== "local-certificate") return;
  assertPrivateFile(config.passwordFile);
  assertPrivateFile(config.helper, true);
  try { execute(config.helper, ["unlock", config.keychain, config.passwordFile], { stdio: "pipe", timeout: 30000 }); }
  catch { throw new Error("The private build signing keychain could not be unlocked. Existing app connections were not accessed."); }
}

export function assertCertificateRequirement(metadata, requirement) {
  if (/Signature=adhoc|flags=.*\(adhoc\)/.test(metadata) ||
      !/designated\s*=>/.test(requirement) ||
      !/\b(?:certificate\s+(?:leaf|root|\d+)|anchor\s+(?:apple|H\"[A-Fa-f0-9]{40}\"))/.test(requirement) ||
      !/\bidentifier\s+"org\.getaudit\.community"/.test(requirement))
    throw new Error("The app lacks a stable, certificate-bound signing requirement. Ad-hoc or identifier-only signatures cannot be installed as production builds.");
}

export async function signDesktopApp(appPath, config, dependencies = {}) {
  const execute = dependencies.execute || execFileSync;
  if (config.kind === "adhoc-qa") {
    execute("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "pipe" });
  } else {
    unlockSigningKeychain(config, execute);
    const sign = dependencies.sign || (await import("@electron/osx-sign")).sign;
    await sign({ app: appPath, platform: "darwin", identity: config.identity,
      ...(config.keychain ? { keychain: config.keychain } : {}),
      // Self-signed local identities are deliberately not trusted globally. Actual
      // codesign verification and certificate-bound DR checks follow signing.
      identityValidation: config.kind !== "local-certificate",
      preAutoEntitlements: false, preEmbedProvisioningProfile: false, strictVerify: true,
      optionsForFile: () => ({ entitlements: ["com.apple.security.cs.allow-jit"],
        hardenedRuntime: config.kind !== "local-certificate",
        ...(config.kind === "local-certificate" ? { timestamp: "none" } : {}) }),
    });
  }
  execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
  if (config.kind !== "adhoc-qa") {
    // codesign writes display output to stderr.
    const inspect = dependencies.inspect || inspectCodesign;
    assertCertificateRequirement(inspect(["-dv", "--verbose=4", appPath]), inspect(["-dr", "-", appPath]));
  }
}

function inspectCodesign(args) {
  const result = spawnSync("/usr/bin/codesign", args, { encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) throw new Error("Could not verify macOS signing identity.");
  return result.stdout + result.stderr;
}
