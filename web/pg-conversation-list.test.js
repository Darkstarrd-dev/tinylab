// web/pg-conversation-list.test.js
// Contract test for the Playground left panel (conversation list) and the
// per-response usage rows on assistant bubbles.
//
// Covers:
//   - conversation titles (20 CJK chars / 10 words)
//   - row creation, active marking, snapshot switching and its guards
//   - Time + Title table shape (Latency/Tokens columns gone)
//   - usage-entry cache merge semantics (live SSE fields never regress)
//   - ttft/gt/in/res/ct/spd rows + request-detail button on the bubble
//   - pgT resolving pg* keys from PG_I18N (pgDurationSec regression)
//
// Run:  node web/pg-conversation-list.test.js

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

function makeEnv(lang) {
  const elements = {};
  function makeEl(id) {
    const el = {
      id: id,
      innerHTML: '',
      value: '',
      textContent: '',
      className: '',
      children: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild() {},
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
    Date, Math, Promise, JSON, Object, Array, String, Number, Error, RegExp, Set, Map, isNaN, parseInt, parseFloat,
    document: {
      documentElement: { getAttribute: () => lang || 'en' },
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
  const toasts = [];

  const files = [
    'web/static/core-util.js',
    'web/static/i18n.js',
    'web/playground/static-pg/playground/pg-core.js',
    'web/static/monitor/monitor_state.js',
    'web/playground/static-pg/playground/pg-ui-reqleft.js',
    'web/playground/static-pg/playground/pg-render.js',
  ];
  for (const f of files) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }
  // Host-side globals the playground falls back to (web/static/i18n.js `t`,
  // app.js `toast`). Defined after the module load so they survive the
  // playground's own function declarations.
  sandbox.toast = (m) => { toasts.push(m); };
  sandbox.t = (k) => ({
    thTTFT: 'TTFT', thGT: 'GT', thIn: 'IN', thRES: 'RES', thCT: 'CT', thSpd: 'Spd',
    ttTTFT: 'Time To First Token', ttGT: 'Generation Time', thInput: 'Input',
    ttRES: 'Reasoning Output', ttCT: 'Content Output', thAvgSpeed: 'Avg Speed',
  }[k] || k);

  // Minimal state surface the left panel and bubble renderers touch.
  sandbox.pgState = { mode: 'normal', windows: [], activeWin: 0 };
  sandbox.pgWinAt = (i) => sandbox.pgState.windows[i];
  sandbox.pgIsGenerating = () => false;
  sandbox.toasts = toasts;
  sandbox.pgRenderMessages = () => {};
  sandbox.pgRenderDebug = () => {};
  sandbox.elements = elements;
  return sandbox;
}

function newChat(env, text, msgs) {
  const w = { config: {}, messages: msgs || [] };
  env.pgState.windows = [w];
  const row = env.pgConvCreate(env.pgConvTitleFromText(text), w.messages.slice());
  return { w, row };
}

async function runAll() {
  console.log('playground conversation list & usage rows contract');

  await check('title: first 20 CJK characters, then ellipsis', () => {
    const env = makeEnv();
    const text = '这是一段很长的中文提示词用来测试标题截断行为是否按照二十个字符处理';
    const title = env.pgConvTitleFromText(text);
    assert.strictEqual(Array.from(title.replace('…', '')).length, 20);
    assert.ok(title.endsWith('…'));
    assert.strictEqual(env.pgConvTitleFromText('短标题'), '短标题');
  });

  await check('title: first 10 words for non-CJK text', () => {
    const env = makeEnv();
    const title = env.pgConvTitleFromText('one two three four five six seven eight nine ten eleven twelve');
    assert.strictEqual(title, 'one two three four five six seven eight nine ten…');
    assert.strictEqual(env.pgConvTitleFromText('  spaced   out  '), 'spaced out');
    assert.strictEqual(env.pgConvTitleFromText(''), '—');
  });

  await check('rows: chat rows become active, image rows do not', () => {
    const env = makeEnv();
    const { row } = newChat(env, 'hello world', [{ role: 'user', content: 'hello world' }]);
    assert.strictEqual(env.pgActiveConvId, row.id);
    const img = env.pgConvCreate('a cat', null);
    assert.strictEqual(env.pgActiveConvId, row.id, 'image row must not steal the active conversation');
    assert.strictEqual(img.messages, null);
  });

  await check('list renders Time + Title only', () => {
    const env = makeEnv();
    newChat(env, 'first conversation', [{ role: 'user', content: 'first conversation' }]);
    newChat(env, 'second conversation', [{ role: 'user', content: 'second conversation' }]);
    const html = env.elements['pg-req-left-content'].innerHTML;
    assert.ok(html.indexOf('>Time<') >= 0, 'Time header missing');
    assert.ok(html.indexOf('>Title<') >= 0, 'Title header missing');
    assert.ok(html.indexOf('Latency') < 0 && html.indexOf('Tokens') < 0, 'removed columns still rendered');
    assert.ok(html.indexOf('second conversation') < html.indexOf('first conversation'), 'newest row first');
    assert.strictEqual((html.match(/pg-req-row/g) || []).length >= 2, true);
  });

  await check('click switches conversation to the row snapshot', () => {
    const env = makeEnv();
    const first = newChat(env, 'first', [{ role: 'user', content: 'first' }]);
    const live = first.w.messages;
    const second = newChat(env, 'second', [
      { role: 'user', content: 'second' },
      { role: 'assistant', content: '', status: 'loading' },
    ]);
    // The stream fills the placeholder in place, which is how the row's
    // snapshot ends up holding the finished reply.
    second.w.messages[1].content = 'reply';
    second.w.messages[1].status = 'complete';
    env.pgSwitchConversation(first.row.id);
    const w = env.pgWinAt(0);
    assert.deepStrictEqual(w.messages.map((m) => m.content), ['first']);
    assert.notStrictEqual(w.messages, live, 'live list must be a copy so the snapshot stays frozen');
    assert.strictEqual(env.pgActiveConvId, first.row.id);
    env.pgSwitchConversation(second.row.id);
    assert.deepStrictEqual(env.pgWinAt(0).messages.map((m) => m.content), ['second', 'reply']);
  });

  await check('switch guards: no conversation and in-flight generation', () => {
    const env = makeEnv();
    const img = env.pgConvCreate('image prompt', null);
    env.pgSwitchConversation(img.id);
    assert.strictEqual(env.toasts.length, 1);
    assert.strictEqual(env.toasts[0], env.pgT('pgConvUnavailable'));

    const { row } = newChat(env, 'chat', [{ role: 'user', content: 'chat' }]);
    env.pgIsGenerating = () => true;
    env.pgSwitchConversation(row.id);
    assert.strictEqual(env.toasts[1], env.pgT('pgGenSwitchLock'));
  });

  await check('entry cache: REST snapshots never regress live SSE fields', () => {
    const env = makeEnv();
    env.pgMergeEntry({
      id: 'e1', source: 'playground', status: 'processing',
      ttftMs: 420, inputTokens: 100, outputTokens: 50, reasoningTokens: 30, contentTokens: 20,
      firstContentMs: 1700000000000,
    });
    env.pgMergeEntry({
      id: 'e1', source: 'playground', status: 'processing',
      ttftMs: 0, inputTokens: 10, outputTokens: 5, reasoningTokens: 0, contentTokens: 0,
    });
    const e = env.pgEntryById('e1');
    assert.strictEqual(e.ttftMs, 420);
    assert.strictEqual(e.inputTokens, 100);
    assert.strictEqual(e.outputTokens, 50);
    assert.strictEqual(e.reasoningTokens, 30);
    assert.strictEqual(e.contentTokens, 20);
    assert.strictEqual(e.firstContentMs, 1700000000000);
    // Terminal entry replaces the live one wholesale.
    env.pgMergeEntry({ id: 'e1', source: 'playground', status: 'success', ttftMs: 400, latencyMs: 5000 });
    assert.strictEqual(env.pgEntryById('e1').status, 'success');
  });

  await check('entry cache: request-tokens events lift live counters', () => {
    const env = makeEnv();
    env.pgMergeEntry({ id: 'e2', source: 'playground', status: 'processing', ttftMs: 100 });
    env.pgMergeTokenUpdate('e2', { inputTokens: 12, outputTokens: 40, contentTokens: 40, firstContentMs: 1700000000123 });
    const e = env.pgEntryById('e2');
    assert.strictEqual(e.inputTokens, 12);
    assert.strictEqual(e.outputTokens, 40);
    assert.strictEqual(e.contentTokens, 40);
    assert.strictEqual(e.firstContentMs, 1700000000123);
    env.pgMergeTokenUpdate('e2', { reasoningTokens: -1 });
    assert.strictEqual(env.pgEntryById('e2').reasoningTokens, -1);
  });

  await check('bubble metrics: two rows with the monitor columns', () => {
    const env = makeEnv();
    const entry = {
      id: 'e3', status: 'success', timestamp: '2026-09-22T10:00:00Z',
      ttftMs: 4200, latencyMs: 12400, inputTokens: 1234,
      reasoningTokens: -1, contentTokens: 300, outputTokens: 300,
    };
    const html = env.pgMetricsBlockHTML(entry);
    for (const label of ['TTFT', 'GT', 'IN', 'RES', 'CT', 'Spd']) {
      assert.ok(html.indexOf('>' + label + '<') >= 0, label + ' label missing');
    }
    assert.ok(html.indexOf('>04.2<') >= 0, 'TTFT value missing');
    // latencyMs - ttftMs = 8200ms, rendered by the shared formatGenTime.
    assert.ok(html.indexOf('>00:08.1<') >= 0, 'GT value (latency - ttft) missing');
    assert.ok(html.indexOf('>1234<') >= 0, 'IN value missing');
    assert.ok(html.indexOf('>enc<') >= 0, 'RES sentinel missing');
    assert.ok(html.indexOf('>300<') >= 0, 'CT value missing');
    assert.ok(/tok\/s</.test(html), 'SPD value missing');
    assert.strictEqual((html.match(/pg-msg-metrics-row/g) || []).length, 2);
  });

  await check('bubble meta: detail button + metrics only for request-backed replies', () => {
    const env = makeEnv();
    const msg = { role: 'assistant', content: 'hi', status: 'complete', reqId: 'e4' };
    env.pgMergeEntry({ id: 'e4', source: 'playground', status: 'success', timestamp: '2026-09-22T10:00:00Z', ttftMs: 900, latencyMs: 3000, inputTokens: 5, contentTokens: 9 });
    env.pgState.windows = [{ messages: [msg] }];
    const html = env.pgMsgMetaInnerHTML(0, 0, msg);
    assert.ok(html.indexOf('pgShowRequestInfo(0,0)') >= 0, 'detail button missing');
    assert.ok(html.indexOf(env.PG_ICON_INFO) >= 0, 'detail button is not the SVG icon');
    assert.ok(html.indexOf('pg-msg-metrics') >= 0, 'metric rows missing');
    assert.ok(html.indexOf(env.pgT('pgReqDetailTip')) >= 0, 'detail tooltip missing');

    const plain = { role: 'assistant', content: 'hi', status: 'complete' };
    const plainHtml = env.pgMsgMetaInnerHTML(0, 0, plain);
    assert.ok(plainHtml.indexOf('pg-msg-metrics') < 0 && plainHtml.indexOf('pgShowRequestInfo') < 0);
  });

  await check('bubble meta: pgRenderMsgMeta writes the meta element', () => {
    const env = makeEnv();
    const msg = { role: 'assistant', content: 'hi', status: 'complete', reqId: 'e5' };
    env.pgState.windows = [{ messages: [msg] }];
    env.pgMergeEntry({ id: 'e5', source: 'playground', status: 'processing', timestamp: new Date().toISOString(), ttftMs: 300, inputTokens: 7 });
    env.pgRenderMsgMeta(0, 0);
    const meta = env.document.getElementById('pg-msg-0-0').querySelector('.pg-msg-meta');
    assert.ok(meta.innerHTML.indexOf('pg-msg-metrics') >= 0);
    assert.ok(meta.innerHTML.indexOf('pgShowRequestInfo(0,0)') >= 0);
  });

  await check('i18n: pg* keys resolve through PG_I18N (pgDurationSec/pgMetaResponse)', () => {
    const en = makeEnv('en');
    assert.strictEqual(en.pgT('pgDurationSec', ['1.23']), '1.23s');
    assert.strictEqual(en.pgT('pgDurationMs', [5]), '5ms');
    assert.strictEqual(en.pgT('pgMetaResponse', ['1.23s']), 'Response 1.23s');
    assert.strictEqual(en.pgFormatDuration(1230), '1.23s');
    assert.strictEqual(en.pgFormatDuration(5), '5ms');
    const cn = makeEnv('cn');
    assert.strictEqual(cn.pgT('pgDurationSec', ['1.23']), '1.23 秒');
    assert.strictEqual(cn.pgT('pgMetaResponse', ['1.23 秒']), '响应 1.23 秒');
    assert.strictEqual(cn.pgT('pgReqColTitle'), '标题');
  });

  await check('i18n: shared app keys still fall through to the host dictionary', () => {
    const env = makeEnv();
    env.t = (k) => (k === 'thTTFT' ? 'TTFT-host' : k);
    // G1 merged pg* keys into L; pgT reads window.L first, so a shared key
    // resolves from the same dictionary as t() — no separate PG dict anymore.
    assert.strictEqual(env.pgT('thTTFT'), env.L.en.thTTFT);
    // A key that exists in NEITHER dictionary falls back to the t() stub.
    assert.strictEqual(env.pgT('noSuchKeyXyz'), 'noSuchKeyXyz');
    assert.strictEqual(env.pgT('pgDurationSec', ['2']), '2s', 'pg keys must not reach the host dictionary');
  });

  if (failures) {
    console.error('\n' + failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('\nall checks passed');
}

runAll();
