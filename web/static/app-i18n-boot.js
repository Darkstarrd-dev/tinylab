// app-i18n-boot.js — Theme / font-size / i18n boot and sidebar refresh.
// Extracted from app.js (P2-03). Load after app.js. Uses t(), updateDemoNavLabel etc. if available.
// Globals preserved: initTheme, updateThemeButton, initFontSize, updateFontButton, initLang,
// updateSidebarNav, setFontSize, toggleFontSize, toggleTheme
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
    if (!page) return;
    // Skip wrapped dropdown buttons (label is managed by update*NavLabel).
    if (el.closest && el.closest('.demo-nav-wrap')) return;
    if (el.closest && el.closest('.utility-nav-wrap:not(.demo-nav-wrap):not(.gallery-nav-wrap)')) return;
    if (el.closest && el.closest('.gallery-nav-wrap')) return;
    el.textContent = t(page);
  });
  if (typeof updateDemoNavLabel === 'function') updateDemoNavLabel();
  if (typeof updateGalleryNavLabel === 'function') updateGalleryNavLabel();
  if (typeof updateUtilityNavLabel === 'function') updateUtilityNavLabel();
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

