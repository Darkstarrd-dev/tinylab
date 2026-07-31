// ===================== Settings Page (entry) =====================
// Renders the whole Settings page: left sidebar rows + right panel
// (providers / combos / quickslots sections). Also owns the row-toggle
// save handlers and the settings-section collapse state.
//
// Split modules:
//   settings_modal.js     — all open*/save* settings modals + port restart flow
//   settings_shortcuts.js — keyboard shortcut manager UI
//   settings_trace.js     — request-tracing config + clear flow

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
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('listenPortDesc')) + '">' + t('listenPort') + '</span>\
          <span class="code copyable settings-row-endpoint" onclick="copyToClipboard(this.dataset.url, this.dataset.url)" data-url="http://localhost:' + s.port + '/v1" data-tooltip="' + escapeHtml(t('clickToCopy')) + '">' + s.port + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openPortModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('proxyDesc')) + '">' + t('proxySettings') + '</span>\
          <label class="toggle-switch settings-row-toggle" data-tooltip="' + escapeHtml(t('proxyDesc')) + '"><input type="checkbox" id="proxy-toggle"' + (s.proxy && s.proxy.enabled ? ' checked' : '') + ' onchange="toggleProxy(this.checked)"><span class="toggle-slider"></span></label>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openProxyModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('rotationDesc')) + '">' + t('rotationSettings') + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openRotationModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('serverTimeoutDesc')) + '">' + t('serverTimeoutSettings') + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openServerTimeoutModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('passwordProtectionDesc')) + '">' + t('passwordProtection') + '</span>\
          <label class="toggle-switch settings-row-toggle" data-tooltip="' + escapeHtml(t('passwordProtectionDesc')) + '"><input type="checkbox" id="password-toggle"' + (s.security && s.security.passwordEnabled ? ' checked' : '') + ' onchange="togglePasswordProtection(this.checked)"><span class="toggle-slider"></span></label>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openPasswordModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('shortcutSettingsDesc')) + '">' + t('shortcutSettings') + '</span>\
          <span class="code settings-row-endpoint" id="shortcut-settings-summary" data-tooltip="' + escapeHtml(t('shortcutSettingsDesc')) + '">' + escapeHtml(getShortcutSettingsSummary()) + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openShortcutsModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('appearanceDesc')) + '">' + t('appearance') + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openThemeModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('debugModeDesc')) + '">' + t('debugMode') + '</span>\
          <label class="toggle-switch settings-row-toggle" data-tooltip="' + escapeHtml(t('debugModeDesc')) + '"><input type="checkbox" id="debug-mode-toggle"' + (s.debugMode ? ' checked' : '') + ' onchange="toggleDebugMode(this.checked)"><span class="toggle-slider"></span></label>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('requestTracingDesc')) + '">' + t('requestTracing') + '</span>\
          <label class="toggle-switch settings-row-toggle" data-tooltip="' + escapeHtml(t('requestTracingDesc')) + '"><input type="checkbox" id="trace-toggle"' + (s.trace && s.trace.enabled ? ' checked' : '') + ' onchange="toggleTrace(this.checked)"><span class="toggle-slider"></span></label>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openTraceModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('pathSettingsDesc')) + '">' + t('pathSettings') + '</span>\
          <button type="button" class="btn btn-sm settings-row-btn" onclick="openPathModal()">' + t('settings') + '</button>\
        </div>\
        <div class="settings-row">\
          <span class="settings-row-title" data-tooltip="' + escapeHtml(t('quickSlotOnlyDesc')) + '">' + t('quickSlotOnly') + '</span>\
          <label class="toggle-switch settings-row-toggle" data-tooltip="' + escapeHtml(t('quickSlotOnlyDesc')) + '"><input type="checkbox" id="quickslot-only-toggle"' + (s.quickSlotOnly ? ' checked' : '') + ' onchange="toggleQuickSlotOnly(this.checked)"><span class="toggle-slider"></span></label>\
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
          <span class="card-title copyable" data-name="' + escapeHtml(cb.name) + '" onclick="copyToClipboard(this.dataset.name, this.dataset.name)" data-tooltip="' + t('clickToCopy') + '">' + escapeHtml(cb.name) + '</span>\
        </div>\
        <div class="provider-card-actions">\
          <span class="badge provider-btn-col1 ' + (cb.disabled ? 'badge-inactive' : 'badge-active') + '">' + escapeHtml(cb.strategy) + '</span>\
          <button type="button" class="btn btn-sm provider-btn-col2" onclick="toggleComboDisabled(\'' + cb.id + '\')">' + (cb.disabled ? t('enable') : t('disable')) + '</button>\
        </div>\
      </div>\
      <div class="provider-card-row mt-12">\
        <div class="provider-card-left">\
          <span class="muted card-left-models" data-tooltip="' + escapeHtml(fullModelsText) + '">' + escapeHtml(fullModelsText) + '</span>\
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

async function togglePasswordProtection(enabled) {
  if (enabled) {
    // Enabling requires setting a password — open the modal.
    // Revert toggle; savePasswordModal checks it on success.
    var toggle = document.getElementById('password-toggle');
    if (toggle) toggle.checked = false;
    openPasswordModal();
    return;
  }
  // Disabling: confirm first.
  var ok = await confirmModal(t('confirmDisablePassword'));
  if (!ok) {
    var toggle = document.getElementById('password-toggle');
    if (toggle) toggle.checked = true;
    return;
  }
  try {
    await apiPatch('/settings', { security: { passwordEnabled: false } });
    toast(t('passwordDisabled'), 'success');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
    var toggle = document.getElementById('password-toggle');
    if (toggle) toggle.checked = true;
  }
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
