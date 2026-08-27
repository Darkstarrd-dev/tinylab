// editor_textreview.js — AI Text Review page entry point + 4-step wizard shell.
// Loaded LAST among the editor_textreview files, after editor_textreview_state.js + step1..4.js.
//
// Exposes window.renderTextReview(container) + window.cleanupTextReview().
// Uses only editor/page globals; every optional host service has a safe fallback.

'use strict';

function trApiGet(p) {
  if (typeof apiGet === 'function') return apiGet(p);
  return fetch('/api' + p).then(function (r) { return r.json(); });
}
function trApiPost(p, b) {
  if (typeof apiPost === 'function') return apiPost(p, b);
  return fetch('/api' + p, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b || {}) }).then(function (r) { return r.json(); });
}
function trApiDelete(p) {
  if (typeof apiDelete === 'function') return apiDelete(p);
  return fetch('/api' + p, { method:'DELETE' }).then(function (r) { return r.json(); });
}
function trEscapeHtml(s) {
  if (typeof escapeHtml === 'function') return escapeHtml(s);
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function trToast(m, ty) { if (typeof toast === 'function') toast(m, ty); }
function trT(k, ar) {
  if (ar !== undefined && !Array.isArray(ar)) ar = [ar];
  return typeof t === 'function' ? t(k, ar) : k;
}

// ===================== universal modal helper =====================

function trShowModal(html) {
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = html;
  overlay.classList.add('show');
}

function trCloseModal() {
  var overlay = document.getElementById('modal-overlay');
  if (overlay) {
    overlay.classList.remove('show');
    overlay.innerHTML = '';
  }
  if (typeof closeModalOverlay === 'function') {
    closeModalOverlay();
  }
}
window.trShowModal = trShowModal;
window.trCloseModal = trCloseModal;

// ===================== page-level refs (cleanup) =====================

var trContainer = null;
var trBootstrapDone = false; // fetch split-patterns + prompt-default once

// ===================== bootstrap: fetch backend config =====================

/**
 * Fetch split-patterns + prompt-default from the backend on first render.
 * Merges backend patterns with TR.DEFAULT_SPLIT_PATTERNS (de-duped by key;
 * backend wins on key collision) and stores the runtime form in trState.
 * Also seeds trState.systemPrompt from the backend default if unset.
 * Idempotent (trBootstrapDone guard).
 */
function trBootstrap() {
  if (trBootstrapDone) return Promise.resolve();
  var patsP = trApiGet('/text-review/split-patterns').then(function (res) {
    if (!res || res.error) throw new Error((res && res.error) || 'Failed to fetch split-patterns');
    var backendPats = Array.isArray(res.patterns) ? res.patterns : [];
    trMergePatterns(backendPats);
  });
  var promptP = trApiGet('/text-review/prompt-default').then(function (res) {
    if (!res || res.error) throw new Error((res && res.error) || 'Failed to fetch prompt-default');
    if (res.builtinPrompt) window.TR_BUILTIN_PROMPT = res.builtinPrompt;
    if (res.systemPrompt) {
      window.TR_DEFAULT_PROMPT = res.systemPrompt;
      if (!trState.systemPrompt) {
        trState.systemPrompt = res.systemPrompt;
      }
    }
  });
  return Promise.all([patsP, promptP]).then(function () {
    trBootstrapDone = true;
    var ta = document.getElementById('tr-s3-prompt');
    if (ta && !ta.value && trState.systemPrompt) {
      ta.value = trState.systemPrompt;
    }
  });
}

/**
 * Merge backend SplitPattern[] (regex strings) with TR.DEFAULT_SPLIT_PATTERNS.
 * Backend wins on key collision; the built-in 'custom' entry is always kept
 * last. Stores runtime form (regex compiled via TR.compilePatterns) in
 * trState.splitPatterns.
 */
function trMergePatterns(backendPats) {
  var byKey = {};
  var order = [];
  function add(p) {
    if (!p || !p.key) return;
    if (!byKey[p.key]) { byKey[p.key] = p; order.push(p.key); }
  }
  // Built-ins first (so backend overrides by key), then backend, then ensure
  // 'custom' is present and last.
  if (window.TR && window.TR.DEFAULT_SPLIT_PATTERNS) {
    window.TR.DEFAULT_SPLIT_PATTERNS.forEach(add);
  }
  backendPats.forEach(add);
  var list = order.map(function (k) { return byKey[k]; });
  // ensure 'custom' exists and is last
  if (!byKey['custom']) {
    list.push({ key: 'custom', label: trT('trPatternCustom'), regex: '', builtin: true });
  } else {
    // move custom to end
    list = list.filter(function (p) { return p.key !== 'custom'; });
    list.push(byKey['custom']);
  }
  trState.splitPatterns = (window.TR && window.TR.compilePatterns) ? window.TR.compilePatterns(list) : list;
}

// ===================== wizard shell =====================

/**
 * Render the 4-step wizard shell (step nav bar + current step panel) into
 * `container`. Loads persisted state, runs backend bootstrap, then renders
 * the current step.
 */
window.renderTextReview = function (container) {
  trContainer = container;
  // Load persisted state (lightweight fields only).
  trLoad();
  if (!trState._loaded) trState._loaded = true;

  container.innerHTML = '';
  container.classList.add('tr-page');

  var shell = document.createElement('div');
  shell.className = 'tr-shell';
  shell.innerHTML =
    '<div class="tr-stepbar" id="tr-stepbar"></div>' +
    '<div class="tr-panel" id="tr-panel"></div>';
  container.appendChild(shell);

  // Render the step bar immediately (non-blocking UX), then bootstrap + render step.
  trRenderStepBar();
  trRenderStep();

  trBootstrap().then(function () {
    // patterns/prompt may have arrived; re-render step bar (custom label i18n)
    // and current step in case Step2 needs the merged patterns.
    trRenderStepBar();
    trRenderStep();
  });
};

window.cleanupTextReview = function () {
  if (typeof window.trCleanupStep3 === 'function') window.trCleanupStep3();
  if (typeof window.trCleanupStep4 === 'function') window.trCleanupStep4();
  // Persist lightweight state so the user's place in the wizard survives.
  trSave();
  trContainer = null;
};

// ===================== step bar =====================

var TR_STEPS = [
  { n: 1, key: 'trStepImport' },
  { n: 2, key: 'trStepSplit' },
  { n: 3, key: 'trStepClean' },
  { n: 4, key: 'trStepReview' }
];

function trRenderStepBar() {
  var bar = document.getElementById('tr-stepbar');
  if (!bar) return;
  var html = '<div class="tr-stepbar-inner">';
  for (var i = 0; i < TR_STEPS.length; i++) {
    var s = TR_STEPS[i];
    var active = (trState.step === s.n) ? ' active' : '';
    var done = (trState.step > s.n) ? ' done' : '';
    var locked = trStepLocked(s.n);
    var cls = 'tr-step' + active + done + (locked ? ' locked' : '');
    html +=
      '<button type="button" class="' + cls + '"' +
        (locked ? ' disabled' : ' onclick="trGotoStep(' + s.n + ')"') +
        ' data-step="' + s.n + '">' +
        '<span class="tr-step-num">' + s.n + '</span>' +
        '<span class="tr-step-label">' + trEscapeHtml(trT(s.key)) + '</span>' +
      '</button>';
    if (i < TR_STEPS.length - 1) {
      html += '<span class="tr-step-sep" aria-hidden="true"></span>';
    }
  }
  html += '</div>';
  html += '<div class="tr-stepbar-actions">' +
    '<button type="button" class="tr-stepbar-clear-btn" id="tr-clear-session-btn" onclick="trHandleClear()" title="' + trEscapeHtml(trT('clear') || 'Clear') + '">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
        '<polyline points="3 6 5 6 21 6"></polyline>' +
        '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
      '</svg>' +
      '<span>' + trEscapeHtml(trT('clear') || 'Clear') + '</span>' +
    '</button>' +
  '</div>';
  bar.innerHTML = html;
}

function trHandleClear() {
  var promptMsg = trT('trConfirmClear') || '确定要清空当前的文本审校状态与重置会话吗？';
  var doClear = function () {
    if (typeof window.trCleanupStep3 === 'function') {
      try { window.trCleanupStep3(); } catch (e) {}
    }
    trApiPost('/text-review/clear', {}).catch(function () {});
    if (typeof trResetState === 'function') {
      trResetState();
    } else if (window.TR_STATE && typeof window.TR_STATE.resetState === 'function') {
      window.TR_STATE.resetState();
    }
    if (typeof trClearPersisted === 'function') {
      trClearPersisted();
    } else if (window.TR_STATE && typeof window.TR_STATE.clearPersisted === 'function') {
      window.TR_STATE.clearPersisted();
    }
    trRenderStepBar();
    trRenderStep();
    trToast(trT('trCleared') || 'Review state cleared & memory freed', 'success');
  };

  if (typeof confirmModal === 'function') {
    confirmModal(promptMsg).then(function (ok) {
      if (ok) doClear();
    });
  } else {
    if (window.confirm(promptMsg)) doClear();
  }
}

/**
 * Step lock rules:
 *  - Step1: always reachable (re-import / re-paste).
 *  - Step2: reachable when rawText non-empty.
 *  - Step3: reachable when chapters exist (Step2 done).
 *  - Step4: reachable when a session exists (Step3 started).
 */
function trStepLocked(n) {
  if (n === 1) return false;
  if (n === 2) return !trState.rawText;
  if (n === 3) return !(trState.chapters && trState.chapters.length);
  if (n === 4) return false; // Step4 is always accessible; chapters appear as they complete
  return true;
}

/**
 * Jump to step n with guard. Locked steps are no-ops. Persists step on move.
 */
function trGotoStep(n) {
  if (trStepLocked(n)) return;
  if (n === 2) {
    trState.configPanelExpanded = false;
  }
  trState.step = n;
  trSave();
  trRenderStepBar();
  trRenderStep();
}

// ===================== step panel dispatch =====================

function trRenderStep() {
  var panel = document.getElementById('tr-panel');
  if (!panel) return;
  if (trState.step === 1 && typeof window.trRenderStep1 === 'function') {
    window.trRenderStep1(panel, trState);
  } else if (trState.step === 2 && typeof window.trRenderStep2 === 'function') {
    window.trRenderStep2(panel, trState);
  } else if (trState.step === 3 && typeof window.trRenderStep3 === 'function') {
    window.trRenderStep3(panel, trState);
  } else if (trState.step === 4 && typeof window.trRenderStep4 === 'function') {
    window.trRenderStep4(panel, trState);
  } else {
    panel.innerHTML = '<div class="tr-empty">' + trEscapeHtml(trT('trStepUnknown')) + '</div>';
  }
}

