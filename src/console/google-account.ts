import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DISCOVERY_ENDPOINT = "https://accounts.google.com/.well-known/openid-configuration";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const MAX_SESSION_BYTES = 32_768;
const GSC_READ_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GA4_READ_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const DATA_SCOPES = [GSC_READ_SCOPE, GA4_READ_SCOPE] as const;
const ALLOWED_DATA_SCOPES = new Set<string>(["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", ...DATA_SCOPES]);

export type GoogleAccountProfile = { subject: string; name: string; email: string };
export type GoogleDataCapabilities = { gsc: boolean; ga4: boolean };
export type GoogleDataGrant = {
  clientId: string; clientSecret?: string; refreshToken?: string;
  profile: GoogleAccountProfile; capabilities: GoogleDataCapabilities; scopes: string[];
};
export type GoogleAccountErrorCode = "setup_required" | "access_denied" | "expired" | "cancelled" | "verification_failed" | "storage_unavailable" | "unavailable";
export type GoogleAccountErrorPhase = "configuration" | "authorization" | "callback" | "token_exchange" | "identity_verification" | "secure_storage" | "refresh";
export type GoogleAccountErrorDetail = "client_secret_missing" | "invalid_client" | "invalid_grant" | "invalid_request" | "unauthorized_client" | "redirect_uri_mismatch" | "invalid_scope" | "access_denied" | "temporarily_unavailable" | "provider_request_failed" | "provider_response_invalid" | "id_token_missing" | "id_token_signature_invalid" | "id_token_claims_invalid" | "id_token_nonce_mismatch" | "provider_keys_unavailable" | "encrypted_storage_write_failed" | "callback_expired" | "callback_invalid" | "configuration_missing";
export type GoogleAccountStatus = {
  configured: boolean;
  status: "setup_required" | "signed_out" | "pending" | "restoring" | "signed_in" | "error";
  profile?: GoogleAccountProfile;
  expiresAt?: string;
  errorCode?: GoogleAccountErrorCode;
  /** Fixed authored diagnostics only; never provider messages, URLs or credential material. */
  errorPhase?: GoogleAccountErrorPhase;
  errorDetail?: GoogleAccountErrorDetail;
  capabilities?: GoogleDataCapabilities;
  /** Non-secret lifecycle revision for discarding reads started before an account transition. */
  sessionRevision?: number;
};
export type GoogleAccountOptions = {
  config: () => { clientId?: string; clientSecret?: string };
  /** The host provides encrypted storage; no saved tokens are exposed as editable settings. */
  readSession: () => string | undefined;
  persistSession: (value: string | undefined) => void | Promise<void>;
  /** Atomically persist the verified identity and its data grant in the encrypted vault. */
  persistDataSession?: (session: string, grant: GoogleDataGrant) => void | Promise<void>;
  /** Atomically remove the managed identity/data connection; preserve unrelated legacy connections. */
  onDisconnect?: () => void | Promise<void>;
  /** Only the separate, explicit Search Console action requests this grant. */
  onGscGrant?: (grant: { clientId: string; clientSecret?: string; refreshToken: string; profile: GoogleAccountProfile }) => void | Promise<void>;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};
type SavedSession = { version: 1; clientId: string; idToken: string; refreshToken?: string; nonce?: string; dataScopes?: string[] };
type VerifiedIdentity = { profile: GoogleAccountProfile; expires: number; nonce?: string };
type PendingSignIn = {
  generation: number; clientId: string; clientSecret?: string; state: string; nonce: string;
  verifier: string; redirectUri: string; expires: number; server: Server; timer?: ReturnType<typeof setTimeout>;
  purpose: "identity" | "gsc" | "data";
};
type SigningKey = JsonWebKey & { kid?: string; use?: string; alg?: string };

class AccountError extends Error {
  constructor(readonly code: GoogleAccountErrorCode, readonly detail?: GoogleAccountErrorDetail, readonly errorPhase?: GoogleAccountErrorPhase) { super(code); }
}
function tokenFailure(data: Record<string, unknown>, phase: GoogleAccountErrorPhase): AccountError {
  // Exact known descriptions identify a missing parameter without ever retaining
  // or returning Google's raw description (which can contain private details).
  const description = typeof data.error_description === "string" && data.error_description.length <= 4096 ? data.error_description.trim().toLowerCase() : "";
  if ((data.error === "invalid_request" || data.error === "invalid_client") && /^(?:client_secret is missing\.?|client_secret (?:is )?required\.?|missing (?:required )?parameter:?[ ]*['"]?client_secret['"]?\.?)$/.test(description)) return new AccountError("unavailable", "client_secret_missing", phase);
  switch (data.error) {
    case "invalid_client": case "invalid_request": case "unauthorized_client": case "redirect_uri_mismatch": case "invalid_scope":
      return new AccountError("unavailable", data.error, phase);
    case "invalid_grant": return new AccountError("expired", "invalid_grant", phase);
    case "access_denied": return new AccountError("access_denied", "access_denied", phase);
    case "temporarily_unavailable": case "server_error": return new AccountError("unavailable", "temporarily_unavailable", phase);
    default: return new AccountError("unavailable", "provider_request_failed", phase);
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function same(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validClientId(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,250}\.apps\.googleusercontent\.com$/.test(value);
}
function text(value: unknown, max: number) { return typeof value === "string" && value.length <= max ? value : undefined; }
function parseSegment(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new AccountError("verification_failed");
  const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!isRecord(decoded)) throw new AccountError("verification_failed");
  return decoded;
}
function parseSaved(value: string): SavedSession {
  if (Buffer.byteLength(value) > MAX_SESSION_BYTES) throw new AccountError("verification_failed");
  const data: unknown = JSON.parse(value);
  if (!isRecord(data) || data.version !== 1 || !validClientId(text(data.clientId, 300)) ||
    !text(data.idToken, 16_384) || (data.nonce !== undefined && !text(data.nonce, 256)) ||
    (data.refreshToken !== undefined && !text(data.refreshToken, 8192)) ||
    (data.dataScopes !== undefined && (!Array.isArray(data.dataScopes) || data.dataScopes.length > 10 || data.dataScopes.some(scope => typeof scope !== "string" || !ALLOWED_DATA_SCOPES.has(scope))))) throw new AccountError("verification_failed");
  return data as SavedSession;
}
function readOnlyScopes(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 4096) throw new AccountError("verification_failed");
  const scopes = [...new Set(value.split(/\s+/).filter(Boolean))];
  if (scopes.some(scope => !ALLOWED_DATA_SCOPES.has(scope))) throw new AccountError("verification_failed");
  return scopes;
}
function capabilities(scopes: readonly string[]): GoogleDataCapabilities {
  return { gsc: scopes.includes(GSC_READ_SCOPE), ga4: scopes.includes(GA4_READ_SCOPE) };
}
function waitWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new AccountError("cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(value => { signal.removeEventListener("abort", aborted); signal.aborted ? aborted() : resolve(value); }, error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
function callbackResponse(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Pragma": "no-cache",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Connection": "close",
  });
  // All content is authored static copy; no callback query or identity is echoed.
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>getaudit</title><body><h1>getaudit</h1><p>${message}</p><p>You can close this tab and return to getaudit.</p></body></html>`);
}

/** Desktop OIDC with an explicitly requested, account-bound read-only data connection. */
export class GoogleAccount {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private generation = 0;
  private pending?: PendingSignIn;
  private identity?: VerifiedIdentity;
  private identityClientId?: string;
  private saved?: SavedSession;
  private phase: GoogleAccountStatus["status"] = "signed_out";
  private errorCode?: GoogleAccountErrorCode;
  private errorPhase?: GoogleAccountErrorPhase;
  private errorDetail?: GoogleAccountErrorDetail;
  private restoring?: Promise<GoogleAccountStatus>;
  private writes: Promise<unknown> = Promise.resolve();
  private keyCache?: { keys: SigningKey[]; expires: number };
  private disposed = false;
  private dataAccess?: { generation: number; clientId: string; subject: string; session: string; accessToken: string; scopes: string[]; expires: number };
  private dataRefreshing?: { generation: number; operation: Promise<{ accessToken: string; scopes: string[] }> };

  constructor(private readonly options: GoogleAccountOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.max(10, Math.min(options.timeoutMs ?? 300_000, 600_000));
  }

  status(): GoogleAccountStatus {
    const config = this.options.config();
    if (!validClientId(config.clientId)) return { configured: false, status: "setup_required", errorCode: "setup_required", errorPhase: "configuration", errorDetail: "configuration_missing", sessionRevision: this.generation };
    if (this.identity && (this.identityClientId !== config.clientId || this.identity.expires <= this.now())) {
      this.identity = undefined;
      if (this.phase === "signed_in") this.phase = "signed_out";
    }
    if (this.pending && this.pending.clientId !== config.clientId) this.cancelPending();
    return {
      configured: true, status: this.phase, sessionRevision: this.generation,
      ...(this.identity && this.phase === "signed_in" ? { profile: { ...this.identity.profile }, expiresAt: new Date(this.identity.expires).toISOString(), ...(this.saved?.dataScopes ? { capabilities: capabilities(this.saved.dataScopes) } : {}) } : {}),
      ...(this.pending ? { expiresAt: new Date(this.pending.expires).toISOString() } : {}),
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      ...(this.phase === "error" && this.errorPhase ? { errorPhase: this.errorPhase } : {}),
      ...(this.phase === "error" && this.errorDetail ? { errorDetail: this.errorDetail } : {}),
    };
  }

  private clearFailure() { this.errorCode = undefined; this.errorPhase = undefined; this.errorDetail = undefined; }
  private fail(error: unknown, phase: GoogleAccountErrorPhase, fallback?: GoogleAccountErrorDetail) {
    this.phase = "error";
    this.errorCode = error instanceof AccountError ? error.code : "verification_failed";
    this.errorPhase = error instanceof AccountError && error.errorPhase ? error.errorPhase : phase;
    this.errorDetail = error instanceof AccountError && error.detail ? error.detail : fallback ?? (phase === "secure_storage" ? "encrypted_storage_write_failed" : phase === "identity_verification" ? "id_token_claims_invalid" : "provider_request_failed");
  }

  /** Call after the connection vault is ready; concurrent calls share one verification. */
  restore(): Promise<GoogleAccountStatus> {
    if (this.restoring) return this.restoring;
    const operation = this.restoreSaved();
    this.restoring = operation;
    void operation.finally(() => { if (this.restoring === operation) this.restoring = undefined; });
    return operation;
  }

  /** Used by account status polling; no refresh while a user sign-in is pending. */
  async ensureFresh(): Promise<GoogleAccountStatus> {
    const status = this.status();
    if (this.disposed || status.status === "setup_required" || status.status === "pending" || status.status === "restoring" || status.status === "signed_in" || status.status === "error") return status;
    if (this.options.readSession()) return this.restore();
    return status;
  }

  async start(): Promise<{ url: string; expiresAt: string }> {
    return this.begin("identity");
  }

  async startGsc(): Promise<{ url: string; expiresAt: string }> {
    if (!this.options.onGscGrant) throw new AccountError("setup_required");
    return this.begin("gsc");
  }

  async startData(): Promise<{ url: string; expiresAt: string }> {
    if (!this.options.persistDataSession) throw new AccountError("setup_required");
    return this.begin("data");
  }

  /** Server-only API credential. Access tokens never enter status, disk or renderer responses. */
  async dataToken(service: "gsc" | "ga4", signal?: AbortSignal): Promise<{ accessToken: string; scopes: string[] }> {
    signal?.throwIfAborted();
    let status = await waitWithSignal(this.ensureFresh(), signal);
    if (status.status === "restoring" && this.restoring) status = await waitWithSignal(this.restoring, signal);
    const generation = this.generation, clientId = this.options.config().clientId;
    if (!clientId || status.status !== "signed_in" || !status.profile || !status.capabilities?.[service]) throw new AccountError("access_denied");
    const raw = this.options.readSession();
    if (!raw || raw !== JSON.stringify(this.saved)) throw new AccountError("verification_failed");
    const saved = parseSaved(raw);
    const identity = await waitWithSignal(this.verifyToken(saved.idToken, clientId, { nonce: saved.nonce, subject: status.profile.subject }), signal);
    if (!this.current(generation, clientId) || this.identity?.profile.subject !== identity.profile.subject) throw new AccountError("cancelled");
    const cached = this.dataAccess;
    if (cached && cached.generation === generation && cached.clientId === clientId && cached.subject === identity.profile.subject && cached.session === raw && cached.expires > this.now()) {
      signal?.throwIfAborted();
      return { accessToken: cached.accessToken, scopes: [...cached.scopes] };
    }
    let refreshing = this.dataRefreshing;
    if (!refreshing || refreshing.generation !== generation) {
      const operation = this.refreshDataToken(saved, identity, generation);
      refreshing = { generation, operation }; this.dataRefreshing = refreshing;
      void operation.then(() => { if (this.dataRefreshing?.operation === operation) this.dataRefreshing = undefined; }, () => { if (this.dataRefreshing?.operation === operation) this.dataRefreshing = undefined; });
    }
    let token: { accessToken: string; scopes: string[] };
    try { token = await waitWithSignal(refreshing.operation, signal); }
    catch (error) {
      if (this.current(generation, clientId) && error instanceof AccountError && error.code === "expired") {
        this.dataAccess = undefined; this.identity = undefined; this.fail(error, "refresh");
      }
      throw error;
    }
    const required = service === "gsc" ? GSC_READ_SCOPE : GA4_READ_SCOPE;
    if (!this.current(generation, clientId) || this.identity?.profile.subject !== identity.profile.subject) throw new AccountError("cancelled");
    if (!token.scopes.includes(required)) throw new AccountError("access_denied");
    return { accessToken: token.accessToken, scopes: [...token.scopes] };
  }

  private async refreshDataToken(saved: SavedSession, identity: VerifiedIdentity, generation: number): Promise<{ accessToken: string; scopes: string[] }> {
    if (!saved.refreshToken || !saved.dataScopes) throw new AccountError("access_denied");
    const config = this.options.config();
    const body = new URLSearchParams({ client_id: saved.clientId, refresh_token: saved.refreshToken, grant_type: "refresh_token" });
    if (config.clientSecret) body.set("client_secret", config.clientSecret);
    const tokens = await this.fetchJson(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }, "refresh");
    const accessToken = text(tokens.access_token, 16_384);
    const scopes = tokens.scope === undefined ? [...saved.dataScopes] : readOnlyScopes(tokens.scope);
    if (!accessToken || typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 86_400 || (tokens.token_type !== undefined && tokens.token_type !== "Bearer")) throw new AccountError("verification_failed", "provider_response_invalid", "refresh");
    let fresh = identity;
    if (tokens.id_token !== undefined) {
      const idToken = text(tokens.id_token, 16_384); if (!idToken) throw new AccountError("verification_failed", "id_token_missing", "refresh");
      fresh = await this.verifyToken(idToken, saved.clientId, { subject: identity.profile.subject, nonce: saved.nonce, nonceOptional: true });
      saved = { ...saved, idToken, nonce: fresh.nonce };
    }
    // A refresh cannot silently add a previously unconsented capability.
    if (scopes.some(scope => DATA_SCOPES.includes(scope as typeof DATA_SCOPES[number]) && !saved.dataScopes!.includes(scope))) throw new AccountError("verification_failed");
    saved = { ...saved, dataScopes: scopes, ...(text(tokens.refresh_token, 8192) ? { refreshToken: tokens.refresh_token as string } : {}) };
    if (!this.current(generation, saved.clientId) || this.identity?.profile.subject !== identity.profile.subject) throw new AccountError("cancelled");
    await this.persist(saved, this.dataGrant(saved, fresh, config.clientSecret), generation);
    if (!this.current(generation, saved.clientId) || this.identity?.profile.subject !== identity.profile.subject) throw new AccountError("cancelled");
    this.saved = saved; this.identity = fresh;
    this.dataAccess = { generation, clientId: saved.clientId, subject: fresh.profile.subject, session: JSON.stringify(saved), accessToken, scopes, expires: this.now() + Math.max(0, tokens.expires_in * 1000 - 30_000) };
    return { accessToken, scopes };
  }

  private dataGrant(saved: SavedSession, identity: VerifiedIdentity, clientSecret?: string): GoogleDataGrant {
    return { clientId: saved.clientId, ...(clientSecret ? { clientSecret } : {}), ...(saved.refreshToken ? { refreshToken: saved.refreshToken } : {}), profile: { ...identity.profile }, capabilities: capabilities(saved.dataScopes ?? []), scopes: [...saved.dataScopes ?? []] };
  }

  private async begin(purpose: "identity" | "gsc" | "data"): Promise<{ url: string; expiresAt: string }> {
    if (this.disposed) throw new AccountError("unavailable");
    const config = this.options.config();
    if (!validClientId(config.clientId)) throw new AccountError("setup_required");
    if (config.clientSecret && config.clientSecret.length > 2000) throw new AccountError("setup_required");
    this.generation++;
    this.dataAccess = undefined; this.dataRefreshing = undefined;
    this.cancelPending();
    this.identity = undefined;
    this.phase = "pending";
    this.clearFailure();
    const generation = this.generation;
    const server = createServer((request, response) => { void this.callback(request.method, request.url, request.headers.host, response, generation); });
    server.headersTimeout = 5000; server.requestTimeout = 10_000; server.maxConnections = 8;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      if (this.disposed || generation !== this.generation) { server.close(); throw new AccountError("cancelled"); }
      const address = server.address();
      if (!address || typeof address === "string") throw new AccountError("unavailable");
      const pending: PendingSignIn = {
        generation, clientId: config.clientId, clientSecret: config.clientSecret, purpose,
        state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url"),
        verifier: randomBytes(48).toString("base64url"), redirectUri: `http://127.0.0.1:${address.port}/`,
        expires: this.now() + this.timeoutMs, server,
      };
      this.pending = pending;
      pending.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.cancelPending(); this.fail(new AccountError("expired", "callback_expired"), "callback");
      }, this.timeoutMs);
      pending.timer.unref(); server.unref();
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: config.clientId, redirect_uri: pending.redirectUri, response_type: "code", scope: `openid email profile${purpose === "data" ? " " + DATA_SCOPES.join(" ") : purpose === "gsc" ? " " + GSC_READ_SCOPE : ""}`,
        state: pending.state, nonce: pending.nonce, code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"),
        access_type: "offline", prompt: purpose === "identity" ? "select_account" : "consent select_account",
      }).toString();
      return { url: url.href, expiresAt: new Date(pending.expires).toISOString() };
    } catch (error) {
      server.close();
      if (generation === this.generation && !this.disposed) this.fail(error instanceof AccountError ? error : new AccountError("unavailable"), "callback", "callback_invalid");
      throw new AccountError(error instanceof AccountError ? error.code : "unavailable");
    }
  }

  /** Local sign-out removes the managed connection without a remote revocation request. */
  async signOut(): Promise<void> {
    this.generation++;
    this.cancelPending();
    this.identity = undefined; this.identityClientId = undefined; this.saved = undefined;
    this.dataAccess = undefined; this.dataRefreshing = undefined;
    this.phase = "signed_out"; this.clearFailure();
    try { await this.persist(undefined); }
    catch { const error = new AccountError("storage_unavailable", "encrypted_storage_write_failed", "secure_storage"); this.fail(error, "secure_storage"); throw error; }
  }

  dispose(): void {
    this.disposed = true; this.generation++; this.cancelPending();
    this.dataAccess = undefined; this.dataRefreshing = undefined;
    this.identity = undefined; this.saved = undefined; this.phase = "signed_out"; this.clearFailure();
  }

  private cancelPending() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer); this.pending.server.close(); this.pending = undefined;
    if (this.phase === "pending") this.phase = "signed_out";
  }

  private current(generation: number, clientId: string) {
    return !this.disposed && generation === this.generation && this.options.config().clientId === clientId;
  }

  private async callback(method: string | undefined, path: string | undefined, host: string | undefined, response: ServerResponse, generation: number) {
    const pending = this.pending;
    if (!pending || pending.generation !== generation || !this.current(generation, pending.clientId)) { callbackResponse(response, 410, "This sign-in request is no longer active."); return; }
    if (method !== "GET" || (path?.length ?? 0) > 16_384 || host !== new URL(pending.redirectUri).host) { callbackResponse(response, 400, "This sign-in response was not accepted."); return; }
    let url: URL;
    try { url = new URL(path ?? "/", pending.redirectUri); }
    catch { callbackResponse(response, 400, "This sign-in response was not accepted."); return; }
    if (url.origin !== new URL(pending.redirectUri).origin || url.pathname !== "/") { callbackResponse(response, 404, "This page is not part of sign-in."); return; }
    if (url.searchParams.getAll("state").length !== 1 || !same(url.searchParams.get("state") ?? "", pending.state)) { callbackResponse(response, 401, "The sign-in response did not match this request."); return; }
    if (pending.expires <= this.now()) { this.cancelPending(); this.fail(new AccountError("expired", "callback_expired"), "callback"); callbackResponse(response, 410, "This sign-in request has expired."); return; }
    this.cancelPending(); // A matching callback is consumed before any asynchronous exchange.
    this.phase = "restoring";
    if (url.searchParams.has("error")) {
      this.fail(tokenFailure({ error: url.searchParams.get("error") }, "authorization"), "authorization");
      callbackResponse(response, 400, "Google sign-in was not completed."); return;
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 4096 || url.searchParams.getAll("code").length !== 1) { this.fail(new AccountError("verification_failed", "callback_invalid"), "callback"); callbackResponse(response, 400, "Google sign-in could not be verified."); return; }
    let failurePhase: GoogleAccountErrorPhase = "token_exchange";
    try {
      const body = new URLSearchParams({ client_id: pending.clientId, code, code_verifier: pending.verifier, grant_type: "authorization_code", redirect_uri: pending.redirectUri });
      if (pending.clientSecret) body.set("client_secret", pending.clientSecret);
      const tokens = await this.fetchJson(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
      const idToken = text(tokens.id_token, 16_384);
      if (!idToken) throw new AccountError("verification_failed", "id_token_missing", "token_exchange");
      failurePhase = "identity_verification";
      const identity = await this.verifyToken(idToken, pending.clientId, { nonce: pending.nonce });
      failurePhase = "token_exchange";
      const refreshToken = text(tokens.refresh_token, 8192);
      const dataScopes = pending.purpose === "data" ? readOnlyScopes(tokens.scope ?? "") : undefined;
      if (pending.purpose === "gsc") {
        const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/) : [];
        if (!refreshToken || !scopes.includes(GSC_READ_SCOPE) || scopes.includes("https://www.googleapis.com/auth/webmasters") || !this.options.onGscGrant) throw new AccountError("verification_failed");
        if (!this.current(generation, pending.clientId)) throw new AccountError("cancelled");
        try {
          await this.options.onGscGrant({ clientId: pending.clientId, clientSecret: pending.clientSecret, refreshToken, profile: { ...identity.profile } });
        } catch { throw new AccountError("storage_unavailable", "encrypted_storage_write_failed", "secure_storage"); }
      }
      // Google may omit a new refresh token on a later consent. Reuse only a
      // previously verified session for this exact subject and OAuth client.
      let previousRefresh: string | undefined;
      const previousRaw = this.options.readSession();
      if (!refreshToken && previousRaw) {
        try {
          const previous = parseSaved(previousRaw);
          if (previous.clientId === pending.clientId) {
            const old = await this.verifyToken(previous.idToken, pending.clientId, { nonce: previous.nonce, allowExpired: true });
            if (old.profile.subject === identity.profile.subject && (dataScopes === undefined || dataScopes.filter(scope => DATA_SCOPES.includes(scope as typeof DATA_SCOPES[number])).every(scope => previous.dataScopes?.includes(scope)))) previousRefresh = previous.refreshToken;
          }
        } catch { /* An unrelated or invalid old identity is never reused. */ }
      }
      if (!this.current(generation, pending.clientId)) throw new AccountError("cancelled");
      const saved: SavedSession = { version: 1, clientId: pending.clientId, idToken, nonce: pending.nonce, ...(refreshToken || previousRefresh ? { refreshToken: refreshToken ?? previousRefresh } : {}), ...(dataScopes ? { dataScopes } : {}) };
      if (dataScopes?.some(scope => DATA_SCOPES.includes(scope as typeof DATA_SCOPES[number])) && !saved.refreshToken) throw new AccountError("verification_failed", "provider_response_invalid", "token_exchange");
      failurePhase = "secure_storage";
      await this.persist(saved, dataScopes ? this.dataGrant(saved, identity, pending.clientSecret) : undefined, generation);
      if (!this.current(generation, pending.clientId)) throw new AccountError("cancelled");
      this.saved = saved; this.identity = identity; this.identityClientId = pending.clientId;
      this.phase = "signed_in"; this.clearFailure();
      callbackResponse(response, 200, pending.purpose === "data" ? "You are connected. Your search desk is waiting in getaudit." : "You are signed in. Your workspace is waiting in getaudit.");
    } catch (error) {
      if (this.current(generation, pending.clientId)) {
        this.fail(error, failurePhase, failurePhase === "token_exchange" ? "provider_response_invalid" : undefined);
      }
      callbackResponse(response, 400, "Google sign-in could not be completed. Return to getaudit and try again.");
    }
  }

  private async restoreSaved(): Promise<GoogleAccountStatus> {
    const config = this.options.config(), raw = this.options.readSession();
    if (this.disposed || !validClientId(config.clientId) || !raw || this.pending || this.phase === "pending" || this.phase === "restoring") return this.status();
    const generation = this.generation;
    this.phase = "restoring"; this.clearFailure();
    let failurePhase: GoogleAccountErrorPhase = "identity_verification";
    try {
      let saved = parseSaved(raw);
      if (saved.clientId !== config.clientId) { this.phase = "signed_out"; return this.status(); }
      let identity = await this.verifyToken(saved.idToken, config.clientId, { nonce: saved.nonce, allowExpired: true });
      if (identity.expires <= this.now()) {
        if (!saved.refreshToken) throw new AccountError("expired", "invalid_grant", "refresh");
        failurePhase = "refresh";
        const body = new URLSearchParams({ client_id: config.clientId, refresh_token: saved.refreshToken, grant_type: "refresh_token" });
        if (config.clientSecret) body.set("client_secret", config.clientSecret);
        const tokens = await this.fetchJson(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }, "refresh");
        const idToken = text(tokens.id_token, 16_384);
        if (!idToken) throw new AccountError("verification_failed", "id_token_missing", "refresh");
        failurePhase = "identity_verification";
        const fresh = await this.verifyToken(idToken, config.clientId, { subject: identity.profile.subject, nonce: saved.nonce, nonceOptional: true });
        const dataScopes = saved.dataScopes === undefined ? undefined : tokens.scope === undefined ? saved.dataScopes : readOnlyScopes(tokens.scope);
        if (dataScopes?.some(scope => DATA_SCOPES.includes(scope as typeof DATA_SCOPES[number]) && !saved.dataScopes!.includes(scope))) throw new AccountError("verification_failed");
        saved = { ...saved, idToken, ...(text(tokens.refresh_token, 8192) ? { refreshToken: tokens.refresh_token as string } : {}), nonce: fresh.nonce, ...(dataScopes ? { dataScopes } : {}) };
        identity = fresh;
        if (!this.current(generation, config.clientId)) return this.status();
        failurePhase = "secure_storage";
        await this.persist(saved, saved.dataScopes ? this.dataGrant(saved, fresh, config.clientSecret) : undefined, generation);
      }
      if (!this.current(generation, config.clientId)) return this.status();
      this.saved = saved; this.identity = identity; this.identityClientId = config.clientId;
      this.phase = "signed_in"; this.clearFailure();
    } catch (error) {
      if (this.current(generation, config.clientId)) {
        this.identity = undefined; this.fail(error, failurePhase);
      }
    }
    return this.status();
  }

  private persist(saved: SavedSession | undefined, grant?: GoogleDataGrant, generation?: number) {
    const serialized = saved ? JSON.stringify(saved) : undefined;
    if (serialized && Buffer.byteLength(serialized) > MAX_SESSION_BYTES) return Promise.reject(new AccountError("verification_failed"));
    const write = this.writes.then(async () => {
      if (generation !== undefined && (generation !== this.generation || this.disposed || saved?.clientId !== this.options.config().clientId)) throw new AccountError("cancelled");
      try {
        if (!saved && this.options.onDisconnect) await this.options.onDisconnect();
        else if (grant) {
          if (!serialized || !this.options.persistDataSession) throw new AccountError("setup_required");
          await this.options.persistDataSession(serialized, grant);
        } else await this.options.persistSession(serialized);
      }
      catch { throw new AccountError("storage_unavailable", "encrypted_storage_write_failed", "secure_storage"); }
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  private async fetchJson(url: string, init: RequestInit = {}, phase: GoogleAccountErrorPhase = url === TOKEN_ENDPOINT ? "token_exchange" : "identity_verification") {
    let response: Response;
    try { response = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new AccountError("unavailable", "provider_request_failed", phase); }
    if (Number(response.headers.get("content-length") ?? 0) > 131_072 || !response.body) throw new AccountError("verification_failed", "provider_response_invalid", phase);
    const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 131_072) throw new AccountError("verification_failed", "provider_response_invalid", phase);
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw new AccountError("unavailable", "provider_request_failed", phase);
    } finally { await reader.cancel().catch(() => undefined); }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new AccountError("verification_failed", "provider_response_invalid", phase); }
    if (!isRecord(data)) throw new AccountError("verification_failed", "provider_response_invalid", phase);
    if (!response.ok) throw url === TOKEN_ENDPOINT ? tokenFailure(data, phase) : new AccountError("unavailable", "provider_request_failed", phase);
    return data;
  }

  private async keys(force = false): Promise<SigningKey[]> {
    if (!force && this.keyCache && this.keyCache.expires > this.now()) return this.keyCache.keys;
    const discovery = await this.fetchJson(DISCOVERY_ENDPOINT);
    // Discovery is provider-controlled, but cannot redirect a token verifier to
    // an arbitrary host or a caller-supplied JWKS URL.
    if (discovery.issuer !== "https://accounts.google.com" || discovery.jwks_uri !== JWKS_ENDPOINT) throw new AccountError("verification_failed");
    const data = await this.fetchJson(JWKS_ENDPOINT);
    if (!Array.isArray(data.keys) || data.keys.length > 20) throw new AccountError("verification_failed");
    const keys = data.keys.filter((key): key is SigningKey => isRecord(key) && key.kty === "RSA" && typeof key.kid === "string" && typeof key.n === "string" && typeof key.e === "string" && (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256"));
    if (!keys.length) throw new AccountError("verification_failed");
    // A short cache limits requests and still allows one forced refresh on kid rotation.
    this.keyCache = { keys, expires: this.now() + 300_000 };
    return keys;
  }

  private async verifyToken(token: string, clientId: string, expected: { nonce?: string; nonceOptional?: boolean; subject?: string; allowExpired?: boolean }): Promise<VerifiedIdentity> {
    try { return await this.verifyTokenClaims(token, clientId, expected); }
    catch (error) {
      if (error instanceof AccountError && error.detail) throw error;
      throw new AccountError("verification_failed", "id_token_claims_invalid", "identity_verification");
    }
  }

  private async verifyTokenClaims(token: string, clientId: string, expected: { nonce?: string; nonceOptional?: boolean; subject?: string; allowExpired?: boolean }): Promise<VerifiedIdentity> {
    if (token.length > 16_384) throw new AccountError("verification_failed");
    const parts = token.split(".");
    if (parts.length !== 3) throw new AccountError("verification_failed");
    const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];
    const header = parseSegment(encodedHeader), payload = parseSegment(encodedPayload);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256 || header.crit !== undefined || !/^[a-zA-Z0-9_-]+$/.test(signature)) throw new AccountError("verification_failed", "id_token_signature_invalid", "identity_verification");
    let key: SigningKey | undefined;
    try {
      let keys = await this.keys(); key = keys.find((candidate) => candidate.kid === header.kid);
      if (!key) { keys = await this.keys(true); key = keys.find((candidate) => candidate.kid === header.kid); }
    } catch { throw new AccountError("verification_failed", "provider_keys_unavailable", "identity_verification"); }
    let validSignature = false;
    try { validSignature = !!key && verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), createPublicKey({ key, format: "jwk" }), Buffer.from(signature, "base64url")); }
    catch { /* Invalid provider keys cannot bypass signature verification. */ }
    if (!validSignature) throw new AccountError("verification_failed", "id_token_signature_invalid", "identity_verification");
    const nowSeconds = Math.floor(this.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!["https://accounts.google.com", "accounts.google.com"].includes(String(payload.iss)) || !audiences.includes(clientId) ||
      (audiences.length > 1 && payload.azp !== clientId) || (payload.azp !== undefined && payload.azp !== clientId) ||
      typeof payload.exp !== "number" || !Number.isInteger(payload.exp) || typeof payload.iat !== "number" || !Number.isInteger(payload.iat) ||
      payload.iat > nowSeconds + 60 || payload.exp <= payload.iat || (!expected.allowExpired && payload.exp <= nowSeconds) ||
      (typeof payload.nbf === "number" && payload.nbf > nowSeconds + 60) ||
      typeof payload.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(payload.sub) ||
      (expected.subject !== undefined && payload.sub !== expected.subject) ||
      payload.email_verified !== true || typeof payload.email !== "string" || payload.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(payload.email)) throw new AccountError("verification_failed");
    if (expected.nonce && !(expected.nonceOptional && payload.nonce === undefined) && (typeof payload.nonce !== "string" || !same(payload.nonce, expected.nonce))) throw new AccountError("verification_failed", "id_token_nonce_mismatch", "identity_verification");
    const name = typeof payload.name === "string" && payload.name.trim() && payload.name.length <= 300 ? payload.name.trim() : payload.email;
    return { profile: { subject: payload.sub, name, email: payload.email }, expires: payload.exp * 1000, ...(typeof payload.nonce === "string" ? { nonce: payload.nonce } : {}) };
  }
}
