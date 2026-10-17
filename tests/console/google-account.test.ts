import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAccount } from "../../src/console/google-account.ts";

const clientId = "123456789-synthetic.apps.googleusercontent.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "RS256", use: "sig" };
const accounts: GoogleAccount[] = [];
afterEach(() => { for (const account of accounts.splice(0)) account.dispose(); });

function token(payload: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const first = Buffer.from(JSON.stringify({ alg: "RS256", kid: "synthetic-key", typ: "JWT", ...header })).toString("base64url");
  const second = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${first}.${second}.${sign("RSA-SHA256", Buffer.from(`${first}.${second}`), privateKey).toString("base64url")}`;
}
function fixture(options: { timeoutMs?: number; configured?: boolean; gsc?: boolean; data?: boolean } = {}) {
  let now = 1_792_166_400_000;
  let saved: string | undefined;
  let currentClientId: string | undefined = options.configured === false ? undefined : clientId;
  let currentSecret: string | undefined;
  let nonce = "";
  let claims: Record<string, unknown> = {};
  let tokenHeader: Record<string, unknown> = {};
  let includeRefresh = true;
  let tokenStatus = 200;
  const issued = () => Math.floor(now / 1000);
  const payload = () => ({ iss: "https://accounts.google.com", aud: clientId, sub: "synthetic-google-subject-1", email: "reader@example.test", email_verified: true, name: "Reader Example", iat: issued(), exp: issued() + 3600, ...(nonce ? { nonce } : {}), ...claims });
  const exchange = vi.fn(async () => ({ id_token: token(payload(), tokenHeader), ...(includeRefresh ? { refresh_token: "synthetic-account-refresh" } : {}), access_token: "discarded-access-token" }));
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === "https://accounts.google.com/.well-known/openid-configuration") return Response.json({ issuer: "https://accounts.google.com", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" });
    if (target === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [publicJwk] });
    if (target === "https://oauth2.googleapis.com/token") return Response.json(await exchange(new URLSearchParams(String(init?.body ?? ""))) as Record<string, unknown>, { status: tokenStatus });
    throw new Error("Unexpected network destination");
  });
  const persist = vi.fn(async (value: string | undefined) => { saved = value; });
  const grant = vi.fn(async (_value: unknown) => {});
  const persistData = vi.fn(async (value: string, _grant: unknown) => { saved = value; });
  const disconnect = vi.fn(async () => { saved = undefined; });
  const account = new GoogleAccount({ config: () => ({ clientId: currentClientId, clientSecret: currentSecret }), readSession: () => saved, persistSession: persist, ...(options.gsc ? { onGscGrant: grant } : {}), ...(options.data ? { persistDataSession: persistData, onDisconnect: disconnect } : {}), fetcher: fetcher as typeof fetch, now: () => now, timeoutMs: options.timeoutMs });
  accounts.push(account);
  async function start(gsc: boolean | "data" = false) {
    const auth = await (gsc === "data" ? account.startData() : gsc ? account.startGsc() : account.start()); const url = new URL(auth.url);
    nonce = url.searchParams.get("nonce")!;
    return { auth, url, redirect: url.searchParams.get("redirect_uri")!, state: url.searchParams.get("state")! };
  }
  async function finish(started: Awaited<ReturnType<typeof start>>, params: Record<string, string> = {}) {
    const callback = new URL(started.redirect);
    callback.search = new URLSearchParams({ state: started.state, code: "synthetic-authorization-code", ...params }).toString();
    return fetch(callback);
  }
  return {
    account, fetcher, exchange, persist, persistData, disconnect, grant, start, finish, payload,
    saved: () => saved, setSaved: (value: string | undefined) => { saved = value; },
    setClaims: (value: Record<string, unknown>) => { claims = value; }, setHeader: (value: Record<string, unknown>) => { tokenHeader = value; },
    setNonce: (value: string) => { nonce = value; }, advance: (ms: number) => { now += ms; },
    setClient: (value: string | undefined) => { currentClientId = value; }, setSecret: (value: string) => { currentSecret = value; },
    omitRefresh: () => { includeRefresh = false; },
    setTokenStatus: (value: number) => { tokenStatus = value; },
  };
}

describe("Google account sign-in, separate from Search Console access", () => {
  it("requires a real desktop OAuth client without reusing GSC credentials or opening a browser", async () => {
    const f = fixture({ configured: false });
    expect(f.account.status()).toEqual({ configured: false, status: "setup_required", errorCode: "setup_required", errorPhase: "configuration", errorDetail: "configuration_missing", sessionRevision: 0 });
    await expect(f.account.start()).rejects.toThrow("setup_required");
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
    expect((await f.account.restore()).status).toBe("setup_required");
  });
  it("uses a random IPv4 loopback listener, fresh state/nonce, S256 PKCE and identity-only scopes", async () => {
    const f = fixture(), s = await f.start();
    expect(s.url.origin).toBe("https://accounts.google.com");
    expect(s.url.pathname).toBe("/o/oauth2/v2/auth");
    expect(new URL(s.redirect).hostname).toBe("127.0.0.1");
    expect(Number(new URL(s.redirect).port)).toBeGreaterThan(0);
    expect(s.url.searchParams.get("scope")).toBe("openid email profile");
    expect(s.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(s.state.length).toBeGreaterThanOrEqual(43);
    expect(s.url.searchParams.get("nonce")?.length).toBeGreaterThanOrEqual(43);
    expect(f.account.status().status).toBe("pending");
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.account.status().profile).toBeUndefined();
    const s2 = await f.start();
    expect(s2.state).not.toBe(s.state); expect(s2.url.searchParams.get("nonce")).not.toBe(s.url.searchParams.get("nonce"));
    expect(s2.url.searchParams.get("code_challenge")).not.toBe(s.url.searchParams.get("code_challenge"));
  });
  it("rejects an unsolicited state, a wrong path and POST without consuming the pending login", async () => {
    const f = fixture(), s = await f.start();
    const wrongState = await f.finish(s, { state: "not-the-issued-state" }); expect(wrongState.status).toBe(401);
    expect((await fetch(`${s.redirect}wrong?state=${s.state}`)).status).toBe(404);
    expect((await fetch(s.redirect, { method: "POST" })).status).toBe(400);
    expect(f.exchange).not.toHaveBeenCalled(); expect(f.account.status().status).toBe("pending");
    expect((await f.finish(s)).status).toBe(200);
  });
  it("verifies the Google signature, identity claims and nonce before persisting or exposing Welcome identity", async () => {
    const f = fixture(); f.setSecret("synthetic-desktop-secret"); const s = await f.start();
    const response = await f.finish(s); expect(response.status).toBe(200);
    expect(f.account.status()).toMatchObject({ configured: true, status: "signed_in", profile: { name: "Reader Example", subject: "synthetic-google-subject-1", email: "reader@example.test" } });
    expect(f.persist).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(f.saved()!);
    expect(saved).toMatchObject({ version: 1, clientId, nonce: s.url.searchParams.get("nonce"), refreshToken: "synthetic-account-refresh" });
    expect(saved.access_token).toBeUndefined(); expect(saved.profile).toBeUndefined();
    const body = f.exchange.mock.calls[0]![0] as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code"); expect(body.get("redirect_uri")).toBe(s.redirect);
    expect(body.get("client_secret")).toBe("synthetic-desktop-secret");
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(s.url.searchParams.get("code_challenge"));
    const html = await response.text();
    expect(html).not.toContain("Reader Example"); expect(html).not.toContain("synthetic-authorization-code"); expect(html).not.toContain("synthetic-account-refresh");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(f.finish(s)).rejects.toThrow();
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["wrong audience", { aud: "other.apps.googleusercontent.com" }],
    ["wrong issuer", { iss: "https://lookalike.example.test" }],
    ["expired token", { exp: 1_792_166_399 }],
    ["future issued-at", { iat: 1_792_166_600 }],
    ["missing issued-at", { iat: undefined }],
    ["unverified email", { email_verified: false }],
    ["string email verification", { email_verified: "true" }],
    ["missing subject", { sub: undefined }],
    ["wrong nonce", { nonce: "unrelated-browser-request" }],
    ["wrong authorized presenter", { azp: "other.apps.googleusercontent.com" }],
    ["multiple audiences without presenter", { aud: [clientId, "other"] }],
  ])("rejects %s without recording an authenticated profile", async (_label, claims) => {
    const f = fixture(); f.setClaims(claims); const s = await f.start();
    expect((await f.finish(s)).status).toBe(400);
    expect(f.account.status()).toMatchObject({ status: "error", errorCode: "verification_failed" });
    expect(f.account.status().profile).toBeUndefined(); expect(f.persist).not.toHaveBeenCalled();
  });
  it("rejects algorithm substitution and token-controlled signing keys", async () => {
    const f = fixture(); f.setHeader({ alg: "HS256", jku: "https://attacker.example.test/keys" }); const s = await f.start();
    expect((await f.finish(s)).status).toBe(400);
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes("attacker"))).toBe(false);
  });
  it("rejects a modified JWT signature", async () => {
    const f = fixture(); f.exchange.mockImplementation(async () => {
      const signed = token(f.payload());
      const parts = signed.split("."); parts[2] = Buffer.alloc(256, 1).toString("base64url");
      return { id_token: parts.join("."), refresh_token: "not-saved", access_token: "discarded" };
    });
    expect((await f.finish(await f.start())).status).toBe(400);
    expect(f.persist).not.toHaveBeenCalled(); expect(f.account.status().profile).toBeUndefined();
  });
  it("treats consent denial as a failed login and does not call the token endpoint", async () => {
    const f = fixture(); const response = await f.finish(await f.start(), { error: "access_denied" });
    expect(response.status).toBe(400); expect(f.account.status()).toMatchObject({ status: "error", errorCode: "access_denied" });
    expect(f.exchange).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
  });
  it("times out and closes a pending callback listener", async () => {
    const f = fixture({ timeoutMs: 25 }), s = await f.start();
    await vi.waitFor(() => expect(f.account.status()).toMatchObject({ status: "error", errorCode: "expired" }));
    await expect(f.finish(s)).rejects.toThrow(); expect(f.exchange).not.toHaveBeenCalled();
  });
  it("restores a saved identity only after rechecking the signature; concurrent restore is single flight", async () => {
    const f = fixture(); const s = await f.start(); await f.finish(s);
    const saved = f.saved()!; f.account.dispose();
    const restored = fixture(); restored.setSaved(saved);
    expect(restored.account.status().profile).toBeUndefined();
    const [a, b] = await Promise.all([restored.account.restore(), restored.account.restore()]);
    expect(a).toMatchObject({ status: "signed_in", profile: { name: "Reader Example" } }); expect(b).toEqual(a);
    expect(restored.exchange).not.toHaveBeenCalled(); expect(restored.persist).not.toHaveBeenCalled();
    expect(restored.fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not trust an editable profile or an identity saved for a different OAuth client", async () => {
    const f = fixture(); f.setSaved(JSON.stringify({ version: 1, clientId: "unrelated.apps.googleusercontent.com", idToken: "bogus", nonce: "bogus", profile: { name: "Impostor" } }));
    expect((await f.account.restore()).status).toBe("signed_out");
    expect(f.account.status().profile).toBeUndefined(); expect(f.fetcher).not.toHaveBeenCalled();
    f.setSaved(JSON.stringify({ profile: { name: "Impostor" } }));
    expect((await f.account.restore()).status).toBe("error"); expect(f.account.status().profile).toBeUndefined();
  });
  it("refreshes an expired session with subject binding and persists no extra API access token", async () => {
    const f = fixture(); await f.finish(await f.start());
    f.advance(3_601_000); f.setNonce(""); f.omitRefresh();
    const status = await f.account.ensureFresh();
    expect(status).toMatchObject({ status: "signed_in", profile: { subject: "synthetic-google-subject-1" } });
    expect(f.exchange).toHaveBeenCalledTimes(2);
    const body = f.exchange.mock.calls[1]![0] as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token"); expect(body.get("refresh_token")).toBe("synthetic-account-refresh");
    const saved = f.saved()!;
    expect(JSON.parse(saved).nonce).toBeUndefined(); expect(saved).not.toContain("discarded-access-token");
    f.account.dispose();
    const restored = fixture(); restored.advance(3_601_000); restored.setSaved(saved);
    expect((await restored.account.restore()).status).toBe("signed_in");
  });
  it("rejects a refresh that switches Google subjects and preserves the previous encrypted session", async () => {
    const f = fixture(); await f.finish(await f.start()); const old = f.saved();
    f.advance(3_601_000); f.setNonce(""); f.setClaims({ sub: "different-google-user" });
    expect(await f.account.ensureFresh()).toMatchObject({ status: "error", errorCode: "verification_failed" });
    expect(f.saved()).toBe(old); expect(f.account.status().profile).toBeUndefined();
  });
  it("does not claim sign-in succeeded when encrypted storage is unavailable", async () => {
    const f = fixture(); f.persist.mockRejectedValue(new Error("private keychain details"));
    const response = await f.finish(await f.start()); expect(response.status).toBe(400);
    expect(f.account.status()).toMatchObject({ status: "error", errorCode: "storage_unavailable" });
    expect(f.account.status().profile).toBeUndefined(); expect(JSON.stringify(f.account.status())).not.toContain("keychain details");
  });
  it("local sign-out clears only the account session and cannot be undone by a late token response", async () => {
    const f = fixture(); const s = await f.start();
    let complete!: (value: { id_token: string; refresh_token: string; access_token: string }) => void;
    f.exchange.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const pending = f.finish(s);
    await vi.waitFor(() => expect(f.exchange).toHaveBeenCalledTimes(1));
    await f.account.signOut();
    complete({ id_token: token(f.payload()), refresh_token: "late-not-saved", access_token: "discarded" });
    expect((await pending).status).toBe(400);
    expect(f.account.status().status).toBe("signed_out"); expect(f.account.status().profile).toBeUndefined();
    expect(f.persist).toHaveBeenCalledTimes(1); expect(f.persist).toHaveBeenCalledWith(undefined); expect(f.saved()).toBeUndefined();
  });
  it("removes an already saved identity on explicit sign-out without contacting any revocation or GSC endpoint", async () => {
    const f = fixture(); await f.finish(await f.start()); const before = f.fetcher.mock.calls.length;
    await f.account.signOut(); expect(f.saved()).toBeUndefined(); expect(f.account.status().status).toBe("signed_out");
    expect(f.fetcher).toHaveBeenCalledTimes(before);
  });
  it("drops the displayed identity when the configured OAuth client changes", async () => {
    const f = fixture(); await f.finish(await f.start());
    f.setClient("different.apps.googleusercontent.com");
    expect(f.account.status().status).toBe("signed_out"); expect(f.account.status().profile).toBeUndefined();
  });
  it("requests Search Console read access only through a separate explicit action", async () => {
    const f = fixture({ gsc: true }); const normal = await f.start();
    expect(normal.url.searchParams.get("scope")).not.toContain("webmasters");
    await f.finish(normal); expect(f.grant).not.toHaveBeenCalled();
    const s = await f.start(true);
    expect(s.url.searchParams.get("scope")).toBe("openid email profile https://www.googleapis.com/auth/webmasters.readonly");
    expect(s.url.searchParams.get("prompt")).toContain("consent");
    f.exchange.mockImplementation(async () => ({ id_token: token(f.payload()), refresh_token: "fresh-gsc-read-grant", access_token: "discarded", scope: "openid email profile https://www.googleapis.com/auth/webmasters.readonly" }));
    expect((await f.finish(s)).status).toBe(200);
    expect(f.grant).toHaveBeenCalledWith(expect.objectContaining({ clientId, refreshToken: "fresh-gsc-read-grant", profile: { subject: "synthetic-google-subject-1", name: "Reader Example", email: "reader@example.test" } }));
  });
  it.each([
    ["missing refresh token", { refresh_token: undefined, scope: "https://www.googleapis.com/auth/webmasters.readonly" }],
    ["missing read-only scope", { refresh_token: "fresh", scope: "openid email profile" }],
    ["write grant", { refresh_token: "fresh", scope: "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/webmasters" }],
  ])("refuses a GSC %s without replacing the existing grant", async (_label, grant) => {
    const f = fixture({ gsc: true }); const s = await f.start(true);
    f.exchange.mockImplementation(async () => ({ id_token: token(f.payload()), access_token: "discarded", ...grant }) as never);
    expect((await f.finish(s)).status).toBe(400); expect(f.grant).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
  });
  it("requires a verified Google identity before accepting a new GSC refresh grant", async () => {
    const f = fixture({ gsc: true }); const s = await f.start(true);
    f.setClaims({ nonce: "wrong" });
    f.exchange.mockImplementation(async () => ({ id_token: token(f.payload()), access_token: "discarded", refresh_token: "fresh", scope: "https://www.googleapis.com/auth/webmasters.readonly" }));
    expect((await f.finish(s)).status).toBe(400); expect(f.grant).not.toHaveBeenCalled();
  });
});

const gscScope = "https://www.googleapis.com/auth/webmasters.readonly";
const ga4Scope = "https://www.googleapis.com/auth/analytics.readonly";
const bothScopes = `openid email profile ${gscScope} ${ga4Scope}`;
function dataResponse(f: ReturnType<typeof fixture>, scope = bothScopes, extra: Record<string, unknown> = {}) {
  f.exchange.mockImplementation(async () => ({ id_token: token(f.payload()), refresh_token: "synthetic-data-refresh", access_token: "memory-only-data-token", expires_in: 3600, token_type: "Bearer", scope, ...extra }) as never);
}
async function connectData(f: ReturnType<typeof fixture>, scope = bothScopes) {
  const started = await f.start("data"); dataResponse(f, scope);
  expect((await f.finish(started)).status).toBe(200);
  return started;
}

describe("one Google connection for read-only Search Console and Analytics", () => {
  it("uses the system-browser loopback flow for both read-only data permissions without a pasted code", async () => {
    const f = fixture({ data: true }); const s = await f.start("data");
    expect(s.url.searchParams.get("scope")).toBe(bothScopes);
    expect(s.url.searchParams.get("access_type")).toBe("offline");
    expect(s.url.searchParams.get("prompt")).toBe("consent select_account");
    expect(s.url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(s.url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(s.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(s.url.href).not.toContain("urn:ietf:wg:oauth:2.0:oob");
  });
  it("requires an atomic encrypted persistence adapter before starting data consent", async () => {
    const f = fixture();
    await expect(f.account.startData()).rejects.toThrow("setup_required");
    expect(f.account.status().status).toBe("signed_out"); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [bothScopes, { gsc: true, ga4: true }],
    [`openid email profile ${gscScope}`, { gsc: true, ga4: false }],
    [`openid email profile ${ga4Scope}`, { gsc: false, ga4: true }],
    ["openid email profile", { gsc: false, ga4: false }],
  ])("records the actual granular grants from %s in one encrypted transaction", async (scopes, expected) => {
    const f = fixture({ data: true }); await connectData(f, scopes);
    expect(f.account.status()).toMatchObject({ status: "signed_in", capabilities: expected });
    expect(f.persistData).toHaveBeenCalledTimes(1); expect(f.persist).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled();
    const [session, grant] = f.persistData.mock.calls[0]!;
    expect(JSON.parse(session).dataScopes).toEqual(scopes.split(" "));
    expect(grant).toMatchObject({ clientId, refreshToken: "synthetic-data-refresh", profile: { subject: "synthetic-google-subject-1" }, capabilities: expected });
    expect(session).not.toContain("memory-only-data-token"); expect(JSON.stringify(f.account.status())).not.toContain("synthetic-data-refresh");
  });
  it.each(["https://www.googleapis.com/auth/webmasters", "https://www.googleapis.com/auth/analytics", "https://www.googleapis.com/auth/drive.readonly"])("rejects an unexpected broader or unrelated grant: %s", async unexpected => {
    const f = fixture({ data: true }), s = await f.start("data"); dataResponse(f, `${bothScopes} ${unexpected}`);
    expect((await f.finish(s)).status).toBe(400); expect(f.persistData).not.toHaveBeenCalled();
    expect(f.account.status().profile).toBeUndefined(); expect(f.account.status().capabilities).toBeUndefined();
  });
  it("does not activate a data grant if the encrypted transaction fails", async () => {
    const f = fixture({ data: true }), s = await f.start("data"); dataResponse(f);
    f.persistData.mockRejectedValue(new Error("private vault details"));
    expect((await f.finish(s)).status).toBe(400);
    expect(f.account.status()).toMatchObject({ status: "error", errorCode: "storage_unavailable" });
    expect(f.saved()).toBeUndefined(); expect(f.persist).not.toHaveBeenCalled();
  });
  it("does not reuse a previous account's refresh token when Google returns another subject", async () => {
    const f = fixture({ data: true }); await connectData(f); const saved = f.saved();
    const s = await f.start("data"); f.setClaims({ sub: "a-different-google-subject" }); dataResponse(f, bothScopes, { refresh_token: undefined });
    expect((await f.finish(s)).status).toBe(400); expect(f.saved()).toBe(saved); expect(f.persistData).toHaveBeenCalledTimes(1);
  });
  it("reuses only a same-client, same-subject refresh grant covering the consented data scopes", async () => {
    const f = fixture({ data: true }); await connectData(f);
    const s = await f.start("data"); dataResponse(f, bothScopes, { refresh_token: undefined });
    expect((await f.finish(s)).status).toBe(200);
    expect(f.persistData.mock.calls[1]![1]).toMatchObject({ refreshToken: "synthetic-data-refresh" });
    const narrower = fixture({ data: true }); await connectData(narrower, gscScope);
    const upgrade = await narrower.start("data"); dataResponse(narrower, bothScopes, { refresh_token: undefined });
    expect((await narrower.finish(upgrade)).status).toBe(400); expect(narrower.persistData).toHaveBeenCalledTimes(1);
  });
  it("restores the signed identity and saved independent capabilities without making a data API request", async () => {
    const f = fixture({ data: true }); await connectData(f, ga4Scope); const saved = f.saved(); f.account.dispose();
    const restored = fixture({ data: true }); restored.setSaved(saved);
    expect(await restored.account.restore()).toMatchObject({ status: "signed_in", capabilities: { gsc: false, ga4: true } });
    expect(restored.exchange).not.toHaveBeenCalled(); expect(restored.persistData).not.toHaveBeenCalled();
    expect(restored.fetcher.mock.calls.every(([url]) => !String(url).includes("analyticsdata"))).toBe(true);
  });
  it("refreshes an expired data identity, keeping the same subject, scopes and encrypted owner transaction", async () => {
    const f = fixture({ data: true }); await connectData(f);
    f.advance(3_601_000); f.setNonce(""); dataResponse(f, ga4Scope, { refresh_token: "rotated-refresh" });
    expect(await f.account.ensureFresh()).toMatchObject({ status: "signed_in", capabilities: { gsc: false, ga4: true } });
    expect(f.persistData).toHaveBeenCalledTimes(2);
    expect(f.persistData.mock.calls[1]![1]).toMatchObject({ refreshToken: "rotated-refresh", capabilities: { gsc: false, ga4: true } });
    expect(f.saved()).not.toContain("memory-only-data-token");
  });
  it("provides memory-only, same-account access tokens and deduplicates concurrent refreshes", async () => {
    const f = fixture({ data: true }); await connectData(f); f.setNonce("");
    const [gsc, ga4] = await Promise.all([f.account.dataToken("gsc"), f.account.dataToken("ga4")]);
    expect(gsc).toEqual({ accessToken: "memory-only-data-token", scopes: bothScopes.split(" ") }); expect(ga4).toEqual(gsc);
    expect(f.exchange).toHaveBeenCalledTimes(2);
    expect(await f.account.dataToken("gsc")).toEqual(gsc); expect(f.exchange).toHaveBeenCalledTimes(2);
    expect(f.saved()).not.toContain("memory-only-data-token");
    expect(JSON.stringify(f.account.status())).not.toContain("memory-only-data-token");
    ga4.scopes.length = 0; expect((await f.account.dataToken("gsc")).scopes).toHaveLength(5);
  });
  it("disables only the denied service when the token refresh returns narrower permissions", async () => {
    const f = fixture({ data: true }); await connectData(f); f.setNonce(""); dataResponse(f, ga4Scope);
    await expect(f.account.dataToken("gsc")).rejects.toThrow("access_denied");
    expect(f.account.status().capabilities).toEqual({ gsc: false, ga4: true });
    expect((await f.account.dataToken("ga4")).accessToken).toBe("memory-only-data-token");
    expect(f.exchange).toHaveBeenCalledTimes(2);
  });
  it("does not issue a token request for an ungranted feature or after the vault session changes", async () => {
    const f = fixture({ data: true }); await connectData(f, ga4Scope);
    await expect(f.account.dataToken("gsc")).rejects.toThrow("access_denied"); expect(f.exchange).toHaveBeenCalledTimes(1);
    f.setSaved(JSON.stringify({ version: 1, clientId, idToken: "tampered-session", dataScopes: [ga4Scope], refreshToken: "untrusted" }));
    await expect(f.account.dataToken("ga4")).rejects.toThrow("verification_failed"); expect(f.exchange).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["different subject", { sub: "different-google-user" }, bothScopes],
    ["unrequested privilege", {}, `${bothScopes} https://www.googleapis.com/auth/analytics`],
  ])("discards a token refresh with %s", async (_label, claims, scopes) => {
    const f = fixture({ data: true }); await connectData(f); const saved = f.saved(); f.setNonce(""); f.setClaims(claims); dataResponse(f, scopes);
    await expect(f.account.dataToken("gsc")).rejects.toThrow("verification_failed");
    expect(f.saved()).toBe(saved); expect(f.persistData).toHaveBeenCalledTimes(1);
  });
  it("clears the managed connection atomically at sign-out and discards a late data-token refresh", async () => {
    const f = fixture({ data: true }); await connectData(f); f.setNonce("");
    let complete!: (value: never) => void;
    f.exchange.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const waiting = f.account.dataToken("gsc"); const rejected = expect(waiting).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(f.exchange).toHaveBeenCalledTimes(2));
    await f.account.signOut();
    complete({ id_token: token(f.payload()), refresh_token: "late-data-refresh", access_token: "late-access", expires_in: 3600, scope: bothScopes } as never);
    await rejected;
    expect(f.disconnect).toHaveBeenCalledTimes(1); expect(f.persist).not.toHaveBeenCalled(); expect(f.persistData).toHaveBeenCalledTimes(1); expect(f.saved()).toBeUndefined();
  });
  it("supports a caller cancellation without cancelling another waiting service or returning the cancelled caller's token", async () => {
    const f = fixture({ data: true }); await connectData(f); f.setNonce("");
    let complete!: (value: never) => void;
    f.exchange.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const controller = new AbortController(), cancelled = f.account.dataToken("gsc", controller.signal);
    const rejected = expect(cancelled).rejects.toThrow("caller stopped"); const other = f.account.dataToken("ga4");
    await vi.waitFor(() => expect(f.exchange).toHaveBeenCalledTimes(2)); controller.abort(new Error("caller stopped"));
    await rejected;
    complete({ id_token: token(f.payload()), refresh_token: "synthetic-data-refresh", access_token: "shared-access", expires_in: 3600, scope: bothScopes } as never);
    expect((await other).accessToken).toBe("shared-access"); expect(f.exchange).toHaveBeenCalledTimes(2);
  });
  it("marks a revoked or expired refresh grant for reconnection without rewriting the previous vault session", async () => {
    const f = fixture({ data: true }); await connectData(f); const saved = f.saved();
    f.fetcher.mockImplementation(async () => Response.json({ error: "invalid_grant", error_description: "private provider detail" }, { status: 400 }));
    await expect(f.account.dataToken("gsc")).rejects.toThrow("expired");
    expect(f.account.status()).toMatchObject({ status: "error", errorCode: "expired" });
    expect(f.account.status().profile).toBeUndefined(); expect(f.account.status().capabilities).toBeUndefined(); expect(f.saved()).toBe(saved);
    expect(JSON.stringify(f.account.status())).not.toContain("private provider detail");
  });
  it("discards an expired data identity whose refresh would silently add an ungranted service", async () => {
    const f = fixture({ data: true }); await connectData(f, ga4Scope); const saved = f.saved();
    f.advance(3_601_000); f.setNonce(""); dataResponse(f, bothScopes);
    expect(await f.account.ensureFresh()).toMatchObject({ status: "error", errorCode: "verification_failed" });
    expect(f.saved()).toBe(saved); expect(f.persistData).toHaveBeenCalledTimes(1);
  });
  it("does not resurrect data access after disposal or an OAuth client change", async () => {
    const f = fixture({ data: true }); await connectData(f); f.account.dispose();
    await expect(f.account.dataToken("gsc")).rejects.toThrow("access_denied"); expect(f.exchange).toHaveBeenCalledTimes(1);
    const other = fixture({ data: true }); await connectData(other); other.setClient("different.apps.googleusercontent.com");
    await expect(other.account.dataToken("ga4")).rejects.toThrow("access_denied"); expect(other.exchange).toHaveBeenCalledTimes(1);
  });
  it("exposes a non-secret lifecycle revision across disconnect and reconnection to the same Google subject", async () => {
    const f = fixture({ data: true }); const first = f.account.status().sessionRevision!;
    await connectData(f); const signedIn = f.account.status().sessionRevision!; expect(signedIn).toBeGreaterThan(first);
    await f.account.signOut(); const signedOut = f.account.status().sessionRevision!; expect(signedOut).toBeGreaterThan(signedIn);
    await connectData(f); expect(f.account.status().sessionRevision).toBeGreaterThan(signedOut);
    expect(f.account.status().profile?.subject).toBe("synthetic-google-subject-1");
  });
  it("shares a pending identity restoration when both data services request access after expiry", async () => {
    const f = fixture({ data: true }); await connectData(f); f.advance(3_601_000); f.setNonce("");
    const tokens = await Promise.all([f.account.dataToken("gsc"), f.account.dataToken("ga4")]);
    expect(tokens.map(value => value.accessToken)).toEqual(["memory-only-data-token", "memory-only-data-token"]);
    expect(f.exchange).toHaveBeenCalledTimes(3); // one consent, one OIDC restoration, one shared API token refresh
    expect(f.account.status().capabilities).toEqual({ gsc: true, ga4: true });
  });
});

describe("safe fixed Google sign-in diagnostics", () => {
  it.each([
    ["invalid_request", "client_secret is missing.", "client_secret_missing", "unavailable"],
    ["invalid_client", "The OAuth client was not found.", "invalid_client", "unavailable"],
    ["invalid_grant", "private authorization-code detail", "invalid_grant", "expired"],
    ["unrecognized-provider-secret", "private token email@example.test https://private.example.test/", "provider_request_failed", "unavailable"],
  ])("classifies %s using fixed fields without reflecting provider material", async (error, description, detail, code) => {
    const f = fixture({ data: true }), s = await f.start("data"); f.setTokenStatus(400);
    f.exchange.mockResolvedValue({ error, error_description: description, access_token: "private-access-token", refresh_token: "private-refresh-token" } as never);
    const response = await f.finish(s); expect(response.status).toBe(400);
    expect(f.account.status()).toMatchObject({ status: "error", errorCode: code, errorPhase: "token_exchange", errorDetail: detail });
    const rendered = JSON.stringify(f.account.status()) + await response.text();
    for (const privateText of [description, "private-access-token", "private-refresh-token", "synthetic-authorization-code", s.state, s.redirect]) expect(rendered).not.toContain(privateText);
    expect(f.persistData).not.toHaveBeenCalled(); expect(f.account.status().profile).toBeUndefined();
  });
  it("does not infer a missing secret from an arbitrary provider description containing the same words", async () => {
    const f = fixture({ data: true }), s = await f.start("data"); f.setTokenStatus(400);
    const description = "client_secret is missing. private owner detail https://secret.example.test/";
    f.exchange.mockResolvedValue({ error: "invalid_request", error_description: description } as never);
    expect((await f.finish(s)).status).toBe(400);
    expect(f.account.status()).toMatchObject({ errorPhase: "token_exchange", errorDetail: "invalid_request" });
    expect(JSON.stringify(f.account.status())).not.toContain(description);
  });
  it("separates a missing identity token from JWT claim, nonce and signature failures", async () => {
    const missing = fixture({ data: true }), s = await missing.start("data");
    missing.exchange.mockResolvedValue({ access_token: "private-access", refresh_token: "private-refresh", scope: bothScopes } as never);
    expect((await missing.finish(s)).status).toBe(400);
    expect(missing.account.status()).toMatchObject({ errorPhase: "token_exchange", errorDetail: "id_token_missing" });
    const claim = fixture({ data: true }), c = await claim.start("data"); dataResponse(claim); claim.setClaims({ aud: "wrong.apps.googleusercontent.com" });
    expect((await claim.finish(c)).status).toBe(400);expect(claim.account.status()).toMatchObject({ errorPhase: "identity_verification", errorDetail: "id_token_claims_invalid" });
    const nonce = fixture({ data: true }), n = await nonce.start("data"); dataResponse(nonce); nonce.setClaims({ nonce: "not-the-pending-nonce" });
    expect((await nonce.finish(n)).status).toBe(400);expect(nonce.account.status()).toMatchObject({ errorPhase: "identity_verification", errorDetail: "id_token_nonce_mismatch" });
    const signature = fixture({ data: true }), v = await signature.start("data"); dataResponse(signature); signature.setClaims({});
    signature.exchange.mockImplementation(async()=>{const parts=token(signature.payload()).split('.');parts[2]=Buffer.alloc(256,1).toString('base64url');return {id_token:parts.join('.'),refresh_token:'private-refresh',scope:bothScopes} as never;});
    expect((await signature.finish(v)).status).toBe(400);expect(signature.account.status()).toMatchObject({ errorPhase: "identity_verification", errorDetail: "id_token_signature_invalid" });
    for(const f of [missing,claim,nonce,signature])expect(f.persistData).not.toHaveBeenCalled();
  });
  it("reports unavailable Google signing keys without returning discovery or network details", async () => {
    const f=fixture({data:true}),s=await f.start('data');dataResponse(f);
    const original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>{if(String(url).includes('.well-known'))throw new Error('private DNS key details');return original(url,init);});
    expect((await f.finish(s)).status).toBe(400);expect(f.account.status()).toMatchObject({errorPhase:'identity_verification',errorDetail:'provider_keys_unavailable'});
    expect(JSON.stringify(f.account.status())).not.toContain('private DNS');expect(f.persistData).not.toHaveBeenCalled();
  });
  it("reports malformed provider JSON with a fixed token response error rather than a JSON parser excerpt", async()=>{
    const f=fixture({data:true}),s=await f.start('data');
    f.fetcher.mockResolvedValue(new Response('not-json private refresh token owner@example.test',{status:200}));
    expect((await f.finish(s)).status).toBe(400);expect(f.account.status()).toMatchObject({errorPhase:'token_exchange',errorDetail:'provider_response_invalid'});
    expect(JSON.stringify(f.account.status())).not.toContain('private refresh');
  });
  it("distinguishes encrypted persistence failure, authorization denial and callback timeout", async()=>{
    const storage=fixture({data:true}),s=await storage.start('data');dataResponse(storage);storage.persistData.mockRejectedValue(new Error('private vault path /somewhere'));
    expect((await storage.finish(s)).status).toBe(400);expect(storage.account.status()).toMatchObject({errorPhase:'secure_storage',errorDetail:'encrypted_storage_write_failed'});
    const denied=fixture({data:true});expect((await denied.finish(await denied.start('data'),{error:'access_denied',error_description:'private browser description'})).status).toBe(400);
    expect(denied.account.status()).toMatchObject({errorPhase:'authorization',errorDetail:'access_denied'});
    const expired=fixture({data:true,timeoutMs:15});await expired.start('data');await vi.waitFor(()=>expect(expired.account.status()).toMatchObject({errorPhase:'callback',errorDetail:'callback_expired'}));
    expect(JSON.stringify(storage.account.status())+JSON.stringify(denied.account.status())).not.toContain('private');
  });
  it("clears old fixed diagnostics on a new attempt, successful login and explicit sign-out", async()=>{
    const f=fixture({data:true}),s=await f.start('data');f.setTokenStatus(400);f.exchange.mockResolvedValue({error:'invalid_client'} as never);await f.finish(s);
    expect(f.account.status().errorDetail).toBe('invalid_client');const retry=await f.start('data');expect(f.account.status().errorDetail).toBeUndefined();expect(f.account.status().errorPhase).toBeUndefined();
    f.setTokenStatus(200);dataResponse(f);expect((await f.finish(retry)).status).toBe(200);expect(f.account.status().errorDetail).toBeUndefined();await f.account.signOut();expect(f.account.status().errorPhase).toBeUndefined();
  });
  it("keeps refresh-provider diagnostics distinct from initial code exchange", async()=>{
    const f=fixture({data:true});await connectData(f);f.advance(3_601_000);f.setNonce('');f.setTokenStatus(400);f.exchange.mockResolvedValue({error:'invalid_client',error_description:'private refresh detail'} as never);
    expect(await f.account.ensureFresh()).toMatchObject({status:'error',errorPhase:'refresh',errorDetail:'invalid_client'});expect(JSON.stringify(f.account.status())).not.toContain('private refresh detail');
  });
});
