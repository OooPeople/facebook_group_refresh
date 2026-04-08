# Task Breakdown

This checklist began as the implementation plan. Most core items below are now completed in the current userscript.

## Phase 1: Scaffold the userscript

- done: create the initial Tampermonkey metadata block
- done: create a single config object with defaults
- done: add local storage helpers
- done: add a fixed control panel shell
- done: add a collapsible debug panel shell

## Phase 2: Panel behavior

- done: implement include keyword input
- done: implement exclude keyword input
- done: implement save action
- done: implement pause and resume action
- done: implement scan-now action
- done: implement test-notification action
- done: implement debug visibility toggle
- done: implement include-keyword help modal
- done: implement settings modal
- done: implement match-history modal

## Phase 3: Page and post detection

- done: detect whether the current page is a Facebook group page
- done: identify the feed container
- done: extract recent post containers
- done: normalize each post into the V1 data model
- done: record extraction source for debugging
- done: accumulate posts across multiple visible scroll windows

## Phase 4: Matching and dedupe

- done: implement keyword parser using `;` as OR and space as AND
- done: implement include matching
- done: implement exclude matching
- done: implement dedupe store with bounded history
- done: namespace seen posts by group identifier
- done: add compatibility with legacy dedupe keys
- pending: further improve stable `postId` and timestamp extraction where Facebook variants differ

## Phase 5: Notifications

- done: implement userscript notification
- done: add notification preview text
- done: store last notification result for debug output
- done: implement optional `ntfy` topic support
- pending: optionally expose browser-native notification as a user-facing setting if needed later

## Phase 6: Scan loop

- done: implement mutation-driven scan trigger
- done: debounce repeated DOM updates
- done: add conservative randomized refresh fallback
- done: ensure pause mode stops both scan and refresh scheduling
- done: add conservative auto-load-more scanning across multiple windows

## Phase 7: Debugging support

- done: surface current config values
- done: surface latest scan summary
- done: surface latest extraction results
- done: surface latest match and dedupe decisions
- done: surface latest error and notification result

## Phase 8: Manual verification

- done: test include-only rules
- done: test duplicate detection
- done: test panel persistence after reload
- done: test pause and resume behavior
- done: test selector failure visibility through debug output
- done: test `ntfy` setting and test-notification flow
- pending: regression-check no-keyword mode
- pending: regression-check exclude-rule suppression after recent notification changes
