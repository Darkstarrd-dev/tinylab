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
var _geGearSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
var _geImageSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
var _geFolderSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
var _geBrowseSvg = _geFolderSvg;

// ---------- helpers ------------------------------------------------

function _geT(k, ar) {
  return (typeof pgT === 'function') ? pgT(k, ar) : k;
}

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
    row1.textContent = _editContainerParentPath(it) || _editContainerPath(it, false) || _geT('geDragNoPathHint');
    row2.textContent = (_batchOriginLabel() || '-') + ' \u00b7 ' + _getSiblingImages().length + ' ' + _geT('geImagesCount');
    return;
  }
  row1.textContent = _editContainerPath(it, true) || _geT('geDragNoPathHint');
  var probe = _editProbe || {};
  var parts = [];
  var nm = it.name || (it.path || '').split('/').pop() || '';
  if (nm) parts.push(nm);
  if (probe.width && probe.height) parts.push(probe.width + '\u00d7' + probe.height);
  if (it.size && it.size > 0) parts.push(_formatSize(it.size));
  var ex = extOf(it.name);
  if (ex) parts.push(ex.replace(/^\./, '').toUpperCase());
  row2.textContent = parts.length ? parts.join(' \u00b7 ') : '-';
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
  row1.textContent = _editVideoPath(it) || _geT('geDragNoPathHint');
  var probe = _editProbe || {};
  var parts = [];
  var nm = it.name || (it.path || '').split('/').pop() || '';
  if (nm) parts.push(nm);
  if (probe.width && probe.height) parts.push(probe.width + '\u00d7' + probe.height);
  if (probe.codec) parts.push(probe.codec);
  if (probe.duration != null && probe.duration > 0) parts.push(formatTime(probe.duration));
  if (probe.hasAudio === false) parts.push(_geT('geNoAudio'));
  if (it.size && it.size > 0) parts.push(_formatSize(it.size));
  row2.textContent = parts.length ? parts.join(' \u00b7 ') : '-';
}

// _editVideoPath returns the disk path of a video item for source-info row 1:
// backend → its absolute path; plain (download) → its disk path; zip → the
// archive path; fs (drag-drop) → '' (browser hides the path → hint shown).
function _editVideoPath(it) {
  if (!it) return '';
  if (it.kind === 'zip') return it.zipAbsPath || '';
  if (it.kind === 'backend') return it.absPath || it.rootDirPath || '';
  if (it.kind === 'plain') return it.path || it.absPath || '';
  if (it.kind === 'fs') return '';
  return it.path || it.absPath || '';
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


  var outputName = data.outputName || _geT('geEmptyName');
  var outputURL = data.outputURL || '';
  var outputPath = data.outputPath || '';


  // Regular single-file result.
  var logHtml = data.logTail ? '<details style="margin-top:8px"><summary>' + escapeHtml(_geT('geLogTail')) + '</summary><pre style="background:#1a1326;border:1px solid var(--glass-border);padding:8px;font-size:11px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all">' + escapeHtml(data.logTail) + '</pre></details>' : '';

  var resultHtml = '<div class="gallery-edit-result">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(_geT('geCompleted')) + '</span>' +
      '<span style="font-size:12px;color:var(--text-secondary)">' + escapeHtml(outputName) + '</span>' +
    '</div>' +
    '<div class="gallery-edit-actions">' +
      '<button class="pg-btn" id="ge-open-folder-btn">' + escapeHtml(_geT('geBatchOpenFolder')) + '</button>' +
    '</div>' +
    logHtml +
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

// ---------- batch mode helpers ----------------------------------------

// _getSiblingImages returns all items in galleryState.items that share the
// same folder/archive as _editCurrentItem, regardless of how they were loaded
// (backend native picker, File System Access API, drag-drop, or zip). The
// grouping key is chosen per item kind so it mirrors the canonical node
// matcher itemsInNode() in gallery-fullscreen.js:
//   kind 'backend' → rootDirPath (fallback: directory of absPath)
//   kind 'fs'      → rootDirHandle (top-level dir the handle was picked from)
//   kind 'zip'     → zipAbsPath (on-disk archive) or sessionId (FSAA zip)
//   kind 'plain'   → excluded (single blob, no shared folder)
function _dirOfPath(p) {
  if (!p) return '';
  var sep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return sep >= 0 ? p.substring(0, sep) : '';
}
function _normDir(d) {
  return d ? d.replace(/\\/g, '/').replace(/\/+$/, '') : '';
}
function _getSiblingImages() {
  if (!_editCurrentItem) return [];
  var cur = _editCurrentItem;
  var items = galleryState.items || [];
  var out = [];

  if (cur.kind === 'zip') {
    // Archive grouping: prefer the on-disk absolute path (backend folders),
    // fall back to the in-memory session id (FSAA / drag-drop zips). Both are
    // stable pack identifiers shared by every entry of the same archive.
    var zipKey = cur.zipAbsPath || ('@sess:' + (cur.sessionId || ''));
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.kind !== 'zip') continue;
      var k = it.zipAbsPath || ('@sess:' + (it.sessionId || ''));
      if (k === zipKey) out.push(it);
    }
    return out;
  }

  if (cur.kind === 'fs') {
    // FSAA folder grouping: the top-level FileSystemDirectoryHandle saved by
    // walkDir() is identity-equal across all files picked from the same dir.
    var rootHandle = cur.rootDirHandle;
    if (!rootHandle) return [];
    for (var j = 0; j < items.length; j++) {
      var it2 = items[j];
      if (!it2 || it2.kind !== 'fs') continue;
      if (it2.rootDirHandle === rootHandle) out.push(it2);
    }
    return out;
  }

  if (cur.kind === 'backend') {
    var srcDir = cur.rootDirPath ? _normDir(cur.rootDirPath)
                                 : (cur.absPath ? _normDir(_dirOfPath(cur.absPath)) : '');
    if (!srcDir) return [];
    for (var m = 0; m < items.length; m++) {
      var it3 = items[m];
      if (!it3 || it3.kind !== 'backend') continue;
      var itDir = it3.rootDirPath ? _normDir(it3.rootDirPath)
                                  : (it3.absPath ? _normDir(_dirOfPath(it3.absPath)) : '');
      if (itDir === srcDir) out.push(it3);
    }
    return out;
  }

  // kind 'plain' (single pasted blob) and unknown kinds have no disk folder:
  // batching applies to one's siblings, and a lone blob has none.
  return [];
}

// _stripExt returns the name without its last extension ("a.b.png" → "a.b").
function _stripExt(name) {
  if (!name) return '';
  var dot = name.lastIndexOf('.');
  return dot > 0 ? name.substring(0, dot) : name;
}

// _batchOriginZipName derives the zipped-output filename from the current
// edit item's source folder/archive, so the result keeps a recognisable name
// instead of "converted_images.zip". Mirrors the grouping keys used by
// _getSiblingImages: zip items → archive base name (or first path segment for
// FSAA zips), fs items → root dir handle name, backend items → rootDirPath
// base name. Output: "<origin>_converted.zip", base-only + .zip enforced
// server-side to prevent path traversal.
// Derives the output zip/folder name. If the "Set Name" toggle is on, it
// uses the custom name from `ge-img-setname-input`; otherwise falls back to
// the original source folder/archive name. Always sanitised server-side
// (filepath.Base + .zip forced).
function _batchOriginZipName() {
  // Honour the explicit "Set Name" input when present and filled.
  var renameReq = '';
  if (_batchCfg && _batchCfg.renameName) renameReq = _batchCfg.renameName;
  else {
    var cb = document.getElementById('ge-img-setname');
    var el = document.getElementById('ge-img-setname-input');
    if (cb && cb.checked && el) renameReq = (el.value || '').trim();
  }
  if (renameReq) {
    return _stripExt(renameReq) || 'converted_images';
  }
  var stem = _batchOriginStem();
  return stem + '_converted.zip';
}

// _refreshBatchUXVisibility syncs the image dialog's toggle-gated inputs:
function _refreshBatchUXVisibility() {
  function _syncToggle(toggleId, inputIds) {
    var cb = document.getElementById(toggleId);
    if (!cb) return;
    var on = !!cb.checked;
    for (var i = 0; i < inputIds.length; i++) {
      var el = document.getElementById(inputIds[i]);
      if (el) el.disabled = !on;
    }
  }
  _syncToggle('ge-img-setpath', ['ge-dest-dir', 'ge-browse-dir-btn']);
  _syncToggle('ge-img-setname', ['ge-img-setname-input']);
  // Uniform (sequential batch rename) is only meaningful in archive mode
  // (renaming many images). In single mode the toggle itself is disabled so it
  // cannot be turned on; when on (in archive mode) it enables the prefix/digits.
  var archiveOn = _isArchiveMode();
  var uniCb = document.getElementById('ge-img-uniform');
  if (uniCb) {
    uniCb.disabled = !archiveOn;
    var uniOn = archiveOn && uniCb.checked;
    var pEl = document.getElementById('ge-img-uniform-prefix');
    var dEl = document.getElementById('ge-img-uniform-digits');
    if (pEl) pEl.disabled = !uniOn;
    if (dEl) dEl.disabled = !uniOn;
  }
}
function _padNum(n, digits) {
  var s = String(n);
  while (s.length < digits) s = '0' + s;
  return s;
}

// _batchOriginStem returns the original folder/archive stem (no extension,
// no trailing _converted) for use as the custom-name fallback and the
// sequential-rename default folder/zip name.
function _batchOriginStem() {
  var it = _editCurrentItem;
  if (!it) return 'converted_images';
  var stem = '';
  if (it.kind === 'zip') {
    if (it.zipAbsPath) stem = it.zipAbsPath.split(/[\\/]/).pop();
    else stem = (it.path || '').split('/')[0] || it.name || '';
  } else if (it.kind === 'fs' && it.rootDirHandle && it.rootDirHandle.name) {
    stem = it.rootDirHandle.name;
  } else if (it.kind === 'backend' && it.rootDirPath) {
    stem = it.rootDirPath.split(/[\\/]/).pop();
  }
  stem = _stripExt(stem) || 'converted_images';
  return stem;
}

// _captureBatchCfg reads the current state of the rename / sequential-rename
// controls so the result handler can honour them even after the controls reset.
function _captureBatchCfg() {
  var uniCb = document.getElementById('ge-img-uniform');
  var uniOn = !!(uniCb && uniCb.checked);
  var prefix = '';
  var digits = 2;
  if (uniOn) {
    var pEl = document.getElementById('ge-img-uniform-prefix');
    var dEl = document.getElementById('ge-img-uniform-digits');
    prefix = (pEl && pEl.value) ? pEl.value.trim() : '';
    digits = dEl ? (parseInt(dEl.value, 10) || 2) : 2;
    if (digits < 1) digits = 1;
    if (!prefix) prefix = _geT('geRenormPrefixPh');
  }
  var setNameCb = document.getElementById('ge-img-setname');
  var setNameEl = document.getElementById('ge-img-setname-input');
  var renameName = (setNameCb && setNameCb.checked && setNameEl) ? (setNameEl.value || '').trim() : '';
  return { renormalise: uniOn, prefix: prefix, digits: digits, renameName: renameName };
}

var _batchJobs = [];
var _batchTotal = 0;
var _batchDone = 0;
var _batchDest = null;
var _batchParams = null;
var _batchOp = null;
var _batchCompress = false;
// Captured UX options at the moment the batch starts ({ renormalise, prefix,
// digits, renameName }) so _onBatchComplete (which runs async after all jobs
// finish and the controls may have been reset) can still honour them.
var _batchCfg = null;

// _resolveBatchInput resolves the on-disk input path for a single batch item,
// mirroring the per-item resolution triggerMediaEditor() already uses for
// single-file editing. Backend items already carry absPath; FSAA/drag-drop
// files are uploaded to a temp file (/edit/upload-temp) and zip entries are
// extracted to a temp file (/edit/extract-zip-entry). Returns a promise that
// resolves to an absolute path string, or rejects on failure.
function _resolveBatchInput(it) {
  if (it.absPath) return Promise.resolve(it.absPath);
  if (it.kind === 'zip' && (it.zipAbsPath || it.sessionId)) {
    var body = { zipPath: it.zipPath };
    if (it.zipAbsPath) body.zipAbsPath = it.zipAbsPath;
    else body.sessionId = it.sessionId;
    return fetch('/api/gallery/edit/extract-zip-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r) {
      return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
    }).then(function(d) { return d.tempPath; });
  }
  if (typeof it.getBlob === 'function') {
    return it.getBlob().then(function(blob) {
      return fetch('/api/gallery/edit/upload-temp?name=' + encodeURIComponent(it.name || 'file'), {
        method: 'POST',
        body: blob
      });
    }).then(function(r) {
      return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
    }).then(function(d) { return d.tempPath; });
  }
  return Promise.reject(new Error('no disk path'));
}

function _startBatch(op, params, dest, compress, targets) {
  var siblings = (targets && targets.length) ? targets : _getSiblingImages();
  if (siblings.length === 0) {
    var re0 = document.getElementById('ge-result-area');
    if (re0) { re0.innerHTML = '<div class="gallery-edit-result" style="border-color:var(--danger)"><span style="color:var(--danger);font-weight:600">' + escapeHtml(_geT('geNoBatchItems')) + '</span></div>'; re0.style.display = 'block'; }
    return;
  }
  _batchJobs = [];
  _batchTotal = siblings.length;
  _batchDone = 0;
  _batchDest = dest;
  _batchParams = params;
  _batchOp = op;
  _batchCompress = !!compress;

  // Capture the user's UX choices once, so the async _onBatchComplete path
  // (which runs after all polling finishes and the controls may have been
  // reset by then) can still honour rename / sequential-rename.
  _batchCfg = _captureBatchCfg();

  // In compress mode, force save-to-dir (never overwrite) and use the
  // download default dir when the user left the directory empty.
  var batchDest = dest;
  if (_batchCompress) {
    batchDest = { overwrite: false, outputDir: dest.outputDir || _editDefaultDir || '' };
  }

  // Pre-compute each sibling's output stem (no extension; server appends the
  // format extension). Sequential-rename overrides the per-item original name.
  var digits = (_batchCfg && _batchCfg.renormalise) ? Math.max(1, parseInt(_batchCfg.digits, 10) || 2) : 0;

  _stopPolling();
  var resultEl = document.getElementById('ge-result-area');
  if (resultEl) { resultEl.innerHTML = ''; resultEl.style.display = 'none'; }
  _showProgressSection();
  _setProgressStatus(_geT('geBatchProgress', ['0', String(_batchTotal)]), false);

  for (var i = 0; i < siblings.length; i++) {
    var it = siblings[i];
    var job = { item: it, jobId: null, done: false, error: null, outStem: '' };
    // Uniform (sequential) → <prefix><NN..>; Set Name on a single target →
    // that name; otherwise leave empty so the server falls back to its
    // "<name>_<desc>.<ext>" default next to the source.
    job.outStem = digits > 0
      ? (_batchCfg.prefix || _geT('geRenormPrefixPh')) + _padNum(i + 1, digits)
      : (_batchTotal === 1 && _batchCfg && _batchCfg.renameName ? _batchCfg.renameName : '');
    _batchJobs.push(job);

    (function(idx, item, reqOp, reqParams, reqBatchDest, outStem) {
      _resolveBatchInput(item).then(function(inputPath) {
        var body = { inputPath: inputPath, operation: reqOp, overwrite: !!reqBatchDest.overwrite, params: reqParams };
        if (reqBatchDest.outputDir && !reqBatchDest.overwrite) body.outputDir = reqBatchDest.outputDir;
        // Send outputName whenever we computed a stem. Covers both
        // "Save to dir" (outputDir+!overwrite → server appends new ext) and
        // "Same Path" (overwrite, no outputDir → server appends _desc+ext).
        // This lets sequential-rename in batch yield e.g. "img001_converted.webp"
        // even in Same Path mode, next to the originals.
        if (outStem) body.outputName = outStem;
        return fetch('/api/gallery/edit/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function(r) {
          return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
        });
      }).then(function(data) {
        var j = _batchJobs[idx];
        if (!j) return;
        j.jobId = data.jobId;
        _pollBatchJob(idx, data.jobId);
      }).catch(function(err) {
        var j = _batchJobs[idx];
        if (!j) return;
        j.done = true;
        j.error = err.message || String(err);
        _batchDone++;
        _setProgressStatus(_geT('geBatchProgress', [String(_batchDone), String(_batchTotal)]), false);
        if (_batchDone >= _batchTotal) _onBatchComplete();
      });
    })(i, it, op, params, batchDest, job.outStem);
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
  var ok = 0, fail = 0;
  var outputPaths = [];
  for (var i = 0; i < _batchJobs.length; i++) {
    if (_batchJobs[i].error) { fail++; continue; }
    ok++;
    if (_batchJobs[i].outputPath) outputPaths.push(_batchJobs[i].outputPath);
  }

  // Replace-original on a backend zip (kind:'zip' with zipAbsPath): repack
  // the on-disk archive in place, overwriting each image entry with its
  // transcoded temp output at the same inner zip path. This must run BEFORE
  // the compress branch (compress mode forces non-overwrite so they are
  // mutually exclusive) and before the generic non-compress results.
  if (_batchDest && _batchDest.overwrite && _editCurrentItem && _editCurrentItem.kind === 'zip' && _editCurrentItem.zipAbsPath) {
    _zipWritebackBatch(_editCurrentItem.zipAbsPath, ok, fail);
    return;
  }

  // If compress mode and we have outputs, create a zip.
  if (_batchCompress && outputPaths.length > 0) {
    _setProgressStatus(_geT('geZipping'), false);
    var zipDest = _batchDest.outputDir || _editDefaultDir || '';
    fetch('/api/gallery/edit/zip-outputs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: outputPaths, outputDir: zipDest, zipName: _batchOriginZipName(), cleanUp: true })
    })
    .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
    .then(function(data) {
      _hideProgressSection();
      var resultEl = document.getElementById('ge-result-area');
      if (resultEl) {
        var html = '<div class="gallery-edit-result">';
        html += '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(_geT('geBatchDone', [String(ok), String(fail)])) + '</span>';
        html += '<div class="gallery-edit-actions">';
        html += '<button class="pg-btn" id="ge-open-folder-btn">' + escapeHtml(_geT('geBatchOpenFolder')) + '</button>';
        html += '</div></div>';
        resultEl.innerHTML = html;
        resultEl.style.display = 'block';
      }
      var openBtn = document.getElementById('ge-open-folder-btn');
      if (openBtn && data.zipPath) {
        openBtn.onclick = function() { _openInFileManager(data.zipPath); };
      }
      _batchJobs = [];
    })
    .catch(function(err) {
      _hideProgressSection();
      var resultEl = document.getElementById('ge-result-area');
      if (resultEl) {
        resultEl.innerHTML = '<div class="gallery-edit-result" style="border-color:var(--danger)"><span style="color:var(--danger);font-weight:600">Zip failed: ' + escapeHtml(err.message || String(err)) + '</span></div>';
        resultEl.style.display = 'block';
      }
      _batchJobs = [];
    });
    return;
  }

  // Non-compress mode: show individual results.
  _hideProgressSection();
  var resultEl = document.getElementById('ge-result-area');
  var html = '<div class="gallery-edit-result">';
  if (fail > 0) {
    // Surface the first error so a single-image failure is visible, not just a count.
    var firstErr = '';
    for (var e = 0; e < _batchJobs.length; e++) { if (_batchJobs[e].error) { firstErr = _batchJobs[e].error; break; } }
    html += '<span style="color:var(--danger);font-weight:600">\u2718 ' + escapeHtml(_geT('geBatchDone', [String(ok), String(fail)])) + '</span>';
    if (firstErr) html += '<div style="font-size:12px;color:var(--danger);margin-top:4px;white-space:pre-wrap;word-break:break-all">' + escapeHtml(firstErr) + '</div>';
  } else {
    html += '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(_geT('geBatchDone', [String(ok), String(fail)])) + '</span>';
  }
  if (ok > 0) {
    html += '<div class="gallery-edit-actions">';
    html += '<button class="pg-btn" id="ge-open-folder-btn">' + escapeHtml(_geT('geBatchOpenFolder')) + '</button>';
    html += '</div>';
  }
  html += '</div>';
  if (resultEl) {
    resultEl.innerHTML = html;
    resultEl.style.display = 'block';
  }
  var openBtnN = document.getElementById('ge-open-folder-btn');
  if (openBtnN) {
    var firstOutPath = outputPaths.length > 0 ? outputPaths[0] : '';
    openBtnN.onclick = function() {
      if (firstOutPath) _openInFileManager(firstOutPath);
    };
  }

  _batchJobs = [];
}

// _zipWritebackBatch completes a replace-original convert-all flow against an
// on-disk zip archive: it POSTs each successfully converted job's temp output
// mapped to its inner zip path to /edit/zip-writeback, which repacks the
// archive and atomically writes it back to archivePath. Renders the result
// area with the same success markup as the non-compress branch plus an Open
// Folder button.
function _zipWritebackBatch(archivePath, ok, fail) {
  var entries = [];
  for (var i = 0; i < _batchJobs.length; i++) {
    var j = _batchJobs[i];
    if (!j.error && j.outputPath && j.item && j.item.zipPath) {
      entries.push({ zipPath: j.item.zipPath, filePath: j.outputPath });
    }
  }

  _setProgressStatus(_geT('geZipping') || 'Repacking archive...', false);
  fetch('/api/gallery/edit/zip-writeback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archivePath: archivePath, entries: entries })
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
  .then(function() {
    _hideProgressSection();
    var resultEl = document.getElementById('ge-result-area');
    if (resultEl) {
      // Single action button: "Open Folder" if translation exists, else fall
      // back to the "Show in Gallery" label (still wired to open the folder,
      // since the archive is replaced in place, not added as a new entry).
      var openLabel = _geT('geBatchOpenFolder') || _geT('geShowInGallery');
      var html = '<div class="gallery-edit-result">';
      html += '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(_geT('geBatchDone', [String(ok), String(fail)])) + '</span>';
      html += '<div class="gallery-edit-actions">';
      html += '<button class="pg-btn" id="ge-open-folder-btn">' + escapeHtml(openLabel) + '</button>';
      html += '</div></div>';
      resultEl.innerHTML = html;
      resultEl.style.display = 'block';
    }
    var openBtn = document.getElementById('ge-open-folder-btn');
    if (openBtn) {
      openBtn.onclick = function() { _openInFileManager(archivePath); };
    }
    _batchJobs = [];
  })
  .catch(function(err) {
    _hideProgressSection();
    var resultEl = document.getElementById('ge-result-area');
    if (resultEl) {
      resultEl.innerHTML = '<div class="gallery-edit-result" style="border-color:var(--danger)"><span style="color:var(--danger);font-weight:600">Writeback failed: ' + escapeHtml(err.message || String(err)) + '</span></div>';
      resultEl.style.display = 'block';
    }
    _batchJobs = [];
  });
}

// _openInFileManager asks the server to open a path's containing directory in
// the OS file manager. On error it surfaces a message via geBatchOpenError.
function _openInFileManager(path) {
  fetch('/api/gallery/open-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path })
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
  .catch(function(err) {
    showMsg((_geT('geBatchOpenError') || 'Failed to open folder') + ': ' + (err.message || err));
  });
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
    + '<label class="gallery-edit-check"><input type="checkbox" id="ge-img-setpath"> ' + escapeHtml(_geT('geSetPath')) + '</label>'
    + '<button type="button" class="btn btn-browse" id="ge-browse-dir-btn" title="' + escapeHtml(_geT('geBrowseDir')) + '">' + _geBrowseSvg + '</button>'
    + '<input type="text" id="ge-dest-dir" style="flex:1" placeholder="' + escapeHtml(_geT('geDestDirPlaceholder')) + '" disabled>'
    + '</div>';
}
function _renderSetNameRow() {
  return '<div class="gallery-edit-row">'
    + '<label class="gallery-edit-check"><input type="checkbox" id="ge-img-setname"> ' + escapeHtml(_geT('geSetName')) + '</label>'
    + '<input type="text" id="ge-img-setname-input" style="flex:1" placeholder="' + escapeHtml(_geT('geNamePlaceholder')) + '" disabled>'
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

  // Uniform (sequential rename)
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check"><input type="checkbox" id="ge-img-uniform"> ' + escapeHtml(_geT('geUniform')) + '</label>';
  html += '<input type="text" id="ge-img-uniform-prefix" style="width:120px" value="' + escapeHtml(_geT('geRenormPrefixPh')) + '" placeholder="' + escapeHtml(_geT('geRenormPrefixPh')) + '" disabled>';
  html += '<label class="gallery-edit-label" style="width:auto;margin-left:8px">' + escapeHtml(_geT('geRenormDigits')) + '</label>';
  html += '<input type="number" id="ge-img-uniform-digits" min="1" max="9" value="2" style="width:60px" disabled>';
  html += '</div>';

  // Compress to Zip + Format
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check"><input type="checkbox" id="ge-img-compress"> ' + escapeHtml(_geT('geCompressZip')) + '</label>';
  html += '<label class="gallery-edit-label" style="width:auto;margin-left:8px">' + escapeHtml(_geT('geFormat')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-img-format" style="flex:1">';
  for (var i = 0; i < formatOptions.length; i++) {
    var f = formatOptions[i];
    html += '<option value="' + f + '"' + (f === srcExt ? ' selected' : '') + '>' + f.toUpperCase() + '</option>';
  }
  html += '</select>';
  html += '</div>';

  // Quality + Scale
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geQuality')) + '</label>';
  html += '<input type="range" id="ge-img-quality" min="0" max="100" value="85" style="flex:1">';
  html += '<span class="gallery-edit-val" id="ge-quality-val">85</span>';
  html += '<label class="gallery-edit-label" style="width:auto;margin-left:12px">' + escapeHtml(_geT('geScalePercent')) + '</label>';
  html += '<input type="range" id="ge-img-scale" min="10" max="200" value="100" style="flex:1">';
  html += '<span class="gallery-edit-val" id="ge-scale-val">100%</span>';
  html += '</div>';

  // PNG lossless note
  html += '<div class="gallery-edit-row" id="ge-img-lossless-note" style="display:none">';
  html += '<span style="font-size:11px;color:var(--text-muted);margin-left:auto">' + escapeHtml(_geT('geQualityHint')) + '</span>';
  html += '</div>';

  // Strip Metadata + Scale output dims
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check"><input type="checkbox" id="ge-img-strip"> ' + escapeHtml(_geT('geStripMetadata')) + '</label>';
  html += '<span class="gallery-edit-val" id="ge-scale-dims" style="margin-left:auto">' + escapeHtml(_geT('geOutputDims', [w, h])) + '</span>';
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

  // Scale percent (same range+value+dims pattern as the image form — the
  // server clips to 10..200 regardless of input type, so changing the control
  // here doesn't alter the server contract).
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geScalePercent')) + '</label>';
  html += '<input type="range" id="ge-vid-scale" min="10" max="200" value="100" style="flex:1">';
  html += '<span class="gallery-edit-val" id="ge-vid-scale-val">100%</span>';
  html += '<span class="gallery-edit-val" id="ge-vid-scale-dims">' + escapeHtml(_geT('geOutputDims', [w, h])) + '</span>';
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

  // Select ranges button — switches to the video display with trim controls
  html += '<div class="gallery-edit-row">';
  html += '<button type="button" class="btn btn-primary" id="ge-trim-select-btn" style="flex:1">' + escapeHtml(_geT('geTrimSelectRanges')) + '</button>';
  html += '</div>';

  // Segment display
  html += '<div class="gallery-edit-row" id="ge-trim-segments-display">';
  html += '<span class="gallery-edit-val" id="ge-trim-segments-text" style="font-size:12px;color:var(--text-muted);flex:1">' + escapeHtml(_formatTrimSegments(_editTrimSegments)) + '</span>';
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

  // Multi-segment re-encode hint
  html += '<div class="gallery-edit-row" id="ge-trim-multi-hint" style="display:none">';
  html += '<span style="font-size:11px;color:var(--text-muted)">' + escapeHtml(_geT('geTrimMultiReencodeHint')) + '</span>';
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
  var fullTitle = title + ': ' + itemName;

  var html = '';
  if (isImage) {
    html += '<div class="pg-modal-header">';
    html += '<div class="ge-header-left">';
    html += '<button type="button" id="ge-settings-btn" class="ge-gear-btn" data-tooltip="' + escapeHtml(_geT('geSettingsHint')) + '" title="' + escapeHtml(_geT('geSettings')) + '">' + _geGearSvg + '</button>';
    html += '<button type="button" id="ge-archive-toggle" class="ge-icon-toggle" data-archive="0" title="' + escapeHtml(_geT('geArchiveHint')) + '">' + _geImageSvg + '</button>';
    html += '</div>';
    html += '<span class="pg-modal-title ge-title-center">' + escapeHtml(_geT('geImageConvert')) + '</span>';
    html += '<button class="pg-modal-close" onclick="pgCloseModal()">\u2715</button>';
    html += '</div>';
  } else {
    html += '<div class="pg-modal-header">';
    html += '<div class="ge-header-left">';
    html += '<button type="button" id="ge-settings-btn" class="ge-gear-btn" data-tooltip="' + escapeHtml(_geT('geSettingsHint')) + '" title="' + escapeHtml(_geT('geSettings')) + '">' + _geGearSvg + '</button>';
    html += '</div>';
    html += '<span class="pg-modal-title ge-title-center">' + escapeHtml(_geT('geVideoConvert')) + '</span>';
    html += '<button class="pg-modal-close" onclick="pgCloseModal()">\u2715</button>';
    html += '</div>';
  }

  html += '<div class="pg-modal-body gallery-edit-body">';

  // FFmpeg warning
  html += '<div id="ge-ffmpeg-warn" style="display:none;padding:8px 12px;background:rgba(239,68,68,0.1);border:1px solid var(--danger);border-radius:var(--radius-sm);margin-bottom:12px;font-size:13px;color:var(--danger)">';
  html += '<strong>' + escapeHtml(_geT('geFfmpegNA')) + '</strong>: ' + escapeHtml(_geT('geFfmpegNAHint'));
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
    html += '<span>' + escapeHtml(_geT('geTranscodeTab') || '转码与格式') + '</span>';
    html += '</div>';
    html += _renderVideoTranscodeForm();
    html += '</div>';

    // Block 2: Trim (Optional section with toggle checkbox)
    html += '<div class="gallery-edit-block">';
    html += '<div class="gallery-edit-block-title">';
    html += '<label class="gallery-edit-check" style="margin:0;font-weight:600;color:var(--text)">';
    html += '<input type="checkbox" id="ge-vid-trim-enable"> ';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>';
    html += '<span>' + escapeHtml(_geT('geTrimTab') || '视频裁剪') + '</span>';
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
    html += '<span>' + escapeHtml(_geT('geSubtitleTab') || '字幕处理') + '</span>';
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
  html += '<button class="pg-btn danger" id="ge-cancel-btn" style="font-size:11px;padding:2px 8px">' + escapeHtml(_geT('geCancelJob')) + '</button>';
  html += '</div>';
  html += '<span id="ge-progress-text" style="font-size:12px;color:var(--text-muted)">' + escapeHtml(_geT('geRunning')) + '</span>';
  html += '</div>';

  // Result area
  html += '<div id="ge-result-area" style="display:none"></div>';

  html += '</div>'; // pg-modal-body

  // Modal footer with Cancel and Start buttons (matching Settings modal footer)
  var cancelTxt = (typeof t === 'function') ? t('cancel') : '取消';
  html += '<div class="pg-modal-footer">';
  html += '<button type="button" class="btn btn-ghost" onclick="pgCloseModal()">' + escapeHtml(cancelTxt) + '</button>';
  html += '<button type="button" class="btn btn-primary" id="ge-start-btn">' + escapeHtml(_geT('geStart')) + '</button>';
  html += '</div>';

  return html;
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
  if (!segments || !segments.length) return _geT('geTrimNoSegments');
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
  return '<button class="gallery-btn gallery-btn-icon" id="ge-tm-play" type="button" data-tooltip="' + escapeHtml(_geT('geTrimPlayPause')) + '">' + GALLERY_ICONS.play + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="ge-tm-add" type="button" data-tooltip="' + escapeHtml(_geT('geTrimAddSegment')) + '">' + addIcon + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="ge-tm-remove" type="button" data-tooltip="' + escapeHtml(_geT('geTrimRemoveSegment')) + '">' + removeIcon + '</button>' +
    '<button class="gallery-btn gallery-btn-icon" id="ge-tm-confirm" type="button" data-tooltip="' + escapeHtml(_geT('geTrimConfirm')) + '">' + confirmIcon + '</button>';
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
      scaleDims.textContent = _geT('geOutputDims', [_editProbe.width, _editProbe.height]);
    }
  }
  setTimeout(_bindModalEvents, 20);
  setTimeout(function() {
    var trimTab = document.querySelector('.gallery-edit-tab[data-tab="trim"]');
    if (trimTab) trimTab.click();
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
      if (typeof openDownloadSettingsModal === 'function') {
        openDownloadSettingsModal();
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
      archTog.title = on ? _geT('geArchiveHint') : _geT('geSingleHint');
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
      vidScaleDims.textContent = _geT('geOutputDims', [nw, nh]);
    };
  }

  // ---- video trim events ----
  var trimSelectBtn = document.getElementById('ge-trim-select-btn');
  if (trimSelectBtn) {
    trimSelectBtn.onclick = function() { _enterTrimMode(); };
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
    if (re) { re.innerHTML = '<div class="gallery-edit-result" style="border-color:var(--danger)"><span style="color:var(--danger);font-weight:600">' + escapeHtml(_geT('geNoBatchItems')) + '</span></div>'; re.style.display = 'block'; }
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
    showMsg(_geT('geTrimSelectFirst'));
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

// ---------- entry point ---------------------------------------------
window.openMediaEditor = function(item, mediaType) {
  if (!item) return;
  _editCurrentItem = item;
  _editMediaType = mediaType;
  _editProbe = null;
  _editJobId = null;
  _editSubtitlePath = null;
  _stopPolling();
  _editTrimSegments = [];

  var html = _buildModalHTML();
  pgShowModal(html);

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
      scaleDims.textContent = _geT('geOutputDims', [data.width, data.height]);
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
};

window.triggerMediaEditor = function(mediaType) {
  mediaType = mediaType || galleryState.mediaType;
  var isVid = (mediaType === 'video');
  var item = isVid ? galleryState.videoItems[galleryState.videoIndex] : galleryState.items[galleryState.index];
  if (!item) {
    showMsg(_geT('geNoItem') || 'No item selected');
    return;
  }

  // Resolve disk path: backend items have absPath directly; zip items need extraction.
  if (item.absPath) {
    if (typeof window.openMediaEditor === 'function') {
      window.openMediaEditor(item, mediaType);
    }
    return;
  }

  // Zip items: extract to temp file via backend, then open editor.
  if (item.kind === 'zip' && (item.zipAbsPath || item.sessionId)) {
    showMsg(_geT('geExtracting') || 'Extracting from archive...');
    var body = { zipPath: item.zipPath };
    if (item.zipAbsPath) body.zipAbsPath = item.zipAbsPath;
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
      showMsg((_geT('geExtractFail') || 'Extract failed') + ': ' + (err.message || err));
    });
    return;
  }

  // FSAA / drag-drop items: upload blob to a temp file via backend.
  if (typeof item.getBlob === 'function') {
    showMsg(_geT('geExtracting') || 'Preparing file for editing...');
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
      showMsg((_geT('geExtractFail') || 'Prepare failed') + ': ' + (err.message || err));
    });
    return;
  }

  // Truly unsupported item kind.
  showMsg(_geT('geNoDiskPath') || 'This item does not have a disk path. Open files from a directory to enable editing.');
};
