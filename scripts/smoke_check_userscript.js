const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");
const userScriptPath = path.join(projectRoot, "src", "facebook_group_refresh.user.js");
const source = fs.readFileSync(userScriptPath, "utf8");
const TEST_GROUP_ID = "123456789012345";
const OTHER_GROUP_ID = "999999999999999";
const TEST_POST_ID = "9876543210123456";
const TEST_GROUP_POST_URL = `https://www.facebook.com/groups/${TEST_GROUP_ID}/posts/${TEST_POST_ID}`;
const TEST_PHOTO_GM_HREF =
  `https://www.facebook.com/photo/?fbid=1234567890&set=gm.${TEST_POST_ID}&idorvanity=${TEST_GROUP_ID}`;
const PERMALINK_ANCHOR_SELECTOR =
  'a[href*="/groups/"][href*="/posts/"], a[href*="/permalink/"], a[href*="multi_permalinks="], a[href*="story_fbid="], a[href*="set=gm."]';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`);
  }
}

function assertUserScriptScaffold() {
  assert(source.includes("// ==UserScript=="), "Missing userscript header.");
  assert(
    source.includes("@match        https://www.facebook.com/groups/*"),
    "Missing Facebook group match rule."
  );
  assert(source.includes("(function () {"), "Missing userscript IIFE wrapper.");
}

function createFakeElement(context, options = {}) {
  const {
    attributes = {},
    dataset = {},
    innerHTML = "",
    id = "",
    href = "",
    querySelectorAll = () => [],
  } = options;
  const element = new context.HTMLElement();
  element.dataset = { ...dataset };
  element.innerHTML = innerHTML;
  element.id = id;
  element.querySelectorAll = querySelectorAll;
  element.getAttribute = (name) => {
    if (name === "href" && href) {
      return href;
    }
    return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : "";
  };
  if (href) {
    element.href = href;
  }
  return element;
}

function createFakeAnchor(context, options = {}) {
  const {
    attributes = {},
    dataset = {},
    innerHTML = "",
    id = "",
    href = "",
  } = options;
  const anchor = new context.HTMLAnchorElement();
  anchor.dataset = { ...dataset };
  anchor.innerHTML = innerHTML;
  anchor.id = id;
  anchor.href = href;
  anchor.getAttribute = (name) => {
    if (name === "href") {
      return anchor.href || "";
    }
    return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : "";
  };
  return anchor;
}

function createMetadataContainer(context, metadataValue) {
  return createFakeElement(context, {
    attributes: {
      "data-ft": metadataValue,
    },
  });
}

function createAnchorHrefContainer(context, href) {
  return createFakeElement(context, {
    querySelectorAll: () => [createFakeAnchor(context, { href })],
  });
}

function createTestContext() {
  class FakeHTMLElement {}
  class FakeHTMLAnchorElement extends FakeHTMLElement {}
  const gmStore = new Map();

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
      href: "https://www.facebook.com/groups/123456789012345/",
      hostname: "www.facebook.com",
      pathname: "/groups/123456789012345/",
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
      title: "Test Group | Facebook",
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
    GM_getValue(key, fallback = null) {
      return gmStore.has(key) ? gmStore.get(key) : fallback;
    },
    GM_setValue(key, value) {
      gmStore.set(key, value);
    },
    GM_deleteValue(key) {
      gmStore.delete(key);
    },
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
    innerWidth: 1280,
  };

  context.Notification.permission = "denied";
  context.window = context;
  context.globalThis = context;
  return context;
}

function loadTestHooks() {
  assertUserScriptScaffold();

  const context = createTestContext();
  vm.createContext(context);
  new vm.Script(source, { filename: userScriptPath }).runInContext(context);

  const hooks = context.__FB_GROUP_REFRESH_TEST_HOOKS__;
  assert(hooks && typeof hooks === "object", "Missing exported test hooks.");
  return { hooks, context };
}

function runTest(name, fn) {
  try {
    fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

function runCoreBehaviorTests(hooks) {
  runTest("monitoring control semantics", () => {
    assertEqual(
      hooks.getPauseToggleAction(true),
      "restart",
      "Paused state should map to restart."
    );
    assertEqual(
      hooks.getPauseToggleAction(false),
      "pause",
      "Active state should map to pause."
    );
    assertEqual(
      hooks.getMonitoringControlAction(true),
      "restart",
      "Monitoring action should preserve paused-state restart semantics."
    );
    assertEqual(
      hooks.getMonitoringControlLabel("restart"),
      "開始",
      "Restart action should render as start."
    );
    assertEqual(
      hooks.getMonitoringControlLabel("pause"),
      "暫停",
      "Pause action should render as pause."
    );
  });

  runTest("session initialization", () => {
    assertEqual(
      hooks.isGroupInitialized("123456789012345"),
      false,
      "Groups should start uninitialized."
    );
    assertEqual(
      hooks.markGroupInitialized("123456789012345"),
      true,
      "First initialization should succeed."
    );
    assertEqual(
      hooks.isGroupInitialized("123456789012345"),
      true,
      "Initialized group should be tracked."
    );
    assertEqual(
      hooks.markGroupInitialized("123456789012345"),
      false,
      "Duplicate initialization should be ignored."
    );
  });

  runTest("text normalization helpers", () => {
    assertEqual(
      hooks.normalizeText("  Alpha\u200B   Beta  "),
      "Alpha Beta",
      "normalizeText should trim, collapse spaces, and remove zero-width characters."
    );
    assertEqual(
      hooks.normalizeForMatch(" AbC "),
      "abc",
      "normalizeForMatch should lower-case normalized text."
    );
    assertEqual(
      hooks.normalizeForKey("A-b C_123!中文"),
      "abc123中文",
      "normalizeForKey should keep letters, digits, and CJK text only."
    );
    assertEqual(
      hooks.buildStableTextSignature("A-b C_123!中文"),
      "abc123中文",
      "Stable signature should reuse normalized key shape."
    );
  });
}

function runConfigAndLayoutTests(hooks) {
  runTest("config patch builders", () => {
    assertDeepEqual(
      hooks.buildKeywordConfigPatch({
        includeKeywords: "  alpha beta  ",
        excludeKeywords: "  gamma  ",
      }),
      {
        includeKeywords: "alpha beta",
        excludeKeywords: "gamma",
      },
      "Keyword config builder should normalize include/exclude text."
    );

    assertDeepEqual(
      hooks.buildRefreshConfigPatch(
        {
          jitterEnabled: 0,
          autoLoadMorePosts: "yes",
          minRefreshSec: 3,
          maxRefreshSec: 42.8,
          fixedRefreshSec: 4,
          maxPostsPerScan: 99,
        },
        {
          minRefreshSec: 25,
          maxRefreshSec: 35,
          fixedRefreshSec: 60,
        }
      ),
      {
        jitterEnabled: false,
        autoLoadMorePosts: true,
        minRefreshSec: 5,
        maxRefreshSec: 42,
        fixedRefreshSec: 5,
        maxPostsPerScan: 10,
      },
      "Refresh config builder should clamp and normalize values."
    );

    assertDeepEqual(
      hooks.buildNotificationConfigPatch({
        ntfyTopic: "  my-topic  ",
        discordWebhook: "  https://discord.example/webhook  ",
      }),
      {
        ntfyTopic: "my-topic",
        discordWebhook: "https://discord.example/webhook",
      },
      "Notification config builder should normalize endpoint fields."
    );

    assertDeepEqual(
      hooks.buildMonitoringConfigPatch({ paused: 0 }),
      { paused: false },
      "Monitoring config builder should normalize the paused flag."
    );

    assertDeepEqual(
      hooks.buildUiConfigPatch({ debugVisible: 1 }),
      { debugVisible: true },
      "UI config builder should normalize the debug flag."
    );

    assertDeepEqual(
      hooks.hydrateNotificationConfigFromStorage(),
      { ntfyTopic: "", discordWebhook: "" },
      "Notification hydration should reuse persisted defaults when storage is empty."
    );

    assertDeepEqual(
      hooks.buildRefreshSettingsPayloadFromConfig({
        minRefreshSec: 15,
        maxRefreshSec: 45,
        jitterEnabled: true,
        fixedRefreshSec: 90,
        maxPostsPerScan: 99,
        autoLoadMorePosts: false,
      }),
      {
        min: 15,
        max: 45,
        jitterEnabled: true,
        fixedSec: 90,
        maxPostsPerScan: 10,
        autoLoadMorePosts: false,
      },
      "Refresh payload builder should clamp maxPostsPerScan."
    );
  });

  runTest("scan limits", () => {
    assertEqual(
      hooks.clampTargetPostCount(-1),
      1,
      "Target post count should clamp to minimum."
    );
    assertEqual(
      hooks.clampTargetPostCount(0),
      5,
      "Falsy target post counts should fall back to the default target."
    );
    assertEqual(
      hooks.clampTargetPostCount(999),
      10,
      "Target post count should clamp to maximum."
    );
    assertEqual(
      hooks.getCandidateCollectionLimit(1),
      12,
      "Candidate collection limit should keep the minimum floor."
    );
    assertEqual(
      hooks.getCandidateCollectionLimit(10),
      60,
      "Candidate collection limit should scale with target count."
    );
    assertEqual(
      hooks.getDynamicMaxWindows(7),
      14,
      "Dynamic max windows should scale with the requested target count."
    );
    assertEqual(
      hooks.getDynamicSeenPostLimit(7),
      84,
      "Dynamic seen-post limit should reserve space for per-post alias keys."
    );
  });

  runTest("panel position helpers", () => {
    assertDeepEqual(
      hooks.normalizePanelPosition({ top: 18.4, left: 205.6 }),
      { top: 18, left: 206 },
      "Panel position normalization should round coordinates."
    );
    assertEqual(
      hooks.normalizePanelPosition({ top: "bad", left: 12 }),
      null,
      "Invalid panel positions should be rejected."
    );
    assertDeepEqual(
      hooks.getPanelPositionBounds({
        width: 380,
        height: 240,
        viewportWidth: 1280,
        viewportHeight: 720,
      }),
      {
        width: 380,
        height: 240,
        viewportWidth: 1280,
        viewportHeight: 720,
        minLeft: 12,
        minTop: 12,
        maxLeft: 888,
        maxTop: 468,
      },
      "Panel bounds should reserve the viewport margin."
    );
    assertDeepEqual(
      hooks.clampPanelPosition(
        { top: -40, left: 999 },
        { width: 380, height: 240, viewportWidth: 1280, viewportHeight: 720 }
      ),
      { top: 12, left: 888 },
      "Panel positions should stay within viewport bounds."
    );
    assertDeepEqual(
      hooks.buildDraggedPanelPosition(
        {
          active: true,
          startTop: 40,
          startLeft: 800,
          startPointerX: 1000,
          startPointerY: 200,
        },
        { clientX: 1200, clientY: 140 },
        { width: 380, height: 240, viewportWidth: 1280, viewportHeight: 720 }
      ),
      { top: 12, left: 888 },
      "Drag helper should apply pointer deltas and clamp the final position."
    );
  });

  runTest("keyword matching", () => {
    const parsedRules = hooks.parseKeywordInput("alpha beta; alpha gamma ; ");
    assertEqual(parsedRules.length, 2, "Two keyword rules should be parsed.");
    assertEqual(parsedRules[0].raw, "alpha beta", "First rule should be normalized.");
    assertDeepEqual(
      parsedRules[0].terms,
      ["alpha", "beta"],
      "First rule terms should be normalized and split."
    );

    const matched = hooks.matchRules(parsedRules, hooks.normalizeForMatch("Alpha beta ticket"));
    assertDeepEqual(
      matched,
      { matched: true, rule: "alpha beta" },
      "Matching rule should report the original normalized rule."
    );

    const unmatched = hooks.matchRules(parsedRules, hooks.normalizeForMatch("alpha delta"));
    assertDeepEqual(
      unmatched,
      { matched: false, rule: "" },
      "Non-matching text should fail cleanly."
    );
  });

  runTest("top-post shortcut eligibility", () => {
    assertEqual(
      hooks.shouldUseTopPostShortcut("mutation"),
      true,
      "Routine mutation scans should allow the top-post shortcut."
    );
    assertEqual(
      hooks.shouldUseTopPostShortcut("manual-start"),
      false,
      "Manual scans should bypass the top-post shortcut."
    );
    assertEqual(
      hooks.shouldUseTopPostShortcut("save"),
      false,
      "Save-triggered scans should bypass the top-post shortcut."
    );
    assertEqual(
      hooks.shouldUseTopPostShortcut("route-change"),
      false,
      "Route-change scans should bypass the top-post shortcut."
    );
  });
}

function runPermalinkHelperTests(hooks) {
  runTest("permalink helpers", () => {
    assertEqual(
      hooks.buildCanonicalGroupPostUrl(TEST_GROUP_ID, TEST_POST_ID),
      TEST_GROUP_POST_URL,
      "Canonical group post URL builder should use the normalized ids."
    );
    assertEqual(
      hooks.buildCanonicalGroupPostUrl(TEST_GROUP_ID, "short"),
      "",
      "Canonical group post URL builder should reject invalid post ids."
    );
    assertDeepEqual(
      hooks.buildPermalinkDetails(),
      { permalink: "", source: "unavailable" },
      "Permalink details builder should provide a stable default shape."
    );
    assertDeepEqual(
      hooks.buildPermalinkDetails("https://example.com/post/1", "source"),
      { permalink: "https://example.com/post/1", source: "source" },
      "Permalink details builder should keep explicit values."
    );
    assertDeepEqual(
      hooks.buildGroupScopedPermalinkDetails(
        TEST_GROUP_ID,
        TEST_POST_ID,
        "helper_source",
        TEST_GROUP_ID
      ),
      {
        permalink: TEST_GROUP_POST_URL,
        source: "helper_source",
      },
      "Group-scoped permalink helper should build canonical group post URLs."
    );
    assertDeepEqual(
      hooks.buildGroupScopedPermalinkDetails(
        OTHER_GROUP_ID,
        TEST_POST_ID,
        "helper_source",
        TEST_GROUP_ID
      ),
      { permalink: "", source: "unavailable" },
      "Group-scoped permalink helper should reject expected-group mismatches."
    );
    assertEqual(
      hooks.extractGroupRouteQueryPostId(
        new URL(`https://www.facebook.com/groups/${TEST_GROUP_ID}/?story_fbid=${TEST_POST_ID}`)
      ),
      TEST_POST_ID,
      "Group route query parser should read story_fbid."
    );
    assertEqual(
      hooks.extractGroupRouteQueryPostId(
        new URL(`https://www.facebook.com/groups/${TEST_GROUP_ID}/?set=gm.${TEST_POST_ID}`)
      ),
      TEST_POST_ID,
      "Group route query parser should read gm set ids."
    );
    assertEqual(
      hooks.extractPhotoRouteGroupId(
        new URL(TEST_PHOTO_GM_HREF),
        TEST_GROUP_ID
      ),
      TEST_GROUP_ID,
      "Photo route group-id parser should prefer idorvanity when it matches the expected group."
    );
    assertEqual(
      hooks.extractPhotoRouteGroupId(
        new URL(
          `https://www.facebook.com/photo/?fbid=1234567890&set=gm.${TEST_POST_ID}&idorvanity=${OTHER_GROUP_ID}`
        ),
        TEST_GROUP_ID
      ),
      "",
      "Photo route group-id parser should reject mismatched idorvanity values."
    );
    assertDeepEqual(
      hooks.extractPhotoRoutePermalinkDetails(
        new URL(TEST_PHOTO_GM_HREF),
        TEST_GROUP_ID
      ),
      {
        permalink: TEST_GROUP_POST_URL,
        source: "photo_gm_anchor",
      },
      "Photo route permalink helper should normalize gm-based photo URLs."
    );
    assertDeepEqual(
      hooks.extractPhotoRoutePermalinkDetails(
        new URL(
          `https://www.facebook.com/photo/?fbid=1234567890&set=gm.${TEST_POST_ID}&idorvanity=${OTHER_GROUP_ID}`
        ),
        TEST_GROUP_ID
      ),
      { permalink: "", source: "unavailable" },
      "Photo route permalink helper should reject mismatched groups."
    );
    assertEqual(
      hooks.getPermalinkSourcePriority("groups_post_anchor"),
      0,
      "Direct group post anchors should have highest priority."
    );
    assertEqual(
      hooks.getPermalinkSourcePriority("pcb_anchor"),
      4,
      "PCB anchors should remain a lower-priority fallback."
    );
    assertEqual(
      hooks.isCommentPermalinkHref(
        `${TEST_GROUP_POST_URL}/?comment_id=111`
      ),
      true,
      "Comment permalinks should be detected."
    );
    assertEqual(
      hooks.isCommentPermalinkHref(`${TEST_GROUP_POST_URL}/`),
      false,
      "Non-comment permalinks should not be marked as comment links."
    );
    assertDeepEqual(
      hooks.extractCanonicalPermalinkFromHref(
        `${TEST_GROUP_POST_URL}/?__cft__[0]=abc`,
        TEST_GROUP_ID
      ),
      {
        permalink: TEST_GROUP_POST_URL,
        source: "groups_post_anchor",
      },
      "Direct group post permalinks should canonicalize cleanly."
    );
    assertDeepEqual(
      hooks.extractCanonicalPermalinkFromHref(
        `https://www.facebook.com/groups/${TEST_GROUP_ID}/permalink/${TEST_POST_ID}/?foo=bar`,
        TEST_GROUP_ID
      ),
      {
        permalink: TEST_GROUP_POST_URL,
        source: "group_permalink_anchor",
      },
      "Group permalink routes should canonicalize to posts."
    );
    assertDeepEqual(
      hooks.extractCanonicalPermalinkFromHref(
        `https://www.facebook.com/groups/${TEST_GROUP_ID}/?set=gm.${TEST_POST_ID}`,
        TEST_GROUP_ID
      ),
      {
        permalink: TEST_GROUP_POST_URL,
        source: "group_query_anchor",
      },
      "Group query routes with gm ids should canonicalize."
    );
    assertDeepEqual(
      hooks.extractCanonicalPermalinkFromHref(
        `https://www.facebook.com/permalink.php?id=${TEST_GROUP_ID}&story_fbid=${TEST_POST_ID}`,
        TEST_GROUP_ID
      ),
      {
        permalink: TEST_GROUP_POST_URL,
        source: "permalink_php_anchor",
      },
      "permalink.php routes should canonicalize when group id and story id exist."
    );
    assertDeepEqual(
      hooks.extractCanonicalPermalinkFromHref(TEST_PHOTO_GM_HREF, TEST_GROUP_ID),
      {
        permalink: TEST_GROUP_POST_URL,
        source: "photo_gm_anchor",
      },
      "Photo routes with gm set ids and idorvanity should canonicalize to the group post URL."
    );
    assertDeepEqual(
      hooks.extractCanonicalPermalinkFromHref(
        `https://www.facebook.com/groups/${OTHER_GROUP_ID}/posts/${TEST_POST_ID}`,
        TEST_GROUP_ID
      ),
      { permalink: "", source: "unavailable" },
      "Expected-group mismatch should reject unrelated group permalinks."
    );
    assertEqual(
      hooks.getPostContainerSourceLabel(PERMALINK_ANCHOR_SELECTOR),
      "permalink_anchor",
      "Primary permalink selector should render as permalink_anchor."
    );
    assertEqual(
      hooks.getPostContainerSourceLabel('[role="feed"] > div'),
      "feed_child",
      "Feed child selector should render as a short label."
    );
  });
}

function runPostIdExtractionTests(hooks, context) {
  runTest("post id extraction", () => {
    assertEqual(hooks.extractPostIdFromValue(`${TEST_GROUP_POST_URL}/`), TEST_POST_ID, "Post id extractor should read ids from canonical permalinks.");
    assertEqual(
      hooks.extractPostIdFromValue(`photo/?fbid=1234567890&set=gm.${TEST_POST_ID}`),
      TEST_POST_ID,
      "Post id extractor should prefer gm ids over photo fbid."
    );
    assertEqual(
      hooks.extractMetadataPostIdFromValue(`"ft_ent_identifier":"${TEST_POST_ID}"`),
      TEST_POST_ID,
      "Metadata post id extractor should read ft_ent_identifier."
    );

    const metadataContainer = createMetadataContainer(
      context,
      `"ft_ent_identifier":"${TEST_POST_ID}"`
    );
    assertDeepEqual(
      hooks.extractPostId("", metadataContainer),
      {
        postId: TEST_POST_ID,
        source: "metadata",
      },
      "Post-id extraction should preserve metadata as a distinct source classification."
    );

    const container = createAnchorHrefContainer(context, TEST_PHOTO_GM_HREF);

    assert(
      hooks.collectPostIdSourceValues("", container).some((value) => {
        return String(value).includes(`set=gm.${TEST_POST_ID}`);
      }),
      "Post-id source collection should include descendant anchor href values."
    );
    assertDeepEqual(
      hooks.extractPostId("", container),
      {
        postId: TEST_POST_ID,
        source: "fallback",
      },
      "Post-id fallback should recover gm ids from descendant anchor href values."
    );
  });
}

function runIdentityAndStoreTests(hooks) {
  runTest("warmup state helper", () => {
    assertDeepEqual(
      hooks.buildPermalinkWarmupState(),
      {
        warmupAttempted: false,
        warmupResolved: false,
        warmupCandidateCount: 0,
      },
      "Warmup state helper should provide a stable default shape."
    );
    assertDeepEqual(
      hooks.buildPermalinkWarmupState({
        warmupAttempted: 1,
        warmupResolved: "yes",
        warmupCandidateCount: "4.8",
      }),
      {
        warmupAttempted: true,
        warmupResolved: true,
        warmupCandidateCount: 4.8,
      },
      "Warmup state helper should normalize booleans and preserve numeric candidate counts."
    );
  });

  runTest("post keys and dedupe", () => {
    assertEqual(
      hooks.getPostKey({ postId: "12345" }),
      "id:12345",
      "postId-based key should win first."
    );
    assertEqual(
      hooks.getPostKey({ permalink: "https://www.facebook.com/groups/x/posts/999/" }),
      "url:https://www.facebook.com/groups/x/posts/999/",
      "Permalink-based key should be used when a post id is missing."
    );

    const compositeKey = hooks.getPostKey({
      author: "Alice",
      timestampText: "today 10:30",
      text: "Alpha ticket available",
    });
    assert(
      compositeKey.startsWith("author:alice||time:today1030||text:"),
      "Composite fallback key should use author, time, and text."
    );

    assertDeepEqual(
      hooks.buildPostKeyFragments({
        author: "Alice",
        timestampText: "today 10:30",
        text: "Alpha ticket available",
      }),
      {
        compactText: "alphaticketavailable",
        compactAuthor: "alice",
        compactTime: "today1030",
      },
      "Post key fragments should normalize author/time/text independently."
    );

    assertEqual(
      hooks.buildCompositePostKey({
        compactAuthor: "alice",
        compactTime: "today1030",
        compactText: "alphaticket",
      }),
      "author:alice||time:today1030||text:alphaticket",
      "Composite key builder should include author, time, and text when all exist."
    );

    const uniquePosts = hooks.collectUniquePostsByKey(
      [
        { postId: "1", text: "a" },
        { postId: "1", text: "b" },
        { postId: "2", text: "c" },
      ],
      10
    );
    assertEqual(uniquePosts.length, 2, "Unique post collection should drop duplicate keys.");

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
    assertEqual(deduped.length, 3, "Dedupe should keep only unique extracted posts.");
  });

  runTest("post key aliases and top-post snapshot matching", () => {
    const canonicalPost = {
      postId: "9876543210123456",
      permalink: "https://www.facebook.com/groups/123456789012345/posts/9876543210123456",
      author: "Alice",
      text: "Alpha ticket available",
    };
    const fallbackOnlyPost = {
      author: "Alice",
      text: "Alpha ticket available",
    };

    assertDeepEqual(
      hooks.getPostKeyAliases(canonicalPost),
      [
        "id:9876543210123456",
        "url:https://www.facebook.com/groups/123456789012345/posts/9876543210123456",
        "author:alice||text:alphaticketavailable",
        "alice||alphaticketavailable",
        "9876543210123456",
      ],
      "Canonical posts should expose id, permalink, composite, fallback, and legacy aliases."
    );

    const snapshot = hooks.buildLatestTopPostSnapshot(canonicalPost);
    assertDeepEqual(
      hooks.getLatestTopPostSnapshotKeys(snapshot),
      hooks.getPostKeyAliases(canonicalPost),
      "Stored top-post snapshot keys should preserve all aliases."
    );
    assertEqual(
      hooks.matchesLatestTopPostSnapshot(snapshot, fallbackOnlyPost),
      true,
      "Top-post snapshot matching should survive missing permalink/postId in later scans."
    );
  });

  runTest("seen-post aliases survive missing permalink in later scans", () => {
    const groupId = "123456789012345";
    const canonicalPost = {
      postId: "9876543210123456",
      permalink: "https://www.facebook.com/groups/123456789012345/posts/9876543210123456",
      author: "Alice",
      text: "Alpha ticket available",
    };
    const fallbackOnlyPost = {
      author: "Alice",
      text: "Alpha ticket available",
    };

    hooks.clearSeenPostsForGroup(groupId);
    hooks.markPostSeen(groupId, canonicalPost);

    assertEqual(
      hooks.hasSeenPost(groupId, fallbackOnlyPost),
      true,
      "Seen-post lookup should still match when a later extraction only has fallback identity."
    );
  });

  runTest("seen-post alias capacity avoids trimming active posts too aggressively", () => {
    const targetCount = 8;
    const dynamicSeenLimit = hooks.getDynamicSeenPostLimit(targetCount);
    const groupStore = {};

    for (let index = 0; index < targetCount; index += 1) {
      const post = {
        postId: `90000000000000${index}`,
        permalink: `https://www.facebook.com/groups/123456789012345/posts/90000000000000${index}`,
        author: `Author ${index}`,
        text: `Alpha ticket ${index}`,
      };
      const timestamp = new Date(Date.UTC(2026, 3, 10, 0, 0, index)).toISOString();
      for (const key of hooks.getPostKeyAliases(post)) {
        groupStore[key] = timestamp;
      }
    }

    const trimmedSeenStore = hooks.trimSeenPostGroupStore(groupStore, dynamicSeenLimit);
    const retainedPost = {
      author: "Author 0",
      text: "Alpha ticket 0",
    };
    const retainedAliases = hooks.getPostKeyAliases(retainedPost);

    assertEqual(
      retainedAliases.some((key) => Boolean(trimmedSeenStore[key])),
      true,
      "Seen-store trimming should still retain at least one alias for posts within the active target window."
    );
  });

  runTest("seen-stop helpers", () => {
    const seenStopState = hooks.createSeenPostStopState({
      enabled: true,
      minNewPostsBeforeStop: 1,
      consecutiveSeenThreshold: 3,
    });

    hooks.applySeenPostStopObservation(seenStopState, { postKey: "new-1", seen: false });
    hooks.applySeenPostStopObservation(seenStopState, { postKey: "seen-1", seen: true });
    hooks.applySeenPostStopObservation(seenStopState, { postKey: "seen-2", seen: true });

    assertEqual(
      seenStopState.triggered,
      false,
      "Seen-stop should remain inactive before threshold."
    );

    hooks.applySeenPostStopObservation(seenStopState, { postKey: "seen-3", seen: true });
    assertEqual(
      seenStopState.triggered,
      true,
      "Seen-stop should trigger after the configured consecutive threshold."
    );
    assert(
      seenStopState.stopReason.includes("3"),
      "Seen-stop reason should mention the threshold."
    );

    const duplicateSeenStopState = hooks.createSeenPostStopState({
      enabled: true,
      minNewPostsBeforeStop: 1,
      consecutiveSeenThreshold: 2,
    });
    hooks.applySeenPostStopObservation(duplicateSeenStopState, { postKey: "new-1", seen: false });
    hooks.applySeenPostStopObservation(duplicateSeenStopState, { postKey: "seen-1", seen: true });
    hooks.applySeenPostStopObservation(duplicateSeenStopState, { postKey: "seen-1", seen: true });
    assertEqual(
      duplicateSeenStopState.consecutiveSeenCount,
      1,
      "Duplicate post keys should be ignored by seen-stop observation."
    );
  });

  runTest("seen/history store shaping", () => {
    const trimmedSeenStore = hooks.trimSeenPostGroupStore(
      {
        old: "2026-04-08T09:00:00.000Z",
        newest: "2026-04-08T11:00:00.000Z",
        middle: "2026-04-08T10:00:00.000Z",
      },
      2
    );
    assertDeepEqual(
      Object.keys(trimmedSeenStore),
      ["newest", "middle"],
      "Seen-post trimming should keep the newest entries."
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

    assertEqual(mergedHistory.length, 4, "Merged history should keep four entries.");
    assertEqual(
      mergedHistory[0].postKey,
      "replace",
      "Incoming entries should stay at the front."
    );
    assertEqual(
      mergedHistory[1].postKey,
      "new",
      "Incoming entries should preserve their given order."
    );
    assert(
      mergedHistory.some((entry) => entry.groupId === "g2" && entry.postKey === "other-group"),
      "History merge should preserve other-group entries."
    );
    assertEqual(
      mergedHistory.filter((entry) => entry.groupId === "g1" && entry.postKey === "replace").length,
      1,
      "Duplicate history keys should be replaced."
    );
  });
}

function runPresentationTests(hooks) {
  runTest("notification formatting", () => {
    const notificationFields = hooks.getNotificationFields({
      author: "Alice",
      includeRule: "alpha beta",
      text: "Alpha beta ticket available right now.",
      permalink: "https://example.com/post/1",
    });

    assertDeepEqual(
      notificationFields,
      {
        groupName: "Test Group",
        author: "Alice",
        includeRule: "alpha beta",
        text: "Alpha beta ticket available right now.",
        permalink: "https://example.com/post/1",
      },
      "Notification fields should include normalized group, author, rule, text, and permalink."
    );

    assertDeepEqual(
      hooks.buildCompactNotificationSegments(notificationFields),
      [
        "Test Group",
        "Alice",
        "match: alpha beta",
        "Alpha beta ticket available right now.",
      ],
      "Compact notification segments should preserve field order."
    );

    const compactBody = hooks.buildCompactNotificationBody({
      author: "Alice",
      includeRule: "alpha beta",
      text: "Alpha beta ticket available right now.",
      permalink: "https://example.com/post/1",
    });
    assert(
      compactBody.includes("Test Group") &&
        compactBody.includes("Alice") &&
        compactBody.includes("match: alpha beta"),
      "Compact notification body should include group, author, and include rule."
    );

    assertDeepEqual(
      hooks.buildRemoteNotificationLines(notificationFields),
      [
        "社團: Test Group",
        "作者: Alice",
        "關鍵字: alpha beta",
        "內容: Alpha beta ticket available right now.",
        "連結: https://example.com/post/1",
      ],
      "Remote notification lines should include the permalink when present."
    );

    const remoteBody = hooks.buildRemoteNotificationBody({
      author: "Alice",
      includeRule: "alpha beta",
      text: "Alpha beta ticket available right now.",
      permalink: "https://example.com/post/1",
    });
    assert(
      remoteBody.includes("社團: Test Group") &&
        remoteBody.includes("作者: Alice") &&
        remoteBody.includes("連結: https://example.com/post/1"),
      "Remote notification body should include group, author, and permalink lines."
    );
  });

  runTest("history/debug presentation helpers", () => {
    const highlighted = hooks.renderHighlightedHistoryContent(
      "alpha beta ticket",
      "alpha beta"
    );
    assert(
      highlighted.includes('<span style="color:#fbbf24;">alpha</span>') &&
        highlighted.includes('<span style="color:#fbbf24;">beta</span>'),
      "History highlighter should wrap matched include terms."
    );

    const fieldRow = hooks.renderHistoryFieldRow("連結", '<a href="https://example.com">Open</a>');
    assert(
      fieldRow.includes("連結") && fieldRow.includes('href="https://example.com"'),
      "History field row should keep the label and render the provided value HTML."
    );
  });
}

function runRuntimeStateTests(hooks) {
  runTest("runtime state helpers", () => {
    assertDeepEqual(
      hooks.buildResetScanRuntimeState(),
      {
        latestPosts: [],
        latestScan: null,
        latestError: "",
      },
      "Reset scan runtime state should provide a stable empty shape."
    );

    assertDeepEqual(
      hooks.buildFailedScanRuntimeState(new Error("boom")),
      { latestError: "boom" },
      "Failed scan runtime state should normalize the error message."
    );

    assertDeepEqual(
      hooks.buildCompletedNotificationState(
        { title: "t", status: "pending" },
        ["gm_sent", "ntfy_sent"]
      ),
      { title: "t", status: "gm_sent, ntfy_sent" },
      "Completed notification state should join channel status parts."
    );

    assertEqual(
      hooks.getLatestNotificationStatusLabel({ status: "discord_sent" }),
      "discord_sent",
      "Latest notification status should surface the stored status."
    );
    assertEqual(
      hooks.getLatestNotificationStatusLabel(null),
      "(本次無)",
      "Latest notification status should provide an empty fallback."
    );
  });
}

function runTests(hooks, context) {
  runCoreBehaviorTests(hooks);
  runConfigAndLayoutTests(hooks);
  runPermalinkHelperTests(hooks);
  runPostIdExtractionTests(hooks, context);
  runIdentityAndStoreTests(hooks);
  runPresentationTests(hooks);
  runRuntimeStateTests(hooks);
}

const { hooks, context } = loadTestHooks();
runTests(hooks, context);

console.log("Smoke test passed.");
console.log(`Checked: ${userScriptPath}`);
