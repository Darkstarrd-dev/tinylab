// web/pg-thinking-stream.test.js
// Contract test for the streaming reasoning pipeline:
//   - think-tag routing must survive across stream flushes (an open block keeps
//     routing chunks to reasoning until the closing tag; previously the
//     thinking bubble froze on its first flush and the reasoning text leaked
//     into the answer bubble)
//   - a tag split across two chunks must not leak into the content
//   - the streaming thinking spinner must not restart its CSS animation on
//     every re-render (phase is rebased from reasoningStartedAt)
//
// Run:  node web/pg-thinking-stream.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const OPEN = LT + 'think' + GT;
const CLOSE = LT + '/think' + GT;

let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log('  ok  ' + name);
  }).catch((err) => {
    failures++;
    console.error('  FAIL ' + name + ': ' + (err && (err.stack || err.message || err)));
  });
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeEnv() {
  const elements = {};
  function makeEl(id) {
    const el = {
      id: id,
      innerHTML: '',
      value: '',
      textContent: '',
      className: '',
      style: {},
      children: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild() {},
      addEventListener() {},
      setAttribute() {},
      getAttribute() { return null; },
      focus() {},
      remove() {},
      querySelector(sel) {
        if (!el.children[sel]) el.children[sel] = makeEl(id + ' ' + sel);
        return el.children[sel];
      },
      querySelectorAll() { return []; },
    };
    return el;
  }
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    Date, Math, Promise, JSON, Object, Array, String, Number, Error, RegExp, Set, Map, isNaN, parseInt, parseFloat,
    document: {
      documentElement: { getAttribute: () => 'en' },
      getElementById(id) {
        if (!elements[id]) elements[id] = makeEl(id);
        return elements[id];
      },
      createElement: () => makeEl('created'),
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

  // Render/UI side effects the flush path calls into but this test does not
  // exercise (bubble meta, debug panel, auto scroll, toolbar).
  sandbox.toast = () => {};
  sandbox.t = (k) => k;
  sandbox.pgRenderMsgMeta = () => {};
  sandbox.pgRenderDebug = () => {};
  sandbox.pgScrollBottom = () => {};
  sandbox.pgHighlight = () => {};
  sandbox.pgPostProcessCode = () => {};
  sandbox.pgUpdateInputBar = () => {};

  sandbox.pgState = {
    mode: 'normal', splitCount: 1, activeWin: 0, windows: [], models: [],
    autoChat: { isRunning: false }, search: {}, searchHistory: [], comfy: {},
  };
  sandbox.elements = elements;
  return sandbox;
}

// streamChat drives chunks through the real chunk → flush → render pipeline
// (pgApplyChunk schedules pgFlushRender exactly like the SSE pump does) and
// waits for the 50 ms render timer to land.
async function streamChat(env, parts) {
  const w = env.makeWin();
  env.pgState.windows = [w];
  w.streaming = true;
  w.messages = [{ role: 'assistant', content: '', reasoning: '', status: 'loading' }];
  for (const p of parts) {
    env.pgApplyChunk(0, { choices: [{ index: 0, delta: { content: p } }] }, 0);
    env.pgFlushRender(0, 0);
    await wait(70);
  }
  return w;
}

async function runAll() {
  console.log('playground streaming reasoning contract');

  // ---------------- think-tag routing ----------------
  await check('think block: reasoning keeps streaming after the opening tag is consumed', async () => {
    const env = makeEnv();
    const w = await streamChat(env, [OPEN + 'first ', 'second ', 'third']);
    const msg = w.messages[0];
    assert.strictEqual(msg.content, '', 'no content before the block closes');
    assert.strictEqual(msg.reasoning, 'first second third');
    assert.strictEqual(w.thinkingBlockOpen, true, 'block state must stay open between flushes');
  });

  await check('think block: closing tag ends reasoning, answer goes to content', async () => {
    const env = makeEnv();
    const w = await streamChat(env, [OPEN + 'reasoning ', 'more', CLOSE, 'the answer']);
    const msg = w.messages[0];
    assert.strictEqual(msg.reasoning, 'reasoning more');
    assert.strictEqual(msg.content, 'the answer');
    assert.strictEqual(w.thinkingBlockOpen, false);
  });

  await check('think block: multiple blocks each route to reasoning', async () => {
    const env = makeEnv();
    const w = await streamChat(env, [OPEN + 'a' + CLOSE, 'mid', OPEN + 'b' + CLOSE, 'end']);
    const msg = w.messages[0];
    assert.strictEqual(msg.reasoning, 'ab', 'blocks streamed in separate flushes concatenate');
    assert.strictEqual(msg.content, 'midend');
  });

  await check('think block: blocks inside one buffer keep their separator', () => {
    const env = makeEnv();
    const w = { thinkingBlockOpen: false };
    const split = env.pgSplitStreamReasoning(OPEN + 'a' + CLOSE + 'mid' + OPEN + 'b' + CLOSE, w);
    assert.strictEqual(split.reasoning, 'a\nb');
    assert.strictEqual(split.content, 'mid');
    assert.strictEqual(w.thinkingBlockOpen, false);
  });

  await check('answer text before a block is never re-classified as reasoning', async () => {
    const env = makeEnv();
    const w = await streamChat(env, ['preamble ', OPEN + 'think1 ', 'think2', CLOSE, ' answer']);
    const msg = w.messages[0];
    assert.strictEqual(msg.reasoning, 'think1 think2');
    assert.strictEqual(msg.content, 'preamble  answer');
  });

  await check('tag split across chunks never leaks into content', async () => {
    const env = makeEnv();
    const w = await streamChat(env, ['answer ', LT + 'thi', 'nk' + GT + 'reasoning', CLOSE + ' tail']);
    const msg = w.messages[0];
    assert.strictEqual(msg.reasoning, 'reasoning');
    assert.strictEqual(msg.content, 'answer  tail');
  });

  await check('plain reasoning_content streams keep routing to reasoning', async () => {
    const env = makeEnv();
    const w = env.makeWin();
    env.pgState.windows = [w];
    w.streaming = true;
    w.messages = [{ role: 'assistant', content: '', reasoning: '', status: 'loading' }];
    for (const p of ['r1 ', 'r2 ', 'r3']) {
      env.pgApplyChunk(0, { choices: [{ index: 0, delta: { reasoning_content: p } }] }, 0);
      env.pgFlushRender(0, 0);
      await wait(70);
    }
    assert.strictEqual(w.messages[0].reasoning, 'r1 r2 r3');
    assert.strictEqual(w.messages[0].content, '');
  });

  await check('finish drains a still-open block into reasoning', async () => {
    const env = makeEnv();
    const w = await streamChat(env, [OPEN + 'unclosed reasoning']);
    env.pgFinish(0, 0);
    const msg = w.messages[0];
    assert.strictEqual(msg.reasoning, 'unclosed reasoning');
    assert.strictEqual(msg.content, '');
    assert.strictEqual(msg.status, 'complete');
    assert.strictEqual(w.thinkingBlockOpen, false, 'block state resets when the request ends');
  });

  await check('a new send clears the block state', async () => {
    const env = makeEnv();
    const w = await streamChat(env, [OPEN + 'left open']);
    assert.strictEqual(w.thinkingBlockOpen, true);
    env.pgStream = () => {};         // the request itself is out of scope here
    env.pgSendNonStream = () => {};
    w.config.model = 'fake/model';
    env.pgSend(0, 0);
    assert.strictEqual(w.thinkingBlockOpen, false);
  });

  // ---------------- spinner animation ----------------
  await check('spinner: rotation phase is rebased on every re-render', () => {
    const env = makeEnv();
    const w = env.makeWin();
    env.pgState.windows = [w];
    const msg = {
      role: 'assistant', content: '', reasoning: 'thinking hard',
      status: 'streaming', reasoningStartedAt: Date.now() - 1234,
    };
    w.messages = [msg];
    env.pgRenderBubble(0, 0);
    const spinner = env.elements['pg-bubble-0-0'].children['.pg-thinking-spinner'];
    assert.ok(spinner, 'spinner element rendered for a streaming reasoning bubble');
    const delay = spinner.style.animationDelay;
    assert.ok(/^-\d+ms$/.test(delay), 'spinner must carry a negative animation-delay, got ' + delay);
    const got = -parseInt(delay, 10);
    const expected = (Date.now() - msg.reasoningStartedAt) % env.PG_SPIN_PERIOD_MS;
    assert.ok(Math.abs(got - expected) < 40, 'phase off by more than 40ms: got ' + got + ' want ~' + expected);
    assert.ok(got >= 0 && got < env.PG_SPIN_PERIOD_MS);
  });

  await check('spinner: no rebase once reasoning completed', () => {
    const env = makeEnv();
    const w = env.makeWin();
    env.pgState.windows = [w];
    const msg = {
      role: 'assistant', content: 'done', reasoning: 'thought',
      status: 'complete', reasoningStartedAt: Date.now() - 5000, reasoningCompletedAt: Date.now() - 1000,
    };
    w.messages = [msg];
    env.pgRenderBubble(0, 0);
    const spinner = env.elements['pg-bubble-0-0'].children['.pg-thinking-spinner'];
    assert.ok(spinner, 'spinner stub is queried by pgRenderBubble');
    assert.strictEqual(spinner.style.animationDelay, undefined, 'completed reasoning must not rebase');
  });

  if (failures) {
    console.error('\n' + failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('\nall checks passed');
}

runAll();
