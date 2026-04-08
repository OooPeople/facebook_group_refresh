# V1 規格說明

這份文件最初是規劃階段的規格草案。
目前其中大部分內容已落地到 `src/facebook_group_refresh.user.js`。

## 目標

建立一支執行於 Facebook 社團頁面的 Tampermonkey userscript，具備以下能力：

- 保守地觀察或刷新目前社團頁面
- 抽取少量最近貼文
- 套用包含與排除關鍵字規則
- 對通知做穩定去重
- 顯示本地控制面板與 debug 面板
- 只透過使用者明確啟用的通知通道送出提醒

## V1 範圍

- 一次只處理一個 Facebook 社團頁面
- 一個使用者在目前瀏覽器中的單一 userscript
- 以關鍵字為核心的新貼文偵測
- 僅使用本地狀態
- 只做保守頁面互動：刷新、溫和捲動載入更多貼文、展開折疊貼文文字，以及本地瀏覽器儲存

## 不在範圍內

- 自動登入
- 自動留言、按讚、發文、加入社團或任何互動行為
- 背景 headless 爬取
- OCR、CAPTCHA 處理或 stealth automation
- 多帳號協調

## 使用者面板

面板應固定顯示在頁面上，並盡量不遮擋主要內容。

### 必要控制項

- `包含關鍵字` 輸入框
- `包含關鍵字說明` 按鈕
- `排除關鍵字` 輸入框
- `儲存` 按鈕
- `開始 / 暫停監控` 按鈕
- `查看紀錄` 按鈕
- `設定` 按鈕
- `除錯面板切換` 按鈕

### 建議狀態區

- 目前監控狀態：監控中或已暫停
- 最近一次掃描時間
- 最近一次掃描取得的貼文數
- 本地已保存的 seen post 數量
- 通知通道狀態

## 關鍵字語法

使用與前面討論一致的簡單規則。

- 分號 `;` 表示 OR
- 空格表示單一規則內的 AND

範例：

- `rock;6880;5880`
  - 任一 token 出現即視為命中
- `rock 6880;rock 5880`
  - 代表 `rock` 與 `6880` 同時出現，或 `rock` 與 `5880` 同時出現

### 包含規則

- 若 include 規則為空，則在排除規則判斷前，所有貼文都先視為可通知
- 否則至少要有一條 include 規則命中

### 排除規則

- 只要任一 exclude 規則命中，即使 include 命中也要抑制通知

## 設定模型

V1 應將設定保存在 userscript 可管理的本地儲存中，並使用清楚的 key。
目前實作是以 Tampermonkey storage 為主，並保留舊版 browser storage migration 支援。

建議設定項目：

- 包含關鍵字
- 排除關鍵字
- `ntfy` topic
- Discord Webhook URL
- 監控暫停旗標
- debug 面板是否顯示
- 最小刷新秒數
- 最大刷新秒數
- 固定刷新秒數
- 是否啟用 refresh jitter
- 是否啟用自動載入更多貼文
- 每輪掃描最多目標貼文數
- 本地通知與可選遠端通知的相關設定

## 貼文資料模型

每篇抽出的貼文應正規化成小型物件：

```js
{
  postId: "",
  permalink: "",
  author: "",
  text: "",
  normalizedText: "",
  timestampText: "",
  timestampEpoch: null,
  groupId: "",
  source: "",
  extractedAt: ""
}
```

說明：

- `postId` 應優先取自 permalink 或可辨識的內部連結 ID
- `normalizedText` 用於關鍵字比對
- `source` 記錄本次抽取成功所使用的策略

## 掃描策略

V1 採混合式策略：

1. 優先依賴被動觀察
2. 低頻隨機刷新作為保守 fallback

### 被動觀察

- 使用 `MutationObserver` 偵測 feed 新增內容
- 對重複 DOM churn 做 debounce 後再掃描
- 避免每次微小 mutation 都整頁重掃

### 主動刷新 fallback

- 以保守區間安排隨機刷新
- 只有在監控啟用時才安排刷新
- 目前實作是在每次掃描完成後重新排 refresh，而不是使用獨立的「最近 mutation 掃描就跳過 refresh」規則
- 瀏覽器背景分頁節流可能延後 refresh callback，因此刷新時間應視為 best-effort，而不是精準保證

## 抽取策略

Extractor 應優先使用較穩定的結構錨點，再退回脆弱的 CSS 類別。

優先順序：

1. 類似 article 的容器或穩定結構區塊
2. permalink anchor
3. timestamp link
4. 貼文本文文字容器

Extractor 每輪只應檢查最近 N 篇貼文。

目前實作目標：

- 在多個可見 feed window 中累積使用者設定數量的唯一貼文
- seen-post dedupe 只保留目前監控社團的 bucket
- seen-post history 上限為 `目標貼文數 * 2`
- match-history 全域保留 10 筆，並在每筆紀錄中顯示社團名稱
- permalink 與 timestamp 抽取邏輯仍保留，但目前實作偏保守，當 Facebook DOM 訊號不夠可靠時，這些欄位可能留空

## 比對流程

對每篇正規化貼文：

1. 建立 normalized text
2. 若有穩定 post ID，優先做 dedupe 檢查
3. 評估 include 規則
4. 評估 exclude 規則
5. 若命中且未被排除，則通知並標記為 seen

## 去重策略

建議優先順序：

1. 來自 permalink 的穩定 post ID
2. permalink 字串本身
3. 作者、時間文字與 normalized text signature 組成的 fallback composite key

seen-post store 應：

- 保留有上限的歷史
- 以 group 為命名空間
- 記錄通知或 seen 時間

目前實作補充：

- seen-post dedupe 仍以 group 為命名空間，但只保留目前 group 的 bucket
- match-history 現在是全域清單，而不是每個 group 各自一個 bucket

## 通知行為

V1 通知通道：

- 本地桌面通知
- 可選的 `ntfy`
- 可選的 Discord Webhook

規則：

- 測試通知不得將假貼文寫入 dedupe storage
- 同一篇貼文重複掃描不得重複通知
- 通知文字應包含足夠上下文，讓使用者能快速判斷並開啟貼文

建議通知內容：

- 社團名稱
- 作者
- 命中的關鍵字或規則
- 簡短文字預覽
- 貼文連結

目前實作補充：

- `GM_notification` 本地桌面通知預設啟用
- browser-native notification 程式碼仍保留，但目前未正式暴露成使用者設定
- `ntfy` 為選填，只有設定 topic 才會發送
- Discord Webhook 為選填，只有設定 URL 才會發送

## Debug 面板

Debug 面板應可由使用者切換，且預設隱藏。

### 必要 debug 欄位

- 目前頁面 URL
- 是否辨識為支援的 Facebook 群組頁
- 監控狀態
- 目前生效中的 include / exclude 關鍵字字串
- 最近一次掃描時間
- refresh timer 狀態
- 最近一次取得的貼文數
- 每篇貼文摘要：
  - post ID
  - 作者
  - timestamp text
  - 短文字預覽
  - 命中的 include 規則
  - 命中的 exclude 規則
  - dedupe 結果
  - extraction source
- 最後通知狀態
- 最近一次錯誤訊息

## 錯誤處理

V1 應採 fail soft 策略。

- selector 失敗不應讓整支腳本崩潰
- 通知失敗應可從 debug 診斷
- 本地儲存壞掉時應能安全回到預設值

## 本地儲存 key

建議前綴：

- `fb_group_refresh_*`

建議 key：

- `fb_group_refresh_include`
- `fb_group_refresh_exclude`
- `fb_group_refresh_ntfy_topic`
- `fb_group_refresh_paused`
- `fb_group_refresh_debug_visible`
- `fb_group_refresh_auto_load_more_posts`
- `fb_group_refresh_seen_posts`
- `fb_group_refresh_match_history`
- `fb_group_refresh_last_notification`
- `fb_group_refresh_refresh_range`

## 手動驗證清單

在視為 V1 可用前，應確認：

1. 支援的 group page 上能正常顯示 panel
2. 儲存關鍵字後重新整理仍會保留
3. 暫停按鈕能阻止 refresh 與 scan
4. 從暫停切回開始時，目前實作的語義是「重新開始目前社團監控」：會清掉該社團的 seen baseline，並在不 reload 的情況下觸發乾淨掃描
5. 測試通知可獨立運作
6. debug toggle 能正常顯示與隱藏面板
7. 新的命中貼文只會通知一次
8. 同一篇貼文不會重複通知
9. exclude 規則能成功抑制通知
10. selector 失敗時仍能從 debug 面板診斷

## 開放風險

- Facebook DOM 結構可能頻繁變動
- 不同 group post 變體的 permalink 抽取可能不同
- 不同語系 UI 可能影響文字型 selector
- infinite-scroll feed 更新可能產生高噪音 mutation
- timestamp extraction 目前在實作中仍偏保守，因為 Facebook DOM heuristic 仍可能把留言時間誤當貼文時間
- 當分頁隱藏或視窗最小化時，瀏覽器背景節流可能延後 refresh timer
