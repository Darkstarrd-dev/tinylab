// sprite.js — TinyLab 小精灵助手交互层 (L1 Dock/Modal + L2 角色与漫画气泡)
(function() {
  'use strict';

  var isInitialized = false;
  var eventSource = null;
  var spriteState = {
    mode: 'dock', // 'dock' | 'modal' | 'char'
    charX: 80,
    charY: 80,
    isMoving: false,
    unreadCount: 0,
    messages: [
      {
        role: 'assistant',
        content: t('spriteWelcome'),
        tools: []
      }
    ]
  };

  // --- Draggable dock (item 2): dock can be dragged to the left or right
  // edge at any vertical position; position persists in localStorage. A
  // click (mousedown→mouseup without moving >4px) opens the modal; a drag
  // (movement >4px) repositions and does NOT open the modal. ---
  var dockDrag = {
    side: 'right',      // 'left' | 'right'
    y: 0.5,             // 0..1 vertical fraction (0.5 = vertically centered)
    isDown: false,
    isDragging: false,
    startX: 0, startY: 0,
    moved: false
  };

  function loadDockPosition() {
    try {
      var s = localStorage.getItem('tr-sprite-dock-side');
      var y = localStorage.getItem('tr-sprite-dock-y');
      if (s === 'left' || s === 'right') dockDrag.side = s;
      if (y !== null) { var f = parseFloat(y); if (!isNaN(f)) dockDrag.y = Math.max(0, Math.min(1, f)); }
    } catch (e) {}
  }

  function saveDockPosition() {
    try {
      localStorage.setItem('tr-sprite-dock-side', dockDrag.side);
      localStorage.setItem('tr-sprite-dock-y', String(dockDrag.y));
    } catch (e) {}
  }

  function applyDockPosition() {
    var dock = document.getElementById('sprite-dock');
    if (!dock) return;
    var h = dock.offsetHeight || 60;
    var maxY = Math.max(0, window.innerHeight - h);
    var top = Math.round(dockDrag.y * maxY);
    dock.style.top = top + 'px';
    dock.style.transform = 'none';
    if (dockDrag.side === 'left') {
      dock.style.left = '0px';
      dock.style.right = 'auto';
      dock.classList.add('side-left');
    } else {
      dock.style.right = '0px';
      dock.style.left = 'auto';
      dock.classList.remove('side-left');
    }
  }

  function dockMouseDown(e) {
    if (e.button !== 0) return; // left button only
    e.preventDefault();
    e.stopPropagation();
    dockDrag.isDown = true;
    dockDrag.isDragging = false;
    dockDrag.startX = e.clientX;
    dockDrag.startY = e.clientY;
    document.addEventListener('mousemove', dockMouseMove);
    document.addEventListener('mouseup', dockMouseUp);
  }

  function dockMouseMove(e) {
    if (!dockDrag.isDown) return;
    var dx = e.clientX - dockDrag.startX;
    var dy = e.clientY - dockDrag.startY;
    if (!dockDrag.isDragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      dockDrag.isDragging = true;
      var d = document.getElementById('sprite-dock');
      if (d) d.classList.add('dragging');
    }
    if (!dockDrag.isDragging) return;
    var dock = document.getElementById('sprite-dock');
    if (!dock) return;
    // Snap side to whichever screen half the cursor is in.
    dockDrag.side = (e.clientX < window.innerWidth / 2) ? 'left' : 'right';
    var h = dock.offsetHeight || 60;
    var maxY = Math.max(0, window.innerHeight - h);
    var top = e.clientY - h / 2;
    top = Math.max(0, Math.min(maxY, top));
    dockDrag.y = maxY > 0 ? top / maxY : 0.5;
    applyDockPosition();
  }

  function dockMouseUp() {
    document.removeEventListener('mousemove', dockMouseMove);
    document.removeEventListener('mouseup', dockMouseUp);
    var dock = document.getElementById('sprite-dock');
    if (dock) dock.classList.remove('dragging');
    var wasDrag = dockDrag.isDragging;
    dockDrag.isDown = false;
    dockDrag.isDragging = false;
    if (wasDrag) {
      saveDockPosition();
    } else {
      // No movement beyond threshold → treat as a click and open the modal.
      openSpriteModal();
    }
  }

  function initSpriteDOM() {
    if (document.getElementById('sprite-dock')) return;

    // 1. Dock Element
    var dock = document.createElement('div');
    dock.id = 'sprite-dock';
    dock.className = 'sprite-dock';
    dock.setAttribute('role', 'button');
    dock.setAttribute('aria-label', 'Open Assistant');
    dock.innerHTML = [
      '<div class="sprite-dock-icon">',
      '  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '    <path d="M12 2a10 10 0 0 1 10 10c0 5.523-4.477 10-10 10S2 17.523 2 12A10 10 0 0 1 12 2z"/>',
      '    <path d="M8 13a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/>',
      '    <path d="M14 13a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/>',
      '    <path d="M9 17c1 1 2 1.5 3 1.5s2-.5 3-1.5"/>',
      '    <path d="M12 2v4"/>',
      '  </svg>',
      '  <span id="sprite-unread-badge" class="sprite-unread-badge" style="display:none;">0</span>',
      '</div>',
      '<span class="sprite-dock-label">' + t('spriteDockLabel') + '</span>'
    ].join('');
    dock.addEventListener('mousedown', dockMouseDown);
    document.body.appendChild(dock);

    // 2. Modal Element
    var modalOverlay = document.createElement('div');
    modalOverlay.id = 'sprite-modal-overlay';
    modalOverlay.className = 'sprite-modal-overlay';
    modalOverlay.onclick = function(e) {
      if (e.target === modalOverlay) closeSpriteModal();
    };

    modalOverlay.innerHTML = [
      '<div class="sprite-modal" role="dialog" aria-modal="true">',
      '  <div class="sprite-modal-header">',
      '    <div class="sprite-modal-title">',
      '      <div class="sprite-avatar-mini">✨</div>',
      '      <span>' + t('spriteHeaderTitle') + '</span>',
      '    </div>',
      '    <div class="sprite-modal-actions">',
      '      <button class="sprite-btn-icon" title="' + t('spriteBtnRelease') + '" onclick="window.releaseSpriteChar()">',
      '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
      '      </button>',
      '      <button class="sprite-btn-icon" title="' + t('spriteBtnClear') + '" onclick="window.clearSpriteHistory()">',
      '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      '      </button>',
      '      <button class="sprite-btn-icon sprite-btn-close" title="' + t('spriteBtnClose') + '" onclick="window.closeSpriteModal()">&times;</button>',
      '    </div>',
      '  </div>',
      '  <div class="sprite-modal-body">',
      '    <div id="sprite-chat-messages" class="sprite-chat-messages"></div>',
      '    <div class="sprite-quick-chips">',
      '      <button type="button" class="sprite-chip" onclick="window.sendSpriteQuickIntent(\'查看配额\')">' + t('spriteChipQuota') + '</button>',
      '      <button type="button" class="sprite-chip" onclick="window.sendSpriteQuickIntent(\'打开我的笔记文件\')">' + t('spriteChipNotes') + '</button>',
      '      <button type="button" class="sprite-chip" onclick="window.sendSpriteQuickIntent(\'定时清理过期的日志\')">' + t('spriteChipCleanLogs') + '</button>',
      '      <button type="button" class="sprite-chip" onclick="window.sendSpriteQuickIntent(\'看看我配置了哪些provider\')">' + t('spriteChipProviders') + '</button>',
      '    </div>',
      '  </div>',
      '  <div class="sprite-modal-footer">',
      '    <form id="sprite-chat-form" onsubmit="window.handleSpriteSubmit(event)">',
      '      <input type="text" id="sprite-chat-input" placeholder="' + t('spriteInputPlaceholder') + '" autocomplete="off">',
      '      <button type="submit" id="sprite-send-btn" class="sprite-send-btn" aria-label="Send">',
      '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
      '      </button>',
      '    </form>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(modalOverlay);

    // 3. Character Element (L2)
    var charEl = document.createElement('div');
    charEl.id = 'sprite-char';
    charEl.className = 'sprite-char';
    charEl.style.display = 'none';
    charEl.innerHTML = [
      '<div class="sprite-char-inner" onclick="window.toggleSpriteBubble(event)">',
      '  <div class="sprite-char-head">',
      '    <div class="sprite-char-eye left"></div>',
      '    <div class="sprite-char-eye right"></div>',
      '    <div class="sprite-char-blush left"></div>',
      '    <div class="sprite-char-blush right"></div>',
      '    <div class="sprite-char-mouth"></div>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(charEl);

    // 4. Bubble Element (L2 Comic Bubble)
    var bubbleEl = document.createElement('div');
    bubbleEl.id = 'sprite-bubble';
    bubbleEl.className = 'sprite-bubble';
    bubbleEl.style.display = 'none';
    bubbleEl.innerHTML = [
      '<div class="sprite-bubble-content">',
      '  <div id="sprite-bubble-text" class="sprite-bubble-text">' + t('spriteBubbleGreeting') + '</div>',
      '  <div class="sprite-bubble-input-wrap">',
      '    <input type="text" id="sprite-bubble-input" placeholder="' + t('spriteBubblePlaceholder') + '" onkeydown="if(event.key===\'Enter\')window.sendBubbleIntent()">',
      '    <button type="button" class="sprite-bubble-send" onclick="window.sendBubbleIntent()">' + t('spriteBubbleSend') + '</button>',
      '  </div>',
      '  <button type="button" class="sprite-bubble-dock-btn" onclick="window.dockSpriteChar()">' + t('spriteBubbleDock') + '</button>',
      '</div>'
    ].join('');
    document.body.appendChild(bubbleEl);

    // Bind click to move for L2
    document.addEventListener('click', function(e) {
      if (spriteState.mode !== 'char') return;
      if (e.target.closest('#sprite-char') || e.target.closest('#sprite-bubble') || e.target.closest('.top-header') || e.target.closest('.modal-overlay')) {
        return;
      }
      moveSpriteTo(e.clientX, e.clientY);
    });

    renderSpriteMessages();
    connectEventsSSE();
    loadDockPosition();
    applyDockPosition();
    window.addEventListener('resize', applyDockPosition);
  }

  function renderSpriteMessages() {
    var container = document.getElementById('sprite-chat-messages');
    if (!container) return;
    container.innerHTML = '';

    spriteState.messages.forEach(function(msg, idx) {
      var item = document.createElement('div');
      item.className = 'sprite-msg sprite-msg-' + msg.role;

      var textDiv = document.createElement('div');
      textDiv.className = 'sprite-msg-text';
      textDiv.innerText = msg.content;
      item.appendChild(textDiv);

      if (msg.tools && msg.tools.length > 0) {
        var toolsDiv = document.createElement('div');
        toolsDiv.className = 'sprite-msg-tools';
        msg.tools.forEach(function(tool) {
          var card = document.createElement('div');
          card.className = 'sprite-tool-card';
          var header = '<div class="sprite-tool-title">⚡ ' + escapeHtml(tool.tool) + '</div>';
          var desc = '<div class="sprite-tool-path">' + escapeHtml(tool.method) + ' ' + escapeHtml(tool.path) + '</div>';
          var actions = '<div class="sprite-tool-actions">';

          if (tool.navigateTo) {
            actions += '<button type="button" class="sprite-action-btn primary" onclick="window.navigateToRoute(\'' + tool.navigateTo + '\')">' + t('spriteActionJump') + '</button>';
          }
          if (tool.actionable) {
            actions += '<button type="button" class="sprite-action-btn" onclick="window.executeSpriteAction(\'' + tool.tool + '\', this)">' + t('spriteActionRun') + '</button>';
          }
          actions += '</div>';

          if (tool.executed) {
            var statusClass = (tool.status >= 200 && tool.status < 300) ? 'success' : 'error';
            actions += '<div class="sprite-tool-exec-status ' + statusClass + '">' + t('spriteActionResultPrefix') + (tool.error || t('spriteActionOk') + tool.status + ')') + '</div>';
          }

          card.innerHTML = header + desc + actions;
          toolsDiv.appendChild(card);
        });
        item.appendChild(toolsDiv);
      }

      container.appendChild(item);
    });

    container.scrollTop = container.scrollHeight;
  }

  function escapeHtml(str) {
    return window.escapeHtml(str);
  }

  function openSpriteModal() {
    var overlay = document.getElementById('sprite-modal-overlay');
    if (overlay) {
      overlay.classList.add('show');
      spriteState.unreadCount = 0;
      updateUnreadBadge();
      setTimeout(function() {
        var input = document.getElementById('sprite-chat-input');
        if (input) input.focus();
      }, 100);
    }
  }

  function closeSpriteModal() {
    var overlay = document.getElementById('sprite-modal-overlay');
    if (overlay) {
      overlay.classList.remove('show');
    }
  }

  function updateUnreadBadge() {
    var badge = document.getElementById('sprite-unread-badge');
    if (!badge) return;
    if (spriteState.unreadCount > 0) {
      badge.innerText = spriteState.unreadCount > 9 ? '9+' : spriteState.unreadCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  function handleSpriteSubmit(e) {
    if (e) e.preventDefault();
    var input = document.getElementById('sprite-chat-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendSpriteIntent(text);
  }

  function sendSpriteQuickIntent(text) {
    sendSpriteIntent(text);
  }

  function sendSpriteIntent(intentText) {
    spriteState.messages.push({
      role: 'user',
      content: intentText
    });
    renderSpriteMessages();

    fetch('/api/assistant/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: intentText })
    })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      var tools = data.tools || [];
      var replyText = t('spriteFoundCapabilities');
      if (tools.length === 0) {
        replyText = t('spriteNoMatch');
      }
      spriteState.messages.push({
        role: 'assistant',
        content: replyText,
        tools: tools
      });
      renderSpriteMessages();
    })
    .catch(function(err) {
      spriteState.messages.push({
        role: 'assistant',
        content: t('spriteDispatchFailed') + err.message,
        tools: []
      });
      renderSpriteMessages();
    });
  }

  function navigateToRoute(route) {
    if (!route) return;
    closeSpriteModal();
    // Call the app SPA router (navigateTo is a global from app.js). The app has
    // no hashchange listener, so setting location.hash was a no-op (item 4);
    // route is now a valid app page id (e.g. "download"/"endpoint").
    if (typeof navigateTo === 'function') {
      navigateTo(route);
    }
    if (typeof showToast === 'function') {
      showToast(t('spriteJumpedTo') + route, 'info');
    }
  }

  function executeSpriteAction(toolName, btn) {
    if (btn) {
      btn.disabled = true;
      btn.innerText = t('spriteRunning');
    }
    fetch('/api/assistant/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: toolName, execute: true })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (btn) {
        btn.disabled = false;
        btn.innerText = t('spriteExecuted');
      }
      var executedTool = (data.tools && data.tools[0]) || {};
      if (typeof showToast === 'function') {
        if (executedTool.status >= 200 && executedTool.status < 300) {
          showToast(t('spriteExecOk') + toolName, 'success');
        } else {
          showToast(t('spriteExecDone') + (executedTool.status || 200) + ')', 'info');
        }
      }
      sendSpriteIntent(t('spriteViewResult'));
    })
    .catch(function(err) {
      if (btn) {
        btn.disabled = false;
        btn.innerText = t('spriteExecFailed');
      }
      if (typeof showToast === 'function') {
        showToast(t('spriteExecFailedMsg') + err.message, 'error');
      }
    });
  }

  function releaseSpriteChar() {
    closeSpriteModal();
    spriteState.mode = 'char';
    var charEl = document.getElementById('sprite-char');
    var dockEl = document.getElementById('sprite-dock');
    if (charEl) {
      charEl.style.display = 'block';
      charEl.style.left = (window.innerWidth - 120) + 'px';
      charEl.style.top = (window.innerHeight - 150) + 'px';
    }
    if (dockEl) dockEl.style.display = 'none';
    showBubble(t('spriteReleased'));
  }

  function dockSpriteChar() {
    spriteState.mode = 'dock';
    var charEl = document.getElementById('sprite-char');
    var bubbleEl = document.getElementById('sprite-bubble');
    var dockEl = document.getElementById('sprite-dock');
    if (charEl) charEl.style.display = 'none';
    if (bubbleEl) bubbleEl.style.display = 'none';
    if (dockEl) dockEl.style.display = 'flex';
  }

  function toggleSpriteBubble(e) {
    if (e) e.stopPropagation();
    var bubbleEl = document.getElementById('sprite-bubble');
    if (!bubbleEl) return;
    if (bubbleEl.style.display === 'none' || !bubbleEl.style.display) {
      showBubble(t('spriteAskCommand'));
    } else {
      bubbleEl.style.display = 'none';
    }
  }

  function showBubble(text) {
    var charEl = document.getElementById('sprite-char');
    var bubbleEl = document.getElementById('sprite-bubble');
    if (!charEl || !bubbleEl) return;

    var textEl = document.getElementById('sprite-bubble-text');
    if (textEl) textEl.innerText = text;

    var rect = charEl.getBoundingClientRect();
    bubbleEl.style.display = 'block';
    bubbleEl.style.left = Math.max(10, rect.left - 120) + 'px';
    bubbleEl.style.top = Math.max(10, rect.top - 140) + 'px';

    var input = document.getElementById('sprite-bubble-input');
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  function sendBubbleIntent() {
    var input = document.getElementById('sprite-bubble-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = '';

    showBubble(t('spriteRunningIntent') + text + '...');
    fetch('/api/assistant/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: text })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      var tools = data.tools || [];
      if (tools.length > 0) {
        var firstTool = tools[0];
        showBubble(t('spriteMatchedCapability') + firstTool.tool + ' (' + firstTool.method + ' ' + firstTool.path + ')');
        if (firstTool.navigateTo) {
          setTimeout(function() { navigateToRoute(firstTool.navigateTo); }, 1000);
        }
      } else {
        showBubble(t('spriteNoToolMatched'));
      }
    })
    .catch(function(err) {
      showBubble(t('spriteDispatchError') + err.message);
    });
  }

  function moveSpriteTo(x, y) {
    var charEl = document.getElementById('sprite-char');
    var bubbleEl = document.getElementById('sprite-bubble');
    if (!charEl) return;
    if (bubbleEl) bubbleEl.style.display = 'none';

    var targetX = Math.max(20, Math.min(window.innerWidth - 80, x - 30));
    var targetY = Math.max(70, Math.min(window.innerHeight - 80, y - 30));

    charEl.style.transition = 'left 0.5s cubic-bezier(0.25, 1, 0.5, 1), top 0.5s cubic-bezier(0.25, 1, 0.5, 1)';
    charEl.style.left = targetX + 'px';
    charEl.style.top = targetY + 'px';
  }

  function clearSpriteHistory() {
    spriteState.messages = [{
      role: 'assistant',
      content: t('spriteHistoryCleared'),
      tools: []
    }];
    renderSpriteMessages();
  }

  function connectEventsSSE() {
    if (eventSource) {
      eventSource.close();
    }
    try {
      eventSource = new EventSource('/api/assistant/events');
      eventSource.addEventListener('notify', function(e) {
        try {
          var evt = JSON.parse(e.data);
          handleAssistantEvent(evt);
        } catch(err) {}
      });
      eventSource.onerror = function() {
        // Reconnect after brief pause
      };
    } catch(e) {}
  }

  function handleAssistantEvent(evt) {
    if (!evt) return;
    spriteState.unreadCount++;
    updateUnreadBadge();

    spriteState.messages.push({
      role: 'assistant',
      content: '🔔 [' + (evt.title || t('spriteNotifyTitle')) + '] ' + (evt.message || ''),
      tools: []
    });
    renderSpriteMessages();

    if (spriteState.mode === 'char') {
      showBubble(evt.message || evt.title);
    } else if (typeof showToast === 'function') {
      showToast('[' + (evt.title || t('spriteBubbleName')) + '] ' + evt.message, evt.level || 'info');
    }
  }

  // Expose global methods
  window.openSpriteModal = openSpriteModal;
  window.closeSpriteModal = closeSpriteModal;
  window.handleSpriteSubmit = handleSpriteSubmit;
  window.sendSpriteQuickIntent = sendSpriteQuickIntent;
  window.navigateToRoute = navigateToRoute;
  window.executeSpriteAction = executeSpriteAction;
  window.releaseSpriteChar = releaseSpriteChar;
  window.dockSpriteChar = dockSpriteChar;
  window.toggleSpriteBubble = toggleSpriteBubble;
  window.sendBubbleIntent = sendBubbleIntent;
  window.clearSpriteHistory = clearSpriteHistory;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSpriteDOM);
  } else {
    initSpriteDOM();
  }
})();
