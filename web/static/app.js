// --- Global Autofill Suppression ---
// Disable browser autofill / "Saved Information" popups globally across all input and form elements.
(function disableGlobalAutofill() {
  function applyAutofillOff(el) {
    if (!el || !el.tagName) return;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var type = (el.type || 'text').toLowerCase();
      if (type !== 'checkbox' && type !== 'radio' && type !== 'range' && type !== 'file' && type !== 'submit' && type !== 'button' && type !== 'color') {
        if (!el.hasAttribute('autocomplete') || el.getAttribute('autocomplete') !== 'off') {
          el.setAttribute('autocomplete', 'off');
        }
        if (!el.hasAttribute('autocorrect') || el.getAttribute('autocorrect') !== 'off') {
          el.setAttribute('autocorrect', 'off');
        }
        if (!el.hasAttribute('autocapitalize') || el.getAttribute('autocapitalize') !== 'off') {
          el.setAttribute('autocapitalize', 'off');
        }
        if (!el.hasAttribute('spellcheck') || el.getAttribute('spellcheck') !== 'false') {
          el.setAttribute('spellcheck', 'false');
        }
      }
    } else if (tag === 'form') {
      if (!el.hasAttribute('autocomplete') || el.getAttribute('autocomplete') !== 'off') {
        el.setAttribute('autocomplete', 'off');
      }
    }
  }

  function scanAndApply(root) {
    var inputs = (root || document).querySelectorAll('input, form');
    for (var i = 0; i < inputs.length; i++) {
      applyAutofillOff(inputs[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { scanAndApply(document); });
  } else {
    scanAndApply(document);
  }

  document.addEventListener('focusin', function(e) {
    if (e.target) applyAutofillOff(e.target);
  }, true);

  if (window.MutationObserver) {
    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType === 1) {
            applyAutofillOff(node);
            scanAndApply(node);
          }
        }
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
})();

// --- State ---
let currentPage = 'monitor';
let currentProviderId = null;
let providersCache = [];
let providerDetailCache = null;
let modelTestStatus = {};
let importTarget = 'models';
var usageEventSource = null;
var navGen = 0;
var utilityActiveTool = null;
var utilityMenuOpen = false;

var UTILITY_TOOLS = [
  { id: 'editor', labelKey: 'logFileEditor' },
  { id: 'logReader', labelKey: 'logReader', requiresPlayground: true },
  { id: 'review', labelKey: 'utilityReview', requiresPlayground: true },
  { id: 'gif', labelKey: 'gifEditor' },
  { id: 'download', labelKey: 'download' },
  { id: 'fileTransfer', labelKey: 'fileTransfer' }
];
function isUtilityTool(id) {
  return UTILITY_TOOLS.some(function(tool) { return tool.id === id; });
}
function utilityHasTool(id) {
  var item = UTILITY_TOOLS.filter(function(tool) { return tool.id === id; })[0];
  if (!item || (item.requiresPlayground && window.__hasPlayground === false)) return false;
  if (id === 'editor') return typeof renderEditor === 'function';
  if (id === 'logReader') return typeof renderLogReader === 'function';
  if (id === 'review') return typeof window.renderReview === 'function';
  if (id === 'gif') return typeof renderGifEditor === 'function';
  if (id === 'download') return typeof renderDownload === 'function';
  if (id === 'fileTransfer') return typeof window.renderUtilityFileTransfer === 'function';
  return false;
}

function renderUtilityReview(container) {
  return window.renderReview(container);
}

function updateUtilityNavLabel() {
  var button = document.querySelector('.nav-item[data-page="utility"]');
  if (!button) return;
  var item = UTILITY_TOOLS.filter(function(tool) { return tool.id === utilityActiveTool; })[0];
  button.textContent = item ? t(item.labelKey) : t('utility');
}

function updateUtilityMenuState() {
  var menu = document.getElementById('utility-menu');
  if (!menu) return;
  var toolToMark = utilityActiveTool || 'editor';
  menu.querySelectorAll('[data-utility-tool]').forEach(function(item) {
    item.setAttribute('aria-current', item.dataset.utilityTool === toolToMark ? 'page' : 'false');
  });
}
function utilityToolLifecycle(id, phase) {
  var hooks = {
    editor: { suspend: 'suspendEditor', resume: 'resumeEditor' },
    logReader: { suspend: 'suspendEditorLogs' },
    review: { suspend: 'cleanupReview' },
    gif: { suspend: 'suspendGifEditor', resume: 'resumeGifEditor' },
    download: { suspend: 'suspendDownload', resume: 'resumeDownload' },
    fileTransfer: { suspend: 'suspendFileTransfer', resume: 'resumeFileTransfer' }
  };
  var hook = hooks[id] && hooks[id][phase];
  if (hook && typeof window[hook] === 'function') window[hook]();
}

function closeUtilityMenu() {
  utilityMenuOpen = false;
  var menu = document.getElementById('utility-menu');
  var button = document.querySelector('.nav-item[data-page="utility"]');
  if (menu) {
    menu.classList.remove('open');
    setTimeout(function() {
      if (!utilityMenuOpen) menu.hidden = true;
    }, 480);
  }
  if (button) button.setAttribute('aria-expanded', 'false');
}

function focusUtilityMenuSelected() {
  var menu = document.getElementById('utility-menu');
  if (!menu || menu.hidden) return;
  var toolToMark = utilityActiveTool || 'editor';
  var selected = menu.querySelector('button[data-utility-tool="' + toolToMark + '"]') ||
                 menu.querySelector('[aria-current="page"]') ||
                 menu.querySelector('button:not([disabled])');
  if (selected) selected.focus();
}

function openUtilityMenu() {
  var menu = document.getElementById('utility-menu');
  var button = document.querySelector('.nav-item[data-page="utility"]');
  if (!menu || !button) return;
  utilityMenuOpen = true;
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  updateUtilityMenuState();
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      menu.classList.add('open');
      focusUtilityMenuSelected();
      setTimeout(focusUtilityMenuSelected, 50);
      setTimeout(focusUtilityMenuSelected, 120);
    });
  });
}

function toggleUtilityMenu() {
  if (utilityMenuOpen) closeUtilityMenu(); else openUtilityMenu();
}

function selectUtilityTool(id) {
  var item = UTILITY_TOOLS.filter(function(tool) { return tool.id === id; })[0];
  if (!item || !utilityHasTool(id)) return;
  utilityActiveTool = id;
  updateUtilityNavLabel();
  updateUtilityMenuState();
  closeUtilityMenu();
  navigateTo(id);
}

function renderUtility(container) {
  if (!utilityActiveTool || !utilityHasTool(utilityActiveTool)) {
    utilityActiveTool = 'editor';
  }
  if (utilityActiveTool && utilityHasTool(utilityActiveTool)) {
    if (utilityActiveTool === 'editor') return renderEditor(container);
    if (utilityActiveTool === 'logReader') return renderLogReader(container);
    if (utilityActiveTool === 'review') return renderUtilityReview(container);
    if (utilityActiveTool === 'gif') return renderGifEditor(container);
    if (utilityActiveTool === 'download') return renderDownload(container);
    if (utilityActiveTool === 'fileTransfer') return window.renderUtilityFileTransfer(container);
  }
  utilityActiveTool = 'editor';
  updateUtilityNavLabel();
  updateUtilityMenuState();
  return renderEditor(container);
}
// Fallback: close all streams when the tab is closed.
window.addEventListener('beforeunload', () => {
    if (typeof closeConsoleStream === 'function') closeConsoleStream();
});
document.addEventListener('DOMContentLoaded', async function() {
  initTheme();
  ThemeSystem.init();
  initFontSize();
  initLang();
  var authStatus = await checkAuthStatus();
  var enabled = authStatus.passwordEnabled || authStatus.authEnabled;
  var authenticated = authStatus.authenticated || authStatus.loggedIn;
  if (enabled && !authenticated) renderLoginScreen();
  else initApp();
});

function navigateTo(page) {
  if (utilityMenuOpen) closeUtilityMenu();
  var previousPage = currentPage;
  var previousIsUtilityTool = isUtilityTool(previousPage);
  var preserveUtilityState = previousIsUtilityTool || utilityHasTool(utilityActiveTool);
  var wasFullscreen = document.body.classList.contains('gallery-fullscreen-active') || (typeof isFullscreen === 'function' && isFullscreen());
  if (previousIsUtilityTool && previousPage !== page) utilityToolLifecycle(previousPage, 'suspend');
  currentPage = page;
  if (isUtilityTool(page)) utilityActiveTool = page;
  updateUtilityNavLabel();
  updateUtilityMenuState();
  var gen = ++navGen;
  currentProviderId = null;
  if (typeof stopUsageRefresh === 'function') stopUsageRefresh();
  if (page !== 'playground' && typeof cleanupPlayground === 'function') cleanupPlayground();
  if (page !== 'gallery' && typeof cleanupGallery === 'function') cleanupGallery();
  if (page !== 'demo' && typeof cleanupAssistantDemo === 'function') cleanupAssistantDemo();
  if (page !== 'demo' && typeof cleanupDemoGames === 'function') cleanupDemoGames();
  if (!preserveUtilityState) {
    if (page !== 'editor' && page !== 'logReader' && page !== 'review' && typeof cleanupEditor === 'function') cleanupEditor();
    if (page !== 'review' && typeof cleanupTextReview === 'function') cleanupTextReview();
    if (page !== 'gif' && typeof cleanupGifEditor === 'function') cleanupGifEditor();
    if (page !== 'fileTransfer' && typeof cleanupFileTransfer === 'function') cleanupFileTransfer();
  }
  if (!preserveUtilityState && page !== 'download' && typeof downloadEventSource !== 'undefined' && downloadEventSource) {
    downloadEventSource.close();
    downloadEventSource = null;
  }
  if (page !== 'monitor' && typeof closeConsoleStream === 'function') closeConsoleStream();
  document.querySelectorAll('.nav-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.page === page || (UTILITY_TOOLS.some(function(tool) { return tool.id === page; }) && el.dataset.page === 'utility'));
  });
  var galBtn = document.querySelector('.nav-item[data-page="gallery"]');
  if (galBtn) galBtn.textContent = t('gallery');
  var container = document.getElementById('page-content');
  var mainEl = document.querySelector('.main');
  if (mainEl) mainEl.classList.remove('main-no-scroll');
  container.style.height = '';
  container.style.overflow = '';
  container.innerHTML = '';
  container.classList.remove('page-enter');
  var p = (function() {
    switch (page) {
      case 'endpoint': return renderEndpoint(container);
      case 'providers': return renderProviders(container);
      case 'combos': return renderCombos(container);
      case 'playground': return renderPlayground(container);
      case 'monitor': return renderUsage(container);
      case 'utility': return renderUtility(container);
      case 'download': utilityActiveTool = 'download'; updateUtilityNavLabel(); return renderUtility(container);
      case 'gallery': return renderGallery(container);
      case 'demo': try { renderAssistantDemo(container); } catch (e) { console.error('renderAssistantDemo failed', e); container.innerHTML = '<div style="padding:12px;color:var(--danger)">Demo init failed: '+(e&&e.message||e)+'</div>'; } try { renderDemoGames(container); } catch (e2) { console.error('renderDemoGames failed', e2); } if (typeof ademoSyncShellTabs === 'function') try { ademoSyncShellTabs(); } catch (e0) {} return;
      case 'editor': utilityActiveTool = 'editor'; updateUtilityNavLabel(); return renderUtility(container);
      case 'logReader': utilityActiveTool = 'logReader'; updateUtilityNavLabel(); return renderUtility(container);
      case 'review': utilityActiveTool = 'review'; updateUtilityNavLabel(); return renderUtility(container);
      case 'gif': utilityActiveTool = 'gif'; updateUtilityNavLabel(); return renderUtility(container);
      case 'fileTransfer': utilityActiveTool = 'fileTransfer'; updateUtilityNavLabel(); return renderUtility(container);
    }
  })();
  // renderUtility is the resume boundary for retained tools: each renderer
  // rebuilds its DOM and binds exactly once (Download opens SSE, FileTransfer
  // binds its root, and GIF rebuilds its editor). Do not call resume hooks
  // before or after this render, which would duplicate those bindings.
  var activeTool = (page === 'utility' || isUtilityTool(page)) ? (utilityActiveTool || 'editor') : null;
  var isFullHeight = (page === 'playground' || page === 'gallery' || page === 'endpoint' || page === 'editor' || page === 'logReader' || page === 'gif' || page === 'utility' || page === 'fileTransfer' || page === 'demo' || activeTool === 'fileTransfer');
  if (isFullHeight && mainEl) {
    mainEl.classList.add('main-no-scroll');
    if (page === 'gif' || activeTool === 'gif' || page === 'fileTransfer' || activeTool === 'fileTransfer') container.style.height = '100%';
  }
  function restoreFullscreenState() {
    if (wasFullscreen) {
      document.body.classList.add('gallery-fullscreen-active');
      if (typeof window.toggleNativeFullscreen === 'function') {
        try { window.toggleNativeFullscreen(true); } catch (e) {}
      }
    }
  }
  if (p && p.then) {
    p.then(function() { if (gen === navGen) container.classList.add('page-enter'); }).catch(function(e) {
      if (gen === navGen) { container.innerHTML = emptyState('Load failed'); container.classList.add('page-enter'); }
      console.warn('navigateTo render failed:', e);
    }).then(restoreFullscreenState);
  } else {
    restoreFullscreenState();
  }
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
    document.body.appendChild(tip);
    return tip;
  }

  function showFor(el, content) {
    if (!content) { hide(); return; }
    currentEl = el;
    var t = ensureTip();
    t.textContent = content;          // textContent keeps us immune to HTML injection from data-tooltip values
    
    // 1. 移除 visible，重置为 scale: 0
    t.classList.remove('visible');
    
    // 2. 重新计算位置
    position(t, el);
    
    // 3. 双重 rAF 确保浏览器渲染引擎与 GPU 合成器记录初始帧状态
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        t.classList.add('visible');
      });
    });
  }

  function position(t, el) {
    var rect = el.getBoundingClientRect();
    var margin = 8;
    var rawLeft = rect.left + (rect.width / 2) - (t.offsetWidth / 2);
    var left = rawLeft;
    var arrowOffset = 0;
    if (left + t.offsetWidth > window.innerWidth - 6) {
      var clampedLeft = window.innerWidth - t.offsetWidth - 6;
      arrowOffset = rawLeft - clampedLeft;
      left = clampedLeft;
    }
    if (left < 6) {
      var clampedLeft = 6;
      arrowOffset = rawLeft - clampedLeft;
      left = clampedLeft;
    }

    var isAbove = true;
    var top = rect.top - t.offsetHeight - margin;       // prefer above
    if (top < 6) {
      top = rect.bottom + margin;            // flip below if no room above
      isAbove = false;
    }
    if (top + t.offsetHeight > window.innerHeight - 6) {
      top = window.innerHeight - t.offsetHeight - 6;
    }

    t.setAttribute('data-placement', isAbove ? 'top' : 'bottom');
    t.style.setProperty('--arrow-offset', arrowOffset + 'px');
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }

  function hide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (tip) {
      tip.classList.remove('visible');
    }
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
  window.addEventListener('scroll', function() { if (currentEl && tip && tip.classList.contains('visible')) position(tip, currentEl); }, true);
  window.addEventListener('resize', function() { if (currentEl && tip && tip.classList.contains('visible')) position(tip, currentEl); });

  return { showFor: showFor, hide: hide };
})();

function maskKey(key) {
  if (!key || key.length <= 8) return '***';
  return key.slice(0, 4) + '****' + key.slice(-4);
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

function promptModal(title, defaultValue, placeholder) {
  return new Promise(function(resolve) {
    var overlay = document.getElementById('modal-overlay');
    if (!overlay) { resolve(null); return; }
    if (overlay.classList.contains('show') || overlay.children.length > 0) { resolve(null); return; }
    var val = defaultValue || '';
    var ph = placeholder || '';
    overlay.innerHTML =
      '<div class="modal" style="max-width:440px;">' +
        '<div class="modal-title">' + escapeHtml(title || t('inputPromptTitle')) + '</div>' +
        '<div class="modal-body" style="margin-top:12px;">' +
          '<input type="text" class="input" id="prompt-input" value="' + escapeAttr(val) + '" placeholder="' + escapeAttr(ph) + '" style="width:100%; box-sizing:border-box;" />' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button type="button" class="btn btn-ghost" id="prompt-cancel">' + t('cancel') + '</button>' +
          '<button type="button" class="btn btn-primary" id="prompt-confirm">' + t('confirm') + '</button>' +
        '</div>' +
      '</div>';
    overlay.classList.add('show');
    var input = document.getElementById('prompt-input');
    if (input) {
      setTimeout(function() {
        input.focus();
        input.select();
      }, 50);
      input.onkeydown = function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          close(input.value.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close(null);
        }
      };
    }
    function close(result) {
      overlay.classList.remove('show');
      overlay.innerHTML = '';
      resolve(result);
    }
    document.getElementById('prompt-cancel').onclick = function() { close(null); };
    document.getElementById('prompt-confirm').onclick = function() {
      var inp = document.getElementById('prompt-input');
      close(inp ? inp.value.trim() : null);
    };
  });
}
window.promptModal = promptModal;

function openModelPickerModal(currentValue, onSelect) {
  if (typeof pgOpenModelPicker === 'function') {
    pgOpenModelPicker(currentValue, onSelect);
    return;
  }
  var overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  fetch('/api/models').then(function(r) { return r.json(); }).then(function(data) {
    var items = [];
    var models = (data && Array.isArray(data.models)) ? data.models : (Array.isArray(data) ? data : []);
    if (models.length > 0) {
      models.forEach(function(m) {
        if (m && m.id) {
          var label = m.provider ? (m.provider + ' / ' + (m.alias || m.name || m.realModelId || m.id)) : m.id;
          items.push({ id: m.id, name: label, note: m.note || '' });
        }
      });
    } else {
      if (data && Array.isArray(data.combos)) {
        data.combos.forEach(function(c) {
          items.push({ id: 'combo:' + c.name, name: '⚡ combo:' + c.name });
        });
      }
      if (data && Array.isArray(data.providers)) {
        data.providers.forEach(function(p) {
          if (p && Array.isArray(p.models)) {
            p.models.forEach(function(m) {
              items.push({ id: p.id + '/' + (m.id || m.name), name: (p.name || p.id) + ' / ' + (m.name || m.id) });
            });
          }
        });
      }
    }
    renderPicker(items);
  }).catch(function() {
    renderPicker([]);
  });

  function renderPicker(items) {
    var selectedVal = currentValue || '';
    overlay.innerHTML =
      '<div class="modal" style="max-width:480px; width:90%; max-height:80vh; display:flex; flex-direction:column;">' +
        '<div class="modal-title" style="display:flex; justify-content:space-between; align-items:center;">' +
          '<span>选择 AI 模型 (Model)</span>' +
          '<button type="button" class="btn btn-ghost btn-sm" id="picker-close" style="padding:2px 8px;">✕</button>' +
        '</div>' +
        '<div style="margin-top:10px;">' +
          '<input type="text" class="input" id="picker-filter" placeholder="搜索过滤模型 (Filter models)..." style="width:100%; box-sizing:border-box;" />' +
        '</div>' +
        '<div id="picker-list" style="margin-top:10px; flex:1; overflow-y:auto; max-height:360px; display:flex; flex-direction:column; gap:4px; padding-right:4px;">' +
        '</div>' +
        '<div class="modal-footer" style="margin-top:12px;">' +
          '<button type="button" class="btn btn-ghost" id="picker-cancel">取消</button>' +
          '<button type="button" class="btn btn-primary" id="picker-confirm">确定</button>' +
        '</div>' +
      '</div>';
    overlay.classList.add('show');
    var listEl = document.getElementById('picker-list');
    var filterEl = document.getElementById('picker-filter');
    var confirmBtn = document.getElementById('picker-confirm');
    var cancelBtn = document.getElementById('picker-cancel');
    var closeBtn = document.getElementById('picker-close');

    function updateList(filterText) {
      if (!listEl) return;
      listEl.innerHTML = '';
      var query = (filterText || '').toLowerCase();
      var filtered = items.filter(function(it) {
        return !query || it.id.toLowerCase().indexOf(query) >= 0 || it.name.toLowerCase().indexOf(query) >= 0;
      });
      if (filtered.length === 0) {
        listEl.innerHTML = '<div style="padding:16px; text-align:center; opacity:0.6; font-size:13px;">无匹配模型</div>';
        return;
      }
      filtered.forEach(function(it) {
        var itemDiv = document.createElement('div');
        var isSel = it.id === selectedVal;
        itemDiv.className = 'model-picker-item' + (isSel ? ' active' : '');
        itemDiv.style.cssText = 'padding:8px 12px; border-radius:6px; cursor:pointer; font-size:13px; display:flex; justify-content:space-between; align-items:center; background:' + (isSel ? 'var(--accent-color-transparent, rgba(79, 70, 229, 0.15))' : 'rgba(255,255,255,0.03)') + '; border:1px solid ' + (isSel ? 'var(--accent-color, #4f46e5)' : 'transparent') + '; transition:background 0.15s;';
        itemDiv.innerHTML = '<span>' + escapeHtml(it.name) + '</span>' + (isSel ? '<span style="color:var(--accent-color, #4f46e5); font-weight:bold;">✓</span>' : '');
        itemDiv.onclick = function() {
          selectedVal = it.id;
          updateList(filterEl ? filterEl.value : '');
        };
        listEl.appendChild(itemDiv);
      });
    }

    updateList('');
    if (filterEl) {
      setTimeout(function() { filterEl.focus(); }, 50);
      filterEl.oninput = function() { updateList(filterEl.value); };
    }
    function close() {
      overlay.classList.remove('show');
      overlay.innerHTML = '';
    }
    cancelBtn.onclick = close;
    closeBtn.onclick = close;
    confirmBtn.onclick = function() {
      close();
      if (typeof onSelect === 'function') onSelect(selectedVal);
    };
  }
}
window.promptModal = promptModal;
window.openModelPickerModal = openModelPickerModal;

function closeModalOverlay() {
  document.dispatchEvent(new CustomEvent('tinyrouter:modal-close'));
  var overlay = document.getElementById('modal-overlay');
  if (typeof window.__confirmResolver === 'function') {
    var r = window.__confirmResolver;
    window.__confirmResolver = null;
    r(false);
  }
  if (typeof cleanupFileTransferModal === 'function') cleanupFileTransferModal();
  overlay.classList.remove('show');
  overlay.innerHTML = '';
}

function initTheme() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  updateThemeButton(theme);
}

function updateThemeButton(theme) {
  const checkbox = document.getElementById('theme-switch-checkbox');
  if (checkbox) {
    checkbox.checked = (theme === 'dark');
  }
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
    if (page) el.textContent = t(page);
  });
  var shutdownBtn = document.querySelector('.shutdown-btn');
  if (shutdownBtn) {
    var shutdownLabel = t('shutdown');
    shutdownBtn.setAttribute('data-tooltip', shutdownLabel);
    shutdownBtn.setAttribute('aria-label', shutdownLabel);
  }
}


function setFontSize(size) {
  if (size !== 's' && size !== 'm' && size !== 'l') size = 's';
  document.documentElement.setAttribute('data-font-size', size);
  localStorage.setItem('fontSize', size);
  updateFontButton(size);
}

function toggleFontSize() {
  const current = document.documentElement.getAttribute('data-font-size') || 's';
  const order = { 's': 'm', 'm': 'l', 'l': 's' };
  const next = order[current] || 's';
  setFontSize(next);
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

// Native OS file/directory dialogs must make the entire app modal. The page
// remains alive while the backend waits for the native dialog, so block both
// pointer and keyboard events until the picker returns.
function beginNativePickerLock(kind) {
  if (window.__nativePickerBusy) return false;
  window.__nativePickerBusy = true;
  window.__nativePickerKind = kind || 'file';
  var blocker = document.createElement('div');
  blocker.id = 'native-picker-blocker';
  blocker.setAttribute('aria-hidden', 'true');
  blocker.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:transparent;cursor:wait;pointer-events:auto;';
  document.body.appendChild(blocker);
  return true;
}

function endNativePickerLock() {
  window.__nativePickerBusy = false;
  window.__nativePickerKind = '';
  var blocker = document.getElementById('native-picker-blocker');
  if (blocker) blocker.remove();
}

function blockNativePickerEvent(event) {
  if (!window.__nativePickerBusy) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dragstart', 'focusin', 'keydown', 'keyup', 'keypress'].forEach(function (type) {
  document.addEventListener(type, blockNativePickerEvent, true);
});

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
  if (Shortcuts.matchEvent('global.goto-demo', e)) { e.preventDefault(); var dNav = document.querySelector('.nav-item[data-page="demo"]'); if (dNav) navigateTo('demo'); return; }

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
  // ESC: close utility menu if open, otherwise shutdown server (when no modal is open)
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

// Global Custom Animated Dropdown Component (matching Download & Settings Modal)
function renderCustomSelectHtml(wrapperId, selectId, options, selectedValue, onChangeHandler, extraStyle, extraSelectAttrs) {
  var styleAttr = extraStyle ? ' style="' + extraStyle + '"' : '';
  var selectedText = selectedValue;
  var optionsHtml = options.map(function(opt) {
    var val = typeof opt === 'object' ? opt.value : opt;
    var label = typeof opt === 'object' ? opt.label : opt;
    var isSel = String(val) === String(selectedValue);
    if (isSel) selectedText = label;
    return '<div class="custom-select-option' + (isSel ? ' selected' : '') + '" data-value="' + escapeAttr(val) + '" data-tooltip="' + escapeAttr(label) + '" onclick="selectCustomOption(\'' + wrapperId + '\', \'' + escapeForJsString(val) + '\', \'' + escapeForJsString(label) + '\')">' +
      '<span class="custom-select-option-link">' + escapeHtml(label) + '</span>' +
      '</div>';
  }).join('');

  var selectOptionsHtml = options.map(function(opt) {
    var val = typeof opt === 'object' ? opt.value : opt;
    var label = typeof opt === 'object' ? opt.label : opt;
    var isSel = String(val) === String(selectedValue);
    return '<option value="' + escapeAttr(val) + '"' + (isSel ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }).join('');

  var onchangeAttr = onChangeHandler ? ' onchange="' + onChangeHandler + '"' : '';
  var selectAttrs = extraSelectAttrs ? ' ' + extraSelectAttrs : '';

  return '<div class="custom-select-wrapper" id="' + wrapperId + '"' + styleAttr + ' onclick="event.stopPropagation()">' +
    '<div class="custom-select-trigger" onclick="toggleCustomSelect(\'' + wrapperId + '\', event)">' +
      '<span class="custom-select-label">' + escapeHtml(selectedText) + '</span>' +
      '<svg viewBox="0 0 512 512"><path d="M233.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 338.7 77.7 160.3c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z"/></svg>' +
    '</div>' +
    '<div class="custom-select-menu">' +
      optionsHtml +
    '</div>' +
    '<select id="' + selectId + '"' + onchangeAttr + selectAttrs + ' style="display:none;">' +
      selectOptionsHtml +
    '</select>' +
  '</div>';
}

function toggleCustomSelect(wrapperId, event) {
  if (event) event.stopPropagation();
  var wrapper = document.getElementById(wrapperId);
  if (!wrapper) return;
  var isOpen = wrapper.classList.contains('open');
  closeAllCustomSelects();
  if (!isOpen) {
    wrapper.classList.add('open');
  }
}

function selectCustomOption(wrapperId, value, labelText) {
  var wrapper = document.getElementById(wrapperId);
  if (!wrapper) return;
  var selectEl = wrapper.querySelector('select');
  var labelEl = wrapper.querySelector('.custom-select-label');
  if (selectEl) {
    selectEl.value = value;
    selectEl.dispatchEvent(new Event('change'));
  }
  if (labelEl) {
    labelEl.textContent = labelText;
  }
  var options = wrapper.querySelectorAll('.custom-select-option');
  options.forEach(function(opt) {
    if (opt.dataset.value === value) {
      opt.classList.add('selected');
    } else {
      opt.classList.remove('selected');
    }
  });
  wrapper.classList.remove('open');
}

function closeAllCustomSelects() {
  document.querySelectorAll('.custom-select-wrapper.open').forEach(function(el) {
    el.classList.remove('open');
  });
}

document.addEventListener('click', closeAllCustomSelects);

// Global Number Stepper Component (matching Settings Modal)
// Accepts both the positional form (id, value, min, max, step, extraStyle,
// onchange) used by provider/quick-slot forms AND the legacy opts-object form
// (id, value, {min, max, step, style, placeholder, dataId, inputClass, onchange})
// used by the settings/trace modals, so a single global component serves every caller.
function renderStepperHtml(id, value, min, max, step, extraStyle, onchangeAttrStr) {
  var placeholder = '';
  var dataId = '';
  var inputClass = 'stepper-input';
  if (min && typeof min === 'object') {
    var opts = min;
    min = opts.min;
    max = opts.max;
    step = opts.step;
    extraStyle = opts.style;
    placeholder = opts.placeholder || '';
    dataId = opts.dataId || '';
    if (opts.inputClass) inputClass += ' ' + opts.inputClass;
    if (opts.onchange) onchangeAttrStr = opts.onchange;
  }
  var minAttr = min !== undefined && min !== null ? ' min="' + min + '"' : '';
  var maxAttr = max !== undefined && max !== null ? ' max="' + max + '"' : '';
  var phAttr = placeholder ? ' placeholder="' + placeholder + '"' : '';
  var dataIdAttr = dataId ? ' data-id="' + dataId + '"' : '';
  var stepVal = step || 1;
  var styleAttr = extraStyle ? ' style="' + extraStyle + '"' : '';
  var onchangeStr = onchangeAttrStr ? ' onchange="' + onchangeAttrStr + '"' : '';
  return '<div class="number-stepper"' + styleAttr + '>' +
    '<button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'' + id + '\', -' + stepVal + ')">-</button>' +
    '<input type="number" class="' + inputClass + '" id="' + id + '" value="' + value + '"' + minAttr + maxAttr + phAttr + dataIdAttr + onchangeStr + '>' +
    '<button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'' + id + '\', ' + stepVal + ')">+</button>' +
    '</div>';
}

function changeStepper(id, delta) {
  var input = document.getElementById(id);
  if (!input) return;
  var min = input.hasAttribute('min') ? parseInt(input.getAttribute('min'), 10) : null;
  var max = input.hasAttribute('max') ? parseInt(input.getAttribute('max'), 10) : null;
  var hasVal = input.value !== '' && input.value !== null && !isNaN(parseInt(input.value, 10));
  var step = delta || 1;
  var val = hasVal ? parseInt(input.value, 10) : (step > 0 && min !== null && min > 0 ? min - step : 0);
  var newVal = val + step;
  if (input.hasAttribute('placeholder') && min !== null && newVal < min) {
    input.value = '';
  } else {
    if (min !== null && newVal < min) newVal = min;
    if (max !== null && newVal > max) newVal = max;
    input.value = newVal;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}



