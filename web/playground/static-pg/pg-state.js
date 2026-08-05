// pg-state.js
function makeWin() {
  return {
    config: JSON.parse(JSON.stringify(PG_DEFAULT_CFG)),
    parameterEnabled: JSON.parse(JSON.stringify(PG_DEFAULT_PARAMS)),
    messages: [],
    streaming: false,
    abortCtrl: null,
    sseEvents: [],
    lastProvider: '',
    lastKey: '',
    debugTab: 'preview',
    debugRequest: '',
    debugPreview: '',
    debugResponse: '',
    debugTimestamp: null,
    debugPreviewTimestamp: null,
    renderTimer: null,
    pendingContent: '',
    pendingReasoning: '',
    pendingSources: [],
    reasoningStartedAt: null,
    reasoningCompletedAt: null,
    image: {
      mode: 'manual', phase: 'empty', draftPrompt: '', submittedPrompt: '',
      activeAssetIndex: -1, generations: [], activeRequestId: '', error: '',
      abortCtrl: null, timer: null
    },
    // Auto chat (group-chat) state
    agentName: '', inbox: [], replyCount: 0, autoChatDone: false,
    autoChatPending: false, autoChatDelayTimer: null, lastReadTimelineId: 0,
  };
}

// Auto chat runtime state (not persisted except userName/iterations/director).
var PG_AUTOCHAT_KEY = 'tinyrouter.playground.autochat.v1';
var PG_SCENARIO_KEY = 'tinyrouter.playground.scenario.v1';
var PG_MODE_KEY = 'tinyrouter.playground.mode.v1';

var PG_IMAGE_KEY = 'tinyrouter.playground.image.v1';
var PG_SEARCH_HISTORY_KEY = 'tinyrouter.playground.search.history.v1';
var PG_SEARCH_ACTIVE_KEY  = 'tinyrouter.playground.search.active.v1';
var PG_SEARCH_MAX_ENTRIES = 50; // Max search history entries in localStorage

var pgState = {
  winInit: false,
  splitCount: 1,
  modeSplitCounts: {
    normal: 1,
    search: 2,
    image: 1,
    autochat: 2
  },
  modeWindows: {
    normal: null,
    search: null,
    image: null,
    autochat: null
  },
  activeWin: 0,
  windows: [],
  models: [],
  mode: 'normal',  // 'normal' | 'autochat' | 'image' | 'search'
  // Auto chat (group-chat) mode
  autoChat: {
    enabled: false,        // auto chat switch (not persisted; off after reload)
    iterations: 10,        // iteration count (0 = infinite)
    userName: 'User',      // user nickname
    delaySeconds: 0,       // random delay base before each reply (0 = no delay)
    isRunning: false,      // loop active
    abortFlag: false,        // termination signal
    session: 0,            // epoch — incremented on start/stop to invalidate stale setTimeout callbacks
    timeline: [],           // shared timeline — single source of truth for group chat
    timelineId: 0,          // auto-increment id counter for timeline entries
    scenario: null,         // current ScenarioProfile (AI-generated setup); in-memory, persisted separately
    director: {             // Phase B: director/narrator config (persisted via pgSaveAutoChat)
      enabled: false,         // director switch
      directorModel: '',      // model for judgment calls (empty = use first window's model)
      narratorModel: '',      // model for narration text (empty = same as directorModel)
      everyNReplies: 6,       // evaluate every N agent replies (complete + pass)
      maxNarrations: 0,       // max narrator injections (0 = infinite)
    },
  },
  search: { maxResults: 5, apiKey: '' },
  // Search history: in-memory list of per-search conversations.
  // Each entry: { id: number, query: string, messages: [...], ts: number }
  // The active search's messages are mirrored into w.messages for rendering.
  // TODO(SQLite): When SQLite persistence is added, store these entries in a
  // "playground_search_history" table with columns (id INTEGER PK, query TEXT,
  // messages JSON, created_at INTEGER). Load on pgLoad(), insert on pgSearchSend().
  searchHistory: [],
  activeSearchId: null,  // id of the currently displayed search conversation
  // ComfyUI protocol runtime state (in-memory; re-fetched on connect)
  comfy: {
    connected: false,
    connecting: false,
    error: '',
    version: '',
    models: {},        // { diffusion_models: [...], text_encoders: [...], vae: [...], checkpoints: [...] }
    samplers: [],      // KSampler sampler_name combo options
    schedulers: [],    // KSampler scheduler combo options
    templates: [],     // [{ prompt_id, title, workflow, workflowId, kind, source, signature }]
  },
};

var pgSearchSavedSplit = 0;
var pgSearchIdCounter = 0;

function pgNextSearchId() { return ++pgSearchIdCounter; }

// Get the search history entry for the active search, or null.
function pgActiveSearch() {
  if (pgState.activeSearchId == null) return null;
  for (var i = 0; i < pgState.searchHistory.length; i++) {
    if (pgState.searchHistory[i].id === pgState.activeSearchId) return pgState.searchHistory[i];
  }
  return null;
}

// Mirror the active search's messages into w.messages for rendering.
// If no active search, clear w.messages.
function pgSyncSearchMessages() {
  var s = pgActiveSearch();
  var msgs = s ? s.messages : [];
  for (var i = 0; i < pgState.windows.length; i++) {
    if (i < 2) {
      pgState.windows[i].messages = msgs;
    }
  }
}

// --- Search history persistence (localStorage) ---

// Serialize a search entry for localStorage (strip non-serializable fields).
function pgSearchEntryToJSON(entry) {
  var msgs = entry.messages.map(function(m) {
    var copy = Object.assign({}, m);
    delete copy.prettyRepairing; // transient flag
    return copy;
  });
  return { id: entry.id, query: entry.query, messages: msgs, ts: entry.ts };
}

// pgSaveSearchHistory — persist searchHistory + activeSearchId to localStorage.
function pgSaveSearchHistory() {
  try {
    var serialized = pgState.searchHistory
      .slice(-PG_SEARCH_MAX_ENTRIES)
      .map(pgSearchEntryToJSON);
    localStorage.setItem(PG_SEARCH_HISTORY_KEY, JSON.stringify(serialized));
  } catch (e) { /* quota exceeded — drop oldest silently next time */ }
  try {
    localStorage.setItem(PG_SEARCH_ACTIVE_KEY, String(pgState.activeSearchId));
  } catch (e) {}
}

// pgLoadSearchHistory — restore searchHistory + activeSearchId from localStorage.
// Called from pgLoad() BEFORE messages are loaded.
function pgLoadSearchHistory() {
  try {
    var raw = localStorage.getItem(PG_SEARCH_HISTORY_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        pgState.searchHistory = parsed;
      }
    }
  } catch (e) {}
  try {
    var rawActive = localStorage.getItem(PG_SEARCH_ACTIVE_KEY);
    if (rawActive) {
      var id = parseInt(rawActive, 10);
      if (!isNaN(id)) pgState.activeSearchId = id;
    }
  } catch (e) {}
}

function pgWin() { return pgState.windows[pgState.activeWin]; }
function pgWinAt(i) { return pgState.windows[i]; }

function pgLoad() {
  if (!pgState.windows.length) pgState.windows.push(makeWin());
  var w = pgState.windows[0];
  try {
    var rawCfg = localStorage.getItem(PG_CFG_KEY);
    if (rawCfg) {
      var savedCfg = JSON.parse(rawCfg);
      if (savedCfg) {
        Object.keys(PG_DEFAULT_CFG).forEach(function(k) {
          if (savedCfg[k] !== undefined) w.config[k] = savedCfg[k];
        });
      }
    }
  } catch (e) { /* corrupt storage */ }
  try {
    var rawParams = localStorage.getItem(PG_PARAM_KEY);
    if (rawParams) {
      var savedParams = JSON.parse(rawParams);
      if (savedParams) {
        Object.keys(PG_DEFAULT_PARAMS).forEach(function(k) {
          if (savedParams[k] !== undefined) w.parameterEnabled[k] = savedParams[k];
        });
      }
    }
  } catch (e) { /* corrupt storage */ }
  // Auto chat persisted fields (userName + iterations + delaySeconds + director).
  try {
    var rawAuto = localStorage.getItem(PG_AUTOCHAT_KEY);
    if (rawAuto) {
      var savedAuto = JSON.parse(rawAuto);
      if (savedAuto && typeof savedAuto === 'object') {
        if (typeof savedAuto.userName === 'string') pgState.autoChat.userName = savedAuto.userName;
        if (typeof savedAuto.iterations === 'number' && savedAuto.iterations >= 0) {
          pgState.autoChat.iterations = savedAuto.iterations;
        }
        if (typeof savedAuto.delaySeconds === 'number' && savedAuto.delaySeconds >= 0) {
          pgState.autoChat.delaySeconds = savedAuto.delaySeconds;
        }
        if (savedAuto.director && typeof savedAuto.director === 'object') {
          var d = savedAuto.director;
          if (typeof d.enabled === 'boolean') pgState.autoChat.director.enabled = d.enabled;
          if (typeof d.directorModel === 'string') pgState.autoChat.director.directorModel = d.directorModel;
          if (typeof d.narratorModel === 'string') pgState.autoChat.director.narratorModel = d.narratorModel;
          if (typeof d.everyNReplies === 'number' && d.everyNReplies > 0) pgState.autoChat.director.everyNReplies = d.everyNReplies;
          if (typeof d.maxNarrations === 'number' && d.maxNarrations >= 0) pgState.autoChat.director.maxNarrations = d.maxNarrations;
        }
      }
    }
  } catch (e) { /* corrupt storage */ }
  pgLoadScenario();
  try {
    var rawMode = localStorage.getItem(PG_MODE_KEY);
    if (rawMode && ['normal', 'autochat', 'image', 'search'].indexOf(rawMode) >= 0) {
      pgState.mode = rawMode;
    }
  } catch (e) { /* corrupt storage */ }
  try {
    var rawImage = localStorage.getItem(PG_IMAGE_KEY);
    if (rawImage) {
      var savedImage = JSON.parse(rawImage);
      if (savedImage && typeof savedImage === 'object') w.image = Object.assign(w.image, savedImage);
    }
  } catch (e) { /* corrupt image history */ }
  // Load search history from localStorage (before messages are loaded)
  pgLoadSearchHistory();
  try {
    var rawMsgs = localStorage.getItem(PG_MSG_KEY);
    if (rawMsgs) {
      // Search mode: messages come from searchHistory, not localStorage.
      // Skip loading to avoid overwriting w.messages reference.
      if (pgState.mode === 'search') {
        pgSyncSearchMessages();
      } else if (rawMsgs.length > PG_MAX_MSGS_BYTES) {
        localStorage.removeItem(PG_MSG_KEY);
      } else {
        var msgs = JSON.parse(rawMsgs);
        if (Array.isArray(msgs)) {
          if (msgs.length > PG_MAX_MSGS) msgs = msgs.slice(-PG_MAX_MSGS);
          var totalSize = 0;
          var trimmedBySize = [];
          for (var mi = msgs.length - 1; mi >= 0; mi--) {
            var mc = pgTextContent(msgs[mi].content || '').length
                   + ((msgs[mi].reasoning || '').length);
            if (trimmedBySize.length > 0 && totalSize + mc > PG_MAX_MSGS_CHARS) break;
            totalSize += mc;
            trimmedBySize.unshift(msgs[mi]);
          }
          trimmedBySize = trimmedBySize.map(function(m) {
            var copy = Object.assign({}, m);
            if (typeof copy.content === 'string' && copy.content.length > PG_MAX_MSG_CHARS) {
              copy.content = copy.content.slice(0, PG_MAX_MSG_CHARS) + '\n\n[...]';
            }
            if (copy.reasoning && copy.reasoning.length > PG_MAX_MSG_CHARS) {
              copy.reasoning = copy.reasoning.slice(0, PG_MAX_MSG_CHARS) + '\n\n[...]';
            }
            return pgNormalizeLoadedMessage(copy);
          });
          w.messages = trimmedBySize;
          if (w.image && Array.isArray(w.image.generations)) {
            var latest = w.image.generations[w.image.generations.length - 1];
            if (latest && latest.status === 'generating') { latest.status = 'canceled'; w.image.phase = 'canceled'; w.image.activeRequestId = ''; }
          }
        }
      }
    } else if (pgState.mode === 'search') {
      // No saved msgs in localStorage (expected for search), sync from searchHistory
      pgSyncSearchMessages();
    }
  } catch (e) { /* corrupt storage */ }
}

function pgEnsureWindows() {
  if (pgState.winInit) return;
  if (!pgState.windows.length) pgState.windows.push(makeWin());
  for (var k = 1; k < 4; k++) {
    var clone = JSON.parse(JSON.stringify(pgState.windows[0]));
    clone.messages = [];
    clone.streaming = false; clone.abortCtrl = null; clone.renderTimer = null;
    clone.pendingContent = ''; clone.pendingReasoning = ''; clone.pendingSources = [];
    clone.reasoningStartedAt = null; clone.reasoningCompletedAt = null;
    clone.sseEvents = []; clone.lastProvider = ''; clone.lastKey = '';
    clone.debugTab = 'preview'; clone.debugRequest = ''; clone.debugResponse = '';
    clone.debugTimestamp = null; clone.debugPreview = ''; clone.debugPreviewTimestamp = null;
    pgState.windows.push(clone);
  }
  pgState.winInit = true;
}

var pgSaveTimer = null;
function pgSave() {
  pgSaveTimer = setTimeout(function() {
    var w = pgState.windows[0];
    try { localStorage.setItem(PG_CFG_KEY, JSON.stringify(w.config)); } catch (e) {}
    try { localStorage.setItem(PG_PARAM_KEY, JSON.stringify(w.parameterEnabled)); } catch (e) {}
    try { localStorage.setItem(PG_IMAGE_KEY, JSON.stringify(w.image || {})); } catch (e) {}
    // In search mode, messages are per-search and in-memory only; don't overwrite normal-mode localStorage.
    if (pgState.mode !== 'search') {
      try {
        var trimmed = w.messages;
        if (trimmed.length > PG_MAX_MSGS) trimmed = trimmed.slice(-PG_MAX_MSGS);
        localStorage.setItem(PG_MSG_KEY, JSON.stringify(trimmed));
      } catch (e) {}
    }
    // Persist search history to localStorage
    if (pgState.mode === 'search' && pgState.searchHistory.length) {
      pgSaveSearchHistory();
    }
    }, 500);
}

function pgSaveMode() {
  try { localStorage.setItem(PG_MODE_KEY, pgState.mode); } catch (e) {}
}

function pgSaveSync() {
  var w = pgState.windows[0];
  if (!w) return;
  try { localStorage.setItem(PG_IMAGE_KEY, JSON.stringify(w.image || {})); } catch (e) {}
  try { localStorage.setItem(PG_CFG_KEY, JSON.stringify(w.config)); } catch (e) {}
  try { localStorage.setItem(PG_PARAM_KEY, JSON.stringify(w.parameterEnabled)); } catch (e) {}
  if (pgState.mode !== 'search') {
    try {
      var trimmed = w.messages;
      if (trimmed.length > PG_MAX_MSGS) trimmed = trimmed.slice(-PG_MAX_MSGS);
      localStorage.setItem(PG_MSG_KEY, JSON.stringify(trimmed));
    } catch (e) {}
  }
  // Persist search history to localStorage
  if (pgState.mode === 'search' && pgState.searchHistory.length) {
    pgSaveSearchHistory();
  }
}

function pgSaveAutoChat() {
  try {
    localStorage.setItem(PG_AUTOCHAT_KEY, JSON.stringify({
      userName: pgState.autoChat.userName,
      iterations: pgState.autoChat.iterations,
      delaySeconds: pgState.autoChat.delaySeconds,
      director: pgState.autoChat.director,
    }));
  } catch (e) {}
}

// Persist the current ScenarioProfile (AI-generated setup) for reuse across reloads.
function pgSaveScenario() {
  try {
    var s = pgState.autoChat.scenario;
    if (s) localStorage.setItem(PG_SCENARIO_KEY, JSON.stringify(s));
    else localStorage.removeItem(PG_SCENARIO_KEY);
  } catch (e) { /* quota or corrupt */ }
}

// Load the most recent ScenarioProfile into memory (called from pgLoad).
function pgLoadScenario() {
  try {
    var raw = localStorage.getItem(PG_SCENARIO_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') pgState.autoChat.scenario = parsed;
    }
  } catch (e) { /* corrupt storage */ }
}

// ----- Module 2: Model list ---------------------------------------
function pgLoadModels() {
  return pgApiGet('/models').then(function(res) {
    pgState.models = (res && res.models) ? res.models : [];
  }).catch(function() {
    pgState.models = [];
  });
}