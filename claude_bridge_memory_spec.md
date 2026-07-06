# Claude.ai ↔ Claude Code 橋接記憶系統 — 實作規格

## 1. 目標

讓 claude.ai 與 Claude Code 共用一份「持續累積」的記憶庫。兩邊都能寫入、都能查詢,
用來記錄使用者偏好、專案決策、進度狀態等長期有價值的資訊。

**重要限制(必須先知道)**:
claude.ai 沒有公開 API 可以讀取既有的對話紀錄或 Project 內容,所以這不是「同步舊資料」,
而是「從現在開始,兩邊主動把重要資訊寫進同一個庫」。舊資料要靠手動匯入(見第 6 節)。

## 2. 架構總覽

```
┌─────────────┐         ┌──────────────────────┐         ┌─────────────┐
│  claude.ai  │ ──MCP──▶│   Bridge MCP Server    │◀──MCP── │ Claude Code │
│ (custom     │  HTTPS  │  (Node.js/TS, hosted)  │  HTTPS  │ (claude mcp │
│ connector)  │         │  + SQLite/Postgres DB  │         │    add)     │
└─────────────┘         └──────────────────────┘         └─────────────┘
```

雙方各自透過官方支援的 remote MCP 機制連到同一台伺服器:
- claude.ai:設定 → Connectors → 新增自訂連接器 → 貼 MCP server URL
- Claude Code:CLI 指令 `claude mcp add <name> <url>`(或寫入 `.mcp.json`)

## 3. 技術選型

| 項目 | 建議 |
|---|---|
| 語言 | Node.js + TypeScript |
| MCP SDK | `@modelcontextprotocol/sdk` |
| 資料庫 | 初期 SQLite(單機夠用);要多裝置高可用再換 Postgres |
| 部署平台 | Cloudflare Workers / Railway / Render(需公開 HTTPS,Anthropic 雲端要連得到) |
| 傳輸協定 | Streamable HTTP(SSE 未來可能棄用,不要用) |
| 認證 | 第一版:Bearer token(固定 API key);第二版:OAuth2 + JWT(可沿用你原本 v0.3 spec 的多租戶設計) |

## 4. 資料模型

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,              -- uuid
  content TEXT NOT NULL,            -- 記憶內容
  source TEXT NOT NULL,             -- 'claude_ai' | 'claude_code'
  tags TEXT,                        -- JSON array, e.g. ["job-search","taiwan-md"]
  project TEXT,                     -- 選填,對應到哪個專案/情境
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_memories_source ON memories(source);
CREATE INDEX idx_memories_project ON memories(project);

-- 記憶整合用:記錄哪些舊記憶被合併進了哪一筆新記憶
CREATE TABLE memory_consolidations (
  id TEXT PRIMARY KEY,              -- uuid
  consolidated_memory_id TEXT NOT NULL,  -- 指向整合後產生的新記憶
  source_memory_id TEXT NOT NULL,        -- 被整合進去的舊記憶 id
  created_at TEXT NOT NULL,
  FOREIGN KEY (consolidated_memory_id) REFERENCES memories(id),
  FOREIGN KEY (source_memory_id) REFERENCES memories(id)
);
```

`memories` 表再加一欄 `superseded_by TEXT`(預設 NULL):當一筆記憶被整合進新記憶後,
把它的 `superseded_by` 設成新記憶的 id,同時軟刪除(`deleted_at` 設定)。這樣舊記錄還在、
可以追溯,但正常查詢不會再撈到它,只會看到整合後的版本。

**軟刪除 vs 硬刪除**:建議加一個 `deleted_at TEXT` 欄位做軟刪除,而不是直接 `DELETE` 這筆資料。
好處是誤刪可以復原,也方便之後做刪除紀錄的稽核。所有查詢(`search_memory`、`get_recent_memory`
等)預設都要加上 `WHERE deleted_at IS NULL`。真正要清空可以另外排一個定期清理的排程
(例如超過 90 天的軟刪除記錄才真正清掉)。

## 5. MCP Tools 規格

### `save_memory`
```json
{
  "name": "save_memory",
  "description": "儲存一筆長期記憶,供另一端的 Claude 之後查詢使用",
  "input_schema": {
    "content": "string, 必填",
    "source": "string, 'claude_ai' | 'claude_code'",
    "tags": "string[], 選填",
    "project": "string, 選填"
  }
}
```

### `search_memory`
```json
{
  "name": "search_memory",
  "description": "依關鍵字或標籤搜尋記憶庫",
  "input_schema": {
    "query": "string, 選填(關鍵字)",
    "tags": "string[], 選填",
    "project": "string, 選填",
    "limit": "number, 預設 10"
  }
}
```

### `get_recent_memory`
```json
{
  "name": "get_recent_memory",
  "description": "取得最近寫入的 N 筆記憶,依時間排序",
  "input_schema": { "limit": "number, 預設 10" }
}
```

### `list_by_source`
```json
{
  "name": "list_by_source",
  "description": "列出特定來源(claude.ai 或 claude code)寫入的所有記憶",
  "input_schema": { "source": "string", "limit": "number, 預設 20" }
}
```

### `delete_memory`
```json
{
  "name": "delete_memory",
  "description": "刪除一筆指定的記憶(依 id)",
  "input_schema": { "id": "string, 必填(記憶的 uuid)" }
}
```
建議 `search_memory` 或 `get_recent_memory` 的回傳結果都要附上 `id`,
這樣呼叫端(不管是 claude.ai 還是 Claude Code)才有東西可以拿來刪除。

### `delete_by_filter`(選用,批次刪除)
```json
{
  "name": "delete_by_filter",
  "description": "依條件批次刪除記憶,例如清掉某個來源或某個專案的全部記錄",
  "input_schema": {
    "source": "string, 選填",
    "project": "string, 選填",
    "tags": "string[], 選填",
    "older_than": "string, 選填,ISO 日期,刪除此日期前的記憶"
  }
}
```
批次刪除風險較高,建議實作時要求「至少填一個條件」,避免誤傳空條件把整個表清空;
也可以先讓它回傳「符合條件的筆數」,呼叫端二次確認後才真的執行刪除。

### `consolidate_memory`
```json
{
  "name": "consolidate_memory",
  "description": "將多筆相關的舊記憶整合成一筆精簡的新記憶,避免同類資訊越堆越多、越查越亂",
  "input_schema": {
    "memory_ids": "string[], 必填,要被整合的舊記憶 id 清單(至少 2 筆)",
    "summary": "string, 必填,整合後的內容(由呼叫端的 LLM 先產生好摘要,server 不做摘要判斷)",
    "project": "string, 選填",
    "tags": "string[], 選填"
  }
}
```
運作方式:
1. 用傳入的 `summary` 新增一筆記憶(跟 `save_memory` 邏輯相同)。
2. 把 `memory_ids` 裡每一筆的 `superseded_by` 指向這筆新記憶,並設定 `deleted_at`(軟刪除)。
3. 在 `memory_consolidations` 表寫入對應關係,保留可追溯性。
4. 回傳新記憶的 id,以及被整合掉的筆數。

**什麼時候該觸發整合**(建議寫進 CLAUDE.md / 系統提示,而不是寫死在 server 端):
- 當 `search_memory` 或 `list_by_source` 針對同一個 `project` 或同一組 `tags` 回傳超過某個
  數量(例如 10~15 筆)時,呼叫端的 Claude 可以主動建議:「這個主題已經累積不少記憶了,
  要不要整合一下?」,取得使用者同意後再讀出全部內容、產生摘要、呼叫 `consolidate_memory`。
- 不建議 server 自動觸發整合,因為「怎麼摘要才不失真」需要 LLM 判斷,而且整合是不可逆的
  資訊壓縮動作,最好讓使用者確認過再做。

## 6. 兩端如何主動寫入

**Claude Code 端**:
在 `~/.claude/CLAUDE.md` 加入類似指令:
> 當使用者表達重要偏好、專案決策、或值得長期記住的資訊時,呼叫 `save_memory` 工具存入橋接記憶庫,source 填 "claude_code"。當使用者說「忘記/刪除/修正」某項記憶時,先用 `search_memory` 找到對應的 id,跟使用者確認後再呼叫 `delete_memory`。查詢時如果發現同主題記憶超過 10 筆以上,主動提醒使用者是否要整合,經同意後讀出全部內容、寫成摘要、呼叫 `consolidate_memory`。

**claude.ai 端**:
使用者可直接跟 Claude 說「幫我把這件事存到橋接記憶」,Claude 會呼叫已連接的自訂連接器
執行 `save_memory`,source 填 "claude_ai"。要刪除或修正記憶時,一樣先搜尋確認 id、跟使用者
核對內容後再刪除——避免因為模糊指令刪錯資料。記憶太零碎時,一樣可以主動建議整合。

**既有資料的一次性匯入**(手動,非即時同步):
- Claude Code 側:寫一支腳本讀取現有 `CLAUDE.md` 與 auto memory 檔案,批次呼叫 `save_memory` 匯入。
- claude.ai 側:用 claude.ai 的「記憶匯出」實驗功能匯出檔案後,同樣寫腳本批次匯入。

## 7. 安全性注意事項

- Bridge server 必須用 HTTPS,且要能被 Anthropic 雲端 IP range 連到(不能放在防火牆/VPN 後面,除非額外做 IP allowlist)。
- 絕對不要把 API key、密碼等敏感資訊存進 `memories` 表。
- 建議加一層簡單的內容過濾(regex 比對常見 credential 格式),避免不小心寫入機密。
- 第一版可以先用單一固定 token 保護 server,測試沒問題後再升級 OAuth2。

## 8. 建議開發順序

1. 先在本機把 MCP server 用 stdio 模式跑起來,用 `@modelcontextprotocol/inspector` 測試六個 tool(含 `delete_memory`、`consolidate_memory`)都正常。
2. 部署到 Cloudflare Workers 或 Railway,改成 Streamable HTTP transport。
3. 在 claude.ai 加自訂連接器測試 `save_memory` / `search_memory`。
4. 用 `claude mcp add` 把同一個 server 接到 Claude Code,測試雙向讀寫、刪除、整合。
5. 補上 CLAUDE.md 指令,讓 Claude Code 自動使用,包含整合觸發的提示邏輯。
6. (選做)加 OAuth2、多裝置同步、既有資料匯入腳本。
