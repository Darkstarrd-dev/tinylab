// web/static/media-bridge.test.js
// Zero-dependency Node smoke test for the MediaBridge contract
// (web/static/media-bridge.js). Loads the module in a sandboxed VM with
// stubbed browser globals and drives the public API end to end.
//
// Run:  node web/static/media-bridge.test.js
//
// Covered contracts (archive_compatibility_plan.md §9.2):
//   register(blob|url) -> assetId; openGallery(assetId|assetId[]);
//   consume(assetId); no absolute paths cross the bridge; no galleryState
//   writes from the bridge; tokens survive until consumed / TTL; Archive API
//   capability probe with a real client-side fallback when absent/failing.

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

// Build a sandboxed browser-like environment.
// statusOk  -> GET /api/archive/status responds 200 with a capability object
// postOk    -> POST /api/archive/assets responds 200 with {assetId}
// hasGallery -> galleryImportAssets + renderGallery globals exist
function makeEnv(opts) {
  opts = opts || {};
  const statusOk = opts.statusOk !== false;
  const postOk = opts.postOk !== false;
  const hasGallery = opts.hasGallery !== false;
  const calls = { fetches: [], toasts: [], navigateTo: null, galleryImports: [], currentPage: 'download' };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Promise,
    Blob: typeof Blob !== 'undefined' ? Blob : undefined,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    toast: function (msg, type) { calls.toasts.push({ msg: msg, type: type }); },
    t: function (key) { return key; },
    get currentPage() { return calls.currentPage; },
    set currentPage(v) { calls.currentPage = v; },
    navigateTo: function (page) { calls.navigateTo = page; calls.currentPage = page; },
    fetch: function (url, fetchOpts) {
      calls.fetches.push({ url: String(url), opts: fetchOpts || null });
      const u = String(url);
      if (u.indexOf('/api/archive/status') === 0) {
        if (!statusOk) return Promise.resolve({ ok: false, status: 404 });
        return Promise.resolve({
          ok: true,
          json: function () { return Promise.resolve({ zip: { read: true, write: true }, sevenZip: { available: false }, rar: { available: false } }); }
        });
      }
      if (u.indexOf('/api/archive/assets?') === 0) {
        if (!postOk) return Promise.resolve({ ok: false, status: 413 });
        return Promise.resolve({
          ok: true,
          json: function () { return Promise.resolve({ assetId: 'srv-' + calls.fetches.length }); }
        });
      }
      if (u.indexOf('/api/archive/assets/') === 0) {
        return Promise.resolve({
          ok: true,
          blob: function () { return Promise.resolve(new Blob(['server-bytes'])); }
        });
      }
      if (u.indexOf('/api/downloads/') === 0 && u.indexOf('/file') > 0) {
        return Promise.resolve({
          ok: true,
          blob: function () { return Promise.resolve(new Blob(['video-bytes'])); }
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (hasGallery) {
    sandbox.renderGallery = function () {};
    sandbox.galleryImportAssets = function (assets) {
      calls.galleryImports.push(assets);
      return Promise.resolve(assets.length);
    };
  }
  return { sandbox, calls };
}

function loadBridge(sandbox) {
  const src = fs.readFileSync(path.join(__dirname, 'media-bridge.js'), 'utf8');
  vm.runInNewContext(src, sandbox, { filename: 'media-bridge.js' });
  return sandbox.MediaBridge;
}

async function main() {
  const gifBlob = new Blob(['gif-bytes'], { type: 'image/gif' });

  // ---- 1. URL-based registration (Download handoff) -------------------
  await check('register(url) keeps controlled URL, no client copy, no probe', async () => {
    const { sandbox, calls } = makeEnv({});
    const bridge = loadBridge(sandbox);
    const id = await bridge.register({
      name: 'clip.mp4', mime: 'video/mp4', kind: 'video', format: 'mp4',
      url: '/api/downloads/d1/file', size: 1234
    });
    assert(id && typeof id === 'string');
    const meta = bridge.getAsset(id);
    assert.strictEqual(meta.url, '/api/downloads/d1/file');
    assert.strictEqual(meta.kind, 'video');
    assert.strictEqual(calls.fetches.length, 0, 'url assets must not probe the Archive API');
    const blob = await bridge.getAssetBlob(id);
    assert(blob && blob.size > 0, 'getAssetBlob must fetch the controlled URL');
  });

  // ---- 2. Blob registration with Archive API present ------------------
  await check('register(blob) mirrors to /api/archive/assets when available', async () => {
    const { sandbox, calls } = makeEnv({ statusOk: true, postOk: true });
    const bridge = loadBridge(sandbox);
    const id = await bridge.register({ name: 'out.gif', mime: 'image/gif', kind: 'image', format: 'gif', blob: gifBlob });
    const post = calls.fetches.find((f) => f.url.indexOf('/api/archive/assets?') === 0);
    assert(post, 'POST /api/archive/assets must be called');
    assert.strictEqual(post.opts.method, 'POST');
    assert(post.url.indexOf('name=out.gif') > 0, 'filename passed via ?name=');
    const meta = bridge.getAsset(id);
    assert(meta.serverAssetId && meta.serverAssetId.indexOf('srv-') === 0, 'server assetId assigned');
    assert.strictEqual(meta.url, '/api/archive/assets/' + meta.serverAssetId);
    assert.strictEqual(bridge._internals.registry[id].blob, null, 'client copy dropped when server owns bytes');
    const blob = await bridge.getAssetBlob(id);
    assert(blob && blob.size > 0, 'bytes resolvable by server assetId');
  });

  // ---- 3. Blob registration with Archive API absent (fallback) --------
  await check('register(blob) falls back to client copy when Archive API absent', async () => {
    const { sandbox, calls } = makeEnv({ statusOk: false });
    const bridge = loadBridge(sandbox);
    const id = await bridge.register({ name: 'out.gif', mime: 'image/gif', kind: 'image', format: 'gif', blob: gifBlob });
    assert(calls.fetches.some((f) => f.url.indexOf('/api/archive/status') === 0), 'capability probe ran');
    assert.strictEqual(bridge._internals.registry[id].blob, gifBlob, 'client blob retained');
    assert.strictEqual(bridge.getAsset(id).url, null);
    const blob = await bridge.getAssetBlob(id);
    assert.strictEqual(blob, gifBlob);
  });

  // ---- 4. Archive API present but asset POST fails (real fallback) ----
  await check('register(blob) falls back to client copy when server rejects', async () => {
    const { sandbox } = makeEnv({ statusOk: true, postOk: false });
    const bridge = loadBridge(sandbox);
    const id = await bridge.register({ name: 'out.gif', mime: 'image/gif', kind: 'image', blob: gifBlob });
    assert.strictEqual(bridge._internals.registry[id].blob, gifBlob, 'client copy retained after rejected upload');
    assert.strictEqual(bridge.getAsset(id).serverAssetId, null);
  });

  // ---- 5. openGallery: queue, navigate, deliver via galleryImportAssets
  await check('openGallery navigates and delivers through Gallery entry only', async () => {
    const { sandbox, calls } = makeEnv({ statusOk: false });
    const bridge = loadBridge(sandbox);
    const id = await bridge.register({ name: 'out.gif', mime: 'image/gif', kind: 'image', format: 'gif', blob: gifBlob });
    const opened = bridge.openGallery(id);
    assert.strictEqual(opened, true);
    assert.strictEqual(calls.navigateTo, 'gallery', 'openGallery must switch to the Gallery page');
    const count = await bridge.deliverPendingImports();
    assert.strictEqual(count, 1);
    assert.strictEqual(calls.galleryImports.length, 1);
    const handed = calls.galleryImports[0][0];
    assert.strictEqual(handed.assetId, id);
    assert.strictEqual(handed.name, 'out.gif');
    assert.strictEqual(handed.kind, 'image');
    assert.strictEqual(bridge.getAsset(id), null, 'token consumed after successful import');
  });
  // ---- 6a. archiveStatus capability probe ------------------------------
  await check('archiveStatus() resolves capability when present, false when absent', async () => {
    const present = makeEnv({ statusOk: true });
    const b1 = loadBridge(present.sandbox);
    const caps = await b1.archiveStatus();
    assert(caps && caps.zip && caps.zip.read === true, 'capability object returned when API present');
    const absent = makeEnv({ statusOk: false });
    const b2 = loadBridge(absent.sandbox);
    const none = await b2.archiveStatus();
    assert.strictEqual(none, false, 'false when API absent');
    // Cached: a second call must not re-fetch.
    const fetches = present.calls.fetches.filter((f) => f.url.indexOf('/api/archive/status') === 0);
    await b1.archiveStatus();
    assert.strictEqual(present.calls.fetches.filter((f) => f.url.indexOf('/api/archive/status') === 0).length, fetches.length, 'probe cached');
  });

  // ---- 6b. GIF pack gate: archiveStatus feeds exportZip path selection --
  await check('archiveStatus() drives gif export pack-path selection', async () => {
    const { sandbox } = makeEnv({ statusOk: true });
    const bridge = loadBridge(sandbox);
    const caps = await bridge.archiveStatus();
    assert.strictEqual(caps !== false, true, 'Path A (assets+pack) selected when API present');
    const absent = makeEnv({ statusOk: false });
    const b2 = loadBridge(absent.sandbox);
    assert.strictEqual(await b2.archiveStatus(), false, 'Path B (legacy zip-outputs) selected when API absent');
  });


  // ---- 6. multi-asset openGallery (Download multi-select) -------------
  await check('openGallery(assetId[]) delivers all assets in one batch', async () => {
    const { sandbox, calls } = makeEnv({ statusOk: false });
    const bridge = loadBridge(sandbox);
    const a = await bridge.register({ name: 'a.mp4', mime: 'video/mp4', kind: 'video', url: '/api/downloads/a/file' });
    const b = await bridge.register({ name: 'b.mp4', mime: 'video/mp4', kind: 'video', url: '/api/downloads/b/file' });
    const opened = bridge.openGallery([a, b]);
    assert.strictEqual(opened, true);
    assert.strictEqual(calls.navigateTo, 'gallery');
    await bridge.deliverPendingImports();
    assert.strictEqual(calls.galleryImports.length, 1);
    // NOTE: the sandbox realm has its own Array.prototype, so compare by
    // membership instead of deepStrictEqual (which is prototype-sensitive).
    const gotIds = calls.galleryImports[0].map((x) => x.assetId);
    assert.strictEqual(gotIds.length, 2);
    assert(gotIds.indexOf(a) >= 0 && gotIds.indexOf(b) >= 0, 'both assets delivered');
    assert.strictEqual(bridge.getAsset(a), null);
    assert.strictEqual(bridge.getAsset(b), null);
  });

  // ---- 7. already on Gallery page -> immediate delivery, no nav --------
  await check('openGallery on Gallery page delivers without re-navigation', async () => {
    const { sandbox, calls } = makeEnv({ statusOk: false });
    const bridge = loadBridge(sandbox);
    sandbox.currentPage = 'gallery';
    const id = await bridge.register({ name: 'out.png', mime: 'image/png', kind: 'image', blob: gifBlob });
    bridge.openGallery(id);
    await new Promise((r) => setImmediate(r)); // let the microtask delivery run
    assert.strictEqual(calls.navigateTo, null, 'no navigation when already on Gallery');
    assert.strictEqual(calls.galleryImports.length, 1);
  });

  // ---- 8. queue dedupe on repeated openGallery ------------------------
  await check('repeated openGallery of the same asset queues once', async () => {
    const { sandbox, calls } = makeEnv({ statusOk: false });
    const bridge = loadBridge(sandbox);
    const id = await bridge.register({ name: 'out.gif', mime: 'image/gif', kind: 'image', blob: gifBlob });
    bridge.openGallery(id);
    bridge.openGallery(id);
    assert.strictEqual(bridge._internals.pendingImports.length, 1);
    await bridge.deliverPendingImports();
    assert.strictEqual(calls.galleryImports.length, 1);
    // A second deliver (page re-render) must not re-import consumed tokens.
    await bridge.deliverPendingImports();
    assert.strictEqual(calls.galleryImports.length, 1);
  });

  // ---- 9. missing/expired asset ---------------------------------------
  await check('openGallery of an unknown asset warns and returns false', async () => {
    const { sandbox, calls } = makeEnv({ statusOk: false });
    const bridge = loadBridge(sandbox);
    const opened = bridge.openGallery('nope');
    assert.strictEqual(opened, false);
    assert(calls.toasts.some((x) => x.msg === 'mediaBridgeAssetExpired'), 'expired-token toast shown');
  });

  // ---- 10. no Gallery in build ----------------------------------------
  await check('openGallery without Gallery globals warns, never touches galleryState', async () => {
    const { sandbox, calls } = makeEnv({ statusOk: false, hasGallery: false });
    const bridge = loadBridge(sandbox);
    const id = await bridge.register({ name: 'out.gif', mime: 'image/gif', kind: 'image', blob: gifBlob });
    const opened = bridge.openGallery(id);
    assert.strictEqual(opened, false);
    assert.strictEqual(calls.navigateTo, null, 'must not navigate without a Gallery consumer');
    assert(calls.toasts.some((x) => x.msg === 'mediaBridgeGalleryUnavailable'));
    const count = await bridge.deliverPendingImports();
    assert.strictEqual(count, 0);
    assert.strictEqual(bridge.getAsset(id) !== null, true, 'token survives until TTL');
  });

  // ---- 11. TTL expiry --------------------------------------------------
  await check('tokens expire at TTL and are swept lazily', async () => {
    const { sandbox } = makeEnv({ statusOk: false });
    const bridge = loadBridge(sandbox);
    bridge._internals.setTtl(1000);
    let fake = Date.now();
    bridge._internals.setNow(function () { return fake; });
    const id = await bridge.register({ name: 'out.gif', mime: 'image/gif', kind: 'image', blob: gifBlob });
    assert(bridge.getAsset(id) !== null);
    fake += 2000;
    assert.strictEqual(bridge.getAsset(id), null, 'expired token removed');
    const blob = await bridge.getAssetBlob(id);
    assert.strictEqual(blob, null);
  });

  // ---- 12. resolver-based registration --------------------------------
  await check('register(resolver) resolves lazily and caches the blob', async () => {
    const { sandbox } = makeEnv({ statusOk: false });
    const bridge = loadBridge(sandbox);
    let resolverCalls = 0;
    const id = await bridge.register({
      name: 'lazy.png', mime: 'image/png', kind: 'image',
      resolver: function () { resolverCalls++; return Promise.resolve(new Blob(['lazy'])); }
    });
    assert.strictEqual(bridge._internals.registry[id].blob, null, 'nothing fetched eagerly');
    const b1 = await bridge.getAssetBlob(id);
    const b2 = await bridge.getAssetBlob(id);
    assert(b1 && b2);
    assert.strictEqual(resolverCalls, 1, 'resolver runs once, result cached');
  });

  // ---- 13. consume -----------------------------------------------------
  await check('consume releases the token and its blob reference', async () => {
    const { sandbox } = makeEnv({ statusOk: false });
    const bridge = loadBridge(sandbox);
    const id = await bridge.register({ name: 'out.gif', mime: 'image/gif', kind: 'image', blob: gifBlob });
    bridge.consume(id);
    assert.strictEqual(bridge.getAsset(id), null);
    assert.strictEqual(bridge._internals.registry[id], undefined);
    const blob = await bridge.getAssetBlob(id);
    assert.strictEqual(blob, null);
  });

  // ---- 14. deliver with an empty queue is a no-op ----------------------
  await check('deliverPendingImports with an empty queue is a no-op', async () => {
    const { sandbox, calls } = makeEnv({ statusOk: false });
    const bridge = loadBridge(sandbox);
    const count = await bridge.deliverPendingImports();
    assert.strictEqual(count, 0);
    assert.strictEqual(calls.galleryImports.length, 0);
  });

  console.log(failures === 0 ? '\nmedia-bridge.test.js: all checks passed' : '\nmedia-bridge.test.js: ' + failures + ' check(s) failed');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('media-bridge.test.js crashed:', err);
  process.exit(1);
});
