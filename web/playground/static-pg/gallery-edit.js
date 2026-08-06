// gallery-edit.js — Gallery media editor modal (ffmpeg-based image/video transformations).
// Exposes window.openMediaEditor(item, mediaType) and window.cleanupMediaEditor().
// Backend: internal/api/gallery/edit_handlers.go + zip_handlers.go.

'use strict';

// ---------- editor state -------------------------------------------
var _editJobId = null;
var _editPollTimer = null;
var _editCurrentItem = null;
var _editMediaType = null;
var _editProbe = null;
var _editSubtitlePath = null;
var _geVidFormat = 'mp4';           // last selected video transcode format (mp4/mkv/webm/mov/gif/webp); persists across the trim-mode modal rebuild
var _geActiveJob = null;            // tracks in-progress job so close/switch doesn't lose it (see _geResumeActive)
var _geBatchPollingEnabled = false; // gates batch poll chains (false on page leave)
var _geConsoleRO = null;            // ResizeObserver syncing console panel height → left modal
var _geGearSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
var _geImageSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
var _geFolderSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
var _geBrowseSvg = _geFolderSvg;

// ---------- image source-info + archive helpers --------------------
// _isArchiveMode reports whether the image|archive header toggle is on
// (convert all images in the folder/archive) vs single-image mode.
function _isArchiveMode() {
  var t = document.getElementById('ge-archive-toggle');
  return !!(t && t.getAttribute('data-archive') === '1');
}

// _editContainerPath returns the disk path of the item's container (the
// archive/folder the image belongs to) for source-info row 1 — the zip's full
// path (+ " › inner folder" when includeInner), or the folder path. Returns ''
// when no disk path is available (FSAA drag-drop: zip without zipAbsPath, or
// kind 'fs' — the browser hides disk paths for dropped handles), so the caller
// shows a "no path" hint instead of the file name.
function _editContainerPath(it, includeInner) {
  if (!it) return '';
  if (it.kind === 'zip') {
    if (!it.zipAbsPath) return '';
    var base = it.zipAbsPath;
    if (includeInner && it.zipPath) {
      var segs = it.zipPath.split('/');
      segs.pop();
      var inner = segs.join('/');
      if (inner) base += ' \u203a ' + inner;
    }
    return base;
  }
  if (it.kind === 'backend') return it.rootDirPath || (it.absPath ? it.absPath.replace(/[\\/][^\\/]*$/, '') : '') || '';
  if (it.kind === 'fs') return '';
  if (it.kind === 'plain') return (it.path ? it.path.replace(/[\\/][^\\/]*$/, '') : '') || '';
  return it.path || it.name || '';
}

// _editContainerParentPath returns the parent directory of the item's
// container (the zip file's folder, or a folder's parent) — what the user
// wants in archive row1 (the "where it lives" directory; row2 carries the
// container name, so row1+row2 reconstructs the container path). Includes a
// trailing separator. Returns '' when no disk path is available (FSAA drag-
// drop items), so the caller can fall back to the container identifier.
function _editContainerParentPath(it) {
  if (!it) return '';
  var p = '';
  if (it.kind === 'zip') p = it.zipAbsPath || '';
  else if (it.kind === 'backend') p = it.rootDirPath || (it.absPath ? it.absPath.replace(/[\\/][^\\/]*$/, '') : '');
  else if (it.kind === 'plain') p = (it.path ? it.path.replace(/[\\/][^\\/]*$/, '') : '');
  if (!p) return '';
  var idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (idx <= 0) return ''; // root — no parent
  return p.substring(0, idx + 1); // keep the trailing separator
}

// _batchOriginLabel returns the folder/archive display name (archive mode).
function _batchOriginLabel() {
  var it = _editCurrentItem;
  if (!it) return '';
  if (it.kind === 'zip') {
    return it.zipAbsPath ? it.zipAbsPath.split(/[\\/]/).pop() : ((it.path || '').split('/')[0] || it.name || '');
  }
  if (it.kind === 'fs' && it.rootDirHandle) return it.rootDirHandle.name || it.name || '';
  if (it.kind === 'backend' && it.rootDirPath) return it.rootDirPath.split(/[\\/]/).pop() || it.name || '';
  return it.name || it.path || '';
}

// _formatSize renders a byte count as B/KB/MB.
function _formatSize(b) {
  if (!b || b <= 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// _updateImageSourceInfo populates the two-row source-info block from the
// current item + probe. In archive mode it shows the folder/archive path +
// name + image count; in single mode the file path + name/dims/size/ext.
function _updateImageSourceInfo() {
  var row1 = document.getElementById('ge-img-src-row1');
  var row2 = document.getElementById('ge-img-src-row2');
  if (!row1 || !row2) return;
  var it = _editCurrentItem;
  if (!it) { row1.textContent = '-'; row2.textContent = '-'; return; }
  if (_isArchiveMode()) {
    row1.textContent = _editContainerParentPath(it) || _editContainerPath(it, false) || T('geDragNoPathHint');
    row2.innerHTML = '<div class="ge-src-filename">' + escapeHtml((_batchOriginLabel() || '-') + ' \u00b7 ' + _getSiblingImages().length + ' ' + T('geImagesCount')) + '</div>';
    return;
  }
  row1.textContent = _editContainerPath(it, true) || T('geDragNoPathHint');
  var probe = _editProbe || {};
  var nm = it.name || (it.path || '').split('/').pop() || '';
  var metaParts = [];
  if (probe.width && probe.height) metaParts.push(probe.width + '\u00d7' + probe.height);
  if (it.size && it.size > 0) metaParts.push(_formatSize(it.size));
  var metaRightStr = metaParts.join(' \u00b7 ');

  row2.innerHTML = '<div class="ge-src-filename">' + escapeHtml(nm || '-') + '</div>'
    + (metaRightStr ? '<div class="ge-src-meta-right">' + escapeHtml(metaRightStr) + '</div>' : '');
}

// _updateVideoSourceInfo populates the video dialog's two-row source info:
// row1 = the file's disk path (or the "no disk path" hint for drag-dropped
// items), row2 = name + resolution + codec + duration + (no audio) + size.
function _updateVideoSourceInfo() {
  var row1 = document.getElementById('ge-vid-src-row1');
  var row2 = document.getElementById('ge-vid-src-row2');
  if (!row1 || !row2) return;
  var it = _editCurrentItem;
  if (!it) { row1.textContent = '-'; row2.textContent = '-'; return; }
  row1.textContent = _editVideoPath(it) || T('geDragNoPathHint');
  var probe = _editProbe || {};
  var nm = it.name || (it.path || '').split('/').pop() || '';
  var metaParts = [];
  if (probe.width && probe.height) metaParts.push(probe.width + '×' + probe.height);
  if (probe.codec) metaParts.push(probe.codec);
  if (probe.duration != null && probe.duration > 0) metaParts.push(formatTime(probe.duration));
  if (probe.hasAudio === false) metaParts.push(T('geNoAudio'));
  if (it.size && it.size > 0) metaParts.push(_formatSize(it.size));
  var metaRightStr = metaParts.join(' · ');

  row2.innerHTML = '<div class="ge-src-filename">' + escapeHtml(nm || '-') + '</div>'
    + (metaRightStr ? '<div class="ge-src-meta-right">' + escapeHtml(metaRightStr) + '</div>' : '');
}

// _editVideoPath returns the disk path of a video item for source-info row 1:
// backend → its absolute path; plain (download) → its disk path; zip → the
// archive path; fs (drag-drop) → '' (browser hides the path → hint shown).
function _editVideoPath(it) {
  if (!it) return '';
  if (it.kind === 'zip') return it.zipAbsPath || '';
  if (it.kind === 'backend') return it.rootDirPath || (it.absPath ? it.absPath.replace(/[\\/][^\\/]*$/, '') : '') || '';
  if (it.kind === 'plain') return (it.path || it.absPath || '').replace(/[\\/][^\\/]*$/, '');
  if (it.kind === 'fs') return '';
  return (it.path || it.absPath || '').replace(/[\\/][^\\/]*$/, '');
}

function _geConsoleBlock(jobId, label) {
  var log = document.getElementById('ge-console-log');
  if (!log) return null;
  var block = log.querySelector('.ge-console-block[data-job="' + jobId + '"]');
  if (!block) {
    block = document.createElement('div');
    block.className = 'ge-console-block';
    block.setAttribute('data-job', jobId);
    if (label) {
      var head = document.createElement('div');
      head.className = 'ge-console-block-head';
      head.textContent = label;
      block.appendChild(head);
    }
    var cmd = document.createElement('div');
    cmd.className = 'ge-console-block-cmd';
    block.appendChild(cmd);
    var pre = document.createElement('pre');
    pre.className = 'ge-console-block-log';
    block.appendChild(pre);
    log.appendChild(block);
  }
  return block;
}

function _geEnsureConsole() {
  var overlay = document.getElementById('pg-modal-overlay');
  if (!overlay || document.getElementById('ge-console-panel')) return;
  var cp = document.createElement('div');
  cp.id = 'ge-console-panel';
  cp.className = 'pg-modal ge-console-panel';
  cp.style.display = 'none';
  cp.innerHTML = '<div class="pg-modal-header">'
    + '<span class="pg-modal-title ge-title-center">' + escapeHtml(T('geConsole')) + '</span>'
    + '<button class="pg-modal-close" id="ge-console-close-btn">\u2715</button>'
    + '</div>'
    + '<div class="pg-modal-body" style="padding:0;display:flex;flex-direction:column;overflow:hidden">'
    + '<div id="ge-console-cmd" style="padding:8px 12px;font-family:monospace;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--glass-border);white-space:pre-wrap;word-break:break-all;flex-shrink:0"></div>'
    + '<pre id="ge-console-log" class="dl-detail-log ge-console-log" style="flex:1;border-left:none;min-height:0"></pre>'
    + '</div>';
  overlay.appendChild(cp);
  var closeBtn = document.getElementById('ge-console-close-btn');
  if (closeBtn) closeBtn.onclick = function() { cp.style.display = 'none'; };
  _geWatchConsoleHeight();
}


// Format seconds to HH:MM:SS.
function _formatSecToTime(secs) {
  if (!isFinite(secs) || secs < 0) return '00:00:00';
  var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = Math.floor(secs % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ---------- polling -------------------------------------------------
function _startPolling(jobId) {
  _stopPolling();
  _editPollTimer = setInterval(function() {
    fetch('/api/gallery/edit/status/' + encodeURIComponent(jobId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        _updateProgress(data);
        if (data.status === 'completed') { _onCompleted(data); }
        else if (data.status === 'error') { _onError(data); }
        else if (data.status === 'cancelled') { _onCancelled(); }
      })
      .catch(function(err) { console.warn('Media edit polling error:', err); });
  }, 600);
}

function _stopPolling() {
  if (_editPollTimer) { clearInterval(_editPollTimer); _editPollTimer = null; }
}

// ---------- progress UI ---------------------------------------------
function _updateProgress(data) {
  var bar = document.getElementById('ge-progress-bar');
  var text = document.getElementById('ge-progress-text');
  if (bar) { bar.value = data.progress || 0; bar.textContent = (data.progress || 0) + '%'; }
  if (text) { text.textContent = T('geRunning') + ' (' + (data.progress || 0) + '%)'; }
  var block = _geConsoleBlock(_editJobId, '');
  if (block) block.classList.add('ge-console-block-single');
  if (block) {
    var cmdEl = block.querySelector('.ge-console-block-cmd');
    if (cmdEl && data.command) cmdEl.textContent = '$ ' + data.command;
    var logEl = block.querySelector('.ge-console-block-log');
    if (logEl && data.logTail) { logEl.textContent = data.logTail; logEl.scrollTop = logEl.scrollHeight; }
  }
}

function _showProgressSection() {
  var s = document.getElementById('ge-progress-section');
  if (s) s.style.display = 'block';
  var startBtn = document.getElementById('ge-start-btn');
  if (startBtn) startBtn.disabled = true;
  var cp = document.getElementById('ge-console-panel');
  if (cp) { cp.style.display = 'flex'; var logEl = document.getElementById('ge-console-log'); if (logEl) logEl.textContent = ''; var cmdEl = document.getElementById('ge-console-cmd'); if (cmdEl) cmdEl.textContent = ''; }
  requestAnimationFrame(_geSyncConsoleHeight);
}

function _hideProgressSection() {
  var s = document.getElementById('ge-progress-section');
  if (s) s.style.display = 'none';
  var startBtn = document.getElementById('ge-start-btn');
  if (startBtn) startBtn.disabled = false;
  var cp = document.getElementById('ge-console-panel');
  if (cp) cp.style.display = 'none';
}

function _setProgressStatus(text, isError) {
  var el = document.getElementById('ge-progress-text');
  if (el) {
    el.textContent = text;
    el.style.color = isError ? 'var(--danger)' : '';
  }
}

function _onCompleted(data) {
  _stopPolling();
  _editJobId = null;
  _geActiveJob = null;
  _setProgressStatus(T('geCompleted'), false);
  var bar = document.getElementById('ge-progress-bar');
  if (bar) bar.value = 100;


  var outputName = data.outputName || T('geEmptyName');
  var outputURL = data.outputURL || '';
  var outputPath = data.outputPath || '';


  // Regular single-file result.
  var resultHtml = '<div class="gallery-edit-result">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(T('geCompleted')) + '</span>' +
      '<span style="font-size:12px;color:var(--text-secondary)">' + escapeHtml(outputName) + '</span>' +
    '</div>' +
    '<div class="gallery-edit-actions">' +
      '<button class="pg-btn" id="ge-open-folder-btn">' + escapeHtml(T('geBatchOpenFolder')) + '</button>' +
    '</div>' +
  '</div>';

  var resultEl = document.getElementById('ge-result-area');
  if (resultEl) {
    resultEl.innerHTML = resultHtml;
    resultEl.style.display = 'block';
  }

  var openBtnS = document.getElementById('ge-open-folder-btn');
  if (openBtnS && outputPath) openBtnS.onclick = function() { _openInFileManager(outputPath); };
}

function _onError(data) {
  _stopPolling();
  _editJobId = null;
  _geActiveJob = null;
  _setProgressStatus(T('geFailed'), true);
  var msg = data.error || T('geFailed');
  var resultEl = document.getElementById('ge-result-area');
  if (resultEl) {
    resultEl.innerHTML = '<div class="gallery-edit-result" style="border-color:var(--danger)"><span style="color:var(--danger);font-weight:600">\u2718 ' + escapeHtml(msg) + '</span></div>';
    resultEl.style.display = 'block';
  }
}

function _onCancelled() {
  _stopPolling();
  _editJobId = null;
  _geActiveJob = null;
  _setProgressStatus(T('geCancelled'), false);
  var resultEl = document.getElementById('ge-result-area');
  if (resultEl) {
    resultEl.innerHTML = '<div class="gallery-edit-result" style="opacity:0.7"><span>' + escapeHtml(T('geCancelled')) + '</span></div>';
    resultEl.style.display = 'block';
  }
  _hideProgressSection();
}

// ---------- modal render ---------------------------------------------

// _renderSourceInfoRows emits the two-row source-info block. `prefix` selects
// the element ids ('img' for the image dialog, 'vid' for the video dialog) so
// the two never collide (only one dialog is open at a time, but distinct ids
// keep the updaters unambiguous). Row 1 = container path (or a "no disk path"
// hint for drag-dropped items); row 2 = file name + metadata / count.
function _renderSourceInfoRows(prefix) {
  return '<div class="ge-src-info">'
    + '<div class="ge-src-row ge-src-path" id="ge-' + prefix + '-src-row1">-</div>'
    + '<div class="ge-src-row ge-src-meta" id="ge-' + prefix + '-src-row2">-</div>'
    + '</div>';
}

// _renderSetPathRow / _renderSetNameRow emit the Set Path and Set Name rows
// shared by the image and video dialogs (same element ids; only one dialog is
// open at a time). Set Path toggles the output directory; Set Name the output
// filename / archive name.
function _renderSetPathRow() {
  return '<div class="gallery-edit-row">'
    + '<label class="gallery-edit-check"><input type="checkbox" id="ge-img-setpath"> ' + escapeHtml(T('geSetPath')) + '</label>'
    + '<button type="button" class="btn btn-browse" id="ge-browse-dir-btn" data-tooltip="' + escapeHtml(T('geBrowseDir')) + '">' + _geBrowseSvg + '</button>'
    + '<input type="text" id="ge-dest-dir" style="flex:1" placeholder="' + escapeHtml(T('geDestDirPlaceholder')) + '" disabled>'
    + '</div>';
}
function _renderSetNameRow() {
  return '<div class="gallery-edit-row">'
    + '<label class="gallery-edit-check"><input type="checkbox" id="ge-img-setname"> ' + escapeHtml(T('geSetName')) + '</label>'
    + '<input type="text" id="ge-img-setname-input" style="flex:1" placeholder="' + escapeHtml(T('geNamePlaceholder')) + '" disabled>'
    + '</div>';
}

function _renderImageForm() {
  var probe = _editProbe || {};
  var w = probe.width || 0, h = probe.height || 0;
  var it = _editCurrentItem;
  var srcExt = it ? (extOf(it.name) || 'png').toLowerCase() : 'png';
  var formatOptions = ['jpeg', 'png', 'webp', 'bmp', 'tiff', 'gif'];
  if (srcExt === 'jpg') srcExt = 'jpeg';
  if (formatOptions.indexOf(srcExt) < 0) srcExt = 'png';

  var html = '';

  // Source info (two rows; populated by _updateImageSourceInfo after probe).
  html += _renderSourceInfoRows('img');
  // Set Path + Set Name (shared with the video dialog).
  html += _renderSetPathRow();
  html += _renderSetNameRow();

  // Row 5: Uniform (sequential rename)
  // img input flex:1 (stretches to fill available space), Digits select right-aligned with top output name input
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check"><input type="checkbox" id="ge-img-uniform"> ' + escapeHtml(T('geUniform')) + '</label>';
  html += '<input type="text" id="ge-img-uniform-prefix" style="flex:1;min-width:0" value="' + escapeHtml(T('geRenormPrefixPh')) + '" placeholder="' + escapeHtml(T('geRenormPrefixPh')) + '" disabled>';
  html += '<label class="gallery-edit-label" style="width:auto;margin:0 4px 0 12px">' + escapeHtml(T('geRenormDigits')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-img-uniform-digits" style="width:64px;flex:none;text-align:center;text-align-last:center" disabled>';
  for (var d = 2; d <= 6; d++) {
    html += '<option value="' + d + '"' + (d === 2 ? ' selected' : '') + '>' + d + '</option>';
  }
  html += '</select>';
  html += '</div>';

  // Row 6: Compress (left-aligned, 130px) + Format (right of compress) + Quality (right-aligned)
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check"><input type="checkbox" id="ge-img-compress"> ' + escapeHtml(T('geCompressZip')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-img-format" style="width:95px;flex:none">';
  for (var i = 0; i < formatOptions.length; i++) {
    var f = formatOptions[i];
    html += '<option value="' + f + '"' + (f === srcExt ? ' selected' : '') + '>' + f.toUpperCase() + '</option>';
  }
  html += '</select>';
  html += '<div style="margin-left:auto;display:flex;align-items:center;gap:8px">';
  html += '<label class="gallery-edit-label" style="width:auto;margin:0">' + escapeHtml(T('geQuality')) + '</label>';
  html += '<input type="range" id="ge-img-quality" min="0" max="100" value="85" style="width:130px">';
  html += '<span class="gallery-edit-val" id="ge-quality-val" style="min-width:24px;text-align:right">85</span>';
  html += '</div>';
  html += '</div>';

  // PNG lossless note
  html += '<div class="gallery-edit-row" id="ge-img-lossless-note" style="display:none">';
  html += '<span style="font-size:11px;color:var(--text-muted);margin-left:auto">' + escapeHtml(T('geQualityHint')) + '</span>';
  html += '</div>';

  // Row 7: Scale (left aligned, no %) + Output Dims + Strip Metadata (right aligned)
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label" style="width:auto;margin:0">' + escapeHtml(T('geScalePercent')) + '</label>';
  html += '<input type="range" id="ge-img-scale" min="10" max="200" value="100" style="width:130px">';
  html += '<span class="gallery-edit-val" id="ge-scale-val" style="min-width:36px">100%</span>';
  html += '<span class="gallery-edit-val" id="ge-scale-dims" style="margin-left:4px;color:var(--text-muted)">' + escapeHtml(pgT('geOutputDims', [w, h])) + '</span>';
  html += '<label class="gallery-edit-check" style="margin-left:auto;margin-right:0"><input type="checkbox" id="ge-img-strip"> ' + escapeHtml(T('geStripMetadata')) + '</label>';
  html += '</div>';

  return html;
}

function _renderVideoTranscodeForm() {
  var probe = _editProbe || {};
  var w = probe.width || 0, h = probe.height || 0;
  var fmt = _geVidFormat || 'mp4';
  var isAnimFmt = (fmt === 'gif' || fmt === 'webp');
  var codecColHide = isAnimFmt ? ' style="display:none"' : '';
  var animBlockHide = isAnimFmt ? '' : ' style="display:none"';
  var gifOptsHide = (fmt === 'gif') ? '' : ' style="display:none"';
  var webpOptsHide = (fmt === 'webp') ? '' : ' style="display:none"';

  var html = '';

  // Row 1: Codec + Format (two columns). GIF/WebP (animated) hide the
  // video codec/preset/audio rows and reveal the animated-param block.
  html += '<div class="gallery-edit-row ge-two-col-row">';
  html += '<div class="ge-col-half" id="ge-vid-codec-col"' + codecColHide + '>';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geCodec')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-codec">';
  html += '<option value="h264">H.264</option><option value="h265">H.265/HEVC</option><option value="vp9">VP9</option><option value="av1">AV1</option><option value="copy">Copy (no re-encode)</option>';
  html += '</select>';
  html += '</div>';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geFormat')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-format">';
  var formats = [
    { v: 'mp4', label: 'MP4' }, { v: 'mkv', label: 'MKV' }, { v: 'webm', label: 'WebM' }, { v: 'mov', label: 'MOV' },
    { v: 'gif', label: T('geFormatGif') }, { v: 'webp', label: T('geFormatWebp') }
  ];
  for (var i = 0; i < formats.length; i++) {
    html += '<option value="' + formats[i].v + '"' + (formats[i].v === fmt ? ' selected' : '') + '>' + escapeHtml(formats[i].label) + '</option>';
  }
  html += '</select>';
  html += '</div>';
  html += '</div>';

  // Capability note: reason string when a format's encoder is unavailable.
  html += '<div class="gallery-edit-row" id="ge-anim-cap-note-row" style="display:none">';
  html += '<span style="font-size:11px;color:var(--danger)" id="ge-anim-cap-note"></span>';
  html += '</div>';

  // Row 2: Quality + Preset (two columns)
  html += '<div class="gallery-edit-row ge-two-col-row" id="ge-vid-quality-preset-row">';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geQualityTier')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-quality">';
  html += '<option value="high">High</option><option value="medium" selected>Medium</option><option value="low">Low</option>';
  html += '</select>';
  html += '</div>';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('gePreset')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-preset">';
  html += '<option value="ultrafast">ultrafast</option><option value="fast">fast</option><option value="medium" selected>medium</option><option value="slow">slow</option><option value="veryslow">veryslow</option>';
  html += '</select>';
  html += '</div>';
  html += '</div>';

  // Row 3: Audio Codec + Audio Bitrate (two columns)
  html += '<div class="gallery-edit-row ge-two-col-row" id="ge-vid-audio-row">';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geAudioCodec')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-audio-codec">';
  html += '<option value="aac">AAC</option><option value="opus">Opus</option><option value="mp3">MP3</option><option value="copy">Copy</option><option value="none">None</option>';
  html += '</select>';
  html += '</div>';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geAudioBitrate')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-audio-bitrate">';
  var bitrates = ['64k', '96k', '128k', '160k', '192k', '256k', '320k'];
  for (var b = 0; b < bitrates.length; b++) {
    var br = bitrates[b];
    html += '<option value="' + br + '"' + (br === '128k' ? ' selected' : '') + '>' + br + '</option>';
  }
  html += '</select>';
  html += '</div>';
  html += '</div>';

  // Row 4: Scale + Dims + Strip metadata (video formats only)
  html += '<div class="gallery-edit-row" id="ge-vid-scale-row">';
  html += '<label class="gallery-edit-label" style="width:auto;margin:0">' + escapeHtml(T('geScalePercent')) + '</label>';
  html += '<input type="range" id="ge-vid-scale" min="10" max="200" value="100" style="width:130px">';
  html += '<span class="gallery-edit-val" id="ge-vid-scale-val" style="min-width:36px">100%</span>';
  html += '<span class="gallery-edit-val" id="ge-vid-scale-dims" style="margin-left:4px;color:var(--text-muted)">' + escapeHtml(pgT('geOutputDims', [w, h])) + '</span>';
  html += '<label class="gallery-edit-check" style="margin-left:auto;margin-right:0"><input type="checkbox" id="ge-vid-strip"> ' + escapeHtml(T('geStripMetadata')) + '</label>';
  html += '</div>';

  // Animated-format param block (GIF / animated WebP)
  html += '<div id="ge-vid-anim-block"' + animBlockHide + '>';

  // Start + Duration (seconds; empty = whole source)
  html += '<div class="gallery-edit-row ge-two-col-row">';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geTrimStart')) + '</label>';
  html += '<input type="number" id="ge-vid-anim-start" min="0" step="0.1" placeholder="0">';
  html += '</div>';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geTrimDuration')) + '</label>';
  html += '<input type="number" id="ge-vid-anim-duration" min="0" step="0.1" placeholder="">';
  html += '</div>';
  html += '</div>';

  // FPS + Loop
  html += '<div class="gallery-edit-row ge-two-col-row">';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geFps')) + '</label>';
  html += '<input type="number" id="ge-vid-anim-fps" min="1" max="60" step="1" value="12">';
  html += '</div>';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geLoop')) + '</label>';
  html += '<span style="display:flex;flex:1;min-width:0">';
  html += '<select class="pg-param-row-select" id="ge-vid-anim-loop-mode" style="flex:1;min-width:0">';
  html += '<option value="infinite" selected>' + escapeHtml(T('geLoopInfinite')) + '</option>';
  if (fmt === 'gif') html += '<option value="once">' + escapeHtml(T('geLoopOnce')) + '</option>';
  html += '<option value="n">' + escapeHtml(T('geLoopRepeatN')) + '</option>';
  html += '</select>';
  html += '<input type="number" id="ge-vid-anim-loop-n" min="0" max="65535" step="1" value="1" style="width:56px;margin-left:6px;display:none">';
  html += '</span>';
  html += '</div>';
  html += '</div>';

  // Width + Height (0 = auto)
  html += '<div class="gallery-edit-row ge-two-col-row">';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geWidth')) + '</label>';
  html += '<input type="number" id="ge-vid-anim-width" min="0" step="2" value="0" placeholder="0 = auto">';
  html += '</div>';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geHeight')) + '</label>';
  html += '<input type="number" id="ge-vid-anim-height" min="0" step="2" value="0" placeholder="0 = auto">';
  html += '</div>';
  html += '</div>';

  // Crop T/B/L/R (pixels removed from each edge)
  html += '<div class="gallery-edit-row" style="gap:6px">';
  html += '<label class="gallery-edit-label" style="width:auto;margin:0">' + escapeHtml(T('geCropTop')) + '</label>';
  html += '<input type="number" id="ge-vid-anim-crop-top" min="0" step="1" value="0" style="width:52px">';
  html += '<label class="gallery-edit-label" style="width:auto;margin:0">' + escapeHtml(T('geCropBottom')) + '</label>';
  html += '<input type="number" id="ge-vid-anim-crop-bottom" min="0" step="1" value="0" style="width:52px">';
  html += '<label class="gallery-edit-label" style="width:auto;margin:0">' + escapeHtml(T('geCropLeft')) + '</label>';
  html += '<input type="number" id="ge-vid-anim-crop-left" min="0" step="1" value="0" style="width:52px">';
  html += '<label class="gallery-edit-label" style="width:auto;margin:0">' + escapeHtml(T('geCropRight')) + '</label>';
  html += '<input type="number" id="ge-vid-anim-crop-right" min="0" step="1" value="0" style="width:52px">';
  html += '</div>';

  // Quality (1-100; GIF uses it as the default palette tier, WebP as encoder quality)
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geQuality')) + '</label>';
  html += '<input type="range" id="ge-vid-anim-quality" min="1" max="100" value="80" style="width:130px">';
  html += '<span class="gallery-edit-val" id="ge-vid-anim-quality-val" style="min-width:36px">80</span>';
  html += '</div>';

  // GIF-only options: palette colors + dither
  html += '<div id="ge-vid-anim-gif-opts"' + gifOptsHide + '>';
  html += '<div class="gallery-edit-row ge-two-col-row">';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('gePaletteColors')) + '</label>';
  html += '<input type="number" id="ge-vid-anim-palette" min="2" max="256" step="1" value="256">';
  html += '</div>';
  html += '<div class="ge-col-half">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geDither')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-anim-dither">';
  html += '<option value="sierra2_4a" selected>sierra2_4a</option><option value="floyd_steinberg">floyd_steinberg</option><option value="bayer">bayer</option><option value="none">none</option>';
  html += '</select>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  // WebP-only option: lossless
  html += '<div id="ge-vid-anim-webp-opts"' + webpOptsHide + '>';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check" style="margin-left:90px"><input type="checkbox" id="ge-vid-anim-lossless"> ' + escapeHtml(T('geLossless')) + '</label>';
  html += '</div>';
  html += '</div>';

  html += '</div>'; // ge-vid-anim-block

  return html;
}

function _renderVideoTrimForm() {
  var html = '';

  // Animated GIF/WebP inputs cannot seek (<img> has no currentTime/duration),
  // so they get a numeric Start/End segment panel instead of the draggable
  // trim bar; the backend re-encodes the requested window (video_anim_trim).
  var isAnim = (typeof isAnimatedImg === 'function') && isAnimatedImg(_editCurrentItem);

  if (isAnim) {
    html += '<div class="gallery-edit-row" style="font-size:11px;color:var(--text-muted)">' + escapeHtml(T('geTrimAnimHint')) + '</div>';
    html += '<div class="gallery-edit-row ge-two-col-row">';
    html += '<div class="ge-col-half">';
    html += '<label class="gallery-edit-label">' + escapeHtml(T('geTrimStart')) + '</label>';
    html += '<input type="number" id="ge-trim-anim-start" min="0" step="0.1" value="0">';
    html += '</div>';
    html += '<div class="ge-col-half">';
    html += '<label class="gallery-edit-label">' + escapeHtml(T('geTrimEnd')) + '</label>';
    html += '<input type="number" id="ge-trim-anim-end" min="0" step="0.1" value="">';
    html += '</div>';
    html += '</div>';
    html += '<div class="gallery-edit-row">';
    html += '<button type="button" class="btn btn-primary" id="ge-trim-anim-add">' + escapeHtml(T('geTrimAddSegment')) + '</button>';
    html += '<button type="button" class="btn btn-ghost" id="ge-trim-anim-clear" style="margin-left:8px">' + escapeHtml(T('geTrimClear')) + '</button>';
    html += '<span class="gallery-edit-val" id="ge-trim-segments-text" style="font-size:12px;color:var(--text-muted);flex:1;text-align:right">' + escapeHtml(_formatTrimSegments(_editTrimSegments)) + '</span>';
    html += '</div>';
    // Capability note (ffmpeg missing, or animated-WebP decoder missing)
    html += '<div class="gallery-edit-row" id="ge-trim-anim-note-row" style="display:none">';
    html += '<span style="font-size:11px;color:var(--danger)" id="ge-trim-anim-note"></span>';
    html += '</div>';
    return html;
  }

  // Select ranges button — switches to the video display with trim controls
  html += '<div class="gallery-edit-row">';
  html += '<button type="button" class="btn btn-primary" id="ge-trim-select-btn" style="flex:1">' + escapeHtml(T('geTrimSelectRanges')) + '</button>';
  html += '</div>';

  // Segment display
  html += '<div class="gallery-edit-row" id="ge-trim-segments-display">';
  html += '<span class="gallery-edit-val" id="ge-trim-segments-text" style="font-size:12px;color:var(--text-muted);flex:1">' + escapeHtml(_formatTrimSegments(_editTrimSegments)) + '</span>';
  html += '</div>';

  // Re-encode mode
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check" style="margin-right:16px">';
  html += '<input type="radio" name="ge-trim-mode" value="copy" checked> ' + escapeHtml(T('geFastCopy'));
  html += '</label>';
  html += '<label class="gallery-edit-check">';
  html += '<input type="radio" name="ge-trim-mode" value="reencode"> ' + escapeHtml(T('geAccurateEncode'));
  html += '</label>';
  html += '</div>';

  // Multi-segment re-encode hint
  html += '<div class="gallery-edit-row" id="ge-trim-multi-hint" style="display:none">';
  html += '<span style="font-size:11px;color:var(--text-muted)">' + escapeHtml(T('geTrimMultiReencodeHint')) + '</span>';
  html += '</div>';

  // Re-encode options
  html += '<div id="ge-trim-reencode-opts" style="display:none">';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geCodec')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-trim-codec">';
  html += '<option value="h264">H.264</option><option value="h265">H.265/HEVC</option><option value="vp9">VP9</option><option value="av1">AV1</option>';
  html += '</select>';
  html += '</div>';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geQualityTier')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-trim-quality">';
  html += '<option value="high">High</option><option value="medium" selected>Medium</option><option value="low">Low</option>';
  html += '</select>';
  html += '</div>';
  html += '</div>';

  return html;
}

function _renderVideoSubtitleForm() {
  var html = '';

  // File picker
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geSubtitleFile')) + '</label>';
  html += '<input type="file" id="ge-sub-file" accept=".srt,.ass,.ssa,.vtt" style="flex:1">';
  html += '</div>';
  html += '<div class="gallery-edit-row" id="ge-sub-filename" style="display:none">';
  html += '<span style="font-size:12px;color:var(--accent2)"></span>';
  html += '</div>';

  // Mode
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geSubtitleMode')) + '</label>';
  html += '<label class="gallery-edit-check" style="margin-right:16px">';
  html += '<input type="radio" name="ge-sub-mode" value="burn" checked> ' + escapeHtml(T('geBurnIn'));
  html += '</label>';
  html += '<label class="gallery-edit-check">';
  html += '<input type="radio" name="ge-sub-mode" value="soft"> ' + escapeHtml(T('geSoftSub'));
  html += '</label>';
  html += '</div>';

  // Burn-in options
  html += '<div id="ge-sub-burn-opts">';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geFontSize')) + '</label>';
  html += '<input type="number" id="ge-sub-fontsize" min="8" max="72" value="24" style="width:80px">';
  html += '</div>';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geFontName')) + '</label>';
  html += '<input type="text" id="ge-sub-fontname" placeholder="' + escapeHtml(T('geFontNamePlaceholder')) + '" style="flex:1">';
  html += '</div>';
  html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;text-align:right">' + escapeHtml(T('geFontCJKHint')) + '</div>';
  html += '</div>';

  // Soft-sub options (hidden initially)
  html += '<div id="ge-sub-soft-opts" style="display:none">';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geLanguage')) + '</label>';
  html += '<input type="text" id="ge-sub-lang" value="eng" placeholder="' + escapeHtml(T('geLanguagePlaceholder')) + '" style="width:80px">';
  html += '</div>';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(T('geContainer')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-sub-container">';
  html += '<option value="mkv" selected>MKV</option><option value="mp4">MP4</option>';
  html += '</select>';
  html += '</div>';
  html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;text-align:right">' + escapeHtml(T('geSoftSubNote')) + '</div>';
  html += '</div>';


  return html;
}

function _buildModalHTML() {
  var isImage = _editMediaType === 'image';
  var title = isImage ? T('geEditImage') : T('geEditVideo');
  var itemName = _editCurrentItem ? escapeHtml(_editCurrentItem.name) : '';
  var fullTitle = title + ': ' + itemName;

  var html = '';
  if (isImage) {
    html += '<div class="pg-modal-header">';
    html += '<div class="ge-header-left">';
    html += '<button type="button" id="ge-settings-btn" class="ge-gear-btn" data-tooltip="' + escapeHtml(T('geSettingsHint')) + '">' + _geGearSvg + '</button>';
    html += '<button type="button" id="ge-archive-toggle" class="ge-icon-toggle" data-archive="0" data-tooltip="' + escapeHtml(T('geArchiveHint')) + '">' + _geImageSvg + '</button>';
    html += '</div>';
    html += '<span class="pg-modal-title ge-title-center">' + escapeHtml(T('geImageConvert')) + '</span>';
    html += '<button class="pg-modal-close" onclick="pgCloseModal()">\u2715</button>';
    html += '</div>';
  } else {
    html += '<div class="pg-modal-header">';
    html += '<div class="ge-header-left">';
    html += '<button type="button" id="ge-settings-btn" class="ge-gear-btn" data-tooltip="' + escapeHtml(T('geSettingsHint')) + '">' + _geGearSvg + '</button>';
    html += '</div>';
    html += '<span class="pg-modal-title ge-title-center">' + escapeHtml(T('geVideoConvert')) + '</span>';
    html += '<button class="pg-modal-close" onclick="pgCloseModal()">\u2715</button>';
    html += '</div>';
  }

  html += '<div class="pg-modal-body gallery-edit-body">';

  // FFmpeg warning
  html += '<div id="ge-ffmpeg-warn" style="display:none;padding:8px 12px;background:rgba(239,68,68,0.1);border:1px solid var(--danger);border-radius:var(--radius-sm);margin-bottom:12px;font-size:13px;color:var(--danger)">';
  html += '<strong>' + escapeHtml(T('geFfmpegNA')) + '</strong>: ' + escapeHtml(T('geFfmpegNAHint'));
  html += '</div>';

  if (isImage) {
    // Image form (includes source info + Set Path; "Replace Original" removed)
    html += '<div class="gallery-edit-section" id="ge-img-section">';
    html += _renderImageForm();
    html += '</div>';
  } else {
    // Video: two-row source info + Set Path + Set Name (shared rows; "Replace
    // Original" removed, same model as the image dialog but no archive toggle).
    html += '<div class="gallery-edit-section" id="ge-vid-dest-section">';
    html += _renderSourceInfoRows('vid');
    html += _renderSetPathRow();
    html += _renderSetNameRow();
    html += '</div>';
    // Video: unified single panel containing Transcode, Trim, Subtitle sections
    html += '<div class="gallery-edit-section" id="ge-vid-section">';
    
    // Block 1: Transcode
    html += '<div class="gallery-edit-block">';
    html += '<div class="gallery-edit-block-title">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>';
    html += '<span>' + escapeHtml(T('geTranscodeTab')) + '</span>';
    html += '</div>';
    html += _renderVideoTranscodeForm();
    html += '</div>';

    // Block 2: Trim (Optional section with toggle checkbox)
    html += '<div class="gallery-edit-block">';
    html += '<div class="gallery-edit-block-title">';
    html += '<label class="gallery-edit-check" style="margin:0;font-weight:600;color:var(--text)">';
    html += '<input type="checkbox" id="ge-vid-trim-enable"> ';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>';
    html += '<span>' + escapeHtml(T('geTrimTab')) + '</span>';
    html += '</label>';
    html += '</div>';
    html += '<div id="ge-vid-trim-body" style="display:none;margin-top:10px">';
    html += _renderVideoTrimForm();
    html += '</div>';
    html += '</div>';

    // Block 3: Subtitle (Optional section with toggle checkbox)
    html += '<div class="gallery-edit-block">';
    html += '<div class="gallery-edit-block-title">';
    html += '<label class="gallery-edit-check" style="margin:0;font-weight:600;color:var(--text)">';
    html += '<input type="checkbox" id="ge-vid-sub-enable"> ';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
    html += '<span>' + escapeHtml(T('geSubtitleTab')) + '</span>';
    html += '</label>';
    html += '</div>';
    html += '<div id="ge-vid-sub-body" style="display:none;margin-top:10px">';
    html += _renderVideoSubtitleForm();
    html += '</div>';
    html += '</div>';

    html += '</div>';
  }

  // Progress section (hidden initially)
  html += '<div class="gallery-edit-section" id="ge-progress-section" style="display:none">';
  html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">';
  html += '<progress id="ge-progress-bar" value="0" max="100" style="flex:1;height:8px"></progress>';
  html += '<button class="pg-btn danger" id="ge-cancel-btn" style="font-size:11px;padding:2px 8px">' + escapeHtml(T('geCancelJob')) + '</button>';
  html += '</div>';
  html += '<span id="ge-progress-text" style="font-size:12px;color:var(--text-muted)">' + escapeHtml(T('geRunning')) + '</span>';
  html += '</div>';

  // Result area
  html += '<div id="ge-result-area" style="display:none"></div>';

  html += '</div>'; // pg-modal-body

  // Modal footer with Cancel and Start buttons (matching Settings modal footer)
  html += '<div class="pg-modal-footer">';
  html += '<button type="button" class="btn btn-ghost" onclick="pgCloseModal()">' + escapeHtml(T('geCancel')) + '</button>';
  html += '<button type="button" class="btn btn-primary" id="ge-start-btn">' + escapeHtml(T('geStart')) + '</button>';
  html += '</div>';

  return html;
}

// ---------- trim mode (video display with multi-segment selector) ----
var _editTrimSegments = [];     // confirmed segments: [{start, end}]
var _editDefaultDir = '';       // cached default download dir
var _trimMode = false;
var _trimSegments = [];         // live segments in trim mode
var _trimLastDragged = null;    // {segIdx, handle} last dragged handle
var _trimDuration = 0;
var _trimVidEl = null;
var _trimSavedSeekerHTML = '';
var _trimSavedCtrlCenterHTML = '';
var _trimKeyHandler = null;

function _trimPct(sec) {
  if (_trimDuration <= 0) return 0;
  return Math.max(0, Math.min(100, (sec / _trimDuration) * 100));
}

function _trimSecFromX(clientX) {
  var bar = document.getElementById('ge-trimbar');
  if (!bar) return 0;
  var rect = bar.getBoundingClientRect();
  var ratio = (clientX - rect.left) / rect.width;
  return Math.max(0, Math.min(1, ratio)) * _trimDuration;
}

function _formatTrimSegments(segments) {
  if (!segments || !segments.length) return T('geTrimNoSegments');
  return segments.map(function(s) {
    return _formatSecToTime(s.start) + ' \u2192 ' + _formatSecToTime(s.end);
  }).join(', ');
}

function _updateTrimSegmentDisplay() {
  var el = document.getElementById('ge-trim-segments-text');
  if (el) el.textContent = _formatTrimSegments(_editTrimSegments);
  var hint = document.getElementById('ge-trim-multi-hint');
  if (hint) hint.style.display = (_editTrimSegments.length > 1) ? '' : 'none';
}

// _normalizeAnimTrimSegments sorts segments by start, drops exact duplicates,
// and rejects overlapping ranges (a later segment may not begin before the
// previous one ends). Returns {segments} or {error}.
function _normalizeAnimTrimSegments(segments) {
  var out = (segments || []).map(function(s) {
    return { start: s.start, end: s.end };
  }).sort(function(a, b) { return a.start - b.start; });
  var dedup = [];
  for (var i = 0; i < out.length; i++) {
    var s = out[i];
    if (dedup.length && dedup[dedup.length - 1].start === s.start && dedup[dedup.length - 1].end === s.end) continue;
    if (dedup.length && s.start < dedup[dedup.length - 1].end) {
      return { error: T('geTrimOverlap') };
    }
    dedup.push(s);
  }
  return { segments: dedup };
}

// _animTrimAddSegment validates the numeric Start/End inputs and appends them
// to the confirmed segment list (animated GIF/WebP trim path).
function _animTrimAddSegment() {
  var startInput = document.getElementById('ge-trim-anim-start');
  var endInput = document.getElementById('ge-trim-anim-end');
  if (!startInput || !endInput) return;
  var start = parseFloat(startInput.value);
  var end = parseFloat(endInput.value);
  if (!isFinite(start) || !isFinite(end) || start < 0 || end <= start) {
    showMsg(T('geTrimInvalidRange'));
    return;
  }
  var duration = _editProbe && _editProbe.duration;
  if (duration > 0 && end > duration) {
    showMsg(pgT('geTrimEndTooLarge', [Math.round(duration * 100) / 100]));
    return;
  }
  var segs = _editTrimSegments.slice();
  segs.push({ start: start, end: end });
  var norm = _normalizeAnimTrimSegments(segs);
  if (norm.error) { showMsg(norm.error); return; }
  _editTrimSegments = norm.segments;
  _updateTrimSegmentDisplay();
  endInput.value = '';
}

// Build the trim bar HTML that replaces the video seeker.
function _buildTrimBarHTML() {
  var html = '<div class="ge-trimbar" id="ge-trimbar">';
  html += '<div class="ge-trimbar-track"></div>';
  html += '</div>';
  html += '<span id="ge-trimbar-time" class="gallery-video-time">00:00 / 00:00</span>';
  return html;
}

// Build the 4 trim-mode buttons that replace the center controls.
function _buildTrimButtonsHTML() {
  var addIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  var removeIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  var confirmIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  return '<button class="gallery-btn gallery-btn-icon" id="ge-tm-play" type="button" data-tooltip="' + escapeHtml(T('geTrimPlayPause')) + '">' + GALLERY_ICONS.play + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="ge-tm-add" type="button" data-tooltip="' + escapeHtml(T('geTrimAddSegment')) + '">' + addIcon + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="ge-tm-remove" type="button" data-tooltip="' + escapeHtml(T('geTrimRemoveSegment')) + '">' + removeIcon + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="ge-tm-confirm" type="button" data-tooltip="' + escapeHtml(T('geTrimConfirm')) + '">' + confirmIcon + '</button>';
}

// Re-render the trim bar fills and thumbs from _trimSegments.
function _updateTrimBarUI() {
  var bar = document.getElementById('ge-trimbar');
  if (!bar) return;
  var html = '<div class="ge-trimbar-track"></div>';
  for (var i = 0; i < _trimSegments.length; i++) {
    var seg = _trimSegments[i];
    var sp = _trimPct(seg.start), ep = _trimPct(seg.end);
    html += '<div class="ge-trimbar-fill" style="left:' + sp + '%;width:' + (ep - sp) + '%"></div>';
    var startActive = (_trimLastDragged && _trimLastDragged.segIdx === i && _trimLastDragged.handle === 'start');
    var endActive = (_trimLastDragged && _trimLastDragged.segIdx === i && _trimLastDragged.handle === 'end');
    html += '<div class="ge-trimbar-thumb' + (startActive ? ' active' : '') + '" data-seg="' + i + '" data-handle="start" style="left:' + sp + '%"></div>';
    html += '<div class="ge-trimbar-thumb' + (endActive ? ' active' : '') + '" data-seg="' + i + '" data-handle="end" style="left:' + ep + '%"></div>';
  }
  bar.innerHTML = html;
}

function _startTrimDrag(segIdx, handle) {
  _trimLastDragged = {segIdx: segIdx, handle: handle};
  var isStart = (handle === 'start');
  function onMove(e) {
    var sec = _trimSecFromX(e.clientX);
    var seg = _trimSegments[segIdx];
    if (!seg) return;
    // Clamp so groups never overlap: a group's start may not cross the
    // previous group's end, and its end may not cross the next group's start.
    // (Min 0.1s width inside each group is still enforced.)
    var prevEnd = segIdx > 0 ? _trimSegments[segIdx - 1].end : 0;
    var nextStart = (segIdx + 1 < _trimSegments.length) ? _trimSegments[segIdx + 1].start : _trimDuration;
    if (isStart) {
      // start may not go past this group's end-0.1, nor before prev group's end
      seg.start = Math.max(prevEnd, Math.min(sec, seg.end - 0.1));
    } else {
      // end may not go before this group's start+0.1, nor past next group's start
      seg.end = Math.min(nextStart, Math.max(sec, seg.start + 0.1));
    }
    if (_trimVidEl) _trimVidEl.currentTime = isStart ? seg.start : seg.end;
    _updateTrimBarUI();
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function _moveNearestHandle(sec) {
  var bestIdx = 0, bestHandle = 'start', bestDist = Infinity;
  for (var i = 0; i < _trimSegments.length; i++) {
    var seg = _trimSegments[i];
    var ds = Math.abs(sec - seg.start);
    var de = Math.abs(sec - seg.end);
    if (ds < bestDist) { bestDist = ds; bestIdx = i; bestHandle = 'start'; }
    if (de < bestDist) { bestDist = de; bestIdx = i; bestHandle = 'end'; }
  }
  var seg = _trimSegments[bestIdx];
  var prevEnd = bestIdx > 0 ? _trimSegments[bestIdx - 1].end : 0;
  var nextStart = (bestIdx + 1 < _trimSegments.length) ? _trimSegments[bestIdx + 1].start : _trimDuration;
  if (bestHandle === 'start') {
    seg.start = Math.max(prevEnd, Math.min(sec, seg.end - 0.1));
  } else {
    seg.end = Math.min(nextStart, Math.max(sec, seg.start + 0.1));
  }
  _trimLastDragged = {segIdx: bestIdx, handle: bestHandle};
  if (_trimVidEl) _trimVidEl.currentTime = (bestHandle === 'start') ? seg.start : seg.end;
  _updateTrimBarUI();
}

function _trimPlayPause() {
  if (!_trimVidEl) return;
  if (_trimVidEl.paused) {
    var startSec = 0;
    if (_trimLastDragged) {
      var seg = _trimSegments[_trimLastDragged.segIdx];
      if (seg) {
        if (_trimLastDragged.handle === 'start') {
          startSec = seg.start;
        } else {
          // Right handle: jump to next group's left, or first group's left.
          if (_trimLastDragged.segIdx < _trimSegments.length - 1) {
            startSec = _trimSegments[_trimLastDragged.segIdx + 1].start;
          } else {
            startSec = _trimSegments[0].start;
          }
        }
      }
    } else {
      startSec = _trimSegments[0] ? _trimSegments[0].start : 0;
    }
    _trimVidEl.currentTime = startSec;
    _trimVidEl.play();
  } else {
    _trimVidEl.pause();
  }
}

function _trimAddSegment() {
  var lastSeg = _trimSegments[_trimSegments.length - 1];
  var start = lastSeg ? lastSeg.end : 0;
  if (start >= _trimDuration) return;
  _trimSegments.push({start: start, end: _trimDuration});
  _updateTrimBarUI();
}

function _trimRemoveSegment() {
  if (_trimSegments.length <= 1) return;
  _trimSegments.pop();
  _trimLastDragged = null;
  _updateTrimBarUI();
}

function _bindTrimModeEvents() {
  var bar = document.getElementById('ge-trimbar');
  if (bar) {
    bar.addEventListener('pointerdown', function(e) {
      var thumb = e.target.closest('.ge-trimbar-thumb');
      if (thumb) {
        e.preventDefault();
        _startTrimDrag(parseInt(thumb.getAttribute('data-seg')), thumb.getAttribute('data-handle'));
      } else if (e.target === bar || e.target.classList.contains('ge-trimbar-track')) {
        _moveNearestHandle(_trimSecFromX(e.clientX));
      }
    });
  }
  if (_trimVidEl) {
    _trimVidEl.ontimeupdate = function() {
      var timeEl = document.getElementById('ge-trimbar-time');
      if (timeEl) timeEl.textContent = formatTime(_trimVidEl.currentTime) + ' / ' + formatTime(_trimDuration);
    };
    _trimVidEl.onplay = function() {
      var playBtn = document.getElementById('ge-tm-play');
      if (playBtn) playBtn.innerHTML = GALLERY_ICONS.pause;
    };
    _trimVidEl.onpause = function() {
      var playBtn = document.getElementById('ge-tm-play');
      if (playBtn) playBtn.innerHTML = GALLERY_ICONS.play;
    };
  }
  // Re-query buttons after innerHTML replacement in _enterTrimMode
  setTimeout(function() {
    var playBtn = document.getElementById('ge-tm-play');
    if (playBtn) playBtn.onclick = _trimPlayPause;
    var addBtn = document.getElementById('ge-tm-add');
    if (addBtn) addBtn.onclick = _trimAddSegment;
    var removeBtn = document.getElementById('ge-tm-remove');
    if (removeBtn) removeBtn.onclick = _trimRemoveSegment;
    var confirmBtn = document.getElementById('ge-tm-confirm');
    if (confirmBtn) confirmBtn.onclick = function() { _exitTrimMode(true); };
  }, 0);
  _trimKeyHandler = function(e) { if (e.key === 'Escape') _exitTrimMode(false); };
  document.addEventListener('keydown', _trimKeyHandler);
}

function _enterTrimMode() {
  pgCloseModal();
  setTimeout(function() {
    _trimMode = true;
    var vidEl = document.getElementById('gallery-main-video');
    if (!vidEl) { _trimMode = false; return; }
    _trimVidEl = vidEl;
    vidEl.pause();
    _trimDuration = vidEl.duration || (_editProbe && _editProbe.duration) || 0;
    if (_editTrimSegments && _editTrimSegments.length > 0) {
      _trimSegments = _editTrimSegments.map(function(s) { return {start: s.start, end: s.end}; });
    } else {
      _trimSegments = [{start: 0, end: _trimDuration}];
    }
    _trimLastDragged = null;
    var hoverCtrl = document.getElementById('gallery-video-ctrl');
    if (hoverCtrl) {
      _trimSavedSeekerHTML = hoverCtrl.innerHTML;
      hoverCtrl.innerHTML = _buildTrimBarHTML();
      hoverCtrl.classList.add('ge-trim-mode-ctrl');
    }
    var vidPane = document.getElementById('gallery-pane-video');
    var ctrlCenter = vidPane ? vidPane.querySelector('.gallery-ctrl-center') : document.querySelector('.gallery-ctrl-center');
    if (ctrlCenter) {
      _trimSavedCtrlCenterHTML = ctrlCenter.innerHTML;
      ctrlCenter.innerHTML = _buildTrimButtonsHTML();
    }
    _bindTrimModeEvents();
    _updateTrimBarUI();
  }, 150);
}

function _exitTrimMode(save) {
  if (save) {
    _editTrimSegments = _trimSegments.map(function(s) { return {start: s.start, end: s.end}; });
  }
  _trimMode = false;
  if (_trimKeyHandler) { document.removeEventListener('keydown', _trimKeyHandler); _trimKeyHandler = null; }
  var hoverCtrl = document.getElementById('gallery-video-ctrl');
  if (hoverCtrl && _trimSavedSeekerHTML) {
    hoverCtrl.innerHTML = _trimSavedSeekerHTML;
    hoverCtrl.classList.remove('ge-trim-mode-ctrl');
  }
  var vidPane = document.getElementById('gallery-pane-video');
  var ctrlCenter = vidPane ? vidPane.querySelector('.gallery-ctrl-center') : document.querySelector('.gallery-ctrl-center');
  if (ctrlCenter && _trimSavedCtrlCenterHTML) {
    ctrlCenter.innerHTML = _trimSavedCtrlCenterHTML;
  }
  if (typeof bindVideoControls === 'function') bindVideoControls();
  // Reopen edit modal using cached probe data.
  var html = _buildModalHTML();
  pgShowModal(html);
  _geEnsureConsole();
  setTimeout(function() {
    var modal = document.querySelector('#pg-modal-overlay .pg-modal');
    if (modal) { modal.style.width = '520px'; modal.style.minWidth = '520px'; }
  }, 0);
  setTimeout(function() {
    var destDir = document.getElementById('ge-dest-dir');
    if (destDir && _editDefaultDir) destDir.value = _editDefaultDir;
    // Video: Set Path defaults ON, pre-filled with the download dir.
    var sp = document.getElementById('ge-img-setpath');
    if (sp) { sp.checked = true; _refreshBatchUXVisibility(); }
  }, 30);
  _checkFfmpegStatus();
  if (_editProbe) {
    _updateVideoSourceInfo();
    var scaleDims = document.getElementById('ge-scale-dims');
    if (scaleDims && _editProbe.width && _editProbe.height) {
      scaleDims.textContent = pgT('geOutputDims', [_editProbe.width, _editProbe.height]);
    }
  }
  setTimeout(_bindModalEvents, 20);
  setTimeout(function() {
    var trimEnableCb = document.getElementById('ge-vid-trim-enable');
    var trimBody = document.getElementById('ge-vid-trim-body');
    if (_editTrimSegments && _editTrimSegments.length > 0) {
      if (trimEnableCb) trimEnableCb.checked = true;
      if (trimBody) trimBody.style.display = '';
    }
    _updateTrimSegmentDisplay();
  }, 50);
}

// ---------- event binding -------------------------------------------
function _bindModalEvents() {
  // Settings gear button — opens the shared download settings modal
  // (same as the download page) and re-checks ffmpeg status on close.
  var gearBtn = document.getElementById('ge-settings-btn');
  if (gearBtn) {
    gearBtn.onclick = function() {
      if (typeof openPathSettingsModal === 'function') {
        openPathSettingsModal({ sections: { defaultDir: true, ffmpegPath: true } });
        // Poll until the settings overlay is gone, then re-check ffmpeg.
        var poll = setInterval(function() {
          if (!document.getElementById('dl-settings-overlay')) {
            clearInterval(poll);
            _checkFfmpegStatus();
          }
        }, 300);
      }
    };
  }

  // Destination directory browse button (icon-only)
  var browseBtn = document.getElementById('ge-browse-dir-btn');
  var destInput = document.getElementById('ge-dest-dir');
  if (browseBtn && destInput) {
    browseBtn.onclick = function() {
      // Native folder picker is modal: refuse re-entry while one is open so
      // the user cannot stack multiple file-manager dialogs.
      if (browseBtn.disabled) return;
      browseBtn.disabled = true;
      fetch('/api/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'directory' })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.path) {
          destInput.value = data.path;
        }
      })
      .catch(function(err) {
        console.warn('Browse directory error:', err);
      })
      .then(function() {
        // Re-enable only if Set Path is still on (sync keeps it disabled otherwise).
        if (document.getElementById('ge-img-setpath')) {
          _refreshBatchUXVisibility();
        } else {
          browseBtn.disabled = false;
        }
      });
    };
  }

  // Image|archive header toggle — single ↔ convert-all-in-folder.
  var archTog = document.getElementById('ge-archive-toggle');
  if (archTog) {
    archTog.onclick = function() {
      var on = archTog.getAttribute('data-archive') === '1';
      archTog.setAttribute('data-archive', on ? '0' : '1');
      archTog.innerHTML = on ? _geImageSvg : _geFolderSvg;
      archTog.setAttribute('data-tooltip', on ? T('geArchiveHint') : T('geSingleHint'));
      // Uniform is archive-only; turning it off when leaving archive mode keeps
      // _captureBatchCfg/outStem from applying batch renaming to a single image.
      if (on) { var u = document.getElementById('ge-img-uniform'); if (u) u.checked = false; }
      _updateImageSourceInfo();
      _refreshBatchUXVisibility();
    };
  }
  // Set Path / Set Name / Uniform toggles — enable/disable their own inputs.
  ['ge-img-setpath', 'ge-img-setname', 'ge-img-uniform'].forEach(function(id) {
    var cb = document.getElementById(id);
    if (cb) cb.onchange = _refreshBatchUXVisibility;
  });
  // Compress toggle (no input gating; the flag is read at start time).
  var compressCb = document.getElementById('ge-img-compress');
  if (compressCb) { compressCb.onchange = _refreshBatchUXVisibility; }

  // ---- image events ----
  var fmtSelect = document.getElementById('ge-img-format');
  var losslessNote = document.getElementById('ge-img-lossless-note');
  var qualitySlider = document.getElementById('ge-img-quality');
  var qualityVal = document.getElementById('ge-quality-val');
  var scaleInput = document.getElementById('ge-img-scale');
  var scaleDims = document.getElementById('ge-scale-dims');

  if (fmtSelect && losslessNote) {
    fmtSelect.onchange = function() {
      // Quality is always visible; only the PNG lossless hint toggles.
      losslessNote.style.display = (fmtSelect.value === 'png') ? '' : 'none';
    };
    fmtSelect.onchange();
  }

  if (qualitySlider && qualityVal) {
    qualitySlider.oninput = function() { qualityVal.textContent = qualitySlider.value; };
  }

  var scaleVal = document.getElementById('ge-scale-val');
  if (scaleInput && scaleDims) {
    scaleInput.oninput = function() {
      var pct = parseFloat(scaleInput.value) || 100;
      var probe = _editProbe || {};
      var nw = Math.round((probe.width || 0) * pct / 100);
      var nh = Math.round((probe.height || 0) * pct / 100);
      if (scaleVal) scaleVal.textContent = pct + '%';
      scaleDims.textContent = pgT('geOutputDims', [nw, nh]);
    };
  }

  // ---- video transcode events ----
  var vidCodec = document.getElementById('ge-vid-codec');
  var vidFormat = document.getElementById('ge-vid-format');
  var vidCodecCol = document.getElementById('ge-vid-codec-col');
  var vidQualityPresetRow = document.getElementById('ge-vid-quality-preset-row') || document.getElementById('ge-vid-quality-row');
  var vidAudioRow = document.getElementById('ge-vid-audio-row');
  var vidScaleRow = document.getElementById('ge-vid-scale-row');
  var vidAnimBlock = document.getElementById('ge-vid-anim-block');
  var vidAnimGifOpts = document.getElementById('ge-vid-anim-gif-opts');
  var vidAnimWebpOpts = document.getElementById('ge-vid-anim-webp-opts');

  function _isAnimFormat() {
    return vidFormat && (vidFormat.value === 'gif' || vidFormat.value === 'webp');
  }

  // Visibility authority for the transcode form: animated formats hide the
  // video codec/preset/audio/scale rows and show the animated-param block.
  function _updateVidFormatUI() {
    if (!vidFormat) return;
    var isAnim = _isAnimFormat();
    var c = vidCodec ? vidCodec.value : 'h264';
    if (vidCodecCol) vidCodecCol.style.display = isAnim ? 'none' : '';
    if (vidQualityPresetRow) vidQualityPresetRow.style.display = (isAnim || c === 'copy') ? 'none' : '';
    if (vidAudioRow) vidAudioRow.style.display = (isAnim || c === 'copy') ? 'none' : '';
    if (vidScaleRow) vidScaleRow.style.display = isAnim ? 'none' : '';
    if (vidAnimBlock) vidAnimBlock.style.display = isAnim ? '' : 'none';
    if (vidAnimGifOpts) vidAnimGifOpts.style.display = (vidFormat.value === 'gif') ? '' : 'none';
    if (vidAnimWebpOpts) vidAnimWebpOpts.style.display = (vidFormat.value === 'webp') ? '' : 'none';
    _syncAnimLoopOptions();
  }

  // Rebuild the loop-mode select for the current format: GIF may play once
  // (muxer loop -1), WebP never offers "once" (muxer 0 = infinite, N = repeat).
  function _syncAnimLoopOptions() {
    var loopSel = document.getElementById('ge-vid-anim-loop-mode');
    if (!loopSel) return;
    var isGifFmt = vidFormat && vidFormat.value === 'gif';
    var prevVal = loopSel.value || 'infinite';
    var html = '<option value="infinite">' + escapeHtml(T('geLoopInfinite')) + '</option>';
    if (isGifFmt) html += '<option value="once">' + escapeHtml(T('geLoopOnce')) + '</option>';
    html += '<option value="n">' + escapeHtml(T('geLoopRepeatN')) + '</option>';
    loopSel.innerHTML = html;
    loopSel.value = (prevVal === 'once' && !isGifFmt) ? 'infinite' : prevVal;
    if (loopN) loopN.style.display = (loopSel.value === 'n') ? '' : 'none';
  }

  function _updateVidCodecUI() {
    if (!vidCodec) return;
    var c = vidCodec.value;
    // Filter video formats by codec; gif/webp are codec-independent and are
    // never hidden (their availability is decided by _checkFfmpegStatus).
    if (vidFormat) {
      var opts = vidFormat.querySelectorAll('option');
      var allowed = (c === 'copy') ? null : ((c === 'h264' || c === 'h265') ? ['mp4','mkv','mov'] : ['webm','mkv']);
      for (var i = 0; i < opts.length; i++) {
        var v = opts[i].value;
        opts[i].style.display = (!allowed || allowed.indexOf(v) >= 0 || v === 'gif' || v === 'webp') ? '' : 'none';
      }
      // Auto-select first allowed video format
      var sel = vidFormat.value;
      if (sel !== 'gif' && sel !== 'webp' && allowed && allowed.indexOf(sel) < 0) {
        vidFormat.value = allowed[0];
      }
    }
    _updateVidFormatUI();
  }

  if (vidFormat) {
    vidFormat.onchange = function() { _geVidFormat = vidFormat.value; _updateVidFormatUI(); };
  }
  if (vidCodec) { vidCodec.onchange = _updateVidCodecUI; }
  _updateVidCodecUI();
  _updateVidFormatUI();

  // Video scale slider: live "%%" + output dims preview (mirrors the image
  // scale binding above); the server gets the value via _startVideoTranscode.
  var vidScaleInput = document.getElementById('ge-vid-scale');
  var vidScaleVal = document.getElementById('ge-vid-scale-val');
  var vidScaleDims = document.getElementById('ge-vid-scale-dims');
  if (vidScaleInput && vidScaleDims) {
    vidScaleInput.oninput = function() {
      var pct = parseFloat(vidScaleInput.value) || 100;
      var probe = _editProbe || {};
      var nw = Math.round((probe.width || 0) * pct / 100);
      var nh = Math.round((probe.height || 0) * pct / 100);
      if (vidScaleVal) vidScaleVal.textContent = pct + '%';
      vidScaleDims.textContent = pgT('geOutputDims', [nw, nh]);
    };
  }

  // Animated-format param block: quality slider value + loop repeat input
  var animQuality = document.getElementById('ge-vid-anim-quality');
  var animQualityVal = document.getElementById('ge-vid-anim-quality-val');
  if (animQuality && animQualityVal) {
    animQuality.oninput = function() { animQualityVal.textContent = animQuality.value; };
  }
  var loopMode = document.getElementById('ge-vid-anim-loop-mode');
  var loopN = document.getElementById('ge-vid-anim-loop-n');
  if (loopMode && loopN) {
    loopMode.onchange = function() { loopN.style.display = (loopMode.value === 'n') ? '' : 'none'; };
  }

  // ---- video trim events ----
  var trimSelectBtn = document.getElementById('ge-trim-select-btn');
  if (trimSelectBtn) {
    trimSelectBtn.onclick = function() { _enterTrimMode(); };
  }
  // Animated input: numeric Start/End segment panel (no draggable bar)
  var trimAnimAdd = document.getElementById('ge-trim-anim-add');
  var trimAnimClear = document.getElementById('ge-trim-anim-clear');
  if (trimAnimAdd) {
    trimAnimAdd.onclick = _animTrimAddSegment;
  }
  if (trimAnimClear) {
    trimAnimClear.onclick = function() {
      _editTrimSegments = [];
      _updateTrimSegmentDisplay();
    };
  }

  // Trim mode radio toggle + multi-segment hint
  var trimModeRadios = document.querySelectorAll('input[name="ge-trim-mode"]');
  var trimReencodeOpts = document.getElementById('ge-trim-reencode-opts');
  var trimMultiHint = document.getElementById('ge-trim-multi-hint');
  trimModeRadios.forEach(function(r) {
    r.onchange = function() {
      trimReencodeOpts.style.display = (this.value === 'reencode') ? '' : 'none';
    };
  });
  // Show multi-segment re-encode hint when segments > 1
  if (trimMultiHint) trimMultiHint.style.display = (_editTrimSegments.length > 1) ? '' : 'none';

  // ---- video subtitle events ----
  var subFile = document.getElementById('ge-sub-file');
  var subFilename = document.getElementById('ge-sub-filename');
  if (subFile && subFilename) {
    subFile.onchange = function() {
      var f = subFile.files[0];
      if (!f) return;
      subFilename.style.display = '';
      subFilename.querySelector('span').textContent = pgT('geSubtitleUploaded', [f.name]);
      _uploadSubtitle(f, function(err) {
        if (err) { showMsg('Subtitle upload failed: ' + err.message); }
      });
    };
  }

  // Subtitle mode toggle
  var subModeRadios = document.querySelectorAll('input[name="ge-sub-mode"]');
  var burnOpts = document.getElementById('ge-sub-burn-opts');
  var softOpts = document.getElementById('ge-sub-soft-opts');
  subModeRadios.forEach(function(r) {
    r.onchange = function() {
      if (this.value === 'burn') { burnOpts.style.display = ''; softOpts.style.display = 'none'; }
      else { burnOpts.style.display = 'none'; softOpts.style.display = ''; }
    };
  });

  // Video Trim enable checkbox toggle
  var trimEnableCb = document.getElementById('ge-vid-trim-enable');
  var trimBody = document.getElementById('ge-vid-trim-body');
  if (trimEnableCb && trimBody) {
    trimEnableCb.onchange = function() {
      trimBody.style.display = trimEnableCb.checked ? '' : 'none';
    };
  }

  // Video Subtitle enable checkbox toggle
  var subEnableCb = document.getElementById('ge-vid-sub-enable');
  var subBody = document.getElementById('ge-vid-sub-body');
  if (subEnableCb && subBody) {
    subEnableCb.onchange = function() {
      subBody.style.display = subEnableCb.checked ? '' : 'none';
    };
  }

  // ---- Start button ----
  var startBtn = document.getElementById('ge-start-btn');
  if (startBtn) {
    startBtn.onclick = function() {
      if (_editMediaType === 'image') {
        _startImageTranscode();
      } else {
        _startVideoJob();
      }
    };
  }

  // ---- Cancel button ----
  var cancelBtn = document.getElementById('ge-cancel-btn');
  if (cancelBtn) { cancelBtn.onclick = _cancelJob; }
}

// ---------- background-task persistence + console height sync --------
// _geActiveJob tracks an in-progress edit job so closing the modal (or
// switching pages) does NOT lose it: the backend goroutine keeps running,
// and reopening the editor restores the in-progress task instead of
// loading a new item. The lock releases on any terminal state — see
// _onCompleted/_onError/_onCancelled/_onBatchComplete. While non-terminal,
// openMediaEditor ignores the newly clicked item and re-shows the active
// task via _geResumeActive.
//   single: { kind:'single', jobId, item, mediaType, probe }
//   batch:  { kind:'batch',  mediaType, item, probe }  (per-job state in _batchJobs)
function _geSyncConsoleHeight() {
  var ov = document.getElementById('pg-modal-overlay');
  var cp = document.getElementById('ge-console-panel');
  if (!ov || !cp || cp.style.display === 'none') return;
  var left = ov.querySelector('.pg-modal:not(.ge-console-panel)');
  if (left) cp.style.height = Math.round(left.getBoundingClientRect().height) + 'px';
}

function _geWatchConsoleHeight() {
  var ov = document.getElementById('pg-modal-overlay');
  if (!ov || typeof ResizeObserver === 'undefined') return;
  var left = ov.querySelector('.pg-modal:not(.ge-console-panel)');
  if (!left) return;
  if (_geConsoleRO) { try { _geConsoleRO.disconnect(); } catch (e) {} }
  _geConsoleRO = new ResizeObserver(function () { _geSyncConsoleHeight(); });
  _geConsoleRO.observe(left);
  _geSyncConsoleHeight();
}

function _geResumeActive() {
  var ov = document.getElementById('pg-modal-overlay');
  if (ov) ov.classList.add('show');
  _editCurrentItem = _geActiveJob.item;
  _editMediaType = _geActiveJob.mediaType;
  _editProbe = _geActiveJob.probe;
  if (_geActiveJob.kind === 'single') {
    _editJobId = _geActiveJob.jobId;
    _stopPolling();
    _startPolling(_geActiveJob.jobId);
  } else {
    _geBatchPollingEnabled = true;
    var ps = document.getElementById('ge-progress-section');
    if (ps) ps.style.display = 'block';
    var cp = document.getElementById('ge-console-panel');
    if (cp) cp.style.display = 'flex';
    var startBtn = document.getElementById('ge-start-btn');
    if (startBtn) startBtn.disabled = true;
    for (var i = 0; i < _batchJobs.length; i++) {
      var j = _batchJobs[i];
      if (j && !j.done && j.jobId) _pollBatchJob(i, j.jobId);
    }
  }
  _geWatchConsoleHeight();
  _geSyncConsoleHeight();
}

// ---------- entry point ---------------------------------------------
window.openMediaEditor = async function(item, mediaType) {
  if (!item) return;
  if (_geActiveJob) {
    var stillActive = false;
    if (_geActiveJob.kind === 'single') {
      try {
        var rs = await fetch('/api/gallery/edit/status/' + encodeURIComponent(_geActiveJob.jobId));
        if (rs.ok) { var ds = await rs.json(); if (ds && ds.status === 'running') stillActive = true; }
      } catch (e) {}
      if (!stillActive) _geActiveJob = null;
    } else {
      if (_batchDone < _batchTotal && _batchJobs && _batchJobs.length) stillActive = true; else _geActiveJob = null;
    }
    if (stillActive) { _geResumeActive(); return; }
  }
  _editCurrentItem = item;
  _editMediaType = mediaType;
  _editProbe = null;
  _editJobId = null;
  _editSubtitlePath = null;
  _stopPolling();
  _editTrimSegments = [];
  _geVidFormat = 'mp4';

  var html = _buildModalHTML();
  pgShowModal(html);
  _geEnsureConsole();

  // Set a fixed modal width so it does not change between tabs.
  setTimeout(function() {
    var modal = document.querySelector('#pg-modal-overlay .pg-modal');
    if (modal) {
      modal.style.width = '520px';
      modal.style.minWidth = '520px';
    }
  }, 0);

  // Pre-fill destination directory from the Default Download Dir (shared
  // with the download page settings).
  setTimeout(function() {
    fetch('/api/settings')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var dl = (data && data.download) || {};
        _editDefaultDir = dl.defaultDir || '';
        var destDir = document.getElementById('ge-dest-dir');
        if (destDir && dl.defaultDir) destDir.value = dl.defaultDir;
      })
      .catch(function() {});
    // Set Path defaults ON (output → download dir by default) for both image
    // and video; the user can toggle it off to save next to the source.
    var sp = document.getElementById('ge-img-setpath');
    if (sp) {
      sp.checked = true;
      _refreshBatchUXVisibility();
    }
  }, 30);

  // Check ffmpeg availability (disables Start if not found)
  _checkFfmpegStatus();

  // Probe source
  fetch('/api/gallery/edit/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: item.absPath })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    _editProbe = data;
    if (_editMediaType === 'image') {
      // Image: populate the two-row source info. For items without a known
      // size (fs), fetch it best-effort (getFile() is metadata-only) then refresh.
      _updateImageSourceInfo();
      var it = _editCurrentItem;
      if (it && (!it.size || it.size <= 0) && typeof it.getBlob === 'function') {
        it.getBlob().then(function(b) { if (b && b.size) { it.size = b.size; _updateImageSourceInfo(); } }).catch(function() {});
      }
    } else {
      _updateVideoSourceInfo();
      _updateTrimSegmentDisplay();
    }
    // Update scale dimensions hint (shared by image + video scale sliders)
    var scaleDims = document.getElementById('ge-scale-dims');
    if (scaleDims && data.width && data.height) {
      scaleDims.textContent = pgT('geOutputDims', [data.width, data.height]);
    }
  })
  .catch(function(err) {
    if (_editMediaType === 'image') {
      _updateImageSourceInfo();
    } else {
      _updateVideoSourceInfo();
    }
  });

  // Bind events after DOM is rendered
  setTimeout(_bindModalEvents, 20);
};

window.cleanupMediaEditor = function() {
  _stopPolling();
  _editJobId = null;
  _geBatchPollingEnabled = false;
  if (_geConsoleRO) { try { _geConsoleRO.disconnect(); } catch (e) {} _geConsoleRO = null; }
};

window.triggerMediaEditor = function(mediaType) {
  mediaType = mediaType || galleryState.mediaType;
  var isVid = (mediaType === 'video');
  var item = isVid ? galleryState.videoItems[galleryState.videoIndex] : galleryState.items[galleryState.index];
  if (!item) {
    showMsg(T('geNoItem') || 'No item selected');
    return;
  }

  // Resolve disk path: backend items have absPath directly; zip items need extraction.
  if (item.absPath) {
    if (typeof window.openMediaEditor === 'function') {
      window.openMediaEditor(item, mediaType);
    }
    return;
  }

  // Zip items: extract to temp file via backend, then open editor. Archive-
  // source items (sourceId) resolve through the /api/archive bridge; legacy
  // sessions/on-disk zips keep zipAbsPath/sessionId.
  if (item.kind === 'zip' && (item.zipAbsPath || item.sessionId || item.sourceId)) {
    showMsg(T('geExtracting') || 'Extracting from archive...');
    var body = { zipPath: item.zipPath };
    if (item.sourceId) body.sourceId = item.sourceId;
    else if (item.zipAbsPath) body.zipAbsPath = item.zipAbsPath;
    else body.sessionId = item.sessionId;

    fetch('/api/gallery/edit/extract-zip-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
    .then(function(data) {
      // Create a shallow clone with absPath pointing to the temp file.
      var resolved = {};
      for (var k in item) { if (item.hasOwnProperty(k)) resolved[k] = item[k]; }
      resolved.absPath = data.tempPath;
      resolved._tempExtracted = true;
      if (typeof window.openMediaEditor === 'function') {
        window.openMediaEditor(resolved, mediaType);
      }
    })
    .catch(function(err) {
      showMsg((T('geExtractFail') || 'Extract failed') + ': ' + (err.message || err));
    });
    return;
  }

  // FSAA / drag-drop items: upload blob to a temp file via backend.
  if (typeof item.getBlob === 'function') {
    showMsg(T('geExtracting') || 'Preparing file for editing...');
    item.getBlob().then(function(blob) {
      return fetch('/api/gallery/edit/upload-temp?name=' + encodeURIComponent(item.name || 'file'), {
        method: 'POST',
        body: blob
      });
    })
    .then(function(r) {
      return r.json().then(function(d) {
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    })
    .then(function(data) {
      var resolved = {};
      for (var k in item) { if (item.hasOwnProperty(k)) resolved[k] = item[k]; }
      resolved.absPath = data.tempPath;
      resolved._tempExtracted = true;
      if (typeof window.openMediaEditor === 'function') {
        window.openMediaEditor(resolved, mediaType);
      }
    })
    .catch(function(err) {
      showMsg((T('geExtractFail') || 'Prepare failed') + ': ' + (err.message || err));
    });
    return;
  }

  // Truly unsupported item kind.
  showMsg(T('geNoDiskPath') || 'This item does not have a disk path. Open files from a directory to enable editing.');
};
