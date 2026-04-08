const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");
const userScriptPath = path.join(projectRoot, "src", "facebook_group_refresh.user.js");
const source = fs.readFileSync(userScriptPath, "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createTestContext() {
  class FakeHTMLElement {}
  class FakeHTMLAnchorElement extends FakeHTMLElement {}

  const context = {
    __FB_GROUP_REFRESH_TEST_MODE__: true,
    console,
    URL,
    Date,
    Math,
    JSON,
    Promise,
    Set,
    Map,
    WeakMap,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    HTMLElement: FakeHTMLElement,
    HTMLAnchorElement: FakeHTMLAnchorElement,
    WheelEvent: function WheelEvent() {},
    MutationObserver: function MutationObserver() {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    location: {
      href: "https://www.facebook.com/groups/test-group/",
      hostname: "www.facebook.com",
      pathname: "/groups/test-group/",
      reload() {},
    },
    navigator: {},
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
    document: {
      readyState: "loading",
      title: "測試社團 | Facebook",
      body: null,
      addEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
      createElement() {
        return {
          style: {},
          appendChild() {},
          remove() {},
          setAttribute() {},
          select() {},
        };
      },
    },
    Notification: function Notification() {},
    GM_getValue() {
      return null;
    },
    GM_setValue() {},
    GM_deleteValue() {},
    GM_notification() {},
    GM_xmlhttpRequest() {},
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
    open() {},
    scrollBy() {},
    scrollTo() {},
    innerHeight: 900,
  };

  context.Notification.permission = "denied";
  context.Notification.requestPermission = async () => "denied";
  context.window = context;
  context.globalThis = context;
  return context;
}

function loadTestHooks() {
  assert(source.includes("// ==UserScript=="), "Missing userscript header.");
  assert(
    source.includes("@match        https://www.facebook.com/groups/*"),
    "Missing Facebook group match rule."
  );
  assert(source.includes("(function () {"), "Missing userscript IIFE wrapper.");

  const context = createTestContext();
  vm.createContext(context);
  new vm.Script(source, {
    filename: userScriptPath,
  }).runInContext(context);

  const hooks = context.__FB_GROUP_REFRESH_TEST_HOOKS__;
  assert(hooks && typeof hooks === "object", "Missing exported test hooks.");
  return hooks;
}

function runTests(hooks) {
  assert(
    hooks.getPauseToggleAction(true) === "restart",
    "Expected paused state to map to restart semantics."
  );
  assert(
    hooks.getPauseToggleAction(false) === "pause",
    "Expected active state to map to pause semantics."
  );
  assert(
    hooks.shouldUseTopPostShortcut("mutation") === true,
    "Expected routine mutation scans to allow the top-post shortcut."
  );
  assert(
    hooks.shouldUseTopPostShortcut("manual-start") === false,
    "Expected manual-start scans to bypass the top-post shortcut."
  );
  assert(
    hooks.shouldUseTopPostShortcut("save") === false,
    "Expected save-triggered scans to bypass the top-post shortcut."
  );
  assert(
    hooks.shouldUseTopPostShortcut("route-change") === false,
    "Expected route-change scans to bypass the top-post shortcut."
  );
  assert(
    JSON.stringify(hooks.buildFailedScanRuntimeState(new Error("boom"))) ===
      JSON.stringify({ latestError: "boom" }),
    "Expected failed scan runtime builder to normalize the error message."
  );
  assert(
    JSON.stringify(
      hooks.buildCompletedNotificationState(
        { title: "t", status: "pending" },
        ["gm_sent", "ntfy_sent"]
      )
    ) === JSON.stringify({ title: "t", status: "gm_sent, ntfy_sent" }),
    "Expected completed notification builder to join status parts."
  );
  assert(
    hooks.getLatestNotificationStatusLabel({ status: "discord_sent" }) === "discord_sent",
    "Expected latest notification status helper to surface the stored status."
  );
  assert(
    hooks.getLatestNotificationStatusLabel(null) === "(本次無)",
    "Expected latest notification status helper to provide an empty fallback."
  );

  const refreshPayload = hooks.buildRefreshSettingsPayloadFromConfig({
    minRefreshSec: 15,
    maxRefreshSec: 45,
    jitterEnabled: true,
    fixedRefreshSec: 90,
    maxPostsPerScan: 99,
    autoLoadMorePosts: false,
  });
  assert(
    JSON.stringify(refreshPayload) === JSON.stringify({
      min: 15,
      max: 45,
      jitterEnabled: true,
      fixedSec: 90,
      maxPostsPerScan: 10,
      autoLoadMorePosts: false,
    }),
    "Expected refresh payload builder to normalize and clamp config values."
  );

  const parsedRules = hooks.parseKeywordInput(" 搖滾 6880 ; 搖滾 5880 ; ");
  assert(parsedRules.length === 2, "Expected two parsed keyword rules.");
  assert(parsedRules[0].raw === "搖滾 6880", "Unexpected first keyword rule.");
  assert(
    JSON.stringify(parsedRules[0].terms) === JSON.stringify(["搖滾", "6880"]),
    "Unexpected normalized keyword terms."
  );

  const matched = hooks.matchRules(parsedRules, hooks.normalizeForMatch("我想收搖滾 6880 兩張"));
  assert(matched.matched === true && matched.rule === "搖滾 6880", "Expected include rule match.");

  const unmatched = hooks.matchRules(parsedRules, hooks.normalizeForMatch("只有 5880 沒有前綴"));
  assert(unmatched.matched === false, "Expected no rule match.");

  assert(
    hooks.getPostKey({ postId: "12345" }) === "id:12345",
    "Expected postId-based key."
  );
  assert(
    hooks.getPostKey({ permalink: "https://www.facebook.com/groups/x/posts/999/" }) ===
      "url:https://www.facebook.com/groups/x/posts/999/",
    "Expected permalink-based key."
  );

  const compositeKey = hooks.getPostKey({
    author: "Alice",
    timestampText: "今天 10:30",
    text: "搖滾區 6880 兩張",
  });
  assert(
    compositeKey.startsWith("author:alice||time:"),
    "Expected composite fallback key."
  );

  const deduped = hooks.dedupeExtractedPosts(
    [
      { postId: "1", text: "a" },
      { postId: "1", text: "b" },
      { author: "Bob", timestampText: "today", text: "same" },
      { author: "Bob", timestampText: "today", text: "same" },
      { postId: "2", text: "c" },
    ],
    10
  );
  assert(deduped.length === 3, "Expected three unique posts after dedupe.");

  const trimmedSeenStore = hooks.trimSeenPostGroupStore(
    {
      old: "2026-04-08T09:00:00.000Z",
      newest: "2026-04-08T11:00:00.000Z",
      middle: "2026-04-08T10:00:00.000Z",
    },
    2
  );
  assert(
    JSON.stringify(Object.keys(trimmedSeenStore)) === JSON.stringify(["newest", "middle"]),
    "Expected seen-post trimming to keep the newest entries."
  );

  const mergedHistory = hooks.mergeMatchHistoryEntries(
    [
      { groupId: "g1", postKey: "keep", notifiedAt: "2026-04-08T10:00:00.000Z" },
      { groupId: "g1", postKey: "replace", notifiedAt: "2026-04-08T09:00:00.000Z" },
      { groupId: "g2", postKey: "other-group", notifiedAt: "2026-04-08T08:00:00.000Z" },
    ],
    [
      { groupId: "g1", postKey: "replace", notifiedAt: "2026-04-08T11:00:00.000Z" },
      { groupId: "g1", postKey: "new", notifiedAt: "2026-04-08T11:05:00.000Z" },
    ],
    new Set(["g1::replace", "g1::new"]),
    10
  );
  assert(mergedHistory.length === 4, "Expected merged history to keep four entries.");
  assert(
    mergedHistory[0].postKey === "replace" && mergedHistory[1].postKey === "new",
    "Expected incoming history entries to stay in front."
  );
  assert(
    mergedHistory.some((entry) => entry.groupId === "g2" && entry.postKey === "other-group"),
    "Expected history merge to preserve other-group entries."
  );
  assert(
    mergedHistory.filter((entry) => entry.groupId === "g1" && entry.postKey === "replace").length === 1,
    "Expected duplicate history entries to be replaced."
  );

  const seenStopState = hooks.createSeenPostStopState({
    enabled: true,
    minNewPostsBeforeStop: 1,
    consecutiveSeenThreshold: 3,
  });
  hooks.applySeenPostStopObservation(seenStopState, { postKey: "new-1", seen: false });
  hooks.applySeenPostStopObservation(seenStopState, { postKey: "seen-1", seen: true });
  hooks.applySeenPostStopObservation(seenStopState, { postKey: "seen-2", seen: true });
  assert(seenStopState.triggered === false, "Expected seen-stop to remain inactive before threshold.");
  hooks.applySeenPostStopObservation(seenStopState, { postKey: "seen-3", seen: true });
  assert(seenStopState.triggered === true, "Expected seen-stop to trigger after three consecutive seen posts.");
  assert(
    seenStopState.stopReason.includes("已連續遇到 3 篇已看過貼文"),
    "Expected seen-stop reason to mention the seen threshold."
  );

  const duplicateSeenStopState = hooks.createSeenPostStopState({
    enabled: true,
    minNewPostsBeforeStop: 1,
    consecutiveSeenThreshold: 2,
  });
  hooks.applySeenPostStopObservation(duplicateSeenStopState, { postKey: "new-1", seen: false });
  hooks.applySeenPostStopObservation(duplicateSeenStopState, { postKey: "seen-1", seen: true });
  hooks.applySeenPostStopObservation(duplicateSeenStopState, { postKey: "seen-1", seen: true });
  assert(
    duplicateSeenStopState.consecutiveSeenCount === 1,
    "Expected duplicate post keys to be ignored by seen-stop observation."
  );

  const compactBody = hooks.buildCompactNotificationBody({
    author: "Alice",
    includeRule: "搖滾 6880",
    text: "搖滾 6880 兩張連號，意者私訊",
    permalink: "https://example.com/post/1",
  });
  assert(compactBody.includes("測試社團"), "Expected group name in compact notification body.");
  assert(compactBody.includes("Alice"), "Expected author in compact notification body.");
  assert(compactBody.includes("match: 搖滾 6880"), "Expected include rule in compact body.");

  const remoteBody = hooks.buildRemoteNotificationBody({
    author: "Alice",
    includeRule: "搖滾 6880",
    text: "搖滾 6880 兩張連號，意者私訊",
    permalink: "https://example.com/post/1",
  });
  assert(remoteBody.includes("社團: 測試社團"), "Expected group name in remote notification body.");
  assert(remoteBody.includes("作者: Alice"), "Expected author in remote notification body.");
  assert(remoteBody.includes("連結: https://example.com/post/1"), "Expected permalink line.");
}

const hooks = loadTestHooks();
runTests(hooks);

console.log("Smoke test passed.");
console.log(`Checked: ${userScriptPath}`);
