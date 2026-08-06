// web/static/gif-editor.js
// GIF / frame editor page for TinyRouter (header nav 6th button, data-page="gif").
// Ported 1:1 from the "喵喵切切乐 Pro Max" single-page app
// (C:/Users/Houpy/Desktop/Zed/# OnePageApps/Pages/07_gif_slicer.html), with the
// five documented source fixes plus the memory/scale fixes:
//   #1 draw() layer branch used undefined `cx` (now `ctx`).
//   #2 GIF decode now uses the vendored gifuct-js bundle (parseGIF +
//      decompressFrames with buildPatches=true) with correct disposal 1/2/3
//      handling (source omggif section had an empty disposal=2 branch and no
//      disposal=3 support).
//   #3 Grid slice sw/sh are rounded (Math.round) so canvas dimensions are ints.
//   #4 Layer sync matches by shared `groupId` (created together) instead of by
//      text content / image object identity (duplicate text over-synced).
//   #5 The three export paths share one compositor (composeFrame) instead of
//      three duplicated layer-drawing blocks.
  //   + GIF/video file size gate <= 200 MB; the export peak-memory estimate
  //     is a confirmable warning, not an input cap (no pixel-frame budget).
  //   + Timeline is virtualized: windowed DOM + delegated interactions + small
  //     lazily generated thumbnails (bounded cache) for large frame counts.
// Vendors: gif.js (encoder, same-origin worker) + gifuct-js (decoder) under
// web/static/vendor/. No external CDN. All DOM ids/classes are gif- prefixed.

var GifEditor = (function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants (file-size gate + export memory warning; timeline geometry)
  // ------------------------------------------------------------------
  var MAX_FILE_BYTES = 200 * 1024 * 1024;     // GIF / video single-file cap
  var EXPORT_MEM_LIMIT = 1.5 * 1024 * 1024 * 1024; // export peak estimate warning threshold
  var GIF_VENDOR_URL = '/vendor/gif.js/gif.js';
  var GIF_WORKER_URL = '/vendor/gif.js/gif.worker.js';
  var MATTE_HEX = '#FF00FF';
  var MATTE_NUM = 0xFF00FF;

  // ------------------------------------------------------------------
  // Module state (no globals leak out of this IIFE)
  // ------------------------------------------------------------------
  var state = {
    srcImg: null,
    srcVideo: null,
    processedImg: null,
    slices: [],                       // {id, canvas, delay, layers[]}
    scale: 1,
    panX: 0,
    panY: 0,
    isDraggingStage: false,
    startX: 0,
    startY: 0,
    mode: 'source',                   // source | video_preview | editor | crop
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
    touchStartIndex: null
  };

  var dom = {};        // cached element refs (gif- prefix stripped)
  var canvas = null;   // preview canvas element
  var ctx = null;      // preview 2d context
  var videoUrl = null;
  var resultUrl = null;
  var rendered = false;
  // Virtualized timeline state (window + bounded thumbnail cache).
  var timelineWin = null;   // last rendered window {start, end}
  var thumbCache = {};      // slice.id -> small thumbnail data URL
  var thumbKeys = [];       // FIFO order of thumbCache entries
  var thumbRaf = null;      // pending rAF for timeline window updates

  function byId(name) { return document.getElementById('gif-' + name); }
  function freshId() { return Date.now() + Math.random(); }

  // ------------------------------------------------------------------
  // Entry points (also exposed as renderGifEditor / cleanupGifEditor)
  // ------------------------------------------------------------------
  function render(container) {
    // Re-render safety: a previous visit may not have been cleaned up
    // (e.g. clicking the GIF nav button while already on the page).
    teardown();
    if (!container) container = document.getElementById('page-content');
    container.style.height = '100%';
    container.style.overflow = 'hidden';
    container.innerHTML = pageTemplate();
    cacheDom();
    canvas = dom.canvas;
    ctx = dom.ctx;
    bindEvents();
    rendered = true;
    renderTimeline();
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
      if (dom.timeline) {
        dom.timeline.removeEventListener('click', onTimelineClick);
        dom.timeline.removeEventListener('change', onTimelineDelayChange);
        dom.timeline.removeEventListener('dragstart', onTimelineDragStart);
        dom.timeline.removeEventListener('dragover', onTimelineDragOver);
        dom.timeline.removeEventListener('dragenter', onTimelineDragEnter);
        dom.timeline.removeEventListener('dragleave', onTimelineDragLeave);
        dom.timeline.removeEventListener('drop', onTimelineDrop);
        dom.timeline.removeEventListener('dragend', onTimelineDragEnd);
        dom.timeline.removeEventListener('touchstart', onTimelineTouchStart);
        dom.timeline.removeEventListener('touchmove', onTimelineTouchMove);
        dom.timeline.removeEventListener('touchend', onTimelineTouchEnd);
        dom.timeline.removeEventListener('scroll', onTimelineScroll);
      }
    }
    if (thumbRaf) { cancelAnimationFrame(thumbRaf); thumbRaf = null; }
    clearThumbCache();
    if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; }
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
    if (state.srcVideo) {
      try { state.srcVideo.removeAttribute('src'); if (state.srcVideo.load) state.srcVideo.load(); } catch (e) {}
      state.srcVideo = null;
    }
    state.slices = [];
    state.srcImg = null;
    state.processedImg = null;
    state.activeLayer = null;
    state.pickColorMode = false;
    state.transparencyReady = false;
    state.selectedSliceIdx = -1;
    canvas = null;
    ctx = null;
    dom = {};
    rendered = false;
  }

  function cacheDom() {
    dom.canvas = byId('preview-canvas');
    dom.ctx = dom.canvas.getContext('2d');
    dom.canvasWrapper = byId('canvas-wrapper');
    dom.stage = byId('stage-container');
    dom.timeline = byId('timeline');
    dom.stageOverlayText = byId('stage-overlay-text');
    dom.spinnerOverlay = byId('loading-spinner');
    dom.spinnerText = byId('spinner-text');
    dom.resultOverlay = byId('result-overlay');
    dom.resultImg = byId('result-img');
    dom.dlLink = byId('dl-link');
    dom.resultClose = byId('result-close');
    dom.reloadBtn = byId('reload-btn');

    dom.dropZone = byId('drop-zone');
    dom.fileInput = byId('file-input');
    dom.enableTrans = byId('enable-trans');
    dom.transPanel = byId('trans-panel');
    dom.keyColor = byId('key-color');
    dom.pickColorBtn = byId('pick-color-btn');
    dom.fuzziness = byId('fuzziness');
    dom.disableTransBtn = byId('disable-trans-btn');
    dom.imageTools = byId('image-tools');
    dom.videoTools = byId('video-tools');
    dom.videoFps = byId('video-fps');
    dom.videoFpsSlider = byId('video-fps-slider');
    dom.extractVideoBtn = byId('extract-video-btn');

    dom.sliderT = byId('slider-t'); dom.cropT = byId('crop-t');
    dom.sliderB = byId('slider-b'); dom.cropB = byId('crop-b');
    dom.sliderL = byId('slider-l'); dom.cropL = byId('crop-l');
    dom.sliderR = byId('slider-r'); dom.cropR = byId('crop-r');
    dom.rows = byId('rows');
    dom.cols = byId('cols');
    dom.sliceBtn = byId('slice-btn');

    dom.panelStep2 = byId('panel-step2');
    dom.frameIndicator = byId('frame-indicator');
    dom.startGlobalCropBtn = byId('start-global-crop-btn');
    dom.cropPanel = byId('crop-panel');
    dom.cropSlideX = byId('crop-slide-x'); dom.cropNumX = byId('crop-num-x');
    dom.cropSlideY = byId('crop-slide-y'); dom.cropNumY = byId('crop-num-y');
    dom.cropSlideW = byId('crop-slide-w'); dom.cropNumW = byId('crop-num-w');
    dom.cropSlideH = byId('crop-slide-h'); dom.cropNumH = byId('crop-num-h');
    dom.cancelCropBtn = byId('cancel-crop-btn');
    dom.applyCropBtn = byId('apply-crop-btn');
    dom.rangeInput = byId('range-input');
    dom.addTextInput = byId('add-text-input');
    dom.addTextBtn = byId('add-text-btn');
    dom.addTextColor = byId('add-text-color');
    dom.addImageInput = byId('add-image-input');
    dom.btnBold = byId('btn-bold');
    dom.btnItalic = byId('btn-italic');
    dom.btnUnderline = byId('btn-underline');
    dom.selectedLayerTools = byId('selected-layer-tools');
    dom.syncLayerBtn = byId('sync-layer-btn');
    dom.layerList = byId('layer-list');

    dom.batchDelayInput = byId('batch-delay-input');
    dom.batchDelayBtn = byId('batch-delay-btn');
    dom.outW = byId('out-w');
    dom.outH = byId('out-h');
    dom.outScaleSlider = byId('out-scale-slider');
    dom.outScaleVal = byId('out-scale-val');
    dom.qualitySlider = byId('quality-slider');
    dom.quality = byId('quality');
    dom.exportBtn = byId('export-btn');
    dom.exportZipBtn = byId('export-zip-btn');
    dom.delStart = byId('del-start');
    dom.delEnd = byId('del-end');
    dom.btnDelRange = byId('btn-del-range');
    dom.btnKeepRange = byId('btn-keep-range');
    dom.spriteRows = byId('sprite-rows');
    dom.spriteCols = byId('sprite-cols');
    dom.exportPngBtn = byId('export-png-btn');

    dom.zoomOutBtn = byId('zoom-out-btn');
    dom.resetViewBtn = byId('reset-view-btn');
    dom.zoomInBtn = byId('zoom-in-btn');
  }

  // ------------------------------------------------------------------
  // Spinner / overlay helpers
  // ------------------------------------------------------------------
  function showSpinner(msg) {
    dom.spinnerOverlay.style.display = 'flex';
    dom.spinnerText.innerText = msg || t('gifEditorProcessing');
  }
  function hideSpinner() {
    dom.spinnerOverlay.style.display = 'none';
  }
  function closeResultModal() {
    dom.resultOverlay.classList.remove('active');
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
    dom.resultImg.removeAttribute('src');
    dom.dlLink.removeAttribute('href');
  }

  // ------------------------------------------------------------------
  // Input: click / drag / paste / change  (file.type three branches)
  // ------------------------------------------------------------------
  function onDropZoneClick() { dom.fileInput.click(); }

  function onDragOver(e) {
    e.preventDefault();
    if (e.target && e.target.closest && e.target.closest('#gif-drop-zone')) {
      dom.dropZone.style.borderColor = 'var(--accent)';
    }
  }
  function onDragLeave(e) {
    if (e.target && e.target.closest && e.target.closest('#gif-drop-zone')) {
      dom.dropZone.style.borderColor = 'var(--glass-border)';
    }
  }
  function onDrop(e) {
    e.preventDefault();
    dom.dropZone.style.borderColor = 'var(--glass-border)';
    if (e.dataTransfer.files && e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
  }
  function onPaste(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        processFile(items[i].getAsFile());
        break;
      }
    }
  }

  function processFile(file) {
    if (!file) return;
    // Reset transparency tools.
    dom.enableTrans.checked = false;
    dom.transPanel.style.display = 'none';
    state.transparencyReady = false;
    state.slices = [];
    state.srcImg = null;
    state.srcVideo = null;
    state.selectedSliceIdx = -1;
    renderTimeline();
    dom.panelStep2.classList.add('gif-edit-blocked');

    var type = String(file.type || '').toLowerCase();
    if (type === 'image/gif') {
      if (file.size > MAX_FILE_BYTES) {
        alert(t('gifEditorAlertFileTooLarge', [Math.round(file.size / 1048576)]));
        return;
      }
      dom.imageTools.classList.add('gif-hidden');
      dom.videoTools.classList.add('gif-hidden');
      processGifFile(file);
      return;
    }
    if (type.indexOf('video/') === 0) {
      if (file.size > MAX_FILE_BYTES) {
        alert(t('gifEditorAlertFileTooLarge', [Math.round(file.size / 1048576)]));
        return;
      }
      dom.imageTools.classList.add('gif-hidden');
      dom.videoTools.classList.remove('gif-hidden');
      loadVideo(file);
      return;
    }
    // image/* branch
    dom.imageTools.classList.remove('gif-hidden');
    dom.videoTools.classList.add('gif-hidden');
    var reader = new FileReader();
    reader.onload = function (evt) {
      var img = new Image();
      img.onload = function () {
        state.srcImg = img;
        state.mode = 'source';
        dom.outW.value = img.width;
        dom.outH.value = img.height;
        dom.sliderT.max = Math.floor(img.height / 2);
        dom.sliderB.max = Math.floor(img.height / 2);
        dom.sliderL.max = Math.floor(img.width / 2);
        dom.sliderR.max = Math.floor(img.width / 2);
        processSourceImage();
        draw();
        resetView();
        dom.stageOverlayText.innerText = t('gifEditorImageLoaded');
      };
      img.onerror = function () {
        alert(t('gifEditorAlertNoImage'));
      };
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ------------------------------------------------------------------
  // GIF decode (gifuct-js vendor; disposal 1/2/3 handled — source fix #2)
  // ------------------------------------------------------------------
  async function decodeGifFile(file) {
    if (typeof parseGIF !== 'function' || typeof decompressFrames !== 'function') {
      throw new Error('gifuct-js vendor not loaded');
    }
    var buf = await file.arrayBuffer();
    var gif = parseGIF(buf);
    var frames = decompressFrames(gif, true); // buildPatches=true -> f.patch RGBA
    var W = gif.lsd.width, H = gif.lsd.height;
    var screen = document.createElement('canvas');
    screen.width = W; screen.height = H;
    var sctx = screen.getContext('2d');
    var result = [];
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      // disposal=3 needs the canvas state BEFORE this frame is drawn.
      var snap = null;
      if (f.disposalType === 3) snap = sctx.getImageData(0, 0, W, H);
      // Blit this frame's RGBA patch at (dims.left, dims.top).
      var rc = document.createElement('canvas');
      rc.width = f.dims.width; rc.height = f.dims.height;
      rc.getContext('2d').putImageData(
        new ImageData(new Uint8ClampedArray(f.patch), f.dims.width, f.dims.height), 0, 0);
      sctx.drawImage(rc, f.dims.left, f.dims.top);
      // Capture the fully-composed frame.
      var fc = document.createElement('canvas');
      fc.width = W; fc.height = H;
      fc.getContext('2d').drawImage(screen, 0, 0);
      result.push({ canvas: fc, delay: f.delay || 100, disposal: f.disposalType });
      // Post-frame disposal: 2 = clear rect; 3 = restore pre-draw snapshot.
      if (f.disposalType === 2) {
        sctx.clearRect(f.dims.left, f.dims.top, f.dims.width, f.dims.height);
      } else if (f.disposalType === 3 && snap) {
        sctx.putImageData(snap, 0, 0);
      }
    }
    return result;
  }

  function processGifFile(file) {
    showSpinner(t('gifEditorParsingGif'));
    decodeGifFile(file).then(function (frames) {
      var w = frames.length ? frames[0].canvas.width : 0;
      var h = frames.length ? frames[0].canvas.height : 0;
      state.slices = frames.map(function (f) {
        return { id: freshId(), canvas: f.canvas, delay: f.delay, layers: [] };
      });
      hideSpinner();
      slicesReady(w, h);
      dom.stageOverlayText.innerText = t('gifEditorGifMode');
    }).catch(function (err) {
      console.error(err);
      hideSpinner();
      alert(t('gifEditorAlertGifParseFail') + err.message);
    });
  }

  // Common post-slices-created UI update.
  function slicesReady(w, h) {
    renderTimeline();
    dom.exportBtn.disabled = false;
    dom.panelStep2.classList.remove('gif-edit-blocked');
    var currentScale = parseFloat(dom.outScaleSlider.value) || 1.0;
    dom.outW.value = Math.round(w * currentScale);
    dom.outH.value = Math.round(h * currentScale);
    if (state.slices.length > 0) selectSlice(0);
  }

  // ------------------------------------------------------------------
  // Video: load preview + frame extraction (seek loop)
  // ------------------------------------------------------------------
  function loadVideo(file) {
    dom.stageOverlayText.innerText = t('gifEditorVideoLoaded');
    var url = URL.createObjectURL(file);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = url;
    var video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = function () {
      state.srcVideo = video;
      state.mode = 'video_preview';
      dom.outW.value = video.videoWidth;
      dom.outH.value = video.videoHeight;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      video.currentTime = 0;
    };
    video.onseeked = function () {
      if (state.mode === 'video_preview') {
        ctx.drawImage(video, 0, 0);
        resetView();
      }
    };
  }

  // Seek helper that resolves immediately when already at the target time
  // (avoids waiting forever for a seeked event that never fires).
  function seekTo(video, t) {
    return new Promise(function (resolve) {
      if (Math.abs(video.currentTime - t) < 0.005) { resolve(); return; }
      var done = false;
      var onSeeked = function () {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = t;
    });
  }

  function extractFrames() {
    if (!state.srcVideo) return;
    var fps = parseFloat(dom.videoFps.value);
    if (!(fps > 0)) fps = 1;
    if (fps > 60) fps = 60;
    var video = state.srcVideo;
    var duration = video.duration;
    if (!duration || duration === Infinity) {
      alert(t('gifEditorAlertVideoUnsupported'));
      return;
    }
    var frameInterval = 1 / fps;
    showSpinner(t('gifEditorExtractingFrames'));
    (async function () {
      state.slices = [];
      var delay = Math.floor(1000 / fps);
      for (var time = 0; time < duration; time += frameInterval) {
        await seekTo(video, time);
        var c = document.createElement('canvas');
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0);
        state.slices.push({ id: freshId(), canvas: c, delay: delay, layers: [] });
        dom.spinnerText.innerText = t('gifEditorExtractingPct', [Math.round((time / duration) * 100)]);
      }
      hideSpinner();
      var currentScale = parseFloat(dom.outScaleSlider.value) || 1.0;
      if (state.slices.length > 0) {
        dom.outW.value = Math.round(state.slices[0].canvas.width * currentScale);
        dom.outH.value = Math.round(state.slices[0].canvas.height * currentScale);
      }
      state.mode = 'source';
      renderTimeline();
      if (state.slices.length > 0) selectSlice(0);
      dom.exportBtn.disabled = false;
      dom.stageOverlayText.innerText = t('gifEditorDone');
    })();
  }

  // ------------------------------------------------------------------
  // Grid slice (sw/sh rounded — source fix #3)
  // ------------------------------------------------------------------
  function runSlice() {
    if (!state.processedImg) { alert(t('gifEditorAlertNoImage')); return; }
    var ct = parseInt(dom.cropT.value, 10) || 0,
        cb = parseInt(dom.cropB.value, 10) || 0,
        cl = parseInt(dom.cropL.value, 10) || 0,
        cr = parseInt(dom.cropR.value, 10) || 0;
    var rows = parseInt(dom.rows.value, 10) || 1,
        cols = parseInt(dom.cols.value, 10) || 1;
    var w = state.processedImg.width - cl - cr,
        h = state.processedImg.height - ct - cb;
    var sw = Math.round(w / cols), sh = Math.round(h / rows);
    state.slices = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var sc = document.createElement('canvas');
        sc.width = sw;
        sc.height = sh;
        sc.getContext('2d').drawImage(
          state.processedImg,
          cl + c * sw, ct + r * sh, sw, sh,
          0, 0, sw, sh
        );
        state.slices.push({ id: freshId(), canvas: sc, delay: 500, layers: [] });
      }
    }
    var currentScale = parseFloat(dom.outScaleSlider.value) || 1.0;
    dom.outW.value = Math.round(sw * currentScale);
    dom.outH.value = Math.round(sh * currentScale);
    renderTimeline();
    dom.exportBtn.disabled = false;
    if (state.slices.length > 0) selectSlice(0);
  }

  // ------------------------------------------------------------------
  // Global crop (rect applied to every slice, layer coords offset)
  // ------------------------------------------------------------------
  function setupCropSliders() {
    var props = ['X', 'Y', 'W', 'H'];
    props.forEach(function (p) {
      var slider = byId('crop-slide-' + p.toLowerCase());
      var num = byId('crop-num-' + p.toLowerCase());
      var update = function () {
        var val = parseInt(slider.value, 10);
        num.value = val;
        state.cropRect[p.toLowerCase()] = val;
        draw();
      };
      slider.addEventListener('input', update);
      num.addEventListener('input', function () {
        slider.value = num.value;
        update();
      });
    });
  }

  function syncCropSlidersFromRect() {
    if (state.mode !== 'crop') return;
    var r = state.cropRect;
    dom.cropSlideX.value = r.x; dom.cropNumX.value = Math.round(r.x);
    dom.cropSlideY.value = r.y; dom.cropNumY.value = Math.round(r.y);
    dom.cropSlideW.value = r.w; dom.cropNumW.value = Math.round(r.w);
    dom.cropSlideH.value = r.h; dom.cropNumH.value = Math.round(r.h);
  }

  function startGlobalCrop() {
    if (state.selectedSliceIdx < 0) { alert(t('gifEditorAlertSliceFirst')); return; }
    var cur = state.slices[state.selectedSliceIdx].canvas;
    var pW = cur.width * 0.1, pH = cur.height * 0.1;
    state.cropRect = { x: pW, y: pH, w: cur.width - pW * 2, h: cur.height - pH * 2 };
    dom.cropSlideX.max = cur.width; dom.cropSlideW.max = cur.width;
    dom.cropSlideY.max = cur.height; dom.cropSlideH.max = cur.height;
    syncCropSlidersFromRect();
    state.mode = 'crop';
    dom.cropPanel.classList.add('active');
    dom.startGlobalCropBtn.style.display = 'none';
    dom.panelStep2.classList.remove('gif-edit-blocked');
    draw();
  }

  function cancelCrop() {
    state.mode = 'editor';
    dom.cropPanel.classList.remove('active');
    dom.startGlobalCropBtn.style.display = 'block';
    draw();
  }

  function applyCrop() {
    var r = state.cropRect;
    if (r.w <= 0 || r.h <= 0) return;
    showSpinner(t('gifEditorCropping'));
    setTimeout(function () {
      state.slices.forEach(function (slice) {
        var t = document.createElement('canvas');
        t.width = r.w;
        t.height = r.h;
        t.getContext('2d').drawImage(slice.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        slice.canvas = t;
        slice.layers.forEach(function (l) {
          l.x -= r.x;
          l.y -= r.y;
        });
      });
      state.mode = 'editor';
      dom.outW.value = Math.round(r.w);
      dom.outH.value = Math.round(r.h);
      dom.cropPanel.classList.remove('active');
      dom.startGlobalCropBtn.style.display = 'block';
      clearThumbCache(); // slice canvases were replaced; cached previews are stale
      renderTimeline();
      selectSlice(state.selectedSliceIdx);
      hideSpinner();
    }, 50);
  }

  // ------------------------------------------------------------------
  // Timeline: virtualized horizontal strip. Only frames inside the current
  // scroll window (plus a buffer) get DOM nodes; each item is absolutely
  // positioned inside a track sized to N*PITCH so the browser keeps native
  // horizontal scroll geometry. Every interaction (select / duplicate /
  // delete / delay / drag & drop / touch reorder) is delegated on the
  // container — no per-frame listeners. Thumbnails are small previews
  // generated lazily for windowed items and held in a bounded cache.
  // ------------------------------------------------------------------
  var TL_ITEM_W = 100;          // matches .gif-slice-item width (style.css)
  var TL_ITEM_GAP = 10;         // matches .gif-timeline-area gap
  var TL_ITEM_PITCH = TL_ITEM_W + TL_ITEM_GAP; // 110 px per frame slot
  var TL_BUFFER = 4;            // extra items rendered beyond the viewport
  var THUMB_CACHE_MAX = 256;    // bounded thumbnail cache entries

  function clearThumbCache() {
    for (var i = 0; i < thumbKeys.length; i++) {
      delete thumbCache[thumbKeys[i]];
    }
    thumbKeys.length = 0;
  }

  // Small bounded preview at ~thumbnail-box size (never a full-frame payload).
  function thumbForSlice(s) {
    var cached = thumbCache[s.id];
    if (cached) return cached;
    var src = s.canvas;
    var TW = 96, TH = 72; // ~ the .gif-slice-img-box drawable area
    var scale = Math.min(TW / src.width, TH / src.height, 1);
    var w = Math.max(1, Math.round(src.width * scale));
    var h = Math.max(1, Math.round(src.height * scale));
    var tc = document.createElement('canvas');
    tc.width = w; tc.height = h;
    tc.getContext('2d').drawImage(src, 0, 0, w, h);
    var url = tc.toDataURL('image/png');
    thumbCache[s.id] = url;
    thumbKeys.push(s.id);
    if (thumbKeys.length > THUMB_CACHE_MAX) {
      delete thumbCache[thumbKeys.shift()];
    }
    return url;
  }

  function timelineWindow() {
    var tl = dom.timeline;
    var count = state.slices.length;
    if (!count) return null;
    var viewW = tl.clientWidth || 800;
    // The container clamps scrollLeft itself, but guard defensively so an
    // out-of-range scroll can never yield an empty/inverted window.
    var maxScroll = Math.max(0, count * TL_ITEM_PITCH - TL_ITEM_GAP - viewW);
    var scroll = Math.max(0, Math.min(tl.scrollLeft || 0, maxScroll));
    var start = Math.max(0, Math.floor(scroll / TL_ITEM_PITCH) - TL_BUFFER);
    var visible = Math.ceil(viewW / TL_ITEM_PITCH) + TL_BUFFER * 2;
    return { start: start, end: Math.min(count, start + visible) };
  }

  function buildSliceItem(i) {
    var s = state.slices[i];
    var el = document.createElement('div');
    el.className = 'gif-slice-item' + (i === state.selectedSliceIdx ? ' selected' : '');
    el.draggable = true;
    el.dataset.index = i;
    el.style.left = (i * TL_ITEM_PITCH) + 'px';

    var img = document.createElement('img');
    img.alt = '';
    img.src = thumbForSlice(s);
    var imgBox = document.createElement('div');
    imgBox.className = 'gif-slice-img-box';
    imgBox.appendChild(img);

    var tools = document.createElement('div');
    tools.className = 'gif-slice-tools';
    tools.innerHTML =
      '<div class="gif-slice-tools-row">' +
      '<span class="gif-slice-num">#' + (i + 1) + '</span>' +
      '<span class="gif-slice-action" data-action="duplicate" title="' + t('gifEditorDuplicate') + '">📑</span>' +
      '<span class="gif-slice-action gif-slice-action-del" data-action="delete" title="' + t('gifEditorDelete') + '">🗑️</span>' +
      '</div>';
    var delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.className = 'gif-delay-input';
    delayInput.value = s.delay;
    delayInput.title = t('gifEditorDelayTitle');
    tools.appendChild(delayInput);

    el.appendChild(imgBox);
    el.appendChild(tools);
    return el;
  }

  function renderTimeline() {
    var tl = dom.timeline;
    if (!tl) return;
    // Structural change: drop the previous window, keep the horizontal position.
    timelineWin = null;
    var keepScroll = tl.scrollLeft || 0;
    tl.innerHTML = '';
    if (state.slices.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'gif-timeline-empty';
      empty.innerText = t('gifEditorNoFrames');
      tl.appendChild(empty);
      clearThumbCache();
      return;
    }
    if (state.selectedSliceIdx >= state.slices.length) {
      state.selectedSliceIdx = state.slices.length - 1;
    }
    var track = document.createElement('div');
    track.className = 'gif-timeline-track';
    track.style.width = (state.slices.length * TL_ITEM_PITCH - TL_ITEM_GAP) + 'px';
    tl.appendChild(track);
    tl.scrollLeft = keepScroll; // clamps to the new max scroll
    updateTimelineWindow();
  }

  function updateTimelineWindow() {
    var tl = dom.timeline;
    if (!tl || state.slices.length === 0) return;
    var track = tl.querySelector('.gif-timeline-track');
    if (!track) return;
    var win = timelineWindow();
    if (timelineWin && timelineWin.start === win.start && timelineWin.end === win.end) {
      patchTimelineSelection(tl);
      return;
    }
    timelineWin = win;
    track.innerHTML = '';
    for (var i = win.start; i < win.end; i++) {
      track.appendChild(buildSliceItem(i));
    }
    patchTimelineSelection(tl);
  }

  function patchTimelineSelection(tl) {
    var idx = state.selectedSliceIdx;
    var items = tl.querySelectorAll('.gif-slice-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('selected', parseInt(items[i].dataset.index, 10) === idx);
    }
  }

  // Center the frame in the scroll viewport (matches the old
  // scrollIntoView({ inline: 'center' }) behavior without needing a DOM node).
  function centerTimelineOn(idx) {
    var tl = dom.timeline;
    if (!tl) return;
    var viewW = tl.clientWidth || 0;
    var targetLeft = idx * TL_ITEM_PITCH;
    var center = Math.max(0, targetLeft - (viewW - TL_ITEM_W) / 2);
    if (center !== (tl.scrollLeft || 0)) {
      tl.scrollTo({ left: center, behavior: 'smooth' });
    }
  }

  function onTimelineScroll() { scheduleTimelineUpdate(); }
  function onWindowResize() { scheduleTimelineUpdate(); }
  function scheduleTimelineUpdate() {
    if (thumbRaf) return;
    thumbRaf = requestAnimationFrame(function () {
      thumbRaf = null;
      updateTimelineWindow();
    });
  }

  // --- Delegated timeline interactions --------------------------------
  function onTimelineClick(e) {
    var item = e.target && e.target.closest ? e.target.closest('.gif-slice-item') : null;
    if (!item) return;
    var idx = parseInt(item.dataset.index, 10);
    if (isNaN(idx)) return;
    var actionEl = e.target.closest('.gif-slice-action');
    if (actionEl) {
      if (actionEl.dataset.action === 'duplicate') duplicateSlice(idx);
      else if (actionEl.dataset.action === 'delete') deleteSlice(idx);
      return;
    }
    if (e.target.closest('input')) return; // delay input clicks never select
    selectSlice(idx);
  }

  function onTimelineDelayChange(e) {
    var input = e.target;
    if (!input || input.tagName !== 'INPUT' || !input.classList.contains('gif-delay-input')) return;
    var item = input.closest('.gif-slice-item');
    if (!item) return;
    var s = state.slices[parseInt(item.dataset.index, 10)];
    if (!s) return;
    var v = parseInt(input.value, 10);
    s.delay = (isNaN(v) || v < 0) ? 0 : v;
  }

  function onTimelineDragStart(e) {
    var item = e.target && e.target.closest ? e.target.closest('.gif-slice-item') : null;
    if (!item) return;
    var idx = parseInt(item.dataset.index, 10);
    if (isNaN(idx)) return;
    state.dragSrcIndex = idx;
    state.dragItemEl = item;
    item.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    }
  }
  function onTimelineDragOver(e) {
    var item = e.target && e.target.closest ? e.target.closest('.gif-slice-item') : null;
    if (!item) return;
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return false;
  }
  function onTimelineDragEnter(e) {
    var item = e.target && e.target.closest ? e.target.closest('.gif-slice-item') : null;
    if (item) item.classList.add('drag-over');
  }
  function onTimelineDragLeave(e) {
    var item = e.target && e.target.closest ? e.target.closest('.gif-slice-item') : null;
    if (!item) return;
    var rel = e.relatedTarget;
    if (rel && rel.closest && rel.closest('.gif-slice-item') === item) return;
    item.classList.remove('drag-over');
  }
  function onTimelineDrop(e) {
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    var item = e.target && e.target.closest ? e.target.closest('.gif-slice-item') : null;
    if (!item) return;
    var srcIdx = state.dragSrcIndex;
    var targetIdx = parseInt(item.dataset.index, 10);
    if (srcIdx !== null && srcIdx !== undefined && !isNaN(targetIdx) && srcIdx !== targetIdx) {
      performReorder(srcIdx, targetIdx);
    }
    return false;
  }
  function onTimelineDragEnd() {
    if (state.dragItemEl) state.dragItemEl.classList.remove('dragging');
    state.dragItemEl = null;
    state.dragSrcIndex = null;
    clearDragOverClasses();
  }

  function onTimelineTouchStart(e) {
    if (e.target.tagName === 'INPUT' || e.target.onclick) return;
    var item = e.target.closest('.gif-slice-item');
    if (!item) return;
    state.touchDragItem = item;
    state.touchStartIndex = parseInt(item.dataset.index, 10);
  }
  function onTimelineTouchMove(e) {
    if (!state.touchDragItem) return;
    e.preventDefault();
    var touch = e.touches[0];
    var under = document.elementFromPoint(touch.clientX, touch.clientY);
    var targetItem = under ? under.closest('.gif-slice-item') : null;
    clearDragOverClasses();
    if (targetItem && targetItem !== state.touchDragItem) targetItem.classList.add('drag-over');
  }
  function onTimelineTouchEnd(e) {
    if (!state.touchDragItem) return;
    var touch = e.changedTouches[0];
    var under = document.elementFromPoint(touch.clientX, touch.clientY);
    var targetItem = under ? under.closest('.gif-slice-item') : null;
    if (targetItem && targetItem !== state.touchDragItem) {
      performReorder(state.touchStartIndex, parseInt(targetItem.dataset.index, 10));
    }
    clearDragOverClasses();
    state.touchDragItem = null;
    state.touchStartIndex = null;
  }

  function clearDragOverClasses() {
    if (!dom.timeline) return;
    var items = dom.timeline.querySelectorAll('.gif-slice-item');
    for (var i = 0; i < items.length; i++) items[i].classList.remove('drag-over');
  }

  function duplicateSlice(i) {
    var src = state.slices[i];
    var nc = document.createElement('canvas');
    nc.width = src.canvas.width;
    nc.height = src.canvas.height;
    nc.getContext('2d').drawImage(src.canvas, 0, 0);
    var nl = src.layers.map(function (l) { return Object.assign({}, l, { id: freshId() }); });
    state.slices.splice(i + 1, 0, { id: freshId(), canvas: nc, delay: src.delay, layers: nl });
    state.selectedSliceIdx = i + 1;
    renderTimeline();
    selectSlice(state.selectedSliceIdx);
  }

  function deleteSlice(i) {
    state.slices.splice(i, 1);
    state.selectedSliceIdx = Math.max(0, state.slices.length - 1);
    renderTimeline();
    if (state.slices.length > 0) selectSlice(state.selectedSliceIdx);
    else { state.mode = 'source'; draw(); }
  }

  function performReorder(fromIndex, toIndex) {
    var elementToMove = state.slices[fromIndex];
    state.slices.splice(fromIndex, 1);
    state.slices.splice(toIndex, 0, elementToMove);
    if (state.selectedSliceIdx === fromIndex) {
      state.selectedSliceIdx = toIndex;
    } else if (fromIndex < state.selectedSliceIdx && toIndex >= state.selectedSliceIdx) {
      state.selectedSliceIdx--;
    } else if (fromIndex > state.selectedSliceIdx && toIndex <= state.selectedSliceIdx) {
      state.selectedSliceIdx++;
    }
    renderTimeline();
  }

  function selectSlice(idx) {
    if (idx < 0 || idx >= state.slices.length) return;
    state.mode = 'editor';
    state.selectedSliceIdx = idx;
    state.activeLayer = null;
    dom.panelStep2.classList.remove('gif-edit-blocked');
    dom.frameIndicator.innerText = t('gifEditorFrameIndicator', [idx + 1]);
    dom.stageOverlayText.innerText = t('gifEditorEditMode', [idx + 1]);
    centerTimelineOn(idx);
    updateTimelineWindow();
    updateUIForSelection();
    draw();
  }

  // ------------------------------------------------------------------
  // Chroma-key transparency (magic wand)
  // ------------------------------------------------------------------
  function toggleTransPanel() {
    dom.transPanel.style.display = dom.enableTrans.checked ? 'block' : 'none';
    processSourceImage();
    draw();
  }
  function transParamChanged() {
    state.transparencyReady = true;
    processSourceImage();
    draw();
  }

  function pickColorClick() {
    if (window.EyeDropper) {
      try {
        var ed = new EyeDropper();
        ed.open().then(function (result) {
          dom.keyColor.value = result.sRGBHex;
          state.transparencyReady = true;
          processSourceImage();
          draw();
        }).catch(function () { /* user cancelled */ });
      } catch (e) { /* fall through to manual mode */ }
    } else {
      state.pickColorMode = !state.pickColorMode;
      if (state.pickColorMode) {
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

  function processSourceImage() {
    if (!state.srcImg) {
      draw();
      return;
    }
    var cvs = document.createElement('canvas');
    cvs.width = state.srcImg.width;
    cvs.height = state.srcImg.height;
    var c = cvs.getContext('2d');
    c.drawImage(state.srcImg, 0, 0);
    applyTransparencyToCtx(c, cvs.width, cvs.height);
    state.processedImg = cvs;
  }

  function applyTransparencyToCtx(targetCtx, width, height) {
    if (!dom.enableTrans || !dom.enableTrans.checked) return;
    if (!state.transparencyReady) return;
    var d = targetCtx.getImageData(0, 0, width, height);
    var data = d.data;
    var hex = dom.keyColor.value;
    var r = parseInt(hex.slice(1, 3), 16),
        g = parseInt(hex.slice(3, 5), 16),
        b = parseInt(hex.slice(5, 7), 16);
    var f = parseFloat(dom.fuzziness.value) * 2.55;
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

    if (state.pickColorMode) {
      var px = ctx.getImageData(Math.floor(coords.x), Math.floor(coords.y), 1, 1).data;
      var hex = '#' + [px[0], px[1], px[2]].map(function (x) {
        return x.toString(16).padStart(2, '0');
      }).join('');
      dom.keyColor.value = hex;
      state.transparencyReady = true;
      processSourceImage();
      draw();
      state.pickColorMode = false;
      dom.canvasWrapper.style.cursor = 'default';
      dom.stageOverlayText.innerText = t('gifEditorPickColorDone') + hex;
      dom.pickColorBtn.classList.remove('active');
      return;
    }

    if (state.mode === 'crop') {
      var h = checkHandleHit(coords.x, coords.y, state.cropRect);
      if (h) { startInteraction(e, h, state.cropRect); return; }
      if (coords.x >= state.cropRect.x && coords.x <= state.cropRect.x + state.cropRect.w &&
          coords.y >= state.cropRect.y && coords.y <= state.cropRect.y + state.cropRect.h) {
        startInteraction(e, 'move', state.cropRect);
        return;
      }
      startPan(e);
      return;
    }

    if (state.mode === 'editor') {
      if (state.activeLayer && checkHandleHit(coords.x, coords.y, state.activeLayer)) {
        startInteraction(e, checkHandleHit(coords.x, coords.y, state.activeLayer), state.activeLayer);
        return;
      }
      var hit = checkLayerHit(coords.x, coords.y);
      if (hit) {
        state.activeLayer = hit;
        if (hit.type === 'text') {
          state.textStyle.bold = !!hit.bold;
          dom.btnBold.classList.toggle('active', !!hit.bold);
          state.textStyle.italic = !!hit.italic;
          dom.btnItalic.classList.toggle('active', !!hit.italic);
          state.textStyle.underline = !!hit.underline;
          dom.btnUnderline.classList.toggle('active', !!hit.underline);
          dom.addTextColor.value = hit.color;
        }
        startInteraction(e, 'move', hit);
        updateUIForSelection();
      } else {
        if (state.activeLayer) {
          state.activeLayer = null;
          updateUIForSelection();
          draw();
        }
        startPan(e);
      }
      return;
    }
    startPan(e);
  }

  function onPointerMove(e) {
    if (state.isDraggingStage) {
      e.preventDefault();
      var cx = e.touches ? e.touches[0].clientX : e.clientX;
      var cy = e.touches ? e.touches[0].clientY : e.clientY;
      state.panX = cx - state.startX;
      state.panY = cy - state.startY;
      updateTransform();
      return;
    }
    if (state.interactionMode) {
      e.preventDefault();
      handleInteraction(e);
    }
  }

  function onPointerUp() {
    state.isDraggingStage = false;
    state.interactionMode = null;
    dom.canvasWrapper.style.cursor = 'default';
  }

  function startPan(e) {
    state.isDraggingStage = true;
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    state.startX = cx - state.panX;
    state.startY = cy - state.panY;
    dom.canvasWrapper.style.cursor = 'grabbing';
  }

  function startInteraction(e, mode, target) {
    state.interactionMode = mode;
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    state.startMouseX = cx;
    state.startMouseY = cy;
    state.startLayerState = {
      x: target.x, y: target.y,
      w: target.w || 0, h: target.h || 0,
      size: target.size || 0
    };
  }

  function handleInteraction(e) {
    var cx = e.touches ? e.touches[0].clientX : e.clientX;
    var cy = e.touches ? e.touches[0].clientY : e.clientY;
    var dx = (cx - state.startMouseX) / state.scale;
    var dy = (cy - state.startMouseY) / state.scale;
    var t = state.mode === 'crop' ? state.cropRect : state.activeLayer;
    var s = state.startLayerState;
    if (!t) return;
    if (state.interactionMode === 'move') {
      t.x = s.x + dx;
      t.y = s.y + dy;
    } else {
      if (t.type === 'text') {
        var d = state.interactionMode.indexOf('b') >= 0 ? dy : -dy;
        t.size = Math.max(8, s.size + d);
      } else {
        var nx = s.x, ny = s.y, nw = s.w, nh = s.h;
        if (state.interactionMode.indexOf('r') >= 0) nw = s.w + dx;
        if (state.interactionMode.indexOf('b') >= 0) nh = s.h + dy;
        if (state.interactionMode.indexOf('l') >= 0) { nx = s.x + dx; nw = s.w - dx; }
        if (state.interactionMode.indexOf('t') >= 0) { ny = s.y + dy; nh = s.h - dy; }
        if (nw > 5 && nh > 5) { t.x = nx; t.y = ny; t.w = nw; t.h = nh; }
      }
    }
    if (state.mode === 'crop') syncCropSlidersFromRect();
    draw();
  }

  function resetView() {
    var w = canvas.width || 300, h = canvas.height || 300;
    if (w === 0) return;
    var cw = dom.stage.clientWidth, ch = dom.stage.clientHeight;
    state.scale = Math.min((cw - 40) / w, (ch - 40) / h);
    state.panX = (cw - w * state.scale) / 2;
    state.panY = (ch - h * state.scale) / 2;
    updateTransform();
  }
  function updateTransform() {
    dom.canvasWrapper.style.transform =
      'translate(' + state.panX + 'px, ' + state.panY + 'px) scale(' + state.scale + ')';
  }

  function drawGizmo(o, c, isCrop) {
    var x, y, w, h;
    if (o.type === 'text') {
      ctx.font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + o.size + 'px ' + (o.font || 'sans-serif');
      var m = ctx.measureText(o.content);
      x = o.x; y = o.y; w = m.width; h = o.size;
    } else {
      x = o.x; y = o.y; w = o.w; h = o.h;
    }
    ctx.save();
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    if (isCrop) ctx.setLineDash([5, 5]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = 'white';
    var hs = 20;
    var dH = function (hx, hy) {
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    };
    dH(x, y);
    dH(x + w, y);
    dH(x, y + h);
    dH(x + w, y + h);
    ctx.restore();
  }

  function checkLayerHit(x, y) {
    var layers = state.slices[state.selectedSliceIdx].layers;
    for (var i = layers.length - 1; i >= 0; i--) {
      var o = layers[i];
      var bx, by, bw, bh;
      if (o.type === 'text') {
        ctx.font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + o.size + 'px ' + (o.font || 'sans-serif');
        var m = ctx.measureText(o.content);
        bx = o.x; by = o.y; bw = m.width; bh = o.size;
      } else {
        bx = o.x; by = o.y; bw = o.w; bh = o.h;
      }
      if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) return o;
    }
    return null;
  }

  function checkHandleHit(mx, my, o) {
    var x, y, w, h;
    if (o.type === 'text') {
      ctx.font = (o.italic ? 'italic ' : '') + (o.bold ? 'bold ' : '') + o.size + 'px ' + (o.font || 'sans-serif');
      var m = ctx.measureText(o.content);
      x = o.x; y = o.y; w = m.width; h = o.size;
    } else {
      x = o.x; y = o.y; w = o.w; h = o.h;
    }
    var hs = 30;
    if (Math.abs(mx - x) < hs && Math.abs(my - y) < hs) return 'tl';
    if (Math.abs(mx - (x + w)) < hs && Math.abs(my - y) < hs) return 'tr';
    if (Math.abs(mx - x) < hs && Math.abs(my - (y + h)) < hs) return 'bl';
    if (Math.abs(mx - (x + w)) < hs && Math.abs(my - (y + h)) < hs) return 'br';
    return null;
  }

  // ------------------------------------------------------------------
  // Layers (text / image; scope current/all/range; sync by groupId — fix #4)
  // ------------------------------------------------------------------
  function getTargetIndices() {
    var scopeEl = document.querySelector('input[name="gif-layer-scope"]:checked');
    if (!scopeEl) return [];
    var scope = scopeEl.value;
    if (state.selectedSliceIdx < 0) {
      alert(t('gifEditorAlertNoFrameSelected'));
      return [];
    }
    if (scope === 'current') return [state.selectedSliceIdx];
    if (scope === 'all') return state.slices.map(function (_, i) { return i; });
    var pts = dom.rangeInput.value.split(/[,，]/);
    var idxs = [];
    pts.forEach(function (p) {
      if (p.indexOf('-') >= 0) {
        var parts = p.split('-');
        var s = parseInt(parts[0], 10), e = parseInt(parts[1], 10);
        for (var i = s; i <= e; i++) idxs.push(i - 1);
      } else {
        idxs.push(parseInt(p, 10) - 1);
      }
    });
    return idxs.filter(function (i) { return i >= 0 && i < state.slices.length; });
  }

  function addText() {
    var idxs = getTargetIndices();
    var txt = dom.addTextInput.value;
    if (!idxs.length || !txt) return;
    var ref = state.slices[state.selectedSliceIdx];
    var gid = freshId();
    idxs.forEach(function (i) {
      state.slices[i].layers.push({
        id: freshId(),
        groupId: gid,
        type: 'text',
        content: txt,
        color: dom.addTextColor.value,
        font: 'sans-serif',
        size: ref.canvas.height / 5,
        x: ref.canvas.width / 2,
        y: ref.canvas.height / 2,
        bold: state.textStyle.bold,
        italic: state.textStyle.italic,
        underline: state.textStyle.underline
      });
    });
    updateUIForSelection();
    draw();
  }

  function addImageFromFile(file) {
    var idxs = getTargetIndices();
    if (!idxs.length || !file) return;
    var r = new FileReader();
    r.onload = function (evt) {
      var img = new Image();
      img.onload = function () {
        var ref = state.slices[state.selectedSliceIdx];
        var w = ref.canvas.width / 3;
        var h = w * (img.height / img.width);
        var gid = freshId();
        idxs.forEach(function (i) {
          state.slices[i].layers.push({
            id: freshId(),
            groupId: gid,
            type: 'image',
            img: img,
            w: w,
            h: h,
            x: 10,
            y: 10
          });
        });
        updateUIForSelection();
        draw();
      };
      img.src = evt.target.result;
    };
    r.readAsDataURL(file);
  }

  function toggleStyle(p, btnName) {
    state.textStyle[p] = !state.textStyle[p];
    dom[btnName].classList.toggle('active', state.textStyle[p]);
    if (state.activeLayer && state.activeLayer.type === 'text') {
      state.activeLayer[p] = state.textStyle[p];
      draw();
    }
  }

  function syncLayer() {
    if (!state.activeLayer || state.selectedSliceIdx < 0) return;
    var src = state.activeLayer;
    if (!src.groupId) src.groupId = src.id;
    state.slices.forEach(function (s, i) {
      if (i === state.selectedSliceIdx) return;
      var f = null;
      for (var j = 0; j < s.layers.length; j++) {
        if (s.layers[j].groupId === src.groupId) { f = s.layers[j]; break; }
      }
      if (f) {
        Object.assign(f, src);
        f.id = freshId();
      } else {
        s.layers.push(Object.assign({}, src, { id: freshId() }));
      }
    });
    alert(t('gifEditorSyncDone'));
  }

  function updateUIForSelection() {
    var list = dom.layerList;
    list.innerHTML = '';
    if (state.selectedSliceIdx >= 0) {
      state.slices[state.selectedSliceIdx].layers.forEach(function (o, i) {
        var item = document.createElement('div');
        item.className = 'gif-layer-item' + (o === state.activeLayer ? ' gif-layer-item-active' : '');
        var label = document.createElement('span');
        label.className = 'gif-layer-label';
        label.textContent = o.type === 'text' ? 'T: ' + o.content : 'Img';
        var remove = document.createElement('span');
        remove.className = 'gif-layer-remove';
        remove.textContent = '×';
        remove.title = t('gifEditorDelete');
        remove.addEventListener('click', function (ev) { ev.stopPropagation(); removeLayer(i); });
        item.appendChild(label);
        item.appendChild(remove);
        item.addEventListener('click', function () {
          state.activeLayer = o;
          updateUIForSelection();
          draw();
        });
        list.appendChild(item);
      });
    }
    dom.selectedLayerTools.style.display = state.activeLayer ? 'block' : 'none';
  }

  function removeLayer(i) {
    state.slices[state.selectedSliceIdx].layers.splice(i, 1);
    state.activeLayer = null;
    updateUIForSelection();
    draw();
  }

  // ------------------------------------------------------------------
  // Preview draw (source fix #1: ctx, not cx) + shared compositor (fix #5)
  // ------------------------------------------------------------------
  function drawLayers(targetCtx, layers) {
    layers.forEach(function (l) {
      targetCtx.save();
      if (l.type === 'text') {
        targetCtx.font = (l.italic ? 'italic ' : '') + (l.bold ? 'bold ' : '') + l.size + 'px ' + (l.font || 'sans-serif');
        targetCtx.fillStyle = l.color;
        targetCtx.textBaseline = 'top';
        targetCtx.fillText(l.content, l.x, l.y);
        if (l.underline) {
          var mt = targetCtx.measureText(l.content);
          targetCtx.fillRect(l.x, l.y + l.size * 1.05, mt.width, l.size / 15);
        }
      } else {
        targetCtx.drawImage(l.img, l.x, l.y, l.w, l.h);
      }
      targetCtx.restore();
    });
  }

  // Compose one slice (base canvas + layers) into a new outW x outH canvas.
  // opts.applyTransparency: chroma-key the base before drawing layers.
  // opts.matte: fill the output background with this color first (GIF export
  // uses #FF00FF so gif.js can map it to transparency).
  function composeFrame(canvasSrc, layers, outW, outH, opts) {
    var cc = document.createElement('canvas');
    cc.width = canvasSrc.width;
    cc.height = canvasSrc.height;
    var c = cc.getContext('2d');
    c.drawImage(canvasSrc, 0, 0);
    if (opts && opts.applyTransparency) applyTransparencyToCtx(c, cc.width, cc.height);
    drawLayers(c, layers);
    var f = document.createElement('canvas');
    f.width = outW;
    f.height = outH;
    var fx = f.getContext('2d');
    if (opts && opts.matte) {
      fx.fillStyle = opts.matte;
      fx.fillRect(0, 0, outW, outH);
    }
    fx.drawImage(cc, 0, 0, outW, outH);
    return f;
  }

  function draw() {
    var w = 300, h = 300;
    if (state.mode === 'source' && state.processedImg) {
      w = state.processedImg.width;
      h = state.processedImg.height;
    } else if (state.mode === 'video_preview' && state.srcVideo) {
      w = state.srcVideo.videoWidth;
      h = state.srcVideo.videoHeight;
    } else if ((state.mode === 'editor' || state.mode === 'crop') && state.selectedSliceIdx >= 0) {
      var s0 = state.slices[state.selectedSliceIdx];
      if (s0) { w = s0.canvas.width; h = s0.canvas.height; }
    }
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    if (state.mode === 'source') {
      if (state.processedImg) {
        ctx.drawImage(state.processedImg, 0, 0);
        var t = +dom.cropT.value, b = +dom.cropB.value,
            l = +dom.cropL.value, r = +dom.cropR.value;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, 0, w, t);
        ctx.fillRect(0, h - b, w, b);
        ctx.fillRect(0, t, l, h - t - b);
        ctx.fillRect(w - r, t, r, h - t - b);
        ctx.strokeStyle = '#ff0055';
        ctx.lineWidth = 2;
        ctx.strokeRect(l, t, w - l - r, h - t - b);
        var rows = parseInt(dom.rows.value, 10) || 1,
            cols = parseInt(dom.cols.value, 10) || 1;
        var sw = (w - l - r) / cols, sh = (h - t - b) / rows;
        ctx.strokeStyle = '#00ffaa';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (var i = 1; i < cols; i++) {
          ctx.moveTo(l + i * sw, t);
          ctx.lineTo(l + i * sw, h - b);
        }
        for (var j = 1; j < rows; j++) {
          ctx.moveTo(l, t + j * sh);
          ctx.lineTo(w - r, t + j * sh);
        }
        ctx.stroke();
      }
    } else if (state.mode === 'video_preview' && state.srcVideo) {
      if (dom.enableTrans.checked && state.transparencyReady) {
        var tempC = document.createElement('canvas');
        tempC.width = w;
        tempC.height = h;
        var tCtx = tempC.getContext('2d');
        tCtx.drawImage(state.srcVideo, 0, 0);
        applyTransparencyToCtx(tCtx, w, h);
        ctx.drawImage(tempC, 0, 0);
      } else {
        ctx.drawImage(state.srcVideo, 0, 0);
      }
    } else {
      var s = state.slices[state.selectedSliceIdx];
      if (s) {
        // Preview transparency (video/GIF-derived frames).
        if (!state.srcImg && dom.enableTrans.checked && state.transparencyReady) {
          var tempC2 = document.createElement('canvas');
          tempC2.width = s.canvas.width;
          tempC2.height = s.canvas.height;
          var tCtx2 = tempC2.getContext('2d');
          tCtx2.drawImage(s.canvas, 0, 0);
          applyTransparencyToCtx(tCtx2, tempC2.width, tempC2.height);
          ctx.drawImage(tempC2, 0, 0);
        } else {
          ctx.drawImage(s.canvas, 0, 0);
        }
        drawLayers(ctx, s.layers);
        if (state.mode === 'editor' && state.activeLayer) drawGizmo(state.activeLayer, '#3b82f6');
        if (state.mode === 'crop') {
          ctx.fillStyle = 'rgba(0,0,0,0.5)';
          ctx.fillRect(0, 0, w, h);
          var cr = state.cropRect;
          ctx.clearRect(cr.x, cr.y, cr.w, cr.h);
          ctx.drawImage(s.canvas, cr.x, cr.y, cr.w, cr.h, cr.x, cr.y, cr.w, cr.h);
          ctx.save();
          ctx.beginPath();
          ctx.rect(cr.x, cr.y, cr.w, cr.h);
          ctx.clip();
          drawLayers(ctx, s.layers);
          ctx.restore();
          drawGizmo(state.cropRect, '#ef4444', true);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Output size + export-time memory warning (never rejects input)
  // ------------------------------------------------------------------
  function outputSize() {
    var w = parseInt(dom.outW.value, 10), h = parseInt(dom.outH.value, 10);
    if (!(w > 0) && state.slices.length && state.slices[0]) w = state.slices[0].canvas.width;
    if (!(h > 0) && state.slices.length && state.slices[0]) h = state.slices[0].canvas.height;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  function exportMemCheck(count, w, h, factor) {
    var bytes = count * w * h * 4 * (factor || 3);
    if (bytes > EXPORT_MEM_LIMIT) {
      return confirm(t('gifEditorExportWarn', [Math.round(bytes / 1048576)]));
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Exports
  // ------------------------------------------------------------------
  function ensureGifJs() {
    return new Promise(function (resolve, reject) {
      if (window.GIF) { resolve(); return; }
      var s = document.createElement('script');
      s.src = GIF_VENDOR_URL;
      s.onload = function () {
        if (window.GIF) resolve();
        else reject(new Error('gif.js loaded but GIF is not defined'));
      };
      s.onerror = function () { reject(new Error('failed to load ' + GIF_VENDOR_URL)); };
      document.head.appendChild(s);
    });
  }

  function restoreExportBtn() {
    dom.exportBtn.innerHTML = t('gifEditorExportGif');
    dom.exportBtn.disabled = false;
  }

  function exportGif() {
    if (state.slices.length === 0) { alert(t('gifEditorAlertNoContent')); return; }
    var size = outputSize();
    var outW = size.w, outH = size.h;
    var isTransEnabled = dom.enableTrans.checked && state.transparencyReady;
    if (!exportMemCheck(state.slices.length, outW, outH, 3)) return;

    dom.exportBtn.innerHTML = t('gifEditorRendering');
    dom.exportBtn.disabled = true;
    showSpinner(t('gifEditorCompositing'));

    ensureGifJs().then(function () {
      setTimeout(function () {
        try {
          var gifOptions = {
            workers: 4,
            quality: parseInt(dom.quality.value, 10) || 10,
            width: outW,
            height: outH,
            workerScript: GIF_WORKER_URL
          };
          if (isTransEnabled) gifOptions.transparent = MATTE_NUM;
          var gif = new GIF(gifOptions);
          state.slices.forEach(function (s) {
            var f = composeFrame(s.canvas, s.layers, outW, outH, {
              applyTransparency: !state.srcImg,
              matte: isTransEnabled ? MATTE_HEX : null
            });
            gif.addFrame(f, { delay: s.delay });
          });
          var settled = false;
          var finish = function (blob) {
            if (settled) return;
            settled = true;
            var u = URL.createObjectURL(blob);
            if (resultUrl) URL.revokeObjectURL(resultUrl);
            resultUrl = u;
            dom.resultImg.src = u;
            dom.dlLink.href = u;
            dom.dlLink.download = 'Slice_' + Date.now() + '.gif';
            hideSpinner();
            dom.resultOverlay.classList.add('active');
            restoreExportBtn();
          };
          var fail = function () {
            if (settled) return;
            settled = true;
            hideSpinner();
            restoreExportBtn();
            alert(t('gifEditorRenderFail'));
          };
          gif.on('finished', finish);
          gif.on('abort', fail);
          gif.render();
          // Safety net: if the worker never responds (vendor/worker 404), fail.
          setTimeout(function () {
            if (!settled) fail();
          }, 60000);
        } catch (err) {
          console.error(err);
          hideSpinner();
          restoreExportBtn();
          alert(t('gifEditorRenderFail'));
        }
      }, 60);
    }).catch(function (err) {
      console.error(err);
      hideSpinner();
      restoreExportBtn();
      alert(t('gifEditorGifVendorPending'));
    });
  }

  function uploadFramePng(canvasSrc, name) {
    return new Promise(function (resolve, reject) {
      canvasSrc.toBlob(function (blob) {
        if (!blob) { reject(new Error('PNG encode failed')); return; }
        fetch('/api/gallery/edit/upload-temp?name=' + encodeURIComponent(name), {
          method: 'POST',
          body: blob
        }).then(function (r) {
          return r.json().catch(function () { return { error: 'HTTP ' + r.status }; });
        }).then(function (data) {
          if (data.error) reject(new Error(data.error));
          else resolve(data); // { tempPath }
        }).catch(reject);
      }, 'image/png');
    });
  }

  function exportZip() {
    if (state.slices.length === 0) { alert(t('gifEditorAlertNoContent')); return; }
    var size = outputSize();
    var outW = size.w, outH = size.h;
    if (!exportMemCheck(state.slices.length, outW, outH, 3)) return;
    showSpinner(t('gifEditorPackingFrames'));

    (async function () {
      var paths = [];
      try {
        var total = state.slices.length;
        for (var start = 0; start < total; start += 50) {
          var end = Math.min(start + 50, total);
          var chunk = [];
          for (var i = start; i < end; i++) {
            var name = 'frame_' + String(i + 1).padStart(3, '0') + '.png';
            var frame = composeFrame(state.slices[i].canvas, state.slices[i].layers, outW, outH);
            chunk.push({ name: name, frame: frame });
          }
          var results = await Promise.all(chunk.map(function (item) {
            return uploadFramePng(item.frame, item.name);
          }));
          for (var j = 0; j < results.length; j++) {
            if (results[j].error) throw new Error(results[j].error);
            paths.push(results[j].tempPath);
          }
          dom.spinnerText.innerText = t('gifEditorPackingFrames') + ' (' + end + '/' + total + ')';
        }
        var zip = await apiPost('/gallery/edit/zip-outputs', { paths: paths, cleanUp: true });
        if (zip.error) throw new Error(zip.error);
        var link = document.createElement('a');
        link.href = zip.outputURL;
        link.download = zip.zipName || ('Frames_' + Date.now() + '.zip');
        document.body.appendChild(link);
        link.click();
        link.remove();
        hideSpinner();
        if (typeof toast === 'function') toast(t('gifEditorZipDone'), 'success');
      } catch (err) {
        console.error(err);
        hideSpinner();
        alert(t('gifEditorZipPackFail', [err.message]));
      }
    })();
  }

  function exportSprite() {
    if (state.slices.length === 0) { alert(t('gifEditorAlertNoContent')); return; }
    var rows = parseInt(dom.spriteRows.value, 10) || 1;
    var cols = parseInt(dom.spriteCols.value, 10) || 1;
    var size = outputSize();
    var itemW = size.w, itemH = size.h;
    if (rows < 1 || cols < 1) { alert(t('gifEditorAlertRowsCols')); return; }
    if (!exportMemCheck(rows * cols, itemW, itemH, 1)) return;

    showSpinner(t('gifEditorGeneratingSheet'));
    setTimeout(function () {
      try {
        var sheet = document.createElement('canvas');
        sheet.width = cols * itemW;
        sheet.height = rows * itemH;
        var sctx = sheet.getContext('2d');
        for (var r = 0; r < rows; r++) {
          for (var c = 0; c < cols; c++) {
            var index = r * cols + c;
            if (index >= state.slices.length) continue;
            var frame = composeFrame(state.slices[index].canvas, state.slices[index].layers, itemW, itemH);
            sctx.drawImage(frame, c * itemW, r * itemH);
          }
        }
        var url = sheet.toDataURL('image/png');
        var link = document.createElement('a');
        link.download = 'SpriteSheet_' + Date.now() + '.png';
        link.href = url;
        document.body.appendChild(link);
        link.click();
        link.remove();
        hideSpinner();
      } catch (err) {
        console.error(err);
        hideSpinner();
        alert(err.message);
      }
    }, 50);
  }

  // ------------------------------------------------------------------
  // Batch frame delete / keep
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

  function deleteRange() {
    var range = getBatchRange();
    if (!range) return;
    if (!confirm(t('gifEditorConfirmDeleteRange', [range.start + 1, range.end + 1]))) return;
    if (range.start >= state.slices.length) return;
    state.slices.splice(range.start, range.end - range.start + 1);
    state.selectedSliceIdx = Math.max(0, state.slices.length - 1);
    renderTimeline();
    if (state.slices.length > 0) selectSlice(0);
    else { state.mode = 'source'; draw(); }
  }

  function keepRange() {
    var range = getBatchRange();
    if (!range) return;
    if (!confirm(t('gifEditorConfirmKeepRange', [range.start + 1, range.end + 1]))) return;
    var newSlices = state.slices.slice(range.start, range.end + 1);
    if (newSlices.length === 0) {
      alert(t('gifEditorAlertRangeEmpty'));
      return;
    }
    state.slices = newSlices;
    state.selectedSliceIdx = 0;
    renderTimeline();
    selectSlice(0);
  }

  // ------------------------------------------------------------------
  // Keyboard navigation (capture-phase so Escape never triggers the app's
  // global shutdown-server shortcut while the GIF page consumes it)
  // ------------------------------------------------------------------
  function cancelPickColor() {
    state.pickColorMode = false;
    dom.canvasWrapper.style.cursor = 'default';
    dom.stageOverlayText.innerText = t('gifEditorPickColorCancelled');
    dom.pickColorBtn.classList.remove('active');
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (state.pickColorMode) {
        e.stopPropagation();
        cancelPickColor();
        return;
      }
      if (dom.resultOverlay && dom.resultOverlay.classList.contains('active')) {
        e.stopPropagation();
        closeResultModal();
        return;
      }
      return;
    }
    if (state.slices.length === 0) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    var newIdx = state.selectedSliceIdx;
    var total = state.slices.length;
    var timeline = dom.timeline;
    var getPageSize = function () {
      return Math.floor(timeline.clientWidth / TL_ITEM_PITCH) || 1;
    };
    switch (e.key) {
      case 'ArrowLeft': newIdx--; break;
      case 'ArrowRight': newIdx++; break;
      case 'Home': newIdx = 0; break;
      case 'End': newIdx = total - 1; break;
      case 'PageUp': newIdx -= getPageSize(); break;
      case 'PageDown': newIdx += getPageSize(); break;
      default: return;
    }
    if (newIdx < 0) newIdx = 0;
    if (newIdx >= total) newIdx = total - 1;
    if (newIdx !== state.selectedSliceIdx) {
      e.preventDefault();
      selectSlice(newIdx);
    }
  }

  // ------------------------------------------------------------------
  // Event binding
  // ------------------------------------------------------------------
  function bindEvents() {
    dom.dropZone.addEventListener('click', onDropZoneClick);
    dom.fileInput.addEventListener('change', function (e) { processFile(e.target.files[0]); });
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    document.addEventListener('paste', onPaste);

    // Edge crop sliders
    var edgeSync = function (sliderName, numName) {
      var slider = dom[sliderName], num = dom[numName];
      slider.addEventListener('input', function () { num.value = slider.value; draw(); });
      num.addEventListener('input', function () { slider.value = num.value; draw(); });
    };
    edgeSync('sliderT', 'cropT');
    edgeSync('sliderB', 'cropB');
    edgeSync('sliderL', 'cropL');
    edgeSync('sliderR', 'cropR');
    dom.rows.addEventListener('input', draw);
    dom.cols.addEventListener('input', draw);

    // Video FPS sync
    dom.videoFps.addEventListener('input', function () {
      var v = parseInt(dom.videoFps.value, 10);
      if (v > 60) v = 60;
      if (v < 1) v = 1;
      dom.videoFpsSlider.value = v || 1;
    });
    dom.videoFpsSlider.addEventListener('input', function () {
      dom.videoFps.value = dom.videoFpsSlider.value;
    });

    // Quality sync
    dom.quality.addEventListener('input', function () {
      var v = parseInt(dom.quality.value, 10);
      if (v > 10) v = 10;
      if (v < 1) v = 1;
      dom.qualitySlider.value = v || 10;
    });
    dom.qualitySlider.addEventListener('input', function () {
      dom.quality.value = dom.qualitySlider.value;
    });

    // Output scale
    dom.outScaleSlider.addEventListener('input', function (e) {
      var s = parseFloat(e.target.value);
      dom.outScaleVal.innerText = s.toFixed(1) + 'x';
      var baseW, baseH;
      if (state.slices.length > 0 && state.slices[0]) {
        baseW = state.slices[0].canvas.width;
        baseH = state.slices[0].canvas.height;
      } else if (state.processedImg) {
        baseW = state.processedImg.width;
        baseH = state.processedImg.height;
      } else if (state.srcVideo) {
        baseW = state.srcVideo.videoWidth;
        baseH = state.srcVideo.videoHeight;
      }
      if (baseW && baseH) {
        dom.outW.value = Math.round(baseW * s);
        dom.outH.value = Math.round(baseH * s);
      }
    });

    dom.batchDelayBtn.addEventListener('click', function () {
      var val = parseInt(dom.batchDelayInput.value, 10);
      if (isNaN(val) || val < 0) { alert(t('gifEditorAlertDelayInvalid')); return; }
      if (state.slices.length === 0) { alert(t('gifEditorAlertNoFrames')); return; }
      state.slices.forEach(function (s) { s.delay = val; });
      // Refresh only the delay inputs currently rendered (windowed DOM).
      var inputs = dom.timeline.querySelectorAll('.gif-delay-input');
      for (var i = 0; i < inputs.length; i++) inputs[i].value = val;
    });

    dom.sliceBtn.addEventListener('click', runSlice);
    dom.extractVideoBtn.addEventListener('click', extractFrames);

    // Global crop
    dom.startGlobalCropBtn.addEventListener('click', startGlobalCrop);
    dom.cancelCropBtn.addEventListener('click', cancelCrop);
    dom.applyCropBtn.addEventListener('click', applyCrop);
    setupCropSliders();

    // Transparency
    dom.enableTrans.addEventListener('change', toggleTransPanel);
    dom.keyColor.addEventListener('input', transParamChanged);
    dom.fuzziness.addEventListener('input', transParamChanged);
    dom.pickColorBtn.addEventListener('click', pickColorClick);
    dom.disableTransBtn.addEventListener('click', function () { dom.enableTrans.click(); });

    // Stage pointer
    dom.stage.addEventListener('mousedown', handlePointerDown);
    dom.stage.addEventListener('touchstart', handlePointerDown, { passive: false });
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchend', onPointerUp);

    // Zoom
    dom.zoomInBtn.addEventListener('click', function () { state.scale *= 1.2; updateTransform(); });
    dom.zoomOutBtn.addEventListener('click', function () { state.scale *= 0.8; updateTransform(); });
    dom.resetViewBtn.addEventListener('click', resetView);

    // Layers
    dom.addTextBtn.addEventListener('click', addText);
    dom.addImageInput.addEventListener('change', function (e) {
      addImageFromFile(e.target.files[0]);
      e.target.value = '';
    });
    dom.btnBold.addEventListener('click', function () { toggleStyle('bold', 'btnBold'); });
    dom.btnItalic.addEventListener('click', function () { toggleStyle('italic', 'btnItalic'); });
    dom.btnUnderline.addEventListener('click', function () { toggleStyle('underline', 'btnUnderline'); });
    dom.addTextColor.addEventListener('input', function (e) {
      if (state.activeLayer && state.activeLayer.type === 'text') {
        state.activeLayer.color = e.target.value;
        draw();
      }
    });
    var scopeRadios = document.querySelectorAll('input[name="gif-layer-scope"]');
    for (var i = 0; i < scopeRadios.length; i++) {
      scopeRadios[i].addEventListener('change', function (e) {
        dom.rangeInput.style.display = e.target.value === 'range' ? 'block' : 'none';
      });
    }
    dom.syncLayerBtn.addEventListener('click', syncLayer);

    // Exports
    dom.exportBtn.addEventListener('click', exportGif);
    dom.exportZipBtn.addEventListener('click', exportZip);
    dom.exportPngBtn.addEventListener('click', exportSprite);

    // Batch delete
    dom.btnDelRange.addEventListener('click', deleteRange);
    dom.btnKeepRange.addEventListener('click', keepRange);

    // Result modal
    dom.resultClose.addEventListener('click', closeResultModal);
    dom.reloadBtn.addEventListener('click', function () { location.reload(); });

    // Timeline: per-frame interactions are delegated on the container so the
    // windowed DOM never needs per-node listeners.
    dom.timeline.addEventListener('click', onTimelineClick);
    dom.timeline.addEventListener('change', onTimelineDelayChange);
    dom.timeline.addEventListener('dragstart', onTimelineDragStart);
    dom.timeline.addEventListener('dragover', onTimelineDragOver);
    dom.timeline.addEventListener('dragenter', onTimelineDragEnter);
    dom.timeline.addEventListener('dragleave', onTimelineDragLeave);
    dom.timeline.addEventListener('drop', onTimelineDrop);
    dom.timeline.addEventListener('dragend', onTimelineDragEnd);
    dom.timeline.addEventListener('touchstart', onTimelineTouchStart);
    dom.timeline.addEventListener('touchmove', onTimelineTouchMove, { passive: false });
    dom.timeline.addEventListener('touchend', onTimelineTouchEnd);
    dom.timeline.addEventListener('scroll', onTimelineScroll, { passive: true });
    window.addEventListener('resize', onWindowResize);

    // Keyboard (capture phase: Escape interception + timeline navigation)
    document.addEventListener('keydown', onKeyDown, true);
  }

  // ------------------------------------------------------------------
  // Page template (ported from source body, all ids/classes gif-prefixed)
  // ------------------------------------------------------------------
  function pageTemplate() {
    return '' +
      '<div class="gif-app">' +
      '  <div class="gif-header">' +
      '    <h1 class="gif-title">' + t('gifEditorAppTitle') + '<span class="gif-title-sub">' + t('gifEditorAppTitleSub') + '</span></h1>' +
      '    <button class="gif-btn gif-reload-btn" id="gif-reload-btn" title="' + t('gifEditorReload') + '">↺</button>' +
      '  </div>' +
      '  <div class="gif-workspace">' +
      '    <aside class="gif-sidebar">' +
      '      <div id="gif-panel-step1">' +
      '        <div class="gif-group-title">1. ' + t('gifEditorStep1') + '</div>' +
      '        <div class="gif-drop-zone" id="gif-drop-zone">' +
      '          <span class="gif-drop-hint">' + t('gifEditorDropHint') + '</span>' +
      '          <input type="file" id="gif-file-input" accept="image/png,image/jpeg,image/gif,video/*" class="gif-hidden">' +
      '        </div>' +
      '        <div id="gif-transparency-wrapper">' +
      '          <label class="gif-check-label"><input type="checkbox" id="gif-enable-trans"> ' + t('gifEditorEnableTrans') + '</label>' +
      '          <div id="gif-trans-panel" class="gif-trans-panel">' +
      '            <div class="gif-control-row">' +
      '              <input type="color" id="gif-key-color" value="#ffffff" class="gif-key-color-input">' +
      '              <button class="gif-btn gif-btn-primary gif-flex-1" id="gif-pick-color-btn" title="' + t('gifEditorPickColorTitle') + '">' + t('gifEditorPickColor') + '</button>' +
      '            </div>' +
      '            <div class="gif-trans-hint">' + t('gifEditorPickColorHint') + '</div>' +
      '            <div class="gif-control-row">' +
      '              <span class="gif-muted-label">' + t('gifEditorFuzziness') + '</span>' +
      '              <input type="range" id="gif-fuzziness" min="0" max="100" value="15" title="' + t('gifEditorFuzzinessTitle') + '" class="gif-flex-1">' +
      '            </div>' +
      '            <button class="gif-btn gif-btn-danger gif-full-width gif-mt-sm" id="gif-disable-trans-btn">' + t('gifEditorDisableTrans') + '</button>' +
      '          </div>' +
      '        </div>' +
      '        <div id="gif-image-tools">' +
      '          <div class="gif-group-title gif-mt">' + t('gifEditorEdgeFix') + '</div>' +
      '          <div class="gif-range-wrap"><span class="gif-axis-label">' + t('gifEditorTop') + '</span><input type="range" id="gif-slider-t" value="0"><input type="number" id="gif-crop-t" value="0" class="gif-crop-num"></div>' +
      '          <div class="gif-range-wrap"><span class="gif-axis-label">' + t('gifEditorBottom') + '</span><input type="range" id="gif-slider-b" value="0"><input type="number" id="gif-crop-b" value="0" class="gif-crop-num"></div>' +
      '          <div class="gif-range-wrap"><span class="gif-axis-label">' + t('gifEditorLeft') + '</span><input type="range" id="gif-slider-l" value="0"><input type="number" id="gif-crop-l" value="0" class="gif-crop-num"></div>' +
      '          <div class="gif-range-wrap"><span class="gif-axis-label">' + t('gifEditorRight') + '</span><input type="range" id="gif-slider-r" value="0"><input type="number" id="gif-crop-r" value="0" class="gif-crop-num"></div>' +
      '          <div class="gif-group-title gif-mt">' + t('gifEditorGridSlice') + '</div>' +
      '          <div class="gif-control-row">' +
      '            <input type="number" id="gif-rows" value="3" min="1" placeholder="' + t('gifEditorRows') + '">' +
      '            <input type="number" id="gif-cols" value="3" min="1" placeholder="' + t('gifEditorCols') + '">' +
      '          </div>' +
      '          <button class="gif-btn gif-btn-primary gif-full-width gif-mt-sm" id="gif-slice-btn">' + t('gifEditorSliceBtn') + '</button>' +
      '        </div>' +
      '        <div id="gif-video-tools" class="gif-hidden">' +
      '          <div class="gif-group-title">' + t('gifEditorVideoExtract') + '</div>' +
      '          <div class="gif-control-row">' +
      '            <div class="gif-flex-1">' +
      '              <label class="gif-label">' + t('gifEditorFps') + '</label>' +
      '              <input type="number" id="gif-video-fps" value="12" min="1" max="60" step="1" placeholder="12">' +
      '            </div>' +
      '            <button class="gif-btn gif-btn-primary gif-flex-1 gif-extract-btn" id="gif-extract-video-btn">' + t('gifEditorExtractBtn') + '</button>' +
      '          </div>' +
      '          <input type="range" id="gif-video-fps-slider" min="1" max="60" value="12" step="1" class="gif-full-width">' +
      '          <div class="gif-muted-hint">' + t('gifEditorFpsHint') + '</div>' +
      '        </div>' +
      '      </div>' +
      '      <div id="gif-panel-step2" class="gif-edit-blocked gif-panel-sep">' +
      '        <div class="gif-group-title">' + t('gifEditorStep2') + ' <span id="gif-frame-indicator" class="gif-frame-indicator"></span></div>' +
      '        <button class="gif-btn gif-btn-accent gif-full-width gif-mb" id="gif-start-global-crop-btn">' + t('gifEditorGlobalCrop') + '</button>' +
      '        <div id="gif-crop-panel" class="gif-crop-panel">' +
      '          <div class="gif-crop-title">' + t('gifEditorCropAdjust') + '</div>' +
      '          <div class="gif-range-wrap"><span class="gif-axis-label">X</span><input type="range" id="gif-crop-slide-x"><input type="number" id="gif-crop-num-x" class="gif-crop-num"></div>' +
      '          <div class="gif-range-wrap"><span class="gif-axis-label">Y</span><input type="range" id="gif-crop-slide-y"><input type="number" id="gif-crop-num-y" class="gif-crop-num"></div>' +
      '          <div class="gif-range-wrap"><span class="gif-axis-label">W</span><input type="range" id="gif-crop-slide-w"><input type="number" id="gif-crop-num-w" class="gif-crop-num"></div>' +
      '          <div class="gif-range-wrap"><span class="gif-axis-label">H</span><input type="range" id="gif-crop-slide-h"><input type="number" id="gif-crop-num-h" class="gif-crop-num"></div>' +
      '          <div class="gif-control-row gif-mt">' +
      '            <button class="gif-btn gif-btn-danger gif-flex-1" id="gif-cancel-crop-btn">' + t('gifEditorCancel') + '</button>' +
      '            <button class="gif-btn gif-btn-primary gif-flex-1" id="gif-apply-crop-btn">' + t('gifEditorApplyCrop') + '</button>' +
      '          </div>' +
      '        </div>' +
      '        <div class="gif-scope-box">' +
      '          <span>' + t('gifEditorScope') + '</span>' +
      '          <label class="gif-radio-label"><input type="radio" name="gif-layer-scope" value="current" checked> ' + t('gifEditorScopeCurrent') + '</label>' +
      '          <label class="gif-radio-label"><input type="radio" name="gif-layer-scope" value="all"> ' + t('gifEditorScopeAll') + '</label>' +
      '          <label class="gif-radio-label"><input type="radio" name="gif-layer-scope" value="range"> ' + t('gifEditorScopeRange') + '</label>' +
      '          <input type="text" id="gif-range-input" placeholder="' + t('gifEditorRangePlaceholder') + '" class="gif-range-input">' +
      '        </div>' +
      '        <div class="gif-control-row">' +
      '          <input type="text" id="gif-add-text-input" placeholder="' + t('gifEditorAddTextPlaceholder') + '">' +
      '          <button class="gif-btn gif-nowrap" id="gif-add-text-btn">' + t('gifEditorAddText') + '</button>' +
      '        </div>' +
      '        <div class="gif-style-toolbar">' +
      '          <input type="color" id="gif-add-text-color" value="#ffffff" class="gif-style-color">' +
      '          <button class="gif-style-btn" id="gif-btn-bold">B</button>' +
      '          <button class="gif-style-btn" id="gif-btn-italic">I</button>' +
      '          <button class="gif-style-btn" id="gif-btn-underline">U</button>' +
      '          <label class="gif-btn gif-style-image-label">' + t('gifEditorAddImage') +
      '            <input type="file" id="gif-add-image-input" accept="image/*" class="gif-hidden">' +
      '          </label>' +
      '        </div>' +
      '        <div id="gif-selected-layer-tools" class="gif-selected-layer-tools">' +
      '          <button class="gif-btn gif-btn-accent gif-full-width gif-sm-btn" id="gif-sync-layer-btn">' + t('gifEditorSyncLayer') + '</button>' +
      '        </div>' +
      '        <div class="gif-group-title gif-mt">' + t('gifEditorLayerList') + '</div>' +
      '        <div id="gif-layer-list" class="gif-layer-list"></div>' +
      '      </div>' +
      '      <div class="gif-output-sep">' +
      '        <div class="gif-group-title">3. ' + t('gifEditorStep3') + '</div>' +
      '        <div class="gif-control-row gif-mb">' +
      '          <input type="number" id="gif-batch-delay-input" placeholder="' + t('gifEditorBatchDelayPlaceholder') + '" value="100" title="' + t('gifEditorDelayTitle') + '">' +
      '          <button class="gif-btn gif-nowrap" id="gif-batch-delay-btn">' + t('gifEditorBatchDelayBtn') + '</button>' +
      '        </div>' +
      '        <div class="gif-control-row">' +
      '          <input type="number" id="gif-out-w" placeholder="' + t('gifEditorWidth') + '" value="300">' +
      '          <span class="gif-muted-label">x</span>' +
      '          <input type="number" id="gif-out-h" placeholder="' + t('gifEditorHeight') + '" value="300">' +
      '        </div>' +
      '        <div class="gif-range-wrap">' +
      '          <span class="gif-scale-label">' + t('gifEditorScale') + '</span>' +
      '          <input type="range" id="gif-out-scale-slider" min="0.1" max="2.0" step="0.1" value="1.0" class="gif-flex-1">' +
      '          <span id="gif-out-scale-val" class="gif-scale-val">1.0x</span>' +
      '        </div>' +
      '        <div class="gif-group-title gif-quality-title">' + t('gifEditorQuality') + ' <span class="gif-quality-range">' + t('gifEditorQualityRange') + '</span></div>' +
      '        <div class="gif-range-wrap">' +
      '          <input type="range" id="gif-quality-slider" min="1" max="10" value="10" step="1" class="gif-flex-1">' +
      '          <input type="number" id="gif-quality" value="10" min="1" max="10" class="gif-crop-num" title="' + t('gifEditorQualityTitle') + '">' +
      '        </div>' +
      '        <button class="gif-btn gif-btn-primary gif-full-width" id="gif-export-btn" disabled>' + t('gifEditorExportGif') + '</button>' +
      '        <button class="gif-btn gif-btn-accent gif-full-width gif-mt" id="gif-export-zip-btn">' + t('gifEditorExportZip') + '</button>' +
      '        <div class="gif-output-sep-inner">' +
      '          <div class="gif-group-title">' + t('gifEditorBatchDelete') + '</div>' +
      '          <div class="gif-control-row">' +
      '            <input type="number" id="gif-del-start" placeholder="' + t('gifEditorDelStart') + '" min="1">' +
      '            <span class="gif-muted-label">-</span>' +
      '            <input type="number" id="gif-del-end" placeholder="' + t('gifEditorDelEnd') + '" min="1">' +
      '          </div>' +
      '          <div class="gif-control-row">' +
      '            <button class="gif-btn gif-btn-danger gif-flex-1 gif-sm-btn" id="gif-btn-del-range">' + t('gifEditorDelRange') + '</button>' +
      '            <button class="gif-btn gif-btn-accent gif-flex-1 gif-sm-btn" id="gif-btn-keep-range">' + t('gifEditorKeepRange') + '</button>' +
      '          </div>' +
      '        </div>' +
      '        <div class="gif-output-sep-inner">' +
      '          <div class="gif-group-title">' + t('gifEditorSpriteSheet') + '</div>' +
      '          <div class="gif-control-row">' +
      '            <input type="number" id="gif-sprite-rows" placeholder="' + t('gifEditorSpriteRows') + '" value="1" min="1">' +
      '            <span class="gif-muted-label">x</span>' +
      '            <input type="number" id="gif-sprite-cols" placeholder="' + t('gifEditorSpriteCols') + '" value="5" min="1">' +
      '          </div>' +
      '          <button class="gif-btn gif-btn-accent gif-full-width" id="gif-export-png-btn">' + t('gifEditorExportPng') + '</button>' +
      '        </div>' +
      '      </div>' +
      '    </aside>' +
      '    <div class="gif-stage-area" id="gif-stage-container">' +
      '      <div class="gif-canvas-wrapper" id="gif-canvas-wrapper">' +
      '        <canvas id="gif-preview-canvas"></canvas>' +
      '      </div>' +
      '      <div class="gif-stage-controls">' +
      '        <button class="gif-icon-btn" id="gif-zoom-out-btn">-</button>' +
      '        <button class="gif-icon-btn" id="gif-reset-view-btn">⟲</button>' +
      '        <button class="gif-icon-btn" id="gif-zoom-in-btn">+</button>' +
      '      </div>' +
      '      <div id="gif-stage-overlay-text" class="gif-stage-overlay-text">' + t('gifEditorStageIdle') + '</div>' +
      '    </div>' +
      '    <div class="gif-timeline-area" id="gif-timeline"></div>' +
      '  </div>' +
      '  <div class="gif-result-overlay" id="gif-result-overlay">' +
      '    <div class="gif-result-box">' +
      '      <h2 class="gif-result-title">' + t('gifEditorResultTitle') + '</h2>' +
      '      <img id="gif-result-img" class="gif-result-img" alt="">' +
      '      <div class="gif-result-actions">' +
      '        <a id="gif-dl-link" class="gif-btn gif-btn-primary" download>' + t('gifEditorDownloadGif') + '</a>' +
      '        <button class="gif-btn" id="gif-result-close">' + t('gifEditorClose') + '</button>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<div class="gif-spinner-overlay" id="gif-loading-spinner">' +
      '  <div class="gif-spinner"></div>' +
      '  <div id="gif-spinner-text">' + t('gifEditorProcessing') + '</div>' +
      '</div>';
  }

  return {
    render: render,
    cleanup: cleanup
  };
})();

function renderGifEditor(container) {
  return GifEditor.render(container);
}
function cleanupGifEditor() {
  GifEditor.cleanup();
}
