/**
 * Editor V2 Embed - lightweight reusable Monaco hosts for non-Utility pages.
 *
 * Two fixed patterns (frozen for direct reuse by callers):
 *  1. Single editor (no menubar/explorer/tabs/preview): line numbers + native
 *     Monaco actions (Find Ctrl+F / Replace Ctrl+H / GotoLine Ctrl+G /
 *     selection / move-copy lines / multi-cursor). Engine, theme and zoom are
 *     shared with the full V2 workbench via window.EditorV2Engine.
 *  2. Diff modal: left original (read-only) + right editable surface, live
 *     EditorV2DiffCore stats + Prev/Next change navigation + Save back.
 *     The right pane IS the edit surface ("改的结果显示在右侧").
 */
(function () {
  'use strict';

  var hosts = {}; // hostId -> { editor, model, host }
  var hostSeq = 0;

  function resolveHost(hostOrId) {
    if (typeof hostOrId === 'string') return document.getElementById(hostOrId);
    return hostOrId || null;
  }

  function hostIdOf(host) {
    if (!host.id) host.id = 'ed2-embed-' + (++hostSeq) + '-' + Date.now().toString(36);
    return host.id;
  }

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function tr(k, fallback) {
    try {
      var v = (typeof window.t === 'function') ? window.t(k, null, fallback) : fallback;
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function ensureEngine() {
    if (!window.EditorV2Engine || typeof window.EditorV2Engine.load !== 'function') {
      return Promise.reject(new Error('EditorV2Engine is not loaded'));
    }
    return window.EditorV2Engine.load();
  }

  function computeFont() {
    var base = 13;
    try {
      if (window.EditorV2Engine && window.EditorV2Engine.getBaseCodeFontSize) {
        base = window.EditorV2Engine.getBaseCodeFontSize() || 13;
      }
    } catch (e) { /* keep default */ }
    var scale = 1;
    try {
      var raw = parseFloat(localStorage.getItem('tr-editor-v2-text-zoom'));
      if (isFinite(raw) && raw >= 0.5 && raw <= 3) scale = raw;
    } catch (e) { /* storage unavailable */ }
    var size = Math.max(8, Math.min(48, Math.round(base * scale)));
    return { fontSize: size, lineHeight: Math.round(size * 1.5) };
  }

  function langFor(filename) {
    try {
      if (window.EditorV2Engine && window.EditorV2Engine.getLanguageForFilename) {
        return window.EditorV2Engine.getLanguageForFilename(filename);
      }
    } catch (e) { /* fall through */ }
    return 'plaintext';
  }

  function themeName() {
    try {
      if (window.EditorV2Engine && window.EditorV2Engine.getCurrentThemeName) {
        return window.EditorV2Engine.getCurrentThemeName();
      }
    } catch (e) { /* fall through */ }
    return 'vs-dark';
  }

  // Live-editor registries so zoom + theme follow every embed surface
  // (single hosts and open diff modals alike).
  var modalEditors = [];
  var liveModalEditors = [];
  var themeObserverOn = false;

  function allEmbedEditors() {
    var out = [];
    for (var id in hosts) {
      if (Object.prototype.hasOwnProperty.call(hosts, id) && hosts[id] && hosts[id].editor) out.push(hosts[id].editor);
    }
    for (var i = 0; i < modalEditors.length; i++) {
      if (modalEditors[i]) out.push(modalEditors[i]);
    }
    for (var j = 0; j < liveModalEditors.length; j++) {
      if (liveModalEditors[j]) out.push(liveModalEditors[j]);
    }
    return out;
  }

  // The left change table is plain DOM (not Monaco): push the shared
  // EditorV2 zoom scale onto every open modal table so both panes scale together.
  function refreshLeftTables() {
    var font = computeFont();
    var tables = document.querySelectorAll('.ed2-embed-diff-table');
    for (var i = 0; i < tables.length; i++) {
      try {
        tables[i].style.fontSize = font.fontSize + 'px';
        tables[i].style.lineHeight = font.lineHeight + 'px';
      } catch (e) { /* detached */ }
    }
  }

  function refreshFonts() {
    var font = computeFont();
    var eds = allEmbedEditors();
    for (var i = 0; i < eds.length; i++) {
      try { eds[i].updateOptions({ fontSize: font.fontSize, lineHeight: font.lineHeight }); } catch (e) { /* disposed */ }
    }
    refreshLeftTables();
  }

  function refreshTheme() {
    try {
      if (window.EditorV2Engine && window.EditorV2Engine.syncMonacoTheme) window.EditorV2Engine.syncMonacoTheme();
    } catch (e) { /* engine unavailable */ }
    var theme = themeName();
    var eds = allEmbedEditors();
    for (var j = 0; j < eds.length; j++) {
      try { eds[j].updateOptions({ theme: theme }); } catch (e) { /* disposed */ }
    }
  }

  function ensureThemeObserver() {
    if (themeObserverOn || typeof MutationObserver === 'undefined' || !document.documentElement) return;
    themeObserverOn = true;
    var obs = new MutationObserver(function () { refreshTheme(); });
    try {
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-variant', 'data-theme-style'] });
    } catch (e) { /* observe unsupported */ }
  }

  function setFontScale(scale) {
    var s = parseFloat(scale);
    if (!isFinite(s)) return;
    s = Math.max(0.5, Math.min(3, s));
    try { localStorage.setItem('tr-editor-v2-text-zoom', String(s)); } catch (e) { /* storage unavailable */ }
    refreshFonts();
  }

  function getFontScale() {
    try {
      var raw = parseFloat(localStorage.getItem('tr-editor-v2-text-zoom'));
      if (isFinite(raw) && raw >= 0.5 && raw <= 3) return raw;
    } catch (e) { /* storage unavailable */ }
    return 1;
  }

  function getRecord(hostOrId) {
    var host = resolveHost(hostOrId);
    if (!host || !host.id) return null;
    var h = hosts[host.id];
    if (!h || !h.editor || !h.model) return null;
    if (!document.body.contains(host)) return null;
    return h;
  }


  function disposeHost(hostOrId) {
    var host = resolveHost(hostOrId);
    if (!host || !host.id || !hosts[host.id]) return;
    var h = hosts[host.id];
    delete hosts[host.id];
    try { if (h.editor) h.editor.dispose(); } catch (e) { /* already disposed */ }
    try { if (h.model) h.model.dispose(); } catch (e) { /* already disposed */ }
  }

  function apiHandle(id) {
    return {
      id: id,
      getValue: function () {
        var h = hosts[id];
        return h ? h.model.getValue() : null;
      },
      setValue: function (v) {
        var h = hosts[id];
        if (!h || typeof v !== 'string') return;
        if (h.model.getValue() === v) return;
        // Skip while the user is typing in the embed so the caret never jumps.
        try {
          if (h.editor.hasTextFocus && h.editor.hasTextFocus()) return;
        } catch (e) { /* focus query unavailable */ }
        h.model.setValue(v);
      },
      layout: function () {
        var h = hosts[id];
        if (h) { try { h.editor.layout(); } catch (e) { /* noop */ } }
      },
      dispose: function () {
        var h = hosts[id];
        if (h) disposeHost(h.host);
      },
    };
  }

  /**
   * Mount a single headerless Monaco editor into host.
   * Uses the native Monaco `placeholder` option (theme-aware, zero-offset).
   * opts: { value, filename, placeholder, wordWrap, readOnly, autofocus,
   *         onChange(value), onCtrlEnter(value), onSave(value) }
   */
  function createSingle(hostOrId, opts) {
    opts = opts || {};
    var host = resolveHost(hostOrId);
    if (!host) return Promise.reject(new Error('Embed host not found'));
    disposeHost(host);
    var id = hostIdOf(host);
    var value = (typeof opts.value === 'string') ? opts.value : '';
    var filename = opts.filename || 'prompt.txt';
    return ensureEngine().then(function (monaco) {
      if (!document.body.contains(host)) throw new Error('Embed host detached');
      disposeHost(host);
      var model = monaco.editor.createModel(value, langFor(filename));
      var font = computeFont();
      var editor = monaco.editor.create(host, {
        model: model,
        lineNumbers: 'on',
        minimap: { enabled: false },
        folding: true,
        glyphMargin: false,
        scrollBeyondLastLine: false,
        wordWrap: opts.wordWrap || 'on',
        wrappingIndent: 'none',
        automaticLayout: true,
        mouseWheelZoom: false,
        tabSize: 2,
        insertSpaces: true,
        fontSize: font.fontSize,
        lineHeight: font.lineHeight,
        theme: themeName(),
        renderWhitespace: 'selection',
        readOnly: !!opts.readOnly,
        placeholder: opts.placeholder || '',
      });
      var h = { editor: editor, model: model, host: host };
      hosts[id] = h;
      ensureThemeObserver();
      model.onDidChangeContent(function () {
        if (typeof opts.onChange === 'function') {
          try { opts.onChange(model.getValue()); } catch (e) { /* host callback fault */ }
        }
      });
      if (typeof opts.onCtrlEnter === 'function') {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function () {
          opts.onCtrlEnter(model.getValue());
        });
      }
      // Swallow Ctrl/Cmd+S inside the embed so the browser save dialog never opens.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
        if (typeof opts.onSave === 'function') {
          try { opts.onSave(model.getValue()); } catch (e) { /* host callback fault */ }
        }
      });
      if (!opts.readOnly && opts.autofocus !== false) {
        try { editor.focus(); } catch (e) { /* noop */ }
      }
      return apiHandle(id);
    });
  }

  function readHost(hostOrId) {
    var h = getRecord(hostOrId);
    return h ? h.model.getValue() : null;
  }

  function setHost(hostOrId, value) {
    var h = getRecord(hostOrId);
    if (!h || typeof value !== 'string') return;
    if (h.model.getValue() === value) return;
    try {
      if (h.editor.hasTextFocus && h.editor.hasTextFocus()) return;
    } catch (e) { /* focus query unavailable */ }
    h.model.setValue(value);
  }

  function layoutHost(hostOrId) {
    var h = getRecord(hostOrId);
    if (h) { try { h.editor.layout(); } catch (e) { /* noop */ } }
  }

  function isLive(hostOrId) {
    return getRecord(hostOrId) !== null;
  }

  function diffStatsText(rows) {
    var adds = 0;
    var dels = 0;
    var mods = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].type === 'add') adds++;
      else if (rows[i].type === 'del') dels++;
      else if (rows[i].type === 'mod') mods++;
    }
    return '共 ' + rows.length + ' 行 (+' + adds + ', -' + dels + ', ~' + mods + ')';
  }

  /**
   * Open the fixed diff modal on the native Monaco DiffEditor (Step4-style
   * 对照): left original + right edited, side-by-side alignment with blank
   * filler lines, synchronized scrolling, and char-level change highlights —
   * all built into the DiffEditor. Editing the right pane recomputes the
   * alignment live so the left reacts (左侧有反应). Per-row A/B decisions +
   * assemble() decide the save text ("改的结果显示在右侧" + 采纳语义).
   * opts: { title, original, current, filename, showSaveDefault,
   *         onSave(value) -> false keeps the modal open,
   *         onSaveDefault(value) }
   */
  function openDiffModal(opts) {
    opts = opts || {};
    var baseOriginal = (typeof opts.original === 'string') ? opts.original : '';
    var current = (typeof opts.current === 'string') ? opts.current : '';
    var filename = opts.filename || 'prompt.txt';
    var title = opts.title || tr('trSystemPrompt', 'System Prompt');
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show ed2-embed-overlay';
    // Header single line: title + stats text + prev/next + zoom pill + close.
    overlay.innerHTML =
      '<div class="modal ed2-embed-diff-modal" role="dialog" aria-label="' + escapeHtml(title) + '">' +
        '<div class="modal-title ed2-embed-diff-head"><span class="ed2-embed-diff-title">' + escapeHtml(title) + '</span>' +
        '<span class="ed2-embed-diff-stats" data-role="stats">计算中…</span>' +
        '<span class="ed2-embed-diff-nav">' +
        '<button class="pg-pane-btn pg-zoom-btn" data-act="prev" title="上一处差异" aria-label="Previous change">↑</button>' +
        '<button class="pg-pane-btn pg-zoom-btn" data-act="next" title="下一处差异" aria-label="Next change">↓</button>' +
        '</span>' +
        '<span class="pg-zoom-group ed2-embed-zoom-pill" role="group" aria-label="Text size">' +
        '<button class="pg-pane-btn pg-zoom-btn" data-act="zoom-out" title="减小字号" aria-label="Decrease text size">−</button>' +
        '<button class="pg-pane-btn pg-zoom-btn" data-act="zoom-reset" title="恢复默认字号" aria-label="Reset text size">↺</button>' +
        '<button class="pg-pane-btn pg-zoom-btn" data-act="zoom-in" title="增大字号" aria-label="Increase text size">+</button>' +
        '</span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="close" aria-label="Close">✕</button></div>' +
        '<div class="ed2-embed-diff-body">' +
          '<div class="ed2-embed-pane"><div class="ed2-embed-diff-scroll" data-role="left-scroll"><div class="ed2-embed-diff-table" data-role="left-table"></div></div></div>' +
          '<div class="ed2-embed-pane"><div class="ed2-embed-host" data-role="right"></div></div>' +
        '</div>' +
        '<div class="modal-footer ed2-embed-diff-foot">' +
          (opts.showRestoreBuiltIn ? '<button type="button" class="btn btn-ghost" data-act="restore-builtin">' + escapeHtml(tr('trResetPromptDefault', 'Restore to Built-in')) + '</button>' : '') +
          (opts.showSaveDefault ? '<button type="button" class="btn btn-secondary" data-act="save-default">' + escapeHtml(tr('trSavePromptDefault', '设为默认')) + '</button>' : '') +
          '<button type="button" class="btn btn-ghost" data-act="close">' + escapeHtml(tr('cancel', '取消')) + '</button>' +
          '<button type="button" class="btn btn-primary" data-act="save">' + escapeHtml(tr('save', '保存')) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var rightEditor = null;
    var rightModel = null;
    var rows = [];
    var navIdx = -1;
    var debounceTimer = null;
    var closed = false;
    var scrollLock = false;
    ensureThemeObserver();

    function cleanup() {
      if (closed) return;
      closed = true;
      clearTimeout(debounceTimer);
      debounceTimer = null;
      try {
        if (rightEditor && rightEditor.changeViewZones && zoneIds.length) {
          var dead = zoneIds.slice();
          zoneIds = [];
          rightEditor.changeViewZones(function (acc) { for (var zi = 0; zi < dead.length; zi++) { try { acc.removeZone(dead[zi]); } catch (e0) { /* gone */ } } });
        }
      } catch (e) { /* noop */ }
      for (var li = liveModalEditors.length - 1; li >= 0; li--) {
        try {
          if (rightEditor && liveModalEditors[li] === rightEditor) liveModalEditors.splice(li, 1);
        } catch (e) { liveModalEditors.splice(li, 1); }
      }
      try { if (rightEditor) rightEditor.dispose(); } catch (e) { /* noop */ }
      try { if (rightModel) rightModel.dispose(); } catch (e) { /* noop */ }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.__close = cleanup;

    function statsEl() {
      return overlay.querySelector('[data-role="stats"]');
    }
    function leftTable() { return overlay.querySelector('[data-role="left-table"]'); }
    function leftScroll() { return overlay.querySelector('[data-role="left-scroll"]'); }

    // Right pane is the user's plain editing surface: zero decorations.
    // Left pane is the change display: padded aligned rows with markers.
    function recompute() {
      if (closed || !rightModel) return;
      if (!window.EditorV2DiffCore) {
        var st0 = statsEl();
        if (st0) st0.textContent = 'Diff 内核未加载';
        return;
      }
      var rightVal = rightModel.getValue();
      try {
        rows = window.EditorV2DiffCore.compare(baseOriginal, rightVal, window.Diff);
      } catch (err) {
        var stErr = statsEl();
        if (stErr) stErr.textContent = 'Diff 计算失败: ' + (err.message || err);
        return;
      }
      var st = statsEl();
      if (st) st.textContent = diffStatsText(rows);
      if (navIdx >= changeCount()) navIdx = changeCount() - 1;
      renderLeft();
    }

    function changeCount() {
      var n = 0;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].type !== 'context') n++;
      }
      return n;
    }

    function changeRowAt(k) {
      var n = -1;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].type === 'context') continue;
        n++;
        if (n === k) return rows[i];
      }
      return null;
    }

    function scheduleRecompute() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(recompute, 350);
    }

    // A mod row is a paired deleted+added line: marker and styling follow the
    // WORD-level parts, not the row type. Pure append (no removed chars)
    // reads as an addition: green + marker, zero strikethrough.
    function modHasRemoved(r) {
      if (!r.leftParts || !r.leftParts.length) return true;
      for (var i = 0; i < r.leftParts.length; i++) {
        if (r.leftParts[i].removed) return true;
      }
      return false;
    }
    function modHasAdded(r) {
      if (!r.rightParts || !r.rightParts.length) return true;
      for (var i = 0; i < r.rightParts.length; i++) {
        if (r.rightParts[i].added) return true;
      }
      return false;
    }
    // 空行填入正文(如原空行变 111):显示层按纯增处理,与 add 行一致
    function isEmptyToContent(r) {
      return r.type === 'mod' && r.left && r.left.text === '' && r.right && r.right.text !== '';
    }

    function markerFor(r) {
      if (r.type === 'del') return { text: '-', cls: 'ed2-embed-mark-del' };
      if (r.type === 'add') return { text: '+', cls: 'ed2-embed-mark-add' };
      if (r.type === 'mod') {
        if (isEmptyToContent(r)) return { text: '+', cls: 'ed2-embed-mark-add' };
        var hr = modHasRemoved(r);
        var ha = modHasAdded(r);
        if (ha && !hr) return { text: '+', cls: 'ed2-embed-mark-add' };
        if (hr && !ha) return { text: '-', cls: 'ed2-embed-mark-del' };
        return { text: '-+', cls: 'ed2-embed-mark-mod' };
      }
      return { text: '', cls: '' };
    }

    // 严格行号 1:1:左表按右行号分块,块数 == 右行数,块号 == 右行号。
    // del-only 行无右行号,不占号,折入相邻右块(前置入下一块,尾删并入末块;
    // 右空时并为 1 号块)。块内:原文置顶(删字红线)+ 换行 + 完整绿字新文。
    function renderLeft() {
      var lt = leftTable();
      if (!lt) return;
      var blocks = [];
      var pending = [];
      var k = 0;
      for (k = 0; k < rows.length; k++) {
        var r0 = rows[k];
        if (r0.type === 'del') { pending.push(r0); continue; }
        if (!r0.right) { pending.push(r0); continue; }
        blocks.push({ num: r0.right.num, main: r0, dels: pending });
        pending = [];
      }
      if (pending.length) {
        if (blocks.length) blocks[blocks.length - 1].tails = pending;
        else blocks.push({ num: 1, main: null, dels: pending, tails: [] });
      }
      var html = '';
      for (var bi = 0; bi < blocks.length; bi++) {
        var b = blocks[bi];
        var main = b.main;
        var mk = blockMarker(b);
        var cls = main ? main.type : 'del';
        // 混合块(含折入删除)一律按 mod 取橙边,纯增/纯删保持原色
        if ((b.dels && b.dels.length) || (b.tails && b.tails.length)) {
          if (!main || main.type === 'context') cls = 'mod';
        }
        var cell = blockCell(b);
        var anchor = main ? main.id : (b.dels.length ? b.dels[0].id : bi);
        html += '<div class="ed2-embed-drow ' + cls + '" data-row="' + anchor + '" data-br="' + b.num + '">' +
          '<span class="ed2-embed-dnum">' + b.num + '</span>' +
          '<span class="ed2-embed-dmark ' + mk.cls + '">' + mk.text + '</span>' +
          '<span class="ed2-embed-dtext">' + cell + '</span>' +
          '</div>';
      }
      lt.innerHTML = html;
      requestPad();
    }

    // 右侧垫空(px 实测):左块 offsetHeight vs 右行实高,差值垫 viewZone —
    // 不估行数(左行 +2px padding 与两侧换行差异会累积漂移),左右 2↔2 永远同水平。
    // 签名不变跳过重建,防 350ms 重算抖动;调用经 rAF 合并到布局后。
    var zoneIds = [];
    var lastPadSig = '';
    var padQueued = false;
    function requestPad() {
      if (padQueued || closed) return;
      padQueued = true;
      function run() {
        padQueued = false;
        syncRightPadding();
      }
      try {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 0);
      } catch (e) { try { setTimeout(run, 0); } catch (e2) { /* noop */ } }
    }
    function syncRightPadding() {
      if (!rightEditor || closed || !rightEditor.changeViewZones) return;
      var lt = leftTable();
      if (!lt || !lt.children || !lt.children.length) return;
      var domLib = (typeof window !== 'undefined' && window.document) ? window.document : null;
      if (!domLib) return;
      try {
        var kids = lt.children;
        var monoLH = 0;
        try { monoLH = computeFont().lineHeight || 0; } catch (e0) { monoLH = 0; }
        // 自清防护:sig 先算后清 — 同布局第二次 sync 直接返回,不碰现存 zone。
        // (先清后比会在 sig 命中时 early-return,把刚清掉的 zone 弄丢。)
        var sigParts = [];
        var ops = [];
        // 预扫描(不清 zone):旧垫高会污染 getTopForLineNumber,此处只取签名 —
        // 真正量 rightH 在清 zone 后重测,签名键只用左高+行号,不含被污染的 rightH。
        for (var pre = 0; pre < kids.length; pre++) {
          var prow = kids[pre];
          var pbr = parseInt(prow.getAttribute('data-br'), 10);
          if (!isFinite(pbr) || pbr < 1) continue;
          var plh = 0;
          try { plh = prow.offsetHeight || 0; } catch (ep) { plh = 0; }
          sigParts.push(pbr + ':' + Math.round(plh));
        }
        var preSig = sigParts.join(',');
        if (preSig === lastPadSig) return;
        // 签名未命中才清:旧垫高污染 getTopForLineNumber,清后再量真右高。
        if (zoneIds.length) {
          var dead = zoneIds.slice();
          zoneIds = [];
          try { rightEditor.changeViewZones(function (acc) { for (var zi = 0; zi < dead.length; zi++) { try { acc.removeZone(dead[zi]); } catch (e3) { /* gone */ } } }); } catch (e5) { /* noop */ }
        }
        sigParts = [];
        ops = [];
        for (var bi = 0; bi < kids.length; bi++) {
          var rowEl = kids[bi];
          var br = parseInt(rowEl.getAttribute('data-br'), 10);
          if (!isFinite(br) || br < 1) continue;
          var leftH = 0;
          try { leftH = rowEl.offsetHeight || 0; } catch (e1) { leftH = 0; }
          var rightH = monoLH;
          try {
            var t1 = rightEditor.getTopForLineNumber(br);
            var t2 = rightEditor.getTopForLineNumber(br + 1);
            if (isFinite(t1) && isFinite(t2) && t2 > t1) rightH = t2 - t1;
          } catch (e2) { /* keep fallback */ }
          if (!(rightH > 0)) continue;
          sigParts.push(br + ':' + Math.round(leftH) + ':' + Math.round(rightH));
          var diff = leftH - rightH;
          if (diff > 1) ops.push({ after: br, px: Math.round(diff) });
        }
        lastPadSig = preSig;
        var freshIds = [];
        if (ops.length) {
          rightEditor.changeViewZones(function (acc) {
            for (var oi = 0; oi < ops.length; oi++) {
              var holder = domLib.createElement('div');
              holder.className = 'ed2-embed-padzone';
              try { freshIds.push(acc.addZone({ afterLineNumber: ops[oi].after, heightInPx: ops[oi].px, domNode: holder, suppressMouseEvent: true })); } catch (e4) { /* skip */ }
            }
          });
        }
        zoneIds = freshIds;
      } catch (e) { /* viewZones unavailable */ }
    }

    function blockMarker(b) {
      var main = b.main;
      var hasDel = (b.dels && b.dels.length > 0) || (b.tails && b.tails.length > 0);
      if (main && main.type === 'del') hasDel = true;
      if (!main) return { text: '-', cls: 'ed2-embed-mark-del' };
      if (main.type === 'add') return hasDel
        ? { text: '-+', cls: 'ed2-embed-mark-mod' }
        : { text: '+', cls: 'ed2-embed-mark-add' };
      if (main.type === 'del') return { text: '-', cls: 'ed2-embed-mark-del' };
      if (main.type === 'context') return hasDel
        ? { text: '-', cls: 'ed2-embed-mark-del' }
        : { text: '', cls: '' };
      // mod 主行:沿用词级 marker,有折入删除时至少 -+
      var m = markerFor(main);
      if (hasDel && (m.text === '+' || m.text === '')) return { text: '-+', cls: 'ed2-embed-mark-mod' };
      return m;
    }

    function blockCell(b) {
      var out = [];
      var di = 0;
      if (b.dels) {
        for (di = 0; di < b.dels.length; di++) {
          var d = b.dels[di];
          var dt = (d.left && typeof d.left.text === 'string') ? d.left.text : '';
          out.push('<span class="ed2-embed-dtext-del">' + escapeHtml(dt === '' ? ' ' : dt) + '</span>');
        }
      }
      var main = b.main;
      if (main) {
        if (main.type === 'context') {
          var ct = main.right ? main.right.text : (main.left ? main.left.text : '');
          out.push(escapeHtml(ct === '' ? ' ' : ct));
        } else if (main.type === 'add') {
          var at = (main.right && typeof main.right.text === 'string') ? main.right.text : '';
          out.push('<span class="ed2-embed-dtext-add">' + escapeHtml(at === '' ? ' ' : at) + '</span>');
        } else if (main.type === 'mod') {
          if (isEmptyToContent(main)) {
            var et = (main.right && typeof main.right.text === 'string') ? main.right.text : '';
            out.push('<span class="ed2-embed-dtext-add">' + escapeHtml(et === '' ? ' ' : et) + '</span>');
          } else if (main.leftParts && main.leftParts.length && main.rightParts && main.rightParts.length) {
            out.push(modInline(main));
          } else {
            var lt0 = (main.left && typeof main.left.text === 'string') ? main.left.text : '';
            var rt0 = (main.right && typeof main.right.text === 'string') ? main.right.text : '';
            out.push(escapeHtml(lt0 === '' ? ' ' : lt0));
            out.push('<span class="ed2-embed-dtext-add">' + escapeHtml(rt0 === '' ? ' ' : rt0) + '</span>');
          }
        } else if (main.type === 'del') {
          var dlt = (main.left && typeof main.left.text === 'string') ? main.left.text : '';
          out.push('<span class="ed2-embed-dtext-del">' + escapeHtml(dlt === '' ? ' ' : dlt) + '</span>');
        }
      }
      if (b.tails) {
        for (var ti = 0; ti < b.tails.length; ti++) {
          var td = b.tails[ti];
          var tt = (td.left && typeof td.left.text === 'string') ? td.left.text : '';
          out.push('<span class="ed2-embed-dtext-del">' + escapeHtml(tt === '' ? ' ' : tt) + '</span>');
        }
      }
      return out.length ? out.join('<br>') : ' ';
    }
    // 真改行块内:删线原文(词级删字红线) + 换行 + 完整绿字新文 —
    // 词级错拼不可信,绿字永远取完整新行,删线只做删除提示
    function modInline(r) {
      var delHtml = '';
      if (r.leftParts && r.leftParts.length) {
        delHtml = charSpans(r.leftParts, 'removed', 'ed2-embed-char-del');
      } else if (r.left) {
        delHtml = escapeHtml(r.left.text);
      }
      var addHtml = '';
      if (r.right && typeof r.right.text === 'string') {
        addHtml = '<span class="ed2-embed-dtext-add">' + escapeHtml(r.right.text === '' ? ' ' : r.right.text) + '</span>';
      }
      if (delHtml && addHtml) return delHtml + '<br>' + addHtml;
      return delHtml + addHtml;
    }

    function charSpans(parts, wantFlag, cls) {
      var html = '';
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        var hl = p[wantFlag] ? ' class="' + cls + '"' : '';
        html += '<span' + hl + '>' + escapeHtml(p.text) + '</span>';
      }
      return html;
    }

    function gotoChange(dir) {
      var total = changeCount();
      if (total === 0 || !rightEditor) return;
      if (dir > 0) navIdx = (navIdx >= total - 1) ? 0 : navIdx + 1;
      else navIdx = (navIdx <= 0) ? total - 1 : navIdx - 1;
      var row = changeRowAt(navIdx);
      if (!row) return;
      // del 行无独立块:向前找下一右行块,无则向后找上一右行块,全删则首行 1 号块。
      var anchorId = row.id;
      var targetBr = (row.right && row.right.num) ? row.right.num : 0;
      if (!row.right) {
        var ri = rows.indexOf(row);
        var found = null;
        for (var fi = ri + 1; fi < rows.length; fi++) { if (rows[fi].right) { found = rows[fi]; break; } }
        if (!found) { for (var bi2 = ri - 1; bi2 >= 0; bi2--) { if (rows[bi2].right) { found = rows[bi2]; break; } } }
        if (found) { anchorId = found.id; targetBr = found.right.num; }
        else { anchorId = rows.length ? rows[0].id : row.id; targetBr = 1; }
      }
      var lt = leftTable();
      if (lt) {
        var el = lt.querySelector('[data-row="' + anchorId + '"]');
        if (!el && targetBr) el = lt.querySelector('[data-br="' + targetBr + '"]');
        if (el) {
          try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* noop */ }
        }
      }
      var line = targetBr || 1;
      try { rightEditor.revealLineInCenter(line); } catch (e2) { /* noop */ }
      try {
        rightEditor.setPosition({ lineNumber: line, column: 1 });
        rightEditor.focus();
      } catch (e3) { /* noop */ }
    }

    function applyAssemble() {
      // Right pane is the source of truth: save text == right editor text.
      return rightModel ? rightModel.getValue() : current;
    }

    // Scroll sync: left table scroll drives the right editor and vice versa.
    function bindScrollSync() {
      var ls = leftScroll();
      if (!ls) return;
      ls.addEventListener('scroll', function () {
        if (scrollLock || closed || !rightEditor) return;
        scrollLock = true;
        try {
          var ratio = ls.scrollTop / Math.max(1, ls.scrollHeight - ls.clientHeight);
          var ed = rightEditor;
          var maxTop = Math.max(1, ed.getScrollHeight() - ed.getLayoutInfo().height);
          ed.setScrollTop(ratio * maxTop);
        } catch (e) { /* noop */ }
        scrollLock = false;
      });
    }
    function bindRightScrollSync() {
      if (!rightEditor) return;
      rightEditor.onDidScrollChange(function (e) {
        if (scrollLock || closed) return;
        var ls = leftScroll();
        if (!ls) return;
        scrollLock = true;
        try {
          var maxTop = Math.max(1, rightEditor.getScrollHeight() - rightEditor.getLayoutInfo().height);
          var ratio = (e.scrollTop || 0) / maxTop;
          ls.scrollTop = ratio * (ls.scrollHeight - ls.clientHeight);
        } catch (err) { /* noop */ }
        scrollLock = false;
      });
    }
    overlay.querySelector('[data-act="close"]').addEventListener('click', cleanup);
    var footerClose = overlay.querySelector('.ed2-embed-diff-foot [data-act="close"]');
    if (footerClose) footerClose.addEventListener('click', cleanup);
    overlay.querySelector('[data-act="prev"]').addEventListener('click', function () { gotoChange(-1); });
    overlay.querySelector('[data-act="next"]').addEventListener('click', function () { gotoChange(1); });
    overlay.querySelector('[data-act="zoom-out"]').addEventListener('click', function () { if (window.__zoom && window.__zoom.editorV2Step) { try { window.__zoom.editorV2Step(-0.1); } catch (e) {} } refreshFonts(); try { renderLeft(); } catch (e4) { /* noop */ } });
    overlay.querySelector('[data-act="zoom-reset"]').addEventListener('click', function () { if (window.__zoom && window.__zoom.editorV2Reset) { try { window.__zoom.editorV2Reset(); } catch (e2) {} } refreshFonts(); try { renderLeft(); } catch (e4) { /* noop */ } });
    overlay.querySelector('[data-act="zoom-in"]').addEventListener('click', function () { if (window.__zoom && window.__zoom.editorV2Step) { try { window.__zoom.editorV2Step(0.1); } catch (e3) {} } refreshFonts(); try { renderLeft(); } catch (e4) { /* noop */ } });
    overlay.querySelector('[data-act="save"]').addEventListener('click', function () {
      var val = applyAssemble();
      var keep = false;
      if (typeof opts.onSave === 'function') {
        try { keep = opts.onSave(val) === false; } catch (e) { /* host callback fault */ }
      }
      if (!keep) cleanup();
    });
    var saveDefaultBtn = overlay.querySelector('[data-act="save-default"]');
    if (saveDefaultBtn) {
      saveDefaultBtn.addEventListener('click', function () {
        var val = applyAssemble();
        function applyBaseline() {
          baseOriginal = val;
          navIdx = -1;
          recompute();
        }
        if (typeof opts.onSaveDefault === 'function') {
          try {
            var r = opts.onSaveDefault(val);
            if (r && typeof r.then === 'function') r.then(applyBaseline, applyBaseline);
            else applyBaseline();
          } catch (e) { /* host callback fault */ }
        } else {
          applyBaseline();
        }
      });
    }
    var restoreBtn = overlay.querySelector('[data-act="restore-builtin"]');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', function () {
        if (typeof opts.onRestoreBuiltIn !== 'function' || !rightModel) return;
        try {
          var p = opts.onRestoreBuiltIn();
          if (p && typeof p.then === 'function') {
            p.then(function (txt) {
              if (closed || typeof txt !== 'string' || !txt) return;
              try { rightModel.setValue(txt); } catch (e) { /* detached */ }
              navIdx = -1;
              recompute();
            }, function () { /* keep current text on failure */ });
          }
        } catch (e) { /* host callback fault */ }
      });
    }

    bindScrollSync();
    // Static first paint (left table) before Monaco arrives.
    try {
      if (window.EditorV2DiffCore) {
        rows = window.EditorV2DiffCore.compare(baseOriginal, current, window.Diff);
        var stFirst = statsEl();
        if (stFirst) stFirst.textContent = diffStatsText(rows);
        renderLeft();
      }
    } catch (e) { /* first paint deferred to engine load */ }
    // Match the shared EditorV2 scale from the first paint: the table is
    // plain DOM, so Monaco's fontSize never reaches it on its own.
    try { refreshLeftTables(); } catch (e) { /* detached */ }
    ensureEngine().then(function (monaco) {
      if (closed) return;
      var font = computeFont();
      var theme = themeName();
      var lang = langFor(filename);
      var rightHost = overlay.querySelector('[data-role="right"]');
      rightModel = monaco.editor.createModel(current, lang);
      rightEditor = monaco.editor.create(rightHost, {
        model: rightModel,
        lineNumbers: 'on',
        minimap: { enabled: false },
        folding: true,
        glyphMargin: false,
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        wrappingIndent: 'none',
        automaticLayout: true,
        mouseWheelZoom: false,
        tabSize: 2,
        insertSpaces: true,
        fontSize: font.fontSize,
        lineHeight: font.lineHeight,
        theme: theme,
        renderWhitespace: 'selection',
      });
      liveModalEditors.push(rightEditor);
      rightModel.onDidChangeContent(scheduleRecompute);
      bindRightScrollSync();
      try { rightEditor.focus(); } catch (e2) { /* noop */ }
      recompute();
    }).catch(function (err) {
      if (closed) return;
      var st = statsEl();
      if (st) st.textContent = '编辑器加载失败: ' + (err.message || err);
    });

    return { close: cleanup, element: overlay };
  }

  window.EditorV2Embed = {
    ensureEngine: ensureEngine,
    createSingle: createSingle,
    disposeHost: disposeHost,
    readHost: readHost,
    setHost: setHost,
    layoutHost: layoutHost,
    isLive: isLive,
    refreshFonts: refreshFonts,
    refreshTheme: refreshTheme,
    setFontScale: setFontScale,
    getFontScale: getFontScale,
    openDiffModal: openDiffModal,
  };
})();
