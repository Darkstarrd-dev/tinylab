// web/settings-assistant-modal.test.js
// Zero-dependency Node behavioral test for the Assistant settings modal save.
// Loads the REAL web/static/settings/settings_modal.js in a VM sandbox with
// stubbed apiPatch/document/t/toast, calls saveAssistantModal, and asserts it
// reads the hidden model field + window.__assistantActions draft and PATCHes
// the correct {assistant:{model,actions}} body — including per-action numeric
// normalization (fps coercion, grid clamps).
//
// Run:  node web/settings-assistant-modal.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const fieldValues = {
  'settings-modal-assistant-model': 'openai/gpt-4o-mini',
};
const apiCalls = [];
const document = {
  getElementById(id) { return { value: fieldValues[id] !== undefined ? fieldValues[id] : '' }; },
};
const sandbox = {
  document,
  window: {},
  apiPatch(url, body) { apiCalls.push({ url, body }); return Promise.resolve({ ok: true }); },
  t(key) { return key; },
  toast() {},
  closeModalOverlay() {},
  escapeHtml(s) { return s; },
  renderStepperHtml() { return ''; },
  withLoading(btn, fn) { return fn(); },
  openSettingsModal() {},
  requestAnimationFrame() {},
  console,
};
vm.createContext(sandbox);
const SRC = fs.readFileSync(path.join(__dirname, 'static/settings/settings_modal.js'), 'utf8');
vm.runInContext(SRC, sandbox, { filename: 'settings_modal.js' });

if (typeof sandbox.saveAssistantModal !== 'function') {
  console.error('saveAssistantModal not exported by settings_modal.js'); process.exit(1);
}

(async () => {
  let failures = 0;
  async function check(name, fn) {
    try { await fn(); console.log('  ok  ' + name); }
    catch (err) { failures++; console.error('FAIL  ' + name + ': ' + (err && err.message)); }
  }

  console.log('settings assistant modal save (model + actions) behavioral tests:');

  await check('saveAssistantModal PATCHes {assistant:{model, actions}} from hidden field + draft', async () => {
    apiCalls.length = 0;
    fieldValues['settings-modal-assistant-model'] = 'openai/gpt-4o-mini';
    sandbox.window.__assistantActions = [
      { name: 'idle', spritesheetPath: 'C:/sheets/idle.png', cols: 4, rows: 2, frameStart: 0, frameEnd: 7, fps: 12 },
    ];
    await sandbox.saveAssistantModal();
    assert.strictEqual(apiCalls.length, 1, 'exactly one PATCH made');
    assert.strictEqual(apiCalls[0].url, '/settings', 'PATCHed /settings');
    var b = apiCalls[0].body.assistant;
    assert.strictEqual(b.model, 'openai/gpt-4o-mini', 'model field');
    assert.strictEqual(b.actions.length, 1, 'one action sent');
    var a = b.actions[0];
    assert.strictEqual(a.name, 'idle', 'action name');
    assert.strictEqual(a.spritesheetPath, 'C:/sheets/idle.png', 'action path');
    assert.strictEqual(a.cols, 4, 'cols');
    assert.strictEqual(a.rows, 2, 'rows');
    assert.strictEqual(a.frameStart, 0, 'frameStart');
    assert.strictEqual(a.frameEnd, 7, 'frameEnd');
    assert.strictEqual(a.fps, 12, 'fps');
  });

  await check('saveAssistantModal coerces invalid fps to default 8 and clamps grid values', async () => {
    apiCalls.length = 0;
    sandbox.window.__assistantActions = [
      { name: 'walk', spritesheetPath: '', cols: -3, rows: 0, frameStart: -5, frameEnd: NaN, fps: 0 },
    ];
    await sandbox.saveAssistantModal();
    var a = apiCalls[0].body.assistant.actions[0];
    assert.strictEqual(a.cols, 1, 'cols clamped to 1');
    assert.strictEqual(a.rows, 1, 'rows clamped to 1');
    assert.strictEqual(a.frameStart, 0, 'frameStart clamped to 0');
    assert.ok(!(a.frameEnd < 0), 'frameEnd never negative');
    assert.strictEqual(a.fps, 8, 'invalid fps coerced to 8');
  });

  await check('saveAssistantModal sends empty actions list when none drafted', async () => {
    apiCalls.length = 0;
    sandbox.window.__assistantActions = [];
    await sandbox.saveAssistantModal();
    assert.deepStrictEqual(apiCalls[0].body.assistant.actions, [], 'empty actions array sent');
  });

  if (failures) { console.error('\n' + failures + ' check(s) FAILED'); process.exit(1); }
  console.log('\nall settings modal checks passed');
})();
