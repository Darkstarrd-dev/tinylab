// web/settings-assistant-modal.test.js
// Zero-dependency Node behavioral test for the Assistant settings modal save
// (item 1 frontend). Loads the REAL web/static/settings/settings_modal.js in
// a VM sandbox with stubbed apiPatch/document/t/toast, calls saveAssistantModal,
// and asserts it reads the field values and PATCHes the correct
// {assistant:{model,spritesheetPath,spritesheetFps}} body — plus fps coercion.
// The API round-trip already proved the backend; this proves the modal wires
// the fields into the request body correctly.
//
// Run:  node web/settings-assistant-modal.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Field values the modal reads via document.getElementById(id).value.
const fieldValues = {
  'settings-modal-assistant-model': 'openai/gpt-4o-mini',
  'settings-modal-assistant-spritesheet': '/sprite/s.png',
  'settings-modal-assistant-fps': '12',
};
const apiCalls = [];
const document = {
  getElementById(id) { return { value: fieldValues[id] !== undefined ? fieldValues[id] : '' }; },
};
// Stubs for the globals settings_modal.js references (only saveAssistantModal's
// dependencies are exercised; the rest are no-ops so the file loads cleanly).
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

  console.log('settings assistant modal save (item 1) behavioral tests:');

  await check('saveAssistantModal reads fields + PATCHes {assistant:{model,spritesheetPath,spritesheetFps}}', async () => {
    apiCalls.length = 0;
    fieldValues['settings-modal-assistant-fps'] = '12';
    await sandbox.saveAssistantModal();
    assert.strictEqual(apiCalls.length, 1, 'exactly one PATCH made');
    assert.strictEqual(apiCalls[0].url, '/settings', 'PATCHed /settings');
    // field-by-field (not deepStrictEqual): the body object is created in the
    // VM context so its Object.prototype differs from the main context.
    var b = apiCalls[0].body.assistant;
    assert.strictEqual(b.model, 'openai/gpt-4o-mini', 'model field');
    assert.strictEqual(b.spritesheetPath, '/sprite/s.png', 'spritesheetPath field');
    assert.strictEqual(b.spritesheetFps, 12, 'spritesheetFps field');
  });

  await check('saveAssistantModal coerces invalid fps to default 8', async () => {
    apiCalls.length = 0;
    fieldValues['settings-modal-assistant-fps'] = 'not-a-number';
    await sandbox.saveAssistantModal();
    assert.strictEqual(apiCalls[0].body.assistant.spritesheetFps, 8, 'invalid fps coerced to 8');
  });

  await check('saveAssistantModal clamps fps<1 to default 8', async () => {
    apiCalls.length = 0;
    fieldValues['settings-modal-assistant-fps'] = '0';
    await sandbox.saveAssistantModal();
    assert.strictEqual(apiCalls[0].body.assistant.spritesheetFps, 8, 'fps<1 coerced to 8');
  });

  if (failures) { console.error('\n' + failures + ' check(s) FAILED'); process.exit(1); }
  console.log('\nall settings modal checks passed');
})();
