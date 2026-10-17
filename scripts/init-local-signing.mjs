import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPrivateFile, buildSigningDirectory } from "./mac-signing.mjs";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
export function localSigningPaths(directory = buildSigningDirectory()) {
  if (!isAbsolute(directory)) throw new Error("Private build signing directory must be absolute.");
  return { directory, config: join(directory, "config.json"), keychain: join(directory, "build.keychain-db"),
    passwordFile: join(directory, "keychain-password"), helper: join(directory, "mac-build-keychain"),
    privateKey: join(directory, "identity.key.pem"), certificate: join(directory, "identity.cert.pem"),
    p12: join(directory, "identity.p12"), opensslConfig: join(directory, "openssl.cnf") };
}

// No secret is an argv element or returned through a child error object.
export function privateCommand(executable, args, input, step = "private-command", passwordFiles = []) {
  const descriptors = [];
  try {
    for (const file of passwordFiles) descriptors.push(openSync(file, "r"));
    const result = spawnSync(executable, args, { input, stdio: ["pipe", "pipe", "pipe", ...descriptors], timeout: 60000 });
    if (result.error || result.status !== 0) throw new Error(`Private build signing initialization failed at ${step}. Details and secrets were withheld; existing app credentials were not accessed.`);
    return result;
  } finally { for (const descriptor of descriptors) closeSync(descriptor); }
}

export function initializeLocalSigning(directory = buildSigningDirectory(), { resume = false } = {}) {
  if (process.platform !== "darwin") throw new Error("Local build signing initialization requires macOS.");
  const p = localSigningPaths(directory);
  if (existsSync(p.config)) {
    assertPrivateFile(p.config);
    const config = JSON.parse(readFileSync(p.config, "utf8"));
    for (const f of [p.passwordFile, p.privateKey, p.certificate, p.p12, p.keychain]) assertPrivateFile(f);
    assertPrivateFile(p.helper, true);
    const identity = new X509Certificate(readFileSync(p.certificate)).fingerprint.replaceAll(":", "");
    if (config.schema !== "geo-local-build-signing-v1" || config.identity !== identity ||
        config.keychain !== p.keychain || config.passwordFile !== p.passwordFile || config.helper !== p.helper)
      throw new Error("Existing private build identity is inconsistent. It was preserved; no automatic certificate rotation was attempted.");
    return { initialized: false, identity, configPath: p.config };
  }
  if (existsSync(p.directory)) {
    const stat = lstatSync(p.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("Build signing directory must be private and owned by this user.");
  } else mkdirSync(p.directory, { recursive: true, mode: 0o700 });
  // Interrupted setup must not silently replace a key that an installed app may trust.
  if (!resume && [p.passwordFile, p.privateKey, p.certificate, p.p12, p.keychain, p.helper].some(existsSync))
    throw new Error("An incomplete private build identity exists. It was preserved. Inspect or recover it before running initialization again.");
  if (resume && existsSync(p.keychain))
    throw new Error("Resume will not alter an already created Keychain without a completed identity configuration. Its existing contents were preserved for explicit recovery.");
  if (resume) for (const f of [p.passwordFile, p.privateKey, p.certificate, p.p12, p.helper].filter(existsSync)) assertPrivateFile(f, f === p.helper);
  const oldMask = process.umask(0o077);
  try {
    if (!existsSync(p.passwordFile)) writeFileSync(p.passwordFile, randomBytes(48).toString("hex"), { mode: 0o600, flag: "wx" });
    if (!existsSync(p.certificate)) {
      const cn = "GEO Lab Local Signing " + randomUUID(); // 58 bytes; X.509 CN limit is 64.
      if (existsSync(p.opensslConfig)) assertPrivateFile(p.opensslConfig);
      writeFileSync(p.opensslConfig, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=code_signing\n[dn]\nCN=${cn}\n[code_signing]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\n`, { mode: 0o600 });
      const keyArgs = existsSync(p.privateKey) ? ["-key", p.privateKey, "-passin", "file:" + p.passwordFile]
        : ["-newkey", "rsa:3072", "-keyout", p.privateKey, "-passout", "file:" + p.passwordFile];
      privateCommand("/usr/bin/openssl", ["req", "-new", "-x509", ...keyArgs, "-sha256", "-days", "3650",
        "-config", p.opensslConfig, "-out", p.certificate], undefined, "certificate-generation");
    }
    // Resume never replaces an existing certificate or private key. Compare only
    // the public keys locally before creating the aggregate import file.
    const publicKey = privateCommand("/usr/bin/openssl", ["pkey", "-in", p.privateKey, "-passin", "file:" + p.passwordFile, "-pubout", "-outform", "DER"], undefined, "public-key-consistency").stdout;
    const cert = new X509Certificate(readFileSync(p.certificate));
    if (!publicKey.equals(cert.publicKey.export({ format: "der", type: "spki" }))) throw new Error("Private build key and certificate do not match. Both were preserved.");
    // LibreSSL shares a BIO when the same file: source is used twice and then
    // expects two password lines. Independent descriptors preserve one fixed
    // password without modifying, duplicating or printing its private file.
    if (!existsSync(p.p12)) privateCommand("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", p.privateKey, "-in", p.certificate,
      "-out", p.p12, "-passin", "fd:3", "-passout", "fd:4"], undefined, "identity-export", [p.passwordFile, p.passwordFile]);
    privateCommand("/usr/bin/xcrun", ["clang", "-fobjc-arc", "-Wno-deprecated-declarations", "-framework", "Foundation", "-framework", "Security",
      join(sourceDirectory, "mac-build-keychain.m"), "-o", p.helper + ".tmp"], undefined, "helper-compilation");
    chmodSync(p.helper + ".tmp", 0o700); renameSync(p.helper + ".tmp", p.helper);
    chmodSync(p.helper, 0o700);
    privateCommand(p.helper, ["create", p.keychain, p.passwordFile, p.p12], undefined, "isolated-keychain-creation");
    chmodSync(p.keychain, 0o600);
    // Only this newly created signing key receives codesign/Apple-tool access.
    // The security interactive command is fed on stdin; the random password is
    // absent from process arguments, tool logs, returned errors and the repo.
    const quote = value => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
    if (/[\r\n\0]/.test(p.keychain)) throw new Error("Invalid private keychain path.");
    const password = readFileSync(p.passwordFile, "utf8");
    const result = privateCommand("/usr/bin/security", ["-i"],
      `set-key-partition-list -S apple-tool:,apple: -s -k ${quote(password)} ${quote(p.keychain)}\n`, "new-key-codesign-access");
    if (/(?:security:|error|failed)/i.test(result.stderr.toString()))
      throw new Error("Could not set access for the new build signing key. Existing Keychains and trust settings were not changed.");
    for (const f of [p.passwordFile, p.privateKey, p.certificate, p.p12, p.opensslConfig]) chmodSync(f, 0o600);
    const identity = new X509Certificate(readFileSync(p.certificate)).fingerprint.replaceAll(":", "");
    const config = { schema: "geo-local-build-signing-v1", identity, keychain: p.keychain,
      passwordFile: p.passwordFile, helper: p.helper, createdAt: new Date().toISOString() };
    writeFileSync(p.config + ".tmp", JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(p.config + ".tmp", p.config);
    return { initialized: true, identity, configPath: p.config };
  } finally { process.umask(oldMask); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (!["--initialize", "--resume"].includes(mode) || process.argv.length > 4)
      throw new Error("Run with --initialize [absolute-private-directory], or explicitly --resume to recover an interrupted setup before Keychain creation. This does not configure public distribution or global certificate trust.");
    console.log(JSON.stringify(initializeLocalSigning(process.argv[3], { resume: mode === "--resume" })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
