// web/shortcut-hints.test.js
// Zero-dependency Node behavioral & wiring test for the Live Shortcut Hints HUD.
// Loads the REAL shortcuts.js, i18n.js, shortcut-hints.js, and module registration
// scripts in an isolated VM sandbox and verifies:
//   1. Preset registration & no cross-region conflicts (global.toggle-shortcut-hints = q),
//      matchBinding(), formatAction(), and onChange() with/without document.
//   2. HTML script order & trigger wiring in index.html / index-nopg.html,
//      and gallery-layout.js dynamic tooltips without escapeAttr.
//   3. Context detection (including lexical let currentPage / currentProviderId),
//      modal isolation & z-index stacking, dropdown menu shadowing, and visibility.
//   4. Module contextual rules & shadowing across Monitor, Endpoint, Settings,
//      Provider Detail, Gallery (image/video/anim/split/tree/review/meta/fs/trim + 1-9 shadow),
//      Playground (modes/generating/batch/inline-edit/splitCount), GIF Editor,
//      Editor V1, Editor V2, Assistant Demo, and GameMaker.
//   5. Tier A vs Tier B DOM visibility split (disabled/hidden/opacity:0/zero-rect/modal).
//   6. Dynamic Shortcuts.setOverride linkage (including Systray footer items).
//   7. Capture-phase Q toggle & Esc dismiss guards (editable targets, IME, overlays).
//
// Run: node web/shortcut-hints.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (err) {
    failures++;
    console.error('FAIL  ' + name + ': ' + (err && err.stack ? err.stack : err));
  }
}

function readWeb(rel) {
  return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

// ----- Tiny DOM + Event harness sufficient for ShortcutHints & module scripts -----

function makeClassList(initial) {
  const set = new Set((initial || []).filter(Boolean));
  return {
    add(...c) { for (const x of c) if (x) set.add(x); },
    remove(...c) { for (const x of c) set.delete(x); },
    replaceAll(str) { set.clear(); for (const x of String(str || '').split(/\s+/)) if (x) set.add(x); },
    toggle(c, force) {
      if (force === undefined) {
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      }
      if (force) set.add(c); else set.delete(c);
      return !!force;
    },
    contains(c) { return set.has(c); },
    toString() { return Array.from(set).join(' '); }
  };
}

function makeEl(opts) {
  opts = opts || {};
  const cl = makeClassList(opts.classes || (opts.className ? String(opts.className).split(/\s+/) : []));
  const propagateConnected = (node, val) => {
    if (!node) return;
    node.isConnected = val;
    for (const ch of (node.children || [])) propagateConnected(ch, val);
  };
  const el = {
    nodeType: 1,
    tagName: (opts.tagName || 'DIV').toUpperCase(),
    id: opts.id || '',
    classList: cl,
    style: Object.assign({}, opts.style || {}),
    attrs: Object.assign({}, opts.attrs || {}),
    children: [],
    parentElement: null,
    parentNode: null,
    isConnected: opts.isConnected !== false,
    hidden: !!opts.hidden,
    disabled: !!opts.disabled,
    readOnly: !!opts.readOnly,
    isContentEditable: !!opts.isContentEditable,
    textContent: opts.textContent || '',
    _innerHTML: '',
    offsetWidth: opts.offsetWidth !== undefined ? opts.offsetWidth : 40,
    offsetHeight: opts.offsetHeight !== undefined ? opts.offsetHeight : 28,
    _rect: opts.rect || { left: 20, top: 20, right: 60, bottom: 48, width: 40, height: 28 },
    _listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    addEventListener(type, fn, cap) {
      this._listeners[type] = this._listeners[type] || [];
      this._listeners[type].push({ fn, cap: !!cap });
    },
    removeEventListener(type, fn, cap) {
      if (!this._listeners[type]) return;
      this._listeners[type] = this._listeners[type].filter(l => !(l.fn === fn && l.cap === !!cap));
    },
    appendChild(child) {
      if (!child) return child;
      if (child.parentNode && child.parentNode !== this) child.parentNode.removeChild(child);
      child.parentNode = this;
      child.parentElement = this;
      propagateConnected(child, this.isConnected);
      if (this.children.indexOf(child) === -1) this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      if (child) { child.parentNode = null; child.parentElement = null; }
      return child;
    },
    get firstElementChild() { return this.children[0] || null; },
    getBoundingClientRect() { return Object.assign({}, this._rect); },
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode || cur.parentElement;
      }
      return false;
    },
    closest(sel) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (matchesSimple(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(sel) { return findAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return findAll(this, sel); }
  };
  Object.defineProperty(el, 'className', {
    get() { return cl.toString(); },
    set(v) { cl.replaceAll(v); }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) {
      el._innerHTML = String(v || '');
      if (v === '') el.children = [];
    }
  });
  return el;
}

function matchesOne(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  sel = sel.trim();
  if (!sel) return false;
  // Support descendant combinator "a b" and compound ".a.b#id[attr='v']"
  const parts = sel.split(/\s+/);
  if (parts.length > 1) {
    const tail = parts[parts.length - 1];
    if (!matchesOne(el, tail)) return false;
    let cur = el.parentElement;
    for (let pi = parts.length - 2; pi >= 0; pi--) {
      while (cur && !matchesOne(cur, parts[pi])) cur = cur.parentElement;
      if (!cur) return false;
      cur = cur.parentElement;
    }
    return true;
  }
  const s = parts[0];
  let rest = s;
  const tagMatch = rest.match(/^[a-zA-Z0-9_-]+/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[0].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  const idMatch = rest.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch) {
    if (el.id !== idMatch[1]) return false;
    rest = rest.replace(idMatch[0], '');
  }
  const classMatches = rest.match(/\.[a-zA-Z0-9_-]+/g) || [];
  for (const cm of classMatches) {
    if (!el.classList.contains(cm.slice(1))) return false;
    rest = rest.replace(cm, '');
  }
  const attrMatch = rest.match(/\[([^\]=]+)(?:="([^"]*)")?\]/);
  if (attrMatch) {
    const av = el.getAttribute(attrMatch[1]);
    if (attrMatch[2] !== undefined ? av !== attrMatch[2] : av == null) return false;
  }
  return true;
}

function matchesSimple(el, sel) {
  return String(sel).split(',').some(part => matchesOne(el, part));
}

function findAll(root, sel) {
  const out = [];
  const list = Array.isArray(root.children) ? root.children : [];
  for (const ch of list) {
    if (matchesSimple(ch, sel)) out.push(ch);
    out.push(...findAll(ch, sel));
  }
  return out;
}

function createHarness() {
  const docListeners = {};
  const winListeners = {};
  const dispatches = [];

  const htmlEl = makeEl({ tagName: 'HTML' });
  const bodyEl = makeEl({
    tagName: 'BODY',
    rect: { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 },
    offsetWidth: 1280,
    offsetHeight: 800
  });
  htmlEl.appendChild(bodyEl);

  const triggerBtn = makeEl({
    tagName: 'BUTTON',
    id: 'shortcut-hints-trigger',
    className: 'brand-title-btn',
    textContent: 'TinyLab',
    rect: { left: 16, top: 10, right: 92, bottom: 38, width: 76, height: 28 }
  });
  bodyEl.appendChild(triggerBtn);

  const documentObj = {
    documentElement: htmlEl,
    body: bodyEl,
    readyState: 'complete',
    activeElement: null,
    createElement(tag) { return makeEl({ tagName: tag, isConnected: false }); },
    getElementById(id) {
      if (!id) return null;
      return findAll(htmlEl, '#' + id)[0] || null;
    },
    querySelector(sel) { return findAll(bodyEl, sel)[0] || null; },
    querySelectorAll(sel) { return findAll(bodyEl, sel); },
    addEventListener(type, fn, cap) {
      docListeners[type] = docListeners[type] || [];
      docListeners[type].push({ fn, cap: !!cap });
    },
    removeEventListener(type, fn, cap) {
      if (!docListeners[type]) return;
      docListeners[type] = docListeners[type].filter(l => !(l.fn === fn && l.cap === !!cap));
    },
    dispatchEvent(ev) { dispatches.push(ev); return true; }
  };

  const sandbox = {
    console,
    Math, Date, Object, Array, String, Number, Boolean, Error, JSON, RegExp, Set, Map,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame: () => {},
    escapeHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    navigator: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)', language: 'en-US' },
    localStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    document: documentObj,
    getComputedStyle(el) {
      return {
        display: (el && el.style && el.style.display) || 'block',
        visibility: (el && el.style && el.style.visibility) || 'visible',
        opacity: (el && el.style && el.style.opacity !== undefined) ? String(el.style.opacity) : '1',
        zIndex: (el && el.style && el.style.zIndex !== undefined) ? String(el.style.zIndex) : 'auto'
      };
    },
    addEventListener(type, fn, cap) {
      winListeners[type] = winListeners[type] || [];
      winListeners[type].push({ fn, cap: !!cap });
    },
    removeEventListener(type, fn, cap) {
      if (!winListeners[type]) return;
      winListeners[type] = winListeners[type].filter(l => !(l.fn === fn && l.cap === !!cap));
    },
    EditorLayout: { create() { return makeEl({ className: 'ed-root' }); } },
    EditorWorkspace: {},
    GifEditorCore: { state: { slices: [], pickColorMode: false, floodPickMode: false }, dom: {}, commands: {}, registerModule() {} },
    T: (k) => k,
    pgT: (k) => k,
    galleryState: {
      viewMode: 'single',
      mediaType: 'image',
      focus: 'image',
      treeOpen: false,
      metaOverlayEnabled: false,
      items: [{ name: 'a.png' }],
      videoItems: [],
      videoIndex: 0,
      reviewState: { active: false, reviewMode: false, status: 'idle' }
    },
    pgState: {
      mode: 'normal',
      splitCount: 1,
      activeWin: 0,
      inputMaximized: false,
      imageBatch: { uiMode: 'idle' }
    },
    pgIsGenerating: () => false
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Mirror app.js top-level lexical `let currentPage` and `let currentProviderId`.
  vm.runInContext(
    "let currentPage = 'monitor'; let currentProviderId = null;" +
    "function __setPage(p){ currentPage = p; }" +
    "function __setProviderId(v){ currentProviderId = v; }",
    sandbox,
    { filename: 'app-lexicals.js' }
  );

  for (const rel of [
    'static/shortcuts.js',
    'static/i18n.js',
    'static/shortcut-hints.js',
    'playground/static-pg/playground/pg-ui-events.js',
    'playground/static-pg/gallery/gallery-fullscreen.js',
    'static/gif-editor/gif-editor-playback.js',
    'static/gif-editor/gif-editor-input.js',
    'static/utility/editor/editor_shell.js',
    'static/utility/editor-v2/editor-v2-commands.js',
    'static/assistant-demo.js',
    'static/demo-designer.js'
  ]) {
    vm.runInContext(readWeb(rel), sandbox, { filename: rel });
  }

  return { sandbox, documentObj, bodyEl, triggerBtn, makeEl, docListeners, dispatches };
}

console.log('shortcut-hints suite:');

// ----- 1. shortcuts.js preset, matchBinding, formatAction, onChange -----

check('shortcuts.js: global.toggle-shortcut-hints defaults to q with zero preset conflicts', () => {
  const noDocCtx = vm.createContext({
    window: {},
    navigator: { platform: 'Win32', userAgent: 'node-test' },
    console
  });
  vm.runInContext(readWeb('static/shortcuts.js'), noDocCtx, { filename: 'shortcuts.js' });
  const Shortcuts = noDocCtx.window.Shortcuts;
  const def = Shortcuts.defaultBinding('global.toggle-shortcut-hints');
  assert.strictEqual(def && def.key, 'q');
  assert.strictEqual(!!def.ctrlOrCmd, false);
  assert.strictEqual(!!def.alt, false);
  assert.strictEqual(!!def.shift, false);
  assert.strictEqual(Shortcuts.formatAction('global.toggle-shortcut-hints'), 'Q');

  // Verify no conflicts across regions or within global.
  for (const region of Shortcuts.getAllRegions()) {
    for (const act of region.actions) {
      if (act.id === 'global.toggle-shortcut-hints') continue;
      const conflict = Shortcuts.findConflict(region.id, def, 'global.toggle-shortcut-hints');
      if (region.id === 'global') {
        assert.strictEqual(conflict, null, `global preset conflict with ${conflict}`);
      }
    }
  }

  // matchBinding: code + altKeys + modifiers + Spacebar
  assert.strictEqual(Shortcuts.matchBinding({ alt: true, key: '`', code: 'Backquote', altKeys: ['~'] }, { altKey: true, code: 'Backquote', key: 'Dead' }), true);
  assert.strictEqual(Shortcuts.matchBinding({ alt: true, key: '`', code: 'Backquote', altKeys: ['~'] }, { altKey: true, key: '~' }), true);
  assert.strictEqual(Shortcuts.matchBinding({ shift: true, key: '1', code: 'Digit1', altKeys: ['!'] }, { shiftKey: true, key: '!' }), true);
  assert.strictEqual(Shortcuts.matchBinding({ key: ' ' }, { key: 'Spacebar' }), true);
  assert.strictEqual(Shortcuts.matchBinding({ ctrlOrCmd: true, key: 's' }, { key: 's', ctrlKey: false }), false);

  // onChange works without throwing even when document is absent.
  let changes = 0;
  const unsub = Shortcuts.onChange(() => { changes++; });
  Shortcuts.setOverride('global.toggle-shortcut-hints', { key: 'h', ctrlOrCmd: true });
  Shortcuts.loadOverrides({});
  Shortcuts.clearOverride('global.toggle-shortcut-hints');
  Shortcuts.clearAll();
  assert.strictEqual(changes, 4);
  unsub();
  Shortcuts.clearAll();
  assert.strictEqual(changes, 4);
});

// ----- 2. HTML wiring & gallery-layout contract -----

check('index.html & index-nopg.html: brand button trigger and script load order', () => {
  for (const file of ['static/index.html', 'static/index-nopg.html']) {
    const html = readWeb(file);
    assert.ok(/<h1[^>]*class="brand-title-wrap"[^>]*>\s*<button[^>]*id="shortcut-hints-trigger"/.test(html),
      `${file} missing #shortcut-hints-trigger in .brand-title-wrap`);
    const scIdx = html.indexOf('<script src="/shortcuts.js"></script>');
    const shIdx = html.indexOf('<script src="/shortcut-hints.js"></script>');
    assert.ok(scIdx > 0 && shIdx > scIdx, `${file} must load shortcut-hints.js after shortcuts.js`);
    assert.strictEqual(html.indexOf('/settings/settings.js') > shIdx, true, `${file} loads settings after shortcut-hints.js`);
  }
});

check('gallery-layout.js: uses escapeHtml (zero escapeAttr calls) and reads live Shortcuts bindings', () => {
  const galLayoutSrc = readWeb('playground/static-pg/gallery/gallery-layout.js');
  assert.ok(!/\bescapeAttr\s*\(/.test(galLayoutSrc), 'gallery-layout.js must not call undefined escapeAttr');
  const h = createHarness();
  h.sandbox.GALLERY_ICONS = {
    single: 'S', dual: 'D', picture: 'P', video: 'V', stop: '[]', play: '>',
    prev: '<', next: '>', prevFolder: '<<', nextFolder: '>>', tree: 'T',
    metaInfo: 'M', edit: 'E', fullscreen: 'F'
  };
  h.sandbox.AUTOPLAY_LABELS = ['2s'];
  h.sandbox.AUTOPLAY_INTERVALS = [2000];
  h.sandbox.escapeHtml = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;');
  h.sandbox.getVolumeIcon = () => 'vol';
  vm.runInContext(galLayoutSrc, h.sandbox, { filename: 'gallery-layout.js' });
  h.sandbox.Shortcuts.setOverride('gallery.toggle-split', { key: 'x', ctrlOrCmd: true });
  const html = h.sandbox.buildPanelHTML('image', false);
  assert.ok(html.includes('Dual View (Ctrl+X)'), 'buildPanelHTML tooltip must track rebound gallery.toggle-split key');
  assert.ok(!html.includes('(I)'), 'Meta tooltip must not contain unimplemented (I)');
});

// ----- 3. Contextual resolution, shadowing & lexical globals -----

check('collectContext reads lexical currentPage & currentProviderId + QuickSlots & ProviderDetail shadowing', () => {
  const h = createHarness();
  const { sandbox, bodyEl, makeEl } = h;
  const Hints = sandbox.ShortcutHints;

  // Add QuickSlot #1 and #3 (leave #2, #4..9 absent)
  const qsHdr = makeEl({ id: 'quickslot-header' });
  for (const n of [1, 3]) {
    const btn = makeEl({ tagName: 'BUTTON', className: 'quickslot-btn' });
    const num = makeEl({ tagName: 'SPAN', className: 'qs-number', textContent: String(n) });
    btn.appendChild(num);
    qsHdr.appendChild(btn);
  }
  bodyEl.appendChild(qsHdr);

  let res = Hints.resolve(null, { skipDom: true });
  let ids = res.overlay.map(x => x.id);
  assert.strictEqual(res.contextTitle, 'Monitor');
  assert.ok(ids.includes('global.quickslot-cycle-1') && ids.includes('global.quickslot-cycle-3'));
  assert.ok(!ids.includes('global.quickslot-cycle-2') && !ids.includes('global.quickslot-cycle-4'));
  assert.ok(ids.includes('global.shutdown-server'));

  // Endpoint + Provider Detail (lexical currentProviderId = 'openai') -> provider.back shadows shutdown
  sandbox.__setPage('endpoint');
  sandbox.__setProviderId('openai');
  res = Hints.resolve(null, { skipDom: true });
  ids = res.overlay.map(x => x.id);
  assert.strictEqual(res.ctx.page, 'endpoint');
  assert.strictEqual(res.ctx.providerDetail, true);
  assert.ok(ids.includes('provider.back'), 'provider.back should appear');
  assert.ok(!ids.includes('global.shutdown-server'), 'provider.back Esc should shadow shutdown-server');
});

check('modals suppress background hints and z-index stacking selects topmost modal', () => {
  const h = createHarness();
  const { sandbox, bodyEl, makeEl } = h;
  const Hints = sandbox.ShortcutHints;

  const qsOv = makeEl({ id: 'qs-modal-overlay', className: 'qs-modal-overlay show', style: { zIndex: '10020' } });
  bodyEl.appendChild(qsOv);
  let res = Hints.resolve(null, { skipDom: true });
  let ids = res.overlay.map(x => x.id);
  assert.strictEqual(res.ctx.modal, 'qs-modal');
  assert.ok(ids.includes('modal.qs.arrows') && ids.includes('modal.qs.digits') && ids.includes('modal.qs.import'));
  assert.ok(ids.includes('global.toggle-shortcut-hints'), 'HUD toggle remains listed in modals');
  assert.ok(!ids.includes('global.goto-monitor') && !ids.includes('global.shutdown-server'));

  // Stack confirm-modal (#modal-overlay z-index 10030) on top of qs-modal
  const mainOv = makeEl({ id: 'modal-overlay', className: 'modal-overlay show', style: { zIndex: '10030' } });
  mainOv.appendChild(makeEl({ id: 'modal-confirm', tagName: 'BUTTON' }));
  bodyEl.appendChild(mainOv);
  res = Hints.resolve(null, { skipDom: true });
  ids = res.overlay.map(x => x.id);
  assert.strictEqual(res.ctx.modal, 'confirm-modal');
  assert.ok(ids.includes('modal.generic.enter') && !ids.includes('modal.qs.digits'));

  // Check theme-modal, shortcuts-modal, pg-model-picker, pg-groupchat-modal, info-modal
  mainOv.innerHTML = '';
  mainOv.appendChild(makeEl({ id: 'theme-modal-picker-container' }));
  res = Hints.resolve(null, { skipDom: true });
  assert.strictEqual(res.ctx.modal, 'theme-modal');
  assert.ok(res.overlay.some(x => x.id === 'modal.theme.tab') && res.overlay.some(x => x.id === 'modal.theme.space'));

  mainOv.innerHTML = '';
  mainOv.appendChild(makeEl({ id: 'sc-status' }));
  assert.strictEqual(Hints.resolve(null, { skipDom: true }).ctx.modal, 'shortcuts-modal');

  bodyEl.removeChild(mainOv);
  bodyEl.removeChild(qsOv);

  const infoOv = makeEl({ id: 'info-modal-overlay', className: 'info-modal-overlay show', style: { zIndex: '10025' } });
  bodyEl.appendChild(infoOv);
  assert.strictEqual(Hints.resolve(null, { skipDom: true }).ctx.modal, 'info-modal');
  bodyEl.removeChild(infoOv);

  const pgPickerOv = makeEl({ id: 'pg-model-picker-overlay', className: 'pg-modal-overlay show', style: { zIndex: '10025' } });
  bodyEl.appendChild(pgPickerOv);
  res = Hints.resolve(null, { skipDom: true });
  assert.strictEqual(res.ctx.modal, 'pg-model-picker');
  assert.ok(res.overlay.some(x => x.id === 'modal.pgpicker.alpha'));
  bodyEl.removeChild(pgPickerOv);

  const pgModalOv = makeEl({ id: 'pg-modal-overlay', className: 'pg-modal-overlay show', style: { zIndex: '10025' } });
  pgModalOv.appendChild(makeEl({ id: 'pg-gc-input', tagName: 'INPUT' }));
  bodyEl.appendChild(pgModalOv);
  res = Hints.resolve(null, { skipDom: true });
  assert.strictEqual(res.ctx.modal, 'pg-groupchat-modal');
  assert.ok(res.overlay.some(x => x.id === 'modal.groupchat.send'));
});

check('dropdown menu shadows shutdown and shows menu hints', () => {
  const h = createHarness();
  const { sandbox } = h;
  sandbox.utilityMenuOpen = true;
  const res = sandbox.ShortcutHints.resolve(null, { skipDom: true });
  const ids = res.overlay.map(x => x.id);
  assert.strictEqual(res.ctx.dropdown, 'utility');
  assert.ok(ids.includes('menu.nav') && ids.includes('menu.open') && ids.includes('menu.close'));
  assert.ok(!ids.includes('global.shutdown-server') && !ids.includes('global.goto-monitor'));
});

check('Gallery: image, video, anim, split, tree, review, meta, fullscreen, trim & 1-9 shadow', () => {
  const h = createHarness();
  const { sandbox, bodyEl, makeEl } = h;
  const Hints = sandbox.ShortcutHints;
  sandbox.__setPage('gallery');

  // Add visible quickslot #1 and #2
  const qsHdr = makeEl({ id: 'quickslot-header' });
  for (const n of [1, 2]) {
    const b = makeEl({ tagName: 'BUTTON', className: 'quickslot-btn' });
    b.appendChild(makeEl({ className: 'qs-number', textContent: String(n) }));
    qsHdr.appendChild(b);
  }
  bodyEl.appendChild(qsHdr);

  // Image mode: bare 1-9 quickslots hidden, rebound Ctrl+Alt+2 shown
  sandbox.Shortcuts.setOverride('global.quickslot-cycle-2', { key: '2', ctrlOrCmd: true, alt: true });
  let ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(!ids.includes('global.quickslot-cycle-1'), 'bare digit quickslot suppressed in Gallery');
  assert.ok(ids.includes('global.quickslot-cycle-2'), 'rebound Ctrl+Alt+2 quickslot remains active in Gallery');
  assert.ok(ids.includes('gallery.prev') && ids.includes('gallery.toggle-autoplay') && ids.includes('gallery.exclude-hash'));
  assert.ok(!ids.includes('gallery.clear-tree') && !ids.includes('gallery.vid-play'));

  // Tree open reveals clear-tree
  sandbox.galleryState.treeOpen = true;
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('gallery.clear-tree'));

  // Review nav shadows gallery.prev/next/prev-folder/next-folder
  sandbox.galleryState.reviewState = { active: true, reviewMode: true, status: 'running' };
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('gallery.review-prev') && ids.includes('gallery.review-mark'));
  assert.ok(!ids.includes('gallery.prev') && !ids.includes('gallery.next'));
  sandbox.galleryState.reviewState = { active: false, reviewMode: false, status: 'idle' };

  // Split mode hides toggle-media and enables switch-focus
  sandbox.galleryState.viewMode = 'split';
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(!ids.includes('gallery.toggle-media') && ids.includes('gallery.switch-focus'));
  sandbox.galleryState.viewMode = 'single';

  // Video mode switches controls
  sandbox.galleryState.mediaType = 'video';
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('gallery.vid-play') && ids.includes('gallery.vid-seek-back') && ids.includes('gallery.vid-volume'));
  assert.ok(!ids.includes('gallery.prev') && !ids.includes('gallery.exclude-hash'));

  // Animated image mode switches to replay + prev/next only
  sandbox.galleryState.videoItems = [{ name: 'anim.gif' }];
  sandbox.isAnimatedImg = () => true;
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('gallery.anim-replay') && ids.includes('gallery.vid-prev'));
  assert.ok(!ids.includes('gallery.vid-play') && !ids.includes('gallery.vid-seek-back') && !ids.includes('gallery.vid-volume'));
  sandbox.galleryState.mediaType = 'image';
  sandbox.isAnimatedImg = () => false;

  // Meta overlay Esc shadows shutdown
  sandbox.galleryState.metaOverlayEnabled = true;
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('gallery.close-meta') && !ids.includes('global.shutdown-server'));
  sandbox.galleryState.metaOverlayEnabled = false;

  // Fullscreen + Trim mode Esc precedence
  bodyEl.classList.add('gallery-fullscreen-active');
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('gallery.exit-fullscreen') && !ids.includes('global.shutdown-server'));

  const trimCtrl = makeEl({ className: 'ge-trim-mode-ctrl' });
  bodyEl.appendChild(trimCtrl);
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('gallery.trim-cancel') && !ids.includes('gallery.exit-fullscreen'));
});

check('Playground, GIF Editor, Editor V1, Editor V2, Assistant Demo, GameMaker context rules', () => {
  const h = createHarness();
  const { sandbox, bodyEl, makeEl } = h;
  const Hints = sandbox.ShortcutHints;

  // Playground: splitCount 2, normal -> win-1 & win-2 only
  sandbox.__setPage('playground');
  sandbox.pgState.splitCount = 2;
  let ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('pg.send-message') && ids.includes('pg.win-1') && ids.includes('pg.win-2'));
  assert.ok(!ids.includes('pg.win-3') && !ids.includes('pg.cancel-edit'));

  // Generating in normal suppresses send/split/win
  sandbox.pgIsGenerating = () => true;
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(!ids.includes('pg.send-message') && !ids.includes('pg.split-count') && !ids.includes('pg.win-1'));
  sandbox.pgIsGenerating = () => false;

  // Image batch hides split-count
  sandbox.pgState.mode = 'image';
  sandbox.pgState.imageBatch = { uiMode: 'batch' };
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(!ids.includes('pg.split-count'));
  sandbox.pgState.mode = 'normal';

  // Inline editing shows apply-edit & cancel-edit (Esc shadows shutdown)
  const panes = makeEl({ id: 'pg-panes' });
  panes.appendChild(makeEl({ className: 'pg-editor' }));
  bodyEl.appendChild(panes);
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('pg.apply-edit') && ids.includes('pg.cancel-edit') && !ids.includes('global.shutdown-server'));
  bodyEl.removeChild(panes);

  // GIF Editor: no slices vs hasSlices vs pickColorMode
  sandbox.__setPage('utility');
  sandbox.utilityActiveTool = 'gif';
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(!ids.includes('gif.play-pause') && !ids.includes('gif.cancel-pick'));
  sandbox.GifEditorCore.state.slices = [{}, {}];
  sandbox.GifEditorCore.state.pickColorMode = true;
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('gif.play-pause') && ids.includes('gif.prev-frame') && ids.includes('gif.cancel-pick'));
  assert.ok(!ids.includes('global.shutdown-server'));

  // Editor V1 & V2
  sandbox.utilityActiveTool = 'editor';
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('ed1.save') && ids.includes('ed1.comment') && !ids.includes('ed2.gotoLine'));

  sandbox.utilityActiveTool = 'editorV2';
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('ed2.save') && ids.includes('ed2.gotoLine') && !ids.includes('ed1.save'));

  // Assistant Demo (scroller vs topdown+bodyMode)
  sandbox.__setPage('demo');
  sandbox.demoActiveTool = 'ademo';
  sandbox.ademoActiveTab = 'ademo';
  let res = Hints.resolve(null, { skipDom: true });
  assert.strictEqual(res.overlay.find(x => x.id === 'demo.move').keyText, '← / →');
  assert.ok(!res.overlay.some(x => x.id === 'demo.exit-body'));

  sandbox.ademoPersist.type1 = 'topdown';
  sandbox.ademoRt = { bodyMode: true };
  res = Hints.resolve(null, { skipDom: true });
  assert.strictEqual(res.overlay.find(x => x.id === 'demo.move').keyText, 'WASD / ←↑↓→');
  assert.ok(res.overlay.some(x => x.id === 'demo.exit-body') && !res.overlay.some(x => x.id === 'global.shutdown-server'));

  // GameMaker (normal -> previewFocused -> .dgn-root.dgn-fullscreen)
  sandbox.demoActiveTool = 'design';
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('dgn.fullscreen') && ids.includes('dgn.save') && ids.includes('dgn.comment'));
  assert.ok(!ids.includes('dgn.exit-focus') && !ids.includes('dgn.exit-fullscreen'));

  bodyEl.classList.add('dgn-preview-focus');
  ids = Hints.resolve(null, { skipDom: true }).overlay.map(x => x.id);
  assert.ok(ids.includes('dgn.exit-focus') && !ids.includes('dgn.save') && !ids.includes('global.shutdown-server'));
  bodyEl.classList.remove('dgn-preview-focus');

  const dgnRoot = makeEl({ className: 'dgn-root dgn-fullscreen' });
  bodyEl.appendChild(dgnRoot);
  res = Hints.resolve(null, { skipDom: true });
  const exitFs = res.overlay.find(x => x.id === 'dgn.exit-fullscreen');
  assert.ok(exitFs && exitFs.keyText.includes('Ctrl+F'), 'dgn.exit-fullscreen should mention Esc / Ctrl+F');
  assert.ok(!res.overlay.some(x => x.id === 'dgn.save') && !res.overlay.some(x => x.id === 'global.shutdown-server'));
});

// ----- 4. Tier A vs Tier B DOM visibility split -----

check('Tier A vs Tier B visibility filter: visible, hidden, disabled, opacity:0, zero-rect, out-of-bounds', () => {
  const h = createHarness();
  const { sandbox, bodyEl, makeEl } = h;
  const Hints = sandbox.ShortcutHints;

  const monNav = makeEl({ tagName: 'BUTTON', className: 'nav-item', attrs: { 'data-page': 'monitor' }, rect: { left: 100, top: 10, right: 170, bottom: 40, width: 70, height: 30 } });
  const epNav = makeEl({ tagName: 'BUTTON', className: 'nav-item', attrs: { 'data-page': 'endpoint' }, disabled: true });
  const pgNav = makeEl({ tagName: 'BUTTON', className: 'nav-item', attrs: { 'data-page': 'playground' }, style: { opacity: '0' } });
  const utNav = makeEl({ tagName: 'BUTTON', className: 'nav-item', attrs: { 'data-page': 'utility' }, rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } });
  const galNav = makeEl({ tagName: 'BUTTON', className: 'nav-item', attrs: { 'data-page': 'gallery' }, style: { display: 'none' } });
  const wrapHidden = makeEl({ style: { visibility: 'hidden' } });
  const demoNav = makeEl({ tagName: 'BUTTON', className: 'nav-item', attrs: { 'data-page': 'demo' } });
  wrapHidden.appendChild(demoNav);
  bodyEl.appendChild(monNav);
  bodyEl.appendChild(epNav);
  bodyEl.appendChild(pgNav);
  bodyEl.appendChild(utNav);
  bodyEl.appendChild(galNav);
  bodyEl.appendChild(wrapHidden);

  const res = Hints.resolve(null, { layerRect: { left: 0, top: 0, right: 1280, bottom: 800 } });
  const anchoredIds = res.anchored.map(a => a.id);
  const overlayIds = res.overlay.map(o => o.id);
  assert.ok(anchoredIds.includes('global.toggle-shortcut-hints') && anchoredIds.includes('global.goto-monitor'));
  for (const hiddenId of ['global.goto-endpoint', 'global.goto-playground', 'global.goto-download', 'global.goto-gallery', 'global.goto-demo']) {
    assert.ok(!anchoredIds.includes(hiddenId), `${hiddenId} must NOT anchor when target hidden/disabled`);
    assert.ok(overlayIds.includes(hiddenId), `${hiddenId} falls back to overlay when target hidden`);
  }
});

// ----- 5. Dynamic override linkage & Systray footer -----

check('Shortcuts.setOverride dynamically updates resolved keys, Systray footer & open HUD', () => {
  const h = createHarness();
  const { sandbox } = h;
  const Hints = sandbox.ShortcutHints;
  assert.strictEqual(Hints.open(), true);
  sandbox.Shortcuts.setOverride('global.toggle-shortcut-hints', { key: 'k', ctrlOrCmd: true });
  sandbox.Shortcuts.setOverride('systray.open-browser', { key: 'b', ctrlOrCmd: true, shift: true });

  const res = Hints.resolve(null, { skipDom: true });
  const toggleItem = res.overlay.find(x => x.id === 'global.toggle-shortcut-hints');
  const sysBrowser = res.systray.find(x => x.id === 'systray.open-browser');
  assert.strictEqual(toggleItem && toggleItem.keyText, 'Ctrl+K');
  assert.strictEqual(sysBrowser && sysBrowser.keyText, 'Ctrl+Shift+B');
  assert.strictEqual(h.triggerBtn.getAttribute('data-tooltip'), 'Shortcut Hints (Ctrl+K)');
});

// ----- 6. Capture-phase Q toggle & Esc dismiss guards -----

check('Capture-phase keydown guards: editable targets, IME, suppression overlays & Esc isolation', () => {
  const h = createHarness();
  const { sandbox, bodyEl, makeEl } = h;
  const Hints = sandbox.ShortcutHints;

  const mkKey = (key, extra) => {
    const ev = Object.assign({
      key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      defaultPrevented: false,
      _stoppedImmediate: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this._stoppedImmediate = true; }
    }, extra || {});
    return ev;
  };

  // Ignored in INPUT / SELECT / editable TEXTAREA / contentEditable / .monaco-editor
  const monacoHost = makeEl({ className: 'monaco-editor' });
  const monacoChild = makeEl({ tagName: 'DIV' });
  monacoHost.appendChild(monacoChild);
  bodyEl.appendChild(monacoHost);
  for (const target of [
    makeEl({ tagName: 'INPUT' }),
    makeEl({ tagName: 'SELECT' }),
    makeEl({ tagName: 'TEXTAREA' }),
    makeEl({ tagName: 'DIV', isContentEditable: true }),
    monacoChild
  ]) {
    Hints._onDocumentKeyDown(mkKey('q', { target }));
    assert.strictEqual(Hints.isOpen(), false, 'Q must be ignored inside ' + target.tagName);
  }

  // Ignored on IME / __scActiveCapture / __nativePickerBusy / demo-stage-fullscreen
  Hints._onDocumentKeyDown(mkKey('q', { target: bodyEl, isComposing: true }));
  assert.strictEqual(Hints.isOpen(), false);
  sandbox.__scActiveCapture = { actionId: 'test' };
  Hints._onDocumentKeyDown(mkKey('q', { target: bodyEl }));
  assert.strictEqual(Hints.isOpen(), false);
  sandbox.__scActiveCapture = null;
  bodyEl.classList.add('demo-stage-fullscreen');
  Hints._onDocumentKeyDown(mkKey('q', { target: bodyEl }));
  assert.strictEqual(Hints.isOpen(), false);
  bodyEl.classList.remove('demo-stage-fullscreen');

  // readOnly textarea DOES allow toggle
  Hints._onDocumentKeyDown(mkKey('q', { target: makeEl({ tagName: 'TEXTAREA', readOnly: true }) }));
  assert.strictEqual(Hints.isOpen(), true, 'Q on readOnly textarea should open HUD');

  // Modified Shift+Escape or Ctrl+Escape must NOT dismiss HUD
  const shiftEsc = mkKey('Escape', { target: bodyEl, shiftKey: true });
  Hints._onDocumentKeyDown(shiftEsc);
  assert.strictEqual(Hints.isOpen(), true);
  assert.strictEqual(shiftEsc._stoppedImmediate, false);

  // Bare Escape closes HUD & calls preventDefault + stopImmediatePropagation
  const esc = mkKey('Escape', { target: bodyEl });
  Hints._onDocumentKeyDown(esc);
  assert.strictEqual(Hints.isOpen(), false);
  assert.strictEqual(esc.defaultPrevented, true);
  assert.strictEqual(esc._stoppedImmediate, true);
});

// ----- 7. Tall modal avoidance side-docking -----

check('Tall centered modal triggers sh-docked-side with non-overlapping coordinates', () => {
  const h = createHarness();
  const { sandbox, bodyEl, makeEl } = h;
  const Hints = sandbox.ShortcutHints;

  // Give body/layer full 1440x900 viewport metrics
  bodyEl._rect = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
  bodyEl.offsetWidth = 1440;
  bodyEl.offsetHeight = 900;

  // Simulate makeEl calculating offsetWidth/Height from style and layer full-viewport rect
  const origCreate = h.documentObj.createElement.bind(h.documentObj);
  h.documentObj.createElement = function(tag) {
    const el = origCreate(tag);
    Object.defineProperty(el, 'offsetWidth', {
      get() {
        if (el.id === 'shortcut-hints-layer') return 1440;
        if (el.className === 'sh-overlay-card' || el.classList.contains('sh-overlay-card')) {
          return el.style.width ? parseInt(el.style.width, 10) : 580;
        }
        return 40;
      }
    });
    Object.defineProperty(el, 'offsetHeight', {
      get() {
        if (el.id === 'shortcut-hints-layer') return 900;
        if (el.className === 'sh-overlay-card' || el.classList.contains('sh-overlay-card')) {
          return 420;
        }
        return 28;
      }
    });
    el.getBoundingClientRect = function() {
      if (el.id === 'shortcut-hints-layer') return { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
      return Object.assign({}, el._rect);
    };
    return el;
  };

  // Tall centered modal (460x660 in 1440x900 -> bottom=780 leaves only 108px below and 464px right/left)
  const mainOv = makeEl({ id: 'modal-overlay', className: 'modal-overlay show', style: { zIndex: '50' } });
  const modalBox = makeEl({
    className: 'modal',
    rect: { left: 490, top: 120, right: 950, bottom: 780, width: 460, height: 660 },
    offsetWidth: 460,
    offsetHeight: 660
  });
  modalBox.appendChild(makeEl({ id: 'sc-status' }));
  mainOv.appendChild(modalBox);
  bodyEl.appendChild(mainOv);

  assert.strictEqual(Hints.open(), true);
  const card = bodyEl.querySelector('#shortcut-hints-layer .sh-overlay-card');
  assert.ok(card && card.classList.contains('sh-docked-side'), 'Card must dock to side beside tall centered modal');
  const m = String(card.style.transform || '').match(/translate3d\((\d+)px,(\d+)px,0\)/);
  assert.ok(m, 'Card must receive translate3d transform');
  const cardLeft = parseInt(m[1], 10);
  const cardWidth = parseInt(card.style.width, 10);
  assert.ok(cardLeft >= 964 && cardLeft + cardWidth <= 1440, `Docked card (${cardLeft}..${cardLeft + cardWidth}) must clear modal right edge 950`);
});

console.log(failures === 0 ? '\nAll shortcut-hints checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
