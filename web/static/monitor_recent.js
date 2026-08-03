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