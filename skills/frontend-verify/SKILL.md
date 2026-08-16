# Frontend verification loop

After building or changing anything a browser renders (HTML, CSS, frontend JS, a dev server response), verify it yourself with the `browser_*` tools before reporting the work as done. Never ask the human to check what you can check.

## The loop

1. **Open** — `browser_open` with the file, directory, or localhost URL you changed. Local paths are served automatically. The result already lists console errors raised during load.
2. **Console first** — `browser_console` (use `errorsOnly: true` on noisy pages). A healthy page has zero errors and zero failed requests. A failed request for a CDN resource means the page cannot work offline — say so.
3. **Read, don't guess** — `browser_read`:
   - `mode: text` to confirm the rendered copy and visible content.
   - `mode: styles` with a selector to assert layout facts (box size, display, color) instead of guessing from source.
   - `mode: html` when you need the actual DOM structure.
4. **Exercise interactions** — `browser_interact` to click buttons, fill forms, and press keys the user would. Every interaction reports new console errors; investigate any.
5. **Screenshot for the human** — `browser_screenshot` once the page is in the state worth showing. The PNG lands in the workspace so the human can open it from the conversation. Screenshot both the healthy state and any visual bug you found.
6. **Fix and re-verify** — edit the source, then repeat from step 1 (a fresh `browser_open` reloads the page). Close pages with `browser_close` when done.

## What to report

- The exact checks that passed (console clean, N interactions exercised, text/styles asserted).
- Any error you saw verbatim, with the fix you applied.
- The screenshot path(s) for the human.
- What you could NOT verify (e.g. pointer lock, real GPU rendering, cross-browser differences) — name it instead of implying full coverage.

## Boundaries

- Remote hosts outside localhost need the user to extend `allowedHosts` in the dsh-preview config; ask rather than working around.
- The browser is headless: pointer lock, some GPU codepaths, and OS dialogs behave differently. Say so when they matter.
- Do not screenshot pages containing credentials or personal data.
