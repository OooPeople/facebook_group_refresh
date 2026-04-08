# facebook_group_refresh

Tampermonkey-based monitoring project for Facebook group pages.

This project is intentionally narrow in scope:
- Detect new group posts that match user-defined keywords.
- Notify the user through opt-in channels such as `ntfy`, Discord, or Telegram.
- Minimize page actions and avoid unnecessary automation.

## Current status

- Planning and scaffolding only.
- No production userscript exists yet.
- Do not add scraping-at-scale, auto-login, or engagement features unless the user explicitly asks.

## Project goals

- Favor a browser-resident userscript over server-side crawling.
- Work with the user's existing logged-in Facebook session.
- Keep refresh cadence conservative and randomized.
- Deduplicate post alerts reliably.
- Make selectors, parsing, and notification delivery easy to swap independently.

## Non-goals

- No credential capture or storage.
- No bypass or evasion features for anti-bot systems.
- No automated posting, commenting, reacting, joining groups, or messaging.
- No hidden background services unless the user requests a separate tool.

## Expected layout

- `README.md`: human-facing overview and project status.
- `AGENTS.md`: agent-facing instructions for this subtree.
- `GIT_COMMIT_RULES.md`: commit message policy.
- `src/`: future source files, including the userscript when approved.
- `docs/`: optional design notes and debugging notes.
- `fixtures/`: optional saved HTML fragments or screenshots with sensitive data removed.

## Working rules

- Read `README.md` and `GIT_COMMIT_RULES.md` before making substantial changes.
- Keep the first implementation single-purpose: one group page, keyword match, dedupe, notify.
- Prefer plain JavaScript that runs directly in Tampermonkey on current Chromium browsers.
- Do not introduce a bundler, framework, or package manager unless the user asks or the maintenance payoff is clear.
- Keep runtime configuration in one obvious config object instead of scattering constants.
- Separate these concerns when code is added:
  - page detection and selectors
  - post extraction and normalization
  - keyword matching
  - dedupe state
  - notification adapters
  - UI/debug panel

## Safety and privacy

- Never commit cookies, tokens, session IDs, browser storage dumps, or screenshots containing private personal data.
- If sample HTML or screenshots are added under `fixtures/`, sanitize names, profile photos, links, and IDs when feasible.
- External notification endpoints must be opt-in and disabled by default in shared examples.
- Prefer local browser storage for small state such as seen post IDs; avoid exporting account data.

## Coding preferences

- Default to ASCII in source files unless existing files already require Unicode.
- Use clear names and short functions.
- Add comments only where the logic is not obvious.
- Prefer defensive DOM access and graceful fallback over brittle assumptions.
- Avoid hard-coding ephemeral CSS class names when stable attributes, URLs, or structural anchors exist.

## Change boundaries

- Ask before adding new third-party dependencies.
- Ask before adding any feature that sends data off-device by default.
- Ask before adding headless browser tooling, OCR, CAPTCHA handling, or stealth automation.

## Validation

- There is no automated test suite yet.
- For non-trivial changes, document the manual verification steps in the final response.
- If tooling is added later, update this file with exact commands to run.

## Git and commits

- Follow Conventional Commits.
- Keep commits small and single-purpose.
- Use a meaningful scope when it helps, such as `docs`, `config`, `scripts`, or `tampermonkey`.
- See `GIT_COMMIT_RULES.md` for the detailed commit message guidance.

## When creating the first userscript

- Keep the first version read-only except for page refresh and local notification state.
- Support include and exclude keywords from day one.
- Include a visible debug mode so selector breakage is diagnosable.
- Build dedupe around stable post identifiers where possible, with text hash fallback only if needed.
