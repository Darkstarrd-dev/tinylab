---
name: tinylab-frontend-xss
description: "TinyLab frontend XSS and escape semantics: escape-function context misuse, t() escaping, click-to-copy conventions, and capture-phase Escape-key handling."
---

# TinyLab Frontend XSS / Escape / i18n


## tinylab-frontend-escape-context-xss


### TinyLab Frontend: escape-function context misuse (dominant XSS class)

Use when auditing or fixing XSS in `web/static/` or `web/playground/static-pg/`. This is the **dominant XSS class** in TinyLab's frontend (2026-08-03 audit: 1 Critical + multiple High/Medium all from this one pattern).

#### Core mechanism — escapeHtml is NOT safe in JS-string context
`escapeHtml(s)` (and `pgEscapeAttr`) escape `'` → `&#39;`. But when that output is placed inside an **HTML attribute** that contains a **single-quoted JS string** — e.g. `onclick="toggleRow('…','<escapeHtml(val)>')"` — the browser's HTML attribute parser **decodes `&#39;` back to a literal `'` BEFORE the JS executes**. The single quote then truncates the JS string → injection. payload `a');alert(document.domain);//` runs on click.

Rule: `escapeHtml` / `escapeAttr` are **text/attribute-context** safe, **JS-string-context UNSAFE**. For JS-string context use **`escapeForJsString`** (`web/static/app.js:132`) — it escapes `\`/`'`/`"`/newline for JS. The repo HAS the right helper; it's just misused/omitted.

#### Known systemic sites (from 2026-08-03 audit — re-check each time, files drift)
**`web/static/` (admin SPA):**
- `monitor_quota.js:24-26` — **Critical stored XSS**: `bar.model` from `POST /v1/chat/completions` (unauth) → `GET /api/monitor/quotas` modelStats → `escapeHtml` in onclick → admin click executes. The trailing `.replace(/'/g,"\\'")` is dead code (escapeHtml already turned `'` into `&#39;`, so it matches nothing).
- `combos.js:283` — `escapeHtml(fullId)` in onclick; same file :276 correctly uses `escapeForJsString` (typo-level inconsistency).
- `quickslots.js:698` — double-escape order wrong: `escapeForJsString(escapeHtml(fullId))` — escapeHtml runs first, `&#39;` survives, escapeForJsString can't match the original quote. Use `escapeForJsString(fullId)`.
- `providers.js` — raw `p.id`/model id in onclick/element-id at ~41/49/50/216-219/262-283/316-317/353-354/458 (id is user/API-controllable; backend `createProvider` accepts client-supplied id verbatim). Same file :472-535 model rows correctly use escapeForJsString — convention is inconsistent within one file.
- `settings.js:185/193/194`, `download.js:166/221`, `monitor_recent.js:13/241`, `pg-search.js:322` (`data-tooltip` attr).
**`web/playground/`:**
- `pgEscapeAttr` (`pg-ui.js:1279`) — does NOT escape `"`, and `'`→`&#39;` decodes back → unsafe in BOTH attribute and JS-string contexts. Used in `pg-render.js:377/401`, `pg-modal.js:98-105`, `pg-ui.js:1294` (image URL from upstream LLM `image_url.url` or user-pasted URL → `onclick="pgShowImageModal('<URL>')"`) — **confirmed via headless browser** (`window.__xss=[2]` executed). The image/meta/button innerHTML regions bypass DOMPurify (sanitization only inside `pgRenderMarkdown`).
- `pg-ui.js:288-299` — `w.config.model` (alias, user-settable, no backend char validation) raw into pane-header innerHTML.
- `gallery-fullscreen.js:790` — `curDir` (disk folder name from untrusted zip/download) raw into `pgShowModal` innerHTML.
- `editor_textreview_step3.js:1095-1097` — `trS3JsString` only escapes `\`+`'`, not `"`; used in double-quoted `onchange="..."` attr.

#### The escapeAttr global-shadowing trap
There are TWO top-level `function escapeAttr`:
- `providers.js:880` — strong (escapes `'`).
- `download.js:1152` — weak (no `'` escape).
`index.html` loads `providers.js` (line ~106) **before** `download.js` (~117) → the **weak version shadows the strong one site-wide** (combos/quickslots/providers all get the weak one). Behavior depends on script load order and is very hard to debug. Fix: merge into one helper (app.js or monitor_state.js) with a complete escape set.

#### DOMPurify — applied but fail-open
`pg-markdown.js:115-118`: `marked.parse()` → `if (typeof DOMPurify !== 'undefined') html = DOMPurify.sanitize(html)`. DOMPurify IS applied on the markdown path (good), but it's **fail-open**: if `purify.min.js` fails to load / loads out of order, it silently returns unsanitized marked HTML (marked passes raw `<img onerror>` through). The link renderer (:12-15) also raw-concatenates href/title. Fix: fail-closed (escape + plaintext branch when DOMPurify absent), like the :122 fallback.

#### Fix pattern (apply consistently)
- Best: **avoid inline `onclick`** entirely — use `addEventListener` + `data-*` / `dataset`. Eliminates the JS-string-context class.
- If keeping inline: JS-string context → `escapeForJsString`; attribute context → a complete attr escaper (escapes `& " < >`).
- Delete the dead `.replace(/'/g,"\\'")` no-ops (they match nothing after escapeHtml).
- Unify the `escapeAttr` definitions; make the strong version the only one.
- Re-run DOMPurify on `pgMsgInnerHTML` output regions (image/meta/buttons), not just markdown internals.

#### Audit procedure (repeatable)
1. `grep -n "innerHTML\|insertAdjacentHTML\|outerHTML" web/static/*.js web/playground/static-pg/*.js` — enumerate all sites.
2. For each, trace whether the interpolated value is user/upstream-controllable (model name, alias, provider id, BaseURL, download filename, image URL, log text, dir name) vs server-generated-safe.
3. Check the escape function used AND the context (text / HTML attribute / JS-string-in-attribute). Mismatch = finding.
4. `node --check` every non-vendor `.js` for syntax (won't catch XSS but catches broken files).
5. For playground image-URL onclick, confirm empirically with a headless browser: inject a URL with `'`/`"` and check `window.__xss`.

## tinylab-i18n-t-function-xss-semantics


### TinyLab `t()` i18n escape semantics (XSS audit)

Use when reviewing/auditing XSS or interpolation correctness in `web/static/*.js` that uses the
`t(key, args)` i18n helper (defined in `web/static/i18n.js`).

#### The non-obvious facts

1. **`t(key, args)` auto-escapes string args.** Inside `t()`, each string arg is passed through
   `tEscapeHtml()` (a local copy of `escapeHtml`: escapes `& < > " '`) BEFORE substitution into the
   template. So `t('failed', [userMsg])` is safe to assign to `innerHTML` with NO extra escaping.
   - Code: `var safeArg = (typeof args[i]==='string') ? tEscapeHtml(args[i]) : args[i]; msg = msg.replace('{' + i + '}', safeArg);`

2. **`t(key).replace('{0}', raw)` does NOT auto-escape the arg.** The `t(key)` call (no args) skips
   the escape loop entirely; the raw value flows into `.replace()`. Such call sites MUST be wrapped
   in an outer `escapeHtml(...)`. Verify the outer escape is present before declaring a site safe.

3. **Both forms share a benign `.replace('{0}', ...)` replacement-pattern quirk** — NOT XSS.
   String `.replace(pattern, replacement)` honors `$&`, `$$`, `$'`, etc. If the substituted value
   contains `$` (and, in the `t()` path, an escaped `&`), the substitution can produce garbled text
   (e.g. `$&` → the literal `{0}` is echoed back). This is a display bug, not an injection. It exists
   in BOTH `t(key,[arg])` (after escaping, `$` survives) and the manual `.replace` form.

#### Audit procedure

For any `t(...)` result that lands in `innerHTML` (or an onclick string template):

- If call is `t(key, [arg...])` → args already escaped. Safe. (Still fine to also wrap in escapeHtml
  — no double-escape because the template literal `'Failed: '` has no special chars; but unnecessary.)
- If call is `t(key).replace('{0}', X)` → confirm an outer `escapeHtml(...)` wraps the whole
  expression. If absent → real XSS. If present → NOT an XSS (common false positive in reviews).
- Do not declare a `.replace('{0}', raw)` site a "P1 XSS" solely because it bypasses `tEscapeHtml`;
  check for the compensating outer `escapeHtml` first. A refactor to `t(key,[arg])` is cosmetic
  consistency, not a security fix, when the outer escape already exists.
- `$`-pattern quirks are orthogonal to XSS; flag separately if fixing display correctness.

#### Known call sites (verify before relying — line numbers drift)

- `web/static/usage.js` `fetchModelKeyDetail` catch path: `escapeHtml(t('failed').replace('{0}', e.message || ''))`
  → outer `escapeHtml` present → SAFE (review once mistook this for XSS).
- `web/static/usage.js` `resetQuotaTimers`: `toast(t('failed', [resp.error||'']))` / `t('failed', [e.message])`
  → `t()` escaped-arg form, result goes to `toast` (textContent path) → safe.
- `escapeHtml` lives in `web/static/app.js`; `tEscapeHtml` is a local copy in `i18n.js` (avoids app.js
  load-order dependency). Both implement the same 5-char entity escape.

## tinylab-click-to-copy-convention


### TinyLab Click-to-Copy Convention

How to add click-to-copy in the TinyLab frontend (web/static + web/playground/static-pg) without reinventing anything.

#### Always reuse app.js's global `copyToClipboard(text, label)`

Defined at `web/static/app.js:515` (top-level global, loaded before all feature modules):

```js
function copyToClipboard(text, label) {
  // navigator.clipboard.writeText(text).then(ok) with fallbackCopy on failure
  // toast((label || text) + ' ' + t('copied'), 'success');  // fallback: execCommand, toast t('copyFailed') on error
}
```

- Handles clipboard API + execCommand fallback + success/error toasts — do NOT write your own clipboard code.
- **Pass a SHORT `label` (e.g. the row's label text), never the content itself**: `label || text` means omitting label dumps the whole copied payload into the toast (huge for long prompts).
- The `copied` / `copyFailed` i18n keys already exist in the app dict — no new i18n keys needed for basic copy feedback.

#### Dynamic/re-rendered content → document-level click delegation

Content that re-renders (gallery sidebar per-navigation, modal sections, streamed lists) must NOT rebind per render. Bind ONCE at module load:

```js
function onMetaCopyClick(e) {
  var el = e.target && e.target.closest ? e.target.closest('.gm-copy') : null;
  if (!el) return;
  var lbl = el.parentElement ? el.parentElement.querySelector('.gm-label') : null;
  copyToClipboard(el.textContent, (lbl && lbl.textContent) || 'Prompt');
}
document.addEventListener('click', onMetaCopyClick);
```

- Mark copyable values with a `gm-copy` class in the rendered HTML.
- Read the source text via `el.textContent` — raw DOM text, **XSS-safe** (never put the payload in a data-* attribute and re-read it; that's an extra injection surface for no gain).
- `e.target.closest('.gm-copy')` survives clicks on nested elements.
- `closest` is fine in all supported Chromium/WebView targets; no polyfill needed.

#### Current usages (verified 2026-08-10)

1. `web/playground/static-pg/gallery/gallery-meta.js` — `onMetaCopyClick` (module tail) copies the sidebar's Prompt / Negative Prompt rows (`gm-copy` class on `.gm-value.gm-prompt` in `formatMetadataForOverlay`); toast label = the row's `.gm-label` text. Affordance CSS: `.gallery-meta-sidebar .gm-prompt{cursor:pointer}` + hover background.
2. `web/playground/static-pg/playground/pg-modal.js:456` — inline `navigator.clipboard.writeText(url)` + button text swap (older pattern; fine for static buttons, but reuse `copyToClipboard` when adding new copy actions).

#### Gotchas

- Do NOT add the `gm-copy`/copy handler to `<pre>` fallback or folded `Details` content unless asked — scope is usually the prompt rows only.
- Clicking a copyable value inside a `<details>` summary region: delegation still fires (event bubbles), but the summary toggle also handles the click — don't put `gm-copy` on summary elements.
- `copyToClipboard` resolves at click time, so calling it from a handler in a later-loaded script is fine (all scripts load before any user click).

## tinylab-escape-key-capture-phase-requirement


### TinyLab Escape-Key Capture-Phase Requirement

When adding any UI that should close on **Escape** (overlay, floating panel, in-place picker) in TinyLab's Gallery (or any page where app.js runs), a bubble-phase keydown handler or `onGalleryKeyDown`/`onFullscreenKey` is NOT sufficient. You must register a **capture-phase** document listener.

#### The trap (cost 2 debug cycles on 2026-08-10)

`web/static/app.js` binds a `document` keydown handler in the **bubble** phase that maps `Escape` (when no modal is open) to the `global.shutdown-server` shortcut (`web/static/shortcuts.js:39`). That handler calls `shutdownServer()` which opens a `confirmModal`, making `topOpenModal()` truthy.

Consequences:
- `onGalleryKeyDown` (`gallery-fullscreen.js`) is also **bubble** phase and runs AFTER app.js's handler. The spec pattern of "ESC-for-overlay branch at the top of `onGalleryKeyDown`, after the `topOpenModal()` guard" **never fires** in non-fullscreen mode — by the time it runs, the shutdown confirm modal is already open.
- `onFullscreenKey` only works in fullscreen because `bindFullscreen` attaches it with `capture=true` (`document.addEventListener('keydown', galleryState.keyHandler, true)`).

#### The fix (verified pattern)

Register a capture-phase listener **at module load** (top-level `document.addEventListener('keydown', fn, true)`), so it runs before both app.js's bubble handler AND `onFullscreenKey` (which is registered later, when entering fullscreen):

```js
function onMyOverlayKeyDown(e) {
  if (e.key !== 'Escape') return;
  if (typeof topOpenModal === 'function' && topOpenModal()) return; // modals still win
  if (!myOverlayVisible) return;                                    // pass through when not shown
  e.preventDefault();
  e.stopImmediatePropagation();  // NOT stopPropagation — see below
  closeMyOverlay();
}
document.addEventListener('keydown', onMyOverlayKeyDown, true);
```

#### Why `stopImmediatePropagation`, not `stopPropagation`

`stopPropagation` does **not** block other listeners on the **same node in the same phase**. `onFullscreenKey` is also capture-phase on `document` (registered when fullscreen is entered). With `stopPropagation`, the sequence in fullscreen + overlay-visible + Escape is:
1. capture listener hides overlay, sets `myOverlayVisible=false`, calls `stopPropagation`;
2. `onFullscreenKey` still runs (same node, same phase), sees `myOverlayVisible` now false, skips its ESC-for-overlay branch, and **falls through to `gallery.exit-fullscreen`** → exits fullscreen.

So Escape would close the overlay **and** exit fullscreen — a regression of the "ESC closes only the overlay" intent. `stopImmediatePropagation` blocks same-node subsequent listeners, so only the overlay closes and fullscreen stays.

When the overlay is **not** visible (or a modal is open), the listener returns early without stopping anything → normal Escape behavior (exit-fullscreen / shutdown-confirm / modal-close) is fully preserved.

#### Reference implementation
`web/playground/static-pg/gallery/gallery-meta.js` `onMetaOverlayKeyDown` (capture-phase ESC for the metadata overlay), registered once at module load.

#### Verification recipe
When implementing, smoke-test **three** Escape cases in a real headless browser (the bug only manifests at runtime, not in unit tests):
1. Non-fullscreen + overlay visible + ESC → overlay closes, **no** shutdown confirm modal appears.
2. Fullscreen + overlay visible + ESC → overlay closes, **stays** in fullscreen.
3. Fullscreen + overlay **hidden** + ESC → exits fullscreen normally (no behavior regression).

Build with `-tags playground`, port-only config + `enablePlayground:true`, drive over CDP (the omp browser daemon may be unavailable — launch `chrome --headless=new --remote-debugging-port=N` yourself).

