# Bridge Memory MCP Server

讓 claude.ai 與 Claude Code 共用一份持續累積的記憶庫的 MCP server。
兩邊都能寫入、查詢、刪除、整合長期記憶(使用者偏好、專案決策、進度狀態等)。

目前為**可部署版本**(開發順序第 2 步):

- **Transport**:MCP **Streamable HTTP**(規格明確不用 SSE,已棄用)。
- **資料庫**:**Postgres**(`pg`),連線字串讀環境變數 `DATABASE_URL`(Railway 慣例)。
- **認證**:第一版固定 Bearer token(環境變數 `BRIDGE_AUTH_TOKEN`),
  所有 MCP 請求都要帶 `Authorization: Bearer <token>`,否則回 401。
  OAuth2 依規格留待第二版。

## 環境變數

見 `.env.example`:

| 變數 | 必填 | 說明 |
|---|---|---|
| `DATABASE_URL` | 是 | Postgres 連線字串,例如 `postgres://user:pass@host:5432/db`。缺少時啟動即失敗。 |
| `BRIDGE_AUTH_TOKEN` | 是 | 固定 API key。缺少時啟動即失敗。請用夠長的隨機字串,例如 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` | 否 | HTTP 埠。Railway 會自動注入;本機預設 8787。 |

啟動時會自動建表(`CREATE TABLE IF NOT EXISTS`),不需要另外跑 migration。

## 安裝與建置

```bash
npm install
npm run build
```

## 本機執行(用 Docker 起一個 Postgres)

```bash
# 1. 起一個測試用 Postgres(佔本機 5433 埠,停掉即自動刪除)
docker run --rm -d --name bridge-pg -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16

# 2. 啟動 server
DATABASE_URL='postgres://postgres:test@localhost:5433/postgres' \
BRIDGE_AUTH_TOKEN='your-local-test-token' \
npm start
```

Server 會在 `http://localhost:8787` 提供:

- `POST /mcp` — MCP endpoint(Streamable HTTP,需要 Bearer token)
- `GET /healthz` — 健康檢查(不需認證、不暴露資料)

測完後 `docker stop bridge-pg` 收掉容器。

## Smoke test(實測全部 7 個工具)

```bash
npm run build
DATABASE_URL='postgres://postgres:test@localhost:5433/postgres' npm run smoke
```

Smoke test 會自己啟動 server(埠 8917)、透過 Streamable HTTP + Bearer token 驗證:

1. 沒帶 token / 帶錯 token → 401
2. `tools/list` 回傳全部 7 個工具
3. `save_memory` ×3 → `search_memory`(關鍵字 + tags)→ `get_recent_memory` → `list_by_source`
4. `delete_memory` 軟刪除後查不到、重複刪除會報錯
5. `consolidate_memory` 合併 2 筆 → 舊的查不到、新的查得到、重複整合會報錯
6. `delete_by_filter` 兩段式確認(不帶 `confirm` 只回筆數;空條件直接拒絕)
7. Secret filter 拒絕 credential 格式內容

## 部署到 Railway(Postgres + Streamable HTTP)

程式碼已就緒並在本機以真實 Postgres 全數通過測試;以下步驟需要你自己的
Railway 帳號操作(用 dashboard 或 CLI 皆可):

### 用 Dashboard

1. 到 [railway.app](https://railway.app) 建立專案,選 **Deploy from GitHub repo**
   (先把這個資料夾 push 到一個 GitHub repo),或用下面的 CLI 方式直接上傳。
2. 在專案裡 **Create → Database → Add PostgreSQL**,Railway 會建立一個 Postgres 服務。
3. 點你的 server 服務 → **Variables**,新增:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`(參照 Postgres 服務的變數;
     服務名稱不同的話對應調整)
   - `BRIDGE_AUTH_TOKEN` = 你產生的長隨機字串
   - `PORT` 不用設,Railway 自動注入。
4. Railway 會自動偵測 Node 專案:`npm ci` → `npm run build`(有 build script 就會跑)
   → `npm start`(執行 `node dist/index.js`)。不需要額外的 `railway.json` /
   `nixpacks.toml`。
5. 服務 → **Settings → Networking → Generate Domain**,拿到公開 HTTPS 網址,
   例如 `https://your-app.up.railway.app`。
6. 開 `https://your-app.up.railway.app/healthz` 應回 `{"status":"ok"}`。

### 用 Railway CLI

```bash
npm i -g @railway/cli
railway login
cd bridge-server
railway init          # 建立新專案
railway add -d postgres   # 加 Postgres
railway variables --set "BRIDGE_AUTH_TOKEN=<你的長隨機字串>" \
                  --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
railway up            # 上傳並部署
railway domain        # 產生公開網址
```

## 接上 claude.ai(自訂連接器)

claude.ai → **Settings → Connectors → Add custom connector**:

- **URL**:`https://your-app.up.railway.app/mcp`
- 若介面沒有獨立的 token 欄位,部分方案支援在進階設定填 HTTP header;
  填 `Authorization: Bearer <BRIDGE_AUTH_TOKEN>`。

連上後測 `save_memory` / `search_memory`(source 填 `claude_ai`)。

## 接上 Claude Code

```bash
claude mcp add --transport http bridge-memory https://your-app.up.railway.app/mcp \
  --header "Authorization: Bearer <BRIDGE_AUTH_TOKEN>"
```

或寫入 `.mcp.json`:

```json
{
  "mcpServers": {
    "bridge-memory": {
      "type": "http",
      "url": "https://your-app.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer <BRIDGE_AUTH_TOKEN>"
      }
    }
  }
}
```

接上後測雙向讀寫、刪除、整合,然後在 `~/.claude/CLAUDE.md` 補上使用指引
(何時 `save_memory`、刪除前先搜尋確認 id、同主題超過 10 筆建議整合;規格第 6 節)。

## 7 個工具

| Tool | 用途 |
|---|---|
| `save_memory` | 儲存一筆長期記憶(content、source 必填;tags、project 選填) |
| `search_memory` | 依關鍵字 / tags / project 搜尋,回傳含 id |
| `get_recent_memory` | 取得最近 N 筆(預設 10) |
| `list_by_source` | 列出特定來源(claude_ai / claude_code)的記憶(預設 20 筆) |
| `delete_memory` | 依 id 軟刪除一筆 |
| `delete_by_filter` | 依條件批次軟刪除;**兩段式確認**:不帶 `confirm` 只回傳符合筆數與 id 清單,帶 `confirm: true` 才真的刪;至少要填一個條件 |
| `consolidate_memory` | 把 >=2 筆舊記憶整合成一筆新記憶(summary 由呼叫端 LLM 先寫好),舊記憶標記 superseded_by + 軟刪除,關聯寫入 `memory_consolidations` |

## 安全性

- 所有 MCP 請求都要帶 `Authorization: Bearer <BRIDGE_AUTH_TOKEN>`,
  比對使用 constant-time comparison。`/healthz` 例外(只回 `{"status":"ok"}`)。
- `save_memory` / `consolidate_memory` 寫入前會用 regex 檢查常見 credential 格式
  (`sk-...`、`AKIA...`、`ghp_...`、`password: ...`、Bearer token、PEM private key 等),
  命中就拒絕儲存。**這只是盡力而為的啟發式檢查,不是保證**——請不要把機密資訊往記憶庫丟。
- 所有刪除都是軟刪除(設 `deleted_at`),誤刪可從資料庫復原;正常查詢一律過濾
  `deleted_at IS NULL`。真正清空可日後再排定期清理(例如軟刪超過 90 天才實刪)。
- Railway 網域天生是公開 HTTPS,Anthropic 雲端連得到;不要再包 VPN / 防火牆。

## 後續(第二版之後)

- OAuth2 + JWT 多租戶認證(規格第 3 節第二版)
- 既有資料一次性匯入腳本(CLAUDE.md / claude.ai 記憶匯出)
- 軟刪除超過 90 天的定期實刪排程
