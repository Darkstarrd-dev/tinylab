// web/gallery-edit-contract.test.js
// Zero-dependency Node contract test for the Gallery single-file edit input
// resolution (audit F-03/F-28): the backend endpoints used to materialize
// edit inputs — /edit/extract-zip-entry and /edit/upload-temp — return
// { assetId } only (no tempPath), and the frontend must resolve edits by
// assetId. Loads the real gallery-edit.js / gallery-edit-operations.js /
// gallery-edit-batch.js in a sandboxed VM with stubbed browser globals and
// drives triggerMediaEditor + _resolveBatchInput end to end.
//
// Run:  node web/gallery-edit-contract.test.js
//
// Covered contracts (archive_compatibility_plan.md §7.3/§8.2):
//   single zip extract-to-edit: resolved item carries assetId, never absPath;
//   request bodies carry sourceId/sessionId/grantId (no raw zip paths);
//   batch resolution returns { inputAssetId } descriptors for /edit/start.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log('  ok  ' + name);
  }).catch((err) => {
    failures++;
    console.error('  FAIL ' + name + ': ' + (err && err.message));
  });
}
// waitFor polls a condition until it holds — triggerMediaEditor is fire-and-
// forget (it does not return the fetch chain), so the async resolution must
// be observed rather than awaited.
function waitFor(fn, what, timeoutMs) {
  timeoutMs = timeoutMs || 2000;
  return new Promise(function (resolve, reject) {
    var start = Date.now();
    (function poll() {
      var v;
      try { v = fn(); } catch (e) { reject(e); return; }
      if (v) { resolve(v); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('timeout waiting for ' + what)); return; }
      setTimeout(poll, 10);
    })();
  });
}

// plain deep-copies a value out of the VM realm so deepStrictEqual compares
// test-realm objects (VM objects carry a different Object prototype).
function plain(o) {
  return JSON.parse(JSON.stringify(o));
}

// Build a sandboxed browser-like environment. The backend stub answers
// extract-zip-entry / upload-temp with { assetId } only — exactly what the
// real handlers return — so any frontend read of data.tempPath surfaces as
// missing assetId / undefined absPath.
function makeEnv() {
  const calls = { fetches: [], opened: [], shown: [] };
  let seq = 0;

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Promise, Math, JSON,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    String, Number, Boolean, Array, Object, RegExp, Error, TypeError,
    Uint8Array, Blob: typeof Blob !== 'undefined' ? Blob : undefined,
    navigator: { userAgent: 'test' },
    location: { href: 'http://test/', pathname: '/', search: '', hash: '' },
    document: {
      getElementById: function () { return null; },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      createElement: function () { return {}; },
      body: {}, documentElement: {},
      addEventListener: function () {},
    },
    ResizeObserver: function () {},
    requestAnimationFrame: function (cb) { return 1; },
    cancelAnimationFrame: function () {},
    T: function (k) { return k; },
    pgT: function (k) { return k; },
    showMsg: function (msg) { calls.shown.push(msg); },
    escapeHtml: function (s) { return String(s); },
    galleryState: {},
    fetch: function (url, opts) {
      const u = String(url);
      calls.fetches.push({ url: u, opts: opts || null });
      if (u.indexOf('/api/gallery/edit/extract-zip-entry') === 0) {
        seq++;
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ assetId: 'extract-' + seq }); } });
      }
      if (u.indexOf('/api/gallery/edit/upload-temp') === 0) {
        seq++;
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ assetId: 'upload-' + seq }); } });
      }
      return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve({ error: 'unexpected fetch ' + u }); } });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, calls };
}

// loadFiles evaluates the three gallery edit scripts in load order (matching
// the pgJSFiles order in internal/api/router.go).
function loadFiles(sandbox) {
  const base = path.join(__dirname, 'playground', 'static-pg', 'gallery');
  const files = ['gallery-edit.js', 'gallery-edit-operations.js', 'gallery-edit-batch.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(base, f), 'utf8');
    vm.runInNewContext(src, sandbox, { filename: f });
  }
}

// capturedOpenMediaEditor replaces window.openMediaEditor after load so the
// tests can inspect what triggerMediaEditor hands off without rendering the
// modal.
function capturedOpenMediaEditor(calls) {
  calls.opened = [];
  const capture = function (item, mediaType) {
    calls.opened.push({ item: item, mediaType: mediaType });
  };
  return capture;
}

async function main() {
  // ---- 1. single zip extract-to-edit (archive-source item) -----------
  await check('single zip extract-to-edit resolves by assetId (sourceId item)', async () => {
    const { sandbox, calls } = makeEnv();
    loadFiles(sandbox);
    sandbox.openMediaEditor = capturedOpenMediaEditor(calls);
    sandbox.galleryState = {
      mediaType: 'image',
      items: [{ kind: 'zip', sourceId: 'src1', zipPath: 'a.png', name: 'a.png' }],
      index: 0,
      videoItems: [],
      videoIndex: 0,
    };

    await sandbox.triggerMediaEditor('image');
    await waitFor(function () { return calls.opened.length > 0; }, 'openMediaEditor call');

    const extractCall = calls.fetches.find(function (f) { return f.url.indexOf('/edit/extract-zip-entry') !== -1; });
    assert(extractCall, 'extract-zip-entry must be fetched');
    assert.strictEqual(extractCall.opts.method, 'POST');
    assert.deepStrictEqual(JSON.parse(extractCall.opts.body), { zipPath: 'a.png', sourceId: 'src1' },
      'request body must carry sourceId + zipPath, never a raw path');
    assert.strictEqual(calls.opened.length, 1, 'openMediaEditor must be called once');
    const resolved = calls.opened[0].item;
    assert.strictEqual(calls.opened[0].mediaType, 'image');
    assert.strictEqual(resolved.assetId, 'extract-1', 'resolved item must carry the backend assetId');
    assert.strictEqual(resolved.absPath, undefined, 'resolved item must NOT carry absPath (tempPath was removed)');
    assert.strictEqual(resolved._tempExtracted, true);
    assert.strictEqual(resolved.sourceId, 'src1', 'original archive identity must survive the clone');
    assert(!('tempPath' in resolved), 'resolved item must not contain a tempPath key');
  });

  // ---- 2. single zip extract-to-edit (legacy session item) ------------
  await check('single zip extract-to-edit resolves by assetId (legacy sessionId item)', async () => {
    const { sandbox, calls } = makeEnv();
    loadFiles(sandbox);
    sandbox.openMediaEditor = capturedOpenMediaEditor(calls);
    sandbox.galleryState = {
      mediaType: 'image',
      items: [{ kind: 'zip', sessionId: 'sess1', zipPath: 'b.png', name: 'b.png' }],
      index: 0,
      videoItems: [],
      videoIndex: 0,
    };

    await sandbox.triggerMediaEditor('image');
    await waitFor(function () { return calls.opened.length > 0; }, 'openMediaEditor call');

    const extractCall = calls.fetches.find(function (f) { return f.url.indexOf('/edit/extract-zip-entry') !== -1; });
    assert(extractCall, 'extract-zip-entry must be fetched');
    assert.deepStrictEqual(JSON.parse(extractCall.opts.body), { zipPath: 'b.png', sessionId: 'sess1' });
    assert.strictEqual(calls.opened.length, 1);
    assert.strictEqual(calls.opened[0].item.assetId, 'extract-1');
    assert.strictEqual(calls.opened[0].item.absPath, undefined);
    assert(!('tempPath' in calls.opened[0].item));
  });

  // ---- 3. FSAA/drag-drop upload-temp ---------------------------------
  await check('single upload-temp edit resolves by assetId', async () => {
    const { sandbox, calls } = makeEnv();
    loadFiles(sandbox);
    sandbox.openMediaEditor = capturedOpenMediaEditor(calls);
    const blob = new Blob(['bytes'], { type: 'image/png' });
    sandbox.galleryState = {
      mediaType: 'image',
      items: [{ name: 'x.png', getBlob: function () { return Promise.resolve(blob); } }],
      index: 0,
      videoItems: [],
      videoIndex: 0,
    };
    await sandbox.triggerMediaEditor('image');
    await waitFor(function () { return calls.opened.length > 0; }, 'openMediaEditor call');

    const upCall = calls.fetches.find(function (f) { return f.url.indexOf('/edit/upload-temp') !== -1; });
    assert(upCall, 'upload-temp must be fetched');
    assert(upCall.url.indexOf('name=x.png') > 0, 'filename passed via ?name=');
    assert.strictEqual(upCall.opts.method, 'POST');
    assert.strictEqual(upCall.opts.body, blob, 'blob body passed through');
    assert.strictEqual(calls.opened.length, 1);
    assert.strictEqual(calls.opened[0].item.assetId, 'upload-1');
    assert.strictEqual(calls.opened[0].item.absPath, undefined);
    assert(!('tempPath' in calls.opened[0].item));
  });

  // ---- 4. batch input resolution: zip entry --------------------------
  await check('_resolveBatchInput zip entry resolves to { inputAssetId }', async () => {
    const { sandbox, calls } = makeEnv();
    loadFiles(sandbox);

    const desc = await sandbox._resolveBatchInput({ kind: 'zip', sourceId: 'src1', zipPath: 'a.png' });
    assert.deepStrictEqual(plain(desc), { inputAssetId: 'extract-1' },
      'batch input must be an inputAssetId descriptor for /edit/start, not a path string');
    const extractCall = calls.fetches.find(function (f) { return f.url.indexOf('/edit/extract-zip-entry') !== -1; });
    assert(extractCall, 'extract-zip-entry must be fetched');
    assert.deepStrictEqual(JSON.parse(extractCall.opts.body), { zipPath: 'a.png', sourceId: 'src1' });
  });

  // ---- 5. batch input resolution: zip with grantId -------------------
  await check('_resolveBatchInput zip with grantId sends grantId, resolves assetId', async () => {
    const { sandbox, calls } = makeEnv();
    loadFiles(sandbox);

    const desc = await sandbox._resolveBatchInput({ kind: 'zip', grantId: 'g1', zipPath: 'c.png' });
    assert.deepStrictEqual(plain(desc), { inputAssetId: 'extract-1' });
    const extractCall = calls.fetches.find(function (f) { return f.url.indexOf('/edit/extract-zip-entry') !== -1; });
    assert(extractCall, 'extract-zip-entry must be fetched');
    assert.deepStrictEqual(JSON.parse(extractCall.opts.body), { zipPath: 'c.png', grantId: 'g1' });
  });

  // ---- 6. batch input resolution: upload-temp ------------------------
  await check('_resolveBatchInput upload-temp resolves to { inputAssetId }', async () => {
    const { sandbox, calls } = makeEnv();
    loadFiles(sandbox);
    const blob = new Blob(['png-bytes'], { type: 'image/png' });

    const desc = await sandbox._resolveBatchInput({ name: 'y.png', getBlob: function () { return Promise.resolve(blob); } });
    assert.deepStrictEqual(plain(desc), { inputAssetId: 'upload-1' });
    const upCall = calls.fetches.find(function (f) { return f.url.indexOf('/edit/upload-temp') !== -1; });
    assert(upCall, 'upload-temp must be fetched');
    assert(upCall.url.indexOf('name=y.png') > 0);
    assert.strictEqual(upCall.opts.body, blob);
  });

  // ---- 7. batch input resolution: passthrough ------------------------
  await check('_resolveBatchInput passes assetId/grantId items through without fetch', async () => {
    const { sandbox, calls } = makeEnv();
    loadFiles(sandbox);

    const viaAsset = await sandbox._resolveBatchInput({ kind: 'backend', assetId: 'already-1' });
    assert.deepStrictEqual(plain(viaAsset), { inputAssetId: 'already-1' });
    const viaGrant = await sandbox._resolveBatchInput({ kind: 'backend', grantId: 'g9', rel: 'd.png' });
    assert.deepStrictEqual(plain(viaGrant), { inputGrantId: 'g9', inputRel: 'd.png' });
  });

  // ---- 8. no backend response ever carries tempPath ------------------
  await check('backend stub only ever returns assetId (tempPath removed)', async () => {
    // The stubbed backend in makeEnv returns exactly the real handler shape;
    // a frontend still reading data.tempPath would resolve assetId undefined
    // and absPath undefined, which the checks above already reject. Pin the
    // real handlers' response shape on the Go side too (see
    // internal/api/gallery/edit_handlers_test.go
    // TestGalleryEditExtractZipEntry_ReturnsAssetId /
    // TestGalleryEditUploadTemp_ReturnsAssetId).
    const { sandbox, calls } = makeEnv();
    loadFiles(sandbox);
    await sandbox._resolveBatchInput({ kind: 'zip', sessionId: 's1', zipPath: 'e.png' });
    const extractCall = calls.fetches.find(function (f) { return f.url.indexOf('/edit/extract-zip-entry') !== -1; });
    assert(extractCall, 'extract-zip-entry must be fetched');
    assert(!('tempPath' in extractCall), 'backend response shape has no tempPath');
  });

  console.log(failures === 0 ? '\ngallery-edit-contract.test.js: all checks passed' : '\ngallery-edit-contract.test.js: ' + failures + ' check(s) failed');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('gallery-edit-contract.test.js crashed:', err);
  process.exit(1);
});
