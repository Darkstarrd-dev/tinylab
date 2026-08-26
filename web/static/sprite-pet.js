// ===================== Sprite Pet page logic (L3 desktop pet) =====================
// Extracted from web/static/sprite-pet.html's inline <script> (verbatim move,
// no behavior change). Loaded by sprite-pet.html just before </body>, so the
// DOM is ready when this runs.
//
// Contents:
//   - Window drag: avatar mousedown + window mousemove/mouseup forwarding
//     incremental screen-deltas to the Go-bound window.movePetWindow (Win32
//     SetWindowPos in host_webview_windows.go::openPetWindow).
//   - Speech bubble: toggle/set message, send user intent to
//     POST /api/assistant/dispatch and show the dispatched tool name.
//   - Action state machine: states = configured Assistant actions; events
//     (drag/think/reply/notify/poke) switch animations via canonical alias
//     lists. Loop states play forever; one-shots return to the default.
//     Window size follows the active action's frame aspect (posted to the
//     host as CSS px + devicePixelRatio; host never guesses DPI).
//   - Events SSE subscription: assistant notifications pop the bubble.
'use strict';

// ---- postMessage bridge to the pet host (host_webview_windows.go::petOnMessage).
// Raw edge.Chromium has no Bind host objects; all native actions go through
// chrome.webview.postMessage JSON payloads.
function petPost(obj) {
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.postMessage(JSON.stringify(obj));
  }
}

// ---- click-through hit regions: report the window-relative rects of every
// interactive element (avatar, close button, bubble, input row). The host
// polls the cursor every 80ms and toggles WS_EX_TRANSPARENT so clicks fall
// through all transparent regions. ResizeObserver tracks bubble growth from
// text; explicit petPostHit() calls cover toggle/scale/side changes.
function petPostHit() {
  var sel = ['#pet-avatar', '.pet-close-btn', '#pet-bubble', '.pet-input-row', '#pet-ctxmenu'];
  var rects = [];
  sel.forEach(function (q) {
    var el = document.querySelector(q);
    if (!el) return;
    var st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    // 8px 外扩：盖住 bounce 动画位移（±6px，transform 不触发 RO）与阴影，
    // 避免 SetWindowRgn 裁掉精灵/气泡边缘
    rects.push([Math.round(r.left) - 8, Math.round(r.top) - 8, Math.round(r.width) + 16, Math.round(r.height) + 16]);
  });
  petPost({ type: 'hit', rects: rects, vp: [window.innerWidth, window.innerHeight], scr: [window.screenX, window.screenY] });
}
window.petPostHit = petPostHit;

// RO 首次回调可能早于布局稳定（捕获到过期矩形且尺寸不变时不再触发），
// 因此叠加 load/双 rAF 与 300ms 周期重报兜底
window.addEventListener('DOMContentLoaded', function () { if (window.updateSide) window.updateSide(); postPetSize(); });
window.addEventListener('load', petPostHit);
requestAnimationFrame(function () { requestAnimationFrame(petPostHit); });
setInterval(petPostHit, 300);
if (window.ResizeObserver) {
  var ro = new ResizeObserver(function () { positionBubble(); petPostHit(); });
  ['#pet-bubble', '.pet-input-row', '#pet-avatar', '#pet-ctxmenu'].forEach(function (q) {
    var el = document.querySelector(q);
    if (el) ro.observe(el);
  });
}

// ---- drag: host tracks the physical-pixel cursor delta (DPI-safe), so the
// page only signals start/move/end. Move events throttled to >=2px deltas.
var isDragging = false;
var lastX = 0, lastY = 0;

var avatar = document.getElementById('pet-avatar');
avatar.addEventListener('mousedown', function(e) {
  if (e.target.closest('#pet-bubble')) return;
  if (e.button !== 0) return;
  e.preventDefault();
  isDragging = true;
  lastX = e.screenX;
  lastY = e.screenY;
  if (window.petSM) petSM.dispatch('drag');
  petPost({ type: 'dragstart' });
});

window.addEventListener('mousemove', function(e) {
  if (!isDragging) return;
  if (Math.abs(e.screenX - lastX) < 2 && Math.abs(e.screenY - lastY) < 2) return;
  lastX = e.screenX;
  lastY = e.screenY;
  petPost({ type: 'dragmove' });
});

window.addEventListener('mouseup', function(e) {
  if (isDragging && e.button === 0) {
    isDragging = false;
    if (window.petSM) petSM.dispatch('idle');
    petPost({ type: 'dragend' });
  }
});

// ---- HTML context menu (close/scale). Win32 TrackPopupMenu cannot be used:
// the WebView2 Chromium child holds mouse capture and dismisses it instantly.
var ctxmenu = document.getElementById('pet-ctxmenu');
var SCALE_LIST = [0.5, 0.75, 1.0, 1.25, 1.5];
var petScale = 1.0;

function buildPetScales() {
  if (!ctxmenu) return;
  var box = ctxmenu.querySelector('.pet-scales');
  box.innerHTML = '';
  SCALE_LIST.forEach(function (f) {
    var d = document.createElement('div');
    d.className = 'pet-scale-item' + (f === petScale ? ' active' : '');
    d.textContent = Math.round(f * 100) + '%';
    d.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    d.addEventListener('click', function () {
      petScale = f;
      if (window.setPetScale) window.setPetScale(f);
      petPost({ type: 'scale', f: f });
      hidePetMenu();
    });
    box.appendChild(d);
  });
}

function showPetMenu(x, y) {
  if (!ctxmenu) return;
  buildPetScales();
  ctxmenu.classList.add('show');
  var r = ctxmenu.getBoundingClientRect();
  ctxmenu.style.left = Math.max(2, Math.min(x, window.innerWidth - r.width - 2)) + 'px';
  ctxmenu.style.top = Math.max(2, Math.min(y, window.innerHeight - r.height - 2)) + 'px';
}

function hidePetMenu() { if (ctxmenu) ctxmenu.classList.remove('show'); }

window.addEventListener('mousedown', function (e) {
  if (e.button !== 2) {
    if (ctxmenu && !ctxmenu.contains(e.target)) hidePetMenu();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  showPetMenu(e.clientX, e.clientY);
});
window.addEventListener('contextmenu', function (e) { e.preventDefault(); });

avatar.addEventListener('dblclick', function (e) {
  if (e.target.closest('#pet-bubble')) return;
  if (window.petSM) petSM.dispatch('poke');
  var row = document.querySelector('.pet-input-row');
  if (row && row.classList.contains('show')) { hidePetInput(); } else { showPetInput(); }
});
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { hidePetInput(); hidePetMenu(); }
});
window.addEventListener('keydown', function (e) { if (e.key === 'Escape') hidePetMenu(); });

var miClose = document.getElementById('pet-mi-close');
if (miClose) miClose.addEventListener('click', function () {
  // 菜单关闭 = 关闭功能：持久化 assistant.enabled=false，Settings 页的
  // Assistant 开关随下次 renderEndpoint 重新拉取 /api/settings 自动同步为 OFF。
  // PATCH 失败（如未登录）也照常关窗，行为与旧版一致。
  try {
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant: { enabled: false } })
    }).catch(function () {});
  } catch (e) {}
  petPost({ type: 'close' });
});

// ---- scale: purely visual, applied in CSS. The page owns its CSS layout and
// posts the desired window size (CSS px + devicePixelRatio); the host only
// converts to physical px. Window width follows the active action's frame
// aspect; bubble/input keep their physical size.
window.setPetScale = function (f) {
  petScale = f;
  applyPetSpriteSize();
  postPetSize();
  positionBubble();
  petPostHit();
};

// ---- Action state machine ----------------------------------------------
// States = configured assistant actions (name + spritesheet + frame range +
// fps). dispatch(event) resolves an action via canonical alias lists (first
// configured match wins), else treats the event as an exact action name.
// The default state (idle alias, else first registered) loops forever; every
// other state is one-shot and returns to the default when its frame range
// finishes. register() doubles as the test seam (no img needed).
var petSM = (function () {
  var states = {};   // name -> {img, cols, rows, start, end, fps, frameW, frameH}
  var order = [];    // configured registration order (fallback chain)
  var current = null;
  var frameIdx = 0, acc = 0, lastTs = 0, started = false;

  // Canonical event -> candidate action names.
  var EVENT_ALIASES = {
    idle:   ['idle', 'stand', 'default'],
    drag:   ['drag', 'grab', 'move', 'walk'],
    think:  ['think', 'loading', 'busy', 'working'],
    reply:  ['reply', 'happy', 'talk', 'success'],
    error:  ['error', 'confused', 'sad'],
    notify: ['notify', 'alert', 'notice'],
    poke:   ['poke', 'click', 'wave', 'greet']
  };

  function resolve(names) {
    for (var i = 0; i < names.length; i++) if (states[names[i]]) return names[i];
    return null;
  }
  function defaultName() { return resolve(EVENT_ALIASES.idle) || order[0] || null; }

  function render() {
    var st = states[current];
    var canvas = document.getElementById('pet-sprite');
    if (!st || !st.img || !canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var frames = st.end - st.start + 1;
    var f = st.start + (frameIdx % frames);
    var sx = (f % st.cols) * st.frameW;
    var sy = Math.floor(f / st.cols) * st.frameH;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(st.img, sx, sy, st.frameW, st.frameH, 0, 0, canvas.width, canvas.height);
  }

  var frameIdx = 0, acc = 0, lastTs = null, started = false;

  function play(name, force) {
    if (current === name && !force) return true;
    current = name; frameIdx = 0; acc = 0; lastTs = null;
    var st = states[name];
    var canvas = document.getElementById('pet-sprite');
    if (canvas && st.img) {
      canvas.width = Math.max(1, Math.round(st.frameW));
      canvas.height = Math.max(1, Math.round(st.frameH));
      canvas.style.display = 'block';
    }
    var face = document.querySelector('.pet-face');
    if (face && st.img) face.style.display = 'none';
    applyPetSpriteSize();
    render();
    postPetSize();
    petPostHit();
    return true;
  }

  function tick(ts) {
    if (lastTs == null) { lastTs = ts; return; }
    var dt = ts - lastTs; lastTs = ts;
    var st = states[current];
    if (!st) return;
    acc += dt;
    var step = 1000 / Math.max(1, st.fps);
    while (acc >= step) {
      acc -= step;
      frameIdx++;
      if (frameIdx >= st.end - st.start + 1) {
        if (current === defaultName()) { frameIdx = 0; }
        else { play(returnTarget()); return; }
      }
    }
    render();
  }
  function returnTarget() { return defaultName() || current; }

  function startLoop() {
    if (started) return;
    started = true;
    var step = function (ts) { tick(ts); requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  function dispatch(evt) {
    var target = EVENT_ALIASES[evt] ? resolve(EVENT_ALIASES[evt]) : (states[evt] ? evt : null);
    if (!target) return false;
    return play(target);
  }

  // Surface current state + alias map for the settings state-machine panel,
  // without requiring a new HTTP round-trip to the pet window. The panel
  // reads these via chromium.Eval("window.__petState ...") or subscribes
  // to petPost({type:'state'}) -> host /api/assistant/pet-state.
  window.__petState = { cur: null, aliases: EVENT_ALIASES, names: function () { return order.slice(); } };
  // Wrap play/register to keep __petState.cur in sync (do not capture stale
  // closure — rebind after dispatch is defined so __petTrigger can see it).
  (function wrapPetState() {
    var _origPlay = play;
    play = function (name, force) {
      var ok = _origPlay(name, force);
      window.__petState.cur = current;
      try { petPost({ type: 'state', state: current }); } catch (e2) {}
      return ok;
    };
    var _origRegister = register;
    register = function (name, def) {
      var ok = _origRegister(name, def);
      window.__petState.cur = current;
      try { petPost({ type: 'state', state: current }); } catch (e2) {}
      return ok;
    };
  })();

  // Allow the settings panel to trigger any configured action remotely
  // (visual smoke test, no backend involvement): Eval "petSM.dispatch('poke')".
  // Expose a tiny trigger helper that also handles direct action names.
  window.__petTrigger = function (evt) {
    if (!evt) return false;
    if (dispatch(evt)) return true;
    if (states[evt]) return play(evt);
    return false;
  };
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
    if (!current) { play(defaultName(), true); startLoop(); }
    return true;
  }

  window.petSM = {
    dispatch: dispatch,
    play: function (n) { return play(n, false); },
    register: register,
    state: function () { return current; },
    defaultState: defaultName,
    aspect: function () { var st = states[current]; return st && st.frameH > 0 ? st.frameW / st.frameH : 0; },
    frame: function () { var st = states[current]; return st ? { w: st.frameW, h: st.frameH } : null; },
    _tick: tick
  };
  return window.petSM;
})();

// ---- dynamic window size ------------------------------------------------
// The page computes its desired CSS layout from the active action's frame
// aspect and posts {type:'size', w, h, dpr}; the host converts to physical
// px with the reported devicePixelRatio (never guesses DPI from f).
function petAvatarBox() {
  var maxBox = 300 * petScale;
  var faceBox = 70 * petScale;
  var aspect = petSM.aspect();
  if (!aspect) return { w: faceBox, h: faceBox };
  if (aspect >= 1) return { w: maxBox, h: maxBox / aspect };
  return { w: maxBox * aspect, h: maxBox };
}
function petDesiredSize() {
  var b = petAvatarBox();
  // 224 = bubble 200 + gap 8 + area padding 16; 80 = minimum bubble height.
  return { w: Math.ceil(b.w + 224), h: Math.ceil(Math.max(b.h, 80) + 16) };
}
function postPetSize() {
  var d = petDesiredSize();
  var area = document.getElementById('pet-area');
  if (area) area.style.width = d.w + 'px';
  petPost({ type: 'size', w: d.w, h: d.h, dpr: window.devicePixelRatio || 1 });
}
function applyPetSpriteSize() {
  var b = petAvatarBox();
  avatar.style.width = Math.round(b.w) + 'px';
  avatar.style.height = Math.round(b.h) + 'px';
  var canvas = document.getElementById('pet-sprite');
  if (canvas) { canvas.style.width = Math.round(b.w) + 'px'; canvas.style.height = Math.round(b.h) + 'px'; }
}

// ---- side: the bubble sits on the side of the sprite that faces the screen
// center. screen.availLeft/availWidth describe the CURRENT monitor (multi-
// monitor correct); screen.width is primary-only.
window.updateSide = function () {
  var area = document.getElementById('pet-area');
  var petCenter = window.screenX + (area ? area.offsetWidth : 300) / 2;
  var monitorCenter = (screen.availLeft || 0) + screen.availWidth / 2;
  document.body.classList.toggle('chat-left', petCenter > monitorCenter);
  positionBubble();
  petPostHit();
};

// Bubble hugs the sprite's edge (8px gap) on the side facing the screen
// center; vertically centered on the sprite and clamped inside the pet area.
// Input row lives INSIDE the bubble, so user input and the reply always share
// one stable anchor position next to the sprite.
function positionBubble() {
  var bubble = document.getElementById('pet-bubble');
  var area = document.getElementById('pet-area');
  if (!bubble || !area || bubble.style.display === 'none') return;
  var areaRect = area.getBoundingClientRect();
  var ar = avatar.getBoundingClientRect();
  var maxW = Math.max(80, Math.min(200, area.clientWidth - ar.width - 24));
  bubble.style.maxWidth = Math.round(maxW) + 'px';
  var br = bubble.getBoundingClientRect();
  var left;
  if (document.body.classList.contains('chat-left')) {
    left = (ar.left - areaRect.left) - br.width - 8;
  } else {
    left = (ar.right - areaRect.left) + 8;
  }
  left = Math.max(2, Math.min(left, area.clientWidth - br.width - 2));
  var top = (ar.top - areaRect.top) + ar.height / 2 - br.height / 2;
  top = Math.max(2, Math.min(top, area.clientHeight - br.height - 2));
  bubble.style.left = Math.round(left) + 'px';
  bubble.style.top = Math.round(top) + 'px';
}

function toggleBubble(e) {
  if (e) e.stopPropagation();
  var bubble = document.getElementById('pet-bubble');
  if (!bubble) return;
  bubble.style.display = (bubble.style.display === 'flex') ? 'none' : 'flex';
}

// 输入指令行：在气泡内，双击精灵显示；发送或 Esc 后隐藏（气泡保留回复）
function showPetInput() {
  var row = document.querySelector('.pet-input-row');
  var bubble = document.getElementById('pet-bubble');
  if (bubble) bubble.style.display = 'flex';
  if (row) row.classList.add('show');
  positionBubble();
  var input = document.getElementById('pet-input');
  if (input) input.focus();
}

function hidePetInput() {
  var row = document.querySelector('.pet-input-row');
  if (row) row.classList.remove('show');
  positionBubble();
}

function setBubbleMsg(msg) {
  var bubble = document.getElementById('pet-bubble');
  var msgEl = document.getElementById('pet-bubble-msg');
  if (msgEl) msgEl.innerText = msg;
  if (bubble) bubble.style.display = 'flex';
  positionBubble();
}

function sendPetIntent() {
  var input = document.getElementById('pet-input');
  if (!input) return;
  var text = input.value.trim();
  if (!text) return;
  input.value = '';
  hidePetInput();

  setBubbleMsg('正在分析意图...');
  if (window.petSM) petSM.dispatch('think');
  fetch('/api/assistant/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: text })
  })
  .then(function(res) { return res.json(); })
  .then(function(data) {
    var tools = data.tools || [];
    if (tools.length > 0) {
      var t = tools[0];
      setBubbleMsg('已调度: ' + t.tool);
      if (window.petSM) petSM.dispatch('reply');
    } else {
      setBubbleMsg('未能识别意图');
      if (window.petSM) petSM.dispatch('error');
    }
  })
  .catch(function(err) {
    setBubbleMsg('请求失败: ' + err.message);
    if (window.petSM) petSM.dispatch('error');
  });
}

// Load configured assistant actions as state-machine states. Spritesheets are
// served by /api/assistant/sheet-image/{name} (no filesystem access needed).
(function loadPetActions() {
  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (s) {
    var actions = ((s && s.assistant) || {}).actions || [];
    actions.forEach(function (a) {
      if (!a || !a.spritesheetPath || !a.name) return;
      var img = new Image();
      img.onload = function () {
        petSM.register(a.name, {
          img: img, cols: a.cols, rows: a.rows,
          start: a.frameStart, end: a.frameEnd, fps: a.fps
        });
      };
      img.onerror = function () { /* unreachable sheet → keep CSS face */ };
      img.src = '/api/assistant/sheet-image/' + encodeURIComponent(a.name);
    });
  }).catch(function () { /* no settings → CSS face fallback */ });
})();

// Subscribe to Events SSE
try {
  var es = new EventSource('/api/assistant/events');
  es.addEventListener('notify', function(e) {
    try {
      var data = JSON.parse(e.data);
      setBubbleMsg(data.message || data.title || '收到通知');
      if (window.petSM) petSM.dispatch('notify');
    } catch(err) {}
  });
} catch(e) {}
