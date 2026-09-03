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

  function updateGutter() {
    if (!shellRoot) return;
    var gutter = shellRoot.querySelector('#ed-line-gutter');
    var input = currentInput();
    if (!gutter || !input) return;
    var lines = input.value.split(/\r?\n/);
    var count = Math.max(1, lines.length);
    gutter.innerHTML = '';
    for (var i = 1; i <= count; i++) {
      var span = global.document.createElement('span');
      span.className = 'ed-line-number';
      var lineText = lines[i - 1] || '';
      var trimmed = lineText.trim();
      if (/^(\/\/|#|\/\*|\*)/.test(trimmed)) {
        span.className += ' is-comment';
      }
      span.textContent = String(i);
      gutter.appendChild(span);
    }
    gutter.scrollTop = input.scrollTop;
    updateOverlay();
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
    var ext = shellState.currentNode ? edFileExt(shellState.currentNode.name) : 'md';
    var isHtml = typeof edIsHtmlExt === 'function' ? edIsHtmlExt(ext) : (ext === 'html' || ext === 'htm');

    if (shellState.htmlRender || isHtml) {
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
      return;
    }

    preview.classList.remove('is-html-iframe-mode');
    var html = global.EditorMarkdown.renderMarkdown(content);
    preview.innerHTML = html;
    global.EditorMarkdown.highlightCode(preview);
    renderToc(preview);
    updateStatus();
  }

  function updateStatus() {
    if (!shellRoot) return;
    var input = currentInput();
    var content = input ? input.value : '';
    var preview = shellRoot.querySelector('#ed-main-preview');
    var stats = global.EditorMarkdown.getStats(content, preview ? preview.innerHTML : '');
    var selStart = input ? (input.selectionStart || 0) : 0;
    var selEnd = input ? (input.selectionEnd || 0) : 0;
    var before = input ? content.slice(0, selStart) : '';
    var line = before ? before.split(/\r?\n/).length : 1;
    var column = before ? before.length - before.lastIndexOf('\n') : 0;
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
    var onInput = function () { if (global.EditorCommands) global.EditorCommands.record(input); saveDraft(shellState.currentId, input.value); updateGutter(); renderPreview(); };
    var onScroll = function () {
      updateGutter();
      syncOverlayScroll();
      if (!shellState.sync || !shellRoot) return;
      var preview = shellRoot.querySelector('#ed-main-preview');
      if (!preview) return;
      var ratio = input.scrollHeight > input.clientHeight ? input.scrollTop / (input.scrollHeight - input.clientHeight) : 0;
      preview.scrollTop = ratio * Math.max(0, preview.scrollHeight - preview.clientHeight);
    };
    var onKey = function (event) {
      var mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); saveWorkspace(); }
      else if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) triggerRedo(); else triggerUndo(); }
      else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); triggerRedo(); }
      else if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); shellFindToggle(); }
      else if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        if (global.EditorCommands && typeof global.EditorCommands.indent === 'function') {
          global.EditorCommands.indent(input, event.shiftKey);
        }
      }
      else if (event.altKey && !mod && event.key === '/') {
        event.preventDefault();
        event.stopPropagation();
        if (global.EditorCommands && typeof global.EditorCommands.toggleComment === 'function') {
          global.EditorCommands.toggleComment(input);
        }
      }
      else if (event.altKey && event.shiftKey && !mod && (event.key === 'ArrowUp' || event.key === 'Up')) {
        event.preventDefault();
        event.stopPropagation();
        if (global.EditorCommands && typeof global.EditorCommands.duplicateLine === 'function') {
          global.EditorCommands.duplicateLine(input, 'up');
        }
      }
      else if (event.altKey && event.shiftKey && !mod && (event.key === 'ArrowDown' || event.key === 'Down')) {
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

    shellHandlers = { input: onInput, scroll: onScroll, keydown: onKey, previewClick: onClick, preview: preview, inputNode: input };
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
    if (h.inputNode) { h.inputNode.removeEventListener('input', h.input); h.inputNode.removeEventListener('scroll', h.scroll); h.inputNode.removeEventListener('keydown', h.keydown); }
    if (h.preview) h.preview.removeEventListener('click', h.previewClick);
    shellHandlers = null;
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
