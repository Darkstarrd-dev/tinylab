// web/pg-presets.test.js
// Contract test for the Playground Normal-mode sidebar changes:
//   - Max Tokens: 8192 effective default, always displayed (even while the
//     parameter toggle is off), normalized back to the default when cleared
//   - Parameters: Top K / Min P rows + request-body wiring (top_k / min_p)
//   - Parameters / System Prompt presets (save / apply / delete / persistence)
//   - System Prompt box: read-only preview of the current prompt, click opens
//     the Editor V2 differ modal (same window as Text Review step-3 Prompt)
//   - Recent-requests row delete button
//
// Run:  node web/pg-presets.test.js

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

function makeEnv(lang, seedStorage) {
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
  const store = Object.assign({}, seedStorage);
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
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
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  sandbox.window = sandbox;
  sandbox.PG_HOST = null;
  const toasts = [];

  const files = [
    'web/static/core-util.js',
    'web/static/i18n.js',
    'web/playground/static-pg/playground/pg-core.js',
    'web/playground/static-pg/playground/pg-state.js',
    'web/playground/static-pg/playground/pg-request.js',
    'web/playground/static-pg/playground/pg-ui-params.js',
    'web/playground/static-pg/playground/pg-ui.js',
    'web/playground/static-pg/playground/pg-modal.js',
    'web/playground/static-pg/playground/pg-presets.js',
    'web/playground/static-pg/playground/pg-ui-reqleft.js',
    'web/playground/static-pg/playground/pg-ui-events.js',
  ];
  for (const f of files) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }

  // Host-side globals the playground falls back to, defined after module load
  // so the playground's own declarations survive.
  sandbox.toast = (m) => { toasts.push(m); };
  sandbox.t = (k) => k;

  // Minimal state surface the sidebar + left panel touch.
  sandbox.pgState = {
    mode: 'normal',
    splitCount: 1,
    activeWin: 0,
    windows: [],
    models: [],
    imageBatch: { uiMode: 'idle' },
    autoChat: { enabled: false, iterations: 10, userName: 'User', delaySeconds: 0, director: {} },
    search: { maxResults: 5, apiKey: '' },
    searchHistory: [],
    activeSearchId: null,
    comfy: {},
  };
  sandbox.pgIsGenerating = () => false;
  sandbox.pgRenderMessages = () => {};
  sandbox.pgRenderDebug = () => {};
  sandbox.pgSchedulePreview = () => {};
  sandbox.pgRenderDebugContent = () => {};
  sandbox.toasts = toasts;
  sandbox.elements = elements;
  sandbox.storage = store;
  return sandbox;
}

// makeWinEnv returns an env with one live window plus the sidebar element.
function makeWinEnv(lang, seedStorage, cfgPatch) {
  const env = makeEnv(lang, seedStorage);
  const w = env.makeWin();
  Object.assign(w.config, cfgPatch || {});
  env.pgState.windows = [w];
  return { env, w };
}

function sidebarHtml(env) {
  env.pgRenderSidebar();
  return env.elements['pg-side'].innerHTML;
}

// valueBefore returns the last value="..." attribute rendered before `needle`.
function valueBefore(html, needle) {
  const idx = html.indexOf(needle);
  assert.ok(idx >= 0, needle + ' not found in sidebar');
  const matches = html.slice(0, idx).match(/value="[^"]*"/g) || [];
  assert.ok(matches.length, 'no value attribute before ' + needle);
  return matches[matches.length - 1];
}

async function runAll() {
  console.log('playground params / presets / request-row delete contract');

  // ---------------- Max Tokens ----------------
  await check('max tokens: default 8192, displayed while the toggle is off', () => {
    const { env } = makeWinEnv();
    assert.strictEqual(env.PG_DEFAULT_CFG.maxTokens, 8192);
    assert.strictEqual(env.PG_DEFAULT_PARAMS.maxTokens, false);
    const html = sidebarHtml(env);
    assert.strictEqual(valueBefore(html, "pgOnParam('maxTokens'"), 'value="8192"');
    // Toggle off => row dimmed, value still visible.
    assert.ok(/pg-param disabled"><button class="pg-toggle" onclick="pgToggleParam\('maxTokens'\)/.test(html));
  });

  await check('max tokens: cleared field falls back to the default', () => {
    const { env, w } = makeWinEnv();
    w.config.maxTokens = 4096;
    env.pgOnParam('maxTokens', 0);
    assert.strictEqual(w.config.maxTokens, 8192);
    env.pgOnParam('maxTokens', '');
    assert.strictEqual(w.config.maxTokens, 8192);
    env.pgOnParam('maxTokens', 2048);
    assert.strictEqual(w.config.maxTokens, 2048);
    // Re-render shows the stored value.
    assert.strictEqual(valueBefore(sidebarHtml(env), "pgOnParam('maxTokens'"), 'value="2048"');
  });

  await check('max tokens: persisted 0 migrates to the default on load', () => {
    const env = makeEnv('en', { 'tinylab.playground.cfg.v2': JSON.stringify({ maxTokens: 0, temperature: 0.5 }) });
    env.pgLoad();
    assert.strictEqual(env.pgState.windows[0].config.maxTokens, 8192);
    assert.strictEqual(env.pgState.windows[0].config.temperature, 0.5, 'other persisted fields survive');
  });

  await check('max tokens: sent only while enabled, value = 8192 default', () => {
    const { env, w } = makeWinEnv();
    w.config.model = 'test/model';
    assert.strictEqual('max_tokens' in env.pgBuildBodyForWin(0), false);
    w.parameterEnabled.maxTokens = true;
    assert.strictEqual(env.pgBuildBodyForWin(0).max_tokens, 8192);
  });

  // ---------------- Top K / Min P ----------------
  await check('params: Top K / Min P rows render as sliders with their defaults', () => {
    const { env } = makeWinEnv();
    const html = sidebarHtml(env);
    assert.ok(html.indexOf("pgToggleParam('topK')") >= 0, 'Top K row missing');
    assert.ok(html.indexOf("pgToggleParam('minP')") >= 0, 'Min P row missing');
    // Top K is a whole-number slider (1..100, step 1), not a number box.
    assert.ok(/<input type="range" min="1" max="100" step="1" value="40" oninput="pgOnParam\('topK', parseFloat\(this.value\), this.step\)"><span class="pg-val" id="pg-val-topK">40<\/span>/.test(html),
      'Top K must be a 1..100 step-1 slider showing an integer');
    assert.strictEqual(valueBefore(html, "pgOnParam('minP'"), 'value="0.05"');
    assert.strictEqual(env.PG_DEFAULT_CFG.minP, 0.05);
  });

  await check('params: slider read-out follows the step (integer vs fractional)', () => {
    const { env } = makeWinEnv();
    env.elements['pg-val-topK'] = { textContent: '' };
    env.elements['pg-val-temperature'] = { textContent: '' };
    env.pgOnParam('topK', 20, '1');
    env.pgOnParam('temperature', 0.7, '0.1');
    assert.strictEqual(env.elements['pg-val-topK'].textContent, '20');
    assert.strictEqual(env.elements['pg-val-temperature'].textContent, '0.70');
  });

  await check('params: top_k / min_p follow their toggles', () => {
    const { env, w } = makeWinEnv();
    w.config.model = 'test/model';
    let body = env.pgBuildBodyForWin(0);
    assert.strictEqual('top_k' in body, false);
    assert.strictEqual('min_p' in body, false);

    w.parameterEnabled.topK = true;
    w.parameterEnabled.minP = true;
    body = env.pgBuildBodyForWin(0);
    assert.strictEqual(body.top_k, 40);
    assert.strictEqual(body.min_p, 0.05);

    // A zeroed value is never sent (toggle on, value 0).
    w.config.topK = 0;
    w.config.minP = 0;
    body = env.pgBuildBodyForWin(0);
    assert.strictEqual('top_k' in body, false);
    assert.strictEqual('min_p' in body, false);
  });

  await check('params: Google protocol keeps generationConfig.topK and never sends min_p', () => {
    const { env, w } = makeWinEnv();
    w.config.model = 'test/model';
    env.pgState.models = [{ id: 'test/model', kind: 'text', textProtocol: 'google' }];
    w.config.topK = 40;
    w.parameterEnabled.topK = true;
    w.parameterEnabled.minP = true;
    const body = env.pgBuildBodyForWin(0);
    assert.strictEqual(body.generationConfig.topK, 40);
    assert.strictEqual('min_p' in body, false);
    assert.strictEqual('top_k' in body, false);
  });

  // ---------------- Presets ----------------
  await check('presets: title rows carry the Preset buttons', () => {
    const { env } = makeWinEnv();
    const html = sidebarHtml(env);
    assert.ok(/<span>Parameters<\/span><button type="button" class="pg-btn pg-preset-btn" onclick="pgPresetOpen\('params'\)"/.test(html), 'Parameters preset button missing');
    assert.ok(/<span>System Prompt<\/span><button type="button" class="pg-btn pg-preset-btn" onclick="pgPresetOpen\('system'\)"/.test(html), 'System Prompt preset button missing');
  });

  await check('presets: params snapshot applies config + toggles to the active window', () => {
    const { env, w } = makeWinEnv();
    w.config.model = 'keep/me';
    w.config.temperature = 0.2;
    w.config.topK = 17;
    w.config.minP = 0.3;
    w.config.systemPrompt = 'sys';
    w.parameterEnabled.topK = true;
    w.parameterEnabled.seed = true;

    assert.strictEqual(env.pgPresetSaveCurrent('params', 'Precise'), true);

    // Drift every field, then apply.
    w.config.temperature = 1.5;
    w.config.topK = 90;
    w.config.minP = 0.9;
    w.config.systemPrompt = 'changed';
    w.parameterEnabled.topK = false;
    w.parameterEnabled.seed = false;

    env.pgPresetApply('params', 0);

    assert.strictEqual(w.config.temperature, 0.2);
    assert.strictEqual(w.config.topK, 17);
    assert.strictEqual(w.config.minP, 0.3);
    assert.strictEqual(w.parameterEnabled.topK, true);
    assert.strictEqual(w.parameterEnabled.seed, true);
    // A Parameters preset never carries the model or the system prompt.
    assert.strictEqual(w.config.model, 'keep/me');
    assert.strictEqual(w.config.systemPrompt, 'changed');
    assert.strictEqual(env.toasts[env.toasts.length - 1], 'Preset "Precise" applied');
  });

  await check('presets: system prompt snapshot applies the text only', () => {
    const { env, w } = makeWinEnv();
    w.config.systemPrompt = 'You are terse.';
    w.config.temperature = 0.7;
    env.pgPresetSaveCurrent('system', 'Terse');
    w.config.systemPrompt = '';
    w.config.temperature = 1.9;
    env.pgPresetApply('system', 0);
    assert.strictEqual(w.config.systemPrompt, 'You are terse.');
    assert.strictEqual(w.config.temperature, 1.9, 'system preset must not touch parameters');
  });

  await check('presets: same name overwrites, delete removes', () => {
    const { env, w } = makeWinEnv();
    w.config.temperature = 0.1;
    env.pgPresetSaveCurrent('params', 'A');
    w.config.temperature = 0.9;
    env.pgPresetSaveCurrent('params', 'A');
    env.pgPresetSaveCurrent('params', 'B');
    const list = env.pgPresetList('params');
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].config.temperature, 0.9, 'same name keeps the newest snapshot');

    env.pgPresetDelete('params', 0);
    assert.strictEqual(JSON.stringify(env.pgPresetList('params').map((p) => p.name)), '["B"]');
    env.pgPresetDelete('params', 5);
    assert.strictEqual(env.pgPresetList('params').length, 1, 'out-of-range delete is a no-op');
  });

  await check('presets: stored in localStorage and reloaded', () => {
    const { env, w } = makeWinEnv();
    w.config.temperature = 0.33;
    w.config.systemPrompt = 'persisted';
    env.pgPresetSaveCurrent('params', 'P');
    env.pgPresetSaveCurrent('system', 'S');

    const raw = JSON.parse(env.storage['tinylab.playground.presets.v1']);
    assert.strictEqual(raw.params[0].name, 'P');
    assert.strictEqual(raw.params[0].config.temperature, 0.33);
    assert.strictEqual(raw.params[0].enabled.temperature, true);
    assert.strictEqual(raw.system[0].text, 'persisted');

    // Simulate a reload: drop the in-memory store and re-read.
    env.pgPresetStore = null;
    assert.strictEqual(env.pgPresetList('params')[0].name, 'P');
    assert.strictEqual(env.pgPresetList('system')[0].text, 'persisted');
  });

  await check('presets: corrupt storage degrades to an empty list', () => {
    const env = makeEnv('en', { 'tinylab.playground.presets.v1': '{not json' });
    assert.strictEqual(JSON.stringify(env.pgPresetList('params')), '[]');
    assert.strictEqual(JSON.stringify(env.pgPresetList('system')), '[]');
  });

  await check('presets: empty name is rejected', () => {
    const { env } = makeWinEnv();
    assert.strictEqual(env.pgPresetSaveCurrent('params', '   '), false);
    assert.strictEqual(env.pgPresetList('params').length, 0);
  });

  await check('presets: modal lists saved entries in the Settings preset card', () => {
    const { env } = makeWinEnv();
    env.pgPresetSaveCurrent('params', 'One');
    env.pgPresetSaveCurrent('params', 'Two');
    const saved = env.pgPresetList('params')[0];
    const enabledCount = Object.keys(saved.enabled).filter((k) => saved.enabled[k]).length;
    env.pgPresetOpen('params');
    const html = env.elements['pg-modal-overlay'].innerHTML;
    // Same card as the Settings page Quick Slot preset modal.
    assert.ok(/<div class="qs-modal">/.test(html), 'modal must use the qs-modal card');
    assert.ok(html.indexOf('<div class="qs-modal-title">') >= 0 && html.indexOf('<div class="qs-modal-hint">') >= 0,
      'title / hint rows missing');
    assert.ok(html.indexOf('Preset — Parameters') >= 0, 'modal title missing');
    assert.ok(html.indexOf('pgPresetApply(\'params\',0)') >= 0);
    assert.ok(html.indexOf('pgPresetRemove(\'params\',1)') >= 0, 'rows must delete on right-click');
    assert.ok(html.indexOf("pgPresetSaveCurrentPrompt('params')") >= 0, '+ button must save the current config');
    assert.ok(html.indexOf('>One <span class="muted"') >= 0 && html.indexOf('>Two <span class="muted"') >= 0,
      'rows carry the name plus its muted detail');
    assert.ok(html.indexOf('(' + enabledCount + ' params)') >= 0, 'detail counts the enabled parameters');
    assert.strictEqual(html.indexOf('pg-preset-del'), -1, 'no per-row delete button');
    env.pgPresetClose();
    assert.strictEqual(env.pgPresetKind, '');
  });

  // ---------------- System prompt box + V2 differ editor ----------------
  await check('system prompt: the box is a read-only preview of the current prompt', () => {
    const { env } = makeWinEnv('en', {}, { systemPrompt: 'You are terse.' });
    const html = sidebarHtml(env);
    assert.ok(html.indexOf('id="pg-sysprompt" readonly') >= 0, 'box must be read-only');
    assert.ok(html.indexOf('onclick="pgOpenSystemPromptEditor()"') >= 0, 'click must open the editor');
    assert.strictEqual(html.indexOf('pgOnSystemPrompt'), -1, 'inline editing handler must be gone');
    assert.ok(html.indexOf('>You are terse.</textarea>') >= 0, 'box must display the current prompt');
  });

  await check('system prompt: click opens the differ modal seeded with the current prompt', () => {
    const { env, w } = makeWinEnv('en', {}, { systemPrompt: 'old prompt' });
    let opts = null;
    env.window.EditorV2Embed = { openDiffModal: (o) => { opts = o; } };
    env.pgOpenSystemPromptEditor();
    assert.ok(opts, 'openDiffModal must be called');
    assert.strictEqual(opts.title, 'System Prompt');
    assert.strictEqual(opts.original, 'old prompt');
    assert.strictEqual(opts.current, 'old prompt');
    const before = env.toasts.length;
    opts.onSave('line one\r\nline two');
    assert.strictEqual(w.config.systemPrompt, 'line one\nline two', 'CRLF from Monaco must be stored as LF');
    assert.ok(env.elements['pg-side'].innerHTML.indexOf('>line one\nline two</textarea>') >= 0,
      'the box must show the saved prompt');
    assert.strictEqual(env.toasts.length, before + 1, 'save must toast once');

    opts.onSave('new prompt');
    assert.strictEqual(w.config.systemPrompt, 'new prompt');
    assert.ok(env.elements['pg-side'].innerHTML.indexOf('>new prompt</textarea>') >= 0,
      'the box must show the saved prompt');
    assert.strictEqual(env.toasts.length, before + 2, 'each save toasts once');
  });

  await check('system prompt: an empty prompt still opens the editor', () => {
    const { env } = makeWinEnv('en', {}, { systemPrompt: '' });
    let opts = null;
    env.window.EditorV2Embed = { openDiffModal: (o) => { opts = o; } };
    env.pgOpenSystemPromptEditor();
    assert.ok(opts && opts.current === '' && opts.original === '', 'empty prompt opens an empty editor');
  });

  await check('system prompt: missing embed degrades to a toast', () => {
    const { env, w } = makeWinEnv('en', {}, { systemPrompt: 'keep me' });
    delete env.window.EditorV2Embed;
    const before = env.toasts.length;
    env.pgOpenSystemPromptEditor();
    assert.strictEqual(w.config.systemPrompt, 'keep me');
    assert.strictEqual(env.toasts.length, before + 1, 'must surface a toast');
  });

  await check('shortcuts: a read-only textarea is not an editing target', () => {
    const { env } = makeWinEnv();
    assert.strictEqual(env.pgIsEditingTarget({ tagName: 'TEXTAREA', readOnly: true }), false);
    assert.strictEqual(env.pgIsEditingTarget({ tagName: 'TEXTAREA' }), true);
    assert.strictEqual(env.pgIsEditingTarget({ tagName: 'INPUT' }), true);
    assert.strictEqual(env.pgIsEditingTarget({ tagName: 'DIV', isContentEditable: true }), true);
    assert.strictEqual(env.pgIsEditingTarget({ tagName: 'DIV' }), false);
  });

  // ---------------- Recent-request row delete ----------------
  await check('left panel: rows carry a delete button', () => {
    const { env, w } = makeWinEnv();
    w.messages = [{ role: 'user', content: 'hello' }];
    const row = env.pgConvCreate('hello', w.messages.slice());
    const html = env.elements['pg-req-left-content'].innerHTML;
    assert.ok(html.indexOf('pgConvDelete(' + row.id + ')') >= 0, 'delete handler missing');
    assert.ok(html.indexOf('event.stopPropagation()') >= 0, 'delete must not switch conversation');
    assert.ok(html.indexOf('pg-req-del-btn') >= 0, 'delete button class missing');
  });

  await check('left panel: delete drops the row and keeps the conversation', () => {
    const { env, w } = makeWinEnv();
    w.messages = [{ role: 'user', content: 'first' }];
    const first = env.pgConvCreate('first', w.messages.slice());
    const second = env.pgConvCreate('second', [{ role: 'user', content: 'second' }]);
    assert.strictEqual(env.pgActiveConvId, second.id);

    // Deleting the active row clears the highlight but leaves the pane alone.
    const paneMsgs = env.pgWinAt(0).messages;
    env.pgConvDelete(second.id);
    assert.strictEqual(env.pgActiveConvId, 0);
    assert.strictEqual(env.pgWinAt(0).messages, paneMsgs, 'pane messages must not be touched');
    assert.strictEqual(JSON.stringify(env.pgConvList.map((r) => r.id)), '[' + first.id + ']');

    env.pgConvDelete(first.id);
    assert.strictEqual(env.pgConvList.length, 0);
    assert.ok(env.elements['pg-req-left-content'].innerHTML.indexOf('pg-req-empty') >= 0, 'empty state missing');

    env.pgConvDelete(999);
    assert.strictEqual(env.pgConvList.length, 0, 'unknown id is a no-op');
  });

  if (failures) {
    console.error('\n' + failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('\nall checks passed');
}

runAll();
