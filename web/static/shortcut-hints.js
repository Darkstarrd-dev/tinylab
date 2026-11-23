// shortcut-hints.js — Context-aware live Shortcut Hints HUD.
// Loaded immediately after shortcuts.js in both index.html and index-nopg.html.
//
// Responsibilities:
//   1. Maintain a unified hint registry (entries bound to Shortcuts actionIds,
//      shared module binding descriptors, or non-keyboard chord descriptions).
//   2. Inspect live UI state (active modal stack, open nav dropdowns, page/tool,
//      fullscreen/sub-mode flags, visible DOM targets) to filter to shortcuts
//      that are genuinely visible and usable right now.
//   3. Dynamically resolve keystrokes from Shortcuts.effective() — never hardcoded.
//   4. Render Tier A keycap badges next to visible target buttons (without mutating
//      those buttons) and Tier B centered/docked overlay card for buttonless or
//      hidden-UI shortcuts, including Windows Systray global hotkeys in the footer.
//   5. Handle TinyLab brand click + capture-phase Q toggle + Esc dismiss cleanly.
(function(global) {
  'use strict';

  var LAYER_ID = 'shortcut-hints-layer';
  var TRIGGER_ID = 'shortcut-hints-trigger';

  var entries = [];       // ordered registration array
  var entryIndex = {};    // id -> index in entries
  var openState = false;
  var domWired = false;
  var rafId = 0;
  var bodyObserver = null;
  var langObserver = null;
  var resizeBound = false;

  // ----- Helpers -----

  function safeT(key, args, fallback) {
    if (typeof global.t === 'function') {
      var res = args !== undefined ? global.t(key, args) : global.t(key);
      if (res && res !== key) return res;
    }
    var out = fallback !== undefined ? fallback : key;
    if (Array.isArray(args)) {
      for (var i = 0; i < args.length; i++) {
        out = out.replace('{' + i + '}', String(args[i]));
      }
    }
    return out;
  }

  function isMacPlatform() {
    var nav = global.navigator || {};
    return /Mac|iPhone|iPad|iPod/i.test(nav.platform || nav.userAgent || '');
  }

  function modLabel() {
    return isMacPlatform() ? 'Cmd' : 'Ctrl';
  }

  function prettyKey(str) {
    if (!str) return '';
    return String(str)
      .replace(/\bArrowLeft\b/g, '←')
      .replace(/\bArrowRight\b/g, '→')
      .replace(/\bArrowUp\b/g, '↑')
      .replace(/\bArrowDown\b/g, '↓')
      .replace(/\bEscape\b/g, 'Esc')
      .replace(/\bPageUp\b/g, 'PgUp')
      .replace(/\bPageDown\b/g, 'PgDn')
      .replace(/\bDelete\b/g, 'Del');
  }

  function formatRawBinding(b) {
    if (!b) return '';
    if (typeof global.Shortcuts !== 'undefined' && typeof global.Shortcuts.formatBinding === 'function') {
      return prettyKey(global.Shortcuts.formatBinding(b));
    }
    var parts = [];
    if (b.ctrlOrCmd) parts.push(modLabel());
    if (b.alt) parts.push('Alt');
    if (b.shift) parts.push('Shift');
    var k = b.key === ' ' ? 'Space' : (b.key && b.key.length === 1 ? b.key.toUpperCase() : (b.key || ''));
    if (k) parts.push(k);
    return prettyKey(parts.join('+'));
  }

  function normalizeShadowFromBinding(b) {
    if (!b || !b.key) return '';
    var k = String(b.key);
    if (k.length === 1) k = k.toLowerCase();
    else if (k === 'Spacebar' || k === ' ') k = 'space';
    else k = k.toLowerCase();
    return (b.ctrlOrCmd ? 'C+' : '') + (b.alt ? 'A+' : '') + (b.shift ? 'S+' : '') + k;
  }

  function formatEntryKey(entry, ctx) {
    if (typeof entry.formatKey === 'function') {
      return prettyKey(entry.formatKey(ctx) || '');
    }
    if (entry.actionId) {
      if (typeof global.Shortcuts === 'undefined' || typeof global.Shortcuts.effective !== 'function') return '';
      var eff = global.Shortcuts.effective(entry.actionId);
      if (!eff) return '';
      var main = formatRawBinding(eff);
      if (Array.isArray(entry.extraKeys) && entry.extraKeys.length) {
        return main + ' / ' + entry.extraKeys.map(prettyKey).join(' / ');
      }
      return main;
    }
    if (entry.binding) {
      var str = formatRawBinding(entry.binding);
      if (Array.isArray(entry.extraKeys) && entry.extraKeys.length) {
        return str + ' / ' + entry.extraKeys.map(prettyKey).join(' / ');
      }
      return str;
    }
    if (Array.isArray(entry.bindings) && entry.bindings.length) {
      return entry.bindings.map(formatRawBinding).filter(Boolean).join(' / ');
    }
    return prettyKey(entry.keyText || '');
  }

  function resolveShadowKey(entry, ctx) {
    if (entry.allowShare) return '';
    if (typeof entry.shadowKey === 'function') return entry.shadowKey(ctx) || '';
    if (entry.shadowKey) return String(entry.shadowKey);
    if (entry.actionId && typeof global.Shortcuts !== 'undefined' && typeof global.Shortcuts.effective === 'function') {
      return normalizeShadowFromBinding(global.Shortcuts.effective(entry.actionId));
    }
    if (entry.binding) return normalizeShadowFromBinding(entry.binding);
    return '';
  }

  function resolveLabel(entry, ctx) {
    if (typeof entry.getLabel === 'function') return entry.getLabel(ctx);
    if (entry.labelKey) {
      var args = typeof entry.labelArgs === 'function' ? entry.labelArgs(ctx) : entry.labelArgs;
      return safeT(entry.labelKey, args, entry.label || entry.labelKey);
    }
    if (entry.actionId && typeof global.SHORTCUT_PRESETS === 'object') {
      for (var r in global.SHORTCUT_PRESETS) {
        if (Object.prototype.hasOwnProperty.call(global.SHORTCUT_PRESETS[r], entry.actionId)) {
          return global.SHORTCUT_PRESETS[r][entry.actionId].label || entry.actionId;
        }
      }
    }
    return entry.label || entry.id;
  }

  // ----- Context Detection -----

  function isElementVisibleQuick(el) {
    if (!el || !el.isConnected) return false;
    if (el.hidden) return false;
    if (typeof global.getComputedStyle === 'function') {
      var st = global.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    }
    return true;
  }

  function detectTopModal() {
    if (typeof document === 'undefined') return { modal: null, modalEl: null };
    var candidates = [];

    var mainOverlay = document.getElementById('modal-overlay');
    if (mainOverlay && (mainOverlay.classList.contains('show') || mainOverlay.children.length > 0 || typeof global.__confirmResolver === 'function')) {
      candidates.push(mainOverlay);
    }
    var extra = document.querySelectorAll('.modal-overlay.show, .info-modal-overlay.show, .pg-modal-overlay.show, .qs-modal-overlay.show');
    for (var i = 0; i < extra.length; i++) {
      if (extra[i] !== mainOverlay) candidates.push(extra[i]);
    }
    var qsOv = document.getElementById('qs-modal-overlay');
    if (qsOv && candidates.indexOf(qsOv) === -1) candidates.push(qsOv);
    var qsPresetOv = document.getElementById('qs-preset-modal-overlay');
    if (qsPresetOv && candidates.indexOf(qsPresetOv) === -1) candidates.push(qsPresetOv);

    if (!candidates.length) return { modal: null, modalEl: null };

    // Sort by effective z-index, tie-breaking by later DOM order.
    var best = candidates[0];
    var bestZ = -Infinity;
    for (var j = 0; j < candidates.length; j++) {
      var el = candidates[j];
      var z = 0;
      if (typeof global.getComputedStyle === 'function') {
        var parsed = parseInt(global.getComputedStyle(el).zIndex, 10);
        if (!isNaN(parsed)) z = parsed;
      }
      if (z >= bestZ) {
        bestZ = z;
        best = el;
      }
    }

    var id = best.id || '';
    var kind = 'generic-modal';
    if (id === 'qs-modal-overlay') {
      kind = 'qs-modal';
    } else if (id === 'qs-preset-modal-overlay') {
      kind = 'qs-preset-modal';
    } else if (id === 'pg-model-picker-overlay') {
      kind = 'pg-model-picker';
    } else if (id === 'info-modal-overlay') {
      kind = 'info-modal';
    } else if (id === 'pg-modal-overlay') {
      if (typeof global.pgPresetKind === 'string' && global.pgPresetKind) kind = 'pg-preset-modal';
      else if (best.querySelector && best.querySelector('#pg-gc-input')) kind = 'pg-groupchat-modal';
      else kind = 'pg-modal';
    } else if (id === 'modal-overlay') {
      if (best.querySelector('#theme-modal-picker-container')) kind = 'theme-modal';
      else if (best.querySelector('#sc-status')) kind = 'shortcuts-modal';
      else if (best.querySelector('#prompt-input')) kind = 'prompt-modal';
      else if (best.querySelector('#modal-confirm')) kind = 'confirm-modal';
      else if (best.querySelector('#picker-filter')) kind = 'model-picker-modal';
      else kind = 'generic-modal';
    } else {
      if (best.querySelector && best.querySelector('#modal-confirm')) kind = 'confirm-modal';
      else if (best.querySelector && best.querySelector('#prompt-input')) kind = 'prompt-modal';
    }
    return { modal: kind, modalEl: best };
  }

  function resolveEffectivePage() {
    var pg = (typeof currentPage !== 'undefined') ? currentPage
      : (typeof global.currentPage !== 'undefined' ? global.currentPage : 'monitor');
    if (pg === 'utility') {
      return (typeof global.utilityActiveTool !== 'undefined' && global.utilityActiveTool) ? global.utilityActiveTool : 'editor';
    }
    if (pg === 'gallery') {
      return (typeof global.galleryActiveTool !== 'undefined' && global.galleryActiveTool) ? global.galleryActiveTool : 'gallery';
    }
    if (pg === 'demo') {
      return (typeof global.demoActiveTool !== 'undefined' && global.demoActiveTool) ? global.demoActiveTool : 'ademo';
    }
    return pg || 'monitor';
  }

  function collectQuickSlotButtons() {
    var map = {};
    var orders = [];
    if (typeof document === 'undefined') return { map: map, orders: orders };
    var hdr = document.getElementById('quickslot-header');
    if (!hdr) return { map: map, orders: orders };
    var btns = hdr.querySelectorAll('.quickslot-btn');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var numEl = btn.querySelector('.qs-number');
      var n = numEl ? parseInt(numEl.textContent, 10) : (i + 1);
      if (n >= 1 && n <= 9) {
        map[n] = btn;
        orders.push(n);
      }
    }
    return { map: map, orders: orders };
  }

  function collectContext() {
    var hasDoc = typeof document !== 'undefined';
    var loginEl = hasDoc ? document.getElementById('login-overlay') : null;
    var loginVisible = !!(loginEl && isElementVisibleQuick(loginEl));
    var demoStageFS = !!(hasDoc && document.body && document.body.classList.contains('demo-stage-fullscreen'));
    var suppressed = loginVisible ||
      !!global.__nativePickerBusy ||
      !!global.__editorFilePickerBusy ||
      (typeof global.__scActiveCapture !== 'undefined' && !!global.__scActiveCapture) ||
      demoStageFS;

    var modalInfo = detectTopModal();
    var dropdown = null;
    if (typeof global.utilityMenuOpen !== 'undefined' && global.utilityMenuOpen) dropdown = 'utility';
    else if (typeof global.galleryMenuOpen !== 'undefined' && global.galleryMenuOpen) dropdown = 'gallery';
    else if (typeof global.demoMenuOpen !== 'undefined' && global.demoMenuOpen) dropdown = 'demo';

    var page = resolveEffectivePage();
    var hasPlayground = typeof global.__hasPlayground === 'boolean' ? global.__hasPlayground : true;
    var fullscreen = !!(hasDoc && document.body && document.body.classList.contains('gallery-fullscreen-active'));
    var qsInfo = collectQuickSlotButtons();

    var gs = typeof global.galleryState === 'object' && global.galleryState ? global.galleryState : null;
    var galVidActive = gs
      ? (gs.viewMode === 'split' ? gs.focus === 'video' : gs.mediaType === 'video')
      : false;
    var galCurVid = (gs && Array.isArray(gs.videoItems) && gs.videoItems[gs.videoIndex]) ? gs.videoItems[gs.videoIndex] : null;
    var galAnimMode = !!(galCurVid && typeof global.isAnimatedImg === 'function' && global.isAnimatedImg(galCurVid));
    var galReviewActive = !!(gs && gs.reviewState && gs.reviewState.active);
    var galReviewNav = !!(galReviewActive && gs.reviewState && (gs.reviewState.status === 'running' || gs.reviewState.status === 'completed'));

    var ps = typeof global.pgState === 'object' && global.pgState ? global.pgState : null;
    var editingMsg = !!(hasDoc && document.querySelector('#pg-panes .pg-editor'));

    var gifCore = global.GifEditorCore || null;
    var gifSlices = (gifCore && gifCore.state && Array.isArray(gifCore.state.slices)) ? gifCore.state.slices.length : 0;

    var adRt = typeof global.ademoRt === 'object' && global.ademoRt ? global.ademoRt : null;
    var adPersist = typeof global.ademoPersist === 'object' && global.ademoPersist ? global.ademoPersist : null;

    var dgnFocused = !!(hasDoc && document.body && document.body.classList.contains('dgn-preview-focus'));
    var dgnFs = !!(hasDoc && (
      (document.body && document.body.classList.contains('dgn-fullscreen')) ||
      document.querySelector('.dgn-root.dgn-fullscreen, .dgn-fullscreen-stage')
    ));
    var provId = (typeof currentProviderId !== 'undefined') ? currentProviderId
      : (typeof global.currentProviderId !== 'undefined' ? global.currentProviderId : null);

    return {
      suppressed: suppressed,
      demoStageFullscreen: demoStageFS,
      modal: modalInfo.modal,
      modalEl: modalInfo.modalEl,
      dropdown: dropdown,
      page: page,
      hasPlayground: hasPlayground,
      fullscreen: fullscreen,
      providerDetail: !!provId,
      quickslotMap: qsInfo.map,
      quickslotOrders: qsInfo.orders,
      gallery: gs ? {
        active: page === 'gallery',
        viewMode: gs.viewMode || 'single',
        mediaType: gs.mediaType || 'image',
        focus: gs.focus || 'image',
        isVidActive: galVidActive,
        isAnimMode: galAnimMode,
        treeOpen: !!gs.treeOpen,
        metaOverlayEnabled: !!gs.metaOverlayEnabled,
        reviewActive: galReviewActive,
        reviewMode: !!(gs.reviewState && gs.reviewState.reviewMode),
        reviewNav: galReviewNav,
        hasItems: !!(gs.items && gs.items.length),
        hasVideoItems: !!(gs.videoItems && gs.videoItems.length),
        trimMode: !!(hasDoc && document.querySelector('.ge-trim-mode-ctrl'))
      } : null,
      playground: ps ? {
        active: page === 'playground',
        mode: ps.mode || 'normal',
        splitCount: ps.splitCount || 1,
        activeWin: ps.activeWin || 0,
        generating: typeof global.pgIsGenerating === 'function' ? !!global.pgIsGenerating() : false,
        batchActive: !!(ps.mode === 'image' && ps.imageBatch && ps.imageBatch.uiMode !== 'idle'),
        inputMaximized: !!ps.inputMaximized,
        editingMessage: editingMsg
      } : null,
      gif: gifCore && gifCore.state ? {
        active: page === 'gif',
        hasSlices: gifSlices > 0,
        pickColorMode: !!gifCore.state.pickColorMode,
        floodPickMode: !!gifCore.state.floodPickMode
      } : null,
      demo: {
        active: page === 'ademo' || page === 'demo',
        tab: typeof global.ademoActiveTab !== 'undefined' ? global.ademoActiveTab : 'ademo',
        bodyMode: !!(adRt && adRt.bodyMode),
        type1: adPersist ? (adPersist.type1 || 'scroller') : 'scroller'
      },
      designer: {
        active: page === 'design',
        previewFocused: dgnFocused,
        fullscreen: dgnFs
      }
    };
  }

  // ----- Target Resolution & Visibility -----

  function resolveTargetElement(target, ctx) {
    if (!target || typeof document === 'undefined') return null;
    if (typeof target === 'function') return target(ctx) || null;
    if (typeof target === 'string') return document.querySelector(target);
    return target.nodeType === 1 ? target : null;
  }

  function isTargetVisible(el, ctx, layerRect) {
    if (!el || !el.isConnected) return false;
    if (el.disabled) return false;
    if (ctx.modalEl && !ctx.modalEl.contains(el) && el.id !== TRIGGER_ID) return false;
    if (typeof global.getComputedStyle === 'function') {
      var cur = el;
      while (cur && cur.nodeType === 1) {
        var st = global.getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        if (parseFloat(st.opacity) <= 0.05) return false;
        if (cur === document.body) break;
        cur = cur.parentElement;
      }
    }
    if (typeof el.getBoundingClientRect !== 'function') return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (layerRect && (r.right < layerRect.left || r.left > layerRect.right || r.bottom < layerRect.top || r.top > layerRect.bottom)) {
      return false;
    }
    return true;
  }

  // ----- Resolution Pipeline -----

  function resolveContextTitle(ctx) {
    if (ctx.modal) {
      var modalTitleMap = {
        'confirm-modal': 'shCtxModalConfirm',
        'prompt-modal': 'shCtxModalPrompt',
        'theme-modal': 'shCtxModalTheme',
        'shortcuts-modal': 'shCtxModalShortcuts',
        'model-picker-modal': 'shCtxModalModelPicker',
        'pg-model-picker': 'shCtxModalModelPicker',
        'qs-modal': 'shCtxModalQuickSlot',
        'qs-preset-modal': 'shCtxModalPreset',
        'pg-preset-modal': 'shCtxModalPreset',
        'pg-groupchat-modal': 'shCtxModalGroupChat',
        'info-modal': 'shCtxModalInfo',
        'generic-modal': 'shCtxModalGeneric'
      };
      return safeT(modalTitleMap[ctx.modal] || 'shCtxModalGeneric');
    }
    if (ctx.dropdown) return safeT('shCtxMenu');
    if (ctx.providerDetail) return safeT('shCtxProviderDetail');
    var pageTitleMap = {
      monitor: 'shCtxMonitor',
      endpoint: 'shCtxEndpoint',
      providers: 'shCtxEndpoint',
      combos: 'shCtxEndpoint',
      playground: 'shCtxPlayground',
      gallery: 'shCtxGallery',
      music: 'shCtxMusic',
      gif: 'shCtxGif',
      editor: 'shCtxEditor',
      editorV2: 'shCtxEditorV2',
      logReader: 'shCtxUtility',
      review: 'shCtxUtility',
      download: 'shCtxUtility',
      fileTransfer: 'shCtxUtility',
      storyMaker: 'shCtxUtility',
      ademo: 'shCtxDemo',
      tilemap: 'shCtxDemo',
      design: 'shCtxDesigner'
    };
    return safeT(pageTitleMap[ctx.page] || 'shCtxMonitor');
  }

  function resolve(ctxOverride, opts) {
    var ctx = ctxOverride || collectContext();
    var layerRect = opts && opts.layerRect ? opts.layerRect : null;
    var checkDom = !(opts && opts.skipDom);

    var candidates = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (ctx.modal) {
        if (e.group !== 'modal' && e.id !== 'global.toggle-shortcut-hints') continue;
      } else {
        if (e.group === 'modal') continue;
      }
      if (typeof e.when === 'function' && !e.when(ctx)) continue;

      var keyText = formatEntryKey(e, ctx);
      if (!keyText) continue;

      candidates.push({
        entry: e,
        priority: typeof e.priority === 'number' ? e.priority : 0,
        order: i,
        keyText: keyText,
        shadowKey: resolveShadowKey(e, ctx),
        label: resolveLabel(e, ctx)
      });
    }

    candidates.sort(function(a, b) {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.order - b.order;
    });

    var usedShadows = {};
    var survived = [];
    for (var j = 0; j < candidates.length; j++) {
      var item = candidates[j];
      if (item.shadowKey) {
        if (usedShadows[item.shadowKey]) continue;
        usedShadows[item.shadowKey] = true;
      }
      survived.push(item);
    }

    // Restore logical declaration order per group for clean display.
    survived.sort(function(a, b) { return a.order - b.order; });

    var anchored = [];
    var overlay = [];
    for (var k = 0; k < survived.length; k++) {
      var s = survived[k];
      var el = checkDom ? resolveTargetElement(s.entry.target, ctx) : null;
      if (el && isTargetVisible(el, ctx, layerRect)) {
        anchored.push({
          id: s.entry.id,
          group: s.entry.group,
          el: el,
          keyText: s.keyText,
          label: s.label,
          placement: s.entry.placement || 'top-right'
        });
      } else {
        overlay.push({
          id: s.entry.id,
          group: s.entry.group,
          keyText: s.keyText,
          label: s.label
        });
      }
    }

    var systray = [];
    if (typeof global.Shortcuts !== 'undefined' && typeof global.Shortcuts.effective === 'function') {
      var stIds = [
        { id: 'systray.open-browser', labelKey: 'shActSystrayBrowser' },
        { id: 'systray.open-console', labelKey: 'shActSystrayConsole' }
      ];
      for (var si = 0; si < stIds.length; si++) {
        var b = global.Shortcuts.effective(stIds[si].id);
        if (b) {
          systray.push({
            id: stIds[si].id,
            keyText: formatRawBinding(b),
            label: safeT(stIds[si].labelKey)
          });
        }
      }
    }

    return {
      contextTitle: resolveContextTitle(ctx),
      ctx: ctx,
      anchored: anchored,
      overlay: overlay,
      systray: systray
    };
  }

  // ----- Registration API -----

  function registerOne(desc) {
    if (!desc || !desc.id) return;
    if (Object.prototype.hasOwnProperty.call(entryIndex, desc.id)) {
      entries[entryIndex[desc.id]] = desc;
    } else {
      entryIndex[desc.id] = entries.length;
      entries.push(desc);
    }
  }

  function register(input) {
    if (Array.isArray(input)) {
      for (var i = 0; i < input.length; i++) registerOne(input[i]);
    } else {
      registerOne(input);
    }
    if (openState) scheduleRender();
  }

  function unregister(idOrIds) {
    var ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    var removeMap = {};
    for (var i = 0; i < ids.length; i++) removeMap[ids[i]] = true;
    entries = entries.filter(function(e) { return !removeMap[e.id]; });
    entryIndex = {};
    for (var j = 0; j < entries.length; j++) entryIndex[entries[j].id] = j;
    if (openState) scheduleRender();
  }

  // ----- DOM Rendering & Zoom-Safe Geometry -----

  function ensureLayer() {
    var layer = document.getElementById(LAYER_ID);
    if (!layer) {
      layer = document.createElement('div');
      layer.id = LAYER_ID;
      layer.className = 'sh-layer';
      layer.setAttribute('aria-hidden', 'false');
      document.body.appendChild(layer);
    }
    return layer;
  }

  function removeLayer() {
    var layer = document.getElementById(LAYER_ID);
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
  }

  function getModalCardRect(modalEl, layerRect, scaleX, scaleY) {
    if (!modalEl) return null;
    var box = modalEl.querySelector('.modal, .info-modal, .pg-modal, .qs-modal') || modalEl.firstElementChild || modalEl;
    if (!box || typeof box.getBoundingClientRect !== 'function') return null;
    var r = box.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    var w = r.width / scaleX;
    var h = r.height / scaleY;
    var left = (r.left - layerRect.left) / scaleX;
    var top = (r.top - layerRect.top) / scaleY;
    // Expand around center to settled layout dimensions so CSS open transitions
    // (e.g. transform: scale(0.96)) never under-report final modal bounds.
    var settledW = (box.offsetWidth && isFinite(box.offsetWidth)) ? Math.max(w, box.offsetWidth) : w;
    var settledH = (box.offsetHeight && isFinite(box.offsetHeight)) ? Math.max(h, box.offsetHeight) : h;
    var cx = left + w / 2;
    var cy = top + h / 2;
    return {
      left: cx - settledW / 2,
      top: cy - settledH / 2,
      right: cx + settledW / 2,
      bottom: cy + settledH / 2,
      width: settledW,
      height: settledH
    };
  }

  function placeAnchoredBadges(badges, layerW, layerH, layerRect, scaleX, scaleY) {
    var placed = [];
    var margin = 4;

    function overlaps(a, b) {
      return !(a.right + 2 <= b.left || a.left >= b.right + 2 || a.bottom + 2 <= b.top || a.top >= b.bottom + 2);
    }

    function clampPos(x, y, w, h) {
      var cx = Math.max(margin, Math.min(layerW - w - margin, x));
      var cy = Math.max(margin, Math.min(layerH - h - margin, y));
      return { left: cx, top: cy, right: cx + w, bottom: cy + h };
    }

    for (var i = 0; i < badges.length; i++) {
      var item = badges[i];
      var r = item.el.getBoundingClientRect();
      var left = (r.left - layerRect.left) / scaleX;
      var top = (r.top - layerRect.top) / scaleY;
      var right = (r.right - layerRect.left) / scaleX;
      var bottom = (r.bottom - layerRect.top) / scaleY;
      var bw = item.badge.offsetWidth;
      var bh = item.badge.offsetHeight;

      var pref = item.placement || 'top-right';
      var candidates = [];
      if (pref === 'right') {
        candidates.push({ x: right + 6, y: top + (bottom - top - bh) / 2 });
      }
      candidates.push(
        { x: right - bw + 4, y: top - Math.round(bh * 0.55) },
        { x: right - bw + 4, y: bottom - Math.round(bh * 0.45) },
        { x: left - 4, y: top - Math.round(bh * 0.55) },
        { x: left - 4, y: bottom - Math.round(bh * 0.45) },
        { x: left + (right - left - bw) / 2, y: top - bh - 4 },
        { x: left + (right - left - bw) / 2, y: bottom + 4 }
      );

      var chosen = null;
      for (var c = 0; c < candidates.length; c++) {
        var box = clampPos(candidates[c].x, candidates[c].y, bw, bh);
        var hit = false;
        for (var p = 0; p < placed.length; p++) {
          if (overlaps(box, placed[p])) { hit = true; break; }
        }
        if (!hit) { chosen = box; break; }
      }
      if (!chosen) {
        var fallback = clampPos(candidates[0].x, candidates[0].y, bw, bh);
        var step = 0;
        while (step < 5) {
          var shifted = clampPos(fallback.left, fallback.top + (step % 2 === 0 ? 1 : -1) * (Math.ceil((step + 1) / 2) * (bh + 3)), bw, bh);
          var hit2 = false;
          for (var p2 = 0; p2 < placed.length; p2++) {
            if (overlaps(shifted, placed[p2])) { hit2 = true; break; }
          }
          if (!hit2) { chosen = shifted; break; }
          step++;
        }
        if (!chosen) chosen = fallback;
      }

      placed.push(chosen);
      item.badge.style.transform = 'translate3d(' + Math.round(chosen.left) + 'px,' + Math.round(chosen.top) + 'px,0)';
    }
  }

  function positionOverlayCard(card, ctx, layerRect, scaleX, scaleY) {
    var layerW = layerRect.width / scaleX;
    var layerH = layerRect.height / scaleY;
    card.classList.remove('sh-docked-bar', 'sh-docked-side');
    card.style.width = '';
    card.style.maxHeight = '';
    var cw = card.offsetWidth;
    var ch = card.offsetHeight;
    var margin = 12;
    var gap = 14;

    if (!ctx.modalEl) {
      var cx = Math.max(margin, (layerW - cw) / 2);
      var cy = Math.max(margin, (layerH - ch) / 2);
      card.style.transform = 'translate3d(' + Math.round(cx) + 'px,' + Math.round(cy) + 'px,0)';
      return;
    }

    var mRect = getModalCardRect(ctx.modalEl, layerRect, scaleX, scaleY);
    if (!mRect) {
      var cx0 = Math.max(margin, (layerW - cw) / 2);
      var cy0 = Math.max(margin, (layerH - ch) / 2);
      card.style.transform = 'translate3d(' + Math.round(cx0) + 'px,' + Math.round(cy0) + 'px,0)';
      return;
    }

    var availBelow = layerH - margin - (mRect.bottom + gap);
    var availRight = layerW - margin - (mRect.right + gap);
    var availLeft = mRect.left - gap - margin;
    var availAbove = mRect.top - gap - margin;

    var x = (layerW - cw) / 2;
    var y = mRect.bottom + gap;
    if (availBelow >= ch) {
      // fits naturally below modal
    } else if (availRight >= cw) {
      x = mRect.right + gap;
      y = mRect.top + (mRect.height - ch) / 2;
    } else if (availLeft >= cw) {
      x = mRect.left - gap - cw;
      y = mRect.top + (mRect.height - ch) / 2;
    } else if (availAbove >= ch) {
      y = mRect.top - gap - ch;
    } else if (Math.max(availRight, availLeft) >= 220) {
      var useRight = availRight >= availLeft;
      var sideW = useRight ? availRight : availLeft;
      card.classList.add('sh-docked-side');
      card.style.width = Math.min(cw || sideW, Math.floor(sideW)) + 'px';
      card.style.maxHeight = Math.max(160, Math.floor(layerH - margin * 2)) + 'px';
      cw = card.offsetWidth;
      ch = card.offsetHeight;
      x = useRight ? (mRect.right + gap) : (mRect.left - gap - cw);
      y = mRect.top + (mRect.height - ch) / 2;
    } else if (Math.max(availBelow, availAbove) >= 110) {
      var useBelow = availBelow >= availAbove;
      var stripH = useBelow ? availBelow : availAbove;
      card.classList.add('sh-docked-bar');
      card.style.maxHeight = Math.floor(stripH) + 'px';
      cw = card.offsetWidth;
      ch = card.offsetHeight;
      x = (layerW - cw) / 2;
      y = useBelow ? (mRect.bottom + gap) : (mRect.top - gap - ch);
    } else {
      card.classList.add('sh-docked-bar');
      cw = card.offsetWidth;
      ch = card.offsetHeight;
      x = (layerW - cw) / 2;
      y = layerH - ch - margin;
    }
    x = Math.max(margin, Math.min(layerW - cw - margin, x));
    y = Math.max(margin, Math.min(layerH - ch - margin, y));
    card.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
  }

  function buildOverlayCard(res) {
    var card = document.createElement('div');
    card.className = 'sh-overlay-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', safeT('shTitle'));

    // Header
    var header = document.createElement('div');
    header.className = 'sh-card-header';
    var titleWrap = document.createElement('div');
    titleWrap.className = 'sh-card-title-wrap';
    var title = document.createElement('span');
    title.className = 'sh-card-title';
    title.textContent = safeT('shTitle');
    var pill = document.createElement('span');
    pill.className = 'sh-card-ctx-pill';
    pill.textContent = res.contextTitle;
    titleWrap.appendChild(title);
    titleWrap.appendChild(pill);

    var actions = document.createElement('div');
    actions.className = 'sh-card-actions';
    if (!res.ctx.modal && typeof global.openShortcutsModal === 'function') {
      var cfgBtn = document.createElement('button');
      cfgBtn.type = 'button';
      cfgBtn.className = 'sh-card-btn';
      cfgBtn.textContent = safeT('shOpenSettings');
      cfgBtn.addEventListener('click', function() {
        close();
        global.openShortcutsModal();
      });
      actions.appendChild(cfgBtn);
    }
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'sh-card-btn sh-close-btn';
    closeBtn.setAttribute('aria-label', safeT('close', undefined, 'Close'));
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);

    header.appendChild(titleWrap);
    header.appendChild(actions);
    card.appendChild(header);

    // Body (Tier B shortcuts grouped by modal / menu / page / global)
    var body = document.createElement('div');
    body.className = 'sh-card-body';

    var groupOrder = ['modal', 'menu', 'page', 'global'];
    var groupLabels = {
      modal: 'shGroupModal',
      menu: 'shGroupMenu',
      page: 'shGroupPage',
      global: 'shGroupGlobal'
    };

    var hasAnySection = false;
    for (var gi = 0; gi < groupOrder.length; gi++) {
      var g = groupOrder[gi];
      var items = res.overlay.filter(function(it) { return it.group === g; });
      if (!items.length) continue;
      hasAnySection = true;

      var sec = document.createElement('div');
      sec.className = 'sh-section';
      var secTitle = document.createElement('div');
      secTitle.className = 'sh-section-title';
      secTitle.textContent = safeT(groupLabels[g]);
      sec.appendChild(secTitle);

      var grid = document.createElement('div');
      grid.className = 'sh-grid';
      for (var ii = 0; ii < items.length; ii++) {
        var row = document.createElement('div');
        row.className = 'sh-item';
        var lbl = document.createElement('span');
        lbl.className = 'sh-label';
        lbl.textContent = items[ii].label;
        var kbd = document.createElement('kbd');
        kbd.className = 'sh-kbd';
        kbd.textContent = items[ii].keyText;
        row.appendChild(lbl);
        row.appendChild(kbd);
        grid.appendChild(row);
      }
      sec.appendChild(grid);
      body.appendChild(sec);
    }

    if (!hasAnySection) {
      var emptyNote = document.createElement('div');
      emptyNote.className = 'sh-empty-note';
      emptyNote.textContent = safeT('shAllAnchored');
      body.appendChild(emptyNote);
    }
    card.appendChild(body);

    // Footer: Systray global hotkeys + close hint
    var footer = document.createElement('div');
    footer.className = 'sh-card-footer';

    if (res.systray.length) {
      var sysBar = document.createElement('div');
      sysBar.className = 'sh-systray-bar';
      var sysTitle = document.createElement('span');
      sysTitle.className = 'sh-systray-title';
      sysTitle.textContent = safeT('shSystrayLabel') + ':';
      sysBar.appendChild(sysTitle);

      var sysList = document.createElement('div');
      sysList.className = 'sh-systray-list';
      for (var si = 0; si < res.systray.length; si++) {
        var stItem = document.createElement('span');
        stItem.className = 'sh-systray-item';
        var stLbl = document.createElement('span');
        stLbl.textContent = res.systray[si].label;
        var stKbd = document.createElement('kbd');
        stKbd.className = 'sh-kbd';
        stKbd.textContent = res.systray[si].keyText;
        stItem.appendChild(stLbl);
        stItem.appendChild(stKbd);
        sysList.appendChild(stItem);
      }
      sysBar.appendChild(sysList);
      footer.appendChild(sysBar);
    }

    var hintRow = document.createElement('div');
    hintRow.className = 'sh-footer-hint';
    var anchoredNote = document.createElement('span');
    anchoredNote.textContent = res.anchored.length ? safeT('shAnchoredNote') : '';
    var toggleKey = 'Q';
    if (typeof global.Shortcuts !== 'undefined' && typeof global.Shortcuts.formatAction === 'function') {
      toggleKey = prettyKey(global.Shortcuts.formatAction('global.toggle-shortcut-hints')) || toggleKey;
    }
    var closeHint = document.createElement('span');
    closeHint.textContent = safeT('shCloseHint', [toggleKey]);
    if (anchoredNote.textContent) hintRow.appendChild(anchoredNote);
    hintRow.appendChild(closeHint);
    footer.appendChild(hintRow);

    card.appendChild(footer);
    return card;
  }

  function render() {
    if (!openState || typeof document === 'undefined') return;
    var ctx = collectContext();
    if (ctx.suppressed) {
      close();
      return;
    }

    var layer = ensureLayer();
    layer.innerHTML = '';
    var layerRect = layer.getBoundingClientRect();
    var scaleX = layer.offsetWidth ? (layerRect.width / layer.offsetWidth) : 1;
    var scaleY = layer.offsetHeight ? (layerRect.height / layer.offsetHeight) : 1;
    if (!scaleX || !isFinite(scaleX)) scaleX = 1;
    if (!scaleY || !isFinite(scaleY)) scaleY = 1;

    var res = resolve(ctx, { layerRect: layerRect, skipDom: false });

    var badgeNodes = [];
    for (var i = 0; i < res.anchored.length; i++) {
      var a = res.anchored[i];
      var badge = document.createElement('span');
      badge.className = 'sh-badge';
      badge.textContent = a.keyText;
      layer.appendChild(badge);
      badgeNodes.push({ el: a.el, badge: badge, placement: a.placement });
    }

    var card = buildOverlayCard(res);
    layer.appendChild(card);

    placeAnchoredBadges(badgeNodes, layerRect.width / scaleX, layerRect.height / scaleY, layerRect, scaleX, scaleY);
    positionOverlayCard(card, ctx, layerRect, scaleX, scaleY);
  }

  function scheduleRender() {
    if (!openState || typeof global.requestAnimationFrame !== 'function') return;
    if (rafId) return;
    rafId = global.requestAnimationFrame(function() {
      rafId = 0;
      if (openState) render();
    });
  }

  // ----- Lifecycle & Observers -----

  function updateTriggerUI() {
    if (typeof document === 'undefined') return;
    var btn = document.getElementById(TRIGGER_ID);
    if (!btn) return;
    btn.classList.toggle('is-active', openState);
    btn.setAttribute('aria-pressed', openState ? 'true' : 'false');
    var keyStr = 'Q';
    if (typeof global.Shortcuts !== 'undefined' && typeof global.Shortcuts.formatAction === 'function') {
      keyStr = prettyKey(global.Shortcuts.formatAction('global.toggle-shortcut-hints')) || keyStr;
    }
    var tip = safeT('shTriggerTooltip', [keyStr]);
    btn.setAttribute('data-tooltip', tip);
    btn.setAttribute('aria-label', tip);
  }

  function isInsideLayer(node) {
    if (!node) return false;
    var el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest('#' + LAYER_ID));
  }

  function attachOpenObservers() {
    if (typeof document === 'undefined') return;
    if (!bodyObserver && typeof global.MutationObserver === 'function' && document.body) {
      bodyObserver = new global.MutationObserver(function(mutations) {
        if (!openState) return;
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (!isInsideLayer(m.target)) {
            scheduleRender();
            return;
          }
        }
      });
      bodyObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'style', 'disabled', 'aria-expanded', 'aria-current']
      });
    }
    if (!resizeBound) {
      resizeBound = true;
      global.addEventListener('resize', scheduleRender);
      document.addEventListener('scroll', scheduleRender, true);
    }
  }

  function detachOpenObservers() {
    if (rafId && typeof global.cancelAnimationFrame === 'function') {
      global.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }
    if (resizeBound && typeof document !== 'undefined') {
      resizeBound = false;
      global.removeEventListener('resize', scheduleRender);
      document.removeEventListener('scroll', scheduleRender, true);
    }
  }

  function open() {
    var ctx = collectContext();
    if (ctx.suppressed) return false;
    openState = true;
    updateTriggerUI();
    attachOpenObservers();
    render();
    return true;
  }

  function close() {
    if (!openState && typeof document !== 'undefined' && !document.getElementById(LAYER_ID)) return false;
    openState = false;
    detachOpenObservers();
    if (typeof document !== 'undefined') removeLayer();
    updateTriggerUI();
    return true;
  }

  function toggle() {
    return openState ? close() : open();
  }

  // ----- Input Guards & Capture-Phase Hotkey Handler -----

  function isEditableTarget(target, activeEl) {
    var nodes = [target, activeEl];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || el.nodeType !== 1) continue;
      var tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT') return true;
      if (tag === 'TEXTAREA' && !el.readOnly) return true;
      if (el.isContentEditable) return true;
      if (el.closest && el.closest('.monaco-editor')) return true;
    }
    return false;
  }

  function onDocumentKeyDown(e) {
    if (!e) return;
    if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return;
    var ctx = collectContext();
    if (ctx.suppressed) return;

    // 1. When HUD is open, Escape closes ONLY the HUD (capture + stopImmediatePropagation)
    //    so fullscreen / modals / shutdown-server underneath are never triggered.
    if (openState && e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }

    // 2. Toggle shortcut (default Q) — respects user overrides in Shortcuts.
    if (typeof global.Shortcuts !== 'undefined' && typeof global.Shortcuts.matchEvent === 'function') {
      if (global.Shortcuts.matchEvent('global.toggle-shortcut-hints', e)) {
        var active = typeof document !== 'undefined' ? document.activeElement : null;
        if (isEditableTarget(e.target, active)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        toggle();
      }
    }
  }

  function wireDomOnce() {
    if (domWired || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    domWired = true;

    document.addEventListener('keydown', onDocumentKeyDown, true);

    var bindTrigger = function() {
      var btn = document.getElementById(TRIGGER_ID);
      if (btn && !btn.__shBound) {
        btn.__shBound = true;
        btn.addEventListener('click', function(ev) {
          ev.preventDefault();
          toggle();
        });
      }
      updateTriggerUI();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindTrigger);
    } else {
      bindTrigger();
    }

    if (typeof global.Shortcuts !== 'undefined' && typeof global.Shortcuts.onChange === 'function') {
      global.Shortcuts.onChange(function() {
        updateTriggerUI();
        if (openState) scheduleRender();
      });
    }

    if (typeof global.MutationObserver === 'function' && document.documentElement) {
      langObserver = new global.MutationObserver(function() {
        updateTriggerUI();
        if (openState) scheduleRender();
      });
      langObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-lang', 'data-theme', 'data-theme-variant', 'data-theme-style', 'data-font-size', 'style']
      });
    }
  }

  // ----- Core Built-in Registrations (Global, Zoom, Menus, Modals, Provider Detail) -----

  function registerCoreEntries() {
    var mod = modLabel();

    register([
      // Global toggle (also shown on TinyLab brand trigger)
      {
        id: 'global.toggle-shortcut-hints',
        actionId: 'global.toggle-shortcut-hints',
        group: 'global',
        priority: 95,
        allowShare: true,
        labelKey: 'shActToggleHints',
        when: function() { return true; },
        target: '#' + TRIGGER_ID,
        placement: 'right'
      },
      // Top-header navigation (F1-F6)
      {
        id: 'global.goto-monitor',
        actionId: 'global.goto-monitor',
        group: 'global',
        priority: 30,
        labelKey: 'shActGotoMonitor',
        when: function(ctx) { return !ctx.modal && !ctx.dropdown; },
        target: '.nav-item[data-page="monitor"]'
      },
      {
        id: 'global.goto-endpoint',
        actionId: 'global.goto-endpoint',
        group: 'global',
        priority: 30,
        labelKey: 'shActGotoEndpoint',
        when: function(ctx) { return !ctx.modal && !ctx.dropdown; },
        target: '.nav-item[data-page="endpoint"]'
      },
      {
        id: 'global.goto-playground',
        actionId: 'global.goto-playground',
        group: 'global',
        priority: 30,
        labelKey: 'shActGotoPlayground',
        when: function(ctx) { return !ctx.modal && !ctx.dropdown && ctx.hasPlayground; },
        target: '.nav-item[data-page="playground"]'
      },
      {
        id: 'global.goto-download',
        actionId: 'global.goto-download',
        group: 'global',
        priority: 30,
        labelKey: 'shActGotoUtility',
        when: function(ctx) { return !ctx.modal && !ctx.dropdown; },
        target: '.nav-item[data-page="utility"]'
      },
      {
        id: 'global.goto-gallery',
        actionId: 'global.goto-gallery',
        group: 'global',
        priority: 30,
        labelKey: 'shActGotoGallery',
        when: function(ctx) { return !ctx.modal && !ctx.dropdown; },
        target: '.nav-item[data-page="gallery"]'
      },
      {
        id: 'global.goto-demo',
        actionId: 'global.goto-demo',
        group: 'global',
        priority: 30,
        labelKey: 'shActGotoDemo',
        when: function(ctx) { return !ctx.modal && !ctx.dropdown; },
        target: '.nav-item[data-page="demo"]'
      }
    ]);

    // QuickSlots 1-9 (only slots currently configured/visible in header)
    for (var n = 1; n <= 9; n++) {
      (function(slotNum) {
        register({
          id: 'global.quickslot-cycle-' + slotNum,
          actionId: 'global.quickslot-cycle-' + slotNum,
          group: 'global',
          priority: 28,
          labelKey: 'shActQuickslotN',
          labelArgs: [slotNum],
          when: function(ctx) {
            if (ctx.modal || ctx.dropdown || ctx.quickslotOrders.indexOf(slotNum) === -1) return false;
            if (ctx.gallery && ctx.gallery.active && typeof global.Shortcuts !== 'undefined' && typeof global.Shortcuts.effective === 'function') {
              var b = global.Shortcuts.effective('global.quickslot-cycle-' + slotNum);
              if (b && !b.ctrlOrCmd && !b.alt && !b.shift && /^[1-9]$/.test(String(b.key || ''))) return false;
            }
            return true;
          },
          target: function(ctx) {
            return (ctx.quickslotMap && ctx.quickslotMap[slotNum]) || null;
          }
        });
      })(n);
    }

    register([
      {
        id: 'global.toggle-fullscreen',
        actionId: 'global.toggle-fullscreen',
        group: 'global',
        priority: 25,
        labelKey: 'shActFullscreen',
        when: function(ctx) { return !ctx.modal && !ctx.dropdown; }
      },
      {
        id: 'global.shutdown-server',
        actionId: 'global.shutdown-server',
        group: 'global',
        priority: 10,
        labelKey: 'shActShutdown',
        when: function(ctx) { return !ctx.modal && !ctx.dropdown; },
        target: '.shutdown-btn'
      },
      {
        id: 'zoom.wheel',
        keyText: mod + '+Wheel',
        group: 'global',
        priority: 12,
        allowShare: true,
        labelKey: 'shActZoomScroll',
        when: function(ctx) { return !ctx.modal; }
      },
      {
        id: 'zoom.reset',
        keyText: mod + '+0 / ' + mod + '+Middle',
        group: 'global',
        priority: 12,
        allowShare: true,
        labelKey: 'shActZoomReset',
        when: function(ctx) { return !ctx.modal; }
      },
      // Provider Detail Back (Esc shadows global shutdown)
      {
        id: 'provider.back',
        binding: { key: 'Escape' },
        group: 'page',
        priority: 60,
        labelKey: 'shActBackProviderList',
        when: function(ctx) { return !ctx.modal && !ctx.dropdown && ctx.providerDetail; },
        target: '.provider-detail-header .btn, .detail-header .btn'
      },
      // Open header dropdown menu (Utility / Gallery / Demo)
      {
        id: 'menu.nav',
        keyText: '↑ / ↓',
        group: 'menu',
        priority: 75,
        allowShare: true,
        labelKey: 'shActMenuNav',
        when: function(ctx) { return !ctx.modal && !!ctx.dropdown; }
      },
      {
        id: 'menu.open',
        binding: { key: 'Enter' },
        group: 'menu',
        priority: 75,
        labelKey: 'shActMenuOpen',
        when: function(ctx) { return !ctx.modal && !!ctx.dropdown; }
      },
      {
        id: 'menu.close',
        binding: { key: 'Escape' },
        group: 'menu',
        priority: 75,
        labelKey: 'shActMenuClose',
        when: function(ctx) { return !ctx.modal && !!ctx.dropdown; }
      },

      // ----- Active Modal Shortcuts -----
      {
        id: 'modal.theme.tab',
        binding: { key: 'Tab' },
        group: 'modal',
        priority: 100,
        labelKey: 'shActThemeGroupSwitch',
        when: function(ctx) { return ctx.modal === 'theme-modal'; }
      },
      {
        id: 'modal.theme.arrows',
        keyText: '↑ / ↓ / ← / →',
        group: 'modal',
        priority: 100,
        allowShare: true,
        labelKey: 'shActThemeCardNav',
        when: function(ctx) { return ctx.modal === 'theme-modal'; }
      },
      {
        id: 'modal.theme.space',
        binding: { key: ' ' },
        group: 'modal',
        priority: 100,
        labelKey: 'shActThemeSelect',
        when: function(ctx) { return ctx.modal === 'theme-modal'; }
      },
      {
        id: 'modal.theme.enter',
        binding: { key: 'Enter' },
        group: 'modal',
        priority: 100,
        labelKey: 'shActThemeSave',
        when: function(ctx) { return ctx.modal === 'theme-modal'; },
        target: '#settings-modal-save'
      },
      {
        id: 'modal.qs.arrows',
        keyText: '↑ / ↓',
        group: 'modal',
        priority: 100,
        allowShare: true,
        labelKey: 'shActQsMove',
        when: function(ctx) { return ctx.modal === 'qs-modal' || ctx.modal === 'qs-preset-modal' || ctx.modal === 'pg-preset-modal'; }
      },
      {
        id: 'modal.qs.digits',
        keyText: '1–9',
        group: 'modal',
        priority: 100,
        allowShare: true,
        labelKey: 'shActQsNext',
        when: function(ctx) { return ctx.modal === 'qs-modal'; }
      },
      {
        id: 'modal.qs.enter',
        binding: { key: 'Enter' },
        group: 'modal',
        priority: 100,
        labelKey: 'shActQsApply',
        when: function(ctx) { return ctx.modal === 'qs-modal' || ctx.modal === 'qs-preset-modal' || ctx.modal === 'pg-preset-modal'; }
      },
      {
        id: 'modal.qs.delete',
        binding: { key: 'Delete' },
        extraKeys: ['Backspace'],
        group: 'modal',
        priority: 100,
        labelKey: 'shActQsDelete',
        when: function(ctx) { return ctx.modal === 'qs-modal' || ctx.modal === 'qs-preset-modal' || ctx.modal === 'pg-preset-modal'; }
      },
      {
        id: 'modal.qs.import',
        keyText: '+ / =',
        group: 'modal',
        priority: 100,
        allowShare: true,
        labelKey: 'shActQsImport',
        when: function(ctx) { return ctx.modal === 'qs-modal'; },
        target: '#qs-modal-overlay .qs-modal-import-item'
      },
      {
        id: 'modal.qspreset.add',
        keyText: '+ / =',
        group: 'modal',
        priority: 100,
        allowShare: true,
        labelKey: 'shActQsPresetAdd',
        when: function(ctx) { return ctx.modal === 'qs-preset-modal'; },
        target: '#qs-preset-modal-overlay .qs-modal-add-btn'
      },
      {
        id: 'modal.pgpicker.arrows',
        keyText: '↑ / ↓',
        group: 'modal',
        priority: 100,
        allowShare: true,
        labelKey: 'shActPickerSelect',
        when: function(ctx) { return ctx.modal === 'pg-model-picker'; }
      },
      {
        id: 'modal.pgpicker.tab',
        binding: { key: 'Tab' },
        group: 'modal',
        priority: 100,
        labelKey: 'shActPickerTab',
        when: function(ctx) { return ctx.modal === 'pg-model-picker'; }
      },
      {
        id: 'modal.pgpicker.alpha',
        keyText: 'A–Z / 0–9',
        group: 'modal',
        priority: 100,
        allowShare: true,
        labelKey: 'shActPickerJump',
        when: function(ctx) { return ctx.modal === 'pg-model-picker'; }
      },
      {
        id: 'modal.pgpicker.enter',
        binding: { key: 'Enter' },
        group: 'modal',
        priority: 100,
        labelKey: 'shActPickerConfirm',
        when: function(ctx) { return ctx.modal === 'pg-model-picker'; },
        target: '#pg-model-picker-ok'
      },
      {
        id: 'modal.generic.tab',
        binding: { key: 'Tab' },
        extraKeys: ['Shift+Tab'],
        group: 'modal',
        priority: 95,
        labelKey: 'shActModalFocusCycle',
        when: function(ctx) {
          return ctx.modal === 'confirm-modal' || ctx.modal === 'prompt-modal' ||
            ctx.modal === 'shortcuts-modal' || ctx.modal === 'model-picker-modal' ||
            ctx.modal === 'info-modal' || ctx.modal === 'generic-modal';
        }
      },
      {
        id: 'modal.generic.arrows',
        keyText: '↑ / ↓ / ← / →',
        group: 'modal',
        priority: 95,
        allowShare: true,
        labelKey: 'shActModalFocusBtns',
        when: function(ctx) {
          return ctx.modal === 'confirm-modal' || ctx.modal === 'shortcuts-modal' ||
            ctx.modal === 'model-picker-modal' || ctx.modal === 'info-modal' || ctx.modal === 'generic-modal';
        }
      },
      {
        id: 'modal.generic.enter',
        binding: { key: 'Enter' },
        group: 'modal',
        priority: 95,
        labelKey: 'shActModalConfirm',
        when: function(ctx) {
          return ctx.modal === 'confirm-modal' || ctx.modal === 'prompt-modal' ||
            ctx.modal === 'shortcuts-modal' || ctx.modal === 'model-picker-modal' ||
            ctx.modal === 'info-modal' || ctx.modal === 'generic-modal';
        },
        target: function(ctx) {
          if (!ctx.modalEl) return null;
          return ctx.modalEl.querySelector('#modal-confirm, #prompt-confirm, #picker-confirm, #settings-modal-save, #dl-settings-save, .btn-primary');
        }
      },
      {
        id: 'modal.groupchat.send',
        actionId: 'pg.send-group-message',
        group: 'modal',
        priority: 100,
        labelKey: 'shActPgSend',
        when: function(ctx) { return ctx.modal === 'pg-groupchat-modal'; },
        target: '#pg-modal-overlay .pg-gc-input-bar .pg-send'
      },
      {
        id: 'modal.close',
        binding: { key: 'Escape' },
        group: 'modal',
        priority: 95,
        labelKey: 'shActModalClose',
        when: function(ctx) { return !!ctx.modal; },
        target: function(ctx) {
          if (!ctx.modalEl) return null;
          return ctx.modalEl.querySelector('#modal-cancel, #prompt-cancel, #picker-cancel, #pg-model-picker-cancel, #dl-settings-cancel, .pg-modal-close, .info-modal-close, .modal-footer .btn-ghost');
        }
      }
    ]);
  }

  registerCoreEntries();
  wireDomOnce();

  global.ShortcutHints = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function() { return openState; },
    refresh: scheduleRender,
    register: register,
    unregister: unregister,
    getEntries: function() { return entries.slice(); },
    collectContext: collectContext,
    resolve: resolve,
    prettyKey: prettyKey,
    isEditableTarget: isEditableTarget,
    _onDocumentKeyDown: onDocumentKeyDown
  };
})(typeof window !== 'undefined' ? window : this);
