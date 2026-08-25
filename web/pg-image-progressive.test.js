// web/pg-image-progressive.test.js
// Contract test for Playground Image progressive batch generation and canvas rendering.
// Verifies:
// 1. As each image in a batch (count > 1) completes, it is immediately added to generation.assets and autosaved.
// 2. pgImageFlatAssets injects a virtual placeholder while generation is in progress (totalExpected > assets.length).
// 3. Active image canvas renders the real image without loading overlay when viewing completed images, and renders hamster animation when viewing the placeholder.
// 4. Navigation (prev/next) works progressively across completed images and into the active generating placeholder.
// 5. Total expected clears upon completion or cancellation, cleaning up the placeholder.

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
    console.error('  FAIL ' + name + ': ' + (err && (err.stack || err.message || err)));
  });
}

function makeEnv() {
  const calls = { fetches: [], autoSaves: [], renders: [] };
  const mockDoms = {};

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, Promise, JSON, Object, Array, String, Number, Error,
    parseInt, parseFloat, isNaN, encodeURIComponent, URLSearchParams,
    AbortController, Uint8Array,
    document: {
      getElementById: function (id) {
        if (!mockDoms[id]) {
          mockDoms[id] = { innerHTML: '', textContent: '', style: {}, title: '' };
        }
        return mockDoms[id];
      }
    },
    fetch: function (url, opts) {
      calls.fetches.push({ url: String(url), opts: opts || null });
      const idx = calls.fetches.length;
      return Promise.resolve({
        ok: true,
        json: function () {
          return Promise.resolve({
            data: [{ url: 'http://img/asset-' + idx + '.png', width: 1024, height: 1024, mime: 'image/png' }],
            provider: 'modelscope',
            key: 'k-' + idx,
          });
        }
      });
    },
    pgT: function (key) { return key; },
    pgToast: function () {},
    pgEscapeHtml: function (str) { return String(str || ''); },
    pgEscapeAttr: function (str) { return String(str || ''); },
    pgWinAt: function (i) { return sandbox.pgState.windows[i]; },
    pgWin: function () { return sandbox.pgState.windows[sandbox.pgState.activeWin]; },
    pgEffectiveProtocol: function (cfg) { return cfg.imgProtocolFilter || 'gpt'; },
    pgGetImgProtocol: function (modelId) {
      const m = modelId || '';
      if (m.indexOf('ms-') === 0) return 'modelscope';
      return 'gpt';
    },
    pgImageRenderCanvas: null,
    pgSave: function () {},
    pgAutoSaveImageArtifact: function (url, asset) { calls.autoSaves.push({ url: url, id: asset.id }); },
    pgGetImageSubmitCount: function () {
      const w = sandbox.pgWin();
      return (w && w.config && w.config.imgSubmitCount) || 1;
    },
    calls: calls,
    mockDoms: mockDoms,
  };
  sandbox.pgState = { windows: [], activeWin: 0, mode: 'image' };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

function loadModules(env) {
  const dir = path.join(__dirname, 'playground', 'static-pg', 'playground');
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(dir, 'pg-image-model.js'), 'utf8'), env, { filename: 'pg-image-model.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'pg-image-tasks.js'), 'utf8'), env, { filename: 'pg-image-tasks.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'pg-render.js'), 'utf8'), env, { filename: 'pg-render.js' });
  return env;
}

function makeWindow(extra) {
  const base = {
    model: 'ms-test',
    imgProtocolFilter: 'modelscope',
    imgN: 1,
    imgSubmitCount: 4,
    imgSeed: 100,
    imgSize: '1024x1024',
    imgSteps: 20,
    imgGuidance: 7,
    imgEndpoint: 'generations',
  };
  return { config: Object.assign(base, extra || {}), messages: [], image: null };
}

async function waitTasksDone(env) {
  while (env.pgTasksSnapshot && env.pgTasksSnapshot().tasks.some(t => t.status === 'queued' || t.status === 'running')) {
    await new Promise(r => setTimeout(r, 5));
  }
}

async function main() {
  console.log('=== Playground Progressive Image Batch Tests ===');

  await check('progressive batch loads images one by one and creates placeholder for active run', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow({ imgSubmitCount: 3 }));
    const w = env.pgState.windows[0];

    // Record snapshots on pgImageRenderCanvas calls
    const snapshots = [];
    env.pgImageRenderCanvas = function () {
      const st = env.pgImageState(w);
      const flat = env.pgImageFlatAssets(st);
      snapshots.push({
        phase: st.phase,
        assetsLen: st.generations[0] ? st.generations[0].assets.length : 0,
        flatLen: flat.length,
        hasPlaceholder: flat.some(e => e.isPlaceholder),
        activeAssetIndex: st.activeAssetIndex,
      });
    };

    const p = env.pgTaskEnqueue(0, 'a beautiful landscape', null);
    const gen = await p;
    await waitTasksDone(env);

    assert.strictEqual(gen.assets.length, 3, 'all 3 assets collected at end');
    assert.strictEqual(gen.status, 'ready');
    assert.strictEqual(gen.totalExpected, 0, 'totalExpected cleared at end');

    // 1st render: initial generating state (0 assets, 1 placeholder)
    assert.strictEqual(snapshots[0].assetsLen, 0);
    assert.strictEqual(snapshots[0].flatLen, 1);
    assert.strictEqual(snapshots[0].hasPlaceholder, true);

    // 2nd render: 1st image done (1 asset, 1 placeholder -> flatLen 2)
    assert.strictEqual(snapshots[1].assetsLen, 1);
    assert.strictEqual(snapshots[1].flatLen, 2);
    assert.strictEqual(snapshots[1].hasPlaceholder, true);
    assert.strictEqual(snapshots[1].activeAssetIndex, 0);

    // 3rd render: 2nd image done (2 assets, 1 placeholder -> flatLen 3)
    assert.strictEqual(snapshots[2].assetsLen, 2);
    assert.strictEqual(snapshots[2].flatLen, 3);
    assert.strictEqual(snapshots[2].hasPlaceholder, true);

    // 4th render: 3rd image done (3 assets, 1 placeholder -> flatLen 4)
    assert.strictEqual(snapshots[3].assetsLen, 3);

    // 5th render: all done, ready state (3 assets, 0 placeholder -> flatLen 3)
    const lastSnap = snapshots[snapshots.length - 1];
    assert.strictEqual(lastSnap.phase, 'ready');
    assert.strictEqual(lastSnap.assetsLen, 3);
    assert.strictEqual(lastSnap.flatLen, 3);
    assert.strictEqual(lastSnap.hasPlaceholder, false);

    const finalSt = env.pgImageState(w);
    const finalFlat = env.pgImageFlatAssets(finalSt);
    assert.strictEqual(finalFlat.length, 3, 'flat has exactly 3 items when done');
    assert.strictEqual(finalFlat.some(e => e.isPlaceholder), false, 'no placeholder when done');
  });

  await check('canvas rendering displays real image without loading overlay and placeholder with hamster', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow({ imgSubmitCount: 2 }));
    const w = env.pgState.windows[0];

    const st = env.pgImageState(w);
    const gen = {
      id: 'gen-test',
      status: 'generating',
      prompt: 'a futuristic city',
      createdAt: Date.now(),
      model: 'ms-test',
      protocol: 'modelscope',
      params: {},
      totalExpected: 2,
      assets: [{ id: 'a1', url: 'http://img/city1.png', width: 1024, height: 1024, mime: 'image/png' }],
    };
    st.phase = 'generating';
    st.generations = [gen];
    st.activeAssetIndex = 0;

    env.pgImageRenderCanvas(0);
    const box = env.mockDoms['pg-messages-0'];
    assert.ok(box.innerHTML.indexOf('http://img/city1.png') >= 0, 'image url rendered');
    assert.ok(box.innerHTML.indexOf('pg-image-loading-overlay') === -1, 'completed image must not be obscured by loading overlay');
    assert.ok(box.innerHTML.indexOf('pg-image-nav-next') >= 0, 'next button is rendered');

    st.activeAssetIndex = 1;
    env.pgImageRenderCanvas(0);
    const box2 = env.mockDoms['pg-messages-0'];
    assert.ok(box2.innerHTML.indexOf('wheel-and-hamster') >= 0, 'hamster animation rendered for placeholder');
    assert.ok(box2.innerHTML.indexOf('pgGenerating') >= 0, 'generating text displayed');
    assert.ok(box2.innerHTML.indexOf('disabled') >= 0, 'next button disabled on placeholder');
    const nav = env.mockDoms['pg-pane-img-nav-0'];
    assert.strictEqual(nav.textContent, '2 / 2', 'nav displays 2 / 2 on placeholder');
  });

  console.log(failures === 0 ? '\npg-image-progressive.test.js: all checks passed' : '\npg-image-progressive.test.js: ' + failures + ' check(s) failed');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('pg-image-progressive.test.js crashed:', err);
  process.exit(1);
});
