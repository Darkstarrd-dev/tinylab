// pg-stream.js
function pgSend(i, assistantIdx) {
  var w = pgWinAt(i);
  var body;
  try { body = pgBuildBodyForWin(i); } catch (e) {
    pgToast(e.message, 'error'); return;
  }
  w.sseEvents = [];
  w.lastProvider = '';
  w.lastKey = '';
  w.pendingContent = '';
  w.pendingReasoning = '';
  w.pendingSources = [];
  w.reasoningStartedAt = null;
  w.reasoningCompletedAt = null;

  var lastUser = null;
  for (var j = body.messages.length - 1; j >= 0; j--) {
    if (body.messages[j].role === 'user') { lastUser = body.messages[j]; break; }
  }
  body = pgFinalizeBodyForSend(body, lastUser, i);
  w.debugRequest = JSON.stringify(body, null, 2);
  w.debugResponse = '';
  w.debugTimestamp = new Date().toISOString();

  if (w.config.stream) {
    pgStream(i, body, assistantIdx);
  } else {
    pgSendNonStream(i, body, assistantIdx);
  }
}

function pgStream(i, body, assistantIdx) {
  var w = pgWinAt(i);
  w.streaming = true;
  w.abortCtrl = new AbortController();
  pgUpdateInputBar();

  var url = '/v1/chat/completions';
  var headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'X-TinyRouter-Source': 'playground' };
  if (w.config.useCustomEndpoint && w.config.customEndpoint && w.config.customEndpoint.trim()) {
    url = w.config.customEndpoint.trim();
    headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
    if (w.config.customEndpointKey) headers['Authorization'] = 'Bearer ' + w.config.customEndpointKey;
  }
  fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
    signal: w.abortCtrl.signal,
  }).then(function(resp) {
    w.lastProvider = w.config.useCustomEndpoint ? 'custom' : (resp.headers.get('X-TinyRouter-Provider') || '');
    w.lastKey = w.config.useCustomEndpoint ? 'custom' : (resp.headers.get('X-TinyRouter-Key') || '');
    if (!resp.ok || !resp.body) {
      resp.text().then(function(text) {
        var details = pgParseErrorDetails(text);
        pgFail(i, assistantIdx, details.errorMessage || ('HTTP ' + resp.status), details.errorCode);
      }).catch(function() {
        pgFail(i, assistantIdx, 'HTTP ' + resp.status);
      });
      return Promise.reject(new Error('HTTP ' + resp.status));
    }
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function(chunk) {
        if (chunk.done) {
          pgFinish(i, assistantIdx);
          var w2 = pgWinAt(i);
          w2.streaming = false;
          pgUpdateInputBar();
          return;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        var events = buffer.split('\n');
        buffer = events.pop();
        for (var j = 0; j < events.length; j++) {
          var line = events[j].trim();
          if (!line) continue;
          if (line.indexOf('data:') === 0) {
            var w3 = pgWinAt(i);
            w3.sseEvents.push(line);
          }
          var data = pgParseSSELine(line);
          if (!data) continue;
          if (data.done) {
            pgFinish(i, assistantIdx);
            var w4 = pgWinAt(i);
            w4.streaming = false;
            pgUpdateInputBar();
            return;
          }
          pgApplyChunk(i, data, assistantIdx);
        }
        pgFlushRender(i, assistantIdx);
        return pump();
      });
    }
    return pump();
  }).catch(function(err) {
    if (err && err.name === 'AbortError') {
      pgFinish(i, assistantIdx);
    } else {
      var w5 = pgWinAt(i);
      if (w5.streaming) {
        pgFail(i, assistantIdx, err && err.message ? err.message : String(err));
      } else {
        pgUpdateInputBar();
      }
    }
  });
}

function pgApplyChunk(i, data, assistantIdx) {
  var w = pgWinAt(i);
  var choices = data.choices;
  if (!choices || !choices.length) {
    pgApplySourcesFromObject(i, data);
    return;
  }
  var delta = choices[0].delta || {};
  if (delta.content) w.pendingContent = pgMergeChunk(w.pendingContent, delta.content);
  var reasonChunk = delta.reasoning_content || delta.reasoning || delta.thinking || delta.thought;
  if (reasonChunk) {
    if (!w.reasoningStartedAt) w.reasoningStartedAt = Date.now();
    w.pendingReasoning = pgMergeChunk(w.pendingReasoning, reasonChunk);
  }
  pgApplySourcesFromObject(i, delta);
  if (choices[0].message) {
    pgApplySourcesFromObject(i, choices[0].message);
  }
}

function pgApplySourcesFromObject(i, obj) {
  var w = pgWinAt(i);
  if (!obj || typeof obj !== 'object') return;
  var candidates = ['sources', 'citations', 'web_search_citation', 'web_search'];
  for (var j = 0; j < candidates.length; j++) {
    var key = candidates[j];
    var val = obj[key];
    if (!val) continue;
    if (Array.isArray(val)) {
      val.forEach(function(item) {
        if (!item) return;
        var href = item.url || item.href || item.link || (typeof item === 'string' ? item : '');
        if (!href) return;
        var title = item.title || item.name || item.snippet || (typeof item === 'string' ? '' : '');
        if (!w.pendingSources.some(function(s) { return s.href === href; })) {
          w.pendingSources.push({ href: href, title: title || href });
        }
      });
    }
  }
}

function pgFlushRender(i, assistantIdx) {
  var w = pgWinAt(i);
  if (w.renderTimer) return;
  w.renderTimer = setTimeout(function() {
    var w2 = pgWinAt(i);
    w2.renderTimer = null;
    if (!w2.streaming) return;
    var msg = w2.messages[assistantIdx];
    if (!msg) return;
    var split = pgExtractAllReasoning(w2.pendingContent);
    if (split.reasoning) {
      w2.pendingReasoning = w2.pendingReasoning
        ? w2.pendingReasoning + '\n' + split.reasoning
        : split.reasoning;
      w2.pendingContent = split.content;
      if (!w2.reasoningStartedAt) w2.reasoningStartedAt = Date.now();
    }
    if (!w2.pendingContent && w2.pendingReasoning) {
    }
    msg.content = w2.pendingContent;
    msg.reasoning = w2.pendingReasoning;
    msg.sources = w2.pendingSources.slice();
    if (w2.reasoningStartedAt) {
      msg.reasoningStartedAt = w2.reasoningStartedAt;
      if (w2.reasoningCompletedAt) {
        msg.reasoningCompletedAt = w2.reasoningCompletedAt;
        msg.reasoningDurationMs = w2.reasoningCompletedAt - w2.reasoningStartedAt;
      } else {
        msg.reasoningDurationMs = Date.now() - w2.reasoningStartedAt;
      }
    }
    msg.status = 'streaming';
    if (w2.reasoningStartedAt && !w2.reasoningCompletedAt && w2.pendingContent) {
      w2.reasoningCompletedAt = Date.now();
      msg.reasoningCompletedAt = w2.reasoningCompletedAt;
      msg.reasoningDurationMs = w2.reasoningCompletedAt - w2.reasoningStartedAt;
    }
    pgRenderBubble(i, assistantIdx);
    pgRenderDebug();
    pgScrollBottom(i, assistantIdx);
    // Group chat modal live-stream hook (guarded; optional module).
    if (typeof pgGcOnStreamChunk === 'function') {
      pgGcOnStreamChunk(i, assistantIdx);
    }
  }, 50);
}

function pgSendNonStream(i, body, assistantIdx) {
  var w = pgWinAt(i);
  w.streaming = true;
  w.abortCtrl = new AbortController();
  pgUpdateInputBar();
  var url = '/v1/chat/completions';
  var headers = { 'Content-Type': 'application/json', 'X-TinyRouter-Source': 'playground' };
  if (w.config.useCustomEndpoint && w.config.customEndpoint && w.config.customEndpoint.trim()) {
    url = w.config.customEndpoint.trim();
    headers = { 'Content-Type': 'application/json' };
    if (w.config.customEndpointKey) headers['Authorization'] = 'Bearer ' + w.config.customEndpointKey;
  }
  fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
    signal: w.abortCtrl.signal,
  }).then(function(resp) {
    w.lastProvider = w.config.useCustomEndpoint ? 'custom' : (resp.headers.get('X-TinyRouter-Provider') || '');
    w.lastKey = w.config.useCustomEndpoint ? 'custom' : (resp.headers.get('X-TinyRouter-Key') || '');
    return resp.json().then(function(j) {
      if (!resp.ok) {
        var details = pgParseErrorDetails(JSON.stringify(j));
        var err2 = new Error(details.errorMessage || ('HTTP ' + resp.status));
        if (details.errorCode) {
          var msg2 = w.messages[assistantIdx];
          if (msg2) msg2.errorCode = details.errorCode;
        }
        throw err2;
      }
      var msg = w.messages[assistantIdx];
      var choice = j.choices && j.choices[0];
      msg.startedAt = msg.startedAt || Date.now();
      msg.completedAt = Date.now();
      msg.durationMs = msg.completedAt - msg.startedAt;
      if (choice && choice.message) {
        msg.content = choice.message.content || '';
        msg.reasoning = choice.message.reasoning_content || '';
        msg.status = 'complete';
        pgApplySourcesFromObject(i, choice.message);
        msg.sources = w.pendingSources.slice();
        if (msg.reasoning) {
          msg.reasoningStartedAt = msg.startedAt;
          msg.reasoningCompletedAt = msg.completedAt;
          msg.reasoningDurationMs = msg.reasoningCompletedAt - msg.reasoningStartedAt;
        }
      } else {
        msg.content = '';
        msg.status = 'complete';
      }
      w.sseEvents.push(JSON.stringify(j, null, 2));
      w.debugResponse = JSON.stringify(j, null, 2);
      pgRenderBubble(i, assistantIdx);
      pgRenderDebug();
      pgSave();
      pgUpdateInputBar();
    });
  }).catch(function(err) {
    if (err && err.name === 'AbortError') {
      pgFinish(i, assistantIdx);
    } else {
      var ec = (w.messages[assistantIdx] && w.messages[assistantIdx].errorCode) || null;
      pgFail(i, assistantIdx, err && err.message ? err.message : String(err), ec);
    }
  });
}

function pgSendImage(i, body, assistantIdx) {
  var w = pgWinAt(i);
  w.streaming = true;
  w.abortCtrl = new AbortController();
  w.sseEvents = [];
  w.lastProvider = '';
  w.lastKey = '';
  w.pendingContent = '';
  w.debugRequest = JSON.stringify(body, null, 2);
  w.debugResponse = '';
  w.debugTimestamp = new Date().toISOString();
  pgUpdateInputBar();

  var msg = w.messages[assistantIdx];
  msg.startedAt = msg.startedAt || Date.now();
  var proto = (typeof pgGetImgProtocol === 'function') ? pgGetImgProtocol(w.config.model) : 'gpt';

  var headers = { 'Content-Type': 'application/json', 'X-TinyRouter-Source': 'playground' };
  if (proto === 'modelscope') {
    headers['X-Modelscope-Async-Mode'] = 'true';
  }

  // Fallback timeout: if the fetch promise never settles (e.g. the playground
  // tab was backgrounded and Chromium aborted the fetch without rejecting),
  // force-fail after imgTimeoutMs so the UI doesn't tick forever. Aligned with
  // pgTickWaiting's pgSafetyNetMs (300s), which covers all real image-gen
  // latencies (2k ~60s, 4k ~4min) with margin, so it only fires for genuinely
  // stuck fetches; the user recovers within 5 minutes if they switch away.
  var imgTimeoutMs = 300000;
  var imgTimer = setTimeout(function() {
    if (w.streaming) {
      try { w.abortCtrl.abort(); } catch(e) {}
      pgFail(i, assistantIdx, 'Request timed out (' + (imgTimeoutMs/1000) + 's)', null);
    }
  }, imgTimeoutMs);

  var endpoint = w.config.imgEndpoint === 'edits' ? '/v1/images/edits' : '/v1/images/generations';
  fetch(endpoint, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
    signal: w.abortCtrl.signal,
  }).then(function(resp) {
    clearTimeout(imgTimer);
    w.lastProvider = resp.headers.get('X-TinyRouter-Provider') || '';
    w.lastKey = resp.headers.get('X-TinyRouter-Key') || '';
    return resp.json().then(function(j) {
      if (!resp.ok || (j && j.error)) {
        var details = pgParseErrorDetails(JSON.stringify(j));
        var err = new Error(details.errorMessage || ('HTTP ' + resp.status));
        if (details.errorCode) {
          if (msg) msg.errorCode = details.errorCode;
        }
        throw err;
      }
      // ModelScope async: check for task ID
      if (proto === 'modelscope') {
        var taskId = j.task_id || j.request_id || (j.data && j.data[0] && j.data[0].task_id) || '';
        if (taskId && (!j.data || !j.data[0] || (!j.data[0].url && !j.data[0].b64_json))) {
          pgPollModelScopeTask(i, taskId, body.model, assistantIdx, msg);
          return;
        }
      }
      msg.completedAt = Date.now();
      msg.durationMs = msg.completedAt - msg.startedAt;
      msg.status = 'complete';
      var dataList = Array.isArray(j.data) ? j.data : (j.data ? [j.data] : []);
      if (dataList.length > 0) {
        var contentParts = [];
        for (var idx = 0; idx < dataList.length; idx++) {
          var item = dataList[idx];
          if (!item) continue;
          var imgUrl = item.url || (item.b64_json ? 'data:image/png;base64,' + item.b64_json : '');
          var revisedPrompt = item.revised_prompt || '';
          if (revisedPrompt) contentParts.push({ type: 'text', text: revisedPrompt });
          if (imgUrl) {
            var imgItem = { url: imgUrl };
            contentParts.push({ type: 'image_url', image_url: imgItem });
            pgAutoSaveImageArtifact(imgUrl, imgItem);
          }
        }
        msg.content = contentParts.length > 0 ? contentParts : '';
      } else {
        msg.content = JSON.stringify(j);
      }
      w.sseEvents.push(JSON.stringify(j, null, 2));
      w.debugResponse = JSON.stringify(j, null, 2);
      pgRenderBubble(i, assistantIdx);
      pgRenderDebug();
      pgSave();
      pgUpdateInputBar();
    });
  }).catch(function(err) {
    clearTimeout(imgTimer);
    if (err && err.name === 'AbortError') {
      pgFinish(i, assistantIdx);
    } else {
      var ec = (w.messages[assistantIdx] && w.messages[assistantIdx].errorCode) || null;
      pgFail(i, assistantIdx, err && err.message ? err.message : String(err), ec);
    }
  });
}

function pgPollModelScopeTask(i, taskId, model, assistantIdx, msg) {
  var w = pgWinAt(i);
  var pollUrl = '/v1/tasks/' + encodeURIComponent(taskId) + '?model=' + encodeURIComponent(model);
  var pollAttempts = 0;
  var maxPollAttempts = 60; // 60 * 5s = 5 minutes max
  function poll() {
    if (!w.streaming) return;
    pollAttempts++;
    if (pollAttempts > maxPollAttempts) {
      pgFail(i, assistantIdx, 'ModelScope task polling timed out after ' + maxPollAttempts + ' attempts');
      return;
    }
    fetch(pollUrl, {
      method: 'GET',
      headers: { 'X-ModelScope-Task-Type': 'image_generation', 'X-TinyRouter-Source': 'playground' },
      signal: w.abortCtrl.signal,
    }).then(function(resp) {
      return resp.json().then(function(j) {
        w.sseEvents.push(JSON.stringify(j, null, 2));
        w.debugResponse = JSON.stringify(j, null, 2);
        pgRenderDebug();
        var status = (j.task_status || '').toUpperCase();
        if (status === 'SUCCEED' || status === 'SUCCESS' || status === 'COMPLETED') {
          var imageUrls = [];
          if (Array.isArray(j.output_images) && j.output_images.length > 0) {
            imageUrls = j.output_images;
          } else if (Array.isArray(j.data) && j.data.length > 0) {
            for (var dIdx = 0; dIdx < j.data.length; dIdx++) {
              var dItem = j.data[dIdx];
              if (!dItem) continue;
              var u = dItem.url || (dItem.b64_json ? 'data:image/png;base64,' + dItem.b64_json : '');
              if (u) imageUrls.push(u);
            }
          } else if (j.output && Array.isArray(j.output.images) && j.output.images.length > 0) {
            for (var oIdx = 0; oIdx < j.output.images.length; oIdx++) {
              var oUrl = j.output.images[oIdx].url || j.output.images[oIdx];
              if (typeof oUrl === 'string' && oUrl) imageUrls.push(oUrl);
            }
          } else if (j.image_url) {
            imageUrls = [j.image_url];
          }
          msg.completedAt = Date.now();
          msg.durationMs = msg.completedAt - msg.startedAt;
          msg.status = 'complete';
          if (imageUrls.length > 0) {
            var msContent = [];
            for (var uIdx = 0; uIdx < imageUrls.length; uIdx++) {
              var targetUrl = imageUrls[uIdx];
              var msItem = { url: targetUrl };
              msContent.push({ type: 'image_url', image_url: msItem });
              pgAutoSaveImageArtifact(targetUrl, msItem);
            }
            msg.content = msContent;
          } else {
            msg.content = JSON.stringify(j);
          }
          pgRenderBubble(i, assistantIdx);
          pgSave();
          pgUpdateInputBar();
        } else if (status === 'FAILED' || status === 'ERROR') {
          pgFail(i, assistantIdx, 'Image generation task failed: ' + (j.message || status));
        } else {
          setTimeout(poll, 2000);
        }
      });
    }).catch(function(err) {
      if (err && err.name === 'AbortError') {
        pgFinish(i, assistantIdx);
      } else {
        setTimeout(poll, 3000);
      }
    });
  }
  setTimeout(poll, 2000);
}

function pgAutoSaveImageArtifact(url, imgObj) {
  if (!url) return;
  pgApiPost('/save-image', { url: url }).then(function(res) {
    if (res && res.path && imgObj) {
      imgObj.savedPath = res.path;
      imgObj.savedFilename = res.filename || res.path;
      pgSave();
      if (typeof pgRefreshImageModalMeta === 'function') {
        pgRefreshImageModalMeta(url, res.path, res.filename);
      }
    }
  }).catch(function(err) {
    console.warn('[Playground] Auto-save image artifact failed:', err);
  });
}

function pgFinish(i, assistantIdx) {
  var w = pgWinAt(i);
  if (!w.streaming) return;
  w.streaming = false;
  if (w.renderTimer) { clearTimeout(w.renderTimer); w.renderTimer = null; }
  w.abortCtrl = null;
  var msg = w.messages[assistantIdx];
  if (msg) {
    msg.content = w.pendingContent;
    msg.reasoning = w.pendingReasoning;
    msg.sources = w.pendingSources.slice();
    var split = pgExtractAllReasoning(msg.content);
    if (split.reasoning) msg.reasoning = (msg.reasoning ? msg.reasoning + '\n\n---\n\n' : '') + split.reasoning;
    msg.content = split.content;
    if (msg.status !== 'error') msg.status = 'complete';
    if (w.reasoningStartedAt && !w.reasoningCompletedAt) {
      w.reasoningCompletedAt = Date.now();
    }
    if (msg.reasoningStartedAt && !msg.reasoningCompletedAt && w.reasoningCompletedAt) {
      msg.reasoningCompletedAt = w.reasoningCompletedAt;
    }
    if (msg.reasoningStartedAt && msg.reasoningCompletedAt) {
      msg.reasoningDurationMs = msg.reasoningCompletedAt - msg.reasoningStartedAt;
    }
    if (!msg.completedAt) {
      msg.completedAt = Date.now();
      if (msg.startedAt) msg.durationMs = msg.completedAt - msg.startedAt;
    }
  }
  w.pendingContent = '';
  w.pendingReasoning = '';
  w.pendingSources = [];
  w.reasoningStartedAt = null;
  w.reasoningCompletedAt = null;
  if (i === 0) pgSave();
  pgRenderBubble(i, assistantIdx);
  pgRenderDebug();
  pgScrollBottomReasoning(i, assistantIdx);
  pgUpdateInputBar();
  // Auto chat hook: notify round orchestration (guarded; optional module).
  if (typeof pgAutoChatOnFinish === 'function' && pgState.autoChat && pgState.autoChat.isRunning) {
    pgAutoChatOnFinish(i);
  }
}

function pgFail(i, assistantIdx, errMsg, errorCode) {
  var w = pgWinAt(i);
  w.streaming = false;
  if (w.renderTimer) { clearTimeout(w.renderTimer); w.renderTimer = null; }
  w.abortCtrl = null;
  var msg = w.messages[assistantIdx];
  if (msg) {
    msg.error = errMsg;
    if (errorCode) msg.errorCode = errorCode;
    msg.content = pgTextContent(w.pendingContent) ? w.pendingContent : '';
    msg.reasoning = w.pendingReasoning;
    msg.status = 'error';
    if (!msg.completedAt) {
      msg.completedAt = Date.now();
      if (msg.startedAt) msg.durationMs = msg.completedAt - msg.startedAt;
    }
  }
  w.sseEvents.push('[ERROR] ' + errMsg);
  if (i === 0) pgSave();
  pgRenderBubble(i, assistantIdx);
  pgRenderDebug();
  pgUpdateInputBar();
  // Auto chat failure retry (guarded; optional module). Returns true and
  // schedules a retry without triggering onFinish.
  if (typeof pgAutoChatShouldRetry === 'function' &&
      pgState.autoChat && pgState.autoChat.isRunning) {
    if (pgAutoChatShouldRetry(i, assistantIdx)) {
      return;
    }
  }
  // Auto chat: a failed window still counts as a completed reply.
  if (typeof pgAutoChatOnFinish === 'function' && pgState.autoChat && pgState.autoChat.isRunning) {
    pgAutoChatOnFinish(i);
  }
}

// ----- Module 6: Stop / Clear / Global controls --------------------
function pgStop() {
  // Signal auto chat to suppress finish hooks during shutdown.
  if (pgState.autoChat && pgState.autoChat.isRunning) {
    pgState.autoChat.abortFlag = true;
    pgState.autoChat.session++;
  }
  for (var i = 0; i < pgState.windows.length; i++) {
    var w = pgWinAt(i);
    if (w.abortCtrl) {
      try { w.abortCtrl.abort(); } catch (e) {}
      w.abortCtrl = null;
    }
    if (w.streaming) {
      var last = w.messages.length - 1;
      for (var j = last; j >= 0; j--) {
        if (w.messages[j].role === 'assistant'
            && (w.messages[j].status === 'streaming'
                || w.messages[j].status === 'loading')) {
          pgFinish(i, j);
          break;
        }
      }
    }
    // Safety: force streaming off
    if (pgWinAt(i).streaming) {
      pgWinAt(i).streaming = false;
    }
  }
  // Terminate auto chat loop if active.
  if (typeof pgAutoChatStop === 'function' && pgState.autoChat && pgState.autoChat.isRunning) {
    pgAutoChatStop();
  }
  pgUpdateInputBar();
}

function pgClear() {
  pgStop();
  if (pgState.mode === 'search') {
    // In search mode, clear the active search's messages and reset state
    var s = pgActiveSearch();
    if (s) {
      s.messages = [];
    }
    pgState.activeSearchId = null;
    var w0 = pgWinAt(0);
    if (w0) {
      w0.messages = [];
      w0.sseEvents = [];
    }
    pgRenderMessages(0);
    pgRenderSidebar();
    pgUpdateInputBar();
    return;
  }
  for (var i = 0; i < pgState.splitCount; i++) {
    var w = pgWinAt(i);
    w.messages = [];
    w.sseEvents = [];
    pgRenderMessages(i);
  }
  pgSave();
  pgRenderDebug();
}

function pgClearWindowMessages(winIdx) {
  var w = pgWinAt(winIdx);
  if (!w) return;
  if (!confirm(pgT('pgClearConfirm'))) return;
  if (w.streaming && w.abortCtrl) { try { w.abortCtrl.abort(); } catch(e){} w.streaming = false; }
  w.messages = [];
  w.sseEvents = [];
  pgRenderMessages(winIdx);
  pgSave();
  if (winIdx === pgState.activeWin) pgRenderDebug();
}

function pgIsGenerating() {
  return pgState.windows.some(function(w) { return w.streaming; });
}

function pgAnyWindowHasModel() {
  for (var i = 0; i < pgState.splitCount; i++) {
    if (pgWinAt(i).config.model) return true;
  }
  return false;
}
