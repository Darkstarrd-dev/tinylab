// web/pg-image-inspire.test.js
// Zero-dependency Node behavioral test for the Prompt Inspire modal fixes:
//   1. Batch stepper +/- (pgStepImageSubmitCount) updates BOTH the config and
//      every rendered input.pg-image-submit-count (main bar + inspire modal) —
//      previously the modal display never changed, so the buttons looked dead.
//   2. Batch inspire generation re-renders the modal with an Apply button
//      (batchDone footer) — previously batch results had no way to apply back.
//   3. pgImageInspireApply writes the delimiter-joined batch prompts into
//      #pg-input and w.config.prompt.
//   4. Presets saved via pgInspireSavePresets are stored on the window config
//      and rendered back into the modal list.
//   5. pgSetMode seeds freshly created mode windows with the outgoing window's
//      (persisted) config — previously image mode started from defaults on
//      every reload, wiping inspire presets / helper model / submit count.
//   6. Task-queue bin buttons carry the btn-icon class so the shared
//      style.css .btn-icon.bin-button rules (column layout + hover rotate)
//      apply — the playground page loads style.css.
//
// Loads the real pg-ui.js + pg-image-inspire.js + pg-image-tasks.js in a
// sandboxed VM with stubbed browser/network globals (pg-image-count.test.js
// convention).
//
// Run:  node web/pg-image-inspire.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.message));
  }
}

function makeEl(value) {
  return {
    value: value !== undefined ? value : '',
    innerHTML: '',
    textContent: '',
    style: {},
    classList: { add: function () {}, remove: function () {} },
    focus: function () {},
    dispatchEvent: function () {},
    setAttribute: function () {},
    getAttribute: function () { return null; },
  };
}

function makeEnv() {
  const calls = { fetches: [], modals: [], toasts: [], saves: 0 };
  const els = {};
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, Promise, JSON, Object, Array, String, Number, Error,
    parseInt, parseFloat, isNaN, encodeURIComponent, URLSearchParams,
    AbortController,
    fetch: function (url, opts) {
      calls.fetches.push({ url: String(url), opts: opts || null });
      return Promise.resolve({
        ok: true,
        json: function () {
          return Promise.resolve({ choices: [{ message: { content: sandbox.fetchReply || '' } }] });
        },
      });
    },
    pgT: function (key) { return key; },
    pgToast: function (msg, kind) { calls.toasts.push({ msg: msg, kind: kind }); },
    pgSave: function () { calls.saves++; },
    pgSaveMode: function () {},
    pgRenderSidebar: function () { calls.renderSidebar = (calls.renderSidebar || 0) + 1; },
    pgRenderPanes: function () {},
    pgRenderInputBar: function () {},
    pgShowModal: function (html) { calls.modals.push(html); },
    pgCloseModal: function () { calls.modalClosed = true; },
    pgEscapeHtml: function (s) { return String(s == null ? '' : s); },
    pgEscapeAttr: function (s) { return String(s == null ? '' : s); },
    pgTextContent: function (s) { return String(s == null ? '' : s); },
    document: {
      getElementById: function (id) { return els[id] || null; },
      querySelector: function () { return null; },
      querySelectorAll: function (sel) {
        if (sel === 'input.pg-image-submit-count') {
          return [els['pg-inspire-count-input'], els['pg-main-count-input']];
        }
        return [];
      },
    },
    pgTextContent: function (s) { return String(s == null ? '' : s); },
    // Real global from pg-state.js; pg-ui.js pgSetMode guards with typeof.
    makeWin: function () { return makeWin(); },
    calls: calls,
    els: els,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.innerHeight = 800;
  sandbox.pgState = {
    windows: [],
    activeWin: 0,
    mode: 'normal',
    splitCount: 1,
    modeWindows: {},
    modeSplitCounts: {},
  };
  sandbox.pgWin = function () { return sandbox.pgState.windows[sandbox.pgState.activeWin]; };
  sandbox.pgWinAt = function (i) { return sandbox.pgState.windows[i]; };
  return sandbox;
}

const DIR = path.join(__dirname, 'playground', 'static-pg', 'playground');
function loadModules(env) {
  vm.createContext(env);
  // pg-ui.js provides the real pgSetMode / pgGetImageSubmitCount /
  // pgOnImageSubmitCount / pgStepImageSubmitCount.
  vm.runInContext(fs.readFileSync(path.join(DIR, 'pg-ui.js'), 'utf8'), env, { filename: 'pg-ui.js' });
  vm.runInContext(fs.readFileSync(path.join(DIR, 'pg-image-inspire.js'), 'utf8'), env, { filename: 'pg-image-inspire.js' });
  vm.runInContext(fs.readFileSync(path.join(DIR, 'pg-image-tasks.js'), 'utf8'), env, { filename: 'pg-image-tasks.js' });
  return env;
}

function makeWin(extra) {
  return {
    config: Object.assign({
      model: '', imgPromptModel: 'helper-1', imgSubmitCount: 1,
      imgInspirePresets: [],
    }, extra || {}),
    messages: [],
    image: null,
  };
}

async function main() {
  // ----- 1. Stepper +/- syncs config and every rendered count input -----
  {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWin({ imgSubmitCount: 5 }));
    const modalInput = makeEl('5');
    const mainInput = makeEl('5');
    env.els['pg-inspire-count-input'] = modalInput;
    env.els['pg-main-count-input'] = mainInput;

    env.pgStepImageSubmitCount(1);
    check('stepper + updates config', () => assert.strictEqual(env.pgGetImageSubmitCount(), 6));
    check('stepper + syncs modal input display', () => assert.strictEqual(modalInput.value, 6));
    check('stepper + syncs main input display', () => assert.strictEqual(mainInput.value, 6));

    env.pgStepImageSubmitCount(-1);
    check('stepper - updates config', () => assert.strictEqual(env.pgGetImageSubmitCount(), 5));
    check('stepper - syncs modal input display', () => assert.strictEqual(modalInput.value, 5));

    env.pgStepImageSubmitCount(-99);
    check('stepper clamps at 1', () => assert.strictEqual(env.pgGetImageSubmitCount(), 1));
  }

  // ----- 2+3. Batch generate re-renders with Apply; Apply writes back -----
  {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWin({ imgSubmitCount: 2 }));
    env.pgState.activeWin = 0;
    env.fetchReply = 'First prompt\n<<<PROMPT>>>\nSecond prompt';
    env.els['pg-inspire-model'] = makeEl('helper-1');
    env.els['pg-inspire-format'] = makeEl('natural');
    const inspireInput = makeEl('cats in a garden');
    env.els['pg-inspire-input'] = inspireInput;
    const mainTa = makeEl('');
    env.els['pg-input'] = mainTa;
    // autosize target used right after the batch re-render
    env.els['pg-inspire-input'].scrollHeight = 100;

    env.pgImageInspireGenerate();
    await new Promise(function (r) { setTimeout(r, 10); });

    const modalHtml = env.calls.modals[env.calls.modals.length - 1];
    check('batch modal footer has Apply button', () => assert.ok(modalHtml.indexOf('pgImageInspireApply()') >= 0));
    check('batch modal footer has Regenerate', () => assert.ok(modalHtml.indexOf('pgImageInspireGenerate()') >= 0));
    check('batch modal has no preview block', () => assert.ok(modalHtml.indexOf('pg-inspire-preview') < 0));
    check('batch prompts joined with delimiter in input', () =>
      assert.strictEqual(inspireInput.value, 'First prompt\n<<<PROMPT>>>\nSecond prompt'));

    env.pgImageInspireApply();
    check('apply writes batch prompts to main input', () =>
      assert.strictEqual(mainTa.value, 'First prompt\n<<<PROMPT>>>\nSecond prompt'));
    check('apply persists to config.prompt', () =>
      assert.strictEqual(env.pgWin().config.prompt, 'First prompt\n<<<PROMPT>>>\nSecond prompt'));
    check('apply closes modal', () => assert.ok(env.calls.modalClosed));

    // Single-prompt result keeps the preview + Apply footer.
    env.fetchReply = 'One polished prompt';
    env.pgState.windows[0].config.imgSubmitCount = 1;
    env.pgImageInspireGenerate();
    await new Promise(function (r) { setTimeout(r, 10); });
    const singleHtml = env.calls.modals[env.calls.modals.length - 1];
    check('single result keeps preview + Apply', () => {
      assert.ok(singleHtml.indexOf('pg-inspire-preview') >= 0);
      assert.ok(singleHtml.indexOf('pgImageInspireApply()') >= 0);
    });
  }

  // ----- 4. Presets save + render back -----
  {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWin());
    env.els['pg-inspire-model'] = makeEl('helper-1');
    env.els['pg-inspire-format'] = makeEl('natural');
    env.els['pg-inspire-input'] = makeEl('');
    env.els['pg-inspire-presets-edit'] = makeEl('  preset one  \n\npreset two\n');

    env.pgInspireSavePresets();
    check('presets saved trimmed/non-empty', () =>
      assert.strictEqual(JSON.stringify(env.pgWin().config.imgInspirePresets), JSON.stringify(['preset one', 'preset two'])));
    const modalHtml = env.calls.modals[env.calls.modals.length - 1];
    check('presets rendered back into modal list', () => {
      assert.ok(modalHtml.indexOf('pgInspireUsePreset(0)') >= 0);
      assert.ok(modalHtml.indexOf('preset one') >= 0);
      assert.ok(modalHtml.indexOf('preset two') >= 0);
    });
  }

  // ----- 4b. Presets are helper-model instruction templates -----
  {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWin({ imgInspirePresets: [] }));
    env.pgState.models = [{ id: 'helper-1', kind: 'text' }];
    env.els['pg-inspire-model'] = makeEl('helper-1');
    env.els['pg-inspire-format'] = makeEl('natural');
    env.els['pg-inspire-input'] = makeEl('a cat');

    env.pgOpenImageInspire();
    const modalHtml = env.calls.modals[env.calls.modals.length - 1];
    check('empty presets render built-in instruction templates', () => {
      assert.ok(modalHtml.indexOf('Generate exactly {n} DIFFERENT image prompts') >= 0);
      assert.ok(modalHtml.indexOf('No presets yet') < 0);
    });
    check('first built-in preset highlighted by default', () => {
      assert.ok(/pg-inspire-preset-item active[^>]*onclick="pgInspireUsePreset\(0\)"/.test(modalHtml));
    });

    // Default selection (no imgInspirePreset) reproduces the historical
    // single-prompt instruction verbatim.
    env.pgImageInspireGenerate();
    await new Promise(function (r) { setTimeout(r, 10); });
    let body = JSON.parse(env.calls.fetches[env.calls.fetches.length - 1].opts.body);
    check('default instruction = polished single prompt', () =>
      assert.strictEqual(body.messages[0].content, 'Return only a polished natural-language image prompt.'));

    // Selecting the multi-prompt built-in: substitution fills {n}/{format}/{delimiter}.
    env.pgInspireUsePreset(1);
    check('clicking preset stores selection', () =>
      assert.ok(env.pgWin().config.imgInspirePreset.indexOf('Generate exactly {n}') === 0));
    const selHtml = env.calls.modals[env.calls.modals.length - 1];
    check('selected preset highlighted after re-render', () => {
      assert.ok(/pg-inspire-preset-item active[^>]*onclick="pgInspireUsePreset\(1\)"/.test(selHtml));
    });
    env.pgState.windows[0].config.imgSubmitCount = 3;
    env.pgImageInspireGenerate();
    await new Promise(function (r) { setTimeout(r, 10); });
    body = JSON.parse(env.calls.fetches[env.calls.fetches.length - 1].opts.body);
    check('multi-prompt preset substitutes {n}/{format}/{delimiter}', () => {
      assert.ok(body.messages[0].content.indexOf('Generate exactly 3 DIFFERENT image prompts') === 0);
      assert.ok(body.messages[0].content.indexOf('self-contained a polished natural-language image prompt') >= 0);
      assert.ok(body.messages[0].content.indexOf('<<<PROMPT>>>') >= 0);
    });

    // A custom preset without {delimiter} still gets batch scaffolding appended.
    env.pgWin().config.imgInspirePresets = ['Polish the user input into a vivid {format}.'];
    env.pgWin().config.imgInspirePreset = 'Polish the user input into a vivid {format}.';
    env.pgImageInspireGenerate();
    await new Promise(function (r) { setTimeout(r, 10); });
    body = JSON.parse(env.calls.fetches[env.calls.fetches.length - 1].opts.body);
    check('custom preset + batch appends separator scaffolding', () => {
      assert.ok(body.messages[0].content.indexOf('Polish the user input into a vivid a polished natural-language image prompt.') === 0);
      assert.ok(body.messages[0].content.indexOf('Generate exactly 3 DIFFERENT') >= 0);
      assert.ok(body.messages[0].content.indexOf('<<<PROMPT>>>') >= 0);
    });

    // Edit prefills the textarea with the current list (user presets at this
    // point; builtins when the user list is still empty).
    env.pgInspireToggleEdit(true);
    const editHtml = env.calls.modals[env.calls.modals.length - 1];
    check('Edit prefills textarea with current preset list', () =>
      assert.ok(editHtml.indexOf('pg-inspire-presets-edit') >= 0 &&
        editHtml.indexOf('Polish the user input into a vivid {format}.') >= 0));
    env.els['pg-inspire-presets-edit'] = makeEl('my own instruction\n');
    env.pgInspireSavePresets();
    const afterHtml = env.calls.modals[env.calls.modals.length - 1];
    check('saved user presets replace builtin fallback', () => {
      assert.strictEqual(JSON.stringify(env.pgWin().config.imgInspirePresets),
        JSON.stringify(['my own instruction']));
      assert.ok(afterHtml.indexOf('my own instruction') >= 0);
      assert.ok(afterHtml.indexOf('Generate exactly {n}') < 0);
    });
  }

  // ----- 5. pgSetMode seeds fresh mode windows with persisted config -----
  {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWin({ imgInspirePresets: ['kept preset'], imgSubmitCount: 3 }));
    env.pgState.mode = 'normal';

    env.pgSetMode('image');
    check('image windows inherit persisted presets', () =>
      assert.strictEqual(JSON.stringify(env.pgWin().config.imgInspirePresets), JSON.stringify(['kept preset'])));
    check('image windows inherit submit count', () =>
      assert.strictEqual(env.pgGetImageSubmitCount(), 3));
    check('image windows registered in modeWindows', () =>
      assert.strictEqual(env.pgState.modeWindows.image, env.pgState.windows));
    check('old mode windows preserved', () =>
      assert.strictEqual(env.pgState.modeWindows.normal[0].config.imgInspirePresets[0], 'kept preset'));

    // Switching back to image again reuses the same image windows (no reseed).
    const imageWindows = env.pgState.windows;
    env.pgWin().config.imgInspirePresets.push('added in image');
    env.pgSetMode('normal');
    env.pgSetMode('image');
    check('returning to image reuses its windows (no data loss)', () =>
      assert.strictEqual(env.pgState.windows, imageWindows));
    check('in-image preset edits survive a mode round trip', () =>
      assert.strictEqual(JSON.stringify(env.pgWin().config.imgInspirePresets), JSON.stringify(['kept preset', 'added in image'])));
  }

  // ----- 6. Bin buttons carry btn-icon for shared layout/animation CSS -----
  {
    const env = loadModules(makeEnv());
    env.pgState.windows.push(makeWin());
    check('pgTaskBinSvg exported', () => assert.ok(typeof env.pgTaskBinSvg === 'function'));
    const svg1 = env.pgTaskBinSvg();
    const svg2 = env.pgTaskBinSvg();
    check('bin svg mask ids unique per instance', () => {
      const m1 = svg1.match(/pg-bin-mask-(\d+)/)[1];
      const m2 = svg2.match(/pg-bin-mask-(\d+)/)[1];
      assert.notStrictEqual(m1, m2);
    });
    check('task remove button carries btn-icon bin-button classes', () => {
      const src = fs.readFileSync(path.join(DIR, 'pg-image-tasks.js'), 'utf8');
      assert.ok(src.indexOf('pg-task-remove-btn btn-icon bin-button') >= 0);
    });
    check('task clear-all button carries btn-icon bin-button classes', () => {
      const src = fs.readFileSync(path.join(DIR, 'pg-ui.js'), 'utf8');
      assert.ok(src.indexOf('pg-task-clear-all-btn btn-icon bin-button') >= 0);
    });
    check('playground.css scopes bin icon sizes for pg buttons', () => {
      const css = fs.readFileSync(path.join(__dirname, 'playground', 'static-pg', 'playground.css'), 'utf8');
      assert.ok(css.indexOf('.pg-task-remove-btn .bin-top') >= 0);
    });
  }

  console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
  if (failures) process.exit(1);
}

main().catch(function (e) { console.error(e); process.exit(1); });
