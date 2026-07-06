/**
 * OAuth 2.1 authorization server + protected-resource metadata for the Bridge
 * MCP Server (spec phase 2: "OAuth2 + JWT", built for claude.ai's custom
 * connector UI).
 *
 * What claude.ai's connector flow needs (per the MCP authorization spec):
 *   1. GET /.well-known/oauth-protected-resource      (RFC 9728) — which AS
 *      protects /mcp. Also served with the path suffix variant
 *      /.well-known/oauth-protected-resource/mcp that clients try first when
 *      the resource URL has a path.
 *   2. GET /.well-known/oauth-authorization-server    (RFC 8414) — endpoints
 *      + capabilities (PKCE S256 mandatory, DCR supported).
 *   3. POST /oauth/register                           (RFC 7591 DCR) — public
 *      clients only (token_endpoint_auth_method "none", PKCE instead of a
 *      client secret).
 *   4. GET  /oauth/authorize — validates the request, renders a single-owner
 *      password form; POST /oauth/authorize approves it and 302s back with a
 *      short-lived single-use code.
 *   5. POST /oauth/token — authorization_code (+ PKCE verification) and
 *      refresh_token (with rotation) grants.
 *   6. POST /oauth/revoke — RFC 7009 revocation of an access or refresh
 *      token. Minimal single-token form: no token-family cascade (tokens
 *      carry no lineage/session id, and for a single-owner server the
 *      cheap "mark this one revoked" covers the practical need).
 *
 * Token format: opaque random tokens. The server stores only
 * HMAC-SHA256(OAUTH_SIGNING_SECRET, token) in Postgres, so tokens are
 * verifiable via one indexed lookup and a DB leak exposes no usable
 * credentials. (Chosen over self-contained JWTs: same env var, fewer moving
 * parts, and revocation/rotation come for free.)
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryDb, OAuthClient } from "./db.js";

// ---------------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------------
const CODE_TTL_MS = 5 * 60 * 1000; // authorization codes: 5 minutes
const ACCESS_TOKEN_TTL_S = 60 * 60; // access tokens: 1 hour
const REFRESH_TOKEN_TTL_S = 60 * 24 * 60 * 60; // refresh tokens: 60 days

export interface OAuthConfig {
  /** Externally reachable base URL, no trailing slash (PUBLIC_BASE_URL). */
  baseUrl: string;
  /** HMAC key for hashing codes/tokens at rest (OAUTH_SIGNING_SECRET). */
  signingSecret: string;
  /** Single-owner approval password (OAUTH_OWNER_PASSWORD). */
  ownerPassword: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE S256: BASE64URL(SHA256(code_verifier)). */
function s256Challenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

/** Constant-time string comparison that does not leak length. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("hex")}`;
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Redirect URIs we accept at registration: https, or http on loopback hosts
 * (RFC 8252 native-app pattern some MCP clients use).
 */
function isAcceptableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]" ||
      parsed.hostname === "::1"
    );
  }
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    // OAuth endpoints are meant to be reachable from browser-based clients
    // (e.g. MCP inspector); the data is not cookie-scoped so * is safe.
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

/** Read a small request body (JSON or form-encoded), capped at 64 KiB. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse a body as JSON or application/x-www-form-urlencoded into a flat record. */
async function readParams(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readBody(req);
  const contentType = String(req.headers["content-type"] ?? "");
  const out: Record<string, string> = {};
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------
export class OAuthProvider {
  constructor(
    private readonly db: MemoryDb,
    private readonly config: OAuthConfig
  ) {}

  /** URL advertised in WWW-Authenticate on 401s from /mcp. */
  get protectedResourceMetadataUrl(): string {
    return `${this.config.baseUrl}/.well-known/oauth-protected-resource`;
  }

  /**
   * Route an incoming request. Returns true if the request was an OAuth /
   * discovery route and has been fully handled, false to let the caller
   * continue with its own routing.
   */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    // RFC 8414/9728 well-known documents, including path-suffix variants
    // (".../oauth-protected-resource/mcp") that MCP clients try first.
    if (
      path === "/.well-known/oauth-protected-resource" ||
      path.startsWith("/.well-known/oauth-protected-resource/")
    ) {
      if (!this.allowGet(req, res)) return true;
      this.handleProtectedResourceMetadata(res);
      return true;
    }
    if (
      path === "/.well-known/oauth-authorization-server" ||
      path.startsWith("/.well-known/oauth-authorization-server/")
    ) {
      if (!this.allowGet(req, res)) return true;
      this.handleAuthorizationServerMetadata(res);
      return true;
    }
    if (path === "/oauth/register") {
      if (req.method === "OPTIONS") return this.preflight(res, "POST, OPTIONS");
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { error: "invalid_request", error_description: "use POST" });
        return true;
      }
      await this.handleRegister(req, res);
      return true;
    }
    if (path === "/oauth/authorize") {
      if (req.method === "GET") {
        await this.handleAuthorizeGet(req, res);
        return true;
      }
      if (req.method === "POST") {
        await this.handleAuthorizePost(req, res);
        return true;
      }
      res.setHeader("Allow", "GET, POST");
      sendJson(res, 405, { error: "invalid_request", error_description: "use GET or POST" });
      return true;
    }
    if (path === "/oauth/token") {
      if (req.method === "OPTIONS") return this.preflight(res, "POST, OPTIONS");
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { error: "invalid_request", error_description: "use POST" });
        return true;
      }
      await this.handleToken(req, res);
      return true;
    }
    if (path === "/oauth/revoke") {
      if (req.method === "OPTIONS") return this.preflight(res, "POST, OPTIONS");
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { error: "invalid_request", error_description: "use POST" });
        return true;
      }
      await this.handleRevoke(req, res);
      return true;
    }
    return false;
  }

  private preflight(res: ServerResponse, methods: string): true {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-protocol-version",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return true;
  }

  private allowGet(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method === "OPTIONS") {
      this.preflight(res, "GET, OPTIONS");
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET");
      sendJson(res, 405, { error: "invalid_request", error_description: "use GET" });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Discovery documents
  // -------------------------------------------------------------------------

  /** RFC 9728: which authorization server protects the /mcp resource. */
  private handleProtectedResourceMetadata(res: ServerResponse): void {
    const base = this.config.baseUrl;
    sendJson(res, 200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      resource_name: "Bridge Memory MCP Server",
    });
  }

  /** RFC 8414: authorization server metadata. */
  private handleAuthorizationServerMetadata(res: ServerResponse): void {
    const base = this.config.baseUrl;
    sendJson(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      revocation_endpoint: `${base}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
      service_documentation: `${base}/healthz`,
    });
  }

  // -------------------------------------------------------------------------
  // Dynamic Client Registration (RFC 7591)
  // -------------------------------------------------------------------------
  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid_client_metadata", error_description: "body must be JSON" });
      return;
    }
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "invalid_client_metadata", error_description: "body must be a JSON object" });
      return;
    }
    const meta = body as Record<string, unknown>;

    const redirectUris = meta.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every((u) => typeof u === "string")
    ) {
      sendJson(res, 400, {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be a non-empty array of strings",
      });
      return;
    }
    const bad = (redirectUris as string[]).find((u) => !isAcceptableRedirectUri(u));
    if (bad !== undefined) {
      sendJson(res, 400, {
        error: "invalid_redirect_uri",
        error_description: `redirect_uri must be https:// or http://localhost — rejected: ${bad}`,
      });
      return;
    }

    // We only support public clients with PKCE (no client secrets).
    const authMethod =
      typeof meta.token_endpoint_auth_method === "string"
        ? meta.token_endpoint_auth_method
        : "none";
    if (authMethod !== "none") {
      sendJson(res, 400, {
        error: "invalid_client_metadata",
        error_description:
          'only public clients are supported: token_endpoint_auth_method must be "none" (PKCE is required instead)',
      });
      return;
    }

    const grantTypes =
      Array.isArray(meta.grant_types) && meta.grant_types.every((g) => typeof g === "string")
        ? (meta.grant_types as string[])
        : ["authorization_code", "refresh_token"];
    const unsupportedGrant = grantTypes.find(
      (g) => g !== "authorization_code" && g !== "refresh_token"
    );
    if (unsupportedGrant) {
      sendJson(res, 400, {
        error: "invalid_client_metadata",
        error_description: `unsupported grant_type: ${unsupportedGrant}`,
      });
      return;
    }
    const responseTypes =
      Array.isArray(meta.response_types) && meta.response_types.every((r) => typeof r === "string")
        ? (meta.response_types as string[])
        : ["code"];
    if (responseTypes.some((r) => r !== "code")) {
      sendJson(res, 400, {
        error: "invalid_client_metadata",
        error_description: 'only response_type "code" is supported',
      });
      return;
    }

    const client = await this.db.createOAuthClient({
      client_name: typeof meta.client_name === "string" ? meta.client_name : undefined,
      redirect_uris: redirectUris as string[],
      token_endpoint_auth_method: "none",
      grant_types: grantTypes,
      response_types: responseTypes,
    });

    sendJson(res, 201, {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
      client_name: client.client_name ?? undefined,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      grant_types: client.grant_types,
      response_types: client.response_types,
    });
  }

  // -------------------------------------------------------------------------
  // Authorization endpoint
  // -------------------------------------------------------------------------

  /**
   * Validate authorize-request params shared by GET (render form) and POST
   * (approve). Returns either the validated context or `null` after having
   * written an error response.
   *
   * Error handling per OAuth 2.1: if client_id/redirect_uri are invalid we
   * MUST NOT redirect (error page instead); once redirect_uri is validated,
   * other errors are reported by redirecting with error/state params.
   */
  private async validateAuthorizeParams(
    params: Record<string, string | undefined>,
    res: ServerResponse
  ): Promise<{ client: OAuthClient; redirectUri: string; codeChallenge: string; state?: string; scope?: string } | null> {
    const clientId = params.client_id;
    const redirectUri = params.redirect_uri;
    const client = clientId ? await this.db.getOAuthClient(clientId) : null;
    if (!client) {
      sendHtml(res, 400, this.errorPage("Unknown client", "This client_id is not registered with this server."));
      return null;
    }
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      sendHtml(
        res,
        400,
        this.errorPage("Invalid redirect_uri", "The redirect_uri does not match any registered for this client.")
      );
      return null;
    }

    const state = params.state;
    const redirectError = (error: string, description: string) => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      target.searchParams.set("error_description", description);
      if (state !== undefined) target.searchParams.set("state", state);
      res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
      res.end();
    };

    if (params.response_type !== "code") {
      redirectError("unsupported_response_type", 'response_type must be "code"');
      return null;
    }
    // OAuth 2.1: PKCE is mandatory, and we only accept S256.
    const codeChallenge = params.code_challenge;
    if (!codeChallenge) {
      redirectError("invalid_request", "code_challenge is required (PKCE is mandatory)");
      return null;
    }
    if (params.code_challenge_method !== "S256") {
      redirectError("invalid_request", 'code_challenge_method must be "S256"');
      return null;
    }

    return { client, redirectUri, codeChallenge, state, scope: params.scope };
  }

  private async handleAuthorizeGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.config.baseUrl);
    const params = Object.fromEntries(url.searchParams);
    const ctx = await this.validateAuthorizeParams(params, res);
    if (!ctx) return;
    sendHtml(res, 200, this.approvalFormPage(params, ctx.client, null));
  }

  private async handleAuthorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let params: Record<string, string>;
    try {
      params = await readParams(req);
    } catch {
      sendHtml(res, 400, this.errorPage("Bad request", "Could not parse the form submission."));
      return;
    }
    const ctx = await this.validateAuthorizeParams(params, res);
    if (!ctx) return;

    const password = params.password ?? "";
    if (!safeEqual(password, this.config.ownerPassword)) {
      // Slow down brute force a little; single-owner server, so a fixed
      // delay is enough. Do not reveal anything beyond "wrong password".
      await new Promise((r) => setTimeout(r, 750));
      sendHtml(res, 401, this.approvalFormPage(params, ctx.client, "Wrong password. Try again."));
      return;
    }

    const code = newSecret("bmc");
    await this.db.insertAuthCode({
      code_hash: hmacHex(this.config.signingSecret, code),
      client_id: ctx.client.client_id,
      redirect_uri: ctx.redirectUri,
      code_challenge: ctx.codeChallenge,
      scope: ctx.scope,
      expires_at: isoIn(CODE_TTL_MS),
    });

    const target = new URL(ctx.redirectUri);
    target.searchParams.set("code", code);
    if (ctx.state !== undefined) target.searchParams.set("state", ctx.state);
    res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
    res.end();
  }

  // -------------------------------------------------------------------------
  // Token endpoint
  // -------------------------------------------------------------------------
  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let params: Record<string, string>;
    try {
      params = await readParams(req);
    } catch {
      sendJson(res, 400, { error: "invalid_request", error_description: "unparseable body" });
      return;
    }

    switch (params.grant_type) {
      case "authorization_code":
        await this.handleAuthorizationCodeGrant(params, res);
        return;
      case "refresh_token":
        await this.handleRefreshTokenGrant(params, res);
        return;
      default:
        sendJson(res, 400, {
          error: "unsupported_grant_type",
          error_description: 'grant_type must be "authorization_code" or "refresh_token"',
        });
    }
  }

  private async handleAuthorizationCodeGrant(
    params: Record<string, string>,
    res: ServerResponse
  ): Promise<void> {
    const { code, code_verifier: codeVerifier } = params;
    if (!code || !codeVerifier) {
      sendJson(res, 400, {
        error: "invalid_request",
        error_description: "code and code_verifier are required",
      });
      return;
    }

    // Atomic single-use consumption: replay of a used/expired code gets null.
    const stored = await this.db.consumeAuthCode(hmacHex(this.config.signingSecret, code));
    if (!stored) {
      sendJson(res, 400, {
        error: "invalid_grant",
        error_description: "authorization code is invalid, expired, or already used",
      });
      return;
    }
    if (params.client_id && params.client_id !== stored.client_id) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "client_id mismatch" });
      return;
    }
    if (params.redirect_uri && params.redirect_uri !== stored.redirect_uri) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }
    // PKCE verification: BASE64URL(SHA256(code_verifier)) == stored challenge.
    if (!safeEqual(s256Challenge(codeVerifier), stored.code_challenge)) {
      sendJson(res, 400, {
        error: "invalid_grant",
        error_description: "PKCE verification failed",
      });
      return;
    }

    await this.issueTokens(res, stored.client_id, stored.scope);
  }

  private async handleRefreshTokenGrant(
    params: Record<string, string>,
    res: ServerResponse
  ): Promise<void> {
    const refreshToken = params.refresh_token;
    if (!refreshToken) {
      sendJson(res, 400, { error: "invalid_request", error_description: "refresh_token is required" });
      return;
    }
    // Rotation: atomically revoke the presented refresh token; a second use
    // (or an expired/revoked one) gets invalid_grant.
    const stored = await this.db.consumeRefreshToken(
      hmacHex(this.config.signingSecret, refreshToken)
    );
    if (!stored) {
      sendJson(res, 400, {
        error: "invalid_grant",
        error_description: "refresh token is invalid, expired, or revoked",
      });
      return;
    }
    if (params.client_id && params.client_id !== stored.client_id) {
      sendJson(res, 400, { error: "invalid_grant", error_description: "client_id mismatch" });
      return;
    }
    await this.issueTokens(res, stored.client_id, stored.scope);
  }

  /** Issue a fresh access + refresh token pair and write the token response. */
  private async issueTokens(
    res: ServerResponse,
    clientId: string,
    scope: string | null
  ): Promise<void> {
    const accessToken = newSecret("bma");
    const refreshToken = newSecret("bmr");
    await this.db.insertToken({
      token_hash: hmacHex(this.config.signingSecret, accessToken),
      kind: "access",
      client_id: clientId,
      scope,
      expires_at: isoIn(ACCESS_TOKEN_TTL_S * 1000),
    });
    await this.db.insertToken({
      token_hash: hmacHex(this.config.signingSecret, refreshToken),
      kind: "refresh",
      client_id: clientId,
      scope,
      expires_at: isoIn(REFRESH_TOKEN_TTL_S * 1000),
    });
    sendJson(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
      ...(scope ? { scope } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Revocation endpoint (RFC 7009).
  // -------------------------------------------------------------------------
  /**
   * POST /oauth/revoke with `token=...` (token_type_hint is accepted but not
   * needed: token_hash is the primary key, so one UPDATE finds either kind).
   * Per RFC 7009 section 2.2 the response is 200 even when the token is
   * unknown or already revoked, so callers cannot probe which tokens exist.
   * Deliberately minimal: no token-family cascade — tokens carry no lineage
   * id to cascade over, and for this single-owner server "revoke the token
   * you hold" is the whole practical use case (kill a leaked/retired client).
   */
  private async handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let params: Record<string, string>;
    try {
      params = await readParams(req);
    } catch {
      sendJson(res, 400, { error: "invalid_request", error_description: "unparseable body" });
      return;
    }
    const token = params.token;
    if (!token) {
      sendJson(res, 400, { error: "invalid_request", error_description: "token is required" });
      return;
    }
    await this.db.revokeToken(hmacHex(this.config.signingSecret, token));
    sendJson(res, 200, {});
  }

  // -------------------------------------------------------------------------
  // Access-token verification for the /mcp auth middleware.
  // -------------------------------------------------------------------------
  async verifyAccessToken(token: string): Promise<boolean> {
    const stored = await this.db.getActiveToken(
      hmacHex(this.config.signingSecret, token),
      "access"
    );
    return stored !== null;
  }

  // -------------------------------------------------------------------------
  // HTML
  // -------------------------------------------------------------------------
  private pageShell(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f5f4; color: #1c1917;
         display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid #e7e5e4; border-radius: 12px;
          padding: 2rem; max-width: 24rem; width: 90%; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 1.1rem; margin: 0 0 .75rem; }
  p { font-size: .9rem; color: #57534e; margin: .5rem 0; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .55rem .7rem; margin: .75rem 0;
          border: 1px solid #d6d3d1; border-radius: 8px; font-size: 1rem; }
  button { width: 100%; padding: .6rem; border: 0; border-radius: 8px; background: #1c1917;
           color: #fff; font-size: .95rem; cursor: pointer; }
  .error { color: #b91c1c; font-size: .85rem; margin: .25rem 0 0; }
  code { background: #f5f5f4; padding: .1rem .3rem; border-radius: 4px; font-size: .85em; }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
  }

  private errorPage(title: string, message: string): string {
    return this.pageShell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
  }

  /** The single-owner approval form. Carries the OAuth params as hidden fields. */
  private approvalFormPage(
    params: Record<string, string | undefined>,
    client: OAuthClient,
    error: string | null
  ): string {
    const hidden = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
      .filter((name) => params[name] !== undefined)
      .map(
        (name) =>
          `<input type="hidden" name="${name}" value="${escapeHtml(params[name] as string)}">`
      )
      .join("\n      ");
    const clientLabel = client.client_name ? client.client_name : client.client_id;
    return this.pageShell(
      "Approve connection — Bridge Memory",
      `<h1>Bridge Memory Server</h1>
    <p><strong>${escapeHtml(clientLabel)}</strong> is asking to connect to your memory bridge.</p>
    <p>Enter the owner password to approve this connection.</p>
    <form method="POST" action="/oauth/authorize">
      ${hidden}
      <input type="password" name="password" placeholder="Owner password" autofocus required autocomplete="current-password">
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <button type="submit">Approve</button>
    </form>`
    );
  }
}
