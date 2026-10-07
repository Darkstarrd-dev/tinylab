// web/systray-shortcuts.test.js
// Zero-dependency Node behavioral test for the Systray shortcut region
// (Settings → Shortcut Settings → Systray): OS-level global hotkeys wired to
// internal/hotkey on Windows. Loads the REAL web/static/shortcuts.js in a VM
// sandbox and proves:
//   1. The systray region exists with the two actions and the spec defaults
//      (Open Browser = Ctrl+Shift+T, Open Console = Ctrl+Alt+Shift+T).
//   2. formatBinding renders the full modifier chain (single-letter keys must
//      not hide Shift for global hotkeys).
//   3. matchEvent matches the default combos (browser keydown semantics).
//   4. The systray defaults collide with no other region's preset.
// Also guards the Go↔JS default mirror, i18n keys (en+cn) and the modal
// wiring in settings_shortcuts.js.
//
// Run:  node web/systray-shortcuts.test.js
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

const scSrc = fs.readFileSync(path.join(__dirname, 'static/shortcuts.js'), 'utf8');

console.log('systray shortcut region:');

check('shortcuts.js defines the systray region with both actions', () => {
  assert.ok(/'systray\.open-browser':\s*\{\s*key:\s*'t',\s*ctrlOrCmd:\s*true,\s*shift:\s*true/.test(scSrc),
    'missing systray.open-browser preset (expected ctrl+shift+t)');
  assert.ok(/'systray\.open-console':\s*\{\s*key:\s*'t',\s*ctrlOrCmd:\s*true,\s*alt:\s*true,\s*shift:\s*true/.test(scSrc),
    'missing systray.open-console preset (expected ctrl+alt+shift+t)');
});

check('SHORTCUT_REGIONS registers the systray tab', () => {
  assert.ok(/\{\s*id:\s*'systray',\s*label:\s*'Systray'\s*\}/.test(scSrc), 'SHORTCUT_REGIONS missing systray entry');
});

check('formatBinding shows Shift for single-letter global hotkeys', () => {
  assert.ok(/if\s*\(b\.shift\)\s*parts\.push\('Shift'\)/.test(scSrc),
    'formatBinding must always show Shift when set');
  const legacy = /if\s*\(b\.shift\s*&&\s*b\.key\.length\s*>\s*1\)\s*parts\.push\('Shift'\)/.test(scSrc);
  assert.ok(!legacy, 'legacy length>1 Shift rule still present');
});

// --- VM sandbox: real script, window + navigator stubs ---
const ctx = vm.createContext({
  window: {},
  navigator: { platform: 'Win32', userAgent: 'node-test' },
  console
});
vm.runInContext(scSrc, ctx, { filename: 'shortcuts.js' });
const Shortcuts = ctx.window.Shortcuts;
const PRESETS = ctx.window.SHORTCUT_PRESETS;

check('Shortcuts API exposes the systray region and defaults', () => {
  assert.ok(Shortcuts && PRESETS && PRESETS.systray, 'window.Shortcuts/PRESETS missing');
  const regions = Shortcuts.getAllRegions().map(r => r.id);
  assert.ok(regions.indexOf('systray') !== -1, 'getAllRegions missing systray');
  const systray = Shortcuts.getAllRegions().filter(r => r.id === 'systray')[0];
  assert.strictEqual(systray.actions.length, 2, 'systray must hold exactly 2 actions');
  // Rebuild in this realm: deepStrictEqual compares prototypes and the VM
  // sandbox has its own Object.prototype.
  const norm = (b) => b && { key: b.key, ctrlOrCmd: !!b.ctrlOrCmd, alt: !!b.alt, shift: !!b.shift };
  assert.deepStrictEqual(norm(Shortcuts.defaultBinding('systray.open-browser')),
    { key: 't', ctrlOrCmd: true, alt: false, shift: true });
  assert.deepStrictEqual(norm(Shortcuts.defaultBinding('systray.open-console')),
    { key: 't', ctrlOrCmd: true, alt: true, shift: true });
});

check('formatBinding renders the full combo chain', () => {
  assert.strictEqual(Shortcuts.formatBinding({ key: 't', ctrlOrCmd: true, shift: true }), 'Ctrl+Shift+T');
  assert.strictEqual(Shortcuts.formatBinding({ key: 't', ctrlOrCmd: true, alt: true, shift: true }), 'Ctrl+Alt+Shift+T');
});

check('matchEvent matches the default systray combos', () => {
  const ev = (mods) => Object.assign({ key: 't' }, mods);
  assert.ok(Shortcuts.matchEvent('systray.open-browser', ev({ ctrlKey: true, shiftKey: true })),
    'ctrl+shift+t must match open-browser');
  assert.ok(Shortcuts.matchEvent('systray.open-console', ev({ ctrlKey: true, altKey: true, shiftKey: true })),
    'ctrl+alt+shift+t must match open-console');
  assert.ok(!Shortcuts.matchEvent('systray.open-console', ev({ ctrlKey: true, shiftKey: true })),
    'ctrl+shift+t must NOT match open-console (alt required)');
});

check('systray defaults collide with no other region preset', () => {
  for (const actionId of ['systray.open-browser', 'systray.open-console']) {
    const b = Shortcuts.defaultBinding(actionId);
    for (const region of Shortcuts.getAllRegions()) {
      if (region.id === 'systray') continue;
      const conflict = Shortcuts.findConflict(region.id, b, null);
      assert.strictEqual(conflict, null,
        `${actionId} collides with ${region.id}.${conflict}`);
    }
  }
});

check('Go mirror: internal/hotkey defaultBindings match the JS presets', () => {
  const goSrc = fs.readFileSync(path.join(__dirname, '..', 'internal/hotkey/hotkey.go'), 'utf8');
  const lineFor = (id) => goSrc.split('\n').find(l => l.includes(id + ':')) || '';
  assert.ok(/ActionOpenBrowser:\s*\{Key: "t", CtrlOrCmd: true, Shift: true\}/.test(lineFor('ActionOpenBrowser')),
    'hotkey.go defaultBindings[ActionOpenBrowser] drifted from the JS preset');
  assert.ok(/ActionOpenConsole:\s*\{Key: "t", CtrlOrCmd: true, Alt: true, Shift: true\}/.test(lineFor('ActionOpenConsole')),
    'hotkey.go defaultBindings[ActionOpenConsole] drifted from the JS preset');
});

check('i18n.js has shortcutTabSystray + shortcutSystrayNote in en AND cn', () => {
  const i18n = fs.readFileSync(path.join(__dirname, 'static/i18n.js'), 'utf8');
  for (const key of ['shortcutTabSystray', 'shortcutSystrayNote']) {
    const n = i18n.split('\n').filter(l => new RegExp('^\\s*' + key + ':').test(l)).length;
    assert.strictEqual(n, 2, `${key} must exist exactly twice (en+cn), found ${n}`);
  }
});

check('settings_shortcuts.js renders the systray tab and note', () => {
  const ss = fs.readFileSync(path.join(__dirname, 'static/settings/settings_shortcuts.js'), 'utf8');
  assert.ok(ss.includes("r.id === 'systray' ? t('shortcutTabSystray')"), 'tab label mapping missing');
  assert.ok(/if\s*\(r\.id === 'global' \|\| r\.id === 'systray'\) return true;/.test(ss),
    'scRegionTabs must always show the systray tab');
  assert.ok(ss.includes("t('shortcutSystrayNote')"), 'systray region note missing');
});

console.log(failures === 0 ? '\nAll systray shortcut checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
