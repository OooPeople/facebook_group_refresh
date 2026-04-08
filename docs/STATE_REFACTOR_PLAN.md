# STATE 重構計畫

本文件是一份**尚未執行的未來重構計畫**，目標是針對目前 `src/facebook_group_refresh.user.js` 中的 `STATE` 使用面，做一次**完整且一致**的整理。

這份計畫刻意獨立成單一文件，原因如下：

- `STATE` 整理如果只做一半，容易比現在更亂
- 這類重構會影響 scan / notifier / UI / lifecycle，多半不適合穿插在一般功能修正中順手做
- 若未來真的要做，應視為一個完整主題，集中規劃、集中驗證、集中提交

---

## 1. 為什麼需要這份計畫

目前腳本的主要結構已經算清楚，但 `STATE` 仍同時承擔多種責任，例如：

- `config`
- `latestScan`
- `latestPosts`
- `latestNotification`
- `latestError`
- `observer`
- `scanTimer`
- `refreshTimer`
- `routeTimer`
- `renderTimer`
- `lastUrl`
- `lastRouteChangeAt`
- `lastRouteGroupId`
- `panelMounted`
- `isScanning`
- `isLoadingMorePosts`

這種設計在單檔 userscript 中不是錯誤，但有幾個長期風險：

1. 新功能很容易「順手」直接寫進 `STATE`
2. 不同責任區會共享同一個 mutable object，邊界容易再次變鬆
3. 之後若要複製這支腳本當範本，會比較難向 AI 或人明確說明：
   - 哪些狀態屬於設定
   - 哪些屬於 scan runtime
   - 哪些屬於 UI runtime
   - 哪些屬於 lifecycle / scheduler

這份計畫的目的不是消滅 `STATE`，而是：

> 讓 `STATE` 的形狀、責任與 mutation 入口變得一致、可說明、可維護。

---

## 2. 這次重構要達成什麼

### 2.1 主要目標

1. 明確切分 `STATE` 內不同責任區
2. 為每一類 state 建立一致的 mutation 入口
3. 減少「任意函式隨手改任意欄位」的情況
4. 保持單檔 userscript 架構，不引入 framework / store library
5. 不改動功能行為，只整理 state 邊界與寫入路徑

### 2.2 次要目標

1. 讓未來新腳本更容易模仿這份 state 管理方式
2. 讓 smoke test 可逐步擴到更多 policy 與 state transition
3. 讓 debug 與 scan 流程更容易追蹤 state 誰改過

---

## 3. 不做什麼

這份重構**不做**以下事情：

### 3.1 不改成多檔架構

仍維持單檔 `src/facebook_group_refresh.user.js`。

### 3.2 不引入外部 state management 工具

不使用：

- Redux
- Zustand
- MobX
- RxJS
- 任何第三方狀態管理套件

### 3.3 不為了形式而做假抽象

不接受這種結果：

- 原本 `STATE.xxx = ...`
- 改成 `setSomething({ ... })`
- 但沒有明確分類、沒有共同規則、只是多一層 wrapper

### 3.4 不同一輪碰 selector / extractor 策略

這份計畫只處理 state 邊界。  
不要把 Facebook DOM 抽取邏輯調整混進來。

### 3.5 不在同一輪順手改 UI 功能

像以下都不應該混入本重構：

- 新增按鈕
- 改 modal 內容
- 改通知文案
- 改自動捲動策略

---

## 4. 預期的最終狀態

完成後，`STATE` 應該接近這種結構：

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

這不表示一定要完全長成上面這個樣子，但原則應該一致：

- 設定一區
- scan 一區
- notification 一區
- route 一區
- UI 一區
- scheduler / lifecycle 一區
- session / memory-only 狀態一區

---

## 5. 重構原則

### 5.1 先分 shape，再改 mutation

不要一邊抽 setter、一邊改 state 形狀。  
順序應該是：

1. 先定 state 分類
2. 再改讀取路徑
3. 再改寫入路徑

### 5.2 每次只收斂一類 state

例如：

- 先收 `notificationRuntime`
- 再收 `scanRuntime`
- 再收 `schedulerRuntime`

不要同一輪同時大改全部。

### 5.3 mutation 入口必須分類清楚

如果要新增 setter / patch helper，至少要符合：

- `setConfigPatch(patch)`
- `setScanRuntimePatch(patch)`
- `setNotificationRuntimePatch(patch)`
- `setRouteRuntimePatch(patch)`
- `setUiRuntimePatch(patch)`
- `setSchedulerRuntimePatch(patch)`

不要新增一堆語意含糊的：

- `updateState()`
- `patchState()`
- `setRuntimeState()`

### 5.4 讀取可以先保守，寫入要先收口

也就是：

- 讀取 `STATE.scanRuntime.latestScan` 這種路徑可逐步改
- 但寫入最好優先改成走明確入口

### 5.5 不改行為語義

這份重構的目的不是改功能，例如：

- `開始` 是否 restart
- `seenPosts` 是否單群組
- top-post shortcut 是否啟用

這些行為語義應保持不變，只整理它們透過哪個 state 面向被驅動。

---

## 6. 建議的實作分階段

這份計畫建議分成 **5 輪**。  
每一輪都應可單獨提交、單獨驗證。

---

## 第 1 輪：定義新的 STATE 形狀

### 目標

先把 `STATE` 的欄位重新分區，但**暫時不改所有函式的寫法**。

### 要做的事

1. 重新整理 `const STATE = { ... }` 的內部結構
2. 將目前平鋪欄位依責任收進子物件，例如：
   - `scanRuntime`
   - `notificationRuntime`
   - `routeRuntime`
   - `uiRuntime`
   - `schedulerRuntime`
   - `sessionRuntime`
3. 先改最直接的初始化讀取
   - `STATE.latestNotification` -> `STATE.notificationRuntime.latestNotification`
   - `STATE.lastUrl` -> `STATE.routeRuntime.lastUrl`
   - `STATE.scanTimer` -> `STATE.schedulerRuntime.scanTimer`
   - 依此類推

### 不要做的事

- 這一輪不要新增 setter helper
- 這一輪不要大改邏輯
- 這一輪不要改功能語義

### 風險

- 改動面大，但 mostly mechanical
- 任何漏改都會直接爆 runtime error

### 驗證

至少確認：

1. script 正常載入
2. panel 正常出現
3. `開始 / 暫停`
4. `儲存` 後重掃
5. debug 面板正常更新

---

## 第 2 輪：建立分類明確的 mutation 入口

### 目標

只為主要責任區建立 patch helper，不做雜亂 wrapper。

### 要做的事

建立這類 helper：

```js
function setConfigPatch(patch) { ... }
function setScanRuntimePatch(patch) { ... }
function setNotificationRuntimePatch(patch) { ... }
function setRouteRuntimePatch(patch) { ... }
function setUiRuntimePatch(patch) { ... }
function setSchedulerRuntimePatch(patch) { ... }
```

### 修改範圍

優先只改**寫入**路徑，不急著全部改讀取：

- `applySuccessfulScanRuntimeState()`
- `handleScanFailure()`
- `setLatestNotificationState()`
- `clearLatestNotificationState()`
- `syncCurrentRouteState()`
- `handlePanelDebugToggle()`
- timer / observer 安裝與清理

### 這一輪的關鍵標準

必須做到：

- 同類 state 的 mutation 走同一組入口
- 不同類 state 不共用同一個模糊 helper

### 不要做的事

- 不要做這種 helper：
  - `setRuntimeState(patch)`
  - `setPartialState(patch)`
- 不要為每個單欄位都造一個 setter

### 驗證

確認：

1. scan 成功後 panel/debug 狀態仍正常
2. scan 失敗時 `latestError` 仍正常
3. 手動測試通知時 `latestNotification` 顯示正常
4. route change 後狀態仍重置正常

---

## 第 3 輪：集中改寫 monitoring / scheduling 類 state

### 目標

把最容易再耦合回去的控制流程集中整理。

### 範圍

這一輪只處理：

- `paused`
- `scanTimer`
- `refreshTimer`
- `refreshDeadline`
- `routeTimer`
- `renderTimer`
- `observer`
- `isScanning`
- `isLoadingMorePosts`

### 要做的事

1. 把 monitoring control 相關函式統一改為只碰：
   - `config`
   - `schedulerRuntime`
   - `scanRuntime`
2. 檢查這些函式：
   - `pauseMonitoring()`
   - `resumeMonitoring()`
   - `restartMonitoringForCurrentGroup()`
   - `scheduleScan()`
   - `scheduleRefresh()`
   - `clearScanTimer()`
   - `clearRefreshTimer()`
   - `installObserver()`
   - `startMaintenanceLoops()`

### 核心目的

讓「控制流程」這件事不要再穿透到其他責任區。

### 驗證

至少確認：

1. `開始 / 暫停`
2. refresh 倒數更新
3. route change 後 observer 仍正常
4. panel 被 Facebook 重新掛載後仍能補回

---

## 第 4 輪：整理 scan / notification / UI 的讀寫邊界

### 目標

把最常見的 runtime state 讀寫規則拉直。

### 要做的事

#### 4.1 Scan runtime

集中到：

- `latestScan`
- `latestPosts`
- `latestError`

重點函式：

- `buildSuccessfulScanRuntimeState()`
- `applySuccessfulScanRuntimeState()`
- `handleScanFailure()`
- `getPanelStatusViewState()`
- `getPanelDebugViewState()`

#### 4.2 Notification runtime

集中到：

- `latestNotification`

重點函式：

- `setLatestNotificationState()`
- `clearLatestNotificationState()`
- `finalizeLatestNotification()`
- panel debug 顯示

#### 4.3 UI runtime

集中到：

- `panelMounted`

重點函式：

- `createPanel()`
- `ensurePanelMountedAndRender()`

### 驗證

至少確認：

1. 命中通知後 `最後通知狀態` 正常
2. debug 區塊顯示的 `latestScan` / `latestError` 正常
3. panel 被吃掉後仍能重建

---

## 第 5 輪：補測試與文件

### 目標

讓這輪 `STATE` 重構不是只靠人工回歸。

### 要做的事

#### 5.1 擴充 smoke test

優先補這些純邏輯或半純邏輯：

- `getPauseToggleAction()`
- config payload builder
- shortcut eligibility
- state patch helper 的基本行為

如果當時已把 patch helper 設計成可在 test mode 下安全呼叫，也可補：

- notification runtime patch
- scan runtime patch

目前已補上的範圍：

- `getPauseToggleAction()`
- `buildRefreshSettingsPayloadFromConfig()`
- `shouldUseTopPostShortcut()`
- `buildFailedScanRuntimeState()`
- `buildCompletedNotificationState()`
- `getLatestNotificationStatusLabel()`
- matcher / dedupe / notification formatting 相關 helper

#### 5.2 更新文件

至少更新：

- `docs/REFACTOR_PLAN.md`
- `docs/SCRIPT_TEMPLATE_GUIDE.md`
- `README.md`（如有必要）

補充內容：

- `STATE` 現在的分類方式
- 為什麼沒有引入完整 state framework
- 哪些 mutation 入口是模板中值得沿用的做法

---

## 7. 執行時要遵守的限制

這份重構若真的開始做，請遵守以下限制：

### 7.1 每一輪只做一類事

例如：

- 只改 shape
- 只改 mutation
- 只改 scheduler

不要混做。

### 7.2 每一輪都要能回到可用狀態

不接受「做到一半先放著，下輪再補」。

### 7.3 每一輪都跑 smoke test

指令：

```powershell
& 'C:\Program Files\nodejs\node.exe' '.\scripts\smoke_check_userscript.js'
```

### 7.4 每一輪都要手動測最少項目

最少手動驗證：

1. panel 是否正常
2. `開始 / 暫停`
3. `儲存` 後重掃
4. 命中通知
5. debug 面板

### 7.5 每一輪都要做單一主題 commit

不要把：

- `STATE` 重構
- selector 修正
- 文件改寫
- UI 微調

混成同一個 commit。

---

## 8. 這份計畫何時值得啟動

不是現在立刻就必做。  
以下情況出現時，這份計畫才真正值得啟動：

### 8.1 適合啟動的訊號

- 又要新增一組明顯會碰到多個 state 區域的新功能
- `STATE.xxx` 寫入點開始重新擴散
- debug / notifier / scan 的狀態來源變得難追
- 未來新腳本真的打算複製這套 state 管理方式

### 8.2 不適合啟動的時機

- 只是要修 selector
- 只是要補小 bug
- 只是要調 README
- 只是要補一個小通知通道

這些都不值得順手開 `STATE` 重構。

---

## 9. 建議的 commit 切法

若未來真的執行，建議至少切成以下 commit：

1. `refactor(tampermonkey): 重新整理 STATE 區塊分類`
2. `refactor(tampermonkey): 收斂 state mutation 入口`
3. `refactor(tampermonkey): 收整 monitoring 與 scheduler runtime`
4. `refactor(tampermonkey): 收整 scan 與 notification runtime`
5. `test(docs): 補 STATE 重構 smoke test 與文件`

---

## 10. 一句話總結

這份 `STATE` 重構不應該是零碎的小修，而應該是：

> 一次完整、分階段、可驗證的單檔 state 邊界整理工程。

如果未來真的要做，就照這份計畫完整執行；如果沒有時間完整做完，寧可先不動。
## 0. 目前狀態

這份文件原本是重構前的分輪計畫。
目前 `refactor/state-phase1-shape` 分支已完成第 1 到第 5 輪，實際落地內容包含：

- `STATE` 已改為 `config / scanRuntime / notificationRuntime / routeRuntime / uiRuntime / schedulerRuntime / sessionRuntime`
- 已補上分類明確的 state mutation patch helper
- monitoring / scheduler 的 timer 與 observer handle 已集中管理
- scan / notification / panel runtime 已補上較清楚的 orchestration helper
- smoke test 已擴大到 control semantics、policy 與部分 runtime 純邏輯 helper

之後若再開下一輪 `STATE` 重構，應把這份文件視為「歷史計畫 + 後續檢查表」，而不是重新從第 1 輪開始。
