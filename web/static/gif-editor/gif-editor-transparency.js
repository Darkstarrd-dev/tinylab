// web/static/gif-editor-transparency.js
// GIF Editor transparency engine (pure functions, zero DOM dependencies).
//
// Loaded BEFORE gif-editor-export.js / gif-editor.js (see index.html /
// index-nopg.html script order). Exposes window.GifEditorTransparency with
// three removal strategies plus the shared pipeline:
//
//   chromaKeyToAlpha   — global color keying by perceptual (redmean) distance
//                        (the "颜色去背" mode; replaces the old RGB box test).
//   colorToAlphaGimp   — GIMP Color-to-Alpha: partial alpha gradient + color
//                        decontamination; preserves anti-aliased edges.
//                        GIF cannot encode partial alpha — this mode is for
//                        PNG / sprite / ZIP outputs (and live preview).
//   floodFillToAlpha   — magic-wand style removal from a seed coordinate:
//                        only the CONNECTED same-color region becomes
//                        transparent, so interior character pixels of the
//                        same color survive (sprite-sheet use case). Already
//                        transparent pixels are passable, so later seeds can
//                        reach regions behind previously removed background.
//   cornerFloodToAlpha — preset: flood from the four image corners (border
//                        connected uniform background, zero clicking).
//
// Every function operates on an ImageData-shaped object
// ({ width, height, data: Uint8ClampedArray }) and mutates it in place —
// identical shape to real canvas ImageData, so the same code runs in the
// browser and in the Node VM contract tests.
//
// Fuzziness is the UI slider range 0..100. Threshold mapping: the old RGB
// box test used fuzz*2.55 per channel; redmean distance at a box corner is
// ~fuzz*7.65, so 0..100 maps to 0..765 (black<->white = 765) — the same
// reach, better perceptual behavior.

(function () {
  'use strict';

  var MAX_DIST = 765; // redmean distance between (0,0,0) and (255,255,255)

  // fuzz (0..100) -> redmean distance threshold (0..765)
  function fuzzThreshold(fuzz) {
    fuzz = parseFloat(fuzz);
    if (isNaN(fuzz)) return 0;
    return Math.max(0, Math.min(100, fuzz)) * (MAX_DIST / 100);
  }

  // Redmean (weighted Euclidean) color distance; perceptually closer than
  // the plain RGB box test and cheap to compute per pixel.
  function redmeanDistance(r1, g1, b1, r2, g2, b2) {
    var dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    var rm = (r1 + r2) / 2;
    var d2 = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
    return Math.sqrt(d2);
  }

  // '#rgb' / '#rrggbb' -> {r,g,b}; null on malformed input.
  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    var h = hex.replace(/^#/, '').trim();
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function clamp255(v) {
    return v < 0 ? 0 : (v > 255 ? 255 : v);
  }

  // ------------------------------------------------------------------
  // Mode A: global chroma key by redmean distance
  // ------------------------------------------------------------------

  function chromaKeyToAlpha(imgData, key, fuzz) {
    var d = imgData.data;
    var th = fuzzThreshold(fuzz);
    var kr = key.r, kg = key.g, kb = key.b;
    var removed = 0;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      if (redmeanDistance(d[i], d[i + 1], d[i + 2], kr, kg, kb) <= th) {
        d[i + 3] = 0;
        removed++;
      }
    }
    return removed;
  }

  // ------------------------------------------------------------------
  // Mode A+: GIMP Color-to-Alpha (partial alpha + decontamination)
  //   alpha = max(|ΔR|,|ΔG|,|ΔB|) over the key; F = (N - (1-a)·B) / a
  //   clamped to [0,255]. Composite invariance: F·a + B·(1-a) == N.
  //   Transparent input pixels are preserved untouched.
  // ------------------------------------------------------------------

  function colorToAlphaGimp(imgData, key) {
    var d = imgData.data;
    var kr = key.r, kg = key.g, kb = key.b;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      var ar = Math.abs(d[i] - kr);
      var ag = Math.abs(d[i + 1] - kg);
      var ab = Math.abs(d[i + 2] - kb);
      var max = ar > ag ? ar : ag;
      if (ab > max) max = ab;
      if (max === 0) {
        d[i + 3] = 0;
        continue;
      }
      var a = max; // 0..255
      var inv = 255 - a;
      d[i] = clamp255(Math.round((d[i] * 255 - kr * inv) / a));
      d[i + 1] = clamp255(Math.round((d[i + 1] * 255 - kg * inv) / a));
      d[i + 2] = clamp255(Math.round((d[i + 2] * 255 - kb * inv) / a));
      d[i + 3] = a;
    }
  }

  // ------------------------------------------------------------------
  // Mode B: flood fill (magic wand) from a seed coordinate.
  // Scanline fill with row-run tracking: the span is cleared on the
  // current row while each contiguous matching run in the rows above and
  // below seeds exactly one pixel (handles full-width spans where the
  // classic two-boundary-pixel variant enqueues nothing). Matching uses
  // the seed pixel's OWN color within fuzz; already-transparent pixels
  // are passable, so later seeds can reach regions behind previously
  // removed background.
  // Returns the number of pixels newly made transparent.
  // ------------------------------------------------------------------

  function floodFillToAlpha(imgData, x, y, fuzz) {
    var w = imgData.width, h = imgData.height;
    var d = imgData.data;
    if (w <= 0 || h <= 0) return 0;
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;
    var si = (y * w + x) * 4;
    if (d[si + 3] === 0) return 0; // seed on already-transparent: no-op

    var tr = d[si], tg = d[si + 1], tb = d[si + 2];
    var th = fuzzThreshold(fuzz);
    var removed = 0;

    // matches: same color within fuzz, OR already transparent (passable)
    function match(idx) {
      if (d[idx + 3] === 0) return true;
      return redmeanDistance(d[idx], d[idx + 1], d[idx + 2], tr, tg, tb) <= th;
    }

    var visited = new Uint8Array(w * h);
    var stack = [x, y];

    function push(px, py) {
      var v = py * w + px;
      if (visited[v]) return;
      visited[v] = 1;
      stack.push(px, py);
    }

    while (stack.length) {
      var cy = stack.pop();
      var cx = stack.pop();
      var row = cy * w;
      var idx = (row + cx) * 4;
      if (!match(idx)) continue;

      // scan left to the span start
      var sx = cx;
      while (sx > 0 && match((row + sx - 1) * 4)) sx--;

      // fill the span, tracking contiguous runs in the rows above/below
      var aboveOpen = false, belowOpen = false;
      var ex = sx;
      while (ex < w && match((row + ex) * 4)) {
        var p = (row + ex) * 4;
        if (d[p + 3] !== 0) {
          d[p + 3] = 0;
          removed++;
        }
        if (cy > 0) {
          var upMatch = match(((cy - 1) * w + ex) * 4);
          if (upMatch && !aboveOpen) {
            push(ex, cy - 1);
            aboveOpen = true;
          } else if (!upMatch && aboveOpen) {
            aboveOpen = false;
          }
        }
        if (cy < h - 1) {
          var downMatch = match(((cy + 1) * w + ex) * 4);
          if (downMatch && !belowOpen) {
            push(ex, cy + 1);
            belowOpen = true;
          } else if (!downMatch && belowOpen) {
            belowOpen = false;
          }
        }
        ex++;
      }
    }
    return removed;
  }

  // ------------------------------------------------------------------
  // Preset: flood from the four image corners (border-connected uniform
  // background removal, no coordinate picking needed). Opaque corner
  // pixels only; a corner that is already transparent is skipped so
  // re-running is harmless.
  // ------------------------------------------------------------------

  function cornerFloodToAlpha(imgData, fuzz) {
    var w = imgData.width, h = imgData.height;
    var removed = 0;
    var seeds = [
      [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]
    ];
    for (var i = 0; i < seeds.length; i++) {
      removed += floodFillToAlpha(imgData, seeds[i][0], seeds[i][1], fuzz);
    }
    return removed;
  }

  // ------------------------------------------------------------------
  // Shared pipeline: applies the configured removal strategy to an
  // ImageData in place.
  // opts: {
  //   mode: 'color' | 'flood',
  //   keyColor: '#rrggbb',
  //   fuzziness: 0..100,
  //   seeds: [{x,y}, ...],
  //   corner: boolean (flood mode only),
  //   c2a: boolean (soft edge; color mode replaces the hard chroma key,
  //                 flood mode runs as a residual-cleanup pass)
  // }
  // ------------------------------------------------------------------

  function applyPipeline(imgData, opts) {
    if (!imgData || !imgData.data || !opts) return 0;
    var removed = 0;
    var key = hexToRgb(opts.keyColor);
    if (opts.mode === 'flood') {
      var seeds = opts.seeds || [];
      for (var i = 0; i < seeds.length; i++) {
        if (seeds[i] && typeof seeds[i].x === 'number' && typeof seeds[i].y === 'number') {
          removed += floodFillToAlpha(imgData, seeds[i].x, seeds[i].y, opts.fuzziness);
        }
      }
      if (opts.corner) removed += cornerFloodToAlpha(imgData, opts.fuzziness);
      if (opts.c2a && key) colorToAlphaGimp(imgData, key);
    } else {
      if (!key) return 0;
      if (opts.c2a) {
        colorToAlphaGimp(imgData, key);
        // count approximate: number of pixels whose alpha changed
        removed = countNonOpaque(imgData.data);
      } else {
        removed = chromaKeyToAlpha(imgData, key, opts.fuzziness);
      }
    }
    return removed;
  }

  function countNonOpaque(data) {
    var n = 0;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 255) n++;
    }
    return n;
  }

  // True if the params represent an active removal configuration
  // (used to decide whether a transform must materialize transparency).
  function hasActiveRemoval(opts) {
    if (!opts) return false;
    if (opts.mode === 'flood') {
      var seeds = opts.seeds || [];
      return opts.corner || seeds.length > 0 || (opts.c2a && !!hexToRgb(opts.keyColor));
    }
    return !!hexToRgb(opts.keyColor);
  }

  window.GifEditorTransparency = {
    fuzzThreshold: fuzzThreshold,
    redmeanDistance: redmeanDistance,
    hexToRgb: hexToRgb,
    chromaKeyToAlpha: chromaKeyToAlpha,
    colorToAlphaGimp: colorToAlphaGimp,
    floodFillToAlpha: floodFillToAlpha,
    cornerFloodToAlpha: cornerFloodToAlpha,
    applyPipeline: applyPipeline,
    hasActiveRemoval: hasActiveRemoval,
    MAX_DIST: MAX_DIST
  };
})();
