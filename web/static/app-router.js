// app-router.js — Navigation + page lifecycle and Utility/Gallery menu wiring.
// Extracted from app.js (P2-03). Load after app.js + app-demo.js.
// Globals preserved: UTILITY_TOOLS, isUtilityTool, GALLERY_TOOLS, isGalleryTool, utilityActiveTool,
// galleryActiveTool, utilityMenuOpen, galleryMenuOpen, utilityHasTool, galleryHasTool, navigateTo,
// renderUtilityReview, updateUtilityNavLabel, updateUtilityMenuState, galleryToolLifecycle, closeGalleryMenu,
// focusGalleryMenuSelected, openGalleryMenu, toggleGalleryMenu, selectGalleryTool, renderGalleryWithMenu,
// utilityToolLifecycle, closeUtilityMenu, focusUtilityMenuSelected, openUtilityMenu, toggleUtilityMenu,
// selectUtilityTool, renderUtility
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
var GALLERY_TOOLS = [
  { id: 'gallery', labelKey: 'gallery' },
  { id: 'music', labelKey: 'music' }
];
function isGalleryTool(id) {
  return GALLERY_TOOLS.some(function(tool) { return tool.id === id; });
}
var galleryActiveTool = 'gallery';
var galleryMenuOpen = false;
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
function galleryHasTool(id) {
  if (id === 'gallery') return typeof renderGallery === 'function';
  if (id === 'music') return typeof renderMusic === 'function';
  return isGalleryTool(id);
}
function updateGalleryNavLabel() {
  var button = document.querySelector('.nav-item[data-page="gallery"]');
  if (!button) return;
  var item = GALLERY_TOOLS.filter(function(tool) { return tool.id === galleryActiveTool; })[0];
  button.textContent = item ? t(item.labelKey) : t('gallery');
}
function updateGalleryMenuState() {
  var menu = document.getElementById('gallery-menu');
  if (!menu) return;
  var toolToMark = galleryActiveTool || 'gallery';
  menu.querySelectorAll('[data-gallery-tool]').forEach(function(item) {
    item.setAttribute('aria-current', item.dataset.galleryTool === toolToMark ? 'page' : 'false');
  });
}
function galleryToolLifecycle(id, phase) {
  var hooks = {
    gallery: { suspend: 'suspendGallery', resume: 'resumeGallery' },
    music: { suspend: 'suspendMusic', resume: 'resumeMusic' }
  };
  var hook = hooks[id] && hooks[id][phase];
  if (hook && typeof window[hook] === 'function') window[hook]();
}
function closeGalleryMenu() {
  galleryMenuOpen = false;
  var menu = document.getElementById('gallery-menu');
  var button = document.querySelector('.nav-item[data-page="gallery"]');
  if (menu) {
    menu.classList.remove('open');
    setTimeout(function() {
      if (!galleryMenuOpen) menu.hidden = true;
    }, 480);
  }
  if (button) button.setAttribute('aria-expanded', 'false');
}
function focusGalleryMenuSelected() {
  var menu = document.getElementById('gallery-menu');
  if (!menu || menu.hidden) return;
  var toolToMark = galleryActiveTool || 'gallery';
  var selected = menu.querySelector('button[data-gallery-tool="' + toolToMark + '"]') ||
                 menu.querySelector('[aria-current="page"]') ||
                 menu.querySelector('button:not([disabled])');
  if (selected) selected.focus();
}
function openGalleryMenu() {
  var menu = document.getElementById('gallery-menu');
  var button = document.querySelector('.nav-item[data-page="gallery"]');
  if (!menu || !button) return;
  galleryMenuOpen = true;
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  updateGalleryMenuState();
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      menu.classList.add('open');
      focusGalleryMenuSelected();
      setTimeout(focusGalleryMenuSelected, 50);
      setTimeout(focusGalleryMenuSelected, 120);
    });
  });
}
function toggleGalleryMenu() {
  if (galleryMenuOpen) closeGalleryMenu(); else openGalleryMenu();
}
function selectGalleryTool(id) {
  var item = GALLERY_TOOLS.filter(function(tool) { return tool.id === id; })[0];
  if (!item || !galleryHasTool(id)) return;
  galleryActiveTool = id;
  updateGalleryNavLabel();
  updateGalleryMenuState();
  closeGalleryMenu();
  navigateTo(id);
}
function renderGalleryWithMenu(container) {
  if (!galleryActiveTool || !galleryHasTool(galleryActiveTool)) {
    galleryActiveTool = 'gallery';
  }
  updateGalleryNavLabel();
  updateGalleryMenuState();
  if (galleryActiveTool === 'music' && typeof renderMusic === 'function') return renderMusic(container);
  if (galleryActiveTool === 'gallery' && typeof renderGallery === 'function') return renderGallery(container);
  // Fallback: music not yet loaded, show comingsoon for music, otherwise gallery
  if (galleryActiveTool === 'music') {
    container.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-secondary)"><h3 style="margin-bottom:8px">'+escapeHtml(t('music'))+'</h3><p>'+escapeHtml(t('comingSoon')||'Coming soon — see docs/music-implementation-plan.md')+'</p></div>';
    return;
  }
  return renderGallery(container);
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

// Gallery dropdown wiring (delegated)
document.addEventListener('click', function(e){
  var gItem = e.target.closest && e.target.closest('[data-gallery-tool]');
  if (gItem) { e.preventDefault(); selectGalleryTool(gItem.getAttribute('data-gallery-tool')); return; }
  var dItem = e.target.closest && e.target.closest('[data-demo-tool]');
  if (dItem) { e.preventDefault(); selectDemoTool(dItem.getAttribute('data-demo-tool')); return; }
  var uItem = e.target.closest && e.target.closest('[data-utility-tool]');
  if (uItem) { e.preventDefault(); selectUtilityTool(uItem.getAttribute('data-utility-tool')); return; }
  // Nav button clicks are handled by auth.js initApp per-button listeners (conditional nav vs toggle).
  // This delegated handler only closes on outside clicks.
  var galWrap = document.querySelector('.gallery-nav-wrap');
  var demoWrap = document.querySelector('.demo-nav-wrap');
  var utilWrap = document.querySelector('.utility-nav-wrap:not(.gallery-nav-wrap):not(.demo-nav-wrap)');
  if (galleryMenuOpen && galWrap && !galWrap.contains(e.target)) closeGalleryMenu();
  if (demoMenuOpen && demoWrap && !demoWrap.contains(e.target) && !e.target.closest('#demo-menu')) closeDemoMenu();
  if (utilityMenuOpen && utilWrap && !utilWrap.contains(e.target) && !e.target.closest('#utility-menu')) closeUtilityMenu();
});

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
function navigateTo(page) {
  if (utilityMenuOpen) closeUtilityMenu();
  if (galleryMenuOpen) closeGalleryMenu();
  if (demoMenuOpen) closeDemoMenu();
  var previousPage = currentPage;
  var previousIsUtilityTool = isUtilityTool(previousPage);
  var previousIsGalleryTool = isGalleryTool(previousPage);
  var previousIsDemoTool = isDemoTool(previousPage);
  var preserveUtilityState = previousIsUtilityTool || utilityHasTool(utilityActiveTool);
  var preserveGalleryState = previousIsGalleryTool || galleryHasTool(galleryActiveTool);
  var wasFullscreen = document.body.classList.contains('gallery-fullscreen-active') || (typeof isFullscreen === 'function' && isFullscreen());
  if (previousIsUtilityTool && previousPage !== page) utilityToolLifecycle(previousPage, 'suspend');
  if (previousIsGalleryTool && previousPage !== page) galleryToolLifecycle(previousPage, 'suspend');
  if (previousIsDemoTool && previousPage !== page) demoToolLifecycle(previousPage, 'suspend');
  currentPage = page;
  if (isUtilityTool(page)) utilityActiveTool = page;
  if (isGalleryTool(page)) galleryActiveTool = page;
  if (isDemoTool(page)) demoActiveTool = page;
  updateUtilityNavLabel();
  updateUtilityMenuState();
  updateGalleryNavLabel();
  updateGalleryMenuState();
  updateDemoNavLabel();
  updateDemoMenuState();
  var gen = ++navGen;
  currentProviderId = null;
  if (typeof stopUsageRefresh === 'function') stopUsageRefresh();
  if (page !== 'playground' && typeof cleanupPlayground === 'function') cleanupPlayground();
  if (!isGalleryTool(page) && typeof cleanupGallery === 'function') cleanupGallery();
  if (page !== 'music' && typeof cleanupMusic === 'function') try{ cleanupMusic(); }catch(e){}
  if (!isDemoTool(page) && page !== 'demo' && typeof cleanupAssistantDemo === 'function') cleanupAssistantDemo();
  if (!isDemoTool(page) && page !== 'demo' && typeof cleanupDemoGames === 'function') cleanupDemoGames();
  // TileMap cleanup is handled by demoToolLifecycle above; legacy per-page cleanup kept as fallback.
  if (!isDemoTool(page) && page !== 'demo' && typeof TilemapEditor !== 'undefined' && TilemapEditor && typeof TilemapEditor.cleanupTilemap === 'function') { try{ TilemapEditor.cleanupTilemap(); }catch(e0){} }
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
    el.classList.toggle('active', el.dataset.page === page || (UTILITY_TOOLS.some(function(tool) { return tool.id === page; }) && el.dataset.page === 'utility') || (GALLERY_TOOLS.some(function(tool){return tool.id===page;}) && el.dataset.page==='gallery') || (DEMO_TOOLS.some(function(tool){return tool.id===page;}) && el.dataset.page==='demo'));
  });
  updateGalleryNavLabel();
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
      case 'gallery': galleryActiveTool='gallery'; updateGalleryNavLabel(); updateGalleryMenuState(); return renderGalleryWithMenu(container);
      case 'music': galleryActiveTool='music'; updateGalleryNavLabel(); updateGalleryMenuState(); return renderGalleryWithMenu(container);
      case 'demo': return renderDemoWithMenu(container);
      case 'ademo': return renderDemoWithMenu(container);
      case 'tilemap': return renderDemoWithMenu(container);
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
  var galleryTool = isGalleryTool(page) ? page : null;
  var demoTool = isDemoTool(page) ? page : (page === 'demo' ? demoActiveTool : null);
  var isFullHeight = (page === 'playground' || page === 'gallery' || page === 'music' || page === 'endpoint' || page === 'editor' || page === 'logReader' || page === 'gif' || page === 'utility' || page === 'fileTransfer' || page === 'demo' || isDemoTool(page) || activeTool === 'fileTransfer' || galleryTool === 'music' || demoTool);
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
window.navigateTo = navigateTo;
