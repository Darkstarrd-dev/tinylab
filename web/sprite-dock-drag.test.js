// web/sprite-dock-drag.test.js
// Zero-dependency Node behavioral test for the sprite dock drag (item 2).
// Loads the REAL sprite.js in a sandboxed VM with a minimal hand-rolled DOM
// stub (no browser, no jsdom) and drives the dock's mousedown/mousemove/mouseup
// handlers directly — proving the drag invariants the structural bench can
// only assert by substring: the >4px threshold (drag vs click), left/right
// side-snap, position persistence to localStorage, and that a drag does NOT
// open the modal while a click does.
//
// Run:  node web/sprite-dock-drag.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (err) { failures++; console.error('FAIL  ' + name + ': ' + (err && err.message)); }
}

// --- Minimal DOM stub: just enough for sprite.js initSpriteDOM + the dock
// drag path. createElement returns a fake element; getElementById resolves by
// id (registered when sprite.js sets el.id). document/window localStorage +
// event listeners are recorded so the test can invoke the drag handlers. ---
const idMap = {};
const docListeners = {};
const lsStore = {};
let lsSets = [];

function makeEl(tag) {
  const listeners = {};
  let _id = '';
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    className: '',
    innerHTML: '',
    style: {},
    children: [],
    onclick: null,
    offsetHeight: 60,
    offsetWidth: 60,
    _listeners: listeners,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute(k, v) { if (k === 'id') { _id = v; idMap[v] = el; } },
    getAttribute() { return null; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { if (listeners[t]) listeners[t] = listeners[t].filter(f => f !== fn); },
    getBoundingClientRect() { return { left: 100, top: 200, right: 160, bottom: 260, width: 60, height: 60 }; },
  };
  Object.defineProperty(el, 'id', { get() { return _id; }, set(v) { _id = v; idMap[v] = el; } });
  return el;
}

const document = {
  readyState: 'complete',
  body: { appendChild() {} },
  createElement: makeEl,
  getElementById(id) { return idMap[id]; },
  addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
  removeEventListener(t, fn) { if (docListeners[t]) docListeners[t] = docListeners[t].filter(f => f !== fn); },
};
const window = {
  innerWidth: 1280,
  innerHeight: 800,
  localStorage: {
    getItem(k) { return (k in lsStore) ? lsStore[k] : null; },
    setItem(k, v) { lsStore[k] = String(v); lsSets.push(k); },
  },
  addEventListener() {},
  setTimeout() {},
  EventSource: class { constructor() {} addEventListener() {} close() {} },
};
window.document = document;
window.window = window;

function fakeEvent(o) {
  return Object.assign({ button: 0, preventDefault() {}, stopPropagation() {}, target: { closest() { return null; } } }, o);
}

function dockEl() { return idMap['sprite-dock']; }
function modalEl() { return idMap['sprite-modal-overlay']; }

// mousedown → (optional mousemove) → mouseup, invoking the handlers sprite.js
// registered on the dock and document.
function dragSequence(down, move, up) {
  const dock = dockEl();
  dock._listeners.mousedown[0](fakeEvent({ clientX: down[0], clientY: down[1] }));
  if (move) docListeners.mousemove[0](fakeEvent({ clientX: move[0], clientY: move[1] }));
  docListeners.mouseup[0](fakeEvent({}));
  void up;
}

const sandbox = {
  document,
  window,
  console,
  // sprite.js references these as free vars (browser globals), not window.*:
  localStorage: window.localStorage,
  setTimeout: window.setTimeout,
  EventSource: window.EventSource,
  fetch: () => Promise.reject(new Error('no fetch in test')),
};
vm.createContext(sandbox);
const SRC = fs.readFileSync(path.join(__dirname, 'static/sprite.js'), 'utf8');
vm.runInContext(SRC, sandbox, { filename: 'sprite.js' });

check('init: dock created + positioned (default right, centered)', () => {
  assert.ok(idMap['sprite-dock'], 'dock element created');
  assert.ok(dockEl().style.top, 'applyDockPosition set dock.style.top on init');
  assert.strictEqual(dockEl().style.right, '0px', 'default side is right');
});

check('drag >4px to left half: repositions, snaps left, persists side+y, NO modal', () => {
  lsSets = [];
  modalEl().classList._s.delete('show');
  dragSequence([100, 100], [500, 300], null); // 500 < 640 (innerWidth/2) → left
  const dock = dockEl();
  assert.ok(dock.style.top, 'dock.style.top updated by drag');
  assert.strictEqual(dock.style.left, '0px', 'snapped to left edge');
  assert.strictEqual(dock.style.right, 'auto', 'right cleared');
  assert.ok(dock.classList.contains('side-left'), 'side-left class applied');
  assert.strictEqual(lsStore['tr-sprite-dock-side'], 'left', 'side persisted to localStorage');
  assert.ok(lsStore['tr-sprite-dock-y'] != null, 'y persisted to localStorage');
  assert.ok(lsSets.indexOf('tr-sprite-dock-side') >= 0, 'saveDockPosition called');
  assert.ok(!modalEl().classList.contains('show'), 'modal NOT opened (drag, not click)');
});

check('drag >4px to right half: snaps right', () => {
  lsSets = [];
  dragSequence([100, 100], [1000, 400], null); // 1000 > 640 → right
  const dock = dockEl();
  assert.strictEqual(dock.style.right, '0px', 'snapped to right edge');
  assert.strictEqual(dock.style.left, 'auto', 'left cleared');
  assert.ok(!dock.classList.contains('side-left'), 'side-left removed');
  assert.strictEqual(lsStore['tr-sprite-dock-side'], 'right', 'side persisted right');
});

check('click (≤4px, no move): opens modal, does NOT persist', () => {
  lsSets = [];
  modalEl().classList._s.delete('show');
  dragSequence([100, 100], null, null); // mousedown then immediate mouseup, no move
  assert.ok(modalEl().classList.contains('show'), 'modal opened (treated as click)');
  assert.strictEqual(lsSets.length, 0, 'no position persistence on click');
});

check('tiny move ≤4px: treated as click (no drag, opens modal)', () => {
  lsSets = [];
  modalEl().classList._s.delete('show');
  dragSequence([100, 100], [103, 102], null); // 3px move < 4 threshold
  assert.ok(modalEl().classList.contains('show'), 'modal opened (sub-threshold = click)');
  assert.strictEqual(lsSets.length, 0, 'no persistence for sub-threshold move');
});

if (failures) { console.error('\n' + failures + ' check(s) FAILED'); process.exit(1); }
console.log('\nall dock drag checks passed');
