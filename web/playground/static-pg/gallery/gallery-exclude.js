// gallery-exclude.js — Hash-based image exclusion (excludehash.txt + config.yaml).
// Loaded after gallery-tree.js. Classic global declarations (no IIFE).

'use strict';

var _excludeLoadPromise = null;
var _excludeCheckInFlight = {}; // dirKey -> { sig: string, promise: Promise }

function _excludeDefaultConfig() {
  return { enabled: true, scope: 'tail', count: 10 };
}

function _excludeNormalizeConfig(raw) {
  var def = _excludeDefaultConfig();
  if (!raw || typeof raw !== 'object') return def;
  var scope = String(raw.scope || def.scope).toLowerCase().trim();
  if (scope !== 'all' && scope !== 'head' && scope !== 'tail') scope = def.scope;
  var count = parseInt(raw.count, 10);
  if (isNaN(count) || count <= 0) count = def.count;
  if (count > 100000) count = 100000;
  return {
    enabled: raw.enabled === undefined ? def.enabled : !!raw.enabled,
    scope: scope,
    count: count
  };
}

function _ensureExcludeState() {
  if (!galleryState.exclude) {
    galleryState.exclude = {
      loaded: false,
      config: _excludeDefaultConfig(),
      count: 0,
      sizes: {},
      hasUnsized: false,
      version: 0,
      checkedPacks: {},
      inFlightAction: false
    };
  }
  return galleryState.exclude;
}

function _applyExcludeSizesSummary(ex, data) {
  ex.count = Number(data && data.count) || 0;
  ex.hasUnsized = !!(data && data.hasUnsized);
  var map = {};
  var sizes = (data && Array.isArray(data.sizes)) ? data.sizes : [];
  for (var i = 0; i < sizes.length; i++) {
    map[String(sizes[i])] = true;
  }
  ex.sizes = map;
}

function loadExcludeHashState(force) {
  var ex = _ensureExcludeState();
  if (_excludeLoadPromise && !force) return _excludeLoadPromise;
  var p = fetch('/api/gallery/exclude-hashes')
    .then(function(r) {
      if (!r.ok) throw new Error('exclude-hashes http ' + r.status);
      return r.json();
    })
    .then(function(data) {
      var prevCfg = ex.config || _excludeDefaultConfig();
      var nextCfg = _excludeNormalizeConfig(data && data.config);
      var scopeChanged = prevCfg.scope !== nextCfg.scope || prevCfg.count !== nextCfg.count;
      var enabledChanged = prevCfg.enabled !== nextCfg.enabled;
      ex.config = nextCfg;
      _applyExcludeSizesSummary(ex, data);
      ex.loaded = true;
      if (typeof window !== 'undefined' && window.__settings) {
        window.__settings.galleryExclude = Object.assign({}, nextCfg);
      }
      if (scopeChanged) {
        ex.checkedPacks = {};
        _clearItemExcludeMarks();
      }
      _updateExcludeTreeBtnUI();
      if (enabledChanged || scopeChanged) {
        applyExcludeProjection();
      }
      if (galleryState.items && galleryState.items.length && galleryState.index >= 0) {
        var cur = galleryState.items[galleryState.index];
        if (cur && typeof getDirPath === 'function') {
          checkExcludeForDir(getDirPath(cur.path));
        }
      }
      return ex;
    })
    .catch(function(err) {
      console.warn('loadExcludeHashState failed:', err);
      ex.loaded = true;
      return ex;
    })
    .finally(function() {
      if (_excludeLoadPromise === p) _excludeLoadPromise = null;
    });
  _excludeLoadPromise = p;
  return p;
}

async function saveExcludeConfig(patch) {
  var ex = _ensureExcludeState();
  var prev = ex.config || _excludeDefaultConfig();
  var merged = _excludeNormalizeConfig(Object.assign({}, prev, patch || {}));
  var payload = {};
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'enabled')) payload.enabled = merged.enabled;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'scope')) payload.scope = merged.scope;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'count')) payload.count = merged.count;

  if (typeof apiPatch === 'function') {
    await apiPatch('/settings', { galleryExclude: payload });
  } else {
    var r = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ galleryExclude: payload })
    });
    if (!r.ok) {
      var errMsg = 'HTTP ' + r.status;
      try {
        var ed = await r.json();
        if (ed && ed.error) errMsg = ed.error;
      } catch (e2) {}
      throw new Error(errMsg);
    }
  }

  var scopeChanged = prev.scope !== merged.scope || prev.count !== merged.count;
  ex.config = merged;
  ex.loaded = true;
  if (typeof window !== 'undefined' && window.__settings) {
    window.__settings.galleryExclude = Object.assign({}, merged);
  }
  if (scopeChanged) {
    ex.checkedPacks = {};
    _clearItemExcludeMarks();
  }
  _updateExcludeTreeBtnUI();
  applyExcludeProjection();
  await ensureCurrentPackExcludeChecked();
  return merged;
}

function _clearItemExcludeMarks() {
  var raw = galleryState.rawItems || [];
  for (var i = 0; i < raw.length; i++) {
    if (raw[i]) {
      raw[i]._excludedByHash = false;
      raw[i]._excludedHash = '';
    }
  }
}

// ---------- rawItems synchronization helpers -------------------------
function _projectVisibleItemsFromRaw() {
  var ex = _ensureExcludeState();
  var raw = galleryState.rawItems || [];
  if (ex.config && ex.config.enabled) {
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] && !raw[i]._excludedByHash) out.push(raw[i]);
    }
    return out;
  }
  return raw.slice();
}

function syncRawItemsReplace(list) {
  var ex = _ensureExcludeState();
  galleryState.rawItems = Array.isArray(list) ? list.slice() : [];
  ex.checkedPacks = {};
  _excludeCheckInFlight = {};
  return _projectVisibleItemsFromRaw();
}

function syncRawItemsAppend(list) {
  if (!Array.isArray(list) || !list.length) return _projectVisibleItemsFromRaw();
  var ex = _ensureExcludeState();
  if (!galleryState.rawItems) galleryState.rawItems = [];
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (!it) continue;
    galleryState.rawItems.push(it);
    if (typeof getDirPath === 'function') {
      var dk = getDirPath(it.path);
      delete ex.checkedPacks[dk];
      delete _excludeCheckInFlight[dk];
    }
  }
  return _projectVisibleItemsFromRaw();
}

function syncRawItemsRemove(removedList) {
  if (!removedList || !removedList.length || !galleryState.rawItems) return;
  var ex = _ensureExcludeState();
  var kept = [];
  for (var i = 0; i < galleryState.rawItems.length; i++) {
    var it = galleryState.rawItems[i];
    if (removedList.indexOf(it) < 0) kept.push(it);
    else if (typeof getDirPath === 'function') {
      delete ex.checkedPacks[getDirPath(it.path)];
    }
  }
  galleryState.rawItems = kept;
}

function syncRawItemsRemoveByPredicate(pred) {
  if (typeof pred !== 'function' || !galleryState.rawItems || !galleryState.rawItems.length) return;
  var ex = _ensureExcludeState();
  var kept = [];
  for (var i = 0; i < galleryState.rawItems.length; i++) {
    var it = galleryState.rawItems[i];
    if (pred(it)) {
      if (it) {
        if (it.mainURL && String(it.mainURL).indexOf('blob:') === 0 && typeof FsApi !== 'undefined') FsApi.BlobTracker.revoke(it.mainURL);
        if (it.thumbURL && String(it.thumbURL).indexOf('blob:') === 0 && typeof FsApi !== 'undefined') FsApi.BlobTracker.revoke(it.thumbURL);
        if (typeof getDirPath === 'function') delete ex.checkedPacks[getDirPath(it.path)];
      }
    } else {
      kept.push(it);
    }
  }
  galleryState.rawItems = kept;
}

function syncRawItemsClear() {
  var ex = _ensureExcludeState();
  galleryState.rawItems = [];
  ex.checkedPacks = {};
  _excludeCheckInFlight = {};
}

// ---------- natural-order pack slicing -------------------------------
function getPackItemsNatural(dirKey) {
  var raw = (galleryState.rawItems && galleryState.rawItems.length) ? galleryState.rawItems : (galleryState.items || []);
  var list = [];
  for (var i = 0; i < raw.length; i++) {
    var it = raw[i];
    if (!it) continue;
    if (getDirPath(it.path) === dirKey) list.push(it);
  }
  list.sort(function(a, b) {
    return naturalComparePath(a.path, b.path);
  });
  return list;
}

function getPackExcludeSlice(dirKey, cfgOverride) {
  var ex = _ensureExcludeState();
  var cfg = _excludeNormalizeConfig(cfgOverride || ex.config);
  var ordered = getPackItemsNatural(dirKey);
  if (!ordered.length) return [];
  if (cfg.scope === 'all') return ordered;
  var n = cfg.count || 10;
  if (n >= ordered.length) return ordered;
  if (cfg.scope === 'head') return ordered.slice(0, n);
  return ordered.slice(ordered.length - n);
}

// ---------- client-side SHA-256 helper for fs/plain items ------------
async function _sha256HexFromBlob(blob) {
  if (!blob) return '';
  if (typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.subtle.digest !== 'function') {
    throw new Error('WebCrypto SHA-256 unavailable');
  }
  var buf = await blob.arrayBuffer();
  var digest = await crypto.subtle.digest('SHA-256', buf);
  var bytes = new Uint8Array(digest);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = bytes[i].toString(16);
    hex += (h.length === 1 ? '0' + h : h);
  }
  return hex;
}

// ---------- pack-level lazy hash check -------------------------------
async function checkExcludeForDir(dirKey) {
  if (dirKey === undefined || dirKey === null) return;
  var ex = _ensureExcludeState();
  if (!ex.loaded) {
    await loadExcludeHashState(false);
  }
  var ordered = getPackItemsNatural(dirKey);
  if (!ordered.length) return;

  var cfg = _excludeNormalizeConfig(ex.config);
  var sig = dirKey + '|' + cfg.scope + '|' + cfg.count + '|' + ordered.length + '|' + ex.version;
  if (ex.checkedPacks[dirKey] && ex.checkedPacks[dirKey].sig === sig) {
    return;
  }
  if (_excludeCheckInFlight[dirKey] && _excludeCheckInFlight[dirKey].sig === sig) {
    return _excludeCheckInFlight[dirKey].promise;
  }

  var p = (async function() {
    try {
      if (ex.count === 0) {
        for (var c = 0; c < ordered.length; c++) {
          ordered[c]._excludedByHash = false;
          ordered[c]._excludedHash = '';
        }
        ex.checkedPacks[dirKey] = { sig: sig };
        return;
      }

      var target = getPackExcludeSlice(dirKey, cfg);
      // Clear previous marks across this pack before applying new slice results.
      for (var m = 0; m < ordered.length; m++) {
        ordered[m]._excludedByHash = false;
        ordered[m]._excludedHash = '';
      }

      var zipSrcGroups = {};  // sourceId -> { byPath: {} }
      var zipSessGroups = {}; // sessionId -> { byPath: {} }
      var grantGroups = {};   // grantId -> { byRel: {} }
      var localItems = [];

      for (var i = 0; i < target.length; i++) {
        var it = target[i];
        if (!it) continue;
        if (it.kind === 'zip') {
          var zp = it.zipPath || it.entryPath || '';
          if (!zp) continue;
          if (it.sourceId) {
            if (!zipSrcGroups[it.sourceId]) zipSrcGroups[it.sourceId] = { byPath: {}, entries: [] };
            if (!zipSrcGroups[it.sourceId].byPath[zp]) {
              zipSrcGroups[it.sourceId].byPath[zp] = [];
              zipSrcGroups[it.sourceId].entries.push(zp);
            }
            zipSrcGroups[it.sourceId].byPath[zp].push(it);
          } else if (it.sessionId) {
            if (!zipSessGroups[it.sessionId]) zipSessGroups[it.sessionId] = { byPath: {}, entries: [], sample: it };
            if (!zipSessGroups[it.sessionId].byPath[zp]) {
              zipSessGroups[it.sessionId].byPath[zp] = [];
              zipSessGroups[it.sessionId].entries.push(zp);
            }
            zipSessGroups[it.sessionId].byPath[zp].push(it);
          }
        } else if (it.kind === 'backend' && it.grantId) {
          var rel = it.rel || '';
          if (!grantGroups[it.grantId]) grantGroups[it.grantId] = { byRel: {}, rels: [] };
          if (!grantGroups[it.grantId].byRel[rel]) {
            grantGroups[it.grantId].byRel[rel] = [];
            grantGroups[it.grantId].rels.push(rel);
          }
          grantGroups[it.grantId].byRel[rel].push(it);
        } else {
          localItems.push(it);
        }
      }

      var anyMatched = false;

      async function _postCheck(body) {
        var res = await fetch('/api/gallery/exclude-hashes/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) return null;
        return res.json();
      }

      for (var srcId in zipSrcGroups) {
        if (!Object.prototype.hasOwnProperty.call(zipSrcGroups, srcId)) continue;
        var sg = zipSrcGroups[srcId];
        var sData = await _postCheck({ sourceId: srcId, entries: sg.entries });
        if (sData && Array.isArray(sData.matched)) {
          for (var si = 0; si < sData.matched.length; si++) {
            var ep = sData.matched[si];
            var shaS = (sData.matchedHashes && sData.matchedHashes[ep]) || '';
            var listS = sg.byPath[ep] || [];
            for (var sl = 0; sl < listS.length; sl++) {
              listS[sl]._excludedByHash = true;
              listS[sl]._excludedHash = shaS;
              anyMatched = true;
            }
          }
        }
      }

      for (var sid in zipSessGroups) {
        if (!Object.prototype.hasOwnProperty.call(zipSessGroups, sid)) continue;
        var zg = zipSessGroups[sid];
        var zRes = await fetch('/api/gallery/exclude-hashes/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, entries: zg.entries })
        });
        var zData = null;
        if (zRes.status === 404 && zg.sample && typeof rehydrateZipSession === 'function') {
          var freshSid = await rehydrateZipSession(zg.sample);
          if (freshSid) {
            zData = await _postCheck({ sessionId: freshSid, entries: zg.entries });
          }
        } else if (zRes.ok) {
          zData = await zRes.json();
        }
        if (zData && Array.isArray(zData.matched)) {
          for (var zi = 0; zi < zData.matched.length; zi++) {
            var zp2 = zData.matched[zi];
            var shaZ = (zData.matchedHashes && zData.matchedHashes[zp2]) || '';
            var listZ = zg.byPath[zp2] || [];
            for (var zl = 0; zl < listZ.length; zl++) {
              listZ[zl]._excludedByHash = true;
              listZ[zl]._excludedHash = shaZ;
              anyMatched = true;
            }
          }
        }
      }

      for (var gid in grantGroups) {
        if (!Object.prototype.hasOwnProperty.call(grantGroups, gid)) continue;
        var gg = grantGroups[gid];
        var gData = await _postCheck({ grantId: gid, rels: gg.rels });
        if (gData && Array.isArray(gData.matched)) {
          for (var gi = 0; gi < gData.matched.length; gi++) {
            var rel2 = gData.matched[gi];
            var shaG = (gData.matchedHashes && gData.matchedHashes[rel2]) || '';
            var listG = gg.byRel[rel2] || [];
            for (var gl = 0; gl < listG.length; gl++) {
              listG[gl]._excludedByHash = true;
              listG[gl]._excludedHash = shaG;
              anyMatched = true;
            }
          }
        }
      }

      if (localItems.length) {
        var candidatesByHash = {};
        var hashesToCheck = [];
        for (var li = 0; li < localItems.length; li++) {
          var lit = localItems[li];
          var fObj = null;
          try {
            if (lit.file) fObj = lit.file;
            else if (typeof getItemBlob === 'function') fObj = await getItemBlob(lit);
          } catch (e) { fObj = null; }
          if (!fObj) continue;
          if (typeof fObj.size === 'number' && fObj.size > 0) lit.size = fObj.size;
          if (!ex.hasUnsized && fObj.size > 0 && !ex.sizes[String(fObj.size)]) {
            continue;
          }
          try {
            var hHex = await _sha256HexFromBlob(fObj);
            if (!hHex) continue;
            if (!candidatesByHash[hHex]) {
              candidatesByHash[hHex] = [];
              hashesToCheck.push(hHex);
            }
            candidatesByHash[hHex].push(lit);
          } catch (e2) {}
        }
        if (hashesToCheck.length) {
          var lData = await _postCheck({ hashes: hashesToCheck });
          if (lData && Array.isArray(lData.matched)) {
            for (var lm = 0; lm < lData.matched.length; lm++) {
              var mh = lData.matched[lm];
              var targets = candidatesByHash[mh] || [];
              for (var lt = 0; lt < targets.length; lt++) {
                targets[lt]._excludedByHash = true;
                targets[lt]._excludedHash = mh;
                anyMatched = true;
              }
            }
          }
        }
      }

      ex.checkedPacks[dirKey] = { sig: sig };
      if (anyMatched || !ex.config.enabled) {
        applyExcludeProjection();
      }
    } catch (err) {
      console.warn('checkExcludeForDir failed:', err);
    } finally {
      if (_excludeCheckInFlight[dirKey] && _excludeCheckInFlight[dirKey].sig === sig) {
        delete _excludeCheckInFlight[dirKey];
      }
    }
  })();

  _excludeCheckInFlight[dirKey] = { sig: sig, promise: p };
  return p;
}

function ensureCurrentPackExcludeChecked() {
  if (!galleryState.items || !galleryState.items.length || galleryState.index < 0) return Promise.resolve();
  var cur = galleryState.items[galleryState.index];
  if (!cur || typeof getDirPath !== 'function') return Promise.resolve();
  return checkExcludeForDir(getDirPath(cur.path));
}

// ---------- non-destructive visible list projection ------------------
function applyExcludeProjection() {
  var ex = _ensureExcludeState();
  var raw = galleryState.rawItems || [];
  if (!raw.length && galleryState.items && galleryState.items.length) {
    galleryState.rawItems = galleryState.items.slice();
    raw = galleryState.rawItems;
  }

  var curItem = (galleryState.index >= 0 && galleryState.index < galleryState.items.length)
    ? galleryState.items[galleryState.index] : null;
  var oldIdx = galleryState.index;

  var next = _projectVisibleItemsFromRaw();
  if (typeof sortItems === 'function') sortItems(next);
  galleryState.items = next;

  var newIdx = -1;
  var curSurvived = false;
  if (curItem) {
    for (var i = 0; i < next.length; i++) {
      if (next[i] === curItem) {
        newIdx = i;
        curSurvived = true;
        break;
      }
    }
  }
  if (!curSurvived && next.length > 0) {
    newIdx = Math.max(0, Math.min(oldIdx >= 0 ? oldIdx : 0, next.length - 1));
  }
  galleryState.index = newIdx;

  if (typeof updateDirStructure === 'function') updateDirStructure();
  if (typeof updateCurrentFolderItems === 'function') updateCurrentFolderItems(newIdx);
  if (typeof renderThumbnails === 'function') renderThumbnails();
  if (typeof renderTreePanel === 'function') renderTreePanel();

  if (next.length === 0) {
    if (typeof renderActive === 'function') renderActive(-1);
  } else if (!curSurvived) {
    if (typeof renderActive === 'function') renderActive(newIdx);
  } else {
    // Surviving item stays on screen without reloading image bytes: refresh count & indicator.
    var info = document.getElementById('gallery-info');
    if (info) {
      var subIdx = (galleryState.currentSubIndex >= 0) ? (galleryState.currentSubIndex + 1) : 0;
      var totalFolder = galleryState.currentFolderIndices ? galleryState.currentFolderIndices.length : 0;
      var countStr = subIdx + ' / ' + totalFolder;
      var prevText = info.textContent || '';
      var pipePos = prevText.indexOf('|');
      info.textContent = pipePos >= 0 ? (countStr + ' ' + prevText.slice(pipePos)) : countStr;
    }
    updateExcludeIndicator(curItem);
  }
}

// ---------- item fingerprint payload & shortcut actions --------------
async function _buildItemExcludePayload(item) {
  if (!item) return null;
  if (item.kind === 'zip') {
    var zp = item.zipPath || item.entryPath || '';
    if (item.sourceId && zp) {
      return { sourceId: item.sourceId, entryPath: zp, name: item.name || '' };
    }
    if (item.sessionId && zp) {
      return { sessionId: item.sessionId, zipPath: zp, name: item.name || '' };
    }
  }
  if (item.kind === 'backend' && item.grantId) {
    return { grantId: item.grantId, rel: item.rel || '', name: item.name || '' };
  }
  var blob = null;
  if (item.file) blob = item.file;
  else if (typeof getItemBlob === 'function') blob = await getItemBlob(item);
  if (!blob) return null;
  var sha = await _sha256HexFromBlob(blob);
  return {
    sha256: sha,
    size: typeof blob.size === 'number' ? blob.size : 0,
    name: item.name || ''
  };
}

function _isVideoFocusActive() {
  return (galleryState.viewMode === 'split') ? (galleryState.focus === 'video') : (galleryState.mediaType === 'video');
}

async function toggleGalleryExclude() {
  var ex = _ensureExcludeState();
  if (ex.inFlightAction) return;
  ex.inFlightAction = true;
  try {
    if (!ex.loaded) await loadExcludeHashState(false);
    var nextEnabled = !(ex.config && ex.config.enabled);
    await saveExcludeConfig({ enabled: nextEnabled });
    showMsg(nextEnabled ? T('galleryExcludeToggleOn') : T('galleryExcludeToggleOff'));
  } catch (err) {
    showMsg(T('galleryExcludeError', [err && err.message ? err.message : String(err)]));
  } finally {
    ex.inFlightAction = false;
  }
}

async function excludeCurrentImage() {
  if (_isVideoFocusActive()) return;
  var ex = _ensureExcludeState();
  if (ex.inFlightAction) return;
  if (!galleryState.items || !galleryState.items.length || galleryState.index < 0) {
    showMsg(T('galleryExcludeNoImage'));
    return;
  }
  var item = galleryState.items[galleryState.index];
  if (!item) return;

  ex.inFlightAction = true;
  try {
    var payload = await _buildItemExcludePayload(item);
    if (!payload) {
      showMsg(T('galleryExcludeError', ['unreadable image']));
      return;
    }
    var res = await fetch('/api/gallery/exclude-hashes/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.status === 404 && item.kind === 'zip' && typeof getItemBlob === 'function') {
      // Session/source evicted fallback: hash blob directly.
      var blob = await getItemBlob(item);
      if (blob) {
        var shaFallback = await _sha256HexFromBlob(blob);
        res = await fetch('/api/gallery/exclude-hashes/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha256: shaFallback, size: blob.size || 0, name: item.name || '' })
        });
      }
    }
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

    ex.count = Number(data.count) || ex.count;
    if (data.size && data.size > 0) ex.sizes[String(data.size)] = true;
    else ex.hasUnsized = true;
    ex.version++;
    ex.checkedPacks = {};

    var hash = data.hash || '';
    item._excludedByHash = true;
    item._excludedHash = hash;
    var raw = galleryState.rawItems || [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] && hash && raw[i]._excludedHash === hash) {
        raw[i]._excludedByHash = true;
      }
    }

    if (data.duplicate) {
      showMsg(T('galleryExcludeDuplicate'));
    } else {
      showMsg(T('galleryExcludeAdded', [String(ex.count)]));
    }

    if (ex.config && ex.config.enabled) {
      applyExcludeProjection();
    } else {
      if (typeof renderThumbnails === 'function') renderThumbnails();
      updateExcludeIndicator(item);
    }
    _updateExcludeTreeBtnUI();
  } catch (err) {
    showMsg(T('galleryExcludeError', [err && err.message ? err.message : String(err)]));
  } finally {
    ex.inFlightAction = false;
  }
}

async function unexcludeCurrentImage() {
  if (_isVideoFocusActive()) return;
  var ex = _ensureExcludeState();
  if (ex.inFlightAction) return;
  if (!galleryState.items || !galleryState.items.length || galleryState.index < 0) {
    showMsg(T('galleryExcludeNoImage'));
    return;
  }
  var item = galleryState.items[galleryState.index];
  if (!item) return;

  ex.inFlightAction = true;
  try {
    var payload = item._excludedHash
      ? { sha256: item._excludedHash }
      : await _buildItemExcludePayload(item);
    if (!payload) {
      showMsg(T('galleryExcludeError', ['unreadable image']));
      return;
    }
    var res = await fetch('/api/gallery/exclude-hashes/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.status === 404 && item.kind === 'zip' && typeof getItemBlob === 'function') {
      var blob = await getItemBlob(item);
      if (blob) {
        var shaFallback = await _sha256HexFromBlob(blob);
        res = await fetch('/api/gallery/exclude-hashes/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha256: shaFallback })
        });
      }
    }
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

    if (data.removed) {
      var removedHash = data.hash || '';
      ex.count = Number(data.count) || 0;
      ex.version++;
      ex.checkedPacks = {};
      item._excludedByHash = false;
      item._excludedHash = '';
      var raw = galleryState.rawItems || [];
      for (var i = 0; i < raw.length; i++) {
        if (raw[i] && removedHash && raw[i]._excludedHash === removedHash) {
          raw[i]._excludedByHash = false;
          raw[i]._excludedHash = '';
        }
      }
      await loadExcludeHashState(true);
      if (typeof renderThumbnails === 'function') renderThumbnails();
      updateExcludeIndicator(item);
      _updateExcludeTreeBtnUI();
      showMsg(T('galleryExcludeRemoved', [String(ex.count)]));
    } else {
      showMsg(T('galleryExcludeNotFound'));
    }
  } catch (err) {
    showMsg(T('galleryExcludeError', [err && err.message ? err.message : String(err)]));
  } finally {
    ex.inFlightAction = false;
  }
}

// ---------- UI indicators & modal ------------------------------------
function updateExcludeIndicator(item) {
  var el = document.getElementById('gallery-exclude-indicator');
  if (!el) return;
  var ex = _ensureExcludeState();
  var show = !!(ex.config && !ex.config.enabled && item && item._excludedByHash);
  if (show) {
    var keyStr = 'Alt+P';
    if (typeof Shortcuts !== 'undefined' && typeof Shortcuts.effective === 'function') {
      keyStr = Shortcuts.formatBinding(Shortcuts.effective('gallery.unexclude-hash')) || keyStr;
    }
    el.textContent = T('galleryExcludeIndicator', [keyStr]);
    el.classList.add('active');
  } else {
    el.textContent = '';
    el.classList.remove('active');
  }
}

function getExcludeButtonTooltip() {
  var ex = _ensureExcludeState();
  var cfg = _excludeNormalizeConfig(ex.config);
  var status = cfg.enabled ? T('galleryExcludeToggleOn') : T('galleryExcludeToggleOff');
  var scopeText = cfg.scope === 'all'
    ? T('galleryExcludeScopeAll')
    : ((cfg.scope === 'head' ? T('galleryExcludeScopeHead') : T('galleryExcludeScopeTail')) + ' ' + cfg.count);
  return status + ' (' + scopeText + ' · ' + T('galleryExcludeRecorded', [String(ex.count || 0)]) + ')';
}

function _updateExcludeTreeBtnUI() {
  var btn = document.getElementById('gallery-exclude-btn');
  if (!btn) return;
  var ex = _ensureExcludeState();
  btn.classList.toggle('active', !!(ex.config && ex.config.enabled));
  btn.setAttribute('data-tooltip', getExcludeButtonTooltip());
}

function openGalleryExcludeModal() {
  var ex = _ensureExcludeState();
  var cfg = _excludeNormalizeConfig(ex.config);

  var fmtKey = function(actionId, fallback) {
    if (typeof Shortcuts !== 'undefined' && typeof Shortcuts.effective === 'function') {
      return Shortcuts.formatBinding(Shortcuts.effective(actionId)) || fallback;
    }
    return fallback;
  };
  var kEx = fmtKey('gallery.exclude-hash', 'P');
  var kUnex = fmtKey('gallery.unexclude-hash', 'Alt+P');
  var kTog = fmtKey('gallery.toggle-exclude', 'Ctrl+Alt+P');

  var html =
    '<div class="pg-modal-header">' +
      '<span class="pg-modal-title">' + escapeHtml(T('galleryExcludeTitle')) + '</span>' +
      '<button type="button" class="pg-modal-close" id="gex-close-btn">✕</button>' +
    '</div>' +
    '<div class="pg-modal-body">' +
      '<div class="gex-modal">' +
        '<div class="gex-row">' +
          '<span class="gex-label">' + escapeHtml(T('galleryExcludeEnable')) + '</span>' +
          '<label class="toggle-switch"><input type="checkbox" id="gex-enabled-chk"' + (cfg.enabled ? ' checked' : '') + '><span class="toggle-slider"></span></label>' +
        '</div>' +
        '<div>' +
          '<div class="gex-label" style="margin-bottom:6px">' + escapeHtml(T('galleryExcludeScope')) + '</div>' +
          '<div class="gex-scope-opts">' +
            '<label class="gex-scope-opt"><input type="radio" name="gex-scope" value="tail"' + (cfg.scope === 'tail' ? ' checked' : '') + '><span>' + escapeHtml(T('galleryExcludeScopeTail')) + '</span></label>' +
            '<label class="gex-scope-opt"><input type="radio" name="gex-scope" value="head"' + (cfg.scope === 'head' ? ' checked' : '') + '><span>' + escapeHtml(T('galleryExcludeScopeHead')) + '</span></label>' +
            '<label class="gex-scope-opt"><input type="radio" name="gex-scope" value="all"' + (cfg.scope === 'all' ? ' checked' : '') + '><span>' + escapeHtml(T('galleryExcludeScopeAll')) + '</span></label>' +
          '</div>' +
        '</div>' +
        '<div class="gex-row" id="gex-count-row">' +
          '<span class="gex-label">' + escapeHtml(T('galleryExcludeCount')) + '</span>' +
          '<input type="number" id="gex-count-input" class="gex-count-input" min="1" max="100000" value="' + escapeHtml(String(cfg.count)) + '"' + (cfg.scope === 'all' ? ' disabled' : '') + '>' +
        '</div>' +
        '<div class="gex-hint">' +
          '<div>' + escapeHtml(T('galleryExcludeRecorded', [String(ex.count || 0)])) + '</div>' +
          '<div style="margin-top:4px">' + escapeHtml(T('galleryExcludeShortcuts', [kEx, kUnex, kTog])) + '</div>' +
        '</div>' +
        '<div class="gex-footer">' +
          '<button type="button" class="pg-btn" id="gex-cancel-btn">' + escapeHtml(T('cancel') || 'Cancel') + '</button>' +
          '<button type="button" class="pg-btn btn-primary" id="gex-save-btn">' + escapeHtml(T('save') || 'Save') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  pgShowModal(html);

  var closeBtn = document.getElementById('gex-close-btn');
  var cancelBtn = document.getElementById('gex-cancel-btn');
  var saveBtn = document.getElementById('gex-save-btn');
  var countInput = document.getElementById('gex-count-input');
  var scopeRadios = document.querySelectorAll('input[name="gex-scope"]');

  if (closeBtn) closeBtn.onclick = function() { pgCloseModal(); };
  if (cancelBtn) cancelBtn.onclick = function() { pgCloseModal(); };
  scopeRadios.forEach(function(r) {
    r.addEventListener('change', function() {
      if (countInput) countInput.disabled = (this.value === 'all' && this.checked);
    });
  });

  if (saveBtn) {
    saveBtn.onclick = async function() {
      var chk = document.getElementById('gex-enabled-chk');
      var selScopeEl = document.querySelector('input[name="gex-scope"]:checked');
      var nextEnabled = chk ? !!chk.checked : true;
      var nextScope = selScopeEl ? selScopeEl.value : 'tail';
      var nextCount = countInput ? parseInt(countInput.value, 10) : 10;
      if (isNaN(nextCount) || nextCount < 1) nextCount = 1;
      if (nextCount > 100000) nextCount = 100000;
      saveBtn.disabled = true;
      try {
        await saveExcludeConfig({ enabled: nextEnabled, scope: nextScope, count: nextCount });
        pgCloseModal();
        showMsg(T('galleryExcludeSaved'));
      } catch (err) {
        saveBtn.disabled = false;
        showMsg(T('galleryExcludeError', [err && err.message ? err.message : String(err)]));
      }
    };
  }
}
