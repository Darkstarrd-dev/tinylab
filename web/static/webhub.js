// ===================== Web Hub (webhub) — browser-driven sites ==============
// Vanilla JS. Embedded INSIDE the Free Hub page: the left pane gets a divider
// with the jethub providers above and the webhub sites below; the shared right
// pane renders the site detail. Nothing here adds a sidebar row — the entry
// stays the Free Hub row (需求 1).
//
// Mechanism difference that shapes this whole file (architecture §1):
//   jethub = HTTP protocol bridge (credentials on disk, account cards, credits)
//   webhub = browser page driver  (NO credential, NO account, NO credits)
// So the right pane shows: ① call prefix → ② site status → ③ actions
// (open / check / clear prefix) → ④ model IDs → ⑤ notice. Deliberately absent:
// account cards, credits/sign-in, rate-limit retest, backup.

var __webhubState = {
  sites: [], selected: null, available: true,
  probing: false, lastOk: {},
};

// webhubLoadSites fetches the site list. A 503 (Web Hub unwired) is not an
// error to shout about — it just means the section stays empty.
async function webhubLoadSites() {
  try {
    var data = await apiGet('/webhub/sites');
    __webhubState.sites = data.sites || [];
    __webhubState.available = true;
  } catch (e) {
    __webhubState.available = false;
    __webhubState.sites = [];
  }
}

// webhubRenderSiteGroup renders the left-pane site rows (below the divider).
function webhubRenderSiteGroup() {
  var el = document.getElementById('free-hub-providers');
  if (!el) return;
  if (!__webhubState.sites.length) return;
  var html = '<div class="free-hub-divider"><span>' + escapeHtml(t('webHubGroup')) + '</span></div>';
  html += __webhubState.sites.map(function (s) {
    return '<div class="free-hub-provider' + (s.id === __webhubState.selected ? ' selected' : '') + '"' +
      ' onclick="webhubSelect(\'' + escapeForJsString(s.id) + '\')">' +
      '<span class="free-hub-provider-name">' + escapeHtml(s.displayName || s.id) + '</span>' +
      webhubStatusBadge(s) +
      '</div>';
  }).join('');
  el.insertAdjacentHTML('beforeend', html);
}

// webhubStatusBadge renders a SITE-SEMANTIC badge (未启用/未连接/已就绪/未登录)
// — NOT the jethub account-count badge: a site has no accounts.
function webhubStatusBadge(s) {
  var cls = 'badge-inactive', text;
  if (!s.prefix) { text = t('webHubNotReady'); }
  else if (!s.ready) { cls = 'badge-warn'; text = s.connected ? t('webHubNoTab') : t('webHubDisconnected'); }
  else { cls = 'badge-active'; text = t('webHubReady'); }
  return '<span class="badge ' + cls + '">' + escapeHtml(text) + '</span>';
}

async function webhubSelect(siteId) {
  __webhubState.selected = siteId;
  // Re-render the left pane so the shared single-selection stays correct.
  __jethubRenderProviders();
  webhubRenderSiteGroup();
  var detail = document.getElementById('free-hub-detail');
  if (!detail) return;
  var site = __webhubState.sites.find(function (x) { return x.id === siteId; }) || {};
  try {
    var st = await apiGet('/webhub/sites/' + encodeURIComponent(siteId) + '/status');
    site.connected = st.connected; site.ready = st.attached;
    site.tabUrl = st.tabUrl; site.lastOkMs = st.lastOkMs;
    site.prefix = st.prefix; site.bridged = st.bridged;
  } catch (e) { /* keep the list snapshot */ }
  webhubRenderDetail(site);
}

function webhubRenderDetail(site) {
  var detail = document.getElementById('free-hub-detail');
  if (!detail) return;
  var sid = escapeForJsString(site.id);
  var prefix = site.prefix || '';
  detail.innerHTML =
    // ① prefix
    '<div class="free-hub-section"><div class="free-hub-section-title">' + escapeHtml(t('webHubPrefixTitle')) + '</div>' +
      '<div class="free-hub-prefix-row">' +
        '<input type="text" class="input" id="webhub-prefix-input" value="' + escapeAttr(prefix) + '" placeholder="e.g. deepseek" data-tooltip="' + escapeAttr(t('webHubPrefixHint')) + '">' +
        '<button type="button" class="btn btn-primary btn-sm" onclick="webhubSavePrefix(\'' + sid + '\')">' + escapeHtml(t('webHubPrefixSave')) + '</button>' +
        (site.bridged ? '<button type="button" class="btn btn-sm" onclick="webhubClearPrefix(\'' + sid + '\')">' + escapeHtml(t('webHubPrefixClear')) + '</button>' : '') +
      '</div>' +
      '<div class="free-hub-hint">' + escapeHtml(t('webHubPrefixHint')) + '</div>' +
    '</div>' +
    // ② status
    '<div class="free-hub-section"><div class="free-hub-section-title">' + escapeHtml(t('webHubStatusTitle')) + '</div>' +
      webhubStatusRows(site) +
    '</div>' +
    // ③ actions
    '<div class="free-hub-section"><div class="free-hub-actions">' +
      '<button type="button" class="btn btn-sm" data-tooltip="' + escapeAttr(t('webHubOpenHint')) + '" onclick="webhubOpen(\'' + sid + '\')">' + escapeHtml(t('webHubOpen')) + '</button>' +
      '<button type="button" class="btn btn-sm" data-tooltip="' + escapeAttr(t('webHubProbeHint')) + '" onclick="webhubProbe(\'' + sid + '\')"' + (__webhubState.probing ? ' disabled' : '') + '>' +
        escapeHtml(__webhubState.probing ? t('webHubProbing') : t('webHubProbe')) + '</button>' +
    '</div>' +
      '<div class="free-hub-hint">' + escapeHtml(t('webHubLoginHint')) + '</div>' +
      '<div class="free-hub-hint">' + escapeHtml(t('webHubSerialHint')) + '</div>' +
    '</div>' +
    '<div id="webhub-notice"></div>' +
    // ④ model IDs
    '<div class="free-hub-section"><div class="free-hub-section-title">' +
      escapeHtml(t('webHubModelsTitle')) + ' (' + ((site.modelIds || []).length) + ')' +
      (site.presetCount > 1 ? ' · ' + escapeHtml(t('webHubPresets', [site.presetCount])) : '') +
    '</div>' +
      '<div class="free-hub-models-hint">' + escapeHtml(t('webHubModelsHint')) + '</div>' +
      webhubModelRows(site) +
    '</div>';
}

function webhubStatusRows(site) {
  var rows = [
    [t('webHubConnected'), site.connected ? t('yes') : t('no')],
    [t('webHubAttached'), site.ready ? t('yes') : t('no')],
    [t('webHubLastOk'), site.lastOkMs ? formatDateTime(new Date(site.lastOkMs)) : t('webHubNeverOk')],
  ];
  if (site.tabUrl) rows.push([t('webHubAttached'), escapeHtml(site.tabUrl)]);
  var html = rows.map(function (r) {
    return '<div class="webhub-status-row"><span class="webhub-status-key">' + r[0] + '</span>' +
      '<span class="webhub-status-val">' + r[1] + '</span></div>';
  }).join('');
  if (site.hasSelectors === false) {
    html += '<div class="free-hub-hint">' + escapeHtml(t('webHubNoSelectors')) + '</div>';
  }
  return html;
}

function webhubModelRows(site) {
  var ids = site.modelIds || [];
  if (!ids.length) return '<div class="free-hub-hint">' + escapeHtml(t('freeHubModelsEmpty')) + '</div>';
  return '<div class="free-hub-model-list">' + ids.map(function (id) {
    var idJs = escapeForJsString(id);
    return '<div class="free-hub-model-row">' +
      '<span class="code free-hub-model-id copyable" onclick="copyToClipboard(\'' + idJs + '\')" data-tooltip="' + escapeAttr(t('clickToCopy')) + '">' + escapeHtml(id) + '</span>' +
      '</div>';
  }).join('') + '</div>';
}

function webhubSetNotice(notice) {
  var el = document.getElementById('webhub-notice');
  if (!el) return;
  if (!notice) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="free-hub-notice" data-tone="' + escapeAttr(notice.tone || '') + '">' +
    '<div>' + notice.text + '</div></div>';
}

// ⚠️ 路由形状必须与 Go 声明一致（/webhub/sites/{site}/...）—— jethub 缺陷
// 6/14 是同一坑复发两次，漏掉 sites/ 会拿到 chi 的纯文本 404。
async function webhubSavePrefix(siteId) {
  var input = document.getElementById('webhub-prefix-input');
  var prefix = (input && input.value || '').trim();
  try {
    var r = await apiPut('/webhub/sites/' + encodeURIComponent(siteId) + '/prefix', { prefix: prefix });
    if (r.error) throw new Error(r.error);
    await webhubRefresh();
    if (prefix) toast(t('webHubPrefixSaved', [(r.modelIds || [])[0] || (prefix + '/')]), 'success');
    else toast(t('webHubPrefixCleared'), 'success');
  } catch (e) {
    toast(t('webHubFailed', [e.message]), 'error');
  }
}

async function webhubClearPrefix(siteId) {
  try {
    await apiDelete('/webhub/sites/' + encodeURIComponent(siteId) + '/prefix');
    await webhubRefresh();
    toast(t('webHubPrefixCleared'), 'success');
  } catch (e) { toast(t('webHubFailed', [e.message]), 'error'); }
}

async function webhubOpen(siteId) {
  try {
    var r = await apiPost('/webhub/sites/' + encodeURIComponent(siteId) + '/open', {});
    if (r && r.error) throw new Error(r.error);
    toast(t('webHubOpened'), 'success');
  } catch (e) { toast(t('webHubFailed', [e.message]), 'error'); }
}

async function webhubProbe(siteId) {
  if (__webhubState.probing) return;
  __webhubState.probing = true;
  var site = __webhubState.sites.find(function (x) { return x.id === siteId; }) || {};
  webhubRenderDetail(site);
  webhubSetNotice({ tone: 'info', text: escapeHtml(t('webHubProbing')) });
  try {
    var r = await apiPost('/webhub/sites/' + encodeURIComponent(siteId) + '/probe', {});
    if (r.ok) {
      webhubSetNotice({ tone: 'ok', text: escapeHtml(t('webHubProbeOk', [r.firstContent || r.elapsedMs || 0])) });
    } else {
      webhubSetNotice({ tone: 'error', text: escapeHtml(t('webHubProbeFailed', [r.error || 'unknown'])) });
    }
    await webhubRefresh();
  } catch (e) {
    webhubSetNotice({ tone: 'error', text: escapeHtml(t('webHubProbeFailed', [e.message])) });
  }
  __webhubState.probing = false;
  var s2 = __webhubState.sites.find(function (x) { return x.id === siteId; }) || {};
  webhubRenderDetail(s2);
}

// webhubRefresh reloads the list and re-renders (selection preserved).
async function webhubRefresh() {
  var sel = __webhubState.selected;
  await webhubLoadSites();
  __webhubState.selected = sel;
  __jethubRenderProviders();
  webhubRenderSiteGroup();
  var site = __webhubState.sites.find(function (x) { return x.id === sel; });
  if (site) webhubRenderDetail(site);
}
