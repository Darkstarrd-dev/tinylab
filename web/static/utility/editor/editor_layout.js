// editor_layout.js — StackEdit-style local editor layout factory.
// DOM and event wiring only; editor/workspace behavior belongs to editor.js / editor_shell.js.
(function (global) {
  'use strict';

  var doc = global && global.document;

  var SVG_ICONS = {
    'file-plus': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M13 9h5.5L13 3.5V9M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m5 10v3H8v2h3v3h2v-3h3v-2h-3v-3h-2z"/></svg>',
    'folder-plus': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2m-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>',
    'delete': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    'pen': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    'close': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
    'folder': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
    'file': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M13 9h5.5L13 3.5V9M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/></svg>',
    'chevron-down': '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>',
    'chevron-right': '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>',
    'undo': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>',
    'redo': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z"/></svg>',
    'bold': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M13.35,17.401l-4.201,0l0,-3.601l4.201,0c0.997,0 1.801,0.805 1.801,1.801c0,0.996 -0.804,1.8 -1.801,1.8m-4.201,-10.802l3.601,0c0.996,0 1.801,0.804 1.801,1.8c0,0.996 -0.805,1.801 -1.801,1.801l-3.601,0m6.722,1.548c1.164,-0.816 1.98,-2.149 1.98,-3.349c0,-2.712 -2.1,-4.801 -4.801,-4.801l-7.502,0l0,16.804l8.45,0c2.521,0 4.454,-2.04 4.454,-4.549c0,-1.825 -1.033,-3.385 -2.581,-4.105Z"/></svg>',
    'italic': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z"/></svg>',
    'heading': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9 4v3h5v12h3V7h5V4H9zm-6 8h3v7h3v-7h3V9H3v3z"/></svg>',
    'strike': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10 19h4v-3h-4v3zM5 4v3h5v3h4V7h5V4H5zM3 14h18v-2H3v2z"/></svg>',
    'ul': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z"/></svg>',
    'ol': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14V5H7zm0 14h14v-2H7v2zm0-6h14v-2H7v2z"/></svg>',
    'checklist': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM17.99 9l-1.41-1.42-6.59 6.59-2.58-2.57-1.41 1.41 4 3.99z"/></svg>',
    'quote': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>',
    'code': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.6 16.6l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4zm-5.2 0L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4z"/></svg>',
    'table': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 4h4v4H5V8zm6 0h4v4h-4V8zm6 0h2v4h-2V8zm-12 6h4v4H5v-4zm6 0h4v4h-4v-4zm6 0h2v4h-2v-4z"/></svg>',
    'link': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10.59 13.41c.41.39.41 1.03 0 1.42-.39.39-1.03.39-1.42 0a5.003 5.003 0 0 1 0-7.07l3.54-3.54a5.003 5.003 0 0 1 7.07 0 5.003 5.003 0 0 1 0 7.07l-1.49 1.49c.01-.82-.12-1.64-.4-2.42l.47-.48a3.001 3.001 0 0 0 0-4.24 3.001 3.001 0 0 0-4.24 0l-3.53 3.53a3.001 3.001 0 0 0 0 4.24zm2.82-2.82c-.41-.39-.41-1.03 0-1.42.39-.39 1.03-.39 1.42 0a5.003 5.003 0 0 1 0 7.07l-3.54 3.54a5.003 5.003 0 0 1-7.07 0 5.003 5.003 0 0 1 0-7.07l1.49-1.49c-.01.82.12 1.64.4 2.42l-.47.48a3.001 3.001 0 0 0 0 4.24 3.001 3.001 0 0 0 4.24 0l3.53-3.53a3.001 3.001 0 0 0 0-4.24z"/></svg>',
    'image': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M13 9h5.5L13 3.5V9M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m5 10a2 2 0 0 0-2 2 2 2 0 0 0 2 2 2 2 0 0 0 2-2 2 2 0 0 0-2-2m-6 7h14l-4.5-6-3.5 4.5-2.5-3L5 19z"/></svg>',
    'find': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
    'open': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>',
    'save': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>',
    'import': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>',
    'export': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
    'export-html': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>',
    'print': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>',
    'edit': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    'side-preview': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16h-6V5h6v14z"/></svg>',
    'reader': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>',
    'focus': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm0-14c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4z"/></svg>',
    'sync': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9 3L5 6.99h3V14h2V6.99h3L9 3zm7 14.01V10h-2v7.01h-3L15 21l4-3.99h-3z"/></svg>',
    'toc': '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 9h14V7H3v2zm0 4h14v-2H3v2zm0 4h14v-2H3v2zm16 0h2v-2h-2v2zm0-10v2h2V7h-2zm0 6h2v-2h-2v2z"/></svg>'
  };

  var ACTION_ICONS = {
    'new-file': 'file-plus',
    'new-folder': 'folder-plus',
    'delete': 'delete',
    'rename': 'pen',
    'toggle-explorer': 'close',
    'undo': 'undo',
    'redo': 'redo',
    'bold': 'bold',
    'italic': 'italic',
    'heading': 'heading',
    'strike': 'strike',
    'ul': 'ul',
    'ol': 'ol',
    'checklist': 'checklist',
    'quote': 'quote',
    'code': 'code',
    'table': 'table',
    'link': 'link',
    'image': 'image',
    'find': 'find',
    'open': 'open',
    'save': 'save',
    'import': 'import',
    'export': 'export',
    'export-html': 'export-html',
    'print': 'print',
    'edit': 'edit',
    'diff': 'edit',
    'preview': 'side-preview',
    'reader': 'reader',
    'focus': 'focus',
    'sync': 'sync',
    'toc': 'toc'
  };

  var SHORTCUT_HINTS = {
    'bold': 'Ctrl+B',
    'italic': 'Ctrl+I',
    'heading': 'Ctrl+H',
    'strike': 'Ctrl+S',
    'ul': 'Ctrl+U',
    'ol': 'Ctrl+O',
    'checklist': 'Ctrl+C',
    'quote': 'Ctrl+Q',
    'code': 'Ctrl+K',
    'table': 'Ctrl+T',
    'link': 'Ctrl+L',
    'image': 'Ctrl+G',
    'find': 'Ctrl+F',
    'undo': 'Ctrl+Z',
    'redo': 'Ctrl+Y'
  };

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

  function button(action, label, attrs, options) {
    options = options || {};
    var iconName = options.icon || ACTION_ICONS[action];
    var hideLabel = !!options.hideLabel;
    var showLabel = options.showLabel !== false;

    var b = make('button', 'ed-button ed-action-' + action);
    b.type = 'button';
    b.setAttribute('data-action', action);

    var tooltip = label;
    if (SHORTCUT_HINTS[action]) {
      tooltip += ' (' + SHORTCUT_HINTS[action] + ')';
    }
    b.setAttribute('aria-label', tooltip);
    b.title = tooltip;

    if (iconName && SVG_ICONS[iconName]) {
      var iconSpan = make('span', 'ed-button-icon');
      iconSpan.innerHTML = SVG_ICONS[iconName];
      b.appendChild(iconSpan);
    }

    if (!hideLabel && showLabel && label) {
      var labelSpan = make('span', 'ed-button-label', label);
      b.appendChild(labelSpan);
    }

    if (hideLabel) {
      b.classList.add('ed-button-icon-only');
    }

    var key;
    if (attrs) {
      for (key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) b.setAttribute(key, attrs[key]);
      }
    }
    return b;
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

  function appendButtons(parent, definitions, defaultOptions) {
    for (var i = 0; i < definitions.length; i++) {
      var d = definitions[i];
      var action = d[0];
      var fallbackLabel = d[1];
      var attrs = d[2];
      var opts = d[3] || defaultOptions || {};
      var key = ACTION_LABEL_KEYS[action];
      var label = key ? layoutText(key, fallbackLabel) : fallbackLabel;
      parent.appendChild(button(action, label, attrs, opts));
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
      var expander = button('toggle', 'Toggle ' + name, { 'data-tree-expander': 'true', 'data-tree-node-id': String(id) }, { icon: node.expanded === true ? 'chevron-down' : 'chevron-right', hideLabel: true });
      expander.className += ' ed-tree-expander';
      row.appendChild(expander);
    } else {
      var spacerSpan = make('span', 'ed-tree-expander ed-tree-expander-spacer', '');
      row.appendChild(spacerSpan);
    }
    
    var iconSpan = make('span', 'ed-tree-icon');
    iconSpan.innerHTML = folder ? SVG_ICONS['folder'] : SVG_ICONS['file'];
    row.appendChild(iconSpan);

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

    // 1. Explorer Sidebar
    var explorer = make('aside', 'ed-explorer');
    explorer.id = 'ed-explorer';
    explorer.setAttribute('aria-label', 'File explorer');
    var explorerHeader = make('div', 'ed-explorer-header');
    
    var explorerActions = make('div', 'ed-explorer-actions');
    appendButtons(explorerActions, [
      ['new-file', 'New file'],
      ['new-folder', 'New folder'],
      ['delete', 'Delete'],
      ['rename', 'Rename'],
      ['toggle-explorer', 'Close Explorer', { 'data-toggle': 'explorer' }, { icon: 'close', hideLabel: true }]
    ], { hideLabel: true });
    explorerHeader.appendChild(explorerActions);
    explorer.appendChild(explorerHeader);
    var tree = make('ul', 'ed-file-tree');
    tree.id = 'ed-file-tree';
    explorer.appendChild(tree);
    root.appendChild(explorer);

    // 2. Main Editor Area
    var main = make('main', 'ed-editor-main');
    main.id = 'ed-editor-main';

    // 2a. Navigation Bar (Top)
    var navigation = make('nav', 'ed-navigation');
    navigation.id = 'ed-navigation';

    var navLeft = make('div', 'ed-navigation-left');
    var toggleExpBtn = button('toggle-explorer', 'Toggle Explorer', { 'data-toggle': 'explorer' }, { icon: 'folder', hideLabel: true });
    toggleExpBtn.className += ' ed-nav-explorer-toggle';
    navLeft.appendChild(toggleExpBtn);

    var title = make('span', 'ed-title', layoutText('editorUntitled', 'Untitled'));
    title.id = 'ed-title';
    title.setAttribute('data-title', 'true');
    navLeft.appendChild(title);
    navigation.appendChild(navLeft);

    var navActions = make('div', 'ed-navigation-actions');
    appendButtons(navActions, [
      ['open', 'Open'],
      ['save', 'Save'],
      ['import', 'Import'],
      ['export', 'Export', { 'data-kind': 'markdown' }],
      ['export-html', 'HTML', { 'data-kind': 'html' }],
      ['print', 'Print']
    ], { showLabel: true });
    navigation.appendChild(navActions);
    main.appendChild(navigation);

    // 2b. Format & View Controls (Toolbar)
    var controls = make('div', 'ed-control-bar');
    controls.id = 'ed-control-bar';

    var formatGroup = make('div', 'ed-toolbar-section ed-format-tools');
    appendButtons(formatGroup, [
      ['undo', 'Undo'], ['redo', 'Redo']
    ], { hideLabel: true });
    formatGroup.appendChild(make('span', 'ed-toolbar-divider', ''));
    appendButtons(formatGroup, [
      ['bold', 'Bold'], ['italic', 'Italic'], ['heading', 'Heading'], ['strike', 'Strikethrough']
    ], { hideLabel: true });
    formatGroup.appendChild(make('span', 'ed-toolbar-divider', ''));
    appendButtons(formatGroup, [
      ['ul', 'Bulleted list'], ['ol', 'Numbered list'], ['checklist', 'Task list']
    ], { hideLabel: true });
    formatGroup.appendChild(make('span', 'ed-toolbar-divider', ''));
    appendButtons(formatGroup, [
      ['quote', 'Quote'], ['code', 'Code'], ['table', 'Table']
    ], { hideLabel: true });
    formatGroup.appendChild(make('span', 'ed-toolbar-divider', ''));
    appendButtons(formatGroup, [
      ['link', 'Link'], ['image', 'Image']
    ], { hideLabel: true });
    formatGroup.appendChild(make('span', 'ed-toolbar-divider', ''));
    appendButtons(formatGroup, [
      ['find', 'Find']
    ], { hideLabel: true });
    controls.appendChild(formatGroup);

    var toolbarSpacer = make('div', 'ed-toolbar-spacer', '');
    controls.appendChild(toolbarSpacer);

    var viewActions = make('div', 'ed-view-actions');
    
    // Segmented Mode Switcher (Edit / Split / Preview)
    var modeSegmented = make('div', 'ed-segmented-control');
    appendButtons(modeSegmented, [
      ['edit', 'Edit only', null, { icon: 'edit', hideLabel: true }],
      ['preview', 'Side preview', { 'data-toggle': 'preview' }, { icon: 'side-preview', hideLabel: true }],
      ['reader', 'Preview only', { 'data-toggle': 'reader' }, { icon: 'reader', hideLabel: true }]
    ]);
    viewActions.appendChild(modeSegmented);

    var togglesGroup = make('div', 'ed-toolbar-section ed-toggles-group');
    togglesGroup.appendChild(make('span', 'ed-toolbar-divider', ''));
    appendButtons(togglesGroup, [
      ['sync', 'Scroll Sync', { 'data-toggle': 'sync' }, { icon: 'sync', hideLabel: true }],
      ['focus', 'Focus Mode', { 'data-toggle': 'focus' }, { icon: 'focus', hideLabel: true }],
      ['toc', 'Table of Contents', { 'data-toggle': 'toc' }, { icon: 'toc', hideLabel: true }]
    ]);
    viewActions.appendChild(togglesGroup);

    controls.appendChild(viewActions);
    main.appendChild(controls);

    // 2c. Content Split Area (Editor Surface + Preview Surface + TOC)
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

    var toc = make('aside', 'ed-toc');
    toc.id = 'ed-toc';
    toc.setAttribute('aria-label', 'Table of contents');
    toc.appendChild(make('h2', 'ed-pane-title', layoutText('editorTableOfContents', 'Contents')));
    toc.appendChild(make('ol', 'ed-toc-list'));
    contentSplit.appendChild(toc);

    main.appendChild(contentSplit);

    // 2d. Status Bar (Bottom)
    var status = make('footer', 'ed-statusbar');
    status.id = 'ed-statusbar';

    var statusLeft = make('div', 'ed-status-block ed-status-left');
    statusLeft.appendChild(make('span', 'ed-status-tag', 'Markdown'));
    var textSelSpan = make('span', 'ed-status-badge ed-status-selection', 'selection');
    textSelSpan.hidden = true;
    statusLeft.appendChild(textSelSpan);
    statusLeft.appendChild(make('span', 'ed-status-item ed-stat-bytes', '0 bytes'));
    statusLeft.appendChild(make('span', 'ed-status-sep', '·'));
    statusLeft.appendChild(make('span', 'ed-status-item ed-stat-words', '0 words'));
    statusLeft.appendChild(make('span', 'ed-status-sep', '·'));
    statusLeft.appendChild(make('span', 'ed-status-item ed-stat-lines', '0 lines'));
    statusLeft.appendChild(make('span', 'ed-status-sep', '·'));
    statusLeft.appendChild(make('span', 'ed-status-item ed-stat-pos', 'Ln 1, Col 0'));
    status.appendChild(statusLeft);

    var statusRight = make('div', 'ed-status-block ed-status-right');
    statusRight.appendChild(make('span', 'ed-status-tag', 'HTML'));
    var htmlSelSpan = make('span', 'ed-status-badge ed-status-selection', 'selection');
    htmlSelSpan.hidden = true;
    statusRight.appendChild(htmlSelSpan);
    statusRight.appendChild(make('span', 'ed-status-item ed-stat-chars', '0 chars'));
    statusRight.appendChild(make('span', 'ed-status-sep', '·'));
    statusRight.appendChild(make('span', 'ed-status-item ed-stat-words-html', '0 words'));
    statusRight.appendChild(make('span', 'ed-status-sep', '·'));
    statusRight.appendChild(make('span', 'ed-status-item ed-stat-paragraphs', '0 paragraphs'));
    status.appendChild(statusRight);

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

    var bytesEl = root.querySelector('.ed-stat-bytes');
    var wordsEl = root.querySelector('.ed-stat-words');
    var linesEl = root.querySelector('.ed-stat-lines');
    var posEl = root.querySelector('.ed-stat-pos');
    var textSelEl = root.querySelector('.ed-status-left .ed-status-selection');

    var charsEl = root.querySelector('.ed-stat-chars');
    var htmlWordsEl = root.querySelector('.ed-stat-words-html');
    var parasEl = root.querySelector('.ed-stat-paragraphs');
    var htmlSelEl = root.querySelector('.ed-status-right .ed-status-selection');

    if (bytesEl && stats.bytes !== undefined) bytesEl.textContent = stats.bytes + ' bytes';
    if (wordsEl && stats.words !== undefined) wordsEl.textContent = stats.words + ' words';
    if (linesEl && stats.lines !== undefined) linesEl.textContent = stats.lines + ' lines';
    if (posEl && (stats.line !== undefined || stats.column !== undefined)) {
      posEl.textContent = 'Ln ' + (stats.line || 1) + ', Col ' + (stats.column || 0);
    }
    if (textSelEl) textSelEl.hidden = !stats.textSelection;

    if (charsEl && stats.chars !== undefined) charsEl.textContent = stats.chars + ' chars';
    if (htmlWordsEl && (stats.htmlWords !== undefined || stats.words !== undefined)) {
      htmlWordsEl.textContent = (stats.htmlWords !== undefined ? stats.htmlWords : stats.words) + ' words';
    }
    if (parasEl && stats.paragraphs !== undefined) parasEl.textContent = stats.paragraphs + ' paragraphs';
    if (htmlSelEl) htmlSelEl.hidden = !stats.htmlSelection;

    // Fallback for legacy string format
    if (stats.left !== undefined && !bytesEl) {
      var leftStr = root.querySelector('.ed-status-left');
      if (leftStr) leftStr.textContent = String(stats.left);
    }
    if (stats.right !== undefined && !charsEl) {
      var rightStr = root.querySelector('.ed-status-right');
      if (rightStr) rightStr.textContent = String(stats.right);
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
    var btn = root.querySelector('[data-action="reader"]');
    if (btn) btn.classList.toggle('is-active', !!on);
    return toggleClass(root, 'ed-reader-mode', on);
  }
  function setFocus(root, on) {
    toggleClass(root, 'is-focused', on, 'data-focus');
    var btn = root.querySelector('[data-action="focus"]');
    if (btn) btn.classList.toggle('is-active', !!on);
    return toggleClass(root, 'ed-focus-mode', on);
  }
  function setPreview(root, on) {
    toggleClass(root, 'is-preview', on, 'data-preview');
    var btn = root.querySelector('[data-action="preview"]');
    if (btn) btn.classList.toggle('is-active', !!on);
    return root;
  }
  function setExplorer(root, on) {
    toggleClass(root, 'is-explorer-hidden', !on, 'data-explorer');
    var btn = root.querySelector('.ed-nav-explorer-toggle');
    if (btn) btn.classList.toggle('is-active', !!on);
    return root;
  }
  function setSync(root, on) {
    toggleClass(root, 'is-syncing', on, 'data-sync');
    var btn = root.querySelector('[data-action="sync"]');
    if (btn) btn.classList.toggle('is-active', !!on);
    return root;
  }

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

