# Git Commit 訊息規範

本專案的 Git commit message 採用 Conventional Commits 風格，並統一使用以下格式：

```text
<type>(<scope>): <summary>
```

若不需要 `scope`，可省略為：

```text
<type>: <summary>
```

## 語言規範

- `type` 一律使用英文小寫關鍵字。
- `scope` 一律使用英文或專案內一致的模組名稱。
- `summary`、`body`、`footer` 一律使用繁體中文撰寫。
- 不要在同一類模組中混用不一致的中英文命名。

## 撰寫原則

- `summary` 應簡短明確，直接描述這次提交做了什麼。
- 以簡潔、偏命令式或陳述式的方式撰寫。
- 不要在 `summary` 結尾加句號。
- 避免模糊訊息，例如：
  - `update`
  - `fix bug`
  - `modify code`
  - `revise file`
- 一次 commit 應盡量聚焦單一職責。

## 建議結構

- `type`：變更類型
- `scope`：受影響模組、功能或檔案區域，可省略
- `summary`：以繁體中文簡述本次修改

## 類型定義

### feat

新增功能或明確的功能性增強。

範例：

- `feat(auth): 新增使用者登入流程`
- `feat(readme): 補充專案功能與操作說明`

### fix

修復錯誤、異常行為或不正確結果。

範例：

- `fix(api): 修正查詢參數為空時的例外錯誤`
- `fix(ui): 修正按鈕在手機版無法點擊的問題`

### docs

僅文件變更，不涉及程式邏輯修改。

範例：

- `docs: 更新安裝與執行說明`
- `docs(readme): 補上系統架構與結果展示段落`

### style

不影響程式邏輯的格式調整，例如排版、縮排、空白或引號風格。

範例：

- `style: 統一 Python 檔案排版格式`
- `style(frontend): 調整元件縮排與換行格式`

### refactor

重構程式碼，但不新增功能，也不修復 bug。

範例：

- `refactor(parser): 拆分資料解析流程以提升可讀性`
- `refactor(model): 簡化特徵前處理函式結構`

### perf

效能優化；本質上屬於 refactor，但目標是提升效能。

範例：

- `perf(search): 降低查詢時的重複計算`
- `perf(image): 優化圖片載入速度`

### test

新增、修改或修正測試。

範例：

- `test(api): 新增登入失敗情境測試`
- `test(model): 補上資料前處理單元測試`

### chore

雜務性變更，不影響產品功能本身，通常是工具、設定或維護類調整。

範例：

- `chore: 更新 .gitignore`
- `chore(config): 調整專案設定檔`
- `chore: 整理資料夾結構與命名`

### ci

CI/CD 相關變更，例如 GitHub Actions、workflow 或 pipeline。

範例：

- `ci: 新增 GitHub Actions 自動測試流程`
- `ci: 調整部署 workflow 觸發條件`

### build

影響建置系統或外部依賴的變更。

範例：

- `build: 更新專案依賴版本`
- `build: 調整 Docker 建置流程`

### revert

回復先前提交。

範例：

- `revert: 回復「feat(api): 新增批次查詢功能」`

## scope 使用建議

常見可用的 `scope`：

- `auth`
- `api`
- `ui`
- `backend`
- `frontend`
- `model`
- `dataset`
- `training`
- `inference`
- `readme`
- `config`
- `scripts`

若此次修改跨多個模組，且沒有明確主體，可省略 `scope`。

## 重大變更

若此次提交包含破壞性變更，可使用：

```text
feat(api)!: 調整回傳欄位命名規則
```

或在 footer 補充：

```text
BREAKING CHANGE: API 回傳格式已改動，需同步更新前端解析邏輯
```

## body / footer 使用時機

當 `summary` 無法充分說明背景時，可補充 `body`：

- 為何要改
- 舊行為與新行為差異
- 是否影響既有流程
- 是否需要遷移或注意事項

範例：

```text
fix(parser): 修正多空白字串解析錯誤

原先在連續空白輸入下會產生欄位錯位，
本次改為先正規化空白後再進行切分，
避免資料前處理結果不一致
```

## 禁止使用的模糊訊息

避免以下寫法：

- `feat: update feature`
- `fix: fix bug`
- `chore: modify files`
- `docs: update readme`

## 推薦輸出規則

請始終遵守以下規則：

1. `type` 必須是英文小寫
2. `summary` 必須是繁體中文
3. `summary` 必須具體，不可空泛
4. 除非有明確模組，否則不要濫用 `scope`
5. 一次 commit 只描述一件主要事情
6. 若同時修改功能與文件，優先描述主要變更
7. 若只是格式調整，不要誤標為 `feat` 或 `fix`
