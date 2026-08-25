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
//   - Spritesheet renderer: plays the configured Assistant action (prefers an
//     action named "idle", otherwise the first one with a spritesheet). Frames
//     are the row-major cells [frameStart..frameEnd] of the cols×rows grid,
//     stepped at the action's fps; without any action the CSS face remains.
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
window.addEventListener('keydown', function (e) { if (e.key === 'Escape') hidePetMenu(); });

var miClose = document.getElementById('pet-mi-close');
if (miClose) miClose.addEventListener('click', function () { petPost({ type: 'close' }); });

function toggleBubble(e) {
  if (e) e.stopPropagation();
  var bubble = document.getElementById('pet-bubble');
  if (bubble.style.display === 'flex') {
    bubble.style.display = 'none';
  } else {
    bubble.style.display = 'flex';
    var input = document.getElementById('pet-input');
    if (input) input.focus();
  }
}

function setBubbleMsg(msg) {
  var bubble = document.getElementById('pet-bubble');
  var msgEl = document.getElementById('pet-bubble-msg');
  if (msgEl) msgEl.innerText = msg;
  if (bubble) bubble.style.display = 'flex';
}

function sendPetIntent() {
  var input = document.getElementById('pet-input');
  if (!input) return;
  var text = input.value.trim();
  if (!text) return;
  input.value = '';

  setBubbleMsg('正在分析意图...');
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
    } else {
      setBubbleMsg('未能识别意图');
    }
  })
  .catch(function(err) {
    setBubbleMsg('请求失败: ' + err.message);
  });
}

function closePet() {
  petPost({ type: 'close' });
}

(function initPetSprite() {
  var canvas = document.getElementById('pet-sprite');
  if (!canvas) return;
  fetch('/api/settings').then(function(r) { return r.json(); }).then(function(s) {
    var actions = ((s && s.assistant) || {}).actions || [];
    var act = null;
    for (var i = 0; i < actions.length; i++) {
      if (actions[i] && actions[i].spritesheetPath && String(actions[i].name).toLowerCase() === 'idle') { act = actions[i]; break; }
    }
    if (!act) {
      for (var j = 0; j < actions.length; j++) {
        if (actions[j] && actions[j].spritesheetPath) { act = actions[j]; break; }
      }
    }
    if (!act) return;
    var img = new Image();
    img.onload = function() {
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      var cols = Math.max(1, act.cols || 1);
      var rows = Math.max(1, act.rows || 1);
      var frameW = img.naturalWidth / cols;
      var frameH = img.naturalHeight / rows;
      var start = Math.max(0, act.frameStart || 0);
      var end = Math.max(start, (act.frameEnd === undefined ? start : act.frameEnd));
      var total = cols * rows;
      if (end > total - 1) end = total - 1;
      var frames = end - start + 1;
      if (frames < 1 || frameW < 1 || frameH < 1) return;
      var idx = 0;
      var fps = Math.max(1, act.fps || 8);
      canvas.style.display = 'block';
      var face = document.querySelector('.pet-face');
      if (face) face.style.display = 'none';
      setInterval(function() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        var f = start + (idx % frames);
        var sx = (f % cols) * frameW;
        var sy = Math.floor(f / cols) * frameH;
        ctx.drawImage(img, sx, sy, frameW, frameH, 0, 0, canvas.width, canvas.height);
        idx++;
      }, Math.round(1000 / fps));
    };
    img.onerror = function() { /* keep CSS face fallback */ };
    img.src = '/api/assistant/sheet-image/' + encodeURIComponent(act.name || '');
  }).catch(function() { /* no settings / fetch fail → CSS face */ });
})();

// Subscribe to Events SSE
try {
  var es = new EventSource('/api/assistant/events');
  es.addEventListener('notify', function(e) {
    try {
      var data = JSON.parse(e.data);
      setBubbleMsg(data.message || data.title || '收到通知');
    } catch(err) {}
  });
} catch(e) {}
