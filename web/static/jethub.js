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
  // 浏览器轴/会话轴（+新建账号 弹窗）：choices = 服务端探测结果（可用浏览器 +
  // 系统默认 + 记住的偏好），loginChoice = 本次选择（「重新打开登录页」复用）。
  loginChoices: null, loginChoice: null,
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
    // Web Hub 站点组与 jethub provider 共用同一块左栏与单选态；加载失败只让
    // 站点组为空，不影响 Free Hub 本体（两个 Hub 互相独立）。
    if (typeof webhubLoadSites === 'function') {
      try { await webhubLoadSites(); } catch (e) { /* webhub unreachable */ }
    }
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
  // 分割线下方 = Web Hub 站点组（浏览器驱动，与上方「账号桥接」机制不同）。
  // 只在 webhub.js 已加载时插入，未加载时左栏维持原样。
  if (typeof webhubRenderSiteGroup === 'function') webhubRenderSiteGroup();
}

async function jethubSelect(providerId) {
  var providerChanged = __jethubState.selected !== providerId;
  __jethubState.selected = providerId;
  // 选中 jethub provider 时清掉 webhub 的选中态（共用同一单选态）。
  if (typeof __webhubState !== 'undefined') __webhubState.selected = null;
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
    html += '<button type="button" class="btn btn-sm" onclick="jethubClaimAllProvider(\'' + pid + '\')">' +
      escapeHtml(provider.claimKind === 'onboarding' ? t('freeHubClaimOnboardingAll') : t('freeHubClaimAll')) + '</button>';
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
  var cards = __jethubState.accounts.map(function(a) {
    return __jethubAccountCard(provider, a);
  }).join('');
  // 顺序会真实影响自动选号，必须让用户知道（仅在两个以上账号时显示）。
  var hint = __jethubState.accounts.length > 1
    ? '<div class="free-hub-hint free-hub-order-hint">' + escapeHtml(t('freeHubOrderHint')) + '</div>'
    : '';
  return cards + hint;
}

// ---------- 账号拖拽排序（顺序 = 选号优先级）----------

// __jethubDragStart / __jethubDragEnd 记/清当前被拖的账号。
// ⚠️ 用 state 而不是只靠 dataTransfer：部分浏览器在 dragover 阶段读不到
// data（安全限制），只依赖它会拿不到被拖项。
function __jethubDragStart(e, accountId) {
  __jethubState.dragAccountId = accountId;
  if (e && e.dataTransfer) {
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', accountId);
    } catch (err) { /* 老浏览器：忽略，state 已记住 */ }
  }
}

function __jethubDragOver(e) {
  // 必须 preventDefault，否则浏览器不认这是一个可放置目标（drop 不会触发）。
  if (e && e.preventDefault) e.preventDefault();
  if (e && e.dataTransfer) { try { e.dataTransfer.dropEffect = 'move'; } catch (err) {} }
}

function __jethubDragEnd() {
  __jethubState.dragAccountId = null;
}

// __jethubDrop 把被拖账号移到目标位置，并把**完整顺序表**提交给服务端。
//
// ⚠️ 提交整个列表而不是「移动的第 N 项」：服务端据此做集合相等校验（不重不漏），
// 一次不完整的拖拽会被明确拒绝，而不是悄悄打乱用户已排好的顺序。
async function __jethubDrop(e, targetId) {
  if (e && e.preventDefault) e.preventDefault();
  var dragged = __jethubState.dragAccountId;
  __jethubState.dragAccountId = null;
  if (!dragged || dragged === targetId) return;
  var ids = __jethubState.accounts.map(function(a) { return a.id; });
  var from = ids.indexOf(dragged);
  var to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return;
  ids.splice(from, 1);
  ids.splice(to, 0, dragged);
  var provider = __jethubState.selected;
  try {
    var res = await apiPut('/jethub/providers/' + encodeURIComponent(provider) + '/accounts/order', { accountIds: ids });
    if (res && res.accounts) {
      // 服务端会重算 rotationOrder（匿名通道恒殿后），故以它的返回为准 ——
      // 用本地 ids 顺序渲染会让序号与实际选号次序不一致。
      __jethubState.accounts = res.accounts;
    }
    __jethubRerenderAccounts();
    toast(t('freeHubOrderSaved'), 'success');
  } catch (err) {
    toast(t('failed', [err.message]), 'error');
    __jethubRerenderAccounts(); // 回到服务端的真实顺序
  }
}

// __jethubRerenderAccounts 只重画账号卡片区（不动前缀/模型列表/提示区）。
function __jethubRerenderAccounts() {
  var el = document.getElementById('free-hub-accounts');
  if (!el) return;
  var provider = __jethubState.providers.find(function(p) { return p.id === __jethubState.selected; }) || {};
  el.innerHTML = __jethubRenderAccounts(provider);
}

// __jethubIsAnonymousAccount: opencode 的匿名通道。
//
// ⚠️ 判据优先用服务端的 `anonymous` 字段（由**凭据内容**判定，权威）；id 前缀只作
// 兜底（ref 的契约形状是 `opencode-anon-`，而本端的账号 id 是 `{provider}-{8hex}`，
// 前缀判据在本端**永远不命中** —— 只写前缀会让标签静默消失）。
function __jethubIsAnonymousAccount(a) {
  if (a && a.anonymous === true) return true;
  return String((a && a.id) || '').indexOf('opencode-anon-') === 0;
}

// __jethubClaimLabel: 「领取」按钮的文案随**语义**走。
// 把一次性奖励写成「领取」会让用户每天点一次必然 already-claimed 的请求
// （ref 的能力矩阵把 dailyCheckin 与 onboardingTasks 分成两个独立位，正是为此）。
function __jethubClaimLabel(provider) {
  if (provider && provider.claimKind === 'onboarding') return t('freeHubClaimOnboarding');
  return t('freeHubClaim');
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
  // opencode 匿名通道：它不需要 key、只用于免费模型，且额度按**出口 IP** 计。
  // 标出来是为了让用户知道「这条不是登录账号」，以及为什么给它们配不同代理才会
  // 各自获得独立额度（ref 的同款标签与 tooltip）。
  if (provider.id === 'opencode' && __jethubIsAnonymousAccount(a)) {
    badges += '<span class="badge badge-active" data-tooltip="' + escapeAttr(t('freeHubAnonymousHint')) + '">' +
      escapeHtml(t('freeHubAnonymous')) + '</span>';
  }

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
    buttons += '<button type="button" class="btn btn-sm" data-tooltip="' + escapeAttr(t('freeHubClaimHelp')) + '" onclick="jethubClaim(\'' + pid + '\', \'' + aid + '\')">' + escapeHtml(__jethubClaimLabel(provider)) + '</button>';
  }
  // 一次性任务端点（原版 onboardingTasks）。只在**另有**每日签到的渠道上出现
  // （见后端 claimKind / supportsOnboardingTasks 的注释）：与每日签到是两件事。
  if (provider.supportsOnboardingTasks && a.enabled && a.hasCredential) {
    buttons += '<button type="button" class="btn btn-sm" data-tooltip="' + escapeAttr(t('freeHubOnboardingHelp')) + '" onclick="jethubClaimOnboarding(\'' + pid + '\', \'' + aid + '\')">' + escapeHtml(t('freeHubOnboarding')) + '</button>';
  }
  // 出口代理 + 指纹轮换（仅 opencode：**两种独立的「账号分离」手段**）。
  // ⚠️ 文案必须说清「不设会怎样」：看到「代理」按钮很容易当成锦上添花，实际不设
  // = 与其它账号共用同一出口（同一份额度）；而**指纹分离不增加配额**，只有独立出口
  // 才会 —— 两个按钮不能混为一谈（ref 的同款 tooltip）。
  if (provider.id === 'opencode' && a.hasCredential) {
    buttons += '<button type="button" class="btn btn-sm" data-tooltip="' +
      escapeAttr(a.opencodeProxy ? t('freeHubProxyCurrent', [a.opencodeProxy]) : t('freeHubProxyHelp')) +
      '" onclick="jethubSetAccountProxy(\'' + aid + '\')">' + escapeHtml(t('freeHubAccountProxy')) + '</button>';
    buttons += '<button type="button" class="btn btn-sm" data-tooltip="' + escapeAttr(t('freeHubFingerprintHelp')) + '" onclick="jethubRotateFingerprint(\'' + aid + '\')">' + escapeHtml(t('freeHubFingerprint')) + '</button>';
  }
  if (a.refreshable) {
    buttons += '<button type="button" class="btn btn-sm" onclick="jethubRefreshAccount(\'' + aid + '\')">' + escapeHtml(t('freeHubRefresh')) + '</button>';
  }
  buttons += '<button type="button" class="btn btn-sm" onclick="jethubRenameAccount(\'' + aid + '\')">' + escapeHtml(t('freeHubRename')) + '</button>';
  buttons += '<button type="button" class="btn btn-sm" onclick="jethubToggleAccount(\'' + aid + '\')">' + escapeHtml(a.enabled ? t('disable') : t('enable')) + '</button>';
  buttons += '<button type="button" class="btn btn-sm btn-danger" onclick="jethubDeleteAccount(\'' + aid + '\')">' + escapeHtml(t('delete')) + '</button>';

  var sid = __jethubSanitizeId(a.id);
  // 拖拽排序只在两个以上账号时可用（一个账号没有顺序可言，句柄只会是噪音）。
  // ⚠️ 顺序 = **自动选号优先级**，会真实改变下一条请求走哪个账号 —— 故句柄上
  // 必须带提示，否则用户「拖了有什么用」无从得知（ref 的 dim-jh-orderHint 同款）。
  var reorderable = __jethubState.accounts.length > 1;

  return '<div class="free-hub-account" data-enabled="' + (a.enabled ? '1' : '0') + '"' +
    (reorderable
      ? ' draggable="true" ondragstart="__jethubDragStart(event, \'' + aid + '\')"' +
        ' ondragover="__jethubDragOver(event)" ondrop="__jethubDrop(event, \'' + aid + '\')"' +
        ' ondragend="__jethubDragEnd(event)"'
      : '') + '>' +
    '<div class="free-hub-account-row">' +
      (reorderable
        ? '<span class="free-hub-account-order" data-tooltip="' + escapeAttr(t('freeHubOrderHint')) + '">' +
            escapeHtml(String(Number(a.rotationOrder || 0) + 1)) + '</span>'
        : '') +
      '<span class="free-hub-dot' + (a.enabled ? ' on' : '') + '"></span>' +
      '<span class="free-hub-account-name"' + (a.accountName ? ' data-tooltip="' + escapeAttr(a.accountName) + '"' : '') + '>' + escapeHtml(a.nickname || a.id) + '</span>' + badges +
      // 手机号（仅 zcode：由 17 位 user_id 前 11 位派生，上游从不下发手机号字段）
      // ——取不到就没有这个元素，不显示占位符。
      (a.phone ? '<span class="free-hub-account-phone">' + escapeHtml(a.phone) + '</span>' : '') +
    '</div>' +
    '<div class="free-hub-account-meta">' +
      '<div class="free-hub-meta-row"><span class="free-hub-meta-label">' + escapeHtml(t('freeHubCredential')) + '</span>' +
        '<code class="code">' + escapeHtml(a.credentialRef || '-') + '</code></div>' +
      '<div class="free-hub-meta-row"><span class="free-hub-meta-label">' + escapeHtml(t('freeHubExpires')) + '</span>' +
        '<span' + (expired ? ' class="free-hub-expired"' : '') + '>' + escapeHtml(expires) + '</span></div>' +
      // 账号规格（目前只有 Gemini 有：Pro / Free / Ultra）。默认隐藏，余额拉回来
      // 才显示 —— 取不到档位时**整行不出现**（不显示「未知」也不报错：它只是一栏
      // 附注信息，不该制造一条无法修复的提示）。
      (provider.hasBalance
        ? '<div class="free-hub-meta-row" id="free-hub-tier-row-' + sid + '" style="display:none">' +
            '<span class="free-hub-meta-label">' + escapeHtml(t('freeHubAccountTier')) + '</span>' +
            '<span id="free-hub-tier-' + sid + '"></span></div>'
        : '') +
      (provider.hasBalance
        ? '<div class="free-hub-meta-row"><span class="free-hub-meta-label" id="free-hub-credit-label-' + sid + '">' + escapeHtml(__jethubCreditLabel(__jethubCreditUnit(a.id))) + '</span>' +
            '<span id="free-hub-credit-' + sid + '">' + __jethubCreditCellHtml(a.id) + '</span></div>'
        : '') +
    '</div>' +
    (chips ? '<div class="free-hub-rate-chips"><span class="free-hub-rate-chips-label">' + escapeHtml(t('freeHubRateLimitReset')) + '</span>' + chips + '</div>' : '') +
    '<div class="free-hub-account-actions">' + buttons + '</div>' +
    '</div>';
}

function __jethubCreditCellHtml(accountId) {
  var c = __jethubState.credits[accountId];
  if (!c || c.loading) return '<span class="free-hub-hint">…</span>';
  if (c.error) {
    // `error` 有两种来源，**都如实显示**（不要把后者也写成「查询失败」）：
    //   - 真失败：网络/凭据/响应形状（API 抛错或 5xx）；
    //   - **状态**：opencode 的「已停用」/「限额中，<时刻> 恢复」—— 那是 200
    //     响应里的正常内容（额度本身就是「通道可用性」，见 OpencodeChannelBalance）。
    // 完整原因放 title，卡片上只放一行（原版同款：`data-tone=warn` + title）。
    return '<span class="free-hub-credit-error" title="' + escapeAttr(c.error) + '">' +
      escapeHtml(c.error) + '</span>';
  }
  var balance = c.balance;
  if (!balance) return '<span class="free-hub-credit-error">' + escapeHtml(t('freeHubCreditFailed')) + '</span>';
  var packages = balance.packages || [];
  var unit = c.unit || '';
  var format = function(value) { return __jethubFormatUnits(value, unit); };
  var now = Date.now();
  var total = __jethubBalanceTotal(balance);
  // 逐窗口百分比（配额单位）优先于均值 —— 均值是上游根本不存在的数（见
  // __jethubQuotaLine 的注释）。
  var quotaLine = __jethubQuotaLine(packages, unit);
  var activeCount = 0;
  packages.forEach(function(p) { if (p && p.active) activeCount++; });
  // 两种分桶互斥：有「当日刷新池」的走池名分桶，其余走到期时间分桶。
  var poolLine = __jethubPoolSplitLine(packages, format, __jethubState.selected === 'loomy' ? t('freeHubCreditPermanent') : t('freeHubCreditLongTerm'));
  var expiryLine = poolLine ? null : __jethubExpirySplitLine(__jethubSplitByExpiry(packages, c.windowDays, now), format);
  // 明细进 title（配额口径用「重置于」，资源包口径列每个包 + 到期日）。
  var detail = __jethubQuotaDetail(packages, unit) || __jethubPackageTooltip(packages, format, now);

  var html = '<span class="free-hub-credit-value"' + (detail ? ' title="' + escapeAttr(detail) + '"' : '') + '>' +
    '<strong class="free-hub-credit-total">' + escapeHtml(quotaLine !== null ? quotaLine : format(total)) + '</strong>';
  if (poolLine) {
    html += '<span class="free-hub-credit-pools">' + escapeHtml(poolLine) + '</span>';
  } else if (expiryLine) {
    html += '<span class="free-hub-credit-pools" data-tooltip="' +
      escapeAttr(t('freeHubCreditExpiryHint', [String(c.windowDays)])) + '">' + escapeHtml(expiryLine) + '</span>';
  }
  // 配额单位下**不渲染**「N/M 个资源包有效」：它的两个「包」是 5 小时窗口与周
  // 窗口，不是资源包 —— 说「2/2 个资源包有效」既没信息量又误导（ref 用户报障
  // 原文：「不要渲染 / 2/2 个资源包有效」）。
  if (quotaLine === null && !poolLine && !expiryLine && packages.length > 1) {
    html += '<span class="free-hub-credit-packages">' +
      escapeHtml(t('freeHubCreditPackages', [String(activeCount), String(packages.length)])) + '</span>';
  }
  if (Number(balance.expiredTotal) > 0) {
    html += '<span class="free-hub-credit-expired">' +
      escapeHtml(t('freeHubCreditExpired', [format(balance.expiredTotal)])) + '</span>';
  }
  return html + '</span>';
}

// __jethubCreditUnit: 当前已知的计量单位（尚未拉到余额时为空串 ⇒ 标签回落「积分」，
// 与 ref unitLabel 的兜底分支同口径）。
function __jethubCreditUnit(accountId) {
  var c = __jethubState.credits[accountId];
  return (c && c.unit) || '';
}

function __jethubUpdateCreditCell(accountId) {
  var el = document.getElementById('free-hub-credit-' + __jethubSanitizeId(accountId));
  if (el) el.innerHTML = __jethubCreditCellHtml(accountId);
  // 标签**随单位走**（ZCode 是 Token、Gemini 是额度、其余是积分）—— 写死「积分」
  // 会把 token 余额说成积分（真实缺陷：上游用户报障「智谱 plan 给的不是积分是
  // tokens」）。
  var label = document.getElementById('free-hub-credit-label-' + __jethubSanitizeId(accountId));
  if (label) label.textContent = __jethubCreditLabel(__jethubCreditUnit(accountId));
  // 账号规格：有值才把整行显示出来（取不到 ⇒ 保持隐藏，不显示「未知」）。
  var c = __jethubState.credits[accountId];
  var tier = c && c.extra && c.extra.accountTier;
  var row = document.getElementById('free-hub-tier-row-' + __jethubSanitizeId(accountId));
  var cell = document.getElementById('free-hub-tier-' + __jethubSanitizeId(accountId));
  if (row && cell) {
    if (tier && tier.label) {
      row.style.display = '';
      cell.textContent = tier.label;
      cell.setAttribute('title', tier.title || tier.label);
    } else {
      row.style.display = 'none';
      cell.textContent = '';
      cell.removeAttribute('title');
    }
  }
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
      __jethubState.credits[a.id] = {
        // 整个 balance 都要留着：分桶 / 明细 / 失效额度都要读 packages，
        // 只留 total 会让这些信息在卡片上无法恢复（原版同样整份带回）。
        balance: data.balance,
        // `error` 与 balance **并列**：opencode 的「已停用 / 限额中」是 200 里的
        // 正常内容，必须能与余额同时显示。
        error: data.error || '',
        unit: __jethubBalanceUnit(data.balance),
        windowDays: (data.windowDays === undefined ? null : data.windowDays),
        // `extra` 是逐账号的**附加读数**（目前只有 Gemini 的账号规格 Pro/Free/
        // Ultra 走这里），与 balance **并列**、必须原样带上 —— 漏掉它卡片就永远
        // 不显示那一行，而后端看不出任何异常。
        extra: data.extra || null,
      };
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

// balance DTO shape varies per provider; normalize the total defensively.
// ⚠️ 只有 total **非正**而包里有余额时才回退为求和：服务端的 total 口径与包明细
// 不一致时（个别渠道不填 total），显示 0 会把「其实还有额度」说成「已用光」。
function __jethubBalanceTotal(balance) {
  if (!balance) return null;
  var total = Number(balance.total);
  if (isFinite(total) && total > 0) return total;
  var sum = 0, any = false;
  (balance.packages || []).forEach(function(p) {
    var v = Number(p && p.remaining !== undefined ? p.remaining : null);
    if (!isNaN(v)) { sum += v; any = true; }
  });
  if (any && sum > 0) return sum;
  return isFinite(total) ? total : null;
}

// __jethubBalanceUnit: 计量单位（zcode 的 token / gemini 的 %；其余渠道无 unit
// 字段 ⇒ ''）。⚠️ 取**首个有单位的包**（同一 provider 的包单位一致；混合单位时
// 以第一个为准，避免标签在两行之间闪烁）。
function __jethubBalanceUnit(balance) {
  if (!balance) return '';
  var packages = balance.packages || [];
  for (var i = 0; i < packages.length; i++) {
    if (packages[i] && packages[i].unit) return packages[i].unit;
  }
  return '';
}

// ---------- credits: 单位口径与分桶（ref credits-format.js / credit-expiry.js） ----------

// __jethubCreditLabel: 单位 → 展示名。**只有三类**（ref unitLabel）：
//   token → Token；% → 额度；其余（含空串/未登记）→ 积分。
// ⚠️ 这是 unit 字段的**唯一消费点** —— 加新单位时改这里，不要在渲染处写
// `if (provider === 'zcode')` 那种分支（会漏掉别的渠道，且标签会各写一份）。
function __jethubCreditLabel(unit) {
  if (unit === 'token') return t('freeHubUnitToken');
  if (unit === '%') return t('freeHubUnitQuota');
  return t('freeHubCreditsLabel');
}

// __jethubFormatQuota: 配额百分比 → `95%`（四舍五入到整数）。
// ⚠️ 不能复用 formatNumber：配额读数是 94.5（两窗口均值），补两位小数会显示成
// 「94.50」——在「额度」标签下那是**假精度**，用户会读成 94.5 个积分。
function __jethubFormatQuota(value) {
  var n = Number(value);
  if (!isFinite(n)) return String(value);
  return String(Math.round(n)) + '%';
}

// __jethubFormatUnits: 按单位选择格式化函数（ref formatUnits 的唯一消费点）。
function __jethubFormatUnits(value, unit) {
  if (unit === 'token') return __jethubFormatTokens(value);
  if (unit === '%') return __jethubFormatQuota(value);
  return __jethubFormatNumber(value);
}

// __jethubQuotaLine: 配额窗口**逐窗口**一行（ref formatQuotaLine）：
// 「5 小时窗口 95% · 周窗口 99%」。
// ⚠️ 主行显示逐窗口读数而**不是均值**：均值（94.5）既不是上游给的数，在「额度」
// 标签下更会被读成 94.5 个积分（ref 用户报障原文：「95 积分；为什么显示的是积分
// 不是额度」）。⚠️ 逐窗口用各自的 remaining，**不做求和**（百分比没有「一共」）。
// 非配额单位返回 null ⇒ 调用方原样走积分/token 分支，零影响。
function __jethubQuotaLine(packages, unit) {
  if (unit !== '%' || !packages || !packages.length) return null;
  var parts = [];
  packages.forEach(function(pkg) {
    if (!pkg) return;
    var value = __jethubFormatQuota(pkg.remaining);
    if (value === null) return;
    parts.push((pkg.name || t('freeHubCreditUnnamed')) + ' ' + value);
  });
  return parts.length ? parts.join(' · ') : null;
}

// __jethubQuotaDetail: 配额窗口的 hover 明细（每包一行）。
// ⚠️ **只在配额单位下生效**（非 `%` 一律返回 null ⇒ 调用方走资源包明细）：
// 配额读数用 `剩余 / 总额` 渲染会被读成「95 个积分，一共 100 个」——而真相是
// 「还剩 95%」。窗口的重置时刻用「重置于」而不是「本周期至」（配额是滚动重置，
// 不是月度套餐）。
function __jethubQuotaDetail(packages, unit) {
  if (unit !== '%' || !packages || !packages.length) return null;
  var lines = [];
  packages.forEach(function(pkg) {
    if (!pkg) return;
    var reset = pkg.cycleEndTime ? ' · ' + t('freeHubCreditResetsAt') + ' ' + pkg.cycleEndTime : '';
    lines.push((pkg.name || t('freeHubCreditUnnamed')) + '：' + t('freeHubCreditRemaining') + ' ' +
      __jethubFormatQuota(pkg.remaining) + reset);
  });
  return lines.length ? lines.join('\n') : null;
}

// 当日刷新池的已知池名（ref DAILY_POOL_NAMES）—— 用**名字**识别而不是下标：
// Raccoon 的池是按「服务端给了哪个字段」动态拼的，下标会错位。
var __jethubDailyPoolNames = ['每日赠送', '每日积分'];

function __jethubFindDailyPool(packages) {
  var list = packages || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && __jethubDailyPoolNames.indexOf(list[i].name) !== -1) return list[i];
  }
  return null;
}

// __jethubPoolSplitLine: 池名分桶（loomy / raccoon）→「长期 X · 每日 Y」。
// 只显示合计会丢掉最关键的信息：**今天有多少会作废**。
function __jethubPoolSplitLine(packages, format, longTermLabel) {
  var daily = __jethubFindDailyPool(packages);
  if (!daily) return null;
  var rest = 0;
  (packages || []).forEach(function(pkg) {
    if (!pkg || pkg === daily) return;
    if (pkg.active !== true) return;
    var v = Number(pkg.remaining);
    if (isFinite(v) && v > 0) rest += v;
  });
  return longTermLabel + ' ' + format(rest) + ' · ' + t('freeHubCreditDaily') + ' ' +
    format(Number(daily.remaining) || 0);
}

// __jethubPackageExpiryMs: 包的到期时刻（ms）；null = 没有到期概念（显示「长期」）。
// 来源优先序（ref packageExpiryMs）：deductionEndTime（后端已归一化的毫秒）>
// expiresAt（字符串，给未归一化的包兜底）。**两处（显示与排序）必须共用它**，
// 否则会出现「显示说 9/30 到期、排序却按别的字段排」。
function __jethubPackageExpiryMs(pkg) {
  if (!pkg) return null;
  var deduction = Number(pkg.deductionEndTime);
  if (isFinite(deduction) && deduction > 0) return deduction;
  if (pkg.expiresAt) {
    var ms = Date.parse(String(pkg.expiresAt).replace(' ', 'T'));
    if (isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

// __jethubSplitByExpiry: 按「会不会近期作废」分两桶（ref splitCreditsByExpiry）。
// ⚠️ 分类是**当前时刻的函数**：宿主长期开着、时间只向前流，永远现算、不缓存。
// ⚠️ 窗口不可用（null/undefined）时返回 null ⇒ 调用方不渲染分类行 —— 不能把
// `Number(null)===0` 当成「窗口 0 天」，那会凭空渲染一行假的「临时 0 · 长期 N」。
// ⚠️ 到期时间**未知**归「长期」（保守方向：宁可少用，不可误烧长期积分）。
function __jethubSplitByExpiry(packages, windowDays, now) {
  if (windowDays === null || windowDays === undefined || windowDays === '') return null;
  var days = Number(windowDays);
  if (!isFinite(days) || days < 0) return null;
  var windowMs = days * 86400000;
  var expiring = 0, permanent = 0;
  (packages || []).forEach(function(pkg) {
    // 失效包跳过：服务端仍会返回它的余额，但那部分扣不到。
    if (!pkg || pkg.active !== true) return;
    var remaining = Number(pkg.remaining);
    if (!isFinite(remaining) || remaining <= 0) return;
    var end = Number(pkg.deductionEndTime);
    var known = isFinite(end) && end > 0;
    if (known && end - now < windowMs) expiring += remaining;
    else permanent += remaining;
  });
  return { expiring: expiring, permanent: permanent };
}

function __jethubExpirySplitLine(split, format) {
  if (!split) return null;
  // 「长期」在前、「临时」在后 —— 与「永久 … · 每日 …」同一顺序，两个渠道的
  // 卡片读起来才对齐。用词是「长期」不是「永久」：这些额度都有到期日，只是较远。
  return t('freeHubCreditLongTerm') + ' ' + format(split.permanent) + ' · ' +
    t('freeHubCreditTemporary') + ' ' + format(split.expiring);
}

// __jethubPackageExpiryText: 单个包的到期展示（绝对日期 + 相对天数）。
function __jethubPackageExpiryText(pkg, now) {
  var end = __jethubPackageExpiryMs(pkg);
  if (end === null) return t('freeHubCreditLongTerm');
  var d = new Date(end);
  var date = d.getFullYear() + '-' + __jethubPad2(d.getMonth() + 1) + '-' + __jethubPad2(d.getDate());
  var days = Math.ceil((end - now) / 86400000);
  if (days <= 0) return date + t('freeHubCreditExpiredSuffix');
  return date + '（' + t('freeHubCreditDaysLeft', [String(days)]) + '）';
}

function __jethubPad2(n) { return (n < 10 ? '0' : '') + n; }

// __jethubPackageTooltip: 资源包列表（账号名 hover）。
// 三条过滤规则（命中任一即不显示）：已消耗完（remaining<=0）、已过期、已失效
// （active===false）。⚠️ **必须在 now 上现算**，不能只判 active —— 实测各家的
// active 口径不一致（TRAE / Qoder 的 active 恒为 true，压根没有这个维度）。
// 排序：最快到期在最上（未知到期沉底），同一到期时刻按剩余量降序。
// 截断：最多 12 行，其余汇总成一行给出合计剩余（不丢总量信息）。
function __jethubPackageTooltip(packages, format, now) {
  if (!packages || !packages.length) return null;
  var at = isFinite(now) ? now : Date.now();
  var usable = packages.filter(function(pkg) {
    if (!pkg || pkg.active === false) return false;
    var remaining = Number(pkg.remaining);
    if (!isFinite(remaining) || remaining <= 0) return false;
    var end = __jethubPackageExpiryMs(pkg);
    if (end !== null && end <= at) return false;
    return true;
  });
  if (!usable.length) return null;
  usable.sort(function(a, b) {
    var ea = __jethubPackageExpiryMs(a), eb = __jethubPackageExpiryMs(b);
    var ka = ea === null ? Infinity : ea, kb = eb === null ? Infinity : eb;
    if (ka !== kb) return ka - kb;
    return (Number(b.remaining) || 0) - (Number(a.remaining) || 0);
  });
  var maxRows = 12;
  var lines = usable.slice(0, maxRows).map(function(pkg) {
    return (pkg.name || t('freeHubCreditUnnamed')) + '  ' +
      format(Number(pkg.remaining) || 0) + ' / ' + format(Number(pkg.total) || 0) + '  ' +
      __jethubPackageExpiryText(pkg, at);
  });
  var rest = usable.slice(maxRows);
  if (rest.length) {
    var sum = 0;
    rest.forEach(function(p) { sum += (Number(p.remaining) || 0); });
    lines.push('…' + t('freeHubCreditMorePackages', [String(rest.length)]) +
      (sum > 0 ? t('freeHubCreditMoreSum', [format(sum)]) : ''));
  }
  return lines.join('\n');
}

// __jethubFormatTokens renders a token count with an M/K magnitude suffix
// (1e6 → 94.54M). 上游额度以 token 计，裸数字在界面上与"积分"无法区分
// （ref 用户报障原话：1 亿 token 显示成 94539275）。
// ⚠️ 小数位**固定两位**（`94.54M` 而不是 `94.5M`）：token 余额的百位变化对用户
// 有意义（差 0.04M = 4 万 token），一位小数会把它们抹平（ref formatTokens 同款）。
function __jethubFormatTokens(value) {
  var n = Number(value);
  if (!isFinite(n)) return String(value);
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return String(Math.round(n));
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
    var res = await apiPost('/jethub/providers/' + encodeURIComponent(providerId) + '/ratelimits/retest', { accountId: accountId || '' });
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
    var res = await apiPost('/jethub/providers/' + encodeURIComponent(providerId) + '/ratelimits/reset', { accountId: accountId || '' });
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
  if ((provider.loginModes || []).indexOf('apikey') !== -1) {
    // opencode（R1-7）：粘贴 API Key，或添加匿名通道 —— 没有浏览器流、没有
    // loginId/轮询，提交即落库（首个非浏览器登录模式）。
    __jethubApiKeyModal(providerId);
    return;
  }
  if ((provider.loginModes || []).indexOf('sms') !== -1) {
    // SMS 流程没有服务端 login session：先创建占位账号，验证码提交时才能
    // 绑定凭据。用户取消时删除占位（不留无凭据的死账号）。
    try {
      // ⚠️ 路由族形状：账号端点挂在 `/jethub/providers/{provider}/accounts`
      // （聚合路由族统一带 `providers/` 段，见 docs/jethub-architecture.md §3.2
      // 缺陷 6）。loomy 是唯一 sms 登录模式，故此前只有它踩到这个 404（chi 回
      // 纯文本 → `Failed: HTTP 404 (non-JSON body)`）。
      var created = await apiPost('/jethub/providers/' + encodeURIComponent(providerId) + '/accounts', {});
      if (created.error) { toast(t('failed', [created.error]), 'error'); return; }
      __jethubSmsModal(providerId, created.accountId);
    } catch (e) {
      toast(t('failed', [e.message]), 'error');
    }
    return;
  }
  // url / qr modes share the URL + poll modal (qr providers hand back the
  // login page URL the same way).
  //
  // ⚠️ 先选后开：开页发生在**服务端建号那一刻**（handler 按请求里的选择调
  // OpenURLWithBrowser），所以浏览器/会话必须在 login 请求之前选好 —— 先建号
  // 再问用户就会开错页（或开两次）。
  try {
    __jethubState.loginChoices = await __jethubLoadLoginChoices();
    __jethubState.loginChoice = null;
    __jethubLoginModal(providerId);
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

// __jethubLoadLoginChoices loads the browser axis (installed browsers + the OS
// default + the remembered selection). Any failure degrades to the legacy
// default (system browser, shared session): this RPC must never block a login.
async function __jethubLoadLoginChoices() {
  var out = { browsers: [], def: {}, prefs: {} };
  try {
    var r = await apiGet('/jethub/login-browsers');
    if (r && !r.error) {
      out.browsers = r.browsers || [];
      out.def = r.defaultBrowser || {};
      out.prefs = r.prefs || {};
    }
  } catch (e) { /* degrade to the legacy default */ }
  return out;
}

// __jethubLoginPrivateOk: whether the private session can be offered for a
// browser axis value. A custom path cannot be classified in the browser (the
// server owns the engine table), so it stays selectable and any refusal comes
// back as a clear error on confirm.
function __jethubLoginPrivateOk(choices, browser) {
  if (browser === 'default') return !!(choices.def || {}).privateOk;
  var hit = (choices.browsers || []).filter(function(b) { return b.id === browser; })[0];
  if (hit) return !!hit.privateOk;
  return true;
}

// __jethubSetOptionDisabled：`renderCustomSelectHtml` 不支持 per-option disabled，
// 所以把状态写在**隐藏的原生 `<option>`** 上（`toggleCustomSelect` 每次展开都会
// 按原生 option 重新同步自定义行的禁用态），同时立刻镜像到自定义行，避免「展开前
// 看着能点」。被禁用的项选不动：`selectCustomOption` 会拒绝。
function __jethubSetOptionDisabled(selectId, value, disabled) {
  var sel = document.getElementById(selectId);
  if (!sel) return;
  var opts = sel.querySelectorAll ? sel.querySelectorAll('option') : [];
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].value === value) opts[i].disabled = !!disabled;
  }
  var wrap = sel.parentNode; // .custom-select-wrapper
  var rows = (wrap && wrap.querySelectorAll) ? wrap.querySelectorAll('.custom-select-option') : [];
  for (var j = 0; j < rows.length; j++) {
    if (rows[j].getAttribute('data-value') !== value) continue;
    if (disabled) {
      rows[j].classList.add('disabled');
      rows[j].style.opacity = '0.4';
      rows[j].style.pointerEvents = 'none';
    } else {
      rows[j].classList.remove('disabled');
      rows[j].style.opacity = '';
      rows[j].style.pointerEvents = '';
    }
  }
}

// __jethubSyncLoginForm: keeps the custom-path row, the private option and the
// session hint in sync with the current selects. Wired as the hidden native
// selects' onchange (the project's custom-select component dispatches change on
// pick), so it runs for real user picks — not just for programmatic ones.
function __jethubSyncLoginForm() {
  var choices = __jethubState.loginChoices || { browsers: [], def: {}, prefs: {} };
  var bSel = document.getElementById('free-hub-login-browser');
  var sSel = document.getElementById('free-hub-login-session');
  if (!bSel || !sSel) return;
  var pathRow = document.getElementById('free-hub-login-path-row');
  if (pathRow) pathRow.style.display = (bSel.value === 'custom') ? '' : 'none';
  var ok = __jethubLoginPrivateOk(choices, bSel.value);
  __jethubSetOptionDisabled('free-hub-login-session', 'private', !ok);
  if (!ok && sSel.value === 'private') {
    // 该内核的隐私开关未知 ⇒ 退回共享登录态（更新隐藏 select + 触发标签）。
    sSel.value = 'shared';
    if (typeof selectCustomOption === 'function') {
      selectCustomOption('free-hub-login-session-wrap', 'shared', t('freeHubLoginSessionShared'));
    }
  }
  var warn = document.getElementById('free-hub-login-warn');
  if (warn) warn.textContent = ok ? '' : t('freeHubLoginPrivateOff');
  var hint = document.getElementById('free-hub-login-session-hint');
  if (hint) {
    hint.textContent = sSel.value === 'private' ? t('freeHubLoginPrivateHint')
      : (sSel.value === 'isolated' ? t('freeHubLoginIsolatedHint') : '');
  }
}

// __jethubReadLoginChoice reads the two axes from the dialog.
function __jethubReadLoginChoice() {
  var b = document.getElementById('free-hub-login-browser');
  var s = document.getElementById('free-hub-login-session');
  var p = document.getElementById('free-hub-login-browser-path');
  var browser = (b && b.value) || 'default';
  return {
    browser: browser,
    browserPath: browser === 'custom' ? ((p && p.value) || '').trim() : '',
    session: (s && s.value) || 'shared',
  };
}

// __jethubLoginModal: 步骤 1 —— 选择浏览器（默认 / 已检测到的 / 自定义路径）与
// 会话模式（共享登录态 / 隐私窗口 / 独立配置）。此时**还没有占位账号**（建号
// 发生在确认之后），所以取消只是关闭弹窗。
function __jethubLoginModal(providerId) {
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  var choices = __jethubState.loginChoices || { browsers: [], def: {}, prefs: {} };
  var prefs = choices.prefs || {};
  var selBrowser = prefs.browser || 'default';
  var selSession = prefs.session || 'shared';
  var defLabel = t('freeHubLoginBrowserDefault') + (choices.def && choices.def.label ? ' — ' + choices.def.label : '');

  // 两个下拉都用项目自定义组件（`renderCustomSelectHtml`，app.js）——原生
  // `<select>` 只在组件内部作隐藏的取值载体（`.modal .custom-select-*` 的样式
  // 见 style.css，基础样式在 style-download.css，经 style.css @import 全局可用）。
  var browserOpts = [{ value: 'default', label: defLabel }];
  (choices.browsers || []).forEach(function(b) {
    browserOpts.push({ value: b.id, label: b.label });
  });
  browserOpts.push({ value: 'custom', label: t('freeHubLoginBrowserCustom') });

  var sessionOpts = [
    { value: 'shared', label: t('freeHubLoginSessionShared') },
    { value: 'private', label: t('freeHubLoginSessionPrivate') },
    { value: 'isolated', label: t('freeHubLoginSessionIsolated') },
  ];

  overlay.innerHTML =
    '<div class="modal" style="max-width:520px;">' +
      '<div class="modal-title">' + escapeHtml(t('freeHubLoginTitle')) + '</div>' +
      '<div class="modal-body" style="margin-top:12px;">' +
        '<div class="free-hub-hint">' + escapeHtml(t('freeHubLoginChooseHint')) + '</div>' +
        '<label class="free-hub-hint" style="display:block;margin-top:10px">' + escapeHtml(t('freeHubLoginBrowser')) + '</label>' +
        renderCustomSelectHtml('free-hub-login-browser-wrap', 'free-hub-login-browser', browserOpts, selBrowser, '__jethubSyncLoginForm()') +
        '<div id="free-hub-login-path-row" style="display:none;margin-top:8px">' +
          '<input type="text" class="input" id="free-hub-login-browser-path" placeholder="' + escapeAttr(t('freeHubLoginBrowserPath')) + '" style="width:100%">' +
        '</div>' +
        '<label class="free-hub-hint" style="display:block;margin-top:10px">' + escapeHtml(t('freeHubLoginSession')) + '</label>' +
        renderCustomSelectHtml('free-hub-login-session-wrap', 'free-hub-login-session', sessionOpts, selSession, '__jethubSyncLoginForm()') +
        '<div id="free-hub-login-session-hint" class="free-hub-hint"></div>' +
        '<div id="free-hub-login-warn" class="free-hub-hint"></div>' +
      '</div>' +
      '<div class="modal-footer"><button type="button" class="btn btn-ghost" id="free-hub-login-cancel">' + escapeHtml(t('cancel')) + '</button>' +
      '<button type="button" class="btn btn-primary" id="free-hub-login-confirm">' + escapeHtml(t('freeHubLoginConfirm')) + '</button></div>' +
    '</div>';
  overlay.classList.add('show');
  // 取消 = 放弃：没有占位账号需要清理（尚未建号）。
  document.getElementById('free-hub-login-cancel').onclick = function() {
    overlay.classList.remove('show'); overlay.innerHTML = '';
  };
  document.getElementById('free-hub-login-confirm').onclick = function() { jethubLoginConfirm(providerId); };
  __jethubSyncLoginForm();
}

// jethubLoginConfirm: 步骤 2 —— 带上选择发起登录（服务端据此建号并开页），然后
// 切到等待态轮询。选择不可用时服务端返回 400 并带上原因（弹窗保持打开可改选）。
async function jethubLoginConfirm(providerId) {
  var choice = __jethubReadLoginChoice();
  if (choice.browser === 'custom' && !choice.browserPath) {
    toast(t('freeHubLoginBrowserPath'), 'error');
    return;
  }
  try {
    var created = await apiPost('/jethub/' + encodeURIComponent(providerId) + '/login', choice);
    if (created && created.error) { toast(t('failed', [created.error]), 'error'); return; }
    __jethubState.loginChoice = choice;
    __jethubLoginWaitingModal(providerId, created);
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

// __jethubLoginWaitingModal: 步骤 3 —— 等待授权（轮询 status）。取消 = 放弃登录：
// 停轮询 + 删除占位账号（服务端失败路径同样会删）。
function __jethubLoginWaitingModal(providerId, created) {
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  var choice = __jethubState.loginChoice || {};
  overlay.innerHTML =
    '<div class="modal" style="max-width:520px;">' +
      '<div class="modal-title">' + escapeHtml(t('freeHubLoginTitle')) + '</div>' +
      '<div class="modal-body" style="margin-top:12px;">' +
        '<div class="free-hub-hint">' + escapeHtml(t('freeHubLoginHint')) + '</div>' +
        '<button type="button" class="btn btn-sm" id="free-hub-login-reopen" style="margin-top:8px">' + escapeHtml(t('freeHubLoginReopen')) + '</button>' +
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
  // 重新打开：走服务端（按本次选择开页）。⚠️ 不能只用 <a target="_blank">——那由
  // UI 宿主决定浏览器（webview 变体里还会被拦到系统默认浏览器），选定的模式会失效。
  document.getElementById('free-hub-login-reopen').onclick = function() {
    apiPost('/jethub/open-login-url', {
      url: created.loginUrl || '',
      browser: choice.browser || 'default',
      browserPath: choice.browserPath || '',
      session: choice.session || 'shared'
    }).then(function(r) {
      if (r && r.error) toast(t('failed', [r.error]), 'error');
    }).catch(function(e) { toast(t('failed', [e.message]), 'error'); });
  };
  // 轮询结束（成功/失败/会话已回收）都要收尾：停 timer + 关弹窗 + 刷新列表。
  var finish = function(toastText, tone) {
    if (__jethubState.pollTimer) { clearInterval(__jethubState.pollTimer); __jethubState.pollTimer = null; }
    overlay.classList.remove('show'); overlay.innerHTML = '';
    if (toastText) toast(toastText, tone);
    jethubSelect(providerId);
  };
  __jethubState.pollTimer = setInterval(async function() {
    try {
      var st = await apiGet('/jethub/' + encodeURIComponent(providerId) + '/status?loginId=' + encodeURIComponent(created.loginId));
      // ⚠️ 判据顺序即契约：先认 `done`（服务端 pollLogin 的三态：false=进行中、
      // true+success、true+error=已失败），**再**看 `error`。两者的 `error` 字段
      // 长相相同但语义完全不同 —— 已结算的失败是 `{done:true,success:false,error}`
      // （必须带原因收尾），而会话已回收是 `{error:"unknown or settled loginId"}`
      // 且**没有** `done`（结果再也读不到了）。
      if (st.done === true) {
        if (st.success) {
          finish(t('freeHubLoginOk'), 'success');
        } else {
          finish(t('freeHubLoginFailed', [st.error || '']), 'error');
        }
        return;
      }
      if (st.done === false) return; // 进行中：继续轮询
      if (st.error) {
        // 404 = 会话已被回收（结算后 30s 宽限期内没被观察到，或 id 已失效）：
        // **必须收尾**。此前这里只把错误文案写进状态行、然后继续每 2s 空转 ——
        // 用户看到的就是「弹窗长时间没有任何反应、账号也没刷新」，而登录可能
        // 其实已经成功、凭据已经落盘（真实缺陷 19 的第二道症状；第一道是服务端
        // 漏了 loginId 分支，见 internal/api/jethub/loomy.go 的 loomyStatus）。
        // 会话没了就再也读不到结果，只能让用户看列表（成功则账号卡已在列表里）。
        finish(t('freeHubLoginGone'), 'error');
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
  // ⚠️ msgid 是发码与提交之间的**唯一关联**（loomy 的 /login/phone/checkCode 必填，
  // 缺了会得到一个毫不相关的「msgid 无效」）。此前前端把发码响应丢掉、提交时也不带
  // msgid ⇒ 这条短信路径必然失败。
  var smsMsgID = '';
  document.getElementById('free-hub-sms-send').onclick = async function() {
    try {
      var res = await apiPost('/jethub/' + encodeURIComponent(providerId) + '/login/sms/send', { phone: document.getElementById('free-hub-sms-phone').value.trim() });
      smsMsgID = (res && res.msgid) || '';
      if (!smsMsgID) { toast(t('failed', [t('freeHubSmsNoMsgID')]), 'error'); return; }
      toast(t('freeHubSmsSend'), 'success');
    } catch (e) { toast(t('failed', [e.message]), 'error'); }
  };
  document.getElementById('free-hub-sms-submit').onclick = async function() {
    if (!smsMsgID) { toast(t('failed', [t('freeHubSmsSendFirst')]), 'error'); return; }
    try {
      await apiPost('/jethub/' + encodeURIComponent(providerId) + '/login/sms/submit', {
        accountId: accountId,
        phone: document.getElementById('free-hub-sms-phone').value.trim(),
        code: document.getElementById('free-hub-sms-code').value.trim(),
        msgid: smsMsgID,
      });
      overlay.classList.remove('show'); overlay.innerHTML = '';
      toast(t('freeHubLoginOk'), 'success');
      jethubSelect(providerId);
    } catch (e) { toast(t('failed', [e.message]), 'error'); }
  };
}

// apikey 登录模式（opencode）：粘贴 Zen API Key；或添加匿名通道（无需 Key，
// 仅免费模型）。⚠️ 端点与其它 provider 的 `/jethub/{provider}/login` 同形，
// 只是 body 语义不同（无 loginId ⇒ 不需要弹窗轮询）。
function __jethubApiKeyModal(providerId) {
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  overlay.innerHTML =
    '<div class="modal" style="max-width:480px;">' +
      '<div class="modal-title">' + escapeHtml(t('freeHubApiKeyTitle')) + '</div>' +
      '<div class="modal-body" style="margin-top:12px;">' +
        '<div class="free-hub-hint">' + escapeHtml(t('freeHubApiKeyHint')) + '</div>' +
        '<input type="text" class="input" id="free-hub-apikey" placeholder="' + escapeAttr(t('freeHubApiKeyPlaceholder')) + '" style="width:100%;margin-top:8px">' +
        '<input type="text" class="input" id="free-hub-apikey-nick" placeholder="' + escapeAttr(t('freeHubApiKeyNickname')) + '" style="width:100%;margin-top:8px">' +
        '<div class="free-hub-hint" style="margin-top:12px">' + escapeHtml(t('freeHubAnonHint')) + '</div>' +
        '<button type="button" class="btn btn-sm" id="free-hub-anon-add" style="margin-top:6px">' + escapeHtml(t('freeHubAnonAdd')) + '</button>' +
      '</div>' +
      '<div class="modal-footer"><button type="button" class="btn btn-ghost" id="free-hub-apikey-cancel">' + escapeHtml(t('cancel')) + '</button>' +
      '<button type="button" class="btn btn-primary" id="free-hub-apikey-submit">' + escapeHtml(t('freeHubApiKeySubmit')) + '</button></div>' +
    '</div>';
  overlay.classList.add('show');
  var close = function() { overlay.classList.remove('show'); overlay.innerHTML = ''; };
  document.getElementById('free-hub-apikey-cancel').onclick = close;
  var submit = async function(body) {
    try {
      var res = await apiPost('/jethub/' + encodeURIComponent(providerId) + '/login', body);
      close();
      toast(res && res.reused ? t('freeHubApiKeyReused') : t('freeHubLoginOk'), 'success');
      jethubSelect(providerId);
    } catch (e) { toast(t('failed', [e.message]), 'error'); }
  };
  document.getElementById('free-hub-apikey-submit').onclick = function() {
    var key = document.getElementById('free-hub-apikey').value.trim();
    if (!key) { toast(t('failed', [t('freeHubApiKeyEmpty')]), 'error'); return; }
    submit({ apiKey: key, nickname: document.getElementById('free-hub-apikey-nick').value.trim() });
  };
  document.getElementById('free-hub-anon-add').onclick = function() { submit({ anonymous: true }); };
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
  // 调用前缀：模型 id 的可复制形态是 `{prefix}/{id}`（与 Settings 的
  // provider detail 里点模型 id 复制的**同一个值**，可直接粘进外部客户端调用）。
  // 未设前缀（未桥接）时退回裸 id —— 那种情况下本来也无从调用。
  var prefix = provider.prefix ? String(provider.prefix) : '';
  return models.map(function(m) {
    var mid = escapeHtml(m.id);
    var midJs = escapeForJsString(m.id);
    // 展示形态与插件一致：`模型名称 · 倍率`（无倍率时只有名称，绝不补 ` · `），
    // 紧跟着 `模型 id` —— 插件的面板就是「一条最终展示名 + 裸 id」两段
    // （ref plugin-src/client/jet-hub.js 的 ModelToggle）：
    //   <strong>{model.name}</strong><code>{model.id}</code>
    // 而适配器的 model.name 里已经拼好了倍率（buddy/lobsterai/cline/qoder/
    // raccoon/loomy/trae 各自的 displayName 函数）。
    var nameText = (m.name || m.id) + (m.rate ? ' · ' + m.rate : '');
    var callId = (prefix ? prefix + '/' : '') + m.id;
    var callIdJs = escapeForJsString(callId);
    var selected = !!__jethubState.modelSelected[m.id];
    var cls = 'free-hub-model-row' + (m.disabled ? ' hidden-model' : '') + (batch && selected ? ' batch-selected' : '');
    var row =
      '<div class="' + cls + '" data-mid="' + mid + '">' +
        (batch ? '<input type="checkbox"' + (selected ? ' checked' : '') + ' onchange="jethubBatchToggle(\'' + midJs + '\')">' : '') +
        '<span class="free-hub-model-name" data-tooltip="' + escapeAttr(nameText) + '">' + escapeHtml(nameText) + '</span>' +
        '<span class="code free-hub-model-id copyable" onclick="copyToClipboard(\'' + callIdJs + '\')" data-tooltip="' + escapeAttr(t('clickToCopy')) + '">' + mid + '</span>';
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
    // 服务端的 outcome.message 是**判据所在**（例如 Qoder「今天的每日活动尚未
    // 刷新（每日 10:00 UTC+8）」与「今天已领取」是两件不同的事；误报已领会让人
    // 真的错过当天额度）。有 message 就照实显示，按 kind 决定色调。
    if (outcome.message) {
      var tone = outcome.kind === 'failed' ? 'error' : (outcome.kind === 'claimed' ? 'success' : 'info');
      toast(outcome.message, tone);
      return;
    }
    var granted = (outcome.claimed !== undefined ? outcome.claimed : outcome.claimResults) || outcome.status;
    toast(t('freeHubClaimOk', [typeof granted === 'object' ? JSON.stringify(granted).slice(0, 120) : String(granted || t('freeHubClaimNone'))]), 'success');
  } catch (e) {
    var msg = (e && e.message) || '';
    toast(/already|claimed|已领|幂等|alreadyProcessed/i.test(msg) ? t('freeHubClaimNone') : t('failed', [msg]), 'error');
  }
}

// jethubClaimOnboarding: 一次性新手任务（仅 loomy；8 个任务合计 10000 分，每号
// 只能领一次）。⚠️ 与「一键领取积分」（每日签到）是**不同**的操作：混在一起会让
// 每天对已领完的账号发 8 个必然 alreadyCompleted 的请求。
async function jethubClaimOnboarding(providerId, accountId) {
  __jethubSetNotice({ tone: 'info', text: t('freeHubClaimRunning') });
  try {
    var data = await apiPost('/jethub/' + encodeURIComponent(providerId) + '/onboarding/claim', { accountId: accountId });
    var claimed = (data && (data.claimed || data.claimedTasks)) || [];
    var earned = data && data.earned;
    __jethubSetNotice({
      tone: 'success',
      text: t('freeHubOnboardingDone', [String(claimed.length || 0), String(earned === undefined ? 0 : earned)]),
    });
  } catch (e) {
    __jethubSetNotice({ tone: 'error', text: t('failed', [e.message]) });
  }
}

// jethubSetAccountProxy: 设置/清除该账号自己的出口代理（仅 opencode）。
//
// ⚠️ 空串 = **清除**（回到与其它无代理账号共享本机出口），这是一个合法且常用的
// 操作，不能因为「输入为空」就当成取消。
async function jethubSetAccountProxy(accountId) {
  var account = __jethubState.accounts.find(function(a) { return a.id === accountId; }) || {};
  var value = await promptModal(t('freeHubAccountProxy'), account.opencodeProxy || '', t('freeHubAccountProxyHint'));
  if (value === null) return; // 用户取消（区别于「输入空串 = 清除」）
  try {
    var res = await apiPut('/jethub/opencode/proxy', { accountId: accountId, proxy: String(value).trim() });
    if (res && res.accounts) __jethubState.accounts = res.accounts;
    __jethubRerenderAccounts();
    toast(String(value).trim() ? t('freeHubAccountProxySaved') : t('freeHubAccountProxyCleared'), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

// jethubRotateFingerprint: 轮换 opencode 账号的指纹（+1 代次 ⇒ 新 project id）。
// ⚠️ 与「换出口代理」不同：**指纹分离不增加配额**（匿名通道按出口 IP 限额）。
async function jethubRotateFingerprint(accountId) {
  var ok = await confirmModal(t('freeHubFingerprintConfirm'));
  if (!ok) return;
  try {
    var res = await apiPost('/jethub/opencode/fingerprint/rotate', { accountId: accountId });
    if (res && res.accounts) __jethubState.accounts = res.accounts;
    __jethubRerenderAccounts();
    toast(t('freeHubFingerprintDone', [String((res && res.generation) || 0)]), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
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
