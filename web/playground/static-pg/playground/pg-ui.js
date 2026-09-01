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

function pgEditPromptForError(i, idx) {
  if (pgIsGenerating()) return;
  var prevUser = pgPrevUserBefore(i, idx);
  if (prevUser < 0) { pgToast(pgT('pgNoPrevUser'), 'warning'); return; }
  pgBeginEdit(i, prevUser);
}

// ----- Append to note ------------------------------------------------
function pgAppendNote(content) {
  if (!content || !String(content).trim()) { pgToast(pgT('pgNothingToAppend'), 'warning'); return Promise.resolve(); }
  return (typeof apiPost === 'function' ? apiPost : pgApiPost)('/notes/append', { content: content }).then(function(res) {
    if (res && res.error) throw new Error(res.error);
    var name = (res && res.fileId) || 'NOTE.md';
    pgToast(pgT('pgAppended', [name]), 'success');
    return res;
  }).catch(function(err) {
    pgToast((err && err.message) || String(err), 'error');
    throw err;
  });
}
function pgAppendSingle(i, idx) {
  // Backward compat: old thinking-block called pgAppendSingle which previously
  // concatenated user+assistant+reasoning. Now it means reasoning-only.
  pgAppendReasoning(i, idx);
}
function pgAppendReasoning(i, idx) {
  var w = pgWinAt(i);
  if (!w || !w.messages || !w.messages[idx]) return;
  var msg = w.messages[idx];
  var rt = (msg.reasoning || '').trim();
  if (!rt) { pgToast(pgT('pgNothingToAppend'), 'warning'); return; }
  pgAppendNote(rt);
}
function pgAppendUser(i, idx) {
  var w = pgWinAt(i);
  if (!w || !w.messages || !w.messages[idx]) return;
  var txt = pgTextContent(w.messages[idx].content).trim();
  if (!txt) { pgToast(pgT('pgNothingToAppend'), 'warning'); return; }
  pgAppendNote(txt);
}
function pgAppendAssistant(i, idx) {
  var w = pgWinAt(i);
  if (!w || !w.messages || !w.messages[idx]) return;
  var txt = pgTextContent(w.messages[idx].content).trim();
  if (!txt) { pgToast(pgT('pgNothingToAppend'), 'warning'); return; }
  pgAppendNote(txt);
}
function pgAppendSearch(i, idx, kind) {
  var w = pgWinAt(i);
  var msg = w && w.messages ? w.messages[idx] : null;
  if (!msg) { pgToast(pgT('pgNothingToAppend'), 'warning'); return; }
  var content = '';
  if (kind === 'raw') {
    content = (msg.searchRaw || '').trim();
  } else {
    content = pgTextContent(msg.content).trim();
  }
  if (!content) { pgToast(pgT('pgNothingToAppend'), 'warning'); return; }
  pgAppendNote(content);
}
function pgAppendWindow(i) {
  var w = pgWinAt(i);
  if (!w || !w.messages || !w.messages.length) {
    pgToast(pgT('pgNothingToAppend'), 'warning');
    return;
  }
  if (pgState.mode === 'search') {
    var w0 = pgWinAt(0);
    var msgs = (w0 && w0.messages) || w.messages;
    var msg = msgs[msgs.length - 1];
    if (!msg) { pgToast(pgT('pgNothingToAppend'), 'warning'); return; }
    var content = '';
    if (i === 0) {
      content = (msg.searchRaw || '').trim();
    } else {
      content = pgTextContent(msg.content).trim();
    }
    if (!content) { pgToast(pgT('pgNothingToAppend'), 'warning'); return; }
    pgAppendNote(content);
    return;
  }
  var parts = [];
  w.messages.forEach(function(msg) {
    if (!msg || msg.status === 'loading') return;
    var txt = pgTextContent(msg.content).trim();
    if (!txt) return;
    var roleLabel = msg.role === 'user' ? 'User' : (msg.role === 'assistant' ? 'Assistant' : (msg.role === 'system' ? 'System' : msg.role));
    parts.push('### ' + roleLabel + ':\n' + txt);
  });
  if (!parts.length) {
    pgToast(pgT('pgNothingToAppend'), 'warning');
    return;
  }
  pgAppendNote(parts.join('\n\n'));
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
    var win0 = pgWin();
    var proto0 = win0 && typeof pgEffectiveProtocol === 'function' ? pgEffectiveProtocol(win0.config) : null;
    if (!win0) return;
    if (proto0 !== 'comfyui' && !win0.config.model) { pgToast(pgT('pgSelectModel'), 'warning'); return; }
    try {
      if (typeof pgTaskEnqueue === 'function') {
        pgTaskEnqueue(pgState.activeWin, text, { promptFormat: 'natural' });
      }
    } catch (e) {
      pgToast(e.message || pgT('pgError'), 'warning');
    }
    ta.value = '';
    if (win0.image) win0.image.draftPrompt = '';
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
        '<span class="pg-zoom-group" onclick="event.stopPropagation()" role="group" aria-label="Text size">' +
          '<button class="pg-pane-btn pg-zoom-btn" onclick="event.stopPropagation(); if(window.pgZoomStep) window.pgZoomStep(-0.1);" data-tooltip="Decrease text size" aria-label="Decrease text size">' + (typeof PG_ICON_ZOOM_OUT !== 'undefined' ? PG_ICON_ZOOM_OUT : '−') + '</button>' +
          '<button class="pg-pane-btn pg-zoom-btn" onclick="event.stopPropagation(); if(window.pgZoomReset) window.pgZoomReset();" data-tooltip="Reset text size" aria-label="Reset text size">' + (typeof PG_ICON_ZOOM_RESET !== 'undefined' ? PG_ICON_ZOOM_RESET : '↺') + '</button>' +
          '<button class="pg-pane-btn pg-zoom-btn" onclick="event.stopPropagation(); if(window.pgZoomStep) window.pgZoomStep(0.1);" data-tooltip="Increase text size" aria-label="Increase text size">' + (typeof PG_ICON_ZOOM_IN !== 'undefined' ? PG_ICON_ZOOM_IN : '+') + '</button>' +
        '</span>' +
        (!isBatchActive ? '<button class="pg-pane-btn" onclick="event.stopPropagation();pgAppendWindow(' + i + ')" data-tooltip="' + pgEscapeHtml(pgT('pgAppendWindow')) + '">' + (typeof PG_ICON_APPEND !== 'undefined' ? PG_ICON_APPEND : '+') + '</button>' : '') +
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
  if (typeof pgRenderTaskQueue === 'function') {
    pgRenderTaskQueue(showReqLeft);
  }
  for (var i2 = 0; i2 < n; i2++) {
    pgRenderMessages(i2);
  }
}

function pgSetMode(mode) {
  if (mode === pgState.mode) return;
  var oldMode = pgState.mode;

  // Cancel any pending debounced save to prevent cross-mode storage bleeding
  if (typeof pgSaveTimer !== 'undefined' && pgSaveTimer) {
    clearTimeout(pgSaveTimer);
    pgSaveTimer = null;
  }

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

  // 1. Save oldMode's windows & splitCount & persist immediately
  if (oldMode) {
    pgState.modeWindows[oldMode] = pgState.windows;
    if (pgState.modeSplitCounts) {
      pgState.modeSplitCounts[oldMode] = pgState.splitCount;
    }
    if (oldMode === 'normal') {
      try {
        var w0Old = pgState.windows[0];
        var trimmedOld = (w0Old && w0Old.messages) || [];
        if (trimmedOld.length > PG_MAX_MSGS) trimmedOld = trimmedOld.slice(-PG_MAX_MSGS);
        localStorage.setItem(PG_MSG_KEY, JSON.stringify(trimmedOld));
      } catch (e) {}
    } else if (oldMode === 'search') {
      if (typeof pgSaveSearchHistory === 'function') pgSaveSearchHistory();
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
    // Fresh mode windows must inherit the persisted config (pgLoad restores it
    // into the startup windows only). Without this, per-mode settings saved in
    // image mode — helper model, inspire presets, submit count, sizes — are
    // lost on every reload because image mode swaps in brand-new windows.
    var seedSrc = pgState.windows[0];
    var seedCfg = seedSrc && seedSrc.config ? JSON.parse(JSON.stringify(seedSrc.config)) : null;
    pgState.windows = [];
    for (var wI = 0; wI < targetSplit; wI++) {
      var seedWin = (typeof makeWin === 'function') ? makeWin() : null;
      if (seedWin && seedCfg) seedWin.config = JSON.parse(JSON.stringify(seedCfg));
      if (mode === 'normal' && wI === 0 && seedWin) {
        try {
          var rawNorm = localStorage.getItem(PG_MSG_KEY);
          if (rawNorm) {
            var parsedNorm = JSON.parse(rawNorm);
            if (Array.isArray(parsedNorm)) seedWin.messages = parsedNorm.map(pgNormalizeLoadedMessage);
          }
        } catch (e) {}
      }
      pgState.windows.push(seedWin);
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
  var concurrencyStepper =
    '<div class="number-stepper pg-img-concurrency-stepper" data-tooltip="' + pgEscapeHtml(pgT('pgImgConcurrency')) + '">' +
      '<button type="button" class="stepper-btn stepper-minus" onclick="pgStepImageConcurrency(-1)" tabindex="-1">-</button>' +
      '<input type="number" class="stepper-input pg-image-concurrency" min="1" max="8" step="1" value="' + pgGetImageConcurrency() + '" onchange="pgOnImageConcurrency(this.value)" aria-label="' + pgEscapeHtml(pgT('pgImgConcurrency')) + '">' +
      '<button type="button" class="stepper-btn stepper-plus" onclick="pgStepImageConcurrency(1)" tabindex="-1">+</button>' +
    '</div>';
  var concurrencyRow = '<div class="pg-param-row" style="margin-top:8px"><label>' + pgEscapeHtml(pgT('pgImgConcurrency')) + '</label>' + concurrencyStepper + '</div>';
  var imageActionsRow = '<div class="pg-image-actions-row" style="margin-top:8px">' + batchEntryHtml + concurrencyRow + '</div>';
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
      '<div class="pg-switch"><label class="toggle-switch"><input type="checkbox" id="pg-stream" ' + (cfg.stream ? 'checked' : '') + ' onchange="pgOnParam(\'stream\', this.checked)"' + (customMode ? ' disabled' : '') + '><span class="toggle-slider"></span></label><span class="pg-switch-label">' + pgEscapeHtml(pgT('pgStream')) + '</span></div>';
  } else {
    params =
      paramRow('temperature', 'pgTemperature', 0, 2, 0.1, false) +
      paramRow('topP', 'pgTopP', 0, 1, 0.05, false) +
      paramRow('frequencyPenalty', 'pgFreqPenalty', -2, 2, 0.1, false) +
      paramRow('presencePenalty', 'pgPresPenalty', -2, 2, 0.1, false) +
      paramRow('maxTokens', 'pgMaxTokens', 0, 1, 1, true) +
      paramRow('thinkingBudget', 'pgThinking', 0, 100000, 100, true) +
      '<div class="pg-param' + (!en.reasoningEffort || customMode ? ' disabled' : '') + '">' +
        '<button class="pg-toggle' + (en.reasoningEffort ? ' on' : '') + '" onclick="pgToggleParam(\'reasoningEffort\')" data-tooltip="' + pgEscapeHtml(pgT('pgParamToggle')) + '">' + (en.reasoningEffort ? '✓' : '✕') + '</button>' +
        '<label data-tooltip="' + pgEscapeAttr(pgT('pgReasoningEffortHint')) + '">' + pgEscapeHtml(pgT('pgReasoningEffort')) + '</label>' +
        pgRenderCustomSelect('pg-reason-wrap', 'pg-reason-sel', [
          { value: 'off', label: pgT('pgReasoningOff') || 'Off' },
          { value: 'minimal', label: pgT('pgThinkingMinimal') || 'Minimal' },
          { value: 'low', label: pgT('pgThinkingLow') || 'Low' },
          { value: 'medium', label: pgT('pgThinkingMedium') || 'Medium' },
          { value: 'high', label: pgT('pgThinkingHigh') || 'High' },
          { value: 'xhigh', label: pgT('pgReasoningXHigh') || 'XHigh' },
          { value: 'max', label: pgT('pgReasoningMax') || 'Max' }
        ], cfg.reasoningEffort || 'medium', 'pgOnParam(\'reasoningEffort\', this.value)', 'flex:1;min-width:0') +
      '</div>' +
      '<div class="pg-param' + (!en.seed || customMode ? ' disabled' : '') + '">' +
        '<button class="pg-toggle' + (en.seed ? ' on' : '') + '" onclick="pgToggleParam(\'seed\')" data-tooltip="' + pgEscapeHtml(pgT('pgParamToggle')) + '">' + (en.seed ? '✓' : '✕') + '</button>' +
        '<label>' + pgEscapeHtml(pgT('pgSeed')) + '</label>' +
        '<input type="text" placeholder="' + pgEscapeHtml(pgT('pgSeedPlaceholder')) + '" value="' + pgEscapeHtml(cfg.seed || '') + '" oninput="pgOnParam(\'seed\', this.value)"' + (!en.seed || customMode ? ' disabled' : '') + '>' +
      '</div>' +
      '<div class="pg-switch"><label class="toggle-switch"><input type="checkbox" id="pg-stream" ' + (cfg.stream ? 'checked' : '') + ' onchange="pgOnParam(\'stream\', this.checked)"' + (customMode ? ' disabled' : '') + '><span class="toggle-slider"></span></label><span class="pg-switch-label">' + pgEscapeHtml(pgT('pgStream')) + '</span></div>';
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
      '<div class="pg-switch" style="margin-bottom:0"><label class="toggle-switch"><input type="checkbox" id="pg-custombody-toggle" ' + (cfg.useCustomBody ? 'checked' : '') + ' onchange="pgOnParam(\'useCustomBody\', this.checked); pgRenderSidebar()"><span class="toggle-slider"></span></label><span class="pg-switch-label">' + pgEscapeHtml(pgT('pgUseCustomBody')) + '</span></div>' +
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
      '<div class="pg-switch" style="margin-bottom:0"><label class="toggle-switch"><input type="checkbox" id="pg-customep-toggle" ' + (cfg.useCustomEndpoint ? 'checked' : '') + ' onchange="pgOnParam(\'useCustomEndpoint\', this.checked); pgRenderSidebar()"><span class="toggle-slider"></span></label><span class="pg-switch-label">' + pgEscapeHtml(pgT('pgUseCustomEndpoint')) + '</span></div>' +
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
        '<div class="pg-panel-section">' +
          '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('pgAutoChatIterations')) + '</label><input type="number" class="input" style="width:92px;height:32px;text-align:center" min="0" value="' + pgState.autoChat.iterations + '" onchange="pgAutoChatSetIterations(this.value)"></div>' +
          '<div class="pg-autochat-hint" id="pg-autochat-iterations-hint" style="margin-top:4px">' + (pgState.autoChat.iterations === 0 ? pgEscapeHtml(pgT('pgAutoChatInfiniteWarn')) : '') + '</div>' +
        '</div>' +
        '<div class="pg-panel-section">' +
          '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('pgAutoChatUserName')) + '</label><input type="text" class="input" style="flex:1;min-width:0;height:32px" value="' + pgEscapeHtml(pgState.autoChat.userName || 'User') + '" oninput="pgAutoChatSetUserName(this.value)"></div>' +
          '<div class="pg-param-row" style="margin-top:8px"><label>' + pgEscapeHtml(pgT('pgAutoChatDelay')) + '</label><input type="number" class="input" style="width:92px;height:32px;text-align:center" min="0" step="0.5" value="' + pgState.autoChat.delaySeconds + '" onchange="pgAutoChatSetDelay(this.value)"></div>' +
          '<div class="pg-autochat-hint" style="margin-top:4px">' + pgEscapeHtml(pgT('pgAutoChatDelayHint')) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pg-autochat-actions">' +
        '<button class="btn btn-ghost danger' + (pgState.autoChat.isRunning ? ' running' : '') + '" onclick="pgAutoChatStop()" id="pg-autochat-stop-btn" style="height:32px">' + pgEscapeHtml(pgT('pgAutoChatStop')) + '</button>' +
        '<button class="btn btn-ghost" onclick="pgOpenGroupChatModal()" style="height:32px">' + pgEscapeHtml(pgT('pgAutoChatOpenGroup')) + '</button>' +
        '<button class="btn btn-ghost" onclick="if(typeof pgOpenSetupWizard===\'function\') pgOpenSetupWizard()" style="height:32px">' + pgEscapeHtml(pgT('Scenario Setup')) + '</button>' +
      '</div>' +
    '</div>' +
    // --- Director panel ---
    '<div class="pg-panel pg-director-panel">' +
      '<div class="pg-panel-title"><span>' + pgEscapeHtml(pgT('Director')) + '</span><label class="toggle-switch" data-tooltip="' + pgEscapeHtml(pgT('Director Enable')) + '"><input type="checkbox" id="pg-director-enable"' + (pgState.autoChat.director.enabled ? ' checked' : '') + ' onchange="pgDirectorToggle(this.checked)"><span class="toggle-slider"></span></label></div>' +
      '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('Director Model')) + '</label><button class="input pg-model-btn" onclick="pgOpenModelPicker(pgState.autoChat.director.directorModel, function(v){ pgDirectorSetDirectorModel(v); pgRenderSidebar(); }, {allowEmpty:true})" style="flex:1;min-width:0;text-align:left;display:flex;justify-content:space-between;align-items:center;cursor:pointer;height:32px">' + pgEscapeHtml(pgState.autoChat.director.directorModel || pgT('Default (first window model)')) + ' <span style="opacity:0.5">▼</span></button></div>' +
      '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('Narrator Model')) + '</label><button class="input pg-model-btn" onclick="pgOpenModelPicker(pgState.autoChat.director.narratorModel, function(v){ pgDirectorSetNarratorModel(v); pgRenderSidebar(); }, {allowEmpty:true})" style="flex:1;min-width:0;text-align:left;display:flex;justify-content:space-between;align-items:center;cursor:pointer;height:32px">' + pgEscapeHtml(pgState.autoChat.director.narratorModel || pgT('Default (first window model)')) + ' <span style="opacity:0.5">▼</span></button></div>' +
      '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('Every N Replies')) + '</label><input type="number" class="input" style="width:92px;height:32px;text-align:center" min="1" value="' + pgState.autoChat.director.everyNReplies + '" onchange="pgDirectorSetEveryNReplies(this.value)"></div>' +
      '<div class="pg-param-row"><label>' + pgEscapeHtml(pgT('Max Narrations')) + '</label><input type="number" class="input" style="width:92px;height:32px;text-align:center" min="0" value="' + pgState.autoChat.director.maxNarrations + '" onchange="pgDirectorSetMaxNarrations(this.value)"><span class="pg-autochat-hint" style="margin-left:6px">' + pgEscapeHtml(pgT('0 = ∞')) + '</span></div>' +
    '</div>' +
    '<div class="pg-panel"><div class="pg-panel-title">' + pgEscapeHtml(pgT('pgAutoChatAgentName')) + '</div>' +
      '<input type="text" class="input pg-agent-name" style="width:100%;height:32px;box-sizing:border-box" placeholder="' + pgEscapeHtml(pgT('pgAutoChatAgentNamePlaceholder')) + '" value="' + pgEscapeHtml(cfg.agentName || '') + '" oninput="pgOnAgentName(this.value)">' +
      '<div class="pg-param-row" style="margin-top:8px"><label>' + pgEscapeHtml(pgT('pgContextLimit')) + '</label><input type="number" class="input" style="width:92px;height:32px;text-align:center" min="1000" step="1000" value="' + (cfg.contextLimit || 8000) + '" onchange="pgOnContextLimit(this.value)"></div>' +
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
    '<div class="pg-switch"><label class="toggle-switch"><input type="checkbox" id="pg-imgenable" ' + (cfg.imageEnabled ? 'checked' : '') + ' onchange="pgOnParam(\'imageEnabled\', this.checked); pgRenderSidebar()"' + (customMode ? ' disabled' : '') + '><span class="toggle-slider"></span></label><span class="pg-switch-label">' + pgEscapeHtml(pgT('pgImageEnable')) + '</span>' +
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

  var sendBtn = '';
  if (pgIsGenerating() && !(pgState.autoChat.enabled && pgState.autoChat.isRunning)) {
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
      '<textarea class="pg-input" id="pg-input" placeholder="' + pgEscapeHtml(pgState.mode === 'image' ? pgT('pgImagePromptPlaceholder') : (pgState.mode === 'search' ? pgT('pgSearchPlaceholder') : pgT('pgEnterMessage'))) + '" onkeydown="pgOnInputKey(event)"></textarea>' +
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

