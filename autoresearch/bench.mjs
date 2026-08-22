// Gallery image-load responsiveness benchmark.
//
// Loads the REAL frontend pipeline (web/playground/static-pg/gallery/
// gallery-state.js + gallery-io.js) inside a Node vm sandbox, replaces the
// backend HTTP endpoints with deterministic fixed-latency mocks, and measures
// how long a "paste a folder full of archive packs" import takes until the
// user sees content:
//
//   ttfi_ms  — time until the tree is rendered AND the first item's main
//              image src is resolved (primary metric: interaction readiness)
//   tree_ms  — time until the folder tree first renders with items present
//   total_ms — time until the whole import finishes appending
//
// The render layer (updateDirStructure / renderTreePanel / renderThumbnails /
// setActive / renderActive ...) is stubbed with instrumented equivalents that
// preserve the production contract (renderActive -> ensureMainSrc -> mainURL).
// All latency constants are fixed => fully deterministic runs.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GALLERY_DIR = path.join(ROOT, 'web', 'playground', 'static-pg', 'gallery');

// ---------- workload shape (mirrors the user complaint: paste/drop of a
// directory holding many ComfyUI-style output packs) ----------
const N_ZIPS = 60;            // archive packs in the pasted folder
const ENTRIES_PER_ZIP = 30;   // images inside each pack
const N_IMAGES = 20;          // loose images next to the packs

// ---------- mocked backend costs (ms, fixed) ----------
const MS_LISTDIR = 20;        // POST /api/gallery/list-dir
const MS_ZIP_FROM_PATH = 180; // POST /api/gallery/zip-from-path per pack
                              // (backend opens the archive + builds manifest)
const MS_ENTRY_FETCH = 40;    // GET  /api/gallery/zip/<sid>/<entry>
const MS_FILE_FETCH = 40;     // GET  /api/gallery/file?grantId=...

const REPS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pad3(n) {
  return String(n).padStart(3, '0');
}

function buildFilesList() {
  const files = [];
  for (let i = 1; i <= N_ZIPS; i++) {
    files.push({ kind: 'zip', name: `pack-${pad3(i)}.zip`, rel: `pack-${pad3(i)}.zip`, size: 50_000_000 });
  }
  for (let i = 1; i <= N_IMAGES; i++) {
    files.push({ kind: 'image', name: `shot-${pad3(i)}.png`, rel: `shot-${pad3(i)}.png`, size: 2_000_000 });
  }
  return files;
}

const ZIP_ENTRIES = Array.from({ length: ENTRIES_PER_ZIP }, (_, i) => ({
  path: `frames/img_${pad3(i + 1)}.png`,
  index: i,
  size: 1_500_000,
}));

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    blob: async () => new Uint8Array(64),
  };
}

function makeMockFetch(state) {
  const files = buildFilesList();
  return async function fetchMock(url) {
    url = String(url);
    const base = url.split('?')[0];
    if (base === '/api/gallery/list-dir') {
      await sleep(MS_LISTDIR);
      return jsonResponse({ files });
    }
    if (base === '/api/gallery/zip-from-path') {
      state.zipSessions += 1;
      const sid = 'sess-' + pad3(state.zipSessions);
      await sleep(MS_ZIP_FROM_PATH);
      return jsonResponse({ sessionId: sid, manifest: { entries: ZIP_ENTRIES } });
    }
    if (base.startsWith('/api/gallery/zip/')) {
      await sleep(MS_ENTRY_FETCH);
      return jsonResponse({});
    }
    if (base === '/api/gallery/file') {
      await sleep(MS_FILE_FETCH);
      return jsonResponse({});
    }
    throw new Error('bench: unexpected fetch ' + url);
  };
}

// Render-layer stand-ins for gallery-tree.js / gallery-video.js. Injected via
// an in-context bootstrap so their free variables (galleryState,
// ensureMainSrc) resolve against the vm globals created by the real scripts.
// They keep the production contract: setActive/renderActive drive
// ensureMainSrc so the "first image displayed" event reflects the real
// data-dependency chain (item appended -> blob fetched -> mainURL set).
const RENDER_STUBS = `
  function __markTree() {
    if (!__bench.events.treeShownAt && galleryState.items.length > 0) {
      __bench.events.treeShownAt = __bench.now();
    }
  }
  function updateDirStructure() {
    __markTree();
    __bench.events.treeRebuilds = (__bench.events.treeRebuilds || 0) + 1;
    __bench.events.treeScanned = (__bench.events.treeScanned || 0) + galleryState.items.length;
  }
  function renderTreePanel() { __markTree(); }
  function renderThumbnails() {
    __bench.events.stripRebuilds = (__bench.events.stripRebuilds || 0) + 1;
    __bench.events.stripScanned = (__bench.events.stripScanned || 0) + galleryState.items.length;
  }
  function updateCurrentFolderItems() {}
  function updateLayoutMode() {}
  function updateVideoDirStructure() {}
  function setVideoActive() {}
  function renderActiveVideo() {}
  function setActive(index) {
    if (!galleryState.items.length) return;
    galleryState.index = index;
    renderActive(index);
  }
  function renderActive(index) {
    var item = galleryState.items[index];
    if (!item) return;
    var isFirst = !__bench.events.firstImageAt;
    ensureMainSrc(item).then(function () {
      if (item.mainURL && isFirst && !__bench.events.firstImageAt) {
        __bench.events.firstImageAt = __bench.now();
      }
    });
  }
`;

async function runOnce() {
  const stateSrc = readFileSync(path.join(GALLERY_DIR, 'gallery-state.js'), 'utf8');
  const ioSrc = readFileSync(path.join(GALLERY_DIR, 'gallery-io.js'), 'utf8');

  const events = { treeShownAt: null, firstImageAt: null };
  const netState = { zipSessions: 0 };
  let blobCounter = 0;
  const now = () => performance.now();

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
      body: { appendChild() {} },
    },
    requestAnimationFrame(fn) { setTimeout(fn, 0); },
    FsApi: {
      BlobTracker: {
        create() { return 'blob:bench/' + (++blobCounter); },
        revoke() {},
      },
    },
    fetch: makeMockFetch(netState),
  };
  sandbox.window = sandbox;
  sandbox.__bench = { events, now };
  const ctx = vm.createContext(sandbox);

  vm.runInContext(stateSrc, ctx, { filename: 'gallery-state.js' });
  vm.runInContext(RENDER_STUBS, ctx, { filename: 'bench-render-stubs.js' });
  vm.runInContext(ioSrc, ctx, { filename: 'gallery-io.js' });

  const grants = [{ name: 'bundle', isDir: true, pathGrantId: 'grant-dir-1' }];

  const t0 = now();
  await sandbox.loadBackendGrants(grants);
  const tDone = now();

  const itemsTotal = sandbox.galleryState.items.length;
  const expected = N_ZIPS * ENTRIES_PER_ZIP + N_IMAGES;
  if (itemsTotal !== expected) {
    throw new Error(`items_total=${itemsTotal}, expected ${expected}`);
  }
  // Pack-integrity assertions: total count alone cannot catch the
  // runWithConcurrency first-wave bug (each dropped pack was exactly offset
  // by one duplicated task on another pack, so items_total stayed equal).
  // Group by the INPUT-derived path prefix ("packName/entry"), not by
  // sessionId — the mock backend mints a fresh session per request, so a
  // duplicated pack would otherwise masquerade as extra distinct packs.
  const perPack = new Map();
  for (const it of sandbox.galleryState.items) {
    if (it.kind !== 'zip') continue;
    const pack = String(it.path).split('/')[0];
    perPack.set(pack, (perPack.get(pack) || 0) + 1);
  }
  if (perPack.size !== N_ZIPS || [...perPack.values()].some((n) => n !== ENTRIES_PER_ZIP)) {
    throw new Error(
      `pack integrity violated: ${perPack.size}/${N_ZIPS} distinct packs, ` +
      `entries per pack ${JSON.stringify([...perPack.values()].sort((a, b) => a - b))}`
    );
  }
  if (events.treeShownAt == null) {
    throw new Error('tree display event never fired');
  }
  // ensureMainSrc of the active item resolves independently of
  // loadBackendGrants; give the in-flight display chain a bounded window.
  for (let waited = 0; events.firstImageAt == null && waited < 5000; waited += 5) {
    await sleep(5);
  }
  if (events.firstImageAt == null) {
    throw new Error('main-image display event never fired');
  }

  return {
    ttfi_ms: Math.max(events.treeShownAt, events.firstImageAt) - t0,
    tree_ms: events.treeShownAt - t0,
    total_ms: tDone - t0,
    items_total: itemsTotal,
    strip_rebuilds: events.stripRebuilds || 0,
    strip_scanned: events.stripScanned || 0,
    tree_rebuilds: events.treeRebuilds || 0,
    tree_scanned: events.treeScanned || 0,
  };
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const results = [];
for (let i = 0; i < REPS; i++) {
  const r = await runOnce();
  results.push(r);
  console.log(
    `rep ${i + 1}/${REPS}: ttfi=${r.ttfi_ms.toFixed(0)}ms tree=${r.tree_ms.toFixed(0)}ms total=${r.total_ms.toFixed(0)}ms items=${r.items_total} stripRebuilds=${r.strip_rebuilds} stripScanned=${r.strip_scanned} treeRebuilds=${r.tree_rebuilds}`
  );
}

const pick = (key) => median(results.map((r) => r[key]));
console.log(`METRIC ttfi_ms=${pick('ttfi_ms').toFixed(1)}`);
console.log(`METRIC tree_ms=${pick('tree_ms').toFixed(1)}`);
console.log(`METRIC total_ms=${pick('total_ms').toFixed(1)}`);
console.log(`METRIC items_total=${results[0].items_total}`);
console.log(`METRIC strip_rebuilds=${pick('strip_rebuilds').toFixed(1)}`);
console.log(`METRIC strip_scanned=${pick('strip_scanned').toFixed(1)}`);
console.log(`METRIC tree_rebuilds=${pick('tree_rebuilds').toFixed(1)}`);
console.log(`METRIC tree_scanned=${pick('tree_scanned').toFixed(1)}`);
