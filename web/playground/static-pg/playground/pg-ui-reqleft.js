// pg-ui-reqleft.js — Request Left polling + render (split from pg-ui.js)
// Provides: pgReqLeftTimer/pgReqLeftSSE/pgReqLeftProcTimer/pgReqLeftInflight,
// pgRenderReqLeft, pgStartReqLeftPolling, pgStopReqLeftPolling, pgReqLeftHasProcessing,
// pgReqLeftEnsureProcTimer, pgReqLeftStopProcTimer, pgReqLeftMergeEntry, pgReqLeftRender,
// pgFetchReqLeft, pgRenderReqLeftContent, pgReqLeftEntries, pgShowReqDetail
var pgReqLeftTimer = null;
var pgReqLeftSSE = null;
var pgReqLeftProcTimer = null;
var pgReqLeftInflight = {};  // id → entry, for processing entries from SSE

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
  pgStartReqLeftPolling();
  if (typeof pgRenderTaskQueue === 'function') pgRenderTaskQueue(pgState.mode === 'image');
}

function pgStartReqLeftPolling() {
  pgStopReqLeftPolling();
  pgFetchReqLeft();
  pgReqLeftTimer = setInterval(pgFetchReqLeft, 10000);
  // SSE for real-time request-start/done events
  try {
    pgReqLeftSSE = new EventSource('/api/monitor/events');
    pgReqLeftSSE.onmessage = function(ev) {
      try {
        var data = JSON.parse(ev.data);
        if (data.type === 'request-start' && data.entry) {
          var e = data.entry;
          if (e.source === 'playground') {
            pgReqLeftInflight[e.id] = e;
            pgReqLeftMergeEntry(e);
            pgReqLeftRender();
            pgReqLeftEnsureProcTimer();
          }
        } else if (data.type === 'request-done' && data.id) {
          var inflight = pgReqLeftInflight[data.id];
          if (inflight) {
            delete pgReqLeftInflight[data.id];
          }
          // 仅 merge Playground 来源的完成条目，避免 Recent Requests 的请求漏入
          if (data.entry && data.entry.source === 'playground') {
            pgReqLeftMergeEntry(data.entry);
          }
          pgReqLeftRender();
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
  pgReqLeftInflight = {};
}

function pgReqLeftHasProcessing() {
  return Object.keys(pgReqLeftInflight).length > 0;
}

function pgReqLeftEnsureProcTimer() {
  if (pgReqLeftProcTimer) return;
  pgReqLeftProcTimer = setInterval(function() {
    if (pgReqLeftHasProcessing()) {
      pgReqLeftRender();
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

// Merge an entry into pgReqLeftEntries (replace if same id, else prepend)
function pgReqLeftMergeEntry(e) {
  if (!e || !e.id) return;
  var found = -1;
  for (var j = 0; j < pgReqLeftEntries.length; j++) {
    if (pgReqLeftEntries[j].id === e.id) { found = j; break; }
  }
  if (found >= 0) {
    pgReqLeftEntries[found] = e;
  } else {
    pgReqLeftEntries.unshift(e);
  }
  // Keep list bounded
  if (pgReqLeftEntries.length > 50) pgReqLeftEntries = pgReqLeftEntries.slice(0, 50);
}

// Render the table from pgReqLeftEntries (no data fetch)
function pgReqLeftRender() {
  var container = document.getElementById('pg-req-left-content');
  if (!container) return;
  var entries = pgReqLeftEntries;
  if (!entries.length) {
    container.innerHTML = '<div class="pg-req-empty">' + pgEscapeHtml(pgT('pgReqEmpty')) + '</div>';
    return;
  }
  // Sort by timestamp descending
  entries = entries.slice().sort(function(a, b) {
    var ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    var tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });
  pgReqLeftEntries = entries;
  var html = '<table class="pg-req-table"><thead><tr>' +
    '<th class="pg-req-status-col"></th>' +
    '<th>' + pgEscapeHtml(pgT('pgReqColTime')) + '</th>' +
    '<th>' + pgEscapeHtml(pgT('pgReqColLatency')) + '</th>' +
    '<th>' + pgEscapeHtml(pgT('pgReqColTokens')) + '</th>' +
    '</tr></thead><tbody>';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var dotCls = 'pg-req-dot';
    if (e.status === 'success') dotCls += ' pg-req-dot-success';
    else if (e.status === 'error') dotCls += ' pg-req-dot-error';
    else if (e.status === 'retry') dotCls += ' pg-req-dot-retry';
    else dotCls += ' pg-req-dot-processing';
    var timeStr = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '—';
    var latStr;
    if (e.status === 'processing') {
      latStr = e.timestamp ? ((Date.now() - new Date(e.timestamp).getTime()) / 1000).toFixed(1) + 's' : '—';
    } else {
      latStr = e.latencyMs ? (e.latencyMs / 1000).toFixed(1) + 's' : '—';
    }
    var tokStr = (e.status === 'processing') ? '—' : ((e.inputTokens || 0) + '/' + (e.outputTokens || 0));
    html += '<tr style="cursor:pointer" onclick="pgShowReqDetail(' + i + ')">' +
      '<td class="pg-req-status-col"><span class="' + dotCls + '"></span></td>' +
      '<td>' + pgEscapeHtml(timeStr) + '</td>' +
      '<td>' + pgEscapeHtml(latStr) + '</td>' +
      '<td>' + pgEscapeHtml(tokStr) + '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function pgFetchReqLeft() {
  // 使用 Playground 专用端点，数据源已物理隔离（仅含 playground 来源）
  pgApiGet('/monitor/playground?limit=50').then(function(res) {
    var entries = (res && res.entries) || [];
    // 双保险：仍过滤一次，防止未来数据源变更引入污染
    entries = entries.filter(function(e) { return e.source === 'playground'; });
    var seenIds = {};
    entries.forEach(function(e) { seenIds[e.id] = true; });
    for (var id in pgReqLeftInflight) {
      if (!seenIds[id]) {
        entries.unshift(pgReqLeftInflight[id]);
      }
    }
    pgReqLeftEntries = entries;
    pgReqLeftRender();
    if (pgReqLeftHasProcessing()) pgReqLeftEnsureProcTimer();
  }).catch(function() {});
}

function pgRenderReqLeftContent(data) {
  var entries = (data && data.entries) || [];
  entries = entries.filter(function(e) { return e.source === 'playground'; });
  pgReqLeftEntries = entries;
  pgReqLeftRender();
}

var pgReqLeftEntries = [];

async function pgShowReqDetail(idx) {
  var e = pgReqLeftEntries[idx];
  if (!e) return;
  if (e.id) {
    try {
      var full = await pgApiGet('/monitor/entry/' + encodeURIComponent(e.id));
      if (full) e = full;
    } catch(ex) {}
  }
  var overlay = document.getElementById('info-modal-overlay');
  if (!overlay) return;
  var titleEl = document.getElementById('info-modal-title');
  var bodyEl = document.getElementById('info-modal-body');
  if (!titleEl || !bodyEl) return;

  titleEl.textContent = (e.provider || '?') + ' / ' + (e.model || '?') + ' \u2014 ' + (e.status || 'unknown') + ' (' + formatLatency(e.latencyMs || 0) + ')';

  bodyEl.classList.remove('info-modal-monitor');
  __infoModalSections = [];
  __rawFieldMap = {};
  var html = '';

  var summaryData = {};
  if (e.id) summaryData['ID'] = e.id;
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
  if (Object.keys(summaryData).length > 0) {
    html += renderInfoSection('Request Info', summaryData);
  }
  if (e.reqPayload) {
    html += renderInfoSection('Request', e.reqPayload);
  }
  if (e.reqHeaders) {
    html += renderInfoSection('Request Headers', e.reqHeaders);
  }
  if (e.respHeaders) {
    html += renderInfoSection('Response Headers', e.respHeaders);
  }
  if (e.respPayload) {
    html += renderInfoSection('Response Body', e.respPayload);
  }

  bodyEl.innerHTML = html || '<div class="info-section">' + t('noData') + '</div>';
  postProcessRawFields();

  overlay.classList.add('show');
  bodyEl.setAttribute('tabindex', '-1');
  bodyEl.focus();
}

