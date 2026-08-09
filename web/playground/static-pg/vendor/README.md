# Playground vendor (vendored browser bundles)

Classic-script browser bundles loaded by `index.html` before the Playground
modules (load order: katex -> marked -> marked-katex-extension -> purify ->
highlight.js -> mermaid). Only files touched by the dependency audit are
documented here; the other bundles keep their pre-existing provenance.

## DOMPurify

| Field | Value |
|---|---|
| Library | DOMPurify |
| Version | 3.4.13 |
| Bundle | `purify.min.js` |
| Source | https://unpkg.com/dompurify@3.4.13/dist/purify.min.js |
| Upstream | https://github.com/cure53/DOMPurify |
| License | Apache License 2.0 / MPL 2.0 (full text at `web/static/vendor/utility-editor/dompurify/LICENSE`) |
| Global | `window.DOMPurify` |

The upstream UMD distribution works as a classic script and requires no module
loader. Playground Markdown/HTML preview sanitizes with `DOMPurify.sanitize`
(see `playground/pg-markdown.js` `PG_PURIFY_CONFIG`; `pg-render.js` also
sanitizes extracted Mermaid SVG strings before re-inserting them).

SHA-256: `9ab3d44d73c3e3947f9ab72e0f0bc15c7f1931d60b365ba261fc85fe59013c56`

## Mermaid

| Field | Value |
|---|---|
| Library | Mermaid |
| Version | 11.16.1 |
| Bundle | `mermaid.min.js` |
| Source | https://unpkg.com/mermaid@11.16.1/dist/mermaid.min.js |
| Upstream | https://github.com/mermaid-js/mermaid |
| License | MIT (see `LICENSE.mermaid`) |
| Global | `window.mermaid` |

Self-contained esbuild UMD bundle (no external chunk/worker files; ends with
`globalThis["mermaid"] = ...default`). Initialized with
`securityLevel: 'strict'` and rendered via `mermaid.run({ nodes, suppressErrors })`
(see `index.html` and `playground/pg-render.js`).

SHA-256: `18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954`
