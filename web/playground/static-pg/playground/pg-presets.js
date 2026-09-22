// pg-presets.js — Parameters / System Prompt presets for the Playground
// sidebar (Normal + Auto Chat modes).
//
// The Parameters and System Prompt panel title rows each carry a "Preset"
// button (same entry point as the Settings page Quick Slots header). The modal
// lists the saved presets of that kind: click a row to apply it to the active
// window, ✕ to delete it (confirmed), "+ Save current" to snapshot the active
// window's current parameters / system prompt under a name.
//
// Scope: presets are browser-local (`tinylab.playground.presets.v1`), the same
// storage class as the rest of the playground config — they are user-level, so
// they are shared by every pane and survive reloads, while applying always
// targets the active window (`pgWin()`), matching how the panels themselves
// are rendered.
//
// Provides: pgPresetButton, pgPresetOpen, pgPresetClose, pgPresetList,
// pgPresetApply, pgPresetSaveCurrent, pgPresetSaveCurrentPrompt,
// pgPresetRemove, pgPresetDelete, pgPresetCapture

var PG_PRESET_KEY = 'tinylab.playground.presets.v1';

// Parameter keys owned by the Parameters panel. Kept in sync with
// pg-ui.js::pgRenderSidebar (both protocol branches) and
// pg-request.js::pgBuildBodyForWin; `stream` is included because the panel
// renders it. Model selection has its own panel and is deliberately excluded.
var PG_PRESET_PARAM_KEYS = [
  'temperature', 'topP', 'topK', 'minP', 'maxTokens',
  'frequencyPenalty', 'presencePenalty', 'seed', 'thinkingBudget',
  'reasoningEffort', 'stream',
  // Google Native branch
  'thinkingLevel', 'maxOutputTokens', 'stopSequences', 'candidateCount',
  'responseMimeType', 'responseSchema'
];

var pgPresetStore = null;  // { params: [{name, config, enabled}], system: [{name, text}] }
var pgPresetKind = '';     // kind of the open modal; '' = closed
var pgPresetFocusIdx = -1; // keyboard-highlighted row inside the open modal

function pgPresetEmptyStore() {
  return { params: [], system: [] };
}

// pgPresetLoad returns the in-memory preset store, reading localStorage once.
// Malformed entries are dropped rather than repaired.
function pgPresetLoad() {
  if (pgPresetStore) return pgPresetStore;
  var store = pgPresetEmptyStore();
  try {
    var raw = localStorage.getItem(PG_PRESET_KEY);
    if (raw) {
      var saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        ['params', 'system'].forEach(function(k) {
          if (!Array.isArray(saved[k])) return;
          store[k] = saved[k].filter(function(p) {
            return p && typeof p.name === 'string' && p.name;
          });
        });
      }
    }
  } catch (e) { /* corrupt storage */ }
  pgPresetStore = store;
  return store;
}

function pgPresetPersist() {
  try {
    localStorage.setItem(PG_PRESET_KEY, JSON.stringify(pgPresetStore || pgPresetEmptyStore()));
  } catch (e) { /* quota or unavailable */ }
}

function pgPresetList(kind) {
  return pgPresetLoad()[kind];
}

// pgPresetCapture snapshots the active window's payload for a preset kind.
function pgPresetCapture(kind) {
  var w = pgWin();
  if (!w) return null;
  if (kind === 'system') return { text: w.config.systemPrompt || '' };
  var config = {}, enabled = {};
  PG_PRESET_PARAM_KEYS.forEach(function(k) {
    if (w.config[k] !== undefined) config[k] = w.config[k];
    if (w.parameterEnabled[k] !== undefined) enabled[k] = w.parameterEnabled[k];
  });
  return { config: config, enabled: enabled };
}

// pgPresetSaveCurrent snapshots the active window under `name`, replacing an
// existing preset with the same name (last write wins, like Quick Slots).
function pgPresetSaveCurrent(kind, name) {
  name = String(name || '').trim();
  if (!name) return false;
  var payload = pgPresetCapture(kind);
  if (!payload) return false;
  var entry = { name: name };
  if (kind === 'system') {
    entry.text = payload.text;
  } else {
    entry.config = payload.config;
    entry.enabled = payload.enabled;
  }
  var list = pgPresetList(kind);
  for (var i = 0; i < list.length; i++) {
    if (list[i].name === name) {
      list[i] = entry;
      pgPresetPersist();
      return true;
    }
  }
  list.push(entry);
  pgPresetPersist();
  return true;
}

function pgPresetDelete(kind, idx) {
  var list = pgPresetList(kind);
  if (idx < 0 || idx >= list.length) return;
  list.splice(idx, 1);
  pgPresetPersist();
}

// pgPresetApply writes a saved preset into the active window, then closes the
// modal and re-renders the sidebar so every panel reflects it.
function pgPresetApply(kind, idx) {
  var preset = pgPresetList(kind)[idx];
  if (!preset) return;
  var w = pgWin();
  if (!w) return;
  if (kind === 'system') {
    w.config.systemPrompt = typeof preset.text === 'string' ? preset.text : '';
  } else {
    var config = preset.config || {}, enabled = preset.enabled || {};
    PG_PRESET_PARAM_KEYS.forEach(function(k) {
      if (config[k] !== undefined) w.config[k] = config[k];
      if (enabled[k] !== undefined) w.parameterEnabled[k] = enabled[k];
    });
  }
  pgSave();
  pgRenderSidebar();
  pgPresetClose();
  pgToast(pgT('pgPresetApplied', [preset.name]), 'success');
}

// --- Host prompt/confirm bridges -----------------------------------
// The SPA host provides promptModal/confirmModal (web/static/app-modal.js).
// Other hosts (PG_HOST) may not, so fall back to the native dialogs.
function pgPresetPrompt(title, def, placeholder) {
  if (typeof promptModal === 'function') return promptModal(title, def, placeholder);
  var v = (typeof window !== 'undefined' && typeof window.prompt === 'function')
    ? window.prompt(title, def) : null;
  return Promise.resolve(v);
}

function pgPresetConfirm(message) {
  if (typeof confirmModal === 'function') return confirmModal(message);
  var ok = (typeof window !== 'undefined' && typeof window.confirm === 'function')
    ? window.confirm(message) : false;
  return Promise.resolve(ok);
}

// pgPresetSaveCurrentPrompt closes the modal first: the host prompt renders in
// #modal-overlay (z-index 50) which sits below the playground overlay
// (.pg-modal-overlay, z-index 10000). The list reopens afterwards.
function pgPresetSaveCurrentPrompt(kind) {
  pgPresetClose();
  pgPresetPrompt(pgT('pgPresetNamePrompt'), '', pgT('pgPresetNamePlaceholder')).then(function(name) {
    if (!name) return;
    if (pgPresetSaveCurrent(kind, name)) pgToast(pgT('pgPresetSaved', [name]), 'success');
    pgPresetOpen(kind);
  });
}

function pgPresetRemove(kind, idx) {
  var preset = pgPresetList(kind)[idx];
  if (!preset) return;
  pgPresetFocusIdx = idx;
  pgPresetClose();
  pgPresetConfirm(pgT('pgPresetDeleteConfirm', [preset.name])).then(function(ok) {
    if (!ok) return;
    pgPresetDelete(kind, idx);
    pgToast(pgT('pgPresetDeleted', [preset.name]), 'success');
    pgPresetOpen(kind);
  });
}

// --- UI ------------------------------------------------------------
// pgPresetButton renders the panel-title button that opens the manager.
function pgPresetButton(kind) {
  return '<button type="button" class="pg-btn pg-preset-btn" onclick="pgPresetOpen(\'' + kind + '\')">' +
    pgEscapeHtml(pgT('pgPreset')) + '</button>';
}

// pgPresetEnabledCount counts a params preset's enabled parameters; it is the
// row's muted detail, the counterpart of the Quick Slot preset row's slot count.
function pgPresetEnabledCount(preset) {
  var enabled = (preset && preset.enabled) || {};
  var n = 0;
  PG_PRESET_PARAM_KEYS.forEach(function(k) { if (enabled[k]) n++; });
  return n;
}

// pgPresetBodyHTML builds the manager's card body. It is the Settings page
// Quick Slot preset modal's markup (.qs-modal-* classes: title row with the +
// button, bordered row list, hint footer) so both preset managers look and
// behave the same — click a row to apply, right-click to delete, no per-row
// delete button and no separate footer.
function pgPresetBodyHTML(kind) {
  var list = pgPresetList(kind);
  var titleKey = kind === 'system' ? 'pgPresetSystem' : 'pgPresetParams';
  var html = '<div class="qs-modal-title">' +
    '<span>' + pgEscapeHtml(pgT('pgPreset')) + ' — ' + pgEscapeHtml(pgT(titleKey)) + '</span>' +
    '<button type="button" class="btn btn-sm" onclick="event.stopPropagation();pgPresetSaveCurrentPrompt(\'' + kind + '\')" data-tooltip="' + pgEscapeAttr(pgT('pgPresetNamePrompt')) + '">+</button>' +
    '</div>';
  html += '<div class="qs-modal-list">';
  if (!list.length) {
    html += '<div class="qs-modal-item muted">\u2014</div>';
  } else {
    for (var i = 0; i < list.length; i++) {
      var detail = kind === 'params'
        ? ' <span class="muted" style="font-size:0.85em">(' + pgEscapeHtml(pgT('pgPresetParamCount', [pgPresetEnabledCount(list[i])])) + ')</span>'
        : '';
      html += '<div class="qs-modal-item' + (i === pgPresetFocusIdx ? ' focused' : '') + '" data-idx="' + i + '"' +
        ' onclick="pgPresetApply(\'' + kind + '\',' + i + ')"' +
        ' oncontextmenu="event.preventDefault();event.stopPropagation();pgPresetRemove(\'' + kind + '\',' + i + ')">' +
        pgEscapeHtml(list[i].name) + detail +
      '</div>';
    }
  }
  html += '</div>';
  html += '<div class="qs-modal-hint">' + pgEscapeHtml(pgT('pgPresetHint')) + '</div>';
  return html;
}

function pgPresetOpen(kind) {
  pgPresetKind = kind;
  pgPresetFocusIdx = pgPresetList(kind).length ? 0 : -1;
  pgShowModal(pgPresetBodyHTML(kind), 'qs-modal');
}

function pgPresetClose() {
  pgPresetKind = '';
  pgPresetFocusIdx = -1;
  pgCloseModal();
}

// pgPresetFocusRender moves the highlighted row, mirroring the Settings page's
// preset modal (focused row = the one keyboard actions act on).
function pgPresetFocusRender() {
  if (!pgPresetKind) return;
  var overlay = document.getElementById('pg-modal-overlay');
  if (!overlay) return;
  var items = overlay.querySelectorAll('.qs-modal-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('focused', parseInt(items[i].getAttribute('data-idx'), 10) === pgPresetFocusIdx);
  }
  var focused = overlay.querySelector('.qs-modal-item.focused');
  if (focused && focused.scrollIntoView) focused.scrollIntoView({ block: 'nearest' });
}

// Backdrop click closes the manager: it has no ✕ button, matching the Settings
// page's preset modal. Only armed while this modal owns the overlay.
document.addEventListener('mousedown', function(e) {
  if (!pgPresetKind) return;
  var overlay = document.getElementById('pg-modal-overlay');
  if (overlay && e.target === overlay) pgPresetClose();
}, true);

// Keyboard handling mirrors the Settings page's preset modal
// (↑↓/Num: move · Enter: apply · Del: remove · Esc: close). Capture phase so the
// playground's global Alt/Ctrl shortcuts cannot swallow these keys first.
document.addEventListener('keydown', function(e) {
  if (!pgPresetKind) return;
  var list = pgPresetList(pgPresetKind);
  var last = list.length - 1;
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    pgPresetClose();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!list.length) return;
    e.preventDefault(); e.stopPropagation();
    var step = e.key === 'ArrowDown' ? 1 : -1;
    pgPresetFocusIdx = pgPresetFocusIdx < 0 ? 0 : (pgPresetFocusIdx + step + list.length) % list.length;
    pgPresetFocusRender();
    return;
  }
  if (e.key === 'Enter') {
    if (pgPresetFocusIdx < 0 || pgPresetFocusIdx > last) return;
    e.preventDefault(); e.stopPropagation();
    pgPresetApply(pgPresetKind, pgPresetFocusIdx);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (pgPresetFocusIdx < 0 || pgPresetFocusIdx > last) return;
    e.preventDefault(); e.stopPropagation();
    pgPresetRemove(pgPresetKind, pgPresetFocusIdx);
  }
}, true);
