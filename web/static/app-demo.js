// app-demo.js — Demo page load/cleanup and Demo menu lifecycle.
// Extracted from app.js (P2-03). Load after app.js, before app-router.js.
// Globals preserved: DEMO_TOOLS, isDemoTool, demoActiveTool, demoMenuOpen, demoHasTool,
// updateDemoNavLabel, updateDemoMenuState, demoToolLifecycle, closeDemoMenu, focusDemoMenuSelected,
// openDemoMenu, toggleDemoMenu, selectDemoTool, renderDemoWithMenu
var DEMO_TOOLS = [
  { id: 'ademo', labelKey: 'demo' },
  { id: 'tilemap', labelKey: 'tilemap' }
];
function isDemoTool(id) {
  return DEMO_TOOLS.some(function(tool) { return tool.id === id; });
}
var demoActiveTool = 'ademo';
var demoMenuOpen = false;
function demoHasTool(id) {
  if (id === 'ademo') return typeof renderAssistantDemo === 'function';
  if (id === 'tilemap') return typeof TilemapEditor !== 'undefined' && typeof TilemapEditor.renderTilemap === 'function';
  return isDemoTool(id);
}
function updateDemoNavLabel() {
  var button = document.querySelector('.demo-nav-wrap [data-page="demo"]');
  if (!button) return;
  var item = DEMO_TOOLS.filter(function(tool) { return tool.id === demoActiveTool; })[0];
  button.textContent = item ? t(item.labelKey) : t('demo');
  // Ensure active styling when on any demo tool page
  var isDemoActive = currentPage === 'demo' || isDemoTool(currentPage);
  button.classList.toggle('active', !!isDemoActive);
}
function updateDemoMenuState() {
  var menu = document.getElementById('demo-menu');
  if (!menu) return;
  var toolToMark = demoActiveTool || 'ademo';
  menu.querySelectorAll('[data-demo-tool]').forEach(function(item) {
    item.setAttribute('aria-current', item.dataset.demoTool === toolToMark ? 'page' : 'false');
  });
}
function demoToolLifecycle(id, phase) {
  var hooks = {
    ademo: { suspend: 'suspendAssistantDemo' },
    tilemap: { suspend: 'cleanupTilemap', resume: null }
  };
  var hook = hooks[id] && hooks[id][phase];
  if (!hook) return;
  // support TilemapEditor.* as well as globals
  if (hook === 'cleanupTilemap' && typeof TilemapEditor !== 'undefined' && typeof TilemapEditor.cleanupTilemap === 'function') { TilemapEditor.cleanupTilemap(); return; }
  if (typeof window[hook] === 'function') window[hook]();
}
function closeDemoMenu() {
  demoMenuOpen = false;
  var menu = document.getElementById('demo-menu');
  var button = document.querySelector('.demo-nav-wrap [data-page="demo"]');
  if (menu) {
    menu.classList.remove('open');
    setTimeout(function() {
      if (!demoMenuOpen) menu.hidden = true;
    }, 480);
  }
  if (button) button.setAttribute('aria-expanded', 'false');
}
function focusDemoMenuSelected() {
  var menu = document.getElementById('demo-menu');
  if (!menu || menu.hidden) return;
  var toolToMark = demoActiveTool || 'ademo';
  var selected = menu.querySelector('button[data-demo-tool="' + toolToMark + '"]') ||
                 menu.querySelector('[aria-current="page"]') ||
                 menu.querySelector('button:not([disabled])');
  if (selected) selected.focus();
}
function openDemoMenu() {
  var menu = document.getElementById('demo-menu');
  var button = document.querySelector('.demo-nav-wrap [data-page="demo"]');
  if (!menu || !button) return;
  demoMenuOpen = true;
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  updateDemoMenuState();
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      menu.classList.add('open');
      focusDemoMenuSelected();
      setTimeout(focusDemoMenuSelected, 50);
      setTimeout(focusDemoMenuSelected, 120);
    });
  });
}
function toggleDemoMenu() {
  if (demoMenuOpen) closeDemoMenu(); else openDemoMenu();
}
function selectDemoTool(id) {
  var item = DEMO_TOOLS.filter(function(tool) { return tool.id === id; })[0];
  if (!item || !demoHasTool(id)) return;
  demoActiveTool = id;
  updateDemoNavLabel();
  updateDemoMenuState();
  closeDemoMenu();
  navigateTo(id);
}
function renderDemoWithMenu(container) {
  if (!demoActiveTool || !demoHasTool(demoActiveTool)) {
    demoActiveTool = 'ademo';
  }
  updateDemoNavLabel();
  updateDemoMenuState();
  if (demoActiveTool === 'tilemap' && typeof TilemapEditor !== 'undefined' && typeof TilemapEditor.renderTilemap === 'function') {
    try { TilemapEditor.renderTilemap(container); } catch(e){ console.error('renderTilemap failed', e); container.innerHTML = '<div style="padding:12px;color:var(--danger)">TileMap init failed: '+(e&&e.message||e)+'</div>'; }
    return;
  }
  // Default: Assistant demo
  try { renderAssistantDemo(container); } catch(e){ console.error('renderAssistantDemo failed', e); container.innerHTML = '<div style="padding:12px;color:var(--danger)">Demo init failed: '+(e&&e.message||e)+'</div>'; }
}
