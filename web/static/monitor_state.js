// ===== State variables and constants =====

var lastUsageEntries = [];

var modelColorMap = {};
var expandedModels = new Set();
var lockCountdownTimerStarted = false;
var lockCountdownInterval = null;
var quotaBarItems = {};
var keyDetailCache = {};          // key "provider/model" -> { data, ts }
var KEY_DETAIL_TTL = 3000;         // reuse _lastPerKeyRefresh throttle window
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

function formatCompactTokens(n) {
  var v = Number(n || 0);
  if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return String(v);
}

// --- Quota refresh with debounce ---
var _quotaRefreshTimer = null;

var QUOTA_CHEVRON = '<svg class="quota-bar-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

// isMultiKeyProvider returns true when the provider has more than one key
// configured. providersCache is populated by renderUsage; when not yet ready
// we default to true so the chevron is not hidden on first paint.
function isMultiKeyProvider(providerName) {
  if (!providersCache) return true;
  for (var i = 0; i < providersCache.length; i++) {
    if (providersCache[i].name === providerName || providersCache[i].Name === providerName) {
      var keys = providersCache[i].keys || providersCache[i].Keys || [];
      return keys.length > 1;
    }
  }
  return true;
}

function formatAvgSpeed(k) {
  if (k.inFlight && k.inFlight > 0 && k.liveSpeed != null && k.liveSpeed > 0) {
    return '<span class="model-key-metric metric-live">' + k.liveSpeed.toFixed(1) + ' tok/s</span>';
  }
  if (k.avgSpeed != null && k.avgSpeed > 0) {
    return '<span class="model-key-metric">' + k.avgSpeed.toFixed(1) + ' tok/s</span>';
  }
  return '—';
}

function formatAvgLatency(k) {
  if (k.avgTtftMs != null && k.avgTtftMs > 0) return formatLatency(k.avgTtftMs);
  return '—';
}

// findActiveKey resolves the key the rotation strategy would pick next,
// mirroring currentKeyId/inUseKeyID. Returns null when none.
function findActiveKey(data, bar) {
  if (!data || !data.keys) return null;
  for (var i = 0; i < data.keys.length; i++) {
    var k = data.keys[i];
    if (k.isActive && k.status === 'active' && !k.modelLock) {
      if ((data.inUseKeyID && k.keyId === data.inUseKeyID) ||
          (!data.inUseKeyID && data.inUseKeyName && k.keyName === data.inUseKeyName)) {
        return k;
      }
    }
  }
  // fall back to matching bar.currentKeyId / currentKeyName
  if (bar) {
    for (var j = 0; j < data.keys.length; j++) {
      var kk = data.keys[j];
      if ((bar.currentKeyId && kk.keyId === bar.currentKeyId) ||
          (!bar.currentKeyId && bar.currentKeyName && kk.keyName === bar.currentKeyName)) {
        return kk;
      }
    }
  }
  return null;
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