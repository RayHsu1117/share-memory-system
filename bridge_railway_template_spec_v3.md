# Bridge Memory — Railway Template 化規格(v3)

> 這份是接續 `bridge_multi_deploy_addendum.md`(v1/v2,手動部署版)的下一步。
> 目標:把 `RayHsu1117/share-memory-system` 包裝成一個 **Railway Template**,
> 讓使用者從原本要跑 8-10 條指令、手動生成密鑰、注意環境變數填寫順序,
> 簡化成「點一個 Deploy 按鈕、填一組密碼、等兩分鐘」。
>
> **核心原則(維持不變)**:使用者自己的 Railway 帳號、自己的帳單、自己的
> Postgres。你不維運任何人的部署,只負責讓「設定」這件事變簡單。

## 0. 為什麼選 Railway Template,而不是自己做一個部署服務

Railway Template 原生支援三件事,剛好解決現有手動流程的三個痛點:

| 現有手動流程的痛點 | Railway Template 的解法 |
|---|---|
| 使用者要自己想辦法生成 `BRIDGE_AUTH_TOKEN`、`OAUTH_SIGNING_SECRET` 兩組隨機字串 | Template variable function(例如 `${{ secret(32) }}`)在部署當下自動產生,使用者不用碰 |
| 要先 `railway up` 部署一次拿網址,填回 `PUBLIC_BASE_URL`,再部署第二次 | 用 Railway 內建的 `${{RAILWAY_PUBLIC_DOMAIN}}` 直接參照,一次部署就到位,不用再部署第二次 |
| 要自己 `railway add -d postgres` 再手動接 `DATABASE_URL` | Template 裡預先定義好 Postgres 服務,`${{Postgres.DATABASE_URL}}` reference variable 自動接上 |

用 Template 幾乎不用自己蓋任何後端服務,維護成本趨近於零——你只要維護一份
GitHub repo(現有的)+ 一份 Template 設定(在 Railway 後台建立,一次性)。

## 1. 需要準備的 Template 設定

### 1.1 服務拓樸

Template 裡定義兩個服務:

1. **`bridge-server`**:來源指向 `RayHsu1117/share-memory-system` 這個 GitHub repo
2. **`Postgres`**:Railway 官方提供的 Postgres plugin,直接加進 Template

### 1.2 環境變數設定(這是本次規格的核心)

在 Railway Template 編輯介面裡,把每個變數設定成:

| 變數 | 設定方式 | 對使用者顯示的說明文字(建議文案) |
|---|---|---|
| `DATABASE_URL` | Reference variable:`${{Postgres.DATABASE_URL}}` | (不需要使用者看到/填寫,自動帶入) |
| `PORT` | 不設定,讓 Railway 自動注入 | (不顯示) |
| `PUBLIC_BASE_URL` | Reference variable:`https://${{RAILWAY_PUBLIC_DOMAIN}}` | (不需要使用者填寫,自動帶入;**這是解決原本「部署兩次」問題的關鍵設定**) |
| `BRIDGE_AUTH_TOKEN` | Template variable function 自動產生,例如 `${{ secret(32) }}` | 說明:「這組是給 Claude Code 用的存取密鑰,部署完後到 Variables 頁面複製它」 |
| `OAUTH_SIGNING_SECRET` | Template variable function 自動產生,與 `BRIDGE_AUTH_TOKEN` 用不同的隨機值 | 說明:「這是給 claude.ai 連線用的內部簽章密鑰,你不需要記住或用到它」 |
| `OAUTH_OWNER_PASSWORD` | **留給使用者手動輸入**(必填,沒有預設值) | 說明:「設一組你自己的密碼,之後 claude.ai 要求你登入核准連線時會用到,請自己記住」 |

**只有 `OAUTH_OWNER_PASSWORD` 需要使用者手動輸入**,其餘全部自動處理。這是相較
於原本手動流程(需要理解、生成、正確填寫六個變數)最大幅度的簡化。

> 技術細節提醒(給 Fable 實作時參考):Railway 的 template variable function
> 語法與寫法需要在 Railway 後台的 Template 編輯介面實際操作與測試,確認
> `secret(32)` 這類語法在 Template 編輯器裡的實際可用選項與寫法(Railway 的
> template variable function 文件列出 `secret`、`randomInt` 等函式,但具體參數
> 與寫法建議在建立 Template 時於 Railway 後台介面直接測試確認,而不是憑記憶
> 假設語法完全正確)。

### 1.3 Health check 設定

Template 裡設定 `/healthz` 作為 health check 路徑,確保 Railway 在部署完成後
才把流量導向這個服務(避免使用者太早存取到還沒 ready 的服務)。

## 2. Template 描述文字(使用者在 Railway 上會看到的說明)

Railway Template 頁面本身要包含:

1. **一句話說明**:「讓 claude.ai 和 Claude Code 共用同一份記憶的橋接服務,
   部署後完全屬於你自己,資料存在你自己的 Postgres 裡」
2. **部署後的下一步**:提醒使用者部署完成後要做兩件事——
   - 去 Variables 頁面複製 `BRIDGE_AUTH_TOKEN`,用來接 Claude Code
   - 記住自己剛剛設定的 `OAUTH_OWNER_PASSWORD`,用來接 claude.ai
3. 連到 GitHub repo README 的連結,作為完整文件參考

## 3. 教學/設定輔助頁面(靜態網頁,零維運)

除了 Template 本身,建議額外做一個**純靜態網頁**(用 GitHub Pages 或類似平台
託管,沒有後端、沒有資料庫、你不用維運),放在 repo 底下(例如 `/docs` 資料夾),
內容包含:

### 3.1 「Deploy on Railway」按鈕
放在頁面最上方,直接連到 Template。

### 3.2 部署後設定小工具(純前端 JavaScript,不經過任何伺服器)

一個簡單的表單:
- 輸入框 1:貼上自己部署後拿到的網址(例如 `https://xxx.up.railway.app`)
- 輸入框 2:貼上自己從 Railway Variables 頁面複製的 `BRIDGE_AUTH_TOKEN`
- 按下「產生指令」後,頁面用 JavaScript 直接組出:
  ```bash
  claude mcp add --transport http bridge-memory <使用者填的網址>/mcp \
    --header "Authorization: Bearer <使用者填的 token>" \
    --scope user
  ```
  並附上「複製」按鈕

**這一步全部在瀏覽器端用 JavaScript 完成字串組合,不會把使用者的 token 傳到
任何伺服器**——這點要在頁面上明講,建立使用者對這個工具的信任感(畢竟 token
是敏感資訊,使用者會在意它有沒有被上傳出去)。

### 3.3 claude.ai 連接教學(純文字/截圖,不需要工具)

沿用現有 README 裡「只填 URL,不用填 Header」那段說明,包含已知的
claude.ai 端 OAuth 註冊偶發失敗的提醒與排查步驟。

## 4. 對現有 repo 需要的調整

1. `README.md` 最上方新增「Deploy on Railway」按鈕 + 一段話說明現在有更簡單的
   方式,同時**保留**原本的手動部署章節(給想要更多控制權、或想先在本機驗證
   一遍再上雲的人用)
2. 確認 `.env.example` 與 Template 裡設定的變數名稱完全一致,避免文件與實際
   設定不同步
3. 新增 `/docs` 資料夾放靜態教學頁面(見第 3 節)
4. Template 本身在 Railway 後台建立、測試、發布,這一步是**手動操作**,不在
   程式碼庫裡,需要有 Railway 帳號的人(你)登入後台親自完成

## 5. 驗證清單(Template 做完後,務必實際測過一輪,不能只看設定畫面覺得對就好)

1. 用一個**全新的 Railway 帳號**(或無痕視窗登入不同帳號)點 Deploy 按鈕,
   從頭跑一次,確認:
   - 只需要填 `OAUTH_OWNER_PASSWORD` 一個欄位
   - 部署完成後,不用手動再部署第二次,`PUBLIC_BASE_URL` 就已經是正確的網址
   - `<網址>/healthz` 直接回傳正常,不需要額外操作
2. 用產生出來的 `BRIDGE_AUTH_TOKEN` 實際跑一次 `claude mcp add`,確認 Claude
   Code 連得上、能呼叫 `save_memory`
3. 用剛剛設定的 `OAUTH_OWNER_PASSWORD` 走一次 claude.ai 自訂連接器的 OAuth
   流程,確認連得上、能呼叫工具
4. 測試靜態教學頁面的指令產生小工具,確認貼上網址跟 token 之後,產生的指令
   複製貼上到終端機真的能直接執行,沒有多餘空白或格式問題

## 6. 這個方案跟之前「多租戶 SaaS」規格(`bridge_saas_multitenant_spec.md`)的關係

這是兩條**互斥的路線**,提醒一下避免搞混:

- **這份(Template 化)**:每人各自一份獨立服務,你不維運任何人的資料庫,
  零維護成本,但使用者需要有 Railway 帳號、願意付自己的 Railway 帳單
- **`bridge_saas_multitenant_spec.md`(多租戶 SaaS)**:你自己維運一台服務給
  所有人共用,需要帳號系統、多租戶隔離、法律合規,維護責任在你身上

目前這份規格是走前者。如果之後真的想做後者,是完全不同的架構決定,不會是
「在 Template 基礎上疊加」,而是兩個平行的產品形態。

## 7. 建議開發順序

1. 在 Railway 後台建立 Template,先用你自己的 Railway 帳號練習設定介面,確認
   template variable function 的實際語法(見第 1.2 節的提醒)
2. 設定六個環境變數,`OAUTH_OWNER_PASSWORD` 設為必填、無預設值,其餘按第 1.2
   節設定
3. 寫 Template 描述文字(第 2 節)
4. 做静態教學頁面(第 3 節),包含指令產生小工具
5. 更新 `README.md`,加上 Deploy 按鈕(第 4 節)
6. 找一個全新帳號完整跑一次驗證清單(第 5 節),確認真的「填一個密碼、等兩
   分鐘」就能用,不是「理論上應該可以」
7. 找一位朋友(不知道任何內情的人)實際試用一次,觀察他卡在哪裡,那些卡點
   就是教學頁面還需要補強的地方
