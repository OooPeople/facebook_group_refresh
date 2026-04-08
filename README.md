# facebook_group_refresh

`facebook_group_refresh` is a planned Tampermonkey project for monitoring Facebook group pages and notifying the user when new posts match specific keywords.

## Status

- Experimental userscript created for manual testing.
- Selector and extraction logic still need real-page validation.
- The current direction remains a browser-resident Tampermonkey script, not a server crawler.

## Why this shape

Facebook group monitoring is better treated as an in-browser assistant that works with a normal logged-in session. The first version should stay conservative:
- refresh or observe the current group page
- extract a small set of recent posts
- match include and exclude keywords
- avoid duplicate alerts
- notify through an explicit, user-owned channel

## Initial scope

- One active Facebook group page at a time
- Keyword-based detection for new posts
- Local dedupe state
- Local debug visibility
- Optional notification adapters added only when enabled

## Out of scope for v1

- Automated login
- Automated likes, comments, or posting
- Background headless scraping
- Large-scale multi-account monitoring
- Anti-detection or stealth features

## Planned structure

- `AGENTS.md`: agent instructions for this project
- `GIT_COMMIT_RULES.md`: commit policy
- `src/`: future userscript source
- `docs/`: optional design and troubleshooting notes
- `fixtures/`: optional sanitized sample data

## Current design docs

- `docs/V1_SPEC.md`: agreed V1 behavior, UI, matching, dedupe, notification, and debug requirements
- `docs/TASK_BREAKDOWN.md`: implementation phases and task checklist

## Script path

- `src/facebook_group_refresh.user.js`: Tampermonkey userscript for manual testing in Facebook group pages

## Notes for future implementation

- Prefer resilient selectors and observable DOM changes over fragile class-based scraping.
- Use randomized low-frequency refresh only as a fallback when passive observation is insufficient.
- Keep notification logic isolated from page parsing logic.
- Treat privacy and account safety as first-class constraints.
