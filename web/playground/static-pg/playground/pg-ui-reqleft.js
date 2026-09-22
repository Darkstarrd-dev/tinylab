// pg-ui-reqleft.js — Playground left panel: conversation list + request entry cache.
//
// Left panel = this app run's requests: one row per client-initiated request
// (Time + Title). Rows live in memory only — nothing is persisted — so quitting
// the app (or reloading the page) clears both the list and every conversation it
// points at. A chat request's row carries the window's message snapshot for that
// request, so clicking the row switches the pane back to that conversation; image
// requests have no conversation and clicking them only reports that.
//
// The usage-entry cache (id → usage.Entry) is fed by /api/monitor/playground,
// the /api/monitor/events SSE stream and the X-TinyLab-Request-Id response header
// captured per request. It backs the response-bubble request/response modal and
// the ttft/gt/in/res/ct/spd rows.
//
// Provides: pgReqLeftTimer/pgReqLeftSSE/pgReqLeftProcTimer, pgRenderReqLeft,
// pgStartReqLeftPolling, pgStopReqLeftPolling, pgConvCreate, pgConvBindEntry,
// pgConvTitleFromText, pgSwitchConversation, pgRenderConvList, pgEntryById,
// pgMergeEntry, pgRefreshBubbleMetrics, pgShowRequestInfo, pgShowReqEntry
var pgReqLeftTimer = null;
var pgReqLeftSSE = null;
var pgReqLeftProcTimer = null;

var PG_CONV_MAX = 50;        // retained conversation rows (newest first)
var PG_REQ_CACHE_MAX = 200;  // retained usage entries (modal + metrics source)

var pgConvList = [];        // newest first: { id, title, ts, entryId, messages }
var pgConvSeq = 0;
var pgActiveConvId = 0;
var pgReqEntryCache = {};   // entry id → usage entry
var pgReqEntryOrder = [];   // cache insertion order, for bounded eviction

// pgTitleFromText builds a conversation title: the first 20 CJK characters, or
// the first 10 words for non-CJK text.
function pgConvTitleFromText(text) {
  var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return '—';
  var chars = Array.from(s);
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s)) {
    return chars.slice(0, 20).join('') + (chars.length > 20 ? '…' : '');
  }
  var words = s.split(' ');
  return words.slice(0, 10).join(' ') + (words.length > 10 ? '…' : '');
}

// pgLastUserText returns the text of the request body's last user message,
// covering both the OpenAI (messages) and Google (contents) body shapes.
function pgLastUserText(body) {
  if (!body) return '';
  var i, m;
  if (Array.isArray(body.messages)) {
    for (i = body.messages.length - 1; i >= 0; i--) {
      m = body.messages[i];
      if (m && m.role === 'user') {
        var t = pgTextContent(m.content);
        if (t) return t;
      }
    }
  }
  if (Array.isArray(body.contents)) {
    for (i = body.contents.length - 1; i >= 0; i--) {
      m = body.contents[i];
      if (m && m.role === 'user' && Array.isArray(m.parts)) {
        var s = '';
        for (var p = 0; p < m.parts.length; p++) {
          if (m.parts[p] && m.parts[p].text) s += m.parts[p].text;
        }
        if (s) return s;
      }
    }
  }
  return '';
}

// pgConvCreate prepends a request row. `messages` is the window's message array
// at send time (null for requests that are not chats); the card is marked active
// only for chat conversations.
function pgConvCreate(title, messages) {
  var row = {
    id: ++pgConvSeq,
    title: title || '—',
    ts: Date.now(),
    entryId: '',
    messages: messages || null,
  };
  pgConvList.unshift(row);
  if (pgConvList.length > PG_CONV_MAX) pgConvList.length = PG_CONV_MAX;
  if (row.messages) pgActiveConvId = row.id;
  pgRenderConvList();
  return row;
}

function pgConvRowById(id) {
  for (var i = 0; i < pgConvList.length; i++) {
    if (pgConvList[i].id === id) return pgConvList[i];
  }
  return null;
}

// pgConvDelete drops a row from the left panel. The row is only a list entry:
// the conversation it points at stays in the pane (deleting the active row
// just clears the active highlight), and the usage entry cache is untouched so
// bubble metrics for existing replies keep working.
function pgConvDelete(rowId) {
  for (var i = 0; i < pgConvList.length; i++) {
    if (pgConvList[i].id !== rowId) continue;
    pgConvList.splice(i, 1);
    if (pgActiveConvId === rowId) pgActiveConvId = 0;
    pgRenderConvList();
    return;
  }
}

// pgConvBindEntry links a row to its usage entry once the response header
// carries the proxy-issued request ID.
function pgConvBindEntry(rowId, entryId) {
  var row = pgConvRowById(rowId);
  if (row) row.entryId = entryId || '';
}

// pgSwitchConversation restores the conversation captured by a row.
function pgSwitchConversation(rowId) {
  var row = pgConvRowById(rowId);
  if (!row) return;
  if (!row.messages) { pgToast(pgT('pgConvUnavailable'), 'warning'); return; }
  if (pgIsGenerating()) { pgToast(pgT('pgGenSwitchLock'), 'warning'); return; }
  var w = pgWinAt(0);
  if (!w) return;
  // Copy the array so continuing the conversation appends to the live list
  // only, leaving the row's snapshot intact.
  w.messages = row.messages.slice();
  // Opening a conversation shows its newest message, whatever the reader had
  // scrolled to in the previous one.
  w.msgsPinned = true;
  pgActiveConvId = row.id;
  if (typeof pgRenderMessages === 'function') pgRenderMessages(0);
  if (typeof pgRenderDebug === 'function') pgRenderDebug();
  pgRenderConvList();
}

function pgRenderReqLeft(showReqLeft) {
  var container = document.getElementById('pg-req-left');
  if (!container) return;
  if (!showReqLeft) {
    container.innerHTML = '';
    pgStopReqLeftPolling();
    if (typeof pgRenderTaskQueue === 'function') pgRenderTaskQueue(false);
    return;
  }
  if (pgState.mode === 'image') {
    container.innerHTML =
      '<div class="pg-req-left-inner pg-req-history-inner">' +
        '<div class="pg-req-left-header">' + pgEscapeHtml(pgT('pgReqLeftTitle')) + '</div>' +
        '<div class="pg-req-table-wrap" id="pg-req-left-content"></div>' +
      '</div>' +
      '<div class="pg-req-left-inner pg-tasks-inner">' +
        '<div class="pg-req-left-header pg-tasks-header"><span>' + pgEscapeHtml(pgT('pgTaskQueueTitle')) + '</span><button class="pg-task-clear-all-btn btn-icon bin-button" type="button" onclick="pgTaskClearAll()" title="' + pgEscapeAttr(pgT('pgTaskClearAllTip')) + '" aria-label="' + pgEscapeAttr(pgT('pgTaskClearAllTip')) + '">' + pgTaskBinSvg() + '</button></div>' +
        '<div class="pg-req-table-wrap" id="pg-tasks-content"></div>' +
      '</div>';
  } else {
    container.innerHTML =
      '<div class="pg-req-left-inner">' +
        '<div class="pg-req-left-header">' + pgEscapeHtml(pgT('pgReqLeftTitle')) + '</div>' +
        '<div class="pg-req-table-wrap" id="pg-req-left-content"></div>' +
      '</div>';
  }
  pgRenderConvList();
  pgStartReqLeftPolling();
  if (typeof pgRenderTaskQueue === 'function') pgRenderTaskQueue(pgState.mode === 'image');
}

// pgRenderConvList renders the Time + Title table from pgConvList.
function pgRenderConvList() {
  var container = document.getElementById('pg-req-left-content');
  if (!container) return;
  if (!pgConvList.length) {
    container.innerHTML = '<div class="pg-req-empty">' + pgEscapeHtml(pgT('pgReqEmpty')) + '</div>';
    return;
  }
  var html = '<table class="pg-req-table"><thead><tr>' +
    '<th class="pg-req-time-col">' + pgEscapeHtml(pgT('pgReqColTime')) + '</th>' +
    '<th>' + pgEscapeHtml(pgT('pgReqColTitle')) + '</th>' +
    '<th class="pg-req-del-col"></th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < pgConvList.length; i++) {
    var row = pgConvList[i];
    var cls = 'pg-req-row' + (row.id === pgActiveConvId ? ' active' : '') +
      (row.messages ? '' : ' pg-req-row-noconv');
    html += '<tr class="' + cls + '" onclick="pgSwitchConversation(' + row.id + ')" title="' + pgEscapeAttr(row.title) + '">' +
      '<td class="pg-req-time-col">' + pgEscapeHtml(new Date(row.ts).toLocaleTimeString()) + '</td>' +
      '<td class="pg-req-title-cell">' + pgEscapeHtml(row.title) + '</td>' +
      '<td class="pg-req-del-col">' +
        '<button type="button" class="pg-req-del-btn btn-icon bin-button" onclick="event.stopPropagation();pgConvDelete(' + row.id + ')" title="' + pgEscapeAttr(pgT('pgConvDeleteTip')) + '" aria-label="' + pgEscapeAttr(pgT('pgConvDeleteTip')) + '">' + pgBinIcon() + '</button>' +
      '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function pgStartReqLeftPolling() {
  pgStopReqLeftPolling();
  pgFetchReqLeft();
  pgReqLeftTimer = setInterval(pgFetchReqLeft, 10000);
  // SSE keeps the entry cache (bubble metrics + detail modal) live.
  try {
    pgReqLeftSSE = new EventSource('/api/monitor/events');
    pgReqLeftSSE.onmessage = function(ev) {
      try {
        var data = JSON.parse(ev.data);
        if (data.type === 'request-start' && data.entry) {
          if (data.entry.source === 'playground') {
            pgMergeEntry(data.entry);
            pgRefreshBubbleMetrics();
            pgReqLeftEnsureProcTimer();
          }
        } else if (data.type === 'request-tokens' && data.id) {
          pgMergeTokenUpdate(data.id, data.entry);
          pgRefreshBubbleMetrics();
        } else if (data.type === 'request-done' && data.id) {
          if (data.entry && data.entry.source === 'playground') pgMergeEntry(data.entry);
          pgRefreshBubbleMetrics();
          if (!pgReqLeftHasProcessing()) pgReqLeftStopProcTimer();
        }
      } catch (ex) {}
    };
  } catch (e) {}
}

function pgStopReqLeftPolling() {
  if (pgReqLeftTimer) {
    clearInterval(pgReqLeftTimer);
    pgReqLeftTimer = null;
  }
  if (pgReqLeftSSE) {
    try { pgReqLeftSSE.close(); } catch (e) {}
    pgReqLeftSSE = null;
  }
  pgReqLeftStopProcTimer();
}

function pgReqLeftHasProcessing() {
  for (var id in pgReqEntryCache) {
    if (pgReqEntryCache[id] && pgReqEntryCache[id].status === 'processing') return true;
  }
  return false;
}

function pgReqLeftEnsureProcTimer() {
  if (pgReqLeftProcTimer) return;
  pgReqLeftProcTimer = setInterval(function() {
    if (pgReqLeftHasProcessing()) {
      pgRefreshBubbleMetrics();
    } else {
      pgReqLeftStopProcTimer();
    }
  }, 500);
}

function pgReqLeftStopProcTimer() {
  if (pgReqLeftProcTimer) {
    clearInterval(pgReqLeftProcTimer);
    pgReqLeftProcTimer = null;
  }
}

function pgEntryById(id) {
  if (!id) return null;
  return pgReqEntryCache[id] || null;
}

// pgMergeEntry stores a usage entry, lifting the live SSE-driven fields of a
// processing entry onto a REST snapshot that may lag them.
function pgMergeEntry(e) {
  if (!e || !e.id) return;
  var prev = pgReqEntryCache[e.id];
  if (prev && prev.status === 'processing' && e.status === 'processing') {
    mergeProcessingEntryFields(prev, e);
  }
  if (!prev) pgReqEntryOrder.push(e.id);
  pgReqEntryCache[e.id] = e;
  while (pgReqEntryOrder.length > PG_REQ_CACHE_MAX) {
    delete pgReqEntryCache[pgReqEntryOrder.shift()];
  }
}

// pgMergeTokenUpdate applies a live request-tokens payload (partial entry) to a
// cached entry.
function pgMergeTokenUpdate(id, d) {
  var e = pgReqEntryCache[id];
  if (!e || !d) return;
  if (d.inputTokens > 0) e.inputTokens = d.inputTokens;
  if (d.outputTokens > 0) e.outputTokens = d.outputTokens;
  if (typeof d.reasoningTokens === 'number') {
    if (d.reasoningTokens === -1) {
      if (!(e.reasoningTokens > 0)) e.reasoningTokens = -1;
    } else if (d.reasoningTokens > (e.reasoningTokens || 0)) {
      e.reasoningTokens = d.reasoningTokens;
    }
  }
  if (d.contentTokens > (e.contentTokens || 0)) e.contentTokens = d.contentTokens;
  if (d.firstContentMs > 0 && !e.firstContentMs) e.firstContentMs = d.firstContentMs;
}

function pgFetchReqLeft() {
  // Playground-scoped endpoint: the data source is physically isolated
  // (playground-origin entries only).
  pgApiGet('/monitor/playground?limit=50').then(function(res) {
    var entries = (res && res.entries) || [];
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].source === 'playground') pgMergeEntry(entries[i]);
    }
    pgRefreshBubbleMetrics();
    if (pgReqLeftHasProcessing()) pgReqLeftEnsureProcTimer();
  }).catch(function() {});
}

// pgRefreshBubbleMetrics re-renders the meta row (buttons + ttft/gt/in/res/ct/spd)
// of every assistant message whose usage entry just changed.
function pgRefreshBubbleMetrics() {
  for (var i = 0; i < pgState.windows.length; i++) {
    var w = pgState.windows[i];
    if (!w || !w.messages) continue;
    for (var idx = 0; idx < w.messages.length; idx++) {
      var m = w.messages[idx];
      if (m && m.role === 'assistant' && m.reqId) pgRenderMsgMeta(i, idx);
    }
  }
}

// pgShowRequestInfo opens the request/response detail modal for the request
// behind an assistant message.
function pgShowRequestInfo(i, idx) {
  var w = pgWinAt(i);
  var msg = w && w.messages[idx];
  if (!msg || !msg.reqId) return;
  pgShowReqEntry(msg.reqId, msg);
}

// pgShowReqEntry renders the entry detail modal, preferring the full entry from
// the server (payloads/headers) and falling back to the cached entry or the
// local message when the entry has been evicted.
async function pgShowReqEntry(id, localMsg) {
  var overlay = document.getElementById('info-modal-overlay');
  if (!overlay) return;
  var titleEl = document.getElementById('info-modal-title');
  var bodyEl = document.getElementById('info-modal-body');
  if (!titleEl || !bodyEl) return;

  var e = null;
  if (id) {
    try {
      var full = await pgApiGet('/monitor/entry/' + encodeURIComponent(id));
      if (full) e = full;
    } catch (ex) {}
    if (!e) e = pgEntryById(id);
  }

  var summaryData = {};
  if (id) summaryData['ID'] = id;
  if (e) {
    if (e.timestamp) summaryData['Timestamp'] = e.timestamp;
    if (e.provider) summaryData['Provider'] = e.provider;
    if (e.model) summaryData['Model'] = e.model;
    if (e.keyName) summaryData['Key'] = e.keyName;
    if (e.status) summaryData['Status'] = e.status;
    if (e.latencyMs !== undefined && e.latencyMs !== null) summaryData['Latency'] = formatLatency(e.latencyMs);
    if (e.ttftMs) summaryData['TTFT'] = e.ttftMs + 'ms';
    if (e.inputTokens) summaryData['Input Tokens'] = e.inputTokens;
    if (e.outputTokens) summaryData['Output Tokens'] = e.outputTokens;
    if (e.error) summaryData['Error'] = e.error;
    if (e.upstreamUrl) summaryData['Upstream URL'] = e.upstreamUrl;
    if (e.respStatus) summaryData['Response Status'] = e.respStatus;
  } else if (localMsg) {
    if (localMsg.startedAt) summaryData['Started'] = new Date(localMsg.startedAt).toISOString();
    if (localMsg.completedAt) summaryData['Completed'] = new Date(localMsg.completedAt).toISOString();
    if (localMsg.durationMs != null) summaryData['Latency'] = formatLatency(localMsg.durationMs);
    if (localMsg.status) summaryData['Status'] = localMsg.status;
    if (localMsg.error) summaryData['Error'] = localMsg.error;
    summaryData['Note'] = 'usage entry evicted';
  }

  titleEl.textContent = ((e && e.provider) || '?') + ' / ' + ((e && e.model) || '?') + ' \u2014 ' +
    ((e && e.status) || (localMsg && localMsg.status) || 'unknown') +
    ' (' + formatLatency((e && e.latencyMs) || (localMsg && localMsg.durationMs) || 0) + ')';

  bodyEl.classList.remove('info-modal-monitor');
  __infoModalSections = [];
  __rawFieldMap = {};
  var html = '';
  if (Object.keys(summaryData).length > 0) {
    html += renderInfoSection('Request Info', summaryData);
  }
  if (e && e.reqPayload) {
    html += renderInfoSection('Request', e.reqPayload);
  }
  if (e && e.reqHeaders) {
    html += renderInfoSection('Request Headers', e.reqHeaders);
  }
  if (e && e.respHeaders) {
    html += renderInfoSection('Response Headers', e.respHeaders);
  }
  if (e && e.respPayload) {
    html += renderInfoSection('Response Body', e.respPayload);
  }
  if (!e && localMsg) {
    var text = pgTextContent(localMsg.content);
    if (text) html += renderInfoSection('Response Body', text);
    if (localMsg.reasoning) html += renderInfoSection('Reasoning', localMsg.reasoning);
  }

  bodyEl.innerHTML = html || '<div class="info-section">' + t('noData') + '</div>';
  postProcessRawFields();

  overlay.classList.add('show');
  bodyEl.setAttribute('tabindex', '-1');
  bodyEl.focus();
}
