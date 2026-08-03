// editor_textreview_state.js — AI Text Review page state + sessionStorage persistence.
// Mirrors editor-state.js style: top-level 'use strict' + var/function.
//
// Only the lightweight fields are persisted to sessionStorage (key 'tr-session'):
// sessionId, step, fileName, selectedPatternKey, systemPrompt, lineDecisions,
// and chapters META (title + content/cleaned length stubs, NOT full content).
// rawText + full chapter content/cleaned are kept in memory only — never
// persisted — to avoid the 5MB sessionStorage blowup on large novels.
// sessionStorage ensures refresh keeps progress but process restart clears state.

'use strict';

var TR_STORE_KEY = 'tr-session';

// In-memory page state. rawText and chapters[*].content/.cleaned live here
// only; they are NOT written to localStorage.
var trState = {
  sessionId: null,          // backend session id (Step3+); null until created
  step: 1,                  // current wizard step (1..4)
  fileName: '',             // imported file name (Step1)
  encoding: 'UTF-8',         // encoding stub (Step1; backend open is UTF-8)
  rawText: '',              // imported raw text (in-memory only, NOT persisted)
  chapters: [],             // split chapters [{title, content, cleaned?, isVolume?}] (in-memory)
  splitPatterns: [],        // merged pattern list (backend + TR.DEFAULT_SPLIT_PATTERNS), runtime form
  selectedPatternKey: 'zhang', // currently selected pattern key
  customRegex: '',           // custom regex source (when selectedPatternKey === 'custom')
  titleTemplate: '',         // chapter title template (e.g. "第{0n}章 {title}")
  keepPrologue: true,        // keep opening un-titled text as a prologue chapter
  systemPrompt: '',         // cleanup system prompt (fetched from backend default, editable in Step3)
  autoRetry: true,          // auto-retry failed chapters on node exhaustion (Step3)
  lineDecisions: {},         // {chapterIdx: {rowIdx: {action, content?}}} Step4 decisions (persisted)
  reviewNodes: [],           // node pool (fetched in Step3; in-memory)
  promptCollapsed: true,      // system prompt section collapsed state (Step3)
  rangeStart: 0,             // chapter range: 1-based start chapter number (0 = from beginning / all)
  rangeEnd: 0,               // chapter range: 1-based end chapter number (0 = to end / all)
  _loaded: false             // guard: trLoad() ran at least once
};

// Fields persisted to localStorage. chapters is stored as a META stub:
var TR_PERSIST_FIELDS = [
  'sessionId', 'step', 'fileName', 'selectedPatternKey', 'customRegex',
  'titleTemplate', 'keepPrologue', 'systemPrompt', 'autoRetry', 'lineDecisions', 'promptCollapsed',
  'rangeStart', 'rangeEnd'
];

/**
 * Build the persistable snapshot: lightweight fields + chapters meta stub.
 * rawText and full chapter content/cleaned are intentionally excluded.
 */
function trBuildSnapshot() {
  var snap = {};
  for (var i = 0; i < TR_PERSIST_FIELDS.length; i++) {
    var k = TR_PERSIST_FIELDS[i];
    snap[k] = trState[k];
  }
  // chapters meta: titles + length stubs only (no full content)
  snap.chaptersMeta = (trState.chapters || []).map(function (c) {
    return {
      title: c.title || '',
      isVolume: !!c.isVolume,
      contentLen: (typeof c.content === 'string' ? c.content.length : 0),
      cleanedLen: (typeof c.cleaned === 'string' ? c.cleaned.length : 0)
    };
  });
  return snap;
}

/**
 * Load persisted state from localStorage into trState (in-memory fields like
 * rawText / chapters content are left untouched — caller manages those).
 * Returns the snapshot or null.
 */
function trLoad() {
  trState._loaded = true;
  var raw = null;
  try {
    raw = sessionStorage.getItem(TR_STORE_KEY);
  } catch (e) {
    return null;
  }
  if (!raw) return null;
  var snap = null;
  try {
    snap = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!snap || typeof snap !== 'object') return null;
  for (var i = 0; i < TR_PERSIST_FIELDS.length; i++) {
    var k = TR_PERSIST_FIELDS[i];
    if (snap[k] !== undefined && snap[k] !== null) {
      trState[k] = snap[k];
    }
  }
  // chaptersMeta is informational only; we do NOT reconstruct chapters content
  // from sessionStorage. The caller (editor_textreview.js) will re-split from rawText
  // if present, or prompt the user to re-import.
  return snap;
}

/**
 * Persist the lightweight snapshot to sessionStorage. Safe to call even when
 * rawText/chapters are large — only meta is written.
 */
function trSave() {
  var snap = trBuildSnapshot();
  try {
    sessionStorage.setItem(TR_STORE_KEY, JSON.stringify(snap));
  } catch (e) {
    // Quota exceeded or storage disabled — non-fatal; state is in-memory.
    if (typeof toast === 'function') {
      toast(trT('trSaveFailed'), 'warning');
    }
  }
}

/**
 * Clear persisted state (e.g. on "new session"). In-memory state is reset to
 * defaults by the caller.
 */
function trClearPersisted() {
  try {
    sessionStorage.removeItem(TR_STORE_KEY);
  } catch (e) {
    // non-fatal
  }
}

/**
 * Reset trState to defaults (keeps the reference identity for any holders).
 * Does NOT touch localStorage; pair with trClearPersisted() when appropriate.
 */
function trResetState() {
  trState.sessionId = null;
  trState.step = 1;
  trState.fileName = '';
  trState.encoding = 'UTF-8';
  trState.rawText = '';
  trState.chapters = [];
  trState.splitPatterns = [];
  trState.selectedPatternKey = 'zhang';
  trState.customRegex = '';
  trState.titleTemplate = '';
  trState.keepPrologue = true;
  trState.systemPrompt = '';
  trState.autoRetry = true;
  trState.lineDecisions = {};
  trState.reviewNodes = [];
  trState.rangeStart = 0;
  trState.rangeEnd = 0;
}

// ===================== exported API =====================

window.TR_STATE = {
  storeKey: TR_STORE_KEY,
  buildSnapshot: trBuildSnapshot,
  load: trLoad,
  save: trSave,
  clearPersisted: trClearPersisted,
  resetState: trResetState
};
