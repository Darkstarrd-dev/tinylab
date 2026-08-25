// web/sprite-pet-drag.test.js
// Zero-dependency Node behavioral test for the L3 desktop pet drag
// (sprite-pet.js's mouse-drag-to-move). Loads the REAL web/static/sprite-pet.js
// in a VM sandbox with a minimal DOM stub, then drives the avatar's mousedown +
// window mousemove/mouseup — proving the drag posts the host protocol messages
// (dragstart/dragmove/dragend via chrome.webview.postMessage; the host tracks
// the physical cursor delta itself, so moves carry no coordinates), that
// mousemove is throttled, that mouseup ends the drag, and that a mousedown on
// the bubble does NOT drag.
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
  for (const fn of ['dragstart', 'dragmove', 'dragend', 'initPetSprite', 'sendPetIntent', 'toggleBubble', '/api/assistant/events', 'setPetScale', 'updateSide']) {
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
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
  };
}
const els = {
  'pet-avatar': makeEl(), 'pet-bubble': makeEl(), 'pet-input': makeEl(),
  'pet-bubble-msg': makeEl(), 'pet-area': makeEl(), 'pet-ctxmenu': makeEl(),
};
const winListeners = {};
const posted = [];
const document = {
  getElementById(id) { return els[id] || null; },
  querySelector(sel) {
    if (sel === '.pet-input-row') return els['pet-input-row'] || null;
    return null;
  },
  querySelectorAll() { return []; },
  body: makeEl(),
  addEventListener() {},
};
els['pet-input-row'] = makeEl();
const window = {
  innerWidth: 560, innerHeight: 300, screenX: 100, screenY: 100,
  addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
  removeEventListener() {},
  chrome: { webview: { postMessage(msg) { posted.push(JSON.parse(msg)); } } },
  EventSource: class { constructor() {} addEventListener() {} close() {} },
  fetch: () => Promise.reject(new Error('no fetch in test')),
  setTimeout() {}, setInterval() {}, clearInterval() {},
  requestAnimationFrame(fn) { if (fn) fn(); },
};
window.document = document; window.window = window;

const sandbox = {
  document, window,
  getComputedStyle() { return { display: 'flex', visibility: 'visible' }; },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  screen: { availLeft: 0, availWidth: 1920, width: 1920 },
  localStorage: window,
  setTimeout: window.setTimeout, setInterval: window.setInterval, clearInterval: window.clearInterval,
  requestAnimationFrame: window.requestAnimationFrame,
  EventSource: window.EventSource, fetch: window.fetch,
  console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(JS_PATH, 'utf8'), sandbox, { filename: 'sprite-pet.js' });

function fakeEvent(o) {
  return Object.assign({ button: 0, screenX: 0, screenY: 0, preventDefault() {}, stopPropagation() {},
    target: { closest() { return null; } } }, o);
}

console.log('sprite pet drag (item 5, JS half) behavioral tests:');

function dragMessages() { return posted.filter(m => m.type === 'dragstart' || m.type === 'dragmove' || m.type === 'dragend'); }

check('drag: avatar mousedown → dragstart, throttled mousemove → dragmove (no coords)', () => {
  els['pet-avatar']._listeners.mousedown[0](fakeEvent({ screenX: 100, screenY: 100 }));
  winListeners.mousemove[0](fakeEvent({ screenX: 100, screenY: 101 })); // <2px: throttled
  winListeners.mousemove[0](fakeEvent({ screenX: 112, screenY: 95 })); // >=2px: posted
  winListeners.mousemove[0](fakeEvent({ screenX: 113, screenY: 96 })); // <2px: throttled
  const msgs = dragMessages();
  assert.deepStrictEqual(msgs.map(m => m.type), ['dragstart', 'dragmove'], 'throttle + protocol order');
  assert.ok(!('dx' in msgs[1]), 'host tracks cursor delta itself; moves carry no coordinates');
});

check('mouseup ends drag: dragend posted, subsequent mousemove ignored', () => {
  winListeners.mouseup[0](fakeEvent({}));
  const before = dragMessages().length;
  winListeners.mousemove[0](fakeEvent({ screenX: 200, screenY: 200 }));
  assert.strictEqual(dragMessages().length, before, 'mousemove after mouseup must be ignored');
  assert.strictEqual(dragMessages()[dragMessages().length - 1].type, 'dragend');
});

check('mousedown on bubble does NOT start a drag', () => {
  els['pet-avatar']._listeners.mousedown[0](fakeEvent({
    screenX: 50, screenY: 50,
    target: { closest(sel) { return sel === '#pet-bubble' ? {} : null; } },
  }));
  winListeners.mousemove[0](fakeEvent({ screenX: 90, screenY: 90 }));
  assert.ok(dragMessages().every(m => m.type !== 'dragstart' || m.screenX !== 50),
    'bubble-originated drag must not move window');
});

if (failures) { console.error('\n' + failures + ' check(s) FAILED'); process.exit(1); }
console.log('\nall pet drag checks passed');
