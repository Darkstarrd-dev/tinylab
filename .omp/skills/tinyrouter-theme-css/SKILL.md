---
name: tinylab-theme-css
description: "TinyLab frontend theme/CSS: attribute-driven theme system, CSS token layers, P0-P4 remediation, Uiverse component adaptation, playground mode-selector styling, and header nav reference control."
---

# TinyLab Frontend Theme & CSS


## tinylab-frontend-theme-css-audit


### TinyLab Frontend Theme & CSS Audit

Use when asked to analyze, adjust, or debug TinyLab frontend styles — especially when "complete HTML/CSS copied into the project doesn't work" or when evaluating theme-system flexibility/stability.

#### Architecture (why copied CSS fails)

The frontend is **not** a set of independent HTML/CSS components. It is:

1. **Server-selected embedded SPA shell** — `serveUI` (`internal/api/router.go:441-475`) picks `index.html` (playground build + `EnablePlayground`) or `index-nopg.html`; both share the same singleton shell (`.app > .top-header > .main > #page-content`, `#modal-overlay`, `#toast-container`, `#info-modal-overlay`). `app.js:31-106` empties `#page-content` via `innerHTML` and re-renders pages — copied DOM is wiped on navigation.

2. **Attribute-driven theme** — `<html>` gets `data-theme`, `data-theme-variant`, `data-theme-style`, `data-font-size`, `data-lang` from an inline bootstrap script (`index.html:13-25`, `index-nopg.html:13-25`) reading localStorage **before** CSS loads. Without these attributes, variant/style/font CSS selectors (`[data-theme="dark"][data-theme-variant="tokyo-night"]`, `[data-theme-style="soft"]`, `[data-font-size="l"]`) are inert — only `:root` dark defaults apply.

3. **Global CSS cascade** — `style.css` starts with `*{margin:0;padding:0;box-sizing:border-box}` (line 1) and has global `html,body`, `h2,h3`, `input,select,textarea,label`, `table,thead,tbody` rules. `playground.css` loads **after** `style.css` and forces `html,body,.app{overflow:hidden!important;height:100%!important}` (playground.css:6). Copied CSS leaks into / gets polluted by these globals.

4. **JS inline styles** — Many modules set `element.style.*` directly (`settings_modal.js:149`, `monitor_recent.js:117-125`, `monitor_state.js:138-183`, `providers.js:183-186`, `quickslots.js:513-555`, `combos.js:304-307`, `monitor_quota.js:144`). Inline author styles override external CSS without `!important`.

5. **`!important` clusters** — `style.css:266-268` (toolbar dims), `318-319` (status cells), `690` (modal focus), `1520-1647` (download layout), `1987` (reduced motion), `2175-2177` (gallery fullscreen), `2810` (theme modal width). External overrides need equal or higher specificity + `!important`.

6. **Embedded build** — `//go:embed all:static` (`web/embed.go:18-19`) bakes CSS into the binary at compile time. Editing `style.css` on disk and refreshing shows **old** CSS until `go build` re-runs. Server sets `Cache-Control: no-store` (`router.go:452`), so browser cache is not the issue — the embed FS is.

7. **Global JS, not ES modules** — Scripts share global `var`/`function` declarations; inline `onclick="globalFn()"` is the convention. Copied HTML referencing these functions fails if scripts aren't loaded in order (`index.html:95-170`).

#### Confirmed Bug: Theme Style not persisted by backend

- **Frontend sends it**: `theme.js:152-160` `persistToBackend()` sends `{darkVariant, lightVariant, style}`.
- **Backend drops it**: `internal/api/settings/register.go:275-282` — PATCH handler only writes `DarkVariant` and `LightVariant`, **no `Style` branch**.
- **Config supports it**: `config/types.go:318-325` `ThemeConfig.Style`; `defaults.go:224-226` defaults `Style` to `"default"` when empty.
- **Effect**: User selects `soft` → first-paint inline script draws `soft` → Settings API returns `style:"default"` → `theme.js:136-142` `initFromSettings` overwrites `currentStyle` to `"default"` → visible flash back to default. Style survives only in localStorage, not `config.yaml`.
- **Fix**: Add `if updates.Theme.Style != "" { cfg.Theme.Style = updates.Theme.Style }` in `register.go` after line 281.

#### Undefined CSS Tokens (bare usage = declaration invalid)

Tokens consumed via `var(--name)` with **no `--name:` definition** anywhere in `style.css` or `playground.css`. Bare usage makes the entire CSS declaration invalid (property falls back to inherited/initial). Tokens **with fallback** (`var(--name, fallback)`) are safe.

##### Bare usage (declaration fails silently)

| Token | Location(s) | Affected property |
|---|---|---|
| `--shadow-sm` | style.css:246 | `.btn:hover` box-shadow |
| `--error` | style.css:2779, 2801 | `.log-error-snippet`, `.attempt-error-msg` color |
| `--bg-card` | style.css:2093, 2095 | `.gallery-main`, `.gallery-pane` background |
| `--bg-main` | style.css:2099 | `.gallery-main-video` background |
| `--border` | style.css:2127, 2130 | scrollbar-color, scrollbar-thumb background |
| `--primary` | style.css:2085 | `.gallery-tree-clear-btn.active` border/color |
| `--font-mono` | style.css:2773, 2788 (bare); 2232, 2234 (has fallback) | font-family (bare sites fail) |
| `--font-body` | playground.css:164, 533 | font-size |
| `--bg-input` | playground.css:533 | background |
| `--bg-secondary` | style.css:2132; playground.css:581 (with `!important`, still fails) | background |
| `--text-primary` | playground.css:842; quickslots.js:516 inline | color |

##### Safe (has fallback) — NOT broken

| Token | Fallback | Location |
|---|---|---|
| `--accent-contrast` | `#fff` | style.css:2239 |
| `--warn-glow` | `rgba(255,167,38,0.10)` | style.css:2241 |
| `--color-primary` | `#4f46e5` | providers.js:184 inline |

#### Theme system layers (CSS)

1. `:root` (style.css:9-79) — dark defaults: colors, fonts, z-index, radii, shadows, transitions, spacing, blur, style-dimension tokens.
2. `[data-font-size="m"/"l"]` (style.css:81-104) — font-size token overrides.
3. `[data-theme="light"]` (style.css:106-142) — light-mode color/shadow overrides.
4. `[data-theme="dark"][data-theme-variant="..."]` (style.css:2254-2407) — 9 dark color variants.
5. `[data-theme="light"][data-theme-variant="..."]` (style.css:2409-2649) — 9 light color variants.
6. `[data-theme-style="sharp/soft/compact"]` (style.css:2654-2720) — 4 style presets (radii, shadows, transitions, weights, padding, blur).
7. `@media` responsive (style.css:883, 1993-2061) + `@container main` (style.css:2067-2072, requires `.main{container-type:inline-size}` at line 158).
8. Hardcoded exceptions: login overlay (style.css:1131-1214), gallery fullscreen (style.css:2152-2177), badge/btn status colors (style.css:248-252, 298-307).

#### JS theme system (theme.js)

- `ThemeSystem` IIFE global (`theme.js:9-350`): mode/variant/style registries, per-mode variant memory, localStorage + Settings API persistence.
- `init()` (line 115): restores from localStorage on load.
- `initFromSettings(settings)` (line 125): called from `settings.js:117` after Settings API response — **overwrites** local state with backend values.
- `applyMode(mode)` (line 74): writes `data-theme`, `data-theme-variant`, `data-theme-style` + localStorage.
- `setStyle(styleId)` (line 280): writes `data-theme-style` + localStorage + `persistToBackend()`.
- Variant registry: 9 dark + 9 light (`theme.js:14-43`); style registry: 4 presets (`theme.js:47-52`).

#### Correct CSS preview workflow

Do NOT copy complete HTML/CSS into the project. Instead:

1. Use the real `index.html` / `index-nopg.html` shell + real `style.css` / `playground.css`.
2. Load an additional preview-only override stylesheet after production CSS.
3. Edit only the override during exploration.
4. `go build` to re-embed (or use a dev server serving from filesystem).
5. Verify via HTTP (not `file://`), hard reload, check `getComputedStyle()` and `document.documentElement.dataset`.
6. Test across: dark/default, dark/non-default variant, light/default, light/non-default variant, sharp, soft, compact, font-size s/m/l, full build, no-playground build, narrow + desktop viewport.
7. After visual confirmation, merge confirmed rules into `style.css` and remove the override.

#### Improvement priority

- **P0**: Fix Style persistence bug; define all bare-usage tokens (or replace with existing tokens).
- **P1**: Add semantic token layer (`--surface-card`, `--status-success-bg`, etc.) and migrate hardcoded colors.
- **P2**: Move JS inline styles to classes (`is-error`, `is-hidden`, `is-selected`).
- **P3**: Namespace global selectors (`.app input` instead of bare `input`).
- **P4**: Establish browser smoke test covering theme matrix.

#### Doc sync

Changes to `style.css` or `theme.js` require updating `PROJECT_MAP.md` §18.2 (line 575) and §24 row 684 per AGENTS.md doc-sync mandate.

## tinylab-frontend-theme-remediation


### Goal
Improve TinyLab frontend CSS/theme maintainability without copying or duplicating the production HTML/CSS. Use the real embedded SPA shell over HTTP and accept route-B local style changes when necessary.

### Scope and order
Execute in this order:

1. **P0 — deterministic defects**
   - In `internal/api/settings/register.go`, ensure Settings PATCH merges all `config.ThemeConfig` fields: `DarkVariant`, `LightVariant`, and `Style`. Prefer a small pure helper such as `applyThemeUpdates` and add a targeted unit test for partial updates preserving untouched fields.
   - In `web/static/style.css`, define every bare-consumed custom property. Current known aliases: `--error`, `--primary`, `--border`, `--bg-card`, `--bg-main`, `--bg-input`, `--bg-secondary`, `--text-primary`, `--font-mono`, `--font-body`, `--shadow-sm`. Use values that expose the intended design (route B) and make them follow existing theme tokens where appropriate. Add light fixed-value overrides where needed.
   - Distinguish bare `var(--token)` from `var(--token, fallback)`; fallback consumers are not undefined-token defects.

2. **P1 — semantic token layer**
   - Add semantic aliases in the existing root/light token layers, e.g. surface, border, status, code, and interaction roles: `--surface-card`, `--surface-overlay`, `--border-subtle`, `--border-strong`, `--status-success-bg`, `--status-warning-bg`, `--status-danger-bg`, `--code-surface`, `--code-text`, `--interactive-active-bg`, `--interactive-active-text`, `--text-on-accent`.
   - Migrate hardcoded component colors in `style.css` and `playground.css` incrementally. Preserve the existing value for the default mode where possible; let variants override semantic tokens instead of adding selector-specific patches.
   - Watch for malformed comment boundaries and duplicate legacy selectors after automated edits. Keep one canonical rule per selector.

3. **P4 — establish the safety net before broad refactors**
   - Do not create a duplicated frontend or introduce a new browser framework when the repo has no existing harness convention.
   - Build the exact target binary because `//go:embed all:static` embeds CSS at compile time. Use a temporary directory and a strict config containing only a valid `port:` field.
   - Serve through HTTP, never `file://`. Attach browser listeners for console errors, page errors, and request failures before navigation. Treat only the known EventSource teardown `ERR_ABORTED` artifact as ignorable after confirming the route exists.
   - Check root attributes and computed values for all P0 tokens using a temporary probe element. Iterate 9 dark + 9 light variants, 4 styles, and font sizes `s/m/l`: 216 states. Override `window.apiPatch` with a resolved promise during the matrix to avoid persistence noise.

4. **P2 — dynamic state classes**
   - Migrate semantic visual state mutations from JS inline style to deterministic classes, retaining inline styles only for computed geometry, coordinates, widths, progress values, and true runtime layout values.
   - Typical migrations: combo success/error rows, provider temporary highlight and chevrons, monitor pager/session/quota state, quickslot filtering, download folding, info raw/pretty visibility, settings collapse, auth visibility/error.
   - Preserve global function declarations and inline `onclick` compatibility. Run `node --check` for each changed JS file.
   - Add matching selectors in CSS, including provider chevron rotation and hidden/expanded states.

5. **P3 — global CSS boundary**
   - Do not blindly rewrite the existing global baseline (`*`, `html/body`, bare headings/forms/tables) in one pass; it is compatibility infrastructure and high-risk layout foundation.
   - Freeze legacy globals and require namespaces for new modules (`.pg-*`, `.dl-*`, `.ge-*`, `.tr-*`, or feature-specific prefixes). New modules should provide their own form/table/heading baseline and consume semantic tokens.
   - Record this contract in `DESIGN.md`.

### Required synchronization
For any `web/static` or `web/playground/static-pg` change, update the applicable `PROJECT_MAP.md` entries and architecture docs in the same change. Theme/config persistence changes update `docs/config-registry-state-architecture.md`; monitor frontend changes update `docs/proxy-architecture.md`; download changes update `docs/download-architecture.md`; Playground CSS changes update `docs/playground-architecture.md`.

### Verification gates
- `go test ./...`
- `go vet ./...`
- `node --check` every migrated JS file
- `go build -o <default>.exe .`
- `go build -tags playground -o <playground>.exe .`
- Real browser smoke over HTTP for both full and no-playground binaries.
- Verify Theme.Style PATCH persists and survives a new page load.
- Verify no console/page/request errors and computed semantic tokens are non-empty and do not retain unresolved `var(...)`.
- Clean temporary binaries, servers, and smoke directories only after verification.

## tinylab-theme-css-audit


### TinyLab theme/CSS audit procedure

Use this before changing TinyLab frontend styles when a complete external HTML/CSS snippet does not reproduce correctly.

#### 1. Map the production shell

Read `web/static/index.html` and `index-nopg.html` first. Record:

- early `<html>` attributes: `data-theme`, `data-theme-variant`, `data-theme-style`, `data-font-size`, `data-lang`
- stylesheet order: core `style.css`, then Playground CSS/vendor CSS in the full build
- singleton IDs: `#page-content`, `#modal-overlay`, `#toast-container`, `#info-modal-overlay`
- common script order and build-specific modules

The frontend is an embedded SPA shell, not independently composable HTML documents. `app.js` clears and repopulates `#page-content`; duplicated shells/IDs are invalid.

#### 2. Trace theme state and persistence

Read `web/static/theme.js`, `app.js`, `settings.js`, `internal/config/types.go`, `internal/config/defaults.go`, and `internal/api/settings/register.go`.

Confirm this flow:

```text
inline localStorage bootstrap → CSS first paint → ThemeSystem.init()
→ Settings GET → ThemeSystem.initFromSettings()
```

Audit all three persisted theme fields: dark variant, light variant, and style. Verify the backend PATCH applies every field sent by `theme.js`; a missing field causes a setting to work until refresh and then be overwritten by the server.

#### 3. Audit CSS layers in order

Inspect `web/static/style.css` in these ranges:

1. global reset and root tokens
2. `[data-font-size]` and `[data-theme="light"]`
3. global layout/component selectors
4. responsive/container queries
5. dark/light variant selectors
6. `[data-theme-style]` style-dimension selectors
7. theme picker and late overrides

Remember specificity: same-element selectors such as `[data-theme][data-theme-variant]` override `:root`; inline styles override ordinary CSS; `!important` clusters require special handling. Check `playground.css` separately because it loads after `style.css` and contains global `html, body, .app` layout rules.

#### 4. Find bypasses

Search core and Playground CSS/JS for:

- hardcoded colors/backgrounds/borders
- undefined variables (`var(--token)` with no definition)
- `!important`
- `style="..."` and `.style.*` assignments
- global selectors (`*`, `html`, `body`, bare `input`, `table`, `h2`, `h3`)

Prioritize login, Playground bubbles/code blocks, Gallery fullscreen, selected navigation/status badges, and dynamic monitor/download rows. These commonly make a theme appear partially applied.

#### 5. Explain copied-snippet failures

Check the external snippet against the production context:

- exact DOM classes and element types
- root `data-*` attributes
- reset and `box-sizing`
- parent layout, `height`, overflow, container-query context
- stylesheet order and specificity
- inline JS mutations and global handlers
- absolute `/asset` URLs and HTTP origin
- duplicate singleton IDs

Do not validate by opening `index.html` with `file://`; use the real shell over HTTP.

#### 6. Verify embedded delivery

`//go:embed all:static` means edited CSS is compiled into the executable. Rebuild the exact target variant before judging a change. `Cache-Control: no-store` prevents browser caching but cannot update an old executable.

#### 7. Safe improvement sequence

1. Fix deterministic persistence/undefined-token defects.
2. Add semantic color tokens and migrate hardcoded component colors incrementally.
3. Move state styles from inline CSS to classes; retain inline styles only for computed geometry.
4. Reduce global selector scope only in small, browser-verified slices.
5. Explore with a preview override loaded after production CSS, then merge confirmed rules into production.
6. Exercise both full and no-Playground shells, dark/light variants, style presets, font sizes, responsive widths, and browser console/page errors.

For any `web/static` change, synchronize `PROJECT_MAP.md` §18.2/§24 and the applicable architecture documentation as required by `AGENTS.md`.

## uiverse-css-adaptation-pitfalls


### Uiverse CSS Adaptation Pitfalls

When adapting a Uiverse.io component (or any standalone HTML/CSS snippet) into an existing project, the visual result often diverges from the reference even when the CSS is copied faithfully. Diagnose these specific differences:

#### 1. Element type mismatch
- Uiverse components often use `<label>`, `<div>`, `<span>` — elements with **zero UA default styles**.
- Projects often need `<button>` for accessibility/routing. `<button>` has default `appearance: auto`, background, border, and padding from the browser UA stylesheet.
- **Fix**: always add `appearance:none; -webkit-appearance:none;` to the adapted `<button>` rule. Without this, UA styles layer under your CSS and produce visible differences.

#### 2. Global `*{box-sizing:border-box}`
- Many projects have `*{margin:0;padding:0;box-sizing:border-box}` on line 1.
- Standalone Uiverse snippets do NOT have this reset.
- Impact: `border` and `padding` are subtracted from `width`, so the content area is smaller than in the reference. `::before` with `inset:0` + `scale:1.02` overflows by a different amount.
- **Diagnose**: compare computed `width` / `content-box` size of tiles between single-page and project.

#### 3. Stacking context differences
- Uiverse often uses `z-index:-1` on the container itself to push it behind page content.
- Projects often substitute `isolation:isolate` (creates stacking context without lowering z-level) or have parent elements with `backdrop-filter` / `transform` / `will-change` that create **additional** stacking contexts.
- `::before` with `z-index:-1` behaves differently depending on whether the parent has `position:relative; z-index:1` (creating its own stacking context) vs the reference where the parent might not.
- **Diagnose**: inspect computed `z-index` and stacking context chain via DevTools "3-point" check (element → parent → root).

#### 4. DOM order vs CSS `order`
- Projects may need a specific DOM order for Tab-key accessibility or JS routing, then use CSS `order` to reorder visually.
- Uiverse references have DOM order === visual order.
- **Impact**: Tab key jumps non-visually; grid auto-placement may differ.
- **Diagnose**: Tab through the component; if focus order ≠ visual order, CSS `order` is reordering.

#### 5. CSS variable system
- Projects with theme systems use `var(--color)` that resolves differently at runtime across themes/variants.
- Uiverse references use static hex colors.
- **Impact**: theme switching changes colors unexpectedly; variable inheritance from `[data-theme]` overrides may produce wrong values.
- **Diagnose**: `getComputedStyle(el).getPropertyValue('--var-name')` in browser console across themes.

#### 6. `text-transform:uppercase` + long labels
- Uiverse labels ("Spring", "Winter") are short. Project labels ("Playground", "Settings") are longer.
- With `text-transform:uppercase`, "PLAYGROUND" ≈ 71px at 13px font, nearly filling an 84px tile.
- **Diagnose**: `el.scrollWidth > el.clientWidth` → text is clipping.

#### 7. Responsive media query partial overrides
- Projects have breakpoints that partially override font-size but NOT border-radius, scale, padding.
- This causes tile proportions to diverge at small sizes.
- **Diagnose**: compare computed styles at each breakpoint vs the reference at the same size.

#### 8. `transition:all` cannot animate `background-image`
- Gradient changes are instant; box-shadow/text-shadow animate.
- Same in both environments, but if the project adds extra `filter:brightness()` hover effects, the inconsistency is more visible.

#### 9. Build/embed mechanism
- Go projects using `//go:embed` bake CSS into the binary at compile time.
- Editing `style.css` on disk and refreshing the browser shows OLD CSS until `go build` re-runs.
- HTTP `Cache-Control: no-store` is set, so browser caching is NOT the issue — the embed FS is.
- **Diagnose**: check executable timestamp vs style.css timestamp; if exe is older, rebuild.

#### Diagnostic checklist
1. Does the adapted element have `appearance:none`? (for `<button>`)
2. Is `*{box-sizing:border-box}` affecting the component?
3. Does any parent have `backdrop-filter`, `transform`, `isolation`, or `will-change`?
4. Does CSS `order` reflow elements differently from DOM order?
5. Are CSS variables resolving to expected values in all themes?
6. Are labels longer than the reference, causing clipping under `text-transform:uppercase`?
7. Do responsive overrides change some properties but not others?
8. Does the build system embed assets (requiring recompile)?

## tinylab-playground-mode-selector-styling


### TinyLab Playground mode selector styling

Use this procedure when modifying the Playground sidebar mode selector (`normal`, `search`, `image`, `autochat`) to match a segmented Uiverse-style reference without changing its behavior or height.

#### Contract

- Keep `web/playground/static-pg/pg-ui.js` markup, `pgState.mode`, `pgSetMode()`, and inline click handlers unchanged unless the user explicitly requests an interaction change.
- The production selector is `.pg-mode-toggle` containing four `.pg-mode-btn` buttons. CSS expresses `.active`, hover, and focus; JavaScript owns mode state.
- Preserve the original selector height: `28px`.
- For the flush reference style: `gap: 0`, `padding: 0`, `border-radius: 0`, and no panel-level vertical whitespace. Keep `.pg-winbar` and `.pg-winbar-header` flush as well.
- Use `style.css` `--pg-mode-*` tokens for frame, segment surfaces, separators, active edge color, text, and light/dark palettes. `playground.css` consumes tokens rather than duplicating fixed palettes.
- Active state should illuminate the selected segment and its left/right edges only. Avoid diffuse `box-shadow` and broad `text-shadow` when the reference requires a crisp button-only glow.

#### Implementation pattern

In `web/static/style.css`, define complete dark and light token sets:

- `--pg-mode-frame-bg`, `--pg-mode-frame-border`
- `--pg-mode-cell-bg`, `--pg-mode-cell-hover-bg`, `--pg-mode-cell-active-bg`
- `--pg-mode-cell-border`, `--pg-mode-separator`, `--pg-mode-active-edge`
- `--pg-mode-text`, `--pg-mode-active-text`, `--pg-mode-text-shadow`

In `web/playground/static-pg/playground.css`:

```css
.pg-winbar{padding:0}
.pg-mode-toggle{display:flex;gap:0;width:100%;height:28px;padding:0;border:1px solid var(--pg-mode-frame-border);border-radius:0;background:var(--pg-mode-frame-bg);overflow:hidden;box-shadow:none}
.pg-mode-btn{position:relative;flex:1;min-width:0;height:100%;display:inline-flex;align-items:center;justify-content:center;padding:0 4px;border:0;border-top:1px solid var(--pg-mode-cell-border);border-right:1px solid var(--pg-mode-separator);border-radius:0;background:var(--pg-mode-cell-bg);color:var(--pg-mode-text);font-family:inherit;font-size:var(--font-base);font-weight:var(--font-weight-bold);text-shadow:var(--pg-mode-text-shadow);transition:background var(--transition-fast),color var(--transition-fast),border-color var(--transition-fast);white-space:nowrap}
.pg-mode-btn:last-child{border-right:0}
.pg-mode-btn.active{border-top-color:transparent;border-left:1px solid var(--pg-mode-active-edge);border-right:1px solid var(--pg-mode-active-edge);background:var(--pg-mode-cell-active-bg);color:var(--pg-mode-active-text);text-shadow:none;box-shadow:none}
```

Ensure `.pg-winbar-header` does not add height or vertical padding around the selector. Do not add a pseudo-element glow unless the reference explicitly needs it; the active surface gradient and side borders are sufficient for crisp lighting.

#### Documentation sync

For frontend Playground CSS changes, update:

- `docs/playground-architecture.md` top verification note and the mode selector/source-anchor section.
- `DESIGN.md` Playground mode selector contract.
- `PROJECT_MAP.md` §18.3 and §24 task index when the relevant entries change.

#### Verification

1. `node --check web/playground/static-pg/pg-ui.js`.
2. `go build -tags playground -o <smoke>.exe .`.
3. Run the real binary over HTTP with a temporary config containing only a valid `port` field.
4. Open Playground in a browser and click all four `.pg-mode-btn` buttons. Assert exactly one `.active` button and `window.pgState.mode` matches each requested mode.
5. Inspect computed style: selector height `28px`, `padding: 0`, `gap: 0`, `border-radius: 0`; active button has no diffuse `box-shadow`/`text-shadow` and has the expected left/right edge colors.
6. Repeat the computed-style check under both `data-theme="dark"` and `data-theme="light"`.
7. Capture a screenshot for visual confirmation, then stop the smoke server and remove temporary binary/config artifacts.

## tinylab-header-nav-reference-control


### TinyLab header navigation reference control

#### Contract

- Keep the production SPA navigation as real `<button class="nav-item" data-page="...">` elements inside `<nav aria-label="Primary navigation">`; do not replace behavior with radio inputs or move navigation into CSS.
- Playground shell uses a 3-column × 2-row grid. Place the five page buttons explicitly: Monitor `(1,1)`, Settings/Endpoint `(2,1)`, Playground `(3,1)`, Gallery `(1,2)`, Download `(3,2)`. Use a disabled empty button in `(2,2)` as the sixth slot.
- Put two small rotated-square decorations in the row gap between columns 1/2 and 2/3 via `.top-header-nav::before` and `::after`. Use a short row gap and keep the diamonds smaller than the button height.
- No-playground shell keeps only Monitor and Settings in `.top-header-nav-minimal`, with both decorative pseudo-elements hidden.
- Preserve `app.js` active-state and Gallery↔Editor label behavior. Existing `data-page` selectors and focus-visible rules remain the integration points.

#### Theme migration

- Add `--nav-*` tokens in the existing root and `[data-theme="light"]` layers; do not add a parallel theme system.
- Tokenize frame, cell, hover, active surface, border, text shadow, per-page active colors, and diamond fill/border.
- Use `:has(.nav-item[data-page="..."].active)` on `.top-header-nav` to set `--nav-active-color`; active button edge glow, embossed text, and both diamonds consume that token.
- Embossed text uses a light/dark text-shadow pair. Keep active text glow separate from structural shadow.

#### Implementation checklist

1. Read `PROJECT_MAP.md` §24, `DESIGN.md`, both embedded shells, current header CSS, and `app.js` navigation handlers.
2. Edit both HTML shells; add the accessible nav label and the disabled placeholder only to the Playground shell.
3. Replace the existing header-nav CSS as one contiguous block to avoid duplicate selectors. Keep responsive overrides expressed through `--nav-cell-width`, `--nav-gap`, `--nav-row-gap`, and `--nav-pad`.
4. Update `DESIGN.md` with the header control contract and `PROJECT_MAP.md` §18.2/§24 with the affected files and layout facts.
5. Build both default and `-tags playground` binaries because `//go:embed all:static` embeds CSS/HTML at compile time.

#### Verification

- Run `node --check web/static/app.js` and `node --check web/static/auth.js`.
- Run `go test ./...`, `go vet ./...`, and `git diff --check`.
- Serve the rebuilt binary over HTTP and inspect the real shell in Chromium. Assert Playground has five `.nav-item` buttons plus a disabled `.nav-placeholder`, 3 grid columns, 2 rows, two visible pseudo-elements, and compact row/column gaps.
- Click Settings and Download; assert `data-page` active state changes and computed active text/box-shadow/diamond colors follow the active page.
- Verify no-playground has two nav buttons, one row, and hidden pseudo-elements. Capture a screenshot of the nav after visual confirmation.
- Stop the smoke server and remove temporary binaries/configs only after verification.

