# Bridge Memory MCP Server

讓 claude.ai 與 Claude Code 共用同一份持續累積記憶的 MCP server——部署後完全屬於你自己,資料存在你自己的 Postgres 裡。

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/saz1QE?referralCode=Nt8u9B&utm_medium=integration&utm_source=template&utm_campaign=generic)

**這是最快的部署方式**:點上面的按鈕、填一組 `OAUTH_OWNER_PASSWORD`(你自己的核准密碼)、等約兩分鐘。其餘變數(資料庫連線、兩組隨機密鑰、公開網址)Template 都會在部署當下自動設定好,不用手動生成、也不用「部署兩次」。部署完成後只要做兩件事:到服務的 **Variables** 頁面複製 `BRIDGE_AUTH_TOKEN` 用來接 Claude Code,並記住剛剛自己設定的 `OAUTH_OWNER_PASSWORD` 用來接 claude.ai(接法見下方對應章節)。如果你想要更多控制權,或想先在本機完整驗證一遍再上雲,下方的手動部署章節(Railway CLI / Dashboard)完整保留,照著做同樣可行。

---

兩邊都能寫入、查詢、刪除、整合長期記憶(使用者偏好、專案決策、進度狀態等)。

**這是可部署版本**,支援兩種認證方式:

- **Transport**:MCP **Streamable HTTP**(規格明確不用 SSE,已棄用)。
- **資料庫**:**Postgres**(`pg`),連線字串讀環境變數 `DATABASE_URL`(Railway 慣例)。
- **認證**(兩種同時支援,互不干擾):
  - **Claude Code**:固定 Bearer token(環境變數 `BRIDGE_AUTH_TOKEN`),
    所有 MCP 請求都要帶 `Authorization: Bearer <token>`,否則回 401。
  - **claude.ai**:完整 **OAuth 2.1 + PKCE + Dynamic Client Registration**
    (環境變數 `OAUTH_SIGNING_SECRET` + `OAUTH_OWNER_PASSWORD`)。這是必要的,
    不是選配的加強版——claude.ai 的自訂連接器**強制**要求伺服器支援 OAuth
    discovery + DCR,沒有「填 Bearer token 就好」這個選項。

## 環境變數

見 `.env.example`,完整六項:

| 變數 | 必填 | 說明 |
|---|---|---|
| `DATABASE_URL` | **是** | Postgres 連線字串,例如 `postgres://user:pass@host:5432/db`。缺少時啟動即失敗。Railway 上建議直接建一個 Postgres 附加元件,用 `${{Postgres.DATABASE_URL}}` 服務變數參照,不用手動貼連線字串。 |
| `BRIDGE_AUTH_TOKEN` | **是** | 固定 API key,供 Claude Code 使用。缺少時啟動即失敗。用夠長的隨機字串,例如 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` | 否,預設 8787 | HTTP 埠。Railway 會自動注入,不用特別設。 |
| `PUBLIC_BASE_URL` | 部署到公網後**強烈建議一定要設** | 自己這份 server 對外的網址(例如 `https://your-app.up.railway.app`,**不要有結尾斜線**)。這個沒設對,OAuth metadata 和導頁會全部指去 `localhost`,claude.ai 連不上。**部署順序上必須先拿到 Railway 網址、填回這個變數、再重新部署一次**(見下方部署步驟)。 |
| `OAUTH_SIGNING_SECRET` | 想接 claude.ai 才需要 | 另一組長亂數,用來簽章/驗證 OAuth 授權碼與 token(HMAC 雜湊後存進資料庫,不是明文)。**跟 `BRIDGE_AUTH_TOKEN` 要用不同的值,不要共用**。 |
| `OAUTH_OWNER_PASSWORD` | 同上,兩者要一起設才會啟用 OAuth | 這組密碼是在瀏覽器核准畫面驗證「你是這台伺服器的擁有者」用的,**不是給多人共用的登入系統**——只有一組密碼,拿到密碼的人都能核准新的連接器授權。 |

只填 `DATABASE_URL` + `BRIDGE_AUTH_TOKEN` 也能跑,但只有 Claude Code 接得上;
要讓 claude.ai 的自訂連接器也能連,`OAUTH_SIGNING_SECRET` 和 `OAUTH_OWNER_PASSWORD`
兩個都要設,缺一不可,而且必須跟 `BRIDGE_AUTH_TOKEN` 用不同的隨機值。

啟動時會自動建表(`CREATE TABLE IF NOT EXISTS`,含向下相容的欄位/索引/外鍵遷移),
不需要另外跑 migration。

## 安裝與建置

```bash
npm install
npm run build
```

## 本機執行(用 Docker 起一個 Postgres)

```bash
# 1. 起一個測試用 Postgres(佔本機 5433 埠,停掉即自動刪除)
docker run --rm -d --name bridge-pg -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16

# 2. 啟動 server(只測 Claude Code 路徑,不含 OAuth)
DATABASE_URL='postgres://postgres:test@localhost:5433/postgres' \
BRIDGE_AUTH_TOKEN='your-local-test-token' \
npm start

# 2b. 若要連 OAuth 流程也一起本機測試,再加這三個變數:
#   PUBLIC_BASE_URL='http://localhost:8787'
#   OAUTH_SIGNING_SECRET='<本機測試用亂數>'
#   OAUTH_OWNER_PASSWORD='<本機測試用密碼>'
```

Server 會在 `http://localhost:8787` 提供:

- `POST /mcp` — MCP endpoint(Streamable HTTP,需要 Bearer token 或 OAuth access token)
- `GET /healthz` — 健康檢查(不需認證、不暴露資料)
- 若設了 OAuth 三個變數:`/.well-known/oauth-protected-resource`、
  `/.well-known/oauth-authorization-server`、`/oauth/register`、`/oauth/authorize`、
  `/oauth/token`、`/oauth/revoke`

測完後 `docker stop bridge-pg` 收掉容器。

## Smoke test(實測全部 7 個工具 + 認證機制)

```bash
npm run build
DATABASE_URL='postgres://postgres:test@localhost:5433/postgres' npm run smoke
```

Smoke test 會自己啟動 server、透過 Streamable HTTP + Bearer token 驗證:

1. 沒帶 token / 帶錯 token → 401
2. `tools/list` 回傳全部 7 個工具
3. `save_memory` ×3 → `search_memory`(關鍵字 + tags)→ `get_recent_memory` → `list_by_source`
4. `delete_memory` 軟刪除後查不到、重複刪除會報錯
5. `consolidate_memory` 合併 2 筆 → 舊的查不到、新的查得到、重複整合會報錯、重複 id(去重後 < 2 筆)直接拒絕
6. `delete_by_filter` 兩段式確認(不帶 `confirm` 只回筆數;空條件直接拒絕)
7. Secret filter 拒絕 credential 格式內容(涵蓋 `content`/`summary`,以及 `tags`/`project`)

## 部署到 Railway(Postgres + Streamable HTTP + OAuth)

> 若你已經用最上方的「Deploy on Railway」按鈕一鍵部署完成,可以跳過本節,
> 直接看下方「接上 claude.ai」與「接上 Claude Code」。本節是給想手動控制
> 每一步、或想先在本機驗證再上雲的人。

程式碼已就緒並在本機以真實 Postgres 全數通過測試;以下步驟需要你自己的
Railway 帳號操作(用 dashboard 或 CLI 皆可)。**重點:`PUBLIC_BASE_URL` 一定要
在拿到公開網址「之後」才填,而且填完要重新部署一次**——這是最容易漏掉的一步。

### 用 Railway CLI(推薦,步驟明確)

```bash
npm i -g @railway/cli
railway login
cd bridge-server
railway init                 # 建立新專案
railway add -d postgres      # 加 Postgres 附加元件

# 先設定不依賴網址的變數
railway variables --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
                  --set "BRIDGE_AUTH_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
                  --set "OAUTH_SIGNING_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
                  --set "OAUTH_OWNER_PASSWORD=<自己選一組夠長的密碼>"

railway up                   # 第一次部署(這時 OAuth 還連不上,沒關係)
railway domain               # 產生公開網址,例如 https://your-app.up.railway.app

# 拿到網址後,回填 PUBLIC_BASE_URL,不要有結尾斜線
railway variables --set "PUBLIC_BASE_URL=https://your-app.up.railway.app"

railway up                   # 因為 PUBLIC_BASE_URL 變了,必須再部署一次
```

部署完確認 `https://your-app.up.railway.app/healthz` 回傳 `{"status":"ok"}`。

### 用 Dashboard

1. 到 [railway.app](https://railway.app) 建立專案,選 **Deploy from GitHub repo**
   (先把這個資料夾 push 到一個 GitHub repo)。
2. 在專案裡 **Create → Database → Add PostgreSQL**。
3. 點你的 server 服務 → **Variables**,新增 `DATABASE_URL`(參照 Postgres 服務的
   `${{Postgres.DATABASE_URL}}`)、`BRIDGE_AUTH_TOKEN`、`OAUTH_SIGNING_SECRET`、
   `OAUTH_OWNER_PASSWORD`(四個都要設,`PORT` 不用管)。
4. Railway 會自動偵測 Node 專案:`npm ci` → `npm run build` → `npm start`。
   不需要額外的 `railway.json` / `nixpacks.toml`。
5. 服務 → **Settings → Networking → Generate Domain**,拿到公開 HTTPS 網址。
6. **回到 Variables,補上 `PUBLIC_BASE_URL`**(填剛拿到的網址,不要有結尾斜線),
   儲存後 Railway 會自動觸發重新部署。
7. 確認 `https://your-app.up.railway.app/healthz` 回傳 `{"status":"ok"}`。

## 接上 claude.ai(自訂連接器)——完整走 OAuth,不用填 Header

claude.ai → **Settings → Connectors → Add custom connector**:

1. **只填 URL**:`https://your-app.up.railway.app/mcp`(不用填任何 Header/token 欄位)
2. claude.ai 會自動:
   - 打 `/.well-known/oauth-protected-resource` 和 `/.well-known/oauth-authorization-server`
     探索這台伺服器支援的 OAuth 端點
   - 呼叫 `/oauth/register` 動態註冊一個 client
   - 跳出瀏覽器授權頁,顯示密碼輸入框
3. **輸入你設定的 `OAUTH_OWNER_PASSWORD`** 核准這次連線
4. 通過後自動導回 claude.ai,連接器顯示已連線,即可使用 `save_memory` /
   `search_memory` 等工具(`source` 填 `claude_ai`)

> ⚠️ **已知風險**:即使伺服器端 OAuth 完全正確實作,claude.ai 的連接器介面
> 仍有已回報的 bug(GitHub `anthropics/claude-ai-mcp` issue #112、#457),偶爾
> 還是可能在註冊階段失敗,跳出「Couldn't register with sign-in service」。如果
> 遇到這個錯誤:
> 1. 先用瀏覽器直接打開 `https://your-app.up.railway.app/.well-known/oauth-authorization-server`,
>    確認有正常回傳 JSON(不是 404 或連不上)——如果這裡就失敗,才是自己伺服器
>    的問題(通常是 `PUBLIC_BASE_URL` 沒設對或還沒重新部署)。
> 2. 如果上面那個網址是正常的,問題大機率在 claude.ai 那端,重新整理再試一次,
>    或稍後再試。這不是「你設定錯」,是已知的上游限制。

## 接上 Claude Code

```bash
claude mcp add --transport http bridge-memory https://your-app.up.railway.app/mcp \
  --header "Authorization: Bearer <BRIDGE_AUTH_TOKEN 的值>" \
  --scope user
```

加 `--scope user` 讓這個連接在你所有專案資料夾都能用,不是只有目前這個資料夾。

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
(何時 `save_memory`、刪除前先搜尋確認 id、同主題超過 10 筆建議整合)。

## 7 個工具

| Tool | 用途 |
|---|---|
| `save_memory` | 儲存一筆長期記憶(content、source 必填;tags、project 選填) |
| `search_memory` | 依關鍵字 / tags / project 搜尋,回傳含 id |
| `get_recent_memory` | 取得最近 N 筆(預設 10) |
| `list_by_source` | 列出特定來源(claude_ai / claude_code)的記憶(預設 20 筆) |
| `delete_memory` | 依 id 軟刪除一筆 |
| `delete_by_filter` | 依條件批次軟刪除;**兩段式確認**:不帶 `confirm` 只回傳符合筆數與 id 清單,帶 `confirm: true` 才真的刪;至少要填一個條件 |
| `consolidate_memory` | 把 >=2 筆(去重後)舊記憶整合成一筆新記憶(summary 由呼叫端 LLM 先寫好),舊記憶標記 superseded_by + 軟刪除,關聯寫入 `memory_consolidations` |

## 安全性

- **Claude Code 路徑**:所有 MCP 請求都要帶 `Authorization: Bearer <BRIDGE_AUTH_TOKEN>`,
  比對使用 constant-time comparison。
- **claude.ai 路徑**:OAuth 2.1,PKCE 強制 S256、DCR、access token 1 小時過期、
  refresh token 使用後自動輪替(舊的失效)。可用 `POST /oauth/revoke` 主動撤銷
  單一 token(沒有「整組連鎖撤銷」機制,細節見 `TECHNICAL_DETAILS.md`)。
- `/healthz` 不需認證,只回 `{"status":"ok"}`,不暴露任何資料。
- `save_memory` / `consolidate_memory` 寫入前會用 regex 檢查常見 credential 格式
  (`sk-...`、`AKIA...`、`ghp_...`、`password: ...`、Bearer token、PEM private key 等),
  掃描範圍涵蓋 `content`/`summary` 以及 `tags`/`project`,命中就拒絕儲存。
  **這只是盡力而為的啟發式檢查,不是保證**——請不要把機密資訊往記憶庫丟。
- 所有刪除都是軟刪除(設 `deleted_at`),誤刪可從資料庫復原;正常查詢一律過濾
  `deleted_at IS NULL`。
- Railway 網域天生是公開 HTTPS,Anthropic 雲端連得到;不要再包 VPN / 防火牆
  (會導致 claude.ai / Claude Code 都連不上)。

## 已知限制(部署前務必了解)

- **單一擁有者密碼模型,不是多人系統**:`OAUTH_OWNER_PASSWORD` 只有一組,任何
  拿到這組密碼的人都能核准連接器授權。如果想給團隊多人用,現在這個實作
  **還做不到**,需要額外開發帳號/角色系統才行。
- **軟刪除、無自動清理**:所有刪除都是標記,不是真的移除,資料庫容量只會增加,
  沒有排程清理超過 N 天的舊資料,自己要注意 Railway 的資料庫用量。
- **憑證過濾是盡力而為**:regex 啟發式檢查擋常見格式,不是完整的資安防護,不能
  當成唯一防線。
- **沒有 rate limiting**:`/oauth/register`、`/oauth/token`、`/mcp` 目前都沒有請求
  頻率限制,網址一旦外流,理論上可以被持續嘗試打這些端點。
- 需要有基本技術能力(申請 Railway 帳號、跑 CLI 指令、填環境變數),不適合完全
  不懂技術的人直接使用。
- 更新這個專案之後,別人不會自動拿到新版本,除非重新 clone/pull 部署。
- 每個人各自部署一份**完全獨立**的系統——資料庫、`BRIDGE_AUTH_TOKEN`、
  `OAUTH_SIGNING_SECRET`、`OAUTH_OWNER_PASSWORD` 都不共用,你的記憶跟別人的
  記憶物理上分開,互不可見,你也不需要負責維運別人部署出來的那份 server。

## 後續(尚未實作)

- 既有資料一次性匯入腳本(CLAUDE.md / claude.ai 記憶匯出)
- 軟刪除超過 90 天的定期實刪排程
- OAuth token 的「重用偵測 → 整組撤銷」級聯機制(目前只有單一 token 撤銷)
- 更完整的技術細節(資料庫 schema、OAuth 完整流程時序圖等)見
  `TECHNICAL_DETAILS.md`
