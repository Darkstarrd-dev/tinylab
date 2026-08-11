// web/gif-editor-i18n-args.test.js
// Zero-dependency Node contract test for GIF editor parameterized
// confirmation messages. Regression guard for the smoke finding that the
// delete-range confirm rendered "Delete frames {0} to {1}?" literally:
// the module-local t(key, fallback) wrapper called window.t(key) without
// args, so dictionary placeholders were never substituted.
//
// The test loads the REAL web/static/i18n.js dictionary + global t() and the
// REAL message expressions extracted from web/static/gif-editor/gif-editor.js
// (delete-range, keep-range, resize, interval-delete confirms) and asserts
// {N} substitution in both languages, plus backward compatibility of the
// wrapper's plain-string fallback calls.
// It also guards the final-gate label fix: the five previously hardcoded GIF
// labels (export-settings / reset-workspace / zoom titles, export-preview alt,
// preview button) must be dictionary-driven in both languages.
//
// Run:  node web/gif-editor-i18n-args.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const I18N_SRC = fs.readFileSync(path.join(__dirname, 'static/i18n.js'), 'utf8');
const MODULE_SRC = fs.readFileSync(path.join(__dirname, 'static/gif-editor/gif-editor.js'), 'utf8');
const EXPORT_SRC = fs.readFileSync(path.join(__dirname, 'static/gif-editor/gif-editor-export.js'), 'utf8');

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

// Extract the module-local wrapper: `function t(key, args, fallback) { ... }`.
function extractWrapper(src) {
  const start = src.indexOf('function t(key, args, fallback)');
  assert.ok(start >= 0, 'module wrapper not found');
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced wrapper braces');
}

// Extract the real `message: t('gifEditor<Key>', ...)` expression from the
// source by scanning to the matching close paren of the t(...) call.
function extractMessageExpr(src, key) {
  const anchor = "message: t('" + key + "'";
  const start = src.indexOf(anchor);
  assert.ok(start >= 0, 'call site for ' + key + ' not found in module source');
  let depth = 0;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(start + 'message: '.length, i + 1);
    }
  }
  throw new Error('unbalanced parens for ' + key);
}

// Sandbox with a controllable documentElement.getAttribute (lang) so the real
// global t() resolves en vs cn.
function makeContext(lang) {
  const sandbox = {
    console,
    String, Array, Object, Math, JSON, RegExp, Error, TypeError,
    window: {},
    document: {
      documentElement: {
        getAttribute: function (attr) { return attr === 'data-lang' ? lang : null; }
      },
      getElementById: function () { return null; }
    }
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(I18N_SRC + '\n;globalThis.__L = L; globalThis.__t = t;', ctx);
  // The module wrapper references window.t — point it at the real global t.
  vm.runInContext('window.t = __t;', ctx);
  return ctx;
}

const WRAPPER = extractWrapper(MODULE_SRC);
const EXPRS = {
  deleteRange: extractMessageExpr(MODULE_SRC, 'gifEditorConfirmDeleteRange'),
  keepRange: extractMessageExpr(MODULE_SRC, 'gifEditorConfirmKeepRange'),
  resize: extractMessageExpr(MODULE_SRC, 'gifEditorResizeConfirm'),
  intervalDelete: extractMessageExpr(MODULE_SRC, 'gifEditorIntervalDeleteConfirm')
};

console.log('gif-editor i18n args contract');
console.log('  wrapper:  ' + WRAPPER.split('\n')[0].trim());
console.log('  delete:   ' + EXPRS.deleteRange);
console.log('  keep:     ' + EXPRS.keepRange);
console.log('  resize:   ' + EXPRS.resize);
console.log('  interval: ' + EXPRS.intervalDelete);

function runExpr(ctx, expr, vars) {
  const decl = Object.keys(vars).map(function (k) { return 'var ' + k + ' = ' + JSON.stringify(vars[k]) + ';'; }).join('');
  return vm.runInContext(decl + '\n(' + WRAPPER + ');\n(' + expr + ')', ctx);
}

// --- Observed smoke path: delete-range confirm, en + cn ---
check('delete-range en substitutes {0}/{1} (smoke regression)', function () {
  const ctx = makeContext('en');
  const msg = runExpr(ctx, EXPRS.deleteRange, { range: { start: 2, end: 4 } });
  assert.strictEqual(msg, 'Delete frames 3 to 5?');
  assert.ok(msg.indexOf('{') === -1, 'literal placeholder survived: ' + msg);
});
check('delete-range cn substitutes {0}/{1}', function () {
  const ctx = makeContext('cn');
  const msg = runExpr(ctx, EXPRS.deleteRange, { range: { start: 2, end: 4 } });
  assert.strictEqual(msg, '确定删除 第 3 帧到 第 5 帧吗？');
  assert.ok(msg.indexOf('{') === -1, 'literal placeholder survived: ' + msg);
});

// --- Sibling confirm with the same wrapper contract ---
check('keep-range en substitutes {0}/{1}', function () {
  const ctx = makeContext('en');
  assert.strictEqual(
    runExpr(ctx, EXPRS.keepRange, { range: { start: 2, end: 4 } }),
    'Keep only frames 3 to 5 and delete all others?');
});
check('keep-range cn substitutes {0}/{1}', function () {
  const ctx = makeContext('cn');
  assert.strictEqual(
    runExpr(ctx, EXPRS.keepRange, { range: { start: 2, end: 4 } }),
    '确定仅保留 第 3 帧到 第 5 帧，并删除其他所有帧吗？');
});

// --- Current-repair keys: 4-placeholder confirms ---
check('resize en substitutes {0}..{3}', function () {
  const ctx = makeContext('en');
  assert.strictEqual(
    runExpr(ctx, EXPRS.resize, { origW: 640, origH: 480, targetW: 320, targetH: 240 }),
    'Resize all frames from 640×480 to 320×240? This cannot be undone.');
});
check('resize cn substitutes {0}..{3}', function () {
  const ctx = makeContext('cn');
  assert.strictEqual(
    runExpr(ctx, EXPRS.resize, { origW: 640, origH: 480, targetW: 320, targetH: 240 }),
    '将所有帧从 640×480 缩放到 320×240？此操作不可撤销。');
});
check('interval-delete en substitutes {0}..{3}', function () {
  const ctx = makeContext('en');
  assert.strictEqual(
    runExpr(ctx, EXPRS.intervalDelete, { interval: 2, deletedCount: 4, slices: new Array(10), kept: new Array(6) }),
    'This deletes 1 frame every 2 frames — 4 frames in total (10 → 6); delays adjust to keep the total duration.');
});
check('interval-delete cn substitutes {0}..{3}', function () {
  const ctx = makeContext('cn');
  assert.strictEqual(
    runExpr(ctx, EXPRS.intervalDelete, { interval: 2, deletedCount: 4, slices: new Array(10), kept: new Array(6) }),
    '将每隔 2 帧删除 1 帧，共删除 4 帧（10 → 6），自动调整延迟保持总时长。');
});

// --- Wrapper backward compatibility (all pre-existing call sites) ---
check('plain t(key, fallbackString) still resolves the dictionary', function () {
  const ctx = makeContext('en');
  const localT = vm.runInContext('(' + WRAPPER + ')', ctx);
  assert.strictEqual(localT('gifTimelineDelete', 'Delete frame'), 'Delete frame');
  assert.strictEqual(localT('gifEditorDeleteTitle', 'Delete Frames'), 'Delete Frames');
});
check('missing key falls back to the plain string', function () {
  const ctx = makeContext('en');
  const localT = vm.runInContext('(' + WRAPPER + ')', ctx);
  assert.strictEqual(localT('noSuchKeyXyz', 'fallback text'), 'fallback text');
});
check('string args are never treated as substitution arrays', function () {
  const ctx = makeContext('cn');
  const localT = vm.runInContext('(' + WRAPPER + ')', ctx);
  // 'gifEditorAlertRangeEmpty' has no placeholders; a string 2nd arg must
  // behave exactly as before (dictionary wins, no window.t args passed).
  assert.strictEqual(localT('gifEditorAlertRangeEmpty', 'x'), '选定范围内没有帧！');
});
// --- Smoke-flagged key coverage: Set Latency / Delete Range / Keep Range / Even / Uneven ---
check('gifEditorSetLatency resolves in en (smoke probe)', function () {
  const ctx = makeContext('en');
  assert.strictEqual(vm.runInContext('__t(\'gifEditorSetLatency\')', ctx), 'Set Latency');
});
check('gifEditorSetLatency resolves in cn (smoke probe)', function () {
  const ctx = makeContext('cn');
  assert.strictEqual(vm.runInContext('__t(\'gifEditorSetLatency\')', ctx), '设置延迟');
});
check('smoke-flagged cn labels are translated, not raw English', function () {
  const ctx = makeContext('cn');
  const labels = vm.runInContext(
    '({ globalDelay: __t(\'gifEditorGlobalDelay\'), delRange: __t(\'gifEditorDelRange\'), keepRange: __t(\'gifEditorKeepRange\'), even: __t(\'gifEditorEven\'), uneven: __t(\'gifEditorUneven\'), reduceFrame: __t(\'gifEditorReduceFrame\'), batchDelete: __t(\'gifEditorBatchDelete\') })',
    ctx);
  assert.strictEqual(labels.globalDelay, '设置延迟');
  assert.strictEqual(labels.delRange, '删除范围');
  assert.strictEqual(labels.keepRange, '保留范围');
  assert.strictEqual(labels.even, '均分');
  assert.strictEqual(labels.uneven, '不均分');
  assert.strictEqual(labels.reduceFrame, '间隔删帧');
  assert.strictEqual(labels.batchDelete, '批量删除帧');
});

// --- Final-gate regression: five previously hardcoded GIF labels must come
// from the dictionary (en + cn); the literal English strings must not appear
// in the sources outside t() fallbacks. ---
check('hardcoded label literals are gone from gif-editor.js', function () {
  assert.ok(MODULE_SRC.indexOf('title="Export settings"') === -1, 'title="Export settings" still literal');
  assert.ok(MODULE_SRC.indexOf('title="Reset workspace"') === -1, 'title="Reset workspace" still literal');
  assert.ok(MODULE_SRC.indexOf('title="Zoom"') === -1, 'title="Zoom" still literal');
});
check('hardcoded label literals are gone from gif-editor-export.js', function () {
  assert.ok(EXPORT_SRC.indexOf('alt="Export preview"') === -1, 'alt="Export preview" still literal');
  assert.ok(EXPORT_SRC.indexOf('>Preview</button>') === -1, 'Preview button still literal');
});
check('export-settings title key resolves en + cn', function () {
  assert.strictEqual(vm.runInContext('__t(\'gifEditorExportSettingsTitle\')', makeContext('en')), 'Export Settings');
  assert.strictEqual(vm.runInContext('__t(\'gifEditorExportSettingsTitle\')', makeContext('cn')), '导出设置');
});
check('reset-workspace title key resolves en + cn', function () {
  assert.strictEqual(vm.runInContext('__t(\'gifEditorResetWorkspace\')', makeContext('en')), 'Reset Workspace');
  assert.strictEqual(vm.runInContext('__t(\'gifEditorResetWorkspace\')', makeContext('cn')), '重置工作区');
});
check('timeline zoom title key resolves en + cn', function () {
  assert.strictEqual(vm.runInContext('__t(\'gifTimelineZoom\')', makeContext('en')), 'Zoom:');
  assert.strictEqual(vm.runInContext('__t(\'gifTimelineZoom\')', makeContext('cn')), '倍率:');
});
check('export-preview alt key resolves en + cn', function () {
  assert.strictEqual(vm.runInContext('__t(\'gifEditorExportPreviewAlt\')', makeContext('en')), 'Export preview');
  assert.strictEqual(vm.runInContext('__t(\'gifEditorExportPreviewAlt\')', makeContext('cn')), '导出预览');
});
check('preview button key resolves en + cn', function () {
  assert.strictEqual(vm.runInContext('__t(\'gifEditorPreviewBtn\')', makeContext('en')), 'Preview');
  assert.strictEqual(vm.runInContext('__t(\'gifEditorPreviewBtn\')', makeContext('cn')), '预览');
});

if (failures > 0) {
  console.error('\n' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\nall checks passed');
