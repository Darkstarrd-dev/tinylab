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
//   erodeSmoothMask   — flood-mode post pass: expands (erode > 0) or shrinks
//                        (erode < 0) the just-flooded selection by N pixels,
//                        optionally feathering the edge over `smooth` pixels
//                        (partial alpha rim).
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
  var MAX_ERODE = 10;   // selection expand/shrink clamp (px)
  var MAX_SMOOTH = 20;  // edge feather clamp (px)

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
  // Flood-mode post pass: morphological expand/shrink of the just-flooded
  // selection by |erode| px, with an optional `smooth` px feathered edge.
  //
  // alphaBefore: Uint8ClampedArray(w*h) snapshot of the alpha channel taken
  // immediately BEFORE the flood fills of this pipeline run. The selection
  // is recovered as the alpha-diff (opaque -> transparent) so morphology
  // applies exactly to what THIS run selected; pixels that were already
  // transparent before the run are part of the background and stay
  // transparent.
  //
  // One chamfer distance transform (1 / sqrt(2) weights) from the raw
  // selection gives a signed distance field s relative to the edge
  // (half-pixel shifted, see inside the function); shifting it by `erode`
  // moves the edge in/out in a single pass. Removal factor
  // r = clamp(0.5 + (s + erode)/smooth, 0, 1) when smooth > 0 (edge = 50%,
  // ramp reaches both sides of the boundary), hard step at s + erode > 0
  // otherwise. Final alpha = round(alphaBefore * (1 - r)); RGB is never
  // touched (flood fill only zeroes alpha, so alphaBefore restores any
  // pixel that erosion deselects).
  // ------------------------------------------------------------------

  var SQRT2 = Math.sqrt(2);

  // Two-pass chamfer distance transform: dist[i] = distance from pixel i
  // to the nearest pixel where isSeed(i) is true.
  function chamferDistance(w, h, isSeed) {
    var INF = 1e9;
    var n = w * h;
    var dist = new Float32Array(n);
    for (var i = 0; i < n; i++) dist[i] = isSeed(i) ? 0 : INF;
    // forward pass: top-left -> bottom-right
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var p = row + x;
        var d = dist[p];
        if (x > 0 && dist[p - 1] + 1 < d) d = dist[p - 1] + 1;
        if (y > 0) {
          var up = p - w;
          if (dist[up] + 1 < d) d = dist[up] + 1;
          if (x > 0 && dist[up - 1] + SQRT2 < d) d = dist[up - 1] + SQRT2;
          if (x < w - 1 && dist[up + 1] + SQRT2 < d) d = dist[up + 1] + SQRT2;
        }
        dist[p] = d;
      }
    }
    // backward pass: bottom-right -> top-left
    for (var y2 = h - 1; y2 >= 0; y2--) {
      var row2 = y2 * w;
      for (var x2 = w - 1; x2 >= 0; x2--) {
        var p2 = row2 + x2;
        var d2 = dist[p2];
        if (x2 < w - 1 && dist[p2 + 1] + 1 < d2) d2 = dist[p2 + 1] + 1;
        if (y2 < h - 1) {
          var dn = p2 + w;
          if (dist[dn] + 1 < d2) d2 = dist[dn] + 1;
          if (x2 < w - 1 && dist[dn + 1] + SQRT2 < d2) d2 = dist[dn + 1] + SQRT2;
          if (x2 > 0 && dist[dn - 1] + SQRT2 < d2) d2 = dist[dn - 1] + SQRT2;
        }
        dist[p2] = d2;
      }
    }
    return dist;
  }

  function erodeSmoothMask(imgData, alphaBefore, erode, smooth) {
    if (!imgData || !imgData.data || !alphaBefore) return 0;
    erode = Math.round(Number(erode) || 0);
    smooth = Number(smooth) || 0;
    if (erode > MAX_ERODE) erode = MAX_ERODE;
    if (erode < -MAX_ERODE) erode = -MAX_ERODE;
    if (smooth < 0) smooth = 0;
    if (smooth > MAX_SMOOTH) smooth = MAX_SMOOTH;
    if (erode === 0 && smooth <= 0) return 0;
    var w = imgData.width, h = imgData.height;
    var n = w * h;
    var d = imgData.data;
    // selection mask = pixels this run turned from opaque to transparent
    var mask = new Uint8Array(n);
    var count = 0;
    for (var i = 0; i < n; i++) {
      if (alphaBefore[i] !== 0 && d[i * 4 + 3] === 0) {
        mask[i] = 1;
        count++;
      }
    }
    if (!count) return 0;

    // Signed distance field relative to the boundary EDGE, which runs
    // halfway between an inside pixel and its outside neighbor — hence the
    // half-pixel shift: without it, chamfer's integer steps on straight
    // edges (1, 2, 3, ...) would make the feather term 0.5 + s/smooth hit
    // exactly 0 or 1 and never produce partial alpha.
    //   inside:  s = distToOutside - 0.5   (>= 0.5 for selected pixels)
    //   outside: s = 0.5 - distToInside    (<= -0.5 for unselected pixels)
    var distToOutside = chamferDistance(w, h, function (p) { return !mask[p]; });
    var distToInside = chamferDistance(w, h, function (p) { return !!mask[p]; });

    var changed = 0;
    for (var p = 0; p < n; p++) {
      if (alphaBefore[p] === 0) continue; // pre-transparent: untouched
      var s = mask[p] ? distToOutside[p] - 0.5 : 0.5 - distToInside[p];
      var edge = s + erode; // > 0 = inside the (possibly resized) selection
      var r;
      if (smooth > 0) {
        r = 0.5 + edge / smooth;
        if (r < 0) r = 0; else if (r > 1) r = 1;
      } else {
        r = edge > 0 ? 1 : 0;
      }
      var a = Math.round(alphaBefore[p] * (1 - r));
      if (a !== d[p * 4 + 3]) {
        d[p * 4 + 3] = a;
        if (a < alphaBefore[p]) changed++;
      }
    }
    return changed;
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
  //   erode: -10..10 (flood mode only; expand/shrink the flooded selection
  //          by N px, applied to the UNION of all seed/corner regions),
  //   erodeSmooth: 0..20 (flood mode only; feather the selection edge,
  //          partial alpha rim in px)
  // }
  // ------------------------------------------------------------------

  function applyPipeline(imgData, opts) {
    if (!imgData || !imgData.data || !opts) return 0;
    var removed = 0;
    var key = hexToRgb(opts.keyColor);
    if (opts.mode === 'flood') {
      var seeds = opts.seeds || [];
      var erode = Math.round(Number(opts.erode) || 0);
      var smooth = Number(opts.erodeSmooth) || 0;
      if (erode > MAX_ERODE) erode = MAX_ERODE;
      if (erode < -MAX_ERODE) erode = -MAX_ERODE;
      if (smooth < 0) smooth = 0;
      if (smooth > MAX_SMOOTH) smooth = MAX_SMOOTH;
      // Snapshot alpha before any flood so the union of all seed/corner
      // selections can be expanded/shrunk/feathered in one post pass.
      var alphaBefore = null;
      if (erode !== 0 || smooth > 0) {
        var n = imgData.width * imgData.height;
        alphaBefore = new Uint8ClampedArray(n);
        for (var j = 0; j < n; j++) alphaBefore[j] = imgData.data[j * 4 + 3];
      }
      for (var i = 0; i < seeds.length; i++) {
        if (seeds[i] && typeof seeds[i].x === 'number' && typeof seeds[i].y === 'number') {
          removed += floodFillToAlpha(imgData, seeds[i].x, seeds[i].y, opts.fuzziness);
        }
      }
      if (opts.corner) removed += cornerFloodToAlpha(imgData, opts.fuzziness);
      if (alphaBefore) removed = erodeSmoothMask(imgData, alphaBefore, erode, smooth);
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
    erodeSmoothMask: erodeSmoothMask,
    applyPipeline: applyPipeline,
    hasActiveRemoval: hasActiveRemoval,
    MAX_DIST: MAX_DIST,
    MAX_ERODE: MAX_ERODE,
    MAX_SMOOTH: MAX_SMOOTH
  };
})();
