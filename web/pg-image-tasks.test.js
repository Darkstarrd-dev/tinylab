// web/pg-image-tasks.test.js
// Contract & behavioral tests for Playground Image Task Queue and Concurrency Dispatcher:
// 1. Task enqueue adds task to queue, sets generation, and pumps units.
// 2. Concurrency limit controls max in-flight requests per provider (concurrency=1 vs concurrency=2).
// 3. Different providers run concurrently without blocking each other.
// 4. Task cancellation stops remaining units and updates status to 'canceled'.
// 5. Task selection toggles activeTaskId and provides scoped view for canvas.

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
  const calls = { fetches: [], autoSaves: [] };
  const mockDoms = {};

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, Promise, JSON, Object, Array, String, Number, Error,
    parseInt, parseFloat, isNaN, encodeURIComponent, URLSearchParams,
    AbortController, Uint8Array,
    document: {
      documentElement: { getAttribute: function () { return 'en'; } },
      getElementById: function (id) {
        if (!mockDoms[id]) {
          mockDoms[id] = { innerHTML: '', textContent: '', style: {}, title: '', classList: { toggle: () => {} } };
        }
        return mockDoms[id];
      }
    },
    fetch: function (url, opts) {
      const idx = calls.fetches.length + 1;
      const record = { id: idx, url: String(url), opts: opts || null, startedAt: Date.now(), endedAt: 0 };
      calls.fetches.push(record);
      const delay = sandbox.fetchDelayMs || 5;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          record.endedAt = Date.now();
          resolve({
            ok: true,
            json: function () {
              return Promise.resolve({
                data: [{ url: 'http://img/' + idx + '.png', width: 1024, height: 1024, mime: 'image/png' }],
                provider: sandbox.mockProvider || 'test-provider',
                key: 'k-' + idx,
              });
            }
          });
        }, delay);
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
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
    pgImageRenderCanvas: function () {},
    pgSave: function () {},
    pgAutoSaveImageArtifact: function (url, asset) { calls.autoSaves.push({ url: url, id: asset.id }); },
    pgGetImageSubmitCount: function () {
      const w = sandbox.pgWin();
      return (w && w.config && w.config.imgSubmitCount) || 1;
    },
    calls: calls,
    mockDoms: mockDoms,
    fetchDelayMs: 5,
  };
  sandbox.pgState = { windows: [], activeWin: 0, mode: 'image' };
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  const dir = path.join(__dirname, 'playground', 'static-pg', 'playground');
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, 'pg-core.js'), 'utf8'), sandbox, { filename: 'pg-core.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'pg-i18n.js'), 'utf8'), sandbox, { filename: 'pg-i18n.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'pg-image-model.js'), 'utf8'), sandbox, { filename: 'pg-image-model.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'pg-image-tasks.js'), 'utf8'), sandbox, { filename: 'pg-image-tasks.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'pg-render.js'), 'utf8'), sandbox, { filename: 'pg-render.js' });

  return sandbox;
}

function makeWin(extra) {
  const base = {
    model: 'openai/gpt-4o',
    imgProtocolFilter: 'gpt',
    imgN: 1,
    imgSubmitCount: 1,
    imgConcurrency: 1,
    imgSeed: 0,
    imgSize: '1024x1024',
    imgEndpoint: 'generations',
  };
  return { config: Object.assign(base, extra || {}), messages: [], image: null };
}

async function waitTasksDone(env) {
  while (env.pgTasksSnapshot().tasks.some(t => t.status === 'queued' || t.status === 'running')) {
    await new Promise(r => setTimeout(r, 5));
  }
}

async function main() {
  console.log('=== Playground Image Task Queue Tests ===');

  await check('task enqueue adds task to queue and completes', async () => {
    const env = makeEnv();
    env.pgState.windows.push(makeWin({ imgSubmitCount: 2 }));
    const gen = await env.pgTaskEnqueue(0, 'sunset over mountains', null);
    const snap1 = env.pgTasksSnapshot();
    assert.strictEqual(snap1.tasks.length, 1);
    assert.strictEqual(snap1.activeTaskId, snap1.tasks[0].id);

    await waitTasksDone(env);
    const snap2 = env.pgTasksSnapshot();
    const task = snap2.tasks[0];
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(gen.status, 'ready');
    assert.strictEqual(gen.assets.length, 1); // gpt single request with n=2
  });

  await check('concurrency=1 serializes units of multi-image batch', async () => {
    const env = makeEnv();
    env.fetchDelayMs = 20;
    env.pgState.windows.push(makeWin({ model: 'ms-model', imgProtocolFilter: 'modelscope', imgSubmitCount: 3, imgConcurrency: 1 }));

    env.pgTaskEnqueue(0, 'cute dogs', null);
    await waitTasksDone(env);

    assert.strictEqual(env.calls.fetches.length, 3);
    for (let i = 0; i < 2; i++) {
      const f1 = env.calls.fetches[i];
      const f2 = env.calls.fetches[i + 1];
      assert.ok(f2.startedAt >= f1.endedAt - 2, `fetch ${i+2} should start after fetch ${i+1} finishes (serial)`);
    }
  });

  await check('concurrency=2 runs units concurrently within same provider', async () => {
    const env = makeEnv();
    env.fetchDelayMs = 40;
    env.pgState.windows.push(makeWin({ model: 'ms-model', imgProtocolFilter: 'modelscope', imgSubmitCount: 4, imgConcurrency: 2 }));

    env.pgTaskEnqueue(0, 'forest trees', null);
    await waitTasksDone(env);

    assert.strictEqual(env.calls.fetches.length, 4);
    // fetch 1 and fetch 2 should start almost at the same time (before fetch 1 ends)
    const f1 = env.calls.fetches[0];
    const f2 = env.calls.fetches[1];
    assert.ok(f2.startedAt < f1.endedAt, 'fetch 2 should overlap with fetch 1 when concurrency=2');
  });

  await check('different providers run concurrently without blocking each other', async () => {
    const env = makeEnv();
    env.fetchDelayMs = 40;
    env.pgState.windows.push(makeWin({ model: 'ms-providerA/model-1', imgProtocolFilter: 'modelscope', imgSubmitCount: 2, imgConcurrency: 1 }));
    env.pgState.windows.push(makeWin({ model: 'ms-providerB/model-2', imgProtocolFilter: 'modelscope', imgSubmitCount: 2, imgConcurrency: 1 }));

    env.pgTaskEnqueue(0, 'prompt A', null);
    env.pgTaskEnqueue(1, 'prompt B', null);
    await waitTasksDone(env);

    assert.strictEqual(env.calls.fetches.length, 4);
    const fA1 = env.calls.fetches.find(f => JSON.parse(f.opts.body).model === 'ms-providerA/model-1');
    const fB1 = env.calls.fetches.find(f => JSON.parse(f.opts.body).model === 'ms-providerB/model-2');
    assert.ok(fA1 && fB1);
    assert.ok(fB1.startedAt < fA1.endedAt, 'provider B task should run concurrently with provider A task');
  });

  await check('task cancellation stops subsequent units and marks canceled', async () => {
    const env = makeEnv();
    env.fetchDelayMs = 40;
    env.pgState.windows.push(makeWin({ model: 'ms-model', imgProtocolFilter: 'modelscope', imgSubmitCount: 4, imgConcurrency: 1 }));

    const gen = await env.pgTaskEnqueue(0, 'flying birds', null);
    const task = env.pgTasksSnapshot().tasks[0];
    // Wait for first fetch to complete
    await new Promise(r => setTimeout(r, 50));
    env.pgTaskCancel(task.id);
    await waitTasksDone(env);

    assert.strictEqual(task.status, 'canceled');
    assert.strictEqual(gen.status, 'canceled');
    assert.ok(env.calls.fetches.length < 4, 'should not dispatch all 4 units after cancellation');
  });

  await check('task selection toggles activeTaskId and provides scoped view for canvas', async () => {
    const env = makeEnv();
    env.pgState.windows.push(makeWin({ imgSubmitCount: 1 }));
    await env.pgTaskEnqueue(0, 'view test prompt', null);
    await waitTasksDone(env);

    const task = env.pgTasksSnapshot().tasks[0];
    assert.strictEqual(env.pgTasksSnapshot().activeTaskId, task.id);

    const view = env.pgTaskSelectedView();
    assert.ok(view, 'scoped view should be returned');
    assert.strictEqual(view.submittedPrompt, 'view test prompt');
    assert.strictEqual(view.generations.length, 1);
    assert.strictEqual(view.phase, 'ready');

    // Click again to unselect
    env.pgTaskSelect(task.id);
    assert.strictEqual(env.pgTasksSnapshot().activeTaskId, null);
    assert.strictEqual(env.pgTaskSelectedView(), null);
  });

  console.log(`\nSummary: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
