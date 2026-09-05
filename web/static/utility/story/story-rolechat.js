// web/static/utility/story/story-rolechat.js — Role Chat Engine
// Dependency load order:
// vendor/diff.min.js -> utility/editor/editor.js -> editor_textreview_diff.js -> storymaker.js -> story sub-pages -> story-rolechat.js

(function() {
  'use strict';

  var currentCtx = null;
  var currentAbort = null;

  var characterCards = [];
  var participants = []; // { id, cardId, name, model: {value, label}, color }
  var sceneSetting = '在避难所的一间安全屋内，窗外暴雨倾盆。两人正在整理此前的战斗情报...';
  var chatHistory = []; // { id, participantId, senderName, content, timestamp, isUser }

  // Auto conversation loop
  var autoRunning = false;
  var autoRoundsLeft = 0;
  var autoConfig = {
    mode: 'count',
    count: 10,
    cooldownMs: 1500
  };

  var COLOR_PALETTE = ['#4dabf7', '#ff8787', '#69db7c', '#ffd43b', '#da77f2', '#ffa94d'];

  function render(container, ctx) {
    currentCtx = ctx;
    var book = ctx.getActiveBook();
    if (!book) {
      ctx.showEmptyBookState(container);
      return;
    }
    loadData(function() {
      drawUI(container);
    });
  }

  function loadData(cb) {
    var bookId = currentCtx.activeBookId;
    Promise.all([
      currentCtx.api.get('/cards?bookId=' + encodeURIComponent(bookId)),
      currentCtx.api.get('/prompts/rolechat-auto')
    ]).then(function(results) {
      var allCards = (results[0] && results[0].cards) || [];
      characterCards = allCards.filter(function(c) { return c.type === 'character'; });

      // If autoConfig saved
      if (results[1] && results[1].content) {
        try {
          var parsed = JSON.parse(results[1].content);
          if (parsed && typeof parsed === 'object') {
            autoConfig = Object.assign(autoConfig, parsed);
          }
        } catch (e) {}
      }

      // Default participants from first two character cards if empty
      if (participants.length === 0 && characterCards.length > 0) {
        for (var i = 0; i < Math.min(2, characterCards.length); i++) {
          var c = characterCards[i];
          participants.push({
            id: 'part_' + i,
            cardId: c.id,
            name: c.name,
            model: { value: '', label: '选择模型' },
            color: COLOR_PALETTE[i % COLOR_PALETTE.length]
          });
        }
      }
      if (cb) cb();
    }).catch(function(err) {
      console.warn('load rolechat data error:', err);
      if (cb) cb();
    });
  }

  function pickModel(current, onPick) {
    if (typeof pgOpenModelPicker === 'function') {
      pgOpenModelPicker(current.value, function(res) {
        if (res && res.id) {
          onPick({ value: res.id, label: res.name || res.id });
        }
      }, { kindFilter: 'text' });
    } else {
      var m = prompt('请输入模型 ID (例如 provider/model-name):', current.value || '');
      if (m) onPick({ value: m, label: m });
    }
  }

  function buildRoleSystemPrompt(card, scene) {
    var lines = [
      '你正在扮演角色【' + card.name + '】。',
      '【别名】' + ((card.aliases && card.aliases.length) ? card.aliases.join('、') : '无'),
      '【角色设定与生平】',
      card.description || '（无特定描述）'
    ];
    if (card.fields && Object.keys(card.fields).length > 0) {
      lines.push('【属性】');
      for (var k in card.fields) {
        lines.push(k + '：' + card.fields[k]);
      }
    }
    if (card.styleNote) {
      lines.push('【语言风格 / 语气】', card.styleNote);
    }
    if (card.styleExamples && card.styleExamples.length > 0) {
      lines.push('【台词示例】', card.styleExamples.join('\n'));
    }
    lines.push('【当前场景】', scene || '（无特定场景）');
    lines.push(
      '注意：',
      '1. 请完全沉浸在该角色中，保持其独特的口吻、思考方式与性格特征。',
      '2. 仅输出你本人的直接发言或心理动作（20-150字左右），严禁代为输出其他角色或旁白的内容。'
    );
    return lines.join('\n');
  }

  function buildParticipantMessages(history, targetPart) {
    var msgs = [];
    var targetCard = characterCards.find(function(c) { return c.id === targetPart.cardId; });
    var sysPrompt = targetCard ? buildRoleSystemPrompt(targetCard, sceneSetting) : '请根据角色设定参与对话。';
    msgs.push({ role: 'system', content: sysPrompt });

    if (!history || history.length === 0) {
      msgs.push({ role: 'user', content: '（请根据你的角色设定，开启对话）' });
      return msgs;
    }

    for (var i = 0; i < history.length; i++) {
      var h = history[i];
      if (h.participantId === targetPart.id) {
        msgs.push({ role: 'assistant', content: h.content });
      } else {
        var prefix = h.isUser ? '【旁白/旁听】' : ('【' + h.senderName + '】');
        msgs.push({ role: 'user', content: prefix + '：' + h.content });
      }
    }
    return msgs;
  }

  function drawUI(container) {
    var book = currentCtx.getActiveBook();

    container.innerHTML = '' +
      '<div class="sm-page-container">' +
        '<div class="sm-page-header">' +
          '<div class="sm-page-title">' + escapeHtml(t('storyRoleChat')) + ' <span style="font-size:14px;color:var(--text-secondary);font-weight:normal;">(' + escapeHtml(book.title) + ')</span></div>' +
          '<div class="sm-page-actions">' +
            '<button class="btn btn-ghost" type="button" id="sm-chat-btn-export">📥 导出 JSON</button>' +
            '<button class="btn btn-danger btn-sm" type="button" id="sm-chat-btn-clear">清空记录</button>' +
          '</div>' +
        '</div>' +

        // Participants & Scene Settings
        '<div class="sm-card" style="gap:14px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-weight:600;font-size:var(--font-base);">👥 对话参与角色与模型配置</div>' +
            '<button type="button" class="btn btn-ghost btn-sm" id="sm-chat-add-part">＋ 添加参与者</button>' +
          '</div>' +
          '<div id="sm-chat-participants-list" style="display:flex;flex-direction:column;gap:8px;"></div>' +

          '<div class="sm-field">' +
            '<span class="sm-field-label">当前场景设定 (Scene Setting)：</span>' +
            '<textarea class="sm-textarea" id="sm-chat-scene" rows="2">' + escapeHtml(sceneSetting) + '</textarea>' +
          '</div>' +

          // Auto chat control row
          '<div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid var(--glass-border);flex-wrap:wrap;gap:10px;">' +
            '<div style="display:flex;align-items:center;gap:12px;">' +
              '<span class="sm-field-label">自动对话轮数：</span>' +
              '<div style="width:110px;">' + renderStepperHtml('sm-chat-auto-rounds', autoConfig.count, 2, 50, 2) + '</div>' +
            '</div>' +
            '<div style="display:flex;gap:10px;">' +
              (autoRunning ?
                '<button class="btn btn-danger" type="button" id="sm-chat-stop-auto">⏹ 停止自动对话</button>' :
                '<button class="btn btn-primary" type="button" id="sm-chat-start-auto">▶ 开启自动循环对话</button>'
              ) +
            '</div>' +
          '</div>' +
        '</div>' +

        // Chat Box Area
        '<div class="sm-card" style="min-height:460px;padding:0;overflow:hidden;display:flex;flex-direction:column;">' +
          '<div class="sm-chat-history" id="sm-chat-history-box"></div>' +

          // Active reasoning indicator
          '<div id="sm-chat-reasoning" style="display:none;padding:6px 16px;background:rgba(255,255,255,0.03);border-top:1px solid var(--glass-border);font-size:12px;color:var(--accent);">' +
            '<span id="sm-chat-reasoning-text">正在回复中...</span>' +
          '</div>' +

          // Send Bar
          '<div style="padding:12px 16px;border-top:1px solid var(--glass-border);display:flex;gap:10px;background:rgba(0,0,0,0.1);align-items:center;">' +
            '<input type="text" class="input" id="sm-chat-user-input" style="flex:1;" placeholder="以旁白/旁听者身份发言，或留空让下一位角色说话...">' +
            '<button class="btn btn-primary" type="button" id="sm-chat-send-btn">发送</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    renderParticipantsList(container);
    renderChatHistory(container);

    // Bindings
    container.querySelector('#sm-chat-scene')?.addEventListener('input', function(e) {
      sceneSetting = e.target.value;
    });

    container.querySelector('#sm-chat-auto-rounds')?.addEventListener('change', function(e) {
      autoConfig.count = parseInt(e.target.value, 10) || 10;
      currentCtx.api.put('/prompts/rolechat-auto', { content: JSON.stringify(autoConfig) });
    });

    container.querySelector('#sm-chat-add-part')?.addEventListener('click', function() {
      openAddParticipantModal(container);
    });

    container.querySelector('#sm-chat-btn-clear')?.addEventListener('click', function() {
      chatHistory = [];
      renderChatHistory(container);
      toast('对话记录已清空', 'info');
    });

    container.querySelector('#sm-chat-btn-export')?.addEventListener('click', function() {
      var blob = new Blob([JSON.stringify({ scene: sceneSetting, participants: participants, history: chatHistory }, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'rolechat-' + Date.now() + '.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    // User send
    var sendBtn = container.querySelector('#sm-chat-send-btn');
    var inputEl = container.querySelector('#sm-chat-user-input');
    var handleSend = function() {
      var text = inputEl.value.trim();
      if (text) {
        chatHistory.push({
          id: 'msg_' + Date.now(),
          participantId: 'user',
          senderName: '旁白/你',
          content: text,
          timestamp: new Date().toLocaleTimeString(),
          isUser: true
        });
        inputEl.value = '';
        renderChatHistory(container);
      }
      // Trigger next participant reply
      triggerNextParticipantReply(container);
    };

    sendBtn?.addEventListener('click', handleSend);
    inputEl?.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSend();
      }
    });

    // Auto loop buttons
    container.querySelector('#sm-chat-start-auto')?.addEventListener('click', function() {
      if (participants.length === 0) {
        toast('请添加至少一位角色参与者', 'warning');
        return;
      }
      for (var p = 0; p < participants.length; p++) {
        if (!participants[p].model.value) {
          toast('参与者【' + participants[p].name + '】尚未选择模型', 'warning');
          return;
        }
      }
      autoRunning = true;
      autoRoundsLeft = autoConfig.count;
      toast('已开启自动循环对话（共 ' + autoRoundsLeft + ' 轮）', 'info');
      drawUI(container);
      runAutoLoopStep(container);
    });

    container.querySelector('#sm-chat-stop-auto')?.addEventListener('click', function() {
      autoRunning = false;
      autoRoundsLeft = 0;
      if (currentAbort) {
        try { currentAbort.abort(); } catch (e) {}
        currentAbort = null;
      }
      toast('自动循环对话已停止', 'warning');
      drawUI(container);
    });
  }

  function renderParticipantsList(container) {
    var listEl = container.querySelector('#sm-chat-participants-list');
    if (!listEl) return;
    if (participants.length === 0) {
      listEl.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;">暂无参与者，请点击右上角添加。</span>';
      return;
    }

    var html = '';
    for (var i = 0; i < participants.length; i++) {
      var p = participants[i];
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:rgba(255,255,255,0.02);">' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<div style="width:12px;height:12px;border-radius:50%;background:' + p.color + ';"></div>' +
          '<strong style="font-size:13px;">' + escapeHtml(p.name) + '</strong>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<button type="button" class="sm-model-btn sm-part-pick-model" data-idx="' + i + '">' +
            '<span>🤖</span><span>' + escapeHtml(p.model.label) + '</span>' +
          '</button>' +
          '<button type="button" class="btn btn-ghost btn-sm sm-part-trigger-one" data-idx="' + i + '" title="让该角色单独发言一次">🗣️ 发言</button>' +
          '<button type="button" class="btn btn-danger btn-sm sm-part-del" data-idx="' + i + '">&times;</button>' +
        '</div>' +
      '</div>';
    }
    listEl.innerHTML = html;

    listEl.querySelectorAll('.sm-part-pick-model').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.dataset.idx, 10);
        pickModel(participants[idx].model, function(m) {
          participants[idx].model = m;
          renderParticipantsList(container);
        });
      });
    });

    listEl.querySelectorAll('.sm-part-trigger-one').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.dataset.idx, 10);
        executeParticipantTurn(participants[idx], container);
      });
    });

    listEl.querySelectorAll('.sm-part-del').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.dataset.idx, 10);
        participants.splice(idx, 1);
        renderParticipantsList(container);
      });
    });
  }

  function renderChatHistory(container) {
    var box = container.querySelector('#sm-chat-history-box');
    if (!box) return;
    if (chatHistory.length === 0) {
      box.innerHTML = '<div style="margin:auto;color:var(--text-secondary);font-size:13px;">对话记录为空。可在下方输入发言或点击角色“🗣️ 发言”。</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < chatHistory.length; i++) {
      var msg = chatHistory[i];
      var p = participants.find(function(x) { return x.id === msg.participantId; });
      var color = p ? p.color : 'var(--text-secondary)';
      var cls = msg.isUser ? 'sm-chat-msg other' : 'sm-chat-msg other';

      html += '<div class="' + cls + '">' +
        '<div class="sm-chat-sender" style="color:' + color + ';">' +
          '<strong>' + escapeHtml(msg.senderName) + '</strong> ' +
          '<span>' + msg.timestamp + '</span>' +
        '</div>' +
        '<div class="sm-chat-bubble" style="border-left:3px solid ' + color + ';">' +
          escapeHtml(msg.content) +
        '</div>' +
      '</div>';
    }
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  function triggerNextParticipantReply(container) {
    if (participants.length === 0) return;
    // Pick the participant who didn't speak last
    var lastSpeakerId = chatHistory.length > 0 ? chatHistory[chatHistory.length - 1].participantId : '';
    var nextPart = participants.find(function(p) { return p.id !== lastSpeakerId; }) || participants[0];
    executeParticipantTurn(nextPart, container);
  }

  function executeParticipantTurn(part, container, onDone) {
    if (!part || !part.model.value) {
      toast('角色【' + (part ? part.name : '未知') + '】未配置模型', 'warning');
      if (onDone) onDone(false);
      return;
    }

    var reasoningEl = container.querySelector('#sm-chat-reasoning');
    var reasoningText = container.querySelector('#sm-chat-reasoning-text');
    if (reasoningEl && reasoningText) {
      reasoningEl.style.display = 'block';
      reasoningText.textContent = '【' + part.name + '】正在组织语言...';
    }

    var messages = buildParticipantMessages(chatHistory, part);
    var fullDelta = '';

    currentAbort = currentCtx.api.sse('/chat', {
      model: part.model.value,
      messages: messages
    }, function(delta) {
      if (typeof delta === 'string') {
        fullDelta += delta;
      }
    }, function() {
      if (reasoningEl) reasoningEl.style.display = 'none';
      if (fullDelta.trim()) {
        chatHistory.push({
          id: 'msg_' + Date.now(),
          participantId: part.id,
          senderName: part.name,
          content: fullDelta.trim(),
          timestamp: new Date().toLocaleTimeString(),
          isUser: false
        });
        renderChatHistory(container);
      }
      if (onDone) onDone(true);
    }, function(err) {
      if (reasoningEl) reasoningEl.style.display = 'none';
      toast(part.name + ' 回复失败: ' + err.message, 'error');
      if (onDone) onDone(false);
    });
  }

  function runAutoLoopStep(container) {
    if (!autoRunning || autoRoundsLeft <= 0) {
      autoRunning = false;
      drawUI(container);
      toast('自动对话已结束', 'info');
      return;
    }

    var lastSpeakerId = chatHistory.length > 0 ? chatHistory[chatHistory.length - 1].participantId : '';
    var nextPart = participants.find(function(p) { return p.id !== lastSpeakerId; }) || participants[0];

    executeParticipantTurn(nextPart, container, function(success) {
      if (!success || !autoRunning) {
        autoRunning = false;
        drawUI(container);
        return;
      }
      autoRoundsLeft--;
      setTimeout(function() {
        runAutoLoopStep(container);
      }, autoConfig.cooldownMs || 1500);
    });
  }

  function openAddParticipantModal(container) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = '' +
      '<div class="modal-card" style="width:420px;">' +
        '<div class="modal-header">' +
          '<div class="modal-title">添加对话角色</div>' +
          '<button class="modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">' +
          '<div class="sm-field">' +
            '<span class="sm-field-label">选择设定卡片：</span>' +
            '<select class="select" id="sm-part-select-card"></select>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:10px;">' +
          '<button class="btn btn-ghost" type="button" id="sm-part-modal-cancel">取消</button>' +
          '<button class="btn btn-primary" type="button" id="sm-part-modal-add">添加</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var close = function() { overlay.remove(); };
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.querySelector('#sm-part-modal-cancel').addEventListener('click', close);

    var sel = overlay.querySelector('#sm-part-select-card');
    if (characterCards.length === 0) {
      sel.innerHTML = '<option value="">暂无人物卡片</option>';
    } else {
      var sHtml = '';
      for (var i = 0; i < characterCards.length; i++) {
        var c = characterCards[i];
        sHtml += '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>';
      }
      sel.innerHTML = sHtml;
    }

    overlay.querySelector('#sm-part-modal-add').addEventListener('click', function() {
      var cardId = sel.value;
      var card = characterCards.find(function(x) { return x.id === cardId; });
      if (!card) return;
      participants.push({
        id: 'part_' + Date.now(),
        cardId: card.id,
        name: card.name,
        model: { value: '', label: '选择模型' },
        color: COLOR_PALETTE[participants.length % COLOR_PALETTE.length]
      });
      close();
      renderParticipantsList(container);
    });
  }

  // Lifecycle
  window.storyRenderRoleChat = render;
  window.storyCleanupRoleChat = function() {
    autoRunning = false;
    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) {}
      currentAbort = null;
    }
  };

})();
