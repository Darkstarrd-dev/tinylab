/* P1-04a concurrency limiter: cap batch to 6 concurrent ops to avoid 429 */
function runWithConcurrency(tasks, cap, fn){ cap=Math.max(1, cap||6); return new Promise(function(resolve,reject){ var i=0, active=0, results=[], failed=null; function next(){ if(failed) return; while(active<cap && i<tasks.length){ (function(idx){ var t=tasks[idx]; active++; Promise.resolve(fn(t, idx)).then(function(r){results[idx]=r; active--; if(i>=tasks.length && active===0) resolve(results); else next();}, function(e){ failed=e; reject(e);}); })(i++); } if(i>=tasks.length && active===0) resolve(results); } next(); }); }
// gallery-edit-batch.js — batch convert/compress flow, archive mode, zip-outputs/zip-writeback integration.
// Split from gallery-edit.js (refactor Fix 5).
// Backend: internal/api/gallery/edit_handlers.go (zip-outputs/zip-writeback).

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
    // Archive grouping: prefer the archive sourceId (/api/archive-registered
    // packs), then the on-disk absolute path (backend folders), then the
    // in-memory session id (legacy FSAA / drag-drop zips). All three are
    // stable pack identifiers shared by every entry of the same archive.
    var zipKey = cur.sourceId || cur.grantId || ('@sess:' + (cur.sessionId || ''));
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.kind !== 'zip') continue;
      var k = it.sourceId || it.grantId || ('@sess:' + (it.sessionId || ''));
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
    if (it.grantId) stem = (it.zipRel || it.name || 'archive.zip').split(/[\\/]/).pop();
    else stem = (it.path || '').split('/')[0] || it.name || '';
  } else if (it.kind === 'fs' && it.rootDirHandle && it.rootDirHandle.name) {
    stem = it.rootDirHandle.name;
  } else if (it.kind === 'backend' && it.grantId) {
    stem = (it.rel || it.name || 'output').split(/[\\/]/).pop();
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
    if (!prefix) prefix = T('geRenormPrefixPh');
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

// _resolveBatchInput resolves the server-side input descriptor for a single
// batch item, mirroring the per-item resolution triggerMediaEditor() already
// uses for single-file editing. Items that already carry an assetId or a
// grantId pass through directly; FSAA/drag-drop files are uploaded to a
// registered asset (/edit/upload-temp); zip entries are extracted to a
// registered asset (/edit/extract-zip-entry) — archive-source items via
// sourceId, legacy sessions/on-disk zips via sessionId/zipAbsPath. Both
// endpoints return { assetId } (no tempPath anymore), which /edit/start
// resolves server-side.
// Returns a promise that resolves to an input descriptor
// { inputAssetId | inputGrantId+inputRel } for /edit/start, or rejects on
// failure.
function _resolveBatchInput(it) {
  if (it.assetId) return Promise.resolve({ inputAssetId: it.assetId });
  if (it.grantId && it.kind !== 'zip') return Promise.resolve({ inputGrantId: it.grantId, inputRel: it.rel || '' });
  if (it.kind === 'zip' && (it.grantId || it.sessionId || it.sourceId)) {
    var body = { zipPath: it.zipPath };
    if (it.sourceId) body.sourceId = it.sourceId;
    else if (it.grantId) body.grantId = it.grantId;
    else body.sessionId = it.sessionId;
    return fetch('/api/gallery/edit/extract-zip-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r) {
      return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
    }).then(function(d) { return { inputAssetId: d.assetId }; });
  }
  if (typeof it.getBlob === 'function') {
    return it.getBlob().then(function(blob) {
      return fetch('/api/gallery/edit/upload-temp?name=' + encodeURIComponent(it.name || 'file'), {
        method: 'POST',
        body: blob
      }).then(function(r) {
        return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
      }).then(function(d) { return { inputAssetId: d.assetId }; });
    });
  }
  return Promise.reject(new Error('no disk path'));
}

function _startBatch(op, params, dest, compress, targets) {
  var siblings = (targets && targets.length) ? targets : _getSiblingImages();
  if (siblings.length === 0) {
    var re0 = document.getElementById('ge-result-area');
    if (re0) { re0.innerHTML = '<div class="gallery-edit-result" style="border-color:var(--danger)"><span style="color:var(--danger);font-weight:600">' + escapeHtml(T('geNoBatchItems')) + '</span></div>'; re0.style.display = 'block'; }
    return;
  }
  _batchJobs = [];
  _batchTotal = siblings.length;
  _batchDone = 0;
  _batchDest = dest;
  _batchParams = params;
  _batchOp = op;
  _batchCompress = !!compress;
  _geActiveJob = { kind: 'batch', mediaType: _editMediaType, item: _editCurrentItem, probe: _editProbe };
  _geBatchPollingEnabled = true;

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
  _setProgressStatus(pgT('geBatchProgress', ['0', String(_batchTotal)]), false);

  for (var i = 0; i < siblings.length; i++) {
    var it = siblings[i];
    var job = { item: it, jobId: null, done: false, error: null, outStem: '' };
    job.outStem = digits > 0
      ? (_batchCfg.prefix || T('geRenormPrefixPh')) + _padNum(i + 1, digits)
      : (_batchTotal === 1 && _batchCfg && _batchCfg.renameName ? _batchCfg.renameName : '');
    _batchJobs.push(job);
  }
  // P1-04a: cap batch concurrency to 4 to avoid 429 burst.
  (function runBatchBatch(start) {
    var batch = _batchJobs.slice(start, start + 4);
    if (batch.length === 0) return;
    var offset = start;
    Promise.all(batch.map(function(job, j) {
      var idx = offset + j;
      var item = siblings[idx];
      var outStem = job.outStem;
      return _resolveBatchInput(item).then(function(inputPath) {
        var ow = !!(dest && dest.overwrite);
        var body = { inputAssetId: inputPath.inputAssetId, inputGrantId: inputPath.inputGrantId, inputRel: inputPath.inputRel, operation: op, overwrite: ow, params: params };
        if (outStem && !ow) body.outputName = outStem;
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
        _setProgressStatus(pgT('geBatchProgress', [String(_batchDone), String(_batchTotal)]), false);
        if (_batchDone >= _batchTotal) _onBatchComplete();
      });
    })).then(function() {
      runBatchBatch(start + 4);
    });
  })(0);
}

function _pollBatchJob(idx, jobId) {
  var j0 = _batchJobs[idx];
  if (!j0 || j0.done) return;
  if (j0.polling) return;
  j0.polling = true;
  fetch('/api/gallery/edit/status/' + encodeURIComponent(jobId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var j = _batchJobs[idx];
      if (j) j.polling = false;
      if (!j) return;
      if (data.status === 'running') {
        var block = _geConsoleBlock(jobId, (j.item && j.item.name) || '');
        if (block) {
          var cmdEl = block.querySelector('.ge-console-block-cmd');
          if (cmdEl && data.command) cmdEl.textContent = '$ ' + data.command;
          var logEl = block.querySelector('.ge-console-block-log');
          if (logEl && data.logTail) { logEl.textContent = data.logTail; logEl.scrollTop = logEl.scrollHeight; }
        }
        if (_geBatchPollingEnabled && !j.done) setTimeout(function() { _pollBatchJob(idx, jobId); }, 600);
      } else {
        if (data.status === 'completed') {
          j.overwritten = !!data.overwritten;
          j.assetId = data.assetId;
          j.outputName = data.outputName;
        } else {
          j.error = data.error || data.status;
        }
        _batchDone++;
        _setProgressStatus(pgT('geBatchProgress', [String(_batchDone), String(_batchTotal)]), false);
        if (_batchDone >= _batchTotal) _onBatchComplete();
      }
    })
    .catch(function(err) {
      var j = _batchJobs[idx];
      if (j) { j.polling = false; j.done = true; j.error = err.message || String(err); }
      _batchDone++;
      _setProgressStatus(pgT('geBatchProgress', [String(_batchDone), String(_batchTotal)]), false);
      if (_batchDone >= _batchTotal) _onBatchComplete();
    });
}

// _refreshTreeBatchOutputs refreshes gallery items after an in-place
// (overwrite) tree batch: renames items whose extension changed (png→webp),
// drops stale blob URLs, and re-renders thumbs/tree/main view. Grant-backed
// getBlob() refetches fresh bytes lazily.
function _refreshTreeBatchOutputs() {
  if (typeof galleryState === 'undefined' || !galleryState.items) return;
  var curChanged = false;
  for (var i = 0; i < _batchJobs.length; i++) {
    var j = _batchJobs[i];
    if (!j || j.error || !j.overwritten || !j.item) continue;
    if (j.outputName) {
      // 跨格式覆盖后磁盘文件名已变（旧文件已删）：同步 rel/path/name，
      // 否则 getBlob 按旧 rel 取文件会 404。
      if (j.item.rel) {
        var sep = Math.max(j.item.rel.lastIndexOf('/'), j.item.rel.lastIndexOf('\\'));
        var newRel = (sep >= 0 ? j.item.rel.substring(0, sep + 1) : '') + j.outputName;
        j.item.rel = newRel;
        j.item.path = newRel;
      }
      j.item.name = j.outputName;
    }
    if (j.item.mainURL && j.item.mainURL.indexOf('blob:') === 0 && typeof FsApi !== 'undefined') FsApi.BlobTracker.revoke(j.item.mainURL);
    if (j.item.thumbURL && j.item.thumbURL.indexOf('blob:') === 0 && typeof FsApi !== 'undefined') FsApi.BlobTracker.revoke(j.item.thumbURL);
    j.item.mainURL = null;
    j.item.thumbURL = null;
    j.item.thumbReady = false;
    j.item.size = 0;
    if (galleryState.items[galleryState.index] === j.item) curChanged = true;
  }
  if (typeof renderThumbnails === 'function') renderThumbnails();
  if (typeof renderTreePanel === 'function') renderTreePanel();
  if (curChanged && typeof renderActive === 'function') renderActive(galleryState.index);
}

function _onBatchComplete() {
  _editJobId = null;
  _geActiveJob = null;
  _geBatchPollingEnabled = false;
  var ok = 0, fail = 0;
  var outputPaths = [];
  var firstGrant = null;
  var firstRel = '';
  for (var i = 0; i < _batchJobs.length; i++) {
    if (_batchJobs[i].error) { fail++; continue; }
    ok++;
    if (_batchJobs[i].assetId) outputPaths.push(_batchJobs[i].assetId);
    if (!firstGrant && _batchJobs[i].item && _batchJobs[i].item.grantId) {
      firstGrant = _batchJobs[i].item.grantId;
      firstRel = _batchJobs[i].item.rel || '';
    }
  }

  // 原地覆盖批量（tree Batch Convert 非 compress）：刷新缩略图/tree/主视图。
  if (_batchDest && _batchDest.overwrite && !_batchCompress) _refreshTreeBatchOutputs();

  // Replace-original on a backend zip (kind:'zip' with zipAbsPath): repack
  // the on-disk archive in place, overwriting each image entry with its
  // transcoded temp output at the same inner zip path. This must run BEFORE
  // the compress branch (compress mode forces non-overwrite so they are
  // mutually exclusive) and before the generic non-compress results.
  if (_batchDest && _batchDest.overwrite && _editCurrentItem && _editCurrentItem.kind === 'zip' && _editCurrentItem.grantId) {
    _zipWritebackBatch(_editCurrentItem.grantId, _editCurrentItem.sessionId || '', ok, fail);
    return;
  }

  // If compress mode and we have outputs, create a zip.
  if (_batchCompress && outputPaths.length > 0) {
    _setProgressStatus(T('geZipping'), false);
    var zipDest = _batchDest.outputDir || _editDefaultDir || '';
    fetch('/api/gallery/edit/zip-outputs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: outputPaths, zipName: _batchOriginZipName(), cleanUp: true })
    })
    .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
    .then(function(data) {
      _hideProgressSection();
      var resultEl = document.getElementById('ge-result-area');
      if (resultEl) {
        var html = '<div class="gallery-edit-result">';
        html += '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(pgT('geBatchDone', [String(ok), String(fail)])) + '</span>';
        html += '<div class="gallery-edit-actions">';
        html += '<button class="pg-btn" id="ge-open-folder-btn">' + escapeHtml(T('geBatchOpenFolder')) + '</button>';
        html += '</div></div>';
        resultEl.innerHTML = html;
        resultEl.style.display = 'block';
      }
      var openBtn = document.getElementById('ge-open-folder-btn');
      if (openBtn && data.assetId) {
        openBtn.onclick = function() { window.open('/api/gallery/file?assetId=' + encodeURIComponent(data.assetId), '_blank'); };
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
    html += '<span style="color:var(--danger);font-weight:600">\u2718 ' + escapeHtml(pgT('geBatchDone', [String(ok), String(fail)])) + '</span>';
    if (firstErr) html += '<div style="font-size:12px;color:var(--danger);margin-top:4px;white-space:pre-wrap;word-break:break-all">' + escapeHtml(firstErr) + '</div>';
  } else {
    html += '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(pgT('geBatchDone', [String(ok), String(fail)])) + '</span>';
  }
  if (ok > 0) {
    html += '<div class="gallery-edit-actions">';
    html += '<button class="pg-btn" id="ge-open-folder-btn">' + escapeHtml(T('geBatchOpenFolder')) + '</button>';
    html += '</div>';
  }
  html += '</div>';
  if (resultEl) {
    resultEl.innerHTML = html;
    resultEl.style.display = 'block';
  }
  var openBtnN = document.getElementById('ge-open-folder-btn');
  if (openBtnN) {
    var firstOutId = outputPaths.length > 0 ? outputPaths[0] : '';
    var openGrant = firstGrant;
    var openRel = firstRel;
    openBtnN.onclick = function() {
      if (firstOutId) { window.open('/api/gallery/file?assetId=' + encodeURIComponent(firstOutId), '_blank'); return; }
      if (openGrant) { _openInFileManager(openGrant, openRel); }
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
function _zipWritebackBatch(grantId, sessionId, ok, fail) {
  var entries = [];
  for (var i = 0; i < _batchJobs.length; i++) {
    var j = _batchJobs[i];
    if (!j.error && j.assetId && j.item && j.item.zipPath) {
      entries.push({ zipPath: j.item.zipPath, assetId: j.assetId });
    }
  }

  _setProgressStatus(T('geZipping') || 'Repacking archive...', false);
  fetch('/api/gallery/edit/zip-writeback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId, grantId: grantId, entries: entries })
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
  .then(function() {
    _hideProgressSection();
    var resultEl = document.getElementById('ge-result-area');
    if (resultEl) {
      // Single action button: "Open Folder" if translation exists, else fall
      // back to the "Show in Gallery" label (still wired to open the folder,
      // since the archive is replaced in place, not added as a new entry).
      var openLabel = T('geBatchOpenFolder') || T('geShowInGallery');
      var html = '<div class="gallery-edit-result">';
      html += '<span style="color:var(--accent2);font-weight:600">\u2714 ' + escapeHtml(pgT('geBatchDone', [String(ok), String(fail)])) + '</span>';
      html += '<div class="gallery-edit-actions">';
      html += '<button class="pg-btn" id="ge-open-folder-btn">' + escapeHtml(openLabel) + '</button>';
      html += '</div></div>';
      resultEl.innerHTML = html;
      resultEl.style.display = 'block';
    }
    var openBtn = document.getElementById('ge-open-folder-btn');
    if (openBtn && grantId) {
      openBtn.onclick = function() { _openInFileManager(grantId, _editCurrentItem.zipRel || ''); };
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
function _openInFileManager(grantId, rel) {
  fetch('/api/gallery/open-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantId: grantId, rel: rel || '' })
  })
  .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
  .catch(function(err) {
    showMsg((T('geBatchOpenError') || 'Failed to open folder') + ': ' + (err.message || err));
  });
}

// ---------- tree batch convert (Batch Convert button) --------------------
// 瘦身版 Image Convert：仅保留格式/画质/缩放（+Compress 打包开关），去掉
// source-info/Set Path/Set Name/Uniform 行。目标 = tree 已加载的全部非压缩包
// 图片，按各自原路径原地保存（overwrite:true，后端跨格式自动换扩展名+删旧文件）。
// 仅 backend kind（grantId）可写：fs/plain 无服务端可写路径，zip 走压缩包内路径，
// 统一跳过并计数提示。
function _treeBatchTargets() {
  var items = (typeof galleryState !== 'undefined' && galleryState.items) || [];
  var writable = [];
  var skipped = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it) { skipped++; continue; }
    if (it.kind === 'backend' && it.grantId) { writable.push(it); continue; }
    skipped++;
  }
  return { writable: writable, skipped: skipped };
}

function _treeBatchFormatOptions(srcExt) {
  var formatOptions = ['jpeg', 'png', 'webp', 'bmp', 'tiff', 'gif'];
  if (srcExt === 'jpg') srcExt = 'jpeg';
  if (formatOptions.indexOf(srcExt) < 0) srcExt = 'png';
  var html = '';
  for (var i = 0; i < formatOptions.length; i++) {
    var f = formatOptions[i];
    html += '<option value="' + f + '"' + (f === srcExt ? ' selected' : '') + '>' + f.toUpperCase() + '</option>';
  }
  return html;
}

function _bindTreeBatchDialog(summary) {
  var fmtSelect = document.getElementById('ge-treebatch-format');
  var losslessNote = document.getElementById('ge-treebatch-lossless-note');
  var qualitySlider = document.getElementById('ge-treebatch-quality');
  var qualityVal = document.getElementById('ge-treebatch-quality-val');
  var scaleInput = document.getElementById('ge-treebatch-scale');
  var scaleVal = document.getElementById('ge-treebatch-scale-val');
  if (fmtSelect && losslessNote) {
    fmtSelect.onchange = function() {
      losslessNote.style.display = (fmtSelect.value === 'png') ? '' : 'none';
    };
    fmtSelect.onchange();
  }
  if (qualitySlider && qualityVal) {
    qualitySlider.oninput = function() { qualityVal.textContent = qualitySlider.value; };
  }
  if (scaleInput && scaleVal) {
    scaleInput.oninput = function() { scaleVal.textContent = (parseFloat(scaleInput.value) || 100) + '%'; };
  }
  var startBtn = document.getElementById('ge-treebatch-start-btn');
  if (startBtn) {
    startBtn.onclick = function() {
      for (var r = 0; r < _batchJobs.length; r++) {
        if (_batchJobs[r] && !_batchJobs[r].done) return;
      }
      var format = fmtSelect ? fmtSelect.value : 'png';
      var quality = qualitySlider ? (parseInt(qualitySlider.value, 10) || 85) : 85;
      var scalePercent = scaleInput ? (parseInt(scaleInput.value, 10) || 100) : 100;
      var compressCb = document.getElementById('ge-treebatch-compress');
      var compress = !!(compressCb && compressCb.checked);
      var params = { format: format, quality: quality, scalePercent: scalePercent, stripMetadata: false };
      // Compress 开 = 打包输出（沿用现有 zip-outputs 链，需非覆盖拿 assetId）；
      // 关闭 = tree 全部原地覆盖保存。
      var dest = compress ? { overwrite: false, outputDir: null } : { overwrite: true, outputDir: null };
      _editMediaType = 'image';
      _editCurrentItem = summary.writable[0] || null;
      _startBatch('image_transcode', params, dest, compress, summary.writable);
    };
  }
}

window.openTreeBatchConvert = function() {
  if (_geActiveJob) { _geResumeActive(); return; }
  var summary = _treeBatchTargets();
  if (!summary.writable.length) {
    showMsg(T('geTreeBatchNoWritable') || 'No writable images. Open a folder first.');
    return;
  }
  var first = summary.writable[0];
  var srcExt = first ? ((typeof extOf === 'function' ? extOf(first.name) : '') || 'png').toLowerCase() : 'png';
  var html = '';
  html += '<div class="pg-modal-header">';
  html += '<span class="pg-modal-title ge-title-center">' + escapeHtml(T('geTreeBatchConvert') || 'Batch Convert') + '</span>';
  html += '<button class="pg-modal-close" onclick="pgCloseModal()">\u2715</button>';
  html += '</div>';
  html += '<div class="pg-modal-body gallery-edit-body">';
  html += '<div class="ge-src-info"><div class="ge-src-row ge-src-meta">' + escapeHtml(pgT('geTreeBatchSummary', [String(summary.writable.length)]));
  if (summary.skipped > 0) html += ' · ' + escapeHtml(pgT('geTreeBatchSkipped', [String(summary.skipped)]));
  html += '</div></div>';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-check"><input type="checkbox" id="ge-treebatch-compress"> ' + escapeHtml(T('geCompressZip')) + '</label>';
  html += '<select class="pg-param-row-select" id="ge-treebatch-format" style="width:95px;flex:none">' + _treeBatchFormatOptions(srcExt) + '</select>';
  html += '<div style="margin-left:auto;display:flex;align-items:center;gap:8px">';
  html += '<label class="gallery-edit-label" style="width:auto;margin:0">' + escapeHtml(T('geQuality')) + '</label>';
  html += '<input type="range" id="ge-treebatch-quality" min="0" max="100" value="85" style="width:130px">';
  html += '<span class="gallery-edit-val" id="ge-treebatch-quality-val" style="min-width:24px;text-align:right">85</span>';
  html += '</div>';
  html += '</div>';
  html += '<div class="gallery-edit-row" id="ge-treebatch-lossless-note" style="display:none">';
  html += '<span style="font-size:11px;color:var(--text-muted);margin-left:auto">' + escapeHtml(T('geQualityHint')) + '</span>';
  html += '</div>';
  html += '<div class="gallery-edit-row">';
  html += '<label class="gallery-edit-label" style="width:auto;margin:0">' + escapeHtml(T('geScalePercent')) + '</label>';
  html += '<input type="range" id="ge-treebatch-scale" min="10" max="200" value="100" style="width:130px">';
  html += '<span class="gallery-edit-val" id="ge-treebatch-scale-val" style="min-width:36px">100%</span>';
  html += '</div>';
  html += '<div class="gallery-edit-section" id="ge-progress-section" style="display:none">';
  html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">';
  html += '<progress id="ge-progress-bar" value="0" max="100" style="flex:1;height:8px"></progress>';
  html += '<button class="pg-btn danger" id="ge-cancel-btn" style="font-size:11px;padding:2px 8px">' + escapeHtml(T('geCancelJob')) + '</button>';
  html += '</div>';
  html += '<span id="ge-progress-text" style="font-size:12px;color:var(--text-muted)">' + escapeHtml(T('geRunning')) + '</span>';
  html += '</div>';
  html += '<div id="ge-result-area" style="display:none"></div>';
  html += '</div>';
  html += '<div class="pg-modal-footer">';
  html += '<button type="button" class="btn btn-ghost" onclick="pgCloseModal()">' + escapeHtml(T('geCancel')) + '</button>';
  html += '<button type="button" class="btn btn-primary" id="ge-treebatch-start-btn">' + escapeHtml(T('geStart')) + '</button>';
  html += '</div>';
  pgShowModal(html);
  _geEnsureConsole();
  setTimeout(function() {
    var modal = document.querySelector('#pg-modal-overlay .pg-modal');
    if (modal) { modal.style.width = '520px'; modal.style.minWidth = '520px'; }
  }, 0);
  _checkFfmpegStatus();
  _bindTreeBatchDialog(summary);
  var cancelBtn = document.getElementById('ge-cancel-btn');
  if (cancelBtn) { cancelBtn.onclick = _cancelJob; }
};
