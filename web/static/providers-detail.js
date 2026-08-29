// providers-detail.js — provider detail page + edit + rotation/order


async function renderProviderDetail(c, id) {
  showSkeleton(c, 1);
  const data = await apiGet('/providers');
  const allProviders = data.providers || [];
  const p = allProviders.find(function(x) { return x.id === id; });
  if (!p) {
    c.innerHTML = emptyState(t('providerNotFound'));
    return;
  }
  // The provider list no longer embeds keys (secret-minimized DTO): fetch the
  // masked key list separately for the detail view.
  await loadDetailKeys(p);
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
          <p class="muted" id="detail-info-summary" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + t('prefix') + ' <span class="code">' + escapeHtml(p.prefix) + '</span> | ' + t('baseUrl') + ' <span class="code copyable" data-copy="' + baseUrlAttr + '" onclick="copyToClipboard(this.getAttribute(\'data-copy\'))" data-tooltip="' + t('clickToCopy') + '">' + baseUrlEsc + '</span></p>\
          <div class="flex" style="gap:8px;flex-shrink:0;align-items:center;white-space:nowrap">\
            <button type="button" class="btn btn-sm" style="white-space:nowrap;flex-shrink:0" onclick="backToProviderList()">' + t('back') + '</button>\
            <button type="button" class="btn btn-sm" style="white-space:nowrap;flex-shrink:0" onclick="showEditProvider(\'' + escapeForJsString(p.id) + '\')">' + t('edit') + '</button>\
            <button type="button" class="btn btn-sm ' + (p.isActive ? '' : 'btn-primary') + '" style="white-space:nowrap;flex-shrink:0" onclick="toggleProvider(\'' + escapeForJsString(p.id) + '\',' + (!p.isActive) + ')">' + (p.isActive ? t('disable') : t('enable')) + '</button>\
            <button type="button" class="btn btn-sm btn-danger" style="white-space:nowrap;flex-shrink:0" onclick="deleteProvider(\'' + escapeForJsString(p.id) + '\')">' + t('delete') + '</button>\
            ' + renderStepperHtml('provider-order-input', currentOrder, 1, totalProviders, 1, 'max-width:110px;display:inline-flex;', 'changeProviderOrder(\'' + escapeForJsString(p.id) + '\', ' + currentOrder + ', ' + totalProviders + ', this.value)') + '\
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

// loadDetailKeys fetches the masked key list for a provider detail view. The
// provider list API returns only keyCount/hasKey (F-04 secret-minimized DTO),
// so the key table is populated from GET /providers/{id}/keys.
async function loadDetailKeys(p) {
  if (!p || !p.id) return p;
  try {
    const data = await apiGet('/providers/' + encodeURIComponent(p.id) + '/keys');
    p.keys = (data && data.keys) || [];
  } catch (e) {
    p.keys = [];
  }
  return p;
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


async function reloadProviderDetail(providerId) {
  currentProviderId = providerId;
  const data = await apiGet('/providers');
  const p = (data.providers || []).find(function(x) { return x.id === providerId; });
  if (p) {
    await loadDetailKeys(p);
    providerDetailCache = p;
    renderDetailKeys(p);
    renderDetailModels(p);
  }
  return p;
}

function renderDetailRotation(p) {
  const el = document.getElementById('detail-rotation');
  const strategy = p.rotationStrategy || '';
  const sticky = p.stickyLimit || 0;
  el.innerHTML = '\
    <div class="detail-block">\
      <div class="section-title">' + t('rotationSection') + '</div>\
      <p class="muted mb-12">' + t('rotationDesc') + '</p>\
      <div class="form-group mb-16">\
        <label for="r-strategy">' + t('strategy') + '</label>\
        ' + renderCustomSelectHtml('pr-strategy-wrap', 'r-strategy', [
          { value: '', label: t('inheritGlobal') },
          { value: 'fill-first', label: t('fillFirst') },
          { value: 'round-robin', label: t('roundRobin') },
          { value: 'failover', label: t('failover') }
        ], strategy || '') + '\
      </div>\
      <div class="form-group mb-16">\
        <label for="r-sticky">' + t('stickyLabel') + '</label>\
        ' + renderStepperHtml('r-sticky', sticky, 0, 9999, 1, 'max-width:140px;') + '\
      </div>\
      <button type="button" class="btn btn-primary" onclick="withLoading(this, () => saveProviderRotation(\'' + escapeForJsString(p.id) + '\'))">' + t('save') + '</button>\
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
  var hl = p.hardLimit || {};
  var summary = document.getElementById('detail-info-summary');
  if (summary) summary.style.display = 'none';
  var el = document.getElementById('detail-info');
  el.innerHTML = '\
    <div class="card provider-edit-card mb-20">\
      <div class="card-title mb-16">' + t('editProvider') + '</div>\
      <div class="form-row-grid mb-16">\
        <div class="form-group" style="margin-bottom:0"><label for="ep-prefix">' + t('prefixLabel') + '</label><input id="ep-prefix" class="input" value="' + escapeHtml(p.prefix) + '"></div>\
        <div class="form-group" style="margin-bottom:0"><label for="ep-name">' + t('name') + '</label><input id="ep-name" class="input" value="' + escapeHtml(p.name) + '"></div>\
      </div>\
      <div class="form-group mb-16"><label for="ep-url">' + t('baseUrlLabel') + ' <span class="form-hint" style="display:inline;margin-left:8px">' + t('baseUrlHint') + '</span></label><input id="ep-url" class="input" placeholder="https://api.deepseek.com  或  https://host/v1beta/openai" value="' + escapeHtml(p.baseUrl) + '"></div>\
      <div class="form-group form-group-inline mb-16">\
        <div class="form-group-label-wrap">\
          <label style="margin:0">' + t('useProxy') + '</label>\
          <span class="form-hint" style="margin:0">' + t('useProxyDesc') + '</span>\
        </div>\
        <label class="toggle-switch" for="ep-useproxy" style="flex-shrink:0">\
          <input type="checkbox" id="ep-useproxy" ' + (p.useProxy ? 'checked' : '') + '>\
          <span class="toggle-slider"></span>\
        </label>\
      </div>\
      <div class="form-group form-group-inline mb-16">\
        <div class="form-group-label-wrap">\
          <label style="margin:0">' + t('allowPrivateNetwork') + '</label>\
          <span class="form-hint" style="margin:0">' + t('allowPrivateNetworkDesc') + '</span>\
        </div>\
        <label class="toggle-switch" for="ep-allownet" style="flex-shrink:0">\
          <input type="checkbox" id="ep-allownet" ' + (p.allowPrivateNetwork ? 'checked' : '') + '>\
          <span class="toggle-slider"></span>\
        </label>\
      </div>\
      <div class="form-group mb-16">\
        <label for="r-strategy">' + t('strategy') + '</label>\
        ' + renderCustomSelectHtml('ep-strategy-wrap', 'r-strategy', [
          { value: '', label: t('inheritGlobal') },
          { value: 'fill-first', label: t('fillFirst') },
          { value: 'round-robin', label: t('roundRobin') },
          { value: 'failover', label: t('failover') }
        ], strategy || '') + '\
      </div>\
      <div class="form-group mb-16">\
        <label for="r-sticky">' + t('stickyLabel') + '</label>\
        ' + renderStepperHtml('r-sticky', sticky, 0, 9999, 1, 'max-width:140px;') + '\
      </div>\
      <div class="form-group mb-20">\
        <div class="form-group-inline mb-8">\
          <div class="form-group-label-wrap">\
            <label style="margin:0">' + t('useCustomHeader') + '</label>\
            <span class="form-hint" style="margin:0">' + t('customHeadersHint') + '</span>\
          </div>\
          <label class="toggle-switch" for="ep-customheaders" style="flex-shrink:0">\
            <input type="checkbox" id="ep-customheaders" ' + (p.useCustomHeaders ? 'checked' : '') + '>\
            <span class="toggle-slider"></span>\
          </label>\
        </div>\
        <textarea id="ep-customheaders-text" class="input mt-8" rows="4" style="width:100%;resize:vertical" placeholder="' + t('customHeadersPlaceholder') + '">' + escapeHtml(providerHeadersToText(p)) + '</textarea>\
      </div>\
      <div class="form-group mb-16">\
        <div class="form-group-label-wrap">\
          <label style="margin:0">' + t('hardLimit') + '</label>\
          <span class="form-hint" style="margin:0">' + t('hardLimitDesc') + '</span>\
        </div>\
        <div class="form-group-inline" style="margin-top:8px;margin-bottom:8px">\
          <label style="margin:0;min-width:180px">' + t('hardLimitRPM') + '</label>\
          ' + renderStepperHtml('ep-hl-rpm', hl.rpm || 0, 0, 1000000, 1, 'max-width:140px;') + '\
          <label class="toggle-switch" for="ep-hl-rpm-enabled" style="flex-shrink:0;margin-left:12px">\
            <input type="checkbox" id="ep-hl-rpm-enabled" ' + (hl.rpmEnabled ? 'checked' : '') + '>\
            <span class="toggle-slider"></span>\
          </label>\
        </div>\
        <div class="form-group-inline" style="margin-bottom:0">\
          <label style="margin:0;min-width:180px">' + t('hardLimitTPM') + '</label>\
          ' + renderStepperHtml('ep-hl-tpm', hl.tpm || 0, 0, 100000000, 100, 'max-width:140px;') + '\
          <label class="toggle-switch" for="ep-hl-tpm-enabled" style="flex-shrink:0;margin-left:12px">\
            <input type="checkbox" id="ep-hl-tpm-enabled" ' + (hl.tpmEnabled ? 'checked' : '') + '>\
            <span class="toggle-slider"></span>\
          </label>\
        </div>\
      </div>\
      <div class="form-footer-actions">\
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
  p.allowPrivateNetwork = document.getElementById('ep-allownet').checked;
  p.useCustomHeaders = document.getElementById('ep-customheaders').checked;
  p.customHeaders = parseCustomHeadersText(document.getElementById('ep-customheaders-text').value);
  p.rotationStrategy = document.getElementById('r-strategy').value;
  p.stickyLimit = parseInt(document.getElementById('r-sticky').value) || 0;
  var rpmOn = document.getElementById('ep-hl-rpm-enabled').checked;
  var tpmOn = document.getElementById('ep-hl-tpm-enabled').checked;
  p.hardLimit = {
    rpmEnabled: rpmOn,
    rpm: parseInt(document.getElementById('ep-hl-rpm').value) || 0,
    tpmEnabled: tpmOn,
    tpm: parseInt(document.getElementById('ep-hl-tpm').value) || 0
  };
  if (!rpmOn && !tpmOn) p.hardLimit = null;
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
      summary.innerHTML = t('prefix') + ' <span class="code">' + escapeHtml(np.prefix) + '</span> | ' + t('baseUrl') + ' <span class="code copyable" data-copy="' + escapeHtml(np.baseUrl) + '" onclick="copyToClipboard(this.getAttribute(\'data-copy\'))" data-tooltip="' + t('clickToCopy') + '">' + escapeHtml(np.baseUrl) + '</span>';
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
// providerHeadersToText serializes the provider's custom headers map into one
// "Name: Value" line per entry for the edit form textarea.
function providerHeadersToText(p) {
  var out = '';
  var hdrs = p.customHeaders;
  if (hdrs && typeof hdrs === 'object') {
    Object.keys(hdrs).forEach(function(k) {
      var v = hdrs[k];
      if (v === null || v === undefined) v = '';
      out += k + ': ' + v + '\n';
    });
  }
  return out;
}

// parseCustomHeadersText parses one "Name: Value" pair per line, splitting at
// the first colon and trimming both sides. Blank lines and malformed lines
// (missing colon or empty name) are ignored. A null-prototype object is used
// so a literal "__proto__" header name cannot pollute the prototype chain.
function parseCustomHeadersText(text) {
  var result = Object.create(null);
  String(text || '').split('\n').forEach(function(line) {
    var idx = line.indexOf(':');
    if (idx <= 0) return;
    var name = line.slice(0, idx).trim();
    if (!name) return;
    result[name] = line.slice(idx + 1).trim();
  });
  return result;
}


// ===================== Model Alias / Note / NIM Modals =====================