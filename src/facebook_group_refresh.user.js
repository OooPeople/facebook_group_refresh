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
    panelPosition: "fb_group_refresh_panel_position",
  };
  const STORE_DEFINITIONS = Object.freeze({
    latestTopPosts: { key: STORAGE_KEYS.latestTopPosts, type: "object" },
    latestScanPosts: { key: STORAGE_KEYS.latestScanPosts, type: "object" },
    seenPosts: { key: STORAGE_KEYS.seenPosts, type: "object" },
    matchHistory: { key: STORAGE_KEYS.matchHistory, type: "json" },
    lastNotification: { key: STORAGE_KEYS.lastNotification, type: "json" },
    panelPosition: { key: STORAGE_KEYS.panelPosition, type: "json" },
  });
  const CONFIG_FIELD_DEFINITIONS = Object.freeze({
    includeKeywords: { key: STORAGE_KEYS.include, type: "string", normalize: true },
    excludeKeywords: { key: STORAGE_KEYS.exclude, type: "string", normalize: true },
    ntfyTopic: {
      key: STORAGE_KEYS.ntfyTopic,
      type: "string",
      normalize: true,
      removeWhenEmpty: true,
    },
    discordWebhook: {
      key: STORAGE_KEYS.discordWebhook,
      type: "string",
      normalize: true,
      removeWhenEmpty: true,
    },
    paused: { key: STORAGE_KEYS.paused, type: "boolean" },
    debugVisible: { key: STORAGE_KEYS.debugVisible, type: "boolean" },
    autoLoadMorePosts: { key: STORAGE_KEYS.autoLoadMorePosts, type: "boolean" },
  });
  const CONFIG_GROUP_DEFINITIONS = Object.freeze({
    keyword: ["includeKeywords", "excludeKeywords"],
    notification: ["ntfyTopic", "discordWebhook"],
    monitoring: ["paused"],
    ui: ["debugVisible"],
  });

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
    matchHistoryGlobalLimit: 10,
    enableGmNotification: true,
  };
  const INTERNAL_CONFIG = Object.freeze({
    loadMoreMode: "scroll",
  });
  const PANEL_LAYOUT = Object.freeze({
    defaultTop: 16,
    defaultRight: 16,
    defaultWidth: 380,
    viewportMargin: 12,
  });

  const SCAN_LIMITS = {
    minTargetPosts: 1,
    maxTargetPosts: 10,
    minCandidateTextLength: 8,
    candidateMultiplier: 6,
    seenPostMultiplier: 2,
    maxWindowMultiplier: 2,
    minNewPostsBeforeSeenStop: 1,
    consecutiveSeenStopCount: 3,
  };

  const FEED_SORT_LABELS = ["新貼文", "最相關", "最新動態"];
  const GROUP_NAVIGATION_LABELS = [
    "討論區",
    "精選",
    "關於",
    "成員",
    "媒體",
    "檔案",
    "活動",
    "影片",
    "reels",
    "discussion",
    "featured",
    "about",
    "members",
    "media",
    "files",
    "events",
  ];
  const SELECTORS = Object.freeze({
    feedRoots: [
      '[role="feed"]',
      'div[data-pagelet*="GroupsFeed"]',
      'div[data-pagelet*="FeedUnit"]',
    ],
    postTextExpanderCandidates: [
      'div[role="button"]',
      'span[role="button"]',
      'a[role="button"]',
      "button",
    ],
    postContainerCandidates: [
      '[role="feed"] [role="article"]',
      '[role="feed"] > div',
      'div[data-pagelet*="FeedUnit"]',
      'div[data-pagelet*="GroupsFeed"] [role="article"]',
      '[aria-posinset]',
    ],
    postPermalinkAnchors:
      'a[href*="/groups/"][href*="/posts/"], a[href*="/permalink/"], a[href*="multi_permalinks="], a[href*="story_fbid="]',
    postStoryMessage:
      'div[data-ad-comet-preview="message"], div[data-ad-preview="message"], [data-ad-rendering-role="story_message"]',
    postIdSourceNodes:
      'a[href], [data-ft], [data-store], [ajaxify], [id], [href], [aria-label], [aria-labelledby], [aria-describedby], [data-testid], [data-pagelet]',
    authorCandidates: [
      "h2 span",
      "h3 span",
      'a[role="link"] span[dir="auto"]',
      "strong span",
    ],
    primaryPostText: [
      'div[data-ad-comet-preview="message"]',
      'div[data-ad-preview="message"]',
      '[data-ad-rendering-role="story_message"]',
    ],
    fallbackPostText: [
      'div[dir="auto"]',
      'span[dir="auto"]',
    ],
  });
  const TEXT_PATTERNS = Object.freeze({
    postTextExpanderLabels: ["顯示更多", "查看更多", "See more"],
    noisyTextFragments: [
      "Facebook",
      "貼文的相片",
      "顯示更多",
      "查看更多",
      "See more",
      "Most relevant",
      "Like",
      "Comment",
      "Share",
    ],
  });
  const REGEX_PATTERNS = Object.freeze({
    postId: [
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
    ],
    cleanedTextNoise: [
      /\b[a-z0-9]{12,}\.com\b/gi,
      /\bsnproSet[a-z0-9]+\b/gi,
      /\bsotoeSrdpn[a-z0-9]+\b/gi,
    ],
    authorFollowSuffix: /\s*[·•]\s*追蹤\s*$/u,
    authorUiLabels: /^(Like|Comment|Share|Most relevant)$/i,
  });
  const ROUTE_SETTLE_MS = 3000;
  const FEATURE_STATUS = Object.freeze({
    permalinkExtraction: "disabled",
  });
  const NOTIFICATION_CHANNEL_DEFINITIONS = Object.freeze([
    { id: "gmDesktop", skippedStatus: "" },
    { id: "ntfy", skippedStatus: "ntfy_skipped" },
    { id: "discord", skippedStatus: "discord_skipped" },
  ]);

  const STATE = {
    config: loadConfig(),
    scanRuntime: {
      latestScan: null,
      latestPosts: [],
      latestError: "",
      isScanning: false,
      isLoadingMorePosts: false,
    },
    notificationRuntime: {
      latestNotification: getLatestNotificationStore(),
    },
    routeRuntime: {
      lastUrl: location.href,
      lastRouteChangeAt: 0,
      lastRouteGroupId: getCurrentGroupId(),
    },
    uiRuntime: {
      panelMounted: false,
      panelPosition: getPanelPositionStore(),
      panelDrag: buildIdlePanelDragState(),
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

  // ==========================================================================
  // State Mutation
  // ==========================================================================

  // 以分類明確的 patch helper 更新執行期狀態，避免不同區塊直接散寫 STATE。
  function setConfigPatch(patch) {
    Object.assign(STATE.config, patch || {});
  }

  function setScanRuntimePatch(patch) {
    Object.assign(STATE.scanRuntime, patch || {});
  }

  function setNotificationRuntimePatch(patch) {
    Object.assign(STATE.notificationRuntime, patch || {});
  }

  function setRouteRuntimePatch(patch) {
    Object.assign(STATE.routeRuntime, patch || {});
  }

  function setUiRuntimePatch(patch) {
    Object.assign(STATE.uiRuntime, patch || {});
  }

  function setSchedulerRuntimePatch(patch) {
    Object.assign(STATE.schedulerRuntime, patch || {});
  }

  function setSessionRuntimePatch(patch) {
    Object.assign(STATE.sessionRuntime, patch || {});
  }

  // 建立統一的 scan runtime reset patch，供 route-change 與其他收尾路徑共用。
  function buildResetScanRuntimeState() {
    return {
      latestPosts: [],
      latestScan: null,
      latestError: "",
    };
  }

  // 建立掃描失敗時的 scan runtime patch。
  function buildFailedScanRuntimeState(error) {
    return {
      latestError: String(error && error.message ? error.message : error),
    };
  }

  // 套用 scan runtime patch，讓 orchestration 層只處理意圖，不散寫欄位。
  function applyScanRuntimeState(runtimeState) {
    setScanRuntimePatch(runtimeState || {});
  }

  // 建立通知完成後的 latestNotification 狀態。
  function buildCompletedNotificationState(latestNotification, statusParts) {
    if (!latestNotification || typeof latestNotification !== "object") {
      return null;
    }

    return {
      ...latestNotification,
      status: statusParts.length ? statusParts.join(", ") : "no_channel_sent",
    };
  }

  // 將 latestNotification 狀態轉成 panel/debug 顯示文字。
  function getLatestNotificationStatusLabel(latestNotification) {
    return latestNotification?.status || "(本次無)";
  }

  // 集中整理 panel 需要的 runtime snapshot，避免 view builder 散讀 STATE。
  function buildPanelRuntimeSnapshot() {
    return {
      latestScan: STATE.scanRuntime.latestScan,
      latestPosts: STATE.scanRuntime.latestPosts,
      latestError: STATE.scanRuntime.latestError,
      latestNotification: STATE.notificationRuntime.latestNotification,
    };
  }

  // 取得目前主面板 DOM；集中 panel element 查找。
  function getPanelElement() {
    const panel = document.getElementById("fb-group-refresh-panel");
    return panel instanceof HTMLElement ? panel : null;
  }

  // 同步 panel mounted runtime flag。
  function setPanelMountedState(panelMounted) {
    setUiRuntimePatch({ panelMounted: Boolean(panelMounted) });
  }

  // 建立 panel 拖曳 runtime 的預設狀態。
  function buildIdlePanelDragState() {
    return {
      active: false,
      pointerId: null,
      startPointerX: 0,
      startPointerY: 0,
      startTop: 0,
      startLeft: 0,
    };
  }

  // 同步 panel 位置到 ui runtime，必要時一併持久化。
  function setPanelPositionState(panelPosition, options = {}) {
    const normalized = normalizePanelPosition(panelPosition);
    setUiRuntimePatch({ panelPosition: normalized });
    if (options.persist) {
      setPanelPositionStore(normalized);
    }
    return normalized;
  }

  // 同步 panel 拖曳 runtime，避免 DOM handler 直接散寫 ui state。
  function setPanelDragState(panelDrag) {
    setUiRuntimePatch({
      panelDrag: panelDrag && typeof panelDrag === "object"
        ? { ...buildIdlePanelDragState(), ...panelDrag }
        : buildIdlePanelDragState(),
    });
  }

  // 判斷 patch 是否真的帶有指定欄位，避免把 undefined 視為有意更新。
  function hasOwnPatchValue(patch, key) {
    return Boolean(patch) && Object.prototype.hasOwnProperty.call(patch, key);
  }

  // ==========================================================================
  // Storage / Config
  // ==========================================================================

  // 設定載入與儲存包裝，統一處理 Tampermonkey storage / legacy localStorage。
  function getConfigFieldDefinition(name) {
    return CONFIG_FIELD_DEFINITIONS[name] || null;
  }

  // 讀取 config group 定義，讓對外設定與 storage key mapping 集中管理。
  function getConfigGroupFields(groupName) {
    return CONFIG_GROUP_DEFINITIONS[groupName] || [];
  }

  // 依欄位型別從持久化 storage 讀回單一 config 值。
  function loadPersistedConfigField(name, fallback = DEFAULT_CONFIG[name]) {
    const definition = getConfigFieldDefinition(name);
    if (!definition) return fallback;

    if (definition.type === "boolean") {
      return loadBoolean(definition.key, fallback);
    }

    const value = loadString(definition.key, fallback);
    return definition.normalize ? normalizeText(value) : value;
  }

  // 讀回一組 config 欄位，避免 loadConfig() 與 UI call site 直接碰 storage key。
  function loadPersistedConfigGroup(groupName, baseConfig = DEFAULT_CONFIG) {
    const patch = {};

    for (const fieldName of getConfigGroupFields(groupName)) {
      patch[fieldName] = loadPersistedConfigField(fieldName, baseConfig[fieldName]);
    }

    return patch;
  }

  // 依欄位型別將單一 config 值寫回 storage，必要時順手移除空值欄位。
  function persistConfigFieldValue(name, value) {
    const definition = getConfigFieldDefinition(name);
    if (!definition) return value;

    if (definition.type === "boolean") {
      const normalized = Boolean(value);
      saveString(definition.key, String(normalized));
      return normalized;
    }

    const normalized = definition.normalize ? normalizeText(value) : String(value || "");
    if (definition.removeWhenEmpty && !normalized) {
      removeStorageKey(definition.key);
      return normalized;
    }

    saveString(definition.key, normalized);
    return normalized;
  }

  // 批次寫回同一組 config 欄位，讓 persistence path 與 UI handler 解耦。
  function persistConfigGroup(groupName, config = STATE.config) {
    for (const fieldName of getConfigGroupFields(groupName)) {
      persistConfigFieldValue(fieldName, config[fieldName]);
    }
  }

  // 將 refresh 相關持久化欄位轉成 config override，集中舊格式相容邏輯。
  function loadRefreshConfigOverrides() {
    const refreshRange = loadJson(STORAGE_KEYS.refreshRange, null);
    return {
      minRefreshSec: refreshRange?.min ?? DEFAULT_CONFIG.minRefreshSec,
      maxRefreshSec: refreshRange?.max ?? DEFAULT_CONFIG.maxRefreshSec,
      jitterEnabled: refreshRange?.jitterEnabled ?? DEFAULT_CONFIG.jitterEnabled,
      fixedRefreshSec: refreshRange?.fixedSec ?? DEFAULT_CONFIG.fixedRefreshSec,
      maxPostsPerScan: clampTargetPostCount(refreshRange?.maxPostsPerScan ?? DEFAULT_CONFIG.maxPostsPerScan),
      autoLoadMorePosts: loadPersistedConfigField(
        "autoLoadMorePosts",
        refreshRange?.autoLoadMorePosts ?? DEFAULT_CONFIG.autoLoadMorePosts
      ),
    };
  }

  // 組出 refresh 設定的持久化 payload，避免讀寫欄位各自漂移。
  function buildRefreshSettingsPayloadFromConfig(config) {
    return {
      min: config.minRefreshSec,
      max: config.maxRefreshSec,
      jitterEnabled: config.jitterEnabled,
      fixedSec: config.fixedRefreshSec,
      maxPostsPerScan: clampTargetPostCount(config.maxPostsPerScan),
      autoLoadMorePosts: config.autoLoadMorePosts,
    };
  }

  // 從持久化儲存讀回目前設定，並將舊格式 refreshRange 合併回執行設定。
  function loadConfig() {
    return {
      ...DEFAULT_CONFIG,
      ...loadPersistedConfigGroup("keyword"),
      ...loadPersistedConfigGroup("notification"),
      ...loadPersistedConfigGroup("monitoring"),
      ...loadPersistedConfigGroup("ui"),
      ...loadRefreshConfigOverrides(),
    };
  }

  // 讀取並正規化已保存的 ntfy topic。
  function getPersistedNtfyTopic() {
    return loadPersistedConfigField("ntfyTopic", DEFAULT_CONFIG.ntfyTopic);
  }

  // 保存 ntfy topic；空字串時直接移除設定。
  function persistNtfyTopicValue(value) {
    return persistConfigFieldValue("ntfyTopic", value);
  }

  // 讀取並正規化已保存的 Discord Webhook URL。
  function getPersistedDiscordWebhook() {
    return loadPersistedConfigField("discordWebhook", DEFAULT_CONFIG.discordWebhook);
  }

  // 保存 Discord Webhook URL；空字串時直接移除設定。
  function persistDiscordWebhookValue(value) {
    return persistConfigFieldValue("discordWebhook", value);
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

  // 讀取命名 store 定義，避免各區塊散落硬編碼 storage key。
  function getStoreDefinition(name) {
    return STORE_DEFINITIONS[name] || null;
  }

  // 讀取 object 型 store；缺值或型別不符時回退為空物件。
  function loadNamedObjectStore(name) {
    const definition = getStoreDefinition(name);
    if (!definition) return {};
    return loadObjectStore(definition.key);
  }

  // 寫回 object 型 store；型別不符時退回空物件。
  function saveNamedObjectStore(name, store) {
    const definition = getStoreDefinition(name);
    if (!definition) return;
    saveJson(
      definition.key,
      store && typeof store === "object" && !Array.isArray(store) ? store : {}
    );
  }

  // 讀取一般 JSON store。
  function loadNamedJsonStore(name, fallback) {
    const definition = getStoreDefinition(name);
    if (!definition) return fallback;
    return loadJson(definition.key, fallback);
  }

  // 寫回一般 JSON store。
  function saveNamedJsonStore(name, value) {
    const definition = getStoreDefinition(name);
    if (!definition) return;
    saveJson(definition.key, value);
  }

  // 將 panel 位置正規化成可持久化的 top/left 座標。
  function normalizePanelPosition(value) {
    const top = Math.round(Number(value?.top));
    const left = Math.round(Number(value?.left));
    if (!Number.isFinite(top) || !Number.isFinite(left)) {
      return null;
    }

    return {
      top,
      left,
    };
  }

  // 讀取已持久化的 panel 位置。
  function getPanelPositionStore() {
    return normalizePanelPosition(loadNamedJsonStore("panelPosition", null));
  }

  // 寫回已持久化的 panel 位置；空值時清掉 storage。
  function setPanelPositionStore(position) {
    const normalized = normalizePanelPosition(position);
    if (!normalized) {
      removeStorageKey(STORAGE_KEYS.panelPosition);
      return;
    }

    saveNamedJsonStore("panelPosition", normalized);
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

  // 讀取預期為 plain object 的 JSON store；格式不符時回退為空物件。
  function loadObjectStore(key) {
    const store = loadJson(key, {});
    return store && typeof store === "object" && !Array.isArray(store) ? store : {};
  }

  // ==========================================================================
  // Config Use Cases
  // ==========================================================================

  // 這些 helper 只處理正式對外設定；internal-only 行為不再混進 STATE.config。
  function getLoadMoreMode() {
    return INTERNAL_CONFIG.loadMoreMode;
  }

  // 將 include / exclude 關鍵字草稿整理成標準 config patch。
  function buildKeywordConfigPatch(patch = {}) {
    const nextPatch = {};

    if (hasOwnPatchValue(patch, "includeKeywords")) {
      nextPatch.includeKeywords = normalizeText(patch.includeKeywords);
    }
    if (hasOwnPatchValue(patch, "excludeKeywords")) {
      nextPatch.excludeKeywords = normalizeText(patch.excludeKeywords);
    }

    return nextPatch;
  }

  // 將 refresh 相關設定草稿整理成標準 config patch。
  function buildRefreshConfigPatch(patch = {}, baseConfig = STATE.config) {
    const nextPatch = {};

    if (hasOwnPatchValue(patch, "jitterEnabled")) {
      nextPatch.jitterEnabled = Boolean(patch.jitterEnabled);
    }
    if (hasOwnPatchValue(patch, "autoLoadMorePosts")) {
      nextPatch.autoLoadMorePosts = Boolean(patch.autoLoadMorePosts);
    }
    if (hasOwnPatchValue(patch, "minRefreshSec")) {
      nextPatch.minRefreshSec = Math.max(
        5,
        Math.floor(Number(patch.minRefreshSec) || baseConfig.minRefreshSec)
      );
    }
    if (hasOwnPatchValue(patch, "maxRefreshSec")) {
      nextPatch.maxRefreshSec = Math.max(
        5,
        Math.floor(Number(patch.maxRefreshSec) || baseConfig.maxRefreshSec)
      );
    }
    if (hasOwnPatchValue(patch, "fixedRefreshSec")) {
      nextPatch.fixedRefreshSec = Math.max(
        5,
        Math.floor(Number(patch.fixedRefreshSec) || baseConfig.fixedRefreshSec)
      );
    }
    if (hasOwnPatchValue(patch, "maxPostsPerScan")) {
      nextPatch.maxPostsPerScan = clampTargetPostCount(patch.maxPostsPerScan);
    }

    return nextPatch;
  }

  // 將通知端點草稿整理成標準 config patch。
  function buildNotificationConfigPatch(patch = {}) {
    const nextPatch = {};

    if (hasOwnPatchValue(patch, "ntfyTopic")) {
      nextPatch.ntfyTopic = normalizeText(patch.ntfyTopic);
    }
    if (hasOwnPatchValue(patch, "discordWebhook")) {
      nextPatch.discordWebhook = normalizeText(patch.discordWebhook);
    }

    return nextPatch;
  }

  // 將 monitoring 旗標整理成標準 config patch。
  function buildMonitoringConfigPatch(patch = {}) {
    const nextPatch = {};

    if (hasOwnPatchValue(patch, "paused")) {
      nextPatch.paused = Boolean(patch.paused);
    }

    return nextPatch;
  }

  // 將 UI 旗標整理成標準 config patch。
  function buildUiConfigPatch(patch = {}) {
    const nextPatch = {};

    if (hasOwnPatchValue(patch, "debugVisible")) {
      nextPatch.debugVisible = Boolean(patch.debugVisible);
    }

    return nextPatch;
  }

  // 寫回 include / exclude 正式設定。
  function persistKeywordConfig(config = STATE.config) {
    persistConfigGroup("keyword", config);
  }

  // 寫回 refresh 相關正式設定。
  function persistRefreshConfig(config = STATE.config) {
    saveJson(STORAGE_KEYS.refreshRange, buildRefreshSettingsPayloadFromConfig(config));
    persistConfigFieldValue("autoLoadMorePosts", config.autoLoadMorePosts);
  }

  // 寫回通知端點設定。
  function persistNotificationConfig(config = STATE.config) {
    persistConfigGroup("notification", config);
  }

  // 寫回 monitoring 設定。
  function persistMonitoringConfig(config = STATE.config) {
    persistConfigGroup("monitoring", config);
  }

  // 寫回 UI 設定。
  function persistUiConfig(config = STATE.config) {
    persistConfigGroup("ui", config);
  }

  // 更新 include / exclude 正式設定，必要時同步持久化。
  function applyKeywordConfigPatch(patch, options = {}) {
    const normalizedPatch = buildKeywordConfigPatch(patch);
    if (!Object.keys(normalizedPatch).length) return normalizedPatch;

    setConfigPatch(normalizedPatch);
    if (options.persist) {
      persistKeywordConfig();
    }

    return normalizedPatch;
  }

  // 更新 refresh 正式設定，必要時同步持久化。
  function applyRefreshConfigPatch(patch, options = {}) {
    const normalizedPatch = buildRefreshConfigPatch(patch);
    if (!Object.keys(normalizedPatch).length) return normalizedPatch;

    setConfigPatch(normalizedPatch);
    if (options.persist) {
      persistRefreshConfig();
    }

    return normalizedPatch;
  }

  // 更新通知端點設定，必要時同步持久化。
  function applyNotificationConfigPatch(patch, options = {}) {
    const normalizedPatch = buildNotificationConfigPatch(patch);
    if (!Object.keys(normalizedPatch).length) return normalizedPatch;

    setConfigPatch(normalizedPatch);
    if (options.persist) {
      persistNotificationConfig();
    }

    return normalizedPatch;
  }

  // 更新 monitoring 設定，必要時同步持久化。
  function applyMonitoringConfigPatch(patch, options = {}) {
    const normalizedPatch = buildMonitoringConfigPatch(patch);
    if (!Object.keys(normalizedPatch).length) return normalizedPatch;

    setConfigPatch(normalizedPatch);
    if (options.persist) {
      persistMonitoringConfig();
    }

    return normalizedPatch;
  }

  // 更新 UI 設定，必要時同步持久化。
  function applyUiConfigPatch(patch, options = {}) {
    const normalizedPatch = buildUiConfigPatch(patch);
    if (!Object.keys(normalizedPatch).length) return normalizedPatch;

    setConfigPatch(normalizedPatch);
    if (options.persist) {
      persistUiConfig();
    }

    return normalizedPatch;
  }

  // ==========================================================================
  // Text / Common Utils
  // ==========================================================================

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

  // 將長文字裁切成固定長度，避免通知或 debug 面板過長。
  function truncate(value, maxLen) {
    const text = String(value || "");
    return text.length <= maxLen ? text : `${text.slice(0, maxLen - 3)}...`;
  }

  // 將數值夾在指定上下界之間。
  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // 計算 panel 在目前 viewport 下可用的定位邊界。
  function getPanelPositionBounds(metrics = {}) {
    const width = Math.max(0, Math.round(Number(metrics.width) || PANEL_LAYOUT.defaultWidth));
    const height = Math.max(0, Math.round(Number(metrics.height) || 0));
    const viewportWidth = Math.max(
      width + PANEL_LAYOUT.viewportMargin * 2,
      Math.round(Number(metrics.viewportWidth) || window.innerWidth || PANEL_LAYOUT.defaultWidth)
    );
    const viewportHeight = Math.max(
      height + PANEL_LAYOUT.viewportMargin * 2,
      Math.round(Number(metrics.viewportHeight) || window.innerHeight || 0)
    );

    return {
      width,
      height,
      viewportWidth,
      viewportHeight,
      minLeft: PANEL_LAYOUT.viewportMargin,
      minTop: PANEL_LAYOUT.viewportMargin,
      maxLeft: Math.max(
        PANEL_LAYOUT.viewportMargin,
        viewportWidth - width - PANEL_LAYOUT.viewportMargin
      ),
      maxTop: Math.max(
        PANEL_LAYOUT.viewportMargin,
        viewportHeight - height - PANEL_LAYOUT.viewportMargin
      ),
    };
  }

  // 依目前 viewport 邊界夾住 panel 定位，避免被拖出畫面外。
  function clampPanelPosition(position, metrics = {}) {
    const normalized = normalizePanelPosition(position);
    if (!normalized) return null;

    const bounds = getPanelPositionBounds(metrics);
    return {
      top: clampNumber(normalized.top, bounds.minTop, bounds.maxTop),
      left: clampNumber(normalized.left, bounds.minLeft, bounds.maxLeft),
    };
  }

  // 用拖曳起點與目前 pointer 位移，計算下一個 panel 定位。
  function buildDraggedPanelPosition(dragState, pointer, metrics = {}) {
    if (!dragState?.active) return null;

    return clampPanelPosition(
      {
        top: dragState.startTop + (Number(pointer?.clientY) - dragState.startPointerY),
        left: dragState.startLeft + (Number(pointer?.clientX) - dragState.startPointerX),
      },
      metrics
    );
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

  // ==========================================================================
  // Matcher / Rules
  // ==========================================================================

  // 將單一關鍵字規則整理成標準格式。
  function buildKeywordRule(rule) {
    const normalizedRule = normalizeText(rule);
    if (!normalizedRule) return null;

    const terms = normalizedRule
      .split(" ")
      .map((part) => normalizeForMatch(part))
      .filter(Boolean);
    if (!terms.length) return null;

    return {
      raw: normalizedRule,
      terms,
    };
  }

  // 將 `a b;c` 這類輸入拆成規則陣列；分號代表 OR、空白代表 AND。
  function parseKeywordInput(rawInput) {
    return String(rawInput || "")
      .split(";")
      .map((rule) => buildKeywordRule(rule))
      .filter(Boolean);
  }

  // 檢查單一關鍵字規則是否命中指定文字。
  function matchesKeywordRule(rule, normalizedText) {
    return Boolean(rule && rule.terms.every((term) => normalizedText.includes(term)));
  }

  // 逐條規則比對，任一規則成立就視為命中。
  function matchRules(rules, normalizedText) {
    if (!rules.length) {
      return { matched: true, rule: "" };
    }

    for (const rule of rules) {
      if (matchesKeywordRule(rule, normalizedText)) {
        return { matched: true, rule: rule.raw };
      }
    }

    return { matched: false, rule: "" };
  }

  // ==========================================================================
  // Page Context / Scheduling
  // ==========================================================================

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
    const headingName = getCurrentGroupNameFromHeading();
    if (headingName) {
      return headingName;
    }

    const candidates = [];
    const anchors = document.querySelectorAll(`a[href*="/groups/${groupId}"]`);

    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLAnchorElement)) continue;

      const text = normalizeText(anchor.innerText || anchor.textContent || "");
      if (!text || text.length < 2 || text.length > 120) continue;
      if (isLikelyGroupNavigationAnchor(anchor, text)) continue;

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

  // 判斷文字是否比較像社團頁籤或導覽按鈕，而不是社團名稱。
  function isLikelyGroupNavigationLabel(value) {
    const normalized = normalizeForMatch(value);
    return Boolean(normalized && GROUP_NAVIGATION_LABELS.includes(normalized));
  }

  // 排除社團導覽 tab / 固定頁籤，避免誤把「討論區」等文字當成社團名稱。
  function isLikelyGroupNavigationAnchor(anchor, text) {
    if (!(anchor instanceof HTMLAnchorElement)) return false;
    if (anchor.getAttribute("role") === "tab") return true;
    if (anchor.getAttribute("aria-selected") === "true") return true;

    const anchorId = normalizeForMatch(anchor.id || "");
    if (anchorId === "posts") return true;

    return isLikelyGroupNavigationLabel(text);
  }

  // 優先從頁面主要 heading 區找社團名稱，降低誤抓作者名稱或導覽 label 的機率。
  function getCurrentGroupNameFromHeading() {
    const selectors = [
      '[role="main"] h1 span[dir="auto"]',
      '[role="main"] h1',
      "h1 span[dir='auto']",
      "h1",
    ];
    const candidates = [];

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (!isVisibleElement(node)) continue;

        const text = normalizeText(node.innerText || node.textContent || "");
        if (!text || text.length < 2 || text.length > 120) continue;
        if (isLikelyGroupNavigationLabel(text)) continue;

        candidates.push(text);
      }

      if (candidates.length) {
        break;
      }
    }

    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || "";
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

  // 根據固定秒數或 jitter 範圍，算出下一次 refresh 秒數。
  function getRefreshSeconds() {
    if (!STATE.config.jitterEnabled) {
      return Math.max(5, Math.floor(Number(STATE.config.fixedRefreshSec) || DEFAULT_CONFIG.fixedRefreshSec));
    }

    const min = Math.min(STATE.config.minRefreshSec, STATE.config.maxRefreshSec);
    const max = Math.max(STATE.config.minRefreshSec, STATE.config.maxRefreshSec);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // 將 refresh timer 與 deadline 一起寫入 scheduler runtime。
  function setRefreshScheduleState(refreshTimer, refreshDeadline) {
    setSchedulerRuntimePatch({
      refreshTimer,
      refreshDeadline,
    });
  }

  // 將 scan debounce timer 寫入 scheduler runtime。
  function setScanScheduleState(scanTimer) {
    setSchedulerRuntimePatch({ scanTimer });
  }

  // 安裝目前使用的 feed observer handle。
  function setFeedObserverState(observer) {
    setSchedulerRuntimePatch({ observer });
  }

  // 寫入 route / render maintenance loop handles。
  function setMaintenanceLoopState(routeTimer, renderTimer) {
    setSchedulerRuntimePatch({
      routeTimer,
      renderTimer,
    });
  }

  // 清掉目前使用的 feed observer handle。
  function clearFeedObserverState() {
    setFeedObserverState(null);
  }

  // 斷開目前的 feed observer，集中 observer 清理邏輯。
  function disconnectFeedObserver() {
    if (!STATE.schedulerRuntime.observer) return;

    STATE.schedulerRuntime.observer.disconnect();
    clearFeedObserverState();
  }

  // 安排下一次頁面刷新；暫停或不在群組頁時不啟動。
  function scheduleRefresh() {
    clearRefreshTimer();
    if (STATE.config.paused || !isSupportedGroupPage()) return;

    const delaySec = getRefreshSeconds();
    const refreshDeadline = Date.now() + delaySec * 1000;
    const refreshTimer = window.setTimeout(() => {
      location.reload();
    }, delaySec * 1000);
    setRefreshScheduleState(refreshTimer, refreshDeadline);
  }

  // 清掉已排程的刷新計時器與截止時間。
  function clearRefreshTimer() {
    if (STATE.schedulerRuntime.refreshTimer) {
      clearTimeout(STATE.schedulerRuntime.refreshTimer);
    }
    setRefreshScheduleState(null, null);
  }

  // 清掉待執行的掃描計時器，避免多個 debounce timer 重疊。
  function clearScanTimer() {
    if (!STATE.schedulerRuntime.scanTimer) return;

    clearTimeout(STATE.schedulerRuntime.scanTimer);
    setScanScheduleState(null);
  }

  // 清掉目前監控流程會用到的排程 timer。
  function clearMonitoringScheduleTimers() {
    clearRefreshTimer();
    clearScanTimer();
  }

  // 清掉 route / render maintenance loops，避免重複安裝 interval。
  function clearMaintenanceLoops() {
    if (STATE.schedulerRuntime.routeTimer) {
      clearInterval(STATE.schedulerRuntime.routeTimer);
    }
    if (STATE.schedulerRuntime.renderTimer) {
      clearInterval(STATE.schedulerRuntime.renderTimer);
    }

    setMaintenanceLoopState(null, null);
  }

  // 透過單一入口觸發主面板重繪，讓生命週期與 UI 收尾點更集中。
  function requestPanelRender() {
    renderPanel();
  }

  // 重新安排 refresh 並立即同步面板倒數顯示。
  function rescheduleRefreshAndRender() {
    scheduleRefresh();
    requestPanelRender();
  }

  // 以 debounce 方式安排掃描，並在 route 剛切換時多等一段穩定時間。
  function scheduleScan(reason) {
    if (STATE.config.paused || STATE.scanRuntime.isLoadingMorePosts || STATE.scanRuntime.isScanning) return;
    if (!isSupportedGroupPage()) {
      requestPanelRender();
      return;
    }

    const routeSettleRemainingMs = getRecentRouteSettleRemainingMs();
    const baseDelayMs = reason === "manual-start" ? 0 : STATE.config.scanDebounceMs;
    const delayMs = Math.max(baseDelayMs, routeSettleRemainingMs);

    clearScanTimer();
    setScanScheduleState(window.setTimeout(() => {
      setScanScheduleState(null);
      runScan(reason);
    }, delayMs));
  }

  // Facebook SPA route 剛變更時先等待 DOM 穩定，降低抓到半套畫面的機率。
  function getRecentRouteSettleRemainingMs() {
    if (!STATE.routeRuntime.lastRouteChangeAt) return 0;
    if (STATE.routeRuntime.lastRouteGroupId !== getCurrentGroupId()) return 0;

    const elapsedMs = Date.now() - STATE.routeRuntime.lastRouteChangeAt;
    return Math.max(0, ROUTE_SETTLE_MS - elapsedMs);
  }

  // 重新安裝 observer 後立刻安排下一輪掃描，集中 route / startup 的共同流程。
  function reinstallObserverAndScheduleScan(reason) {
    installObserver();
    scheduleScan(reason);
  }

  // ==========================================================================
  // Extractor / DOM Collection
  // ==========================================================================

  // 掃描候選區塊的 DOM 探勘與展開邏輯。
  // 嘗試找出目前群組動態牆的主要根節點，找不到時退回 document.body。
  function findFeedRoot() {
    for (const selector of SELECTORS.feedRoots) {
      const root = document.querySelector(selector);
      if (root) return root;
    }

    return document.body;
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

  // 依 selector 順序攤平符合的 HTMLElement，讓多組 selector 掃描可共用同一條走訪手勢。
  function getSelectorElementsByOrder(scope, selectors) {
    if (!scope || typeof scope.querySelectorAll !== "function") return [];

    const elements = [];
    for (const selector of selectors) {
      const nodes = scope.querySelectorAll(selector);
      for (const node of nodes) {
        if (node instanceof HTMLElement) {
          elements.push(node);
        }
      }
    }

    return elements;
  }

  // 依畫面垂直位置排序節點，供 expander / timestamp 類抽取共用。
  function sortElementsByViewportTop(elements) {
    return [...elements].sort((a, b) => {
      return Math.round(a.getBoundingClientRect().top) - Math.round(b.getBoundingClientRect().top);
    });
  }

  // 依 selector 順序走訪節點，回傳第一個有效結果。
  function findFirstSelectorResult(container, selectors, resolver) {
    if (!(container instanceof HTMLElement)) return undefined;

    for (const node of getSelectorElementsByOrder(container, selectors)) {
      const result = resolver(node);
      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  }

  // 依 selector 順序收集唯一文字片段，供 extractors 共用。
  function collectUniqueTextSnippets(container, selectors, options = {}) {
    if (!(container instanceof HTMLElement)) return [];

    const {
      normalize = normalizeText,
      minLength = 0,
      maxItems = Number.POSITIVE_INFINITY,
      shouldInclude = null,
    } = options;
    const snippets = [];
    const seen = new Set();

    for (const node of getSelectorElementsByOrder(container, selectors)) {
      const text = normalize(node.innerText || "");
      if (!text || text.length < minLength) continue;
      if (typeof shouldInclude === "function" && !shouldInclude(text, node)) continue;
      if (seen.has(text)) continue;

      seen.add(text);
      snippets.push(text);

      if (snippets.length >= maxItems) break;
    }

    return snippets;
  }

  // 依候選字串與 regex pattern 順序找第一個命中片段。
  function extractFirstPatternMatch(candidates, patterns) {
    for (const candidate of candidates) {
      const text = String(candidate || "");
      if (!text) continue;

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          return match[1];
        }
      }
    }

    return "";
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

    const isExpandLabel = TEXT_PATTERNS.postTextExpanderLabels.includes(text);
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

    const results = [];
    const seen = new Set();

    for (const node of getSelectorElementsByOrder(container, SELECTORS.postTextExpanderCandidates)) {
      if (!isPostTextExpander(node, container)) continue;
      if (seen.has(node)) continue;
      seen.add(node);
      results.push(node);
    }

    return sortElementsByViewportTop(results);
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
      element.querySelector(SELECTORS.postPermalinkAnchors)
    );
    const hasProfileName = element.querySelector('[data-ad-rendering-role="profile_name"]') instanceof HTMLElement;
    const hasStoryMessage = element.querySelector(SELECTORS.postStoryMessage) instanceof HTMLElement;

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
    const results = [];
    const seen = new Set();

    for (const selector of SELECTORS.postContainerCandidates) {
      for (const node of getSelectorElementsByOrder(document, [selector])) {
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

  // Experimental / disabled: permalink 抽取目前停用。
  // 保留函式介面與 postId 萃取邏輯，避免之後恢復時需要改動其他主流程。
  function extractPermalinkDetails() {
    return {
      permalink: "",
      source: FEATURE_STATUS.permalinkExtraction,
    };
  }

  // 從網址、data-ft、innerHTML 等雜訊字串裡盡量抽出穩定的 post ID。
  function extractPostIdFromValue(value) {
    const text = String(value || "");
    if (!text) return "";

    return extractFirstPatternMatch([text], REGEX_PATTERNS.postId);
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

    const nodes = container.querySelectorAll(SELECTORS.postIdSourceNodes);
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

  // ==========================================================================
  // Post Parsing / Notification Formatting
  // ==========================================================================

  // 作者、內文與內容品質評分抽取。
  // 以多組常見 selector 抽取作者名稱，並排除操作按鈕等假陽性文字。
  function extractAuthor(container) {
    return findFirstSelectorResult(container, SELECTORS.authorCandidates, (node) => {
      const text = normalizeText(node.innerText).replace(REGEX_PATTERNS.authorFollowSuffix, "");
      if (!text) return undefined;
      if (text.length > 80) return undefined;
      if (REGEX_PATTERNS.authorUiLabels.test(text)) return undefined;
      return text;
    }) || "";
  }

  // 優先從 Facebook 較穩定的貼文訊息區塊抽正文，失敗才退回通用 dir="auto" 掃描。
  function extractPostTextDetails(container) {
    const primarySnippets = collectUniqueTextSnippets(container, SELECTORS.primaryPostText, {
      normalize: cleanExtractedText,
      minLength: 2,
      maxItems: 8,
    });

    if (primarySnippets.length) {
      return {
        text: cleanExtractedText(primarySnippets.join(" ")),
        source: "primary",
      };
    }

    const fallbackSnippets = collectUniqueTextSnippets(container, SELECTORS.fallbackPostText, {
      normalize: cleanExtractedText,
      minLength: 6,
      maxItems: 8,
    });

    if (fallbackSnippets.length) {
      return {
        text: cleanExtractedText(fallbackSnippets.join(" ")),
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

    for (const fragment of TEXT_PATTERNS.noisyTextFragments) {
      text = text.replaceAll(fragment, " ");
    }

    for (const pattern of REGEX_PATTERNS.cleanedTextNoise) {
      text = text.replace(pattern, " ");
    }

    text = text.replace(/\s+/g, " ").trim();

    return text;
  }

  // 將文字壓成較短且穩定的 signature，供 fallback 去重使用。
  function buildStableTextSignature(value) {
    const compact = normalizeForKey(value);
    if (!compact) return "";
    return compact.slice(0, 120);
  }

  // 將貼文去重常用的文字片段整理成固定結構。
  function buildPostKeyFragments(post) {
    return {
      compactText: buildStableTextSignature(post.text || post.normalizedText),
      compactAuthor: normalizeForKey(post.author),
      compactTime: normalizeForKey(post.timestampText),
    };
  }

  // 依作者 / 時間 / 文字片段組出複合型去重鍵。
  function buildCompositePostKey({ compactAuthor, compactTime, compactText }) {
    if (compactAuthor && compactTime && compactText) {
      return `author:${compactAuthor}||time:${compactTime}||text:${compactText}`;
    }

    if (compactAuthor && compactText) {
      return `author:${compactAuthor}||text:${compactText}`;
    }

    if (compactText) {
      return `text:${compactText}`;
    }

    return "";
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

  // 建立桌面通知用的單行片段。
  function buildCompactNotificationSegments(fields) {
    return [
      fields.groupName,
      fields.author,
      `match: ${fields.includeRule}`,
      truncate(fields.text, 120),
    ].filter(Boolean);
  }

  // 建立較精簡的單行通知文字，適合桌面通知。
  function buildCompactNotificationBody(post) {
    const fields = getNotificationFields(post);
    return truncate(buildCompactNotificationSegments(fields).join(" | "), 250);
  }

  // 建立遠端通知用的多行文字列。
  function buildRemoteNotificationLines(fields) {
    const lines = [
      `社團: ${fields.groupName}`,
      `作者: ${fields.author}`,
      `關鍵字: ${fields.includeRule}`,
      `內容: ${fields.text}`,
    ];

    if (fields.permalink) {
      lines.push(`連結: ${fields.permalink}`);
    }

    return lines;
  }

  // 建立多行通知文字，格式接近「查看紀錄」的顯示方式。
  function buildRemoteNotificationBody(post) {
    const fields = getNotificationFields(post);
    return buildRemoteNotificationLines(fields).join("\n");
  }

  // ==========================================================================
  // Persistence / Dedupe / History
  // ==========================================================================

  // 讀取指定 group bucket；型別不符時回退為預設值。
  function getGroupStoreValue(store, groupId, fallback, isValid) {
    if (!groupId) return fallback;
    const value = store?.[groupId];
    return isValid(value) ? value : fallback;
  }

  // 讀取命名 object store 中的指定 group bucket。
  function getNamedGroupObjectValue(storeName, groupId, fallback, isValid) {
    return getGroupStoreValue(loadNamedObjectStore(storeName), groupId, fallback, isValid);
  }

  // 將單一群組資料寫回命名 object store。
  function setNamedGroupObjectValue(storeName, groupId, value) {
    if (!groupId) return;
    const store = loadNamedObjectStore(storeName);
    store[groupId] = value;
    saveNamedObjectStore(storeName, store);
  }

  // 將最新最上方貼文整理成可持久化的快照格式。
  function buildLatestTopPostSnapshot(post) {
    const postKey = getPostKey(post);
    if (!postKey) return null;

    return {
      postKey,
      author: post.author || "",
      text: truncate(post.text || "", 160),
      updatedAt: new Date().toISOString(),
    };
  }

  // 將持久化的貼文清單正規化為物件陣列。
  function normalizeStoredPostList(posts) {
    return Array.isArray(posts)
      ? posts.filter((post) => post && typeof post === "object")
      : [];
  }

  // 讀取指定社團最近一次最上方貼文快照。
  function getLatestTopPostForGroup(groupId) {
    return getNamedGroupObjectValue(
      "latestTopPosts",
      groupId,
      null,
      (value) => value && typeof value === "object"
    );
  }

  // 保存指定社團最近一次最上方貼文快照。
  function setLatestTopPostForGroup(groupId, post) {
    if (!groupId || !post) return;

    const snapshot = buildLatestTopPostSnapshot(post);
    if (!snapshot) return;

    setNamedGroupObjectValue("latestTopPosts", groupId, snapshot);
  }

  // 讀取指定社團最近一次完整掃描後的貼文清單。
  function getLatestScanPostsForGroup(groupId) {
    return getNamedGroupObjectValue(
      "latestScanPosts",
      groupId,
      [],
      Array.isArray
    );
  }

  // 保存指定社團最近一次完整掃描後的貼文清單。
  function setLatestScanPostsForGroup(groupId, posts) {
    setNamedGroupObjectValue("latestScanPosts", groupId, normalizeStoredPostList(posts));
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

    const compositeKey = buildCompositePostKey(buildPostKeyFragments(post));
    if (compositeKey) {
      return compositeKey;
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

  // 依去重鍵保留唯一貼文，供多條 selector 命中同一篇貼文時共用。
  function collectUniquePostsByKey(posts, limit = STATE.config.maxPostsPerScan) {
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

  // 對抽出的貼文再次去重，避免多個 selector 命中同一篇貼文。
  function dedupeExtractedPosts(posts, limit = STATE.config.maxPostsPerScan) {
    return collectUniquePostsByKey(posts, limit);
  }

  // 讀取「已看過貼文」儲存區。
  function getSeenPostsStore() {
    return loadNamedObjectStore("seenPosts");
  }

  // 寫回「已看過貼文」儲存區。
  function setSeenPostsStore(store) {
    saveNamedObjectStore("seenPosts", store);
  }

  // 檢查某篇貼文是否已看過，支援直接傳 key 或傳入完整 post 物件。
  function hasSeenPost(groupId, postKey) {
    const groupStore = getSeenPostGroupStore(groupId);
    if (!Object.keys(groupStore).length) return false;
    if (typeof postKey !== "object" && postKey && groupStore[postKey]) return true;

    if (typeof postKey === "object" && postKey) {
      const currentKey = getPostKey(postKey);
      const legacyKey = getLegacyPostKey(postKey);
      return Boolean(
        (currentKey && groupStore[currentKey]) ||
        (legacyKey && groupStore[legacyKey])
      );
    }

    return false;
  }

  // 將單一群組的 seen-post map 依時間排序並裁切到指定上限。
  function trimSeenPostGroupStore(groupStore, limit) {
    const entries = Object.entries(groupStore || {}).sort((a, b) => {
      return new Date(b[1]).getTime() - new Date(a[1]).getTime();
    });

    return Object.fromEntries(entries.slice(0, limit));
  }

  // 建立只保留目前群組 bucket 的 seen-post store。
  function buildSeenPostsStoreForGroup(groupId, groupStore) {
    const normalizedGroupId = String(groupId || "");
    if (!normalizedGroupId) {
      return {};
    }

    return {
      [normalizedGroupId]: groupStore,
    };
  }

  // 讀取指定群組的 seen-post bucket；格式不符時回退為空物件。
  function getSeenPostGroupStore(groupId, store = getSeenPostsStore()) {
    const normalizedGroupId = String(groupId || "");
    if (!normalizedGroupId) {
      return {};
    }

    const groupStore = store?.[normalizedGroupId];
    return groupStore && typeof groupStore === "object" ? groupStore : {};
  }

  // 只寫回指定群組的 seen-post bucket，其他群組資料一律丟棄。
  function setSeenPostGroupStore(groupId, groupStore) {
    setSeenPostsStore(buildSeenPostsStoreForGroup(groupId, groupStore));
  }

  // 將貼文標記為已看過，並依時間保留最近 N 筆。
  function markPostSeen(groupId, postKey) {
    const normalizedGroupId = String(groupId || "");
    const nextGroupStore = getSeenPostGroupStore(normalizedGroupId);

    nextGroupStore[postKey] = new Date().toISOString();
    setSeenPostGroupStore(
      normalizedGroupId,
      trimSeenPostGroupStore(nextGroupStore, getDynamicSeenPostLimit())
    );
  }

  // 清空指定群組的已看過貼文紀錄；若沒有 groupId，則不做任何事。
  function clearSeenPostsForGroup(groupId) {
    const normalizedGroupId = String(groupId || "");
    if (!normalizedGroupId) {
      return;
    }

    setSeenPostGroupStore(normalizedGroupId, {});
  }

  // 讀取目前命中歷史保留上限，集中後續裁切行為。
  function getMatchHistoryLimit() {
    return STATE.config.matchHistoryGlobalLimit;
  }

  // 將命中歷史資料正規化成全域陣列格式，並套用排序與上限裁切。
  function normalizeMatchHistoryEntries(store) {
    if (Array.isArray(store)) {
      return sortMatchHistoryEntries(store).slice(0, getMatchHistoryLimit());
    }

    if (!store || typeof store !== "object") {
      return [];
    }

    return sortMatchHistoryEntries(flattenLegacyMatchHistoryStore(store))
      .slice(0, getMatchHistoryLimit());
  }

  // 讀取命中通知歷史；新版使用全域陣列，舊版依社團分組資料會在讀取時攤平。
  function getMatchHistoryStore() {
    return normalizeMatchHistoryEntries(loadNamedJsonStore("matchHistory", []));
  }

  // 寫回全域命中通知歷史。
  function setMatchHistoryStore(store) {
    saveNamedJsonStore("matchHistory", normalizeMatchHistoryEntries(store));
  }

  // 讀取最近一次通知狀態。
  function getLatestNotificationStore() {
    const store = loadNamedJsonStore("lastNotification", null);
    return store && typeof store === "object" ? store : null;
  }

  // 寫回最近一次通知狀態。
  function setLatestNotificationStore(store) {
    saveNamedJsonStore("lastNotification", store && typeof store === "object" ? store : null);
  }

  // 更新執行期 latestNotification，必要時同步持久化。
  function setLatestNotificationState(notification, options = {}) {
    const { persist = false } = options;
    setNotificationRuntimePatch({
      latestNotification: notification && typeof notification === "object" ? notification : null,
    });
    if (persist) {
      setLatestNotificationStore(STATE.notificationRuntime.latestNotification);
    }
  }

  // 清空執行期 latestNotification，必要時同步清掉持久化值。
  function clearLatestNotificationState(options = {}) {
    const { persist = false } = options;
    setNotificationRuntimePatch({ latestNotification: null });
    if (persist) {
      setLatestNotificationStore(null);
    }
  }

  // 清空所有命中通知歷史。
  function clearMatchHistory() {
    setMatchHistoryStore([]);
  }

  // 將命中歷史依通知時間由新到舊排序。
  function sortMatchHistoryEntries(entries) {
    return [...entries].sort((a, b) => {
      return new Date(b.notifiedAt || 0).getTime() - new Date(a.notifiedAt || 0).getTime();
    });
  }

  // 將新版前的舊格式命中歷史攤平成全域陣列。
  function flattenLegacyMatchHistoryStore(store) {
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

    return flattened;
  }

  // 建立本輪要加入的命中歷史項目，並同步收集用來去掉舊紀錄的唯一鍵。
  function buildIncomingMatchHistoryEntries(groupId, groupName, posts) {
    const incomingPosts = Array.isArray(posts) ? posts : [posts];
    const entries = [];
    const incomingKeys = new Set();

    for (const post of incomingPosts) {
      const postKey = post?.postKey || "";
      const historyKey = `${groupId}::${postKey}`;
      if (postKey && incomingKeys.has(historyKey)) continue;
      if (postKey) incomingKeys.add(historyKey);

      entries.push({
        groupId,
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

    return {
      entries,
      incomingKeys,
    };
  }

  // 合併新的命中歷史與既有紀錄，移除重複 key 並裁切到上限。
  function mergeMatchHistoryEntries(existingEntries, incomingEntries, incomingKeys, limit) {
    const existing = existingEntries.filter((item) => {
      if (!item?.postKey) return true;
      return !incomingKeys.has(`${String(item.groupId || "")}::${item.postKey}`);
    });

    return [...incomingEntries, ...existing].slice(0, limit);
  }

  // 將本輪新命中的貼文批次加入全域歷史，保留傳入順序並移除相同 key 的舊項目。
  function addMatchHistory(groupId, posts) {
    const store = getMatchHistoryStore();
    const normalizedGroupId = String(groupId || "");
    const groupName = getCurrentGroupName();
    const { entries, incomingKeys } = buildIncomingMatchHistoryEntries(
      normalizedGroupId,
      groupName,
      posts
    );

    setMatchHistoryStore(
      mergeMatchHistoryEntries(
        store,
        entries,
        incomingKeys,
        getMatchHistoryLimit()
      )
    );
  }

  // ==========================================================================
  // Scan Engine
  // ==========================================================================

  // 將候選 DOM 轉成貼文紀錄，並在多個視窗區段內累積掃描結果。
  // 將單一候選容器轉成統一的貼文資料結構。
  function extractPostRecord(candidate) {
    const container = candidate.element;
    const postId = extractPostId("", container);
    const textDetails = extractPostTextDetails(container);
    const text = textDetails.text;
    const author = extractAuthor(container);
    // Timestamp fields remain in the post shape for compatibility, but the
    // script no longer attempts to extract post time from Facebook DOM.
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
  async function collectPostsFromCandidates(candidates, scanCache = null, seenStopContext = null) {
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

      const seenStopReason = inspectPostForSeenStop(seenStopContext, post);
      if (seenStopReason) {
        meta.stopReason = seenStopReason;
        break;
      }
    }

    return { posts, meta };
  }

  // 建立跨視窗掃描的執行期上下文。
  function createWindowCollectionContext(targetPostCount, groupId) {
    const result = normalizeCollectedMeta({
      targetCount: targetPostCount,
      maxWindowCount: STATE.config.autoLoadMorePosts ? getDynamicMaxWindows(targetPostCount) : 1,
    });
    const seenStopContext = createSeenPostStopContext(groupId);

    return {
      targetPostCount,
      result,
      accumulated: [],
      accumulatedKeys: new Set(),
      scanCache: new WeakMap(),
      maxWindows: result.maxWindowCount,
      stagnantWindows: 0,
      seenStopContext,
    };
  }

  // 針對目前畫面視窗收集候選、抽取貼文並完成單視窗去重。
  async function collectCurrentWindowPosts(targetPostCount, scanCache, seenStopContext) {
    const candidates = collectPostContainers(getCandidateCollectionLimit(targetPostCount));
    const collected = await collectPostsFromCandidates(candidates, scanCache, seenStopContext);
    const posts = dedupeExtractedPosts(collected.posts, Number.MAX_SAFE_INTEGER);

    return {
      candidates,
      collected,
      posts,
    };
  }

  // 將單一視窗的新貼文併入累積結果，回傳本輪新增篇數。
  function mergeWindowPostsIntoAccumulated(accumulated, accumulatedKeys, posts, targetPostCount) {
    let addedThisWindow = 0;

    for (const post of posts) {
      const postKey = getPostKey(post);
      if (!postKey || accumulatedKeys.has(postKey)) continue;

      accumulatedKeys.add(postKey);
      accumulated.push(post);
      addedThisWindow += 1;

      if (accumulated.length >= targetPostCount) break;
    }

    return addedThisWindow;
  }

  // 將單視窗掃描結果同步回跨視窗 meta。
  function updateWindowCollectionMeta(result, windowIndex, candidates, collected, posts, accumulatedCount, stagnantWindows) {
    result.windowCount = windowIndex + 1;
    accumulateCollectedMetaCounts(result, collected.meta, {
      candidateCountDelta: candidates.length,
      parsedCountDelta: posts.length,
      afterCount: candidates.length,
    });
    result.accumulatedCount = accumulatedCount;
    result.stagnantWindows = stagnantWindows;
  }

  // 依目前狀態判斷是否應停止跨視窗掃描。
  function getWindowCollectionStopReason(accumulatedCount, targetPostCount, collected) {
    if (collected?.meta?.stopReason) {
      return collected.meta.stopReason;
    }
    if (accumulatedCount >= targetPostCount) {
      return "已達目標貼文數";
    }
    if (!STATE.config.autoLoadMorePosts) {
      return "已停用自動載入更多貼文";
    }

    return "";
  }

  // 依設定執行下一輪 load-more 動作。
  function performConfiguredLoadMore() {
    if (getLoadMoreMode() === "wheel") {
      performWheelLikeLoad();
      return;
    }

    performScrollLoad();
  }

  // 收尾跨視窗掃描的停止原因，讓 return 結構固定一致。
  function finalizeWindowCollectionResult(context) {
    const { result, accumulated, targetPostCount, maxWindows } = context;

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

  // 若上一輪仍在載入更多貼文，改成只吃當前視窗，避免多個掃描流程互搶。
  async function collectCurrentWindowOnlyResult(context, initialCandidates) {
    const { result, scanCache, targetPostCount, seenStopContext } = context;

    result.stopReason = "目前正在載入更多貼文，先使用當前視窗結果";
    const initialCollected = await collectPostsFromCandidates(initialCandidates, scanCache, seenStopContext);
    accumulateCollectedMetaCounts(result, initialCollected.meta);
    const initialPosts = dedupeExtractedPosts(initialCollected.posts, targetPostCount);

    return {
      posts: initialPosts,
      meta: result,
    };
  }

  // 只掃描目前可見視窗，用於最上方貼文快篩命中後的快速返回。
  async function collectVisiblePostsOnly() {
    const targetPostCount = clampTargetPostCount(STATE.config.maxPostsPerScan);
    const candidates = collectPostContainers(getCandidateCollectionLimit(1));
    const collected = await collectPostsFromCandidates(candidates, new WeakMap());
    const posts = dedupeExtractedPosts(collected.posts, targetPostCount);

    return {
      posts,
      meta: buildSingleWindowCollectedMeta({
        targetCount: targetPostCount,
        candidateCount: candidates.length,
        collectedMeta: collected.meta,
        parsedCount: posts.length,
        accumulatedCount: posts.length,
      }),
    };
  }

  // 建立 top-post shortcut 的初始 meta 與關鍵資料。
  function buildTopPostShortcutContext(visibleResult) {
    const topPost = visibleResult.posts[0] || null;
    const topPostKey = topPost ? getPostKey(topPost) : "";

    visibleResult.meta.topPostShortcutUsed = true;
    visibleResult.meta.topPostKey = topPostKey;

    return {
      visibleResult,
      topPost,
      topPostKey,
    };
  }

  // 判斷本輪是否適合進行 top-post shortcut 比對。
  function getTopPostShortcutBypassReason(reason, topPost, topPostKey) {
    if (!STATE.config.autoLoadMorePosts) {
      return "已停用自動載入更多貼文";
    }
    if (!shouldUseTopPostShortcut(reason)) {
      return "skip_shortcut_check";
    }
    if (getCurrentFeedSortLabel() !== "新貼文") {
      return "skip_shortcut_check";
    }
    if (!topPost || !topPostKey) {
      return "skip_shortcut_check";
    }

    return "";
  }

  // 將 top-post shortcut 的 cache hit 結果套回可見視窗結果。
  function applyTopPostShortcutCacheHit(visibleResult, groupId) {
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

  // 將最新 top post snapshot 與 shortcut 判斷同步到結果上。
  function resolveTopPostShortcutResult(reason, groupId, shortcutContext) {
    const { visibleResult, topPost, topPostKey } = shortcutContext;
    const bypassReason = getTopPostShortcutBypassReason(reason, topPost, topPostKey);

    if (bypassReason === "已停用自動載入更多貼文") {
      visibleResult.meta.stopReason = bypassReason;
      return visibleResult;
    }
    if (bypassReason) {
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
      return applyTopPostShortcutCacheHit(visibleResult, groupId);
    }

    setLatestTopPostForGroup(groupId, topPost);
    visibleResult.meta.topPostShortcutMatched = false;
    return null;
  }

  // 先比對最上方最新貼文是否與上一輪相同；相同時直接跳過深度掃描。
  async function collectPostsWithTopPostShortcut(reason, groupId) {
    const visibleResult = await collectVisiblePostsOnly();
    return resolveTopPostShortcutResult(reason, groupId, buildTopPostShortcutContext(visibleResult));
  }

  // 在當前視窗與後續滾動視窗中累積貼文，直到足夠或達到保守上限。
  async function collectPostsAcrossWindows(groupId) {
    const context = createWindowCollectionContext(
      clampTargetPostCount(STATE.config.maxPostsPerScan),
      groupId
    );
    const {
      targetPostCount,
      result,
      accumulated,
      accumulatedKeys,
      scanCache,
      maxWindows,
      seenStopContext,
    } = context;
    const initialCandidates = collectPostContainers(getCandidateCollectionLimit(targetPostCount));
    result.beforeCount = initialCandidates.length;
    result.afterCount = initialCandidates.length;

    // 若其他掃描流程正在載入更多貼文，這輪只吃當前視窗，避免互相打架。
    if (STATE.scanRuntime.isLoadingMorePosts) {
      return collectCurrentWindowOnlyResult(context, initialCandidates);
    }

    const startY = window.scrollY;
    setScanRuntimePatch({ isLoadingMorePosts: true });

    try {
      for (let windowIndex = 0; windowIndex < maxWindows; windowIndex += 1) {
        // 每個 window 代表「目前畫面可見範圍」的一次候選收集。
        const { candidates, collected, posts } = await collectCurrentWindowPosts(
          targetPostCount,
          scanCache,
          seenStopContext
        );
        const addedThisWindow = mergeWindowPostsIntoAccumulated(
          accumulated,
          accumulatedKeys,
          posts,
          targetPostCount
        );

        if (addedThisWindow === 0) {
          // 沒有新增貼文時累計停滯視窗數，作為後續停止掃描的參考訊號。
          context.stagnantWindows += 1;
        } else {
          context.stagnantWindows = 0;
        }

        updateWindowCollectionMeta(
          result,
          windowIndex,
          candidates,
          collected,
          posts,
          accumulated.length,
          context.stagnantWindows
        );

        result.stopReason = getWindowCollectionStopReason(accumulated.length, targetPostCount, collected);
        if (result.stopReason) {
          break;
        }

        result.attempted = true;
        result.attempts += 1;
        performConfiguredLoadMore();

        // 給 Facebook 一點時間把新增內容補進 DOM。
        await sleep(900);
      }
    } finally {
      // 掃描結束後把視窗捲回原位，避免干擾使用者閱讀。
      window.scrollTo(0, startY);
      await sleep(160);
      setScanRuntimePatch({ isLoadingMorePosts: false });
    }

    return finalizeWindowCollectionResult(context);
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

  // 將單次候選收集的統計欄位累加到 scan meta。
  function accumulateCollectedMetaCounts(targetMeta, sourceMeta, options = {}) {
    const {
      candidateCountDelta = 0,
      parsedCountDelta = 0,
      afterCount = 0,
    } = options;

    if (!targetMeta || !sourceMeta) return;

    targetMeta.candidateCount += candidateCountDelta;
    targetMeta.cacheHitCount += sourceMeta.cacheHitCount;
    targetMeta.freshExtractCount += sourceMeta.freshExtractCount;
    targetMeta.parsedCount += parsedCountDelta;
    targetMeta.filteredEmptyTextCount += sourceMeta.filteredEmptyTextCount;
    targetMeta.filteredNonPostCount += sourceMeta.filteredNonPostCount;
    targetMeta.filteredFeedSortControlCount += sourceMeta.filteredFeedSortControlCount;
    targetMeta.articleElementCount += sourceMeta.articleElementCount;
    targetMeta.postsWithPostIdCount += sourceMeta.postsWithPostIdCount;
    targetMeta.afterCount = Math.max(targetMeta.afterCount, afterCount);
  }

  // 建立單一可見視窗掃描的標準 meta。
  function buildSingleWindowCollectedMeta({
    targetCount,
    candidateCount,
    collectedMeta,
    parsedCount,
    accumulatedCount,
  }) {
    return normalizeCollectedMeta({
      targetCount,
      maxWindowCount: STATE.config.autoLoadMorePosts ? getDynamicMaxWindows(targetCount) : 1,
      beforeCount: candidateCount,
      afterCount: candidateCount,
      windowCount: 1,
      candidateCount,
      cacheHitCount: collectedMeta.cacheHitCount,
      freshExtractCount: collectedMeta.freshExtractCount,
      parsedCount,
      accumulatedCount,
      filteredEmptyTextCount: collectedMeta.filteredEmptyTextCount,
      filteredNonPostCount: collectedMeta.filteredNonPostCount,
      filteredFeedSortControlCount: collectedMeta.filteredFeedSortControlCount,
      articleElementCount: collectedMeta.articleElementCount,
      postsWithPostIdCount: collectedMeta.postsWithPostIdCount,
    });
  }

  // 建立 collected meta 的標準欄位形狀，避免不同掃描路徑回傳結構不一致。
  function normalizeCollectedMeta(meta = {}) {
    return {
      targetCount: STATE.config.maxPostsPerScan,
      mode: STATE.config.autoLoadMorePosts ? getLoadMoreMode() : "off",
      attempted: false,
      attempts: 0,
      beforeCount: 0,
      afterCount: 0,
      windowCount: 0,
      candidateCount: 0,
      cacheHitCount: 0,
      freshExtractCount: 0,
      parsedCount: 0,
      accumulatedCount: 0,
      maxWindowCount: 0,
      stagnantWindows: 0,
      stopReason: "",
      filteredEmptyTextCount: 0,
      filteredNonPostCount: 0,
      filteredFeedSortControlCount: 0,
      articleElementCount: 0,
      postsWithPostIdCount: 0,
      topPostShortcutUsed: false,
      topPostShortcutMatched: false,
      topPostKey: "",
      previousTopPostKey: "",
      ...meta,
    };
  }

  // 建立掃描前的預設結果，讓無法掃描時仍有一致的回傳結構。
  function createEmptyCollectedResult() {
    return {
      posts: [],
      meta: normalizeCollectedMeta(),
    };
  }

  // 收集本輪掃描貼文，並處理最上方貼文快篩後的快取寫回。
  async function collectScanPosts(reason, supported, groupId) {
    let collectedResult = createEmptyCollectedResult();
    if (supported) {
      const shortcutResult = await collectPostsWithTopPostShortcut(reason, groupId);
      collectedResult = shortcutResult || await collectPostsAcrossWindows(groupId);
    }

    const uniquePosts = collectedResult.posts;
    if (supported && uniquePosts.length) {
      setLatestTopPostForGroup(groupId, uniquePosts[0]);
    }
    if (supported && !collectedResult.meta.topPostShortcutMatched) {
      setLatestScanPostsForGroup(groupId, uniquePosts);
    }

    return {
      collectedResult,
      uniquePosts,
    };
  }

  // 將單篇貼文套用 include / exclude / seen 判斷，整理成統一摘要格式。
  function buildPostScanSummary(post, groupId, includeRules, excludeRules) {
    const postKey = getPostKey(post);
    const seen = hasSeenPost(groupId, post);
    const includeResult = matchRules(includeRules, post.normalizedText);
    const excludeResult = excludeRules.length
      ? matchRules(excludeRules, post.normalizedText)
      : { matched: false, rule: "" };

    return {
      ...post,
      postKey,
      seen,
      includeRule: includeResult.rule,
      excludeRule: excludeResult.rule,
      eligible: includeResult.matched && !excludeResult.matched,
    };
  }

  // 只有「未看過」且「符合規則」的摘要才進通知佇列。
  function shouldNotifyScanSummary(summary) {
    return Boolean(summary && !summary.seen && summary.eligible);
  }

  // 將貼文套用 include / exclude 與已看過判斷，整理成本輪摘要與通知佇列。
  function summarizeScanPosts(uniquePosts, groupId, includeRules, excludeRules) {
    const summaries = [];
    const matchesToNotify = [];

    for (const post of uniquePosts) {
      const summary = buildPostScanSummary(post, groupId, includeRules, excludeRules);
      summaries.push(summary);

      // 已看過或不符合規則的貼文只保留在摘要，不進通知佇列。
      if (shouldNotifyScanSummary(summary)) {
        matchesToNotify.push(summary);
      }
    }

    return {
      summaries,
      matchesToNotify,
    };
  }

  // 建立「已看過貼文提前停止」的純邏輯狀態。
  function createSeenPostStopState(options = {}) {
    const {
      enabled = false,
      minNewPostsBeforeStop = SCAN_LIMITS.minNewPostsBeforeSeenStop,
      consecutiveSeenThreshold = SCAN_LIMITS.consecutiveSeenStopCount,
    } = options;

    return {
      enabled,
      minNewPostsBeforeStop,
      consecutiveSeenThreshold,
      newPostCount: 0,
      consecutiveSeenCount: 0,
      processedKeys: new Set(),
      triggered: false,
      stopReason: "",
    };
  }

  // 將單筆唯一貼文的 seen 狀態套入停止策略，必要時標記提早停止。
  function applySeenPostStopObservation(state, observation) {
    if (!state?.enabled || state.triggered || !observation) {
      return state;
    }

    const { postKey = "", seen = false } = observation;
    if (!postKey || state.processedKeys.has(postKey)) {
      return state;
    }

    state.processedKeys.add(postKey);

    if (!seen) {
      state.newPostCount += 1;
      state.consecutiveSeenCount = 0;
      return state;
    }

    if (state.newPostCount < state.minNewPostsBeforeStop) {
      return state;
    }

    state.consecutiveSeenCount += 1;
    if (state.consecutiveSeenCount < state.consecutiveSeenThreshold) {
      return state;
    }

    state.triggered = true;
    state.stopReason = `已連續遇到 ${state.consecutiveSeenThreshold} 篇已看過貼文，停止深度掃描`;
    return state;
  }

  // 只有在「新貼文」排序且已有 seen 紀錄時，才啟用保守的 seen-stop 深掃捷徑。
  function shouldUseSeenPostStop(groupId) {
    if (!groupId) return false;
    if (getCurrentFeedSortLabel() !== "新貼文") return false;
    return Object.keys(getSeenPostGroupStore(groupId, getSeenPostsStore())).length > 0;
  }

  // 建立掃描期的 seen-stop context，供候選抽取與跨視窗停止判斷共用。
  function createSeenPostStopContext(groupId) {
    return {
      groupId,
      state: createSeenPostStopState({
        enabled: shouldUseSeenPostStop(groupId),
      }),
    };
  }

  // 觀察單篇貼文是否已看過，並更新目前這輪掃描的 seen-stop 狀態。
  function inspectPostForSeenStop(context, post) {
    if (!context?.state?.enabled || !post) {
      return "";
    }

    const postKey = getPostKey(post);
    const seen = hasSeenPost(context.groupId, post);
    applySeenPostStopObservation(context.state, { postKey, seen });
    return context.state.stopReason;
  }

  // 依序發送本輪新命中的通知，並立即把已通知 key 納入 seen。
  async function notifyMatchesAndMarkSeen(groupId, matchesToNotify) {
    for (const item of matchesToNotify) {
      await notifyForPost(item);
      if (item.postKey) {
        markPostSeen(groupId, item.postKey);
      }
    }
  }

  // 將本輪新命中的貼文寫入全域通知歷史。
  function addMatchesToHistory(groupId, matchesToNotify) {
    if (matchesToNotify.length) {
      addMatchHistory(groupId, matchesToNotify);
    }
  }

  // 即使沒有通知，也要把本輪掃到的貼文記成 seen，避免下一輪重複報警。
  function markSummariesSeen(groupId, summaries) {
    for (const item of summaries) {
      if (item.postKey) {
        markPostSeen(groupId, item.postKey);
      }
    }
  }

  // 讀取指定群組最新的 seen map，供 panel/debug 狀態重建使用。
  function getLatestSeenMapForGroup(groupId) {
    return getSeenPostGroupStore(groupId, getSeenPostsStore());
  }

  // 依本輪掃描結果送通知、更新命中歷史與已看過貼文狀態。
  async function commitScanState(groupId, summaries, matchesToNotify) {
    await notifyMatchesAndMarkSeen(groupId, matchesToNotify);
    addMatchesToHistory(groupId, matchesToNotify);
    markSummariesSeen(groupId, summaries);
    return getLatestSeenMapForGroup(groupId);
  }

  // 將摘要貼文重新套用最新 seen map，供主面板顯示使用。
  function buildLatestPostsState(summaries, latestSeenMap) {
    return summaries.map((item) => ({
      ...item,
      seen: Boolean(item.postKey && latestSeenMap[item.postKey]),
    }));
  }

  // 將本輪掃描結果整理成 debug / panel 共用的 latestScan 狀態物件。
  function buildLatestScanState({
    reason,
    supported,
    groupId,
    collectedResult,
    uniquePosts,
    matchesToNotify,
    baselineMode,
  }) {
    const collectedMeta = normalizeCollectedMeta(collectedResult.meta);

    return {
      reason,
      supported,
      groupId,
      candidateCount: collectedMeta.candidateCount,
      cacheHitCount: collectedMeta.cacheHitCount,
      freshExtractCount: collectedMeta.freshExtractCount,
      parsedCount: collectedMeta.parsedCount,
      scannedCount: uniquePosts.length,
      notifiedCount: matchesToNotify.length,
      baselineMode,
      targetCount: collectedMeta.targetCount,
      loadMoreMode: collectedMeta.mode,
      loadMoreAttempted: collectedMeta.attempted,
      loadMoreAttempts: collectedMeta.attempts,
      maxWindowCount: collectedMeta.maxWindowCount,
      stagnantWindows: collectedMeta.stagnantWindows,
      stopReason: collectedMeta.stopReason,
      loadMoreBeforeCount: collectedMeta.beforeCount,
      loadMoreAfterCount: collectedMeta.afterCount,
      loadMoreWindowCount: collectedMeta.windowCount,
      accumulatedCount: collectedMeta.accumulatedCount,
      topPostShortcutUsed: collectedMeta.topPostShortcutUsed,
      topPostShortcutMatched: collectedMeta.topPostShortcutMatched,
      topPostKey: collectedMeta.topPostKey,
      previousTopPostKey: collectedMeta.previousTopPostKey,
      filteredEmptyTextCount: collectedMeta.filteredEmptyTextCount,
      filteredNonPostCount: collectedMeta.filteredNonPostCount,
      filteredFeedSortControlCount: collectedMeta.filteredFeedSortControlCount,
      articleElementCount: collectedMeta.articleElementCount,
      postsWithPostIdCount: collectedMeta.postsWithPostIdCount,
      finishedAt: new Date().toISOString(),
    };
  }

  // 建立單輪掃描需要的固定 context，集中 page/rule/baseline 判斷。
  function createScanExecutionContext(reason) {
    const supported = isSupportedGroupPage();
    const groupId = getCurrentGroupId();

    return {
      reason,
      supported,
      groupId,
      includeRules: parseKeywordInput(STATE.config.includeKeywords),
      excludeRules: parseKeywordInput(STATE.config.excludeKeywords),
      // 每個群組第一次掃描只建立 baseline，不對既有貼文發通知。
      baselineMode: !STATE.sessionRuntime.initializedGroups.has(groupId),
    };
  }

  // 依 scan context 執行本輪貼文收集與規則摘要。
  async function collectScanExecutionData(scanContext) {
    const { collectedResult, uniquePosts } = await collectScanPosts(
      scanContext.reason,
      scanContext.supported,
      scanContext.groupId
    );
    const { summaries, matchesToNotify } = summarizeScanPosts(
      uniquePosts,
      scanContext.groupId,
      scanContext.includeRules,
      scanContext.excludeRules
    );

    return {
      collectedResult,
      uniquePosts,
      summaries,
      matchesToNotify,
    };
  }

  // baseline 群組只需要在成功完成本輪掃描後註記一次。
  function markGroupInitializedAfterScan(groupId, baselineMode) {
    if (baselineMode) {
      STATE.sessionRuntime.initializedGroups.add(groupId);
    }
  }

  // 將成功完成的 scan 結果整理成 runtime state patch。
  function buildSuccessfulScanRuntimeState(scanContext, scanData, latestSeenMap) {
    return {
      latestPosts: buildLatestPostsState(scanData.summaries, latestSeenMap),
      latestScan: buildLatestScanState({
        reason: scanContext.reason,
        supported: scanContext.supported,
        groupId: scanContext.groupId,
        collectedResult: scanData.collectedResult,
        uniquePosts: scanData.uniquePosts,
        matchesToNotify: scanData.matchesToNotify,
        baselineMode: scanContext.baselineMode,
      }),
      clearLatestNotification: !scanData.matchesToNotify.length,
    };
  }

  // 套用成功掃描後的 runtime state，讓 runScan() 保持在 orchestration 層。
  function applySuccessfulScanRuntimeState(runtimeState) {
    applyScanRuntimeState({
      latestPosts: runtimeState.latestPosts,
      latestScan: runtimeState.latestScan,
      latestError: "",
    });
    if (runtimeState.clearLatestNotification) {
      clearLatestNotificationState();
    }
  }

  // 單輪掃描失敗時的共用收尾。
  function handleScanFailure(error) {
    applyScanRuntimeState(buildFailedScanRuntimeState(error));
    console.error("[fb-group-refresh] scan failed", error);
  }

  // 主掃描流程：收集貼文、套用 include/exclude、去重並觸發通知。
  // 核心掃描入口：收集貼文、套規則、判斷 baseline、通知並更新 UI 狀態。
  async function runScan(reason) {
    if (STATE.config.paused) {
      requestPanelRender();
      return;
    }
    if (STATE.scanRuntime.isScanning) return;

    setScanRuntimePatch({ isScanning: true });

    try {
      const scanContext = createScanExecutionContext(reason);
      const scanData = await collectScanExecutionData(scanContext);

      markGroupInitializedAfterScan(scanContext.groupId, scanContext.baselineMode);
      const latestSeenMap = await commitScanState(
        scanContext.groupId,
        scanData.summaries,
        scanData.matchesToNotify
      );
      applySuccessfulScanRuntimeState(
        buildSuccessfulScanRuntimeState(scanContext, scanData, latestSeenMap)
      );
    } catch (error) {
      handleScanFailure(error);
    } finally {
      setScanRuntimePatch({ isScanning: false });
      rescheduleRefreshAndRender();
    }
  }

  // ==========================================================================
  // Notifier
  // ==========================================================================

  // 通知分發與手動測試通知。
  // 建立本輪通知開始前的 latestNotification 狀態。
  function createPendingNotificationState(title, body, permalink) {
    return {
      title,
      body,
      permalink,
      timestamp: new Date().toISOString(),
      status: "pending",
    };
  }

  // 本地桌面通知優先走 Tampermonkey GM_notification。
  function sendGmDesktopNotification(title, compactBody) {
    if (!STATE.config.enableGmNotification) {
      return "";
    }

    try {
      GM_notification({
        title,
        text: compactBody,
        timeout: 15000,
      });
      return "gm_sent";
    } catch (error) {
      return "gm_failed";
    }
  }

  // 透過 ntfy topic 傳送遠端通知；未設定 topic 時直接跳過。
  function sendNtfyNotification({ title, body, clickUrl }) {
    const topic = getPersistedNtfyTopic();
    applyNotificationConfigPatch({ ntfyTopic: topic });
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
    applyNotificationConfigPatch({ discordWebhook: webhook });
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

  // 只有實際送出或失敗的通道結果才加入狀態摘要。
  function appendNotificationStatus(statusParts, status, skippedStatus = "") {
    if (!status || status === skippedStatus) return;
    statusParts.push(status);
  }

  // 更新 latestNotification 的最終狀態並持久化。
  function finalizeLatestNotification(statusParts) {
    const latestNotification = buildCompletedNotificationState(
      STATE.notificationRuntime.latestNotification,
      statusParts
    );
    if (!latestNotification) return;

    setLatestNotificationState(latestNotification, { persist: true });
  }

  // 建立本輪通知內容與標題，供各通知通道共用。
  function buildNotificationPayload(post) {
    return {
      title: "Facebook group match",
      compactBody: buildCompactNotificationBody(post),
      remoteBody: buildRemoteNotificationBody(post),
    };
  }

  // 建立每個通知通道對應的執行器，避免 task 建立端維護 switch。
  function buildNotificationChannelRunnerMap(post, payload) {
    return {
      gmDesktop: () => Promise.resolve(sendGmDesktopNotification(payload.title, payload.compactBody)),
      ntfy: () => sendNtfyNotification({
        title: payload.title,
        body: payload.remoteBody,
        clickUrl: post.permalink,
      }),
      discord: () => sendDiscordWebhookNotification({
        title: payload.title,
        body: payload.remoteBody,
        clickUrl: post.permalink,
      }),
    };
  }

  // 依通道定義與執行器建立單一通知 task。
  function createNotificationChannelTask(definition, runnerMap) {
    return {
      channelId: definition.id,
      skippedStatus: definition.skippedStatus,
      run: runnerMap[definition.id] || (() => Promise.resolve("")),
    };
  }

  // 建立本輪通知通道任務，讓 orchestration 不直接依序寫死所有通道。
  function createNotificationChannelTasks(post, payload) {
    const runnerMap = buildNotificationChannelRunnerMap(post, payload);
    return NOTIFICATION_CHANNEL_DEFINITIONS.map((definition) => {
      return createNotificationChannelTask(definition, runnerMap);
    });
  }

  // 依序執行通知通道任務，並收集最終狀態摘要。
  async function collectNotificationStatusParts(tasks) {
    const statusParts = [];

    for (const task of tasks) {
      appendNotificationStatus(statusParts, await task.run(), task.skippedStatus);
    }

    return statusParts;
  }

  // 依目前設定分送桌面通知、ntfy 與 Discord Webhook。
  async function notifyForPost(post) {
    const payload = buildNotificationPayload(post);

    setLatestNotificationState(
      createPendingNotificationState(payload.title, payload.remoteBody, post.permalink)
    );
    const statusParts = await collectNotificationStatusParts(
      createNotificationChannelTasks(post, payload)
    );
    finalizeLatestNotification(statusParts);
  }

  // 從設定視窗觸發的手動測試通知。
  async function sendTestNotification() {
    const mockPost = {
      author: "Test",
      includeRule: "manual test",
      text: "This is a test notification from facebook_group_refresh.",
      permalink: location.href,
    };
    await notifyForPost(mockPost);
    requestPanelRender();
  }

  // ==========================================================================
  // UI / Modal
  // ==========================================================================

  // UI: 命中歷史視窗。
  // 統一切換 overlay / modal 的顯示狀態。
  function setOverlayVisibility(overlay, visible) {
    if (!overlay) return;
    overlay.style.display = visible ? "block" : "none";
  }

  // 依元素 id 顯示指定 overlay。
  function showOverlayById(id) {
    setOverlayVisibility(document.getElementById(id), true);
  }

  // 依元素 id 關閉指定 overlay。
  function hideOverlayById(id) {
    setOverlayVisibility(document.getElementById(id), false);
  }

  // 以共用樣式建立 overlay 容器並附加到頁面上。
  function createOverlayElement({ id, zIndex, innerHtml, padding = 24 }) {
    const overlay = document.createElement("div");
    overlay.id = id;
    overlay.style.cssText = [
      "display:none",
      "position:fixed",
      "inset:0",
      `z-index:${zIndex}`,
      "background:rgba(0,0,0,0.55)",
      `padding:${padding}px`,
      "box-sizing:border-box",
    ].join(";");
    overlay.innerHTML = innerHtml;
    document.body.appendChild(overlay);
    return overlay;
  }

  // 集中查找歷史紀錄視窗內會重複使用的節點。
  function getHistoryModalElementRefs(overlay) {
    if (!overlay) return null;

    const refs = {
      overlay,
      contentEl: overlay.querySelector("#fbgr-history-content"),
    };

    if (!refs.contentEl) {
      return null;
    }

    return refs;
  }

  // 歷史紀錄為空時的固定內容。
  function renderEmptyHistoryHtml() {
    return "<div>目前還沒有符合關鍵字的紀錄。</div>";
  }

  // 渲染單筆歷史紀錄卡片。
  function renderHistoryEntryHtml(item, index) {
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
  }

  // 將整份歷史紀錄資料轉成視窗內容 HTML。
  function renderHistoryModalContentHtml(displayHistory) {
    if (!displayHistory.length) {
      return renderEmptyHistoryHtml();
    }

    return displayHistory.map((item, index) => {
      return renderHistoryEntryHtml(item, index);
    }).join("");
  }

  // 建立歷史紀錄 modal 的固定外層 HTML。
  function renderHistoryModalShellHtml() {
    return `
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
  }

  // 綁定歷史紀錄 modal 的互動事件。
  function bindHistoryModalEventHandlers(overlay) {
    if (!overlay) return;

    overlay.querySelector("#fbgr-history-clear")?.addEventListener("click", () => {
      if (!window.confirm("確定要清空所有符合關鍵字紀錄嗎？")) return;
      clearMatchHistory();
      openHistoryModal();
    });
    overlay.querySelector("#fbgr-history-close")?.addEventListener("click", closeHistoryModal);
  }

  // 建立命中通知歷史視窗的 DOM；只建立一次。
  function createHistoryModal() {
    if (document.getElementById("fbgr-history-modal")) return;

    const overlay = createOverlayElement({
      id: "fbgr-history-modal",
      zIndex: 2147483644,
      innerHtml: renderHistoryModalShellHtml(),
    });
    bindHistoryModalEventHandlers(overlay);
  }

  // 讀取全域命中歷史並渲染到視窗中。
  function openHistoryModal() {
    createHistoryModal();
    const overlay = document.getElementById("fbgr-history-modal");
    const historyRefs = getHistoryModalElementRefs(overlay);
    if (!historyRefs) return;

    const displayHistory = getMatchHistoryStore();
    historyRefs.contentEl.innerHTML = renderHistoryModalContentHtml(displayHistory);
    setOverlayVisibility(historyRefs.overlay, true);
  }

  // 關閉命中通知歷史視窗。
  function closeHistoryModal() {
    hideOverlayById("fbgr-history-modal");
  }

  const HELP_MODAL_DEFINITIONS = Object.freeze({
    include: {
      overlayId: "fbgr-include-help-modal",
      title: "關鍵字輸入規則",
      closeButtonId: "fbgr-include-help-close",
      zIndex: 2147483646,
      bodyHtml: `
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
      `,
    },
    ntfy: {
      overlayId: "fbgr-ntfy-help-modal",
      title: "ntfy 說明",
      closeButtonId: "fbgr-ntfy-help-close",
      bodyHtml: `
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
      `,
    },
    discord: {
      overlayId: "fbgr-discord-help-modal",
      title: "Discord Webhook 說明",
      closeButtonId: "fbgr-discord-help-close",
      bodyHtml: `
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
      `,
    },
  });

  // 建立共用的 help modal 外層骨架，讓多個說明視窗只需要關心內容本身。
  function createHelpModalShell({
    overlayId,
    title,
    bodyHtml,
    closeButtonId,
    zIndex = 2147483647,
    maxWidth = 520,
  }) {
    if (document.getElementById(overlayId)) return;

    const overlay = createOverlayElement({
      id: overlayId,
      zIndex,
      innerHtml: `
        <div style="max-width:${maxWidth}px;margin:40px auto 0 auto;background:#111827;color:#f9fafb;border:1px solid #4b5563;border-radius:14px;padding:16px;box-shadow:0 18px 40px rgba(0,0,0,0.4);font-family:Consolas, 'Courier New', monospace;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;">
            <div style="font-size:16px;font-weight:bold;">${title}</div>
            <button id="${closeButtonId}" style="padding:4px 8px;cursor:pointer;">關閉</button>
          </div>
          <div style="display:grid;gap:12px;line-height:1.6;">
            ${bodyHtml}
          </div>
        </div>
      `,
    });
    overlay.querySelector(`#${closeButtonId}`)?.addEventListener("click", () => {
      hideOverlayById(overlayId);
    });
  }

  // 依定義建立指定 help modal。
  function createHelpModal(kind) {
    const definition = HELP_MODAL_DEFINITIONS[kind];
    if (!definition) return;
    createHelpModalShell(definition);
  }

  // 依定義建立並顯示指定 help modal。
  function openHelpModal(kind) {
    const definition = HELP_MODAL_DEFINITIONS[kind];
    if (!definition) return;

    createHelpModal(kind);
    showOverlayById(definition.overlayId);
  }

  // 預先建立所有 help modal，讓後續開啟動作只剩顯示切換。
  function createAllHelpModals() {
    Object.keys(HELP_MODAL_DEFINITIONS).forEach((kind) => {
      createHelpModal(kind);
    });
  }

  // UI: 設定視窗與刷新模式切換。
  // 集中查找設定視窗內會重複使用的欄位節點。
  function getSettingsModalElementRefs(overlay) {
    if (!overlay) return null;

    const refs = {
      overlay,
      jitterEnabledEl: overlay.querySelector("#fbgr-jitter-enabled"),
      autoLoadMoreEl: overlay.querySelector("#fbgr-auto-load-more"),
      fixedRefreshEl: overlay.querySelector("#fbgr-fixed-refresh"),
      minRefreshEl: overlay.querySelector("#fbgr-refresh-min"),
      maxRefreshEl: overlay.querySelector("#fbgr-refresh-max"),
      maxPostsPerScanEl: overlay.querySelector("#fbgr-max-posts-per-scan"),
      ntfyTopicEl: overlay.querySelector("#fbgr-ntfy-topic"),
      discordWebhookEl: overlay.querySelector("#fbgr-discord-webhook"),
      jitterWrapEl: overlay.querySelector("#fbgr-jitter-wrap"),
      fixedWrapEl: overlay.querySelector("#fbgr-fixed-wrap"),
    };

    if (
      !refs.jitterEnabledEl ||
      !refs.autoLoadMoreEl ||
      !refs.fixedRefreshEl ||
      !refs.minRefreshEl ||
      !refs.maxRefreshEl ||
      !refs.maxPostsPerScanEl ||
      !refs.ntfyTopicEl ||
      !refs.discordWebhookEl ||
      !refs.jitterWrapEl ||
      !refs.fixedWrapEl
    ) {
      return null;
    }

    return refs;
  }

  // 從設定視窗欄位讀出目前草稿值，並做基本正規化。
  function readSettingsModalDraft(settingsRefs) {
    if (!settingsRefs) return null;

    return {
      jitterEnabled: settingsRefs.jitterEnabledEl.checked,
      ntfyTopic: normalizeText(settingsRefs.ntfyTopicEl.value),
      discordWebhook: normalizeText(settingsRefs.discordWebhookEl.value),
      autoLoadMorePosts: settingsRefs.autoLoadMoreEl.checked,
      minRefreshSec: Math.max(5, Math.floor(Number(settingsRefs.minRefreshEl.value) || STATE.config.minRefreshSec)),
      maxRefreshSec: Math.max(5, Math.floor(Number(settingsRefs.maxRefreshEl.value) || STATE.config.maxRefreshSec)),
      fixedRefreshSec: Math.max(5, Math.floor(Number(settingsRefs.fixedRefreshEl.value) || STATE.config.fixedRefreshSec)),
      maxPostsPerScan: clampTargetPostCount(settingsRefs.maxPostsPerScanEl.value),
    };
  }

  // 將設定草稿套回執行期 state 並寫入持久化儲存。
  function applySettingsModalDraft(draft) {
    if (!draft) return;

    applyRefreshConfigPatch(
      {
        jitterEnabled: draft.jitterEnabled,
        autoLoadMorePosts: draft.autoLoadMorePosts,
        minRefreshSec: draft.minRefreshSec,
        maxRefreshSec: draft.maxRefreshSec,
        fixedRefreshSec: draft.fixedRefreshSec,
        maxPostsPerScan: draft.maxPostsPerScan,
      },
      { persist: true }
    );
    applyNotificationConfigPatch(
      {
        ntfyTopic: draft.ntfyTopic,
        discordWebhook: draft.discordWebhook,
      },
      { persist: true }
    );
  }

  // 將目前設定回填到設定視窗欄位。
  function populateSettingsModalFields(settingsRefs) {
    if (!settingsRefs) return;

    settingsRefs.jitterEnabledEl.checked = STATE.config.jitterEnabled;
    settingsRefs.ntfyTopicEl.value = STATE.config.ntfyTopic;
    settingsRefs.discordWebhookEl.value = STATE.config.discordWebhook;
    settingsRefs.autoLoadMoreEl.checked = STATE.config.autoLoadMorePosts;
    settingsRefs.minRefreshEl.value = String(STATE.config.minRefreshSec);
    settingsRefs.maxRefreshEl.value = String(STATE.config.maxRefreshSec);
    settingsRefs.fixedRefreshEl.value = String(STATE.config.fixedRefreshSec);
    settingsRefs.maxPostsPerScanEl.value = String(STATE.config.maxPostsPerScan);
  }

  // 設定視窗中的測試通知只暫存通知端點，不修改其他刷新設定。
  function handleSettingsTestNotification(settingsRefs) {
    const draft = readSettingsModalDraft(settingsRefs);
    if (!draft) return;

    applyNotificationConfigPatch(
      {
        ntfyTopic: draft.ntfyTopic,
        discordWebhook: draft.discordWebhook,
      },
      { persist: true }
    );
    sendTestNotification();
  }

  // 儲存設定視窗中的所有欄位，並同步重排 refresh 顯示。
  function handleSettingsSave(settingsRefs) {
    const draft = readSettingsModalDraft(settingsRefs);
    if (!draft) return;

    applySettingsModalDraft(draft);
    closeSettingsModal();
    rescheduleRefreshAndRender();
  }

  // 綁定設定視窗的互動事件，讓 createSettingsModal() 聚焦在 DOM 建立。
  function bindSettingsModalEventHandlers(overlay, settingsRefs) {
    if (!overlay || !settingsRefs) return;

    overlay.querySelector("#fbgr-settings-cancel")?.addEventListener("click", closeSettingsModal);
    settingsRefs.jitterEnabledEl.addEventListener("change", renderSettingsMode);
    overlay.querySelector("#fbgr-ntfy-help")?.addEventListener("click", () => openHelpModal("ntfy"));
    overlay.querySelector("#fbgr-discord-help")?.addEventListener("click", () => openHelpModal("discord"));
    overlay.querySelector("#fbgr-settings-test")?.addEventListener("click", () => {
      handleSettingsTestNotification(settingsRefs);
    });
    overlay.querySelector("#fbgr-settings-save")?.addEventListener("click", () => {
      handleSettingsSave(settingsRefs);
    });
  }

  // 建立設定視窗的固定外層 HTML。
  function renderSettingsModalShellHtml() {
    return `
      <div style="max-width:520px;margin:40px auto 0 auto;background:#111827;color:#f9fafb;border:1px solid #4b5563;border-radius:14px;padding:16px;box-shadow:0 18px 40px rgba(0,0,0,0.4);font-family:Consolas, 'Courier New', monospace;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:14px;">
          <div style="font-size:16px;font-weight:bold;">設定</div>
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
  }

  // 建立設定視窗，集中管理 refresh、load more、ntfy 與 Discord Webhook。
  function createSettingsModal() {
    if (document.getElementById("fbgr-settings-modal")) return;

    const overlay = createOverlayElement({
      id: "fbgr-settings-modal",
      zIndex: 2147483645,
      innerHtml: renderSettingsModalShellHtml(),
    });
    const settingsRefs = getSettingsModalElementRefs(overlay);
    bindSettingsModalEventHandlers(overlay, settingsRefs);
  }

  // 依 jitter 是否啟用，切換固定刷新 / 範圍刷新欄位顯示。
  function renderSettingsMode() {
    const overlay = document.getElementById("fbgr-settings-modal");
    const settingsRefs = getSettingsModalElementRefs(overlay);
    if (!settingsRefs) return;

    const jitterEnabled = settingsRefs.jitterEnabledEl.checked;
    settingsRefs.jitterWrapEl.style.display = jitterEnabled ? "grid" : "none";
    settingsRefs.fixedWrapEl.style.display = jitterEnabled ? "none" : "grid";
  }

  // 將目前設定灌入設定視窗並顯示。
  function openSettingsModal() {
    createSettingsModal();
    const overlay = document.getElementById("fbgr-settings-modal");
    const settingsRefs = getSettingsModalElementRefs(overlay);
    if (!settingsRefs) return;

    applyNotificationConfigPatch({
      ntfyTopic: getPersistedNtfyTopic(),
      discordWebhook: getPersistedDiscordWebhook(),
    });
    populateSettingsModalFields(settingsRefs);
    renderSettingsMode();
    setOverlayVisibility(settingsRefs.overlay, true);
  }

  // 關閉設定視窗。
  function closeSettingsModal() {
    hideOverlayById("fbgr-settings-modal");
  }

  // UI: 主控制面板建立與互動事件綁定。
  // 使用者在面板輸入時，先更新記憶體中的草稿設定，不立刻寫入持久化儲存。
  function persistDraftInputs() {
    const panel = document.getElementById("fb-group-refresh-panel");
    if (!panel) return;

    const includeEl = panel.querySelector("#fbgr-include");
    const excludeEl = panel.querySelector("#fbgr-exclude");
    if (!includeEl || !excludeEl) return;

    applyKeywordConfigPatch({
      includeKeywords: normalizeText(includeEl.value),
      excludeKeywords: normalizeText(excludeEl.value),
    });
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
    const savedKeywordConfig = loadPersistedConfigGroup("keyword");

    return (
      currentInclude !== savedKeywordConfig.includeKeywords ||
      currentExclude !== savedKeywordConfig.excludeKeywords
    );
  }

  // 將主面板目前輸入的 include / exclude 草稿寫回設定與 storage。
  function savePanelKeywordSettings(panelRefs) {
    if (!panelRefs) return;

    applyKeywordConfigPatch(
      {
      includeKeywords: normalizeText(panelRefs.includeEl.value),
      excludeKeywords: normalizeText(panelRefs.excludeEl.value),
      },
      { persist: true }
    );
  }

  // 處理主面板上的「儲存」按鈕。
  function handlePanelSave(panelRefs) {
    savePanelKeywordSettings(panelRefs);
    requestPanelRender();
    runScan("save");
  }

  // 依目前 paused 狀態決定主面板監控按鈕的動作語義。
  function getMonitoringControlAction(isPaused) {
    return isPaused ? "restart" : "pause";
  }

  // 保留舊名稱給 smoke test 與既有呼叫端，實際語義已轉成 monitoring control。
  function getPauseToggleAction(isPaused) {
    return getMonitoringControlAction(isPaused);
  }

  // 將 monitoring action 轉成面板按鈕文字；UI 只維持「開始 / 暫停」兩種顯示。
  function getMonitoringControlLabel(action) {
    if (action === "restart") {
      return "開始";
    }

    return "暫停";
  }

  // 將 paused 狀態寫回執行期與持久化設定。
  function setPausedState(paused) {
    applyMonitoringConfigPatch({ paused }, { persist: true });
  }

  // 停止監控計時器，保留目前畫面與已看過貼文基準。
  function pauseMonitoring() {
    setPausedState(true);
    clearMonitoringScheduleTimers();
  }

  // 恢復監控排程，不重置目前群組的 seen 基準。
  function resumeMonitoring(reason = "manual-start") {
    setPausedState(false);
    scheduleRefresh();
    scheduleScan(reason);
  }

  // 清掉目前群組的 seen baseline；若目前不在群組頁則直接略過。
  function resetSeenBaselineForCurrentGroup() {
    const groupId = getCurrentGroupId();
    if (!groupId) return false;

    clearSeenPostsForGroup(groupId);
    return true;
  }

  // 重新開始目前群組監控，會先清掉該群組的 seen 基準再立即重掃。
  function restartMonitoringForCurrentGroup(reason = "manual-start") {
    resetSeenBaselineForCurrentGroup();
    resumeMonitoring(reason);
  }

  // 統一處理 panel 觸發的 monitoring action，集中 pause / restart 的收尾。
  function performPanelMonitoringAction(action, reason = "manual-start") {
    if (action === "pause") {
      pauseMonitoring();
    } else if (action === "restart") {
      restartMonitoringForCurrentGroup(reason);
    }

    requestPanelRender();
  }

  // 處理主面板上的「開始 / 暫停」切換。
  function handlePanelPauseToggle() {
    performPanelMonitoringAction(getMonitoringControlAction(STATE.config.paused), "manual-start");
  }

  // 處理主面板上的除錯區塊開關。
  function handlePanelDebugToggle() {
    applyUiConfigPatch({ debugVisible: !STATE.config.debugVisible }, { persist: true });
    requestPanelRender();
  }

  // 取得目前 panel 的 viewport / 尺寸資訊，供拖曳邊界與重掛校正共用。
  function getPanelPositionMetrics(panel) {
    const rect = panel?.getBoundingClientRect?.() || {};
    return {
      width: Math.round(rect.width || panel?.offsetWidth || PANEL_LAYOUT.defaultWidth),
      height: Math.round(rect.height || panel?.offsetHeight || 0),
      viewportWidth: window.innerWidth || document.documentElement?.clientWidth || PANEL_LAYOUT.defaultWidth,
      viewportHeight: window.innerHeight || document.documentElement?.clientHeight || 0,
    };
  }

  // 將目前 panel 位置套到 DOM；未持久化時維持右上角預設定位。
  function applyPanelPositionToElement(panel, panelPosition = STATE.uiRuntime.panelPosition) {
    if (!(panel instanceof HTMLElement)) return null;

    panel.style.bottom = "auto";
    panel.style.top = `${PANEL_LAYOUT.defaultTop}px`;

    if (!panelPosition) {
      panel.style.left = "auto";
      panel.style.right = `${PANEL_LAYOUT.defaultRight}px`;
      return null;
    }

    const clampedPosition = clampPanelPosition(panelPosition, getPanelPositionMetrics(panel));
    if (!clampedPosition) return null;

    panel.style.top = `${clampedPosition.top}px`;
    panel.style.left = `${clampedPosition.left}px`;
    panel.style.right = "auto";
    return clampedPosition;
  }

  // 若 viewport 改變導致 panel 超出邊界，將目前位置夾回畫面內並同步持久化。
  function syncPanelPositionWithinViewport(panel) {
    if (!(panel instanceof HTMLElement) || !STATE.uiRuntime.panelPosition) return;

    const clampedPosition = applyPanelPositionToElement(panel, STATE.uiRuntime.panelPosition);
    if (
      !clampedPosition ||
      (clampedPosition.top === STATE.uiRuntime.panelPosition.top &&
        clampedPosition.left === STATE.uiRuntime.panelPosition.left)
    ) {
      return;
    }

    setPanelPositionState(clampedPosition, { persist: true });
  }

  // 在拖曳開始時建立 panelDrag runtime，統一起點資料。
  function startPanelDrag(event, panel) {
    const rect = panel.getBoundingClientRect();
    const startLeft = Number.isFinite(STATE.uiRuntime.panelPosition?.left)
      ? STATE.uiRuntime.panelPosition.left
      : Math.round(rect.left);
    const startTop = Number.isFinite(STATE.uiRuntime.panelPosition?.top)
      ? STATE.uiRuntime.panelPosition.top
      : Math.round(rect.top);

    setPanelDragState({
      active: true,
      pointerId: event.pointerId,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startTop,
      startLeft,
    });
  }

  // 依目前 pointer 位置更新 panel DOM 與 ui runtime 定位。
  function updatePanelDragPosition(event, panel) {
    const nextPosition = buildDraggedPanelPosition(
      STATE.uiRuntime.panelDrag,
      event,
      getPanelPositionMetrics(panel)
    );
    if (!nextPosition) return;

    setPanelPositionState(nextPosition);
    applyPanelPositionToElement(panel, nextPosition);
  }

  // 結束 panel 拖曳並將目前位置持久化。
  function finishPanelDrag() {
    if (STATE.uiRuntime.panelPosition) {
      setPanelPositionState(STATE.uiRuntime.panelPosition, { persist: true });
    }
    setPanelDragState(null);
  }

  // 綁定主面板標題列拖曳，避免把拖曳事件散落到 render / createPanel 之外。
  function bindPanelDragHandlers(panel, panelRefs) {
    const dragHandleEl = panelRefs?.dragHandleEl;
    if (!dragHandleEl) return;

    dragHandleEl.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest("button, input, textarea, a")) {
        return;
      }

      event.preventDefault();
      startPanelDrag(event, panel);

      const onPointerMove = (moveEvent) => {
        if (!STATE.uiRuntime.panelDrag.active) return;
        if (
          STATE.uiRuntime.panelDrag.pointerId != null &&
          moveEvent.pointerId !== STATE.uiRuntime.panelDrag.pointerId
        ) {
          return;
        }

        updatePanelDragPosition(moveEvent, panel);
      };
      const onPointerEnd = (endEvent) => {
        if (
          STATE.uiRuntime.panelDrag.pointerId != null &&
          endEvent.pointerId !== STATE.uiRuntime.panelDrag.pointerId
        ) {
          return;
        }

        finishPanelDrag();
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerEnd);
        window.removeEventListener("pointercancel", onPointerEnd);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerEnd);
      window.addEventListener("pointercancel", onPointerEnd);
    });
  }

  // 綁定主面板上的互動事件，讓 createPanel() 保持在殼層。
  function bindPanelEventHandlers(panel) {
    const panelRefs = getPanelElementRefs(panel);
    if (!panelRefs) return;

    panelRefs.includeEl.addEventListener("input", persistDraftInputs);
    panelRefs.excludeEl.addEventListener("input", persistDraftInputs);
    panel.querySelector("#fbgr-include-help").addEventListener("click", () => openHelpModal("include"));
    panel.querySelector("#fbgr-history").addEventListener("click", openHistoryModal);
    panel.querySelector("#fbgr-settings").addEventListener("click", openSettingsModal);
    panel.querySelector("#fbgr-save").addEventListener("click", () => {
      handlePanelSave(panelRefs);
    });
    panelRefs.pauseEl.addEventListener("click", handlePanelPauseToggle);
    panel.querySelector("#fbgr-debug-toggle").addEventListener("click", handlePanelDebugToggle);
  }

  // 主面板建立時順便預熱相關 modal，讓後續互動不需要各自補建。
  function ensurePanelRelatedModalsCreated() {
    createSettingsModal();
    createHistoryModal();
    createAllHelpModals();
  }

  // 建立主面板的固定外層 HTML。
  function renderPanelShellHtml() {
    return `
      <div id="fbgr-panel-drag-handle" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;cursor:move;user-select:none;touch-action:none;">
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
  }

  // 建立右上角主控制面板，並綁定所有主要互動事件。
  function createPanel() {
    const existingPanel = getPanelElement();
    if (existingPanel) {
      setPanelMountedState(true);
      return existingPanel;
    }

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

    panel.innerHTML = renderPanelShellHtml();

    document.body.appendChild(panel);
    applyPanelPositionToElement(panel);
    ensurePanelRelatedModalsCreated();
    bindPanelEventHandlers(panel);
    bindPanelDragHandlers(panel, getPanelElementRefs(panel));

    setPanelMountedState(true);
    requestPanelRender();
    return panel;
  }

  // 將下一次 refresh 倒數格式化成面板文字。
  function formatRefreshStatus() {
    if (!STATE.schedulerRuntime.refreshDeadline) return "未排程";
    const remainSec = Math.max(0, Math.ceil((STATE.schedulerRuntime.refreshDeadline - Date.now()) / 1000));
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

  // 批次渲染多列雙欄位欄位，讓 status / history 一類區塊少掉重複 join 邏輯。
  function renderHistoryFieldRows(rows) {
    return rows.map((row) => {
      return renderHistoryFieldRow(row.label, row.value, row.options);
    }).join("");
  }

  // 將 debug 摘要列渲染成單行文字，預設會先 escape 值。
  function renderDebugTextRow(label, value, options = {}) {
    const { escapeValue = true } = options;
    const renderedValue = escapeValue ? escapeHtml(value) : String(value || "");
    return `<div>${escapeHtml(label)}: ${renderedValue}</div>`;
  }

  // 批次渲染 debug 摘要列。
  function renderDebugTextRows(rows) {
    return rows.map((row) => {
      return renderDebugTextRow(row.label, row.value, {
        escapeValue: row.escapeValue,
      });
    }).join("");
  }

  // 建立主面板狀態摘要列，讓 view-state 與模板字串之間多一層穩定接口。
  function buildPanelStatusRows(viewState) {
    return [
      { label: "狀態", value: viewState.statusLabel },
      { label: "社團", value: escapeHtml(viewState.groupName) },
      {
        label: "貼文排序",
        value: `<span style="color:${viewState.feedSortColor};">${escapeHtml(viewState.feedSortDisplay)}</span>`,
      },
      { label: "目標貼文", value: viewState.targetPostCountLabel },
      { label: "刷新模式", value: escapeHtml(viewState.refreshModeLabel) },
      { label: "下次刷新", value: escapeHtml(viewState.refreshStatusLabel) },
      { label: "停止原因", value: escapeHtml(viewState.stopReasonLabel) },
    ];
  }

  // 建立 debug 摘要列，集中所有欄位順序與 escape 規則。
  function buildPanelDebugSummaryRows(viewState) {
    return [
      { label: "網址", value: viewState.currentUrlLabel },
      { label: "包含", value: viewState.includeKeywordsLabel },
      { label: "排除", value: viewState.excludeKeywordsLabel },
      { label: "掃描原因", value: viewState.reasonLabel },
      { label: "首次掃描", value: viewState.baselineModeLabel, escapeValue: false },
      { label: "目標貼文數", value: viewState.targetPostCountLabel, escapeValue: false },
      { label: "自動載入方式", value: viewState.loadMoreModeLabel },
      { label: "最上方快篩", value: viewState.topPostShortcutLabel },
      { label: "自動載入嘗試", value: viewState.loadMoreAttemptedLabel, escapeValue: false },
      { label: "安全掃描上限", value: `${viewState.maxWindowCountLabel} 輪`, escapeValue: false },
      { label: "視窗掃描次數", value: viewState.loadMoreWindowCountLabel, escapeValue: false },
      { label: "停止原因", value: viewState.stopReasonLabel },
      { label: "本輪最上方貼文 key", value: viewState.topPostKeyLabel },
      { label: "上一輪最上方貼文 key", value: viewState.previousTopPostKeyLabel },
      { label: "貼文數變化", value: viewState.loadMoreCountDeltaLabel, escapeValue: false },
      { label: "累積候選容器次數", value: viewState.candidateCountLabel, escapeValue: false },
      { label: "實際解析次數", value: viewState.freshExtractCountLabel, escapeValue: false },
      { label: "快取命中次數", value: viewState.cacheHitCountLabel, escapeValue: false },
      { label: "累積有效貼文次數", value: viewState.parsedCountLabel, escapeValue: false },
      { label: "累積唯一貼文數", value: viewState.accumulatedCountLabel, escapeValue: false },
      { label: "排除控制列數", value: viewState.filteredFeedSortControlCountLabel, escapeValue: false },
      { label: "排除非貼文數", value: viewState.filteredNonPostCountLabel, escapeValue: false },
      { label: "排除空白內容數", value: viewState.filteredEmptyTextCountLabel, escapeValue: false },
      { label: "最終去重後貼文數", value: viewState.scannedCountLabel, escapeValue: false },
      { label: "最後通知狀態", value: viewState.latestNotificationStatusLabel },
      { label: "錯誤", value: viewState.latestErrorLabel },
    ];
  }

  // 將單筆貼文整理成主面板摘要列需要的 view state。
  function buildPanelPostListEntryViewState(post, index) {
    return {
      indexLabel: `${index + 1}.`,
      authorLabel: post.author || "(作者未知)",
      matched: Boolean(post.eligible),
    };
  }

  // 將主面板貼文摘要區需要的資料整理成固定結構。
  function buildPanelPostListViewState(posts) {
    const entries = posts.map((post, index) => {
      return buildPanelPostListEntryViewState(post, index);
    });

    return {
      count: entries.length,
      empty: entries.length === 0,
      entries,
    };
  }

  // 將單筆貼文明細整理成 debug 區塊需要的 view state。
  function buildPanelDebugPostViewState(post, index) {
    return {
      indexLabel: `#${index + 1}`,
      sourceLabel: post.source || "(無)",
      postIdLabel: post.postId || "(無)",
      authorLabel: post.author || "(無)",
      timestampLabel: post.timestampText || "(無)",
      containerRoleLabel: post.containerRole || "(無)",
      textSourceLabel: post.textSource || "(無)",
      hasPostIdLabel: post.postId ? "是" : "否",
      includeRuleLabel: post.includeRule || "(無)",
      excludeRuleLabel: post.excludeRule || "(無)",
      eligibilityLabel: post.eligible ? "是" : "否",
      seenLabel: post.seen ? "是" : "否",
      textLabel: truncate(post.text, 180) || "(空白)",
    };
  }

  // 將 debug 貼文列表整理成固定的 view state。
  function buildPanelDebugPostRowsViewState(posts) {
    const entries = posts.map((post, index) => {
      return buildPanelDebugPostViewState(post, index);
    });

    return {
      empty: entries.length === 0,
      entries,
    };
  }

  // 將 latestScan 轉成 panel/debug 共用的摘要欄位。
  function buildLatestScanViewState(latestScan) {
    return {
      reasonLabel: latestScan?.reason || "(無)",
      baselineModeLabel: latestScan?.baselineMode ? "是" : "否",
      targetPostCountLabel: String(latestScan?.targetCount ?? STATE.config.maxPostsPerScan),
      loadMoreModeLabel: latestScan?.loadMoreMode || getLoadMoreMode(),
      topPostShortcutLabel: latestScan?.topPostShortcutUsed
        ? (latestScan?.topPostShortcutMatched ? "命中，已跳過深度掃描" : "已檢查，需完整掃描")
        : "未啟用",
      loadMoreAttemptedLabel: latestScan?.loadMoreAttempted
        ? `${latestScan?.loadMoreAttempts || 0} 次`
        : "未執行",
      maxWindowCountLabel: String(latestScan?.maxWindowCount ?? 0),
      loadMoreWindowCountLabel: String(latestScan?.loadMoreWindowCount ?? 0),
      stopReasonLabel: latestScan?.stopReason || "(無)",
      topPostKeyLabel: latestScan?.topPostKey || "(無)",
      previousTopPostKeyLabel: latestScan?.previousTopPostKey || "(無)",
      loadMoreCountDeltaLabel: `${latestScan?.loadMoreBeforeCount ?? 0} -> ${latestScan?.loadMoreAfterCount ?? 0}`,
      candidateCountLabel: String(latestScan?.candidateCount ?? 0),
      freshExtractCountLabel: String(latestScan?.freshExtractCount ?? 0),
      cacheHitCountLabel: String(latestScan?.cacheHitCount ?? 0),
      parsedCountLabel: String(latestScan?.parsedCount ?? 0),
      accumulatedCountLabel: String(latestScan?.accumulatedCount ?? latestScan?.scannedCount ?? 0),
      filteredFeedSortControlCountLabel: String(latestScan?.filteredFeedSortControlCount ?? 0),
      filteredNonPostCountLabel: String(latestScan?.filteredNonPostCount ?? 0),
      filteredEmptyTextCountLabel: String(latestScan?.filteredEmptyTextCount ?? 0),
      scannedCountLabel: String(latestScan?.scannedCount ?? 0),
    };
  }

  // 建立主面板狀態區需要的 view model。
  function getPanelStatusViewState({ latestScan, latestPosts, groupName, feedSortLabel }) {
    const isPreferredFeedSort = feedSortLabel === "新貼文";
    const latestScanViewState = buildLatestScanViewState(latestScan);

    return {
      postList: buildPanelPostListViewState(latestPosts),
      groupName,
      statusLabel: STATE.config.paused ? "已暫停" : "監控中",
      feedSortColor: isPreferredFeedSort ? "#f9fafb" : "#fbbf24",
      feedSortDisplay: isPreferredFeedSort
        ? feedSortLabel
        : `${feedSortLabel}（建議調成新貼文）`,
      targetPostCountLabel: `${STATE.config.maxPostsPerScan} 篇`,
      refreshModeLabel: formatRefreshModeLabel(),
      refreshStatusLabel: formatRefreshStatus(),
      stopReasonLabel: latestScanViewState.stopReasonLabel,
    };
  }

  // 建立 debug 區塊需要的 view model，集中所有 fallback 與顯示文字。
  function getPanelDebugViewState({ latestScan, latestPosts, latestError, latestNotification }) {
    const latestScanViewState = buildLatestScanViewState(latestScan);

    return {
      postRows: buildPanelDebugPostRowsViewState(latestPosts),
      currentUrlLabel: location.href,
      includeKeywordsLabel: STATE.config.includeKeywords || "(空白)",
      excludeKeywordsLabel: STATE.config.excludeKeywords || "(空白)",
      ...latestScanViewState,
      latestNotificationStatusLabel: getLatestNotificationStatusLabel(latestNotification),
      latestErrorLabel: latestError || "(無)",
    };
  }

  // 建立主面板渲染所需的 view state，避免 render 階段直接散讀 STATE 與 DOM。
  function getPanelViewState(runtimeSnapshot = buildPanelRuntimeSnapshot()) {
    const { latestScan, latestPosts, latestError, latestNotification } = runtimeSnapshot;
    const groupName = getCurrentGroupName() || "無法判斷";
    const feedSortLabel = getCurrentFeedSortLabel() || "無法判斷";

    return {
      pauseButtonLabel: getMonitoringControlLabel(getMonitoringControlAction(STATE.config.paused)),
      unsavedKeywordChanges: hasUnsavedKeywordChanges(),
      debugVisible: STATE.config.debugVisible,
      status: getPanelStatusViewState({
        latestScan,
        latestPosts,
        groupName,
        feedSortLabel,
      }),
      debug: getPanelDebugViewState({
        latestScan,
        latestPosts,
        latestError,
        latestNotification,
      }),
    };
  }

  // 集中查找主面板內會重複使用的 DOM 節點。
  function getPanelElementRefs(panel) {
    if (!panel) return null;

    const refs = {
      panel,
      includeEl: panel.querySelector("#fbgr-include"),
      excludeEl: panel.querySelector("#fbgr-exclude"),
      pauseEl: panel.querySelector("#fbgr-pause"),
      statusEl: panel.querySelector("#fbgr-status"),
      debugEl: panel.querySelector("#fbgr-debug"),
      unsavedEl: panel.querySelector("#fbgr-unsaved-indicator"),
      dragHandleEl: panel.querySelector("#fbgr-panel-drag-handle"),
    };

    if (
      !refs.includeEl ||
      !refs.excludeEl ||
      !refs.pauseEl ||
      !refs.statusEl ||
      !refs.debugEl ||
      !refs.dragHandleEl
    ) {
      return null;
    }

    return refs;
  }

  // 將 keyword 輸入框同步到目前 state，但保留使用者正在輸入的欄位。
  function syncPanelKeywordInputs(panelRefs) {
    if (!panelRefs) return;

    if (panelRefs.includeEl !== document.activeElement) {
      panelRefs.includeEl.value = STATE.config.includeKeywords;
    }
    if (panelRefs.excludeEl !== document.activeElement) {
      panelRefs.excludeEl.value = STATE.config.excludeKeywords;
    }
  }

  // 更新主面板上方的控制按鈕與未儲存提示。
  function updatePanelControls(panelRefs, viewState) {
    if (!panelRefs || !viewState) return;

    panelRefs.pauseEl.textContent = viewState.pauseButtonLabel;
    if (panelRefs.unsavedEl) {
      panelRefs.unsavedEl.style.display = viewState.unsavedKeywordChanges ? "inline" : "none";
    }
  }

  // 更新主面板狀態摘要區塊。
  function updatePanelStatusSection(panelRefs, viewState) {
    if (!panelRefs || !viewState) return;

    panelRefs.statusEl.innerHTML = renderPanelStatusHtml(viewState.status);
  }

  // 更新 debug 區塊的顯示與內容。
  function updatePanelDebugSection(panelRefs, viewState) {
    if (!panelRefs || !viewState) return;

    panelRefs.debugEl.style.display = viewState.debugVisible ? "block" : "none";
    if (!viewState.debugVisible) {
      return;
    }

    panelRefs.debugEl.innerHTML = renderPanelDebugHtml(viewState.debug);
    bindDebugCopyButton(panelRefs.debugEl);
  }

  // 渲染主面板中的貼文摘要區塊。
  function renderPanelPostListHtml(viewState) {
    if (viewState.empty) {
      return `
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);">
          <div>尚未獲取貼文</div>
        </div>
      `;
    }

    return `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);">
        <div style="margin-bottom:6px;">已獲取 ${viewState.count} 篇貼文：</div>
        ${viewState.entries.map((entry) => renderPanelPostListEntryHtml(entry)).join("")}
        <div style="margin-top:8px;font-size:12px;color:#9ca3af;">詳細內容請至「查看紀錄」查看</div>
      </div>
    `;
  }

  // 渲染主面板中的單筆貼文摘要列。
  function renderPanelPostListEntryHtml(viewState) {
    const authorLabel = escapeHtml(viewState.authorLabel);
    const matchedLabel = viewState.matched
      ? ' <span style="color:#fbbf24;">[符合]</span>'
      : "";
    return `<div>${escapeHtml(viewState.indexLabel)} ${authorLabel}${matchedLabel}</div>`;
  }

  // 渲染主面板狀態區的 HTML。
  function renderPanelStatusHtml(viewState) {
    return [
      renderHistoryFieldRows(buildPanelStatusRows(viewState)),
      renderPanelPostListHtml(viewState.postList),
    ].join("");
  }

  // 渲染 debug 區中的貼文列表。
  function renderPanelDebugPostRowsHtml(viewState) {
    if (viewState.empty) {
      return "<div>目前還沒有抽到貼文。</div>";
    }

    return viewState.entries.map((entry) => {
      return renderPanelDebugPostRowHtml(entry);
    }).join("");
  }

  // 渲染 debug 區中的單筆貼文明細。
  function renderPanelDebugPostRowHtml(viewState) {
    return `
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);">
        <div>${escapeHtml(viewState.indexLabel)} 來源=${escapeHtml(viewState.sourceLabel)}</div>
        <div>貼文ID=${escapeHtml(viewState.postIdLabel)}</div>
        <div>作者=${escapeHtml(viewState.authorLabel)}</div>
        <div>時間=${escapeHtml(viewState.timestampLabel)}</div>
        <div>容器=${escapeHtml(viewState.containerRoleLabel)} | 文字來源=${escapeHtml(viewState.textSourceLabel)}</div>
        <div>有貼文ID=${viewState.hasPostIdLabel}</div>
        <div>命中包含=${escapeHtml(viewState.includeRuleLabel)}</div>
        <div>命中排除=${escapeHtml(viewState.excludeRuleLabel)}</div>
        <div>可通知=${viewState.eligibilityLabel} | 已看過=${viewState.seenLabel}</div>
        <div>文字=${escapeHtml(viewState.textLabel)}</div>
      </div>
    `;
  }

  // 渲染 debug 區塊的 HTML。
  function renderPanelDebugHtml(viewState) {
    const postRows = renderPanelDebugPostRowsHtml(viewState.postRows);
    const summaryRows = renderDebugTextRows(buildPanelDebugSummaryRows(viewState));

    return `
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
        <button id="fbgr-debug-copy" type="button" style="padding:4px 8px;cursor:pointer;">複製</button>
      </div>
      <div id="fbgr-debug-content">
        ${summaryRows}
        ${postRows}
      </div>
    `;
  }

  // 綁定 debug 複製按鈕，避免 renderPanel() 本體再處理細節。
  function bindDebugCopyButton(debugEl) {
    const copyButton = debugEl.querySelector("#fbgr-debug-copy");
    const debugContent = debugEl.querySelector("#fbgr-debug-content");
    if (!copyButton || !debugContent) return;

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

  // UI: 主面板與 debug 區塊渲染。
  // 依 STATE 重新渲染主面板狀態、貼文摘要與 debug 資訊。
  function renderPanel() {
    if (!document.body) return;
    if (!getPanelElement()) createPanel();

    const panel = getPanelElement();
    if (!panel) return;
    const panelRefs = getPanelElementRefs(panel);
    if (!panelRefs) return;

    syncPanelPositionWithinViewport(panel);
    syncPanelKeywordInputs(panelRefs);
    const viewState = getPanelViewState(buildPanelRuntimeSnapshot());
    updatePanelControls(panelRefs, viewState);
    updatePanelStatusSection(panelRefs, viewState);
    updatePanelDebugSection(panelRefs, viewState);
  }

  // ==========================================================================
  // Lifecycle / Observer
  // ==========================================================================

  // 監聽 Facebook 動態 DOM / route 變化並維持腳本生命週期。
  // 重新安裝 MutationObserver，當動態牆新增節點時觸發下一輪掃描。
  function installObserver() {
    disconnectFeedObserver();

    const root = findFeedRoot();
    if (!root) return;

    const observer = new MutationObserver((mutations) => {
      const addedNodes = mutations.some((mutation) => mutation.addedNodes && mutation.addedNodes.length > 0);
      if (addedNodes) {
        scheduleScan("mutation");
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
    });
    setFeedObserverState(observer);
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
    return getLoadMoreMode() === "wheel" ? "模擬滑鼠滾輪" : "溫和捲動";
  }

  // route 切換時重置與本輪掃描結果相關的執行期狀態。
  function resetRouteScanState() {
    applyScanRuntimeState(buildResetScanRuntimeState());
  }

  // 封裝 route 變更後的共同行為，集中處理 refresh / observer / scan / render。
  function handleRouteTransition() {
    resetRouteScanState();
    clearRefreshTimer();
    reinstallObserverAndScheduleScan("route-change");
    requestPanelRender();
  }

  // 主面板若被 Facebook SPA 重新掛載吃掉，補回 panel 並重繪。
  function ensurePanelMountedAndRender() {
    if (!getPanelElement()) {
      setPanelMountedState(false);
      createPanel();
      return;
    }

    if (!STATE.uiRuntime.panelMounted) {
      setPanelMountedState(true);
    }

    requestPanelRender();
  }

  // 將目前 URL 與群組資訊同步到 route state，供後續判斷 settle / route-change 使用。
  function syncCurrentRouteState() {
    setRouteRuntimePatch({
      lastUrl: location.href,
      lastRouteChangeAt: Date.now(),
      lastRouteGroupId: getCurrentGroupId(),
    });
  }

  // 啟動腳本後的初始 panel / observer / refresh 流程。
  function bootstrapAppRuntime() {
    createPanel();
    reinstallObserverAndScheduleScan("startup");
    scheduleRefresh();
  }

  // 啟動週期性維護計時器，持續監看 route 與 panel 是否被重掛。
  function startMaintenanceLoops() {
    clearMaintenanceLoops();
    setMaintenanceLoopState(
      window.setInterval(handleRouteChange, 1000),
      window.setInterval(ensurePanelMountedAndRender, 1000)
    );
  }

  // 監聽 Facebook SPA 路由變化，切頁時重設狀態並重新安排掃描。
  function handleRouteChange() {
    if (STATE.routeRuntime.lastUrl === location.href) return;

    syncCurrentRouteState();
    handleRouteTransition();
  }

  // 腳本主入口：建立 UI、安裝 observer、安排掃描與刷新、啟動週期性維護。
  function start() {
    bootstrapAppRuntime();
    startMaintenanceLoops();
  }

  // 測試模式只暴露穩定純邏輯，不啟動實際 userscript 生命週期。
  function exposeTestHooks() {
    globalThis.__FB_GROUP_REFRESH_TEST_HOOKS__ = {
      normalizeText,
      normalizeForMatch,
      getMonitoringControlAction,
      getPauseToggleAction,
      getMonitoringControlLabel,
      buildKeywordConfigPatch,
      buildRefreshConfigPatch,
      buildRefreshSettingsPayloadFromConfig,
      buildNotificationConfigPatch,
      buildMonitoringConfigPatch,
      buildUiConfigPatch,
      getLoadMoreMode,
      normalizePanelPosition,
      getPanelPositionBounds,
      clampPanelPosition,
      buildDraggedPanelPosition,
      parseKeywordInput,
      matchRules,
      shouldUseTopPostShortcut,
      createSeenPostStopState,
      applySeenPostStopObservation,
      buildPostKeyFragments,
      buildCompositePostKey,
      getPostKey,
      collectUniquePostsByKey,
      dedupeExtractedPosts,
      trimSeenPostGroupStore,
      mergeMatchHistoryEntries,
      getNotificationFields,
      buildCompactNotificationSegments,
      buildCompactNotificationBody,
      buildRemoteNotificationLines,
      buildRemoteNotificationBody,
      buildFailedScanRuntimeState,
      buildCompletedNotificationState,
      getLatestNotificationStatusLabel,
    };
  }

  if (globalThis.__FB_GROUP_REFRESH_TEST_MODE__) {
    exposeTestHooks();
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
