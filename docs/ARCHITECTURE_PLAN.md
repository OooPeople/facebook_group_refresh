# Architecture Plan

這份文件是目前專案的架構索引。舊的 `V1_SPEC.md`、`REFACTOR_PLAN.md`、`STATE_REFACTOR_PLAN.md` 已移到 `docs/archive/` 作為完成紀錄；後續新增功能時，優先以本文件描述的現況與邊界為準。

## 目前定位

`src/facebook_group_refresh.user.js` 是一支單檔 Tampermonkey userscript，執行於 `https://www.facebook.com/groups/*`。

它的核心目標是：

- 在使用者已登入 Facebook 的瀏覽器頁面中監看單一社團。
- 從目前社團動態牆抽取少量最近貼文。
- 以 include / exclude 關鍵字判斷是否通知。
- 對貼文做 group-scoped 去重，避免重複提醒。
- 只透過使用者明確啟用的通知通道送出遠端通知。
- 維持保守頁面互動，不加入登入、發文、留言、按讚、加入社團、私訊或大量爬取能力。

## 單檔分層

目前部署仍維持單一 `.user.js`，但檔案內部已依責任分段。後續修改時應優先沿用這些區段，而不是先導入 bundler 或框架。

主要區段：

- `Storage / Config`：storage key、設定載入、舊資料 migration、group-scoped 設定與 store facade。
- `Config Use Cases`：keyword、refresh、notification、monitoring、UI 設定的 patch / persist 入口。
- `Text / Common Utils`：文字正規化、HTML escape、數值裁切、panel 位置計算、clipboard 等共用工具。
- `Matcher / Rules`：include / exclude 規則解析與比對。
- `Page Context / Scheduling`：社團頁判斷、社團名稱、排序偵測、refresh / scan 排程。
- `Extractor / DOM Collection`：feed root、候選貼文容器、文字展開、permalink warmup、postId / author / text 抽取。
- `Post Parsing / Notification Formatting`：貼文 identity fragment、通知欄位與通知文字格式。
- `Persistence / Dedupe / History`：seen posts、match history、latest top post、latest scan posts。
- `Scan Engine`：單輪掃描 orchestration、跨視窗收集、top-post shortcut、seen-stop、include / exclude 摘要、commit state。
- `Notifier`：GM desktop、ntfy、Discord Webhook 的通知任務分發。
- `UI / Modal`：主面板、debug、設定視窗、說明視窗、歷史紀錄視窗、拖曳位置。
- `Lifecycle / Observer`：啟動流程、MutationObserver、Facebook SPA route 監看、panel 補掛。

## 設定與儲存

正式設定集中於 `DEFAULT_CONFIG` 與 config patch helper。

目前主要設定：

- `includeKeywords`
- `excludeKeywords`
- `paused`
- `debugVisible`
- `ntfyTopic`
- `discordWebhook`
- `maxPostsPerScan`
- `scanDebounceMs`
- `minRefreshSec`
- `maxRefreshSec`
- `jitterEnabled`
- `fixedRefreshSec`
- `autoLoadMorePosts`
- `matchHistoryGlobalLimit`
- `enableGmNotification`

`INTERNAL_CONFIG` 只放內部 policy，例如目前的 `loadMoreMode`。不要把 internal-only 能力混進正式使用者設定，除非它真的要成為 UI 可調功能。

儲存策略：

- 優先使用 Tampermonkey `GM_getValue` / `GM_setValue` / `GM_deleteValue`。
- 舊版 `localStorage` 只作為 migration fallback。
- include / exclude、通知端點、paused、refresh 等設定已改為 per-group bucket。
- `seenPosts`、`latestTopPosts`、`latestScanPosts` 使用每社團獨立 key。
- `matchHistory` 是全域清單，保留最近 `matchHistoryGlobalLimit` 筆。
- `panelPosition` 是全域位置，不分社團。

新增持久化資料時，應先補：

- `STORAGE_KEYS`
- `STORE_DEFINITIONS` 或 `PER_GROUP_STORE_DEFINITIONS`
- 對應的 normalize / load / save helper
- smoke test 覆蓋 migration 或基本讀寫形狀

## Runtime State

目前 `STATE` 已分成 runtime 區塊：

```js
const STATE = {
  config,
  scanRuntime,
  notificationRuntime,
  routeRuntime,
  uiRuntime,
  schedulerRuntime,
  sessionRuntime,
};
```

各區塊責任：

- `config`：目前生效中的正式設定。
- `scanRuntime`：最近掃描結果、最近貼文、掃描錯誤、掃描中與載入更多狀態。
- `notificationRuntime`：最近一次通知狀態。
- `routeRuntime`：Facebook SPA route、route settle 與目前 group id。
- `uiRuntime`：panel 掛載、panel 位置、拖曳狀態。
- `schedulerRuntime`：MutationObserver、scan timer、refresh timer、route/render interval。
- `sessionRuntime`：本次 userscript session 內已初始化的 group set。

重要寫入應優先透過現有 patch helper：

- `setConfigPatch()`
- `setScanRuntimePatch()`
- `setNotificationRuntimePatch()`
- `setRouteRuntimePatch()`
- `setUiRuntimePatch()`
- `setSchedulerRuntimePatch()`
- `setSessionRuntimePatch()`

後續若新增功能會同時動到多個 runtime 區塊，先補小型 orchestration helper，不要把寫入散落在 event handler、extractor 或 notifier 內。

## 掃描流程

掃描入口是 `runScan(reason)`，目前已整理成薄 orchestration：

1. `createScanExecutionContext(reason)` 建立 page / group / rule / baseline context。
2. `collectScanExecutionData(scanContext)` 收集貼文並建立 include / exclude 摘要。
3. `markGroupInitializedAfterScan(groupId, baselineMode)` 完成第一次掃描 baseline 註記。
4. `commitScanState(groupId, summaries, matchesToNotify)` 發送通知、寫入 history、標記 seen。
5. `buildSuccessfulScanRuntimeState(...)` 建立最新 panel/debug state。
6. `applySuccessfulScanRuntimeState(...)` 套用 runtime state。
7. finally 階段重排 refresh 並重繪 panel。

第一次進入某社團時會進入 baseline mode：建立 seen baseline，不對既有貼文發通知。從暫停切回開始時，目前語義是 restart current group：清掉該社團 seen baseline，並重新掃描。

## 貼文收集與抽取

抽取流程分成候選收集、DOM 準備、資料抽取與過濾：

- `findFeedRoot()` 找 feed root，找不到時退回 `document.body`。
- `collectPostContainers()` 依 `SELECTORS.postContainerCandidates` 收集視窗附近候選容器。
- `preparePostContainerForExtraction()` 展開折疊文字，並執行最小 permalink warmup。
- `extractPostRecord()` 統一輸出貼文資料形狀。
- `getNonPostReason()` 過濾排序控制列、留言回覆等非貼文內容。
- `collectPostsAcrossWindows()` 在保守捲動下累積多個可見視窗的唯一貼文。

貼文資料形狀保留：

```js
{
  postId,
  permalink,
  author,
  text,
  normalizedText,
  timestampText,
  timestampEpoch,
  groupId,
  source,
  extractedAt
}
```

目前 `timestampText` 與 `timestampEpoch` 只保留欄位形狀，不再從 Facebook DOM 抽取時間。不要在沒有明確需求時重新加入時間解析，因為這通常會增加 selector 脆弱性。

## 去重與快取

貼文 identity 目前優先順序：

1. `postId`
2. canonical permalink
3. author / timestamp / text fragment 組成的 composite key
4. legacy fallback key

`getPostKeyAliases(post)` 會為同一篇貼文建立多組等價 key，降低不同掃描輪次抽到不同欄位時造成重複通知的機率。

目前有兩個掃描最佳化：

- `top-post shortcut`：例行掃描時比對最新最上方貼文 snapshot；若相同，可跳過深度掃描。
- `seen-stop`：在「新貼文」排序且已有 seen 紀錄時，連續遇到足夠數量的已看過貼文後停止更深掃描。

這些都是保守最佳化。新增功能若會改變掃描深度、排序假設或 identity key，必須同步檢查這兩條捷徑。

## 通知架構

通知由 `notifyForPost(post)` 分發。

通道定義集中於 `NOTIFICATION_CHANNEL_DEFINITIONS`，目前包含：

- `gmDesktop`：本地 Tampermonkey `GM_notification`，預設啟用。
- `ntfy`：需要使用者設定 topic 才送出。
- `discord`：需要使用者設定 Webhook URL 才送出。

遠端通知端點必須維持 opt-in。新增任何會把資料送出本機的通道前，應先確認需求與文件。

通知內容由共用 formatter 建立：

- `getNotificationFields()`
- `buildCompactNotificationBody()`
- `buildRemoteNotificationBody()`

測試通知不得寫入 seen 或 match history；目前 `sendTestNotification()` 只走 notifier 與 panel render。

## UI 架構

主面板由 `createPanel()` 建立、`renderPanel()` 更新。

目前 UI 分工：

- 主面板 shell：固定 DOM 與按鈕。
- view state：`getPanelViewState()`、`getPanelStatusViewState()`、`getPanelDebugViewState()`。
- section update：`updatePanelControls()`、`updatePanelStatusSection()`、`updatePanelDebugSection()`。
- settings modal：讀草稿、套用草稿、持久化 refresh / notification 設定。
- history modal：讀全域 match history 並顯示可開啟貼文連結。
- help modal：definition-driven 的 include / ntfy / Discord 說明。
- panel drag：位置正規化、viewport clamp、持久化。

低優先可改善點是進一步降低 panel 重刷範圍，但目前沒有必要為形式而拆更細。

## Lifecycle

啟動流程：

1. userscript IIFE 檢查 `window.__FB_GROUP_REFRESH_RUNNING__`，避免重複初始化。
2. `start()` 呼叫 `bootstrapAppRuntime()` 與 `startMaintenanceLoops()`。
3. `bootstrapAppRuntime()` 建立 panel、安裝 observer、安排初始 scan 與 refresh。
4. `startMaintenanceLoops()` 每秒檢查 route change 與 panel 是否被 Facebook SPA 移除。
5. `handleRouteTransition()` 在 route 改變時 reload group config、重置 scan state、重裝 observer、安排掃描。

掃描與刷新排程：

- MutationObserver 新增節點時透過 debounce 安排 scan。
- route 切換後套用 `ROUTE_SETTLE_MS`，避免抓到半穩定 DOM。
- refresh 只在監控啟用且位於支援的 group page 時安排。
- refresh 秒數可用 jitter range 或 fixed seconds。

## 測試與驗證

最小驗證指令：

```powershell
node .\scripts\smoke_check_userscript.js
```

smoke test 透過 `__FB_GROUP_REFRESH_TEST_MODE__` 載入 userscript，只暴露穩定純邏輯，不啟動真實 lifecycle。

目前覆蓋重點：

- userscript metadata / test hook
- text normalization
- config patch 與 group-scoped storage
- panel position helper
- keyword matcher
- refresh payload 與 scan limits
- permalink / postId extraction helper
- post identity aliases、dedupe、seen store、history merge
- top-post shortcut 與 seen-stop helper
- notification formatting
- runtime state helper

有 DOM、Facebook 實頁、Tampermonkey 權限、通知端點的行為仍需手動驗證。

## 變更邊界

後續新增功能時，先判斷它主要屬於哪個區段：

- 新設定：走 `DEFAULT_CONFIG`、config patch helper、settings modal、storage facade。
- 新關鍵字語法：改 `Matcher / Rules`，並補 smoke test。
- 新抽取欄位：改 extractor 與 post record shape，並同步 debug panel。
- 新 notification channel：改 notification channel registry、runner map、settings UI 與 opt-in 文件。
- 新掃描策略：改 scan engine / scheduler，並檢查 top-post shortcut 與 seen-stop。
- 新 UI 顯示：優先從 view state 與 section renderer 切入，不直接散讀 `STATE`。

避免事項：

- 不引入 bundler、框架或第三方依賴，除非需求明確且先討論。
- 不做背景 headless browser、OCR、CAPTCHA、stealth automation。
- 不自動登入、發文、留言、按讚、加入社團或私訊。
- 不把遠端通知改成預設啟用。
- 不在同一輪同時大改 selector / extractor 與 scan orchestration。
