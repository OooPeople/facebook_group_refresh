// ==UserScript==
// @name         Facebook Group Refresh Monitor
// @namespace    http://tampermonkey.net/
// @version      2026-04-01
// @description  Monitor Facebook group posts for keyword matches and notify on new posts.
// @author       Codex
// @match        https://www.facebook.com/groups/*
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      ntfy.sh
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  if (window.__FB_GROUP_REFRESH_RUNNING__) return;
  window.__FB_GROUP_REFRESH_RUNNING__ = true;

  const STORAGE_KEYS = {
    include: "fb_group_refresh_include",
    exclude: "fb_group_refresh_exclude",
    paused: "fb_group_refresh_paused",
    debugVisible: "fb_group_refresh_debug_visible",
    ntfyTopic: "fb_group_refresh_ntfy_topic",
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
    maxPostsPerScan: 5,
    scanDebounceMs: 1500,
    minRefreshSec: 25,
    maxRefreshSec: 35,
    jitterEnabled: true,
    fixedRefreshSec: 60,
    autoLoadMorePosts: true,
    loadMoreMode: "scroll",
    seenPostLimitPerGroup: 5,
    matchHistoryLimitPerGroup: 10,
    enableGmNotification: true,
    enableBrowserNotification: false,
  };

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
    panelMounted: false,
    isLoadingMorePosts: false,
  };

  function loadConfig() {
    const refreshRange = loadJson(STORAGE_KEYS.refreshRange, null);
    return {
      ...DEFAULT_CONFIG,
      includeKeywords: loadString(STORAGE_KEYS.include, DEFAULT_CONFIG.includeKeywords),
      excludeKeywords: loadString(STORAGE_KEYS.exclude, DEFAULT_CONFIG.excludeKeywords),
      ntfyTopic: loadString(STORAGE_KEYS.ntfyTopic, DEFAULT_CONFIG.ntfyTopic),
      paused: loadBoolean(STORAGE_KEYS.paused, DEFAULT_CONFIG.paused),
      debugVisible: loadBoolean(STORAGE_KEYS.debugVisible, DEFAULT_CONFIG.debugVisible),
      minRefreshSec: refreshRange?.min ?? DEFAULT_CONFIG.minRefreshSec,
      maxRefreshSec: refreshRange?.max ?? DEFAULT_CONFIG.maxRefreshSec,
      jitterEnabled: refreshRange?.jitterEnabled ?? DEFAULT_CONFIG.jitterEnabled,
      fixedRefreshSec: refreshRange?.fixedSec ?? DEFAULT_CONFIG.fixedRefreshSec,
      maxPostsPerScan: refreshRange?.maxPostsPerScan ?? DEFAULT_CONFIG.maxPostsPerScan,
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
      maxPostsPerScan: STATE.config.maxPostsPerScan,
      autoLoadMorePosts: STATE.config.autoLoadMorePosts,
    });
    saveNtfyTopicSetting(STATE.config.ntfyTopic);
    saveString(STORAGE_KEYS.autoLoadMorePosts, String(STATE.config.autoLoadMorePosts));
  }

  function loadString(key, fallback) {
    try {
      const value = loadStoredRawValue(key);
      return value == null ? fallback : String(value);
    } catch (error) {
      return fallback;
    }
  }

  function loadBoolean(key, fallback) {
    try {
      const raw = loadStoredRawValue(key);
      if (raw == null) return fallback;
      return raw === "true";
    } catch (error) {
      return fallback;
    }
  }

  function loadJson(key, fallback) {
    try {
      const raw = loadStoredRawValue(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function saveString(key, value) {
    saveStoredRawValue(key, String(value));
  }

  function saveJson(key, value) {
    saveStoredRawValue(key, JSON.stringify(value));
  }

  function removeStorageKey(key) {
    removeStoredRawValue(key);
  }

  function hasGmStorage() {
    return (
      typeof GM_getValue === "function" &&
      typeof GM_setValue === "function" &&
      typeof GM_deleteValue === "function"
    );
  }

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

  function loadGmRawValue(key) {
    if (!hasGmStorage()) return null;

    try {
      const value = GM_getValue(key, null);
      return value == null ? null : String(value);
    } catch (error) {
      return null;
    }
  }

  function loadLegacyLocalStorageValue(key) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? null : String(value);
    } catch (error) {
      return null;
    }
  }

  function saveLegacyLocalStorageValue(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (error) {
      // Ignore legacy storage write errors.
    }
  }

  function removeLegacyLocalStorageValue(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // Ignore legacy storage cleanup errors.
    }
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeForMatch(value) {
    return normalizeText(value).toLowerCase();
  }

  function normalizeForKey(value) {
    return normalizeForMatch(value).replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "");
  }

  function getPersistedNtfyTopic() {
    return normalizeText(loadString(STORAGE_KEYS.ntfyTopic, DEFAULT_CONFIG.ntfyTopic));
  }

  function saveNtfyTopicSetting(value) {
    const topic = normalizeText(value);
    STATE.config.ntfyTopic = topic;

    if (topic) {
      saveString(STORAGE_KEYS.ntfyTopic, topic);
    } else {
      removeStorageKey(STORAGE_KEYS.ntfyTopic);
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function persistDraftInputs() {
    const panel = document.getElementById("fb-group-refresh-panel");
    if (!panel) return;

    const includeEl = panel.querySelector("#fbgr-include");
    const excludeEl = panel.querySelector("#fbgr-exclude");
    if (!includeEl || !excludeEl) return;

    STATE.config.includeKeywords = normalizeText(includeEl.value);
    STATE.config.excludeKeywords = normalizeText(excludeEl.value);
  }

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

  function truncate(value, maxLen) {
    const text = String(value || "");
    return text.length <= maxLen ? text : `${text.slice(0, maxLen - 3)}...`;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getCurrentGroupId() {
    const match = location.pathname.match(/^\/groups\/([^/?#]+)/i);
    return match ? match[1] : "";
  }

  function isSupportedGroupPage() {
    if (location.hostname !== "www.facebook.com") return false;
    const groupId = getCurrentGroupId();
    return Boolean(groupId);
  }

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

  function getRefreshSeconds() {
    if (!STATE.config.jitterEnabled) {
      return Math.max(5, Math.floor(Number(STATE.config.fixedRefreshSec) || DEFAULT_CONFIG.fixedRefreshSec));
    }

    const min = Math.min(STATE.config.minRefreshSec, STATE.config.maxRefreshSec);
    const max = Math.max(STATE.config.minRefreshSec, STATE.config.maxRefreshSec);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function scheduleRefresh() {
    clearRefreshTimer();
    if (STATE.config.paused || !isSupportedGroupPage()) return;

    const delaySec = getRefreshSeconds();
    STATE.refreshDeadline = Date.now() + delaySec * 1000;
    STATE.refreshTimer = window.setTimeout(() => {
      location.reload();
    }, delaySec * 1000);
  }

  function clearRefreshTimer() {
    if (STATE.refreshTimer) {
      clearTimeout(STATE.refreshTimer);
      STATE.refreshTimer = null;
    }
    STATE.refreshDeadline = null;
  }

  function scheduleScan(reason) {
    if (STATE.config.paused || STATE.isLoadingMorePosts) return;
    if (!isSupportedGroupPage()) {
      renderPanel();
      return;
    }

    if (STATE.scanTimer) clearTimeout(STATE.scanTimer);
    STATE.scanTimer = window.setTimeout(() => {
      STATE.scanTimer = null;
      runScan(reason);
    }, STATE.config.scanDebounceMs);
  }

  function findFeedRoot() {
    return (
      document.querySelector('[role="feed"]') ||
      document.querySelector('div[data-pagelet*="GroupsFeed"]') ||
      document.querySelector('div[data-pagelet*="FeedUnit"]') ||
      document.body
    );
  }

  function getScrollStep() {
    return Math.max(320, Math.floor(window.innerHeight * 0.62));
  }

  function getElementText(element) {
    if (!(element instanceof HTMLElement)) return "";
    return normalizeText(element.innerText || element.textContent || "");
  }

  function isVisibleElement(element) {
    if (!element || !(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

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

  async function expandCollapsedPostText(container) {
    if (!(container instanceof HTMLElement)) return;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expanders = findPostTextExpanders(container);
      if (!expanders.length) break;

      expanders[0].click();
      await sleep(220);
    }
  }

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

    const article = node.closest('[role="article"]');
    return article instanceof HTMLElement ? article : node;
  }

  function collectPostContainers(limit = STATE.config.maxPostsPerScan * 3) {
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
        const text = normalizeText(canonical.innerText);
        if (text.length < 40) continue;

        const identity = canonical;
        if (seen.has(identity)) continue;
        seen.add(identity);

        results.push({
          element: canonical,
          source: selector,
        });
      }
    }

    results.sort((a, b) => {
      return a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top;
    });

    return results.slice(0, limit);
  }

  function sanitizePermalink(url) {
    if (!url) return "";

    try {
      const parsed = new URL(url, location.origin);
      const cleanUrl = new URL(parsed.origin + parsed.pathname);
      const allowedParams = ["story_fbid", "id", "multi_permalinks", "view"];

      for (const key of allowedParams) {
        const value = parsed.searchParams.get(key);
        if (value) {
          cleanUrl.searchParams.set(key, value);
        }
      }

      return cleanUrl.toString();
    } catch (error) {
      return String(url || "");
    }
  }

  function extractPostIdFromValue(value) {
    const text = String(value || "");
    if (!text) return "";

    const patterns = [
      /\/posts\/(\d+)/i,
      /\/permalink\/(\d+)/i,
      /multi_permalinks=(\d+)/i,
      /story_fbid=(\d+)/i,
      /"top_level_post_id":"?(\d+)/i,
      /"mf_story_key":"?(\d+)/i,
      /"storyID":"?(\d+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }

    return "";
  }

  function extractPermalink(container) {
    const anchorSelectors = [
      'a[href*="/groups/"][href*="/posts/"]',
      'a[href*="/permalink/"]',
      'a[href*="multi_permalinks="]',
      'a[href*="/groups/"][href*="view=permalink"]',
      'a[href*="story_fbid="]',
    ];
    const results = [];
    const seen = new Set();

    for (const selector of anchorSelectors) {
      const anchors = container.querySelectorAll(selector);
      for (const anchor of anchors) {
        if (!(anchor instanceof HTMLAnchorElement)) continue;
        const href = anchor.href || anchor.getAttribute("href") || "";
        if (!href) continue;

        const permalink = sanitizePermalink(new URL(href, location.origin).toString());
        if (!extractPostIdFromValue(permalink)) continue;
        if (seen.has(permalink)) continue;
        seen.add(permalink);
        results.push(permalink);
      }
    }

    if (results.length) return results[0];

    const htmlMatch = container.innerHTML.match(/https?:\/\/www\.facebook\.com\/groups\/[^"' ]+/i);
    return htmlMatch ? sanitizePermalink(htmlMatch[0]) : "";
  }

  function extractPostId(permalink, container) {
    const values = [
      permalink,
      container?.getAttribute?.("data-ft") || "",
      container?.getAttribute?.("data-store") || "",
      container?.dataset?.ft || "",
      container?.dataset?.store || "",
      container?.innerHTML || "",
    ];

    const anchors = container?.querySelectorAll?.("a[href]") || [];
    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLAnchorElement)) continue;
      values.push(anchor.href || anchor.getAttribute("href") || "");
    }

    for (const value of values) {
      const postId = extractPostIdFromValue(value);
      if (postId) return postId;
    }

    return "";
  }

  function sanitizeTimestampText(value) {
    return normalizeText(String(value || "").replace(/^[\u00B7\u2022]\s*/, "").replace(/\s*[\u00B7\u2022]\s*$/, ""));
  }

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

  function getTimestampNodeSortValue(node) {
    if (!(node instanceof HTMLElement)) return Number.MAX_SAFE_INTEGER;

    const rect = node.getBoundingClientRect();
    return Math.round(rect.top);
  }

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

  function isProbablyTimestamp(value) {
    return Boolean(extractTimestampFragmentSafe(value));
  }

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
        const text = normalizeText(node.innerText);
        if (!text) continue;
        if (text.length > 80) continue;
        if (/^(Like|Comment|Share|Most relevant)$/i.test(text)) continue;
        return text;
      }
    }

    return "";
  }

  function extractPostText(container) {
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

    if (!snippets.length) {
      return cleanExtractedText(container.innerText);
    }

    return cleanExtractedText(snippets.join(" "));
  }

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

  function buildStableTextSignature(value) {
    const compact = normalizeForKey(value);
    if (!compact) return "";
    return compact.slice(0, 120);
  }

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

  function buildFallbackId(post) {
    return [
      normalizeForKey(post.author),
      normalizeForKey(post.timestampText),
      buildStableTextSignature(post.text || post.normalizedText),
    ].filter(Boolean).join("||");
  }

  function getPostKey(post) {
    if (post.postId) return `id:${post.postId}`;

    const permalink = sanitizePermalink(post.permalink);
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

  function getSeenPostsStore() {
    const store = loadJson(STORAGE_KEYS.seenPosts, {});
    return store && typeof store === "object" ? store : {};
  }

  function setSeenPostsStore(store) {
    saveJson(STORAGE_KEYS.seenPosts, store);
  }

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

  function markPostSeen(groupId, postKey) {
    const store = getSeenPostsStore();
    if (!store[groupId] || typeof store[groupId] !== "object") {
      store[groupId] = {};
    }

    store[groupId][postKey] = new Date().toISOString();

    const entries = Object.entries(store[groupId]).sort((a, b) => {
      return new Date(b[1]).getTime() - new Date(a[1]).getTime();
    });

    store[groupId] = Object.fromEntries(entries.slice(0, STATE.config.seenPostLimitPerGroup));
    setSeenPostsStore(store);
  }

  function clearSeenPostsForGroup(groupId) {
    const store = getSeenPostsStore();
    store[groupId] = {};
    setSeenPostsStore(store);
  }

  function getMatchHistoryStore() {
    const store = loadJson(STORAGE_KEYS.matchHistory, {});
    return store && typeof store === "object" ? store : {};
  }

  function setMatchHistoryStore(store) {
    saveJson(STORAGE_KEYS.matchHistory, store);
  }

  function clearMatchHistoryForGroup(groupId) {
    const store = getMatchHistoryStore();
    store[groupId] = [];
    setMatchHistoryStore(store);
  }

  function addMatchHistory(groupId, post) {
    const store = getMatchHistoryStore();
    if (!store[groupId] || !Array.isArray(store[groupId])) {
      store[groupId] = [];
    }

    const nextEntry = {
      postKey: post.postKey || "",
      author: post.author || "",
      text: post.text || "",
      permalink: post.permalink || "",
      includeRule: post.includeRule || "",
      timestampText: post.timestampText || "",
      notifiedAt: new Date().toISOString(),
    };

    const existing = store[groupId].filter((item) => item.postKey !== nextEntry.postKey);
    store[groupId] = [nextEntry, ...existing].slice(0, STATE.config.matchHistoryLimitPerGroup);
    setMatchHistoryStore(store);
  }

  function extractPostRecord(candidate) {
    const container = candidate.element;
    const permalink = extractPermalink(container);
    const postId = extractPostId(permalink, container);
    const text = extractPostText(container);
    const author = extractAuthor(container);
    // Facebook post timestamp extraction is temporarily disabled because the
    // current DOM heuristics still confuse post time with comment time.
    const timestampText = "";
    const groupId = getCurrentGroupId();

    return {
      postId,
      permalink,
      author,
      text,
      normalizedText: normalizeForMatch(text),
      timestampText,
      timestampEpoch: null,
      groupId,
      source: candidate.source,
      extractedAt: new Date().toISOString(),
    };
  }

  async function collectPostsFromCandidates(candidates) {
    const posts = [];

    for (const candidate of candidates) {
      await expandCollapsedPostText(candidate.element);
      const post = extractPostRecord(candidate);
      if (normalizeText(post.text)) {
        posts.push(post);
      }
    }

    return posts;
  }

  async function collectPostsAcrossWindows() {
    const result = {
      mode: STATE.config.autoLoadMorePosts ? STATE.config.loadMoreMode : "off",
      attempted: false,
      attempts: 0,
      beforeCount: 0,
      afterCount: 0,
      windowCount: 0,
      candidateCount: 0,
      parsedCount: 0,
      accumulatedCount: 0,
    };
    const accumulated = [];
    const accumulatedKeys = new Set();
    const maxWindows = STATE.config.autoLoadMorePosts ? 5 : 1;
    let stagnantWindows = 0;

    const initialCandidates = collectPostContainers();
    result.beforeCount = initialCandidates.length;
    result.afterCount = initialCandidates.length;

    if (STATE.isLoadingMorePosts) {
      const initialPosts = dedupeExtractedPosts(await collectPostsFromCandidates(initialCandidates), STATE.config.maxPostsPerScan);
      return { posts: initialPosts, meta: result };
    }

    const startY = window.scrollY;
    STATE.isLoadingMorePosts = true;

    try {
      for (let windowIndex = 0; windowIndex < maxWindows; windowIndex += 1) {
        result.windowCount = windowIndex + 1;

        const candidates = collectPostContainers();
        const posts = dedupeExtractedPosts(await collectPostsFromCandidates(candidates), Number.MAX_SAFE_INTEGER);
        result.candidateCount += candidates.length;
        result.parsedCount += posts.length;
        result.afterCount = Math.max(result.afterCount, candidates.length);

        let addedThisWindow = 0;

        for (const post of posts) {
          const postKey = getPostKey(post);
          if (!postKey || accumulatedKeys.has(postKey)) continue;
          accumulatedKeys.add(postKey);
          accumulated.push(post);
          addedThisWindow += 1;

          if (accumulated.length >= STATE.config.maxPostsPerScan) break;
        }

        result.accumulatedCount = accumulated.length;

        if (accumulated.length >= STATE.config.maxPostsPerScan) break;
        if (!STATE.config.autoLoadMorePosts) break;

        if (addedThisWindow === 0) {
          stagnantWindows += 1;
        } else {
          stagnantWindows = 0;
        }

        if (stagnantWindows >= 2) break;

        result.attempted = true;
        result.attempts += 1;
        if (STATE.config.loadMoreMode === "wheel") {
          performWheelLikeLoad();
        } else {
          performScrollLoad();
        }

        await sleep(900);
      }
    } finally {
      window.scrollTo(0, startY);
      await sleep(160);
      STATE.isLoadingMorePosts = false;
    }

    return {
      posts: accumulated.slice(0, STATE.config.maxPostsPerScan),
      meta: result,
    };
  }

  function performScrollLoad() {
    window.scrollBy(0, getScrollStep());
  }

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

  async function runScan(reason) {
    if (STATE.config.paused) {
      renderPanel();
      return;
    }

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
        },
      };
      if (supported) {
        collectedResult = await collectPostsAcrossWindows();
      }
      const uniquePosts = collectedResult.posts;
      const candidateCount = collectedResult.meta.candidateCount;
      const parsedCount = collectedResult.meta.parsedCount;
      const uniqueCount = uniquePosts.length;
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
        addMatchHistory(groupId, item);
      }

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
        parsedCount,
        scannedCount: uniqueCount,
        notifiedCount: matchesToNotify.length,
        baselineMode,
        loadMoreMode: collectedResult.meta.mode || STATE.config.loadMoreMode,
        loadMoreAttempted: collectedResult.meta.attempted || false,
        loadMoreAttempts: collectedResult.meta.attempts || 0,
        loadMoreBeforeCount: collectedResult.meta.beforeCount ?? 0,
        loadMoreAfterCount: collectedResult.meta.afterCount ?? 0,
        loadMoreWindowCount: collectedResult.meta.windowCount ?? 0,
        accumulatedCount: collectedResult.meta.accumulatedCount ?? 0,
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
      scheduleRefresh();
      renderPanel();
    }
  }

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

  async function notifyForPost(post) {
    const title = "Facebook group match";
    const matchedRule = post.includeRule || "(include-all)";
    const body = truncate(
      [post.author, `match: ${matchedRule}`, truncate(post.text, 120)].filter(Boolean).join(" | "),
      250
    );
    const statusParts = [];

    STATE.latestNotification = {
      title,
      body,
      permalink: post.permalink,
      timestamp: new Date().toISOString(),
      status: "pending",
    };

    if (STATE.config.enableGmNotification) {
      try {
        GM_notification({
          title,
          text: body,
          timeout: 15000,
        });
        statusParts.push("gm_sent");
      } catch (error) {
        statusParts.push("gm_failed");
      }
    }

    if (STATE.config.enableBrowserNotification && "Notification" in window) {
      try {
        if (Notification.permission === "granted") {
          const notification = new Notification(title, { body });
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

    const ntfyStatus = await sendNtfyNotification({
      title,
      body,
      clickUrl: post.permalink,
    });
    if (ntfyStatus !== "ntfy_skipped") {
      statusParts.push(ntfyStatus);
    }

    STATE.latestNotification.status = statusParts.length ? statusParts.join(", ") : "no_channel_sent";

    saveJson(STORAGE_KEYS.lastNotification, STATE.latestNotification);
  }

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

  function createHistoryModal() {
    if (document.getElementById("fbgr-history-modal")) return;

    const overlay = document.createElement("div");
    overlay.id = "fbgr-history-modal";
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
      const groupId = getCurrentGroupId();
      if (!groupId) return;
      if (!window.confirm("確定要清空目前社團的符合關鍵字紀錄嗎？")) return;
      clearMatchHistoryForGroup(groupId);
      openHistoryModal();
    });
    overlay.querySelector("#fbgr-history-close").addEventListener("click", closeHistoryModal);
  }

  function openHistoryModal() {
    createHistoryModal();
    const overlay = document.getElementById("fbgr-history-modal");
    const content = overlay?.querySelector("#fbgr-history-content");
    if (!overlay || !content) return;

    const groupId = getCurrentGroupId();
    const history = getMatchHistoryStore()[groupId] || [];

    if (!history.length) {
      content.innerHTML = "<div>目前還沒有符合關鍵字的紀錄。</div>";
    } else {
      content.innerHTML = history
        .map((item, index) => {
          const linkHtml = item.permalink
            ? `<a href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener noreferrer" style="color:#93c5fd;">開啟貼文</a>`
            : '<span style="color:#9ca3af;">無連結</span>';
          return `
            <div style="padding:10px;border:1px solid #374151;border-radius:10px;background:rgba(255,255,255,0.03);">
              <div>#${index + 1}</div>
              <div>作者: ${escapeHtml(item.author || "(無)")}</div>
              <div>關鍵字: ${escapeHtml(item.includeRule || "(無)")}</div>
              <div>貼文時間: ${escapeHtml(item.timestampText || "(無)")}</div>
              <div>通知時間: ${escapeHtml(item.notifiedAt || "(無)")}</div>
              <div>內容: ${escapeHtml(truncate(item.text, 220) || "(空白)")}</div>
              <div style="margin-top:6px;">${linkHtml}</div>
            </div>
          `;
        })
        .join("");
    }

    overlay.style.display = "block";
  }

  function closeHistoryModal() {
    const overlay = document.getElementById("fbgr-history-modal");
    if (overlay) overlay.style.display = "none";
  }

  function createIncludeHelpModal() {
    if (document.getElementById("fbgr-include-help-modal")) return;

    const overlay = document.createElement("div");
    overlay.id = "fbgr-include-help-modal";
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

  function openIncludeHelpModal() {
    createIncludeHelpModal();
    const overlay = document.getElementById("fbgr-include-help-modal");
    if (overlay) overlay.style.display = "block";
  }

  function closeIncludeHelpModal() {
    const overlay = document.getElementById("fbgr-include-help-modal");
    if (overlay) overlay.style.display = "none";
  }

  function createSettingsModal() {
    if (document.getElementById("fbgr-settings-modal")) return;

    const overlay = document.createElement("div");
    overlay.id = "fbgr-settings-modal";
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
            <label for="fbgr-max-posts-per-scan">每次最多掃描貼文數</label>
            <input id="fbgr-max-posts-per-scan" type="number" min="1" step="1" style="padding:6px;border-radius:6px;border:1px solid #6b7280;background:#111827;color:#f9fafb;" />
          </div>
          <div style="display:grid;gap:4px;">
            <label for="fbgr-ntfy-topic">ntfy topic</label>
            <input id="fbgr-ntfy-topic" type="text" placeholder="例如：my-facebook-alerts" style="padding:6px;border-radius:6px;border:1px solid #6b7280;background:#111827;color:#f9fafb;" />
          </div>
          <div style="padding:10px;border:1px solid #374151;border-radius:8px;background:rgba(255,255,255,0.03);color:#d1d5db;">
            每次最多累積掃描你設定的貼文數。頁面內查看紀錄仍保留最新 10 筆符合關鍵字的通知紀錄。
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
    overlay.querySelector("#fbgr-settings-test").addEventListener("click", () => {
      const ntfyTopic = normalizeText(overlay.querySelector("#fbgr-ntfy-topic").value);
      saveNtfyTopicSetting(ntfyTopic);
      sendTestNotification();
    });
    overlay.querySelector("#fbgr-settings-save").addEventListener("click", () => {
      const jitterEnabled = overlay.querySelector("#fbgr-jitter-enabled").checked;
      const ntfyTopic = normalizeText(overlay.querySelector("#fbgr-ntfy-topic").value);
      const autoLoadMorePosts = overlay.querySelector("#fbgr-auto-load-more").checked;
      const minRefreshSec = Math.max(5, Math.floor(Number(overlay.querySelector("#fbgr-refresh-min").value) || STATE.config.minRefreshSec));
      const maxRefreshSec = Math.max(5, Math.floor(Number(overlay.querySelector("#fbgr-refresh-max").value) || STATE.config.maxRefreshSec));
      const fixedRefreshSec = Math.max(5, Math.floor(Number(overlay.querySelector("#fbgr-fixed-refresh").value) || STATE.config.fixedRefreshSec));
      const maxPostsPerScan = Math.max(1, Math.floor(Number(overlay.querySelector("#fbgr-max-posts-per-scan").value) || STATE.config.maxPostsPerScan));

      STATE.config.jitterEnabled = jitterEnabled;
      STATE.config.ntfyTopic = ntfyTopic;
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

  function renderSettingsMode() {
    const overlay = document.getElementById("fbgr-settings-modal");
    if (!overlay) return;

    const jitterEnabled = overlay.querySelector("#fbgr-jitter-enabled").checked;
    overlay.querySelector("#fbgr-jitter-wrap").style.display = jitterEnabled ? "grid" : "none";
    overlay.querySelector("#fbgr-fixed-wrap").style.display = jitterEnabled ? "none" : "grid";
  }

  function openSettingsModal() {
    createSettingsModal();
    const overlay = document.getElementById("fbgr-settings-modal");
    if (!overlay) return;

    STATE.config.ntfyTopic = getPersistedNtfyTopic();
    overlay.querySelector("#fbgr-jitter-enabled").checked = STATE.config.jitterEnabled;
    overlay.querySelector("#fbgr-ntfy-topic").value = STATE.config.ntfyTopic;
    overlay.querySelector("#fbgr-auto-load-more").checked = STATE.config.autoLoadMorePosts;
    overlay.querySelector("#fbgr-refresh-min").value = String(STATE.config.minRefreshSec);
    overlay.querySelector("#fbgr-refresh-max").value = String(STATE.config.maxRefreshSec);
    overlay.querySelector("#fbgr-fixed-refresh").value = String(STATE.config.fixedRefreshSec);
    overlay.querySelector("#fbgr-max-posts-per-scan").value = String(STATE.config.maxPostsPerScan);
    renderSettingsMode();
    overlay.style.display = "block";
  }

  function closeSettingsModal() {
    const overlay = document.getElementById("fbgr-settings-modal");
    if (overlay) overlay.style.display = "none";
  }

  function createPanel() {
    if (document.getElementById("fb-group-refresh-panel")) return;

    const panel = document.createElement("div");
    panel.id = "fb-group-refresh-panel";
    panel.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      "z-index:2147483647",
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
        runScan("manual-start");
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

  function formatRefreshStatus() {
    if (!STATE.refreshDeadline) return "未排程";
    const remainSec = Math.max(0, Math.ceil((STATE.refreshDeadline - Date.now()) / 1000));
    return `${remainSec}s`;
  }

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

    statusEl.innerHTML = [
      `<div>社團: ${escapeHtml(getCurrentGroupId() || "(無)")}</div>`,
      `<div>狀態: ${STATE.config.paused ? "已暫停" : "監控中"}</div>`,
      `<div>刷新模式: ${escapeHtml(formatRefreshModeLabel())}</div>`,
      `<div>自動載入更多: ${STATE.config.autoLoadMorePosts ? "開" : "關"}</div>`,
      `<div>上次掃描: ${escapeHtml(formatLastScanStatus(latestScan?.finishedAt))}</div>`,
      `<div>下次刷新: ${escapeHtml(formatRefreshStatus())}</div>`,
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
                <div>命中包含=${escapeHtml(post.includeRule || "(無)")}</div>
                <div>命中排除=${escapeHtml(post.excludeRule || "(無)")}</div>
                <div>可通知=${post.eligible ? "是" : "否"} | 已看過=${post.seen ? "是" : "否"}</div>
                <div>文字=${escapeHtml(truncate(post.text, 180) || "(空白)")}</div>
              </div>
            `;
          }).join("")
        : "<div>目前還沒有抽到貼文。</div>";

      debugEl.innerHTML = `
        <div>網址: ${escapeHtml(location.href)}</div>
        <div>包含: ${escapeHtml(STATE.config.includeKeywords || "(空白)")}</div>
        <div>排除: ${escapeHtml(STATE.config.excludeKeywords || "(空白)")}</div>
        <div>掃描原因: ${escapeHtml(latestScan?.reason || "(無)")}</div>
        <div>首次掃描: ${latestScan?.baselineMode ? "是" : "否"}</div>
        <div>自動載入方式: ${escapeHtml(latestScan?.loadMoreMode || STATE.config.loadMoreMode)}</div>
        <div>自動載入嘗試: ${latestScan?.loadMoreAttempted ? `${latestScan?.loadMoreAttempts || 0} 次` : "未執行"}</div>
        <div>視窗掃描次數: ${latestScan?.loadMoreWindowCount ?? 0}</div>
        <div>貼文數變化: ${(latestScan?.loadMoreBeforeCount ?? 0)} -> ${(latestScan?.loadMoreAfterCount ?? 0)}</div>
        <div>累積候選貼文數: ${latestScan?.candidateCount ?? 0}</div>
        <div>累積解析貼文數: ${latestScan?.parsedCount ?? 0}</div>
        <div>累積唯一貼文數: ${latestScan?.accumulatedCount ?? latestScan?.scannedCount ?? 0}</div>
        <div>最終去重後貼文數: ${latestScan?.scannedCount ?? 0}</div>
        <div>最後通知狀態: ${escapeHtml(STATE.latestNotification?.status || "(本次無)")}</div>
        <div>錯誤: ${escapeHtml(STATE.latestError || "(無)")}</div>
        ${postRows}
      `;
    }
  }

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

  function formatRefreshModeLabel() {
    if (STATE.config.jitterEnabled) {
      return `浮動 ${STATE.config.minRefreshSec}-${STATE.config.maxRefreshSec} 秒`;
    }
    return `固定 ${STATE.config.fixedRefreshSec} 秒`;
  }

  function formatLoadMoreModeLabel() {
    return STATE.config.loadMoreMode === "wheel" ? "模擬滑鼠滾輪" : "溫和捲動";
  }

  function handleRouteChange() {
    if (STATE.lastUrl === location.href) return;

    STATE.lastUrl = location.href;
    clearRefreshTimer();
    installObserver();
    scheduleScan("route-change");
    renderPanel();
  }

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
