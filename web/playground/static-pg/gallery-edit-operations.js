// gallery-edit-operations.js — single-operation (convert/trim/compress/subtitle/rotate) UI helpers, parameter
// collection, start/cancel/poll, subtitle upload, ffmpeg status. Split from gallery-edit.js (refactor Fix 5).
// Backend: internal/api/gallery/edit_handlers.go.

// ---------- add output to gallery -----------------------------------
function _addOutputToGallery(outputName, outputPath, outputURL) {
  if (!outputURL || !outputPath) return;
  // Determine parent directory from outputPath
  var lastSep = Math.max(outputPath.lastIndexOf('/'), outputPath.lastIndexOf('\\'));
  var rootDirPath = lastSep >= 0 ? outputPath.substring(0, lastSep) : '';
  // dirBucket is the output dir's basename; path is grouped on by getDirPath
  // in gallery-tree.js, so a bare outputName would land in the Root bucket
  // and renderThumbnails (which filters by currentFolderIndices) would never
  // show it — that was the show-in-gallery no-op root cause. Prefixing with
   // the dir basename puts it into its own navigable folder bucket.
  var dirBucket = (rootDirPath || '').split(/[\\/]/).pop() || 'Output';
  var itemPath = dirBucket + '/' + outputName;
  var isVideo = _editMediaType === 'video';
  var item = {
    name: outputName,
    path: itemPath,
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
      var newIdx = galleryState.items.length - 1;
      if (typeof setActive === 'function') { setActive(newIdx); }
      // Re-derive currentFolderIndices for the new item's dir bucket and
      // re-render the thumbnail strip so it actually appears. setActive alone
      // only updates the big-image view; the strip stayed on the old (now
      // stale) folder filter and the new item was invisible — that's the
      // show-in-gallery bug.
      if (typeof updateCurrentFolderItems === 'function') { updateCurrentFolderItems(newIdx); }
      if (typeof renderTreePanel === 'function') { renderTreePanel(); }
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
  // Output filename: Set Name (when on) wins over the original name; the
  // server appends the format extension from buildArgs. With Set Path off,
  // the server's !Overwrite && OutputDir=="" && OutputName!="" branch places
  // <dir>/<outputName><ext> next to the source (replace-original was removed,
  // so overwrite is always false).
  var customRename = '';
  var setNameCb = document.getElementById('ge-img-setname');
  var setNameEl = document.getElementById('ge-img-setname-input');
  if (setNameCb && setNameCb.checked && setNameEl) customRename = (setNameEl.value || '').trim();
  var origStem = customRename || _stripExt((_editCurrentItem.name || ((_editCurrentItem.path || '').split('/').pop())) || '');
  var body = { inputPath: _editCurrentItem.absPath, operation: op, overwrite: false, params: params };
  if (outputDir) body.outputDir = outputDir;
  if (origStem) body.outputName = origStem;
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


// ---------- ffmpeg status check ------------------------------------
function _checkFfmpegStatus() {
  fetch('/api/gallery/edit/ffmpeg-status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var warn = document.getElementById('ge-ffmpeg-warn');
      var startBtn = document.getElementById('ge-start-btn');
      if (!data.available) {
        if (warn) warn.style.display = '';
        if (startBtn) startBtn.disabled = true;
      } else {
        if (warn) warn.style.display = 'none';
        if (startBtn && !_editJobId) startBtn.disabled = false;
      }
    })
    .catch(function() {});
}

// ---------- start operation helpers ---------------------------------
// _getDestFromSetPath builds the output destination from the Set Path toggle
// (shared by image and video): overwrite is always false (replace-original was
// removed), outputDir comes from Set Path, the output filename (Set Name) is
// read inside _startJob/_startBatch.
function _getDestFromSetPath() {
  var setPathOn = document.getElementById('ge-img-setpath').checked;
  var dirInput = document.getElementById('ge-dest-dir');
  var outputDir = setPathOn ? ((dirInput ? dirInput.value : '') || '').trim() : '';
  return { overwrite: false, outputDir: outputDir || null };
}

function _startImageTranscode() {
  var format = document.getElementById('ge-img-format').value;
  var quality = parseInt(document.getElementById('ge-img-quality').value) || 85;
  var scalePercent = parseInt(document.getElementById('ge-img-scale').value) || 100;
  var stripMetadata = document.getElementById('ge-img-strip').checked;
  var archiveOn = _isArchiveMode();
  var setPathOn = document.getElementById('ge-img-setpath').checked;
  var setNameOn = document.getElementById('ge-img-setname').checked;
  var setName = setNameOn ? (document.getElementById('ge-img-setname-input').value || '').trim() : '';
  var compress = document.getElementById('ge-img-compress') && document.getElementById('ge-img-compress').checked;
  var dirInput = document.getElementById('ge-dest-dir');
  var outputDir = setPathOn ? ((dirInput ? dirInput.value : '') || '').trim() : '';
  var params = { format: format, quality: quality, scalePercent: scalePercent, stripMetadata: stripMetadata };
  var dest = { overwrite: false, outputDir: outputDir || null, renameStem: setName || null };
  var targets = archiveOn ? _getSiblingImages() : [_editCurrentItem];
  if (archiveOn && targets.length === 0) {
    var re = document.getElementById('ge-result-area');
    if (re) { re.innerHTML = '<div class="gallery-edit-result" style="border-color:var(--danger)"><span style="color:var(--danger);font-weight:600">' + escapeHtml(T('geNoBatchItems')) + '</span></div>'; re.style.display = 'block'; }
    return;
  }
  _startBatch('image_transcode', params, dest, compress, targets);
}

function _startVideoJob() {
  var subCb = document.getElementById('ge-vid-sub-enable');
  var trimCb = document.getElementById('ge-vid-trim-enable');
  if (subCb && subCb.checked) {
    _startVideoSubtitle();
  } else if (trimCb && trimCb.checked) {
    _startVideoTrim();
  } else {
    _startVideoTranscode();
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

  var dest = _getDestFromSetPath();
  _startJob('video_transcode', {
    codec: codec, container: container, qualityTier: qualityTier,
    preset: preset, scalePercent: scalePercent,
    audioCodec: audioCodec, audioBitrate: audioBitrate,
    stripMetadata: stripMetadata
  }, false, dest.outputDir);
}

function _startVideoTrim() {
  if (!_editTrimSegments || !_editTrimSegments.length) {
    showMsg(T('geTrimSelectFirst'));
    return;
  }
  var modeRadio = document.querySelector('input[name="ge-trim-mode"]:checked');
  var reencode = modeRadio ? modeRadio.value === 'reencode' : false;
  var codec = 'h264', qualityTier = 'medium';
  if (reencode) {
    codec = document.getElementById('ge-trim-codec').value;
    qualityTier = document.getElementById('ge-trim-quality').value;
  }

  var dest = _getDestFromSetPath();
  var params = {
    reencode: reencode, codec: codec, qualityTier: qualityTier,
    hasAudio: (_editProbe && _editProbe.hasAudio !== false)
  };
  if (_editTrimSegments.length === 1) {
    // Single segment: use backward-compatible start/duration.
    var seg = _editTrimSegments[0];
    params.start = String(seg.start);
    params.duration = String(seg.end - seg.start);
  } else {
    // Multi-segment: force re-encode (filter_complex requires it).
    params.reencode = true;
    params.segments = _editTrimSegments.map(function(s) {
      return { start: String(s.start), end: String(s.end) };
    });
  }
  _startJob('video_trim', params, false, dest.outputDir);
}

function _startVideoSubtitle() {
  if (!_editSubtitlePath) { showMsg('Please select a subtitle file first'); return; }
  var modeRadio = document.querySelector('input[name="ge-sub-mode"]:checked');
  var mode = modeRadio ? modeRadio.value : 'burn';
  var lang = document.getElementById('ge-sub-lang').value || 'eng';
  var fontSize = parseInt(document.getElementById('ge-sub-fontsize').value) || 24;
  var fontName = document.getElementById('ge-sub-fontname').value || '';
  var container = document.getElementById('ge-sub-container').value;

  var dest = _getDestFromSetPath();
  _startJob('video_subtitle', {
    subtitlePath: _editSubtitlePath, mode: mode,
    language: lang, fontSize: fontSize,
    fontName: fontName, container: container
  }, false, dest.outputDir);
}
