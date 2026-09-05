// ===== Recent Requests list =====

function renderUsageRow(e, sessionKey, hidden) {
  var statusDot;
  var dotClass = 'status-dot';
  if (e.status === 'success') dotClass += ' status-dot-success';
  else if (e.status === 'error') dotClass += ' status-dot-error';
  else if (e.status === 'retry') dotClass += ' status-dot-retry';
  else dotClass += ' status-dot-processing';
  var dotHtml = '<span class="' + dotClass + '"></span>';
  var statusInner;
  if (e.id || e.reqPayload || e.respPayload || e.respHeaders || e.reqHeaders || e.upstreamUrl || e.respStatus || e.status === 'processing' || traceEnabled) {
    statusInner = '<button type="button" class="btn btn-sm btn-info" onclick="showUsageEntryInfoById(\'' + escapeForJsString(e.id || '') + '\')">' + dotHtml + '</button>';
  } else {
    statusInner = dotHtml;
  }
  // TTFT: frozen on first-token (request-ttft), ticking wall-clock before.
  var ttftDisplay, ttftFrozen;
  if (e.status === 'processing') {
    if (e.ttftMs && e.ttftMs > 0) {
      ttftDisplay = formatTTFT(e.ttftMs);
      ttftFrozen = true;
    } else {
      var ttftElapsed = Date.now() - new Date(e.timestamp).getTime();
      if (isNaN(ttftElapsed) || ttftElapsed < 0) ttftElapsed = 0;
      ttftDisplay = formatTTFT(ttftElapsed);
      ttftFrozen = false;
    }
  } else {
    ttftFrozen = true;
    ttftDisplay = (e.ttftMs && e.ttftMs > 0) ? formatTTFT(e.ttftMs) : '—';
  }
  // GT anchor priority: server first-content stamp (provider-agnostic local
  // byte observation) > ts + ttft. Freezes at done via LatencyMs - TTFTMs.
  var genStartMs = null;
  var genSrc = '';
  if (e.firstContentMs && e.firstContentMs > 0) {
    genStartMs = e.firstContentMs;
    genSrc = 'fcm';
  } else if (e.ttftMs && e.ttftMs > 0 && e.timestamp) {
    genStartMs = new Date(e.timestamp).getTime() + e.ttftMs;
    if (isNaN(genStartMs)) genStartMs = null;
    if (genStartMs != null) genSrc = 'ttft';
  }
  var gtMs = null, gtDisplay, spdDisplay;
  var inT = (e.inputTokens || 0);
  // RES/CT split: prefer per-split fields; fall back to splitting the
  // aggregate by ratio when only outputTokens exists (old entries).
  var resT = (e.reasoningTokens || 0);
  var ctT = (e.contentTokens || 0);
  var outT = (e.outputTokens || 0);
  if (outT > 0 && resT + ctT === 0) ctT = outT;
  var spdBase = resT + ctT > 0 ? resT + ctT : outT;
  if (e.status === 'processing') {
    if (genStartMs != null) {
      gtMs = Date.now() - genStartMs;
      if (isNaN(gtMs) || gtMs < 0) gtMs = 0;
      gtDisplay = formatGenTime(gtMs);
      spdDisplay = formatGenSpeed(spdBase, gtMs);
    } else {
      gtDisplay = '—';
      spdDisplay = '—';
    }
  } else {
    if (genStartMs != null) {
      gtMs = (e.latencyMs || 0) - (e.ttftMs || 0);
      if (isNaN(gtMs) || gtMs < 0) gtMs = 0;
    } else {
      gtMs = e.latencyMs || 0;
    }
    gtDisplay = formatGenTime(gtMs);
    spdDisplay = formatGenSpeed(spdBase, gtMs);
  }
  var tsAttr = e.timestamp ? ' data-ts="' + escapeHtml(e.timestamp) + '"' : '';
  var ttftAttr = (ttftFrozen && e.status === 'processing') ? ' data-ttft="1"' : '';
  var genAttr = (genStartMs != null) ? ' data-gen-start="' + genStartMs + '"' : '';
  genAttr += (genSrc ? ' data-gen-src="' + genSrc + '"' : '');
  var outAttr = ' data-out="' + outT + '" data-res="' + resT + '" data-ct="' + ctT + '"';
  var provPrefix = (typeof findProviderPrefix === 'function') ? findProviderPrefix(e) : (e.provider || '');
  var keyShort = (typeof shortKeyName === 'function') ? shortKeyName(e.keyName) : (e.keyName || '');
  var idAttr = e.id ? ' data-id="' + sanitizeId(e.id) + '"' : '';
  var inSession = sessionKey !== undefined;
  var sessionAttr = inSession ? ' data-session="' + escapeHtml(sessionKey) + '" class="session-row' + (hidden ? ' session-row-hidden' : '') + '"' : '';
  var firstCellClass = inSession ? 'status-col-cell session-row-indented' : 'status-col-cell';
  return '<tr data-status="' + e.status + '"' + tsAttr + ttftAttr + genAttr + outAttr + idAttr + sessionAttr + '>\
    <td class="' + firstCellClass + '">' + statusInner + '</td>\
    <td>' + new Date(e.timestamp).toLocaleTimeString() + '</td>\
    <td data-tooltip="' + escapeHtml(e.provider || '') + '">' + escapeHtml(provPrefix) + '</td>\
    <td class="model-cell" data-tooltip="' + escapeHtml(displayModelName(e.model, e.originalModel)) + '">' + escapeHtml(displayModelName(e.model, e.originalModel)) + '</td>\
    <td data-tooltip="' + escapeHtml(e.keyName || '') + '">' + escapeHtml(keyShort) + '</td>\
    <td class="ttft-cell" data-tooltip="' + escapeHtml(t('ttTTFT')) + '">' + ttftDisplay + '</td>\
    <td class="gt-cell" data-tooltip="' + escapeHtml(t('ttGT')) + '">' + gtDisplay + '</td>\
    <td class="in-cell" data-tooltip="' + escapeHtml(t('thInput')) + '">' + inT + '</td>\
    <td class="res-cell" data-tooltip="' + escapeHtml(t('ttRES')) + '">' + resT + '</td>\
    <td class="ct-cell" data-tooltip="' + escapeHtml(t('ttCT')) + '">' + ctT + '</td>\
    <td class="speed-cell" data-tooltip="' + escapeHtml(t('thAvgSpeed')) + '">' + spdDisplay + '</td>\
  </tr>';
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
  var atFirst = recentPage <= 1;
  var atLast = recentPage >= maxPage;
  var ind = document.getElementById('recent-page-indicator');
  if (ind) ind.textContent = recentPage + ' / ' + maxPage;
  var sel = document.getElementById('recent-page-size');
  if (sel && String(sel.value) !== String(recentPageSize)) sel.value = String(recentPageSize);
  var prev = document.getElementById('recent-prev-page');
  if (prev) {
    prev.disabled = atFirst;
    prev.classList.toggle('pager-disabled', atFirst);
  }
  var next = document.getElementById('recent-next-page');
  if (next) {
    next.disabled = atLast;
    next.classList.toggle('pager-disabled', atLast);
  }
}

var ICON_STATUS_SUCCESS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
var ICON_STATUS_FAILURE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
var ICON_STATUS_PROCESSING = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
var ICON_STATUS_SESSION = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

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
  var header = '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:6px">' +
    '<span style="white-space:nowrap;flex-shrink:0">' + t('recentRequests') + '<span class="recent-count">' + filtered.length + '</span></span>' +
    '<span class="console-controls" style="gap:6px">' +
      '<div class="btn-filter-group">' +
        '<button type="button" class="btn btn-sm btn-filter' + (usageFilters.success ? ' active' : '') + '" data-filter="success" onclick="toggleUsageFilter(this,\'success\')" data-tooltip="' + escapeHtml(t('filterSuccess')) + '" aria-label="' + escapeHtml(t('filterSuccess')) + '">' + ICON_STATUS_SUCCESS + '</button>' +
        '<button type="button" class="btn btn-sm btn-filter' + (usageFilters.failure ? ' active' : '') + '" data-filter="failure" onclick="toggleUsageFilter(this,\'failure\')" data-tooltip="' + escapeHtml(t('filterFailure')) + '" aria-label="' + escapeHtml(t('filterFailure')) + '">' + ICON_STATUS_FAILURE + '</button>' +
        '<button type="button" class="btn btn-sm btn-filter' + (usageFilters.processing ? ' active' : '') + '" data-filter="processing" onclick="toggleUsageFilter(this,\'processing\')" data-tooltip="' + escapeHtml(t('filterProcessing')) + '" aria-label="' + escapeHtml(t('filterProcessing')) + '">' + ICON_STATUS_PROCESSING + '</button>' +
        '<button type="button" class="btn btn-sm btn-filter' + (recentGroupBySession ? ' active' : '') + '" id="recent-group-toggle" onclick="toggleRecentGroupBySession()" data-tooltip="' + escapeHtml(t('groupBySession')) + '" aria-label="' + escapeHtml(t('groupBySession')) + '">' + ICON_STATUS_SESSION + '</button>' +
      '</div>' +
      '<input type="text" id="recent-search" class="console-search" value="' + escapeHtml(recentSearchQuery) + '" placeholder="' + escapeHtml(t('searchProviderModel')) + '" aria-label="' + escapeHtml(t('searchProviderModel')) + '" autocomplete="off" oninput="onRecentSearch(this.value)">' +
      pagerHtml +
    '</span>' +
  '</div>';
  var emptyRow = '<tr class="recent-empty-row"><td colspan="11" style="text-align:center;color:var(--text-muted)">' + escapeHtml(recentSearchQuery.trim() ? t('noMatchingRequests') : t('noUsage')) + '</td></tr>';
  var body = '<div class="recent-requests-scroll card-scroll">' +
    '<table class="usage-table" data-nofit="1">' +
      '<colgroup>' +
        '<col style="width:28px">' +
        '<col style="width:9ch">' +
        '<col style="width:6ch">' +
        '<col style="width:30ch">' +
        '<col style="width:5ch">' +
        '<col style="width:5ch">' +
        '<col style="width:8ch">' +
        '<col style="width:7ch">' +
        '<col style="width:6ch">' +
        '<col style="width:6ch">' +
        '<col style="width:13ch">' +
      '</colgroup>' +
      '<thead><tr>' +
        '<th class="status-col-header"></th>' +
        '<th class="col-time" data-fixed="1">' + t('thTime') + '</th>' +
        '<th class="col-prov" data-fixed="1" data-tooltip="' + escapeHtml(t('thProvider')) + '">' + t('thProv') + '</th>' +
        '<th class="col-model">' + t('thModel') + '</th>' +
        '<th class="col-key" data-fixed="1" data-tooltip="' + escapeHtml(t('thKey')) + '">' + t('thKey') + '</th>' +
        '<th class="num-ttft" data-fixed="1" data-tooltip="' + escapeHtml(t('ttTTFT')) + '">' + t('thTTFT') + '</th>' +
        '<th class="num-gt" data-fixed="1" data-tooltip="' + escapeHtml(t('ttGT')) + '">' + t('thGT') + '</th>' +
        '<th class="num-in" data-fixed="1" data-tooltip="' + escapeHtml(t('thInput')) + '">' + t('thIn') + '</th>' +
        '<th class="num-int" data-fixed="1" data-tooltip="' + escapeHtml(t('ttRES')) + '">' + t('thRES') + '</th>' +
        '<th class="num-int" data-fixed="1" data-tooltip="' + escapeHtml(t('ttCT')) + '">' + t('thCT') + '</th>' +
        '<th class="num-spd" data-fixed="1" data-tooltip="' + escapeHtml(t('thAvgSpeed')) + '">' + t('thSpd') + '</th>' +
      '</tr></thead>' +
      '<tbody id="recent-tbody">' + (rows.length > 0 ? renderRecentRows(rows) : emptyRow) + '</tbody>' +
    '</table>' +
  '</div>';
  return '<div class="card recent-requests-card">' + header + body + '</div>';
}

function onRecentSearch(value) {
  recentSearchQuery = String(value || '');
  recentPage = 1;
  updateRecentRequestsInline(lastUsageEntries);
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
  tbody.innerHTML = rows.length > 0
    ? renderRecentRows(rows)
    : '<tr class="recent-empty-row"><td colspan="11" style="text-align:center;color:var(--text-muted)">' + escapeHtml(recentSearchQuery.trim() ? t('noMatchingRequests') : t('noUsage')) + '</td></tr>';
  scheduleMonitorTableAutoFit();
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
    html += '<tr class="session-group-header ungrouped" data-session-group=""><td colspan="11" style="font-size:var(--font-badge);color:var(--text-muted)">' +
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
  return '<tr class="' + cls + '" data-session-group="' + escapeHtml(sk) + '" onclick="toggleSessionGroup(this, \'' + escapeForJsString(sk) + '\')">' +
    '<td colspan="11" class="session-group-cell">' +
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
    scheduleMonitorTableAutoFit();
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
  for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('session-row-hidden', !nowExpanded);
  var arrow = headerEl.querySelector('.session-group-arrow');
  if (arrow) arrow.textContent = nowExpanded ? '\u25BE' : '\u25B8';
  scheduleMonitorTableAutoFit();
}

function toggleUsageFilter(btn, filter) {
  usageFilters[filter] = !usageFilters[filter];
  btn.classList.toggle('active', usageFilters[filter]);
  updateRecentRequestsInline(lastUsageEntries);
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