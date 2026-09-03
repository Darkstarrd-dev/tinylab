// web/static/gif-editor.js
// GIF / frame editor page for TinyLab (header nav 6th button, data-page="gif").
// Pure local SPA, classic script execution under web/static/.
//
// Module split (docs/gif_upgrade.md §4): state/lifecycle, import (Import Modal),
// timeline (virtualized window + zoom), playback (First/Prev/Play/Next/Last),
// export (GIF/ZIP/sprite + MediaBridge) live in gif-editor-{state,import,
// timeline,playback,export}.js. This entry owns the page template, canvas
// stage (pan/zoom/crop gizmo/layer gizmo), chroma-key transparency, edge
// crop + grid slice, layer creation/editing and the shared compositor.

// Split: gif-editor-actions.js
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

  function isImageUnsliced() {
    return core.state.source.kind === 'image' && !core.state.source.gridSliced &&
      (core.state.slices || []).length === 1;
  }
  shared.fns.isImageUnsliced = isImageUnsliced;

  function runSlice() {
    // The slice cells replace the pristine source canvas: materialize any
    // committed transparency into the source first (seeds are dropped).
    shared.fns.materializeTransparency();
    var src = core.state.processedImg ||
      ((core.state.slices && core.state.slices[0]) ? core.state.slices[0].canvas : null);
    if (!src) { alert(shared.fns.t('gifEditorAlertNoImage')); return; }

    var c = shared.fns.edgeCropValues(src.width, src.height);
    var rows = parseInt(shared.dom.rows.value, 10) || 1,
        cols = parseInt(shared.dom.cols.value, 10) || 1;
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
    shared.dom.outW.value = sw;
    shared.dom.outH.value = sh;
    if (core.timeline) core.timeline.render();
    if (core.commands.focusFrame) core.commands.focusFrame(0);
    else { core.state.selectedSliceIdx = 0; shared.fns.draw(); }
  }

  // ------------------------------------------------------------------
  // Global crop (rect applied to every frame, layer coords offset)
  // ------------------------------------------------------------------
  shared.fns.runSlice = runSlice;

  function setupCropSliders() {
    shared.dom.cropNumL = core.byId('crop-num-l');
    shared.dom.cropNumR = core.byId('crop-num-r');
    shared.dom.cropNumT = core.byId('crop-num-t');
    shared.dom.cropNumB = core.byId('crop-num-b');

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
      var l = parseInt(shared.dom.cropNumL ? shared.dom.cropNumL.value : 0, 10);
      var r = parseInt(shared.dom.cropNumR ? shared.dom.cropNumR.value : 0, 10);
      var t = parseInt(shared.dom.cropNumT ? shared.dom.cropNumT.value : 0, 10);
      var b = parseInt(shared.dom.cropNumB ? shared.dom.cropNumB.value : 0, 10);

      if (isNaN(l)) l = 0;
      if (isNaN(r)) r = 0;
      if (isNaN(t)) t = 0;
      if (isNaN(b)) b = 0;

      l = Math.max(0, Math.min(dims.width - 1, l));
      r = Math.max(0, Math.min(dims.width - l - 1, r));
      t = Math.max(0, Math.min(dims.height - 1, t));
      b = Math.max(0, Math.min(dims.height - t - 1, b));

      if (shared.dom.cropNumL) shared.dom.cropNumL.value = l;
      if (shared.dom.cropNumR) shared.dom.cropNumR.value = r;
      if (shared.dom.cropNumT) shared.dom.cropNumT.value = t;
      if (shared.dom.cropNumB) shared.dom.cropNumB.value = b;

      core.state.cropRect = {
        x: l,
        y: t,
        w: Math.max(1, dims.width - l - r),
        h: Math.max(1, dims.height - t - b)
      };
      shared.fns.draw();
    };

    var inputs = [shared.dom.cropNumL, shared.dom.cropNumR, shared.dom.cropNumT, shared.dom.cropNumB];
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i]) {
        inputs[i].addEventListener('input', updateFromEdgeInputs);
        inputs[i].addEventListener('change', updateFromEdgeInputs);
      }
    }
  }
  shared.fns.setupCropSliders = setupCropSliders;

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

    if (shared.dom.cropNumL) { shared.dom.cropNumL.max = dims.width; shared.dom.cropNumL.value = leftVal; }
    if (shared.dom.cropNumR) { shared.dom.cropNumR.max = dims.width; shared.dom.cropNumR.value = rightVal; }
    if (shared.dom.cropNumT) { shared.dom.cropNumT.max = dims.height; shared.dom.cropNumT.value = topVal; }
    if (shared.dom.cropNumB) { shared.dom.cropNumB.max = dims.height; shared.dom.cropNumB.value = bottomVal; }
  }
  shared.fns.syncCropSlidersFromRect = syncCropSlidersFromRect;

  function startGlobalCrop() {
    var slices = core.state.slices || [];
    if (core.state.selectedSliceIdx < 0 || !slices[core.state.selectedSliceIdx]) {
      alert(shared.fns.t('gifEditorAlertSliceFirst'));
      return;
    }
    var cur = slices[core.state.selectedSliceIdx].canvas;
    var pW = 0, pH = 0;
    core.state.cropRect = { x: 0, y: 0, w: cur.width, h: cur.height };
    if (shared.dom.cropNumX) shared.dom.cropNumX.max = cur.width;
    if (shared.dom.cropNumW) shared.dom.cropNumW.max = cur.width;
    if (shared.dom.cropNumY) shared.dom.cropNumY.max = cur.height;
    if (shared.dom.cropNumH) shared.dom.cropNumH.max = cur.height;
    core.state.mode = 'crop';
    syncCropSlidersFromRect();
    if (shared.dom.cropPanel) {
      shared.dom.cropPanel.classList.add('active');
      shared.dom.cropPanel.style.display = 'block';
    }
    shared.fns.draw();
  }
  shared.fns.startGlobalCrop = startGlobalCrop;

  function cancelCrop() {
    core.state.mode = 'editor';
    if (shared.dom.cropPanel) {
      shared.dom.cropPanel.classList.remove('active');
      shared.dom.cropPanel.style.display = 'none';
    }
    shared.fns.draw();
  }
  shared.fns.cancelCrop = cancelCrop;

  function applyCrop() {
    // Cropping replaces the pristine canvases: bake the committed removal
    // into them first so the crop does not silently drop transparency.
    shared.fns.materializeTransparency();
    var r = core.state.cropRect;
    core.showSpinner(shared.fns.t('gifEditorCropping'));
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
      // The cropped frame is now the canonical image source: refresh
      // processedImg so a subsequent Split Sheet uses the crop, not a stale
      // pre-crop shared.canvas.
      if (core.state.source && core.state.source.kind === 'image') {
        core.state.processedImg = slices[core.state.selectedSliceIdx >= 0 ? core.state.selectedSliceIdx : 0].canvas;
      }
      core.state.mode = 'editor';
      if (shared.dom.outW) shared.dom.outW.value = Math.round(r.w);
      if (shared.dom.outH) shared.dom.outH.value = Math.round(r.h);
      if (shared.dom.cropPanel) shared.dom.cropPanel.classList.remove('active');
      if (core.timeline) core.timeline.clearThumbCache(); // slice canvases replaced
      if (core.timeline && core.timeline.render) core.timeline.render();
      if (core.commands.focusFrame) core.commands.focusFrame(core.state.selectedSliceIdx);
      else shared.fns.draw();
      core.hideSpinner();
    }, 50);
  }

  // ------------------------------------------------------------------
  // Layers (text / image; scope current/all/range; sync by groupId)
  // ------------------------------------------------------------------
  shared.fns.applyCrop = applyCrop;

  function getTargetIndices() {
    var scopeEl = document.querySelector('input[name="gif-scope"]:checked');
    if (!scopeEl) return [];
    var scope = scopeEl.value;
    var slices = core.state.slices || [];
    if (core.state.selectedSliceIdx < 0) {
      alert(shared.fns.t('gifEditorAlertNoFrameSelected'));
      return [];
    }
    if (scope === 'current') return [core.state.selectedSliceIdx];
    if (scope === 'all') {
      var all = [];
      for (var i = 0; i < slices.length; i++) all.push(i);
      return all;
    }
    var s = parseInt(shared.dom.rangeStart ? shared.dom.rangeStart.value : '', 10);
    var e = parseInt(shared.dom.rangeEnd ? shared.dom.rangeEnd.value : '', 10);
    if (isNaN(s) || isNaN(e)) { alert(shared.fns.t('gifEditorAlertRangeInvalid')); return []; }
    if (s < 1 || e < 1) { alert(shared.fns.t('gifEditorAlertRangeMin')); return []; }
    if (s > e) { alert(shared.fns.t('gifEditorAlertRangeOrder')); return []; }
    var idxs = [];
    for (var k = s - 1; k <= e - 1 && k < slices.length; k++) {
      if (k >= 0) idxs.push(k);
    }
    return idxs;
  }
  shared.fns.getTargetIndices = getTargetIndices;

  function addText() {
    var idxs = getTargetIndices();
    var txt = shared.dom.addTextInput.value;
    if (!idxs.length || !txt) return;
    var ref = core.state.slices[core.state.selectedSliceIdx];
    var gid = core.freshId();
    for (var i = 0; i < idxs.length; i++) {
      core.state.slices[idxs[i]].layers.push({
        id: core.freshId(),
        groupId: gid,
        type: 'text',
        content: txt,
        color: shared.dom.addTextColor.value,
        strokeColor: shared.dom.strokeColor ? shared.dom.strokeColor.value : '#000000',
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
    shared.fns.draw();
  }
  shared.fns.addText = addText;

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
        shared.fns.draw();
      };
      img.src = evt.target.result;
    };
    r.readAsDataURL(file);
  }
  shared.fns.addImageFromFile = addImageFromFile;

  function toggleStyle(p, btnName) {
    core.state.textStyle[p] = !core.state.textStyle[p];
    shared.dom[btnName].classList.toggle('active', core.state.textStyle[p]);
    if (core.state.activeLayer && core.state.activeLayer.type === 'text') {
      core.state.activeLayer[p] = core.state.textStyle[p];
      shared.fns.draw();
    }
  }

  shared.fns.toggleStyle = toggleStyle;

  function removeLayer(i) {
    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;
    if (idx < 0 || idx >= slices.length) return;
    slices[idx].layers.splice(i, 1);
    core.state.activeLayer = null;
    updateSelectionUI(idx);
    shared.fns.draw();
  }
  shared.fns.removeLayer = removeLayer;

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
      if (shared.dom.btnBold) shared.dom.btnBold.classList.toggle('active', !!layer.bold);
      if (shared.dom.btnItalic) shared.dom.btnItalic.classList.toggle('active', !!layer.italic);
      if (shared.dom.btnUnderline) shared.dom.btnUnderline.classList.toggle('active', !!layer.underline);
      if (shared.dom.addTextColor) shared.dom.addTextColor.value = layer.color || '#ffffff';
      if (shared.dom.strokeColor) shared.dom.strokeColor.value = layer.strokeColor || '#000000';
    }
    shared.layerBase = { size: layer.size, w: layer.w, h: layer.h };
    if (shared.dom.layerScale) shared.dom.layerScale.value = 1;
    updateSelectionUI(core.state.selectedSliceIdx);
    shared.fns.draw();
  }

  // ------------------------------------------------------------------
  // Stage interaction: pan/zoom, crop gizmo, layer gizmo, color pick
  // ------------------------------------------------------------------
  shared.fns.onLayerListClick = onLayerListClick;

  function updateSelectionUI(index) {
    var hasSlices = (core.state.slices || []).length > 0;
    if (shared.dom.sidebarEditorContent) {
      shared.dom.sidebarEditorContent.style.display = hasSlices ? 'block' : 'none';
    }
    if (shared.dom.panelStep2) {
      shared.dom.panelStep2.classList.toggle('gif-edit-blocked', !hasSlices);
    }
    if (shared.dom.panelStep3) {
      shared.dom.panelStep3.classList.toggle('gif-edit-blocked', !hasSlices);
    }
    if (shared.dom.dropZone) {
      shared.dom.dropZone.style.display = hasSlices ? 'none' : 'flex';
    }
    if (shared.dom.dropZoneContainer) {
      shared.dom.dropZoneContainer.style.display = hasSlices ? 'none' : 'block';
    }
    if (shared.dom.frameIndicator) {
      var idx = (index >= 0) ? index : core.state.selectedSliceIdx;
      shared.dom.frameIndicator.textContent = (idx >= 0 && hasSlices) ? ((idx + 1) + ' / ' + (core.state.slices.length)) : '';
    }
    updateExportEnabled();
    renderLayerList();
  } // ------------------------------------------------------------------
  // Canvas Rendering & Composition
  // ------------------------------------------------------------------
  shared.fns.updateSelectionUI = updateSelectionUI;

  function updateExportEnabled() {
    var has = (core.state.slices || []).length > 0;
    if (shared.dom.exportBtn) shared.dom.exportBtn.disabled = !has;
    if (shared.dom.exportZipBtn) shared.dom.exportZipBtn.disabled = !has;
    if (shared.dom.exportPngBtn) shared.dom.exportPngBtn.disabled = !has;
    if (shared.dom.openExportBtn) shared.dom.openExportBtn.disabled = !has;
  }
  shared.fns.updateExportEnabled = updateExportEnabled;

  function renderLayerList() {
    if (!shared.dom.layerList) return;
    shared.dom.layerList.innerHTML = '';
    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;
    if (idx < 0 || idx >= slices.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-muted);font-size:var(--font-badge);padding:4px;';
      empty.textContent = shared.fns.t('gifEditorNoLayer', 'No layers');
      shared.dom.layerList.appendChild(empty);
      return;
    }
    var layers = slices[idx].layers || [];
    if (!layers.length) {
      var empty2 = document.createElement('div');
      empty2.style.cssText = 'color:var(--text-muted);font-size:var(--font-badge);padding:4px;';
      empty2.textContent = shared.fns.t('gifEditorNoLayer', 'No layers');
      shared.dom.layerList.appendChild(empty2);
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
      shared.dom.layerList.appendChild(item);
    }
    if (shared.dom.selectedLayerTools) {
      shared.dom.selectedLayerTools.style.display = core.state.activeLayer ? 'block' : 'none';
    }
  }
  shared.fns.renderLayerList = renderLayerList;

  function updateSourcePanels(kind, opts) {
    if (shared.dom.imageTools) shared.dom.imageTools.style.display = (kind === 'image' ? 'block' : 'none');
    if (shared.dom.splitSheetContainer) shared.dom.splitSheetContainer.style.display = (kind === 'image' ? 'block' : 'none');
    if (shared.dom.globalDelayContainer) shared.dom.globalDelayContainer.style.display = 'block';
    if (shared.dom.batchDeleteContainer) shared.dom.batchDeleteContainer.style.display = (kind === 'image' ? 'none' : 'block');
    if (shared.dom.intervalDeleteContainer) shared.dom.intervalDeleteContainer.style.display = (kind === 'image' ? 'none' : 'block');
    if (shared.dom.overlayContainer) shared.dom.overlayContainer.style.display = (kind === 'image' ? 'none' : 'block');
    // The hidden checkbox mirrors the committed snapshot so a page re-entry
    // (shared.fns.render -> updateSourcePanels without resetTrans) keeps applied
    // transparency alive; a new source (resetTrans) clears it fully.
    if (shared.dom.enableTrans) shared.dom.enableTrans.checked = !!(core.state.trans && core.state.trans.committed);
    if (shared.dom.transPanel) shared.dom.transPanel.style.display = 'none';
    core.state.pickColorMode = false;
    core.state.floodPickMode = false;
    if (shared.dom.canvasWrapper) shared.dom.canvasWrapper.style.cursor = 'default';
    if (opts && opts.resetTrans) {
      shared.fns.resetTransState();
    } else {
      shared.fns.syncTransPanelUI();
    }

    if (kind === 'image' && (shared.dom.cropNumL || shared.dom.sliderT)) {
      var s0 = (core.state.slices || [])[0];
      if (s0 && s0.canvas) {
        if (shared.dom.cropNumT) shared.dom.cropNumT.value = 0;
        if (shared.dom.cropNumB) shared.dom.cropNumB.value = 0;
        if (shared.dom.cropNumL) shared.dom.cropNumL.value = 0;
        if (shared.dom.cropNumR) shared.dom.cropNumR.value = 0;
        if (shared.dom.sliderT) {
          shared.dom.sliderT.max = Math.floor(s0.canvas.height / 2);
          shared.dom.sliderB.max = Math.floor(s0.canvas.height / 2);
          shared.dom.sliderL.max = Math.floor(s0.canvas.width / 2);
          shared.dom.sliderR.max = Math.floor(s0.canvas.width / 2);
          shared.dom.sliderT.value = 0; if (shared.dom.cropT) shared.dom.cropT.value = 0;
          shared.dom.sliderB.value = 0; if (shared.dom.cropB) shared.dom.cropB.value = 0;
          shared.dom.sliderL.value = 0; if (shared.dom.cropL) shared.dom.cropL.value = 0;
          shared.dom.sliderR.value = 0; if (shared.dom.cropR) shared.dom.cropR.value = 0;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Transparency (magic wand): color key / flood fill / soft edge
  //
  // Session model: the DOM inputs are LIVE params while the panel is open
  // (the stage preview re-runs the pipeline on every change — no Apply
  // needed to see the result). Apply freezes the live params into
  // state.trans.committed and checks the hidden enable-trans checkbox.
  // Slice canvases are NEVER baked: every consumer (stage preview when the
  // panel is closed, thumbnails, exports) runs the GifEditorTransparency
  // pipeline against the pristine shared.canvas with the committed params, so
  // adjustments stay fully reversible. A destructive transform (crop /
  // resize / grid slice / split sheet) materializes the committed removal
  // into the new canvases via shared.fns.materializeTransparency().
  // ------------------------------------------------------------------
  shared.fns.updateSourcePanels = updateSourcePanels;

  function getBatchRange() {
    var s = parseInt(shared.dom.delStart.value, 10);
    var e = parseInt(shared.dom.delEnd.value, 10);
    if (isNaN(s) || isNaN(e)) {
      alert(shared.fns.t('gifEditorAlertRangeInvalid'));
      return null;
    }
    if (s < 1 || e < 1) {
      alert(shared.fns.t('gifEditorAlertRangeMin'));
      return null;
    }
    if (s > e) {
      alert(shared.fns.t('gifEditorAlertRangeOrder'));
      return null;
    }
    return { start: s - 1, end: e - 1 };
  }
  shared.fns.getBatchRange = getBatchRange;

  function showConfirmModal(opts) {
    var overlay = document.getElementById('modal-overlay');
    if (!overlay) {
      if (opts && opts.onConfirm) opts.onConfirm();
      return;
    }
    opts = opts || {};
    var title = opts.title || shared.fns.t('confirmTitle', 'Confirm');
    var message = opts.message || '';
    var confirmText = opts.confirmText || shared.fns.t('gifEditorConfirmBtn', 'Confirm');
    var cancelText = opts.cancelText || shared.fns.t('cancel', 'Cancel');

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
  shared.fns.showConfirmModal = showConfirmModal;

  function deleteRange() {
    var range = getBatchRange();
    if (!range) return;
    showConfirmModal({
      title: shared.fns.t('gifEditorDeleteTitle', 'Delete Frames'),
      message: shared.fns.t('gifEditorConfirmDeleteRange', [String(range.start + 1), String(range.end + 1)], 'Delete frames ' + (range.start + 1) + ' - ' + (range.end + 1) + '?'),
      confirmText: shared.fns.t('gifEditorDeleteConfirmBtn', 'Delete'),
      cancelText: shared.fns.t('cancel', 'Cancel'),
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
        else if (slices.length > 0) { core.state.selectedSliceIdx = 0; shared.fns.draw(); }
        else { core.state.mode = 'source'; shared.fns.draw(); }
      }
    });
  }
  shared.fns.deleteRange = deleteRange;

  function keepRange() {
    var range = getBatchRange();
    if (!range) return;
    showConfirmModal({
      title: shared.fns.t('gifEditorKeepTitle', 'Keep Frames'),
      message: shared.fns.t('gifEditorConfirmKeepRange', [String(range.start + 1), String(range.end + 1)], 'Keep frames ' + (range.start + 1) + ' - ' + (range.end + 1) + '?'),
      confirmText: shared.fns.t('gifEditorKeepConfirmBtn', 'Keep'),
      cancelText: shared.fns.t('cancel', 'Cancel'),
      onConfirm: function () {
        var slices = core.state.slices || [];
        var newSlices = slices.slice(range.start, range.end + 1);
        if (!newSlices.length) {
          alert(shared.fns.t('gifEditorAlertRangeEmpty'));
          return;
        }
        core.state.slices = newSlices;
        core.state.selectedSliceIdx = 0;
        var panel = core.byId('batch-delete-panel');
        if (panel) panel.style.display = 'none';
        if (core.timeline) core.timeline.clearThumbCache();
        if (core.timeline && core.timeline.render) core.timeline.render();
        if (core.commands.focusFrame) core.commands.focusFrame(0);
        else { core.state.selectedSliceIdx = 0; shared.fns.draw(); }
      }
    });
  }

  // ------------------------------------------------------------------
  // Keyboard (capture-phase: Escape for pick-color)
  // ------------------------------------------------------------------
  shared.fns.keepRange = keepRange;
})();
