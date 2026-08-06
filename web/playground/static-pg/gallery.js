// gallery.js — Gallery entry point and cleanup. Loaded last.
// Backend: internal/api/gallery/fs_handlers.go + zip_handlers.go + register.go.

'use strict';

// ---------- entry & cleanup -------------------------------------
/**
 * Entry: inject the Gallery layout into the given container and initialize
 * event bindings. Called by app.js when navigating to the gallery page.
 * @param {HTMLElement} container
 */
window.renderGallery = function(container) {
  try {
    renderInitial(container);

    // Restore tree panel UI state if tree was open
    var panel = document.getElementById('gallery-tree-panel');
    var btn = document.getElementById('gallery-tree-btn');
    if (panel) panel.classList.toggle('hidden', !galleryState.treeOpen);
    if (btn) btn.classList.toggle('active', galleryState.treeOpen);

    if (galleryState.items && galleryState.items.length) {
      // Tab-switching back from another page: restore current session and index
      updateDirStructure();
      var targetIndex = (galleryState.index >= 0 && galleryState.index < galleryState.items.length) ? galleryState.index : 0;
      setActive(targetIndex);
    }

    // 恢复 AI Review 轮询：若离开页面时审核仍在运行，需重新轮询同步进度。
    // 注意：审核完成后 backend 会自动删除任务，所以这里仅在 running 时恢复。
    if (galleryState.reviewState && galleryState.reviewState.active &&
        galleryState.reviewState.status === 'running' && !galleryState.reviewState.pollTimer) {
      if (typeof window.startReviewPolling === 'function') {
        window.startReviewPolling();
      }
    }
    // 进入 Gallery 页面时若预设列表为空，主动拉取一次。
    // autoLoadPresets 的 IIFE 只在脚本解析时跑一次，SPA 切换回来不会重跑。
    if (galleryState.reviewState && !galleryState.reviewState.availablePresets.length &&
        typeof window.loadReviewPresets === 'function') {
      window.loadReviewPresets();
    }

    // Flush any MediaBridge handoff queue (GIF export / Download "Play" →
    // Gallery). The bridge holds tokens until consumed or TTL, so switching
    // away and back re-delivers only handoffs that were never imported.
    if (window.MediaBridge && typeof window.MediaBridge.deliverPendingImports === 'function') {
      window.MediaBridge.deliverPendingImports();
    }
  } catch (e) {
    console.warn('renderGallery failed:', e);
  }
};

/**
 * Cleanup: suspend gallery state, stop timers, remove document-level
 * listeners when leaving the page without destroying loaded items.
 */
window.cleanupGallery = function() {
  stopAutoplay();
  var fs = isFullscreen();
  unbindFullscreen();
  if (!fs) {
    document.body.classList.remove('gallery-fullscreen-active');
    if (typeof window.toggleNativeFullscreen === 'function') {
      try { window.toggleNativeFullscreen(false); } catch (e) {}
    }
  }
  if (galleryState.pageKeyHandler) {
    document.removeEventListener('keydown', galleryState.pageKeyHandler);
    galleryState.pageKeyHandler = null;
  }
  if (galleryState.pasteHandler) {
    document.removeEventListener('paste', galleryState.pasteHandler);
    galleryState.pasteHandler = null;
  }
  if (galleryState.thumbObserver) {
    galleryState.thumbObserver.disconnect();
    galleryState.thumbObserver = null;
  }
  var layout = document.getElementById('gallery-layout');
  if (layout) layout.classList.remove('gallery-layout-fullscreen');
  var c = galleryState.container;
  galleryState.container = null;
  if (c) c.classList.remove('gallery-page');
  // 清理 AI Review 状态
  if (typeof window.cleanupReview === 'function') {
    window.cleanupReview();
  }
  if (typeof window.cleanupMediaEditor === 'function') {
    window.cleanupMediaEditor();
  }
  clearObjectURLs();
};