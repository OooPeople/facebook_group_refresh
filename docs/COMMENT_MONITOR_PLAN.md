# Comment Monitor Plan

這份文件規劃「單篇貼文留言監控」功能。目標是讓現有 userscript 在 Facebook 社團貼文頁中，也能保守掃描留言、套用 include / exclude 關鍵字，並沿用既有通知與去重架構。

本計畫的核心原則是：新增留言掃描能力，但不影響既有社團動態牆貼文監控。實作時應維持單檔 `src/facebook_group_refresh.user.js`，不引入 bundler、背景服務、headless browser、登入自動化或互動式 Facebook 操作。

## 使用者可見行為

第一版完成後，使用者可在兩種頁面使用同一支腳本：

- 社團動態牆頁：維持目前行為，自動 refresh 頁面、保守 scroll、掃描最近貼文。
- 社團單篇貼文頁：自動 refresh 目前貼文頁、保守 scroll、掃描該貼文下方可見與載入後的留言。

建議第一版採用自動偵測：

- URL 是 `https://www.facebook.com/groups/<group-id>/` 或社團分頁時，使用 `posts` scan target。
- URL 是 `https://www.facebook.com/groups/<group-id>/posts/<post-id>` 或等價 permalink 時，使用 `comments` scan target。

若自動偵測在實頁驗證後不穩，再補設定讓使用者手動指定模式。第一版不先新增設定，以降低 UI 與 storage 變更面。

## 明確非目標

- 不自動留言、回覆、按讚、私訊或與 Facebook 使用者互動。
- 不處理帳號憑證、cookies、tokens、session IDs。
- 不加入大量爬取、OCR、CAPTCHA、stealth automation。
- 第一版不強制點擊「查看更多留言」、「查看先前留言」或切換留言排序。
- 第一版不掃描巢狀回覆留言，除非 DOM selector 實作時能安全區分且不增加脆弱互動。
- 不改變既有社團貼文監控的預設行為、設定語義、通知通道與 seen state。

## 架構策略

不要建立「留言版 runScan」。應讓留言資料進入目前 scan pipeline：

1. 新增 page target 判斷，產生本輪 scan target。
2. `posts` target 走既有貼文 collector。
3. `comments` target 走新增留言 collector。
4. 貼文與留言都輸出共用 scan item shape。
5. 沿用既有 matcher、summary、notification、history、seen commit。

核心抽象：

```js
{
  kind: "posts" | "comments",
  groupId,
  parentPostId,
  scopeId,
}
```

其中：

- `kind` 決定 collector 與最佳化策略。
- `groupId` 維持社團設定與通知顯示使用。
- `parentPostId` 只在留言模式有值。
- `scopeId` 用於 baseline、seen、latest scan cache，避免留言與社團 feed seen state 混在一起。

建議 scope：

```text
group:<group-id>:posts
group:<group-id>:post:<post-id>:comments
```

如果要最小化儲存 helper 改動，可先讓既有 `groupId` 參數接受 scope id；但函式命名要逐步泛化，避免長期誤導。

## Scan Item Shape

留言 record 應盡量相容目前 post record，讓下游少改：

```js
{
  itemKind: "comment",
  commentId,
  parentPostId,
  postId: "",
  permalink,
  author,
  text,
  normalizedText,
  timestampText: "",
  timestampEpoch: null,
  groupId,
  source: "comment",
  containerRole,
  textSource,
  permalinkSource,
  extractedAt,
}
```

貼文 record 可補：

```js
{
  itemKind: "post",
  parentPostId: "",
  commentId: "",
}
```

第一版下游可以繼續叫 `post` 變數，但新增純邏輯 helper 時優先使用 `item` 命名。大範圍改名不是第一版目標。

## 去重策略

留言 identity 優先順序：

1. `commentId`
2. comment permalink canonical form
3. `parentPostId + author + text signature`
4. legacy fallback `author + text signature`

建議新增：

- `extractCommentIdFromValue(value)`
- `getScanItemKey(item)` 或讓 `getPostKey(post)` 支援 `itemKind === "comment"`
- `getScanItemKeyAliases(item)` 或讓 `getPostKeyAliases(post)` 支援 `commentId`

第一版可先擴充現有 `getPostKey()` / `getPostKeyAliases()`，避免一次重命名大量 call sites。完成後再視可讀性逐步改成 scan item 命名。

注意：

- `commentId` 不可被當成 `postId`，避免污染貼文 key。
- 同一則留言在 permalink、query 參數或 fallback 欄位變動時，仍應盡量被視為同一則留言。
- 留言 seen 必須寫入 comments scope，不可寫入社團 feed scope。

## Collector 設計

### Page Context

新增或調整：

- `getCurrentPostRouteId()`
- `isGroupPostPermalinkPage()`
- `getCurrentScanTarget()`
- `isSupportedScanPage()`

`isSupportedGroupPage()` 可保留給既有呼叫，但 scan context 應逐步改讀 `isSupportedScanPage()`。

### Posts Target

既有貼文 collector 應保持行為不變：

- `collectPostsWithTopPostShortcut()`
- `collectPostsAcrossWindows()`
- `collectPostContainers()`
- `extractPostRecord()`

貼文模式仍保留：

- top-post shortcut
- seen-stop
- latest top post cache
- latest scan posts cache

任何留言改動後，都要跑社團 feed 回歸驗證。

### Comments Target

新增留言 collector，優先放在 `Extractor / DOM Collection` 與 `Scan Engine` 邊界附近：

- `collectCommentContainers(limit)`
- `prepareCommentContainerForExtraction(container)`
- `extractCommentRecord(candidate, scanTarget)`
- `collectCommentsFromCandidates(candidates, scanCache)`
- `collectLoadedCommentsOnly(scanTarget)`

候選策略：

- 優先從單篇貼文頁主內容區或目前文章容器附近找留言。
- 使用 `role="article"`、comment permalink、`comment_id` query、`aria-label`、文字錨點等較穩定訊號。
- 避免把原始貼文本文、社團導覽、排序控制、推薦內容誤當留言。
- 初版只掃目前已載入 DOM 的留言，不自動滾動、不主動展開大量隱藏留言。等留言抽取與作者辨識穩定後，再評估是否加入 comments 專用的自動載入策略。

文字抽取：

- 可復用 `normalizeText()`、`cleanExtractedText()`、`stripCommentActionTrail()`。
- 不直接復用 `extractPostTextDetails()` 的上半部區域假設，因為留言容器較小且結構不同。
- 新增 `extractCommentTextDetails(container)`，只負責留言文字。

作者抽取：

- 可先復用 `extractAuthor(container)`。
- 若實頁誤抓操作按鈕或原貼作者，再新增 `extractCommentAuthor(container)`。

permalink / id：

- 復用 `normalizeFacebookUrl()`、`collectAnchorsFromScope()`、`isCommentPermalinkHref()`。
- 新增 comment permalink details helper，保留 `comment_id` 或 `reply_comment_id`。
- 通知連結優先使用 comment permalink；沒有時退回當前貼文 URL。

## Scan Engine 改動

### Context

`createScanExecutionContext(reason)` 應新增 target：

```js
{
  reason,
  supported,
  target,
  groupId: target.groupId,
  scopeId: target.scopeId,
  includeRules,
  excludeRules,
  baselineMode: !isScopeInitialized(target.scopeId),
}
```

既有 `initializedGroups` 可改為 initialized scopes：

- 最小改法：保留 `initializedGroups` 名稱，但實際存 scope id。
- 較乾淨改法：改成 `initializedScopes`，同步更新 helper 與 smoke test。

第一版推薦較乾淨改法，但要確保回歸測試涵蓋原 group scope。

### Collection

`collectScanPosts(reason, supported, groupId)` 改為依 target 分流：

- `target.kind === "posts"`：既有路徑。
- `target.kind === "comments"`：新留言路徑。

留言模式第一版不使用：

- top-post shortcut
- seen-stop
- latest top post cache

可以使用 latest scan cache，但 key 必須用 `scopeId`。如果會增加風險，第一版可不快取留言 latest scan，只保留 panel runtime。

### Summary / Commit

`summarizeScanPosts()`、`buildPostScanSummary()`、`commitScanState()` 可先維持名稱，但傳入 scope id：

```js
const seen = hasSeenPost(scanContext.scopeId, item);
markPostSeen(scanContext.scopeId, item);
addMatchHistory(scanContext.groupId, matchesToNotify);
```

history 建議保留 `groupId`，並在 entry 內新增：

- `itemKind`
- `parentPostId`
- `commentId`

UI 可先不全部顯示，但資料要保留，方便後續診斷。

## Notification / UI

第一版通知共用既有通道，不新增遠端端點。

建議小幅調整文字：

- post：標題仍可為 `Facebook group match`
- comment：標題可為 `Facebook group comment match`
- remote body 加一列 `類型: 留言` 或 `類型: 貼文`

主面板：

- 狀態列顯示目前模式：`社團貼文` / `貼文留言`
- target count 文案第一版可維持「目標掃描貼文數」，但功能完成前應改為較中性的「目標掃描項目數」。
- debug rows 加上 `scan target`、`scopeId`、`parentPostId`。
- debug item rows 加上 `itemKind`、`commentId`。

歷史紀錄：

- 顯示類型，至少能分辨貼文與留言。
- 連結優先開 comment permalink。

文件：

- 更新 `README.md` 功能概要與啟用 URL 說明。
- 更新 `docs/USAGE.md`，新增「留言監控」章節。
- 更新 `docs/ARCHITECTURE_PLAN.md`，補 scan target 與留言 collector 現況。

## 分階段任務

### Phase 0: Safety Baseline

- [x] 執行 `node .\scripts\smoke_check_userscript.js`，確認改動前 baseline 通過。
- [ ] 手動確認目前社團 feed 頁可顯示 panel、儲存關鍵字、開始 / 暫停。
- [ ] 記錄一個社團 feed 頁的 debug 摘要，作為回歸比較。

完成條件：

- 測試與手動 baseline 無異常。
- 未改動 userscript 行為。

### Phase 1: Scan Target Abstraction

- [x] 新增 route helper：`getCurrentPostRouteId()`、`isGroupPostPermalinkPage()`、`getCurrentScanTarget()`。
- [x] 新增 scope helper，讓 posts target 保留既有 group id 以相容既有 seen state，comments target 使用 parent-post scoped id。
- [x] 將 scan context 改為帶 `target` / `scopeId`。
- [x] 將 baseline initialized helper 從 group 語義泛化到 scope 語義。
- [x] 確保 posts target 仍走既有 collector。

測試：

- [x] smoke test 新增 route / target helper 覆蓋：
  - group root URL => `posts`
  - group post URL => `comments`
  - unsupported URL => unsupported
  - posts scope id 穩定
  - comments scope id 包含 parent post id
- [x] `node .\scripts\smoke_check_userscript.js`
- [ ] 手動回歸社團 feed 監控。

完成條件：

- 沒有留言 collector 時，社團 feed 行為完全維持。
- baseline mode 仍只在新 scope 第一次掃描時生效。

### Phase 2: Comment Identity Helpers

- [x] 新增 `extractCommentIdFromValue(value)`。
- [x] 擴充 key aliases，支援 `itemKind === "comment"`。
- [x] 確保 post key 優先順序不變。
- [ ] 新增 history entry 的 optional comment 欄位 normalization。

測試：

- [x] smoke test 覆蓋：
  - `comment_id`
  - `reply_comment_id`
  - comment permalink alias
  - comment scope seen isolation
  - post key 既有案例不變
- [x] `node .\scripts\smoke_check_userscript.js`

完成條件：

- comment key 與 post key 不互相污染。
- 既有 post dedupe 測試全部通過。

### Phase 3: Minimal Comment Collector

- [x] 新增 comment selectors 與 text extraction helper。
- [x] 新增 `collectCommentContainers()`。
- [x] 新增 `extractCommentRecord()`。
- [x] 新增 `collectLoadedCommentsOnly()`，只掃目前已載入 DOM 的留言。
- [x] 留言模式先不啟用 top-post shortcut、seen-stop 或自動滾動。
- [x] 留言模式不主動點擊大量 load more / previous comments。

測試：

- [x] smoke test 覆蓋純 helper：
  - comment id extraction
  - comment record key aliases
  - comment scope seen isolation
  - canonical comment URL
- [x] `node .\scripts\smoke_check_userscript.js`
- [ ] 手動在單篇社團貼文頁確認：
  - panel 顯示
  - debug 可看到 `comments` target
  - 至少一則可見留言能抽到 text
  - 有 permalink 或 fallback key
  - include 命中時可通知
  - exclude 命中時抑制通知

完成條件：

- 單篇貼文頁可掃描可見留言。
- 社團 feed 頁不受影響。

### Phase 4: Scope-Safe Seen / Baseline

- [ ] 將 commit path 明確使用 `scopeId` 寫 seen。
- [ ] `restartMonitoringForCurrentGroup()` 改為 reset current scope，或新增 `restartMonitoringForCurrentTarget()`。
- [ ] 清除 baseline 時只清目前 scope，不清同社團其他貼文留言或社團 feed。
- [ ] latest scan / latest top post cache 只在 posts target 使用，或改用 scope-safe helper。

測試：

- [ ] smoke test 覆蓋：
  - posts scope seen 不影響 comments scope
  - comments scope seen 不影響 posts scope
  - 不同 parent post comments scope 互不影響
  - manual start 只 reset current scope
- [ ] `node .\scripts\smoke_check_userscript.js`
- [ ] 手動確認：
  - 同一則留言不重複通知
  - 同社團 feed 新貼文仍可通知
  - 另一篇貼文留言不被目前貼文 seen state 抑制

完成條件：

- seen state isolation 成立。
- 不會清掉其他社團或其他貼文的 seen state。

### Phase 5: UI / Notification Polish

- [ ] 面板狀態顯示目前掃描模式。
- [ ] 設定文案從「貼文數」調整為「項目數」或依模式顯示。
- [ ] debug 顯示 target kind、scope id、parent post id、comment id。
- [ ] notification title / body 能區分貼文與留言。
- [ ] history modal 顯示類型，留言連結可開啟。

測試：

- [ ] smoke test 覆蓋 notification formatter：
  - post body 不退化
  - comment body 包含類型或留言資訊
- [ ] `node .\scripts\smoke_check_userscript.js`
- [ ] 手動確認桌面通知、ntfy、Discord 測試通知仍正常。

完成條件：

- 使用者能從 panel / debug / history 分辨掃描的是貼文還是留言。
- 遠端通知仍是 opt-in，不新增預設外送資料。

### Phase 6: Documentation and Final Regression

- [ ] 更新 `README.md`。
- [ ] 更新 `docs/USAGE.md`。
- [ ] 更新 `docs/ARCHITECTURE_PLAN.md`。
- [ ] 如需要交接，更新 `docs/HANDOFF_PLAN.md`。
- [ ] 執行 `node .\scripts\smoke_check_userscript.js`。
- [ ] 完成社團 feed 手動回歸。
- [ ] 完成單篇貼文留言手動驗證。

完成條件：

- 文件描述與實際行為一致。
- 原本社團貼文功能通過回歸。
- 留言監控功能完成第一版範圍。

## 必要 Smoke Test 清單

實作過程中應逐步新增，不要等全部完成才補。

- route target detection：
  - group feed route
  - group post route
  - unsupported route
- scope id：
  - posts scope
  - comments scope
  - invalid / missing post id fallback
- key aliases：
  - existing post id / permalink behavior
  - comment id behavior
  - comment permalink behavior
  - fallback comment author + text behavior
- seen isolation：
  - posts vs comments
  - post A comments vs post B comments
  - manual restart current scope only
- notification formatting：
  - post formatting unchanged
  - comment formatting includes correct link and type
- history merge：
  - post entries remain compatible
  - comment entries preserve item kind and comment id

## 手動驗證清單

### 社團 Feed 回歸

1. 開啟 `https://www.facebook.com/groups/<group-id>/`。
2. panel 正常顯示。
3. include / exclude reload 後仍保留。
4. 按開始後第一次掃描是 baseline，不通知既有貼文。
5. 後續新貼文符合 include 時通知。
6. exclude 命中時不通知。
7. 自動 refresh 與保守 scroll 行為維持。
8. top-post shortcut 與 seen-stop debug 不出現異常。
9. 歷史紀錄可開啟貼文連結。

### 單篇貼文留言

1. 開啟 `https://www.facebook.com/groups/<group-id>/posts/<post-id>`。
2. panel 正常顯示並標示留言模式。
3. 第一次掃描建立該貼文留言 baseline，不通知既有留言。
4. 新留言符合 include 時通知。
5. exclude 命中時抑制通知。
6. 同一則留言 refresh 後不重複通知。
7. 通知連結優先指向留言 permalink，沒有時退回目前貼文 URL。
8. 切到另一篇貼文後，seen state 不沿用上一篇貼文留言。
9. 暫停時不掃描、不 refresh。
10. 從暫停切回開始只 reset 目前 target scope。

## 主要風險與處理策略

- Facebook 留言 DOM selector 不穩：第一版只做可見留言與保守 fallback，debug 顯示要足夠診斷。
- 誤把原貼文當留言：comment collector 必須排除 parent post body，手動驗證需特別檢查。
- 誤把回覆留言當頂層留言：第一版可先排除 nested reply；若無法穩定區分，寧可少抓。
- comment permalink 不一定可得：fallback key 必須可用，但 debug 要顯示 permalink 缺失。
- seen scope 污染：所有 commit / baseline / reset 路徑都要使用 scope id，並有 smoke test。
- 既有貼文功能回歸：每個 phase 都要跑 smoke test，涉及 scan / extractor 後要手動回歸社團 feed。

## 完成定義

此功能第一版完成前，必須符合：

- 單檔 userscript 架構維持。
- 原社團貼文監控功能不退化。
- 留言監控只在單篇貼文 target 下啟用。
- matcher、notification、history、seen commit 盡量復用既有模組。
- 遠端通知仍需使用者自行設定。
- 沒有新增 Facebook 互動行為，除了既有 refresh、保守 scroll、文字展開與通知傳送。
- `node .\scripts\smoke_check_userscript.js` 通過。
- 已完成社團 feed 與單篇貼文留言手動驗證。
