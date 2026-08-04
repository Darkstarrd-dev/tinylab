// pg-lifecycle.js
// ----- Entry: render the page --------------------------------------
function renderPlayground(container) {
  var hadActiveSearch = pgState.mode === 'search'
                      && pgState.activeSearchId != null
                      && pgActiveSearch() != null;

  pgLoad();
  pgEnsureWindows();
  if (pgState.mode === 'search') {
    if (pgState.splitCount > 1) pgState.splitCount = 1;
    if (typeof pgSearchLoadSettings === 'function') pgSearchLoadSettings();
  }

  // If there was an active search before re-render, sync messages from restored searchHistory
  // Note: pgEnsureWindows() may have cleared w[1].messages, so always re-sync in search mode.
  if (pgState.mode === 'search') {
    pgSyncSearchMessages();
  }

  pgInitMarker();
  if (typeof pgInitGlobalShortcuts === 'function') pgInitGlobalShortcuts();
  container.style.height = '100%';
  container.style.overflow = 'hidden';
  container.innerHTML =
    '<div class="pg-layout">' +
      '<div class="pg-req-left" id="pg-req-left"></div>' +
      '<div class="pg-main">' +
        '<div class="pg-main-inner" id="pg-main-inner">' +
          '<div class="pg-panes" id="pg-panes"></div>' +
        '</div>' +
      '</div>' +
      '<div class="pg-input-bar" id="pg-inputbar"></div>' +
      '<div class="pg-side" id="pg-side"></div>' +
    '</div>';
  pgRenderSidebar();
  pgRenderPanes();
  pgRenderInputBar();

  // If search is still streaming, re-render messages after DOM is built
  if (hadActiveSearch && pgState.mode === 'search') {
    var w0 = pgWinAt(0);
    if (w0 && w0.streaming) {
      pgRenderMessages(0);
      if (pgWinAt(1)) pgRenderMessages(1);
    }
  }

  // Apply active quickslot model (if any) before loading models & rendering
  var activePromise = typeof qsGetActiveModel === 'function'
    ? qsGetActiveModel().then(function(a) {
        if (a && a.model && (pgState.mode === 'normal' || pgState.mode === 'search')) {
          pgWin().config.model = a.model;
        }
      })
    : Promise.resolve();
  activePromise.then(function() {
    return pgLoadModels();
  }).then(function() {
    pgRenderSidebar();
    pgRenderPanes();
    pgUpdateInputBar();
  });
  // Batch tasks are backend-owned. Re-entry snapshot-reconciles before SSE.
  if (typeof pgImageBatchOnEnter === 'function' && pgState.mode === 'image') {
    pgImageBatchOnEnter();
  }

}

function cleanupPlayground() {
  // Batch SSE is a page subscription, not the backend task. Closing it here
  // preserves projectId/snapshot so a later render can recover snapshot-first.
  if (typeof pgImageBatchCleanup === 'function') pgImageBatchCleanup();
  // In search mode: let requests continue in background. Only persist state.
  if (pgState.mode === 'search') {
    if (typeof pgSaveSearchHistory === 'function') pgSaveSearchHistory();
    if (typeof pgSaveMode === 'function') pgSaveMode();
    return;
  }

  if (typeof pgSaveSync === 'function') pgSaveSync();
  if (typeof pgSaveMode === 'function') pgSaveMode();
  if (typeof pgAutoChatStop === 'function' && pgState.autoChat && pgState.autoChat.isRunning) {
    pgAutoChatStop();
  }
  if (typeof pgStopReqLeftPolling === 'function') pgStopReqLeftPolling();
  for (var i = 0; i < pgState.windows.length; i++) {
    var w = pgWinAt(i);
    if (w.streaming) {
      if (w.abortCtrl) {
        try { w.abortCtrl.abort(); } catch (e) {}
        w.abortCtrl = null;
      }
      w.streaming = false;
    }
  }
  if (typeof pgDirectorReset === 'function') pgDirectorReset();
}