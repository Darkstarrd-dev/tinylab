// gallery-edit.js — Gallery media editor modal (ffmpeg-based image/video transformations).
// Exposes window.openMediaEditor(item, mediaType) and window.cleanupMediaEditor().

'use strict';

// ---------- editor state -------------------------------------------
var _editJobId = null;
var _editPollTimer = null;
var _editCurrentItem = null;
var _editMediaType = null;
var _editProbe = null;
var _editSubtitlePath = null;

// ---------- helpers ------------------------------------------------

function _geT(k, ar) {
  return (typeof pgT === 'function') ? pgT(k, ar) : k;
}

// Parse a time string (HH:MM:SS or bare seconds) to float seconds.
function _parseTimeToSec(s) {
  if (!s || !s.trim()) return NaN;
  s = s.trim();
  var parts = s.split(':');
  if (parts.length === 3) {
    var h = parseFloat(parts[0]), m = parseFloat(parts[1]), sec = parseFloat(parts[2]);
    if (isNaN(h) || isNaN(m) || isNaN(sec)) return NaN;
    return h * 3600 + m * 60 + sec;
  }
  if (parts.length === 2) {
    var m2 = parseFloat(parts[0]), sec2 = parseFloat(parts[1]);
    if (isNaN(m2) || isNaN(sec2)) return NaN;
    return m2 * 60 + sec2;
  }
  return parseFloat(s);
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
  if (text) { text.textContent = _geT('geRunning') + ' (' + (data.progress || 0) + '%)'; }
  var logEl = document.getElementById('ge-log-tail');
  if (logEl && data.logTail) { logEl.textContent = data.logTail; }
}

function _showProgressSection() {
  var s = document.getElementById('ge-progress-section');
  if (s) s.style.display = 'block';
  var startBtn = document.getElementById('ge-start-btn');
  if (startBtn) startBtn.disabled = true;
}

function _hideProgressSection() {
  var s = document.getElementById('ge-progress-section');
  if (s) s.style.display = 'none';
  var startBtn = document.getElementById('ge-start-btn');
  if (startBtn) startBtn.disabled = false;
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
  _setProgressStatus(_geT('geCompleted'), false);
  var bar = document.getElementById('ge-progress-bar');
  if (bar) bar.value = 100;

  // Build result block
  var logHtml = data.logTail ? '<details style="margin-top:8px"><summary>' + escapeHtml(_geT('geLogTail')) + '</summary><pre style="background:#1a1326;border:1px solid var(--glass-border);padding:8px;font-size:11px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all">' + escapeHtml(data.logTail) + '</pre></details>' : '';

  var outputName = data.outputName || _geT('geEmptyName');
  var outputURL = data.outputURL || '';
  var outputPath = data.outputPath || '';

  var resultHtml = '<div class="gallery-edit-result">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(_geT('geCompleted')) + '</span>' +
      '<span style="font-size:12px;color:var(--text-secondary)">' + escapeHtml(outputName) + '</span>' +
    '</div>' +
    '<div class="gallery-edit-actions">' +
      '<button class="pg-btn" id="ge-show-btn">' + escapeHtml(_geT('geShowInGallery')) + '</button>' +
      (outputURL ? '<a class="pg-btn" href="' + escapeHtml(outputURL) + '" download="' + escapeHtml(outputName) + '">' + escapeHtml(_geT('geDownload')) + '</a>' : '') +
    '</div>' +
    logHtml +
  '</div>';

  var resultEl = document.getElementById('ge-result-area');
  if (resultEl) {
    resultEl.innerHTML = resultHtml;
    resultEl.style.display = 'block';
  }

  // Bind Show in Gallery
  var showBtn = document.getElementById('ge-show-btn');
  if (showBtn && outputURL) {
    showBtn.onclick = function() {
      _addOutputToGallery(outputName, outputPath, outputURL);
    };
  }
}

function _onError(data) {
  _stopPolling();
  _editJobId = null;
  _setProgressStatus(_geT('geFailed'), true);
  var msg = data.error || _geT('geFailed');
  var logHtml = data.logTail ? '<details style="margin-top:8px"><summary>' + escapeHtml(_geT('geLogTail')) + '</summary><pre style="background:#1a1326;border:1px solid var(--danger);padding:8px;font-size:11px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--danger)">' + escapeHtml(data.logTail) + '</pre></details>' : '';
  var resultEl = document.getElementById('ge-result-area');
  if (resultEl) {
    resultEl.innerHTML = '<div class="gallery-edit-result" style="border-color:var(--danger)"><span style="color:var(--danger);font-weight:600">\u2718 ' + escapeHtml(msg) + '</span>' + logHtml + '</div>';
    resultEl.style.display = 'block';
  }
  _hideProgressSection();
}

function _onCancelled() {
  _stopPolling();
  _editJobId = null;
  _setProgressStatus(_geT('geCancelled'), false);
  var resultEl = document.getElementById('ge-result-area');
  if (resultEl) {
    resultEl.innerHTML = '<div class="gallery-edit-result" style="opacity:0.7"><span>' + escapeHtml(_geT('geCancelled')) + '</span></div>';
    resultEl.style.display = 'block';
  }
  _hideProgressSection();
}

// ---------- add output to gallery -----------------------------------
function _addOutputToGallery(outputName, outputPath, outputURL) {
  if (!outputURL || !outputPath) return;
  // Determine parent directory from outputPath
  var lastSep = Math.max(outputPath.lastIndexOf('/'), outputPath.lastIndexOf('\\'));
  var rootDirPath = lastSep >= 0 ? outputPath.substring(0, lastSep) : '';
  var isVideo = _editMediaType === 'video';
  var item = {
    name: outputName,
    path: outputName,
    kind: 'backend',
    absPath: outputPath,
    rootDirPath: rootDirPath,
    getBlob: function() {
      return fetch('/api/gallery/file?path=' + encodeURIComponent(outputPath)).then(function(r) {
        if (!r.ok) throw new Error('file http ' + r.status);
        return r.blob();
      });
    },
    size: 0
  };
  if (isVideo) {
    if (typeof appendVideoItems === 'function') {
      appendVideoItems([item]);
      if (typeof setVideoActive === 'function') { setVideoActive(galleryState.videoItems.length - 1); }
    }
  } else {
    if (typeof appendItems === 'function') {
      appendItems([item]);
      if (typeof setActive === 'function') { setActive(galleryState.items.length - 1); }
    }
  }
  pgCloseModal();
}

// ---------- cancel job ----------------------------------------------
function _cancelJob() {
  if (!_editJobId) return;
  fetch('/api/gallery/edit/cancel/' + encodeURIComponent(_editJobId), { method: 'POST' })
    .catch(function(err) { console.warn('Cancel job error:', err); });
  _onCancelled();
}

// ---------- start job -----------------------------------------------
function _startJob(op, params, overwrite, outputDir) {
  if (!_editCurrentItem || !_editCurrentItem.absPath) return;
  _editJobId = null;
  var resultEl = document.getElementById('ge-result-area');
  if (resultEl) { resultEl.innerHTML = ''; resultEl.style.display = 'none'; }
  _showProgressSection();
  var body = { inputPath: _editCurrentItem.absPath, operation: op, overwrite: !!overwrite, params: params };
  if (outputDir && !overwrite) body.outputDir = outputDir;
  fetch('/api/gallery/edit/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
  .then(function(data) {
    _editJobId = data.jobId;
    _startPolling(data.jobId);
  })
  .catch(function(err) {
    _onError({ error: err.message || String(err) });
  });
}

// ---------- upload subtitle ------------------------------------------
function _uploadSubtitle(file, callback) {
  fetch('/api/gallery/edit/subtitle-upload?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    body: file
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
  .then(function(data) {
    _editSubtitlePath = data.subtitlePath;
    if (callback) callback(null, data);
  })
  .catch(function(err) {
    if (callback) callback(err);
  });
}

// ---------- batch mode helpers ----------------------------------------

// _getSiblingImages returns all items in galleryState.items that share the
// same directory as _editCurrentItem AND have an absPath.
function _getSiblingImages() {
  if (!_editCurrentItem || !_editCurrentItem.absPath) return [];
  var lastSep = Math.max(_editCurrentItem.absPath.lastIndexOf('/'), _editCurrentItem.absPath.lastIndexOf('\\'));
  var srcDir = lastSep >= 0 ? _editCurrentItem.absPath.substring(0, lastSep) : '';
  var siblings = [];
  var items = galleryState.items || [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || !it.absPath) continue;
    var itDir = it.absPath.substring(0, Math.max(it.absPath.lastIndexOf('/'), it.absPath.lastIndexOf('\\')));
    if (itDir === srcDir) siblings.push(it);
  }
  return siblings;
}

var _batchJobs = [];
var _batchTotal = 0;
var _batchDone = 0;
var _batchDest = null;
var _batchParams = null;
var _batchOp = null;

function _startBatch(op, params, dest) {
  var siblings = _getSiblingImages();
  if (siblings.length === 0) { showMsg(_geT('geNoBatchItems')); return; }
  _batchJobs = [];
  _batchTotal = siblings.length;
  _batchDone = 0;
  _batchDest = dest;
  _batchParams = params;
  _batchOp = op;

  _stopPolling();
  var resultEl = document.getElementById('ge-result-area');
  if (resultEl) { resultEl.innerHTML = ''; resultEl.style.display = 'none'; }
  _showProgressSection();
  _setProgressStatus(_geT('geBatchProgress', ['0', String(_batchTotal)]), false);

  for (var i = 0; i < siblings.length; i++) {
    var it = siblings[i];
    var body = { inputPath: it.absPath, operation: op, overwrite: !!dest.overwrite, params: params };
    if (dest.outputDir && !dest.overwrite) body.outputDir = dest.outputDir;

    var job = { item: it, jobId: null, done: false, error: null };
    _batchJobs.push(job);

    (function(idx, reqBody) {
      fetch('/api/gallery/edit/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      })
      .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
      .then(function(data) {
        var j = _batchJobs[idx];
        if (!j) return;
        j.jobId = data.jobId;
        _pollBatchJob(idx, data.jobId);
      })
      .catch(function(err) {
        var j = _batchJobs[idx];
        if (!j) return;
        j.done = true;
        j.error = err.message || String(err);
        _batchDone++;
        _setProgressStatus(_geT('geBatchProgress', [String(_batchDone), String(_batchTotal)]), false);
        if (_batchDone >= _batchTotal) _onBatchComplete();
      });
    })(i, body);
  }
}

function _pollBatchJob(idx, jobId) {
  fetch('/api/gallery/edit/status/' + encodeURIComponent(jobId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var j = _batchJobs[idx];
      if (!j) return;
      if (data.status === 'running') {
        setTimeout(function() { _pollBatchJob(idx, jobId); }, 600);
      } else {
        j.done = true;
        if (data.status === 'completed') {
          j.outputPath = data.outputPath;
          j.outputName = data.outputName;
          j.outputURL = data.outputURL;
        } else {
          j.error = data.error || data.status;
        }
        _batchDone++;
        _setProgressStatus(_geT('geBatchProgress', [String(_batchDone), String(_batchTotal)]), false);
        if (_batchDone >= _batchTotal) _onBatchComplete();
      }
    })
    .catch(function(err) {
      var j = _batchJobs[idx];
      if (j) { j.done = true; j.error = err.message || String(err); }
      _batchDone++;
      _setProgressStatus(_geT('geBatchProgress', [String(_batchDone), String(_batchTotal)]), false);
      if (_batchDone >= _batchTotal) _onBatchComplete();
    });
}

function _onBatchComplete() {
  _editJobId = null;
  _hideProgressSection();
  var ok = 0, fail = 0;
  for (var i = 0; i < _batchJobs.length; i++) {
    if (_batchJobs[i].error) fail++;
    else ok++;
  }
  var resultEl = document.getElementById('ge-result-area');
  var html = '<div class="gallery-edit-result">';
  html += '<span style="color:var(--accent2);font-weight:600">&#10004; ' + escapeHtml(_geT('geBatchDone', [String(ok), String(fail)])) + '</span>';
  html += '<div class="gallery-edit-actions">';
  html += '<button class="pg-btn" id="ge-show-batch-btn">' + escapeHtml(_geT('geShowInGallery')) + '</button>';
  html += '</div></div>';
  if (resultEl) {
    resultEl.innerHTML = html;
    resultEl.style.display = 'block';
  }

  var showBtn = document.getElementById('ge-show-batch-btn');
  if (showBtn) {
    showBtn.onclick = function() {
      var added = false;
      for (var i = 0; i < _batchJobs.length; i++) {
        var j = _batchJobs[i];
        if (!j.error && j.outputPath && j.outputURL) {
          _addOutputToGallery(j.outputName, j.outputPath, j.outputURL);
          added = true;
        }
      }
      if (added) pgCloseModal();
    };
  }

  _batchJobs = [];
}

// ---------- modal render ---------------------------------------------

function _renderImageForm() {
  var probe = _editProbe || {};
  var w = probe.width || 0, h = probe.height || 0;
  var srcExt = _editCurrentItem ? (extOf(_editCurrentItem.name) || 'png').toLowerCase() : 'png';
  var formatOptions = ['jpeg', 'png', 'webp', 'bmp', 'tiff', 'gif'];
  var selectedFormat = srcExt;
  if (formatOptions.indexOf(selectedFormat) < 0) selectedFormat = 'png';
  if (selectedFormat === 'jpg') selectedFormat = 'jpeg';

  var html = '';

  // Source info
  html += '<div class="gallery-edit-info">';
  html += '<span><strong>' + escapeHtml(_geT('geSourceInfo')) + ':</strong> ' + w + '\u00d7' + h;
  var codecStr = probe.codec ? ', ' + probe.codec : '';
  html += codecStr + '</span>';
  html += '</div>';

  // Batch mode
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check">';
  html += '<input type="checkbox" id="ge-img-batch"> ' + escapeHtml(_geT('geBatchConvert'));
  html += '</label>';
  html += '<span id="ge-batch-count" style="font-size:11px;color:var(--text-muted);margin-left:8px"></span>';
  html += '</div>';

  // Format select
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geFormat')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-img-format">';
  for (var i = 0; i < formatOptions.length; i++) {
    var f = formatOptions[i];
    html += '<option value="' + f + '"' + (f === selectedFormat ? ' selected' : '') + '>' + f.toUpperCase() + '</option>';
  }
  html += '</select>';
  html += '</div>';

  // Quality slider (only for jpeg/webp)
  html += '<div class="gallery-edit-row" id="ge-img-quality-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geQuality')) + '</label>';
  html += '<input type="range" id="ge-img-quality" min="0" max="100" value="85" style="flex:1">';
  html += '<span class="gallery-edit-val" id="ge-quality-val">85</span>';
  html += '</div>';

  // PNG lossless note
  html += '<div class="gallery-edit-row" id="ge-img-lossless-note" style="display:none">';
  html += '<span style="font-size:11px;color:var(--text-muted);margin-left:auto">' + escapeHtml(_geT('geQualityHint')) + '</span>';
  html += '</div>';

  // Scale percent
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geScalePercent')) + '</label>';
  html += '<input type="number" id="ge-img-scale" min="10" max="200" value="100" style="width:80px">';
  html += '<span class="gallery-edit-val" id="ge-scale-dims">' + escapeHtml(_geT('geOutputDims', [w, h])) + '</span>';
  html += '</div>';

  // Strip metadata
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check">';
  html += '<input type="checkbox" id="ge-img-strip"> ' + escapeHtml(_geT('geStripMetadata'));
  html += '</label>';
  html += '</div>';


  return html;
}

function _renderVideoTranscodeForm() {
  var probe = _editProbe || {};
  var w = probe.width || 0, h = probe.height || 0;

  var html = '';

  // Codec select
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geCodec')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-codec">';
  html += '<option value="h264">H.264</option><option value="h265">H.265/HEVC</option><option value="vp9">VP9</option><option value="av1">AV1</option><option value="copy">Copy (no re-encode)</option>';
  html += '</select>';
  html += '</div>';

  // Container select
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geContainer')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-container">';
  html += '<option value="mp4">MP4</option><option value="mkv">MKV</option><option value="webm">WebM</option><option value="mov">MOV</option>';
  html += '</select>';
  html += '</div>';

  // Quality tier
  html += '<div class="gallery-edit-row" id="ge-vid-quality-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geQualityTier')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-quality">';
  html += '<option value="high">High</option><option value="medium" selected>Medium</option><option value="low">Low</option>';
  html += '</select>';
  html += '</div>';

  // Preset
  html += '<div class="gallery-edit-row" id="ge-vid-preset-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('gePreset')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-preset">';
  html += '<option value="ultrafast">ultrafast</option><option value="fast">fast</option><option value="medium" selected>medium</option><option value="slow">slow</option><option value="veryslow">veryslow</option>';
  html += '</select>';
  html += '</div>';

  // Scale percent
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geScalePercent')) + '</label>';
  html += '<input type="number" id="ge-vid-scale" min="10" max="200" value="100" style="width:80px">';
  html += '</div>';

  // Audio codec
  html += '<div class="gallery-edit-row" id="ge-vid-audio-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geAudioCodec')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-vid-audio-codec">';
  html += '<option value="aac">AAC</option><option value="opus">Opus</option><option value="mp3">MP3</option><option value="copy">Copy</option><option value="none">None</option>';
  html += '</select>';
  html += '</div>';

  // Audio bitrate
  html += '<div class="gallery-edit-row" id="ge-vid-ab-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geAudioBitrate')) + '</label>';
  html += '<input type="text" id="ge-vid-audio-bitrate" value="128k" style="width:80px">';
  html += '</div>';

  // Strip metadata
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check">';
  html += '<input type="checkbox" id="ge-vid-strip"> ' + escapeHtml(_geT('geStripMetadata'));
  html += '</label>';
  html += '</div>';


  return html;
}

function _renderVideoTrimForm() {
  var html = '';

  // Start time
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geTrimStart')) + '</label>';
  html += '<input type="text" id="ge-trim-start" placeholder="' + escapeHtml(_geT('geTrimStartPlaceholder')) + '" style="width:140px">';
  html += '</div>';

  // Duration
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geTrimDuration')) + '</label>';
  html += '<input type="text" id="ge-trim-duration" placeholder="' + escapeHtml(_geT('geTrimDurationPlaceholder')) + '" style="width:140px">';
  html += '</div>';

  // Preview hint
  html += '<div class="gallery-edit-row">';
  html += '<span class="gallery-edit-val" id="ge-trim-preview" style="font-size:12px;color:var(--text-muted)"></span>';
  html += '</div>';

  // Re-encode mode
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check" style="margin-right:16px">';
  html += '<input type="radio" name="ge-trim-mode" value="copy" checked> ' + escapeHtml(_geT('geFastCopy'));
  html += '</label>';
  html += '<label class="gallery-edit-check">';
  html += '<input type="radio" name="ge-trim-mode" value="reencode"> ' + escapeHtml(_geT('geAccurateEncode'));
  html += '</label>';
  html += '</div>';

  // Re-encode options
  html += '<div id="ge-trim-reencode-opts" style="display:none">';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geCodec')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-trim-codec">';
  html += '<option value="h264">H.264</option><option value="h265">H.265/HEVC</option><option value="vp9">VP9</option><option value="av1">AV1</option>';
  html += '</select>';
  html += '</div>';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geQualityTier')) + '</label>';
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
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geSubtitleFile')) + '</label>';
  html += '<input type="file" id="ge-sub-file" accept=".srt,.ass,.ssa,.vtt" style="flex:1">';
  html += '</div>';
  html += '<div class="gallery-edit-row" id="ge-sub-filename" style="display:none">';
  html += '<span style="font-size:12px;color:var(--accent2)"></span>';
  html += '</div>';

  // Mode
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geSubtitleMode')) + '</label>';
  html += '<label class="gallery-edit-check" style="margin-right:16px">';
  html += '<input type="radio" name="ge-sub-mode" value="burn" checked> ' + escapeHtml(_geT('geBurnIn'));
  html += '</label>';
  html += '<label class="gallery-edit-check">';
  html += '<input type="radio" name="ge-sub-mode" value="soft"> ' + escapeHtml(_geT('geSoftSub'));
  html += '</label>';
  html += '</div>';

  // Burn-in options
  html += '<div id="ge-sub-burn-opts">';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geFontSize')) + '</label>';
  html += '<input type="number" id="ge-sub-fontsize" min="8" max="72" value="24" style="width:80px">';
  html += '</div>';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geFontName')) + '</label>';
  html += '<input type="text" id="ge-sub-fontname" placeholder="' + escapeHtml(_geT('geFontNamePlaceholder')) + '" style="flex:1">';
  html += '</div>';
  html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;text-align:right">' + escapeHtml(_geT('geFontCJKHint')) + '</div>';
  html += '</div>';

  // Soft-sub options (hidden initially)
  html += '<div id="ge-sub-soft-opts" style="display:none">';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geLanguage')) + '</label>';
  html += '<input type="text" id="ge-sub-lang" value="eng" placeholder="' + escapeHtml(_geT('geLanguagePlaceholder')) + '" style="width:80px">';
  html += '</div>';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geContainer')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-sub-container">';
  html += '<option value="mkv" selected>MKV</option><option value="mp4">MP4</option>';
  html += '</select>';
  html += '</div>';
  html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;text-align:right">' + escapeHtml(_geT('geSoftSubNote')) + '</div>';
  html += '</div>';


  return html;
}

function _buildModalHTML() {
  var isImage = _editMediaType === 'image';
  var title = isImage ? _geT('geEditImage') : _geT('geEditVideo');
  var itemName = _editCurrentItem ? escapeHtml(_editCurrentItem.name) : '';

  var html = '';
  html += '<div class="pg-modal-header">';
  html += '<span class="pg-modal-title">' + title + ': ' + itemName + '</span>';
  html += '<button class="pg-modal-close" onclick="pgCloseModal()">\u2715</button>';
  html += '</div>';

  html += '<div class="pg-modal-body gallery-edit-body">';

  // FFmpeg warning
  html += '<div id="ge-ffmpeg-warn" style="display:none;padding:8px 12px;background:rgba(239,68,68,0.1);border:1px solid var(--danger);border-radius:var(--radius-sm);margin-bottom:12px;font-size:13px;color:var(--danger)">';
  html += '<strong>' + escapeHtml(_geT('geFfmpegNA')) + '</strong>: ' + escapeHtml(_geT('geFfmpegNAHint'));
  html += '</div>';

  // Source info line
  html += '<div class="gallery-edit-info" id="ge-source-info">';
  html += '<span>' + escapeHtml(_geT('geSourceInfo')) + ': <span id="ge-source-detail">Loading...</span></span>';
  html += '</div>';
  // Destination section
  html += '<div class="gallery-edit-section">';
  html += '<div class="gallery-edit-row"><span style="font-weight:600;font-size:13px;color:var(--text-secondary)">' + escapeHtml(_geT('geDest')) + '</span></div>';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check" style="margin-right:16px">';
  html += '<input type="radio" name="ge-dest" value="overwrite" checked> ' + escapeHtml(_geT('geReplaceOriginal'));
  html += '</label>';
  html += '<label class="gallery-edit-check">';
  html += '<input type="radio" name="ge-dest" value="dir"> ' + escapeHtml(_geT('geSaveToDir'));
  html += '</label>';
  html += '</div>';
  html += '<div class="gallery-edit-row" id="ge-dest-dir-row" style="display:none">';
  html += '<input type="text" id="ge-dest-dir" style="flex:1" placeholder="' + escapeHtml(_geT('geDestDirPlaceholder')) + '">';
  html += '</div>';
  html += '</div>';

  if (isImage) {
    // Image: simple form
    html += '<div class="gallery-edit-section" id="ge-img-section">';
    html += _renderImageForm();
    html += '</div>';
  } else {
    // Video: tabbed
    html += '<div class="gallery-edit-tabs">';
    html += '<button class="gallery-edit-tab active" data-tab="transcode">' + escapeHtml(_geT('geTranscodeTab')) + '</button>';
    html += '<button class="gallery-edit-tab" data-tab="trim">' + escapeHtml(_geT('geTrimTab')) + '</button>';
    html += '<button class="gallery-edit-tab" data-tab="subtitle">' + escapeHtml(_geT('geSubtitleTab')) + '</button>';
    html += '</div>';

    html += '<div class="gallery-edit-section" id="ge-tab-transcode">';
    html += _renderVideoTranscodeForm();
    html += '</div>';
    html += '<div class="gallery-edit-section" id="ge-tab-trim" style="display:none">';
    html += _renderVideoTrimForm();
    html += '</div>';
    html += '<div class="gallery-edit-section" id="ge-tab-subtitle" style="display:none">';
    html += _renderVideoSubtitleForm();
    html += '</div>';
  }

  // Progress section (hidden initially)
  html += '<div class="gallery-edit-section" id="ge-progress-section" style="display:none">';
  html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">';
  html += '<progress id="ge-progress-bar" value="0" max="100" style="flex:1;height:8px"></progress>';
  html += '<button class="pg-btn danger" id="ge-cancel-btn" style="font-size:11px;padding:2px 8px">' + escapeHtml(_geT('geCancelJob')) + '</button>';
  html += '</div>';
  html += '<span id="ge-progress-text" style="font-size:12px;color:var(--text-muted)">' + escapeHtml(_geT('geRunning')) + '</span>';
  html += '</div>';

  // Result area
  html += '<div id="ge-result-area" style="display:none"></div>';

  // Start button
  html += '<div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">';
  html += '<button class="pg-btn" id="ge-start-btn" style="background:var(--accent);color:#000;border-color:var(--accent);font-weight:600">' + escapeHtml(_geT('geStart')) + '</button>';
  html += '</div>';

  html += '</div>'; // pg-modal-body

  return html;
}

// ---------- event binding -------------------------------------------
function _bindModalEvents() {
  // Destination radio toggle
  var destRadios = document.querySelectorAll('input[name="ge-dest"]');
  var destDirRow = document.getElementById('ge-dest-dir-row');
  destRadios.forEach(function(r) {
    r.onchange = function() {
      if (destDirRow) destDirRow.style.display = (this.value === 'dir') ? '' : 'none';
    };
  });

  // Batch checkbox — update count
  var batchCb = document.getElementById('ge-img-batch');
  if (batchCb) {
    batchCb.onchange = function() {
      var countEl = document.getElementById('ge-batch-count');
      if (countEl) {
        if (batchCb.checked) {
          var sib = _getSiblingImages();
          countEl.textContent = '(' + sib.length + ' ' + _geT('geBatchFiles') + ')';
        } else {
          countEl.textContent = '';
        }
      }
    };
  }
  // ---- image events ----
  var fmtSelect = document.getElementById('ge-img-format');
  var qualityRow = document.getElementById('ge-img-quality-row');
  var losslessNote = document.getElementById('ge-img-lossless-note');
  var qualitySlider = document.getElementById('ge-img-quality');
  var qualityVal = document.getElementById('ge-quality-val');
  var scaleInput = document.getElementById('ge-img-scale');
  var scaleDims = document.getElementById('ge-scale-dims');

  if (fmtSelect && qualityRow && losslessNote) {
    fmtSelect.onchange = function() {
      var v = fmtSelect.value;
      var showQuality = (v === 'jpeg' || v === 'webp');
      qualityRow.style.display = showQuality ? '' : 'none';
      losslessNote.style.display = (v === 'png') ? '' : 'none';
    };
    // Initial state
    fmtSelect.onchange();
  }

  if (qualitySlider && qualityVal) {
    qualitySlider.oninput = function() { qualityVal.textContent = qualitySlider.value; };
  }

  if (scaleInput && scaleDims) {
    scaleInput.oninput = function() {
      var pct = parseFloat(scaleInput.value) || 100;
      var probe = _editProbe || {};
      var nw = Math.round((probe.width || 0) * pct / 100);
      var nh = Math.round((probe.height || 0) * pct / 100);
      scaleDims.textContent = _geT('geOutputDims', [nw, nh]);
    };
  }

  // ---- video transcode events ----
  var vidCodec = document.getElementById('ge-vid-codec');
  var vidQualityRow = document.getElementById('ge-vid-quality-row');
  var vidPresetRow = document.getElementById('ge-vid-preset-row');
  var vidAudioRow = document.getElementById('ge-vid-audio-row');
  var vidAbRow = document.getElementById('ge-vid-ab-row');
  var vidContainer = document.getElementById('ge-vid-container');

  function _updateVidCodecUI() {
    if (!vidCodec) return;
    var c = vidCodec.value;
    var isCopy = (c === 'copy');
    if (vidQualityRow) vidQualityRow.style.display = isCopy ? 'none' : '';
    if (vidPresetRow) vidPresetRow.style.display = isCopy ? 'none' : '';
    if (vidAudioRow) vidAudioRow.style.display = isCopy ? 'none' : '';
    if (vidAbRow) vidAbRow.style.display = isCopy ? 'none' : '';
    // Filter containers based on codec
    if (vidContainer) {
      var opts = vidContainer.querySelectorAll('option');
      var allowed = (c === 'copy') ? null : ((c === 'h264' || c === 'h265') ? ['mp4','mkv','mov'] : ['webm','mkv']);
      for (var i = 0; i < opts.length; i++) {
        if (!allowed || allowed.indexOf(opts[i].value) >= 0) {
          opts[i].style.display = '';
        } else {
          opts[i].style.display = 'none';
        }
      }
      // Auto-select first allowed
      var sel = vidContainer.value;
      if (allowed && allowed.indexOf(sel) < 0) vidContainer.value = allowed[0];
    }
  }

  if (vidCodec) { vidCodec.onchange = _updateVidCodecUI; _updateVidCodecUI(); }

  // ---- video trim events ----
  var trimStart = document.getElementById('ge-trim-start');
  var trimDuration = document.getElementById('ge-trim-duration');
  var trimPreview = document.getElementById('ge-trim-preview');
  function _updateTrimPreview() {
    if (!trimPreview) return;
    var s = _parseTimeToSec((trimStart && trimStart.value) || '');
    var d = _parseTimeToSec((trimDuration && trimDuration.value) || '');
    if (!isNaN(s) && !isNaN(d)) {
      trimPreview.textContent = _geT('geTrimPreview', [_formatSecToTime(s), _formatSecToTime(s + d)]);
    } else {
      trimPreview.textContent = '';
    }
  }
  if (trimStart) { trimStart.oninput = _updateTrimPreview; }
  if (trimDuration) { trimDuration.oninput = _updateTrimPreview; }

  // Trim mode toggle
  var trimModeRadios = document.querySelectorAll('input[name="ge-trim-mode"]');
  var trimReencodeOpts = document.getElementById('ge-trim-reencode-opts');
  trimModeRadios.forEach(function(r) {
    r.onchange = function() {
      trimReencodeOpts.style.display = (this.value === 'reencode') ? '' : 'none';
    };
  });

  // ---- video subtitle events ----
  var subFile = document.getElementById('ge-sub-file');
  var subFilename = document.getElementById('ge-sub-filename');
  if (subFile && subFilename) {
    subFile.onchange = function() {
      var f = subFile.files[0];
      if (!f) return;
      subFilename.style.display = '';
      subFilename.querySelector('span').textContent = _geT('geSubtitleUploaded', [f.name]);
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

  // ---- video tabs ----
  var tabs = document.querySelectorAll('.gallery-edit-tab');
  tabs.forEach(function(t) {
    t.onclick = function() {
      var tabName = t.getAttribute('data-tab');
      tabs.forEach(function(tb) { tb.classList.remove('active'); });
      t.classList.add('active');
      document.querySelectorAll('.gallery-edit-section[id^="ge-tab-"]').forEach(function(s) { s.style.display = 'none'; });
      var section = document.getElementById('ge-tab-' + tabName);
      if (section) section.style.display = '';
    };
  });

  // ---- Start button ----
  var startBtn = document.getElementById('ge-start-btn');
  if (startBtn) {
    startBtn.onclick = function() {
      if (_editMediaType === 'image') {
        _startImageTranscode();
      } else {
        var activeTab = document.querySelector('.gallery-edit-tab.active');
        var tabName = activeTab ? activeTab.getAttribute('data-tab') : 'transcode';
        if (tabName === 'transcode') _startVideoTranscode();
        else if (tabName === 'trim') _startVideoTrim();
        else if (tabName === 'subtitle') _startVideoSubtitle();
      }
    };
  }

  // ---- Cancel button ----
  var cancelBtn = document.getElementById('ge-cancel-btn');
  if (cancelBtn) { cancelBtn.onclick = _cancelJob; }
}

// ---------- start operation helpers ---------------------------------
function _getDestination() {
  var radio = document.querySelector('input[name="ge-dest"]:checked');
  if (!radio || radio.value === 'overwrite') return { overwrite: true, outputDir: null };
  var dirInput = document.getElementById('ge-dest-dir');
  var dir = dirInput ? dirInput.value.trim() : '';
  return { overwrite: false, outputDir: dir || null };
}

function _startImageTranscode() {
  var format = document.getElementById('ge-img-format').value;
  var quality = parseInt(document.getElementById('ge-img-quality').value) || 85;
  var scalePercent = parseInt(document.getElementById('ge-img-scale').value) || 100;
  var stripMetadata = document.getElementById('ge-img-strip').checked;
  var batch = document.getElementById('ge-img-batch').checked;
  var dest = _getDestination();
  var params = { format: format, quality: quality, scalePercent: scalePercent, stripMetadata: stripMetadata };
  if (batch) {
    _startBatch('image_transcode', params, dest);
  } else {
    _startJob('image_transcode', params, dest.overwrite, dest.outputDir);
  }
}

function _startVideoTranscode() {
  var codec = document.getElementById('ge-vid-codec').value;
  var container = document.getElementById('ge-vid-container').value;
  var qualityTier = document.getElementById('ge-vid-quality').value;
  var preset = document.getElementById('ge-vid-preset').value;
  var scalePercent = parseInt(document.getElementById('ge-vid-scale').value) || 100;
  var audioCodec = document.getElementById('ge-vid-audio-codec').value;
  var audioBitrate = document.getElementById('ge-vid-audio-bitrate').value || '128k';
  var stripMetadata = document.getElementById('ge-vid-strip').checked;

  // Hide preset if codec=copy
  if (codec === 'copy') preset = 'medium';

  var dest = _getDestination();
  _startJob('video_transcode', {
    codec: codec, container: container, qualityTier: qualityTier,
    preset: preset, scalePercent: scalePercent,
    audioCodec: audioCodec, audioBitrate: audioBitrate,
    stripMetadata: stripMetadata
  }, dest.overwrite, dest.outputDir);
}

function _startVideoTrim() {
  var startStr = document.getElementById('ge-trim-start').value;
  var durationStr = document.getElementById('ge-trim-duration').value;
  if (!startStr || !durationStr) { showMsg('Start time and duration are required'); return; }
  var start = _parseTimeToSec(startStr);
  var duration = _parseTimeToSec(durationStr);
  if (isNaN(start) || isNaN(duration)) { showMsg('Invalid time format'); return; }

  var modeRadio = document.querySelector('input[name="ge-trim-mode"]:checked');
  var reencode = modeRadio ? modeRadio.value === 'reencode' : false;
  var codec = 'h264', qualityTier = 'medium';
  if (reencode) {
    codec = document.getElementById('ge-trim-codec').value;
    qualityTier = document.getElementById('ge-trim-quality').value;
  }

  var dest = _getDestination();
  _startJob('video_trim', {
    start: String(start), duration: String(duration),
    reencode: reencode, codec: codec, qualityTier: qualityTier
  }, dest.overwrite, dest.outputDir);
}

function _startVideoSubtitle() {
  if (!_editSubtitlePath) { showMsg('Please select a subtitle file first'); return; }
  var modeRadio = document.querySelector('input[name="ge-sub-mode"]:checked');
  var mode = modeRadio ? modeRadio.value : 'burn';
  var lang = document.getElementById('ge-sub-lang').value || 'eng';
  var fontSize = parseInt(document.getElementById('ge-sub-fontsize').value) || 24;
  var fontName = document.getElementById('ge-sub-fontname').value || '';
  var container = document.getElementById('ge-sub-container').value;

  var dest = _getDestination();
  _startJob('video_subtitle', {
    subtitlePath: _editSubtitlePath, mode: mode,
    language: lang, fontSize: fontSize,
    fontName: fontName, container: container
  }, dest.overwrite, dest.outputDir);
}

// ---------- entry point ---------------------------------------------
window.openMediaEditor = function(item, mediaType) {
  if (!item) return;
  _editCurrentItem = item;
  _editMediaType = mediaType;
  _editProbe = null;
  _editJobId = null;
  _editSubtitlePath = null;
  _stopPolling();

  var html = _buildModalHTML();
  pgShowModal(html);
  // Pre-fill destination directory from source file
  setTimeout(function() {
    var destDir = document.getElementById('ge-dest-dir');
    if (destDir && _editCurrentItem && _editCurrentItem.absPath) {
      var lastSep = Math.max(_editCurrentItem.absPath.lastIndexOf('/'), _editCurrentItem.absPath.lastIndexOf('\\'));
      if (lastSep >= 0) destDir.value = _editCurrentItem.absPath.substring(0, lastSep);
    }
  }, 30);

  // Check ffmpeg availability
  fetch('/api/gallery/edit/ffmpeg-status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.available) {
        var warn = document.getElementById('ge-ffmpeg-warn');
        if (warn) warn.style.display = '';
        var startBtn = document.getElementById('ge-start-btn');
        if (startBtn) startBtn.disabled = true;
      }
    })
    .catch(function() {});

  // Probe source
  fetch('/api/gallery/edit/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: item.absPath })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    _editProbe = data;
    var detailEl = document.getElementById('ge-source-detail');
    if (detailEl) {
      var parts = [];
      if (data.width && data.height) parts.push(data.width + '\u00d7' + data.height);
      if (data.codec) parts.push(data.codec);
      if (data.duration != null) parts.push(formatTime(data.duration));
      if (data.hasAudio === false) parts.push(_geT('geNoAudio'));
      detailEl.textContent = parts.join(', ') || '-';
    }
    // Update scale dimensions hint
    var scaleDims = document.getElementById('ge-scale-dims');
    if (scaleDims && data.width && data.height) {
      scaleDims.textContent = _geT('geOutputDims', [data.width, data.height]);
    }
  })
  .catch(function(err) {
    var detailEl = document.getElementById('ge-source-detail');
    if (detailEl) detailEl.textContent = 'Probe failed: ' + (err.message || err);
  });

  // Bind events after DOM is rendered
  setTimeout(_bindModalEvents, 20);
};

window.cleanupMediaEditor = function() {
  _stopPolling();
  _editJobId = null;
};

window.triggerMediaEditor = function(mediaType) {
  mediaType = mediaType || galleryState.mediaType;
  var isVid = (mediaType === 'video');
  var item = isVid ? galleryState.videoItems[galleryState.videoIndex] : galleryState.items[galleryState.index];
  if (!item) {
    showMsg(_geT('geNoItem') || 'No item selected');
    return;
  }
  if (!item.absPath) {
    showMsg(_geT('geNoDiskPath') || 'This item does not have a disk path. Open files from a directory to enable editing.');
    return;
  }
  if (typeof window.openMediaEditor === 'function') {
    window.openMediaEditor(item, mediaType);
  }
};
