#!/usr/bin/env node
/**
 * Bridge MCP Server — shared persistent memory between claude.ai and Claude Code.
 *
 * Deployment edition (spec section 8, step 2):
 *  - Transport: MCP Streamable HTTP (spec section 3 — SSE is deprecated, do
 *    not use it). Stateless mode: each POST gets a fresh server+transport
 *    pair, which is the simplest correct setup for horizontally-scalable
 *    hosts like Railway.
 *  - Database: Postgres via DATABASE_URL (Railway Postgres addon convention).
 *  - Auth (spec sections 3/7): TWO parallel Bearer paths on /mcp —
 *      (a) the fixed token from BRIDGE_AUTH_TOKEN (Claude Code path,
 *          unchanged from v1), OR
 *      (b) an OAuth 2.1 access token issued by this server's own
 *          authorization endpoints (claude.ai custom-connector path,
 *          spec phase 2). See src/oauth.ts.
 *
 * Endpoints:
 *  - POST /mcp      — the MCP endpoint (also accepts POST /)
 *  - GET  /healthz  — unauthenticated liveness probe (no data exposed)
 *  - GET  /.well-known/oauth-protected-resource[/*]     — RFC 9728 metadata
 *  - GET  /.well-known/oauth-authorization-server[/*]   — RFC 8414 metadata
 *  - POST /oauth/register   — RFC 7591 Dynamic Client Registration
 *  - GET|POST /oauth/authorize — owner-password approval + code issuance
 *  - POST /oauth/token      — authorization_code (PKCE) + refresh_token grants
 *  - POST /oauth/revoke     — RFC 7009 access/refresh token revocation
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { MemoryDb, type Source } from "./db.js";
import { OAuthProvider } from "./oauth.js";
import { detectSecret } from "./secret-filter.js";

// ---------------------------------------------------------------------------
// Configuration — fail fast on missing required env vars.
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "FATAL: DATABASE_URL is not set. Point it at a Postgres instance, e.g. " +
      "postgres://user:password@host:5432/dbname (Railway's Postgres addon " +
      "provides this automatically as a service variable)."
  );
  process.exit(1);
}

const AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN;
if (!AUTH_TOKEN) {
  console.error(
    "FATAL: BRIDGE_AUTH_TOKEN is not set. Generate a long random secret " +
      '(e.g. `openssl rand -hex 32` or `node -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"`) ' +
      "and set it in the environment. Every MCP request must send it as " +
      "`Authorization: Bearer <token>`."
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8787);

// --- OAuth 2.1 configuration (phase 2) -------------------------------------
// PUBLIC_BASE_URL must be the externally reachable origin (Railway sits
// behind a proxy, so request headers can't be trusted to reconstruct it).
// Local/dev fallback: http://localhost:<port>.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(
  /\/+$/,
  ""
);
const OAUTH_SIGNING_SECRET = process.env.OAUTH_SIGNING_SECRET;
const OAUTH_OWNER_PASSWORD = process.env.OAUTH_OWNER_PASSWORD;
// OAuth is optional: if its env vars are missing the server still boots with
// the static-token path only (so an existing deployment never breaks), and
// the OAuth/discovery endpoints return 404.
const OAUTH_ENABLED = Boolean(OAUTH_SIGNING_SECRET && OAUTH_OWNER_PASSWORD);
if (!OAUTH_ENABLED) {
  console.error(
    "WARNING: OAUTH_SIGNING_SECRET and/or OAUTH_OWNER_PASSWORD are not set. " +
      "OAuth 2.1 endpoints are DISABLED; only the static BRIDGE_AUTH_TOKEN " +
      "path is active. Set both env vars (plus PUBLIC_BASE_URL) to enable " +
      "the claude.ai custom-connector flow."
  );
}

const db = new MemoryDb(DATABASE_URL);
const oauth = OAUTH_ENABLED
  ? new OAuthProvider(db, {
      baseUrl: PUBLIC_BASE_URL,
      signingSecret: OAUTH_SIGNING_SECRET as string,
      ownerPassword: OAUTH_OWNER_PASSWORD as string,
    })
  : null;

const sourceSchema = z
  .enum(["claude_ai", "claude_code"])
  .describe("Which side wrote this memory: 'claude_ai' or 'claude_code'");

/** Uniform success payload: JSON text content. */
function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Run the credential filter over every user-supplied text field that gets
 * persisted — not just the main text but also tags and project, which would
 * otherwise be an unfiltered path for a secret to slip into the database.
 * Returns a human-readable "<pattern> in <field>" description, or null.
 */
function detectSecretInFields(input: {
  text: string;
  textField: string; // "content" | "summary" — for the error message
  tags?: string[];
  project?: string;
}): string | null {
  const textHit = detectSecret(input.text);
  if (textHit) return `${textHit} in ${input.textField}`;
  for (const tag of input.tags ?? []) {
    const tagHit = detectSecret(tag);
    if (tagHit) return `${tagHit} in tags`;
  }
  if (input.project) {
    const projectHit = detectSecret(input.project);
    if (projectHit) return `${projectHit} in project`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP server factory. Stateless Streamable HTTP creates a fresh McpServer per
// request, so tool registration lives in a factory. The db pool is shared.
// ---------------------------------------------------------------------------
function buildServer(): McpServer {
  const server = new McpServer({
    name: "bridge-memory-server",
    version: "0.2.0",
  });

  // -------------------------------------------------------------------------
  // save_memory
  // -------------------------------------------------------------------------
  server.registerTool(
    "save_memory",
    {
      title: "Save memory",
      description:
        "儲存一筆長期記憶,供另一端的 Claude 之後查詢使用。Save a long-term memory so the other Claude client can query it later.",
      inputSchema: {
        content: z.string().min(1).describe("The memory content to store (required)"),
        source: sourceSchema,
        tags: z.array(z.string()).optional().describe("Optional tags, e.g. [\"job-search\"]"),
        project: z.string().optional().describe("Optional project/context this memory belongs to"),
      },
    },
    async ({ content, source, tags, project }) => {
      const secret = detectSecretInFields({ text: content, textField: "content", tags, project });
      if (secret) {
        return errorResult(
          `Refused to save: input appears to contain a credential (${secret}). ` +
            `Never store API keys, passwords, or tokens in the memory bridge. ` +
            `(Heuristic check — rephrase without the secret and retry.)`
        );
      }
      const memory = await db.saveMemory({ content, source, tags, project });
      return jsonResult({ saved: true, memory });
    }
  );

  // -------------------------------------------------------------------------
  // search_memory
  // -------------------------------------------------------------------------
  server.registerTool(
    "search_memory",
    {
      title: "Search memory",
      description:
        "依關鍵字或標籤搜尋記憶庫。Search memories by keyword, tags, and/or project. Results include ids usable with delete_memory / consolidate_memory.",
      inputSchema: {
        query: z.string().optional().describe("Keyword to match against memory content"),
        tags: z.array(z.string()).optional().describe("Only memories carrying ALL of these tags"),
        project: z.string().optional().describe("Only memories in this project"),
        limit: z.number().int().min(1).max(100).default(10).describe("Max results (default 10)"),
      },
    },
    async ({ query, tags, project, limit }) => {
      const results = await db.searchMemory({ query, tags, project, limit });
      return jsonResult({ count: results.length, memories: results });
    }
  );

  // -------------------------------------------------------------------------
  // get_recent_memory
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_recent_memory",
    {
      title: "Get recent memories",
      description:
        "取得最近寫入的 N 筆記憶,依時間排序。Return the N most recently created memories, newest first. Results include ids.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(10).describe("Max results (default 10)"),
      },
    },
    async ({ limit }) => {
      const results = await db.getRecent(limit);
      return jsonResult({ count: results.length, memories: results });
    }
  );

  // -------------------------------------------------------------------------
  // list_by_source
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_by_source",
    {
      title: "List memories by source",
      description:
        "列出特定來源(claude.ai 或 claude code)寫入的記憶。List memories written by a specific source, newest first.",
      inputSchema: {
        source: sourceSchema,
        limit: z.number().int().min(1).max(200).default(20).describe("Max results (default 20)"),
      },
    },
    async ({ source, limit }) => {
      const results = await db.listBySource(source, limit);
      return jsonResult({ count: results.length, memories: results });
    }
  );

  // -------------------------------------------------------------------------
  // delete_memory
  // -------------------------------------------------------------------------
  server.registerTool(
    "delete_memory",
    {
      title: "Delete a memory",
      description:
        "刪除一筆指定的記憶(依 id,軟刪除)。Soft-delete one memory by id. Use search_memory / get_recent_memory first to find the id and confirm with the user.",
      inputSchema: {
        id: z.string().min(1).describe("The uuid of the memory to delete (required)"),
      },
    },
    async ({ id }) => {
      const deleted = await db.deleteMemory(id);
      if (!deleted) {
        return errorResult(
          `No live memory found with id ${id} (it may not exist or was already deleted).`
        );
      }
      return jsonResult({ deleted: true, id });
    }
  );

  // -------------------------------------------------------------------------
  // delete_by_filter — two-step confirm flow (spec section 5 prose):
  // without confirm:true the tool only reports the matching count + ids;
  // the actual soft-delete happens only on a second call with confirm:true.
  // -------------------------------------------------------------------------
  server.registerTool(
    "delete_by_filter",
    {
      title: "Batch delete memories by filter",
      description:
        "依條件批次刪除記憶(軟刪除)。Two-step flow: call WITHOUT confirm to get the count and ids of matching memories, verify with the user, then call again WITH confirm:true to actually delete. At least one filter is required.",
      inputSchema: {
        source: sourceSchema.optional(),
        project: z.string().optional().describe("Only memories in this project"),
        tags: z.array(z.string()).optional().describe("Only memories carrying ALL of these tags"),
        older_than: z
          .string()
          .optional()
          .describe("ISO date/datetime; only memories created before this moment"),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Must be true to actually delete. When false/omitted the tool only returns the match count and ids for confirmation."
          ),
      },
    },
    async ({ source, project, tags, older_than, confirm }) => {
      // Safety requirement from the spec: reject empty filters outright so a
      // bad call can never wipe the whole table.
      const hasFilter =
        source !== undefined ||
        project !== undefined ||
        (tags !== undefined && tags.length > 0) ||
        older_than !== undefined;
      if (!hasFilter) {
        return errorResult(
          "delete_by_filter requires at least one non-empty filter (source, project, tags, or older_than)."
        );
      }
      if (older_than !== undefined && Number.isNaN(Date.parse(older_than))) {
        return errorResult(`older_than is not a valid ISO date: ${older_than}`);
      }
      try {
        const result = await db.deleteByFilter({ source, project, tags, older_than }, confirm);
        return jsonResult({
          matched_count: result.count,
          matched_ids: result.ids,
          deleted: result.deleted,
          note: result.deleted
            ? undefined
            : "Nothing was deleted. Confirm the list with the user, then call again with confirm:true to perform the soft delete.",
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // -------------------------------------------------------------------------
  // consolidate_memory
  // -------------------------------------------------------------------------
  server.registerTool(
    "consolidate_memory",
    {
      title: "Consolidate memories",
      description:
        "將多筆相關的舊記憶整合成一筆精簡的新記憶。Merge >=2 old memories into one new memory created from `summary` (the caller's LLM produces the summary; the server does no summarization). Old memories are marked superseded_by the new one and soft-deleted; the relationship is recorded for traceability. Returns the new memory id and the consolidated count.",
      inputSchema: {
        memory_ids: z
          .array(z.string())
          .min(2)
          .describe("Ids of the old memories to consolidate (at least 2, required)"),
        summary: z
          .string()
          .min(1)
          .describe("The consolidated content, pre-written by the calling LLM (required)"),
        project: z.string().optional().describe("Optional project for the new memory"),
        tags: z.array(z.string()).optional().describe("Optional tags for the new memory"),
        source: sourceSchema
          .optional()
          .describe(
            "Optional source for the new memory. If omitted: the shared source of all consolidated memories, or the first memory's source when they differ."
          ),
      },
    },
    async ({ memory_ids, summary, project, tags, source }) => {
      const secret = detectSecretInFields({ text: summary, textField: "summary", tags, project });
      if (secret) {
        return errorResult(
          `Refused to consolidate: input appears to contain a credential (${secret}). ` +
            `Never store API keys, passwords, or tokens in the memory bridge.`
        );
      }
      // Fail fast on duplicate ids: the zod schema only checks array LENGTH
      // >= 2, so ["a","a"] passes it but can never be a valid consolidation.
      // Catching it here gives the caller an actionable message instead of
      // the deeper db-layer error (which also guards this, as defense in depth).
      const uniqueIdCount = new Set(memory_ids).size;
      if (uniqueIdCount < 2) {
        return errorResult(
          `consolidate_memory needs at least 2 DISTINCT memory_ids, but the ` +
            `${memory_ids.length} id(s) provided contain only ${uniqueIdCount} unique value. ` +
            `Remove the duplicated id(s) and pass two or more different memory ids.`
        );
      }
      // Derive the new memory's source (the spec's consolidate_memory schema
      // has no source field, but the memories table requires one): explicit
      // input > unanimous source of the constituents > first constituent's
      // source. Taking sources[0] implements BOTH fallback cases at once:
      // when all constituents agree, the first source IS the shared source;
      // when they differ, the first one wins by definition.
      let resolvedSource: Source | undefined = source;
      if (!resolvedSource) {
        const sources = (
          await Promise.all(memory_ids.map((id) => db.getSourceOfAny(id)))
        ).filter((s): s is string => s !== null);
        const first = sources[0];
        resolvedSource =
          first === "claude_ai" || first === "claude_code" ? first : "claude_code";
      }
      try {
        const { newMemory, consolidatedCount } = await db.consolidateMemory({
          memory_ids,
          summary,
          source: resolvedSource,
          project,
          tags,
        });
        return jsonResult({
          new_memory_id: newMemory.id,
          consolidated_count: consolidatedCount,
          new_memory: newMemory,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Bearer token auth. A request is authorized if EITHER:
//  (a) the token equals BRIDGE_AUTH_TOKEN (v1 static path — Claude Code), or
//  (b) the token is a live OAuth 2.1 access token this server issued
//      (claude.ai custom-connector path).
// The static comparison stays constant-time so the token can't be probed
// byte by byte.
// ---------------------------------------------------------------------------
function matchesStaticToken(presentedToken: string): boolean {
  const presented = Buffer.from(presentedToken);
  const expected = Buffer.from(AUTH_TOKEN as string);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

async function isAuthorized(req: IncomingMessage): Promise<boolean> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length);
  if (matchesStaticToken(token)) return true;
  if (oauth) return oauth.verifyAccessToken(token);
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// HTTP server (Streamable HTTP transport, stateless mode).
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await db.init();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Unauthenticated liveness probe (exposes no data).
    if (req.method === "GET" && path === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    // OAuth 2.1 + discovery routes (unauthenticated by design; the
    // authorize step is gated by the owner password instead).
    if (oauth) {
      try {
        if (await oauth.handle(req, res, path)) return;
      } catch (err) {
        console.error("Error handling OAuth request:", err);
        if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
        return;
      }
    }

    // Everything else is the MCP endpoint; accept both /mcp and /.
    if (path !== "/mcp" && path !== "/") {
      sendJson(res, 404, { error: "not found; the MCP endpoint is POST /mcp" });
      return;
    }

    if (!(await isAuthorized(req))) {
      // RFC 9728 section 5.1: point clients at the protected-resource
      // metadata so they can discover the authorization server from a bare
      // 401. The JSON-RPC error body stays as before for non-OAuth clients.
      res.setHeader(
        "WWW-Authenticate",
        oauth
          ? `Bearer resource_metadata="${oauth.protectedResourceMetadataUrl}", error="invalid_token"`
          : "Bearer"
      );
      sendJson(res, 401, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or invalid Bearer token" },
        id: null,
      });
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode: no SSE notification stream (GET) or session
      // termination (DELETE) to speak of.
      res.setHeader("Allow", "POST");
      sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed; use POST" },
        id: null,
      });
      return;
    }

    // Stateless Streamable HTTP: fresh server + transport per request so
    // concurrent clients (claude.ai and Claude Code) never share state.
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  httpServer.listen(PORT, () => {
    console.error(
      `bridge-memory-server listening on port ${PORT} (Streamable HTTP at /mcp, health at /healthz, ` +
        (oauth
          ? `OAuth 2.1 enabled with issuer ${PUBLIC_BASE_URL})`
          : "OAuth 2.1 disabled — static token only)")
    );
  });

  const shutdown = async () => {
    console.error("Shutting down bridge-memory-server...");
    httpServer.close();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error starting bridge-memory-server:", err);
  process.exit(1);
});
