// ===================== Console Page =====================

var consoleEventSource = null;
var consoleFilters = { error: true, warn: true, info: true, debug: true };
var consoleSearchQuery = '';
var consoleAutoScroll = true;
var consoleAllLines = [];
var consoleSubView = 'logs';
var consolePendingLines = [];
var consoleFlushTimer = null;
var consoleRelativeTimer = null;
var CONSOLE_FLUSH_INTERVAL = 100;
var CONSOLE_MAX_BATCH = 50;

var ICON_LOG_ALL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
var ICON_LOG_ERROR = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
var ICON_LOG_WARN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
var ICON_LOG_INFO = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
var ICON_LOG_DEBUG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4M16 2v4M12 4v4M9 13a3 3 0 0 0 6 0M4 11h3M17 11h3M5 18l2.5-2.5M19 18l-2.5-2.5"/><rect x="6" y="8" width="12" height="12" rx="6"/></svg>';

async function buildConsoleInto(c) {
  consoleAllLines = [];
  consoleAutoScroll = true;
  consoleSubView = 'logs';


  c.innerHTML =
    '<div class="console-layout">' +
      '<div class="console-toolbar">' +
        '<div class="console-controls">' +
          '<div class="btn-filter-group">' +
            '<button type="button" class="btn btn-sm btn-filter active" data-level="all" onclick="toggleConsoleFilter(this,\'all\')" data-tooltip="' + escapeHtml(t('all')) + '" aria-label="' + escapeHtml(t('all')) + '">' + ICON_LOG_ALL + '</button>' +
            '<button type="button" class="btn btn-sm btn-filter active" data-level="error" onclick="toggleConsoleFilter(this,\'error\')" data-tooltip="ERROR" aria-label="ERROR">' + ICON_LOG_ERROR + '</button>' +
            '<button type="button" class="btn btn-sm btn-filter active" data-level="warn" onclick="toggleConsoleFilter(this,\'warn\')" data-tooltip="WARN" aria-label="WARN">' + ICON_LOG_WARN + '</button>' +
            '<button type="button" class="btn btn-sm btn-filter active" data-level="info" onclick="toggleConsoleFilter(this,\'info\')" data-tooltip="INFO" aria-label="INFO">' + ICON_LOG_INFO + '</button>' +
            '<button type="button" class="btn btn-sm btn-filter active" data-level="debug" onclick="toggleConsoleFilter(this,\'debug\')" data-tooltip="DEBUG" aria-label="DEBUG">' + ICON_LOG_DEBUG + '</button>' +
          '</div>' +
          '<input type="text" id="console-search" class="console-search" placeholder="' + t('searchLogs') + '" oninput="onConsoleSearch(this.value)">' +
        '</div>' +
        '<div class="flex" style="gap:8px">' +
          '<span class="muted" id="console-status">' + t('connecting') + '</span>' +
          '<button type="button" class="btn btn-danger btn-sm" id="console-clear-btn" onclick="clearCurrentView()">' + t('clear') + '</button>' +
        '</div>' +
      '</div>' +
      '<div id="console-subview" style="flex:1;display:flex;flex-direction:column;min-height:0">' +
        buildLogsViewHTML() +
      '</div>' +
    '</div>';

  initLogsView();
  startConsoleStream();
}

function buildLogsViewHTML() {
  return '<div id="console-logs-view" style="flex:1;display:flex;flex-direction:column;min-height:0">' +
      '<div class="log-container" id="log-container"></div>' +
    '</div>';
}

function initLogsView() {
  if (consoleSubView !== 'logs') return;
  var container = document.getElementById('log-container');
  if (!container) return;
  container.addEventListener('scroll', function() {
    var atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
    consoleAutoScroll = atBottom;
  });
  if (!consoleRelativeTimer) {
    consoleRelativeTimer = setInterval(refreshConsoleRelativeTimes, 30000);
  }
}

// ===================== View switching (toggle) =====================



function switchConsoleTab(tab) {
  // Cleanup previous tab (if any)
  // Stop log SSE if leaving logs
  if (consoleSubView === 'logs' && tab !== 'logs') {
    if (consoleEventSource) { consoleEventSource.close(); consoleEventSource = null; }
    if (consoleRelativeTimer) {
      clearInterval(consoleRelativeTimer);
      consoleRelativeTimer = null;
    }
    var status = document.getElementById('console-status');
    if (status) status.textContent = '';
  }

  consoleSubView = tab;


  // Show/hide search box (hide when not in logs mode to save space, but keep visible per user request)
  // Per user: search box stays visible. Leave it as-is.

  var subviewContainer = document.getElementById('console-subview');
  if (!subviewContainer) return;

  if (tab === 'logs') {
    subviewContainer.innerHTML = buildLogsViewHTML();
    initLogsView();
    startConsoleStream();
    var st = document.getElementById('console-status');
    if (st) st.textContent = t('connecting');
  }
}

// ===================== Clear (delegates to current view) =====================

function clearCurrentView() {
  if (consoleSubView === 'logs') {
    clearConsole();
  }
}

// ===================== Log streaming =====================

function closeConsoleStream() {
  if (consoleEventSource) {
    consoleEventSource.close();
    consoleEventSource = null;
  }
  if (consoleReconnectTimer) {
    clearTimeout(consoleReconnectTimer);
    consoleReconnectTimer = null;
  }
}

var consoleReconnectTimer = null;
var consoleReconnectDelay = 1000;

function scheduleConsoleReconnect() {
  if (consoleReconnectTimer) return;
  if (consoleSubView !== 'logs') return;
  // Only reconnect while console logs view is active.
  var jitter = 0.8 + Math.random() * 0.4;
  var delay = Math.round(consoleReconnectDelay * jitter);
  consoleReconnectTimer = setTimeout(function() {
    consoleReconnectTimer = null;
    if (consoleSubView === 'logs') startConsoleStream();
    consoleReconnectDelay = Math.min(consoleReconnectDelay * 2, 30000);
  }, delay);
}

function startConsoleStream() {
  if (consoleReconnectTimer) {
    clearTimeout(consoleReconnectTimer);
    consoleReconnectTimer = null;
  }
  if (consoleEventSource) {
    try { consoleEventSource.close(); } catch(e) {}
    consoleEventSource = null;
  }
  var container = document.getElementById('log-container');
  var status = document.getElementById('console-status');

  // Don't fetch existing lines via REST here: the SSE stream below already
  // sends the backlog before live updates (see console_logs.go streamConsoleLogs
  // L33-38 "Send existing lines first"). Fetching both caused every existing
  // line (including startup messages already in the buffer) to be rendered
  // twice. Removing the REST call eliminates the duplication.

  if (typeof EventSource === 'undefined') {
    if (status) status.textContent = t('disconnected');
    return;
  }
  consoleEventSource = new EventSource('/api/console-logs/stream');
  consoleEventSource.onopen = function() {
    if (status) status.textContent = t('connected');
    consoleReconnectDelay = 1000;
    if (consoleReconnectTimer) {
      clearTimeout(consoleReconnectTimer);
      consoleReconnectTimer = null;
    }
  };
  consoleEventSource.onerror = function() {
    if (status) status.textContent = t('disconnected');
    try { consoleEventSource.close(); } catch(e) {}
    consoleEventSource = null;
    if (consoleSubView === 'logs' && !consoleReconnectTimer) scheduleConsoleReconnect();
  };
  consoleEventSource.onmessage = function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'line' && msg.line) {
        appendLogLine(container, msg.line);
      }
    } catch (err) {}
  };
}

var LOG_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s?(.*)$/;

function parseLogTimestamp(line) {
  var m = LOG_TIMESTAMP_RE.exec(line);
  if (!m) return null;
  return { time: m[1], rest: m[2] };
}

function logTimestampMs(timeStr) {
  return new Date(timeStr.replace(' ', 'T')).getTime();
}

function formatRelativeTime(tsMs) {
  var diff = Date.now() - tsMs;
  if (diff < 0) diff = 0;
  if (diff < 5000) return '刚刚';
  if (diff < 60000) return Math.floor(diff / 1000) + 's前';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h前';
  return Math.floor(diff / 86400000) + 'd前';
}

function refreshConsoleRelativeTimes() {
  var container = document.getElementById('log-container');
  if (!container) return;
  var lines = container.querySelectorAll('.log-line[data-ts]');
  for (var i = 0; i < lines.length; i++) {
    var rel = lines[i].querySelector('.log-relative');
    var ts = lines[i].getAttribute('data-ts');
    if (rel && ts) rel.textContent = formatRelativeTime(Number(ts));
  }
}

var LOG_COPY_FIELD_RE = /model=[^\s]+|reqID=[^\s]+/g;

function appendLogMessageWithCopyFields(msg, text) {
  LOG_COPY_FIELD_RE.lastIndex = 0;
  var last = 0;
  var m;
  while ((m = LOG_COPY_FIELD_RE.exec(text))) {
    if (m.index > last) msg.appendChild(document.createTextNode(text.slice(last, m.index)));
    var span = document.createElement('span');
    span.className = 'log-copy-field';
    span.textContent = m[0];
    span.title = t('copy') + ': ' + m[0];
    span.addEventListener('click', (function(value) {
      return function(e) { e.stopPropagation(); copyToClipboard(value, value); };
    })(m[0]));
    msg.appendChild(span);
    last = m.index + m[0].length;
  }
  if (last < text.length) msg.appendChild(document.createTextNode(text.slice(last)));
}

function getLogLevel(line) {
  if (line.includes('[ERROR]')) return 'error';
  if (line.includes('\u26A0')) return 'warn';
  if (line.includes('[DEBUG]')) return 'debug';
  return 'info';
}

function createLogLineDiv(line) {
  var div = document.createElement('div');
  div.className = 'log-line log-' + getLogLevel(line);

  var parsed = parseLogTimestamp(line);
  var body = parsed ? parsed.rest : line;
  if (parsed) {
    var timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = parsed.time;
    timeSpan.title = parsed.time;
    div.appendChild(timeSpan);
    var relSpan = document.createElement('span');
    relSpan.className = 'log-relative';
    var tsMs = logTimestampMs(parsed.time);
    div.setAttribute('data-ts', String(tsMs));
    relSpan.textContent = formatRelativeTime(tsMs);
    div.appendChild(relSpan);
  }

  var msg = document.createElement('span');
  msg.className = 'log-msg';
  appendLogMessageWithCopyFields(msg, body);
  div.appendChild(msg);

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'log-copy-btn';
  btn.title = t('copy');
  btn.textContent = t('copy');
  btn.addEventListener('click', (function(rawLine, label) {
    return function(e) {
      e.stopPropagation();
      copyToClipboard(rawLine, label);
    };
  })(line, parsed ? parsed.time : ''));
  div.appendChild(btn);

  return div;
}

function shouldShowLogLine(line) {
  var level = getLogLevel(line);
  if (!consoleFilters[level]) return false;
  if (consoleSearchQuery) {
    var q = consoleSearchQuery.toLowerCase();
    if (line.toLowerCase().indexOf(q) < 0) return false;
  }
  return true;
}

function appendLogLine(container, line) {
  consoleAllLines.push(line);
  if (consoleAllLines.length > 10000) {
    consoleAllLines.splice(0, consoleAllLines.length - 8000);
  }
  if (shouldShowLogLine(line)) {
    consolePendingLines.push(line);
    if (consolePendingLines.length >= CONSOLE_MAX_BATCH) {
      flushConsoleLogLines(container);
    } else {
      scheduleConsoleFlush(container);
    }
  }
}

function scheduleConsoleFlush(container) {
  if (consoleFlushTimer) return;
  consoleFlushTimer = setTimeout(function() {
    consoleFlushTimer = null;
    flushConsoleLogLines(container);
  }, CONSOLE_FLUSH_INTERVAL);
}

function flushConsoleLogLines(container) {
  consoleFlushTimer = null;
  if (!consolePendingLines.length) return;
  var target = document.getElementById('log-container') || container;
  if (!target) return;
  var lines = consolePendingLines.splice(0, consolePendingLines.length);
  var fragment = document.createDocumentFragment();
  for (var i = 0; i < lines.length; i++) {
    fragment.appendChild(createLogLineDiv(lines[i]));
  }
  target.appendChild(fragment);
  // 裁剪 DOM：数组有上限，DOM 节点也必须有上限，否则 WebView2 长期运行内存耗尽（OOM 空白页）
  if (target.childElementCount > 8000) {
    var excess = target.childElementCount - 8000;
    for (var j = 0; j < excess; j++) {
      target.removeChild(target.firstElementChild);
    }
  }
  if (consoleAutoScroll) target.scrollTop = target.scrollHeight;
}

function renderConsoleLogs() {
  if (consoleFlushTimer) {
    clearTimeout(consoleFlushTimer);
    consoleFlushTimer = null;
  }
  consolePendingLines = [];
  var container = document.getElementById('log-container');
  if (!container) return;
  container.innerHTML = '';
  var fragment = document.createDocumentFragment();
  consoleAllLines.forEach(function(line) {
    if (shouldShowLogLine(line)) fragment.appendChild(createLogLineDiv(line));
  });
  container.appendChild(fragment);
  if (consoleAutoScroll) container.scrollTop = container.scrollHeight;
}

function toggleConsoleFilter(btn, level) {
  if (level === 'all') {
    consoleFilters = { error: true, warn: true, info: true, debug: true };
  } else {
    consoleFilters[level] = !consoleFilters[level];
  }
  document.querySelectorAll('.btn-filter').forEach(function(b) {
    var lvl = b.dataset.level;
    if (lvl === 'all') {
      b.classList.toggle('active', consoleFilters.error && consoleFilters.warn && consoleFilters.info && consoleFilters.debug);
    } else {
      b.classList.toggle('active', consoleFilters[lvl]);
    }
  });
  renderConsoleLogs();
}

function onConsoleSearch(val) {
  consoleSearchQuery = val;
  renderConsoleLogs();
}

async function clearConsole() {
  await apiDelete('/console-logs');
  consoleAllLines = [];
  if (consoleFlushTimer) {
    clearTimeout(consoleFlushTimer);
    consoleFlushTimer = null;
  }
  consolePendingLines = [];
  var c = document.getElementById('log-container');
  if (c) c.innerHTML = '';
  toast(t('consoleCleared'), 'info');
}
