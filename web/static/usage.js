// ===================== Usage Page =====================

var lastUsageSig = '';
var lastUsageEntries = [];

var modelColorMap = {};
var expandedModels = new Set();
var lockCountdownTimerStarted = false;
var lockCountdownInterval = null;
var quotaBarItems = {};
var lastQuotaSig = '';
var usageDebugMode = false;
var traceEnabled = false;
var usageVisibilityHandler = null;
var usagePeriodicTimer = null;
var _lastPerKeyRefresh = 0;
var inflightEntries = {};
var processingTimer = null;
var usageFilters = { success: true, failure: true, processing: true };
var recentPageSize = 30;
var recentPage = 1;
var recentFilteredCount = 0;
var recentGroupBySession = false;
var expandedSessions = {}; // sessionKey -> true when expanded; survives re-renders so periodic refresh won't re-collapse
var currentInfoModalRequestId = null;
var currentInfoModalReasoningEl = null;
var currentInfoModalAssistantEl = null;
var currentInfoModalUsageEl = null;

function formatBody(body) {
  if (body == null) return '';
  if (typeof body === 'object') {
    try { return JSON.stringify(body, null, 2); } catch (e) { return String(body); }
  }
  var s = String(body);
  if (s.indexOf('data:') === 0 || s.indexOf('\ndata:') >= 0) {
    return s.split(/\r?\n/).map(function(line) {
      if (line.indexOf('data: ') === 0) {
        var payload = line.slice(6);
        if (payload === '[DONE]') return 'data: [DONE]';
        try { return 'data: ' + JSON.stringify(JSON.parse(payload), null, 2); }
        catch (e) { return line; }
      }
      return line;
    }).join('\n');
  }
  return s;
}
var currentInfoModalStreamingDone = false;
var modelIdToAlias = {};

// buildModelIdToAlias builds a reverse lookup map from model ID to alias
// across all providers in providersCache.
function buildModelIdToAlias() {
  modelIdToAlias = {};
  for (var i = 0; i < (providersCache || []).length; i++) {
    var p = providersCache[i];
    for (var j = 0; j < (p.models || []).length; j++) {
      var m = p.models[j];
      if (m.alias) {
        modelIdToAlias[m.id] = m.alias;
      }
    }
  }
}

// displayModelName returns the best display name for a model: prefer alias
// from the resolved model ID, falling back to originalModel (what the client
// sent), then the raw model ID.
function displayModelName(model, originalModel) {
  var alias = modelIdToAlias[model];
  if (alias) return alias;
  if (originalModel && originalModel !== model) return originalModel;
  return model;
}

function sortEntriesByTimeDesc(entries) {
  entries.sort(function(a, b) {
    var ta = new Date(a.timestamp).getTime();
    var tb = new Date(b.timestamp).getTime();
    return tb - ta;
  });
  return entries;
}

function formatLatency(ms) {
  return (ms / 1000).toFixed(1) + 's';
}

function hasProcessingEntries() {
  return lastUsageEntries.some(function(e) { return e.status === 'processing'; });
}

var MAX_PROCESSING_MS = 10 * 60 * 1000; // 10 分钟，超时停止计时
var MAX_PRESERVED_TERMINAL = 200; // 保留被 ring 驱逐的终态条目上限，避免无界增长

function updateProcessingLatencyCells() {
  var rows = document.querySelectorAll('tr[data-status="processing"]');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute('data-ttft')) continue;
    var ts = rows[i].getAttribute('data-ts');
    if (!ts) continue;
    var elapsed = Date.now() - new Date(ts).getTime();
    if (isNaN(elapsed) || elapsed < 0) elapsed = 0;
    var cell = rows[i].querySelector('.latency-cell');
    if (!cell) continue;
    if (elapsed > MAX_PROCESSING_MS) {
      cell.textContent = '>10m';
    } else {
      cell.textContent = formatLatency(elapsed);
    }
  }
}

function ensureProcessingTimer() {
  if (processingTimer) return;
  processingTimer = setInterval(function() {
    if (currentPage === 'usage' && hasProcessingEntries()) {
      updateProcessingLatencyCells();
    } else {
      clearInterval(processingTimer);
      processingTimer = null;
    }
  }, 200);
}

function stopProcessingTimer() {
  if (processingTimer) {
    clearInterval(processingTimer);
    processingTimer = null;
  }
}

function toggleUsageFilter(btn, filter) {
  usageFilters[filter] = !usageFilters[filter];
  btn.classList.toggle('active', usageFilters[filter]);
  updateRecentRequestsInline(lastUsageEntries);
}

function statusToFilter(status) {
  if (status === 'success') return 'success';
  if (status === 'processing') return 'processing';
  return 'failure';
}

function shouldShowUsageEntry(e) {
  return usageFilters[statusToFilter(e.status)];
}

var TREND_PALETTE = ['#4fc3f7', '#10a37f', '#d97706', '#4285f4', '#a855f7', '#ff6a00', '#ec4899', '#14b8a6', '#f59e0b', '#84cc16', '#7c3aed', '#06b6d4', '#f97316', '#ef4444'];
function getModelColor(provider, model) {
  var key = provider + '/' + model;
  if (modelColorMap[key]) return modelColorMap[key];
  var hash = 0;
  for (var i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  var color = TREND_PALETTE[Math.abs(hash) % TREND_PALETTE.length];
  modelColorMap[key] = color;
  return color;
}

function sanitizeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '-');
}
function renderUsageRow(e, sessionKey, hidden) {
  var statusDot;
  var dotClass = 'status-dot';
  if (e.status === 'success') dotClass += ' status-dot-success';
  else if (e.status === 'error') dotClass += ' status-dot-error';
  else if (e.status === 'retry') dotClass += ' status-dot-retry';
  else dotClass += ' status-dot-processing';
  var dotHtml = '<span class="' + dotClass + '"></span>';
  var statusInner;
  if (e.reqPayload || e.respPayload || e.respHeaders || e.reqHeaders || e.upstreamUrl || e.respStatus || e.status === 'processing' || traceEnabled) {
    statusInner = '<button type="button" class="btn btn-sm btn-info" onclick="showUsageEntryInfoById(\'' + (e.id || '') + '\')">' + dotHtml + '</button>';
  } else {
    statusInner = dotHtml;
  }
  var latencyDisplay;
  if (e.status === 'processing') {
    if (e.ttftMs && e.ttftMs > 0) {
      latencyDisplay = formatLatency(e.ttftMs);
    } else {
      var elapsed = Date.now() - new Date(e.timestamp).getTime();
      if (isNaN(elapsed) || elapsed < 0) elapsed = 0;
      latencyDisplay = formatLatency(elapsed);
    }
  } else {
    latencyDisplay = formatLatency(e.latencyMs);
  }
  var tokensDisplay;
  if (e.status === 'processing') {
    var inT = (e.inputTokens || 0);
    var outT = (e.outputTokens || 0);
    tokensDisplay = inT + '/' + outT;
  } else {
    tokensDisplay = e.inputTokens + '/' + e.outputTokens;
  }
  var tsAttr = e.timestamp ? ' data-ts="' + escapeHtml(e.timestamp) + '"' : '';
  var ttftAttr = (e.status === 'processing' && e.ttftMs && e.ttftMs > 0) ? ' data-ttft="1"' : '';
  var idAttr = e.id ? ' data-id="' + sanitizeId(e.id) + '"' : '';
  var inSession = sessionKey !== undefined;
  var sessionAttr = inSession ? ' data-session="' + escapeHtml(sessionKey) + '" class="session-row"' : '';
  var firstCellStyle = inSession ? ' style="padding-left:18px"' : '';
  var hiddenAttr = (inSession && hidden) ? ' style="display:none"' : '';
  return '<tr data-status="' + e.status + '"' + tsAttr + ttftAttr + idAttr + sessionAttr + hiddenAttr + '>\
    <td class="status-col-cell"' + firstCellStyle + '>' + statusInner + '</td>\
    <td>' + new Date(e.timestamp).toLocaleTimeString() + '</td>\
    <td>' + escapeHtml(e.provider) + '</td>\
    <td>' + escapeHtml(displayModelName(e.model, e.originalModel)) + '</td>\
    <td>' + escapeHtml(e.keyName) + '</td>\
    <td class="latency-cell">' + latencyDisplay + '</td>\
    <td class="tokens-cell">' + tokensDisplay + '</td>\
  </tr>';
}


async function renderUsage(c) {
  try {
  var cachedEntries = lastUsageEntries.slice();
  var quotaCardHtml = '<div class="card"><div class="card-title" style="display:flex;justify-content:space-between;align-items:center"><span>' + t('quotaMonitor') + '</span><button type="button" class="btn btn-sm btn-ghost" onclick="resetQuotaTimers()">' + t('resetQuota') + '</button></div><div class="quota-section quota-section-scroll"></div></div>';
  c.innerHTML = '\
    <div class="usage-header usage-fullscreen">\
      <div class="usage-body-grid">\
        <div class="usage-left-col">\
          <div class="quota-monitor-card">' + quotaCardHtml + '\
          </div>\
          <div class="recent-requests-section">' + renderRecentRequestsInline(cachedEntries) + '</div>\
        </div>\
        <div class="usage-right-col" id="usage-console-col"></div>\
      </div>\
    </div>';
  c.classList.remove('usage-page');
  var mainEl = document.querySelector('.main');
  if (mainEl) mainEl.classList.add('main-no-scroll');
  var results = await Promise.allSettled([
    apiGet('/usage/summary'),
    apiGet('/usage?limit=500'),
    apiGet('/usage/quotas'),
    apiGet('/settings'),
    apiGet('/providers')
  ]);
  if (currentPage !== 'usage') return;
  var summary = results[0].status === 'fulfilled' ? results[0].value : {};
  var usage = results[1].status === 'fulfilled' ? results[1].value : {};
  var quotas = results[2].status === 'fulfilled' ? results[2].value : {};
  var settings = results[3].status === 'fulfilled' ? results[3].value : {};
  if (results[4].status === 'fulfilled' && results[4].value && results[4].value.providers) {
    providersCache = results[4].value.providers;
    buildModelIdToAlias();
  }
  var rejected = results.slice(0, 4).some(function(r) { return r.status === 'rejected'; });
  if (rejected) toast(t('loadFailed') || 'Load failed', 'error');
  usageDebugMode = !!(settings && settings.debugMode);
  traceEnabled = !!(settings && settings.trace && settings.trace.enabled);
  var usageEntries = usage.entries || [];
  var apiIds = {};
  usageEntries.forEach(function(e) {
    if (e.id) apiIds[e.id] = true;
  });

  // Deduplicate by ID: ring entries come first in the API response and carry
  // terminal status (success/error). Subsequent inflight (processing) entries
  // with the same ID are skipped so the completed entry always wins.
  var seenIds = {};
  var merged = [];
  usageEntries.forEach(function(e) {
    if (e.id && seenIds[e.id]) return;
    var existing = lastUsageEntries.find(function(x) { return x.id === e.id; });
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

  // Clean up inflightEntries for IDs that now have a terminal-status entry in
  // the merged result, so stale inflight entries don't persist and get re-added
  // on future polls after the ring entry is evicted.
  for (var i = 0; i < merged.length; i++) {
    var me = merged[i];
    if (me.id && me.status !== 'processing' && inflightEntries[me.id]) {
      delete inflightEntries[me.id];
    }
  }

  sortEntriesByTimeDesc(merged);
  // Preserve terminal entries from lastUsageEntries that are NOT in the API
  // response (ring-evicted), mirroring refreshQuotaData, so switching pages
  // does not drop completed entries. Bounded by MAX_PRESERVED_TERMINAL.
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
  var quotaBars = quotas.quotas || [];
  quotaBarItems = {};
  lastQuotaSig = '';
  var section = document.querySelector('.quota-monitor-card > .card > .quota-section');
  if (section) {
    if (quotaBars.length === 0) {
      section.innerHTML = emptyState(t('noQuota'));
    } else {
      buildQuotaBarItems(quotaBars, section);
    }
  }
  updateUsageSummary(summary);
  updateRecentRequestsInline(lastUsageEntries);
  var consoleCol = document.getElementById('usage-console-col');
  if (consoleCol && typeof buildConsoleInto === 'function') {
    buildConsoleInto(consoleCol);
  }
  startUsageRefresh();
  ensureProcessingTimer();
  } catch(e) {
    c.innerHTML = emptyState(t('loadFailed') || 'Load failed');
    console.warn('renderUsage failed:', e);
  }
}

function recentMaxPage() {
  return Math.max(1, Math.ceil(recentFilteredCount / recentPageSize));
}

function recentPrevPage() {
  if (recentPage <= 1) return;
  recentPage--;
  updateRecentRequestsInline(lastUsageEntries);
}

function recentNextPage() {
  if (recentPage >= recentMaxPage()) return;
  recentPage++;
  updateRecentRequestsInline(lastUsageEntries);
}

function recentSetPageSize(sel) {
  recentPageSize = Number(sel.value) || 30;
  recentPage = 1;
  updateRecentRequestsInline(lastUsageEntries);
}

function recentPageSizeOptions() {
  var opts = [20, 30, 40, 50];
  return opts.map(function(n) {
    var s = (n === recentPageSize) ? ' selected' : '';
    return '<option value="' + n + '"' + s + '>' + n + '</option>';
  }).join('');
}

function updateRecentPagerState() {
  var maxPage = recentMaxPage();
  var ind = document.getElementById('recent-page-indicator');
  if (ind) ind.textContent = recentPage + ' / ' + maxPage;
  var sel = document.getElementById('recent-page-size');
  if (sel && String(sel.value) !== String(recentPageSize)) sel.value = String(recentPageSize);
  var prev = document.getElementById('recent-prev-page');
  if (prev) {
    var atFirst = recentPage <= 1;
    prev.disabled = atFirst;
    prev.style.opacity = atFirst ? '0.4' : '';
    prev.style.cursor = atFirst ? 'not-allowed' : '';
  }
  var next = document.getElementById('recent-next-page');
  if (next) {
    var atLast = recentPage >= maxPage;
    next.disabled = atLast;
    next.style.opacity = atLast ? '0.4' : '';
    next.style.cursor = atLast ? 'not-allowed' : '';
  }
}

function renderRecentRequestsInline(entries) {
  var filtered = entries.filter(shouldShowUsageEntry);
  recentFilteredCount = filtered.length;
  var maxPage = recentMaxPage();
  if (recentPage > maxPage) recentPage = maxPage;
  if (recentPage < 1) recentPage = 1;
  var start = (recentPage - 1) * recentPageSize;
  var end = start + recentPageSize;
  var rows = filtered.slice(start, end);
  var pagerHtml =
    '<span class="recent-pager" style="display:inline-flex;align-items:center;gap:4px;margin-left:6px">' +
      '<select id="recent-page-size" onchange="recentSetPageSize(this)" style="width:auto;padding:3px 8px;font-size:var(--font-badge);border-radius:var(--radius-sm);border:1px solid var(--glass-border);background:var(--input-bg);color:var(--text)">' + recentPageSizeOptions() + '</select>' +
      '<button type="button" class="btn btn-sm btn-filter" id="recent-prev-page" onclick="recentPrevPage()">\u2190</button>' +
      '<span id="recent-page-indicator" style="font-size:var(--font-badge);color:var(--text-muted);min-width:52px;text-align:center">' + recentPage + ' / ' + maxPage + '</span>' +
      '<button type="button" class="btn btn-sm btn-filter" id="recent-next-page" onclick="recentNextPage()">\u2192</button>' +
    '</span>';
  var header = '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">' +
    '<span>' + t('recentRequests') + '<span class="recent-count">' + filtered.length + '</span></span>' +
    '<span class="console-controls" style="gap:4px">' +
      '<button type="button" class="btn btn-sm btn-filter' + (usageFilters.success ? ' active' : '') + '" data-filter="success" onclick="toggleUsageFilter(this,\'success\')">' + t('filterSuccess') + '</button>' +
      '<button type="button" class="btn btn-sm btn-filter' + (usageFilters.failure ? ' active' : '') + '" data-filter="failure" onclick="toggleUsageFilter(this,\'failure\')">' + t('filterFailure') + '</button>' +
      '<button type="button" class="btn btn-sm btn-filter' + (usageFilters.processing ? ' active' : '') + '" data-filter="processing" onclick="toggleUsageFilter(this,\'processing\')">' + t('filterProcessing') + '</button>' +
      '<button type="button" class="btn btn-sm btn-filter' + (recentGroupBySession ? ' active' : '') + '" id="recent-group-toggle" onclick="toggleRecentGroupBySession()">' + t('groupBySession') + '</button>' +
      pagerHtml +
    '</span>' +
  '</div>';
  var body;
  if (rows.length === 0) {
    body = emptyState(t('noUsage'));
  } else {
    body = '<div class="recent-requests-scroll card-scroll">' +
      '<table class="usage-table">' +
        '<thead><tr>' +
          '<th class="status-col-header"></th>' +
          '<th>' + t('thTime') + '</th>' +
          '<th>' + t('thProvider') + '</th>' +
          '<th>' + t('thModel') + '</th>' +
          '<th>' + t('thKey') + '</th>' +
          '<th>' + t('thLatency') + '</th>' +
          '<th>' + t('thTokens') + '</th>' +
        '</tr></thead>' +
        '<tbody id="recent-tbody">' + renderRecentRows(rows) + '</tbody>' +
      '</table>' +
    '</div>';
  }
  return '<div class="card recent-requests-card">' + header + body + '</div>';
}

function updateRecentRequestsInline(entries) {
  var tbody = document.getElementById('recent-tbody');
  var filtered = entries.filter(shouldShowUsageEntry);
  recentFilteredCount = filtered.length;
  var maxPage = recentMaxPage();
  if (recentPage > maxPage) recentPage = maxPage;
  if (recentPage < 1) recentPage = 1;
  var start = (recentPage - 1) * recentPageSize;
  var end = start + recentPageSize;
  var rows = filtered.slice(start, end);
  if (!tbody) {
    if (entries.length > 0) {
      var card = document.querySelector('.recent-requests-card');
      if (card && card.parentNode) {
        var temp = document.createElement('div');
        temp.innerHTML = renderRecentRequestsInline(entries);
        var newCard = temp.firstElementChild;
        if (newCard) card.parentNode.replaceChild(newCard, card);
        document.querySelectorAll('.recent-requests-card .btn-filter').forEach(function(b) {
          var f = b.dataset.filter;
          if (f) b.classList.toggle('active', usageFilters[f]);
        });
        updateRecentPagerState();
      }
    }
    return;
  }
  tbody.innerHTML = renderRecentRows(rows);
  var countEl = document.querySelector('.recent-requests-card .recent-count');
  if (countEl) countEl.textContent = String(filtered.length);
  updateRecentPagerState();
}

// renderRecentRows renders the current page's rows either flat (default) or
// grouped by inferred sessionKey. Grouping is a DISPLAY transform on the
// already-paginated page slice: paging still operates on the flat filtered
// list (one page = recentPageSize rows), and within that page rows are
// clustered under collapsible session headers. A session with more rows than
// fit on one page therefore appears on multiple pages — acceptable for v1 and
// the simplest way to keep paging semantics identical in both modes.
function renderRecentRows(rows) {
  if (!recentGroupBySession) return rows.map(function(e) { return renderUsageRow(e, undefined, false); }).join('');
  return renderRecentRowsGrouped(rows);
}

// renderRecentRowsGrouped buckets the page's rows by sessionKey in
// first-appearance order. Empty sessionKey (single-shot / ungrouped) collects
// into a pseudo-group shown first.
function renderRecentRowsGrouped(rows) {
  var order = [];
  var groups = {};
  var ungrouped = [];
  for (var i = 0; i < rows.length; i++) {
    var e = rows[i];
    var sk = e.sessionKey || '';
    if (!sk) { ungrouped.push(e); continue; }
    if (!groups[sk]) { groups[sk] = []; order.push(sk); }
    groups[sk].push(e);
  }
  var html = '';
  if (ungrouped.length) {
    html += '<tr class="session-group-header ungrouped" data-session-group=""><td colspan="7" style="font-size:var(--font-badge);color:var(--text-muted)">' +
      escapeHtml(t('ungrouped')) + ' \u00B7 ' + ungrouped.length + ' ' + t('requests') +
    '</td></tr>';
    html += ungrouped.map(function(e) { return renderUsageRow(e, ''); }).join('');
  }
  for (var gi = 0; gi < order.length; gi++) {
    var sk = order[gi];
    var g = groups[sk];
    var expanded = !!expandedSessions[sk];
    html += renderSessionGroupHeader(sk, 'sess:' + sk, g, expanded);
    html += g.map(function(e) { return renderUsageRow(e, sk, !expanded); }).join('');
  }
  return html;
}

// renderSessionGroupHeader emits a clickable header row spanning all columns:
// "label · N requests · first→last time · provider/model". Clicking toggles
// the visibility of that session's rows.
function renderSessionGroupHeader(sk, label, group, expanded) {
  var first = group[0], last = group[group.length - 1];
  var span = new Date(first.timestamp).toLocaleTimeString() + ' \u2192 ' + new Date(last.timestamp).toLocaleTimeString();
  var prov = escapeHtml(first.provider || '');
  var model = escapeHtml(displayModelName(first.model, first.originalModel));
  var cls = expanded ? 'session-group-header expanded' : 'session-group-header collapsed';
  var arrow = expanded ? '\u25BE' : '\u25B8';
  return '<tr class="' + cls + '" data-session-group="' + escapeHtml(sk) + '" onclick="toggleSessionGroup(this, \'' + escapeHtml(sk) + '\')">' +
    '<td colspan="7" class="session-group-cell">' +
      '<div class="session-group-flex">' +
        '<span class="session-group-arrow">' + arrow + '</span>' +
        '<span class="session-group-name">' + escapeHtml(label) + '</span>' +
        '<span class="session-group-count">' + group.length + ' ' + t('requests') + '</span>' +
        '<span class="session-group-time">' + escapeHtml(span) + '</span>' +
        '<span class="session-group-model">' + prov + ' / ' + model + '</span>' +
      '</div>' +
    '</td>' +
  '</tr>';
}

// toggleRecentGroupBySession flips grouping on/off and rebuilds the whole
// Recent Requests card so the toggle button's active state and the grouped
// body refresh together (the in-place tbody update path does not re-render
// the header). Resetting to page 1 avoids an out-of-range page.
function toggleRecentGroupBySession() {
  recentGroupBySession = !recentGroupBySession;
  if (!recentGroupBySession) expandedSessions = {};
  recentPage = 1;
  var card = document.querySelector('.recent-requests-card');
  if (card && card.parentNode) {
    var temp = document.createElement('div');
    temp.innerHTML = renderRecentRequestsInline(lastUsageEntries);
    var newCard = temp.firstElementChild;
    if (newCard) card.parentNode.replaceChild(newCard, card);
    document.querySelectorAll('.recent-requests-card .btn-filter').forEach(function(b) {
      var f = b.dataset.filter;
      if (f) b.classList.toggle('active', usageFilters[f]);
    });
    updateRecentPagerState();
  } else {
    updateRecentRequestsInline(lastUsageEntries);
  }
}

// toggleSessionGroup collapses/expands one session's rows by toggling their
// display directly in the DOM (no re-render). The header's arrow flips to
// reflect state.
function toggleSessionGroup(headerEl, sk) {
  var nowExpanded = !expandedSessions[sk];
  if (nowExpanded) { expandedSessions[sk] = true; } else { delete expandedSessions[sk]; }
  headerEl.classList.toggle('collapsed', !nowExpanded);
  headerEl.classList.toggle('expanded', nowExpanded);
  var tbody = document.getElementById('recent-tbody');
  if (!tbody) return;
  var rows = tbody.querySelectorAll('tr.session-row[data-session="' + sk + '"]');
  for (var i = 0; i < rows.length; i++) rows[i].style.display = nowExpanded ? '' : 'none';
  var arrow = headerEl.querySelector('.session-group-arrow');
  if (arrow) arrow.textContent = nowExpanded ? '\u25BE' : '\u25B8';
}

function formatCompactTokens(n) {
  var v = Number(n || 0);
  if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return String(v);
}

// --- Quota refresh with debounce ---
var _quotaRefreshTimer = null;

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
      apiGet('/usage/summary'),
      apiGet('/usage?limit=500'),
      apiGet('/usage/quotas')
    ]);
    var newEntries = usage.entries || [];
    var apiIds = {};
    newEntries.forEach(function(e) {
      if (e.id) apiIds[e.id] = true;
    });
    // Deduplicate by ID: ring entries come first in the API response and carry
    // terminal status (success/error). Subsequent inflight (processing) entries
    // with the same ID are skipped so the completed entry always wins.
    var seenIds = {};
    var merged = [];
    newEntries.forEach(function(e) {
      if (e.id && seenIds[e.id]) return;
      var existing = lastUsageEntries.find(function(x) { return x.id === e.id; });
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
          // 超过 10 分钟的 processing 条目，不再保留在 inflight，等待后端 SweepStale 产生的 error 记录
          delete inflightEntries[id];
        } else {
          merged.unshift(inflightEntries[id]);
        }
      }
    });
    // Clean up inflightEntries for IDs that now have a terminal-status entry in
    // the merged result, so stale inflight entries don't persist and get re-added
    // on future polls after the ring entry is evicted.
    for (var i = 0; i < merged.length; i++) {
      var me = merged[i];
      if (me.id && me.status !== 'processing' && inflightEntries[me.id]) {
        delete inflightEntries[me.id];
      }
    }
    sortEntriesByTimeDesc(merged);
    // Preserve entries from lastUsageEntries that have terminal status and are
    // NOT in the API response (their IDs are not in seenIds). This prevents
    // entries from vanishing when the ring evicts them between polls, or when
    // the SSE request-done fires in between refreshQuotaData calls. Without
    // this, a completed entry that was handled by handleRequestDone (which
    // deletes inflightEntries[id]) is gone from both merged and inflightEntries
    // if the ring entry was evicted or the limit=500 cutoff excluded it.
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
    updateUsageSummary(summary);
    updateQuotaBars(quotas.quotas || []);
    updateRecentRequestsModal();
    updateRecentRequestsInline(lastUsageEntries);
    ensureProcessingTimer();
    maybeRefreshPerKeyDetails();
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

function updateStreamingModalResponse(entry) {
  var bodyEl = document.getElementById('info-modal-body');
  if (!bodyEl) return;
  var existingRespSection = bodyEl.querySelector('#streaming-response-body-section');
  if (existingRespSection) existingRespSection.remove();
  if (entry.respPayload) {
    var html = renderInfoSection('Response Body', entry.respPayload);
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var sectionEl = temp.firstElementChild;
    sectionEl.id = 'streaming-response-body-section';
    bodyEl.appendChild(sectionEl);
  }
  if (entry.respHeaders) {
    var html = renderInfoSection('Response Headers', entry.respHeaders);
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var sectionEl = temp.firstElementChild;
    bodyEl.appendChild(sectionEl);
  }
  if (entry.respStatus) {
    var html = '<div class="info-section"><div class="info-section-title">Status: ' + escapeHtml(entry.respStatus) + '</div></div>';
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var sectionEl = temp.firstElementChild;
    bodyEl.appendChild(sectionEl);
  }
  postProcessRawFields();
}

function startUsageRefresh() {
  stopUsageRefresh();
  usageEventSource = new EventSource('/api/usage/events');
  applyUsageSSEHandlers(usageEventSource);

  usageVisibilityHandler = function() {
    if (document.visibilityState === 'visible' && currentPage === 'usage') {
      if (!usageEventSource || usageEventSource.readyState === EventSource.CLOSED) {
        if (usageEventSource) usageEventSource.close();
        usageEventSource = new EventSource('/api/usage/events');
        applyUsageSSEHandlers(usageEventSource);
      }
      refreshQuotaData();
    }
  };
  document.addEventListener('visibilitychange', usageVisibilityHandler);

  usagePeriodicTimer = setInterval(function() {
    if (currentPage === 'usage') {
      refreshQuotaData();
    }
  }, 5000);
}

function stopUsageRefresh() {
  if (usageVisibilityHandler) {
    document.removeEventListener('visibilitychange', usageVisibilityHandler);
    usageVisibilityHandler = null;
  }
  if (usageEventSource) {
    usageEventSource.close();
    usageEventSource = null;
  }
  if (usagePeriodicTimer) {
    clearInterval(usagePeriodicTimer);
    usagePeriodicTimer = null;
  }
  if (lockCountdownInterval) {
    clearInterval(lockCountdownInterval);
    lockCountdownInterval = null;
  }
  lockCountdownTimerStarted = false;
  stopProcessingTimer();
}

function computeQuotaSig(bars) {
  if (!bars) return '';
  try { return JSON.stringify(bars.map(function(b) { return b.provider + '|' + b.model + '|' + b.totalUsed + '|' + b.totalCapacity + '|' + (b.inFlightKeyNames ? b.inFlightKeyNames.join(',') : '') + '|' + (b.currentKeyName||'') + '|' + (b.currentKeyId||'') + '|' + b.successCount + '|' + b.errorCount + '|' + b.inputTokens + '|' + b.outputTokens + '|' + (b.hasQuota ? 1 : 0) + '|' + (b.perKeyLimit||''); })); } catch(e) { return ''; }
}

function setBarWidth(fillEl, pctStr) {
  fillEl.style.transition = 'none';
  fillEl.style.width = pctStr;
  void fillEl.offsetWidth;
  fillEl.style.transition = '';
}

function updateUsageSummary(summary) {
  var grid = document.querySelector('.stat-grid');
  if (!grid) return;
  var cards = grid.querySelectorAll('.stat-value');
  if (cards.length >= 6) {
    cards[0].textContent = summary.total;
    cards[1].textContent = summary.success;
    cards[2].textContent = summary.error;
    cards[3].textContent = formatLatency(summary.avgLatencyMs);
    cards[4].textContent = formatMillionTokens(summary.totalInputTokens);
    cards[5].textContent = formatMillionTokens(summary.totalOutputTokens);
  }
}

async function clearUsage() {
  await apiDelete('/usage');
  toast(t('usageCleared'), 'info');
  renderUsage(document.getElementById('page-content'));
}

var QUOTA_CHEVRON = '<svg class="quota-bar-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

function renderQuotaBarItem(bar) {
  var color = getModelColor(bar.provider, bar.model);
  var barDotClass = 'model-color-dot';
  if (bar.inFlightKeyNames && bar.inFlightKeyNames.length > 0) {
    barDotClass += ' model-color-dot-calling';
  }
  var itemId = 'qbi-' + sanitizeId(bar.provider) + '-' + sanitizeId(bar.model);
  var toggleCall = "toggleModelDetail('" + escapeHtml(bar.provider).replace(/'/g, "\\'") + "','" + escapeHtml(bar.model).replace(/'/g, "\\'") + "')";
  var currentKeyHtml = '';
  if (bar.currentKeyName) {
    currentKeyHtml = '<span class="current-key-tag" data-tooltip="' + escapeHtml(t('currentKey')) + '" data-current-key-id="' + escapeHtml(bar.currentKeyId || '') + '"><span class="current-key-dot"></span>' + escapeHtml(bar.currentKeyName) + '</span>';
  } else {
    currentKeyHtml = '<span class="current-key-tag current-key-tag-none">' + escapeHtml(t('noCurrentKey')) + '</span>';
  }
  var displayModel = bar.alias || bar.model;
  var tokenInfo = ' <span class="quota-bar-tokens">' +
    '<span style="color:var(--accent2);font-weight:700">' + bar.successCount + '</span>' +
    '<span style="color:var(--text-muted);font-weight:400"> / </span>' +
    '<span style="color:var(--danger);font-weight:700">' + bar.errorCount + '</span>' +
    '<span style="color:var(--text-muted);margin:0 4px">|</span>' +
    '<span style="color:var(--text-muted)">in:</span>' +
    '<span style="color:var(--accent2);font-weight:600">' + formatCompactTokens(bar.inputTokens) + '</span>' +
    '<span style="color:var(--text-muted);margin:0 4px">|</span>' +
    '<span style="color:var(--text-muted)">out:</span>' +
    '<span style="color:var(--accent);font-weight:600">' + formatCompactTokens(bar.outputTokens) + '</span>' +
    '</span>';
  if (bar.hasQuota) {
    var pct = bar.totalCapacity > 0 ? (bar.totalUsed / bar.totalCapacity * 100) : 0;
    var fillColor = pct < 50 ? 'var(--accent2)' : (pct < 80 ? 'var(--warn)' : 'var(--danger)');
    var remain = bar.totalCapacity - bar.totalUsed;
    return '<div class="quota-bar-item" id="' + itemId + '" onclick="' + toggleCall + '">' +
      '<div class="quota-bar-header">' +
        '<span class="quota-bar-model"><span class="' + barDotClass + '" style="background:' + color + '"></span>' + escapeHtml(bar.provider) + ' / ' + escapeHtml(displayModel) + ' (' + bar.perKeyLimit + ' per/day)' + currentKeyHtml + tokenInfo + '</span>' +
        '<span class="quota-bar-right">' + QUOTA_CHEVRON + '</span>' +
      '</div>' +
      '<div class="quota-bar-row">' +
        '<span class="quota-bar-numbers">' + bar.totalUsed + '/' + bar.totalCapacity + '</span>' +
        '<div class="quota-bar-track" data-used="' + bar.totalUsed + '" data-total="' + bar.totalCapacity + '" data-remain="' + remain + '" data-perkey="' + bar.perKeyLimit + '">' +
          '<div class="quota-bar-fill" style="width:' + pct + '%;background:' + fillColor + '"></div>' +
        '</div>' +
      '</div>' +
      '<div class="model-key-detail-wrap" id="detail-' + itemId + '"></div>' +
    '</div>';
  } else {
    return '<div class="quota-bar-item" id="' + itemId + '" onclick="' + toggleCall + '">' +
      '<div class="quota-bar-header">' +
        '<span class="quota-bar-model"><span class="' + barDotClass + '" style="background:' + color + '"></span>' + escapeHtml(bar.provider) + ' / ' + escapeHtml(displayModel) + currentKeyHtml + tokenInfo + '</span>' +
        '<span class="quota-bar-right">' + QUOTA_CHEVRON + '</span>' +
      '</div>' +
      '<div class="model-key-detail-wrap" id="detail-' + itemId + '"></div>' +
    '</div>';
  }
}

function buildQuotaBarItems(bars, section) {
  if (!bars) return;
  for (var i = 0; i < bars.length; i++) {
    var bar = bars[i];
    var key = bar.provider + '/' + bar.model;
    var html = renderQuotaBarItem(bar);
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var el = temp.firstElementChild;
    section.appendChild(el);
    quotaBarItems[key] = el;
    el._hasQuota = !!bar.hasQuota;
    var setKey = JSON.stringify([bar.provider, bar.model]);
    if (expandedModels.has(setKey)) {
      toggleModelDetail(bar.provider, bar.model);
    }
  }
  attachQuotaBarHover();
}

function patchQuotaBarItem(el, bar) {
  if (!!el._hasQuota !== !!bar.hasQuota) {
    var key = bar.provider + '/' + bar.model;
    var temp = document.createElement('div');
    temp.innerHTML = renderQuotaBarItem(bar);
    var newEl = temp.firstElementChild;
    el.parentNode.replaceChild(newEl, el);
    quotaBarItems[key] = newEl;
    newEl._hasQuota = !!bar.hasQuota;
    attachQuotaBarHover();
    var setKey = JSON.stringify([bar.provider, bar.model]);
    if (expandedModels.has(setKey)) {
      toggleModelDetail(bar.provider, bar.model);
    }
    return;
  }
  var dot = el.querySelector('.model-color-dot');
  if (bar.inFlightKeyNames && bar.inFlightKeyNames.length > 0) {
    dot.classList.add('model-color-dot-calling');
  } else {
    dot.classList.remove('model-color-dot-calling');
  }
  var tokenInfo = ' <span class="quota-bar-tokens">' +
    '<span style="color:var(--accent2);font-weight:700">' + bar.successCount + '</span>' +
    '<span style="color:var(--text-muted);font-weight:400"> / </span>' +
    '<span style="color:var(--danger);font-weight:700">' + bar.errorCount + '</span>' +
    '<span style="color:var(--text-muted);margin:0 4px">|</span>' +
    '<span style="color:var(--text-muted)">in:</span>' +
    '<span style="color:var(--accent2);font-weight:600">' + formatCompactTokens(bar.inputTokens) + '</span>' +
    '<span style="color:var(--text-muted);margin:0 4px">|</span>' +
    '<span style="color:var(--text-muted)">out:</span>' +
    '<span style="color:var(--accent);font-weight:600">' + formatCompactTokens(bar.outputTokens) + '</span>' +
    '</span>';
  var currentKeyHtml = '';
  if (bar.currentKeyName) {
    currentKeyHtml = '<span class="current-key-tag" data-tooltip="' + escapeHtml(t('currentKey')) + '" data-current-key-id="' + escapeHtml(bar.currentKeyId || '') + '"><span class="current-key-dot"></span>' + escapeHtml(bar.currentKeyName) + '</span>';
  } else {
    currentKeyHtml = '<span class="current-key-tag current-key-tag-none">' + escapeHtml(t('noCurrentKey')) + '</span>';
  }
  var modelSpan = el.querySelector('.quota-bar-model');
  var displayModel = bar.alias || bar.model;
  var modelPrefix = escapeHtml(bar.provider) + ' / ' + escapeHtml(displayModel);
  if (bar.hasQuota) {
    modelPrefix += ' (' + bar.perKeyLimit + ' per/day)';
  }
  modelSpan.innerHTML = '<span class="' + dot.className + '" style="background:' + getModelColor(bar.provider, bar.model) + '"></span>' + modelPrefix + currentKeyHtml + tokenInfo;
  var numSpan = el.querySelector('.quota-bar-numbers');
  var track = el.querySelector('.quota-bar-track');
  var fill = track ? track.querySelector('.quota-bar-fill') : null;
  if (bar.hasQuota) {
    var pct = bar.totalCapacity > 0 ? (bar.totalUsed / bar.totalCapacity * 100) : 0;
    var fillColor = pct < 50 ? 'var(--accent2)' : (pct < 80 ? 'var(--warn)' : 'var(--danger)');
    if (numSpan) numSpan.textContent = bar.totalUsed + '/' + bar.totalCapacity;
    if (track) {
      var remain = bar.totalCapacity - bar.totalUsed;
      track.setAttribute('data-used', bar.totalUsed);
      track.setAttribute('data-total', bar.totalCapacity);
      track.setAttribute('data-remain', remain);
      track.setAttribute('data-perkey', bar.perKeyLimit);
    }
    if (fill) {
      setBarWidth(fill, pct + '%');
      fill.style.background = fillColor;
    }
  } else {
    if (numSpan) numSpan.textContent = '';
  }
}

function renderQuotaBars(bars) {
  if (!bars || bars.length === 0) return '<div class="card"><div class="card-title">' + t('quotaMonitor') + '</div>' + emptyState(t('noQuota')) + '</div>';
  var html = '<div class="card"><div class="card-title">' + t('quotaMonitor') + '</div><div class="quota-section quota-section-scroll">';
  for (var i = 0; i < bars.length; i++) {
    html += renderQuotaBarItem(bars[i]);
  }
  html += '</div></div>';
  return html;
}

function formatRemaining(ms) {
  if (ms <= 0) return '0s';
  var totalSec = Math.floor(ms / 1000);
  var m = Math.floor(totalSec / 60);
  var s = totalSec % 60;
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

function formatMinutes(ms) {
  if (ms < 0) ms = 0;
  if (ms < 60000) {
    var sec = Math.floor(ms / 1000);
    if (sec > 59) sec = 59;
    if (sec < 0) sec = 0;
    var s = String(sec);
    while (s.length < 2) s = '0' + s;
    return s;
  }
  var totalMin = Math.floor(ms / 60000);
  if (totalMin > 99) totalMin = 99;
  if (totalMin < 0) totalMin = 0;
  var m = String(totalMin);
  while (m.length < 2) m = '0' + m;
  return m;
}

function updateLockCountdowns() {
  var els = document.querySelectorAll('.model-key-countdown[data-unlock]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var unlock = el.getAttribute('data-unlock');
    if (!unlock) continue;
    var remaining = new Date(unlock).getTime() - Date.now();
    if (remaining <= 0) {
      el.textContent = '0s';
      el.classList.add('model-key-countdown-done');
    } else {
      el.textContent = formatRemaining(remaining);
    }
  }
}

function updateKeyTimers() {
  var els = document.querySelectorAll('.model-key-timer');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var type = el.getAttribute('data-type');
    if (type === 'cooldown') {
      var unlock = el.getAttribute('data-unlock');
      if (!unlock) continue;
      var remaining = new Date(unlock).getTime() - Date.now();
      if (remaining <= 0) {
        // cooldown 结束：切换到 idle 正向计时
        el.classList.remove('model-key-timer-cooldown');
        el.classList.add('model-key-timer-idle');
        el.setAttribute('data-type', 'idle');
        el.removeAttribute('data-unlock');
        var nowIso = new Date().toISOString();
        el.setAttribute('data-used-at', nowIso);
        el.textContent = '00';
        // 同行 status badge: cooldown/locked -> available
        var row = el.closest('.model-key-row');
        if (row) {
          var badge = row.querySelector('.key-status-badge');
          if (badge && (badge.classList.contains('key-status-cooldown') || badge.classList.contains('key-status-locked'))) {
            badge.classList.remove('key-status-cooldown', 'key-status-locked');
            badge.classList.add('key-status-available');
            badge.textContent = t('available');
          }
          // 同行 error 清除
          var errEl = row.querySelector('.model-key-error');
          if (errEl) {
            errEl.textContent = '';
            errEl.removeAttribute('title');
          }
        }
      } else {
        el.textContent = formatMinutes(remaining);
      }
    } else if (type === 'idle') {
      var usedAt = el.getAttribute('data-used-at');
      if (!usedAt) continue;
      var elapsed = Date.now() - new Date(usedAt).getTime();
      if (elapsed < 0) elapsed = 0;
      el.textContent = formatMinutes(elapsed);
    }
  }
}

function updateQuotaBars(bars) {
  var section = document.querySelector('.quota-monitor-card > .card > .quota-section');
  if (!section) return;
  var sig = computeQuotaSig(bars);
  if (sig === lastQuotaSig) return;
  lastQuotaSig = sig;
  if (!bars) bars = [];
  if (!lockCountdownTimerStarted) {
    lockCountdownTimerStarted = true;
    clearInterval(lockCountdownInterval);
    lockCountdownInterval = setInterval(function() {
      updateLockCountdowns();
      updateKeyTimers();
    }, 1000);
  }
  var seen = {};
  var keys = [];
  for (var i = 0; i < bars.length; i++) {
    var bar = bars[i];
    var key = bar.provider + '/' + bar.model;
    seen[key] = true;
    keys.push(key);
    var el = quotaBarItems[key];
    if (el) {
      patchQuotaBarItem(el, bar);
    } else {
      var temp = document.createElement('div');
      temp.innerHTML = renderQuotaBarItem(bar);
      var newEl = temp.firstElementChild;
      var refEl = null;
      for (var j = i + 1; j < bars.length; j++) {
        if (quotaBarItems[bars[j].provider + '/' + bars[j].model]) {
          refEl = quotaBarItems[bars[j].provider + '/' + bars[j].model];
          break;
        }
      }
      if (refEl) {
        section.insertBefore(newEl, refEl);
      } else {
        section.appendChild(newEl);
      }
      quotaBarItems[key] = newEl;
      newEl._hasQuota = !!bar.hasQuota;
      attachQuotaBarHover();
      var setKey = JSON.stringify([bar.provider, bar.model]);
      if (expandedModels.has(setKey)) {
        toggleModelDetail(bar.provider, bar.model);
      }
    }
  }
  for (var key in quotaBarItems) {
    if (!seen[key]) {
      var el = quotaBarItems[key];
      if (el && el.parentNode) el.parentNode.removeChild(el);
      delete quotaBarItems[key];
    }
  }
}

function attachQuotaBarHover() {
  var tracks = document.querySelectorAll('.quota-bar-track');
  tracks.forEach(function(track) {
    if (track._ttBound) return;
    track._ttBound = true;
    track.addEventListener('mouseenter', function() {
      var used = track.getAttribute('data-used');
      var total = track.getAttribute('data-total');
      var remain = track.getAttribute('data-remain');
      var perkey = track.getAttribute('data-perkey');
      showQuotaTooltip(track, used, total, remain, perkey);
    });
    track.addEventListener('mouseleave', hideQuotaTooltip);
  });
}

function showQuotaTooltip(track, used, total, remain, perkey) {
  hideQuotaTooltip();
  var tip = document.createElement('div');
  tip.className = 'quota-tip';
  tip.id = 'quota-tip';
  tip.innerHTML =
    '<div><span class="quota-tip-k">' + escapeHtml(t('quotaUsed')) + '</span><span class="quota-tip-v">' + used + '</span></div>' +
    '<div><span class="quota-tip-k">' + escapeHtml(t('quotaRemain')) + '</span><span class="quota-tip-v">' + remain + '</span></div>' +
    '<div><span class="quota-tip-k">' + escapeHtml(t('quotaTotal')) + '</span><span class="quota-tip-v">' + total + '</span></div>' +
    '<div class="quota-tip-perkey">' + escapeHtml(t('perKeyLabel')) + ': ' + perkey + '</div>';
  document.body.appendChild(tip);
  var rect = track.getBoundingClientRect();
  tip.style.left = rect.left + 'px';
  tip.style.top = (rect.top - tip.offsetHeight - 6) + 'px';
  // Flip below if not enough space above.
  if (rect.top - tip.offsetHeight - 6 < 4) {
    tip.style.top = (rect.bottom + 6) + 'px';
  }
}

function hideQuotaTooltip() {
  var existing = document.getElementById('quota-tip');
  if (existing) existing.remove();
}

function toggleModelDetail(provider, model) {
  var itemId = 'qbi-' + sanitizeId(provider) + '-' + sanitizeId(model);
  var detailId = 'detail-' + itemId;
  var wrap = document.getElementById(detailId);
  if (!wrap) return;
  var key = provider + '/' + model;
  var item = document.getElementById(itemId);
  var chevron = item ? item.querySelector('.quota-bar-chevron') : null;

  var setKey = JSON.stringify([provider, model]);
  if (expandedModels.has(setKey)) {
    expandedModels.delete(setKey);
    wrap.classList.remove('expanded');
    if (chevron) chevron.style.transform = '';
    setTimeout(function() { if (!expandedModels.has(setKey)) wrap.innerHTML = ''; }, 300);
  } else {
    expandedModels.add(setKey);
    wrap.classList.add('expanded');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
    wrap.innerHTML = '<div class="model-key-detail-loading">' + t('loading') + '...</div>';
    fetchModelKeyDetail(provider, model);
  }
}

async function fetchModelKeyDetail(provider, model) {
  try {
    var data = await apiGet('/usage/model-keys?provider=' + encodeURIComponent(provider) + '&model=' + encodeURIComponent(model));
    renderModelKeyDetail(provider, model, data);
  } catch(e) {
    var itemId = 'qbi-' + sanitizeId(provider) + '-' + sanitizeId(model);
    var wrap = document.getElementById('detail-' + itemId);
    if (wrap) wrap.innerHTML = '<div class="model-key-detail-error">' + escapeHtml(t('failed').replace('{0}', e.message || '')) + '</div>';
  }
}

function renderModelKeyDetail(provider, model, data) {
  var itemId = 'qbi-' + sanitizeId(provider) + '-' + sanitizeId(model);
  var wrap = document.getElementById('detail-' + itemId);
  if (!wrap) return;
  var setKey = JSON.stringify([provider, model]);
  if (!expandedModels.has(setKey)) return;
  if (!data.keys || data.keys.length === 0) {
    wrap.innerHTML = '<div class="model-key-detail-empty">' + escapeHtml(t('noKeysConfigured')) + '</div>';
    return;
  }

  var html = '<div class="model-key-detail">';
  data.keys.forEach(function(k) {
    var color = getModelColor(provider, model);
    var statusBadge = '';
    var quotaBar = '<span class="model-key-quota-bar">';

    if (data.hasQuota) {
      if (k.hasQuota) {
        if (k.modelRemaining === 0) {
          statusBadge = '<span class="key-status-badge key-status-exhausted">' + t('exhausted') + '</span>';
        } else {
          statusBadge = '<span class="key-status-badge key-status-available">' + t('available') + '</span>';
        }
        var pct = k.modelLimit > 0 ? ((k.modelLimit - k.modelRemaining) / k.modelLimit * 100) : 0;
        var fillColor = pct < 50 ? 'var(--accent2)' : (pct < 80 ? 'var(--warn)' : 'var(--danger)');
        quotaBar += '<div class="model-key-quota-fill" style="width:' + pct + '%;background:' + fillColor + '"></div>';
      } else {
        statusBadge = '<span class="key-status-badge key-status-untested">' + t('untestedKey') + '</span>';
      }
    } else {
      if (k.modelLock) {
        if (k.status === 'locked') {
          statusBadge = '<span class="key-status-badge key-status-locked">' + t('dailyLocked') + '</span>';
        } else {
          statusBadge = '<span class="key-status-badge key-status-cooldown">' + t('cooldown') + '</span>';
        }
      } else if (!k.isActive) {
        statusBadge = '<span class="key-status-badge key-status-inactive">' + t('inactive') + '</span>';
      } else {
        statusBadge = '<span class="key-status-badge key-status-available">' + t('available') + '</span>';
      }
    }

    var errorInfo = '<span class="model-key-error"';
    if (k.lastError) {
      var errStr = k.lastError.length > 60 ? k.lastError.slice(0, 60) + '…' : k.lastError;
      errorInfo += ' data-tooltip="' + escapeHtml(k.lastError) + '">' + escapeHtml(errStr);
    } else {
      errorInfo += '>';
    }
    errorInfo += '</span>';

    var quotaInfo = '<span class="model-key-quota-numbers">';
    if (data.hasQuota && k.hasQuota) {
      quotaInfo += (k.modelLimit - k.modelRemaining) + '/' + k.modelLimit;
    }
    quotaInfo += '</span>';

    // Dot state classes (calling + in-use are independent)
    var dotClass = 'model-color-dot';
    if (k.inFlight && k.inFlight > 0) {
      dotClass += ' model-color-dot-calling';
    }

    // "In Use" badge removed; row highlighting + dot size indicate predicted next key
    var rowClass = 'model-key-row';
    var usable = k.isActive && k.status === 'active' && !k.modelLock;
    if (usable && ((data.inUseKeyID && k.keyId === data.inUseKeyID) || (!data.inUseKeyID && data.inUseKeyName && k.keyName === data.inUseKeyName))) {
      dotClass += ' model-color-dot-in-use';
      rowClass = 'model-key-row model-key-row-in-use';
    } else if (!usable) {
      rowClass = 'model-key-row model-key-row-disabled';
    }

    // Timer: 2-digit circle left of dot; mutually exclusive display
    var timerHtml = '';
    if (k.modelLock || k.status === 'cooldown' || k.status === 'locked') {
      if (k.modelLock) {
        var unlockMs = new Date(k.modelLock).getTime() - Date.now();
        timerHtml = '<span class="model-key-timer model-key-timer-cooldown" data-type="cooldown" data-unlock="' + k.modelLock + '">' + formatMinutes(unlockMs) + '</span>';
      }
    } else if (k.lastUsedAt) {
      var isCurrentlyInUse = (data.inUseKeyID && k.keyId === data.inUseKeyID) ||
       (!data.inUseKeyID && data.inUseKeyName && k.keyName === data.inUseKeyName);
      var isCurrentlyCalling = k.inFlight && k.inFlight > 0;
      if (!isCurrentlyInUse && !isCurrentlyCalling) {
        var idleMs = Date.now() - new Date(k.lastUsedAt).getTime();
        timerHtml = '<span class="model-key-timer model-key-timer-idle" data-type="idle" data-used-at="' + k.lastUsedAt + '">' + formatMinutes(idleMs) + '</span>';
      }
    }

    var metricsHtml = '<span class="model-key-metrics">';
    var hasMetrics = (k.successCount != null && k.successCount > 0) || (k.errorCount != null && k.errorCount > 0) || (k.avgTtftMs != null && k.avgTtftMs > 0) || (k.avgSpeed != null && k.avgSpeed > 0) || (k.liveSpeed != null && k.liveSpeed > 0);
    if (hasMetrics) {
      var metricsParts = [];
      if (k.successCount != null || k.errorCount != null) {
        metricsParts.push('<span class="model-key-metric model-key-succ">' + (k.successCount || 0) + '/<span class="model-key-err">' + (k.errorCount || 0) + '</span></span>');
      }
      if (k.avgTtftMs != null && k.avgTtftMs > 0) {
        metricsParts.push('<span class="model-key-metric">' + (k.avgTtftMs / 1000).toFixed(1) + 's</span>');
      }
      if (k.inFlight && k.inFlight > 0 && k.liveSpeed != null && k.liveSpeed > 0) {
        metricsParts.push('<span class="model-key-metric metric-live">' + k.liveSpeed.toFixed(1) + ' tok/s</span>');
      } else if (k.avgSpeed != null && k.avgSpeed > 0) {
        metricsParts.push('<span class="model-key-metric">' + k.avgSpeed.toFixed(1) + ' tok/s</span>');
      }
      metricsHtml += metricsParts.join('');
    }
    metricsHtml += '</span>';

    quotaBar += '</span>';

    var leadHtml = timerHtml !== '' ? timerHtml : '<span class="' + dotClass + '" style="background:' + color + '"></span>';
    html += '<div class="' + rowClass + '">' +
      leadHtml +
      '<span class="model-key-name">' + escapeHtml(k.keyName) + '</span>' +
      quotaInfo +
      quotaBar +
      statusBadge +
      metricsHtml +
      errorInfo +
    '</div>';
  });
  html += '</div>';
  wrap.innerHTML = html;
}

function reexpandModelDetails() {
  expandedModels.forEach(function(setKey) {
    var parts = JSON.parse(setKey);
    var provider = parts[0];
    var model = parts[1];
    var itemId = 'qbi-' + sanitizeId(provider) + '-' + sanitizeId(model);
    var wrap = document.getElementById('detail-' + itemId);
    if (wrap) {
      wrap.classList.add('expanded');
      var chevron = document.querySelector('#' + itemId + ' .quota-bar-chevron');
      if (chevron) chevron.style.transform = 'rotate(180deg)';
      fetchModelKeyDetail(provider, model);
    }
  });
}

function maybeRefreshPerKeyDetails() {
  var now = Date.now();
  if (now - _lastPerKeyRefresh < 3000) return;
  _lastPerKeyRefresh = now;
  reexpandModelDetails();
}

// --- Recent Requests Modal ---

function openRecentRequests() {
  var overlay = document.getElementById('modal-overlay');
  if (overlay.classList.contains('show')) return;

  var entries = lastUsageEntries;
  var tableHtml = entries.length === 0 ? emptyState(t('noUsage')) :
    '<div class="recent-requests-scroll">' +
    '<table>' +
      '<thead><tr><th class="status-col-header"></th><th>' + t('time') + '</th><th>' + t('provider') + '</th><th>' + t('model') + '</th><th>Key</th><th>' + t('latency') + '</th><th>' + t('tokens') + '</th></tr></thead>' +
      '<tbody>' + entries.filter(shouldShowUsageEntry).map(function(e) { return renderUsageRow(e, undefined, false); }).join('') + '</tbody>' +
    '</table>' +
    '</div>';

  overlay.innerHTML = '<div class="modal" id="recent-requests-modal" style="max-width:900px;width:90vw">' +
    '<div class="modal-title">' + t('recentRequests') + '</div>' +
    '<div class="modal-body" style="max-height:60vh;overflow-y:auto;padding:0 0 8px 0">' + tableHtml + '</div>' +
    '<div class="modal-footer">' +
      '<button type="button" class="btn btn-danger btn-sm" onclick="clearUsageFromModal()">' + t('clear') + '</button>' +
      '<button type="button" class="btn btn-ghost" onclick="closeRecentRequests()">' + t('close') + '</button>' +
    '</div>' +
  '</div>';

  requestAnimationFrame(function() { overlay.classList.add('show'); });
}

function closeRecentRequests() {
  var overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('show');
  overlay.addEventListener('transitionend', function() { overlay.innerHTML = ''; }, { once: true });
}

function updateRecentRequestsModal() {
  var modal = document.getElementById('recent-requests-modal');
  if (!modal) return;
  var tbody = modal.querySelector('tbody');
  if (!tbody) return;
  var entries = lastUsageEntries;
  if (entries.length === 0) {
    var body = modal.querySelector('.modal-body');
    if (body) body.innerHTML = emptyState(t('noUsage'));
  } else {
    tbody.innerHTML = entries.filter(shouldShowUsageEntry).map(function(e) { return renderUsageRow(e, undefined, false); }).join('');
  }
}

async function clearUsageFromModal() {
  await apiDelete('/usage');
  toast(t('usageCleared'), 'info');
  closeRecentRequests();
  renderUsage(document.getElementById('page-content'));
}

// ===================== Usage Entry Info Modal (Debug Mode) =====================

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
      var entries = usage.entries || [];
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
    var data = await apiGet('/api/traces/req/' + encodeURIComponent(e.id));
    if (currentInfoModalRequestId !== e.id) return;
    var traceHtml = '';
    if (data && data.lines && data.lines.length > 0) {
      var reqLine = data.lines.find(function(l) { return l.type === 'request'; });
      var attemptLines = data.lines.filter(function(l) { return l.type === 'attempt'; });
      var lastAttempt = attemptLines.length > 0 ? attemptLines[attemptLines.length - 1] : null;
      if (reqLine && reqLine.reqBody) traceHtml += renderInfoSection('Request', formatBody(reqLine.reqBody));
      if (reqLine && reqLine.reqHeaders) traceHtml += renderInfoSection('Request Headers', reqLine.reqHeaders);
      if (lastAttempt) {
        if (lastAttempt.respHeaders) traceHtml += renderInfoSection('Response Headers', lastAttempt.respHeaders);
        if (lastAttempt.respStatus) traceHtml += '<div class="info-section"><div class="info-section-title">Status: ' + escapeHtml(String(lastAttempt.respStatus)) + '</div></div>';
        if (lastAttempt.respBody) traceHtml += renderInfoSection('Response Body', formatBody(lastAttempt.respBody));
      }
    }
    if (!traceHtml) traceHtml = '<div class="info-section"><div class="info-section-title">Trace Detail</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap;color:var(--text-muted)">(trace not available)</pre></div></div></div>';
    loadingEl.outerHTML = traceHtml;
  } catch (ex) {
    if (currentInfoModalRequestId !== e.id) return;
    loadingEl.outerHTML = '<div class="info-section"><div class="info-section-title">Trace Detail</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap;color:var(--text-muted)">(trace not available)</pre></div></div></div>';
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
    html += renderInfoSection('Request Info', summaryData);
  }
  if (e.reqPayload) {
    html += renderInfoSection('Request', e.reqPayload);
  }
  if (e.reqHeaders) {
    html += renderInfoSection('Request Headers', e.reqHeaders);
  }
  if (e.status === 'processing' && usageDebugMode) {
    html += '<div class="info-section" id="streaming-reasoning-section">' +
      '<div class="info-section-title">Reasoning (streaming)</div>' +
      '<div class="info-field">' +
        '<span class="info-field-key">' +
          '<span class="info-field-key-name">Content</span>' +
          '<span class="info-field-actions">' +
            '<button type="button" class="info-copy-btn" onclick="copyStreamingText(this)">Copy</button>' +
          '</span>' +
        '</span>' +
        '<div class="info-field-value">' +
          '<pre class="info-json" id="streaming-reasoning-text" style="white-space:pre-wrap;min-height:20px;color:var(--text-muted)">Thinking...</pre>' +
        '</div>' +
      '</div>' +
    '</div>';
    html += '<div class="info-section" id="streaming-assistant-section">' +
      '<div class="info-section-title">Assistant Message (streaming)</div>' +
      '<div class="info-field">' +
        '<span class="info-field-key">' +
          '<span class="info-field-key-name">Content</span>' +
          '<span class="info-field-actions">' +
            '<button type="button" class="info-copy-btn" onclick="copyStreamingText(this)">Copy</button>' +
          '</span>' +
        '</span>' +
        '<div class="info-field-value">' +
          '<pre class="info-json" id="streaming-assistant-text" style="white-space:pre-wrap;min-height:20px"> </pre>' +
        '</div>' +
      '</div>' +
    '</div>';
    html += '<div class="info-section" id="streaming-usage-section" style="display:none">' +
      '<div class="info-section-title">Usage</div>' +
      '<div class="info-field">' +
        '<span class="info-field-key">' +
          '<span class="info-field-key-name">Token Stats</span>' +
          '<span class="info-field-actions">' +
            '<button type="button" class="info-copy-btn" onclick="copyStreamingText(this)">Copy</button>' +
          '</span>' +
        '</span>' +
        '<div class="info-field-value">' +
          '<pre class="info-json" id="streaming-usage-text" style="white-space:pre-wrap;min-height:20px;color:var(--text-muted)">Waiting...</pre>' +
        '</div>' +
      '</div>' +
    '</div>';
  } else {
    if (e.respHeaders) {
      html += renderInfoSection('Response Headers', e.respHeaders);
    }
    if (e.respStatus) {
      html += '<div class="info-section"><div class="info-section-title">Status: ' + escapeHtml(e.respStatus) + '</div></div>';
    }
    if (e.respPayload) {
      html += renderInfoSection('Response Body', e.respPayload);
    }
    if (e.__streamingReasoning) {
      html += '<div class="info-section"><div class="info-section-title">Reasoning</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap">' + escapeHtml(e.__streamingReasoning) + '</pre></div></div></div>';
    }
    if (e.__streamingAssistant) {
      html += '<div class="info-section"><div class="info-section-title">Assistant Message</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap">' + escapeHtml(e.__streamingAssistant) + '</pre></div></div></div>';
    }
  }
  if (traceEnabled && e.status !== 'processing' && !e.reqPayload && !e.respPayload && !e.reqHeaders && !e.respHeaders) {
    html += '<div class="info-section" id="trace-loading-section"><div class="info-section-title">Trace Detail</div><div class="info-field"><div class="info-field-value"><pre class="info-json" style="white-space:pre-wrap;color:var(--text-muted)">Loading trace…</pre></div></div></div>';
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

function showUsageEntryInfo(ts) {
  var e = lastUsageEntries.find(function(x) { return String(new Date(x.timestamp).getTime()) === ts; });
  if (!e) return;
  showUsageEntryInfoWithData(e);
}

function copyStreamingText(btn) {
  var field = btn.closest('.info-field');
  if (!field) return;
  var pre = field.querySelector('.info-json');
  if (!pre) return;
  var text = pre.textContent || '';
  navigator.clipboard.writeText(text).then(function() {
    var orig = btn.textContent;
    btn.textContent = 'Copied';
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

async function resetQuotaTimers() {
	var ok = await confirmModal(t('confirmResetQuota'));
	if (!ok) return;
	try {
		var resp = await apiPost('/usage/reset-quota', {});
		if (resp && resp.ok) {
			toast(t('quotaReset'), 'success');
			refreshQuotaMonitor();
		} else {
			toast(t('failed', [resp.error || '']), 'error');
		}
	} catch(e) {
		toast(t('failed', [e.message]), 'error');
	}
}

function refreshQuotaMonitor() {
	var c = document.getElementById('page-content');
	if (c) renderUsage(c);
}
