// --- State ---
let currentPage = 'endpoint';
let currentProviderId = null;
let providersCache = [];
let providerDetailCache = null;
let modelTestStatus = {};
let importTarget = 'models';
var usageEventSource = null;
var navGen = 0;

// Fallback: close all streams when the tab is closed.
window.addEventListener('beforeunload', () => {
    if (typeof closeConsoleStream === 'function') closeConsoleStream();
});

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  ThemeSystem.init();
  initFontSize();
  initLang();
  var authStatus = await checkAuthStatus();
  var enabled = authStatus.passwordEnabled || authStatus.authEnabled;
  var authenticated = authStatus.authenticated || authStatus.loggedIn;
  if (enabled && !authenticated) {
    renderLoginScreen();
  } else {
    initApp();
  }
});

function navigateTo(page) {
  var wasFullscreen = document.body.classList.contains('gallery-fullscreen-active') || (typeof isFullscreen === 'function' && isFullscreen());
  currentPage = page;
  if (page === 'gallery' || page === 'editor') sessionStorage.setItem('trGalView', page);
  var gen = ++navGen;
  currentProviderId = null;
  if (typeof stopUsageRefresh === 'function') stopUsageRefresh();
  // Cleanup playground streaming state when leaving the page.
  if (currentPage !== 'playground' && typeof cleanupPlayground === 'function') {
    cleanupPlayground();
  }
  // Cleanup gallery resources when leaving the page.
  if (currentPage !== 'gallery' && typeof cleanupGallery === 'function') {
    cleanupGallery();
  }
  // Cleanup editor resources when leaving the page.
  if (currentPage !== 'editor' && typeof cleanupEditor === 'function') {
    cleanupEditor();
  }
  // Close the download SSE stream when leaving the download page.
  if (page !== 'download' && typeof downloadEventSource !== 'undefined' && downloadEventSource) {
    downloadEventSource.close();
    downloadEventSource = null;
  }
  // Close Console stream when leaving the usage page.
  if (page !== 'monitor') {
    if (typeof closeConsoleStream === 'function') closeConsoleStream();
  }
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page ||
      (page === 'editor' && el.dataset.page === 'gallery'));
  });
  // Gallery nav button label toggle (2-way: Gallery / Editor)
  var galBtn = document.querySelector('.nav-item[data-page="gallery"]');
  if (galBtn) {
    var label = (page === 'editor') ? t('editor') : t('gallery');
    galBtn.textContent = label;
  }
  const container = document.getElementById('page-content');
  // Remove any per-page main modifier classes before rendering the new page.
  const mainEl = document.querySelector('.main');
  if (mainEl) mainEl.classList.remove('main-no-scroll');
  // Clear any inline styles left by previous page (e.g., playground sets height/overflow).
  container.style.height = '';
  container.style.overflow = '';
  container.innerHTML = '';
  container.classList.remove('page-enter');
  const p = (() => {
    switch (page) {
      case 'endpoint': return renderEndpoint(container);
      case 'providers': return renderProviders(container);
      case 'combos': return renderCombos(container);
      case 'playground': return renderPlayground(container);
      case 'monitor': return renderUsage(container);
      case 'download': return renderDownload(container);
      case 'gallery': return renderGallery(container);
      case 'editor': return renderEditor(container);
    }
  })();
  if ((page === 'playground' || page === 'gallery' || page === 'endpoint' || page === 'editor') && mainEl) mainEl.classList.add('main-no-scroll');
  
  function restoreFullscreenState() {
    if (wasFullscreen) {
      document.body.classList.add('gallery-fullscreen-active');
      if (typeof window.toggleNativeFullscreen === 'function') {
        try { window.toggleNativeFullscreen(true); } catch (e) {}
      }
    }
  }

  if (p && p.then) {
    p.then(() => { if (gen === navGen) container.classList.add('page-enter'); })
     .catch((e) => {
       if (gen === navGen) {
         container.innerHTML = emptyState('Load failed');
         container.classList.add('page-enter');
       }
       console.warn('navigateTo render failed:', e);
     })
     .then(function() {
       restoreFullscreenState();
     });
  } else {
    // Sync render: restore fullscreen state immediately.
    restoreFullscreenState();
  }
}

function gotoGalleryToggle() {
  // 2-way toggle: Gallery <-> Editor. Persisted via sessionStorage so the
  // toggle returns to the last-used page on initial load.
  if (currentPage === 'gallery') navigateTo('editor');
  else if (currentPage === 'editor') navigateTo('gallery');
  else { var last = sessionStorage.getItem('trGalView') || 'gallery'; navigateTo(last); }
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function escapeForJsString(s) {
  if (!s) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// Lookup a model note by `displayId` (alias OR model id) within a provider.
function findModelNote(provider, displayId) {
  if (!provider || !provider.models) return '';
  for (var i = 0; i < provider.models.length; i++) {
    var m = provider.models[i];
    if ((m.alias && m.alias === displayId) || m.id === displayId) return m.note || '';
  }
  return '';
}

// ===================== Model Note Popover =====================
// Shows a custom hover popover with the model note text. Listens at the
// document level for mouseenter/mouseleave on any element carrying a
// `data-model-note` attribute (decoded from the HTML-escaped value set at
// render time). Supports dynamically-inserted dropdowns without per-item
// re-binding.
document.addEventListener('mouseover', function(e) {
  var el = e.target.closest && e.target.closest('[data-model-note]');
  if (!el || el === document.documentElement) return;
  if (el.dataset.modelNote === '') return;
  showModelNotePopover(el, el.dataset.modelNote);
});
document.addEventListener('mouseout', function(e) {
  var el = e.target.closest && e.target.closest('[data-model-note]');
  if (!el || el === document.documentElement) return;
  if (e.relatedTarget && el.contains(e.relatedTarget)) return;
  hideModelNotePopover();
});

function showModelNotePopover(target, note) {
  if (!note) { hideModelNotePopover(); return; }
  hideModelNotePopover();
  var tip = document.createElement('div');
  tip.className = 'model-note-tip';
  tip.id = 'model-note-tip';
  tip.textContent = note;
  document.body.appendChild(tip);
  positionModelNotePopover(tip, target);
  target._modelNoteTip = tip;
}
function positionModelNotePopover(tip, target) {
  var rect = target.getBoundingClientRect();
  var margin = 6;
  var left = rect.left;
  if (left + tip.offsetWidth > window.innerWidth - 4) {
    left = window.innerWidth - tip.offsetWidth - 4;
  }
  if (left < 4) left = 4;
  var top = rect.top - tip.offsetHeight - margin;
  if (top < 4) top = rect.bottom + margin;
  if (top + tip.offsetHeight > window.innerHeight - 4) {
    top = window.innerHeight - tip.offsetHeight - 4;
  }
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
function hideModelNotePopover() {
  var existing = document.getElementById('model-note-tip');
  if (existing) existing.remove();
}
// ===================== TooltipSystem =====================
// Unified themed tooltip for any element carrying a `data-tooltip` attribute.
// Replaces native title= tooltips (which the UA renders as un-styled OS blocks
// that ignore the theme). Shows on hover AND keyboard focus — matching the
// native title behaviour for sighted keyboard users. A single shared DOM node
// is reused; listeners are delegated at document level so dynamically inserted
// content (rendered lists, dropdowns, streamed messages) needs no per-item
// binding. Styling comes from the `.tip` class in style.css, which consumes the
// same theme tokens as .model-note-tip / .quota-tip, so it follows every
// mode/variant/style automatically.
var TooltipSystem = (function() {
  var tip = null;          // shared <div class="tip">
  var showTimer = null;    // hover delay handle
  var currentEl = null;    // element the tip is currently anchored to
  var SHOW_DELAY = 600;     // ms — matches native title hover delay, avoids flicker on rapid traversal

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.id = 'app-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.style.display = 'none';
    document.body.appendChild(tip);
    return tip;
  }

  function showFor(el, content) {
    if (!content) { hide(); return; }
    currentEl = el;
    var t = ensureTip();
    t.textContent = content;          // textContent keeps us immune to HTML injection from data-tooltip values
    t.style.display = '';
    position(t, el);
  }

  function position(t, el) {
    var rect = el.getBoundingClientRect();
    var margin = 6;
    var left = rect.left;
    if (left + t.offsetWidth > window.innerWidth - 4) left = window.innerWidth - t.offsetWidth - 4;
    if (left < 4) left = 4;
    var top = rect.top - t.offsetHeight - margin;       // prefer above
    if (top < 4) top = rect.bottom + margin;            // flip below if no room above
    if (top + t.offsetHeight > window.innerHeight - 4) top = window.innerHeight - t.offsetHeight - 4;
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }

  function hide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (tip) tip.style.display = 'none';
    currentEl = null;
  }

  function scheduleShow(el, content) {
    clearTimeout(showTimer);
    showTimer = setTimeout(function() { showFor(el, content); }, SHOW_DELAY);
  }

  function contentOf(el) { return el.getAttribute('data-tooltip') || ''; }

  // Hover path (delegated — covers dynamically inserted elements).
  document.addEventListener('mouseover', function(e) {
    var el = e.target.closest && e.target.closest('[data-tooltip]');
    if (!el || el === document.documentElement) return;
    var c = contentOf(el);
    if (!c) return;
    scheduleShow(el, c);
  });
  document.addEventListener('mouseout', function(e) {
    var el = e.target.closest && e.target.closest('[data-tooltip]');
    if (!el || el === document.documentElement) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;   // moving within the same el
    hide();
  });

  // Focus path — restores the visual tooltip sighted keyboard users get from
  // native title=. Without this, removing title= would regress keyboard UX.
  // Immediate (no delay): focus is an intentional act, not incidental traversal.
  document.addEventListener('focusin', function(e) {
    var el = e.target.closest && e.target.closest('[data-tooltip]');
    if (!el || el === document.documentElement) return;
    var c = contentOf(el);
    if (!c) return;
    showFor(el, c);
  });
  document.addEventListener('focusout', function(e) {
    var el = e.target.closest && e.target.closest('[data-tooltip]');
    if (!el || el === document.documentElement) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    hide();
  });

  // Reposition / hide on scroll/resize so the tip never floats away from its anchor.
  window.addEventListener('scroll', function() { if (currentEl && tip && tip.style.display !== 'none') position(tip, currentEl); }, true);
  window.addEventListener('resize', function() { if (currentEl && tip && tip.style.display !== 'none') position(tip, currentEl); });

  return { showFor: showFor, hide: hide };
})();

function maskKey(key) {
  if (!key || key.length < 8) return '***';
  return key.slice(0, 8) + '...';
}

function formatMillionTokens(n) {
  return (Number(n || 0) / 1000000).toFixed(3) + 'M';
}

function copyToClipboard(text, label) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      toast((label || text) + ' ' + t('copied'), 'success');
    }).catch(function() {
      fallbackCopy(text, label);
    });
  } else {
    fallbackCopy(text, label);
  }
}

function fallbackCopy(text, label) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast((label || text) + ' ' + t('copied'), 'success');
  } catch (e) {
    toast(t('copyFailed'), 'error');
  }
  document.body.removeChild(ta);
}

function getSpinnerHtml() {
  return '<svg class="btn-spinner-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" style="display:inline-block;vertical-align:middle;box-sizing:border-box"><path d="M12 2a10 10 0 0 1 10 10"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.75s" repeatCount="indefinite"/></path></svg>';
}

function withLoading(btn, asyncFn) {
  if (!btn || btn.disabled) return Promise.resolve();
  var original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = getSpinnerHtml();
  return Promise.resolve(asyncFn()).finally(function() {
    btn.disabled = false;
    btn.innerHTML = original;
  });
}

function emptyState(msg) {
  return '<div class="empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg><p>' + msg + '</p></div>';
}

function getProviderBrand(name) {
  var n = (name || '').toLowerCase();
  if (n.indexOf('deepseek') >= 0) return '#4fc3f7';
  if (n.indexOf('openai') >= 0 || n.indexOf('gpt') >= 0) return '#10a37f';
  if (n.indexOf('claude') >= 0 || n.indexOf('anthropic') >= 0) return '#d97706';
  if (n.indexOf('gemini') >= 0 || n.indexOf('google') >= 0) return '#4285f4';
  if (n.indexOf('moonshot') >= 0 || n.indexOf('kimi') >= 0) return '#6b21a8';
  if (n.indexOf('qwen') >= 0 || n.indexOf('alibaba') >= 0 || n.indexOf('aliyun') >= 0) return '#ff6a00';
  if (n.indexOf('baichuan') >= 0) return '#2563eb';
  if (n.indexOf('siliconflow') >= 0) return '#7c3aed';
  if (n.indexOf('modelscope') >= 0) return '#a855f7';
  return '';
}

function toast(message, type, duration, key) {
  if (type === undefined) type = 'info';
  if (duration === undefined) duration = 3500;
  const container = document.getElementById('toast-container');
  if (!container) return;
  if (key) {
    var prev = container.querySelectorAll('[data-toast-key="' + key + '"]');
    for (var pi = 0; pi < prev.length; pi++) prev[pi].remove();
  }
  var svgCheck = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  var svgX = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var svgInfo = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  var svgWarn = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  const icons = { success: svgCheck, error: svgX, info: svgInfo, warning: svgWarn };
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  if (key) el.setAttribute('data-toast-key', key);
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = '<span class="toast-icon">' + icons[type] + '</span><span class="toast-message">' + escapeHtml(message) + '</span><div class="toast-progress"></div>';
  container.appendChild(el);
  requestAnimationFrame(function() { el.classList.add('show'); });
  setTimeout(function() {
    el.classList.remove('show');
    el.addEventListener('transitionend', function() { el.remove(); }, { once: true });
  }, duration);
}

function confirmModal(message) {
  return new Promise(function(resolve) {
    var overlay = document.getElementById('modal-overlay');
    if (overlay.classList.contains('show') || overlay.children.length > 0) { resolve(false); return; }
    overlay.innerHTML = '<div class="modal"><div class="modal-title">' + t('confirmTitle') + '</div><div class="modal-body">' + escapeHtml(message) + '</div><div class="modal-footer"><button type="button" class="btn btn-ghost" id="modal-cancel">' + t('cancel') + '</button><button type="button" class="btn btn-primary" id="modal-confirm">' + t('confirm') + '</button></div></div>';
    overlay.classList.add('show');
    window.__confirmResolver = resolve;
    setTimeout(function() {
      var confirmBtn = document.getElementById('modal-confirm');
      if (confirmBtn) confirmBtn.focus();
    }, 20);
    function close(result) {
      window.__confirmResolver = null;
      overlay.classList.remove('show');
      overlay.innerHTML = '';
      resolve(result);
    }
    document.getElementById('modal-cancel').onclick = function() { close(false); };
    document.getElementById('modal-confirm').onclick = function() { close(true); };
  });
}

function closeModalOverlay() {
  var overlay = document.getElementById('modal-overlay');
  if (typeof window.__confirmResolver === 'function') {
    var r = window.__confirmResolver;
    window.__confirmResolver = null;
    r(false);
  }
  overlay.classList.remove('show');
  overlay.innerHTML = '';
}

function initTheme() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  updateThemeButton(theme);
}

function updateThemeButton(theme) {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  var sunSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  var moonSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
  btn.innerHTML = theme === 'dark' ? sunSvg : moonSvg;
}

function initFontSize() {
  const size = document.documentElement.getAttribute('data-font-size') || 's';
  updateFontButton(size);
}

function updateFontButton(size) {
  const btn = document.getElementById('font-btn');
  if (btn) btn.textContent = size.toUpperCase();
}

function initLang() {
  const lang = document.documentElement.getAttribute('data-lang') || 'en';
  updateLangButton(lang);
  updateSidebarNav();
}

function updateSidebarNav() {
  document.querySelectorAll('.nav-item').forEach(function(el) {
    var page = el.dataset.page;
    if (page) {
      // Gallery nav button reflects current page
      if (page === 'gallery') {
        el.textContent = currentPage === 'editor' ? t('editor') : t('gallery');
      } else {
        el.textContent = t(page);
      }
    }
  });
  var shutdownBtn = document.querySelector('.shutdown-btn');
  if (shutdownBtn) {
    var shutdownLabel = t('shutdown');
    shutdownBtn.setAttribute('data-tooltip', shutdownLabel);
    shutdownBtn.setAttribute('aria-label', shutdownLabel);
  }
}


function toggleFontSize() {
  const current = document.documentElement.getAttribute('data-font-size') || 's';
  const order = { 's': 'm', 'm': 'l', 'l': 's' };
  const next = order[current] || 's';
  document.documentElement.setAttribute('data-font-size', next);
  localStorage.setItem('fontSize', next);
  updateFontButton(next);
}

function toggleTheme() {
  ThemeSystem.toggleMode();
}

async function shutdownServer() {
  const ok = await confirmModal(t('confirmShutdown'));
  if (!ok) return;
  // Show "shutting down" UI immediately so the user is not left staring at a
  // frozen page even before the backend acknowledges. The desktop window will
  // be terminated by the backend shortly after; the fetch is best-effort.
  document.body.innerHTML = '\
    <div class="app" style="align-items:center;justify-content:center">\
      <div class="card" style="text-align:center;max-width:360px">\
        <div class="card-title">' + t('serverStopped') + '</div>\
        <p class="muted mt-12">' + t('serverStoppedDesc') + '</p>\
      </div>\
    </div>';
  try { await apiPost('/shutdown', {}); } catch (e) {}
  try { window.close(); } catch (e) {}
}

function showSkeleton(container, count) {
  if (count === undefined) count = 3;
  var cards = [];
  for (var i = 0; i < count; i++) {
    var s = document.createElement('div');
    s.className = 'skeleton skeleton-card';
    cards.push(s);
  }
  container.replaceChildren.apply(container, cards);
}

// ===================== Global Modal & Keyboard =====================
// Returns the topmost currently-open modal overlay (.modal-overlay or .info-modal-overlay).
function topOpenModal() {
  var modalOverlay = document.getElementById('modal-overlay');
  if (modalOverlay && (modalOverlay.classList.contains('show') || modalOverlay.children.length > 0 || typeof window.__confirmResolver === 'function')) {
    return modalOverlay;
  }
  var ms = document.querySelectorAll('.modal-overlay.show, .info-modal-overlay.show, .pg-modal-overlay.show');
  return ms.length ? ms[ms.length - 1] : null;
}

// Unified dismissal: ESC / right-click / Cancel all funnel here.
function dismissTopModal() {
  var m = topOpenModal();
  if (!m) return;
  if (m.id === 'modal-overlay') {
    closeModalOverlay();
    return;
  }
  if (m.classList.contains('info-modal-overlay')) {
    if (typeof closeInfoModal === 'function') closeInfoModal();
    return;
  }
  if (m.classList.contains('pg-modal-overlay')) {
    if (m.id === 'pg-model-picker-overlay') {
      if (typeof pgCloseModelPicker === 'function') pgCloseModelPicker();
    } else {
      if (typeof pgCloseModal === 'function') pgCloseModal();
    }
    return;
  }
  if (typeof m.__close === 'function') { m.__close(); return; }
  m.classList.remove('show');
  setTimeout(function() { if (m.parentNode && m.id !== 'modal-overlay') m.parentNode.removeChild(m); }, 400);
}

// Right-click anywhere closes the topmost open modal.
document.addEventListener('contextmenu', function(e) {
  if (topOpenModal()) { e.preventDefault(); dismissTopModal(); }
});

document.addEventListener('keydown', function(e) {
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
  if (Shortcuts.matchEvent('global.goto-download', e))   { e.preventDefault(); navigateTo('download'); return; }
  if (Shortcuts.matchEvent('global.goto-gallery', e))    { e.preventDefault(); var galNav = document.querySelector('.nav-item[data-page="gallery"]'); if (galNav) gotoGalleryToggle(); return; }

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
  // ESC: shutdown (only when no modal is open — modal case handled above)
  if (Shortcuts.matchEvent('global.shutdown-server', e)) {
    e.preventDefault();
    shutdownServer();
    return;
  }
});

function handleThemeModalKeyDown(e, modal) {
  if (e.key === 'Escape') {
    e.preventDefault();
    dismissTopModal();
    return true;
  }

  var darkCards = Array.prototype.slice.call(modal.querySelectorAll('[data-group="dark"] .theme-card'));
  var lightCards = Array.prototype.slice.call(modal.querySelectorAll('[data-group="light"] .theme-card'));
  var styleSwatches = Array.prototype.slice.call(modal.querySelectorAll('.style-swatch'));
  var footerBtns = Array.prototype.slice.call(modal.querySelectorAll('.modal-footer button'));

  var groups = [
    { name: 'dark', items: darkCards },
    { name: 'night', items: lightCards },
    { name: 'style', items: styleSwatches },
    { name: 'button', items: footerBtns }
  ];

  var activeEl = document.activeElement;
  var targetControl = activeEl ? (activeEl.closest ? activeEl.closest('.theme-card, .style-swatch, .btn, button') : activeEl) : null;
  var currentGroupIdx = -1;
  var currentItemIdx = -1;

  for (var gi = 0; gi < groups.length; gi++) {
    var idx = groups[gi].items.indexOf(targetControl);
    if (idx !== -1) {
      currentGroupIdx = gi;
      currentItemIdx = idx;
      break;
    }
  }

  // 1. Tab key cycling: dark -> night -> style -> button -> dark
  if (e.key === 'Tab') {
    e.preventDefault();
    var nextGroupIdx;
    if (e.shiftKey) {
      if (currentGroupIdx <= 0) nextGroupIdx = groups.length - 1;
      else nextGroupIdx = currentGroupIdx - 1;
    } else {
      if (currentGroupIdx < 0 || currentGroupIdx >= groups.length - 1) nextGroupIdx = 0;
      else nextGroupIdx = currentGroupIdx + 1;
    }

    var targetGroup = groups[nextGroupIdx];
    if (targetGroup && targetGroup.items.length > 0) {
      var targetItem = targetGroup.items.find(function(el) {
        return el.classList.contains('active') || el.classList.contains('selected') || el.id === 'settings-modal-save';
      }) || targetGroup.items[0];
      if (targetItem) targetItem.focus();
    }
    return true;
  }

  // 2. Arrow keys: Move focus within the active group
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (currentGroupIdx === -1) {
      if (groups[0].items.length > 0) {
        var firstItem = groups[0].items.find(function(el) { return el.classList.contains('active') || el.classList.contains('selected'); }) || groups[0].items[0];
        if (firstItem) firstItem.focus();
      }
      return true;
    }

    var items = groups[currentGroupIdx].items;
    if (items.length === 0) return true;

    var nextItemIdx = currentItemIdx;
    if (currentGroupIdx === 0 || currentGroupIdx === 1) {
      // 3x3 Card Grid (Dark or Night Group)
      var cols = 3;
      var total = items.length;
      if (e.key === 'ArrowRight') {
        nextItemIdx = (currentItemIdx + 1) % total;
      } else if (e.key === 'ArrowLeft') {
        nextItemIdx = (currentItemIdx - 1 + total) % total;
      } else if (e.key === 'ArrowDown') {
        nextItemIdx = (currentItemIdx + cols) % total;
      } else if (e.key === 'ArrowUp') {
        nextItemIdx = (currentItemIdx - cols + total) % total;
      }
    } else {
      // Linear layout (Style Group or Button Group)
      var totalLinear = items.length;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        nextItemIdx = (currentItemIdx + 1) % totalLinear;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        nextItemIdx = (currentItemIdx - 1 + totalLinear) % totalLinear;
      }
    }

    if (items[nextItemIdx]) {
      items[nextItemIdx].focus();
    }
    return true;
  }

  // 3. Spacebar: Select / Activate item
  if (e.key === ' ' || e.key === 'Spacebar') {
    if (activeEl && (activeEl.classList.contains('theme-card') || activeEl.classList.contains('style-swatch') || activeEl.tagName === 'BUTTON')) {
      e.preventDefault();
      activeEl.click();
      return true;
    }
  }

  // 4. Enter: Confirm and Exit
  if (e.key === 'Enter') {
    e.preventDefault();
    if (activeEl && activeEl.tagName === 'BUTTON' && activeEl.id !== 'settings-modal-save') {
      activeEl.click();
    } else {
      var saveBtn = modal.querySelector('#settings-modal-save');
      if (saveBtn) saveBtn.click();
      else dismissTopModal();
    }
    return true;
  }

  return false;
}
