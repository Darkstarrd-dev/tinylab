// ===== Usage Entry Info Modal (Debug Mode) =====

async function showUsageEntryInfoById(id) {
  if (!id) return;
  var e = lastUsageEntries.find(function(x) { return x.id === id; });
  if (!e) {
    e = inflightEntries[id];
  }
  if (!e) return;
  // If the entry is processing-status but no longer in inflightEntries, the
  // request completed but the SSE request-done event may have been dropped
  // (broadcaster channel full) or the entry came from refreshQuotaData's merged
  // result which only has the tracker's processing copy. Also handle the case
  // where the entry has a terminal status (success/error) but no respPayload/
  // respHeaders — this happens when handleRequestDone fell back to the inflight
  // entry (which lacks payloads) because the SSE event's entry field was
  // missing or incomplete. In both cases, try to fetch the ring entry (which
  // carries respPayload/respHeaders) from the API.
  if (!traceEnabled && (e.status === 'processing' || (!infoHasValue(e.respPayload) && !infoHasValue(e.respHeaders))) && !inflightEntries[id]) {
    try {
      var resp = await apiGet('/monitor?limit=500&offset=0');
      var entries = (resp && resp.entries) || [];
      var ringEntry = entries.find(function(x) { return x.id === id; });
      if (ringEntry && ringEntry.status !== 'processing') {
        e = ringEntry;
      }
    } catch(ex) { /* fall through to the entry we have */ }
  }
  showUsageEntryInfoWithData(e);
}

function monitorSectionOptions(sectionId, rawData, withViewControls) {
  return {
    monitor: true,
    collapsible: true,
    defaultCollapsed: true,
    sectionView: withViewControls !== false,
    sectionCopy: withViewControls !== false,
    sectionId: sectionId,
    rawData: rawData
  };
}

function monitorRenderDataSection(title, value, sectionId) {
  if (!infoHasValue(value)) return '';
  if (typeof value === 'object' && value !== null) {
    return renderInfoSection(title, value, null, monitorSectionOptions(sectionId, value, true));
  }
  var formatted = formatBody(value);
  return renderInfoSection(title, { Body: formatted }, { Body: value }, monitorSectionOptions(sectionId, value, true));
}

function monitorRenderStatusSection(status, sectionId) {
  if (!infoHasValue(status)) return '';
  return '<div class="info-section info-section-monitor info-section-status" id="' + escapeHtml(sectionId) + '">' +
    '<div class="info-section-title">' +
      '<span class="info-section-title-text">' + escapeHtml(t('infoStatus')) + '</span>' +
      '<span class="info-status-value">' + escapeHtml(String(status)) + '</span>' +
    '</div>' +
  '</div>';
}

function monitorRenderTextSection(title, sectionId, textId, initialText, copyEnabled, initiallyHidden) {
  var copy = copyEnabled ? '<span class="info-section-actions"><button type="button" class="info-copy-btn" onclick="copyStreamingTextById(this,\'' + escapeForJsString(textId) + '\')">' + escapeHtml(t('infoCopy')) + '</button></span>' : '';
  return '<div class="info-section info-section-monitor info-section-collapsed" id="' + escapeHtml(sectionId) + '"' + (initiallyHidden ? ' style="display:none"' : '') + '>' +
    '<div class="info-section-title">' +
      '<button type="button" class="info-section-toggle" onclick="toggleInfoSection(this)" aria-expanded="false" aria-controls="' + escapeHtml(sectionId) + '-content">' +
        '<span class="info-section-chevron" aria-hidden="true">&#9656;</span>' +
        '<span class="info-section-title-text">' + escapeHtml(title) + '</span>' +
      '</button>' + copy +
    '</div>' +
    '<div class="info-section-content" id="' + escapeHtml(sectionId) + '-content" hidden>' +
      '<div class="info-field">' +
        '<span class="info-field-key"><span class="info-field-key-name">' + escapeHtml(t('infoContent')) + '</span></span>' +
        '<div class="info-field-value"><pre class="info-json" id="' + escapeHtml(textId) + '" style="white-space:pre-wrap;min-height:20px">' + escapeHtml(initialText == null ? '' : initialText) + '</pre></div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

async function loadTraceDetails(e) {
  if (currentInfoModalRequestId !== e.id) return;
  var loadingEl = document.getElementById('trace-loading-section');
  if (!loadingEl) return;
  try {
    var data = await apiGet('/traces/req/' + encodeURIComponent(e.id));
    if (currentInfoModalRequestId !== e.id) return;
    var traceHtml = '';
    if (data && data.lines && data.lines.length > 0) {
      var reqLine = data.lines.find(function(l) { return l.type === 'request'; });
      var attemptLines = data.lines.filter(function(l) { return l.type === 'attempt'; });
      var lastAttempt = attemptLines.length > 0 ? attemptLines[attemptLines.length - 1] : null;
      if (reqLine && infoHasValue(reqLine.reqBody)) traceHtml += monitorRenderDataSection(t('infoRequestBody'), reqLine.reqBody, 'monitor-request');
      if (reqLine && infoHasValue(reqLine.reqHeaders)) traceHtml += monitorRenderDataSection(t('infoRequestHeaders'), reqLine.reqHeaders, 'monitor-request-headers');
      if (lastAttempt) {
        if (infoHasValue(lastAttempt.respHeaders)) traceHtml += monitorRenderDataSection(t('infoResponseHeaders'), lastAttempt.respHeaders, 'monitor-response-headers');
        if (infoHasValue(lastAttempt.respStatus)) traceHtml += monitorRenderStatusSection(lastAttempt.respStatus, 'monitor-status');
        if (infoHasValue(lastAttempt.respBody)) traceHtml += monitorRenderDataSection(t('infoResponseBody'), lastAttempt.respBody, 'monitor-response-body');
      }
    }
    if (!traceHtml) traceHtml = monitorRenderTextSection(t('infoTraceDetail'), 'trace-loading-section', 'trace-loading-text', t('infoTraceNA'), false, false);
    loadingEl.outerHTML = traceHtml;
  } catch (ex) {
    if (currentInfoModalRequestId !== e.id) return;
    loadingEl.outerHTML = monitorRenderTextSection(t('infoTraceDetail'), 'trace-loading-section', 'trace-loading-text', t('infoTraceNA'), false, false);
  }
}

function showUsageEntryInfoWithData(e) {
  var overlay = document.getElementById('info-modal-overlay');
  var titleEl = document.getElementById('info-modal-title');
  var bodyEl = document.getElementById('info-modal-body');
  titleEl.textContent = (e.provider || '') + ' / ' + (e.model || '') + ' \u2014 ' + (e.status || 'unknown') + ' (' + formatLatency(e.latencyMs || 0) + ')';
  bodyEl.classList.add('info-modal-monitor');
  __infoModalSections = [];
  __rawFieldMap = {};
  currentInfoModalRequestId = e.id || null;
  currentInfoModalReasoningEl = null;
  currentInfoModalAssistantEl = null;
  currentInfoModalUsageEl = null;
  currentInfoModalStreamingDone = false;
  var html = '';
  var summaryData = {};
  if (infoHasValue(e.id)) summaryData['ID'] = e.id;
  if (infoHasValue(e.timestamp)) summaryData['Timestamp'] = e.timestamp;
  if (infoHasValue(e.provider)) summaryData['Provider'] = e.provider;
  if (infoHasValue(e.model)) summaryData['Model'] = e.model;
  if (infoHasValue(e.keyName)) summaryData['Key'] = e.keyName;
  if (infoHasValue(e.status)) summaryData['Status'] = e.status;
  if (infoHasValue(e.latencyMs)) summaryData['Latency'] = formatLatency(e.latencyMs);
  if (infoHasValue(e.ttftMs)) summaryData['TTFT'] = e.ttftMs + 'ms';
  if (infoHasValue(e.inputTokens)) summaryData['Input Tokens'] = e.inputTokens;
  if (infoHasValue(e.outputTokens)) summaryData['Output Tokens'] = e.outputTokens;
  if (infoHasValue(e.error)) summaryData['Error'] = e.error;
  if (infoHasValue(e.upstreamUrl)) summaryData['Upstream URL'] = e.upstreamUrl;
  if (infoHasValue(e.respStatus)) summaryData['Response Status'] = e.respStatus;
  if (Object.keys(summaryData).length > 0) html += renderInfoSection(t('infoRequestInfo'), summaryData, null, monitorSectionOptions('monitor-request-info', summaryData, true));
  if (infoHasValue(e.reqPayload)) html += monitorRenderDataSection(t('infoRequestBody'), e.reqPayload, 'monitor-request');
  if (infoHasValue(e.reqHeaders)) html += monitorRenderDataSection(t('infoRequestHeaders'), e.reqHeaders, 'monitor-request-headers');
  if (e.status === 'processing' && usageDebugMode) {
    html += monitorRenderTextSection(t('infoReasoning'), 'streaming-reasoning-section', 'streaming-reasoning-text', t('infoThinking'), true, false);
    html += monitorRenderTextSection(t('infoAssistantMsg'), 'streaming-assistant-section', 'streaming-assistant-text', '', true, false);
    html += monitorRenderTextSection(t('infoUsage'), 'streaming-usage-section', 'streaming-usage-text', t('infoWaiting'), true, true);
  } else {
    if (infoHasValue(e.respHeaders)) html += monitorRenderDataSection(t('infoResponseHeaders'), e.respHeaders, 'monitor-response-headers');
    if (infoHasValue(e.respStatus)) html += monitorRenderStatusSection(e.respStatus, 'monitor-status');
    if (infoHasValue(e.respPayload)) html += monitorRenderDataSection(t('infoResponseBody'), e.respPayload, 'monitor-response-body');
    if (infoHasValue(e.__streamingReasoning)) html += monitorRenderTextSection(t('infoReasoning'), 'streaming-reasoning-section', 'streaming-reasoning-text', e.__streamingReasoning, false, false);
    if (infoHasValue(e.__streamingAssistant)) html += monitorRenderTextSection(t('infoAssistantMsg'), 'streaming-assistant-section', 'streaming-assistant-text', e.__streamingAssistant, false, false);
  }
  var noPayload = !infoHasValue(e.reqPayload) && !infoHasValue(e.respPayload) && !infoHasValue(e.reqHeaders) && !infoHasValue(e.respHeaders);
  if (traceEnabled && e.status !== 'processing' && noPayload) html += monitorRenderTextSection(t('infoTraceDetail'), 'trace-loading-section', 'trace-loading-text', t('infoLoadingTrace'), false, false);
  bodyEl.innerHTML = html || '<div class="info-section info-section-monitor"><div class="info-section-title"><span class="info-section-title-text">' + escapeHtml(t('noData')) + '</span></div></div>';
  if (traceEnabled && e.status !== 'processing' && noPayload) loadTraceDetails(e);
  if (e.status === 'processing' && usageDebugMode) {
    currentInfoModalReasoningEl = document.getElementById('streaming-reasoning-text');
    currentInfoModalAssistantEl = document.getElementById('streaming-assistant-text');
    currentInfoModalUsageEl = document.getElementById('streaming-usage-text');
    var inflight = inflightEntries[e.id];
    if (inflight) {
      if (currentInfoModalReasoningEl && infoHasValue(inflight.__streamingReasoning)) currentInfoModalReasoningEl.textContent = inflight.__streamingReasoning;
      if (currentInfoModalAssistantEl && infoHasValue(inflight.__streamingAssistant)) currentInfoModalAssistantEl.textContent = inflight.__streamingAssistant;
      if (currentInfoModalUsageEl && infoHasValue(inflight.__streamingUsage)) {
        currentInfoModalUsageEl.textContent = inflight.__streamingUsage;
        var usageSection = document.getElementById('streaming-usage-section');
        if (usageSection) usageSection.style.display = '';
      }
    }
  }
  overlay.classList.add('show');
  bodyEl.setAttribute('tabindex', '-1');
  bodyEl.focus();
  document.addEventListener('keydown', usageInfoModalEscapeHandler);
}


function copyStreamingTextById(btn, textId) {
  var pre = document.getElementById(textId);
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent || '').then(function() { infoCopyFeedback(btn); });
}

function copyStreamingText(btn) {
  var field = btn.closest('.info-field');
  if (!field) return;
  var pre = field.querySelector('.info-json');
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent || '').then(function() { infoCopyFeedback(btn); });
}

function usageInfoModalEscapeHandler(e) {
  if (e.key === 'Escape') { closeUsageEntryInfo(); }
}

function closeUsageEntryInfo() {
  var overlay = document.getElementById('info-modal-overlay');
  var bodyEl = document.getElementById('info-modal-body');
  overlay.classList.remove('show');
  if (bodyEl) bodyEl.classList.remove('info-modal-monitor');
  document.removeEventListener('keydown', usageInfoModalEscapeHandler);
  currentInfoModalRequestId = null;
  currentInfoModalReasoningEl = null;
  currentInfoModalAssistantEl = null;
  currentInfoModalUsageEl = null;
  currentInfoModalStreamingDone = false;
}

function updateStreamingModalResponse(entry) {
  var bodyEl = document.getElementById('info-modal-body');
  if (!bodyEl || !bodyEl.classList.contains('info-modal-monitor')) return;
  var responseBody = document.getElementById('monitor-response-body');
  var responseHeaders = document.getElementById('monitor-response-headers');
  var status = document.getElementById('monitor-status');
  if (responseBody) responseBody.remove();
  if (responseHeaders) responseHeaders.remove();
  if (status) status.remove();
  if (infoHasValue(entry.respHeaders)) {
    var headersHtml = monitorRenderDataSection(t('infoResponseHeaders'), entry.respHeaders, 'monitor-response-headers');
    var headersTemp = document.createElement('div');
    headersTemp.innerHTML = headersHtml;
    bodyEl.appendChild(headersTemp.firstElementChild);
  }
  if (infoHasValue(entry.respStatus)) {
    var statusHtml = monitorRenderStatusSection(entry.respStatus, 'monitor-status');
    var statusTemp = document.createElement('div');
    statusTemp.innerHTML = statusHtml;
    bodyEl.appendChild(statusTemp.firstElementChild);
  }
  if (infoHasValue(entry.respPayload)) {
    var bodyHtml = monitorRenderDataSection(t('infoResponseBody'), entry.respPayload, 'monitor-response-body');
    var bodyTemp = document.createElement('div');
    bodyTemp.innerHTML = bodyHtml;
    bodyEl.appendChild(bodyTemp.firstElementChild);
  }
}