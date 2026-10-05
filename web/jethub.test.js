// web/jethub.test.js
// Zero-dependency Node behavioral test for the Free Hub UI (P4/P6 rework).
// Loads the REAL web/static/jethub.js in a VM sandbox with DOM/API stubs and
// proves: (1) page wiring — entry row position, script/CSS tags, feature
// manifest registration; (2) the reworked mount: settings LEFT sidebar stays
// visible, only the main (right) area is replaced, and re-entry after a page
// switch remounts instead of being blocked by the stale active flag;
// (3) header: all four buttons in one left-aligned group (no right-aligned
// close); (4) provider detail: capability-gated action row + account cards
// with credential/expiry/credits/rate-limit chips; (5) model list: vertical
// rows with rate badges, batch delete and restore-defaults request shapes;
// (6) prefix save request shape; (7) backup shell crypto (PBKDF2 310000 +
// AES-GCM) roundtrip and WRONG-password rejection; (8) restore path:
// encrypted original-shell container → decrypt → import request body is the
// original-format payload.
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
  for (const key of ['freeHubRefreshCredits', 'freeHubRetestAll', 'freeHubLockPermanent', 'freeHubRestoreDefaults', 'freeHubBatchManage']) {
    const c = (src.match(new RegExp(key + ':', 'g')) || []).length;
    assert.strictEqual(c, 2, key + ' must exist exactly twice (en + cn), got ' + c);
  }
});

check('app-router.js closes Free Hub on page switches (re-entry bug fix)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'static/app-router.js'), 'utf8');
  assert.ok(src.includes('closeFreeHub()'), 'navigateTo must tear down Free Hub state');
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

check('login handlers never bind a background flow to r.Context() (+new-account regression)', () => {
  // Regression for the reported defect: "+new account immediately created a
  // placeholder; the credential never landed because the background poll
  // died with the canceled request context". Every Start*Login / background
  // poll call in the API layer must pass context.Background().
  const cases = [
    ['internal/api/jethub/raccoon.go', 'StartRaccoonQRLogin(context.Background()'],
    ['internal/api/jethub/cline.go', 'StartClineLogin(context.Background()'],
    ['internal/api/jethub/trae.go', 'StartTraeLogin(context.Background()'],
    ['internal/api/jethub/lobsterai.go', 'StartLobsteraiLogin(context.Background()'],
    ['internal/api/jethub/buddy.go', 'StartBuddyLogin(context.Background()'],
    ['internal/api/jethub/minimax.go', 'PollMinimaxDeviceToken(context.Background()'],
    ['internal/api/jethub/qoder.go', 'PollQoderDeviceToken(context.Background()'],
  ];
  for (const [f, needle] of cases) {
    const go = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(go.includes(needle), f + ' must start its login flow with context.Background(), not r.Context()');
    // No login start may ever reference the request context again.
    const startCalls = go.match(/Start\w*Login\(r\.Context\(\)|Poll\w*Token\(r\.Context\(\)/g);
    assert.ok(!startCalls, f + ' still binds a login flow to r.Context(): ' + startCalls);
  }
  // Every login handler registers a single-winner pump so the status poll
  // never races the pump for the flow's outcome channel.
  for (const f of ['raccoon.go', 'cline.go', 'trae.go', 'lobsterai.go', 'buddy.go', 'minimax.go', 'qoder.go', 'codearts.go']) {
    const go = fs.readFileSync(path.join(__dirname, '..', 'internal/api/jethub', f), 'utf8');
    assert.ok(go.includes('SettleAndCleanup(sess'), f + ' must pump the outcome via SettleAndCleanup');
  }
  // Every login handler must auto-open the authorization page: the flows that
  // live in Manager Start*Login functions do it internally, but the inline
  // ones (minimax, qoder) and the scan-login page (raccoon: the local page URL
  // only exists once the handler knows the request host) must call the opener
  // themselves — minimax shipped without it (reported defect).
  for (const f of ['minimax.go', 'qoder.go', 'raccoon.go']) {
    const go = fs.readFileSync(path.join(__dirname, '..', 'internal/api/jethub', f), 'utf8');
    assert.ok(go.includes('OpenURLWithBrowser('), f + ' must auto-open the login page (OpenURLWithBrowser)');
  }
  // The app must wire the browser opener + the post-credential sync hook:
  // auto-open the login page like the original plugin, and refresh the
  // bridged provider's keys when a credential lands (else the new account
  // stays invisible to {prefix}/{model} routing).
  const appGo = fs.readFileSync(path.join(__dirname, '..', 'internal/app/app.go'), 'utf8');
  assert.ok(appGo.includes('SetBrowserOpener('), 'app must wire SetBrowserOpener (auto-open the login page)');
  assert.ok(appGo.includes('SetAccountCredentialedHook('), 'app must wire SetAccountCredentialedHook (SyncKeys after login)');
  // The app must also route jethub outbound calls through the configured
  // global proxy (real defect: direct dial got TLS handshake timeouts on
  // machines whose upstream access runs through the local routing proxy).
  assert.ok(appGo.includes('SetProxyURL(proxyRaw)'), 'app must wire jethubMgr.SetProxyURL from config.Proxy');
  assert.ok(appGo.includes('jethub.SetPackageProxyURL(proxyRaw)'), 'app must wire jethub.SetPackageProxyURL (codearts callback client)');
});

check('account card marks credential-less placeholders; SMS modal creates the account itself', () => {
  const src = fs.readFileSync(path.join(__dirname, 'static/jethub.js'), 'utf8');
  assert.ok(src.includes('freeHubNoCredential'), 'placeholder accounts must show the no-credential badge');
  // SMS providers have no server-side login session: the UI must create the
  // placeholder account before the modal opens (otherwise sms/submit has no
  // accountId to attach the credential to).
  const addAccount = src.match(/async function jethubAddAccount[\s\S]*?\n}/);
  assert.ok(addAccount, 'jethubAddAccount found');
  assert.ok(addAccount[0].includes("/accounts'"), 'SMS path must POST /accounts to create the placeholder first');
  assert.ok(addAccount[0].includes('__jethubSmsModal(providerId, created.accountId)'), 'SMS modal must receive the new accountId');
  // The placeholder cleanup lives in the WAITING step now: the browser/session
  // chooser runs BEFORE the login RPC, so at that point no account exists and
  // cancelling must not touch the API.
  const waitingModal = src.match(/function __jethubLoginWaitingModal[\s\S]*?\n\nfunction/);
  assert.ok(waitingModal && waitingModal[0].includes("apiDelete('/jethub/accounts/'"), 'the waiting modal cancel must delete the placeholder');
  const chooseModal = src.match(/function __jethubLoginModal[\s\S]*?\n\n\/\//);
  assert.ok(chooseModal, '__jethubLoginModal found');
  assert.ok(!chooseModal[0].includes('apiDelete('), 'the choose step runs before the account exists: cancel must not delete anything');
  const smsModal = src.match(/function __jethubSmsModal[\s\S]*?\n\nasync function/);
  assert.ok(smsModal && smsModal[0].includes("apiDelete('/jethub/accounts/'"), 'SMS modal cancel must delete the placeholder');
  assert.ok(smsModal[0].includes('accountId: accountId'), 'SMS submit must send accountId');
});

check('login dialog uses the project custom-select component, not a native dropdown', () => {
  const src = fs.readFileSync(path.join(__dirname, 'static/jethub.js'), 'utf8');
  const choose = src.match(/function __jethubLoginModal[\s\S]*?\n\n\/\//);
  assert.ok(choose, '__jethubLoginModal found');
  assert.ok(choose[0].includes('renderCustomSelectHtml('), 'the browser/session pickers must use renderCustomSelectHtml (app.js component)');
  // `\s` (not `[\s>]`) so the design-comment's `<select>` mention is not a hit:
  // only real element markup (`<select class=…`) counts.
  assert.ok(!/<select\s/.test(choose[0]), 'the dialog must not render a bare native <select> — the component owns the hidden one');
  assert.ok(choose[0].includes("renderCustomSelectHtml('free-hub-login-browser-wrap'"), 'the browser axis must use the component');
  assert.ok(choose[0].includes("renderCustomSelectHtml('free-hub-login-session-wrap'"), 'the session axis must use the component');
  assert.ok(choose[0].includes('__jethubSyncLoginForm()'), 'the hidden native selects must dispatch into the sync handler');
  // The component's base styles live in style-download.css (imported by
  // style.css) and the in-modal overrides in style.css: losing either silently
  // turns the dropdown back into an unstyled box.
  const styleCss = fs.readFileSync(path.join(__dirname, 'static/style.css'), 'utf8');
  assert.ok(styleCss.includes('@import url("style-download.css")'), 'style.css must keep importing the component base styles');
  assert.ok(styleCss.includes('.modal .custom-select-trigger'), 'the in-modal custom-select overrides must stay in style.css');
});

// --- VM sandbox ---
const src = fs.readFileSync(path.join(__dirname, 'static/jethub.js'), 'utf8');

function makeEl(tag) {
  return {
    tagName: tag || 'div', style: { display: '' }, children: [], id: '', className: '',
    innerHTML: '', value: '', textContent: '', href: '', download: '', type: '',
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); },
    insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i === -1) this.children.push(c); else this.children.splice(i, 0, c); },
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
  const layout = makeEl('div');
  const right = makeEl('div'); right.className = 'settings-panel-right';
  layout.children.push(right);
  page.children.push(layout);
  page.querySelector = function(sel) {
    if (sel === '.settings-layout') return layout;
    if (sel === '.settings-panel-right') return right;
    return null;
  };
  layout.querySelector = function(sel) { return sel === '.settings-panel-right' ? right : null; };
  registry['page-content'] = page;
  const overlay = makeEl('div'); overlay.id = 'modal-overlay';
  registry['modal-overlay'] = overlay;

  const calls = { apiGet: [], apiPost: [], apiPut: [], apiDelete: [], apiPatch: [], toast: [], intervals: [], cleared: [] };
  // login-status poll responses are scripted per test (see __setStatusResponse):
  // the modal's whole lifecycle hangs off this one response shape.
  let statusResponse = null;
  const providers = [
    { id: 'qoder', displayName: 'Qoder', accountCount: 1, enabledAccounts: 1, hasBalance: true, hasCredits: true, loginModes: ['url'], prefix: 'qd', bridged: true, supportsRateLimit: true, canLockPermanent: false, permanentLocked: false, proxyEnabled: true },
    // ⚠️ loomy 的 loginModes 是 ['url']（真实缺陷 18 后与后端一致）：面板走浏览器
    // 弹窗页 + 轮询，不再有内嵌短信表单。
    { id: 'loomy', displayName: 'Loomy', accountCount: 0, enabledAccounts: 0, hasBalance: true, hasCredits: true, loginModes: ['url'], prefix: '', bridged: false, supportsRateLimit: false, canLockPermanent: true, permanentLocked: true, proxyEnabled: false },
  ];
  const accounts = [{ id: 'qoder-1', provider: 'qoder', nickname: '小七', enabled: true, hasCredential: true, refreshable: true, expiresAt: Date.now() + 7200000, credentialRef: 'QODER_ACCOUNT_1', modelRateLimits: { qfmodel: Date.now() + 3600000, stale: Date.now() - 3600000 } }];
  const models = [{ id: 'auto', name: 'Auto', rate: 'x0.5', disabled: false }, { id: 'qfmodel', name: 'Qwen3.8-Flash', rate: '免费', disabled: true }];

  let promptQueue = [];
  async function apiGet(p) {
    calls.apiGet.push(p);
    if (p.indexOf('/status?loginId=') !== -1) return statusResponse || {};
    if (p === '/jethub/providers') return { providers };
    // Browser/session axis of the +New Account dialog (installed browsers + the
    // OS default + the remembered selection).
    if (p === '/jethub/login-browsers') return {
      browsers: [{ id: 'edge', label: 'Microsoft Edge', family: 'edge', path: 'C:/Edge/msedge.exe', privateOk: true, privateFlag: '--inprivate', profileOk: true }],
      defaultBrowser: { path: 'C:/Chrome/chrome.exe', label: 'Google Chrome', family: 'chrome', privateOk: true, privateFlag: '--incognito' },
      sessions: ['shared', 'private', 'isolated'],
      prefs: { browser: 'edge', session: 'isolated' },
    };
    if (p.indexOf('/balance') !== -1) return { balance: { total: 123.45 } };
    if (p.indexOf('/accounts') !== -1) return { accounts };
    if (p.indexOf('/models') !== -1) return { models };
    if (p === '/jethub/backup/export') {
      return { payload: { format: 'dsh-codearts-auth/backup', version: 1, exportedAt: '2026-01-01T00:00:00Z', credentials: { R1: '{"access_token":"t"}' }, accounts: [{ id: 'qoder-1', provider: 'qoder', nickname: '小七', enabled: true, credentialRef: 'R1', createdAt: 1, refreshable: true }], disabledModels: { qoder: { auto: true } }, permanentLocks: { qoder: true } }, warnings: [] };
    }
    return {};
  }
  async function apiPost(p, body) { calls.apiPost.push([p, body]); if (p.endsWith('/login')) return { accountId: 'loomy-1', loginId: 'L1', loginUrl: 'http://127.0.0.1/free-hub-loomy-login.html?loginId=L1', loginMode: 'url' }; if (p.endsWith('/retest')) return { clearedCount: 1, accounts: [{ accountId: 'qoder-1', stillLimited: [{ modelId: 'qfmodel', message: 'HTTP 429: limited' }] }] }; return { ok: true, imported: 1, skipped: 0, outcome: { claimed: true } }; }
  async function apiPut(p, body) { calls.apiPut.push([p, body]); return { ok: true }; }
  async function apiDelete(p) { calls.apiDelete.push(p); return { ok: true }; }
  async function apiPatch(p, body) { calls.apiPatch.push([p, body]); return { ok: true }; }

  const ctx = {
    console,
    document: {
      // ⚠️ 'free-hub-root' must follow real DOM semantics (null when absent):
      // openFreeHub() gates the right-panel replacement behind its existence.
      // Everything else auto-creates like the old sandbox did.
      getElementById(id) {
        if (id === 'free-hub-root' && !registry[id]) return null;
        if (!registry[id]) registry[id] = makeEl('div');
        return registry[id];
      },
      createElement(tag) { return makeEl(tag); },
      querySelector() { return null; },
    },
    t(key, args) {
      const table = { loading: '加载中…', enable: '启用', disable: '停用', delete: '删除', cancel: '取消', confirm: '确认', clickToCopy: '点击复制',
        freeHubCheckinAll: '一键签到', freeHubBackup: '备份', freeHubRestore: '恢复', freeHubClose: '关闭',
        freeHubPrefixTitle: '调用前缀', freeHubPrefixSave: '保存前缀', freeHubPrefixClear: '清除前缀', freeHubPrefixHint: 'h', freeHubPrefixSaved: '已保存 {0}/{1}',
        freeHubPrefixInvalid: '非法', freeHubPrefixCleared: '已清除', freeHubAccountsTitle: '账号池', freeHubAddAccount: '新增账号',
        freeHubNoAccounts: '无', freeHubRename: '改名', freeHubExpires: '有效期', freeHubNever: '未知', freeHubRefresh: '续期',
        freeHubLoginTitle: '登录', freeHubLoginHint: 'h', freeHubLoginOpen: '打开', freeHubLoginWaiting: '等待',
        freeHubModelsTitle: '模型列表', freeHubModelsHint: 'h', freeHubModelsEmpty: '空', freeHubCreditsTitle: '积分',
        freeHubNoCredits: '无', freeHubRefreshBalance: '查询', freeHubBalance: '余额', freeHubClaim: '领取',
        freeHubBalanceFailed: '失败', freeHubClaimOk: '领取成功：{0}', freeHubRestorePwd: '口令', freeHubBackupPwd: '口令',
        freeHubRefreshCredits: '刷新积分', freeHubClaimAll: '一键领取积分', freeHubClaimRunning: '领取中…',
        freeHubClaimDone: '领取完成：成功 {0}，失败 {1}', freeHubNewAccount: '+ 新建账号',
        freeHubNoCredential: '登录未完成 · 无凭据',
        freeHubUseProxy: '走代理', freeHubUseProxyHint: 'h', freeHubProxyOn: '已启用走代理', freeHubProxyOff: '已关闭走代理',
        freeHubRetestAll: '重测所有', freeHubResetAll: '重置所有', freeHubRetest: '重测', freeHubReset: '重置',
        freeHubRetestHelp: 'h', freeHubResetHelp: 'h', freeHubRetestAllHelp: 'h', freeHubResetAllHelp: 'h',
        freeHubRetestConfirm: '继续？', freeHubRetestRunning: '重测中…', freeHubRetestDone: '重测完成：清除 {0}，仍受限 {1}',
        freeHubRetestNone: '没有可重测的限流标记', freeHubStillLimited: '仍受限',
        freeHubResetRunning: '清除中…', freeHubResetDone: '已清除 {0} 条限流标记', freeHubResetNone: '没有可清除的限流标记',
        freeHubLockPermanent: '锁定永久积分', freeHubUnlockPermanent: '解锁永久积分',
        freeHubLockOn: '已锁定', freeHubLockOff: '已解锁',
        freeHubCredential: '凭据', freeHubAutoRenew: '自动续期', freeHubCreditsLabel: '积分',
        freeHubUnknown: '未知', freeHubExpired: '已过期', freeHubInMinutes: '{0} 分钟后', freeHubInHours: '{0} 小时后',
        freeHubCreditFailed: '查询失败', freeHubCreditsLoading: '正在查询积分…', freeHubRateLimitReset: '限额重置',
        freeHubRestoreDefaults: '恢复默认', freeHubRestoreDefaultsConfirm: '恢复？', freeHubBatchManage: '批量管理',
        freeHubBatchDelete: '删除所选', freeHubSelectAll: '全选', freeHubDeselectAll: '取消全选',
        freeHubFilterModels: '筛选模型', freeHubClearFilter: '清除', freeHubHidden: '已隐藏', freeHubRestoreRow: '恢复',
        freeHubBatchDeleteConfirm: '隐藏 {0} 个？', freeHubModelsDeleted: '已隐藏 {0} 个模型',
        freeHubModelsRestored: '已恢复默认', freeHubNoModelsSelected: '未选择模型',
        failed: '失败 {0}' };
      const v = table[key] !== undefined ? table[key] : key;
      if (args && args.length) return v.replace(/\{(\d)\}/g, (m, i) => args[Number(i)] !== undefined ? args[Number(i)] : m);
      return v;
    },
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    escapeForJsString: (s) => String(s).replace(/'/g, "\\'"),
    // The project's custom-select component lives in app.js, which this sandbox
    // does not load. Stub it with the SAME DOM contract as the real
    // renderCustomSelectHtml (wrapper + trigger + menu + hidden native <select>
    // carrying the value and the onchange dispatch) so the dialog's real call
    // path — and any regression back to a bare native <select> — is visible here.
    renderCustomSelectHtml(wrapperId, selectId, options, selectedValue, onChangeHandler) {
      const parts = options.map((opt) => {
        const val = typeof opt === 'object' ? opt.value : opt;
        const label = typeof opt === 'object' ? opt.label : opt;
        return { val, label, sel: String(val) === String(selectedValue) };
      });
      const rows = parts.map((p) => '<div class="custom-select-option' + (p.sel ? ' selected' : '') +
        '" data-value="' + p.val + '"><span class="custom-select-option-link">' + p.label + '</span></div>').join('');
      const optsHtml = parts.map((p) => '<option value="' + p.val + '"' + (p.sel ? ' selected' : '') + '>' + p.label + '</option>').join('');
      const selText = parts.filter((p) => p.sel).map((p) => p.label)[0] || String(selectedValue);
      return '<div class="custom-select-wrapper" id="' + wrapperId + '">' +
        '<div class="custom-select-trigger" onclick="toggleCustomSelect(\'' + wrapperId + '\', event)">' +
        '<span class="custom-select-label">' + selText + '</span></div>' +
        '<div class="custom-select-menu">' + rows + '</div>' +
        '<select id="' + selectId + '"' + (onChangeHandler ? ' onchange="' + onChangeHandler + '"' : '') + ' style="display:none;">' + optsHtml + '</select>' +
        '</div>';
    },
    toast(msg, type) { calls.toast.push([msg, type]); },
    confirmModal: async () => true,
    promptModal: async () => (promptQueue.length ? promptQueue.shift() : null),
    apiGet, apiPost, apiPut, apiDelete, apiPatch,
    // The login modal's poll runs on setInterval: capture the callbacks so the
    // tests can drive the status transitions deterministically (the real timer
    // is a no-op here).
    setInterval: (fn, ms) => { calls.intervals.push([fn, ms]); return calls.intervals.length; },
    clearInterval: (id) => { calls.cleared.push(id); },
    setTimeout: (fn) => 0,
    crypto: nodeCrypto.webcrypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Blob: function(parts) { this.parts = parts; },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    TextEncoder, TextDecoder,
    __calls: calls, __providers: providers, __promptQueue: promptQueue, __layout: layout, __right: right, __page: page, __registry: registry,
    __setStatusResponse: (v) => { statusResponse = v; },
  };
  promptQueue = ctx.__promptQueue;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'jethub.js' });
  return ctx;
}

const tick = () => new Promise((r) => setImmediate(r));
const ticks = async (n) => { for (let i = 0; i < n; i++) await tick(); };

console.log('free hub behavior (VM):');

checkAsync('① mount replaces ONLY the main area: settings sidebar stays, right panel hidden, close restores', async () => {
  const ctx = makeSandbox();
  ctx.openFreeHub();
  await ticks(4);
  assert.strictEqual(ctx.__jethubActive, true, 'must be active');
  assert.strictEqual(ctx.__layout.style.display, '', 'settings layout (sidebar) must stay visible');
  assert.strictEqual(ctx.__right.style.display, 'none', 'only the right panel is replaced');
  const providersEl = ctx.document.getElementById('free-hub-providers');
  assert.ok(providersEl.innerHTML.indexOf('Qoder') !== -1, 'provider list rendered');
  ctx.closeFreeHub();
  assert.strictEqual(ctx.__jethubActive, false, 'must be inactive');
  assert.strictEqual(ctx.__right.style.display, '', 'right panel restored');
});

checkAsync('① re-entering Free Hub after a page switch (orphaned state) remounts instead of being blocked', async () => {
  const ctx = makeSandbox();
  ctx.openFreeHub();
  await ticks(4);
  // Simulate the reported bug path: the user switches to another page. The
  // router wipes #page-content (destroying the Free Hub DOM) — without the
  // fix the stale __jethubActive flag blocked all re-entry until reload.
  delete ctx.__registry['free-hub-root'];
  assert.strictEqual(ctx.__jethubActive, true, 'stale flag as left by a page switch without the router hook');
  ctx.openFreeHub();
  await ticks(4);
  assert.strictEqual(ctx.__jethubActive, true, 'must be active again');
  const providersEl = ctx.document.getElementById('free-hub-providers');
  assert.ok(providersEl.innerHTML.indexOf('Qoder') !== -1, 'provider list must render after re-entry');
});

check('② header: all four buttons in one left-aligned group (no spacer / right-aligned close)', () => {
  assert.ok(!src.includes('free-hub-header-spacer'), 'the flex spacer pushing Close right must be gone');
  const shell = src.match(/free-hub-header">([\s\S]*?)<\/div>/);
  assert.ok(shell, 'header markup found');
  const group = shell[1];
  const buttons = (group.match(/<button/g) || []).length;
  assert.strictEqual(buttons, 4, 'header must contain exactly claim-all + backup + restore + close, got ' + buttons);
  const closeIdx = group.indexOf("closeFreeHub()");
  const restoreIdx = group.indexOf("jethubRestorePick()");
  assert.ok(restoreIdx !== -1 && closeIdx > restoreIdx, 'close sits inline after the action buttons');
});

checkAsync('③ detail: capability-gated action row (refresh/claim/retest/reset/lock/new)', async () => {
  const ctx = makeSandbox();
  ctx.openFreeHub();
  await ticks(6);
  const detail = ctx.document.getElementById('free-hub-detail');
  const html = detail.innerHTML;
  assert.ok(html.indexOf('刷新积分') !== -1, '刷新积分 button');
  assert.ok(html.indexOf('一键领取积分') !== -1, '一键领取积分 button');
  assert.ok(html.indexOf('重测所有') !== -1, '重测所有 button');
  assert.ok(html.indexOf('重置所有') !== -1, '重置所有 button');
  assert.ok(html.indexOf('+ 新建账号') !== -1, '+ 新建账号 button');
  // loomy hides retest/reset (no rate limiting) but shows the lock toggle
  await ctx.jethubSelect('loomy');
  await ticks(2);
  const loomyHtml = ctx.document.getElementById('free-hub-detail').innerHTML;
  assert.ok(loomyHtml.indexOf('解锁永久积分') !== -1, 'locked provider shows 解锁永久积分');
  assert.ok(loomyHtml.indexOf('重测所有') === -1, 'loomy must not render 重测所有');
  assert.ok(loomyHtml.indexOf('重置所有') === -1, 'loomy must not render 重置所有');
});

checkAsync('⑤ Use Proxy toggle right of +New Account: project toggle-switch, PUT body, revert on failure', async () => {
  const ctx = makeSandbox();
  ctx.openFreeHub();
  await ticks(6);
  const detail = ctx.document.getElementById('free-hub-detail');
  const html = detail.innerHTML;
  assert.ok(html.indexOf('走代理') !== -1, 'Use Proxy label rendered');
  assert.ok(html.indexOf('toggle-switch') !== -1, 'project custom toggle-switch style');
  // qoder has proxyEnabled: true → checked; the toggle sits after the
  // + 新建账号 button in the same action row.
  const actionIdx = html.indexOf('free-hub-actions');
  const newBtnIdx = html.indexOf('+ 新建账号', actionIdx);
  const toggleIdx = html.indexOf('toggle-switch', actionIdx);
  assert.ok(newBtnIdx !== -1 && toggleIdx > newBtnIdx, 'toggle must sit right of + 新建账号');
  assert.ok(/jethubToggleProxy\('qoder', this\.checked\)"\s*checked/.test(html), 'qoder toggle rendered checked');
  // Flip loomy's toggle: PUT body {enabled:true} + success toast.
  await ctx.jethubSelect('loomy');
  await ticks(2);
  await ctx.jethubToggleProxy('loomy', true);
  const put = ctx.__calls.apiPut.find(([p]) => p === '/jethub/providers/loomy/proxy');
  assert.ok(put && JSON.stringify(put[1]) === JSON.stringify({ enabled: true }), 'proxy PUT body');
  assert.ok(ctx.__calls.toast.some(([m, ty]) => ty === 'success' && m === '已启用走代理'), 'success toast');
  // Failure reverts: apiPut failing → checkbox state refreshes via select.
  const origApiPut = ctx.apiPut;
  ctx.apiPut = async function(p, body) { return { error: 'boom' }; };
  await ctx.jethubToggleProxy('loomy', true);
  ctx.apiPut = origApiPut;
  assert.ok(ctx.__calls.toast.some(([m, ty]) => ty === 'error' && m.indexOf('boom') !== -1), 'failure toast shown');
});

// jethubRouteTable parses every chi route declaration in internal/api/jethub/*.go
// into "METHOD /canonical/path" keys (dynamic segments — {param} or a literal
// provider name — become '*'). Shared by the UI path guard and the login-page
// literal guard below.
function jethubRouteTable() {
  const dir = path.join(__dirname, '..', 'internal/api/jethub');
  const managerGo = fs.readFileSync(path.join(__dirname, '..', 'internal/jethub/manager.go'), 'utf8');
  const providers = new Set([...managerGo.matchAll(/\{ID: "([a-z]+)"/g)].map((m) => m[1]));
  const canon = (p) => p.split('/').map((seg) => {
    if (seg === '{}' || /^\{.*\}$/.test(seg) || providers.has(seg)) return '*';
    return seg;
  }).join('/');
  const table = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.go') || f.endsWith('_test.go')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/r\.(Get|Post|Put|Patch|Delete)\("(\/[^"]*)"/g)) {
      const p = m[2].startsWith('/jethub') ? m[2] : '/jethub' + m[2];
      table.add(m[1].toUpperCase() + ' ' + canon(p));
    }
  }
  return { table, canon, providers };
}

check('⑤ frontend jethub paths match the backend route table (404 regression guard, ALL methods)', () => {
  // Regression for the reported "Failed: HTTP 404 (non-JSON body)" family. Three
  // real defects came from this one class, all of them *plain-text* chi 404s:
  //   - PUT /jethub/{provider}/proxy            (needs the providers/ segment)
  //   - POST /jethub/{provider}/accounts        (SMS placeholder creation; only
  //     loomy uses the sms login mode, which is why only it reported the error)
  //   - POST /jethub/{provider}/ratelimits/*    (retest/reset buttons)
  // The old guard only looked at apiPut literals, so the apiPost ones slipped
  // through — now EVERY api<Method>('/jethub/...') call is cross-checked against
  // the chi route declarations parsed out of internal/api/jethub/*.go.
  const api = fs.readFileSync(path.join(__dirname, 'static/jethub.js'), 'utf8');
  const { table: backend, canon, providers } = jethubRouteTable();
  assert.ok(providers.size >= 10, 'expected the 11-provider table, got ' + [...providers].join(','));
  assert.ok(backend.size > 20, 'expected a substantial jethub route table, got ' + backend.size);

  // Normalise both concatenation forms: `'/a/' + encodeURIComponent(x) + '/b'`
  // and the trailing `'/a/' + encodeURIComponent(x)` (no following literal).
  const norm = api
    .replace(/' \+ encodeURIComponent\([^)]*\) \+ '/g, '{}')
    .replace(/' \+ encodeURIComponent\([^)]*\)/g, '{}');
  const calls = [...norm.matchAll(/api(Get|Post|Put|Patch|Delete)\('(\/jethub\/[^')]*)/g)];
  assert.ok(calls.length > 15, 'expected many jethub RPC calls, got ' + calls.length);
  const misses = [];
  for (const [, method, rawPath] of calls) {
    const pathOnly = rawPath.split('?')[0].replace(/\/$/, '');
    const key = method.toUpperCase() + ' ' + canon(pathOnly);
    if (!backend.has(key)) misses.push(key);
  }
  assert.deepStrictEqual(misses, [], 'these UI calls have no matching backend route (plain-text 404): ' + misses.join(', '));
});

check('⑤ login pages + public page payloads reference registered /api/jethub routes', () => {
  // The scan-login pages are static assets whose calls are NOT covered by the
  // jethub.js guard above — a typo there only shows up in a browser. Same for
  // the `qrImage` URL the Go handler hands to the page. Both are checked here
  // against the real route table (method-agnostic: a wrong METHOD still fails
  // the path match only when no route uses that path at all).
  const { table, canon } = jethubRouteTable();
  const paths = new Set();
  for (const f of ['free-hub-login.html', 'free-hub-loomy-login.html']) {
    const src = fs.readFileSync(path.join(__dirname, 'static', f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of src.matchAll(/['"](\/api\/jethub\/[^'"?]*)/g)) paths.add(m[1]);
  }
  const goPage = fs.readFileSync(path.join(__dirname, '..', 'internal/api/jethub/login_page.go'), 'utf8');
  for (const m of goPage.matchAll(/"(\/api\/jethub\/[^"?]*)"/g)) paths.add(m[1]);
  assert.ok(paths.size >= 3, 'expected the login-page endpoints, got ' + [...paths].join(','));

  const registered = new Set([...table].map((k) => k.split(' ').slice(1).join(' ')));
  const misses = [];
  for (const p of paths) {
    const shape = canon(p.replace(/^\/api/, ''));
    if (!registered.has(shape)) misses.push(p + ' → ' + shape);
  }
  assert.deepStrictEqual(misses, [], 'login-page paths with no registered route: ' + misses.join(', '));
});

checkAsync('③ account card: credential/expiry/credits meta + rate-limit chips + per-card retest/reset', async () => {
  const ctx = makeSandbox();
  ctx.openFreeHub();
  await ticks(6);
  const html = ctx.document.getElementById('free-hub-detail').innerHTML;
  assert.ok(html.indexOf('QODER_ACCOUNT_1') !== -1, 'credential ref displayed');
  assert.ok(html.indexOf('限额重置') !== -1, 'rate-limit chip row label');
  assert.ok(html.indexOf('qfmodel') !== -1, 'limited model chip');
  assert.ok(html.indexOf('重测') !== -1 && html.indexOf('重置') !== -1, 'per-card retest/reset buttons');
  // per-account credits: the balance RPC ran and the credit cell element was
  // updated (in this string-DOM sandbox the cell lives in the registry).
  const creditCell = ctx.__registry['free-hub-credit-qoder-1'];
  assert.ok(creditCell && creditCell.innerHTML.indexOf('123.45') !== -1, 'per-account credits fetched and rendered');
  assert.ok(ctx.__calls.apiGet.some((p) => p.indexOf('/jethub/qoder/balance?accountId=qoder-1') === 0), 'balance RPC per account');
  // retest endpoint shape (all accounts) — providers/ segment required
  await ctx.jethubRetest('qoder', '');
  const retest = ctx.__calls.apiPost.find(([p]) => p === '/jethub/providers/qoder/ratelimits/retest');
  assert.ok(retest && JSON.stringify(retest[1]) === JSON.stringify({ accountId: '' }), 'retest POST body');
  // reset endpoint shape (single account)
  await ctx.jethubReset('qoder', 'qoder-1');
  const reset = ctx.__calls.apiPost.find(([p]) => p === '/jethub/providers/qoder/ratelimits/reset');
  assert.ok(reset && JSON.stringify(reset[1]) === JSON.stringify({ accountId: 'qoder-1' }), 'reset POST body');
});

checkAsync('③ login modal (URL flow): settles on done, and a GONE session ends it too — never a silent forever-poll', async () => {
  // 真实缺陷 19 的第二道症状：登录其实已经成功（凭据落盘、账号卡也进了列表），
  // 但弹窗一动不动。第一道在服务端（loomy 的 /status 漏了 loginId 分支，见
  // internal/api/jethub/status_login_test.go）；这里锁前端这一半 —— 只要会话没了
  // （结算 30s 宽限期后回收 ⇒ 404），就必须**收尾**（停轮询 + 关弹窗 + 刷新列表 +
  // 明确提示），而不是把错误文案写进状态行后每 2s 空转到天荒地老。
  const ctx = makeSandbox();
  ctx.openFreeHub();
  await ticks(4);
  await ctx.jethubAddAccount('loomy');
  await ticks(2);
  // Step 1 (choose browser/session) → step 2 (login RPC + waiting + poll).
  await ctx.jethubLoginConfirm('loomy');
  await ticks(1);
  const overlay = ctx.document.getElementById('modal-overlay');
  assert.ok(overlay.innerHTML.indexOf('free-hub-login-status') !== -1, 'URL flow must open the login modal');
  assert.strictEqual(ctx.__calls.apiPost[0][0], '/jethub/loomy/login', 'URL flow must start the server login, not create the account itself');
  const [poll, interval] = ctx.__calls.intervals[0];
  assert.strictEqual(interval, 2000, 'the modal polls the login status every 2s');

  // 未结算 ⇒ 保持打开（不误判）
  ctx.__setStatusResponse({ done: false, accountId: 'loomy-1' });
  await poll();
  assert.ok(overlay.innerHTML.indexOf('free-hub-login-status') !== -1, 'a pending flow must keep the modal open');

  // 结算成功 ⇒ 关弹窗 + 成功提示 + 停轮询 + 刷新列表
  ctx.__setStatusResponse({ done: true, success: true, accountId: 'loomy-1' });
  await poll();
  assert.strictEqual(overlay.innerHTML, '', 'a settled login must close the modal');
  assert.ok(ctx.__calls.toast.some(([m]) => m === 'freeHubLoginOk'), 'success toast must fire');
  assert.ok(ctx.__calls.cleared.length > 0, 'the poll timer must be cleared');
  assert.ok(ctx.__calls.apiGet.some((p) => p === '/jethub/providers'), 'the account list must be refreshed');

  // 结算失败 ⇒ 关弹窗 + 带原因的错误提示
  const fail = makeSandbox();
  fail.openFreeHub();
  await ticks(4);
  await fail.jethubAddAccount('loomy');
  await ticks(2);
  await fail.jethubLoginConfirm('loomy');
  await ticks(1);
  fail.__setStatusResponse({ done: true, success: false, error: 'loomy: 你已取消授权' });
  await fail.__calls.intervals[0][0]();
  assert.strictEqual(fail.document.getElementById('modal-overlay').innerHTML, '', 'a failed login must close the modal');
  assert.ok(fail.__calls.toast.some(([m]) => m === 'freeHubLoginFailed'), 'failure toast must fire');

  // 会话已回收（404）⇒ 也必须收尾（此前只写状态行、继续静默轮询）
  const gone = makeSandbox();
  gone.openFreeHub();
  await ticks(4);
  await gone.jethubAddAccount('loomy');
  await ticks(2);
  await gone.jethubLoginConfirm('loomy');
  await ticks(1);
  gone.__setStatusResponse({ error: 'unknown or settled loginId' });
  await gone.__calls.intervals[0][0]();
  assert.strictEqual(gone.document.getElementById('modal-overlay').innerHTML, '', 'a reaped session must close the modal');
  assert.ok(gone.__calls.toast.some(([m]) => m === 'freeHubLoginGone'), 'the user needs an explicit "session ended" hint');
  assert.ok(gone.__calls.cleared.length > 0, 'polling a reaped session must stop');
});

checkAsync('③ login dialog: browser/session axes ride the login RPC; reopen goes through the server', async () => {
  const ctx = makeSandbox();
  ctx.openFreeHub();
  await ticks(4);
  await ctx.jethubAddAccount('loomy');
  await ticks(2);
  const overlay = ctx.document.getElementById('modal-overlay');
  // Step 1 renders both axes with the PROJECT custom-select component (a bare
  // native <select> is the reported regression).
  assert.ok(overlay.innerHTML.indexOf('custom-select-wrapper') !== -1, 'the dialog must use .custom-select-wrapper');
  assert.ok(overlay.innerHTML.indexOf('custom-select-trigger') !== -1, 'the dialog must use the project trigger');
  assert.ok(overlay.innerHTML.indexOf('custom-select-menu') !== -1, 'the dialog must use the project menu');
  assert.ok(overlay.innerHTML.indexOf('<select class="input"') === -1, 'no bare native dropdown in the dialog');
  assert.ok(overlay.innerHTML.indexOf('onchange="__jethubSyncLoginForm()"') !== -1, 'the pickers must dispatch into the sync handler');
  assert.ok(overlay.innerHTML.indexOf('free-hub-login-browser') !== -1, 'the dialog must offer the browser axis');
  assert.ok(overlay.innerHTML.indexOf('free-hub-login-session') !== -1, 'the dialog must offer the session axis');
  assert.ok(overlay.innerHTML.indexOf('value="edge" selected') !== -1, 'the remembered browser must be pre-selected');
  assert.ok(overlay.innerHTML.indexOf('value="isolated" selected') !== -1, 'the remembered session must be pre-selected');
  assert.ok(overlay.innerHTML.indexOf('Microsoft Edge') !== -1, 'detected browsers must be listed');
  // ⚠️ Nothing may be created before the user confirms: the server opens the
  // page while creating the placeholder, so the choice must precede the RPC.
  assert.strictEqual(ctx.__calls.apiPost.length, 0, 'no login RPC before confirming the dialog');

  // Cancel at the choose step: no account exists yet ⇒ no API call at all.
  ctx.document.getElementById('free-hub-login-cancel').onclick();
  assert.strictEqual(ctx.__calls.apiDelete.length, 0, 'cancelling the choose step must not delete anything');
  assert.strictEqual(overlay.innerHTML, '', 'cancelling closes the dialog');

  // Step 2: the axes are sent with the login RPC, then the dialog waits.
  await ctx.jethubAddAccount('loomy');
  await ticks(2);
  ctx.document.getElementById('free-hub-login-browser').value = 'edge';
  ctx.document.getElementById('free-hub-login-session').value = 'private';
  await ctx.jethubLoginConfirm('loomy');
  await ticks(1);
  const login = ctx.__calls.apiPost[0];
  assert.strictEqual(login[0], '/jethub/loomy/login');
  assert.strictEqual(JSON.stringify(login[1]), JSON.stringify({ browser: 'edge', browserPath: '', session: 'private' }));
  assert.ok(overlay.innerHTML.indexOf('free-hub-login-status') !== -1, 'the waiting step shows the status line');
  assert.strictEqual(ctx.__calls.intervals.length, 1, 'the waiting step polls');

  // Reopen must go through the SERVER with the same selection: a plain
  // <a target="_blank"> would be opened by the UI host, ignoring the choice.
  await ctx.document.getElementById('free-hub-login-reopen').onclick();
  const reopen = ctx.__calls.apiPost.find(([p]) => p === '/jethub/open-login-url');
  assert.ok(reopen, 'reopen must call the server endpoint');
  assert.strictEqual(reopen[1].browser, 'edge');
  assert.strictEqual(reopen[1].session, 'private');
  assert.strictEqual(reopen[1].url, 'http://127.0.0.1/free-hub-loomy-login.html?loginId=L1');

  // Private mode is only offered when the engine's switch is known (an unknown
  // fork would silently open a NORMAL window — the measured Edge --incognito trap).
  assert.strictEqual(ctx.__jethubLoginPrivateOk({ def: {}, browsers: [] }, 'default'), false);
  assert.strictEqual(ctx.__jethubLoginPrivateOk({ def: { privateOk: true }, browsers: [] }, 'default'), true);
  assert.strictEqual(ctx.__jethubLoginPrivateOk({ def: {}, browsers: [{ id: 'x', privateOk: false }] }, 'x'), false);
  assert.strictEqual(ctx.__jethubLoginPrivateOk({ def: {}, browsers: [{ id: 'edge', privateOk: true }] }, 'edge'), true);
  assert.strictEqual(ctx.__jethubLoginPrivateOk({ def: {}, browsers: [] }, 'custom'), true,
    'a custom path is classified by the server (it owns the engine table)');
});

checkAsync('④ model list: `name · rate` then bare id, prefix-qualified copy, batch delete + restore defaults', async () => {
  const ctx = makeSandbox();
  ctx.openFreeHub();
  await ticks(6);
  let html = ctx.document.getElementById('free-hub-detail').innerHTML;
  assert.ok(html.indexOf('free-hub-model-row') !== -1, 'vertical model rows');
  // 展示形态与插件一致：一条 `模型名称 · 倍率`，紧跟着裸 id（顺序 = 插件
  // ModelToggle 的 <strong>{name}</strong><code>{id}</code>）。
  assert.ok(html.indexOf('Auto · x0.5') !== -1, 'the rate is part of the display name (plugin form)');
  assert.ok(html.indexOf('Qwen3.8-Flash · 免费') !== -1, 'free models render `名称 · 免费`');
  assert.ok(html.indexOf('free-hub-model-rate') === -1, 'the separate rate chip is gone (one display string, like the plugin)');
  assert.ok(html.indexOf('已隐藏') !== -1, 'hidden badge for blacklisted model');
  assert.ok(html.indexOf('恢复默认') !== -1, 'restore-defaults button');
  // 模型 id 复制的是 `{prefix}/{id}`（= Settings provider detail 里点模型 id
  // 得到的同一个值，可直接用于外部调用）。
  const copyCall = (html.match(/copyToClipboard\('([^']*)'\)/g) || []);
  assert.ok(copyCall.indexOf("copyToClipboard('qd/auto')") !== -1, 'copy must be prefix-qualified (qd/auto), got ' + JSON.stringify(copyCall));
  assert.ok(copyCall.indexOf("copyToClipboard('qd/qfmodel')") !== -1, 'copy must be prefix-qualified (qd/qfmodel)');
  assert.ok(copyCall.length === 2, 'exactly one copy action per model row, got ' + copyCall.length);
  assert.ok(html.indexOf('>auto<') !== -1, 'the displayed text stays the bare model id');
  // 未设前缀（未桥接）的 provider：退回裸 id（无从调用，不编造前缀）
  const loomy = makeSandbox();
  loomy.openFreeHub();
  await ticks(6);
  loomy.jethubSelect('loomy');
  await ticks(4);
  const loomyHtml = loomy.document.getElementById('free-hub-detail').innerHTML;
  assert.ok(loomyHtml.indexOf("copyToClipboard('auto')") !== -1, 'no prefix → copy the bare id, got ' + JSON.stringify(loomyHtml.match(/copyToClipboard\('([^']*)'\)/g)));
  // batch manage: enter → select → delete selected (the re-render targets the
  // section element directly, which in this sandbox lives in the registry)
  await ctx.jethubToggleBatchMode();
  const sectionEl = ctx.__registry['free-hub-models-section'];
  assert.ok(sectionEl && sectionEl.innerHTML.indexOf('批量管理') !== -1, 'batch mode re-rendered the section');
  const barEl = ctx.__registry['free-hub-batch-bar'];
  assert.ok(barEl && barEl.innerHTML.indexOf('删除所选') !== -1, 'batch bar rendered');
  ctx.jethubBatchToggle('auto');
  await ctx.jethubBatchDeleteSelected('qoder');
  const batch = ctx.__calls.apiPost.find(([p]) => p === '/jethub/providers/qoder/models/batch-delete');
  assert.ok(batch && JSON.stringify(batch[1]) === JSON.stringify({ modelIds: ['auto'] }), 'batch delete POST body');
  // restore defaults
  await ctx.jethubRestoreDefaultModels('qoder');
  const restore = ctx.__calls.apiDelete.find((p) => p === '/jethub/providers/qoder/models');
  assert.ok(restore, 'restore-defaults DELETE clears the blacklist');
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
    permanentLocks: { loomy: true },
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
