// gallery-edit.js — Gallery media editor modal (ffmpeg-based image/video transformations).
// Exposes window.openMediaEditor(item, mediaType) and window.cleanupMediaEditor().

'use strict';

// ---------- editor state -------------------------------------------
var _editJobId = null;
var _editPollTimer = null;
var _editCurrentItem = null;
var _zipReplacePending = false;  // set by _startJob when single-image overwrite should replace an entry inside the source zip
var _editMediaType = null;
var _editProbe = null;
var _editSubtitlePath = null;

// ---------- helpers ------------------------------------------------

function _geT(k, ar) {
  return (typeof pgT === 'function') ? pgT(k, ar) : k;
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

  // Single-image replace-original into a zip: repack the on-disk archive with
  // this transcoded temp file at the entry's original inner path, delete the
  // temp file, and present an Open Folder button. The transcoded temp is the
  // ffmpeg job's outputPath.
  if (_zipReplacePending && _editCurrentItem && _editCurrentItem.kind === 'zip'
      && _editCurrentItem.zipAbsPath && _editCurrentItem.zipPath && outputPath) {
    _setProgressStatus(_geT('geZipping') || 'Repacking archive...', false);
    var entries = [{ zipPath: _editCurrentItem.zipPath, filePath: outputPath }];
    fetch('/api/gallery/edit/zip-writeback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archivePath: _editCurrentItem.zipAbsPath, entries: entries })
    })
    .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
    .then(function() {
      _hideProgressSection();
      _zipReplacePending = false;
      // best-effort delete the transcoded temp now that the entry is back in
      // the archive; the server also cleans inputs, but be defensive on FSAA
      // cases where outputPath was a client-managed temp.
      var resultEl2 = document.getElementById('ge-result-area');
      if (resultEl2) {
        var html = '<div class="gallery-edit-result">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
            '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(_geT('geCompleted')) + '</span>' +
            '<span style="font-size:12px;color:var(--text-secondary)">' + escapeHtml(_editCurrentItem.zipAbsPath.split(/[\\/]/).pop()) + '</span>' +
          '</div>' +
          '<div class="gallery-edit-actions">' +
            '<button class="pg-btn" id="ge-open-folder-btn">' + escapeHtml(_geT('geBatchOpenFolder')) + '</button>' +
          '</div>' +
        '</div>';
        resultEl2.innerHTML = html;
        resultEl2.style.display = 'block';
      }
      var openBtn2 = document.getElementById('ge-open-folder-btn');
      if (openBtn2) openBtn2.onclick = function() { _openInFileManager(_editCurrentItem.zipAbsPath); };
    })
    .catch(function(err) {
      _hideProgressSection();
      _zipReplacePending = false;
      var resultElErr = document.getElementById('ge-result-area');
      if (resultElErr) {
        resultElErr.innerHTML = '<div class="gallery-edit-result" style="border-color:var(--danger)"><span style="color:var(--danger);font-weight:600">Writeback failed: ' + escapeHtml(err.message || String(err)) + '</span></div>';
        resultElErr.style.display = 'block';
      }
    });
    return;
  }

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
  // "Replace original" needs a real source path: a kind:'backend' file/dir
  // on disk, or a backend zip (handled below via zip-writeback). FSAA
  // (kind:'fs'), FSAA-dropped zip (no zipAbsPath), and plain blobs have no
  // writable original — overwriting their temp input would silently no-op.
  var canReplace = _editCurrentItem.kind === 'backend'
    || (_editCurrentItem.kind === 'zip' && !!_editCurrentItem.zipAbsPath && !!_editCurrentItem.zipPath);
  if (overwrite && !canReplace) { showMsg(_geT('geNoDiskPath')); return; }
  _editJobId = null;
  // Single-image "replace original" into a zip archive: transcode to a temp
  // file first, then repost the bytes into the on-disk archive at the entry's
  // original inner path via /edit/zip-writeback. We set a pending flag that
  // _onCompleted honors (see below) so the api/start response's outputPath
  // (the temp file) becomes the writeback input. FSAA zip (no zipAbsPath) and
  // fs items cannot be replaced in place — guard and fall back to save-to-dir.
  _zipReplacePending = !!(overwrite && _editCurrentItem.kind === 'zip' && _editCurrentItem.zipAbsPath
                           && _editCurrentItem.zipPath);
  var resultEl = document.getElementById('ge-result-area');
  if (resultEl) { resultEl.innerHTML = ''; resultEl.style.display = 'none'; }
  _showProgressSection();
  // Carry the original filename so single-file save-to-dir (and zip-writeback
  // temp naming) keeps the gallery item's name with only the new extension,
  // instead of leaking the temp input name ("gallery-edit-upload-XXXX.mp4"
  // etc.) into the saved output. Applies to every single-file operation that
  // flows here: image_transcode, video_transcode, video_trim, video_subtitle.
  // When the user typed a custom filename in the shared dest block ("Save to
  // dir → rename"), prefer it over the original name — applies equally to
  // single images and single videos (Rename parity). The server appends the
  // format extension from buildArgs.
  var customRename = '';
  var renameEl = document.getElementById('ge-dest-rename');
  if (renameEl) customRename = (renameEl.value || '').trim();
  var origStem = customRename || _stripExt((_editCurrentItem.name || ( (_editCurrentItem.path||'').split('/').pop() )) || '');
  var body = { inputPath: _editCurrentItem.absPath, operation: op, overwrite: _zipReplacePending ? false : !!overwrite, params: params };
  if (_zipReplacePending) {
    // Write to the server's temp dir; we read outputPath from job status and
    // POST it to /edit/zip-writeback which repacks the archive in place.
    body.outputDir = '';
  } else if (outputDir && !overwrite) {
    body.outputDir = outputDir;
    if (origStem) body.outputName = origStem;
  }
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
// Derives the output zip/folder name. If the rethink rename toggle is on,
// it uses the custom name from `ge-img-rename-name`; otherwise falls back
// to the original source folder/archive name. Always sanitised server-side
// (filepath.Base + .zip forced).
function _batchOriginZipName() {
  var it = _editCurrentItem;
  // Honour the explicit "Rename" input when present and filled.
  var renameReq = '';
  var ri = document.getElementById('ge-img-rename');
  var rn = document.getElementById('ge-img-rename-name');
  if (ri && ri.checked && rn) renameReq = (rn.value || '').trim();
  if (_batchCfg && _batchCfg.renameName) renameReq = _batchCfg.renameName;
  if (renameReq) {
    return _stripExt(renameReq) || 'converted_images';
  }
  var stem = _batchOriginStem();
  return stem + '_converted.zip';
}

// _refreshBatchUXVisibility toggles the visibility of the rename/normalise
// rows according to the current checkbox/destination state. Rules:
//  - rename row: batch mode AND "Compress to ZIP" on (the rename field sets
//    the zip name; in uncompressed save-to-dir, individual names come from
//    either sequential-rename or the original filename)
//  - rename name input: only when the rename checkbox is also on
//  - normalise row + opts: batch mode on (any destination). "Same Path"
//    (overwrite) batch also accepts sequential rename because the server
//    now honours OutputName in the same-path (non-OutputDir) branch too,
//    placing e.g. "img001_converted.webp" next to the originals without
//    overwriting them.
function _refreshBatchUXVisibility() {
  var batchCb = document.getElementById('ge-img-batch');
  var compressCb = document.getElementById('ge-img-compress');
  var renameCb = document.getElementById('ge-img-rename');
  var renameNameInput = document.getElementById('ge-img-rename-name');
  var renameRow = document.getElementById('ge-img-rename-row');
  var renormRow = document.getElementById('ge-img-renorm-row');
  var renormOpts = document.getElementById('ge-img-renorm-opts');
  var batchOn = !!(batchCb && batchCb.checked);
  var compressOn = !!(compressCb && compressCb.checked);
  var destRadio = document.querySelector('input[name="ge-dest"]:checked');
  var samePath = !destRadio || destRadio.value === 'overwrite';
  if (renameRow) renameRow.style.display = (batchOn && compressOn) ? '' : 'none';
  if (renameNameInput) renameNameInput.style.display = (renameCb && renameCb.checked && renameRow && renameRow.style.display !== 'none') ? '' : 'none';
  if (renormRow) renormRow.style.display = (batchOn && !samePath) ? '' : 'none';
  if (renormOpts) renormOpts.style.display = (renormRow && renormRow.style.display !== 'none' && document.getElementById('ge-img-renorm') && document.getElementById('ge-img-renorm').checked) ? '' : 'none';
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
  var renormCb = document.getElementById('ge-img-renorm');
  var renormOn = !!(renormCb && renormCb.checked);
  var prefix = '';
  var digits = 2;
  if (renormOn) {
    var pEl = document.getElementById('ge-img-renorm-prefix');
    var dEl = document.getElementById('ge-img-renorm-digits');
    prefix = (pEl && pEl.value) ? pEl.value.trim() : '';
    digits = dEl ? (parseInt(dEl.value, 10) || 2) : 2;
    if (digits < 1) digits = 1;
    if (!prefix) prefix = _geT('geRenormPrefixPh');
  }
  var renameCb = document.getElementById('ge-img-rename');
  var renameNameEl = document.getElementById('ge-img-rename-name');
  var renameName = '';
  if (renameCb && renameCb.checked && renameNameEl) {
    renameName = (renameNameEl.value || '').trim();
  }
  return { renormalise: renormOn, prefix: prefix, digits: digits, renameName: renameName };
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

function _startBatch(op, params, dest, compress) {
  var siblings = _getSiblingImages();
  if (siblings.length === 0) { showMsg(_geT('geNoBatchItems')); return; }
  if (dest.overwrite) {
    var canReplace = _editCurrentItem && (_editCurrentItem.kind === 'backend'
      || (_editCurrentItem.kind === 'zip' && !!_editCurrentItem.zipAbsPath && !!_editCurrentItem.zipPath));
    if (!canReplace) { showMsg(_geT('geNoDiskPath')); return; }
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
    // Sequential renormalise → <prefix><NN..>; otherwise keep the original
    // item name stem. Multi-segment zipPath-like names already include a
    // directory prefix; we keep the basename only so the saved filename is a
    // plain leaf ("p1.png" path "archive.zip/sub/x.png" → "x").
    var baseName = it.name || (it.path || '').split('/').pop() || '';
    job.outStem = digits > 0
      ? (_batchCfg.prefix || _geT('geRenormPrefixPh')) + _padNum(i + 1, digits)
      : _stripExt(baseName);
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
  html += '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(_geT('geBatchDone', [String(ok), String(fail)])) + '</span>';
  html += '<div class="gallery-edit-actions">';
  html += '<button class="pg-btn" id="ge-open-folder-btn">' + escapeHtml(_geT('geBatchOpenFolder')) + '</button>';
  html += '</div></div>';
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

function _renderImageForm() {
  var probe = _editProbe || {};
  var w = probe.width || 0, h = probe.height || 0;
  var srcExt = _editCurrentItem ? (extOf(_editCurrentItem.name) || 'png').toLowerCase() : 'png';
  var formatOptions = ['jpeg', 'png', 'webp', 'bmp', 'tiff', 'gif'];
  var selectedFormat = srcExt;
  if (formatOptions.indexOf(selectedFormat) < 0) selectedFormat = 'png';
  if (selectedFormat === 'jpg') selectedFormat = 'jpeg';

  var html = '';

  // Batch mode + compress toggle
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check">';
  html += '<input type="checkbox" id="ge-img-batch"> ' + escapeHtml(_geT('geBatchConvert'));
  html += '</label>';
  html += '<span id="ge-batch-count" style="font-size:11px;color:var(--text-muted);margin-left:8px"></span>';
  html += '</div>';
  // Compress to ZIP (only visible in batch mode)
  html += '<div class="gallery-edit-row" id="ge-img-compress-row" style="display:none;margin-left:24px">';
  html += '<label class="gallery-edit-check">';
  html += '<input type="checkbox" id="ge-img-compress"> ' + escapeHtml(_geT('geCompressZip'));
  html += '</label>';
  html += '</div>';
  // Custom zip/folder name (only visible in batch + compress mode)
  html += '<div class="gallery-edit-row" id="ge-img-rename-row" style="display:none;margin-left:24px">';
  html += '<label class="gallery-edit-check">';
  html += '<input type="checkbox" id="ge-img-rename"> ' + escapeHtml(_geT('geRenameZip'));
  html += '</label>';
  html += '<input type="text" id="ge-img-rename-name" style="flex:1;margin-left:8px" placeholder="' + escapeHtml(_geT('geRenamePlaceholder')) + '" title="' + escapeHtml(_geT('geRenameZipHint')) + '">';
  html += '</div>';
  // Sequential rename (only visible in batch mode, hidden when compress path forced in-place)
  html += '<div class="gallery-edit-row" id="ge-img-renorm-row" style="display:none;margin-left:24px">';
  html += '<label class="gallery-edit-check">';
  html += '<input type="checkbox" id="ge-img-renorm"> ' + escapeHtml(_geT('geRenorm'));
  html += '</label>';
  html += '</div>';
  html += '<div class="gallery-edit-row" id="ge-img-renorm-opts" style="display:none;margin-left:48px">';
  html += '<label class="gallery-edit-label" style="width:auto">' + escapeHtml(_geT('geRenormPrefix')) + '</label>';
  html += '<input type="text" id="ge-img-renorm-prefix" style="width:120px" value="' + escapeHtml(_geT('geRenormPrefixPh')) + '" placeholder="' + escapeHtml(_geT('geRenormPrefixPh')) + '">';
  html += '<label class="gallery-edit-label" style="width:auto;margin-left:8px">' + escapeHtml(_geT('geRenormDigits')) + '</label>';
  html += '<input type="number" id="ge-img-renorm-digits" min="1" max="9" value="2" style="width:60px">';
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

  // Scale slider
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label">' + escapeHtml(_geT('geScalePercent')) + '</label>';
  html += '<input type="range" id="ge-img-scale" min="10" max="200" value="100" style="flex:1">';
  html += '<span class="gallery-edit-val" id="ge-scale-val">100%</span>';
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
  html += '<div class="pg-modal-header">';
  html += '<span class="pg-modal-title" title="' + fullTitle + '">' + fullTitle + '</span>';
  html += '<button class="pg-modal-close" onclick="pgCloseModal()">\u2715</button>';
  html += '</div>';

  html += '<div class="pg-modal-body gallery-edit-body">';

  // FFmpeg warning
  html += '<div id="ge-ffmpeg-warn" style="display:none;padding:8px 12px;background:rgba(239,68,68,0.1);border:1px solid var(--danger);border-radius:var(--radius-sm);margin-bottom:12px;font-size:13px;color:var(--danger)">';
  html += '<strong>' + escapeHtml(_geT('geFfmpegNA')) + '</strong>: ' + escapeHtml(_geT('geFfmpegNAHint'));
  html += '</div>';

  // Source info line with settings gear button
  html += '<div class="gallery-edit-info" id="ge-source-info">';
  html += '<span>' + escapeHtml(_geT('geSourceInfo')) + ': <span id="ge-source-detail">Loading...</span></span>';
  html += '<button type="button" id="ge-settings-btn" class="ge-gear-btn" data-tooltip="' + escapeHtml(_geT('geSettingsHint')) + '" title="' + escapeHtml(_geT('geSettings')) + '">';
  html += '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
  html += '</button>';
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
  html += '<button type="button" class="btn btn-browse" id="ge-browse-dir-btn" title="' + escapeHtml(_geT('geBrowseDir')) + '">';
  html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
  html += '</button>';
  html += '<input type="text" id="ge-dest-dir" style="flex:1" placeholder="' + escapeHtml(_geT('geDestDirPlaceholder')) + '">';
  html += '</div>';
  html += '<div class="gallery-edit-row" id="ge-dest-rename-row" style="display:none;margin-left:24px">';
  html += '<label class="gallery-edit-label" style="width:auto">' + escapeHtml(_geT('geRenameZip')) + '</label>';
  html += '<input type="text" id="ge-dest-rename" style="flex:1;margin-left:8px" placeholder="' + escapeHtml(_geT('geRenamePlaceholder')) + '">';
  html += '</div>';
  html += '</div>';

  if (isImage) {
    // Image: simple form
    html += '<div class="gallery-edit-section" id="ge-img-section">';
    html += _renderImageForm();
    html += '</div>';
  } else {
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
  }, 30);
  _checkFfmpegStatus();
  if (_editProbe) {
    var detailEl = document.getElementById('ge-source-detail');
    if (detailEl) {
      var parts = [];
      if (_editProbe.width && _editProbe.height) parts.push(_editProbe.width + '\u00d7' + _editProbe.height);
      if (_editProbe.codec) parts.push(_editProbe.codec);
      if (_editMediaType === 'video') {
        if (_editProbe.duration != null && _editProbe.duration > 0) parts.push(formatTime(_editProbe.duration));
        if (_editProbe.hasAudio === false) parts.push(_geT('geNoAudio'));
      }
      detailEl.textContent = parts.join(', ') || '-';
    }
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
      });
    };
  }
  // Destination radio toggle
  var destRadios = document.querySelectorAll('input[name="ge-dest"]');
  var destDirRow = document.getElementById('ge-dest-dir-row');
  var destRenameRow = document.getElementById('ge-dest-rename-row');
  destRadios.forEach(function(r) {
    r.onchange = function() {
      var saveToDir = (this.value === 'dir');
      if (destDirRow) destDirRow.style.display = saveToDir ? '' : 'none';
      // Custom output filename is meaningful only when saving to a directory
      // (Same Path keeps the original name).
      if (destRenameRow) destRenameRow.style.display = saveToDir ? '' : 'none';
      _refreshBatchUXVisibility();
    };
  });

  // Batch checkbox — update count + toggle compress row
  var batchCb = document.getElementById('ge-img-batch');
  var compressRow = document.getElementById('ge-img-compress-row');
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
      if (compressRow) compressRow.style.display = batchCb.checked ? '' : 'none';
      _refreshBatchUXVisibility();
    };
  }
  // Compress toggle — reveal "rename" sub-row only when compressing (the
  // rename field sets the zip name; in non-compress batches the folder name
  // comes from the source folder so rename is hidden there).
  var compressCb = document.getElementById('ge-img-compress');
  if (compressCb) {
    compressCb.onchange = _refreshBatchUXVisibility;
  }
  // Rename toggle — surface the custom name input.
  var renameCb = document.getElementById('ge-img-rename');
  var renameNameInput = document.getElementById('ge-img-rename-name');
  if (renameCb) {
    renameCb.onchange = function() {
      if (renameNameInput) renameNameInput.style.display = renameCb.checked ? '' : 'none';
      _refreshBatchUXVisibility();
    };
  }
  // Normalise toggle — surface prefix/digits.
  var renormCb = document.getElementById('ge-img-renorm');
  var renormOpts = document.getElementById('ge-img-renorm-opts');
  if (renormCb) {
    renormCb.onchange = function() {
      if (renormOpts) renormOpts.style.display = renormCb.checked ? '' : 'none';
      _refreshBatchUXVisibility();
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
function _getDestination() {
  var destRadio = document.querySelector('input[name="ge-dest"]:checked');
  var samePath = !destRadio || destRadio.value === 'overwrite';
  var dirInput = document.getElementById('ge-dest-dir');
  var dir = dirInput ? dirInput.value.trim() : '';
  // Custom output filename (rename). Lives in the shared dest block on the
  // "Save to dir" path only. Stem only (no extension) — the server appends
  // the format extension.
  var renameInput = document.getElementById('ge-dest-rename');
  var renameStem = renameInput ? (renameInput.value || '').trim() : '';
  return { overwrite: samePath, outputDir: samePath ? null : (dir || null), renameStem: renameStem || null };
}

function _startImageTranscode() {
  var format = document.getElementById('ge-img-format').value;
  var quality = parseInt(document.getElementById('ge-img-quality').value) || 85;
  var scalePercent = parseInt(document.getElementById('ge-img-scale').value) || 100;
  var stripMetadata = document.getElementById('ge-img-strip').checked;
  var batch = document.getElementById('ge-img-batch').checked;
  var compress = document.getElementById('ge-img-compress') && document.getElementById('ge-img-compress').checked;
  var dest = _getDestination();
  var params = { format: format, quality: quality, scalePercent: scalePercent, stripMetadata: stripMetadata };
  if (batch) {
    _startBatch('image_transcode', params, dest, compress);
  } else {
    _startJob('image_transcode', params, dest.overwrite, dest.outputDir);
  }
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

  var dest = _getDestination();
  _startJob('video_transcode', {
    codec: codec, container: container, qualityTier: qualityTier,
    preset: preset, scalePercent: scalePercent,
    audioCodec: audioCodec, audioBitrate: audioBitrate,
    stripMetadata: stripMetadata
  }, dest.overwrite, dest.outputDir);
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

  var dest = _getDestination();
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
  _startJob('video_trim', params, dest.overwrite, dest.outputDir);
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
    var destDir = document.getElementById('ge-dest-dir');
    if (destDir) {
      fetch('/api/settings')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var dl = (data && data.download) || {};
          _editDefaultDir = dl.defaultDir || '';
          if (dl.defaultDir) destDir.value = dl.defaultDir;
        })
        .catch(function() {});
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
    var detailEl = document.getElementById('ge-source-detail');
    if (detailEl) {
      var parts = [];
      if (data.width && data.height) parts.push(data.width + '\u00d7' + data.height);
      if (data.codec) parts.push(data.codec);
      if (_editMediaType === 'video') {
        if (data.duration != null && data.duration > 0) parts.push(formatTime(data.duration));
        if (data.hasAudio === false) parts.push(_geT('geNoAudio'));
      }
      detailEl.textContent = parts.join(', ') || '-';
    }
    // Update scale dimensions hint
    var scaleDims = document.getElementById('ge-scale-dims');
    if (scaleDims && data.width && data.height) {
      scaleDims.textContent = _geT('geOutputDims', [data.width, data.height]);
    }
    // Update trim segment display if on video mode
    if (_editMediaType === 'video') {
      _updateTrimSegmentDisplay();
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
