// web/sprite-pet-drag.test.js
// Zero-dependency Node behavioral test for the L3 desktop pet drag
// (sprite-pet.js's mouse-drag-to-move). Loads the REAL web/static/sprite-pet.js
// in a VM sandbox with a minimal DOM stub, then drives the avatar's mousedown +
// window mousemove/mouseup — proving the drag calls the Go-bound
// window.movePetWindow with correct deltas, that deltas are incremental
// (startX/Y updated each move), that mouseup ends the drag, and that a
// mousedown on the bubble does NOT drag.
// The transparency itself is Windows-native Win32 (untestable without a
// tray+webview runtime + display); this covers the JS drag half of item 5.
//
// Since the pet logic was extracted from sprite-pet.html into its own module,
// this file also guards the extraction contract: sprite-pet.html must load
// /sprite-pet.js via an external script tag and must NOT contain inline
// <script> blocks (regression guard against re-inlining the logic).
//
// Run:  node web/sprite-pet-drag.test.js
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

const JS_PATH = path.join(__dirname, 'static/sprite-pet.js');
const HTML_PATH = path.join(__dirname, 'static/sprite-pet.html');

console.log('sprite pet module extraction contract:');

check('sprite-pet.html loads /sprite-pet.js externally (no inline script)', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  assert.ok(html.includes('<script src="/sprite-pet.js"></script>'),
    'html must reference /sprite-pet.js via external tag');
  assert.ok(!/<script>(?![\s]*<\/)/.test(html.replace('<script src="/sprite-pet.js"></script>', '')),
    'no inline <script> blocks allowed in sprite-pet.html');
});

check('sprite-pet.js defines the drag + renderer entry points', () => {
  const src = fs.readFileSync(JS_PATH, 'utf8');
  for (const fn of ['movePetWindow', 'initPetSprite', 'sendPetIntent', 'toggleBubble', '/api/assistant/events']) {
    assert.ok(src.includes(fn), 'missing expected symbol: ' + fn);
  }
});

// --- Minimal DOM stub for the pet page drag path. ---
function makeEl() {
  const listeners = {};
  return {
    style: {}, children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    _listeners: listeners,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    focus() {}, querySelector() { return null; },
  };
}
const els = { 'pet-avatar': makeEl(), 'pet-bubble': makeEl(), 'pet-input': makeEl(), 'pet-bubble-msg': makeEl() };
const winListeners = {};
const moveCalls = [];
const document = {
  getElementById(id) { return els[id] || null; },
};
const window = {
  innerWidth: 240, innerHeight: 240,
  addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
  removeEventListener() {},
  movePetWindow(dx, dy) { moveCalls.push([dx, dy]); },
  closePetWindow() {},
  close() {},
  EventSource: class { constructor() {} addEventListener() {} close() {} },
  fetch: () => Promise.reject(new Error('no fetch in test')),
  setTimeout() {},
};
window.document = document; window.window = window;

const sandbox = {
  document, window,
  localStorage: window, // not used by drag; satisfy any free-var reference
  setTimeout: window.setTimeout, EventSource: window.EventSource, fetch: window.fetch,
  console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(JS_PATH, 'utf8'), sandbox, { filename: 'sprite-pet.js' });

function fakeEvent(o) {
  return Object.assign({ button: 0, screenX: 0, screenY: 0, preventDefault() {}, stopPropagation() {},
    target: { closest() { return null; } } }, o);
}

console.log('sprite pet drag (item 5, JS half) behavioral tests:');

check('drag: avatar mousedown → mousemove → movePetWindow with incremental deltas', () => {
  els['pet-avatar']._listeners.mousedown[0](fakeEvent({ screenX: 100, screenY: 100 }));
  winListeners.mousemove[0](fakeEvent({ screenX: 112, screenY: 95 })); // +12,-5
  winListeners.mousemove[0](fakeEvent({ screenX: 120, screenY: 90 })); // +8,-5 (incremental)
  assert.deepStrictEqual(moveCalls, [[12, -5], [8, -5]], 'deltas must be incremental per move');
});

check('mouseup ends drag: subsequent mousemove does NOT call movePetWindow', () => {
  winListeners.mouseup[0](fakeEvent({}));
  const before = moveCalls.length;
  winListeners.mousemove[0](fakeEvent({ screenX: 200, screenY: 200 }));
  assert.strictEqual(moveCalls.length, before, 'mousemove after mouseup must be ignored');
});

check('mousedown on bubble does NOT start a drag', () => {
  els['pet-avatar']._listeners.mousedown[0](fakeEvent({
    screenX: 50, screenY: 50,
    target: { closest(sel) { return sel === '#pet-bubble' ? {} : null; } },
  }));
  winListeners.mousemove[0](fakeEvent({ screenX: 90, screenY: 90 }));
  assert.ok(moveCalls.every(c => c[0] !== 40 && c[1] !== 40), 'bubble-originated drag must not move window');
});

if (failures) { console.error('\n' + failures + ' check(s) FAILED'); process.exit(1); }
console.log('\nall pet drag checks passed');
