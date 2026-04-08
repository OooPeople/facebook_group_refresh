# facebook_group_refresh

Tampermonkey-based monitoring project for Facebook group pages.

This project is intentionally narrow in scope:
- Detect new group posts that match user-defined keywords.
- Notify the user through opt-in channels such as `ntfy` or Discord.
- Minimize page actions and avoid unnecessary automation.

## Current status

- A working Tampermonkey userscript exists under `src/facebook_group_refresh.user.js`.
- Current implemented scope includes panel controls, include/exclude matching, dedupe, debug output, `ntfy` and Discord support, conservative refresh/scroll scanning, and a minimal Node-based smoke test.
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
- `src/`: source files, including the active userscript.
- `scripts/`: local validation helpers such as the smoke test.
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

- A minimal smoke test exists at `scripts/smoke_check_userscript.js`.
- Preferred validation command:
  - `& 'C:\Program Files\nodejs\node.exe' 'e:\P3\xx\ticket\facebook_group_refresh\scripts\smoke_check_userscript.js'`
- For non-trivial changes, document the manual verification steps in the final response.
- If validation steps change later, update this file with exact commands to run.

## Git and commits

- Follow Conventional Commits.
- Keep commits small and single-purpose.
- Use a meaningful scope when it helps, such as `docs`, `config`, `scripts`, or `tampermonkey`.
- See `GIT_COMMIT_RULES.md` for the detailed commit message guidance.

## Current implementation guardrails

- Keep the script read-only except for page refresh, local browser storage, and explicit notification delivery.
- Preserve include and exclude keyword support.
- Preserve a visible debug mode so selector breakage is diagnosable.
- Preserve dedupe around stable post identifiers where possible, with text-signature fallback only if needed.
- Keep notification channels opt-in. Local notifications may remain available, but remote delivery such as `ntfy` must stay user-configured.
