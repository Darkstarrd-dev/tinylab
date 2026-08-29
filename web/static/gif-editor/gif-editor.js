// web/static/gif-editor.js
// GIF / frame editor page for TinyRouter (header nav 6th button, data-page="gif").
// Pure local SPA, classic script execution under web/static/.
//
// Module split (docs/gif_upgrade.md §4): state/lifecycle, import (Import Modal),
// timeline (virtualized window + zoom), playback (First/Prev/Play/Next/Last),
// export (GIF/ZIP/sprite + MediaBridge) live in gif-editor-{state,import,
// timeline,playback,export}.js. This entry owns the page template, canvas
// stage (pan/zoom/crop gizmo/layer gizmo), chroma-key transparency, edge
// crop + grid slice, layer creation/editing and the shared compositor.

// Split: gif-editor.js
(function () {
  'use strict';

  var shared = window._gifEditorShared || (window._gifEditorShared = {});
  shared.dom = shared.dom || {};
  shared.canvas = shared.canvas || null;
  shared.ctx = shared.ctx || null;
  shared.rendered = shared.rendered || false;
  shared.renderContainer = shared.renderContainer || null;
  shared.suspended = shared.suspended || false;
  shared.layerBase = shared.layerBase || null;
  shared.fns = shared.fns || {};
  if (!shared.core) shared.core = window.GifEditorCore;
  var core = shared.core;

  function t(key, args, fallback) {
    if (typeof window.t === 'function') {
      // Global t(key, args) substitutes {0}/{1}/... placeholders (escaped);
      // pass the array through so parameterized messages shared.fns.render correctly.
      var res = window.t(key, Array.isArray(args) ? args : undefined);
      if (res && res !== key) return res;
    }
    if (typeof args === 'string') return args;
    return fallback || key;
  }

  // Real translation application for the static page template: [data-i18n] /
  // [data-i18n-placeholder] attributes have no caller of their own, so they
  // are applied here on every shared.fns.render (setLang re-navigates, which re-renders).
  // Element children (frame indicator span, add-image file input) are kept by
  // replacing only text nodes.
  shared.fns.t = t;

  function applyTemplateI18n(root) {
    if (!root) return;
    var i, el, key, msg;
    var labels = root.querySelectorAll('[data-i18n]');
    for (i = 0; i < labels.length; i++) {
      el = labels[i];
      key = el.getAttribute('data-i18n');
      if (!key) continue;
      msg = t(key, el.textContent);
      if (el.childElementCount === 0) {
        el.textContent = msg;
      } else {
        for (var n = 0; n < el.childNodes.length; n++) {
          if (el.childNodes[n].nodeType === 3) {
            el.childNodes[n].textContent = msg;
            msg = '';
          }
        }
      }
    }
    var phs = root.querySelectorAll('[data-i18n-placeholder]');
    for (i = 0; i < phs.length; i++) {
      el = phs[i];
      key = el.getAttribute('data-i18n-placeholder');
      if (!key) continue;
      el.placeholder = t(key, el.placeholder);
    }
  }
  shared.fns.applyTemplateI18n = applyTemplateI18n;

  function cacheDom() {
    shared.dom.canvas = core.byId('preview-canvas');
    shared.dom.ctx = shared.dom.canvas ? shared.dom.canvas.getContext('2d') : null;
    shared.dom.canvasWrapper = core.byId('canvas-wrapper');
    shared.dom.stage = core.byId('stage-container');
    shared.dom.timeline = core.byId('timeline');
    shared.dom.timelineScroll = core.byId('timeline-scroll');
    shared.dom.timelineToolbar = core.byId('timeline-toolbar');
    shared.dom.stageOverlayText = core.byId('stage-overlay-text');
    shared.dom.spinnerOverlay = core.byId('loading-spinner');
    shared.dom.spinnerText = core.byId('spinner-text');
    shared.dom.reloadBtn = core.byId('reload-btn');
    shared.dom.dropZoneContainer = core.byId('drop-zone-container');
    shared.dom.sidebarEditorContent = core.byId('sidebar-editor-content');
    shared.dom.openExportBtn = core.byId('open-export-btn');

    shared.dom.dropZone = core.byId('drop-zone');
    shared.dom.fileInput = core.byId('file-input');
    shared.dom.enableTrans = core.byId('enable-trans');
    shared.dom.transPanel = core.byId('trans-panel');
    shared.dom.keyColor = core.byId('key-color');
    shared.dom.pickColorBtn = core.byId('pick-color-btn');
    shared.dom.fuzziness = core.byId('fuzziness');
    shared.dom.transErode = core.byId('trans-erode');
    shared.dom.transErodeSmooth = core.byId('trans-erode-smooth');
    shared.dom.disableTransBtn = core.byId('disable-trans-btn');
    shared.dom.transModeColorBtn = core.byId('trans-mode-color-btn');
    shared.dom.transModeFloodBtn = core.byId('trans-mode-flood-btn');
    shared.dom.transColorControls = core.byId('trans-color-controls');
    shared.dom.transFloodControls = core.byId('trans-flood-controls');
    shared.dom.transC2a = core.byId('trans-c2a');
    shared.dom.floodPickBtn = core.byId('flood-pick-btn');
    shared.dom.clearSeedsBtn = core.byId('clear-seeds-btn');
    shared.dom.transCornerBtn = core.byId('corner-flood-btn');
    shared.dom.seedCountLabel = core.byId('seed-count');
    shared.dom.imageTools = core.byId('image-tools');
    shared.dom.videoTools = core.byId('video-tools');

    shared.dom.sliderT = core.byId('slider-t'); shared.dom.cropT = core.byId('crop-t');
    shared.dom.sliderB = core.byId('slider-b'); shared.dom.cropB = core.byId('crop-b');
    shared.dom.sliderL = core.byId('slider-l'); shared.dom.cropL = core.byId('crop-l');
    shared.dom.sliderR = core.byId('slider-r'); shared.dom.cropR = core.byId('crop-r');
    shared.dom.rows = core.byId('rows');
    shared.dom.cols = core.byId('cols');
    shared.dom.sliceBtn = core.byId('slice-btn');

    shared.dom.panelStep2 = core.byId('gif-panel-step2') || core.byId('panel-step2');
    shared.dom.panelStep3 = core.byId('gif-panel-step3') || core.byId('panel-step3');
    shared.dom.frameIndicator = core.byId('frame-indicator');
    shared.dom.startGlobalCropBtn = core.byId('global-crop-btn');
    shared.dom.cropPanel = core.byId('crop-panel');
    shared.dom.cropNumL = core.byId('crop-num-l');
    shared.dom.cropNumR = core.byId('crop-num-r');
    shared.dom.cropNumT = core.byId('crop-num-t');
    shared.dom.cropNumB = core.byId('crop-num-b');
    shared.dom.cancelCropBtn = core.byId('cancel-crop-btn');
    shared.dom.applyCropBtn = core.byId('apply-crop-btn');
    shared.dom.rangeStart = core.byId('crop-start');
    shared.dom.rangeEnd = core.byId('crop-end');
    shared.dom.addTextInput = core.byId('text-input');
    shared.dom.addTextBtn = core.byId('add-text-btn');
    shared.dom.addTextColor = core.byId('text-color');
    shared.dom.addImageInput = core.byId('add-image-input');
    shared.dom.btnBold = core.byId('btn-bold');
    shared.dom.btnItalic = core.byId('btn-italic');
    shared.dom.btnUnderline = core.byId('btn-underline');
    shared.dom.selectedLayerTools = core.byId('selected-layer-tools');
    shared.dom.layerApplyAll = core.byId('layer-apply-all');
    shared.dom.strokeColor = core.byId('text-stroke-color');
    shared.dom.layerScale = core.byId('layer-scale');
    shared.dom.deleteLayerBtn = core.byId('delete-layer-btn');
    shared.dom.layerList = core.byId('layer-list');

    shared.dom.overlayContainer = core.byId('overlay-container');
    shared.dom.globalDelayContainer = core.byId('global-delay-container');
    shared.dom.batchDelayInput = core.byId('batch-delay-input');
    shared.dom.batchDelayBtn = core.byId('batch-delay-btn');
    shared.dom.batchDeleteContainer = core.byId('batch-delete-container');
    shared.dom.intervalDeleteContainer = core.byId('interval-delete-container');

    // 全局缩放 DOM
    shared.dom.resizeKeepRatio = core.byId('resize-keep-ratio');
    shared.dom.resizeWidth = core.byId('resize-width');
    shared.dom.resizeHeight = core.byId('resize-height');
    shared.dom.resizeApplyBtn = core.byId('resize-apply-btn');

    // 间隔删除 DOM
    shared.dom.intervalDeleteVal = core.byId('interval-delete-val');
    shared.dom.intervalDeleteBtn = core.byId('interval-delete-btn');
    shared.dom.outW = core.byId('output-width');
    shared.dom.outH = core.byId('output-height');
    shared.dom.outScaleSlider = core.byId('output-scale-slider');
    shared.dom.outScaleVal = core.byId('output-scale-val');
    shared.dom.scalePercent = core.byId('scale-percent');
    shared.dom.applyScaleBtn = core.byId('apply-scale-btn');
    shared.dom.qualitySlider = core.byId('sample-interval');
    shared.dom.quality = core.byId('quality-val');
    shared.dom.exportBtn = core.byId('export-gif-btn');
    shared.dom.exportZipBtn = core.byId('export-frames-btn');
    shared.dom.exportPngBtn = core.byId('export-sprite-btn');

    shared.dom.delStart = core.byId('del-start');
    shared.dom.delEnd = core.byId('del-end');
    shared.dom.btnDelRange = core.byId('delete-range-btn');
    shared.dom.btnKeepRange = core.byId('keep-range-btn');
    shared.dom.spriteRows = core.byId('sprite-rows');
    shared.dom.spriteCols = core.byId('sprite-cols');

    shared.dom.zoomOutBtn = core.byId('zoom-out-btn');
    shared.dom.resetViewBtn = core.byId('reset-view-btn');
    shared.dom.zoomInBtn = core.byId('zoom-in-btn');

    shared.dom.splitSheetContainer = core.byId('split-sheet-container');
    shared.dom.splitSheetToggleBtn = core.byId('split-sheet-toggle-btn');
    shared.dom.splitSheetPanel = core.byId('split-sheet-panel');
    shared.dom.splitSourceRes = core.byId('split-source-res');
    shared.dom.splitScale = core.byId('split-scale');
    shared.dom.splitScaleDisplay = core.byId('split-scale-display');
    shared.dom.splitCols = core.byId('split-cols');
    shared.dom.splitRows = core.byId('split-rows');
    shared.dom.splitColsLabel = core.byId('split-cols-label');
    shared.dom.splitRowsLabel = core.byId('split-rows-label');
    shared.dom.splitModeToggle = core.byId('split-mode-toggle');
    shared.dom.splitInnerGap = core.byId('split-inner-gap');
    shared.dom.splitOuterMargin = core.byId('split-outer-margin');
    shared.dom.splitEnableOuter = core.byId('split-enable-outer');
    shared.dom.splitActualFrames = core.byId('split-actual-frames');
    shared.dom.splitDuration = core.byId('split-duration');
    shared.dom.splitApplyBtn = core.byId('split-apply-btn');

    shared.dom.batchDeleteContainer = core.byId('batch-delete-container');

    // Link references to GifEditorCore.dom
    Object.assign(core.dom, shared.dom);
  }
  shared.fns.cacheDom = cacheDom;

  function registerCoreCommands() {
    core.commands.redrawSelection = function (index) {
      shared.fns.draw();
    };
    core.commands.updateSelectionUI = function (index) {
      shared.fns.updateSelectionUI(index);
    };
    core.commands.composeFrame = function (index, targetCanvas, opts) {
      shared.fns.composeFrame(index, targetCanvas, opts);
    };
    core.commands.resetView = function () {
      shared.fns.resetView();
    };
    core.commands.updateTransform = function () {
      shared.fns.updateTransform();
    };
    core.commands.updateSourcePanels = function (kind) {
      shared.fns.updateSourcePanels(kind);
    };
  }
  shared.fns.registerCoreCommands = registerCoreCommands;
})();
