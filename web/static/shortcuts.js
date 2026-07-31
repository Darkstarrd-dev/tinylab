// ===================== Shortcut Registry =====================
//
// Central source of truth for keyboard shortcuts and their user overrides.
//
// Design:
//  - SHORTCUT_PRESETS holds the system default bindings, grouped by region.
//  - Each actionID (e.g. "global.goto-monitor") maps to a default binding
//    {key, ctrlOrCmd, alt, shift}. Modifiers are omitted when false.
//  - User overrides live in a map<actionID, binding> loaded from
//    /api/settings (config.yaml). Only actions the user explicitly
//    rebound are present; everything else falls back to the preset.
//  - Shortcuts.matchEvent(actionID, e) is the single entry point used by
//    every keydown handler in the app. It compares an effective binding
//    (preset merged with any override) against a KeyboardEvent.
//  - The Shortcut Settings UI mutates overrides in memory and the Save
//    button persists the full overrides map via PATCH /api/settings.
//
// This file is loaded BEFORE endpoint.js (and before any module that
// calls matchEvent), so Shortcuts is always available.

// ----- System presets -----

var SHORTCUT_PRESETS = {
  global: {
    'global.goto-monitor':     { key: 'F1', label: 'Go to Monitor' },
    'global.goto-endpoint':    { key: 'F2', label: 'Go to Settings' },
    'global.goto-playground':  { key: 'F3', label: 'Go to Playground' },
    'global.goto-download':    { key: 'F5', label: 'Go to Download' },
    'global.goto-gallery':     { key: 'F4', label: 'Toggle Gallery / Editor' },
    'global.quickslot-cycle-1': { key: '1', label: 'Quickslot #1' },
    'global.quickslot-cycle-2': { key: '2', label: 'Quickslot #2' },
    'global.quickslot-cycle-3': { key: '3', label: 'Quickslot #3' },
    'global.quickslot-cycle-4': { key: '4', label: 'Quickslot #4' },
    'global.quickslot-cycle-5': { key: '5', label: 'Quickslot #5' },
    'global.quickslot-cycle-6': { key: '6', label: 'Quickslot #6' },
    'global.quickslot-cycle-7': { key: '7', label: 'Quickslot #7' },
    'global.quickslot-cycle-8': { key: '8', label: 'Quickslot #8' },
    'global.quickslot-cycle-9': { key: '9', label: 'Quickslot #9' },
    'global.shutdown-server':  { key: 'Escape', label: 'Shutdown Server (no modal)' },
    'global.toggle-fullscreen':{ key: 'f', label: 'Toggle fullscreen' }
  },
  playground: {
    'pg.send-message':        { key: 'Enter', label: 'Send message (main input)' },
    'pg.apply-edit':          { ctrlOrCmd: true, key: 'Enter', label: 'Apply message edit' },
    'pg.cancel-edit':         { key: 'Escape', label: 'Cancel message edit' },
    'pg.send-group-message':  { key: 'Enter', label: 'Send message (group chat input)' }
  },
  gallery: {
    'gallery.toggle-split':     { key: 'd', label: 'Toggle split view' },
    'gallery.toggle-media':     { key: 'm', label: 'Toggle media type' },
    'gallery.switch-focus':      { key: 'Tab', label: 'Switch focus (split only)' },
    'gallery.prev':             { key: 'ArrowLeft', label: 'Previous item' },
    'gallery.next':             { key: 'ArrowRight', label: 'Next item' },
    'gallery.prev-folder':      { key: 'ArrowUp', label: 'Previous folder' },
    'gallery.next-folder':      { key: 'ArrowDown', label: 'Next folder' },
    'gallery.toggle-autoplay':  { key: 'a', label: 'Toggle autoplay' },
    'gallery.toggle-fullscreen':{ key: 'f', label: 'Toggle fullscreen' },
    'gallery.toggle-tree':      { key: 't', label: 'Toggle tree panel' },
    'gallery.clear-tree':       { key: 'c', label: 'Clear focused tree (tree open only)' },
    'gallery.exit-fullscreen':  { key: 'Escape', label: 'Exit fullscreen (Enter also works)' }
  }
};

// Region metadata for UI tab rendering. The order here is the tab order
// shown in the Shortcut Settings modal. Whether each region tab is shown
// is decided at render time by the caller (see openShortcutsModal) based
// on window.__hasPlayground.
var SHORTCUT_REGIONS = [
  { id: 'global',     label: 'Global' },
  { id: 'playground', label: 'Playground' },
  { id: 'gallery',    label: 'Gallery' }
];

// ----- Override storage (in-memory cache; persisted via PATCH /settings) -----

var __scOverrides = {}; // actionID -> binding (only actions explicitly rebound)

// ----- Helpers -----

function __scCloneBinding(b) {
  return { key: b.key, ctrlOrCmd: !!b.ctrlOrCmd, alt: !!b.alt, shift: !!b.shift };
}

function __scNormalizeBinding(b) {
  if (!b || !b.key) return null;
  return { key: String(b.key), ctrlOrCmd: !!b.ctrlOrCmd, alt: !!b.alt, shift: !!b.shift };
}

// Whether the implementer considers Ctrl or Cmd as the "CtrlOrCmd" modifier
// on the current platform. macOS: metaKey; others: ctrlKey.
function __scIsCtrlOrCmd(e) {
  if (/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')) {
    return !!e.metaKey;
  }
  return !!e.ctrlKey;
}

function __scBindingsEqual(a, b) {
  if (!a || !b) return false;
  return a.key === b.key && !!a.ctrlOrCmd === !!b.ctrlOrCmd && !!a.alt === !!b.alt && !!a.shift === !!b.shift;
}

// ----- Public API -----

var Shortcuts = {
  // Returns all region metadata (label + ordered action IDs).
  // The UI uses this to render tabs and rows.
  getAllRegions: function() {
    return SHORTCUT_REGIONS.map(function(r) {
      var actions = [];
      var region = SHORTCUT_PRESETS[r.id] || {};
      for (var actionId in region) {
        if (Object.prototype.hasOwnProperty.call(region, actionId)) {
          actions.push(actionId);
        }
      }
      return { id: r.id, label: r.label, actions: actions };
    });
  },

  // Returns the default binding for an action, or null if unknown.
  defaultBinding: function(actionId) {
    var region = __scRegionForAction(actionId);
    if (!region) return null;
    var preset = SHORTCUT_PRESETS[region][actionId];
    return preset ? __scCloneBinding(preset) : null;
  },

  // Returns the user-overridden binding for an action, or null if none.
  // Note: this returns the override only, not the effective binding.
  overrideBinding: function(actionId) {
    if (!Object.prototype.hasOwnProperty.call(__scOverrides, actionId)) return null;
    return __scCloneBinding(__scOverrides[actionId]);
  },

  // Returns the binding that should be in effect for an action:
  // user override when present, otherwise the system preset.
  effective: function(actionId) {
    var region = __scRegionForAction(actionId);
    if (!region) return null;
    if (Object.prototype.hasOwnProperty.call(__scOverrides, actionId)) {
      return __scCloneBinding(__scOverrides[actionId]);
    }
    var preset = SHORTCUT_PRESETS[region][actionId];
    return preset ? __scCloneBinding(preset) : null;
  },

  // True iff the KeyboardEvent matches the effective binding for actionId.
  // Conservative rules:
  //  - key must equal (case-sensitive for letters via upper-case compare to
  //    tolerate Shift state; for single-letter shortcuts 'd' matches both
  //    'd' and 'D' to match the original gallery literals which matched both)
  //  - ctrl/cmd, alt, shift modifier flags must match exactly.
  //  - Tab/Space/Arrow/special keys are compared verbatim.
  matchEvent: function(actionId, e) {
    var b = Shortcuts.effective(actionId);
    if (!b || !b.key) return false;
    if (!!b.ctrlOrCmd !== __scIsCtrlOrCmd(e)) return false;
    if (!!b.alt !== !!e.altKey) return false;
    if (!!b.shift !== !!e.shiftKey) return false;
    if (e.key == null) return false;
    // Single-letter/F-key/named keys all compare case-insensitively against
    // event.key when the binding has no shift modifier requirement.
    if (b.key.length === 1 && /[a-z0-9]/i.test(b.key)) {
      return e.key.toLowerCase() === b.key.toLowerCase() || e.key === b.key;
    }
    // Arrow keys / 'Tab' / 'Escape' / 'Enter' / 'Space' etc. compare verbatim
    // but tolerate 'Spacebar' (legacy) for ' '.
    if (b.key === ' ') {
      return e.key === ' ' || e.key === 'Spacebar';
    }
    return e.key === b.key;
  },

  // Load user overrides from the /api/settings response. Replaces the
  // entire in-memory override map. Pass {} to clear all overrides.
  loadOverrides: function(map) {
    __scOverrides = {};
    if (!map) return;
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      var b = __scNormalizeBinding(map[k]);
      if (b) __scOverrides[k] = b;
    }
  },

  // Returns a shallow copy of the current overrides map (for serialization
  // before PATCH /settings).
  getAllOverrides: function() {
    var out = {};
    for (var k in __scOverrides) {
      if (Object.prototype.hasOwnProperty.call(__scOverrides, k)) {
        out[k] = __scCloneBinding(__scOverrides[k]);
      }
    }
    return out;
  },

  // Record/replace a user override for actionId. The binding must be a
  // valid object {key, ...modifiers}; invalid bindings are rejected.
  // Returns true on success, false otherwise.
  setOverride: function(actionId, binding) {
    if (!__scRegionForAction(actionId)) return false;
    var b = __scNormalizeBinding(binding);
    if (!b) return false;
    __scOverrides[actionId] = b;
    return true;
  },

  // Remove the override for actionId, falling back to the system preset.
  clearOverride: function(actionId) {
    delete __scOverrides[actionId];
  },

  // Remove every override.
  clearAll: function() {
    __scOverrides = {};
  },

  // True if an override currently exists for actionId.
  hasOverride: function(actionId) {
    return Object.prototype.hasOwnProperty.call(__scOverrides, actionId);
  },

  // Find any actionID within the same region whose effective binding equals
  // `binding`. Excludes `exceptActionId`. Returns the colliding actionID or null.
  // Used by the Shortcut Settings UI to prevent same-region conflicts.
  findConflict: function(regionId, binding, exceptActionId) {
    var b = __scNormalizeBinding(binding);
    if (!b) return null;
    var region = SHORTCUT_PRESETS[regionId] || {};
    for (var actionId in region) {
      if (!Object.prototype.hasOwnProperty.call(region, actionId)) continue;
      if (actionId === exceptActionId) continue;
      var eff = Shortcuts.effective(actionId);
      if (eff && __scBindingsEqual(eff, b)) return actionId;
    }
    return null;
  },

  // Render a binding as a human-friendly keystroke string (e.g. "Ctrl+Enter",
  // "Shift+F7", "M"). Used by the Shortcut Settings UI.
  formatBinding: function(b) {
    if (!b) return '';
    var parts = [];
    if (b.ctrlOrCmd) {
      if (/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')) parts.push('Cmd');
      else parts.push('Ctrl');
    }
    if (b.alt) parts.push('Alt');
    if (b.shift && b.key.length > 1) parts.push('Shift'); // only show Shift for multi-char keys
    var k = b.key;
    if (k === ' ') k = 'Space';
    else if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join('+');
  }
};

// Internal: lookup which region an actionID belongs to. Returns the region
// id or null.
function __scRegionForAction(actionId) {
  for (var region in SHORTCUT_PRESETS) {
    if (!Object.prototype.hasOwnProperty.call(SHORTCUT_PRESETS, region)) continue;
    if (Object.prototype.hasOwnProperty.call(SHORTCUT_PRESETS[region], actionId)) return region;
  }
  return null;
}

// Expose for console debugging / unit inspection.
window.Shortcuts = Shortcuts;
window.SHORTCUT_PRESETS = SHORTCUT_PRESETS;
