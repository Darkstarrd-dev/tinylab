// pg-ui-events.js — all pgOn* handlers + global shortcuts (split from pg-ui.js)
// Provides: pgOnImagePromptModel, pgApplyActiveQuickSlot, pgOnModelChange, pgOnProtocolFilter,
// pgOnParam, pgGetImageSubmitCount, pgOnImageSubmitCount, pgStepImageSubmitCount,
// pgGetImageConcurrency, pgOnImageConcurrency, pgStepImageConcurrency, pgOnImgSizeSelect,
// pgOnSystemPrompt, pgOnContextLimit, pgToggleParam, pgOnCustomToggle, pgCustomFormat,
// pgOnInputKey, pgIsEditingTarget, pgInitGlobalShortcuts
function pgOnImagePromptModel(v) { var w = pgWin(); if (!w) return; w.config.imgPromptModel = v || ''; pgSave(); pgRenderSidebar(); }
function pgApplyActiveQuickSlot(model) {
  if (!model) return;
  if (pgState.mode !== 'normal' && pgState.mode !== 'search') return;
  var w = pgWin(); if (!w) return;
  w.config.model = model;
  if (pgState.mode === 'search') {
    for (var si = 0; si < pgState.windows.length && si < 2; si++) {
      pgState.windows[si].config.model = model;
    }
  }
  pgSave();
  pgRenderSidebar();
  pgRenderPanes();
  pgUpdateInputBar();
}
function pgOnModelChange(v) {
  var w = pgWin();
  if (!w) return;
  w.config.model = v;
  // In search mode, sync model to both windows so headers stay consistent
  // and API requests (which always read from window 0) use the chosen model.
  if (pgState.mode === 'search') {
    for (var si = 0; si < pgState.windows.length && si < 2; si++) {
      pgState.windows[si].config.model = v;
    }
  }
  if (typeof qsClearActive === 'function') qsClearActive();
  pgSave(); pgRenderSidebar(); pgRenderPanes(); pgUpdateInputBar();
}

// pgOnProtocolFilter changes the protocol filter.  If the currently selected
// model no longer matches the chosen protocol, it is cleared so the user
// always has a coherent model+protocol pair.
function pgOnProtocolFilter(v) {
  var w = pgWin();
  if (!w) return;
  w.config.imgProtocolFilter = v;
  if (v === 'comfyui') {
    // ComfyUI has no entry in /api/models; '__comfyui__' is a placeholder that
    // satisfies the "a model is selected" gate while the panel shows the
    // ComfyUI connection + workflow UI instead of the model selector.
    w.config.model = '__comfyui__';
  } else if (v === 'all' || w.config.model === '__comfyui__') {
    w.config.model = '';
  } else {
    // Clear model if it doesn't match the selected protocol
    if (w.config.model) {
      var info = pgGetModelInfo(w.config.model);
      var proto = (info && info.kind === 'image') ? (info.imgProtocol || 'gpt') : '';
      if (proto !== v) {
        w.config.model = '';
      }
    }
  }
  pgSave();
  pgRenderSidebar();
  pgRenderPanes();
  pgUpdateInputBar();
}
function pgOnParam(name, v) {
  var w = pgWin();
  if (!w) return;
  w.config[name] = v;
  var valEl = document.getElementById('pg-val-' + name);
  if (valEl) valEl.textContent = typeof v === 'number' ? v.toFixed(2) : v;
  pgSave();
}
// Manual Canvas per-submission image count. Value/state seam for the
// multi-generation loop worker: read pgGetImageSubmitCount() at submission
// time (clamped int >= 1). It lives in w.config.imgSubmitCount (default 1),
// is persisted by pgSave(), is never part of the API body (distinct from
// imgN / the Batch Planning quantity which stays default 4).
function pgGetImageSubmitCount() {
  var w = pgWin();
  var raw = (w && w.config && w.config.imgSubmitCount != null) ? w.config.imgSubmitCount : 1;
  var n = parseInt(raw, 10);
  if (!isFinite(n) || n < 1) n = 1;
  if (n > 99) n = 99;
  return n;
}
function pgOnImageSubmitCount(v) {
  var w = pgWin();
  if (!w) return;
  var n = parseInt(v, 10);
  if (!isFinite(n) || n < 1) n = 1;
  if (n > 99) n = 99;
  w.config.imgSubmitCount = n;
  pgSave();
  // Keep every rendered stepper (main input bar + inspire modal) in display
  // sync — the +/- buttons only change state, they never re-render the modal.
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    var countInputs = document.querySelectorAll('input.pg-image-submit-count');
    for (var ci = 0; ci < countInputs.length; ci++) countInputs[ci].value = n;
  }
  pgRenderSidebar();
}
function pgStepImageSubmitCount(delta) {
  var cur = pgGetImageSubmitCount();
  pgOnImageSubmitCount(cur + delta);
}
function pgGetImageConcurrency() {
  var w = pgWin();
  var raw = (w && w.config && w.config.imgConcurrency != null) ? w.config.imgConcurrency : 1;
  var n = parseInt(raw, 10);
  if (!isFinite(n) || n < 1) n = 1;
  if (n > 8) n = 8;
  return n;
}
function pgOnImageConcurrency(v) {
  var w = pgWin();
  if (!w) return;
  var n = parseInt(v, 10);
  if (!isFinite(n) || n < 1) n = 1;
  if (n > 8) n = 8;
  w.config.imgConcurrency = n;
  pgSave();
  pgRenderSidebar();
}
function pgStepImageConcurrency(delta) {
  var cur = pgGetImageConcurrency();
  pgOnImageConcurrency(cur + delta);
}
// pgOnImgSizeSelect handles the size <select> in image mode. Selecting the
// '__custom' sentinel reveals the Custom Size text input below (without
// overwriting any WxH value already typed). Selecting a concrete size writes
// it into w.config.imgSize and hides the Custom Size input.
function pgOnImgSizeSelect(v) {
  var w = pgWin();
  if (!w) return;
  var row = document.querySelector('.pg-img-custom-row');
  if (v === '__custom') {
    if (row) row.style.display = '';
    // Don't clobber an existing custom WxH value the user may have typed.
    // If imgSize is currently a list entry (or ''), clear it so the custom
    // input is the source of truth once the user types into it.
    w.config.imgSize = '';
    pgSave();
    return;
  }
  if (row) row.style.display = 'none';
  pgOnParam('imgSize', v);
}
function pgOnSystemPrompt(v) { var w = pgWin(); if (w) { w.config.systemPrompt = v; pgSave(); } }
function pgOnContextLimit(v) {
  var w = pgWin();
  if (!w) return;
  var n = parseInt(v, 10) || 8000;
  if (n < 1000) n = 1000;
  w.config.contextLimit = n;
  pgSave();
}
function pgToggleParam(name) {
  var w = pgWin();
  if (!w) return;
  w.parameterEnabled[name] = !w.parameterEnabled[name];
  pgSave();
  pgRenderSidebar();
}

function pgOnCustomToggle(enabled) {
  var w = pgWin();
  if (!w) return;
  w.config.useCustomBody = enabled;
  if (enabled && (!w.config.customBody || !w.config.customBody.trim())) {
    try {
      var preview = pgBuildBody();
      w.config.customBody = JSON.stringify(preview, null, 2);
    } catch (e) { /* ignore */ }
  }
  pgSave();
  pgRenderSidebar();
}

function pgCustomFormat() {
  var w = pgWin();
  if (!w) return;
  var ta = document.getElementById('pg-custombody');
  if (!ta) return;
  try {
    var parsed = JSON.parse(ta.value);
    var formatted = JSON.stringify(parsed, null, 2);
    ta.value = formatted;
    w.config.customBody = formatted;
    pgSave();
    pgRenderSidebar();
  } catch (e) { /* ignore - format button only shown when valid */ }
}
function pgOnInputKey(e) {
  if (Shortcuts.matchEvent('pg.send-message', e) && !e.shiftKey) { e.preventDefault(); pgUserSend(); }
}

function pgIsEditingTarget(el) {
  if (!el) return false;
  var tag = el.tagName ? el.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}

function pgInitGlobalShortcuts() {
  if (window._pgGlobalShortcutsBound) return;
  window._pgGlobalShortcutsBound = true;

  document.addEventListener('keydown', function(e) {
    // 1. Alt + ~ (Backquote / ~) -> focus #pg-input
    if (e.altKey && (e.key === '`' || e.key === '~' || e.code === 'Backquote')) {
      e.preventDefault();
      var input = document.getElementById('pg-input');
      if (input) {
        input.focus();
        if (typeof input.select === 'function') {
          input.selectionStart = input.selectionEnd = input.value.length;
        }
      }
      return;
    }

    // 2. Alt + 1~4 -> switch mode (1: normal, 2: search, 3: image, 4: autochat)
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      var modes = ['normal', 'search', 'image', 'autochat'];
      var digit = null;
      if (e.code && e.code.startsWith('Digit')) {
        digit = parseInt(e.code.replace('Digit', ''), 10);
      } else if (e.key >= '1' && e.key <= '4') {
        digit = parseInt(e.key, 10);
      }
      if (digit >= 1 && digit <= 4) {
        e.preventDefault();
        pgSetMode(modes[digit - 1]);
        return;
      }
    }

    // 3. Alt + c -> clear chat
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
      e.preventDefault();
      if (typeof pgClear === 'function') pgClear();
      return;
    }

    // 4. Ctrl + 1~4 -> switch splitCount (1~4)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      var splitNum = null;
      if (e.code && e.code.startsWith('Digit')) {
        splitNum = parseInt(e.code.replace('Digit', ''), 10);
      } else if (e.key >= '1' && e.key <= '4') {
        splitNum = parseInt(e.key, 10);
      }
      if (splitNum >= 1 && splitNum <= 4) {
        e.preventDefault();
        if (typeof pgSetSplitCount === 'function') {
          pgSetSplitCount(splitNum);
        }
        return;
      }
    }

    // 5. Shift + 1~4 -> switch active window (0~3)
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      var winIdx = null;
      if (e.code && e.code.startsWith('Digit')) {
        winIdx = parseInt(e.code.replace('Digit', ''), 10) - 1;
      } else if (['!', '@', '#', '$'].indexOf(e.key) !== -1) {
        winIdx = ['!', '@', '#', '$'].indexOf(e.key);
      } else if (e.key >= '1' && e.key <= '4') {
        winIdx = parseInt(e.key, 10) - 1;
      }
      if (winIdx !== null && winIdx >= 0 && winIdx < 4) {
        if (pgIsEditingTarget(e.target)) return;
        e.preventDefault();
        if (winIdx < pgState.splitCount && typeof pgSetActiveWin === 'function') {
          pgSetActiveWin(winIdx);
        }
        return;
      }
    }
  });
}
