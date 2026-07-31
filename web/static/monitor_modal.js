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
  if (!traceEnabled && (e.status === 'processing' || (!e.respPayload && !e.respHeaders)) && !inflightEntries[id]) {
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
      if (reqLine && reqLine.reqBody) {
        var rb = (typeof reqLine.reqBody === 'object') ? reqLine.reqBody : { Body: formatBody(reqLine.reqBody) };
        traceHtml += renderInfoSection(t('infoRequestBody'), rb);
      }
      if (reqLine && reqLine.reqHeaders) traceHtml += renderInfoSection(t('infoRequestHeaders'), reqLine.reqHeaders);
      if (lastAttempt) {
        if (lastAttempt.respHeaders) traceHtml += renderInfoSection(t('infoResponseHeaders'), lastAttempt.respHeaders);
        if (lastAttempt.respStatus) traceHtml += '<div class="info-section"><div class="info-section-title">' + escapeHtml(t('infoStatus')) + ': ' + escapeHtml(String(lastAttempt.respStatus)) + '</div></div>';
        if (lastAttempt.respBody) {
          var pb = (typeof lastAttempt.respBody === 'object') ? lastAttempt.respBody : { Body: formatBody(lastAttempt.respBody) };
          traceHtml += renderInfoSection(t('infoResponseBody'), pb);
        }
      }
    }
    if (!traceHtml) traceHtml = '<div class="info-section"><div class="info-section-title">' + escapeHtml(t('infoTraceDetail')) + '</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap;color:var(--text-muted)">' + escapeHtml(t('infoTraceNA')) + '</pre></div></div></div>';
    loadingEl.outerHTML = traceHtml;
  } catch (ex) {
    if (currentInfoModalRequestId !== e.id) return;
    loadingEl.outerHTML = '<div class="info-section"><div class="info-section-title">' + escapeHtml(t('infoTraceDetail')) + '</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap;color:var(--text-muted)">' + escapeHtml(t('infoTraceNA')) + '</pre></div></div></div>';
  }
}

function showUsageEntryInfoWithData(e) {
  var overlay = document.getElementById('info-modal-overlay');
  var titleEl = document.getElementById('info-modal-title');
  var bodyEl = document.getElementById('info-modal-body');
  titleEl.textContent = e.provider + ' / ' + e.model + ' \u2014 ' + (e.status || 'unknown') + ' (' + formatLatency(e.latencyMs || 0) + ')';
  __infoModalSections = [];
  currentInfoModalRequestId = e.id || null;
  currentInfoModalReasoningEl = null;
  currentInfoModalAssistantEl = null;
  currentInfoModalUsageEl = null;
  currentInfoModalStreamingDone = false;
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
    html += renderInfoSection(t('infoRequestInfo'), summaryData);
  }
  if (e.reqPayload) {
    html += renderInfoSection(t('infoRequestBody'), e.reqPayload);
  }
  if (e.reqHeaders) {
    html += renderInfoSection(t('infoRequestHeaders'), e.reqHeaders);
  }
  if (e.status === 'processing' && usageDebugMode) {
    html += '<div class="info-section" id="streaming-reasoning-section">' +
      '<div class="info-section-title">' + escapeHtml(t('infoReasoning')) + '</div>' +
      '<div class="info-field">' +
        '<span class="info-field-key">' +
          '<span class="info-field-key-name">' + escapeHtml(t('infoContent')) + '</span>' +
          '<span class="info-field-actions">' +
            '<button type="button" class="info-copy-btn" onclick="copyStreamingText(this)">' + escapeHtml(t('infoCopy')) + '</button>' +
          '</span>' +
        '</span>' +
        '<div class="info-field-value">' +
          '<pre class="info-json" id="streaming-reasoning-text" style="white-space:pre-wrap;min-height:20px;color:var(--text-muted)">' + escapeHtml(t('infoThinking')) + '</pre>' +
        '</div>' +
      '</div>' +
    '</div>';
    html += '<div class="info-section" id="streaming-assistant-section">' +
      '<div class="info-section-title">' + escapeHtml(t('infoAssistantMsg')) + '</div>' +
      '<div class="info-field">' +
        '<span class="info-field-key">' +
          '<span class="info-field-key-name">' + escapeHtml(t('infoContent')) + '</span>' +
          '<span class="info-field-actions">' +
            '<button type="button" class="info-copy-btn" onclick="copyStreamingText(this)">' + escapeHtml(t('infoCopy')) + '</button>' +
          '</span>' +
        '</span>' +
        '<div class="info-field-value">' +
          '<pre class="info-json" id="streaming-assistant-text" style="white-space:pre-wrap;min-height:20px"> </pre>' +
        '</div>' +
      '</div>' +
    '</div>';
    html += '<div class="info-section" id="streaming-usage-section" style="display:none">' +
      '<div class="info-section-title">' + escapeHtml(t('infoUsage')) + '</div>' +
      '<div class="info-field">' +
        '<span class="info-field-key">' +
          '<span class="info-field-key-name">' + escapeHtml(t('infoTokenStats')) + '</span>' +
          '<span class="info-field-actions">' +
            '<button type="button" class="info-copy-btn" onclick="copyStreamingText(this)">' + escapeHtml(t('infoCopy')) + '</button>' +
          '</span>' +
        '</span>' +
        '<div class="info-field-value">' +
          '<pre class="info-json" id="streaming-usage-text" style="white-space:pre-wrap;min-height:20px;color:var(--text-muted)">' + escapeHtml(t('infoWaiting')) + '</pre>' +
        '</div>' +
      '</div>' +
    '</div>';
  } else {
    if (e.respHeaders) {
      html += renderInfoSection(t('infoResponseHeaders'), e.respHeaders);
    }
    if (e.respStatus) {
      html += '<div class="info-section"><div class="info-section-title">' + escapeHtml(t('infoStatus')) + ': ' + escapeHtml(e.respStatus) + '</div></div>';
    }
    if (e.respPayload) {
      html += renderInfoSection(t('infoResponseBody'), e.respPayload);
    }
    if (e.__streamingReasoning) {
      html += '<div class="info-section"><div class="info-section-title">' + escapeHtml(t('infoReasoning')) + '</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap">' + escapeHtml(e.__streamingReasoning) + '</pre></div></div></div>';
    }
    if (e.__streamingAssistant) {
      html += '<div class="info-section"><div class="info-section-title">' + escapeHtml(t('infoAssistantMsg')) + '</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap">' + escapeHtml(e.__streamingAssistant) + '</pre></div></div></div>';
    }
  }
  if (traceEnabled && e.status !== 'processing' && !e.reqPayload && !e.respPayload && !e.reqHeaders && !e.respHeaders) {
    html += '<div class="info-section" id="trace-loading-section"><div class="info-section-title">' + escapeHtml(t('infoTraceDetail')) + '</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap;color:var(--text-muted)">' + escapeHtml(t('infoLoadingTrace')) + '</pre></div></div></div>';
  }
  bodyEl.innerHTML = html || '<div class="info-section">' + t('noData') + '</div>';
  postProcessRawFields();
  if (traceEnabled && e.status !== 'processing' && !e.reqPayload && !e.respPayload && !e.reqHeaders && !e.respHeaders) {
    loadTraceDetails(e);
  }
  if (e.status === 'processing' && usageDebugMode) {
    currentInfoModalReasoningEl = document.getElementById('streaming-reasoning-text');
    currentInfoModalAssistantEl = document.getElementById('streaming-assistant-text');
    currentInfoModalUsageEl = document.getElementById('streaming-usage-text');
    var inflight = inflightEntries[e.id];
    if (inflight) {
      if (currentInfoModalReasoningEl && inflight.__streamingReasoning) {
        currentInfoModalReasoningEl.textContent = inflight.__streamingReasoning;
      }
      if (currentInfoModalAssistantEl && inflight.__streamingAssistant) {
        currentInfoModalAssistantEl.textContent = inflight.__streamingAssistant;
      }
      if (currentInfoModalUsageEl && inflight.__streamingUsage) {
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

function copyStreamingText(btn) {
  var field = btn.closest('.info-field');
  if (!field) return;
  var pre = field.querySelector('.info-json');
  if (!pre) return;
  var text = pre.textContent || '';
  navigator.clipboard.writeText(text).then(function() {
    var orig = btn.textContent;
      btn.textContent = t('infoCopied');
    setTimeout(function() { btn.textContent = orig; }, 1500);
  });
}

function usageInfoModalEscapeHandler(e) {
  if (e.key === 'Escape') { closeUsageEntryInfo(); }
}

function closeUsageEntryInfo() {
  var overlay = document.getElementById('info-modal-overlay');
  overlay.classList.remove('show');
  document.removeEventListener('keydown', usageInfoModalEscapeHandler);
  currentInfoModalRequestId = null;
  currentInfoModalReasoningEl = null;
  currentInfoModalAssistantEl = null;
  currentInfoModalUsageEl = null;
  currentInfoModalStreamingDone = false;
}

function updateStreamingModalResponse(entry) {
  var bodyEl = document.getElementById('info-modal-body');
  if (!bodyEl) return;
  var existingRespSection = bodyEl.querySelector('#streaming-response-body-section');
  if (existingRespSection) existingRespSection.remove();
  if (entry.respPayload) {
    var html = renderInfoSection(t('infoResponseBody'), entry.respPayload);
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var sectionEl = temp.firstElementChild;
    sectionEl.id = 'streaming-response-body-section';
    bodyEl.appendChild(sectionEl);
  }
  if (entry.respHeaders) {
    var html = renderInfoSection(t('infoResponseHeaders'), entry.respHeaders);
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var sectionEl = temp.firstElementChild;
    bodyEl.appendChild(sectionEl);
  }
  if (entry.respStatus) {
    var html = '<div class="info-section"><div class="info-section-title">' + escapeHtml(t('infoStatus')) + ': ' + escapeHtml(entry.respStatus) + '</div></div>';
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var sectionEl = temp.firstElementChild;
    bodyEl.appendChild(sectionEl);
  }
  postProcessRawFields();
}