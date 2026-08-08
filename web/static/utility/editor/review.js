// review.js — standalone Utility Review entry point.
// The wizard implementation remains in editor_textreview*.js; this adapter
// gives Utility navigation an explicit lifecycle separate from File Editor.
(function () {
  'use strict';

  function renderReview(container) {
    if (!container) return;
    if (typeof window.renderTextReview !== 'function') {
      container.innerHTML = '<div class="utility-empty-state">Review is unavailable in this build.</div>';
      return;
    }
    window.renderTextReview(container);
  }

  function cleanupReview() {
    if (typeof window.cleanupTextReview === 'function') window.cleanupTextReview();
  }

  window.renderReview = renderReview;
  window.cleanupReview = cleanupReview;
}());
