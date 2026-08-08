// editor-logs.js — Log Reader mode for the Editor page.
// Loaded after editor.js. Renders a three-pane trace browser:
//   left = date list, middle = request index, right = request detail.
// Uses apiGet() for all backend calls and t() for i18n strings.

'use strict';

// ===================== state =====================

var elLogs = null;            // container ref for cleanup
var logsAbort = null;         // AbortController for in-flight fetches
var logsDate = null;          // currently selected date (YYYYMMDD)
var logsOffset = 0;           // current pagination offset for index
var logsLimit = 200;          // page size
var logsTotal = 0;            // total filtered count for selected date
var logsAllLines = [];        // accumulated lines for selected date
var logsFilterStatus = '';    // status filter ('', 'success', 'error')
var logsFilterQ = '';         // search query
var logsSelectedReq = null;   // currently selected request detail

// ===================== helpers =====================

function logsEscapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function logsFormatTs(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  var h = String(d.getHours()).padStart(2, '0');
  var m = String(d.getMinutes()).padStart(2, '0');
  var s = String(d.getSeconds()).padStart(2, '0');
  return h + ':' + m + ':' + s;
}

function logsTruncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.substring(0, n) + '…' : s;
}

function logsFormatBytes(n) {
  if (!n) return '0 B';
  n = Number(n);
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function logsFormatBody(body) {
  if (body == null) return '';
  if (typeof body === 'object') {
    try { return JSON.stringify(body, null, 2); } catch (e) { return String(body); }
  }
  var s = String(body);
  // SSE stream: split lines and pretty-print each data: JSON payload.
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

// ===================== abort =====================

function logsAbortFetch() {
  if (logsAbort) {
    logsAbort.abort();
    logsAbort = null;
  }
}

// ===================== cleanup =====================

window.suspendEditorLogs = function() {
  logsAbortFetch();
  if (elLogs) elLogs.innerHTML = '';
  elLogs = null;
};

window.cleanupEditorLogs = function() {
  logsAbortFetch();
  if (elLogs) elLogs.innerHTML = '';
  elLogs = null;
  logsDate = null;
  logsOffset = 0;
  logsTotal = 0;
  logsAllLines = [];
  logsFilterStatus = '';
  logsFilterQ = '';
  logsSelectedReq = null;
};

// ===================== render: log reader =====================

window.renderLogReader = function(container) {
  elLogs = container;
  container.innerHTML = '';
  container.style.height = '100%';
  container.style.overflow = 'hidden';

  var layout = document.createElement('div');
  layout.className = 'log-reader-layout';
  layout.id = 'log-reader-layout';
  container.appendChild(layout);

  // Left pane: date list
  var leftPane = document.createElement('div');
  leftPane.className = 'log-reader-left';
  layout.appendChild(leftPane);

  var leftHeader = document.createElement('div');
  leftHeader.className = 'log-reader-pane-header';
  leftHeader.textContent = t('logDates');
  leftPane.appendChild(leftHeader);

  var leftList = document.createElement('div');
  leftList.className = 'log-reader-list';
  leftList.id = 'log-dates-list';
  leftPane.appendChild(leftList);

  // Middle pane: request list
  var midPane = document.createElement('div');
  midPane.className = 'log-reader-middle';
  layout.appendChild(midPane);

  var midHeader = document.createElement('div');
  midHeader.className = 'log-reader-pane-header';
  midHeader.textContent = t('logRequests');
  midPane.appendChild(midHeader);

  // Filter bar
  var filterBar = document.createElement('div');
  filterBar.className = 'log-reader-filter';

  var statusSelect = document.createElement('select');
  statusSelect.className = 'log-filter-select';
  statusSelect.id = 'log-filter-status';
  var statusOpts = [
    { value: '', label: t('logAll') },
    { value: 'success', label: t('logSuccess') },
    { value: 'error', label: t('logError') }
  ];
  for (var si = 0; si < statusOpts.length; si++) {
    var sOpt = document.createElement('option');
    sOpt.value = statusOpts[si].value;
    sOpt.textContent = statusOpts[si].label;
    statusSelect.appendChild(sOpt);
  }
  filterBar.appendChild(statusSelect);

  var searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'log-filter-search';
  searchInput.id = 'log-filter-q';
  searchInput.placeholder = t('logSearchPlaceholder');
  searchInput.setAttribute('aria-label', t('logSearchLabel'));
  filterBar.appendChild(searchInput);

  midPane.appendChild(filterBar);

  // Request list container
  var midList = document.createElement('div');
  midList.className = 'log-reader-list';
  midList.id = 'log-requests-list';
  midPane.appendChild(midList);

  // Load more button
  var loadMoreBtn = document.createElement('button');
  loadMoreBtn.className = 'log-load-more';
  loadMoreBtn.id = 'log-load-more';
  loadMoreBtn.textContent = t('logLoadMore');
  loadMoreBtn.style.display = 'none';
  midPane.appendChild(loadMoreBtn);

  // Right pane: detail
  var rightPane = document.createElement('div');
  rightPane.className = 'log-reader-right';
  layout.appendChild(rightPane);

  var rightHeader = document.createElement('div');
  rightHeader.className = 'log-reader-pane-header';
  rightHeader.textContent = t('logDetail');
  rightPane.appendChild(rightHeader);

  var rightContent = document.createElement('div');
  rightContent.className = 'log-reader-detail';
  rightContent.id = 'log-detail';
  rightPane.appendChild(rightContent);

  logsLoadDates(leftList, function() {
    logsRestoreView(leftList, midList, loadMoreBtn, statusSelect, searchInput);
  });

  // ===================== filter events =====================
  statusSelect.addEventListener('change', function() {
    logsFilterStatus = this.value;
    logsOffset = 0;
    logsAllLines = [];
    logsLoadIndex(midList, loadMoreBtn);
  });

  var searchDebounce = null;
  searchInput.addEventListener('input', function() {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function() {
      logsFilterQ = searchInput.value.trim();
      logsOffset = 0;
      logsAllLines = [];
      logsLoadIndex(midList, loadMoreBtn);
    }, 300);
  });

  // ===================== load more =====================
  loadMoreBtn.addEventListener('click', function() {
    logsOffset += logsLimit;
    logsLoadIndex(midList, loadMoreBtn);
  });

  // ===================== scroll near bottom for load more =====================
  midList.addEventListener('scroll', function() {
    if (midList.scrollTop + midList.clientHeight >= midList.scrollHeight - 200) {
      if (logsAllLines.length < logsTotal) {
        logsOffset += logsLimit;
        logsLoadIndex(midList, loadMoreBtn);
      }
    }
  });
};

// ===================== load dates =====================
function logsLoadDates(listEl, onLoaded) {
  logsAbortFetch();
  logsAbort = new AbortController();
  listEl.innerHTML = '<div class="log-loading">' + t('logLoading') + '</div>';

  apiGet('/traces/dates', logsAbort.signal).then(function(data) {
    logsAbort = null;
    if (!data || data.error) {
      listEl.innerHTML = emptyState(t('logDatesError'));
      return;
    }
    var dates = data.dates || [];
    if (dates.length === 0) {
      listEl.innerHTML = emptyState(t('logNoDates'));
      return;
    }
    listEl.innerHTML = '';
    for (var i = 0; i < dates.length; i++) {
      (function(d) {
        var item = document.createElement('div');
        item.className = 'log-date-item';
        item.dataset.date = d.date;
        var dateSpan = document.createElement('span');
        dateSpan.className = 'log-date-label';
        dateSpan.textContent = d.date;
        var countSpan = document.createElement('span');
        countSpan.className = 'log-date-count muted';
        countSpan.textContent = ' \u00B7 ' + d.count;
        item.appendChild(dateSpan);
        item.appendChild(countSpan);
        item.addEventListener('click', function() {
          logsSelectDate(d.date, listEl);
        });
        listEl.appendChild(item);
      })(dates[i]);
    }
    if (typeof onLoaded === 'function') onLoaded();
  }).catch(function(err) {
    logsAbort = null;
    if (err.name === 'AbortError') return;
    listEl.innerHTML = emptyState(t('logDatesError'));
  });
}

function logsRestoreView(leftList, midList, loadMoreBtn, statusSelect, searchInput) {
  if (statusSelect) statusSelect.value = logsFilterStatus;
  if (searchInput) searchInput.value = logsFilterQ;

  var dateItems = leftList.querySelectorAll('.log-date-item');
  for (var di = 0; di < dateItems.length; di++) {
    dateItems[di].classList.toggle('log-date-selected', dateItems[di].dataset.date === logsDate);
  }

  if (!logsDate) return;
  if (midList) {
    midList.innerHTML = '';
    for (var li = 0; li < logsAllLines.length; li++) {
      logsRenderIndexRow(midList, logsAllLines[li]);
    }
    if (logsAllLines.length === 0 && logsTotal === 0) {
      logsLoadIndex(midList, loadMoreBtn);
    } else if (logsAllLines.length === 0) {
      midList.innerHTML = emptyState(t('logNoRequests'));
    }
  }
  if (loadMoreBtn) loadMoreBtn.style.display = (logsAllLines.length < logsTotal) ? '' : 'none';

  var selectedID = logsSelectedReq && logsSelectedReq.reqID;
  if (!selectedID) return;
  var selectedIndex = null;
  for (var si = 0; si < logsAllLines.length; si++) {
    if (logsAllLines[si].reqID === selectedID) selectedIndex = logsAllLines[si];
  }
  var rows = midList ? midList.querySelectorAll('.log-index-row') : [];
  for (var ri = 0; ri < rows.length; ri++) {
    rows[ri].classList.toggle('log-row-selected', rows[ri].dataset.reqId === selectedID);
  }
  var detail = document.getElementById('log-detail');
  if (detail) logsRenderDetail(detail, logsSelectedReq, selectedIndex);
}

// ===================== select date =====================

function logsSelectDate(date, listEl) {
  logsDate = date;
  logsOffset = 0;
  logsAllLines = [];
  logsSelectedReq = null;
  logsFilterStatus = '';
  logsFilterQ = '';

  // Highlight selected date
  var items = listEl.querySelectorAll('.log-date-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('log-date-selected', items[i].dataset.date === date);
  }

  // Reset filter controls
  var statusSelect = document.getElementById('log-filter-status');
  var searchInput = document.getElementById('log-filter-q');
  if (statusSelect) statusSelect.value = '';
  if (searchInput) searchInput.value = '';

  // Load index
  var midList = document.getElementById('log-requests-list');
  var loadMoreBtn = document.getElementById('log-load-more');
  if (midList) midList.innerHTML = '';
  if (loadMoreBtn) loadMoreBtn.style.display = 'none';
  logsLoadIndex(midList, loadMoreBtn);

  // Clear detail
  var detail = document.getElementById('log-detail');
  if (detail) detail.innerHTML = '';
}

// ===================== load index =====================

function logsLoadIndex(listEl, loadMoreBtn) {
  if (!logsDate) return;
  logsAbortFetch();
  logsAbort = new AbortController();

  var params = new URLSearchParams();
  params.set('date', logsDate);
  params.set('limit', String(logsLimit));
  params.set('offset', String(logsOffset));
  if (logsFilterStatus) params.set('status', logsFilterStatus);
  if (logsFilterQ) params.set('q', logsFilterQ);

  if (listEl) listEl.innerHTML = '<div class="log-loading">' + t('logLoading') + '</div>';
  if (loadMoreBtn) loadMoreBtn.style.display = 'none';

  apiGet('/traces/index?' + params.toString(), logsAbort.signal).then(function(data) {
    logsAbort = null;
    if (!data || data.error) {
      if (listEl) listEl.innerHTML = emptyState(t('logIndexError'));
      return;
    }
    var lines = data.lines || [];
    logsTotal = data.total || 0;

    if (logsOffset === 0) {
      logsAllLines = lines;
    } else {
      // Append for pagination
      logsAllLines = logsAllLines.concat(lines);
    }

    if (listEl) {
      listEl.innerHTML = '';
      if (logsAllLines.length === 0) {
        listEl.innerHTML = emptyState(t('logNoRequests'));
      } else {
        for (var i = 0; i < logsAllLines.length; i++) {
          logsRenderIndexRow(listEl, logsAllLines[i]);
        }
      }
    }

    if (loadMoreBtn) {
      loadMoreBtn.style.display = (logsAllLines.length < logsTotal) ? '' : 'none';
    }
  }).catch(function(err) {
    logsAbort = null;
    if (err.name === 'AbortError') return;
    if (listEl) listEl.innerHTML = emptyState(t('logIndexError'));
  });
}

// ===================== render index row =====================

function logsRenderIndexRow(container, line) {
  var row = document.createElement('div');
  row.className = 'log-index-row';
  row.dataset.reqId = line.reqID;

  // Timestamp
  var tsSpan = document.createElement('span');
  tsSpan.className = 'log-ts';
  tsSpan.textContent = logsFormatTs(line.ts);
  row.appendChild(tsSpan);

  // Status badge
  var badge = document.createElement('span');
  badge.className = 'badge ' + (line.status === 'success' ? 'badge-active' : 'badge-locked');
  badge.textContent = line.status === 'success' ? t('logSuccess') : t('logError');
  row.appendChild(badge);

  // Model
  var modelSpan = document.createElement('span');
  modelSpan.className = 'log-model';
  modelSpan.textContent = line.model || '\u2014';
  row.appendChild(modelSpan);

  // Provider
  var provSpan = document.createElement('span');
  provSpan.className = 'log-provider muted';
  provSpan.textContent = line.provider || '';
  row.appendChild(provSpan);

  // Latency
  var latSpan = document.createElement('span');
  latSpan.className = 'log-latency';
  latSpan.textContent = (line.latencyMs != null ? line.latencyMs + 'ms' : '');
  row.appendChild(latSpan);

  // Attempts
  if (line.attempts && line.attempts > 1) {
    var attSpan = document.createElement('span');
    attSpan.className = 'log-attempts';
    attSpan.textContent = '\u00D7' + line.attempts;
    row.appendChild(attSpan);
  }

  // Provenance (small/muted)
  if (line.provenance) {
    var prov2 = document.createElement('span');
    prov2.className = 'log-provenance muted';
    prov2.textContent = line.provenance;
    row.appendChild(prov2);
  }

  // Error snippet (if error status)
  if (line.status === 'error' && line.error) {
    var errSpan = document.createElement('span');
    errSpan.className = 'log-error-snippet muted';
    errSpan.textContent = logsTruncate(line.error, 80);
    errSpan.title = line.error;
    row.appendChild(errSpan);
  }

  row.addEventListener('click', function() {
    logsSelectRequest(line.reqID, container);
  });

  container.appendChild(row);
}

// ===================== select request =====================

function logsSelectRequest(reqID, listEl) {
  logsSelectedReq = null;
  var detail = document.getElementById('log-detail');
  if (detail) detail.innerHTML = '<div class="log-loading">' + t('logLoading') + '</div>';
  // Highlight selected row
  if (listEl) {
    var rows = listEl.querySelectorAll('.log-index-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('log-row-selected', rows[i].dataset.reqId === reqID);
    }
  }
  // Look up the index line (last-write-wins) for the header summary fields.
  var indexLine = null;
  for (var i = 0; i < logsAllLines.length; i++) {
    if (logsAllLines[i].reqID === reqID) indexLine = logsAllLines[i];
  }
  logsAbortFetch();
  logsAbort = new AbortController();
  apiGet('/traces/req/' + encodeURIComponent(reqID), logsAbort.signal).then(function(data) {
    logsAbort = null;
    if (!data || data.error) {
      if (detail) detail.innerHTML = emptyState(t('logReqNotFound'));
      return;
    }
    logsSelectedReq = data;
    logsRenderDetail(detail, data, indexLine);
  }).catch(function(err) {
    logsAbort = null;
    if (err.name === 'AbortError') return;
    if (detail) detail.innerHTML = emptyState(t('logReqNotFound'));
  });
}

// ===================== render detail =====================

function logsRenderDetail(container, data, indexLine) {
  container.innerHTML = '';

  // Header summary comes from the index line (session/status/latency/attempts
  // live only in the index file, not in the per-request detail file).
  var ix = indexLine || {};

  var header = document.createElement('div');
  header.className = 'log-detail-header';

  var reqIDTitle = document.createElement('h3');
  reqIDTitle.textContent = data.reqID || ix.reqID || '';
  header.appendChild(reqIDTitle);

  var infoGrid = document.createElement('div');
  infoGrid.className = 'log-detail-grid';

  var fields = [
    { label: t('logSession'), value: ix.session || '\u2014' },
    { label: t('logProvenance'), value: ix.provenance || '\u2014' },
    { label: t('logSource'), value: ix.source || '\u2014' },
    { label: t('logModel'), value: ix.model || '\u2014' },
    { label: t('logOriginalModel'), value: ix.originalModel || '\u2014' },
    { label: t('logProvider'), value: ix.provider || '\u2014' },
    { label: t('logStatus'), value: ix.status || '\u2014' },
    { label: t('logLatency'), value: (ix.latencyMs != null ? ix.latencyMs + 'ms' : '\u2014') },
    { label: t('logAttempts'), value: (ix.attempts != null ? ix.attempts : '\u2014') }
  ];

  for (var i = 0; i < fields.length; i++) {
    var item = document.createElement('div');
    item.className = 'log-detail-field';
    var label = document.createElement('span');
    label.className = 'log-detail-label muted';
    label.textContent = fields[i].label + ':';
    var value = document.createElement('span');
    value.className = 'log-detail-value';
    value.textContent = fields[i].value;
    item.appendChild(label);
    item.appendChild(value);
    infoGrid.appendChild(item);
  }

  header.appendChild(infoGrid);
  container.appendChild(header);

  // Request line: reqHeaders + reqBody live in the per-request detail file's
  // "request" line, not at the top level of the API response.
  var lines = data.lines || [];
  var reqLine = null;
  for (var ri = 0; ri < lines.length; ri++) {
    if (lines[ri].type === 'request') { reqLine = lines[ri]; break; }
  }

  var reqSection = document.createElement('div');
  reqSection.className = 'log-detail-section';

  var reqHeading = document.createElement('h4');
  reqHeading.textContent = t('logRequest');
  reqSection.appendChild(reqHeading);

  if (reqLine) {
    if (reqLine.reqHeaders && Object.keys(reqLine.reqHeaders).length > 0) {
      var headersPre = document.createElement('pre');
      headersPre.className = 'code';
      var headerLines = [];
      var keys = Object.keys(reqLine.reqHeaders);
      for (var hi = 0; hi < keys.length; hi++) {
        var key = keys[hi];
        var vals = reqLine.reqHeaders[key];
        headerLines.push(key + ': ' + (Array.isArray(vals) ? vals.join(', ') : vals));
      }
      headersPre.textContent = headerLines.join('\n');
      reqSection.appendChild(headersPre);
    }
    if (reqLine.reqBody != null) {
      var bodyPre = document.createElement('pre');
      bodyPre.className = 'code';
      bodyPre.textContent = logsFormatBody(reqLine.reqBody);
      reqSection.appendChild(bodyPre);
    }
  } else {
    var emptyReq = document.createElement('div');
    emptyReq.className = 'muted';
    emptyReq.style.fontSize = 'var(--font-badge)';
    emptyReq.textContent = t('logReqNotFound') || '(no request data)';
    reqSection.appendChild(emptyReq);
  }

  container.appendChild(reqSection);

  // Attempts timeline
  for (var ai = 0; ai < lines.length; ai++) {
    var attempt = lines[ai];
    if (attempt.type !== 'attempt') continue;
    logsRenderAttemptCard(container, attempt);
  }
}

// ===================== render attempt card =====================

function logsRenderAttemptCard(container, attempt) {
  var card = document.createElement('div');
  card.className = 'attempt-card' + (attempt.respStatus >= 400 || attempt.error ? ' attempt-error' : ' attempt-success');

  // Badge + status
  var cardHeader = document.createElement('div');
  cardHeader.className = 'attempt-card-header';

  var badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = t('logAttempt') + ' ' + (attempt.n != null ? attempt.n : '?');
  cardHeader.appendChild(badge);

  var statusBadge = document.createElement('span');
  statusBadge.className = 'badge ' + (attempt.respStatus < 400 && !attempt.error ? 'badge-active' : 'badge-locked');
  statusBadge.textContent = (attempt.respStatus ? attempt.respStatus : '') + (attempt.error ? ' \u2014 ' + t('logError') : '');
  cardHeader.appendChild(statusBadge);

  // Decision (prominent)
  if (attempt.decision) {
    var decisionSpan = document.createElement('span');
    decisionSpan.className = 'attempt-decision';
    decisionSpan.textContent = t('logDecision') + ': ' + attempt.decision;
    cardHeader.appendChild(decisionSpan);
  }

  card.appendChild(cardHeader);

  // Key / keyName
  var keyInfo = document.createElement('div');
  keyInfo.className = 'attempt-meta';
  var keyText = attempt.key || attempt.keyName || '\u2014';
  keyInfo.innerHTML = '<span class="muted">' + t('logKey') + ':</span> ' + logsEscapeHtml(keyText);
  if (attempt.latencyMs != null) {
    keyInfo.innerHTML += ' <span class="muted">| ' + t('logLatency') + ': ' + attempt.latencyMs + 'ms</span>';
  }
  if (attempt.ttftMs != null) {
    keyInfo.innerHTML += ' <span class="muted">| ' + t('logTTFT') + ': ' + attempt.ttftMs + 'ms</span>';
  }
  card.appendChild(keyInfo);

  // Error (if any)
  if (attempt.error) {
    var errDiv = document.createElement('div');
    errDiv.className = 'attempt-error-msg';
    errDiv.textContent = attempt.error;
    card.appendChild(errDiv);
  }

  // collapsible respHeaders + respBody
  var details = document.createElement('details');
  details.className = 'attempt-details';

  var summary = document.createElement('summary');
  summary.textContent = t('logResponseDetails');
  details.appendChild(summary);

  // respHeaders
  if (attempt.respHeaders && Object.keys(attempt.respHeaders).length > 0) {
    var respHeadersPre = document.createElement('pre');
    respHeadersPre.className = 'code';
    var rheaderLines = [];
    var rkeys = Object.keys(attempt.respHeaders);
    for (var ri = 0; ri < rkeys.length; ri++) {
      var rkey = rkeys[ri];
      var rvals = attempt.respHeaders[rkey];
      rheaderLines.push(rkey + ': ' + (Array.isArray(rvals) ? rvals.join(', ') : rvals));
    }
    respHeadersPre.textContent = rheaderLines.join('\n');
    details.appendChild(respHeadersPre);
  }

  // respBody
  if (attempt.respBody != null) {
    var respBodyPre = document.createElement('pre');
    respBodyPre.className = 'code';
    respBodyPre.textContent = logsFormatBody(attempt.respBody);
    details.appendChild(respBodyPre);
  }

  card.appendChild(details);
  container.appendChild(card);
}
