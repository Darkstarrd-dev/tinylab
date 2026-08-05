# gif.js (vendored encoder)

Browser GIF encoder for the GIF editor page's export path. Loads as a classic
`<script>` (UMD — exposes the `GIF` global).

## Provenance

| Field | Value |
|---|---|
| Library | gif.js |
| Version | 0.2.0 (npm dist build) |
| Source | https://github.com/jnordberg/gif.js (npm: https://registry.npmjs.org/gif.js/0.2.0, `dist/`) |
| License | MIT (see `LICENSE`, Copyright (c) 2013-2018 Johan Nordberg) |
| Notes | npm tarball ships no LICENSE file; LICENSE copied from the upstream repo master branch |

## Files

- `gif.js` — main UMD bundle (13,451 bytes); exposes `window.GIF`
- `gif.worker.js` — worker script (16,636 bytes); **plain self-contained script**,
  no `importScripts`, no `Blob`/`URL.createObjectURL` wrapping
- `LICENSE` — MIT license text from the upstream repository

### SHA-256

```
a8b111071bb3b123c302e6182c01d6b3550f93a4b627398b07c46875d84090bb  gif.js
ca9e3048557ec05d619e18b83403cd3669c88939e5fa2d6034ce7625d445970d  gif.worker.js
9a11e10f1864ed90c106d344eee7c20dd7170c4f0fbb8c45fe2e8a3b1fb821fe  LICENSE
```

## Worker loading & CSP (verified in source)

gif.js 0.2.0 creates workers with a plain same-origin URL:

```js
defaults = { workerScript: "gif.worker.js", workers: 2, ... };
// ...
worker = new Worker(this.options.workerScript);
```

There is **no** blob: `importScripts` wrapper in this version — the original
app's `blob:` wrapping is NOT needed and MUST NOT be reintroduced (CSP
`script-src 'self'` does not include `blob:`; `worker-src` unset falls back to
`'self'`).

Usage from the app: pass an explicit same-origin path, e.g.

```js
new GIF({ workerScript: './vendor/gif.js/gif.worker.js', workers: 4, quality: 10 });
```

The bare relative default (`"gif.worker.js"`) resolves against the document
URL, so the app should always pass the full static path.
