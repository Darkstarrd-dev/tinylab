// web/gif-editor-transparency.test.js
// Zero-dependency Node contract test for the GIF editor transparency engine
// (web/static/gif-editor/gif-editor-transparency.js). Loads the REAL module
// in a sandboxed VM and drives the pure ImageData functions directly — no
// DOM, no browser.
//
// Run:  node web/gif-editor-transparency.test.js
//
// Covered contracts:
//   chromaKeyToAlpha — exact key + within-fuzz removal, far colors kept,
//     already-transparent pixels preserved, idempotent;
//   fuzzThreshold / redmeanDistance — 0..100 maps to 0..765, monotonic,
//     black<->white = 765;
//   floodFillToAlpha — CONNECTED region only (interior same-color pixels
//     survive — the sprite-sheet case), stops at color boundaries, passes
//     through already-transparent pixels, out-of-bounds seed is a no-op;
//   cornerFloodToAlpha — border-connected background removed, interior
//     pocket stays;
//   colorToAlphaGimp — exact key -> alpha 0, far color -> alpha 255,
//     blend -> partial alpha with composite invariance F*a + B*(1-a) == N;
//   applyPipeline — mode dispatch (color hard / color c2a / flood + seeds /
//     flood + corner + c2a), hasActiveRemoval gating.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (err) {
    failures++;
    console.error('FAIL  ' + name + ': ' + (err && err.message));
  }
}

const SRC = fs.readFileSync(path.join(__dirname, 'static/gif-editor/gif-editor-transparency.js'), 'utf8');
const sandbox = { window: {} };
sandbox.window.window = sandbox.window; // module references window.*
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'gif-editor-transparency.js' });
const T = sandbox.window.GifEditorTransparency;

// --- helpers ---------------------------------------------------------

// Build an ImageData-shaped object: w x h pixels, all filled, or with a
// custom painter function.
function makeImg(w, h, painter) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (painter) {
        const c = painter(x, y);
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
        data[i + 3] = c.length > 3 ? c[3] : 255;
      } else {
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
      }
    }
  }
  return { width: w, height: h, data: data };
}

function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}
check('hexToRgb parses #rgb and #rrggbb, rejects garbage', function () {
  const c1 = T.hexToRgb('#fff');
  assert.strictEqual(c1.r, 255);
  assert.strictEqual(c1.g, 255);
  assert.strictEqual(c1.b, 255);
  const c2 = T.hexToRgb('#0a0b0c');
  assert.strictEqual(c2.r, 10);
  assert.strictEqual(c2.g, 11);
  assert.strictEqual(c2.b, 12);
  assert.strictEqual(T.hexToRgb('nope'), null);
  assert.strictEqual(T.hexToRgb(null), null);
});
function countAlpha(img, value) {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] === value) n++;
  }
  return n;
}

// --- threshold / distance mapping ------------------------------------

console.log('gif-editor transparency engine contract');
console.log('  fuzz mapping');

check('fuzzThreshold maps 0 -> 0 and 100 -> 765 (black-white distance)', function () {
  assert.strictEqual(T.fuzzThreshold(0), 0);
  assert.strictEqual(T.fuzzThreshold(100), T.MAX_DIST);
  assert.strictEqual(T.MAX_DIST, 765);
});

check('fuzzThreshold is monotonic and clamps', function () {
  assert.ok(T.fuzzThreshold(10) < T.fuzzThreshold(20));
  assert.strictEqual(T.fuzzThreshold(-5), 0);
  assert.strictEqual(T.fuzzThreshold(999), 765);
  assert.strictEqual(T.fuzzThreshold('abc'), 0);
});

check('redmeanDistance: identical = 0, black<->white = 765', function () {
  assert.strictEqual(T.redmeanDistance(120, 80, 40, 120, 80, 40), 0);
  assert.strictEqual(Math.round(T.redmeanDistance(0, 0, 0, 255, 255, 255)), 765);
});

// --- chroma key (mode A, hard) ---------------------------------------

console.log('  chromaKeyToAlpha');

check('removes exact key color and within-fuzz colors', function () {
  const img = makeImg(4, 4, (x, y) => {
    if (x === 0 && y === 0) return [255, 255, 255, 255];      // exact key
    if (x === 1 && y === 0) return [250, 252, 248, 255];      // near key (fuzz 15)
    return [0, 128, 255, 255];                                // far
  });
  T.chromaKeyToAlpha(img, { r: 255, g: 255, b: 255 }, 15);
  assert.strictEqual(px(img, 0, 0)[3], 0);
  assert.strictEqual(px(img, 1, 0)[3], 0);
  assert.strictEqual(px(img, 2, 0)[3], 255); // far color survives
});

check('skips already-transparent pixels and is idempotent', function () {
  const img = makeImg(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 0] : [255, 255, 255, 255]));
  T.chromaKeyToAlpha(img, { r: 255, g: 255, b: 255 }, 100);
  assert.strictEqual(px(img, 0, 0)[3], 0); // stayed transparent (not corrupted)
  assert.strictEqual(px(img, 1, 1)[3], 0);
  T.chromaKeyToAlpha(img, { r: 255, g: 255, b: 255 }, 100);
  assert.strictEqual(countAlpha(img, 0), 4);
});

check('fuzziness 0 removes only the exact key color', function () {
  const img = makeImg(2, 1, (x) => (x === 0 ? [200, 200, 200, 255] : [201, 201, 201, 255]));
  T.chromaKeyToAlpha(img, { r: 200, g: 200, b: 200 }, 0);
  assert.strictEqual(px(img, 0, 0)[3], 0);
  assert.strictEqual(px(img, 1, 0)[3], 255);
});

// --- flood fill (mode B) ---------------------------------------------

console.log('  floodFillToAlpha');

check('removes the CONNECTED region only — interior same-color pixel survives (sprite case)', function () {
  // 5x5: white background, red "character" filling the middle 3x3.
  // Interior white would be gone if global; here a white pocket inside the
  // character must survive because it is not connected to the outside.
  const img = makeImg(5, 5, (x, y) => {
    if (x >= 1 && x <= 3 && y >= 1 && y <= 3) return [255, 0, 0, 255];
    return [255, 255, 255, 255];
  });
  T.floodFillToAlpha(img, 0, 0, 15);
  // all border-adjacent white removed
  assert.strictEqual(px(img, 0, 0)[3], 0);
  assert.strictEqual(px(img, 4, 4)[3], 0);
  // character intact
  assert.strictEqual(px(img, 2, 2)[3], 255);
  assert.strictEqual(px(img, 1, 1)[3], 255);
  assert.strictEqual(px(img, 3, 3)[3], 255);
});

check('stops at color boundaries (isolated pocket of key color NOT removed)', function () {
  // 4x4 white bg with a red island in the middle; flood from (0,0) must
  // NOT reach the red island nor any white inside it.
  const img = makeImg(4, 4, (x, y) => {
    if (x === 2 && y === 1) return [255, 0, 0, 255];
    if (x === 3 && y === 1) return [0, 0, 0, 255]; // black barrier
    return [255, 255, 255, 255];
  });
  T.floodFillToAlpha(img, 0, 0, 15);
  assert.strictEqual(px(img, 0, 0)[3], 0);
  assert.strictEqual(px(img, 1, 2)[3], 0);
  assert.strictEqual(px(img, 2, 1)[3], 255); // red island intact
  assert.strictEqual(px(img, 3, 1)[3], 255); // black barrier intact
});

check('passes through already-transparent pixels (later seeds reach past removed bg)', function () {
  // 6x1: white | red bridge | black — flood white seed removes white;
  // flood black seed must traverse the transparent gap into the white
  // side (all already transparent) and remove the black region.
  const img = makeImg(6, 1, (x) => {
    if (x === 0 || x === 1) return [255, 255, 255, 255];
    if (x === 2 || x === 3) return [255, 0, 0, 255];
    return [0, 0, 0, 255];
  });
  T.floodFillToAlpha(img, 0, 0, 15);
  assert.strictEqual(px(img, 1, 0)[3], 0);
  assert.strictEqual(px(img, 2, 0)[3], 255); // red bridge stops the white fill
  T.floodFillToAlpha(img, 5, 0, 15);
  assert.strictEqual(px(img, 5, 0)[3], 0);   // black removed
  assert.strictEqual(px(img, 4, 0)[3], 0);
  assert.strictEqual(px(img, 2, 0)[3], 255); // red bridge still intact
  assert.strictEqual(px(img, 3, 0)[3], 255);
});

check('out-of-bounds and transparent seeds are no-ops', function () {
  const img = makeImg(3, 3, () => [255, 255, 255, 255]);
  assert.strictEqual(T.floodFillToAlpha(img, -1, 0, 15), 0);
  assert.strictEqual(T.floodFillToAlpha(img, 0, 99, 15), 0);
  img.data[3] = 0; // make (0,0) transparent
  assert.strictEqual(T.floodFillToAlpha(img, 0, 0, 15), 0);
  assert.strictEqual(countAlpha(img, 255), 8);
});

check('returns the count of pixels made transparent', function () {
  const img = makeImg(3, 3, () => [10, 20, 30, 255]);
  assert.strictEqual(T.floodFillToAlpha(img, 1, 1, 100), 9);
});

// --- corner flood -----------------------------------------------------

console.log('  cornerFloodToAlpha');

check('removes border-connected background, keeps interior pocket', function () {
  const img = makeImg(5, 5, (x, y) => {
    if (x === 2 && y === 2) return [255, 0, 0, 255];       // interior pocket
    if (x >= 1 && x <= 3 && y >= 1 && y <= 3) return [0, 255, 0, 255]; // frame color
    return [255, 255, 255, 255];                          // corner background
  });
  T.cornerFloodToAlpha(img, 15);
  assert.strictEqual(px(img, 0, 0)[3], 0); // corner white removed
  assert.strictEqual(px(img, 4, 4)[3], 0);
  // the green frame is not connected to the corners (white border separates)
  assert.strictEqual(px(img, 1, 1)[3], 255);
  assert.strictEqual(px(img, 2, 2)[3], 255);
});

// --- GIMP color-to-alpha ---------------------------------------------

console.log('  colorToAlphaGimp');

check('exact key color -> fully transparent', function () {
  const img = makeImg(1, 1, () => [255, 0, 0, 255]);
  T.colorToAlphaGimp(img, { r: 255, g: 0, b: 0 });
  assert.strictEqual(px(img, 0, 0)[3], 0);
});

check('far color -> stays opaque', function () {
  const img = makeImg(1, 1, () => [0, 0, 255, 255]);
  T.colorToAlphaGimp(img, { r: 255, g: 255, b: 255 });
  assert.strictEqual(px(img, 0, 0)[3], 255);
});

check('blend -> partial alpha and composite invariance (F*a + B*(1-a) == N)', function () {
  // 50% blend of character (black) over white background = gray 128.
  const img = makeImg(1, 1, () => [128, 128, 128, 255]);
  const key = { r: 255, g: 255, b: 255 };
  T.colorToAlphaGimp(img, key);
  const p = px(img, 0, 0);
  assert.ok(p[3] > 0 && p[3] < 255, 'alpha is partial, got ' + p[3]);
  const a = p[3] / 255;
  for (let c = 0; c < 3; c++) {
    const recomposed = Math.round(p[c] * a + key[c === 0 ? 'r' : c === 1 ? 'g' : 'b'] * (1 - a));
    assert.ok(Math.abs(recomposed - 128) <= 1, 'channel ' + c + ' composite ' + recomposed + ' != 128');
  }
});

check('skips already-transparent pixels', function () {
  const img = makeImg(1, 1, () => [255, 255, 255, 0]);
  T.colorToAlphaGimp(img, { r: 255, g: 255, b: 255 });
  assert.strictEqual(px(img, 0, 0)[3], 0);
});

// --- pipeline dispatch ------------------------------------------------

console.log('  applyPipeline');

check('mode color without c2a uses hard chroma key', function () {
  const img = makeImg(2, 2, () => [255, 255, 255, 255]);
  T.applyPipeline(img, { mode: 'color', keyColor: '#ffffff', fuzziness: 15 });
  assert.strictEqual(countAlpha(img, 0), 4);
});

check('mode color with c2a produces soft alpha', function () {
  const img = makeImg(1, 1, () => [128, 128, 128, 255]);
  T.applyPipeline(img, { mode: 'color', keyColor: '#ffffff', fuzziness: 15, c2a: true });
  const a = px(img, 0, 0)[3];
  assert.ok(a > 0 && a < 255, 'expected partial alpha, got ' + a);
});

check('mode flood applies seeds then optional corner + c2a cleanup', function () {
  // white bg + red character; seed at (0,0) removes bg; c2a cleans the
  // character edge (red near-white blends) but the core red stays opaque.
  const img = makeImg(5, 5, (x, y) => {
    if (x >= 1 && x <= 3 && y >= 1 && y <= 3) return [255, 0, 0, 255];
    return [255, 255, 255, 255];
  });
  T.applyPipeline(img, { mode: 'flood', keyColor: '#ffffff', fuzziness: 15, seeds: [{ x: 0, y: 0 }], corner: false, c2a: true });
  assert.strictEqual(px(img, 0, 0)[3], 0);   // bg removed
  assert.strictEqual(px(img, 2, 2)[3], 255); // character core untouched
});

check('flood mode corner flag removes border background', function () {
  const img = makeImg(4, 4, () => [255, 255, 255, 255]);
  T.applyPipeline(img, { mode: 'flood', keyColor: '#000000', fuzziness: 15, seeds: [], corner: true, c2a: false });
  assert.strictEqual(countAlpha(img, 0), 16);
});

check('hasActiveRemoval gates color/flood configurations', function () {
  assert.ok(T.hasActiveRemoval({ mode: 'color', keyColor: '#ffffff', fuzziness: 10 }));
  assert.ok(!T.hasActiveRemoval({ mode: 'color', keyColor: 'zzz', fuzziness: 10 }));
  assert.ok(T.hasActiveRemoval({ mode: 'flood', keyColor: '#ffffff', seeds: [{ x: 1, y: 1 }] }));
  assert.ok(T.hasActiveRemoval({ mode: 'flood', keyColor: '#ffffff', corner: true }));
  assert.ok(!T.hasActiveRemoval({ mode: 'flood', keyColor: '#ffffff' }));
  assert.ok(!T.hasActiveRemoval(null));
});

if (failures > 0) {
  console.error('\n' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\nall checks passed');
