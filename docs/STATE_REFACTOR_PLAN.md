# STATE 重構計畫

這份文件原本是 `STATE` 專題重構的分輪計畫。
目前第 1 到第 5 輪已在 `refactor/state-phase1-shape` 分支完成，並已合併回 `main`。

這份文件現在的用途是：

- 記錄這次 `STATE` 重構實際完成了什麼
- 說明目前 `STATE` 結構與 mutation 邊界
- 留下之後是否還需要再開下一輪重構的判斷基準

---

## 1. 重構前問題

重構前的 `STATE` 主要問題不是「有狀態」本身，而是：

- 太多不同性質的欄位平鋪在同一層
- 重要寫入點散在 scan、notifier、UI、lifecycle 各處
- timer / observer / route / panel runtime 的責任邊界不夠清楚
- `runScan()` 雖然已逐步變薄，但 state 寫回與 orchestration 仍可再收口
- smoke test 對 state 相關純邏輯與 control semantics 的覆蓋還不夠

這些問題在單檔 Tampermonkey userscript 中不一定會立刻變成 bug，但會明顯拉高：

- 後續閱讀成本
- 小改動時的心智負擔
- AI 或協作者接手時的誤判機率

---

## 2. 這次重構的目標

這次重構的目標是：

- 把 `STATE` 從平鋪結構改成 runtime 分區
- 讓重要寫入點盡量走分類明確的 mutation 入口
- 收斂 monitoring / scheduler / scan / notification / UI runtime 的 orchestration 邊界
- 擴充 smoke test，讓 state 相關純邏輯至少有最小回歸保護

這次刻意**不做**：

- 不導入 Redux、Zustand、MobX、RxJS 或其他 state framework
- 不把整支腳本改成 reducer / action / dispatcher 模型
- 不全面 facade 化所有讀取面
- 不為了對稱而增加大量薄 wrapper

---

## 3. 目前的 STATE 形狀

目前 `src/facebook_group_refresh.user.js` 內的 `STATE` 已整理成：

```js
const STATE = {
  config: { ... },
  scanRuntime: {
    latestScan: null,
    latestPosts: [],
    latestError: "",
    isScanning: false,
    isLoadingMorePosts: false,
  },
  notificationRuntime: {
    latestNotification: null,
  },
  routeRuntime: {
    lastUrl: location.href,
    lastRouteChangeAt: 0,
    lastRouteGroupId: getCurrentGroupId(),
  },
  uiRuntime: {
    panelMounted: false,
  },
  schedulerRuntime: {
    observer: null,
    scanTimer: null,
    refreshTimer: null,
    refreshDeadline: null,
    routeTimer: null,
    renderTimer: null,
  },
  sessionRuntime: {
    initializedGroups: new Set(),
  },
};
```

這個分法的重點不是看起來像 framework，而是讓不同 concern 至少先分層：

- `config`: 持久化設定與目前生效中的設定值
- `scanRuntime`: 掃描結果與掃描進行中狀態
- `notificationRuntime`: 最新通知狀態
- `routeRuntime`: Facebook SPA route 相關狀態
- `uiRuntime`: 面板掛載等 UI runtime
- `schedulerRuntime`: timer / observer handle 與 refresh deadline
- `sessionRuntime`: 只存在於本次 userscript session 的記憶體資料

---

## 4. 已完成的 5 輪內容

### 第 1 輪：STATE shape 重排

已完成：

- 把平鋪欄位改為 runtime 分區
- 全面替換既有讀寫路徑到新 shape
- 不改行為，只改 state 路徑

### 第 2 輪：mutation 入口收斂

已完成：

- 新增分類明確的 patch helper：
  - `setConfigPatch()`
  - `setScanRuntimePatch()`
  - `setNotificationRuntimePatch()`
  - `setRouteRuntimePatch()`
  - `setUiRuntimePatch()`
  - `setSchedulerRuntimePatch()`
  - `setSessionRuntimePatch()`
- 重要寫入點改走 patch helper，而不是直接散寫 `STATE.xxx = ...`

### 第 3 輪：monitoring / scheduler runtime 收口

已完成：

- 新增 scheduler 專用 helper：
  - `setRefreshScheduleState()`
  - `setScanScheduleState()`
  - `setFeedObserverState()`
  - `setMaintenanceLoopState()`
  - `disconnectFeedObserver()`
  - `clearMonitoringScheduleTimers()`
  - `clearMaintenanceLoops()`
- `scheduleRefresh()` / `scheduleScan()` / `installObserver()` / `startMaintenanceLoops()` 的 handle 管理已集中

### 第 4 輪：scan / notification / UI runtime 收口

已完成：

- scan runtime helper：
  - `buildResetScanRuntimeState()`
  - `buildFailedScanRuntimeState()`
  - `applyScanRuntimeState()`
- notification runtime helper：
  - `buildCompletedNotificationState()`
  - `getLatestNotificationStatusLabel()`
- panel runtime helper：
  - `buildPanelRuntimeSnapshot()`
  - `getPanelElement()`
  - `setPanelMountedState()`
- `renderPanel()`、`ensurePanelMountedAndRender()`、`finalizeLatestNotification()` 等入口已改成更清楚的 orchestration 邊界

### 第 5 輪：文件與驗證收尾

已完成：

- README 已補上 `STATE_REFACTOR_PLAN.md` 索引
- `REFACTOR_PLAN.md` 已註記 `STATE` 專題另立文件
- `SCRIPT_TEMPLATE_GUIDE.md` 已補上目前可沿用的 runtime pattern
- smoke test 已擴大到 control semantics、policy 與部分 runtime 純邏輯 helper

---

## 5. 目前 smoke test 覆蓋

目前 `scripts/smoke_check_userscript.js` 已涵蓋：

- `buildKeywordConfigPatch()`
- `buildRefreshConfigPatch()`
- `getPauseToggleAction()`
- `buildRefreshSettingsPayloadFromConfig()`
- `buildNotificationConfigPatch()`
- `buildMonitoringConfigPatch()`
- `buildUiConfigPatch()`
- `getLoadMoreMode()`
- `shouldUseTopPostShortcut()`
- `buildFailedScanRuntimeState()`
- `buildCompletedNotificationState()`
- `getLatestNotificationStatusLabel()`
- matcher 相關 helper
- dedupe / post key 相關 helper
- notification formatting helper

這些測試的目的不是取代手動測試，而是保護：

- 控制語義
- 主要 policy
- 常被重構波及的純邏輯 helper

---

## 6. 目前仍保留的取捨

這次重構之後，`STATE` 問題已從「結構性缺陷」降到「可接受的單檔 userscript 取捨」，但並不是把 state 問題完全消滅。

目前仍保留的現實：

- 仍然是單一 mutable `STATE` 物件，不是完整 state framework
- 讀取面沒有全面 facade 化
- `config` 雖已補上 keyword / refresh / notification / monitoring / UI 的 use case helper，但仍同時承接設定值與持久化語義
- 單檔 userscript 的 UI / scheduler / notifier 仍共享同一個執行環境

另外，這一輪也刻意把半正式配置再收斂一層：

- `loadMoreMode` 已從正式 `STATE.config` 移出，改為 `INTERNAL_CONFIG.loadMoreMode`
- browser-native notification 程式碼路徑已移除，不再保留 internal-only 開關

也就是說，目前正式對外設定與 internal-only capability 已開始分開，避免讓 `STATE.config` 看起來比實際產品面更大。

這些取捨是刻意保留的，因為目前專案規模下：

- 再往上做會明顯增加重構成本
- 很容易進入過度工程
- 對這支單站 Tampermonkey 腳本的維護收益不一定成比例

---

## 7. 什麼情況下才值得再開下一輪

只有在出現以下訊號時，才值得再開新的 `STATE` 專題重構：

- `STATE.xxx = ...` 的直接寫入點再次明顯擴散
- 新功能開始同時牽動 scan / notifier / UI / scheduler 多個 runtime
- patch helper 已經無法維持清楚邊界
- smoke test 難以覆蓋新增行為，因為 runtime transition 太分散
- 這支腳本不再只是單站單檔 userscript，而開始朝多站共用核心邏輯發展

如果沒有出現這些訊號，這次重構後的狀態就是合理停止點。

---

## 8. 下一輪若真的要做，建議範圍

若未來真的要再進一步，不建議直接跳到完整 state framework。
比較合理的範圍是：

- 只補更清楚的 runtime transition 文件
- 只擴充 smoke test
- 只在新功能造成邊界破壞時補對應 helper

不建議直接做：

- Redux / reducer / dispatcher 化
- 全面 action object 化
- 全面 selector facade 化
- 為單檔 userscript 製造過多抽象名詞層

---

## 9. 總結

目前 `STATE` 重構已完成，而且成果已實際落地到：

- runtime 分區
- mutation patch helper
- scheduler handle 管理
- scan / notification / panel orchestration helper
- smoke test 擴充

接下來這份文件應該被當成：

- 這次 `STATE` 重構的完成紀錄
- 之後是否需要再開新一輪的判斷基準

而不是仍然把它當成尚未執行的待辦清單。
