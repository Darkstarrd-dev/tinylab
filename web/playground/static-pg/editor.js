// editor.js — Editor page entry point, cleanup, and all editor logic.
// Loaded last among editor files, after editor-state.js.

'use strict';

// ===================== aligned diff (ported from novelhelper) =====================

function edToLines(value) {
  var arr = value.split('\n');
  if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

/**
 * Line-aligned diff: adjacent delete/add blocks are pair-matched as "mod" rows
 * with char-level highlighting via Diff.diffChars.
 * Exposed as window.editorAlignedDiff.
 */
function editorAlignedDiff(oldText, newText) {
  if (typeof Diff === 'undefined' || !Diff.diffLines) {
    return [{ type:'context', left:{num:1,text:oldText}, right:{num:1,text:newText} }];
  }
  var changes = Diff.diffLines(oldText, newText);
  var rows = [];
  var ln = 1;
  var rn = 1;
  var i = 0;
  while (i < changes.length) {
    var c = changes[i];
    if (!c.added && !c.removed) {
      var ctxLines = edToLines(c.value);
      for (var ci = 0; ci < ctxLines.length; ci++) {
        rows.push({ type:'context', left:{num:ln++, text:ctxLines[ci]}, right:{num:rn++, text:ctxLines[ci]} });
      }
      i += 1;
      continue;
    }
    if (c.removed) {
      // Look ahead for an added block, skipping over empty-line context blocks.
      // This pairs del+add as mod even when separated by blank lines (common in
      // novel text where paragraphs are separated by empty lines).
      var skipCtx = [];
      var addIdx = -1;
      for (var j = i + 1; j < changes.length; j++) {
        if (changes[j].added) { addIdx = j; break; }
        if (changes[j].removed) { addIdx = -1; break; } // another removed: abort pairing
        var ctxLs = edToLines(changes[j].value);
        var allEmpty = true;
        for (var ce = 0; ce < ctxLs.length; ce++) { if (ctxLs[ce] !== '') { allEmpty = false; break; } }
        if (!allEmpty) { addIdx = -1; break; }
        skipCtx = skipCtx.concat(ctxLs);
      }
      if (addIdx > 0) {
        // Emit skipped empty context lines first
        for (var si = 0; si < skipCtx.length; si++) {
          rows.push({ type:'context', left:{num:ln++, text:skipCtx[si]}, right:{num:rn++, text:skipCtx[si]} });
        }
        // Pair removed + added as mod rows with char-level diff
        var delLines = edToLines(c.value);
        var addLines = edToLines(changes[addIdx].value);
        var n = Math.max(delLines.length, addLines.length);
        for (var k = 0; k < n; k++) {
          var l = k < delLines.length ? delLines[k] : null;
          var r = k < addLines.length ? addLines[k] : null;
          if (l !== null && r !== null) {
            var parts = Diff.diffChars(l, r);
            rows.push({
              type: 'mod',
              left: {num:ln++, text:l},
              right: {num:rn++, text:r},
              leftParts: parts.filter(function(p) { return !p.added; }).map(function(p) { return {text:p.value, removed:p.removed}; }),
              rightParts: parts.filter(function(p) { return !p.removed; }).map(function(p) { return {text:p.value, added:p.added}; })
            });
          } else if (l !== null) {
            rows.push({ type:'del', left:{num:ln++, text:l}, right:null });
          } else {
            rows.push({ type:'add', left:null, right:{num:rn++, text:r} });
          }
        }
        i = addIdx + 1;
        continue;
      }
      // No added block found: emit as del
      var rmLines = edToLines(c.value);
      for (var ri = 0; ri < rmLines.length; ri++) {
        rows.push({ type:'del', left:{num:ln++, text:rmLines[ri]}, right:null });
      }
      i += 1;
      continue;
    }
    if (c.added) {
      var addLines2 = edToLines(c.value);
      for (var ai = 0; ai < addLines2.length; ai++) {
        rows.push({ type:'add', left:null, right:{num:rn++, text:addLines2[ai]} });
      }
      i += 1;
      continue;
    }
  }
  return rows;
}

function edDiffStats(rows) {
  var stats = { del:0, add:0, mod:0 };
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].type === 'del') stats.del++;
    else if (rows[i].type === 'add') stats.add++;
    else if (rows[i].type === 'mod') stats.mod++;
  }
  return stats;
}

// ===================== editor entry & cleanup =====================

/** References kept for cleanup */
var edContainer = null;
var edKeyHandler = null;
var edFindHandler = null;
var edGutterTimers = []; // per-pane resize observers / scroll sync timers

window.renderEditor = function(container) {
  edContainer = container;
  edLoadState();
  container.innerHTML = '';
  container.style.height = '100%';
  container.style.overflow = 'hidden';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  // Mode switch: File Editor | Log Reader
  var modeSwitch = document.createElement('div');
  modeSwitch.className = 'log-mode-switch';

  var fileEditorBtn = document.createElement('button');
  fileEditorBtn.className = 'log-mode-btn' + (editorState.mode !== 'logReader' ? ' active' : '');
  fileEditorBtn.textContent = T('logFileEditor');
  fileEditorBtn.dataset.mode = 'fileEditor';

  var logReaderBtn = document.createElement('button');
  logReaderBtn.className = 'log-mode-btn' + (editorState.mode === 'logReader' ? ' active' : '');
  logReaderBtn.textContent = T('logReader');
  logReaderBtn.dataset.mode = 'logReader';

  modeSwitch.appendChild(fileEditorBtn);
  modeSwitch.appendChild(logReaderBtn);
  container.appendChild(modeSwitch);

  // Content container for either log reader or file editor UI
  fileEditorBtn.addEventListener('click', function() {
    editorState.mode = 'edit';
    if (typeof window.cleanupEditorLogs === 'function') {
      window.cleanupEditorLogs();
    }
    window.renderEditor(container);
  });
  logReaderBtn.addEventListener('click', function() {
    editorState.mode = 'logReader';
    if (typeof window.renderLogReader === 'function') {
      window.renderLogReader(contentContainer);
    }
  });
  var contentContainer = document.createElement('div');
  contentContainer.className = 'log-reader-content';
  contentContainer.style.flex = '1';
  contentContainer.style.minHeight = '0';
  container.appendChild(contentContainer);

  // If Log Reader mode, render log reader into content container and stop here
  if (editorState.mode === 'logReader') {
    if (typeof window.renderLogReader === 'function') {
      window.renderLogReader(contentContainer);
    }
    return;
  }

  // File Editor mode: render the existing editor UI below the mode switch

  // Build layout
  var layout = document.createElement('div');
  layout.className = 'ed-layout';
  layout.id = 'ed-layout';
  contentContainer.appendChild(layout);

  // Toolbar
  var toolbar = document.createElement('div');
  toolbar.className = 'ed-toolbar';
  toolbar.id = 'ed-toolbar';
  layout.appendChild(toolbar);

  // Mode toggle
  var modeGroup = document.createElement('div');
  modeGroup.className = 'ed-toolbar-group';
  var modeEditBtn = document.createElement('button');
  modeEditBtn.className = 'ed-btn ed-btn-sm' + (editorState.mode === 'edit' ? ' active' : '');
  modeEditBtn.textContent = T('editorEditMode');
  modeEditBtn.dataset.mode = 'edit';
  var modeDiffBtn = document.createElement('button');
  modeDiffBtn.className = 'ed-btn ed-btn-sm' + (editorState.mode === 'diff' ? ' active' : '');
  modeDiffBtn.textContent = T('editorDiff');
  modeDiffBtn.dataset.mode = 'diff';
  modeGroup.appendChild(modeEditBtn);
  modeGroup.appendChild(modeDiffBtn);
  var modeCleanBtn = document.createElement('button');
  modeCleanBtn.className = 'ed-btn ed-btn-sm' + (editorState.mode === 'clean' ? ' active' : '');
  modeCleanBtn.textContent = T('editorClean');
  modeCleanBtn.dataset.mode = 'clean';
  modeGroup.appendChild(modeCleanBtn);
  toolbar.appendChild(modeGroup);

  // Diff source selector (hidden in edit mode)
  var diffSourceGroup = document.createElement('div');
  diffSourceGroup.className = 'ed-toolbar-group ed-diff-source-group';
  diffSourceGroup.id = 'ed-diff-source-group';
  diffSourceGroup.style.display = editorState.mode === 'diff' ? '' : 'none';
  var dsLabel = document.createElement('span');
  dsLabel.className = 'ed-toolbar-label';
  dsLabel.textContent = T('editorDiffSource') + ':';
  diffSourceGroup.appendChild(dsLabel);
  var dsSelect = document.createElement('select');
  dsSelect.className = 'ed-select';
  dsSelect.id = 'ed-diff-source';
  var dsOpts = [
    { value:'left-after', label:T('editorLeftBeforeAfter') },
    { value:'right-after', label:T('editorRightBeforeAfter') },
    { value:'left-vs-right', label:T('editorLeftVsRight') }
  ];
  for (var dsi = 0; dsi < dsOpts.length; dsi++) {
    var opt = document.createElement('option');
    opt.value = dsOpts[dsi].value;
    opt.textContent = dsOpts[dsi].label;
    if (opt.value === editorState.diffSource) opt.selected = true;
    dsSelect.appendChild(opt);
  }
  diffSourceGroup.appendChild(dsSelect);
  toolbar.appendChild(diffSourceGroup);

  // Spacer
  var spacer = document.createElement('div');
  spacer.className = 'ed-toolbar-spacer';
  toolbar.appendChild(spacer);

  // Save All button
  var saveAllBtn = document.createElement('button');
  saveAllBtn.className = 'ed-btn ed-btn-sm';
  saveAllBtn.id = 'ed-save-all';
  saveAllBtn.textContent = T('editorSaveAll');
  toolbar.appendChild(saveAllBtn);

  // Panes container
  var panesContainer = document.createElement('div');
  panesContainer.className = 'ed-panes';
  panesContainer.id = 'ed-panes';
  layout.appendChild(panesContainer);

  // Create two panes
  for (var pi = 0; pi < 2; pi++) {
    var pane = document.createElement('div');
    pane.className = 'ed-pane' + (pi === editorState.focused ? ' ed-pane-focused' : '');
    pane.id = 'ed-pane-' + pi;

    // Pane header
    var header = document.createElement('div');
    header.className = 'ed-pane-header';
    header.id = 'ed-pane-header-' + pi;

    var titleSpan = document.createElement('span');
    titleSpan.className = 'ed-pane-title';
    var paneName = editorState.panes[pi].name || T('editorUntitled');
    titleSpan.textContent = paneName;
    titleSpan.id = 'ed-pane-title-' + pi;

    var dirtyDot = document.createElement('span');
    dirtyDot.className = 'ed-dirty-dot' + (edIsDirty(pi) ? ' ed-dirty' : '');
    dirtyDot.id = 'ed-dirty-dot-' + pi;
    dirtyDot.textContent = ' \u2022';

    header.appendChild(titleSpan);
    header.appendChild(dirtyDot);

    // Header buttons
    var headerBtns = document.createElement('div');
    headerBtns.className = 'ed-pane-header-btns';

    var openBtn = document.createElement('button');
    openBtn.className = 'ed-btn ed-btn-xs';
    openBtn.textContent = T('editorOpen');
    openBtn.id = 'ed-open-' + pi;
    headerBtns.appendChild(openBtn);

    var saveBtn = document.createElement('button');
    saveBtn.className = 'ed-btn ed-btn-xs' + (edIsDirty(pi) ? '' : ' ed-btn-disabled');
    saveBtn.textContent = T('editorSave');
    saveBtn.id = 'ed-save-' + pi;
    saveBtn.disabled = !edIsDirty(pi);
    headerBtns.appendChild(saveBtn);

    var rawBtn = document.createElement('button');
    rawBtn.className = 'ed-btn ed-btn-xs' + (editorState.panes[pi].view === 'raw' ? ' active' : '');
    rawBtn.textContent = T('editorRaw');
    rawBtn.id = 'ed-raw-' + pi;
    headerBtns.appendChild(rawBtn);

    var parsedBtn = document.createElement('button');
    parsedBtn.className = 'ed-btn ed-btn-xs' + (editorState.panes[pi].view === 'parsed' ? ' active' : '');
    parsedBtn.textContent = T('editorParsed');
    parsedBtn.id = 'ed-parsed-' + pi;
    headerBtns.appendChild(parsedBtn);

    var wrapBtn = document.createElement('button');
    wrapBtn.className = 'ed-btn ed-btn-xs' + (editorState.panes[pi].wrap ? ' active' : '');
    wrapBtn.textContent = T('editorWrap');
    wrapBtn.id = 'ed-wrap-' + pi;
    headerBtns.appendChild(wrapBtn);

    header.appendChild(headerBtns);
    pane.appendChild(header);

    // Find bar (hidden)
    var findBar = document.createElement('div');
    findBar.className = 'ed-find-bar' + (editorState.find.visible ? '' : ' ed-hidden');
    findBar.id = 'ed-find-bar-' + pi;
    pane.appendChild(findBar);
    edBuildFindBar(findBar, pi);

    // Body area (editor or parsed)
    var body = document.createElement('div');
    body.className = 'ed-pane-body';
    body.id = 'ed-pane-body-' + pi;

    // Gutter + textarea (for raw view)
    var editArea = document.createElement('div');
    editArea.className = 'ed-edit-area' + (editorState.panes[pi].view === 'raw' ? '' : ' ed-hidden');
    editArea.id = 'ed-edit-area-' + pi;

    var gutter = document.createElement('div');
    gutter.className = 'ed-gutter';
    gutter.id = 'ed-gutter-' + pi;
    editArea.appendChild(gutter);

    var textarea = document.createElement('textarea');
    textarea.className = 'ed-input' + (editorState.panes[pi].wrap ? ' ed-wrap' : '');
    textarea.id = 'ed-input-' + pi;
    textarea.value = editorState.panes[pi].original;
    textarea.spellcheck = false;
    editArea.appendChild(textarea);
    body.appendChild(editArea);

    // Parsed view area
    var parsedArea = document.createElement('div');
    parsedArea.className = 'ed-parsed-area' + (editorState.panes[pi].view === 'parsed' ? '' : ' ed-hidden');
    parsedArea.id = 'ed-parsed-area-' + pi;
    body.appendChild(parsedArea);

    pane.appendChild(body);
    panesContainer.appendChild(pane);
  }

  // Diff area (hidden in edit mode)
  var diffArea = document.createElement('div');
  diffArea.className = 'ed-diff-area' + (editorState.mode === 'diff' ? '' : ' ed-hidden');
  diffArea.id = 'ed-diff-area';
  layout.appendChild(diffArea);

  // Review area wrapper (Clean mode — hosts AI Text Review wizard in left pane)
  var reviewWrap = document.createElement('div');
  reviewWrap.className = 'ed-review-wrap' + (editorState.mode === 'clean' ? '' : ' ed-hidden');
  reviewWrap.id = 'ed-review-wrap';

  var reviewArea = document.createElement('div');
  reviewArea.className = 'ed-review-area';
  reviewArea.id = 'ed-review-area';
  reviewWrap.appendChild(reviewArea);

  var reviewContent = document.createElement('pre');
  reviewContent.className = 'ed-review-content';
  reviewContent.id = 'ed-review-content';
  reviewWrap.appendChild(reviewContent);

  layout.appendChild(reviewWrap);

  // ===================== Bind events =====================

  // Mode toggle
  modeEditBtn.addEventListener('click', function() { edSetMode('edit'); });
  modeDiffBtn.addEventListener('click', function() { edSetMode('diff'); });
  modeCleanBtn.addEventListener('click', function() { edSetMode('clean'); });

  // Diff source
  dsSelect.addEventListener('change', function() {
    editorState.diffSource = this.value;
    edRenderDiff();
  });

  // Save all
  saveAllBtn.addEventListener('click', function() { edSaveAll(); });

  // Per-pane buttons
  for (var bi = 0; bi < 2; bi++) {
    (function(idx) {
      document.getElementById('ed-open-' + idx).addEventListener('click', function() { edOpenFile(idx); });
      document.getElementById('ed-save-' + idx).addEventListener('click', function() { edSaveFile(idx); });
      document.getElementById('ed-raw-' + idx).addEventListener('click', function() { edSetPaneView(idx, 'raw'); });
      document.getElementById('ed-parsed-' + idx).addEventListener('click', function() { edSetPaneView(idx, 'parsed'); });
      document.getElementById('ed-wrap-' + idx).addEventListener('click', function() { edToggleWrap(idx); });
    })(bi);
  }

  // Textarea events
  for (var ti = 0; ti < 2; ti++) {
    (function(idx) {
      var ta = document.getElementById('ed-input-' + idx);
      if (!ta) return;
      ta.addEventListener('input', function() { edOnInput(idx); });
      ta.addEventListener('scroll', function() { edSyncGutter(idx); });
      ta.addEventListener('keydown', function(e) { edTextareaKeydown(e, idx); });
      ta.addEventListener('focus', function() { edFocusPane(idx); });
      ta.addEventListener('click', function() { edFocusPane(idx); });
    })(ti);
  }

  // Global keydown handler
  edKeyHandler = function(e) {
    var tag = document.activeElement ? document.activeElement.tagName : '';
    var isTextarea = tag === 'TEXTAREA' && document.activeElement && document.activeElement.classList.contains('ed-input');
    var findInput = document.activeElement && document.activeElement.classList.contains('ed-find-input');
    var replaceInput = document.activeElement && document.activeElement.classList.contains('ed-find-replace');

    // Ctrl+S (or Cmd+S on Mac) — save
    if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (isTextarea) {
        var fIdx = edFocusedPaneIndex();
        if (fIdx >= 0) edSaveFile(fIdx);
      }
      return;
    }
    // Ctrl+Shift+S — save all
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 's') {
      e.preventDefault();
      e.stopPropagation();
      edSaveAll();
      return;
    }
    // Ctrl+F — find
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      if (!findInput && !replaceInput) {
        e.preventDefault();
        e.stopPropagation();
        edToggleFind();
        return;
      }
    }
    // Ctrl+H — find+replace
    if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
      e.preventDefault();
      e.stopPropagation();
      edToggleFind(true);
      return;
    }
    // Ctrl+G — go to line
    if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
      if (!findInput && !replaceInput) {
        e.preventDefault();
        e.stopPropagation();
        edGoToLine();
        return;
      }
    }
    // Tab handling in textarea
    if (e.key === 'Tab' && isTextarea) {
      e.preventDefault();
      e.stopPropagation();
      edInsertTab(document.activeElement, e.shiftKey);
      return;
    }
    // Shift+F3 / Shift+Enter — prev match (check before plain F3)
    if (e.key === 'F3' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      edFindPrev();
      return;
    }
    // F3 / Enter in find bar — next match
    if (e.key === 'F3' || (e.key === 'Enter' && findInput)) {
      e.preventDefault();
      e.stopPropagation();
      edFindNext();
      return;
    }
    // Esc — close find bar
    if (e.key === 'Escape' && editorState.find.visible) {
      e.preventDefault();
      e.stopPropagation();
      edCloseFind();
      return;
    }
  };
  document.addEventListener('keydown', edKeyHandler);

  // Render parsed views if needed
  for (var rpi = 0; rpi < 2; rpi++) {
    if (editorState.panes[rpi].view === 'parsed') {
      edRenderParsed(rpi);
    }
  }

  // Initial gutter update
  edUpdateGutters();

  if (editorState.mode === 'clean') {
    edSetMode('clean');
  } else {
    edRenderDiff();
  }
};

// ===================== cleanup =====================

window.cleanupEditor = function() {
  if (edKeyHandler) {
    document.removeEventListener('keydown', edKeyHandler);
    edKeyHandler = null;
  }
  if (editorState.mode === 'clean' && typeof window.cleanupTextReview === 'function') {
    window.cleanupTextReview();
  }
  for (var i = 0; i < edGutterTimers.length; i++) {
    if (edGutterTimers[i]) clearTimeout(edGutterTimers[i]);
  }
  edGutterTimers = [];
  edContainer = null;
  if (typeof window.cleanupEditorLogs === 'function') {
    window.cleanupEditorLogs();
  }
};
// ===================== state helpers =====================

function edFocusedPaneIndex() {
  return editorState.focused;
}

function edIsDirty(idx) {
  var p = editorState.panes[idx];
  if (!p) return false;
  var ta = document.getElementById('ed-input-' + idx);
  var current = ta ? ta.value : p.original;
  return current !== p.original;
}

function edGetContent(idx) {
  var ta = document.getElementById('ed-input-' + idx);
  return ta ? ta.value : editorState.panes[idx].original;
}

// ===================== mode / view toggles =====================

function edSetMode(mode) {
  var prev = editorState.mode;
  editorState.mode = mode;

  // Active state on all three mode buttons
  var editBtn = document.querySelector('#ed-toolbar .ed-btn[data-mode="edit"]');
  var diffBtn = document.querySelector('#ed-toolbar .ed-btn[data-mode="diff"]');
  var cleanBtn = document.querySelector('#ed-toolbar .ed-btn[data-mode="clean"]');
  if (editBtn) editBtn.classList.toggle('active', mode === 'edit');
  if (diffBtn) diffBtn.classList.toggle('active', mode === 'diff');
  if (cleanBtn) cleanBtn.classList.toggle('active', mode === 'clean');

  var diffSourceGroup = document.getElementById('ed-diff-source-group');
  if (diffSourceGroup) diffSourceGroup.style.display = mode === 'diff' ? '' : 'none';

  var panes = document.getElementById('ed-panes');
  var diffArea = document.getElementById('ed-diff-area');
  var reviewWrap = document.getElementById('ed-review-wrap');
  var reviewArea = document.getElementById('ed-review-area');

  // Leaving clean mode
  if (prev === 'clean' && mode !== 'clean') {
    if (typeof window.cleanupTextReview === 'function') window.cleanupTextReview();
    if (reviewArea) reviewArea.innerHTML = '';
  }

  if (mode === 'clean') {
    if (panes) panes.style.display = 'none';
    if (diffArea) diffArea.classList.add('ed-hidden');
    if (reviewWrap) {
      reviewWrap.classList.remove('ed-hidden');
      if (reviewArea && reviewArea.children.length === 0 && typeof window.renderTextReview === 'function') {
        window.renderTextReview(reviewArea);
      }
    }
  } else {
    // edit or diff
    if (reviewWrap) reviewWrap.classList.add('ed-hidden');
    if (panes) panes.style.display = mode === 'edit' ? '' : 'none';
    if (mode === 'diff') edRenderDiff();
  }

  edSaveState();
}

function edSetPaneView(idx, view) {
  editorState.panes[idx].view = view;
  var rawBtn = document.getElementById('ed-raw-' + idx);
  var parsedBtn = document.getElementById('ed-parsed-' + idx);
  if (rawBtn) rawBtn.classList.toggle('active', view === 'raw');
  if (parsedBtn) parsedBtn.classList.toggle('active', view === 'parsed');

  var editArea = document.getElementById('ed-edit-area-' + idx);
  var parsedArea = document.getElementById('ed-parsed-area-' + idx);
  if (editArea) editArea.classList.toggle('ed-hidden', view !== 'raw');
  if (parsedArea) parsedArea.classList.toggle('ed-hidden', view !== 'parsed');

  if (view === 'parsed') {
    edRenderParsed(idx);
  }
  edSaveState();
}

function edToggleWrap(idx) {
  editorState.panes[idx].wrap = !editorState.panes[idx].wrap;
  var wrapBtn = document.getElementById('ed-wrap-' + idx);
  if (wrapBtn) wrapBtn.classList.toggle('active', editorState.panes[idx].wrap);
  var ta = document.getElementById('ed-input-' + idx);
  if (ta) ta.classList.toggle('ed-wrap', editorState.panes[idx].wrap);
  edUpdateGutters();
  edSaveState();
}

function edFocusPane(idx) {
  editorState.focused = idx;
  for (var i = 0; i < 2; i++) {
    var p = document.getElementById('ed-pane-' + i);
    if (p) p.classList.toggle('ed-pane-focused', i === idx);
  }
}

// ===================== input handling =====================

function edOnInput(idx) {
  edUpdateDirty(idx);
  edUpdateGutters();
}

function edUpdateDirty(idx) {
  var dirty = edIsDirty(idx);
  var dot = document.getElementById('ed-dirty-dot-' + idx);
  if (dot) dot.classList.toggle('ed-dirty', dirty);
  var saveBtn = document.getElementById('ed-save-' + idx);
  if (saveBtn) {
    saveBtn.disabled = !dirty;
    saveBtn.classList.toggle('ed-btn-disabled', !dirty);
  }
}

function edUpdateGutters() {
  for (var i = 0; i < 2; i++) {
    edRenderGutter(i);
  }
}

function edRenderGutter(idx) {
  var ta = document.getElementById('ed-input-' + idx);
  var gutter = document.getElementById('ed-gutter-' + idx);
  if (!ta || !gutter) return;
  var lines = ta.value.split('\n');
  var html = '';
  for (var i = 1; i <= lines.length; i++) {
    html += '<span>' + i + '</span>\n';
  }
  // Ensure at least one line when empty
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    html = '<span>1</span>\n';
  }
  gutter.innerHTML = html;
}

function edSyncGutter(idx) {
  var ta = document.getElementById('ed-input-' + idx);
  var gutter = document.getElementById('ed-gutter-' + idx);
  if (!ta || !gutter) return;
  gutter.scrollTop = ta.scrollTop;
}

function edInsertTab(ta, shift) {
  var start = ta.selectionStart;
  var end = ta.selectionEnd;
  var val = ta.value;

  if (shift) {
    // Outdent: remove up to 2 leading spaces from current line(s)
    var lineStart = val.lastIndexOf('\n', start - 1);
    if (lineStart < 0) lineStart = 0;
    else lineStart += 1;

    var before = val.substring(0, lineStart);
    var afterLine = val.substring(lineStart);
    var lineEnd = afterLine.indexOf('\n');
    var lineText = lineEnd >= 0 ? afterLine.substring(0, lineEnd) : afterLine;
    var indent = 0;
    while (indent < 2 && indent < lineText.length && lineText[indent] === ' ') indent++;
    var newText = before + lineText.substring(indent) + (lineEnd >= 0 ? afterLine.substring(lineEnd) : '');
    ta.value = newText;
    var newPos = start - indent;
    if (newPos < lineStart) newPos = lineStart;
    ta.selectionStart = newPos;
    ta.selectionEnd = newPos;
  } else {
    // Tab → 2 spaces
    ta.value = val.substring(0, start) + '  ' + val.substring(end);
    ta.selectionStart = start + 2;
    ta.selectionEnd = start + 2;
  }
  edOnInput(idxOfElement(ta));
}

function idxOfElement(el) {
  var id = el && el.id;
  if (!id) return -1;
  var m = id.match(/ed-input-(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

function edTextareaKeydown(e, idx) {
  if (e.key === 'Tab') {
    // Handled in global handler
    return;
  }
  if (e.key === 'Enter') {
    // Auto-indent
    e.preventDefault();
    var ta = e.target;
    var start = ta.selectionStart;
    var val = ta.value;
    var lineStart = val.lastIndexOf('\n', start - 1);
    if (lineStart < 0) lineStart = 0;
    else lineStart += 1;
    var lineText = val.substring(lineStart, start);
    var indent = '';
    for (var ci = 0; ci < lineText.length && lineText[ci] === ' '; ci++) {
      indent += ' ';
    }
    ta.value = val.substring(0, start) + '\n' + indent + val.substring(ta.selectionEnd);
    ta.selectionStart = start + 1 + indent.length;
    ta.selectionEnd = ta.selectionStart;
    edOnInput(idx);
    return;
  }
}

// ===================== parsed rendering =====================

function edRenderParsed(idx) {
  var area = document.getElementById('ed-parsed-area-' + idx);
  if (!area) return;
  var p = editorState.panes[idx];
  var content = edGetContent(idx);
  var ext = edFileExt(p.name);

  area.innerHTML = '';

  if (edIsMdExt(ext)) {
    // Markdown rendering via existing playground pipeline
    var html;
    if (typeof pgRenderMarkdown === 'function') {
      html = pgRenderMarkdown(content, false);
    } else if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      try {
        html = DOMPurify.sanitize(marked.parse(content));
      } catch (e) {
        html = '<pre>' + edEscapeHtml(content) + '</pre>';
      }
    } else {
      html = '<pre>' + edEscapeHtml(content) + '</pre>';
    }
    area.innerHTML = '<div class="pg-bubble pg-bubble-slot">' + html + '</div>';
    // Highlight code blocks
    if (typeof pgHighlight === 'function') {
      pgHighlight(area);
    } else if (typeof hljs !== 'undefined') {
      area.querySelectorAll('pre code').forEach(function(block) {
        hljs.highlightElement(block);
      });
    }
  } else if (edIsCodeExt(ext)) {
    var lang = edLangForExt(ext);
    var el = document.createElement('div');
    var pre = document.createElement('pre');
    var code = document.createElement('code');
    code.className = 'language-' + lang;
    code.textContent = content;
    pre.appendChild(code);
    el.appendChild(pre);
    area.appendChild(el);
    if (typeof hljs !== 'undefined') {
      try { hljs.highlightElement(code); } catch (e) { code.textContent = content; }
    }
  } else {
    // Plain text
    var pre2 = document.createElement('pre');
    pre2.textContent = content;
    area.appendChild(pre2);
  }
}

// ===================== diff rendering =====================

function edRenderDiff() {
  var area = document.getElementById('ed-diff-area');
  if (!area) return;
  area.innerHTML = '';

  if (editorState.mode !== 'diff') return;
  var leftText, rightText;
  if (editorState.diffSource === 'left-after') {
    leftText = editorState.panes[0].original;
    rightText = edGetContent(0);
  } else if (editorState.diffSource === 'right-after') {
    leftText = editorState.panes[1].original;
    rightText = edGetContent(1);
  } else {
    // 'left-vs-right'
    leftText = edGetContent(0);
    rightText = edGetContent(1);
  }

  if (!leftText && !rightText) {
    area.innerHTML = '<div class="ed-diff-empty">' + T('editorNoFile') + '</div>';
    return;
  }

  var rows = editorAlignedDiff(leftText, rightText);
  var stats = edDiffStats(rows);

  // Stats header
  var oldChars = leftText.replace(/\s/g, '').length;
  var newChars = rightText.replace(/\s/g, '').length;
  var rate = oldChars > 0 ? (newChars / oldChars * 100) : 100;

  var statsDiv = document.createElement('div');
  statsDiv.className = 'ed-diff-stats';
  statsDiv.innerHTML =
    '<span class="ed-diff-stat-del">' + T('editorDeleted') + ' ' + stats.del + ' ' + T('editorLines') + '</span>' +
    '<span class="ed-diff-stat-add">' + T('editorAdded') + ' ' + stats.add + ' ' + T('editorLines') + '</span>' +
    '<span class="ed-diff-stat-mod">' + T('editorModified') + ' ' + stats.mod + ' ' + T('editorLines') + '</span>' +
    '<span class="ed-diff-stat-rate">' + T('editorCharRetention') + ' ' + rate.toFixed(1) + '%</span>';
  area.appendChild(statsDiv);

  // Table
  var tableWrap = document.createElement('div');
  tableWrap.className = 'ed-diff-table-wrap';

  var table = document.createElement('table');
  table.className = 'ed-diff-table';

  var tbody = document.createElement('tbody');
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var tr = document.createElement('tr');
    tr.className = 'ed-diff-row-' + row.type;

    // Left line num
    var tdNumL = document.createElement('td');
    tdNumL.className = 'ed-diff-num';
    tdNumL.textContent = row.left ? row.left.num : '';
    tr.appendChild(tdNumL);

    // Left text
    var tdTextL = document.createElement('td');
    tdTextL.className = 'ed-diff-cell-left';
    if (row.left) {
      tdTextL.innerHTML = edRenderParts(row.leftParts, row.left.text);
    } else {
      tdTextL.innerHTML = '<span class="ed-diff-placeholder">\u2205</span>';
    }
    tr.appendChild(tdTextL);

    // Right line num
    var tdNumR = document.createElement('td');
    tdNumR.className = 'ed-diff-num';
    tdNumR.textContent = row.right ? row.right.num : '';
    tr.appendChild(tdNumR);

    // Right text
    var tdTextR = document.createElement('td');
    tdTextR.className = 'ed-diff-cell-right';
    if (row.right) {
      tdTextR.innerHTML = edRenderParts(row.rightParts, row.right.text);
    } else {
      tdTextR.innerHTML = '<span class="ed-diff-placeholder">\u2205</span>';
    }
    tr.appendChild(tdTextR);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  area.appendChild(tableWrap);

  // Auto-scroll to first diff
  var firstDiff = rows.length;
  var firstDiffIdx = -1;
  for (var si = 0; si < rows.length; si++) {
    if (rows[si].type !== 'context') { firstDiffIdx = si; break; }
  }
  if (firstDiffIdx >= 0) {
    setTimeout(function() {
      var trs = tableWrap.querySelectorAll('tbody tr');
      if (trs[firstDiffIdx]) {
        trs[firstDiffIdx].scrollIntoView({ behavior:'smooth', block:'start' });
      }
    }, 50);
  }
}

function edRenderParts(parts, fallback) {
  if (!parts || parts.length === 0) return edEscapeHtml(fallback);
  var html = '';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.removed) {
      html += '<span class="ed-diff-char-removed">' + edEscapeHtml(p.text) + '</span>';
    } else if (p.added) {
      html += '<span class="ed-diff-char-added">' + edEscapeHtml(p.text) + '</span>';
    } else {
      html += edEscapeHtml(p.text);
    }
  }
  return html;
}

// ===================== file IO =====================

function edOpenFile(idx) {
  // POST to backend native file picker
  fetch('/api/editor/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  .then(function(resp) { return resp.json(); })
  .then(function(data) {
    if (data.cancelled) return;
    if (data.unsupported) {
      // Fallback to FsApi browser picker
      edOpenFallback(idx);
      return;
    }
    if (data.path !== undefined && data.content !== undefined) {
      editorState.panes[idx].path = data.path;
      editorState.panes[idx].name = data.name || '';
      editorState.panes[idx].original = data.content;
      var ta = document.getElementById('ed-input-' + idx);
      if (ta) ta.value = data.content;
      var title = document.getElementById('ed-pane-title-' + idx);
      if (title) title.textContent = data.name || T('editorUntitled');
      edSetPaneView(idx, 'raw');
      edUpdateDirty(idx);
      edUpdateGutters();
      edRenderDiff();
      edSaveState();
    }
  })
  .catch(function(err) {
    console.warn('editor open failed:', err);
    edOpenFallback(idx);
  });
}

function edOpenFallback(idx) {
  if (typeof FsApi === 'undefined' || !FsApi.pickFiles) {
    if (typeof toast === 'function') toast(T('editorCancelled'), 'error');
    return;
  }
  FsApi.pickFiles({ multiple: false }).then(function(files) {
    if (!files || files.length === 0) return;
    var file = files[0];
    file.text().then(function(text) {
      editorState.panes[idx].path = null;
      editorState.panes[idx].name = file.name;
      editorState.panes[idx].original = text;
      var ta = document.getElementById('ed-input-' + idx);
      if (ta) ta.value = text;
      var title = document.getElementById('ed-pane-title-' + idx);
      if (title) title.textContent = file.name || T('editorUntitled');
      edSetPaneView(idx, 'raw');
      edUpdateDirty(idx);
      edUpdateGutters();
      edRenderDiff();
      edSaveState();
    });
  }).catch(function() {
    // Cancelled — no-op
  });
}

function edSaveFile(idx) {
  var ta = document.getElementById('ed-input-' + idx);
  if (!ta) return;
  var content = ta.value;
  var p = editorState.panes[idx];

  if (p.path) {
    fetch('/api/editor/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p.path, content: content })
    })
    .then(function(resp) { return resp.json(); })
    .then(function(data) {
      if (data.ok) {
        p.original = content;
        edUpdateDirty(idx);
        edSaveState();
        if (typeof toast === 'function') toast(T('editorSaved'), 'success');
      } else {
        if (typeof toast === 'function') toast(T('editorSaveFailed'), 'error');
      }
    })
    .catch(function() {
      if (typeof toast === 'function') toast(T('editorSaveFailed'), 'error');
    });
  } else {
    // No path → browser save-as
    var name = p.name || 'untitled.txt';
    if (typeof FsApi !== 'undefined' && typeof FsApi.saveFile === 'function') {
      FsApi.saveFile(content, name, 'text/plain');
      p.original = content;
      edUpdateDirty(idx);
      edSaveState();
    } else {
      // Fallback: download via Blob
      var blob = new Blob([content], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      p.original = content;
      edSaveState();
      edUpdateDirty(idx);
    }
  }
}

function edSaveAll() {
  edSaveFile(0);
  edSaveFile(1);
}

// ===================== find / replace =====================

function edBuildFindBar(container, idx) {
  container.innerHTML =
    '<div class="ed-find-row">' +
      '<input type="text" class="ed-find-input" id="ed-find-input-' + idx + '" placeholder="' + T('editorFind') + '..." />' +
      '<button class="ed-btn ed-btn-xs ed-find-prev" id="ed-find-prev-' + idx + '" data-tooltip="' + T('editorPrev') + '">&larr;</button>' +
      '<button class="ed-btn ed-btn-xs ed-find-next" id="ed-find-next-' + idx + '" data-tooltip="' + T('editorNext') + '">&rarr;</button>' +
      '<span class="ed-find-count" id="ed-find-count-' + idx + '"></span>' +
      '<label class="ed-find-label"><input type="checkbox" class="ed-find-case" id="ed-find-case-' + idx + '" /> ' + T('editorCaseSensitive') + '</label>' +
      '<label class="ed-find-label"><input type="checkbox" class="ed-find-regex" id="ed-find-regex-' + idx + '" /> Regex</label>' +
    '</div>' +
    '<div class="ed-find-replace-row">' +
      '<input type="text" class="ed-find-replace" id="ed-find-replace-' + idx + '" placeholder="' + T('editorReplace') + '..." />' +
      '<button class="ed-btn ed-btn-xs ed-find-replace-one" id="ed-find-replace-one-' + idx + '">' + T('editorReplace') + '</button>' +
      '<button class="ed-btn ed-btn-xs ed-find-replace-all" id="ed-find-replace-all-' + idx + '">' + T('editorReplaceAll') + '</button>' +
    '</div>';

  // Bind events
  var input = container.querySelector('#ed-find-input-' + idx);
  if (input) {
    input.addEventListener('input', function() { edFindUpdate(idx); });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) edFindPrev(idx); else edFindNext(idx); }
      if (e.key === 'Escape') edCloseFind();
    });
  }
  container.querySelector('#ed-find-prev-' + idx).addEventListener('click', function() { edFindPrev(idx); });
  container.querySelector('#ed-find-next-' + idx).addEventListener('click', function() { edFindNext(idx); });
  container.querySelector('#ed-find-case-' + idx).addEventListener('change', function() { edFindUpdate(idx); });
  container.querySelector('#ed-find-regex-' + idx).addEventListener('change', function() { edFindUpdate(idx); });
  container.querySelector('#ed-find-replace-one-' + idx).addEventListener('click', function() { edFindReplace(idx); });
  container.querySelector('#ed-find-replace-all-' + idx).addEventListener('click', function() { edFindReplaceAll(idx); });

  if (editorState.find.visible) {
    setTimeout(function() { if (input) input.focus(); }, 50);
  }
}

function edToggleFind(showReplace) {
  editorState.find.visible = !editorState.find.visible;
  for (var i = 0; i < 2; i++) {
    var fb = document.getElementById('ed-find-bar-' + i);
    if (fb) {
      fb.classList.toggle('ed-hidden', !editorState.find.visible);
      // Show/hide replace row
      var rr = fb.querySelector('.ed-find-replace-row');
      if (rr) rr.style.display = showReplace ? '' : 'none';
    }
  }
  if (editorState.find.visible) {
    // Focus find input in focused pane
    var fi = document.getElementById('ed-find-input-' + editorState.focused);
    if (fi) { fi.focus(); fi.select(); }
  }
}

function edCloseFind() {
  editorState.find.visible = false;
  for (var i = 0; i < 2; i++) {
    var fb = document.getElementById('ed-find-bar-' + i);
    if (fb) fb.classList.add('ed-hidden');
  }
}

function edFindUpdate(idx) {
  var input = document.getElementById('ed-find-input-' + idx);
  if (!input) return;
  var query = input.value;
  if (!query) {
    var countEl = document.getElementById('ed-find-count-' + idx);
    if (countEl) countEl.textContent = '';
    return;
  }
  var caseSens = document.getElementById('ed-find-case-' + idx).checked;
  var regex = document.getElementById('ed-find-regex-' + idx).checked;
  var ta = document.getElementById('ed-input-' + idx);
  if (!ta) return;

  var flags = 'g' + (caseSens ? '' : 'i');
  var pattern;
  try {
    pattern = regex ? new RegExp(query, flags) : new RegExp(edEscapeRegex(query), flags);
  } catch (e) {
    var countEl2 = document.getElementById('ed-find-count-' + idx);
    if (countEl2) countEl2.textContent = '0/0';
    return;
  }

  var matches = [];
  var match;
  while ((match = pattern.exec(ta.value)) !== null) {
    matches.push({ index: match.index, length: match[0].length });
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
  }

  var countEl3 = document.getElementById('ed-find-count-' + idx);
  if (countEl3) countEl3.textContent = matches.length > 0 ? '1/' + matches.length : '0/0';

  editorState.find.matches = matches.length;
  editorState.find.current = 0;
  editorState._findMatches = matches;
  editorState._findIdx = idx;

  // Select first match
  if (matches.length > 0) {
    ta.focus();
    ta.setSelectionRange(matches[0].index, matches[0].index + matches[0].length);
    edScrollIntoView(ta);
  }
}

function edEscapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function edFindNext(idx) {
  var matches = editorState._findMatches;
  var fi = idx !== undefined ? idx : editorState._findIdx;
  if (!matches || matches.length === 0) return;
  var current = editorState.find.current;
  current = (current + 1) % matches.length;
  editorState.find.current = current;

  var ta = document.getElementById('ed-input-' + fi);
  if (ta) {
    ta.focus();
    ta.setSelectionRange(matches[current].index, matches[current].index + matches[current].length);
    edScrollIntoView(ta);
  }
  var countEl = document.getElementById('ed-find-count-' + fi);
  if (countEl) countEl.textContent = (current + 1) + '/' + matches.length;
}

function edFindPrev(idx) {
  var matches = editorState._findMatches;
  var fi = idx !== undefined ? idx : editorState._findIdx;
  if (!matches || matches.length === 0) return;
  var current = editorState.find.current;
  current = (current - 1 + matches.length) % matches.length;
  editorState.find.current = current;

  var ta = document.getElementById('ed-input-' + fi);
  if (ta) {
    ta.focus();
    ta.setSelectionRange(matches[current].index, matches[current].index + matches[current].length);
    edScrollIntoView(ta);
  }
  var countEl = document.getElementById('ed-find-count-' + fi);
  if (countEl) countEl.textContent = (current + 1) + '/' + matches.length;
}

// edScrollIntoView scrolls the textarea so the current selection start sits
// near the top third of the viewport, instead of the earlier crude "jump to
// bottom" hack. It measures the pixel height of the text preceding the
// selection via a hidden mirror div that mirrors the textarea's wrapping, so
// it stays correct for auto-wrapped lines (no per-line-height constant needed).
function edScrollIntoView(ta) {
  var pos = ta.selectionStart;
  if (pos == null || pos < 0) pos = 0;
  // Build (or reuse) a hidden mirror of this textarea to measure text height.
  var mirror = ta._edScrollMirror;
  if (!mirror || mirror.ownerDocument !== ta.ownerDocument) {
    mirror = ta.ownerDocument.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';
    mirror.style.zIndex = '-1';
    ta.ownerDocument.body.appendChild(mirror);
    ta._edScrollMirror = mirror;
  }
  // Sync styles that affect wrapping/layout with the textarea.
  var cs = (ta.ownerDocument.defaultView || window).getComputedStyle(ta);
  mirror.style.font = cs.font;
  mirror.style.fontFamily = cs.fontFamily;
  mirror.style.fontSize = cs.fontSize;
  mirror.style.fontWeight = cs.fontWeight;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.tabSize = cs.tabSize;
  mirror.style.boxSizing = cs.boxSizing;
  mirror.style.paddingLeft = cs.paddingLeft;
  mirror.style.paddingRight = cs.paddingRight;
  mirror.style.width = ta.clientWidth + 'px';
  // Measure the height of the text up to the selection start by rendering the
  // prefix plus a zero-width marker line; the marker's offsetTop is the
  // pixel offset of the selection within the (wrapped) content.
  mirror.textContent = '';
  var prefix = ta.value.slice(0, pos);
  var textNode = ta.ownerDocument.createTextNode(prefix);
  mirror.appendChild(textNode);
  var marker = ta.ownerDocument.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  var offset = marker.offsetTop - mirror.offsetTop;
  // Target: selection line at ~1/3 of the visible height, clamped to valid range.
  var target = offset - Math.round(ta.clientHeight / 3);
  var max = Math.max(0, ta.scrollHeight - ta.clientHeight);
  ta.scrollTop = Math.max(0, Math.min(target, max));
  // Also ensure keyboard focus is on the textarea so the caret is active.
  try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
}

function edFindReplace(idx) {
  var replaceInput = document.getElementById('ed-find-replace-' + idx);
  if (!replaceInput) return;
  var replaceText = replaceInput.value;
  var ta = document.getElementById('ed-input-' + idx);
  if (!ta) return;
  var start = ta.selectionStart;
  var end = ta.selectionEnd;
  if (start !== end) {
    ta.value = ta.value.substring(0, start) + replaceText + ta.value.substring(end);
    ta.selectionStart = start + replaceText.length;
    ta.selectionEnd = ta.selectionStart;
    edOnInput(idx);
    edFindUpdate(idx);
  }
}

function edFindReplaceAll(idx) {
  var input = document.getElementById('ed-find-input-' + idx);
  var replaceInput = document.getElementById('ed-find-replace-' + idx);
  if (!input || !replaceInput) return;
  var query = input.value;
  var replaceText = replaceInput.value;
  if (!query) return;
  var caseSens = document.getElementById('ed-find-case-' + idx).checked;
  var regex = document.getElementById('ed-find-regex-' + idx).checked;
  var ta = document.getElementById('ed-input-' + idx);
  if (!ta) return;

  var flags = 'g' + (caseSens ? '' : 'i');
  var pattern;
  try {
    pattern = regex ? new RegExp(query, flags) : new RegExp(edEscapeRegex(query), flags);
  } catch (e) { return; }

  ta.value = ta.value.replace(pattern, replaceText);
  edOnInput(idx);
  edFindUpdate(idx);
}

// ===================== go to line =====================

function edGoToLine() {
  var lineStr = window.prompt(T('editorGoToLinePrompt'));
  if (!lineStr) return;
  var lineNum = parseInt(lineStr, 10);
  if (isNaN(lineNum) || lineNum < 1) return;

  var idx = editorState.focused;
  var ta = document.getElementById('ed-input-' + idx);
  if (!ta) return;

  var lines = ta.value.split('\n');
  if (lineNum > lines.length) lineNum = lines.length;
  var pos = 0;
  for (var i = 0; i < lineNum - 1; i++) {
    pos += lines[i].length + 1; // +1 for \n
  }
  ta.focus();
  ta.setSelectionRange(pos, pos);
  edScrollIntoView(ta);
}

// ===================== exported API =====================

window.editorAlignedDiff = editorAlignedDiff;
