# 重構規劃

本文件整理 `src/facebook_group_refresh.user.js` 的重構方向，目標是在維持 Tampermonkey 單檔部署前提下，逐步降低耦合、縮小主流程責任，並保留目前可運作的功能。

## 重構目標

- 最終產物仍然是一支 `.user.js`
- 先改善結構，再考慮外觀上的模組化
- 優先處理高風險、高耦合區塊
- 每一步都盡量維持既有功能行為不變
- 重構期間凍結 selector / extractor 策略，避免把結構改動與 Facebook DOM 風險混在一起

## 重構前錨點

- Git 錨點 commit: `6a7771c6beec56f75958db040df7b57d3820ef47`
- 用途: 作為本輪重構的回退基準

## 已完成項目

### 1. 掃描主流程、狀態摘要與資料整理已先切乾淨

已完成的重點：

- `runScan()` 已拆成較薄的協調流程，核心步驟拆為：
  - `createScanExecutionContext()`
  - `collectScanExecutionData()`
  - `markGroupInitializedAfterScan()`
  - `buildSuccessfulScanRuntimeState()`
  - `applySuccessfulScanRuntimeState()`
  - `handleScanFailure()`
  - `createEmptyCollectedResult()`
  - `collectScanPosts()`
  - `buildPostScanSummary()`
  - `shouldNotifyScanSummary()`
  - `summarizeScanPosts()`
  - `commitScanState()`
  - `notifyMatchesAndMarkSeen()`
  - `addMatchesToHistory()`
  - `markSummariesSeen()`
  - `getLatestSeenMapForGroup()`
  - `buildLatestPostsState()`
  - `buildLatestScanState()`
- 關鍵字解析、去重鍵與通知格式化也開始抽出較穩定的純邏輯 helper：
  - `buildKeywordRule()`
  - `matchesKeywordRule()`
  - `buildPostKeyFragments()`
  - `buildCompositePostKey()`
  - `collectUniquePostsByKey()`
  - `buildCompactNotificationSegments()`
  - `buildRemoteNotificationLines()`
- top-post shortcut 的判斷與 cache-hit 套用也開始拆出固定入口：
  - `buildTopPostShortcutContext()`
  - `getTopPostShortcutBypassReason()`
  - `applyTopPostShortcutCacheHit()`
  - `resolveTopPostShortcutResult()`
- scan meta 的欄位標準已集中到 `normalizeCollectedMeta()`，並由：
  - `createEmptyCollectedResult()`
  - `collectVisiblePostsOnly()`
  - `collectPostsAcrossWindows()`
  - `buildLatestScanState()`
  共用
- scan meta 的單視窗組裝與累加手勢也已開始收斂：
  - `buildSingleWindowCollectedMeta()`
  - `accumulateCollectedMetaCounts()`
- 跨視窗掃描 orchestration 已再往下拆：
  - `createWindowCollectionContext()`
  - `collectCurrentWindowPosts()`
  - `mergeWindowPostsIntoAccumulated()`
  - `updateWindowCollectionMeta()`
  - `getWindowCollectionStopReason()`
  - `performConfiguredLoadMore()`
  - `finalizeWindowCollectionResult()`
  - `collectCurrentWindowOnlyResult()`
- `latestScan -> panel/debug` 的摘要欄位映射已開始共用：
  - `buildLatestScanViewState()`
- extractor / UI 內散落的固定 DOM 規則與文字片段也開始集中：
  - `SELECTORS`
  - `TEXT_PATTERNS`
- store 與通知通道的固定定義也開始集中：
  - `STORE_DEFINITIONS`
  - `NOTIFICATION_CHANNEL_DEFINITIONS`
- extractor 內重複的 regex / selector traversal 手勢也開始共用：
  - `REGEX_PATTERNS`
  - `getSelectorElementsByOrder()`
  - `findFirstSelectorResult()`
  - `collectUniqueTextSnippets()`
  - `extractFirstPatternMatch()`
- `seenPosts` / `matchHistory` 的排序、合併、裁切邏輯已獨立：
  - `trimSeenPostGroupStore()`
  - `buildSeenPostsStoreForGroup()`
  - `getSeenPostGroupStore()`
  - `setSeenPostGroupStore()`
  - `getMatchHistoryLimit()`
  - `normalizeMatchHistoryEntries()`
  - `getLatestNotificationStore()`
  - `setLatestNotificationStore()`
  - `setLatestNotificationState()`
  - `clearLatestNotificationState()`
  - `sortMatchHistoryEntries()`
  - `flattenLegacyMatchHistoryStore()`
  - `buildIncomingMatchHistoryEntries()`
  - `mergeMatchHistoryEntries()`
- group-scoped snapshot / post-list 持久化也開始走共用入口：
  - `getGroupStoreValue()`
  - `getNamedGroupObjectValue()`
  - `setNamedGroupObjectValue()`
  - `buildLatestTopPostSnapshot()`
  - `normalizeStoredPostList()`
  - `loadNamedObjectStore()`
  - `saveNamedObjectStore()`
  - `loadNamedJsonStore()`
  - `saveNamedJsonStore()`
- 單檔模組區塊也已整理成較明確的區段：
  - `Storage / Config`
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
- 最小 Node smoke test 與 test hook 已建立：
  - `scripts/smoke_check_userscript.js`
  - `__FB_GROUP_REFRESH_TEST_HOOKS__`

目前效果：

- 單檔內部已開始用明確的區塊分段整理成 `Storage / Config`、`Text / Common Utils`、`Matcher / Rules`、`Page Context / Scheduling`、`Extractor / DOM Collection`、`Post Parsing / Notification Formatting`、`Persistence / Dedupe / History`、`Scan Engine`、`Notifier`、`UI / Modal`、`Lifecycle / Observer`，閱讀路徑更接近模組化應用。
- `runScan()` 比較像流程協調器，而不是把掃描、比對、通知、state 寫回全塞在同一層。
- `runScan()` 也開始把「建立掃描 context」、「執行 scan data pipeline」、「套用成功狀態」、「錯誤收尾」明確分層，主流程責任比前一階段更薄。
- `latestScan` 與 panel / debug 共用的 scan summary 形狀更一致。
- `markPostSeen()` 與 `addMatchHistory()` 的責任邊界更清楚，後續若要補測或調整策略，切入點比較穩定。
- `commitScanState()` 也開始把「通知新命中」、「寫入歷史」、「補標全量 seen」與「取回最新 seen map」拆開，成功收尾階段的責任比前一階段更單純。
- 單篇貼文的 summary 建立與是否進通知佇列的判斷也開始有固定入口，matcher / scan 的邊界比前一階段更清楚。
- `parseKeywordInput()`、`matchRules()`、`getPostKey()`、`dedupeExtractedPosts()`、通知文字格式化等穩定邏輯也開始共用更小的 helper，後續補 Node 級檢查時切入點更直接。
- smoke test 目前也已開始覆蓋控制語義與 policy 層，例如 `開始 / 暫停` 的 restart 語義、top-post shortcut eligibility，以及 refresh 設定 payload 的欄位對齊與裁切。
- selector / extractor 的固定規則開始從函式內硬編碼轉成集中常數，後續要檢查或調整 DOM 規則時比較容易盤點。
- extractor 內 selector 走訪、文字片段收集與 regex 命中順序也開始有共用入口，後續若要補更多 DOM 變體，變更點更集中。
- `collectPostsAcrossWindows()` 已比較接近 orchestration shell，視窗收集、累積去重、停止條件與 load-more 動作各自有獨立入口。
- `seenPosts` 也開始有自己的群組 bucket facade，讀寫界線比之前清楚。
- top-post shortcut 這條快篩分支也開始從主函式內拆出決策與 cache-hit 套用點，後續若要檢查 shortcut 行為，比以前更容易定位。
- `matchHistory` 的讀寫也開始走正規化入口，舊格式攤平、排序與裁切不再分散在 get/set 兩側各自維護。
- storage key 與 object/json store 類型也開始有固定 registry，之後若補更多持久化欄位，比較不需要再散改 raw key。
- `latestNotification` 已開始同時具備 runtime state 與 persistence facade，通知狀態的更新路徑更集中。
- 單檔模組區塊整理這件事已經從「規劃中的命名整理」進展到實際可讀的分段結構，不再只是停留在假模組化命名層。
- 穩定純邏輯也已有最小 Node 級 smoke test 可驗，後續若補更多測試案例，可以直接延伸現有基礎。
- permalink 抽取目前已恢復為正式主路徑，並採用「permalink anchor 優先 + canonicalization + 最小 warmup」策略。
- `STATE` 的後續收口已另立 [`STATE_REFACTOR_PLAN.md`](./STATE_REFACTOR_PLAN.md)，避免把主重構盤點與 state 專題重構混在同一份文件裡。

### 2. lifecycle 與 scheduler 的入口已收斂

已完成的重點：

- lifecycle / scheduler 收尾 helper：
  - `requestPanelRender()`
  - `rescheduleRefreshAndRender()`
  - `reinstallObserverAndScheduleScan()`
  - `resetRouteScanState()`
  - `handleRouteTransition()`
  - `ensurePanelMountedAndRender()`
  - `syncCurrentRouteState()`
  - `bootstrapAppRuntime()`
  - `startMaintenanceLoops()`
- 後續又補了較低風險的共用 helper：
  - `clearScanTimer()`
  - `loadObjectStore()`
  - `loadRefreshConfigOverrides()`
  - `buildRefreshSettingsPayload()`

目前效果：

- `renderPanel()`、`refresh`、`scan`、`route-change` 的收尾不再散落在各處。
- startup / route-change / pause 這些常見路徑比較一致。
- storage 與 timer cleanup 的膠水邏輯開始有共用基礎，後續比較不容易各自漂移。
- refresh 設定的讀寫欄位也開始走固定 payload，不再分散在 `loadConfig()` / `persistRefreshConfig()` 兩側各自維護。

### 3. 主面板與設定視窗的資料流已整理成 UI orchestration

已完成的重點：

- panel render/view-state/section render：
  - `getPanelViewState()`
  - `getPanelStatusViewState()`
  - `getPanelDebugViewState()`
  - `buildLatestScanViewState()`
  - `buildPanelPostListEntryViewState()`
  - `buildPanelPostListViewState()`
  - `buildPanelDebugPostViewState()`
  - `buildPanelDebugPostRowsViewState()`
  - `renderPanelShellHtml()`
  - `buildPanelStatusRows()`
  - `buildPanelDebugSummaryRows()`
  - `renderPanelPostListHtml()`
  - `renderPanelPostListEntryHtml()`
  - `renderPanelStatusHtml()`
  - `renderPanelDebugPostRowsHtml()`
  - `renderPanelDebugPostRowHtml()`
  - `renderPanelDebugHtml()`
  - `bindDebugCopyButton()`
  - `renderHistoryFieldRows()`
  - `renderDebugTextRow()`
  - `renderDebugTextRows()`
- panel update helper：
  - `getPanelElementRefs()`
  - `syncPanelKeywordInputs()`
  - `updatePanelControls()`
  - `updatePanelStatusSection()`
  - `updatePanelDebugSection()`
- panel action handler：
  - `savePanelKeywordSettings()`
  - `handlePanelSave()`
  - `handlePanelPauseToggle()`
  - `handlePanelDebugToggle()`
  - `bindPanelEventHandlers()`
- settings modal draft flow：
  - `getSettingsModalElementRefs()`
  - `readSettingsModalDraft()`
  - `applySettingsModalDraft()`
  - `populateSettingsModalFields()`
  - `handleSettingsTestNotification()`
  - `handleSettingsSave()`
  - `ensurePanelRelatedModalsCreated()`
  - `renderSettingsModalShellHtml()`

目前效果：

- `renderPanel()`、`createPanel()`、`openSettingsModal()` 都更接近 orchestration shell。
- 主面板的 `儲存`、`開始 / 暫停`、`除錯` 與設定視窗的讀寫流程都已有固定入口。
- `STATE.config` 的主要更新路徑也已開始收斂成 keyword / refresh / notification / monitoring / UI 幾類 use case helper，而不是每個 event handler 自己決定怎麼改 state 與落盤。
- panel/status/debug 的字串殼層與 row 組裝也開始分離，後續若要調整欄位或重刷範圍，不需要再回頭修改長段模板。
- panel status/debug 的欄位順序、單筆列渲染與 row builder 也已各自有固定入口，debug 區塊後續再增減欄位時風險更低。
- `latestScan` 的欄位 fallback 與 label 映射也開始有單一入口，status/debug 顯示不容易各自漂移。
- panel/debug 的貼文列表也開始先轉成 view state，再交給 render 層輸出，UI 對 raw runtime post shape 的耦合又再降一層。
- 後續若要再縮小重刷範圍或拆 UI 區塊，切入點已經比一開始清楚很多。
- 半正式配置也已再收斂一層，像固定 load-more mode 這類 internal-only capability 不再掛在正式 `config` 下面。

### 4. modal 與 overlay 相關 UI 共用層已開始成形

已完成的重點：

- 歷史紀錄 modal 的內容渲染：
  - `getHistoryModalElementRefs()`
  - `renderEmptyHistoryHtml()`
  - `renderHistoryEntryHtml()`
  - `renderHistoryModalContentHtml()`
  - `bindHistoryModalEventHandlers()`
  - `renderHistoryModalShellHtml()`
- overlay 顯示切換 helper：
  - `setOverlayVisibility()`
  - `showOverlayById()`
  - `hideOverlayById()`
  - `createOverlayElement()`
- 多個 help modal 的共用骨架：
  - `createHelpModalShell()`
  - `HELP_MODAL_DEFINITIONS`
  - `createHelpModal()`
  - `openHelpModal()`
  - `createAllHelpModals()`
- 設定視窗 modal 的事件綁定：
  - `bindSettingsModalEventHandlers()`

目前效果：

- `openHistoryModal()` 已比較接近單純的開啟與填內容流程。
- 多個 modal 的開關行為不再各自重複寫一份。
- include / ntfy / Discord 三個 help modal 也開始共用同一套 shell。
- help modal 本體內容也開始從平行函式改成 definition-driven，後續若再新增說明視窗，擴充點更固定。
- help modal 的事件綁定也開始直接走通用 `openHelpModal()` 入口，不再維護多組薄 wrapper。
- history / settings modal 的 DOM 建立與事件 wiring 也比之前分得更開。
- history、settings 與 help modal 的 overlay 建立方式已開始共享同一個基礎入口。
- panel、settings、history、help modal 之間開始共享同一層 UI overlay 基礎。

### 5. 通知流程與非現役功能區已明確分流

已完成的重點：

- `notifyForPost()` 的通知 orchestration helper：
  - `createPendingNotificationState()`
  - `buildNotificationPayload()`
  - `sendGmDesktopNotification()`
  - `appendNotificationStatus()`
  - `finalizeLatestNotification()`
  - `buildNotificationChannelRunnerMap()`
  - `createNotificationChannelTask()`
  - `createNotificationChannelTasks()`
  - `collectNotificationStatusParts()`
- 非現役或 internal-only 能力已明確標示：
  - permalink extraction: `enabled`
  - timestamp extraction: `removed`
  - browser-native notification: `removed`

- 通知端點的 storage hydration 已收斂為共用入口，settings modal 與 notifier 目前不再各自散讀 storage。
- 主面板目前已支援拖曳、位置持久化與 viewport 邊界夾制，對應的 UI interaction state 已落入 `uiRuntime`。

目前效果：

- `notifyForPost()` 更接近單純的流程協調器，各通道結果如何累積到狀態摘要也更明確。
- 閱讀者比較容易分辨哪些能力是正式現役流程，哪些只是保留中的實驗或內部選項。
- 通知通道的執行順序與 skipped-status 規則也開始集中，未來若增減通道，不需要再直接改動 `notifyForPost()` 本體。
- 通知通道本身也開始有 registry + 單通道執行入口，後續若把通道再抽成 adapter 形式，改動面會更小。
- 通知 task 建立端也不再直接維護 switch，通道定義與執行器的對應關係比前一階段更清楚。

## 已完成收口

目前高優先、且與「接近模組化、區塊邊界非常清楚」直接相關的重構已大致完成。

`scripts/smoke_check_userscript.js` 也已不再只是語法檢查，現在會透過 test hook 驗證部分穩定純邏輯：

- `parseKeywordInput()`
- `matchRules()`
- permalink canonicalization / postId extraction
- `getPostKey()`
- `dedupeExtractedPosts()`
- history merge / seen-stop helper
- 通知文字格式化函式

## 低優先待辦

### 1. 進一步降低 panel 區塊的重刷範圍

方向：

- 保留現在的 panel shell / section helper 結構
- 視需要把 status / debug 的整段 `innerHTML` 更新再拆成更細的區塊
- 只在確定有維護價值時再處理，不為了形式而拆

## 目前不建議做

### 1. 不建議立刻做大規模「假模組化」重寫

不建議把現有函式整批塞進 `Storage / UI / ScanEngine` 名字空間，卻保留同樣的資料流與副作用邏輯。

原因：

- 外觀看起來比較整齊
- 但實際耦合未必下降

### 2. 不建議全面改成 class-heavy 架構

這支 script 的本質較接近事件驅動與 DOM orchestration。

原因：

- 過度 OOP 不一定更自然
- module object / closure pattern 通常更適合這類 userscript

### 3. 不建議在重構同時動 selector / extractor 策略

原因：

- Facebook DOM 是目前最脆弱的部分
- 一旦結構重整與 selector 調整一起發生，出問題時很難定位

### 4. 不建議先追求多檔化或 bundler

原因：

- 目前部署模型仍是單檔 Tampermonkey
- 先把單檔內部邊界做好，比先引入工具鏈更實際

## 建議的後續順序

1. 先維持目前已完成的模組邊界與 smoke test 基礎
2. 若之後 UI 維護成本真的升高，再考慮縮小 panel 重刷範圍

## 每輪重構的驗證原則

- 不同一輪同時修改 scan flow 與 selector
- 不同一輪同時修改 UI 行為與通知策略
- 每次重構後至少手動確認：
  - `開始 / 暫停`
  - `儲存` 後重掃
  - 命中通知
  - `查看紀錄`
  - debug 面板 scan summary
  - top-post shortcut 行為

## 一句話總結

這份重構規劃的核心不是把單檔拆掉，而是把目前這支單檔腳本逐步整理成「有清楚責任邊界、主流程較薄、可持續維護」的單檔應用。

## 與 chatgpt_review 對照結論

重新對照 `chatgpt_review.md` 後，結論如下：

- review 中高價值、且與結構清晰度直接相關的主張，目前大多已完成：
  - 單檔內責任邊界更清楚
  - `runScan()` 降為 orchestration
  - 純邏輯與副作用分流
  - UI shell / render / event wiring 分開
  - 停用或 internal-only 功能已明確標示
  - 已補上最小可執行的 smoke test 與 test hook
- 有些 review 建議沒有完全照做，屬於刻意保留，而不是遺漏：
  - 沒有把 `STATE` 全面抽象化，只把接觸面集中；再做下去容易變成假抽象
  - 沒有把所有觸發來源硬收成完整 `Scheduler` API；目前複雜度尚未高到必須如此
  - 沒有把 panel 改成極細粒度局部 patch；沒有明顯效能症狀前，收益不足
  - 沒有把所有區塊強行包成 closure / module object；避免為了形式而模組化
- 仍然有道理、但屬於後續觀察的方向：
  - 視未來複雜度，再考慮為 `STATE` 補一層很薄的 runtime facade
  - 視掃描規則是否繼續擴充，再考慮加強 scheduler 收口
  - 以 smoke test 為主，逐步補更多穩定純邏輯案例
  - 只在實際出現卡頓、閃動或輸入干擾時，才進一步縮小 panel 重刷範圍

總結來說，`chatgpt_review.md` 所指出的核心結構問題，目前已大致落地；尚未完成的部分，多半不是漏做，而是評估後認為再往下做會開始進入過度工程。

## 與 chatgpt_review2 對照結論

重新對照 `chatgpt_review2.md` 後，結論如下：

- review2 中仍然合理、而且值得持續注意的部分：
  - `STATE` 仍偏胖，雖然已從結構風險降到可接受的單檔 userscript 取捨，但後續新增功能時仍要避免再次擴散寫入點
  - `開始 / 暫停` 的語義不能只當成 UI toggle，必須明確區分 pause 與 restart；目前已開始朝這個方向收口
  - `seenPosts` 現在已改成保留多個社團 bucket；後續若再擴充 state，仍要避免讓不同 bucket 的生命週期規則再次分裂
  - maintenance loop 屬於 Facebook SPA 下的現實折衷，應視為 policy 層選擇，而不是隨機散落的 workaround
  - smoke test 應逐步從 matcher 擴大到控制語義與 policy 層，避免未來重構只剩人工回歸
- review2 中部分合理，但優先度已下降的部分：
  - `FEATURE_STATUS` 與 `loadMoreMode` 確實仍有「保留能力 / 內部預留點」的痕跡，但目前已是刻意縮小正式能力面的做法，不再視為急修項
  - config persistence 在早期版本確實較分裂；目前已透過 refresh payload 與 store facade 收斂，不再需要為此再開一輪大重構
  - Facebook DOM 依賴點可以再文件化，但不建議再抽成更高一層抽象模型，避免為了名稱而名稱
- review2 中目前不建議照單全收的部分：
  - 不做全面 `STATE` facade 化；在單檔 Tampermonkey 腳本中，這很容易只增加 wrapper 而不明顯降低複雜度
  - 不做更高一層的 `facebookDomProfile` / `groupPageDetectionContract` 類抽象；目前單站腳本還不需要這種額外名詞層
  - 不做 scheduler framework 化；現況的 scan / refresh / route / render 排程複雜度仍可由既有分段支撐

總結來說，`chatgpt_review2.md` 比較像是第二輪整理的提醒清單，而不是新的大重構藍圖。其高價值部分已被納入後續優化方向，剩餘未採納部分多半是為了避免過度工程。
