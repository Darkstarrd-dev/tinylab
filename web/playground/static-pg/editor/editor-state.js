// editor-state.js — Editor state, constants, and helper functions.

'use strict';

// ---------- helpers ----------------------------------------------
var CODE_EXTS = {
  js:1, ts:1, go:1, json:1, yaml:1, yml:1, html:1, css:1, xml:1,
  py:1, rs:1, c:1, cpp:1, java:1, sh:1, sql:1, lua:1, php:1, rb:1,
  swift:1, kt:1, dart:1, toml:1, ini:1, cfg:1, conf:1, env:1,
  md:1, markdown:1
};

function edEscapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function edFileExt(name) {
  if (!name) return '';
  var i = name.lastIndexOf('.');
  return i >= 0 ? name.substring(i + 1).toLowerCase() : '';
}

function edIsCodeExt(ext) {
  return !!CODE_EXTS[ext];
}

function edIsMdExt(ext) {
  return ext === 'md' || ext === 'markdown';
}

function edLangForExt(ext) {
  // Map extensions to highlight.js language classes
  var map = {
    js:'javascript', ts:'typescript', go:'go', json:'json',
    yaml:'yaml', yml:'yaml', html:'html', css:'css', xml:'xml',
    py:'python', rs:'rust', c:'c', cpp:'cpp', java:'java',
    sh:'bash', sql:'sql', lua:'lua', php:'php', rb:'ruby',
    swift:'swift', kt:'kotlin', dart:'dart', toml:'toml',
    ini:'ini', cfg:'ini', conf:'ini', env:'dotenv',
    md:'markdown', markdown:'markdown'
  };
  return map[ext] || '';
}

// ---------- state ------------------------------------------------
var editorState = {
  panes: [
    { name: '', path: null, original: '', view: 'raw', wrap: true },
    { name: '', path: null, original: '', view: 'raw', wrap: true }
  ],
  mode: 'edit',          // 'edit' | 'diff' | 'clean'
  diffSource: 'left-after',    // 'left-after' | 'right-after' | 'left-vs-right'
  focused: 0,
  find: {
    visible: false,
    query: '',
    replace: '',
    caseSensitive: false,
    regex: false,
    matches: 0,
    current: 0
  },
  _findMatches: [],
  _findIdx: -1
};

// ---------- persistence -------------------------------------------
var ED_STATE_KEY = 'trEditor';

function edSaveState() {
  var saved = {
    mode: editorState.mode,
    diffSource: editorState.diffSource,
    focused: editorState.focused,
    panes: []
  };
  for (var i = 0; i < editorState.panes.length; i++) {
    var p = editorState.panes[i];
    saved.panes.push({ name: p.name, path: p.path, original: p.original, view: p.view, wrap: p.wrap });
  }
  try { sessionStorage.setItem(ED_STATE_KEY, JSON.stringify(saved)); } catch (e) {}
}

function edLoadState() {
  try {
    var raw = sessionStorage.getItem(ED_STATE_KEY);
    if (!raw) return;
    var saved = JSON.parse(raw);
    if (saved && typeof saved === 'object') {
      if (typeof saved.mode === 'string') editorState.mode = saved.mode;
      if (typeof saved.diffSource === 'string') editorState.diffSource = saved.diffSource;
      if (typeof saved.focused === 'number') editorState.focused = saved.focused;
      if (Array.isArray(saved.panes)) {
        for (var i = 0; i < saved.panes.length && i < editorState.panes.length; i++) {
          var sp = saved.panes[i];
          if (sp && typeof sp === 'object') {
            var dp = editorState.panes[i];
            if (typeof sp.name === 'string') dp.name = sp.name;
            if (sp.path === null || typeof sp.path === 'string') dp.path = sp.path;
            if (typeof sp.original === 'string') dp.original = sp.original;
            if (typeof sp.view === 'string') dp.view = sp.view;
            if (typeof sp.wrap === 'boolean') dp.wrap = sp.wrap;
          }
        }
      }
    }
  } catch (e) { /* ignore corrupt state */ }
}
