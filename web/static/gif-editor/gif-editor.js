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

  // ------------------------------------------------------------------
  // Lifecycle: render & cleanup (repeated enter/leave must be safe)
  // ------------------------------------------------------------------

  function render(container) {
    teardown();
    if (!container) container = document.getElementById('page-content');
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

    if (core.timeline && core.timeline.render) core.timeline.render();
    draw();
    resetView();
    return container;
  }

  function cleanup() {
    teardown();
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
      }
    }
    if (core) {
      core.cleanupModules();   // import (draft), timeline, playback, export cleanups
      core.resetSlices();      // release frame canvases
      core.releaseSource();    // revoke committed object URLs + media refs
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
    dom.resultOverlay = core.byId('result-overlay');
    dom.resultImg = core.byId('result-img');
    dom.dlLink = core.byId('dl-link');
    dom.resultOpenGallery = core.byId('result-open-gallery');
    dom.reloadBtn = core.byId('reload-btn');

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
    dom.startGlobalCropBtn = core.byId('start-global-crop-btn');
    dom.cropPanel = core.byId('crop-panel');
    dom.cropSlideX = core.byId('crop-slide-x'); dom.cropNumX = core.byId('crop-num-x');
    dom.cropSlideY = core.byId('crop-slide-y'); dom.cropNumY = core.byId('crop-num-y');
    dom.cropSlideW = core.byId('crop-slide-w'); dom.cropNumW = core.byId('crop-num-w');
    dom.cropSlideH = core.byId('crop-slide-h'); dom.cropNumH = core.byId('crop-num-h');
    dom.cancelCropBtn = core.byId('cancel-crop-btn');
    dom.applyCropBtn = core.byId('apply-crop-btn');
    dom.rangeInput = core.byId('range-input');
    dom.addTextInput = core.byId('add-text-input');
    dom.addTextBtn = core.byId('add-text-btn');
    dom.addTextColor = core.byId('add-text-color');
    dom.addImageInput = core.byId('add-image-input');
    dom.btnBold = core.byId('btn-bold');
    dom.btnItalic = core.byId('btn-italic');
    dom.btnUnderline = core.byId('btn-underline');
    dom.selectedLayerTools = core.byId('selected-layer-tools');
    dom.syncLayerBtn = core.byId('sync-layer-btn');
    dom.layerList = core.byId('layer-list');

    dom.batchDelayInput = core.byId('batch-delay-input');
    dom.batchDelayBtn = core.byId('batch-delay-btn');
    dom.outW = core.byId('out-w');
    dom.outH = core.byId('out-h');
    dom.outScaleSlider = core.byId('out-scale-slider');
    dom.outScaleVal = core.byId('out-scale-val');
    dom.qualitySlider = core.byId('quality-slider');
    dom.quality = core.byId('quality');
    dom.exportBtn = core.byId('export-gif');
    dom.exportZipBtn = core.byId('export-zip');
    dom.exportPngBtn = core.byId('export-sprite');

    dom.delStart = core.byId('del-start');
    dom.delEnd = core.byId('del-end');
    dom.btnDelRange = core.byId('btn-del-range');
    dom.btnKeepRange = core.byId('btn-keep-range');
    dom.spriteRows = core.byId('sprite-rows');
    dom.spriteCols = core.byId('sprite-cols');

    dom.zoomOutBtn = core.byId('zoom-out-btn');
    dom.resetViewBtn = core.byId('reset-view-btn');
    dom.zoomInBtn = core.byId('zoom-in-btn');

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

  // ------------------------------------------------------------------
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

  function updateSelectionUI(index) {
    var hasSlices = (core.state.slices || []).length > 0;
    if (dom.panelStep2) {
      dom.panelStep2.classList.toggle('gif-edit-blocked', !hasSlices);
    }
    if (dom.panelStep3) {
      dom.panelStep3.classList.toggle('gif-edit-blocked', !hasSlices);
    }
    if (dom.frameIndicator) {
      var idx = (index >= 0) ? index : core.state.selectedSliceIdx;
      dom.frameIndicator.textContent = (idx >= 0 && hasSlices) ? ((idx + 1) + ' / ' + (core.state.slices.length)) : '';
    }
    updateExportEnabled();
    renderLayerList();
  }

  function updateExportEnabled() {
    var has = (core.state.slices || []).length > 0;
    if (dom.exportBtn) dom.exportBtn.disabled = !has;
    if (dom.exportZipBtn) dom.exportZipBtn.disabled = !has;
    if (dom.exportPngBtn) dom.exportPngBtn.disabled = !has;
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
    if (dom.enableTrans) dom.enableTrans.checked = false;
    if (dom.transPanel) dom.transPanel.style.display = 'none';
    core.state.transparencyReady = false;
    core.state.pickColorMode = false;
    if (dom.canvasWrapper) dom.canvasWrapper.style.cursor = 'default';

    if (kind === 'image' && dom.sliderT) {
      var s0 = (core.state.slices || [])[0];
      if (s0 && s0.canvas) {
        dom.sliderT.max = Math.floor(s0.canvas.height / 2);
        dom.sliderB.max = Math.floor(s0.canvas.height / 2);
        dom.sliderL.max = Math.floor(s0.canvas.width / 2);
        dom.sliderR.max = Math.floor(s0.canvas.width / 2);
        dom.sliderT.value = 0; dom.cropT.value = 0;
        dom.sliderB.value = 0; dom.cropB.value = 0;
        dom.sliderL.value = 0; dom.cropL.value = 0;
        dom.sliderR.value = 0; dom.cropR.value = 0;
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
    var tVal = parseInt(dom.cropT.value, 10) || 0,
        bVal = parseInt(dom.cropB.value, 10) || 0,
        lVal = parseInt(dom.cropL.value, 10) || 0,
        rVal = parseInt(dom.cropR.value, 10) || 0;
    var maxT = Math.max(0, h - 1), maxL = Math.max(0, w - 1);
    tVal = Math.max(0, Math.min(maxT, tVal));
    bVal = Math.max(0, Math.min(maxT, bVal));
    lVal = Math.max(0, Math.min(maxL, lVal));
    rVal = Math.max(0, Math.min(maxL, rVal));
    return { t: tVal, b: bVal, l: lVal, r: rVal };
  }

  // Grid preview overlay (dimmed edges + row/col lines).
  function drawEdgeCropGrid(w, h) {
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
    var props = ['X', 'Y', 'W', 'H'];
    for (var p = 0; p < props.length; p++) {
      (function (prop) {
        var slider = core.byId('crop-slide-' + prop.toLowerCase());
        var num = core.byId('crop-num-' + prop.toLowerCase());
        if (!slider || !num) return;
        var update = function () {
          var val = parseInt(slider.value, 10);
          if (isNaN(val)) val = 0;
          num.value = val;
          core.state.cropRect[prop.toLowerCase()] = val;
          draw();
        };
        slider.addEventListener('input', update);
        num.addEventListener('change', function () {
          var val = parseInt(num.value, 10);
          if (isNaN(val)) val = 0;
          var max = parseInt(slider.max, 10);
          if (!isNaN(max)) val = Math.max(0, Math.min(max, val));
          slider.value = val;
          num.value = val;
          update();
        });
      })(props[p]);
    }
  }

  function syncCropSlidersFromRect() {
    if (core.state.mode !== 'crop') return;
    var r = core.state.cropRect;
    if (dom.cropSlideX) dom.cropSlideX.value = r.x;
    if (dom.cropNumX) dom.cropNumX.value = Math.round(r.x);
    if (dom.cropSlideY) dom.cropSlideY.value = r.y;
    if (dom.cropNumY) dom.cropNumY.value = Math.round(r.y);
    if (dom.cropSlideW) dom.cropSlideW.value = r.w;
    if (dom.cropNumW) dom.cropNumW.value = Math.round(r.w);
    if (dom.cropSlideH) dom.cropSlideH.value = r.h;
    if (dom.cropNumH) dom.cropNumH.value = Math.round(r.h);
  }

  function startGlobalCrop() {
    var slices = core.state.slices || [];
    if (core.state.selectedSliceIdx < 0 || !slices[core.state.selectedSliceIdx]) {
      alert(t('gifEditorAlertSliceFirst'));
      return;
    }
    var cur = slices[core.state.selectedSliceIdx].canvas;
    var pW = cur.width * 0.1, pH = cur.height * 0.1;
    core.state.cropRect = { x: pW, y: pH, w: cur.width - pW * 2, h: cur.height - pH * 2 };
    if (dom.cropSlideX) dom.cropSlideX.max = cur.width;
    if (dom.cropSlideW) dom.cropSlideW.max = cur.width;
    if (dom.cropSlideY) dom.cropSlideY.max = cur.height;
    if (dom.cropSlideH) dom.cropSlideH.max = cur.height;
    syncCropSlidersFromRect();
    core.state.mode = 'crop';
    if (dom.cropPanel) dom.cropPanel.classList.add('active');
    if (dom.startGlobalCropBtn) dom.startGlobalCropBtn.style.display = 'none';
    draw();
  }

  function cancelCrop() {
    core.state.mode = 'editor';
    if (dom.cropPanel) dom.cropPanel.classList.remove('active');
    if (dom.startGlobalCropBtn) dom.startGlobalCropBtn.style.display = 'block';
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
      if (dom.startGlobalCropBtn) dom.startGlobalCropBtn.style.display = 'block';
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
    var scopeEl = document.querySelector('input[name="gif-layer-scope"]:checked');
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
    var pts = dom.rangeInput.value.split(/[,，]/);
    var idxs = [];
    for (var p = 0; p < pts.length; p++) {
      var token = pts[p].trim();
      if (!token) continue;
      if (token.indexOf('-') >= 0) {
        var parts = token.split('-');
        var s = parseInt(parts[0], 10), e = parseInt(parts[1], 10);
        if (isNaN(s) || isNaN(e)) continue;
        for (var k = s; k <= e; k++) idxs.push(k - 1);
      } else {
        idxs.push(parseInt(token, 10) - 1);
      }
    }
    var filtered = [];
    for (var f = 0; f < idxs.length; f++) {
      if (idxs[f] >= 0 && idxs[f] < slices.length) filtered.push(idxs[f]);
    }
    return filtered;
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

  function syncLayer() {
    if (!core.state.activeLayer || core.state.selectedSliceIdx < 0) return;
    var src = core.state.activeLayer;
    if (!src.groupId) src.groupId = src.id;
    var slices = core.state.slices || [];
    for (var i = 0; i < slices.length; i++) {
      if (i === core.state.selectedSliceIdx) continue;
      var f = null;
      for (var j = 0; j < slices[i].layers.length; j++) {
        if (slices[i].layers[j].groupId === src.groupId) { f = slices[i].layers[j]; break; }
      }
      if (f) {
        Object.assign(f, src);
        f.id = core.freshId();
      } else {
        slices[i].layers.push(Object.assign({}, src, { id: core.freshId() }));
      }
    }
    alert(t('gifEditorSyncDone'));
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
    }
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
        }
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
    if (core.state.mode === 'crop') syncCropSlidersFromRect();
    draw();
  }

  function drawGizmo(o, c, isCrop) {
    var x, y, w, h;
    if (o.type === 'text') {
      ctx.font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + (o.size || 24) + 'px ' + (o.font || 'sans-serif');
      var m = ctx.measureText(o.content || '');
      x = o.x || 0; y = o.y || 0; w = m.width; h = o.size || 24;
    } else {
      x = o.x || 0; y = o.y || 0; w = o.w || 0; h = o.h || 0;
    }
    ctx.save();
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    if (isCrop) ctx.setLineDash([5, 5]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = 'white';
    var hs = 10;
    var dH = function (hx, hy) {
      ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
      ctx.strokeRect(hx - hs, hy - hs, hs * 2, hs * 2);
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
    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;
    var w = 300, h = 300;

    if (core.state.mode === 'source' && core.state.processedImg) {
      w = core.state.processedImg.width;
      h = core.state.processedImg.height;
    } else if (idx >= 0 && slices[idx] && slices[idx].canvas) {
      w = slices[idx].canvas.width;
      h = slices[idx].canvas.height;
    }
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    if (core.state.mode === 'source' && core.state.processedImg) {
      ctx.drawImage(core.state.processedImg, 0, 0);
      if (isImageUnsliced()) drawEdgeCropGrid(w, h);
    } else if (idx >= 0 && slices[idx] && slices[idx].canvas) {
      var s = slices[idx];
      // Preview transparency (video/GIF-derived frames).
      if (!core.state.srcImg && dom.enableTrans && dom.enableTrans.checked && core.state.transparencyReady) {
        var tempC = document.createElement('canvas');
        tempC.width = s.canvas.width;
        tempC.height = s.canvas.height;
        var tCtx = tempC.getContext('2d');
        tCtx.drawImage(s.canvas, 0, 0);
        applyTransparencyToCtx(tCtx, tempC.width, tempC.height);
        ctx.drawImage(tempC, 0, 0);
      } else {
        ctx.drawImage(s.canvas, 0, 0);
      }
      drawLayers(ctx, s.layers);
      if (isImageUnsliced()) drawEdgeCropGrid(w, h);
      if (core.state.mode === 'editor' && core.state.activeLayer) drawGizmo(core.state.activeLayer, '#3b82f6');
      if (core.state.mode === 'crop') {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, w, h);
        var cr = core.state.cropRect;
        ctx.clearRect(cr.x, cr.y, cr.w, cr.h);
        ctx.drawImage(s.canvas, cr.x, cr.y, cr.w, cr.h, cr.x, cr.y, cr.w, cr.h);
        ctx.save();
        ctx.beginPath();
        ctx.rect(cr.x, cr.y, cr.w, cr.h);
        ctx.clip();
        drawLayers(ctx, s.layers);
        ctx.restore();
        drawGizmo(core.state.cropRect, '#ef4444', true);
      }
    }

    updateStageOverlay();
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
    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;
    if (core.state.mode === 'source' && core.state.processedImg) {
      return { w: core.state.processedImg.width, h: core.state.processedImg.height };
    } else if (idx >= 0 && slices[idx] && slices[idx].canvas) {
      return { w: slices[idx].canvas.width, h: slices[idx].canvas.height };
    }
    return { w: canvas ? canvas.width : 0, h: canvas ? canvas.height : 0 };
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
    core.state.scale = Math.max(0.05, Math.min(1.0, fitScale));
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
        if (core.timeline) core.timeline.clearThumbCache();
        if (core.timeline && core.timeline.render) core.timeline.render();
        if (core.commands.focusFrame) core.commands.focusFrame(0);
        else { core.state.selectedSliceIdx = 0; draw(); }
      }
    });
  }

  // ------------------------------------------------------------------
  // Keyboard (capture-phase: Escape for pick-color / result modal)
  // ------------------------------------------------------------------

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (core.state.pickColorMode) {
      e.stopPropagation();
      cancelPickColor();
    }
    if (dom.resultOverlay && dom.resultOverlay.classList.contains('active')) {
      e.stopPropagation();
      if (core.export && core.export.closeResult) core.export.closeResult();
      return;
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
    var edgeSync = function (slider, num) {
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

    // Quality sync
    if (dom.quality) {
      dom.quality.addEventListener('change', function () {
        var v = parseInt(dom.quality.value, 10);
        if (isNaN(v)) v = 10;
        v = Math.max(1, Math.min(10, v));
        dom.quality.value = v;
        dom.qualitySlider.value = v;
      });
    }
    if (dom.qualitySlider) {
      dom.qualitySlider.addEventListener('input', function () {
        dom.quality.value = dom.qualitySlider.value;
      });
    }

    // Output scale
    if (dom.outScaleSlider) {
      dom.outScaleSlider.addEventListener('input', function (e) {
        var s = parseFloat(e.target.value);
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

    // Batch delay
    if (dom.batchDelayBtn) {
      dom.batchDelayBtn.addEventListener('click', function () {
        var val = parseInt(dom.batchDelayInput.value, 10);
        if (isNaN(val) || val < 0) { alert(t('gifEditorAlertDelayInvalid')); return; }
        var slices = core.state.slices || [];
        if (!slices.length) { alert(t('gifEditorAlertNoFrames')); return; }
        for (var i = 0; i < slices.length; i++) slices[i].delay = val;
        // Refresh only the delay inputs currently rendered (windowed DOM).
        var track = dom.timeline;
        if (track) {
          var inputs = track.querySelectorAll('.gif-delay-input');
          for (var j = 0; j < inputs.length; j++) inputs[j].value = val;
        }
      });
    }

    // Global crop
    if (dom.startGlobalCropBtn) dom.startGlobalCropBtn.addEventListener('click', startGlobalCrop);
    if (dom.cancelCropBtn) dom.cancelCropBtn.addEventListener('click', cancelCrop);
    if (dom.applyCropBtn) dom.applyCropBtn.addEventListener('click', applyCrop);
    setupCropSliders();

    // Transparency
    if (dom.enableTrans) dom.enableTrans.addEventListener('change', toggleTransPanel);
    if (dom.keyColor) dom.keyColor.addEventListener('input', transParamChanged);
    if (dom.fuzziness) dom.fuzziness.addEventListener('input', transParamChanged);
    if (dom.pickColorBtn) dom.pickColorBtn.addEventListener('click', pickColorClick);
    if (dom.disableTransBtn) {
      dom.disableTransBtn.addEventListener('click', function () { if (dom.enableTrans) dom.enableTrans.click(); });
    }

    // Stage pointer (crop / layer gizmo / pan / color pick)
    if (dom.stage) {
      dom.stage.addEventListener('mousedown', handlePointerDown);
      dom.stage.addEventListener('touchstart', handlePointerDown, { passive: false });
    }
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchend', onPointerUp);

    // Zoom
    if (dom.zoomInBtn) dom.zoomInBtn.addEventListener('click', function () { core.state.scale = Math.min(5, core.state.scale * 1.2); updateTransform(); });
    if (dom.zoomOutBtn) dom.zoomOutBtn.addEventListener('click', function () { core.state.scale = Math.max(0.2, core.state.scale * 0.8); updateTransform(); });
    if (dom.resetViewBtn) dom.resetViewBtn.addEventListener('click', resetView);

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
    if (dom.syncLayerBtn) dom.syncLayerBtn.addEventListener('click', syncLayer);
    if (dom.layerList) dom.layerList.addEventListener('click', onLayerListClick);
    var scopeRadios = document.querySelectorAll('input[name="gif-layer-scope"]');
    for (var i = 0; i < scopeRadios.length; i++) {
      scopeRadios[i].addEventListener('change', function (e) {
        if (dom.rangeInput) dom.rangeInput.style.display = e.target.value === 'range' ? 'block' : 'none';
      });
    }

    // Batch delete / keep
    if (dom.btnDelRange) dom.btnDelRange.addEventListener('click', deleteRange);
    if (dom.btnKeepRange) dom.btnKeepRange.addEventListener('click', keepRange);

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
      '      <div class="gif-group-title-row">' +
      '        <div class="gif-group-title" data-i18n="gifEditorStep1">1. 导入素材</div>' +
      '        <button type="button" class="btn btn-ghost btn-sm" id="gif-reload-btn" data-i18n="gifEditorReload">重置</button>' +
      '      </div>' +
      '      <div class="gif-drop-zone" id="gif-drop-zone">' +
      '        <div style="font-size: var(--font-h3); margin-bottom: 4px;">📂</div>' +
      '        <div data-i18n="gifEditorDropHint">选择 / 拖放 / 粘贴文件</div>' +
      '        <input type="file" id="gif-file-input" style="display:none;" accept="image/*,video/*,.gif">' +
      '      </div>' +
      '      <div id="gif-transparency-wrapper">' +
      '        <label class="gif-check-label"><input type="checkbox" id="gif-enable-trans"> <span data-i18n="gifEditorEnableTrans">色键透明</span></label>' +
      '        <div id="gif-trans-panel" class="gif-trans-panel">' +
      '          <div class="gif-control-row">' +
      '            <input type="color" id="gif-key-color" value="#ffffff" class="gif-key-color-input" title="' + t('gifEditorPickColorTitle', 'Key color') + '">' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-flex-1" id="gif-pick-color-btn" title="' + t('gifEditorPickColorTitle', 'Key color') + '">' + t('gifEditorPickColor', '取色') + '</button>' +
      '          </div>' +
      '          <div class="gif-trans-hint" data-i18n="gifEditorPickColorHint">选择要变为透明的颜色</div>' +
      '          <div class="gif-control-row">' +
      '            <span class="gif-muted-label" data-i18n="gifEditorFuzziness">容差</span>' +
      '            <input type="range" id="gif-fuzziness" min="0" max="100" value="15" class="gif-flex-1" title="' + t('gifEditorFuzzinessTitle', 'Fuzziness') + '">' +
      '          </div>' +
      '          <button type="button" class="gif-btn gif-btn-danger gif-full-width gif-mt-sm" id="gif-disable-trans-btn" data-i18n="gifEditorDisableTrans">取消透明</button>' +
      '        </div>' +
      '      </div>' +
      '      <div id="gif-image-tools" class="gif-hidden">' +
      '        <div class="gif-group-title gif-mt" data-i18n="gifEditorEdgeFix">边缘裁剪</div>' +
      '        <div class="gif-range-wrap"><span class="gif-axis-label">' + t('gifEditorTop', '上') + '</span><input type="range" id="gif-slider-t" value="0"><input type="number" id="gif-crop-t" value="0" class="gif-crop-num"></div>' +
      '        <div class="gif-range-wrap"><span class="gif-axis-label">' + t('gifEditorBottom', '下') + '</span><input type="range" id="gif-slider-b" value="0"><input type="number" id="gif-crop-b" value="0" class="gif-crop-num"></div>' +
      '        <div class="gif-range-wrap"><span class="gif-axis-label">' + t('gifEditorLeft', '左') + '</span><input type="range" id="gif-slider-l" value="0"><input type="number" id="gif-crop-l" value="0" class="gif-crop-num"></div>' +
      '        <div class="gif-range-wrap"><span class="gif-axis-label">' + t('gifEditorRight', '右') + '</span><input type="range" id="gif-slider-r" value="0"><input type="number" id="gif-crop-r" value="0" class="gif-crop-num"></div>' +
      '        <div class="gif-group-title gif-mt" data-i18n="gifEditorGridSlice">网格切片</div>' +
      '        <div class="gif-control-row">' +
      '          <input type="number" id="gif-rows" value="3" min="1" placeholder="' + t('gifEditorRows', '行') + '">' +
      '          <input type="number" id="gif-cols" value="3" min="1" placeholder="' + t('gifEditorCols', '列') + '">' +
      '        </div>' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width gif-mt-sm" id="gif-slice-btn" data-i18n="gifEditorSliceBtn">开始切片</button>' +
      '      </div>' +
      '    </div>' +
      '    <div class="gif-panel-sep gif-edit-blocked" id="gif-panel-step2">' +
      '      <div class="gif-group-title" data-i18n="gifEditorStep2">2. 单帧编辑</div>' +
      '      <button type="button" class="gif-btn gif-btn-accent gif-full-width gif-mb" id="gif-global-crop-btn" data-i18n="gifEditorGlobalCrop">✂️ 全局裁剪 (框选画布)</button>' +
      '      <div class="gif-scope-box">' +
      '        <span class="gif-axis-label" data-i18n="gifEditorScope">作用:</span>' +
      '        <label class="gif-radio-label"><input type="radio" name="gif-scope" value="current" checked> <span data-i18n="gifEditorScopeCurrent">当前帧</span></label>' +
      '        <label class="gif-radio-label"><input type="radio" name="gif-scope" value="all"> <span data-i18n="gifEditorScopeAll">全部帧</span></label>' +
      '        <label class="gif-radio-label"><input type="radio" name="gif-scope" value="range"> <span data-i18n="gifEditorScopeRange">范围</span></label>' +
      '        <div class="gif-control-row gif-range-input" id="gif-crop-range-inputs">' +
      '          <input type="number" id="gif-crop-start" placeholder="' + t('gifEditorStartFrame', '起始帧') + '">' +
      '          <input type="number" id="gif-crop-end" placeholder="' + t('gifEditorEndFrame', '结束帧') + '">' +
      '        </div>' +
      '      </div>' +
      '      <div class="gif-control-row">' +
      '        <input type="text" id="gif-text-input" placeholder="' + t('gifEditorTextInput', '输入文字...') + '" class="gif-flex-1">' +
      '        <button type="button" class="gif-btn gif-btn-primary" id="gif-add-text-btn" data-i18n="gifEditorAddText">+ 文字</button>' +
      '      </div>' +
      '      <div class="gif-style-toolbar">' +
      '        <button type="button" class="gif-style-btn" id="gif-btn-bold" title="' + t('gifEditorBold', '加粗') + '">B</button>' +
      '        <button type="button" class="gif-style-btn" id="gif-btn-italic" title="' + t('gifEditorItalic', '斜体') + '">I</button>' +
      '        <button type="button" class="gif-style-btn" id="gif-btn-underline" title="' + t('gifEditorUnderline', '下划线') + '">U</button>' +
      '        <label class="gif-style-btn gif-style-image-label" title="' + t('gifEditorAddImage', '添加贴图') + '">' +
      '          📷' +
      '          <input type="file" id="gif-add-image-input" style="display:none" accept="image/*">' +
      '        </label>' +
      '      </div>' +
      '      <div class="gif-group-title" data-i18n="gifEditorLayerList">图层列表</div>' +
      '      <div class="gif-layer-list" id="gif-layer-list"></div>' +
      '      <div class="gif-selected-layer-tools" id="gif-selected-layer-tools">' +
      '        <div class="gif-control-row">' +
      '          <span class="gif-muted-label" data-i18n="gifEditorColor">颜色</span>' +
      '          <input type="color" id="gif-text-color" value="#ffffff" class="gif-style-color">' +
      '          <span class="gif-muted-label" data-i18n="gifEditorStroke">描边</span>' +
      '          <input type="color" id="gif-text-stroke-color" value="#000000" class="gif-style-color">' +
      '        </div>' +
      '        <div class="gif-control-row">' +
      '          <span class="gif-muted-label" data-i18n="gifEditorScale">缩放</span>' +
      '          <input type="range" id="gif-layer-scale" min="0.2" max="3" step="0.1" value="1" class="gif-flex-1">' +
      '          <button type="button" class="gif-btn gif-btn-danger gif-sm-btn" id="gif-delete-layer-btn" data-i18n="gifEditorDeleteLayer">删除</button>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '    <div class="gif-panel-sep gif-edit-blocked" id="gif-panel-step3">' +
      '      <div class="gif-group-title" data-i18n="gifEditorStep3">3. 输出设置</div>' +
      '      <div class="gif-control-row">' +
      '        <input type="number" id="gif-scale-percent" value="100" min="10" max="300">' +
      '        <button type="button" class="gif-btn gif-btn-primary" id="gif-apply-scale-btn" data-i18n="gifEditorApplyAll">⚡ 应用到全部</button>' +
      '      </div>' +
      '      <div class="gif-control-row">' +
      '        <input type="number" id="gif-output-width" placeholder="' + t('gifEditorWidth', '宽度') + '">' +
      '        <input type="number" id="gif-output-height" placeholder="' + t('gifEditorHeight', '高度') + '">' +
      '      </div>' +
      '      <div class="gif-range-wrap">' +
      '        <span class="gif-scale-label" data-i18n="gifEditorScaleLabel">缩放</span>' +
      '        <input type="range" id="gif-output-scale-slider" min="10" max="300" value="100" class="gif-flex-1">' +
      '        <span class="gif-scale-val" id="gif-output-scale-val">1.0x</span>' +
      '      </div>' +
      '      <div class="gif-group-title gif-quality-title" data-i18n="gifEditorQualityTitle">GIF 质量 (采样间隔)' +
      '        <span class="gif-quality-range" data-i18n="gifEditorQualityHint">1: 最佳 - 10: 最快</span>' +
      '      </div>' +
      '      <div class="gif-control-row">' +
      '        <input type="range" id="gif-sample-interval" min="1" max="10" value="10" class="gif-flex-1">' +
      '        <span id="gif-quality-val" style="width: 20px; text-align: right;">10</span>' +
      '      </div>' +
      '      <button type="button" class="gif-btn gif-btn-primary gif-full-width gif-mt" id="gif-export-gif-btn" data-i18n="gifEditorExportGif">⚡ 预览 (导出 GIF)</button>' +
      '      <div class="gif-control-row gif-mt-sm">' +
      '        <label class="gif-radio-label"><input type="radio" name="gif-export-fmt" value="zip" checked> <span data-i18n="gifEditorExportZip">导出帧图 (ZIP)</span></label>' +
      '      </div>' +
      '      <button type="button" class="gif-btn gif-full-width gif-mt-sm" id="gif-export-frames-btn" data-i18n="gifEditorExportFrames">导出帧图 (ZIP)</button>' +
      '      <div class="gif-output-sep-inner">' +
      '        <div class="gif-group-title" data-i18n="gifEditorBatchDelete">批量删除帧</div>' +
      '        <div class="gif-control-row">' +
      '          <input type="number" id="gif-del-start" placeholder="' + t('gifEditorStartFrame', '起始帧') + '">' +
      '          <input type="number" id="gif-del-end" placeholder="' + t('gifEditorEndFrame', '结束帧') + '">' +
      '        </div>' +
      '        <div class="gif-control-row">' +
      '          <button type="button" class="gif-btn gif-btn-danger gif-flex-1" id="gif-delete-range-btn" data-i18n="gifEditorDeleteRange">🗑️ 删除指定</button>' +
      '          <button type="button" class="gif-btn gif-btn-primary gif-flex-1" id="gif-keep-range-btn" data-i18n="gifEditorKeepRange">保留指定</button>' +
      '        </div>' +
      '        <div class="gif-group-title gif-mt" data-i18n="gifEditorExportSprite">导出拼图 (Sprite Sheet)</div>' +
      '        <div class="gif-control-row">' +
      '          <input type="number" id="gif-sprite-rows" value="1" min="1" placeholder="' + t('gifEditorSpriteRows', '行') + '">' +
      '          <input type="number" id="gif-sprite-cols" value="5" min="1" placeholder="' + t('gifEditorSpriteCols', '列') + '">' +
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
      '    <div class="gif-timeline-toolbar" id="gif-timeline-toolbar">' +
      '      <div class="gif-timeline-zoom">' +
      '        <span class="gif-muted-label" id="gif-timeline-zoom-label" data-i18n="gifTimelineZoom">Zoom:</span>' +
      '        <input type="range" id="gif-timeline-zoom-range" min="0.1" max="3" step="0.05" value="1">' +
      '        <span id="gif-timeline-zoom-value">100%</span>' +
      '      </div>' +
      '      <span class="gif-timeline-count" id="gif-timeline-count">0 / 0</span>' +
      '      <div class="gif-timeline-nav" role="group">' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-first" title="' + t('gifTimelineFirst', '第一帧') + '">|&lt;</button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-prev" title="' + t('gifTimelinePrev', '上一帧') + '">&lt;</button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-play" title="' + t('gifTimelinePlay', '播放') + '" aria-label="' + t('gifTimelinePlay', '播放') + '">▶️</button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-next" title="' + t('gifTimelineNext', '下一帧') + '">&gt;</button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-last" title="' + t('gifTimelineLast', '最后一帧') + '">&gt;|</button>' +
      '      </div>' +
      '    </div>' +
      '  </section>' +

      '  <div class="gif-spinner-overlay" id="gif-loading-spinner">' +
      '    <div class="gif-spinner"></div>' +
      '    <div id="gif-spinner-text" style="color:#fff;">' + t('gifEditorProcessing', 'Processing...') + '</div>' +
      '  </div>' +

      '  <div class="gif-result-overlay" id="gif-result-overlay">' +
      '    <div class="gif-result-box">' +
      '      <div class="gif-result-title">' + t('gifEditorResultTitle', 'Export Complete') + '</div>' +
      '      <img id="gif-result-img" class="gif-result-img" alt="Result">' +
      '      <div class="gif-result-actions">' +
      '        <a id="gif-dl-link" class="btn btn-primary" download>' + t('gifEditorDownloadGif', 'Download') + '</a>' +
      '        <button type="button" id="gif-result-open-gallery" class="btn btn-ghost">' + t('gifEditorOpenGallery', 'Open in Gallery') + '</button>' +
      '        <button type="button" id="gif-result-close" class="btn btn-ghost">' + t('gifEditorClose', 'Close') + '</button>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</div>';
  }

  // Export entry points globally
  window.renderGifEditor = render;
  window.cleanupGifEditor = cleanup;
  window.GifEditor = {
    render: render,
    cleanup: cleanup
  };
})();
