// app-shortcuts.js — Global keydown / Escape / right-click hooks.
// Extracted from app.js (P2-03). Load after app-modal.js (topOpenModal/dismissTopModal) and app-router.js (navigateTo, menu state).
// No new globals; registers document listeners on load.
document.addEventListener('keydown', function(e) {
  if (window.__nativePickerBusy || window.__editorFilePickerBusy) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  // Demo stage-only fullscreen: only Ctrl+F toggles and game input pass through.
  // Must run before modal/shortcut handling so we can suppress all global shortcuts.
  if (document.body.classList.contains('demo-stage-fullscreen')) {
    var isCtrlF = (e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    if (isCtrlF) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (typeof ademoSetFullscreen === 'function') ademoSetFullscreen(false);
      else document.body.classList.remove('demo-stage-fullscreen');
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (typeof ademoSetFullscreen === 'function') ademoSetFullscreen(false);
      else document.body.classList.remove('demo-stage-fullscreen');
      return;
    }
    // Let capture-phase game handlers (WASD/arrows) run; suppress every global shortcut below.
    // Return early so F1-F6 etc. don't fire while playing fullscreen.
    // We still allow the event to reach capture listeners, so don't stopPropagation here.
    // Just skip the rest of this bubble handler's shortcut routing.
    // Mark so later checks (if any) can also gate.
    window.__demoStageFullscreen = true;
    // Fall through to block only global shortcuts — not game keys — by returning after modal block.
    // Quick gating: if a modal is open we already returned; otherwise skip global shortcut section.
    // We achieve that by short-circuiting the rest of the handler:
    // Use a flag check at the top of the global-shortcut block below via early return.
    // Instead, just return here after allowing capture handlers to have run; game keys are capture-phase.
    // But we still need to let keydown propagate to canvas listeners — don't preventDefault.
    // Simply skip global shortcuts by returning.
    return;
  }
  window.__demoStageFullscreen = false;
  var tag = document.activeElement ? document.activeElement.tagName : '';
  var isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable);
  var modal = topOpenModal();

  // ---- Modal is open: modal interactions take precedence ----
  if (modal) {
    if (modal.querySelector('#theme-modal-picker-container')) {
      if (handleThemeModalKeyDown(e, modal)) {
        return;
      }
    }
    // Collect all focusable elements in the modal (buttons, inputs, textareas, selects)
    var modalFocusables = Array.prototype.slice.call(modal.querySelectorAll('button, input, textarea, select, a[href], .pg-btn, .btn'));
    modalFocusables = modalFocusables.filter(function(b) { return b.offsetParent !== null && !b.disabled; }); // visible & enabled only
    if (e.key === 'Tab') {
      if (modalFocusables.length > 1) {
        e.preventDefault();
        var curIdx = modalFocusables.indexOf(document.activeElement);
        var nextIdx = e.shiftKey
          ? (curIdx <= 0 ? modalFocusables.length - 1 : curIdx - 1)
          : (curIdx + 1) % modalFocusables.length;
        modalFocusables[nextIdx].focus();
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); dismissTopModal(); return; }
    if (!isInput && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      var modalBtns = Array.prototype.slice.call(modal.querySelectorAll('button, .pg-btn, .btn'));
      modalBtns = modalBtns.filter(function(b) { return b.offsetParent !== null; }); // visible only
      if (modalBtns.length > 1) {
        e.preventDefault();
        var curIdx = modalBtns.indexOf(document.activeElement);
        var nextIdx;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % modalBtns.length;
        } else {
          nextIdx = curIdx <= 0 ? modalBtns.length - 1 : curIdx - 1;
        }
        modalBtns[nextIdx].focus();
        return;
      }
    }
    if (e.key === 'Enter') {
      var ae = document.activeElement;
      if (ae && ae.tagName === 'TEXTAREA') return; // allow newline in multi-line inputs
      if (ae && (ae.tagName === 'BUTTON' || ae.classList.contains('btn') || ae.classList.contains('pg-btn'))) {
        e.preventDefault();
        ae.click();
        return;
      }
      // No button focused: click the primary or last button
      var primary = modal.querySelector('.btn-primary') || (modalFocusables.length ? modalFocusables[modalFocusables.length - 1] : null);
      if (primary && typeof primary.click === 'function') { e.preventDefault(); primary.click(); }
      return;
    }
    // block page shortcuts while a modal is open
    return;
  }

  // ---- No modal: global shortcuts ----
  // F1-F6: page navigation (works even in inputs) — keys are configurable
  // via Settings > Shortcut Settings (action IDs global.goto-*).
  if (Shortcuts.matchEvent('global.goto-monitor', e))      { e.preventDefault(); navigateTo('monitor'); return; }
  if (Shortcuts.matchEvent('global.goto-endpoint', e))   { e.preventDefault(); navigateTo('endpoint'); return; }
  if (Shortcuts.matchEvent('global.goto-playground', e)) { e.preventDefault(); var pgNav = document.querySelector('.nav-item[data-page="playground"]'); if (pgNav) navigateTo('playground'); return; }
  if (Shortcuts.matchEvent('global.goto-download', e)) {
    e.preventDefault();
    if (currentPage === 'utility' || UTILITY_TOOLS.some(function(tool) { return tool.id === currentPage; })) toggleUtilityMenu();
    else { navigateTo('utility'); }
    return;
  }
  if (Shortcuts.matchEvent('global.goto-gallery', e)) { e.preventDefault(); navigateTo('gallery'); return; }
  if (Shortcuts.matchEvent('global.goto-demo', e)) {
    e.preventDefault();
    if (currentPage === 'demo' || (typeof isDemoTool === 'function' && isDemoTool(currentPage))) {
      if (typeof toggleDemoMenu === 'function') toggleDemoMenu();
    } else {
      navigateTo('demo');
    }
    return;
  }

  // F: toggle fullscreen (ignore when typing in any input field)
  if (Shortcuts.matchEvent('global.toggle-fullscreen', e)) {
    if (isInput) return;
    e.preventDefault();
    if (typeof toggleFullscreen === 'function') {
      toggleFullscreen();
    } else {
      var isFS = document.body.classList.contains('gallery-fullscreen-active');
      if (isFS) {
        document.body.classList.remove('gallery-fullscreen-active');
        if (typeof window.toggleNativeFullscreen === 'function') {
          try { window.toggleNativeFullscreen(false); } catch (e2) {}
        }
      } else {
        document.body.classList.add('gallery-fullscreen-active');
        if (typeof window.toggleNativeFullscreen === 'function') {
          try { window.toggleNativeFullscreen(true); } catch (e2) {}
        }
      }
    }
    return;
  }

  // Number keys 1-9: open quickslot modal (only when not in input and not in gallery)
  if (!isInput) {
    if (typeof currentPage !== 'undefined' && (currentPage === 'gallery' || currentPage === 'editor')) {
      // Gallery/Editor page owns these keys; do not double-trigger quickslot.
      // QuickSlot modal handles its own keys; skip global processing.
    } else {
      var matchedQuickslot = false;
      for (var n = 1; n <= 9; n++) {
        if (Shortcuts.matchEvent('global.quickslot-cycle-' + n, e)) {
          e.preventDefault();
          if (typeof openQuickSlotModalByOrder === 'function') openQuickSlotModalByOrder(n, true);
          matchedQuickslot = true;
          break;
        }
      }
      if (matchedQuickslot) return;
    }
  }
  if (demoMenuOpen && (e.key === 'Escape' || Shortcuts.matchEvent('global.shutdown-server', e))) {
    e.preventDefault();
    closeDemoMenu();
    var dBtn = document.querySelector('.demo-nav-wrap [data-page="demo"]');
    if (dBtn) dBtn.focus();
    return;
  }
  // ESC: close utility menu if open, otherwise shutdown server (when no modal is open)
  if (galleryMenuOpen && (e.key === 'Escape' || Shortcuts.matchEvent('global.shutdown-server', e))) {
    e.preventDefault();
    closeGalleryMenu();
    var gBtn = document.querySelector('.gallery-nav-wrap [data-page="gallery"]');
    if (gBtn) gBtn.focus();
    return;
  }
  if (utilityMenuOpen && (e.key === 'Escape' || Shortcuts.matchEvent('global.shutdown-server', e))) {
    e.preventDefault();
    closeUtilityMenu();
    var utBtn = document.querySelector('.nav-item[data-page="utility"]');
    if (utBtn) utBtn.focus();
    return;
  }
  if (Shortcuts.matchEvent('global.shutdown-server', e)) {
    e.preventDefault();
    shutdownServer();
    return;
  }
});

