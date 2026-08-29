// ===================== Demo Games: disk plugin host =====================
// Game plugin host for the Demo page (F6), rendered as a section below the
// assistant testbed. Games are PLUGINS: each one is a directory on disk under
// {configDir}/games/<id>/ (seeded from the embedded defaults on first run),
// served by the Go backend at /games/<id>/* — editing a game file and
// reloading the page picks up the change with NO recompile and NO process
// restart. See docs/gamedemo-progress.md for the full contract.
//
// Plugin layout:
//   {configDir}/games/<id>/game.json  {"id","title","version","entry"}
//   {configDir}/games/<id>/<entry>    classic script (default main.js)
//
// Plugin contract:
//   The entry script MUST synchronously call
//     window.TRGames.register({ id, title, launch(host) })
//   where id equals the manifest id. launch(host) starts the game inside
//   host.container and MAY return either a Phaser.Game (auto-destroyed via
//   .destroy(true)) or any handle with a .dispose() method.
//
// host = {
//   container: HTMLElement,   // empty stage element; mount the canvas here
//   width:     number,        // stage CSS px at launch time
//   height:    number,
//   phaser:    window.Phaser, // guaranteed loaded before the entry runs
//   saveState(obj)  -> Promise,   // PUT /api/games/<id>/state (any JSON)
//   loadState()     -> Promise<object|null>,  // null when nothing stored
//   sheetImageUrl(actionName) -> string,      // assistant spritesheet URL
//   llmChat({model, messages}) -> Promise< parsed chat-completion JSON >
//   getAssistantConfig()  -> Promise<{model,actions,enabled,debug}|null>, // GET /api/settings -> assistant slice
//   getAssistantActions() -> Promise<AssistantAction[]>,                   // convenience: config.actions || []
// }
//
// Backend endpoints (see internal/api/games):
//   GET /api/games                  -> {games:[{id,title,version,entry,v}]}
//   GET /api/games/{id}/state       -> stored JSON | 404
//   PUT /api/games/{id}/state       -> {ok:true} (atomic write)
//   GET /games/<id>/*               -> no-store static from the games dir
//
// While a game runs the testbed above is frozen via the __ademo.setPaused
// seam so keyboard input belongs to the game alone.
//
// Test seam: window.__dgames exposes the registry and loaders so
// web/demo-games.test.js can drive the contract in a VM without a DOM.
'use strict';

// ---- registry -------------------------------------------------------------
var dgRegistry = {};        // id -> {def:{id,title,launch}, src}
var dgCurrent = null;       // {id, handle}
var dgGames = [];           // last /api/games result
var dgUi = null;            // per-render UI refs
var dgPhaserPromise = null; // shared Phaser script-injection promise
var dgLoadPromises = {};    // id -> in-flight entry injection promise

var DG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

window.TRGames = {
  // register is called synchronously by game entry scripts at load time.
  register: function (def) {
    if (!def || typeof def !== 'object') throw new Error('TRGames.register: def must be an object');
    if (!DG_ID_RE.test(def.id || '')) throw new Error('TRGames.register: invalid id');
    if (typeof def.launch !== 'function') throw new Error('TRGames.register: launch must be a function');
    if (dgRegistry[def.id]) throw new Error('TRGames.register: duplicate id "' + def.id + '"');
    dgRegistry[def.id] = { def: def };
  },
  stop: function () { dgStopGame(); }
};

// ---- fullscreen + icons (mirrors assistant-demo.js) ------------------------
var DG_SVG_FULLSCREEN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
var DG_SVG_CLOSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function dgIsFullscreen() {
  return document.body.classList.contains('demo-stage-fullscreen');
}
function dgSetFullscreen(on) {
  var will = !!on;
  // Delegate to the shell's fullscreen controller so both panes share one chrome
  if (typeof ademoSetFullscreen === 'function') { ademoSetFullscreen(will); return; }
  document.body.classList.toggle('demo-stage-fullscreen', will);
  if (dgUi && dgUi.root) dgUi.root.classList.toggle('dg-fullscreen', will);
  dgSyncUi();
  if (dgUi.stageWrap) {
    // Nudge stage sizing if game has fixed layout.
    try { window.dispatchEvent(new Event('resize')); } catch (e0) {}
  }
  if (typeof window.toggleNativeFullscreen === 'function') {
    try { window.toggleNativeFullscreen(will); } catch (e1) {}
  }
}
function dgToggleFullscreen() { dgSetFullscreen(!dgIsFullscreen()); }
function dgIsFullscreenActive() { return document.body.classList.contains('demo-stage-fullscreen'); }

// ---- loaders ----------------------------------------------------------------
function dgFetchList() {
  return fetch('/api/games').then(function (r) {
    if (!r.ok) throw new Error('GET /api/games -> ' + r.status);
    return r.json();
  }).then(function (data) {
    return (data && data.games) || [];
  });
}

// Lazy-load vendored Phaser exactly once.
function dgLoadPhaser() {
  if (window.Phaser) return Promise.resolve();
  if (dgPhaserPromise) return dgPhaserPromise;
  dgPhaserPromise = dgInjectScript('/vendor/phaser/phaser.min.js').then(function () {
    if (!window.Phaser) throw new Error('phaser.min.js loaded but window.Phaser is missing');
  });
  return dgPhaserPromise;
}

// Inject (or return the in-flight injection of) a game entry script. The
// manifest mtime `v` busts the browser cache so disk edits apply on reload.
function dgLoadGame(id, entry, v) {
  if (dgRegistry[id]) return Promise.resolve(dgRegistry[id].def);
  if (dgLoadPromises[id]) return dgLoadPromises[id];
  var src = '/games/' + encodeURIComponent(id) + '/' + encodeURIComponent(entry || 'main.js') + '?v=' + (v || Date.now());
  dgLoadPromises[id] = dgInjectScript(src).then(function () {
    delete dgLoadPromises[id];
    if (!dgRegistry[id]) throw new Error('game "' + id + '" did not call TRGames.register');
    dgRegistry[id].src = src;
    return dgRegistry[id].def;
  }, function (err) {
    delete dgLoadPromises[id];
    throw err;
  });
  return dgLoadPromises[id];
}

function dgInjectScript(src) {
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('script load failed: ' + src)); };
    document.head.appendChild(s);
  });
}

// ---- host adapter -------------------------------------------------------------
function dgMakeHost(id, stageEl) {
  var host = {
    container: stageEl,
    width: stageEl.clientWidth || 800,
    height: stageEl.clientHeight || 450,
    phaser: window.Phaser || null,
    saveState: function (obj) {
      return fetch('/api/games/' + encodeURIComponent(id) + '/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj == null ? {} : obj)
      }).then(function (r) {
        if (!r.ok) throw new Error('saveState -> ' + r.status);
      });
    },
    loadState: function () {
      return fetch('/api/games/' + encodeURIComponent(id) + '/state').then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('loadState -> ' + r.status);
        return r.json();
      });
    },
    sheetImageUrl: function (actionName) {
      return '/api/assistant/sheet-image/' + encodeURIComponent(actionName);
    },
    llmChat: function (req) {
      return fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: req.model, messages: req.messages, stream: false })
      }).then(function (r) {
        if (!r.ok) throw new Error('llmChat -> ' + r.status);
        return r.json();
      });
    },
    getAssistantConfig: function () {
      return fetch('/api/settings').then(function (r) {
        if (!r.ok) throw new Error('getAssistantConfig -> ' + r.status);
        return r.json();
      }).then(function (j) {
        return (j && j.assistant) ? j.assistant : null;
      });
    },
    getAssistantActions: function () {
      return host.getAssistantConfig().then(function (c) {
        return (c && c.actions) ? c.actions : [];
      });
    }
  };
  return host;
}

// ---- lifecycle -------------------------------------------------------------
function dgLaunch(id) {
  var meta = null;
  for (var i = 0; i < dgGames.length; i++) {
    if (dgGames[i].id === id) { meta = dgGames[i]; break; }
  }
  if (!meta) return Promise.reject(new Error('unknown game: ' + id));
  dgSetStatus(t('demoGamesLoading'));
  return dgLoadPhaser()
    .then(function () { return dgLoadGame(meta.id, meta.entry, meta.v); })
    .then(function (def) {
      dgStopGame();
      var stage = dgUi && dgUi.stage;
      if (!stage) throw new Error('game stage not rendered');
      stage.innerHTML = '';
      var handle = def.launch(dgMakeHost(def.id, stage));
      dgCurrent = { id: def.id, handle: handle || null };
      if (window.__ademo && typeof window.__ademo.setPaused === 'function') window.__ademo.setPaused(true);
      dgSetStatus('');
      dgSyncUi();
    })
    .catch(function (err) {
      dgSetStatus(t('demoGamesLoadError') + ': ' + (err && err.message));
      dgSyncUi();
      throw err;
    });
}

function dgStopGame() {
  if (!dgCurrent) return;
  var h = dgCurrent.handle;
  dgCurrent = null;
  try {
    if (h && typeof h.destroy === 'function') h.destroy(true);       // Phaser.Game
    else if (h && typeof h.dispose === 'function') h.dispose();      // custom handle
  } catch (e) { /* disposal errors must not break page navigation */ }
  if (dgUi && dgUi.stage) dgUi.stage.innerHTML = '';
  if (window.__ademo && typeof window.__ademo.setPaused === 'function') window.__ademo.setPaused(false);
  dgSyncUi();
}

// ---- UI ---------------------------------------------------------------------
function dgBindShellTabs(container) {
  var shell = container.querySelector('.demo-shell');
  if (!shell) return;
  // Single toggle button fallback (when ademo owns the toggle)
  var toggle = shell.querySelector('.demo-toggle');
  if (toggle) {
    // Fallback handler if ademo not loaded
    if (!window.__ademo || typeof window.__ademo.setActiveTab !== 'function') {
      toggle.addEventListener('click', function () {
        var isGames = toggle.textContent.trim() === 'Games';
        var next = isGames ? 'Assistant Demo' : 'Games';
        toggle.textContent = next;
        var ademoPane = shell.querySelector('.demo-pane-ademo');
        var gamesPane = shell.querySelector('.demo-pane-games');
        if (ademoPane) ademoPane.hidden = next === 'Games';
        if (gamesPane) gamesPane.hidden = next !== 'Games';
        toggle.blur();
      });
    }
  }
}

function dgEnsureToolbar() {
  if (!window.ademoInjectGamesToolbar) return;
  var injected = window.ademoInjectGamesToolbar(
    '<div class="dg-select-wrap" style="min-width:180px;flex:0 0 auto"></div>' +
    '<button type="button" class="btn dg-launch">' + escapeHtml(t('demoGamesLaunch')) + '</button>' +
    '<button type="button" class="btn btn-ghost dg-stop" disabled>' + escapeHtml(t('demoGamesStop')) + '</button>' +
    '<button type="button" class="btn btn-ghost dg-reload" data-tooltip="' + escapeHtml(t('demoGamesReloadDesc')) + '">' + escapeHtml(t('demoGamesReload')) + '</button>' +
    '<span class="dg-status" style="font-size:12px;color:var(--text-muted);white-space:nowrap"></span>'
  );
  if (!injected || injected.dataset.bound) return;
  injected.dataset.bound = '1';
  var selWrap = injected.querySelector('.dg-select-wrap');
  var launchBtn = injected.querySelector('.dg-launch');
  var stopBtn = injected.querySelector('.dg-stop');
  var reloadBtn = injected.querySelector('.dg-reload');
  var status = injected.querySelector('.dg-status');
  // Create a plain select and upgrade to custom-select on next sync
  var sel = document.createElement('select');
  sel.className = 'input dg-select';
  sel.setAttribute('data-tooltip', t('demoGamesSelect'));
  selWrap.appendChild(sel);
  // Keep dgUi.toolbar alias so existing callers find it
  if (!dgUi) dgUi = { status: status };
  dgUi.select = sel;
  dgUi.selWrap = selWrap;
  dgUi.launchBtn = launchBtn;
  dgUi.stopBtn = stopBtn;
  dgUi.reloadBtn = reloadBtn;
  dgUi.status = status;
  dgUi.toolbarFields = injected;
  launchBtn.addEventListener('click', function () {
    var id = sel.value;
    if (!id) return;
    dgLaunch(id).catch(function () {});
    launchBtn.blur();
  });
  stopBtn.addEventListener('click', function () { dgStopGame(); stopBtn.blur(); });
  reloadBtn.addEventListener('click', function () {
    var wasRunning = dgCurrent && dgCurrent.id;
    dgStopGame();
    if (wasRunning && dgRegistry[wasRunning]) delete dgRegistry[wasRunning];
    dgRefreshList().then(function () {
      if (wasRunning) {
        sel.value = wasRunning;
        if (selWrap && selWrap._customWrap) {
          // Custom select label will be synced by dgSyncUi select replacement
        }
        return dgLaunch(wasRunning).catch(function () {});
      }
    });
    reloadBtn.blur();
  });
}

function dgRenderSelect() {
  if (!dgUi || !dgUi.selWrap) return;
  var sel = dgUi.select;
  // If custom-select is available, build custom wrapper; else keep native select options.
  var useCustom = typeof renderCustomSelectHtml === 'function';
  if (useCustom) {
    var opts = dgGames.map(function (g) {
      return { value: g.id, label: (g.title || g.id) + (g.version ? ' v' + g.version : '') };
    });
    if (!dgGames.length) opts = [{ value: '', label: t('demoGamesEmpty') }];
    var cur = sel ? sel.value : (dgGames[0] && dgGames[0].id) || '';
    dgUi.selWrap.innerHTML = renderCustomSelectHtml('dg-select-wrap', 'dg-select', opts, cur, 'dgOnSelectChange(this.value)', 'min-width:180px');
    var newSel = dgUi.selWrap.querySelector('#dg-select');
    if (newSel) {
      dgUi.select = newSel;
      dgUi.selWrap._customWrap = dgUi.selWrap.querySelector('.custom-select-wrapper');
    }
    sel = newSel;
  }
  if (sel && dgGames.length) {
    sel.innerHTML = '';
    if (!dgGames.length) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = t('demoGamesEmpty');
      sel.appendChild(opt);
    } else {
      dgGames.forEach(function (g) {
        var opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = (g.title || g.id) + (g.version ? ' v' + g.version : '');
        sel.appendChild(opt);
      });
    }
  }
}
window.dgOnSelectChange = function (v) { if (dgUi && dgUi.select) dgUi.select.value = v; };
window.dgEnsureToolbar = dgEnsureToolbar;

function renderDemoGames(container) {
  cleanupDemoGames();

  // Shell is created by renderAssistantDemo (single toggle + toolbar in demo-toolbar).
  var shell = container.querySelector('.demo-shell');
  if (!shell) return;

  var gamesPane = shell.querySelector('.demo-pane-games');
  if (!gamesPane) {
    gamesPane = document.createElement('div');
    gamesPane.className = 'demo-pane-games';
    gamesPane.hidden = true;
    shell.appendChild(gamesPane);
  }

  // Toolbar row is now owned by .demo-toolbar in the shell; create stub pane only.
  gamesPane.innerHTML = '<div class="dg-root"><div class="dg-stage-wrap" hidden><div class="dg-stage"></div><button type="button" class="dg-fs-exit" aria-label="' + escapeHtml(t('demoExitFullscreen')) + '" style="display:none">' + DG_SVG_CLOSE + '</button></div></div>';
  var root = gamesPane.querySelector('.dg-root');
  dgUi = dgUi || {};
  dgUi.root = root;
  dgUi.stageWrap = root.querySelector('.dg-stage-wrap');
  dgUi.stage = root.querySelector('.dg-stage');
  dgUi.fsExit = root.querySelector('.dg-fs-exit');
  // Toolbar fields live in shell's demo-toolbar; ensure them.
  dgEnsureToolbar();
  if (!dgUi.select) {
    // Select will be populated by refresh; keep compatibility if toolbar injection failed
    var fallbackSel = gamesPane.querySelector('.dg-select') || document.querySelector('.dg-select');
    if (fallbackSel) dgUi.select = fallbackSel;
  }

  if (dgUi.fsExit) dgUi.fsExit.addEventListener('click', function () { dgSetFullscreen(false); this.blur(); });

  dgRefreshList();
}

function dgRefreshList() {
  return dgFetchList().then(function (games) {
    dgGames = games;
    if (!dgUi) return;
    if (dgUi.selWrap) dgRenderSelect();
    else if (dgUi.select) {
      var sel = dgUi.select;
      sel.innerHTML = '';
      if (!games.length) {
        var opt = document.createElement('option');
        opt.value = '';
        opt.textContent = t('demoGamesEmpty');
        sel.appendChild(opt);
      } else {
        games.forEach(function (g) {
          var opt = document.createElement('option');
          opt.value = g.id;
          opt.textContent = (g.title || g.id) + (g.version ? ' v' + g.version : '');
          sel.appendChild(opt);
        });
      }
    }
    dgSyncUi();
  }).catch(function (err) {
    dgSetStatus(t('demoGamesLoadError') + ': ' + (err && err.message));
  });
}

function dgSyncUi() {
  if (!dgUi) return;
  var running = !!dgCurrent;
  if (dgUi.stageWrap) dgUi.stageWrap.hidden = !running;
  var tf = document.querySelector('.dg-toolbar-fields');
  if (tf) tf.hidden = false; // always visible when Games tab active; parent shell hidden controls it
  if (dgUi.stopBtn) dgUi.stopBtn.disabled = !running;
  if (dgUi.launchBtn) dgUi.launchBtn.disabled = running || !dgGames.length;
  if (dgUi.select) dgUi.select.disabled = running;
  if (dgUi.fsExit) dgUi.fsExit.style.display = dgIsFullscreen() ? '' : 'none';
}

function dgSetStatus(msg) {
  if (dgUi && dgUi.status) dgUi.status.textContent = msg || '';
  if (dgUi && dgUi.fsExit) dgUi.fsExit.style.display = dgIsFullscreen() ? '' : 'none';
}

function cleanupDemoGames() {
  // Stage-only fullscreen is body-scoped; clear it on leave if we own it.
  if (document.body.classList.contains('demo-stage-fullscreen')) {
    // Don't force-clear if ademo still owns the stage (both share the class).
    // The ademo cleanup will clear it; here we just leave it.
}
  dgStopGame();
  dgUi = null;
}

// ---- test seam -------------------------------------------------------------
window.__dgames = {
  registry: dgRegistry,
  current: function () { return dgCurrent; },
  makeHost: dgMakeHost,
  fetchList: dgFetchList,
  loadGame: dgLoadGame,
  launch: dgLaunch,
  stop: dgStopGame,
  idRe: DG_ID_RE,
  // VM-test backdoor: inject a fake running game (same role as petSM.register).
  setCurrent: function (c) { dgCurrent = c; },
  isFullscreen: dgIsFullscreen,
  setFullscreen: dgSetFullscreen,
  toggleFullscreen: dgToggleFullscreen
};
