// web/sprite-pet-drag.test.js
// Zero-dependency Node behavioral test for the L3 desktop pet drag
// (sprite-pet.html's mouse-drag-to-move). Extracts the REAL inline script
// from web/static/sprite-pet.html and runs it in a VM sandbox with a minimal
// DOM stub, then drives the avatar's mousedown + window mousemove/mouseup —
// proving the drag calls the Go-bound window.movePetWindow with correct
// deltas, that deltas are incremental (startX/Y updated each move), that
// mouseup ends the drag, and that a mousedown on the bubble does NOT drag.
// The transparency itself is Windows-native Win32 (untestable without a
// tray+webview runtime + display); this covers the JS drag half of item 5.
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

// Extract the inline <script> from the real pet page.
const html = fs.readFileSync(path.join(__dirname, 'static/sprite-pet.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('no <script> found in sprite-pet.html'); process.exit(1); }
const SRC = m[1];

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
vm.runInContext(SRC, sandbox, { filename: 'sprite-pet.html.js' });

function fakeEvent(o) {
  return Object.assign({ button: 0, screenX: 0, screenY: 0, preventDefault() {}, stopPropagation() {},
    target: { closest() { return null; } } }, o);
}

console.log('sprite pet drag (item 5, JS half) behavioral tests:');

check('drag: avatar mousedown → mousemove → movePetWindow with incremental deltas', () => {
  moveCalls.length = 0;
  const avatar = els['pet-avatar'];
  avatar._listeners.mousedown[0](fakeEvent({ screenX: 100, screenY: 100 }));
  winListeners.mousemove[0](fakeEvent({ screenX: 150, screenY: 120 })); // dx=50, dy=20
  winListeners.mousemove[0](fakeEvent({ screenX: 180, screenY: 120 })); // dx=30, dy=0 (startX updated)
  assert.deepStrictEqual(moveCalls, [[50, 20], [30, 0]], 'movePetWindow called with incremental deltas');
});

check('mouseup ends drag: subsequent mousemove does NOT call movePetWindow', () => {
  moveCalls.length = 0;
  winListeners.mouseup[0](fakeEvent({}));
  winListeners.mousemove[0](fakeEvent({ screenX: 300, screenY: 300 }));
  assert.strictEqual(moveCalls.length, 0, 'no movePetWindow after mouseup');
});

check('mousedown on bubble does NOT start a drag', () => {
  moveCalls.length = 0;
  const avatar = els['pet-avatar'];
  // target.closest('#pet-bubble') returns truthy → handler returns early
  avatar._listeners.mousedown[0](fakeEvent({ screenX: 100, screenY: 100, target: { closest() { return els['pet-bubble']; } } }));
  winListeners.mousemove[0](fakeEvent({ screenX: 200, screenY: 200 }));
  assert.strictEqual(moveCalls.length, 0, 'no drag when mousedown originated on the bubble');
});

if (failures) { console.error('\n' + failures + ' check(s) FAILED'); process.exit(1); }
console.log('\nall pet drag checks passed');
