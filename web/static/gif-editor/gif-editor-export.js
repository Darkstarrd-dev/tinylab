// web/static/gif-editor-export.js
// Export GIF, ZIP, Sprite Sheet & MediaBridge Integration for TinyRouter GIF Editor

(function () {
  'use strict';

  var core = window.GifEditorCore;
  if (!core) return;

  function t(key, fallback) {
    if (typeof window.t === 'function') {
      var res = window.t(key);
      if (res && res !== key) return res;
    }
    return fallback || key;
  }

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  function getOutputDimensions() {
    var modalWInput = document.getElementById('gif-modal-w');
    var modalHInput = document.getElementById('gif-modal-h');
    var outWInput = document.getElementById('gif-output-width');
    var outHInput = document.getElementById('gif-output-height');

    var slices = core.state.slices || [];
    var baseW = (slices.length && slices[0].canvas) ? slices[0].canvas.width : 400;
    var baseH = (slices.length && slices[0].canvas) ? slices[0].canvas.height : 300;

    // The Export Modal's W/H take precedence; the legacy sidebar inputs are
    // only a fallback for callers outside the modal.
    var outWInput2 = modalWInput || outWInput;
    var outHInput2 = modalHInput || outHInput;
    var outW = outWInput2 ? (parseInt(outWInput2.value, 10) || baseW) : baseW;
    var outH = outHInput2 ? (parseInt(outHInput2.value, 10) || baseH) : baseH;

    return { outW: Math.max(1, Math.round(outW)), outH: Math.max(1, Math.round(outH)) };
  }

  function checkExportMemory(outW, outH, factor) {
    var slices = core.state.slices || [];
    if (!slices.length) return true;
    var bytes = slices.length * outW * outH * 4 * (factor || 3);
    if (bytes > core.constants.EXPORT_MEM_LIMIT) {
      var msg = t('gifEditorExportWarn', 'Estimated peak export memory is {0}MB. Continue?').replace('{0}', Math.round(bytes / 1048576));
      return confirm(msg);
    }
    return true;
  }

  function renderCompositedFrame(sliceIndex, targetCanvas, opts) {
    if (core.commands.composeFrame) {
      core.commands.composeFrame(sliceIndex, targetCanvas, opts);
      return;
    }
    // Default composition fallback
    var slice = core.state.slices[sliceIndex];
    if (!slice || !slice.canvas) return;
    var ctx = targetCanvas.getContext('2d');
    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    ctx.drawImage(slice.canvas, 0, 0, targetCanvas.width, targetCanvas.height);
  }

  function isTransparencyEnabled() {
    var cb = document.getElementById('gif-enable-trans');
    return !!(cb && cb.checked && core.state.transparencyReady);
  }

  // ------------------------------------------------------------------
  // Export GIF (browser gif.js encoder; matte #FF00FF maps to transparency)
  // ------------------------------------------------------------------

  function ensureGifJs() {
    return new Promise(function (resolve, reject) {
      if (window.GIF) { resolve(); return; }
      var s = document.createElement('script');
      s.src = core.constants.GIF_VENDOR_URL;
      s.onload = function () {
        if (window.GIF) resolve();
        else reject(new Error('gif.js loaded but GIF is not defined'));
      };
      s.onerror = function () { reject(new Error('failed to load ' + core.constants.GIF_VENDOR_URL)); };
      document.head.appendChild(s);
    });
  }

  // ------------------------------------------------------------------
  // Export ZIP (frames -> registered assets -> archive pack)
  //
  // Current backend contract (internal/api/archive/register.go):
  //   1. POST /api/archive/assets?name=frame_NNN.png   raw PNG body
  //        -> { assetId, name, mime, size, kind }
  //   2. POST /api/archive/pack   JSON { assetIds, format: "zip", name }
  //        -> { assetId }
  //   3. GET  /api/archive/assets/{assetId}            serves the packed zip
  // When the Archive API is absent, falls back to the legacy
  // upload-temp + zip-outputs gallery contract.
  // ------------------------------------------------------------------

  function uploadFrameAsset(canvasSrc, name) {
    return new Promise(function (resolve, reject) {
      canvasSrc.toBlob(function (blob) {
        if (!blob) { reject(new Error('PNG encode failed')); return; }
        fetch('/api/archive/assets?name=' + encodeURIComponent(name), {
          method: 'POST',
          body: blob
        }).then(function (r) {
          return r.json().catch(function () { return { error: 'HTTP ' + r.status }; });
        }).then(function (data) {
          if (data.error || !data.assetId) reject(new Error(data.error || 'asset registration failed'));
          else resolve(data.assetId);
        }).catch(reject);
      }, 'image/png');
    });
  }

  function releaseAsset(id) {
    if (!id) return;
    fetch('/api/archive/release/' + encodeURIComponent(id), { method: 'POST' }).catch(function () {});
  }

  function exportZipViaArchive(total, outW, outH, zipName, spinnerText) {
    var assetIds = [];
    function uploadChunk(start, end) {
      var chunk = [];
      for (var i = start; i < end; i++) {
        var name = 'frame_' + String(i + 1).padStart(3, '0') + '.png';
        var frame = document.createElement('canvas');
        frame.width = outW;
        frame.height = outH;
        renderCompositedFrame(i, frame);
        chunk.push(uploadFrameAsset(frame, name));
      }
      return Promise.all(chunk).then(function (ids) {
        for (var j = 0; j < ids.length; j++) assetIds.push(ids[j]);
        if (spinnerText) spinnerText.textContent = t('gifEditorPackingFrames', 'Packing frames...') + ' (' + end + '/' + total + ')';
      });
    }
    var BATCH = 50;
    var chain = Promise.resolve();
    for (var start = 0; start < total; start += BATCH) {
      (function (s) {
        chain = chain.then(function () { return uploadChunk(s, Math.min(s + BATCH, total)); });
      })(start);
    }
    return chain.then(function () {
      return fetch('/api/archive/pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: assetIds, format: 'zip', name: zipName })
      }).then(function (r) {
        return r.json().catch(function () { return { error: 'HTTP ' + r.status }; });
      }).then(function (pack) {
        if (!pack || !pack.assetId) {
          throw new Error((pack && pack.error) || 'archive pack failed');
        }
        // Frames are consumed into the pack — release server copies best-effort.
        for (var i = 0; i < assetIds.length; i++) releaseAsset(assetIds[i]);
        return '/api/archive/assets/' + encodeURIComponent(pack.assetId);
      });
    });
  }

  function uploadLegacyFramePng(canvasSrc, name) {
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
          else resolve(data.tempPath);
        }).catch(reject);
      }, 'image/png');
    });
  }

  function exportZipLegacy(total, outW, outH, zipName, spinnerText) {
    var paths = [];
    function uploadChunk(start, end) {
      var chunk = [];
      for (var i = start; i < end; i++) {
        var name = 'frame_' + String(i + 1).padStart(3, '0') + '.png';
        var frame = document.createElement('canvas');
        frame.width = outW;
        frame.height = outH;
        renderCompositedFrame(i, frame);
        chunk.push(uploadLegacyFramePng(frame, name));
      }
      return Promise.all(chunk).then(function (ps) {
        for (var j = 0; j < ps.length; j++) paths.push(ps[j]);
        if (spinnerText) spinnerText.textContent = t('gifEditorPackingFrames', 'Packing frames...') + ' (' + end + '/' + total + ')';
      });
    }
    var BATCH = 50;
    var chain = Promise.resolve();
    for (var start = 0; start < total; start += BATCH) {
      (function (s) {
        chain = chain.then(function () { return uploadChunk(s, Math.min(s + BATCH, total)); });
      })(start);
    }
    return chain.then(function () {
      return fetch('/api/gallery/edit/zip-outputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: paths, cleanUp: true })
      }).then(function (r) {
        return r.json().catch(function () { return { error: 'HTTP ' + r.status }; });
      }).then(function (zip) {
        if (zip.error) throw new Error(zip.error);
        return { url: zip.outputURL, name: zip.zipName || zipName };
      });
    });
  }

  // ------------------------------------------------------------------
  // Export Sprite Sheet (single canvas, one PNG encode)
  // ------------------------------------------------------------------

  function exportSprite() {
    var rowsInput = document.getElementById('gif-modal-sprite-rows');
    var colsInput = document.getElementById('gif-modal-sprite-cols');
    var rows = rowsInput ? (parseInt(rowsInput.value, 10) || 1) : 1;
    var cols = colsInput ? (parseInt(colsInput.value, 10) || 1) : 1;
    rows = Math.max(1, rows);
    cols = Math.max(1, cols);

    var dims = getOutputDimensions();
    var sheetW = dims.outW * cols;
    var sheetH = dims.outH * rows;

    if (!checkExportMemory(sheetW, sheetH, 1)) return;

    core.showSpinner(t('gifEditorGeneratingSheet', 'Generating sprite sheet...'));

    setTimeout(function () {
      try {
        var sheetCanvas = document.createElement('canvas');
        sheetCanvas.width = sheetW;
        sheetCanvas.height = sheetH;
        var sCtx = sheetCanvas.getContext('2d');

        var tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = dims.outW;
        tmpCanvas.height = dims.outH;

        for (var i = 0; i < slices.length; i++) {
          var r = Math.floor(i / cols);
          var c = i % cols;
          if (r >= rows) break;
          renderCompositedFrame(i, tmpCanvas);
          sCtx.drawImage(tmpCanvas, c * dims.outW, r * dims.outH, dims.outW, dims.outH);
        }

        sheetCanvas.toBlob(function (blob) {
          if (!blob) {
            core.hideSpinner();
            alert(t('gifEditorRenderFail', 'Sprite sheet render failed.'));
            return;
          }
          core.hideSpinner();
          var name = 'SpriteSheet_' + Date.now() + '.png';
          var previewImg = document.getElementById('gif-modal-preview-img');
          if (previewImg) {
            if (previewImg.src && previewImg.src.startsWith('blob:')) {
              URL.revokeObjectURL(previewImg.src);
            }
            previewImg.src = URL.createObjectURL(blob);
          }
          triggerSaveFileWithPicker(blob, name, 'image/png');
        }, 'image/png');
      } catch (err) {
        console.error(err);
        core.hideSpinner();
        alert(err && err.message ? err.message : String(err));
      }
    }, 50);
  }

  // Helper to trigger direct browser save-as dialog or native file picker
  async function triggerSaveFileWithPicker(blobOrUrl, filename, mimeType) {
    mimeType = mimeType || 'image/gif';
    var ext = filename.split('.').pop() || 'gif';

    var blobData = null;
    if (blobOrUrl instanceof Blob) {
      blobData = blobOrUrl;
    } else if (typeof blobOrUrl === 'string') {
      try {
        var res = await fetch(blobOrUrl);
        blobData = await res.blob();
      } catch (e) {
        console.error('Fetch blob failed:', e);
      }
    }

    if (typeof window.showSaveFilePicker === 'function' && blobData) {
      try {
        var acceptMap = {};
        acceptMap[mimeType] = ['.' + ext];
        var handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: ext.toUpperCase() + ' File',
            accept: acceptMap
          }]
        });
        var writable = await handle.createWritable();
        await writable.write(blobData);
        await writable.close();
        return true;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          return false;
        }
      }
    }

    triggerSaveFile(blobOrUrl, filename);
    return true;
  }

  function triggerSaveFile(blobOrUrl, filename) {
    var link = document.createElement('a');
    var isBlob = blobOrUrl instanceof Blob;
    var url = isBlob ? URL.createObjectURL(blobOrUrl) : blobOrUrl;
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (isBlob) {
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }
  }

  // ------------------------------------------------------------------
  // Export Modal & Dimension Coupling (W / H / Scale 3-way sync)
  // ------------------------------------------------------------------

  var modalPreviewBlob = null;

  function openExportModal() {
    var slices = core.state.slices || [];
    if (!slices.length) {
      alert(t('gifEditorAlertNoSlices', 'No frames to export.'));
      return;
    }

    var overlay = document.getElementById('modal-overlay');
    if (!overlay) return;

    var baseW = (slices[0] && slices[0].canvas) ? slices[0].canvas.width : 400;
    var baseH = (slices[0] && slices[0].canvas) ? slices[0].canvas.height : 300;
    var outWInput = document.getElementById('gif-output-width');
    var outHInput = document.getElementById('gif-output-height');
    var curW = outWInput ? (parseInt(outWInput.value, 10) || baseW) : baseW;
    var curH = outHInput ? (parseInt(outHInput.value, 10) || baseH) : baseH;
    var initialScale = Math.round((curW / baseW) * 100) || 100;

    modalPreviewBlob = null;

    var html = '' +
      '<div class="modal gif-export-modal">' +
      '  <div class="modal-title" data-i18n="gifEditorExportModalTitle">' + t('gifEditorExportModalTitle', 'Export GIF & Frame Settings') + '</div>' +
      '  <div class="modal-body">' +
      '    <div class="gif-export-preview-container">' +
      '      <img id="gif-modal-preview-img" class="gif-export-preview-img" alt="Preview">' +
      '    </div>' +
      '    <div class="gif-control-row" style="margin-bottom: 12px; gap: 12px;">' +
      '      <div class="gif-input-with-label">' +
      '        <span class="gif-axis-label">W</span>' +
      '        <div class="number-stepper" style="flex: 1;">' +
      '          <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-modal-w\', -10)">-</button>' +
      '          <input type="number" class="stepper-input" id="gif-modal-w" value="' + curW + '" min="1">' +
      '          <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-modal-w\', 10)">+</button>' +
      '        </div>' +
      '      </div>' +
      '      <div class="gif-input-with-label">' +
      '        <span class="gif-axis-label">H</span>' +
      '        <div class="number-stepper" style="flex: 1;">' +
      '          <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-modal-h\', -10)">-</button>' +
      '          <input type="number" class="stepper-input" id="gif-modal-h" value="' + curH + '" min="1">' +
      '          <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-modal-h\', 10)">+</button>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '    <div class="gif-range-wrap" style="margin-bottom: 12px;">' +
      '      <span class="gif-scale-label" data-i18n="gifEditorScale">' + t('gifEditorScale', 'Scale') + '</span>' +
      '      <input type="range" id="gif-modal-scale-slider" min="10" max="300" value="' + initialScale + '" class="gif-flex-1">' +
      '      <span class="gif-scale-val" id="gif-modal-scale-val">' + (initialScale / 100).toFixed(1) + 'x</span>' +
      '    </div>' +
      '    <div class="gif-group-title gif-quality-title" style="margin-bottom: 4px;" data-i18n="gifEditorQuality">' + t('gifEditorQuality', 'GIF quality (sampling interval)') +
      '      <span class="gif-quality-range" data-i18n="gifEditorQualityRange">' + t('gifEditorQualityRange', '1: Best - 10: Fastest') + '</span>' +
      '    </div>' +
      '    <div class="gif-control-row" style="margin-bottom: 16px;">' +
      '      <input type="range" id="gif-modal-quality-slider" min="1" max="10" value="10" class="gif-flex-1">' +
      '      <span id="gif-modal-quality-val" style="width: 24px; text-align: right; font-weight: bold;">10</span>' +
      '    </div>' +
      '    <div class="gif-output-sep-inner" style="margin-top: 12px; border-top: 1px dashed var(--glass-border); padding-top: 10px;">' +
      '      <div class="gif-group-title" data-i18n="gifEditorExportSprite" style="margin-bottom: 8px; font-weight: bold;">Export Sprite Sheet</div>' +
      '      <div class="gif-control-row" style="margin-bottom: 8px; gap: 12px;">' +
      '        <div class="gif-input-with-label">' +
      '          <span class="gif-axis-label">X</span>' +
      '          <div class="number-stepper" style="flex: 1;">' +
      '            <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-modal-sprite-cols\', -1)">-</button>' +
      '            <input type="number" class="stepper-input" id="gif-modal-sprite-cols" value="5" min="1">' +
      '            <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-modal-sprite-cols\', 1)">+</button>' +
      '          </div>' +
      '        </div>' +
      '        <div class="gif-input-with-label">' +
      '          <span class="gif-axis-label">Y</span>' +
      '          <div class="number-stepper" style="flex: 1;">' +
      '            <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-modal-sprite-rows\', -1)">-</button>' +
      '            <input type="number" class="stepper-input" id="gif-modal-sprite-rows" value="1" min="1">' +
      '            <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-modal-sprite-rows\', 1)">+</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +
      '      <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-modal-export-sprite-btn" data-i18n="gifEditorExportSprite">Export Sprite Sheet</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">' +
      '    <button type="button" class="btn btn-ghost" id="gif-modal-preview-btn">Preview</button>' +
      '    <div style="display: flex; gap: 8px;">' +
      '      <button type="button" class="btn btn-ghost" id="gif-modal-save-zip-btn" data-i18n="gifEditorSaveAsZip">' + t('gifEditorSaveAsZip', '📦 Save as ZIP') + '</button>' +
      '      <button type="button" class="btn btn-primary" id="gif-modal-save-gif-btn" data-i18n="gifEditorSaveAsGif">' + t('gifEditorSaveAsGif', '💾 Save as GIF') + '</button>' +
      '    </div>' +
      '    <button type="button" class="btn btn-ghost" id="gif-modal-close-btn" data-i18n="gifEditorClose">' + t('gifEditorClose', 'Close') + '</button>' +
      '  </div>' +
      '</div>';

    overlay.innerHTML = html;
    overlay.classList.add('show');

    bindExportModalEvents(baseW, baseH);
    renderInitialModalPreview();
  }

  function renderInitialModalPreview() {
    var slices = core.state.slices || [];
    if (!slices.length) return;
    var previewImg = document.getElementById('gif-modal-preview-img');
    if (!previewImg) return;

    var wInput = document.getElementById('gif-modal-w');
    var hInput = document.getElementById('gif-modal-h');
    var w = wInput ? parseInt(wInput.value, 10) : slices[0].canvas.width;
    var h = hInput ? parseInt(hInput.value, 10) : slices[0].canvas.height;

    var tempCanvas = document.createElement('canvas');
    tempCanvas.width = Math.max(1, w);
    tempCanvas.height = Math.max(1, h);
    renderCompositedFrame(0, tempCanvas, { applyTransparency: !core.state.srcImg });
    previewImg.src = tempCanvas.toDataURL('image/png');
  }

  function bindExportModalEvents(baseW, baseH) {
    var wInput = document.getElementById('gif-modal-w');
    var hInput = document.getElementById('gif-modal-h');
    var scaleSlider = document.getElementById('gif-modal-scale-slider');
    var scaleValSpan = document.getElementById('gif-modal-scale-val');
    var qualitySlider = document.getElementById('gif-modal-quality-slider');
    var qualityValSpan = document.getElementById('gif-modal-quality-val');
    var previewBtn = document.getElementById('gif-modal-preview-btn');
    var saveGifBtn = document.getElementById('gif-modal-save-gif-btn');
    var saveZipBtn = document.getElementById('gif-modal-save-zip-btn');
    var closeBtn = document.getElementById('gif-modal-close-btn');

    var isUpdating = false;
    var aspectRatio = (baseW && baseH) ? (baseW / baseH) : 1;

    function syncDimensions(source) {
      if (isUpdating) return;
      isUpdating = true;

      var curW = baseW, curH = baseH;

      if (source === 'w') {
        curW = parseInt(wInput.value, 10) || baseW;
        curH = Math.max(1, Math.round(curW / aspectRatio));
        hInput.value = curH;
        var scale = Math.round((curW / baseW) * 100);
        scaleSlider.value = Math.max(10, Math.min(300, scale));
        scaleValSpan.textContent = (scale / 100).toFixed(1) + 'x';
      } else if (source === 'h') {
        curH = parseInt(hInput.value, 10) || baseH;
        curW = Math.max(1, Math.round(curH * aspectRatio));
        wInput.value = curW;
        var scale = Math.round((curW / baseW) * 100);
        scaleSlider.value = Math.max(10, Math.min(300, scale));
        scaleValSpan.textContent = (scale / 100).toFixed(1) + 'x';
      } else if (source === 'scale') {
        var scale = parseInt(scaleSlider.value, 10) || 100;
        scaleValSpan.textContent = (scale / 100).toFixed(1) + 'x';
        curW = Math.max(1, Math.round(baseW * scale / 100));
        curH = Math.max(1, Math.round(baseH * scale / 100));
        wInput.value = curW;
        hInput.value = curH;
      }

      var outWInput = document.getElementById('gif-output-width');
      var outHInput = document.getElementById('gif-output-height');
      if (outWInput) outWInput.value = curW;
      if (outHInput) outHInput.value = curH;

      isUpdating = false;
    }

    if (wInput) {
      wInput.addEventListener('input', function () { syncDimensions('w'); });
      wInput.addEventListener('change', function () { syncDimensions('w'); });
    }
    if (hInput) {
      hInput.addEventListener('input', function () { syncDimensions('h'); });
      hInput.addEventListener('change', function () { syncDimensions('h'); });
    }
    if (scaleSlider) scaleSlider.addEventListener('input', function () { syncDimensions('scale'); });

    if (qualitySlider) {
      qualitySlider.addEventListener('input', function () {
        if (qualityValSpan) qualityValSpan.textContent = qualitySlider.value;
      });
    }

    if (previewBtn) {
      previewBtn.addEventListener('click', function () {
        renderGifBlobFromModal(function (blob) {
          if (!blob) return;
          modalPreviewBlob = blob;
          var previewImg = document.getElementById('gif-modal-preview-img');
          if (previewImg) {
            if (previewImg.src && previewImg.src.startsWith('blob:')) {
              URL.revokeObjectURL(previewImg.src);
            }
            previewImg.src = URL.createObjectURL(blob);
          }
        });
      });
    }

    var spriteBtn = document.getElementById('gif-modal-export-sprite-btn');
    if (spriteBtn) {
      spriteBtn.addEventListener('click', function () {
        var rowsInput = document.getElementById('gif-modal-sprite-rows');
        var colsInput = document.getElementById('gif-modal-sprite-cols');
        var rows = rowsInput ? (parseInt(rowsInput.value, 10) || 1) : 1;
        var cols = colsInput ? (parseInt(colsInput.value, 10) || 1) : 1;
        exportSprite();
      });
    }

    if (saveGifBtn) {
      saveGifBtn.addEventListener('click', function () {
        var filename = 'Slice_' + Date.now() + '.gif';
        if (modalPreviewBlob) {
          triggerSaveFileWithPicker(modalPreviewBlob, filename, 'image/gif');
        } else {
          renderGifBlobFromModal(function (blob) {
            if (blob) triggerSaveFileWithPicker(blob, filename, 'image/gif');
          });
        }
      });
    }

    if (saveZipBtn) {
      saveZipBtn.addEventListener('click', function () {
        var wInput = document.getElementById('gif-modal-w');
        var hInput = document.getElementById('gif-modal-h');
        var w = wInput ? parseInt(wInput.value, 10) : baseW;
        var h = hInput ? parseInt(hInput.value, 10) : baseH;
        saveZipCustom(w, h);
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        var overlay = document.getElementById('modal-overlay');
        if (overlay) {
          overlay.classList.remove('show');
          overlay.innerHTML = '';
        }
      });
    }
  }

  function renderGifBlobFromModal(callback) {
    var slices = core.state.slices || [];
    if (!slices.length) return;

    var wInput = document.getElementById('gif-modal-w');
    var hInput = document.getElementById('gif-modal-h');
    var qualityInput = document.getElementById('gif-modal-quality-slider');

    var outW = wInput ? (parseInt(wInput.value, 10) || 400) : 400;
    var outH = hInput ? (parseInt(hInput.value, 10) || 300) : 300;
    var quality = qualityInput ? (parseInt(qualityInput.value, 10) || 10) : 10;

    var transEnabled = isTransparencyEnabled();
    if (!checkExportMemory(outW, outH, 3)) return;

    core.showSpinner(t('gifEditorCompositing', 'Compositing...'));

    ensureGifJs().then(function () {
      setTimeout(function () {
        try {
          var gifOptions = {
            workers: 4,
            quality: Math.max(1, Math.min(10, quality)),
            width: outW,
            height: outH,
            workerScript: core.constants.GIF_WORKER_URL
          };
          if (transEnabled) gifOptions.transparent = core.constants.MATTE_NUM;

          var encoder = new GIF(gifOptions);
          var tmpCanvas = document.createElement('canvas');
          tmpCanvas.width = outW;
          tmpCanvas.height = outH;

          for (var i = 0; i < slices.length; i++) {
            renderCompositedFrame(i, tmpCanvas, {
              applyTransparency: !core.state.srcImg,
              matte: transEnabled ? core.constants.MATTE_HEX : null
            });
            encoder.addFrame(tmpCanvas, {
              delay: Math.max(1, Math.round(slices[i].delay || 100)),
              copy: true
            });
          }

          var settled = false;
          encoder.on('progress', function (p) {
            core.showSpinner(t('gifEditorExtractingPct', 'Extracting: {0}%').replace('{0}', Math.round(p * 100)));
          });
          encoder.on('finished', function (blob) {
            if (settled) return;
            settled = true;
            core.hideSpinner();
            if (callback) callback(blob);
          });
          encoder.on('abort', function () {
            if (settled) return;
            settled = true;
            core.hideSpinner();
            alert(t('gifEditorRenderFail', 'GIF render failed.'));
          });
          encoder.render();

          setTimeout(function () {
            if (!settled) {
              settled = true;
              core.hideSpinner();
              alert(t('gifEditorRenderFail', 'GIF render failed.'));
            }
          }, 60000);
        } catch (err) {
          console.error(err);
          core.hideSpinner();
          alert(t('gifEditorRenderFail', 'GIF render failed.'));
        }
      }, 60);
    }).catch(function (err) {
      console.error(err);
      core.hideSpinner();
      alert(t('gifEditorGifVendorPending', 'gif.js vendor is not available: ') + (err && err.message ? err.message : err));
    });
  }

  function saveZipCustom(outW, outH) {
    var slices = core.state.slices || [];
    if (!slices.length) return;

    if (!checkExportMemory(outW, outH, 3)) return;

    core.showSpinner(t('gifEditorPackingFrames', 'Packing frames...'));
    var spinnerText = core.dom.spinnerText || document.getElementById('gif-spinner-text');
    var zipName = 'Frames_' + Date.now() + '.zip';

    (function () {
      var caps = (window.MediaBridge && typeof window.MediaBridge.archiveStatus === 'function')
        ? window.MediaBridge.archiveStatus()
        : Promise.resolve(false);
      return caps.then(function (available) {
        if (available) {
          return exportZipViaArchive(slices.length, outW, outH, zipName, spinnerText);
        }
        return exportZipLegacy(slices.length, outW, outH, zipName, spinnerText);
      });
    })().then(function (result) {
      core.hideSpinner();
      var url = (typeof result === 'string') ? result : result.url;
      var name = (typeof result === 'string') ? zipName : result.name;
      triggerSaveFileWithPicker(url, name, 'application/zip');
    }).catch(function (err) {
      core.hideSpinner();
      console.error('ZIP export error:', err);
      alert(t('gifEditorAlertZipFailed', 'Exporting ZIP failed: ') + (err && err.message ? err.message : String(err)));
    });
  }

  function bindEvents() {
    var openExportBtn = document.getElementById('gif-open-export-btn');
    if (openExportBtn) openExportBtn.addEventListener('click', openExportModal);
  }

  function cleanup() {
    // Result-overlay teardown was removed with the overlay (M2).
  }

  var exportApi = {
    sprite: exportSprite,
    openExportModal: openExportModal,
    bindEvents: bindEvents,
    cleanup: cleanup
  };

  core.registerModule('export', exportApi);
  core.export = exportApi;
})();

