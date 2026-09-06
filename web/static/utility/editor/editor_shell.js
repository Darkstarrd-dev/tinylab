// editor_shell.js — local StackEdit-style Utility Editor shell.
// Loaded after editor.js so the legacy diff/file helpers remain available.
(function (global) {
  'use strict';

  if (!global || !global.document || !global.EditorLayout || !global.EditorWorkspace) return;

  var legacyRender = global.renderEditor;
  var legacyCleanup = global.cleanupEditor;
  var legacySuspend = global.suspendEditor;
  if (!global.renderLegacyEditor) global.renderLegacyEditor = legacyRender;

  var shellRoot = null;
  var shellContainer = null;
  var shellHandlers = null;
  var shellState = {
    selectedId: null,
    selectedNode: null,
    currentId: null,
    currentNode: null,
    original: '',
    dirty: false,
    mode: 'edit',
    reader: false,
    focus: false,
    preview: true,
    sync: true,
    toc: true,
    explorer: true,
    htmlRender: false,
    expanded: []
  };
  var shellFind = { visible: false, query: '', replace: '', index: 0, matches: [] };

  // Input scheduling: per-keystroke work must stay cheap. Heavy preview
  // rendering is debounced (markdown 250ms, html-iframe 700ms), drafts are
  // debounced separately (800ms), and byte-identical content never
  // re-renders. Explicit actions (open/save/undo/toggle) keep going through
  // the synchronous redraw() path below; only the input event is deferred.
  var shellRender = { timer: 0, draftTimer: 0, lastHash: null, lastHtml: null };
  // IME perf ring buffer: records the last 32 composition/input timings so
  // a real (not synthetic) IME stall can be measured in-page. Exposed as
  // window.__edImePerf; each entry is [phase, ms] where phase is one of
  // 'comp-start' | 'comp-input' | 'comp-end' | 'input'.
  var edImePerf = [];
  function edImeMark(phase, ms) {
    try {
      edImePerf.push([phase, Math.round(ms * 10) / 10]);
      if (edImePerf.length > 32) edImePerf.splice(0, edImePerf.length - 32);
      if (typeof window !== 'undefined') window.__edImePerf = edImePerf;
    } catch (ePerf) {}
  }
  // Shared composition state, visible to every handler in this module.
  // Browser hint: compositor heartbeat (trace rounds 5-6) shows 400-1000ms
  // BeginFrame gaps while composition runs with zero DOM churn; the blind
  // tick below keeps frames flowing instead of freezing mid-stroke.
  var shellComposing = false;
  // IME window (round 16, viewport-anchored): on docs past
  // IME_WIN_LINES/IME_WIN_BYTES, the session swaps the textarea to the
  // visible viewport ∪ caret line ± IME_WIN_PAD so the browser lays out
  // ~150 lines per candidate keystroke instead of 2000 (input-gap 1→3s
  // linear while handlers run 0.1ms; A/B round 15 proved the window is the
  // only freeze cure). The old ±8-line caret window visibly reflowed the
  // doc (transparent textarea IS the display surface): window text painted
  // against wrong gutter lines and the scrollHeight collapse desynced the
  // viewport. The viewport window keeps every visible line plus the caret
  // on screen with pixel-identical scrollTop, so the session is visually
  // a no-op. The window replaces the [winStart, winStart+winInitLen) span
  // on commit; text outside is untouched, splice-back exact. Small docs
  // skip windowing (blind-tick path, verified fine at 300 lines).
  var IME_WIN_LINES = 500;
  var IME_WIN_BYTES = 50 * 1024;
  var IME_WIN_PAD = 60;
  var imeWin = null;
  // Pin the caret into the visible viewport after a window splice-back.
  // Logical-line estimate for mid-doc carets; an at-end caret pins to the
  // true bottom (exact regardless of wrapping).
  function edEnsureCaretVisible(input, caret) {
    if (!input) return;
    var text = input.value;
    var pos = (typeof caret === 'number' && caret >= 0) ? caret : text.length;
    var vh = input.clientHeight || 0;
    if (vh <= 0) return;
    if (pos >= text.length - 1) {
      input.scrollTop = Math.max(0, input.scrollHeight - vh);
      return;
    }
    var lh = 19.5;
    try {
      var cs = input.ownerDocument.defaultView.getComputedStyle(input);
      var plh = parseFloat(cs.lineHeight);
      if (plh > 0) lh = plh;
    } catch (eLH) {}
    var line = 1;
    var idx = -1;
    while ((idx = text.indexOf('\n', idx + 1)) >= 0 && idx < pos) line++;
    var caretTop = (line - 1) * lh;
    var st = input.scrollTop;
    if (caretTop < st) input.scrollTop = Math.max(0, caretTop - lh);
    else if (caretTop + lh > st + vh) input.scrollTop = Math.max(0, caretTop - vh + lh * 2);
  }
  // Round 16: viewport-anchored window re-enabled (round-15 A/B: no window
  // → freeze returns with input-gap 2-4.8s; ±8-line window → jump). All
  // other session guards stay (overlay display:none, gutter hidden+sliced,
  // pre-wrap, blind tick).
  var IME_WIN_ENABLED = true;
  function imeWindowOpen(input) {
    if (!IME_WIN_ENABLED) return false;
    var full = input.value;
    var lines = 1;
    var idx = -1;
    var big = full.length >= IME_WIN_BYTES;
    if (!big) {
      while ((idx = full.indexOf('\n', idx + 1)) >= 0) {
        if (++lines >= IME_WIN_LINES) break;
      }
      big = lines >= IME_WIN_LINES;
    }
    if (!big) return false;
    var caret = typeof input.selectionStart === 'number' ? input.selectionStart : full.length;
    var caretEnd = typeof input.selectionEnd === 'number' ? input.selectionEnd : caret;
    // Viewport-anchored range: visible run ∪ caret line, ±PAD, snapped to
    // line boundaries. Line-height estimated from computed style (wrap
    // error only shifts the pad, never correctness: splice-back is by
    // character offsets, scroll restore below is re-pinned by
    // edEnsureCaretVisible on commit).
    var st0 = input.scrollTop || 0;
    var sl0 = input.scrollLeft || 0;
    var lh0 = 19.5;
    try {
      var cs0 = input.ownerDocument.defaultView.getComputedStyle(input);
      var plh0 = parseFloat(cs0.lineHeight);
      if (plh0 > 0) lh0 = plh0;
      else { var fs0 = parseFloat(cs0.fontSize); if (fs0 > 0) lh0 = fs0 * 1.5; }
    } catch (eLH0) {}
    var vh0 = input.clientHeight || 0;
    if (vh0 <= 0) { try { vh0 = input.ownerDocument.defaultView.innerHeight || 600; } catch (eVH0) { vh0 = 600; } }
    var caretLine = 1;
    var ci = -1;
    while ((ci = full.indexOf('\n', ci + 1)) >= 0 && ci < caret) caretLine++;
    var totalLines = 1;
    var ni = -1;
    while ((ni = full.indexOf('\n', ni + 1)) >= 0) totalLines++;
    var vStart = Math.floor(st0 / lh0) + 1;
    if (vStart < 1) vStart = 1;
    var vEnd = Math.ceil((st0 + vh0) / lh0) + 1;
    if (vEnd > totalLines) vEnd = totalLines;
    var winTopLine = Math.min(vStart, caretLine) - IME_WIN_PAD;
    if (winTopLine < 1) winTopLine = 1;
    var winBotLine = Math.max(vEnd, caretLine) + IME_WIN_PAD;
    if (winBotLine > totalLines) winBotLine = totalLines;
    var winStart = 0;
    if (winTopLine > 1) {
      var n = 0;
      var p = -1;
      while (n < winTopLine - 1) { p = full.indexOf('\n', p + 1); if (p < 0) break; n++; }
      winStart = p + 1;
    }
    var winEnd = full.length;
    if (winBotLine < totalLines) {
      var m = 0;
      var q = -1;
      while (m < winBotLine) { q = full.indexOf('\n', q + 1); if (q < 0) break; m++; }
      if (q >= 0) winEnd = q;
    }
    imeWin = {
      full: full,
      winStart: winStart,
      winInitLen: winEnd - winStart,
      caretStart: caret,
      caretEnd: caretEnd,
      scrollTop: st0,
      scrollLeft: sl0
    };
    input.value = full.slice(winStart, winEnd);
    try {
      input.setSelectionRange(caret - winStart, caretEnd - winStart);
    } catch (eSel) {}
    // Pixel-identical viewport: the window top sits (winTopLine-1)*lh px
    // into the full doc, so subtract it to keep the same lines on screen.
    // The caret stays visible by construction (inside viewport ∪ pad).
    try {
      input.scrollTop = Math.max(0, st0 - (winTopLine - 1) * lh0);
      input.scrollLeft = sl0;
    } catch (eWinScroll) {}
    // The value swap collapses scrollHeight; some hosts (WebView2) fire a
    // deferred caret-reveal that yanks the viewport to the window top and
    // sticks there (blank viewport / composition painted mid-screen). A
    // trailing rAF pass re-pins the conserved offset after that reveal.
    if (typeof requestAnimationFrame === 'function') {
      (function (el, wantTop, wantLeft) {
        requestAnimationFrame(function () {
          if (!imeWin) return;
          try {
            if (Math.abs(el.scrollTop - wantTop) > 2) el.scrollTop = wantTop;
            if (Math.abs(el.scrollLeft - wantLeft) > 2) el.scrollLeft = wantLeft;
          } catch (eWinPin) {}
        });
      })(input, Math.max(0, st0 - (winTopLine - 1) * lh0), sl0);
    }
    // No gutter/overlay sync here: both are display:none/content-hidden for
    // the session (is-typing/is-composing), and the commit path re-syncs
    // after splice-back. Syncing now would pay a full-doc highlight for a
    // hidden subtree (measured 37ms of the 40ms comp-start in CDP test).
    // No record here: pushing the window text would poison the undo
    // stack (post-session Ctrl+Z would "restore" 17 lines over the full
    // doc). In-session undo stays with the IME itself (see onKey guard).
    return true;
  }
  function imeWindowCommit(input) {
    if (!imeWin) return false;
    var winText = input.value;
    var w = imeWin;
    imeWin = null;
    var full = w.full.slice(0, w.winStart) + winText + w.full.slice(w.winStart + w.winInitLen);
    input.value = full;
    var caret = w.winStart + winText.length;
    try {
      input.setSelectionRange(caret, caret);
    } catch (eSel) {}
    try {
      input.scrollTop = w.scrollTop;
      input.scrollLeft = w.scrollLeft;
    } catch (eScroll) {}
    // The window swap collapses scrollHeight, so the browser's own async
    // caret-reveal can land mid-doc and stick (bottom caret invisible,
    // viewport frozen at the old reveal). Restore the old offset first,
    // then pin the caret visible; a trailing rAF pass wins the race with
    // the browser's deferred reveal.
    try { edEnsureCaretVisible(input, caret); } catch (ePin) {}
    if (typeof requestAnimationFrame === 'function') {
      (function (el, pos) {
        requestAnimationFrame(function () {
          if (imeWin) return;
          try { edEnsureCaretVisible(el, pos); } catch (ePin2) {}
        });
      })(input, caret);
    }
    if (global.EditorCommands) global.EditorCommands.record(input);
    // Gutter/overlay ride the debounced preview pass (300ms): syncing here
    // would force a full-doc split+highlight in the commit frame. Only the
    // caret/title tick runs now so the committed text is positioned.
    updateCaret();
    schedulePreview();
    return true;
  }
  function imeWindowAbort(input) {
    if (!imeWin) return;
    var w = imeWin;
    imeWin = null;
    input.value = w.full;
    try {
      input.setSelectionRange(w.caretStart, w.caretEnd);
    } catch (eSel) {}
    try {
      input.scrollTop = w.scrollTop;
      input.scrollLeft = w.scrollLeft;
    } catch (eScroll) {}
    try { edEnsureCaretVisible(input, w.caretStart); } catch (ePinA) {}
  }
  // edImeHeartbeat: zero-cost compositor signal. A bare rAF request keeps
  // BeginFrames flowing during an IME session without touching the DOM,
  // style, or layout at all. Re-armed per input so long sessions (22+
  // pending chars) never stall on a spent frame; coalesced by the browser
  // so rapid keystrokes cost one pending callback at a time.
  var edImeBeatPending = false;
  function edImeHeartbeat() {
    if (edImeBeatPending) return;
    if (typeof requestAnimationFrame !== 'function') return;
    edImeBeatPending = true;
    try {
      // Frame-gap forensics: record the interval between delivered frames
      // so a real IME freeze shows whether the compositor stopped emitting
      // frames (>100ms gaps) or kept emitting while input starved.
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      requestAnimationFrame(function () {
        edImeBeatPending = false;
        if (t0) {
          var now = performance.now();
          var last = edImeHeartbeat._last || 0;
          if (last && now - last > 100) edImeMark('frame-gap', now - last);
          edImeHeartbeat._last = now;
        }
      });
    } catch (eBeat) { edImeBeatPending = false; }
  }
  function edHashStr(value) {
    var text = value == null ? '' : String(value);
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 0x01000193) | 0;
    }
    return (hash >>> 0).toString(36) + ':' + text.length;
  }
  function previewVisible() {
    return !!(shellState.preview || shellState.reader);
  }
  function currentIsHtml() {
    if (shellState.htmlRender) return true;
    var ext = shellState.currentNode ? edFileExt(shellState.currentNode.name) : 'md';
    return typeof edIsHtmlExt === 'function' ? edIsHtmlExt(ext) : (ext === 'html' || ext === 'htm');
  }
  function scheduleDraft(id, content) {
    if (!id) return;
    if (shellRender.draftTimer) { try { clearTimeout(shellRender.draftTimer); } catch (e) {} shellRender.draftTimer = 0; }
    shellRender.draftTimer = setTimeout(function () {
      shellRender.draftTimer = 0;
      // Never persist mid-session: the 800ms draft timer can land inside an
      // IME session on 2000-line docs (JSON.stringify + localStorage write
      // on the main thread while TSF owns the caret). Re-arm after the
      // session ends instead of dropping the write.
      if (shellComposing) {
        shellRender.draftTimer = setTimeout(function () {
          shellRender.draftTimer = 0;
          if (!shellComposing) scheduleDraftIdle(id, content);
          else scheduleDraft(id, content);
        }, 800);
        return;
      }
      scheduleDraftIdle(id, content);
    }, 800);
  }
  function schedulePreview() {
    if (shellRender.timer) { try { clearTimeout(shellRender.timer); } catch (e) {} shellRender.timer = 0; }
    // Stop-to-render: the preview only refreshes after keystrokes settle
    // (markdown 300ms, html-iframe 1200ms), never mid-burst. The typing
    // passthrough class (see onInput) keeps real glyphs visible meanwhile.
    var delay = currentIsHtml() ? 1200 : 300;
    shellRender.timer = setTimeout(function () {
      shellRender.timer = 0;
      if (shellState.mode === 'diff') renderDiff(); else renderPreview();
    }, delay);
  }
  function setTyping(on) {
    if (!shellRoot) return;
    var wrap = shellRoot.querySelector('.ed-input-wrap');
    if (!wrap) return;
    if (on) wrap.classList.add('is-typing');
    else wrap.classList.remove('is-typing');
  }
  function setComposing(on) {
    if (!shellRoot) return;
    var wrap = shellRoot.querySelector('.ed-input-wrap');
    if (!wrap) return;
    if (on) wrap.classList.add('is-composing');
    else wrap.classList.remove('is-composing');
  }
  function cancelScheduled() {
    if (shellRender.timer) { try { clearTimeout(shellRender.timer); } catch (e) {} shellRender.timer = 0; }
    if (shellRender.draftTimer) { try { clearTimeout(shellRender.draftTimer); } catch (e) {} shellRender.draftTimer = 0; }
    setTyping(false);
    setComposing(false);
  }

  // Large-document budget: past ~1500 lines / 150KB the heavy post-pass
  // (hljs full-document scan + per-block hashing, mermaid SVG layout) is
  // what freezes the window, so it is skipped and diagrams degrade to
  // click-to-render placeholders. marked+sanitize still run (pure text).
  var ED_LARGE_LINES = 1500;
  var ED_LARGE_BYTES = 150 * 1024;
  function edIsLargeDoc(content) {
    var text = content == null ? '' : String(content);
    if (text.length >= ED_LARGE_BYTES) return true;
    var lines = 1;
    var idx = -1;
    while ((idx = text.indexOf('\n', idx + 1)) >= 0) {
      if (++lines >= ED_LARGE_LINES) return true;
    }
    return false;
  }

  function installFilePickerKeyLock() {
    if (global.__editorFilePickerKeyLockInstalled) return;
    var block = function (event) {
      if (!global.__editorFilePickerBusy) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    global.addEventListener('keydown', block, true);
    global.addEventListener('keyup', block, true);
    global.addEventListener('keypress', block, true);
    global.__editorFilePickerKeyLockInstalled = true;
  }
  installFilePickerKeyLock();

  function text(value) { return value == null ? '' : String(value); }
  function tr(key, fallback) {
    try { return typeof global.edT === 'function' ? (global.edT(key) || fallback) : fallback; } catch (e) { return fallback; }
  }
  function safe(fn) { try { return fn(); } catch (e) { return null; } }
  function promise(value) { return value && typeof value.then === 'function' ? value : Promise.resolve(value); }
  function toast(message, type) { if (typeof global.toast === 'function') global.toast(message, type || 'info'); }

  function nodeMap(nodes) {
    var map = Object.create(null);
    (nodes || []).forEach(function (node) { if (node && node.id && !node.deleted) map[node.id] = node; });
    return map;
  }

  function buildTree(nodes) {
    var map = nodeMap(nodes);
    var roots = [];
    (nodes || []).forEach(function (node) {
      if (!node || node.deleted) return;
      node.children = [];
    });
    (nodes || []).forEach(function (node) {
      if (!node || node.deleted) return;
      var copy = Object.assign({}, node);
      copy.children = [];
      map[node.id] = copy;
    });
    Object.keys(map).forEach(function (id) {
      var node = map[id];
      if (node.parentId && map[node.parentId] && node.parentId !== node.id) map[node.parentId].children.push(node);
      else roots.push(node);
    });
    // Sibling dedupe: after an unclean shutdown the backend can return two
    // live nodes with different ids but the same (parentId, name) — e.g. a
    // retried create plus its orphan. Both would render as identical rows
    // that edit the same underlying file. Keep the first, drop the rest,
    // and warn with both ids so the backend root cause stays locatable.
    (function dedupeSiblings(list) {
      var seen = Object.create(null);
      for (var i = list.length - 1; i >= 0; i--) {
        var n = list[i];
        var key = (n.parentId || '') + '\n' + (n.name || '');
        if (seen[key]) {
          try {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[editor] duplicate tree node hidden: kept id=' + seen[key].id + ' dropped id=' + n.id + ' name=' + n.name);
            }
          } catch (eWarn) {}
          list.splice(i, 1);
        } else {
          seen[key] = n;
        }
      }
      for (var j = 0; j < list.length; j++) {
        if (list[j] && list[j].children) dedupeSiblings(list[j].children);
      }
    })(roots);
    var expanded = Object.create(null);
    (shellState.expanded || []).forEach(function (id) { expanded[id] = true; });
    function finish(node) {
      node.children.sort(function (a, b) { return (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'folder' ? -1 : 1)); });
      node.expanded = node.type === 'folder' ? expanded[node.id] === true : false;
      node.children.forEach(finish);
      return node;
    }
    roots.forEach(finish);
    roots.sort(function (a, b) { return (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'folder' ? -1 : 1)); });
    return roots;
  }

  function currentInput() { return shellRoot && shellRoot.querySelector('#ed-main-input'); }
  function currentText() { var input = currentInput(); return input ? input.value : ''; }
  function updateOverlay() {
    if (global.EditorLayout && typeof global.EditorLayout.updateOverlay === 'function') {
      global.EditorLayout.updateOverlay(shellRoot);
    }
  }

  function syncOverlayScroll() {
    if (global.EditorLayout && typeof global.EditorLayout.syncOverlayScroll === 'function') {
      global.EditorLayout.syncOverlayScroll(shellRoot);
    }
  }

  function updateGutter(withOverlay) {
    if (!shellRoot) return;
    var gutter = shellRoot.querySelector('#ed-line-gutter');
    var input = currentInput();
    if (!gutter || !input) return;
    if (global.EditorLayout && typeof global.EditorLayout.syncGutter === 'function') {
      // Pass the textarea's real scroll range: wrapped long lines inflate
      // scrollHeight far beyond count*lh, so the gutter must position its
      // window by scroll ratio, not by st/lh (which pins the gutter early
      // near the bottom while the textarea keeps scrolling).
      var sh = 0, ch = 0;
      try { sh = input.scrollHeight; ch = input.clientHeight; } catch (eRange) {}
      global.EditorLayout.syncGutter(gutter, input.value, { scrollTop: input.scrollTop, scrollHeight: sh, clientHeight: ch });
    }
    // The comment overlay re-highlights the full text; it rides the debounced
    // preview pass, not the per-keystroke path. Explicit callers (open, undo,
    // file switch) pass withOverlay !== false for an immediate sync.
    if (withOverlay !== false) updateOverlay();
  }

  function renderToc(preview) {
    if (!shellRoot || !preview) return;
    var list = shellRoot.querySelector('.ed-toc-list');
    if (!list) return;
    list.innerHTML = '';
    var toc = [];
    var iframe = preview.querySelector('iframe');
    if (iframe) {
      // The preview iframe is zero-permission sandboxed (opaque origin), so
      // contentDocument is not readable. Parse the raw HTML in the parent
      // with DOMParser instead — it executes no scripts — and build the TOC
      // from the parsed body.
      try {
        var doc = new DOMParser().parseFromString(currentText(), 'text/html');
        if (doc && doc.body) {
          toc = global.EditorMarkdown.buildToc(doc.body);
        }
      } catch (e) {}
    } else {
      toc = global.EditorMarkdown.buildToc(preview);
    }
    toc.forEach(function (entry) {
      var li = global.document.createElement('li');
      li.className = 'ed-toc-item ed-toc-level-' + entry.level;
      var a = global.document.createElement('a');
      a.href = '#' + entry.id;
      a.textContent = entry.text;
      a.dataset.tocId = entry.id;
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  function renderPreview() {
    if (!shellRoot) return;
    var preview = shellRoot.querySelector('#ed-main-preview');
    if (!preview) return;
    var content = currentText();
    if (!previewVisible()) {
      // Edit-only mode: skip the expensive render entirely; null the hash
      // so showing the preview again forces a fresh render.
      shellRender.lastHash = null;
      updateStatus();
      updateOverlay();
      setTyping(false);
      setComposing(false);
      return;
    }
    var ext = shellState.currentNode ? edFileExt(shellState.currentNode.name) : 'md';
    var isHtml = typeof edIsHtmlExt === 'function' ? edIsHtmlExt(ext) : (ext === 'html' || ext === 'htm');
    var useHtmlBranch = !!(shellState.htmlRender || isHtml);
    // Byte-identical content (including the md/html branch flag, so the
    // html-iframe toggle always re-renders) never re-renders.
    var hash = edHashStr((useHtmlBranch ? 'H' : 'M') + '\n' + content);
    // Hash hit: nothing to re-render, but the typing passthrough must still
    // be lifted or the overlay stays display:none forever (e.g. a
    // compositionend whose committed text matches the last rendered hash).
    if (hash === shellRender.lastHash) { setTyping(false); setComposing(false); return; }
    shellRender.lastHash = hash;
    // Generation token: a newer keystroke schedule cancels this pass's
    // second frame (heavy post-pass) so stale work never lands.
    var gen = (shellRender.generation = (shellRender.generation || 0) + 1);

    if (useHtmlBranch) {
      preview.innerHTML = '';
      preview.classList.add('is-html-iframe-mode');
      var iframe = document.createElement('iframe');
      iframe.className = 'ed-iframe-preview';
      // Keep the iframe zero-permissioned and remove executable elements from
      // srcdoc. This avoids the sandbox warning while preserving the visual DOM.
      iframe.setAttribute('sandbox', '');
      iframe.setAttribute('allowtransparency', 'true');
      iframe.style.cssText = 'width:100%; height:100%; border:none; background:transparent; display:block;';

      var themedDoc = content || '';
      if (themedDoc.indexOf('<html') < 0 && themedDoc.indexOf('<body') < 0) {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
                     document.body.classList.contains('dark-theme');
        themedDoc = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
          '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:16px;color:' + (isDark ? '#e2e8f0' : '#1e293b') + ';background:transparent;}</style>' +
          '</head><body>' + themedDoc + '</body></html>';
      }
      themedDoc = themedDoc.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<script\b[^>]*\/?>/gi, '')
        .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
      iframe.onload = function () { renderToc(preview); };
      iframe.srcdoc = themedDoc;
      preview.appendChild(iframe);
      renderToc(preview);
      updateStatus();
      updateOverlay();
      setTyping(false);
      setComposing(false);
      return;
    }

    // Frame 1 (sync, cheap): marked+sanitize text pass only. Frame 2
    // (rAF-deferred, heavy): hljs/mermaid post-pass + TOC + stats + overlay.
    // Textarea input events get a chance to run between the frames, and a
    // superseding keystroke (generation mismatch) drops frame 2 entirely.
    var large = edIsLargeDoc(content);
    try {
      preview.classList.remove('is-html-iframe-mode');
      var html = global.EditorMarkdown.renderMarkdown(content);
      preview.innerHTML = html;
    } catch (eText) {
      preview.innerHTML = '<p><em>Preview unavailable for this content.</em></p>';
      updateStatus();
      updateOverlay();
      setTyping(false);
      setComposing(false);
      return;
    }
    var runHeavy = function () {
      if (gen !== shellRender.generation) return; // superseded by newer input
      try {
        global.EditorMarkdown.highlightCode(preview, { skipHeavy: large });
        renderToc(preview);
      } catch (eHeavy) {}
      try { updateStatus(); } catch (eStatus) {}
      try { updateOverlay(); } catch (eOverlay) {}
      setTyping(false);
      setComposing(false);
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { requestAnimationFrame(runHeavy); });
    } else {
      setTimeout(runHeavy, 0);
    }
  }

  function updateStatus() {
    if (!shellRoot) return;
    var input = currentInput();
    var content = input ? input.value : '';
    var preview = shellRoot.querySelector('#ed-main-preview');
    var stats = global.EditorMarkdown.getStats(content, preview ? preview.innerHTML : '');
    var selStart = input ? (input.selectionStart || 0) : 0;
    var selEnd = input ? (input.selectionEnd || 0) : 0;
    // Line number without slicing the whole prefix: count breaks only up to
    // the caret. No allocation of the before-caret substring.
    var line = 1;
    if (input) {
      var brk = -1;
      for (;;) {
        brk = content.indexOf('\n', brk + 1);
        if (brk < 0 || brk >= selStart) break;
        line++;
      }
    }
    // O(caret-line): lastIndexOf with a start position scans only back to
    // the current line's break instead of slicing/scanning the whole doc.
    var column = input ? selStart - (content.lastIndexOf('\n', selStart - 1) + 1) : 0;
    var dirty = content !== shellState.original;
    shellState.dirty = dirty;
    var textSel = selStart !== selEnd;
    global.EditorLayout.updateTitle(shellRoot, shellState.currentNode && shellState.currentNode.name, dirty);
    global.EditorLayout.updateStatus(shellRoot, {
      textSelection: textSel,
      bytes: stats.bytes,
      words: stats.words,
      lines: stats.lines,
      line: line,
      column: column,
      chars: stats.chars,
      paragraphs: stats.paragraphs
    });
  }
  // updateCaret: the only status work allowed per keystroke. No getStats
  // (which re-parses preview.innerHTML into a throwaway div), no title
  // reflow beyond the dirty marker. Full counts arrive with the debounced
  // renderPreview pass via updateStatus().
  function updateCaret() {
    if (!shellRoot) return;
    var input = currentInput();
    var content = input ? input.value : '';
    var selStart = input ? (input.selectionStart || 0) : 0;
    var selEnd = input ? (input.selectionEnd || 0) : 0;
    shellRender.lastCaretSelStart = selStart;
    shellRender.lastCaretSelEnd = selEnd;
    // O(caret): count breaks only up to the caret, no before-substring
    // allocation or full-prefix split. (updateStatus already uses this;
    // updateCaret was left on the old O(n) path by mistake.)
    var line = 1;
    if (input) {
      var brk = -1;
      for (;;) {
        brk = content.indexOf('\n', brk + 1);
        if (brk < 0 || brk >= selStart) break;
        line++;
      }
    }
    var column = input ? selStart - (content.lastIndexOf('\n', selStart - 1) + 1) : 0;
    var dirty = content !== shellState.original;
    shellState.dirty = dirty;
    // Skip DOM writes when nothing changed: title/status rewrites every
    // keystroke cost a reflow each, and 99% of keystrokes only move Ln/Col.
    var caretKey = (shellState.currentNode && shellState.currentNode.name) + '|' + dirty + '|' + line + '|' + column + '|' + (selStart !== selEnd);
    if (caretKey === shellRender.lastCaretKey) return;
    shellRender.lastCaretKey = caretKey;
    global.EditorLayout.updateTitle(shellRoot, shellState.currentNode && shellState.currentNode.name, dirty);
    global.EditorLayout.updateStatus(shellRoot, {
      textSelection: selStart !== selEnd,
      line: line,
      column: column
    });
  }
  function shellFindRefresh() {
    var input = currentInput();
    if (!input) return;
    var query = shellFind.query;
    var matches = [];
    if (query) {
      var start = 0;
      var value = input.value;
      while (start <= value.length) {
        var at = value.indexOf(query, start);
        if (at < 0) break;
        matches.push({ start: at, end: at + query.length });
        start = at + Math.max(1, query.length);
      }
    }
    shellFind.matches = matches;
    shellFind.index = matches.length ? Math.min(shellFind.index, matches.length - 1) : 0;
    var count = shellRoot && shellRoot.querySelector('.ed-shell-find-count');
    if (count) count.textContent = matches.length ? (shellFind.index + 1) + '/' + matches.length : '0/0';
    if (matches.length) {
      var match = matches[shellFind.index];
      input.focus();
      input.setSelectionRange(match.start, match.end);
    }
  }
  function shellFindStep(delta) {
    if (!shellFind.matches.length) shellFindRefresh();
    if (!shellFind.matches.length) return;
    shellFind.index = (shellFind.index + delta + shellFind.matches.length) % shellFind.matches.length;
    shellFindRefresh();
  }
  function shellFindToggle() {
    if (!shellRoot) return;
    var existing = shellRoot.querySelector('.ed-shell-find');
    if (existing) {
      existing.parentNode.removeChild(existing);
      shellFind.visible = false;
      shellFind.matches = [];
      return;
    }
    var bar = global.document.createElement('div');
    bar.className = 'ed-shell-find';
    var queryInput = global.document.createElement('input');
    queryInput.type = 'search';
    queryInput.placeholder = tr('editorFind', 'Find');
    queryInput.value = shellFind.query;
    var replaceInput = global.document.createElement('input');
    replaceInput.type = 'text';
    replaceInput.placeholder = tr('editorReplace', 'Replace');
    replaceInput.value = shellFind.replace;
    var count = global.document.createElement('span');
    count.className = 'ed-shell-find-count';
    var previous = global.document.createElement('button');
    previous.type = 'button';
    previous.textContent = 'Prev';
    var next = global.document.createElement('button');
    next.type = 'button';
    next.textContent = 'Next';
    var replace = global.document.createElement('button');
    replace.type = 'button';
    replace.textContent = 'Replace';
    var replaceAll = global.document.createElement('button');
    replaceAll.type = 'button';
    replaceAll.textContent = 'Replace all';
    var close = global.document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    bar.appendChild(queryInput);
    bar.appendChild(replaceInput);
    bar.appendChild(count);
    bar.appendChild(previous);
    bar.appendChild(next);
    bar.appendChild(replace);
    bar.appendChild(replaceAll);
    bar.appendChild(close);
    var split = shellRoot.querySelector('#ed-content-split');
    var main = shellRoot.querySelector('#ed-editor-main');
    if (!split || !main) return;
    main.insertBefore(bar, split);
    shellFind.visible = true;
    queryInput.addEventListener('input', function () { shellFind.query = queryInput.value; shellFind.index = 0; shellFindRefresh(); });
    replaceInput.addEventListener('input', function () { shellFind.replace = replaceInput.value; });
    previous.addEventListener('click', function () { shellFindStep(-1); });
    next.addEventListener('click', function () { shellFindStep(1); });
    replace.addEventListener('click', function () {
      var input = currentInput();
      if (!input || !shellFind.query) return;
      shellFindRefresh();
      if (!shellFind.matches.length) return;
      var match = shellFind.matches[shellFind.index];
      input.value = input.value.slice(0, match.start) + shellFind.replace + input.value.slice(match.end);
      input.setSelectionRange(match.start, match.start + shellFind.replace.length);
      input.dispatchEvent(new global.Event('input', { bubbles: true }));
      shellFindRefresh();
    });
    replaceAll.addEventListener('click', function () {
      var input = currentInput();
      if (!input || !shellFind.query) return;
      input.value = input.value.split(shellFind.query).join(shellFind.replace);
      input.dispatchEvent(new global.Event('input', { bubbles: true }));
      shellFindRefresh();
    });
    close.addEventListener('click', function () { shellFindToggle(); });
    queryInput.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); shellFindStep(event.shiftKey ? -1 : 1); } else if (event.key === 'Escape') { event.preventDefault(); shellFindToggle(); } });
    queryInput.focus();
    shellFindRefresh();
  }

  function renderDiff() {
    if (!shellRoot) return;
    var preview = shellRoot.querySelector('#ed-main-preview');
    if (!preview) return;
    var rows = typeof global.editorAlignedDiff === 'function' ? global.editorAlignedDiff(shellState.original, currentText()) : [];
    var html = '<div class="ed-diff-stats">' + tr('editorDiff', 'Diff') + '</div><table class="ed-diff-table"><tbody>';
    rows.forEach(function (row) {
      var left = row.left ? row.left.text : '';
      var right = row.right ? row.right.text : '';
      var cls = row.type === 'del' ? 'ed-diff-row-del' : (row.type === 'add' ? 'ed-diff-row-add' : (row.type === 'mod' ? 'ed-diff-row-mod' : 'ed-diff-row-context'));
      html += '<tr class="' + cls + '"><td class="ed-diff-num">' + (row.left ? row.left.num : '') + '</td><td class="ed-diff-cell-left">' + escapeHtml(left) + '</td><td class="ed-diff-num">' + (row.right ? row.right.num : '') + '</td><td class="ed-diff-cell-right">' + escapeHtml(right) + '</td></tr>';
    });
    html += '</tbody></table>';
    preview.innerHTML = html;
  }

  function escapeHtml(value) {
    return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return text(value).replace(/"/g, '&quot;');
  }

  function redraw() {
    if (!shellRoot) return;
    global.EditorLayout.setMode(shellRoot, shellState.mode);
    global.EditorLayout.setReader(shellRoot, shellState.reader);
    global.EditorLayout.setFocus(shellRoot, shellState.focus);
    global.EditorLayout.setPreview(shellRoot, shellState.preview);
    global.EditorLayout.setExplorer(shellRoot, shellState.explorer);
    global.EditorLayout.setSync(shellRoot, shellState.sync);
    if (global.EditorLayout.updateExplorerToggleIcon) global.EditorLayout.updateExplorerToggleIcon(shellRoot, shellState.explorer !== false);
    if (shellState.mode === 'diff') renderDiff(); else renderPreview();
  }

  function syncDocDirTree() {
    return fetch('/api/editor/tree').then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.files)) return null;
      if (typeof global.EditorWorkspace.replaceDocTree === 'function') {
        return global.EditorWorkspace.replaceDocTree(data.files).then(function () { return data; });
      }
      return data;
    }).catch(function () {
      return null;
    });
  }
  var editorBootstrapped = false;
  function saveDraft(id, content) {
    if (!id) return;
    try {
      var drafts = JSON.parse(localStorage.getItem('tr_editor_drafts') || '{}');
      drafts[id] = { content: content, time: Date.now() };
      localStorage.setItem('tr_editor_drafts', JSON.stringify(drafts));
    } catch (e) {}
  }
  // Draft persistence goes through requestIdleCallback (or a 500ms
  // setTimeout fallback) so a 2000-line JSON.stringify + localStorage write
  // never lands inside an IME composition session. The latest queued write
  // wins; earlier ones are dropped by the generation counter.
  var draftIdleGen = 0;
  function scheduleDraftIdle(id, content) {
    if (!id) return;
    var gen = ++draftIdleGen;
    var run = function () {
      if (gen !== draftIdleGen) return;
      saveDraft(id, content);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 500);
  }

  function getDraft(id) {
    if (!id) return null;
    try {
      var drafts = JSON.parse(localStorage.getItem('tr_editor_drafts') || '{}');
      return drafts[id] ? drafts[id].content : null;
    } catch (e) { return null; }
  }

  function removeDraft(id) {
    if (!id) return;
    try {
      var drafts = JSON.parse(localStorage.getItem('tr_editor_drafts') || '{}');
      delete drafts[id];
      localStorage.setItem('tr_editor_drafts', JSON.stringify(drafts));
    } catch (e) {}
  }

  // editorTargetBody maps a workspace node to the backend's path-capability
  // identity: docDir files by fileId, picker-imported files by pathGrantId,
  // local-only nodes by null (audit F-02: never a raw path).
  function editorTargetBody(node) {
    if (!node) return null;
    // A native picker grant is authoritative. This matters when WebView2
    // selects a file located inside docDir: the grant still owns the selected
    // physical file and must be used for open/save/rename.
    if (node.pathGrantId) return { pathGrantId: node.pathGrantId };
    if (node.fileId) return { fileId: node.fileId };
    return null;
  }

  function loadFile(id, overrideContent) {
    if (!id) return Promise.resolve(false);
    // Windowed IME session: restore the full text before switching files, or
    // the uncommitted window (and its stashed full copy) is discarded.
    if (imeWin) {
      var loadInput = currentInput();
      if (loadInput) { try { imeWindowAbort(loadInput); } catch (eWinLoad) {} }
      else imeWin = null;
    }
    cancelScheduled();
    shellRender.lastHash = null;
    shellRender.lastCaretKey = null;
    shellState.htmlRender = false;
    return global.EditorWorkspace.getNode(id).then(function (node) {
      if (!node || node.type !== 'file') return false;
      var target = editorTargetBody(node);
      var contentPromise;
      if (typeof overrideContent === 'string') {
        global.EditorWorkspace.updateNode(id, { content: overrideContent });
        contentPromise = Promise.resolve(overrideContent);
      } else if (target) {
        contentPromise = fetch('/api/editor/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(target)
        }).then(function (res) {
          if (!res.ok) return global.EditorWorkspace.getContent(id);
          return res.json().then(function (data) {
            if (data && typeof data.content === 'string') {
              global.EditorWorkspace.updateNode(id, { content: data.content });
              return data.content;
            }
            return global.EditorWorkspace.getContent(id);
          });
        }).catch(function () {
          return global.EditorWorkspace.getContent(id);
        });
      } else {
        contentPromise = global.EditorWorkspace.getContent(id);
      }

      return contentPromise.then(function (content) {
        if ((content === '' || content === null || content === undefined) && target && typeof overrideContent !== 'string') {
          return fetch('/api/editor/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(target)
          }).then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
              var retryContent = data && typeof data.content === 'string' ? data.content : '';
              return applyContent(id, node, retryContent, overrideContent);
            }).catch(function () {
              return applyContent(id, node, '', overrideContent);
            });
        }
        return applyContent(id, node, content, overrideContent);
      });
    });
  }

  // applyContent：将解析出的文件内容填入编辑器区域并触发渲染
  function applyContent(id, node, content, overrideContent) {
    var loadedText = text(content);
    shellState.selectedId = id;
    shellState.selectedNode = node;
    shellState.currentId = id;
    shellState.currentNode = node;
    shellState.original = loadedText;
    var input = currentInput();
    var draft = getDraft(id);

    if (typeof overrideContent === 'string' || editorTargetBody(node)) {
      if (input) {
        input.value = loadedText;
      }
      shellState.dirty = false;
      removeDraft(id);
    } else if (draft !== null && draft !== shellState.original) {
      if (input) input.value = draft;
      shellState.dirty = true;
    } else {
      if (input) input.value = loadedText;
      shellState.dirty = false;
    }

    global.EditorWorkspace.setCurrentFile(id);
    if (global.EditorCommands) global.EditorCommands.clear(input);
    updateStatus();
    redraw();
    refreshTree();
    if (input) input.focus();
    return true;
  }

  function refreshTree() {
    return global.EditorWorkspace.listNodes().then(function (nodes) {
      var tree = shellRoot && shellRoot.querySelector('#ed-file-tree');
      if (tree) {
        global.EditorLayout.renderTree(tree, buildTree(nodes), {
          selectedId: shellState.selectedId || shellState.currentId,
          filterQuery: shellState.filterQuery || ''
        }, shellHooks());
      }
      return nodes;
    });
  }

  function selectedParent() {
    return shellState.selectedNode && shellState.selectedNode.type === 'folder' ? shellState.selectedNode.id : null;
  }


  function promptDialog(message, defaultValue, placeholder) {
    if (typeof global.promptModal === 'function') {
      return global.promptModal(message, defaultValue, placeholder);
    }
    return Promise.resolve(global.prompt(message, defaultValue));
  }

  function createFile() {
    promptDialog(tr('editorNewFile', 'New file'), 'untitled.md').then(function (name) {
      if (!name) return;
      var parent = selectedParent();
      // A file created at the docDir root or under a docDir folder gets a
      // docDir-relative fileId; local-only folders keep the node local.
      var parentRel = null;
      if (parent && parent.indexOf('docdir:') === 0) parentRel = parent.slice('docdir:'.length);
      else if (!parent) parentRel = '';
      var fileId = parentRel === null ? null : (parentRel ? parentRel + '/' + name : name);
      var meta = fileId !== null ? { fileId: fileId, isDoc: true } : null;
      global.EditorWorkspace.putFile(name, '', parent, meta).then(function (node) {
        if (!node) { toast('A file with that name already exists', 'warning'); return; }
        if (meta) {
          fetch('/api/editor/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId: fileId, content: '' })
          }).catch(function () {});
        }
        refreshTree().then(function () { loadFile(node.id); });
      });
    });
  }

  function createFolder() {
    promptDialog(tr('editorNewFolder', 'New folder'), 'New folder').then(function (name) {
      if (!name) return;
      global.EditorWorkspace.putFolder(name, selectedParent()).then(function (node) {
        if (node) refreshTree(); else toast('A folder with that name already exists', 'warning');
      });
    });
  }

  function renameCurrent() {
    var targetId = shellState.selectedId || shellState.currentId;
    var targetNode = shellState.selectedNode || shellState.currentNode;
    if (!targetId || !targetNode) return;
    promptDialog(tr('editorRename', 'Rename'), targetNode.name).then(function (name) {
      name = typeof name === 'string' ? name.trim() : '';
      if (!name || name === targetNode.name) return;

      var renameTarget = editorTargetBody(targetNode);
      if (!renameTarget) {
        global.EditorWorkspace.updateNode(targetId, { name: name }).then(function (node) {
          if (!node) { toast('A file with that name already exists', 'warning'); return; }
          shellState.selectedNode = node;
          if (shellState.currentId === targetId) shellState.currentNode = node;
          refreshTree();
          updateStatus();
          toast('Renamed to ' + name, 'success');
        });
        return;
      }

      fetch('/api/editor/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: renameTarget.fileId, pathGrantId: renameTarget.pathGrantId, newName: name })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok || !data || !data.ok) {
            var error = new Error((data && (data.error || data.message)) || 'Rename failed');
            error.status = response.status;
            throw error;
          }
          return data;
        });
      }).then(function (data) {
        var identity = {};
        if (data.fileId) {
          identity.fileId = data.fileId;
          identity.pathGrantId = null;
          identity.isDoc = true;
        } else if (data.pathGrantId) {
          identity.pathGrantId = data.pathGrantId;
          identity.fileId = null;
        }
        return global.EditorWorkspace.updateNode(targetId, { name: name, meta: identity }).then(function (node) {
          if (!node) throw new Error('A file with that name already exists');
          shellState.selectedNode = node;
          if (shellState.currentId === targetId) shellState.currentNode = node;
          refreshTree();
          updateStatus();
          toast('Renamed to ' + name, 'success');
        });
      }).catch(function (error) {
        toast(error && error.message ? error.message : 'Rename failed', 'error');
      });
    });
  }

  function deleteCurrent() {
    var id = shellState.selectedId || shellState.currentId;
    var node = shellState.selectedNode || shellState.currentNode;
    if (!id || !node) return;

    var overlay = document.getElementById('modal-overlay');
    if (!overlay) return;

    var fileName = node.name || 'file';
    overlay.innerHTML =
      '<div class="modal" style="max-width:480px;">' +
        '<div class="modal-title" style="color:var(--danger, #ef4444); display:flex; align-items:center; gap:8px;">' +
          '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>' +
          '<span>删除文件 / Delete File</span>' +
        '</div>' +
        '<div class="modal-body" style="margin-top:12px; font-size:13px; opacity:0.9; line-height:1.6;">' +
          '请选择对文件 <strong>' + escapeHtml(fileName) + '</strong> 的删除处理方式：' +
        '</div>' +
        '<div class="modal-footer" style="margin-top:20px; display:flex; flex-direction:column; gap:8px;">' +
          '<button type="button" class="btn btn-danger" id="del-disk-btn" style="width:100%; justify-content:center;">' +
            '🗑️ 删除磁盘文件并从 Explorer 移除 (Delete File & Remove)' +
          '</button>' +
          '<button type="button" class="btn btn-outline" id="del-discard-btn" style="width:100%; justify-content:center;">' +
            '放弃本地修改并仅从 Explorer 移除 (Discard & Remove)' +
          '</button>' +
          '<button type="button" class="btn btn-ghost" id="del-cancel-btn" style="width:100%; justify-content:center;">' +
            '取消 (Cancel)' +
          '</button>' +
        '</div>' +
      '</div>';

    overlay.classList.add('show');

    function close() {
      overlay.classList.remove('show');
      overlay.innerHTML = '';
    }

    document.getElementById('del-cancel-btn').onclick = close;

    function finishDelete() {
      removeDraft(id);
      global.EditorWorkspace.deleteNode(id).then(function () { return global.EditorWorkspace.getCurrentFileId(); }).then(function (nextId) {
        shellState.selectedId = null;
        shellState.selectedNode = null;
        return refreshTree().then(function (nodes) {
          var targetNextId = nextId;
          if (!targetNextId && nodes && nodes.length) {
            var firstFile = nodes.find(function (n) { return n && n.type === 'file'; });
            if (firstFile) targetNextId = firstFile.id;
          }
          if (targetNextId) loadFile(targetNextId);
          else {
            var input = currentInput();
            if (input) input.value = '';
            shellState.original = '';
            redraw();
          }
        });
      });
    }

    document.getElementById('del-disk-btn').onclick = function() {
      close();
      var delTarget = editorTargetBody(node);
      if (delTarget) {
        fetch('/api/editor/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(delTarget)
        }).catch(function() {});
      }
      toast('已从磁盘物理删除文件', 'info');
      finishDelete();
    };

    document.getElementById('del-discard-btn').onclick = function() {
      close();
      toast('已放弃本地修改并从 Explorer 移除记录', 'info');
      finishDelete();
    };
  }

  var editorSessionImages = [];
  var editorImageSeq = 1;

  function compressToWebp70(fileOrBlob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var img = new Image();
        img.onload = function () {
          var canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error('Canvas compression failed'));
          }, 'image/webp', 0.70);
        };
        img.onerror = function (err) { reject(err); };
        img.src = e.target.result;
      };
      reader.onerror = function (err) { reject(err); };
      reader.readAsDataURL(fileOrBlob);
    });
  }

  function addSessionImage(fileOrBlob) {
    return compressToWebp70(fileOrBlob).then(function (webpBlob) {
      var numStr = String(editorImageSeq++).padStart(3, '0') + '.webp';
      var objectUrl = URL.createObjectURL(webpBlob);
      var item = { id: numStr, blob: webpBlob, objectUrl: objectUrl };
      editorSessionImages.push(item);
      return item;
    });
  }

  function flushSessionImagesForSave(target, currentValue) {
    if (!target || !currentValue || !editorSessionImages.length) return Promise.resolve(currentValue);
    var referenced = editorSessionImages.filter(function (it) {
      return currentValue.indexOf(it.objectUrl) >= 0;
    });
    if (referenced.length === 0) return Promise.resolve(currentValue);

    var filename = (target.fileId || target.pathGrantId || 'document').split('/').pop() || 'document.md';
    var baseName = filename.replace(/\.[^/.]+$/, '').replace(/[^\w-]/g, '_') || 'doc';
    var imgsSubdir = baseName + '_imgs';

    var formData = new FormData();
    if (target.fileId) formData.append('fileId', target.fileId);
    if (target.pathGrantId) formData.append('pathGrantId', target.pathGrantId);
    formData.append('imgsSubdir', imgsSubdir);
    referenced.forEach(function (it) {
      formData.append('files', it.blob, it.id);
    });

    return fetch('/api/editor/save-session-images', {
      method: 'POST',
      body: formData
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (data && data.ok) {
        var updatedValue = currentValue;
        referenced.forEach(function (it) {
          var relPath = './' + imgsSubdir + '/' + it.id;
          updatedValue = updatedValue.split(it.objectUrl).join(relPath);
        });
        return updatedValue;
      }
      return currentValue;
    }).catch(function (err) {
      console.warn('[Flush Session Images Failed]', err);
      return currentValue;
    });
  }

  function saveWorkspace() {
    var input = currentInput();
    if (!input || !shellState.currentId) return Promise.resolve(false);
    // Windowed IME session: splice the live window back before reading, or
    // only the ±8-line window would be persisted and the rest lost.
    if (imeWin) {
      try { imeWindowCommit(input); } catch (eWinSave) { try { imeWindowAbort(input); } catch (eAbortSave) {} }
    }
    var value = input.value;

    function doSaveTarget(target) {
      return flushSessionImagesForSave(target, value).then(function (finalValue) {
        value = finalValue;
        input.value = finalValue;
        return fetch('/api/editor/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: value, fileId: target.fileId, pathGrantId: target.pathGrantId })
        }).then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok || !data || !data.ok) return false;
            var meta = Object.assign({}, (shellState.currentNode && shellState.currentNode.meta) || {});
            if (target.fileId) { meta.fileId = target.fileId; delete meta.pathGrantId; }
            if (target.pathGrantId) { meta.pathGrantId = target.pathGrantId; delete meta.fileId; }
            return global.EditorWorkspace.updateNode(shellState.currentId, { content: value, meta: meta }).then(function (node) { return !!node; });
          });
        }).catch(function () { return false; });
      });
    }

    var target = editorTargetBody(shellState.currentNode);
    var savePromise;
    if (target) {
      savePromise = doSaveTarget(target);
    } else {
      // Local-only node (no server identity): persist to the IndexedDB
      // workspace without a backend write.
      savePromise = global.EditorWorkspace.updateNode(shellState.currentId, { content: value }).then(function (node) { return !!node; });
    }

    return savePromise.then(function (saved) {
      if (!saved) { toast(tr('editorSaveFailed', 'Save failed'), 'error'); return false; }
      removeDraft(shellState.currentId);
      // A debounced draft write from pre-save keystrokes may still be
      // pending; drop it or it would resurrect a stale draft after save.
      if (shellRender.draftTimer) { try { clearTimeout(shellRender.draftTimer); } catch (e) {} shellRender.draftTimer = 0; }
      shellState.original = value;
      shellState.dirty = false;
      updateStatus();
      toast(tr('editorSaved', 'File saved'), 'success');
      return true;
    });
  }

  function importWorkspaceFile(name, content, meta) {
    return global.EditorWorkspace.listNodes().then(function (nodes) {
      var existing = (nodes || []).find(function (n) {
        return n && n.type === 'file' && n.name.toLowerCase() === name.toLowerCase();
      });
      if (existing) {
        removeDraft(existing.id);
        return global.EditorWorkspace.updateNode(existing.id, { content: content, meta: meta || {} }).then(function () {
          return refreshTree().then(function () { return loadFile(existing.id, content); });
        });
      }
      return global.EditorWorkspace.putFile(name, content, null, meta || { imported: true }).then(function (node) {
        if (!node) {
          return global.EditorWorkspace.listNodes().then(function (freshNodes) {
            var found = (freshNodes || []).find(function (n) { return n && n.type === 'file' && n.name.toLowerCase() === name.toLowerCase(); });
            if (!found) return false;
            return global.EditorWorkspace.updateNode(found.id, { content: content, meta: meta || {} }).then(function () {
              return refreshTree().then(function () { return loadFile(found.id, content); });
            });
          });
        }
        return refreshTree().then(function () { return loadFile(node.id, content); });
      });
    });
  }

  var isOpenModalBusy = false;

  function setFilePickerBusy(value) {
    if (value) {
      if (typeof global.beginNativePickerLock === 'function' && !global.beginNativePickerLock('file')) return false;
      global.__editorFilePickerBusy = true;
      return true;
    }
    global.__editorFilePickerBusy = false;
    if (typeof global.endNativePickerLock === 'function') global.endNativePickerLock();
    return true;
  }

  function openLocalFile() {
    if (isOpenModalBusy) return Promise.resolve(false);
    isOpenModalBusy = true;
    if (!setFilePickerBusy(true)) {
      isOpenModalBusy = false;
      return Promise.resolve(false);
    }
    return fetch('/api/editor/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data && data.content !== undefined) {
          return importWorkspaceFile(data.name || 'untitled.md', data.content, { fileId: data.fileId || '', pathGrantId: data.pathGrantId || '', imported: true });
        }
        return false;
      })
      .catch(function () { return false; })
      .then(function (result) {
        isOpenModalBusy = false;
        setFilePickerBusy(false);
        return result;
      });
  }

  function triggerUndo() {
    var input = currentInput();
    if (!input) return;
    input.focus();
    try {
      if (typeof document.execCommand === 'function') {
        var ok = document.execCommand('undo');
        if (ok) { updateGutter(); redraw(); return; }
      }
    } catch (e) {}
    if (global.EditorCommands) global.EditorCommands.undo(input);
    updateGutter();
    redraw();
  }
  function triggerRedo() {
    var input = currentInput();
    if (!input) return;
    input.focus();
    try {
      if (typeof document.execCommand === 'function') {
        var ok = document.execCommand('redo');
        if (ok) { updateGutter(); redraw(); return; }
      }
    } catch (e) {}
    if (global.EditorCommands) global.EditorCommands.redo(input);
    updateGutter();
    redraw();
  }

  function showLinkModal() {
    var input = currentInput();
    var overlay = document.getElementById('modal-overlay');
    if (!overlay || !input) return;
    var selStart = input.selectionStart || 0;
    var selEnd = input.selectionEnd || 0;
    var selectedText = input.value.slice(selStart, selEnd);

    overlay.innerHTML =
      '<div class="modal" style="max-width:440px;">' +
        '<div class="modal-title">' + escapeHtml(tr('editorLink', 'Insert Link')) + '</div>' +
        '<div class="modal-body" style="margin-top:12px; display:flex; flex-direction:column; gap:10px;">' +
          '<label style="font-size:12px; opacity:0.8;">Text</label>' +
          '<input type="text" class="input" id="link-text-input" value="' + escapeAttr(selectedText || 'link text') + '" style="width:100%; box-sizing:border-box;" />' +
          '<label style="font-size:12px; opacity:0.8;">URL</label>' +
          '<input type="text" class="input" id="link-url-input" value="https://" style="width:100%; box-sizing:border-box;" />' +
        '</div>' +
        '<div class="modal-footer" style="margin-top:16px;">' +
          '<button type="button" class="btn btn-ghost" id="link-cancel">' + tr('cancel', 'Cancel') + '</button>' +
          '<button type="button" class="btn btn-primary" id="link-confirm">' + tr('confirm', 'Confirm') + '</button>' +
        '</div>' +
      '</div>';
    overlay.classList.add('show');
    var urlInput = document.getElementById('link-url-input');
    if (urlInput) {
      setTimeout(function() { urlInput.focus(); urlInput.select(); }, 50);
    }
    function close() {
      overlay.classList.remove('show');
      overlay.innerHTML = '';
    }
    document.getElementById('link-cancel').onclick = close;
    document.getElementById('link-confirm').onclick = function() {
      var tInput = document.getElementById('link-text-input');
      var uInput = document.getElementById('link-url-input');
      var textVal = tInput ? tInput.value.trim() : 'link text';
      var urlVal = uInput ? uInput.value.trim() : 'https://';
      close();
      input.focus();
      if (global.EditorCommands) global.EditorCommands.insertLink(input, textVal, urlVal);
      updateGutter();
      redraw();
    };
  }

  function uploadAndInsertImage(file, altText) {
    var input = currentInput();
    if (!input) return;
    toast('Compressing WebP...', 'info');

    addSessionImage(file).then(function (item) {
      if (global.EditorCommands) {
        global.EditorCommands.insertImage(input, altText || 'image', item.objectUrl);
        updateGutter();
        redraw();
        toast('Image loaded into session (' + item.id + ')', 'success');
      }
    }).catch(function (err) {
      console.error('[Session Image]', err);
      toast('Image process failed: ' + (err.message || 'Error'), 'error');
    });
  }

  function showImageModal() {
    var input = currentInput();
    var overlay = document.getElementById('modal-overlay');
    if (!overlay || !input) return;
    var selStart = input.selectionStart || 0;
    var selEnd = input.selectionEnd || 0;
    var selectedText = input.value.slice(selStart, selEnd);
    var pendingFile = null;

    overlay.innerHTML =
      '<div class="modal" style="max-width:460px;">' +
        '<div class="modal-title">' + escapeHtml(tr('editorImage', 'Insert Image')) + '</div>' +
        '<div class="modal-body" style="margin-top:12px; display:flex; flex-direction:column; gap:10px;">' +
          '<label style="font-size:12px; opacity:0.8;">Alt Description</label>' +
          '<input type="text" class="input" id="img-alt-input" value="' + escapeAttr(selectedText || 'image alt') + '" style="width:100%; box-sizing:border-box;" />' +
          '<label style="font-size:12px; opacity:0.8;">Image URL / Local File</label>' +
          '<div style="display:flex; gap:8px;">' +
            '<input type="text" class="input" id="img-url-input" placeholder="https://... or select local file" value="" style="flex:1; box-sizing:border-box;" />' +
            '<button type="button" class="btn btn-ghost" id="img-browse-btn" style="white-space:nowrap;">Browse...</button>' +
          '</div>' +
          '<input type="file" id="img-file-picker" accept="image/*" style="display:none;" />' +
        '</div>' +
        '<div class="modal-footer" style="margin-top:16px;">' +
          '<button type="button" class="btn btn-ghost" id="img-cancel">' + tr('cancel', 'Cancel') + '</button>' +
          '<button type="button" class="btn btn-primary" id="img-confirm">' + tr('confirm', 'Confirm') + '</button>' +
        '</div>' +
      '</div>';
    overlay.classList.add('show');
    var urlInput = document.getElementById('img-url-input');
    var filePicker = document.getElementById('img-file-picker');
    var browseBtn = document.getElementById('img-browse-btn');

    if (urlInput) {
      setTimeout(function() { urlInput.focus(); }, 50);
    }
    if (browseBtn && filePicker) {
      browseBtn.onclick = function() { filePicker.click(); };
      filePicker.onchange = function() {
        if (filePicker.files && filePicker.files[0]) {
          pendingFile = filePicker.files[0];
          if (urlInput) urlInput.value = pendingFile.name;
        }
      };
    }
    function close() {
      overlay.classList.remove('show');
      overlay.innerHTML = '';
    }
    document.getElementById('img-cancel').onclick = close;
    document.getElementById('img-confirm').onclick = function() {
      var aInput = document.getElementById('img-alt-input');
      var uInput = document.getElementById('img-url-input');
      var altVal = aInput ? aInput.value.trim() : 'image alt';
      var urlVal = uInput ? uInput.value.trim() : '';

      if (pendingFile) {
        close();
        uploadAndInsertImage(pendingFile, altVal);
        return;
      }

      if (!urlVal) { toast('Please enter image URL or select a local image file', 'warning'); return; }
      close();
      input.focus();
      if (global.EditorCommands) global.EditorCommands.insertImage(input, altVal, urlVal);
      updateGutter();
      redraw();
    };
  }

  function handlePasteImage(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') !== -1) {
        var file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          uploadAndInsertImage(file, 'pasted_image');
          break;
        }
      }
    }
  }

  function showAiModal() {
    var input = currentInput();
    var overlay = document.getElementById('modal-overlay');
    if (!overlay || !input) return;

    var selStart = input.selectionStart || 0;
    var selEnd = input.selectionEnd || 0;
    var selectedText = input.value.slice(selStart, selEnd).trim();
    var isSelectionMode = !!selectedText;

    var titleText = isSelectionMode ? 'AI 润色 / 修改选中文本' : 'AI 智能辅助写作';
    var selectedModel = localStorage.getItem('tinylab_editor_ai_model') || '';

    overlay.innerHTML =
      '<div class="modal" style="max-width:500px; width:90%;">' +
        '<div class="modal-title" style="display:flex; align-items:center; gap:8px;">' +
          '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2L14.39 7.61L20 10L14.39 12.39L12 18L9.61 12.39L4 10L9.61 7.61L12 2ZM6 15l1.19 2.81L10 19l-2.81 1.19L6 23l-1.19-2.81L2 19l2.81-1.19L6 15z"/></svg>' +
          '<span>' + escapeHtml(titleText) + '</span>' +
        '</div>' +
        '<div class="modal-body" style="margin-top:12px; display:flex; flex-direction:column; gap:12px;">' +
          '<div>' +
            '<label style="font-size:12px; opacity:0.8; display:block; margin-bottom:4px;">选择 AI 模型 (Model)</label>' +
            '<button type="button" class="btn btn-outline" id="ai-model-picker-btn" style="width:100%; text-align:left; justify-content:space-between; display:flex; align-items:center; min-height:36px; padding:6px 12px; background:var(--input-bg, rgba(0,0,0,0.2)); border:1px solid var(--border-color, rgba(255,255,255,0.15)); border-radius:6px; color:var(--text);">' +
              '<span id="ai-model-label" style="font-weight:500;">' + escapeHtml(selectedModel || '-- 点击选择 AI 模型 --') + '</span>' +
              '<span style="opacity:0.6; font-size:10px;">▼</span>' +
            '</button>' +
          '</div>' +
          (isSelectionMode ?
            '<div>' +
              '<label style="font-size:12px; opacity:0.8; display:block; margin-bottom:4px;">选中的目标文本 (Selected Text)</label>' +
              '<div style="max-height:100px; overflow-y:auto; padding:8px; background:rgba(0,0,0,0.2); border-radius:6px; font-size:12px; color:var(--text-muted, #999); word-break:break-all;">' + escapeHtml(selectedText) + '</div>' +
            '</div>' : '') +
          '<div>' +
            '<label style="font-size:12px; opacity:0.8; display:block; margin-bottom:4px;">输入指令与要求 (Prompt)</label>' +
            '<textarea class="input" id="ai-prompt-input" rows="3" placeholder="' + (isSelectionMode ? '如：帮我修正错别字并进行语句润色...' : '如：根据上下文生成一段相关内容...') + '" style="width:100%; box-sizing:border-box; resize:vertical;"></textarea>' +
          '</div>' +
          '<div id="ai-status-msg" style="font-size:12px; color:var(--accent-color, #4f46e5); display:none;">处理中，请稍候...</div>' +
        '</div>' +
        '<div class="modal-footer" style="margin-top:16px;">' +
          '<button type="button" class="btn btn-ghost" id="ai-cancel">取消</button>' +
          '<button type="button" class="btn btn-primary" id="ai-submit">提交执行</button>' +
        '</div>' +
      '</div>';

    overlay.classList.add('show');
    var modelPickerBtn = document.getElementById('ai-model-picker-btn');
    var modelLabel = document.getElementById('ai-model-label');
    var promptInput = document.getElementById('ai-prompt-input');
    var submitBtn = document.getElementById('ai-submit');
    var cancelBtn = document.getElementById('ai-cancel');
    var statusMsg = document.getElementById('ai-status-msg');

    if (modelPickerBtn) {
      modelPickerBtn.onclick = function() {
        if (typeof window.openModelPickerModal === 'function') {
          window.openModelPickerModal(selectedModel, function(newModel) {
            if (newModel) {
              selectedModel = newModel;
              if (modelLabel) modelLabel.textContent = selectedModel;
              localStorage.setItem('tinylab_editor_ai_model', selectedModel);
            }
          });
        } else if (typeof window.pgOpenModelPicker === 'function') {
          window.pgOpenModelPicker(selectedModel, function(newModel) {
            if (newModel) {
              selectedModel = newModel;
              if (modelLabel) modelLabel.textContent = selectedModel;
              localStorage.setItem('tinylab_editor_ai_model', selectedModel);
            }
          });
        }
      };
    }

    if (promptInput) setTimeout(function() { promptInput.focus(); }, 50);

    function close() {
      overlay.classList.remove('show');
      overlay.innerHTML = '';
    }
    cancelBtn.onclick = close;

    submitBtn.onclick = function() {
      var userPrompt = promptInput ? promptInput.value.trim() : '';
      if (!selectedModel) { toast('请先选择一个 AI 模型', 'warning'); return; }
      if (!userPrompt) { toast('请输入提示词要求', 'warning'); return; }

      localStorage.setItem('tinylab_editor_ai_model', selectedModel);
      submitBtn.disabled = true;
      submitBtn.textContent = '生成中...';
      if (statusMsg) statusMsg.style.display = 'block';

      var messages = [];
      if (isSelectionMode) {
        messages.push({ role: 'system', content: '你是一个专业的写作与编辑助手。请根据用户的要求修改给出的【选中文本】。只输出修改后的最终内容，不要添加任何额外的解释或对话说明。' });
        messages.push({ role: 'user', content: '【用户要求】:\n' + userPrompt + '\n\n【选中文本】:\n' + selectedText });
      } else {
        messages.push({ role: 'system', content: '你是一个智能写作助手。请根据用户的要求生成相应的文本。只输出生成的文本正文。' });
        messages.push({ role: 'user', content: userPrompt });
      }

      fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: messages,
          stream: false
        })
      }).then(function(res) {
        if (!res.ok) throw new Error('API request failed');
        return res.json();
      }).then(function(data) {
        var reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!reply) throw new Error('No content returned from AI');
        close();
        input.focus();
        if (global.EditorCommands) {
          global.EditorCommands.replaceSelection(input, reply);
          toast(isSelectionMode ? '已用 AI 生成结果替换选中文本' : 'AI 生成结果已插入当前位置', 'success');
        }
        updateGutter();
        redraw();
      }).catch(function(err) {
        console.error('[Editor AI]', err);
        toast('AI 请求失败: ' + (err.message || '网络错误'), 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '提交执行';
        if (statusMsg) statusMsg.style.display = 'none';
      });
    };
  }

  function shellHooks() {
    return {
      action: function (action) {
        if (action === 'new-file') createFile();
        else if (action === 'new-folder') createFolder();
        else if (action === 'delete') deleteCurrent();
        else if (action === 'undo') triggerUndo();
        else if (action === 'redo') triggerRedo();
        else if (action === 'link') showLinkModal();
        else if (action === 'image') showImageModal();
        else if (action === 'ai') showAiModal();
        else if (['bold','italic','heading','strike','ul','ol','checklist','quote','code','table'].indexOf(action) >= 0) { global.EditorCommands.format(currentInput(), action); }
        else if (action === 'find') shellFindToggle();
        else if (action === 'edit') { shellState.mode = 'edit'; redraw(); }
        else if (action === 'diff') { shellState.mode = 'diff'; redraw(); }
      },
      selectFile: function (id) {
        global.EditorWorkspace.getNode(id).then(function (node) {
          shellState.selectedId = id;
          shellState.selectedNode = node;
          if (node && node.type === 'file') return loadFile(id);
          return refreshTree();
        });
      },
      open: openLocalFile,
      save: saveWorkspace,
      toggle: function (name) {
        if (name === 'reader') shellState.reader = !shellState.reader;
        else if (name === 'focus') shellState.focus = !shellState.focus;
        else if (name === 'preview') shellState.preview = !shellState.preview;
        else if (name === 'sync') shellState.sync = !shellState.sync;
        else if (name === 'toc') shellState.toc = !shellState.toc;
        else if (name === 'html-iframe') shellState.htmlRender = !shellState.htmlRender;
        else if (name === 'explorer') shellState.explorer = !shellState.explorer;
        if (name === 'toc' && shellRoot) { var toc = shellRoot.querySelector('.ed-toc'); if (toc) toc.hidden = !shellState.toc; }
        redraw();
      },
      toggleTree: function (id) {
        var index = shellState.expanded.indexOf(id);
        if (index >= 0) shellState.expanded.splice(index, 1); else shellState.expanded.push(id);
        global.EditorWorkspace.setExpandedIds(shellState.expanded).then(function () { refreshTree(); });
      },
      collapseAll: function () {
        shellState.expanded = [];
        global.EditorWorkspace.setExpandedIds([]).then(function () { refreshTree(); });
      },
      expandAll: function () {
        global.EditorWorkspace.listNodes().then(function (nodes) {
          var allIds = [];
          (nodes || []).forEach(function (n) {
            if (n && n.type === 'folder' && !n.deleted) allIds.push(n.id);
          });
          shellState.expanded = allIds;
          global.EditorWorkspace.setExpandedIds(allIds).then(function () { refreshTree(); });
        });
      },
      filter: function (query) {
        var prevQ = shellState.filterQuery || '';
        shellState.filterQuery = query || '';
        if (prevQ && !shellState.filterQuery && (shellState.selectedId || shellState.currentId)) {
          var targetId = shellState.selectedId || shellState.currentId;
          global.EditorWorkspace.listNodes().then(function (nodes) {
            var nMap = Object.create(null);
            (nodes || []).forEach(function (n) { if (n) nMap[n.id] = n; });
            var cur = nMap[targetId];
            var changed = false;
            while (cur && cur.parentId && nMap[cur.parentId]) {
              if (shellState.expanded.indexOf(cur.parentId) < 0) {
                shellState.expanded.push(cur.parentId);
                changed = true;
              }
              cur = nMap[cur.parentId];
            }
            if (cur && cur.type === 'folder' && shellState.expanded.indexOf(cur.id) < 0) {
              shellState.expanded.push(cur.id);
              changed = true;
            }
            if (changed) global.EditorWorkspace.setExpandedIds(shellState.expanded);
            refreshTree();
          });
          return;
        }
        refreshTree();
      }
    };
  }

  function bindShell() {
    var input = currentInput();
    if (!shellRoot || !input) return;
    var hooks = shellHooks();
    input.addEventListener('paste', handlePasteImage);
    // Per-keystroke path: record undo + cheap gutter delta + caret only.
    // Draft persistence, comment overlay, and the full markdown/mermaid/hljs
    // render arrive via schedulePreview's debounced pass.
    // IME guard: while a CJK composition session is open (isComposing or
    // between compositionstart/end), the browser owns the textarea value and
    // selection. Any read of input.value, setSelectionRange, or overlay DOM
    // rewrite can abort the session — on 2000-line docs the per-keystroke
    // full-text snapshot/diff freezes the WebView2 IME channel entirely.
    // So composition input is ignored; one full pass runs on compositionend.
    var onCompositionStart = function () {
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      shellComposing = true;
      // Composition must render through the real textarea (not the overlay):
      // the browser draws the candidate string inside the textarea, but
      // .ed-main-input is color:transparent so it only shows when .is-typing
      // removes that. Set it here, not on compositionend.
      setTyping(true);
      // Freeze the wrap subtree's rendering for the session (see
      // .is-composing in style-editor.css): candidate keystrokes stop
      // paying overlay/gutter paint per keystroke.
      setComposing(true);
      // 方案A windowing: shrink the live textarea to the caret window so
      // candidate keystrokes lay out ~17 lines, not 2000. currentInput()
      // is a plain querySelector — no value/selection read on the session.
      var winInput = currentInput();
      if (winInput) {
        try { imeWindowOpen(winInput); } catch (eWin) { imeWin = null; }
      }
      // A pending debounced preview from pre-session typing must not fire
      // mid-session: the generation bump below drops its second frame, and
      // cancelling the first frame keeps marked/sanitize off the main thread
      // while TSF owns the caret.
      if (shellRender.timer) { try { clearTimeout(shellRender.timer); } catch (eCancel) {} shellRender.timer = 0; }
      shellRender.generation = (shellRender.generation || 0) + 1;
      // rAF heartbeat: a bare frame request keeps the compositor emitting
      // BeginFrames during the session with zero DOM/style/layout cost
      // (replaces the old attribute-flip tick, whose setAttribute itself
      // cost a style recalc per firing on 2000-line docs).
      edImeHeartbeat._last = 0;
      edImeHeartbeat._in = 0;
      edImeHeartbeat();
      if (t0) edImeMark('comp-start', performance.now() - t0);
    };
    var onCompositionEnd = function () {
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      shellComposing = false;
      // Splice the window back into the full text first (or restore on
      // failure), then run the normal post-commit pass on the full doc.
      var endInput = currentInput();
      if (endInput) {
        try {
          if (!imeWindowCommit(endInput)) {
            if (global.EditorCommands) global.EditorCommands.record(endInput);
            scheduleDraft(shellState.currentId, endInput.value);
            updateGutter(false);
            updateCaret();
            schedulePreview();
          } else {
            scheduleDraft(shellState.currentId, endInput.value);
            // Windowed commit: the textarea just swapped window text back
            // to the full doc. Gutter/overlay must re-sync NOW on the full
            // text, not 300ms later: mid-delay the gutter shows window
            // line numbers against full text (click-line/edit-line skew)
            // and Chrome/WebView2 disagree on the deferred scroll pin.
            try { updateGutter(true); } catch (eGSync) {}
            updateCaret();
            schedulePreview();
          }
        } catch (eCommit) {
          try { imeWindowAbort(endInput); } catch (eAbort) {}
        }
      }
      if (t0) edImeMark('comp-end', performance.now() - t0);
    };
    var onInput = function (event, skipTyping) {
      if (shellComposing || (event && event.isComposing)) {
        // Blind tick: never read input.value/selection here. During an IME
        // session the browser/TSF owns the caret; reads can stall the
        // session round-trip (the 1-minute freeze scales with pending
        // composition length). Write a cheap visibility-kept token through
        // the layout helper instead so the compositor still gets a frame.
        var tick0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        setTyping(true);
        // Zero-cost heartbeat only: no DOM reads, no attribute writes. The
        // session-opened heartbeat from compositionstart already covers the
        // frame signal; re-arm it here in case the session outlives a frame.
        // Input-gap forensics: record arrival intervals so a real freeze
        // shows whether input events stopped arriving (>100ms) while frames
        // kept flowing (input starvation) or frames stopped too (compositor).
        if (tick0) {
          var lastIn = edImeHeartbeat._in || 0;
          if (lastIn && tick0 - lastIn > 100) edImeMark('input-gap', tick0 - lastIn);
          edImeHeartbeat._in = tick0;
        }
        edImeHeartbeat();
        if (tick0) edImeMark('comp-input', performance.now() - tick0);
        return;
      }
      if (global.EditorCommands) global.EditorCommands.record(input);
      scheduleDraft(shellState.currentId, input.value);
      updateGutter(false);
      updateCaret();
      // Show real glyphs instantly; the debounced pass clears the class
      // after the overlay re-syncs (see renderPreview tail). Skipped when
      // the overlay was just synced (e.g. compositionend) to avoid a
      // hide-then-restore flicker of fresh overlay content.
      if (!skipTyping) setTyping(true);
      schedulePreview();
    };
    var onScroll = function () {
      // During an IME session the caret rectangle is TSF-owned; rewriting
      // the gutter/overlay scroll here can yank the candidate-window anchor
      // and stretch the round-trip. Skip everything except the deferred
      // preview sync below (which is itself a no-op without sync enabled).
      if (!shellComposing) {
        updateGutter(false);
        syncOverlayScroll();
      }
      if (!shellState.sync || !shellRoot) return;
      var preview = shellRoot.querySelector('#ed-main-preview');
      if (!preview) return;
      var ratio = input.scrollHeight > input.clientHeight ? input.scrollTop / (input.scrollHeight - input.clientHeight) : 0;
      preview.scrollTop = ratio * Math.max(0, preview.scrollHeight - preview.clientHeight);
    };
    var onKey = function (event) {
      var mod = event.ctrlKey || event.metaKey;
      // keyCode 229 = IME composition keystroke: never hijack it (Tab /
      // comment / duplicate-line rewrites would abort the session).
      var imeKey = event.keyCode === 229 || event.key === 'Process';
      // Treat an explicit 229 as session-open even if compositionstart has
      // not arrived yet (event ordering differs across IMEs); the blind
      // tick keeps frames flowing without touching value/selection.
      if (imeKey && !shellComposing) {
        shellComposing = true;
        setTyping(true);
        if (global.EditorLayout && typeof global.EditorLayout.imeTick === 'function') {
          global.EditorLayout.imeTick(shellRoot);
        }
        return;
      }
      if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); saveWorkspace(); }
      // In-session undo/redo belongs to the IME (its own candidate history):
      // applySnapshot would rewrite input.value under the live composition
      // and abort the session. Let the event reach the IME untouched.
      if (shellComposing && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) return;
      else if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) triggerRedo(); else triggerUndo(); }
      else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); triggerRedo(); }
      else if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); shellFindToggle(); }
      else if (!imeKey && event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        if (global.EditorCommands && typeof global.EditorCommands.indent === 'function') {
          global.EditorCommands.indent(input, event.shiftKey);
        }
      }
      else if (!imeKey && event.altKey && !mod && event.key === '/') {
        event.preventDefault();
        event.stopPropagation();
        if (global.EditorCommands && typeof global.EditorCommands.toggleComment === 'function') {
          global.EditorCommands.toggleComment(input);
        }
      }
      else if (!imeKey && event.altKey && event.shiftKey && !mod && (event.key === 'ArrowUp' || event.key === 'Up')) {
        event.preventDefault();
        event.stopPropagation();
        if (global.EditorCommands && typeof global.EditorCommands.duplicateLine === 'function') {
          global.EditorCommands.duplicateLine(input, 'up');
        }
      }
      else if (!imeKey && event.altKey && event.shiftKey && !mod && (event.key === 'ArrowDown' || event.key === 'Down')) {
        event.preventDefault();
        event.stopPropagation();
        if (global.EditorCommands && typeof global.EditorCommands.duplicateLine === 'function') {
          global.EditorCommands.duplicateLine(input, 'down');
        }
      }
    };
    var onClick = function (event) {
      var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (link && /^https?:\/\//i.test(link.href)) { event.preventDefault(); global.open(link.href, '_blank', 'noopener,noreferrer'); }
    };
    input.addEventListener('input', onInput);
    input.addEventListener('compositionstart', onCompositionStart);
    input.addEventListener('compositionend', onCompositionEnd);
    input.addEventListener('scroll', onScroll);
    input.addEventListener('keydown', onKey);
    var preview = shellRoot.querySelector('#ed-main-preview');
    if (preview) preview.addEventListener('click', onClick);

    var tocList = shellRoot.querySelector('.ed-toc-list');
    if (tocList) {
      tocList.onclick = function (e) {
        var link = e.target && e.target.closest ? e.target.closest('a[data-toc-id], a[href]') : null;
        if (!link) return;
        e.preventDefault();
        var tocId = link.dataset.tocId || (link.getAttribute('href') || '').replace(/^#/, '');
        if (!tocId) return;

        var prevNode = shellRoot.querySelector('#ed-main-preview');
        if (!prevNode) return;

        var iframe = prevNode.querySelector('iframe');
        if (iframe) {
          // Sandboxed (opaque origin): contentDocument is unreadable, so
          // in-iframe scrolling is not possible; fall through to scrolling
          // the preview container.
          try {
            var targetInIframe = iframe.contentDocument.getElementById(tocId) ||
                                 iframe.contentDocument.querySelector('[id="' + tocId + '"]');
            if (targetInIframe) {
              targetInIframe.scrollIntoView({ behavior: 'smooth', block: 'start' });
              return;
            }
          } catch (err) {}
        }

        try {
          var targetEl = prevNode.querySelector('#' + CSS.escape(tocId)) ||
                         prevNode.querySelector('[id="' + tocId + '"]');
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        } catch (err2) {}
      };
    }

    shellHandlers = { input: onInput, scroll: onScroll, keydown: onKey, compStart: onCompositionStart, compEnd: onCompositionEnd, previewClick: onClick, preview: preview, inputNode: input };
    var titleNode = shellRoot.querySelector('#ed-title');
    if (titleNode) {
      titleNode.setAttribute('data-tooltip', tr('editorRename', 'Click to rename'));
      titleNode.onclick = function () { renameCurrent(); };
    }
    global.EditorLayout.bind(shellRoot, hooks);
  }

  function unbindShell() {
    if (!shellHandlers) return;
    var h = shellHandlers;
    if (h.inputNode) { h.inputNode.removeEventListener('input', h.input); h.inputNode.removeEventListener('scroll', h.scroll); h.inputNode.removeEventListener('keydown', h.keydown); h.inputNode.removeEventListener('compositionstart', h.compStart); h.inputNode.removeEventListener('compositionend', h.compEnd); }
    if (h.preview) h.preview.removeEventListener('click', h.previewClick);
    shellHandlers = null;
    // Windowed IME session: restore the full text before teardown, or the
    // live window replaces the document on next bind.
    if (imeWin && h.inputNode) { try { imeWindowAbort(h.inputNode); } catch (eWinUnbind) {} }
    imeWin = null;
    cancelScheduled();
  }

  function renderEditor(container) {
    shellContainer = container;
    shellState.mode = 'edit';
    var bootstrap = !editorBootstrapped;
    editorBootstrapped = true;
    return global.EditorWorkspace.init().then(function () {
      return bootstrap ? syncDocDirTree() : null;
    }).then(function () {
      return Promise.all([global.EditorWorkspace.listNodes(), global.EditorWorkspace.getCurrentFileId(), global.EditorWorkspace.getExpandedIds()]);
    }).then(function (values) {
      var nodes = values[0] || [];
      shellState.expanded = values[2] || [];
      var currentId = values[1];
      if (!currentId) {
        var firstFile = nodes.find(function (node) { return node && node.type === 'file' && node.isDoc; });
        currentId = firstFile ? firstFile.id : null;
      }
      shellState.currentId = currentId;
      shellRoot = global.EditorLayout.create(container, { nodes: buildTree(nodes), selectedId: currentId }, shellHooks());
      return loadFile(currentId).then(function () {
        bindShell();
        refreshTree();
        return shellRoot;
      });
    });

  }

  function suspendEditor() {
    if (typeof legacySuspend === 'function') safe(function () { legacySuspend(); });
    unbindShell();
    if (typeof global.edSaveState === 'function') safe(function () { global.edSaveState(); });
  }
  function cleanupEditor() {
    if (shellHandlers) unbindShell();
    if (typeof legacyCleanup === 'function' && legacyCleanup !== cleanupEditor) safe(function () { legacyCleanup(); });
    if (shellRoot) global.EditorLayout.destroy(shellRoot);
    shellRoot = null;
    shellContainer = null;
  }

  global.renderEditor = renderEditor;
  global.suspendEditor = suspendEditor;
  global.resumeEditor = function () {};
  global.cleanupEditor = cleanupEditor;
}(typeof window !== 'undefined' ? window : this));
