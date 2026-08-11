// web/static/gif-editor.js
// GIF / frame editor page for TinyRouter (header nav 6th button, data-page="gif").
// Pure local SPA, classic script execution under web/static/.
//
// Module split (gif_upgrade.md §4): state/lifecycle, import (Import Modal),
// timeline (virtualized window + zoom), playback (First/Prev/Play/Next/Last),
// export (GIF/ZIP/sprite + MediaBridge) live in gif-editor-{state,import,
// timeline,playback,export}.js. This entry owns the page template, canvas
// stage (pan/zoom/crop gizmo/layer gizmo), chroma-key transparency, edge
// crop + grid slice, layer creation/editing and the shared compositor.

(function () {
  'use strict';

  var core = window.GifEditorCore;

  function t(key, fallback) {
    if (typeof window.t === 'function') {
      var res = window.t(key);
      if (res && res !== key) return res;
    }
    return fallback || key;
  }

  // Real translation application for the static page template: [data-i18n] /
  // [data-i18n-placeholder] attributes have no caller of their own, so they
  // are applied here on every render (setLang re-navigates, which re-renders).
  // Element children (frame indicator span, add-image file input) are kept by
  // replacing only text nodes.
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

  var dom = {};
  var canvas = null;
  var ctx = null;
  var rendered = false;
  var renderContainer = null;
  var suspended = false;
  var layerBase = null; // baseline size of the active layer (layer-scale slider)

  // ------------------------------------------------------------------
  // Lifecycle: render & cleanup (repeated enter/leave must be safe)
  // ------------------------------------------------------------------

  function render(container) {
    teardown();
    if (!container) container = document.getElementById('page-content');
    if (!container) return null;
    renderContainer = container;
    suspended = false;
    container.style.height = '100%';
    container.style.overflow = 'hidden';
    container.innerHTML = pageTemplate();
    applyTemplateI18n(container);

    cacheDom();
    canvas = dom.canvas;
    ctx = dom.ctx;

    registerCoreCommands();
    bindEvents();
    rendered = true;

    // Restore workspace state from memory if returning from another tab
    if ((core.state.slices || []).length > 0) {
      if (core.commands.updateSourcePanels) core.commands.updateSourcePanels(core.state.source.kind);
      if (core.timeline && core.timeline.render) core.timeline.render();
      if (core.playback && core.playback.updateButtons) core.playback.updateButtons();
      var selectedIdx = core.state.selectedSliceIdx >= 0 ? core.state.selectedSliceIdx : 0;
      updateSelectionUI(selectedIdx);
    } else {
      updateSelectionUI(-1);
    }

    draw();
    resetView();
    return container;
  }

  function suspend() {
    if (!rendered && !core.state.playback.playing) {
      suspended = true;
      return;
    }
    teardown();
    suspended = true;
  }

  function resume() {
    if (!suspended && rendered) return renderContainer;
    var pageContent = document.getElementById('page-content');
    var target = pageContent || renderContainer;
    if (!target) return null;
    return render(target);
  }

  function cleanup() {
    teardown();
    // cleanupGifEditor remains the full teardown path for legacy callers.
    // Utility navigation must call suspend() instead to retain this project.
    if (core) {
      core.resetSlices();
      core.releaseSource();
    }
    renderContainer = null;
    suspended = false;
  }

  function teardown() {
    if (rendered) {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('touchmove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
      window.removeEventListener('touchend', onPointerUp);
      window.removeEventListener('resize', onWindowResize);
      if (dom.stage) {
        dom.stage.removeEventListener('mousedown', handlePointerDown);
        dom.stage.removeEventListener('touchstart', handlePointerDown);
        dom.stage.removeEventListener('wheel', handleWheel);
      }
    }
    if (core) {
      core.cleanupModules();
    }
    dom = {};
    canvas = null;
    ctx = null;
    rendered = false;
  }

  // ------------------------------------------------------------------
  // DOM Cache & Core Command Registration
  // ------------------------------------------------------------------

  function cacheDom() {
    dom.canvas = core.byId('preview-canvas');
    dom.ctx = dom.canvas ? dom.canvas.getContext('2d') : null;
    dom.canvasWrapper = core.byId('canvas-wrapper');
    dom.stage = core.byId('stage-container');
    dom.timeline = core.byId('timeline');
    dom.timelineScroll = core.byId('timeline-scroll');
    dom.timelineToolbar = core.byId('timeline-toolbar');
    dom.stageOverlayText = core.byId('stage-overlay-text');
    dom.spinnerOverlay = core.byId('loading-spinner');
    dom.spinnerText = core.byId('spinner-text');
    dom.reloadBtn = core.byId('reload-btn');
    dom.dropZoneContainer = core.byId('drop-zone-container');
    dom.sidebarEditorContent = core.byId('sidebar-editor-content');
    dom.openExportBtn = core.byId('open-export-btn');

    dom.dropZone = core.byId('drop-zone');
    dom.fileInput = core.byId('file-input');
    dom.enableTrans = core.byId('enable-trans');
    dom.transPanel = core.byId('trans-panel');
    dom.keyColor = core.byId('key-color');
    dom.pickColorBtn = core.byId('pick-color-btn');
    dom.fuzziness = core.byId('fuzziness');
    dom.disableTransBtn = core.byId('disable-trans-btn');
    dom.imageTools = core.byId('image-tools');
    dom.videoTools = core.byId('video-tools');

    dom.sliderT = core.byId('slider-t'); dom.cropT = core.byId('crop-t');
    dom.sliderB = core.byId('slider-b'); dom.cropB = core.byId('crop-b');
    dom.sliderL = core.byId('slider-l'); dom.cropL = core.byId('crop-l');
    dom.sliderR = core.byId('slider-r'); dom.cropR = core.byId('crop-r');
    dom.rows = core.byId('rows');
    dom.cols = core.byId('cols');
    dom.sliceBtn = core.byId('slice-btn');

    dom.panelStep2 = core.byId('gif-panel-step2') || core.byId('panel-step2');
    dom.panelStep3 = core.byId('gif-panel-step3') || core.byId('panel-step3');
    dom.frameIndicator = core.byId('frame-indicator');
    dom.startGlobalCropBtn = core.byId('global-crop-btn');
    dom.cropPanel = core.byId('crop-panel');
    dom.cropNumL = core.byId('crop-num-l');
    dom.cropNumR = core.byId('crop-num-r');
    dom.cropNumT = core.byId('crop-num-t');
    dom.cropNumB = core.byId('crop-num-b');
    dom.cancelCropBtn = core.byId('cancel-crop-btn');
    dom.applyCropBtn = core.byId('apply-crop-btn');
    dom.rangeStart = core.byId('crop-start');
    dom.rangeEnd = core.byId('crop-end');
    dom.addTextInput = core.byId('text-input');
    dom.addTextBtn = core.byId('add-text-btn');
    dom.addTextColor = core.byId('text-color');
    dom.addImageInput = core.byId('add-image-input');
    dom.btnBold = core.byId('btn-bold');
    dom.btnItalic = core.byId('btn-italic');
    dom.btnUnderline = core.byId('btn-underline');
    dom.selectedLayerTools = core.byId('selected-layer-tools');
    dom.layerApplyAll = core.byId('layer-apply-all');
    dom.strokeColor = core.byId('text-stroke-color');
    dom.layerScale = core.byId('layer-scale');
    dom.deleteLayerBtn = core.byId('delete-layer-btn');
    dom.layerList = core.byId('layer-list');

    dom.overlayContainer = core.byId('overlay-container');
    dom.globalDelayContainer = core.byId('global-delay-container');
    dom.batchDeleteContainer = core.byId('batch-delete-container');
    dom.intervalDeleteContainer = core.byId('interval-delete-container');

    // 全局缩放 DOM
    dom.resizeKeepRatio = core.byId('resize-keep-ratio');
    dom.resizeWidth = core.byId('resize-width');
    dom.resizeHeight = core.byId('resize-height');
    dom.resizeApplyBtn = core.byId('resize-apply-btn');

    // 间隔删除 DOM
    dom.intervalDeleteVal = core.byId('interval-delete-val');
    dom.intervalDeleteBtn = core.byId('interval-delete-btn');
    dom.outW = core.byId('output-width');
    dom.outH = core.byId('output-height');
    dom.outScaleSlider = core.byId('output-scale-slider');
    dom.outScaleVal = core.byId('output-scale-val');
    dom.scalePercent = core.byId('scale-percent');
    dom.applyScaleBtn = core.byId('apply-scale-btn');
    dom.qualitySlider = core.byId('sample-interval');
    dom.quality = core.byId('quality-val');
    dom.exportBtn = core.byId('export-gif-btn');
    dom.exportZipBtn = core.byId('export-frames-btn');
    dom.exportPngBtn = core.byId('export-sprite-btn');

    dom.delStart = core.byId('del-start');
    dom.delEnd = core.byId('del-end');
    dom.btnDelRange = core.byId('delete-range-btn');
    dom.btnKeepRange = core.byId('keep-range-btn');
    dom.spriteRows = core.byId('sprite-rows');
    dom.spriteCols = core.byId('sprite-cols');

    dom.zoomOutBtn = core.byId('zoom-out-btn');
    dom.resetViewBtn = core.byId('reset-view-btn');
    dom.zoomInBtn = core.byId('zoom-in-btn');

    dom.splitSheetContainer = core.byId('split-sheet-container');
    dom.splitSheetToggleBtn = core.byId('split-sheet-toggle-btn');
    dom.splitSheetPanel = core.byId('split-sheet-panel');
    dom.splitSourceRes = core.byId('split-source-res');
    dom.splitScale = core.byId('split-scale');
    dom.splitScaleDisplay = core.byId('split-scale-display');
    dom.splitCols = core.byId('split-cols');
    dom.splitRows = core.byId('split-rows');
    dom.splitColsLabel = core.byId('split-cols-label');
    dom.splitRowsLabel = core.byId('split-rows-label');
    dom.splitModeToggle = core.byId('split-mode-toggle');
    dom.splitInnerGap = core.byId('split-inner-gap');
    dom.splitOuterMargin = core.byId('split-outer-margin');
    dom.splitEnableOuter = core.byId('split-enable-outer');
    dom.splitActualFrames = core.byId('split-actual-frames');
    dom.splitDuration = core.byId('split-duration');
    dom.splitApplyBtn = core.byId('split-apply-btn');

    dom.batchDeleteContainer = core.byId('batch-delete-container');

    // Link references to GifEditorCore.dom
    Object.assign(core.dom, dom);
  }

  function registerCoreCommands() {
    core.commands.redrawSelection = function (index) {
      draw();
    };
    core.commands.updateSelectionUI = function (index) {
      updateSelectionUI(index);
    };
    core.commands.composeFrame = function (index, targetCanvas, opts) {
      composeFrame(index, targetCanvas, opts);
    };
    core.commands.resetView = function () {
      resetView();
    };
    core.commands.updateTransform = function () {
      updateTransform();
    };
    core.commands.updateSourcePanels = function (kind) {
      updateSourcePanels(kind);
    };
  }

  function updateSelectionUI(index) {
    var hasSlices = (core.state.slices || []).length > 0;
    if (dom.sidebarEditorContent) {
      dom.sidebarEditorContent.style.display = hasSlices ? 'block' : 'none';
    }
    if (dom.panelStep2) {
      dom.panelStep2.classList.toggle('gif-edit-blocked', !hasSlices);
    }
    if (dom.panelStep3) {
      dom.panelStep3.classList.toggle('gif-edit-blocked', !hasSlices);
    }
    if (dom.dropZone) {
      dom.dropZone.style.display = hasSlices ? 'none' : 'flex';
    }
    if (dom.dropZoneContainer) {
      dom.dropZoneContainer.style.display = hasSlices ? 'none' : 'block';
    }
    if (dom.frameIndicator) {
      var idx = (index >= 0) ? index : core.state.selectedSliceIdx;
      dom.frameIndicator.textContent = (idx >= 0 && hasSlices) ? ((idx + 1) + ' / ' + (core.state.slices.length)) : '';
    }
    updateExportEnabled();
    renderLayerList();
  } // ------------------------------------------------------------------
  // Canvas Rendering & Composition
  // ------------------------------------------------------------------

  function drawLayers(targetCtx, layers) {
    if (!layers) return;
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      targetCtx.save();
      if (l.type === 'text') {
        targetCtx.font = (l.italic ? 'italic ' : '') + (l.bold ? 'bold ' : '') + (l.size || 24) + 'px ' + (l.font || 'sans-serif');
        targetCtx.fillStyle = l.color || '#ffffff';
        targetCtx.textBaseline = 'top';
        if (l.strokeColor) {
          targetCtx.strokeStyle = l.strokeColor;
          targetCtx.lineWidth = Math.max(1, (l.size || 24) / 12);
          targetCtx.lineJoin = 'round';
          targetCtx.strokeText(l.content || '', l.x || 0, l.y || 0);
        }
        targetCtx.fillText(l.content || '', l.x || 0, l.y || 0);
        if (l.underline) {
          var mt = targetCtx.measureText(l.content || '');
          targetCtx.fillRect(l.x || 0, (l.y || 0) + (l.size || 24) * 1.05, mt.width, (l.size || 24) / 15);
        }
      } else if (l.img) {
        targetCtx.drawImage(l.img, l.x || 0, l.y || 0, l.w || 0, l.h || 0);
      }
      targetCtx.restore();
    }
  }

  // Compose one slice (base canvas + layers) into targetCanvas.
  // opts.applyTransparency: chroma-key the base before drawing layers.
  // opts.matte: fill the output background with this color first (GIF export
  // uses #FF00FF so gif.js can map it to transparency).
  function composeFrame(sliceIndex, targetCanvas, opts) {
    var slices = core.state.slices || [];
    var slice = slices[sliceIndex];
    if (!slice || !slice.canvas || !targetCanvas) return;

    var cc = document.createElement('canvas');
    cc.width = slice.canvas.width;
    cc.height = slice.canvas.height;
    var c = cc.getContext('2d');
    c.drawImage(slice.canvas, 0, 0);
    if (opts && opts.applyTransparency) applyTransparencyToCtx(c, cc.width, cc.height);
    drawLayers(c, slice.layers);

    var tx = targetCanvas.getContext('2d');
    tx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    if (opts && opts.matte) {
      tx.fillStyle = opts.matte;
      tx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    }
    tx.drawImage(cc, 0, 0, targetCanvas.width, targetCanvas.height);
  }



  function updateExportEnabled() {
    var has = (core.state.slices || []).length > 0;
    if (dom.exportBtn) dom.exportBtn.disabled = !has;
    if (dom.exportZipBtn) dom.exportZipBtn.disabled = !has;
    if (dom.exportPngBtn) dom.exportPngBtn.disabled = !has;
    if (dom.openExportBtn) dom.openExportBtn.disabled = !has;
  }

  function renderLayerList() {
    if (!dom.layerList) return;
    dom.layerList.innerHTML = '';
    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;
    if (idx < 0 || idx >= slices.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-muted);font-size:var(--font-badge);padding:4px;';
      empty.textContent = t('gifEditorNoLayer', 'No layers');
      dom.layerList.appendChild(empty);
      return;
    }
    var layers = slices[idx].layers || [];
    if (!layers.length) {
      var empty2 = document.createElement('div');
      empty2.style.cssText = 'color:var(--text-muted);font-size:var(--font-badge);padding:4px;';
      empty2.textContent = t('gifEditorNoLayer', 'No layers');
      dom.layerList.appendChild(empty2);
      return;
    }
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      var item = document.createElement('div');
      item.className = 'gif-layer-item' + (core.state.activeLayer === l ? ' gif-layer-item-active' : '');
      item.dataset.layerIndex = i;
      var label = document.createElement('span');
      label.className = 'gif-layer-label';
      label.textContent = l.type === 'text' ? ('T: ' + (l.content || '')) : 'Img'; // textContent: escaped
      var remove = document.createElement('span');
      remove.className = 'gif-layer-remove';
      remove.textContent = '×';
      remove.dataset.removeIndex = i;
      item.appendChild(label);
      item.appendChild(remove);
      dom.layerList.appendChild(item);
    }
    if (dom.selectedLayerTools) {
      dom.selectedLayerTools.style.display = core.state.activeLayer ? 'block' : 'none';
    }
  }

  function updateSourcePanels(kind) {
    if (dom.imageTools) dom.imageTools.classList.toggle('gif-hidden', kind !== 'image');
    if (dom.splitSheetContainer) dom.splitSheetContainer.style.display = (kind === 'image' ? 'block' : 'none');
    if (dom.globalDelayContainer) dom.globalDelayContainer.style.display = 'block';
    if (dom.batchDeleteContainer) dom.batchDeleteContainer.style.display = (kind === 'image' ? 'none' : 'block');
    if (dom.intervalDeleteContainer) dom.intervalDeleteContainer.style.display = (kind === 'image' ? 'none' : 'block');
    if (dom.overlayContainer) dom.overlayContainer.style.display = (kind === 'image' ? 'none' : 'block');
    if (dom.enableTrans) dom.enableTrans.checked = false;
    if (dom.transPanel) dom.transPanel.style.display = 'none';
    core.state.transparencyReady = false;
    core.state.pickColorMode = false;
    if (dom.canvasWrapper) dom.canvasWrapper.style.cursor = 'default';

    if (kind === 'image' && (dom.cropNumL || dom.sliderT)) {
      var s0 = (core.state.slices || [])[0];
      if (s0 && s0.canvas) {
        if (dom.cropNumT) dom.cropNumT.value = 0;
        if (dom.cropNumB) dom.cropNumB.value = 0;
        if (dom.cropNumL) dom.cropNumL.value = 0;
        if (dom.cropNumR) dom.cropNumR.value = 0;
        if (dom.sliderT) {
          dom.sliderT.max = Math.floor(s0.canvas.height / 2);
          dom.sliderB.max = Math.floor(s0.canvas.height / 2);
          dom.sliderL.max = Math.floor(s0.canvas.width / 2);
          dom.sliderR.max = Math.floor(s0.canvas.width / 2);
          dom.sliderT.value = 0; if (dom.cropT) dom.cropT.value = 0;
          dom.sliderB.value = 0; if (dom.cropB) dom.cropB.value = 0;
          dom.sliderL.value = 0; if (dom.cropL) dom.cropL.value = 0;
          dom.sliderR.value = 0; if (dom.cropR) dom.cropR.value = 0;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Chroma-key transparency (magic wand)
  // ------------------------------------------------------------------

  function toggleTransPanel() {
    if (dom.transPanel) dom.transPanel.style.display = dom.enableTrans.checked ? 'block' : 'none';
    rebakeImageFrame();
    draw();
  }

  function transParamChanged() {
    core.state.transparencyReady = true;
    rebakeImageFrame();
    draw();
  }

  // For imported images the (single, not-yet-sliced) frame doubles as the
  // source: re-apply the chroma key to the frame + processedImg so the grid
  // slice and every export see the transparent pixels.
  function rebakeImageFrame() {
    if (!isImageUnsliced()) return;
    var src = core.state.slices[0].canvas;
    var c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    var cctx = c.getContext('2d');
    cctx.drawImage(src, 0, 0);
    applyTransparencyToCtx(cctx, c.width, c.height);
    core.state.slices[0].canvas = c;
    core.state.processedImg = c;
    if (core.timeline) core.timeline.clearThumbCache();
    if (core.timeline && core.timeline.render) core.timeline.render();
  }

  function applyTransparencyToCtx(targetCtx, width, height) {
    if (!dom.enableTrans || !dom.enableTrans.checked) return;
    if (!core.state.transparencyReady) return;
    var d = targetCtx.getImageData(0, 0, width, height);
    var data = d.data;
    var hex = dom.keyColor.value;
    var r = parseInt(hex.slice(1, 3), 16),
        g = parseInt(hex.slice(3, 5), 16),
        b = parseInt(hex.slice(5, 7), 16);
    var f = parseFloat(dom.fuzziness.value) * 2.55;
    if (isNaN(f)) f = 0;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      if (Math.abs(data[i] - r) <= f &&
          Math.abs(data[i + 1] - g) <= f &&
          Math.abs(data[i + 2] - b) <= f) {
        data[i + 3] = 0;
      }
    }
    targetCtx.putImageData(d, 0, 0);
  }

  function pickColorClick() {
    if (window.EyeDropper) {
      try {
        var ed = new EyeDropper();
        ed.open().then(function (result) {
          dom.keyColor.value = result.sRGBHex;
          core.state.transparencyReady = true;
          rebakeImageFrame();
          draw();
        }).catch(function () { /* user cancelled */ });
      } catch (e) { /* fall through to manual mode */ }
    } else {
      core.state.pickColorMode = !core.state.pickColorMode;
      if (core.state.pickColorMode) {
        dom.canvasWrapper.style.cursor = 'crosshair';
        dom.stageOverlayText.innerText = t('gifEditorPickColorHintStage');
        dom.pickColorBtn.classList.add('active');
      } else {
        dom.canvasWrapper.style.cursor = 'default';
        dom.stageOverlayText.innerText = t('gifEditorPickColorCancelled');
        dom.pickColorBtn.classList.remove('active');
      }
    }
  }

  function cancelPickColor() {
    core.state.pickColorMode = false;
    dom.canvasWrapper.style.cursor = 'default';
    dom.stageOverlayText.innerText = t('gifEditorPickColorCancelled');
    dom.pickColorBtn.classList.remove('active');
  }

  // ------------------------------------------------------------------
  // Edge crop + grid slice (image source)
  // ------------------------------------------------------------------

  function isImageUnsliced() {
    return core.state.source.kind === 'image' && !core.state.source.gridSliced &&
      (core.state.slices || []).length === 1;
  }

  function edgeCropValues(w, h) {
    var tVal = (dom.cropT && parseInt(dom.cropT.value, 10)) || 0,
        bVal = (dom.cropB && parseInt(dom.cropB.value, 10)) || 0,
        lVal = (dom.cropL && parseInt(dom.cropL.value, 10)) || 0,
        rVal = (dom.cropR && parseInt(dom.cropR.value, 10)) || 0;
    var maxT = Math.max(0, h - 1), maxL = Math.max(0, w - 1);
    tVal = Math.max(0, Math.min(maxT, tVal));
    bVal = Math.max(0, Math.min(maxT, bVal));
    lVal = Math.max(0, Math.min(maxL, lVal));
    rVal = Math.max(0, Math.min(maxL, rVal));
    return { t: tVal, b: bVal, l: lVal, r: rVal };
  }

  // Grid preview overlay (dimmed edges + row/col lines).
  function drawEdgeCropGrid(w, h) {
    if (!dom.cropT || !dom.cropB || !dom.cropL || !dom.cropR) return;
    var c = edgeCropValues(w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, c.t);
    ctx.fillRect(0, h - c.b, w, c.b);
    ctx.fillRect(0, c.t, c.l, h - c.t - c.b);
    ctx.fillRect(w - c.r, c.t, c.r, h - c.t - c.b);
    ctx.strokeStyle = '#ff0055';
    ctx.lineWidth = 2;
    ctx.strokeRect(c.l, c.t, w - c.l - c.r, h - c.t - c.b);

    var rows = parseInt(dom.rows.value, 10) || 1,
        cols = parseInt(dom.cols.value, 10) || 1;
    var sw = (w - c.l - c.r) / cols, sh = (h - c.t - c.b) / rows;
    ctx.strokeStyle = '#00ffaa';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 1; i < cols; i++) {
      ctx.moveTo(c.l + i * sw, c.t);
      ctx.lineTo(c.l + i * sw, h - c.b);
    }
    for (var j = 1; j < rows; j++) {
      ctx.moveTo(c.l, c.t + j * sh);
      ctx.lineTo(w - c.r, c.t + j * sh);
    }
    ctx.stroke();
  }

  function runSlice() {
    var src = core.state.processedImg ||
      ((core.state.slices && core.state.slices[0]) ? core.state.slices[0].canvas : null);
    if (!src) { alert(t('gifEditorAlertNoImage')); return; }

    var c = edgeCropValues(src.width, src.height);
    var rows = parseInt(dom.rows.value, 10) || 1,
        cols = parseInt(dom.cols.value, 10) || 1;
    rows = Math.max(1, rows);
    cols = Math.max(1, cols);

    var w = src.width - c.l - c.r;
    var h = src.height - c.t - c.b;
    var sw = Math.max(1, Math.round(w / cols));
    var sh = Math.max(1, Math.round(h / rows));

    var newSlices = [];
    for (var r = 0; r < rows; r++) {
      for (var cc = 0; cc < cols; cc++) {
        var sc = document.createElement('canvas');
        sc.width = sw;
        sc.height = sh;
        sc.getContext('2d').drawImage(
          src,
          c.l + cc * sw, c.t + r * sh, sw, sh,
          0, 0, sw, sh
        );
        newSlices.push({ id: core.freshId(), canvas: sc, delay: 500, layers: [] });
      }
    }

    core.state.slices = newSlices;
    core.state.source.gridSliced = true;
    dom.outW.value = sw;
    dom.outH.value = sh;
    if (core.timeline) core.timeline.render();
    if (core.commands.focusFrame) core.commands.focusFrame(0);
    else { core.state.selectedSliceIdx = 0; draw(); }
  }

  // ------------------------------------------------------------------
  // Global crop (rect applied to every frame, layer coords offset)
  // ------------------------------------------------------------------

  function setupCropSliders() {
    dom.cropNumL = core.byId('crop-num-l');
    dom.cropNumR = core.byId('crop-num-r');
    dom.cropNumT = core.byId('crop-num-t');
    dom.cropNumB = core.byId('crop-num-b');

    var getCanvasDims = function () {
      var slices = core.state.slices || [];
      if (core.state.selectedSliceIdx >= 0 && slices[core.state.selectedSliceIdx]) {
        var c = slices[core.state.selectedSliceIdx].canvas;
        return { width: c.width, height: c.height };
      }
      if (core.state.processedImg) {
        return { width: core.state.processedImg.width, height: core.state.processedImg.height };
      }
      return { width: 800, height: 600 };
    };

    var updateFromEdgeInputs = function () {
      var dims = getCanvasDims();
      var l = parseInt(dom.cropNumL ? dom.cropNumL.value : 0, 10);
      var r = parseInt(dom.cropNumR ? dom.cropNumR.value : 0, 10);
      var t = parseInt(dom.cropNumT ? dom.cropNumT.value : 0, 10);
      var b = parseInt(dom.cropNumB ? dom.cropNumB.value : 0, 10);

      if (isNaN(l)) l = 0;
      if (isNaN(r)) r = 0;
      if (isNaN(t)) t = 0;
      if (isNaN(b)) b = 0;

      l = Math.max(0, Math.min(dims.width - 1, l));
      r = Math.max(0, Math.min(dims.width - l - 1, r));
      t = Math.max(0, Math.min(dims.height - 1, t));
      b = Math.max(0, Math.min(dims.height - t - 1, b));

      if (dom.cropNumL) dom.cropNumL.value = l;
      if (dom.cropNumR) dom.cropNumR.value = r;
      if (dom.cropNumT) dom.cropNumT.value = t;
      if (dom.cropNumB) dom.cropNumB.value = b;

      core.state.cropRect = {
        x: l,
        y: t,
        w: Math.max(1, dims.width - l - r),
        h: Math.max(1, dims.height - t - b)
      };
      draw();
    };

    var inputs = [dom.cropNumL, dom.cropNumR, dom.cropNumT, dom.cropNumB];
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i]) {
        inputs[i].addEventListener('input', updateFromEdgeInputs);
        inputs[i].addEventListener('change', updateFromEdgeInputs);
      }
    }
  }

  function syncCropSlidersFromRect() {
    if (core.state.mode !== 'crop') return;
    var r = core.state.cropRect;
    var slices = core.state.slices || [];
    var dims = { width: 800, height: 600 };
    if (core.state.selectedSliceIdx >= 0 && slices[core.state.selectedSliceIdx]) {
      var c = slices[core.state.selectedSliceIdx].canvas;
      dims = { width: c.width, height: c.height };
    } else if (core.state.processedImg) {
      dims = { width: core.state.processedImg.width, height: core.state.processedImg.height };
    }

    var leftVal = Math.max(0, Math.round(r.x));
    var topVal = Math.max(0, Math.round(r.y));
    var rightVal = Math.max(0, Math.round(dims.width - (r.x + r.w)));
    var bottomVal = Math.max(0, Math.round(dims.height - (r.y + r.h)));

    if (dom.cropNumL) { dom.cropNumL.max = dims.width; dom.cropNumL.value = leftVal; }
    if (dom.cropNumR) { dom.cropNumR.max = dims.width; dom.cropNumR.value = rightVal; }
    if (dom.cropNumT) { dom.cropNumT.max = dims.height; dom.cropNumT.value = topVal; }
    if (dom.cropNumB) { dom.cropNumB.max = dims.height; dom.cropNumB.value = bottomVal; }
  }

  function startGlobalCrop() {
    var slices = core.state.slices || [];
    if (core.state.selectedSliceIdx < 0 || !slices[core.state.selectedSliceIdx]) {
      alert(t('gifEditorAlertSliceFirst'));
      return;
    }
    var cur = slices[core.state.selectedSliceIdx].canvas;
    var pW = 0, pH = 0;
    core.state.cropRect = { x: 0, y: 0, w: cur.width, h: cur.height };
    if (dom.cropNumX) dom.cropNumX.max = cur.width;
    if (dom.cropNumW) dom.cropNumW.max = cur.width;
    if (dom.cropNumY) dom.cropNumY.max = cur.height;
    if (dom.cropNumH) dom.cropNumH.max = cur.height;
    core.state.mode = 'crop';
    syncCropSlidersFromRect();
    if (dom.cropPanel) {
      dom.cropPanel.classList.add('active');
      dom.cropPanel.style.display = 'block';
    }
    draw();
  }

  function cancelCrop() {
    core.state.mode = 'editor';
    if (dom.cropPanel) {
      dom.cropPanel.classList.remove('active');
      dom.cropPanel.style.display = 'none';
    }
    draw();
  }

  function applyCrop() {
    var r = core.state.cropRect;
    if (r.w <= 0 || r.h <= 0) return;
    core.showSpinner(t('gifEditorCropping'));
    setTimeout(function () {
      var slices = core.state.slices || [];
      for (var i = 0; i < slices.length; i++) {
        var tCanvas = document.createElement('canvas');
        tCanvas.width = Math.round(r.w);
        tCanvas.height = Math.round(r.h);
        tCanvas.getContext('2d').drawImage(slices[i].canvas, r.x, r.y, r.w, r.h, 0, 0, Math.round(r.w), Math.round(r.h));
        slices[i].canvas = tCanvas;
        var layers = slices[i].layers || [];
        for (var j = 0; j < layers.length; j++) {
          layers[j].x -= r.x;
          layers[j].y -= r.y;
        }
      }
      core.state.mode = 'editor';
      if (dom.outW) dom.outW.value = Math.round(r.w);
      if (dom.outH) dom.outH.value = Math.round(r.h);
      if (dom.cropPanel) dom.cropPanel.classList.remove('active');
      if (core.timeline) core.timeline.clearThumbCache(); // slice canvases replaced
      if (core.timeline && core.timeline.render) core.timeline.render();
      if (core.commands.focusFrame) core.commands.focusFrame(core.state.selectedSliceIdx);
      else draw();
      core.hideSpinner();
    }, 50);
  }

  // ------------------------------------------------------------------
  // Layers (text / image; scope current/all/range; sync by groupId)
  // ------------------------------------------------------------------

  function getTargetIndices() {
    var scopeEl = document.querySelector('input[name="gif-scope"]:checked');
    if (!scopeEl) return [];
    var scope = scopeEl.value;
    var slices = core.state.slices || [];
    if (core.state.selectedSliceIdx < 0) {
      alert(t('gifEditorAlertNoFrameSelected'));
      return [];
    }
    if (scope === 'current') return [core.state.selectedSliceIdx];
    if (scope === 'all') {
      var all = [];
      for (var i = 0; i < slices.length; i++) all.push(i);
      return all;
    }
    var s = parseInt(dom.rangeStart ? dom.rangeStart.value : '', 10);
    var e = parseInt(dom.rangeEnd ? dom.rangeEnd.value : '', 10);
    if (isNaN(s) || isNaN(e)) { alert(t('gifEditorAlertRangeInvalid')); return []; }
    if (s < 1 || e < 1) { alert(t('gifEditorAlertRangeMin')); return []; }
    if (s > e) { alert(t('gifEditorAlertRangeOrder')); return []; }
    var idxs = [];
    for (var k = s - 1; k <= e - 1 && k < slices.length; k++) {
      if (k >= 0) idxs.push(k);
    }
    return idxs;
  }

  function addText() {
    var idxs = getTargetIndices();
    var txt = dom.addTextInput.value;
    if (!idxs.length || !txt) return;
    var ref = core.state.slices[core.state.selectedSliceIdx];
    var gid = core.freshId();
    for (var i = 0; i < idxs.length; i++) {
      core.state.slices[idxs[i]].layers.push({
        id: core.freshId(),
        groupId: gid,
        type: 'text',
        content: txt,
        color: dom.addTextColor.value,
        strokeColor: dom.strokeColor ? dom.strokeColor.value : '#000000',
        font: 'sans-serif',
        size: ref.canvas.height / 5,
        x: ref.canvas.width / 2,
        y: ref.canvas.height / 2,
        bold: core.state.textStyle.bold,
        italic: core.state.textStyle.italic,
        underline: core.state.textStyle.underline
      });
    }
    updateSelectionUI(core.state.selectedSliceIdx);
    draw();
  }

  function addImageFromFile(file) {
    var idxs = getTargetIndices();
    if (!idxs.length || !file) return;
    var r = new FileReader();
    r.onload = function (evt) {
      var img = new Image();
      img.onload = function () {
        var ref = core.state.slices[core.state.selectedSliceIdx];
        var w = ref.canvas.width / 3;
        var h = w * (img.height / img.width);
        var gid = core.freshId();
        for (var i = 0; i < idxs.length; i++) {
          core.state.slices[idxs[i]].layers.push({
            id: core.freshId(),
            groupId: gid,
            type: 'image',
            img: img,
            w: w,
            h: h,
            x: 10,
            y: 10
          });
        }
        updateSelectionUI(core.state.selectedSliceIdx);
        draw();
      };
      img.src = evt.target.result;
    };
    r.readAsDataURL(file);
  }

  function toggleStyle(p, btnName) {
    core.state.textStyle[p] = !core.state.textStyle[p];
    dom[btnName].classList.toggle('active', core.state.textStyle[p]);
    if (core.state.activeLayer && core.state.activeLayer.type === 'text') {
      core.state.activeLayer[p] = core.state.textStyle[p];
      draw();
    }
  }


  function removeLayer(i) {
    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;
    if (idx < 0 || idx >= slices.length) return;
    slices[idx].layers.splice(i, 1);
    core.state.activeLayer = null;
    updateSelectionUI(idx);
    draw();
  }

  function onLayerListClick(e) {
    var removeEl = e.target.closest('.gif-layer-remove');
    if (removeEl) {
      removeLayer(parseInt(removeEl.dataset.removeIndex, 10));
      return;
    }
    var item = e.target.closest('.gif-layer-item');
    if (!item) return;
    var layers = (core.state.slices[core.state.selectedSliceIdx] || {}).layers || [];
    var layer = layers[parseInt(item.dataset.layerIndex, 10)];
    if (!layer) return;
    core.state.activeLayer = layer;
    if (layer.type === 'text') {
      core.state.textStyle.bold = !!layer.bold;
      core.state.textStyle.italic = !!layer.italic;
      core.state.textStyle.underline = !!layer.underline;
      if (dom.btnBold) dom.btnBold.classList.toggle('active', !!layer.bold);
      if (dom.btnItalic) dom.btnItalic.classList.toggle('active', !!layer.italic);
      if (dom.btnUnderline) dom.btnUnderline.classList.toggle('active', !!layer.underline);
      if (dom.addTextColor) dom.addTextColor.value = layer.color || '#ffffff';
      if (dom.strokeColor) dom.strokeColor.value = layer.strokeColor || '#000000';
    }
    layerBase = { size: layer.size, w: layer.w, h: layer.h };
    if (dom.layerScale) dom.layerScale.value = 1;
    updateSelectionUI(core.state.selectedSliceIdx);
    draw();
  }

  // ------------------------------------------------------------------
  // Stage interaction: pan/zoom, crop gizmo, layer gizmo, color pick
  // ------------------------------------------------------------------

  function getPointerPos(e) {
    var rect = canvas.getBoundingClientRect();
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  function handlePointerDown(e) {
    if (e.target === canvas) e.preventDefault();
    var coords = getPointerPos(e);

    if (core.state.pickColorMode) {
      var px = ctx.getImageData(Math.floor(coords.x), Math.floor(coords.y), 1, 1).data;
      var hex = '#' + [px[0], px[1], px[2]].map(function (x) {
        var s = x.toString(16);
        return s.length === 1 ? '0' + s : s;
      }).join('');
      dom.keyColor.value = hex;
      core.state.transparencyReady = true;
      rebakeImageFrame();
      draw();
      core.state.pickColorMode = false;
      dom.canvasWrapper.style.cursor = 'default';
      dom.stageOverlayText.innerText = t('gifEditorPickColorDone') + hex;
      dom.pickColorBtn.classList.remove('active');
      return;
    }

    if (core.state.mode === 'crop') {
      var h = checkHandleHit(coords.x, coords.y, core.state.cropRect);
      if (h) { startInteraction(e, h, core.state.cropRect); return; }
      if (coords.x >= core.state.cropRect.x && coords.x <= core.state.cropRect.x + core.state.cropRect.w &&
          coords.y >= core.state.cropRect.y && coords.y <= core.state.cropRect.y + core.state.cropRect.h) {
        startInteraction(e, 'move', core.state.cropRect);
        return;
      }
      startPan(e);
      return;
    }

    if (core.state.mode === 'editor') {
      if (core.state.activeLayer && checkHandleHit(coords.x, coords.y, core.state.activeLayer)) {
        startInteraction(e, checkHandleHit(coords.x, coords.y, core.state.activeLayer), core.state.activeLayer);
        return;
      }
      var hit = checkLayerHit(coords.x, coords.y);
      if (hit) {
        core.state.activeLayer = hit;
        if (hit.type === 'text') {
          core.state.textStyle.bold = !!hit.bold;
          core.state.textStyle.italic = !!hit.italic;
          core.state.textStyle.underline = !!hit.underline;
          if (dom.btnBold) dom.btnBold.classList.toggle('active', !!hit.bold);
          if (dom.btnItalic) dom.btnItalic.classList.toggle('active', !!hit.italic);
          if (dom.btnUnderline) dom.btnUnderline.classList.toggle('active', !!hit.underline);
          if (dom.addTextColor) dom.addTextColor.value = hit.color || '#ffffff';
          if (dom.strokeColor) dom.strokeColor.value = hit.strokeColor || '#000000';
        }
        layerBase = { size: hit.size, w: hit.w, h: hit.h };
        if (dom.layerScale) dom.layerScale.value = 1;
        startInteraction(e, 'move', hit);
        updateSelectionUI(core.state.selectedSliceIdx);
      } else {
        if (core.state.activeLayer) {
          core.state.activeLayer = null;
          updateSelectionUI(core.state.selectedSliceIdx);
          draw();
        }
        startPan(e);
      }
      return;
    }
    startPan(e);
  }
  // Stage wheel zoom (scoped to the stage, so app-shell keys/clicks are untouched).
  function handleWheel(e) {
    if (!core.state.slices || !core.state.slices.length) return;
    e.preventDefault();
    var delta = e.deltaY < 0 ? 0.08 : -0.08;
    var newScale = Math.max(0.1, Math.min(3.0, core.state.scale * (1 + delta)));
    core.state.scale = newScale;
    updateTransform();
  }

  function onPointerMove(e) {
    if (core.state.isDraggingStage) {
      e.preventDefault();
      var cx = e.touches ? e.touches[0].clientX : e.clientX;
      var cy = e.touches ? e.touches[0].clientY : e.clientY;
      core.state.panX = cx - core.state.startX;
      core.state.panY = cy - core.state.startY;
      updateTransform();
      return;
    }
    if (core.state.interactionMode) {
      e.preventDefault();
      handleInteraction(e);
    }
  }

  function onPointerUp() {
    core.state.isDraggingStage = false;
    core.state.interactionMode = null;
    if (dom.canvasWrapper) dom.canvasWrapper.style.cursor = 'default';
  }

  function startPan(e) {
    core.state.isDraggingStage = true;
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    core.state.startX = cx - core.state.panX;
    core.state.startY = cy - core.state.panY;
    if (dom.canvasWrapper) dom.canvasWrapper.style.cursor = 'grabbing';
  }

  function startInteraction(e, mode, target) {
    core.state.interactionMode = mode;
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    core.state.startMouseX = cx;
    core.state.startMouseY = cy;
    core.state.startLayerState = {
      x: target.x, y: target.y,
      w: target.w || 0, h: target.h || 0,
      size: target.size || 0
    };
  }

  function handleInteraction(e) {
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    var dx = (cx - core.state.startMouseX) / core.state.scale;
    var dy = (cy - core.state.startMouseY) / core.state.scale;
    var t = core.state.mode === 'crop' ? core.state.cropRect : core.state.activeLayer;
    var s = core.state.startLayerState;
    if (!t) return;

    if (core.state.mode === 'crop') {
      var dims = getEffectiveDimensions();
      var imgW = dims.w;
      var imgH = dims.h;
      var minW = 10, minH = 10;

      if (core.state.interactionMode === 'move') {
        t.x = Math.max(0, Math.min(imgW - s.w, s.x + dx));
        t.y = Math.max(0, Math.min(imgH - s.h, s.y + dy));
      } else {
        var mode = core.state.interactionMode;
        var nx = s.x, ny = s.y, nw = s.w, nh = s.h;

        if (mode.indexOf('r') >= 0) {
          nw = Math.max(minW, Math.min(imgW - s.x, s.w + dx));
        }
        if (mode.indexOf('b') >= 0) {
          nh = Math.max(minH, Math.min(imgH - s.y, s.h + dy));
        }
        if (mode.indexOf('l') >= 0) {
          nx = Math.max(0, Math.min(s.x + s.w - minW, s.x + dx));
          nw = s.x + s.w - nx;
        }
        if (mode.indexOf('t') >= 0) {
          ny = Math.max(0, Math.min(s.y + s.h - minH, s.y + dy));
          nh = s.y + s.h - ny;
        }

        t.x = nx;
        t.y = ny;
        t.w = nw;
        t.h = nh;
      }
      syncCropSlidersFromRect();
      draw();
      return;
    }

    if (core.state.interactionMode === 'move') {
      t.x = s.x + dx;
      t.y = s.y + dy;
    } else {
      if (t.type === 'text') {
        var d = core.state.interactionMode.indexOf('b') >= 0 ? dy : -dy;
        t.size = Math.max(8, s.size + d);
      } else {
        var nx = s.x, ny = s.y, nw = s.w, nh = s.h;
        if (core.state.interactionMode.indexOf('r') >= 0) nw = s.w + dx;
        if (core.state.interactionMode.indexOf('b') >= 0) nh = s.h + dy;
        if (core.state.interactionMode.indexOf('l') >= 0) { nx = s.x + dx; nw = s.w - dx; }
        if (core.state.interactionMode.indexOf('t') >= 0) { ny = s.y + dy; nh = s.h - dy; }
        if (nw > 5 && nh > 5) { t.x = nx; t.y = ny; t.w = nw; t.h = nh; }
      }
    }

    var applyAll = dom.layerApplyAll ? dom.layerApplyAll.checked : true;
    if (applyAll && t.groupId) {
      var slices = core.state.slices || [];
      for (var sIdx = 0; sIdx < slices.length; sIdx++) {
        var layers = slices[sIdx].layers || [];
        for (var lIdx = 0; lIdx < layers.length; lIdx++) {
          var l = layers[lIdx];
          if (l && l.groupId === t.groupId && l !== t) {
            if (core.state.interactionMode === 'move') {
              l.x = t.x;
              l.y = t.y;
            } else {
              l.x = t.x;
              l.y = t.y;
              if (l.type === 'text') {
                l.size = t.size;
              } else {
                l.w = t.w;
                l.h = t.h;
              }
            }
          }
        }
      }
    }

    draw();
  }

  function drawGizmo(o, defaultColor, isCrop) {
    var x, y, w, h;
    if (o.type === 'text') {
      ctx.font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + (o.size || 24) + 'px ' + (o.font || 'sans-serif');
      var m = ctx.measureText(o.content || '');
      x = o.x || 0; y = o.y || 0; w = m.width; h = o.size || 24;
    } else {
      x = o.x || 0; y = o.y || 0; w = o.w || 0; h = o.h || 0;
    }
    ctx.save();

    var primaryColor = defaultColor || '#3b82f6';
    if (isCrop) {
      try {
        var computedStyle = getComputedStyle(document.documentElement);
        var themeAccent = computedStyle.getPropertyValue('--accent-color').trim() ||
                          computedStyle.getPropertyValue('--accent').trim() ||
                          computedStyle.getPropertyValue('--primary-color').trim();
        if (themeAccent) primaryColor = themeAccent;
      } catch (e) {}
      if (!primaryColor || primaryColor === '#ef4444') primaryColor = '#a855f7';
    }

    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 2;
    if (isCrop) {
      ctx.strokeRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
    } else {
      ctx.strokeRect(x, y, w, h);
    }

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 2;
    var hs = isCrop ? 7 : 6;

    var dH = function (hx, hy) {
      ctx.beginPath();
      var hx0 = hx - hs, hy0 = hy - hs, hs2 = hs * 2;
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(hx0, hy0, hs2, hs2, 3);
      } else {
        ctx.rect(hx0, hy0, hs2, hs2);
      }
      ctx.fill();
      ctx.stroke();
    };

    dH(x, y);
    dH(x + w, y);
    dH(x, y + h);
    dH(x + w, y + h);
    ctx.restore();
  }

  function checkLayerHit(x, y) {
    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;
    if (idx < 0 || idx >= slices.length) return null;
    var layers = slices[idx].layers || [];
    for (var i = layers.length - 1; i >= 0; i--) {
      var o = layers[i];
      var bx, by, bw, bh;
      if (o.type === 'text') {
        ctx.font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + (o.size || 24) + 'px ' + (o.font || 'sans-serif');
        var m = ctx.measureText(o.content || '');
        bx = o.x || 0; by = o.y || 0; bw = m.width; bh = o.size || 24;
      } else {
        bx = o.x || 0; by = o.y || 0; bw = o.w || 0; bh = o.h || 0;
      }
      if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) return o;
    }
    return null;
  }

  function checkHandleHit(mx, my, o) {
    var x, y, w, h;
    if (o.type === 'text') {
      ctx.font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + (o.size || 24) + 'px ' + (o.font || 'sans-serif');
      var m = ctx.measureText(o.content || '');
      x = o.x || 0; y = o.y || 0; w = m.width; h = o.size || 24;
    } else {
      x = o.x || 0; y = o.y || 0; w = o.w || 0; h = o.h || 0;
    }
    var hs = 15;
    if (Math.abs(mx - x) < hs && Math.abs(my - y) < hs) return 'tl';
    if (Math.abs(mx - (x + w)) < hs && Math.abs(my - y) < hs) return 'tr';
    if (Math.abs(mx - x) < hs && Math.abs(my - (y + h)) < hs) return 'bl';
    if (Math.abs(mx - (x + w)) < hs && Math.abs(my - (y + h)) < hs) return 'br';
    return null;
  }

  // ------------------------------------------------------------------
  // Preview draw
  // ------------------------------------------------------------------

  function draw() {
    if (!canvas || !ctx) return;
    ctx.imageSmoothingEnabled = false;
    if ('webkitImageSmoothingEnabled' in ctx) ctx.webkitImageSmoothingEnabled = false;
    if ('mozImageSmoothingEnabled' in ctx) ctx.mozImageSmoothingEnabled = false;
    if ('msImageSmoothingEnabled' in ctx) ctx.msImageSmoothingEnabled = false;

    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;

    var rawCanvas = null;
    if (core.state.mode === 'source' && core.state.processedImg) {
      rawCanvas = core.state.processedImg;
    } else if (idx >= 0 && slices[idx] && slices[idx].canvas) {
      rawCanvas = slices[idx].canvas;
    }

    if (!rawCanvas) return;

    var origW = rawCanvas.width || 800;
    var origH = rawCanvas.height || 600;

    if (canvas.width !== origW) canvas.width = origW;
    if (canvas.height !== origH) canvas.height = origH;
    ctx.clearRect(0, 0, origW, origH);

    var isSplitOpen = dom.splitSheetPanel && dom.splitSheetPanel.style.display !== 'none' && core.state.source && core.state.source.kind === 'image';
    var splitScaleRatio = isSplitOpen ? ((parseInt(dom.splitScale ? dom.splitScale.value : 100, 10) || 100) / 100) : 1;

    // Source / Frame image draw with crisp pixel scaling if scale < 1
    var sourceDrawImg = rawCanvas;
    if (dom.enableTrans && dom.enableTrans.checked && core.state.transparencyReady && slices[idx]) {
      var tempC = document.createElement('canvas');
      tempC.width = origW;
      tempC.height = origH;
      var tCtx = tempC.getContext('2d');
      tCtx.drawImage(rawCanvas, 0, 0);
      applyTransparencyToCtx(tCtx, origW, origH);
      sourceDrawImg = tempC;
    }

    if (splitScaleRatio < 1.0) {
      // Offscreen crisp downsampling for pixelated preview
      var scaledW = Math.max(1, Math.round(origW * splitScaleRatio));
      var scaledH = Math.max(1, Math.round(origH * splitScaleRatio));
      var offCanvas = document.createElement('canvas');
      offCanvas.width = scaledW;
      offCanvas.height = scaledH;
      var offCtx = offCanvas.getContext('2d');
      offCtx.imageSmoothingEnabled = false;
      if ('webkitImageSmoothingEnabled' in offCtx) offCtx.webkitImageSmoothingEnabled = false;
      if ('mozImageSmoothingEnabled' in offCtx) offCtx.mozImageSmoothingEnabled = false;
      offCtx.drawImage(sourceDrawImg, 0, 0, origW, origH, 0, 0, scaledW, scaledH);

      // Render back to full stage canvas with sharp pixelated edges
      ctx.drawImage(offCanvas, 0, 0, scaledW, scaledH, 0, 0, origW, origH);
    } else {
      ctx.drawImage(sourceDrawImg, 0, 0, origW, origH);
    }

    if (slices[idx]) drawLayers(ctx, slices[idx].layers);
    if (isImageUnsliced()) drawEdgeCropGrid(origW, origH);
    if (core.state.source && core.state.source.kind === 'image') drawSplitGridOverlay(origW, origH);
    if (core.state.mode === 'editor' && core.state.activeLayer) drawGizmo(core.state.activeLayer, '#3b82f6');
    if (core.state.mode === 'crop') {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, origW, origH);
      var cr = core.state.cropRect;
      ctx.clearRect(cr.x, cr.y, cr.w, cr.h);
      if (slices[idx]) ctx.drawImage(slices[idx].canvas, cr.x, cr.y, cr.w, cr.h, cr.x, cr.y, cr.w, cr.h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(cr.x, cr.y, cr.w, cr.h);
      ctx.clip();
      if (slices[idx]) drawLayers(ctx, slices[idx].layers);
      ctx.restore();
      drawGizmo(core.state.cropRect, '#ef4444', true);
    }

    updateStageOverlay();
  }

  function drawSplitGridOverlay(w, h) {
    if (!dom.splitSheetPanel || dom.splitSheetPanel.style.display === 'none') return;
    if (!dom.splitCols || !dom.splitRows) return;
    var scale = (parseInt(dom.splitScale ? dom.splitScale.value : 100, 10) || 100) / 100;
    var innerGap = Math.round((parseInt(dom.splitInnerGap ? dom.splitInnerGap.value : 0, 10) || 0) * scale);
    var outerMargin = (dom.splitEnableOuter && dom.splitEnableOuter.checked) ? Math.round((parseInt(dom.splitOuterMargin ? dom.splitOuterMargin.value : 0, 10) || 0) * scale) : 0;
    var cols, rows, cellW, cellH;

    if (core.state.splitMode === 'uneven') {
      cellW = Math.max(1, Math.round((parseInt(dom.splitCols.value, 10) || 64) * scale));
      cellH = Math.max(1, Math.round((parseInt(dom.splitRows.value, 10) || 64) * scale));
      cols = Math.max(1, Math.floor((w - outerMargin * 2 + innerGap) / (cellW + innerGap)));
      rows = Math.max(1, Math.floor((h - outerMargin * 2 + innerGap) / (cellH + innerGap)));
    } else {
      cols = Math.max(1, parseInt(dom.splitCols.value, 10) || 1);
      rows = Math.max(1, parseInt(dom.splitRows.value, 10) || 1);
      var availW = Math.max(0, w - outerMargin * 2 - innerGap * (cols - 1));
      var availH = Math.max(0, h - outerMargin * 2 - innerGap * (rows - 1));
      cellW = availW / cols;
      cellH = availH / rows;
    }

    ctx.save();
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = outerMargin + c * (cellW + innerGap);
        var y = outerMargin + r * (cellH + innerGap);

        ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, cellW, cellH);

        ctx.strokeStyle = '#00ffaa';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, cellW, cellH);

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - 2, y - 2, 5, 5);
        ctx.fillRect(x + cellW - 2, y - 2, 5, 5);
        ctx.fillRect(x - 2, y + cellH - 2, 5, 5);
        ctx.fillRect(x + cellW - 2, y + cellH - 2, 5, 5);
      }
    }
    ctx.restore();
  }

  function updateStageOverlay() {
    if (!dom.stageOverlayText) return;
    if (core.state.pickColorMode) return;
    var slices = core.state.slices || [];
    var hasContent = (slices.length > 0) || !!core.state.processedImg;
    if (hasContent) {
      dom.stageOverlayText.style.display = 'none';
    } else {
      dom.stageOverlayText.style.display = 'block';
      dom.stageOverlayText.textContent = t('gifEditorStageIdle', 'Waiting for upload...');
    }
  }

  // ------------------------------------------------------------------
  // Stage transform (fit on reset, zoom/pan around)
  // ------------------------------------------------------------------

  function getEffectiveDimensions() {
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      return { w: canvas.width, h: canvas.height };
    }
    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;
    if (core.state.mode === 'source' && core.state.processedImg) {
      return { w: core.state.processedImg.width, h: core.state.processedImg.height };
    } else if (idx >= 0 && slices[idx] && slices[idx].canvas) {
      return { w: slices[idx].canvas.width, h: slices[idx].canvas.height };
    }
    return { w: 0, h: 0 };
  }

  function resetView() {
    var dims = getEffectiveDimensions();
    var w = dims.w;
    var h = dims.h;
    if (!w || !h) {
      core.state.scale = 1;
      core.state.panX = 0;
      core.state.panY = 0;
      updateTransform();
      return;
    }
    var cw = dom.stage ? dom.stage.clientWidth : 800;
    var ch = dom.stage ? dom.stage.clientHeight : 600;
    if (cw <= 0) cw = 800;
    if (ch <= 0) ch = 600;

    var fitScale = Math.min((cw - 40) / w, (ch - 40) / h);
    core.state.scale = Math.max(0.05, fitScale);
    core.state.panX = (cw - w) / 2;
    core.state.panY = (ch - h) / 2;
    updateTransform();
  }

  function updateTransform() {
    if (dom.canvasWrapper) {
      dom.canvasWrapper.style.transform =
        'translate(' + core.state.panX + 'px, ' + core.state.panY + 'px) scale(' + core.state.scale + ')';
    }
    var zoomRange = document.getElementById('gif-timeline-zoom-range');
    var zoomVal = document.getElementById('gif-timeline-zoom-value');
    if (zoomRange && Math.abs(parseFloat(zoomRange.value) - core.state.scale) > 0.001) {
      zoomRange.value = core.state.scale;
    }
    if (zoomVal) {
      zoomVal.textContent = Math.round(core.state.scale * 100) + '%';
    }
  }

  // ------------------------------------------------------------------
  // Batch frame delete / keep + batch delay
  // ------------------------------------------------------------------

  function getBatchRange() {
    var s = parseInt(dom.delStart.value, 10);
    var e = parseInt(dom.delEnd.value, 10);
    if (isNaN(s) || isNaN(e)) {
      alert(t('gifEditorAlertRangeInvalid'));
      return null;
    }
    if (s < 1 || e < 1) {
      alert(t('gifEditorAlertRangeMin'));
      return null;
    }
    if (s > e) {
      alert(t('gifEditorAlertRangeOrder'));
      return null;
    }
    return { start: s - 1, end: e - 1 };
  }

  function showConfirmModal(opts) {
    var overlay = document.getElementById('modal-overlay');
    if (!overlay) {
      if (opts && opts.onConfirm) opts.onConfirm();
      return;
    }
    opts = opts || {};
    var title = opts.title || t('confirmTitle', 'Confirm');
    var message = opts.message || '';
    var confirmText = opts.confirmText || t('gifEditorConfirmBtn', 'Confirm');
    var cancelText = opts.cancelText || t('cancel', 'Cancel');

    var html = '' +
      '<div class="modal" style="max-width: 420px; animation: modalFadeIn 0.15s ease-out;">' +
      '  <div class="modal-title">' + core.escapeHtml(title) + '</div>' +
      '  <div class="modal-body" style="padding: 14px 0;">' +
      '    <p style="margin: 0; color: var(--text-secondary); line-height: 1.5; font-size: var(--font-card-title);">' + core.escapeHtml(message) + '</p>' +
      '  </div>' +
      '  <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;">' +
      '    <button type="button" class="btn btn-ghost" id="gif-custom-cancel-btn">' + core.escapeHtml(cancelText) + '</button>' +
      '    <button type="button" class="btn btn-primary" id="gif-custom-confirm-btn">' + core.escapeHtml(confirmText) + '</button>' +
      '  </div>' +
      '</div>';

    overlay.innerHTML = html;
    overlay.classList.add('show');

    function closeSelf() {
      overlay.classList.remove('show');
      overlay.innerHTML = '';
    }

    var cancelBtn = document.getElementById('gif-custom-cancel-btn');
    var confirmBtn = document.getElementById('gif-custom-confirm-btn');

    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        closeSelf();
        if (opts.onCancel) opts.onCancel();
      });
    }
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () {
        closeSelf();
        if (opts.onConfirm) opts.onConfirm();
      });
    }
  }

  function deleteRange() {
    var range = getBatchRange();
    if (!range) return;
    showConfirmModal({
      title: t('gifEditorDeleteTitle', 'Delete Frames'),
      message: t('gifEditorConfirmDeleteRange', 'Delete frames ' + (range.start + 1) + ' - ' + (range.end + 1) + '?'),
      confirmText: t('gifEditorDeleteConfirmBtn', 'Delete'),
      cancelText: t('cancel', 'Cancel'),
      onConfirm: function () {
        var slices = core.state.slices || [];
        if (range.start >= slices.length) return;
        slices.splice(range.start, Math.min(range.end, slices.length - 1) - range.start + 1);
        core.state.selectedSliceIdx = Math.max(0, slices.length - 1);
        if (core.timeline) core.timeline.clearThumbCache();
        if (core.timeline && core.timeline.render) core.timeline.render();
        var panel = core.byId('batch-delete-panel');
        if (panel) panel.style.display = 'none';
        if (slices.length > 0 && core.commands.focusFrame) core.commands.focusFrame(0);
        else if (slices.length > 0) { core.state.selectedSliceIdx = 0; draw(); }
        else { core.state.mode = 'source'; draw(); }
      }
    });
  }

  function keepRange() {
    var range = getBatchRange();
    if (!range) return;
    showConfirmModal({
      title: t('gifEditorKeepTitle', 'Keep Frames'),
      message: t('gifEditorConfirmKeepRange', 'Keep frames ' + (range.start + 1) + ' - ' + (range.end + 1) + '?'),
      confirmText: t('gifEditorKeepConfirmBtn', 'Keep'),
      cancelText: t('cancel', 'Cancel'),
      onConfirm: function () {
        var slices = core.state.slices || [];
        var newSlices = slices.slice(range.start, range.end + 1);
        if (!newSlices.length) {
          alert(t('gifEditorAlertRangeEmpty'));
          return;
        }
        core.state.slices = newSlices;
        core.state.selectedSliceIdx = 0;
        var panel = core.byId('batch-delete-panel');
        if (panel) panel.style.display = 'none';
        if (core.timeline) core.timeline.clearThumbCache();
        if (core.timeline && core.timeline.render) core.timeline.render();
        if (core.commands.focusFrame) core.commands.focusFrame(0);
        else { core.state.selectedSliceIdx = 0; draw(); }
      }
    });
  }

  // ------------------------------------------------------------------
  // Keyboard (capture-phase: Escape for pick-color)
  // ------------------------------------------------------------------

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (core.state.pickColorMode) {
      e.stopPropagation();
      cancelPickColor();
    }
  }

  // ------------------------------------------------------------------
  // Document drag / paste -> Import Modal
  // ------------------------------------------------------------------

  function onDragOver(e) {
    e.preventDefault();
    if (dom.dropZone && e.target && e.target.closest && e.target.closest('#gif-drop-zone')) {
      dom.dropZone.style.borderColor = 'var(--accent)';
    }
  }

  function onDragLeave(e) {
    if (dom.dropZone && e.target && e.target.closest && e.target.closest('#gif-drop-zone')) {
      dom.dropZone.style.borderColor = 'var(--glass-border)';
    }
  }

  function onDrop(e) {
    e.preventDefault();
    if (dom.dropZone) dom.dropZone.style.borderColor = 'var(--glass-border)';
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      core.import.openFromFile(e.dataTransfer.files[0]);
    }
  }

  function onPaste(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        core.import.openFromFile(items[i].getAsFile());
        break;
      }
    }
  }

  function onWindowResize() {
    if (core.timeline && core.timeline.updateWindow) {
      core.timeline.updateWindow();
    }
  }

  // ------------------------------------------------------------------
  // Event Binding
  // ------------------------------------------------------------------

  function bindEvents() {
    // Import drag/drop/paste proxying to core.import.openFromFile
    if (dom.dropZone) {
      dom.dropZone.addEventListener('click', function () {
        if (dom.fileInput) dom.fileInput.click();
      });
    }
    if (dom.fileInput) {
      dom.fileInput.addEventListener('change', function (e) {
        if (e.target.files && e.target.files[0]) {
          core.import.openFromFile(e.target.files[0]);
          dom.fileInput.value = '';
        }
      });
    }

    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    document.addEventListener('paste', onPaste);
    document.addEventListener('keydown', onKeyDown, true);

    // Edge crop sliders + grid params (image source)
    function edgeSync(slider, num) {
      if (!slider || !num) return;
      slider.addEventListener('input', function () { num.value = slider.value; draw(); });
      num.addEventListener('change', function () {
        var val = parseInt(num.value, 10);
        if (isNaN(val)) val = 0;
        var max = parseInt(slider.max, 10);
        if (!isNaN(max)) val = Math.max(0, Math.min(max, val));
        slider.value = val;
        num.value = val;
        draw();
      });
    };
    edgeSync(dom.sliderT, dom.cropT);
    edgeSync(dom.sliderB, dom.cropB);
    edgeSync(dom.sliderL, dom.cropL);
    edgeSync(dom.sliderR, dom.cropR);
    if (dom.rows) dom.rows.addEventListener('input', draw);
    if (dom.cols) dom.cols.addEventListener('input', draw);
    if (dom.sliceBtn) dom.sliceBtn.addEventListener('click', runSlice);

    // Quality sync (#gif-sample-interval slider + read-only #gif-quality-val span)
    if (dom.quality) {
      dom.quality.addEventListener('change', function () {
        var v = parseInt(dom.quality.textContent, 10);
        if (isNaN(v)) v = 10;
        v = Math.max(1, Math.min(10, v));
        dom.quality.textContent = v;
        dom.qualitySlider.value = v;
      });
    }
    if (dom.qualitySlider) {
      dom.qualitySlider.addEventListener('input', function () {
        if (dom.quality) dom.quality.textContent = dom.qualitySlider.value;
      });
    }

    // Output scale
    if (dom.outScaleSlider) {
      dom.outScaleSlider.addEventListener('input', function (e) {
        var s = parseFloat(e.target.value) / 100;
        if (isNaN(s)) s = 1;
        if (dom.outScaleVal) dom.outScaleVal.innerText = s.toFixed(1) + 'x';
        var baseW, baseH;
        var slices = core.state.slices || [];
        if (slices.length > 0 && slices[0]) {
          baseW = slices[0].canvas.width;
          baseH = slices[0].canvas.height;
        } else if (core.state.processedImg) {
          baseW = core.state.processedImg.width;
          baseH = core.state.processedImg.height;
        }
        if (baseW && baseH) {
          dom.outW.value = Math.max(1, Math.round(baseW * s));
          dom.outH.value = Math.max(1, Math.round(baseH * s));
        }
      });
    }

    // Apply scale percent (#gif-scale-percent + #gif-apply-scale-btn) -> output dims
    if (dom.applyScaleBtn && dom.scalePercent) {
      dom.applyScaleBtn.addEventListener('click', function () {
        var p = parseInt(dom.scalePercent.value, 10);
        if (isNaN(p)) p = 100;
        p = Math.max(10, Math.min(300, p));
        dom.scalePercent.value = p;
        var s = p / 100;
        if (dom.outScaleSlider) dom.outScaleSlider.value = p;
        if (dom.outScaleVal) dom.outScaleVal.innerText = s.toFixed(1) + 'x';
        var baseW, baseH;
        var slices = core.state.slices || [];
        if (slices.length > 0 && slices[0]) {
          baseW = slices[0].canvas.width;
          baseH = slices[0].canvas.height;
        } else if (core.state.processedImg) {
          baseW = core.state.processedImg.width;
          baseH = core.state.processedImg.height;
        }
        if (baseW && baseH) {
          dom.outW.value = Math.max(1, Math.round(baseW * s));
          dom.outH.value = Math.max(1, Math.round(baseH * s));
        }
      });
    }

    // 1. Crop
    dom.startGlobalCropBtn = core.byId('global-crop-btn');
    dom.cropPanel = core.byId('crop-panel');
    dom.cancelCropBtn = core.byId('cancel-crop-btn');
    dom.applyCropBtn = core.byId('apply-crop-btn');
    if (dom.startGlobalCropBtn) {
      dom.startGlobalCropBtn.addEventListener('click', function () {
        if (dom.cropPanel && dom.cropPanel.style.display === 'block') {
          cancelCrop();
        } else {
          startGlobalCrop();
        }
      });
    }
    if (dom.cancelCropBtn) dom.cancelCropBtn.addEventListener('click', cancelCrop);
    if (dom.applyCropBtn) dom.applyCropBtn.addEventListener('click', applyCrop);
    setupCropSliders();

    // 2. Transparency (Set Transparency)
    dom.magicWandBtn = core.byId('magic-wand-btn');
    dom.applyTransBtn = core.byId('apply-trans-btn');
    dom.cancelTransBtn = core.byId('cancel-trans-btn');

    if (dom.magicWandBtn) {
      dom.magicWandBtn.addEventListener('click', function () {
        if (dom.transPanel) {
          var isExpanded = dom.transPanel.style.display === 'block';
          dom.transPanel.style.display = isExpanded ? 'none' : 'block';
        }
      });
    }
    if (dom.enableTrans) dom.enableTrans.addEventListener('change', toggleTransPanel);
    if (dom.keyColor) dom.keyColor.addEventListener('input', transParamChanged);
    if (dom.fuzziness) dom.fuzziness.addEventListener('input', transParamChanged);
    if (dom.pickColorBtn) dom.pickColorBtn.addEventListener('click', pickColorClick);
    if (dom.applyTransBtn) {
      dom.applyTransBtn.addEventListener('click', function () {
        if (dom.enableTrans) dom.enableTrans.checked = true;
        core.state.transparencyReady = true;
        rebakeImageFrame();
        draw();
        if (dom.transPanel) dom.transPanel.style.display = 'none';
      });
    }
    if (dom.cancelTransBtn) {
      dom.cancelTransBtn.addEventListener('click', function () {
        if (dom.enableTrans) dom.enableTrans.checked = false;
        rebakeImageFrame();
        draw();
        if (dom.transPanel) dom.transPanel.style.display = 'none';
      });
    }

    // 4. Set Latency
    var delayToggleBtn = core.byId('delay-toggle-btn');
    var delayPanel = core.byId('delay-panel');
    var cancelDelayBtn = core.byId('cancel-delay-btn');
    if (delayToggleBtn) {
      delayToggleBtn.addEventListener('click', function () {
        if (delayPanel) {
          var isExp = delayPanel.style.display === 'block';
          delayPanel.style.display = isExp ? 'none' : 'block';
        }
      });
    }
    if (dom.batchDelayBtn) {
      dom.batchDelayBtn.addEventListener('click', function () {
        var slices = core.state.slices || [];
        if (!slices.length) return;
        var val = parseInt(dom.batchDelayInput ? dom.batchDelayInput.value : 100, 10);
        if (isNaN(val) || val < 0) val = 100;
        for (var i = 0; i < slices.length; i++) slices[i].delay = val;
        if (core.timeline && core.timeline.render) core.timeline.render();
        if (delayPanel) delayPanel.style.display = 'none';
      });
    }
    if (cancelDelayBtn) {
      cancelDelayBtn.addEventListener('click', function () {
        if (delayPanel) delayPanel.style.display = 'none';
      });
    }

    // 5. Batch Frame Delete toggle
    var batchDelToggleBtn = core.byId('batch-delete-toggle-btn');
    var batchDelPanel = core.byId('batch-delete-panel');
    if (batchDelToggleBtn) {
      batchDelToggleBtn.addEventListener('click', function () {
        if (batchDelPanel) {
          var isExp = batchDelPanel.style.display === 'block';
          batchDelPanel.style.display = isExp ? 'none' : 'block';
        }
      });
    }

    // 6. Reduce Frame toggle
    var intervalDelToggleBtn = core.byId('interval-delete-toggle-btn');
    var intervalDelPanel = core.byId('interval-delete-panel');
    if (intervalDelToggleBtn) {
      intervalDelToggleBtn.addEventListener('click', function () {
        if (intervalDelPanel) {
          var isExp = intervalDelPanel.style.display === 'block';
          intervalDelPanel.style.display = isExp ? 'none' : 'block';
        }
      });
    }

    // 7. Overlay toggle
    var overlayToggleBtn = core.byId('overlay-toggle-btn');
    var overlayPanel = core.byId('overlay-panel');
    if (overlayToggleBtn) {
      overlayToggleBtn.addEventListener('click', function () {
        if (overlayPanel) {
          var isExp = overlayPanel.style.display === 'block';
          overlayPanel.style.display = isExp ? 'none' : 'block';
        }
      });
    }
    // Stage pointer (crop / layer gizmo / pan / color pick)
    if (dom.stage) {
      dom.stage.addEventListener('mousedown', handlePointerDown);
      dom.stage.addEventListener('touchstart', handlePointerDown, { passive: false });
      dom.stage.addEventListener('wheel', handleWheel, { passive: false });
    }
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchend', onPointerUp);

    // Zoom
    if (dom.zoomInBtn) dom.zoomInBtn.addEventListener('click', function () { core.state.scale = Math.min(3, core.state.scale * 1.2); updateTransform(); });
    if (dom.zoomOutBtn) dom.zoomOutBtn.addEventListener('click', function () { core.state.scale = Math.max(0.2, core.state.scale * 0.8); updateTransform(); });
    if (dom.resetViewBtn) dom.resetViewBtn.addEventListener('click', resetView);

    var zoomRange = document.getElementById('gif-timeline-zoom-range');
    if (zoomRange) {
      zoomRange.addEventListener('input', function (e) {
        var val = parseFloat(e.target.value);
        if (!isNaN(val) && val > 0) {
          core.state.scale = val;
          updateTransform();
        }
      });
    }

    // Layers
    if (dom.addTextBtn) dom.addTextBtn.addEventListener('click', addText);
    if (dom.addImageInput) {
      dom.addImageInput.addEventListener('change', function (e) {
        addImageFromFile(e.target.files[0]);
        e.target.value = '';
      });
    }
    if (dom.btnBold) dom.btnBold.addEventListener('click', function () { toggleStyle('bold', 'btnBold'); });
    if (dom.btnItalic) dom.btnItalic.addEventListener('click', function () { toggleStyle('italic', 'btnItalic'); });
    if (dom.btnUnderline) dom.btnUnderline.addEventListener('click', function () { toggleStyle('underline', 'btnUnderline'); });
    if (dom.addTextColor) {
      dom.addTextColor.addEventListener('input', function (e) {
        if (core.state.activeLayer && core.state.activeLayer.type === 'text') {
          core.state.activeLayer.color = e.target.value;
          draw();
        }
      });
    }
    if (dom.strokeColor) {
      dom.strokeColor.addEventListener('input', function (e) {
        if (core.state.activeLayer && core.state.activeLayer.type === 'text') {
          core.state.activeLayer.strokeColor = e.target.value;
          draw();
        }
      });
    }
    if (dom.deleteLayerBtn) {
      dom.deleteLayerBtn.addEventListener('click', function () {
        var slices = core.state.slices || [];
        var idx = core.state.selectedSliceIdx;
        if (!core.state.activeLayer || idx < 0 || idx >= slices.length) return;
        var layers = slices[idx].layers || [];
        for (var i = 0; i < layers.length; i++) {
          if (layers[i] === core.state.activeLayer) {
            removeLayer(i);
            return;
          }
        }
      });
    }
    if (dom.layerScale) {
      dom.layerScale.addEventListener('input', function (e) {
        var l = core.state.activeLayer;
        if (!l) return;
        var f = parseFloat(e.target.value);
        if (isNaN(f)) return;
        if (l.type === 'text') {
          l.size = Math.max(8, ((layerBase && layerBase.size) || l.size) * f);
        } else if (l.img) {
          l.w = ((layerBase && layerBase.w) || l.w) * f;
          l.h = ((layerBase && layerBase.h) || l.h) * f;
        }
        draw();
      });
    }
    if (dom.layerList) dom.layerList.addEventListener('click', onLayerListClick);
    var scopeRadios = document.querySelectorAll('input[name="gif-scope"]');
    for (var i = 0; i < scopeRadios.length; i++) {
      scopeRadios[i].addEventListener('change', function (e) {
        var ri = core.byId('crop-range-inputs');
        if (ri) ri.style.display = e.target.value === 'range' ? 'flex' : 'none';
      });
    }

    // Batch delete / keep
    if (dom.btnDelRange) dom.btnDelRange.addEventListener('click', deleteRange);
    if (dom.btnKeepRange) dom.btnKeepRange.addEventListener('click', keepRange);

    // 全局缩放：保持比例联动
    if (dom.resizeKeepRatio && dom.resizeWidth && dom.resizeHeight) {
      dom.resizeWidth.addEventListener('input', function () {
        if (!dom.resizeKeepRatio.checked) return;
        var slices = core.state.slices || [];
        if (!slices.length || !slices[0].canvas) return;
        var origW = slices[0].canvas.width;
        var origH = slices[0].canvas.height;
        var w = parseInt(dom.resizeWidth.value, 10);
        if (w > 0 && origW > 0) dom.resizeHeight.value = Math.round(origH * w / origW);
      });
      dom.resizeHeight.addEventListener('input', function () {
        if (!dom.resizeKeepRatio.checked) return;
        var slices = core.state.slices || [];
        if (!slices.length || !slices[0].canvas) return;
        var origW = slices[0].canvas.width;
        var origH = slices[0].canvas.height;
        var h = parseInt(dom.resizeHeight.value, 10);
        if (h > 0 && origH > 0) dom.resizeWidth.value = Math.round(origW * h / origH);
      });
    }
    // 全局缩放：应用
    if (dom.resizeApplyBtn) {
      dom.resizeApplyBtn.addEventListener('click', function () {
        var slices = core.state.slices || [];
        if (!slices.length) { alert(t('gifEditorAlertNoFrames', '没有帧可操作')); return; }
        var keepRatio = dom.resizeKeepRatio && dom.resizeKeepRatio.checked;
        var targetW = parseInt(dom.resizeWidth.value, 10);
        var targetH = parseInt(dom.resizeHeight.value, 10);
        var origW = slices[0].canvas.width;
        var origH = slices[0].canvas.height;
        if (keepRatio) {
          if (targetW && !targetH) targetH = Math.round(origH * targetW / origW);
          else if (targetH && !targetW) targetW = Math.round(origW * targetH / origH);
          else if (!targetW && !targetH) { alert(t('gifEditorAlertResizeEmpty', '请输入宽度或高度')); return; }
        } else {
          if (!targetW) targetW = origW;
          if (!targetH) targetH = origH;
        }
        targetW = Math.max(1, targetW);
        targetH = Math.max(1, targetH);
        showConfirmModal({
          title: t('gifEditorResizeTitle', '全局缩放'),
          message: t('gifEditorResizeConfirm', '将所有帧从 ' + origW + '×' + origH + ' 缩放到 ' + targetW + '×' + targetH + '？此操作不可撤销。'),
          confirmText: t('gifEditorResizeBtn', '确认缩放'),
          cancelText: t('cancel', '取消'),
          onConfirm: function () {
            for (var i = 0; i < slices.length; i++) {
              var src = slices[i].canvas;
              var dst = document.createElement('canvas');
              dst.width = targetW;
              dst.height = targetH;
              dst.getContext('2d').drawImage(src, 0, 0, targetW, targetH);
              slices[i].canvas = dst;
            }
            core.state.processedImg = slices[core.state.selectedSliceIdx >= 0 ? core.state.selectedSliceIdx : 0].canvas;
            if (core.timeline) core.timeline.clearThumbCache();
            if (core.timeline && core.timeline.render) core.timeline.render();
            draw();
            resetView();
          }
        });
      });
    }

    // 间隔删除
    if (dom.intervalDeleteBtn) {
      dom.intervalDeleteBtn.addEventListener('click', function () {
        var slices = core.state.slices || [];
        if (!slices.length) { alert(t('gifEditorAlertNoFrames', '没有帧可操作')); return; }
        var interval = parseInt(dom.intervalDeleteVal.value, 10);
        if (isNaN(interval) || interval < 1) { alert(t('gifEditorAlertIntervalInvalid', '请输入有效的间隔值（≥1）')); return; }
        // 计算删除前总时长
        var totalDuration = 0;
        for (var i = 0; i < slices.length; i++) totalDuration += (slices[i].delay || 100);
        // 执行间隔删除：每隔 interval 帧删除 1 帧
        var kept = [];
        for (var i = 0; i < slices.length; i++) {
          if ((i + 1) % (interval + 1) !== 0) kept.push(slices[i]);
        }
        if (!kept.length) { alert(t('gifEditorAlertAllDeleted', '所有帧都会被删除，操作取消')); return; }
        var deletedCount = slices.length - kept.length;
        showConfirmModal({
          title: t('gifEditorIntervalDeleteTitle', '间隔删除'),
          message: t('gifEditorIntervalDeleteConfirm', '将每隔 ' + interval + ' 帧删除 1 帧，共删除 ' + deletedCount + ' 帧（' + slices.length + ' → ' + kept.length + '），自动调整延迟保持总时长。'),
          confirmText: t('gifEditorDeleteConfirmBtn', '确认删除'),
          cancelText: t('cancel', '取消'),
          onConfirm: function () {
            // 重新分配 delay 保持总时长不变
            var newDelay = Math.max(1, Math.round(totalDuration / kept.length));
            for (var j = 0; j < kept.length; j++) kept[j].delay = newDelay;
            core.state.slices = kept;
            core.state.selectedSliceIdx = Math.min(core.state.selectedSliceIdx, kept.length - 1);
            if (core.state.selectedSliceIdx < 0) core.state.selectedSliceIdx = 0;
            if (core.timeline) core.timeline.clearThumbCache();
            if (core.timeline && core.timeline.render) core.timeline.render();
            var panel = core.byId('interval-delete-panel');
            if (panel) panel.style.display = 'none';
            if (core.commands.focusFrame) core.commands.focusFrame(core.state.selectedSliceIdx);
            else draw();
          }
        });
      });
    }

    // 右键复制当前帧到剪贴板
    if (dom.stage) {
      dom.stage.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var slices = core.state.slices || [];
        var idx = core.state.selectedSliceIdx;
        if (idx < 0 || idx >= slices.length || !slices[idx].canvas) return;
        var src = slices[idx].canvas;
        // 创建临时 canvas 用于合成（含图层）
        var tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = src.width;
        tmpCanvas.height = src.height;
        if (core.commands && core.commands.composeFrame) {
          core.commands.composeFrame(idx, tmpCanvas, {});
        } else {
          tmpCanvas.getContext('2d').drawImage(src, 0, 0);
        }
        tmpCanvas.toBlob(function (blob) {
          if (!blob) return;
          try {
            navigator.clipboard.write([
              new ClipboardItem({ 'image/png': blob })
            ]).then(function () {
              // 短暂提示
              if (dom.stageOverlayText) {
                var origText = dom.stageOverlayText.textContent;
                dom.stageOverlayText.textContent = '✅ ' + t('gifEditorCopiedToClipboard', '已复制到剪贴板');
                setTimeout(function () {
                  dom.stageOverlayText.textContent = origText;
                }, 1500);
              }
            }).catch(function (err) {
              console.error('Copy to clipboard failed:', err);
              alert(t('gifEditorCopyFailed', '复制失败，请检查浏览器权限'));
            });
          } catch (err) {
            console.error('Clipboard API not available:', err);
            alert(t('gifEditorCopyFailed', '复制失败，浏览器不支持剪贴板 API'));
          }
        }, 'image/png');
      });
    }

    // Reload (reset workspace in place)
    if (dom.reloadBtn) {
      dom.reloadBtn.addEventListener('click', function () {
        showConfirmModal({
          title: t('gifEditorResetTitle', 'Reset Workspace'),
          message: t('gifEditorConfirmReset', 'Are you sure you want to reset the workspace? All unexported edits will be cleared.'),
          confirmText: t('gifEditorResetConfirmBtn', 'Reset'),
          cancelText: t('cancel', 'Cancel'),
          onConfirm: function () {
            core.resetSlices();
            core.releaseSource();
            updateSourcePanels(null);
            updateSelectionUI(-1);
            if (core.timeline && core.timeline.render) core.timeline.render();
            if (core.playback && core.playback.updateButtons) core.playback.updateButtons();
            core.hideSpinner();
            draw();
            resetView();
          }
        });
      });
    }

    if (dom.openExportBtn) {
      dom.openExportBtn.addEventListener('click', function () {
        if (core.export && core.export.openExportModal) core.export.openExportModal();
      });
    }

    function updateSplitSummary() {
      if (!dom.splitCols || !dom.splitRows) return;
      var scale = (parseInt(dom.splitScale ? dom.splitScale.value : 100, 10) || 100) / 100;
      var srcCanvas = (core.state.source && (core.state.source.rawImage || core.state.source.image)) || core.state.processedImg;
      var origW = srcCanvas ? (srcCanvas.width || srcCanvas.naturalWidth || 800) : 800;
      var origH = srcCanvas ? (srcCanvas.height || srcCanvas.naturalHeight || 600) : 600;
      var scaledW = Math.max(1, Math.round(origW * scale));
      var scaledH = Math.max(1, Math.round(origH * scale));

      var totalFrames;
      if (core.state.splitMode === 'uneven') {
        var cellW = Math.max(1, Math.round((parseInt(dom.splitCols.value, 10) || 64) * scale));
        var cellH = Math.max(1, Math.round((parseInt(dom.splitRows.value, 10) || 64) * scale));
        var innerGap = Math.round((parseInt(dom.splitInnerGap ? dom.splitInnerGap.value : 0, 10) || 0) * scale);
        var outerMargin = (dom.splitEnableOuter && dom.splitEnableOuter.checked) ? Math.round((parseInt(dom.splitOuterMargin ? dom.splitOuterMargin.value : 0, 10) || 0) * scale) : 0;
        var cols = Math.max(1, Math.floor((scaledW - outerMargin * 2 + innerGap) / (cellW + innerGap)));
        var rows = Math.max(1, Math.floor((scaledH - outerMargin * 2 + innerGap) / (cellH + innerGap)));
        totalFrames = cols * rows;
      } else {
        var cols = Math.max(1, parseInt(dom.splitCols.value, 10) || 1);
        var rows = Math.max(1, parseInt(dom.splitRows.value, 10) || 1);
        totalFrames = cols * rows;
      }

      if (dom.splitActualFrames) dom.splitActualFrames.textContent = totalFrames;
      if (dom.splitScaleDisplay) dom.splitScaleDisplay.textContent = Math.round(scale * 100) + '%';

      if (srcCanvas && dom.splitSourceRes) {
        var origText = origW + ' × ' + origH;
        if (scale !== 1) {
          dom.splitSourceRes.textContent = origText + ' -> ' + scaledW + ' × ' + scaledH;
        } else {
          dom.splitSourceRes.textContent = origText;
        }
      }
    }

    if (dom.splitSheetToggleBtn && dom.splitSheetPanel) {
      dom.splitSheetToggleBtn.addEventListener('click', function () {
        var isHidden = dom.splitSheetPanel.style.display === 'none' || !dom.splitSheetPanel.style.display;
        dom.splitSheetPanel.style.display = isHidden ? 'block' : 'none';
        updateSplitSummary();
        draw();
      });
    }

    var updateSplitLabels = function (mode) {
      if (dom.splitColsLabel) dom.splitColsLabel.textContent = mode === 'uneven' ? 'Cell Width (px):' : 'X (Horizontal Split):';
      if (dom.splitRowsLabel) dom.splitRowsLabel.textContent = mode === 'uneven' ? 'Cell Height (px):' : 'Y (Vertical Split):';
      if (dom.splitCols) dom.splitCols.max = mode === 'uneven' ? '9999' : '100';
      if (dom.splitRows) dom.splitRows.max = mode === 'uneven' ? '9999' : '100';
    };

    if (dom.splitModeToggle) {
      dom.splitModeToggle.addEventListener('click', function (e) {
        var btn = e.target.closest('.gif-split-mode-btn');
        if (!btn) return;
        var mode = btn.dataset.mode;
        var btns = dom.splitModeToggle.querySelectorAll('.gif-split-mode-btn');
        for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i] === btn);
        core.state.splitMode = mode;
        updateSplitLabels(mode);
        if (mode === 'uneven') {
          if (dom.splitCols && parseInt(dom.splitCols.value, 10) < 10) dom.splitCols.value = 64;
          if (dom.splitRows && parseInt(dom.splitRows.value, 10) < 10) dom.splitRows.value = 64;
        } else {
          if (dom.splitCols && parseInt(dom.splitCols.value, 10) > 100) dom.splitCols.value = 3;
          if (dom.splitRows && parseInt(dom.splitRows.value, 10) > 100) dom.splitRows.value = 3;
        }
        onSplitUIChange();
      });
    }

    var onSplitUIChange = function () {
      updateSplitSummary();
      draw();
    };

    if (dom.splitScale) dom.splitScale.addEventListener('input', onSplitUIChange);
    if (dom.splitCols) { dom.splitCols.addEventListener('input', onSplitUIChange); dom.splitCols.addEventListener('change', onSplitUIChange); }
    if (dom.splitRows) { dom.splitRows.addEventListener('input', onSplitUIChange); dom.splitRows.addEventListener('change', onSplitUIChange); }
    if (dom.splitInnerGap) { dom.splitInnerGap.addEventListener('input', onSplitUIChange); dom.splitInnerGap.addEventListener('change', onSplitUIChange); }
    if (dom.splitOuterMargin) { dom.splitOuterMargin.addEventListener('input', onSplitUIChange); dom.splitOuterMargin.addEventListener('change', onSplitUIChange); }
    if (dom.splitEnableOuter) dom.splitEnableOuter.addEventListener('change', onSplitUIChange);

    if (dom.splitApplyBtn) {
      dom.splitApplyBtn.addEventListener('click', function () {
        if (!core.import || !core.import.splitImage) return;
        var opts = {
          mode: core.state.splitMode || 'even',
          cols: parseInt(dom.splitCols ? dom.splitCols.value : 3, 10) || 1,
          rows: parseInt(dom.splitRows ? dom.splitRows.value : 3, 10) || 1,
          innerGap: parseInt(dom.splitInnerGap ? dom.splitInnerGap.value : 0, 10) || 0,
          outerMargin: parseInt(dom.splitOuterMargin ? dom.splitOuterMargin.value : 0, 10) || 0,
          enableOuterGap: dom.splitEnableOuter ? !!dom.splitEnableOuter.checked : false,
          scalePercent: parseInt(dom.splitScale ? dom.splitScale.value : 100, 10) || 100
        };
        core.import.splitImage(opts).then(function () {
          if (dom.splitSheetPanel) dom.splitSheetPanel.style.display = 'none';
          draw();
        }).catch(function (err) {
          console.error('Split sheet failed:', err);
        });
      });
    }

    // Sub-module event binders
    if (core.import) core.import.bindEvents();
    if (core.timeline) core.timeline.bindEvents();
    if (core.playback) core.playback.bindEvents();
    if (core.export) core.export.bindEvents();

    updateSelectionUI(core.state.selectedSliceIdx);
    updateExportEnabled();
  }

  // ------------------------------------------------------------------
  // HTML Template (restored full sidebar: import, transparency, image
  // tools, crop/layers, output/export controls; stage + timeline toolbar)
  // ------------------------------------------------------------------

  function pageTemplate() {
    return '' +
      '<div class="gif-workspace">' +
      '  <aside class="gif-sidebar">' +
      '    <div id="gif-panel-step1">' +
      '      <div id="gif-drop-zone-container">' +
      '        <div class="gif-drop-zone" id="gif-drop-zone">' +
      '          <div class="gif-drop-zone-icon">📁</div>' +
      '          <div class="gif-drop-zone-title" data-i18n="gifEditorDropTitle">点击选择或拖入文件</div>' +
      '          <div class="gif-drop-zone-desc" data-i18n="gifEditorDropDesc">支持 Image / GIF / Video，可直接粘贴</div>' +
      '          <input type="file" id="gif-file-input" style="display:none;" accept="image/*,video/*,.gif">' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '    <div id="gif-sidebar-editor-content" style="display:none;">' +
      '      <div class="gif-action-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; margin-bottom: 12px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="btn btn-primary" id="gif-open-export-btn" title="Export settings" style="width:100%; display:flex; align-items:center; justify-content:center; padding:8px 12px; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorExportTitle">Export</span>' +
      '        </button>' +
      '        <button type="button" class="btn btn-ghost gif-reset-btn" id="gif-reload-btn" title="Reset workspace" style="width:100%; display:flex; align-items:center; justify-content:center; padding:8px 12px; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorReload">Reset</span>' +
      '        </button>' +
      '      </div>' +

      '      <!-- 1. Crop -->' +
      '      <div id="gif-crop-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-global-crop-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorGlobalCrop">' + t('gifEditorGlobalCrop', 'Crop') + '</span>' +
      '        </button>' +
      '        <div class="gif-crop-panel" id="gif-crop-panel" style="display:none; width:100%; box-sizing:border-box; margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.25); border: 1px dashed var(--glass-border); border-radius: 8px;">' +
      '          <div class="gif-group-title" style="margin-bottom: 8px; font-weight: bold; font-size: 12px; color: var(--accent-color);" data-i18n="gifEditorCropAdjust">' + t('gifEditorCropAdjust', 'Crop area fine-tune') + '</div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:6px;">' +
      '            <label for="gif-crop-num-l" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropLeft">' + t('gifEditorCropLeft', 'Left:') + '</label>' +
      '            <div class="number-stepper" style="flex:1;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-l\', -1)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-crop-num-l" min="0" value="0">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-l\', 1)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:6px;">' +
      '            <label for="gif-crop-num-r" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropRight">' + t('gifEditorCropRight', 'Right:') + '</label>' +
      '            <div class="number-stepper" style="flex:1;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-r\', -1)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-crop-num-r" min="0" value="0">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-r\', 1)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:6px;">' +
      '            <label for="gif-crop-num-t" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropTop">' + t('gifEditorCropTop', 'Top:') + '</label>' +
      '            <div class="number-stepper" style="flex:1;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-t\', -1)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-crop-num-t" min="0" value="0">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-t\', 1)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:8px;">' +
      '            <label for="gif-crop-num-b" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropBottom">' + t('gifEditorCropBottom', 'Bottom:') + '</label>' +
      '            <div class="number-stepper" style="flex:1;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-b\', -1)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-crop-num-b" min="0" value="0">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-b\', 1)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-control-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;">' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-crop-action-btn" id="gif-apply-crop-btn" data-i18n="gifEditorApplyCrop">' + t('gifEditorApplyCrop', 'Apply') + '</button>' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-crop-action-btn" id="gif-cancel-crop-btn" data-i18n="gifEditorCancelCrop">' + t('gifEditorCancelCrop', 'Cancel') + '</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 2. Set Transparency -->' +
      '      <div id="gif-transparency-wrapper" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <input type="checkbox" id="gif-enable-trans" style="display:none;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-magic-wand-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorMagicWandTitle">' + t('gifEditorMagicWandTitle', 'Set Transparency') + '</span>' +
      '        </button>' +
      '        <div id="gif-trans-panel" class="gif-trans-panel" style="display:none; width:100%; box-sizing:border-box; margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.25); border: 1px dashed var(--glass-border); border-radius: 8px;">' +
      '          <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">' +
      '            <input type="color" id="gif-key-color" value="#ffffff" class="gif-key-color-input" style="width:36px; height:36px; padding:0; border:1px solid var(--glass-border); border-radius:4px; cursor:pointer;" title="' + t('gifEditorPickColorTitle', 'Key color') + '">' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-flex-1" id="gif-pick-color-btn" style="display:flex; align-items:center; justify-content:center; height:36px; font-weight:600;" title="' + t('gifEditorPickColorTitle', 'Key color') + '">' +
      '              <span data-i18n="gifEditorPickColor">' + t('gifEditorPickColor', 'Pick Color') + '</span>' +
      '            </button>' +
      '          </div>' +
      '          <div class="gif-trans-hint" style="font-size:11px; color:var(--text-muted); margin-bottom:8px; line-height:1.3;" data-i18n="gifEditorPickColorHint">' + t('gifEditorPickColorHint', '* After clicking Pick Color, click background color on canvas') + '</div>' +
      '          <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">' +
      '            <span class="gif-muted-label" style="font-size:12px; color:var(--text-muted);" data-i18n="gifEditorFuzziness">' + t('gifEditorFuzziness', 'Tolerance:') + '</span>' +
      '            <input type="range" id="gif-fuzziness" min="0" max="100" value="15" class="gif-flex-1" title="' + t('gifEditorFuzzinessTitle', 'Fuzziness') + '">' +
      '          </div>' +
      '          <div class="gif-control-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;">' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-crop-action-btn" id="gif-apply-trans-btn" data-i18n="gifEditorApplyTrans">' + t('gifEditorApplyTrans', 'Apply') + '</button>' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-crop-action-btn" id="gif-cancel-trans-btn" data-i18n="gifEditorCancelTrans">' + t('gifEditorCancelTrans', 'Cancel') + '</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 3. Split Sheet -->' +
      '      <div id="gif-split-sheet-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-split-sheet-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorSplitSheet">Split Sheet</span>' +
      '        </button>' +
      '        <div id="gif-split-sheet-panel" class="gif-split-sheet-panel" style="display:none; width:100%; box-sizing:border-box; margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.25); border: 1px dashed var(--glass-border); border-radius: 8px;">' +
      '          <div class="gif-import-row" style="display:flex; justify-content:space-between; font-size:12px; margin-bottom: 6px;">' +
      '            <span class="gif-import-label" style="color:var(--text-muted);">Source Resolution:</span>' +
      '            <span class="gif-import-value" id="gif-split-source-res" style="font-weight:bold; color:var(--accent-color);">2048 × 2048</span>' +
      '          </div>' +
      '          <div class="gif-import-col" style="margin-bottom: 8px;">' +
      '            <div class="gif-import-label-row" style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">' +
      '              <label for="gif-split-scale" class="gif-import-label" style="color:var(--text-muted);">Scale</label>' +
      '              <span class="gif-import-value" id="gif-split-scale-display" style="font-weight:bold;">100%</span>' +
      '            </div>' +
      '            <input type="range" id="gif-split-scale" min="10" max="100" step="5" value="100" style="width:100%;">' +
      '          </div>' +
      '          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">' +
      '            <div class="gif-group-title" style="font-weight:bold; font-size:12px; color:var(--accent-color);">Sprite Sheet Grid Split</div>' +
      '            <div class="gif-split-mode-toggle" id="gif-split-mode-toggle">' +
      '              <button type="button" class="gif-split-mode-btn active" data-mode="even">Even</button>' +
      '              <button type="button" class="gif-split-mode-btn" data-mode="uneven">Uneven</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-control-group" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 6px;">' +
      '            <div class="gif-import-field-vert">' +
      '              <label for="gif-split-cols" class="gif-import-label" id="gif-split-cols-label" style="font-size:11px; display:block; margin-bottom:2px;">X (Horizontal Split):</label>' +
      '              <div class="number-stepper">' +
      '                <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-split-cols\', -1)">-</button>' +
      '                <input type="number" class="stepper-input" id="gif-split-cols" min="1" max="100" value="3">' +
      '                <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-split-cols\', 1)">+</button>' +
      '              </div>' +
      '            </div>' +
      '            <div class="gif-import-field-vert">' +
      '              <label for="gif-split-rows" class="gif-import-label" id="gif-split-rows-label" style="font-size:11px; display:block; margin-bottom:2px;">Y (Vertical Split):</label>' +
      '              <div class="number-stepper">' +
      '                <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-split-rows\', -1)">-</button>' +
      '                <input type="number" class="stepper-input" id="gif-split-rows" min="1" max="100" value="3">' +
      '                <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-split-rows\', 1)">+</button>' +
      '              </div>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-control-group" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 6px;">' +
      '            <div class="gif-import-field-vert">' +
      '              <label for="gif-split-inner-gap" class="gif-import-label" style="font-size:11px; display:block; margin-bottom:2px;">Center Gap (px):</label>' +
      '              <div class="number-stepper">' +
      '                <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-split-inner-gap\', -1)">-</button>' +
      '                <input type="number" class="stepper-input" id="gif-split-inner-gap" min="0" max="500" value="0">' +
      '                <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-split-inner-gap\', 1)">+</button>' +
      '              </div>' +
      '            </div>' +
      '            <div class="gif-import-field-vert">' +
      '              <label for="gif-split-outer-margin" class="gif-import-label" style="font-size:11px; display:block; margin-bottom:2px;">Outer Margin (px):</label>' +
      '              <div class="number-stepper">' +
      '                <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-split-outer-margin\', -1)">-</button>' +
      '                <input type="number" class="stepper-input" id="gif-split-outer-margin" min="0" max="500" value="0">' +
      '                <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-split-outer-margin\', 1)">+</button>' +
      '              </div>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-row" style="margin-bottom: 8px;">' +
      '            <label class="gif-check-label" style="font-size:12px;"><input type="checkbox" id="gif-split-enable-outer"> <span>Enable outer border gap</span></label>' +
      '          </div>' +
      '          <div class="gif-import-summary-row" style="display:flex; justify-content:space-between; font-size:12px; margin-bottom: 8px; border-top: 1px dashed var(--glass-border); padding-top: 6px;">' +
      '            <div>' +
      '              <span class="gif-import-label">Actual Frames: </span>' +
      '              <span class="gif-import-summary-val" id="gif-split-actual-frames" style="font-weight:bold;">9</span>' +
      '            </div>' +
      '            <div>' +
      '              <span class="gif-import-label">Duration: </span>' +
      '              <span class="gif-import-summary-val" id="gif-split-duration">00:00:00.000</span>' +
      '            </div>' +
      '          </div>' +
      '          <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-split-apply-btn" style="margin-top: 4px;">Split</button>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 4. Set Latency -->' +
      '      <div id="gif-global-delay-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-delay-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorGlobalDelay">' + t('gifEditorGlobalDelay', 'Set Latency') + '</span>' +
      '        </button>' +
      '        <div id="gif-delay-panel" class="gif-delay-panel" style="display:none; width:100%; box-sizing:border-box; margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.25); border: 1px dashed var(--glass-border); border-radius: 8px;">' +
      '          <div class="gif-import-field-vert" style="width: 100%; margin-bottom: 8px;">' +
      '            <label for="gif-batch-delay-input" class="gif-import-label" style="font-size: 11px; display: block; margin-bottom: 2px;" data-i18n="gifEditorDelayLabel">' + t('gifEditorDelayLabel', 'Frame Latency (ms):') + '</label>' +
      '            <div class="number-stepper" style="width: 100%;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-batch-delay-input\', -10)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-batch-delay-input" min="0" value="100" placeholder="100">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-batch-delay-input\', 10)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-control-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;">' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-crop-action-btn" id="gif-batch-delay-btn" data-i18n="gifEditorApplyDelay">' + t('gifEditorApplyDelay', 'Apply') + '</button>' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-crop-action-btn" id="gif-cancel-delay-btn" data-i18n="gifEditorCancelDelay">' + t('gifEditorCancelDelay', 'Cancel') + '</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 5. Batch Frame Delete -->' +
      '      <div id="gif-batch-delete-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-batch-delete-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorBatchDelete">' + t('gifEditorBatchDelete', 'Batch Frame Delete') + '</span>' +
      '        </button>' +
      '        <div id="gif-batch-delete-panel" class="gif-batch-delete-panel" style="display:none; width:100%; box-sizing:border-box; margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.25); border: 1px dashed var(--glass-border); border-radius: 8px;">' +
      '          <div class="gif-control-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">' +
      '            <input type="number" id="gif-del-start" placeholder="' + t('gifEditorStartFrame', 'Start') + '" min="1" style="width:100%; box-sizing:border-box;">' +
      '            <input type="number" id="gif-del-end" placeholder="' + t('gifEditorEndFrame', 'End') + '" min="1" style="width:100%; box-sizing:border-box;">' +
      '          </div>' +
      '          <div class="gif-control-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;">' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-crop-action-btn" id="gif-delete-range-btn" data-i18n="gifEditorDelRange">' + t('gifEditorDelRange', 'Delete Range') + '</button>' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-crop-action-btn" id="gif-keep-range-btn" data-i18n="gifEditorKeepRange">' + t('gifEditorKeepRange', 'Keep Range') + '</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 6. Reduce Frame -->' +
      '      <div id="gif-interval-delete-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-interval-delete-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorReduceFrame">' + t('gifEditorReduceFrame', 'Reduce Frame') + '</span>' +
      '        </button>' +
      '        <div id="gif-interval-delete-panel" class="gif-interval-delete-panel" style="display:none; width:100%; box-sizing:border-box; margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.25); border: 1px dashed var(--glass-border); border-radius: 8px;">' +
      '          <div class="gif-import-field-vert" style="width: 100%; margin-bottom: 8px;">' +
      '            <label for="gif-interval-delete-val" class="gif-import-label" style="font-size: 11px; display: block; margin-bottom: 2px;" data-i18n="gifEditorInterval">' + t('gifEditorInterval', 'Interval (N):') + '</label>' +
      '            <div class="number-stepper" style="width: 100%;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-interval-delete-val\', -1)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-interval-delete-val" min="1" value="1" placeholder="1">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-interval-delete-val\', 1)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-muted-hint" data-i18n="gifEditorIntervalDeleteHint" style="font-size:11px; color:var(--text-muted); margin-bottom:10px; line-height:1.3;">' + t('gifEditorIntervalDeleteHint', '* Delete 1 frame every N frames, automatically adjusting delay to preserve total duration') + '</div>' +
      '          <div class="gif-control-row" style="margin-top: 10px;">' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-crop-action-btn" id="gif-interval-delete-btn" style="width:100%;" data-i18n="gifEditorIntervalDeleteBtn">' + t('gifEditorIntervalDeleteBtn', 'Apply') + '</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 7. Overlay -->' +
      '      <div id="gif-overlay-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-overlay-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorOverlay">' + t('gifEditorOverlay', 'Overlay') + '</span>' +
      '        </button>' +
      '        <div id="gif-overlay-panel" class="gif-overlay-panel" style="display:none; width:100%; box-sizing:border-box; margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.25); border: 1px dashed var(--glass-border); border-radius: 8px;">' +
      '          <div class="gif-group-title" style="margin-bottom:6px; font-weight:bold; font-size:12px; color:var(--accent-color);" data-i18n="gifEditorApplyTo">' + t('gifEditorApplyTo', 'Apply To') + '</div>' +
      '          <div class="gif-control-row" style="display:flex; gap:10px; align-items:center; margin-bottom:8px; font-size:12px;">' +
      '            <label class="gif-check-label" style="display:flex; align-items:center; gap:3px; cursor:pointer;"><input type="radio" name="gif-scope" value="current" checked> <span data-i18n="gifEditorScopeCurrent">' + t('gifEditorScopeCurrent', 'Current') + '</span></label>' +
      '            <label class="gif-check-label" style="display:flex; align-items:center; gap:3px; cursor:pointer;"><input type="radio" name="gif-scope" value="all"> <span data-i18n="gifEditorScopeAll">' + t('gifEditorScopeAll', 'All') + '</span></label>' +
      '            <label class="gif-check-label" style="display:flex; align-items:center; gap:3px; cursor:pointer;"><input type="radio" name="gif-scope" value="range"> <span data-i18n="gifEditorScopeRange">' + t('gifEditorScopeRange', 'Range') + '</span></label>' +
      '          </div>' +
      '          <div id="gif-crop-range-inputs" style="display:none; gap:8px; align-items:center; margin-bottom:8px;">' +
      '            <input type="number" id="gif-crop-start" placeholder="' + t('gifEditorStartFrame', 'Start') + '" min="1" style="width:50%; box-sizing:border-box; padding:4px 6px; font-size:12px;">' +
      '            <input type="number" id="gif-crop-end" placeholder="' + t('gifEditorEndFrame', 'End') + '" min="1" style="width:50%; box-sizing:border-box; padding:4px 6px; font-size:12px;">' +
      '          </div>' +
      '          <div class="gif-group-title" style="margin-top:8px; margin-bottom:6px; font-weight:bold; font-size:12px; color:var(--accent-color);" data-i18n="gifEditorAddTextTitle">' + t('gifEditorAddTextTitle', 'Add Text / Subtitle') + '</div>' +
      '          <div class="gif-control-row" style="margin-bottom:6px;">' +
      '            <input type="text" id="gif-text-input" placeholder="Enter text..." style="width:100%; box-sizing:border-box; padding:6px 8px; font-size:12px;">' +
      '          </div>' +
      '          <div class="gif-control-row" style="display:flex; gap:6px; align-items:center; margin-bottom:8px;">' +
      '            <button type="button" class="gif-btn gif-btn-ghost" id="gif-btn-bold" style="font-weight:bold; width:30px; height:30px; padding:0;">B</button>' +
      '            <button type="button" class="gif-btn gif-btn-ghost" id="gif-btn-italic" style="font-style:italic; width:30px; height:30px; padding:0;">I</button>' +
      '            <button type="button" class="gif-btn gif-btn-ghost" id="gif-btn-underline" style="text-decoration:underline; width:30px; height:30px; padding:0;">U</button>' +
      '            <input type="color" id="gif-text-color" value="#ffffff" style="width:30px; height:30px; padding:0; border:none; cursor:pointer;" title="Text Color">' +
      '            <input type="color" id="gif-text-stroke-color" value="#000000" style="width:30px; height:30px; padding:0; border:none; cursor:pointer;" title="Stroke Color">' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-flex-1" id="gif-add-text-btn" style="height:30px; padding:0 8px; font-size:12px;" data-i18n="gifEditorAddTextBtn">' + t('gifEditorAddTextBtn', '+ Add Text') + '</button>' +
      '          </div>' +
      '          <div class="gif-group-title" style="margin-top:10px; margin-bottom:6px; font-weight:bold; font-size:12px; color:var(--accent-color);" data-i18n="gifEditorAddImageTitle">' + t('gifEditorAddImageTitle', 'Add Image / Watermark') + '</div>' +
      '          <div class="gif-control-row" style="margin-bottom:8px;">' +
      '            <label class="gif-btn gif-btn-primary gif-full-width" style="display:flex; align-items:center; justify-content:center; height:32px; font-size:12px; cursor:pointer; width:100%; box-sizing:border-box;">' +
      '              <span data-i18n="gifEditorAddImageBtn">' + t('gifEditorAddImageBtn', '📷 Add Image / Watermark') + '</span>' +
      '              <input type="file" id="gif-add-image-input" accept="image/*" style="display:none;">' +
      '            </label>' +
      '          </div>' +
      '          <div id="gif-selected-layer-tools" style="margin-top:10px; border-top:1px dashed var(--glass-border); padding-top:8px;">' +
      '            <div class="gif-group-title" style="margin-bottom:6px; font-weight:bold; font-size:11px; color:var(--text-muted);" data-i18n="gifEditorLayerTools">' + t('gifEditorLayerTools', 'Layer Options') + '</div>' +
      '            <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">' +
      '              <span style="font-size:11px; color:var(--text-muted);" data-i18n="gifEditorLayerScale">' + t('gifEditorLayerScale', 'Scale:') + '</span>' +
      '              <input type="range" id="gif-layer-scale" min="0.2" max="3" step="0.05" value="1" style="flex:1;">' +
      '            </div>' +
      '            <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">' +
      '              <button type="button" class="gif-btn gif-btn-danger gif-full-width" id="gif-delete-layer-btn" style="height:28px; font-size:11px;" data-i18n="gifEditorDeleteLayer">' + t('gifEditorDeleteLayer', 'Delete Layer') + '</button>' +
      '            </div>' +
      '          </div>' +
      '          <div id="gif-layer-list" style="margin-top:8px; max-height:100px; overflow-y:auto; font-size:11px;"></div>' +
      '        </div>' +
      '      </div>' +

      '    </div>' +
      '  </aside>' +
      '  <main class="gif-stage-area" id="gif-stage-container">' +
      '    <div class="gif-stage-overlay-text" id="gif-stage-overlay-text">' + t('gifEditorStageIdle', 'Stage') + '</div>' +
      '    <div class="gif-canvas-wrapper" id="gif-canvas-wrapper">' +
      '      <canvas id="gif-preview-canvas"></canvas>' +
      '    </div>' +
      '    <div class="gif-stage-controls">' +
      '      <button type="button" class="gif-icon-btn" id="gif-zoom-out-btn" title="' + t('gifEditorZoomOut', '缩小') + '">-</button>' +
      '      <button type="button" class="gif-icon-btn" id="gif-reset-view-btn" title="' + t('gifEditorResetView', '重置') + '">1:1</button>' +
      '      <button type="button" class="gif-icon-btn" id="gif-zoom-in-btn" title="' + t('gifEditorZoomIn', '放大') + '">+</button>' +
      '    </div>' +
      '  </main>' +
      '  <section class="gif-timeline-area" aria-label="GIF timeline">' +
      '    <div class="gif-timeline-scroll" id="gif-timeline-scroll">' +
      '      <div class="gif-timeline-track" id="gif-timeline"></div>' +
      '    </div>' +
      '    <div class="gif-timeline-toolbar">' +
      '      <div class="gif-timeline-zoom-control">' +
      '        <span class="gif-zoom-label" style="font-size:12px; color:var(--text-muted);">🔍</span>' +
      '        <input type="range" id="gif-timeline-zoom-range" min="0.2" max="3" step="0.05" value="1" style="width:100px; cursor:pointer;" title="Zoom">' +
      '        <span id="gif-timeline-zoom-value" style="font-size:11px; color:var(--text-muted); min-width:35px;">100%</span>' +
      '      </div>' +
      '      <div class="gif-timeline-nav" role="group">' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-first" title="' + t('gifTimelineFirst', '第一帧') + '">|&lt;</button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-prev" title="' + t('gifTimelinePrev', '上一帧') + '">&lt;</button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-play" title="' + t('gifTimelinePlay', '播放') + '" aria-label="' + t('gifTimelinePlay', '播放') + '">▶️</button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-next" title="' + t('gifTimelineNext', '下一帧') + '">&gt;</button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-last" title="' + t('gifTimelineLast', '最后一帧') + '">&gt;|</button>' +
      '      </div>' +
      '      <span class="gif-timeline-count" id="gif-timeline-count">0 / 0</span>' +
      '    </div>' +
      '  </section>' +

      '  <div class="gif-spinner-overlay" id="gif-loading-spinner">' +
      '    <div class="gif-spinner"></div>' +
      '    <div id="gif-spinner-text" style="color:#fff;">' + t('gifEditorProcessing', 'Processing...') + '</div>' +
      '  </div>' +

      '</div>';
  }

  // Export entry points globally. cleanup remains destructive for legacy page-leave callers.
  window.renderGifEditor = render;
  window.cleanupGifEditor = cleanup;
  window.suspendGifEditor = suspend;
  window.resumeGifEditor = resume;
  window.GifEditor = {
    render: render,
    cleanup: cleanup,
    suspend: suspend,
    resume: resume
  };
})();
