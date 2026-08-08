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
function trT(k, ar) { return typeof t === 'function' ? t(k, ar) : k; }

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
  trBootstrapDone = true;
  var patsP = trApiGet('/text-review/split-patterns').then(function (res) {
    var backendPats = (res && !res.error && Array.isArray(res.patterns)) ? res.patterns : [];
    trMergePatterns(backendPats);
  }, function () { trMergePatterns([]); });
  var promptP = trApiGet('/text-review/prompt-default').then(function (res) {
    if (res && !res.error && res.systemPrompt && !trState.systemPrompt) {
      trState.systemPrompt = res.systemPrompt;
    }
  }, function () { /* non-fatal */ });
  return Promise.all([patsP, promptP]);
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
  // Close the Step3 SSE subscription (backend task continues — 切页不丢).
  if (typeof window.trCleanupStep3 === 'function') window.trCleanupStep3();
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
  bar.innerHTML = html;
}

/**
 * Step lock rules:
 *  - Step1: always reachable (re-import / re-paste).
 *  - Step2: reachable when rawText non-empty.
 *  - Step3: reachable when chapters exist (Step2 done). P6 implements it.
 *  - Step4: reachable when a session exists (Step3 started). P7 implements it.
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
  // Step4 uses the full editor area (left wizard + right pane); other steps
  // keep the wizard in the left half with the right content pane beside it.
  var wrap = document.querySelector('.ed-review-wrap');
  if (wrap) wrap.classList.toggle('tr-s4-active', trState.step === 4);
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
