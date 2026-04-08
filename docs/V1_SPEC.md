# V1 Specification

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
- Read-only behavior except for page refresh and local browser storage

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
- `Exclude keywords` input
- `Save` button
- `Pause monitoring` button
- `Scan now` button
- `Test notification` button
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

V1 should keep configuration in local browser storage with clear keys.

Suggested settings:
- include keywords
- exclude keywords
- monitoring paused flag
- debug panel visible flag
- refresh min seconds
- refresh max seconds
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

## Notification behavior

V1 notification channels:
- local browser notification
- optional `ntfy` if enabled later

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
- `fb_group_refresh_paused`
- `fb_group_refresh_debug_visible`
- `fb_group_refresh_seen_posts`
- `fb_group_refresh_last_notification`
- `fb_group_refresh_refresh_range`

## Manual verification checklist

Before calling V1 usable, verify:

1. panel renders on a supported group page
2. saving keywords persists across reload
3. pause button blocks refresh and scans
4. scan-now works without reload
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
