# DESIGN.md — TinyRouter Design System Contract

> Machine-readable design token specification. Last synced with `style.css` at commit HEAD.

## Architecture: Three-Dimensional Theme Model

```
┌─────────────────────────────────────────────────────┐
│  HTML: <html data-theme data-theme-variant data-theme-style>  │
├─────────────────────────────────────────────────────┤
│  Dimension 1: Mode       → dark | light             │
│  Dimension 2: Variant    → 9 per mode (color)       │
│  Dimension 3: Style      → 4 presets (shape/motion) │
│  Total combinations: 2 × 9 × 4 = 72 appearances    │
└─────────────────────────────────────────────────────┘
```

- **Mode** (`data-theme`): Controls color-scheme and base palette (dark/light).
- **Variant** (`data-theme-variant`): Overrides accent/text/surface colors within a mode.
- **Style** (`data-theme-style`): Overrides shape, shadow, motion, typography weight, and spacing tokens. Orthogonal to color.

## Token Taxonomy

### Color Tokens (controlled by Mode + Variant)

| Token | Default (dark) | Purpose |
|-------|---------------|---------|
| `--bg` | radial-gradient(...) | Page background |
| `--glass-bg` | rgba(255,255,255,0.035) | Card/panel surface |
| `--glass-hover` | rgba(255,255,255,0.075) | Hover surface |
| `--glass-active` | rgba(255,255,255,0.10) | Active/pressed surface |
| `--glass-border` | rgba(255,255,255,0.08) | Default border |
| `--glass-border-hover` | rgba(255,255,255,0.14) | Hover border |
| `--input-bg` | rgba(255,255,255,0.045) | Input field background |
| `--code-bg` | rgba(255,255,255,0.06) | Code block background |
| `--text` | #ededf0 | Primary text |
| `--text-secondary` | #9e9ea8 | Secondary text |
| `--text-muted` | #646474 | Muted/disabled text |
| `--accent` | #4fc3f7 | Primary accent |
| `--accent-glow` | rgba(79,195,247,0.30) | Accent glow/shadow |
| `--accent-gradient` | linear-gradient(135deg,...) | Gradient accent |
| `--accent2` | #66bb6a | Success/secondary accent |
| `--danger` | #ef5350 | Error/destructive |
| `--danger-glow` | rgba(239,83,80,0.25) | Danger glow |
| `--warn` | #ffa726 | Warning |
| `--warn-glow` | rgba(255,167,38,0.25) | Warning glow |
| `--modal-bg` | rgba(26,26,36,0.96) | Modal surface |
| `--toast-bg` | rgba(28,28,38,0.94) | Toast surface |

### Semantic component aliases

Component-specific state and surface rules consume these aliases so a new mode or variant changes a semantic role once rather than requiring selector-by-selector color overrides:

| Token group | Examples | Purpose |
|---|---|---|
| Surface | `--surface-page`, `--surface-card`, `--surface-overlay`, `--surface-fullscreen` | Page, card, overlay, and media-canvas surfaces |
| Border | `--border-subtle`, `--border-strong` | Normal and emphasized component boundaries |
| Status | `--status-success-bg`, `--status-warning-bg`, `--status-danger-bg` | State backgrounds for dynamic rows, badges, and messages |
| Code | `--code-surface`, `--code-text` | Code/debug/SSE rendering surfaces and text |
| Interaction | `--interactive-active-text`, `--interactive-active-bg`, `--text-on-accent` | Selected, active, and accent-contrast states |

### Shape Tokens (controlled by Style dimension)

| Token | Default | Sharp | Soft | Compact |
|-------|---------|-------|------|---------|
| `--radius-xs` | 4px | 0px | 6px | 2px |
| `--radius-sm` | 6px | 2px | 10px | 4px |
| `--radius-md` | 10px | 3px | 14px | 6px |
| `--radius-lg` | 14px | 4px | 20px | 8px |
| `--radius-xl` | 18px | 6px | 24px | 10px |

### Shadow Tokens (controlled by Style dimension)

| Token | Default | Sharp | Soft | Compact |
|-------|---------|-------|------|---------|
| `--shadow-card` | 0 2px 8px rgba(0,0,0,0.12) | 0 1px 3px rgba(0,0,0,0.20) | 0 4px 16px rgba(0,0,0,0.08) | 0 1px 2px rgba(0,0,0,0.06) |
| `--shadow-card-hover` | 0 4px 16px rgba(0,0,0,0.20) | 0 2px 6px rgba(0,0,0,0.30) | 0 8px 32px rgba(0,0,0,0.12) | 0 2px 4px rgba(0,0,0,0.10) |
| `--shadow-modal` | 0 16px 48px rgba(0,0,0,0.30) | 0 8px 24px rgba(0,0,0,0.40) | 0 24px 64px rgba(0,0,0,0.18) | 0 8px 24px rgba(0,0,0,0.15) |

### Motion Tokens (controlled by Style dimension)

| Token | Default | Sharp | Soft | Compact |
|-------|---------|-------|------|---------|
| `--transition-fast` | 0.15s cubic-bezier(0.4,0,0.2,1) | 0.10s ease | 0.20s cubic-bezier(0.25,0.46,0.45,0.94) | 0.08s ease |
| `--transition-normal` | 0.25s cubic-bezier(0.4,0,0.2,1) | 0.15s ease | 0.35s cubic-bezier(0.25,0.46,0.45,0.94) | 0.12s ease |
| `--transition-slow` | 0.35s cubic-bezier(0.4,0,0.2,1) | 0.20s ease | 0.50s cubic-bezier(0.25,0.46,0.45,0.94) | 0.18s ease |

### Typography Tokens (controlled by Style dimension)

| Token | Default | Sharp | Soft | Compact |
|-------|---------|-------|------|---------|
| `--font-weight-normal` | 600 | 500 | 500 | 500 |
| `--font-weight-bold` | 700 | 700 | 650 | 600 |
| `--letter-spacing-heading` | -0.3px | -0.5px | 0px | -0.2px |

### Layout/Spacing Tokens (controlled by Style dimension)

| Token | Default | Sharp | Soft | Compact |
|-------|---------|-------|------|---------|
| `--card-padding` | 18px | 14px | 22px | 12px |
| `--btn-padding` | 8px 16px | 6px 14px | 10px 20px | 5px 10px |

### Blur Tokens (controlled by Style dimension)

| Token | Default | Sharp | Soft | Compact |
|-------|---------|-------|------|---------|
| `--glass-blur` | 20px | 12px | 28px | 10px |
| `--glass-blur-sm` | 16px | 8px | 22px | 8px |
| `--glass-blur-overlay` | 8px | 4px | 12px | 4px |

### Font Size Tokens (controlled by `data-font-size` attribute, independent)

| Token | S (default) | M | L |
|-------|-------------|---|---|
| `--font-base` | 13.5px | 15px | 17px |
| `--font-h2` | 20px | 22px | 25px |
| `--font-h3` | 15px | 16px | 18px |
| `--font-stat-value` | 26px | 28px | 32px |

### Z-Index Scale (fixed, not theme-controlled)

| Token | Value | Layer |
|-------|-------|-------|
| `--z-dropdown` | 10 | Dropdowns |
| `--z-sticky` | 20 | Sticky headers |
| `--z-modal` | 50 | Modals/overlays |
| `--z-toast` | 60 | Toast notifications |
| `--z-tooltip` | 10005 | Tooltips |

## Component Rules

### Do

- Use `var(--radius-*)` for all `border-radius` (except `100px` pill shapes and `50%` circles).
- Use `var(--font-weight-normal)` / `var(--font-weight-bold)` for all structural font-weight.
- Use `var(--glass-blur)` / `var(--glass-blur-sm)` / `var(--glass-blur-overlay)` for all `backdrop-filter: blur()`.
- Use `var(--transition-fast/normal/slow)` for all `transition` durations.
- Use `var(--card-padding)` for card container padding.
- Use `var(--btn-padding)` for button padding.
- Use `var(--shadow-card)` / `var(--shadow-card-hover)` / `var(--shadow-modal)` for structural shadows.

### Don't

- Don't hardcode `border-radius` px values on containers/buttons/cards.
- Don't use `font-weight: 600/700` directly on structural elements (use token).
- Don't hardcode `backdrop-filter: blur(Npx)` — always reference a blur token.
- Don't hardcode `transition: ... 0.25s ...` — use motion tokens.
- Don't apply style-dimension tokens to color properties (they're orthogonal).
- Don't override `font-size` in style presets (that's the `data-font-size` dimension).

## Frontend CSS maintenance contract

- Semantic color aliases must be declared in the root token layer and consumed by component selectors; new components must not introduce bare hardcoded status/surface colors when an existing semantic token applies.
- Dynamic visual state belongs to CSS classes (`is-error`, `is-selected`, `is-hidden`, `is-expanded`, or a module-prefixed equivalent). JavaScript may retain inline styles for computed geometry, coordinates, widths, and progress values only.
- Existing global baseline selectors are compatibility infrastructure. New modules must use a namespace prefix (`.pg-*`, `.dl-*`, `.ge-*`, `.tr-*`, or a feature-specific prefix) and declare their own form/table/heading styles instead of depending on new bare global selectors.
- Style validation uses the production HTML shell over HTTP with an optional preview override loaded after production CSS; copied standalone HTML/CSS and `file://` are not valid equivalence tests.

### Header navigation reference control

- `.top-header-nav` is the production navigation shell: a theme-token-driven 3-column × 2-row recessed control with five long rectangular `.nav-item` cells and one disabled, empty sixth button slot; Download occupies the lower-middle slot and the lower-right slot remains empty.
- `.top-header-nav::before` and `::after` are the two small non-interactive rotated square decorations centered in the tightened row gap between adjacent columns. Only the diamond edge facing the active cell receives the active color; `.top-header-nav-minimal` removes them and uses a single 2-cell row for the no-Playground shell.
- Navigation order remains controlled by `data-page`/grid placement rules, while `app.js` continues to own active state and page navigation. Do not replace these buttons with radio inputs or move navigation behavior into CSS.
- Dark and light appearances are controlled by `--nav-*` tokens in `style.css`; the active page selects its accent color for a rounded-contour-clipped, transparency/brightness-gradient outline, accent-colored bright fog/glow text with a crisp stroked fill and short restrained halo, and one-facing-edge diamond light. Navigation click focus does not add the global blue outline.

### Playground mode selector

- `.pg-mode-toggle` is the Playground mode control: four long rectangular segments for `normal` / `search` / `image` / `autochat`, rendered as one flush, square-cornered frame without panel-level outer whitespace or extra vertical height.
- `pg-ui.js::pgSetMode()` remains the sole owner of mode transitions; CSS only expresses `.pg-mode-btn.active`, hover, and keyboard focus. Do not replace the buttons with radio inputs or move mode state into CSS.
- `--pg-mode-*` tokens in `style.css` own the frame, cell gradients, active text, separator, active side edges, and text shadow. Dark and light modes each define a complete token set; `playground.css` consumes those tokens and does not hardcode a second palette.
- The active segment illuminates its own surface and left/right edges only. It has no diffuse text halo, drop shadow, or rounded corners; the surrounding `.pg-winbar` / `.pg-winbar-header` stays flush with the panel and preserves the original 28px control height.

### Exceptions (intentionally hardcoded)

- `border-radius: 100px` — pill badges (`.badge`, `.model-status`, `.model-quota`).
- `border-radius: 50%` — circular dots/icons.
- `font-weight: 700` on `.model-key-timer` (9px decorative digit).
- `font-weight: 700` on `::after` pseudo-element indicators.
- `font-weight: 700` on `.toast-icon` (11px icon glyph).
- Glow shadows (`box-shadow: 0 0 Npx color`) — color-dimension decorative, not structural.
- Focus ring shadows (`0 0 0 2px`) — functional accessibility, not style-controlled.

## Accessibility Constraints

- All interactive elements must have `:focus-visible` outline (2px solid var(--accent)).
- `@media (prefers-reduced-motion: reduce)` disables all animation/transition via universal selector.
- Minimum touch target: 24×24px (WCAG 2.5.8 AA). All interactive elements comply.
- Style presets do NOT alter color contrast ratios (color is orthogonal).
- Compact mode minimum button height: ~31px (font-base × line-height + 2 × btn-padding-y).

## Responsive Breakpoints

| Breakpoint | Target | Key Changes |
|-----------|--------|-------------|
| `@container main (max-width:600px)` | Narrow container | card-actions flexible |
| `@media (max-width:480px)` | Small mobile | Compact header, reduced padding |
| `@media (max-width:768px)` | Tablet | Header wrap, single-column usage, flexible card-actions |
| `@media (max-width:1100px) and (min-width:901px)` | Medium | Settings single-column, compact header |
| `@media (max-width:1250px)` | — | Hide header stats |
| `@media (min-width:1280px)` | Large | Expanded header, wider nav |

## Persistence

- **Instant**: `localStorage` keys `themeMode`, `themeVariantDark`, `themeVariantLight`, `themeStyle`.
- **Durable**: `config.yaml` → `theme.darkVariant`, `theme.lightVariant`, `theme.style` via Settings API (GET/PATCH `/api/settings`).
- **First-paint**: Inline `<script>` in `index.html` reads localStorage and sets `data-theme`, `data-theme-variant`, `data-theme-style` before CSS loads.
