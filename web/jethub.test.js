// web/jethub.test.js
// Zero-dependency Node behavioral test for the Free Hub UI (P4).
// Loads the REAL web/static/jethub.js in a VM sandbox with DOM/API stubs and
// proves: (1) page wiring — entry row position, script/CSS tags, feature
// manifest registration; (2) main switch open/close restores the settings
// view; (3) mount → provider select → prefix save request shape; (4) backup
// shell crypto (PBKDF2 310000 + AES-GCM) roundtrip and WRONG-password
// rejection; (5) restore path: encrypted original-shell container → decrypt →
// import request body is the original-format payload.
// Run:  node web/jethub.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

let failures = 0;
const checks = [];
function check(name, fn) { checks.push([name, fn]); }
function checkAsync(name, fn) { checks.push([name, fn, true]); }

console.log('free hub page wiring:');

// --- static wiring (no VM) ---
check('settings.js places the Free Hub row between Path Settings and Assistant', () => {
  const src = fs.readFileSync(path.join(__dirname, 'static/settings/settings.js'), 'utf8');
  const pathRow = src.indexOf('openPathModal()');
  const hubRow = src.indexOf('id="free-hub-entry"');
  const assistantRow = src.indexOf('openAssistantModal()');
  assert.ok(pathRow !== -1 && hubRow !== -1 && assistantRow !== -1, 'missing rows');
  assert.ok(pathRow < hubRow && hubRow < assistantRow, 'Free Hub row must sit after Path Settings and before Assistant');
  assert.ok(src.includes('onclick="openFreeHub()"'), 'row must open the Free Hub main');
});

check('i18n.js defines freeHub keys in BOTH en and cn dictionaries', () => {
  const src = fs.readFileSync(path.join(__dirname, 'static/i18n.js'), 'utf8');
  const count = (src.match(/freeHubDesc:/g) || []).length;
  assert.strictEqual(count, 2, 'freeHubDesc must exist exactly twice (en + cn), got ' + count);
});

check('both index variants mount jethub.js + style-jethub.css', () => {
  for (const f of ['static/index.html', 'static/index-nopg.html']) {
    const html = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(html.includes('<script src="/jethub.js"></script>'), f + ' missing jethub.js script tag');
    assert.ok(html.includes('<link rel="stylesheet" href="/style-jethub.css">'), f + ' missing style-jethub.css link');
  }
});

check('feature.go registers the two assets on the Core feature', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'internal/feature/feature.go'), 'utf8');
  assert.ok(src.includes('"jethub.js"'), 'feature manifest missing jethub.js');
  assert.ok(src.includes('"style-jethub.css"'), 'feature manifest missing style-jethub.css');
});

// --- VM sandbox ---
const src = fs.readFileSync(path.join(__dirname, 'static/jethub.js'), 'utf8');

function makeEl(tag) {
  return {
    tagName: tag || 'div', style: {}, children: [], id: '',
    innerHTML: '', value: '', textContent: '', href: '', download: '', type: '',
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); },
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    click() {},
    setAttribute() {},
    files: null,
    onchange: null,
  };
}

function makeSandbox() {
  const registry = {};
  const page = makeEl('div'); page.id = 'page-content';
  const layout = makeEl('div'); page.children.push(layout);
  page.querySelector = function(sel) { return sel === '.settings-layout' ? layout : null; };
  registry['page-content'] = page;
  const overlay = makeEl('div'); overlay.id = 'modal-overlay';
  registry['modal-overlay'] = overlay;

  const calls = { apiGet: [], apiPost: [], apiPut: [], apiDelete: [], toast: [] };
  const providers = [
    { id: 'qoder', displayName: 'Qoder', accountCount: 1, enabledAccounts: 1, hasBalance: true, hasCredits: true, loginModes: ['url'], prefix: 'qd', bridged: true },
    { id: 'codearts', displayName: 'CodeArts Agent', accountCount: 0, enabledAccounts: 0, hasBalance: true, hasCredits: true, loginModes: ['url'], prefix: '', bridged: false },
  ];
  const accounts = [{ id: 'qoder-1', provider: 'qoder', nickname: '小七', enabled: true, hasCredential: true, refreshable: true, expiresAt: 1893456000000, credentialRef: 'QODER_ACCOUNT_1' }];
  const models = [{ id: 'auto', name: 'Auto', disabled: false }, { id: 'qfmodel', name: 'Qwen3.8-Flash', disabled: true }];

  let promptQueue = [];
  async function apiGet(p) {
    calls.apiGet.push(p);
    if (p === '/jethub/providers') return { providers };
    if (p.indexOf('/accounts') !== -1) return { accounts };
    if (p.indexOf('/models') !== -1) return { models };
    if (p === '/jethub/backup/export') {
      return { payload: { format: 'dsh-codearts-auth/backup', version: 1, exportedAt: '2026-01-01T00:00:00Z', credentials: { R1: '{"access_token":"t"}' }, accounts: [{ id: 'qoder-1', provider: 'qoder', nickname: '小七', enabled: true, credentialRef: 'R1', createdAt: 1, refreshable: true }], disabledModels: { qoder: { auto: true } } }, warnings: [] };
    }
    return {};
  }
  async function apiPost(p, body) { calls.apiPost.push([p, body]); return { ok: true, imported: 1, skipped: 0, outcome: { claimed: true } }; }
  async function apiPut(p, body) { calls.apiPut.push([p, body]); return { ok: true }; }
  async function apiDelete(p) { calls.apiDelete.push(p); return { ok: true }; }
  async function apiPatch(p, body) { calls.apiPatch = calls.apiPatch || []; calls.apiPatch.push([p, body]); return { ok: true }; }

  const ctx = {
    console,
    document: {
      getElementById(id) { if (!registry[id]) registry[id] = makeEl('div'); return registry[id]; },
      createElement(tag) { return makeEl(tag); },
      querySelector() { return null; },
    },
    t(key, args) {
      const table = { loading: '加载中…', enable: '启用', disable: '停用', delete: '删除', cancel: '取消', confirm: '确认',
        freeHubCheckinAll: '一键签到', freeHubBackup: '备份', freeHubRestore: '恢复', freeHubClose: '关闭',
        freeHubPrefixTitle: '调用前缀', freeHubPrefixSave: '保存前缀', freeHubPrefixClear: '清除前缀', freeHubPrefixHint: 'h', freeHubPrefixSaved: '已保存 {0}/{1}',
        freeHubPrefixInvalid: '非法', freeHubPrefixCleared: '已清除', freeHubAccountsTitle: '账号池', freeHubAddAccount: '新增账号',
        freeHubNoAccounts: '无', freeHubRename: '改名', freeHubExpires: '有效期', freeHubNever: '未知', freeHubRefresh: '续期',
        freeHubLoginTitle: '登录', freeHubLoginHint: 'h', freeHubLoginOpen: '打开', freeHubLoginWaiting: '等待',
        freeHubModelsTitle: '模型', freeHubModelsHint: 'h', freeHubModelsEmpty: '空', freeHubCreditsTitle: '积分',
        freeHubNoCredits: '无', freeHubRefreshBalance: '查询', freeHubBalance: '余额', freeHubClaim: '领取',
        freeHubBalanceFailed: '失败', freeHubClaimOk: '领取成功：{0}', freeHubRestorePwd: '口令', freeHubBackupPwd: '口令',
        failed: '失败 {0}' };
      const v = table[key] !== undefined ? table[key] : key;
      if (args && args.length) return v.replace(/\{(\d)\}/g, (m, i) => args[Number(i)] !== undefined ? args[Number(i)] : m);
      return v;
    },
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    escapeForJsString: (s) => String(s).replace(/'/g, "\\'"),
    toast(msg, type) { calls.toast.push([msg, type]); },
    confirmModal: async () => true,
    promptModal: async () => (promptQueue.length ? promptQueue.shift() : null),
    apiGet, apiPost, apiPut, apiDelete, apiPatch,
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn) => 0,
    crypto: nodeCrypto.webcrypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Blob: function(parts) { this.parts = parts; },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    TextEncoder, TextDecoder,
    __calls: calls, __providers: providers, __promptQueue: promptQueue, __layout: layout, __page: page,
  };
  promptQueue = ctx.__promptQueue;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'jethub.js' });
  return ctx;
}

const tick = () => new Promise((r) => setImmediate(r));
const ticks = async (n) => { for (let i = 0; i < n; i++) await tick(); };

console.log('free hub behavior (VM):');

checkAsync('openFreeHub hides the settings layout, mounts providers; closeFreeHub restores', async () => {
  const ctx = makeSandbox();
  ctx.openFreeHub();
  await ticks(4);
  assert.strictEqual(ctx.__jethubActive, true, 'must be active');
  assert.strictEqual(ctx.__layout.style.display, 'none', 'settings layout hidden');
  const providersEl = ctx.document.getElementById('free-hub-providers');
  assert.ok(providersEl.innerHTML.indexOf('Qoder') !== -1, 'provider list rendered');
  const detailEl = ctx.document.getElementById('free-hub-detail');
  assert.ok(detailEl.innerHTML.indexOf('value="qd"') !== -1, 'prefix input prefilled from provider DTO');
  assert.ok(detailEl.innerHTML.indexOf('Qwen3.8-Flash') !== -1, 'model list rendered');
  ctx.closeFreeHub();
  assert.strictEqual(ctx.__jethubActive, false, 'must be inactive');
  assert.strictEqual(ctx.__layout.style.display, '', 'settings layout restored');
});

checkAsync('prefix save validates client-side and PUTs the body to the provider route', async () => {
  const ctx = makeSandbox();
  ctx.openFreeHub();
  await ticks(4);
  const input = ctx.document.getElementById('free-hub-prefix-input');
  input.value = 'Qoder!'; // illegal charset
  await ctx.jethubSavePrefix('qoder');
  assert.strictEqual(ctx.__calls.apiPut.length, 0, 'illegal prefix must not hit the API');
  input.value = 'qoder-free';
  await ctx.jethubSavePrefix('qoder');
  assert.strictEqual(ctx.__calls.apiPut.length, 1, 'valid prefix must PUT once');
  const [p, body] = ctx.__calls.apiPut[0];
  assert.strictEqual(p, '/jethub/providers/qoder/prefix');
  // ⚠️ body 对象创建于 VM realm，跨 realm 的 deepStrictEqual 会因原型不同
  // 而失败 —— 用 JSON 字符串比较。
  assert.strictEqual(JSON.stringify(body), JSON.stringify({ prefix: 'qoder-free' }));
});

checkAsync('backup: export + passphrase produces the ORIGINAL encrypted shell and downloads it', async () => {
  const ctx = makeSandbox();
  ctx.__promptQueue.push('pw-123');
  let blob = null;
  const origBlob = ctx.Blob;
  ctx.Blob = function(parts) { blob = { parts, container: JSON.parse(parts[0]) }; origBlob.call(ctx, parts); };
  await ctx.jethubBackup();
  await ticks(2);
  assert.ok(blob, 'a backup blob must be produced');
  const c = blob.container;
  assert.strictEqual(c.format, 'dsh-codearts-auth/backup.encrypted');
  assert.strictEqual(c.kdf, 'PBKDF2');
  assert.strictEqual(c.hash, 'SHA-256');
  assert.strictEqual(c.iterations, 310000);
  assert.ok(c.salt && c.iv && c.ciphertext, 'salt/iv/ciphertext required');
  assert.ok(ctx.__calls.toast.some(([m]) => m === 'freeHubBackupDone'), 'success toast');
});

checkAsync('backup crypto: wrong passphrase must reject (AES-GCM auth), correct one roundtrips', async () => {
  const ctx = makeSandbox();
  const payload = { format: 'dsh-codearts-auth/backup', version: 1, accounts: [1] };
  const container = await ctx.__jethubEncryptBackup(payload, 'right');
  const back = await ctx.__jethubDecryptBackup(container, 'right');
  assert.strictEqual(JSON.stringify(back), JSON.stringify(payload), 'roundtrip must be lossless');
  let rejected = false;
  try { await ctx.__jethubDecryptBackup(container, 'wrong'); } catch (e) { rejected = true; }
  assert.ok(rejected, 'wrong passphrase must throw');
});

checkAsync('restore: encrypted original-shell container decrypts and imports the original payload', async () => {
  const ctx = makeSandbox();
  const original = await apiExportLikePayload();
  const container = await ctx.__jethubEncryptBackup(original, 'pw');
  ctx.__promptQueue.push('pw');
  await ctx.jethubRestore({ text: async () => JSON.stringify(container) });
  await ticks(2);
  const importCall = (ctx.__calls.apiPost || []).find(([p]) => p === '/jethub/backup/import');
  assert.ok(importCall, 'import RPC must be called');
  assert.strictEqual(importCall[1].payload.format, 'dsh-codearts-auth/backup');
  assert.strictEqual(importCall[1].payload.credentials.R1, '{"access_token":"t"}', 'credential JSON must survive verbatim');
});

// a payload in the exact original field shape (mirrors the Go-side contract test)
async function apiExportLikePayload() {
  return {
    format: 'dsh-codearts-auth/backup', version: 1, exportedAt: '2026-01-01T00:00:00Z',
    credentials: { R1: '{"access_token":"t"}' },
    accounts: [{ id: 'qoder-1', provider: 'qoder', nickname: '小七', enabled: true, credentialRef: 'R1', createdAt: 1, refreshable: true }],
    disabledModels: { qoder: { auto: true } },
  };
}

(async () => {
  for (const [name, fn, isAsync] of checks) {
    try { if (isAsync) await fn(); else fn(); console.log('  ok  ' + name); }
    catch (err) { failures++; console.error('FAIL  ' + name + ': ' + (err && err.message)); }
  }
  console.log(failures === 0 ? 'all green' : failures + ' failure(s)');
  process.exit(failures === 0 ? 0 : 1);
})();
