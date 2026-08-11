// web/pg-image-count.test.js
// Zero-dependency Node contract test for the Manual Image sidebar Count
// (imgSubmitCount via pgGetImageSubmitCount, default 1) multi-image behavior
// in the Canvas submit path (requirement 3): one ordinary Image prompt
// submission with count N > 1 generates N images from the same prompt with
// different seeds. GPT/xAI override the body `n` to the count in one request
// (split sequentially at the provider n cap — GPT 5 / xAI 10; provider
// assigns seeds); ModelScope and ComfyUI (no `n` support) run N sequential
// requests with per-image seed overrides; count=1 preserves the pre-existing
// single-request behavior byte-for-byte. The count is never part of the API
// body and is unrelated to Batch Project planning quantity (default stays 4)
// — no Batch code is touched here.
//
// Loads the real pg-comfyui.js + pg-image-model.js in a sandboxed VM with
// stubbed browser/network globals (media-bridge.test.js convention) and
// drives window.pgImageGenerate end to end.
//
// Run:  node web/pg-image-count.test.js

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

function hangUntilAbort(opts) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
    const sig = opts && opts.signal;
    if (!sig) return;
    if (sig.aborted) { onAbort(); return; }
    sig.addEventListener('abort', onAbort);
  });
}

// Build a sandboxed browser-like environment hosting the real playground
// modules. env.hangFetchAt / env.hangWaitAt / env.failFetchAt select which
// remote request (1-based) hangs until abort / fails with an error.
function makeEnv() {
  const calls = { fetches: [], comfyPosts: [], comfyViews: [], waitHistory: [], autoSaves: [], renders: 0 };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, Promise, JSON, Object, Array, String, Number, Error,
    parseInt, parseFloat, isNaN, encodeURIComponent, URLSearchParams,
    AbortController, Uint8Array,
    fetch: function (url, opts) {
      calls.fetches.push({ url: String(url), opts: opts || null });
      const u = String(url);
      const idx = calls.fetches.length;
      if (u.indexOf('/api/comfyui/proxy') === 0) {
        const req = JSON.parse((opts && opts.body) || '{}');
        if (req.method === 'POST' && req.path === '/prompt') {
          calls.comfyPosts.push(req.body);
          return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ prompt_id: 'p' + calls.comfyPosts.length }); } });
        }
        if (req.method === 'GET' && req.path === '/view') {
          calls.comfyViews.push(req.query);
          return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(new Uint8Array([137, 80, 78, 71])); } });
        }
        return Promise.resolve({ ok: false, status: 404 });
      }
      // /v1/images/* remote generation (GPT/xAI/ModelScope)
      if (sandbox.hangFetchAt === idx) return hangUntilAbort(opts);
      if (sandbox.failFetchAt === idx) {
        return Promise.resolve({ ok: false, status: 400, json: function () { return Promise.resolve({ error: { message: 'boom' } }); } });
      }
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ data: [{ url: 'http://img/' + idx + '.png' }], provider: 'modelscope', key: 'k' }); }
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
      if (m.indexOf('ms-') === 0) return 'modelscope';
      if (m.indexOf('xai-') === 0) return 'xai';
      return 'gpt';
    },
    pgBuildImageBody: function () {
      const w = sandbox.pgWin();
      const cfg = w.config;
      const prompt = (w.messages[0] && w.messages[0].content) || '';
      const proto = sandbox.pgGetImgProtocol(cfg.model);
      const body = { model: cfg.model, prompt: prompt };
      if (proto === 'modelscope') {
        if (cfg.imgSize) body.size = cfg.imgSize;
        if (cfg.imgSteps > 0) body.steps = cfg.imgSteps;
        if (cfg.imgGuidance > 0) body.guidance = cfg.imgGuidance;
        if (cfg.imgSeed > 0) body.seed = cfg.imgSeed;
      } else if (proto === 'gpt') {
        if (cfg.imgSize) body.size = cfg.imgSize;
        if ((cfg.imgN || 1) !== 1) body.n = Math.min(5, Math.max(1, cfg.imgN || 1));
      }
      return body;
    },
    pgImageRenderCanvas: function () { calls.renders++; },
    pgSave: function () {},
    pgAutoSaveImageArtifact: function (url, asset) { calls.autoSaves.push({ url: url, id: asset.id }); },
    pgGetImageSubmitCount: function () {
      const w = sandbox.pgWin();
      const raw = (w && w.config && w.config.imgSubmitCount != null) ? w.config.imgSubmitCount : 1;
      const n = parseInt(raw, 10);
      if (!isFinite(n) || n < 1) return 1;
      return Math.min(99, n);
    },
  };
  sandbox.pgState = { windows: [], activeWin: 0 };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.pgState.windows = [];
  sandbox.pgState.activeWin = 0;
  sandbox.hangFetchAt = 0;
  sandbox.failFetchAt = 0;
  sandbox.hangWaitAt = 0;
  sandbox.calls = calls;
  return sandbox;
}

function loadModules(env) {
  const dir = path.join(__dirname, 'playground', 'static-pg', 'playground');
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(dir, 'pg-comfyui.js'), 'utf8'), env, { filename: 'pg-comfyui.js' });
  // Keep the real pgComfyWorkflowForPrompt (seed injection under test); the
  // real network-facing helpers are replaced with deterministic stubs.
  env.pgComfyWaitHistory = function (cfg, pid, timeoutMs, signal) {
    env.calls.waitHistory.push(pid);
    const idx = env.calls.waitHistory.length;
    if (env.hangWaitAt === idx) return hangUntilAbort({ signal: signal });
    const h = {};
    h[pid] = { outputs: { '3': { images: [{ filename: 'f' + idx + '.png', subfolder: '', type: 'output' }] } } };
    return Promise.resolve(h);
  };
  env.pgComfyBufToDataUrl = function () { return 'data:image/png;base64,AAAA'; };
  vm.runInContext(fs.readFileSync(path.join(dir, 'pg-image-model.js'), 'utf8'), env, { filename: 'pg-image-model.js' });
  return env;
}

function makeWindow(protocol, extra) {
  const base = {
    model: '',
    imgProtocolFilter: protocol,
    imgN: 1,
    imgSubmitCount: 1,
    imgSeed: 0,
    imgSize: '',
    imgSteps: 0,
    imgGuidance: 0,
    imgEndpoint: 'generations',
    imageEnabled: false,
    imageUrls: null,
    imgComfyPort: '8188',
    imgComfyWorkflow: null,
  };
  return { config: Object.assign(base, extra || {}), messages: [], image: null };
}

function bodyOf(fetchCall) { return JSON.parse(fetchCall.opts.body); }

async function main() {
  // 1. ModelScope count=1 preserves the single request: no seed, no n,
  //    and no imgSubmitCount key in the API body.
  await check('modelscope count=1 keeps single request without seed/n/count', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('modelscope', { model: 'ms-x', imgSteps: 20 }));
    const gen = await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.fetches.length, 1, 'exactly one request');
    const b = bodyOf(env.calls.fetches[0]);
    assert.strictEqual(b.prompt, 'a cat');
    assert.strictEqual(b.seed, undefined, 'no seed injected at count=1');
    assert.strictEqual(b.n, undefined, 'no n at count=1');
    assert.strictEqual(b.imgSubmitCount, undefined, 'count never part of the API body');
    assert.strictEqual(b.steps, 20, 'other params preserved');
    assert.strictEqual(gen.assets.length, 1);
    assert.strictEqual(env.calls.autoSaves.length, 1, 'asset autosaved');
    assert.strictEqual(gen.params.imgSubmitCount, 1, 'count recorded on the generation');
  });

  // 2. ModelScope count=1 with user seed keeps the existing single seed.
  await check('modelscope count=1 with imgSeed keeps single seed', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('modelscope', { model: 'ms-x', imgSeed: 42 }));
    const gen = await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.fetches.length, 1);
    assert.strictEqual(bodyOf(env.calls.fetches[0]).seed, 42);
    assert.strictEqual(gen.assets.length, 1);
  });

  // 3. GPT count=1 keeps the existing imgN body `n` (count must not override).
  await check('gpt count=1 keeps existing imgN body n', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('gpt', { model: 'gpt-img', imgN: 3 }));
    const gen = await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.fetches.length, 1, 'no split at count=1');
    assert.strictEqual(bodyOf(env.calls.fetches[0]).n, 3, 'imgN n preserved');
    assert.strictEqual(gen.assets.length, 1);
  });

  // 4. ModelScope count=3 -> exactly 3 sequential requests, same prompt,
  //    seeds base, base+1, base+2 from the user seed.
  await check('modelscope count=3 sends 3 sequential requests with incremented seeds', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('modelscope', { model: 'ms-x', imgSubmitCount: 3, imgSeed: 42, imgSteps: 20 }));
    const gen = await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.fetches.length, 3, 'one request per image');
    env.calls.fetches.forEach((f, k) => {
      const b = bodyOf(f);
      assert.strictEqual(b.prompt, 'a cat', 'prompt identical across runs');
      assert.strictEqual(b.seed, 42 + k, 'seed = base + index');
      assert.strictEqual(b.steps, 20, 'other params preserved');
      assert.strictEqual(b.n, undefined, 'no n in sequential runs');
      assert.strictEqual(b.imgSubmitCount, undefined, 'count never in the body');
    });
    assert.strictEqual(gen.assets.length, 3, 'all 3 assets collected');
    assert.strictEqual(gen.status, 'ready');
    assert.strictEqual(env.calls.autoSaves.length, 3);
    assert.strictEqual(gen.params.imgSubmitCount, 3, 'count recorded on the generation');
  });

  // 5. ModelScope count=2 without a base seed draws a random base, then increments.
  await check('modelscope count=2 without base seed uses random base + increment', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('modelscope', { model: 'ms-x', imgSubmitCount: 2, imgSeed: 0 }));
    await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.fetches.length, 2);
    const s0 = bodyOf(env.calls.fetches[0]).seed;
    const s1 = bodyOf(env.calls.fetches[1]).seed;
    assert.ok(Number.isInteger(s0) && s0 > 0, 'random base seed set: ' + s0);
    assert.strictEqual(s1, s0 + 1, 'second run increments the base');
  });

  // 6. ModelScope regenerate replays the recorded count (snapshot params),
  //    strips any saved `n`, and pins per-image seeds.
  await check('modelscope regenerate replays recorded count and pins seeds', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('modelscope', { model: 'ms-x' }));
    await env.pgImageGenerate(0, 'a cat', {
      protocol: 'modelscope', model: 'ms-x', endpoint: 'generations',
      params: { imgSubmitCount: 2, imgSeed: 42, imgSteps: 20, imgN: 1 },
    });
    assert.strictEqual(env.calls.fetches.length, 2);
    env.calls.fetches.forEach((f, k) => {
      const b = bodyOf(f);
      assert.strictEqual(b.n, undefined, 'regenerated snapshot n dropped');
      assert.strictEqual(b.seed, 42 + k, 'per-image seed');
      assert.strictEqual(b.steps, 20);
    });
  });

  // 7. GPT count=3 -> single request with body n overridden to the count.
  await check('gpt count=3 overrides body n to count in one request', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('gpt', { model: 'gpt-img', imgSubmitCount: 3, imgSize: '1024x1024' }));
    const gen = await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.fetches.length, 1, 'count 3 fits the GPT cap 5');
    const b = bodyOf(env.calls.fetches[0]);
    assert.strictEqual(b.n, 3, 'body n = count');
    assert.strictEqual(b.seed, undefined, 'gpt images API has no seed field');
    assert.strictEqual(b.imgSubmitCount, undefined, 'count never in the body');
    assert.strictEqual(gen.assets.length, 1);
    assert.strictEqual(gen.params.imgSubmitCount, 3);
  });

  // 8. GPT count above the cap 5 splits into sequential requests (5,5,2).
  await check('gpt count=12 splits into sequential capped requests', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('gpt', { model: 'gpt-img', imgSubmitCount: 12 }));
    const gen = await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.fetches.length, 3, 'ceil(12/5) requests');
    assert.deepStrictEqual(env.calls.fetches.map((f) => bodyOf(f).n), [5, 5, 2], 'n per request');
    assert.strictEqual(gen.status, 'ready');
  });

  // 9. xAI count above the cap 10 splits into sequential requests (10,2).
  await check('xai count=12 splits into sequential capped requests', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('xai', { model: 'xai-img', imgSubmitCount: 12 }));
    await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.fetches.length, 2, 'ceil(12/10) requests');
    assert.deepStrictEqual(env.calls.fetches.map((f) => bodyOf(f).n), [10, 2], 'n per request');
  });

  // 10. ComfyUI count=1 leaves the workflow seed untouched and injects prompt.
  await check('comfy count=1 leaves workflow seed untouched', async () => {
    const env = loadModules(makeEnv());
    const wf = {
      '3': { class_type: 'KSampler', inputs: { seed: 111, steps: 20, cfg: 7 } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'template prompt' } },
    };
    env.pgState.windows.push(makeWindow('comfyui', { imgComfyWorkflow: wf }));
    const gen = await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.comfyPosts.length, 1);
    const run = env.calls.comfyPosts[0];
    assert.strictEqual(run.prompt['3'].inputs.seed, 111, 'template seed preserved at count=1');
    assert.strictEqual(run.prompt['4'].inputs.text, 'a cat', 'prompt injected');
    assert.strictEqual(gen.assets.length, 1);
    assert.strictEqual(gen.status, 'ready');
  });

  // 11. ComfyUI count=3 runs the workflow 3 times with per-run sampler seeds.
  await check('comfy count=3 injects per-run KSampler seeds', async () => {
    const env = loadModules(makeEnv());
    const wf = {
      '3': { class_type: 'KSamplerAdvanced', inputs: { seed: 111, noise_seed: 111, steps: 20 } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'template prompt' } },
    };
    env.pgState.windows.push(makeWindow('comfyui', { imgComfyWorkflow: wf, imgSubmitCount: 3, imgSeed: 7 }));
    const gen = await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.comfyPosts.length, 3, 'one workflow run per image');
    env.calls.comfyPosts.forEach((post, k) => {
      const s = post.prompt['3'].inputs;
      assert.strictEqual(s.seed, 7 + k, 'KSampler seed = base + index');
      assert.strictEqual(s.noise_seed, 7 + k, 'noise_seed follows seed');
      assert.strictEqual(post.prompt['4'].inputs.text, 'a cat', 'prompt identical across runs');
    });
    assert.strictEqual(gen.assets.length, 3);
    assert.strictEqual(gen.status, 'ready');
    assert.strictEqual(gen.params.imgSubmitCount, 3, 'count recorded on the generation');
  });

  // 12. ModelScope second-run failure -> error status, first asset kept.
  await check('modelscope second-run failure keeps partial asset and marks error', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('modelscope', { model: 'ms-x', imgSubmitCount: 2, imgSeed: 42 }));
    env.failFetchAt = 2;
    await assert.rejects(env.pgImageGenerate(0, 'a cat', null), /boom/);
    const st = env.pgState.windows[0].image;
    const gen = st.generations[0];
    assert.strictEqual(gen.status, 'error');
    assert.strictEqual(st.phase, 'error');
    assert.ok(st.error.indexOf('boom') >= 0, 'error surfaced: ' + st.error);
    assert.strictEqual(gen.assets.length, 1, 'completed run asset kept');
    assert.strictEqual(env.calls.autoSaves.length, 1, 'partial asset autosaved');
  });

  // 13. ComfyUI stop mid-sequence -> canceled status, completed assets kept.
  await check('comfy stop mid-sequence cancels and keeps completed assets', async () => {
    const env = loadModules(makeEnv());
    const wf = {
      '3': { class_type: 'KSampler', inputs: { seed: 111, steps: 20 } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'template prompt' } },
    };
    env.pgState.windows.push(makeWindow('comfyui', { imgComfyWorkflow: wf, imgSubmitCount: 2, imgSeed: 5 }));
    env.hangWaitAt = 2; // second workflow run hangs until abort
    const p = env.pgImageGenerate(0, 'a cat', null);
    await new Promise((r) => setTimeout(r, 10)); // let run 1 finish, run 2 hang
    env.pgImageStop(0);
    const gen = await p;
    assert.strictEqual(gen.status, 'canceled');
    assert.strictEqual(env.pgState.windows[0].image.phase, 'canceled');
    assert.strictEqual(env.calls.comfyPosts.length, 2, 'run 1 submitted before hanging on history');
    assert.strictEqual(gen.assets.length, 1, 'first run asset kept');
    assert.strictEqual(env.calls.autoSaves.length, 1);
  });

  // 14. Abort before the first run starts -> canceled with no request sent.
  await check('comfy stop before first run cancels without submitting', async () => {
    const env = loadModules(makeEnv());
    const wf = {
      '3': { class_type: 'KSampler', inputs: { seed: 111, steps: 20 } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'template prompt' } },
    };
    env.pgState.windows.push(makeWindow('comfyui', { imgComfyWorkflow: wf, imgSubmitCount: 3, imgSeed: 5 }));
    const p = env.pgImageGenerate(0, 'a cat', null);
    env.pgImageStop(0); // synchronous abort before any microtask runs
    const gen = await p;
    assert.strictEqual(gen.status, 'canceled');
    assert.strictEqual(env.calls.comfyPosts.length, 0, 'no run submitted after stop');
    assert.strictEqual(gen.assets.length, 0);
    assert.strictEqual(env.pgState.windows[0].image.phase, 'canceled');
  });

  // 15. Regenerate replays the recorded count even after the live input changes.
  await check('regenerate replays recorded count from generation params', async () => {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWindow('modelscope', { model: 'ms-x', imgSubmitCount: 2, imgSeed: 42 }));
    const gen = await env.pgImageGenerate(0, 'a cat', null);
    assert.strictEqual(env.calls.fetches.length, 2);
    assert.strictEqual(gen.params.imgSubmitCount, 2);
    // Change the live count to 1, then Regenerate: the recorded count wins.
    env.pgState.windows[0].config.imgSubmitCount = 1;
    const gen2 = await env.pgImageGenerate(0, 'a cat', gen);
    assert.strictEqual(env.calls.fetches.length, 4, 'two more requests on regenerate');
    assert.strictEqual(gen2.params.imgSubmitCount, 2, 'recorded count replayed');
    const s2 = bodyOf(env.calls.fetches[2]).seed;
    const s3 = bodyOf(env.calls.fetches[3]).seed;
    assert.strictEqual(s2, 42, 'same seed base');
    assert.strictEqual(s3, 43, 'same seed sequence');
  });

  console.log(failures === 0 ? '\npg-image-count.test.js: all checks passed' : '\npg-image-count.test.js: ' + failures + ' check(s) failed');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('pg-image-count.test.js crashed:', err);
  process.exit(1);
});
