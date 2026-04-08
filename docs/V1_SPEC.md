# V1 Specification

This document started as a planning spec. Parts of it are now implemented in `src/facebook_group_refresh.user.js`.

## Objective

Build a Tampermonkey userscript for Facebook group pages that:
- observes or refreshes the current group page conservatively
- extracts a small set of recent posts
- matches include and exclude keywords
- deduplicates alerts
- shows a local control panel and debug panel
- sends notifications only through explicitly enabled channels

## V1 scope

- One Facebook group page at a time
- One userscript running in the active browser
- Keyword-based detection for new posts
- Local state only
- Conservative page interaction only: refresh, gentle scrolling for more posts, expanding collapsed post text, and local browser storage

## Out of scope

- Automated login
- Automated comments, reactions, posting, or joining groups
- Background headless crawling
- OCR, CAPTCHA handling, or stealth automation
- Multi-account orchestration

## User-facing panel

The panel should be fixed on the page and remain visible without blocking core content.

### Required controls

- `Include keywords` input
- `Include keyword help` button
- `Exclude keywords` input
- `Save` button
- `Pause monitoring` button
- `History` button
- `Settings` button
- `Debug panel toggle`

### Suggested status area

- current monitoring state: running or paused
- last scan time
- number of posts scanned in the latest pass
- number of seen posts stored locally
- notification channel status

## Keyword syntax

Use a simple syntax compatible with the earlier discussion.

- semicolon `;` means OR
- space means AND inside one rule

Examples:
- `rock;6880;5880`
  - match if any one token appears
- `rock 6880;rock 5880`
  - match if `rock` and `6880` both appear, or `rock` and `5880` both appear

### Include logic

- if include rules are empty, treat all posts as eligible before exclude filtering
- otherwise, at least one include rule must match

### Exclude logic

- if any exclude rule matches, suppress the notification even if include also matched

## Configuration model

V1 should keep configuration in userscript-managed local storage with clear keys. In the current implementation this is Tampermonkey storage first, with legacy browser storage migration support.

Suggested settings:
- include keywords
- exclude keywords
- `ntfy` topic
- Discord Webhook URL
- monitoring paused flag
- debug panel visible flag
- refresh min seconds
- refresh max seconds
- fixed refresh seconds
- refresh jitter enabled flag
- auto-load-more enabled flag
- maximum posts to inspect per scan
- notification settings for local browser and optional remote channel

## Post data model

Each extracted post should be normalized into a small object:

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

Notes:
- `postId` should prefer a stable identifier from the permalink or internal link if available.
- `normalizedText` should be used for matching.
- `source` should record which extraction strategy succeeded.

## Scan strategy

V1 should use a hybrid approach:

1. Try passive observation first.
2. Use low-frequency randomized refresh only as fallback.

### Passive observation

- use `MutationObserver` to detect new content added to the feed
- debounce repeated DOM churn before scanning
- avoid rescanning the full page on every tiny mutation

### Active refresh fallback

- schedule randomized refresh in a conservative range
- refresh only while monitoring is enabled
- skip refresh if a recent mutation-triggered scan already occurred

## Extraction strategy

The extractor should attempt stable anchors before brittle CSS classes.

Priority:
1. article-like containers or stable structural blocks
2. permalink anchors
3. timestamp links
4. text containers inside the post body

The extractor should inspect only the most recent N posts per pass.

Current implementation target:
- accumulate up to a user-configurable number of unique posts across multiple visible feed windows
- keep seen-post dedupe only for the currently monitored group
- keep seen-post history bounded to `target post count * 2`
- keep match-history records bounded to 10 globally, with group name shown per entry

## Matching flow

For each normalized post:

1. build normalized text
2. check dedupe first if a stable post ID exists
3. evaluate include rules
4. evaluate exclude rules
5. if matched and not excluded, notify and mark as seen

## Dedupe strategy

Preferred order:

1. stable post ID from permalink
2. permalink string
3. fallback hash of `author + timestampText + normalizedText`

The seen-post store should:
- keep a bounded history
- be namespaced by group
- include notification timestamp

Current implementation note:
- seen-post dedupe remains namespaced by group, but only the current group's bucket is retained
- match-history is now rendered as one global list rather than per-group buckets

## Notification behavior

V1 notification channels:
- local desktop notification
- optional `ntfy`
- optional Discord Webhook

Rules:
- test notification must not add a fake post into dedupe storage
- repeated scans of the same post must not re-notify
- notification text should include enough context to open the post quickly

Suggested notification content:
- group label if available
- author
- matched keyword or rule
- short text preview
- post link

Current implementation notes:
- local desktop notification via `GM_notification` is enabled by default
- browser-native notification code still exists internally but is not currently exposed as a user-facing setting
- `ntfy` is optional and only sends when a topic is configured
- Discord Webhook is optional and only sends when a webhook URL is configured

## Debug panel

The debug panel should be user-toggleable and hidden by default.

### Required debug fields

- current page URL
- whether the page is recognized as a supported Facebook group page
- monitoring state
- include and exclude keyword strings currently in effect
- last scan time
- refresh timer state
- number of recent posts found
- per-post summary:
  - post ID
  - author
  - timestamp text
  - short text preview
  - matched include rule
  - matched exclude rule
  - dedupe result
  - extraction source
- last notification result
- latest error message if any

## Error handling

V1 should fail soft.

- selector failure should not crash the whole script
- notification failure should be logged in debug mode
- corrupted local storage should reset to defaults safely

## Local storage keys

Suggested key prefix:

- `fb_group_refresh_*`

Suggested keys:
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

## Manual verification checklist

Before calling V1 usable, verify:

1. panel renders on a supported group page
2. saving keywords persists across reload
3. pause button blocks refresh and scans
4. resuming from paused state triggers a clean scan without reload
5. test notification works independently
6. debug toggle hides and shows the panel
7. new matching post notifies once
8. same post does not notify twice
9. exclude rules suppress notification
10. selector failure remains diagnosable from debug output

## Open risks

- Facebook DOM structure may change frequently
- permalink extraction may differ between group post variants
- localized UI may affect text-based selectors
- infinite-scroll feed updates may generate noisy mutations
- timestamp extraction is currently disabled in the implementation because Facebook DOM heuristics still confuse post time with comment time
