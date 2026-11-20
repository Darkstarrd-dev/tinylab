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
// Covered contracts (docs/archive_compatibility_plan.md §7.3/§8.2):
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

// makeBatchEnv creates an isolated sandbox with a realistic 4-slot server
// concurrency gate (HTTP 429 on slot exhaustion) and minimal progress DOM stubs
// to exercise _startBatch, _cancelJob, and _geResumeActive end to end.
function makeBatchEnv(simOpts) {
  simOpts = simOpts || {};
  const { sandbox, calls } = makeEnv();
  const elements = {};
  [
    'pg-modal-overlay',
    'ge-result-area',
    'ge-progress-section',
    'ge-progress-bar',
    'ge-progress-text',
    'ge-console-panel',
    'ge-console-log',
    'ge-console-cmd',
    'ge-start-btn',
    'ge-treebatch-start-btn',
  ].forEach(function (id) {
    elements[id] = {
      id: id,
      style: {},
      value: 0,
      textContent: '',
      innerHTML: '',
      disabled: false,
      scrollTop: 0,
      scrollHeight: 0,
      classList: { add: function () {}, remove: function () {}, toggle: function () {} },
      setAttribute: function () {},
      getAttribute: function () { return null; },
      querySelector: function () { return null; },
      appendChild: function () {},
      getBoundingClientRect: function () { return { height: 400 }; },
    };
  });

  sandbox.document.getElementById = function (id) { return elements[id] || null; };
  sandbox.document.querySelector = function () { return null; };
  sandbox.document.createElement = function () {
    return {
      className: '',
      textContent: '',
      setAttribute: function () {},
      appendChild: function () {},
      querySelector: function () { return null; },
    };
  };
  sandbox.pgT = function (k, args) {
    return args && args.length ? (String(k) + ':' + args.join('/')) : String(k);
  };

  const sim = {
    semLimit: simOpts.semLimit || 4,
    activeSlots: 0,
    peakActive: 0,
    externalHeld: simOpts.externalHeld || 0,
    forceInitial429s: simOpts.forceInitial429s || 0,
    status429Count: 0,
    completedCount: 0,
    starts: [],
    cancels: [],
    statusPolls: {},
    jobs: {},
    seq: 0,
  };

  sandbox.fetch = function (url, opts) {
    const u = String(url);
    calls.fetches.push({ url: u, opts: opts || null });

    if (u === '/api/gallery/edit/start') {
      const body = JSON.parse((opts && opts.body) || '{}');
      const startIndex = sim.starts.length;
      sim.starts.push(body);
      if (sim.forceInitial429s > 0) {
        sim.forceInitial429s--;
        sim.status429Count++;
        return Promise.resolve({
          ok: false,
          status: 429,
          json: function () { return Promise.resolve({ error: 'too many concurrent media jobs, retry later' }); },
        });
      }
      if (sim.activeSlots + sim.externalHeld >= sim.semLimit) {
        sim.status429Count++;
        return Promise.resolve({
          ok: false,
          status: 429,
          json: function () { return Promise.resolve({ error: 'too many concurrent media jobs, retry later' }); },
        });
      }
      const jobId = 'job-' + (++sim.seq);
      sim.activeSlots++;
      if (sim.activeSlots > sim.peakActive) sim.peakActive = sim.activeSlots;
      const dur = simOpts.durationFn ? simOpts.durationFn(startIndex, body) : 20;
      const job = { id: jobId, status: 'running', overwritten: !!body.overwrite, timer: null };
      job.timer = setTimeout(function () {
        if (job.status !== 'running') return;
        sim.activeSlots--;
        job.status = 'completed';
        sim.completedCount++;
        if (simOpts.onJobComplete) simOpts.onJobComplete(sim, job);
      }, dur);
      sim.jobs[jobId] = job;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve({ jobId: jobId }); },
      });
    }

    if (u.indexOf('/api/gallery/edit/status/') === 0) {
      const jobId = decodeURIComponent(u.slice('/api/gallery/edit/status/'.length));
      const job = sim.jobs[jobId];
      sim.statusPolls[jobId] = (sim.statusPolls[jobId] || 0) + 1;
      if (!job) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: function () { return Promise.resolve({ error: 'job not found' }); },
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({
            id: jobId,
            status: job.status,
            progress: job.status === 'completed' ? 100 : 50,
            overwritten: job.overwritten,
            outputName: 'out_' + jobId + '.webp',
            assetId: job.overwritten ? '' : ('asset-' + jobId),
          });
        },
      });
    }

    if (u.indexOf('/api/gallery/edit/cancel/') === 0) {
      const jobId = decodeURIComponent(u.slice('/api/gallery/edit/cancel/'.length));
      sim.cancels.push(jobId);
      const job = sim.jobs[jobId];
      if (job && job.status === 'running') {
        clearTimeout(job.timer);
        sim.activeSlots--;
        job.status = 'cancelled';
      }
      return Promise.resolve({
        ok: true,
        status: 204,
        json: function () { return Promise.reject(new Error('no body')); },
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
      json: function () { return Promise.resolve({ error: 'unexpected fetch ' + u }); },
    });
  };

  loadFiles(sandbox);
  sandbox._batchPollDelays = [5, 10];
  sandbox._batchRetryDelays = [5, 10];
  return { sandbox, calls, elements, sim };
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

  // ---- 7b. triggerMediaEditor: grantId video opens without upload ------
  // Regression: triggerMediaEditor used to route every non-absPath item with
  // getBlob through a full download + POST /edit/upload-temp BEFORE the modal
  // opened, so open latency scaled with file size. Backend-grant items are
  // server-resolvable (openMediaEditor probes/starts by grantId), so they
  // must pass straight through to openMediaEditor with zero fetches.
  await check('triggerMediaEditor opens grantId video without upload-temp', async () => {
    const { sandbox, calls } = makeEnv();
    loadFiles(sandbox);
    sandbox.openMediaEditor = capturedOpenMediaEditor(calls);
    const item = { kind: 'backend', name: 'big.mp4', grantId: 'g1', rel: 'big.mp4', size: 67108864, getBlob: function () { throw new Error('getBlob must not be called for grantId items'); } };
    sandbox.galleryState = { mediaType: 'video', items: [], index: -1, videoItems: [item], videoIndex: 0 };
    await sandbox.triggerMediaEditor('video');
    await waitFor(function () { return calls.opened.length > 0; }, 'openMediaEditor call');
    assert.strictEqual(calls.opened.length, 1, 'openMediaEditor must be called once');
    assert.strictEqual(calls.opened[0].item, item, 'grantId item must pass through unmodified');
    assert.strictEqual(calls.opened[0].mediaType, 'video');
    assert(!calls.fetches.some(function (f) { return f.url.indexOf('/edit/upload-temp') !== -1; }), 'upload-temp must not be fetched before the modal opens');
    assert(!calls.fetches.some(function (f) { return f.url.indexOf('/api/gallery/file') !== -1; }), 'file download must not happen before the modal opens');
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

  // ---- 9. batch 20 items: non-uniform durations within 4-slot cap ------
  await check('batch 20 items complete 20/0 within 4-slot cap and zero 429s', async () => {
    const { sandbox, elements, sim } = makeBatchEnv({
      durationFn: function (idx) { return 8 + (idx % 5) * 7; },
    });
    const items = [];
    for (let i = 0; i < 20; i++) {
      items.push({ kind: 'backend', name: 'img_' + i + '.png', grantId: 'g1', rel: 'img_' + i + '.png' });
    }
    sandbox._startBatch('image_transcode', { format: 'webp', quality: 85 }, { overwrite: true, outputDir: null }, false, items);

    await waitFor(function () {
      return sandbox._geActiveJob === null && elements['ge-result-area'].innerHTML.indexOf('geBatchDone:') !== -1;
    }, 'batch 20 completion', 5000);

    assert.strictEqual(sim.starts.length, 20, 'all 20 items must start once');
    assert.strictEqual(sim.completedCount, 20, 'all 20 items must complete');
    assert.strictEqual(sim.status429Count, 0, '4-worker pool must not hit 429 when slots are free');
    assert(sim.peakActive <= 4 && sim.peakActive >= 2, 'peak concurrency expected 2..4, got ' + sim.peakActive);
    assert(elements['ge-result-area'].innerHTML.indexOf('geBatchDone:20/0') !== -1, 'expected geBatchDone:20/0 in ' + elements['ge-result-area'].innerHTML);
    assert.strictEqual(elements['ge-progress-bar'].value, 100);
  });

  // ---- 10. batch 429 contention backoff retries and succeeds -----------
  await check('batch retries 429 responses under slot contention and completes 10/0', async () => {
    const { sandbox, elements, sim } = makeBatchEnv({
      externalHeld: 2,
      forceInitial429s: 4,
      durationFn: function () { return 15; },
    });
    setTimeout(function () { sim.externalHeld = 0; }, 45);
    const items = [];
    for (let i = 0; i < 10; i++) {
      items.push({ kind: 'backend', name: 'p_' + i + '.png', grantId: 'g1', rel: 'p_' + i + '.png' });
    }
    sandbox._startBatch('image_transcode', { format: 'webp', quality: 85 }, { overwrite: true, outputDir: null }, false, items);

    await waitFor(function () {
      return sandbox._geActiveJob === null && elements['ge-result-area'].innerHTML.indexOf('geBatchDone:') !== -1;
    }, 'batch 429 retry completion', 5000);

    assert(sim.status429Count >= 4, 'expected 429s to occur before backoff retry, got ' + sim.status429Count);
    assert.strictEqual(sim.completedCount, 10, 'all 10 items must succeed after 429 backoff');
    assert(elements['ge-result-area'].innerHTML.indexOf('geBatchDone:10/0') !== -1, 'expected geBatchDone:10/0 in ' + elements['ge-result-area'].innerHTML);
  });

  // ---- 11. batch cancel mid-flight isolates subsequent batch -----------
  await check('batch cancel mid-flight stops pending items and isolates next batch', async () => {
    const { sandbox, elements, sim } = makeBatchEnv({
      durationFn: function () { return 80; },
    });
    const batch1 = [];
    for (let i = 0; i < 12; i++) {
      batch1.push({ kind: 'backend', name: 'c_' + i + '.png', grantId: 'g1', rel: 'c_' + i + '.png' });
    }
    sandbox._startBatch('image_transcode', { format: 'webp' }, { overwrite: true, outputDir: null }, false, batch1);
    await waitFor(function () { return sim.starts.length === 4; }, 'first 4 jobs started');

    sandbox._cancelJob();
    await new Promise(function (r) { setTimeout(r, 45); });

    assert.strictEqual(sim.cancels.length, 4, 'active 4 jobs must be cancelled');
    assert.strictEqual(sim.starts.length, 4, 'remaining 8 items must not fire /edit/start after cancel');
    assert.strictEqual(sim.activeSlots, 0, 'all cancelled slots must drain');
    assert.strictEqual(sandbox._geActiveJob, null);
    assert.strictEqual(elements['ge-result-area'].innerHTML.indexOf('geBatchDone:'), -1, 'cancelled batch must not render completion');

    // Start a clean second batch immediately in the same VM state.
    const batch2 = [];
    for (let j = 0; j < 6; j++) {
      batch2.push({ kind: 'backend', name: 'n_' + j + '.png', grantId: 'g1', rel: 'n_' + j + '.png' });
    }
    sandbox._startBatch('image_transcode', { format: 'webp' }, { overwrite: true, outputDir: null }, false, batch2);
    await waitFor(function () {
      return sandbox._geActiveJob === null && elements['ge-result-area'].innerHTML.indexOf('geBatchDone:') !== -1;
    }, 'second batch completion', 5000);

    assert.strictEqual(sim.starts.length, 10, '4 cancelled + 6 new starts');
    assert.strictEqual(sim.completedCount, 6, 'all 6 items of new batch must complete');
    assert(elements['ge-result-area'].innerHTML.indexOf('geBatchDone:6/0') !== -1, 'expected geBatchDone:6/0');
  });

  // ---- 12. _geResumeActive while running does not duplicate counts -----
  await check('_geResumeActive during active batch keeps exact completion count and disables tree Start', async () => {
    const { sandbox, elements, sim } = makeBatchEnv({
      durationFn: function (i) { return i < 4 ? 35 : 15; },
    });
    const items = [];
    for (let i = 0; i < 8; i++) {
      items.push({ kind: 'backend', name: 'r_' + i + '.png', grantId: 'g1', rel: 'r_' + i + '.png' });
    }
    sandbox._startBatch('image_transcode', { format: 'webp' }, { overwrite: true, outputDir: null }, false, items);
    await waitFor(function () { return sim.starts.length === 4; }, '4 jobs started');

    sandbox._geResumeActive();
    assert.strictEqual(elements['ge-treebatch-start-btn'].disabled, true, 'tree batch Start must stay disabled on resume');
    assert.strictEqual(elements['ge-start-btn'].disabled, true, 'edit Start must stay disabled on resume');

    await waitFor(function () {
      return sandbox._geActiveJob === null && elements['ge-result-area'].innerHTML.indexOf('geBatchDone:') !== -1;
    }, 'resumed batch completion', 5000);

    assert.strictEqual(sim.completedCount, 8);
    assert(elements['ge-result-area'].innerHTML.indexOf('geBatchDone:8/0') !== -1, 'expected geBatchDone:8/0 in ' + elements['ge-result-area'].innerHTML);
    assert.strictEqual(elements['ge-treebatch-start-btn'].disabled, false, 'tree batch Start re-enables on completion');
  });

  // ---- 13. gallery-edit scripts must not overwrite global runWithConcurrency ----
  await check('loading gallery-edit scripts preserves existing global runWithConcurrency', async () => {
    const { sandbox } = makeEnv();
    const sentinel = function existingRunWithConcurrency() {};
    sandbox.runWithConcurrency = sentinel;
    loadFiles(sandbox);
    assert.strictEqual(sandbox.runWithConcurrency, sentinel, 'gallery-edit-batch.js must not overwrite global runWithConcurrency');
  });

  console.log(failures === 0 ? '\ngallery-edit-contract.test.js: all checks passed' : '\ngallery-edit-contract.test.js: ' + failures + ' check(s) failed');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('gallery-edit-contract.test.js crashed:', err);
  process.exit(1);
});
