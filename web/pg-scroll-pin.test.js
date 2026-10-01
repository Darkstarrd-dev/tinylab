// web/pg-scroll-pin.test.js
// Contract test for the playground's streaming auto-scroll:
//   - the message list follows the newest output only while the reader is at
//     the end (a scroll up must survive the next flush; previously every flush
//     forced the view back to the bottom, which made reading back impossible)
//   - scrolling back to the end resumes following; a new message re-pins
//   - the reasoning body keeps the reader's position across the render that
//     recreates it (the bubble HTML is replaced on every flush)
//
// Run:  node web/pg-scroll-pin.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log('  ok  ' + name);
  }).catch((err) => {
    failures++;
    console.error('  FAIL ' + name + ': ' + (err && (err.stack || err.message || err)));
  });
}

// A scroll container that behaves like the real ones: scrollTop clamps to the
// scrollable range and writing it (as a user scroll or a programmatic one does)
// notifies the listeners the code under test registers.
function makeScrollBox(clientHeight, scrollHeight) {
  const listeners = { scroll: [] };
  let top = 0;
  const el = {
    clientHeight: clientHeight,
    scrollHeight: scrollHeight,
    __pgPinBound: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    scrollTo(top) { this.scrollTop = top; },
    get scrollTop() { return top; },
    set scrollTop(v) {
      const clamped = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight));
      const changed = clamped !== top;
      top = clamped;
      if (changed) listeners.scroll.forEach((fn) => fn({ target: el }));
    },
  };
  return el;
}

function makeThinkingBody(scrollHeight, collapsed) {
  const body = makeScrollBox(100, scrollHeight);
  body.parentElement = {
    classList: { contains: (c) => c === 'collapsed' && !!collapsed },
  };
  return body;
}

// Bubble element whose innerHTML swap recreates the thinking body, exactly like
// the real one does on every stream flush.
function makeBubble(body) {
  let current = body;
  return {
    __pgPinBound: false,
    get innerHTML() { return ''; },
    set innerHTML(html) { current = /pg-thinking-body/.test(html) ? makeThinkingBody(html.length, false) : null; },
    get body() { return current; },
    querySelector(sel) {
      if (sel === '.pg-thinking-body') return current;
      return null;
    },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function makeEnv() {
  const boxes = {};   // id -> element the code under test looks up
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    Date, Math, Promise, JSON, Object, Array, String, Number, Error, RegExp, Set, Map, isNaN, parseInt, parseFloat,
    document: {
      documentElement: { getAttribute: () => 'en' },
      getElementById: (id) => boxes[id] || null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      body: { appendChild() {} },
      hidden: false,
      visibilityState: 'visible',
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.PG_HOST = null;

  const files = [
    'web/static/core-util.js',
    'web/static/i18n.js',
    'web/playground/static-pg/playground/pg-core.js',
    'web/playground/static-pg/playground/pg-state.js',
    'web/playground/static-pg/playground/pg-markdown.js',
    'web/playground/static-pg/playground/pg-request.js',
    'web/playground/static-pg/playground/pg-stream.js',
    'web/playground/static-pg/playground/pg-render.js',
  ];
  for (const f of files) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }

  // Side effects the render path calls into but this test does not exercise.
  sandbox.t = (k) => k;
  sandbox.pgRenderMsgMeta = () => {};
  sandbox.pgRenderDebug = () => {};
  sandbox.pgHighlight = () => {};
  sandbox.pgPostProcessCode = () => {};
  sandbox.pgUpdateInputBar = () => {};

  const w = { messages: [], config: {} };
  sandbox.pgState = { windows: [w], mode: 'normal', activeWin: 0 };
  sandbox.pgWinAt = (i) => (sandbox.pgState.windows[i] || null);

  return { sandbox, boxes, w };
}

async function runAll() {
  console.log('playground streaming auto-scroll contract');

  await check('message list follows the output while the reader is at the end', () => {
    const { sandbox, boxes, w } = makeEnv();
    const box = makeScrollBox(300, 600);
    boxes['pg-messages-0'] = box;
    sandbox.pgScrollBottom(0);
    assert.strictEqual(box.scrollTop, 300, 'pinned list jumps to the last line');
    box.scrollHeight += 60;              // another line streamed in
    sandbox.pgScrollBottom(0);
    assert.strictEqual(box.scrollTop, 360, 'still following');
    assert.notStrictEqual(w.msgsPinned, false);
  });

  await check('a scroll up survives the next flushes', () => {
    const { sandbox, boxes } = makeEnv();
    const box = makeScrollBox(300, 600);
    boxes['pg-messages-0'] = box;
    sandbox.pgScrollBottom(0);
    box.scrollTop = 100;                 // reader scrolls back
    box.scrollHeight += 60;              // output keeps streaming
    sandbox.pgScrollBottom(0);
    sandbox.pgScrollBottom(0);
    assert.strictEqual(box.scrollTop, 100, 'view stays where the reader put it');
  });

  await check('returning to the end resumes following', () => {
    const { sandbox, boxes } = makeEnv();
    const box = makeScrollBox(300, 600);
    boxes['pg-messages-0'] = box;
    sandbox.pgScrollBottom(0);
    box.scrollTop = 100;
    box.scrollHeight += 60;
    sandbox.pgScrollBottom(0);
    assert.strictEqual(box.scrollTop, 100, 'precondition: not following');
    box.scrollTop = box.scrollHeight - box.clientHeight;
    box.scrollHeight += 40;
    sandbox.pgScrollBottom(0);
    assert.strictEqual(box.scrollTop, 400, 'following again');
  });

  await check('a new message re-pins a list the reader had scrolled up', () => {
    const { sandbox, boxes } = makeEnv();
    const box = makeScrollBox(300, 600);
    boxes['pg-messages-0'] = box;
    sandbox.pgScrollBottom(0);
    box.scrollTop = 100;
    sandbox.pgScrollBottom(0);           // unpinned
    sandbox.pgScrollBottom(0, true);     // send / conversation switch
    assert.strictEqual(box.scrollTop, 300, 'forced back to the newest message');
  });

  await check('reasoning body follows the end while the reader is pinned to it', () => {
    const { sandbox } = makeEnv();
    const body = makeThinkingBody(1000, false);
    const bub = makeBubble(body);
    const msg = {};
    const prev = sandbox.pgCaptureThinkingScroll(bub, msg);
    // Field-wise: objects built inside the VM context have a different prototype.
    assert.strictEqual(prev.top, 0);
    assert.strictEqual(prev.pinned, true);
    const restored = makeThinkingBody(1200, false);
    const bub2 = makeBubble(restored);
    sandbox.pgRestoreThinkingScroll(bub2, msg, prev);
    assert.strictEqual(restored.scrollTop, 1100, 'follows the newest reasoning text');
  });

  await check('reasoning body keeps the reader position across a re-render', () => {
    const { sandbox } = makeEnv();
    const body = makeThinkingBody(1000, false);
    const msg = {};
    // First render binds the scroll listener.
    sandbox.pgRestoreThinkingScroll(makeBubble(body), msg, null);
    body.scrollTop = 300;                // reader scrolls back inside the panel
    assert.strictEqual(msg.thinkingPinned, false, 'scrolling away unpins');
    const prev = sandbox.pgCaptureThinkingScroll(makeBubble(body), msg);
    assert.strictEqual(prev.top, 300);
    assert.strictEqual(prev.pinned, false);
    const restored = makeThinkingBody(1400, false);
    sandbox.pgRestoreThinkingScroll(makeBubble(restored), msg, prev);
    assert.strictEqual(restored.scrollTop, 300, 'position survives the recreated element');
  });

  await check('collapsed reasoning panel is left alone', () => {
    const { sandbox } = makeEnv();
    const msg = {};
    const prev = { top: 300, pinned: true };
    const restored = makeThinkingBody(1400, true);
    sandbox.pgRestoreThinkingScroll(makeBubble(restored), msg, prev);
    assert.strictEqual(restored.scrollTop, 0, 'no scrolling inside a collapsed panel');
  });

  await check('pgRenderBubble restores the reasoning scroll after its innerHTML swap', () => {
    const { sandbox, boxes, w } = makeEnv();
    const body = makeThinkingBody(1000, false);
    const bub = makeBubble(body);
    w.messages = [{ role: 'assistant', content: 'answer', reasoning: 'thinking…', status: 'streaming' }];
    boxes['pg-bubble-0-0'] = bub;
    sandbox.pgRenderBubble(0, 0);         // binds the pin, follows the end
    assert.strictEqual(bub.body.scrollTop, bub.body.scrollHeight - bub.body.clientHeight);
    bub.body.scrollTop = 250;             // reader scrolls back
    sandbox.pgRenderBubble(0, 0);
    assert.strictEqual(bub.body.scrollTop, 250, 're-render keeps the reading position');
  });

  console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

runAll();
