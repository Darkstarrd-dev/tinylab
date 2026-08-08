// editor_layout.js — StackEdit-style local editor layout factory.
// DOM and event wiring only; editor/workspace behavior belongs to editor.js.
(function (global) {
  'use strict';

  var doc = global && global.document;

  function make(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function safeCall(fn, ctx, args) {
    if (typeof fn !== 'function') return;
    try { fn.apply(ctx, args || []); } catch (e) { /* hook failures must not break UI wiring */ }
  }

  function button(action, label, attrs) {
    var b = make('button', 'ed-button ed-action-' + action, label);
    b.type = 'button';
    b.setAttribute('data-action', action);
    b.setAttribute('aria-label', label);
    b.title = label;
    var key;
    if (attrs) {
      for (key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) b.setAttribute(key, attrs[key]);
      }
    }
    return b;
  }

  function group(title, className) {
    var section = make('section', className || 'ed-tool-group');
    if (title) {
      var heading = make('h2', 'ed-tool-heading', title);
      section.appendChild(heading);
    }
    return section;
  }

  var ACTION_LABEL_KEYS = {
    'new-file':'editorNewFile', 'new-folder':'editorNewFolder', 'delete':'editorDelete', 'rename':'editorRename',
    'undo':'editorUndo', 'redo':'editorRedo', 'bold':'editorBold', 'italic':'editorItalic', 'heading':'editorHeading',
    'strike':'editorStrike', 'ul':'editorUnorderedList', 'ol':'editorOrderedList', 'checklist':'editorTaskList',
    'quote':'editorQuote', 'code':'editorCode', 'table':'editorTable', 'link':'editorLink', 'image':'editorImage',
'find':'editorFind', 'import':'editorImport', 'export':'editorExport', 'export-html':'editorExportHtml', 'print':'editorPrint', 'reader':'editorReader',
'focus':'editorFocus', 'preview':'editorPreview', 'sync':'editorScrollSync', 'toc':'editorTableOfContents', 'open':'editorOpen',
'save':'editorSave', 'edit':'editorEditMode', 'diff':'editorDiff', 'toggle':'editorToggle'
  };

  function layoutText(key, fallback) {
    var translate = global && typeof global.edT === 'function' ? global.edT : (global && typeof global.t === 'function' ? global.t : null);
    if (!translate) return fallback;
    try { return translate(key) || fallback; } catch (e) { return fallback; }
  }

  function appendButtons(parent, definitions) {
    for (var i = 0; i < definitions.length; i++) {
      var d = definitions[i];
      var key = ACTION_LABEL_KEYS[d[0]];
      parent.appendChild(button(d[0], key ? layoutText(key, d[1]) : d[1], d[2]));
    }
  }

  function buildTreeItem(node, state, depth) {
    node = node || {};
    var name = node.title || node.name || node.label || node.path || '';
    var id = node.id !== undefined ? node.id : (node.path !== undefined ? node.path : name);
    var children = Array.isArray(node.children) ? node.children : [];
    var folder = !!(node.folder || node.isFolder || node.type === 'folder' || children.length);
    var li = make('li', 'ed-tree-node' + (folder ? ' ed-tree-folder' : ' ed-tree-file'));
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String((depth || 0) + 1));
    if (id !== undefined && id !== null) li.setAttribute('data-file-id', String(id));
    if (folder) li.setAttribute('aria-expanded', node.expanded === true ? 'true' : 'false');
    var row = make('div', 'ed-tree-item' + (state && state.selectedId !== undefined && String(state.selectedId) === String(id) ? ' is-selected' : ''));
    row.setAttribute('role', 'presentation');
    if (folder) {
      var expander = button('toggle', node.expanded === true ? '−' : '+', { 'data-tree-expander': 'true', 'data-tree-node-id': String(id) });
      expander.className += ' ed-tree-expander';
      expander.setAttribute('aria-label', 'Toggle ' + name);
      row.appendChild(expander);
    } else {
      row.appendChild(make('span', 'ed-tree-expander ed-tree-expander-spacer', ''));
    }
    row.appendChild(make('span', 'ed-tree-icon', folder ? '▾' : '•'));
    row.appendChild(make('span', 'ed-tree-label', name));
    li.appendChild(row);
    if (folder) {
      var list = make('ul', 'ed-tree-children');
      list.setAttribute('role', 'group');
      if (node.expanded !== true) list.hidden = true;
      for (var i = 0; i < children.length; i++) list.appendChild(buildTreeItem(children[i], state, (depth || 0) + 1));
      li.appendChild(list);
    }
    return li;
  }

  function renderTree(treeRoot, nodes, state, hooks) {
    if (!treeRoot || !doc) return treeRoot || null;
    while (treeRoot.firstChild) treeRoot.removeChild(treeRoot.firstChild);
    var items = Array.isArray(nodes) ? nodes : [];
    treeRoot.setAttribute('role', 'tree');
    for (var i = 0; i < items.length; i++) treeRoot.appendChild(buildTreeItem(items[i], state || {}, 0));
    treeRoot.__edLayoutHooks = hooks || treeRoot.__edLayoutHooks || {};
    return treeRoot;
  }

  function create(container, state, hooks) {
    if (!container || !doc) return null;
    hooks = hooks || {};
    var root = make('div', 'ed-workspace');
    root.id = 'ed-workspace';
    root.__edLayoutState = state || {};
    root.__edLayoutHooks = hooks;

    var explorer = make('aside', 'ed-explorer');
    explorer.id = 'ed-explorer';
    explorer.setAttribute('aria-label', 'File explorer');
    var explorerHeader = make('div', 'ed-explorer-header');
    explorerHeader.appendChild(make('h2', 'ed-pane-title', layoutText('editorExplorer', 'Files')));
    var explorerActions = make('div', 'ed-explorer-actions');
    appendButtons(explorerActions, [
      ['new-file', 'New file'], ['new-folder', 'New folder'], ['delete', 'Delete'], ['rename', 'Rename']
    ]);
    explorerHeader.appendChild(explorerActions);
    explorer.appendChild(explorerHeader);
    var tree = make('ul', 'ed-file-tree');
    tree.id = 'ed-file-tree';
    explorer.appendChild(tree);
    root.appendChild(explorer);

    var main = make('main', 'ed-editor-main');
    main.id = 'ed-editor-main';
    var navigation = make('nav', 'ed-navigation');
    navigation.id = 'ed-navigation';
    var title = make('span', 'ed-title', layoutText('editorUntitled', 'Untitled'));
    title.id = 'ed-title';
    title.setAttribute('data-title', 'true');
    navigation.appendChild(title);
    var navActions = make('div', 'ed-navigation-actions');
    appendButtons(navActions, [
      ['open', 'Open'], ['save', 'Save'], ['import', 'Import'], ['export', 'Export', { 'data-kind': 'markdown' }], ['export-html', 'HTML', { 'data-kind': 'html' }], ['print', 'Print']
    ]);
    navigation.appendChild(navActions);
    main.appendChild(navigation);

    var contentSplit = make('div', 'ed-content-split');
    contentSplit.id = 'ed-content-split';
    var editorSurface = make('section', 'ed-editor-surface');
    editorSurface.id = 'ed-editor-surface';
    editorSurface.setAttribute('aria-label', 'Editor');
    var gutter = make('div', 'ed-line-gutter ed-gutter');
    gutter.id = 'ed-line-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    gutter.appendChild(make('span', 'ed-line-number', '1'));
    editorSurface.appendChild(gutter);
    var input = make('textarea', 'ed-main-input ed-input');
    input.id = 'ed-main-input';
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', 'Editor text');
    editorSurface.appendChild(input);
    contentSplit.appendChild(editorSurface);
    var preview = make('section', 'ed-preview-surface');
    preview.id = 'ed-preview-surface';
    preview.setAttribute('aria-label', 'Preview');
    var previewInner = make('div', 'ed-preview-content ed-parsed-area');
    previewInner.id = 'ed-main-preview';
    preview.appendChild(previewInner);
    contentSplit.appendChild(preview);
    main.appendChild(contentSplit);

    var controls = make('div', 'ed-control-bar');
    controls.id = 'ed-control-bar';
    appendButtons(controls, [
      ['undo', 'Undo'], ['redo', 'Redo'], ['bold', 'Bold'], ['italic', 'Italic'], ['heading', 'Heading'],
      ['strike', 'Strikethrough'], ['ul', 'Bulleted list'], ['ol', 'Numbered list'], ['checklist', 'Checklist'],
      ['quote', 'Quote'], ['code', 'Code'], ['table', 'Table'], ['link', 'Link'], ['image', 'Image'], ['find', 'Find']
    ]);
    var viewActions = make('div', 'ed-view-actions');
    appendButtons(viewActions, [
      ['edit', 'Edit'], ['diff', 'Diff'], ['reader', 'Reader', { 'data-toggle': 'reader' }],
      ['focus', 'Focus', { 'data-toggle': 'focus' }], ['preview', 'Preview', { 'data-toggle': 'preview' }],
      ['sync', 'Sync', { 'data-toggle': 'sync' }], ['toc', 'Table of contents', { 'data-toggle': 'toc' }]
    ]);
    controls.appendChild(viewActions);
    main.appendChild(controls);

    var toc = make('aside', 'ed-toc');
    toc.id = 'ed-toc';
    toc.setAttribute('aria-label', 'Table of contents');
    toc.appendChild(make('h2', 'ed-pane-title', layoutText('editorTableOfContents', 'Contents')));
    toc.appendChild(make('ol', 'ed-toc-list'));
    contentSplit.appendChild(toc);
    main.appendChild(contentSplit);


    var status = make('footer', 'ed-statusbar');
    status.id = 'ed-statusbar';
    status.appendChild(make('span', 'ed-status-left', layoutText('editorSaved', 'Ready')));
    status.appendChild(make('span', 'ed-status-right', ''));
    main.appendChild(status);
    root.appendChild(main);
    container.appendChild(root);

    renderTree(tree, (state && (state.tree || state.nodes || state.files)) || [], state, hooks);
    bind(root, hooks);
    return root;
  }

  function bind(root, hooks) {
    if (!root || root.__edLayoutBound) return root;
    hooks = hooks || root.__edLayoutHooks || {};
    root.__edLayoutHooks = hooks;
    var clickHandler = function (event) {
      var target = event.target;
      var actionNode = target && target.closest ? target.closest('[data-action]') : null;
      if (actionNode && root.contains(actionNode)) {
        var action = actionNode.getAttribute('data-action');
        safeCall(hooks.action, hooks, [action, event]);
        if (action === 'open') safeCall(hooks.open, hooks);
        else if (action === 'save') safeCall(hooks.save, hooks);
        else if (action === 'import') safeCall(hooks.import, hooks);
        else if (action === 'export' || action === 'export-html') safeCall(hooks.export, hooks, [actionNode.getAttribute('data-kind') || (action === 'export-html' ? 'html' : 'markdown')]);
        else if (action === 'print') safeCall(hooks.print, hooks);
        if (actionNode.hasAttribute('data-toggle')) safeCall(hooks.toggle, hooks, [actionNode.getAttribute('data-toggle')]);
        if (action === 'toggle' && actionNode.hasAttribute('data-tree-node-id')) {
          safeCall(hooks.toggleTree, hooks, [actionNode.getAttribute('data-tree-node-id'), event]);
        }
        event.preventDefault();
        return;
      }
      var fileNode = target && target.closest ? target.closest('[data-file-id]') : null;
      if (fileNode && root.contains(fileNode) && !target.closest('[data-tree-expander]')) {
        safeCall(hooks.selectFile, hooks, [fileNode.getAttribute('data-file-id'), event]);
        event.preventDefault();
      }
    };
    var keyHandler = function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var item = event.target && event.target.closest ? event.target.closest('[data-file-id]') : null;
      if (item && root.contains(item) && !event.target.closest('button')) {
        safeCall(hooks.selectFile, hooks, [item.getAttribute('data-file-id'), event]);
        event.preventDefault();
      }
    };
    root.addEventListener('click', clickHandler);
    root.addEventListener('keydown', keyHandler);
    root.__edLayoutHandlers = { click: clickHandler, keydown: keyHandler };
    root.__edLayoutBound = true;
    return root;
  }

  function unbind(root) {
    if (!root || !root.__edLayoutHandlers) return root;
    root.removeEventListener('click', root.__edLayoutHandlers.click);
    root.removeEventListener('keydown', root.__edLayoutHandlers.keydown);
    root.__edLayoutHandlers = null;
    root.__edLayoutBound = false;
    return root;
  }

  function updateTitle(root, name, dirty) {
    if (!root) return root;
    var title = root.querySelector('#ed-title');
    if (title) {
      title.textContent = (name || layoutText('editorUntitled', 'Untitled')) + (dirty ? ' *' : '');
      title.setAttribute('aria-label', 'Document: ' + title.textContent);
    }
    root.setAttribute('data-dirty', dirty ? 'true' : 'false');
    return root;
  }

  function updateStatus(root, stats) {
    if (!root) return root;
    stats = stats || {};
    var left = root.querySelector('.ed-status-left');
    var right = root.querySelector('.ed-status-right');
    if (left) left.textContent = stats.left !== undefined ? String(stats.left) : (stats.message || layoutText('editorSaved', 'Ready'));
    if (right) {
      if (stats.right !== undefined) right.textContent = String(stats.right);
      else {
        var parts = [];
        if (stats.line !== undefined) parts.push('Ln ' + stats.line);
        if (stats.column !== undefined) parts.push('Col ' + stats.column);
        if (stats.words !== undefined) parts.push(String(stats.words) + ' words');
        if (stats.chars !== undefined) parts.push(String(stats.chars) + ' chars');
        right.textContent = parts.join(' · ');
      }
    }
    return root;
  }

  function toggleClass(root, className, on, attr) {
    if (!root) return root;
    root.classList.toggle(className, !!on);
    if (attr) root.setAttribute(attr, on ? 'true' : 'false');
    return root;
  }

  function setMode(root, mode) {
    if (!root) return root;
    root.setAttribute('data-mode', mode || 'edit');
    var modes = root.querySelectorAll('[data-action="edit"], [data-action="diff"]');
    for (var i = 0; i < modes.length; i++) modes[i].classList.toggle('is-active', modes[i].getAttribute('data-action') === mode);
    return root;
  }
  function setReader(root, on) {
    toggleClass(root, 'is-reader', on, 'data-reader');
    return toggleClass(root, 'ed-reader-mode', on);
  }
  function setFocus(root, on) {
    toggleClass(root, 'is-focused', on, 'data-focus');
    return toggleClass(root, 'ed-focus-mode', on);
  }
  function setPreview(root, on) { return toggleClass(root, 'is-preview', on, 'data-preview'); }
  function setExplorer(root, on) { return toggleClass(root, 'is-explorer-hidden', !on, 'data-explorer'); }
  function setSync(root, on) { return toggleClass(root, 'is-syncing', on, 'data-sync'); }

  function destroy(root) {
    if (!root) return null;
    unbind(root);
    if (root.parentNode) root.parentNode.removeChild(root);
    root.__edLayoutHooks = null;
    root.__edLayoutState = null;
    return null;
  }

  global.EditorLayout = {
    create: create,
    bind: bind,
    unbind: unbind,
    renderTree: renderTree,
    updateTitle: updateTitle,
    updateStatus: updateStatus,
    setMode: setMode,
    setReader: setReader,
    setFocus: setFocus,
    setPreview: setPreview,
    setExplorer: setExplorer,
    setSync: setSync,
    destroy: destroy
  };
}(typeof window !== 'undefined' ? window : this));
