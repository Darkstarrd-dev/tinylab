// headerStats.js —— 顶部 header 的 stat-grid 实时统计模块
var headerStatsEventSource = null;
var headerStatsRefreshScheduled = false;

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

function startHeaderStatsSSE() {
  stopHeaderStatsSSE();
  if (typeof EventSource === 'undefined') return;
  headerStatsEventSource = new EventSource('/api/monitor/events');
  headerStatsEventSource.onmessage = function(ev) {
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
  if (headerStatsEventSource) {
    headerStatsEventSource.close();
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