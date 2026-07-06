#!/usr/bin/env node
/**
 * Streamable HTTP smoke test.
 *
 * Spawns the built server (dist/index.js) pointed at the Postgres instance in
 * DATABASE_URL, waits for /healthz, then exercises the full surface over
 * Streamable HTTP with Bearer auth:
 *   - 401 without / with a wrong token
 *   - tools/list returns all 7 tools
 *   - save_memory x3, search_memory (keyword + tags), get_recent_memory,
 *     list_by_source, delete_memory, consolidate_memory,
 *     delete_by_filter (two-step confirm), secret filter rejection
 *
 * Prereqs:
 *   - `npm run build` has been run
 *   - DATABASE_URL points at a reachable Postgres, e.g. a local container:
 *       docker run --rm -d --name bridge-pg -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16
 *       DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run smoke
 *
 * The test uses a unique project/tag per run so it can run against a shared
 * database without clobbering real data; it cleans up its own rows
 * (soft-delete) via delete_by_filter at the end.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL is required, e.g. postgres://postgres:test@localhost:5433/postgres"
  );
  process.exit(1);
}
const TOKEN = process.env.BRIDGE_AUTH_TOKEN || "smoke-test-token";
const PORT = Number(process.env.SMOKE_PORT || 8917);
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;

const RUN_ID = randomUUID().slice(0, 8);
const PROJECT = `smoke-${RUN_ID}`;
const TAG = `smoke-tag-${RUN_ID}`;

// ---------------------------------------------------------------------------
// Start the server as a child process.
// ---------------------------------------------------------------------------
const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  env: {
    ...process.env,
    DATABASE_URL,
    BRIDGE_AUTH_TOKEN: TOKEN,
    PORT: String(PORT),
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let childExited = false;
child.on("exit", (code) => {
  childExited = true;
  if (code !== 0 && code !== null) console.error(`server exited with code ${code}`);
});

async function waitForHealthy(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExited) throw new Error("server process exited before becoming healthy");
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy in time");
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Call a tool and parse the JSON text payload. */
async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
  return { isError: result.isError === true, text, payload };
}

const EXPECTED_TOOLS = [
  "consolidate_memory",
  "delete_by_filter",
  "delete_memory",
  "get_recent_memory",
  "list_by_source",
  "save_memory",
  "search_memory",
];

let failed = false;
try {
  await waitForHealthy();
  console.log("healthz OK");

  // --- auth checks (raw fetch) ----------------------------------------------
  const initBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  });
  const headersBase = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const noAuth = await fetch(MCP_URL, { method: "POST", headers: headersBase, body: initBody });
  assert(noAuth.status === 401, `expected 401 without token, got ${noAuth.status}`);
  const badAuth = await fetch(MCP_URL, {
    method: "POST",
    headers: { ...headersBase, Authorization: "Bearer wrong-token" },
    body: initBody,
  });
  assert(badAuth.status === 401, `expected 401 with wrong token, got ${badAuth.status}`);
  console.log("auth OK (401 without token and with wrong token)");

  // --- authenticated MCP client ---------------------------------------------
  const client = new Client({ name: "smoke-test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  console.log("initialize OK (Streamable HTTP with Bearer token)");

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  assert(missing.length === 0, `missing tools: ${missing.join(", ")}`);
  console.log(`tools/list OK — ${names.length} tools: ${names.join(", ")}`);

  // --- save_memory x3 --------------------------------------------------------
  const saves = [];
  for (const [content, source] of [
    [`smoke memory alpha ${RUN_ID}`, "claude_code"],
    [`smoke memory beta ${RUN_ID}`, "claude_code"],
    [`smoke memory gamma ${RUN_ID}`, "claude_ai"],
  ]) {
    const r = await callTool(client, "save_memory", {
      content,
      source,
      tags: [TAG],
      project: PROJECT,
    });
    assert(!r.isError, `save_memory failed: ${r.text}`);
    assert(r.payload?.memory?.id, "save_memory returned no id");
    saves.push(r.payload.memory);
  }
  console.log(`save_memory OK (3 saved under project ${PROJECT})`);

  // --- search_memory: keyword + project -------------------------------------
  let r = await callTool(client, "search_memory", {
    query: `alpha ${RUN_ID}`,
    project: PROJECT,
  });
  assert(!r.isError && r.payload.count === 1, `keyword search expected 1 hit, got ${r.text}`);
  assert(r.payload.memories[0].id === saves[0].id, "keyword search returned wrong memory");
  // tags search (AND semantics)
  r = await callTool(client, "search_memory", { tags: [TAG] });
  assert(r.payload.count === 3, `tag search expected 3 hits, got ${r.payload.count}`);
  console.log("search_memory OK (keyword+project hit, tag search found all 3)");

  // --- get_recent_memory ------------------------------------------------------
  r = await callTool(client, "get_recent_memory", { limit: 50 });
  const recentIds = r.payload.memories.map((m) => m.id);
  assert(
    saves.every((s) => recentIds.includes(s.id)),
    "get_recent_memory missing freshly saved rows"
  );
  console.log("get_recent_memory OK (all 3 present)");

  // --- list_by_source ---------------------------------------------------------
  r = await callTool(client, "list_by_source", { source: "claude_ai", limit: 200 });
  const aiIds = r.payload.memories.map((m) => m.id);
  assert(aiIds.includes(saves[2].id), "list_by_source(claude_ai) missing the claude_ai row");
  assert(!aiIds.includes(saves[0].id), "list_by_source(claude_ai) leaked a claude_code row");
  console.log("list_by_source OK");

  // --- delete_memory (soft delete) --------------------------------------------
  r = await callTool(client, "delete_memory", { id: saves[2].id });
  assert(!r.isError && r.payload.deleted === true, `delete_memory failed: ${r.text}`);
  r = await callTool(client, "search_memory", { query: `gamma ${RUN_ID}` });
  assert(r.payload.count === 0, "deleted memory still shows up in search");
  // Deleting again must report an error (already soft-deleted).
  r = await callTool(client, "delete_memory", { id: saves[2].id });
  assert(r.isError, "second delete of the same id should error");
  console.log("delete_memory OK (soft-deleted, hidden from search, double-delete rejected)");

  // --- consolidate_memory ------------------------------------------------------
  r = await callTool(client, "consolidate_memory", {
    memory_ids: [saves[0].id, saves[1].id],
    summary: `consolidated smoke summary ${RUN_ID}`,
    project: PROJECT,
    tags: [TAG],
  });
  assert(!r.isError, `consolidate_memory failed: ${r.text}`);
  assert(r.payload.consolidated_count === 2, "consolidated_count should be 2");
  const newId = r.payload.new_memory_id;
  assert(newId, "consolidate_memory returned no new id");
  // Old rows must be gone from search; new one findable.
  r = await callTool(client, "search_memory", { query: `alpha ${RUN_ID}` });
  assert(r.payload.count === 0, "consolidated source memory still visible");
  r = await callTool(client, "search_memory", { query: `consolidated smoke summary ${RUN_ID}` });
  assert(r.payload.count === 1 && r.payload.memories[0].id === newId, "new consolidated memory not found");
  // Consolidating already-consolidated ids must fail.
  r = await callTool(client, "consolidate_memory", {
    memory_ids: [saves[0].id, saves[1].id],
    summary: "should fail",
  });
  assert(r.isError, "consolidating already-deleted ids should error");
  console.log("consolidate_memory OK (merged 2 -> 1, sources hidden, re-consolidate rejected)");

  // --- delete_by_filter: two-step confirm --------------------------------------
  // Empty filter must be rejected.
  r = await callTool(client, "delete_by_filter", {});
  assert(r.isError, "empty delete_by_filter should error");
  // Step 1: no confirm — reports matches, deletes nothing.
  r = await callTool(client, "delete_by_filter", { project: PROJECT });
  assert(!r.isError, `delete_by_filter step 1 failed: ${r.text}`);
  assert(r.payload.deleted === false, "step 1 must not delete");
  assert(r.payload.matched_count === 1, `expected 1 live match (the consolidated row), got ${r.payload.matched_count}`);
  // Step 2: confirm — actually deletes.
  r = await callTool(client, "delete_by_filter", { project: PROJECT, confirm: true });
  assert(r.payload.deleted === true && r.payload.matched_count === 1, `step 2 failed: ${r.text}`);
  r = await callTool(client, "search_memory", { project: PROJECT });
  assert(r.payload.count === 0, "rows remain after confirmed delete_by_filter");
  console.log("delete_by_filter OK (two-step confirm, empty filter rejected)");

  // --- secret filter -------------------------------------------------------------
  r = await callTool(client, "save_memory", {
    content: "my key is sk-abcdefghijklmnop1234",
    source: "claude_ai",
  });
  assert(r.isError, "secret filter did not reject credential content");
  // Secrets hidden in tags or project must be caught too.
  r = await callTool(client, "save_memory", {
    content: "harmless content",
    source: "claude_ai",
    tags: ["ghp_ABCDEFghijklmnopqrst0123456789"],
  });
  assert(r.isError && r.text.includes("in tags"), "secret filter did not reject credential in tags");
  r = await callTool(client, "save_memory", {
    content: "harmless content",
    source: "claude_ai",
    project: "password=hunter2-super-secret",
  });
  assert(r.isError && r.text.includes("in project"), "secret filter did not reject credential in project");
  console.log("secret filter OK (credential in content, tags, and project all rejected)");

  // --- consolidate_memory duplicate-id fast failure ---------------------------
  r = await callTool(client, "consolidate_memory", {
    memory_ids: [saves[0].id, saves[0].id],
    summary: "should fail before touching the db layer",
  });
  assert(r.isError && r.text.includes("DISTINCT"), `duplicate ids not rejected clearly: ${r.text}`);
  console.log("consolidate_memory duplicate-id rejection OK");

  await client.close();
  console.log("SMOKE TEST PASSED");
} catch (err) {
  failed = true;
  console.error("SMOKE TEST FAILED:", err?.message ?? err);
} finally {
  child.kill();
}
process.exit(failed ? 1 : 0);
