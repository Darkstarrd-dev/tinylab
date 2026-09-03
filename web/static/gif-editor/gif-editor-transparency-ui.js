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

// Split: gif-editor-transparency-ui.js
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

  function defaultTransParams() {
    return { mode: 'color', keyColor: '#ffffff', fuzziness: 15, seeds: [], corner: false, c2a: false, erode: 0, erodeSmooth: 0 };
  }

  // Live params straight from the panel DOM (session state).
  shared.fns.defaultTransParams = defaultTransParams;

  function liveTransParams() {
    var tr = core.state.trans;
    var keyColor = (shared.dom.keyColor && shared.dom.keyColor.value) || tr.keyColor;
    var fuzz = shared.dom.fuzziness ? parseFloat(shared.dom.fuzziness.value) : tr.fuzziness;
    if (isNaN(fuzz)) fuzz = tr.fuzziness;
    var erode = shared.dom.transErode ? parseFloat(shared.dom.transErode.value) : tr.erode;
    if (isNaN(erode)) erode = tr.erode;
    var erodeSmooth = shared.dom.transErodeSmooth ? parseFloat(shared.dom.transErodeSmooth.value) : tr.erodeSmooth;
    if (isNaN(erodeSmooth)) erodeSmooth = tr.erodeSmooth;
    return {
      mode: tr.mode,
      keyColor: keyColor,
      fuzziness: fuzz,
      seeds: (tr.seeds || []).slice(),
      corner: !!tr.corner,
      c2a: !!tr.c2a,
      erode: erode,
      erodeSmooth: erodeSmooth
    };
  }

  // The frozen snapshot created by Apply; null when transparency is not
  shared.fns.liveTransParams = liveTransParams;

  function committedTransParams() {
    var tr = core.state.trans;
    return tr && tr.committed ? tr.committed : null;
  }

  // Stage preview params: live while the panel is open (immediate feedback
  shared.fns.committedTransParams = committedTransParams;

  function previewTransParams() {
    if (!core.state.transparencyReady) return null;
    if (shared.dom.transPanel && shared.dom.transPanel.style.display === 'block') return liveTransParams();
    if (shared.dom.enableTrans && shared.dom.enableTrans.checked) return committedTransParams();
    return null;
  }
  shared.fns.previewTransParams = previewTransParams;

  function applyTransparencyToCtx(targetCtx, width, height, params) {
    if (!params || !window.GifEditorTransparency) return;
    var d = targetCtx.getImageData(0, 0, width, height);
    window.GifEditorTransparency.applyPipeline(d, params);
    targetCtx.putImageData(d, 0, 0);
  }

  // True when the committed snapshot represents an active removal (gates
  shared.fns.applyTransparencyToCtx = applyTransparencyToCtx;

  function isTransCommitted() {
    var c = committedTransParams();
    return !!(c && window.GifEditorTransparency &&
      window.GifEditorTransparency.hasActiveRemoval(c));
  }

  // Bake the committed removal into every slice shared.canvas + the image source
  // shared.canvas, then clear the committed state. Called by crop / resize /
  // grid slice / split sheet whose output canvases would otherwise lose
  // the (never-baked) transparency. Flood seeds are dropped: their
  shared.fns.isTransCommitted = isTransCommitted;

  function materializeTransparency() {
    if (!isTransCommitted()) return;
    var params = committedTransParams();
    var slices = core.state.slices || [];
    for (var i = 0; i < slices.length; i++) {
      var src = slices[i].canvas;
      if (!src) continue;
      var c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      var cctx = c.getContext('2d');
      cctx.drawImage(src, 0, 0);
      applyTransparencyToCtx(cctx, c.width, c.height, params);
      slices[i].canvas = c;
    }
    if (core.state.processedImg && core.state.source && core.state.source.kind === 'image') {
      var p = document.createElement('canvas');
      p.width = core.state.processedImg.width;
      p.height = core.state.processedImg.height;
      var pctx = p.getContext('2d');
      pctx.drawImage(core.state.processedImg, 0, 0);
      applyTransparencyToCtx(pctx, p.width, p.height, params);
      core.state.processedImg = p;
    }
    resetTransState();
    if (core.timeline) core.timeline.clearThumbCache();
    if (core.timeline && core.timeline.render) core.timeline.render();
  }

  shared.fns.materializeTransparency = materializeTransparency;

  function resetTransState() {
    var tr = core.state.trans;
    tr.mode = 'color';
    tr.keyColor = '#ffffff';
    tr.fuzziness = 15;
    tr.seeds = [];
    tr.corner = false;
    tr.c2a = false;
    tr.erode = 0;
    tr.erodeSmooth = 0;
    tr.committed = null;
    core.state.transparencyReady = false;
    core.state.pickColorMode = false;
    core.state.floodPickMode = false;
    if (shared.dom.enableTrans) shared.dom.enableTrans.checked = false;
    if (shared.dom.canvasWrapper) shared.dom.canvasWrapper.style.cursor = 'default';
    syncTransPanelUI();
  }

  // Reflect state -> panel DOM (mode buttons, section visibility, seed
  shared.fns.resetTransState = resetTransState;

  function syncTransPanelUI() {
    var tr = core.state.trans;
    if (shared.dom.transModeColorBtn) shared.dom.transModeColorBtn.classList.toggle('active', tr.mode === 'color');
    if (shared.dom.transModeFloodBtn) shared.dom.transModeFloodBtn.classList.toggle('active', tr.mode === 'flood');
    if (shared.dom.transColorControls) shared.dom.transColorControls.style.display = tr.mode === 'color' ? 'block' : 'none';
    if (shared.dom.transFloodControls) shared.dom.transFloodControls.style.display = tr.mode === 'flood' ? 'block' : 'none';
    if (shared.dom.keyColor) shared.dom.keyColor.value = tr.keyColor;
    if (shared.dom.fuzziness) shared.dom.fuzziness.value = String(tr.fuzziness);
    if (shared.dom.transErode) shared.dom.transErode.value = String(tr.erode || 0);
    if (shared.dom.transErodeSmooth) shared.dom.transErodeSmooth.value = String(tr.erodeSmooth || 0);
    if (shared.dom.transC2a) shared.dom.transC2a.checked = !!tr.c2a;
    if (shared.dom.transCornerBtn) shared.dom.transCornerBtn.classList.toggle('active', !!tr.corner);
    if (shared.dom.seedCountLabel) {
      shared.dom.seedCountLabel.textContent = shared.fns.t('gifEditorSeedCount', [String(tr.seeds.length)], tr.seeds.length + ' seeds');
    }
  }
  shared.fns.syncTransPanelUI = syncTransPanelUI;

  function toggleTransPanel() {
    // Opening/closing switches the preview between live and committed
    // params — just re-shared.fns.render.
    shared.fns.draw();
  }
  shared.fns.toggleTransPanel = toggleTransPanel;

  function transParamChanged() {
    // erode sliders are state-backed (DOM -> state on every input) so the
    // panel round-trips committed values on reopen.
    var trc = core.state.trans;
    if (shared.dom.transErode) { var e = parseFloat(shared.dom.transErode.value); if (!isNaN(e)) trc.erode = e; }
    if (shared.dom.transErodeSmooth) { var es = parseFloat(shared.dom.transErodeSmooth.value); if (!isNaN(es)) trc.erodeSmooth = es; }
    core.state.transparencyReady = true;
    shared.fns.draw();
  }
  shared.fns.transParamChanged = transParamChanged;

  function setTransMode(mode) {
    core.state.trans.mode = (mode === 'flood') ? 'flood' : 'color';
    core.state.transparencyReady = true;
    syncTransPanelUI();
    shared.fns.draw();
  }

  // Flood seed: bounds-checked against the current frame shared.canvas; duplicate
  shared.fns.setTransMode = setTransMode;

  function addFloodSeed(x, y) {
    var slices = core.state.slices || [];
    var idx = core.state.selectedSliceIdx;
    var dims = null;
    if (idx >= 0 && slices[idx] && slices[idx].canvas) {
      dims = { w: slices[idx].canvas.width, h: slices[idx].canvas.height };
    } else if (core.state.processedImg) {
      dims = { w: core.state.processedImg.width, h: core.state.processedImg.height };
    }
    x = Math.floor(x);
    y = Math.floor(y);
    if (!dims || x < 0 || x >= dims.w || y < 0 || y >= dims.h) return;
    var tr = core.state.trans;
    for (var i = 0; i < tr.seeds.length; i++) {
      if (tr.seeds[i].x === x && tr.seeds[i].y === y) return;
    }
    tr.seeds.push({ x: x, y: y });
    core.state.transparencyReady = true;
    syncTransPanelUI();
    shared.fns.draw();
  }
  shared.fns.addFloodSeed = addFloodSeed;

  function clearFloodSeeds() {
    core.state.trans.seeds = [];
    core.state.trans.corner = false;
    syncTransPanelUI();
    shared.fns.draw();
  }
  shared.fns.clearFloodSeeds = clearFloodSeeds;

  function toggleCornerFlood() {
    core.state.trans.corner = !core.state.trans.corner;
    core.state.transparencyReady = true;
    syncTransPanelUI();
    shared.fns.draw();
  }
  shared.fns.toggleCornerFlood = toggleCornerFlood;

  function toggleSoftEdge() {
    core.state.trans.c2a = !!(shared.dom.transC2a && shared.dom.transC2a.checked);
    core.state.transparencyReady = true;
    shared.fns.draw();
  }
  shared.fns.toggleSoftEdge = toggleSoftEdge;

  function pickColorClick() {
    if (window.EyeDropper) {
      try {
        var ed = new EyeDropper();
        ed.open().then(function (result) {
          shared.dom.keyColor.value = result.sRGBHex;
          core.state.transparencyReady = true;
          shared.fns.draw();
        }).catch(function () { /* user cancelled */ });
      } catch (e) { /* fall through to manual mode */ }
    } else {
      core.state.pickColorMode = !core.state.pickColorMode;
      core.state.floodPickMode = false;
      if (core.state.pickColorMode) {
        shared.dom.canvasWrapper.style.cursor = 'crosshair';
        shared.dom.stageOverlayText.innerText = shared.fns.t('gifEditorPickColorHintStage');
        shared.dom.pickColorBtn.classList.add('active');
        if (shared.dom.floodPickBtn) shared.dom.floodPickBtn.classList.remove('active');
      } else {
        shared.dom.canvasWrapper.style.cursor = 'default';
        shared.dom.stageOverlayText.innerText = shared.fns.t('gifEditorPickColorCancelled');
        shared.dom.pickColorBtn.classList.remove('active');
      }
    }
  }
  shared.fns.pickColorClick = pickColorClick;

  function cancelPickColor() {
    core.state.pickColorMode = false;
    shared.dom.canvasWrapper.style.cursor = 'default';
    shared.dom.stageOverlayText.innerText = shared.fns.t('gifEditorPickColorCancelled');
    shared.dom.pickColorBtn.classList.remove('active');
  }
  shared.fns.cancelPickColor = cancelPickColor;

  function toggleFloodPick() {
    core.state.floodPickMode = !core.state.floodPickMode;
    core.state.pickColorMode = false;
    if (shared.dom.pickColorBtn) shared.dom.pickColorBtn.classList.remove('active');
    if (core.state.floodPickMode) {
      shared.dom.canvasWrapper.style.cursor = 'crosshair';
      shared.dom.stageOverlayText.innerText = shared.fns.t('gifEditorFloodPickHintStage');
      if (shared.dom.floodPickBtn) shared.dom.floodPickBtn.classList.add('active');
    } else {
      shared.dom.canvasWrapper.style.cursor = 'default';
      shared.dom.stageOverlayText.innerText = shared.fns.t('gifEditorFloodPickCancelled');
      if (shared.dom.floodPickBtn) shared.dom.floodPickBtn.classList.remove('active');
    }
  }
  shared.fns.toggleFloodPick = toggleFloodPick;

  function cancelFloodPick() {
    core.state.floodPickMode = false;
    shared.dom.canvasWrapper.style.cursor = 'default';
    shared.dom.stageOverlayText.innerText = shared.fns.t('gifEditorFloodPickCancelled');
    if (shared.dom.floodPickBtn) shared.dom.floodPickBtn.classList.remove('active');
  }

  // ------------------------------------------------------------------
  // Edge crop + grid slice (image source)
  // ------------------------------------------------------------------
  shared.fns.cancelFloodPick = cancelFloodPick;
})();
