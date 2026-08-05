# gifuct-js (vendored browser bundle)

Self-contained GIF decoder for the GIF editor page. Loads as a plain classic
`<script>` (no bundler, no ESM) and also works under Node `require`.

## Provenance

| Field | Value |
|---|---|
| Library | gifuct-js |
| Version | 2.1.2 (npm) |
| Source | https://github.com/matt-way/gifuct-js (npm: https://registry.npmjs.org/gifuct-js/2.1.2) |
| License | MIT (see `LICENSE`, Copyright (c) 2015 Matt Way) |
| Inline deps | js-binary-schema-parser@2.0.3 (MIT) — bundled inline, no external runtime deps |
| Bundler | esbuild (IIFE, `--platform=browser --target=es2017 --minify`), built 2026-08-05 |

## File

- `gifuct-js.js` — the bundled decoder, 7,738 bytes (minified)
- `LICENSE` — original MIT license text from the npm package

### SHA-256

```
a4fe55b05a358484c7c162c809bd1455bf7ab9bb456fe5d94ba1fbf95890c8bf  gifuct-js.js
```

## Global API

The bundle is an IIFE that assigns onto `globalThis` — no module system needed:

- `window.parseGIF(arrayBuffer)` → parsed GIF object (`{ lsd, gct, frames[] }`)
- `window.decompressFrames(parsedGif, buildPatches)` → frame array; pass `true`
  to include the RGBA `patch` per frame

Both are also available in Node after `require('./gifuct-js.js')` (they land on
the global object).

## Frame contract (verified against 2.1.2 output)

Each decompressed frame is:

```js
{
  pixels: Uint8Array,            // LZW-decompressed COLOR-INDEX values (not RGBA)
  dims: { top, left, width, height }, // frame rect within the logical screen
  colorTable: [r,g,b][],         // palette used by this frame (LCT or GCT)
  delay: number,                 // milliseconds (GCE delay in centiseconds * 10, 0 -> 100)
  disposalType: number,          // 0/1 keep, 2 restore-to-background, 3 restore-to-previous
  transparentIndex: number|undefined,
  patch: Uint8ClampedArray,      // RGBA of the frame rect (only with buildPatches=true)
}
```

Compositing rule: blit each frame's `patch` at `(dims.left, dims.top)` onto a
`lsd.width x lsd.height` canvas, honoring `disposalType` of the previous frame
(save a snapshot before the frame when the next frame uses disposal 3).

## Verification performed (2026-08-05, Node 22 + ffmpeg git build)

- 3-frame solid-color GIF (ffmpeg concat): 3 frames, dims 64x64, delay 200 ms,
  disposalType 1, distinct composited pixel data per frame.
- PAL dither smoke GIF (testsrc → palettegen/paletteuse): 24 frames, partial
  rects (e.g. `120x17@0,90`), per-frame delays (80/90 ms).
- PIL-generated 2-frame GIF with disposal=2: both frames report `disposalType 2`
  and `transparentIndex 0`; frame 1 patch is 25% opaque (32x32 blue rect).
- `vm` sandbox (no module/require/exports): loads as plain script, globals land
  on the bare context.
