// ===================== Free Hub (jethub) management UI (P4/P6 rework) ========
// Vanilla JS, no framework. Mounted INSIDE the Settings layout: the settings
// left sidebar stays visible and only the main (right) area is replaced by
// the header + left-pane|right-pane layout. closeFreeHub() restores the
// settings view; navigateTo() closes it on page switches (app-router.js).
//
// Right pane sections: ① call prefix → ② action row (刷新积分 / 一键领取积分 /
// 重测所有 / 重置所有 / 锁定|解锁永久积分 / + 新建账号 — capability-gated like
// the original plugin) → ③ notice area → ④ account cards (凭据/有效期/积分 +
// 限额重置 chips + per-card buttons) → ⑤ model list (vertical rows, batch
// manage, restore-defaults, alias + rate display).
// All state goes through /api/jethub RPCs; backup payloads are assembled by
// the server and encrypted/decrypted in the browser (PBKDF2 310000 + AES-GCM
// — original Jet Hub compatible shell, §1.5).

var __jethubActive = false;
var __jethubState = {
  providers: [], selected: null, accounts: [], models: [],
  credits: {}, creditsLoading: false,
  modelBatch: false, modelSelected: {},
  pollTimer: null,
};

function openFreeHub() {
  __jethubOpenFreeHubAsync();
}

// __jethubOpenFreeHubAsync: the mount path may need to re-render the settings
// page first (renderEndpoint is async), so the real work lives here.
async function __jethubOpenFreeHubAsync() {
  var page = document.getElementById('page-content');
  if (!page) return;
  // Robust re-entry: if a previous Free Hub session was orphaned (its DOM
  // was wiped by a page switch), tear the stale state down and remount.
  if (__jethubActive) closeFreeHub();
  var layout = page.querySelector('.settings-layout');
  if (!layout && typeof renderEndpoint === 'function') {
    try { await renderEndpoint(page); } catch (e) { /* fall through */ }
    layout = page.querySelector('.settings-layout');
  }
  if (!layout) return;
  var right = layout.querySelector('.settings-panel-right');
  var root = document.getElementById('free-hub-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'free-hub-root';
    root.className = 'free-hub-main';
    if (right) {
      right.style.display = 'none'; // only the main area is replaced
      if (right.nextSibling) layout.insertBefore(root, right.nextSibling);
      else layout.appendChild(root);
    } else {
      layout.appendChild(root);
    }
  }
  __jethubActive = true;
  __jethubMount(root);
}

function closeFreeHub() {
  if (!__jethubActive) return;
  __jethubActive = false;
  if (__jethubState.pollTimer) { clearInterval(__jethubState.pollTimer); __jethubState.pollTimer = null; }
  var root = document.getElementById('free-hub-root');
  if (root) root.remove();
  var page = document.getElementById('page-content');
  var right = page && page.querySelector('.settings-panel-right');
  if (right) right.style.display = '';
}

async function __jethubMount(root) {
  root.innerHTML = '<div class="free-hub"><div class="free-hub-loading">' + escapeHtml(t('loading')) + '</div></div>';
  try {
    var data = await apiGet('/jethub/providers');
    __jethubState.providers = data.providers || [];
    __jethubState.selected = null;
    __jethubRenderShell(root);
    var first = __jethubState.providers.find(function(p) { return p.accountCount > 0; }) || __jethubState.providers[0];
    if (first) jethubSelect(first.id);
  } catch (e) {
    if (typeof console !== 'undefined' && console.error) console.error('free hub mount failed:', e);
    var loading = root.querySelector('.free-hub-loading');
    if (loading) loading.textContent = t('failed', [e.message]);
  }
}

function __jethubRenderShell(root) {
  // Header: ALL action buttons left-aligned (claim all / backup / restore /
  // close) — the original plugin's header row is also a plain left group.
  root.innerHTML =
    '<div class="free-hub">' +
      '<div class="free-hub-header">' +
        '<button type="button" class="btn btn-sm" onclick="jethubClaimAll()">' + escapeHtml(t('freeHubCheckinAll')) + '</button>' +
        '<button type="button" class="btn btn-sm" onclick="jethubBackup()">' + escapeHtml(t('freeHubBackup')) + '</button>' +
        '<button type="button" class="btn btn-sm" onclick="jethubRestorePick()">' + escapeHtml(t('freeHubRestore')) + '</button>' +
        '<button type="button" class="btn btn-sm btn-danger" onclick="closeFreeHub()">' + escapeHtml(t('freeHubClose')) + '</button>' +
      '</div>' +
      '<div class="free-hub-body">' +
        '<div class="free-hub-left" id="free-hub-providers"></div>' +
        '<div class="free-hub-right" id="free-hub-detail"></div>' +
      '</div>' +
    '</div>';
  __jethubRenderProviders();
}

function __jethubRenderProviders() {
  var el = document.getElementById('free-hub-providers');
  if (!el) return;
  el.innerHTML = __jethubState.providers.map(function(p) {
    return '<div class="free-hub-provider' + (p.id === __jethubState.selected ? ' selected' : '') + '"' +
      ' onclick="jethubSelect(\'' + escapeForJsString(p.id) + '\')">' +
      '<span class="free-hub-provider-name">' + escapeHtml(p.displayName) + '</span>' +
      '<span class="badge ' + (p.accountCount > 0 ? 'badge-active' : 'badge-inactive') + '">' + p.accountCount + '</span>' +
      '</div>';
  }).join('');
}

async function jethubSelect(providerId) {
  var providerChanged = __jethubState.selected !== providerId;
  __jethubState.selected = providerId;
  if (providerChanged) {
    __jethubState.credits = {};
    __jethubState.modelBatch = false;
    __jethubState.modelSelected = {};
  }
  __jethubRenderProviders();
  var detail = document.getElementById('free-hub-detail');
  if (!detail) return;
  detail.innerHTML = '<div class="free-hub-loading">' + escapeHtml(t('loading')) + '</div>';
  var provider = __jethubState.providers.find(function(p) { return p.id === providerId; }) || {};
  try {
    var accountsData = await apiGet('/jethub/providers/' + encodeURIComponent(providerId) + '/accounts');
    __jethubState.accounts = accountsData.accounts || [];
    var modelsData = { models: [] };
    try { modelsData = await apiGet('/jethub/providers/' + encodeURIComponent(providerId) + '/models'); } catch (e) {}
    __jethubState.models = modelsData.models || [];
    __jethubRenderDetail(provider);
    // Credits load in the background like the original (cards show … then fill).
    if (provider.hasBalance) __jethubLoadCredits(provider);
  } catch (e) {
    detail.innerHTML = '<div class="free-hub-loading">' + escapeHtml(t('failed', [e.message])) + '</div>';
  }
}

function __jethubRenderDetail(provider) {
  var detail = document.getElementById('free-hub-detail');
  if (!detail) return;
  var prefix = provider.prefix || '';
  detail.innerHTML =
    // ① prefix
    '<div class="free-hub-section"><div class="free-hub-section-title">' + escapeHtml(t('freeHubPrefixTitle')) + '</div>' +
      '<div class="free-hub-prefix-row">' +
        '<input type="text" class="input" id="free-hub-prefix-input" value="' + escapeAttr(prefix) + '" placeholder="e.g. ' + escapeAttr(provider.id) + '" data-tooltip="' + escapeAttr(t('freeHubPrefixHint')) + '">' +
        '<button type="button" class="btn btn-primary btn-sm" onclick="jethubSavePrefix(\'' + escapeForJsString(provider.id) + '\')">' + escapeHtml(t('freeHubPrefixSave')) + '</button>' +
        (provider.bridged ? '<button type="button" class="btn btn-sm" onclick="jethubClearPrefix(\'' + escapeForJsString(provider.id) + '\')">' + escapeHtml(t('freeHubPrefixClear')) + '</button>' : '') +
      '</div>' +
      '<div class="free-hub-hint">' + escapeHtml(t('freeHubPrefixHint')) + '</div>' +
    '</div>' +
    // ② action row (capability-gated like the original panel header)
    '<div class="free-hub-section"><div class="free-hub-actions" id="free-hub-actions">' +
      __jethubActionButtons(provider) +
    '</div></div>' +
    // ③ notice area (retest / reset / claim / lock results)
    '<div id="free-hub-notice"></div>' +
    // ④ account cards
    '<div class="free-hub-section"><div class="free-hub-section-title">' + escapeHtml(t('freeHubAccountsTitle')) + '</div>' +
      '<div id="free-hub-accounts" class="free-hub-accounts">' + __jethubRenderAccounts(provider) + '</div>' +
    '</div>' +
    // ⑤ models
    '<div class="free-hub-section" id="free-hub-models-section">' + __jethubModelsSection(provider) + '</div>';
}

// __jethubActionButtons: 刷新积分 / 一键领取积分 / 重测所有 / 重置所有 /
// 解锁|锁定永久积分 / + 新建账号 / Use Proxy 开关 — same order and gating as
// the original dim-jh-headerActions row; the proxy toggle sits right of
// + 新建账号（per-provider: 登录/积分/推理出站走代理还是直连）.
function __jethubActionButtons(provider) {
  var pid = escapeForJsString(provider.id);
  var html = '';
  if (provider.hasBalance) {
    html += '<button type="button" class="btn btn-sm" onclick="jethubRefreshCredits(\'' + pid + '\')">' + escapeHtml(t('freeHubRefreshCredits')) + '</button>';
  }
  if (provider.hasCredits) {
    html += '<button type="button" class="btn btn-sm" onclick="jethubClaimAllProvider(\'' + pid + '\')">' + escapeHtml(t('freeHubClaimAll')) + '</button>';
  }
  if (provider.supportsRateLimit !== false) {
    html += '<button type="button" class="btn btn-sm" data-tooltip="' + escapeAttr(t('freeHubRetestAllHelp')) + '" onclick="jethubRetest(\'' + pid + '\', \'\')">' + escapeHtml(t('freeHubRetestAll')) + '</button>';
    html += '<button type="button" class="btn btn-sm" data-tooltip="' + escapeAttr(t('freeHubResetAllHelp')) + '" onclick="jethubReset(\'' + pid + '\', \'\')">' + escapeHtml(t('freeHubResetAll')) + '</button>';
  }
  if (provider.canLockPermanent) {
    html += '<button type="button" class="btn btn-sm' + (provider.permanentLocked ? ' btn-primary' : '') + '" onclick="jethubToggleLock(\'' + pid + '\')">' +
      escapeHtml(provider.permanentLocked ? t('freeHubUnlockPermanent') : t('freeHubLockPermanent')) + '</button>';
  }
  html += '<button type="button" class="btn btn-primary btn-sm" onclick="jethubAddAccount(\'' + pid + '\')">' + escapeHtml(t('freeHubNewAccount')) + '</button>';
  // Use Proxy toggle（项目自定义 toggle-switch 样式，同 Upstream Proxy /
  // Provider 详情 useProxy——标签在开关左侧，复用全局 .toggle-switch 不动其
  // 堆叠规则）：per-provider 登录/积分/推理出站走代理还是直连。
  var on = provider.proxyEnabled === true;
  html += '<span class="free-hub-proxy-wrap">' +
    '<span class="free-hub-proxy-label" data-tooltip="' + escapeAttr(t('freeHubUseProxyHint')) + '">' + escapeHtml(t('freeHubUseProxy')) + '</span>' +
    '<label class="toggle-switch" data-tooltip="' + escapeAttr(t('freeHubUseProxyHint')) + '">' +
      '<input type="checkbox" onchange="jethubToggleProxy(\'' + pid + '\', this.checked)"' + (on ? ' checked' : '') + '>' +
      '<span class="toggle-slider"></span>' +
    '</label>' +
    '</span>';
  return html;
}

// jethubToggleProxy PUT /jethub/providers/{provider}/proxy — 登录/积分/推理
// 出站的 per-provider 代理开关；桥接 provider 的 UseProxy 由后端 SyncKeys
// 一并写入。⚠️ 路径必须带 `providers/` 段（与 prefix/permanent-lock 同形），
// 漏掉会命中 chi 的 404 page not found（非 JSON 体 → 前端显示 HTTP 404）。
async function jethubToggleProxy(providerId, enabled) {
  try {
    var r = await apiPut('/jethub/providers/' + encodeURIComponent(providerId) + '/proxy', { enabled: !!enabled });
    if (r.error) throw new Error(r.error);
    var p = __jethubState.providers.find(function(x) { return x.id === providerId; });
    if (p) p.proxyEnabled = !!enabled;
    toast(enabled ? t('freeHubProxyOn') : t('freeHubProxyOff'), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
    jethubSelect(__jethubState.selected); // revert the checkbox to stored state
  }
}

// __jethubNotice shows the result of a batch action with a per-item details
// list (原版 dim-jh-probeNotice / dim-jh-probeDetails).
function __jethubSetNotice(notice) {
  var el = document.getElementById('free-hub-notice');
  if (!el) return;
  if (!notice) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="free-hub-notice" data-tone="' + escapeAttr(notice.tone || '') + '">' +
    '<div>' + notice.text + '</div>' +
    ((notice.details || []).length
      ? '<ul class="free-hub-notice-details">' + notice.details.map(function(d) { return '<li>' + escapeHtml(d) + '</li>'; }).join('') + '</ul>'
      : '') +
    '</div>';
}

// ---------- accounts ----------

function __jethubRenderAccounts(provider) {
  if (__jethubState.accounts.length === 0) {
    return '<div class="free-hub-hint">' + escapeHtml(t('freeHubNoAccounts')) + '</div>';
  }
  return __jethubState.accounts.map(function(a) {
    return __jethubAccountCard(provider, a);
  }).join('');
}

function __jethubAccountCard(provider, a) {
  var now = Date.now();
  var expired = a.expiresAt && a.expiresAt > 0 && a.expiresAt <= now;
  var expires = a.expiresAt
    ? __jethubFormatTime(a.expiresAt) + (a.refreshable ? ' · ' + t('freeHubAutoRenew') : '')
    : t('freeHubUnknown');
  var badges = '<span class="badge ' + (a.enabled ? 'badge-active' : 'badge-inactive') + '">' + (a.enabled ? t('enable') : t('disable')) + '</span>';
  if (!a.hasCredential) {
    // 占位账号（登录未完成/失败残留）：凭据从未落盘，无法使用。
    badges += '<span class="badge badge-inactive">' + escapeHtml(t('freeHubNoCredential')) + '</span>';
  } else {
    badges += '<span class="badge badge-active">key</span>';
  }
  if (a.refreshable) badges += '<span class="badge badge-active">refresh</span>';

  // 限额重置 chips: only future markers are displayed, but ANY marker (even
  // expired) enables the retest/reset buttons (原版 hasAnyLimit 语义).
  var chips = '';
  var hasAnyLimit = false;
  var limits = a.modelRateLimits || {};
  Object.keys(limits).forEach(function(mid) {
    if (mid.indexOf('__') === 0) return; // internal bookkeeping keys
    hasAnyLimit = true;
    if (limits[mid] > now) {
      chips += '<span class="free-hub-rate-chip" data-tooltip="' + escapeAttr(t('freeHubRateLimitReset') + ': ' + mid) + '">' +
        escapeHtml(mid) + ' · ' + escapeHtml(__jethubFormatTime(limits[mid])) + '</span>';
    }
  });

  var pid = escapeForJsString(provider.id);
  var aid = escapeForJsString(a.id);
  var showRateActions = provider.supportsRateLimit !== false;
  var buttons = '';
  if (showRateActions && hasAnyLimit) {
    buttons += '<button type="button" class="btn btn-sm" data-tooltip="' + escapeAttr(t('freeHubRetestHelp')) + '" onclick="jethubRetest(\'' + pid + '\', \'' + aid + '\')">' + escapeHtml(t('freeHubRetest')) + '</button>';
    buttons += '<button type="button" class="btn btn-sm" data-tooltip="' + escapeAttr(t('freeHubResetHelp')) + '" onclick="jethubReset(\'' + pid + '\', \'' + aid + '\')">' + escapeHtml(t('freeHubReset')) + '</button>';
  }
  if (provider.hasCredits && a.enabled && a.hasCredential) {
    buttons += '<button type="button" class="btn btn-sm" onclick="jethubClaim(\'' + pid + '\', \'' + aid + '\')">' + escapeHtml(t('freeHubClaim')) + '</button>';
  }
  if (a.refreshable) {
    buttons += '<button type="button" class="btn btn-sm" onclick="jethubRefreshAccount(\'' + aid + '\')">' + escapeHtml(t('freeHubRefresh')) + '</button>';
  }
  buttons += '<button type="button" class="btn btn-sm" onclick="jethubRenameAccount(\'' + aid + '\')">' + escapeHtml(t('freeHubRename')) + '</button>';
  buttons += '<button type="button" class="btn btn-sm" onclick="jethubToggleAccount(\'' + aid + '\')">' + escapeHtml(a.enabled ? t('disable') : t('enable')) + '</button>';
  buttons += '<button type="button" class="btn btn-sm btn-danger" onclick="jethubDeleteAccount(\'' + aid + '\')">' + escapeHtml(t('delete')) + '</button>';

  return '<div class="free-hub-account" data-enabled="' + (a.enabled ? '1' : '0') + '">' +
    '<div class="free-hub-account-row">' +
      '<span class="free-hub-dot' + (a.enabled ? ' on' : '') + '"></span>' +
      '<span class="free-hub-account-name">' + escapeHtml(a.nickname || a.id) + '</span>' + badges +
    '</div>' +
    '<div class="free-hub-account-meta">' +
      '<div class="free-hub-meta-row"><span class="free-hub-meta-label">' + escapeHtml(t('freeHubCredential')) + '</span>' +
        '<code class="code">' + escapeHtml(a.credentialRef || '-') + '</code></div>' +
      '<div class="free-hub-meta-row"><span class="free-hub-meta-label">' + escapeHtml(t('freeHubExpires')) + '</span>' +
        '<span' + (expired ? ' class="free-hub-expired"' : '') + '>' + escapeHtml(expires) + '</span></div>' +
      (provider.hasBalance
        ? '<div class="free-hub-meta-row"><span class="free-hub-meta-label">' + escapeHtml(t('freeHubCreditsLabel')) + '</span>' +
            '<span id="free-hub-credit-' + __jethubSanitizeId(a.id) + '">' + __jethubCreditCellHtml(a.id) + '</span></div>'
        : '') +
    '</div>' +
    (chips ? '<div class="free-hub-rate-chips"><span class="free-hub-rate-chips-label">' + escapeHtml(t('freeHubRateLimitReset')) + '</span>' + chips + '</div>' : '') +
    '<div class="free-hub-account-actions">' + buttons + '</div>' +
    '</div>';
}

function __jethubCreditCellHtml(accountId) {
  var c = __jethubState.credits[accountId];
  if (!c || c.loading) return '<span class="free-hub-hint">…</span>';
  if (c.error) return '<span class="free-hub-credit-error">' + escapeHtml(t('freeHubCreditFailed')) + '</span>';
  if (c.total === null || c.total === undefined) return '<span class="free-hub-credit-error">' + escapeHtml(t('freeHubCreditFailed')) + '</span>';
  return '<span class="free-hub-credit-total">' + escapeHtml(__jethubFormatNumber(c.total)) + '</span>';
}

function __jethubUpdateCreditCell(accountId) {
  var el = document.getElementById('free-hub-credit-' + __jethubSanitizeId(accountId));
  if (el) el.innerHTML = __jethubCreditCellHtml(accountId);
}

// __jethubLoadCredits queries the balance of every account that holds a
// credential (disabled included — the original does the same), updating each
// card incrementally.
async function __jethubLoadCredits(provider) {
  if (!provider || !provider.hasBalance || __jethubState.creditsLoading) return;
  __jethubState.creditsLoading = true;
  var pid = provider.id;
  var accounts = __jethubState.accounts.filter(function(a) { return a.hasCredential; });
  accounts.forEach(function(a) {
    __jethubState.credits[a.id] = { loading: true };
    __jethubUpdateCreditCell(a.id);
  });
  for (var i = 0; i < accounts.length; i++) {
    var a = accounts[i];
    try {
      var data = await apiGet('/jethub/' + encodeURIComponent(pid) + '/balance?accountId=' + encodeURIComponent(a.id));
      __jethubState.credits[a.id] = { total: __jethubBalanceTotal(data.balance) };
    } catch (e) {
      __jethubState.credits[a.id] = { error: e.message };
    }
    if (__jethubState.selected !== pid) { __jethubState.creditsLoading = false; return; } // provider switched away
    __jethubUpdateCreditCell(a.id);
  }
  __jethubState.creditsLoading = false;
}

async function jethubRefreshCredits(providerId) {
  var provider = __jethubState.providers.find(function(p) { return p.id === providerId; });
  if (!provider) return;
  __jethubState.creditsLoading = false; // allow a fresh run
  __jethubSetNotice({ tone: 'info', text: t('freeHubCreditsLoading') });
  await __jethubLoadCredits(provider);
  __jethubSetNotice(null);
}

// balance DTO shape varies per provider; normalize the total defensively
// (packages[].remaining when present, else total, else null).
function __jethubBalanceTotal(balance) {
  if (!balance) return null;
  if (typeof balance.total !== 'undefined' && balance.total !== null) return balance.total;
  var total = 0, any = false;
  var packages = balance.packages || [];
  packages.forEach(function(p) {
    var v = Number(p.remaining !== undefined ? p.remaining : p.value);
    if (!isNaN(v)) { total += v; any = true; }
  });
  return any ? total : null;
}

// __jethubFormatNumber: two decimals for fractional credit values (服务端精确
// 值是两位, e.g. 247.87), plain integer otherwise (原版 formatCredits).
function __jethubFormatNumber(value) {
  var n = Number(value);
  if (!isFinite(n)) return String(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// __jethubFormatTime mirrors the original formatTime: 已过期 / X 分钟后 /
// X 小时后 / localized date.
function __jethubFormatTime(ts) {
  if (!ts || ts <= 0) return t('freeHubUnknown');
  var d = new Date(ts);
  var now = Date.now();
  if (ts <= now) return t('freeHubExpired');
  var diff = ts - now;
  if (diff < 3600000) return t('freeHubInMinutes', [String(Math.round(diff / 60000))]);
  if (diff < 86400000) return t('freeHubInHours', [String(Math.round(diff / 3600000))]);
  try { return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return d.toLocaleString(); }
}

function __jethubSanitizeId(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ---------- action row: claim all / retest / reset / lock ----------

// jethubClaimAllProvider: 一键领取当前 provider 全部已启用账号的每日签到积分。
async function jethubClaimAllProvider(providerId) {
  var accounts = __jethubState.accounts.filter(function(a) { return a.enabled && a.hasCredential; });
  if (accounts.length === 0) { toast(t('freeHubNoAccounts'), 'warning'); return; }
  __jethubSetNotice({ tone: 'info', text: t('freeHubClaimRunning') });
  var ok = 0, fail = 0, details = [];
  for (var i = 0; i < accounts.length; i++) {
    var a = accounts[i];
    try {
      await apiPost('/jethub/' + encodeURIComponent(providerId) + '/claim', { accountId: a.id });
      ok++;
    } catch (e) {
      fail++;
      details.push((a.nickname || a.id) + ': ' + e.message);
    }
  }
  __jethubSetNotice({
    tone: fail > 0 ? 'warn' : 'ok',
    text: t('freeHubClaimDone', [String(ok), String(fail)]),
    details: details,
  });
  var provider = __jethubState.providers.find(function(p) { return p.id === providerId; });
  if (provider && provider.hasBalance) { __jethubState.creditsLoading = false; await __jethubLoadCredits(provider); }
}

async function jethubRetest(providerId, accountId) {
  if (!accountId) {
    var okgo = await confirmModal(t('freeHubRetestConfirm'));
    if (!okgo) return;
  }
  __jethubSetNotice({ tone: 'info', text: t('freeHubRetestRunning') });
  try {
    var res = await apiPost('/jethub/' + encodeURIComponent(providerId) + '/ratelimits/retest', { accountId: accountId || '' });
    var details = [];
    (res.accounts || []).forEach(function(a) {
      (a.stillLimited || []).forEach(function(m) {
        details.push((a.nickname || a.accountId) + ' · ' + m.modelId + ': ' + (m.message || t('freeHubStillLimited')));
      });
    });
    var still = 0;
    (res.accounts || []).forEach(function(a) { still += (a.stillLimited || []).length; });
    var text = (res.clearedCount > 0 || still > 0)
      ? t('freeHubRetestDone', [String(res.clearedCount || 0), String(still)])
      : t('freeHubRetestNone');
    __jethubSetNotice({ tone: still > 0 ? 'warn' : 'ok', text: text, details: details });
  } catch (e) {
    __jethubSetNotice({ tone: 'error', text: t('failed', [e.message]) });
  }
  await jethubSelect(providerId);
}

async function jethubReset(providerId, accountId) {
  __jethubSetNotice({ tone: 'info', text: t('freeHubResetRunning') });
  try {
    var res = await apiPost('/jethub/' + encodeURIComponent(providerId) + '/ratelimits/reset', { accountId: accountId || '' });
    __jethubSetNotice({
      tone: 'ok',
      text: res.clearedCount > 0 ? t('freeHubResetDone', [String(res.clearedCount)]) : t('freeHubResetNone'),
    });
  } catch (e) {
    __jethubSetNotice({ tone: 'error', text: t('failed', [e.message]) });
  }
  await jethubSelect(providerId);
}

async function jethubToggleLock(providerId) {
  var provider = __jethubState.providers.find(function(p) { return p.id === providerId; }) || {};
  var next = !provider.permanentLocked;
  try {
    await apiPut('/jethub/providers/' + encodeURIComponent(providerId) + '/permanent-lock', { locked: next });
    provider.permanentLocked = next;
    __jethubSetNotice({ tone: 'ok', text: next ? t('freeHubLockOn') : t('freeHubLockOff') });
    var actions = document.getElementById('free-hub-actions');
    if (actions) actions.innerHTML = __jethubActionButtons(provider);
  } catch (e) {
    __jethubSetNotice({ tone: 'error', text: t('failed', [e.message]) });
  }
}

// ---------- prefix ----------

async function jethubSavePrefix(providerId) {
  var input = document.getElementById('free-hub-prefix-input');
  var prefix = (input && input.value || '').trim();
  if (!/^[a-z0-9-]{1,32}$/.test(prefix)) {
    toast(t('freeHubPrefixInvalid'), 'error');
    return;
  }
  try {
    await apiPut('/jethub/providers/' + encodeURIComponent(providerId) + '/prefix', { prefix: prefix });
    var provider = __jethubState.providers.find(function(p) { return p.id === providerId; });
    if (provider) { provider.prefix = prefix; provider.bridged = true; }
    toast(t('freeHubPrefixSaved', [prefix, '<modelID>']), 'success');
    __jethubRenderDetail(provider);
  } catch (e) {
    toast(t('failed', [e.message]), 'error'); // 409 conflict surfaces here
  }
}

async function jethubClearPrefix(providerId) {
  if (!(await confirmModal(t('freeHubPrefixClear') + '?'))) return;
  try {
    await apiDelete('/jethub/providers/' + encodeURIComponent(providerId) + '/prefix');
    var provider = __jethubState.providers.find(function(p) { return p.id === providerId; });
    if (provider) { provider.prefix = ''; provider.bridged = false; }
    toast(t('freeHubPrefixCleared'), 'success');
    __jethubRenderDetail(provider);
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

// ---------- account login / CRUD ----------

async function jethubAddAccount(providerId) {
  var provider = __jethubState.providers.find(function(p) { return p.id === providerId; }) || {};
  if ((provider.loginModes || []).indexOf('sms') !== -1) {
    // SMS 流程没有服务端 login session：先创建占位账号，验证码提交时才能
    // 绑定凭据。用户取消时删除占位（不留无凭据的死账号）。
    try {
      var created = await apiPost('/jethub/' + encodeURIComponent(providerId) + '/accounts', {});
      if (created.error) { toast(t('failed', [created.error]), 'error'); return; }
      __jethubSmsModal(providerId, created.accountId);
    } catch (e) {
      toast(t('failed', [e.message]), 'error');
    }
    return;
  }
  // url / qr modes share the URL + poll modal (qr providers hand back the
  // login page URL the same way).
  try {
    var started = await apiPost('/jethub/' + encodeURIComponent(providerId) + '/login', {});
    if (started.error) { toast(t('failed', [started.error]), 'error'); return; }
    __jethubLoginModal(providerId, started);
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

function __jethubLoginModal(providerId, created) {
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  overlay.innerHTML =
    '<div class="modal" style="max-width:480px;">' +
      '<div class="modal-title">' + escapeHtml(t('freeHubLoginTitle')) + '</div>' +
      '<div class="modal-body" style="margin-top:12px;">' +
        '<div class="free-hub-hint">' + escapeHtml(t('freeHubLoginHint')) + '</div>' +
        '<a class="free-hub-login-link" href="' + escapeAttr(created.loginUrl || '') + '" target="_blank" rel="noopener">' + escapeHtml(t('freeHubLoginOpen')) + '</a>' +
        '<div id="free-hub-login-status" class="free-hub-hint">' + escapeHtml(t('freeHubLoginWaiting')) + '</div>' +
      '</div>' +
      '<div class="modal-footer"><button type="button" class="btn btn-ghost" id="free-hub-login-cancel">' + escapeHtml(t('cancel')) + '</button></div>' +
    '</div>';
  overlay.classList.add('show');
  // 取消 = 放弃登录：停轮询 + 删除占位账号（服务端失败路径同样会删）。
  var stop = function() {
    if (__jethubState.pollTimer) { clearInterval(__jethubState.pollTimer); __jethubState.pollTimer = null; }
    overlay.classList.remove('show'); overlay.innerHTML = '';
    apiDelete('/jethub/accounts/' + encodeURIComponent(created.accountId)).then(function() {
      jethubSelect(providerId);
    }).catch(function() { jethubSelect(providerId); });
  };
  document.getElementById('free-hub-login-cancel').onclick = stop;
  var statusEl = document.getElementById('free-hub-login-status');
  __jethubState.pollTimer = setInterval(async function() {
    try {
      var st = await apiGet('/jethub/' + encodeURIComponent(providerId) + '/status?loginId=' + encodeURIComponent(created.loginId));
      if (st.error) { statusEl.textContent = st.error; return; } // settled & reaped (404): keep the last visible state
      if (st.done) {
        if (__jethubState.pollTimer) { clearInterval(__jethubState.pollTimer); __jethubState.pollTimer = null; }
        overlay.classList.remove('show'); overlay.innerHTML = '';
        if (st.success) {
          toast(t('freeHubLoginOk'), 'success');
        } else {
          toast(t('freeHubLoginFailed', [st.error || '']), 'error');
        }
        jethubSelect(providerId);
      }
    } catch (e) { /* transient poll failure: keep polling */ }
  }, 2000);
}

function __jethubSmsModal(providerId, accountId) {
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  overlay.innerHTML =
    '<div class="modal" style="max-width:420px;">' +
      '<div class="modal-title">' + escapeHtml(t('freeHubLoginTitle')) + '</div>' +
      '<div class="modal-body" style="margin-top:12px;">' +
        '<input type="text" class="input" id="free-hub-sms-phone" placeholder="' + escapeAttr(t('freeHubSmsPhone')) + '" style="width:100%">' +
        '<button type="button" class="btn btn-sm" id="free-hub-sms-send" style="margin-top:8px">' + escapeHtml(t('freeHubSmsSend')) + '</button>' +
        '<input type="text" class="input" id="free-hub-sms-code" placeholder="' + escapeAttr(t('freeHubSmsCode')) + '" style="width:100%;margin-top:8px">' +
      '</div>' +
      '<div class="modal-footer"><button type="button" class="btn btn-ghost" id="free-hub-sms-cancel">' + escapeHtml(t('cancel')) + '</button>' +
      '<button type="button" class="btn btn-primary" id="free-hub-sms-submit">' + escapeHtml(t('freeHubSmsSubmit')) + '</button></div>' +
    '</div>';
  overlay.classList.add('show');
  // 取消 = 放弃登录：删除占位账号（凭据从未落盘，留着也无法使用）。
  var close = function() {
    overlay.classList.remove('show'); overlay.innerHTML = '';
    apiDelete('/jethub/accounts/' + encodeURIComponent(accountId)).then(function() {
      jethubSelect(providerId);
    }).catch(function() { jethubSelect(providerId); });
  };
  document.getElementById('free-hub-sms-cancel').onclick = close;
  document.getElementById('free-hub-sms-send').onclick = async function() {
    try {
      await apiPost('/jethub/' + encodeURIComponent(providerId) + '/login/sms/send', { phone: document.getElementById('free-hub-sms-phone').value.trim() });
      toast(t('freeHubSmsSend'), 'success');
    } catch (e) { toast(t('failed', [e.message]), 'error'); }
  };
  document.getElementById('free-hub-sms-submit').onclick = async function() {
    try {
      await apiPost('/jethub/' + encodeURIComponent(providerId) + '/login/sms/submit', {
        accountId: accountId,
        phone: document.getElementById('free-hub-sms-phone').value.trim(),
        code: document.getElementById('free-hub-sms-code').value.trim(),
      });
      overlay.classList.remove('show'); overlay.innerHTML = '';
      toast(t('freeHubLoginOk'), 'success');
      jethubSelect(providerId);
    } catch (e) { toast(t('failed', [e.message]), 'error'); }
  };
}

async function jethubRenameAccount(accountId) {
  var acc = __jethubState.accounts.find(function(a) { return a.id === accountId; }) || {};
  var name = await promptModal(t('freeHubRename'), acc.nickname || acc.id);
  if (name === null) return;
  try {
    await apiPatch('/jethub/accounts/' + encodeURIComponent(accountId), { nickname: name });
    jethubSelect(__jethubState.selected);
  } catch (e) { toast(t('failed', [e.message]), 'error'); }
}

async function jethubToggleAccount(accountId) {
  var acc = __jethubState.accounts.find(function(a) { return a.id === accountId; }) || {};
  try {
    await apiPatch('/jethub/accounts/' + encodeURIComponent(accountId), { enabled: !acc.enabled });
    jethubSelect(__jethubState.selected);
  } catch (e) { toast(t('failed', [e.message]), 'error'); }
}

async function jethubDeleteAccount(accountId) {
  if (!(await confirmModal(accountId))) return;
  try {
    await apiDelete('/jethub/accounts/' + encodeURIComponent(accountId));
    jethubSelect(__jethubState.selected);
  } catch (e) { toast(t('failed', [e.message]), 'error'); }
}

async function jethubRefreshAccount(accountId) {
  try {
    await apiPost('/jethub/' + encodeURIComponent(__jethubState.selected) + '/refresh', { accountId: accountId });
    toast(t('freeHubRefreshed'), 'success');
    jethubSelect(__jethubState.selected);
  } catch (e) { toast(t('failed', [e.message]), 'error'); }
}

// ---------- models (vertical list + batch manage + restore defaults) ----------

function __jethubModelsSection(provider) {
  var models = __jethubState.models;
  var pid = escapeForJsString(provider.id);
  var html =
    '<div class="free-hub-models-head">' +
      '<span class="free-hub-section-title">' + escapeHtml(t('freeHubModelsTitle')) + ' (' + models.length + ')</span>' +
      '<button type="button" class="btn btn-sm" data-tooltip="' + escapeAttr(t('freeHubModelsHint')) + '" onclick="jethubRestoreDefaultModels(\'' + pid + '\')">' + escapeHtml(t('freeHubRestoreDefaults')) + '</button>' +
      '<button type="button" class="btn btn-sm" id="free-hub-batch-btn" onclick="jethubToggleBatchMode()">' + escapeHtml(t('freeHubBatchManage')) + '</button>' +
    '</div>' +
    '<div class="free-hub-models-hint">' + escapeHtml(t('freeHubModelsHint')) + '</div>' +
    '<div id="free-hub-batch-bar"></div>' +
    '<div id="free-hub-model-list" class="free-hub-model-list">' + __jethubModelRows(provider) + '</div>';
  return html;
}

function __jethubModelRows(provider) {
  var models = __jethubState.models;
  if (!models.length) {
    return '<div class="free-hub-hint">' + escapeHtml(t('freeHubModelsEmpty')) + '</div>';
  }
  var batch = __jethubState.modelBatch;
  var pid = escapeForJsString(provider.id);
  return models.map(function(m) {
    var mid = escapeHtml(m.id);
    var midJs = escapeForJsString(m.id);
    var selected = !!__jethubState.modelSelected[m.id];
    var cls = 'free-hub-model-row' + (m.disabled ? ' hidden-model' : '') + (batch && selected ? ' batch-selected' : '');
    var row =
      '<div class="' + cls + '" data-mid="' + mid + '">' +
        (batch ? '<input type="checkbox"' + (selected ? ' checked' : '') + ' onchange="jethubBatchToggle(\'' + midJs + '\')">' : '') +
        '<span class="free-hub-model-name" data-tooltip="' + escapeAttr(m.id) + '">' + escapeHtml(m.name || m.id) + '</span>' +
        (m.rate ? '<span class="free-hub-model-rate">' + escapeHtml(m.rate) + '</span>' : '') +
        '<span class="code free-hub-model-id copyable" onclick="copyToClipboard(\'' + midJs + '\', \'' + midJs + '\')" data-tooltip="' + escapeAttr(t('clickToCopy')) + '">' + mid + '</span>';
    if (m.disabled) {
      row += '<span class="badge badge-inactive">' + escapeHtml(t('freeHubHidden')) + '</span>' +
        '<button type="button" class="btn btn-sm" onclick="jethubSetModelHidden(\'' + pid + '\', \'' + midJs + '\', false)">' + escapeHtml(t('freeHubRestoreRow')) + '</button>';
    } else {
      row += '<button type="button" class="btn btn-sm btn-danger" onclick="jethubSetModelHidden(\'' + pid + '\', \'' + midJs + '\', true)">' + escapeHtml(t('delete')) + '</button>';
    }
    row += '</div>';
    return row;
  }).join('');
}

// __jethubRerenderModels redraws only the models section (prefix input, cards
// and credits stay untouched).
function __jethubRerenderModels() {
  var provider = __jethubState.providers.find(function(p) { return p.id === __jethubState.selected; });
  var section = document.getElementById('free-hub-models-section');
  if (!provider || !section) return;
  section.innerHTML = __jethubModelsSection(provider);
  if (__jethubState.modelBatch) __jethubRenderBatchBar(provider);
}

function __jethubRenderBatchBar(provider) {
  var bar = document.getElementById('free-hub-batch-bar');
  if (!bar) return;
  if (!__jethubState.modelBatch) { bar.innerHTML = ''; return; }
  var pid = escapeForJsString(provider.id);
  var models = __jethubState.models;
  var allSelected = models.length > 0 && models.every(function(m) { return __jethubState.modelSelected[m.id]; });
  bar.innerHTML =
    '<div class="free-hub-batch-bar">' +
      '<input id="free-hub-model-filter" class="input" placeholder="' + escapeAttr(t('freeHubFilterModels')) + '" style="width:140px" oninput="jethubModelFilter(this.value)">' +
      '<button type="button" class="btn btn-sm" onclick="jethubModelFilter(\'\')">' + escapeHtml(t('freeHubClearFilter')) + '</button>' +
      '<button type="button" class="btn btn-sm" onclick="jethubBatchSelectAll()">' + escapeHtml(allSelected ? t('freeHubDeselectAll') : t('freeHubSelectAll')) + '</button>' +
      '<button type="button" class="btn btn-sm btn-primary" onclick="jethubBatchDeleteSelected(\'' + pid + '\')">' + escapeHtml(t('freeHubBatchDelete')) + '</button>' +
      '<button type="button" class="btn btn-sm" onclick="jethubToggleBatchMode()">' + escapeHtml(t('cancel')) + '</button>' +
    '</div>';
}

async function jethubToggleBatchMode() {
  __jethubState.modelBatch = !__jethubState.modelBatch;
  __jethubState.modelSelected = {};
  __jethubRerenderModels();
}

function jethubBatchToggle(modelId) {
  if (__jethubState.modelSelected[modelId]) delete __jethubState.modelSelected[modelId];
  else __jethubState.modelSelected[modelId] = true;
  var provider = __jethubState.providers.find(function(p) { return p.id === __jethubState.selected; });
  __jethubRerenderModels();
  if (provider) __jethubRenderBatchBar(provider);
}

function jethubBatchSelectAll() {
  var models = __jethubState.models;
  var allSelected = models.length > 0 && models.every(function(m) { return __jethubState.modelSelected[m.id]; });
  __jethubState.modelSelected = {};
  if (!allSelected) {
    models.forEach(function(m) { __jethubState.modelSelected[m.id] = true; });
  }
  __jethubRerenderModels();
}

function jethubModelFilter(value) {
  var filter = (value || '').trim().toLowerCase();
  var rows = document.querySelectorAll('#free-hub-model-list [data-mid]');
  for (var i = 0; i < rows.length; i++) {
    var mid = (rows[i].getAttribute('data-mid') || '').toLowerCase();
    rows[i].style.display = (!filter || mid.indexOf(filter) !== -1) ? '' : 'none';
  }
  var input = document.getElementById('free-hub-model-filter');
  if (input && filter && input.value !== value) input.value = value;
}

async function jethubSetModelHidden(providerId, modelId, hidden) {
  try {
    await apiPut('/jethub/providers/' + encodeURIComponent(providerId) + '/models', { modelId: modelId, disabled: hidden });
    var m = __jethubState.models.find(function(x) { return x.id === modelId; });
    if (m) m.disabled = hidden;
    __jethubRerenderModels();
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
    await __jethubReloadModels(providerId);
  }
}

async function jethubBatchDeleteSelected(providerId) {
  var ids = Object.keys(__jethubState.modelSelected);
  if (ids.length === 0) { toast(t('freeHubNoModelsSelected'), 'warning'); return; }
  var okgo = await confirmModal(t('freeHubBatchDeleteConfirm', [String(ids.length)]));
  if (!okgo) return;
  try {
    await apiPost('/jethub/providers/' + encodeURIComponent(providerId) + '/models/batch-delete', { modelIds: ids });
    __jethubState.modelSelected = {};
    toast(t('freeHubModelsDeleted', [String(ids.length)]), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
  await __jethubReloadModels(providerId);
}

async function jethubRestoreDefaultModels(providerId) {
  var okgo = await confirmModal(t('freeHubRestoreDefaultsConfirm'));
  if (!okgo) return;
  try {
    await apiDelete('/jethub/providers/' + encodeURIComponent(providerId) + '/models');
    __jethubState.modelSelected = {};
    toast(t('freeHubModelsRestored'), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
  await __jethubReloadModels(providerId);
}

async function __jethubReloadModels(providerId) {
  try {
    var d = await apiGet('/jethub/providers/' + encodeURIComponent(providerId) + '/models');
    __jethubState.models = d.models || [];
  } catch (e) { /* keep the current list on refetch failure */ }
  __jethubRerenderModels();
}

// ---------- credits claim (single account, kept from P4) ----------

async function jethubClaim(providerId, accountId) {
  try {
    var data = await apiPost('/jethub/' + encodeURIComponent(providerId) + '/claim', { accountId: accountId });
    var outcome = data.outcome || {};
    var granted = (outcome.claimed !== undefined ? outcome.claimed : outcome.claimResults) || outcome.status;
    toast(t('freeHubClaimOk', [typeof granted === 'object' ? JSON.stringify(granted).slice(0, 120) : String(granted || t('freeHubClaimNone'))]), 'success');
  } catch (e) {
    var msg = (e && e.message) || '';
    toast(/already|claimed|已领|幂等|alreadyProcessed/i.test(msg) ? t('freeHubClaimNone') : t('failed', [msg]), 'error');
  }
}

// ---------- header claim-all (kept from P4) ----------

async function jethubClaimAll() {
  toast(t('freeHubCheckinRunning'));
  var ok = 0, fail = 0;
  for (var i = 0; i < __jethubState.providers.length; i++) {
    var p = __jethubState.providers[i];
    if (!p.hasCredits) continue;
    var accounts = [];
    try {
      var data = await apiGet('/jethub/providers/' + encodeURIComponent(p.id) + '/accounts');
      accounts = (data.accounts || []).filter(function(a) { return a.enabled && a.hasCredential; });
    } catch (e) { continue; }
    for (var j = 0; j < accounts.length; j++) {
      try {
        await apiPost('/jethub/' + encodeURIComponent(p.id) + '/claim', { accountId: accounts[j].id });
        ok++;
      } catch (e) { fail++; } // already-claimed surfaces as an error on some providers — counted as failed but harmless
    }
  }
  toast(t('freeHubCheckinDone', [String(ok), String(fail)]), fail > 0 ? 'error' : 'success');
}

// ---------- backup / restore (original Jet Hub format, §1.5) ----------

var JETHUB_BACKUP_ENCRYPTED_FORMAT = 'dsh-codearts-auth/backup.encrypted';

async function jethubBackup() {
  var passphrase = await promptModal(t('freeHubBackupPwd'), '', t('freeHubBackupPwdHint'));
  if (passphrase === null || passphrase === '') return;
  try {
    var data = await apiGet('/jethub/backup/export');
    var container = await __jethubEncryptBackup(data.payload, passphrase);
    var blob = new Blob([JSON.stringify(container, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'free-hub-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast(t('freeHubBackupDone'), 'success');
  } catch (e) {
    toast(t('freeHubBackupFailed', [e.message]), 'error');
  }
}

function jethubRestorePick() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = function() { if (input.files && input.files[0]) jethubRestore(input.files[0]); };
  input.click();
}

async function jethubRestore(file) {
  try {
    var parsed = JSON.parse(await file.text());
    var payload = parsed;
    if (__jethubIsEncryptedBackup(parsed)) {
      var passphrase = await promptModal(t('freeHubRestorePwd'), '', '');
      if (passphrase === null || passphrase === '') return;
      payload = await __jethubDecryptBackup(parsed, passphrase);
    }
    if (!payload || payload.format !== 'dsh-codearts-auth/backup') {
      throw new Error(t('freeHubRestoreFailed', [String(payload && payload.format)]));
    }
    var data = await apiPost('/jethub/backup/import', { payload: payload });
    toast(t('freeHubRestoreDone', [String(data.imported), String(data.skipped)]), 'success');
    // refresh provider badges + current detail
    var root = document.getElementById('free-hub-root');
    if (__jethubActive && root) __jethubMount(root);
  } catch (e) {
    toast(t('freeHubRestoreFailed', [e.message]), 'error');
  }
}

function __jethubIsEncryptedBackup(value) {
  return typeof value === 'object' && value !== null
    && typeof value.kdf === 'string' && typeof value.ciphertext === 'string';
}

// The shell matches ref backup-crypto.js 1:1 (PBKDF2 310000 / SHA-256 /
// AES-256-GCM, salt 16B, iv 12B) so the files stay interchangeable.
async function __jethubEncryptBackup(payload, passphrase) {
  var salt = crypto.getRandomValues(new Uint8Array(16));
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var key = await __jethubDeriveKey(passphrase, salt, 310000, ['encrypt']);
  var ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return {
    format: JETHUB_BACKUP_ENCRYPTED_FORMAT, kdf: 'PBKDF2', hash: 'SHA-256',
    iterations: 310000, salt: __jethubB64(salt), iv: __jethubB64(iv),
    ciphertext: __jethubB64(new Uint8Array(ciphertext)),
  };
}

async function __jethubDecryptBackup(container, passphrase) {
  var salt = __jethubUnb64(container.salt);
  var iv = __jethubUnb64(container.iv);
  var iterations = Number.isSafeInteger(container.iterations) && container.iterations > 0 ? container.iterations : 310000;
  var key = await __jethubDeriveKey(passphrase, salt, iterations, ['decrypt']);
  var plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, __jethubUnb64(container.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function __jethubDeriveKey(passphrase, salt, iterations, usages) {
  var keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, usages);
}

function __jethubB64(bytes) {
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function __jethubUnb64(value) {
  var binary = atob(value);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
