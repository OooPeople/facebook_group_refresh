# `facebook_group_refresh.user.js` 最新版架構再評論

針對以下最新版本進行 review：

- Repo: `OooPeople/facebook_group_refresh`
- File: `src/facebook_group_refresh.user.js`

這份 review 的評估前提與之前相同，而且我會刻意再強調一次，因為這會影響整份評論的基準：

1. 這是一支 **Tampermonkey userscript**
2. 因此 **單檔** 不是缺點，而是合理的部署形式
3. 評估重點不是「為什麼不拆多檔」，而是：
   - 在單檔限制下，內部結構是否持續成熟
   - `STATE` 是否真的從「共享大物件」進一步進化成較穩定的分層模型
   - 新功能加入後，是否仍能維持低耦合與可讀性

---

## 一、總評

這次再看最新版，我的評價比上一輪更正面，而且差距不是小修小補，而是**架構成熟度真的再往前走了一步**。

目前我的總結是：

- **維護性：8.5/10**
- **可擴充性：7.5/10**
- **整體判斷：已經接近「穩定可長期維護」的單檔 userscript 架構**

如果上一輪我會說：

> 你已經開始有 state discipline

那這一輪我會說：

> 你已經把 state discipline 具體落地了，而且還補上了 config use case、monitoring semantics、UI runtime 建模與 panel 拖曳狀態這些細節。

也就是說，這版不只是比之前整齊，而是更像一個有一致規則的系統。

---

## 二、這次最重要的架構進步

## 1. `STATE` 分層終於真正落地

這一版最大的變化，就是 `STATE` 已經從平面共享物件，明確切成：

- `config`
- `scanRuntime`
- `notificationRuntime`
- `routeRuntime`
- `uiRuntime`
- `schedulerRuntime`
- `sessionRuntime`

這件事的價值非常大。

### 為什麼這很重要
之前雖然你已經開始有「scan state」「route state」「UI state」的概念，但還是比較偏 conceptual 分層，也就是：

- code 裡有 builder
- 某些欄位有 grouping 意圖
- 但整體 state 仍然比較平

現在不同了。  
你已經直接把不同生命週期與不同責任的狀態放進不同 runtime bucket。

### 這帶來的實際好處

#### (1) 可讀性更高
現在看到 `STATE.scanRuntime.latestScan`，你會很清楚它屬於「掃描結果」。  
看到 `STATE.schedulerRuntime.refreshDeadline`，也能立刻知道它是排程控制狀態。

#### (2) 新增 state 時更不容易亂放
這非常重要。  
以前若要新增一個狀態欄位，容易直接塞進 `STATE` 最上層。  
現在至少你會先問自己：

- 這是 UI runtime？
- route runtime？
- scan runtime？
- session runtime？

這種「先分類再放置」的習慣，本身就是架構成熟度的表現。

#### (3) reset / teardown 更容易設計
之後如果你要：
- route transition reset
- soft reset
- panel-only reset
- scheduler cleanup

都會比平面結構更容易下手。

---

## 2. 你建立了明確的狀態更新入口

這版另一個很大的進步，是你開始用一組一致的 patch helper 收斂狀態更新：

- `setConfigPatch`
- `setScanRuntimePatch`
- `setNotificationRuntimePatch`
- `setRouteRuntimePatch`
- `setUiRuntimePatch`
- `setSchedulerRuntimePatch`
- `setSessionRuntimePatch`

### 這件事的價值
它不只是少打一點 `STATE.xxx = ...`，而是代表：

> 你不希望不同區塊任意散寫 state，而是希望 state 更新有固定入口。

這跟很多大型專案裡的 state mutation discipline 很像，只是你這裡是用 userscript 友善的輕量版本來做。

### 為什麼這比之前更好
前一版雖然已經有 `build...State()` / `apply...State()`，但更新入口還不夠完整。  
這版則是補上「底層 patch helper + 上層 use case / apply helper」兩層結構。

也就是說，現在你的 state 更新不是只有：

- 建立結果
- 套用結果

而是也有：

- 統一 patch 入口
- 明確 runtime bucket
- 局部 state reset helper

這比之前更穩。

---

## 3. `config` 更新路徑比上一輪成熟非常多

這一輪我最明顯感受到的提升，就是 `config` 這條線真的變乾淨了。

你現在不只是有 `CONFIG_FIELD_DEFINITIONS`，還進一步加了：

- `CONFIG_GROUP_DEFINITIONS`
- `getConfigFieldDefinition`
- `getConfigGroupFields`
- `loadPersistedConfigField`
- `loadPersistedConfigGroup`
- `persistConfigFieldValue`
- `persistConfigGroup`

以及最重要的 use case / patch 分層：

- `buildKeywordConfigPatch`
- `buildRefreshConfigPatch`
- `buildNotificationConfigPatch`
- `buildMonitoringConfigPatch`
- `buildUiConfigPatch`

再加上：

- `applyKeywordConfigPatch`
- `applyRefreshConfigPatch`
- `applyNotificationConfigPatch`
- `applyMonitoringConfigPatch`
- `applyUiConfigPatch`

### 這組結構為什麼重要
它解決的是我前一輪最在意的問題：

> `STATE.config` 雖然變薄了，但更新路徑還沒有真正收斂。

現在你已經開始讓 config 更新具備這些特性：

1. 有分類
2. 有正規化
3. 有 persistence 路徑
4. 有 apply 層
5. 有 UI use case 對應

這代表你不再只是「把 config 放在 `STATE` 裡」，而是開始把它當成正式的設定模型來管理。

---

## 4. `INTERNAL_CONFIG` 的出現是正確的決策

這版我很喜歡的一個改動是：

- `loadMoreMode` 不再繼續混在正式對外 config 裡
- 而是被放進 `INTERNAL_CONFIG`

這是一個非常好的決策。

### 為什麼這麼做是對的
因為之前 `loadMoreMode` 有一點「看起來像配置，但實際上不是完整配置」的問題。  
那種狀況最麻煩，因為會造成 state model 的語義鬆動：

- 看起來可以改
- 但實際上 UI 沒提供
- 持久化不完整
- 邏輯上也未必真的支援完整配置生命週期

現在把它移進 `INTERNAL_CONFIG`，就代表你開始明確區分：

- **使用者可配置**
- **系統內部策略**

這個內外邊界意識，是成熟架構的一個重要特徵。

---

## 5. Monitoring semantics 變得明確很多

這次最值得肯定的改動之一，是你把「開始 / 暫停 / 重新開始」的語義切乾淨了。

你現在有：

- `getMonitoringControlAction()`
- `getMonitoringControlLabel()`
- `setPausedState()`
- `pauseMonitoring()`
- `resumeMonitoring()`
- `resetSeenBaselineForCurrentGroup()`
- `restartMonitoringForCurrentGroup()`
- `performPanelMonitoringAction()`

### 這為什麼重要
因為上一輪我最特別提醒的一點，就是：

> 原本「開始」的實作，其實很像 restart，不只是單純 resume。

那種語義模糊很危險，因為你之後自己也容易搞混：
- 這個按鈕是在恢復排程？
- 還是在清空基準重新監控？
- 還是兩者同時做？

現在這個問題被修得不錯。  
`resume` 與 `restart` 被分開，`resetSeenBaselineForCurrentGroup()` 也獨立出來，這讓後續調整會安全很多。

---

## 6. `uiRuntime` 的存在讓 UI 行為也納入狀態模型

這次新增的另一個進步，是你沒有只在 scan engine 與 config 管理上進化，而是把 UI 行為也納入比較一致的 state 模型。

尤其是：

- `panelPosition`
- `panelDrag`
- `buildIdlePanelDragState()`
- `setPanelPositionState()`
- `setPanelDragState()`
- `normalizePanelPosition()`
- `clampPanelPosition()`
- `buildDraggedPanelPosition()`

### 這件事的價值
很多 userscript 一做 UI 拖曳，就會變成：

- 在 DOM handler 內直接算位置
- 直接改 `style.left/top`
- 順便持久化
- 邏輯與 DOM 完全纏在一起

你這版沒有這樣做。  
你是先把「拖曳中狀態」與「panel 位置狀態」建出來，再讓 DOM handler 去驅動它。

這種做法很好，因為它保持了你整支腳本目前的一致設計語言：

> 先有 state model，再有 UI interaction

這表示你不只是 scan 有 discipline，連 UI 行為也開始有 discipline。

---

## 7. Snapshot / view state 層比之前更完整

你前一輪已經有 panel view state builder，這一輪則更穩了。

像這一組：

- `buildPanelRuntimeSnapshot()`
- `getPanelViewState(runtimeSnapshot)`
- `getPanelStatusViewState(...)`
- `getPanelDebugViewState(...)`

這種做法的價值，在這版比之前更明顯，因為你現在 panel 顯示的東西更多了：

- latest scan 統計
- latest notification 狀態
- monitoring 狀態語義
- refresh 倒數
- debug 區塊
- panel 位置同步後的 render

沒有 snapshot / view state，render 很容易失控。  
你現在把這層保住了，這是非常正確的。

---

## 三、這次架構成熟的核心原因

如果要更抽象地說，這一版之所以讓我評價上升，不是因為單純多了幾個 helper，而是因為你開始同時守住三件事：

## 1. 邊界感更強
你開始明確區分：

- config vs internal config
- runtime vs persistence
- UI runtime vs scheduler runtime
- resume vs restart
- panel state vs DOM style
- state snapshot vs render HTML

這些邊界感，遠比多一點函式更重要。

## 2. 更新路徑更一致
以前比較像：
- 有些地方直接改 `STATE`
- 有些地方建 state
- 有些地方直接存 storage

現在比較像：
- 先 patch / build
- 再 apply
- 再必要時 persist
- 再 render / reschedule

一致性高很多。

## 3. 你開始不是在整理 code，而是在整理系統規則
這是這次最重要的質變。

以前比較像「把巨型腳本切乾淨」。  
現在比較像「替腳本建立一套持續成長時仍能維持秩序的規則」。

這就是為什麼我會說，這次已經更接近真正可長期維護的狀態。

---

## 四、目前仍然存在的問題

雖然這版很不錯，但還不是完全沒有風險。以下是我認為目前最值得注意的幾點。

## 1. `set...Patch()` 目前仍然偏薄，本質還是 `Object.assign`

這是我目前最主要的結構提醒。

像：

- `setConfigPatch`
- `setScanRuntimePatch`
- `setNotificationRuntimePatch`
- `setRouteRuntimePatch`
- `setUiRuntimePatch`
- `setSchedulerRuntimePatch`
- `setSessionRuntimePatch`

目前本質都還只是：

- 接 patch
- `Object.assign(...)`

### 問題不在於它簡單
簡單本身不是問題。  
問題在於：**如果未來所有地方都直接開始呼叫這些 `set...Patch()`，那它們就只會變成語法糖，而不是規則層。**

### 也就是說
現在你已經建立了狀態更新 discipline，但還沒有完全建立「誰應該呼叫哪一層更新 API」的使用紀律。

### 最理想的方向
我會建議未來慢慢形成這個層級：

#### 第 1 層：最底層 patch helper
只當作基礎設施存在，不鼓勵一般業務邏輯直接大量使用。

#### 第 2 層：有語義的 apply / use case
例如：
- `applyKeywordConfigPatch`
- `applyRefreshConfigPatch`
- `pauseMonitoring`
- `resumeMonitoring`
- `restartMonitoringForCurrentGroup`

#### 第 3 層：UI / lifecycle orchestration
例如：
- panel button handler
- modal save handler
- route transition handler

現在你已經有這個架構雛形，但還要注意不要讓後續需求直接繞回 `set...Patch()`。

---

## 2. 還有少數資料結構直接 mutate，風格尚未完全一致

最明顯的例子是：

- `STATE.sessionRuntime.initializedGroups.add(groupId)`

### 這是不是錯
不一定。  
因為 `Set` 本來就不像 plain object 那麼容易走 immutable / patch 風格。

### 但它透露了一個訊號
現在你的 state 更新紀律已經建立起來了，可是仍有部分結構在例外處理。  
這不是立即性的 bug，但表示你的架構還沒完全統一。

### 長期風險
如果未來再新增：
- `Map`
- `Set`
- nested mutable container

很可能會再次出現：
- 有些 state 走 patch helper
- 有些 state 直接 mutate
- 有些 state 要特別記住它不是普通物件

### 建議
目前不一定要改，但值得在心中記住這個風格分裂點。  
未來若 session data 再長大，這塊可能要再收斂。

---

## 3. 有些「讀設定」的動作仍帶有副作用

這是目前我第二個比較想提醒的點。

像這些情況：

- `sendNtfyNotification()` 先 `getPersistedNtfyTopic()` 再 `applyNotificationConfigPatch(...)`
- `sendDiscordWebhookNotification()` 類似
- `openSettingsModal()` 會重新從 persisted 值 patch 回 config

### 為什麼這會讓人遲疑
因為直覺上，讀設定與寫 state 應該是不同類型的動作：

- **讀設定**：應該盡量無副作用
- **同步狀態**：才是顯式的寫入行為

現在你這些地方做的事比較像：

> 我先去持久化層讀最新值，再順手把 runtime config 校正回來

這在 userscript 中不是不能做，但會讓函式的語義變得稍微混合。

### 長期風險
之後你回頭看 code 時，可能會出現這種理解成本：

- 為什麼通知發送函式也會動 config？
- 為什麼打開設定視窗也會 patch runtime？
- 這到底算 hydration 還是 state update？

### 我建議的方向
如果未來還要再收斂，我會傾向：

- 將 config hydration 做成明確動作
- 將 read persisted value 與 apply runtime state 分開

例如：
- 啟動時 hydration
- 開 modal 前 hydration
- 通知發送時單純讀當前已經 hydration 的 config

這樣邏輯會更乾淨。

---

## 4. Scan engine 仍然是全檔最重的區塊

這點其實是正常的，因為你的核心難題就是在：

- Facebook DOM 抽取
- top-post shortcut
- seen-stop
- 跨視窗累積
- 去重
- 通知判定

### 所以這不是批評它複雜
而是提醒你：

> 這裡仍然是未來最容易吸附新需求、最容易重新變胖的地方。

即使你現在已經把很多東西拆開了，例如：

- `collectScanPosts`
- `createScanExecutionContext`
- `collectScanExecutionData`
- `commitScanState`
- `buildSuccessfulScanRuntimeState`
- `applySuccessfulScanRuntimeState`

這條線還是很容易在未來加入新需求時被直接塞東西進去。

### 典型風險
未來如果再加：
- 新 shortcut
- 新過濾規則
- 新 debug 資訊
- 新通知行為
- 新 fallback extraction

很容易又回到 scan engine 這一段。

### 建議
這裡目前不是要重寫，而是要持續維持紀律：

- scan orchestration 只做編排
- 抽取 / 判斷 / 統計 / commit 各自維持獨立 helper
- 新特例不要直接塞進主幹函式

---

## 5. UI 與 state 現在很接近成熟，但 DOM 操作仍不可避免地偏多

這是 userscript 的現實限制，不是你特別做錯。

你已經很努力把：
- view state
- panel runtime
- drag state
- modal refs

做出結構化處理。

但本質上因為這是 userscript，UI 還是會維持：
- 手寫 DOM
- `querySelector`
- `innerHTML`
- inline style
- event binding

### 這代表什麼
代表你的 UI 層已經很乾淨了，但它天然就不會像 React / Vue 那種宣告式 UI 一樣安全。

### 所以你現在真正要守住的不是「再抽更多 UI helper」
而是：
- 不要讓 UI 事件直接回頭污染業務 state
- 不要讓 render 又開始自己做 domain 判斷
- 不要讓 DOM 操作與 runtime persistence 混在一起

目前這版大致守得還不錯。

---

## 五、這版最值得肯定的設計決策

如果要挑幾個我最想你保留的核心原則，我會列這些。

## 1. 正式 config 與 internal config 分離
這件事非常值得繼續維持。

## 2. 有語義的 monitoring action
`pause` / `resume` / `restart` 這種語義清楚的 use case 非常有價值。

## 3. runtime bucket 分層
這是目前整體架構提升的根本原因之一。

## 4. view state builder
請繼續保留，不要回頭讓 render 直接吞 raw runtime。

## 5. UI drag state 也走狀態模型
這代表你不是只在 scan engine 上講究結構，而是全域都在往一致性前進。

---

## 六、如果再往上走一步，最推薦的優先順序

如果你之後還想繼續優化，而不是停在目前版本，我建議的順序如下。

## 優先級 1：限制 `set...Patch()` 的直接使用範圍

### 目標
不是刪掉它們，而是讓它們更偏向內部基礎設施，而不是讓一般業務邏輯廣泛直接呼叫。

### 理想方向
未來新功能優先走：
- `apply...Patch()`
- `...Monitoring()`
- `...UseCase()`

而不是直接：
- `setConfigPatch(...)`
- `setScanRuntimePatch(...)`

這能讓「狀態更新規則」更穩。

---

## 優先級 2：把 hydration 與讀取副作用再切乾淨

### 目標
避免像通知發送或 modal 開啟函式，同時兼具：
- 讀 persisted value
- patch runtime config

### 理想方向
建立更清楚的 hydration 場景，例如：
- startup hydration
- modal-open hydration
- route hydration（若需要）

而不是讓各個 read path 自己順手 patch。

---

## 優先級 3：處理 `Set` / `Map` 類型狀態的一致性

### 目標
降低「有些 state 走 patch helper，有些直接 mutate」的風格混用。

### 理想方向
不一定要全面 immutable，但至少可建立小型 helper，例如：
- `markGroupInitialized(groupId)`
- `isGroupInitialized(groupId)`

讓外部不要直接碰 `initializedGroups.add(...)`

---

## 優先級 4：持續保護 scan orchestration 不變胖

### 目標
讓之後新增規則、統計或 shortcut 時，仍然往 helper 層加，而不是回塞進主幹函式。

---

## 優先級 5：若未來功能再擴大，可考慮「單檔內次級命名空間」

目前你仍然不需要拆多檔。  
但若再長下去，可以考慮用更清楚的段落命名或物件封裝，例如：

- `ConfigUseCases`
- `ScanRuntimeActions`
- `PanelUiActions`
- `SchedulerActions`

即使仍然單檔，也能再進一步降低平面感。

---

## 七、簡化後的一句結論

如果我要用一句話總結這次最新版：

> 你這支腳本已經從「有模組化思維的單檔腳本」，進一步長成「有 state discipline、config discipline、UI discipline 的單檔系統」。

這次的進步不是 cosmetic，而是規則層面的進步：

- state 分層真的落地
- config path 真的收斂
- internal / external config 邊界更清楚
- monitoring 語義更明確
- UI runtime 也被納入狀態模型

目前最大的剩餘風險，不再是「架構亂」，而是：

1. patch helper 會不會重新被當成萬用入口
2. hydration 與讀取副作用是否還能再收斂
3. scan engine 是否能持續維持紀律

換句話說，你現在已經離「救火式重構」那個階段很遠了。  
現在你做的是比較高階的事：

> 維持設計紀律，避免系統在繼續長大後重新失序。

---

## 八、最終評價

### 我對這版的最終評語是：

**這版是明顯成功的進一步演化。**

它比上一輪更成熟的地方不只是「多了幾個 helper」，而是你真的做到了這幾件事：

- 把 state 分類變成真正的資料結構
- 把 config 更新變成正式 use case 路徑
- 把 UI runtime 也納入模型管理
- 把 monitoring 行為語義化
- 把 internal config 從 public config 中分離

這種演化是很有價值的，而且方向正確。

### 目前如果我要給一句最直接的總結
我會這樣說：

> 你現在這份 `facebook_group_refresh.user.js`，已經不再只是維護得不錯的 Tampermonkey 腳本，而是具備明確狀態邊界與更新紀律的單檔應用。

只要你接下來守住目前建立好的規則，不讓新需求重新把副作用塞回 scan / config / UI 主幹，這份腳本可以再長一段時間，仍維持相當不錯的可維護性。
