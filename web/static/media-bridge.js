// web/static/media-bridge.js
// MediaBridge — the single sanctioned handoff channel between media producers
// (GIF editor exports, Download "Play", future Archive pack outputs) and the
// Gallery consumer.
//
// Contract (archive_compatibility_plan.md §9.2, frozen 2026-08-06):
//   register(asset)      -> Promise<assetId>   short-term assetId + display
//                                              metadata; never a permanent
//                                              copy of large blobs
//   openGallery(assetId | assetId[])           switch to Gallery and import
//                                              through Gallery's own entry
//                                              point; never writes
//                                              galleryState from here
//   consume(assetId | assetId[])               release the bridge-side token
//                                              (blob refs / URL refs); server
//                                              copies are left to server TTL
//
// Rules:
//   - No absolute filesystem paths ever cross this bridge. Producers hand a
//     Blob, a controlled server URL (/api/downloads/{id}/file,
//     /api/gallery/file?path=...), or nothing but metadata.
//   - galleryState is only ever mutated by Gallery code (gallery-io.js
//     galleryImportAssets); MediaBridge hands over plain metadata objects.
//   - Tokens survive page switches and cleanups until consumed, explicitly
//     released, or the TTL expires; the pending-import queue survives
//     cleanupGallery so switching away and back still delivers.
//   - When the Archive API (/api/archive/status + /api/archive/assets) is
//     present, blob registrations are mirrored server-side and the server
//     assetId becomes the source of truth (bytes fetched by id, never by
//     path). When it is absent, the blob is held client-side for the token
//     TTL — a real fallback, not a stub.
//
// Zero dependencies: works standalone (guards every DOM/toast/i18n access).

(function (global) {
  'use strict';

  var TTL_MS = 10 * 60 * 1000;          // bridge token lifetime
  var SWEEP_INTERVAL_MS = 60 * 1000;    // lazy sweep cadence
  var PROBE_TIMEOUT_MS = 2500;          // archive status probe budget

  // assetId -> record
  // record: { assetId, name, mime, kind, format, size, createdAt, expiresAt,
  //           url (controlled server URL | null), serverAssetId (|null),
  //           blob (short-term client copy | null), resolver (fn->Promise<Blob>|null) }
  var registry = {};
  // assetIds queued for delivery into Gallery (survives page switches).
  var pendingImports = [];
  var sweepTimer = null;
  var archiveApi = null;    // null = not probed, false = absent, object = status payload
  var unavailableNotified = false;

  function now() { return Date.now(); }

  function freshId() {
    return 'mb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function safeToast(msg, type) {
    if (typeof toast === 'function') toast(msg, type);
  }

  function tr(key) {
    return (typeof t === 'function') ? t(key) : key;
  }

  // ------------------------------------------------------------------
  // Public capability probe (cached; never throws). Resolves to the
  // /api/archive/status payload when the Archive API is present, or false.
  // Used by producers (e.g. gif-editor export) to gate assetId/archive-pack
  // flows on availability, falling back to legacy contracts otherwise.
  // ------------------------------------------------------------------
  function archiveStatus() {
    return probeArchiveApi();
  }

  // ------------------------------------------------------------------
  // Archive API capability probe (cached per session; never throws).
  // ------------------------------------------------------------------
  function probeArchiveApi() {
    if (archiveApi !== null) return Promise.resolve(archiveApi);
    if (typeof fetch !== 'function') { archiveApi = false; return Promise.resolve(false); }
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, PROBE_TIMEOUT_MS) : null;
    return fetch('/api/archive/status', ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) {
        if (!r.ok) return false;
        return r.json().catch(function () { return false; });
      })
      .catch(function () { return false; })
      .then(function (result) {
        clearTimeout(timer);
        archiveApi = (result && typeof result === 'object') ? result : false;
        return archiveApi;
      });
  }

  function makeRecord(asset) {
    var name = asset && asset.name ? String(asset.name) : 'asset';
    var mime = (asset && asset.mime) || '';
    var kind = asset && asset.kind ? String(asset.kind)
      : (mime.indexOf('video/') === 0 ? 'video'
        : (mime.indexOf('image/') === 0 ? 'image' : 'media'));
    var ts = now();
    return {
      assetId: freshId(),
      name: name,
      mime: mime,
      kind: kind,
      format: (asset && asset.format) || '',
      size: (asset && asset.size) || 0,
      createdAt: ts,
      expiresAt: ts + TTL_MS,
      url: (asset && asset.url) || null,          // controlled server URL
      serverAssetId: null,                        // /api/archive/assets id
      blob: null,                                 // short-term client copy
      resolver: (asset && typeof asset.resolver === 'function') ? asset.resolver : null,
      consumed: false
    };
  }

  // POST /api/archive/assets?name=... with the raw blob; returns the server
  // assetId or null when the endpoint is unavailable/rejects the body.
  function serverRegister(rec, blob) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    return fetch('/api/archive/assets?name=' + encodeURIComponent(rec.name), {
      method: 'POST',
      body: blob
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json().then(function (d) { return d && d.assetId ? d.assetId : null; })
        .catch(function () { return null; });
    }).catch(function () { return null; });
  }

  /**
   * register(asset) -> Promise<assetId>
   * asset: { name, mime, kind?, format?, size?, blob?, url?, resolver? }
   *   - blob: browser Blob held short-term (or mirrored to the Archive API
   *     when present); bytes fetched by id at import time.
   *   - url: controlled server URL the Gallery may stream/fetch directly
   *     (e.g. /api/downloads/{id}/file). No client copy is kept.
   *   - resolver: lazy () -> Promise<Blob> used only when neither blob nor a
   *     directly streamable url is appropriate.
   */
  function register(asset) {
    asset = asset || {};
    var rec = makeRecord(asset);
    registry[rec.assetId] = rec;
    ensureSweepTimer();

    if (!asset.blob) return Promise.resolve(rec.assetId); // url/resolver-based

    return probeArchiveApi().then(function (caps) {
      if (caps) {
        return serverRegister(rec, asset.blob).then(function (serverId) {
          if (serverId) {
            rec.serverAssetId = serverId;
            rec.url = '/api/archive/assets/' + encodeURIComponent(serverId);
            rec.blob = null; // server owns the bytes; do not retain a copy
          } else {
            rec.blob = asset.blob; // real fallback: endpoint rejected us
          }
          return rec.assetId;
        });
      }
      rec.blob = asset.blob;
      return rec.assetId;
    });
  }

  // ------------------------------------------------------------------
  // Lookup / byte resolution (consumed by Gallery's own import entry)
  // ------------------------------------------------------------------
  function sweep() {
    var threshold = now();
    Object.keys(registry).forEach(function (id) {
      var rec = registry[id];
      if (rec.expiresAt <= threshold) {
        rec.blob = null;
        rec.resolver = null;
        delete registry[id];
        var qi = pendingImports.indexOf(id);
        if (qi >= 0) pendingImports.splice(qi, 1);
      }
    });
  }

  function ensureSweepTimer() {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  function getAsset(assetId) {
    sweep();
    var rec = registry[assetId];
    if (!rec || rec.consumed) return null;
    return {
      assetId: rec.assetId,
      name: rec.name,
      mime: rec.mime,
      kind: rec.kind,
      format: rec.format,
      size: rec.size,
      url: rec.url,
      serverAssetId: rec.serverAssetId
    };
  }

  function list() {
    sweep();
    var out = [];
    Object.keys(registry).forEach(function (id) { out.push(getAsset(id)); });
    return out.filter(Boolean);
  }

  /**
   * getAssetBlob(assetId) -> Promise<Blob|null>
   * Resolves the asset bytes: retained client blob, lazy resolver, or a fetch
   * of the controlled server URL. Used by gallery-io.js galleryImportAssets.
   */
  function getAssetBlob(assetId) {
    sweep();
    var rec = registry[assetId];
    if (!rec || rec.consumed) return Promise.resolve(null);
    if (rec.blob) return Promise.resolve(rec.blob);
    if (rec.resolver) {
      return Promise.resolve().then(rec.resolver).then(function (b) {
        if (b) rec.blob = b;
        return b || null;
      }).catch(function () { return null; });
    }
    if (rec.url && typeof fetch === 'function') {
      return fetch(rec.url).then(function (r) { return r.ok ? r.blob() : null; })
        .catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  // ------------------------------------------------------------------
  // Release
  // ------------------------------------------------------------------
  /**
   * consume(assetId | assetId[]) — drops the bridge-side token. Server-side
   * copies are intentionally NOT deleted here: Gallery items may still stream
   * from their server URL, and server TTL/expiry is the cleanup authority.
   */
  function consume(assetId) {
    var ids = Array.isArray(assetId) ? assetId.slice() : [assetId];
    ids.forEach(function (id) {
      var rec = registry[id];
      if (!rec) return;
      rec.consumed = true;
      rec.blob = null;
      rec.resolver = null;
      delete registry[id];
      var qi = pendingImports.indexOf(id);
      if (qi >= 0) pendingImports.splice(qi, 1);
    });
  }

  // ------------------------------------------------------------------
  // Gallery handoff
  // ------------------------------------------------------------------
  function toAssetMetadata(rec) {
    return {
      assetId: rec.assetId,
      name: rec.name,
      mime: rec.mime,
      kind: rec.kind,
      format: rec.format,
      size: rec.size,
      url: rec.url,
      serverAssetId: rec.serverAssetId
    };
  }

  function galleryAvailable() {
    return typeof renderGallery === 'function' && typeof galleryImportAssets === 'function';
  }

  function gotoGalleryPage() {
    if (typeof navigateTo === 'function') {
      navigateTo('gallery');
      return true;
    }
    if (typeof document !== 'undefined') {
      var btn = document.querySelector('button[data-page="gallery"], .nav-item[data-page="gallery"]');
      if (btn && typeof btn.click === 'function') {
        btn.click();
        return true;
      }
    }
    return false;
  }

  /**
   * deliverPendingImports() — called by Gallery's own renderGallery after the
   * page is (re)rendered. Hands every queued asset to gallery-io.js
   * galleryImportAssets (Gallery's own state writer) and consumes the tokens
   * on success. The queue is NOT cleared by cleanupGallery, so switching away
   * and back re-delivers pending handoffs.
   */
  function deliverPendingImports() {
    if (!pendingImports.length) return Promise.resolve(0);
    if (typeof galleryImportAssets !== 'function') {
      if (!unavailableNotified) {
        unavailableNotified = true;
        safeToast(tr('mediaBridgeGalleryUnavailable'), 'warning');
      }
      return Promise.resolve(0);
    }
    var ids = pendingImports.slice();
    var assets = [];
    ids.forEach(function (id) {
      var rec = registry[id];
      if (rec && !rec.consumed) assets.push(toAssetMetadata(rec));
    });
    pendingImports = [];
    return Promise.resolve()
      .then(function () { return galleryImportAssets(assets); })
      .then(function (importedCount) {
        ids.forEach(function (id) { consume(id); });
        return importedCount || 0;
      })
      .catch(function (err) {
        console.warn('MediaBridge deliverPendingImports failed:', err);
        return 0;
      });
  }

  /**
   * openGallery(assetId | assetId[]) — queue registered assets for Gallery
   * import, switch to the Gallery page, and let renderGallery trigger the
   * delivery. Returns true when the handoff was accepted.
   */
  function openGallery(assetIdOrIds) {
    var ids = Array.isArray(assetIdOrIds) ? assetIdOrIds.slice() : [assetIdOrIds];
    if (!ids.length) return false;
    sweep();
    var anyMissing = false;
    var anyQueued = false;
    ids.forEach(function (id) {
      var rec = registry[id];
      if (!rec || rec.consumed) anyMissing = true;
      else {
        anyQueued = true;
        if (pendingImports.indexOf(id) < 0) pendingImports.push(id);
      }
    });
    if (anyMissing) {
      safeToast(tr('mediaBridgeAssetExpired'), 'warning');
    }
    if (!anyQueued) return false; // nothing valid to hand off
    if (!galleryAvailable()) {
      if (!unavailableNotified) {
        unavailableNotified = true;
        safeToast(tr('mediaBridgeGalleryUnavailable'), 'warning');
      }
      return false;
    }
    var onGallery = typeof currentPage !== 'undefined' && currentPage === 'gallery';
    if (onGallery) {
      deliverPendingImports();
    } else if (!gotoGalleryPage()) {
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Test/diagnostics seam (used by web/media-bridge.test.js)
  // ------------------------------------------------------------------
  function reset() {
    Object.keys(registry).forEach(function (id) { registry[id].blob = null; });
    Object.keys(registry).forEach(function (id) { delete registry[id]; });
    pendingImports = [];
    archiveApi = null;
    unavailableNotified = false;
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  }

  global.MediaBridge = {
    register: register,
    openGallery: openGallery,
    consume: consume,
    deliverPendingImports: deliverPendingImports,
    getAsset: getAsset,
    getAssetBlob: getAssetBlob,
    list: list,
    archiveStatus: archiveStatus,
    _internals: {
      registry: registry,
      pendingImports: pendingImports,
      archiveApi: function () { return archiveApi; },
      setTtl: function (ms) { TTL_MS = ms; },
      setNow: function (fn) { now = fn; },
      reset: reset
    }
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
