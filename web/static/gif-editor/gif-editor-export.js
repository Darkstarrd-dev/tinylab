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

  var resultUrl = null;
  var lastResultAsset = null;
  var lastResultAssetPromise = null;

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  function getOutputDimensions() {
    var outWInput = document.getElementById('gif-out-w');
    var outHInput = document.getElementById('gif-out-h');

    var slices = core.state.slices || [];
    var baseW = (slices.length && slices[0].canvas) ? slices[0].canvas.width : 400;
    var baseH = (slices.length && slices[0].canvas) ? slices[0].canvas.height : 300;

    var outW = outWInput ? (parseInt(outWInput.value, 10) || baseW) : baseW;
    var outH = outHInput ? (parseInt(outHInput.value, 10) || baseH) : baseH;

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

  function exportGif() {
    var slices = core.state.slices || [];
    if (!slices.length) {
      alert(t('gifEditorAlertNoSlices', 'No frames to export.'));
      return;
    }

    var dims = getOutputDimensions();
    var transEnabled = isTransparencyEnabled();
    if (!checkExportMemory(dims.outW, dims.outH, 3)) return;

    core.showSpinner(t('gifEditorCompositing', 'Compositing...'));
    var exportBtn = document.getElementById('gif-export-gif');
    if (exportBtn) {
      exportBtn.disabled = true;
      exportBtn.innerHTML = t('gifEditorRendering', 'Rendering...');
    }
    var restoreBtn = function () {
      if (exportBtn) {
        exportBtn.disabled = false;
        exportBtn.innerHTML = t('gifEditorExportGif', '👁️ 预览 (导出GIF)');
      }
    };

    ensureGifJs().then(function () {
      setTimeout(function () {
        try {
          var qualityInput = document.getElementById('gif-quality');
          var quality = qualityInput ? (parseInt(qualityInput.value, 10) || 10) : 10;

          var gifOptions = {
            workers: 4,
            quality: Math.max(1, Math.min(10, quality)),
            width: dims.outW,
            height: dims.outH,
            workerScript: core.constants.GIF_WORKER_URL
          };
          if (transEnabled) gifOptions.transparent = core.constants.MATTE_NUM;

          var encoder = new GIF(gifOptions);
          var tmpCanvas = document.createElement('canvas');
          tmpCanvas.width = dims.outW;
          tmpCanvas.height = dims.outH;

          for (var i = 0; i < slices.length; i++) {
            renderCompositedFrame(i, tmpCanvas, {
              applyTransparency: !core.state.srcImg, // GIF/video frames are chroma-keyed at export
              matte: transEnabled ? core.constants.MATTE_HEX : null
            });
            encoder.addFrame(tmpCanvas, {
              delay: Math.max(1, Math.round(slices[i].delay || 100)),
              copy: true
            });
          }

          var settled = false;
          var finish = function (blob) {
            if (settled) return;
            settled = true;
            core.hideSpinner();
            restoreBtn();
            var name = 'Slice_' + Date.now() + '.gif';
            showResultModal(blob, name, 'image/gif', 'gif');
          };
          var fail = function () {
            if (settled) return;
            settled = true;
            core.hideSpinner();
            restoreBtn();
            alert(t('gifEditorRenderFail', 'GIF render failed.'));
          };

          encoder.on('progress', function (p) {
            core.showSpinner(t('gifEditorExtractingPct', 'Extracting: {0}%').replace('{0}', Math.round(p * 100)));
          });
          encoder.on('finished', finish);
          encoder.on('abort', fail);
          encoder.render();

          // Safety net: if the worker never responds (vendor/worker 404), fail.
          setTimeout(function () {
            if (!settled) fail();
          }, 60000);
        } catch (err) {
          console.error(err);
          core.hideSpinner();
          restoreBtn();
          alert(t('gifEditorRenderFail', 'GIF render failed.'));
        }
      }, 60);
    }).catch(function (err) {
      console.error(err);
      core.hideSpinner();
      restoreBtn();
      alert(t('gifEditorGifVendorPending', 'gif.js vendor is not available: ') + (err && err.message ? err.message : err));
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
  // The pack result is shown in the result modal and registered via
  // MediaBridge so "Open in Gallery" can import it by controlled URL.
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

  function exportZip() {
    var slices = core.state.slices || [];
    if (!slices.length) {
      alert(t('gifEditorAlertNoSlices', 'No frames to export.'));
      return;
    }

    var dims = getOutputDimensions();
    if (!checkExportMemory(dims.outW, dims.outH, 3)) return;

    core.showSpinner(t('gifEditorPackingFrames', 'Packing frames...'));
    var spinnerText = core.dom.spinnerText || document.getElementById('gif-spinner-text');

    var zipName = 'Frames_' + Date.now() + '.zip';

    (function () {
      var caps = (window.MediaBridge && typeof window.MediaBridge.archiveStatus === 'function')
        ? window.MediaBridge.archiveStatus()
        : Promise.resolve(false);
      return caps.then(function (available) {
        if (available) {
          return exportZipViaArchive(slices.length, dims.outW, dims.outH, zipName, spinnerText);
        }
        return exportZipLegacy(slices.length, dims.outW, dims.outH, zipName, spinnerText);
      });
    })().then(function (result) {
      core.hideSpinner();
      var url = (typeof result === 'string') ? result : result.url;
      var name = (typeof result === 'string') ? zipName : result.name;
      showResultModal(null, name, 'application/zip', 'zip', url);
    }).catch(function (err) {
      core.hideSpinner();
      console.error('ZIP export error:', err);
      alert(t('gifEditorAlertZipFailed', 'Exporting ZIP failed: ') + (err && err.message ? err.message : String(err)));
    });
  }

  // ------------------------------------------------------------------
  // Export Sprite Sheet (single canvas, one PNG encode)
  // ------------------------------------------------------------------

  function exportSprite() {
    var slices = core.state.slices || [];
    if (!slices.length) {
      alert(t('gifEditorAlertNoSlices', 'No frames to export.'));
      return;
    }

    var rowsInput = document.getElementById('gif-sprite-rows');
    var colsInput = document.getElementById('gif-sprite-cols');
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
          showResultModal(blob, name, 'image/png', 'png');
        }, 'image/png');
      } catch (err) {
        console.error(err);
        core.hideSpinner();
        alert(err && err.message ? err.message : String(err));
      }
    }, 50);
  }

  // ------------------------------------------------------------------
  // Result Modal & MediaBridge Integration
  // ------------------------------------------------------------------

  // `blob` may be null for server-URL results (ZIP); `url` supplies the href
  // in that case. The activation class is `.active` (style.css contract).
  function showResultModal(blob, filename, mimeType, format, url) {
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
    if (blob) resultUrl = URL.createObjectURL(blob);

    lastResultAsset = null;
    lastResultAssetPromise = null;

    var resultOverlay = core.dom.resultOverlay || document.getElementById('gif-result-overlay');
    var resultImg = core.dom.resultImg || document.getElementById('gif-result-img');
    var dlLink = core.dom.dlLink || document.getElementById('gif-dl-link');
    var openGalleryBtn = core.dom.resultOpenGallery || document.getElementById('gif-result-open-gallery');

    if (resultImg) {
      if (blob && mimeType.indexOf('image/') === 0) {
        resultImg.src = resultUrl;
        resultImg.style.display = 'block';
      } else {
        resultImg.removeAttribute('src');
        resultImg.style.display = 'none';
      }
    }

    if (dlLink) {
      dlLink.href = url || resultUrl || '#';
      dlLink.download = filename;
    }

    // Register the export with the MediaBridge so "Open in Gallery" can
    // import it without touching galleryState. Blob results are mirrored
    // server-side when the Archive API is present; URL results (ZIP pack)
    // resolve immediately.
    if (window.MediaBridge && typeof window.MediaBridge.register === 'function') {
      var asset = {
        name: filename,
        mime: mimeType,
        kind: (mimeType.indexOf('image/') === 0) ? 'image' : 'archive',
        format: format || '',
        blob: blob,
        url: url || undefined
      };
      lastResultAssetPromise = window.MediaBridge.register(asset).then(function (assetId) {
        lastResultAsset = assetId;
        return assetId;
      }).catch(function (e) {
        console.warn('MediaBridge register failed:', e);
        return null;
      });
    }

    if (openGalleryBtn) {
      openGalleryBtn.style.display = (window.MediaBridge ? 'inline-block' : 'none');
    }

    if (resultOverlay) {
      resultOverlay.classList.add('active');
    }
  }

  function closeResult() {
    var resultOverlay = core.dom.resultOverlay || document.getElementById('gif-result-overlay');
    if (resultOverlay) {
      resultOverlay.classList.remove('active');
    }
    var resultImg = core.dom.resultImg || document.getElementById('gif-result-img');
    if (resultImg) resultImg.removeAttribute('src');
    var dlLink = core.dom.dlLink || document.getElementById('gif-dl-link');
    if (dlLink) dlLink.removeAttribute('href');
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
    lastResultAsset = null;
    lastResultAssetPromise = null;
  }

  function openResultInGallery() {
    if (!window.MediaBridge) return;
    var p = lastResultAssetPromise ||
      (lastResultAssetPromise = Promise.resolve(lastResultAsset));
    p.then(function (assetId) {
      if (assetId) window.MediaBridge.openGallery(assetId);
    }).catch(function (err) {
      console.error('MediaBridge open failed:', err);
      alert(t('gifEditorZipPackFail', 'Failed to open in Gallery: ') + (err && err.message ? err.message : String(err)));
    });
  }

  function bindEvents() {
    var exportGifBtn = document.getElementById('gif-export-gif');
    var exportZipBtn = document.getElementById('gif-export-zip');
    var exportSpriteBtn = document.getElementById('gif-export-sprite');
    var closeResultBtn = document.getElementById('gif-result-close');
    var openGalleryBtn = document.getElementById('gif-result-open-gallery');

    if (exportGifBtn) exportGifBtn.addEventListener('click', exportGif);
    if (exportZipBtn) exportZipBtn.addEventListener('click', exportZip);
    if (exportSpriteBtn) exportSpriteBtn.addEventListener('click', exportSprite);
    if (closeResultBtn) closeResultBtn.addEventListener('click', closeResult);
    if (openGalleryBtn) openGalleryBtn.addEventListener('click', openResultInGallery);
  }

  function cleanup() {
    closeResult();
  }

  var exportApi = {
    gif: exportGif,
    zip: exportZip,
    sprite: exportSprite,
    closeResult: closeResult,
    openResultInGallery: openResultInGallery,
    bindEvents: bindEvents,
    cleanup: cleanup
  };

  core.registerModule('export', exportApi);
  core.export = exportApi;
})();
