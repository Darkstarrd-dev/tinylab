// web/webhub.test.js
// Zero-dependency Node behavioral test for the Web Hub UI (P3).
// Proves: (1) page wiring — script/CSS tags in BOTH index variants, feature
// manifest registration, i18n keys in en+cn; (2) the routes the UI calls match
// the Go declarations EXACTLY (`/webhub/sites/{site}/...`) — jethub 缺陷 6/14
// 是同一坑复发两次，这里先验一次； (3) the left pane renders the site group
// UNDER a divider and shares the single-selection state with jethub;
// (4) the right pane shows site semantics (status / prefix / model IDs) and
// NOT jethub account semantics (no account cards, no credits, no backup).
// Run:  node web/webhub.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const checks = [];
function check(name, fn) { checks.push([name, fn]); }
function checkAsync(name, fn) { checks.push([name, fn, true]); }

console.log('web hub page wiring:');

const staticDir = path.join(__dirname, 'static');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

// ---------- 1. static wiring ----------

check('both index variants mount webhub.js + style-webhub.css', () => {
  for (const f of ['static/index.html', 'static/index-nopg.html']) {
    const html = read(f);
    assert.ok(html.includes('<script src="/webhub.js"></script>'), f + ' missing webhub.js script tag');
    assert.ok(html.includes('<link rel="stylesheet" href="/style-webhub.css">'), f + ' missing style-webhub.css link');
  }
});

check('webhub.js loads AFTER jethub.js (it extends the Free Hub pane)', () => {
  for (const f of ['static/index.html', 'static/index-nopg.html']) {
    const html = read(f);
    const j = html.indexOf('<script src="/jethub.js"></script>');
    const w = html.indexOf('<script src="/webhub.js"></script>');
    assert.ok(j !== -1 && w !== -1 && j < w, f + ': webhub.js must load after jethub.js');
  }
});

check('feature.go registers the two webhub assets on the Core feature', () => {
  const src = read('../internal/feature/feature.go');
  assert.ok(src.includes('"webhub.js"'), 'feature manifest missing webhub.js');
  assert.ok(src.includes('"style-webhub.css"'), 'feature manifest missing style-webhub.css');
});

check('i18n.js defines webHub keys in BOTH en and cn dictionaries', () => {
  const src = read('static/i18n.js');
  for (const key of ['webHubGroup', 'webHubStatusTitle', 'webHubOpen', 'webHubProbe', 'webHubModelsTitle']) {
    const c = (src.match(new RegExp(key + ':', 'g')) || []).length;
    assert.strictEqual(c, 2, key + ' must exist exactly twice (en + cn), got ' + c);
  }
});

check('style-webhub.css defines the divider + status row classes', () => {
  const src = read('static/style-webhub.css');
  assert.ok(src.includes('.free-hub-divider'), 'missing .free-hub-divider');
  assert.ok(src.includes('.webhub-status-row'), 'missing .webhub-status-row');
  assert.ok(src.includes('.badge-warn'), 'missing .badge-warn (site-semantic badge)');
});

// ---------- 2. route shape (the defect-6/14 class) ----------

check('UI route shape matches the Go declaration exactly', () => {
  const go = read('../internal/api/webhub/register.go');
  // Go declares: /webhub/sites, /webhub/sites/{site}/status|open|prefix|probe
  for (const route of ['"/sites"', '"/sites/{site}/status"', '"/sites/{site}/open"',
    '"/sites/{site}/prefix"', '"/sites/{site}/probe"']) {
    assert.ok(go.includes(route), 'Go missing route ' + route);
  }
  const ui = read('static/webhub.js');
  // Every UI call must carry the /sites/ segment.
  for (const call of ['/webhub/sites', '/webhub/sites/\' + encodeURIComponent(siteId) + \'/status',
    '/webhub/sites/\' + encodeURIComponent(siteId) + \'/prefix',
    '/webhub/sites/\' + encodeURIComponent(siteId) + \'/open',
    '/webhub/sites/\' + encodeURIComponent(siteId) + \'/probe']) {
    assert.ok(ui.includes(call), 'UI missing call ' + call);
  }
  // The shape that caused jethub defects 6/14 must NOT appear.
  assert.ok(!ui.includes("/webhub/' + encodeURIComponent(siteId)"), 'UI must not use the /webhub/{site}/... shape');
});

// ---------- 3. jethub.js integration is minimal ----------

check('jethub.js inserts the site group and clears the shared selection', () => {
  const src = read('static/jethub.js');
  assert.ok(src.includes('webhubRenderSiteGroup'), 'jethub.js must render the webhub site group');
  assert.ok(src.includes('webhubLoadSites'), 'jethub.js must load sites on mount');
  assert.ok(src.includes('__webhubState.selected = null'), 'selecting a jethub provider must clear the webhub selection');
  // The lifecycle (openFreeHub/closeFreeHub/navigateTo) must be untouched.
  assert.ok(src.includes('function openFreeHub()'), 'openFreeHub must survive');
  assert.ok(src.includes('function closeFreeHub()'), 'closeFreeHub must survive');
});

check('no new sidebar row is added (requirement 1)', () => {
  const src = read('static/settings/settings.js');
  const rows = (src.match(/id="free-hub-entry"/g) || []).length;
  assert.strictEqual(rows, 1, 'Free Hub entry must stay a single row; webhub is embedded, not a new row');
});

// ---------- 4. VM: render behavior ----------

function makeCtx(sites) {
  const calls = [];
  const els = {};
  const mkEl = (id) => ({
    id, innerHTML: '', textContent: '', value: '',
    insertAdjacentHTML(pos, html) { this.innerHTML += html; calls.push(['insert', id, html]); },
  });
  const ctx = {
    console,
    document: {
      getElementById(id) {
        if (!els[id]) els[id] = mkEl(id);
        return els[id];
      },
      querySelector() { return null; },
      createElement() { return mkEl('new'); },
    },
    window: {},
    escapeHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escapeAttr: (s) => String(s == null ? '' : s).replace(/"/g, '&quot;'),
    escapeForJsString: (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
    t: (k, args) => {
      const dict = {
        webHubGroup: 'Web Sites (browser driven)',
        webHubNotReady: 'Not ready', webHubNoTab: 'Page not open',
        webHubDisconnected: 'Browser not connected', webHubReady: 'Ready',
        webHubPrefixTitle: 'Call Prefix', webHubPrefixHint: 'hint',
        webHubPrefixSave: 'Save Prefix', webHubPrefixClear: 'Clear Prefix',
        webHubStatusTitle: 'Site Status', webHubConnected: 'Browser connected',
        webHubAttached: 'Page attached', webHubLastOk: 'Last check', webHubNeverOk: 'never',
        webHubOpen: 'Open Site', webHubOpenHint: 'h', webHubProbe: 'Check',
        webHubProbeHint: 'h', webHubProbing: 'Checking…',
        webHubLoginHint: 'h', webHubSerialHint: 'h',
        webHubModelsTitle: 'Model IDs', webHubModelsHint: 'h',
        webHubPresets: '{0} presets', freeHubModelsEmpty: 'No models registered',
        clickToCopy: 'Click to copy', webHubNoSelectors: 'no selectors',
        yes: 'yes', no: 'no',
      };
      let out = dict[k] != null ? dict[k] : k;
      (args || []).forEach((a, i) => { out = out.split('{' + i + '}').join(a); });
      return out;
    },
    toast: () => {},
    copyToClipboard: () => {},
    formatDateTime: (d) => String(d),
    apiGet: async (p) => { calls.push(['GET', p]); if (p === '/webhub/sites') return { sites }; return {}; },
    apiPut: async (p, b) => { calls.push(['PUT', p, b]); return { ok: true, modelIds: ['ds/chat.deepseek.com'] }; },
    apiPost: async (p, b) => { calls.push(['POST', p, b]); return { ok: true }; },
    apiDelete: async (p) => { calls.push(['DELETE', p]); return { ok: true }; },
    __jethubRenderProviders: () => {},
    __jethubState: { providers: [] },
    __calls: calls,
    __els: els,
  };
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

const SITES = [
  { id: 'chat.deepseek.com', displayName: 'Deepseek', prefix: '', ready: false, connected: true,
    presetCount: 1, hasSelectors: true, modelIds: ['chat.deepseek.com', 'deepseek'] },
  { id: 'chatgpt.com', displayName: 'Chatgpt', prefix: 'gpt', ready: true, connected: true,
    presetCount: 1, hasSelectors: true, modelIds: ['gpt/chatgpt.com', 'gpt/chat'] },
];

checkAsync('site group renders below a divider, above nothing else', async () => {
  const ctx = makeCtx(SITES);
  vm.runInContext(read('static/webhub.js'), ctx, { filename: 'webhub.js' });
  vm.runInContext('(async()=>{ await webhubLoadSites(); webhubRenderSiteGroup(); })()', ctx);
  await new Promise((r) => setImmediate(r));
  const html = ctx.__els['free-hub-providers'].innerHTML;
  assert.ok(html.includes('free-hub-divider'), 'the divider must be rendered: ' + html);
  const divIdx = html.indexOf('free-hub-divider');
  const firstSite = html.indexOf('chat.deepseek.com');
  assert.ok(divIdx !== -1 && firstSite !== -1 && divIdx < firstSite, 'sites must come AFTER the divider');
  // Both sites present.
  assert.ok(html.includes('chatgpt.com'), 'all sites must render');
});

checkAsync('badges use site semantics, not account counts', async () => {
  const ctx = makeCtx(SITES);
  vm.runInContext(read('static/webhub.js'), ctx, { filename: 'webhub.js' });
  vm.runInContext('(async()=>{ await webhubLoadSites(); webhubRenderSiteGroup(); })()', ctx);
  await new Promise((r) => setImmediate(r));
  const html = ctx.__els['free-hub-providers'].innerHTML;
  // A site has no accounts: the count badge must never appear.
  assert.ok(!/badge[^>]*>\s*\d+\s*</.test(html), 'a site badge must not show a bare count: ' + html);
  assert.ok(html.includes('Not ready') || html.includes('Page not open'), 'must show a site status');
  assert.ok(html.includes('Ready'), 'a ready site must show Ready');
});

checkAsync('site detail has prefix/status/actions/model IDs and NO account UI', async () => {
  const ctx = makeCtx(SITES);
  vm.runInContext(read('static/webhub.js'), ctx, { filename: 'webhub.js' });
  vm.runInContext('(async()=>{ await webhubLoadSites(); await webhubSelect("chatgpt.com"); })()', ctx);
  await new Promise((r) => setImmediate(r));
  const html = ctx.__els['free-hub-detail'].innerHTML;
  for (const want of ['webhub-prefix-input', 'Call Prefix', 'Site Status', 'Open Site', 'Check', 'Model IDs']) {
    assert.ok(html.includes(want), 'detail missing ' + want + ': ' + html);
  }
  // Deliberately NOT present (架构 §3.2: 不做账号卡/积分/限流重测/备份).
  for (const bad of ['free-hub-accounts', 'freeHubAccountsTitle', 'New Account', 'Claim', 'backup']) {
    assert.ok(!html.includes(bad), 'webhub detail must not render jethub account UI: ' + bad);
  }
});

checkAsync('model IDs are rendered as copyable {prefix}/{modelID} strings', async () => {
  const ctx = makeCtx(SITES);
  vm.runInContext(read('static/webhub.js'), ctx, { filename: 'webhub.js' });
  vm.runInContext('(async()=>{ await webhubLoadSites(); await webhubSelect("chatgpt.com"); })()', ctx);
  await new Promise((r) => setImmediate(r));
  const html = ctx.__els['free-hub-detail'].innerHTML;
  assert.ok(html.includes('gpt/chatgpt.com'), 'prefixed model id missing: ' + html);
  assert.ok(html.includes('copyToClipboard'), 'model ids must be click-to-copy');
});

checkAsync('multi-preset sites show the preset count', async () => {
  const ctx = makeCtx([
    { id: 'arena.ai', displayName: 'Arena', prefix: 'ar', ready: false, connected: false,
      presetCount: 12, hasSelectors: true, modelIds: ['ar/arena.ai'] },
  ]);
  vm.runInContext(read('static/webhub.js'), ctx, { filename: 'webhub.js' });
  vm.runInContext('(async()=>{ await webhubLoadSites(); await webhubSelect("arena.ai"); })()', ctx);
  await new Promise((r) => setImmediate(r));
  const html = ctx.__els['free-hub-detail'].innerHTML;
  assert.ok(html.includes('12 presets'), 'preset count missing: ' + html);
});

checkAsync('sites lacking selectors are flagged in the UI', async () => {
  const ctx = makeCtx([
    { id: 'broken.example', displayName: 'Broken', prefix: '', ready: false, connected: true,
      presetCount: 1, hasSelectors: false, modelIds: [] },
  ]);
  vm.runInContext(read('static/webhub.js'), ctx, { filename: 'webhub.js' });
  vm.runInContext('(async()=>{ await webhubLoadSites(); await webhubSelect("broken.example"); })()', ctx);
  await new Promise((r) => setImmediate(r));
  const html = ctx.__els['free-hub-detail'].innerHTML;
  assert.ok(html.includes('no selectors'), 'must flag the missing selectors: ' + html);
});

checkAsync('save prefix hits the /sites/{site}/prefix route', async () => {
  const ctx = makeCtx(SITES);
  vm.runInContext(read('static/webhub.js'), ctx, { filename: 'webhub.js' });
  ctx.__els['webhub-prefix-input'] = { value: 'ds' };
  vm.runInContext('(async()=>{ await webhubLoadSites(); await webhubSavePrefix("chat.deepseek.com"); })()', ctx);
  await new Promise((r) => setImmediate(r));
  const put = ctx.__calls.find((c) => c[0] === 'PUT');
  assert.ok(put, 'no PUT issued');
  assert.strictEqual(put[1], '/webhub/sites/chat.deepseek.com/prefix', 'wrong route: ' + put[1]);
  // NB: the body object is created inside the VM realm, so its prototype is
  // not the host Object — compare fields, not prototypes.
  assert.strictEqual(put[2].prefix, 'ds', 'wrong body: ' + JSON.stringify(put[2]));
});

// ---------- run ----------

(async () => {
  for (const [name, fn, isAsync] of checks) {
    try {
      if (isAsync) await fn(); else fn();
      console.log('  ok  ' + name);
    } catch (e) {
      failures++;
      console.log('  FAIL ' + name + '\n       ' + (e && e.message));
    }
  }
  console.log(failures ? '\nwebhub: ' + failures + ' failure(s)' : '\nwebhub: all checks passed');
  process.exit(failures ? 1 : 0);
})();
