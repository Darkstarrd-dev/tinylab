// pg-ui.js
// ----- Module 8/9: Edit / Regenerate --------------------------------
function pgBeginEdit(i, idx) {
  var w = pgWinAt(i);
  var msg = w.messages[idx];
  if (!msg) return;
  var wrap = document.getElementById('pg-bubble-' + i + '-' + idx);
  if (!wrap) return;
  var txt = pgTextContent(msg.content);
  wrap.innerHTML =
    '<div class="pg-editor-title"><span>' + pgEscapeHtml(pgT('pgEdit')) +
      '<span class="' + (txt !== pgTextContent(msg.content) ? 'unsaved' : 'saved') + '"></span></span></div>' +
    '<textarea class="pg-editor" id="pg-edit-ta-' + i + '-' + idx + '">' + pgEscapeHtml(txt) + '</textarea>' +
    '<div class="pg-editor-row">' +
      '<button class="pg-btn" onclick="pgCancelEdit(' + i + ',' + idx + ')">' + pgEscapeHtml(pgT('cancel')) + '</button>' +
      '<button class="pg-btn" onclick="pgApplyEdit(' + i + ',' + idx + ',false)">' + pgEscapeHtml(pgT('pgSave')) + '</button>' +
      '<button class="pg-btn active" onclick="pgApplyEdit(' + i + ',' + idx + ',true)">' + pgEscapeHtml(pgT('pgSendMessage')) + '</button>' +
    '</div>';
  var ta = document.getElementById('pg-edit-ta-' + i + '-' + idx);
  if (ta) {
    ta.focus();
    ta.addEventListener('keydown', function(e) {
      if (Shortcuts.matchEvent('pg.cancel-edit', e)) { e.preventDefault(); e.stopPropagation(); pgCancelEdit(i, idx); }
      if (Shortcuts.matchEvent('pg.apply-edit', e)) {
        e.preventDefault();
        pgApplyEdit(i, idx, true);
      }
    });
  }
}

function pgCancelEdit(i, idx) {
  pgRenderBubble(i, idx);
}

function pgApplyEdit(i, idx, submit) {
  var w = pgWinAt(i);
  var ta = document.getElementById('pg-edit-ta-' + i + '-' + idx);
  if (!ta) return;
  var msg = w.messages[idx];
  if (!msg) return;
  if (typeof msg.content === 'string') {
    msg.content = ta.value;
  } else {
    var replaced = false;
    msg.content = (msg.content || []).map(function(p) {
      if (p.type === 'text') { replaced = true; return { type: 'text', text: ta.value }; }
      return p;
    });
    if (!replaced) msg.content.unshift({ type: 'text', text: ta.value });
  }
  if (submit) {
    if (pgIsGenerating()) { pgToast(pgT('pgStreaming'), 'warning'); return; }
    w.messages = w.messages.slice(0, idx + 1);
    w.messages.push({ role: 'assistant', content: '', reasoning: '', status: 'loading', startedAt: Date.now() });
    if (i === 0) pgSave();
    pgRenderMessages(i);
    pgSend(i, w.messages.length - 1);
  } else {
    pgRenderBubble(i, idx);
    if (i === 0) pgSave();
  }
}

function pgRegenerate(i, idx) {
  if (pgIsGenerating()) return;
  var w = pgWinAt(i);
  w.messages = w.messages.slice(0, idx);
  w.messages.push({ role: 'assistant', content: '', reasoning: '', status: 'loading', startedAt: Date.now() });
  if (i === 0) pgSave();
  pgRenderMessages(i);
  pgSend(i, w.messages.length - 1);
}

function pgDeleteMessage(i, idx) {
  var w = pgWinAt(i);
  w.messages.splice(idx, 1);
  if (i === 0) pgSave();
  pgRenderMessages(i);
}

function pgToggleRole(i, idx) {
  if (pgIsGenerating()) return;
  var w = pgWinAt(i);
  var msg = w.messages[idx];
  if (!msg) return;
  var order = { user: 'assistant', assistant: 'system', system: 'user' };
  msg.role = order[msg.role] || 'user';
  if (i === 0) pgSave();
  pgRenderMessages(i);
}

function pgPrevUserBefore(i, idx) {
  var w = pgWinAt(i);
  for (var j = idx - 1; j >= 0; j--) {
    if (w.messages[j].role === 'user') return j;
  }
  return -1;
}

function pgRetryError(i, idx) {
  if (pgIsGenerating()) return;
  pgRegenerate(i, idx);
}

function pgEditPromptForError(i, idx) {
  if (pgIsGenerating()) return;
  var prevUser = pgPrevUserBefore(i, idx);
  if (prevUser < 0) { pgToast(pgT('pgNoPrevUser'), 'warning'); return; }
  pgBeginEdit(i, prevUser);
}

// ----- Module: New message send (broadcast) -------------------------
function pgUserSend() {
  if (pgState.inputMaximized) {
    pgState.inputMaximized = false;
    pgSyncInputMaximizedState();
  }
  var ta = document.getElementById('pg-input');
  if (!ta) return;
  var text = ta.value.trim();
  if (!text) return;

  if (pgState.autoChat.enabled) {
    ta.value = '';
    if (pgState.autoChat.isRunning) pgAutoChatUserSend(text); else pgAutoChatStart(text);
    return;
  }

  if (pgState.mode === 'image') {
    var activeImageWin = pgWin();
    var imageProtocol = activeImageWin && typeof pgEffectiveProtocol === 'function' ? pgEffectiveProtocol(activeImageWin.config) : null;
    if (!activeImageWin) return;
    if (imageProtocol !== 'comfyui' && !activeImageWin.config.model) { pgToast(pgT('pgSelectModel'), 'warning'); return; }
    activeImageWin.image.draftPrompt = text;
    pgImageGenerate(pgState.activeWin, text, { promptFormat: 'natural' }).then(function () {
      ta.value = '';
      activeImageWin.image.draftPrompt = '';
      pgRenderInputBar();
    }).catch(function () {});
    pgRenderInputBar();
    return;
  }

  // Search mode
  if (pgState.mode === 'search') {
    if (pgIsGenerating()) return;
    if (!pgAnyWindowHasModel()) { pgToast(pgT('pgSearchNoModel'), 'warning'); return; }
    var searchQuery = text.trim();
    if (!searchQuery) return;
    ta.value = '';
    pgSearchSend(searchQuery);
    return;
  }

  if (pgIsGenerating()) return;
  if (!pgAnyWindowHasModel()) {
    pgToast(pgT('pgSelectModel'), 'warning'); return;
  }

  var skipped = [];
  var now = Date.now();
  var hadImages = false;
  for (var i = 0; i < pgState.splitCount; i++) {
    var w = pgWinAt(i);
    if (!w.config.model) {
      skipped.push(i);
      pgToast(pgT('pgNoModelWin', [i + 1]), 'warning');
      continue;
    }
    var content = text;
    if (w.config.imageEnabled && w.config.imageUrls && w.config.imageUrls.length > 0) {
      var urls = w.config.imageUrls.filter(function(u) { return u && u.trim(); });
      if (urls.length > 0) {
        var parts = [];
        if (text) parts.push({ type: 'text', text: text });
        urls.forEach(function(u) {
          parts.push({ type: 'image_url', image_url: { url: u } });
        });
        content = parts;
      }
      w.config.imageUrls = [];
      w.config.imageEnabled = false;
      hadImages = true;
    }
    w.messages.push({ role: 'user', content: content, createdAt: now });
    w.messages.push({ role: 'assistant', content: '', reasoning: '', status: 'loading', startedAt: now });
  }
  ta.value = '';
  if (hadImages) {
    pgRenderInputThumbs();
    pgRenderSidebar();
  }
  for (var i2 = 0; i2 < pgState.splitCount; i2++) {
    if (skipped.indexOf(i2) >= 0) continue;
    pgRenderMessages(i2);
    var w2 = pgWinAt(i2);
    pgSend(i2, w2.messages.length - 1);
  }
  pgSave();
}

function pgUserSendText(text) {
  var ta = document.getElementById('pg-input');
  if (ta) ta.value = text;
  pgUserSend();
}

// ----- Module 12: Paste / Upload multimodal media -------------------
async function pgProcessUploadedFile(file) {
  var mime = file.type || '';
  if (!mime) {
    var name = (file.name || '').toLowerCase();
    if (name.endsWith('.pdf')) mime = 'application/pdf';
    else if (name.endsWith('.png')) mime = 'image/png';
    else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) mime = 'image/jpeg';
    else if (name.endsWith('.webp')) mime = 'image/webp';
    else if (name.endsWith('.gif')) mime = 'image/gif';
    else if (name.endsWith('.svg')) mime = 'image/svg+xml';
    else if (name.endsWith('.mp3')) mime = 'audio/mp3';
    else if (name.endsWith('.wav')) mime = 'audio/wav';
    else if (name.endsWith('.ogg')) mime = 'audio/ogg';
    else if (name.endsWith('.aac')) mime = 'audio/aac';
    else if (name.endsWith('.flac')) mime = 'audio/flac';
    else if (name.endsWith('.m4a')) mime = 'audio/m4a';
    else if (name.endsWith('.mp4')) mime = 'video/mp4';
    else if (name.endsWith('.webm')) mime = 'video/webm';
    else if (name.endsWith('.mov')) mime = 'video/quicktime';
    else if (name.endsWith('.mkv')) mime = 'video/x-matroska';
    else if (name.endsWith('.avi')) mime = 'video/x-msvideo';
  }

  // If audio or video, invoke /api/playground/media-prep
  if (mime.indexOf('audio/') === 0 || mime.indexOf('video/') === 0) {
    var formData = new FormData();
    formData.append('file', file);
    formData.append('mimeType', mime);
    formData.append('target', 'audio');
    try {
      var resp = await fetch('/api/playground/media-prep', {
        method: 'POST',
        body: formData
      });
      if (resp.ok) {
        var json = await resp.json();
        if (json.ok && json.inlineData) {
          return 'data:' + json.inlineData.mimeType + ';base64,' + json.inlineData.data;
        }
      }
    } catch (e) {
      console.warn('media-prep request error, fallback to raw read:', e);
    }
  }

  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(ev) {
      resolve(ev.target.result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function pgHandleFiles(files) {
  var w = pgWin();
  if (!w || !files || files.length === 0) return;
  if (!w.config.imageEnabled) {
    w.config.imageEnabled = true;
  }
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    try {
      var dataUrl = await pgProcessUploadedFile(file);
      w.config.imageUrls.push(dataUrl);
    } catch (e) {
      console.error('File read error:', e);
    }
  }
  pgSave();
  pgRenderSidebar();
  pgRenderInputThumbs();
  pgToast(pgT('pgImagePasteAdded'), 'success');
}

function pgPasteImage(e) {
  var w = pgWin();
  if (!w) return;
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  var filesToProcess = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.type && (it.type.indexOf('image/') === 0 || it.type.indexOf('audio/') === 0 || it.type.indexOf('video/') === 0 || it.type === 'application/pdf')) {
      var blob = it.getAsFile();
      if (blob) filesToProcess.push(blob);
    }
  }
  if (filesToProcess.length > 0) {
    e.preventDefault();
    pgHandleFiles(filesToProcess);
  }
}
// ----- Panes layout ------------------------------------------------
function pgRenderPanes() {
  var panes = document.getElementById('pg-panes');
  if (!panes) return;
  var isBatchActive = pgState.mode === 'image' && pgState.imageBatch && pgState.imageBatch.uiMode !== 'idle';
  if (isBatchActive) {
    if (pgState.imageBatch.uiMode === 'executing') {
      pgState.splitCount = 1;
    } else {
      pgState.splitCount = 2;
      while (pgState.windows.length < 2) {
        if (typeof makeWin === 'function') pgState.windows.push(makeWin());
      }
    }
  } else if (pgState.mode === 'search') {
    pgState.splitCount = 2;
    while (pgState.windows.length < 2) {
      pgState.windows.push(makeWin());
    }
  }
  var n = pgState.splitCount;
  var cols = n === 1 ? '1fr' : (n === 2 ? '1fr 1fr' : (n === 3 ? '1fr 1fr 1fr' : '1fr 1fr'));
  var rows = n === 4 ? '1fr 1fr' : '1fr';
  panes.style.gridTemplateColumns = cols;
  panes.style.gridTemplateRows = rows;
  var html = '';
  for (var i = 0; i < n; i++) {
    var w = pgWinAt(i);
    var modelLabel = w && w.config && w.config.model ? pgEscapeHtml(w.config.model) : pgEscapeHtml(pgT('pgSelectModel'));
    if (modelLabel.length > 30) modelLabel = modelLabel.substring(0, 30) + '…';
    var paneLabel = (w && w.config.agentName) ? w.config.agentName : pgT('pgPaneName', [i + 1]);
    if (pgState.mode === 'search') {
      paneLabel = i === 0 ? pgT('pgSearchPaneLeft') : pgT('pgSearchPaneRight');
    } else if (isBatchActive) {
      var stg = pgState.imageBatch.stage;
      if (stg === 1) paneLabel = i === 0 ? '1. Planning Form' : 'Plan Request Log';
      else if (stg === 2) paneLabel = i === 0 ? 'Plan Request Log' : '2. Format Conversion';
      else if (stg === 3) paneLabel = i === 0 ? 'Conversion Items' : '3. Review & Start';
      else if (stg === 4) paneLabel = 'Batch Execution Viewer';
    }
    html += '<div class="pg-pane' + (i === pgState.activeWin ? ' active' : '') + '" data-win="' + i + '">' +
      '<div class="pg-pane-head" onclick="pgSetActiveWin(' + i + ')">' +
        '<span class="pg-pane-idx">' + pgEscapeHtml(paneLabel) +
          '<span class="pg-pane-typing" style="display:none"></span>' +
        '</span>' +
        (!isBatchActive ? '<span class="pg-pane-model">' + modelLabel + '</span>' : '') +
        (pgState.mode === 'image' && !isBatchActive ? '<span class="pg-pane-img-meta" id="pg-pane-img-meta-' + i + '"></span><span class="pg-pane-img-nav" id="pg-pane-img-nav-' + i + '"></span>' : '') +
        (pgState.mode !== 'search' && !isBatchActive ? '<button class="pg-pane-btn" onclick="event.stopPropagation();pgClearWindowMessages(' + i + ')" data-tooltip="' + pgEscapeHtml(pgT('pgClearWin')) + '">' + PG_ICON_DELETE + '</button>' : '') +
        (!isBatchActive ? '<button class="pg-pane-btn" onclick="event.stopPropagation();pgOpenDebugModal(' + i + ')" data-tooltip="' + pgEscapeHtml(pgT('pgDebugWin')) + '">' + PG_ICON_DEBUG + '</button>' : '') +
      '</div>' +
      '<div class="pg-messages" id="pg-messages-' + i + '"></div>' +
    '</div>';
  }
  panes.innerHTML = html;
  var inner = document.getElementById('pg-main-inner');
  if (inner) {
    inner.classList.toggle('pg-split', n > 1);
  }
  var showReqLeft = !pgState.autoChat.enabled && n === 1 && pgState.mode !== 'search';
  var layout = document.querySelector('.pg-layout');
  if (layout) {
    layout.classList.toggle('pg-req-left-mode', showReqLeft);
  }
  pgRenderReqLeft(showReqLeft);
  for (var i2 = 0; i2 < n; i2++) {
    pgRenderMessages(i2);
  }
}

function pgSetMode(mode) {
  if (mode === pgState.mode) return;
  var oldMode = pgState.mode;

  if (!pgState.modeWindows) {
    pgState.modeWindows = { normal: null, search: null, image: null, autochat: null };
  }

  // Batch exit must run before mode/windows are switched: pgImageBatchExitUI
  // restores the Image layout, which is only valid while still in Image mode.
  if (oldMode === 'image' && pgState.imageBatch && pgState.imageBatch.uiMode !== 'idle') {
    if (typeof pgImageBatchCloseUI === 'function') {
      pgImageBatchCloseUI();
    }
  }

  // 1. Save oldMode's windows & splitCount
  if (oldMode) {
    pgState.modeWindows[oldMode] = pgState.windows;
    if (pgState.modeSplitCounts) {
      pgState.modeSplitCounts[oldMode] = pgState.splitCount;
    }
  }

  pgState.mode = mode;

  // 2. Calculate mode's splitCount
  var targetSplit = (pgState.modeSplitCounts && pgState.modeSplitCounts[mode]) || 1;
  if (mode === 'search') {
    targetSplit = 2;
  } else if (mode === 'autochat') {
    if (targetSplit < 2) targetSplit = 2;
  }
  pgState.splitCount = targetSplit;
  if (pgState.modeSplitCounts) {
    pgState.modeSplitCounts[mode] = targetSplit;
  }

  // 3. Load mode's dedicated windows (data isolation & state preservation across modes)
  if (pgState.modeWindows[mode] && pgState.modeWindows[mode].length > 0) {
    pgState.windows = pgState.modeWindows[mode];
  } else {
    pgState.windows = [];
    for (var wI = 0; wI < targetSplit; wI++) {
      if (typeof makeWin === 'function') pgState.windows.push(makeWin());
    }
    pgState.modeWindows[mode] = pgState.windows;
  }

  while (pgState.windows.length < targetSplit) {
    if (typeof makeWin === 'function') pgState.windows.push(makeWin());
  }

  if (pgState.activeWin >= targetSplit) {
    pgState.activeWin = targetSplit - 1;
  }

  // 4. Mode-specific lifecycle actions
  if (mode === 'autochat') {
    pgAutoChatToggle(true);
  } else {
    if (oldMode === 'autochat') pgAutoChatToggle(false);
    if (mode === 'search') {
      if (typeof pgSearchLoadSettings === 'function') pgSearchLoadSettings();
      if (typeof pgSyncSearchMessages === 'function') pgSyncSearchMessages();
    }
  }

  // Batch UI is only entered by an explicit user action (the sidebar
  // Batch Project / Return button). It is never re-entered automatically
  // from persisted state when returning to Image mode.

  pgSaveMode();
  pgRenderSidebar();
  pgRenderPanes();
  pgRenderInputBar();
}

function pgSetSplitCount(n) {
  if (pgState.mode === 'image' && pgState.imageBatch && pgState.imageBatch.uiMode !== 'idle') {
    return;
  }
  if (pgIsGenerating()) { pgToast(pgT('pgGenSwitchLock'), 'warning'); return; }
  n = Math.max(1, Math.min(4, parseInt(n, 10) || 1));
  if (pgState.mode === 'autochat' && n < 2) n = 2;
  pgState.splitCount = n;
  if (pgState.modeSplitCounts) {
    pgState.modeSplitCounts[pgState.mode] = n;
  }
  while (pgState.windows.length < n) {
    if (typeof makeWin !== 'function') break;
    pgState.windows.push(makeWin());
  }
  if (pgState.modeWindows) pgState.modeWindows[pgState.mode] = pgState.windows;
  if (pgState.activeWin >= n) pgState.activeWin = n - 1;
  pgRenderPanes();
  pgRenderSidebar();
}

function pgSetActiveWin(i) {
  if (pgIsGenerating()) return;
  i = parseInt(i, 10);
  if (!isFinite(i) || i < 0 || i >= pgState.splitCount || !pgWinAt(i)) return;
  pgState.activeWin = i;
  pgRenderPanes();
  pgRenderSidebar();
  pgRenderInputBar();
}

function pgResetSettings() {
  var w = pgWin();
  if (!w) return;
  if (!confirm(pgT('pgResetConfirm'))) return;
  w.config = JSON.parse(JSON.stringify(PG_DEFAULT_CFG));
  w.parameterEnabled = JSON.parse(JSON.stringify(PG_DEFAULT_PARAMS));
  pgSave();
  pgRenderSidebar();
  pgRenderMessages(pgState.activeWin);
  pgToast(pgT('pgCfgReset'), 'success');
}
function pgRenderSidebar() {
  var side = document.getElementById('pg-side');
  if (!side) return;
  if (pgState.mode === 'image' && pgState.imageBatch && pgState.imageBatch.uiMode === 'executing') {
    if (typeof pgImageBatchRenderSidebar === 'function') {
      side.innerHTML = pgImageBatchRenderSidebar();
    }
    return;
  }
  var w = pgWin();
  if (!w) return;
  var en = w.parameterEnabled;
  var cfg = w.config;
  var customMode = cfg.useCustomBody;
  var dimCls = customMode ? ' disabled' : '';
  // Batch Project / Return toggle: while Batch UI is active the button becomes
  // a clickable Return that exits to the normal Image layout (preserving the
  // draft/plan/transform/project; the backend task keeps running). The numeric
  // input to its right is the Manual Canvas per-submission image count (see
  // pgGetImageSubmitCount / pgOnImageSubmitCount) — it never touches the Batch
  // Planning quantity.
  var batchActive = pgState.mode === 'image' && pgState.imageBatch && pgState.imageBatch.uiMode !== 'idle';
  var imageBatchDisabled = pgState.mode === 'image' && pgState.splitCount > 1 && !batchActive;
  var imageBatchBtn;
  if (batchActive) {
    imageBatchBtn = '<button class="pg-btn pg-batch-btn" onclick="if(typeof pgImageBatchCloseUI===\'function\') pgImageBatchCloseUI()" data-tooltip="' + pgEscapeHtml(pgT('pgBatchReturnTip')) + '" style="flex:1;min-width:0;width:auto;white-space:nowrap">' + pgEscapeHtml(pgT('pgBatchReturn')) + '</button>';
  } else {
    var imageBatchTitle = imageBatchDisabled ? pgT('pgBatchSingleWindow') : pgT('pgBatchProject');
    imageBatchBtn = '<button class="pg-btn pg-batch-btn' + (imageBatchDisabled ? ' disabled' : '') + '" onclick="if(!' + imageBatchDisabled + ' && typeof pgOpenImageBatch===\'function\') pgOpenImageBatch()"' + (imageBatchDisabled ? ' disabled' : '') + ' data-tooltip="' + pgEscapeHtml(imageBatchTitle) + '" style="flex:1;min-width:0;width:auto;white-space:nowrap">' + pgEscapeHtml(pgT('pgBatchProject')) + '</button>';
  }
  var submitCountStepper =
    '<div class="number-stepper pg-img-submit-stepper" data-tooltip="' + pgEscapeHtml(pgT('pgImageSubmitCountTip')) + '">' +
      '<button type="button" class="stepper-btn stepper-minus" onclick="pgStepImageSubmitCount(-1)" tabindex="-1">-</button>' +
      '<input type="number" class="stepper-input pg-image-submit-count" min="1" max="99" step="1" value="' + pgGetImageSubmitCount() + '" onchange="pgOnImageSubmitCount(this.value)" aria-label="' + pgEscapeHtml(pgT('pgImageSubmitCountTip')) + '">' +
      '<button type="button" class="stepper-btn stepper-plus" onclick="pgStepImageSubmitCount(1)" tabindex="-1">+</button>' +
    '</div>';
  var batchEntryHtml = '<div class="pg-batch-entry">' + imageBatchBtn + submitCountStepper + '</div>';
  var imageActionsRow = '<div class="pg-image-actions-row" style="margin-top:8px">' + batchEntryHtml + '</div>';
  // --- WinBar ---
  var generating = pgIsGenerating();
  var winBtns = '';
  for (var k = 0; k < 4; k++) {
    var isActive = k === pgState.activeWin ? ' active' : '';
    var isDisabled = (k >= pgState.splitCount || generating) ? ' disabled' : '';
    winBtns += '<button class="pg-win-btn' + isActive + '" onclick="pgSetActiveWin(' + k + ')"' + (isDisabled ? ' disabled' : '') + ' data-tooltip="' + pgEscapeHtml(pgT('pgWinBtnTitle', [k + 1])) + '">' + (k + 1) + '</button>';
  }
  var startSplit = (pgState.mode === 'autochat') ? 2 : 1;
  var splitOptsList = [];
  for (var s = startSplit; s <= 4; s++) {
    splitOptsList.push({ value: s, label: String(s) });
  }
  var splitSelHtml = pgRenderCustomSelect('pg-split-wrap', 'pg-split-sel', splitOptsList, pgState.splitCount, 'pgSetSplitCount(parseInt(this.value,10))', 'width:60px');

  var winbarRow = pgState.mode === 'search' ? '' : (
    '<div class="pg-panel-title" style="margin-bottom:8px">' + pgEscapeHtml(pgT('pgWinBarTitle')) + '</div>' +
    '<div class="pg-winbar-row">' +
      '<div class="pg-winbar-btns">' +
        winBtns +
        '<button class="pg-win-btn pg-reset-btn" onclick="pgResetSettings()"' + (generating ? ' disabled' : '') + ' data-tooltip="' + pgEscapeHtml(pgT('pgResetCfg')) + '">' + PG_ICON_RESET + '</button>' +
      '</div>' +
      splitSelHtml +
    '</div>'
  );

  var currentMode = pgState.mode;

  var winbarContent = winbarRow ? ('<div class="pg-winbar-body">' + winbarRow + '</div>') : '';
  var winbar =
    '<div class="pg-panel pg-winbar">' +
      '<div class="pg-winbar-header">' +
        '<div class="pg-mode-toggle">' +
          '<button class="pg-mode-btn' + (currentMode === 'normal' ? ' active' : '') + '" data-mode="normal" onclick="pgSetMode(\'normal\')">' + pgEscapeHtml(pgT('pgModeNormal')) + '</button>' +
          '<button class="pg-mode-btn' + (currentMode === 'search' ? ' active' : '') + '" data-mode="search" onclick="pgSetMode(\'search\')">' + pgEscapeHtml(pgT('pgModeSearch')) + '</button>' +
          '<button class="pg-mode-btn' + (currentMode === 'image' ? ' active' : '') + '" data-mode="image" onclick="pgSetMode(\'image\')">' + pgEscapeHtml(pgT('pgModeImage')) + '</button>' +
          '<button class="pg-mode-btn' + (currentMode === 'autochat' ? ' active' : '') + '" data-mode="autochat" onclick="pgSetMode(\'autochat\')">' + pgEscapeHtml(pgT('pgModeAutoChat')) + '</button>' +
        '</div>' +
      '</div>' +
      winbarContent +
    '</div>';

  // --- Model select (image mode: protocol and image model) ---
  var modelLabel = pgWin().config.model || pgT('pgSelectModel');
  var modelPickerOpts = { kindFilter: 'text' };
  var modelSel = '<button class="pg-btn pg-model-btn"' + (customMode ? ' disabled' : '') + ' onclick="pgOpenModelPicker(pgWin().config.model, function(v){ pgOnModelChange(v); pgRenderSidebar(); }, ' + JSON.stringify(modelPickerOpts).replace(/"/g, '&quot;') + ')" style="width:100%;text-align:left;justify-content:flex-start">' + pgEscapeHtml(modelLabel) + ' <span style="float:right;opacity:0.5">▼</span></button>';
  if (pgState.mode === 'image') {
    var protos = pgImageProtocols(), protoCur = cfg.imgProtocolFilter || 'all';
    var protoLabels = { all: pgT('pgImgProtocolAll'), gpt: 'GPT', xai: 'Xai', modelscope: 'ModelScope', sensenova: 'SenseNova', comfyui: 'ComfyUI' };
    var protoOptsList = protos.map(function(p) {
      return { value: p, label: protoLabels[p] || p };
    });
    var protoSelHtml = pgRenderCustomSelect('pg-proto-wrap', 'pg-proto-sel', protoOptsList, protoCur, 'pgOnProtocolFilter(this.value)', 'flex:1;min-width:0');

    var mCur = cfg.model || '', availModels = (pgState.models || []).slice().filter(function(m) { return m.kind === 'image'; });
    if (protoCur && protoCur !== 'all') availModels = availModels.filter(function(m) { return (m.imgProtocol || 'gpt') === protoCur; });
    var modelOptsList = [{ value: '', label: pgT('pgSelectModel') }].concat(
      availModels.map(function(m) { return { value: m.id, label: m.id }; })
    );
    var modelSelHtml = pgRenderCustomSelect('pg-imgmodel-wrap', 'pg-imgmodel-sel', modelOptsList, mCur, 'pgOnModelChange(this.value); pgOnModelSelectBackfill(this.value); pgSave(); pgRenderSidebar(); pgRenderPanes(); pgUpdateInputBar()', 'flex:1;min-width:0');

    modelSel = '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('pgImgProtocol')) + '</label>' + protoSelHtml + '</div>' +
               '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('pgModel')) + '</label>' + modelSelHtml + '</div>';
  }

  // --- Parameters ---
  function paramRow(key, label, min, max, step, isNum) {
    var on = en[key];
    var val = cfg[key];
    var disabled = !on || customMode;
    var valAttr = typeof val === 'number' ? 'value="' + val + '"' : 'value=""';
    var input = isNum
      ? '<input type="number" min="' + min + '" step="' + step + '" ' + valAttr + ' onchange="pgOnParam(\'' + key + '\', this.value==\'\'?0:'+ (min < 0 ? 'parseFloat(this.value)' : 'parseInt(this.value,10)||0') + ')">'
      : '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" oninput="pgOnParam(\'' + key + '\', parseFloat(this.value))"><span class="pg-val" id="pg-val-' + key + '">' + (typeof val === 'number' ? val.toFixed(2) : val) + '</span>';
    return '<div class="pg-param' + (disabled ? ' disabled' : '') + '">' +
      '<button class="pg-toggle' + (on ? ' on' : '') + '" onclick="pgToggleParam(\'' + key + '\')" data-tooltip="' + pgEscapeHtml(pgT('pgParamToggle')) + '">' + (on ? '✓' : '✕') + '</button>' +
      '<label>' + pgEscapeHtml(pgT(label)) + '</label>' +
      input +
    '</div>';
  }

  var isGoogle = pgGetTextProtocol(cfg.model) === 'google';
  var params = '';
  if (isGoogle) {
    var thinkOpts = [
      { value: 'minimal', label: pgT('pgThinkingMinimal') || 'Minimal' },
      { value: 'low', label: pgT('pgThinkingLow') || 'Low' },
      { value: 'medium', label: pgT('pgThinkingMedium') || 'Medium' },
      { value: 'high', label: pgT('pgThinkingHigh') || 'High' }
    ];
    var thinkSelHtml = pgRenderCustomSelect('pg-thinklvl-wrap', 'pg-thinklvl-sel', thinkOpts, cfg.thinkingLevel || 'medium', 'pgOnParam(\'thinkingLevel\', this.value)', 'flex:1;min-width:0');

    var mimeOpts = [
      { value: 'text/plain', label: 'Text (text/plain)' },
      { value: 'application/json', label: 'JSON (application/json)' }
    ];
    var mimeSelHtml = pgRenderCustomSelect('pg-mimetype-wrap', 'pg-mimetype-sel', mimeOpts, cfg.responseMimeType || 'text/plain', 'pgOnParam(\'responseMimeType\', this.value); pgRenderSidebar();', 'flex:1;min-width:0');

    params =
      '<div class="pg-param' + (!en.thinkingLevel || customMode ? ' disabled' : '') + '">' +
        '<button class="pg-toggle' + (en.thinkingLevel ? ' on' : '') + '" onclick="pgToggleParam(\'thinkingLevel\')" data-tooltip="' + pgEscapeHtml(pgT('pgParamToggle')) + '">' + (en.thinkingLevel ? '✓' : '✕') + '</button>' +
        '<label>' + pgEscapeHtml(pgT('pgThinkingLevel')) + '</label>' +
        thinkSelHtml +
      '</div>' +
      paramRow('temperature', 'pgTemperature', 0, 2, 0.1, false) +
      paramRow('topP', 'pgTopP', 0, 1, 0.05, false) +
      paramRow('topK', 'pgTopK', 1, 100, 1, true) +
      paramRow('maxOutputTokens', 'pgMaxOutputTokens', 1, 65536, 1, true) +
      paramRow('presencePenalty', 'pgPresPenalty', -2, 2, 0.1, false) +
      paramRow('frequencyPenalty', 'pgFreqPenalty', -2, 2, 0.1, false) +
      '<div class="pg-param' + (!en.stopSequences || customMode ? ' disabled' : '') + '">' +
        '<button class="pg-toggle' + (en.stopSequences ? ' on' : '') + '" onclick="pgToggleParam(\'stopSequences\')" data-tooltip="' + pgEscapeHtml(pgT('pgParamToggle')) + '">' + (en.stopSequences ? '✓' : '✕') + '</button>' +
        '<label>' + pgEscapeHtml(pgT('pgStopSequences')) + '</label>' +
        '<input type="text" placeholder="' + pgEscapeHtml(pgT('pgStopSequencesPlaceholder')) + '" value="' + pgEscapeHtml(cfg.stopSequences || '') + '" oninput="pgOnParam(\'stopSequences\', this.value)"' + (!en.stopSequences || customMode ? ' disabled' : '') + '>' +
      '</div>' +
      paramRow('candidateCount', 'pgCandidateCount', 1, 8, 1, true) +
      '<div class="pg-param' + (!en.responseMimeType || customMode ? ' disabled' : '') + '">' +
        '<button class="pg-toggle' + (en.responseMimeType ? ' on' : '') + '" onclick="pgToggleParam(\'responseMimeType\')" data-tooltip="' + pgEscapeHtml(pgT('pgParamToggle')) + '">' + (en.responseMimeType ? '✓' : '✕') + '</button>' +
        '<label>' + pgEscapeHtml(pgT('pgResponseMimeType')) + '</label>' +
        mimeSelHtml +
      '</div>' +
      ((cfg.responseMimeType === 'application/json') ? (
        '<div class="pg-param' + (!en.responseSchema || customMode ? ' disabled' : '') + '" style="display:block;margin-top:6px;">' +
          '<div style="display:flex;align-items:center;margin-bottom:4px;">' +
            '<button class="pg-toggle' + (en.responseSchema ? ' on' : '') + '" onclick="pgToggleParam(\'responseSchema\')" data-tooltip="' + pgEscapeHtml(pgT('pgParamToggle')) + '">' + (en.responseSchema ? '✓' : '✕') + '</button>' +
            '<label style="margin-left:4px;">' + pgEscapeHtml(pgT('pgResponseSchema')) + '</label>' +
          '</div>' +
          '<textarea style="width:100%;height:60px;font-family:monospace;font-size:11px;resize:vertical;" placeholder="' + pgEscapeHtml(pgT('pgResponseSchemaPlaceholder')) + '" oninput="pgOnParam(\'responseSchema\', this.value)"' + (!en.responseSchema || customMode ? ' disabled' : '') + '>' + pgEscapeHtml(cfg.responseSchema || '') + '</textarea>' +
        '</div>'
      ) : '') +
      '<div class="pg-switch"><input type="checkbox" id="pg-stream" ' + (cfg.stream ? 'checked' : '') + ' onchange="pgOnParam(\'stream\', this.checked)"' + (customMode ? ' disabled' : '') + '><label for="pg-stream">' + pgEscapeHtml(pgT('pgStream')) + '</label></div>';
  } else {
    params =
      paramRow('temperature', 'pgTemperature', 0, 2, 0.1, false) +
      paramRow('topP', 'pgTopP', 0, 1, 0.05, false) +
      paramRow('frequencyPenalty', 'pgFreqPenalty', -2, 2, 0.1, false) +
      paramRow('presencePenalty', 'pgPresPenalty', -2, 2, 0.1, false) +
      paramRow('maxTokens', 'pgMaxTokens', 0, 1, 1, true) +
      paramRow('thinkingBudget', 'pgThinking', 0, 100000, 100, true) +
      '<div class="pg-param' + (!en.seed || customMode ? ' disabled' : '') + '">' +
        '<button class="pg-toggle' + (en.seed ? ' on' : '') + '" onclick="pgToggleParam(\'seed\')" data-tooltip="' + pgEscapeHtml(pgT('pgParamToggle')) + '">' + (en.seed ? '✓' : '✕') + '</button>' +
        '<label>' + pgEscapeHtml(pgT('pgSeed')) + '</label>' +
        '<input type="text" placeholder="' + pgEscapeHtml(pgT('pgSeedPlaceholder')) + '" value="' + pgEscapeHtml(cfg.seed || '') + '" oninput="pgOnParam(\'seed\', this.value)"' + (!en.seed || customMode ? ' disabled' : '') + '>' +
      '</div>' +
      '<div class="pg-switch"><input type="checkbox" id="pg-stream" ' + (cfg.stream ? 'checked' : '') + ' onchange="pgOnParam(\'stream\', this.checked)"' + (customMode ? ' disabled' : '') + '><label for="pg-stream">' + pgEscapeHtml(pgT('pgStream')) + '</label></div>';
  }

  // --- System prompt ---
  var sysPrompt =
    '<textarea class="pg-system-prompt" id="pg-sysprompt" placeholder="' + pgEscapeHtml(pgT('pgSystemPromptPlaceholder')) + '" oninput="pgOnSystemPrompt(this.value)"' + (customMode ? ' disabled' : '') + '>' + pgEscapeHtml(cfg.systemPrompt || '') + '</textarea>';

  // --- Image URL input ---
  var imgBlock = pgRenderImageBlock(customMode);

  // --- Custom body ---
  var customValid = true;
  var customErr = '';
  if (cfg.useCustomBody && cfg.customBody && cfg.customBody.trim()) {
    try { JSON.parse(cfg.customBody); } catch (e) { customValid = false; customErr = e.message; }
  }
  var customStatus = cfg.useCustomBody
    ? (customValid
      ? '<div class="pg-custom-status valid">✓ ' + pgEscapeHtml(pgT('pgCustomJsonValid')) + '</div>'
      : '<div class="pg-custom-status invalid">✕ ' + pgEscapeHtml(pgT('pgCustomJsonInvalid')) + '</div>')
    : '';
  var customWarning = cfg.useCustomBody ? '<div class="pg-custom-warning">⚠ ' + pgEscapeHtml(pgT('pgCustomWarning')) + '</div>' : '';
  var formatBtn = cfg.useCustomBody && customValid
    ? '<button class="pg-sse-action" onclick="pgCustomFormat()">' + pgEscapeHtml(pgT('pgCustomFormat')) + '</button>'
    : '';
  var customErrLine = (!customValid && customErr) ? '<div class="pg-custom-error-msg">' + pgEscapeHtml(pgT('pgCustomJsonError', [customErr])) + '</div>' : '';
  var custom =
    '<div class="pg-custom-toolbar">' +
      '<div class="pg-switch" style="margin-bottom:0"><input type="checkbox" id="pg-custombody-toggle" ' + (cfg.useCustomBody ? 'checked' : '') + ' onchange="pgOnParam(\'useCustomBody\', this.checked); pgRenderSidebar()"><label for="pg-custombody-toggle">' + pgEscapeHtml(pgT('pgUseCustomBody')) + '</label></div>' +
      customStatus +
    '</div>' +
    customWarning +
    '<div class="pg-custom-editor">' +
      '<textarea class="pg-custom-body' + (!customValid ? ' invalid' : '') + '" id="pg-custombody" oninput="pgOnParam(\'customBody\', this.value); pgRenderSidebar()" placeholder=\'{"model":"...","messages":[...]}\'>' + pgEscapeHtml(cfg.customBody || '') + '</textarea>' +
    '</div>' +
    customErrLine;

  // --- Custom Endpoint ---
  var customEp =
    '<div class="pg-custom-toolbar">' +
      '<div class="pg-switch" style="margin-bottom:0"><input type="checkbox" id="pg-customep-toggle" ' + (cfg.useCustomEndpoint ? 'checked' : '') + ' onchange="pgOnParam(\'useCustomEndpoint\', this.checked); pgRenderSidebar()"><label for="pg-customep-toggle">' + pgEscapeHtml(pgT('pgUseCustomEndpoint')) + '</label></div>' +
    '</div>' +
    (cfg.useCustomEndpoint ? '<div class="pg-custom-ep-hint">' + pgEscapeHtml(pgT('pgCustomEndpointHint')) + '</div>' : '') +
    '<div class="pg-custom-ep-fields"' + (cfg.useCustomEndpoint ? '' : ' style="display:none"') + '>' +
      '<input type="text" class="pg-custom-ep-url" id="pg-customep-url" value="' + pgEscapeAttr(cfg.customEndpoint || '') + '" oninput="pgOnParam(\'customEndpoint\', this.value)" placeholder="' + pgEscapeAttr(pgT('pgCustomEndpointUrlPlaceholder')) + '">' +
      '<input type="password" class="pg-custom-ep-key" id="pg-customep-key" value="' + pgEscapeAttr(cfg.customEndpointKey || '') + '" oninput="pgOnParam(\'customEndpointKey\', this.value)" placeholder="' + pgEscapeAttr(pgT('pgCustomEndpointKey')) + '">' +
    '</div>';

  // --- Debug ---
  var sseCount = w.sseEvents.length;
  var customBadge = cfg.useCustomBody ? ' <span class="pg-tab-badge custom">' + pgEscapeHtml(pgT('pgDebugCustomBadge')) + '</span>' : '';
  var responseBadge = sseCount > 0 ? ' <span class="pg-tab-badge">SSE ' + sseCount + '</span>' : '';
  var debugTabs = '<div class="pg-tabs">' +
    '<button class="pg-tab' + (w.debugTab === 'preview' ? ' active' : '') + '" data-tab="preview" onclick="pgSetDebugTab(\'preview\')">👁 ' + pgEscapeHtml(pgT('pgDebugTabPreview')) + customBadge + '</button>' +
    '<button class="pg-tab' + (w.debugTab === 'request' ? ' active' : '') + '" data-tab="request" onclick="pgSetDebugTab(\'request\')">📤 ' + pgEscapeHtml(pgT('pgDebugTabRequest')) + '</button>' +
    '<button class="pg-tab' + (w.debugTab === 'response' ? ' active' : '') + '" data-tab="response" onclick="pgSetDebugTab(\'response\')">⚡ ' + pgEscapeHtml(pgT('pgDebugTabResponse')) + responseBadge + '</button>' +
  '</div>';
  var debugMeta = '<div class="pg-debug-meta">' +
    '<span>' + pgEscapeHtml(pgT('pgRespProvider').replace('{0}', w.lastProvider || pgT('pgNoProvider'))) + '</span>' +
    '<span>' + pgEscapeHtml(pgT('pgRespKey').replace('{0}', w.lastKey || pgT('pgNoProvider'))) + '</span>' +
    '<span>' + (w.streaming ? '🔴 ' + pgT('pgStreaming') : '🟢 ' + pgT('pgIdle')) + '</span></div>';
  var debug = debugMeta + debugTabs + '<div class="pg-tab-content" id="pg-debug-content"></div><div class="pg-debug-footer" id="pg-debug-footer"></div>';

  var autoChatPanels = pgState.autoChat.enabled ? (
    // --- Auto chat panel ---
    '<div class="pg-panel pg-autochat-panel">' +
      '<div class="pg-panel-title">' + pgEscapeHtml(pgT('pgAutoChat')) + '</div>' +
      '<div class="pg-autochat-config">' +
        '<div class="pg-param-row">' +
          '<label>' + pgEscapeHtml(pgT('pgAutoChatIterations')) + '</label>' +
          '<input type="number" min="0" value="' + pgState.autoChat.iterations + '" onchange="pgAutoChatSetIterations(this.value)">' +
        '</div>' +
        '<div class="pg-autochat-hint" id="pg-autochat-iterations-hint">' + (pgState.autoChat.iterations === 0 ? pgEscapeHtml(pgT('pgAutoChatInfiniteWarn')) : '') + '</div>' +
        '<div class="pg-param-row">' +
          '<label>' + pgEscapeHtml(pgT('pgAutoChatUserName')) + '</label>' +
          '<input type="text" value="' + pgEscapeHtml(pgState.autoChat.userName || 'User') + '" oninput="pgAutoChatSetUserName(this.value)">' +
        '</div>' +
        '<div class="pg-param-row">' +
          '<label>' + pgEscapeHtml(pgT('pgAutoChatDelay')) + '</label>' +
          '<input type="number" min="0" step="0.5" value="' + pgState.autoChat.delaySeconds + '" onchange="pgAutoChatSetDelay(this.value)">' +
        '</div>' +
        '<div class="pg-autochat-hint">' + pgEscapeHtml(pgT('pgAutoChatDelayHint')) + '</div>' +
      '</div>' +
      '<div class="pg-autochat-actions">' +
        '<button class="pg-btn danger' + (pgState.autoChat.isRunning ? ' running' : '') + '" onclick="pgAutoChatStop()" id="pg-autochat-stop-btn">' + pgEscapeHtml(pgT('pgAutoChatStop')) + '</button>' +
        '<button class="pg-btn" onclick="pgOpenGroupChatModal()">' + pgEscapeHtml(pgT('pgAutoChatOpenGroup')) + '</button>' +
        '<button class="pg-btn" onclick="if(typeof pgOpenSetupWizard===\'function\') pgOpenSetupWizard()">' + pgEscapeHtml(pgT('Scenario Setup')) + '</button>' +
      '</div>' +
    '</div>' +
    // --- Director panel ---
    '<div class="pg-panel pg-director-panel">' +
      '<div class="pg-panel-title">' + pgEscapeHtml(pgT('Director')) + '</div>' +
      '<div class="pg-param-row">' +
        '<label>' + pgEscapeHtml(pgT('Director Enable')) + '</label>' +
        '<input type="checkbox" id="pg-director-enable"' + (pgState.autoChat.director.enabled ? ' checked' : '') + ' onchange="pgDirectorToggle(this.checked)">' +
      '</div>' +
       '<div class="pg-param-row">' +
         '<label>' + pgEscapeHtml(pgT('Director Model')) + '</label>' +
         '<button class="pg-btn pg-model-btn" onclick="pgOpenModelPicker(pgState.autoChat.director.directorModel, function(v){ pgDirectorSetDirectorModel(v); pgRenderSidebar(); }, {allowEmpty:true})" style="width:100%;text-align:left;justify-content:flex-start">' + pgEscapeHtml(pgState.autoChat.director.directorModel || pgT('Default (first window model)')) + ' <span style="float:right;opacity:0.5">▼</span></button>' +
       '</div>' +
       '<div class="pg-param-row">' +
         '<label>' + pgEscapeHtml(pgT('Narrator Model')) + '</label>' +
         '<button class="pg-btn pg-model-btn" onclick="pgOpenModelPicker(pgState.autoChat.director.narratorModel, function(v){ pgDirectorSetNarratorModel(v); pgRenderSidebar(); }, {allowEmpty:true})" style="width:100%;text-align:left;justify-content:flex-start">' + pgEscapeHtml(pgState.autoChat.director.narratorModel || pgT('Default (first window model)')) + ' <span style="float:right;opacity:0.5">▼</span></button>' +
       '</div>' +
      '<div class="pg-param-row">' +
        '<label>' + pgEscapeHtml(pgT('Every N Replies')) + '</label>' +
        '<input type="number" min="1" value="' + pgState.autoChat.director.everyNReplies + '" onchange="pgDirectorSetEveryNReplies(this.value)">' +
      '</div>' +
      '<div class="pg-param-row">' +
        '<label>' + pgEscapeHtml(pgT('Max Narrations')) + '</label>' +
        '<input type="number" min="0" value="' + pgState.autoChat.director.maxNarrations + '" onchange="pgDirectorSetMaxNarrations(this.value)">' +
        '<span class="pg-autochat-hint" style="margin-left:4px">' + pgEscapeHtml(pgT('0 = ∞')) + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgAutoChatAgentName')) + '</div>' +
      '<input type="text" class="pg-agent-name" placeholder="' + pgEscapeHtml(pgT('pgAutoChatAgentNamePlaceholder')) + '" value="' + pgEscapeHtml(cfg.agentName || '') + '" oninput="pgOnAgentName(this.value)">' +
      '<div class="pg-param-row" style="margin-top:8px"><label>' + pgEscapeHtml(pgT('pgContextLimit')) + '</label><input type="number" min="1000" step="1000" value="' + (cfg.contextLimit || 8000) + '" onchange="pgOnContextLimit(this.value)"></div>' +
    '</div>'
  ) : '';

  if (pgState.mode === 'image') {
    var effProto = pgEffectiveProtocol(cfg);
    var helperLabel = cfg.imgPromptModel || pgT('pgSelectModel');
    var helperPickerOpts = {
      allowEmpty: true,
      emptyLabel: pgT('pgSelectModel'),
      title: pgT('pgPromptHelperModel'),
      kindFilter: 'text'
    };
    var helperBtnHtml = '<button type="button" class="pg-btn pg-model-btn" onclick="pgOpenModelPicker(pgWin().config.imgPromptModel, function(v){ pgOnParam(\'imgPromptModel\', v); pgSave(); pgRenderSidebar(); }, ' + JSON.stringify(helperPickerOpts).replace(/"/g, '&quot;') + ')" style="flex:1;min-width:0;text-align:right;justify-content:flex-end;display:flex;align-items:center;padding:0 10px;height:32px;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" data-tooltip="' + pgEscapeAttr(helperLabel) + '"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:6px">' + pgEscapeHtml(helperLabel) + '</span><span style="opacity:0.5;flex-shrink:0">▼</span></button>';
    var promptHelperRow = '<div class="pg-param-row"><label data-tooltip="' + pgEscapeAttr(pgT('pgPromptHelperModel')) + '">' + pgEscapeHtml(pgT('pgPromptHelperModel')) + '</label>' + helperBtnHtml + '</div>';

    if (effProto === 'comfyui') {
      // ComfyUI protocol: connection panel + dynamic workflow params replace
      // the model selector (models come from ComfyUI, not /api/models).
      var comfyPanel = (typeof pgRenderComfyPanel === 'function') ? pgRenderComfyPanel(cfg) : '';
      side.innerHTML =
        winbar + comfyPanel +
        '<div class="pg-panel pg-image-actions-panel">' +
          promptHelperRow +
          imageActionsRow +
        '</div>' +
        '<div class="pg-panel' + dimCls + '"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgImage')) + '</div>' + imgBlock + '</div>' +
        '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgDebug')) + '</div>' + debug + '</div>';
    } else {
      var imgParams = effProto !== null ? pgRenderImageParams(cfg, effProto) : '';
      side.innerHTML =
        winbar +
        '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgSelectModel')) + '</div>' +
          modelSel +
          promptHelperRow +
          imageActionsRow +
        '</div>' +
        imgParams +
        '<div class="pg-panel' + dimCls + '"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgImage')) + '</div>' + imgBlock + '</div>' +
        '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgDebug')) + '</div>' + debug + '</div>';
    }
  } else if (pgState.mode === 'search') {
    var searchSettings = pgRenderSearchSettings(cfg);
    side.innerHTML =
      winbar +
      '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgSelectModel')) + '</div>' + modelSel + '</div>' +
      '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgSearchSettings')) + '<button class="pg-btn" onclick="window.open(\'https://www.anysearch.com/pricing\',\'_blank\')">' + pgEscapeHtml(pgT('pgSearchGetKey')) + '</button></div>' + searchSettings + '</div>' +
      '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgSearchHistory')) + '</div>' + pgRenderSearchHistory() + '</div>';
  } else {
    side.innerHTML =
      winbar +
      autoChatPanels +
      '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgSelectModel')) + '</div>' + modelSel + '</div>' +
      '<div class="pg-panel' + dimCls + '"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgParams')) + '</div>' + params + '</div>' +
      '<div class="pg-panel' + dimCls + '"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgSystemPrompt')) + '</div>' + sysPrompt + '</div>' +
      '<div class="pg-panel' + dimCls + '"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgImage')) + '</div>' + imgBlock + '</div>' +
      '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgCustomEndpoint')) + '</div>' + customEp + '</div>' +
      '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgCustomBody')) + '</div>' + custom + '</div>' +
      '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgDebug')) + '</div>' + debug + '</div>';
  }
  pgSchedulePreview();
  pgRenderDebugContent();
}

function pgGetModelInfo(modelId) {
  var models = pgState.models || [];
  for (var i = 0; i < models.length; i++) {
    if (models[i].id === modelId) return models[i];
  }
  return null;
}

// pgGetImgProtocol returns the imgProtocol for a model (gpt/xai/modelscope),
// defaulting to 'gpt' when the model is not an image kind or has no protocol.
// Used by request construction (pg-stream.js).
function pgGetImgProtocol(modelId) {
  var info = pgGetModelInfo(modelId);
  return (info && info.kind === 'image' && info.imgProtocol) ? info.imgProtocol : 'gpt';
}

function pgGetTextProtocol(modelId) {
  var info = pgGetModelInfo(modelId);
  if (!info) return '';
  if (info.textProtocol) return info.textProtocol;
  if (Array.isArray(info.protocols) && info.protocols.indexOf('google') !== -1) return 'google';
  return '';
}
// pgOnModelSelectBackfill sets the protocol filter to match the selected
// pgOnModelSelectBackfill sets the protocol filter to match the selected
// model's imgProtocol so the protocol picker stays coherent with the model.
// Called from the image-mode model <select> onchange after pgOnModelChange.
function pgOnModelSelectBackfill(modelId) {
  var w = pgWin();
  if (!w) return;
  if (!modelId) { w.config.imgProtocolFilter = 'all'; return; }
  var info = pgGetModelInfo(modelId);
  if (info && info.kind === 'image') {
    w.config.imgProtocolFilter = info.imgProtocol || 'gpt';
  } else {
    w.config.imgProtocolFilter = 'all';
  }
}

// pgEffectiveProtocol returns the protocol that governs the current image-mode
// parameter panel.  It prefers an explicit protocol filter (imgProtocolFilter)
// when one is active, then falls back to the selected model's imgProtocol,
// and finally to null.  This helper drives UI visibility and is also passed
// to pgRenderImageParams to determine which protocol's params panel to render.
function pgEffectiveProtocol(cfg) {
  // Prefer the selected model's imgProtocol first, then explicit filter.
  if (cfg.model) {
    var m = pgGetModelInfo(cfg.model);
    if (m && m.kind === 'image') return m.imgProtocol || 'gpt';
  }
  if (cfg.imgProtocolFilter && cfg.imgProtocolFilter !== 'all') {
    return cfg.imgProtocolFilter;
  }
  return null;
}

function pgImageProtocols() {
  return ['all', 'gpt', 'xai', 'modelscope', 'sensenova', 'comfyui'];
}

function pgRenderCustomSelect(wrapperId, selectId, options, selectedValue, onChangeCode, extraStyle) {
  if (typeof renderCustomSelectHtml === 'function') {
    return renderCustomSelectHtml(wrapperId, selectId, options, selectedValue, onChangeCode, extraStyle || 'flex:1;min-width:0');
  }
  var opts = options.map(function(o) {
    var val = typeof o === 'object' ? o.value : o;
    var label = typeof o === 'object' ? o.label : o;
    var isSel = String(val) === String(selectedValue);
    return '<option value="' + pgEscapeAttr(val) + '"' + (isSel ? ' selected' : '') + '>' + pgEscapeHtml(label) + '</option>';
  }).join('');
  return '<select id="' + selectId + '" class="pg-param-select" onchange="' + onChangeCode + '" style="' + (extraStyle || 'flex:1;min-width:0') + '">' + opts + '</select>';
}

function pgStepParam(key, delta, min, max, isFloat) {
  var w = pgWin();
  if (!w) return;
  var cur = isFloat ? (parseFloat(w.config[key]) || 0) : (parseInt(w.config[key], 10) || 0);
  var next = cur + delta;
  if (min != null && next < min) next = min;
  if (max != null && next > max) next = max;
  if (isFloat) next = Math.round(next * 100) / 100;
  w.config[key] = next;
  pgSave();
  pgRenderSidebar();
}

function pgImgParamSelect(key, labelKey, val, options) {
  var wrapId = 'pg-selwrap-' + key;
  var selId = 'pg-sel-' + key;
  var opts = options.map(function(o) {
    return { value: o.value, label: o.label };
  });
  return '<div class="pg-param-row">' +
    '<label>' + pgEscapeHtml(pgT(labelKey)) + '</label>' +
    pgRenderCustomSelect(wrapId, selId, opts, val || '', 'pgOnParam(\'' + key + '\', this.value)', 'flex:1;min-width:0') +
  '</div>';
}

function pgImgParamNumber(key, labelKey, val, min, max, step, isFloat) {
  var v = val != null ? val : (min || 0);
  var stp = step || 1;
  var flt = !!isFloat;
  return '<div class="pg-param-row">' +
    '<label>' + pgEscapeHtml(pgT(labelKey)) + '</label>' +
    '<div class="number-stepper" style="flex:1;min-width:0">' +
      '<button type="button" class="stepper-btn stepper-minus" onclick="pgStepParam(\'' + key + '\', -' + stp + ', ' + min + ', ' + max + ', ' + flt + ')">-</button>' +
      '<input type="number" class="stepper-input" min="' + min + '" max="' + max + '" step="' + stp + '" value="' + v + '" onchange="pgOnParam(\'' + key + '\', ' + (flt ? 'parseFloat(this.value)||0' : 'parseInt(this.value,10)||0') + ')">' +
      '<button type="button" class="stepper-btn stepper-plus" onclick="pgStepParam(\'' + key + '\', ' + stp + ', ' + min + ', ' + max + ', ' + flt + ')">+</button>' +
    '</div>' +
  '</div>';
}

// pgImgSizeOptionsFor returns the size option list for a model. If the model
// exposes a custom imgSizes list in pgState, use that; otherwise fall back to
// the built-in defaults for the given protocol ('gpt' or 'modelscope').
// The list never includes the ''/Default entry or the '__custom' sentinel —
// those are appended by pgImgParamSelectWithEdit so they always appear.
function pgImgSizeOptionsFor(proto, modelId, builtin) {
  var info = pgGetModelInfo(modelId);
  if (info && info.imgSizes && info.imgSizes.length) {
    var opts = [];
    for (var i = 0; i < info.imgSizes.length; i++) {
      var s = info.imgSizes[i];
      if (s) opts.push({ value: s, label: s });
    }
    return opts;
  }
  return builtin;
}

// pgImgParamSelectWithEdit renders a size select with:
//  - the options (Default + sizeOpts + a Custom... sentinel)
//  - clickable Size label button that opens the per-model resolutions editor modal
//  - a Custom Size text input below the select for ad-hoc WxH that bypasses
//    the saved list (writes directly to w.config.imgSize)
// `proto` is the image protocol ('gpt' or 'modelscope'); used to seed the
// editor modal with the right built-in defaults.
function pgImgParamSelectWithEdit(key, proto, modelId, cfg, builtinOpts) {
  var sizeOpts = pgImgSizeOptionsFor(proto, modelId, builtinOpts);
  var sel = pgEscapeHtml(pgT('pgImgSize'));
  var arr = [{value: '', label: pgT('pgImgSizeDefault')}];
  for (var i = 0; i < sizeOpts.length; i++) arr.push(sizeOpts[i]);
  // Sentinel '__custom' — selecting it reveals the custom input without
  // disturbing any saved list entry the user may have picked before.
  arr.push({value: '__custom', label: pgT('pgImgCustomSize') + '...'});
  var wrapId = 'pg-selwrap-size-' + proto;
  var selId = 'pg-sel-size-' + proto;
  var labelBtn = '<button type="button" class="pg-param-label-btn" onclick="pgOpenImgSizesModal()" data-tooltip="' + pgEscapeAttr(pgT('pgImgEditSizesTitle')) + '">' + sel + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.65;margin-left:3px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>';
  var html = '<div class="pg-param-row">' +
    labelBtn +
    pgRenderCustomSelect(wrapId, selId, arr, cfg[key] || '', 'pgOnImgSizeSelect(this.value)', 'flex:1;min-width:0') +
  '</div>';
  var isCustom = cfg[key] && cfg[key] !== '__custom' && !pgImgListContains(sizeOpts, cfg[key]);
  var showCustom = (cfg[key] === '__custom') || isCustom;
  html += '<div class="pg-param-row pg-img-custom-row"' + (showCustom ? '' : ' style="display:none"') + '>' +
    '<label>' + pgEscapeHtml(pgT('pgImgCustomSize')) + '</label>' +
    '<input type="text" value="' + pgEscapeAttr(isCustom ? cfg[key] : '') + '" placeholder="' + pgEscapeAttr(pgT('pgImgCustomSizePlaceholder')) + '" oninput="pgOnParam(\'' + key + '\', this.value)" style="flex:1">' +
  '</div>';
  return html;
}

function pgImgListContains(opts, val) {
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].value === val) return true;
  }
  return false;
}

function pgRenderImageParams(cfg, proto) {
  var html = '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgImageParams')) + '</div>';
  if (proto === 'gpt') {
    html += pgImgParamSelectWithEdit('imgSize', 'gpt', cfg.model, cfg, [
      {value: '', label: pgT('pgImgSizeDefault')},
      {value: 'auto', label: 'auto'},
      {value: '1:1', label: '1:1'},
      {value: '16:9', label: '16:9'},
      {value: '9:16', label: '9:16'},
      {value: '3:1', label: '3:1'},
      {value: '1024x1024', label: '1024x1024 (1:1)'},
      {value: '1200x675', label: '1200x675 (16:9)'},
      {value: '928x1664', label: '928x1664 (9:16)'},
      {value: '3000x1000', label: '3000x1000 (3:1)'},
    ]);
    html += pgImgParamSelect('imgQuality', 'pgImgQuality', cfg.imgQuality || '', [
      {value: '', label: pgT('pgImgQualityStandard')},
      {value: 'auto', label: pgT('pgImgQualityAuto')},
      {value: 'low', label: pgT('pgImgQualityLow')},
      {value: 'medium', label: pgT('pgImgQualityMedium')},
      {value: 'high', label: pgT('pgImgQualityHigh')},
    ]);
    html += pgImgParamSelect('imgBackground', 'pgImgBackground', cfg.imgBackground || '', [
      {value: '', label: pgT('pgImgBackgroundOpaque')},
      {value: 'transparent', label: pgT('pgImgBackgroundTransparent')},
    ]);
    html += pgImgParamSelect('imgModeration', 'pgImgModeration', cfg.imgModeration || '', [
      {value: '', label: pgT('pgImgModerationAuto')},
      {value: 'low', label: pgT('pgImgModerationLow')},
    ]);
    // n constrained 1..5 for GPT
    html += pgImgParamNumber('imgN', 'pgImgN', cfg.imgN || 1, 1, 5, 1);
    // response_format
    html += pgImgParamSelect('imgResponseFormat', 'pgImgResponseFormat', cfg.imgResponseFormat || '', [
      {value: '', label: pgT('pgImgResponseFormatUrl')},
      {value: 'b64_json', label: pgT('pgImgResponseFormatB64')},
    ]);
    // output_format
    html += pgImgParamSelect('imgOutputFormat', 'pgImgOutputFormat', cfg.imgOutputFormat || '', [
      {value: '', label: pgT('pgImgQualityStandard')},
      {value: 'png', label: pgT('pgImgOutputFormatPng')},
      {value: 'jpeg', label: pgT('pgImgOutputFormatJpeg')},
      {value: 'webp', label: pgT('pgImgOutputFormatWebp')},
    ]);
    // output_compression (shown only when output_format is set)
    html += '<div class="pg-param-row pg-img-output-compression-row"' + (cfg.imgOutputFormat && cfg.imgOutputFormat !== 'png' ? '' : ' style="display:none"') + '>' +
      '<label>' + pgEscapeHtml(pgT('pgImgOutputCompression')) + '</label>' +
      '<div class="number-stepper" style="flex:1;min-width:0">' +
        '<button type="button" class="stepper-btn stepper-minus" onclick="pgStepParam(\'imgOutputCompression\', -1, 0, 100, false)">-</button>' +
        '<input type="number" class="stepper-input" min="0" max="100" step="1" value="' + (cfg.imgOutputCompression || 0) + '" onchange="pgOnParam(\'imgOutputCompression\', parseInt(this.value,10)||0)">' +
        '<button type="button" class="stepper-btn stepper-plus" onclick="pgStepParam(\'imgOutputCompression\', 1, 0, 100, false)">+</button>' +
      '</div>' +
    '</div>';
    // user
    html += '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('pgImgUser')) + '</label>' +
      '<input type="text" value="' + pgEscapeAttr(cfg.imgUser || '') + '" oninput="pgOnParam(\'imgUser\', this.value)" style="flex:1">' +
    '</div>';
  } else if (proto === 'xai') {
    html += pgImgParamSelect('imgAspectRatio', 'pgImgAspectRatio', cfg.imgAspectRatio || '1:1', [
      {value: '1:1', label: '1:1'},
      {value: '3:2', label: '3:2'},
      {value: '4:3', label: '4:3'},
      {value: '16:9', label: '16:9'},
      {value: '21:9', label: '21:9'},
      {value: '9:16', label: '9:16'},
      {value: '2:3', label: '2:3'},
      {value: '3:4', label: '3:4'},
      {value: '2:1', label: '2:1'},
      {value: '1:2', label: '1:2'},
    ]);
    html += pgImgParamSelect('imgResolution', 'pgImgResolution', cfg.imgResolution || '2k', [
      {value: '1k', label: '1k'},
      {value: '2k', label: '2k'},
      {value: '4k', label: '4k'},
      {value: '8k', label: '8k'},
    ]);
    html += pgImgParamNumber('imgN', 'pgImgN', cfg.imgN || 1, 1, 10, 1);
  } else if (proto === 'modelscope') {
    html += pgImgParamSelectWithEdit('imgSize', 'modelscope', cfg.model, cfg, [
      {value: '1024x1024', label: '1024x1024'},
      {value: '1280x720', label: '1280x720'},
      {value: '720x1280', label: '720x1280'},
      {value: '1024x768', label: '1024x768'},
      {value: '768x1024', label: '768x1024'},
    ]);
    html += '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('pgImgNegativePrompt')) + '</label><input type="text" value="' + pgEscapeAttr(cfg.imgNegativePrompt || '') + '" oninput="pgOnParam(\'imgNegativePrompt\', this.value)" style="flex:1"></div>';
    html += pgImgParamNumber('imgSteps', 'pgImgSteps', cfg.imgSteps || 0, 0, 100, 1, false);
    html += pgImgParamNumber('imgGuidance', 'pgImgGuidance', cfg.imgGuidance || 0, 0, 20, 0.5, true);
    html += pgImgParamNumber('imgSeed', 'pgImgSeed', cfg.imgSeed || 0, 0, 999999, 1, false);
  } else if (proto === 'sensenova') {
    var mName = (cfg.model || '').toLowerCase();
    var isFast = mName.indexOf('fast') !== -1;
    var snSizes = isFast ? [
      {value: '2752x1536', label: '2752×1536 (16:9 默认)'},
      {value: '2048x2048', label: '2048×2048 (1:1)'},
      {value: '1536x2752', label: '1536×2752 (9:16)'},
      {value: '2496x1664', label: '2496×1664 (3:2)'},
      {value: '1664x2496', label: '1664×2496 (2:3)'},
      {value: '2368x1760', label: '2368×1760 (4:3)'},
      {value: '1760x2368', label: '1760×2368 (3:4)'},
      {value: '2272x1824', label: '2272×1824 (5:4)'},
      {value: '1824x2272', label: '1824×2272 (4:5)'},
      {value: '3072x1376', label: '3072×1376 (21:9)'},
      {value: '1344x3136', label: '1344×3136 (9:21)'},
    ] : [
      {value: 'auto', label: 'auto'},
      {value: '2048x2048', label: '2048×2048 (1:1 2K)'},
      {value: '2720x1536', label: '2720×1536 (16:9 2K)'},
      {value: '1536x2720', label: '1536×2720 (9:16 2K)'},
      {value: '1664x2496', label: '1664×2496 (2:3 2K)'},
      {value: '2496x1664', label: '2496×1664 (3:2 2K)'},
      {value: '4096x4096', label: '4096×4096 (1:1 4K)'},
    ];
    html += pgImgParamSelectWithEdit('imgSize', 'sensenova', cfg.model, cfg, snSizes);
    html += pgImgParamSelect('imgOutputFormat', 'pgImgOutputFormat', cfg.imgOutputFormat || '', [
      {value: '', label: pgT('pgImgSizeDefault')},
      {value: 'png', label: pgT('pgImgOutputFormatPng')},
      {value: 'jpeg', label: pgT('pgImgOutputFormatJpeg')},
      {value: 'webp', label: pgT('pgImgOutputFormatWebp')},
    ]);
    html += pgImgParamSelect('imgResponseFormat', 'pgImgResponseFormat', cfg.imgResponseFormat || '', [
      {value: '', label: pgT('pgImgResponseFormatB64')},
      {value: 'url', label: pgT('pgImgResponseFormatUrl')},
    ]);
    html += pgImgParamSelect('snWatermark', 'pgSnWatermark', cfg.snWatermark || '', [
      {value: '', label: pgT('pgSnWatermarkOn')},
      {value: 'false', label: pgT('pgSnWatermarkOff')},
    ]);
    html += pgImgParamSelect('snPromptExtend', 'pgSnPromptExtend', cfg.snPromptExtend || '', [
      {value: '', label: pgT('pgSnPromptExtendOn')},
      {value: 'false', label: pgT('pgSnPromptExtendOff')},
    ]);
  }
  html += '</div>';
  return html;
}

function pgRenderImageBlock(customMode) {
  var w = pgWin();
  if (!w) return '';
  var cfg = w.config;
  var en = cfg.imageEnabled && !customMode;
  var urls = cfg.imageUrls || [];
  var hintKey;
  if (customMode) hintKey = 'pgImageCustomDisabled';
  else if (!en) hintKey = 'pgImageHint';
  else if (urls.length === 0) hintKey = 'pgImageHintEmpty';
  else hintKey = 'pgImageCount';
  var hintText = pgT(hintKey, [urls.length]);
  var rows = '';
  if (en) {
    urls.forEach(function(u, i) {
      rows += '<div class="pg-image-row-input">' +
        '<input type="text" value="' + pgEscapeHtml(u || '') + '" oninput="pgOnImageUrl(' + i + ', this.value)" placeholder="https://example.com/image' + (i + 1) + '.jpg">' +
        '<button class="pg-image-rem" onclick="pgRemoveImageUrl(' + i + ')" data-tooltip="×">✕</button>' +
      '</div>';
    });
  }
  return '<div class="pg-image-block' + (en ? '' : ' disabled') + '">' +
    '<div class="pg-switch"><input type="checkbox" id="pg-imgenable" ' + (cfg.imageEnabled ? 'checked' : '') + ' onchange="pgOnParam(\'imageEnabled\', this.checked); pgRenderSidebar()"' + (customMode ? ' disabled' : '') + '><label for="pg-imgenable">' + pgEscapeHtml(pgT('pgImageEnable')) + '</label>' +
      '<button class="pg-image-add" onclick="pgAddImageUrl()" ' + (en ? '' : 'disabled') + ' data-tooltip="' + pgEscapeHtml(pgT('pgImageAdd')) + '">+</button>' +
    '</div>' +
    (rows || '') +
    '<div class="pg-image-hint">' + pgEscapeHtml(hintText) + '</div>' +
  '</div>';
}

function pgAddImageUrl() {
  var w = pgWin();
  if (!w || !w.config.imageEnabled) return;
  w.config.imageUrls.push('');
  pgSave();
  pgRenderSidebar();
}
function pgRemoveImageUrl(i) {
  var w = pgWin();
  if (!w) return;
  w.config.imageUrls.splice(i, 1);
  pgSave();
  pgRenderSidebar();
}
function pgOnImageUrl(i, v) {
  var w = pgWin();
  if (!w) return;
  w.config.imageUrls[i] = v;
  pgSave();
}

function pgRenderDebug() {
  var w = pgWin();
  if (!w) return;
  var side = document.getElementById('pg-side');
  if (side) {
    var meta = side.querySelector('.pg-debug-meta');
    if (meta) {
      meta.innerHTML =
        '<span>' + pgEscapeHtml(pgT('pgRespProvider').replace('{0}', w.lastProvider || pgT('pgNoProvider'))) + '</span>' +
        '<span>' + pgEscapeHtml(pgT('pgRespKey').replace('{0}', w.lastKey || pgT('pgNoProvider'))) + '</span>' +
        '<span>' + (w.streaming ? '🔴 ' + pgT('pgStreaming') : '🟢 ' + pgT('pgIdle')) + '</span>';
    }
  }
  pgRenderDebugContent();
  var respTab = document.querySelector('.pg-tab[data-tab="response"]');
  if (respTab) {
    var badge = respTab.querySelector('.pg-tab-badge');
    var count = w.sseEvents.length;
    if (count > 0) {
      if (badge) { badge.textContent = 'SSE ' + count; }
      else { var span = document.createElement('span'); span.className = 'pg-tab-badge'; span.textContent = 'SSE ' + count; respTab.appendChild(span); }
    } else {
      if (badge) badge.remove();
    }
  }
}

// ----- Recent requests left panel (normal mode, single window) --------
var pgReqLeftTimer = null;
var pgReqLeftSSE = null;
var pgReqLeftProcTimer = null;
var pgReqLeftInflight = {};  // id → entry, for processing entries from SSE

function pgRenderReqLeft(showReqLeft) {
  var container = document.getElementById('pg-req-left');
  if (!container) return;
  if (!showReqLeft) {
    container.innerHTML = '';
    pgStopReqLeftPolling();
    return;
  }
  container.innerHTML =
    '<div class="pg-req-left-inner">' +
      '<div class="pg-req-left-header">' + pgEscapeHtml(pgT('pgReqLeftTitle')) + '</div>' +
      '<div class="pg-req-table-wrap" id="pg-req-left-content"></div>' +
    '</div>';
  pgStartReqLeftPolling();
}

function pgStartReqLeftPolling() {
  pgStopReqLeftPolling();
  pgFetchReqLeft();
  pgReqLeftTimer = setInterval(pgFetchReqLeft, 10000);
  // SSE for real-time request-start/done events
  try {
    pgReqLeftSSE = new EventSource('/api/monitor/events');
    pgReqLeftSSE.onmessage = function(ev) {
      try {
        var data = JSON.parse(ev.data);
        if (data.type === 'request-start' && data.entry) {
          var e = data.entry;
          if (e.source === 'playground') {
            pgReqLeftInflight[e.id] = e;
            pgReqLeftMergeEntry(e);
            pgReqLeftRender();
            pgReqLeftEnsureProcTimer();
          }
        } else if (data.type === 'request-done' && data.id) {
          var inflight = pgReqLeftInflight[data.id];
          if (inflight) {
            delete pgReqLeftInflight[data.id];
          }
          // 仅 merge Playground 来源的完成条目，避免 Recent Requests 的请求漏入
          if (data.entry && data.entry.source === 'playground') {
            pgReqLeftMergeEntry(data.entry);
          }
          pgReqLeftRender();
          if (!pgReqLeftHasProcessing()) pgReqLeftStopProcTimer();
        }
      } catch (ex) {}
    };
  } catch (e) {}
}

function pgStopReqLeftPolling() {
  if (pgReqLeftTimer) {
    clearInterval(pgReqLeftTimer);
    pgReqLeftTimer = null;
  }
  if (pgReqLeftSSE) {
    try { pgReqLeftSSE.close(); } catch (e) {}
    pgReqLeftSSE = null;
  }
  pgReqLeftStopProcTimer();
  pgReqLeftInflight = {};
}

function pgReqLeftHasProcessing() {
  return Object.keys(pgReqLeftInflight).length > 0;
}

function pgReqLeftEnsureProcTimer() {
  if (pgReqLeftProcTimer) return;
  pgReqLeftProcTimer = setInterval(function() {
    if (pgReqLeftHasProcessing()) {
      pgReqLeftRender();
    } else {
      pgReqLeftStopProcTimer();
    }
  }, 500);
}

function pgReqLeftStopProcTimer() {
  if (pgReqLeftProcTimer) {
    clearInterval(pgReqLeftProcTimer);
    pgReqLeftProcTimer = null;
  }
}

// Merge an entry into pgReqLeftEntries (replace if same id, else prepend)
function pgReqLeftMergeEntry(e) {
  if (!e || !e.id) return;
  var found = -1;
  for (var j = 0; j < pgReqLeftEntries.length; j++) {
    if (pgReqLeftEntries[j].id === e.id) { found = j; break; }
  }
  if (found >= 0) {
    pgReqLeftEntries[found] = e;
  } else {
    pgReqLeftEntries.unshift(e);
  }
  // Keep list bounded
  if (pgReqLeftEntries.length > 50) pgReqLeftEntries = pgReqLeftEntries.slice(0, 50);
}

// Render the table from pgReqLeftEntries (no data fetch)
function pgReqLeftRender() {
  var container = document.getElementById('pg-req-left-content');
  if (!container) return;
  var entries = pgReqLeftEntries;
  if (!entries.length) {
    container.innerHTML = '<div class="pg-req-empty">' + pgEscapeHtml(pgT('pgReqEmpty')) + '</div>';
    return;
  }
  // Sort by timestamp descending
  entries = entries.slice().sort(function(a, b) {
    var ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    var tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });
  pgReqLeftEntries = entries;
  var html = '<table class="pg-req-table"><thead><tr>' +
    '<th class="pg-req-status-col"></th>' +
    '<th>' + pgEscapeHtml(pgT('pgReqColTime')) + '</th>' +
    '<th>' + pgEscapeHtml(pgT('pgReqColLatency')) + '</th>' +
    '<th>' + pgEscapeHtml(pgT('pgReqColTokens')) + '</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var dotCls = 'pg-req-dot';
    if (e.status === 'success') dotCls += ' pg-req-dot-success';
    else if (e.status === 'error') dotCls += ' pg-req-dot-error';
    else if (e.status === 'retry') dotCls += ' pg-req-dot-retry';
    else dotCls += ' pg-req-dot-processing';
    var timeStr = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '—';
    var latStr;
    if (e.status === 'processing') {
      latStr = e.timestamp ? ((Date.now() - new Date(e.timestamp).getTime()) / 1000).toFixed(1) + 's' : '—';
    } else {
      latStr = e.latencyMs ? (e.latencyMs / 1000).toFixed(1) + 's' : '—';
    }
    var tokStr = (e.status === 'processing') ? '—' : ((e.inputTokens || 0) + '/' + (e.outputTokens || 0));
    html += '<tr style="cursor:pointer" onclick="pgShowReqDetail(' + i + ')">' +
      '<td class="pg-req-status-col"><span class="' + dotCls + '"></span></td>' +
      '<td>' + pgEscapeHtml(timeStr) + '</td>' +
      '<td>' + pgEscapeHtml(latStr) + '</td>' +
      '<td>' + pgEscapeHtml(tokStr) + '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function pgFetchReqLeft() {
  // 使用 Playground 专用端点，数据源已物理隔离（仅含 playground 来源）
  pgApiGet('/monitor/playground?limit=50').then(function(res) {
    var entries = (res && res.entries) || [];
    // 双保险：仍过滤一次，防止未来数据源变更引入污染
    entries = entries.filter(function(e) { return e.source === 'playground'; });
    var seenIds = {};
    entries.forEach(function(e) { seenIds[e.id] = true; });
    for (var id in pgReqLeftInflight) {
      if (!seenIds[id]) {
        entries.unshift(pgReqLeftInflight[id]);
      }
    }
    pgReqLeftEntries = entries;
    pgReqLeftRender();
    if (pgReqLeftHasProcessing()) pgReqLeftEnsureProcTimer();
  }).catch(function() {});
}

function pgRenderReqLeftContent(data) {
  var entries = (data && data.entries) || [];
  entries = entries.filter(function(e) { return e.source === 'playground'; });
  pgReqLeftEntries = entries;
  pgReqLeftRender();
}

var pgReqLeftEntries = [];

async function pgShowReqDetail(idx) {
  var e = pgReqLeftEntries[idx];
  if (!e) return;
  if (e.id) {
    try {
      var full = await pgApiGet('/monitor/entry/' + encodeURIComponent(e.id));
      if (full) e = full;
    } catch(ex) {}
  }
  var overlay = document.getElementById('info-modal-overlay');
  if (!overlay) return;
  var titleEl = document.getElementById('info-modal-title');
  var bodyEl = document.getElementById('info-modal-body');
  if (!titleEl || !bodyEl) return;

  titleEl.textContent = (e.provider || '?') + ' / ' + (e.model || '?') + ' \u2014 ' + (e.status || 'unknown') + ' (' + formatLatency(e.latencyMs || 0) + ')';

  bodyEl.classList.remove('info-modal-monitor');
  __infoModalSections = [];
  __rawFieldMap = {};
  var html = '';

  var summaryData = {};
  if (e.id) summaryData['ID'] = e.id;
  if (e.timestamp) summaryData['Timestamp'] = e.timestamp;
  if (e.provider) summaryData['Provider'] = e.provider;
  if (e.model) summaryData['Model'] = e.model;
  if (e.keyName) summaryData['Key'] = e.keyName;
  if (e.status) summaryData['Status'] = e.status;
  if (e.latencyMs !== undefined && e.latencyMs !== null) summaryData['Latency'] = formatLatency(e.latencyMs);
  if (e.ttftMs) summaryData['TTFT'] = e.ttftMs + 'ms';
  if (e.inputTokens) summaryData['Input Tokens'] = e.inputTokens;
  if (e.outputTokens) summaryData['Output Tokens'] = e.outputTokens;
  if (e.error) summaryData['Error'] = e.error;
  if (e.upstreamUrl) summaryData['Upstream URL'] = e.upstreamUrl;
  if (e.respStatus) summaryData['Response Status'] = e.respStatus;
  if (Object.keys(summaryData).length > 0) {
    html += renderInfoSection('Request Info', summaryData);
  }
  if (e.reqPayload) {
    html += renderInfoSection('Request', e.reqPayload);
  }
  if (e.reqHeaders) {
    html += renderInfoSection('Request Headers', e.reqHeaders);
  }
  if (e.respHeaders) {
    html += renderInfoSection('Response Headers', e.respHeaders);
  }
  if (e.respPayload) {
    html += renderInfoSection('Response Body', e.respPayload);
  }

  bodyEl.innerHTML = html || '<div class="info-section">' + t('noData') + '</div>';
  postProcessRawFields();

  overlay.classList.add('show');
  bodyEl.setAttribute('tabindex', '-1');
  bodyEl.focus();
}

// ----- Input bar (send/stop + clear + maximize) -----------------------
function pgToggleInputMaximize() {
  pgState.inputMaximized = !pgState.inputMaximized;
  pgSyncInputMaximizedState();
}

function pgSyncInputMaximizedState() {
  var isMax = !!pgState.inputMaximized;
  var panesEl = document.getElementById('pg-panes');
  var wrapperEl = document.getElementById('pg-max-editor-wrapper');
  var ta = document.getElementById('pg-input');

  if (isMax) {
    if (panesEl) panesEl.style.display = 'none';
    if (wrapperEl) {
      wrapperEl.style.display = 'flex';
      var currentVal = ta ? ta.value : '';
      wrapperEl.innerHTML =
        '<div class="pg-max-editor-header">' +
          '<span class="pg-max-editor-title">' + pgEscapeHtml(pgT('pgMaxEditorTitle')) + '</span>' +
          '<button type="button" class="pg-max-editor-restore-btn" onclick="pgToggleInputMaximize()">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>' +
            '<span>' + pgEscapeHtml(pgT('pgRestoreDefaultView')) + '</span>' +
          '</button>' +
        '</div>' +
        '<textarea class="pg-max-editor-textarea" id="pg-max-editor-textarea" placeholder="' + pgEscapeHtml(pgState.mode === 'image' ? pgT('pgImagePromptPlaceholder') : (pgState.mode === 'search' ? pgT('pgSearchPlaceholder') : pgT('pgEnterMessage'))) + '">' + pgEscapeHtml(currentVal) + '</textarea>';

      var maxTa = document.getElementById('pg-max-editor-textarea');
      if (maxTa) {
        maxTa.focus();
        maxTa.selectionStart = maxTa.selectionEnd = maxTa.value.length;
        maxTa.addEventListener('input', function() {
          if (ta) ta.value = maxTa.value;
        });
        maxTa.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            pgUserSend();
          }
        });
      }
    }
  } else {
    if (panesEl) panesEl.style.display = '';
    if (wrapperEl) wrapperEl.style.display = 'none';
    if (ta) ta.focus();
  }

  var expandBtn = document.getElementById('pg-input-expand-btn');
  if (expandBtn) {
    var expandTooltip = isMax ? pgT('pgRestoreInput') : pgT('pgMaximizeInput');
    expandBtn.setAttribute('data-tooltip', expandTooltip);
    expandBtn.setAttribute('aria-label', expandTooltip);
    expandBtn.classList.toggle('active', isMax);
    expandBtn.innerHTML = isMax
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  }
}

function pgRenderInputBar() {
  var bar = document.getElementById('pg-inputbar');
  if (!bar) return;
  var existingTa = document.getElementById('pg-input');
  var w = pgWin();
  var savedVal = existingTa ? existingTa.value : (w && w.config && w.config.prompt ? w.config.prompt : '');

  var imageGenerating = pgState.mode === 'image' && w && w.image && w.image.phase === 'generating';
  var sendBtn = '';
  if (imageGenerating) {
    sendBtn = '<button class="pg-send stop" onclick="pgImageStop(pgState.activeWin)">' + pgEscapeHtml(pgT('pgStop')) + '</button>';
  } else if (pgIsGenerating() && !(pgState.autoChat.enabled && pgState.autoChat.isRunning)) {
    sendBtn = '<button class="pg-send stop" onclick="pgStop()">' + pgEscapeHtml(pgT('pgStop')) + '</button>';
  } else {
    var sendLabel = pgState.mode === 'image' ? pgT('pgGenerate') : (pgState.mode === 'search' ? pgT('pgSearchButton') : pgT('pgSendMessage'));
    sendBtn = '<button class="pg-send" onclick="pgUserSend()" ' + (!pgAnyWindowHasModel() ? 'disabled' : '') + '>' + pgEscapeHtml(sendLabel) + '</button>';
  }
  var isMax = !!pgState.inputMaximized;
  var expandTooltip = isMax ? pgT('pgRestoreInput') : pgT('pgMaximizeInput');
  var expandBtnHtml = '<button type="button" class="pg-input-expand-btn' + (isMax ? ' active' : '') + '" id="pg-input-expand-btn" onclick="pgToggleInputMaximize()" data-tooltip="' + pgEscapeHtml(expandTooltip) + '" aria-label="' + pgEscapeHtml(expandTooltip) + '">'
    + (isMax
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>')
    + '</button>';

  var infinitySvgHtml =
    '<div class="pg-infinity-loader" id="pg-main-input-loader">' +
      '<svg preserveAspectRatio="xMidYMid meet" viewBox="0 0 187.3 93.7" style="width:140px;height:70px">' +
        '<path d="M93.9,46.4c9.3,9.5,13.8,17.9,23.5,17.9s17.5-7.8,17.5-17.5s-7.8-17.6-17.5-17.5c-9.7,0.1-13.3,7.2-22.1,17.1 c-8.9,8.8-15.7,17.9-25.4,17.9s-17.5-7.8-17.5-17.5s7.8-17.5,17.5-17.5S86.2,38.6,93.9,46.4z" stroke-miterlimit="10" stroke-linejoin="round" stroke-linecap="round" stroke-width="5" fill="none" id="outline" stroke="var(--accent, #10b981)"></path>' +
        '<path d="M93.9,46.4c9.3,9.5,13.8,17.9,23.5,17.9s17.5-7.8,17.5-17.5s-7.8-17.6-17.5-17.5c-9.7,0.1-13.3,7.2-22.1,17.1 c-8.9,8.8-15.7,17.9-25.4,17.9s-17.5-7.8-17.5-17.5s7.8-17.5,17.5-17.5S86.2,38.6,93.9,46.4z" stroke-miterlimit="10" stroke-linejoin="round" stroke-linecap="round" stroke-width="5" stroke="var(--accent, #10b981)" fill="none" opacity="0.15" id="outline-bg"></path>' +
      '</svg>' +
    '</div>';

  var wandSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 4 2 2M18 13l-1.5-1.5M10.5 4.5 9 3M19 8l2-2M2 22l10-10"/><path d="M12 2v2M12 8v2M8 4.5l-1.5-1.5M14.5 4.5l1.5-1.5"/></svg>';
  var attachSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

  bar.innerHTML =
    '<div class="pg-input-card' + (isMax ? ' pg-input-card-maximized' : '') + '">' +
      '<div class="pg-input-thumbs" id="pg-input-thumbs"></div>' +
      '<textarea class="pg-input" id="pg-input"' + (imageGenerating ? ' readonly' : '') + ' placeholder="' + pgEscapeHtml(pgState.mode === 'image' ? pgT('pgImagePromptPlaceholder') : (pgState.mode === 'search' ? pgT('pgSearchPlaceholder') : pgT('pgEnterMessage'))) + '" onkeydown="pgOnInputKey(event)"></textarea>' +
      expandBtnHtml +
      infinitySvgHtml +
      '<input type="file" id="pg-file-input" accept="image/*,video/*,audio/*,application/pdf" multiple style="display:none" onchange="if(this.files){pgHandleFiles(this.files); this.value=\'\';}">' +
    '</div>' +
    '<div class="pg-input-actions">' +
      sendBtn +
      '<div class="pg-btn-row">' +
        '<button type="button" class="pg-btn pg-btn-attach" onclick="document.getElementById(\'pg-file-input\').click()" data-tooltip="Upload / Attach (Image, Video, Audio, PDF)">' + attachSvg + '</button>' +
        (pgState.autoChat.enabled && pgState.autoChat.isRunning
          ? '<button class="pg-btn danger" onclick="pgAutoChatStop()" data-tooltip="' + pgEscapeHtml(pgT('pgAutoChatStop')) + '">' + pgEscapeHtml(pgT('pgAutoChatStop')) + '</button>'
          : '') +
        (pgState.mode === 'image'
          ? '<button class="pg-btn pg-btn-wand" onclick="pgImageInspireQuick()" data-tooltip="一键提示词灵感生成">' + wandSvg + '</button><button class="pg-btn pg-btn-inspire" onclick="pgOpenImageInspire()">' + pgEscapeHtml(pgT('pgInspire')) + '</button>'
          : '<button class="pg-btn danger" onclick="pgClear()">' + pgEscapeHtml(pgT('pgClear')) + '</button>') +
      '</div>' +
    '</div>';

  var ta = document.getElementById('pg-input');
  if (ta) {
    if (savedVal) ta.value = savedVal;
    ta.addEventListener('paste', pgPasteImage);
    ta.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); });
    ta.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        pgHandleFiles(e.dataTransfer.files);
      }
    });
    ta.addEventListener('input', function() {
      var w2 = pgWin();
      if (w2 && w2.config) w2.config.prompt = ta.value;
      var maxTa = document.getElementById('pg-max-editor-textarea');
      if (maxTa && pgState.inputMaximized) maxTa.value = ta.value;
    });
    if (pgState.mode === 'search') {
      var activeSearch = typeof pgActiveSearch === 'function' ? pgActiveSearch() : null;
      if (activeSearch && activeSearch.query) {
        if (!ta.value || ta.value === activeSearch.query) {
          ta.value = activeSearch.query;
          ta.classList.add('pg-input-search-submitted');
        }
      }
      if (pgIsGenerating()) {
        ta.readOnly = true;
        ta.classList.add('pg-input-search-locked');
      }
      ta.addEventListener('input', function() {
        var s2 = typeof pgActiveSearch === 'function' ? pgActiveSearch() : null;
        if (!s2 || ta.value !== s2.query) {
          ta.classList.remove('pg-input-search-submitted');
        }
      });
    }
  }
  pgRenderInputThumbs();
  pgSyncInputMaximizedState();
}
function pgUpdateInputBar() { pgRenderInputBar(); }

function pgEscapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function pgRenderInputThumbs() {
  var container = document.getElementById('pg-input-thumbs');
  if (!container) return;
  var w = pgWin();
  if (!w || !w.config.imageUrls || w.config.imageUrls.length === 0) {
    container.innerHTML = '';
    return;
  }
  var html = '';
  w.config.imageUrls.forEach(function(url, idx) {
    var mediaType = pgGetMediaType(url);
    var previewHtml = '';
    var safeUrl = pgEscapeAttr(url);

    if (mediaType === 'pdf') {
      previewHtml = '<div class="pg-input-thumb pg-input-thumb-file pg-input-thumb-pdf" onclick="pgShowMediaModal(\'' + safeUrl + '\')" data-tooltip="' + pgEscapeHtml(pgT('pgPdfDoc')) + '">' +
        pgGetMediaSvg('pdf', 22) +
        '<span>PDF</span>' +
      '</div>';
    } else if (mediaType === 'video') {
      previewHtml = '<div class="pg-input-thumb pg-input-thumb-file pg-input-thumb-video" onclick="pgShowMediaModal(\'' + safeUrl + '\')" data-tooltip="' + pgEscapeHtml(pgT('pgVideoFile')) + '">' +
        pgGetMediaSvg('video', 22) +
        '<span>VIDEO</span>' +
      '</div>';
    } else if (mediaType === 'audio') {
      previewHtml = '<div class="pg-input-thumb pg-input-thumb-file pg-input-thumb-audio" onclick="pgShowMediaModal(\'' + safeUrl + '\')" data-tooltip="' + pgEscapeHtml(pgT('pgAudioFile')) + '">' +
        pgGetMediaSvg('audio', 22) +
        '<span>AUDIO</span>' +
      '</div>';
    } else {
      previewHtml = '<img class="pg-input-thumb" src="' + pgEscapeHtml(url) + '" alt="media" onclick="pgShowMediaModal(\'' + safeUrl + '\')">';
    }

    html += '<div class="pg-input-thumb-wrap">' +
      previewHtml +
      '<button class="pg-input-thumb-del" onclick="event.stopPropagation();pgRemoveInputImage(' + idx + ')" data-tooltip="' + pgEscapeHtml(pgT('pgDelete')) + '">✕</button>' +
    '</div>';
  });
  container.innerHTML = html;
}

function pgRemoveInputImage(idx) {
  var w = pgWin();
  if (!w || !w.config.imageUrls) return;
  w.config.imageUrls.splice(idx, 1);
  pgSave();
  pgRenderInputThumbs();
  pgRenderSidebar();
}

// ----- Event handlers ----------------------------------------------
function pgOnImagePromptModel(v) { var w = pgWin(); if (!w) return; w.config.imgPromptModel = v || ''; pgSave(); pgRenderSidebar(); }
function pgApplyActiveQuickSlot(model) {
  if (!model) return;
  if (pgState.mode !== 'normal' && pgState.mode !== 'search') return;
  var w = pgWin(); if (!w) return;
  w.config.model = model;
  pgSave();
  pgRenderSidebar();
  pgRenderPanes();
  pgUpdateInputBar();
}
function pgOnModelChange(v) { var w = pgWin(); if (w) { w.config.model = v; if (typeof qsClearActive === 'function') qsClearActive(); pgSave(); pgRenderSidebar(); pgRenderPanes(); pgUpdateInputBar(); } }

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
  pgRenderSidebar();
}
function pgStepImageSubmitCount(delta) {
  var cur = pgGetImageSubmitCount();
  pgOnImageSubmitCount(cur + delta);
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

// ----- Load fixup: finalize orphaned streaming assistants. ----------
function pgNormalizeLoadedMessage(msg) {
  if (!msg) return msg;
  if (typeof msg.role !== 'string') msg.role = 'assistant';
  if (msg.content === undefined) msg.content = '';
  if (msg.status === undefined) msg.status = 'complete';
  if (msg.role === 'assistant' && (msg.status === 'streaming' || msg.status === 'loading')) {
    var hasContent = pgTextContent(msg.content).trim() || (msg.reasoning && msg.reasoning.trim());
    if (hasContent) {
      msg.status = 'complete';
      if (!msg.completedAt) {
        msg.completedAt = msg.reasoningCompletedAt || msg.startedAt || Date.now();
      }
      if (msg.startedAt && !msg.durationMs) {
        msg.durationMs = msg.completedAt - msg.startedAt;
      }
    }
  }
  return msg;
}

// ----- Global Shortcuts System -----
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