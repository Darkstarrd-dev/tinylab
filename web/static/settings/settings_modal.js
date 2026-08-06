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
  var val = parseInt(input.value, 10);
  if (isNaN(val)) val = 0;
  var step = delta || 1;
  var newVal = val + step;
  var min = input.hasAttribute('min') ? parseInt(input.getAttribute('min'), 10) : null;
  var max = input.hasAttribute('max') ? parseInt(input.getAttribute('max'), 10) : null;
  if (min !== null && !isNaN(min) && newVal < min) newVal = min;
  if (max !== null && !isNaN(max) && newVal > max) newVal = max;
  input.value = newVal;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function renderStepperHtml(id, value, opts) {
  opts = opts || {};
  var minAttr = opts.min !== undefined ? ' min="' + opts.min + '"' : '';
  var maxAttr = opts.max !== undefined ? ' max="' + opts.max + '"' : '';
  var step = opts.step || 1;
  var styleAttr = opts.style ? ' style="' + opts.style + '"' : '';
  return '<div class="number-stepper"' + styleAttr + '>' +
    '<button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'' + id + '\', -' + step + ')">-</button>' +
    '<input type="number" class="stepper-input" id="' + id + '" value="' + value + '"' + minAttr + maxAttr + '>' +
    '<button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'' + id + '\', ' + step + ')">+</button>' +
    '</div>';
}

function renderCustomSelectHtml(wrapperId, selectId, options, selectedValue) {
  var selectedText = selectedValue;
  var optionsHtml = options.map(function(opt) {
    var val = typeof opt === 'object' ? opt.value : opt;
    var label = typeof opt === 'object' ? opt.label : opt;
    var isSel = String(val) === String(selectedValue);
    if (isSel) selectedText = label;
    return '<div class="custom-select-option' + (isSel ? ' selected' : '') + '" data-value="' + escapeAttr(val) + '" onclick="selectCustomOption(\'' + wrapperId + '\', \'' + escapeForJsString(val) + '\', \'' + escapeForJsString(label) + '\')">' +
      '<span class="custom-select-option-link">' + escapeHtml(label) + '</span>' +
      '</div>';
  }).join('');

  var selectOptionsHtml = options.map(function(opt) {
    var val = typeof opt === 'object' ? opt.value : opt;
    var label = typeof opt === 'object' ? opt.label : opt;
    var isSel = String(val) === String(selectedValue);
    return '<option value="' + escapeAttr(val) + '"' + (isSel ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }).join('');

  return '<div class="custom-select-wrapper" id="' + wrapperId + '" style="width:100%;">' +
    '<div class="custom-select-trigger" onclick="toggleCustomSelect(\'' + wrapperId + '\', event)">' +
      '<span class="custom-select-label">' + escapeHtml(selectedText) + '</span>' +
      '<svg viewBox="0 0 512 512"><path d="M233.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 338.7 77.7 160.3c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z"/></svg>' +
    '</div>' +
    '<div class="custom-select-menu">' +
      optionsHtml +
    '</div>' +
    '<select id="' + selectId + '" style="display:none;">' +
      selectOptionsHtml +
    '</select>' +
  '</div>';
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
  openPathSettingsModal({ title: t('pathSettings'), sections: { defaultDir: true, imageDir: true, logDir: true, ytDlpPath: true, ffmpegPath: true } });
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
          <button type="button" class="segmented-btn' + (currLang === 'en' ? ' active' : '') + '" onclick="setLang(\'en\'); renderLangAndFontSizePicker(\'lang-font-modal-container\');">English</button>\
          <button type="button" class="segmented-btn' + (currLang === 'cn' ? ' active' : '') + '" onclick="setLang(\'cn\'); renderLangAndFontSizePicker(\'lang-font-modal-container\');">中文</button>\
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
  var newPw = document.getElementById('settings-modal-new-password');
  if (!newPw || !newPw.value) {
    toast(t('enterPassword'), 'error');
    return;
  }
  try {
    await apiPatch('/settings', { security: { password: newPw.value } });
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
