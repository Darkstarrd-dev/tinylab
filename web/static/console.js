// ===================== Console Page =====================

var consoleEventSource = null;
var consoleFilters = { error: true, warn: true, info: true, debug: true };
var consoleSearchQuery = '';
var consoleAutoScroll = true;
var consoleAllLines = [];
var consoleSubView = 'logs';

async function buildConsoleInto(c) {
  consoleAllLines = [];
  consoleAutoScroll = true;
  consoleSubView = 'logs';


  c.innerHTML =
    '<div class="console-layout">' +
      '<div class="console-toolbar">' +
        '<div class="console-controls">' +
          '<button type="button" class="btn btn-sm btn-filter active" data-level="all" onclick="toggleConsoleFilter(this,\'all\')">' + t('all') + '</button>' +
          '<button type="button" class="btn btn-sm btn-filter active" data-level="error" onclick="toggleConsoleFilter(this,\'error\')">ERROR</button>' +
          '<button type="button" class="btn btn-sm btn-filter active" data-level="warn" onclick="toggleConsoleFilter(this,\'warn\')">WARN</button>' +
          '<button type="button" class="btn btn-sm btn-filter active" data-level="info" onclick="toggleConsoleFilter(this,\'info\')">INFO</button>' +
          '<button type="button" class="btn btn-sm btn-filter active" data-level="debug" onclick="toggleConsoleFilter(this,\'debug\')">DEBUG</button>' +
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
}

// ===================== View switching (toggle) =====================



function switchConsoleTab(tab) {
  // Cleanup previous tab (if any)
  // Stop log SSE if leaving logs
  if (consoleSubView === 'logs' && tab !== 'logs') {
    if (consoleEventSource) { consoleEventSource.close(); consoleEventSource = null; }
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
}

function startConsoleStream() {
  if (consoleEventSource) consoleEventSource.close();
  var container = document.getElementById('log-container');
  var status = document.getElementById('console-status');

  // Don't fetch existing lines via REST here: the SSE stream below already
  // sends the backlog before live updates (see console_logs.go streamConsoleLogs
  // L33-38 "Send existing lines first"). Fetching both caused every existing
  // line (including startup messages already in the buffer) to be rendered
  // twice. Removing the REST call eliminates the duplication.

  consoleEventSource = new EventSource('/api/console-logs/stream');
  consoleEventSource.onopen = function() { status.textContent = t('connected'); };
  consoleEventSource.onerror = function() { status.textContent = t('disconnected'); };
  consoleEventSource.onmessage = function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'line' && msg.line) {
        appendLogLine(container, msg.line);
      }
    } catch (err) {}
  };
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
  div.textContent = line;
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
    container.appendChild(createLogLineDiv(line));
    if (consoleAutoScroll) container.scrollTop = container.scrollHeight;
  }
}

function renderConsoleLogs() {
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
  var c = document.getElementById('log-container');
  if (c) c.innerHTML = '';
  toast(t('consoleCleared'), 'info');
}
