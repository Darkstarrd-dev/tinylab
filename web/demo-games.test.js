// web/demo-games.test.js
// Zero-dependency Node behavioral test for the Demo Games plugin host
// (web/static/demo-games.js). Loads the REAL script in a VM sandbox and
// drives the exposed __dgames / TRGames seams — proving:
//   1. Registry contract: register validates id/launch, rejects duplicates.
//   2. Host adapter: saveState/loadState wire shapes, 404 -> null, URL
//      encoding, llmChat passthrough body.
//   3. Stop semantics: Phaser.Game handles destroyed via .destroy(true),
//      custom handles via .dispose(), testbed unpaused either way.
// Also guards the page wiring: script tags in both index variants, app.js
// render/cleanup calls, i18n keys (en+zh), the :has() CSS layout gate, the
// vendored Phaser bundle, and the __ademo.setPaused seam.
//
// Run:  node web/demo-games.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (err) { failures++; console.error('FAIL  ' + name + ': ' + (err && err.message)); }
}
function pcheck(name, fn) {
  return Promise.resolve().then(fn).then(
    () => console.log('  ok  ' + name),
    (err) => { failures++; console.error('FAIL  ' + name + ': ' + (err && err.message)); }
  );
}

const STATIC = path.join(__dirname, 'static');
const src = fs.readFileSync(path.join(STATIC, 'demo-games.js'), 'utf8');

console.log('demo games wiring:');

check('both index variants load demo-games.js after assistant-demo.js', () => {
  for (const f of ['index.html', 'index-nopg.html']) {
    const html = fs.readFileSync(path.join(STATIC, f), 'utf8');
    const a = html.indexOf('<script src="/assistant-demo.js"></script>');
    const g = html.indexOf('<script src="/demo-games.js"></script>');
    assert.ok(a > 0, f + ' missing assistant-demo.js tag');
    assert.ok(g > a, f + ' missing demo-games.js tag (or wrong order)');
  }
});

check('app.js renders and cleans up the games section with the demo page', () => {
  const appDemo = fs.readFileSync(path.join(STATIC, 'app-demo.js'), 'utf8');
  const appRouter = fs.readFileSync(path.join(STATIC, 'app-router.js'), 'utf8');
  assert.ok(appDemo.includes("renderAssistantDemo(container)") && appDemo.includes("renderDemoGames(container)"), 'app-demo.js missing demo games render (shell)');
  assert.ok(appRouter.includes("typeof cleanupDemoGames === 'function') cleanupDemoGames();"), 'app-router.js missing demo games cleanup');
});

check('i18n defines demoGames* keys in en and zh', () => {
  const i18n = fs.readFileSync(path.join(STATIC, 'i18n.js'), 'utf8');
  for (const k of ['demoGamesTitle', 'demoGamesLaunch', 'demoGamesStop', 'demoGamesReload', 'demoGamesLoading', 'demoGamesEmpty', 'demoGamesLoadError']) {
    const n = i18n.split(k + ':').length - 1;
    assert.ok(n >= 2, k + ' defined ' + n + ' time(s), expected en+zh');
  }
});

check('style.css gates the two-panel demo layout behind :has(.dg-root)', () => {
  const css = fs.readFileSync(path.join(STATIC, 'style-demo.css'), 'utf8');
  assert.ok(css.includes('#page-content:has(.dg-root)'), 'style-demo.css missing :has(.dg-root) layout gate');
  assert.ok(css.includes('.dg-stage-wrap'), 'style-demo.css missing .dg-stage-wrap rule');
});

check('vendored Phaser bundle + README + LICENSE exist', () => {
  for (const f of ['phaser.min.js', 'README.md', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(STATIC, 'vendor/phaser', f)), 'vendor/phaser/' + f + ' missing');
  }
  const js = fs.readFileSync(path.join(STATIC, 'vendor/phaser/phaser.min.js'), 'utf8');
  assert.ok(js.length > 1000000, 'phaser.min.js suspiciously small');
});

check('assistant-demo.js exposes the setPaused/isPaused seam', () => {
  const ad = fs.readFileSync(path.join(STATIC, 'assistant-demo.js'), 'utf8');
  assert.ok(ad.includes('setPaused: function (v) { ademoPaused = !!v; }'), 'missing setPaused seam');
  assert.ok(ad.includes('!ademoPaused'), 'ademoLoop does not honor ademoPaused');
});

// --- VM sandbox: real script, no DOM (load-time code touches only window) ---
const fetches = [];
function stubFetch(impl) {
  fetches.length = 0;
  return function (url, opts) {
    fetches.push({ url, opts });
    return impl(url, opts);
  };
}
const ctx = vm.createContext({ window: {}, console, fetch: null });
vm.runInContext(src, ctx, { filename: 'demo-games.js' });
const TR = ctx.window.TRGames;
const dg = ctx.window.__dgames;

check('__dgames exposes loadPhaser/injectScript for the game designer preview', () => {
  assert.ok(typeof dg.loadPhaser === 'function', 'loadPhaser missing from __dgames seam');
  assert.ok(typeof dg.injectScript === 'function', 'injectScript missing from __dgames seam');
});

console.log('registry contract:');

check('register accepts a valid def and stores it', () => {
  TR.register({ id: 'alpha', title: 'Alpha', launch: function () {} });
  assert.ok(dg.registry.alpha, 'alpha not registered');
});

check('register rejects duplicate id', () => {
  assert.throws(() => TR.register({ id: 'alpha', launch: function () {} }), /duplicate id/);
});

check('register rejects invalid ids and missing launch', () => {
  for (const bad of ['', '../x', 'a b', 'x'.repeat(65)]) {
    assert.throws(() => TR.register({ id: bad, launch: function () {} }), /invalid id/, 'id ' + JSON.stringify(bad));
  }
  assert.throws(() => TR.register({ id: 'nolaunch' }), /launch must be a function/);
  assert.throws(() => TR.register(null), /must be an object/);
});

console.log('host adapter:');

async function hostTests() {
  const stage = { clientWidth: 960, clientHeight: 540 };

  await pcheck('makeHost reports stage geometry and Phaser global', () => {
    ctx.window.Phaser = { fake: true };
    const host = dg.makeHost('alpha', stage);
    assert.strictEqual(host.container, stage);
    assert.strictEqual(host.width, 960);
    assert.strictEqual(host.height, 540);
    assert.strictEqual(host.phaser, ctx.window.Phaser);
  });

  await pcheck('saveState PUTs JSON to the per-game endpoint', async () => {
    ctx.fetch = stubFetch(() => Promise.resolve({ ok: true }));
    const host = dg.makeHost('alpha', stage);
    await host.saveState({ best: 7 });
    assert.strictEqual(fetches.length, 1);
    assert.strictEqual(fetches[0].url, '/api/games/alpha/state');
    assert.strictEqual(fetches[0].opts.method, 'PUT');
    assert.strictEqual(fetches[0].opts.body, '{"best":7}');
  });

  await pcheck('loadState maps 404 to null and 200 to parsed JSON', async () => {
    const host = dg.makeHost('alpha', stage);
    ctx.fetch = stubFetch(() => Promise.resolve({ ok: false, status: 404 }));
    assert.strictEqual(await host.loadState(), null);
    ctx.fetch = stubFetch(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ best: 3 }) }));
    assert.deepStrictEqual(await host.loadState(), { best: 3 });
    assert.strictEqual(fetches[0].url, '/api/games/alpha/state');
  });

  await pcheck('sheetImageUrl and llmChat wire shapes', async () => {
    const host = dg.makeHost('alpha', stage);
    assert.strictEqual(host.sheetImageUrl('walk left'), '/api/assistant/sheet-image/walk%20left');
    ctx.fetch = stubFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [] }) }));
    const out = await host.llmChat({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] });
    assert.deepStrictEqual(out, { choices: [] });
    assert.strictEqual(fetches[0].url, '/v1/chat/completions');
    const body = JSON.parse(fetches[0].opts.body);
    assert.deepStrictEqual(body, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: false });
  });

  console.log('stop semantics:');

  await pcheck('stop destroys Phaser.Game handles via .destroy(true) and unpauses testbed', () => {
    let destroyed = null;
    const pauses = [];
    ctx.window.__ademo = { setPaused: (v) => pauses.push(v) };
    dg.setCurrent({ id: 'alpha', handle: { destroy: (v) => { destroyed = v; } } });
    TR.stop();
    assert.strictEqual(destroyed, true);
    assert.strictEqual(dg.current(), null);
    assert.deepStrictEqual(pauses, [false]);
  });

  await pcheck('stop falls back to .dispose() and swallows disposal errors', () => {
    let disposed = false;
    dg.setCurrent({ id: 'beta', handle: { dispose: () => { disposed = true; } } });
    dg.stop();
    assert.ok(disposed);
    dg.setCurrent({ id: 'gamma', handle: { destroy: () => { throw new Error('boom'); } } });
    dg.stop(); // must not throw
    assert.strictEqual(dg.current(), null);
  });

  await pcheck('stop is a no-op when nothing runs', () => {
    dg.stop();
    assert.strictEqual(dg.current(), null);
  });

  console.log(failures ? ('FAILED: ' + failures + ' check(s)') : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
hostTests();
