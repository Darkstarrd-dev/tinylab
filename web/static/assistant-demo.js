// ===================== Assistant Demo Page (header nav F6) =====================
// 2D game-style test bed for assistant sprite interaction. Renders the
// configured assistant actions (Settings > Assistant) on a canvas stage with
// platformer physics: gravity, AABB collision bodies, keyboard movement
// (arrows + Shift slow / Ctrl run / Space jump) and right-click move-to.
//
// Everything here is demo-page-local: no pet-window or global assistant
// behavior is touched. Background image and collision bodies persist only in
// this module's memory (survive page switches within the session).
//
// Backend reuse (no new endpoints):
//   - GET /api/settings                     -> assistant.actions[] config
//   - GET /api/assistant/sheet-image/{name} -> spritesheet per action
//   - POST /api/browse                      -> native file picker (background)
//   - POST /api/assistant/sheet-preview     -> serve picked background image
//
// Test seam: window.__ademo exposes the state machine, entity and step()
// so web/assistant-demo.test.js can drive physics in a VM without a DOM.
'use strict';

// ---- tunables ------------------------------------------------------------
var ADEMO_GRAVITY = 2200;      // px/s^2
var ADEMO_JUMP_VEL = 760;      // px/s
var ADEMO_SPEED_SLOW = 70;     // Shift held
var ADEMO_SPEED_WALK = 160;    // default
var ADEMO_SPEED_RUN = 340;     // Ctrl held
var ADEMO_FASTFALL = 1400;     // extra Down-arrow gravity while airborne
var ADEMO_TERMINAL_VY = 1600;
var ADEMO_MIN_BODY = 8;        // px, smallest draggable collider edge

// ---- persisted for the session (module lifetime) -------------------------
var ademoPersist = { bgPath: '', bodies: [], scale: 1.5 };

// ---- per-render runtime (torn down by cleanupAssistantDemo) --------------
var ademoRt = null; // {wrap, canvas, ctx, ro, raf, lastTs, bgImg, bodyMode, dragRect, bound:{...}}

// ---- input state ----------------------------------------------------------
var ademoKeys = { left: false, right: false, down: false, shift: false, ctrl: false };

// ---- stage geometry (CSS px) ----------------------------------------------
var ademoStage = { w: 800, h: 450 };

// ---- assistant entity ------------------------------------------------------
var ademoEnt = { x: 40, y: 0, w: 48, h: 64, vx: 0, vy: 0, facing: 1, onGround: false, moveTarget: null };

// ---- sprite state machine --------------------------------------------------
// States = configured assistant actions. Unlike the pet window's one-shot
// semantics, every demo state loops while active (game-style). setEvent()
// resolves an event through alias lists; events with no configured action
// fall back to the default (idle alias chain, else first registered).
var ademoSM = (function () {
  var states = {};   // name -> {img, cols, rows, start, end, fps, frameW, frameH}
  var order = [];
  var current = null;
  var frameIdx = 0, acc = 0;

  var EVENT_ALIASES = {
    idle: ['idle', 'stand', 'default'],
    walk: ['walk', 'move', 'run'],
    run: ['run', 'dash', 'walk', 'move'],
    jump: ['jump', 'leap'],
    fall: ['fall', 'jump', 'leap']
  };

  function resolveAliases(names) {
    for (var i = 0; i < names.length; i++) if (states[names[i]]) return names[i];
    return null;
  }
  function defaultName() { return resolveAliases(EVENT_ALIASES.idle) || order[0] || null; }

  function register(name, def) {
    if (!name || states[name]) return false;
    var cols = Math.max(1, def.cols || 1), rows = Math.max(1, def.rows || 1);
    var start = Math.max(0, def.start || 0);
    var end = Math.max(start, def.end === undefined ? start : def.end);
    if (end > cols * rows - 1) end = cols * rows - 1;
    states[name] = {
      img: def.img || null, cols: cols, rows: rows, start: start, end: end,
      fps: Math.max(1, def.fps || 8),
      frameW: (def.frameW || (def.img ? def.img.naturalWidth : 0)) / cols,
      frameH: (def.frameH || (def.img ? def.img.naturalHeight : 0)) / rows
    };
    order.push(name);
    if (!current) current = defaultName();
    return true;
  }

  function setEvent(ev) {
    var target = resolveAliases(EVENT_ALIASES[ev] || []) || defaultName();
    if (!target) { current = null; return false; }
    if (target === current) return true;
    current = target; frameIdx = 0; acc = 0;
    ademoSyncEntitySize();
    return true;
  }

  function tick(dtMs) {
    var st = states[current];
    if (!st) return;
    acc += dtMs;
    var step = 1000 / st.fps;
    var frames = st.end - st.start + 1;
    while (acc >= step) { acc -= step; frameIdx = (frameIdx + 1) % frames; }
  }

  function frame() {
    var st = states[current];
    if (!st || !st.img || !st.frameW || !st.frameH) return null;
    var f = st.start + (frameIdx % (st.end - st.start + 1));
    return {
      img: st.img,
      sx: (f % st.cols) * st.frameW,
      sy: Math.floor(f / st.cols) * st.frameH,
      w: st.frameW, h: st.frameH
    };
  }

  function frameSize() {
    var st = states[current];
    return st && st.frameW > 0 && st.frameH > 0 ? { w: st.frameW, h: st.frameH } : null;
  }

  return {
    register: register,
    setEvent: setEvent,
    tick: tick,
    frame: frame,
    frameSize: frameSize,
    current: function () { return current; },
    aliases: EVENT_ALIASES,
    hasActions: function () { return order.length > 0; },
    reset: function () { states = {}; order = []; current = null; frameIdx = 0; acc = 0; }
  };
})();

// ---- entity sizing ---------------------------------------------------------
// Box follows the current action's frame aspect x user scale; feet stay put
// when the size changes (action switch / scale slider).
function ademoSyncEntitySize() {
  var fs = ademoSM.frameSize();
  var s = ademoPersist.scale;
  var nw = fs ? Math.max(4, fs.w * s) : 48 * s;
  var nh = fs ? Math.max(4, fs.h * s) : 64 * s;
  var e = ademoEnt;
  e.x += (e.w - nw) / 2;
  e.y += e.h - nh;
  e.w = nw; e.h = nh;
  ademoClampEntity();
}

function ademoClampEntity() {
  var e = ademoEnt;
  if (e.x < 0) e.x = 0;
  if (e.x > ademoStage.w - e.w) e.x = Math.max(0, ademoStage.w - e.w);
  if (e.y > ademoStage.h - e.h) { e.y = ademoStage.h - e.h; if (e.vy > 0) { e.vy = 0; e.onGround = true; } }
}

function ademoTryJump() {
  if (!ademoEnt.onGround) return false;
  ademoEnt.vy = -ADEMO_JUMP_VEL;
  ademoEnt.onGround = false;
  return true;
}

// ---- physics ----------------------------------------------------------------
function ademoOverlap(e, b) {
  return e.x < b.x + b.w && e.x + e.w > b.x && e.y < b.y + b.h && e.y + e.h > b.y;
}

// One fixed substep (<=8ms slices, driven by ademoStep) so fast falls cannot
// tunnel through thin colliders.
function ademoSubstep(dt) {
  var e = ademoEnt, st = ademoStage, bodies = ademoPersist.bodies;

  // --- horizontal intent: manual keys beat the right-click move target ---
  var dir = (ademoKeys.right ? 1 : 0) - (ademoKeys.left ? 1 : 0);
  var speed = ademoKeys.shift ? ADEMO_SPEED_SLOW : (ademoKeys.ctrl ? ADEMO_SPEED_RUN : ADEMO_SPEED_WALK);
  if (dir !== 0) {
    e.moveTarget = null;
  } else if (e.moveTarget != null) {
    var dx = e.moveTarget - e.x;
    if (Math.abs(dx) <= Math.max(2, ADEMO_SPEED_WALK * dt)) {
      e.x = e.moveTarget; e.moveTarget = null;
    } else {
      dir = dx > 0 ? 1 : -1;
      speed = ADEMO_SPEED_WALK;
    }
  }
  if (dir !== 0) e.facing = dir;
  e.vx = dir * speed;

  // --- vertical: gravity + fast-fall ---
  e.vy += ADEMO_GRAVITY * dt;
  if (ademoKeys.down && !e.onGround) e.vy += ADEMO_FASTFALL * dt;
  if (e.vy > ADEMO_TERMINAL_VY) e.vy = ADEMO_TERMINAL_VY;

  // --- X axis: walls + collider sides ---
  e.x += e.vx * dt;
  if (e.x < 0) e.x = 0;
  if (e.x > st.w - e.w) e.x = st.w - e.w;
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i];
    if (!ademoOverlap(e, b)) continue;
    if (e.vx > 0) e.x = b.x - e.w;
    else if (e.vx < 0) e.x = b.x + b.w;
    else { e.x = (e.x + e.w / 2 < b.x + b.w / 2) ? b.x - e.w : b.x + b.w; }
  }

  // --- Y axis: ceiling, collider tops/bottoms, stage floor ---
  var prevBottom = e.y + e.h;
  var prevTop = e.y;
  e.y += e.vy * dt;
  e.onGround = false;
  if (e.y < 0) { e.y = 0; if (e.vy < 0) e.vy = 0; }
  for (var j = 0; j < bodies.length; j++) {
    var bb = bodies[j];
    if (!ademoOverlap(e, bb)) continue;
    if (e.vy > 0 && prevBottom <= bb.y + 0.5) {          // landed on top
      e.y = bb.y - e.h; e.vy = 0; e.onGround = true;
    } else if (e.vy < 0 && prevTop >= bb.y + bb.h - 0.5) { // bumped head
      e.y = bb.y + bb.h; e.vy = 0;
    } else {                                             // wedged: minimal push
      var pushUp = e.y + e.h - bb.y, pushDown = bb.y + bb.h - e.y;
      if (pushUp <= pushDown) { e.y = bb.y - e.h; e.vy = 0; e.onGround = true; }
      else { e.y = bb.y + bb.h; if (e.vy < 0) e.vy = 0; }
    }
  }
  if (e.y + e.h >= st.h) { e.y = st.h - e.h; e.vy = 0; e.onGround = true; }
}

function ademoStep(dtSec) {
  var remain = Math.min(Math.max(dtSec, 0), 0.05);
  while (remain > 0) {
    var dt = Math.min(remain, 0.008);
    ademoSubstep(dt);
    remain -= dt;
  }
}

// Pick the animation event from the entity's current motion.
function ademoMotionEvent() {
  var e = ademoEnt;
  if (!e.onGround) return e.vy < 0 ? 'jump' : 'fall';
  if (Math.abs(e.vx) > 1) return ademoKeys.ctrl && !ademoKeys.shift && (ademoKeys.left || ademoKeys.right) ? 'run' : 'walk';
  return 'idle';
}

// ---- background -------------------------------------------------------------
async function ademoPickBackground() {
  if (typeof beginNativePickerLock === 'function' && !beginNativePickerLock('file')) return;
  try {
    var res = await apiPost('/browse', {
      mode: 'file',
      initialPath: ademoPersist.bgPath || '',
      filter: 'Images (*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp)|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp|All Files (*.*)|*.*'
    });
    if (!res || !res.path) return;
    ademoPersist.bgPath = res.path;
    await ademoReloadBackground();
    ademoSyncToolbar();
  } catch (e) {
    console.warn('demo background browse failed:', e);
    toast(t('failed', [e.message]), 'error');
  } finally {
    if (typeof endNativePickerLock === 'function') endNativePickerLock();
  }
}

// Register bgPath with sheet-preview and load it (fresh 1h-TTL id each time,
// so revisiting the page after expiry still works while the file exists).
async function ademoReloadBackground() {
  if (!ademoRt || !ademoPersist.bgPath) return;
  try {
    var reg = await apiPost('/assistant/sheet-preview', { path: ademoPersist.bgPath });
    if (!reg || !reg.previewId) throw new Error((reg && reg.error) || 'preview register failed');
    var img = new Image();
    img.onload = function () { if (ademoRt) ademoRt.bgImg = img; };
    img.onerror = function () {
      ademoPersist.bgPath = '';
      if (ademoRt) ademoRt.bgImg = null;
      ademoSyncToolbar();
    };
    img.src = '/api/assistant/sheet-preview/' + encodeURIComponent(reg.previewId);
  } catch (e) {
    ademoPersist.bgPath = '';
    if (ademoRt) ademoRt.bgImg = null;
    ademoSyncToolbar();
    toast(t('failed', [e.message]), 'error');
  }
}

// ---- collision bodies ---------------------------------------------------------
function ademoAddBody(b) {
  ademoPersist.bodies.push(b);
  ademoSyncToolbar();
}
function ademoUndoBody() {
  ademoPersist.bodies.pop();
  ademoSyncToolbar();
}
function ademoClearBodies() {
  ademoPersist.bodies.length = 0;
  ademoSyncToolbar();
}

// ---- toolbar sync --------------------------------------------------------------
function ademoSyncToolbar() {
  if (!ademoRt) return;
  var q = function (id) { return ademoRt.wrap.querySelector(id); };
  var count = q('.ademo-body-count');
  if (count) count.textContent = t('demoBodyCount', [String(ademoPersist.bodies.length)]);
  var undo = q('.ademo-undo-body');
  if (undo) undo.disabled = ademoPersist.bodies.length === 0;
  var clear = q('.ademo-clear-bodies');
  if (clear) clear.disabled = ademoPersist.bodies.length === 0;
  var clearBg = q('.ademo-clear-bg');
  if (clearBg) clearBg.disabled = !ademoPersist.bgPath;
  var addBtn = q('.ademo-add-body');
  if (addBtn) {
    addBtn.textContent = ademoRt.bodyMode ? t('demoAddingBody') : t('demoAddBody');
    addBtn.classList.toggle('btn-accent', !!ademoRt.bodyMode);
  }
  if (ademoRt.canvas) ademoRt.canvas.classList.toggle('ademo-draw-mode', !!ademoRt.bodyMode);
  var noAct = q('.ademo-no-actions');
  if (noAct) noAct.style.display = ademoSM.hasActions() ? 'none' : '';
}

function ademoSetBodyMode(on) {
  if (!ademoRt) return;
  ademoRt.bodyMode = !!on;
  ademoRt.dragRect = null;
  ademoSyncToolbar();
}

// ---- drawing -------------------------------------------------------------------
function ademoDraw() {
  var rt = ademoRt;
  if (!rt || !rt.ctx) return;
  var ctx = rt.ctx, W = ademoStage.w, H = ademoStage.h;

  // backdrop
  ctx.clearRect(0, 0, W, H);
  if (rt.bgImg) {
    var iw = rt.bgImg.naturalWidth, ih = rt.bgImg.naturalHeight;
    if (iw > 0 && ih > 0) {
      var s = Math.max(W / iw, H / ih);
      ctx.drawImage(rt.bgImg, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
    }
  }

  // collision bodies
  var accent = rt.accent || '56,189,248';
  ctx.fillStyle = 'rgba(' + accent + ',0.25)';
  ctx.strokeStyle = 'rgba(' + accent + ',0.9)';
  ctx.lineWidth = 1.5;
  var bodies = ademoPersist.bodies;
  for (var i = 0; i < bodies.length; i++) {
    ctx.fillRect(bodies[i].x, bodies[i].y, bodies[i].w, bodies[i].h);
    ctx.strokeRect(bodies[i].x + 0.5, bodies[i].y + 0.5, bodies[i].w - 1, bodies[i].h - 1);
  }

  // in-progress body drag rect
  if (rt.dragRect) {
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rt.dragRect.x + 0.5, rt.dragRect.y + 0.5, rt.dragRect.w - 1, rt.dragRect.h - 1);
    ctx.setLineDash([]);
  }

  // assistant sprite
  var e = ademoEnt;
  var fr = ademoSM.frame();
  if (fr) {
    ctx.save();
    if (e.facing < 0) {
      ctx.translate(e.x + e.w / 2, e.y);
      ctx.scale(-1, 1);
      ctx.drawImage(fr.img, fr.sx, fr.sy, fr.w, fr.h, -e.w / 2, 0, e.w, e.h);
    } else {
      ctx.translate(e.x, e.y);
      ctx.drawImage(fr.img, fr.sx, fr.sy, fr.w, fr.h, 0, 0, e.w, e.h);
    }
    ctx.restore();
  } else {
    // placeholder blob (no actions configured / sheet unreachable)
    ctx.fillStyle = 'rgba(' + accent + ',0.85)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(e.x, e.y, e.w, e.h, Math.min(10, e.w / 4));
    else ctx.rect(e.x, e.y, e.w, e.h);
    ctx.fill();
    ctx.fillStyle = '#0b0c13';
    var eyeY = e.y + e.h * 0.3, eyeR = Math.max(2, e.w * 0.07);
    var eyeOff = e.w * 0.18 + e.facing * e.w * 0.06;
    ctx.beginPath();
    ctx.arc(e.x + e.w / 2 - eyeOff, eyeY, eyeR, 0, Math.PI * 2);
    ctx.arc(e.x + e.w / 2 + eyeOff, eyeY, eyeR, 0, Math.PI * 2);
    ctx.fill();
  }

  // HUD readout (debug surface: raw English on purpose)
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(6, 6, 330, 40);
  ctx.fillStyle = '#e5e7eb';
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText('state=' + (ademoSM.current() || '-') + '  event=' + ademoMotionEvent() +
    '  ground=' + e.onGround + '  facing=' + (e.facing < 0 ? 'L' : 'R'), 12, 12);
  ctx.fillText('x=' + Math.round(e.x) + ' y=' + Math.round(e.y) +
    '  vx=' + Math.round(e.vx) + ' vy=' + Math.round(e.vy) +
    '  bodies=' + bodies.length + (rt.bodyMode ? '  [DRAW MODE]' : ''), 12, 28);
}

// ---- frame loop -----------------------------------------------------------------
function ademoLoop(ts) {
  var rt = ademoRt;
  if (!rt) return;
  if (rt.lastTs == null) rt.lastTs = ts;
  var dtMs = Math.min(ts - rt.lastTs, 100);
  rt.lastTs = ts;
  ademoStep(dtMs / 1000);
  ademoSM.setEvent(ademoMotionEvent());
  ademoSM.tick(dtMs);
  ademoDraw();
  rt.raf = requestAnimationFrame(ademoLoop);
}

// ---- canvas sizing ----------------------------------------------------------------
function ademoResize() {
  var rt = ademoRt;
  if (!rt || !rt.canvas || !rt.stageWrap) return;
  var w = rt.stageWrap.clientWidth, h = rt.stageWrap.clientHeight;
  if (w < 10 || h < 10) return;
  var dpr = window.devicePixelRatio || 1;
  rt.canvas.width = Math.round(w * dpr);
  rt.canvas.height = Math.round(h * dpr);
  rt.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ademoStage.w = w;
  ademoStage.h = h;
  ademoClampEntity();
}

// ---- input handlers ------------------------------------------------------------------
function ademoIsFormTarget(e) {
  var tag = e.target && e.target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
}

// Capture-phase so a body-draw Escape is consumed before app.js's global
// Escape (which would shut the server down).
function ademoOnKeyDown(e) {
  if (!ademoRt) return;
  if (typeof topOpenModal === 'function' && topOpenModal()) return;
  if (ademoIsFormTarget(e)) return;

  if (e.key === 'Escape' && ademoRt.bodyMode) {
    e.preventDefault();
    e.stopPropagation();
    ademoSetBodyMode(false);
    return;
  }

  switch (e.key) {
    case 'ArrowLeft': ademoKeys.left = true; break;
    case 'ArrowRight': ademoKeys.right = true; break;
    case 'ArrowDown': ademoKeys.down = true; break;
    case 'ArrowUp':
      if (!e.repeat) ademoTryJump();
      break;
    case ' ':
      if (!e.repeat) ademoTryJump();
      break;
    case 'Shift': ademoKeys.shift = true; return;
    case 'Control': ademoKeys.ctrl = true; return;
    default: return;
  }
  e.preventDefault();
}

function ademoOnKeyUp(e) {
  if (!ademoRt) return;
  switch (e.key) {
    case 'ArrowLeft': ademoKeys.left = false; break;
    case 'ArrowRight': ademoKeys.right = false; break;
    case 'ArrowDown': ademoKeys.down = false; break;
    case 'Shift': ademoKeys.shift = false; break;
    case 'Control': ademoKeys.ctrl = false; break;
  }
}

function ademoOnBlur() {
  ademoKeys.left = ademoKeys.right = ademoKeys.down = ademoKeys.shift = ademoKeys.ctrl = false;
}

function ademoStagePos(e) {
  var rect = ademoRt.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function ademoNormRect(a, b) {
  return {
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y)
  };
}

// ---- action loading ------------------------------------------------------------------
function ademoLoadActions() {
  ademoSM.reset();
  ademoSyncToolbar();
  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (s) {
    var actions = ((s && s.assistant) || {}).actions || [];
    var pending = 0;
    actions.forEach(function (a) {
      if (!a || !a.spritesheetPath || !a.name) return;
      pending++;
      var img = new Image();
      img.onload = function () {
        ademoSM.register(a.name, {
          img: img, cols: a.cols, rows: a.rows,
          start: a.frameStart, end: a.frameEnd, fps: a.fps
        });
        if (--pending <= 0) ademoSM.setEvent('idle');
        ademoSyncEntitySize();
        ademoSyncToolbar();
      };
      img.onerror = function () { if (--pending <= 0) ademoSM.setEvent('idle'); };
      img.src = '/api/assistant/sheet-image/' + encodeURIComponent(a.name);
    });
    if (pending === 0) ademoSyncToolbar();
  }).catch(function () { ademoSyncToolbar(); });
}

// ---- page lifecycle --------------------------------------------------------------------
function renderAssistantDemo(container) {
  cleanupAssistantDemo();

  container.innerHTML =
    '<div class="ademo-root">' +
      '<div class="ademo-toolbar">' +
        '<span class="ademo-title">' + escapeHtml(t('demoTitle')) + '</span>' +
        '<button type="button" class="btn ademo-set-bg">' + escapeHtml(t('demoSetBackground')) + '</button>' +
        '<button type="button" class="btn btn-ghost ademo-clear-bg">' + escapeHtml(t('demoClearBackground')) + '</button>' +
        '<span class="ademo-sep"></span>' +
        '<button type="button" class="btn ademo-add-body">' + escapeHtml(t('demoAddBody')) + '</button>' +
        '<button type="button" class="btn btn-ghost ademo-undo-body">' + escapeHtml(t('demoUndoBody')) + '</button>' +
        '<button type="button" class="btn btn-ghost ademo-clear-bodies">' + escapeHtml(t('demoClearBodies')) + '</button>' +
        '<span class="ademo-body-count"></span>' +
        '<span class="ademo-sep"></span>' +
        '<label class="ademo-scale-label">' + escapeHtml(t('demoScale')) +
          ' <input type="range" class="ademo-scale" min="0.5" max="4" step="0.25" value="' + ademoPersist.scale + '">' +
        '</label>' +
        '<span class="ademo-no-actions" data-tooltip="' + escapeHtml(t('demoNoActions')) + '">!</span>' +
      '</div>' +
      '<div class="ademo-stage-wrap"><canvas class="ademo-stage"></canvas></div>' +
      '<div class="ademo-hint">' + escapeHtml(t('demoHint')) + '</div>' +
    '</div>';

  var wrap = container.querySelector('.ademo-root');
  var stageWrap = container.querySelector('.ademo-stage-wrap');
  var canvas = container.querySelector('.ademo-stage');
  var accentRaw = '';
  try {
    var hex = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim();
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (m) accentRaw = parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16);
  } catch (e0) {}

  ademoRt = {
    wrap: wrap, stageWrap: stageWrap, canvas: canvas,
    ctx: canvas.getContext('2d'),
    ro: null, raf: 0, lastTs: null,
    bgImg: null, bodyMode: false, dragStart: null, dragRect: null,
    accent: accentRaw || '56,189,248'
  };

  // --- toolbar bindings ---
  wrap.querySelector('.ademo-set-bg').addEventListener('click', ademoPickBackground);
  wrap.querySelector('.ademo-clear-bg').addEventListener('click', function () {
    ademoPersist.bgPath = '';
    if (ademoRt) ademoRt.bgImg = null;
    ademoSyncToolbar();
  });
  wrap.querySelector('.ademo-add-body').addEventListener('click', function () {
    ademoSetBodyMode(!ademoRt.bodyMode);
  });
  wrap.querySelector('.ademo-undo-body').addEventListener('click', ademoUndoBody);
  wrap.querySelector('.ademo-clear-bodies').addEventListener('click', ademoClearBodies);
  var scaleInput = wrap.querySelector('.ademo-scale');
  scaleInput.addEventListener('input', function () {
    ademoPersist.scale = parseFloat(scaleInput.value) || 1.5;
    ademoSyncEntitySize();
  });
  scaleInput.addEventListener('change', function () { scaleInput.blur(); });

  // --- stage mouse: right-click move + body drawing ---
  canvas.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (!ademoRt || ademoRt.bodyMode) return;
    var p = ademoStagePos(e);
    var tx = Math.max(0, Math.min(ademoStage.w - ademoEnt.w, p.x - ademoEnt.w / 2));
    ademoEnt.moveTarget = tx;
  });
  canvas.addEventListener('mousedown', function (e) {
    if (!ademoRt || !ademoRt.bodyMode || e.button !== 0) return;
    ademoRt.dragStart = ademoStagePos(e);
    ademoRt.dragRect = null;
  });
  canvas.addEventListener('mousemove', function (e) {
    if (!ademoRt || !ademoRt.dragStart) return;
    ademoRt.dragRect = ademoNormRect(ademoRt.dragStart, ademoStagePos(e));
  });
  canvas.addEventListener('mouseup', function (e) {
    if (!ademoRt || !ademoRt.dragStart || e.button !== 0) return;
    var r = ademoNormRect(ademoRt.dragStart, ademoStagePos(e));
    ademoRt.dragStart = null;
    ademoRt.dragRect = null;
    if (r.w >= ADEMO_MIN_BODY && r.h >= ADEMO_MIN_BODY) {
      ademoAddBody({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    }
  });
  canvas.addEventListener('mouseleave', function () {
    if (!ademoRt) return;
    ademoRt.dragStart = null;
    ademoRt.dragRect = null;
  });

  // --- keyboard (capture: demo Escape must beat the global shutdown key) ---
  window.addEventListener('keydown', ademoOnKeyDown, true);
  window.addEventListener('keyup', ademoOnKeyUp, true);
  window.addEventListener('blur', ademoOnBlur);

  // --- sizing ---
  if (window.ResizeObserver) {
    ademoRt.ro = new ResizeObserver(ademoResize);
    ademoRt.ro.observe(stageWrap);
  }
  ademoResize();

  // --- spawn entity on the floor ---
  ademoSyncEntitySize();
  ademoEnt.x = 40;
  ademoEnt.y = ademoStage.h - ademoEnt.h;
  ademoEnt.vx = 0; ademoEnt.vy = 0; ademoEnt.onGround = true; ademoEnt.moveTarget = null;

  ademoLoadActions();
  if (ademoPersist.bgPath) ademoReloadBackground();
  ademoSyncToolbar();
  ademoRt.raf = requestAnimationFrame(ademoLoop);
}

function cleanupAssistantDemo() {
  if (!ademoRt) return;
  cancelAnimationFrame(ademoRt.raf);
  if (ademoRt.ro) ademoRt.ro.disconnect();
  window.removeEventListener('keydown', ademoOnKeyDown, true);
  window.removeEventListener('keyup', ademoOnKeyUp, true);
  window.removeEventListener('blur', ademoOnBlur);
  ademoRt = null;
  ademoOnBlur();
}

// ---- test seam (web/assistant-demo.test.js) ---------------------------------------------
window.__ademo = {
  sm: ademoSM,
  ent: ademoEnt,
  keys: ademoKeys,
  persist: ademoPersist,
  stage: ademoStage,
  step: ademoStep,
  tryJump: ademoTryJump,
  motionEvent: ademoMotionEvent,
  syncSize: ademoSyncEntitySize,
  addBody: ademoAddBody,
  clearBodies: ademoClearBodies
};
