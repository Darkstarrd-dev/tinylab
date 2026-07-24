// ===================== Endpoint Page (Settings) =====================

async function renderEndpoint(c) {
  showSkeleton(c, 2);
  const settings = await apiGet('/settings');
  window.__settings = settings;
  const s = settings;
  // Load user-overridden keyboard shortcuts into the in-memory registry.
  // System presets live in web/static/shortcuts.js; only overrides are
  // persisted to config.yaml (see PATCH /api/settings).
  if (typeof Shortcuts !== 'undefined' && s.shortcuts) {
    Shortcuts.loadOverrides(s.shortcuts || {});
  }
  const [provData, comboData, qsData] = await Promise.all([apiGet('/providers'), apiGet('/combos'), apiGet('/quickslots')]);
  providersCache = provData.providers || [];
  const combos = comboData.combos || [];
  const quickslots = qsData.quickslots || [];
  c.innerHTML = '\
    <div class="settings-layout">\
      <div class="settings-panel-left">\
        <div class="settings-row">\
          <span class="settings-row-title" title="' + escapeHtml(t('listenPortDesc')) + '">' + t('listenPort') + '</span>\
          <span class="code copyable settings-row-endpoint" onclick="copyToClipboard(this.dataset.url, this.dataset.url)" data-url="http://localhost:' + s.port + '/v1" title="' + escapeHtml(t('clickToCopy')) + '">' + s.port + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openPortModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" title="' + escapeHtml(t('proxyDesc')) + '">' + t('proxySettings') + '</span>\
          <label class="toggle-switch settings-row-toggle" title="' + escapeHtml(t('proxyDesc')) + '"><input type="checkbox" id="proxy-toggle"' + (s.proxy && s.proxy.enabled ? ' checked' : '') + ' onchange="toggleProxy(this.checked)"><span class="toggle-slider"></span></label>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openProxyModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" title="' + escapeHtml(t('rotationDesc')) + '">' + t('rotationSettings') + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openRotationModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" title="' + escapeHtml(t('serverTimeoutDesc')) + '">' + t('serverTimeoutSettings') + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openServerTimeoutModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" title="' + escapeHtml(t('passwordProtectionDesc')) + '">' + t('passwordProtection') + '</span>\
          <label class="toggle-switch settings-row-toggle" title="' + escapeHtml(t('passwordProtectionDesc')) + '"><input type="checkbox" id="password-toggle"' + (s.security && s.security.passwordEnabled ? ' checked' : '') + ' onchange="togglePasswordProtection(this.checked)"><span class="toggle-slider"></span></label>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openPasswordModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" title="' + escapeHtml(t('shortcutSettingsDesc')) + '">' + t('shortcutSettings') + '</span>\
          <span class="code settings-row-endpoint" id="shortcut-settings-summary" title="' + escapeHtml(t('shortcutSettingsDesc')) + '">' + escapeHtml(getShortcutSettingsSummary()) + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openShortcutsModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" title="' + escapeHtml(t('appearanceDesc')) + '">' + t('appearance') + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openThemeModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" title="' + escapeHtml(t('debugModeDesc')) + '">' + t('debugMode') + '</span>\
          <label class="toggle-switch settings-row-toggle" title="' + escapeHtml(t('debugModeDesc')) + '"><input type="checkbox" id="debug-mode-toggle"' + (s.debugMode ? ' checked' : '') + ' onchange="toggleDebugMode(this.checked)"><span class="toggle-slider"></span></label>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" title="' + escapeHtml(t('quickSlotOnlyDesc')) + '">' + t('quickSlotOnly') + '</span>\
          <label class="toggle-switch settings-row-toggle" title="' + escapeHtml(t('quickSlotOnlyDesc')) + '"><input type="checkbox" id="quickslot-only-toggle"' + (s.quickSlotOnly ? ' checked' : '') + ' onchange="toggleQuickSlotOnly(this.checked)"><span class="toggle-slider"></span></label>\
        </div>\
      </div>\
      <div class="settings-panel-right">\
        <div class="settings-panel-section" id="settings-section-providers" data-collapse-key="settings-providers">\
          <div class="settings-panel-header">\
            <span class="settings-panel-title settings-panel-title-clickable" onclick="toggleSettingsSectionCollapse(\'settings-providers\')">' + settingsSectionChevron() + t('providers') + '</span>\
            <button type="button" class="btn btn-primary btn-sm" onclick="showAddProvider()">' + t('addProvider') + '</button>\
          </div>\
          <div class="settings-panel-body">\
            <div id="provider-list" class="settings-card-grid"></div>\
          </div>\
        </div>\
        <div class="settings-panel-section settings-panel-split" id="settings-section-combos-quickslots">\
          <div class="settings-panel-half" id="settings-section-combos" data-collapse-key="settings-combos">\
            <div class="settings-panel-header">\
              <span class="settings-panel-title settings-panel-title-clickable" onclick="toggleSettingsSectionCollapse(\'settings-combos\')">' + settingsSectionChevron() + t('combos') + '</span>\
              <button type="button" class="btn btn-primary btn-sm" onclick="showAddCombo()">' + t('addCombo') + '</button>\
            </div>\
            <div class="settings-panel-body">\
              <div id="combo-list" class="settings-card-grid"></div>\
            </div>\
          </div>\
          <div class="settings-panel-half" id="settings-section-quickslots" data-collapse-key="settings-quickslots">\
            <div class="settings-panel-header">\
              <span class="settings-panel-title settings-panel-title-clickable" onclick="toggleSettingsSectionCollapse(\'settings-quickslots\')">' + settingsSectionChevron() + t('quickSlots') + '</span>\
              <button type="button" class="btn btn-primary btn-sm" onclick="showAddQuickSlot()">' + t('addQuickSlot') + '</button>\
            </div>\
            <div class="settings-panel-body">\
              <div id="quickslot-list" class="settings-card-grid"></div>\
            </div>\
          </div>\
        </div>\
      </div>\
    </div>';
  renderProviderList();
  renderComboListInline(combos);
  if (typeof renderQuickSlotListInline === 'function') renderQuickSlotListInline(quickslots);
  if (typeof renderHeaderQuickSlots === 'function') renderHeaderQuickSlots();
  applySettingsSectionCollapseState();
  // ThemeSystem: sync backend variants.
  ThemeSystem.initFromSettings(settings);
}

// Collapsed Settings sections persist across re-renders (renderEndpoint re-runs
// on every combo/quickslot/provider toggle).
var collapsedSettingsSections = new Set();

function settingsSectionChevron() {
  return '<svg class="settings-panel-title-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
}

function applySettingsSectionCollapseState() {
  document.querySelectorAll('[data-collapse-key]').forEach(function(el) {
    var key = el.getAttribute('data-collapse-key');
    var chevron = el.querySelector('.settings-panel-title-chevron');
    if (collapsedSettingsSections.has(key)) {
      el.classList.add('collapsed');
      if (chevron) chevron.style.transform = 'rotate(-90deg)';
    } else {
      el.classList.remove('collapsed');
      if (chevron) chevron.style.transform = '';
    }
  });
  var splitEl = document.getElementById('settings-section-combos-quickslots');
  if (splitEl) {
    if (collapsedSettingsSections.has('settings-combos') && collapsedSettingsSections.has('settings-quickslots')) {
      splitEl.classList.add('collapsed');
    } else {
      splitEl.classList.remove('collapsed');
    }
  }
}

function toggleSettingsSectionCollapse(key) {
  if (collapsedSettingsSections.has(key)) {
    collapsedSettingsSections.delete(key);
  } else {
    collapsedSettingsSections.add(key);
  }
  if (key === 'settings-combos' || key === 'settings-quickslots') {
    var other = (key === 'settings-combos') ? 'settings-quickslots' : 'settings-combos';
    if (collapsedSettingsSections.has(key)) {
      collapsedSettingsSections.add(other);
    } else {
      collapsedSettingsSections.delete(other);
    }
  }
  applySettingsSectionCollapseState();
}

function renderComboListInline(combos) {
  var el = document.getElementById('combo-list');
  if (!el) return;
  if (combos.length === 0) {
    el.innerHTML = emptyState(t('noCombos'));
    return;
  }
  el.innerHTML = combos.map(function(cb) {
    var modelsStr = cb.models ? cb.models.join(', ') : 'none';
    var fullModelsText = t('models') + ' ' + modelsStr;
    return '\
    <div class="card combo-card' + (cb.disabled ? ' combo-disabled' : '') + '">\
      <div class="provider-card-row">\
        <div class="provider-card-left">\
          <span class="card-title copyable" data-name="' + escapeHtml(cb.name) + '" onclick="copyToClipboard(this.dataset.name, this.dataset.name)" title="' + t('clickToCopy') + '">' + escapeHtml(cb.name) + '</span>\
        </div>\
        <div class="provider-card-actions">\
          <span class="badge provider-btn-col1 ' + (cb.disabled ? 'badge-inactive' : 'badge-active') + '">' + escapeHtml(cb.strategy) + '</span>\
          <button type="button" class="btn btn-sm provider-btn-col2" onclick="toggleComboDisabled(\'' + cb.id + '\')">' + (cb.disabled ? t('enable') : t('disable')) + '</button>\
        </div>\
      </div>\
      <div class="provider-card-row mt-12">\
        <div class="provider-card-left">\
          <span class="muted card-left-models" title="' + escapeHtml(fullModelsText) + '">' + escapeHtml(fullModelsText) + '</span>\
        </div>\
        <div class="provider-card-actions">\
          <button type="button" class="btn btn-sm provider-btn-col1" onclick="showEditCombo(\'' + cb.id + '\')">' + t('edit') + '</button>\
          <button type="button" class="btn btn-sm btn-danger provider-btn-col2" onclick="deleteCombo(\'' + cb.id + '\')">' + t('delete') + '</button>\
        </div>\
      </div>\
    </div>';
  }).join('');
}

async function toggleDebugMode(enabled) {
  try {
    await apiPatch('/settings', { debugMode: enabled });
    toast(enabled ? t('debugModeOn') : t('debugModeOff'), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
    var toggle = document.getElementById('debug-mode-toggle');
    if (toggle) toggle.checked = !enabled;
  }
}

async function toggleQuickSlotOnly(enabled) {
  try {
    await apiPatch('/settings', { quickSlotOnly: enabled });
    toast(enabled ? t('quickSlotOnlyOn') : t('quickSlotOnlyOff'), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
    var toggle = document.getElementById('quickslot-only-toggle');
    if (toggle) toggle.checked = !enabled;
  }
}

async function savePort() {
  var port = parseInt(document.getElementById('port').value);
  if (!port || port < 1 || port > 65535) {
    toast(t('invalidPort'), 'error');
    return;
  }
  var ok = await confirmModal(t('confirmRestart'));
  if (!ok) return;
  try {
    var resp = await apiPatch('/settings', { port: port });
    if (resp.error) {
      toast(resp.error, 'error', 5000);
      return;
    }
    if (resp.restart) {
      showRestarting(port);
      pollNewPort(port);
    } else {
      toast(t('portSaved'), 'success');
    }
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

function showRestarting(newPort) {
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '<div class="modal" style="text-align:center;min-width:280px">' +
    '<div style="margin:16px auto;width:28px;height:28px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite"></div>' +
    '<div class="modal-title">' + t('restarting') + '</div>' +
    '<p class="muted mt-12">' + t('restartingDesc', [newPort]) + '</p>' +
    '</div>';
  overlay.classList.add('show');
  overlay.onclick = null;
}

async function pollNewPort(newPort) {
  var newBase = 'http://127.0.0.1:' + newPort;
  var startTime = Date.now();
  var timeout = 15000;
  while (Date.now() - startTime < timeout) {
    try {
      await fetch(newBase + '/api/settings');
      window.location.href = newBase + '/';
      return;
    } catch (e) {
      await new Promise(function(r) { setTimeout(r, 500); });
    }
  }
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '<div class="modal" style="text-align:center;min-width:280px">' +
    '<div class="modal-title">' + t('restartFailed') + '</div>' +
    '<p class="muted mt-12">' + t('restartFailedDesc') + '</p>' +
    '<div class="modal-footer" style="justify-content:center;margin-top:16px"><button type="button" class="btn btn-primary" onclick="location.reload()">' + t('close') + '</button></div>' +
    '</div>';
}
async function saveRotation() {
  const rotation = {
    strategy: document.getElementById('strategy').value,
    stickyLimit: parseInt(document.getElementById('stickyLimit').value),
    maxRetries: parseInt(document.getElementById('maxRetries').value),
    retryDelaySec: parseInt(document.getElementById('retryDelaySec').value),
    backoffMaxSec: parseInt(document.getElementById('backoffMaxSec').value),
  };
  try {
    await apiPatch('/settings', { rotation });
    toast(t('rotationSaved'), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

async function saveServerTimeout() {
  const server = {
    readTimeoutSec: parseInt(document.getElementById('readTimeoutSec').value) || 300,
    writeTimeoutSec: parseInt(document.getElementById('writeTimeoutSec').value) || 300,
    idleTimeoutSec: parseInt(document.getElementById('idleTimeoutSec').value) || 120,
    upstreamTimeoutSec: parseInt(document.getElementById('upstreamTimeoutSec').value) || 300,
  };
  try {
    var resp = await apiPatch('/settings', { server });
    if (resp.restart) {
      showRestarting(resp.port);
      pollNewPort(resp.port);
    } else {
      toast(t('serverTimeoutSaved'), 'success');
    }
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

async function saveProxy() {
  const enabled = document.getElementById('proxy-toggle').checked;
  const host = document.getElementById('proxy-host').value;
  const port = document.getElementById('proxy-port').value;
  if (enabled) {
    if (!host || !host.trim()) {
      toast(t('proxyHostRequired') || 'Proxy host is required', 'error');
      return;
    }
    var portNum = parseInt(port, 10);
    if (!port || isNaN(portNum) || portNum < 1 || portNum > 65535) {
      toast(t('invalidPort'), 'error');
      return;
    }
  }
  try {
    await apiPatch('/settings', { proxy: { enabled, host, port } });
    toast(t('proxySaved'), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

async function togglePasswordProtection(enabled) {
  if (!enabled) {
    var ok = await confirmModal(t('confirmDisablePassword'));
    if (!ok) {
      var toggle = document.getElementById('password-toggle');
      if (toggle) toggle.checked = true;
      return;
    }
  }
  try {
    await apiPatch('/settings', { security: { passwordEnabled: enabled } });
    toast(enabled ? t('passwordEnabled') : t('passwordDisabled'), 'success');
    var pwSettings = document.getElementById('password-settings');
    if (pwSettings) pwSettings.style.display = enabled ? 'block' : 'none';
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
    var toggle = document.getElementById('password-toggle');
    if (toggle) toggle.checked = !enabled;
  }
}

async function savePassword() {
  var newPw = document.getElementById('new-password');
  if (!newPw || !newPw.value) {
    toast(t('enterPassword'), 'error');
    return;
  }
  try {
    await apiPatch('/settings', { security: { password: newPw.value } });
    toast(t('passwordSaved'), 'success');
    newPw.value = '';
    var settings = await apiGet('/settings');
    var curPw = document.getElementById('current-password');
    if (curPw && settings.security) curPw.value = settings.security.password || '';
    var toggle = document.getElementById('password-toggle');
    if (toggle) toggle.checked = true;
    var pwSettings = document.getElementById('password-settings');
    if (pwSettings) pwSettings.style.display = 'block';
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

// ===================== Settings Modal Functions =====================

function openSettingsModal(title, bodyHtml) {
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '\
    <div class="modal" style="min-width:400px;max-width:520px">\
      <div class="modal-title">' + escapeHtml(title) + '</div>\
      <div class="modal-body">' + bodyHtml + '</div>\
      <div class="modal-footer">\
        <button type="button" class="btn btn-ghost" onclick="closeModalOverlay()">' + t('cancel') + '</button>\
        <button type="button" class="btn btn-primary" id="settings-modal-save">' + t('save') + '</button>\
      </div>\
    </div>';
  requestAnimationFrame(function() {
    overlay.classList.add('show');
    var input = overlay.querySelector('input:not([type="hidden"]), textarea, select');
    if (input) {
      if (input.type === 'checkbox' || input.type === 'radio') {
        var textInput = overlay.querySelector('input[type="text"], input[type="number"], textarea');
        if (textInput) input = textInput;
      }
      input.focus();
      if (typeof input.select === 'function' && input.tagName === 'INPUT' && (input.type === 'text' || input.type === 'number' || input.type === '' || !input.type)) {
        input.select();
      }
    }
  });
}

function openPortModal() {
  var s = window.__settings;
  openSettingsModal(t('listenPort'),
    '<p class="muted">' + escapeHtml(t('listenPortDesc')) + '</p>\
    <div class="form-group" style="margin-top:16px">\
      <input type="number" id="settings-modal-port" value="' + s.port + '" style="max-width:160px">\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return savePortModal(); });
  };
}

function openProxyModal() {
  var s = window.__settings;
  openSettingsModal(t('proxySettings'),
    '<p class="muted">' + escapeHtml(t('proxyDesc')) + '</p>\
    <div class="settings-form-grid" style="margin-top:12px">\
      <div class="form-group"><label>' + t('proxyHost') + '</label>\
        <input type="text" id="settings-modal-proxy-host" value="' + (s.proxy ? escapeHtml(s.proxy.host) : '') + '" placeholder="127.0.0.1">\
      </div>\
      <div class="form-group"><label>' + t('proxyPort') + '</label>\
        <input type="text" id="settings-modal-proxy-port" value="' + (s.proxy ? escapeHtml(s.proxy.port) : '') + '" placeholder="2080">\
      </div>\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveProxyModal(); });
  };
}

function openRotationModal() {
  var s = window.__settings;
  openSettingsModal(t('rotationSettings'),
    '<p class="muted">' + escapeHtml(t('rotationDesc')) + '</p>\
    <div class="settings-form-grid" style="margin-top:12px">\
      <div class="form-group"><label>' + t('strategy') + '</label>\
        <select id="settings-modal-strategy">\
          <option value="fill-first"' + (s.rotation && s.rotation.strategy === 'fill-first' ? ' selected' : '') + '>' + t('fillFirst') + '</option>\
          <option value="round-robin"' + (s.rotation && s.rotation.strategy === 'round-robin' ? ' selected' : '') + '>' + t('roundRobin') + '</option>\
          <option value="failover"' + (s.rotation && s.rotation.strategy === 'failover' ? ' selected' : '') + '>' + t('failover') + '</option>\
        </select>\
      </div>\
      <div class="form-group"><label>' + t('stickyLimit') + '</label>\
        <input type="number" id="settings-modal-stickyLimit" value="' + ((s.rotation && s.rotation.stickyLimit) || 3) + '">\
      </div>\
      <div class="form-group"><label>' + t('maxRetries') + '</label>\
        <input type="number" id="settings-modal-maxRetries" value="' + ((s.rotation && s.rotation.maxRetries) || 5) + '">\
      </div>\
      <div class="form-group"><label>' + t('retryDelay') + '</label>\
        <input type="number" id="settings-modal-retryDelaySec" value="' + ((s.rotation && s.rotation.retryDelaySec) || 5) + '">\
      </div>\
      <div class="form-group"><label>' + t('backoffMax') + '</label>\
        <input type="number" id="settings-modal-backoffMaxSec" value="' + ((s.rotation && s.rotation.backoffMaxSec) || 300) + '">\
      </div>\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveRotationModal(); });
  };
}

function openServerTimeoutModal() {
  var s = window.__settings;
  openSettingsModal(t('serverTimeoutSettings'),
    '<p class="muted">' + escapeHtml(t('serverTimeoutDesc')) + '</p>\
    <div class="settings-form-grid" style="margin-top:12px">\
      <div class="form-group"><label>' + t('readTimeout') + '</label>\
        <input type="number" id="settings-modal-readTimeoutSec" value="' + ((s.server && s.server.readTimeoutSec) || 300) + '">\
      </div>\
      <div class="form-group"><label>' + t('writeTimeout') + '</label>\
        <input type="number" id="settings-modal-writeTimeoutSec" value="' + ((s.server && s.server.writeTimeoutSec) || 300) + '">\
      </div>\
      <div class="form-group"><label>' + t('idleTimeout') + '</label>\
        <input type="number" id="settings-modal-idleTimeoutSec" value="' + ((s.server && s.server.idleTimeoutSec) || 120) + '">\
      </div>\
      <div class="form-group"><label>' + t('upstreamTimeout') + '</label>\
        <input type="number" id="settings-modal-upstreamTimeoutSec" value="' + ((s.server && s.server.upstreamTimeoutSec) || 300) + '">\
      </div>\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveServerTimeoutModal(); });
  };
}

function openPasswordModal() {
  var s = window.__settings;
  var pwEnabled = s.security && s.security.passwordEnabled;
  openSettingsModal(t('passwordProtection'),
    '<p class="muted">' + escapeHtml(t('passwordProtectionDesc')) + '</p>\
    <div class="form-group" style="margin-top:12px">\
      <label>' + t('currentPassword') + '</label>\
      <div style="display:flex;gap:8px;align-items:center">\
        <input type="text" id="settings-modal-current-password" value="' + escapeHtml(s.security ? s.security.password : '') + '" readonly style="flex:1">\
        <button type="button" class="btn btn-sm" onclick="copyToClipboard(document.getElementById(\'settings-modal-current-password\').value, t(\'password\'))">' + t('copy') + '</button>\
      </div>\
    </div>\
    <div class="form-group">\
      <label>' + t('newPassword') + '</label>\
      <input type="password" id="settings-modal-new-password" placeholder="' + t('newPasswordPlaceholder') + '">\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return savePasswordModal(); });
  };
}

// ===================== Shortcut Settings Modal =====================
//
// UI flow:
//   1. openShortcutsModal() renders tab bar + per-region lists of rows.
//   2. Each row shows the action label, default keystroke (struck-through
//      when overridden), current effective keystroke, and "Rebind" plus
//      (if overridden) "Reset to default" buttons.
//   3. "Rebind" puts the row into capture mode: a one-shot keydown handler
//      records the next keystroke. Same-region conflicts block the
//      override and toast an error. Esc cancels capture.
//   4. "Reset to default" drops the override from the in-memory map and
//      re-renders the row.
//   5. "Reset all to default" clears all overrides after confirmModal.
//   6. "Save" persists Shortcuts.getAllOverrides() to config.yaml via
//      PATCH /api/settings { shortcuts: {...} }. An empty object {} is
//      sent explicitly so the backend clears any previous overrides.

function getShortcutSettingsSummary() {
  if (typeof Shortcuts === 'undefined') return '';
  var tabs = (typeof scRegionTabs === 'function') ? scRegionTabs() : Shortcuts.getAllRegions();
  var total = 0;
  for (var i = 0; i < tabs.length; i++) {
    var actions = tabs[i].actions || [];
    total += actions.length;
  }
  var overrides = Object.keys(Shortcuts.getAllOverrides() || {}).length;
  if (overrides > 0) {
    return t('shortcutSummaryCustom', [total, overrides]);
  }
  return t('shortcutSummaryDefault', [total]);
}

function updateShortcutSettingsSummary() {
  var el = document.getElementById('shortcut-settings-summary');
  if (el) {
    el.textContent = getShortcutSettingsSummary();
  }
}

function closeShortcutsModal() {
  if (window.__settings && window.__settings.shortcuts && typeof Shortcuts !== 'undefined') {
    Shortcuts.loadOverrides(window.__settings.shortcuts || {});
  }
  closeModalOverlay();
}

function scRegionTabs() {
  var regions = Shortcuts.getAllRegions();
  var hasPg = (typeof window.__hasPlayground === 'boolean') ? window.__hasPlayground : true;
  return regions.filter(function(r) {
    if (r.id === 'global') return true;
    return hasPg;
  });
}

function openShortcutsModal() {
  if (typeof Shortcuts === 'undefined') {
    toast('Shortcuts registry not loaded', 'error');
    return;
  }
  var tabs = scRegionTabs();
  var tabBtns = tabs.map(function(r, i) {
    var label = r.id === 'global' ? t('shortcutTabGlobal')
      : r.id === 'playground' ? t('shortcutTabPlayground')
      : r.id === 'gallery' ? t('shortcutTabGallery')
      : r.label;
    return '<button type="button" class="sc-tab' + (i === 0 ? ' active' : '') + '" data-sc-tab="' + r.id + '" onclick="setScTab(\'' + r.id + '\')">' + escapeHtml(label) + '</button>';
  }).join('');
  var contents = tabs.map(function(r, i) {
    return '<div class="sc-tab-content' + (i === 0 ? ' active' : '') + '" data-sc-tab-content="' + r.id + '" id="sc-tab-content-' + r.id + '"></div>';
  }).join('');
  var body =
    '<p class="muted" style="margin-bottom:10px">' + escapeHtml(t('shortcutSettingsDesc')) + '</p>' +
    '<div class="sc-tabs">' + tabBtns + '</div>' +
    '<div class="sc-hint">' + escapeHtml(t('shortcutCaptureHint')) + '</div>' +
    contents +
    '<div class="sc-reset-all-row">' +
      '<span id="sc-status" class="sc-status-line"><span></span><a onclick="resetAllSc()">' + escapeHtml(t('shortcutResetAll')) + '</a></span>' +
    '</div>';
  // Modal: save + cancel in footer; widen slightly for layout.
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML =
    '<div class="modal" style="min-width:520px;max-width:680px">' +
      '<div class="modal-title">' + escapeHtml(t('shortcutSettings')) + '</div>' +
      '<div class="modal-body">' + body + '</div>' +
      '<div class="modal-footer">' +
        '<button type="button" class="btn btn-ghost" onclick="closeShortcutsModal()">' + t('cancel') + '</button>' +
        '<button type="button" class="btn btn-primary" id="settings-modal-save">' + t('save') + '</button>' +
      '</div>' +
    '</div>';
  requestAnimationFrame(function() {
    overlay.classList.add('show');
    // Render the first tab's list now; others lazily on click.
    if (tabs.length) renderScList(tabs[0].id);
    renderScStatus();
  });
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveShortcutsModal(); });
  };
}

function setScTab(regionId) {
  var tabs = scRegionTabs();
  // Toggle active classes.
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  overlay.querySelectorAll('.sc-tab').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-sc-tab') === regionId);
  });
  overlay.querySelectorAll('.sc-tab-content').forEach(function(c) {
    c.classList.toggle('active', c.getAttribute('data-sc-tab-content') === regionId);
  });
  // Render the just-activated tab's list (lazy).
  renderScList(regionId);
}

function scRegionActions(regionId) {
  var regions = Shortcuts.getAllRegions();
  for (var i = 0; i < regions.length; i++) {
    if (regions[i].id === regionId) return regions[i].actions;
  }
  return [];
}

function renderScList(regionId) {
  var container = document.getElementById('sc-tab-content-' + regionId);
  if (!container) return;
  var actionIds = scRegionActions(regionId);
  var rows = actionIds.map(function(actionId) { return renderScRow(actionId); }).join('');
  container.innerHTML = '<div class="sc-list">' + rows + '</div>';
}

function scActionLabel(actionId) {
  var region = (function() {
    var regions = Shortcuts.getAllRegions();
    for (var i = 0; i < regions.length; i++) {
      if (regions[i].actions.indexOf(actionId) !== -1) return regions[i].id;
    }
    return null;
  })();
  if (!region) return actionId;
  // SHORTCUT_PRESETS holds label per action.
  var preset = (window.SHORTCUT_PRESETS || {})[region][actionId];
  return preset ? (preset.label || actionId) : actionId;
}

function renderScRow(actionId) {
  var def = Shortcuts.defaultBinding(actionId);
  var eff = Shortcuts.effective(actionId);
  var overridden = Shortcuts.hasOverride(actionId);
  var defStr = def ? Shortcuts.formatBinding(def) : '';
  var curStr = eff ? Shortcuts.formatBinding(eff) : '';
  var defCellHtml = overridden
    ? '<span class="sc-key-default-struck">' + escapeHtml(defStr) + '</span>'
    : '<span class="sc-key-mono">' + escapeHtml(curStr) + '</span>';
  var curCellHtml = '<span class="sc-key-mono' + (overridden ? ' sc-key-overridden' : '') + '">' + escapeHtml(curStr) + '</span>';
  var resetBtn = overridden
    ? ' <button type="button" class="sc-btn" onclick="resetScRow(\'' + escapeForJsString(actionId) + '\')">' + escapeHtml(t('shortcutResetDefault')) + '</button>'
    : '';
  return '' +
    '<div class="sc-row" data-sc-action="' + escapeHtml(actionId) + '">' +
      '<div class="sc-action-name" title="' + escapeHtml(actionId) + '">' + escapeHtml(scActionLabel(actionId)) +
        (overridden ? '<br>' + defCellHtml : '') +
      '</div>' +
      '<div class="sc-controls">' + curCellHtml + resetBtn +
        ' <button type="button" class="sc-btn sc-btn-primary" onclick="captureShortcut(\'' + escapeForJsString(actionId) + '\')">' + escapeHtml(t('shortcutRebind')) + '</button>' +
      '</div>' +
    '</div>';
}

function reRenderScRow(actionId) {
  var row = document.querySelector('.sc-row[data-sc-action="' + actionId + '"]');
  if (!row) return;
  row.outerHTML = renderScRow(actionId);
  renderScStatus();
}

function renderScStatus() {
  var statusEl = document.getElementById('sc-status');
  if (!statusEl) return;
  var ov = Shortcuts.getAllOverrides();
  var n = Object.keys(ov).length;
  var msg = n === 0
    ? escapeHtml(t('shortcutNoOverrides'))
    : escapeHtml(String(n) + ' override' + (n === 1 ? '' : 's'));
  var left = statusEl.querySelector('span');
  if (left) left.textContent = msg;
}

// Begin key capture for an action. Uses a one-shot document keydown
// listener registered on the capture phase so it sees the event before
// any other (especially app.js's global handler, which would shutdown
// on Esc etc.). The listener removes itself after one event.
var __scActiveCapture = null;

function __scCaptureHandler(e) {
  if (!__scActiveCapture) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  var cap = __scActiveCapture;
  __scActiveCapture = null;
  document.removeEventListener('keydown', __scCaptureHandler, true);
  // Cancel capture on Esc.
  if (e.key === 'Escape' || cap.cancelled) {
    reRenderScRow(cap.actionId);
    return;
  }
  var binding = {
    key: e.key,
    ctrlOrCmd: (/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')) ? !!e.metaKey : !!e.ctrlKey,
    alt: !!e.altKey,
    shift: !!e.shiftKey
  };
  // Reject bare modifier-only presses by ignoring the recognized modifier
  // keys themselves (no binding to "Shift" alone, etc.).
  var modOnly = ['Shift', 'Control', 'Alt', 'Meta', 'Ctrl'].indexOf(binding.key) !== -1;
  if (modOnly) {
    // Stay in capture mode — re-attach.
    __scActiveCapture = cap;
    document.addEventListener('keydown', __scCaptureHandler, true);
    return;
  }
  // Find same-region conflict.
  var region = (function() {
    var regions = Shortcuts.getAllRegions();
    for (var i = 0; i < regions.length; i++) {
      if (regions[i].actions.indexOf(cap.actionId) !== -1) return regions[i].id;
    }
    return null;
  })();
  if (region) {
    var conflict = Shortcuts.findConflict(region, binding, cap.actionId);
    if (conflict) {
      toast(t('shortcutConflictingAction', [scActionLabel(conflict)]), 'error', 4000);
      reRenderScRow(cap.actionId);
      return;
    }
  }
  if (!Shortcuts.setOverride(cap.actionId, binding)) {
    toast(t('shortcutConflict'), 'error');
    reRenderScRow(cap.actionId);
    return;
  }
  reRenderScRow(cap.actionId);
}

function captureShortcut(actionId) {
  var row = document.querySelector('.sc-row[data-sc-action="' + actionId + '"]');
  if (!row) return;
  // Visual: render the row in capture mode (with capturing class + hint).
  var curCell = row.querySelector('.sc-key-mono');
  if (curCell) {
    curCell.textContent = t('shortcutCapturing');
  }
  row.classList.add('sc-capturing');
  __scActiveCapture = { actionId: actionId, cancelled: false };
  document.addEventListener('keydown', __scCaptureHandler, true);
}

function resetScRow(actionId) {
  Shortcuts.clearOverride(actionId);
  reRenderScRow(actionId);
}

function resetAllSc() {
  confirmModal(t('shortcutResetAll') + '?').then(function(ok) {
    if (!ok) return;
    Shortcuts.clearAll();
    // Re-render whichever tab is active.
    var active = document.querySelector('.sc-tab.active');
    if (active) {
      renderScList(active.getAttribute('data-sc-tab'));
    }
    renderScStatus();
  });
}

async function saveShortcutsModal() {
  // Re-validate that no same-region conflicts exist after all captures.
  // (captureShortcut already guards per-press but re-check defensively.)
  var regions = Shortcuts.getAllRegions();
  for (var r = 0; r < regions.length; r++) {
    var region = regions[r];
    var seen = {};
    for (var a = 0; a < region.actions.length; a++) {
      var eff = Shortcuts.effective(region.actions[a]);
      if (!eff) continue;
      var key = eff.key + '|' + (eff.ctrlOrCmd ? '1' : '0') + (eff.alt ? '1' : '0') + (eff.shift ? '1' : '0');
      if (seen[key]) {
        toast(t('shortcutConflictingAction', [scActionLabel(seen[key])]), 'error', 5000);
        return;
      }
      seen[key] = region.actions[a];
    }
  }
  var overrides = Shortcuts.getAllOverrides();
  try {
    var resp = await apiPatch('/settings', { shortcuts: overrides });
    if (resp && resp.error) {
      toast(t('shortcutSaveFailed', [resp.error]), 'error', 5000);
      return;
    }
    // Reflect the persisted state into the cached settings.
    if (window.__settings) {
      window.__settings.shortcuts = overrides;
    }
    updateShortcutSettingsSummary();
    toast(t('shortcutSaved'), 'success');
    closeModalOverlay();
  } catch (e) {
    toast(t('shortcutSaveFailed', [String(e.message || e)]), 'error', 5000);
  }
}

// ===================== Theme Modal =====================

function openThemeModal() {
  var title = t('appearance');
  var bodyHtml = '<div id="theme-modal-picker-container" class="theme-modal-picker"></div>';
  openSettingsModal(title, bodyHtml);
  var modalEl = document.querySelector('#modal-overlay .modal');
  if (modalEl) modalEl.style.maxWidth = '620px';
  ThemeSystem.renderThemePicker('theme-modal-picker-container');
  var saveBtn = document.getElementById('settings-modal-save');
  if (saveBtn) {
    saveBtn.onclick = function() {
      closeModalOverlay();
    };
  }
}

// ===================== Modal Save Functions =====================

async function savePortModal() {
  var port = parseInt(document.getElementById('settings-modal-port').value);
  if (!port || port < 1 || port > 65535) {
    toast(t('invalidPort'), 'error');
    return;
  }
  var ok = await confirmModal(t('confirmRestart'));
  if (!ok) return;
  try {
    var resp = await apiPatch('/settings', { port: port });
    if (resp.error) {
      toast(resp.error, 'error', 5000);
      return;
    }
    closeModalOverlay();
    if (resp.restart) {
      showRestarting(port);
      pollNewPort(port);
    } else {
      toast(t('portSaved'), 'success');
    }
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

async function saveProxyModal() {
  var host = document.getElementById('settings-modal-proxy-host').value.trim();
  var port = document.getElementById('settings-modal-proxy-port').value.trim();
  var enabled = document.getElementById('proxy-toggle').checked;
  if (enabled) {
    if (!host) {
      toast(t('proxyHostRequired') || 'Proxy host is required', 'error');
      return;
    }
    var portNum = parseInt(port, 10);
    if (!port || isNaN(portNum) || portNum < 1 || portNum > 65535) {
      toast(t('invalidPort'), 'error');
      return;
    }
  }
  try {
    await apiPatch('/settings', { proxy: { enabled: enabled, host: host, port: port } });
    toast(t('proxySaved'), 'success');
    closeModalOverlay();
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

async function saveRotationModal() {
  var rotation = {
    strategy: document.getElementById('settings-modal-strategy').value,
    stickyLimit: parseInt(document.getElementById('settings-modal-stickyLimit').value),
    maxRetries: parseInt(document.getElementById('settings-modal-maxRetries').value),
    retryDelaySec: parseInt(document.getElementById('settings-modal-retryDelaySec').value),
    backoffMaxSec: parseInt(document.getElementById('settings-modal-backoffMaxSec').value),
  };
  try {
    await apiPatch('/settings', { rotation: rotation });
    toast(t('rotationSaved'), 'success');
    closeModalOverlay();
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

async function saveServerTimeoutModal() {
  var server = {
    readTimeoutSec: parseInt(document.getElementById('settings-modal-readTimeoutSec').value) || 300,
    writeTimeoutSec: parseInt(document.getElementById('settings-modal-writeTimeoutSec').value) || 300,
    idleTimeoutSec: parseInt(document.getElementById('settings-modal-idleTimeoutSec').value) || 120,
    upstreamTimeoutSec: parseInt(document.getElementById('settings-modal-upstreamTimeoutSec').value) || 300,
  };
  try {
    var resp = await apiPatch('/settings', { server: server });
    closeModalOverlay();
    if (resp.restart) {
      showRestarting(resp.port);
      pollNewPort(resp.port);
    } else {
      toast(t('serverTimeoutSaved'), 'success');
    }
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

async function savePasswordModal() {
  var enabled = document.getElementById('password-toggle').checked;
  try {
    await apiPatch('/settings', { security: { passwordEnabled: enabled } });
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
    return;
  }
  var newPw = document.getElementById('settings-modal-new-password');
  if (newPw && newPw.value) {
    try {
      await apiPatch('/settings', { security: { password: newPw.value } });
    } catch (e) {
      toast(t('failed', [e.message]), 'error');
      return;
    }
  }
  toast(enabled ? t('passwordEnabled') : t('passwordDisabled'), 'success');
  closeModalOverlay();
}

async function toggleProxy(enabled) {
  try {
    var s = window.__settings;
    var proxy = s.proxy || {};
    await apiPatch('/settings', { proxy: { enabled: enabled, host: proxy.host || '', port: proxy.port || '' } });
    s.proxy = Object.assign({}, proxy, { enabled: enabled });
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
    var toggle = document.getElementById('proxy-toggle');
    if (toggle) toggle.checked = !enabled;
  }
}

function openInfoModal(title, bodyHtml) {
  var overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = '\
    <div class="modal" style="min-width:400px;max-width:520px">\
      <div class="modal-title">' + escapeHtml(title) + '</div>\
      <div class="modal-body">' + bodyHtml + '</div>\
      <div class="modal-footer" style="justify-content:center">\
        <button type="button" class="btn btn-primary" onclick="closeModalOverlay()">' + t('close') + '</button>\
      </div>\
    </div>';
  requestAnimationFrame(function() { overlay.classList.add('show'); });
}