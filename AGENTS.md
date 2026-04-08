# facebook_group_refresh

這是一個執行於 Facebook 社團頁面的 Tampermonkey 監控專案。

本專案刻意維持狹窄範圍：

- 偵測符合使用者自訂關鍵字的新社團貼文
- 透過使用者選擇啟用的通道，例如 `ntfy` 或 Discord，送出通知
- 盡量減少頁面動作，避免不必要的自動化

## 目前狀態

- 已有可用的 Tampermonkey userscript，位於 `src/facebook_group_refresh.user.js`
- 目前已實作的範圍包括：面板控制、include / exclude 比對、去重、debug 輸出、`ntfy` 與 Discord 支援、保守的 refresh / scroll 掃描，以及最小 Node smoke test
- 除非使用者明確要求，否則不要加入大規模爬取、自動登入或互動類功能

## 專案目標

- 優先採用瀏覽器內 userscript，而不是伺服器端爬取
- 直接使用使用者既有的 Facebook 登入 session
- 保持保守且帶隨機性的 refresh 節奏
- 穩定去重貼文通知
- 讓 selector、解析邏輯與通知傳送能相對獨立替換

## 非目標

- 不處理帳號憑證擷取或儲存
- 不加入任何繞過或規避 anti-bot 的功能
- 不自動發文、留言、按讚、加入社團、私訊或任何互動
- 除非使用者明確要求獨立工具，否則不建立隱藏背景服務

## 預期目錄結構

- `README.md`：給人看的專案總覽與目前狀態
- `AGENTS.md`：這個子目錄給 agent / AI 使用的工作說明
- `GIT_COMMIT_RULES.md`：commit message 規則
- `src/`：原始碼，包含目前使用中的 userscript
- `scripts/`：本地驗證工具，例如 smoke test
- `docs/`：可選的設計筆記與除錯說明
- `fixtures/`：可選的 HTML 片段或截圖，且需先移除敏感資料

## 工作規則

- 在進行較大修改前，先閱讀 `README.md` 與 `GIT_COMMIT_RULES.md`
- 第一版實作維持單一用途：單一社團頁、關鍵字比對、去重、通知
- 優先使用可直接在 Tampermonkey 與目前 Chromium 瀏覽器執行的原生 JavaScript
- 除非使用者要求，或維護收益非常明確，否則不要引入 bundler、框架或 package manager
- 執行期設定集中在一個明顯的 config 物件中，不要把常數散落各處
- 新增程式碼時，盡量分清這些責任：
  - 頁面判斷與 selector
  - 貼文抽取與正規化
  - 關鍵字比對
  - 去重狀態
  - 通知 adapter
  - UI / debug panel

## 安全與隱私

- 不要提交 cookies、tokens、session IDs、browser storage dump，或包含私人資料的截圖
- 若在 `fixtures/` 下加入 HTML 或截圖，應盡量去識別化姓名、頭像、連結與 ID
- 外部通知端點必須是 opt-in，且在分享範例中預設關閉
- 小型狀態例如 seen post ID 優先保存在本地瀏覽器儲存，不要導出帳號資料

## 編碼偏好

- 除非既有檔案本來就需要 Unicode，否則原始碼預設使用 ASCII
- 使用清楚的命名與短函式
- 只在邏輯不夠直觀時補上註解
- 優先採用防禦性 DOM 存取與 graceful fallback，而不是脆弱假設
- 若有穩定屬性、URL 或結構錨點，避免硬編碼易變的 CSS class 名稱

## 變更邊界

- 新增第三方依賴前先詢問
- 新增任何預設會把資料送出本機的功能前先詢問
- 新增 headless browser tooling、OCR、CAPTCHA handling 或 stealth automation 前先詢問

## 驗證

- 最小 smoke test 位於 `scripts/smoke_check_userscript.js`
- 建議驗證指令：
  - `node scripts/smoke_check_userscript.js`
- 若變更不算小，請在最終回覆中寫出手動驗證步驟
- 若日後驗證方式改變，也要同步更新這份文件中的實際指令

## Git 與 commit

- 遵守 Conventional Commits
- 每個 commit 保持小且單一主題
- 若有助於理解，可使用明確 scope，例如 `docs`、`config`、`scripts` 或 `tampermonkey`
- 詳細 commit message 規則請見 `GIT_COMMIT_RULES.md`

## 目前實作的 guardrails

- 除了頁面 refresh、本地瀏覽器儲存與明確通知傳送外，腳本應維持唯讀
- 保留 include 與 exclude 關鍵字支援
- 保留可見的 debug 模式，讓 selector 壞掉時仍可診斷
- 盡可能以穩定 post identifier 做 dedupe；若做不到，才退回文字 signature 類 fallback
- 通知通道維持 opt-in。本地通知可保留，但 `ntfy` 這類遠端通知必須由使用者自行設定
