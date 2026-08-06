// web/static/gif-editor-state.js
// TinyRouter GIF Editor Core State & Lifecycle Registry

(function () {
  'use strict';

  var MAX_FILE_BYTES = 200 * 1024 * 1024;        // GIF / video single-file cap (200MB)
  var EXPORT_MEM_LIMIT = 1.5 * 1024 * 1024 * 1024; // Export memory warning threshold
  var GIF_VENDOR_URL = '/vendor/gif.js/gif.js';
  var GIF_WORKER_URL = '/vendor/gif.js/gif.worker.js';
  var MATTE_HEX = '#FF00FF';
  var MATTE_NUM = 0xFF00FF;

  var state = {
    source: {
      kind: null,          // 'image' | 'gif' | 'video' | null
      file: null,
      objectUrl: null,     // committed source URL (revoked on reset/leave)
      width: 0,
      height: 0,
      durationMs: 0,
      sourceFps: 0,
      image: null,
      video: null,
      gridSliced: false    // image grid slice applied (hides the slice preview overlay)
    },
    importDraft: null,     // Temporary draft during Import Modal
    slices: [],            // { id, canvas, delay, layers[] }
    processedImg: null,    // image source canvas used by edge-crop / grid slice
    scale: 1,
    panX: 0,
    panY: 0,
    isDraggingStage: false,
    startX: 0,
    startY: 0,
    mode: 'source',        // source | editor | crop
    selectedSliceIdx: -1,
    activeLayer: null,
    interactionMode: null,
    startMouseX: 0,
    startMouseY: 0,
    startLayerState: null,
    cropRect: { x: 0, y: 0, w: 100, h: 100 },
    textStyle: { bold: false, italic: false, underline: false },
    dragSrcIndex: null,
    dragItemEl: null,
    pickColorMode: false,
    transparencyReady: false,
    touchDragItem: null,
    touchStartIndex: null,

    // Integrated timeline state
    timeline: {
      zoom: 1,
      window: null,
      thumbCache: {},
      thumbKeys: []
    },

    // Integrated playback state
    playback: {
      playing: false,
      timer: null,
      generation: 0
    }
  };

  var dom = {};
  var modules = {};
  var commands = {};
  var cleanupFns = [];

  function byId(name) {
    return document.getElementById('gif-' + name);
  }

  function freshId() {
    return Date.now() + Math.random();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatDurationMs(ms) {
    if (!ms || isNaN(ms) || ms < 0) ms = 0;
    var totalSec = Math.floor(ms / 1000);
    var msec = Math.floor(ms % 1000);
    var hrs = Math.floor(totalSec / 3600);
    var mins = Math.floor((totalSec % 3600) / 60);
    var secs = totalSec % 60;

    var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var pad3 = function (n) { return (n < 100 ? (n < 10 ? '00' : '0') : '') + n; };

    return pad2(hrs) + ':' + pad2(mins) + ':' + pad2(secs) + '.' + pad3(msec);
  }

  function registerModule(name, api) {
    modules[name] = api;
    if (api && typeof api.cleanup === 'function') {
      registerCleanup(function () {
        try {
          api.cleanup();
        } catch (e) {
          console.error('[GifEditorCore] Error cleaning module ' + name, e);
        }
      });
    }
  }

  function registerCleanup(fn) {
    if (typeof fn === 'function') {
      cleanupFns.push(fn);
    }
  }

  function cleanupModules() {
    for (var i = 0; i < cleanupFns.length; i++) {
      try {
        cleanupFns[i]();
      } catch (e) {
        console.error('[GifEditorCore] Error in cleanup callback', e);
      }
    }
    cleanupFns = [];
    modules = {};
    commands = {};
  }

  // Drop every frame canvas + layer reference so the GC can reclaim the
  // (potentially large) pixel buffers. Idempotent.
  function resetSlices() {
    for (var i = 0; i < state.slices.length; i++) {
      var s = state.slices[i];
      if (s) {
        if (s.canvas) { try { s.canvas.width = 0; } catch (e) {} s.canvas = null; }
        s.layers = null;
      }
    }
    state.slices = [];
    state.selectedSliceIdx = -1;
    state.activeLayer = null;
    state.mode = 'source';
    state.processedImg = null;
    if (state.timeline) {
      state.timeline.thumbCache = {};
      state.timeline.thumbKeys = [];
      state.timeline.window = null;
    }
  }

  // Release the committed source resources (object URL + media refs).
  // Called on reset / page leave. Idempotent.
  function releaseSource() {
    if (state.source.objectUrl) {
      try { URL.revokeObjectURL(state.source.objectUrl); } catch (e) {}
      state.source.objectUrl = null;
    }
    state.source.file = null;
    state.source.image = null;
    if (state.source.video) {
      try {
        state.source.video.removeAttribute('src');
        if (state.source.video.load) state.source.video.load();
      } catch (e) {}
      state.source.video = null;
    }
    state.source.kind = null;
    state.source.width = 0;
    state.source.height = 0;
    state.source.durationMs = 0;
    state.source.sourceFps = 0;
    state.source.gridSliced = false;
    state.srcImg = null;
    state.srcVideo = null;
  }

  function showSpinner(msg) {
    state.isExtracting = true;
    var overlay = dom.spinnerOverlay || byId('loading-spinner');
    var textEl = dom.spinnerText || byId('spinner-text');
    if (overlay) overlay.style.display = 'flex';
    if (textEl && msg) textEl.textContent = msg;
  }

  function hideSpinner() {
    state.isExtracting = false;
    var overlay = dom.spinnerOverlay || byId('loading-spinner');
    if (overlay) overlay.style.display = 'none';
  }

  // Lock keyboard events during extracting/processing state
  function blockKeyDuringExtracting(e) {
    if (state.isExtracting) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      return false;
    }
  }
  window.addEventListener('keydown', blockKeyDuringExtracting, true);
  window.addEventListener('keyup', blockKeyDuringExtracting, true);

  window.GifEditorCore = {
    constants: {
      MAX_FILE_BYTES: MAX_FILE_BYTES,
      EXPORT_MEM_LIMIT: EXPORT_MEM_LIMIT,
      GIF_VENDOR_URL: GIF_VENDOR_URL,
      GIF_WORKER_URL: GIF_WORKER_URL,
      MATTE_HEX: MATTE_HEX,
      MATTE_NUM: MATTE_NUM
    },
    state: state,
    dom: dom,
    modules: modules,
    commands: commands,
    byId: byId,
    freshId: freshId,
    escapeHtml: escapeHtml,
    formatDurationMs: formatDurationMs,
    registerModule: registerModule,
    registerCleanup: registerCleanup,
    cleanupModules: cleanupModules,
    resetSlices: resetSlices,
    releaseSource: releaseSource,
    showSpinner: showSpinner,
    hideSpinner: hideSpinner
  };
})();
