// pg-ui-events.js — all pgOn* handlers + global shortcuts (split from pg-ui.js)
// Provides: pgOnImagePromptModel, pgApplyActiveQuickSlot, pgApplyActiveQuickSlotToAll,
// pgOnModelChange, pgOnProtocolFilter,
// pgOnParam, pgGetImageSubmitCount, pgOnImageSubmitCount, pgStepImageSubmitCount,
// pgGetImageConcurrency, pgOnImageConcurrency, pgStepImageConcurrency, pgOnImgSizeSelect,
// pgOpenSystemPromptEditor, pgOnContextLimit, pgToggleParam, pgOnCustomToggle, pgCustomFormat,
// pgOnInputKey, pgIsEditingTarget, pgInitGlobalShortcuts
function pgOnImagePromptModel(v) { var w = pgWin(); if (!w) return; w.config.imgPromptModel = v || ''; pgSave(); pgRenderSidebar(); }
// pgApplyActiveQuickSlot applies the selected quickslot model to the active
// window. A quickslot is a global model preset, so this applies in every mode
// (normal/search/autochat/image alike); in image mode the image protocol is
// driven by the model itself (same semantics as pgOnModelChange).
function pgApplyActiveQuickSlot(model) {
  if (!model) return;
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
// pgApplyActiveQuickSlotToAll broadcasts a quickslot model switch to every
// window (multi-pane normal/search/autochat all follow the preset) and aborts
// any in-flight stream so an old-model request cannot leave a long-tail
// Console entry behind.
function pgApplyActiveQuickSlotToAll(model) {
  if (!model) return;
  for (var i = 0; i < pgState.windows.length; i++) {
    var w = pgState.windows[i];
    if (!w || !w.config) continue;
    if (w.streaming && w.abortCtrl) {
      try { w.abortCtrl.abort(); } catch (e) {}
      w.streaming = false;
    }
    w.config.model = model;
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
function pgOnParam(name, v, step) {
  var w = pgWin();
  if (!w) return;
  // Max Tokens has no "unset" value: the field always shows the effective
  // default (8192) while its toggle is off, so an emptied/zeroed field falls
  // back to that default instead of displaying 0.
  if (name === 'maxTokens' && !(v > 0)) v = PG_DEFAULT_CFG.maxTokens;
  w.config[name] = v;
  var valEl = document.getElementById('pg-val-' + name);
  if (valEl) valEl.textContent = pgParamValText(v, parseFloat(step));
  // Number inputs are not reformatted in place; re-render so a clamped field
  // shows the value that was actually stored.
  if (name === 'maxTokens') pgRenderSidebar();
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
// pgOpenSystemPromptEditor opens the Editor V2 differ modal for the active
// window's system prompt — the same window (and the same embed API) the Text
// Review step-3 "Prompt" button uses. The sidebar box is a read-only preview of
// the prompt and the click target; saving writes the right pane back into the
// window config and re-renders the panel, so the box always shows the prompt in
// effect. `original` is the prompt as of opening, so edits diff against it.
function pgOpenSystemPromptEditor() {
  var w = pgWin();
  if (!w) return;
  if (typeof window.EditorV2Embed === 'undefined' || !window.EditorV2Embed.openDiffModal) {
    pgToast(pgT('pgSystemPromptEditorFailed'), 'error');
    return;
  }
  var current = w.config.systemPrompt || '';
  window.EditorV2Embed.openDiffModal({
    title: pgT('pgSystemPrompt'),
    original: current,
    current: current,
    filename: 'system-prompt.txt',
    onSave: function (val) {
      // Monaco models default to CRLF: keep the stored prompt LF-only so the
      // preview box, the diff baseline and the sent body all agree.
      w.config.systemPrompt = String(val == null ? '' : val).replace(/\r\n?/g, '\n');
      pgSave();
      pgRenderSidebar();
      pgToast(pgT('pgSystemPromptSaved'), 'success');
    }
  });
}
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
  if (el.isContentEditable) return true;
  var tag = el.tagName ? el.tagName.toLowerCase() : '';
  // A read-only textarea is a preview surface (the system-prompt box opens the
  // differ editor on click), not a text target: global shortcuts still work.
  if (tag === 'textarea') return !el.readOnly;
  return tag === 'input';
}

var PG_LOCAL_SHORTCUTS = {
  focusInput: { alt: true, key: '`', code: 'Backquote', altKeys: ['~'] },
  mode1:      { alt: true, key: '1', code: 'Digit1' },
  mode2:      { alt: true, key: '2', code: 'Digit2' },
  mode3:      { alt: true, key: '3', code: 'Digit3' },
  mode4:      { alt: true, key: '4', code: 'Digit4' },
  clearChat:  { alt: true, key: 'c', code: 'KeyC' },
  split1:     { ctrlOrCmd: true, key: '1', code: 'Digit1' },
  split2:     { ctrlOrCmd: true, key: '2', code: 'Digit2' },
  split3:     { ctrlOrCmd: true, key: '3', code: 'Digit3' },
  split4:     { ctrlOrCmd: true, key: '4', code: 'Digit4' },
  win1:       { shift: true, key: '1', code: 'Digit1', altKeys: ['!'] },
  win2:       { shift: true, key: '2', code: 'Digit2', altKeys: ['@'] },
  win3:       { shift: true, key: '3', code: 'Digit3', altKeys: ['#'] },
  win4:       { shift: true, key: '4', code: 'Digit4', altKeys: ['$'] }
};

function pgInitGlobalShortcuts() {
  if (window._pgGlobalShortcutsBound) return;
  window._pgGlobalShortcutsBound = true;

  document.addEventListener('keydown', function(e) {
    // V2 embed owns its keys: never hijack Alt+digits / Ctrl+digits / Alt+C / Alt+` inside it.
    try {
      var t = e.target;
      if (t && t.closest && t.closest('.pg-max-editor-host, .ed2-embed-host, .ed2-embed-overlay, .monaco-editor')) return;
      var ae = document.activeElement;
      if (ae && ae.closest && ae.closest('.pg-max-editor-host, .ed2-embed-host, .ed2-embed-overlay')) return;
    } catch (err) { /* closest unavailable */ }
    if (Shortcuts.matchBinding(PG_LOCAL_SHORTCUTS.focusInput, e)) {
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
    var modes = ['normal', 'search', 'image', 'autochat'];
    for (var mi = 0; mi < modes.length; mi++) {
      if (Shortcuts.matchBinding(PG_LOCAL_SHORTCUTS['mode' + (mi + 1)], e)) {
        e.preventDefault();
        pgSetMode(modes[mi]);
        return;
      }
    }

    // 3. Alt + c -> clear chat
    if (Shortcuts.matchBinding(PG_LOCAL_SHORTCUTS.clearChat, e)) {
      e.preventDefault();
      if (typeof pgClear === 'function') pgClear();
      return;
    }

    // 4. Ctrl + 1~4 -> switch splitCount (1~4)
    for (var si = 1; si <= 4; si++) {
      if (Shortcuts.matchBinding(PG_LOCAL_SHORTCUTS['split' + si], e)) {
        e.preventDefault();
        if (typeof pgSetSplitCount === 'function') {
          pgSetSplitCount(si);
        }
        return;
      }
    }

    // 5. Shift + 1~4 -> switch active window (0~3)
    for (var wi = 1; wi <= 4; wi++) {
      if (Shortcuts.matchBinding(PG_LOCAL_SHORTCUTS['win' + wi], e)) {
        if (pgIsEditingTarget(e.target)) return;
        e.preventDefault();
        if (wi - 1 < pgState.splitCount && typeof pgSetActiveWin === 'function') {
          pgSetActiveWin(wi - 1);
        }
        return;
      }
    }
  });
}

if (typeof ShortcutHints !== 'undefined' && typeof ShortcutHints.register === 'function') {
  (function registerPgHints() {
    var isPgActive = function(ctx) {
      return !ctx.modal && !ctx.dropdown && !!(ctx.playground && ctx.playground.active);
    };
    var modes = ['normal', 'search', 'image', 'autochat'];
    var list = [
      {
        id: 'pg.send-message',
        actionId: 'pg.send-message',
        group: 'page',
        priority: 55,
        labelKey: 'shActPgSend',
        when: function(ctx) {
          if (!isPgActive(ctx)) return false;
          var autoRunning = typeof pgState !== 'undefined' && pgState.autoChat && pgState.autoChat.enabled && pgState.autoChat.isRunning;
          return !(ctx.playground.generating && !autoRunning);
        },
        target: '#pg-inputbar .pg-send:not(.stop)'
      },
      {
        id: 'pg.apply-edit',
        actionId: 'pg.apply-edit',
        group: 'page',
        priority: 75,
        labelKey: 'shActPgApplyEdit',
        when: function(ctx) { return isPgActive(ctx) && ctx.playground.editingMessage; },
        target: '#pg-panes .pg-editor-row .pg-btn.active'
      },
      {
        id: 'pg.cancel-edit',
        actionId: 'pg.cancel-edit',
        group: 'page',
        priority: 80,
        labelKey: 'shActPgCancelEdit',
        when: function(ctx) { return isPgActive(ctx) && ctx.playground.editingMessage; },
        target: '#pg-panes .pg-editor-row .pg-btn:first-child'
      },
      {
        id: 'pg.focus-input',
        binding: PG_LOCAL_SHORTCUTS.focusInput,
        group: 'page',
        priority: 55,
        labelKey: 'shActPgFocusInput',
        when: isPgActive,
        target: '#pg-input'
      },
      {
        id: 'pg.clear-chat',
        binding: PG_LOCAL_SHORTCUTS.clearChat,
        group: 'page',
        priority: 55,
        labelKey: 'shActPgClear',
        when: isPgActive,
        target: '#pg-inputbar .pg-btn.danger[onclick*="pgClear"]'
      },
      {
        id: 'pg.split-count',
        formatKey: function() {
          var prefix = (typeof Shortcuts !== 'undefined' && Shortcuts.formatBinding)
            ? Shortcuts.formatBinding(PG_LOCAL_SHORTCUTS.split1).replace(/1$/, '')
            : 'Ctrl+';
          return prefix + '1–4';
        },
        group: 'page',
        priority: 55,
        allowShare: true,
        labelKey: 'shActPgSplit',
        when: function(ctx) {
          return isPgActive(ctx) && !ctx.playground.batchActive && !ctx.playground.generating;
        },
        target: '#pg-split-wrap'
      }
    ];
    for (var mi = 0; mi < modes.length; mi++) {
      (function(mIdx, mName) {
        list.push({
          id: 'pg.mode-' + mName,
          binding: PG_LOCAL_SHORTCUTS['mode' + (mIdx + 1)],
          group: 'page',
          priority: 55,
          labelKey: 'shActPgMode',
          when: isPgActive,
          target: '.pg-mode-btn[data-mode="' + mName + '"]'
        });
      })(mi, modes[mi]);
    }
    for (var wi = 1; wi <= 4; wi++) {
      (function(wNum) {
        list.push({
          id: 'pg.win-' + wNum,
          binding: PG_LOCAL_SHORTCUTS['win' + wNum],
          group: 'page',
          priority: 55,
          labelKey: 'shActPgActiveWin',
          labelArgs: [wNum],
          when: function(ctx) {
            return isPgActive(ctx) && !ctx.playground.generating && wNum <= ctx.playground.splitCount;
          },
          target: '.pg-winbar-btns .pg-win-btn:nth-child(' + wNum + ')'
        });
      })(wi);
    }
    ShortcutHints.register(list);
  })();
}
