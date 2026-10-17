import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertCertificateRequirement, resolveSigningConfig, signDesktopApp, unlockSigningKeychain } from "../../scripts/mac-signing.mjs";
import { localSigningPaths, privateCommand } from "../../scripts/init-local-signing.mjs";

const folders: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "geo-signing-policy-")); folders.push(dir); return { dir, path: join(dir, "config.json") }; };
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const identity = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
const metadata = "Identifier=org.getaudit.community\nSignature size=1000\nAuthority=Local Signing\n";
const requirement = '# designated => identifier "org.getaudit.community" and anchor H"' + identity + '"';
const localConfig = (dir: string) => ({ schema: "geo-local-build-signing-v1", identity,
  keychain: join(dir, "build.keychain-db"), passwordFile: join(dir, "password"), helper: join(dir, "helper") });

describe("macOS build signing policy without accessing any Keychain", () => {
  it("stops a production build before an absent identity can become an ad-hoc fallback", () => {
    const f = fixture();
    expect(() => resolveSigningConfig({}, f.path)).toThrow(/Stable macOS signing is required/);
    expect(() => resolveSigningConfig({ GEO_CODESIGN_IDENTITY: "-" }, f.path)).toThrow(/Stable/);
    expect(resolveSigningConfig({ GEO_ALLOW_ADHOC: "1" }, f.path)).toEqual({ kind: "adhoc-qa", identity: "-" });
    expect(() => resolveSigningConfig({ GEO_ALLOW_ADHOC: "true" }, f.path)).toThrow(/Stable/);
  });
  it("reads a fixed identity from a private build-only configuration", () => {
    const f = fixture(), config = localConfig(f.dir);
    writeFileSync(f.path, JSON.stringify(config), { mode: 0o600 });
    expect(resolveSigningConfig({}, f.path)).toMatchObject({ kind: "local-certificate", ...Object.fromEntries(Object.entries(config).filter(([k]) => k !== "schema")) });
    chmodSync(f.path, 0o644);
    expect(() => resolveSigningConfig({}, f.path)).toThrow(/private/);
  });
  it("an explicit identity override never unlocks the unrelated local build key", () => {
    const f = fixture(); writeFileSync(f.path, JSON.stringify(localConfig(f.dir)), { mode: 0o600 });
    expect(resolveSigningConfig({ GEO_CODESIGN_IDENTITY: "Developer ID Application: Company" }, f.path))
      .toEqual({ kind: "certificate", identity: "Developer ID Application: Company" });
    expect(resolveSigningConfig({ GEO_CODESIGN_IDENTITY: identity, GEO_CODESIGN_KEYCHAIN: "/private/another.keychain-db" }, f.path))
      .toEqual({ kind: "certificate", identity, keychain: "/private/another.keychain-db" });
  });
  it("rejects malformed private configurations and relative keychain paths", () => {
    const f = fixture(); writeFileSync(f.path, "{}", { mode: 0o600 });
    expect(() => resolveSigningConfig({}, f.path)).toThrow(/invalid/);
    rmSync(f.path);
    expect(() => resolveSigningConfig({ GEO_CODESIGN_IDENTITY: identity, GEO_CODESIGN_KEYCHAIN: "login" }, f.path)).toThrow(/absolute/);
  });
  it("requires a certificate or anchor constraint and the exact application identifier", () => {
    expect(() => assertCertificateRequirement(metadata, requirement)).not.toThrow();
    expect(() => assertCertificateRequirement(metadata, '# designated => identifier "org.getaudit.community" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE"')).not.toThrow();
    expect(() => assertCertificateRequirement(metadata, '# designated => identifier "org.getaudit.community"')).toThrow(/certificate-bound/);
    expect(() => assertCertificateRequirement("Signature=adhoc", requirement)).toThrow(/certificate-bound/);
    expect(() => assertCertificateRequirement(metadata, '# designated => cdhash H"' + identity + '"')).toThrow(/certificate-bound/);
    expect(() => assertCertificateRequirement(metadata, requirement.replace("org.getaudit.community", "com.other.app"))).toThrow(/certificate-bound/);
  });
  it("uses osx-sign to sign inside out without weak custom requirements or global trust changes", async () => {
    const sign = vi.fn(async () => {}), execute = vi.fn(), inspect = vi.fn(args => args.includes("-dr") ? requirement : metadata);
    await signDesktopApp("/private/synthetic.app", { kind: "certificate", identity, keychain: "/private/build.keychain-db" }, { sign, execute, inspect });
    const options = sign.mock.calls[0]![0] as any;
    expect(options).toMatchObject({ platform: "darwin", identity, keychain: "/private/build.keychain-db", strictVerify: true, identityValidation: true });
    expect(options.optionsForFile()).toEqual({ entitlements: ["com.apple.security.cs.allow-jit"], hardenedRuntime: true });
    expect(options.requirements).toBeUndefined();
    expect(execute.mock.calls).toEqual([["/usr/bin/codesign", ["--verify", "--deep", "--strict", "/private/synthetic.app"], { stdio: "pipe" }]]);
  });
  it("allows ad-hoc only in explicit synthetic QA and never presents it as a stable certificate", async () => {
    const execute = vi.fn(), sign = vi.fn(), inspect = vi.fn();
    await signDesktopApp("/private/synthetic.app", { kind: "adhoc-qa", identity: "-" }, { execute, sign, inspect });
    expect(sign).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]?.[1]).toEqual(["--force", "--deep", "--sign", "-", "/private/synthetic.app"]);
  });
  it("passes only private filenames to the local unlock helper and suppresses subprocess secrets in errors", () => {
    const f = fixture(), config = { kind: "local-certificate", ...localConfig(f.dir) };
    writeFileSync(config.passwordFile, "synthetic-new-keychain-password", { mode: 0o600 });
    writeFileSync(config.helper, "synthetic executable", { mode: 0o700 });
    const execute = vi.fn(); unlockSigningKeychain(config, execute);
    expect(execute.mock.calls[0]?.[1]).toEqual(["unlock", config.keychain, config.passwordFile]);
    expect(() => unlockSigningKeychain(config, () => { throw new Error("synthetic-new-keychain-password"); })).toThrow(/could not be unlocked/);
    expect(() => unlockSigningKeychain(config, () => { throw new Error("synthetic-new-keychain-password"); })).not.toThrow(/synthetic-new-keychain-password/);
  });
  it("keeps initialization tools separate from app credentials and does not alter persistent search lists or trust", () => {
    const p = localSigningPaths("/private/synthetic-build-signing");
    expect(p.keychain).toBe("/private/synthetic-build-signing/build.keychain-db");
    const source = readFileSync(new URL("../../scripts/init-local-signing.mjs", import.meta.url), "utf8");
    const native = readFileSync(new URL("../../scripts/mac-build-keychain.m", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:add-trusted-cert|trust-settings-import|list-keychains.*-s|default-keychain.*-s|connections\.enc)/);
    expect(native).not.toMatch(/SecKeychainSet(?:PreferenceDomain|SearchList|Default)\s*\(/);
    expect(native).toContain("SecKeychainSetUserInteractionAllowed(false)");
    expect(native).toContain('SecTrustedApplicationCreateFromPath("/usr/bin/codesign"');
    expect(source).not.toContain("\"create-keychain\"");
    expect(source).toContain("Existing private build identity is inconsistent");
    expect(source).toContain('flag: "wx"');
    expect(source).toContain('"GEO Lab Local Signing "');
    expect(source).toContain('"--resume"');
  });
  it("gives password-consuming tools independent descriptors for one fixed password source", () => {
    const f = fixture(), passwordFile = join(f.dir, "synthetic-password");
    writeFileSync(passwordFile, "synthetic fixed value", { mode: 0o600 });
    const result = privateCommand(process.execPath, ["-e", "const fs=require('node:fs');const a=fs.readFileSync(3),b=fs.readFileSync(4);process.stdout.write(String(a.equals(b)));"], undefined, "synthetic-fd-test", [passwordFile, passwordFile]);
    expect(result.stdout.toString()).toBe("true");
    expect(readFileSync(passwordFile, "utf8")).toBe("synthetic fixed value");
  });
});
