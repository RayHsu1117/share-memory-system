/**
 * Database layer for the Bridge MCP Server — Postgres edition.
 *
 * Implements the schema from spec section 4:
 *  - `memories` table with soft-delete (`deleted_at`) and consolidation
 *    tracking (`superseded_by`).
 *  - `memory_consolidations` table recording which old memories were merged
 *    into which new memory.
 *
 * All read queries filter `WHERE deleted_at IS NULL` so soft-deleted /
 * superseded rows never surface in normal results, but remain recoverable
 * and auditable.
 *
 * Ported from better-sqlite3 to `pg` (node-postgres):
 *  - Connection string comes from DATABASE_URL (Railway's Postgres addon
 *    convention).
 *  - All methods are async (pg Pool API).
 *  - Timestamps stay TEXT ISO-8601 strings generated in JS, exactly like the
 *    SQLite version, so ordering and `older_than` comparisons behave
 *    identically.
 *  - SQLite's LIKE is case-insensitive for ASCII; Postgres LIKE is not, so
 *    keyword/tag matching uses ILIKE to preserve behavior.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";

export type Source = "claude_ai" | "claude_code";

/** Raw row shape as stored in Postgres. */
interface MemoryRow {
  id: string;
  content: string;
  source: string;
  tags: string | null;
  project: string | null;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
  deleted_at: string | null;
}

/** Public memory shape returned by the tools (tags parsed back to array). */
export interface Memory {
  id: string;
  content: string;
  source: string;
  tags: string[];
  project: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchFilters {
  query?: string;
  tags?: string[];
  project?: string;
  limit?: number;
}

export interface DeleteFilters {
  source?: Source;
  project?: string;
  tags?: string[];
  older_than?: string; // ISO date; matches memories created before this date
}

// ---------------------------------------------------------------------------
// OAuth 2.1 storage shapes (spec phase 2: OAuth alongside the static token).
// All secrets (codes, tokens) are stored as HMAC hashes, never in plaintext,
// so a database leak does not leak usable credentials.
// ---------------------------------------------------------------------------

/** A dynamically-registered OAuth client (RFC 7591). Public client, no secret. */
export interface OAuthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  created_at: string;
}

interface OAuthClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string; // JSON array
  token_endpoint_auth_method: string;
  grant_types: string; // JSON array
  response_types: string; // JSON array
  created_at: string;
}

export interface OAuthCode {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export type TokenKind = "access" | "refresh";

export interface OAuthToken {
  token_hash: string;
  kind: TokenKind;
  client_id: string;
  scope: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToMemory(row: MemoryRow): Memory {
  let tags: string[] = [];
  if (row.tags) {
    try {
      const parsed = JSON.parse(row.tags);
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      // Tolerate malformed tag JSON rather than failing the whole query.
      tags = [];
    }
  }
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    tags,
    project: row.project,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Escape LIKE/ILIKE wildcards in user input so keyword search matches
 * literally. Used together with `ESCAPE '\'` in the SQL.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class MemoryDb {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  /** Create tables/indexes if missing. Call once at startup before serving. */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,              -- uuid
        content TEXT NOT NULL,            -- memory content
        source TEXT NOT NULL,             -- 'claude_ai' | 'claude_code'
        tags TEXT,                        -- JSON array, e.g. ["job-search","taiwan-md"]
        project TEXT,                     -- optional project/context
        created_at TEXT NOT NULL,         -- ISO-8601 (JS-generated, same as sqlite version)
        updated_at TEXT NOT NULL,
        superseded_by TEXT,               -- id of the consolidated memory that replaced this one
        deleted_at TEXT                   -- soft-delete timestamp; NULL = live
      );

      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      -- Every list query orders by created_at DESC; a plain b-tree index
      -- serves that via a backward scan. (Content ILIKE search stays a seq
      -- scan on purpose: a trigram/GIN index needs CREATE EXTENSION pg_trgm,
      -- which may be unavailable on managed Postgres and would fail startup —
      -- not worth it at personal scale.)
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);

      CREATE TABLE IF NOT EXISTS memory_consolidations (
        id TEXT PRIMARY KEY,                    -- uuid
        consolidated_memory_id TEXT NOT NULL,   -- the new, merged memory
        source_memory_id TEXT NOT NULL,         -- an old memory that was merged in
        created_at TEXT NOT NULL,
        FOREIGN KEY (consolidated_memory_id) REFERENCES memories(id),
        FOREIGN KEY (source_memory_id) REFERENCES memories(id)
      );

      -- OAuth 2.1 (phase 2). Dynamically registered public clients (RFC 7591).
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,               -- random uuid
        client_name TEXT,
        redirect_uris TEXT NOT NULL,              -- JSON array of exact URIs
        token_endpoint_auth_method TEXT NOT NULL, -- 'none' (public client + PKCE)
        grant_types TEXT NOT NULL,                -- JSON array
        response_types TEXT NOT NULL,             -- JSON array
        created_at TEXT NOT NULL
      );

      -- Short-lived authorization codes. Single-use (used_at) + expiry.
      -- Expired rows are simply ignored at query time (no cleanup job).
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,               -- HMAC of the code, never plaintext
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,             -- PKCE S256 challenge
        scope TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT                              -- non-NULL once exchanged
      );

      -- Issued access + refresh tokens (opaque, stored hashed).
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash TEXT PRIMARY KEY,              -- HMAC of the token, never plaintext
        kind TEXT NOT NULL,                       -- 'access' | 'refresh'
        client_id TEXT NOT NULL,
        scope TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT                           -- non-NULL once revoked (refresh rotation or /oauth/revoke)
      );
    `);

    // Additive migration for databases created before oauth_codes had a
    // foreign key to oauth_clients. Runs on every boot, idempotently:
    //  1. Remove orphaned codes first (codes are 5-minute single-use rows, so
    //     deleting strays is harmless) — otherwise ADD CONSTRAINT would fail
    //     against a live database that ever had a client row removed by hand.
    //  2. Add the constraint only if it does not exist yet (Postgres has no
    //     ADD CONSTRAINT IF NOT EXISTS, hence the pg_constraint guard).
    // ON DELETE CASCADE so manually de-registering a client can never strand
    // rows that would break the next boot.
    await this.pool.query(`
      DELETE FROM oauth_codes
       WHERE client_id NOT IN (SELECT client_id FROM oauth_clients);

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'fk_oauth_codes_client'
             AND conrelid = 'oauth_codes'::regclass
        ) THEN
          ALTER TABLE oauth_codes
            ADD CONSTRAINT fk_oauth_codes_client
            FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id)
            ON DELETE CASCADE;
        END IF;
      END $$;
    `);
  }

  async saveMemory(input: {
    content: string;
    source: Source;
    tags?: string[];
    project?: string;
  }): Promise<Memory> {
    const id = randomUUID();
    const now = nowIso();
    await this.pool.query(
      `INSERT INTO memories (id, content, source, tags, project, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.content,
        input.source,
        input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null,
        input.project ?? null,
        now,
        now,
      ]
    );
    return (await this.getById(id))!;
  }

  async getById(id: string): Promise<Memory | null> {
    const { rows } = await this.pool.query<MemoryRow>(
      `SELECT * FROM memories WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return rows[0] ? rowToMemory(rows[0]) : null;
  }

  async searchMemory(filters: SearchFilters): Promise<Memory[]> {
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];

    if (filters.query) {
      params.push(`%${escapeLike(filters.query)}%`);
      conditions.push(`content ILIKE $${params.length} ESCAPE '\\'`);
    }
    if (filters.project) {
      params.push(filters.project);
      conditions.push(`project = $${params.length}`);
    }
    if (filters.tags && filters.tags.length > 0) {
      // Tags are stored as a JSON array string; match each requested tag as
      // a quoted JSON element (AND semantics: memory must carry every tag).
      for (const tag of filters.tags) {
        params.push(`%"${escapeLike(tag)}"%`);
        conditions.push(`tags ILIKE $${params.length} ESCAPE '\\'`);
      }
    }

    params.push(filters.limit ?? 10);
    const { rows } = await this.pool.query<MemoryRow>(
      `SELECT * FROM memories WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows.map(rowToMemory);
  }

  async getRecent(limit = 10): Promise<Memory[]> {
    const { rows } = await this.pool.query<MemoryRow>(
      `SELECT * FROM memories WHERE deleted_at IS NULL
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map(rowToMemory);
  }

  async listBySource(source: Source, limit = 20): Promise<Memory[]> {
    const { rows } = await this.pool.query<MemoryRow>(
      `SELECT * FROM memories WHERE deleted_at IS NULL AND source = $1
       ORDER BY created_at DESC LIMIT $2`,
      [source, limit]
    );
    return rows.map(rowToMemory);
  }

  /** Soft delete a single memory. Returns true if a live row was deleted. */
  async deleteMemory(id: string): Promise<boolean> {
    const now = nowIso();
    const result = await this.pool.query(
      `UPDATE memories SET deleted_at = $1, updated_at = $2
       WHERE id = $3 AND deleted_at IS NULL`,
      [now, now, id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Batch soft delete with a two-step confirm flow (spec section 5,
   * delete_by_filter prose): callers first get the match count/ids back,
   * and deletion only happens when `confirm` is true.
   *
   * At least one filter must be provided (enforced here as well as in the
   * tool layer) so an empty filter can never wipe the whole table.
   */
  async deleteByFilter(
    filters: DeleteFilters,
    confirm: boolean
  ): Promise<{ count: number; ids: string[]; deleted: boolean }> {
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];
    let hasFilter = false;

    if (filters.source) {
      params.push(filters.source);
      conditions.push(`source = $${params.length}`);
      hasFilter = true;
    }
    if (filters.project) {
      params.push(filters.project);
      conditions.push(`project = $${params.length}`);
      hasFilter = true;
    }
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        params.push(`%"${escapeLike(tag)}"%`);
        conditions.push(`tags ILIKE $${params.length} ESCAPE '\\'`);
      }
      hasFilter = true;
    }
    if (filters.older_than) {
      params.push(filters.older_than);
      conditions.push(`created_at < $${params.length}`);
      hasFilter = true;
    }

    if (!hasFilter) {
      throw new Error(
        "delete_by_filter requires at least one non-empty filter (source, project, tags, or older_than) to avoid wiping the whole table."
      );
    }

    const where = conditions.join(" AND ");
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM memories WHERE ${where}`,
      params
    );
    const ids = rows.map((r) => r.id);

    if (!confirm || ids.length === 0) {
      return { count: ids.length, ids, deleted: false };
    }

    const now = nowIso();
    await this.pool.query(
      `UPDATE memories SET deleted_at = $1, updated_at = $2
       WHERE id = ANY($3::text[]) AND deleted_at IS NULL`,
      [now, now, ids]
    );
    return { count: ids.length, ids, deleted: true };
  }

  /**
   * Consolidate several memories into one (spec section 5, consolidate_memory):
   * 1. Insert a new memory from `summary` (same logic as save_memory).
   * 2. Mark each old memory as superseded_by the new one + soft-deleted.
   * 3. Record the relationships in memory_consolidations for traceability.
   * 4. Return the new memory and the count of consolidated rows.
   *
   * Runs in a single Postgres transaction so a partial failure rolls back.
   */
  async consolidateMemory(input: {
    memory_ids: string[];
    summary: string;
    source: Source;
    project?: string;
    tags?: string[];
  }): Promise<{ newMemory: Memory; consolidatedCount: number }> {
    const uniqueIds = [...new Set(input.memory_ids)];
    if (uniqueIds.length < 2) {
      throw new Error("consolidate_memory requires at least 2 distinct memory_ids.");
    }

    // Validate all targets exist and are live before touching anything.
    const { rows: liveRows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM memories WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [uniqueIds]
    );
    const liveIds = new Set(liveRows.map((r) => r.id));
    const missing = uniqueIds.filter((id) => !liveIds.has(id));
    if (missing.length > 0) {
      throw new Error(
        `These memory_ids do not exist or are already deleted: ${missing.join(", ")}`
      );
    }

    const now = nowIso();
    const newId = randomUUID();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO memories (id, content, source, tags, project, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          newId,
          input.summary,
          input.source,
          input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null,
          input.project ?? null,
          now,
          now,
        ]
      );
      for (const oldId of uniqueIds) {
        await client.query(
          `UPDATE memories SET superseded_by = $1, deleted_at = $2, updated_at = $3
           WHERE id = $4 AND deleted_at IS NULL`,
          [newId, now, now, oldId]
        );
        await client.query(
          `INSERT INTO memory_consolidations (id, consolidated_memory_id, source_memory_id, created_at)
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), newId, oldId, now]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return {
      newMemory: (await this.getById(newId))!,
      consolidatedCount: uniqueIds.length,
    };
  }

  /** Source of a memory even if soft-deleted (used to derive consolidation source). */
  async getSourceOfAny(id: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ source: string }>(
      `SELECT source FROM memories WHERE id = $1`,
      [id]
    );
    return rows[0] ? rows[0].source : null;
  }

  // -------------------------------------------------------------------------
  // OAuth 2.1 storage (phase 2). Same conventions as above: TEXT ISO-8601
  // timestamps generated in JS, parameterized queries, expiry filtered at
  // query time instead of a cleanup job.
  // -------------------------------------------------------------------------

  private static rowToOAuthClient(row: OAuthClientRow): OAuthClient {
    const parseArray = (text: string): string[] => {
      try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    };
    return {
      client_id: row.client_id,
      client_name: row.client_name,
      redirect_uris: parseArray(row.redirect_uris),
      token_endpoint_auth_method: row.token_endpoint_auth_method,
      grant_types: parseArray(row.grant_types),
      response_types: parseArray(row.response_types),
      created_at: row.created_at,
    };
  }

  async createOAuthClient(input: {
    client_name?: string;
    redirect_uris: string[];
    token_endpoint_auth_method: string;
    grant_types: string[];
    response_types: string[];
  }): Promise<OAuthClient> {
    const client_id = randomUUID();
    const now = nowIso();
    await this.pool.query(
      `INSERT INTO oauth_clients
         (client_id, client_name, redirect_uris, token_endpoint_auth_method,
          grant_types, response_types, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        client_id,
        input.client_name ?? null,
        JSON.stringify(input.redirect_uris),
        input.token_endpoint_auth_method,
        JSON.stringify(input.grant_types),
        JSON.stringify(input.response_types),
        now,
      ]
    );
    return (await this.getOAuthClient(client_id))!;
  }

  async getOAuthClient(clientId: string): Promise<OAuthClient | null> {
    const { rows } = await this.pool.query<OAuthClientRow>(
      `SELECT * FROM oauth_clients WHERE client_id = $1`,
      [clientId]
    );
    return rows[0] ? MemoryDb.rowToOAuthClient(rows[0]) : null;
  }

  async insertAuthCode(input: {
    code_hash: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    scope?: string;
    expires_at: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_codes
         (code_hash, client_id, redirect_uri, code_challenge, scope, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.code_hash,
        input.client_id,
        input.redirect_uri,
        input.code_challenge,
        input.scope ?? null,
        nowIso(),
        input.expires_at,
      ]
    );
  }

  /**
   * Atomically consume an authorization code: marks it used and returns it in
   * one UPDATE ... RETURNING, so a replayed code (already used) or an expired
   * code returns null. Single-statement = no race between check and mark.
   */
  async consumeAuthCode(codeHash: string): Promise<OAuthCode | null> {
    const now = nowIso();
    const { rows } = await this.pool.query<OAuthCode>(
      `UPDATE oauth_codes SET used_at = $1
       WHERE code_hash = $2 AND used_at IS NULL AND expires_at > $1
       RETURNING *`,
      [now, codeHash]
    );
    return rows[0] ?? null;
  }

  async insertToken(input: {
    token_hash: string;
    kind: TokenKind;
    client_id: string;
    scope?: string | null;
    expires_at: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, scope, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.token_hash,
        input.kind,
        input.client_id,
        input.scope ?? null,
        nowIso(),
        input.expires_at,
      ]
    );
  }

  /** Live (non-revoked, non-expired) token lookup by hash + kind. */
  async getActiveToken(tokenHash: string, kind: TokenKind): Promise<OAuthToken | null> {
    const { rows } = await this.pool.query<OAuthToken>(
      `SELECT * FROM oauth_tokens
       WHERE token_hash = $1 AND kind = $2 AND revoked_at IS NULL AND expires_at > $3`,
      [tokenHash, kind, nowIso()]
    );
    return rows[0] ?? null;
  }

  /**
   * Atomically revoke a live refresh token and return it (refresh rotation):
   * a second concurrent use of the same refresh token gets null.
   */
  async consumeRefreshToken(tokenHash: string): Promise<OAuthToken | null> {
    const now = nowIso();
    const { rows } = await this.pool.query<OAuthToken>(
      `UPDATE oauth_tokens SET revoked_at = $1
       WHERE token_hash = $2 AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > $1
       RETURNING *`,
      [now, tokenHash]
    );
    return rows[0] ?? null;
  }

  /**
   * Revoke a live token of either kind by hash (RFC 7009 /oauth/revoke).
   * Idempotent: returns true only if a not-yet-revoked token was found.
   */
  async revokeToken(tokenHash: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE oauth_tokens SET revoked_at = $1
       WHERE token_hash = $2 AND revoked_at IS NULL`,
      [nowIso(), tokenHash]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
