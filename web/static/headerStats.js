// headerStats.js —— 顶部 header 的 stat-grid 实时统计模块
var headerStatsEventSource = null;
var headerStatsRefreshScheduled = false;
var headerStatsReconnectTimer = null;
var headerStatsReconnectDelay = 1000;

function applyHeaderStatLabels() {
  var labels = ['totalRequests', 'success', 'errors', 'avgLatency', 'totalInput', 'totalOutput'];
  var labelEls = document.querySelectorAll('#header-stat-grid .stat-label');
  for (var i = 0; i < labelEls.length && i < labels.length; i++) {
    labelEls[i].textContent = t(labels[i]);
  }
}

function initHeaderStats() {
  applyHeaderStatLabels();
  refreshHeaderStats();
  startHeaderStatsSSE();
}

async function refreshHeaderStats() {
  try {
    var summary = await apiGet('/monitor/summary');
    if (!summary || summary.error) return;
    var cards = document.querySelectorAll('#header-stat-grid .stat-value');
    if (cards.length >= 6) {
      cards[0].textContent = summary.total;
      cards[1].textContent = summary.success;
      cards[2].textContent = summary.error;
      cards[3].textContent = (typeof formatLatency === 'function') ? formatLatency(summary.avgLatencyMs) : (summary.avgLatencyMs / 1000).toFixed(1) + 's';
      cards[4].textContent = formatMillionTokens(summary.totalInputTokens);
      cards[5].textContent = formatMillionTokens(summary.totalOutputTokens);
    }
  } catch(e) {}
}

function scheduleHeaderStatsReconnect() {
  if (headerStatsReconnectTimer) return;
  var jitter = 0.8 + Math.random() * 0.4;
  var delay = Math.round(headerStatsReconnectDelay * jitter);
  headerStatsReconnectTimer = setTimeout(function() {
    headerStatsReconnectTimer = null;
    startHeaderStatsSSE();
    headerStatsReconnectDelay = Math.min(headerStatsReconnectDelay * 2, 30000);
  }, delay);
}

function startHeaderStatsSSE() {
  if (headerStatsReconnectTimer) {
    clearTimeout(headerStatsReconnectTimer);
    headerStatsReconnectTimer = null;
  }
  if (headerStatsEventSource) {
    try { headerStatsEventSource.close(); } catch(e) {}
    headerStatsEventSource = null;
  }
  if (typeof EventSource === 'undefined') return;
  var es = new EventSource('/api/monitor/events');
  headerStatsEventSource = es;
  es.onopen = function() {
    headerStatsReconnectDelay = 1000;
    if (headerStatsReconnectTimer) {
      clearTimeout(headerStatsReconnectTimer);
      headerStatsReconnectTimer = null;
    }
  };
  es.onerror = function() {
    try { es.close(); } catch(e) {}
    if (headerStatsEventSource === es) headerStatsEventSource = null;
    if (!headerStatsReconnectTimer) scheduleHeaderStatsReconnect();
  };
  es.onmessage = function(ev) {
    try {
      var data = JSON.parse(ev.data);
      if (data.type === 'usage-updated' || data.type === 'key-inflight') {
        scheduleHeaderStatsRefresh();
      }
    } catch(e) {}
  };
}

window.addEventListener('beforeunload', stopHeaderStatsSSE);

function stopHeaderStatsSSE() {
  if (headerStatsReconnectTimer) {
    clearTimeout(headerStatsReconnectTimer);
    headerStatsReconnectTimer = null;
  }
  if (headerStatsEventSource) {
    try { headerStatsEventSource.close(); } catch(e) {}
    headerStatsEventSource = null;
  }
}

function scheduleHeaderStatsRefresh() {
  if (headerStatsRefreshScheduled) return;
  headerStatsRefreshScheduled = true;
  setTimeout(function() {
    headerStatsRefreshScheduled = false;
    refreshHeaderStats();
  }, 300);
}