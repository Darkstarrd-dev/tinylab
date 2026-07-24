// ===================== Providers Page =====================

var expandedModelDetails = new Set();
var allKeysTestResults = {};
var batchManageMode = false;
var batchSelectedModels = new Set();

async function renderProviders(c) {
  if (currentProviderId) {
    showSkeleton(c, 1);
    await renderProviderDetail(c, currentProviderId);
    return;
  }
  showSkeleton(c, 3);
  const data = await apiGet('/providers');
  providersCache = data.providers || [];
  c.innerHTML = '\
    <h2>' + t('providers') + '</h2>\
    <button type="button" class="btn btn-primary mb-12" onclick="showAddProvider()">' + t('addProvider') + '</button>\
    <div id="provider-list"></div>\
    <div id="provider-form" style="display:none"></div>';
  renderProviderList();
}

function renderProviderList() {
  const el = document.getElementById('provider-list');
  if (providersCache.length === 0) {
    el.innerHTML = emptyState(t('noProviders'));
    return;
  }
  el.innerHTML = providersCache.map(function(p) {
    return '\
    <div class="card provider-card">\
      <div class="provider-card-row">\
        <div class="provider-card-left">\
          <span class="code provider-prefix-tag">' + escapeHtml(p.prefix) + '</span>\
          <span class="card-title">' + escapeHtml(p.name) + '</span>\
        </div>\
        <div class="provider-card-actions">\
          <span class="badge provider-btn-col1 ' + (p.isActive ? 'badge-active' : 'badge-inactive') + '">' + (p.isActive ? t('active') : t('inactive')) + '</span>\
          <button type="button" class="btn btn-sm provider-btn-col2" onclick="toggleProviderList(event, \'' + p.id + '\',' + (!p.isActive) + ')">' + (p.isActive ? t('disable') : t('enable')) + '</button>\
        </div>\
      </div>\
      <div class="provider-card-row mt-12">\
        <div class="provider-card-left">\
          <span class="muted">' + t('keys') + ' ' + (p.keys ? p.keys.length : 0) + ' | ' + t('models') + ' ' + (p.models ? p.models.length : 0) + '</span>\
        </div>\
        <div class="provider-card-actions">\
          <button type="button" class="btn btn-sm provider-btn-col1" onclick="event.stopPropagation(); openProviderDetail(\'' + p.id + '\')">' + t('edit') + '</button>\
          <button type="button" class="btn btn-sm btn-danger provider-btn-col2" onclick="deleteProviderFromList(event, \'' + p.id + '\')">' + t('delete') + '</button>\
        </div>\
      </div>\
    </div>';
  }).join('');
}

async function deleteProviderFromList(event, id) {
  if (event) event.stopPropagation();
  const ok = await confirmModal(t('confirmDeleteProvider'));
  if (!ok) return;
  await apiDelete('/providers/' + id);
  providersCache = providersCache.filter(function(x) { return x.id !== id; });
  renderProviderList();
  toast(t('providerDeleted'), 'success');
}

function openProviderDetail(id) {
  currentProviderId = id;
  renderProviders(document.getElementById('page-content'));
}

async function toggleProviderList(event, id, active) {
  event.stopPropagation();
  var p = providersCache.find(function(x) { return x.id === id; });
  if (!p) return;
  p.isActive = active;
  await apiPut('/providers/' + id, p);
  renderProviderList();
  toast(active ? t('providerEnabled') : t('providerDisabled'), 'success');
}

function backToProviderList() {
  currentProviderId = null;
  providerDetailCache = null;
  expandedModelDetails = new Set();
  allKeysTestResults = {};
  navigateTo('endpoint');
}

function showAddProvider() {
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '<div class="modal" style="max-width:520px">\
    <div class="modal-title">' + t('newProvider') + '</div>\
    <div class="flex" style="gap:12px">\
      <div class="form-group" style="flex:1"><label for="p-name">' + t('name') + '</label><input id="p-name" placeholder="DeepSeek"></div>\
      <div class="form-group" style="flex:1"><label for="p-prefix">' + t('prefixLabel') + '</label><input id="p-prefix" placeholder="deepseek"></div>\
    </div>\
    <div class="form-group"><label for="p-url">' + t('baseUrlLabel') + '</label><input id="p-url" placeholder="https://api.deepseek.com  或  https://host/v1beta/openai"></div>\
    <div class="form-hint" style="margin-top:-6px;margin-bottom:12px">' + t('baseUrlHint') + '</div>\
    <div class="form-group"><label for="p-apikey">' + t('apiKeyLabel') + '</label><input type="password" id="p-apikey" placeholder="sk-..."></div>\
    <div class="form-group"><label for="p-modelid">' + t('modelIdLabel') + '</label><input id="p-modelid" placeholder="deepseek-chat"></div>\
    <div class="form-group" style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;margin-bottom:0">\
      <div>\
        <label style="margin-bottom:2px;display:block">' + t('useProxy') + '</label>\
        <div class="form-hint" style="margin-top:2px">' + t('useProxyDesc') + '</div>\
      </div>\
      <label class="toggle-switch" for="p-useproxy" style="flex-shrink:0;margin-left:16px">\
        <input type="checkbox" id="p-useproxy">\
        <span class="toggle-slider"></span>\
      </label>\
    </div>\
    <div id="p-check-result" class="mt-12"></div>\
    <div class="modal-footer">\
      <button type="button" class="btn" onclick="closeModalOverlay()">' + t('cancel') + '</button>\
      <button type="button" class="btn" onclick="withLoading(this, () => checkProvider())">' + t('check') + '</button>\
      <button type="button" class="btn btn-primary" onclick="withLoading(this, () => addProvider())">' + t('create') + '</button>\
    </div>\
  </div>';
  requestAnimationFrame(function() { overlay.classList.add('show'); });
}

async function checkProvider() {
  const baseUrl = document.getElementById('p-url').value.trim();
  const apiKey = document.getElementById('p-apikey').value.trim();
  const modelId = document.getElementById('p-modelid').value.trim();
  const resultEl = document.getElementById('p-check-result');
  if (!baseUrl || !apiKey) {
    resultEl.innerHTML = '<span class="badge badge-invalid">' + t('baseUrlKeyRequired') + '</span>';
    return;
  }
  resultEl.innerHTML = '<span class="badge badge-testing">' + t('checking') + '</span>';
  try {
    const result = await apiPost('/providers/validate', { baseUrl: baseUrl, apiKey: apiKey, modelId: modelId || undefined, useProxy: (document.getElementById('p-useproxy') ? document.getElementById('p-useproxy').checked : false) });
    if (result.valid) {
      const method = result.method ? ' (via ' + result.method + ')' : '';
      resultEl.innerHTML = '<span class="badge badge-valid">' + t('validProvider') + method + '</span>';
    } else {
      resultEl.innerHTML = '<span class="badge badge-invalid">' + t('invalidProvider', [result.error || 'unknown error']) + '</span>';
    }
  } catch (e) {
    resultEl.innerHTML = '<span class="badge badge-invalid">' + t('failed', [e.message]) + '</span>';
  }
}

async function addProvider() {
  const p = {
    name: document.getElementById('p-name').value.trim(),
    prefix: document.getElementById('p-prefix').value.trim(),
    baseUrl: document.getElementById('p-url').value.trim(),
    apiType: 'openai-compatible',
    isActive: true,
    keys: [],
    models: []
  };
  p.useProxy = document.getElementById('p-useproxy').checked;
  if (!p.name || !p.prefix || !p.baseUrl) {
    toast(t('requiredFields'), 'error');
    return;
  }
  await apiPost('/providers', p);
  closeModalOverlay();
  toast(t('providerCreated'), 'success');

  const data = await apiGet('/providers');
  providersCache = data.providers || [];

  var settingsPanel = document.querySelector('.settings-panel-section');
  if (settingsPanel) {
    renderProviderList();
    focusNewProviderCard(p.prefix);
  } else {
    renderProviders(document.getElementById('page-content'));
  }
}

function focusNewProviderCard(prefix) {
  var cards = document.querySelectorAll('#provider-list .provider-card');
  for (var i = 0; i < cards.length; i++) {
    var codeEl = cards[i].querySelector('.code');
    if (codeEl && codeEl.textContent === prefix) {
      var card = cards[i];
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.transition = 'box-shadow 0.3s';
      card.style.boxShadow = '0 0 0 3px var(--color-primary, #4f46e5)';
      (function(c) {
        setTimeout(function() { c.style.boxShadow = ''; }, 2000);
      })(card);
      break;
    }
  }
}

async function renderProviderDetail(c, id) {
  showSkeleton(c, 1);
  const data = await apiGet('/providers');
  const allProviders = data.providers || [];
  const p = allProviders.find(function(x) { return x.id === id; });
  if (!p) {
    c.innerHTML = emptyState(t('providerNotFound'));
    return;
  }
  providerDetailCache = p;
  var totalProviders = allProviders.length;
  var currentOrder = allProviders.findIndex(function(x) { return x.id === id; }) + 1;
  var orderTitle = (t('providerOrderTooltip') || 'Display order (1-{0})').replace('{0}', totalProviders);
  var baseUrlEsc = escapeHtml(p.baseUrl);
  var baseUrlAttr = escapeHtml(p.baseUrl);
  c.innerHTML = '\
    <div class="provider-detail">\
      <div class="provider-detail-header">\
        <div style="display:flex;align-items:baseline;gap:10px;min-width:0;flex:1;flex-wrap:wrap">\
          <h2>' + escapeHtml(p.name) + '</h2>\
          <p class="muted" id="detail-info-summary" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + t('prefix') + ' <span class="code">' + escapeHtml(p.prefix) + '</span> | ' + t('baseUrl') + ' <span class="code copyable" data-copy="' + baseUrlAttr + '" onclick="copyToClipboard(this.getAttribute(\'data-copy\'))" title="' + t('clickToCopy') + '">' + baseUrlEsc + '</span></p>\
          <div class="flex" style="gap:8px;flex-shrink:0;align-items:center">\
            <button type="button" class="btn btn-sm" onclick="backToProviderList()">' + t('back') + '</button>\
            <button type="button" class="btn btn-sm" onclick="showEditProvider(\'' + p.id + '\')">' + t('edit') + '</button>\
            <button type="button" class="btn btn-sm ' + (p.isActive ? '' : 'btn-primary') + '" onclick="toggleProvider(\'' + p.id + '\',' + (!p.isActive) + ')">' + (p.isActive ? t('disable') : t('enable')) + '</button>\
            <button type="button" class="btn btn-sm btn-danger" onclick="deleteProvider(\'' + p.id + '\')">' + t('delete') + '</button>\
            <input type="number" class="btn-order-input" id="provider-order-input" min="1" max="' + totalProviders + '" value="' + currentOrder + '" title="' + escapeHtml(orderTitle) + '" onchange="changeProviderOrder(\'' + p.id + '\', ' + currentOrder + ', ' + totalProviders + ', this.value)" onkeydown="if(event.key===\'Enter\') this.blur()"/>\
          </div>\
        </div>\
      </div>\
      <div class="provider-detail-body">\
        <div id="detail-info">\
        </div>\
        <div id="detail-keys"></div>\
        <div id="detail-models"></div>\
      </div>\
    </div>';
  renderDetailKeys(p);
  renderDetailModels(p);
}

async function changeProviderOrder(id, oldOrder, totalCount, valStr) {
  var inputEl = document.getElementById('provider-order-input');
  var newOrder = parseInt(valStr, 10);
  if (isNaN(newOrder) || newOrder < 1 || newOrder > totalCount) {
    toast((t('invalidOrderRange') || 'Order must be between 1 and {0}').replace('{0}', totalCount), 'error');
    if (inputEl) inputEl.value = oldOrder;
    return;
  }
  if (newOrder === oldOrder) return;
  try {
    var res = await apiPut('/providers/' + encodeURIComponent(id) + '/reorder', { index: newOrder });
    providersCache = res.providers || [];
    toast(t('providerOrderUpdated'), 'success');
    openProviderDetail(id);
  } catch (err) {
    if (inputEl) inputEl.value = oldOrder;
    toast(err.message || 'Error updating order', 'error');
  }
}


function renderDetailKeys(p) {
  const el = document.getElementById('detail-keys');
  const keys = p.keys || [];
  const hasKeys = keys.length > 0;
  el.innerHTML = '\
    <div class="detail-block">\
      <div class="section-title" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">\
        <span style="cursor:' + (hasKeys ? 'pointer' : 'default') + ';user-select:none" onclick="' + (hasKeys ? 'toggleKeysTable(\'' + p.id + '\')' : '') + '">\
          <span id="keys-chevron-' + p.id + '" style="display:' + (hasKeys ? 'inline-block' : 'none') + ';transition:transform .2s;margin-right:4px;font-size:10px">\u25B6</span>' +
          t('keysTitle') + ' (' + keys.length + ')\
        </span>\
        <div class="flex" style="gap:8px">\
          <button type="button" class="btn btn-sm btn-primary" onclick="showAddKeyDetail(\'' + p.id + '\')">' + t('addKey') + '</button>\
          <button type="button" class="btn btn-sm" onclick="showBulkAddKeys(\'' + p.id + '\')">' + t('bulkAdd') + '</button>\
        </div>\
      </div>\
      <div id="key-form-' + p.id + '"></div>\
      <div id="keys-body-' + p.id + '" style="display:' + (hasKeys ? 'none' : '') + '">' +
        (hasKeys ? '\
      <table>\
        <thead><tr><th>' + t('keyName') + '</th><th>' + t('actions') + '</th><th>' + t('key') + '</th><th>' + t('priority') + '</th><th>' + t('status') + '</th></tr></thead>\
        <tbody>' +
          keys.map(function(k) {
            return '<tr>\
              <td>' + escapeHtml(k.name) + '</td>\
              <td>\
                <button type="button" class="btn btn-sm" onclick="withLoading(this, () => testKeyDetail(\'' + p.id + '\',\'' + k.id + '\'))">' + t('test') + '</button>\
                <button type="button" class="btn btn-sm" onclick="toggleKeyDetail(\'' + p.id + '\',\'' + k.id + '\',' + (!k.isActive) + ')">' + (k.isActive ? t('pause') : t('resume')) + '</button>\
                <button type="button" class="btn btn-sm btn-danger" onclick="deleteKeyDetail(\'' + p.id + '\',\'' + k.id + '\')">' + t('delete') + '</button>\
              </td>\
              <td><span class="code copyable" data-copy="' + escapeHtml(k.key) + '" onclick="copyToClipboard(this.getAttribute(\'data-copy\'), \'' + escapeForJsString(k.name || 'key') + '\')" title="' + t('clickToCopy') + '">' + maskKey(k.key) + '</span></td>\
              <td>' + k.priority + '</td>\
              <td><span class="badge ' + (k.isActive ? 'badge-active' : 'badge-inactive') + '">' + (k.isActive ? t('active') : t('pause')) + '</span></td>\
            </tr>';
          }).join('') + '\
        </tbody>\
      </table>' : emptyState(t('noKeys'))) + '\
      </div>\
    </div>';
}

function toggleKeysTable(pid) {
  var body = document.getElementById('keys-body-' + pid);
  var chevron = document.getElementById('keys-chevron-' + pid);
  if (!body) return;
  var isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  if (chevron) {
    chevron.style.transform = isHidden ? 'rotate(90deg)' : '';
  }
}

function showAddKeyDetail(providerId) {
  const el = document.getElementById('key-form-' + providerId);
  el.innerHTML = '\
    <div class="card" style="background:var(--glass-bg)">\
      <div class="card-title">' + t('newKey') + '</div>\
      <div class="form-group mt-12"><label for="dk-name">' + t('keyName') + '</label><input id="dk-name" placeholder="Main"></div>\
      <div class="form-group"><label for="dk-key">' + t('apiKeyInput') + '</label><input type="password" id="dk-key" placeholder="sk-..."></div>\
      <div class="form-group"><label for="dk-priority">' + t('priorityLabel') + '</label><input type="number" id="dk-priority" value="1" style="max-width:120px"></div>\
      <div class="flex" style="gap:8px">\
        <button type="button" class="btn btn-primary" onclick="withLoading(this, () => addKeyDetail(\'' + providerId + '\'))">' + t('create') + '</button>\
        <button type="button" class="btn" onclick="document.getElementById(\'key-form-' + providerId + '\').innerHTML=\'\'">' + t('cancel') + '</button>\
      </div>\
    </div>';
}

async function addKeyDetail(providerId) {
  const k = {
    name: document.getElementById('dk-name').value.trim(),
    key: document.getElementById('dk-key').value.trim(),
    priority: parseInt(document.getElementById('dk-priority').value) || 1,
    isActive: true
  };
  if (!k.key) { toast(t('apiKeyRequired'), 'error'); return; }
  await apiPost('/providers/' + providerId + '/keys', k);
  toast(t('keyAdded'), 'success');
  currentProviderId = providerId;
  const data = await apiGet('/providers');
  const p = (data.providers || []).find(function(x) { return x.id === providerId; });
  if (p) {
    providerDetailCache = p;
    renderDetailKeys(p);
    renderDetailModels(p);
  }
  const formEl = document.getElementById('key-form-' + providerId);
  if (formEl) formEl.innerHTML = '';
}

function showBulkAddKeys(providerId) {
  const el = document.getElementById('key-form-' + providerId);
  el.innerHTML = '\
    <div class="card" style="background:var(--glass-bg)">\
      <div class="card-title">' + t('bulkAddKeys') + '</div>\
      <p class="muted mt-12">' + t('bulkFormat') + '</p>\
      <div class="form-group mt-12"><textarea id="bk-textarea" rows="8" placeholder="Main|sk-aaa\nBackup|sk-bbb\nsk-ccc"></textarea></div>\
      <div class="form-group"><label for="bk-priority">' + t('defaultPriority') + '</label><input type="number" id="bk-priority" value="1" style="max-width:120px"></div>\
      <div class="flex" style="gap:8px">\
        <button type="button" class="btn btn-primary" onclick="withLoading(this, () => bulkAddKeys(\'' + providerId + '\'))">' + t('addAll') + '</button>\
        <button type="button" class="btn" onclick="document.getElementById(\'key-form-' + providerId + '\').innerHTML=\'\'">' + t('cancel') + '</button>\
      </div>\
      <div id="bk-result" class="mt-12"></div>\
    </div>';
}

async function bulkAddKeys(providerId) {
  const text = document.getElementById('bk-textarea').value;
  const priority = parseInt(document.getElementById('bk-priority').value) || 1;
  const lines = text.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
  const keys = lines.map(function(line) {
    const idx = line.indexOf('|');
    if (idx > 0) {
      return { name: line.slice(0, idx).trim(), key: line.slice(idx + 1).trim(), priority: priority };
    }
    return { name: '', key: line.trim(), priority: priority };
  });
  const resultEl = document.getElementById('bk-result');
  resultEl.innerHTML = '<span class="badge badge-testing">' + t('adding') + '</span>';
  const result = await apiPost('/providers/' + providerId + '/keys/bulk', { keys: keys });
  if (result.error) {
    resultEl.innerHTML = '<span class="badge badge-invalid">' + escapeHtml(result.error) + '</span>';
  } else if (result.warning) {
    resultEl.innerHTML = '<span class="badge badge-valid">' + t('addedKeys', [result.added]) + '</span> <span class="badge badge-invalid">' + escapeHtml(result.warning) + '</span>';
  } else if (result.errors && result.errors.length > 0) {
    resultEl.innerHTML = '<span class="badge badge-valid">' + t('addedKeysErrors', [result.added]) + '</span> <span class="badge badge-invalid">Errors: ' + result.errors.length + '</span>';
  } else {
    resultEl.innerHTML = '<span class="badge badge-valid">' + t('addedKeys', [result.added]) + '</span>';
  }
  setTimeout(async function() {
    currentProviderId = providerId;
    const data = await apiGet('/providers');
    const p = (data.providers || []).find(function(x) { return x.id === providerId; });
    if (p) {
      providerDetailCache = p;
      renderDetailKeys(p);
      renderDetailModels(p);
    }
    const formEl = document.getElementById('key-form-' + providerId);
    if (formEl) formEl.innerHTML = '';
  }, 1000);
}

async function testKeyDetail(pid, kid) {
  const result = await apiPost('/providers/' + pid + '/test', { keyId: kid });
  if (result.valid) {
    toast(t('keyValid'), 'success');
  } else {
    toast(t('keyInvalid') + (result.error || 'unknown error'), 'error');
  }
}

async function toggleKeyDetail(pid, kid, active) {
  const p = providerDetailCache;
  const k = (p.keys || []).find(function(x) { return x.id === kid; });
  if (!k) return;
  k.isActive = active;
  await apiPut('/providers/' + pid + '/keys/' + kid, k);
  currentProviderId = pid;
  const data = await apiGet('/providers');
  const np = (data.providers || []).find(function(x) { return x.id === pid; });
  if (np) {
    providerDetailCache = np;
    renderDetailKeys(np);
    renderDetailModels(np);
  }
}

async function deleteKeyDetail(pid, kid) {
  var ok = await confirmModal(t('confirmDeleteKey'));
  if (!ok) return;
  await apiDelete('/providers/' + pid + '/keys/' + kid);
  toast(t('keyDeleted'), 'success');
  currentProviderId = pid;
  const data = await apiGet('/providers');
  const p = (data.providers || []).find(function(x) { return x.id === pid; });
  if (p) {
    providerDetailCache = p;
    renderDetailKeys(p);
    renderDetailModels(p);
  }
}

function renderDetailRotation(p) {
  const el = document.getElementById('detail-rotation');
  const strategy = p.rotationStrategy || '';
  const sticky = p.stickyLimit || 0;
  el.innerHTML = '\
    <div class="detail-block">\
      <div class="section-title">' + t('rotationSection') + '</div>\
      <p class="muted mb-12">' + t('rotationDesc') + '</p>\
      <div class="form-group">\
        <label for="r-strategy">' + t('strategy') + '</label>\
        <select id="r-strategy">\
          <option value=""' + (strategy === '' ? ' selected' : '') + '>' + t('inheritGlobal') + '</option>\
          <option value="fill-first"' + (strategy === 'fill-first' ? ' selected' : '') + '>' + t('fillFirst') + '</option>\
          <option value="round-robin"' + (strategy === 'round-robin' ? ' selected' : '') + '>' + t('roundRobin') + '</option>\
          <option value="failover"' + (strategy === 'failover' ? ' selected' : '') + '>' + t('failover') + '</option>\
        </select>\
      </div>\
      <div class="form-group">\
        <label for="r-sticky">' + t('stickyLabel') + '</label>\
        <input type="number" id="r-sticky" value="' + sticky + '" style="max-width:120px">\
      </div>\
      <button type="button" class="btn btn-primary" onclick="withLoading(this, () => saveProviderRotation(\'' + p.id + '\'))">' + t('save') + '</button>\
    </div>';
}

async function saveProviderRotation(id) {
  const p = providerDetailCache;
  const strategy = document.getElementById('r-strategy').value;
  const sticky = parseInt(document.getElementById('r-sticky').value) || 0;
  p.rotationStrategy = strategy;
  p.stickyLimit = sticky;
  await apiPut('/providers/' + id, p);
  toast(t('rotationStrategySaved'), 'success');
}

function buildModelRowMainInner(p, m) {
  var ts = modelTestStatus[m.id];
  var quotaStr = '';
  if (ts) {
    if (ts.quotaTotal > 0) quotaStr = ts.quotaRemain + '/' + ts.quotaTotal;
  }
  var midEsc = escapeHtml(m.id);
  var midJs = escapeForJsString(m.id);
  var pidEsc = escapeHtml(p.id);
  var prefixEsc = escapeHtml(p.prefix);
  var prefixJs = escapeForJsString(p.prefix);
  // If alias exists, use it for display and copy instead of model id
  var displayId = m.alias ? escapeHtml(m.alias) : midEsc;
  var copySuffix = m.alias ? escapeForJsString(m.alias) : midJs;
  var allRes = allKeysTestResults[p.id + '/' + m.id];
  var allBadge = '';
  if (allRes && allRes.results) {
    var okCnt = 0, failCnt = 0;
    allRes.results.forEach(function(r) { if (r.ok) okCnt++; else failCnt++; });
    allBadge = '<span class="model-alltest-badge show"><span class="ok">' + okCnt + '</span>/<span class="fail">' + failCnt + '</span></span>';
  } else {
    allBadge = '<span class="model-alltest-badge"></span>';
  }
  var kindVal = m.kind || 'text';
  var protoVal = m.imgProtocol || 'gpt';
  var protoDisplay = (kindVal === 'image') ? '' : 'none';
  var chevronDown = '<svg class="quota-bar-chevron model-row-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  var rowOnclick = batchManageMode
    ? 'batchToggleModel(\'' + midJs + '\')'
    : 'toggleModelDetailRow(event, \'' + pidEsc + '\', \'' + midJs + '\')';
  var modelIdOnclick = batchManageMode
    ? 'event.stopPropagation(); batchToggleModel(\'' + midJs + '\')'
    : 'event.stopPropagation(); copyToClipboard(\'' + prefixJs + '/' + copySuffix + '\')';
  var isCurrentBatchTesting = window.activeBatchTestState && window.activeBatchTestState.running && window.activeBatchTestState.pid === p.id && window.activeBatchTestState.currentModelId === m.id;
  var testBtnText = isCurrentBatchTesting ? getSpinnerHtml() : (ts && ts.speed != null ? String(ts.speed) : t('test'));
  var testBtnDisabled = isCurrentBatchTesting ? ' disabled' : '';
  return '<div class="model-row-main" onclick="' + rowOnclick + '">' +
    chevronDown +
    '<button type="button" class="btn btn-sm btn-test-model ' + (ts ? (ts.ok ? 'btn-test-ok' : 'btn-test-err') : '') + '"' + testBtnDisabled + ' onclick="event.stopPropagation(); withLoading(this, () => testSingleModel(\'' + pidEsc + '\', \'' + midJs + '\'))">' + testBtnText + '</button>' +
    buildMiniProtocolBadges(ts, m.id) +
    '<select class="model-quota-select" onclick="event.stopPropagation()" onchange="updateModelQuotaType(\'' + pidEsc + '\', this)" data-model="' + midEsc + '">' +
      '<option value="unlimited"' + (m.quotaType === 'unlimited' ? ' selected' : '') + '>' + t('unlimited') + '</option>' +
      '<option value="limited"' + (m.quotaType === 'limited' || !m.quotaType ? ' selected' : '') + '>' + t('limited') + '</option>' +
      '<option value="paid"' + (m.quotaType === 'paid' ? ' selected' : '') + '>' + t('paid') + '</option>' +
    '</select>' +
    '<select class="model-quota-select model-kind-select" onclick="event.stopPropagation()" onchange="updateModelKind(\'' + pidEsc + '\', this)" data-model="' + midEsc + '" title="' + t('modelKind') + '">' +
      '<option value="text"' + (kindVal !== 'image' ? ' selected' : '') + '>' + t('textModel') + '</option>' +
      '<option value="image"' + (kindVal === 'image' ? ' selected' : '') + '>' + t('imageModel') + '</option>' +
    '</select>' +
    '<select class="model-quota-select model-protocol-select" style="display:' + protoDisplay + '" onclick="event.stopPropagation()" onchange="updateModelImgProtocol(\'' + pidEsc + '\', this)" data-model="' + midEsc + '" title="' + t('imgProtocol') + '">' +
      '<option value="gpt"' + (protoVal === 'gpt' ? ' selected' : '') + '>GPT</option>' +
      '<option value="xai"' + (protoVal === 'xai' ? ' selected' : '') + '>xAI</option>' +
      '<option value="modelscope"' + (protoVal === 'modelscope' ? ' selected' : '') + '>ModelScope</option>' +
    '</select>' +
    allBadge +
    '<span class="model-quota-numbers" style="display:none"></span>' +
    '<button type="button" class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteModelDetail(\'' + pidEsc + '\', \'' + midJs + '\')">' + t('delete') + '</button>' +
    '<button type="button" class="btn btn-sm ' + (m.alias ? 'btn-primary' : '') + '" data-alias="' + escapeHtml(m.alias || '') + '" onclick="event.stopPropagation(); showModelAliasModal(\'' + pidEsc + '\', \'' + midJs + '\', this.getAttribute(\'data-alias\'))" title="' + t('alias') + '">' + t('alias') + '</button>' +
    '<button type="button" class="btn btn-sm ' + (m.note ? 'btn-info' : '') + '" data-note="' + escapeHtml(m.note || '') + '" onclick="event.stopPropagation(); showModelNoteModal(\'' + pidEsc + '\', \'' + midJs + '\', this.getAttribute(\'data-note\'))" title="' + escapeHtml(m.note || t('note')) + '">' + t('note') + '</button>' +
    '<button type="button" class="btn btn-sm ' + (m.nim && m.nim.enabled ? 'btn-primary' : '') + '" data-nim-enabled="' + (m.nim && m.nim.enabled ? '1' : '0') + '" data-nim-count="' + (m.nim ? (m.nim.request_count_per_key || 0) : 0) + '" data-nim-interval="' + (m.nim ? (m.nim.min_interval_ms || 0) : 0) + '" onclick="event.stopPropagation(); showModelNIMModal(\'' + pidEsc + '\', \'' + midJs + '\', this)" title="' + t('modelNIM') + '">' + t('modelNIM') + '</button>' +
    '<span class="model-id copyable" onclick="' + modelIdOnclick + '" title="' + t('clickToCopy') + '">' + prefixEsc + '/' + displayId + '</span>' +
  '</div>';
}

function renderDetailModels(p) {
  const el = document.getElementById('detail-models');
  const models = p.models || [];
  var modelsHtml = models.map(function(m) {
    var rowId = 'mrow-' + sanitizeId(p.id) + '-' + sanitizeId(m.id);
    var detailId = 'mdetail-' + sanitizeId(p.id) + '-' + sanitizeId(m.id);
    var batchSelected = batchSelectedModels.has(m.id);
    var batchClass = (batchManageMode && batchSelected) ? ' batch-selected' : '';
    return '<div class="model-row' + batchClass + '" id="' + rowId + '" data-batch-mid="' + escapeHtml(m.id) + '">' +
      buildModelRowMainInner(p, m) +
      '<div class="model-key-detail-wrap" id="' + detailId + '"></div>' +
    '</div>';
  }).join('');
  var isBatchRunning = window.activeBatchTestState && window.activeBatchTestState.running && window.activeBatchTestState.pid === p.id;
  var batchBtnText = isBatchRunning ? (t('stop') || 'Stop') : t('batchTest');
  var batchBtnClass = isBatchRunning ? 'btn btn-sm btn-danger' : 'btn btn-sm';
  el.innerHTML = '\
    <div class="detail-block">\
      <div class="flex mb-12 model-create-row" style="gap:10px;align-items:center">\
        <span class="models-title-inline" style="font-size:var(--font-section-title);font-weight:600;color:var(--text-secondary);white-space:nowrap">' + t('modelsTitle') + ' (' + models.length + ')</span>\
        <input id="m-input" class="form-control model-create-input" placeholder="' + t('modelPlaceholder') + '">\
        <button type="button" class="btn btn-sm btn-create-action" onclick="withLoading(this, () => testModelDetail(\'' + escapeForJsString(p.id) + '\'))">' + t('test') + '</button>\
        <button type="button" class="btn btn-sm btn-primary btn-create-action" onclick="withLoading(this, () => addModelDetail(\'' + escapeForJsString(p.id) + '\'))">' + t('create') + '</button>\
      </div>\
      <div class="model-toolbar-row">\
        <button type="button" class="btn btn-sm" style="flex-shrink:0;white-space:nowrap" onclick="withLoading(this, () => importModels(\'' + escapeForJsString(p.id) + '\'))">' + t('importModels') + '</button>\
        <button type="button" class="btn btn-sm" id="batch-manage-btn" onclick="enterBatchManage(\'' + escapeForJsString(p.id) + '\')" style="display:' + (batchManageMode ? 'none' : '') + ';flex-shrink:0;white-space:nowrap">' + t('batchManage') + '</button>\
        <button type="button" class="' + batchBtnClass + '" id="batch-test-btn" onclick="batchTestModels(\'' + escapeForJsString(p.id) + '\', this)" style="display:' + (batchManageMode ? 'none' : '') + ';flex-shrink:0;white-space:nowrap">' + batchBtnText + '</button>\
        <div id="batch-actions" style="display:' + (batchManageMode ? 'inline-flex' : 'none') + ';gap:6px;align-items:center;flex-wrap:nowrap;white-space:nowrap;flex-shrink:0">\
          <input id="batch-filter-input" class="form-control" placeholder="' + t('filterModels') + '" style="width:130px;max-width:140px;height:28px;padding:3px 8px;font-size:calc(var(--font-base) - 1px);border-radius:var(--radius-sm);box-sizing:border-box;flex-shrink:0" oninput="filterBatchModels(this.value)">\
          <button type="button" class="btn btn-sm" style="flex-shrink:0;white-space:nowrap" onclick="clearBatchFilter()">' + t('clear') + '</button>\
          <button type="button" class="btn btn-sm" id="batch-toggle-select-btn" style="flex-shrink:0;white-space:nowrap" onclick="batchToggleSelectAll()">' + ((models.length > 0 && batchSelectedModels.size === models.length) ? t('deselectAll') : t('selectAll')) + '</button>\
          <button type="button" class="btn btn-sm btn-primary" style="flex-shrink:0;white-space:nowrap" onclick="withLoading(this, () => batchKeepSelected(\'' + escapeForJsString(p.id) + '\'))">' + t('keepSelected') + '</button>\
          <button type="button" class="btn btn-sm btn-danger" style="flex-shrink:0;white-space:nowrap" onclick="withLoading(this, () => batchRemoveSelected(\'' + escapeForJsString(p.id) + '\'))">' + t('removeSelected') + '</button>\
          <button type="button" class="btn btn-sm" style="flex-shrink:0;white-space:nowrap" onclick="batchCancel()">' + t('cancel') + '</button>\
        </div>\
        <div id="m-test-result" style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0"></div>\
      </div>\
      <div id="model-list">' + (models.length === 0 ? emptyState(t('noModels')) : modelsHtml) + '</div>\
    </div>';
  // 重新展开之前打开的模型
  expandedModelDetails.forEach(function(setKey) {
    var parts = JSON.parse(setKey);
    if (parts[0] === p.id) {
      reexpandModelDetailRow(parts[0], parts[1]);
    }
  });
}

function toggleModelDetailRow(e, pid, mid) {
  if (e && e.target && e.target.closest) {
    if (e.target.closest('button, select, .copyable')) return;
  }
  var rowId = 'mrow-' + sanitizeId(pid) + '-' + sanitizeId(mid);
  var detailId = 'mdetail-' + sanitizeId(pid) + '-' + sanitizeId(mid);
  var wrap = document.getElementById(detailId);
  if (!wrap) return;
  var item = document.getElementById(rowId);
  var chevron = item ? item.querySelector('.model-row-chevron') : null;
  var key = JSON.stringify([pid, mid]);
  if (expandedModelDetails.has(key)) {
    expandedModelDetails.delete(key);
    wrap.classList.remove('expanded');
    if (chevron) chevron.style.transform = '';
    setTimeout(function() { if (!expandedModelDetails.has(key)) wrap.innerHTML = ''; }, 300);
  } else {
    expandedModelDetails.add(key);
    wrap.classList.add('expanded');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
    wrap.innerHTML = '<div class="model-key-detail-loading">' + t('loading') + '...</div>';
    fetchModelDetailRow(pid, mid);
  }
}

async function fetchModelDetailRow(pid, mid) {
  var detailId = 'mdetail-' + sanitizeId(pid) + '-' + sanitizeId(mid);
  var wrap = document.getElementById(detailId);
  if (!wrap) return;
  try {
    var p = providerDetailCache;
    var data = await apiGet('/usage/model-keys?provider=' + encodeURIComponent(p.name) + '&model=' + encodeURIComponent(mid));
    renderModelKeyDetailRow(pid, mid, data);
  } catch (e) {
    wrap.innerHTML = '<div class="model-key-detail-empty">' + escapeHtml(e.message || String(e)) + '</div>';
  }
}

function renderModelKeyDetailRow(pid, mid, data) {
  var detailId = 'mdetail-' + sanitizeId(pid) + '-' + sanitizeId(mid);
  var wrap = document.getElementById(detailId);
  if (!wrap) return;
  if (!data || !data.keys || data.keys.length === 0) {
    wrap.innerHTML = '<div class="model-key-detail-empty">' + t('noKeysConfigured') + '</div>';
    return;
  }
  // Actions row first (Run All-Keys Test button + status)
  var html = '<div class="model-key-detail-actions">' +
    '<button type="button" class="btn btn-sm btn-primary" id="run-alltest-' + sanitizeId(pid) + '-' + sanitizeId(mid) + '" onclick="runAllKeysTest(\'' + escapeHtml(pid) + '\', \'' + escapeForJsString(mid) + '\')">' + t('runAllKeysTest') + '</button>' +
    '<span class="model-alltest-status" id="alltest-status-' + sanitizeId(pid) + '-' + sanitizeId(mid) + '"></span>' +
  '</div>';
  // Each key on its own grid row
  html += '<div class="model-key-detail">';
  data.keys.forEach(function(k) {
    var color = typeof getModelColor !== 'undefined' ? getModelColor(data.provider, data.model) : 'var(--accent2)';
    var statusBadge = '';
    var quotaPct = 0;
    var quotaFillColor = 'var(--accent2)';
    var quotaNumText = '';
    if (data.hasQuota && k.hasQuota) {
      if (k.modelRemaining === 0) {
        statusBadge = '<span class="key-status-badge key-status-exhausted">' + t('exhausted') + '</span>';
      } else {
        statusBadge = '<span class="key-status-badge key-status-available">' + t('available') + '</span>';
      }
      quotaPct = k.modelLimit > 0 ? ((k.modelLimit - k.modelRemaining) / k.modelLimit * 100) : 0;
      quotaFillColor = quotaPct < 50 ? 'var(--accent2)' : (quotaPct < 80 ? 'var(--warn)' : 'var(--danger)');
      quotaNumText = (k.modelLimit - k.modelRemaining) + '/' + k.modelLimit;
    } else if (k.modelLock) {
      if (k.status === 'locked') {
        statusBadge = '<span class="key-status-badge key-status-locked">' + t('dailyLocked') + '</span>';
      } else {
        statusBadge = '<span class="key-status-badge key-status-cooldown">' + t('cooldown') + '</span>';
      }
    } else if (!k.isActive) {
      statusBadge = '<span class="key-status-badge key-status-inactive">' + t('inactive') + '</span>';
    } else {
      statusBadge = '<span class="key-status-badge key-status-available">' + t('available') + '</span>';
    }
    var quotaBar = '<div class="model-key-quota-bar"><div class="model-key-quota-fill" style="width:' + quotaPct + '%;background:' + quotaFillColor + '"></div></div>';
    var quotaInfo = '<span class="model-key-quota-numbers">' + quotaNumText + '</span>';
    var lockInfo = '';
    if (k.modelLock) {
      try {
        var lockTime = new Date(k.modelLock);
        lockInfo = '<span class="model-key-lock-info">' + t('unlockAt') + ' ' + lockTime.toLocaleTimeString() + '</span>';
      } catch (_) {}
    }
    var rowClass = 'model-key-row';
    if (!k.isActive || k.modelLock) {
      rowClass = 'model-key-row model-key-row-disabled';
    }
    var errStr = '';
    if (k.lastError) {
      errStr = k.lastError.length > 60 ? k.lastError.slice(0, 60) + '…' : k.lastError;
    }
    html += '<div class="' + rowClass + '" data-keyname="' + escapeHtml(k.keyName) + '">' +
      '<span class="model-color-dot" style="background:' + color + '"></span>' +
      '<span class="model-key-name">' + escapeHtml(k.keyName) + '</span>' +
      '<div class="model-key-badges">' + statusBadge + '</div>' +
      '<div class="model-key-quota">' + quotaBar + quotaInfo + '</div>' +
      (lockInfo || '<span></span>') +
      '<span class="model-key-ttft"></span>' +
      '<span class="model-key-speed"></span>' +
      '<span class="model-key-tokens"></span>' +
      '<span class="model-key-error"' + (k.lastError ? ' title="' + escapeHtml(k.lastError) + '"' : '') + '>' + (errStr ? escapeHtml(errStr) : '') + '</span>' +
    '</div>';
  });
  html += '</div>';
  wrap.innerHTML = html;
  // Aggregate quota totals and update parent model row
  var totalRemain = 0, totalLimit = 0;
  data.keys.forEach(function(k) {
    if (k.hasQuota) { totalRemain += (k.modelRemaining || 0); totalLimit += (k.modelLimit || 0); }
  });
  var modelRow = document.getElementById('mrow-' + sanitizeId(pid) + '-' + sanitizeId(mid));
  var quotaNumEl = modelRow ? modelRow.querySelector('.model-quota-numbers') : null;
  if (quotaNumEl) {
    if (totalLimit > 0) {
      quotaNumEl.textContent = totalRemain + '/' + totalLimit;
      quotaNumEl.style.display = '';
    } else {
      quotaNumEl.style.display = 'none';
    }
  }
  var prev = allKeysTestResults[pid + '/' + mid];
  if (prev && prev.results) {
    renderKeyTestResults(pid, mid, prev.results);
  }
}

async function runAllKeysTest(pid, mid) {
  var btnId = 'run-alltest-' + sanitizeId(pid) + '-' + sanitizeId(mid);
  var statusId = 'alltest-status-' + sanitizeId(pid) + '-' + sanitizeId(mid);
  var btn = document.getElementById(btnId);
  var statusEl = document.getElementById(statusId);
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span class="badge badge-testing">' + t('runningAllKeysTest') + '</span>';
  // Clear any previous per-key metrics so a retest shows progress cleanly.
  var wrap = document.getElementById('mdetail-' + sanitizeId(pid) + '-' + sanitizeId(mid));
  if (wrap) {
    wrap.querySelectorAll('.model-key-row').forEach(function(row) {
      ['model-key-ttft', 'model-key-speed', 'model-key-tokens'].forEach(function(cls) {
        var el = row.querySelector('.' + cls);
        if (el) el.innerHTML = '';
      });
    });
  }
  var results = [];
  var total = 0;
  const controller = new AbortController();
  const timeoutId = setTimeout(function() { controller.abort(); }, 60000);
  let reader;
  try {
    const resp = await fetch('/api/providers/' + pid + '/models/test-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ model: mid }),
      signal: controller.signal
    });
    if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
    reader = resp.body.getReader();
    const decoder = new TextDecoder();
    var buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      var events = buffer.split('\n\n');
      buffer = events.pop();
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var lines = ev.split('\n');
        var eventType = '', dataStr = '';
        for (var j = 0; j < lines.length; j++) {
          if (lines[j].indexOf('event:') === 0) eventType = lines[j].slice(6).trim();
          else if (lines[j].indexOf('data:') === 0) dataStr += lines[j].slice(5).trim();
        }
        if (eventType === 'meta') {
          try { total = JSON.parse(dataStr).total; } catch (_) {}
          if (statusEl) statusEl.innerHTML = '<span class="badge badge-testing">0/' + total + '</span>';
        } else if (eventType === 'key') {
          var r;
          try { r = JSON.parse(dataStr); } catch (_) { continue; }
          results.push(r);
          renderKeySingleResult(pid, mid, r);
          if (statusEl) statusEl.innerHTML = '<span class="badge badge-testing">' + results.length + '/' + total + '</span>';
        } else if (eventType === 'done') {
          var summary;
          try { summary = JSON.parse(dataStr); } catch (_) { summary = {}; }
          allKeysTestResults[pid + '/' + mid] = { results: results };
          if (statusEl) statusEl.innerHTML = '<span class="badge badge-valid">' + t('allKeysTestDone') + ' (' + (summary.ok || 0) + '/' + (summary.fail || 0) + ')</span>';
          var okCnt = summary.ok || 0, failCnt = summary.fail || 0;
          var row = document.getElementById('mrow-' + sanitizeId(pid) + '-' + sanitizeId(mid));
          if (row) {
            var badge = row.querySelector('.model-alltest-badge');
            if (badge) {
              badge.classList.add('show');
              badge.innerHTML = '<span class="ok">' + okCnt + '</span>/<span class="fail">' + failCnt + '</span>';
            }
            // Re-aggregate quota from test results and update model row quota numbers
            var totalRemain = 0, totalLimit = 0;
            results.forEach(function(r) {
              if (r.quotaTotal > 0) { totalRemain += (r.quotaRemain || 0); totalLimit += (r.quotaTotal || 0); }
            });
            var quotaNumEl = row.querySelector('.model-quota-numbers');
            if (quotaNumEl && totalLimit > 0) {
              quotaNumEl.textContent = totalRemain + '/' + totalLimit;
              quotaNumEl.style.display = '';
            }
          }
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      if (statusEl) statusEl.innerHTML = '<span class="badge badge-invalid">' + escapeHtml('All keys test timed out (60s)') + '</span>';
    } else {
      if (statusEl) statusEl.innerHTML = '<span class="badge badge-invalid">' + escapeHtml(e.message || String(e)) + '</span>';
    }
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
    if (reader) { reader.cancel().catch(function() {}); }
    if (btn) btn.disabled = false;
  }
}

function renderKeySingleResult(pid, mid, r) {
  var detailId = 'mdetail-' + sanitizeId(pid) + '-' + sanitizeId(mid);
  var wrap = document.getElementById(detailId);
  if (!wrap) return;
  var rows = wrap.querySelectorAll('.model-key-row[data-keyname="' + escapeAttr(r.keyName) + '"]');
  rows.forEach(function(row) {
    var ttftEl = row.querySelector('.model-key-ttft');
    var speedEl = row.querySelector('.model-key-speed');
    var tokensEl = row.querySelector('.model-key-tokens');
    if (r.ok) {
      row.classList.remove('model-key-row-disabled');
      if (ttftEl) ttftEl.innerHTML = '<span class="model-key-metric">' + t('firstToken') + ' ' + r.ttftMs + 'ms</span>';
      if (speedEl) speedEl.innerHTML = '<span class="model-key-metric">' + t('speed') + ' ' + (r.tokensPerSec != null ? r.tokensPerSec.toFixed(1) : '0') + ' ' + t('tokPerSec') + '</span>';
      if (tokensEl) tokensEl.innerHTML = '<span class="model-key-metric">' + t('outputTokensLabel') + ' ' + r.outputTokens + '</span>';
    } else {
      row.classList.add('model-key-row-disabled');
      if (ttftEl) ttftEl.innerHTML = '<span class="model-key-metric model-key-metric-err">FAIL' + (r.status ? ' ' + r.status : '') + '</span>';
      if (speedEl) speedEl.innerHTML = '';
      if (tokensEl) tokensEl.innerHTML = '<span class="model-key-metric model-key-metric-err">' + escapeHtml(r.error || '') + '</span>';
    }
    // Refresh quota bar if backend returned quota info
    if (r.quotaTotal > 0) {
      var remain = r.quotaRemain || 0;
      var total = r.quotaTotal || 0;
      var pct = total > 0 ? ((total - remain) / total * 100) : 0;
      var fillColor = pct < 50 ? 'var(--accent2)' : (pct < 80 ? 'var(--warn)' : 'var(--danger)');
      var quotaFill = row.querySelector('.model-key-quota-fill');
      var quotaNumbers = row.querySelector('.model-key-quota-numbers');
      if (quotaFill) { quotaFill.style.width = pct + '%'; quotaFill.style.background = fillColor; }
      if (quotaNumbers) quotaNumbers.textContent = (total - remain) + '/' + total;
      var dot = row.querySelector('.model-color-dot');
      if (dot) dot.style.background = remain === 0 && total > 0 ? 'var(--danger)' : (pct >= 80 ? 'var(--warn)' : 'var(--accent2)');
      // Update status badge to reflect quota (skip if locked/cooldown/inactive)
      var badge = row.querySelector('.model-key-badges');
      if (badge && !badge.querySelector('.key-status-locked, .key-status-cooldown, .key-status-inactive')) {
        badge.innerHTML = remain === 0
          ? '<span class="key-status-badge key-status-exhausted">' + t('exhausted') + '</span>'
          : '<span class="key-status-badge key-status-available">' + t('available') + '</span>';
      }
    }
  });
}

function renderKeyTestResults(pid, mid, results) {
  results.forEach(function(r) {
    renderKeySingleResult(pid, mid, r);
  });
}

function reexpandModelDetailRow(pid, mid) {
  var detailId = 'mdetail-' + sanitizeId(pid) + '-' + sanitizeId(mid);
  var wrap = document.getElementById(detailId);
  if (!wrap) return;
  wrap.classList.add('expanded');
  var rowId = 'mrow-' + sanitizeId(pid) + '-' + sanitizeId(mid);
  var item = document.getElementById(rowId);
  var chevron = item ? item.querySelector('.model-row-chevron') : null;
  if (chevron) chevron.style.transform = 'rotate(180deg)';
  wrap.innerHTML = '<div class="model-key-detail-loading">' + t('loading') + '...</div>';
  fetchModelDetailRow(pid, mid);
}

function escapeAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function testModelDetail(pid) {
  const modelId = document.getElementById('m-input').value.trim();
  if (!modelId) { toast(t('enterModelId'), 'error'); return; }
  await doTestModel(pid, modelId);
}

function updateModelRowStatus(pid, modelId) {
  var p = providerDetailCache;
  if (!p || p.id !== pid) return;
  var m = (p.models || []).find(function(x) { return x.id === modelId; });
  if (!m) return;
  var rowId = 'mrow-' + sanitizeId(pid) + '-' + sanitizeId(modelId);
  var row = document.getElementById(rowId);
  if (!row) return;
  var main = row.querySelector('.model-row-main');
  if (!main) return;
  var oldChevron = main.querySelector('.model-row-chevron');
  var wasExpanded = oldChevron && oldChevron.style.transform === 'rotate(180deg)';
  main.outerHTML = buildModelRowMainInner(p, m);
  var newMain = row.querySelector('.model-row-main');
  if (!newMain) return;
  if (wasExpanded) {
    var newChevron = newMain.querySelector('.model-row-chevron');
    if (newChevron) newChevron.style.transform = 'rotate(180deg)';
  }
}

async function testSingleModel(pid, modelId) {
  await doTestModel(pid, modelId);
  currentProviderId = pid;
  updateModelRowStatus(pid, modelId);
}

async function doTestModel(pid, modelId) {
  await testModelProtosSerial(pid, modelId, {
    onComplete: function(result) {
      if (!result.ok) {
        var err = '';
        for (var k in result) {
          if (result[k] && result[k].error) err = result[k].error;
        }
        toast(t('modelTestFailed') + (err || 'unknown error'), 'error');
      }
    }
  });
  updateModelRowStatus(pid, modelId);
}

// renderMultiProtocolBadge renders the top #m-test-result badge for the new
// three-protocol composite test response. It shows a summary badge plus one
// badge per protocol (openaiCompat / openaiResponses / anthropic).
function renderMultiProtocolBadge(el, result, modelId) {
  if (!result) {
    el.innerHTML = '<span class="badge badge-invalid">' + t('failed', [t('noData')]) + '</span>';
    return;
  }
  var summary;
  if (result.ok === false) {
    summary = '<span class="badge badge-invalid">' + t('mptestAllFailed') + '</span>';
  } else {
    var n = Array.isArray(result.protocols) ? result.protocols.length : 0;
    summary = '<span class="badge badge-valid">' + t('mptestSummary', [n]) + '</span>';
  }
  var protoHtml = '<span class="mp-summary-badges">';
  [['openaiCompat', 'O', t('protoOpenAICompat')],
   ['openaiResponses', 'R', t('protoOpenAIResponses')],
   ['anthropic', 'A', t('protoAnthropic')]].forEach(function(p) {
    var r = result[p[0]];
    var cls = 'mp-skip';
    var label = t('mptestStatusSkip');
    if (r) {
      if (r.ok) { cls = 'mp-ok'; label = t('mptestStatusOk'); }
      else if (r.skipped) { cls = 'mp-skip'; label = t('mptestStatusSkip'); }
      else { cls = 'mp-err'; label = t('mptestStatusFail'); }
    }
    var title = p[2] + ': ' + label + (r && r.latencyMs != null ? ' (' + r.latencyMs + 'ms)' : '');
    protoHtml += '<span class="mp-proto-badge ' + cls + '" title="' + escapeAttr(title) + '">' + escapeAttr(p[1]) + '</span>';
  });
  protoHtml += '</span>';
  el.innerHTML = summary + protoHtml;
}

// ===================== Shared Protocol Test Helpers =====================

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function updateMiniBadge(modelId, protoKey, status) {
  var el = document.querySelector('.mp-mini-badge[data-model="' + CSS.escape(modelId) + '"][data-proto="' + protoKey + '"]');
  if (!el) return;
  el.className = 'mp-mini-badge mp-' + status;
  var labelMap = {openaiCompat: 'OpenAI Compatible', openaiResponses: 'OpenAI Responses', anthropic: 'Anthropic Messages'};
  var statusMap = {testing: 'testing', ok: 'OK', err: 'failed', skip: 'skipped'};
  el.title = (labelMap[protoKey] || protoKey) + ': ' + (statusMap[status] || status);
  var cursorStyle = (status === 'testing') ? 'cursor:default' : 'cursor:pointer';
  el.style.cursor = cursorStyle;
  // Update onclick: once tested, make it clickable to show detail
  if (status !== 'testing') {
    el.setAttribute('onclick', 'showProtoDetail(\'' + escapeForJsString(modelId) + '\',\'' + protoKey + '\')');
  } else {
    el.removeAttribute('onclick');
  }
}

async function testModelProtosSerial(pid, modelId, options) {
  var protos = [
    {key: 'openaiCompat', endpoint: 'openai-compat'},
    {key: 'openaiResponses', endpoint: 'openai-responses'},
    {key: 'anthropic', endpoint: 'anthropic'}
  ];
  var result = modelTestStatus[modelId] || {};
  // Reset all mini badges to testing
  for (var pi = 0; pi < protos.length; pi++) {
    updateMiniBadge(modelId, protos[pi].key, 'testing');
  }
  // Show testing state in top result area if applicable
  var resultEl = document.getElementById('m-test-result');
  if (resultEl) resultEl.innerHTML = '<span class="badge badge-testing">' + t('testing', [modelId]) + '</span>';
  const controller = new AbortController();
  const timeoutId = setTimeout(function() { controller.abort(); }, 20000);
  try {
    for (var i = 0; i < protos.length; i++) {
      var p = protos[i];
      try {
        var r = await apiPost('/providers/' + pid + '/models/test-proto', {model: modelId, proto: p.endpoint}, controller.signal);
        result[p.key] = r;
        updateMiniBadge(modelId, p.key, r.ok ? 'ok' : (r.skipped ? 'skip' : 'err'));
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        result[p.key] = {ok: false, error: e.message, skipped: false};
        updateMiniBadge(modelId, p.key, 'err');
      }
      if (i < protos.length - 1) await sleep(2000);
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      // Mark any untested protos as timed out
      for (var si = 0; si < protos.length; si++) {
        if (!result[protos[si].key]) {
          result[protos[si].key] = {ok: false, error: 'Timed out', skipped: false};
          updateMiniBadge(modelId, protos[si].key, 'err');
        }
      }
      if (resultEl) resultEl.innerHTML = '<span class="badge badge-invalid">' + escapeHtml('Protocol test timed out (20s)') + '</span>';
    } else {
      throw e;
    }
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
  // Compute final protocols list and speed
  result.protocols = [];
  var bestSpeed = null;
  for (var pi2 = 0; pi2 < protos.length; pi2++) {
    var pKey = protos[pi2].key;
    if (result[pKey] && result[pKey].ok) {
      result.protocols.push(protos[pi2].endpoint);
      if (bestSpeed == null) {
        var pr = result[pKey];
        if (pr.tokensPerSec != null && pr.tokensPerSec > 0) {
          bestSpeed = Math.floor(pr.tokensPerSec);
        } else if (pr.outputTokens > 0 && pr.latencyMs > 0) {
          bestSpeed = Math.floor(pr.outputTokens / (pr.latencyMs / 1000));
        }
      }
    }
  }
  result.ok = result.protocols.length > 0;
  result.speed = bestSpeed;
  modelTestStatus[modelId] = result;
  if (resultEl) renderMultiProtocolBadge(resultEl, result, modelId);
  if (options && options.onComplete) options.onComplete(result);
}

window.activeBatchTestState = window.activeBatchTestState || {
  pid: null,
  running: false,
  currentModelId: null,
  aborted: false
};

async function batchTestModels(pid, btn) {
  var state = window.activeBatchTestState;
  if (state.running && state.pid === pid) {
    state.aborted = true;
    return;
  }
  state.pid = pid;
  state.running = true;
  state.aborted = false;
  state.currentModelId = null;

  var batchBtn = btn || document.getElementById('batch-test-btn');
  if (batchBtn) {
    batchBtn.textContent = t('stop') || 'Stop';
    batchBtn.className = 'btn btn-sm btn-danger';
  }

  var p = providerDetailCache;
  if (!p || !p.models || p.models.length === 0) {
    state.running = false;
    state.pid = null;
    if (batchBtn) {
      batchBtn.textContent = t('batchTest');
      batchBtn.className = 'btn btn-sm';
    }
    return;
  }

  try {
    for (var i = 0; i < p.models.length; i++) {
      if (state.aborted) break;
      var m = p.models[i];
      state.currentModelId = m.id;

      var rowEl = document.getElementById('mrow-' + sanitizeId(pid) + '-' + sanitizeId(m.id));
      var modelBtn = rowEl ? rowEl.querySelector('.btn-test-model') : null;
      if (modelBtn) {
        await withLoading(modelBtn, function() {
          return testSingleModel(pid, m.id);
        });
      } else {
        await testSingleModel(pid, m.id);
      }
    }
  } finally {
    state.running = false;
    state.pid = null;
    state.currentModelId = null;
    state.aborted = false;
    var finalBatchBtn = document.getElementById('batch-test-btn');
    if (finalBatchBtn) {
      finalBatchBtn.textContent = t('batchTest');
      finalBatchBtn.className = 'btn btn-sm';
    }
  }
}

// buildMiniProtocolBadges returns the inline 3-dot mini badge HTML for a model
// row, mirroring the per-protocol status from modelTestStatus.
function buildMiniProtocolBadges(ts, modelId) {
  var letters = [
    ['openaiCompat', 'O', t('protoOpenAICompat')],
    ['openaiResponses', 'R', t('protoOpenAIResponses')],
    ['anthropic', 'A', t('protoAnthropic')]
  ];
  var html = '<span class="mp-mini-badges">';
  letters.forEach(function(p) {
    var r = ts ? ts[p[0]] : null;
    var cls = 'mp-skip';
    var title = p[2] + ': ' + t('untested');
    var hasData = !!r;
    if (r) {
      if (r.ok) {
        cls = 'mp-ok';
        title = p[2] + ': ' + t('mptestStatusOk') + (r.latencyMs != null ? ' (' + r.latencyMs + 'ms)' : '');
      } else if (r.skipped) {
        cls = 'mp-skip';
        title = p[2] + ': ' + t('mptestStatusSkip');
      } else {
        cls = 'mp-err';
        title = p[2] + ': ' + (r.status || r.error || t('mptestStatusFail'));
      }
    }
    var cursorStyle = hasData ? 'cursor:pointer' : 'cursor:default';
    var onclickAttr = hasData ? ' onclick="showProtoDetail(\'' + escapeForJsString(modelId || '') + '\',\'' + p[0] + '\')"' : '';
    html += '<span class="mp-mini-badge ' + cls + '" data-model="' + escapeAttr(modelId || '') + '" data-proto="' + p[0] + '" style="' + cursorStyle + '"' + onclickAttr + ' title="' + escapeAttr(title) + '">' + escapeAttr(p[1]) + '</span>';
  });
  html += '</span>';
  return html;
}

// ===================== Info Modal =====================

function showProtoDetail(modelId, protoKey) {
  var ts = modelTestStatus[modelId];
  var r = ts ? ts[protoKey] : null;

  var overlay = document.getElementById('info-modal-overlay');
  var titleEl = document.getElementById('info-modal-title');
  var bodyEl = document.getElementById('info-modal-body');

  var nameMap = {
    openaiCompat: 'protoOpenAICompat',
    openaiResponses: 'protoOpenAIResponses',
    anthropic: 'protoAnthropic'
  };
  var nameKey = nameMap[protoKey] || protoKey;
  titleEl.textContent = modelId + ' \u2014 ' + t(nameKey);

  if (!r) {
    __infoModalSections = [];
    bodyEl.innerHTML = '<div class="info-section"><div class="info-section-title">' + t('noData') + '</div><pre class="info-json">' + t('untested') + '</pre></div>';
  } else {
    __infoModalSections = [];
    bodyEl.innerHTML = renderProtocolSection(protoKey, r);
  }

  overlay.classList.add('show');
  document.addEventListener('keydown', infoModalEscapeHandler);
}

// renderProtocolSection renders a single-protocol block for the Info modal:
// a header (protocol display name + OK/FAIL/SKIP badge) and the protocol's
// status / latency / error fields plus Request / ResponseHeaders / ResponseBody
// sub-sections when present.
function renderProtocolSection(key, r) {
  var nameKey = {
    openaiCompat: 'protoOpenAICompat',
    openaiResponses: 'protoOpenAIResponses',
    anthropic: 'protoAnthropic'
  }[key] || key;
  var statusKey, statusCls;
  if (r.ok) { statusKey = 'mptestStatusOk'; statusCls = 'mp-ok'; }
  else if (r.skipped) { statusKey = 'mptestStatusSkip'; statusCls = 'mp-skip'; }
  else { statusKey = 'mptestStatusFail'; statusCls = 'mp-err'; }

  var header =
    '<div class="info-modal-proto-header">' +
      '<span>' + escapeHtml(t(nameKey)) + '</span>' +
      '<span class="info-modal-proto-status ' + statusCls + '">' + escapeHtml(t(statusKey)) + '</span>' +
    '</div>';

  var metaHtml = '';
  metaHtml += renderInfoSection(t('status'), { status: r.status });
  metaHtml += renderInfoSection(t('latency'), { latencyMs: r.latencyMs });
  metaHtml += renderInfoSection(t('error'), { error: r.error });

  var detailHtml = '';
  if (r.request) {
    var reqRawOverrides = {};
    if (r.request.bodyRaw != null) reqRawOverrides.body = r.request.bodyRaw;
    detailHtml += renderInfoSection(t('requestInfo'), r.request, reqRawOverrides);
  }
  if (r.responseHeaders) {
    detailHtml += renderInfoSection(t('responseHeaders'), r.responseHeaders);
  }
  if (r.responseBody != null) {
    var respRawOverrides = {};
    if (r.responseBodyRaw != null) respRawOverrides.responseBody = r.responseBodyRaw;
    detailHtml += renderInfoSection(t('responseBody'), r.responseBody, respRawOverrides);
  }

  return '<div class="info-modal-proto-section">' + header + metaHtml + detailHtml + '</div>';
}

function closeInfoModal() {
  var overlay = document.getElementById('info-modal-overlay');
  overlay.classList.remove('show');
  document.removeEventListener('keydown', infoModalEscapeHandler);
}

function infoModalEscapeHandler(e) {
  if (e.key === 'Escape') {
    closeInfoModal();
  }
}

async function addModelDetail(pid) {
  const modelId = document.getElementById('m-input').value.trim();
  if (!modelId) { toast(t('enterModelId2'), 'error'); return; }
  await apiPost('/providers/' + pid + '/models', { model: modelId });
  toast(t('modelAdded'), 'success');
  currentProviderId = pid;
  const data = await apiGet('/providers');
  const p = (data.providers || []).find(function(x) { return x.id === pid; });
  if (p) {
    providerDetailCache = p;
    renderDetailModels(p);
  }
  const inputEl = document.getElementById('m-input');
  if (inputEl) inputEl.value = '';
}

async function deleteModelDetail(pid, modelId) {
  var resp = await apiDelete('/providers/' + pid + '/models?model=' + encodeURIComponent(modelId));
  if (resp.error) {
    toast(t('modelDeleteFailed') + resp.error, 'error');
    currentProviderId = pid;
    const errData = await apiGet('/providers');
    const errP = (errData.providers || []).find(function(x) { return x.id === pid; });
    if (errP) {
      providerDetailCache = errP;
      renderDetailModels(errP);
    }
    return;
  }
  delete modelTestStatus[modelId];
  toast(t('modelDeleted'), 'success');
  currentProviderId = pid;
  const data = await apiGet('/providers');
  const p = (data.providers || []).find(function(x) { return x.id === pid; });
  if (p) {
    providerDetailCache = p;
    renderDetailModels(p);
  }
}

function enterBatchManage(pid) {
  batchManageMode = true;
  batchSelectedModels.clear();
  renderDetailModels(providerDetailCache);
}

function updateBatchToggleSelectBtn() {
  var btn = document.getElementById('batch-toggle-select-btn');
  if (!btn) return;
  var p = providerDetailCache;
  var models = (p && p.models) ? p.models : [];
  var allSelected = models.length > 0 && batchSelectedModels.size === models.length;
  btn.textContent = allSelected ? t('deselectAll') : t('selectAll');
}

function batchToggleModel(mid) {
  if (batchSelectedModels.has(mid)) {
    batchSelectedModels.delete(mid);
  } else {
    batchSelectedModels.add(mid);
  }
  var rows = document.querySelectorAll('[data-batch-mid]');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute('data-batch-mid') === mid) {
      if (batchSelectedModels.has(mid)) {
        rows[i].classList.add('batch-selected');
      } else {
        rows[i].classList.remove('batch-selected');
      }
      break;
    }
  }
  updateBatchToggleSelectBtn();
}

function batchToggleSelectAll() {
  var p = providerDetailCache;
  if (!p) return;
  var models = p.models || [];
  if (models.length === 0) return;
  var allSelected = models.length > 0 && batchSelectedModels.size === models.length;
  if (allSelected) {
    batchSelectedModels.clear();
  } else {
    for (var i = 0; i < models.length; i++) {
      batchSelectedModels.add(models[i].id);
    }
  }
  var rows = document.querySelectorAll('[data-batch-mid]');
  for (var j = 0; j < rows.length; j++) {
    var rmid = rows[j].getAttribute('data-batch-mid');
    if (batchSelectedModels.has(rmid)) {
      rows[j].classList.add('batch-selected');
    } else {
      rows[j].classList.remove('batch-selected');
    }
  }
  updateBatchToggleSelectBtn();
}

function batchSelectAll() {
  var p = providerDetailCache;
  if (!p) return;
  var models = p.models || [];
  for (var i = 0; i < models.length; i++) {
    batchSelectedModels.add(models[i].id);
  }
  var rows = document.querySelectorAll('[data-batch-mid]');
  for (var j = 0; j < rows.length; j++) {
    rows[j].classList.add('batch-selected');
  }
  updateBatchToggleSelectBtn();
}

function batchInvert() {
  var p = providerDetailCache;
  if (!p) return;
  var models = p.models || [];
  for (var i = 0; i < models.length; i++) {
    var mid = models[i].id;
    if (batchSelectedModels.has(mid)) {
      batchSelectedModels.delete(mid);
    } else {
      batchSelectedModels.add(mid);
    }
  }
  var rows = document.querySelectorAll('[data-batch-mid]');
  for (var j = 0; j < rows.length; j++) {
    var rmid = rows[j].getAttribute('data-batch-mid');
    if (batchSelectedModels.has(rmid)) {
      rows[j].classList.add('batch-selected');
    } else {
      rows[j].classList.remove('batch-selected');
    }
  }
  updateBatchToggleSelectBtn();
}

function filterBatchModels(val) {
  var filterText = (val || '').trim().toLowerCase();
  var rows = document.querySelectorAll('#model-list [data-batch-mid]');
  for (var i = 0; i < rows.length; i++) {
    var mid = rows[i].getAttribute('data-batch-mid') || '';
    if (!filterText || mid.toLowerCase().indexOf(filterText) >= 0) {
      rows[i].style.display = '';
    } else {
      rows[i].style.display = 'none';
    }
  }
}

function clearBatchFilter() {
  var input = document.getElementById('batch-filter-input');
  if (input) {
    input.value = '';
    filterBatchModels('');
  }
}

async function batchKeepSelected(pid) {
  if (batchSelectedModels.size === 0) {
    toast(t('noModelsSelected'), 'warning');
    return;
  }
  var p = providerDetailCache;
  if (!p || !p.models) return;
  var allModels = p.models;
  var toDelete = [];
  for (var i = 0; i < allModels.length; i++) {
    if (!batchSelectedModels.has(allModels[i].id)) {
      toDelete.push(allModels[i].id);
    }
  }
  if (toDelete.length === 0) {
    batchManageMode = false;
    batchSelectedModels.clear();
    renderDetailModels(p);
    return;
  }
  var ok = await confirmModal(t('confirmKeepSelected', [batchSelectedModels.size, toDelete.length]));
  if (!ok) return;
  var deleted = 0;
  for (var j = 0; j < toDelete.length; j++) {
    var resp = await apiDelete('/providers/' + pid + '/models?model=' + encodeURIComponent(toDelete[j]));
    if (!resp.error) {
      delete modelTestStatus[toDelete[j]];
      deleted++;
    }
  }
  batchManageMode = false;
  batchSelectedModels.clear();
  toast(t('batchDeleted', [deleted]), 'success');
  currentProviderId = pid;
  const data = await apiGet('/providers');
  const np = (data.providers || []).find(function(x) { return x.id === pid; });
  if (np) {
    providerDetailCache = np;
    renderDetailModels(np);
  }
}

async function batchRemoveSelected(pid) {
  if (batchSelectedModels.size === 0) {
    toast(t('noModelsSelected'), 'warning');
    return;
  }
  var ok = await confirmModal(t('confirmRemoveSelected', [batchSelectedModels.size]));
  if (!ok) return;
  var toDelete = Array.from(batchSelectedModels);
  var deleted = 0;
  for (var i = 0; i < toDelete.length; i++) {
    var resp = await apiDelete('/providers/' + pid + '/models?model=' + encodeURIComponent(toDelete[i]));
    if (!resp.error) {
      delete modelTestStatus[toDelete[i]];
      deleted++;
    }
  }
  batchManageMode = false;
  batchSelectedModels.clear();
  toast(t('batchDeleted', [deleted]), 'success');
  currentProviderId = pid;
  const data = await apiGet('/providers');
  const np = (data.providers || []).find(function(x) { return x.id === pid; });
  if (np) {
    providerDetailCache = np;
    renderDetailModels(np);
  }
}

function batchCancel() {
  batchManageMode = false;
  batchSelectedModels.clear();
  renderDetailModels(providerDetailCache);
}

async function importModels(pid) {
  const p = providerDetailCache;
  const resultEl = document.getElementById('m-test-result');
  if (resultEl) resultEl.innerHTML = '<span class="badge badge-testing">' + t('fetchingModels') + '</span>';
  try {
    const data = await apiGet('/providers/' + pid + '/models');
    if (data.error) {
      if (resultEl) resultEl.innerHTML = '<span class="badge badge-invalid">' + escapeHtml(data.error) + '</span>';
      return;
    }
    const models = data.models || [];
    if (models.length === 0) {
      if (resultEl) resultEl.innerHTML = '<span class="badge badge-invalid">' + t('noModelsUpstream') + '</span>';
      return;
    }
    const existing = new Set((p.models || []).map(function(x) { return x.id; }));
    var added = 0;
    for (const m of models) {
      if (!existing.has(m.id)) {
        await apiPost('/providers/' + pid + '/models', { model: m.id });
        added++;
      }
    }
    if (resultEl) resultEl.innerHTML = '<span class="badge badge-valid">' + t('importedModels', [added, models.length, models.length - added]) + '</span>';
    setTimeout(async function() {
      currentProviderId = pid;
      const data = await apiGet('/providers');
      const p = (data.providers || []).find(function(x) { return x.id === pid; });
      if (p) {
        providerDetailCache = p;
        renderDetailModels(p);
      }
    }, 1500);
  } catch (e) {
    if (resultEl) {
      resultEl.innerHTML = '<span class="badge badge-invalid">' + t('failed', [e.message || 'unknown error']) + '</span>';
    }
  }
}

async function updateModelQuotaType(pid, selectEl) {
  var modelId = selectEl.getAttribute('data-model');
  var quotaType = selectEl.value;
  try {
    await apiPatch('/providers/' + pid + '/models/quota', { model: modelId, quotaType: quotaType });
    toast(t('quotaType') + ' \u2192 ' + t(quotaType), 'success');
  } catch (e) {
    toast(e.message || t('failed'), 'error');
  }
}

async function updateModelKind(pid, selectEl) {
  var modelId = selectEl.getAttribute('data-model');
  var kind = selectEl.value;
  try {
    await apiPatch('/providers/' + pid + '/models/kind', { model: modelId, kind: kind });
    toast(t('modelKind') + ' \u2192 ' + t(kind === 'text' ? 'textModel' : 'imageModel'), 'success');
    var row = selectEl.closest('.model-row-main');
    var protoSelect = row ? row.querySelector('.model-protocol-select') : null;
    if (protoSelect) {
      if (kind === 'image') {
        protoSelect.style.display = '';
        if (!protoSelect.value) {
          protoSelect.value = 'gpt';
        }
      } else {
        protoSelect.style.display = 'none';
      }
    }
  } catch (e) {
    toast(e.message || t('failed'), 'error');
  }
}

async function updateModelImgProtocol(pid, selectEl) {
  var modelId = selectEl.getAttribute('data-model');
  var imgProtocol = selectEl.value;
  try {
    await apiPatch('/providers/' + pid + '/models/imgProtocol', { model: modelId, imgProtocol: imgProtocol });
    toast(t('imgProtocol') + ' \u2192 ' + imgProtocol, 'success');
  } catch (e) {
    toast(e.message || t('failed'), 'error');
  }
}

async function toggleProvider(id, active) {
  const p = providerDetailCache || providersCache.find(function(x) { return x.id === id; });
  if (!p) return;
  p.isActive = active;
  await apiPut('/providers/' + id, p);
  currentProviderId = id;
  renderProviders(document.getElementById('page-content'));
}

async function deleteProvider(id) {
  const ok = await confirmModal(t('confirmDeleteProvider'));
  if (!ok) return;
  await apiDelete('/providers/' + id);
  toast(t('providerDeleted'), 'success');
  backToProviderList();
}

function showEditProvider(id) {
  var p = providerDetailCache;
  if (!p) return;
  var strategy = p.rotationStrategy || '';
  var sticky = p.stickyLimit || 0;
  var summary = document.getElementById('detail-info-summary');
  if (summary) summary.style.display = 'none';
  var el = document.getElementById('detail-info');
  el.innerHTML = '\
    <div class="card">\
      <div class="card-title">' + t('editProvider') + '</div>\
      <div class="flex" style="gap:12px">\
        <div class="form-group" style="flex:1"><label for="ep-prefix">' + t('prefixLabel') + '</label><input id="ep-prefix" value="' + escapeHtml(p.prefix) + '"></div>\
        <div class="form-group" style="flex:1"><label for="ep-name">' + t('name') + '</label><input id="ep-name" value="' + escapeHtml(p.name) + '"></div>\
      </div>\
      <div class="form-group"><label for="ep-url">' + t('baseUrlLabel') + ' <span class="form-hint" style="display:inline;margin:0 0 0 8px">' + t('baseUrlHint') + '</span></label><input id="ep-url" placeholder="https://api.deepseek.com  或  https://host/v1beta/openai" value="' + escapeHtml(p.baseUrl) + '"></div>\
      <div class="form-group mt-12">\
        <label>' + t('useProxy') + ' <span class="form-hint" style="display:inline;margin:0 0 0 8px">' + t('useProxyDesc') + '</span></label>\
        <label class="toggle-switch" for="ep-useproxy">\
          <input type="checkbox" id="ep-useproxy" ' + (p.useProxy ? 'checked' : '') + '>\
          <span class="toggle-slider"></span>\
        </label>\
      </div>\
      <div class="form-group mt-12">\
        <label for="r-strategy">' + t('strategy') + '</label>\
        <select id="r-strategy">\
          <option value=""' + (strategy === '' ? ' selected' : '') + '>' + t('inheritGlobal') + '</option>\
          <option value="fill-first"' + (strategy === 'fill-first' ? ' selected' : '') + '>' + t('fillFirst') + '</option>\
          <option value="round-robin"' + (strategy === 'round-robin' ? ' selected' : '') + '>' + t('roundRobin') + '</option>\
          <option value="failover"' + (strategy === 'failover' ? ' selected' : '') + '>' + t('failover') + '</option>\
        </select>\
      </div>\
      <div class="form-group">\
        <label for="r-sticky">' + t('stickyLabel') + '</label>\
        <input type="number" id="r-sticky" value="' + sticky + '" style="max-width:120px">\
      </div>\
      <div class="flex" style="gap:8px">\
        <button type="button" class="btn btn-primary" onclick="withLoading(this, () => saveEditProvider(\'' + id + '\'))">' + t('save') + '</button>\
        <button type="button" class="btn" onclick="cancelEditProvider()">' + t('cancel') + '</button>\
      </div>\
    </div>';
}

async function saveEditProvider(id) {
  var p = providerDetailCache;
  if (!p) return;
  p.name = document.getElementById('ep-name').value.trim();
  p.prefix = document.getElementById('ep-prefix').value.trim();
  p.baseUrl = document.getElementById('ep-url').value.trim();
  p.useProxy = document.getElementById('ep-useproxy').checked;
  p.rotationStrategy = document.getElementById('r-strategy').value;
  p.stickyLimit = parseInt(document.getElementById('r-sticky').value) || 0;
  if (!p.name || !p.prefix || !p.baseUrl) {
    toast(t('requiredFields'), 'error');
    return;
  }
  await apiPut('/providers/' + id, p);
  toast(t('providerUpdated'), 'success');
  currentProviderId = id;
  const data = await apiGet('/providers');
  const np = (data.providers || []).find(function(x) { return x.id === id; });
  if (np) {
    providerDetailCache = np;
    // Update h2 text
    var h2 = document.querySelector('.provider-detail-header h2');
    if (h2) h2.textContent = np.name;
    // Update and show summary in header
    var summary = document.getElementById('detail-info-summary');
    if (summary) {
      summary.innerHTML = t('prefix') + ' <span class="code">' + escapeHtml(np.prefix) + '</span> | ' + t('baseUrl') + ' <span class="code copyable" data-copy="' + escapeHtml(np.baseUrl) + '" onclick="copyToClipboard(this.getAttribute(\'data-copy\'))" title="' + t('clickToCopy') + '">' + escapeHtml(np.baseUrl) + '</span>';
      summary.style.display = '';
    }
    // Clear detail-info (rotation is now part of edit form)
    var infoEl = document.getElementById('detail-info');
    if (infoEl) {
      infoEl.innerHTML = '';
    }
  }
}

function cancelEditProvider() {
  var p = providerDetailCache;
  if (!p) return;
  var summary = document.getElementById('detail-info-summary');
  if (summary) summary.style.display = '';
  var el = document.getElementById('detail-info');
  el.innerHTML = '';
}

// ===================== Model Alias / Note / NIM Modals =====================

function showModelAliasModal(pid, mid, currentAlias) {
  openSettingsModal(t('setAlias'),
    '<div class="form-group">\
      <label>' + t('aliasDesc') + '</label>\
      <input id="modal-alias-input" value="' + escapeHtml(currentAlias) + '" placeholder="e.g. my-fast-model">\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveModelAlias(pid, mid); });
  };
  requestAnimationFrame(function() {
    var input = document.getElementById('modal-alias-input');
    if (input) { input.focus(); if (typeof input.select === 'function') input.select(); }
  });
}

async function saveModelAlias(pid, mid) {
  var alias = document.getElementById('modal-alias-input').value.trim();
  var p = (providersCache || []).find(function(item) { return item.id === pid; });
  if (p && p.prefix && alias.indexOf(p.prefix + '/') === 0) {
    alias = alias.slice(p.prefix.length + 1).trim();
  }
  try {
    await apiPatch('/providers/' + pid + '/models/alias', { model: mid, alias: alias });
    toast(t('aliasSaved'), 'success');
    closeModalOverlay();
    currentProviderId = pid;
    renderProviders(document.getElementById('page-content'));
  } catch (e) {
    toast(e.message || t('failed'), 'error');
  }
}

function showModelNoteModal(pid, mid, currentNote) {
  openSettingsModal(t('setNote'),
    '<div class="form-group">\
      <label>' + t('noteDesc') + '</label>\
      <textarea id="modal-note-input" rows="4" style="width:100%;resize:vertical">' + escapeHtml(currentNote) + '</textarea>\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveModelNote(pid, mid); });
  };
  requestAnimationFrame(function() {
    var input = document.getElementById('modal-note-input');
    if (input) { input.focus(); if (typeof input.setSelectionRange === 'function') input.setSelectionRange(input.value.length, input.value.length); }
  });
}

async function saveModelNote(pid, mid) {
  var note = document.getElementById('modal-note-input').value.trim();
  try {
    await apiPatch('/providers/' + pid + '/models/note', { model: mid, note: note });
    toast(t('noteSaved'), 'success');
    closeModalOverlay();
    currentProviderId = pid;
    renderProviders(document.getElementById('page-content'));
  } catch (e) {
    toast(e.message || t('failed'), 'error');
  }
}

function showModelNIMModal(pid, mid, btnEl) {
  var enabled = btnEl.getAttribute('data-nim-enabled') === '1';
  var reqCount = parseInt(btnEl.getAttribute('data-nim-count')) || 0;
  var minInterval = parseInt(btnEl.getAttribute('data-nim-interval')) || 0;
  openSettingsModal(t('modelNIM'),
    '<p class="muted" style="margin:0 0 16px;line-height:1.55">' + t('nimDesc') + '</p>\
    <div class="form-group" style="margin-bottom:16px">\
      <label style="margin-bottom:0;display:inline-flex;align-items:center;cursor:pointer">' + t('nimEnabled') + '\
        <label class="toggle-switch" style="margin-left:8px">\
          <input type="checkbox" id="modal-nim-enabled" ' + (enabled ? 'checked' : '') + '>\
          <span class="toggle-slider"></span>\
        </label>\
      </label>\
    </div>\
    <div class="form-group" style="margin-bottom:16px">\
      <label style="margin-bottom:6px;display:block">' + t('nimRequestCount') + '</label>\
      <input type="number" id="modal-nim-count" value="' + reqCount + '" placeholder="30" style="max-width:120px">\
    </div>\
    <div class="form-group" style="margin-bottom:0">\
      <label style="margin-bottom:6px;display:block">' + t('nimMinInterval') + '</label>\
      <input type="number" id="modal-nim-interval" value="' + minInterval + '" placeholder="2000" style="max-width:120px">\
      <div class="form-hint" style="margin-top:6px;margin-bottom:0">' + t('nimMinIntervalHint') + '</div>\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveModelNIM(pid, mid); });
  };
  requestAnimationFrame(function() {
    var input = document.getElementById('modal-nim-count');
    if (input) { input.focus(); if (typeof input.select === 'function') input.select(); }
  });
}

async function saveModelNIM(pid, mid) {
  var enabled = document.getElementById('modal-nim-enabled').checked;
  var count = parseInt(document.getElementById('modal-nim-count').value) || 0;
  var interval = parseInt(document.getElementById('modal-nim-interval').value) || 0;
  try {
    await apiPatch('/providers/' + pid + '/models/nim', {
      model: mid,
      nim: {
        enabled: enabled,
        request_count_per_key: count,
        min_interval_ms: interval
      }
    });
    toast(t('nimSaved'), 'success');
    closeModalOverlay();
    currentProviderId = pid;
    renderProviders(document.getElementById('page-content'));
  } catch (e) {
    toast(e.message || t('failed'), 'error');
  }
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    var modalOverlay = document.getElementById('modal-overlay');
    var infoOverlay = document.getElementById('info-modal-overlay');
    var confirmOverlay = document.getElementById('confirm-modal-overlay');
    if ((modalOverlay && modalOverlay.classList.contains('show')) ||
        (infoOverlay && infoOverlay.classList.contains('show')) ||
        (confirmOverlay && confirmOverlay.classList.contains('show'))) {
      return;
    }
    if (typeof currentProviderId !== 'undefined' && currentProviderId) {
      e.preventDefault();
      e.stopPropagation();
      backToProviderList();
    }
  }
}, true);
