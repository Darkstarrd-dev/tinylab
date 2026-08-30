// ===================== Assistant Settings: Model Picker + Action Editor =====================
// Split from settings_modal.js. openAssistantModal keeps its shell there; this
// file provides:
//   - openAssistantModelPicker: playground-style model picker stacked in its
//     own overlay (fetch /api/models, text-kind list, filter input, keyboard
//     nav) writing into the hidden #settings-modal-assistant-model input. A
//     separate overlay is required because app.js::openModelPickerModal would
//     replace the still-open settings modal rendered in #modal-overlay.
//   - Action list + per-action editor modal: spritesheet picked via the native
//     OS picker (/api/browse) and previewed through /api/assistant/sheet-preview,
//     grid split (cols×rows), 0-based row-major frame range selection by
//     click/drag on the canvas or numeric inputs (0 = top-left cell,
//     N-1 = bottom-right), and fps.
// Draft state lives in window.__assistantActions; saveAssistantModal
// (settings_modal.js) reads it on Save.
'use strict';

var __assistantModelsCache = null;
var __assistantPickerCb = null;

function assistantEscape(s) {
  return typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s);
}

function assistantActionSummary(a) {
  if (!a || !a.spritesheetPath) return t('assistantActionNoSheet') + (a && a.mirror ? ' · mirrored' : '');
  var grid = (a.cols || 1) + '×' + (a.rows || 1);
  return grid + ' · ' + t('assistantActionSummaryFrames', [String(a.frameStart || 0), String(a.frameEnd || 0)]) + ' · ' + (a.fps || 8) + ' fps' + (a.mirror ? ' · mirrored' : '');
}

function assistantActionRowHtml(a, i) {
  // Polished row: badge-like name + secondary summary, consistent with modal token density.
  return '<div class="assistant-action-row" data-index="' + i + '" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--glass-border);border-radius:var(--radius-md);margin-bottom:8px;background:var(--option-bg)">' +
    '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">' +
      '<span style="font-weight:700;font-size:13px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + assistantEscape(a.name || ('#' + (i + 1))) + '</span>' +
      '<span class="muted" style="font-size:11px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + assistantEscape(assistantActionSummary(a)) + '</span>' +
    '</div>' +
    '<button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px" onclick="assistantEditAction(' + i + ')">' + assistantEscape(t('assistantActionEdit')) + '</button>' +
    '<button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px;color:var(--danger,#e5484d)" onclick="assistantRemoveAction(' + i + ')">' + assistantEscape(t('assistantActionRemove')) + '</button>' +
  '</div>';
}

// Actions are grouped by the preset their name belongs to (first match wins,
// Moves first; other groups keep only non-move names.
function assistantActionGroupOf(name) {
  var low = (name || '').toLowerCase();
  if (__assistantMoveActions.indexOf(low) >= 0) return 'move';
  // pet/platformer/topdown non-move only
  if (['drag','think','reply','error','notify','poke'].indexOf(low) >= 0) return 'pet';
  if (['jump','fall'].indexOf(low) >= 0) return 'platformer';
  if (['attack'].indexOf(low) >= 0) return 'topdown';
  return 'other';
}

function renderAssistantActions() {
  var box = document.getElementById('settings-assistant-actions');
  if (!box) return;
  var actions = window.__assistantActions || [];
  var html = '<div class="assistant-action-row" style="display:flex;gap:8px;margin-bottom:10px">' +
    '<input type="text" class="input" id="settings-assistant-new-action" placeholder="' + assistantEscape(t('assistantActionNamePlaceholder')) + '" style="flex:1;min-width:0;height:36px" onkeydown="if(event.key===\'Enter\'){event.preventDefault();assistantAddAction();}">' +
    '<button type="button" class="btn btn-primary" style="padding:0 16px;height:36px;flex-shrink:0" onclick="assistantAddAction()">' + assistantEscape(t('assistantActionAdd')) + '</button>' +
  '</div>';
  if (!actions.length) {
    box.innerHTML = html + '<p class="muted" style="margin:2px 0 4px;font-size:12px;line-height:1.5">' + assistantEscape(t('assistantActionNone')) + '</p>';
    return;
  }
  var buckets = { move: [], pet: [], platformer: [], topdown: [], other: [] };
  for (var i = 0; i < actions.length; i++) {
    buckets[assistantActionGroupOf(actions[i] && actions[i].name)].push(i);
  }
  var groupDefs = [
    { id: 'move',       label: t('assistantGroupMove') || 'Move' },
    { id: 'pet',        label: t('assistantStateGroupPet') },
    { id: 'platformer', label: t('assistantStateGroupPlatformer') },
    { id: 'topdown',    label: t('assistantStateGroupTopdown') },
    { id: 'other',      label: t('assistantGroupOther') }
  ];
  for (var g = 0; g < groupDefs.length; g++) {
    var gd = groupDefs[g];
    var idxs = buckets[gd.id];
    if (!idxs.length && gd.id === 'other') continue; // hide empty Other
    html += assistantGroupHeader(gd.id, idxs.length, gd.label);
    if (__assistantGroupCollapsed[gd.id]) continue;
    for (var k = 0; k < idxs.length; k++) html += assistantActionRowHtml(actions[idxs[k]] || {}, idxs[k]);
  }
  box.innerHTML = html;
}

function assistantAddAction() {
  var input = document.getElementById('settings-assistant-new-action');
  var name = ((input && input.value) || '').trim();
  if (!name) return;
  var actions = window.__assistantActions || (window.__assistantActions = []);
  for (var i = 0; i < actions.length; i++) {
    if ((actions[i].name || '').toLowerCase() === name.toLowerCase()) {
      toast(t('assistantActionDupName'), 'error');
      return;
    }
  }
  actions.push({ name: name, spritesheetPath: '', cols: 1, rows: 1, frameStart: 0, frameEnd: 0, fps: 8 });
  __assistantAutoMirrorFor(name.toLowerCase());
  renderAssistantActions();
  try { if (typeof renderAssistantStateMatrix === 'function') renderAssistantStateMatrix(); } catch(eSM0) {}
  var newInput = document.getElementById('settings-assistant-new-action');
  if (newInput) newInput.focus();
}

// ----- Action presets per game type ----------------------------------------
// Move actions: 8-directional + idle, shared by all game types.
var __assistantMoveActions = ['idle', 'move_left', 'move_up_left', 'move_up', 'move_up_right', 'move_right', 'move_down_right', 'move_down', 'move_down_left'];
// Pair map for auto-mirror: left -> right mirror.
var __assistantMoveMirrorPairs = {
  'move_up_left': 'move_up_right',
  'move_left': 'move_right',
  'move_down_left': 'move_down_right'
};
var __assistantMoveMirrorRev = {
  'move_up_right': 'move_up_left',
  'move_right': 'move_left',
  'move_down_right': 'move_down_left'
};

// Presets: pet/platformer/topdown keep non-move states; move is separate button.
var __assistantActionPresets = {
  pet: ['drag', 'think', 'reply', 'error', 'notify', 'poke'],
  platformer: ['jump', 'fall'],
  topdown: ['attack'],
  move: __assistantMoveActions.slice()
};

function assistantAddPreset(kind) {
  var names = __assistantActionPresets[kind] || [];
  if (!names.length) return;
  var actions = window.__assistantActions || (window.__assistantActions = []);
  var added = 0;
  for (var i = 0; i < names.length; i++) {
    var exists = false;
    for (var j = 0; j < actions.length; j++) {
      if ((actions[j].name || '').toLowerCase() === names[i]) { exists = true; break; }
    }
    if (!exists) {
      actions.push({ name: names[i], spritesheetPath: '', cols: 1, rows: 1, frameStart: 0, frameEnd: 0, fps: 8 });
      added++;
    }
  }
  renderAssistantActions();
  try { if (typeof renderAssistantStateMatrix === 'function') renderAssistantStateMatrix(); } catch(eSMp) {}
  toast(added > 0 ? t('assistantPresetAdded', [String(added)]) : t('assistantPresetExists'), added > 0 ? 'success' : 'info');
}

function __assistantHasAction(nameLow) {
  var actions = window.__assistantActions || [];
  for (var i = 0; i < actions.length; i++) if ((actions[i].name || '').toLowerCase() === nameLow) return true;
  return false;
}

function __assistantAutoMirrorFor(newNameLow) {
  var actions = window.__assistantActions || [];
  var peer = (__assistantMoveMirrorPairs[newNameLow] || __assistantMoveMirrorRev[newNameLow] || '').toLowerCase();
  if (!peer) return;
  var peerExists = __assistantHasAction(peer);
  // Only auto-create if peer does not already exist; mirror flag on source
  if (peerExists) return;
  // Find source action to mirror
  var src = null;
  for (var i = 0; i < actions.length; i++) if ((actions[i].name || '').toLowerCase() === newNameLow) { src = actions[i]; break; }
  if (!src) return;
  // Auto-create mirrored peer
  var canonName = peer.indexOf('move_') === 0 ? peer : peer;
  // Use display canonical with underscore: move_up_right etc keep as is
  actions.push({
    name: peer,
    spritesheetPath: src.spritesheetPath || '',
    cols: src.cols || 1,
    rows: src.rows || 1,
    frameStart: src.frameStart || 0,
    frameEnd: (src.frameEnd !== undefined ? src.frameEnd : 0),
    fps: src.fps || 8,
    mirror: true
  });
}

function assistantRemoveAction(i) {
  var actions = window.__assistantActions || [];
  if (i < 0 || i >= actions.length) return;
  actions.splice(i, 1);
  renderAssistantActions();
  try { if (typeof renderAssistantStateMatrix === 'function') renderAssistantStateMatrix(); } catch(eSM) {}
}

// ----- State-machine visibility panel ------------------------------------
// Renders every preset event (the keys of petSM EVENT_ALIASES = behavior states)
// and shows which configured action it currently resolves to. Live pet readout
// is fetched via backend probe (no cross-window Eval dependency on the tray
// webview boundary) + optional local window.__petState when available.
var __assistantSMAliases = {
  idle:   ['idle', 'stand', 'default'],
  drag:   ['drag', 'grab', 'move', 'walk'],
  think:  ['think', 'loading', 'busy', 'working'],
  reply:  ['reply', 'happy', 'talk', 'success'],
  error:  ['error', 'confused', 'sad'],
  notify: ['notify', 'alert', 'notice'],
  poke:   ['poke', 'click', 'wave', 'greet'],
  // canonical move aliases map to move_* actions
  move_left:       ['move_left', 'walk_left', 'walk_l', 'left_walk', 'walk', 'move'],
  move_right:      ['move_right', 'walk_right', 'walk_r', 'right_walk', 'move_left', 'walk', 'move'],
  move_up:         ['move_up', 'walk_up', 'up_walk', 'walk_north', 'walk', 'move'],
  move_down:       ['move_down', 'walk_down', 'down_walk', 'walk_south', 'walk', 'move'],
  move_up_left:    ['move_up_left', 'walk_up_left', 'walk_ul', 'walk_nw', 'move_up', 'move_left', 'walk', 'move'],
  move_down_left:  ['move_down_left', 'walk_down_left', 'walk_dl', 'walk_sw', 'move_down', 'move_left', 'walk', 'move'],
  move_up_right:   ['move_up_right', 'walk_up_right', 'walk_ur', 'walk_ne', 'move_up_left', 'walk_up_left', 'move_up', 'move_left', 'walk', 'move'],
  move_down_right: ['move_down_right', 'walk_down_right', 'walk_dr', 'walk_se', 'move_down_left', 'walk_down_left', 'move_down', 'move_left', 'walk', 'move'],
  // legacy walk_* aliases kept for backward compat (actions still may be named walk_*)
  walk:   ['walk', 'move', 'move_right', 'move_left'],
  run:    ['run', 'dash', 'move'],
  jump:   ['jump', 'leap'],
  fall:   ['fall'],
  attack: ['attack', 'shoot', 'hit'],
  walk_left: ['walk_left', 'move_left', 'walk_l', 'left_walk', 'walk', 'move'],
  run_left: ['run_left', 'move_left', 'run_l', 'run', 'dash', 'walk', 'move'],
  walk_up: ['walk_up', 'move_up', 'up_walk', 'walk_north', 'walk', 'move'],
  walk_down: ['walk_down', 'move_down', 'down_walk', 'walk_south', 'walk', 'move'],
  walk_up_left: ['walk_up_left', 'move_up_left', 'walk_ul', 'walk_nw', 'walk_up', 'move_up', 'walk_left', 'move_left', 'walk', 'move'],
  walk_down_left: ['walk_down_left', 'move_down_left', 'walk_dl', 'walk_sw', 'walk_down', 'move_down', 'walk_left', 'move_left', 'walk', 'move'],
  walk_right:      ['walk_right', 'move_right', 'walk_r', 'right_walk', 'move_left', 'walk_left', 'walk', 'move'],
  run_right:       ['run_right', 'move_right', 'run_r', 'right_run', 'run_left', 'move_left', 'run', 'dash', 'walk', 'move'],
  walk_up_right:   ['walk_up_right', 'move_up_right', 'walk_ur', 'walk_ne', 'move_up_right', 'move_up_left', 'walk_up_left', 'walk_up', 'move_up', 'move_left', 'walk', 'move'],
  walk_down_right: ['walk_down_right', 'move_down_right', 'walk_dr', 'walk_se', 'move_down_right', 'move_down_left', 'walk_down_left', 'move_down', 'move_left', 'walk', 'move']
};

// Event groups shown in the state matrix. domain 'pet' rows dispatch to the
// live pet; domain 'demo' rows drive the demo page's state machine (__ademo).
var __assistantSMGroups = [
  { key: 'Move',       domain: 'pet',  events: ['idle', 'move_left', 'move_up_left', 'move_up', 'move_up_right', 'move_right', 'move_down_right', 'move_down', 'move_down_left'] },
  { key: 'Pet',        domain: 'pet',  events: ['drag', 'think', 'reply', 'error', 'notify', 'poke'] },
  { key: 'Platformer', domain: 'demo', events: ['jump', 'fall'] },
  { key: 'Topdown',    domain: 'demo', events: ['attack'] }
];

function assistantResolveAlias(eventKey, actions) {
  var cands = __assistantSMAliases[eventKey] || [];
  var names = {};
  for (var k = 0; k < actions.length; k++) names[(actions[k].name || '').toLowerCase()] = actions[k].name;
  for (var j = 0; j < cands.length; j++) {
    var low = cands[j].toLowerCase();
    if (names[low]) return names[low];
  }
  // No alias match → event key is also tried as exact action name by petSM.dispatch.
  for (var j2 = 0; j2 < actions.length; j2++) if ((actions[j2].name || '').toLowerCase() === eventKey.toLowerCase()) return actions[j2].name;
  return null;
}

// Collapse state shared by the actions list and the state matrix groups.
var __assistantGroupCollapsed = {};

function assistantToggleGroup(g) {
  __assistantGroupCollapsed[g] = !__assistantGroupCollapsed[g];
  renderAssistantActions();
  try { if (typeof renderAssistantStateMatrix === 'function') renderAssistantStateMatrix(); } catch(eTG) {}
}

function assistantGroupHeader(key, count, tag) {
  var collapsed = !!__assistantGroupCollapsed[key];
  return '<div style="display:flex;align-items:center;gap:6px;padding:10px 8px 6px;cursor:pointer;user-select:none;border-top:1px solid var(--glass-border);margin-top:6px" onclick="assistantToggleGroup(\'' + assistantEscape(key) + '\')">' +
    '<span style="font-size:10px;width:12px;color:var(--text-muted);text-align:center">' + (collapsed ? '▸' : '▾') + '</span>' +
    '<span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted)">' + assistantEscape(tag || t('assistantStateGroup' + key)) + '</span>' +
    (count != null ? '<span style="font-size:11px;color:var(--text-muted);opacity:0.9">· ' + count + '</span>' : '') +
  '</div>';
}

function assistantStateRows() {
  var actions = window.__assistantActions || [];
  var rows = '';
  for (var g = 0; g < __assistantSMGroups.length; g++) {
    var grp = __assistantSMGroups[g];
    // First group omits top divider; subsequent groups keep it (handled inside header).
    rows += assistantGroupHeader(grp.key, null);
    if (__assistantGroupCollapsed[grp.key]) continue;
    for (var oi = 0; oi < grp.events.length; oi++) {
      var ev = grp.events[oi];
      var aliases = (__assistantSMAliases[ev] || []).join(', ');
      var mapped = assistantResolveAlias(ev, actions);
      var mappedLabel = mapped ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;background:var(--glass-hover);border:1px solid var(--glass-border);font-weight:600;color:var(--text)">' + assistantEscape(mapped) + '</span>' : '<span class="muted" style="font-size:11px">' + assistantEscape(t('assistantStateUnmapped')) + '</span>';
      var triggerFn2 = grp.domain === 'demo' ? 'assistantTriggerDemoState' : 'assistantTriggerState';
      var btn2 = '<button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px;flex-shrink:0" ' + (mapped ? '' : 'disabled title="' + assistantEscape(t('assistantStateNoActions')) + '"') + ' onclick="event.stopPropagation();' + triggerFn2 + '(\'' + assistantEscape(ev) + '\')">' + assistantEscape(t('assistantStateTrigger')) + '</button>';
      rows += '<div style="display:flex;align-items:center;gap:10px;padding:8px 8px;border-bottom:1px solid var(--glass-border)">' +
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-weight:700;font-size:13px">' + assistantEscape(ev) + '</span>' + mappedLabel + '</div>' +
          '<div class="muted" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.9">' + assistantEscape(t('assistantStateAlias') + ': ' + aliases) + '</div>' +
        '</div>' + btn2 +
      '</div>';
    }
  }
  if (!actions.length) rows += '<p class="muted" style="padding:8px">' + assistantEscape(t('assistantStateNoActions')) + '</p>';
  return rows;
}

// assistantTriggerDemoState drives the demo page's state machine (F6 page,
// same browsing context) so game-type rows can be previewed like pet states.
function assistantTriggerDemoState(evt) {
  try {
    if (window.__ademo && window.__ademo.sm && typeof window.__ademo.sm.setEvent === 'function'
        && document.querySelector('.ademo-root')) {
      var ok = window.__ademo.sm.setEvent(evt);
      toast(evt + ' → ' + (window.__ademo.sm.current() || '?'), ok ? 'success' : 'warning');
      return;
    }
  } catch(eD) {}
  toast(t('assistantDemoNotOpen'), 'warning');
}

function renderAssistantStateMatrix() {
  var box = document.getElementById('assistant-state-matrix');
  if (!box) return;
  var actions = window.__assistantActions || [];
  // Live state: probe via backend first (works across separate webview), fall
  // back to in-page __petState when available (dev / same-context).
  var curLive = null;
  try {
    if (window.__petState && window.__petState.cur) curLive = window.__petState.cur;
    else if (window.petSM && typeof window.petSM.state === 'function') curLive = window.petSM.state() || null;
  } catch(eLive) {}
  var defaultName = (function() {
    for (var k = 0; k < actions.length; k++) {
      var nm = (actions[k].name||'').toLowerCase();
      if (nm === 'idle' || nm === 'stand' || nm === 'default') return actions[k].name;
    }
    return (actions[0] && actions[0].name) || '—';
  })();
  var header = '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;margin:-8px -8px 8px;background:var(--option-bg,rgba(255,255,255,0.04));border-radius:var(--radius-md);border:1px solid var(--glass-border);font-size:12px;flex-wrap:wrap">' +
    '<span data-live-cur style="font-weight:600">' + (curLive ? assistantEscape(t('assistantStateCurrent', [curLive])) : assistantEscape(t('assistantStateCurrent', ['—'])) ) + '</span>' +
    '<span class="muted" style="font-size:12px">' + assistantEscape(t('assistantStateDefault', [defaultName])) + '</span>' +
    '<button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px" onclick="assistantTriggerAllStates()">' + assistantEscape(t('assistantStateTriggerAll')) + '</button>' +
  '</div>';
  // Subtle containment for rows: keep header visually separated from the grouped lists.
  box.innerHTML = header + '<div style="border-top:1px solid var(--glass-border);margin:0 -8px 6px"></div>' + assistantStateRows();
  // Kick a backend poll to fill live state when not in same browsing context.
  fetch('/api/assistant/pet-state').then(function(r){ return r.json(); }).then(function(j){
    if (!j || !j.state) return;
    var span = box.querySelector('[data-live-cur]');
    if (span) span.textContent = t('assistantStateCurrent', [j.state]);
  }).catch(function(){});
  // Poll live state while the modal is open.
  clearInterval(__assistantSMCurPoll);
  var pollEl = box;
  __assistantSMCurPoll = setInterval(function() {
    if (!document.getElementById('assistant-state-matrix')) { clearInterval(__assistantSMCurPoll); __assistantSMCurPoll = null; return; }
    // Prefer backend (authoritative across webviews), fall back to in-page.
    fetch('/api/assistant/pet-state').then(function(r){ return r.json(); }).then(function(j){
      if (j && j.state) {
        var liveSpan = pollEl.querySelector('[data-live-cur]');
        if (liveSpan) liveSpan.textContent = t('assistantStateCurrent', [j.state]);
      }
    }).catch(function(){});
    try {
      var cur = null;
      if (window.__petState && window.__petState.cur) cur = window.__petState.cur;
      else if (window.petSM && typeof window.petSM.state === 'function') cur = window.petSM.state();
      if (cur) {
        var liveSpan2 = pollEl.querySelector('[data-live-cur]');
        if (liveSpan2) liveSpan2.textContent = t('assistantStateCurrent', [cur]);
      }
    } catch(ePoll) {}
  }, 900);
}
function assistantTriggerState(evt) {
  // Prefer in-page petSM when available (modal opened from same browsing context).
  try {
    if (window.petSM && typeof window.petSM.dispatch === 'function') {
      var ok = window.petSM.dispatch(evt);
      if (!ok && window.__petTrigger) ok = window.__petTrigger(evt);
      toast(ok ? (evt + ' → ' + (window.petSM.state() || '?')) : (evt + ': ' + t('assistantStateUnmapped')), ok ? 'success' : 'warning');
      setTimeout(function(){ try{ renderAssistantStateMatrix(); }catch(e){} }, 180);
      return;
    }
    if (window.__petTrigger) {
      var ok2 = window.__petTrigger(evt);
      toast(ok2 ? (evt + ' dispatched') : (evt + ': ' + t('assistantStateUnmapped')), ok2 ? 'success' : 'warning');
      return;
    }
  } catch(eTrig) {}
  // Fallback: ask backend to trigger via Eval on the pet window (tray webview).
  fetch('/api/assistant/pet-trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: evt }) })
    .then(function(r){ return r.json(); }).then(function(j){
      toast(j.ok ? (evt + ' → ' + (j.state || '?')) : (j.error || t('assistantStateUnmapped')), j.ok ? 'success' : 'warning');
      setTimeout(function(){ try{ renderAssistantStateMatrix(); }catch(e){} }, 280);
    }).catch(function(err){ toast(t('failed', [err.message]), 'error'); });
}

function assistantTriggerAllStates() {
  var order = ['idle', 'drag', 'think', 'reply', 'error', 'notify', 'poke'];
  var i = 0;
  function next(){
    if (i >= order.length) return;
    var ev = order[i++];
    assistantTriggerState(ev);
    setTimeout(next, 900);
  }
  next();
}

// ----- Action editor modal ----------------------------------------------
var __assistantEditorImg = null;
var __assistantEditorDrag = null; // { anchor, pointerId }

function assistantEditAction(i) {
  var actions = window.__assistantActions || [];
  if (i < 0 || i >= actions.length) return;
  var a = actions[i];
  var old = document.getElementById('assistant-action-editor-overlay');
  if (old) old.remove();

  var maxFrame = Math.max(0, (a.cols || 1) * (a.rows || 1) - 1);
  var start = Math.min(Math.max(0, a.frameStart || 0), maxFrame);
  var end = Math.min(Math.max(start, a.frameEnd || 0), maxFrame);

  var html =
    '<div class="modal" style="width:560px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column">' +
      '<div class="modal-title" style="flex-shrink:0">' + assistantEscape(t('assistantActionEditorTitle')) + ' · ' + assistantEscape(a.name || '') + '</div>' +
      '<div class="modal-body" style="overflow-y:auto;flex:1">' +
        '<div style="display:grid;grid-template-columns:1fr;gap:12px">' +
          '<div class="form-group" style="margin:0"><label>' + assistantEscape(t('assistantActionNameLabel')) + '</label>' +
            '<input type="text" class="input" id="assistant-editor-name" value="' + assistantEscape(a.name) + '">' +
          '</div>' +
          '<div class="form-group" style="margin:0"><label>' + assistantEscape(t('assistantActionSheetLabel')) + '</label>' +
            '<div style="display:flex;gap:8px;align-items:center">' +
              '<span id="assistant-editor-path" class="muted" data-path="' + assistantEscape(a.spritesheetPath || '') + '" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;padding:7px 10px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:var(--glass-bg)">' + assistantEscape(a.spritesheetPath || t('assistantActionNoSheet')) + '</span>' +
              '<button type="button" class="btn btn-ghost" id="assistant-editor-browse" style="padding:6px 14px;flex-shrink:0">' + assistantEscape(t('assistantActionBrowse')) + '</button>' +
            '</div>' +
          '</div>' +
          '<div id="assistant-editor-canvas-wrap" style="border:1px solid var(--glass-border);border-radius:var(--radius-md);background:var(--bg);min-height:140px;display:flex;align-items:center;justify-content:center;overflow:hidden">' +
            '<canvas id="assistant-editor-canvas" style="display:none;max-width:100%;touch-action:none"></canvas>' +
            '<span id="assistant-editor-empty" class="muted" style="padding:28px;font-size:12px">' + assistantEscape(t('assistantActionNoSheet')) + '</span>' +
          '</div>' +
          '<p class="muted" style="margin:0;font-size:12px;line-height:1.5">' + assistantEscape(t('assistantActionHint')) + '</p>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;align-items:end">' +
            '<div><label class="muted" style="font-size:12px;display:block;margin-bottom:6px">' + assistantEscape(t('assistantActionSplitX')) + '</label>' +
              renderStepperHtml('assistant-editor-cols', a.cols || 1, { min: 1, max: 100 }) + '</div>' +
            '<div><label class="muted" style="font-size:12px;display:block;margin-bottom:6px">' + assistantEscape(t('assistantActionSplitY')) + '</label>' +
              renderStepperHtml('assistant-editor-rows', a.rows || 1, { min: 1, max: 100 }) + '</div>' +
            '<div><label class="muted" style="font-size:12px;display:block;margin-bottom:6px">' + assistantEscape(t('assistantActionFps')) + '</label>' +
              renderStepperHtml('assistant-editor-fps', a.fps || 8, { min: 1, max: 30 }) + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;padding:10px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:var(--glass-bg)">' +
            '<div><label class="muted" style="font-size:12px;display:block;margin-bottom:6px">' + assistantEscape(t('assistantActionFrameFrom')) + '</label>' +
              '<input type="number" class="input" id="assistant-editor-frame-start" value="' + start + '" min="0" style="width:96px"></div>' +
            '<div><label class="muted" style="font-size:12px;display:block;margin-bottom:6px">' + assistantEscape(t('assistantActionFrameTo')) + '</label>' +
              '<input type="number" class="input" id="assistant-editor-frame-end" value="' + end + '" min="0" style="width:96px"></div>' +
            '<div style="display:flex;flex-direction:column;gap:6px"><label class="muted" style="font-size:12px;display:block">Mirror</label><label class="toggle-switch"><input type="checkbox" id="assistant-editor-mirror"' + (a.mirror ? ' checked' : '') + '><span class="toggle-slider"></span></label></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="modal-footer" style="flex-shrink:0">' +
        '<button type="button" class="btn btn-ghost" id="assistant-editor-cancel">' + assistantEscape(t('cancel')) + '</button>' +
        '<button type="button" class="btn btn-primary" id="assistant-editor-ok">' + assistantEscape(t('confirm')) + '</button>' +
      '</div>' +
    '</div>';

  var overlay = document.createElement('div');
  overlay.id = 'assistant-action-editor-overlay';
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = 'calc(var(--z-modal, 1000) + 20)';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  requestAnimationFrame(function() { overlay.classList.add('show'); });

  document.getElementById('assistant-editor-cancel').onclick = closeAssistantActionEditor;
  document.getElementById('assistant-editor-ok').onclick = function() { assistantSaveActionEditor(i); };
  document.getElementById('assistant-editor-browse').onclick = assistantBrowseSheet;
  overlay.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAssistantActionEditor(); }
  });

  ['assistant-editor-cols', 'assistant-editor-rows'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', assistantOnGridChange);
      el.addEventListener('input', assistantOnGridChange);
    }
  });
  ['assistant-editor-frame-start', 'assistant-editor-frame-end'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', assistantOnRangeInput);
      el.addEventListener('input', assistantOnRangeInput);
    }
  });

  var mirrorEl = document.getElementById('assistant-editor-mirror');
  if (mirrorEl) mirrorEl.addEventListener('change', assistantDrawSheet);

  if (a.spritesheetPath) {
    // Existing action: spritesheet on disk -> use sheet-image endpoint (never file://)
    // Fallback: if action already has a preview registered, it will still be served via sheet-image
    assistantLoadSheetPreview('/api/assistant/sheet-image/' + encodeURIComponent(a.name));
  }
}

function closeAssistantActionEditor() {
  __assistantEditorDrag = null;
  __assistantEditorImg = null;
  var overlay = document.getElementById('assistant-action-editor-overlay');
  if (overlay) {
    overlay.classList.remove('show');
    setTimeout(function() { overlay.remove(); }, 150);
  }
}

// assistantBrowseSheet opens the native OS file picker via /api/browse, then
// registers the picked absolute path with /api/assistant/sheet-preview so the
// editor canvas can display it (the browser cannot read server-local files).
// Uses the shared native-picker lock so global shortcuts stay frozen while
// the dialog is open.
async function assistantBrowseSheet() {
  if (typeof beginNativePickerLock === 'function' && !beginNativePickerLock('file')) return;
  var browseBtn = document.getElementById('assistant-editor-browse');
  if (browseBtn) browseBtn.disabled = true;
  try {
    var initialPath = '';
    var pathEl = document.getElementById('assistant-editor-path');
    if (pathEl && pathEl.dataset && pathEl.dataset.path) initialPath = pathEl.dataset.path;
    var res = await apiPost('/browse', {
      mode: 'file',
      initialPath: initialPath,
      filter: 'Images (*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp)|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp|All Files (*.*)|*.*'
    });
    if (!res || !res.path) return;
    var reg = await apiPost('/assistant/sheet-preview', { path: res.path });
    if (!reg || !reg.previewId) return;
    if (pathEl) {
      pathEl.textContent = res.path;
      pathEl.dataset.path = res.path;
    }
    assistantLoadSheetPreview('/api/assistant/sheet-preview/' + encodeURIComponent(reg.previewId));
  } catch (e) {
    console.warn('spritesheet browse failed:', e);
    toast(t('failed', [e.message]), 'error');
  } finally {
    if (browseBtn) browseBtn.disabled = false;
    if (typeof endNativePickerLock === 'function') endNativePickerLock();
  }
}

function assistantLoadSheetPreview(url) {
  var img = new Image();
  img.onload = function() {
    __assistantEditorImg = img;
    var empty = document.getElementById('assistant-editor-empty');
    var canvas = document.getElementById('assistant-editor-canvas');
    if (empty) empty.style.display = 'none';
    if (canvas) {
      canvas.style.display = 'block';
      assistantBindCanvas(canvas);
      assistantDrawSheet();
    }
  };
  img.onerror = function() {
    __assistantEditorImg = null;
    var canvas = document.getElementById('assistant-editor-canvas');
    if (canvas) canvas.style.display = 'none';
    var empty = document.getElementById('assistant-editor-empty');
    if (empty) {
      empty.style.display = '';
      empty.textContent = t('assistantActionLoadFail');
    }
  };
  img.src = url;
}

function assistantGridGeom() {
  var img = __assistantEditorImg;
  var canvas = document.getElementById('assistant-editor-canvas');
  if (!img || !canvas || !canvas.width || !canvas.height) return null;
  var cols = Math.max(1, parseInt((document.getElementById('assistant-editor-cols') || {}).value, 10) || 1);
  var rows = Math.max(1, parseInt((document.getElementById('assistant-editor-rows') || {}).value, 10) || 1);
  return {
    cols: cols,
    rows: rows,
    cellW: canvas.width / cols,
    cellH: canvas.height / rows
  };
}

function assistantSelectedRange() {
  var g = assistantGridGeom();
  var total = g ? g.cols * g.rows : 1;
  var s = parseInt((document.getElementById('assistant-editor-frame-start') || {}).value, 10);
  var e = parseInt((document.getElementById('assistant-editor-frame-end') || {}).value, 10);
  if (isNaN(s) || s < 0) s = 0;
  if (isNaN(e) || e < s) e = s;
  if (e > total - 1) e = total - 1;
  if (s > e) s = e;
  return { start: s, end: e };
}

function assistantAccentColor(alpha) {
  var accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4fc3f7';
  // Hex (#rrggbb) → rgba at the requested alpha; leave other formats as-is.
  var m = /^#([0-9a-f]{6})$/i.exec(accent);
  if (m) {
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }
  return accent;
}

function assistantDrawSheet() {
  var canvas = document.getElementById('assistant-editor-canvas');
  var img = __assistantEditorImg;
  if (!canvas || !img) return;
  var wrap = document.getElementById('assistant-editor-canvas-wrap');
  var maxW = Math.min(480, (wrap ? wrap.clientWidth : 480) - 2);
  var maxH = 300;
  var scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Draw base sheet without mirroring; mirroring applies only to selected frames' output
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  var mirror = !!(document.getElementById('assistant-editor-mirror') || {}).checked;

  var g = assistantGridGeom();
  if (!g) return;
  var sel = assistantSelectedRange();
  // If mirror is on, redraw selected cells mirrored to preview the flipped output
  if (mirror) {
    for (var mIdx = sel.start; mIdx <= sel.end; mIdx++) {
      var mCol = mIdx % g.cols;
      var mRow = Math.floor(mIdx / g.cols);
      var mDX = mCol * g.cellW;
      var mDY = mRow * g.cellH;
      var sx = mCol * (img.naturalWidth / g.cols);
      var sy = mRow * (img.naturalHeight / g.rows);
      var sw = img.naturalWidth / g.cols;
      var sh = img.naturalHeight / g.rows;
      ctx.save();
      ctx.translate(mDX + g.cellW, mDY);
      ctx.scale(-1, 1);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, g.cellW, g.cellH);
      ctx.restore();
    }
  }

  // Highlight the selected range first so grid lines draw on top.
  ctx.fillStyle = assistantAccentColor(0.28);
  for (var idx = sel.start; idx <= sel.end; idx++) {
    ctx.fillRect((idx % g.cols) * g.cellW, Math.floor(idx / g.cols) * g.cellH, g.cellW, g.cellH);
  }
  ctx.strokeStyle = assistantAccentColor(0.55);
  ctx.lineWidth = 1;
  for (var c = 1; c < g.cols; c++) {
    ctx.beginPath();
    ctx.moveTo(Math.round(c * g.cellW) + 0.5, 0);
    ctx.lineTo(Math.round(c * g.cellW) + 0.5, canvas.height);
    ctx.stroke();
  }
  for (var r = 1; r < g.rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, Math.round(r * g.cellH) + 0.5);
    ctx.lineTo(canvas.width, Math.round(r * g.cellH) + 0.5);
    ctx.stroke();
  }
  // Frame numbers: top-left cell is 0, bottom-right is N-1.
  ctx.fillStyle = assistantAccentColor(0.95);
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 2;
  ctx.font = 'bold ' + Math.max(9, Math.min(14, g.cellW / 3)) + 'px sans-serif';
  ctx.textBaseline = 'top';
  for (var i = 0; i < g.cols * g.rows; i++) {
    var tx = (i % g.cols) * g.cellW + 3;
    var ty = Math.floor(i / g.cols) * g.cellH + 3;
    ctx.strokeText(String(i), tx, ty);
    ctx.fillText(String(i), tx, ty);
  }
}

// assistantBindCanvas wires click/drag frame-range selection. Bound once per
// canvas element — the editor rebuilds the DOM each time it opens, so no
// listener accumulation across open/close cycles.
function assistantBindCanvas(canvas) {
  if (canvas.dataset.bound) { assistantDrawSheet(); return; }
  canvas.dataset.bound = '1';

  function cellAt(e) {
    var g = assistantGridGeom();
    if (!g) return -1;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    var px = (e.clientX - rect.left) * (canvas.width / rect.width);
    var py = (e.clientY - rect.top) * (canvas.height / rect.height);
    var col = Math.max(0, Math.min(g.cols - 1, Math.floor(px / g.cellW)));
    var row = Math.max(0, Math.min(g.rows - 1, Math.floor(py / g.cellH)));
    return row * g.cols + col;
  }
  function setRange(start, end) {
    var sEl = document.getElementById('assistant-editor-frame-start');
    var eEl = document.getElementById('assistant-editor-frame-end');
    if (sEl) sEl.value = start;
    if (eEl) eEl.value = end;
  }

  canvas.addEventListener('pointerdown', function(e) {
    var idx = cellAt(e);
    if (idx < 0) return;
    e.preventDefault();
    __assistantEditorDrag = { anchor: idx, pointerId: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    setRange(idx, idx);
    assistantDrawSheet();
  });
  canvas.addEventListener('pointermove', function(e) {
    if (!__assistantEditorDrag || e.pointerId !== __assistantEditorDrag.pointerId) return;
    var idx = cellAt(e);
    if (idx < 0) return;
    setRange(Math.min(__assistantEditorDrag.anchor, idx), Math.max(__assistantEditorDrag.anchor, idx));
    assistantDrawSheet();
  });
  function endDrag(e) {
    if (__assistantEditorDrag && e.pointerId === __assistantEditorDrag.pointerId) __assistantEditorDrag = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
}

function assistantOnGridChange() {
  var g = assistantGridGeom();
  if (!g) return;
  var total = g.cols * g.rows;
  var sEl = document.getElementById('assistant-editor-frame-start');
  var eEl = document.getElementById('assistant-editor-frame-end');
  var s = parseInt(sEl && sEl.value, 10) || 0;
  var e = parseInt(eEl && eEl.value, 10) || 0;
  if (s < 0) s = 0;
  if (s > total - 1) s = total - 1;
  if (e < s) e = s;
  if (e > total - 1) e = total - 1;
  if (sEl) sEl.value = s;
  if (eEl) eEl.value = e;
  assistantDrawSheet();
}

function assistantOnRangeInput() {
  var sel = assistantSelectedRange();
  var sEl = document.getElementById('assistant-editor-frame-start');
  var eEl = document.getElementById('assistant-editor-frame-end');
  if (sEl) sEl.value = sel.start;
  if (eEl) eEl.value = sel.end;
  assistantDrawSheet();
}

function assistantSaveActionEditor(index) {
  var actions = window.__assistantActions || [];
  if (index < 0 || index >= actions.length) return;
  var nameEl = document.getElementById('assistant-editor-name');
  var pathEl = document.getElementById('assistant-editor-path');
  var name = ((nameEl && nameEl.value) || '').trim();
  if (!name) {
    toast(t('assistantActionNameRequired'), 'error');
    return;
  }
  for (var k = 0; k < actions.length; k++) {
    if (k !== index && (actions[k].name || '').toLowerCase() === name.toLowerCase()) {
      toast(t('assistantActionDupName'), 'error');
      return;
    }
  }
  var g = assistantGridGeom();
  var sel = assistantSelectedRange();
  var fps = parseInt((document.getElementById('assistant-editor-fps') || {}).value, 10);
  if (isNaN(fps) || fps < 1) fps = 8;
  var mirror = !!((document.getElementById('assistant-editor-mirror') || {}).checked);
  var oldName = (actions[index].name || '').toLowerCase();
  var newNameLow = name.toLowerCase();
  var wasMove = !!(__assistantMoveMirrorPairs[oldName] || __assistantMoveMirrorRev[oldName] || __assistantMoveMirrorPairs[newNameLow] || __assistantMoveMirrorRev[newNameLow] || newNameLow === 'move_up' || newNameLow === 'move_down' || newNameLow === 'idle');
  // Determine if this is a new move entry becoming set (has sheet) and peer missing
  actions[index] = {
    name: name,
    spritesheetPath: (pathEl && pathEl.dataset && pathEl.dataset.path) || '',
    cols: g ? g.cols : 1,
    rows: g ? g.rows : 1,
    frameStart: sel.start,
    frameEnd: sel.end,
    fps: fps,
    mirror: mirror
  };
  // Auto-mirror: if saved as a move direction and peer doesn't exist, create mirrored peer (only once)
  if (wasMove || __assistantMoveMirrorPairs[newNameLow] || __assistantMoveMirrorRev[newNameLow]) {
    var peerLow = (__assistantMoveMirrorPairs[newNameLow] || __assistantMoveMirrorRev[newNameLow] || '').toLowerCase();
    if (peerLow && !__assistantHasAction(peerLow)) {
      // Copy from just-saved entry
      var src2 = actions[index];
      actions.push({
        name: peerLow,
        spritesheetPath: src2.spritesheetPath || '',
        cols: src2.cols || 1,
        rows: src2.rows || 1,
        frameStart: src2.frameStart || 0,
        frameEnd: (src2.frameEnd !== undefined ? src2.frameEnd : 0),
        fps: src2.fps || 8,
        mirror: true
      });
      // If both already existed, do not auto-overwrite (override allowed)
    }
  }
  closeAssistantActionEditor();
  renderAssistantActions();
  try { if (typeof renderAssistantStateMatrix === 'function') renderAssistantStateMatrix(); } catch(eMir) {}
}

// assistantModelBtnClick wires the Assistant modal's model button: reads the
// current value from the hidden input and writes the picked id back into it
// and the visible button label.
function assistantModelBtnClick() {
  var hidden = document.getElementById('settings-modal-assistant-model');
  var btn = document.getElementById('settings-assistant-model-btn');
  openAssistantModelPicker((hidden && hidden.value) || '', function(v) {
    if (hidden) hidden.value = v || '';
    if (btn) btn.innerHTML = assistantEscape(v || t('assistantKeywordFallback')) + ' <span style="opacity:0.5">▼</span>';
  });
}

// ----- Playground-style model picker (stacked overlay, settings context) --

function openAssistantModelPicker(currentValue, onSelect) {
  __assistantPickerCb = onSelect;
  if (__assistantModelsCache && __assistantModelsCache.length) {
    assistantRenderModelPicker(currentValue, __assistantModelsCache);
    return;
  }
  fetch('/api/models')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      __assistantModelsCache = (data && Array.isArray(data.models)) ? data.models : [];
      assistantRenderModelPicker(currentValue, __assistantModelsCache);
    })
    .catch(function() {
      assistantRenderModelPicker(currentValue, []);
    });
}

function assistantRenderModelPicker(currentValue, allModels) {
  var models = (allModels || []).filter(function(m) {
    if (!m) return false;
    var k = String(m.kind || '').toLowerCase();
    return k !== 'image' && k !== 'embedding';
  });
  var itemsHtml = '';
  if (!models.length) {
    itemsHtml = '<div style="padding:20px;text-align:center;opacity:0.6">' + assistantEscape(t('assistantModelNone')) + '</div>';
  }
  models.forEach(function(m) {
    var label = m.id + (m.provider ? ' (' + m.provider + ')' : '');
    var cls = 'assistant-model-item' + (currentValue === m.id ? ' selected' : '');
    itemsHtml += '<div class="' + cls + '" data-value="' + assistantEscape(m.id) + '" tabindex="-1" onclick="assistantModelSelect(this)" ondblclick="assistantModelSelect(this);assistantModelConfirm()" style="padding:7px 10px;cursor:pointer;border-radius:6px;font-size:13px">' + assistantEscape(label) + '</div>';
  });
  var html =
    '<div class="modal" style="width:460px;max-width:90vw;padding:16px">' +
      '<div class="modal-title" style="padding:0 0 10px">' + assistantEscape(t('assistantPickModel')) + '</div>' +
      '<input type="text" id="assistant-model-filter" placeholder="' + assistantEscape(t('assistantModelFilterPlaceholder')) + '" oninput="assistantModelFilter(this.value)" style="width:100%;padding:6px 8px;margin-bottom:8px;border:1px solid var(--glass-border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box">' +
      '<div id="assistant-model-list" style="max-height:50vh;overflow-y:auto">' + itemsHtml + '</div>' +
      '<div class="modal-footer">' +
        '<button type="button" class="btn btn-ghost" id="assistant-model-cancel">' + assistantEscape(t('cancel')) + '</button>' +
        '<button type="button" class="btn btn-primary" id="assistant-model-ok">' + assistantEscape(t('confirm')) + '</button>' +
      '</div>' +
    '</div>';
  var old = document.getElementById('assistant-model-picker-overlay');
  if (old) old.remove();
  var overlay = document.createElement('div');
  overlay.id = 'assistant-model-picker-overlay';
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = 'calc(var(--z-modal, 1000) + 30)';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  requestAnimationFrame(function() { overlay.classList.add('show'); });

  document.getElementById('assistant-model-cancel').onclick = closeAssistantModelPicker;
  document.getElementById('assistant-model-ok').onclick = assistantModelConfirm;
  overlay.addEventListener('keydown', assistantModelKeydown);

  // Item hover/selected styles (mirrors the pg model picker look).
  if (!document.getElementById('assistant-picker-style')) {
    var style = document.createElement('style');
    style.id = 'assistant-picker-style';
    style.textContent =
      '.assistant-model-item:hover{background:var(--glass-hover)}' +
      '.assistant-model-item.selected{background:rgba(79,195,247,0.12);color:var(--accent)}';
    document.head.appendChild(style);
  }

  var filterEl = document.getElementById('assistant-model-filter');
  if (filterEl) filterEl.focus();
}

function closeAssistantModelPicker() {
  var overlay = document.getElementById('assistant-model-picker-overlay');
  if (overlay) {
    overlay.classList.remove('show');
    setTimeout(function() { overlay.remove(); }, 150);
  }
  __assistantPickerCb = null;
}

function assistantModelSelect(el) {
  var overlay = document.getElementById('assistant-model-picker-overlay');
  if (!overlay) return;
  var items = overlay.querySelectorAll('.assistant-model-item');
  for (var i = 0; i < items.length; i++) items[i].classList.remove('selected');
  el.classList.add('selected');
}

function assistantModelConfirm() {
  var overlay = document.getElementById('assistant-model-picker-overlay');
  if (!overlay) return;
  var selected = overlay.querySelector('.assistant-model-item.selected');
  var value = selected ? selected.getAttribute('data-value') : '';
  var cb = __assistantPickerCb;
  closeAssistantModelPicker();
  if (cb) cb(value);
}

function assistantModelFilter(query) {
  var overlay = document.getElementById('assistant-model-picker-overlay');
  if (!overlay) return;
  var q = (query || '').toLowerCase();
  var items = overlay.querySelectorAll('.assistant-model-item');
  for (var i = 0; i < items.length; i++) {
    var text = (items[i].textContent || '').toLowerCase();
    items[i].style.display = q && text.indexOf(q) < 0 ? 'none' : '';
  }
}

function assistantModelVisibleItems() {
  var overlay = document.getElementById('assistant-model-picker-overlay');
  if (!overlay) return [];
  var visible = [];
  var items = overlay.querySelectorAll('.assistant-model-item');
  for (var i = 0; i < items.length; i++) {
    if (items[i].style.display !== 'none') visible.push(items[i]);
  }
  return visible;
}

function assistantModelKeydown(e) {
  var overlay = document.getElementById('assistant-model-picker-overlay');
  if (!overlay) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAssistantModelPicker(); return; }
  if (e.key === 'Enter') { e.preventDefault(); assistantModelConfirm(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    var visible = assistantModelVisibleItems();
    if (!visible.length) return;
    var curIdx = -1;
    for (var i = 0; i < visible.length; i++) {
      if (visible[i].classList.contains('selected')) { curIdx = i; break; }
    }
    var nextIdx = e.key === 'ArrowDown'
      ? (curIdx < 0 ? 0 : (curIdx + 1) % visible.length)
      : (curIdx <= 0 ? visible.length - 1 : curIdx - 1);
    assistantModelSelect(visible[nextIdx]);
    visible[nextIdx].focus();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    var filter = document.getElementById('assistant-model-filter');
    if (filter === document.activeElement) {
      var vis = assistantModelVisibleItems();
      if (vis.length) vis[0].focus();
    } else if (filter) {
      filter.focus();
    }
  }
}

// ----- Assistant presets: dropdown + add/remove for named action bundles -----
// Draft presets live in window.__assistantPresets (array of {name, actions}).
// window.__assistantPresetSel holds the active dropdown value (preset name).
if (typeof window.__assistantPresetSel === 'undefined') window.__assistantPresetSel = '';

function assistantCloneAction(a) {
  return {
    name: a && a.name ? String(a.name) : '',
    spritesheetPath: a && a.spritesheetPath ? String(a.spritesheetPath) : '',
    cols: Math.max(1, parseInt(a && a.cols, 10) || 1),
    rows: Math.max(1, parseInt(a && a.rows, 10) || 1),
    frameStart: Math.max(0, parseInt(a && a.frameStart, 10) || 0),
    frameEnd: Math.max(0, parseInt(a && a.frameEnd, 10) || 0),
    fps: Math.max(1, parseInt(a && a.fps, 10) || 8),
    mirror: !!(a && a.mirror)
  };
}

function renderAssistantPresetBar() {
  var bar = document.getElementById('assistant-preset-bar');
  if (!bar) return;
  var presets = window.__assistantPresets || [];
  var sel = window.__assistantPresetSel || '';
  var opts = '<option value="">' + assistantEscape(t('assistantPresetPlaceholder') || '— Select preset —') + '</option>';
  for (var i = 0; i < presets.length; i++) {
    var nm = (presets[i] && presets[i].name) || '';
    if (!nm) continue;
    opts += '<option value="' + assistantEscape(nm) + '"' + (nm === sel ? ' selected' : '') + '>' + assistantEscape(nm) + '</option>';
  }
  bar.innerHTML =
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<select class="input" id="assistant-preset-select" style="flex:1;min-width:200px;height:36px" onchange="assistantSelectPreset(this.value)">' + opts + '</select>' +
      '<button type="button" class="btn btn-ghost" style="padding:0 14px;height:36px" onclick="assistantAddPresetBundle()">' + assistantEscape(t('assistantPresetAdd') || 'Add') + '</button>' +
      '<button type="button" class="btn btn-ghost" style="padding:0 14px;height:36px"' + (sel ? '' : ' disabled') + ' onclick="assistantApplyPresetBundle()">' + assistantEscape(t('assistantPresetApply') || 'Apply') + '</button>' +
      '<button type="button" class="btn btn-ghost" style="padding:0 14px;height:36px" onclick="assistantSaveCurrentAsPreset()">' + assistantEscape(t('assistantPresetSaveCurrent') || 'Save current') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-danger" style="padding:0 14px;height:36px"' + (sel ? '' : ' disabled') + ' onclick="assistantRemovePresetBundle()">' + assistantEscape(t('assistantPresetRemove') || 'Remove') + '</button>' +
    '</div>';
}

function assistantSelectPreset(name) {
  window.__assistantPresetSel = name || '';
  renderAssistantPresetBar();
}

function assistantAddPresetBundle() {
  var name = (typeof prompt === 'function' ? prompt(t('assistantPresetNamePrompt') || 'Preset name:', '') : '') || '';
  name = String(name).trim();
  if (!name) return;
  var presets = window.__assistantPresets || (window.__assistantPresets = []);
  for (var i = 0; i < presets.length; i++) if ((presets[i].name || '').toLowerCase() === name.toLowerCase()) {
    toast(t('assistantActionDupName') || 'Name already exists', 'error');
    return;
  }
  presets.push({ name: name, actions: [] });
  window.__assistantPresetSel = name;
  renderAssistantPresetBar();
  try { if (typeof __assistantMSPersistPresetChange === 'function') __assistantMSPersistPresetChange('add', name); } catch (e) {}
}

function assistantApplyPresetBundle() {
  var sel = window.__assistantPresetSel || '';
  if (!sel) return;
  var presets = window.__assistantPresets || [];
  var found = null;
  for (var i = 0; i < presets.length; i++) if ((presets[i].name || '').toLowerCase() === sel.toLowerCase()) { found = presets[i]; break; }
  if (!found) { toast(t('assistantPresetNotFound') || 'Preset not found', 'error'); return; }
  var actions = window.__assistantActions || (window.__assistantActions = []);
  var existing = {};
  for (var j = 0; j < actions.length; j++) existing[(actions[j].name || '').toLowerCase()] = true;
  var added = 0;
  for (var k = 0; k < (found.actions || []).length; k++) {
    var a = found.actions[k];
    var low = (a && a.name ? String(a.name).toLowerCase() : '');
    if (!low || existing[low]) continue;
    actions.push(assistantCloneAction(a));
    existing[low] = true;
    added++;
  }
  renderAssistantActions();
  try { if (typeof renderAssistantStateMatrix === 'function') renderAssistantStateMatrix(); } catch(eAP) {}
  toast(added > 0 ? t('assistantPresetAdded', [String(added)]) : t('assistantPresetExists'), added > 0 ? 'success' : 'info');
}

function assistantSaveCurrentAsPreset() {
  var sel = window.__assistantPresetSel || '';
  var name = sel;
  if (!name) {
    var entered = (typeof prompt === 'function' ? prompt(t('assistantPresetNamePrompt') || 'Preset name:', '') : '') || '';
    name = String(entered).trim();
    if (!name) return;
  }
  var presets = window.__assistantPresets || (window.__assistantPresets = []);
  var cur = window.__assistantActions || [];
  var snap = cur.map(assistantCloneAction);
  for (var i = 0; i < presets.length; i++) if ((presets[i].name || '').toLowerCase() === name.toLowerCase()) {
    presets[i].actions = snap;
    window.__assistantPresetSel = presets[i].name;
    renderAssistantPresetBar();
    toast(t('assistantPresetSaved') || 'Preset saved', 'success');
    try { if (typeof __assistantMSPersistPresetChange === 'function') __assistantMSPersistPresetChange('update', presets[i].name); } catch (e) {}
    return;
  }
  presets.push({ name: name, actions: snap });
  window.__assistantPresetSel = name;
  renderAssistantPresetBar();
  toast(t('assistantPresetSaved') || 'Preset saved', 'success');
  try { if (typeof __assistantMSPersistPresetChange === 'function') __assistantMSPersistPresetChange('add', name); } catch (e2) {}
}

function assistantRemovePresetBundle() {
  var sel = window.__assistantPresetSel || '';
  if (!sel) return;
  var presets = window.__assistantPresets || [];
  for (var i = 0; i < presets.length; i++) if ((presets[i].name || '').toLowerCase() === sel.toLowerCase()) {
    var ok = true;
    if (typeof confirmModal === 'function') {
      // fire async confirm without blocking this click path is fine? Use sync confirm fallback
      // Keep modal flow: schedule removal after UI interaction
      // For now use native confirm for immediate sync removal
      try { ok = confirm(t('assistantPresetRemoveConfirm', [presets[i].name]) || ('Remove preset \"' + presets[i].name + '\"?')); } catch(eC) { ok = true; }
    } else {
      try { ok = confirm(t('assistantPresetRemoveConfirm', [presets[i].name]) || ('Remove preset \"' + presets[i].name + '\"?')); } catch(eC2) { ok = true; }
    }
    if (!ok) return;
    var removedName = presets[i].name;
    presets.splice(i, 1);
    window.__assistantPresetSel = '';
    renderAssistantPresetBar();
    toast(t('assistantPresetRemoved') || 'Preset removed', 'success');
    try { if (typeof __assistantMSPersistPresetChange === 'function') __assistantMSPersistPresetChange('remove', removedName); } catch (e3) {}
    return;
  }
}
