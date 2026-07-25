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
  mode: 'edit',          // 'edit' | 'diff'
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
  }
};
