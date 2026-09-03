// ===================== Providers Page =====================
// providers.js — provider list + cards (split from monolith)
// Shared state (also used by detail/models/keys via global scope)

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
          <button type="button" class="btn btn-sm provider-btn-col2" onclick="toggleProviderList(event, \'' + escapeForJsString(p.id) + '\',' + (!p.isActive) + ')">' + (p.isActive ? t('disable') : t('enable')) + '</button>\
        </div>\
      </div>\
      <div class="provider-card-row mt-12">\
        <div class="provider-card-left">\
          <span class="muted">' + t('keys') + ' ' + (p.keyCount != null ? p.keyCount : (p.keys ? p.keys.length : 0)) + ' | ' + t('models') + ' ' + (p.models ? p.models.length : 0) + '</span>\
        </div>\
        <div class="provider-card-actions">\
          <button type="button" class="btn btn-sm provider-btn-col1" onclick="event.stopPropagation(); openProviderDetail(\'' + escapeForJsString(p.id) + '\')">' + t('edit') + '</button>\
          <button type="button" class="btn btn-sm btn-danger provider-btn-col2" onclick="deleteProviderFromList(event, \'' + escapeForJsString(p.id) + '\')">' + t('delete') + '</button>\
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
  // Settings 页同时展示 combos/quickslot：后端删除已自动清理无效引用，
  // 此处整页重拉使清理结果即时可见（独立 Providers 页无 #combo-list，不触发）。
  if (document.getElementById('combo-list') && typeof renderEndpoint === 'function') {
    renderEndpoint(document.getElementById('page-content'));
  }
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
    <div class="form-row-grid" style="grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">\
      <div class="form-group" style="margin-bottom:0"><label for="p-name">' + t('name') + '</label><input id="p-name" class="input" placeholder="DeepSeek"></div>\
      <div class="form-group" style="margin-bottom:0"><label for="p-prefix">' + t('prefixLabel') + '</label><input id="p-prefix" class="input" placeholder="deepseek"></div>\
    </div>\
    <div class="form-group" style="margin-bottom:4px"><label for="p-url">' + t('baseUrlLabel') + '</label><input id="p-url" class="input" placeholder="https://api.deepseek.com  或  https://host/v1beta/openai"></div>\
    <div class="form-hint" style="margin-bottom:14px;margin-top:4px">' + t('baseUrlHint') + '</div>\
    <div class="form-group" style="margin-bottom:14px"><label for="p-apikey">' + t('apiKeyLabel') + '</label><input type="password" id="p-apikey" class="input" placeholder="sk-..."></div>\
    <div class="form-group" style="margin-bottom:14px"><label for="p-modelid">' + t('modelIdLabel') + '</label><input id="p-modelid" class="input" placeholder="deepseek-chat"></div>\
    <div class="form-group" style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;margin-bottom:0">\
      <div>\
        <label style="margin-bottom:2px;display:block">' + t('useProxy') + '</label>\
        <div class="form-hint" style="margin-top:2px;margin-bottom:0">' + t('useProxyDesc') + '</div>\
      </div>\
      <label class="toggle-switch" for="p-useproxy" style="flex-shrink:0;margin-left:16px">\
        <input type="checkbox" id="p-useproxy">\
        <span class="toggle-slider"></span>\
      </label>\
    </div>\
    <div class="form-group" style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;margin-bottom:0">\
      <div>\
        <label style="margin-bottom:2px;display:block">' + t('allowPrivateNetwork') + '</label>\
        <div class="form-hint" style="margin-top:2px;margin-bottom:0">' + t('allowPrivateNetworkDesc') + '</div>\
      </div>\
      <label class="toggle-switch" for="p-allownet" style="flex-shrink:0;margin-left:16px">\
        <input type="checkbox" id="p-allownet">\
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
    const result = await apiPost('/providers/validate', { baseUrl: baseUrl, apiKey: apiKey, modelId: modelId || undefined, useProxy: (document.getElementById('p-useproxy') ? document.getElementById('p-useproxy').checked : false), allowPrivate: (document.getElementById('p-allownet') ? document.getElementById('p-allownet').checked : false) });
    if (result.valid) {
      const method = result.method ? ' (via ' + result.method + ')' : '';
      resultEl.innerHTML = '<span class="badge badge-valid">' + t('validProvider') + method + '</span>';
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
    models: []
  };
  p.useProxy = document.getElementById('p-useproxy').checked;
  p.allowPrivateNetwork = document.getElementById('p-allownet').checked;
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
      card.classList.add('provider-temp-highlight');
      (function(c) {
        setTimeout(function() { c.classList.remove('provider-temp-highlight'); }, 2000);
      })(card);
      break;
    }
  }
}

function escapeAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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