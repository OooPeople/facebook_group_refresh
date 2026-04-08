# facebook_group_refresh 架構檢視與單檔重構建議

## 文件目的

這份文件整理目前 `src/facebook_group_refresh.user.js` 在**代碼架構**上的主要可改進點，並提出一套在 **Tampermonkey 單檔前提** 下仍然合理、可落地的重構方向。

重點不是要求把 userscript 變成多檔執行，而是：

- **部署仍然是一支 `.user.js`**
- **開發與組織方式更模組化**
- **降低耦合與修改風險**
- **讓後續功能擴充不必一直往同一層塞**

---

## 前提說明

在 Tampermonkey 的實際使用情境裡，最後安裝的常常就是一支單一腳本。  
所以目前專案寫成單檔，本身不是錯，也不是作者刻意把 code 硬塞成一坨。

真正的問題不是「單檔」本身，而是：

> **單檔中缺乏更明確的責任邊界，導致職責過度集中。**

也就是說，**單檔可以接受，但單檔不代表所有邏輯都應該直接混在一起。**

---

## 目前架構的主要缺點

### 1. 最大問題：單一檔案承擔太多責任

這支 `facebook_group_refresh.user.js` 已經不是「腳本」而是「應用程式」了，但它還維持在單檔形態。

目前這一檔同時負責：

- 狀態管理
- 設定持久化
- DOM 抽取
- 掃描排程
- 去重
- 規則比對
- 通知發送
- UI rendering
- modal 建立
- lifecycle

這種結構短期很方便，因為 Tampermonkey 貼一檔就能跑；但中期開始會有三個問題：

- 改一個功能容易波及別處
- 很難針對單一模組做測試
- 新功能只能繼續往同一檔、同一層邏輯塞

所以它現在的問題不是「寫得亂」，而是：

> **職責過度集中。**

---

### 2. `STATE` 是全域可變中心，耦合度偏高

`STATE` 這個做法對 userscript 很常見，也不是錯；但這份 code 已經大到讓它開始變成隱性耦合源。

目前很多函式都有這種特性：

- 直接讀 `STATE.config`
- 直接改 `STATE.latestScan`
- 直接觸發 `renderPanel()`
- 直接呼叫 storage、DOM、notification、timer

這會帶來幾個架構問題：

- 函式的輸入輸出不夠明確
- 很多行為依賴「外部當下狀態」而不是函式參數
- 單看函式名稱很難知道它會不會順手改 UI、排 timer、寫 storage
- 想局部重用某段邏輯時，容易被全域狀態綁死

這類 code 在專案小的時候沒問題；但當功能多起來後，就會讓：

- 除錯變慢
- 重構變危險
- 行為變得難預測

所以問題不是有 `STATE`，而是：

> **目前 `STATE` 同時承載資料、流程控制、UI 狀態與副作用節點，範圍太大。**

---

### 3. 掃描主流程過胖，`runScan()` 承擔過多 orchestration

目前 `runScan()` 是整支腳本的核心流程，但它處理的事情已經太多：

- 判斷是否可掃描
- 決定 shortcut 或完整掃描
- 收集貼文
- parse include / exclude
- 套規則
- dedupe
- baseline 判斷
- 發送通知
- 更新歷史
- 更新 seen posts
- 更新 latest scan 狀態
- error handling
- 安排 refresh
- 觸發 render

這類函式一開始很實用，因為流程都集中在同一處；  
但當分支越來越多時，它就會變成一個「修改成本很高」的控制器。

風險在於：

- 任一功能調整都可能影響掃描主幹
- 測試粒度過粗
- 很難在不碰主流程的情況下替換其中一個子策略

也就是說，現在的 `runScan()` 比較像「一個做完所有事的總管」，而不是「組裝幾個明確模組的流程協調器」。

---

### 4. UI 層以大段 `innerHTML` 字串模板為主，維護成本偏高

目前 panel、history modal、settings modal、help modal 都是可用的，這點沒問題。  
但它們的建立方式仍然偏向：

- 一次拼整塊 HTML
- 每次 render 重建不少內容
- 事件綁定分散在建立與重畫邏輯之間
- 重複樣板偏多

這種方式在小型 userscript 裡很常見，也很有效率；  
但當 UI 功能開始增加時，會出現幾個問題：

- HTML 字串變得很長，不好維護
- 小修改常常要在模板字串中找位置
- 部分事件容易綁在重建後的節點上
- render 粒度太粗，更新一小塊資訊也可能整段重組

所以它目前不是「不能用」，而是：

> **UI 已經到達應該把「建立結構」與「更新內容」分開的規模。**

---

### 5. 生命週期與觸發來源偏分散，事件流不夠收斂

目前腳本的運作來自多種不同觸發源：

- `MutationObserver`
- `scheduleScan()`
- `scheduleRefresh()`
- `setInterval(handleRouteChange, 1000)`
- `setInterval(renderPanel, 1000)`
- 手動操作（save / start / pause / settings）

這些機制 individually 都合理，但合在一起後，事件流開始變得不夠集中。

結果是：

- 追蹤某次掃描是怎麼被觸發的，心智負擔較高
- render 與 scan 的節奏不夠統一
- 某些 guard 雖然存在，但流程入口仍然偏多
- 後續若再加「延後掃描」「條件跳過」「重試策略」，複雜度會上升很快

這代表目前專案已經從單純腳本，走到需要更清楚的「調度中心」的階段。

---

### 6. 存在不少「暫時停用但仍常駐」的邏輯，增加閱讀與維護負擔

目前 code 中有些邏輯明顯屬於：

- 曾經想做
- 部分做完
- 目前停用
- 之後可能再啟用

最典型的是：

- timestamp 抽取相關函式
- permalink / post link 相關流程
- browser-native notification exposure

這類邏輯保留不是錯，但若長期維持「主幹常駐、實際不生效」狀態，會出現問題：

- 新維護者不容易判斷哪些是現役邏輯
- 閱讀成本上升
- Debug 時容易誤以為某段程式會參與主流程
- 重構時不容易知道該不該算進去

所以這不是單純的 dead code 問題，而是：

> **主幹程式中混入太多半啟用、備用、未完成邏輯，會稀釋結構清晰度。**

---

### 7. 缺少「可獨立驗證」的純邏輯邊界

目前有不少函式其實很適合做成 pure functions，例如：

- keyword parsing
- rule matching
- post key building
- fallback id building
- notification text formatting
- history merge
- seen-post trimming
- scan result summary normalization

但現在它們仍然與 `STATE`、DOM、storage、UI 交錯在一起。

這會造成：

- 想驗證一個規則邏輯時，常常得把整個執行環境一起帶上
- 很難為真正「最穩定、最值得測」的邏輯補單元測試
- 之後若要搬去別的環境重用，幾乎無法直接抽出

這是典型的「邏輯與副作用沒有切乾淨」問題。

---

## 在單檔前提下，合理的重構原則

這裡不假設 Tampermonkey 直接多檔執行。  
前提是：

> **最後產物仍然是一支 `facebook_group_refresh.user.js`。**

重構目標是把單檔變成：

- **有清楚邊界的單檔**
- **有內部模組結構的單檔**
- **以協作與維護為優先的單檔**

### 原則 1：單檔可以，但要有模組邊界

不一定要拆成多個實體檔案，但至少要在單檔內分出明確區塊，例如：

- `Storage`
- `State`
- `Matcher`
- `Extractor`
- `Dedupe`
- `Notifier`
- `UI`
- `Scheduler`
- `App`

比起現在以「大量函式平鋪」方式存在，這種做法的好處是：

- 看 code 時知道功能歸屬
- 修改時比較知道會影響哪個區塊
- 後續如果真的要 bundle 多檔，也更容易搬

---

### 原則 2：純邏輯與副作用分開

重構時最值得先做的事，不是拆 UI，而是把**純邏輯**先抽乾淨。

例如可以先把這些變成「只吃參數、只回傳結果」的函式：

- `parseKeywordInput(rawInput)`
- `matchRules(rules, normalizedText)`
- `buildFallbackId(post)`
- `getPostKey(post)`
- `dedupeExtractedPosts(posts, limit)`
- `formatNotificationPayload(post, groupName)`
- `mergeMatchHistory(existing, incoming, limit)`

這樣做的價值很大：

- 測試容易
- 重構風險低
- 可讀性提高
- 更容易定位 bug 是邏輯錯還是環境錯

---

### 原則 3：UI 初始化一次，render 只做局部更新

目前的 modal 與 panel 可以保留，但建議改成兩層：

1. **create / mount**
   - 只建立一次 DOM 結構
   - 綁定一次事件

2. **render / update**
   - 只更新內容、顯示狀態、按鈕文字、狀態欄位

這會比現在大量用 `innerHTML` 整段重刷更穩定。

可以優先把這些拆開：

- `createPanelShell()`
- `bindPanelEvents()`
- `renderPanelStatus(viewModel)`
- `renderDebugPanel(viewModel)`
- `renderHistoryModal(historyItems)`
- `renderSettingsModal(config)`

這樣就算仍在同一檔，也會比現在更好維護。

---

### 原則 4：把掃描流程拆成數個小步驟，由總控函式協調

`runScan()` 不應自己做完所有事。  
它比較適合改成：

1. 取得掃描上下文
2. 收集貼文
3. 套規則
4. 做 dedupe / baseline 判斷
5. 發送通知
6. 寫回 state
7. 觸發 render

也就是說，讓 `runScan()` 像這樣：

```js
async function runScan(reason) {
  const context = AppContext.getScanContext(reason);
  const collected = await ScanEngine.collect(context);
  const evaluated = ScanEngine.evaluate(collected, context);
  const result = await ScanEngine.commit(evaluated, context);
  AppState.applyScanResult(result);
  UI.render(AppState.getViewModel());
}
```

好處是：

- 主流程更短
- 子策略比較容易替換
- 掃描問題比較容易定位到哪個階段

---

### 原則 5：把觸發來源統一導向同一個 scheduler 入口

現在的掃描觸發來源很多，建議收斂成：

- `Scheduler.requestScan(reason)`
- `Scheduler.requestRender(reason)`
- `Scheduler.scheduleRefresh()`

也就是說，不管是：

- mutation
- route change
- manual start
- save
- startup

都先走 scheduler，而不是大家各自決定何時執行、是否 debounce、是否跳過。

這樣可把節奏控制集中在同一層，減少時序問題。

---

### 原則 6：為暫停中的功能建立明確狀態，而不是讓它混在主幹

像 timestamp、permalink 這類目前停用的能力，建議改成其中一種：

- 明確的 feature flag
- 集中放到 `experimental` 區塊
- 暫時移出主幹，等重新啟用時再合回

例如：

```js
const FEATURE_FLAGS = {
  enableTimestampExtraction: false,
  enablePermalinkExtraction: false,
  enableBrowserNotificationSetting: false,
};
```

這樣閱讀者至少一眼就知道：

- 這段不是現在主流程的有效功能
- 保留它是有意識的，不是忘了刪

---

## 單檔前提下的建議內部分層

下面是一個**仍然只有一個 `.user.js` 檔案**，但內部結構更合理的寫法。

```js
(function () {
  "use strict";

  const AppConfig = (() => {
    // defaults, storage keys, feature flags
    return { ... };
  })();

  const Storage = (() => {
    // GM storage / localStorage migration / persistence helpers
    return {
      loadConfig,
      saveConfig,
      loadSeenPosts,
      saveSeenPosts,
      loadHistory,
      saveHistory,
    };
  })();

  const State = (() => {
    // runtime state only
    const state = { ... };
    return {
      get,
      patch,
      resetForRoute,
      applyScanResult,
      getViewModel,
    };
  })();

  const Matcher = (() => {
    // parseKeywordInput / matchRules / normalizeForMatch
    return {
      parseRules,
      matchPost,
      normalizeText,
      normalizeForMatch,
    };
  })();

  const Dedupe = (() => {
    // getPostKey / buildFallbackId / seen-post logic / history merge
    return {
      getPostKey,
      hasSeenPost,
      markPostSeen,
      clearSeenPostsForGroup,
      mergeHistory,
    };
  })();

  const Extractor = (() => {
    // Facebook DOM extraction only
    return {
      isSupportedGroupPage,
      getCurrentGroupId,
      getCurrentGroupName,
      collectVisiblePosts,
      collectPostsAcrossWindows,
    };
  })();

  const Notifier = (() => {
    // GM_notification / ntfy / Discord webhook
    return {
      notifyMatch,
      sendTestNotification,
      buildNotificationPayload,
    };
  })();

  const UI = (() => {
    // panel shell / modal shell / renderers / event bindings
    return {
      mount,
      render,
      openHistory,
      openSettings,
    };
  })();

  const Scheduler = (() => {
    // scan debounce / refresh timer / route settle
    return {
      requestScan,
      requestRender,
      scheduleRefresh,
      clearRefresh,
      handleRouteChange,
    };
  })();

  const ScanEngine = (() => {
    // orchestration logic
    return {
      runScan,
      collect,
      evaluate,
      commit,
    };
  })();

  const App = (() => {
    function start() {
      UI.mount();
      Scheduler.requestScan("startup");
      Scheduler.scheduleRefresh();
    }

    return { start };
  })();

  App.start();
})();
```

這仍然是**單一檔案**，但和現在最大的差別在於：

- 讀 code 時知道每段責任
- 可以逐步重構，而不是一次大改
- 後續就算真的要外部 bundle，也幾乎可直接搬

---

## 建議的單檔重構順序

不建議一次大改。  
比較穩的做法是分三輪。

### 第一輪：只整理邊界，不改功能

目標：

- 不改 UI 行為
- 不改通知行為
- 不改 DOM selector
- 只把函式依責任分組

先完成：

- 建 `Storage`
- 建 `Matcher`
- 建 `Dedupe`
- 建 `Notifier`
- 建 `UI`
- 建 `Scheduler`

這一輪完成後，程式行為應該幾乎完全相同，但閱讀性會提升很多。

---

### 第二輪：把 `runScan()` 拆成 collect / evaluate / commit

目標：

- 保持相同行為
- 明確分出掃描流程階段

建議拆成：

- `collectScanInputs()`
- `collectPosts()`
- `evaluatePosts()`
- `commitNotificationsAndState()`
- `finalizeScan()`

這一輪完成後，主流程會變清楚，之後要改 shortcut、baseline、dedupe 也比較安全。

---

### 第三輪：把 UI 改成 shell + render

目標：

- 減少 `innerHTML` 大量重建
- 讓 panel / modal 成為穩定節點

這一輪可以優先處理：

- panel 主體
- debug 區塊
- settings modal
- history modal

help modal 倒是可以先放後面，因為它們比較靜態。

---

## 哪些函式最值得優先抽成 pure functions

如果只選一批「最值得先整理」的，我會建議這些：

### Matcher 類
- `normalizeText`
- `normalizeForMatch`
- `parseKeywordInput`
- `matchRules`

### Dedupe 類
- `normalizeForKey`
- `buildStableTextSignature`
- `buildFallbackId`
- `getPostKey`
- `getLegacyPostKey`
- `dedupeExtractedPosts`

### Formatting 類
- `truncate`
- `buildCompactNotificationBody`
- `buildRemoteNotificationBody`
- `formatNotificationTimestamp`
- `formatRefreshModeLabel`

### History / merge 類
- `merge incoming match history`
- `trim seen post store`
- `trim global history`

這些邏輯穩定、可測、跟 DOM 不直接耦合，重構投報率最高。

---

## 單檔前提下，不建議做的事

### 1. 不建議一開始就全面改成 class-heavy 架構
這類腳本本質上是事件驅動、DOM 導向，過度 OOP 不一定比較清楚。  
用 module object / closure pattern 會更自然。

### 2. 不建議先碰 selector 細節
DOM 抽取是最脆弱的部分。  
如果結構整理和 selector 調整同時做，之後出 bug 很難判斷是哪一層出了問題。

### 3. 不建議一次改完 UI 與 scan flow
這兩塊都牽涉面大。  
先切邏輯邊界，再切 UI，風險較低。

---

## 最實際的重構目標

如果用一句話描述最適合這個專案的方向：

> **不是把單檔拆掉，而是把單檔內部變成「有分層的單檔應用」。**

也就是：

- 最後仍可直接貼進 Tampermonkey
- 不需要強制改成多檔部署
- 但內部要讓 storage、scan、extract、notify、UI、scheduler 各司其職

這樣一來，未來你要加：

- 更多通知通道
- 更多規則語法
- 更穩的 post link 抽取
- 更完整的 debug 資訊
- 更細的設定項

都不至於繼續把 complexity 堆在同一個大函式與同一塊全域狀態上。

---

## 總結

這個專案目前的問題，不是因為它是 Tampermonkey 單檔腳本。  
真正的問題是：

- 單檔承擔過多責任
- `STATE` 耦合太廣
- `runScan()` 過胖
- UI 與流程層混得太近
- 事件流入口過多
- 有些停用邏輯常駐主幹
- 純邏輯與副作用尚未切開

而最合理的改法也不是直接要求多檔，而是：

1. **先在單檔中建立模組邊界**
2. **把 pure logic 抽出**
3. **讓 scan orchestration 變薄**
4. **讓 UI 改為 shell + render**
5. **讓 scheduler 成為統一入口**

這樣你仍然保有 Tampermonkey 單檔安裝的便利性，但 codebase 的可維護性會明顯提升。