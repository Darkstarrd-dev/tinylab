// web/gif-editor-import-budget.test.js
// Zero-dependency Node contract test for the GIF editor import byte budgets
// (P0-06). Regression guard for the int32-truncated budgets: `2 << 30` is
// -2147483648 and `4 << 30` is 0, so every image/GIF/video import was rejected
// ("Video sampling exceeds budget" / "Import exceeds budget") after the spinner
// was raised — the editor hung on the loading animation forever.
//
// Loads the REAL web/static/gif-editor/gif-editor-import.js in a sandboxed VM
// (GifEditorCore stub) and drives the module's budget gates.
//
// Run:  node web/gif-editor-import-budget.test.js
//
// Covered contracts:
//   budgets are real byte counts above the int32 range, so a normal import is
//     never rejected (pre-fix every estimate exceeded the gate);
//   the sampling gate admits everything up to 4 GiB and rejects past it;
//   the GIF composite gate admits everything up to 2 GiB and rejects past it.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GiB = 1024 * 1024 * 1024;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (err) {
    failures++;
    console.error('  FAIL ' + name + ': ' + (err && err.message));
  }
}

// Minimal browser-like sandbox: the import module only touches window.GifEditorCore
// at load time (the DOM is reached lazily through core.byId).
function loadImportModule() {
  const sandbox = {
    console,
    String, Array, Object, Math, JSON, RegExp, Error, TypeError, Promise,
    document: { getElementById: function () { return null; } }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.GifEditorCore = {
    constants: { MAX_FILE_BYTES: 200 * 1024 * 1024 },
    registerModule: function (name, api) {
      if (name === 'import') sandbox.window.__importApi = api;
    }
  };
  const src = fs.readFileSync(path.join(__dirname, 'static', 'gif-editor', 'gif-editor-import.js'), 'utf8');
  vm.runInNewContext(src, sandbox, { filename: 'gif-editor-import.js' });
  assert.ok(sandbox.window.__importApi, 'import module must register during load');
  return sandbox.window.__importApi;
}

const api = loadImportModule();

check('import module exposes the budget gates', function () {
  assert.strictEqual(typeof api.exceedsSamplingBudget, 'function');
  assert.strictEqual(typeof api.exceedsCompositeBudget, 'function');
  assert.strictEqual(typeof api.SAMPLING_BUDGET_BYTES, 'number');
  assert.strictEqual(typeof api.GIF_COMPOSITE_BUDGET_BYTES, 'number');
});

check('budgets are plain byte counts above the int32 range', function () {
  // 2147483647 is the int32 maximum: `2 << 30` (= -2147483648) and `4 << 30`
  // (= 0) are both inside the range and therefore fail this.
  assert.ok(api.SAMPLING_BUDGET_BYTES > 2147483647, 'sampling budget must exceed int32');
  assert.ok(api.GIF_COMPOSITE_BUDGET_BYTES > 2147483647, 'composite budget must exceed int32');
  assert.ok(api.SAMPLING_BUDGET_BYTES > api.GIF_COMPOSITE_BUDGET_BYTES, 'sampling budget is the looser of the two');
});

check('a small image import is admitted (64x64 RGBA, 1 frame)', function () {
  assert.strictEqual(api.exceedsSamplingBudget(1 * 64 * 64 * 4), false);
});

check('sampling gate boundary is 4 GiB', function () {
  assert.strictEqual(api.exceedsSamplingBudget(4 * GiB), false, 'exactly 4 GiB is allowed');
  assert.strictEqual(api.exceedsSamplingBudget(4 * GiB + 4), true, '4 GiB + one frame is rejected');
  assert.strictEqual(api.exceedsSamplingBudget(8 * GiB), true);
});

check('composite gate boundary is 2 GiB', function () {
  assert.strictEqual(api.exceedsCompositeBudget(2 * GiB), false, 'exactly 2 GiB is allowed');
  assert.strictEqual(api.exceedsCompositeBudget(2 * GiB + 12), true);
  // 100 frames of 500x500 composited into 3 canvases each: 300 MB — must pass.
  assert.strictEqual(api.exceedsCompositeBudget(100 * 500 * 500 * 4 * 3), false);
});

console.log(failures === 0 ? '\ngif-editor-import-budget.test.js: all checks passed' : '\ngif-editor-import-budget.test.js: ' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
