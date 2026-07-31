// pg-modal.js
// ----- Modal system ------------------------------------------------
function pgEnsureModalOverlay() {
  var overlay = document.getElementById('pg-modal-overlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'pg-modal-overlay';
  overlay.className = 'pg-modal-overlay';
  document.body.appendChild(overlay);
  return overlay;
}

function pgCloseModal() {
  pgRemoveZoomListeners();
  var overlay = document.getElementById('pg-modal-overlay');
  if (overlay) { overlay.classList.remove('show'); }
}

function pgShowModal(html) {
  var overlay = pgEnsureModalOverlay();
  overlay.innerHTML = '<div class="pg-modal">' + html + '</div>';
  requestAnimationFrame(function() { overlay.classList.add('show'); });
}

function pgOpenDebugModal(winIdx) {
  var w = pgWinAt(winIdx);
  if (!w) return;
  var sseCount = w.sseEvents.length;
  var customBadge = w.config.useCustomBody ? ' <span class="pg-tab-badge custom">' + pgEscapeHtml(pgT('pgDebugCustomBadge')) + '</span>' : '';
  var responseBadge = sseCount > 0 ? ' <span class="pg-tab-badge">SSE ' + sseCount + '</span>' : '';
  var headerHtml = '<div class="pg-modal-header">' +
    '<span class="pg-modal-title">🐛 ' + pgEscapeHtml(pgT('pgDebug')) + ' — ' + pgEscapeHtml(pgT('pgPaneName', [winIdx + 1])) + '</span>' +
    '<button class="pg-modal-close" onclick="pgCloseModal()">✕</button>' +
  '</div>';
  var metaHtml = '<div class="pg-debug-meta">' +
    '<span>' + pgEscapeHtml(pgT('pgRespProvider').replace('{0}', w.lastProvider || pgT('pgNoProvider'))) + '</span>' +
    '<span>' + pgEscapeHtml(pgT('pgRespKey').replace('{0}', w.lastKey || pgT('pgNoProvider'))) + '</span>' +
    '<span>' + (w.streaming ? '🔴 ' + pgT('pgStreaming') : '🟢 ' + pgT('pgIdle')) + '</span>' +
  '</div>';
  var tabsHtml = '<div class="pg-tabs">' +
    '<button class="pg-tab' + (w.debugTab === 'preview' ? ' active' : '') + '" data-tab="preview" onclick="pgSetDebugModalTab(' + winIdx + ',\'preview\')">👁 ' + pgEscapeHtml(pgT('pgDebugTabPreview')) + customBadge + '</button>' +
    '<button class="pg-tab' + (w.debugTab === 'request' ? ' active' : '') + '" data-tab="request" onclick="pgSetDebugModalTab(' + winIdx + ',\'request\')">📤 ' + pgEscapeHtml(pgT('pgDebugTabRequest')) + '</button>' +
    '<button class="pg-tab' + (w.debugTab === 'response' ? ' active' : '') + '" data-tab="response" onclick="pgSetDebugModalTab(' + winIdx + ',\'response\')">⚡ ' + pgEscapeHtml(pgT('pgDebugTabResponse')) + responseBadge + '</button>' +
  '</div>';
  var bodyHtml = '<div class="pg-modal-body">' +
    metaHtml + tabsHtml +
    '<div class="pg-tab-content" id="pg-debug-modal-content"></div>' +
    '<div class="pg-debug-footer" id="pg-debug-modal-footer"></div>' +
  '</div>';
  pgShowModal(headerHtml + bodyHtml);
  pgRenderDebugModalContent(winIdx);
}

function pgRenderDebugModalContent(winIdx) {
  var container = document.getElementById('pg-debug-modal-content');
  if (!container) return;
  var w = pgWinAt(winIdx);
  if (!w) return;
  var html = '';
  var tab = w.debugTab;
  if (tab === 'preview') {
    html = pgCodeViewer(w.debugPreview, 'preview');
  } else if (tab === 'request') {
    html = pgCodeViewer(w.debugRequest, 'request');
  } else if (tab === 'response') {
    if (w.sseEvents && w.sseEvents.length) {
      html = pgSSEViewer(w.sseEvents);
    } else {
      html = pgCodeViewer(w.debugResponse, 'response');
    }
  }
  container.innerHTML = html;
  var footer = document.getElementById('pg-debug-modal-footer');
  if (footer) {
    var ts = (tab === 'preview') ? w.debugPreviewTimestamp : w.debugTimestamp;
    if (ts) {
      var label = (tab === 'preview') ? pgT('pgDebugPreviewUpdated') : pgT('pgDebugLastRequest');
      footer.textContent = label + ': ' + new Date(ts).toLocaleString();
    } else {
      footer.textContent = '';
    }
  }
}

function pgSetDebugModalTab(winIdx, tab) {
  var w = pgWinAt(winIdx);
  if (!w) return;
  w.debugTab = tab;
  var modalTabs = document.querySelectorAll('#pg-modal-overlay .pg-tab');
  modalTabs.forEach(function(el) { el.classList.toggle('active', el.dataset.tab === tab); });
  pgRenderDebugModalContent(winIdx);
}

function pgShowImageModal(url, savedPath, savedFilename) {
  var html = '<div class="pg-modal-header">' +
    '<span class="pg-modal-title">&#x1F5BC; ' + pgEscapeHtml(pgT('pgImagePreview')) + '</span>' +
    '<span class="pg-modal-header-actions">' +
      '<button class="pg-img-btn" onclick="pgCopyImage(\'' + pgEscapeAttr(url) + '\', this)" data-tooltip="' + pgEscapeHtml(pgT('pgCopy')) + '">' + pgEscapeHtml(pgT('pgCopy')) + '</button>' +
      '<button class="pg-img-btn" onclick="pgSaveImage(\'' + pgEscapeAttr(url) + '\', this)" data-tooltip="' + pgEscapeHtml(pgT('pgSave')) + '">' + pgEscapeHtml(pgT('pgSave')) + '</button>' +
      '<button class="pg-img-btn" id="pg-img-reset-btn" onclick="pgResetImageZoom()" data-tooltip="' + pgEscapeHtml(pgT('pgReset')) + '" style="display:none">' + pgEscapeHtml(pgT('pgReset')) + '</button>' +
      '<button class="pg-modal-close" onclick="pgCloseModal()">✕</button>' +
    '</span>' +
  '</div>' +
  '<div class="pg-modal-body" id="pg-img-modal-body" style="display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;padding:0;cursor:default">' +
    '<img src="' + pgEscapeHtml(url) + '" crossorigin="anonymous" alt="image" id="pg-img-modal-img" data-url="' + pgEscapeAttr(url) + '" style="border-radius:4px;transform-origin:center center;display:block">' +
  '</div>' +
  '<div class="pg-img-modal-footer" id="pg-img-footer">' +
    '<span id="pg-img-meta-res">—</span>' +
    '<span class="pg-img-meta-sep">·</span>' +
    '<span id="pg-img-meta-size">—</span>' +
    '<span class="pg-img-meta-sep">·</span>' +
    '<span id="pg-img-meta-fmt">—</span>' +
    '<span class="pg-img-meta-sep" id="pg-img-meta-path-sep" style="display:none">·</span>' +
    '<span id="pg-img-meta-path" style="display:none;opacity:0.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:360px"></span>' +
  '</div>';
  pgShowModal(html);
  requestAnimationFrame(function() {
    var modal = document.querySelector('#pg-modal-overlay .pg-modal');
    if (modal) {
      modal.style.width = '90vw';
      modal.style.height = '90vh';
      modal.style.maxWidth = '95vw';
      modal.style.maxHeight = '95vh';
    }
    pgInitImageZoom();
    pgRefreshImageModalMeta(url, savedPath, savedFilename);
  });
}

var pgZoomResizeHandler = null;
var pgZoomMouseMoveHandler = null;
var pgZoomMouseUpHandler = null;

function pgInitImageZoom() {
  var img = document.getElementById('pg-img-modal-img');
  var body = document.getElementById('pg-img-modal-body');
  var resetBtn = document.getElementById('pg-img-reset-btn');
  if (!img || !body) return;

  // Calculate the auto-fit scale: the scale at which the image fits the container
  function calcFitScale() {
    if (!img.naturalWidth || !img.naturalHeight) return 1;
    var bw = body.clientWidth;
    var bh = body.clientHeight;
    if (!bw || !bh) return 1;
    var scaleW = bw / img.naturalWidth;
    var scaleH = bh / img.naturalHeight;
    return Math.min(scaleW, scaleH);
  }

  var fitScale = 1;
  var scale = 1;
  var translateX = 0;
  var translateY = 0;
  var isDragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var dragTranslateX = 0;
  var dragTranslateY = 0;

  function applyTransform() {
    img.style.transform = 'scale(' + scale + ') translate(' + translateX + 'px, ' + translateY + 'px)';
    body.style.cursor = scale > fitScale ? (isDragging ? 'grabbing' : 'grab') : 'default';
    if (resetBtn) resetBtn.style.display = scale > fitScale ? '' : 'none';
  }

  function reset() {
    scale = fitScale;
    translateX = 0;
    translateY = 0;
    applyTransform();
  }

  // Wait for image to load to get natural dimensions
  function init() {
    function loadMeta() {
      var resEl = document.getElementById('pg-img-meta-res');
      if (resEl) resEl.textContent = img.naturalWidth + ' × ' + img.naturalHeight;
      pgLoadImageMeta(img.getAttribute('data-url'));
    }
    if (img.naturalWidth && img.naturalHeight) {
      fitScale = calcFitScale();
      scale = fitScale;
      applyTransform();
      loadMeta();
    } else {
      img.addEventListener('load', function() {
        fitScale = calcFitScale();
        scale = fitScale;
        applyTransform();
        loadMeta();
      }, { once: true });
    }
  }

  // Recalculate fit scale on window resize
  var resizeTimer;
  pgZoomResizeHandler = function() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
      var prevFit = fitScale;
      fitScale = calcFitScale();
      if (scale <= prevFit) { scale = fitScale; translateX = 0; translateY = 0; }
      applyTransform();
    }, 150);
  };
  window.addEventListener('resize', pgZoomResizeHandler);

  body.addEventListener('wheel', function(e) {
    e.preventDefault();
    var delta = e.deltaY > 0 ? -0.08 : 0.08;
    var newScale = Math.max(fitScale, Math.min(10, scale + delta));
    // Zoom centered on image center
    var ratio = newScale / scale;
    translateX *= ratio;
    translateY *= ratio;
    scale = newScale;
    applyTransform();
  });

  body.addEventListener('mousedown', function(e) {
    if (scale <= fitScale || e.button !== 0) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragTranslateX = translateX;
    dragTranslateY = translateY;
    body.style.cursor = 'grabbing';
    e.preventDefault();
  });

  pgZoomMouseMoveHandler = function(e) {
    if (!isDragging) return;
    translateX = dragTranslateX + (e.clientX - dragStartX) / scale;
    translateY = dragTranslateY + (e.clientY - dragStartY) / scale;
    applyTransform();
  };
  window.addEventListener('mousemove', pgZoomMouseMoveHandler);

  pgZoomMouseUpHandler = function() {
    if (isDragging) {
      isDragging = false;
      body.style.cursor = scale > fitScale ? 'grab' : 'default';
    }
  };
  window.addEventListener('mouseup', pgZoomMouseUpHandler);

  // Expose reset for the button onclick
  window.pgResetImageZoom = reset;

  init();
}

function pgRemoveZoomListeners() {
  if (pgZoomResizeHandler) { window.removeEventListener('resize', pgZoomResizeHandler); pgZoomResizeHandler = null; }
  if (pgZoomMouseMoveHandler) { window.removeEventListener('mousemove', pgZoomMouseMoveHandler); pgZoomMouseMoveHandler = null; }
  if (pgZoomMouseUpHandler) { window.removeEventListener('mouseup', pgZoomMouseUpHandler); pgZoomMouseUpHandler = null; }
}

function pgCopyImage(url, btn) {
  var orig = btn ? btn.textContent : '';
  if (btn) btn.textContent = '...';

  function writePngBlob(blob) {
    if (!blob) {
      if (btn) btn.textContent = orig;
      pgToast(pgT('pgImageCopyFailed') || 'Copy failed', 'error');
      return;
    }
    try {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function() {
        if (btn) {
          btn.textContent = pgT('pgCopied');
          setTimeout(function() { btn.textContent = orig; }, 1500);
        } else {
          pgToast(pgT('pgCopied'), 'success');
        }
      }).catch(function() {
        if (btn) btn.textContent = orig;
        pgToast(pgT('pgImageCopyFailed') || 'Copy failed', 'error');
      });
    } catch (e) {
      if (btn) btn.textContent = orig;
      pgToast(pgT('pgImageCopyFailed') || 'Copy failed', 'error');
    }
  }

  function fallbackViaProxy() {
    if (url.indexOf('data:') === 0) {
      if (btn) btn.textContent = orig;
      pgToast(pgT('pgImageCopyFailed') || 'Copy failed', 'error');
      return;
    }
    fetch(pgImageProxyURL(url)).then(function(r) {
      if (!r.ok) throw new Error('proxy fetch failed');
      return r.blob();
    }).then(function(blob) {
      var blobUrl = URL.createObjectURL(blob);
      var proxyImg = new Image();
      proxyImg.onload = function() {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = proxyImg.naturalWidth || proxyImg.width;
          canvas.height = proxyImg.naturalHeight || proxyImg.height;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(proxyImg, 0, 0);
          canvas.toBlob(writePngBlob, 'image/png');
        } catch (e) {
          if (btn) btn.textContent = orig;
          pgToast(pgT('pgImageCopyFailed') || 'Copy failed', 'error');
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      };
      proxyImg.onerror = function() {
        URL.revokeObjectURL(blobUrl);
        if (btn) btn.textContent = orig;
        pgToast(pgT('pgImageCopyFailed') || 'Copy failed', 'error');
      };
      proxyImg.src = blobUrl;
    }).catch(function() {
      if (btn) btn.textContent = orig;
      pgToast(pgT('pgImageCopyFailed') || 'Copy failed', 'error');
    });
  }

  function drawToCanvasAndWrite(img) {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(function(blob) {
        if (!blob) {
          fallbackViaProxy();
          return;
        }
        writePngBlob(blob);
      }, 'image/png');
    } catch (e) {
      fallbackViaProxy();
    }
  }

  var imgModal = document.getElementById('pg-img-modal-img');
  if (imgModal && imgModal.complete && imgModal.naturalWidth && (imgModal.dataset.url === url || imgModal.src === url)) {
    drawToCanvasAndWrite(imgModal);
    return;
  }

  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = function() { drawToCanvasAndWrite(img); };
  img.onerror = function() { fallbackViaProxy(); };
  img.src = url;
}

function pgImageProxyURL(url) {
  return '/api/image-proxy?url=' + encodeURIComponent(url);
}

function pgFormatBytes(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function pgExtFromUrl(url) {
  var m = url.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
  return m ? m[1].toLowerCase() : '';
}

// pgLoadImageMeta fills the preview footer with resolution (set by caller), file
// size and format. For data: URLs it is computed client-side; for remote URLs
// the bytes are fetched via the same-origin proxy to read size + mime type.
function pgLoadImageMeta(url) {
  if (!url) return;
  var sizeEl = document.getElementById('pg-img-meta-size');
  var fmtEl = document.getElementById('pg-img-meta-fmt');
  if (url.indexOf('data:') === 0) {
    var mm = url.match(/^data:([^;]+)/);
    var mime = mm ? mm[1] : 'image';
    if (fmtEl) fmtEl.textContent = mime.split('/').pop().toUpperCase();
    var comma = url.indexOf(',');
    var b64 = comma >= 0 ? url.slice(comma + 1) : '';
    var pad = (b64.match(/=+$/) || [''])[0].length;
    var bytes = Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
    if (sizeEl) sizeEl.textContent = pgFormatBytes(bytes);
    return;
  }
  fetch(pgImageProxyURL(url)).then(function(r) {
    if (!r.ok) throw new Error('fetch failed');
    return r.blob();
  }).then(function(blob) {
    if (sizeEl) sizeEl.textContent = pgFormatBytes(blob.size);
    if (fmtEl) {
      var mt = blob.type || '';
      fmtEl.textContent = mt ? mt.split('/').pop().toUpperCase() : (pgExtFromUrl(url).toUpperCase() || '—');
    }
  }).catch(function() {
    if (fmtEl) fmtEl.textContent = (pgExtFromUrl(url).toUpperCase() || '—');
  });
}

function pgRefreshImageModalMeta(url, savedPath, savedFilename) {
  var pathEl = document.getElementById('pg-img-meta-path');
  var sepEl = document.getElementById('pg-img-meta-path-sep');
  var imgModal = document.getElementById('pg-img-modal-img');
  if (!pathEl) return;
  if (imgModal && imgModal.dataset.url !== url && imgModal.src !== url) return;
  var displayPath = savedFilename || savedPath || '';
  if (displayPath) {
    if (sepEl) sepEl.style.display = 'inline';
    pathEl.style.display = 'inline';
    pathEl.textContent = '📁 ' + displayPath;
    pathEl.setAttribute('data-tooltip', savedPath || displayPath);
  } else {
    if (sepEl) sepEl.style.display = 'none';
    pathEl.style.display = 'none';
  }
}

function pgCopyImageFallback(url, btn) {
  // Fallback: copy URL as text
  var orig = btn.textContent;
  navigator.clipboard.writeText(url).then(function() {
    btn.textContent = pgT('pgCopied');
    setTimeout(function() { btn.textContent = orig; }, 1500);
  }).catch(function() {});
}

function pgSaveImage(url, btn) {
  var orig = btn.textContent;
  btn.textContent = '...';
  pgApiPost('/save-image', { url: url }).then(function(res) {
    btn.textContent = orig;
    pgToast(pgT('pgImageSaved', [res.filename || res.path]), 'success');
    pgRefreshImageModalMeta(url, res.path, res.filename);
  }).catch(function(err) {
    btn.textContent = orig;
    pgToast(pgT('pgImageSaveFailed'), 'error');
  });
}

// ----- Edit Resolutions modal (per-model custom size list) -----
// Saves the custom list to the model via PATCH /api/providers/{id}/models/imgSizes
// and updates pgState.models[].imgSizes so pgRenderImageParams picks it up
// on the next re-render without refetching /api/models.
function pgOpenImgSizesModal() {
  var w = pgWin();
  if (!w || !w.config.model) { pgToast(pgT('pgSelectModel'), 'info'); return; }
  var info = pgGetModelInfo(w.config.model);
  if (!info) { pgToast(pgT('pgSelectModel'), 'info'); return; }
  var proto = (info.kind === 'image' && info.imgProtocol) ? info.imgProtocol : 'gpt';
  var builtin = pgImgBuiltinSizesFor(proto);
  var current = (info.imgSizes && info.imgSizes.length) ? info.imgSizes.slice() : builtin.slice();
  var hint = pgT('pgImgEditSizesHint');
  var modelLabel = pgEscapeHtml(w.config.model);
  var html = '<div class="pg-modal" style="width:420px;max-width:90vw">' +
    '<div class="pg-modal-header">' +
      '<span class="pg-modal-title">' + pgEscapeHtml(pgT('pgImgEditSizesTitle')) + '</span>' +
      '<button class="pg-modal-close" onclick="pgCloseModal()">✕</button>' +
    '</div>' +
    '<div class="pg-modal-body" style="padding:16px;max-height:60vh;overflow-y:auto">' +
      '<div style="opacity:0.7;font-size:12px;margin-bottom:6px">' + modelLabel + '</div>' +
      '<div style="opacity:0.6;font-size:12px;margin-bottom:8px">' + pgEscapeHtml(hint) + '</div>' +
      '<textarea id="pg-imgsizes-text" style="width:100%;min-height:200px;font-family:var(--font-mono,monospace);font-size:13px;padding:8px;resize:vertical;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);box-sizing:border-box" placeholder="1024x1024&#10;2560x3840&#10;3840x2560">' + pgEscapeHtml(current.join('\n')) + '</textarea>' +
    '</div>' +
    '<div class="pg-modal-footer" style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="pg-btn" id="pg-imgsizes-reset" onclick="pgResetImgSizesTextarea()">' + pgEscapeHtml(pgT('Reset')) + '</button>' +
      '<button class="pg-btn" onclick="pgCloseModal()">' + pgEscapeHtml(pgT('Cancel')) + '</button>' +
      '<button class="pg-btn" id="pg-imgsizes-ok" style="background:var(--accent);color:#fff" onclick="pgSaveImgSizesModal()">' + pgEscapeHtml(pgT('OK')) + '</button>' +
    '</div>' +
  '</div>';
  pgShowModal(html);
  // Unset Old sizes info into a global so pgResetImgSizesTextarea can restore defaults.
  window.__pgImgSizesBuiltin = builtin;
  // Focus the textarea.
  var ta = document.getElementById('pg-imgsizes-text');
  if (ta) setTimeout(function() { ta.focus(); }, 30);
}

function pgResetImgSizesTextarea() {
  var builtin = window.__pgImgSizesBuiltin || [];
  var ta = document.getElementById('pg-imgsizes-text');
  if (ta) ta.value = builtin.join('\n');
}

function pgSaveImgSizesModal() {
  var w = pgWin();
  if (!w || !w.config.model) return;
  var info = pgGetModelInfo(w.config.model);
  if (!info || !info.providerId) { pgToast(pgT('pgImgErrorModelMeta'), 'error'); return; }
  var ta = document.getElementById('pg-imgsizes-text');
  var text = ta ? ta.value : '';
  var parts = text.split('\n').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
  // Basic format check: every entry must match ^\d+x\d+$.
  var invalid = [];
  for (var i = 0; i < parts.length; i++) {
    if (!/^\d+x\d+$/.test(parts[i])) invalid.push(parts[i]);
  }
  if (invalid.length) {
    pgToast(pgT('pgImgCustomSizeFormat') + ' (' + invalid.join(', ') + ')', 'error');
    return;
  }
  var okBtn = document.getElementById('pg-imgsizes-ok');
  var orig = okBtn ? okBtn.textContent : '';
  if (okBtn) { okBtn.disabled = true; okBtn.textContent = '...'; }
  pgApiPatch('/providers/' + encodeURIComponent(info.providerId) + '/models/imgSizes', {
    model: info.realModelId || pgImgResolveModelID(info.id),
    imgSizes: parts,
  }).then(function(res) {
    if (okBtn) { okBtn.disabled = false; okBtn.textContent = orig; }
    if (res && res.ok) {
      info.imgSizes = parts;
      pgCloseModal();
      pgRenderSidebar();
      pgRenderPanes();
      pgToast(pgT('pgImgSizesSaved'), 'info');
    } else {
      pgToast(pgT('pgImgSizesSaveFailed'), 'error');
    }
  }).catch(function(err) {
    if (okBtn) { okBtn.disabled = false; okBtn.textContent = orig; }
    pgToast(pgT('pgImgSizesSaveFailed') + ': ' + (err && err.message ? err.message : String(err)), 'error');
  });
}

// pgImgResolveModelID converts the display id ("ll/gpt-image-2-2k") back to the
// raw model id the PATCH endpoint expects (the Alias-stripped form, e.g.
// "gpt-image-2-2k"). The /api/models feed always exposes the alias if set,
// but the backend matches ModelDef.ID, so we strip the provider prefix and
// consult Registry.ResolveModelAlias indirectly: the registry lookup is done
// server-side, so we send the ID as displayed and trust the server to match.
// Model alias display IDs are sent as-is; the registry resolves via both ID
// and alias. We send the part after the provider '/' prefix as the model id.
function pgImgResolveModelID(displayId) {
  if (!displayId) return '';
  var slash = displayId.indexOf('/');
  return slash >= 0 ? displayId.slice(slash + 1) : displayId;
}

// pgImgBuiltinSizesFor returns the hardcoded default size list for a protocol
// so the edit modal can prefill when no custom list is set yet.
// GPT modal builtin concrete defaults only: exact four sizes.
// xAI and ModelScope defaults are unchanged.
function pgImgBuiltinSizesFor(proto) {
  if (proto === 'modelscope') {
    return ['1024x1024', '1280x720', '720x1280', '1024x768', '768x1024'];
  }
  return ['1024x1024', '1200x675', '928x1664', '3000x1000'];
}

// ----- Model picker modal (separate overlay, stacks on top) ---
var pgModelPickerCallback = null;

function pgOpenModelPicker(currentValue, onSelect, opts) {
  pgModelPickerCallback = onSelect;
  var allowEmpty = opts && opts.allowEmpty;
  var emptyLabel = (opts && opts.emptyLabel) || pgT('Default (first window model)');
  var title = (opts && opts.title) || pgT('pgSelectModel');
  var itemsHtml = '';
  if (allowEmpty) {
    itemsHtml += '<div class="pg-model-picker-item' + (!currentValue ? ' selected' : '') + '" data-value="" tabindex="-1" onclick="pgModelPickerSelect(this)">' + pgEscapeHtml(emptyLabel) + '</div>';
  }
  var kindFilter = opts && opts.kindFilter;
  var models = (pgState.models || []).filter(function(m) {
    if (!kindFilter) return true;
    if (kindFilter === 'image') return m.kind === 'image';
    return m.kind !== 'image';
  });
  if (!models.length && !allowEmpty) {
    itemsHtml = '<div style="padding:20px;text-align:center;opacity:0.6">' + pgEscapeHtml(pgT('No models available')) + '</div>';
  }
  models.forEach(function(m) {
    var id = m.id;
    var label = m.id + (m.provider ? ' (' + m.provider + ')' : '');
    var note = m.note || '';
    var cls = 'pg-model-picker-item';
    if (currentValue === id) cls += ' selected';
    if (note) { cls += ' has-model-note'; }
    var noteAttr = note ? ' data-model-note="' + pgEscapeHtml(note) + '"' : '';
    itemsHtml += '<div class="' + cls + '"' + noteAttr + ' data-value="' + pgEscapeHtml(id) + '" tabindex="-1" onclick="pgModelPickerSelect(this)">' + pgEscapeHtml(label) + '</div>';
  });
  var html = '<div class="pg-modal" style="width:400px;max-width:90vw">' +
    '<div class="pg-modal-header">' +
      '<span class="pg-modal-title">' + pgEscapeHtml(title) + '</span>' +
      '<button class="pg-modal-close" onclick="pgCloseModelPicker()">✕</button>' +
    '</div>' +
    '<div class="pg-modal-body" style="max-height:50vh;overflow-y:auto">' +
      '<input type="text" id="pg-model-picker-filter" placeholder="' + pgEscapeHtml(pgT('Filter')) + '" oninput="pgModelPickerFilter(this.value)" style="width:100%;padding:6px 8px;margin-bottom:8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font-size:13px;box-sizing:border-box">' +
      itemsHtml +
    '</div>' +
    '<div class="pg-modal-footer" style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="pg-btn" id="pg-model-picker-cancel" onclick="pgCloseModelPicker()">' + pgEscapeHtml(pgT('Cancel')) + '</button>' +
      '<button class="pg-btn" id="pg-model-picker-ok" style="background:var(--accent);color:#fff" onclick="pgModelPickerConfirm()">' + pgEscapeHtml(pgT('OK')) + '</button>' +
    '</div>' +
  '</div>';
  var overlay = document.createElement('div');
  overlay.id = 'pg-model-picker-overlay';
  overlay.className = 'pg-modal-overlay show';
  overlay.style.zIndex = '10001';
  overlay.innerHTML = html;
  overlay.addEventListener('keydown', pgModelPickerKeydown);
  document.body.appendChild(overlay);
  var filterEl = document.getElementById('pg-model-picker-filter');
  if (filterEl) filterEl.focus();
}

function pgCloseModelPicker() {
  var overlay = document.getElementById('pg-model-picker-overlay');
  if (overlay) overlay.remove();
  pgModelPickerCallback = null;
}

function pgModelPickerSelect(el) {
  var overlay = document.getElementById('pg-model-picker-overlay');
  if (!overlay) return;
  var items = overlay.querySelectorAll('.pg-model-picker-item');
  for (var i = 0; i < items.length; i++) items[i].classList.remove('selected');
  el.classList.add('selected');
}

function pgModelPickerConfirm() {
  var overlay = document.getElementById('pg-model-picker-overlay');
  if (!overlay) return;
  var selected = overlay.querySelector('.pg-model-picker-item.selected');
  var value = selected ? selected.getAttribute('data-value') : '';
  var cb = pgModelPickerCallback;
  pgCloseModelPicker();
  if (cb) cb(value);
}

function pgModelPickerFilter(query) {
  var overlay = document.getElementById('pg-model-picker-overlay');
  if (!overlay) return;
  var q = (query || '').toLowerCase();
  var items = overlay.querySelectorAll('.pg-model-picker-item');
  for (var i = 0; i < items.length; i++) {
    var text = (items[i].textContent || '').toLowerCase();
    items[i].style.display = q && text.indexOf(q) < 0 ? 'none' : '';
  }
}

function pgModelPickerVisibleItems() {
  var overlay = document.getElementById('pg-model-picker-overlay');
  if (!overlay) return [];
  var items = overlay.querySelectorAll('.pg-model-picker-item');
  var visible = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].style.display !== 'none') visible.push(items[i]);
  }
  return visible;
}

function pgModelPickerSelectedIndex(visible) {
  for (var i = 0; i < visible.length; i++) {
    if (visible[i].classList.contains('selected')) return i;
  }
  return -1;
}

function pgModelPickerKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pgCloseModelPicker(); return; }
  if (e.key === 'Enter') { e.preventDefault(); pgModelPickerConfirm(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    var visible = pgModelPickerVisibleItems();
    if (!visible.length) return;
    var curIdx = pgModelPickerSelectedIndex(visible);
    var nextIdx;
    if (e.key === 'ArrowDown') {
      nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % visible.length;
    } else {
      nextIdx = curIdx <= 0 ? visible.length - 1 : curIdx - 1;
    }
    pgModelPickerSelect(visible[nextIdx]);
    visible[nextIdx].focus();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    var filter = document.getElementById('pg-model-picker-filter');
    if (filter && filter === document.activeElement) {
      var visible = pgModelPickerVisibleItems();
      if (visible.length) {
        var curIdx = pgModelPickerSelectedIndex(visible);
        visible[curIdx >= 0 ? curIdx : 0].focus();
      }
    } else {
      if (filter) filter.focus();
    }
    return;
  }
  if (e.key.length === 1 && e.key.match(/[a-z0-9]/i) && !e.ctrlKey && !e.altKey && !e.metaKey) {
    var filterEl = document.getElementById('pg-model-picker-filter');
    if (filterEl && filterEl === document.activeElement) return;
    e.preventDefault();
    var visible = pgModelPickerVisibleItems();
    if (!visible.length) return;
    var ch = e.key.toLowerCase();
    var curIdx = pgModelPickerSelectedIndex(visible);
    var startIdx = curIdx >= 0 ? curIdx : -1;
    for (var i = 0; i < visible.length; i++) {
      var idx = (startIdx + 1 + i) % visible.length;
      var text = (visible[idx].textContent || '').toLowerCase().trim();
      if (text.charAt(0) === ch) {
        pgModelPickerSelect(visible[idx]);
        visible[idx].focus();
        return;
      }
    }
    return;
  }
}