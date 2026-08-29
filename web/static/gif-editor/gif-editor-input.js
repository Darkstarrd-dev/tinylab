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

// Split: gif-editor-input.js
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

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (core.state.floodPickMode) {
      e.stopPropagation();
      shared.fns.cancelFloodPick();
      return;
    }
    if (core.state.pickColorMode) {
      e.stopPropagation();
      shared.fns.cancelPickColor();
    }
  }

  // ------------------------------------------------------------------
  // Document drag / paste -> Import Modal
  // ------------------------------------------------------------------
  shared.fns.onKeyDown = onKeyDown;

  function onDragOver(e) {
    e.preventDefault();
    if (shared.dom.dropZone && e.target && e.target.closest && e.target.closest('#gif-drop-zone')) {
      shared.dom.dropZone.style.borderColor = 'var(--accent)';
    }
  }
  shared.fns.onDragOver = onDragOver;

  function onDragLeave(e) {
    if (shared.dom.dropZone && e.target && e.target.closest && e.target.closest('#gif-drop-zone')) {
      shared.dom.dropZone.style.borderColor = 'var(--glass-border)';
    }
  }
  shared.fns.onDragLeave = onDragLeave;

  function onDrop(e) {
    e.preventDefault();
    if (shared.dom.dropZone) shared.dom.dropZone.style.borderColor = 'var(--glass-border)';
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      core.import.openFromFile(e.dataTransfer.files[0]);
    }
  }
  shared.fns.onDrop = onDrop;

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
  shared.fns.onPaste = onPaste;

  function onWindowResize() {
    if (core.timeline && core.timeline.updateWindow) {
      core.timeline.updateWindow();
    }
  }

  // ------------------------------------------------------------------
  // Event Binding
  // ------------------------------------------------------------------
  shared.fns.onWindowResize = onWindowResize;

  function bindEvents() {
    // Import drag/drop/paste proxying to core.import.openFromFile
    if (shared.dom.dropZone) {
      shared.dom.dropZone.addEventListener('click', function () {
        if (shared.dom.fileInput) shared.dom.fileInput.click();
      });
    }
    if (shared.dom.fileInput) {
      shared.dom.fileInput.addEventListener('change', function (e) {
        if (e.target.files && e.target.files[0]) {
          core.import.openFromFile(e.target.files[0]);
          shared.dom.fileInput.value = '';
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
      slider.addEventListener('input', function () { num.value = slider.value; shared.fns.draw(); });
      num.addEventListener('change', function () {
        var val = parseInt(num.value, 10);
        if (isNaN(val)) val = 0;
        var max = parseInt(slider.max, 10);
        if (!isNaN(max)) val = Math.max(0, Math.min(max, val));
        slider.value = val;
        num.value = val;
        shared.fns.draw();
      });
    };
    edgeSync(shared.dom.sliderT, shared.dom.cropT);
    edgeSync(shared.dom.sliderB, shared.dom.cropB);
    edgeSync(shared.dom.sliderL, shared.dom.cropL);
    edgeSync(shared.dom.sliderR, shared.dom.cropR);
    if (shared.dom.rows) shared.dom.rows.addEventListener('input', shared.fns.draw);
    if (shared.dom.cols) shared.dom.cols.addEventListener('input', shared.fns.draw);
    if (shared.dom.sliceBtn) shared.dom.sliceBtn.addEventListener('click', shared.fns.runSlice);
    // Image tools panel toggle (edge crop + grid slice section)
    var imageToolsToggleBtn = core.byId('image-tools-toggle-btn');
    var imageToolsPanel = core.byId('image-tools-panel');
    if (imageToolsToggleBtn && imageToolsPanel) {
      imageToolsToggleBtn.addEventListener('click', function () {
        imageToolsPanel.style.display = imageToolsPanel.style.display === 'block' ? 'none' : 'block';
      });
    }

    // Quality sync (#gif-sample-interval slider + read-only #gif-quality-val span)
    if (shared.dom.quality) {
      shared.dom.quality.addEventListener('change', function () {
        var v = parseInt(shared.dom.quality.textContent, 10);
        if (isNaN(v)) v = 10;
        v = Math.max(1, Math.min(10, v));
        shared.dom.quality.textContent = v;
        shared.dom.qualitySlider.value = v;
      });
    }
    if (shared.dom.qualitySlider) {
      shared.dom.qualitySlider.addEventListener('input', function () {
        if (shared.dom.quality) shared.dom.quality.textContent = shared.dom.qualitySlider.value;
      });
    }

    // Output scale
    if (shared.dom.outScaleSlider) {
      shared.dom.outScaleSlider.addEventListener('input', function (e) {
        var s = parseFloat(e.target.value) / 100;
        if (isNaN(s)) s = 1;
        if (shared.dom.outScaleVal) shared.dom.outScaleVal.innerText = s.toFixed(1) + 'x';
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
          shared.dom.outW.value = Math.max(1, Math.round(baseW * s));
          shared.dom.outH.value = Math.max(1, Math.round(baseH * s));
        }
      });
    }

    // Apply scale percent (#gif-scale-percent + #gif-apply-scale-btn) -> output dims
    if (shared.dom.applyScaleBtn && shared.dom.scalePercent) {
      shared.dom.applyScaleBtn.addEventListener('click', function () {
        var p = parseInt(shared.dom.scalePercent.value, 10);
        if (isNaN(p)) p = 100;
        p = Math.max(10, Math.min(300, p));
        shared.dom.scalePercent.value = p;
        var s = p / 100;
        if (shared.dom.outScaleSlider) shared.dom.outScaleSlider.value = p;
        if (shared.dom.outScaleVal) shared.dom.outScaleVal.innerText = s.toFixed(1) + 'x';
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
          shared.dom.outW.value = Math.max(1, Math.round(baseW * s));
          shared.dom.outH.value = Math.max(1, Math.round(baseH * s));
        }
      });
    }

    // 1. Crop
    shared.dom.startGlobalCropBtn = core.byId('global-crop-btn');
    shared.dom.cropPanel = core.byId('crop-panel');
    shared.dom.cancelCropBtn = core.byId('cancel-crop-btn');
    shared.dom.applyCropBtn = core.byId('apply-crop-btn');
    if (shared.dom.startGlobalCropBtn) {
      shared.dom.startGlobalCropBtn.addEventListener('click', function () {
        if (shared.dom.cropPanel && shared.dom.cropPanel.style.display === 'block') {
          shared.fns.cancelCrop();
        } else {
          shared.fns.startGlobalCrop();
        }
      });
    }
    if (shared.dom.cancelCropBtn) shared.dom.cancelCropBtn.addEventListener('click', shared.fns.cancelCrop);
    if (shared.dom.applyCropBtn) shared.dom.applyCropBtn.addEventListener('click', shared.fns.applyCrop);
    shared.fns.setupCropSliders();

    // 2. Transparency (Set Transparency): live preview while the panel is
    // open; Apply freezes the committed snapshot; Cancel restores the
    // committed state (or defaults); Disable clears transparency fully.
    shared.dom.magicWandBtn = core.byId('magic-wand-btn');
    shared.dom.applyTransBtn = core.byId('apply-trans-btn');
    shared.dom.cancelTransBtn = core.byId('cancel-trans-btn');

    if (shared.dom.magicWandBtn) {
      shared.dom.magicWandBtn.addEventListener('click', function () {
        if (shared.dom.transPanel) {
          var isExpanded = shared.dom.transPanel.style.display === 'block';
          shared.dom.transPanel.style.display = isExpanded ? 'none' : 'block';
          if (!isExpanded) shared.fns.syncTransPanelUI();
          shared.fns.draw();
        }
      });
    }
    if (shared.dom.enableTrans) shared.dom.enableTrans.addEventListener('change', shared.fns.toggleTransPanel);
    if (shared.dom.keyColor) shared.dom.keyColor.addEventListener('input', shared.fns.transParamChanged);
    if (shared.dom.fuzziness) shared.dom.fuzziness.addEventListener('input', shared.fns.transParamChanged);
    if (shared.dom.transErode) shared.dom.transErode.addEventListener('input', shared.fns.transParamChanged);
    if (shared.dom.transErodeSmooth) shared.dom.transErodeSmooth.addEventListener('input', shared.fns.transParamChanged);
    if (shared.dom.pickColorBtn) shared.dom.pickColorBtn.addEventListener('click', shared.fns.pickColorClick);
    if (shared.dom.transModeColorBtn) shared.dom.transModeColorBtn.addEventListener('click', function () { shared.fns.setTransMode('color'); });
    if (shared.dom.transModeFloodBtn) shared.dom.transModeFloodBtn.addEventListener('click', function () { shared.fns.setTransMode('flood'); });
    if (shared.dom.floodPickBtn) shared.dom.floodPickBtn.addEventListener('click', shared.fns.toggleFloodPick);
    if (shared.dom.clearSeedsBtn) shared.dom.clearSeedsBtn.addEventListener('click', shared.fns.clearFloodSeeds);
    if (shared.dom.transCornerBtn) shared.dom.transCornerBtn.addEventListener('click', shared.fns.toggleCornerFlood);
    if (shared.dom.transC2a) shared.dom.transC2a.addEventListener('change', shared.fns.toggleSoftEdge);
    if (shared.dom.applyTransBtn) {
      shared.dom.applyTransBtn.addEventListener('click', function () {
        core.state.transparencyReady = true;
        core.state.trans.committed = shared.fns.liveTransParams();
        if (shared.dom.enableTrans) shared.dom.enableTrans.checked = true;
        if (shared.dom.transPanel) shared.dom.transPanel.style.display = 'none';
        if (core.timeline) core.timeline.clearThumbCache();
        if (core.timeline && core.timeline.render) core.timeline.render();
        shared.fns.draw();
      });
    }
    if (shared.dom.cancelTransBtn) {
      shared.dom.cancelTransBtn.addEventListener('click', function () {
        var committed = shared.fns.committedTransParams();
        if (committed) {
          // Discard the abandoned live tweaks; restore the committed state
          // so a reopened panel shows what is actually applied.
          if (shared.dom.keyColor) shared.dom.keyColor.value = committed.keyColor;
          if (shared.dom.fuzziness) shared.dom.fuzziness.value = String(committed.fuzziness);
          core.state.trans.mode = committed.mode;
          core.state.trans.seeds = (committed.seeds || []).slice();
          core.state.trans.corner = !!committed.corner;
          core.state.trans.c2a = !!committed.c2a;
          core.state.trans.erode = committed.erode || 0;
          core.state.trans.erodeSmooth = committed.erodeSmooth || 0;
          if (shared.dom.enableTrans) shared.dom.enableTrans.checked = true;
        } else {
          shared.fns.resetTransState();
        }
        if (shared.dom.transPanel) shared.dom.transPanel.style.display = 'none';
        shared.fns.syncTransPanelUI();
        shared.fns.draw();
      });
    }
    if (shared.dom.disableTransBtn) {
      shared.dom.disableTransBtn.addEventListener('click', function () {
        shared.fns.resetTransState();
        if (shared.dom.transPanel) shared.dom.transPanel.style.display = 'none';
        if (core.timeline) core.timeline.clearThumbCache();
        if (core.timeline && core.timeline.render) core.timeline.render();
        shared.fns.draw();
      });
    }

    // 4. Set Latency
    var delayToggleBtn = core.byId('delay-toggle-btn');
    var delayPanel = core.byId('delay-panel');
    var cancelDelayBtn = core.byId('cancel-delay-btn');
    var applyDelayBtn = shared.dom.batchDelayBtn || core.byId('batch-delay-btn');
    var delayInput = shared.dom.batchDelayInput || core.byId('batch-delay-input');

    if (delayToggleBtn) {
      delayToggleBtn.addEventListener('click', function () {
        if (delayPanel) {
          var isExp = delayPanel.style.display === 'block';
          delayPanel.style.display = isExp ? 'none' : 'block';
        }
      });
    }
    if (applyDelayBtn) {
      applyDelayBtn.addEventListener('click', function () {
        var slices = core.state.slices || [];
        if (!slices.length) {
          alert(shared.fns.t('gifEditorAlertNoFrames', '没有可设置的帧'));
          return;
        }
        var val = parseInt(delayInput ? delayInput.value : 100, 10);
        if (isNaN(val) || val < 0) val = 100;
        for (var i = 0; i < slices.length; i++) slices[i].delay = val;
        if (core.timeline && core.timeline.render) core.timeline.render();
        if (core.playback && core.playback.updateButtons) core.playback.updateButtons();
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
    if (shared.dom.stage) {
      shared.dom.stage.addEventListener('mousedown', shared.fns.handlePointerDown);
      shared.dom.stage.addEventListener('touchstart', shared.fns.handlePointerDown, { passive: false });
      shared.dom.stage.addEventListener('wheel', shared.fns.handleWheel, { passive: false });
    }
    window.addEventListener('mousemove', shared.fns.onPointerMove);
    window.addEventListener('touchmove', shared.fns.onPointerMove, { passive: false });
    window.addEventListener('mouseup', shared.fns.onPointerUp);
    window.addEventListener('touchend', shared.fns.onPointerUp);

    // Zoom
    if (shared.dom.zoomInBtn) shared.dom.zoomInBtn.addEventListener('click', function () { core.state.scale = Math.min(3, core.state.scale * 1.2); shared.fns.updateTransform(); });
    if (shared.dom.zoomOutBtn) shared.dom.zoomOutBtn.addEventListener('click', function () { core.state.scale = Math.max(0.2, core.state.scale * 0.8); shared.fns.updateTransform(); });
    if (shared.dom.resetViewBtn) shared.dom.resetViewBtn.addEventListener('click', shared.fns.resetView);


    // Layers
    if (shared.dom.addTextBtn) shared.dom.addTextBtn.addEventListener('click', shared.fns.addText);
    if (shared.dom.addImageInput) {
      shared.dom.addImageInput.addEventListener('change', function (e) {
        shared.fns.addImageFromFile(e.target.files[0]);
        e.target.value = '';
      });
    }
    if (shared.dom.btnBold) shared.dom.btnBold.addEventListener('click', function () { shared.fns.toggleStyle('bold', 'btnBold'); });
    if (shared.dom.btnItalic) shared.dom.btnItalic.addEventListener('click', function () { shared.fns.toggleStyle('italic', 'btnItalic'); });
    if (shared.dom.btnUnderline) shared.dom.btnUnderline.addEventListener('click', function () { shared.fns.toggleStyle('underline', 'btnUnderline'); });
    if (shared.dom.addTextColor) {
      shared.dom.addTextColor.addEventListener('input', function (e) {
        if (core.state.activeLayer && core.state.activeLayer.type === 'text') {
          core.state.activeLayer.color = e.target.value;
          shared.fns.draw();
        }
      });
    }
    if (shared.dom.strokeColor) {
      shared.dom.strokeColor.addEventListener('input', function (e) {
        if (core.state.activeLayer && core.state.activeLayer.type === 'text') {
          core.state.activeLayer.strokeColor = e.target.value;
          shared.fns.draw();
        }
      });
    }
    if (shared.dom.deleteLayerBtn) {
      shared.dom.deleteLayerBtn.addEventListener('click', function () {
        var slices = core.state.slices || [];
        var idx = core.state.selectedSliceIdx;
        if (!core.state.activeLayer || idx < 0 || idx >= slices.length) return;
        var layers = slices[idx].layers || [];
        for (var i = 0; i < layers.length; i++) {
          if (layers[i] === core.state.activeLayer) {
            shared.fns.removeLayer(i);
            return;
          }
        }
      });
    }
    if (shared.dom.layerScale) {
      shared.dom.layerScale.addEventListener('input', function (e) {
        var l = core.state.activeLayer;
        if (!l) return;
        var f = parseFloat(e.target.value);
        if (isNaN(f)) return;
        if (l.type === 'text') {
          l.size = Math.max(8, ((shared.layerBase && shared.layerBase.size) || l.size) * f);
        } else if (l.img) {
          l.w = ((shared.layerBase && shared.layerBase.w) || l.w) * f;
          l.h = ((shared.layerBase && shared.layerBase.h) || l.h) * f;
        }
        shared.fns.draw();
      });
    }
    if (shared.dom.layerList) shared.dom.layerList.addEventListener('click', shared.fns.onLayerListClick);
    var scopeRadios = document.querySelectorAll('input[name="gif-scope"]');
    for (var i = 0; i < scopeRadios.length; i++) {
      scopeRadios[i].addEventListener('change', function (e) {
        var ri = core.byId('crop-range-inputs');
        if (ri) ri.style.display = e.target.value === 'range' ? 'flex' : 'none';
      });
    }

    // Batch delete / keep
    if (shared.dom.btnDelRange) shared.dom.btnDelRange.addEventListener('click', shared.fns.deleteRange);
    if (shared.dom.btnKeepRange) shared.dom.btnKeepRange.addEventListener('click', shared.fns.keepRange);

    // 全局缩放：保持比例联动
    if (shared.dom.resizeKeepRatio && shared.dom.resizeWidth && shared.dom.resizeHeight) {
      shared.dom.resizeWidth.addEventListener('input', function () {
        if (!shared.dom.resizeKeepRatio.checked) return;
        var slices = core.state.slices || [];
        if (!slices.length || !slices[0].canvas) return;
        var origW = slices[0].canvas.width;
        var origH = slices[0].canvas.height;
        var w = parseInt(shared.dom.resizeWidth.value, 10);
        if (w > 0 && origW > 0) shared.dom.resizeHeight.value = Math.round(origH * w / origW);
      });
      shared.dom.resizeHeight.addEventListener('input', function () {
        if (!shared.dom.resizeKeepRatio.checked) return;
        var slices = core.state.slices || [];
        if (!slices.length || !slices[0].canvas) return;
        var origW = slices[0].canvas.width;
        var origH = slices[0].canvas.height;
        var h = parseInt(shared.dom.resizeHeight.value, 10);
        if (h > 0 && origH > 0) shared.dom.resizeWidth.value = Math.round(origW * h / origH);
      });
    }
    // 全局缩放：应用
    if (shared.dom.resizeApplyBtn) {
      shared.dom.resizeApplyBtn.addEventListener('click', function () {
        var slices = core.state.slices || [];
        if (!slices.length) { alert(shared.fns.t('gifEditorAlertNoFrames', '没有帧可操作')); return; }
        var keepRatio = shared.dom.resizeKeepRatio && shared.dom.resizeKeepRatio.checked;
        var targetW = parseInt(shared.dom.resizeWidth.value, 10);
        var targetH = parseInt(shared.dom.resizeHeight.value, 10);
        var origW = slices[0].canvas.width;
        var origH = slices[0].canvas.height;
        if (keepRatio) {
          if (targetW && !targetH) targetH = Math.round(origH * targetW / origW);
          else if (targetH && !targetW) targetW = Math.round(origW * targetH / origH);
          else if (!targetW && !targetH) { alert(shared.fns.t('gifEditorAlertResizeEmpty', '请输入宽度或高度')); return; }
        } else {
          if (!targetW) targetW = origW;
          if (!targetH) targetH = origH;
        }
        targetW = Math.max(1, targetW);
        targetH = Math.max(1, targetH);
        shared.fns.showConfirmModal({
          title: shared.fns.t('gifEditorResizeTitle', '全局缩放'),
          message: shared.fns.t('gifEditorResizeConfirm', [String(origW), String(origH), String(targetW), String(targetH)], '将所有帧从 ' + origW + '×' + origH + ' 缩放到 ' + targetW + '×' + targetH + '？此操作不可撤销。'),
          confirmText: shared.fns.t('gifEditorResizeBtn', '确认缩放'),
          cancelText: shared.fns.t('cancel', '取消'),
          onConfirm: function () {
            // Resize replaces the pristine canvases: bake the committed
            // removal in first (seeds would not map onto the new size).
            shared.fns.materializeTransparency();
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
            shared.fns.draw();
            shared.fns.resetView();
          }
        });
      });
    }

    // 间隔删除
    if (shared.dom.intervalDeleteBtn) {
      shared.dom.intervalDeleteBtn.addEventListener('click', function () {
        var slices = core.state.slices || [];
        if (!slices.length) { alert(shared.fns.t('gifEditorAlertNoFrames', '没有帧可操作')); return; }
        var interval = parseInt(shared.dom.intervalDeleteVal.value, 10);
        if (isNaN(interval) || interval < 1) { alert(shared.fns.t('gifEditorAlertIntervalInvalid', '请输入有效的间隔值（≥1）')); return; }
        // 计算删除前总时长
        var totalDuration = 0;
        for (var i = 0; i < slices.length; i++) totalDuration += (slices[i].delay || 100);
        // 执行间隔删除：每隔 interval 帧删除 1 帧
        var kept = [];
        for (var i = 0; i < slices.length; i++) {
          if ((i + 1) % (interval + 1) !== 0) kept.push(slices[i]);
        }
        if (!kept.length) { alert(shared.fns.t('gifEditorAlertAllDeleted', '所有帧都会被删除，操作取消')); return; }
        var deletedCount = slices.length - kept.length;
        shared.fns.showConfirmModal({
          title: shared.fns.t('gifEditorIntervalDeleteTitle', '间隔删除'),
          message: shared.fns.t('gifEditorIntervalDeleteConfirm', [String(interval), String(deletedCount), String(slices.length), String(kept.length)], '将每隔 ' + interval + ' 帧删除 1 帧，共删除 ' + deletedCount + ' 帧（' + slices.length + ' → ' + kept.length + '），自动调整延迟保持总时长。'),
          confirmText: shared.fns.t('gifEditorDeleteConfirmBtn', '确认删除'),
          cancelText: shared.fns.t('cancel', '取消'),
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
            else shared.fns.draw();
          }
        });
      });
    }

    // 右键复制当前帧到剪贴板
    if (shared.dom.stage) {
      shared.dom.stage.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var slices = core.state.slices || [];
        var idx = core.state.selectedSliceIdx;
        if (idx < 0 || idx >= slices.length || !slices[idx].canvas) return;
        var src = slices[idx].canvas;
        // 创建临时 shared.canvas 用于合成（含图层）
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
              if (shared.dom.stageOverlayText) {
                var origText = shared.dom.stageOverlayText.textContent;
                shared.dom.stageOverlayText.textContent = '✅ ' + shared.fns.t('gifEditorCopiedToClipboard', '已复制到剪贴板');
                setTimeout(function () {
                  shared.dom.stageOverlayText.textContent = origText;
                }, 1500);
              }
            }).catch(function (err) {
              console.error('Copy to clipboard failed:', err);
              alert(shared.fns.t('gifEditorCopyFailed', '复制失败，请检查浏览器权限'));
            });
          } catch (err) {
            console.error('Clipboard API not available:', err);
            alert(shared.fns.t('gifEditorCopyFailed', '复制失败，浏览器不支持剪贴板 API'));
          }
        }, 'image/png');
      });
    }

    // Reload (reset workspace in place)
    if (shared.dom.reloadBtn) {
      shared.dom.reloadBtn.addEventListener('click', function () {
        shared.fns.showConfirmModal({
          title: shared.fns.t('gifEditorResetTitle', 'Reset Workspace'),
          message: shared.fns.t('gifEditorConfirmReset', 'Are you sure you want to reset the workspace? All unexported edits will be cleared.'),
          confirmText: shared.fns.t('gifEditorResetConfirmBtn', 'Reset'),
          cancelText: shared.fns.t('cancel', 'Cancel'),
          onConfirm: function () {
            core.resetSlices();
            core.releaseSource();
            shared.fns.updateSelectionUI(-1);
            if (core.timeline && core.timeline.render) core.timeline.render();
            shared.fns.updateSourcePanels(null, { resetTrans: true });
            core.hideSpinner();
            shared.fns.draw();
            shared.fns.resetView();
          }
        });
      });
    }

    if (shared.dom.openExportBtn) {
      shared.dom.openExportBtn.addEventListener('click', function () {
        if (core.export && core.export.openExportModal) core.export.openExportModal();
      });
    }

    function updateSplitSummary() {
      if (!shared.dom.splitCols || !shared.dom.splitRows) return;
      var scale = (parseInt(shared.dom.splitScale ? shared.dom.splitScale.value : 100, 10) || 100) / 100;
      var srcCanvas = core.state.processedImg ||
        ((core.state.slices && core.state.slices[0] && core.state.slices[0].canvas) || null) ||
        (core.state.source && (core.state.source.rawImage || core.state.source.image));
      var origW = srcCanvas ? (srcCanvas.width || srcCanvas.naturalWidth || 800) : 800;
      var origH = srcCanvas ? (srcCanvas.height || srcCanvas.naturalHeight || 600) : 600;
      var scaledW = Math.max(1, Math.round(origW * scale));
      var scaledH = Math.max(1, Math.round(origH * scale));

      var totalFrames;
      if (core.state.splitMode === 'uneven') {
        var cellW = Math.max(1, parseInt(shared.dom.splitCols.value, 10) || 64);
        var cellH = Math.max(1, parseInt(shared.dom.splitRows.value, 10) || 64);
        var innerGap = Math.max(0, parseInt(shared.dom.splitInnerGap ? shared.dom.splitInnerGap.value : 0, 10) || 0);
        var outerMargin = (shared.dom.splitEnableOuter && shared.dom.splitEnableOuter.checked) ? Math.max(0, parseInt(shared.dom.splitOuterMargin ? shared.dom.splitOuterMargin.value : 0, 10) || 0) : 0;
        var cols = Math.max(1, Math.floor((scaledW - outerMargin * 2 + innerGap) / (cellW + innerGap)));
        var rows = Math.max(1, Math.floor((scaledH - outerMargin * 2 + innerGap) / (cellH + innerGap)));
        totalFrames = cols * rows;
      } else {
        var cols = Math.max(1, parseInt(shared.dom.splitCols.value, 10) || 1);
        var rows = Math.max(1, parseInt(shared.dom.splitRows.value, 10) || 1);
        totalFrames = cols * rows;
      }

      if (shared.dom.splitActualFrames) shared.dom.splitActualFrames.textContent = totalFrames;
      if (shared.dom.splitScaleDisplay) shared.dom.splitScaleDisplay.textContent = Math.round(scale * 100) + '%';

      if (srcCanvas && shared.dom.splitSourceRes) {
        var origText = origW + ' × ' + origH;
        if (scale !== 1) {
          shared.dom.splitSourceRes.textContent = origText + ' -> ' + scaledW + ' × ' + scaledH;
        } else {
          shared.dom.splitSourceRes.textContent = origText;
        }
      }
    }

    if (shared.dom.splitSheetToggleBtn && shared.dom.splitSheetPanel) {
      shared.dom.splitSheetToggleBtn.addEventListener('click', function () {
        var isHidden = shared.dom.splitSheetPanel.style.display === 'none' || !shared.dom.splitSheetPanel.style.display;
        shared.dom.splitSheetPanel.style.display = isHidden ? 'block' : 'none';
        updateSplitSummary();
        shared.fns.draw();
      });
    }

    var updateSplitLabels = function (mode) {
      if (shared.dom.splitColsLabel) shared.dom.splitColsLabel.textContent = shared.fns.t(mode === 'uneven' ? 'gifEditorCellWidth' : 'gifEditorSplitX', mode === 'uneven' ? 'Cell Width (px):' : 'X (Horizontal Split):');
      if (shared.dom.splitRowsLabel) shared.dom.splitRowsLabel.textContent = shared.fns.t(mode === 'uneven' ? 'gifEditorCellHeight' : 'gifEditorSplitY', mode === 'uneven' ? 'Cell Height (px):' : 'Y (Vertical Split):');
      if (shared.dom.splitCols) shared.dom.splitCols.max = mode === 'uneven' ? '9999' : '100';
      if (shared.dom.splitRows) shared.dom.splitRows.max = mode === 'uneven' ? '9999' : '100';
    };

    if (shared.dom.splitModeToggle) {
      shared.dom.splitModeToggle.addEventListener('click', function (e) {
        var btn = e.target.closest('.gif-split-mode-btn');
        if (!btn) return;
        var mode = btn.dataset.mode;
        var btns = shared.dom.splitModeToggle.querySelectorAll('.gif-split-mode-btn');
        for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i] === btn);
        core.state.splitMode = mode;
        updateSplitLabels(mode);
        if (mode === 'uneven') {
          if (shared.dom.splitCols && parseInt(shared.dom.splitCols.value, 10) < 10) shared.dom.splitCols.value = 64;
          if (shared.dom.splitRows && parseInt(shared.dom.splitRows.value, 10) < 10) shared.dom.splitRows.value = 64;
        } else {
          if (shared.dom.splitCols && parseInt(shared.dom.splitCols.value, 10) > 100) shared.dom.splitCols.value = 3;
          if (shared.dom.splitRows && parseInt(shared.dom.splitRows.value, 10) > 100) shared.dom.splitRows.value = 3;
        }
        onSplitUIChange();
      });
    }

    var onSplitUIChange = function () {
      updateSplitSummary();
      shared.fns.draw();
    };

    if (shared.dom.splitScale) shared.dom.splitScale.addEventListener('input', onSplitUIChange);
    if (shared.dom.splitCols) { shared.dom.splitCols.addEventListener('input', onSplitUIChange); shared.dom.splitCols.addEventListener('change', onSplitUIChange); }
    if (shared.dom.splitRows) { shared.dom.splitRows.addEventListener('input', onSplitUIChange); shared.dom.splitRows.addEventListener('change', onSplitUIChange); }
    if (shared.dom.splitInnerGap) { shared.dom.splitInnerGap.addEventListener('input', onSplitUIChange); shared.dom.splitInnerGap.addEventListener('change', onSplitUIChange); }
    if (shared.dom.splitOuterMargin) { shared.dom.splitOuterMargin.addEventListener('input', onSplitUIChange); shared.dom.splitOuterMargin.addEventListener('change', onSplitUIChange); }
    if (shared.dom.splitEnableOuter) shared.dom.splitEnableOuter.addEventListener('change', onSplitUIChange);

    if (shared.dom.splitApplyBtn) {
      shared.dom.splitApplyBtn.addEventListener('click', function () {
        // The split cells replace the source canvas: bake the committed
        // removal into the source first (seeds are dropped).
        shared.fns.materializeTransparency();
        if (!core.import || !core.import.splitImage) return;
        var opts = {
          mode: core.state.splitMode || 'even',
          cols: parseInt(shared.dom.splitCols ? shared.dom.splitCols.value : 3, 10) || 1,
          rows: parseInt(shared.dom.splitRows ? shared.dom.splitRows.value : 3, 10) || 1,
          innerGap: parseInt(shared.dom.splitInnerGap ? shared.dom.splitInnerGap.value : 0, 10) || 0,
          outerMargin: parseInt(shared.dom.splitOuterMargin ? shared.dom.splitOuterMargin.value : 0, 10) || 0,
          enableOuterGap: shared.dom.splitEnableOuter ? !!shared.dom.splitEnableOuter.checked : false,
          scalePercent: parseInt(shared.dom.splitScale ? shared.dom.splitScale.value : 100, 10) || 100
        };
        core.import.splitImage(opts).then(function () {
          if (shared.dom.splitSheetPanel) shared.dom.splitSheetPanel.style.display = 'none';
          shared.fns.draw();
        }).catch(function (err) {
          console.error('Split sheet failed:', err);
        });
      });
    }

    // Sub-module event binders (state first: window-level key blocking)
    if (core.bindStateEvents) core.bindStateEvents();
    if (core.import) core.import.bindEvents();
    if (core.timeline) core.timeline.bindEvents();
    if (core.playback) core.playback.bindEvents();
    if (core.export) core.export.bindEvents();

    shared.fns.updateSelectionUI(core.state.selectedSliceIdx);
    shared.fns.updateExportEnabled();
  }

  // ------------------------------------------------------------------
  // HTML Template (restored full sidebar: import, transparency, image
  // tools, crop/layers, output/export controls; stage + timeline toolbar)
  // ------------------------------------------------------------------
  shared.fns.bindEvents = bindEvents;
})();
