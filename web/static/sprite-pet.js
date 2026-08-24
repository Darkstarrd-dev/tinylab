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

var isDragging = false;
var startX, startY;

var avatar = document.getElementById('pet-avatar');
avatar.addEventListener('mousedown', function(e) {
  if (e.target.closest('#pet-bubble')) return;
  isDragging = true;
  startX = e.screenX;
  startY = e.screenY;
});

window.addEventListener('mousemove', function(e) {
  if (!isDragging) return;
  var dx = e.screenX - startX;
  var dy = e.screenY - startY;
  startX = e.screenX;
  startY = e.screenY;
  if (window.movePetWindow) {
    window.movePetWindow(dx, dy);
  }
});

window.addEventListener('mouseup', function() {
  isDragging = false;
});

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
  if (window.closePetWindow) {
    window.closePetWindow();
  } else {
    window.close();
  }
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
