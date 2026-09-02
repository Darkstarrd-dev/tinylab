// zoom.js — Global + contextual text zoom (Ctrl+Wheel, Ctrl+Middle reset).
// Global: html zoom (all content) + contextual text-only zoom:
//   playground prompt input (pg) → pg input + chat bubbles
//   editor / game designer (editor) → editor textarea
// When focus is in those inputs, Ctrl+Wheel scales only that surface; otherwise
// it scales the whole window. Ctrl+MiddleClick (or Ctrl+0) resets the current
// context to 100%. GIF timeline/stage and tilemap canvas keep their own
// ctrl+wheel handlers and are excluded.
(function () {
  'use strict';
  var GLOBAL_KEY = 'tr-global-zoom';
  var PG_KEY = 'tr-pg-text-zoom';
  var EDITOR_KEY = 'tr-editor-text-zoom';
  var globalScale = parseFloat(localStorage.getItem(GLOBAL_KEY) || '1');
  if (!isFinite(globalScale)) globalScale = 1;
  var pgScale = parseFloat(localStorage.getItem(PG_KEY) || '1');
  if (!isFinite(pgScale)) pgScale = 1;
  var editorScale = parseFloat(localStorage.getItem(EDITOR_KEY) || '1');
  if (!isFinite(editorScale)) editorScale = 1;

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function applyGlobal() {
    try {
      document.documentElement.style.zoom = globalScale === 1 ? '' : String(globalScale);
    } catch (e) {}
    try { localStorage.setItem(GLOBAL_KEY, String(globalScale)); } catch (e) {}
  }
  function ensureStyle(id) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    return el;
  }
  function applyPg() {
    var el = ensureStyle('zoom-pg-style');
    if (pgScale === 1) el.textContent = '';
    else {
      // prompt input + maximized textarea + chat bubbles (text only, not padding via zoom)
     // Coverage: normal chat (pg-bubble), search dual panes (both sides use pg-bubble
     // but left/raw is rendered via pg-search-raw/pretty-view and has its own
     // code/table/body containers), and prompt input. Button group on each
     // pane head should scale both sides and input together per user request.
      el.textContent =
        '#pg-input{font-size:calc(var(--font-base) * ' + pgScale + ') !important}\n' +
        '#pg-max-editor-textarea{font-size:calc(14px * ' + pgScale + ') !important}\n' +
        '.pg-bubble{font-size:calc(var(--font-base) * ' + pgScale + ') !important}\n' +
        '.pg-bubble h1{font-size:calc((var(--font-base) + 6px) * ' + pgScale + ') !important}\n' +
        '.pg-bubble h2{font-size:calc((var(--font-base) + 4px) * ' + pgScale + ') !important}\n' +
        '.pg-bubble h3{font-size:calc((var(--font-base) + 2px) * ' + pgScale + ') !important}\n' +
        '.pg-bubble code{font-size:calc(var(--font-code) * ' + pgScale + ') !important}\n' +
        '.pg-bubble pre code{font-size:calc(var(--font-code) * ' + pgScale + ') !important}\n' +
        '.pg-bubble table,.pg-bubble th,.pg-bubble td{font-size:calc(var(--font-code) * ' + pgScale + ') !important}\n' +
        '.pg-thinking-body{font-size:calc(var(--font-body) * ' + pgScale + ') !important}\n' +
        '.pg-search-raw-view{font-size:calc(12px * ' + pgScale + ') !important}\n' +
        '.pg-search-strategy pre{font-size:calc(12px * ' + pgScale + ') !important}\n' +
        '.pg-search-raw-body .pg-search-pretty-view{font-size:calc(var(--font-base) * ' + pgScale + ') !important}\n' +
        '.pg-search-raw-body .pg-search-pretty-view h1{font-size:calc((var(--font-base) + 6px) * ' + pgScale + ') !important}\n' +
        '.pg-search-raw-body .pg-search-pretty-view h2{font-size:calc((var(--font-base) + 4px) * ' + pgScale + ') !important}\n' +
        '.pg-search-raw-body .pg-search-pretty-view h3{font-size:calc((var(--font-base) + 2px) * ' + pgScale + ') !important}\n' +
        '.pg-search-raw-body .pg-search-pretty-view code{font-size:calc(var(--font-code) * ' + pgScale + ') !important}\n' +
        '.pg-search-raw-body .pg-search-pretty-view pre code{font-size:calc(var(--font-code) * ' + pgScale + ') !important}\n' +
        '.pg-search-raw-body .pg-search-pretty-view table,.pg-search-raw-body .pg-search-pretty-view th,.pg-search-raw-body .pg-search-pretty-view td{font-size:calc(var(--font-code) * ' + pgScale + ') !important}\n';
    }
    try { localStorage.setItem(PG_KEY, String(pgScale)); } catch (e) {}
  }
  function applyEditor() {
    var el = ensureStyle('zoom-editor-style');
    if (editorScale === 1) el.textContent = '';
    else {
      // Toolbar buttons use data-zoom; input + gutter + preview must share scale.
      el.textContent =
        '#ed-main-input, .ed-syntax-overlay, textarea.ed-input, .ed-input, .ed-main-input, textarea[id^="ed-input-"]{font-size:calc(var(--font-code,13px) * ' + editorScale + ') !important; line-height:calc(1.55 * ' + editorScale + ')}\n' +
        '.ed-line-gutter{font-size:calc(var(--font-code,13px) * ' + editorScale + ') !important}\n' +
        '.ed-preview-content{font-size:calc(var(--font-base,14px) * ' + editorScale + ') !important}\n' +
        '.ed-preview-content h1{font-size:calc((var(--font-base,14px) + 8px) * ' + editorScale + ') !important}\n' +
        '.ed-preview-content h2{font-size:calc((var(--font-base,14px) + 5px) * ' + editorScale + ') !important}\n' +
        '.ed-preview-content h3{font-size:calc((var(--font-base,14px) + 2px) * ' + editorScale + ') !important}\n' +
        '.ed-preview-content code{font-size:calc(var(--font-code,13px) * ' + editorScale + ') !important}\n' +
        '.ed-preview-content pre code{font-size:calc(var(--font-code,13px) * ' + editorScale + ') !important}\n' +
        '.ed-preview-content table,.ed-preview-content th,.ed-preview-content td{font-size:calc(var(--font-code,13px) * ' + editorScale + ') !important}\n' +
        '.dgn-root #ed-main-input, .dgn-root .ed-syntax-overlay{font-size:calc(var(--font-code,13px) * ' + editorScale + ') !important}\n' +
        '.dgn-root .ed-preview-content{font-size:calc(var(--font-base,14px) * ' + editorScale + ') !important}\n';
    }
    try { localStorage.setItem(EDITOR_KEY, String(editorScale)); } catch (e) {}
  }

  function getContext() {
    var ae = document.activeElement;
    if (!ae) return 'global';
    // Editor / Game Designer (both reuse EditorLayout → #ed-main-input)
    if (ae.id === 'ed-main-input' || ae.classList.contains('ed-input') || ae.classList.contains('ed-main-input') || (ae.id && ae.id.indexOf('ed-input-') === 0)) {
      return 'editor';
    }
    if (ae.tagName === 'TEXTAREA' && ae.closest) {
      var ec = ae.closest('.ed-editor-surface, .ed-content-split, .dgn-root');
      if (ec) return 'editor';
    }
    if (ae.id === 'pg-input' || ae.id === 'pg-max-editor-textarea') return 'pg';
    return 'global';
  }

  function toastScale(ctx, scale) {
    var msg = '';
    if (ctx === 'pg') msg = 'Playground ' + Math.round(scale * 100) + '%';
    else if (ctx === 'editor') msg = 'Editor ' + Math.round(scale * 100) + '%';
    else msg = Math.round(scale * 100) + '%';
    if (typeof window.toast === 'function') {
      try { window.toast(msg, 'info', 1200); } catch (e) {}
    }
  }

  // initial apply (head may not be ready if script in head; defer if needed)
  function initApply() {
    applyGlobal();
    applyPg();
    applyEditor();
  }
  if (document.head) initApply();
  else document.addEventListener('DOMContentLoaded', initApply);

  window.__zoom = {
    getGlobal: function () { return globalScale; },
    getPg: function () { return pgScale; },
    getEditor: function () { return editorScale; },
    resetGlobal: function () { globalScale = 1; applyGlobal(); },
    resetPg: function () { pgScale = 1; applyPg(); },
    resetEditor: function () { editorScale = 1; applyEditor(); }
  };

  // Button-facing helpers (also wired to wheel/middle)
  function pgStep(delta) {
    pgScale = clamp(pgScale + delta, 0.5, 3);
    applyPg();
    toastScale('pg', pgScale);
  }
  function editorStep(delta) {
    editorScale = clamp(editorScale + delta, 0.5, 3);
    applyEditor();
    toastScale('editor', editorScale);
  }
  function pgReset() { pgScale = 1; applyPg(); toastScale('pg', pgScale); }
  function editorReset() { editorScale = 1; applyEditor(); toastScale('editor', editorScale); }
  window.__zoom.pgStep = pgStep;
  window.__zoom.editorStep = editorStep;
  window.__zoom.pgReset = pgReset;
  window.__zoom.editorReset = editorReset;
  // globals for inline onclick (pg-ui / EditorLayout)
  window.pgZoomStep = pgStep;
  window.pgZoomReset = pgReset;
  window.editorZoomStep = editorStep;
  window.editorZoomReset = editorReset;

  function isInternalZoomTarget(t) {
    if (!t || !t.closest) return false;
    if (t.closest('.gif-timeline-area') || t.closest('.gif-stage-area') || t.closest('#gif-stage') || t.closest('#gif-timeline-scroll')) return true;
    if (t.closest('#tilemap-canvas')) return true;
    return false;
  }

  function onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (isInternalZoomTarget(e.target)) return;
    var ctx = getContext();
    e.preventDefault();
    var delta = e.deltaY < 0 ? 0.05 : -0.05;
    if (ctx === 'pg') {
      pgScale = clamp(pgScale + delta, 0.5, 3);
      applyPg();
      toastScale(ctx, pgScale);
    } else if (ctx === 'editor') {
      editorScale = clamp(editorScale + delta, 0.5, 3);
      applyEditor();
      toastScale(ctx, editorScale);
    } else {
      globalScale = clamp(globalScale + delta, 0.5, 3);
      applyGlobal();
      toastScale(ctx, globalScale);
    }
  }
  // capture to run before inner handlers, but we still let internal targets pass through
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });

  function onMiddle(e) {
    if (e.button !== 1) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    var ctx = getContext();
    if (ctx === 'pg') { pgScale = 1; applyPg(); toastScale(ctx, pgScale); }
    else if (ctx === 'editor') { editorScale = 1; applyEditor(); toastScale(ctx, editorScale); }
    else { globalScale = 1; applyGlobal(); toastScale(ctx, globalScale); }
  }
  window.addEventListener('mousedown', onMiddle, { passive: false, capture: true });
  window.addEventListener('auxclick', function (e) {
    if (e.button === 1 && (e.ctrlKey || e.metaKey)) e.preventDefault();
  }, { passive: false, capture: true });

  window.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      var ctx = getContext();
      if (ctx === 'pg') { pgScale = 1; applyPg(); toastScale(ctx, pgScale); }
      else if (ctx === 'editor') { editorScale = 1; applyEditor(); toastScale(ctx, editorScale); }
      else { globalScale = 1; applyGlobal(); toastScale(ctx, globalScale); }
    }
  });
})();
