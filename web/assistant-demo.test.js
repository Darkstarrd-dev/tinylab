// web/assistant-demo.test.js
// Zero-dependency Node behavioral test for the Assistant Demo page
// (web/static/assistant-demo.js, header nav F6). Loads the REAL script in a
// VM sandbox and drives the exposed __ademo test seam — proving:
//   1. SM alias resolution: events fall back through aliases to the default.
//   2. SM frame stepping honors fps and loops inside [start, end].
//   3. Physics: gravity pulls the entity to the stage floor (onGround),
//      jump rises and lands back, walk/Shift-slow/Ctrl-run speeds differ.
//   4. Colliders: landing on a body top, side blocking, head bump.
//   5. Right-click move target: walks to x and clears; manual keys cancel it.
// Also guards the page wiring: nav button, F6 preset, navigateTo case, and
// script tags in both index variants.
//
// Run:  node web/assistant-demo.test.js
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

const JS_PATH = path.join(__dirname, 'static/assistant-demo.js');
const src = fs.readFileSync(JS_PATH, 'utf8');

console.log('assistant demo page wiring:');

check('index.html has Demo nav button + script tag', () => {
  const html = fs.readFileSync(path.join(__dirname, 'static/index.html'), 'utf8');
  assert.ok(html.includes('data-page="demo"'), 'index.html missing data-page="demo" nav button');
  assert.ok(html.includes('<script src="/assistant-demo.js"></script>'), 'index.html missing assistant-demo.js script tag');
});

check('index-nopg.html has Demo nav button + script tag', () => {
  const html = fs.readFileSync(path.join(__dirname, 'static/index-nopg.html'), 'utf8');
  assert.ok(html.includes('data-page="demo"'), 'index-nopg.html missing data-page="demo" nav button');
  assert.ok(html.includes('<script src="/assistant-demo.js"></script>'), 'index-nopg.html missing assistant-demo.js script tag');
});

check('shortcuts.js binds F6 to global.goto-demo; app.js routes demo page', () => {
  const sc = fs.readFileSync(path.join(__dirname, 'static/shortcuts.js'), 'utf8');
  assert.ok(/'global\.goto-demo':\s*\{\s*key:\s*'F6'/.test(sc), 'shortcuts.js missing F6 goto-demo preset');
  const appRouter = fs.readFileSync(path.join(__dirname, 'static/app-router.js'), 'utf8');
  const appDemo = fs.readFileSync(path.join(__dirname, 'static/app-demo.js'), 'utf8');
  const appShortcuts = fs.readFileSync(path.join(__dirname, 'static/app-shortcuts.js'), 'utf8');
  // Shell toggle refactor (2026-08-29): demo renders via two panes, not a single return.
  assert.ok(appRouter.includes("case 'demo':") && appRouter.includes('renderDemoWithMenu(container)'), 'app-router.js missing demo route');
  assert.ok(appDemo.includes('renderAssistantDemo(container)') || appRouter.includes('renderAssistantDemo'), 'demo shell missing Assistant render');
  assert.ok(appDemo.includes('renderDemoGames(container)') || appRouter.includes('renderDemoGames'), 'demo shell missing Games render');
  assert.ok(appShortcuts.includes("matchEvent('global.goto-demo'") || appShortcuts.includes('global.goto-demo'), 'app-shortcuts.js missing F6 keydown binding');
  assert.ok(appRouter.includes('cleanupAssistantDemo'), 'app-router.js missing demo cleanup on navigate-away');
});

check('style.css places demo button at grid slot col3/row2 with active color', () => {
  const css = fs.readFileSync(path.join(__dirname, 'static/style.css'), 'utf8');
  assert.ok(css.includes('.nav-item[data-page="demo"]{grid-column:3;grid-row:2}'), 'missing demo grid slot');
  assert.ok(css.includes('--nav-demo-color'), 'missing demo nav color');
});

// --- VM sandbox: real script, no DOM (load-time code touches only window) ---
const ctx = vm.createContext({ window: {}, console });
vm.runInContext(src, ctx, { filename: 'assistant-demo.js' });
const demo = ctx.window.__ademo;

function resetEnt(x, y) {
  const e = demo.ent;
  e.x = x; e.y = y; e.w = 48; e.h = 64;
  e.vx = 0; e.vy = 0; e.facing = 1; e.onGround = false; e.moveTarget = null;
  demo.keys.left = demo.keys.right = demo.keys.down = demo.keys.shift = demo.keys.ctrl = false;
  demo.clearBodies();
  demo.stage.w = 800; demo.stage.h = 450;
}
// advance the world in 16ms slices (step clamps to 50ms internally)
function run(seconds) {
  let t = 0;
  while (t < seconds) { demo.step(0.016); t += 0.016; }
}

console.log('assistant demo state machine:');

check('SM: default falls back to first registered when no idle alias configured', () => {
  demo.sm.reset();
  demo.sm.register('walk', { cols: 1, rows: 1, start: 0, end: 0, fps: 8, frameW: 32, frameH: 32 });
  assert.strictEqual(demo.sm.current(), 'walk', 'first registered should become current');
  demo.sm.setEvent('jump'); // no jump/leap configured -> default
  assert.strictEqual(demo.sm.current(), 'walk', 'unconfigured event must fall back to default');
});

check('SM: alias resolution picks first configured candidate', () => {
  demo.sm.reset();
  demo.sm.register('idle', { cols: 1, rows: 1, start: 0, end: 0, fps: 8, frameW: 32, frameH: 32 });
  demo.sm.register('run', { cols: 1, rows: 1, start: 0, end: 0, fps: 8, frameW: 32, frameH: 32 });
  demo.sm.setEvent('walk'); // walk aliases [walk, move, run] -> only run configured
  assert.strictEqual(demo.sm.current(), 'run', 'walk event should resolve to run action');
  demo.sm.setEvent('idle');
  assert.strictEqual(demo.sm.current(), 'idle');
});

check('SM: tick advances frames at fps and loops inside [start,end]', () => {
  demo.sm.reset();
  const img = { naturalWidth: 128, naturalHeight: 32 };
  demo.sm.register('idle', { img, cols: 4, rows: 1, start: 0, end: 3, fps: 10 });
  demo.sm.setEvent('idle');
  let fr = demo.sm.frame();
  assert.strictEqual(fr.sx, 0, 'frame 0 at sx=0');
  assert.strictEqual(fr.w, 32, 'frameW = sheet width / cols');
  demo.sm.tick(100); // 1000/10 = 100ms per frame -> frame 1
  fr = demo.sm.frame();
  assert.strictEqual(fr.sx, 32, 'frame 1 at sx=32 after 100ms');
  demo.sm.tick(300); // frames 2, 3, then loop to 0
  fr = demo.sm.frame();
  assert.strictEqual(fr.sx, 0, 'frames must loop back to start');
});

console.log('assistant demo physics:');

check('gravity: airborne entity falls to the stage floor and lands', () => {
  resetEnt(40, 100);
  run(1.0);
  const e = demo.ent;
  assert.strictEqual(e.y, 450 - 64, 'must rest on the floor');
  assert.strictEqual(e.vy, 0);
  assert.strictEqual(e.onGround, true);
});

check('jump: rises then lands back on the floor', () => {
  resetEnt(40, 450 - 64);
  demo.step(0.016); // settle -> onGround
  assert.strictEqual(demo.tryJump(), true, 'jump must fire while grounded');
  let minY = demo.ent.y;
  run(1.5);
  // track during a second pass for min height
  resetEnt(40, 450 - 64);
  demo.step(0.016);
  demo.tryJump();
  for (let i = 0; i < 100; i++) { demo.step(0.016); if (demo.ent.y < minY) minY = demo.ent.y; }
  assert.ok(minY < 450 - 64 - 80, 'jump should rise at least 80px, rose ' + (450 - 64 - minY));
  assert.strictEqual(demo.ent.y, 450 - 64, 'must land back on the floor');
  assert.strictEqual(demo.ent.onGround, true);
});

check('jump blocked while airborne', () => {
  resetEnt(40, 100); // in the air
  assert.strictEqual(demo.tryJump(), false, 'no double jump');
});

check('walk / Shift slow / Ctrl run speeds are distinct and ordered', () => {
  function distance(mod) {
    resetEnt(40, 450 - 64);
    demo.step(0.016);
    demo.keys.right = true;
    if (mod === 'shift') demo.keys.shift = true;
    if (mod === 'ctrl') demo.keys.ctrl = true;
    run(1.0);
    return demo.ent.x - 40;
  }
  const slow = distance('shift');
  const walk = distance(null);
  const fast = distance('ctrl');
  assert.ok(Math.abs(slow - 70) < 8, 'slow ~= 70px/s, got ' + slow);
  assert.ok(Math.abs(walk - 160) < 8, 'walk ~= 160px/s, got ' + walk);
  assert.ok(Math.abs(fast - 340) < 8, 'run ~= 340px/s, got ' + fast);
  assert.ok(slow < walk && walk < fast, 'speeds must be ordered slow < walk < run');
});

check('walls clamp horizontal movement', () => {
  resetEnt(40, 450 - 64);
  demo.step(0.016);
  demo.keys.left = true;
  run(1.0);
  assert.strictEqual(demo.ent.x, 0, 'left wall clamps at x=0');
});

check('collider: falling entity lands on body top', () => {
  resetEnt(40, 100);
  demo.addBody({ x: 0, y: 300, w: 800, h: 20 });
  run(1.0);
  const e = demo.ent;
  assert.strictEqual(e.y, 300 - 64, 'must rest on the body top');
  assert.strictEqual(e.onGround, true);
});

check('collider: side blocks horizontal walk', () => {
  resetEnt(40, 450 - 64);
  demo.step(0.016);
  demo.addBody({ x: 200, y: 300, w: 20, h: 150 }); // wall from floor up
  demo.keys.right = true;
  run(1.5);
  const e = demo.ent;
  assert.ok(e.x <= 200 - 48 + 0.5, 'must not penetrate the wall, x=' + e.x);
  assert.ok(e.x >= 200 - 48 - 1, 'should be pushed against the wall, x=' + e.x);
});

check('collider: head bump stops upward motion', () => {
  resetEnt(40, 450 - 64);
  demo.step(0.016);
  demo.addBody({ x: 0, y: 250, w: 800, h: 20 }); // ceiling slab, bottom at 270
  demo.tryJump();
  let minY = 1e9;
  for (let i = 0; i < 100; i++) { demo.step(0.016); if (demo.ent.y < minY) minY = demo.ent.y; }
  assert.ok(minY >= 269.5, 'head must not pass the slab bottom (270), minY=' + minY);
  assert.strictEqual(demo.ent.onGround, true, 'must land back');
});

console.log('assistant demo move target (right-click):');

check('move target: walks to x and clears on arrival', () => {
  resetEnt(100, 450 - 64);
  demo.step(0.016);
  demo.ent.moveTarget = { x: 300, y: null };
  run(2.0);
  const e = demo.ent;
  assert.strictEqual(e.x, 300, 'must arrive exactly at the target');
  assert.strictEqual(e.moveTarget, null, 'target must clear after arrival');
  assert.strictEqual(Math.round(e.vx), 0, 'stops after arrival');
});

check('move target: manual arrow key cancels it', () => {
  resetEnt(100, 450 - 64);
  demo.step(0.016);
  demo.ent.moveTarget = { x: 300, y: null };
  demo.step(0.016);
  demo.keys.right = true;
  demo.step(0.016);
  assert.strictEqual(demo.ent.moveTarget, null, 'manual input must cancel the target');
});

check('move target: direction left sets facing', () => {
  resetEnt(400, 450 - 64);
  demo.step(0.016);
  demo.ent.moveTarget = { x: 100, y: null };
  demo.step(0.016);
  assert.strictEqual(demo.ent.facing, -1, 'walking left must face left');
});

console.log('assistant demo motion events:');

check('motionEvent maps movement state to animation events', () => {
  resetEnt(40, 450 - 64);
  demo.step(0.016);
  assert.strictEqual(demo.motionEvent(), 'idle');
  demo.keys.right = true;
  demo.step(0.016);
  assert.strictEqual(demo.motionEvent(), 'move_right');
  demo.keys.ctrl = true;
  demo.step(0.016);
  assert.strictEqual(demo.motionEvent(), 'run');
  demo.keys.ctrl = false; demo.keys.right = false;
  demo.tryJump();
  demo.step(0.016);
  assert.strictEqual(demo.motionEvent(), 'jump');
});

console.log('assistant demo topdown (Survivor):');

function resetTopdown(x, y) {
  demo.setType('topdown');
  const e = demo.ent;
  e.x = x; e.y = y; e.w = 48; e.h = 64;
  e.vx = 0; e.vy = 0; e.facing = 1; e.attackUntil = 0; e.moveTarget = null;
  demo.keys.left = demo.keys.right = demo.keys.up = demo.keys.down = demo.keys.shift = demo.keys.ctrl = false;
  demo.aim.active = false;
  demo.clearBodies();
  demo.stage.w = 800; demo.stage.h = 450;
}

check('topdown: no gravity — idle entity floats, up key moves up', () => {
  resetTopdown(100, 200);
  run(1.0);
  assert.strictEqual(demo.ent.y, 200, 'no gravity: y must not change while idle');
  assert.strictEqual(demo.ent.onGround, true, 'topdown reports grounded for HUD/jump consistency');
  demo.keys.up = true;
  run(0.5);
  const moved = 200 - demo.ent.y;
  assert.ok(Math.abs(moved - 160 * 0.5) < 2, 'up key walks up at walk speed, got ' + moved);
});

check('topdown: diagonal movement is normalized to walk speed', () => {
  resetTopdown(100, 200);
  demo.keys.right = true; demo.keys.down = true;
  run(1.0);
  const dx = demo.ent.x - 100, dy = demo.ent.y - 200;
  const expect = 160 * Math.SQRT1_2;
  assert.ok(Math.abs(dx - expect) < 2 && Math.abs(dy - expect) < 2,
    'diagonal axes must each move walk/sqrt(2), got dx=' + dx + ' dy=' + dy);
});

check('topdown: mouse aim drives facing, movement is the fallback', () => {
  resetTopdown(100, 200);
  demo.aim.active = true; demo.aim.x = 10; // left of the entity center
  run(0.05);
  assert.strictEqual(demo.ent.facing, -1, 'aim left of the sprite must face left');
  demo.aim.x = 700;
  run(0.05);
  assert.strictEqual(demo.ent.facing, 1, 'aim right of the sprite must face right');
  demo.aim.active = false;
  demo.keys.left = true;
  run(0.05);
  assert.strictEqual(demo.ent.facing, -1, 'without aim, movement direction drives facing');
});

check('topdown: attack holds the attack event then falls back to idle', () => {
  resetTopdown(100, 200);
  assert.strictEqual(demo.attack(), true, 'attack must fire in topdown');
  assert.strictEqual(demo.motionEvent(), 'attack', 'attack window must surface the attack event');
  demo.ent.attackUntil = 0; // expire
  assert.strictEqual(demo.motionEvent(), 'idle', 'expired attack falls back to idle');
  demo.setType('scroller');
  assert.strictEqual(demo.attack(), false, 'attack is topdown-only');
});

check('topdown: collider blocks horizontal walk', () => {
  resetTopdown(100, 300);
  demo.addBody({ x: 200, y: 200, w: 20, h: 200 });
  demo.keys.right = true;
  run(2.0);
  assert.ok(demo.ent.x + demo.ent.w <= 200 + 0.5, 'body side must stop the entity, got x=' + demo.ent.x);
  assert.strictEqual(demo.ent.y, 300, 'blocked on X must not push on Y');
});

check('topdown: jump is disabled (scroller-only)', () => {
  resetTopdown(100, 200);
  demo.step(0.016);
  assert.strictEqual(demo.tryJump(), false, 'tryJump must refuse outside scroller');
  assert.strictEqual(demo.ent.vy, 0);
});

console.log('assistant demo types & scale:');

check('setType: level-1 switch resets subtype and respawns centered (topdown)', () => {
  demo.setType('topdown');
  assert.strictEqual(demo.persist.type2, 'Survivor');
  const e = demo.ent;
  assert.ok(Math.abs(e.x - (800 - e.w) / 2) < 1 && Math.abs(e.y - (450 - e.h) / 2) < 1,
    'topdown spawn must center the entity');
  demo.setType('isometric');
  assert.strictEqual(demo.persist.type2, 'Tactic');
  demo.setType('scroller');
  assert.strictEqual(demo.persist.type2, 'Platformer');
  const e2 = demo.ent;
  assert.strictEqual(e2.x, 40, 'scroller spawn returns to the left');
  assert.ok(Math.abs(e2.y - (450 - e2.h)) < 1, 'scroller spawn rests on the floor');
});

check('scale: applyScale clamps into 0.01-1.00 and resizes the entity', () => {
  demo.setType('scroller');
  demo.applyScale(5);
  assert.strictEqual(demo.persist.scale, 1, 'scale must clamp to the 1.00 slider max');
  demo.applyScale(0.001);
  assert.strictEqual(demo.persist.scale, 0.01, 'scale must clamp to the 0.01 slider min');
  demo.applyScale(0.5);
  const ref = demo.frameRef();
  assert.ok(Math.abs(demo.ent.w - ref.w * 0.5) < 0.001 && Math.abs(demo.ent.h - ref.h * 0.5) < 0.001,
    'entity box must follow frame size x scale (ScaleTo semantics)');
  demo.applyScale(1); // restore for any later checks
});

check('wiring: i18n defines new demo-type / ScaleTo / preset keys in en+cn', () => {
  const i18n = fs.readFileSync(path.join(__dirname, 'static/i18n.js'), 'utf8');
  ['demoTypeTopdown', 'demoTypeIsometric', 'demoSubSurvivor', 'demoSubTactic',
   'demoScaleToW', 'demoScaleToH', 'demoHintTopdown', 'demoHintTactic',
   'demoBgMode', 'demoBgFitWidth', 'demoBgFitHeight', 'demoBgPixel',
   'assistantPresetPlatformer', 'assistantPresetTopdown', 'assistantPresetPet', 'assistantPresetMove',
   'assistantStateGroupPet', 'assistantStateGroupPlatformer', 'assistantStateGroupTopdown', 'assistantGroupMove',
   'assistantGroupOther', 'assistantDemoNotOpen'
  ].forEach(k => {
    const hits = i18n.split(k + ':').length - 1;
    assert.ok(hits >= 2, k + ' must exist in both en and cn (found ' + hits + ')');
  });
});

check('topdown: right-click move target walks to the 2D point and clears', () => {
  resetTopdown(100, 300);
  demo.ent.moveTarget = { x: 400, y: 100 };
  run(4.0);
  const e = demo.ent;
  assert.ok(Math.abs(e.x - 400) < 2 && Math.abs(e.y - 100) < 2,
    'must arrive at the clicked point, got x=' + e.x + ' y=' + e.y);
  assert.strictEqual(e.moveTarget, null, 'target must clear after arrival');
  assert.ok(Math.abs(e.vx) < 1 && Math.abs(e.vy) < 1, 'stops after arrival');
});

check('topdown: manual keys cancel the move target', () => {
  resetTopdown(100, 300);
  demo.ent.moveTarget = { x: 400, y: 100 };
  demo.step(0.016);
  demo.keys.down = true;
  demo.step(0.016);
  assert.strictEqual(demo.ent.moveTarget, null, 'manual input must cancel the target');
});

console.log('assistant demo directional events:');

check('topdown: movement direction maps to directional events', () => {
  resetTopdown(400, 200);
  const cases = [
    { keys: { up: true, left: true }, ev: 'move_up_left' },
    { keys: { down: true, left: true }, ev: 'move_down_left' },
    { keys: { up: true }, ev: 'move_up' },
    { keys: { down: true }, ev: 'move_down' },
    { keys: { left: true }, ev: 'move_left' },
    { keys: { right: true }, ev: 'move_right' }
  ];
  for (const c of cases) {
    resetTopdown(400, 200);
    Object.assign(demo.keys, c.keys);
    demo.step(0.016);
    assert.strictEqual(demo.motionEvent(), c.ev, 'expected ' + c.ev + ' for ' + JSON.stringify(c.keys));
  }
  resetTopdown(400, 200);
  demo.keys.right = true; demo.keys.ctrl = true;
  demo.step(0.016);
  assert.strictEqual(demo.motionEvent(), 'run', 'ctrl still maps to run');
});

check('scroller: left movement maps to left-variant events', () => {
  demo.setType('scroller');
  resetEnt(400, 450 - 64);
  demo.keys.left = true;
  demo.step(0.016);
  assert.strictEqual(demo.motionEvent(), 'move_left', 'walking left must emit move_left');
  demo.keys.ctrl = true;
  demo.step(0.016);
  assert.strictEqual(demo.motionEvent(), 'run_left', 'running left must emit run_left');
  demo.keys.ctrl = false; demo.keys.left = false;
  demo.keys.right = true;
  demo.step(0.016);
  assert.strictEqual(demo.motionEvent(), 'move_right', 'walking right must emit move_right');
});

check('SM: left-variant states are flagged so the renderer skips mirroring', () => {
  demo.sm.reset();
  demo.sm.register('walk_left', { cols: 1, rows: 1, start: 0, end: 0, fps: 8, frameW: 32, frameH: 32 });
  demo.sm.register('idle', { cols: 1, rows: 1, start: 0, end: 0, fps: 8, frameW: 32, frameH: 32 });
  demo.sm.setEvent('walk_left');
  assert.strictEqual(demo.sm.currentIsLeftVariant(), true, 'walk_left must be a left variant');
  demo.sm.setEvent('idle');
  assert.strictEqual(demo.sm.currentIsLeftVariant(), false, 'idle is not a left variant');
});

console.log('assistant demo background modes:');

check('bgScale: fit-width / fit-height / pixel map to the right scale', () => {
  assert.strictEqual(demo.bgScale('fit-width', 200, 100, 800, 450), 4, 'fit-width = W/iw');
  assert.strictEqual(demo.bgScale('fit-height', 200, 100, 800, 450), 4.5, 'fit-height = H/ih');
  assert.strictEqual(demo.bgScale('pixel', 200, 100, 800, 450), 1, 'pixel = 1:1');
  assert.strictEqual(demo.bgScale('bogus', 200, 100, 800, 450), 4, 'unknown mode falls back to fit-width');
});

if (failures) { console.error(failures + ' check(s) failed'); process.exit(1); }
console.log('all assistant demo checks passed');
