// ===================== Free Hub (jethub) management UI (P4) =====================
// Vanilla JS, no framework. Mounted as a full-main replacement inside
// #page-content when the Settings sidebar "Free Hub" row is clicked;
// closeFreeHub() restores the initial settings view.
//
// Sections (right pane): ① call prefix → ② account pool → ③ model blacklist
// → ④ credits. Header: claim-all / backup / restore / close.
// All state goes through /api/jethub RPCs; backup payloads are assembled by
// the server and encrypted/decrypted in the browser (PBKDF2 310000 +
// AES-GCM — original Jet Hub compatible shell, §1.5).

var __jethubActive = false;
var __jethubState = {
  providers: [], selected: null, accounts: [], models: [],
  balance: null, balanceLoading: false, pollTimer: null,
};

function openFreeHub() {
  if (__jethubActive) return;
  var page = document.getElementById('page-content');
  if (!page) return;
  var layout = page.querySelector('.settings-layout');
  var root = document.getElementById('free-hub-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'free-hub-root';
    page.appendChild(root);
  }
  __jethubActive = true;
  if (layout) layout.style.display = 'none';
  __jethubMount(root);
}

function closeFreeHub() {
  if (!__jethubActive) return;
  __jethubActive = false;
  if (__jethubState.pollTimer) { clearInterval(__jethubState.pollTimer); __jethubState.pollTimer = null; }
  var page = document.getElementById('page-content');
  var root = document.getElementById('free-hub-root');
  if (root) root.remove();
  var layout = page && page.querySelector('.settings-layout');
  if (layout) {
    layout.style.display = '';
  } else if (page && typeof renderEndpoint === 'function') {
    renderEndpoint(page); // page was re-rendered while Free Hub was open
  }
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
  root.innerHTML =
    '<div class="free-hub">' +
      '<div class="free-hub-header">' +
        '<button type="button" class="btn btn-sm" onclick="jethubClaimAll()">' + escapeHtml(t('freeHubCheckinAll')) + '</button>' +
        '<button type="button" class="btn btn-sm" onclick="jethubBackup()">' + escapeHtml(t('freeHubBackup')) + '</button>' +
        '<button type="button" class="btn btn-sm" onclick="jethubRestorePick()">' + escapeHtml(t('freeHubRestore')) + '</button>' +
        '<span class="free-hub-header-spacer"></span>' +
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
  __jethubState.selected = providerId;
  __jethubState.balance = null;
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
    // ② accounts
    '<div class="free-hub-section"><div class="free-hub-section-title">' + escapeHtml(t('freeHubAccountsTitle')) + '</div>' +
      '<button type="button" class="btn btn-primary btn-sm" onclick="jethubAddAccount(\'' + escapeForJsString(provider.id) + '\')">' + escapeHtml(t('freeHubAddAccount')) + '</button>' +
      '<div id="free-hub-accounts" class="free-hub-accounts">' + __jethubRenderAccounts(provider) + '</div>' +
    '</div>' +
    // ③ models
    '<div class="free-hub-section"><div class="free-hub-section-title">' + escapeHtml(t('freeHubModelsTitle')) + '</div>' +
      '<div class="free-hub-hint">' + escapeHtml(t('freeHubModelsHint')) + '</div>' +
      '<div class="free-hub-models">' + __jethubRenderModels(provider) + '</div>' +
    '</div>' +
    // ④ credits
    '<div class="free-hub-section"><div class="free-hub-section-title">' + escapeHtml(t('freeHubCreditsTitle')) + '</div>' +
      __jethubRenderCredits(provider) +
    '</div>';
}

function __jethubRenderAccounts(provider) {
  if (__jethubState.accounts.length === 0) {
    return '<div class="free-hub-hint">' + escapeHtml(t('freeHubNoAccounts')) + '</div>';
  }
  return __jethubState.accounts.map(function(a) {
    var expires = a.expiresAt ? new Date(a.expiresAt).toLocaleString() : t('freeHubNever');
    var badges = '<span class="badge ' + (a.enabled ? 'badge-active' : 'badge-inactive') + '">' + (a.enabled ? t('enable') : t('disable')) + '</span>';
    if (a.hasCredential) badges += '<span class="badge badge-active">key</span>';
    if (a.refreshable) badges += '<span class="badge badge-active">refresh</span>';
    var buttons =
      '<button type="button" class="btn btn-sm" onclick="jethubRenameAccount(\'' + escapeForJsString(a.id) + '\')">' + escapeHtml(t('freeHubRename')) + '</button>' +
      '<button type="button" class="btn btn-sm" onclick="jethubToggleAccount(\'' + escapeForJsString(a.id) + '\')">' + escapeHtml(a.enabled ? t('disable') : t('enable')) + '</button>' +
      (a.refreshable ? '<button type="button" class="btn btn-sm" onclick="jethubRefreshAccount(\'' + escapeForJsString(a.id) + '\')">' + escapeHtml(t('freeHubRefresh')) + '</button>' : '') +
      '<button type="button" class="btn btn-sm btn-danger" onclick="jethubDeleteAccount(\'' + escapeForJsString(a.id) + '\')">' + escapeHtml(t('delete')) + '</button>';
    return '<div class="free-hub-account">' +
      '<div class="free-hub-account-row"><span class="free-hub-account-name">' + escapeHtml(a.nickname || a.id) + '</span>' + badges + '</div>' +
      '<div class="free-hub-hint">' + escapeHtml(t('freeHubExpires')) + ': ' + escapeHtml(expires) + '</div>' +
      '<div class="free-hub-account-actions">' + buttons + '</div>' +
      '</div>';
  }).join('');
}

function __jethubRenderModels(provider) {
  if (!__jethubState.models.length) {
    return '<div class="free-hub-hint">' + escapeHtml(t('freeHubModelsEmpty')) + '</div>';
  }
  return __jethubState.models.map(function(m) {
    return '<label class="free-hub-model" data-tooltip="' + escapeAttr(m.id) + '">' +
      '<input type="checkbox"' + (m.disabled ? '' : ' checked') + ' onchange="jethubToggleModel(\'' + escapeForJsString(provider.id) + '\', \'' + escapeForJsString(m.id) + '\', this.checked)">' +
      '<span>' + escapeHtml(m.name || m.id) + '</span></label>';
  }).join('');
}

function __jethubRenderCredits(provider) {
  if (!provider.hasBalance && !provider.hasCredits) {
    return '<div class="free-hub-hint">' + escapeHtml(t('freeHubNoCredits')) + '</div>';
  }
  var html = '';
  if (provider.hasBalance) {
    html += '<button type="button" class="btn btn-sm" onclick="jethubQueryBalance(\'' + escapeForJsString(provider.id) + '\')">' + escapeHtml(t('freeHubRefreshBalance')) + '</button>' +
      '<div id="free-hub-balance" class="free-hub-balance">' + __jethubRenderBalance() + '</div>';
  }
  if (provider.hasCredits) {
    html += '<div class="free-hub-claim-list">' + __jethubState.accounts.map(function(a) {
      if (!a.enabled) return '';
      return '<div class="free-hub-claim-row"><span>' + escapeHtml(a.nickname || a.id) + '</span>' +
        '<button type="button" class="btn btn-sm" onclick="jethubClaim(\'' + escapeForJsString(provider.id) + '\', \'' + escapeForJsString(a.id) + '\')">' + escapeHtml(t('freeHubClaim')) + '</button></div>';
    }).join('') + '</div>';
  }
  return html;
}

function __jethubRenderBalance() {
  var b = __jethubState.balance;
  if (__jethubState.balanceLoading) return '<div class="free-hub-hint">…</div>';
  if (b === null) return '';
  if (!b || b.total === undefined) return '<div class="free-hub-hint">' + escapeHtml(t('freeHubBalanceFailed')) + '</div>';
  return '<div class="free-hub-balance-total">' + escapeHtml(t('freeHubBalance')) + ': ' + escapeHtml(String(b.total)) + '</div>';
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

// ---------- accounts ----------

async function jethubAddAccount(providerId) {
  var provider = __jethubState.providers.find(function(p) { return p.id === providerId; }) || {};
  if ((provider.loginModes || []).indexOf('sms') !== -1) {
    __jethubSmsModal(providerId);
    return;
  }
  // url / qr modes share the URL + poll modal (qr providers hand back the
  // login page URL the same way).
  try {
    var created = await apiPost('/jethub/' + encodeURIComponent(providerId) + '/login', {});
    __jethubLoginModal(providerId, created);
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
  var stop = function() { if (__jethubState.pollTimer) { clearInterval(__jethubState.pollTimer); __jethubState.pollTimer = null; } overlay.classList.remove('show'); overlay.innerHTML = ''; };
  document.getElementById('free-hub-login-cancel').onclick = stop;
  var statusEl = document.getElementById('free-hub-login-status');
  __jethubState.pollTimer = setInterval(async function() {
    try {
      var st = await apiGet('/jethub/' + encodeURIComponent(providerId) + '/status?loginId=' + encodeURIComponent(created.loginId));
      if (st.done) {
        stop();
        if (st.success) {
          toast(t('freeHubLoginOk'), 'success');
          jethubSelect(providerId);
        } else {
          toast(t('freeHubLoginFailed', [st.error || '']), 'error');
          jethubSelect(providerId); // the placeholder account is cleaned up server-side when it failed hard
        }
      }
    } catch (e) { /* transient poll failure: keep polling */ }
  }, 2000);
}

function __jethubSmsModal(providerId) {
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
  var close = function() { overlay.classList.remove('show'); overlay.innerHTML = ''; };
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
        phone: document.getElementById('free-hub-sms-phone').value.trim(),
        code: document.getElementById('free-hub-sms-code').value.trim(),
      });
      close();
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

// ---------- models ----------

async function jethubToggleModel(providerId, modelId, enabled) {
  try {
    await apiPut('/jethub/providers/' + encodeURIComponent(providerId) + '/models', { modelId: modelId, disabled: !enabled });
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
    jethubSelect(providerId);
  }
}

// ---------- credits ----------

async function jethubQueryBalance(providerId) {
  var acc = __jethubState.accounts.find(function(a) { return a.enabled; });
  if (!acc) { toast(t('freeHubBalanceFailed'), 'error'); return; }
  __jethubState.balanceLoading = true;
  var el = document.getElementById('free-hub-balance');
  if (el) el.innerHTML = '<div class="free-hub-hint">…</div>';
  try {
    var data = await apiGet('/jethub/' + encodeURIComponent(providerId) + '/balance?accountId=' + encodeURIComponent(acc.id));
    __jethubState.balance = __jethubSumBalance(data.balance);
  } catch (e) {
    __jethubState.balance = null;
  }
  __jethubState.balanceLoading = false;
  el = document.getElementById('free-hub-balance');
  if (el) el.innerHTML = __jethubRenderBalance();
}

// balance DTO shape varies per provider; normalize the total defensively
// (packages[].remaining when present, else total, else unknown).
function __jethubSumBalance(balance) {
  if (!balance) return null;
  if (typeof balance.total !== 'undefined') return balance;
  var total = 0, any = false;
  var packages = balance.packages || [];
  packages.forEach(function(p) {
    var v = Number(p.remaining !== undefined ? p.remaining : p.value);
    if (!isNaN(v)) { total += v; any = true; }
  });
  return any ? { total: total } : null;
}

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
    var page = document.getElementById('page-content');
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
