# Task Breakdown

## Phase 1: Scaffold the userscript

- create the initial Tampermonkey metadata block
- create a single config object with defaults
- add local storage helpers
- add a fixed control panel shell
- add a collapsible debug panel shell

## Phase 2: Panel behavior

- implement include keyword input
- implement exclude keyword input
- implement save action
- implement pause and resume action
- implement scan-now action
- implement test-notification action
- implement debug visibility toggle

## Phase 3: Page and post detection

- detect whether the current page is a Facebook group page
- identify the feed container
- extract the most recent N post containers
- normalize each post into the V1 data model
- record extraction source for debugging

## Phase 4: Matching and dedupe

- implement keyword parser using `;` as OR and space as AND
- implement include matching
- implement exclude matching
- implement dedupe store with bounded history
- namespace seen posts by group identifier

## Phase 5: Notifications

- implement browser notification
- add notification preview text
- store last notification result for debug output
- keep remote notification hooks disabled by default

## Phase 6: Scan loop

- implement mutation-driven scan trigger
- debounce repeated DOM updates
- add conservative randomized refresh fallback
- ensure pause mode stops both scan and refresh scheduling

## Phase 7: Debugging support

- surface current config values
- surface latest scan summary
- surface latest extraction results
- surface latest match and dedupe decisions
- surface latest error and notification result

## Phase 8: Manual verification

- test with no keywords
- test include-only rules
- test exclude rules
- test duplicate detection
- test panel persistence after reload
- test pause and resume behavior
- test selector failure visibility
