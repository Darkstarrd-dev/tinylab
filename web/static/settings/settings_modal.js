// ===================== Settings Modal Functions =====================
// All open*/save* settings modals (port / proxy / rotation / timeouts /
// password / path / appearance) plus the shared modal shells and the
// port-change restart polling flow. Split from endpoint.js (2026-07-31).

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

function changeStepper(inputId, delta) {
  var input = document.getElementById(inputId);
  if (!input) return;
  var min = input.hasAttribute('min') ? parseInt(input.getAttribute('min'), 10) : null;
  var max = input.hasAttribute('max') ? parseInt(input.getAttribute('max'), 10) : null;
  var hasVal = input.value !== '' && input.value !== null && !isNaN(parseInt(input.value, 10));
  var step = delta || 1;
  var val = hasVal ? parseInt(input.value, 10) : (step > 0 && min !== null && min > 0 ? min - step : 0);
  var newVal = val + step;
  if (input.hasAttribute('placeholder') && min !== null && newVal < min) {
    input.value = '';
  } else {
    if (min !== null && !isNaN(min) && newVal < min) newVal = min;
    if (max !== null && !isNaN(max) && newVal > max) newVal = max;
    input.value = newVal;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function openPortModal() {
  var s = window.__settings;
  openSettingsModal(t('listenPort'),
    '<p class="muted">' + escapeHtml(t('listenPortDesc')) + '</p>\
    <div class="form-group" style="margin-top:16px">\
      <label>' + escapeHtml(t('listenPort')) + '</label>\
      ' + renderStepperHtml('settings-modal-port', s.port, { min: 1, max: 65535, style: 'max-width:200px' }) + '\
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
    <div class="settings-form-grid" style="margin-top:16px">\
      <div class="form-group"><label>' + t('proxyHost') + '</label>\
        <input type="text" class="input" id="settings-modal-proxy-host" value="' + (s.proxy ? escapeHtml(s.proxy.host) : '') + '" placeholder="127.0.0.1">\
      </div>\
      <div class="form-group"><label>' + t('proxyPort') + '</label>\
        <input type="text" class="input" id="settings-modal-proxy-port" value="' + (s.proxy ? escapeHtml(s.proxy.port) : '') + '" placeholder="2080">\
      </div>\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveProxyModal(); });
  };
}

function openPathModal() {
  openPathSettingsModal({ title: t('pathSettings'), sections: { defaultDir: true, docDir: true, imageDir: true, logDir: true, gamesDir: true, ytDlpPath: true, ffmpegPath: true } });
}

function openAssistantModal() {
  var s = window.__settings;
  var a = (s && s.assistant) || {};
  // Draft action list for the editor (plain objects, safe to mutate freely).
  window.__assistantActions = (a.actions || []).map(function(x) {
    return {
      name: x.name || '',
      spritesheetPath: x.spritesheetPath || '',
      cols: x.cols || 1,
      rows: x.rows || 1,
      frameStart: x.frameStart || 0,
      frameEnd: (x.frameEnd !== undefined ? x.frameEnd : 0),
      fps: x.fps || 8,
      mirror: !!x.mirror
    };
  });
  // Presets draft: persisted bundles (AssistantPreset[]).
  window.__assistantPresets = (a.presets || []).map(function(p) {
    return {
      name: p.name || '',
      actions: (p.actions || []).map(function(x) {
        return {
          name: x.name || '',
          spritesheetPath: x.spritesheetPath || '',
          cols: x.cols || 1,
          rows: x.rows || 1,
          frameStart: x.frameStart || 0,
          frameEnd: (x.frameEnd !== undefined ? x.frameEnd : 0),
          fps: x.fps || 8,
          mirror: !!x.mirror
        };
      })
    };
  });
  openSettingsModal(t('assistantSettings'),
    '<p class="muted">' + escapeHtml(t('assistantSettingsDesc')) + '</p>\
    <div class="form-group" style="margin-top:16px"><label>' + escapeHtml(t('assistantModel')) + '</label>\
      <button type="button" class="input" id="settings-assistant-model-btn" onclick="assistantModelBtnClick()" style="width:100%;text-align:left;cursor:pointer;display:flex;justify-content:space-between;align-items:center">' +
      escapeHtml(a.model || t('assistantKeywordFallback')) + ' <span style="opacity:0.5">▼</span></button>\
      <input type="hidden" id="settings-modal-assistant-model" value="' + escapeHtml(a.model || '') + '">\
      <p class="muted" style="margin-top:4px;font-size:12px">' + escapeHtml(t('assistantModelDesc')) + '</p>\
    </div>\
    <div class="form-group" style="margin-top:12px"><label>' + escapeHtml(t('assistantDebug')) + '</label>      <label class="toggle-switch" data-tooltip="' + escapeHtml(t('assistantDebugDesc')) + '"><input type="checkbox" id="settings-assistant-debug"' + (a.debug ? ' checked' : '') + '><span class="toggle-slider"></span></label>      <p class="muted" style="margin-top:4px;font-size:12px">' + escapeHtml(t('assistantDebugDesc')) + '</p>    </div>\
    <div class="form-group" style="margin-top:12px"><label>' + escapeHtml(t('assistantPreset') || 'Assistant Preset') + '</label>\
      <div id="assistant-preset-bar"></div>\
    </div>\
    <div class="form-group" style="margin-top:12px"><label>' + escapeHtml(t('assistantActions')) + '</label>\
      <div id="settings-assistant-actions"></div>\
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">\
        <button type="button" class="btn btn-ghost" style="padding:3px 10px;font-size:12px" data-tooltip="' + escapeHtml(t('assistantPresetDesc')) + '" onclick="assistantAddPreset(\'move\')">' + escapeHtml(t('assistantPresetMove') || 'Move preset') + '</button>\
        <button type="button" class="btn btn-ghost" style="padding:3px 10px;font-size:12px" data-tooltip="' + escapeHtml(t('assistantPresetDesc')) + '" onclick="assistantAddPreset(\'pet\')">' + escapeHtml(t('assistantPresetPet')) + '</button>\
        <button type="button" class="btn btn-ghost" style="padding:3px 10px;font-size:12px" data-tooltip="' + escapeHtml(t('assistantPresetDesc')) + '" onclick="assistantAddPreset(\'platformer\')">' + escapeHtml(t('assistantPresetPlatformer')) + '</button>\
        <button type="button" class="btn btn-ghost" style="padding:3px 10px;font-size:12px" data-tooltip="' + escapeHtml(t('assistantPresetDesc')) + '" onclick="assistantAddPreset(\'topdown\')">' + escapeHtml(t('assistantPresetTopdown')) + '</button>\
      </div>\
      <p class="muted" style="margin-top:4px;font-size:12px">' + escapeHtml(t('assistantActionListHint')) + '</p>\
    </div>\
    <div class="form-group" id="assistant-state-matrix-group" style="margin-top:14px"><label>' + escapeHtml(t('assistantStateMatrix')) + '</label>\
      <p class="muted" style="margin:4px 0 8px;font-size:12px">' + escapeHtml(t('assistantStateMatrixDesc')) + '</p>\
      <div id="assistant-state-matrix" style="border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:8px;background:var(--bg)"></div>\
    </div>'
  );
  try { if (typeof renderAssistantPresetBar === 'function') renderAssistantPresetBar(); } catch(ePB) {}
  renderAssistantActions();
  // Render the preset-state → action mapping + live pet readout.
  try { if (typeof renderAssistantStateMatrix === 'function') renderAssistantStateMatrix(); } catch(eSM2) {}
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveAssistantModal(); });
  };
}

function openRotationModal() {
  var s = window.__settings;
  var rot = s.rotation || {};
  var strategyOptions = [
    { value: 'fill-first', label: t('fillFirst') },
    { value: 'round-robin', label: t('roundRobin') },
    { value: 'failover', label: t('failover') }
  ];
  openSettingsModal(t('rotationSettings'),
    '<p class="muted">' + escapeHtml(t('rotationDesc')) + '</p>\
    <div class="settings-form-grid" style="margin-top:16px">\
      <div class="form-group form-group-full"><label>' + t('strategy') + '</label>\
        ' + renderCustomSelectHtml('settings-rotation-strategy-wrap', 'settings-modal-strategy', strategyOptions, rot.strategy || 'fill-first') + '\
      </div>\
      <div class="form-group"><label>' + t('stickyLimit') + '</label>\
        ' + renderStepperHtml('settings-modal-stickyLimit', rot.stickyLimit || 3, { min: 1 }) + '\
      </div>\
      <div class="form-group"><label>' + t('maxRetries') + '</label>\
        ' + renderStepperHtml('settings-modal-maxRetries', rot.maxRetries || 5, { min: 1 }) + '\
      </div>\
      <div class="form-group"><label>' + t('retryDelay') + '</label>\
        ' + renderStepperHtml('settings-modal-retryDelaySec', rot.retryDelaySec || 5, { min: 1 }) + '\
      </div>\
      <div class="form-group"><label>' + t('backoffMax') + '</label>\
        ' + renderStepperHtml('settings-modal-backoffMaxSec', rot.backoffMaxSec || 300, { min: 1 }) + '\
      </div>\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveRotationModal(); });
  };
}

function openServerTimeoutModal() {
  var s = window.__settings;
  var server = s.server || {};
  openSettingsModal(t('serverTimeoutSettings'),
    '<p class="muted">' + escapeHtml(t('serverTimeoutDesc')) + '</p>\
    <div class="settings-form-grid" style="margin-top:16px">\
      <div class="form-group"><label>' + t('readTimeout') + '</label>\
        ' + renderStepperHtml('settings-modal-readTimeoutSec', server.readTimeoutSec || 300, { min: 1 }) + '\
      </div>\
      <div class="form-group"><label>' + t('writeTimeout') + '</label>\
        ' + renderStepperHtml('settings-modal-writeTimeoutSec', server.writeTimeoutSec || 300, { min: 1 }) + '\
      </div>\
      <div class="form-group"><label>' + t('idleTimeout') + '</label>\
        ' + renderStepperHtml('settings-modal-idleTimeoutSec', server.idleTimeoutSec || 120, { min: 1 }) + '\
      </div>\
      <div class="form-group"><label>' + t('upstreamTimeout') + '</label>\
        ' + renderStepperHtml('settings-modal-upstreamTimeoutSec', server.upstreamTimeoutSec || 300, { min: 1 }) + '\
      </div>\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return saveServerTimeoutModal(); });
  };
}

function openPasswordModal() {
  var s = window.__settings;
  var hasPassword = s.security && s.security.hasPassword;
  var hint = hasPassword ? '<p class="muted">' + escapeHtml(t('passwordChangeHint')) + '</p>' : '<p class="muted">' + escapeHtml(t('passwordProtectionDesc')) + '</p>';
  openSettingsModal(t('passwordProtection'),
    hint + '\
    <div class="form-group" style="margin-top:16px">\
      <label>' + t('newPassword') + '</label>\
      <input type="password" class="input" id="settings-modal-new-password" placeholder="' + t('newPasswordPlaceholder') + '" autofocus>\
    </div>'
  );
  document.getElementById('settings-modal-save').onclick = function() {
    withLoading(this, function() { return savePasswordModal(); });
  };
}

// ===================== Theme Modal =====================

function openThemeModal() {
  var title = t('appearance');
  var bodyHtml = '<div id="theme-modal-picker-container" class="theme-modal-picker"></div>'
    + '<div class="style-modal-section"><div class="style-modal-title">' + t('themeStyle') + '</div>'
    + '<div id="style-modal-picker-container"></div></div>'
    + '<div class="style-modal-section"><div class="style-modal-title">' + t('langAndFontSize') + '</div>'
    + '<div id="lang-font-modal-container"></div></div>';
  openSettingsModal(title, bodyHtml);
  var modalEl = document.querySelector('#modal-overlay .modal');
  if (modalEl) {
    modalEl.style.maxWidth = '760px';
    modalEl.classList.add('modal-theme-dialog');
  }
  ThemeSystem.renderThemePicker('theme-modal-picker-container');
  ThemeSystem.renderStylePicker('style-modal-picker-container');
  renderLangAndFontSizePicker('lang-font-modal-container');
  var saveBtn = document.getElementById('settings-modal-save');
  if (saveBtn) {
    saveBtn.onclick = function() {
      closeModalOverlay();
    };
  }
  requestAnimationFrame(function() {
    setTimeout(function() {
      var initialFocus = document.querySelector('#theme-modal-picker-container [data-group="dark"] .theme-card.active')
        || document.querySelector('#theme-modal-picker-container [data-group="dark"] .theme-card.selected')
        || document.querySelector('#theme-modal-picker-container [data-group="dark"] .theme-card');
      if (initialFocus) {
        initialFocus.focus();
      }
    }, 60);
  });
}

function renderLangAndFontSizePicker(containerId) {
  var container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
  if (!container) return;
  var currLang = typeof currentLang === 'function' ? currentLang() : 'en';
  var currFont = document.documentElement.getAttribute('data-font-size') || 's';

  container.innerHTML = '\
    <div class="lang-font-row">\
      <div class="lang-font-group">\
        <span class="lang-font-label">' + t('language') + '</span>\
        <div class="segmented-control">\
          <button type="button" class="segmented-btn' + (currLang === 'en' ? ' active' : '') + '" onclick="setLang(\'en\');">English</button>\
          <button type="button" class="segmented-btn' + (currLang === 'cn' ? ' active' : '') + '" onclick="setLang(\'cn\');">中文</button>\
        </div>\
      </div>\
      <div class="lang-font-group">\
        <span class="lang-font-label">' + t('fontSize') + '</span>\
        <div class="segmented-control">\
          <button type="button" class="segmented-btn' + (currFont === 's' ? ' active' : '') + '" onclick="setFontSize(\'s\'); renderLangAndFontSizePicker(\'lang-font-modal-container\');">' + t('fontSmall') + '</button>\
          <button type="button" class="segmented-btn' + (currFont === 'm' ? ' active' : '') + '" onclick="setFontSize(\'m\'); renderLangAndFontSizePicker(\'lang-font-modal-container\');">' + t('fontMedium') + '</button>\
          <button type="button" class="segmented-btn' + (currFont === 'l' ? ' active' : '') + '" onclick="setFontSize(\'l\'); renderLangAndFontSizePicker(\'lang-font-modal-container\');">' + t('fontLarge') + '</button>\
        </div>\
      </div>\
    </div>';
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
    if (window.__settings) {
      window.__settings.proxy = { enabled: enabled, host: host, port: port };
    }
    toast(t('proxySaved'), 'success');
    closeModalOverlay();
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

async function saveAssistantModal() {
  var modelEl = document.getElementById('settings-modal-assistant-model');
  var model = ((modelEl && modelEl.value) || '').trim();
  var actions = (window.__assistantActions || []).map(function(a) {
    return {
      name: a.name || '',
      spritesheetPath: a.spritesheetPath || '',
      cols: Math.max(1, parseInt(a.cols, 10) || 1),
      rows: Math.max(1, parseInt(a.rows, 10) || 1),
      frameStart: Math.max(0, parseInt(a.frameStart, 10) || 0),
      frameEnd: Math.max(0, parseInt(a.frameEnd, 10) || 0),
      fps: Math.max(1, parseInt(a.fps, 10) || 8),
      mirror: !!a.mirror
    };
  });
  var presets = (window.__assistantPresets || []).map(function(p) {
    return {
      name: (p.name || '').trim(),
      actions: (p.actions || []).map(function(a) {
        return {
          name: a.name || '',
          spritesheetPath: a.spritesheetPath || '',
          cols: Math.max(1, parseInt(a.cols, 10) || 1),
          rows: Math.max(1, parseInt(a.rows, 10) || 1),
          frameStart: Math.max(0, parseInt(a.frameStart, 10) || 0),
          frameEnd: Math.max(0, parseInt(a.frameEnd, 10) || 0),
          fps: Math.max(1, parseInt(a.fps, 10) || 8),
          mirror: !!a.mirror
        };
      })
    };
  }).filter(function(p) { return !!p.name; });
  var dbgEl = document.getElementById('settings-assistant-debug');
  var debug = !!(dbgEl && dbgEl.checked);
  try {
    await apiPatch('/settings', { assistant: { model: model, actions: actions, presets: presets, debug: debug } });
    if (window.__settings) {
      window.__settings.assistant = Object.assign({}, window.__settings.assistant, { model: model, actions: actions, presets: presets, debug: debug });
    }
    window.__assistantActions = null;
    window.__assistantPresets = null;
    window.__assistantPresetSel = '';
    toast(t('assistantSaved'), 'success');
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
    if (window.__settings) {
      window.__settings.rotation = Object.assign({}, window.__settings.rotation || {}, rotation);
    }
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
    if (window.__settings) {
      window.__settings.server = Object.assign({}, window.__settings.server || {}, server);
    }
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
  var newPw = document.getElementById('settings-modal-new-password');
  if (!newPw || !newPw.value) {
    toast(t('enterPassword'), 'error');
    return;
  }
  try {
    var result = await apiPatch('/settings', { security: { password: newPw.value } });
    if (result && result.csrfToken) window.__setCsrfToken(result.csrfToken);
    toast(t('passwordSaved'), 'success');
    closeModalOverlay();
    // Update page toggle to reflect enabled state.
    var toggle = document.getElementById('password-toggle');
    if (toggle) toggle.checked = true;
    // Refresh settings cache so hasPassword is updated.
    window.__settings = await apiGet('/settings');
  } catch (e) {
    toast(t('failed', [e.message]), 'error');
  }
}

// ===================== Port-change restart flow =====================

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
