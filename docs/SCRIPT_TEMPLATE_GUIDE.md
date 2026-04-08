# 腳本模板導覽

本文件說明如何把 `src/facebook_group_refresh.user.js` 視為一份**單站監視腳本模板**。

重點不是把這支腳本改成多站共用核心，而是：

- 這支腳本仍然專注在 Facebook 社團監視
- 但它的架構整理到足夠清楚
- 讓人或 AI 在未來要做「另一個網站專屬的監視腳本」時，可以快速複製這份結構
- 只替換必要的站點邏輯，而不是重新從零摸索整體架構

---

## 1. 使用目的

這份模板適合用在以下情境：

- 新網站上有一批可觀察的「項目」
  - 例如貼文
  - 票券
  - 商品
  - 訂房空房
  - 活動名額
  - 排程狀態
- 使用者想在瀏覽器登入後，直接在前端頁面上監視變化
- 希望保留：
  - 關鍵字比對
  - 去重
  - 通知
  - debug
  - 設定面板
- 不希望一開始就引入 server crawler、bundler、框架或背景服務

這份模板**不適合**直接用在：

- 需要大量爬取、批次資料抓取的情境
- 需要登入自動化、驗證碼、OCR、隱身策略的情境
- 本質不是「頁面監視」，而是 API client、批量同步工具、後端排程器

---

## 2. 設計原則

這份模板的核心設計原則如下：

### 2.1 單站專用，但區塊清楚

不要把每支腳本硬做成多站共用平台。

比較好的做法是：

- 每一支腳本都只服務單一網站 / 單一場景
- 但內部維持同一套高可讀性的分層方式

這樣未來要做新網站時：

- 可以複製整個專案
- 保留共通結構
- 重寫少數站點相關區塊

### 2.2 純邏輯與副作用分開

模板裡最值得被複製的，不是 Facebook selector，而是這些思路：

- 關鍵字規則解析
- 匹配規則
- 唯一鍵生成
- seen/history 合併
- 通知文字格式化
- scan summary 的標準形狀

這些邏輯越純，越容易：

- 被 AI 快速理解
- 被 smoke test 驗證
- 被搬到新網站腳本

### 2.3 先有可診斷性，再談優化

監視腳本最怕的是：

- 站點 DOM 變了
- 腳本不再工作
- 但不知道壞在哪裡

所以模板裡的：

- debug 面板
- latest scan summary
- 通知狀態
- history / seen 邏輯

都不是裝飾，而是維護性的一部分。

### 2.4 不追求假模組化

不要為了看起來漂亮，就把所有函式硬包進：

- `Storage.xxx`
- `Scheduler.xxx`
- `UI.xxx`

如果資料流沒有真的更清楚，這只會讓後續維護更痛苦。

這份模板追求的是：

- 單檔內有清楚區塊
- 入口穩定
- 流程明確

而不是形式上的 namespace。

---

## 3. 目前模板的區塊分層

`src/facebook_group_refresh.user.js` 目前分成以下區塊：

1. `Storage / Config`
2. `Text / Common Utils`
3. `Matcher / Rules`
4. `Page Context / Scheduling`
5. `Extractor / DOM Collection`
6. `Post Parsing / Notification Formatting`
7. `Persistence / Dedupe / History`
8. `Scan Engine`
9. `Notifier`
10. `UI / Modal`
11. `Lifecycle / Observer`

這 10 區就是未來新腳本最應該沿用的主骨架。

---

## 4. 哪些區塊通常可以沿用

以下區塊在新網站腳本中通常可以直接參考，甚至大幅複用：

### 4.1 Storage / Config

可沿用內容：

- `STORAGE_KEYS` 的設計方式
- `CONFIG_FIELD_DEFINITIONS` / `CONFIG_GROUP_DEFINITIONS` 這種欄位定義 + group 定義分層
- `DEFAULT_CONFIG` 的集中管理方式
- `INTERNAL_CONFIG` 這種 internal-only 行為設定
- `loadString()` / `loadBoolean()` / `loadJson()`
- `saveString()` / `saveJson()`
- `loadStoredRawValue()` / `saveStoredRawValue()`
- `loadPersistedConfigField()` / `loadPersistedConfigGroup()`
- `persistConfigFieldValue()` / `persistConfigGroup()`
- 命名化 store registry 的概念
- group-scoped store / named store 的概念

新網站通常只需要調整：

- `STORAGE_KEYS`
- `DEFAULT_CONFIG`
- `CONFIG_FIELD_DEFINITIONS`
- 是否需要保留 group-scoped store

如果新腳本同時有「正式設定」與「不對外暴露的執行策略」，建議一開始就分成：

- public config
- internal config

這樣像固定 load-more 策略、通知 hydration 細節、暫時停用但仍保留介面的欄位，就不會混進使用者可編輯設定。

如果新網站不是「群組」概念，也可以把：

- `groupId`

改成：

- `pageKey`
- `queryKey`
- `watchTargetId`

### 4.2 Text / Common Utils

可沿用內容：

- `normalizeText()`
- `normalizeForMatch()`
- `normalizeForKey()`
- `truncate()`
- `escapeHtml()`
- `escapeRegExp()`
- `sleep()`
- clipboard helper

這層幾乎是所有監視腳本都會需要的基礎工具層。

### 4.3 Matcher / Notification Formatting

可沿用內容：

- `buildKeywordRule()`
- `parseKeywordInput()`
- `matchesKeywordRule()`
- `matchRules()`
- `buildCompactNotificationSegments()`
- `buildRemoteNotificationLines()`

這些是目前最適合被 AI 直接借用到新腳本的部分。

### 4.4 Persistence / Dedupe / History

可沿用內容：

- `getPostKey()` 這類唯一鍵思路
- `collectUniquePostsByKey()`
- `trimSeenPostGroupStore()`
- `mergeMatchHistoryEntries()`
- `seen` / `history` / `latestNotification` 的資料流

要改的只有「唯一鍵怎麼組」的站點細節。

### 4.5 Notifier

可沿用內容：

- 本地通知流程，例如 `GM_notification`
- `ntfy`
- Discord Webhook
- `latestNotification` 更新方式
- channel definitions / runner map / task 建立方式
- `hydrateNotificationConfigFromStorage()` 這種「進入通知流程前先把 persisted config 同步回 runtime」的收斂入口

多數網站腳本都不需要改這層，除非：

- 通知內容欄位完全不同
- 想新增其他通道

### 4.6 UI / Modal

可沿用內容：

- panel shell
- settings modal
- history modal
- help modal
- view state -> render HTML 的流程
- debug copy button
- `buildPanelRuntimeSnapshot()` / `getPanelViewState()` 這種先整理 view model 再 render 的做法
- `uiRuntime.panelPosition` / `uiRuntime.panelDrag` 這種 UI-only runtime state
- 僅允許標題列拖曳的 panel drag 結構
- `normalizePanelPosition()` / `clampPanelPosition()` / `buildDraggedPanelPosition()` 這類位置 helper
- 拖曳位置持久化，並在 panel 重建後重新套回位置

這層通常只需調整：

- 標題文字
- 欄位標籤
- status / debug 內容
- 拖曳熱區與按鈕 / textarea / input 的事件邊界
- viewport clamp 規則

### 4.7 Smoke Test 架構

可沿用內容：

- `scripts/smoke_check_userscript.js`
- `__FB_GROUP_REFRESH_TEST_MODE__`
- `__FB_GROUP_REFRESH_TEST_HOOKS__`
- Node `vm` 載入 userscript 的方式
- 優先暴露純邏輯 helper，而不是直接測完整 DOM side effect
- 讓 config / dedupe / notification formatting / panel position helper 都可單獨驗證

目前這份模板也已驗證一種可直接沿用的 runtime 結構：

- `STATE` 先分成 `config / scanRuntime / notificationRuntime / routeRuntime / uiRuntime / schedulerRuntime / sessionRuntime`
- 各 runtime 的寫入優先走分類明確的 patch helper
- timer / observer / panel runtime 以 orchestration helper 統一收口
- 正式設定優先透過 keyword / refresh / notification / monitoring / UI 的 use case helper 更新
- 不對外開放的能力，例如固定 load-more 策略或 internal-only 通知能力，應降階成 internal config，而不是混進正式設定模型
- session-only 狀態若需要 `Set` / `Map`，建議包成像 `isGroupInitialized()` / `markGroupInitialized()` 這類 helper 再由 orchestration 呼叫
- UI 行為若有計算邏輯，例如 panel drag，也應拆出可測的純 helper

這是這份模板很重要的部分，因為它讓：

- 單檔 userscript
- 仍然有最小可驗證純邏輯

---

## 5. 哪些區塊一定要重寫

未來做新網站腳本時，以下區塊通常不能直接照抄。

### 5.1 Page Context / Detection

Facebook 版本目前的概念是：

- `isSupportedGroupPage()`
- `getCurrentGroupId()`
- `getCurrentGroupName()`
- `getCurrentFeedSortLabel()`

換網站後，這層一定要改。

新的腳本至少要重新定義：

- 目標頁如何判定
- 目前頁面的核心上下文是什麼
- 使用者現在正在監視哪一個目標

常見例子：

- 商品頁：`productId`、`productName`
- 飯店頁：`hotelId`、`hotelName`、日期條件
- 活動頁：`eventId`、`eventName`
- 搜尋頁：`queryKey`

### 5.2 Extractor / DOM Collection

這是新網站最需要重寫的區塊。

要改的通常包括：

- `findFeedRoot()`
- `collectPostContainers()`
- `getCanonicalPostElement()`
- `extractAuthor()`
- `extractPostTextDetails()`
- `extractPostId()`
- 任何 selector / DOM traversal / text cleanup

原則：

- 這層只負責「抓資料」
- 不要在這層混入通知、history、UI

### 5.3 Page-specific Scheduling Heuristics

Facebook 目前有：

- route settle
- mutation observer
- refresh cadence
- scroll-based load more
- top-post shortcut

換網站後，這些規則未必成立。

例如：

- 有些站不需要 refresh，只要 observer
- 有些站需要等篩選器套用完成
- 有些站是 pagination 而不是 infinite scroll

因此這一塊要重新評估：

- `scheduleScan()`
- `scheduleRefresh()`
- `collectPostsAcrossWindows()`
- `performConfiguredLoadMore()`
- route / page change 策略

### 5.4 唯一鍵組成方式

目前 Facebook 腳本的 `getPostKey()` 是圍繞：

- `postId`
- `permalink`
- `author`
- `timestampText`
- `text signature`

新網站未必有這些欄位。

新網站一定要重新決定：

- 哪些欄位穩定
- 哪些欄位可作為 fallback
- 哪些欄位會經常變動，不該進 key

---

## 6. 新腳本的建議建立順序

不要一開始就把所有功能都搬過去。建議順序如下。

### 階段 1：先建立最小可掃描版本

目標：

- 腳本能在目標網站頁面啟動
- 能抓到候選資料
- 能把每一筆資料轉成統一 record

這個階段應先完成：

- `isSupportedPage`
- `getCurrentPageContext`
- `collectCandidates`
- `extractRecord`
- `renderDebug`

先不要急著做：

- 通知
- history
- fancy settings

### 階段 2：補上 dedupe / seen / history

目標：

- 同一項目不重複通知
- 每輪掃描結果有歷史與診斷資訊

這個階段應完成：

- `getRecordKey()`
- `hasSeenRecord()`
- `markRecordSeen()`
- `addMatchHistory()`
- `latestScan` / debug summary

### 階段 3：補上通知與設定

目標：

- 能實際提醒使用者
- 設定可保存

這個階段應完成：

- local notification
- `ntfy`
- Discord
- settings modal

### 階段 4：補上網站特有優化

例如：

- load more
- route settle
- observer
- polling
- 快速略過策略

原則是：

- 先可用
- 再穩定
- 最後再優化

---

## 7. 建議保留的資料形狀

為了讓後續新腳本維持可讀性，建議沿用這幾種核心資料形狀。

### 7.1 `record`

代表一筆從頁面抽出的可監視資料。

建議至少包含：

```js
{
  id: "",
  url: "",
  title: "",
  text: "",
  normalizedText: "",
  timestampText: "",
  source: "",
  extractedAt: "",
}
```

如果網站適合，也可改成：

```js
{
  roomType: "",
  price: "",
  availability: "",
  dateRange: "",
}
```

重點不是欄位名稱統一，而是：

- 每一筆資料都要有穩定 shape
- 一旦進入 scan engine，就盡量不要再讀 DOM

### 7.2 `summary`

代表 record 套過規則與去重後的掃描結果。

建議至少包含：

```js
{
  recordKey: "",
  seen: false,
  includeRule: "",
  excludeRule: "",
  eligible: false,
}
```

### 7.3 `latestScan`

代表本輪掃描摘要。

建議保留：

- 掃描原因
- candidate 數
- 去重後數量
- 通知數量
- 停止原因
- 錯誤
- 完成時間

因為這是 debug / UI / 維護性核心。

---

## 8. 新腳本時，哪些命名最好保留

為了讓 AI 或維護者快速對照，我建議保留這種命名習慣。

### 8.1 掃描流程

- `runScan()`
- `scheduleScan()`
- `scheduleRefresh()`
- `collectScanRecords()` 或 `collectScanPosts()`
- `summarizeScanRecords()` 或 `summarizeScanPosts()`
- `commitScanState()`

### 8.2 去重 / 歷史

- `getRecordKey()` 或 `getPostKey()`
- `hasSeenRecord()`
- `markRecordSeen()`
- `getMatchHistoryStore()`
- `addMatchHistory()`

### 8.3 通知

- `notifyForRecord()` 或 `notifyForPost()`
- `buildCompactNotificationBody()`
- `buildRemoteNotificationBody()`

### 8.4 UI

- `getPanelViewState()`
- `renderPanel()`
- `openSettingsModal()`
- `openHistoryModal()`

命名不必完全一樣，但盡量維持：

- `get...`
- `build...`
- `render...`
- `handle...`
- `open...`
- `close...`

這種意圖清楚的模式。

---

## 9. 建議保留的檔案結構

如果你之後複製這個 repo 做新網站腳本，建議保留這個基本結構：

```text
<new-monitor-project>/
├─ src/
│  └─ <new-script>.user.js
├─ docs/
│  ├─ REFACTOR_PLAN.md
│  ├─ SCRIPT_TEMPLATE_GUIDE.md
│  ├─ V1_SPEC.md
│  └─ TASK_BREAKDOWN.md
├─ scripts/
│  └─ smoke_check_userscript.js
├─ README.md
├─ AGENTS.md
├─ GIT_COMMIT_RULES.md
└─ .gitignore
```

如果要最小化，也至少保留：

- `src/`
- `docs/`
- `scripts/`
- `README.md`
- `AGENTS.md`

---

## 10. AI 使用這份模板時的最佳提示方式

如果你未來要讓 AI 根據這份腳本做新網站版本，建議在 prompt 中明確說：

1. 這是一支單站監視腳本，不要改成多站平台
2. 請沿用目前的區塊分層
3. 請保留：
   - debug 面板
   - seen/history
   - opt-in 通知
   - smoke test
4. 請只重寫：
   - page detection
   - extractor
   - page-specific scheduling heuristics
   - unique key strategy
5. 不要引入 bundler 或 framework

建議 prompt 長這樣：

```text
請把這個 Facebook userscript 視為單站監視腳本模板，
建立一支新的 <網站名稱> 監視腳本。

要求：
- 仍然是單檔 Tampermonkey userscript
- 沿用目前的區塊分層
- 保留 settings/debug/history/notification/smoke test 結構
- 只重寫 page detection、extractor、站點特有的 scheduling 邏輯
- 不要引入 bundler、框架、server-side crawler
```

這樣 AI 較容易做出：

- 架構相似
- 維護性一致
- 可比較與可驗證的新腳本

---

## 11. 建議保留的 smoke test 策略

每一支新網站腳本都建議保留：

- test mode
- test hooks
- Node `vm` smoke test

至少要驗：

- 關鍵字解析
- 規則匹配
- 唯一鍵生成
- dedupe
- history merge
- seen trimming
- 通知文字格式化

如果新網站有特別穩定的純邏輯，也可再補：

- 價格格式化
- 日期範圍正規化
- query key 組合
- availability 判斷

原則是：

- 不去測脆弱 DOM
- 優先測最穩定、最容易被重構破壞的邏輯

---

## 12. 改站時最常見的錯誤

### 12.1 一開始就硬搬所有 Facebook 專屬欄位

例如直接保留：

- `groupId`
- `groupName`
- `postId`

這會讓新網站腳本語意混亂。

應改成符合新站點語意的名稱。

### 12.2 Extractor 內混入通知與 storage

錯誤做法：

- 在 DOM 抽取函式裡直接寫 storage
- 在 extract 時順手 notify
- 在 collectCandidates 時順手 render UI

這會讓新腳本很快再次變成不可維護的單坨。

### 12.3 一開始就過度抽象

例如：

- 先做一個超大的 `Scheduler`
- 先做一個通用 `SiteAdapter`
- 先做 closure-heavy module 包裝

這些如果沒有第二支腳本實際需求，通常會讓第一支新腳本反而更難做。

### 12.4 沒有保留 debug 面板

沒有 debug 面板時，DOM 抽取壞掉後很難定位：

- 是 selector 壞了
- 是候選抓不到
- 是 key 壞了
- 還是通知被 skip

所以 debug 面板不是可有可無。

---

## 13. 新腳本建立時的最小驗證清單

完成第一版後，至少手動確認：

1. userscript 只在目標網站啟動
2. 主面板正常出現
3. debug 面板能看到掃描摘要
4. 能抓到候選資料
5. include / exclude 規則正常
6. seen 去重正常
7. history 正常寫入與清空
8. 本地通知正常
9. `ntfy` / Discord 在設定後能送出
10. 重新整理或切頁後不會重複初始化

如果有 smoke test，再確認：

1. script 能在 Node `vm` 內載入
2. test hook 有暴露
3. 核心純邏輯測試通過

---

## 14. 從這份模板複製新腳本時的建議步驟

### 做法 A：直接複製整個 repo

適合你未來持續做多個監視腳本。

步驟：

1. 複製整個 repo 成新資料夾
2. 改 `README.md`
3. 改 userscript metadata
4. 改 `src/<new-script>.user.js`
5. 先只重寫 page detection / extractor
6. 再調整 key / history / 通知文字
7. 最後更新 smoke test

### 做法 B：只複製單支 userscript + smoke test

適合快速做小型原型。

步驟：

1. 複製 `src/facebook_group_refresh.user.js`
2. 複製 `scripts/smoke_check_userscript.js`
3. 保留原分段
4. 逐區替換站點相關內容

---

## 15. 對這份模板的最終定位

這份 Facebook 社團監視腳本，未來最好的定位不是：

- 多站共用框架
- 通用 crawler
- 抽象平台

而是：

> 一份高可讀、可維護、可複製的單站監視腳本模板。

它的價值在於：

- 給未來的你一份清楚骨架
- 給 AI 一份容易模仿的結構
- 讓新網站腳本能少走很多彎路

---

## 16. 一句話總結

未來做新網站監視腳本時，應該複製這份腳本的「分層方式與資料流」，而不是複製 Facebook 本身的 selector 與語意。

---

## 17. 哪些 policy 可直接沿用，哪些屬於 Facebook 專屬

這份模板的價值不只在函式切分，也在於某些 policy 已經被整理成可複製的模式。實際複製到新腳本時，應先分清楚「通用 policy」與「Facebook 專屬 policy」。

### 17.1 適合直接沿用的 policy

以下做法通常可直接沿用到新網站腳本，只需改欄位名稱與通知文字：

- include / exclude 關鍵字規則
- dedupe key 的分層策略
  - 優先穩定 ID
  - 次選 permalink
  - 最後才用作者 / 時間 / 文字簽名 fallback
- seen / history / latest notification 的持久化思路
- panel / settings / debug / history modal 的互動分層
- panel drag + persisted position 的 UI policy
- smoke test 只測純邏輯與 policy，不硬測 DOM-heavy 行為
- notifier 分成本地通知與 opt-in 遠端通知通道
- public config 與 `INTERNAL_CONFIG` 分離
- config hydration 與 session helper 的薄封裝

### 17.2 屬於 Facebook 專屬、通常必須重寫的 policy

以下內容高度依賴 Facebook 社團頁的 DOM 與互動節奏，新腳本通常不能直接搬：

- page detection 與 context 命名
  - `groupId`
  - `groupName`
- feed sort 判斷
  - `新貼文`
  - `最相關`
  - `最新動態`
- top-post shortcut 的前提
  - 依賴目前頁面確實是時間排序
  - 依賴最上方貼文足以作為快篩基準
- seen-stop 提前停止深掃
  - 依賴貼文列表由新到舊的排序可信度
  - 依賴 scroll / load-more 的頁面節奏
- Facebook 專屬 DOM heuristic
  - 貼文容器辨識
  - `查看更多 / See more`
  - post ID 抽取
  - 群組名稱抓取與導覽 label 排除

### 17.3 複製到新腳本時的判斷原則

如果某個規則同時依賴以下兩件事，就應優先視為站點專屬：

1. 依賴網站 DOM 結構、按鈕文案、頁籤名稱或排序模式
2. 依賴該網站的載入節奏，例如 scroll 後何時補資料、最上方資料是否可信

如果某個規則主要是在回答以下問題，通常可視為可複製的通用 policy：

1. 如何定義命中條件
2. 如何定義 dedupe
3. 如何保存已通知歷史
4. 如何把 UI / notifier / scan orchestration 分層

### 17.4 一個實用的複製順序

當你從這份模板開新腳本時，建議順序是：

1. 先保留通用 policy 不動
   - matcher
   - dedupe
   - history
   - notifier
   - config / internal-config 骨架
   - panel position helper
   - smoke test 骨架
2. 再重寫站點專屬 policy
   - page detection
   - extractor
   - top-post shortcut 是否存在
   - seen-stop 是否合理
3. 最後才調整 UI 文字與通知內容

如果新腳本暫時停用某個欄位或能力，也可以保留資料形狀與介面，但要在文件中明確標註目前是否啟用，避免讀者把「欄位仍存在」誤解成「功能仍在運作」。

這樣做的好處是，新腳本會先站穩資料流與分層，再處理網站差異，而不是一開始就把所有東西一起改亂。
