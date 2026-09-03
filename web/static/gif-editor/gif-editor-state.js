// web/static/gif-editor-state.js
// TinyLab GIF Editor Core State & Lifecycle Registry

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
    splitMode: 'even',       // Split Sheet grid mode (even | uneven)
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
    // Transparency tool session (docs/gif_upgrade.md §4.1, trans section).
    // Live DOM inputs drive the preview while the panel is open; Apply
    // snapshots them into `committed`. Consumers (draw preview when the
    // panel is closed, thumbnails, exports) read ONLY the committed
    // snapshot — slice canvases are never baked, so params stay fully
    // reversible until a destructive transform (crop/resize/slice/split)
    // materializes the committed removal into the new canvases.
    trans: {
      mode: 'color',        // 'color' (颜色去背) | 'flood' (区域去背)
      keyColor: '#ffffff',
      fuzziness: 15,
      seeds: [],            // [{x, y}] flood seeds in slice-canvas coords
      corner: false,        // flood preset: remove border-connected bg
      c2a: false,           // GIMP Color-to-Alpha soft-edge mode
      erode: 0,             // flood: expand (+) / shrink (−) selection, px -10..10
      erodeSmooth: 0,       // flood: feather the selection edge, px 0..20
      committed: null       // frozen params snapshot at Apply
    },
    pickColorMode: false,
    floodPickMode: false,
    transparencyReady: false,

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
      generation: 0,
      loop: false,
      reverse: false
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
    // The cleanup registry is persistent: every registered module cleanup is
    // idempotent and must run on EVERY teardown/re-render (not just the first
    // render) so document/window listeners, timers and draft handlers never
    // accumulate or go stale across repeated enter/leave cycles.
    for (var i = 0; i < cleanupFns.length; i++) {
      try {
        cleanupFns[i]();
      } catch (e) {
        console.error('[GifEditorCore] Error in cleanup callback', e);
      }
    }
    // Commands/modules are re-registered on every render; the cleanup list
    // itself is intentionally NOT cleared here.
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
    state.source.rawImage = null;
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

  function showSpinner(msg, pct) {
    state.isExtracting = true;
    var overlay = dom.spinnerOverlay || byId('loading-spinner');
    if (overlay) overlay.style.display = 'flex';

    var liquidFill = document.getElementById('gif-liquid-fill');
    if (liquidFill) {
      var numPct = (typeof pct === 'number') ? pct : null;
      if (numPct === null && typeof msg === 'string') {
        var match = msg.match(/(\d+)\s*%/);
        if (match) {
          numPct = parseInt(match[1], 10);
        }
      }

      if (numPct !== null && !isNaN(numPct)) {
        numPct = Math.max(0, Math.min(100, numPct));
        liquidFill.style.animation = 'none';
        liquidFill.style.width = Math.max(4, numPct) + '%';
      } else {
        liquidFill.style.animation = 'fillProgress 4s ease-out infinite';
      }
    }
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
  var stateBound = false;

  // Window-level key blocking is lifecycle-bound: added on render, removed on
  // teardown, so no stale global keyboard handler survives page leave.
  function bindStateEvents() {
    if (stateBound) return;
    stateBound = true;
    window.addEventListener('keydown', blockKeyDuringExtracting, true);
    window.addEventListener('keyup', blockKeyDuringExtracting, true);
  }

  function cleanupStateEvents() {
    stateBound = false;
    window.removeEventListener('keydown', blockKeyDuringExtracting, true);
    window.removeEventListener('keyup', blockKeyDuringExtracting, true);
    // Never let a stale extracting flag or spinner survive page leave.
    state.isExtracting = false;
    hideSpinner();
  }

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
    hideSpinner: hideSpinner,
    bindStateEvents: bindStateEvents
  };

  // Lifecycle cleanup for the state module itself (window key block, spinner
  // state). Runs on every teardown via the persistent cleanup registry.
  window.GifEditorCore.registerModule('state', { cleanup: cleanupStateEvents });
})();
