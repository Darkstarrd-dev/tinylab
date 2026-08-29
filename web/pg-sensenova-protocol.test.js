// web/pg-sensenova-protocol.test.js
// Unit & contract test for SenseNova Image protocol integration:
// 1. pgImageProtocols includes 'sensenova'
// 2. pgBuildImageBody formats size, output_format, response_format, watermark, prompt_extend
// 3. pgBuildImageBody formats reference images as images: [{image_url: "..."}] for sensenova
// 4. pgTaskEnqueue schedules requests for count > 1 under sensenova
//
// Run: node web/pg-sensenova-protocol.test.js

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
  const calls = { fetches: [], autoSaves: [], renders: 0 };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, Promise, JSON, Object, Array, String, Number, Error,
    parseInt, parseFloat, isNaN, encodeURIComponent, URLSearchParams,
    AbortController, Uint8Array,
    document: { documentElement: { lang: 'en', getAttribute: function(attr) { return 'en'; } } },
    fetch: function (url, opts) {
      calls.fetches.push({ url: String(url), opts: opts || null });
      const idx = calls.fetches.length;
      return Promise.resolve({
        ok: true,
        json: function () {
          return Promise.resolve({
            data: [{ url: 'https://cdn.sensenova.dev/gen/' + idx + '.png' }],
            provider: 'sensenova'
          });
        }
      });
    },
    pgT: function (key) { return key; },
    pgToast: function () {},
    pgWinAt: function (i) { return sandbox.pgState.windows[i]; },
    pgWin: function () { return sandbox.pgState.windows[sandbox.pgState.activeWin]; },
    pgEffectiveProtocol: function (cfg) {
      return (cfg.imgProtocolFilter && cfg.imgProtocolFilter !== 'all') ? cfg.imgProtocolFilter : null;
    },
    pgGetImgProtocol: function (modelId) {
      const m = modelId || '';
      if (m.indexOf('sensenova') !== -1 || m.indexOf('u1') !== -1) return 'sensenova';
      if (m.indexOf('ms-') === 0) return 'modelscope';
      if (m.indexOf('xai-') === 0) return 'xai';
      return 'gpt';
    },
    pgAutoSaveImageArtifact: function (url, asset, genId, assetId) {
      calls.autoSaves.push({ url, asset, genId, assetId });
    },
    pgImageRenderCanvas: function () { calls.renders++; },
    pgSave: function () {},
    pgGetImageSubmitCount: function () {
      const w = sandbox.pgWin();
      return (w && w.config && w.config.imgSubmitCount) || 1;
    },
    pgState: {
      activeWin: 0,
      mode: 'image',
      models: [
        { id: 'sensenova-u1.5-lite', kind: 'image', imgProtocol: 'sensenova' },
        { id: 'sensenova-u1-fast', kind: 'image', imgProtocol: 'sensenova' }
      ],
      windows: [
        {
          id: 'w0',
          messages: [],
          lastProvider: '',
          config: {
            model: 'sensenova-u1.5-lite',
            imgProtocolFilter: 'sensenova',
            imgSubmitCount: 1,
            imgSize: '2048x2048',
            imgOutputFormat: 'png',
            imgResponseFormat: 'b64_json',
            snWatermark: 'false',
            snPromptExtend: 'false',
            imageEnabled: false,
            imageUrls: []
          }
        }
      ]
    },
    window: null
  };
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);

  // Load pg-core.js, pg-i18n.js, pg-ui.js (+ params/reqleft/events), pg-modal.js, pg-request.js, pg-image-model.js, pg-image-tasks.js
  const dir = path.join(__dirname, 'playground', 'static-pg', 'playground');
  const files = ['pg-core.js', 'pg-i18n.js', 'pg-ui.js', 'pg-ui-params.js', 'pg-ui-reqleft.js', 'pg-ui-events.js', 'pg-modal.js', 'pg-request.js', 'pg-image-model.js', 'pg-image-tasks.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }

  return { sandbox, calls };
}

async function waitTasksDone(sandbox) {
  while (sandbox.pgTasksSnapshot && sandbox.pgTasksSnapshot().tasks.some(t => t.status === 'queued' || t.status === 'running')) {
    await new Promise(r => setTimeout(r, 5));
  }
}

async function run() {
  console.log('=== SenseNova Protocol Tests ===');

  await check('pgImageProtocols includes sensenova', () => {
    const { sandbox } = makeEnv();
    const protos = sandbox.pgImageProtocols();
    assert(protos.includes('sensenova'), 'expected sensenova in pgImageProtocols');
  });

  await check('pgBuildImageBody constructs correct SenseNova body with parameters', () => {
    const { sandbox } = makeEnv();
    const w = sandbox.pgWin();
    w.messages = [{ role: 'user', content: 'Draw a cute cat' }];
    w.config.imgSize = '2720x1536';
    w.config.imgOutputFormat = 'webp';
    w.config.imgResponseFormat = 'url';
    w.config.snWatermark = 'false';
    w.config.snPromptExtend = 'false';

    const body = sandbox.pgBuildImageBody(0);
    assert.strictEqual(body.model, 'sensenova-u1.5-lite');
    assert.strictEqual(body.prompt, 'Draw a cute cat');
    assert.strictEqual(body.size, '2720x1536');
    assert.strictEqual(body.output_format, 'webp');
    assert.strictEqual(body.response_format, 'url');
    assert.strictEqual(body.watermark, false);
    assert.strictEqual(body.prompt_extend, false);
    assert.strictEqual(body.images, undefined);
  });

  await check('pgBuildImageBody formats reference images into images: [{image_url}] array', () => {
    const { sandbox } = makeEnv();
    const w = sandbox.pgWin();
    w.messages = [{ role: 'user', content: 'Transform cat' }];
    w.config.imageEnabled = true;
    w.config.imageUrls = ['https://example.com/ref1.png', 'data:image/png;base64,abc'];

    const body = sandbox.pgBuildImageBody(0);
    assert.strictEqual(body.image_url, undefined, 'body.image_url should not be set for sensenova');
    assert(Array.isArray(body.images), 'body.images should be an array');
    assert.strictEqual(body.images.length, 2);
    assert.strictEqual(body.images[0].image_url, 'https://example.com/ref1.png');
    assert.strictEqual(body.images[1].image_url, 'data:image/png;base64,abc');
  });

  await check('pgTaskEnqueue sends single request when count is 1', async () => {
    const { sandbox, calls } = makeEnv();
    const gen = await sandbox.pgTaskEnqueue(0, 'Single image test');
    await waitTasksDone(sandbox);
    assert.strictEqual(gen.status, 'ready');
    assert.strictEqual(gen.assets.length, 1);
    assert.strictEqual(calls.fetches.length, 1);
    assert.strictEqual(calls.fetches[0].url, '/v1/images/generations');
    const sentBody = JSON.parse(calls.fetches[0].opts.body);
    assert.strictEqual(sentBody.prompt, 'Single image test');
    assert.strictEqual(sentBody.n, undefined, 'SenseNova should not send n in body');
  });

  await check('pgTaskEnqueue sends sequential requests when count > 1', async () => {
    const { sandbox, calls } = makeEnv();
    const w = sandbox.pgWin();
    w.config.imgSubmitCount = 3;

    const gen = await sandbox.pgTaskEnqueue(0, 'Multi-image test');
    await waitTasksDone(sandbox);
    assert.strictEqual(gen.status, 'ready');
    assert.strictEqual(gen.assets.length, 3);
    assert.strictEqual(calls.fetches.length, 3, 'expected 3 sequential fetches');
    for (let i = 0; i < 3; i++) {
      const sentBody = JSON.parse(calls.fetches[i].opts.body);
      assert.strictEqual(sentBody.prompt, 'Multi-image test');
      assert.strictEqual(sentBody.n, undefined);
    }
  });

  await check('SenseNova i18n keys are present in both EN and CN', () => {
    const { sandbox } = makeEnv();
    const i18n = sandbox.PG_I18N;
    const requiredKeys = [
      'pgSnWatermark', 'pgSnWatermarkOn', 'pgSnWatermarkOff',
      'pgSnPromptExtend', 'pgSnPromptExtendOn', 'pgSnPromptExtendOff'
    ];
    for (const k of requiredKeys) {
      assert(i18n.en && i18n.en[k], 'missing EN i18n key: ' + k);
      assert(i18n.cn && i18n.cn[k], 'missing CN i18n key: ' + k);
    }
  });

  await check('SenseNova models have distinct size lists for U1.5 Lite and U1 Fast', () => {
    const { sandbox } = makeEnv();
    const liteSizes = sandbox.pgImgBuiltinSizesFor('sensenova', 'sensenova-u1.5-lite');
    const fastSizes = sandbox.pgImgBuiltinSizesFor('sensenova', 'sensenova-u1-fast');

    // U1.5 Lite includes auto and 2K/4K resolutions
    assert(liteSizes.includes('auto'), 'U1.5 Lite should include auto');
    assert(liteSizes.includes('4096x4096'), 'U1.5 Lite should include 4096x4096');
    assert(!liteSizes.includes('2752x1536'), 'U1.5 Lite should not include 2752x1536');

    // U1 Fast has exactly 11 fixed 2K aspect ratio sizes, no auto, no 4096x4096
    assert(!fastSizes.includes('auto'), 'U1 Fast should not include auto');
    assert(!fastSizes.includes('4096x4096'), 'U1 Fast should not include 4096x4096');
    assert(fastSizes.includes('2752x1536'), 'U1 Fast should include 2752x1536');
    assert.strictEqual(fastSizes.length, 11, 'U1 Fast should have 11 fixed sizes');
  });

  await check('pgImageNormalizeResult correctly detects WebP from b64_json', () => {
    const { sandbox } = makeEnv();
    // Simulate WebP base64 output (RIFF... header encoded)
    const b64WebP = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsSScQAA3AAAA+v1/70wAAA=';
    const normWebP = sandbox.pgImageNormalizeResult({
      data: [{ b64_json: b64WebP }]
    }, 'sensenova');
    assert.strictEqual(normWebP.assets.length, 1);
    assert.ok(normWebP.assets[0].url.indexOf('data:image/webp;base64,') === 0, 'url should have data:image/webp prefix');
    assert.strictEqual(normWebP.assets[0].mime, 'image/webp');

    // Simulate PNG base64 output (iVBOR... header)
    const b64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const normPng = sandbox.pgImageNormalizeResult({
      data: [{ b64_json: b64Png }]
    }, 'sensenova');
    assert.strictEqual(normPng.assets.length, 1);
    assert.ok(normPng.assets[0].url.indexOf('data:image/png;base64,') === 0, 'url should have data:image/png prefix');
    assert.strictEqual(normPng.assets[0].mime, 'image/png');
  });

  await check('pgTaskEnqueue auto-routes to edits when reference images exist, generations when absent', async () => {
    const { sandbox, calls } = makeEnv();
    const w = sandbox.pgWin();

    // 1. Without images -> generations
    w.config.imageEnabled = false;
    w.config.imageUrls = [];
    calls.fetches = [];
    await sandbox.pgTaskEnqueue(0, 'Gen prompt');
    await waitTasksDone(sandbox);
    assert.strictEqual(calls.fetches[0].url, '/v1/images/generations');

    // 2. With images -> edits
    w.config.imageEnabled = true;
    w.config.imageUrls = ['https://example.com/source.png'];
    calls.fetches = [];
    await sandbox.pgTaskEnqueue(0, 'Edit prompt');
    await waitTasksDone(sandbox);
    assert.strictEqual(calls.fetches[0].url, '/v1/images/edits');
  });

  await check('pgRenderImageBlock does not contain redundant Endpoint dropdown', () => {
    const { sandbox } = makeEnv();
    const html = sandbox.pgRenderImageBlock(false);
    assert(!html.includes('pg-img-endpoint-sel'), 'UI should not contain pg-img-endpoint-sel dropdown');
    assert(!html.includes('pgImgEndpoint'), 'UI should not contain Endpoint label');
  });

  console.log(`\nSummary: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  if (failures > 0) process.exit(1);
}

run();
