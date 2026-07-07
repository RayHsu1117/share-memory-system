# 補充規格:讓其他人也能部署自己獨立的一份(依現有實作更新版)

> 這份是「Claude.ai ↔ Claude Code 橋接記憶系統」的補充章節,依照目前
> `RayHsu1117/share-memory-system` 這個 repo **實際的實作**(Railway + Postgres +
> OAuth 2.1 + PKCE + DCR,含 `/oauth/revoke`)重新校對過,取代先前對照舊規格書寫的初版。
> 目的是讓別人能複製一份**完全獨立**的系統,不影響你自己這份正在跑的。
>
> 這一版把「`README.md` 應該涵蓋什麼」從一份待檢查清單,改成一份**逐條核對過、
> 具體指出哪裡漏、哪裡錯**的落差清單(見下方「`README.md` 實際落差清單」),
> 可以直接照著改,不用再重新比對一次。

## 設計原則(不變)

不做多租戶隔離,而是把整個專案當成「可複製的模板」——每個人自己申請 Railway 帳號、
自己起一份 Postgres、自己部署一份完全獨立的 server。你的跟別人的資料庫、token、
OAuth 密碼完全不共用。

- 不需要 user_id 隔離、不需要多租戶權限系統
- 資料物理上分開,沒有外洩風險
- 每個人自己管自己的用量與 Railway 帳單
- 你不需要負責維運別人部署出來的那份 server

## 目前實際會用到的環境變數(以現有程式碼為準)

`.env.example` 現在完整涵蓋這六項,對方部署時要自己填:

| 變數 | 必填 | 說明 |
|---|---|---|
| `DATABASE_URL` | **是** | 自己的 Postgres 連線字串。Railway 上建議直接建一個 Postgres 附加元件,用 `${{Postgres.DATABASE_URL}}` 服務變數參照,不用手動貼連線字串 |
| `BRIDGE_AUTH_TOKEN` | **是** | 自己設一組長亂數字串,供 Claude Code 用(`claude mcp add ... --header "Authorization: Bearer <token>"`) |
| `PORT` | 否,預設 8787 | Railway 通常會自動注入,不用特別設 |
| `PUBLIC_BASE_URL` | 部署到公網後**建議一定要設** | 自己那份 server 對外的網址(例如 `https://<自己的服務名>-production-xxxx.up.railway.app`)。這個沒設對,OAuth metadata 和導頁會全部指去 `localhost`,claude.ai 連不上 |
| `OAUTH_SIGNING_SECRET` | 想接 claude.ai 才需要 | 另一組長亂數,用來簽章/驗證 OAuth 授權碼與 token。跟 `BRIDGE_AUTH_TOKEN` 要用不同的值,不要共用 |
| `OAUTH_OWNER_PASSWORD` | 同上,兩者要一起設才會啟用 OAuth | 這組密碼是用來在瀏覽器核准畫面驗證「你是這台伺服器的擁有者」,不是給多人共用的登入系統 |

只填 `DATABASE_URL` + `BRIDGE_AUTH_TOKEN` 也能跑,但只有 Claude Code 接得上;
要讓 claude.ai 的自訂連接器也能連,`OAUTH_SIGNING_SECRET` 和 `OAUTH_OWNER_PASSWORD`
兩個都要設,缺一不可。

## `README.md` 實際落差清單(已對照現有內容逐條核對,不是「請檢查」而是「這些確實漏了/錯了」)

已經拿目前 repo 的 `README.md` 對照過一輪,結論:**內容明顯落後於實作**,而且有一處是會讓對方複製到已知失敗操作的錯誤說明。要讓別人能自己部署一份,以下是必須修正的具體項目:

1. **🔴 最高優先:「接上 claude.ai」章節說明是錯的。** 現在寫的是「若介面沒有獨立 token 欄位,填 HTTP header:`Authorization: Bearer <BRIDGE_AUTH_TOKEN>`」——這正是實測會失敗、跳出 `Couldn't register with sign-in service` 錯誤的舊做法(claude.ai 的自訂連接器一律強制走 OAuth Dynamic Client Registration,沒有填 header 的選項)。必須整段改寫成:
   - 只填 URL(不用填 header)
   - claude.ai 會自動嘗試 OAuth discovery + DCR 註冊
   - 跳出瀏覽器核准頁,輸入 `OAUTH_OWNER_PASSWORD`
   - 通過後自動導回、顯示已連線
   - 補一句提醒:即使伺服器端 OAuth 完全實作正確,claude.ai 那端仍有已知回報的 bug(參考 anthropics/claude-ai-mcp #112、#457),偶爾還是可能失敗,失敗時建議先確認 `/.well-known/oauth-authorization-server` 有正常回應。

2. **環境變數表不完整。** 現在只列 `DATABASE_URL`、`BRIDGE_AUTH_TOKEN`、`PORT` 三個,漏了 `PUBLIC_BASE_URL`、`OAUTH_SIGNING_SECRET`、`OAUTH_OWNER_PASSWORD`。要換成本文件上面那張完整六欄的表。

3. **開頭「認證」說明過時。** 現在寫「OAuth2 依規格留待第二版」,但 OAuth 2.1 + PKCE + DCR 已經做完並上線驗證過,這句話要拿掉或改成「支援兩種認證:Claude Code 用固定 Bearer token,claude.ai 用 OAuth 2.1(見下方各自的接法)」。

4. **Railway CLI 部署步驟缺 OAuth 變數,也漏了關鍵的操作順序。** 現有步驟只設了 `BRIDGE_AUTH_TOKEN` + `DATABASE_URL`,且沒提到「`railway domain` 拿到網址之後,要把這個網址填回 `PUBLIC_BASE_URL` 環境變數,然後重新 `railway up` 一次」這個順序——這步漏掉的話,OAuth 的 metadata 和導頁全部會指向 `localhost`,claude.ai 連不上。完整步驟應該是:
   ```
   npm i -g @railway/cli && railway login
   railway init
   railway add -d postgres
   railway variables --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
                     --set "BRIDGE_AUTH_TOKEN=<長亂數>" \
                     --set "OAUTH_SIGNING_SECRET=<另一組長亂數,不可跟上面共用>" \
                     --set "OAUTH_OWNER_PASSWORD=<你的核准密碼>"
   railway up
   railway domain   # 拿到網址後...
   railway variables --set "PUBLIC_BASE_URL=<剛拿到的網址,不要有結尾斜線>"
   railway up       # 因為 PUBLIC_BASE_URL 變了,必須再部署一次
   ```
   最後確認 `<網址>/healthz` 回傳 `{"status":"ok"}`。

5. **「後續(第二版之後)」章節還把 OAuth 列為待辦。** 這節要更新,拿掉已完成的 OAuth 項目,只留真正還沒做的(既有資料匯入腳本、軟刪除定期清理排程)。

6. **完全沒有本文件下面「給對方的重要提醒」那 5 點限制說明。** 這 5 點必須整段搬進 README,獨立成一個章節(例如「已知限制」),不能省略——這是避免對方誤會這是正式多人產品的關鍵資訊。

7. **接上 Claude Code 的步驟本身是對的**,維持不變:
   ```
   claude mcp add --transport http bridge-memory <你的網址>/mcp \
     --header "Authorization: Bearer <BRIDGE_AUTH_TOKEN 的值>"
   ```

8. 補一句資料存放說明(README 目前完全沒提):對方的記憶存在**對方自己申請**的 Railway Postgres 裡,不會經過你的伺服器或帳號,你們兩份資料完全獨立、互不可見。

## 給對方的重要提醒(這是目前實作的既知限制,務必寫進 README)

- **這是單一擁有者密碼模型,不是多人系統**:`OAUTH_OWNER_PASSWORD` 只有一組,
  任何拿到這組密碼的人都能核准連接器授權。如果對方想給團隊多人用,現在這個實作
  **還做不到**,需要額外開發帳號/角色系統才行——先講清楚,避免對方誤會這是
  多租戶產品。
- **軟刪除、無自動清理**:所有刪除都是標記,不是真的移除,資料庫容量只會增加,
  沒有排程清理超過 N 天的舊資料,對方要自己注意 Railway 的資料庫用量。
- **憑證過濾是盡力而為**:`save_memory`/`consolidate_memory` 會做啟發式的正則檢查
  擋掉常見 API key/密碼格式,但不是完整的資安防護,不能把它當成唯一防線。
- **沒有 rate limiting**:`/oauth/register`、`/oauth/token`、`/mcp` 目前都沒有請求
  頻率限制,如果對方的網址被別人拿到,理論上可以持續嘗試打這些端點。
- 對方需要有基本技術能力(申請 Railway 帳號、跑 CLI 指令、填環境變數),不適合
  完全不懂技術的人直接使用。
- 你更新這個專案之後,別人不會自動拿到新版本,除非重新 clone/pull 部署。

## 建議進行順序

1. ✅ 目前單人版(Railway + Postgres + OAuth 2.1 + PKCE + DCR)已經跑穩,這步已完成。
2. ✅ `README.md` 落差分析已完成(見上方「實際落差清單」8 點)——下一步是照著那 8 點
   直接改 `README.md`,不用再重新檢查一次,問題跟解法都已經寫清楚了。
3. 把「給對方的重要提醒」那 5 點限制說明整段搬進 README(落差清單第 6 點已經提到,
   這裡再次強調:是「搬過去」,不是重寫)。
4. (選做)研究 Railway 的 "Deploy on Railway" 一鍵部署按鈕,降低對方操作門檻——
   但要注意這種按鈕通常只能預設環境變數的「名稱」,實際的值(尤其
   `OAUTH_SIGNING_SECRET`、`OAUTH_OWNER_PASSWORD`)還是要對方自己填,按鈕本身
   解決不了「兩份 secret 不能共用」這件事,README 還是要講清楚。
5. 找一位朋友實測一次完整流程,包含 claude.ai 連接器的 OAuth 授權那一步,
   確認 README 修好之後步驟真的走得通、沒有遺漏(這步之前只有你自己測過)。
   實測時特別留意:如果朋友的 claude.ai 連接器卡在 OAuth 註冊失敗,那大機率是
   §「已知限制」提到的 claude.ai 端 bug(#112/#457),不是他的伺服器設定錯——
   先讓他自己確認 `/.well-known/oauth-authorization-server` 這個網址能不能正常
   打開、有沒有回傳 JSON,排除是自己這邊的問題後再往 claude.ai 那邊查。
