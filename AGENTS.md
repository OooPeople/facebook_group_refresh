# facebook_group_refresh

這是一個執行於 Facebook 社團頁面的 Tampermonkey 監控專案。agent / AI 在本 repo 工作時，請把它視為「單檔 userscript 應用」，而不是要被改造成多檔前端專案或背景爬蟲服務。

## 專案定位

核心用途：

- 在使用者已登入 Facebook 的瀏覽器中監看單一社團頁。
- 抽取少量最近貼文，套用 include / exclude 關鍵字規則。
- 以 group-scoped seen state 做穩定去重。
- 透過使用者明確啟用的通道送出通知，例如 `ntfy` 或 Discord。
- 保持保守 refresh / scroll 掃描，避免不必要的頁面互動。

明確非目標：

- 不處理帳號憑證、cookies、tokens、session IDs 或登入自動化。
- 不加入繞過 anti-bot、CAPTCHA、OCR、stealth automation 或大量爬取能力。
- 不自動發文、留言、按讚、加入社團、私訊或任何互動類功能。
- 除非使用者明確要求，不建立 headless browser、背景服務、server crawler 或獨立排程器。

## 目前入口文件

較大修改前，先閱讀：

- `README.md`：專案總覽與使用入口。
- `docs/ARCHITECTURE_PLAN.md`：目前架構、runtime 邊界與變更邊界。
- `docs/TASK_BREAKDOWN.md`：任務分類、驗證清單與完成定義。
- `GIT_COMMIT_RULES.md`：commit message 規則。

其他文件定位：

- `src/facebook_group_refresh.user.js`：唯一實際使用的 Tampermonkey userscript。
- `scripts/smoke_check_userscript.js`：最小 Node smoke test。
- `docs/USAGE.md`：使用者操作說明；使用者可見行為變更時需同步更新。
- `docs/SCRIPT_TEMPLATE_GUIDE.md`：把本專案作為其他單站監視腳本模板時使用。
- `docs/archive/`：已完成的歷史規格與重構紀錄，不作為新任務的主要入口。
- `docs/HANDOFF_PLAN.md`：任務交接文件；只有在有具體交接需求時再填。

## 架構紀律

部署仍維持單一 `.user.js`。不要為了形式引入 bundler、框架、package manager 或多檔拆分；只有在使用者明確要求，或維護收益非常明確時才討論。

新增或修改程式碼時，先判斷主要落在哪個區段：

- `Storage / Config`
- `Config Use Cases`
- `Text / Common Utils`
- `Matcher / Rules`
- `Page Context / Scheduling`
- `Extractor / DOM Collection`
- `Post Parsing / Notification Formatting`
- `Persistence / Dedupe / History`
- `Scan Engine`
- `Notifier`
- `UI / Modal`
- `Lifecycle / Observer`

維護重點：

- `STATE` 已分成 `config`、`scanRuntime`、`notificationRuntime`、`routeRuntime`、`uiRuntime`、`schedulerRuntime`、`sessionRuntime`。新增 state 時先分類，不要直接塞回頂層。
- `set...Patch()` 是底層 mutation helper。新業務邏輯優先走有語義的 use case / apply helper，例如 `apply...ConfigPatch()`、`pauseMonitoring()`、`restartMonitoringForCurrentGroup()`，避免把 patch helper 當萬用入口。
- `DEFAULT_CONFIG` 放正式使用者設定；`INTERNAL_CONFIG` 放內部 policy。不要把 internal-only 能力混入正式 config，除非它真的要成為 UI 可調功能。
- runtime、persistence、DOM render、notification side effect 要盡量分清。若需要從 storage hydration runtime config，請讓 hydration 是明確動作，不要讓普通 read path 暗中改 state。
- `Set` / `Map` 類 runtime 狀態不要在外部任意 mutate；優先透過既有語義 helper，例如 `isGroupInitialized()`、`markGroupInitialized()`。
- scan orchestration 只做編排。新增抽取、判斷、統計、commit、shortcut 或 debug 資訊時，優先放在獨立 helper，不要把 `runScan()` 或主掃描幹線重新塞胖。
- UI render 走 snapshot / view state。不要讓 render 直接承接 raw runtime 並混入 domain 判斷；UI event handler 也不要直接散寫 persistence 或 scan state。

## 變更規則

新增設定：

- 更新 `DEFAULT_CONFIG`、config definition、config patch / persist helper。
- 判斷是否需要 group-scoped storage。
- 同步 settings modal、debug 顯示、`docs/USAGE.md` 與 smoke test。

修改關鍵字語法：

- 以 `Matcher / Rules` 為主要修改區。
- 保留 include 空白代表「所有貼文先視為 include 命中」的語義，除非使用者明確要求改變。
- exclude 命中應繼續優先抑制通知。

修改 extractor / selector：

- 優先使用穩定結構、URL、ARIA、資料屬性或文字錨點，避免依賴易變 CSS class。
- 不要同一輪同時大改 selector / extractor 與 scan orchestration。
- 若新增 fixture，必須先去識別化姓名、頭像、連結、ID 與私人內容。
- `timestampText` / `timestampEpoch` 目前只保留欄位形狀，不做 Facebook DOM 時間抽取；沒有明確需求不要恢復。

修改 scan / dedupe：

- 檢查 baseline mode、top-post shortcut、seen-stop 與 group-scoped seen store 是否仍正確。
- 同一篇貼文在 `postId`、permalink 或 fallback 欄位變動時，仍應盡量被視為同一篇。
- 不要清掉其他社團的 seen state。
- match history 目前是全域最近清單，不要重新切回 per-group，除非有明確需求。

新增通知通道：

- 遠端通知必須 opt-in。
- 不要把 token、webhook、topic 寫入範例預設值。
- 測試通知不得寫入 seen 或 match history。
- 同步 notification registry、runner map、settings UI、`docs/USAGE.md` 與 smoke test。

修改 lifecycle / scheduler：

- Facebook 是 SPA，route change 後要保留 settle window。
- 暫停時不應安排 scan 或 refresh。
- 不要製造多個 observer、interval 或 timer handle。
- panel 被 Facebook 重掛移除時仍需能補回。

## 安全與隱私

- 不提交 cookies、tokens、session IDs、browser storage dump 或包含私人資料的截圖。
- 外部通知端點必須由使用者自行設定，分享範例預設關閉。
- 小型狀態如 seen post ID 優先保存在本地瀏覽器儲存，不導出帳號資料。
- 除頁面 refresh、本地瀏覽器儲存、保守 scroll / text expand 與明確通知傳送外，腳本應維持近似唯讀。

## 編碼偏好

- 原始碼優先使用可直接在 Tampermonkey 與目前 Chromium 瀏覽器執行的原生 JavaScript。
- 除非既有檔案本來就需要 Unicode，否則原始碼預設使用 ASCII；文件可使用繁體中文。
- 讀取文件時請明確使用 UTF-8；在 PowerShell 中優先使用 `Get-Content -Encoding utf8`，避免繁體中文文件被誤判編碼。
- 使用清楚命名與短函式；只在邏輯不夠直觀時補註解。
- 優先防禦性 DOM 存取與 graceful fallback，不寫脆弱假設。
- 新增第三方依賴、預設外送資料、headless tooling、OCR、CAPTCHA 或 stealth automation 前，必須先詢問。

## 驗證

最小驗證指令：

```powershell
node .\scripts\smoke_check_userscript.js
```

需要補充手動驗證的情況：

- 變更 DOM extractor、selector、scroll/load-more、route handling、panel UI、Tampermonkey 權限或通知端點。
- 新增或改變使用者可見行為。

手動驗證重點依 `docs/TASK_BREAKDOWN.md` 為準。若驗證方式改變，請同步更新本文件與相關 docs。

## Git 與 commit

- 遵守 Conventional Commits。
- 每個 commit 保持小且單一主題。
- 常見 scope 可用 `docs`、`config`、`scripts`、`tampermonkey`。
- 詳細規則見 `GIT_COMMIT_RULES.md`。
