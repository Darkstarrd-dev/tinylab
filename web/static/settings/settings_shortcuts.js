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
//
// Split from endpoint.js (2026-07-31).

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
      '<div class="sc-action-name" data-tooltip="' + escapeHtml(actionId) + '">' + escapeHtml(scActionLabel(actionId)) +
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
