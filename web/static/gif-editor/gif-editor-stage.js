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

// Split: gif-editor-stage.js
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

  // Compose one slice (base shared.canvas + layers) into targetCanvas.
  // opts.applyTransparency: chroma-key the base before drawing layers.
  // opts.matte: fill the output background with this color first (GIF export
  shared.fns.drawLayers = drawLayers;

  function composeFrame(sliceIndex, targetCanvas, opts) {
    var slices = core.state.slices || [];
    var slice = slices[sliceIndex];
    if (!slice || !slice.canvas || !targetCanvas) return;

    var cc = document.createElement('canvas');
    cc.width = slice.canvas.width;
    cc.height = slice.canvas.height;
    var c = cc.getContext('2d');
    c.drawImage(slice.canvas, 0, 0);
    if (opts && opts.applyTransparency) {
      // true -> the committed snapshot; an object -> explicit params.
      var transParams = (opts.applyTransparency === true) ? shared.fns.committedTransParams() : opts.applyTransparency;
      shared.fns.applyTransparencyToCtx(c, cc.width, cc.height, transParams);
    }
    drawLayers(c, slice.layers);

    var tx = targetCanvas.getContext('2d');
    tx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    if (opts && opts.matte) {
      tx.fillStyle = opts.matte;
      tx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    }
    tx.drawImage(cc, 0, 0, targetCanvas.width, targetCanvas.height);
  }


  shared.fns.composeFrame = composeFrame;

  function getPointerPos(e) {
    var rect = shared.canvas.getBoundingClientRect();
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (shared.canvas.width / rect.width),
      y: (clientY - rect.top) * (shared.canvas.height / rect.height)
    };
  }
  shared.fns.getPointerPos = getPointerPos;

  function handlePointerDown(e) {
    if (e.target === shared.canvas) e.preventDefault();
    var coords = getPointerPos(e);

    if (core.state.floodPickMode) {
      shared.fns.addFloodSeed(coords.x, coords.y);
      return;
    }

    if (core.state.pickColorMode) {
      var px = shared.ctx.getImageData(Math.floor(coords.x), Math.floor(coords.y), 1, 1).data;
      var hex = '#' + [px[0], px[1], px[2]].map(function (x) {
        var s = x.toString(16);
        return s.length === 1 ? '0' + s : s;
      }).join('');
      shared.dom.keyColor.value = hex;
      core.state.transparencyReady = true;
      draw();
      core.state.pickColorMode = false;
      shared.dom.canvasWrapper.style.cursor = 'default';
      shared.dom.stageOverlayText.innerText = shared.fns.t('gifEditorPickColorDone') + hex;
      shared.dom.pickColorBtn.classList.remove('active');
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
          if (shared.dom.btnBold) shared.dom.btnBold.classList.toggle('active', !!hit.bold);
          if (shared.dom.btnItalic) shared.dom.btnItalic.classList.toggle('active', !!hit.italic);
          if (shared.dom.btnUnderline) shared.dom.btnUnderline.classList.toggle('active', !!hit.underline);
          if (shared.dom.addTextColor) shared.dom.addTextColor.value = hit.color || '#ffffff';
          if (shared.dom.strokeColor) shared.dom.strokeColor.value = hit.strokeColor || '#000000';
        }
        shared.layerBase = { size: hit.size, w: hit.w, h: hit.h };
        if (shared.dom.layerScale) shared.dom.layerScale.value = 1;
        startInteraction(e, 'move', hit);
        shared.fns.updateSelectionUI(core.state.selectedSliceIdx);
      } else {
        if (core.state.activeLayer) {
          core.state.activeLayer = null;
          shared.fns.updateSelectionUI(core.state.selectedSliceIdx);
          draw();
        }
        startPan(e);
      }
      return;
    }
    startPan(e);
  }
  shared.fns.handlePointerDown = handlePointerDown;

  function handleWheel(e) {
    if (!core.state.slices || !core.state.slices.length) return;
    e.preventDefault();
    var delta = e.deltaY < 0 ? 0.08 : -0.08;
    var newScale = Math.max(0.1, Math.min(3.0, core.state.scale * (1 + delta)));
    core.state.scale = newScale;
    updateTransform();
  }
  shared.fns.handleWheel = handleWheel;

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
  shared.fns.onPointerMove = onPointerMove;

  function onPointerUp() {
    core.state.isDraggingStage = false;
    core.state.interactionMode = null;
    if (shared.dom.canvasWrapper) shared.dom.canvasWrapper.style.cursor = 'default';
  }
  shared.fns.onPointerUp = onPointerUp;

  function startPan(e) {
    core.state.isDraggingStage = true;
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    core.state.startX = cx - core.state.panX;
    core.state.startY = cy - core.state.panY;
    if (shared.dom.canvasWrapper) shared.dom.canvasWrapper.style.cursor = 'grabbing';
  }
  shared.fns.startPan = startPan;

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
  shared.fns.startInteraction = startInteraction;

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
      shared.fns.syncCropSlidersFromRect();
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

    var applyAll = shared.dom.layerApplyAll ? shared.dom.layerApplyAll.checked : true;
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
  shared.fns.handleInteraction = handleInteraction;

  function drawGizmo(o, defaultColor, isCrop) {
    var x, y, w, h;
    if (o.type === 'text') {
      shared.ctx.font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + (o.size || 24) + 'px ' + (o.font || 'sans-serif');
      var m = shared.ctx.measureText(o.content || '');
      x = o.x || 0; y = o.y || 0; w = m.width; h = o.size || 24;
    } else {
      x = o.x || 0; y = o.y || 0; w = o.w || 0; h = o.h || 0;
    }
    shared.ctx.save();

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

    shared.ctx.strokeStyle = primaryColor;
    shared.ctx.lineWidth = 2;
    if (isCrop) {
      shared.ctx.strokeRect(x, y, w, h);
      shared.ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      shared.ctx.lineWidth = 1;
      shared.ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
    } else {
      shared.ctx.strokeRect(x, y, w, h);
    }

    shared.ctx.fillStyle = '#ffffff';
    shared.ctx.strokeStyle = primaryColor;
    shared.ctx.lineWidth = 2;
    var hs = isCrop ? 7 : 6;

    var dH = function (hx, hy) {
      shared.ctx.beginPath();
      var hx0 = hx - hs, hy0 = hy - hs, hs2 = hs * 2;
      if (typeof shared.ctx.roundRect === 'function') {
        shared.ctx.roundRect(hx0, hy0, hs2, hs2, 3);
      } else {
        shared.ctx.rect(hx0, hy0, hs2, hs2);
      }
      shared.ctx.fill();
      shared.ctx.stroke();
    };

    dH(x, y);
    dH(x + w, y);
    dH(x, y + h);
    dH(x + w, y + h);
    shared.ctx.restore();
  }

  shared.fns.drawGizmo = drawGizmo;

  function drawSeedMarker(x, y) {
    shared.ctx.save();
    shared.ctx.strokeStyle = '#ff0055';
    shared.ctx.lineWidth = 2;
    var r = 10;
    shared.ctx.beginPath();
    shared.ctx.moveTo(x - r, y);
    shared.ctx.lineTo(x + r, y);
    shared.ctx.moveTo(x, y - r);
    shared.ctx.lineTo(x, y + r);
    shared.ctx.stroke();
    shared.ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    shared.ctx.lineWidth = 1;
    shared.ctx.beginPath();
    shared.ctx.arc(x, y, r + 2, 0, Math.PI * 2);
    shared.ctx.stroke();
    shared.ctx.restore();
  }
  shared.fns.drawSeedMarker = drawSeedMarker;

  function checkLayerHit(x, y) {
    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;
    if (idx < 0 || idx >= slices.length) return null;
    var layers = slices[idx].layers || [];
    for (var i = layers.length - 1; i >= 0; i--) {
      var o = layers[i];
      var bx, by, bw, bh;
      if (o.type === 'text') {
        shared.ctx.font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + (o.size || 24) + 'px ' + (o.font || 'sans-serif');
        var m = shared.ctx.measureText(o.content || '');
        bx = o.x || 0; by = o.y || 0; bw = m.width; bh = o.size || 24;
      } else {
        bx = o.x || 0; by = o.y || 0; bw = o.w || 0; bh = o.h || 0;
      }
      if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) return o;
    }
    return null;
  }
  shared.fns.checkLayerHit = checkLayerHit;

  function checkHandleHit(mx, my, o) {
    var x, y, w, h;
    if (o.type === 'text') {
      shared.ctx.font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + (o.size || 24) + 'px ' + (o.font || 'sans-serif');
      var m = shared.ctx.measureText(o.content || '');
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
  shared.fns.checkHandleHit = checkHandleHit;

  function draw() {
    if (!shared.canvas || !shared.ctx) return;
    shared.ctx.imageSmoothingEnabled = false;
    if ('webkitImageSmoothingEnabled' in shared.ctx) shared.ctx.webkitImageSmoothingEnabled = false;
    if ('mozImageSmoothingEnabled' in shared.ctx) shared.ctx.mozImageSmoothingEnabled = false;
    if ('msImageSmoothingEnabled' in shared.ctx) shared.ctx.msImageSmoothingEnabled = false;

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

    if (shared.canvas.width !== origW) shared.canvas.width = origW;
    if (shared.canvas.height !== origH) shared.canvas.height = origH;
    shared.ctx.clearRect(0, 0, origW, origH);

    var isSplitOpen = shared.dom.splitSheetPanel && shared.dom.splitSheetPanel.style.display !== 'none' && core.state.source && core.state.source.kind === 'image';
    var splitScaleRatio = isSplitOpen ? ((parseInt(shared.dom.splitScale ? shared.dom.splitScale.value : 100, 10) || 100) / 100) : 1;

    // Source / Frame image draw with crisp pixel scaling if scale < 1.
    // Live preview while the trans panel is open; committed params once
    // applied (panel closed). Never touches the pristine slice shared.canvas.
    var sourceDrawImg = rawCanvas;
    var previewParams = shared.fns.previewTransParams();
    if (previewParams && slices[idx]) {
      var tempC = document.createElement('canvas');
      tempC.width = origW;
      tempC.height = origH;
      var tCtx = tempC.getContext('2d');
      tCtx.drawImage(rawCanvas, 0, 0);
      shared.fns.applyTransparencyToCtx(tCtx, origW, origH, previewParams);
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

      // Render back to full stage shared.canvas with sharp pixelated edges
      shared.ctx.drawImage(offCanvas, 0, 0, scaledW, scaledH, 0, 0, origW, origH);
    } else {
      shared.ctx.drawImage(sourceDrawImg, 0, 0, origW, origH);
    }

    if (slices[idx]) drawLayers(shared.ctx, slices[idx].layers);
    if (slices[idx] && core.state.trans && core.state.trans.mode === 'flood' &&
        core.state.transparencyReady &&
        (core.state.floodPickMode || (shared.dom.transPanel && shared.dom.transPanel.style.display === 'block'))) {
      var seeds = core.state.trans.seeds;
      for (var sIdx = 0; sIdx < seeds.length; sIdx++) {
        drawSeedMarker(seeds[sIdx].x, seeds[sIdx].y);
      }
    }
    if (shared.fns.isImageUnsliced()) drawEdgeCropGrid(origW, origH);
    if (core.state.source && core.state.source.kind === 'image') drawSplitGridOverlay(origW, origH);
    if (core.state.mode === 'editor' && core.state.activeLayer) drawGizmo(core.state.activeLayer, '#3b82f6');
    if (core.state.mode === 'crop') {
      shared.ctx.fillStyle = 'rgba(0,0,0,0.5)';
      shared.ctx.fillRect(0, 0, origW, origH);
      var cr = core.state.cropRect;
      shared.ctx.clearRect(cr.x, cr.y, cr.w, cr.h);
      if (slices[idx]) shared.ctx.drawImage(slices[idx].canvas, cr.x, cr.y, cr.w, cr.h, cr.x, cr.y, cr.w, cr.h);
      shared.ctx.save();
      shared.ctx.beginPath();
      shared.ctx.rect(cr.x, cr.y, cr.w, cr.h);
      shared.ctx.clip();
      if (slices[idx]) drawLayers(shared.ctx, slices[idx].layers);
      shared.ctx.restore();
      drawGizmo(core.state.cropRect, '#ef4444', true);
    }

    updateStageOverlay();
  }
  shared.fns.draw = draw;

  function drawSplitGridOverlay(w, h) {
    if (!shared.dom.splitSheetPanel || shared.dom.splitSheetPanel.style.display === 'none') return;
    if (!shared.dom.splitCols || !shared.dom.splitRows) return;
    var scale = (parseInt(shared.dom.splitScale ? shared.dom.splitScale.value : 100, 10) || 100) / 100;
    var realInnerGap = parseInt(shared.dom.splitInnerGap ? shared.dom.splitInnerGap.value : 0, 10) || 0;
    var realOuterMargin = (shared.dom.splitEnableOuter && shared.dom.splitEnableOuter.checked) ? (parseInt(shared.dom.splitOuterMargin ? shared.dom.splitOuterMargin.value : 0, 10) || 0) : 0;

    // Convert target shared.canvas pixel gap/margin to stage coordinate system
    var innerGap = realInnerGap / scale;
    var outerMargin = realOuterMargin / scale;
    var cols, rows, cellW, cellH;

    if (core.state.splitMode === 'uneven') {
      var realCellW = Math.max(1, parseInt(shared.dom.splitCols.value, 10) || 64);
      var realCellH = Math.max(1, parseInt(shared.dom.splitRows.value, 10) || 64);
      var scaledW = w * scale;
      var scaledH = h * scale;
      cols = Math.max(1, Math.floor((scaledW - realOuterMargin * 2 + realInnerGap) / (realCellW + realInnerGap)));
      rows = Math.max(1, Math.floor((scaledH - realOuterMargin * 2 + realInnerGap) / (realCellH + realInnerGap)));
      cellW = realCellW / scale;
      cellH = realCellH / scale;
    } else {
      cols = Math.max(1, parseInt(shared.dom.splitCols.value, 10) || 1);
      rows = Math.max(1, parseInt(shared.dom.splitRows.value, 10) || 1);
      var availW = Math.max(0, w - outerMargin * 2 - innerGap * (cols - 1));
      var availH = Math.max(0, h - outerMargin * 2 - innerGap * (rows - 1));
      cellW = availW / cols;
      cellH = availH / rows;
    }

    shared.ctx.save();
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = outerMargin + c * (cellW + innerGap);
        var y = outerMargin + r * (cellH + innerGap);

        shared.ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        shared.ctx.lineWidth = 3;
        shared.ctx.strokeRect(x, y, cellW, cellH);

        shared.ctx.strokeStyle = '#00ffaa';
        shared.ctx.lineWidth = 1.5;
        shared.ctx.strokeRect(x, y, cellW, cellH);

        shared.ctx.fillStyle = '#ffffff';
        shared.ctx.fillRect(x - 2, y - 2, 5, 5);
        shared.ctx.fillRect(x + cellW - 2, y - 2, 5, 5);
        shared.ctx.fillRect(x - 2, y + cellH - 2, 5, 5);
        shared.ctx.fillRect(x + cellW - 2, y + cellH - 2, 5, 5);
      }
    }
    shared.ctx.restore();
  }
  shared.fns.drawSplitGridOverlay = drawSplitGridOverlay;

  function updateStageOverlay() {
    if (!shared.dom.stageOverlayText) return;
    if (core.state.pickColorMode || core.state.floodPickMode) return;
    var slices = core.state.slices || [];
    var hasContent = (slices.length > 0) || !!core.state.processedImg;
    if (hasContent) {
      shared.dom.stageOverlayText.style.display = 'none';
    } else {
      shared.dom.stageOverlayText.style.display = 'block';
      shared.dom.stageOverlayText.textContent = shared.fns.t('gifEditorStageIdle', 'Waiting for upload...');
    }
  }

  // ------------------------------------------------------------------
  // Stage transform (fit on reset, zoom/pan around)
  // ------------------------------------------------------------------
  shared.fns.updateStageOverlay = updateStageOverlay;

  function getEffectiveDimensions() {
    if (shared.canvas && shared.canvas.width > 0 && shared.canvas.height > 0) {
      return { w: shared.canvas.width, h: shared.canvas.height };
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
  shared.fns.getEffectiveDimensions = getEffectiveDimensions;

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
    var cw = shared.dom.stage ? shared.dom.stage.clientWidth : 800;
    var ch = shared.dom.stage ? shared.dom.stage.clientHeight : 600;
    if (cw <= 0) cw = 800;
    if (ch <= 0) ch = 600;

    var fitScale = Math.min(cw / w, ch / h);
    core.state.scale = Math.max(0.05, fitScale);
    core.state.panX = (cw - w) / 2;
    core.state.panY = (ch - h) / 2;
    updateTransform();
  }
  shared.fns.resetView = resetView;

  function updateTransform() {
    if (shared.dom.canvasWrapper) {
      shared.dom.canvasWrapper.style.transform =
        'translate(' + core.state.panX + 'px, ' + core.state.panY + 'px) scale(' + core.state.scale + ')';
    }
    // Stage zoom is separate from the timeline zoom control: the timeline
    // module owns #gif-timeline-zoom-range/#gif-timeline-zoom-value and its
    // own timeline.zoom display, so nothing is written here.
  }

  // ------------------------------------------------------------------
  // Batch frame delete / keep + batch delay
  // ------------------------------------------------------------------
  shared.fns.updateTransform = updateTransform;

  function edgeCropValues(w, h) {
    var tVal = (shared.dom.cropT && parseInt(shared.dom.cropT.value, 10)) || 0,
        bVal = (shared.dom.cropB && parseInt(shared.dom.cropB.value, 10)) || 0,
        lVal = (shared.dom.cropL && parseInt(shared.dom.cropL.value, 10)) || 0,
        rVal = (shared.dom.cropR && parseInt(shared.dom.cropR.value, 10)) || 0;
    var maxT = Math.max(0, h - 1), maxL = Math.max(0, w - 1);
    tVal = Math.max(0, Math.min(maxT, tVal));
    bVal = Math.max(0, Math.min(maxT, bVal));
    lVal = Math.max(0, Math.min(maxL, lVal));
    rVal = Math.max(0, Math.min(maxL, rVal));
    return { t: tVal, b: bVal, l: lVal, r: rVal };
  }

  shared.fns.edgeCropValues = edgeCropValues;

  function drawEdgeCropGrid(w, h) {
    if (!shared.dom.cropT || !shared.dom.cropB || !shared.dom.cropL || !shared.dom.cropR) return;
    var c = edgeCropValues(w, h);
    shared.ctx.fillStyle = 'rgba(0,0,0,0.6)';
    shared.ctx.fillRect(0, 0, w, c.t);
    shared.ctx.fillRect(0, h - c.b, w, c.b);
    shared.ctx.fillRect(0, c.t, c.l, h - c.t - c.b);
    shared.ctx.fillRect(w - c.r, c.t, c.r, h - c.t - c.b);
    shared.ctx.strokeStyle = '#ff0055';
    shared.ctx.lineWidth = 2;
    shared.ctx.strokeRect(c.l, c.t, w - c.l - c.r, h - c.t - c.b);

    var rows = parseInt(shared.dom.rows.value, 10) || 1,
        cols = parseInt(shared.dom.cols.value, 10) || 1;
    var sw = (w - c.l - c.r) / cols, sh = (h - c.t - c.b) / rows;
    shared.ctx.strokeStyle = '#00ffaa';
    shared.ctx.lineWidth = 1;
    shared.ctx.beginPath();
    for (var i = 1; i < cols; i++) {
      shared.ctx.moveTo(c.l + i * sw, c.t);
      shared.ctx.lineTo(c.l + i * sw, h - c.b);
    }
    for (var j = 1; j < rows; j++) {
      shared.ctx.moveTo(c.l, c.t + j * sh);
      shared.ctx.lineTo(w - c.r, c.t + j * sh);
    }
    shared.ctx.stroke();
  }
  shared.fns.drawEdgeCropGrid = drawEdgeCropGrid;
})();
