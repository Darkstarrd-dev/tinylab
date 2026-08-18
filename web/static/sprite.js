// sprite.js — TinyRouter 小精灵助手交互层 (L1 Dock/Modal + L2 角色与漫画气泡)
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
        content: '你好！我是 TinyRouter 小精灵。我可以帮你快速跳转页面、查询模型配额、清理日志、打包归档等。有什么我可以帮你的吗？',
        tools: []
      }
    ]
  };

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
      '<span class="sprite-dock-label">小精灵</span>'
    ].join('');
    dock.onclick = function(e) {
      e.stopPropagation();
      openSpriteModal();
    };
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
      '      <span>TinyRouter 智能助理</span>',
      '    </div>',
      '    <div class="sprite-modal-actions">',
      '      <button class="sprite-btn-icon" title="释放小精灵到界面" onclick="window.releaseSpriteChar()">',
      '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
      '      </button>',
      '      <button class="sprite-btn-icon" title="清空对话" onclick="window.clearSpriteHistory()">',
      '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      '      </button>',
      '      <button class="sprite-btn-icon sprite-btn-close" title="关闭" onclick="window.closeSpriteModal()">&times;</button>',
      '    </div>',
      '  </div>',
      '  <div class="sprite-modal-body">',
      '    <div id="sprite-chat-messages" class="sprite-chat-messages"></div>',
      '    <div class="sprite-quick-chips">',
      '      <button type="button" class="sprite-chip" onclick="window.sendSpriteQuickIntent(\'查看配额\')">📊 查看配额</button>',
      '      <button type="button" class="sprite-chip" onclick="window.sendSpriteQuickIntent(\'打开我的笔记文件\')">📝 打开笔记</button>',
      '      <button type="button" class="sprite-chip" onclick="window.sendSpriteQuickIntent(\'定时清理过期的日志\')">🧹 清理日志</button>',
      '      <button type="button" class="sprite-chip" onclick="window.sendSpriteQuickIntent(\'看看我配置了哪些provider\')">⚡ 查看 Provider</button>',
      '    </div>',
      '  </div>',
      '  <div class="sprite-modal-footer">',
      '    <form id="sprite-chat-form" onsubmit="window.handleSpriteSubmit(event)">',
      '      <input type="text" id="sprite-chat-input" placeholder="输入意图，例如：帮我生成一张猫的图片 / 查看监控..." autocomplete="off">',
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
      '  <div id="sprite-bubble-text" class="sprite-bubble-text">有什么我可以帮你的？</div>',
      '  <div class="sprite-bubble-input-wrap">',
      '    <input type="text" id="sprite-bubble-input" placeholder="输入指令..." onkeydown="if(event.key===\'Enter\')window.sendBubbleIntent()">',
      '    <button type="button" class="sprite-bubble-send" onclick="window.sendBubbleIntent()">发送</button>',
      '  </div>',
      '  <button type="button" class="sprite-bubble-dock-btn" onclick="window.dockSpriteChar()">收起</button>',
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
            actions += '<button type="button" class="sprite-action-btn primary" onclick="window.navigateToRoute(\'' + tool.navigateTo + '\')">跳转页面</button>';
          }
          if (tool.actionable) {
            actions += '<button type="button" class="sprite-action-btn" onclick="window.executeSpriteAction(\'' + tool.tool + '\', this)">执行动作</button>';
          }
          actions += '</div>';

          if (tool.executed) {
            var statusClass = (tool.status >= 200 && tool.status < 300) ? 'success' : 'error';
            actions += '<div class="sprite-tool-exec-status ' + statusClass + '">执行结果: ' + (tool.error || '已成功执行 (' + tool.status + ')') + '</div>';
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
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
      var replyText = '为你找到以下对应能力与操作：';
      if (tools.length === 0) {
        replyText = '未能识别到直接相关的工具或操作，你可以尝试换个表达方式。';
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
        content: '分派请求失败: ' + err.message,
        tools: []
      });
      renderSpriteMessages();
    });
  }

  function navigateToRoute(route) {
    if (!route) return;
    window.location.hash = route;
    closeSpriteModal();
    if (typeof showToast === 'function') {
      showToast('已跳转到 ' + route, 'info');
    }
  }

  function executeSpriteAction(toolName, btn) {
    if (btn) {
      btn.disabled = true;
      btn.innerText = '执行中...';
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
        btn.innerText = '已执行';
      }
      var executedTool = (data.tools && data.tools[0]) || {};
      if (typeof showToast === 'function') {
        if (executedTool.status >= 200 && executedTool.status < 300) {
          showToast('执行成功: ' + toolName, 'success');
        } else {
          showToast('执行完成 (' + (executedTool.status || 200) + ')', 'info');
        }
      }
      sendSpriteIntent('查看刚刚的操作结果');
    })
    .catch(function(err) {
      if (btn) {
        btn.disabled = false;
        btn.innerText = '执行失败';
      }
      if (typeof showToast === 'function') {
        showToast('执行失败: ' + err.message, 'error');
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
    showBubble('小精灵已释放！点击桌面可移动，点击我可打开对话气泡。');
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
      showBubble('有什么指令需要我执行吗？');
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

    showBubble('正在执行意图: ' + text + '...');
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
        showBubble('已匹配能力: ' + t.tool + ' (' + t.method + ' ' + t.path + ')');
        if (t.navigateTo) {
          setTimeout(function() { navigateToRoute(t.navigateTo); }, 1000);
        }
      } else {
        showBubble('未能匹配到具体工具。');
      }
    })
    .catch(function(err) {
      showBubble('分派失败: ' + err.message);
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
      content: '对话记录已清空。有什么可以帮你的？',
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
      content: '🔔 [' + (evt.title || '通知') + '] ' + (evt.message || ''),
      tools: []
    });
    renderSpriteMessages();

    if (spriteState.mode === 'char') {
      showBubble(evt.message || evt.title);
    } else if (typeof showToast === 'function') {
      showToast('[' + (evt.title || '小精灵') + '] ' + evt.message, evt.level || 'info');
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
