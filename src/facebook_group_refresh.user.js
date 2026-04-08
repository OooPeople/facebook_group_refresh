// ==UserScript==
// @name         Facebook Group Refresh Monitor
// @namespace    http://tampermonkey.net/
// @version      2026-04-04
// @description  Monitor Facebook group posts for keyword matches and notify on new posts.
// @author       OooPeople
// @homepageURL  https://github.com/OooPeople/facebook_group_refresh
// @match        https://www.facebook.com/groups/*
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      ntfy.sh
// @connect      discord.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // 啟動防重複執行保護，避免 userscript 被 Facebook 動態重掛時重複初始化。
  if (window.__FB_GROUP_REFRESH_RUNNING__) return;
  window.__FB_GROUP_REFRESH_RUNNING__ = true;

  // 持久化設定鍵、預設值、掃描限制與執行期狀態。
  const STORAGE_KEYS = {
    include: "fb_group_refresh_include",
    exclude: "fb_group_refresh_exclude",
    paused: "fb_group_refresh_paused",
    debugVisible: "fb_group_refresh_debug_visible",
    ntfyTopic: "fb_group_refresh_ntfy_topic",
    discordWebhook: "fb_group_refresh_discord_webhook",
    latestTopPosts: "fb_group_refresh_latest_top_posts",
    latestScanPosts: "fb_group_refresh_latest_scan_posts",
    autoLoadMorePosts: "fb_group_refresh_auto_load_more_posts",
    seenPosts: "fb_group_refresh_seen_posts",
    matchHistory: "fb_group_refresh_match_history",
    lastNotification: "fb_group_refresh_last_notification",
    refreshRange: "fb_group_refresh_refresh_range",
  };

  const DEFAULT_CONFIG = {
    includeKeywords: "4/4 熱區; 4/4 109; 4/4 117",
    excludeKeywords: "徵",
    paused: true,
    debugVisible: false,
    ntfyTopic: "",
    discordWebhook: "",
    maxPostsPerScan: 5,
    scanDebounceMs: 1500,
    minRefreshSec: 25,
    maxRefreshSec: 35,
    jitterEnabled: true,
    fixedRefreshSec: 60,
    autoLoadMorePosts: true,
    loadMoreMode: "scroll",
    matchHistoryGlobalLimit: 10,
    enableGmNotification: true,
    enableBrowserNotification: false,
  };

  const SCAN_LIMITS = {
    minTargetPosts: 1,
    maxTargetPosts: 10,
    minCandidateTextLength: 8,
    candidateMultiplier: 6,
    seenPostMultiplier: 2,
    maxWindowMultiplier: 2,
  };

  const FEED_SORT_LABELS = ["新貼文", "最相關", "最新動態"];
  const ROUTE_SETTLE_MS = 3000;

  const STATE = {
    config: loadConfig(),
    initializedGroups: new Set(),
    latestScan: null,
    latestPosts: [],
    latestError: "",
    latestNotification: loadJson(STORAGE_KEYS.lastNotification, null),
    observer: null,
    scanTimer: null,
    refreshTimer: null,
    refreshDeadline: null,
    routeTimer: null,
    renderTimer: null,
    lastUrl: location.href,
    lastRouteChangeAt: 0,
    lastRouteGroupId: getCurrentGroupId(),
    panelMounted: false,
    isScanning: false,
    isLoadingMorePosts: false,
  };

  // 設定載入與儲存包裝，統一處理 Tampermonkey storage / legacy localStorage。
  // 從持久化儲存讀回目前設定，並將舊格式 refreshRange 合併回執行設定。
  function loadConfig() {
    const refreshRange = loadJson(STORAGE_KEYS.refreshRange, null);
    return {
      ...DEFAULT_CONFIG,
      includeKeywords: loadString(STORAGE_KEYS.include, DEFAULT_CONFIG.includeKeywords),
      excludeKeywords: loadString(STORAGE_KEYS.exclude, DEFAULT_CONFIG.excludeKeywords),
      ntfyTopic: loadString(STORAGE_KEYS.ntfyTopic, DEFAULT_CONFIG.ntfyTopic),
      discordWebhook: loadString(STORAGE_KEYS.discordWebhook, DEFAULT_CONFIG.discordWebhook),
      paused: loadBoolean(STORAGE_KEYS.paused, DEFAULT_CONFIG.paused),
      debugVisible: loadBoolean(STORAGE_KEYS.debugVisible, DEFAULT_CONFIG.debugVisible),
      minRefreshSec: refreshRange?.min ?? DEFAULT_CONFIG.minRefreshSec,
      maxRefreshSec: refreshRange?.max ?? DEFAULT_CONFIG.maxRefreshSec,
      jitterEnabled: refreshRange?.jitterEnabled ?? DEFAULT_CONFIG.jitterEnabled,
      fixedRefreshSec: refreshRange?.fixedSec ?? DEFAULT_CONFIG.fixedRefreshSec,
      maxPostsPerScan: clampTargetPostCount(refreshRange?.maxPostsPerScan ?? DEFAULT_CONFIG.maxPostsPerScan),
      autoLoadMorePosts: loadBoolean(STORAGE_KEYS.autoLoadMorePosts, refreshRange?.autoLoadMorePosts ?? DEFAULT_CONFIG.autoLoadMorePosts),
      loadMoreMode: DEFAULT_CONFIG.loadMoreMode,
    };
  }

  function saveRefreshSettings() {
    saveJson(STORAGE_KEYS.refreshRange, {
      min: STATE.config.minRefreshSec,
      max: STATE.config.maxRefreshSec,
      jitterEnabled: STATE.config.jitterEnabled,
      fixedSec: STATE.config.fixedRefreshSec,
      maxPostsPerScan: clampTargetPostCount(STATE.config.maxPostsPerScan),
      autoLoadMorePosts: STATE.config.autoLoadMorePosts,
    });
    saveNtfyTopicSetting(STATE.config.ntfyTopic);
    saveDiscordWebhookSetting(STATE.config.discordWebhook);
    saveString(STORAGE_KEYS.autoLoadMorePosts, String(STATE.config.autoLoadMorePosts));
  }

  // 以字串形式讀取儲存值，讀不到時回傳預設值。
  function loadString(key, fallback) {
    try {
      const value = loadStoredRawValue(key);
      return value == null ? fallback : String(value);
    } catch (error) {
      return fallback;
    }
  }

  // 以布林形式讀取儲存值，僅 "true" 視為 true。
  function loadBoolean(key, fallback) {
    try {
      const raw = loadStoredRawValue(key);
      if (raw == null) return fallback;
      return raw === "true";
    } catch (error) {
      return fallback;
    }
  }

  // 以 JSON 形式讀取儲存值，解析失敗時回退為預設值。
  function loadJson(key, fallback) {
    try {
      const raw = loadStoredRawValue(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  // 將值以字串形式寫入持久化儲存。
  function saveString(key, value) {
    saveStoredRawValue(key, String(value));
  }

  // 將物件序列化為 JSON 後寫入持久化儲存。
  function saveJson(key, value) {
    saveStoredRawValue(key, JSON.stringify(value));
  }

  // 統一移除指定的持久化鍵值。
  function removeStorageKey(key) {
    removeStoredRawValue(key);
  }

  // 檢查目前環境是否可使用 Tampermonkey GM storage API。
  function hasGmStorage() {
    return (
      typeof GM_getValue === "function" &&
      typeof GM_setValue === "function" &&
      typeof GM_deleteValue === "function"
    );
  }

  // 先讀 GM storage；若沒有資料則嘗試舊版 localStorage，並在成功時做一次性搬移。
  function loadStoredRawValue(key) {
    const gmValue = loadGmRawValue(key);
    if (gmValue != null) {
      return gmValue;
    }

    const legacyValue = loadLegacyLocalStorageValue(key);
    if (legacyValue == null) {
      return null;
    }

    // One-time migration from facebook.com localStorage to Tampermonkey storage.
    saveStoredRawValue(key, legacyValue);
    removeLegacyLocalStorageValue(key);
    return legacyValue;
  }

  // 優先寫入 GM storage，失敗時退回 localStorage 備援。
  function saveStoredRawValue(key, value) {
    const normalized = String(value);

    if (hasGmStorage()) {
      try {
        GM_setValue(key, normalized);
      } catch (error) {
        saveLegacyLocalStorageValue(key, normalized);
        return;
      }

      removeLegacyLocalStorageValue(key);
      return;
    }

    saveLegacyLocalStorageValue(key, normalized);
  }

  // 同步清掉 GM storage 與舊版 localStorage 的同名鍵值。
  function removeStoredRawValue(key) {
    if (hasGmStorage()) {
      try {
        GM_deleteValue(key);
      } catch (error) {
        // Ignore GM storage cleanup errors and continue clearing legacy storage.
      }
    }

    removeLegacyLocalStorageValue(key);
  }

  // 安全讀取 GM storage 原始值。
  function loadGmRawValue(key) {
    if (!hasGmStorage()) return null;

    try {
      const value = GM_getValue(key, null);
      return value == null ? null : String(value);
    } catch (error) {
      return null;
    }
  }

  // 安全讀取舊版 localStorage 原始值。
  function loadLegacyLocalStorageValue(key) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? null : String(value);
    } catch (error) {
      return null;
    }
  }

  // 將值寫入舊版 localStorage，僅作為備援儲存方案。
  function saveLegacyLocalStorageValue(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (error) {
      // Ignore legacy storage write errors.
    }
  }

  // 從舊版 localStorage 移除指定鍵值。
  function removeLegacyLocalStorageValue(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // Ignore legacy storage cleanup errors.
    }
  }

  // 文字正規化與小型共用工具，供比對、去重、UI 顯示共用。
  // 移除零寬字元、壓縮空白並去頭尾空白，讓 DOM 抽出的文字可穩定比較。
  function normalizeText(value) {
    return String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 轉成小寫的比對用文字。
  function normalizeForMatch(value) {
    return normalizeText(value).toLowerCase();
  }

  // 轉成較穩定的 key 片段，只保留中英文與數字。
  function normalizeForKey(value) {
    return normalizeForMatch(value).replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "");
  }

  // 限制單次目標貼文數，避免 UI 設定超出掃描安全範圍。
  function clampTargetPostCount(value) {
    return Math.min(
      SCAN_LIMITS.maxTargetPosts,
      Math.max(
        SCAN_LIMITS.minTargetPosts,
        Math.floor(Number(value) || DEFAULT_CONFIG.maxPostsPerScan)
      )
    );
  }

  // 根據目標貼文數推估候選容器收集上限，避免抓太少造成漏文。
  function getCandidateCollectionLimit(targetCount = STATE.config.maxPostsPerScan) {
    return Math.max(12, clampTargetPostCount(targetCount) * SCAN_LIMITS.candidateMultiplier);
  }

  // 安全掃描上限跟著目標貼文數動態調整，目前採用目標篇數 * 2。
  function getDynamicMaxWindows(targetCount = STATE.config.maxPostsPerScan) {
    return clampTargetPostCount(targetCount) * SCAN_LIMITS.maxWindowMultiplier;
  }

  // 已看過貼文的去重保留數量跟著目標貼文數動態調整，目前採用目標篇數 * 2。
  function getDynamicSeenPostLimit(targetCount = STATE.config.maxPostsPerScan) {
    return clampTargetPostCount(targetCount) * SCAN_LIMITS.seenPostMultiplier;
  }

  // 讀取並正規化已保存的 ntfy topic。
  function getPersistedNtfyTopic() {
    return normalizeText(loadString(STORAGE_KEYS.ntfyTopic, DEFAULT_CONFIG.ntfyTopic));
  }

  // 保存 ntfy topic；空字串時直接移除設定。
  function saveNtfyTopicSetting(value) {
    const topic = normalizeText(value);
    STATE.config.ntfyTopic = topic;

    if (topic) {
      saveString(STORAGE_KEYS.ntfyTopic, topic);
    } else {
      removeStorageKey(STORAGE_KEYS.ntfyTopic);
    }
  }

  // 讀取並正規化已保存的 Discord Webhook URL。
  function getPersistedDiscordWebhook() {
    return normalizeText(loadString(STORAGE_KEYS.discordWebhook, DEFAULT_CONFIG.discordWebhook));
  }

  // 保存 Discord Webhook URL；空字串時直接移除設定。
  function saveDiscordWebhookSetting(value) {
    const webhook = normalizeText(value);
    STATE.config.discordWebhook = webhook;

    if (webhook) {
      saveString(STORAGE_KEYS.discordWebhook, webhook);
    } else {
      removeStorageKey(STORAGE_KEYS.discordWebhook);
    }
  }

  // UI 文字輸出前做最基本的 HTML escape，避免 debug / history 面板插入未轉義內容。
  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  // 跳脫正則特殊字元，讓關鍵字可安全用於高亮比對。
  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // 使用者在面板輸入時，先更新記憶體中的草稿設定，不立刻寫入持久化儲存。
  function persistDraftInputs() {
    const panel = document.getElementById("fb-group-refresh-panel");
    if (!panel) return;

    const includeEl = panel.querySelector("#fbgr-include");
    const excludeEl = panel.querySelector("#fbgr-exclude");
    if (!includeEl || !excludeEl) return;

    STATE.config.includeKeywords = normalizeText(includeEl.value);
    STATE.config.excludeKeywords = normalizeText(excludeEl.value);
  }

  // 判斷 include / exclude 文字是否與已儲存值不同，用於顯示未儲存提示。
  function hasUnsavedKeywordChanges() {
    const panel = document.getElementById("fb-group-refresh-panel");
    if (!panel) return false;

    const includeEl = panel.querySelector("#fbgr-include");
    const excludeEl = panel.querySelector("#fbgr-exclude");
    if (!includeEl || !excludeEl) return false;

    const currentInclude = normalizeText(includeEl.value);
    const currentExclude = normalizeText(excludeEl.value);
    const savedInclude = loadString(STORAGE_KEYS.include, DEFAULT_CONFIG.includeKeywords);
    const savedExclude = loadString(STORAGE_KEYS.exclude, DEFAULT_CONFIG.excludeKeywords);

    return currentInclude !== savedInclude || currentExclude !== savedExclude;
  }

  // 將長文字裁切成固定長度，避免通知或 debug 面板過長。
  function truncate(value, maxLen) {
    const text = String(value || "");
    return text.length <= maxLen ? text : `${text.slice(0, maxLen - 3)}...`;
  }

  // 小型 async 延遲工具，配合 DOM 展開與滾動等待使用。
  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  // 複製 debug 內容到剪貼簿，先走 Clipboard API，失敗才退回 execCommand。
  async function copyTextToClipboard(text) {
    const normalized = String(text || "");
    if (!normalized) return false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(normalized);
        return true;
      }
    } catch (error) {
      // Fallback to execCommand below.
    }

    const textarea = document.createElement("textarea");
    textarea.value = normalized;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    } finally {
      textarea.remove();
    }

    return copied;
  }

  // 頁面與群組上下文判斷，確認目前是否位於可掃描的 Facebook 群組頁。
  // 從網址路徑抓出目前群組 ID。
  function getCurrentGroupId() {
    const match = location.pathname.match(/^\/groups\/([^/?#]+)/i);
    return match ? match[1] : "";
  }

  // 只允許在 facebook.com/groups/* 頁面啟用掃描。
  function isSupportedGroupPage() {
    if (location.hostname !== "www.facebook.com") return false;
    const groupId = getCurrentGroupId();
    return Boolean(groupId);
  }

  // 嘗試抓取目前社團名稱，優先使用指向當前社團首頁的連結文字。
  function getCurrentGroupName() {
    if (!isSupportedGroupPage()) return "";

    const groupId = getCurrentGroupId();
    const exactPath = `/groups/${groupId}`;
    const candidates = [];
    const anchors = document.querySelectorAll(`a[href*="/groups/${groupId}"]`);

    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLAnchorElement)) continue;

      const text = normalizeText(anchor.innerText || anchor.textContent || "");
      if (!text || text.length < 2 || text.length > 120) continue;

      let pathname = "";
      try {
        pathname = new URL(anchor.href || anchor.getAttribute("href") || "", location.origin)
          .pathname
          .replace(/\/+$/, "");
      } catch (error) {
        pathname = "";
      }

      let score = 0;
      if (pathname === exactPath) score += 5;
      if (isVisibleElement(anchor)) score += 2;

      const rect = anchor.getBoundingClientRect();
      if (rect.top >= -40 && rect.top <= Math.max(240, Math.round(window.innerHeight * 0.45))) {
        score += 2;
      }

      score += Math.min(3, Math.floor(text.length / 8));

      candidates.push({ text, score });
    }

    candidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
    if (candidates.length) {
      return candidates[0].text;
    }

    const ogTitle = normalizeText(
      document.querySelector('meta[property="og:title"]')?.getAttribute("content") || ""
    );
    if (ogTitle) {
      return ogTitle.replace(/\s*\|\s*Facebook\s*$/i, "").trim();
    }

    const title = normalizeText(document.title || "");
    if (title) {
      return title.replace(/\s*\|\s*Facebook\s*$/i, "").trim();
    }

    return "";
  }

  // 嘗試從頁面控制列辨識目前動態牆排序，用於提醒使用者是否在偏好的排序模式。
  function getCurrentFeedSortLabel() {
    if (!isSupportedGroupPage()) return "";

    const buttons = document.querySelectorAll('[role="button"]');
    for (const button of buttons) {
      if (!(button instanceof HTMLElement)) continue;

      const buttonText = normalizeText(button.innerText || button.textContent || "");
      if (!buttonText.includes("社團動態消息排序方式")) continue;

      const heading = button.querySelector("h2");
      const headingText = normalizeText(heading?.innerText || heading?.textContent || "");
      if (headingText && FEED_SORT_LABELS.includes(headingText)) {
        return headingText;
      }

      for (const label of FEED_SORT_LABELS) {
        if (buttonText.includes(label)) {
          return label;
        }
      }
    }

    return "";
  }

  // 判斷文字是否其實是動態牆排序控制，而不是貼文內容。
  function isFeedSortControlText(value) {
    return normalizeText(value).includes("社團動態消息排序方式");
  }

  // 過濾掉非貼文候選，例如排序控制列。
  function getNonPostReason(post) {
    const text = normalizeText(post?.text);
    const author = normalizeText(post?.author);

    if (isFeedSortControlText(text)) {
      return "feed_sort_control";
    }

    if (
      FEED_SORT_LABELS.includes(author) &&
      (isFeedSortControlText(text) || isFeedSortControlText(`${author} ${text}`))
    ) {
      return "feed_sort_control";
    }

    return "";
  }

  // 關鍵字規則解析與刷新排程控制。
  // 將 `a b;c` 這類輸入拆成規則陣列；分號代表 OR、空白代表 AND。
  function parseKeywordInput(rawInput) {
    return String(rawInput || "")
      .split(";")
      .map((rule) => normalizeText(rule))
      .filter(Boolean)
      .map((rule) => ({
        raw: rule,
        terms: rule.split(" ").map((part) => normalizeForMatch(part)).filter(Boolean),
      }))
      .filter((rule) => rule.terms.length > 0);
  }

  // 逐條規則比對，任一規則成立就視為命中。
  function matchRules(rules, normalizedText) {
    if (!rules.length) {
      return { matched: true, rule: "" };
    }

    for (const rule of rules) {
      if (rule.terms.every((term) => normalizedText.includes(term))) {
        return { matched: true, rule: rule.raw };
      }
    }

    return { matched: false, rule: "" };
  }

  // 根據固定秒數或 jitter 範圍，算出下一次 refresh 秒數。
  function getRefreshSeconds() {
    if (!STATE.config.jitterEnabled) {
      return Math.max(5, Math.floor(Number(STATE.config.fixedRefreshSec) || DEFAULT_CONFIG.fixedRefreshSec));
    }

    const min = Math.min(STATE.config.minRefreshSec, STATE.config.maxRefreshSec);
    const max = Math.max(STATE.config.minRefreshSec, STATE.config.maxRefreshSec);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // 安排下一次頁面刷新；暫停或不在群組頁時不啟動。
  function scheduleRefresh() {
    clearRefreshTimer();
    if (STATE.config.paused || !isSupportedGroupPage()) return;

    const delaySec = getRefreshSeconds();
    STATE.refreshDeadline = Date.now() + delaySec * 1000;
    STATE.refreshTimer = window.setTimeout(() => {
      location.reload();
    }, delaySec * 1000);
  }

  // 清掉已排程的刷新計時器與截止時間。
  function clearRefreshTimer() {
    if (STATE.refreshTimer) {
      clearTimeout(STATE.refreshTimer);
      STATE.refreshTimer = null;
    }
    STATE.refreshDeadline = null;
  }

  // 以 debounce 方式安排掃描，並在 route 剛切換時多等一段穩定時間。
  function scheduleScan(reason) {
    if (STATE.config.paused || STATE.isLoadingMorePosts || STATE.isScanning) return;
    if (!isSupportedGroupPage()) {
      renderPanel();
      return;
    }

    const routeSettleRemainingMs = getRecentRouteSettleRemainingMs();
    const baseDelayMs = reason === "manual-start" ? 0 : STATE.config.scanDebounceMs;
    const delayMs = Math.max(baseDelayMs, routeSettleRemainingMs);

    if (STATE.scanTimer) clearTimeout(STATE.scanTimer);
    STATE.scanTimer = window.setTimeout(() => {
      STATE.scanTimer = null;
      runScan(reason);
    }, delayMs);
  }

  // Facebook SPA route 剛變更時先等待 DOM 穩定，降低抓到半套畫面的機率。
  function getRecentRouteSettleRemainingMs() {
    if (!STATE.lastRouteChangeAt) return 0;
    if (STATE.lastRouteGroupId !== getCurrentGroupId()) return 0;

    const elapsedMs = Date.now() - STATE.lastRouteChangeAt;
    return Math.max(0, ROUTE_SETTLE_MS - elapsedMs);
  }

  // 掃描候選區塊的 DOM 探勘與展開邏輯。
  // 嘗試找出目前群組動態牆的主要根節點，找不到時退回 document.body。
  function findFeedRoot() {
    return (
      document.querySelector('[role="feed"]') ||
      document.querySelector('div[data-pagelet*="GroupsFeed"]') ||
      document.querySelector('div[data-pagelet*="FeedUnit"]') ||
      document.body
    );
  }

  // 定義每次向下捲動的保守步長。
  function getScrollStep() {
    return Math.max(320, Math.floor(window.innerHeight * 0.62));
  }

  // 取得元素可見文字並做正規化。
  function getElementText(element) {
    if (!(element instanceof HTMLElement)) return "";
    return normalizeText(element.innerText || element.textContent || "");
  }

  // 判斷元素目前是否可見，避免處理隱藏節點。
  function isVisibleElement(element) {
    if (!element || !(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // 只掃描視窗附近的候選區塊，避免一次處理過多離屏內容。
  function isElementInActiveScanWindow(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const upperThreshold = Math.max(180, Math.round(window.innerHeight * 0.25));
    const lowerThreshold = Math.max(window.innerHeight * 2.5, window.innerHeight + 480);
    return rect.bottom >= -upperThreshold && rect.top <= lowerThreshold;
  }

  // 辨識貼文內的「查看更多 / See more」按鈕。
  function isPostTextExpander(element, container) {
    if (!(element instanceof HTMLElement) || !(container instanceof HTMLElement)) return false;
    if (!isVisibleElement(element)) return false;

    const text = getElementText(element);
    if (!text) return false;

    const isExpandLabel = (
      text === "顯示更多" ||
      text === "查看更多" ||
      text === "See more"
    );
    if (!isExpandLabel) return false;

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const relativeTop = elementRect.top - containerRect.top;
    const upperRegionThreshold = Math.max(220, Math.round(containerRect.height * 0.72));

    return relativeTop >= -12 && relativeTop <= upperRegionThreshold;
  }

  // 在單一貼文容器中找出可能的文字展開按鈕。
  function findPostTextExpanders(container) {
    if (!(container instanceof HTMLElement)) return [];

    const selectors = [
      'div[role="button"]',
      'span[role="button"]',
      'a[role="button"]',
      "button",
    ];
    const results = [];
    const seen = new Set();

    for (const selector of selectors) {
      const nodes = container.querySelectorAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (!isPostTextExpander(node, container)) continue;
        if (seen.has(node)) continue;
        seen.add(node);
        results.push(node);
      }
    }

    results.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return results;
  }

  // 最多點兩次展開按鈕，盡量先把折疊文字展開再抽取。
  async function expandCollapsedPostText(container) {
    if (!(container instanceof HTMLElement)) return;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expanders = findPostTextExpanders(container);
      if (!expanders.length) break;

      expanders[0].click();
      await sleep(220);
    }
  }

  // 將命中的節點提升到最接近的頂層貼文容器，避免把留言當成貼文。
  function getCanonicalPostElement(node) {
    if (!(node instanceof HTMLElement)) return null;

    const feed = document.querySelector('[role="feed"]');
    if (feed instanceof HTMLElement) {
      let current = node;
      while (current && current instanceof HTMLElement) {
        if (current.parentElement === feed) {
          return current;
        }
        current = current.parentElement;
      }
    }

    // Prefer the feed child wrapper over nested articles so comment/reply
    // articles do not get promoted into top-level post candidates.
    if (node.matches('[role="article"]')) {
      return node;
    }

    const article = node.closest('[role="article"]');
    if (article instanceof HTMLElement) {
      return article;
    }

    return node;
  }

  // 依結構訊號對候選容器做粗略評分，供品質判斷與 debug 使用。
  function getCandidateQualityMeta(element) {
    if (!(element instanceof HTMLElement)) {
      return {
        score: 0,
        hasArticle: false,
        hasPermalinkAnchor: false,
        hasProfileName: false,
        hasStoryMessage: false,
      };
    }

    const hasArticle = element.matches('[role="article"]');
    const hasPermalinkAnchor = Boolean(
      element.querySelector(
        'a[href*="/groups/"][href*="/posts/"], a[href*="/permalink/"], a[href*="multi_permalinks="], a[href*="story_fbid="]'
      )
    );
    const hasProfileName = element.querySelector('[data-ad-rendering-role="profile_name"]') instanceof HTMLElement;
    const hasStoryMessage = element.querySelector(
      'div[data-ad-comet-preview="message"], div[data-ad-preview="message"], [data-ad-rendering-role="story_message"]'
    ) instanceof HTMLElement;

    const score = (
      (hasArticle ? 4 : 0) +
      (hasPermalinkAnchor ? 4 : 0) +
      (hasProfileName ? 2 : 0) +
      (hasStoryMessage ? 2 : 0)
    );

    return {
      score,
      hasArticle,
      hasPermalinkAnchor,
      hasProfileName,
      hasStoryMessage,
    };
  }

  // 依候選區塊文字建立快取指紋，內容不變時可直接重用抽取結果。
  function buildCandidateCacheFingerprint(value) {
    const normalized = normalizeText(value);
    return `${normalized.length}:${normalized.slice(0, 240)}`;
  }

  // 從多組 selector 收集貼文候選容器，再做可見性與文字長度過濾。
  function collectPostContainers(limit = getCandidateCollectionLimit()) {
    const selectors = [
      '[role="feed"] [role="article"]',
      '[role="feed"] > div',
      'div[data-pagelet*="FeedUnit"]',
      'div[data-pagelet*="GroupsFeed"] [role="article"]',
      '[aria-posinset]',
    ];

    const results = [];
    const seen = new Set();

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const canonical = getCanonicalPostElement(node);
        if (!(canonical instanceof HTMLElement)) continue;
        if (!isVisibleElement(canonical)) continue;
        if (!isElementInActiveScanWindow(canonical)) continue;
        const text = normalizeText(canonical.innerText);
        if (text.length < SCAN_LIMITS.minCandidateTextLength) continue;
        const candidateQuality = getCandidateQualityMeta(canonical);

        const identity = canonical;
        if (seen.has(identity)) continue;
        seen.add(identity);

        results.push({
          element: canonical,
          source: selector,
          top: Math.round(canonical.getBoundingClientRect().top),
          textFingerprint: buildCandidateCacheFingerprint(text),
          candidateQualityScore: candidateQuality.score,
          candidateQuality,
        });
      }
    }

    results.sort((a, b) => a.top - b.top);
    return results.slice(0, limit);
  }

  // 貼文識別資料抽取，目前 permalink 關閉，仍保留 postId 萃取邏輯。
  // 目前 permalink 抽取邏輯停用，保留函式介面讓其他流程不必改動。
  function extractPermalinkDetails() {
    return {
      permalink: "",
      source: "disabled",
    };
  }

  // 從網址、data-ft、innerHTML 等雜訊字串裡盡量抽出穩定的 post ID。
  function extractPostIdFromValue(value) {
    const text = String(value || "");
    if (!text) return "";

    const patterns = [
      /\/posts\/(\d+)/i,
      /\/permalink\/(\d+)/i,
      /multi_permalinks=(\d+)/i,
      /story_fbid=(\d+)/i,
      /[?&]set=pcb\.(\d+)/i,
      /\bpcb\.(\d+)/i,
      /ft_ent_identifier=(\d+)/i,
      /\bpost[_-]?id["'=:\s]+(\d{8,})/i,
      /\btop_level_post_id["'=:\s]+(\d{8,})/i,
      /\bmf_story_key["'=:\s]+(\d{8,})/i,
      /\bstoryid["'=:\s]+(\d{8,})/i,
      /\bfeedback_target_id["'=:\s]+(\d{8,})/i,
      /\btargetfbid["'=:\s]+(\d{8,})/i,
      /\bshare_fbid["'=:\s]+(\d{8,})/i,
      /\bfbid["'=:\s]+(\d{8,})/i,
      /"top_level_post_id":"?(\d+)/i,
      /"mf_story_key":"?(\d+)/i,
      /"storyID":"?(\d+)/i,
      /\/posts\/pcb\.(\d+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }

    return "";
  }

  // 收集容器自身與子節點上的各種屬性值，提供 post ID regex 掃描。
  function collectPostIdSourceValues(permalink, container) {
    const values = [String(permalink || "")];
    if (!(container instanceof HTMLElement)) return values;

    values.push(
      container.getAttribute?.("data-ft") || "",
      container.getAttribute?.("data-store") || "",
      container.getAttribute?.("ajaxify") || "",
      container.getAttribute?.("id") || "",
      container.getAttribute?.("href") || "",
      container.getAttribute?.("aria-label") || "",
      container.getAttribute?.("aria-labelledby") || "",
      container.getAttribute?.("aria-describedby") || "",
      container.getAttribute?.("data-testid") || "",
      container.getAttribute?.("data-pagelet") || "",
      container.dataset?.ft || "",
      container.dataset?.store || "",
      container.dataset?.pagelet || "",
      container.dataset?.testid || "",
      container.innerHTML || ""
    );

    const nodes = container.querySelectorAll(
      "a[href], [data-ft], [data-store], [ajaxify], [id], [href], [aria-label], [aria-labelledby], [aria-describedby], [data-testid], [data-pagelet]"
    );
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node instanceof HTMLAnchorElement) {
        values.push(node.href || node.getAttribute("href") || "");
      }
      values.push(node.id || "");
      values.push(node.getAttribute("href") || "");
      values.push(node.getAttribute("data-ft") || "");
      values.push(node.getAttribute("data-store") || "");
      values.push(node.getAttribute("ajaxify") || "");
      values.push(node.getAttribute("aria-label") || "");
      values.push(node.getAttribute("aria-labelledby") || "");
      values.push(node.getAttribute("aria-describedby") || "");
      values.push(node.getAttribute("data-testid") || "");
      values.push(node.getAttribute("data-pagelet") || "");
      values.push(node.dataset?.ft || "");
      values.push(node.dataset?.store || "");
      values.push(node.dataset?.pagelet || "");
      values.push(node.dataset?.testid || "");
    }

    return values;
  }

  // 逐一掃描候選值，抓到第一個看起來可靠的 post ID 就返回。
  function extractPostId(permalink, container) {
    const values = collectPostIdSourceValues(permalink, container);
    for (const value of values) {
      const postId = extractPostIdFromValue(value);
      if (postId) return postId;
    }

    return "";
  }

  // 時間欄位推測工具，目前主流程暫時停用，但保留供後續修復與調整。
  // 清理時間字串周圍的分隔符號與多餘空白。
  function sanitizeTimestampText(value) {
    return normalizeText(String(value || "").replace(/^[\u00B7\u2022]\s*/, "").replace(/\s*[\u00B7\u2022]\s*$/, ""));
  }

  // 從一般字串中抓可能的時間片段，屬於較寬鬆的早期版本。
  function extractTimestampFragment(value) {
    const text = sanitizeTimestampText(value);
    if (!text) return "";

    const compact = text.replace(/\s+/g, "");
    const candidates = [text, compact];
    const patterns = [
      /(\d{1,2}月\d{1,2}日(?:上午|下午)?\d{1,2}[:：]\d{2})/i,
      /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:上午|下午)?\d{1,2}[:：]\d{2})/i,
      /((?:今天|今日|昨天)(?:上午|下午)?\d{1,2}[:：]\d{2})/i,
      /(\d+\s*(?:秒|分|分鐘|小時|天|週|周|月|年))/i,
      /(\d+\s*(?:hrs?|mins?|min|hour|hours|day|days|week|weeks|month|months|year|years))/i,
      /(剛剛|昨天|今日|今天)/i,
    ];

    for (const candidate of candidates) {
      for (const pattern of patterns) {
        const match = candidate.match(pattern);
        if (match && match[1]) {
          return sanitizeTimestampText(match[1]);
        }
      }
    }

    return "";
  }

  // 較保守地抽取時間片段，盡量避免把一般文字誤判成時間。
  function extractTimestampFragmentSafe(value) {
    const text = sanitizeTimestampText(value);
    if (!text) return "";

    const compact = text.replace(/\s+/g, "");
    const signal = text.replace(/[^\d/:\uFF1Aa-zA-Z\u4eca\u65e5\u6628\u5929\u525b\u5206\u9418\u5c0f\u6642\u5929\u9031\u5468\u6708\u5e74\u65e5\u4e0a\u4e0b\u5348]/g, "");
    const candidates = [text, compact, signal];
    const patterns = [
      /(\d{1,2}\s*\u6708\s*\d{1,2}\s*\u65e5(?:\s*(?:\u4e0a\u5348|\u4e0b\u5348))?\s*\d{1,2}\s*[:\uff1a]\s*\d{2})/i,
      /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s*(?:\u4e0a\u5348|\u4e0b\u5348))?\s*\d{1,2}\s*[:\uff1a]\s*\d{2})/i,
      /((?:\u4eca\u5929|\u4eca\u65e5|\u6628\u5929)(?:\s*(?:\u4e0a\u5348|\u4e0b\u5348))?\s*\d{1,2}\s*[:\uff1a]\s*\d{2})/i,
      /(\d+\s*(?:\u79d2|\u5206(?:\u9418)?|\u5c0f\u6642|\u5929|\u9031|\u5468|\u6708|\u5e74))/i,
      /(\d+\s*(?:hrs?|mins?|min|hour|hours|day|days|week|weeks|month|months|year|years))/i,
      /(\u525b\u525b|\u6628\u5929|\u4eca\u65e5|\u4eca\u5929)/i,
    ];

    for (const candidate of candidates) {
      for (const pattern of patterns) {
        const match = candidate.match(pattern);
        if (match && match[1]) {
          return sanitizeTimestampText(match[1]);
        }
      }
    }

    return "";
  }

  // 判斷某個 anchor 是否像是貼文本身的時間連結，而不是留言或其他導頁。
  function isLikelyPostTimestampAnchor(node, permalink) {
    if (!(node instanceof HTMLAnchorElement)) return false;

    const href = node.href || node.getAttribute("href") || "";
    if (!href) return false;

    const permalinkId = extractPostIdFromValue(permalink);
    const hrefId = extractPostIdFromValue(href);

    if (permalinkId && hrefId) {
      return permalinkId === hrefId;
    }

    return (
      href.includes("/posts/") ||
      href.includes("/permalink/") ||
      href.includes("multi_permalinks=") ||
      href.includes("story_fbid=")
    );
  }

  // 以節點在畫面中的垂直位置排序，優先處理較靠上的時間節點。
  function getTimestampNodeSortValue(node) {
    if (!(node instanceof HTMLElement)) return Number.MAX_SAFE_INTEGER;

    const rect = node.getBoundingClientRect();
    return Math.round(rect.top);
  }

  // 有些時間文字藏在 aria-labelledby 對應節點，這裡把它們一併攤平收集。
  function getAriaLabelledTextCandidates(node) {
    if (!(node instanceof HTMLElement)) return [];

    const ids = String(node.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);

    const candidates = [];
    for (const id of ids) {
      const target = document.getElementById(id);
      if (!(target instanceof HTMLElement)) continue;

      candidates.push(sanitizeTimestampText(target.innerText || ""));
      candidates.push(sanitizeTimestampText(target.textContent || ""));
      candidates.push(sanitizeTimestampText(target.getAttribute("aria-label") || ""));
      candidates.push(sanitizeTimestampText(target.getAttribute("title") || ""));
    }

    return candidates.filter(Boolean);
  }

  // 在指定區域內收集時間候選節點，並拆成偏好節點與備援節點兩組。
  function collectTimestampNodesInScope(scope, selectors, permalink) {
    const preferredNodes = [];
    const fallbackNodes = [];
    if (!(scope instanceof HTMLElement)) {
      return { preferredNodes, fallbackNodes };
    }

    for (const selector of selectors) {
      const nodes = scope.querySelectorAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;

        if (isLikelyPostTimestampAnchor(node, permalink)) {
          preferredNodes.push(node);
        } else {
          fallbackNodes.push(node);
        }
      }
    }

    preferredNodes.sort((a, b) => getTimestampNodeSortValue(a) - getTimestampNodeSortValue(b));
    fallbackNodes.sort((a, b) => getTimestampNodeSortValue(a) - getTimestampNodeSortValue(b));

    return { preferredNodes, fallbackNodes };
  }

  // 先試偏好節點，再試備援節點，取第一個可用的時間字串。
  function extractTimestampFromNodes(preferredNodes, fallbackNodes, permalink) {
    for (const node of preferredNodes) {
      const candidate = extractTimestampCandidate(node, permalink);
      if (candidate) return candidate;
    }

    for (const node of fallbackNodes) {
      const candidate = extractTimestampCandidate(node, permalink);
      if (candidate) return candidate;
    }

    return "";
  }

  // 嘗試鎖定貼文 header 區域，讓時間抽取不要誤吃到留言時間。
  function findPostHeaderElement(container, permalink) {
    if (!(container instanceof HTMLElement)) return null;

    const profileName = container.querySelector('[data-ad-rendering-role="profile_name"]');
    if (!(profileName instanceof HTMLElement)) return null;

    let current = profileName.parentElement;
    while (current && current !== container && current instanceof HTMLElement) {
      const matchingAnchor = current.querySelector('a[href*="/groups/"][href*="/posts/"], a[href*="/permalink/"], a[href*="multi_permalinks="], a[href*="story_fbid="]');
      if (matchingAnchor instanceof HTMLElement && isLikelyPostTimestampAnchor(matchingAnchor, permalink)) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  // 綜合 header 優先、位置排序與屬性候選來抽取貼文時間。
  function extractTimestampText(container, permalink) {
    const maybeTimestampSelectors = [
      'a[href*="/groups/"][href*="/posts/"]',
      'a[href*="/permalink/"]',
      'a[href*="multi_permalinks="]',
      'a[href*="story_fbid="]',
      "a[aria-label]",
      "span[aria-label]",
      "time",
      "[datetime]",
      "[data-utime]",
    ];
    const headerElement = findPostHeaderElement(container, permalink);
    if (headerElement) {
      const headerNodes = collectTimestampNodesInScope(headerElement, maybeTimestampSelectors, permalink);
      const headerTimestamp = extractTimestampFromNodes(headerNodes.preferredNodes, headerNodes.fallbackNodes, permalink);
      if (headerTimestamp) return headerTimestamp;
      return "";
    }

    const preferredHeaderNodes = [];
    const fallbackHeaderNodes = [];
    const preferredNodes = [];
    const fallbackNodes = [];
    const containerRect = container.getBoundingClientRect();
    const headerThreshold = Math.max(140, Math.min(260, Math.round(containerRect.height * 0.35 || 220)));

    for (const selector of maybeTimestampSelectors) {
      const nodes = container.querySelectorAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const isHeaderRegion = getTimestampNodeSortValue(node) - Math.round(containerRect.top) <= headerThreshold;

        if (isLikelyPostTimestampAnchor(node, permalink)) {
          preferredNodes.push(node);
          if (isHeaderRegion) preferredHeaderNodes.push(node);
        } else {
          fallbackNodes.push(node);
          if (isHeaderRegion) fallbackHeaderNodes.push(node);
        }
      }
    }

    preferredHeaderNodes.sort((a, b) => getTimestampNodeSortValue(a) - getTimestampNodeSortValue(b));
    fallbackHeaderNodes.sort((a, b) => getTimestampNodeSortValue(a) - getTimestampNodeSortValue(b));
    preferredNodes.sort((a, b) => getTimestampNodeSortValue(a) - getTimestampNodeSortValue(b));
    fallbackNodes.sort((a, b) => getTimestampNodeSortValue(a) - getTimestampNodeSortValue(b));

    const headerTimestamp = extractTimestampFromNodes(preferredHeaderNodes, fallbackHeaderNodes, permalink);
    if (headerTimestamp) return headerTimestamp;

    if (preferredHeaderNodes.length || fallbackHeaderNodes.length) {
      return "";
    }

    return extractTimestampFromNodes(preferredNodes, fallbackNodes, permalink);
  }

  // 從單一節點上常見的時間來源屬性逐一抽取可用值。
  function extractTimestampCandidate(node, permalink) {
    if (!(node instanceof HTMLElement)) return "";

    if (node instanceof HTMLAnchorElement) {
      const href = node.href || "";
      if (permalink && href && !isLikelyPostTimestampAnchor(node, permalink)) {
        return "";
      }
    }

    const candidates = [
      sanitizeTimestampText(node.getAttribute("datetime") || ""),
      sanitizeTimestampText(node.getAttribute("data-utime") || ""),
      sanitizeTimestampText(node.getAttribute("aria-label") || ""),
      sanitizeTimestampText(node.getAttribute("title") || ""),
      sanitizeTimestampText(node.innerText || ""),
      sanitizeTimestampText(node.textContent || ""),
      ...getAriaLabelledTextCandidates(node),
    ];

    for (const candidate of candidates) {
      const timestamp = extractTimestampFragmentSafe(candidate);
      if (timestamp) return timestamp;
    }

    return "";
  }

  // 用於 fallback 文字抽取時排除看起來像時間的片段。
  function isProbablyTimestamp(value) {
    return Boolean(extractTimestampFragmentSafe(value));
  }

  // 作者、內文與內容品質評分抽取。
  // 以多組常見 selector 抽取作者名稱，並排除操作按鈕等假陽性文字。
  function extractAuthor(container) {
    const selectors = [
      "h2 span",
      "h3 span",
      'a[role="link"] span[dir="auto"]',
      "strong span",
    ];

    for (const selector of selectors) {
      const nodes = container.querySelectorAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const text = normalizeText(node.innerText).replace(/\s*[·•]\s*追蹤\s*$/u, "");
        if (!text) continue;
        if (text.length > 80) continue;
        if (/^(Like|Comment|Share|Most relevant)$/i.test(text)) continue;
        return text;
      }
    }

    return "";
  }

  // 優先從 Facebook 較穩定的貼文訊息區塊抽正文，失敗才退回通用 dir="auto" 掃描。
  function extractPostTextDetails(container) {
    const primarySelectors = [
      'div[data-ad-comet-preview="message"]',
      'div[data-ad-preview="message"]',
      '[data-ad-rendering-role="story_message"]',
    ];
    const fallbackSelectors = [
      'div[dir="auto"]',
      'span[dir="auto"]',
    ];

    const snippets = [];
    const seen = new Set();

    for (const selector of primarySelectors) {
      const nodes = container.querySelectorAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const text = cleanExtractedText(node.innerText);
        if (!text || text.length < 2) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        snippets.push(text);
      }
      if (snippets.length >= 8) break;
    }

    if (snippets.length) {
      return {
        text: cleanExtractedText(snippets.join(" ")),
        source: "primary",
      };
    }

    if (!snippets.length) {
      for (const selector of fallbackSelectors) {
        const nodes = container.querySelectorAll(selector);
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          const text = cleanExtractedText(node.innerText);
          if (!text || text.length < 6) continue;
          if (isProbablyTimestamp(text)) continue;
          if (seen.has(text)) continue;
          seen.add(text);
          snippets.push(text);
        }
        if (snippets.length >= 8) break;
      }
    }

    if (snippets.length) {
      return {
        text: cleanExtractedText(snippets.join(" ")),
        source: "fallback",
      };
    }

    return {
      text: cleanExtractedText(container.innerText),
      source: "container",
    };
  }

  // 只需要純文字時的薄封裝。
  function extractPostText(container) {
    return extractPostTextDetails(container).text;
  }

  // 清理抽出的貼文文字，移除按鈕文案與常見噪音片段。
  function cleanExtractedText(value) {
    let text = normalizeText(value);
    if (!text) return "";

    const noisyFragments = [
      "Facebook",
      "貼文的相片",
      "顯示更多",
      "查看更多",
      "See more",
      "Most relevant",
      "Like",
      "Comment",
      "Share",
    ];

    for (const fragment of noisyFragments) {
      text = text.replaceAll(fragment, " ");
    }

    text = text
      .replace(/\b[a-z0-9]{12,}\.com\b/gi, " ")
      .replace(/\bsnproSet[a-z0-9]+\b/gi, " ")
      .replace(/\bsotoeSrdpn[a-z0-9]+\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    return text;
  }

  // 將文字壓成較短且穩定的 signature，供 fallback 去重使用。
  function buildStableTextSignature(value) {
    const compact = normalizeForKey(value);
    if (!compact) return "";
    return compact.slice(0, 120);
  }

  // 依 postId、permalink、作者、來源等訊號計算粗略品質分數。
  function getPostQualityScore(post) {
    return (
      Number(post?.candidateQualityScore || 0) +
      (post?.postId ? 5 : 0) +
      (post?.permalink ? 3 : 0) +
      (post?.author ? 2 : 0) +
      (post?.containerRole === "article" ? 2 : 0) +
      (post?.textSource === "primary" ? 1 : 0)
    );
  }

  // 建立通知欄位，供本機通知與遠端通知共用。
  function getNotificationFields(post) {
    return {
      groupName: getCurrentGroupName() || "(未知)",
      author: post?.author || "(作者未知)",
      includeRule: post?.includeRule || "(include-all)",
      text: truncate(post?.text || "", 220) || "(空白)",
      permalink: post?.permalink || "",
    };
  }

  // 建立較精簡的單行通知文字，適合桌面通知。
  function buildCompactNotificationBody(post) {
    const fields = getNotificationFields(post);
    return truncate(
      [
        fields.groupName,
        fields.author,
        `match: ${fields.includeRule}`,
        truncate(fields.text, 120),
      ].filter(Boolean).join(" | "),
      250
    );
  }

  // 建立多行通知文字，格式接近「查看紀錄」的顯示方式。
  function buildRemoteNotificationBody(post) {
    const fields = getNotificationFields(post);
    const lines = [
      `社團: ${fields.groupName}`,
      `作者: ${fields.author}`,
      `關鍵字: ${fields.includeRule}`,
      `內容: ${fields.text}`,
    ];

    if (fields.permalink) {
      lines.push(`連結: ${fields.permalink}`);
    }

    return lines.join("\n");
  }

  // 通知能力檢查與 ntfy 傳送。
  // 若啟用原生桌面通知，主動請求權限或回報目前權限狀態。
  async function requestBrowserNotificationPermission() {
    try {
      if (!("Notification" in window)) return "unsupported";
      if (Notification.permission === "granted") return "granted";
      if (Notification.permission === "denied") return "denied";
      return await Notification.requestPermission();
    } catch (error) {
      return "error";
    }
  }

  // 透過 ntfy topic 傳送遠端通知；未設定 topic 時直接跳過。
  function sendNtfyNotification({ title, body, clickUrl }) {
    const topic = getPersistedNtfyTopic();
    STATE.config.ntfyTopic = topic;
    if (!topic) {
      return Promise.resolve("ntfy_skipped");
    }

    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: `https://ntfy.sh/${encodeURIComponent(topic)}`,
          data: body,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Title: title,
            Priority: "default",
            Tags: "bell",
            ...(clickUrl ? { Click: clickUrl } : {}),
          },
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve("ntfy_sent");
              return;
            }
            resolve(`ntfy_failed:${response.status}`);
          },
          onerror: () => resolve("ntfy_failed"),
          ontimeout: () => resolve("ntfy_timeout"),
        });
      } catch (error) {
        resolve("ntfy_failed");
      }
    });
  }

  // 透過 Discord Webhook 傳送遠端通知；未設定 URL 時直接跳過。
  function sendDiscordWebhookNotification({ title, body, clickUrl }) {
    const webhook = getPersistedDiscordWebhook();
    STATE.config.discordWebhook = webhook;
    if (!webhook) {
      return Promise.resolve("discord_skipped");
    }

    const content = truncate(
      [title, body, clickUrl].filter(Boolean).join("\n"),
      1900
    );

    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: webhook,
          data: JSON.stringify({ content }),
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve("discord_sent");
              return;
            }
            resolve(`discord_failed:${response.status}`);
          },
          onerror: () => resolve("discord_failed"),
          ontimeout: () => resolve("discord_timeout"),
        });
      } catch (error) {
        resolve("discord_failed");
      }
    });
  }

  // 讀取各社團最近一次最上方貼文快照，用於快速判斷是否需要深度掃描。
  function getLatestTopPostsStore() {
    const store = loadJson(STORAGE_KEYS.latestTopPosts, {});
    return store && typeof store === "object" ? store : {};
  }

  // 寫回各社團最近一次最上方貼文快照。
  function setLatestTopPostsStore(store) {
    saveJson(STORAGE_KEYS.latestTopPosts, store);
  }

  // 讀取指定社團最近一次最上方貼文快照。
  function getLatestTopPostForGroup(groupId) {
    if (!groupId) return null;
    const store = getLatestTopPostsStore();
    const snapshot = store[groupId];
    return snapshot && typeof snapshot === "object" ? snapshot : null;
  }

  // 保存指定社團最近一次最上方貼文快照。
  function setLatestTopPostForGroup(groupId, post) {
    if (!groupId || !post) return;

    const postKey = getPostKey(post);
    if (!postKey) return;

    const store = getLatestTopPostsStore();
    store[groupId] = {
      postKey,
      author: post.author || "",
      text: truncate(post.text || "", 160),
      updatedAt: new Date().toISOString(),
    };
    setLatestTopPostsStore(store);
  }

  // 讀取各社團最近一次完整掃描後的貼文清單，用於快篩命中時沿用上一輪顯示結果。
  function getLatestScanPostsStore() {
    const store = loadJson(STORAGE_KEYS.latestScanPosts, {});
    return store && typeof store === "object" ? store : {};
  }

  // 寫回各社團最近一次完整掃描後的貼文清單。
  function setLatestScanPostsStore(store) {
    saveJson(STORAGE_KEYS.latestScanPosts, store);
  }

  // 讀取指定社團最近一次完整掃描後的貼文清單。
  function getLatestScanPostsForGroup(groupId) {
    if (!groupId) return [];
    const store = getLatestScanPostsStore();
    const posts = store[groupId];
    return Array.isArray(posts) ? posts : [];
  }

  // 保存指定社團最近一次完整掃描後的貼文清單。
  function setLatestScanPostsForGroup(groupId, posts) {
    if (!groupId) return;

    const normalizedPosts = Array.isArray(posts)
      ? posts.filter((post) => post && typeof post === "object")
      : [];

    const store = getLatestScanPostsStore();
    store[groupId] = normalizedPosts;
    setLatestScanPostsStore(store);
  }

  // 只有例行掃描才啟用最上方貼文快篩，避免手動操作時誤跳過完整掃描。
  function shouldUseTopPostShortcut(reason) {
    return (
      reason !== "manual-start" &&
      reason !== "save" &&
      reason !== "route-change"
    );
  }

  // 去重鍵、已見貼文與命中歷史的持久化狀態管理。
  // 在缺少 postId / permalink 時，用作者、時間與文字簽名組出最後防線的 key。
  function buildFallbackId(post) {
    return [
      normalizeForKey(post.author),
      normalizeForKey(post.timestampText),
      buildStableTextSignature(post.text || post.normalizedText),
    ].filter(Boolean).join("||");
  }

  // 建立目前版本使用的主去重鍵，優先順序為 postId > permalink > 文字組合鍵。
  function getPostKey(post) {
    if (post.postId) return `id:${post.postId}`;

    const permalink = String(post.permalink || "");
    if (extractPostIdFromValue(permalink)) return `url:${permalink}`;

    const compactText = buildStableTextSignature(post.text || post.normalizedText);
    const compactAuthor = normalizeForKey(post.author);
    const compactTime = normalizeForKey(post.timestampText);

    if (compactAuthor && compactTime && compactText) {
      return `author:${compactAuthor}||time:${compactTime}||text:${compactText}`;
    }

    if (compactAuthor && compactText) {
      return `author:${compactAuthor}||text:${compactText}`;
    }

    if (compactText) {
      return `text:${compactText}`;
    }

    return buildFallbackId(post);
  }

  // 保留舊版 key 規則，讓舊資料仍能被辨識為已看過。
  function getLegacyPostKey(post) {
    if (post.postId) return post.postId;
    if (post.permalink) return post.permalink;

    const compactText = String(post.normalizedText || "")
      .replace(/\s+/g, "")
      .slice(0, 180);
    const compactAuthor = String(post.author || "").trim().toLowerCase();
    const compactTime = String(post.timestampText || "").trim().toLowerCase();

    return [compactAuthor, compactTime, compactText].filter(Boolean).join("||") || "";
  }

  // 讀取「已看過貼文」儲存區。
  function getSeenPostsStore() {
    const store = loadJson(STORAGE_KEYS.seenPosts, {});
    return store && typeof store === "object" ? store : {};
  }

  // 寫回「已看過貼文」儲存區。
  function setSeenPostsStore(store) {
    saveJson(STORAGE_KEYS.seenPosts, store);
  }

  // 檢查某篇貼文是否已看過，支援直接傳 key 或傳入完整 post 物件。
  function hasSeenPost(groupId, postKey) {
    const store = getSeenPostsStore();
    if (!store[groupId]) return false;
    if (typeof postKey !== "object" && postKey && store[groupId][postKey]) return true;

    if (typeof postKey === "object" && postKey) {
      const currentKey = getPostKey(postKey);
      const legacyKey = getLegacyPostKey(postKey);
      return Boolean(
        (currentKey && store[groupId][currentKey]) ||
        (legacyKey && store[groupId][legacyKey])
      );
    }

    return false;
  }

  // 將貼文標記為已看過，並依時間保留最近 N 筆。
  function markPostSeen(groupId, postKey) {
    const normalizedGroupId = String(groupId || "");
    const store = getSeenPostsStore();
    const nextGroupStore = (
      store[normalizedGroupId] && typeof store[normalizedGroupId] === "object"
        ? store[normalizedGroupId]
        : {}
    );

    const nextStore = {};
    if (normalizedGroupId) {
      nextStore[normalizedGroupId] = nextGroupStore;
    }

    nextGroupStore[postKey] = new Date().toISOString();

    const entries = Object.entries(nextGroupStore).sort((a, b) => {
      return new Date(b[1]).getTime() - new Date(a[1]).getTime();
    });

    nextStore[normalizedGroupId] = Object.fromEntries(entries.slice(0, getDynamicSeenPostLimit()));
    setSeenPostsStore(nextStore);
  }

  // 清空指定群組的已看過貼文紀錄，並移除其他群組殘留的去重資料。
  function clearSeenPostsForGroup(groupId) {
    const normalizedGroupId = String(groupId || "");
    if (!normalizedGroupId) {
      setSeenPostsStore({});
      return;
    }

    setSeenPostsStore({
      [normalizedGroupId]: {},
    });
  }

  // 讀取命中通知歷史；新版使用全域陣列，舊版依社團分組資料會在讀取時攤平。
  function getMatchHistoryStore() {
    const store = loadJson(STORAGE_KEYS.matchHistory, []);
    if (Array.isArray(store)) {
      return store;
    }

    if (!store || typeof store !== "object") {
      return [];
    }

    const flattened = [];
    for (const [groupId, entries] of Object.entries(store)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        flattened.push({
          groupId,
          groupName: entry.groupName || "",
          postKey: entry.postKey || "",
          author: entry.author || "",
          text: entry.text || "",
          permalink: entry.permalink || "",
          includeRule: entry.includeRule || "",
          timestampText: entry.timestampText || "",
          notifiedAt: entry.notifiedAt || "",
        });
      }
    }

    flattened.sort((a, b) => {
      return new Date(b.notifiedAt || 0).getTime() - new Date(a.notifiedAt || 0).getTime();
    });
    return flattened.slice(0, STATE.config.matchHistoryGlobalLimit);
  }

  // 寫回全域命中通知歷史。
  function setMatchHistoryStore(store) {
    saveJson(STORAGE_KEYS.matchHistory, Array.isArray(store) ? store : []);
  }

  // 清空所有命中通知歷史。
  function clearMatchHistory() {
    setMatchHistoryStore([]);
  }

  // 將本輪新命中的貼文批次加入全域歷史，保留傳入順序並移除相同 key 的舊項目。
  function addMatchHistory(groupId, posts) {
    const store = getMatchHistoryStore();
    const incomingPosts = Array.isArray(posts) ? posts : [posts];
    const nextEntries = [];
    const seenIncomingKeys = new Set();
    const normalizedGroupId = String(groupId || "");
    const groupName = getCurrentGroupName();

    for (const post of incomingPosts) {
      const postKey = post?.postKey || "";
      const historyKey = `${normalizedGroupId}::${postKey}`;
      if (postKey && seenIncomingKeys.has(historyKey)) continue;
      if (postKey) seenIncomingKeys.add(historyKey);

      nextEntries.push({
        groupId: normalizedGroupId,
        groupName: groupName || "",
        postKey,
        author: post?.author || "",
        text: post?.text || "",
        permalink: post?.permalink || "",
        includeRule: post?.includeRule || "",
        timestampText: post?.timestampText || "",
        notifiedAt: new Date().toISOString(),
      });
    }

    const existing = store.filter((item) => {
      if (!item?.postKey) return true;
      return !seenIncomingKeys.has(`${String(item.groupId || "")}::${item.postKey}`);
    });

    setMatchHistoryStore(
      [...nextEntries, ...existing].slice(0, STATE.config.matchHistoryGlobalLimit)
    );
  }

  // 將候選 DOM 轉成貼文紀錄，並在多個視窗區段內累積掃描結果。
  // 將單一候選容器轉成統一的貼文資料結構。
  function extractPostRecord(candidate) {
    const container = candidate.element;
    const postId = extractPostId("", container);
    const textDetails = extractPostTextDetails(container);
    const text = textDetails.text;
    const author = extractAuthor(container);
    // Facebook post timestamp extraction is temporarily disabled because the
    // current DOM heuristics still confuse post time with comment time.
    const timestampText = "";
    const groupId = getCurrentGroupId();
    const containerRole = container.matches('[role="article"]') ? "article" : "feed_child";
    const permalink = "";

    const record = {
      postId,
      permalink,
      author,
      text,
      normalizedText: normalizeForMatch(text),
      timestampText,
      timestampEpoch: null,
      groupId,
      source: candidate.source,
      containerRole,
      candidateTop: candidate.top ?? Number.MAX_SAFE_INTEGER,
      candidateQualityScore: candidate.candidateQualityScore ?? 0,
      hasPermalink: false,
      permalinkSource: "disabled",
      textSource: textDetails.source,
      scopeDebug: [],
      extractedAt: new Date().toISOString(),
    };

    record.postQualityScore = getPostQualityScore(record);
    return record;
  }

  // 將候選容器批次抽成貼文，並統計快取命中、空文字、非貼文等過濾資訊。
  async function collectPostsFromCandidates(candidates, scanCache = null) {
    const posts = [];
    const meta = {
      cacheHitCount: 0,
      freshExtractCount: 0,
      filteredEmptyTextCount: 0,
      filteredNonPostCount: 0,
      filteredFeedSortControlCount: 0,
      articleElementCount: 0,
      postsWithPostIdCount: 0,
    };

    for (const candidate of candidates) {
      const cachedEntry = scanCache?.get(candidate.element) || null;
      let post = null;

      // 若同一個 DOM 區塊的文字指紋沒變，直接重用上一次抽取結果。
      if (cachedEntry && cachedEntry.fingerprint === candidate.textFingerprint) {
        post = cachedEntry.post;
        meta.cacheHitCount += 1;
      } else {
        // 先嘗試展開折疊文字，再抽取完整貼文內容。
        await expandCollapsedPostText(candidate.element);
        post = extractPostRecord(candidate);
        meta.freshExtractCount += 1;
        scanCache?.set(candidate.element, {
          post,
          fingerprint: buildCandidateCacheFingerprint(candidate.element.innerText || candidate.element.textContent || ""),
        });
      }

      if (!normalizeText(post.text)) {
        meta.filteredEmptyTextCount += 1;
        continue;
      }

      // 這裡會排除誤抓到的排序控制列等非貼文內容。
      const nonPostReason = getNonPostReason(post);
      if (nonPostReason) {
        meta.filteredNonPostCount += 1;
        if (nonPostReason === "feed_sort_control") {
          meta.filteredFeedSortControlCount += 1;
        }
        continue;
      }

      if (candidate.element.matches('[role="article"]')) {
        meta.articleElementCount += 1;
      }
      if (post.postId) {
        meta.postsWithPostIdCount += 1;
      }

      posts.push(post);
    }

    return { posts, meta };
  }

  // 只掃描目前可見視窗，用於最上方貼文快篩命中後的快速返回。
  async function collectVisiblePostsOnly() {
    const targetPostCount = clampTargetPostCount(STATE.config.maxPostsPerScan);
    const candidates = collectPostContainers(getCandidateCollectionLimit(1));
    const collected = await collectPostsFromCandidates(candidates, new WeakMap());
    const posts = dedupeExtractedPosts(collected.posts, targetPostCount);

    return {
      posts,
      meta: {
        targetCount: targetPostCount,
        mode: STATE.config.autoLoadMorePosts ? STATE.config.loadMoreMode : "off",
        attempted: false,
        attempts: 0,
        maxWindowCount: STATE.config.autoLoadMorePosts ? getDynamicMaxWindows(targetPostCount) : 1,
        stagnantWindows: 0,
        stopReason: "",
        beforeCount: candidates.length,
        afterCount: candidates.length,
        windowCount: 1,
        candidateCount: candidates.length,
        cacheHitCount: collected.meta.cacheHitCount,
        freshExtractCount: collected.meta.freshExtractCount,
        parsedCount: posts.length,
        accumulatedCount: posts.length,
        filteredEmptyTextCount: collected.meta.filteredEmptyTextCount,
        filteredNonPostCount: collected.meta.filteredNonPostCount,
        filteredFeedSortControlCount: collected.meta.filteredFeedSortControlCount,
        articleElementCount: collected.meta.articleElementCount,
        postsWithPostIdCount: collected.meta.postsWithPostIdCount,
        topPostShortcutUsed: false,
        topPostShortcutMatched: false,
      },
    };
  }

  // 先比對最上方最新貼文是否與上一輪相同；相同時直接跳過深度掃描。
  async function collectPostsWithTopPostShortcut(reason, groupId) {
    const visibleResult = await collectVisiblePostsOnly();
    const topPost = visibleResult.posts[0] || null;
    const topPostKey = topPost ? getPostKey(topPost) : "";

    visibleResult.meta.topPostShortcutUsed = true;
    visibleResult.meta.topPostKey = topPostKey;

    if (!STATE.config.autoLoadMorePosts) {
      visibleResult.meta.stopReason = "已停用自動載入更多貼文";
      return visibleResult;
    }

    if (!shouldUseTopPostShortcut(reason)) {
      visibleResult.meta.topPostShortcutMatched = false;
      return null;
    }

    if (getCurrentFeedSortLabel() !== "新貼文") {
      visibleResult.meta.topPostShortcutMatched = false;
      return null;
    }

    if (!topPost || !topPostKey) {
      visibleResult.meta.topPostShortcutMatched = false;
      return null;
    }

    const previousTopPost = getLatestTopPostForGroup(groupId);
    visibleResult.meta.previousTopPostKey = previousTopPost?.postKey || "";

    if (!previousTopPost?.postKey) {
      setLatestTopPostForGroup(groupId, topPost);
      visibleResult.meta.topPostShortcutMatched = false;
      return null;
    }

    if (previousTopPost.postKey === topPostKey) {
      const cachedPosts = getLatestScanPostsForGroup(groupId);
      visibleResult.meta.topPostShortcutMatched = true;
      visibleResult.meta.stopReason = "最上方貼文未變更，跳過深度掃描";
      if (cachedPosts.length) {
        visibleResult.posts = cachedPosts.slice(0, clampTargetPostCount(STATE.config.maxPostsPerScan));
        visibleResult.meta.parsedCount = visibleResult.posts.length;
        visibleResult.meta.accumulatedCount = visibleResult.posts.length;
      }
      return visibleResult;
    }

    setLatestTopPostForGroup(groupId, topPost);
    visibleResult.meta.topPostShortcutMatched = false;
    return null;
  }

  // 在當前視窗與後續滾動視窗中累積貼文，直到足夠或達到保守上限。
  async function collectPostsAcrossWindows() {
    const targetPostCount = clampTargetPostCount(STATE.config.maxPostsPerScan);
    const result = {
      targetCount: targetPostCount,
      mode: STATE.config.autoLoadMorePosts ? STATE.config.loadMoreMode : "off",
      attempted: false,
      attempts: 0,
      maxWindowCount: STATE.config.autoLoadMorePosts ? getDynamicMaxWindows(targetPostCount) : 1,
      stagnantWindows: 0,
      stopReason: "",
      beforeCount: 0,
      afterCount: 0,
      windowCount: 0,
      candidateCount: 0,
      cacheHitCount: 0,
      freshExtractCount: 0,
      parsedCount: 0,
      accumulatedCount: 0,
      filteredEmptyTextCount: 0,
      filteredNonPostCount: 0,
      filteredFeedSortControlCount: 0,
      articleElementCount: 0,
      postsWithPostIdCount: 0,
    };
    const accumulated = [];
    const accumulatedKeys = new Set();
    const scanCache = new WeakMap();
    const maxWindows = result.maxWindowCount;
    let stagnantWindows = 0;

    const initialCandidates = collectPostContainers(getCandidateCollectionLimit(targetPostCount));
    result.beforeCount = initialCandidates.length;
    result.afterCount = initialCandidates.length;

    // 若其他掃描流程正在載入更多貼文，這輪只吃當前視窗，避免互相打架。
    if (STATE.isLoadingMorePosts) {
      result.stopReason = "目前正在載入更多貼文，先使用當前視窗結果";
      const initialCollected = await collectPostsFromCandidates(initialCandidates, scanCache);
      result.cacheHitCount += initialCollected.meta.cacheHitCount;
      result.freshExtractCount += initialCollected.meta.freshExtractCount;
      result.filteredEmptyTextCount += initialCollected.meta.filteredEmptyTextCount;
      result.filteredNonPostCount += initialCollected.meta.filteredNonPostCount;
      result.filteredFeedSortControlCount += initialCollected.meta.filteredFeedSortControlCount;
      result.articleElementCount += initialCollected.meta.articleElementCount;
      result.postsWithPostIdCount += initialCollected.meta.postsWithPostIdCount;
      const initialPosts = dedupeExtractedPosts(initialCollected.posts, targetPostCount);
      return { posts: initialPosts, meta: result };
    }

    const startY = window.scrollY;
    STATE.isLoadingMorePosts = true;

    try {
      for (let windowIndex = 0; windowIndex < maxWindows; windowIndex += 1) {
        result.windowCount = windowIndex + 1;

        // 每個 window 代表「目前畫面可見範圍」的一次候選收集。
        const candidates = collectPostContainers(getCandidateCollectionLimit(targetPostCount));
        const collected = await collectPostsFromCandidates(candidates, scanCache);
        const posts = dedupeExtractedPosts(collected.posts, Number.MAX_SAFE_INTEGER);
        result.candidateCount += candidates.length;
        result.cacheHitCount += collected.meta.cacheHitCount;
        result.freshExtractCount += collected.meta.freshExtractCount;
        result.parsedCount += posts.length;
        result.afterCount = Math.max(result.afterCount, candidates.length);
        result.filteredEmptyTextCount += collected.meta.filteredEmptyTextCount;
        result.filteredNonPostCount += collected.meta.filteredNonPostCount;
        result.filteredFeedSortControlCount += collected.meta.filteredFeedSortControlCount;
        result.articleElementCount += collected.meta.articleElementCount;
        result.postsWithPostIdCount += collected.meta.postsWithPostIdCount;

        let addedThisWindow = 0;

        for (const post of posts) {
          const postKey = getPostKey(post);
          if (!postKey || accumulatedKeys.has(postKey)) continue;
          accumulatedKeys.add(postKey);
          accumulated.push(post);
          addedThisWindow += 1;

          if (accumulated.length >= targetPostCount) break;
        }

        result.accumulatedCount = accumulated.length;
        result.stagnantWindows = stagnantWindows;

        if (accumulated.length >= targetPostCount) {
          result.stopReason = "已達目標貼文數";
          break;
        }
        if (!STATE.config.autoLoadMorePosts) {
          result.stopReason = "已停用自動載入更多貼文";
          break;
        }

        if (addedThisWindow === 0) {
          // 沒有新增貼文時累計停滯視窗數，作為後續停止掃描的參考訊號。
          stagnantWindows += 1;
        } else {
          stagnantWindows = 0;
        }

        result.stagnantWindows = stagnantWindows;

        result.attempted = true;
        result.attempts += 1;
        if (STATE.config.loadMoreMode === "wheel") {
          performWheelLikeLoad();
        } else {
          performScrollLoad();
        }

        // 給 Facebook 一點時間把新增內容補進 DOM。
        await sleep(900);
      }
    } finally {
      // 掃描結束後把視窗捲回原位，避免干擾使用者閱讀。
      window.scrollTo(0, startY);
      await sleep(160);
      STATE.isLoadingMorePosts = false;
    }

    if (!result.stopReason) {
      if (accumulated.length >= targetPostCount) {
        result.stopReason = "已達目標貼文數";
      } else if (STATE.config.autoLoadMorePosts && result.windowCount >= maxWindows) {
        result.stopReason = `已達安全掃描上限 (${maxWindows} 輪)，目前取得 ${accumulated.length}/${targetPostCount} 篇`;
      } else {
        result.stopReason = "已完成目前掃描";
      }
    }

    return {
      posts: accumulated.slice(0, targetPostCount),
      meta: result,
    };
  }

  // 模擬保守的載入更多貼文行為。
  // 用單純 scrollBy 模擬使用者往下看更多貼文。
  function performScrollLoad() {
    window.scrollBy(0, getScrollStep());
  }

  // 先嘗試派送 wheel 事件，再退回 scrollBy，讓部分頁面更像真人滾動。
  function performWheelLikeLoad() {
    const target = document.scrollingElement || document.documentElement || document.body;
    const deltaY = getScrollStep();

    try {
      const wheelEvent = new WheelEvent("wheel", {
        deltaY,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        view: window,
      });
      target.dispatchEvent(wheelEvent);
    } catch (error) {
      // Ignore and fallback to scroll.
    }

    window.scrollBy(0, deltaY);
  }

  // 主掃描流程：收集貼文、套用 include/exclude、去重並觸發通知。
  // 核心掃描入口：收集貼文、套規則、判斷 baseline、通知並更新 UI 狀態。
  async function runScan(reason) {
    if (STATE.config.paused) {
      renderPanel();
      return;
    }
    if (STATE.isScanning) return;

    STATE.isScanning = true;

    try {
      const supported = isSupportedGroupPage();
      const groupId = getCurrentGroupId();
      const includeRules = parseKeywordInput(STATE.config.includeKeywords);
      const excludeRules = parseKeywordInput(STATE.config.excludeKeywords);
      let collectedResult = {
        posts: [],
        meta: {
          mode: STATE.config.autoLoadMorePosts ? STATE.config.loadMoreMode : "off",
          attempted: false,
          attempts: 0,
          beforeCount: 0,
          afterCount: 0,
          windowCount: 0,
          candidateCount: 0,
          parsedCount: 0,
          accumulatedCount: 0,
          topPostShortcutUsed: false,
          topPostShortcutMatched: false,
        },
      };
      if (supported) {
        const shortcutResult = await collectPostsWithTopPostShortcut(reason, groupId);
        collectedResult = shortcutResult || await collectPostsAcrossWindows();
      }
      const uniquePosts = collectedResult.posts;
      if (supported && uniquePosts.length) {
        setLatestTopPostForGroup(groupId, uniquePosts[0]);
      }
      if (supported && !collectedResult.meta.topPostShortcutMatched) {
        setLatestScanPostsForGroup(groupId, uniquePosts);
      }
      const candidateCount = collectedResult.meta.candidateCount;
      const parsedCount = collectedResult.meta.parsedCount;
      const uniqueCount = uniquePosts.length;
      // 每個群組第一次掃描只建立 baseline，不對既有貼文發通知。
      const baselineMode = !STATE.initializedGroups.has(groupId);
      const summaries = [];
      const matchesToNotify = [];

      for (const post of uniquePosts) {
        const postKey = getPostKey(post);
        const seen = hasSeenPost(groupId, post);
        const includeResult = matchRules(includeRules, post.normalizedText);
        const excludeResult = excludeRules.length
          ? matchRules(excludeRules, post.normalizedText)
          : { matched: false, rule: "" };

        const summary = {
          ...post,
          postKey,
          seen,
          includeRule: includeResult.rule,
          excludeRule: excludeResult.rule,
          eligible: includeResult.matched && !excludeResult.matched,
        };

        summaries.push(summary);

        // 已看過或不符合規則的貼文只保留在摘要，不進通知佇列。
        if (seen) continue;
        if (!summary.eligible) continue;

        matchesToNotify.push(summary);
      }

      if (baselineMode) {
        STATE.initializedGroups.add(groupId);
      }

      for (const item of matchesToNotify) {
        await notifyForPost(item);
        if (item.postKey) markPostSeen(groupId, item.postKey);
      }

      if (matchesToNotify.length) {
        addMatchHistory(groupId, matchesToNotify);
      }

      // 即使沒有通知，也會把本輪掃到的貼文記成 seen，避免下一輪重複報警。
      for (const item of summaries) {
        if (item.postKey) {
          markPostSeen(groupId, item.postKey);
        }
      }

      const seenStoreAfterUpdate = getSeenPostsStore();
      const latestSeenMap = seenStoreAfterUpdate[groupId] || {};

      STATE.latestPosts = summaries.map((item) => ({
        ...item,
        seen: Boolean(item.postKey && latestSeenMap[item.postKey]),
      }));
      STATE.latestScan = {
        reason,
        supported,
        groupId,
        candidateCount,
        cacheHitCount: collectedResult.meta.cacheHitCount ?? 0,
        freshExtractCount: collectedResult.meta.freshExtractCount ?? 0,
        parsedCount,
        scannedCount: uniqueCount,
        notifiedCount: matchesToNotify.length,
        baselineMode,
        targetCount: collectedResult.meta.targetCount ?? STATE.config.maxPostsPerScan,
        loadMoreMode: collectedResult.meta.mode || STATE.config.loadMoreMode,
        loadMoreAttempted: collectedResult.meta.attempted || false,
        loadMoreAttempts: collectedResult.meta.attempts || 0,
        maxWindowCount: collectedResult.meta.maxWindowCount ?? 0,
        stagnantWindows: collectedResult.meta.stagnantWindows ?? 0,
        stopReason: collectedResult.meta.stopReason || "",
        loadMoreBeforeCount: collectedResult.meta.beforeCount ?? 0,
        loadMoreAfterCount: collectedResult.meta.afterCount ?? 0,
        loadMoreWindowCount: collectedResult.meta.windowCount ?? 0,
        accumulatedCount: collectedResult.meta.accumulatedCount ?? 0,
        topPostShortcutUsed: collectedResult.meta.topPostShortcutUsed || false,
        topPostShortcutMatched: collectedResult.meta.topPostShortcutMatched || false,
        topPostKey: collectedResult.meta.topPostKey || "",
        previousTopPostKey: collectedResult.meta.previousTopPostKey || "",
        filteredEmptyTextCount: collectedResult.meta.filteredEmptyTextCount ?? 0,
        filteredNonPostCount: collectedResult.meta.filteredNonPostCount ?? 0,
        filteredFeedSortControlCount: collectedResult.meta.filteredFeedSortControlCount ?? 0,
        articleElementCount: collectedResult.meta.articleElementCount ?? 0,
        postsWithPostIdCount: collectedResult.meta.postsWithPostIdCount ?? 0,
        finishedAt: new Date().toISOString(),
      };
      if (!matchesToNotify.length) {
        STATE.latestNotification = null;
      }
      STATE.latestError = "";
    } catch (error) {
      STATE.latestError = String(error && error.message ? error.message : error);
      console.error("[fb-group-refresh] scan failed", error);
    } finally {
      STATE.isScanning = false;
      scheduleRefresh();
      renderPanel();
    }
  }

  // 對抽出的貼文再次去重，避免多個 selector 命中同一篇貼文。
  function dedupeExtractedPosts(posts, limit = STATE.config.maxPostsPerScan) {
    const seen = new Set();
    const results = [];

    for (const post of posts) {
      const key = getPostKey(post);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(post);
    }

    return results.slice(0, limit);
  }

  // 通知分發與手動測試通知。
  // 依目前設定分送桌面通知、ntfy 與 Discord Webhook。
  async function notifyForPost(post) {
    const title = "Facebook group match";
    const compactBody = buildCompactNotificationBody(post);
    const remoteBody = buildRemoteNotificationBody(post);
    const statusParts = [];

    STATE.latestNotification = {
      title,
      body: remoteBody,
      permalink: post.permalink,
      timestamp: new Date().toISOString(),
      status: "pending",
    };

    // 本地通知優先走 Tampermonkey GM_notification，不依賴網站權限。
    if (STATE.config.enableGmNotification) {
      try {
        GM_notification({
          title,
          text: compactBody,
          timeout: 15000,
        });
        statusParts.push("gm_sent");
      } catch (error) {
        statusParts.push("gm_failed");
      }
    }

    // 瀏覽器原生通知是額外選項，只有在權限已核准時才送。
    if (STATE.config.enableBrowserNotification && "Notification" in window) {
      try {
        if (Notification.permission === "granted") {
          const notification = new Notification(title, { body: compactBody });
          if (post.permalink) {
            notification.onclick = () => {
              window.open(post.permalink, "_blank", "noopener,noreferrer");
            };
          }
          statusParts.push("browser_sent");
        }
      } catch (error) {
        statusParts.push("browser_failed");
      }
    }

    // ntfy 為 opt-in 遠端通知通道；未設定 topic 時會直接略過。
    const ntfyStatus = await sendNtfyNotification({
      title,
      body: remoteBody,
      clickUrl: post.permalink,
    });
    if (ntfyStatus !== "ntfy_skipped") {
      statusParts.push(ntfyStatus);
    }

    const discordStatus = await sendDiscordWebhookNotification({
      title,
      body: remoteBody,
      clickUrl: post.permalink,
    });
    if (discordStatus !== "discord_skipped") {
      statusParts.push(discordStatus);
    }

    STATE.latestNotification.status = statusParts.length ? statusParts.join(", ") : "no_channel_sent";

    saveJson(STORAGE_KEYS.lastNotification, STATE.latestNotification);
  }

  // 從設定視窗觸發的手動測試通知。
  async function sendTestNotification() {
    await requestBrowserNotificationPermission();
    const mockPost = {
      author: "Test",
      includeRule: "manual test",
      text: "This is a test notification from facebook_group_refresh.",
      permalink: location.href,
    };
    await notifyForPost(mockPost);
    renderPanel();
  }

  // UI: 命中歷史視窗。
  // 建立命中通知歷史視窗的 DOM；只建立一次。
  function createHistoryModal() {
    if (document.getElementById("fbgr-history-modal")) return;

    const overlay = document.createElement("div");
    overlay.id = "fbgr-history-modal";
    overlay.style.cssText = [
      "display:none",
      "position:fixed",
      "inset:0",
      "z-index:2147483644",
      "background:rgba(0,0,0,0.55)",
      "padding:24px",
      "box-sizing:border-box",
    ].join(";");

    overlay.innerHTML = `
      <div style="max-width:720px;margin:40px auto 0 auto;background:#111827;color:#f9fafb;border:1px solid #4b5563;border-radius:14px;padding:16px;box-shadow:0 18px 40px rgba(0,0,0,0.4);font-family:Consolas, 'Courier New', monospace;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;">
          <div style="font-size:16px;font-weight:bold;">符合關鍵字紀錄</div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button id="fbgr-history-clear" style="padding:4px 8px;cursor:pointer;">清空紀錄</button>
            <button id="fbgr-history-close" style="padding:4px 8px;cursor:pointer;">關閉</button>
          </div>
        </div>
        <div id="fbgr-history-content" style="display:grid;gap:10px;max-height:70vh;overflow:auto;"></div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeHistoryModal();
      }
    });
    overlay.querySelector("#fbgr-history-clear").addEventListener("click", () => {
      if (!window.confirm("確定要清空所有符合關鍵字紀錄嗎？")) return;
      clearMatchHistory();
      openHistoryModal();
    });
    overlay.querySelector("#fbgr-history-close").addEventListener("click", closeHistoryModal);
  }

  // 讀取全域命中歷史並渲染到視窗中。
  function openHistoryModal() {
    createHistoryModal();
    const overlay = document.getElementById("fbgr-history-modal");
    const content = overlay?.querySelector("#fbgr-history-content");
    if (!overlay || !content) return;

    const displayHistory = getMatchHistoryStore();

    if (!displayHistory.length) {
      content.innerHTML = "<div>目前還沒有符合關鍵字的紀錄。</div>";
    } else {
      content.innerHTML = displayHistory
        .map((item, index) => {
          const linkHtml = item.permalink
            ? `<a href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener noreferrer" style="color:#93c5fd;">開啟貼文</a>`
            : "";
          const notifiedAtLabel = escapeHtml(formatNotificationTimestamp(item.notifiedAt));
          const groupRow = renderHistoryFieldRow(
            "社團",
            escapeHtml(item.groupName || item.groupId || "(未知)")
          );
          const authorRow = renderHistoryFieldRow("作者", escapeHtml(item.author || "(無)"));
          const keywordRow = renderHistoryFieldRow("關鍵字", escapeHtml(item.includeRule || "(無)"));
          const notifiedAtRow = renderHistoryFieldRow("通知時間", notifiedAtLabel);
          const contentRow = renderHistoryFieldRow(
            "內容",
            renderHighlightedHistoryContent(truncate(item.text, 220) || "(空白)", item.includeRule)
          );
          return `
            <div style="padding:10px;border:1px solid #374151;border-radius:10px;background:rgba(255,255,255,0.03);">
              <div>#${index + 1}</div>
              ${groupRow}
              <div style="height:10px;"></div>
              ${authorRow}
              ${keywordRow}
              ${notifiedAtRow}
              ${contentRow}
              ${linkHtml ? `<div style="margin-top:6px;">${linkHtml}</div>` : ""}
            </div>
          `;
        })
        .join("");
    }

    overlay.style.display = "block";
  }

  // 關閉命中通知歷史視窗。
  function closeHistoryModal() {
    const overlay = document.getElementById("fbgr-history-modal");
    if (overlay) overlay.style.display = "none";
  }

  // UI: include 規則說明視窗。
  // 建立 include 規則說明視窗，解釋 OR / AND 的輸入方式。
  function createIncludeHelpModal() {
    if (document.getElementById("fbgr-include-help-modal")) return;

    const overlay = document.createElement("div");
    overlay.id = "fbgr-include-help-modal";
    overlay.style.cssText = [
      "display:none",
      "position:fixed",
      "inset:0",
      "z-index:2147483646",
      "background:rgba(0,0,0,0.55)",
      "padding:24px",
      "box-sizing:border-box",
    ].join(";");

    overlay.innerHTML = `
      <div style="max-width:520px;margin:40px auto 0 auto;background:#111827;color:#f9fafb;border:1px solid #4b5563;border-radius:14px;padding:16px;box-shadow:0 18px 40px rgba(0,0,0,0.4);font-family:Consolas, 'Courier New', monospace;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;">
          <div style="font-size:16px;font-weight:bold;">關鍵字輸入規則</div>
          <button id="fbgr-include-help-close" style="padding:4px 8px;cursor:pointer;">關閉</button>
        </div>
        <div style="display:grid;gap:14px;line-height:1.6;">
          <div style="display:grid;gap:6px;">
            <div><code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">;</code> 表示 <strong>OR</strong></div>
            <div>空格表示 <strong>AND</strong></div>
          </div>
          <div style="display:grid;gap:8px;padding:10px;border:1px solid #374151;border-radius:10px;background:rgba(255,255,255,0.03);">
            <div style="font-weight:bold;">示例 1</div>
            <div><code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;">搖滾;6880;5880</code></div>
            <div>只要出現 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">搖滾</code> 或 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">6880</code> 或 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">5880</code> 就通知。</div>
          </div>
          <div style="display:grid;gap:8px;padding:10px;border:1px solid #374151;border-radius:10px;background:rgba(255,255,255,0.03);">
            <div style="font-weight:bold;">示例 2</div>
            <div><code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;">搖滾 6880;搖滾 5880</code></div>
            <div>代表 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">搖滾</code> 且 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">6880</code>，或 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">搖滾</code> 且 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">5880</code> 才通知。</div>
          </div>
          <div>排除關鍵字也使用同樣規則。</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeIncludeHelpModal();
      }
    });
    overlay.querySelector("#fbgr-include-help-close").addEventListener("click", closeIncludeHelpModal);
  }

  // 顯示 include 規則說明視窗。
  function openIncludeHelpModal() {
    createIncludeHelpModal();
    const overlay = document.getElementById("fbgr-include-help-modal");
    if (overlay) overlay.style.display = "block";
  }

  // 關閉 include 規則說明視窗。
  function closeIncludeHelpModal() {
    const overlay = document.getElementById("fbgr-include-help-modal");
    if (overlay) overlay.style.display = "none";
  }

  // UI: ntfy 說明視窗。
  // 建立 ntfy 說明視窗，說明 topic 的用途與基本設定步驟。
  function createNtfyHelpModal() {
    if (document.getElementById("fbgr-ntfy-help-modal")) return;

    const overlay = document.createElement("div");
    overlay.id = "fbgr-ntfy-help-modal";
    overlay.style.cssText = [
      "display:none",
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "background:rgba(0,0,0,0.55)",
      "padding:24px",
      "box-sizing:border-box",
    ].join(";");

    overlay.innerHTML = `
      <div style="max-width:520px;margin:40px auto 0 auto;background:#111827;color:#f9fafb;border:1px solid #4b5563;border-radius:14px;padding:16px;box-shadow:0 18px 40px rgba(0,0,0,0.4);font-family:Consolas, 'Courier New', monospace;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;">
          <div style="font-size:16px;font-weight:bold;">ntfy 說明</div>
          <button id="fbgr-ntfy-help-close" style="padding:4px 8px;cursor:pointer;">關閉</button>
        </div>
        <div style="display:grid;gap:12px;line-height:1.6;">
          <div>不填 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">ntfy topic</code> 也可以使用，腳本仍會透過桌面通知在電腦上提醒你。</div>
          <div>如果希望手機也同步收到提醒，可以另外設定 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">ntfy</code>。</div>
          <div style="display:grid;gap:6px;padding:10px;border:1px solid #374151;border-radius:10px;background:rgba(255,255,255,0.03);">
            <div style="font-weight:bold;">建議步驟</div>
            <div>1. 在手機上安裝 ntfy App</div>
            <div>2. 在 App 內按 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">+</code>，輸入 topic，例如 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">my-facebook-alerts</code></div>
            <div>3. 建議使用英文字母、數字、減號或底線</div>
            <div>4. 回到電腦上的 Facebook 頁面，在腳本面板中按「設定」</div>
            <div>5. 在 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">ntfy topic</code> 輸入完全相同的 topic</div>
            <div>6. 按一次「測試通知」，確認手機 App 是否有收到通知；通知可能會有些許延遲</div>
          </div>
          <div style="font-size:12px;color:#d1d5db;">若你另外修改了刷新秒數、掃描貼文數等其他設定，再按「儲存設定」。</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeNtfyHelpModal();
      }
    });
    overlay.querySelector("#fbgr-ntfy-help-close").addEventListener("click", closeNtfyHelpModal);
  }

  // 顯示 ntfy 說明視窗。
  function openNtfyHelpModal() {
    createNtfyHelpModal();
    const overlay = document.getElementById("fbgr-ntfy-help-modal");
    if (overlay) overlay.style.display = "block";
  }

  // 關閉 ntfy 說明視窗。
  function closeNtfyHelpModal() {
    const overlay = document.getElementById("fbgr-ntfy-help-modal");
    if (overlay) overlay.style.display = "none";
  }

  // UI: Discord Webhook 說明視窗。
  // 建立 Discord Webhook 說明視窗，說明 URL 的用途與基本設定步驟。
  function createDiscordHelpModal() {
    if (document.getElementById("fbgr-discord-help-modal")) return;

    const overlay = document.createElement("div");
    overlay.id = "fbgr-discord-help-modal";
    overlay.style.cssText = [
      "display:none",
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "background:rgba(0,0,0,0.55)",
      "padding:24px",
      "box-sizing:border-box",
    ].join(";");

    overlay.innerHTML = `
      <div style="max-width:520px;margin:40px auto 0 auto;background:#111827;color:#f9fafb;border:1px solid #4b5563;border-radius:14px;padding:16px;box-shadow:0 18px 40px rgba(0,0,0,0.4);font-family:Consolas, 'Courier New', monospace;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;">
          <div style="font-size:16px;font-weight:bold;">Discord Webhook 說明</div>
          <button id="fbgr-discord-help-close" style="padding:4px 8px;cursor:pointer;">關閉</button>
        </div>
        <div style="display:grid;gap:12px;line-height:1.6;">
          <div>不填 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">Discord Webhook URL</code> 也可以使用，腳本仍會透過桌面通知在電腦上提醒你。</div>
          <div>如果希望通知直接送到 Discord 頻道，可以另外設定 Discord Webhook。</div>
          <div style="display:grid;gap:6px;padding:10px;border:1px solid #374151;border-radius:10px;background:rgba(255,255,255,0.03);">
            <div style="font-weight:bold;">建議步驟</div>
            <div>1. 在 Discord 選擇目標頻道，進入「編輯頻道」</div>
            <div>2. 點選「整合」→「Webhooks」→「新 Webhook」</div>
            <div>3. 複製 Webhook URL</div>
            <div>4. 回到電腦上的 Facebook 頁面，在腳本面板中按「設定」</div>
            <div>5. 在 <code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;">Discord Webhook URL</code> 貼上剛剛複製的網址</div>
            <div>6. 按一次「測試通知」，確認 Discord 頻道是否有收到通知；通知可能會有些許延遲</div>
          </div>
          <div style="font-size:12px;color:#d1d5db;">留空則不會傳送 Discord 通知。</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeDiscordHelpModal();
      }
    });
    overlay.querySelector("#fbgr-discord-help-close").addEventListener("click", closeDiscordHelpModal);
  }

  // 顯示 Discord Webhook 說明視窗。
  function openDiscordHelpModal() {
    createDiscordHelpModal();
    const overlay = document.getElementById("fbgr-discord-help-modal");
    if (overlay) overlay.style.display = "block";
  }

  // 關閉 Discord Webhook 說明視窗。
  function closeDiscordHelpModal() {
    const overlay = document.getElementById("fbgr-discord-help-modal");
    if (overlay) overlay.style.display = "none";
  }

  // UI: 設定視窗與刷新模式切換。
  // 建立設定視窗，集中管理 refresh、load more、ntfy 與 Discord Webhook。
  function createSettingsModal() {
    if (document.getElementById("fbgr-settings-modal")) return;

    const overlay = document.createElement("div");
    overlay.id = "fbgr-settings-modal";
    overlay.style.cssText = [
      "display:none",
      "position:fixed",
      "inset:0",
      "z-index:2147483645",
      "background:rgba(0,0,0,0.55)",
      "padding:24px",
      "box-sizing:border-box",
    ].join(";");

    overlay.innerHTML = `
      <div style="max-width:520px;margin:40px auto 0 auto;background:#111827;color:#f9fafb;border:1px solid #4b5563;border-radius:14px;padding:16px;box-shadow:0 18px 40px rgba(0,0,0,0.4);font-family:Consolas, 'Courier New', monospace;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;">
          <div style="font-size:16px;font-weight:bold;">設定</div>
          <button id="fbgr-settings-close" style="padding:4px 8px;cursor:pointer;">關閉</button>
        </div>
        <div style="display:grid;gap:12px;">
          <label style="display:flex;align-items:center;gap:8px;">
            <input id="fbgr-jitter-enabled" type="checkbox" />
            <span>啟用浮動刷新</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;">
            <input id="fbgr-auto-load-more" type="checkbox" />
            <span>自動載入更多貼文</span>
          </label>
          <div id="fbgr-fixed-wrap" style="display:grid;gap:4px;">
            <label for="fbgr-fixed-refresh">固定刷新秒數</label>
            <input id="fbgr-fixed-refresh" type="number" min="5" step="1" style="padding:6px;border-radius:6px;border:1px solid #6b7280;background:#111827;color:#f9fafb;" />
          </div>
          <div id="fbgr-jitter-wrap" style="display:grid;gap:8px;">
            <div style="display:grid;gap:4px;">
              <label for="fbgr-refresh-min">最小刷新秒數</label>
              <input id="fbgr-refresh-min" type="number" min="5" step="1" style="padding:6px;border-radius:6px;border:1px solid #6b7280;background:#111827;color:#f9fafb;" />
            </div>
            <div style="display:grid;gap:4px;">
              <label for="fbgr-refresh-max">最大刷新秒數</label>
              <input id="fbgr-refresh-max" type="number" min="5" step="1" style="padding:6px;border-radius:6px;border:1px solid #6b7280;background:#111827;color:#f9fafb;" />
            </div>
          </div>
          <div style="display:grid;gap:4px;">
            <label for="fbgr-max-posts-per-scan">目標掃描貼文數</label>
            <input id="fbgr-max-posts-per-scan" type="number" min="1" max="10" step="1" style="padding:6px;border-radius:6px;border:1px solid #6b7280;background:#111827;color:#f9fafb;" />
          </div>
          <div style="display:grid;gap:4px;">
            <label for="fbgr-ntfy-topic" style="display:flex;align-items:center;gap:6px;">
              <span>ntfy topic (選填)</span>
              <button id="fbgr-ntfy-help" type="button" style="width:20px;height:20px;border-radius:999px;border:1px solid #6b7280;background:#111827;color:#f9fafb;cursor:pointer;padding:0;line-height:1;">?</button>
            </label>
            <input id="fbgr-ntfy-topic" type="text" placeholder="例如：my-facebook-alerts" style="padding:6px;border-radius:6px;border:1px solid #6b7280;background:#111827;color:#f9fafb;" />
          </div>
          <div style="display:grid;gap:4px;">
            <label for="fbgr-discord-webhook" style="display:flex;align-items:center;gap:6px;">
              <span>Discord Webhook URL (選填)</span>
              <button id="fbgr-discord-help" type="button" style="width:20px;height:20px;border-radius:999px;border:1px solid #6b7280;background:#111827;color:#f9fafb;cursor:pointer;padding:0;line-height:1;">?</button>
            </label>
            <input id="fbgr-discord-webhook" type="text" placeholder="例如：https://discord.com/api/webhooks/..." style="padding:6px;border-radius:6px;border:1px solid #6b7280;background:#111827;color:#f9fafb;" />
          </div>
          <div style="padding:10px;border:1px solid #374151;border-radius:8px;background:rgba(255,255,255,0.03);color:#d1d5db;">
            系統會盡量湊滿你設定的貼文數，最多可設定 10 篇。頁面內查看紀錄仍保留最新 10 筆符合關鍵字的通知紀錄。
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-start;">
            <button id="fbgr-settings-test" style="padding:6px 10px;cursor:pointer;">測試通知</button>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="fbgr-settings-cancel" style="padding:6px 10px;cursor:pointer;">取消</button>
            <button id="fbgr-settings-save" style="padding:6px 10px;cursor:pointer;">儲存設定</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeSettingsModal();
      }
    });

    overlay.querySelector("#fbgr-settings-close").addEventListener("click", closeSettingsModal);
    overlay.querySelector("#fbgr-settings-cancel").addEventListener("click", closeSettingsModal);
    overlay.querySelector("#fbgr-jitter-enabled").addEventListener("change", renderSettingsMode);
    overlay.querySelector("#fbgr-ntfy-help").addEventListener("click", openNtfyHelpModal);
    overlay.querySelector("#fbgr-discord-help").addEventListener("click", openDiscordHelpModal);
    overlay.querySelector("#fbgr-settings-test").addEventListener("click", () => {
      const ntfyTopic = normalizeText(overlay.querySelector("#fbgr-ntfy-topic").value);
      const discordWebhook = normalizeText(overlay.querySelector("#fbgr-discord-webhook").value);
      saveNtfyTopicSetting(ntfyTopic);
      saveDiscordWebhookSetting(discordWebhook);
      sendTestNotification();
    });
    overlay.querySelector("#fbgr-settings-save").addEventListener("click", () => {
      const jitterEnabled = overlay.querySelector("#fbgr-jitter-enabled").checked;
      const ntfyTopic = normalizeText(overlay.querySelector("#fbgr-ntfy-topic").value);
      const discordWebhook = normalizeText(overlay.querySelector("#fbgr-discord-webhook").value);
      const autoLoadMorePosts = overlay.querySelector("#fbgr-auto-load-more").checked;
      const minRefreshSec = Math.max(5, Math.floor(Number(overlay.querySelector("#fbgr-refresh-min").value) || STATE.config.minRefreshSec));
      const maxRefreshSec = Math.max(5, Math.floor(Number(overlay.querySelector("#fbgr-refresh-max").value) || STATE.config.maxRefreshSec));
      const fixedRefreshSec = Math.max(5, Math.floor(Number(overlay.querySelector("#fbgr-fixed-refresh").value) || STATE.config.fixedRefreshSec));
      const maxPostsPerScan = clampTargetPostCount(overlay.querySelector("#fbgr-max-posts-per-scan").value);

      STATE.config.jitterEnabled = jitterEnabled;
      STATE.config.ntfyTopic = ntfyTopic;
      STATE.config.discordWebhook = discordWebhook;
      STATE.config.autoLoadMorePosts = autoLoadMorePosts;
      STATE.config.loadMoreMode = DEFAULT_CONFIG.loadMoreMode;
      STATE.config.minRefreshSec = minRefreshSec;
      STATE.config.maxRefreshSec = maxRefreshSec;
      STATE.config.fixedRefreshSec = fixedRefreshSec;
      STATE.config.maxPostsPerScan = maxPostsPerScan;
      saveRefreshSettings();
      closeSettingsModal();
      scheduleRefresh();
      renderPanel();
    });
  }

  // 依 jitter 是否啟用，切換固定刷新 / 範圍刷新欄位顯示。
  function renderSettingsMode() {
    const overlay = document.getElementById("fbgr-settings-modal");
    if (!overlay) return;

    const jitterEnabled = overlay.querySelector("#fbgr-jitter-enabled").checked;
    overlay.querySelector("#fbgr-jitter-wrap").style.display = jitterEnabled ? "grid" : "none";
    overlay.querySelector("#fbgr-fixed-wrap").style.display = jitterEnabled ? "none" : "grid";
  }

  // 將目前設定灌入設定視窗並顯示。
  function openSettingsModal() {
    createSettingsModal();
    const overlay = document.getElementById("fbgr-settings-modal");
    if (!overlay) return;

    STATE.config.ntfyTopic = getPersistedNtfyTopic();
    STATE.config.discordWebhook = getPersistedDiscordWebhook();
    overlay.querySelector("#fbgr-jitter-enabled").checked = STATE.config.jitterEnabled;
    overlay.querySelector("#fbgr-ntfy-topic").value = STATE.config.ntfyTopic;
    overlay.querySelector("#fbgr-discord-webhook").value = STATE.config.discordWebhook;
    overlay.querySelector("#fbgr-auto-load-more").checked = STATE.config.autoLoadMorePosts;
    overlay.querySelector("#fbgr-refresh-min").value = String(STATE.config.minRefreshSec);
    overlay.querySelector("#fbgr-refresh-max").value = String(STATE.config.maxRefreshSec);
    overlay.querySelector("#fbgr-fixed-refresh").value = String(STATE.config.fixedRefreshSec);
    overlay.querySelector("#fbgr-max-posts-per-scan").value = String(STATE.config.maxPostsPerScan);
    renderSettingsMode();
    overlay.style.display = "block";
  }

  // 關閉設定視窗。
  function closeSettingsModal() {
    const overlay = document.getElementById("fbgr-settings-modal");
    if (overlay) overlay.style.display = "none";
  }

  // UI: 主控制面板建立與互動事件綁定。
  // 建立右上角主控制面板，並綁定所有主要互動事件。
  function createPanel() {
    if (document.getElementById("fb-group-refresh-panel")) return;

    const panel = document.createElement("div");
    panel.id = "fb-group-refresh-panel";
    panel.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      "z-index:2147483643",
      "width:380px",
      "max-height:84vh",
      "overflow:auto",
      "background:rgba(17,24,39,0.96)",
      "color:#f9fafb",
      "border:1px solid #4b5563",
      "border-radius:12px",
      "padding:12px",
      "box-shadow:0 12px 28px rgba(0,0,0,0.35)",
      "font-size:13px",
      "line-height:1.45",
      "font-family:Consolas, 'Courier New', monospace",
    ].join(";");

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;">
        <div style="font-size:15px;font-weight:bold;">Facebook 社團監看</div>
        <button id="fbgr-debug-toggle" style="padding:4px 8px;cursor:pointer;">除錯</button>
      </div>
      <div style="display:grid;gap:8px;">
        <label style="display:grid;gap:4px;">
          <span style="display:flex;align-items:center;gap:6px;">
            <span>包含關鍵字</span>
            <button id="fbgr-include-help" type="button" style="width:20px;height:20px;border-radius:999px;border:1px solid #6b7280;background:#111827;color:#f9fafb;cursor:pointer;padding:0;line-height:1;">?</button>
          </span>
          <textarea id="fbgr-include" rows="2" style="resize:vertical;padding:6px;border-radius:6px;border:1px solid #6b7280;background:#111827;color:#f9fafb;"></textarea>
        </label>
        <label style="display:grid;gap:4px;">
          <span>排除關鍵字</span>
          <textarea id="fbgr-exclude" rows="2" style="resize:vertical;padding:6px;border-radius:6px;border:1px solid #6b7280;background:#111827;color:#f9fafb;"></textarea>
        </label>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button id="fbgr-pause" style="padding:6px 10px;cursor:pointer;">開始</button>
            <button id="fbgr-save" style="padding:6px 10px;cursor:pointer;">儲存</button>
            <span id="fbgr-unsaved-indicator" style="display:none;align-self:center;font-size:12px;color:#fbbf24;">尚未儲存</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
            <button id="fbgr-history" style="padding:6px 10px;cursor:pointer;">查看紀錄</button>
            <button id="fbgr-settings" style="padding:6px 10px;cursor:pointer;">設定</button>
          </div>
        </div>
        <div id="fbgr-status" style="padding:8px;border:1px solid #374151;border-radius:8px;background:rgba(255,255,255,0.03);"></div>
        <div id="fbgr-debug" style="display:none;padding:8px;border:1px solid #374151;border-radius:8px;background:rgba(0,0,0,0.18);color:#c7d2fe;"></div>
      </div>
    `;

    document.body.appendChild(panel);
    createSettingsModal();
    createHistoryModal();
    createIncludeHelpModal();
    createNtfyHelpModal();
    createDiscordHelpModal();

    panel.querySelector("#fbgr-include").addEventListener("input", persistDraftInputs);
    panel.querySelector("#fbgr-exclude").addEventListener("input", persistDraftInputs);
    panel.querySelector("#fbgr-include-help").addEventListener("click", openIncludeHelpModal);
    panel.querySelector("#fbgr-history").addEventListener("click", openHistoryModal);
    panel.querySelector("#fbgr-settings").addEventListener("click", openSettingsModal);

    panel.querySelector("#fbgr-save").addEventListener("click", () => {
      const include = panel.querySelector("#fbgr-include").value;
      const exclude = panel.querySelector("#fbgr-exclude").value;

      STATE.config.includeKeywords = normalizeText(include);
      STATE.config.excludeKeywords = normalizeText(exclude);
      saveString(STORAGE_KEYS.include, STATE.config.includeKeywords);
      saveString(STORAGE_KEYS.exclude, STATE.config.excludeKeywords);

      renderPanel();
      runScan("save");
    });

    panel.querySelector("#fbgr-pause").addEventListener("click", () => {
      STATE.config.paused = !STATE.config.paused;
      saveString(STORAGE_KEYS.paused, String(STATE.config.paused));

      if (STATE.config.paused) {
        clearRefreshTimer();
        if (STATE.scanTimer) clearTimeout(STATE.scanTimer);
      } else {
        clearSeenPostsForGroup(getCurrentGroupId());
        scheduleScan("manual-start");
      }

      renderPanel();
    });

    panel.querySelector("#fbgr-debug-toggle").addEventListener("click", () => {
      STATE.config.debugVisible = !STATE.config.debugVisible;
      saveString(STORAGE_KEYS.debugVisible, String(STATE.config.debugVisible));
      renderPanel();
    });

    STATE.panelMounted = true;
    renderPanel();
  }

  // 將下一次 refresh 倒數格式化成面板文字。
  function formatRefreshStatus() {
    if (!STATE.refreshDeadline) return "未排程";
    const remainSec = Math.max(0, Math.ceil((STATE.refreshDeadline - Date.now()) / 1000));
    return `${remainSec}s`;
  }

  // 將最後掃描時間格式化為相對時間字串。
  function formatLastScanStatus(value) {
    if (!value) return "(無)";

    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) {
      return String(value);
    }

    const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diffSec < 5) return "剛剛";
    if (diffSec < 60) return `${diffSec} 秒前`;

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} 分鐘前`;

    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} 小時前`;

    const diffDay = Math.floor(diffHour / 24);
    return `${diffDay} 天前`;
  }

  // 將中文欄位名稱補到 4 個字寬，並以靠右方式讓冒號大致對齊。
  function formatAlignedLabel(label, minWidth = 4) {
    const normalized = String(label || "");
    return normalized.length >= minWidth ? normalized : normalized.padStart(minWidth, "　");
  }

  // 將 ISO 通知時間格式化為本地時間，精確到分鐘。
  function formatNotificationTimestamp(value) {
    if (!value) return "(無)";

    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return String(value);
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}  ${hours}:${minutes}`;
  }

  // 將命中的 include 規則 terms 以橘色標出，用於查看紀錄中的內容欄位。
  function renderHighlightedHistoryContent(text, includeRule) {
    const source = String(text || "");
    const terms = Array.from(new Set(
      normalizeText(includeRule)
        .split(" ")
        .map((term) => normalizeText(term))
        .filter(Boolean)
    )).sort((a, b) => b.length - a.length);

    if (!source || !terms.length) {
      return escapeHtml(source);
    }

    const ranges = [];
    for (const term of terms) {
      const pattern = new RegExp(escapeRegExp(term), "gi");
      let match;
      while ((match = pattern.exec(source))) {
        const start = match.index;
        const end = start + match[0].length;
        if (end > start) {
          ranges.push([start, end]);
        }
      }
    }

    if (!ranges.length) {
      return escapeHtml(source);
    }

    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

    const mergedRanges = [];
    for (const [start, end] of ranges) {
      const lastRange = mergedRanges[mergedRanges.length - 1];
      if (!lastRange || start > lastRange[1]) {
        mergedRanges.push([start, end]);
      } else if (end > lastRange[1]) {
        lastRange[1] = end;
      }
    }

    let html = "";
    let cursor = 0;

    for (const [start, end] of mergedRanges) {
      if (start > cursor) {
        html += escapeHtml(source.slice(cursor, start));
      }
      html += `<span style="color:#fbbf24;">${escapeHtml(source.slice(start, end))}</span>`;
      cursor = end;
    }

    if (cursor < source.length) {
      html += escapeHtml(source.slice(cursor));
    }

    return html;
  }

  // 建立雙欄位列，讓長文字換行時與冒號後方對齊。
  function renderHistoryFieldRow(label, value, options = {}) {
    const { marginTop = 0 } = options;
    return `
      <div style="display:grid;grid-template-columns:max-content minmax(0,1fr);column-gap:6px;align-items:start;${marginTop ? `margin-top:${marginTop}px;` : ""}">
        <div>${escapeHtml(formatAlignedLabel(label))}:</div>
        <div style="min-width:0;overflow-wrap:anywhere;word-break:break-word;">${value}</div>
      </div>
    `;
  }

  // UI: 主面板與 debug 區塊渲染。
  // 依 STATE 重新渲染主面板狀態、貼文摘要與 debug 資訊。
  function renderPanel() {
    if (!document.body) return;
    if (!document.getElementById("fb-group-refresh-panel")) createPanel();

    const panel = document.getElementById("fb-group-refresh-panel");
    if (!panel) return;

    const includeEl = panel.querySelector("#fbgr-include");
    const excludeEl = panel.querySelector("#fbgr-exclude");
    const pauseEl = panel.querySelector("#fbgr-pause");
    const statusEl = panel.querySelector("#fbgr-status");
    const debugEl = panel.querySelector("#fbgr-debug");
    const unsavedEl = panel.querySelector("#fbgr-unsaved-indicator");

    if (includeEl !== document.activeElement) includeEl.value = STATE.config.includeKeywords;
    if (excludeEl !== document.activeElement) excludeEl.value = STATE.config.excludeKeywords;
    pauseEl.textContent = STATE.config.paused ? "開始" : "暫停";
    if (unsavedEl) unsavedEl.style.display = hasUnsavedKeywordChanges() ? "inline" : "none";

    const latestScan = STATE.latestScan;
    const groupName = getCurrentGroupName() || "無法判斷";
    const feedSortLabel = getCurrentFeedSortLabel() || "無法判斷";
    const isPreferredFeedSort = feedSortLabel === "新貼文";
    const feedSortColor = isPreferredFeedSort ? "#f9fafb" : "#fbbf24";
    const feedSortDisplay = isPreferredFeedSort
      ? feedSortLabel
      : `${feedSortLabel}（建議調成新貼文）`;
    const postListHtml = STATE.latestPosts.length
      ? `
          <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);">
            <div style="margin-bottom:6px;">已獲取 ${STATE.latestPosts.length} 篇貼文：</div>
            ${STATE.latestPosts.map((post, index) => {
              const authorLabel = escapeHtml(post.author || "(作者未知)");
              const matchedLabel = post.eligible
                ? ' <span style="color:#fbbf24;">[符合]</span>'
                : "";
              return `<div>${index + 1}. ${authorLabel}${matchedLabel}</div>`;
            }).join("")}
            <div style="margin-top:8px;font-size:12px;color:#9ca3af;">詳細內容請至「查看紀錄」查看</div>
          </div>
        `
      : `
          <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);">
            <div>尚未獲取貼文</div>
          </div>
        `;

    statusEl.innerHTML = [
      renderHistoryFieldRow("狀態", STATE.config.paused ? "已暫停" : "監控中"),
      renderHistoryFieldRow("社團", escapeHtml(groupName)),
      renderHistoryFieldRow("貼文排序", `<span style="color:${feedSortColor};">${escapeHtml(feedSortDisplay)}</span>`),
      renderHistoryFieldRow("目標貼文", `${STATE.config.maxPostsPerScan} 篇`),
      renderHistoryFieldRow("刷新模式", escapeHtml(formatRefreshModeLabel())),
      renderHistoryFieldRow("下次刷新", escapeHtml(formatRefreshStatus())),
      renderHistoryFieldRow("停止原因", escapeHtml(latestScan?.stopReason || "(無)")),
      postListHtml,
    ].join("");

    debugEl.style.display = STATE.config.debugVisible ? "block" : "none";

    if (STATE.config.debugVisible) {
      const postRows = STATE.latestPosts.length
        ? STATE.latestPosts.map((post, index) => {
            return `
              <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);">
                <div>#${index + 1} 來源=${escapeHtml(post.source)}</div>
                <div>貼文ID=${escapeHtml(post.postId || "(無)")}</div>
                <div>作者=${escapeHtml(post.author || "(無)")}</div>
                <div>時間=${escapeHtml(post.timestampText || "(無)")}</div>
                <div>容器=${escapeHtml(post.containerRole || "(無)")} | 文字來源=${escapeHtml(post.textSource || "(無)")}</div>
                <div>有貼文ID=${post.postId ? "是" : "否"}</div>
                <div>命中包含=${escapeHtml(post.includeRule || "(無)")}</div>
                <div>命中排除=${escapeHtml(post.excludeRule || "(無)")}</div>
                <div>可通知=${post.eligible ? "是" : "否"} | 已看過=${post.seen ? "是" : "否"}</div>
                <div>文字=${escapeHtml(truncate(post.text, 180) || "(空白)")}</div>
              </div>
            `;
          }).join("")
        : "<div>目前還沒有抽到貼文。</div>";

      debugEl.innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
          <button id="fbgr-debug-copy" type="button" style="padding:4px 8px;cursor:pointer;">複製</button>
        </div>
        <div id="fbgr-debug-content">
          <div>網址: ${escapeHtml(location.href)}</div>
          <div>包含: ${escapeHtml(STATE.config.includeKeywords || "(空白)")}</div>
          <div>排除: ${escapeHtml(STATE.config.excludeKeywords || "(空白)")}</div>
          <div>掃描原因: ${escapeHtml(latestScan?.reason || "(無)")}</div>
          <div>首次掃描: ${latestScan?.baselineMode ? "是" : "否"}</div>
          <div>目標貼文數: ${latestScan?.targetCount ?? STATE.config.maxPostsPerScan}</div>
          <div>自動載入方式: ${escapeHtml(latestScan?.loadMoreMode || STATE.config.loadMoreMode)}</div>
          <div>最上方快篩: ${latestScan?.topPostShortcutUsed ? (latestScan?.topPostShortcutMatched ? "命中，已跳過深度掃描" : "已檢查，需完整掃描") : "未啟用"}</div>
          <div>自動載入嘗試: ${latestScan?.loadMoreAttempted ? `${latestScan?.loadMoreAttempts || 0} 次` : "未執行"}</div>
          <div>安全掃描上限: ${latestScan?.maxWindowCount ?? 0} 輪</div>
          <div>視窗掃描次數: ${latestScan?.loadMoreWindowCount ?? 0}</div>
          <div>停止原因: ${escapeHtml(latestScan?.stopReason || "(無)")}</div>
          <div>本輪最上方貼文 key: ${escapeHtml(latestScan?.topPostKey || "(無)")}</div>
          <div>上一輪最上方貼文 key: ${escapeHtml(latestScan?.previousTopPostKey || "(無)")}</div>
          <div>貼文數變化: ${(latestScan?.loadMoreBeforeCount ?? 0)} -> ${(latestScan?.loadMoreAfterCount ?? 0)}</div>
          <div>累積候選容器次數: ${latestScan?.candidateCount ?? 0}</div>
          <div>實際解析次數: ${latestScan?.freshExtractCount ?? 0}</div>
          <div>快取命中次數: ${latestScan?.cacheHitCount ?? 0}</div>
          <div>累積有效貼文次數: ${latestScan?.parsedCount ?? 0}</div>
          <div>累積唯一貼文數: ${latestScan?.accumulatedCount ?? latestScan?.scannedCount ?? 0}</div>
          <div>排除控制列數: ${latestScan?.filteredFeedSortControlCount ?? 0}</div>
          <div>排除非貼文數: ${latestScan?.filteredNonPostCount ?? 0}</div>
          <div>排除空白內容數: ${latestScan?.filteredEmptyTextCount ?? 0}</div>
          <div>最終去重後貼文數: ${latestScan?.scannedCount ?? 0}</div>
          <div>最後通知狀態: ${escapeHtml(STATE.latestNotification?.status || "(本次無)")}</div>
          <div>錯誤: ${escapeHtml(STATE.latestError || "(無)")}</div>
          ${postRows}
        </div>
      `;

      const copyButton = debugEl.querySelector("#fbgr-debug-copy");
      const debugContent = debugEl.querySelector("#fbgr-debug-content");
      if (copyButton && debugContent) {
        copyButton.addEventListener("click", async () => {
          const copied = await copyTextToClipboard(debugContent.innerText || debugContent.textContent || "");
          copyButton.textContent = copied ? "已複製" : "複製失敗";
          window.setTimeout(() => {
            if (document.body.contains(copyButton)) {
              copyButton.textContent = "複製";
            }
          }, 1200);
        });
      }
    }
  }

  // 監聽 Facebook 動態 DOM / route 變化並維持腳本生命週期。
  // 重新安裝 MutationObserver，當動態牆新增節點時觸發下一輪掃描。
  function installObserver() {
    if (STATE.observer) {
      STATE.observer.disconnect();
      STATE.observer = null;
    }

    const root = findFeedRoot();
    if (!root) return;

    STATE.observer = new MutationObserver((mutations) => {
      const addedNodes = mutations.some((mutation) => mutation.addedNodes && mutation.addedNodes.length > 0);
      if (addedNodes) {
        scheduleScan("mutation");
      }
    });

    STATE.observer.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  // 將刷新模式顯示為人類可讀的簡短說明。
  function formatRefreshModeLabel() {
    if (STATE.config.jitterEnabled) {
      return `浮動 ${STATE.config.minRefreshSec}-${STATE.config.maxRefreshSec} 秒`;
    }
    return `固定 ${STATE.config.fixedRefreshSec} 秒`;
  }

  // 將載入更多模式轉成面板可讀標籤。
  function formatLoadMoreModeLabel() {
    return STATE.config.loadMoreMode === "wheel" ? "模擬滑鼠滾輪" : "溫和捲動";
  }

  // 監聽 Facebook SPA 路由變化，切頁時重設狀態並重新安排掃描。
  function handleRouteChange() {
    if (STATE.lastUrl === location.href) return;

    STATE.lastUrl = location.href;
    STATE.lastRouteChangeAt = Date.now();
    STATE.lastRouteGroupId = getCurrentGroupId();
    STATE.latestPosts = [];
    STATE.latestScan = null;
    STATE.latestError = "";
    clearRefreshTimer();
    installObserver();
    scheduleScan("route-change");
    renderPanel();
  }

  // 腳本主入口：建立 UI、安裝 observer、安排掃描與刷新、啟動週期性維護。
  function start() {
    createPanel();
    installObserver();
    scheduleScan("startup");
    scheduleRefresh();
    STATE.routeTimer = window.setInterval(handleRouteChange, 1000);
    STATE.renderTimer = window.setInterval(() => {
      if (!document.getElementById("fb-group-refresh-panel")) {
        STATE.panelMounted = false;
        createPanel();
      }
      renderPanel();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
