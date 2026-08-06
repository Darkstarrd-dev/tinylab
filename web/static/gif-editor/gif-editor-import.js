// web/static/gif-editor-import.js
// GIF / Image / Video Import & Modal Handling for TinyRouter GIF Editor

(function () {
  'use strict';

  var core = window.GifEditorCore;
  if (typeof window.changeStepper !== 'function') {
    window.changeStepper = function (id, delta) {
      var input = document.getElementById(id);
      if (!input) return;
      var curVal = parseInt(input.value, 10);
      if (isNaN(curVal)) curVal = 0;
      var newVal = curVal + delta;
      var min = input.hasAttribute('min') ? parseInt(input.getAttribute('min'), 10) : null;
      var max = input.hasAttribute('max') ? parseInt(input.getAttribute('max'), 10) : null;
      if (min !== null && !isNaN(min) && newVal < min) newVal = min;
      if (max !== null && !isNaN(max) && newVal > max) newVal = max;
      input.value = newVal;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
  }

  function t(key, fallback) {
    if (typeof window.t === 'function') {
      var res = window.t(key);
      if (res && res !== key) return res;
    }
    return fallback || key;
  }

  var draft = null;
  var previewDebounceTimer = null;
  var commitGeneration = 0;   // bumped on cancel/open/cleanup; stale commits abort silently

  // ------------------------------------------------------------------
  // Helper functions
  // ------------------------------------------------------------------

  function getFileType(file) {
    if (!file) return null;
    var name = (file.name || '').toLowerCase();
    var type = (file.type || '').toLowerCase();

    if (type === 'image/gif' || name.endsWith('.gif')) {
      return 'gif';
    }
    if (type.startsWith('video/') || /\.(mp4|webm|ogv|mov|avi|mkv)$/i.test(name)) {
      return 'video';
    }
    if (type.startsWith('image/') || /\.(png|jpe?g|webp|bmp)$/i.test(name)) {
      return 'image';
    }
    return null;
  }

  function seekTo(video, sec, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!video) return reject(new Error('No video element'));
      timeoutMs = timeoutMs || 5000;
      var timer = null;

      function cleanup() {
        if (timer) clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      }

      function onSeeked() {
        cleanup();
        resolve();
      }

      function onError(e) {
        cleanup();
        reject(e || new Error('Video seek error'));
      }

      timer = setTimeout(function () {
        cleanup();
        reject(new Error('Video seek timeout at ' + sec + 's'));
      }, timeoutMs);

      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);

      try {
        video.currentTime = sec;
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  // ------------------------------------------------------------------
  // Import Entry & Metadata Reading
  // ------------------------------------------------------------------

  function openFromFile(file) {
    if (!file) return;
    if (file.size > core.constants.MAX_FILE_BYTES) {
      alert(t('gifEditorAlertFileTooLarge', 'File size exceeds 200MB limit.'));
      return;
    }

    var kind = getFileType(file);
    if (!kind) {
      alert(t('gifEditorAlertUnsupportedType', 'Unsupported file type. Please select an image, GIF, or video.'));
      return;
    }

    // Abort any previous draft/commit (generation bump makes stale async work a no-op).
    cancelDraft();

    var objectUrl = URL.createObjectURL(file);
    draft = {
      file: file,
      kind: kind,
      objectUrl: objectUrl,
      sourceWidth: 0,
      sourceHeight: 0,
      sourceDurationMs: 0,
      sourceFps: 30,

      scalePercent: 100,
      fps: 30,
      fpsChanged: false,      // GIF keeps original delays until the user edits FPS
      startMs: 0,
      endMs: 0,

      image: null,
      video: null,
      gifFrames: null,        // [{ canvas, delay, startMs, endMs, disposal }]
      gifTotalDurationMs: 0,
      previewFrameIndex: 0,
      previewTimer: null,
      previewGeneration: 0
    };
    core.state.importDraft = draft;

    if (kind === 'image') {
      readImageMetadata();
    } else if (kind === 'gif') {
      readGifMetadata();
    } else if (kind === 'video') {
      readVideoMetadata();
    }
  }

  function readImageMetadata() {
    var img = new Image();
    img.onload = function () {
      if (!draft || draft.objectUrl !== img.src) return;
      draft.image = img;
      draft.sourceWidth = img.naturalWidth || img.width;
      draft.sourceHeight = img.naturalHeight || img.height;
      draft.sourceDurationMs = 0;
      draft.endMs = 0;
      showImportModal();
    };
    img.onerror = function () {
      alert(t('gifEditorAlertLoadImageFailed', 'Failed to load image metadata.'));
      cancelDraft();
    };
    img.src = draft.objectUrl;
  }

  // Composite every GIF frame into a full logical-screen canvas.
  //
  // Disposal semantics (applied to the PREVIOUS frame before the current
  // patch is drawn):
  //   0/1 = leave the canvas as-is
  //   2   = clear the disposed frame's rect (restore background)
  //   3   = restore the canvas state from before the disposed frame was drawn
  // The pre-draw snapshot is taken for EVERY frame so disposal=3 of the
  // following frame can restore it.
  //
  // gifuct-js already reports `delay` in milliseconds — no conversion.
  function compositeGifFrames(frames, width, height) {
    var composited = [];
    var totalMs = 0;

    var fullCanvas = document.createElement('canvas');
    fullCanvas.width = width;
    fullCanvas.height = height;
    var fullCtx = fullCanvas.getContext('2d');
    var prevStateCanvas = null;

    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var delay = f.delay || 100; // ms already (gifuct-js)
      if (!(delay > 0)) delay = 100;

      // 1) Apply the previous frame's disposal.
      if (i > 0) {
        var prev = frames[i - 1];
        if (prev.disposalType === 2) {
          fullCtx.clearRect(prev.dims.left, prev.dims.top, prev.dims.width, prev.dims.height);
        } else if (prev.disposalType === 3 && prevStateCanvas) {
          fullCtx.clearRect(0, 0, width, height);
          fullCtx.drawImage(prevStateCanvas, 0, 0);
        }
      }

      // 2) Snapshot the pre-draw canvas (needed if THIS frame is disposal 3).
      prevStateCanvas = document.createElement('canvas');
      prevStateCanvas.width = width;
      prevStateCanvas.height = height;
      prevStateCanvas.getContext('2d').drawImage(fullCanvas, 0, 0);

      // 3) Draw this frame's patch at its offset.
      var patchCanvas = document.createElement('canvas');
      patchCanvas.width = f.dims.width;
      patchCanvas.height = f.dims.height;
      var pCtx = patchCanvas.getContext('2d');
      var imgData = pCtx.createImageData(f.dims.width, f.dims.height);
      imgData.data.set(f.patch);
      pCtx.putImageData(imgData, 0, 0);
      fullCtx.drawImage(patchCanvas, f.dims.left, f.dims.top);

      // 4) Capture the fully composed frame.
      var snapCanvas = document.createElement('canvas');
      snapCanvas.width = width;
      snapCanvas.height = height;
      snapCanvas.getContext('2d').drawImage(fullCanvas, 0, 0);

      var startMs = totalMs;
      totalMs += delay;

      composited.push({
        canvas: snapCanvas,
        delay: delay,
        startMs: startMs,
        endMs: totalMs,
        disposal: f.disposalType
      });
    }

    return composited;
  }

  function readGifMetadata() {
    var reader = new FileReader();
    reader.onload = function (e) {
      if (!draft) return;
      try {
        var buffer = e.target.result;
        var gif = parseGIF(buffer);
        var frames = decompressFrames(gif, true);
        if (!frames || !frames.length) {
          throw new Error('No frames in GIF');
        }

        var header = gif.lsd || {};
        var width = header.width || frames[0].dims.width;
        var height = header.height || frames[0].dims.height;

        var composited = compositeGifFrames(frames, width, height);
        var totalMs = composited.length ? composited[composited.length - 1].endMs : 0;

        draft.gifFrames = composited;
        draft.sourceWidth = width;
        draft.sourceHeight = height;
        draft.sourceDurationMs = totalMs;
        draft.gifTotalDurationMs = totalMs;
        draft.startMs = 0;
        draft.endMs = totalMs;

        var avgDelay = composited.length ? totalMs / composited.length : 100;
        var avgFps = Math.round(1000 / avgDelay);
        draft.sourceFps = Math.max(1, Math.min(60, avgFps || 10));
        draft.fps = draft.sourceFps;

        showImportModal();
      } catch (err) {
        console.error('Failed to parse GIF:', err);
        alert(t('gifEditorAlertParseGifFailed', 'Failed to parse GIF file.'));
        cancelDraft();
      }
    };
    reader.onerror = function () {
      alert(t('gifEditorAlertReadGifFailed', 'Failed to read GIF file.'));
      cancelDraft();
    };
    reader.readAsArrayBuffer(draft.file);
  }

  function readVideoMetadata() {
    var video = document.createElement('video');
    video.preload = 'metadata';
    video.src = draft.objectUrl;
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = function () {
      if (!draft || draft.objectUrl !== video.src) return;
      var duration = video.duration;
      if (!duration || isNaN(duration) || duration === Infinity || duration <= 0) {
        alert(t('gifEditorAlertVideoUnsupported', 'Video duration could not be determined.'));
        cancelDraft();
        return;
      }

      draft.video = video;
      draft.sourceWidth = video.videoWidth;
      draft.sourceHeight = video.videoHeight;
      draft.sourceDurationMs = Math.round(duration * 1000);
      draft.startMs = 0;
      draft.endMs = draft.sourceDurationMs;
      draft.sourceFps = 30;
      draft.fps = 30;

      showImportModal();
    };

    video.onerror = function () {
      alert(t('gifEditorAlertVideoLoadFailed', 'Failed to load video file.'));
      cancelDraft();
    };
  }

  // ------------------------------------------------------------------
  // Import Modal UI & Render
  // ------------------------------------------------------------------

  function showImportModal() {
    if (!draft) return;

    var overlay = document.getElementById('modal-overlay');
    if (!overlay) return;

    var title = '';
    if (draft.kind === 'video') title = t('gifImportModalTitleVideo', 'Import Frames from Video');
    else if (draft.kind === 'gif') title = t('gifImportModalTitleGif', 'Import Frames from GIF');
    else title = t('gifImportModalTitleImage', 'Import Image');

    var isSingleFrame = (draft.kind === 'image');
    var maxMs = Math.max(1, draft.sourceDurationMs);

    var html = '' +
      '<div class="modal gif-import-modal">' +
      '  <div class="modal-title">' + title + '</div>' +
      '  <div class="modal-body gif-import-modal-body">' +
      '    <div class="gif-import-preview-wrapper">' +
      '      <canvas id="gif-import-preview-canvas" class="gif-import-preview-canvas"></canvas>' +
      '    </div>' +
      '    <div class="gif-import-form">' +
      '      <div class="gif-import-row">' +
      '        <span class="gif-import-label">' + t('gifImportSourceResolution', 'Source Resolution:') + '</span>' +
      '        <span class="gif-import-value" id="gif-import-source-res">' + draft.sourceWidth + ' × ' + draft.sourceHeight + '</span>' +
      '      </div>' +

      '      <div class="gif-import-col">' +
      '        <div class="gif-import-label-row">' +
      '          <label for="gif-import-scale" class="gif-import-label">Scale</label>' +
      '          <span class="gif-import-value" id="gif-import-scale-display">' + draft.scalePercent + '%</span>' +
      '        </div>' +
      '        <input type="range" id="gif-import-scale" min="10" max="100" step="5" value="' + Math.min(100, draft.scalePercent) + '">' +
      '      </div>' +

      '      <div class="gif-import-three-col' + (isSingleFrame ? ' gif-disabled' : '') + '">' +
      '        <div class="gif-import-field-vert">' +
      '          <label for="gif-import-fps" class="gif-import-label">' + t('gifImportFps', 'Import FPS:') + '</label>' +
      '          <div class="number-stepper">' +
      '            <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-import-fps\', -1)" ' + (isSingleFrame ? 'disabled' : '') + '>-</button>' +
      '            <input type="number" class="stepper-input" id="gif-import-fps" min="1" max="60" value="' + draft.fps + '" ' + (isSingleFrame ? 'disabled' : '') + '>' +
      '            <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-import-fps\', 1)" ' + (isSingleFrame ? 'disabled' : '') + '>+</button>' +
      '          </div>' +
      '        </div>' +
      '        <div class="gif-import-field-vert">' +
      '          <label for="gif-import-start-ms" class="gif-import-label">' + t('gifImportStartMs', 'Start (ms):') + '</label>' +
      '          <div class="number-stepper">' +
      '            <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-import-start-ms\', -100)" ' + (isSingleFrame ? 'disabled' : '') + '>-</button>' +
      '            <input type="number" class="stepper-input" id="gif-import-start-ms" min="0" max="' + maxMs + '" value="' + draft.startMs + '" ' + (isSingleFrame ? 'disabled' : '') + '>' +
      '            <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-import-start-ms\', 100)" ' + (isSingleFrame ? 'disabled' : '') + '>+</button>' +
      '          </div>' +
      '        </div>' +
      '        <div class="gif-import-field-vert">' +
      '          <label for="gif-import-end-ms" class="gif-import-label">' + t('gifImportEndMs', 'End (ms):') + '</label>' +
      '          <div class="number-stepper">' +
      '            <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-import-end-ms\', -100)" ' + (isSingleFrame ? 'disabled' : '') + '>-</button>' +
      '            <input type="number" class="stepper-input" id="gif-import-end-ms" min="0" max="' + maxMs + '" value="' + draft.endMs + '" ' + (isSingleFrame ? 'disabled' : '') + '>' +
      '            <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-import-end-ms\', 100)" ' + (isSingleFrame ? 'disabled' : '') + '>+</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <div class="gif-import-row' + (isSingleFrame ? ' gif-disabled' : '') + '" style="flex-direction: column; align-items: stretch; gap: 4px;">' +
      '        <div style="display:flex; justify-content:space-between;">' +
      '          <span class="gif-import-label">' + t('gifImportTimeRange', 'Time Range:') + '</span>' +
      '          <span class="gif-import-value" id="gif-import-time-display">0.00s - ' + (draft.sourceDurationMs / 1000).toFixed(2) + 's</span>' +
      '        </div>' +
      '        <div class="gif-import-range" id="gif-import-range">' +
      '          <div class="gif-import-range-track"></div>' +
      '          <div class="gif-import-range-selected" id="gif-import-range-selected"></div>' +
      '          <input type="range" id="gif-import-start-range" min="0" max="' + maxMs + '" value="' + draft.startMs + '" ' + (isSingleFrame ? 'disabled' : '') + '>' +
      '          <input type="range" id="gif-import-end-range" min="0" max="' + maxMs + '" value="' + draft.endMs + '" ' + (isSingleFrame ? 'disabled' : '') + '>' +
      '        </div>' +
      '      </div>' +

      '      <hr class="gif-import-divider">' +

      '      <div class="gif-import-summary-row">' +
      '        <div>' +
      '          <span class="gif-import-label">' + t('gifImportActualFrames', 'Actual Frames:') + ' </span>' +
      '          <span class="gif-import-summary-val" id="gif-import-actual-frames">1</span>' +
      '        </div>' +
      '        <div>' +
      '          <span class="gif-import-label">' + t('gifImportDuration', 'Duration:') + ' </span>' +
      '          <span class="gif-import-summary-val" id="gif-import-duration">00:00:00.000</span>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="modal-footer">' +
      '    <button type="button" class="btn btn-ghost" id="gif-import-cancel-btn">' + t('gifImportCancel', 'Cancel') + '</button>' +
      '    <button type="button" class="btn btn-primary" id="gif-import-confirm-btn">' + t('gifImportConfirm', 'Import') + '</button>' +
      '  </div>' +
      '</div>';

    overlay.innerHTML = html;
    overlay.classList.add('show');

    bindModalEvents();
    updateImportSummary();
    triggerPreviewDebounced();
  }

  function bindModalEvents() {
    var overlay = document.getElementById('modal-overlay');
    if (!overlay) return;

    var cancelBtn = document.getElementById('gif-import-cancel-btn');
    var confirmBtn = document.getElementById('gif-import-confirm-btn');

    if (cancelBtn) cancelBtn.addEventListener('click', onCancelClick);
    if (confirmBtn) confirmBtn.addEventListener('click', onConfirmClick);

    var scaleInput = document.getElementById('gif-import-scale');
    var fpsInput = document.getElementById('gif-import-fps');
    var startRange = document.getElementById('gif-import-start-range');
    var endRange = document.getElementById('gif-import-end-range');
    var startMsInput = document.getElementById('gif-import-start-ms');
    var endMsInput = document.getElementById('gif-import-end-ms');

    if (scaleInput) {
      scaleInput.addEventListener('input', function () {
        if (!draft) return;
        var val = parseInt(scaleInput.value, 10);
        if (isNaN(val) || val < 1) val = 100;
        draft.scalePercent = Math.max(10, Math.min(100, val));
        updateImportSummary();
        triggerPreviewDebounced();
      });
    }

    if (fpsInput) {
      fpsInput.addEventListener('input', function () {
        if (!draft) return;
        var val = parseInt(fpsInput.value, 10);
        if (isNaN(val) || val < 1) val = 30;
        draft.fps = Math.max(1, Math.min(60, val));
        draft.fpsChanged = true;
        clampRanges();
        syncInputs();
        updateImportSummary();
        triggerPreviewDebounced();
      });
    }

    if (startRange) {
      startRange.addEventListener('input', function () {
        if (!draft) return;
        draft.startMs = parseInt(startRange.value, 10) || 0;
        clampRanges('start');
        syncInputs();
        updateImportSummary();
        triggerPreviewDebounced();
      });
    }

    if (endRange) {
      endRange.addEventListener('input', function () {
        if (!draft) return;
        draft.endMs = parseInt(endRange.value, 10) || 0;
        clampRanges('end');
        syncInputs();
        updateImportSummary();
        triggerPreviewDebounced();
      });
    }

    if (startMsInput) {
      startMsInput.addEventListener('change', function () {
        if (!draft) return;
        draft.startMs = parseInt(startMsInput.value, 10);
        if (isNaN(draft.startMs)) draft.startMs = 0;
        clampRanges('start');
        syncInputs();
        updateImportSummary();
        triggerPreviewDebounced();
      });
    }

    if (endMsInput) {
      endMsInput.addEventListener('change', function () {
        if (!draft) return;
        draft.endMs = parseInt(endMsInput.value, 10);
        if (isNaN(draft.endMs)) draft.endMs = 0;
        clampRanges('end');
        syncInputs();
        updateImportSummary();
        triggerPreviewDebounced();
      });
    }
  }

  // Clamp start/end to [0, maxMs], preserve at least a one-frame span, and
  // keep start <= end. All numeric entry points funnel through here.
  function clampRanges(changedSource) {
    if (!draft || draft.kind === 'image') return;

    var maxMs = Math.max(1, draft.sourceDurationMs);
    var minSpanMs = Math.max(1, Math.round(1000 / draft.fps));

    if (draft.startMs < 0) draft.startMs = 0;
    if (draft.startMs > maxMs) draft.startMs = maxMs;
    if (draft.endMs < 0) draft.endMs = 0;
    if (draft.endMs > maxMs) draft.endMs = maxMs;

    if (changedSource === 'start') {
      if (draft.startMs > draft.endMs - minSpanMs) {
        draft.endMs = Math.min(maxMs, draft.startMs + minSpanMs);
      }
      if (draft.startMs >= draft.endMs && draft.startMs >= minSpanMs) {
        draft.startMs = Math.max(0, draft.endMs - minSpanMs);
      }
    } else if (changedSource === 'end') {
      if (draft.endMs < draft.startMs + minSpanMs) {
        draft.startMs = Math.max(0, draft.endMs - minSpanMs);
      }
      if (draft.endMs <= draft.startMs && draft.endMs + minSpanMs <= maxMs) {
        draft.endMs = draft.startMs + minSpanMs;
      }
    } else {
      if (draft.startMs >= draft.endMs) {
        draft.endMs = Math.min(maxMs, draft.startMs + minSpanMs);
      }
    }
    // Final safety net (single-frame edge: 0..0 on a 0-length source).
    if (draft.endMs < draft.startMs) draft.endMs = draft.startMs;
  }

  function syncInputs() {
    if (!draft) return;
    var startRange = document.getElementById('gif-import-start-range');
    var endRange = document.getElementById('gif-import-end-range');
    var startMsInput = document.getElementById('gif-import-start-ms');
    var endMsInput = document.getElementById('gif-import-end-ms');
    var timeDisplay = document.getElementById('gif-import-time-display');
    var rangeSelected = document.getElementById('gif-import-range-selected');

    if (startRange) startRange.value = draft.startMs;
    if (endRange) endRange.value = draft.endMs;
    if (startMsInput) startMsInput.value = draft.startMs;
    if (endMsInput) endMsInput.value = draft.endMs;

    if (timeDisplay) {
      timeDisplay.textContent = (draft.startMs / 1000).toFixed(2) + 's - ' + (draft.endMs / 1000).toFixed(2) + 's';
    }

    if (rangeSelected && draft.sourceDurationMs > 0) {
      var startRatio = Math.max(0, Math.min(1, draft.startMs / draft.sourceDurationMs));
      var endRatio = Math.max(0, Math.min(1, draft.endMs / draft.sourceDurationMs));
      var spanRatio = Math.max(0, endRatio - startRatio);
      rangeSelected.style.left = 'calc(8px + (100% - 16px) * ' + startRatio + ')';
      rangeSelected.style.width = 'calc((100% - 16px) * ' + spanRatio + ')';
    }
  }

  // Number of frames that will actually be produced by the current settings.
  // Inclusive sampling: floor(spanMs * fps / 1000) + 1 (e.g. 0..4000ms at
  // 30 FPS -> 121 frames, duration 4000ms).
  function estimateFrameCount() {
    if (!draft) return 1;
    if (draft.kind === 'image') return 1;
    var spanMs = Math.max(1, draft.endMs - draft.startMs);
    if (draft.kind === 'gif' && !draft.fpsChanged) {
      // Original-delay GIF import: count source frames overlapping the range.
      var count = 0;
      var frames = draft.gifFrames || [];
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].endMs > draft.startMs && frames[i].startMs < draft.endMs) count++;
      }
      return Math.max(1, count);
    }
    return Math.max(1, Math.floor(spanMs * draft.fps / 1000) + 1);
  }

  function updateImportSummary() {
    if (!draft) return;

    var sourceResEl = document.getElementById('gif-import-source-res');
    var scaleDisplayEl = document.getElementById('gif-import-scale-display');
    var actualFramesEl = document.getElementById('gif-import-actual-frames');
    var durationEl = document.getElementById('gif-import-duration');

    if (sourceResEl) {
      var origText = draft.sourceWidth + ' × ' + draft.sourceHeight;
      if (draft.scalePercent !== 100) {
        var scaledW = Math.max(1, Math.round(draft.sourceWidth * draft.scalePercent / 100));
        var scaledH = Math.max(1, Math.round(draft.sourceHeight * draft.scalePercent / 100));
        sourceResEl.textContent = origText + ' -> ' + scaledW + ' × ' + scaledH;
      } else {
        sourceResEl.textContent = origText;
      }
    }

    if (scaleDisplayEl) {
      scaleDisplayEl.textContent = draft.scalePercent + '%';
    }

    var frameCount = estimateFrameCount();
    var durationMs = draft.kind === 'image' ? 0 : Math.max(1, draft.endMs - draft.startMs);

    if (actualFramesEl) actualFramesEl.textContent = frameCount;
    if (durationEl) durationEl.textContent = core.formatDurationMs(durationMs);
  }

  function triggerPreviewDebounced() {
    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(function () {
      updateImportPreview();
    }, 120);
  }

  function updateImportPreview() {
    if (!draft) return;
    var canvas = document.getElementById('gif-import-preview-canvas');
    if (!canvas) return;

    draft.previewGeneration++;
    var gen = draft.previewGeneration;

    var targetW = Math.max(1, Math.round(draft.sourceWidth * draft.scalePercent / 100));
    var targetH = Math.max(1, Math.round(draft.sourceHeight * draft.scalePercent / 100));

    canvas.width = targetW;
    canvas.height = targetH;
    var ctx = canvas.getContext('2d');

    if (draft.kind === 'image' && draft.image) {
      ctx.drawImage(draft.image, 0, 0, targetW, targetH);
    } else if (draft.kind === 'gif' && draft.gifFrames && draft.gifFrames.length) {
      var foundIndex = frameIndexAt(draft.gifFrames, draft.startMs);
      var snap = draft.gifFrames[foundIndex].canvas;
      ctx.drawImage(snap, 0, 0, targetW, targetH);
    } else if (draft.kind === 'video' && draft.video) {
      seekTo(draft.video, draft.startMs / 1000, 3000).then(function () {
        if (!draft || gen !== draft.previewGeneration) return;
        ctx.drawImage(draft.video, 0, 0, targetW, targetH);
      }).catch(function () {
        // ignore preview seek errors silently
      });
    }
  }

  function frameIndexAt(frames, sampleMs) {
    var foundIndex = 0;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].endMs >= sampleMs) {
        foundIndex = i;
        break;
      }
    }
    return foundIndex;
  }

  // ------------------------------------------------------------------
  // Commit Import Draft Transaction
  // ------------------------------------------------------------------

  function onConfirmClick() {
    if (!draft) return;
    commitImportDraft();
  }

  function onCancelClick() {
    cancelDraft();
    closeModal();
  }

  function closeModal() {
    var overlay = document.getElementById('modal-overlay');
    if (overlay) {
      overlay.classList.remove('show');
      overlay.innerHTML = '';
    }
  }

  // Transactional commit: the old project survives until the new slice list
  // is fully built; any failure or cancellation leaves it untouched. Stale
  // async work (page left / new file / cancel) is aborted via commitGeneration.
  function commitImportDraft() {
    if (!draft) return;
    var currentDraft = draft;
    var gen = commitGeneration;

    core.showSpinner(t('gifEditorProcessing', 'Processing...'));

    var scale = currentDraft.scalePercent / 100;
    var importWidth = Math.max(1, Math.round(currentDraft.sourceWidth * scale));
    var importHeight = Math.max(1, Math.round(currentDraft.sourceHeight * scale));

    var commitPromise;
    if (currentDraft.kind === 'image') {
      commitPromise = commitImageDraft(importWidth, importHeight);
    } else if (currentDraft.kind === 'gif') {
      commitPromise = commitGifDraft(importWidth, importHeight);
    } else if (currentDraft.kind === 'video') {
      commitPromise = commitVideoDraft(importWidth, importHeight);
    } else {
      core.hideSpinner();
      return;
    }

    commitPromise.then(function (nextSlices) {
      if (gen !== commitGeneration) return; // stale: cancelled / replaced
      core.hideSpinner();
      if (!nextSlices || !nextSlices.length) {
        handleCommitError(gen, new Error('No frames extracted.'));
        return;
      }

      // ---- Commit point: replace the project atomically. ----
      core.resetSlices();
      core.state.slices = nextSlices;
      core.state.source.kind = currentDraft.kind;
      core.state.source.file = currentDraft.file;
      core.state.source.width = importWidth;
      core.state.source.height = importHeight;
      core.state.source.durationMs = (currentDraft.endMs - currentDraft.startMs);
      core.state.source.sourceFps = currentDraft.fps;
      core.state.source.gridSliced = false;

      if (currentDraft.kind === 'image' && nextSlices[0]) {
        core.state.processedImg = nextSlices[0].canvas;
      }

      // Frames are independent canvases now: the draft media resources (video
      // element, object URL, decoded GIF frames) are no longer needed.
      if (currentDraft.objectUrl) {
        try { URL.revokeObjectURL(currentDraft.objectUrl); } catch (e) {}
        currentDraft.objectUrl = null;
      }
      currentDraft.image = null;
      currentDraft.video = null;
      currentDraft.gifFrames = null;

      closeModal();
      draft = null;
      core.state.importDraft = null;

      if (core.commands.updateSourcePanels) core.commands.updateSourcePanels(currentDraft.kind);
      if (core.timeline && core.timeline.render) core.timeline.render();
      if (core.commands.focusFrame) core.commands.focusFrame(0);
      if (core.commands.redrawSelection) core.commands.redrawSelection(0);
      if (core.commands.updateSelectionUI) core.commands.updateSelectionUI(0);
      if (core.commands.resetView) core.commands.resetView();
      setTimeout(function () {
        if (core.commands.resetView) core.commands.resetView();
      }, 60);
    }).catch(function (err) {
      if (gen !== commitGeneration) return; // stale failure: stay silent
      core.hideSpinner();
      handleCommitError(gen, err);
    });
  }

  function handleCommitError(gen, err) {
    if (gen !== commitGeneration) return;
    console.error('Import failed:', err);
    alert(t('gifEditorAlertImportFailed', 'Failed to import file: ') + (err && err.message ? err.message : String(err)));
  }

  function commitImageDraft(width, height) {
    return new Promise(function (resolve) {
      var frame = document.createElement('canvas');
      frame.width = width;
      frame.height = height;
      var ctx = frame.getContext('2d');
      ctx.drawImage(draft.image, 0, 0, width, height);

      resolve([{
        id: core.freshId(),
        canvas: frame,
        delay: 100,
        layers: []
      }]);
    });
  }

  function commitGifDraft(width, height) {
    return new Promise(function (resolve) {
      var nextSlices = [];
      var startMs = draft.startMs;
      var endMs = draft.endMs;
      var fps = draft.fps;
      var frames = draft.gifFrames || [];
      if (!frames.length) {
        resolve(nextSlices);
        return;
      }

      var scaleCanvas = function (srcCanvas) {
        var frame = document.createElement('canvas');
        frame.width = width;
        frame.height = height;
        frame.getContext('2d').drawImage(srcCanvas, 0, 0, width, height);
        return frame;
      };

      if (!draft.fpsChanged) {
        // Default import: preserve the source frame delays; keep every frame
        // overlapping the selected range (inclusive endpoints).
        var included = 0;
        for (var i = 0; i < frames.length; i++) {
          var g = frames[i];
          if (g.endMs > startMs && g.startMs < endMs) {
            nextSlices.push({
              id: core.freshId(),
              canvas: scaleCanvas(g.canvas),
              delay: g.delay,
              layers: []
            });
            included++;
          }
        }
        if (!included) {
          var fallback = frameIndexAt(frames, startMs);
          nextSlices.push({
            id: core.freshId(),
            canvas: scaleCanvas(frames[fallback].canvas),
            delay: frames[fallback].delay,
            layers: []
          });
        }
        resolve(nextSlices);
        return;
      }

      // Re-sample at the chosen FPS (inclusive sampling contract).
      var spanMs = Math.max(1, endMs - startMs);
      var frameCount = Math.max(1, Math.floor(spanMs * fps / 1000) + 1);
      var avgDelay = spanMs / frameCount;

      for (var j = 0; j < frameCount; j++) {
        var sampleMs = startMs + j * 1000 / fps;
        if (sampleMs > endMs + 0.001) break;
        var idx = frameIndexAt(frames, sampleMs);
        nextSlices.push({
          id: core.freshId(),
          canvas: scaleCanvas(frames[idx].canvas),
          delay: avgDelay,
          layers: []
        });
      }
      resolve(nextSlices);
    });
  }

  function commitVideoDraft(width, height) {
    return new Promise(function (resolve, reject) {
      var video = draft.video;
      if (!video) return reject(new Error('No video reference'));

      var gen = commitGeneration;
      var startMs = draft.startMs;
      var endMs = draft.endMs;
      var fps = draft.fps;
      var spanMs = Math.max(1, endMs - startMs);
      var frameCount = Math.max(1, Math.floor(spanMs * fps / 1000) + 1); // inclusive
      var avgDelay = spanMs / frameCount;

      var nextSlices = [];
      var i = 0;

      function step() {
        if (gen !== commitGeneration) {
          // Stale commit: release partial work, resolve (finish guard drops it).
          resolve(nextSlices);
          return;
        }
        if (i >= frameCount) {
          resolve(nextSlices);
          return;
        }
        var sampleMs = startMs + i * 1000 / fps;
        if (sampleMs > endMs + 0.001) {
          resolve(nextSlices);
          return;
        }

        var pct = Math.round((i / frameCount) * 100);
        core.showSpinner(t('gifEditorExtractingPct', 'Extracting: {0}%').replace('{0}', pct));

        seekTo(video, sampleMs / 1000, 5000).then(function () {
          if (gen !== commitGeneration) {
            resolve(nextSlices);
            return;
          }
          var frame = document.createElement('canvas');
          frame.width = width;
          frame.height = height;
          frame.getContext('2d').drawImage(video, 0, 0, width, height);

          nextSlices.push({
            id: core.freshId(),
            canvas: frame,
            delay: avgDelay,
            layers: []
          });

          i++;
          setTimeout(step, 0);
        }).catch(reject);
      }

      step();
    });
  }

  // ------------------------------------------------------------------
  // Cleanup & Event Listeners
  // ------------------------------------------------------------------

  function cancelDraft() {
    commitGeneration++; // abort any in-flight commit
    if (previewDebounceTimer) {
      clearTimeout(previewDebounceTimer);
      previewDebounceTimer = null;
    }
    if (draft) {
      draft.previewGeneration++;
      if (draft.objectUrl) {
        try { URL.revokeObjectURL(draft.objectUrl); } catch (e) {}
      }
      if (draft.video) {
        try { draft.video.removeAttribute('src'); if (draft.video.load) draft.video.load(); } catch (e) {}
      }
      draft.image = null;
      draft.video = null;
      draft.gifFrames = null;
      draft = null;
    }
    core.state.importDraft = null;
  }

  // Named so cleanup() can remove it (no listener accumulation across renders).
  function onModalClose() {
    if (draft) {
      cancelDraft();
    }
  }

  function bindEvents() {
    document.addEventListener('tinyrouter:modal-close', onModalClose);
  }

  function cleanup() {
    document.removeEventListener('tinyrouter:modal-close', onModalClose);
    cancelDraft();
  }

  var importApi = {
    openFromFile: openFromFile,
    bindEvents: bindEvents,
    cancel: cancelDraft,
    cleanup: cleanup
  };

  core.registerModule('import', importApi);
  core.import = importApi;
})();
