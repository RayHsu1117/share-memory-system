# Bridge Memory Server — 技術詳解(Technical Reference)

> 本文件是 Bridge Memory Server 的**深度技術參考**,面向需要理解或維護實作細節的讀者。
> 快速上手、部署步驟請見 `README.md`;本文件不重複那些內容,只在必要時交叉引用。
> 內容完全依據原始碼(`src/db.ts`、`src/index.ts`、`src/oauth.ts`、`src/secret-filter.ts`、
> `package.json`、`.env.example`)實際行為撰寫,並與原始規格書
> `claude_bridge_memory_spec.md` 對照差異(見第 9 節)。

---

## 變更紀錄

**2026-07-06**:針對前一輪套用到程式碼上的修正,校對並更新本文件,異動摘要:

1. 新增 `POST /oauth/revoke`(RFC 7009 單一 token 撤銷)端點說明,並更新 §1.3
   端點總表、§5.4 metadata 範例(新增 `revocation_endpoint`)。
2. §2.5/§5.10/§8 原本記載「沒有 access token 主動撤銷端點」的敘述已更新:現在
   `/oauth/revoke` 可撤銷單一 access 或 refresh token,但仍未實作「偵測到 token
   被重放時連鎖撤銷整條 token 家族」的機制(§5.8 提到的限制依然存在,只是單次
   rotation,非重放偵測連鎖)。
3. §2.4 `oauth_codes` 新增了 `client_id → oauth_clients(client_id)` 的
   `FOREIGN KEY`(`ON DELETE CASCADE`),由 `MemoryDb.init()` 內一段冪等的
   additive migration 補上(含孤兒列清理),原本記載「沒有 FOREIGN KEY 約束」
   的敘述已更正。
4. §2.1 `memories` 新增 `idx_memories_created_at` 索引,更正原本「`created_at`
   沒有索引」的敘述。
5. §3.1/§3.7/§6 更新憑證過濾範圍:`detectSecretInFields` 現在也會掃描
   `tags`、`project`,不再只檢查 `content`/`summary`。
6. §2.8/§3.7 新增說明:`consolidate_memory` 現在會在 `index.ts` 工具層對
   `memory_ids` 去重後先檢查唯一值數量,不足 2 筆會立刻回傳明確錯誤訊息,不必
   等呼叫深入 DB 層才失敗(DB 層原本的同一檢查仍保留,退居 defense-in-depth)。
7. §7.1 更正:`.env.example` 現已補上 `PUBLIC_BASE_URL`/`OAUTH_SIGNING_SECRET`/
   `OAUTH_OWNER_PASSWORD` 三項,原本記載的落差已修正。

---

## 1. 架構總覽

### 1.1 元件圖

```
┌──────────────┐                              ┌──────────────┐
│  claude.ai   │                              │ Claude Code  │
│ (custom      │                              │ (claude mcp  │
│  connector)  │                              │    add)      │
└──────┬───────┘                              └──────┬───────┘
       │  MCP over Streamable HTTP (JSON-RPC 2.0, HTTPS)     │
       │  Authorization: Bearer <OAuth access token>          │
       │                                       Authorization: Bearer <BRIDGE_AUTH_TOKEN>
       ▼                                              ▼
┌─────────────────────────────────────────────────────────────┐
│  node:http 原生 HTTP server(src/index.ts,無 Express)         │
│  ─ 路由分派(依 URL path + method):                            │
│    1. GET /healthz                     → 未認證,健康檢查        │
│    2. OAuth / discovery 路由(見 §5)     → OAuthProvider.handle │
│    3. POST /mcp 或 POST /               → 進雙重認證 middleware │
│  ─ 雙重認證 middleware(isAuthorized,見 §4):                    │
│    (a) 固定 Bearer token(BRIDGE_AUTH_TOKEN,constant-time)     │
│    (b) OAuth 2.1 access token(HMAC 查表,src/oauth.ts)          │
│  ─ 通過認證後:為這次 POST 建立全新的                              │
│    McpServer + StreamableHTTPServerTransport(無 session)       │
└───────────────────────────┬───────────────────────────────────┘
                            │  buildServer() 註冊 7 個工具
                            ▼
        ┌─────────────────────────────────────────────┐
        │  7 個 MCP tool handlers(save/search/get_recent│
        │  /list_by_source/delete/delete_by_filter/     │
        │  consolidate)+ secret-filter.ts 憑證過濾        │
        └───────────────────────┬───────────────────────┘
                                 │  MemoryDb(src/db.ts,pg.Pool)
                                 ▼
                     ┌───────────────────────┐
                     │   Postgres(Railway)    │
                     │ memories / memory_     │
                     │ consolidations /       │
                     │ oauth_clients /        │
                     │ oauth_codes / oauth_   │
                     │ tokens                 │
                     └───────────────────────┘
```

值得注意:程式碼庫的 `node_modules` 中存在 `express`、`hono`、`cors` 等套件,但這些是
`@modelcontextprotocol/sdk` 的間接相依套件(SDK 內部/範例可能用得到),`src/index.ts`
實際上完全沒有 import 或使用它們——整個 HTTP server 是用 Node 內建的 `node:http`
`createServer` 手刻的,沒有任何 Express/Hono 中介層。

### 1.2 Stateless Transport 設計

`main()` 裡對每一個進來的 POST 請求都執行:

```ts
const server = buildServer();
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
res.on("close", () => { void transport.close(); void server.close(); });
await server.connect(transport);
await transport.handleRequest(req, res);
```

也就是說**每一次 HTTP POST 都會建立一組全新的 `McpServer` + `StreamableHTTPServerTransport`
實例**,處理完(或連線關閉)後立刻 `close()` 丟棄,不保留任何 session 狀態
(`sessionIdGenerator: undefined` 明確關閉 session id 機制)。

這樣設計的原因(程式碼註解與架構共同指出):

- **水平擴展友善**:Railway 這類平台可能同時跑多個 instance 或重啟服務,若 transport
  帶 session 狀態,請求路由到不同 instance 就會遺失上下文;無狀態設計讓每個請求各自獨立、
  可路由到任何一個 instance。
- **claude.ai 與 Claude Code 併發使用同一台伺服器**:兩端各自的請求互不影響、不共用
  記憶體內的 server/transport 物件,天然避免 race condition。
- **`enableJsonResponse: true`**:直接回傳一般 JSON 回應而非 SSE event stream,搭配
  stateless 模式最簡單。
- 因為是 stateless 模式,`/mcp` 只接受 `POST`;`GET`(SSE 通知流)與 `DELETE`
  (顯式終止 session)在這個部署裡沒有意義,呼叫會得到 `405 Method not allowed`。

### 1.3 端點總表

| 方法 | 路徑 | 認證 | 說明 |
|---|---|---|---|
| `GET` | `/healthz` | 無 | 存活探測,只回 `{"status":"ok"}`,不暴露任何資料 |
| `POST` | `/mcp`(或 `/`) | 雙重認證(§4) | MCP JSON-RPC 端點,唯一的工具呼叫入口 |
| `GET` | `/.well-known/oauth-protected-resource[/*]` | 無 | RFC 9728 protected-resource metadata |
| `GET` | `/.well-known/oauth-authorization-server[/*]` | 無 | RFC 8414 authorization-server metadata |
| `POST` | `/oauth/register` | 無(公開註冊) | RFC 7591 Dynamic Client Registration |
| `GET`/`POST` | `/oauth/authorize` | Owner password(表單) | PKCE 授權 + 核准頁 |
| `POST` | `/oauth/token` | 無(以 code/refresh_token 本身為憑證) | 換發 access/refresh token |
| `POST` | `/oauth/revoke` | 無(以 token 本身為憑證) | RFC 7009 撤銷單一 access 或 refresh token(見 §5.11) |

以上 OAuth 相關路由只有在 `OAUTH_ENABLED`(見 §7)為真時才會被註冊/處理;若 OAuth 未啟用,
這些路徑一律落入 `/mcp` 的路由判斷,回傳 `404`。

---

## 2. 資料庫 Schema 完整規格

所有資料表皆由 `MemoryDb.init()` 在啟動時以 `CREATE TABLE IF NOT EXISTS` 建立,
沒有額外的 migration 工具。時間戳一律是 **TEXT 型別、JS 端產生的 ISO-8601 字串**
(`new Date().toISOString()`),不是 Postgres 原生的 `timestamp` 型別
——這是刻意從 SQLite 版本移植過來的慣例,讓字串排序與 `older_than` 比較行為
與舊版一致(ISO-8601 字串在同一時區/格式下,字典序排序等同時間序排序)。

### 2.1 `memories`

```sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,              -- uuid(randomUUID() 產生)
  content TEXT NOT NULL,            -- 記憶內容
  source TEXT NOT NULL,             -- 'claude_ai' | 'claude_code'(僅應用層以 zod enum 保證,DB 無 CHECK)
  tags TEXT,                        -- JSON array 字串,例如 ["job-search","taiwan-md"];無標籤時為 NULL
  project TEXT,                     -- 選填,對應的專案/情境
  created_at TEXT NOT NULL,         -- ISO-8601,JS 產生
  updated_at TEXT NOT NULL,
  superseded_by TEXT,               -- 整合後指向新記憶的 id;未被整合則為 NULL
  deleted_at TEXT                   -- 軟刪除時間戳;NULL = 存活
);

CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | `TEXT` (PK) | UUID v4,`node:crypto` 的 `randomUUID()` |
| `content` | `TEXT NOT NULL` | 記憶正文,`save_memory`/`consolidate_memory` 寫入前先過 `detectSecret` |
| `source` | `TEXT NOT NULL` | `'claude_ai'` 或 `'claude_code'`;只在 TypeScript/zod 層檢查,資料庫沒有 `CHECK` 約束 |
| `tags` | `TEXT` (nullable) | 標籤陣列以 `JSON.stringify` 存成純文字;無標籤時存 `NULL`(不是 `"[]"`) |
| `project` | `TEXT` (nullable) | 自由文字的專案/情境標籤 |
| `created_at` / `updated_at` | `TEXT NOT NULL` | ISO-8601;`updated_at` 在軟刪除、整合時會被更新 |
| `superseded_by` | `TEXT` (nullable) | 指向 `consolidate_memory` 產生的新記憶 id |
| `deleted_at` | `TEXT` (nullable) | 軟刪除標記;所有一般查詢都加 `WHERE deleted_at IS NULL` |

**索引觀察**:`source`、`project`、`created_at` 三個欄位各自有一般 b-tree 索引。
所有列表類查詢(`search_memory`、`get_recent_memory`、`list_by_source`)都用
`ORDER BY created_at DESC LIMIT n`,`created_at` 上的 b-tree 索引可以用反向掃描
(backward scan)滿足這個排序,不必每次都對全表排序。`search_memory` 的關鍵字
比對用 `content ILIKE '%...%'` 則刻意維持循序掃描——程式碼註解說明:要加速這種
比對需要 `pg_trgm` extension 提供的 trigram/GIN 索引,但 `CREATE EXTENSION
pg_trgm` 在部分受管理的 Postgres 服務上可能沒有權限執行而導致啟動失敗,在個人
規模的資料量下,權衡之後認為不值得冒這個風險。

### 2.2 `memory_consolidations`

```sql
CREATE TABLE IF NOT EXISTS memory_consolidations (
  id TEXT PRIMARY KEY,                    -- uuid
  consolidated_memory_id TEXT NOT NULL,   -- 整合後的新記憶
  source_memory_id TEXT NOT NULL,         -- 被整合掉的舊記憶
  created_at TEXT NOT NULL,
  FOREIGN KEY (consolidated_memory_id) REFERENCES memories(id),
  FOREIGN KEY (source_memory_id) REFERENCES memories(id)
);
```

每次 `consolidate_memory` 針對「新記憶 × 每一筆被整合的舊記憶」各寫入一列,是
多對一的追溯關係表。因為應用程式從不對 `memories` 做真正的 `DELETE`(全部是軟刪除的
`UPDATE`),這兩條 `FOREIGN KEY` 實務上不會因為刪除動作而違反。

### 2.3 `oauth_clients`(RFC 7591 動態註冊的客戶端)

```sql
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,               -- 隨機 uuid
  client_name TEXT,
  redirect_uris TEXT NOT NULL,              -- JSON array,精確比對用
  token_endpoint_auth_method TEXT NOT NULL, -- 恆為 'none'(public client + PKCE)
  grant_types TEXT NOT NULL,                -- JSON array
  response_types TEXT NOT NULL,             -- JSON array
  created_at TEXT NOT NULL
);
```

沒有 `client_secret` 欄位——這個伺服器只支援 **public client**(`token_endpoint_auth_method:
"none"`),安全性完全靠 PKCE 而非 client secret,這是刻意的設計(見 §5)。

### 2.4 `oauth_codes`(短命的授權碼)

```sql
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,               -- HMAC(code),絕不存明碼
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,             -- PKCE S256 challenge
  scope TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT                              -- 非 NULL = 已兌換過
);
```

`client_id` 現在**有** `FOREIGN KEY` 約束指向 `oauth_clients(client_id)`,
`ON DELETE CASCADE`——手動刪除一個註冊過的 client 時,它名下殘留的 `oauth_codes`
列會被連帶刪除,不會孤兒化。這個約束不是寫在上面的 `CREATE TABLE IF NOT EXISTS`
裡,而是 `MemoryDb.init()` 額外執行的一段**冪等的 additive migration**(每次啟動
都會跑一次):

```sql
-- 1) 先清掉孤兒列:授權碼本來就是 5 分鐘內單次使用的短命資料,直接刪除無風險,
--    否則 ADD CONSTRAINT 會因為既有的孤兒列而失敗。
DELETE FROM oauth_codes
 WHERE client_id NOT IN (SELECT client_id FROM oauth_clients);

-- 2) Postgres 沒有 ADD CONSTRAINT IF NOT EXISTS,所以用 pg_constraint 查詢
--    手動模擬「不存在才新增」,確保重複執行這段 migration 是安全的。
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
```

這樣設計讓既有(在此約束加入之前就已存在)的資料庫可以在下次重啟時安全補上這個
約束,不會因為歷史孤兒列讓 `ALTER TABLE` 失敗,也不會在約束已存在時重複嘗試而
出錯。過期的列本身仍然不會被清除——沒有背景清理工作(cleanup job),過期判斷
依舊完全在查詢當下用 `expires_at > now` 比較完成(見 2.6)。

### 2.5 `oauth_tokens`(已核發的 access/refresh token)

```sql
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,              -- HMAC(token),絕不存明碼
  kind TEXT NOT NULL,                       -- 'access' | 'refresh'
  client_id TEXT NOT NULL,
  scope TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT                           -- 非 NULL = 已撤銷(refresh rotation 用)
);
```

`kind` 同樣沒有 DB 層 `CHECK` 約束。`revoked_at` 有兩條寫入路徑:(1) refresh
token 被 rotation 消費時自動設定(見 §5.8);(2) 呼叫端主動打 `POST /oauth/revoke`
(見 §5.11)時,經 `MemoryDb.revokeToken(tokenHash)` 設定——這條路徑對 access
token、refresh token 皆適用(`revokeToken` 只以 `token_hash` 主鍵比對,不篩選
`kind`)。也就是說,**access token 現在也有主動撤銷的手段**,不必再完全依賴
1 小時的自然到期;但仍然沒有「偵測到某個 token 被撤銷後又被重放時,連鎖撤銷
同一批/同一使用者其他 token」的機制——`oauth_tokens` 沒有欄位記錄同一批核發的
access+refresh token 屬於同一個 lineage/session,每個 token 只能個別撤銷。

### 2.6 軟刪除模型與過濾規則

`deleted_at IS NULL` 被加在下列每一個「一般讀取」查詢中:

- `getById`
- `searchMemory`
- `getRecent`
- `listBySource`
- `deleteByFilter` 內部先執行的 `SELECT id ... WHERE ...`(取得符合條件、且仍存活的 id)
- `consolidateMemory` 驗證 `memory_ids` 是否存活的 `SELECT`

例外:`getSourceOfAny(id)` **刻意不過濾** `deleted_at`,可以讀到已軟刪除記憶的
`source`。它只在 `index.ts` 的 `consolidate_memory` handler 中,於呼叫
`db.consolidateMemory` **之前**用來推導新記憶的 `source`(此時目標記憶通常仍是
存活狀態,尚未被標記刪除),其設計目的是「即使之後這筆記憶被標記刪除,仍能回頭
查出它原本的來源」的通用工具函式。

**刪除的兩種寫入路徑**:

1. `deleteMemory(id)`:`UPDATE memories SET deleted_at=now, updated_at=now
   WHERE id=$1 AND deleted_at IS NULL`。條件式的 `WHERE deleted_at IS NULL`
   讓它天生冪等——對已刪除的 id 再呼叫一次,`rowCount` 是 0,回傳 `false`。
2. `deleteByFilter(filters, confirm)` / `consolidateMemory`:同樣的
   `deleted_at IS NULL` guard,只是用 `WHERE id = ANY($ids)` 批次更新。

### 2.7 關鍵字與標籤比對的實作細節

**關鍵字搜尋**(`search_memory` 的 `query`):

```sql
content ILIKE '%<escaped query>%' ESCAPE '\'
```

`escapeLike()` 會把使用者輸入裡的 `\ % _` 都加上反斜線跳脫,確保這些字元被當成
**字面值**而非 SQL `LIKE`/`ILIKE` 的萬用字元。原始碼註解特別指出:SQLite 的 `LIKE`
對 ASCII 是大小寫不敏感,但 Postgres 的 `LIKE` **是**大小寫敏感的,所以這裡改用
`ILIKE` 以維持與舊版(SQLite)相同的行為。

**標籤比對**(`search_memory` 的 `tags` / `delete_by_filter` 的 `tags`):

標籤陣列在 DB 裡是存成 JSON 陣列的**純文字字串**(例如 `["job-search","urgent"]`),
沒有使用 Postgres 的 `jsonb` 型別或 `@>` 包含運算子。比對方式是對「每一個要求的
tag」各自產生一個條件:

```sql
tags ILIKE '%"<escaped tag>"%' ESCAPE '\'
```

也就是在原始 JSON 字串裡尋找**帶雙引號的精確 tag 子字串**。因為前後都帶雙引號,
可以避免「`job`」誤配到「`job-search`」這種前綴子字串(`"job-search"` 這個子字串裡
並不包含連續的 `"job"` 四個字元,因為 `job` 後面接的是 `-` 而非收尾引號)。多個
tag 條件之間是 **AND** 關係——`search_memory`/`delete_by_filter` 的 `tags` 語意是
「必須同時擁有全部列出的 tag」,而不是「符合任一個」。

**`older_than` 比對**(`delete_by_filter` 專用):`created_at < $older_than`,直接
字串比較。因為兩邊都是 ISO-8601、UTC(`Z` 結尾)格式,字典序等同時間序,行為正確;
但呼叫端若傳入非標準格式字串,行為未定義(工具層有先做 `Date.parse` 驗證,見 §3)。

### 2.8 `consolidateMemory` 交易邏輯

```ts
async consolidateMemory(input): Promise<{ newMemory; consolidatedCount }> {
  const uniqueIds = [...new Set(input.memory_ids)];
  if (uniqueIds.length < 2) throw new Error(...);          // 去重後仍需 >= 2 筆

  // 1) 先驗證全部目標都存在且存活
  const liveIds = ...;                                       // SELECT id WHERE id=ANY() AND deleted_at IS NULL
  const missing = uniqueIds.filter(id => !liveIds.has(id));
  if (missing.length > 0) throw new Error(`... ${missing.join(", ")}`);

  // 2) 單一交易內:插入新記憶 → 逐筆標記舊記憶 superseded_by + 軟刪除 → 寫入追溯關聯
  BEGIN;
    INSERT INTO memories (...) VALUES (newId, summary, ...);
    for (oldId of uniqueIds) {
      UPDATE memories SET superseded_by=newId, deleted_at=now, updated_at=now
        WHERE id=oldId AND deleted_at IS NULL;
      INSERT INTO memory_consolidations (...) VALUES (uuid, newId, oldId, now);
    }
  COMMIT;  // 任何一步失敗 ROLLBACK,client.release() 保證在 finally 執行
}
```

要點:

- 使用**獨立取得的 `pool.connect()` client**手動下 `BEGIN`/`COMMIT`/`ROLLBACK`,
  而不是每個語句各自的隱式交易——確保「新增新記憶 + 逐筆標記舊記憶 + 寫入追溯關聯」
  是一個原子操作,任何一步例外都會整批回滾。
- **去重後仍需要至少 2 筆不同的 `memory_ids`**——這與呼叫端(`index.ts`)的 zod schema
  `z.array(z.string()).min(2)` 不完全等價:zod 只檢查「陣列長度 >= 2」,不會檢查
  「陣列內容是否重複」。所以呼叫端傳入 `["a", "a"]`(同一個 id 兩次)可以通過 zod
  驗證。**這個邊界案例現在會在 `index.ts` 的工具層被提前攔截**:handler 對
  `memory_ids` 先做一次 `new Set(...)` 去重計數,若唯一值少於 2 筆就直接回傳
  一則明確的 `isError` 訊息(見 §3.7),根本不會呼叫到 `db.consolidateMemory`。
  這裡描述的 `db.consolidateMemory` 內部去重檢查依然存在、行為不變,只是在正常
  呼叫路徑下退居 defense-in-depth 的角色。
- 新記憶讀回(`getById(newId)`)是在 `COMMIT` **之後**另外執行的一次查詢,不在同一個
  交易內(此時交易已提交,資料已可見,不影響正確性)。

**`source` 的推導邏輯**(`index.ts`,非 `db.ts`):

```ts
let resolvedSource: Source | undefined = source;              // 呼叫端可明確指定
if (!resolvedSource) {
  const sources = (await Promise.all(memory_ids.map(id => db.getSourceOfAny(id))))
    .filter((s): s is string => s !== null);
  const first = sources[0];
  resolvedSource = first === "claude_ai" || first === "claude_code" ? first : "claude_code";
}
```

工具描述文字寫的是「若省略:採用被整合記憶們一致的來源,若不一致則採用第一筆的來源」,
但**實際程式碼並沒有真的檢查是否一致**——它只是單純取 `sources[0]`(第一筆非 null 的
來源),完全不管其餘記憶的 `source` 是否相同。這是描述文字與程式行為之間的一個小落差,
但因為「混合來源整合」是罕見情境,對實務影響很小,記錄於此供參考。

---

## 3. 7 個 MCP 工具完整規格

所有工具的成功回應統一包成:

```ts
{ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
```

失敗(業務邏輯錯誤,非協定層錯誤)統一包成:

```ts
{ content: [{ type: "text", text: "<純文字錯誤訊息>" }], isError: true }
```

也就是說**回傳值本體其實是一段 JSON 字串,被包在單一個 `text` content block 裡**
(MCP 沒有使用 structured content),呼叫端(LLM)要自己剖析這段文字。以下範例皆為
**示意用**(illustrative),欄位值為虛構。

### 3.1 `save_memory`

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `content` | `string`(`min(1)`) | 是 | 記憶內容 |
| `source` | `"claude_ai" \| "claude_code"` | 是 | 寫入端 |
| `tags` | `string[]` | 否 | 標籤 |
| `project` | `string` | 否 | 專案/情境 |

行為:先用 `detectSecretInFields` 檢查 `content`、`tags`、`project` 是否疑似含有
憑證(見 §6),命中就拒絕寫入並回傳 `isError`;沒問題才呼叫 `db.saveMemory`。

```jsonc
// 請求(tools/call params.arguments)
{ "content": "使用者偏好在週五下午進行 code review", "source": "claude_code",
  "tags": ["workflow"], "project": "bridge-server" }
```
```jsonc
// 成功回應(content[0].text 內的 JSON)
{
  "saved": true,
  "memory": {
    "id": "3fa8b1de-6c2a-4e1d-9c3f-1a2b3c4d5e6f",
    "content": "使用者偏好在週五下午進行 code review",
    "source": "claude_code",
    "tags": ["workflow"],
    "project": "bridge-server",
    "created_at": "2026-07-06T03:12:00.000Z",
    "updated_at": "2026-07-06T03:12:00.000Z"
  }
}
```
```jsonc
// 命中憑證過濾時(isError: true;訊息裡的 "in content" 會依實際命中欄位換成
// "in tags" 或 "in project")
"Refused to save: input appears to contain a credential (API key (sk-...) in content). Never store API keys, passwords, or tokens in the memory bridge. (Heuristic check — rephrase without the secret and retry.)"
```

### 3.2 `search_memory`

| 欄位 | 型別 | 必填 | 預設 |
|---|---|---|---|
| `query` | `string` | 否 | — |
| `tags` | `string[]` | 否(需**全部**符合) | — |
| `project` | `string` | 否 | — |
| `limit` | `int, 1–100` | 否 | `10` |

```jsonc
// 請求
{ "query": "code review", "tags": ["workflow"], "limit": 5 }
```
```jsonc
// 回應
{ "count": 1, "memories": [ { "id": "3fa8b1de-...", "content": "...", "source": "claude_code",
  "tags": ["workflow"], "project": "bridge-server", "created_at": "...", "updated_at": "..." } ] }
```

### 3.3 `get_recent_memory`

| 欄位 | 型別 | 必填 | 預設 |
|---|---|---|---|
| `limit` | `int, 1–100` | 否 | `10` |

不分 `source`/`project`,單純依 `created_at DESC` 取最近 N 筆。

```jsonc
{ "limit": 3 }
```
```jsonc
{ "count": 3, "memories": [ /* 最新 3 筆,新到舊 */ ] }
```

### 3.4 `list_by_source`

| 欄位 | 型別 | 必填 | 預設 |
|---|---|---|---|
| `source` | `"claude_ai" \| "claude_code"` | 是 | — |
| `limit` | `int, 1–200` | 否 | `20` |

```jsonc
{ "source": "claude_ai", "limit": 20 }
```
```jsonc
{ "count": 2, "memories": [ /* 依 created_at DESC */ ] }
```

### 3.5 `delete_memory`

| 欄位 | 型別 | 必填 |
|---|---|---|
| `id` | `string`(`min(1)`) | 是 |

單筆軟刪除。若目標 id 不存在或已被刪除(不論是單筆刪除還是先前被
`consolidate_memory` 標記為 `superseded_by`),回傳 `isError`,不會拋協定層例外。

```jsonc
{ "id": "3fa8b1de-6c2a-4e1d-9c3f-1a2b3c4d5e6f" }
```
```jsonc
// 成功
{ "deleted": true, "id": "3fa8b1de-6c2a-4e1d-9c3f-1a2b3c4d5e6f" }
```
```jsonc
// 找不到 / 已刪除(isError: true)
"No live memory found with id 3fa8b1de-6c2a-4e1d-9c3f-1a2b3c4d5e6f (it may not exist or was already deleted)."
```

### 3.6 `delete_by_filter` — 兩段式確認流程

| 欄位 | 型別 | 必填 | 預設 |
|---|---|---|---|
| `source` | `"claude_ai" \| "claude_code"` | 否 | — |
| `project` | `string` | 否 | — |
| `tags` | `string[]`(需全部符合) | 否 | — |
| `older_than` | `string`(ISO 日期/時間) | 否 | — |
| `confirm` | `boolean` | 否 | `false` |

**至少要提供 `source`/`project`/`tags`/`older_than` 其中一項**——工具層與
`db.deleteByFilter` 各自都會檢查一次(defense in depth),空條件會被直接拒絕,
避免誤傳空物件把整張表清空。`older_than` 另外會用 `Date.parse` 驗證格式,無效日期
直接回錯誤,不會送進 SQL。

**流程**:
1. 第一次呼叫(不帶 `confirm` 或 `confirm:false`)→ 只執行 `SELECT`,回傳符合條件的
   `matched_count`/`matched_ids`,**不刪除任何資料**,並附上提示文字要求呼叫端與
   使用者確認。
2. 呼叫端(LLM)應把符合的筆數/內容念給使用者確認。
3. 第二次呼叫,帶上完全相同的篩選條件 + `confirm: true`,才真正執行
   `UPDATE ... SET deleted_at=now WHERE id = ANY($ids) AND deleted_at IS NULL`。

```jsonc
// 第一次呼叫(未確認)
{ "project": "old-project", "older_than": "2025-01-01T00:00:00Z" }
```
```jsonc
{
  "matched_count": 4,
  "matched_ids": ["id-1", "id-2", "id-3", "id-4"],
  "deleted": false,
  "note": "Nothing was deleted. Confirm the list with the user, then call again with confirm:true to perform the soft delete."
}
```
```jsonc
// 第二次呼叫(帶 confirm:true,條件相同)
{ "project": "old-project", "older_than": "2025-01-01T00:00:00Z", "confirm": true }
```
```jsonc
{ "matched_count": 4, "matched_ids": ["id-1", "id-2", "id-3", "id-4"], "deleted": true }
```
```jsonc
// 空條件(isError: true)
"delete_by_filter requires at least one non-empty filter (source, project, tags, or older_than)."
```

### 3.7 `consolidate_memory`

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `memory_ids` | `string[]`(`min(2)`) | 是 | 要被整合的舊記憶 id(見 §2.8 的去重邊界案例) |
| `summary` | `string`(`min(1)`) | 是 | 整合後內容,由**呼叫端的 LLM** 先寫好摘要;伺服器不做任何摘要判斷 |
| `project` | `string` | 否 | 新記憶的專案 |
| `tags` | `string[]` | 否 | 新記憶的標籤 |
| `source` | `"claude_ai" \| "claude_code"` | 否 | 見 §2.8 的來源推導邏輯 |

行為(依實際程式碼執行順序):

1. 先用 `detectSecretInFields` 檢查 `summary`、`tags`、`project` 是否疑似含有
   憑證(見 §6),命中即拒絕並回傳 `isError`。
2. **在呼叫 `db.consolidateMemory` 之前**,`index.ts` 這一層先對 `memory_ids`
   做 `new Set(...)` 去重並檢查唯一值數量:去重後若少於 2 筆,直接回傳一則清楚
   的 `isError` 訊息(見下方範例),呼叫不會再往下傳到 DB 層。這是新增的
   fail-fast 檢查——`db.consolidateMemory` 內部原本就有的同一個去重檢查(見
   §2.8)依然保留,作為 defense-in-depth,但正常呼叫路徑下重複 id 現在會在工具
   層就被攔下,拿到的錯誤訊息也比原本純 DB 層錯誤更明確。
3. 推導 `source`(見 §2.8)。
4. 呼叫 `db.consolidateMemory`——內部驗證全部 `memory_ids` 存活、在單一交易內
   插入新記憶、把每筆舊記憶標記 `superseded_by` + 軟刪除、寫入
   `memory_consolidations` 追溯列。

```jsonc
// 請求
{
  "memory_ids": ["id-1", "id-2", "id-3"],
  "summary": "使用者過去三次都偏好把 code review 排在週五下午,且偏好簡短摘要而非逐行註解。",
  "project": "bridge-server",
  "tags": ["workflow", "code-review"]
}
```
```jsonc
// 成功回應
{
  "new_memory_id": "c9d8e7f6-....",
  "consolidated_count": 3,
  "new_memory": {
    "id": "c9d8e7f6-....",
    "content": "使用者過去三次都偏好把 code review 排在週五下午,且偏好簡短摘要而非逐行註解。",
    "source": "claude_code",
    "tags": ["workflow", "code-review"],
    "project": "bridge-server",
    "created_at": "2026-07-06T04:00:00.000Z",
    "updated_at": "2026-07-06T04:00:00.000Z"
  }
}
```
```jsonc
// 有 id 不存在/已刪除(isError: true)
"These memory_ids do not exist or are already deleted: id-2"
```
```jsonc
// memory_ids 去重後少於 2 筆(isError: true;在 index.ts 工具層被攔截,
// 不會到達 DB 層)
"consolidate_memory needs at least 2 DISTINCT memory_ids, but the 2 id(s) provided contain only 1 unique value. Remove the duplicated id(s) and pass two or more different memory ids."
```

工具總表:

| Tool | 讀/寫 | 二次確認 | 過濾憑證 |
|---|---|---|---|
| `save_memory` | 寫 | 否 | 是 |
| `search_memory` | 讀 | — | — |
| `get_recent_memory` | 讀 | — | — |
| `list_by_source` | 讀 | — | — |
| `delete_memory` | 寫(軟刪除) | 否(單筆,呼叫端自行先搜尋確認 id) | — |
| `delete_by_filter` | 寫(軟刪除) | **是**(`confirm` 欄位) | — |
| `consolidate_memory` | 寫 | 否 | 是(對 `summary`) |

---

## 4. 雙重認證機制詳解

`/mcp`(以及等價的 `/`)的認證邏輯集中在 `index.ts` 的 `isAuthorized()`:

```ts
async function isAuthorized(req): Promise<boolean> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length);
  if (matchesStaticToken(token)) return true;   // (a) 固定 token 路徑
  if (oauth) return oauth.verifyAccessToken(token); // (b) OAuth access token 路徑
  return false;
}
```

### 4.1 路徑 (a):固定 Bearer Token(`BRIDGE_AUTH_TOKEN`)

```ts
function matchesStaticToken(presentedToken: string): boolean {
  const presented = Buffer.from(presentedToken);
  const expected = Buffer.from(AUTH_TOKEN as string);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
```

- 這是 v1 就存在的路徑,主要給 Claude Code(`claude mcp add ... --header
  "Authorization: Bearer <token>"`)使用。
- 使用 `crypto.timingSafeEqual` 做**常數時間比對**,避免逐位元組時間側channel 洩漏
  token 內容。
- 長度不同時直接短路回傳 `false`(`timingSafeEqual` 本身要求兩個 buffer 等長,否則會
  丟例外),這是必要的前置檢查,而非額外的安全弱點——攻擊者能得到的訊息僅止於
  「長度是否吻合」,對固定格式、固定長度產生的 token 沒有實質資訊價值。

### 4.2 路徑 (b):OAuth 2.1 Access Token

只有在 `OAUTH_ENABLED`(`OAUTH_SIGNING_SECRET` 與 `OAUTH_OWNER_PASSWORD` 皆有設定)
為真時,`oauth` 物件才存在,才會嘗試這條路徑。驗證方式是把呈上的 token 用
`HMAC-SHA256(OAUTH_SIGNING_SECRET, token)` 雜湊後,查 `oauth_tokens` 表
是否有一列 `token_hash` 相符、`kind='access'`、`revoked_at IS NULL`、
`expires_at > now`(詳見 §5.9)。

### 4.3 判斷順序與「未認證」時的行為

兩條路徑是 **OR** 關係:固定 token 對得上就直接放行,對不上才試 OAuth token
(若 OAuth 有啟用);兩者都不對、或 OAuth 未啟用時視為未認證。

未認證時的回應(`401`):

```http
HTTP/1.1 401
WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource", error="invalid_token"
Content-Type: application/json
```
```json
{ "jsonrpc": "2.0", "error": { "code": -32001, "message": "Unauthorized: missing or invalid Bearer token" }, "id": null }
```

若 OAuth 未啟用(`oauth` 為 `null`),`WWW-Authenticate` 退化成純粹的 `Bearer`
(不帶 `resource_metadata`),但回應 body 結構相同。

`WWW-Authenticate` 帶上 `resource_metadata` 指向 protected-resource metadata
端點,是依照 RFC 9728 §5.1 的設計:讓一個原本完全不知道這台伺服器存在 OAuth
的用戶端,能單純從一次 401 回應就發現「應該去問 `.well-known` 才能拿到正確的
authorization server」,這正是 claude.ai 自訂連接器探索流程所依賴的機制(見 §5)。

非 `POST` 打到 `/mcp` 會得到 `405`(`Allow: POST`,body 為
`{jsonrpc:"2.0", error:{code:-32000, message:"Method not allowed; use POST"}, id:null}`)。
不屬於 `/mcp`、`/`、`/healthz`、OAuth 路由的任何路徑一律 `404`
(`{"error":"not found; the MCP endpoint is POST /mcp"}`,注意這個 404 body
不是 JSON-RPC 格式,是純物件)。

---

## 5. OAuth 2.1 + PKCE + DCR 完整流程

### 5.1 為什麼需要完整 OAuth(而不只是固定 token)

`BRIDGE_AUTH_TOKEN` 這條固定 token 路徑對 Claude Code 很夠用,因為 `claude mcp add`
可以直接指定自訂 HTTP header。但 claude.ai 的「自訂連接器」(custom connector)UI
在新增連接器時,會**強制先嘗試標準的 OAuth 探索流程**(打
`/.well-known/oauth-protected-resource` 等 metadata 端點、進而嘗試 DCR),
且該 UI 並未提供「直接填一個固定 Authorization header」的選項——這點已由社群回報
(`anthropics/claude-ai-mcp` repo 的 issue #112、#457)證實。因此,若要讓
claude.ai 的自訂連接器能連上這個 bridge server,**完整的 OAuth 2.1 + PKCE + DCR
流程不是錦上添花,而是必要條件**;`BRIDGE_AUTH_TOKEN` 只解決得了 Claude Code 那一側。

### 5.2 Token 格式(重要澄清)

`src/oauth.ts` 檔頭註解明確寫著設計決策:**token 是不透明的隨機字串
(opaque random token),不是自我描述的 JWT**。產生方式:

```ts
function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("hex")}`;
}
```

- 授權碼前綴 `bmc_`、access token 前綴 `bma_`、refresh token 前綴 `bmr_`,
  後面接 32 bytes(64 個十六進位字元)的加密亂數。
- 資料庫**只存 `HMAC-SHA256(OAUTH_SIGNING_SECRET, token)` 的十六進位摘要**
  (`code_hash`/`token_hash` 欄位),從不存明碼。驗證時把呈上的 token 重新算一次
  HMAC,拿去比對資料庫裡的雜湊值(索引查詢,`O(1)`)。
- 選擇「opaque + HMAC 雜湊」而非「self-contained JWT」的理由(程式碼註解原文):
  同一個 env var 就能簽發/驗證、實作面更少活動零件、而且撤銷(revocation)與
  輪替(rotation)天生就有(因為驗證必須查資料庫,把該列標記撤銷/刪除即可生效;
  JWT 若不额外做黑名單機制,理論上在到期前是無法撤銷的)。

> 這點與規格書(見 §9)所寫的「第二版:OAuth2 + JWT」字面描述不同——實作出來的
> 並不是 JWT,是 opaque token + HMAC 雜湊儲存。文件在此明確記錄「真實程式碼行為」,
> 不是規格書原本設想的字面方案。

### 5.3 Token 生命週期

| 種類 | 常數 | 時長 |
|---|---|---|
| 授權碼(authorization code) | `CODE_TTL_MS` | 5 分鐘 |
| Access token | `ACCESS_TOKEN_TTL_S` | 1 小時(3600 秒) |
| Refresh token | `REFRESH_TOKEN_TTL_S` | 60 天(5,184,000 秒) |

### 5.4 端點與 Metadata

**`GET /.well-known/oauth-protected-resource`**(RFC 9728,含路徑後綴變體如
`/.well-known/oauth-protected-resource/mcp`,以 `startsWith` 相容部分用戶端
先嘗試「資源路徑」拼接的行為):

```json
{
  "resource": "https://bridge-server-production-4d23.up.railway.app/mcp",
  "authorization_servers": ["https://bridge-server-production-4d23.up.railway.app"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Bridge Memory MCP Server"
}
```

**`GET /.well-known/oauth-authorization-server`**(RFC 8414):

```json
{
  "issuer": "https://bridge-server-production-4d23.up.railway.app",
  "authorization_endpoint": ".../oauth/authorize",
  "token_endpoint": ".../oauth/token",
  "registration_endpoint": ".../oauth/register",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "revocation_endpoint": ".../oauth/revoke",
  "revocation_endpoint_auth_methods_supported": ["none"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["mcp"],
  "service_documentation": ".../healthz"
}
```

`revocation_endpoint`/`revocation_endpoint_auth_methods_supported` 是隨
`POST /oauth/revoke`(見 §5.11)新增的欄位;`"none"` 表示這個端點跟
`/oauth/token` 一樣,不需要 client secret 之類的端點認證,只靠 token 本身作為
憑證。

兩者皆設 `Cache-Control: no-store` 與 `Access-Control-Allow-Origin: *`。

### 5.5 `POST /oauth/register`(RFC 7591 DCR)

請求(JSON body):

```json
{ "redirect_uris": ["https://claude.ai/api/mcp/oauth/callback"], "client_name": "claude.ai" }
```

驗證規則:

- `redirect_uris` 必須是非空字串陣列;每一個 URI 必須通過 `isAcceptableRedirectUri`
  ——`https://` 任何 host 皆可,`http://` 只接受 loopback host
  (`localhost`/`127.0.0.1`/`[::1]`/`::1`,對應 RFC 8252 原生應用程式的慣例)。
- `token_endpoint_auth_method` 若提供,必須是 `"none"`(否則 400)
  ——**只支援 public client**,不支援任何形式的 client secret 驗證,PKCE 是唯一
  的防護手段。
- `grant_types` 預設 `["authorization_code","refresh_token"]`,只允許這兩種值。
- `response_types` 預設 `["code"]`,只允許 `"code"`。

成功回應(`201`):

```json
{
  "client_id": "b5c1a2d3-....",
  "client_id_issued_at": 1783401600,
  "client_name": "claude.ai",
  "redirect_uris": ["https://claude.ai/api/mcp/oauth/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

沒有 `client_secret` 欄位(因為根本不核發)。此端點**完全不需要認證**——任何人都能
註冊一個 client_id,但註冊到的 client 之後要走到「拿到 access token」為止,還得
通過 owner password 那一關(見 5.6),所以開放註冊本身風險有限。

### 5.6 `GET`/`POST /oauth/authorize`(PKCE + Owner Password 核准)

**Step 1 — 用戶端發起(通常是瀏覽器導頁)**:

```
GET /oauth/authorize
  ?response_type=code
  &client_id=b5c1a2d3-....
  &redirect_uri=https://claude.ai/api/mcp/oauth/callback
  &code_challenge=<BASE64URL(SHA256(code_verifier))>
  &code_challenge_method=S256
  &state=<opaque>
  &scope=mcp
```

`validateAuthorizeParams` 的驗證順序與錯誤回報方式(遵循 OAuth 2.1 安全 BCP):

1. `client_id` 找不到對應 client → **不重導**,直接回一個 HTML 錯誤頁(`400`)。
2. `redirect_uri` 缺漏,或不在該 client 註冊時登記的 `redirect_uris` 清單裡
   (精確字串比對)→ **不重導**,直接回 HTML 錯誤頁(`400`)。這兩步之所以不重導,
   是因為在驗證 `redirect_uri` 之前把使用者導去一個未經驗證的網址,本身就是一個
   開放重導(open redirect)風險。
3. 上述兩項都通過之後,其餘錯誤(`response_type` 不是 `"code"`、缺少
   `code_challenge`、`code_challenge_method` 不是 `"S256"`)一律用
   `302` 重導回 `redirect_uri`,並帶上 `error`/`error_description`/`state`
   查詢參數。
4. **只接受 `S256`,不支援 `plain`**——OAuth 2.1 對公開客戶端強制要求 PKCE,而
   這個伺服器進一步把 `code_challenge_method` 收斂成只有 `S256` 一種,拒絕較弱的
   `plain` 方法。

驗證全部通過後,`GET` 回傳一個 HTML 核准表單(`approvalFormPage`),把原始查詢參數
(`response_type`/`client_id`/`redirect_uri`/`code_challenge`/`code_challenge_method`
/`state`/`scope`/`resource`)全部放進隱藏欄位原樣帶過,只多一個密碼輸入欄。

值得一提:`resource` 這個查詢參數(RFC 8707 Resource Indicators)雖然被保留並透過
隱藏欄位傳遞下去,但伺服器**沒有對它做任何驗證或用途**(沒有 audience 限制邏輯)
——單純是「路過帶著走」。

**Step 2 — Owner 提交密碼**(`POST /oauth/authorize`,表單或 JSON):

```
password=<OAUTH_OWNER_PASSWORD 的值>
+ 上述所有隱藏欄位
```

- 密碼比對用 `safeEqual`:把兩個字串各自算 SHA-256 摘要後再用
  `timingSafeEqual` 比較(先雜湊成固定長度,天生沒有「長度不同就短路」的問題,
  是比 `matchesStaticToken` 更嚴謹一階的常數時間比較)。
- 密碼錯誤:**先睡 750ms** 才回應(`await new Promise(r => setTimeout(r, 750))`),
  帶著同一張表單重新渲染、附上「Wrong password. Try again.」錯誤訊息,回應碼 `401`。
  這是單一擁有者伺服器場景下的簡化防護——沒有帳號鎖定或按 IP 限流,只有這個固定延遲。
- 密碼正確:產生 `code = newSecret("bmc")`,寫入 `oauth_codes`
  (`code_hash`、`client_id`、`redirect_uri`、`code_challenge`、`scope`、
  `expires_at = now + 5min`),`302` 重導回
  `redirect_uri?code=<code>&state=<state>`。

### 5.7 `POST /oauth/token` — `authorization_code` 授權

```
grant_type=authorization_code
&code=bmc_....
&code_verifier=<原始隨機字串>
&client_id=b5c1a2d3-....        (選填,若提供會驗證是否吻合)
&redirect_uri=https://...       (選填,若提供會驗證是否吻合)
```

伺服器行為:

1. `db.consumeAuthCode(HMAC(code))` 是一個**單一 SQL 語句**同時完成「檢查有效性
   + 標記已使用」:

   ```sql
   UPDATE oauth_codes SET used_at = $1
   WHERE code_hash = $2 AND used_at IS NULL AND expires_at > $1
   RETURNING *
   ```

   這種寫法讓「檢查是否已使用」與「標記為已使用」之間沒有 race window——重放
   (replay)同一個 code 兩次,第二次一定拿到 `null`(因為第一次已經把
   `used_at` 設值,`used_at IS NULL` 條件不再成立)。找不到符合的列 → `400
   invalid_grant`。
2. 若請求帶了 `client_id`/`redirect_uri`,分別與 code 記錄的值比對,不符 →
   `400 invalid_grant`。
3. **PKCE 驗證**:`s256Challenge(code_verifier)` 必須（用 `safeEqual`)等於當初
   授權時存下的 `code_challenge`,不符 → `400 invalid_grant, "PKCE verification
   failed"`。
4. 全部通過 → `issueTokens(client_id, scope)`。

### 5.8 `POST /oauth/token` — `refresh_token` 授權(輪替)

```
grant_type=refresh_token
&refresh_token=bmr_....
&client_id=b5c1a2d3-....   (選填)
```

`db.consumeRefreshToken(HMAC(token))` 同樣是單一原子語句:

```sql
UPDATE oauth_tokens SET revoked_at = $1
WHERE token_hash = $2 AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > $1
RETURNING *
```

也就是「驗證」與「撤銷舊 refresh token」在同一步完成——**每次刷新都會讓舊的
refresh token 立即失效**,重放舊 refresh token 必定得到 `400 invalid_grant`。
驗證通過後一樣呼叫 `issueTokens` 核發全新的一組 access + refresh token。

需注意的行為細節(文件記錄,非缺陷指控):

- 這裡只做「單次輪替」,**沒有實作「refresh token 重放偵測後連鎖撤銷整條 token
  家族」**的進階模式(部分 OAuth 實作在偵測到已撤銷的 refresh token 被重放時,
  會把同一 lineage 下所有 token 都撤銷,視為金鑰外洩的訊號)。這裡單純回錯誤,
  不做連鎖撤銷。
- 舊的 access token(在這次刷新之前核發的)**不會**因為 refresh 而被連動撤銷,
  它們各自照自己的 1 小時到期時間單獨失效。`oauth_tokens` 沒有把同一批
  access+refresh token 標記成同一個 lineage/session 的欄位。

### 5.9 `issueTokens` — 核發

```json
{
  "access_token": "bma_....",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "bmr_....",
  "scope": "mcp"
}
```

`scope` 欄位只在原本 authorize 請求帶有 `scope` 時才出現(falsy 值直接省略整個
key,而非輸出 `null`)。access token 與 refresh token 分別各自 `insertToken`
一列進 `oauth_tokens`,`kind` 分別是 `'access'`/`'refresh'`,各自獨立的
`expires_at`。

### 5.10 存取驗證(供 `/mcp` middleware 使用)

```ts
async verifyAccessToken(token: string): Promise<boolean> {
  const stored = await this.db.getActiveToken(hmacHex(secret, token), "access");
  return stored !== null;
}
```

`getActiveToken` 的 SQL 條件是 `token_hash=$1 AND kind=$2 AND revoked_at IS
NULL AND expires_at > now`。過去 access token 沒有任何程式路徑會設定
`revoked_at`,這個條件實務上恆真(只要沒過期),等同純粹的過期檢查;現在
`POST /oauth/revoke`(見下方 §5.11)可以把任一 access token 的 `revoked_at`
設成非 NULL,讓下一次 `verifyAccessToken` 立刻判定失敗——外洩的 access token
不必再乾等自然到期,呼叫端可以主動撤銷。

### 5.11 `POST /oauth/revoke`(RFC 7009 撤銷)

請求(表單或 JSON body,與 `/oauth/token` 一樣接受兩種格式):

```
token=bma_....
token_type_hint=access_token   (選填,伺服器接受但不使用)
```

伺服器行為(`handleRevoke`):

1. 解析 body 拿到 `token`;缺少則回 `400 { error: "invalid_request",
   error_description: "token is required" }`。
2. 用 `HMAC-SHA256(OAUTH_SIGNING_SECRET, token)` 算出雜湊,呼叫
   `db.revokeToken(tokenHash)`：

   ```sql
   UPDATE oauth_tokens SET revoked_at = $1
   WHERE token_hash = $2 AND revoked_at IS NULL
   ```

   這個 `UPDATE` **不篩選 `kind`**,所以同一個呼叫可以撤銷 access token 或
   refresh token,由 `token_hash` 主鍵決定命中哪一列;`token_type_hint` 因此
   收下即可,完全不需要真的使用。
3. **不論撤銷是否真的命中一列**(token 不存在、已撤銷、或撤銷成功),都固定回
   `200 {}`——遵循 RFC 7009 §2.2:回應不得洩露「這個 token 是否存在/是否有效」
   的資訊,避免呼叫端把這個端點當成 token 存在性探測工具。
4. `OPTIONS /oauth/revoke` 有 CORS 預檢處理,行為與 `/oauth/token` 一致
   (`Access-Control-Allow-Methods: POST, OPTIONS`)。

刻意保持最小化:**沒有 token 家族連鎖撤銷**(cascade)——`oauth_tokens` 沒有
lineage/session 欄位可供連鎖,對單一擁有者伺服器而言,「撤銷手上這一個 token」
已涵蓋實務上的需求(撤銷外洩或不再使用的 client 的 token)。這點與 §5.8 提到
的「refresh rotation 沒有重放偵測連鎖撤銷」是同一類、刻意不做的進階功能。

### 5.12 完整時序總覽

```
claude.ai                          Bridge Server                    Postgres
   │  GET /.well-known/oauth-protected-resource        │                │
   │ ─────────────────────────────────────────────────▶│                │
   │◀───────────────────────────── resource metadata ──│                │
   │  GET /.well-known/oauth-authorization-server       │                │
   │ ─────────────────────────────────────────────────▶│                │
   │◀──────────────────────────── AS metadata (S256,DCR)│                │
   │  POST /oauth/register {redirect_uris,...}          │                │
   │ ─────────────────────────────────────────────────▶│  INSERT oauth_clients
   │◀────────────────────────── 201 {client_id, ...} ──│                │
   │  GET /oauth/authorize?...&code_challenge=S256(v)   │                │
   │ ─────────────────────────────────────────────────▶│                │
   │◀───────────────────────── HTML 核准表單(owner password)│           │
   │  POST /oauth/authorize {password, ...hidden}       │                │
   │ ─────────────────────────────────────────────────▶│  INSERT oauth_codes (hash)
   │◀──────────────── 302 redirect_uri?code=bmc_...&state│                │
   │  POST /oauth/token {grant_type=authorization_code, │                │
   │        code, code_verifier=v}                      │                │
   │ ─────────────────────────────────────────────────▶│  UPDATE oauth_codes(used_at) RETURNING
   │                                                     │  验证 PKCE: SHA256(v)==challenge?
   │                                                     │  INSERT oauth_tokens ×2 (access,refresh)
   │◀──────────── 200 {access_token, refresh_token, ...}│                │
   │  ... 之後每次 MCP 呼叫: Authorization: Bearer bma_...│                │
   │  (1 小時後) POST /oauth/token {grant_type=refresh_token, refresh_token}│
   │ ─────────────────────────────────────────────────▶│  UPDATE oauth_tokens(revoked_at) RETURNING
   │                                                     │  INSERT oauth_tokens ×2(新 access,新 refresh)
   │◀──────────── 200 {新 access_token, 新 refresh_token}│                │
```

---

## 6. 憑證過濾機制(`src/secret-filter.ts`)

`detectSecret(content)` 依序測試以下正則表達式,**回傳第一個命中的類別名稱**
(不是「找出所有命中」,一旦第一個 pattern 命中就立刻回傳,不繼續檢查其餘 pattern):

| 類別 | Pattern 概要 |
|---|---|
| `API key (sk-...)` | `\bsk-[A-Za-z0-9_-]{16,}\b`(OpenAI / Anthropic 風格) |
| `AWS access key (AKIA...)` | `\bAKIA[0-9A-Z]{16}\b` |
| `AWS secret key assignment` | `aws_?secret[^\n]{0,20}[:=]\s*['"]?[A-Za-z0-9/+=]{30,}`(大小寫不敏感) |
| `GitHub token (gh*_...)` | `\bgh[pousr]_[A-Za-z0-9]{20,}\b`(涵蓋 `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`) |
| `Slack token (xox...)` | `\bxox[baprs]-[A-Za-z0-9-]{10,}\b` |
| `Google API key (AIza...)` | `\bAIza[0-9A-Za-z_-]{30,}\b` |
| `password assignment` | `\b(password\|passwd\|pwd)\s*[:=]\s*\S+`(大小寫不敏感) |
| `secret/token assignment` | `\b(api[_-]?key\|secret\|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{16,}`(大小寫不敏感) |
| `Bearer token` | `\bBearer\s+[A-Za-z0-9._~+/=-]{16,}`(大小寫不敏感) |
| `private key block` | `-----BEGIN\s+[A-Z ]*PRIVATE KEY-----` |

### 呼叫點

`index.ts` 有一個包裝函式 `detectSecretInFields({ text, textField, tags,
project })`,依序對「主要文字欄位(content/summary)→ 逐一檢查每個 tag →
project」跑 `detectSecret`,任何一個命中就立刻回傳 `"<pattern> in <field>"`
形式的描述(例如 `"API key (sk-...) in tags"`),不繼續檢查其餘欄位。目前有
兩處呼叫它:

1. `save_memory`:檢查 `content`、`tags`、`project`。
2. `consolidate_memory`:檢查 `summary`、`tags`、`project`。

**現在會被掃描的欄位**:兩個工具的 `tags` 陣列(逐一檢查每個 tag 字串)與
`project` 字串,連同各自的主要文字欄位,都會被 `detectSecret` 檢查——不再只看
`content`/`summary`。`search_memory` 等讀取類工具仍然不會對已存在的資料做任何
掃描——這個機制只在「寫入的當下」生效,對已經在庫裡的資料(例如透過 psql 直接
寫入、或未來新增別的寫入路徑)沒有保護力。

### 明確聲明的限制

這是**盡力而為的啟發式規則(best-effort heuristic)**,不是保證:

- 純字串比對正則,沒有任何 entropy 分析或機器學習判斷,新格式(例如非上述廠商的
  API key 格式)、刻意拆分/編碼過的憑證(例如 base64 包一層、加空白分隔)都會
  直接繞過。
- 只回傳「第一個」命中類別,不是完整掃描報告。
- 呼叫端(LLM)仍須自行判斷、避免把敏感資訊寫進這個共享記憶庫——這個過濾器只是
  最後一道安全網,不能取代呼叫端的判斷。

---

## 7. 部署與環境變數

### 7.1 環境變數總表

| 變數 | 必填 | 讀取位置 | `.env.example` 是否列出 | 說明 |
|---|---|---|---|---|
| `DATABASE_URL` | **是**(缺少即 `process.exit(1)`) | `index.ts` | 是 | Postgres 連線字串 |
| `BRIDGE_AUTH_TOKEN` | **是**(缺少即 `process.exit(1)`) | `index.ts` | 是 | 固定 Bearer token |
| `PORT` | 否(預設 `8787`) | `index.ts` | 是(註解說明,預設值列出) | HTTP 監聽埠 |
| `PUBLIC_BASE_URL` | 否(未設時退回 `http://localhost:<PORT>`) | `index.ts` | 是(以註解列出,預設關閉) | 對外可達的 origin;Railway 在 proxy 後面,不能信任 request header 反推,正式環境**實質上必須設定**才能讓 OAuth metadata/redirect 正確 |
| `OAUTH_SIGNING_SECRET` | 否,但與 `OAUTH_OWNER_PASSWORD` 需同時設定才會啟用 OAuth | `index.ts`/`oauth.ts` | 是(以註解列出,預設關閉) | HMAC 簽章金鑰,用於雜湊 authorization code 與 token |
| `OAUTH_OWNER_PASSWORD` | 否,同上 | `index.ts`/`oauth.ts` | 是(以註解列出,預設關閉) | `/oauth/authorize` 核准頁的單一擁有者密碼 |

> **落差記錄(已修正,見文件頂部「變更紀錄」)**:`.env.example` 先前只涵蓋
> `DATABASE_URL`/`BRIDGE_AUTH_TOKEN`/`PORT` 三項,實際程式碼會讀取的
> `PUBLIC_BASE_URL`/`OAUTH_SIGNING_SECRET`/`OAUTH_OWNER_PASSWORD` 三個變數當時
> 未被列出。這一輪修正已經把這三項補進 `.env.example`(以註解形式列出、預設
> 關閉,並附上說明文字),現在 `.env.example` 完整涵蓋所有程式碼會讀取的環境
> 變數,不再有落差。

`OAUTH_ENABLED` 的判斷是 `Boolean(OAUTH_SIGNING_SECRET && OAUTH_OWNER_PASSWORD)`
——兩者都要有值才會啟用 OAuth 端點;只設定其中一個,行為等同兩個都沒設定
(OAuth 停用,但不會有額外警告區分「設了一半」與「都沒設」)。

### 7.2 建置與啟動指令

```jsonc
// package.json scripts
"build": "tsc",                                    // 依 tsconfig.json:src/ → dist/,target ES2022, module NodeNext
"start": "node dist/index.js",
"smoke": "node scripts/smoke-test.mjs",             // 實測全部 7 個工具(見 README)
"inspect": "npx @modelcontextprotocol/inspector"
```

`package.json` 的 `main`/`bin` 都指向 `dist/index.js`;`engines.node` 要求
`>=20`。相依套件:`@modelcontextprotocol/sdk`、`pg`、`zod`(僅 3 個 runtime
依賴);開發依賴 `typescript`、`@types/node`、`@types/pg`。

專案根目錄**沒有** `railway.json` 或 `nixpacks.toml`,Railway 是靠自動偵測
Node 專案(Nixpacks)完成建置:`npm ci` → `npm run build`(偵測到
`build` script)→ `npm start`。

### 7.3 實際 Railway 部署現況

- Railway 專案名稱:`bridge-memory`
- 兩個服務:`bridge-server`(這個 Node 應用)與 `Postgres`(Railway 提供的
  Postgres 附加元件,透過 `${{Postgres.DATABASE_URL}}` 服務變數參照注入
  `bridge-server` 的 `DATABASE_URL`)
- 對外網址:`https://bridge-server-production-4d23.up.railway.app`
  ——因此 `PUBLIC_BASE_URL` 應設為這個值,`/oauth/authorize` 的重導、
  `.well-known` metadata 裡的 `issuer`/`resource` 等欄位才會指向正確的公開網域
  (而不是退回預設的 `http://localhost:8787`)。
- `GET https://bridge-server-production-4d23.up.railway.app/healthz` 應回
  `{"status":"ok"}`,可作為部署後的存活確認。

---

## 8. 安全性考量與已知限制

以下項目以**中性語氣**記錄為「已知的設計取捨」,而非需要修正的臭蟲——多數是
單一擁有者(single-owner)、小規模個人使用情境下合理的簡化。

- **軟刪除即審計軌跡**:應用層完全沒有任何硬刪除(`DELETE FROM`)路徑,`delete_memory`
  /`delete_by_filter`/`consolidate_memory` 全部只設 `deleted_at`/`superseded_by`。
  誤刪可直接在 Postgres 裡查回、甚至手動復原(把 `deleted_at` 設回 `NULL`)。
  這既是資料保護機制,也隱含著「資料庫實體大小只會增不會減」的取捨——目前沒有排程
  清理超過 N 天的軟刪除列(README 把這列為「後續」項目)。
- **憑證過濾器的邊界**:見 §6——純正則、只挑第一個命中類別、無法防禦刻意規避
  或全新格式的憑證字串。掃描範圍已涵蓋 `content`/`summary`、`tags`、`project`
  (見 §6 的變更),但仍只在寫入當下生效,對已存在的資料沒有保護力。
- **PKCE 僅接受 S256**:`/oauth/authorize` 明確拒絕 `code_challenge_method=plain`,
  符合 OAuth 2.1 對公開客戶端的強制要求,不接受較弱的替代方案。
- **Refresh token 輪替,但無重放偵測連鎖撤銷**:每次刷新都會撤銷舊的 refresh
  token(§5.8),但沒有實作「偵測到已撤銷 token 被重放時,連鎖撤銷整條
  token 家族」的進階防護;同一批次核發的 access token 也不會因 refresh 而被
  連動撤銷,各自獨立到期。
- **單一擁有者密碼模型,非多租戶身份系統**:`OAUTH_OWNER_PASSWORD` 是一組寫在
  環境變數裡的**單一**密碼,守住 `/oauth/authorize` 的核准畫面——任何知道這組
  密碼的人都能核准**任何**已透過 DCR 註冊的 client。這不是使用者帳號/角色系統,
  而是「這台伺服器只有一個擁有者」假設下的簡化實作,與 README、`oauth.ts` 註解
  裡反覆出現的「single-owner server」定位一致。
- **沒有速率限制(rate limiting)**:除了密碼錯誤時固定的 750ms 延遲之外,
  `/oauth/register`(公開、無需認證即可呼叫)、`/oauth/token`、`/mcp`
  都沒有任何按 IP 或按 client 的請求頻率限制。
- **單一 token 撤銷已支援,但無 token 家族連鎖撤銷**:`POST /oauth/revoke`
  (RFC 7009,見 §5.11)可以撤銷單一 access 或 refresh token,外洩的 token
  不必再乾等自然到期。但這僅止於「撤銷呼叫端拿到手上的這一個 token」——伺服器
  沒有 token lineage/session 的概念,也沒有實作「偵測到某個 token 已被撤銷卻
  仍被重放時,自動連鎖撤銷同一批/同一使用者核發的其他 token」的進階防護,與
  §5.8 提到的「refresh rotation 沒有重放偵測連鎖撤銷」屬於同一類、刻意不做的
  限制。
- **OAuth 相關資料表沒有清理排程**:過期的 `oauth_codes`/`oauth_tokens` 列
  永遠不會被實際刪除,只在查詢時用 `expires_at`/`used_at`/`revoked_at`
  條件過濾掉——資料表會隨時間無上限成長(程式碼註解明確承認「no cleanup
  job」)。
- **DB 層沒有 enum 型別的 `CHECK` 約束**:`memories.source`(`'claude_ai'`/
  `'claude_code'`)、`oauth_tokens.kind`(`'access'`/`'refresh'`)都只在應用層
  (zod schema / TypeScript 型別)保證合法值,資料庫本身不會擋下非法字串。
- **CORS 大開**:OAuth 相關端點一律回 `Access-Control-Allow-Origin: *`
  (程式碼註解說明:回應內容不含 cookie 作用域資訊,因此判定為安全);但
  `/oauth/authorize` 本身沒有像 `/oauth/register`/`/oauth/token` 一樣明確處理
  `OPTIONS` 預檢請求(對它送 `OPTIONS` 會得到 `405`)——實務上 `/oauth/authorize`
  是透過瀏覽器整頁導頁/表單提交存取,不是透過 `fetch()`,所以缺少預檢處理在
  實務流程中影響有限。
- **`/mcp` 本身沒有設定任何 CORS header**(只有 `src/oauth.ts` 管轄的路由才會加)
  ——這代表瀏覽器端直接用 `fetch()` 跨網域打 `/mcp` 會被瀏覽器的同源政策擋下;
  claude.ai/Claude Code 對 `/mcp` 的呼叫是伺服器對伺服器,不受此限制。

---

## 9. 與原始規格書的差異

比對對象:`claude_bridge_memory_spec.md`(繁體中文,原始設計意圖文件)。

| 規格書描述(section) | 實際實作 | 差異說明 |
|---|---|---|
| §3 技術選型:「初期 SQLite;要多裝置高可用再換 Postgres」 | 直接且僅使用 Postgres,無任何 SQLite 程式碼路徑 | `db.ts` 檔頭註解自陳「Ported from better-sqlite3 to pg」,顯示開發過程中確實存在過 SQLite 版本,但**目前部署與程式碼庫只剩 Postgres**,沒有雙資料庫支援或切換開關 |
| §3「認證:第一版 Bearer token;第二版 OAuth2 + JWT」 | 第二版確實加上了 OAuth 2.1,但 token 格式是 **opaque random token + HMAC-SHA256 雜湊儲存**,不是 JWT | 見 §5.2;是刻意的技術選型調整(理由:更少活動零件、撤銷/輪替天生可得),而非未完成 |
| §3 部署平台:「Cloudflare Workers / Railway / Render」 | 只採用 Railway | 與 README 一致,規格書原本列出的是候選清單,非強制指定 |
| §4 資料模型(僅 `memories`/`memory_consolidations`,`memories` 原始欄位不含 `superseded_by`) | `memories` 加上 `superseded_by`(規格書後段散文有提到要加這個欄位),外加全新的 `oauth_clients`/`oauth_codes`/`oauth_tokens` 三張表 | OAuth 三張表是規格書 §3 提到「第二版 OAuth2」帶出的全新需求,規格書 §4 的 SQL 範例本身沒有涵蓋;`superseded_by` 則與規格書散文描述的加法完全吻合並被實作 |
| §5 `consolidate_memory` 的 `input_schema` 沒有 `source` 欄位 | 實作新增了選填的 `source` 欄位 + 推導邏輯(§2.8) | `index.ts` 註解明確說明原因:規格書的 schema 沒考慮到 `memories` 表 `source` 是 `NOT NULL`,新記憶必須有個來源,因此新增此欄位並補上推導規則作為相容處理 |
| §5 `delete_by_filter` 的 `input_schema` 沒有 `confirm` 欄位,散文建議「可以先讓它回傳符合筆數,二次確認後才真的執行」屬於**建議**語氣 | 實作把兩段式確認做成**強制**的 schema 欄位與邏輯(`confirm` 預設 `false`,且空篩選條件直接拒絕) | 規格書原文用「建議」語氣描述的安全機制,在實作中被提升為不可繞過的強制流程 |
| §7「建議加一層簡單的內容過濾」 | 完整實作為 `secret-filter.ts`,10 種 pattern,掛在 `save_memory`/`consolidate_memory`,經 `detectSecretInFields` 涵蓋 `content`/`summary`、`tags`、`project` | 落實規格建議;過濾範圍原本只涵蓋 `content`/`summary`,後續一輪修正(見文件頂部變更紀錄)擴大到 `tags`/`project`,細節見 §6/§8 |
| §8 建議開發順序:先 stdio + inspector 本機測試(step 1),之後才改 Streamable HTTP 部署(step 2) | `index.ts` 檔頭註解直接寫「Deployment edition (spec section 8, step 2)」 | 現有程式碼庫呈現的即是規格書 step 2 的成果,對應的 step 1(stdio 模式)版本未包含在此程式碼庫中(或已被取代) |
| §8 第 6 點(選做):「加 OAuth2、多裝置同步、既有資料匯入腳本」 | OAuth2 已完整實作(§5);多裝置同步本來就是架構的既定目標(兩端共用同一 DB);既有資料匯入腳本**未見於程式碼庫**(README「後續」清單仍列為待辦) | 三項「選做」項目裡,OAuth2 已完成,匯入腳本仍是未實作的待辦 |
| §6 兩端主動寫入的 CLAUDE.md 指引文字 | 屬於使用慣例/prompt 工程,不在這個程式碼庫的職責範圍內 | 規格書把這部分內容放在使用者自己的 `~/.claude/CLAUDE.md`,不是伺服器程式碼的一部分,無法從原始碼驗證是否已落實,此處僅記錄範疇劃分 |

**整體結論**:實作在資料模型、7 個工具的核心語意上與規格書高度一致(甚至把規格書
用「建議」語氣描述的安全機制強化為強制流程),主要的落差集中在:(1) 資料庫從
「初期 SQLite」直接跳到「僅 Postgres」;(2) 「OAuth2 + JWT」的 JWT 部分被替換成
opaque token + HMAC 雜湊儲存的方案;(3) 因應資料庫欄位限制而對 `consolidate_memory`
schema 做的必要擴充。這些都是工程實作階段對規格的合理具體化與調整,而非規格與
實作彼此矛盾的錯誤。
