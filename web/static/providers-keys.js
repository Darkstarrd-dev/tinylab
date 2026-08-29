// providers-keys.js — key CRUD + test (detail keys table)


function toggleKeyReveal(btn, kid) {
  var el = document.getElementById('k-disp-' + kid);
  if (!el) return;
  var isRaw = el.getAttribute('data-showing-raw') === 'true';
  if (isRaw) {
    el.textContent = el.getAttribute('data-masked');
    el.setAttribute('data-showing-raw', 'false');
    btn.style.opacity = '0.75';
  } else {
    el.textContent = el.getAttribute('data-raw');
    el.setAttribute('data-showing-raw', 'true');
    btn.style.opacity = '1';
  }
}

function renderDetailKeys(p) {
  const el = document.getElementById('detail-keys');
  const keys = p.keys || [];
  const hasKeys = keys.length > 0;
  el.innerHTML = '\
    <div class="detail-block">\
      <div class="section-title provider-keys-section-title">\
        <span class="provider-keys-title' + (hasKeys ? ' provider-keys-title-clickable' : '') + '" onclick="' + (hasKeys ? 'toggleKeysTable(\'' + escapeForJsString(p.id) + '\')' : '') + '">\
          <span id="keys-chevron-' + escapeAttr(p.id) + '" class="provider-keys-chevron' + (hasKeys ? '' : ' provider-keys-chevron-hidden') + '">\u25B6</span>' +
          t('keysTitle') + ' (' + keys.length + ')\
        </span>\
        <div class="flex provider-keys-actions">\
          <button type="button" class="btn btn-sm btn-primary" onclick="showAddKeyDetail(\'' + escapeForJsString(p.id) + '\')">' + t('addKey') + '</button>\
          <button type="button" class="btn btn-sm" onclick="showBulkAddKeys(\'' + escapeForJsString(p.id) + '\')">' + t('bulkAdd') + '</button>\
        </div>\
      </div>\
      <div id="key-form-' + escapeAttr(p.id) + '"></div>\
      <div id="keys-body-' + escapeAttr(p.id) + '" class="' + (hasKeys ? 'provider-keys-hidden' : '') + '">' +
        (hasKeys ? '\
      <table>\
        <thead><tr><th>' + t('keyName') + '</th><th>' + t('actions') + '</th><th>' + t('key') + '</th><th>' + t('priority') + '</th><th>' + t('status') + '</th></tr></thead>\
        <tbody>' +
          keys.map(function(k) {
            var rawKey = k.key || '';
            var masked = k.maskedKey || maskKey(rawKey);
            var copyText = rawKey || masked;
            return '<tr>\
              <td>' + escapeHtml(k.name) + '</td>\
              <td>\
                <button type="button" class="btn btn-sm" onclick="withLoading(this, () => testKeyDetail(\'' + escapeForJsString(p.id) + '\',\'' + escapeForJsString(k.id) + '\'))">' + t('test') + '</button>\
                <button type="button" class="btn btn-sm" onclick="toggleKeyDetail(\'' + escapeForJsString(p.id) + '\',\'' + escapeForJsString(k.id) + '\',' + (!k.isActive) + ')">' + (k.isActive ? t('pause') : t('resume')) + '</button>\
                <button type="button" class="btn btn-sm btn-danger" onclick="deleteKeyDetail(\'' + escapeForJsString(p.id) + '\',\'' + escapeForJsString(k.id) + '\')">' + t('delete') + '</button>\
              </td>\
              <td>\
                <div style="display:inline-flex;align-items:center;gap:6px">\
                  <span class="code copyable" id="k-disp-' + escapeAttr(k.id) + '" data-copy="' + escapeHtml(copyText) + '" data-masked="' + escapeHtml(masked) + '" data-raw="' + escapeHtml(rawKey) + '" onclick="copyToClipboard(this.getAttribute(\'data-copy\'), \'' + escapeForJsString(k.name || 'key') + '\')" data-tooltip="' + t('clickToCopy') + '">' + escapeHtml(masked) + '</span>\
                  ' + (rawKey ? '<button type="button" class="btn btn-sm" style="padding:1px 6px;font-size:11px;line-height:1.2;opacity:0.75" onclick="toggleKeyReveal(this, \'' + escapeForJsString(k.id) + '\')" title="Toggle reveal">\uD83D\uDC41</button>' : '') + '\
                </div>\
              </td>\
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
  var isHidden = body.classList.contains('provider-keys-hidden');
  body.classList.toggle('provider-keys-hidden', !isHidden);
  if (chevron) chevron.classList.toggle('provider-keys-expanded', isHidden);
}

function showAddKeyDetail(providerId) {
  const el = document.getElementById('key-form-' + providerId);
  el.innerHTML = '\
    <div class="card" style="background:var(--glass-bg)">\
      <div class="card-title">' + t('newKey') + '</div>\
      <div class="form-group mt-12"><label for="dk-name">' + t('keyName') + '</label><input id="dk-name" class="input" placeholder="Main"></div>\
      <div class="form-group"><label for="dk-key">' + t('apiKeyInput') + '</label><input type="password" id="dk-key" class="input" placeholder="sk-..."></div>\
      <div class="form-group"><label for="dk-priority">' + t('priorityLabel') + '</label>' + renderStepperHtml('dk-priority', 1, 1, 999, 1, 'max-width:140px;') + '</div>\
      <div class="flex" style="gap:8px">\
        <button type="button" class="btn btn-primary" onclick="withLoading(this, () => addKeyDetail(\'' + escapeForJsString(providerId) + '\'))">' + t('create') + '</button>\
        <button type="button" class="btn" onclick="document.getElementById(\'key-form-' + escapeForJsString(providerId) + '\').innerHTML=\'\'">' + t('cancel') + '</button>\
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
  await reloadProviderDetail(providerId);
  const formEl = document.getElementById('key-form-' + providerId);
  if (formEl) formEl.innerHTML = '';
}

function showBulkAddKeys(providerId) {
  const el = document.getElementById('key-form-' + providerId);
  el.innerHTML = '\
    <div class="card" style="background:var(--glass-bg)">\
      <div class="card-title">' + t('bulkAddKeys') + '</div>\
      <p class="muted mt-12">' + t('bulkFormat') + '</p>\
      <div class="form-group mt-12"><textarea id="bk-textarea" class="input" rows="8" placeholder="Main|sk-aaa\nBackup|sk-bbb\nsk-ccc"></textarea></div>\
      <div class="form-group"><label for="bk-priority">' + t('defaultPriority') + '</label>' + renderStepperHtml('bk-priority', 1, 1, 999, 1, 'max-width:140px;') + '</div>\
      <div class="flex" style="gap:8px">\
        <button type="button" class="btn btn-primary" onclick="withLoading(this, () => bulkAddKeys(\'' + escapeForJsString(providerId) + '\'))">' + t('addAll') + '</button>\
        <button type="button" class="btn" onclick="document.getElementById(\'key-form-' + escapeForJsString(providerId) + '\').innerHTML=\'\'">' + t('cancel') + '</button>\
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
    await reloadProviderDetail(providerId);
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
  const k = (p && p.keys || []).find(function(x) { return x.id === kid; });
  if (!k) return;
  k.isActive = active;
  await apiPut('/providers/' + pid + '/keys/' + kid, k);
  await reloadProviderDetail(pid);
}

async function deleteKeyDetail(pid, kid) {
  var ok = await confirmModal(t('confirmDeleteKey'));
  if (!ok) return;
  await apiDelete('/providers/' + pid + '/keys/' + kid);
  toast(t('keyDeleted'), 'success');
  await reloadProviderDetail(pid);
}
