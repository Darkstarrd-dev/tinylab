// gallery-io.js — Gallery item accessors, filesystem traversal, zip loading, and collectors.

'use strict';

// ---------- item accessors ---------------------------------------
function getItemBlob(item) {
  if (!item) return Promise.resolve(null);
  if (typeof item.getBlob === 'function') return Promise.resolve(item.getBlob());
  try {
    if (item.kind === 'fs' && item.handle) {
      return item.handle.getFile();
    }
    if (item.kind === 'plain') {
      return Promise.resolve(item.file);
    }
    if (item.kind === 'zip') {
      return getZipEntryBlob(item);
    }
  } catch (e) {
    return Promise.reject(e);
  }
  return Promise.resolve(null);
}

// getZipEntryBlob fetches a single zip entry image, rehydrating the backend
// session on a 404 (the session was evicted by the LRU) by re-uploading the
// pack from its original source, then retrying the fetch once. The retry uses
// the fresh session id stored back onto the item (and onto every sibling item
// of the same pack) so a single re-upload revives the whole pack.
function getZipEntryBlob(item) {
  var sid = item.sessionId || galleryState.zipSessionId;
  var zPath = item.zipPath || item.path || '';
  // Use zipPath (path stable after deletion; index is renumbered by DELETE
  // and would become stale — zipPath is unique per entry and never changes).
  var identifier = zPath.split('/').map(encodeURIComponent).join('/');
  var url = '/api/gallery/zip/' + encodeURIComponent(sid) + '/' + identifier;
  return fetch(url).then(function(r) {
    if (r.ok) return r.blob();
    if (r.status !== 404) throw new Error('zip entry http ' + r.status);
    // Session evicted by LRU — rehydrate from the pack's source and retry once.
    return rehydrateZipSession(item).then(function(newSid) {
      if (!newSid) throw new Error('zip session rehydrate failed');
      var nurl = '/api/gallery/zip/' + encodeURIComponent(item.sessionId) + '/' + identifier;
      return fetch(nurl).then(function(r2) {
        if (!r2.ok) throw new Error('zip entry http ' + r2.status);
        return r2.blob();
      });
    });
  });
}

// rehydrateZipSession re-creates an evicted backend zip session from the
// pack's original source and migrates every item of the same pack to the new
// session id. Deduped per old session id so concurrent 404s for the same pack
// share a single re-upload. Returns the new session id, or null on failure.
var _rehydrateInFlight = {}; // oldSessionId -> Promise<newSessionId|null>
function rehydrateZipSession(item) {
  var oldSid = item.sessionId;
  if (oldSid && _rehydrateInFlight[oldSid]) return _rehydrateInFlight[oldSid];
  var p = (async function() {
    try {
      var newSid = null;
      if (item.zipAbsPath) {
        // Backend-path packs re-create from the on-disk path (no upload).
        var res = await fetch('/api/gallery/zip-from-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: item.zipAbsPath })
        });
        if (!res.ok) return null;
        var d = await res.json();
        newSid = d.sessionId;
      } else {
        // FS Access API or pasted blob packs re-upload the zip bytes.
        var blob = null;
        if (item.zipFileHandle) {
          blob = await item.zipFileHandle.getFile();
        } else if (item.zipFile) {
          blob = item.zipFile;
        }
        if (!blob) return null;
        var buf = await blob.arrayBuffer();
        var res = await fetch('/api/gallery/zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: buf
        });
        if (!res.ok) return null;
        var d = await res.json();
        newSid = d.sessionId;
      }
      if (newSid && oldSid) {
        // Migrate all items of the evicted pack to the fresh session.
        for (var i = 0; i < galleryState.items.length; i++) {
          var it = galleryState.items[i];
          if (it && it.kind === 'zip' && it.sessionId === oldSid) it.sessionId = newSid;
        }
      }
      return newSid;
    } catch (e) {
      console.warn('rehydrateZipSession failed:', e);
      return null;
    } finally {
      if (oldSid) delete _rehydrateInFlight[oldSid];
    }
  })();
  if (oldSid) _rehydrateInFlight[oldSid] = p;
  return p;
}

async function ensureMainSrc(item) {
  if (!item) return;
  try {
    if (item.mainURL) return;
    var blob;
    if (isTiff(item.name)) {
      blob = await getItemBlob(item);
      if (!blob) return;
      var conv = await fetch('/api/gallery/tiff', {
        method: 'POST',
        body: blob
      });
      if (!conv.ok) throw new Error('tiff http ' + conv.status);
      blob = await conv.blob();
    } else {
      blob = await getItemBlob(item);
    }
    if (!blob) return;
    setMainURL(item, trackURL(FsApi.BlobTracker.create(blob)));
  } catch (e) {
    console.warn('ensureMainSrc failed:', e);
  }
}

async function ensureThumb(item) {
  if (!item || item.thumbReady) return;
  try {
    var blob = await getItemBlob(item);
    if (!blob) return;
    var url;
    try {
      var bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      var maxDim = THUMB_SIZE;
      var scale = Math.min(maxDim / bitmap.width, maxDim / bitmap.height);
      var w = Math.round(bitmap.width * scale);
      var h = Math.round(bitmap.height * scale);
      var canvas = new OffscreenCanvas(w, h);
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close && bitmap.close();
      var tblob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      url = trackURL(FsApi.BlobTracker.create(tblob));
    } catch (e) {
      url = trackURL(FsApi.BlobTracker.create(blob));
    }
    setThumbURL(item, url);
    item.thumbReady = true;
    var imgEl = item.thumbImgEl;
    if (imgEl) imgEl.src = url;
  } catch (e) {
    console.warn('ensureThumb failed:', e);
  }
}

// ---------- filesystem traversal ---------------------------------
async function walkDir(dirHandle, prefix, out, outVid) {
  var root = dirHandle; // capture the top-level directory handle
  var queue = [];
  queue.push({ handle: dirHandle, prefix: prefix });
  while (queue.length) {
    var cur = queue.shift();
    var entries = [];
    try {
      for await (var entry of cur.handle.values()) {
        entries.push(entry);
      }
    } catch (e) {
      console.warn('walkDir values failed:', e);
      continue;
    }
    for (var i = 0; i < entries.length; i++) {
      var ent = entries[i];
      var rel = cur.prefix ? cur.prefix + '/' + ent.name : ent.name;
      if (ent.kind === 'directory') {
        queue.push({ handle: ent, prefix: rel });
      } else if (ent.kind === 'file') {
        if (isZipName(ent.name)) {
          // Upload zip to server and create proper zip items with handle
          try {
            var ff = await ent.getFile();
            await addZipBlob(ff, out, ent);
          } catch (e) {
            console.warn('walkDir zip failed:', e);
          }
        } else if (isSupportedExt(ent.name)) {
          if (isVideoExt(ent.name)) {
            if (outVid) outVid.push({
              name: ent.name,
              path: rel,
              kind: 'fs',
              handle: ent,
              rootDirHandle: root, // points to the top-level directory
              getBlob: function(h) { return function() { return h.getFile(); }; }(ent),
              size: 0
            });
          } else {
            out.push({
              name: ent.name,
              path: rel,
              kind: 'fs',
              handle: ent,
              rootDirHandle: root, // points to the top-level directory
              getBlob: function(h) { return function() { return h.getFile(); }; }(ent),
              size: 0
            });
          }
        }
      }
    }
  }
}

// ---------- recursive directory reader for Drag & Drop / Paste -----------
function readEntryRecursive(entry, prefix) {
  return new Promise(function(resolve) {
    if (!entry) return resolve([]);
    if (entry.isFile) {
      entry.file(function(file) {
        var name = file.name || entry.name || '';
        if (file && file.size > 0 && (isSupportedExt(name) || isZipName(name))) {
          var rel = prefix ? prefix + '/' + name : name;
          resolve([{ kind: isZipName(name) ? 'zipfile' : 'plain', file: file, path: rel }]);
        } else {
          resolve([]);
        }
      }, function() { resolve([]); });
    } else if (entry.isDirectory) {
      var reader = entry.createReader();
      var allEntries = [];
      var readBatch = function() {
        reader.readEntries(function(results) {
          if (!results || !results.length) {
            var dirPrefix = prefix ? prefix + '/' + entry.name : entry.name;
            var promises = allEntries.map(function(child) {
              return readEntryRecursive(child, dirPrefix);
            });
            Promise.all(promises).then(function(nested) {
              var flat = [];
              for (var i = 0; i < nested.length; i++) {
                flat = flat.concat(nested[i]);
              }
              resolve(flat);
            });
          } else {
            allEntries = allEntries.concat(Array.prototype.slice.call(results));
            readBatch();
          }
        }, function() { resolve([]); });
      };
      readBatch();
    } else {
      resolve([]);
    }
  });
}

// ---------- collectors & lazy zip loader ---------------------------
async function loadNextZipChunk() {
  if (!galleryState.pendingZipQueue.length || galleryState.loadingZip) return;
  galleryState.loadingZip = true;
  var nextZip = galleryState.pendingZipQueue.shift();
  var newItems = [];
  await addZipBlob(nextZip, newItems);
  galleryState.loadingZip = false;
  if (newItems.length) {
    appendNewItems(newItems);
  }
}

function appendNewItems(newItems) {
  sortItems(newItems);
  galleryState.items = galleryState.items.concat(newItems);
  updateDirStructure();
  renderThumbnails();
  if (galleryState.index >= 0 && galleryState.index < galleryState.items.length) {
    renderActive(galleryState.index);
  }
}

// runWithConcurrency runs task(item) over every item with at most `limit`
// in-flight at once. Preserves input order of completion tracking but does not
// wait for earlier items to finish before starting later ones up to the cap.
// Returns a promise that resolves when all tasks have settled.
function runWithConcurrency(items, limit, task) {
  if (!items || !items.length) return Promise.resolve();
  var cap = Math.max(1, limit || 1);
  var i = 0;
  return new Promise(function(resolve) {
    var active = 0;
    function next() {
      while (active < cap && i < items.length) {
        var idx = i++;
        active++;
        Promise.resolve()
          .then(function() { return task(items[idx]); })
          .then(function() { settle(); }, function() { settle(); });
      }
      if (i >= items.length && active === 0) resolve();
    }
    function settle() {
      active--;
      if (i >= items.length && active === 0) resolve();
      else next();
    }
    next();
  });
}

async function processCollectedEntries(collected) {
  galleryState.pendingZipQueue = [];
  galleryState.loadingZip = false;
  var outImg = [];
  var outVid = [];
  var zipFiles = [];
  for (var i = 0; i < collected.length; i++) {
    var item = collected[i];
    if (item.kind === 'zipfile') {
      zipFiles.push({ file: item.file, zipFileHandle: item.zipFileHandle || null });
    } else if (item.kind === 'plain' && item.file && item.file.size > 0) {
      var plainObj = {
        name: item.file.name || item.path.split('/').pop(),
        path: item.path || item.file.name,
        kind: 'plain',
        file: item.file,
        size: item.file.size || 0
      };
      if (isVideoExt(plainObj.path)) {
        outVid.push(plainObj);
      } else {
        outImg.push(plainObj);
      }
    }
  }

  // Parallel process all zip files
  zipFiles.sort(function(a, b) {
    return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
  });

  if (zipFiles.length > 0) {
    // Bounded concurrency: uploading hundreds of zips at once previously let
    // the backend LRU evict the earliest sessions before their thumbnails were
    // fetched (the "first N packs fail" bug). Capping at 6 keeps the working
    // set within the session store and avoids a thundering-herd upload burst.
    await runWithConcurrency(zipFiles, 6, function(zf) {
      return addZipBlob(zf.file, outImg, zf.zipFileHandle);
    });
  }

  // Append videos (preserve existing)
  if (outVid.length) {
    var hadNoVideos = (galleryState.videoItems.length === 0);
    sortItems(outVid);
    galleryState.videoItems = galleryState.videoItems.concat(outVid);
    updateVideoDirStructure();
    if (hadNoVideos) {
      galleryState.videoIndex = -1;
      if (galleryState.viewMode === 'single' && outImg.length === 0 && galleryState.items.length === 0) {
        galleryState.mediaType = 'video';
        updateLayoutMode();
      }
      setVideoActive(0);
    } else {
      renderTreePanel();
    }
  }

  // Append images (preserve existing)
  if (outImg.length) {
    appendItems(outImg);
  }
  renderTreePanel();
}

async function processHandles(handles, leaves) {
  var collected = [];
  for (var i = 0; i < handles.length; i++) {
    var h = handles[i];
    if (h.kind === 'directory') {
      await walkDir(h.handle, '', collected);
    } else if (h.kind === 'file' && h.handle) {
      var name = h.handle.name;
      if (isZipName(name)) {
        try {
          var file = await h.handle.getFile();
          collected.push({ kind: 'zipfile', file: file, zipFileHandle: h.handle });
        } catch (e) { console.warn('zip handle read failed:', e); }
      } else {
        try {
          var ff = await h.handle.getFile();
          collected.push({ kind: 'plain', file: ff, path: name });
        } catch (e) {}
      }
    }
  }
  if (leaves && leaves.length) {
    for (var j = 0; j < leaves.length; j++) {
      var lf = leaves[j];
      if (lf.kind === 'ziphandle') {
        try {
          var zf = await lf.handle.getFile();
          collected.push({ kind: 'zipfile', file: zf, zipFileHandle: lf.handle });
        } catch (e) {}
      } else if (lf.kind === 'file' && lf.handle) {
        try {
          var f2 = await lf.handle.getFile();
          collected.push({ kind: 'plain', file: f2, path: f2.name });
        } catch (e) {}
      } else if (lf.kind === 'blob' && lf.file) {
        collected.push({ kind: 'plain', file: lf.file, path: lf.file.name });
      }
    }
  }
  await processCollectedEntries(collected);
}

function processFiles(files) {
  var collected = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (isZipName(f.name)) collected.push({ kind: 'zipfile', file: f });
    else if (isSupportedExt(f.name) && f.size > 0) collected.push({ kind: 'plain', file: f, path: f.name });
  }
  processCollectedEntries(collected);
}

function processBlobs(blobs) {
  var collected = [];
  for (var i = 0; i < blobs.length; i++) {
    var b = blobs[i];
    if (b.type === 'application/zip' || isZipName(b.name)) collected.push({ kind: 'zipfile', file: b });
    else if (isSupportedExt(b.name) || (b.type && (b.type.startsWith('image/') || b.type.startsWith('video/')))) {
      if (b.size > 0) collected.push({ kind: 'plain', file: b, path: b.name || ('paste' + (b.type.startsWith('video/') ? '.mp4' : extOf(b.type))) });
    }
  }
  processCollectedEntries(collected);
}

function makePlainItem(file) {
  return {
    name: file.name || ('blob' + extOf(file.type)),
    path: file.name || ('blob' + extOf(file.type)),
    kind: 'plain',
    file: file,
    size: file.size
  };
}

async function addZipBlob(file, out, zipFileHandle) {
  try {
    var buf = await file.arrayBuffer();
    var res = await fetch('/api/gallery/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: buf
    });
    if (!res.ok) {
      showMsg('zip http ' + res.status);
      console.warn('zip upload failed:', res.status);
      return;
    }
    var data = await res.json();
    var sessionId = data.sessionId;
    // Do not stomp the global zipSessionId here: under bounded-concurrency
    // bulk import, every addZipBlob would race and the global would end up
    // pointing at the last-imported pack, breaking AI Review (which previously
    // read this global). Each item carries its own sessionId (below), and
    // setActive now updates the global to the currently-viewed pack's session.
    var entries = (data.manifest && data.manifest.entries) || [];
    var zipName = file.path || file.name || 'archive.zip';
    // zipFileHandle: FileSystemFileHandle|null — null means the zip cannot be
    // written back to disk (e.g. pasted blob, legacy drop). UI will degrade
    // delete/overwrite actions accordingly.
    var handle = zipFileHandle || null;
    // Retain the original Blob only when there is no FS handle and no on-disk
    // path to re-create the session from — those cases (pasted/legacy-drop
    // zips) need it for rehydrateZipSession on a 404. FS-handle and backend-
    // path packs rehydrate via handle.getFile() / zip-from-path respectively.
    var rehydrateBlob = handle ? null : file;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var nm = e.path.split('/').pop();
      var displayPath = zipName + '/' + e.path;
      out.push({
        name: nm,
        path: displayPath,
        kind: 'zip',
        index: (typeof e.index === 'number' ? e.index : i),
        zipPath: e.path,
        sessionId: sessionId,
        size: e.size || 0,
        getBlob: null,
        zipFileHandle: handle,
        zipFile: rehydrateBlob
      });
    }
  } catch (e) {
    showMsg('zip error');
    console.warn('addZipBlob failed:', e);
  }
}

function finalizeItems(out) {
  clearObjectURLs();
  if (!out.length) {
    galleryState.items = [];
    galleryState.index = -1;
    updateDirStructure();
    renderThumbnails();
    renderActive(-1);
    return;
  }
  sortItems(out);
  galleryState.items = out;
  galleryState.index = -1;
  updateDirStructure();
  renderThumbnails();
  setActive(0);
}

function appendItems(out) {
  if (!out.length) return;
  sortItems(out);
  galleryState.items = galleryState.items.concat(out);
  updateDirStructure();
  renderThumbnails();
  if (galleryState.index >= 0 && galleryState.index < galleryState.items.length) {
    renderActive(galleryState.index);
  } else if (galleryState.items.length) {
    setActive(0);
  }
  renderTreePanel();
}

function appendVideoItems(outVid) {
  if (!outVid.length) return;
  var hadNoVideos = (galleryState.videoItems.length === 0);
  sortItems(outVid);
  galleryState.videoItems = galleryState.videoItems.concat(outVid);
  updateVideoDirStructure();
  if (hadNoVideos) {
    galleryState.videoIndex = -1;
    if (galleryState.viewMode === 'single' && galleryState.items.length === 0) {
      galleryState.mediaType = 'video';
      updateLayoutMode();
    }
    setVideoActive(0);
  } else {
    renderTreePanel();
  }
}

// ---------- event handlers ---------------------------------------
function onDragOver(e) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}

function onDragEnter(e) {
  e.preventDefault();
  var zone = document.getElementById('gallery-layout');
  if (zone) zone.classList.add('drag-active');
}

function onDragLeave(e) {
  var zone = document.getElementById('gallery-layout');
  if (zone) zone.classList.remove('drag-active');
}

function showPermissionNoticeModal() {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'pg-modal-overlay show';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);opacity:1;pointer-events:auto;';
    
    var modal = document.createElement('div');
    modal.className = 'pg-modal';
    modal.style.cssText = 'background:var(--modal-bg);border:1px solid var(--glass-border);border-radius:var(--radius-lg);padding:24px;width:90%;max-width:440px;box-shadow:0 20px 50px rgba(0,0,0,0.5);color:var(--text);font-family:inherit;text-align:center;';
    
    modal.innerHTML = 
      '<div style="font-size:36px;margin-bottom:12px">📁</div>' +
      '<div style="font-size:16px;font-weight:700;margin-bottom:8px">' + (pgT('File Permission Required') || '需要文件读写权限确认') + '</div>' +
      '<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:20px">' + 
        (pgT('To allow file deletion, renaming, and editing directly within Gallery, browser read/write permission is required. Please click "Allow" in the upcoming browser prompt.') || '为了支持在 Gallery 中对拖入的文件进行重命名、修改与删除，稍后浏览器将在窗口顶部弹出读写授权请求，请点击“允许”。') + 
      '</div>' +
      '<button id="perm-notice-ok-btn" class="pg-btn" style="width:100%;padding:10px 16px;background:var(--accent);color:#fff;border-radius:var(--radius-sm);font-weight:600;cursor:pointer;border:none">' + 
        (pgT('Continue') || '我知道了，继续授权') + 
      '</button>';
      
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    var btn = modal.querySelector('#perm-notice-ok-btn');
    btn.onclick = function() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve();
    };
  });
}

async function onDrop(e) {
  e.preventDefault();
  var zone = document.getElementById('gallery-layout');
  if (zone) zone.classList.remove('drag-active');
  var dt = e.dataTransfer;
  if (!dt || !dt.items) {
    if (dt && dt.files && dt.files.length) {
      processFiles(Array.prototype.slice.call(dt.files));
    }
    return;
  }

  // Modern path: File System Access API (Chrome/Edge 86+)
  // Provides FileSystemFileHandle / FileSystemDirectoryHandle with
  // remove() and createWritable() capabilities.
  if (typeof DataTransferItem.prototype.getAsFileSystemHandle === 'function') {
    // IMPORTANT: getAsFileSystemHandle() must be called synchronously in the
    // same tick — the promise must be collected, not awaited between calls.
    var handlePromises = [];
    for (var i = 0; i < dt.items.length; i++) {
      var item = dt.items[i];
      if (item.kind !== 'file') continue;
      try {
        var p = item.getAsFileSystemHandle();
        if (p) handlePromises.push(p);
      } catch (err) {
        console.warn('getAsFileSystemHandle error:', err);
      }
    }
    if (handlePromises.length) {
      var handles = await Promise.all(handlePromises);
      // Front-load readwrite permission: request on the FIRST handle that
      // needs it only. Chromium shares the grant across handles from the same
      // parent directory, so a single dialog covers all dropped files.
      var _permRequested = false;
      for (var pi = 0; pi < handles.length; pi++) {
        if (!handles[pi] || !handles[pi].requestPermission) continue;
        try {
          var _ps = await handles[pi].queryPermission({ mode: 'readwrite' });
          if (_ps === 'granted') continue;
          if (!_permRequested) {
            await showPermissionNoticeModal();
            await handles[pi].requestPermission({ mode: 'readwrite' });
            _permRequested = true;
          }
        } catch (e) { /* best-effort */ }
      }
      var out = [];
      var outVid = [];
      for (var j = 0; j < handles.length; j++) {
        var h = handles[j];
        if (!h) continue;
        if (h.kind === 'directory') {
          try {
            await walkDir(h, '', out, outVid);
          } catch (err) {
            console.warn('walkDir drop failed:', err);
          }
        } else if (h.kind === 'file') {
          if (isZipName(h.name)) {
            try {
              var ff = await h.getFile();
              await addZipBlob(ff, out, h);
            } catch (err) {
              console.warn('drop zip handle failed:', err);
            }
          } else if (isSupportedExt(h.name)) {
            if (isVideoExt(h.name)) {
              outVid.push({
                name: h.name,
                path: h.name,
                kind: 'fs',
                handle: h,
                rootDirHandle: null, // individual file, no directory context
                getBlob: function(v) { return function() { return v.getFile(); }; }(h),
                size: 0
              });
            } else {
              out.push({
                name: h.name,
                path: h.name,
                kind: 'fs',
                handle: h,
                rootDirHandle: null, // individual file, no directory context
                getBlob: function(v) { return function() { return v.getFile(); }; }(h),
                size: 0
              });
            }
          }
        }
      }
      if (out.length) {
        appendItems(out);
      }
      if (outVid.length) {
        appendVideoItems(outVid);
      }
      return;
    }
  }

  // Fallback: webkitGetAsEntry / getAsFile (no handle — items cannot be
  // deleted from disk; UI will degrade delete/overwrite actions accordingly).
  var promises = [];
  for (var i = 0; i < dt.items.length; i++) {
    var item = dt.items[i];
    if (item.kind !== 'file') continue;
    if (typeof item.webkitGetAsEntry === 'function') {
      var entry = item.webkitGetAsEntry();
      if (entry) {
        promises.push(readEntryRecursive(entry, ''));
        continue;
      }
    }
    var f = item.getAsFile();
    if (f && f.size > 0) {
      if (isZipName(f.name)) promises.push(Promise.resolve([{ kind: 'zipfile', file: f, path: f.name }]));
      else if (isSupportedExt(f.name)) promises.push(Promise.resolve([{ kind: 'plain', file: f, path: f.name }]));
    }
  }

  if (promises.length) {
    Promise.all(promises).then(function(results) {
      var flat = [];
      for (var r = 0; r < results.length; r++) {
        flat = flat.concat(results[r]);
      }
      processCollectedEntries(flat);
    }).catch(function(err) { console.warn('drop parse failed:', err); });
  }
}

async function onPaste(e) {
  // 1. 优先尝试调后端 paste-paths 读取 Windows 系统剪贴板 (CF_HDROP) 路径
  try {
    var cpRes = await fetch('/api/gallery/paste-paths', { method: 'POST' });
    if (cpRes.ok) {
      var cpData = await cpRes.json();
      if (cpData.paths && cpData.paths.length) {
        if (e) e.preventDefault();
        await loadBackendPaths(cpData.paths);
        return;
      }
    }
  } catch (err) {
    console.warn('paste-paths failed, falling back:', err);
  }

  var cd = e.clipboardData;
  if (!cd || !cd.items) return;

  // 2. 检查前端剪贴板中是否有 file 元素或纯文本
  var hasFiles = false;
  for (var fi = 0; fi < cd.items.length; fi++) {
    if (cd.items[fi].kind === 'file' || (cd.items[fi].kind === 'string' && cd.items[fi].type === 'text/plain')) {
      hasFiles = true;
      break;
    }
  }
  if (!hasFiles) return;

  // Fallback: File System Access API (screenshots, non-Windows, etc.)
  // Modern path: File System Access API
  if (typeof DataTransferItem.prototype.getAsFileSystemHandle === 'function') {
    var handlePromises = [];
    for (var i = 0; i < cd.items.length; i++) {
      var it = cd.items[i];
      if (it.kind !== 'file') continue;
      try {
        var p = it.getAsFileSystemHandle();
        if (p) handlePromises.push(p);
      } catch (err) {
        console.warn('getAsFileSystemHandle paste error:', err);
      }
    }
    if (handlePromises.length) {
      var handles = await Promise.all(handlePromises);
      var out = [];
      var outVid = [];
      for (var j = 0; j < handles.length; j++) {
        var h = handles[j];
        if (!h) continue;
        if (h.kind === 'directory') {
          try {
            await walkDir(h, '', out, outVid);
          } catch (err) {
            console.warn('walkDir paste failed:', err);
          }
        } else if (h.kind === 'file') {
          if (isZipName(h.name)) {
            try {
              var ff = await h.getFile();
              await addZipBlob(ff, out, h);
            } catch (err) {
              console.warn('paste zip handle failed:', err);
            }
          } else if (isSupportedExt(h.name)) {
            if (isVideoExt(h.name)) {
              outVid.push({
                name: h.name,
                path: h.name,
                kind: 'fs',
                handle: h,
                rootDirHandle: null, // individual file, no directory context
                getBlob: function(v) { return function() { return v.getFile(); }; }(h),
                size: 0
              });
            } else {
              out.push({
                name: h.name,
                path: h.name,
                kind: 'fs',
                handle: h,
                rootDirHandle: null, // individual file, no directory context
                getBlob: function(v) { return function() { return v.getFile(); }; }(h),
                size: 0
              });
            }
          }
        }
      }
      if (out.length) {
        appendItems(out);
      }
      if (outVid.length) {
        appendVideoItems(outVid);
      }
      e.preventDefault();
      return;
    }
  }

  // Fallback: webkitGetAsEntry / getAsFile (no handle)
  var promises = [];
  for (var i = 0; i < cd.items.length; i++) {
    var it = cd.items[i];
    if (it.kind !== 'file') continue;
    if (typeof it.webkitGetAsEntry === 'function') {
      var entry = it.webkitGetAsEntry();
      if (entry) {
        promises.push(readEntryRecursive(entry, ''));
        continue;
      }
    }
    var blob = it.getAsFile();
    if (blob && blob.size > 0) {
      var nm = blob.name || '';
      if (isZipName(nm)) promises.push(Promise.resolve([{ kind: 'zipfile', file: blob, path: nm }]));
      else if (isSupportedExt(nm) || (blob.type && blob.type.startsWith('image/'))) {
        promises.push(Promise.resolve([{ kind: 'plain', file: blob, path: nm || ('paste' + extOf(blob.type)) }]));
      }
    }
  }
  if (!promises.length) return;
  e.preventDefault();
  Promise.all(promises).then(function(results) {
    var flat = [];
    for (var r = 0; r < results.length; r++) {
      flat = flat.concat(results[r]);
    }
    processCollectedEntries(flat);
  }).catch(function(err) { console.warn('paste parse failed:', err); });
}

function onOpenClick() {
  // Prefer backend native picker (returns absolute paths, zero browser
  // permission dialogs for subsequent disk operations).
  onOpenDirBackend().catch(function(err) {
    console.warn('backend open-dir failed, falling back to FSAA:', err);
    // Fallback: File System Access API (for non-local or unsupported platforms)
    if (typeof window.showDirectoryPicker === 'function') {
      onOpenDir().catch(function(e2) { console.warn('showDirectoryPicker failed:', e2); });
    } else if (typeof window.showOpenFilePicker === 'function') {
      onOpenFiles().catch(function(e2) { console.warn('showOpenFilePicker failed:', e2); });
    } else {
      var input = document.getElementById('gallery-file-input');
      if (input) input.click();
    }
  });
}

// onOpenDirBackend calls the backend native directory picker and loads files
// via the backend file-serving API. Items get kind:'backend' with absolute
// paths — all disk operations (delete/rename) go through the Go backend with
// zero browser permission dialogs.
async function onOpenDirBackend() {
  var res = await fetch('/api/gallery/open-dir', { method: 'POST' });
  if (!res.ok) throw new Error('open-dir http ' + res.status);
  var data = await res.json();
  if (!data.dirPath || !data.files || !data.files.length) return;

  var out = [];
  var outVid = [];
  for (var i = 0; i < data.files.length; i++) {
    var f = data.files[i];
    if (f.kind === 'zip') {
      // Create zip session from disk path (no upload needed)
      try {
        var zRes = await fetch('/api/gallery/zip-from-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: f.path })
        });
        if (!zRes.ok) continue;
        var zData = await zRes.json();
        var manifest = zData.manifest;
        for (var j = 0; j < manifest.entries.length; j++) {
          var e = manifest.entries[j];
          out.push({
            name: e.path.split('/').pop(),
            path: f.rel + '/' + e.path,
            kind: 'zip',
            index: e.index,
            zipPath: e.path,
            sessionId: zData.sessionId,
            size: e.size || 0,
            getBlob: null,
            zipFileHandle: null,
            zipAbsPath: f.path // absolute path for backend writeback/delete
          });
        }
      } catch (e) {
        console.warn('zip-from-path failed:', e);
      }
    } else if (f.kind === 'video') {
      outVid.push({
        name: f.name,
        path: f.rel,
        kind: 'backend',
        absPath: f.path,
        rootDirPath: data.dirPath,
        getBlob: function(p) { return function() {
          return fetch('/api/gallery/file?path=' + encodeURIComponent(p)).then(function(r) {
            if (!r.ok) throw new Error('file http ' + r.status);
            return r.blob();
          });
        }; }(f.path),
        size: f.size
      });
    } else {
      out.push({
        name: f.name,
        path: f.rel,
        kind: 'backend',
        absPath: f.path,
        rootDirPath: data.dirPath,
        getBlob: function(p) { return function() {
          return fetch('/api/gallery/file?path=' + encodeURIComponent(p)).then(function(r) {
            if (!r.ok) throw new Error('file http ' + r.status);
            return r.blob();
          });
        }; }(f.path),
        size: f.size
      });
    }
  }
  if (outVid.length) { appendVideoItems(outVid); }
  if (out.length) { appendItems(out); }
}

// loadBackendPaths loads gallery items from absolute file/directory paths
// loadBackendPaths handles array of absolute local file system paths
// (obtained from clipboard CF_HDROP or other backend sources). Directories
// are expanded via /api/gallery/list-dir; individual files are classified
// by extension.
async function loadBackendPaths(paths) {
  var out = [];
  var outVid = [];
  for (var i = 0; i < paths.length; i++) {
    var p = paths[i];
    var name = p.replace(/[\\\/]/g, '/').split('/').pop();
    var lower = name.toLowerCase();
    var isKnownFile = isSupportedExt(name) || isZipName(name);

    if (!isKnownFile) {
      // 路径不带图片/视频/ZIP后缀时，尝试作为目录调用 list-dir 展开
      try {
        var listRes = await fetch('/api/gallery/list-dir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: p })
        });
        if (listRes.ok) {
          var listData = await listRes.json();
          if (listData.isDir !== false && listData.files && listData.files.length) {
            await processBackendFileList(listData.files, listData.dirPath, out, outVid);
            continue;
          }
        }
      } catch (e) { /* not a directory, fall through to file classification */ }
    }

    // 单个文件分类处理
    if (lower.endsWith('.zip') || isZipName(name)) {
      try {
        var zRes = await fetch('/api/gallery/zip-from-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p })
        });
        if (zRes.ok) {
          var zData = await zRes.json();
          for (var j = 0; j < zData.manifest.entries.length; j++) {
            var ze = zData.manifest.entries[j];
            out.push({
              name: ze.path.split('/').pop(),
              path: name + '/' + ze.path,
              kind: 'zip', index: ze.index, zipPath: ze.path,
              sessionId: zData.sessionId, size: ze.size || 0,
              getBlob: null, zipFileHandle: null, zipAbsPath: p
            });
          }
        }
      } catch (e) { console.warn('paste zip-from-path failed:', e); }
    } else if (isSupportedExt(name)) {
      var item = {
        name: name, path: name, kind: 'backend', absPath: p,
        rootDirPath: null,
        getBlob: function(ap) { return function() {
          return fetch('/api/gallery/file?path=' + encodeURIComponent(ap)).then(function(r) {
            if (!r.ok) throw new Error('file http ' + r.status);
            return r.blob();
          });
        }; }(p),
        size: 0
      };
      if (isVideoExt(name)) { outVid.push(item); } else { out.push(item); }
    }
  }
  if (outVid.length) { appendVideoItems(outVid); }
  if (out.length) { appendItems(out); }
}

// processBackendFileList converts a backend file listing into gallery items.
async function processBackendFileList(files, dirPath, out, outVid) {
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f.kind === 'zip') {
      try {
        var zRes = await fetch('/api/gallery/zip-from-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: f.path })
        });
        if (!zRes.ok) continue;
        var zData = await zRes.json();
        for (var j = 0; j < zData.manifest.entries.length; j++) {
          var e = zData.manifest.entries[j];
          out.push({
            name: e.path.split('/').pop(),
            path: f.rel + '/' + e.path,
            kind: 'zip', index: e.index, zipPath: e.path,
            sessionId: zData.sessionId, size: e.size || 0,
            getBlob: null, zipFileHandle: null, zipAbsPath: f.path
          });
        }
      } catch (e) { console.warn('zip-from-path failed:', e); }
    } else if (f.kind === 'video') {
      outVid.push({
        name: f.name, path: f.rel, kind: 'backend', absPath: f.path,
        rootDirPath: dirPath,
        getBlob: function(p) { return function() {
          return fetch('/api/gallery/file?path=' + encodeURIComponent(p)).then(function(r) {
            if (!r.ok) throw new Error('file http ' + r.status);
            return r.blob();
          });
        }; }(f.path),
        size: f.size
      });
    } else {
      out.push({
        name: f.name, path: f.rel, kind: 'backend', absPath: f.path,
        rootDirPath: dirPath,
        getBlob: function(p) { return function() {
          return fetch('/api/gallery/file?path=' + encodeURIComponent(p)).then(function(r) {
            if (!r.ok) throw new Error('file http ' + r.status);
            return r.blob();
          });
        }; }(f.path),
        size: f.size
      });
    }
  }
}

async function onOpenDir() {
  var dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  var out = [];
  var outVid = [];
  await walkDir(dirHandle, '', out, outVid);
  if (outVid.length) { appendVideoItems(outVid); }
  appendItems(out);
}

async function onOpenFiles() {
  var handles = await window.showOpenFilePicker({ multiple: true, mode: 'readwrite' });
  var fsHandles = [];
  var blobs = [];
  for (var i = 0; i < handles.length; i++) {
    var h = handles[i];
    if (h.kind === 'directory') {
      await walkDir(h.handle, '', fsHandles);
    } else {
      if (isZipName(h.name)) blobs.push({ kind: 'ziphandle', handle: h });
      else fsHandles.push({ kind: 'file', handle: h });
    }
  }
  await processHandles(fsHandles, blobs);
}