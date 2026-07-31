// ===================== ThemeSystem =====================
// Two-level theme model:
//   Mode (dark/light) — toggled by header sun/moon button
//   Variant — per-mode sub-theme (extensible via registry + CSS overrides)
//
// HTML attributes: <html data-theme="dark" data-theme-variant="default">
// Persistence: localStorage (immediate) + config.yaml via Settings API (durable)

var ThemeSystem = (function() {
  'use strict';

  // --- Registry ---
  // Each variant: { id, name, nameZh, swatchColor, primaryColor }
  var registry = {
    dark: [
      // Row 1
      { id: 'default', name: 'Midnight', nameZh: '暗夜蓝调', swatchColor: '#0b0c13', primaryColor: '#4fc3f7' },
      { id: 'tokyo-night', name: 'Tokyo Night', nameZh: '东京夜影', swatchColor: '#1a1b26', primaryColor: '#7aa2f7' },
      { id: 'emerald', name: 'Emerald Midnight', nameZh: '翡翠极夜', swatchColor: '#091410', primaryColor: '#10b981' },
      // Row 2
      { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', nameZh: '猫猫摩卡', swatchColor: '#1e1e2e', primaryColor: '#cba6f7' },
      { id: 'dracula', name: 'Dracula', nameZh: '德古拉', swatchColor: '#282a36', primaryColor: '#ff79c6' },
      { id: 'nord', name: 'Nord Dark', nameZh: '北欧极夜', swatchColor: '#2e3440', primaryColor: '#88c0d0' },
      // Row 3
      { id: 'one-dark', name: 'One Dark', nameZh: '经典深灰', swatchColor: '#21252b', primaryColor: '#61afef' },
      { id: 'cyberpunk', name: 'Cyberpunk', nameZh: '赛博霓虹', swatchColor: '#120e24', primaryColor: '#f9f871' },
      { id: 'rose-pine', name: 'Rosé Pine', nameZh: '玫瑰暮色', swatchColor: '#191724', primaryColor: '#ebbcba' }
    ],
    light: [
      // Row 1
      { id: 'default', name: 'Standard Light', nameZh: '标准亮色', swatchColor: '#f8f9fc', primaryColor: '#0ea5e9' },
      { id: 'cream', name: 'Warm Cream', nameZh: '暖阳米白', swatchColor: '#faf8f5', primaryColor: '#d97706' },
      { id: 'cool', name: 'Cool Slate', nameZh: '冰霜凝蓝', swatchColor: '#f0f4f8', primaryColor: '#6366f1' },
      // Row 2
      { id: 'catppuccin-latte', name: 'Catppuccin Latte', nameZh: '猫猫拿铁', swatchColor: '#eff1f5', primaryColor: '#8839ef' },
      { id: 'github-light', name: 'GitHub Light', nameZh: '极简白', swatchColor: '#ffffff', primaryColor: '#0969da' },
      { id: 'nord-light', name: 'Nord Light', nameZh: '极光白', swatchColor: '#eceff4', primaryColor: '#5e81ac' },
      // Row 3
      { id: 'solarized-light', name: 'Solarized Light', nameZh: '日光米黄', swatchColor: '#fdf6e3', primaryColor: '#268bd2' },
      { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', nameZh: '晨曦玫瑰', swatchColor: '#faf4ed', primaryColor: '#d7827e' },
      { id: 'sakura', name: 'Sakura Blossom', nameZh: '樱花漫舞', swatchColor: '#fff5f7', primaryColor: '#ec4899' }
    ]
  };

  // --- Style Registry ---
  // Independent style dimension (shape, motion, weight) — orthogonal to color variant.
  var styleRegistry = [
    { id: 'default', name: 'Rounded', nameZh: '圆润', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="6"/></svg>' },
    { id: 'sharp', name: 'Sharp', nameZh: '锐利', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="1"/></svg>' },
    { id: 'soft', name: 'Soft', nameZh: '柔和', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="10"/></svg>' },
    { id: 'compact', name: 'Compact', nameZh: '紧凑', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="3"/><line x1="9" y1="12" x2="15" y2="12"/></svg>' }
  ];

  // --- State ---
  // Per-mode variant memory (so toggling mode restores each mode's variant).
  var variants = {
    dark: localStorage.getItem('themeVariantDark') || 'default',
    light: localStorage.getItem('themeVariantLight') || 'default'
  };
  // Style dimension state (global, independent of mode).
  var currentStyle = localStorage.getItem('themeStyle') || 'default';

  // --- Core API ---

  function getMode() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  function getVariant(mode) {
    if (!mode) mode = getMode();
    return variants[mode] || 'default';
  }

  function applyMode(mode) {
    var variant = variants[mode] || 'default';
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.setAttribute('data-theme-variant', variant);
    document.documentElement.setAttribute('data-theme-style', currentStyle);
    localStorage.setItem('theme', mode);
    localStorage.setItem('themeVariant', variant);
  }

  function applyVariant(mode, variant) {
    variants[mode] = variant;
    localStorage.setItem('themeVariant' + capitalize(mode), variant);
    // If applying to the currently active mode, update DOM immediately.
    if (mode === getMode()) {
      document.documentElement.setAttribute('data-theme-variant', variant);
      localStorage.setItem('themeVariant', variant);
    }
  }

  function toggleMode() {
    var current = getMode();
    var next = current === 'dark' ? 'light' : 'dark';
    applyMode(next);
    // Notify existing subsystems that depend on mode change.
    notifyModeChange(next);
    return next;
  }

  function setVariant(mode, variant) {
    applyVariant(mode, variant);
    // If this mode is active, reflect immediately.
    if (mode === getMode()) {
      notifyModeChange(mode);
    }
    // Persist to backend (fire-and-forget).
    persistToBackend();
    // Re-render picker UI if present.
    renderThemePicker('theme-modal-picker-container');
    renderThemePicker('theme-picker');
  }

  function init() {
    // Restore mode + variant + style from localStorage on page load.
    var mode = localStorage.getItem('theme') || 'dark';
    var variant = localStorage.getItem('themeVariant') || 'default';
    currentStyle = localStorage.getItem('themeStyle') || 'default';
    // Sync per-mode memory.
    variants[mode] = variant;
    applyMode(mode);
  }

  function initFromSettings(settings) {
    // Called after Settings API response to sync backend-persisted variants.
    if (settings && settings.theme) {
      if (settings.theme.darkVariant) {
        variants.dark = settings.theme.darkVariant;
        localStorage.setItem('themeVariantDark', settings.theme.darkVariant);
      }
      if (settings.theme.lightVariant) {
        variants.light = settings.theme.lightVariant;
        localStorage.setItem('themeVariantLight', settings.theme.lightVariant);
      }
      if (settings.theme.style) {
        currentStyle = settings.theme.style;
        localStorage.setItem('themeStyle', currentStyle);
      }
      // Re-apply current mode with correct variant + style.
      var mode = getMode();
      applyMode(mode);
    }
  }

  function getRegistry() {
    return registry;
  }

  // --- Persistence ---

  function persistToBackend() {
    if (typeof apiPatch !== 'function') return;
    apiPatch('/settings', {
      theme: {
        darkVariant: variants.dark,
        lightVariant: variants.light,
        style: currentStyle
      }
    }).catch(function() { /* best-effort */ });
  }

  // --- Notifications ---

  function notifyModeChange(mode) {
    // Update header theme button icon.
    if (typeof updateThemeButton === 'function') updateThemeButton(mode);
  }

  // --- Theme Picker UI ---

  function renderThemePicker(targetId) {
    var containerId = targetId || 'theme-picker';
    var container = document.getElementById(containerId);
    if (!container) return;
    var currentMode = getMode();
    var lang = document.documentElement.getAttribute('data-lang') || 'en';
    var html = '';
    var modes = ['dark', 'light'];
    var icons = {
      dark: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
      light: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>'
    };
    var modeLabels = {
      dark: (typeof t === 'function') ? t('themeDark') : 'Dark',
      light: (typeof t === 'function') ? t('themeLight') : 'Light'
    };

    var isModalView = (containerId === 'theme-modal-picker-container');

    if (isModalView) {
      // High-aesthetic card grid layout for modal
      for (var mi = 0; mi < modes.length; mi++) {
        var mode = modes[mi];
        var variantList = registry[mode] || [];
        var isModeActive = (mode === currentMode);

        html += '<div class="theme-modal-group" data-group="' + mode + '">';
        html += '  <div class="theme-modal-group-title">' + icons[mode] + ' <span>' + modeLabels[mode] + '</span></div>';
        html += '  <div class="theme-modal-grid">';
        for (var vi = 0; vi < variantList.length; vi++) {
          var v = variantList[vi];
          var isSelected = (variants[mode] === v.id);
          var isCurrentActive = (mode === currentMode && isSelected);
          var label = lang === 'cn' ? (v.nameZh || v.name) : v.name;

          html += '<button type="button" class="theme-card' + (isSelected ? ' selected' : '') + (isCurrentActive ? ' active' : '') + '"'
            + ' data-mode="' + mode + '" data-variant="' + v.id + '"'
            + ' onclick="ThemeSystem.onSwatchClick(this)">';
          html += '  <div class="theme-card-preview" style="background:' + v.swatchColor + ';">';
          html += '    <span class="theme-card-accent" style="background:' + v.primaryColor + ';"></span>';
          html += '  </div>';
          html += '  <div class="theme-card-label">' + escapeHtml(label) + '</div>';
          if (isSelected) {
            html += '  <div class="theme-card-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg></div>';
          }
          html += '</button>';
        }
        html += '  </div>';
        html += '</div>';
      }
    } else {
      // Standard compact row layout
      for (var mi = 0; mi < modes.length; mi++) {
        var mode = modes[mi];
        var variantList = registry[mode] || [];
        html += '<div class="theme-picker-row' + (mode === currentMode ? ' theme-picker-row-active' : '') + '">';
        html += '<span class="theme-picker-icon">' + icons[mode] + '</span>';
        html += '<span class="theme-picker-label">' + modeLabels[mode] + '</span>';
        html += '<span class="theme-picker-swatches">';
        for (var vi = 0; vi < variantList.length; vi++) {
          var v = variantList[vi];
          var isActive = (mode === currentMode && variants[mode] === v.id);
          var label = lang === 'cn' ? (v.nameZh || v.name) : v.name;
          html += '<button type="button" class="theme-swatch' + (isActive ? ' active' : '') + '"'
            + ' data-mode="' + mode + '" data-variant="' + v.id + '"'
            + ' data-tooltip="' + label + '"'
            + ' style="background:' + v.swatchColor + '"'
            + ' onclick="ThemeSystem.onSwatchClick(this)"'
            + '></button>';
        }
        html += '</span>';
        html += '</div>';
      }
    }
    container.innerHTML = html;
  }

  function onSwatchClick(el) {
    var mode = el.getAttribute('data-mode');
    var variant = el.getAttribute('data-variant');
    if (!mode || !variant) return;
    // If clicking a variant for the non-active mode, switch mode too.
    if (mode !== getMode()) {
      applyMode(mode);
      notifyModeChange(mode);
    }
    setVariant(mode, variant);

    requestAnimationFrame(function() {
      if (document.querySelector('#theme-modal-picker-container')) {
        var target = document.querySelector('#theme-modal-picker-container [data-mode="' + mode + '"][data-variant="' + variant + '"]');
        if (target) target.focus();
      }
    });
  }

  // --- Style API ---

  function getStyle() {
    return currentStyle;
  }

  function applyStyle(styleId) {
    currentStyle = styleId;
    document.documentElement.setAttribute('data-theme-style', styleId);
    localStorage.setItem('themeStyle', styleId);
  }

  function setStyle(styleId) {
    applyStyle(styleId);
    persistToBackend();
    renderStylePicker('style-picker');
    renderStylePicker('style-modal-picker-container');
  }

  function getStyleRegistry() {
    return styleRegistry;
  }

  // --- Style Picker UI ---

  function renderStylePicker(targetId) {
    var container = document.getElementById(targetId);
    if (!container) return;
    var lang = document.documentElement.getAttribute('data-lang') || 'en';
    var html = '<div class="style-picker-row">';
    for (var i = 0; i < styleRegistry.length; i++) {
      var s = styleRegistry[i];
      var isActive = (currentStyle === s.id);
      var label = lang === 'cn' ? s.nameZh : s.name;
      html += '<button type="button" class="style-swatch' + (isActive ? ' active' : '') + '"'
        + ' data-style="' + s.id + '"'
        + ' data-tooltip="' + label + '"'
        + ' onclick="ThemeSystem.onStyleClick(this)"'
        + '>' + s.icon + '<span>' + label + '</span></button>';
    }
    html += '</div>';
    container.innerHTML = html;
  }

  function onStyleClick(el) {
    var styleId = el.getAttribute('data-style');
    if (!styleId) return;
    setStyle(styleId);

    requestAnimationFrame(function() {
      if (document.querySelector('#style-modal-picker-container')) {
        var target = document.querySelector('#style-modal-picker-container [data-style="' + styleId + '"]');
        if (target) target.focus();
      }
    });
  }

  // --- Helpers ---

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // --- Public API ---
  return {
    getMode: getMode,
    getVariant: getVariant,
    applyMode: applyMode,
    toggleMode: toggleMode,
    setVariant: setVariant,
    init: init,
    initFromSettings: initFromSettings,
    getRegistry: getRegistry,
    renderThemePicker: renderThemePicker,
    onSwatchClick: onSwatchClick,
    getStyle: getStyle,
    setStyle: setStyle,
    applyStyle: applyStyle,
    getStyleRegistry: getStyleRegistry,
    renderStylePicker: renderStylePicker,
    onStyleClick: onStyleClick
  };
})();
