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
  return {
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
    }
  };
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
  shell.querySelectorAll('.demo-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tab = btn.getAttribute('data-tab');
      if (window.__ademo && typeof window.__ademo.setActiveTab === 'function') {
        window.__ademo.setActiveTab(tab);
      } else {
        // Fallback if ademo not yet loaded.
        shell.querySelectorAll('.demo-tab').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-tab') === tab);
        });
        var ademoPane = shell.querySelector('.demo-pane-ademo');
        var gamesPane = shell.querySelector('.demo-pane-games');
        if (ademoPane) ademoPane.hidden = tab !== 'ademo';
        if (gamesPane) gamesPane.hidden = tab !== 'games';
      }
      btn.blur();
    });
  });
}

function renderDemoGames(container) {
  cleanupDemoGames();

  // Ensure the shell exists (renderAssistantDemo creates it). If not, create a minimal shell.
  var shell = container.querySelector('.demo-shell');
  if (!shell) {
    // Fallback: wrap existing content (defensive; normal path has shell).
    var existing = container.innerHTML;
    container.innerHTML = '<div class="demo-shell"><div class="demo-tabs"><button type="button" class="btn demo-tab active" data-tab="ademo">' + escapeHtml(t('demoTabAssistant')) + '</button><button type="button" class="btn btn-ghost demo-tab" data-tab="games">' + escapeHtml(t('demoTabGames')) + '</button></div><div class="demo-pane-ademo">' + existing + '</div><div class="demo-pane-games" hidden></div></div>';
    shell = container.querySelector('.demo-shell');
    dgBindShellTabs(container);
  }

  var gamesPane = shell.querySelector('.demo-pane-games');
  if (!gamesPane) {
    gamesPane = document.createElement('div');
    gamesPane.className = 'demo-pane-games';
    gamesPane.hidden = true;
    shell.appendChild(gamesPane);
  }

  var root = document.createElement('div');
  root.className = 'dg-root';
  root.innerHTML =
    '<div class="dg-toolbar">' +
      '<span class="dg-title">' + escapeHtml(t('demoGamesTitle')) + '</span>' +
      '<select class="input dg-select" data-tooltip="' + escapeHtml(t('demoGamesSelect')) + '"></select>' +
      '<button type="button" class="btn dg-launch">' + escapeHtml(t('demoGamesLaunch')) + '</button>' +
      '<button type="button" class="btn btn-ghost dg-stop" disabled>' + escapeHtml(t('demoGamesStop')) + '</button>' +
      '<button type="button" class="btn btn-ghost dg-reload" data-tooltip="' + escapeHtml(t('demoGamesReloadDesc')) + '">' + escapeHtml(t('demoGamesReload')) + '</button>' +
      '<span class="dg-status"></span>' +
      '<span class="dg-fs-sep" style="flex:1"></span>' +
      '<button type="button" class="btn btn-ghost dg-fs-btn" data-tooltip="' + escapeHtml(t('demoEnterFullscreen')) + '" aria-label="' + escapeHtml(t('demoEnterFullscreen')) + '">' + DG_SVG_FULLSCREEN + '</button>' +
    '</div>' +
    '<div class="dg-stage-wrap" hidden><div class="dg-stage"></div><button type="button" class="dg-fs-exit" aria-label="' + escapeHtml(t('demoExitFullscreen')) + '" style="display:none">' + DG_SVG_CLOSE + '</button></div>';
  gamesPane.innerHTML = '';
  gamesPane.appendChild(root);

  dgUi = {
    root: root,
    select: root.querySelector('.dg-select'),
    launchBtn: root.querySelector('.dg-launch'),
    stopBtn: root.querySelector('.dg-stop'),
    reloadBtn: root.querySelector('.dg-reload'),
    status: root.querySelector('.dg-status'),
    stageWrap: root.querySelector('.dg-stage-wrap'),
    stage: root.querySelector('.dg-stage'),
    fsBtn: root.querySelector('.dg-fs-btn'),
    fsExit: root.querySelector('.dg-fs-exit')
  };

  dgUi.fsBtn.addEventListener('click', function () { dgToggleFullscreen(); this.blur(); });
  dgUi.fsExit.addEventListener('click', function () { dgSetFullscreen(false); this.blur(); });

  dgUi.launchBtn.addEventListener('click', function () {
    var id = dgUi.select.value;
    if (!id) return;
    dgLaunch(id).catch(function () { /* status already set */ });
    dgUi.launchBtn.blur();
  });
  dgUi.stopBtn.addEventListener('click', function () {
    dgStopGame();
    dgUi.stopBtn.blur();
  });
  dgUi.reloadBtn.addEventListener('click', function () {
    // Reload = re-scan the games dir, drop the registered entry so the next
    // launch re-fetches the (possibly edited) script, then relaunch if one
    // was running.
    var wasRunning = dgCurrent && dgCurrent.id;
    dgStopGame();
    if (wasRunning && dgRegistry[wasRunning]) delete dgRegistry[wasRunning];
    dgRefreshList().then(function () {
      if (wasRunning) {
        dgUi.select.value = wasRunning;
        return dgLaunch(wasRunning).catch(function () {});
      }
    });
    dgUi.reloadBtn.blur();
  });

  dgRefreshList();
}

function dgRefreshList() {
  return dgFetchList().then(function (games) {
    dgGames = games;
    if (!dgUi) return;
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
    dgSyncUi();
  }).catch(function (err) {
    dgSetStatus(t('demoGamesLoadError') + ': ' + (err && err.message));
  });
}

function dgSyncUi() {
  if (!dgUi) return;
  var running = !!dgCurrent;
  dgUi.stageWrap.hidden = !running;
  dgUi.stopBtn.disabled = !running;
  dgUi.launchBtn.disabled = running || !dgGames.length;
  dgUi.select.disabled = running;
  if (dgUi.fsBtn) {
    dgUi.fsBtn.setAttribute('aria-label', dgIsFullscreen() ? t('demoExitFullscreen') : t('demoEnterFullscreen'));
    dgUi.fsBtn.setAttribute('data-tooltip', dgIsFullscreen() ? t('demoExitFullscreen') : t('demoEnterFullscreen'));
  }
  if (dgUi.fsExit) dgUi.fsExit.style.display = dgIsFullscreen() ? '' : 'none';
}

function dgSetStatus(msg) {
  if (dgUi.fsExit) dgUi.fsExit.style.display = dgIsFullscreen() ? '' : 'none';
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
