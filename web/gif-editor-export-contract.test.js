// web/gif-editor-export-contract.test.js
// Zero-dependency Node contract test for the GIF editor ZIP export legacy
// fallback (audit F-28): POST /api/gallery/edit/upload-temp now returns
// { assetId } only (no tempPath) and POST /api/gallery/edit/zip-outputs
// accepts { assetIds } (raw paths/outputDir are 410) and returns
// { assetId, name, size } — the frontend must pack frames by assetId and
// download the result through the controlled /api/gallery/file?assetId= URL.
// Loads the real web/static/gif-editor/gif-editor-export.js in a sandboxed
// VM with stubbed browser globals, opens the export modal and drives the
// "Save as ZIP" button with MediaBridge.archiveStatus() = false so the
// legacy gallery fallback runs end to end.
//
// Run:  node web/gif-editor-export-contract.test.js
//
// Covered contracts:
//   upload-temp responses resolve to assetIds (a data.tempPath read would
//     yield undefined frame ids and fail the zip-outputs body assertion);
//   zip-outputs body carries { assetIds, zipName, cleanUp } and never a
//     paths key; result is downloaded from /api/gallery/file?assetId=...

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
// waitFor polls a condition until it holds — the export flow is fire-and-
// forget (saveZipCustom does not return its promise chain), so the async
// resolution must be observed rather than awaited.
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

function makeElement(id) {
  const el = {
    id: id || '',
    value: '',
    textContent: '',
    checked: false,
    src: '',
    href: '',
    download: '',
    style: {},
    classList: { add: function () {}, remove: function () {} },
    listeners: {},
    addEventListener: function (type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    click: function () {
      (el.listeners.click || []).forEach(function (fn) { fn(); });
    },
    appendChild: function () {},
    removeChild: function () {},
    innerHTML: ''
  };
  return el;
}

// Build a sandboxed browser-like environment. The backend stub answers
// upload-temp / zip-outputs with exactly the real handler shapes
// ({ assetId } / { assetId, name, size }), so a frontend still reading
// data.tempPath surfaces as undefined frame ids in the zip-outputs body.
function makeEnv() {
  const calls = { fetches: [], anchors: [], alerts: [] };
  const elements = {};
  let seq = 0;

  const pngBlob = new Blob(['png-bytes'], { type: 'image/png' });
  const zipBlob = new Blob(['zip-bytes'], { type: 'application/zip' });

  function makeCanvas() {
    return {
      width: 0,
      height: 0,
      toBlob: function (cb) { cb(pngBlob); },
      toDataURL: function () { return 'data:image/png;base64,eGln'; },
      getContext: function () { return { drawImage: function () {} }; }
    };
  }

  const overlay = makeElement('modal-overlay');
  overlay._html = '';
  Object.defineProperty(overlay, 'innerHTML', {
    get: function () { return overlay._html; },
    set: function (html) {
      overlay._html = html;
      const re = /id="([^"]+)"/g;
      let m;
      while ((m = re.exec(html))) {
        if (!elements[m[1]]) elements[m[1]] = makeElement(m[1]);
      }
    }
  });
  elements['modal-overlay'] = overlay;

  const spinnerText = makeElement('gif-spinner-text');

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Promise, Math, JSON,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    String, Number, Boolean, Array, Object, RegExp, Error, TypeError,
    Uint8Array, Blob,
    navigator: { userAgent: 'test' },
    location: { href: 'http://test/', pathname: '/', search: '', hash: '' },
    URL: {
      createObjectURL: function () { return 'blob:test'; },
      revokeObjectURL: function () {}
    },
    document: {
      getElementById: function (id) { return elements[id] || null; },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      createElement: function (tag) {
        if (tag === 'canvas') return makeCanvas();
        const el = makeElement('');
        if (tag === 'a') {
          calls.anchors.push(el);
          el.addEventListener('click', function () {});
        }
        return el;
      },
      body: { appendChild: function () {}, removeChild: function () {} },
      documentElement: {},
      addEventListener: function () {}
    },
    alert: function (msg) { calls.alerts.push(String(msg)); },
    confirm: function () { return true; },
    fetch: function (url, opts) {
      const u = String(url);
      calls.fetches.push({ url: u, opts: opts || null });
      if (u.indexOf('/api/gallery/edit/upload-temp') === 0) {
        seq++;
        const id = 'up-' + seq;
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve({ assetId: id }); },
          blob: function () { return Promise.resolve(pngBlob); }
        });
      }
      if (u.indexOf('/api/gallery/edit/zip-outputs') === 0) {
        const req = JSON.parse((opts && opts.body) || '{}');
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve({ assetId: 'zip-1', name: req.zipName || 'frames.zip', size: 42 }); },
          blob: function () { return Promise.resolve(zipBlob); }
        });
      }
      if (u.indexOf('/api/gallery/file?assetId=') === 0) {
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve({}); },
          blob: function () { return Promise.resolve(zipBlob); }
        });
      }
      return Promise.resolve({
        ok: false, status: 404,
        json: function () { return Promise.resolve({ error: 'unexpected fetch ' + u }); },
        blob: function () { return Promise.resolve(new Blob([])); }
      });
    },
    MediaBridge: {
      archiveStatus: function () { return Promise.resolve(false); }
    },
    GifEditorCore: {
      state: {
        srcImg: null,
        slices: [
          { canvas: { width: 10, height: 10 } },
          { canvas: { width: 10, height: 10 } },
          { canvas: { width: 10, height: 10 } }
        ]
      },
      commands: {
        composeFrame: function () {}
      },
      constants: {
        GIF_VENDOR_URL: '/vendor/gif.js/gif.js',
        EXPORT_MEM_LIMIT: 1.5 * 1024 * 1024 * 1024
      },
      dom: { spinnerText: spinnerText },
      showSpinner: function () {},
      hideSpinner: function () {},
      registerModule: function () {}
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, calls };
}

function loadExportModule(sandbox) {
  const src = fs.readFileSync(path.join(__dirname, 'static', 'gif-editor', 'gif-editor-export.js'), 'utf8');
  vm.runInNewContext(src, sandbox, { filename: 'gif-editor-export.js' });
}

// driveLegacyZipExport opens the export modal and clicks "Save as ZIP";
// MediaBridge.archiveStatus() is stubbed to false so exportZipLegacy runs.
async function driveLegacyZipExport() {
  const { sandbox, calls } = makeEnv();
  sandbox.GifEditorCore.registerModule = function (name, api) {
    if (name === 'export') sandbox.GifEditorCore.exportApi = api;
  };
  loadExportModule(sandbox);

  assert(sandbox.GifEditorCore.exportApi, 'export module must register during load');

  sandbox.GifEditorCore.exportApi.openExportModal();

  const saveZipBtn = sandbox.document.getElementById('gif-modal-save-zip-btn');
  assert(saveZipBtn, 'save-zip button must exist after opening the modal');
  saveZipBtn.click();

  await waitFor(function () {
    return calls.anchors.length > 0;
  }, 'zip download anchor');

  return { calls };
}

async function main() {
  await check('legacy ZIP export packs frames by assetId (no tempPath read)', async () => {
    const { calls } = await driveLegacyZipExport();

    // ---- upload-temp: one POST per frame, filename via ?name= ---------
    const upCalls = calls.fetches.filter(function (f) { return f.url.indexOf('/edit/upload-temp') !== -1; });
    assert.strictEqual(upCalls.length, 3, 'one upload-temp per frame');
    upCalls.forEach(function (c, i) {
      assert.strictEqual(c.opts.method, 'POST');
      assert(c.url.indexOf('name=frame_00' + (i + 1) + '.png') > 0, 'frame ' + (i + 1) + ' filename passed via ?name=');
    });

    // ---- zip-outputs: { assetIds } body, never a paths key -----------
    const zipCall = calls.fetches.find(function (f) { return f.url.indexOf('/edit/zip-outputs') !== -1; });
    assert(zipCall, 'zip-outputs must be fetched');
    assert.strictEqual(zipCall.opts.method, 'POST');
    const body = JSON.parse(zipCall.opts.body);
    assert.deepStrictEqual(body.assetIds, ['up-1', 'up-2', 'up-3'],
      'zip-outputs must pack the assetIds returned by upload-temp');
    assert(!('paths' in body), 'zip-outputs body must never carry a paths key');
    assert.strictEqual(body.cleanUp, true, 'cleanUp must pass through');
    assert(/^Frames_\d+\.zip$/.test(body.zipName), 'zipName must be the generated name');

    // ---- download: controlled asset URL, never a path -----------------
    const fileCall = calls.fetches.find(function (f) { return f.url.indexOf('/api/gallery/file?assetId=') === 0; });
    assert(fileCall, 'result must be fetched via the controlled /api/gallery/file URL');
    assert.strictEqual(fileCall.url, '/api/gallery/file?assetId=zip-1');

    assert.strictEqual(calls.anchors.length, 1, 'one download anchor');
    assert.strictEqual(calls.anchors[0].href, '/api/gallery/file?assetId=zip-1',
      'anchor href must be the controlled asset URL');
    assert(/^Frames_\d+\.zip$/.test(calls.anchors[0].download), 'anchor download name must come from the backend zip name');
    assert.strictEqual(calls.alerts.length, 0, 'no error alert on the happy path');
  });

  console.log(failures === 0 ? '\ngif-editor-export-contract.test.js: all checks passed' : '\ngif-editor-export-contract.test.js: ' + failures + ' check(s) failed');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
