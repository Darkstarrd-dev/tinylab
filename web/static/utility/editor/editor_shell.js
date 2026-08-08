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
    expanded: []
  };
  var shellFind = { visible: false, query: '', replace: '', index: 0, matches: [] };

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
  function updateGutter() {
    if (!shellRoot) return;
    var gutter = shellRoot.querySelector('#ed-line-gutter');
    var input = currentInput();
    if (!gutter || !input) return;
    var count = Math.max(1, input.value.split(/\r?\n/).length);
    gutter.innerHTML = '';
    for (var i = 1; i <= count; i++) {
      var span = global.document.createElement('span');
      span.className = 'ed-line-number';
      span.textContent = String(i);
      gutter.appendChild(span);
    }
    gutter.scrollTop = input.scrollTop;
  }

  function renderToc(preview) {
    if (!shellRoot || !preview) return;
    var list = shellRoot.querySelector('.ed-toc-list');
    if (!list) return;
    list.innerHTML = '';
    var toc = global.EditorMarkdown.buildToc(preview);
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
    var html = global.EditorMarkdown.renderMarkdown(currentText());
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
  function saveWorkspace() {
    var input = currentInput();
    if (!input || !shellState.currentId) return Promise.resolve(false);
    var value = input.value;
    var savePromise;
    if (shellState.currentNode && shellState.currentNode.externalPath) {
      savePromise = fetch('/api/editor/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: shellState.currentNode.externalPath, content: value })
      }).then(function (response) { return response.json(); }).then(function (data) {
        if (!data || !data.ok) return false;
        return global.EditorWorkspace.updateNode(shellState.currentId, { content: value }).then(function (node) { return !!node; });
      });
    } else {
      savePromise = global.EditorWorkspace.updateNode(shellState.currentId, { content: value }).then(function (node) { return !!node; });
    }
    return savePromise.then(function (saved) {
      if (!saved) { toast(tr('editorSaveFailed', 'Save failed'), 'error'); return false; }
      shellState.original = value;
      shellState.dirty = false;
      updateStatus();
      toast(tr('editorSaved', 'File saved'), 'success');
      return true;
    });
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

  function redraw() {
    if (!shellRoot) return;
    global.EditorLayout.setMode(shellRoot, shellState.mode);
    global.EditorLayout.setReader(shellRoot, shellState.reader);
    global.EditorLayout.setFocus(shellRoot, shellState.focus);
    global.EditorLayout.setPreview(shellRoot, shellState.preview);
    global.EditorLayout.setExplorer(shellRoot, shellState.explorer);
    global.EditorLayout.setSync(shellRoot, shellState.sync);
    if (shellState.mode === 'diff') renderDiff(); else renderPreview();
  }

  function saveWorkspace() {
    var input = currentInput();
    if (!input || !shellState.currentId) return Promise.resolve(false);
    var value = input.value;
    var savePromise;
    if (shellState.currentNode && shellState.currentNode.externalPath) {
      savePromise = fetch('/api/editor/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: shellState.currentNode.externalPath, content: value })
      }).then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok || !data || !data.ok) return false;
          return global.EditorWorkspace.updateNode(shellState.currentId, { content: value }).then(function (node) { return !!node; });
        });
      }).catch(function () { return false; });
    } else {
      savePromise = global.EditorWorkspace.updateNode(shellState.currentId, { content: value }).then(function (node) { return !!node; });
    }
    return savePromise.then(function (saved) {
      if (!saved) { toast(tr('editorSaveFailed', 'Save failed'), 'error'); return false; }
      shellState.original = value;
      shellState.dirty = false;
      updateStatus();
      toast(tr('editorSaved', 'File saved'), 'success');
      return true;
    });
  }

  function loadFile(id) {
    return Promise.all([global.EditorWorkspace.getNode(id), global.EditorWorkspace.getContent(id)]).then(function (values) {
      if (!values[0] || values[0].type !== 'file') return false;
      shellState.selectedId = id;
      shellState.selectedNode = values[0];
      shellState.currentId = id;
      shellState.currentNode = values[0];
      shellState.original = text(values[1]);
      var input = currentInput();
      if (input) input.value = shellState.original;
      global.EditorWorkspace.setCurrentFile(id);
      if (global.EditorCommands) global.EditorCommands.record(input);
      updateGutter();
      shellState.mode = 'edit';
      redraw();
      if (input) input.focus();
      return true;
    });
  }

  function refreshTree() {
    return global.EditorWorkspace.listNodes().then(function (nodes) {
      var tree = shellRoot && shellRoot.querySelector('#ed-file-tree');
      if (tree) global.EditorLayout.renderTree(tree, buildTree(nodes), { selectedId: shellState.selectedId || shellState.currentId }, shellHooks());
      return nodes;
    });
  }

  function selectedParent() {
    return shellState.selectedNode && shellState.selectedNode.type === 'folder' ? shellState.selectedNode.id : null;
  }


  function createFile() {
    var name = global.prompt(tr('editorNewFile', 'New file'), 'untitled.md');
    if (!name) return;
    global.EditorWorkspace.putFile(name, '', selectedParent()).then(function (node) { if (node) { refreshTree().then(function () { loadFile(node.id); }); } else toast('A file with that name already exists', 'warning'); });
  }
  function createFolder() {
    var name = global.prompt(tr('editorNewFolder', 'New folder'), 'New folder');
    if (!name) return;
    global.EditorWorkspace.putFolder(name, selectedParent()).then(function (node) { if (node) refreshTree(); else toast('A folder with that name already exists', 'warning'); });
  }
  function renameCurrent() {
    var targetId = shellState.selectedId || shellState.currentId;
    var targetNode = shellState.selectedNode || shellState.currentNode;
    if (!targetId || !targetNode || targetNode.system) return;
    var name = global.prompt(tr('editorRename', 'Rename'), targetNode.name);
    if (!name || name === targetNode.name) return;
    global.EditorWorkspace.updateNode(targetId, { name: name }).then(function (node) {
      if (!node) return;
      shellState.selectedNode = node;
      if (shellState.currentId === targetId) shellState.currentNode = node;
      refreshTree();
      updateStatus();
    });
  }
  function deleteCurrent() {
    var targetId = shellState.selectedId || shellState.currentId;
    var targetNode = shellState.selectedNode || shellState.currentNode;
    if (!targetId || !targetNode || targetNode.system) return;
    global.EditorWorkspace.deleteNode(targetId).then(function () { return global.EditorWorkspace.getCurrentFileId(); }).then(function (id) {
      shellState.selectedId = null;
      shellState.selectedNode = null;
      return refreshTree().then(function () { return loadFile(id || 'file:welcome'); });
    });
  }

  function importWorkspaceFile(name, content, meta) {
    return global.EditorWorkspace.putFile(name, content, null, meta || { imported: true }).then(function (node) {
      if (!node) { toast('A file with that name already exists', 'warning'); return false; }
      return refreshTree().then(function () { return loadFile(node.id); });
    });
  }

  function openLocalFile() {
    return fetch('/api/editor/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data && data.path !== undefined && data.content !== undefined) return importWorkspaceFile(data.name || 'untitled.md', data.content, { externalPath: data.path, imported: true });
        if (data && !data.unsupported && !data.cancelled) return false;
        var picker = global.FsApi && global.FsApi.pickFiles ? global.FsApi.pickFiles({ multiple: false }) : Promise.resolve([]);
        return picker.then(function (entries) {
          if (!entries || !entries.length) return false;
          var entry = entries[0];
          var filePromise = entry.file ? Promise.resolve(entry.file) : (entry.handle && entry.handle.getFile ? entry.handle.getFile() : Promise.resolve(null));
          return filePromise.then(function (file) { return file ? file.text().then(function (content) { return importWorkspaceFile(file.name, content); }) : false; });
        });
      })
      .catch(function () {
        var picker = global.FsApi && global.FsApi.pickFiles ? global.FsApi.pickFiles({ multiple: false }) : Promise.resolve([]);
        return picker.then(function (entries) {
          if (!entries || !entries.length) return false;
          var entry = entries[0];
          var filePromise = entry.file ? Promise.resolve(entry.file) : (entry.handle && entry.handle.getFile ? entry.handle.getFile() : Promise.resolve(null));
          return filePromise.then(function (file) { return file ? file.text().then(function (content) { return importWorkspaceFile(file.name, content); }) : false; });
        });
      });
  }

  function importFile() {
    var picker = global.FsApi && global.FsApi.pickFiles ? global.FsApi.pickFiles({ multiple: false, accept: { 'text/plain': ['.md', '.markdown', '.txt'], 'text/html': ['.html', '.htm'] } }) : Promise.resolve([]);
    return picker.then(function (entries) {
      if (!entries || !entries.length) return false;
      var entry = entries[0];
      var filePromise = entry.file ? Promise.resolve(entry.file) : (entry.handle && entry.handle.getFile ? entry.handle.getFile() : Promise.resolve(null));
      return filePromise.then(function (file) {
        if (!file) return false;
        return file.text().then(function (content) {
          var isHtml = /\.html?$/i.test(file.name || '');
          if (isHtml && typeof global.TurndownService === 'function') {
            try { content = new global.TurndownService().turndown(content); } catch (e) {}
          }
          return importWorkspaceFile(file.name.replace(/\.html?$/i, isHtml ? '.md' : ''), content);
        });
      });
    });
  }
  function exportFile(kind) {
    var content = currentText();
    var name = (shellState.currentNode && shellState.currentNode.name) || 'untitled.md';
    if (kind === 'html') content = global.EditorMarkdown.toHtmlDocument(content, name);
    var filename = kind === 'html' ? name.replace(/\.[^.]*$/, '') + '.html' : name;
    return global.FsApi && global.FsApi.saveFile ? global.FsApi.saveFile(content, filename, kind === 'html' ? 'text/html' : 'text/markdown') : Promise.resolve(false);
  }

  function shellHooks() {
    return {
      action: function (action) {
        if (action === 'new-file') createFile();
        else if (action === 'new-folder') createFolder();
        else if (action === 'delete') deleteCurrent();
        else if (action === 'rename') renameCurrent();
        else if (action === 'undo') { global.EditorCommands.undo(currentInput()); updateGutter(); redraw(); }
        else if (action === 'redo') { global.EditorCommands.redo(currentInput()); updateGutter(); redraw(); }
        else if (['bold','italic','heading','strike','ul','ol','checklist','quote','code','table','link','image'].indexOf(action) >= 0) { global.EditorCommands.format(currentInput(), action); }
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
      import: importFile,
      export: exportFile,
      print: function () { if (typeof global.print === 'function') global.print(); else if (global.window && typeof global.window.print === 'function') global.window.print(); },
      rename: renameCurrent,
      toggle: function (name) {
        if (name === 'reader') shellState.reader = !shellState.reader;
        else if (name === 'focus') shellState.focus = !shellState.focus;
        else if (name === 'preview') shellState.preview = !shellState.preview;
        else if (name === 'sync') shellState.sync = !shellState.sync;
        else if (name === 'toc') shellState.toc = !shellState.toc;
        else if (name === 'explorer') shellState.explorer = !shellState.explorer;
        if (name === 'toc' && shellRoot) { var toc = shellRoot.querySelector('.ed-toc'); if (toc) toc.hidden = !shellState.toc; }
        redraw();
      },
      toggleTree: function (id) {
        var index = shellState.expanded.indexOf(id);
        if (index >= 0) shellState.expanded.splice(index, 1); else shellState.expanded.push(id);
        global.EditorWorkspace.setExpandedIds(shellState.expanded).then(function () { refreshTree(); });
      }
    };
  }

  function bindShell() {
    var input = currentInput();
    if (!shellRoot || !input) return;
    var hooks = shellHooks();
    var onInput = function () { if (global.EditorCommands) global.EditorCommands.record(input); updateGutter(); renderPreview(); };
    var onScroll = function () {
      updateGutter();
      if (!shellState.sync || !shellRoot) return;
      var preview = shellRoot.querySelector('#ed-main-preview');
      if (!preview) return;
      var ratio = input.scrollHeight > input.clientHeight ? input.scrollTop / (input.scrollHeight - input.clientHeight) : 0;
      preview.scrollTop = ratio * Math.max(0, preview.scrollHeight - preview.clientHeight);
    };
    var onKey = function (event) {
      var mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); saveWorkspace(); }
      else if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) global.EditorCommands.redo(input); else global.EditorCommands.undo(input); redraw(); }
      else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); global.EditorCommands.redo(input); redraw(); }
      else if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); shellFindToggle(); }
      else if (event.key === 'Tab') { event.preventDefault(); var start = input.selectionStart; input.value = input.value.slice(0, start) + '  ' + input.value.slice(input.selectionEnd); input.setSelectionRange(start + 2, start + 2); onInput(); }
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
    shellHandlers = { input: onInput, scroll: onScroll, keydown: onKey, previewClick: onClick, preview: preview, inputNode: input };
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
    return global.EditorWorkspace.init().then(function () {
      return Promise.all([global.EditorWorkspace.listNodes(), global.EditorWorkspace.getCurrentFileId(), global.EditorWorkspace.getExpandedIds()]);
    }).then(function (values) {
      var nodes = values[0] || [];
      shellState.expanded = values[2] || [];
      var currentId = values[1];
      if (!currentId) { currentId = 'file:welcome'; }
      shellState.currentId = currentId;
      shellRoot = global.EditorLayout.create(container, { nodes: buildTree(nodes), selectedId: currentId }, shellHooks());
      return loadFile(currentId).then(function (loaded) {
        if (!loaded && currentId !== 'file:welcome') return loadFile('file:welcome');
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
