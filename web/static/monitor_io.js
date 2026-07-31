// ===== REST/SSE data plumbing and entry merging =====

// mergeUsageEntries deduplicates API entries by ID (preferring the terminal
// ring entry over a duplicate inflight one), preserves streaming buffers
// from the previous render, merges live inflight entries, retains a bounded
// set of ring-evicted terminal entries, sorts by time desc, and commits the
// result to lastUsageEntries. Shared by renderUsage and refreshQuotaData.
function mergeUsageEntries(apiEntries) {
  var apiIds = {};
  apiEntries.forEach(function(e) { if (e.id) apiIds[e.id] = true; });
  // Index lastUsageEntries by id once (O(n)) instead of .find() per entry.
  var existingById = {};
  for (var i = 0; i < lastUsageEntries.length; i++) {
    var x = lastUsageEntries[i];
    if (x.id) existingById[x.id] = x;
  }
  var seenIds = {};
  var merged = [];
  apiEntries.forEach(function(e) {
    if (e.id && seenIds[e.id]) return;
    var existing = e.id ? existingById[e.id] : null;
    if (existing) {
      if (existing.__streamingReasoning) e.__streamingReasoning = existing.__streamingReasoning;
      if (existing.__streamingAssistant) e.__streamingAssistant = existing.__streamingAssistant;
      if (existing.__streamingUsage) e.__streamingUsage = existing.__streamingUsage;
    }
    if (e.id) seenIds[e.id] = true;
    merged.push(e);
  });
  Object.keys(inflightEntries).forEach(function(id) {
    if (!apiIds[id]) {
      var ts = new Date(inflightEntries[id].timestamp).getTime();
      if (Date.now() - ts > MAX_PROCESSING_MS) {
        delete inflightEntries[id];
      } else {
        merged.unshift(inflightEntries[id]);
      }
    }
  });
  for (var i = 0; i < merged.length; i++) {
    var me = merged[i];
    if (me.id && me.status !== 'processing' && inflightEntries[me.id]) {
      delete inflightEntries[me.id];
    }
  }
  sortEntriesByTimeDesc(merged);
  var _preserved = 0;
  for (var i = 0; i < lastUsageEntries.length; i++) {
    var e = lastUsageEntries[i];
    if (e.id && e.status !== 'processing' && !seenIds[e.id]) {
      merged.push(e);
      seenIds[e.id] = true;
      if (++_preserved >= MAX_PRESERVED_TERMINAL) break;
    }
  }
  sortEntriesByTimeDesc(merged);
  lastUsageEntries = merged;
  return merged;
}

function scheduleQuotaRefresh() {
  if (_quotaRefreshTimer) clearTimeout(_quotaRefreshTimer);
  _quotaRefreshTimer = setTimeout(function() {
    _quotaRefreshTimer = null;
    refreshQuotaData();
  }, 300);
}

async function refreshQuotaData() {
  try {
    const [summary, usage, quotas] = await Promise.all([
      apiGet('/monitor/summary'),
      apiGet('/monitor?limit=500'),
      apiGet('/monitor/quotas')
    ]);
    mergeUsageEntries(usage.entries || []);
    updateUsageSummary(summary);
    updateQuotaTable(quotas.quotas || []);
    updateRecentRequestsInline(lastUsageEntries);
    ensureProcessingTimer();
    refreshAllKeyDetails();
  } catch(e) { console.warn('refreshQuotaData failed:', e); }
}

function applyUsageSSEHandlers(es) {
  es.onmessage = function(ev) {
    try {
      var data = JSON.parse(ev.data);
      if (data.type === 'usage-updated' || data.type === 'key-inflight') {
        scheduleQuotaRefresh();
        return;
      }
      if (data.type === 'request-start') {
        handleRequestStart(data.entry);
        scheduleQuotaRefresh();
        return;
      }
      if (data.type === 'request-done') {
        handleRequestDone(data.id, data.status, data.entry);
        scheduleQuotaRefresh();
        return;
      }
      if (data.type === 'request-chunk') {
        handleRequestChunk(data.id, data.section, data.delta);
      }
      if (data.type === 'request-ttft') {
        handleRequestTTFT(data.id, data.entry);
      }
      if (data.type === 'request-tokens') {
        handleRequestTokens(data.id, data.entry);
      }
    } catch(e) {}
  };
  es.onerror = function() {
    var status = document.getElementById('console-status');
    if (status) status.textContent = t('disconnected');
  };
  es.onopen = function() {
    var status = document.getElementById('console-status');
    if (status) status.textContent = t('connected');
  };
}

function handleRequestStart(entry) {
  if (!entry) return;
  // 排除 Playground 来源：Playground 请求由其独立列表展示，不进 Recent Requests
  if (entry.source === 'playground') return;
  if (!entry.id) entry.id = 'inflight-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  // 去重：如果 ID 已在 inflight 中，仅更新不做重复插入
  if (inflightEntries[entry.id]) {
    inflightEntries[entry.id] = entry;
    var found2 = lastUsageEntries.findIndex(function(x) { return x.id === entry.id; });
    if (found2 >= 0 && lastUsageEntries[found2].status === 'processing') {
      lastUsageEntries[found2] = entry;
    }
    return;
  }
  inflightEntries[entry.id] = entry;
  var found = lastUsageEntries.findIndex(function(x) { return x.id === entry.id; });
  if (found >= 0) {
    if (lastUsageEntries[found].status === 'processing') {
      lastUsageEntries[found] = entry;
    }
  } else {
    lastUsageEntries.unshift(entry);
  }
  sortEntriesByTimeDesc(lastUsageEntries);
  updateRecentRequestsInline(lastUsageEntries);
  ensureProcessingTimer();
}

function handleRequestDone(id, status, entry) {
  if (!id) return;
  // 排除 Playground 来源（entry 可能为 undefined，需判空）
  if (entry && entry.source === 'playground') return;
  var inflightEntry = inflightEntries[id];
  if (!inflightEntry && !entry) return;
  var completeEntry = entry || inflightEntry;
  if (inflightEntry) {
    completeEntry.__streamingReasoning = inflightEntry.__streamingReasoning || '';
    completeEntry.__streamingAssistant = inflightEntry.__streamingAssistant || '';
    completeEntry.__streamingUsage = inflightEntry.__streamingUsage || '';
    if (!completeEntry.reqPayload && inflightEntry.reqPayload) {
      completeEntry.reqPayload = inflightEntry.reqPayload;
    }
    if (!completeEntry.reqHeaders && inflightEntry.reqHeaders) {
      completeEntry.reqHeaders = inflightEntry.reqHeaders;
    }
    if (!completeEntry.upstreamUrl && inflightEntry.upstreamUrl) {
      completeEntry.upstreamUrl = inflightEntry.upstreamUrl;
    }
  }
  if (completeEntry) {
    if (status) completeEntry.status = status;
  }
  var found = lastUsageEntries.findIndex(function(x) { return x.id === id; });
  if (found >= 0) {
    lastUsageEntries[found] = completeEntry;
  } else {
    lastUsageEntries.unshift(completeEntry);
  }
  sortEntriesByTimeDesc(lastUsageEntries);
  delete inflightEntries[id];
  updateRecentRequestsInline(lastUsageEntries);
  if (!hasProcessingEntries()) stopProcessingTimer();
  if (currentInfoModalRequestId === id) {
    currentInfoModalStreamingDone = true;
    if (completeEntry.respPayload) {
      updateStreamingModalResponse(completeEntry);
    } else if (traceEnabled) {
      // trace mode: ring entry has no payload; fetch final response from trace file.
      // Remove streaming sections first so trace content replaces them.
      var bodyEl = document.getElementById('info-modal-body');
      if (bodyEl) {
        var sr = bodyEl.querySelector('#streaming-reasoning-section');
        if (sr) sr.remove();
        var sa = bodyEl.querySelector('#streaming-assistant-section');
        if (sa) sa.remove();
        var su = bodyEl.querySelector('#streaming-usage-section');
        if (su) su.remove();
        var srb = bodyEl.querySelector('#streaming-response-body-section');
        if (srb) srb.remove();
        // Add a trace-loading placeholder if not present.
        if (!bodyEl.querySelector('#trace-loading-section')) {
          var ph = document.createElement('div');
          ph.className = 'info-section';
          ph.id = 'trace-loading-section';
          ph.innerHTML = '<div class="info-section-title">' + escapeHtml(t('infoTraceDetail')) + '</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap;color:var(--text-muted)">' + escapeHtml(t('infoLoadingTrace')) + '</pre></div></div>';
          bodyEl.appendChild(ph);
        }
      }
      loadTraceDetails(completeEntry);
    }
  }
}

function handleRequestChunk(id, section, delta) {
  if (!id || !delta) return;
  var inflight = inflightEntries[id];
  if (inflight) {
    if (section === 'reasoning') {
      inflight.__streamingReasoning = (inflight.__streamingReasoning || '') + delta;
    } else if (section === 'assistant') {
      inflight.__streamingAssistant = (inflight.__streamingAssistant || '') + delta;
    } else if (section === 'usage') {
      inflight.__streamingUsage = (inflight.__streamingUsage || '') + delta;
    }
  }
  if (currentInfoModalRequestId !== id) return;
  if (currentInfoModalStreamingDone) return;
  var targetEl;
  if (section === 'reasoning') {
    targetEl = currentInfoModalReasoningEl;
  } else if (section === 'assistant') {
    targetEl = currentInfoModalAssistantEl;
  } else if (section === 'usage') {
    targetEl = currentInfoModalUsageEl;
  }
  if (!targetEl) return;
  var text = targetEl.textContent || '';
  targetEl.textContent = text + (delta || '');
}

function handleRequestTTFT(id, entry) {
  if (!id || !entry) return;
  var ttftMs = entry.ttftMs || 0;
  if (ttftMs <= 0) return;
  var inflight = inflightEntries[id];
  if (inflight) {
    inflight.ttftMs = ttftMs;
  }
  var found = lastUsageEntries.findIndex(function(x) { return x.id === id; });
  if (found >= 0 && lastUsageEntries[found].status === 'processing') {
    lastUsageEntries[found].ttftMs = ttftMs;
  }
  var row = document.querySelector('tr[data-id="' + sanitizeId(id) + '"]');
  if (row) {
    row.setAttribute('data-ttft', '1');
    var cell = row.querySelector('.latency-cell');
    if (cell) cell.textContent = formatLatency(ttftMs);
  }
}

function handleRequestTokens(id, entry) {
  if (!id || !entry) return;
  var input = entry.inputTokens;
  var output = entry.outputTokens || 0;
  var inflight = inflightEntries[id];
  if (inflight) {
    if (input && input > 0) inflight.inputTokens = input;
    inflight.outputTokens = output;
  }
  var found = lastUsageEntries.findIndex(function(x) { return x.id === id; });
  if (found >= 0 && lastUsageEntries[found].status === 'processing') {
    if (input && input > 0) lastUsageEntries[found].inputTokens = input;
    lastUsageEntries[found].outputTokens = output;
  }
  var row = document.querySelector('tr[data-id="' + sanitizeId(id) + '"]');
  if (row) {
    var cell = row.querySelector('.tokens-cell');
    if (cell) {
      var displayInput = (input && input > 0) ? input : ((inflight && inflight.inputTokens) || (found >= 0 ? lastUsageEntries[found].inputTokens : 0) || 0);
      cell.textContent = displayInput + '/' + output;
    }
  }
}