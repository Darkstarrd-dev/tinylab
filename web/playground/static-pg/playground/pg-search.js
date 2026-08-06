// pg-search.js
var PG_SEARCH_CLASSIFY_PROMPT = 'You are a search query classifier. Given a user\'s search query, determine the best search strategy.\n\nRules:\n- Always use "general" strategy for all queries.\n- Do NOT output sub_domain or sub_domain_params; always set them to null.\n\nRespond with ONLY a JSON object (no markdown fences, no explanation):\n{"strategy":"general","domain":null,"sub_domain":null,"sub_domain_params":null,"query":"<original search query>"}';

var PG_SEARCH_SYNTHESIZE_PROMPT = 'You are a search result synthesizer. Given a user\'s original query and raw search results from a search engine, provide a comprehensive, well-formatted Markdown summary that answers the user\'s question. Include relevant details, organize information with headers/lists/tables as appropriate, and mention sources where available. Write in the same language as the user\'s query.';

function pgSearchSend(query) {
  var w0 = pgWinAt(0);
  var w1 = pgWinAt(1);
  if (!w0) return;
  var now = Date.now();
  var searchId = pgNextSearchId();
  var searchEntry = { id: searchId, query: query, messages: [], ts: now };
  pgState.searchHistory.push(searchEntry);
  pgState.activeSearchId = searchId;

  // Persist search history immediately to prevent data loss on crash
  if (typeof pgSaveSearchHistory === 'function') pgSaveSearchHistory();

  searchEntry.messages.push({ role: 'user', content: query, createdAt: now });
  searchEntry.messages.push({ role: 'assistant', content: '', status: 'loading', startedAt: now, searchStep: 'classifying' });
  
  pgSyncSearchMessages();
  w0.streaming = true;
  if (w1) w1.streaming = true;
  w0.abortCtrl = new AbortController();
  pgRenderMessages(0);
  if (w1) pgRenderMessages(1);
  pgUpdateInputBar();
  pgRenderSidebar();

  // Step 1: Classify query
  fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TinyRouter-Source': 'playground' },
    body: JSON.stringify({
      model: w0.config.model,
      messages: [
        { role: 'system', content: PG_SEARCH_CLASSIFY_PROMPT },
        { role: 'user', content: query }
      ],
      stream: false
    }),
    signal: w0.abortCtrl.signal,
  }).then(function(resp) {
    if (!resp.ok) {
      return resp.text().then(function(text) {
        throw new Error('Classify HTTP ' + resp.status + ': ' + text);
      });
    }
    return resp.json();
  }).then(function(data) {
    var w2 = pgWinAt(0);
    var msg = w2.messages[w2.messages.length - 1];
    if (!msg || msg.status === 'error') return;
    var classifyText = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    var classification = null;
    try {
      var cleaned = classifyText.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
      classification = JSON.parse(cleaned);
    } catch (e) {}
    if (!classification || typeof classification !== 'object' || !classification.strategy) {
      classification = { strategy: 'general', domain: null, sub_domain: null, sub_domain_params: null, query: query };
    }
    msg.searchClassification = classification;
    msg.searchStep = 'searching';
    pgRenderBubble(0, w2.messages.length - 1);
    pgRenderBubble(1, w2.messages.length - 1);

    // Step 2: Search (pure general)
    return fetch('/api/anysearch/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: classification.query || query,
        max_results: pgState.search.maxResults
      }),
      signal: w2.abortCtrl.signal,
    }).then(function(resp2) {
      if (!resp2.ok) {
        return resp2.text().then(function(text) {
          throw new Error('Search HTTP ' + resp2.status + ': ' + text);
        });
      }
      return resp2.json();
    }).then(function(searchData) {
      var w3 = pgWinAt(0);
      var msg2 = w3.messages[w3.messages.length - 1];
      if (!msg2 || msg2.status === 'error') return;
      if (searchData.error) throw new Error(searchData.error);
      var rawResult = searchData.result || '';
      if (!rawResult) throw new Error('Empty search results');
      msg2.searchRaw = rawResult;
      msg2.searchStep = 'synthesizing';
      msg2.status = 'streaming';
      w3.pendingContent = '';
      w3.lastRenderedRawLen = rawResult.length;
      pgRenderBubble(0, w3.messages.length - 1);
      pgRenderBubble(1, w3.messages.length - 1);
      pgScrollBottom(0, w3.messages.length - 1);

      // Step 3: Synthesize (streaming)
      var synthBody = {
        model: w3.config.model,
        messages: [
          { role: 'system', content: PG_SEARCH_SYNTHESIZE_PROMPT },
          { role: 'user', content: 'Query: ' + query + '\n\nSearch Results:\n' + rawResult }
        ],
        stream: true
      };
      return fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'X-TinyRouter-Source': 'playground' },
        body: JSON.stringify(synthBody),
        signal: w3.abortCtrl.signal,
      }).then(function(resp3) {
        if (!resp3.ok || !resp3.body) {
          return resp3.text().then(function(text) {
            throw new Error('Synthesize HTTP ' + resp3.status + ': ' + text);
          });
        }
        var reader = resp3.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        function pump() {
          return reader.read().then(function(chunk) {
            if (chunk.done) {
              pgSearchFinish();
              return;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            var events = buffer.split('\n');
            buffer = events.pop();
            for (var j = 0; j < events.length; j++) {
              var line = events[j].trim();
              if (!line) continue;
              var data = pgParseSSELine(line);
              if (!data) continue;
              if (data.done) {
                pgSearchFinish();
                return;
              }
              pgSearchApplyChunk(data);
            }
            pgSearchFlushRender();
            return pump();
          });
        }
        return pump();
      });
    });
  }).catch(function(err) {
    if (err && err.name === 'AbortError') {
      pgSearchFinish();
    } else {
      pgSearchFail(err && err.message ? err.message : String(err));
    }
  });
}

function pgSearchApplyChunk(data) {
  var w = pgWinAt(0);
  var choices = data.choices;
  if (!choices || !choices.length) return;
  var delta = choices[0].delta || {};
  if (delta.content) w.pendingContent = pgMergeChunk(w.pendingContent, delta.content);
}

function pgSearchFlushRender() {
  var w = pgWinAt(0);
  if (w.renderTimer) return;
  w.renderTimer = setTimeout(function() {
    var w2 = pgWinAt(0);
    w2.renderTimer = null;
    if (!w2.streaming) return;
    var msg = w2.messages[w2.messages.length - 1];
    if (!msg) return;

    // DOM existence check — background tab render may fire after container is cleared
    var bubble0 = document.getElementById('pg-bubble-0-' + (w2.messages.length - 1));
    var bubble1 = document.getElementById('pg-bubble-1-' + (w2.messages.length - 1));
    if (!bubble0 && !bubble1) return;

    // Only re-render left pane if left content (searchRaw/strategy) actually changed
    var rawLen = msg.searchRaw ? msg.searchRaw.length : 0;
    var rawChanged = w2.lastRenderedRawLen !== rawLen;
    if (rawChanged || msg.searchStep === 'classifying' || msg.searchStep === 'searching') {
      w2.lastRenderedRawLen = rawLen;
      if (bubble0) {
        pgRenderBubble(0, w2.messages.length - 1);
        pgScrollBottom(0, w2.messages.length - 1);
      }
    }

    // Right pane (synthesized result) is updated during streaming
    msg.content = w2.pendingContent;
    msg.status = 'streaming';
    if (bubble1) pgRenderBubble(1, w2.messages.length - 1);
    if (bubble1) pgScrollBottom(1, w2.messages.length - 1);
  }, 50);
}

function pgSearchFinish() {
  var w0 = pgWinAt(0);
  var w1 = pgWinAt(1);
  if (!w0.streaming) return;
  w0.streaming = false;
  if (w1) w1.streaming = false;
  if (w0.renderTimer) { clearTimeout(w0.renderTimer); w0.renderTimer = null; }
  w0.abortCtrl = null;
  var msg = w0.messages[w0.messages.length - 1];
  if (msg) {
    msg.content = w0.pendingContent || msg.content;
    msg.status = 'complete';
    msg.searchStep = 'done';
    if (!msg.completedAt) {
      msg.completedAt = Date.now();
      if (msg.startedAt) msg.durationMs = msg.completedAt - msg.startedAt;
    }
  }
  w0.pendingContent = '';
  // DOM existence check — background tab render may fire after container is cleared
  var bubble0 = document.getElementById('pg-bubble-0-' + (w0.messages.length - 1));
  var bubble1 = document.getElementById('pg-bubble-1-' + (w0.messages.length - 1));
  if (bubble0) pgRenderBubble(0, w0.messages.length - 1);
  if (bubble1) pgRenderBubble(1, w0.messages.length - 1);
  if (document.getElementById('pg-debug-content')) pgRenderDebug();
  pgSave();
  if (document.getElementById('pg-inputbar')) pgUpdateInputBar();
}

function pgSearchFail(errMsg) {
  var w0 = pgWinAt(0);
  var w1 = pgWinAt(1);
  w0.streaming = false;
  if (w1) w1.streaming = false;
  if (w0.renderTimer) { clearTimeout(w0.renderTimer); w0.renderTimer = null; }
  w0.abortCtrl = null;
  var msg = w0.messages[w0.messages.length - 1];
  if (msg) {
    msg.error = errMsg;
    msg.status = 'error';
    msg.searchStep = 'error';
    if (!msg.completedAt) {
      msg.completedAt = Date.now();
      if (msg.startedAt) msg.durationMs = msg.completedAt - msg.startedAt;
    }
  }
  // DOM existence check — background tab render may fire after container is cleared
  var bubble0 = document.getElementById('pg-bubble-0-' + (w0.messages.length - 1));
  var bubble1 = document.getElementById('pg-bubble-1-' + (w0.messages.length - 1));
  if (bubble0) pgRenderBubble(0, w0.messages.length - 1);
  if (bubble1) pgRenderBubble(1, w0.messages.length - 1);
  if (document.getElementById('pg-debug-content')) pgRenderDebug();
  if (document.getElementById('pg-inputbar')) pgUpdateInputBar();
}

function pgSearchSaveKey() {
  var input = document.getElementById('pg-search-key-input');
  if (!input) return;
  var key = input.value.trim();
  pgApiPatch('/settings', { anySearch: { apiKey: key } }).then(function() {
    pgState.search.apiKey = key;
    pgToast(pgT('pgSearchKeySaved'), 'success');
  }).catch(function() {
    pgToast(pgT('pgSearchError'), 'error');
  });
}

function pgSearchLoadSettings() {
  pgApiGet('/settings').then(function(res) {
    if (res && res.anySearch) {
      pgState.search.apiKey = res.anySearch.apiKey || '';
      pgState.search.maxResults = res.anySearch.maxResults || 5;
      var keyInput = document.getElementById('pg-search-key-input');
      if (keyInput) keyInput.value = pgState.search.apiKey;
      var slider = document.getElementById('pg-search-slider');
      if (slider) {
        slider.value = pgState.search.maxResults;
        var val = document.getElementById('pg-search-slider-val');
        if (val) val.textContent = pgState.search.maxResults;
      }
    }
  }).catch(function() {});
}

function pgRenderSearchSettings(cfg) {
  var keyVal = pgState.search.apiKey || '';
  var maxVal = pgState.search.maxResults || 5;
  return '<div class="pg-search-settings">' +
    '<div class="pg-search-key-row">' +
      '<input type="password" class="pg-search-key-input" id="pg-search-key-input" value="' + pgEscapeHtml(keyVal) + '" placeholder="' + pgEscapeHtml(pgT('pgSearchApiKeyHint')) + '">' +
      '<button class="pg-search-save-btn" onclick="pgSearchSaveKey()">' + pgEscapeHtml(pgT('pgSearchSaveKey')) + '</button>' +
    '</div>' +
    '<div class="pg-search-slider-row">' +
      '<span>' + pgEscapeHtml(pgT('pgSearchMaxResults')) + '</span>' +
      '<input type="range" class="pg-search-slider" id="pg-search-slider" min="1" max="10" value="' + maxVal + '" onchange="pgSearchSliderChange(this.value)">' +
      '<span class="pg-search-slider-val" id="pg-search-slider-val">' + maxVal + '</span>' +
    '</div>' +
  '</div>';
}

function pgSearchSliderChange(val) {
  pgState.search.maxResults = parseInt(val, 10);
  var valEl = document.getElementById('pg-search-slider-val');
  if (valEl) valEl.textContent = val;
  pgApiPatch('/settings', { anySearch: { maxResults: pgState.search.maxResults } }).catch(function() {});
}

function pgRenderSearchHistory() {
  var history = pgState.searchHistory;
  if (!history.length) {
    return '<div class="pg-search-history-empty">' + pgEscapeHtml(pgT('pgSearchHistoryEmpty')) + '</div>';
  }
  var html = '<ul class="pg-search-history-list">';
  // Render newest first (top-to-bottom)
  for (var i = history.length - 1; i >= 0; i--) {
    var entry = history[i];
    var isActive = entry.id === pgState.activeSearchId;
    var display = entry.query.length > 30 ? entry.query.substring(0, 30) + '…' : entry.query;
    var timeStr = pgFormatTime(entry.ts);
    var num = i + 1;  // search number: 1 = first, N = latest
    html += '<li class="pg-search-history-item' + (isActive ? ' active' : '') + '" data-tooltip="' + pgEscapeAttr(entry.query) + '" onclick="pgSwitchSearch(' + entry.id + ')">' +
      '<span class="pg-search-history-num">' + num + '</span>' +
      '<span class="pg-search-history-text">' + pgEscapeHtml(display) + '</span>' +
      '<span class="pg-search-history-time">' + pgEscapeHtml(timeStr) + '</span>' +
      '<button class="pg-search-history-del" onclick="event.stopPropagation(); pgDeleteSearchHistory(' + entry.id + ')" data-tooltip="Delete search history">✕</button>' +
    '</li>';
  }
  html += '</ul>';
  return html;
}

function pgDeleteSearchHistory(searchId) {
  pgState.searchHistory = pgState.searchHistory.filter(function(item) {
    return item.id !== searchId;
  });
  if (pgState.activeSearchId === searchId) {
    pgState.activeSearchId = pgState.searchHistory.length ? pgState.searchHistory[pgState.searchHistory.length - 1].id : null;
  }
  pgSaveSearchHistory();
  if (typeof pgSyncSearchMessages === 'function') pgSyncSearchMessages();
  pgRenderSidebar();
  pgRenderMessages(0);
  if (typeof pgWinAt === 'function' && pgWinAt(1)) pgRenderMessages(1);
}

function pgSwitchSearch(searchId) {
  // Don't allow switching away from an active (streaming) search
  if (pgState.mode !== 'search') return;
  var w = pgWinAt(0);
  if (!w) return;
  if (w.streaming) return;
  // Find the entry
  for (var i = 0; i < pgState.searchHistory.length; i++) {
    if (pgState.searchHistory[i].id === searchId) {
      pgState.activeSearchId = searchId;
      pgSyncSearchMessages();
      pgRenderMessages(0);
      pgRenderSidebar();
      pgUpdateInputBar();
      return;
    }
  }
}

// Kept for backward compat — no longer used by history items.
function pgScrollToSearchMsg(msgIdx) {
  var el = document.getElementById('pg-msg-0-' + msgIdx);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
  }
}

// ===== AI Search Markdown Structure Repair =====

var PG_SEARCH_REPAIR_MARKDOWN_PROMPT =
  '你是一个专业的 Markdown 语法与结构修复专家。\n' +
  '你的唯一任务是：将输入的结构混乱、丢失换行或格式粘连的原始网页提取文本（Raw Search Results），修复为结构标准、排版规范、可读性高的 Markdown 文本。\n\n' +
  '【严禁行为】\n' +
  '1. 绝对不要归纳、总结、删减或改写原本的文字与内容；\n' +
  '2. 绝对不要添加任何前言、总结说明、解释或对话标语（例如“以下是修复后的内容：”）；\n\n' +
  '【修复规则】\n' +
  '1. 恢复粘连的代码块，使用标准的 ``` 语言代码块并正确换行；\n' +
  '2. 恢复粘连的标题与段落，强切换行并保留标题级别 (# / ## / ###)；\n' +
  '3. 恢复单行或损坏的表格/列表，整理为标准的 GFM 格式；\n' +
  '4. 直接输出修复后的标准 Markdown 文本。';

function pgRepairSearchMarkdownAI(i, idx) {
  var w = pgWinAt(i);
  var msg = w ? w.messages[idx] : null;
  if (!msg || !msg.searchRaw) return;

  msg.prettyRepairing = true;
  msg.prettyRepairError = null;
  msg.prettyMarkdown = '';
  pgRenderBubble(i, idx);

  var reqBody = {
    model: w.config.model,
    messages: [
      { role: 'system', content: PG_SEARCH_REPAIR_MARKDOWN_PROMPT },
      { role: 'user', content: msg.searchRaw }
    ],
    stream: true
  };

  var pendingPretty = '';
  fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'X-TinyRouter-Source': 'playground' },
    body: JSON.stringify(reqBody)
  }).then(function(resp) {
    if (!resp.ok) {
      return resp.text().then(function(text) {
        throw new Error('HTTP ' + resp.status + ': ' + text);
      });
    }
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function(res) {
        if (res.done) {
          msg.prettyRepairing = false;
          msg.prettyMarkdown = pendingPretty;
          pgRenderBubble(i, idx);
          return;
        }
        buffer += decoder.decode(res.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(function(line) {
          line = line.trim();
          if (!line || line.indexOf('data: ') !== 0) return;
          var rawJson = line.slice(6);
          if (rawJson === '[DONE]') return;
          try {
            var data = JSON.parse(rawJson);
            var delta = data.choices && data.choices[0] && data.choices[0].delta;
            if (delta && delta.content) {
              pendingPretty = pgMergeChunk(pendingPretty, delta.content);
              msg.prettyMarkdown = pendingPretty;
              pgRenderBubble(i, idx);
            }
          } catch(e) {}
        });
        return pump();
      });
    }
    return pump();
  }).catch(function(err) {
    msg.prettyRepairing = false;
    msg.prettyRepairError = err.message || String(err);
    pgRenderBubble(i, idx);
  });
}

function pgToggleSearchRaw(btn, view) {
  var msgEl = btn.closest('.pg-msg');
  if (!msgEl) return;
  var idParts = msgEl.id ? msgEl.id.split('-') : [];
  var winIdx = parseInt(idParts[2], 10) || 0;
  var msgIdx = parseInt(idParts[3], 10) || 0;
  var w = pgWinAt(winIdx);
  var msg = w ? w.messages[msgIdx] : null;

  if (view === 'pretty' && msg && msg.status !== 'complete') {
    pgToast('请等待搜索与总结完成后再转换 Pretty 视图', 'info');
    return;
  }

  var card = btn.closest('.pg-search-raw');
  if (!card) return;
  var btns = card.querySelectorAll('.pg-search-toggle-btn');
  btns.forEach(function(b) { b.classList.remove('pg-search-toggle-btn-active'); });
  btn.classList.add('pg-search-toggle-btn-active');

  var rawView = card.querySelector('.pg-search-raw-view');
  var prettyView = card.querySelector('.pg-search-pretty-view');

  if (view === 'pretty') {
    if (rawView) rawView.style.display = 'none';
    if (prettyView) prettyView.style.display = 'block';

    if (msg && !msg.prettyMarkdown && !msg.prettyRepairing) {
      pgRepairSearchMarkdownAI(winIdx, msgIdx);
    }
  } else {
    if (rawView) rawView.style.display = 'block';
    if (prettyView) prettyView.style.display = 'none';
  }
}