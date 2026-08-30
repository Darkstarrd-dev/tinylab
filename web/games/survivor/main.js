// =============================================================================
// Survivor v0.2.0 — Vampire Survivors-style demo with dual-mode support
// =============================================================================
// IIFE + 'use strict'; classic script, no imports, no modules. Registered
// synchronously via window.TRGames.register({id, title, launch}). The host
// (web/static/demo-games.js :: dgMakeHost) injects the only external API:
//
//   host.container        HTMLElement — empty stage, canvas mounts here
//   host.width/height     number      — stage CSS px at launch time (fixed)
//   host.phaser           Phaser      — window.Phaser v4.2.1 (lazy-loaded)
//   host.saveState(obj)   Promise     — PUT /api/games/<id>/state (any JSON ≤1MB)
//   host.loadState()      Promise<obj|null> — 404 → null
//   host.sheetImageUrl(name) string   — GET /api/assistant/sheet-image/{name}
//   host.getAssistantConfig() Promise<{model,actions,enabled,debug}|null>
//   host.getAssistantActions() Promise<AssistantAction[]>
//   host.llmChat({model,messages}) Promise<parsed JSON>
//   host._survivorMode    string      — closure-owned selected mode
//   host._moveTarget      {x:number}|null — platformer right-click target
//
// All strings rendered as English literals (no t()/escapeHtml dependency).
//
// Phaser v4.2.1 traps preserved from v0.1.0:
//   1. overlap(group, gameObject, cb) callback arg order is NOT v3 order:
//      v4.2.1 delivers (gameObject, groupChild). Callbacks resolve roles via
//      group.contains() so they are order-agnostic (a naive first-arg assumption
//      destroyed the player on contact in the first CDP smoke).
//   2. physics sprite setPosition does NOT reliably teleport (body not updated
//      until next step, then overwritten). Use body.reset(x,y) for teleports.
//   3. See docs/gamedemo-progress.md §6 for the full list.
//
// Modes:
//   topdown    — gravity 0, 8-direction WASD/arrows, diagonal √½ normalized,
//                mouse aim optional, auto-turret, enemies chase in 2D.
//   platformer — gravity 2200 px/s², 1-D horizontal walk/slow/run (Shift/Ctrl),
//                W/UP/SPACE jump (grounded gate), S/DOWN fastfall, static
//                platforms + collider, X-only enemy chase, right-click x-target.
//
// Persisted state (via host.saveState/loadState):
//   { best: {kills:number, timeSec:number}, mode: 'topdown'|'platformer' }
//
// Test seam: window.__trgame = { game:Phaser.Game, getState():{hp,kills,timeSec,over,mode}, getMode():string }
//   sceneRef always points at the active gameplay scene (topdown/platformer),
//   not Boot/Menu. CDP drives via window.__trgame + scene internals.
//
// Full comment pass (v0.2.0) — every section banner + function JSDoc + tunable
// units + trap notes. Behaviour of v0.1.0 topdown is preserved inside
// TopdownScene; new scenes are Boot/Menu/Platformer + shared Pause overlay.
// =============================================================================
(function () {
  'use strict';

  // ==========================================================================
  // Tunables (per-mode) — units annotated; see assistant-demo.js for parity
  // ==========================================================================

  // ---- Shared (both modes) -------------------------------------------------
  /** ms between enemy spawns */
  var SHARED_SPAWN_INTERVAL = 1200;
  /** ms between auto-turret shots */
  var SHARED_FIRE_INTERVAL = 600;
  /** starting HP */
  var SHARED_START_HP = 3;
  /** invulnerable window after hit (ms) */
  var SHARED_INVINCIBLE_MS = 800;
  /** max live enemies */
  var SHARED_MAX_ENEMIES = 80;

  // ---- Topdown specifics ---------------------------------------------------
  /** player speed px/s (topdown) — matches v0.1.0 PLAYER_SPEED */
  var TOPDOWN_SPEED = 220;
  /** enemy chase speed px/s (topdown) */
  var TOPDOWN_ENEMY_SPEED = 92;
  /** bullet speed px/s */
  var TOPDOWN_BULLET_SPEED = 380;
  /** enemies spawn this far outside the field (px) */
  var TOPDOWN_SPAWN_MARGIN = 36;
  /** bullets spawn this far ahead of the player (px) */
  var TOPDOWN_BULLET_OFFSET = 18;
  /** bullets culled this far outside the field (px) */
  var TOPDOWN_BULLET_CULL = 48;

  // Legacy aliases so any copied v0.1.0 snippet still resolves.
  var PLAYER_SPEED = TOPDOWN_SPEED;
  var ENEMY_SPEED = TOPDOWN_ENEMY_SPEED;
  var BULLET_SPEED = TOPDOWN_BULLET_SPEED;
  var SPAWN_INTERVAL = SHARED_SPAWN_INTERVAL;
  var FIRE_INTERVAL = SHARED_FIRE_INTERVAL;
  var START_HP = SHARED_START_HP;
  var INVINCIBLE_MS = SHARED_INVINCIBLE_MS;
  var MAX_ENEMIES = SHARED_MAX_ENEMIES;
  var SPAWN_MARGIN = TOPDOWN_SPAWN_MARGIN;
  var BULLET_OFFSET = TOPDOWN_BULLET_OFFSET;
  var BULLET_CULL = TOPDOWN_BULLET_CULL;

  // ---- Platformer specifics ------------------------------------------------
  // Mirrors assistant-demo.js constants (ADEMO_GRAVITY etc.) for parity.
  /** walk speed px/s (platformer default) */
  var PLATFORMER_WALK = 160;
  /** slow walk px/s (Shift held) */
  var PLATFORMER_SLOW = 70;
  /** run speed px/s (Ctrl held, Shift wins) */
  var PLATFORMER_RUN = 340;
  /** gravity px/s² (platformer) — matches ADEMO_GRAVITY */
  var PLATFORMER_GRAVITY = 2200;
  /** jump initial velocity px/s (negative = upward) — matches ADEMO_JUMP_VEL */
  var PLATFORMER_JUMP_VEL = 760;
  /** extra gravity when holding Down mid-air px/s² — ADEMO_FASTFALL */
  var PLATFORMER_FASTFALL = 1400;
  /** terminal fall velocity px/s — ADEMO_TERMINAL_VY */
  var PLATFORMER_TERMINAL = 1600;
  /** platform texture base size (px) — generated at runtime */
  var PLATFORM_TEX_W = 120;
  var PLATFORM_TEX_H = 16;

  // ==========================================================================
  // Shared: Input mapping + sprite display (reusable for every future game)
  // ==========================================================================
  /** Default key bindings; mirror assistant-demo.js WASD/arrows/Jump/Pause. */
  var DEFAULT_BINDINGS = {
    up: ['W', 'UP'], down: ['S', 'DOWN'], left: ['A', 'LEFT'], right: ['D', 'RIGHT'],
    jump: ['W', 'UP', 'SPACE'], attack: ['SPACE'], pause: ['ESC'], menu: ['M'], restart: ['R'],
    run: ['CTRL'], slow: ['SHIFT']
  };
  /** Live bindings mutated by the Input mapping overlay. */
  var activeBindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
  /** 0.35–2.0 range; 1.0 = generated 28px disc baseline, matches editor 0.5→1.0 scaling. */
  var spriteScale = 1;
  /** Last resolved frame size (from assistant action def or fallback 28×28). */
  var spriteFrameW = 28, spriteFrameH = 28;
  /** Whether current action is a mirrored left-variant. */
  var spriteMirror = false;

  function keyName(e) {
    var c = e && e.code ? e.code : (e && e.key ? e.key : '');
    // Normalize code: "KeyA"→"A", "ArrowLeft"→"LEFT", "Space"→"SPACE"
    var u = String(c).toUpperCase();
    if (u.indexOf('KEY') === 0) u = u.slice(3);
    if (u === 'ARROWLEFT') u = 'LEFT';
    else if (u === 'ARROWRIGHT') u = 'RIGHT';
    else if (u === 'ARROWUP') u = 'UP';
    else if (u === 'ARROWDOWN') u = 'DOWN';
    else if (u === ' ') u = 'SPACE';
    else if (u === 'CONTROLLEFT' || u === 'CONTROLRIGHT' || u === 'CONTROL') u = 'CTRL';
    else if (u === 'SHIFTLEFT' || u === 'SHIFTRIGHT' || u === 'SHIFT') u = 'SHIFT';
    return u;
  }
  function applySpriteScaleTo(sceneSprite) {
    if (!sceneSprite) return;
    try {
      sceneSprite.setDisplaySize(spriteFrameW * spriteScale, spriteFrameH * spriteScale);
      // Keep physics body centered around the scaled display.
      if (sceneSprite.body) {
        sceneSprite.body.setSize(spriteFrameW * spriteScale * 0.72, spriteFrameH * spriteScale * 0.72, true);
      }
    } catch (e) {
      try { sceneSprite.setScale(spriteScale); } catch (e2) {}
    }
  }
  function applyFrameSizeFromAction(name) {
    // Look up action def if assistant is configured; otherwise use 28×28 fallback.
    if (assistantConfig && assistantConfig.actions) {
      for (var i = 0; i < assistantConfig.actions.length; i++) {
        var a = assistantConfig.actions[i];
        if (a.name !== name) continue;
        var cols = Math.max(1, a.cols || 1), rows = Math.max(1, a.rows || 1);
        // Natural size is the sheet image / (cols,rows); until loaded use
        // persisted per-action width/height derived from assistant-demo's scale
        // math: ademoSyncEntitySize uses frameW/frameH × persist.scale.
        // For survivor we derive a stable square fallback and let setDisplaySize
        // normalize already-loaded 'assist_*' textures on next scale apply.
        // Use 48×64 baseline divided by frame grid like the demo stage does.
        var img = null;
        // Try to get the texture's actual frame size if already loaded
        // (Phaser stores it on the texture source).
        var key = 'assist_' + name;
        try {
          // sceneRef may be null during boot; guard
          if (sceneRef && sceneRef.textures && sceneRef.textures.exists(key)) {
            var src = sceneRef.textures.get(key);
            if (src && src.source && src.source[0]) {
              spriteFrameW = src.source[0].width / cols;
              spriteFrameH = src.source[0].height / rows;
              spriteMirror = !!a.mirror;
              return;
            }
          }
        } catch (e) {}
        // Fallback: estimate from cols/rows against 48×64 baseline
        spriteFrameW = Math.max(8, Math.round(48 / cols * 0.9 + 28 / Math.max(cols, rows) * 0.1));
        spriteFrameH = Math.max(8, Math.round(64 / rows * 0.9 + 28 / Math.max(cols, rows) * 0.1));
        spriteMirror = !!a.mirror;
        return;
      }
    }
    // Not an assistant action — generated player/enemy: keep 28×28
    spriteFrameW = 28; spriteFrameH = 28; spriteMirror = false;
  }
  function loadInputBindingsFromState(data) {
    if (data && data.inputBindings && typeof data.inputBindings === 'object') {
      var b = data.inputBindings;
      // Validate: each key must be array of strings; unknown actions ignored.
      for (var k in DEFAULT_BINDINGS) {
        if (b[k] && Array.isArray(b[k]) && b[k].length && b[k].every(function (x) { return typeof x === 'string' && x; })) {
          activeBindings[k] = b[k].slice();
        }
      }
    }
    if (data && typeof data.spriteScale === 'number' && isFinite(data.spriteScale) && data.spriteScale >= 0.35 && data.spriteScale <= 2.0) {
      spriteScale = Math.round(data.spriteScale * 100) / 100;
    }
  }
  function persistInputAndSprite() {
    if (!hostRef || typeof hostRef.saveState !== 'function') return;
    try {
      hostRef.loadState().then(function (prev) {
        var best = (prev && prev.best) ? prev.best : (bestScore !== null ? { kills: bestScore, timeSec: 0 } : null);
        var mode = (prev && prev.mode) || selectedMode;
        hostRef.saveState({ best: best, mode: mode, inputBindings: activeBindings, spriteScale: spriteScale }).then(function () {}, function () {});
      }, function () {
        hostRef.saveState({ mode: selectedMode, inputBindings: activeBindings, spriteScale: spriteScale }).then(function () {}, function () {});
      });
    } catch (e) {}
  }

  // ==========================================================================
  // State & seam — closed-over references exposed via window.__trgame
  // ==========================================================================
  /** @type {object|null} host adapter injected by TRGames */
  var hostRef = null;
  /** @type {Phaser.Scene|null} active gameplay scene (topdown or platformer) */
  var sceneRef = null;
  /** @type {object|null} last fetched assistant config {model, actions, enabled, debug} */
  var assistantConfig = null;
  /** @type {Object.<string,string>} action name -> Phaser texture key ('assist_'+name) */
  var assistantTextures = {};
  /** @type {'topdown'|'platformer'} selected mode (menu-driven, persisted) */
  var selectedMode = 'topdown';
  /** @type {number|null} best score = kills + floor(timeSec), restored from storage */
  var bestScore = null;
  // Pending action name awaiting a key rebind capture (null when idle).
  var pendingRebind = null;

  /**
   * Read the current gameplay state for the CDP seam.
   * @returns {{hp:number, kills:number, timeSec:number, over:boolean, mode:string}}
   */
  function getState() {
    var s = sceneRef;
    if (!s) {
      return { hp: SHARED_START_HP, kills: 0, timeSec: 0, over: false, mode: selectedMode };
    }
    return {
      hp: s.hp,
      kills: s.kills,
      timeSec: Math.round(s.timeMs / 1000),
      over: s.over,
      mode: selectedMode
    };
  }

  /**
   * @returns {'topdown'|'platformer'} currently selected mode
   */
  function getMode() {
    return selectedMode;
  }

  // ── Input-mapping helpers (used by gameplay scenes + overlays) ──────────
  function pressed(scene, action) {
    if (!scene || !scene.input || !scene.input.keyboard) return false;
    var keys = activeBindings[action];
    if (!keys || !keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      var code = keys[i].toUpperCase();
      var ph = code === 'SPACE' ? 'SPACE' : (code === 'LEFT' ? 'LEFT' : (code === 'RIGHT' ? 'RIGHT' : (code === 'UP' ? 'UP' : (code === 'DOWN' ? 'DOWN' : (code === 'ESC' ? 'ESC' : code)))));
      try {
        if (code.length === 1) {
          var k = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes[code]);
          if (k && k.isDown) return true;
        } else {
          var kc = Phaser.Input.Keyboard.KeyCodes[ph];
          if (kc !== undefined) {
            var k2 = scene.input.keyboard.addKey(kc);
            if (k2 && k2.isDown) return true;
          }
        }
      } catch (e) {}
    }
    return false;
  }
  function justPressed(scene, action) {
    var keys = activeBindings[action];
    if (!keys || !keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      var code = keys[i].toUpperCase();
      var ph = code === 'SPACE' ? 'SPACE' : (code === 'LEFT' ? 'LEFT' : (code === 'RIGHT' ? 'RIGHT' : (code === 'UP' ? 'UP' : (code === 'DOWN' ? 'DOWN' : (code === 'ESC' ? 'ESC' : code)))));
      try {
        if (code.length === 1) {
          var k = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes[code]);
          if (k && Phaser.Input.Keyboard.JustDown(k)) return true;
        } else {
          var kc = Phaser.Input.Keyboard.KeyCodes[ph];
          if (kc !== undefined) {
            var k2 = scene.input.keyboard.addKey(kc);
            if (Phaser.Input.Keyboard.JustDown(k2)) return true;
          }
        }
      } catch (e) {}
    }
    return false;
  }
  function anyManualDir(scene) {
    return pressed(scene, 'left') || pressed(scene, 'right') || pressed(scene, 'up') || pressed(scene, 'down');
  }

  // ==========================================================================
  // Texture generation — all visuals are code-generated via Graphics
  // ==========================================================================

  /**
   * Build the shared textures (player, bullets, enemies, 1×1 panel).
   * Called once per scene create (and again on restart). Idempotent — if the
   * texture already exists in the Texture Manager it is removed first so
   * scene.restart() does not throw duplicate-key errors.
   * @param {Phaser.Scene} scene
   */
  function buildTextures(scene) {
    var g;
    // Helper: remove stale texture before regenerating (scene.restart safety).
    function ensureRemoved(key) {
      if (scene.textures.exists(key)) { scene.textures.remove(key); }
    }

    // Player: light-blue disc with a nose so setAngle() / facing is readable.
    ensureRemoved('player');
    g = scene.add.graphics();
    g.fillStyle(0x4fc3f7, 1);
    g.fillCircle(14, 14, 11);
    g.fillTriangle(27, 14, 18, 8, 18, 20);
    g.generateTexture('player', 28, 28);
    g.destroy();

    // Bullet: amber disc with bright core.
    ensureRemoved('bullet');
    g = scene.add.graphics();
    g.fillStyle(0xffd54f, 1);
    g.fillCircle(5, 5, 4);
    g.fillStyle(0xfff9c4, 1);
    g.fillCircle(5, 5, 2);
    g.generateTexture('bullet', 10, 10);
    g.destroy();

    // Enemy 1 HP: red disc.
    ensureRemoved('enemy1');
    g = scene.add.graphics();
    g.fillStyle(0xe57373, 1);
    g.fillCircle(13, 13, 11);
    g.generateTexture('enemy1', 26, 26);
    g.destroy();

    // Enemy 2 HP: larger purple disc.
    ensureRemoved('enemy2');
    g = scene.add.graphics();
    g.fillStyle(0xba68c8, 1);
    g.fillCircle(16, 16, 14);
    g.generateTexture('enemy2', 32, 32);
    g.destroy();

    // 1×1 white pixel — tinted + stretched for dim/pause overlays.
    ensureRemoved('panel');
    g = scene.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 1, 1);
    g.generateTexture('panel', 1, 1);
    g.destroy();
  }

  /**
   * Generate the platform texture for Platformer mode.
   * @param {Phaser.Scene} scene
   */
  function buildPlatformTexture(scene) {
    if (scene.textures.exists('platform')) { scene.textures.remove('platform'); }
    var g = scene.add.graphics();
    g.fillStyle(0x2a3a56, 1);
    g.fillRect(0, 0, PLATFORM_TEX_W, PLATFORM_TEX_H);
    // Subtle highlight edge so platforms read as solid.
    g.fillStyle(0x3a4d6a, 1);
    g.fillRect(0, 0, PLATFORM_TEX_W, 3);
    g.generateTexture('platform', PLATFORM_TEX_W, PLATFORM_TEX_H);
    g.destroy();
  }

  /**
   * @param {number} min
   * @param {number} max
   * @returns {number} integer in [min, max]
   */
  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  // ==========================================================================
  // Assistant Bridge — import host action/state/sprite into the game
  // ==========================================================================

  /**
   * Fetch the assistant config via host.getAssistantConfig().
   * Falls back to null on any failure (no assistant data = use generated
   * textures). Caches the result in assistantConfig for the session.
   * @returns {Promise<object|null>}
   */
  function fetchAssistantData() {
    if (!hostRef || typeof hostRef.getAssistantConfig !== 'function') {
      return Promise.resolve(null);
    }
    try {
      return hostRef.getAssistantConfig().then(function (c) {
        assistantConfig = c;
        return c;
      }, function () {
        return null;
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /**
   * Load assistant spritesheet images into the given scene's Texture Manager.
   * For each action with a non-empty name + spritesheetPath, creates an
   * <img> whose src is host.sheetImageUrl(name); onload registers it as
   * 'assist_<name>'. Failures are silently ignored — the game remains playable
   * with generated textures.
   * @param {Phaser.Scene} scene
   */
  function loadAssistantTextures(scene) {
    if (!assistantConfig || !assistantConfig.actions || !hostRef) { return; }
    var actions = assistantConfig.actions;
    for (var i = 0; i < actions.length; i++) {
      (function (action) {
        var name = action && action.name;
        var path = action && action.spritesheetPath;
        if (!name || !path) { return; }
        var key = 'assist_' + name;
        // Skip if already loaded or already loading.
        if (assistantTextures[key] || (scene.textures && scene.textures.exists(key))) {
          assistantTextures[key] = key;
          return;
        }
        var img = new Image();
        img.onload = function () {
          try {
            if (scene.textures && !scene.textures.exists(key)) {
              scene.textures.addImage(key, img);
            }
            assistantTextures[key] = key;
          } catch (e) { /* ignore */ }
        };
        img.onerror = function () { /* missing file — keep generated texture */ };
        try {
          img.src = hostRef.sheetImageUrl(name);
        } catch (e) { /* ignore */ }
      })(actions[i]);
    }
  }

  /**
   * Alias table mirroring web/static/assistant-demo.js EVENT_ALIASES for the
   * subset the game cares about (idle + directional move + jump/fall/attack).
   * Each entry is an ordered fallback chain — first existing assistant texture
   * wins, otherwise the generated 'player' texture is used.
   * Mirrors assistant-demo.js entries so assistant actions like 'walk_left',
   * 'jump', 'attack' are picked up without extra wiring.
   */
  var SURVIVOR_ALIASES = {
    idle: ['idle', 'stand', 'default'],
    move_left: ['move_left', 'walk_left', 'walk_l', 'left_walk', 'walk', 'move'],
    move_right: ['move_right', 'walk_right', 'walk_r', 'right_walk', 'move_left', 'walk', 'move'],
    move_up: ['move_up', 'walk_up', 'up_walk', 'walk_north', 'walk', 'move'],
    move_down: ['move_down', 'walk_down', 'down_walk', 'walk_south', 'walk', 'move'],
    move_up_left: ['move_up_left', 'walk_up_left', 'walk_ul', 'walk_nw', 'move_up', 'move_left', 'walk', 'move'],
    move_down_left: ['move_down_left', 'walk_down_left', 'walk_dl', 'walk_sw', 'move_down', 'move_left', 'walk', 'move'],
    move_up_right: ['move_up_right', 'walk_up_right', 'walk_ur', 'walk_ne', 'move_up_left', 'walk_up_left', 'move_up', 'move_left', 'walk', 'move'],
    move_down_right: ['move_down_right', 'walk_down_right', 'walk_dr', 'walk_se', 'move_down_left', 'walk_down_left', 'move_down', 'move_left', 'walk', 'move'],
    walk: ['walk', 'move', 'run'],
    run: ['run', 'dash', 'walk', 'move'],
    run_left: ['run_left', 'move_left', 'run_l', 'run', 'dash', 'walk', 'move'],
    jump: ['jump', 'leap'],
    fall: ['fall', 'jump', 'leap'],
    attack: ['attack', 'shoot', 'hit']
  };

  /**
   * Resolve an event name (e.g. 'move_left', 'jump') to the best available
   * Phaser texture key. Checks the SURVIVOR_ALIASES fallback chain for the
   * first key that exists in assistantTextures / scene.textures; falls back
   * to the generated 'player' key if none match.
   * @param {string} eventName
   * @param {Phaser.Scene} [scene] optional — if provided, checks scene.textures
   * @returns {string} texture key to use with setTexture()
   */
  function resolvePlayerTexture(eventName, scene) {
    var chain = SURVIVOR_ALIASES[eventName] || SURVIVOR_ALIASES.idle;
    for (var i = 0; i < chain.length; i++) {
      var key = 'assist_' + chain[i];
      if (assistantTextures[key]) { applyFrameSizeFromAction(chain[i]); return key; }
      if (scene && scene.textures && scene.textures.exists(key)) { applyFrameSizeFromAction(chain[i]); return key; }
    }
    var direct = 'assist_' + eventName;
    if (assistantTextures[direct]) { applyFrameSizeFromAction(eventName); return direct; }
    if (scene && scene.textures && scene.textures.exists(direct)) { applyFrameSizeFromAction(eventName); return direct; }
    spriteFrameSize = { w: 28, h: 28 };
    spriteIsLeftVariant = false;
    return 'player';
  }

  /**
   * Resolve enemy texture — prefers assistant actions 'enemy'/'enemy1'/'enemy2'
   * if present, else falls back to generated enemy textures.
   * @param {boolean} strong
   * @param {Phaser.Scene} [scene]
   * @returns {string}
   */
  function resolveEnemyTexture(strong, scene) {
    var candidates = strong ? ['enemy2', 'enemy'] : ['enemy1', 'enemy'];
    for (var i = 0; i < candidates.length; i++) {
      var key = 'assist_' + candidates[i];
      if (assistantTextures[key]) { return key; }
      if (scene && scene.textures && scene.textures.exists(key)) { return key; }
    }
    return strong ? 'enemy2' : 'enemy1';
  }

  /**
   * Derive the motion event name for topdown (8-dir) from velocity / aim.
   * Mirrors assistant-demo.js ademoMotionEvent() topdown branch.
   * @param {number} dx normalized X intent
   * @param {number} dy normalized Y intent
   * @param {boolean} isRun Ctrl without Shift
   * @returns {string}
   */
  function motionEventTopdown(dx, dy, isRun) {
    if (dx === 0 && dy === 0) { return 'idle'; }
    var left = dx < 0, right = dx > 0, up = dy < 0, down = dy > 0;
    if (up && left) { return 'move_up_left'; }
    if (down && left) { return 'move_down_left'; }
    if (up && right) { return 'move_up_right'; }
    if (down && right) { return 'move_down_right'; }
    if (up) { return 'move_up'; }
    if (down) { return 'move_down'; }
    if (left) { return isRun ? 'run_left' : 'move_left'; }
    if (right) { return isRun ? 'run' : 'move_right'; }
    return 'idle';
  }

  /**
   * Derive the motion event for platformer (grounded vs air + horizontal).
   * @param {number} dir -1/0/1
   * @param {boolean} onGround
   * @param {number} vy vertical velocity
   * @param {boolean} isRun
   * @returns {string}
   */
  function motionEventPlatformer(dir, onGround, vy, isRun) {
    if (!onGround) { return vy < 0 ? 'jump' : 'fall'; }
    if (dir !== 0) {
      if (dir < 0) { return isRun ? 'run_left' : 'move_left'; }
      return isRun ? 'run' : 'walk';
    }
    return 'idle';
  }

  // ==========================================================================
  // Pause overlay — shared helper for both gameplay scenes
  // ==========================================================================

  /**
   * Show the pause overlay for a scene. Adds a dim + text + interactive
   * Resume/Menu options. Caller must have already paused the scene or will do
   * so. The overlay objects are stored on scene._pauseOverlay for cleanup.
   * @param {Phaser.Scene} scene
   * @param {string} sceneKey key of the scene being paused (for resume)
   */
  function showPauseOverlay(scene, sceneKey) {
    if (scene._pauseOverlay) { return; }
    var w = scene.cameras.main.width;
    var h = scene.cameras.main.height;
    var dim = scene.add.sprite(0, 0, 'panel');
    dim.setOrigin(0, 0);
    dim.setDisplaySize(w, h);
    dim.setTint(0x0b0e14);
    dim.setAlpha(0.62);
    dim.setDepth(70);
    var title = scene.add.text(w / 2, h / 2 - 40, 'PAUSED', {
      fontFamily: 'monospace', fontSize: '24px', color: '#e8e8e8', align: 'center'
    });
    title.setOrigin(0.5, 0.5);
    title.setDepth(71);
    var resume = scene.add.text(w / 2, h / 2 + 12, 'Resume (ESC)', {
      fontFamily: 'monospace', fontSize: '15px', color: '#7fe0a0', align: 'center',
      backgroundColor: '#1a2332', padding: { x: 10, y: 6 }
    });
    resume.setOrigin(0.5, 0.5);
    resume.setDepth(71);
    resume.setInteractive({ useHandCursor: true });
    resume.on('pointerdown', function () { hidePauseOverlay(scene, sceneKey); });
    var menu = scene.add.text(w / 2, h / 2 + 44, 'Menu (M)', {
      fontFamily: 'monospace', fontSize: '15px', color: '#8ab4f8', align: 'center',
      backgroundColor: '#1a2332', padding: { x: 10, y: 6 }
    });
    menu.setOrigin(0.5, 0.5);
    menu.setDepth(71);
    menu.setInteractive({ useHandCursor: true });
    menu.on('pointerdown', function () {
      hidePauseOverlay(scene, sceneKey);
      try { scene.scene.stop(sceneKey); } catch (e) { /* ignore */ }
      scene.scene.start('menu');
    });
    scene._pauseOverlay = [dim, title, resume, menu];
    scene._pauseKey = sceneKey;
  }

  /**
   * Remove the pause overlay and resume the scene if paused.
   * @param {Phaser.Scene} scene
   * @param {string} sceneKey
   */
  function hidePauseOverlay(scene, sceneKey) {
    if (!scene._pauseOverlay) { return; }
    for (var i = 0; i < scene._pauseOverlay.length; i++) {
      try { scene._pauseOverlay[i].destroy(); } catch (e) { /* ignore */ }
    }
    scene._pauseOverlay = null;
    scene._pauseKey = null;
    try { scene.scene.resume(sceneKey); } catch (e) { /* already resumed */ }
  }

  // ── Input mapping overlay (reusable demo module) ────────────────────────
  function showInputOverlay(scene, sceneKey) {
    if (scene._inputOverlay) return;
    var w = scene.cameras.main.width, h = scene.cameras.main.height;
    var bg = scene.add.sprite(0, 0, 'panel').setOrigin(0, 0).setDisplaySize(w, h).setTint(0x0b0e14).setAlpha(0.78).setDepth(80);
    var title = scene.add.text(w / 2, 30, 'Input Mapping  (click a row, press a key)', { fontFamily: 'monospace', fontSize: '14px', color: '#e8e8e8', align: 'center' }).setOrigin(0.5, 0).setDepth(81);
    var rows = [];
    var actions = ['up', 'down', 'left', 'right', 'jump', 'attack', 'pause', 'restart', 'menu'];
    var y0 = 62, lh = 22;
    for (var i = 0; i < actions.length; i++) {
      (function (act, idx) {
        var y = y0 + idx * lh;
        var label = scene.add.text(40, y, act.toUpperCase(), { fontFamily: 'monospace', fontSize: '12px', color: '#8ab4f8' }).setDepth(81);
        var val = (activeBindings[act] || []).join(' / ') || '-';
        var btn = scene.add.text(w - 40, y, val, { fontFamily: 'monospace', fontSize: '12px', color: '#7fe0a0', backgroundColor: '#1a2332', padding: { x: 6, y: 2 } }).setOrigin(1, 0).setDepth(81).setInteractive({ useHandCursor: true });
        btn.on('pointerdown', function () {
          pendingRebind = act;
          btn.setText('… press a key …');
          btn.setStyle({ color: '#ffd54f' });
        });
        rows.push({ label: label, btn: btn, act: act });
      })(actions[i], i);
    }
    var hint = scene.add.text(w / 2, y0 + actions.length * lh + 10, 'ESC closes  ·  Backspace clears  ·  changes save to host.saveState', { fontFamily: 'monospace', fontSize: '10px', color: '#8b949e', align: 'center' }).setOrigin(0.5, 0).setDepth(81);
    var close = scene.add.text(w - 12, 12, '✕', { fontFamily: 'monospace', fontSize: '18px', color: '#e8e8e8' }).setOrigin(1, 0).setDepth(81).setInteractive({ useHandCursor: true });
    close.on('pointerdown', function () { hideInputOverlay(scene, sceneKey); });
    scene._inputOverlay = [bg, title, hint, close].concat(rows.reduce(function (a, r) { return a.concat([r.label, r.btn]); }, []));
    scene._inputRows = rows;
    scene._inputClose = close;
    scene._inputKeyHandler = function (e) {
      if (!pendingRebind) {
        if (e.key === 'Escape') hideInputOverlay(scene, sceneKey);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { pendingRebind = null; refreshInputRows(scene); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        activeBindings[pendingRebind] = [];
        pendingRebind = null;
        persistInputAndSprite();
        refreshInputRows(scene);
        return;
      }
      var code = keyName(e);
      if (!code) return;
      activeBindings[pendingRebind] = [code];
      pendingRebind = null;
      persistInputAndSprite();
      refreshInputRows(scene);
    };
    document.addEventListener('keydown', scene._inputKeyHandler, true);
    scene._inputOverlayKey = sceneKey;
  }
  function refreshInputRows(scene) {
    var rows = scene._inputRows;
    if (!rows) return;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var val = (activeBindings[r.act] || []).join(' / ') || '-';
      if (pendingRebind === r.act) { r.btn.setText('… press a key …'); r.btn.setStyle({ color: '#ffd54f' }); }
      else { r.btn.setText(val); r.btn.setStyle({ color: '#7fe0a0' }); }
    }
  }
  function hideInputOverlay(scene, _sceneKey) {
    if (!scene._inputOverlay) return;
    if (scene._inputKeyHandler) { try { document.removeEventListener('keydown', scene._inputKeyHandler, true); } catch (e) {} scene._inputKeyHandler = null; }
    pendingRebind = null;
    for (var i = 0; i < scene._inputOverlay.length; i++) { try { scene._inputOverlay[i].destroy(); } catch (e2) {} }
    scene._inputOverlay = null; scene._inputRows = null; scene._inputClose = null; scene._inputOverlayKey = null;
  }
  // ── Sprite settings overlay (reusable demo module) ──────────────────────
  function showSpriteOverlay(scene, sceneKey) {
    if (scene._spriteOverlay) return;
    var w = scene.cameras.main.width, h = scene.cameras.main.height;
    var bg = scene.add.sprite(0, 0, 'panel').setOrigin(0, 0).setDisplaySize(w, h).setTint(0x0b0e14).setAlpha(0.78).setDepth(80);
    var title = scene.add.text(w / 2, 30, 'Sprite Settings', { fontFamily: 'monospace', fontSize: '14px', color: '#e8e8e8', align: 'center' }).setOrigin(0.5, 0).setDepth(81);
    var info = scene.add.text(w / 2, 58, 'Assistant sheets (when configured) or generated discs', { fontFamily: 'monospace', fontSize: '10px', color: '#8b949e', align: 'center' }).setOrigin(0.5, 0).setDepth(81);
    var cur = scene.add.text(w / 2, 84, 'Scale: ' + spriteScale.toFixed(2) + '  Frame: ' + (spriteFrameSize ? spriteFrameSize.w + '×' + spriteFrameSize.h : '—'), { fontFamily: 'monospace', fontSize: '11px', color: '#c9d1d9', align: 'center' }).setOrigin(0.5, 0).setDepth(81);
    function refreshInfo() {
      cur.setText('Scale: ' + spriteScale.toFixed(2) + '  Frame: ' + (spriteFrameSize ? spriteFrameSize.w + '×' + spriteFrameSize.h : '—') + (spriteIsLeftVariant ? '  [left-variant]' : ''));
    }
    var btnMinus = scene.add.text(w / 2 - 60, 108, ' − ', { fontFamily: 'monospace', fontSize: '16px', color: '#ffffff', backgroundColor: '#1a2332', padding: { x: 14, y: 6 } }).setOrigin(0.5, 0).setDepth(81).setInteractive({ useHandCursor: true });
    var btnPlus = scene.add.text(w / 2 + 60, 108, ' + ', { fontFamily: 'monospace', fontSize: '16px', color: '#ffffff', backgroundColor: '#1a2332', padding: { x: 14, y: 6 } }).setOrigin(0.5, 0).setDepth(81).setInteractive({ useHandCursor: true });
    var btnReset = scene.add.text(w / 2, 144, 'Reset (1.00)', { fontFamily: 'monospace', fontSize: '11px', color: '#8ab4f8', backgroundColor: '#1a2332', padding: { x: 10, y: 4 } }).setOrigin(0.5, 0).setDepth(81).setInteractive({ useHandCursor: true });
    var close = scene.add.text(w - 12, 12, '✕', { fontFamily: 'monospace', fontSize: '18px', color: '#e8e8e8' }).setOrigin(1, 0).setDepth(81).setInteractive({ useHandCursor: true });
    close.on('pointerdown', function () { hideSpriteOverlay(scene, sceneKey); });
    function apply(n) {
      spriteScale = Math.max(0.35, Math.min(2.0, n));
      refreshInfo();
      if (scene.player) applySpriteScaleTo(scene.player);
      persistInputAndSprite();
    }
    btnMinus.on('pointerdown', function () { apply(spriteScale - 0.1); });
    btnPlus.on('pointerdown', function () { apply(spriteScale + 0.1); });
    btnReset.on('pointerdown', function () { apply(1.0); });
    var escHandler = function (e) { if (e.key === 'Escape') hideSpriteOverlay(scene, sceneKey); };
    document.addEventListener('keydown', escHandler, true);
    scene._spriteOverlay = [bg, title, info, cur, btnMinus, btnPlus, btnReset, close];
    scene._spriteEsc = escHandler;
    scene._spriteOverlayKey = sceneKey;
  }
  function hideSpriteOverlay(scene, _sceneKey) {
    if (!scene._spriteOverlay) return;
    if (scene._spriteEsc) { try { document.removeEventListener('keydown', scene._spriteEsc, true); } catch (e) {} scene._spriteEsc = null; }
    for (var i = 0; i < scene._spriteOverlay.length; i++) { try { scene._spriteOverlay[i].destroy(); } catch (e2) {} }
    scene._spriteOverlay = null; scene._spriteOverlayKey = null;
  }

  // ==========================================================================
  // Entry point — launch(host)
  // ==========================================================================

  /**
   * Launch the game inside host.container. Defines all scenes as closures
   * so they can access hostRef, selectedMode, assistant bridge, etc.
   * @param {object} host — TRGames host adapter (see file header)
   * @returns {Phaser.Game}
   */
  function launch(host) {
    var Phaser = host.phaser;
    hostRef = host;
    // Expose selectedMode on host for external reads (menu buttons write it too).
    hostRef._survivorMode = selectedMode;

    // ----------------------------------------------------------------------
    // BootScene — generates textures, restores persisted best + mode
    // ----------------------------------------------------------------------
    var BootScene = class extends Phaser.Scene {
      constructor() { super({ key: 'boot' }); }
      create() {
        var self = this;
        buildTextures(self);
        buildPlatformTexture(self);
        // Restore best score + mode from storage (async, non-fatal).
        // Also restore inputBindings/spriteScale so demos survive reload.
        // Try to load assistant data as well so textures can be prefetched.
        var stateP = Promise.resolve(null);
        if (hostRef && typeof hostRef.loadState === 'function') {
          try {
            stateP = hostRef.loadState().then(function (data) { return data; }, function () { return null; });
          } catch (e) { stateP = Promise.resolve(null); }
        }
        var assistP = fetchAssistantData();
        Promise.all([stateP, assistP]).then(function (results) {
          var data = results[0];
          // State shape: { best: {kills, timeSec}, mode, inputBindings, spriteScale }
          if (data) {
            if (data.best && typeof data.best.kills === 'number' && typeof data.best.timeSec === 'number') {
              bestScore = data.best.kills + Math.floor(data.best.timeSec);
            }
            if (data.mode === 'platformer' || data.mode === 'topdown') {
              selectedMode = data.mode;
              hostRef._survivorMode = selectedMode;
            }
            try { loadInputBindingsFromState(data); } catch (e2) {}
          }
          // Prefetch assistant textures while we're still in Boot.
          try { loadAssistantTextures(self); } catch (e) { /* ignore */ }
          self.scene.start('menu');
        }).catch(function () {
          // Even if everything fails, go to menu.
          self.scene.start('menu');
        });
        // Also optimistically try loading assistant textures right away (in case
        // fetch already resolved synchronously or was cached).
        try { loadAssistantTextures(self); } catch (e) { /* ignore */ }
      }
    };

    // ----------------------------------------------------------------------
    // MenuScene — title + mode selector + Start + Best + How to Play
    // ----------------------------------------------------------------------
    var MenuScene = class extends Phaser.Scene {
      constructor() { super({ key: 'menu' }); }
      create() {
        var w = this.cameras.main.width;
        var h = this.cameras.main.height;
        var self = this;

        // Ensure gravity is reset when returning to menu (platformer leaves it on).
        try { this.physics.world.gravity.y = 0; } catch (e) { /* ignore */ }

        // Background — reuse the panel tint logic for a subtle frame.
        // Title
        var title = this.add.text(w / 2, h * 0.16, 'SURVIVOR v0.2.0', {
          fontFamily: 'monospace', fontSize: '22px', color: '#e8e8e8', align: 'center'
        });
        title.setOrigin(0.5, 0.5);
        this.add.text(w / 2, h * 0.16 + 22, 'Dual-mode demo  ·  host data aware', {
          fontFamily: 'monospace', fontSize: '11px', color: '#8b949e', align: 'center'
        }).setOrigin(0.5, 0.5);

        // Best line (updated when async load arrives; show '-' until then).
        var bestLabel = bestScore === null ? '-' : String(bestScore);
        var bestText = this.add.text(w / 2, h * 0.28, 'Best: ' + bestLabel, {
          fontFamily: 'monospace', fontSize: '13px', color: '#8b949e', align: 'center'
        });
        bestText.setOrigin(0.5, 0.5);
        // Poll for late bestScore arrival (Boot async may still be pending on first create).
        this._bestPoll = this.time.addEvent({
          delay: 300, loop: true, callback: function () {
            var cur = bestScore === null ? '-' : String(bestScore);
            var txt = 'Best: ' + cur;
            if (bestText.text !== txt) { bestText.setText(txt); }
          }
        });

        // Try to lazily load assistant data if Boot didn't (e.g. direct reload).
        if (!assistantConfig && hostRef && typeof hostRef.getAssistantConfig === 'function') {
          fetchAssistantData().then(function () { try { loadAssistantTextures(self); } catch (e) {} });
        } else {
          try { loadAssistantTextures(self); } catch (e) {}
        }

        // Mode buttons — two side-by-side pills.
        var btnTopdown = this.add.text(w / 2 - 86, h * 0.42, 'Topdown', {
          fontFamily: 'monospace', fontSize: '14px', color: '#e8e8e8',
          backgroundColor: selectedMode === 'topdown' ? '#1f6feb' : '#1a2332',
          padding: { x: 14, y: 8 }
        });
        btnTopdown.setOrigin(0.5, 0.5);
        btnTopdown.setInteractive({ useHandCursor: true });
        var btnPlatformer = this.add.text(w / 2 + 86, h * 0.42, 'Platformer', {
          fontFamily: 'monospace', fontSize: '14px', color: '#e8e8e8',
          backgroundColor: selectedMode === 'platformer' ? '#1f6feb' : '#1a2332',
          padding: { x: 14, y: 8 }
        });
        btnPlatformer.setOrigin(0.5, 0.5);
        btnPlatformer.setInteractive({ useHandCursor: true });

        function refreshModeButtons() {
          btnTopdown.setBackgroundColor(selectedMode === 'topdown' ? '#1f6feb' : '#1a2332');
          btnPlatformer.setBackgroundColor(selectedMode === 'platformer' ? '#1f6feb' : '#1a2332');
        }
        btnTopdown.on('pointerdown', function () {
          selectedMode = 'topdown';
          hostRef._survivorMode = selectedMode;
          refreshModeButtons();
          persistMode();
        });
        btnPlatformer.on('pointerdown', function () {
          selectedMode = 'platformer';
          hostRef._survivorMode = selectedMode;
          refreshModeButtons();
          persistMode();
        });

        /** Persist the selected mode alongside the current best (non-blocking). */
        function persistMode() {
          if (!hostRef || typeof hostRef.saveState !== 'function') { return; }
          try {
            // Read existing best from bestScore; encode as kills/timeSec for compat.
            var kills = 0, timeSec = 0;
            if (bestScore !== null) { kills = bestScore; } // approximate; full best is kills+timeSec
            // Preserve inputBindings/spriteScale so demo settings are not clobbered.
            hostRef.loadState().then(function (prev) {
              var ib = (prev && prev.inputBindings) ? prev.inputBindings : activeBindings;
              var sc = (prev && typeof prev.spriteScale === 'number') ? prev.spriteScale : spriteScale;
              hostRef.saveState({ best: { kills: kills, timeSec: timeSec }, mode: selectedMode, inputBindings: ib, spriteScale: sc })
                .then(function () {}, function () {});
            }, function () {
              hostRef.saveState({ best: { kills: kills, timeSec: timeSec }, mode: selectedMode, inputBindings: activeBindings, spriteScale: spriteScale })
                .then(function () {}, function () {});
            });
          } catch (e) { /* ignore */ }
        }

        // Demo modules — every future game should expose these two entries.
        var demoInputBtn = this.add.text(w / 2, h * 0.82, 'Input Mapping  [I]', {
          fontFamily: 'monospace', fontSize: '11px', color: '#8ab4f8',
          backgroundColor: '#1a2332', padding: { x: 10, y: 5 }
        }).setOrigin(0.5, 0.5).setInteractive({ useHandCursor: true });
        var demoSpriteBtn = this.add.text(w / 2, h * 0.89, 'Sprite Settings  [O]', {
          fontFamily: 'monospace', fontSize: '11px', color: '#8ab4f8',
          backgroundColor: '#1a2332', padding: { x: 10, y: 5 }
        }).setOrigin(0.5, 0.5).setInteractive({ useHandCursor: true });
        demoInputBtn.on('pointerdown', function () { showInputOverlay(self, 'menu'); });
        demoSpriteBtn.on('pointerdown', function () { showSpriteOverlay(self, 'menu'); });
        this._menuDemoKeys = this.input.keyboard.addKeys('I,O');

        // Start button — large, centered below mode selector.
        var startBtn = this.add.text(w / 2, h * 0.56, 'START  ▶', {
          fontFamily: 'monospace', fontSize: '18px', color: '#ffffff',
          backgroundColor: '#238636', padding: { x: 22, y: 10 }
        });
        startBtn.setOrigin(0.5, 0.5);
        startBtn.setInteractive({ useHandCursor: true });
        function doStart() {
          var key = selectedMode === 'platformer' ? 'platformer-scene' : 'topdown-scene';
          self.scene.start(key);
        }
        startBtn.on('pointerdown', doStart);

        // How to Play — contextual by mode.
        var howTopdown = 'WASD / Arrows to move · Auto turret shoots nearest foe\n3 HP · R restart · ESC pause · I input · O sprite';
        var howPlatformer = 'A/D or Arrows to move · W/UP/SPACE to jump · S/DOWN fastfall\nRight-click to move-to-x · R restart · ESC pause · I input · O sprite';
        var howText = this.add.text(w / 2, h * 0.72, selectedMode === 'platformer' ? howPlatformer : howTopdown, {
          fontFamily: 'monospace', fontSize: '11px', color: '#8b949e', align: 'center'
        });
        howText.setOrigin(0.5, 0.5);
        // Update how-to when mode changes — poll button state.
        this._howPoll = this.time.addEvent({
          delay: 200, loop: true, callback: function () {
            var txt = selectedMode === 'platformer' ? howPlatformer : howTopdown;
            if (howText.text !== txt) { howText.setText(txt); }
          }
        });

        // Keyboard: ENTER/SPACE starts, keep mode selection via input too.
        this._startKeys = this.input.keyboard.addKeys('ENTER,SPACE');
        // Store refs so update() can poll without re-querying.
        this._doStart = doStart;

        // Hint line
        this.add.text(w / 2, h - 16, 'ENTER/SPACE to start  ·  I input  ·  O sprite  ·  ESC/M to leave overlay', {
          fontFamily: 'monospace', fontSize: '10px', color: '#484f58', align: 'center'
        }).setOrigin(0.5, 0.5);
      }
      update() {
        // Keyboard start from menu.
        if (this._startKeys) {
          if (Phaser.Input.Keyboard.JustDown(this._startKeys.ENTER) ||
              Phaser.Input.Keyboard.JustDown(this._startKeys.SPACE)) {
            if (this._doStart) { this._doStart(); }
          }
        }
        // Menu-level demo overlays: I = Input mapping, O = Sprite settings.
        if (this._menuDemoKeys) {
          if (Phaser.Input.Keyboard.JustDown(this._menuDemoKeys.I)) {
            if (this._spriteOverlay) hideSpriteOverlay(this, 'menu');
            if (this._inputOverlay) hideInputOverlay(this, 'menu'); else showInputOverlay(this, 'menu');
          }
          if (Phaser.Input.Keyboard.JustDown(this._menuDemoKeys.O)) {
            if (this._inputOverlay) hideInputOverlay(this, 'menu');
            if (this._spriteOverlay) hideSpriteOverlay(this, 'menu'); else showSpriteOverlay(this, 'menu');
          }
        }
      }
      shutdown() {
        if (this._bestPoll) { try { this._bestPoll.remove(false); } catch (e) {} this._bestPoll = null; }
        if (this._howPoll) { try { this._howPoll.remove(false); } catch (e) {} this._howPoll = null; }
        if (this._inputOverlay) { try { hideInputOverlay(this, 'menu'); } catch (e2) {} }
        if (this._spriteOverlay) { try { hideSpriteOverlay(this, 'menu'); } catch (e3) {} }
      }
    };

    // ----------------------------------------------------------------------
    // TopdownScene — Vampire Survivors style (ported from v0.1.0 SurvivorScene)
    // ----------------------------------------------------------------------
    var TopdownScene = class extends Phaser.Scene {
      constructor() { super({ key: 'topdown-scene' }); }

      create() {
        // Re-point the CDP seam at the active gameplay scene.
        sceneRef = this;
        selectedMode = 'topdown';
        if (hostRef) { hostRef._survivorMode = selectedMode; }
        // Ensure no leftover gravity from platformer.
        try { this.physics.world.gravity.y = 0; } catch (e) {}

        this.w = this.cameras.main.width;
        this.h = this.cameras.main.height;

        // Run state (exposed via getState()).
        this.hp = SHARED_START_HP;
        this.kills = 0;
        this.timeMs = 0;
        this.over = false;
        this.invincibleUntil = 0;
        this.saved = false;
        this.hudStr = '';
        this._paused = false;

        buildTextures(this);
        // Attempt assistant texture prefetch (idempotent).
        try { loadAssistantTextures(this); } catch (e) {}
        // If assistant data not yet loaded, fetch it lazily.
        if (!assistantConfig && hostRef && typeof hostRef.getAssistantConfig === 'function') {
          var selfLate = this;
          fetchAssistantData().then(function () { try { loadAssistantTextures(selfLate); } catch (e) {} });
        }

        // Player — start centered. Texture resolved via assistant alias chain.
        var pTex = resolvePlayerTexture('idle', this);
        this.player = this.physics.add.sprite(this.w / 2, this.h / 2, pTex);
        this.player.setDepth(10);
        try { this.player.body.setCircle(10); } catch (e) { /* fallback */ this.player.body.setSize(20, 20); }
        try { applySpriteScaleTo(this.player); } catch (e) {}
        this._playerTex = pTex;

        // Groups
        this.enemies = this.physics.add.group();
        this.bullets = this.physics.add.group();

        // Collisions — arg-order agnostic (see header trap #1).
        this.physics.add.overlap(this.bullets, this.enemies, this.onBulletHit, null, this);
        this.physics.add.overlap(this.enemies, this.player, this.onPlayerHit, null, this);

        // Input — movement + restart + pause.
        this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SHIFT,CTRL,I,O');
        this.restartKey = this.input.keyboard.addKeys('R')[Object.keys(this.input.keyboard.addKeys('R'))[0]] || this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
        // Prefer mappings; fall back to legacy keys for pause/menu/restart when not mapped.
        this.menuKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M);
        this.pauseKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
        // Keep direct refs for demo overlays.
        this._demoKeys = { i: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.I), o: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.O) };
        // Cache last movement intent for alias + assistant texture selection.
        this._lastDx = 0;
        this._lastDy = 0;

        // Spawn + fire loops (both no-op while over or paused).
        this.time.addEvent({
          delay: SHARED_SPAWN_INTERVAL, loop: true,
          callback: this.spawnEnemy, callbackScope: this
        });
        this.time.addEvent({
          delay: SHARED_FIRE_INTERVAL, loop: true,
          callback: this.fireAtNearest, callbackScope: this
        });

        // HUD (top-left) and game-over overlay.
        this.hud = this.add.text(10, 8, '', {
          fontFamily: 'monospace', fontSize: '14px', color: '#e8e8e8'
        });
        this.hud.setDepth(50);

        this.dim = this.add.sprite(0, 0, 'panel');
        this.dim.setOrigin(0, 0);
        this.dim.setDisplaySize(this.w, this.h);
        this.dim.setTint(0x0b0e14);
        this.dim.setAlpha(0.62);
        this.dim.setVisible(false);
        this.dim.setDepth(60);

        this.overText = this.add.text(this.w / 2, this.h / 2, '', {
          fontFamily: 'monospace', fontSize: '22px', color: '#ff8a80', align: 'center'
        });
        this.overText.setOrigin(0.5, 0.5);
        this.overText.setVisible(false);
        this.overText.setDepth(61);

        // Load persisted best score (async) — may already be in bestScore global.
        // Keep per-scene bestScore for HUD fallback until global catches up.
        this.bestScore = bestScore;
        if (this.bestScore === null && hostRef && typeof hostRef.loadState === 'function') {
          var sceneLoad = this;
          try {
            hostRef.loadState().then(function (data) {
              if (data && data.best && typeof data.best.kills === 'number' && typeof data.best.timeSec === 'number') {
                var s = sceneLoad.bestScore;
                // Only adopt if this scene still cares (not yet overwritten).
                if (sceneLoad.bestScore === null) {
                  sceneLoad.bestScore = data.best.kills + Math.floor(data.best.timeSec);
                  bestScore = sceneLoad.bestScore;
                  sceneLoad.hudStr = '';
                  sceneLoad.updateHud();
                }
              }
              try { loadInputBindingsFromState(data); } catch (e) {}
            }, function () {});
          } catch (e) {}
        }

        this.updateHud();
      }

      // ---- Spawning (topdown: from screen edges) -------------------------
      spawnEnemy() {
        if (this.over || this._paused || this.enemies.getChildren().length >= SHARED_MAX_ENEMIES) { return; }
        var side = randInt(0, 3);
        var x, y;
        if (side === 0) { x = randInt(-TOPDOWN_SPAWN_MARGIN, this.w + TOPDOWN_SPAWN_MARGIN); y = -TOPDOWN_SPAWN_MARGIN; }
        else if (side === 1) { x = this.w + TOPDOWN_SPAWN_MARGIN; y = randInt(-TOPDOWN_SPAWN_MARGIN, this.h + TOPDOWN_SPAWN_MARGIN); }
        else if (side === 2) { x = randInt(-TOPDOWN_SPAWN_MARGIN, this.w + TOPDOWN_SPAWN_MARGIN); y = this.h + TOPDOWN_SPAWN_MARGIN; }
        else { x = -TOPDOWN_SPAWN_MARGIN; y = randInt(-TOPDOWN_SPAWN_MARGIN, this.h + TOPDOWN_SPAWN_MARGIN); }
        var strong = Math.random() < 0.35;
        var tex = resolveEnemyTexture(strong, this);
        var enemy = this.physics.add.sprite(x, y, tex);
        enemy.hp = strong ? 2 : 1;
        enemy._strong = strong;
        // Body shape: circles for generated textures, boxes for assistant sprites (unknown shape).
        if (tex === 'enemy1' || tex === 'enemy2') {
          enemy.body.setCircle(strong ? 11 : 9);
        } else {
          enemy.body.setSize(22, 22);
        }
        this.enemies.add(enemy);
      }

      // ---- Auto-turret (nearest enemy) -----------------------------------
      fireAtNearest() {
        if (this.over || this._paused) { return; }
        var enemies = this.enemies.getChildren();
        if (enemies.length === 0) { return; }
        var px = this.player.x, py = this.player.y;
        var target = null, bestD2 = Infinity;
        for (var i = 0; i < enemies.length; i++) {
          var en = enemies[i];
          var dx = en.x - px, dy = en.y - py;
          var d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; target = en; }
        }
        if (!target) { return; }
        var ang = Math.atan2(target.y - py, target.x - px);
        var bullet = this.physics.add.sprite(
          px + Math.cos(ang) * TOPDOWN_BULLET_OFFSET,
          py + Math.sin(ang) * TOPDOWN_BULLET_OFFSET,
          'bullet'
        );
        bullet.setDepth(5);
        bullet.setVelocity(Math.cos(ang) * TOPDOWN_BULLET_SPEED, Math.sin(ang) * TOPDOWN_BULLET_SPEED);
        bullet.setAngle(ang * 180 / Math.PI);
        this.bullets.add(bullet);
      }

      // ---- Collision callbacks (order-agnostic — see header trap #1) ------
      onBulletHit(a, b) {
        // Resolve roles via group membership, not argument position.
        var bullet = this.bullets.contains(a) ? a : b;
        var enemy = this.enemies.contains(a) ? a : b;
        bullet.destroy();
        if (enemy.hp > 1) {
          enemy.hp -= 1;
          // Downgrade texture from strong to weak on first hit.
          var newTex = resolveEnemyTexture(false, this);
          // Only switch to generated fallback if current was generated strong;
          // assistant textures may not have a weak variant — keep as-is if not found.
          if (enemy.texture.key === 'enemy2' || enemy.texture.key === resolveEnemyTexture(true, this)) {
            try { enemy.setTexture(newTex); } catch (e) {}
            try { enemy.body.setCircle(9); } catch (e) { enemy.body.setSize(20, 20); }
          }
        } else {
          enemy.destroy();
          this.kills += 1;
        }
      }

      onPlayerHit(a, b) {
        var enemy = (a === this.player) ? b : a;
        if (this.time.now < this.invincibleUntil) { return; }
        this.invincibleUntil = this.time.now + INVINCIBLE_MS;
        this.hp -= 1;
        try { enemy.destroy(); } catch (e) {}
        if (this.hp <= 0) {
          this.hp = 0;
          this.gameOver();
        }
      }

      // ---- Game over -----------------------------------------------------
      gameOver() {
        var i;
        this.over = true;
        this.player.setVelocity(0, 0);
        this.player.setAlpha(0.2);
        var enemies = this.enemies.getChildren();
        for (i = 0; i < enemies.length; i++) { enemies[i].setVelocity(0, 0); }
        var bullets = this.bullets.getChildren();
        for (i = 0; i < bullets.length; i++) { bullets[i].setVelocity(0, 0); }
        var secs = Math.floor(this.timeMs / 1000);
        var score = this.kills + secs;
        if (this.bestScore === null || score > this.bestScore) {
          this.bestScore = score;
          bestScore = score;
          if (!this.saved && hostRef && typeof hostRef.saveState === 'function') {
            this.saved = true;
            try {
              hostRef.saveState({ best: { kills: this.kills, timeSec: secs }, mode: selectedMode })
                .then(function () {}, function () {});
            } catch (e) {}
          }
        }
        this.dim.setVisible(true);
        this.overText.setText(
          'GAME OVER\n' +
          'Kills: ' + this.kills + '   Time: ' + secs + 's   Best: ' + this.bestScore +
          '\n\nPress R to restart  ·  M for menu'
        );
        this.overText.setVisible(true);
        this.updateHud();
      }

      // ---- HUD -----------------------------------------------------------
      updateHud() {
        var secs = Math.floor(this.timeMs / 1000);
        var best = this.bestScore === null ? '-' : String(this.bestScore);
        var modeTag = 'Topdown';
        var s = '[' + modeTag + ']  HP: ' + this.hp + '/' + SHARED_START_HP +
          '   Kills: ' + this.kills + '   Time: ' + secs + 's   Best: ' + best;
        if (s !== this.hudStr) { this.hudStr = s; this.hud.setText(s); }
      }

      // ---- Per-frame update ----------------------------------------------
      update(time, delta) {
        var i, en, b;
        // Game-over: only restart/menu input lives.
        if (this.over) {
          if (Phaser.Input.Keyboard.JustDown(this.restartKey)) { this.scene.restart(); return; }
          if (Phaser.Input.Keyboard.JustDown(this.menuKey)) {
            try { this.scene.stop('topdown-scene'); } catch (e) {}
            this.scene.start('menu');
            return;
          }
          return;
        }
        // Demo overlays: I = Input mapping, O = Sprite settings (even mid-game).
        if (this._demoKeys) {
          if (Phaser.Input.Keyboard.JustDown(this._demoKeys.i)) {
            if (this._spriteOverlay) hideSpriteOverlay(this, 'topdown-scene');
            if (this._inputOverlay) hideInputOverlay(this, 'topdown-scene'); else showInputOverlay(this, 'topdown-scene');
            return;
          }
          if (Phaser.Input.Keyboard.JustDown(this._demoKeys.o)) {
            if (this._inputOverlay) hideInputOverlay(this, 'topdown-scene');
            if (this._spriteOverlay) hideSpriteOverlay(this, 'topdown-scene'); else showSpriteOverlay(this, 'topdown-scene');
            return;
          }
        }
        if (this._inputOverlay || this._spriteOverlay) return;
        // Pause overlay active — only pause/menu keys matter.
        if (this._paused) {
          if (Phaser.Input.Keyboard.JustDown(this.pauseKey)) { this.togglePause(); }
          if (Phaser.Input.Keyboard.JustDown(this.menuKey)) {
            this.togglePause(); // resume first
            try { this.scene.stop('topdown-scene'); } catch (e) {}
            this.scene.start('menu');
          }
          return;
        }
        // ESC → pause
        if (Phaser.Input.Keyboard.JustDown(this.pauseKey)) { this.togglePause(); return; }
        // M → menu (without pause)
        if (Phaser.Input.Keyboard.JustDown(this.menuKey)) {
          try { this.scene.stop('topdown-scene'); } catch (e) {}
          this.scene.start('menu');
          return;
        }

        this.timeMs += delta;

        // 8-direction movement, diagonals normalized to TOPDOWN_SPEED.
        var dx = 0, dy = 0;
        // Honor remapped bindings; legacy WASD/arrows remain compatible via activeBindings defaults.
        var leftDown = pressed(this, 'left'), rightDown = pressed(this, 'right'), upDown = pressed(this, 'up'), downDown = pressed(this, 'down');
        if (leftDown) dx -= 1;
        if (rightDown) dx += 1;
        if (upDown) dy -= 1;
        if (downDown) dy += 1;
        // Normalize diagonals so cornering is not faster.
        var isRun = pressed(this, 'run') && !pressed(this, 'slow');
        var moving = dx !== 0 || dy !== 0;
        if (moving) {
          var len = Math.sqrt(dx * dx + dy * dy);
          this.player.setVelocity((dx / len) * TOPDOWN_SPEED, (dy / len) * TOPDOWN_SPEED);
          this.player.setAngle(Math.atan2(dy, dx) * 180 / Math.PI);
          this._lastDx = dx / len;
          this._lastDy = dy / len;
        } else {
          this.player.setVelocity(0, 0);
          // Keep last intent for facing while idle — don't reset to 0.
        }
        // Assistant sprite selection by motion event.
        var evt = moving
          ? motionEventTopdown(dx, dy, isRun)
          : 'idle';
        // Mouse aim: if pointer is over canvas, face cursor instead of movement (topdown parity).
        try {
          var ptr = this.input.activePointer;
          if (ptr && ptr.x >= 0 && ptr.x <= this.w && ptr.y >= 0 && ptr.y <= this.h &&
              (ptr.isDown || this.input.manager && this.input.manager.pointers && ptr.x !== 0)) {
            // Only override facing when mouse is actually over the stage and moved recently.
            // We check pointer position to decide left/right facing; up/down aim stays via move event.
            // To avoid jitter, only apply when pointer has meaningful position.
            // This mirrors assistant-demo.js aim.active → facing.
            // For topdown, prefer mouse X for horizontal facing when non-zero intent is small.
            // Keep the motion event as-is but override angle for visual feedback when aim is active
            // and the player is idle — otherwise movement angle wins.
            if (!moving && ptr.x !== 0) {
              // When idle, let mouse X influence the displayed angle slightly
              // (left vs right half).
              var aimLeft = ptr.x < this.player.x;
              // Don't change velocity, just angle for sprite facing.
              this.player.setAngle(aimLeft ? 180 : 0);
            }
          }
        } catch (e2) {}
        var desiredTex = resolvePlayerTexture(evt, this);
        if (desiredTex !== this._playerTex) {
          // Only switch if the texture actually exists (assistant image may still be loading).
          var canSwitch = false;
          try { canSwitch = this.textures.exists(desiredTex); } catch (e3) { canSwitch = false; }
          if (canSwitch) {
            try { this.player.setTexture(desiredTex); this._playerTex = desiredTex; applySpriteScaleTo(this.player); } catch (e4) {}
          }
        }

        // Enemies chase the player (2D).
        var enemies = this.enemies.getChildren();
        for (i = 0; i < enemies.length; i++) {
          en = enemies[i];
          var ex = this.player.x - en.x;
          var ey = this.player.y - en.y;
          var d = Math.sqrt(ex * ex + ey * ey);
          if (d < 1) { d = 1; }
          en.setVelocity((ex / d) * TOPDOWN_ENEMY_SPEED, (ey / d) * TOPDOWN_ENEMY_SPEED);
        }

        // Cull bullets that flew off-field.
        var bullets = this.bullets.getChildren();
        for (i = 0; i < bullets.length; i++) {
          b = bullets[i];
          if (b.x < -TOPDOWN_BULLET_CULL || b.x > this.w + TOPDOWN_BULLET_CULL ||
              b.y < -TOPDOWN_BULLET_CULL || b.y > this.h + TOPDOWN_BULLET_CULL) {
            b.destroy();
          }
        }

        // Invincibility flicker.
        if (this.time.now < this.invincibleUntil) {
          this.player.setAlpha(this.time.now % 90 < 45 ? 0.25 : 1);
        } else if (this.player.alpha !== 1) {
          this.player.setAlpha(1);
        }

        this.updateHud();
      }

      /**
       * Toggle the pause overlay for this scene.
       */
      togglePause() {
        if (this._paused) {
          hidePauseOverlay(this, 'topdown-scene');
          this._paused = false;
        } else {
          this._paused = true;
          showPauseOverlay(this, 'topdown-scene');
          // Freeze movement while paused.
          try { this.player.setVelocity(0, 0); } catch (e) {}
          var ens = this.enemies.getChildren();
          for (var k = 0; k < ens.length; k++) { try { ens[k].setVelocity(0, 0); } catch (e2) {} }
        }
      }
      shutdown() {
        if (this._inputOverlay) try { hideInputOverlay(this, 'topdown-scene'); } catch (e) {}
        if (this._spriteOverlay) try { hideSpriteOverlay(this, 'topdown-scene'); } catch (e) {}
      }
    };

    // ----------------------------------------------------------------------
    // PlatformerScene — gravity, platforms, jump, X-only moveTarget
    // ----------------------------------------------------------------------
    var PlatformerScene = class extends Phaser.Scene {
      constructor() { super({ key: 'platformer-scene' }); }

      create() {
        sceneRef = this;
        selectedMode = 'platformer';
        if (hostRef) { hostRef._survivorMode = selectedMode; }
        // Gravity ON for platformer (world gravity is global — must be set per scene).
        try { this.physics.world.gravity.y = PLATFORMER_GRAVITY; } catch (e) {}

        this.w = this.cameras.main.width;
        this.h = this.cameras.main.height;

        this.hp = SHARED_START_HP;
        this.kills = 0;
        this.timeMs = 0;
        this.over = false;
        this.invincibleUntil = 0;
        this.saved = false;
        this.hudStr = '';
        this._paused = false;
        this._moveTarget = null; // {x:number} x-only target from right-click

        buildTextures(this);
        buildPlatformTexture(this);
        try { loadAssistantTextures(this); } catch (e) {}
        if (!assistantConfig && hostRef && typeof hostRef.getAssistantConfig === 'function') {
          var selfLate2 = this;
          fetchAssistantData().then(function () { try { loadAssistantTextures(selfLate2); } catch (e2) {} });
        }

        // Platforms — static group: ground + 3 floaters.
        this.platforms = this.physics.add.staticGroup();
        // Ground: full-width strip.
        var ground = this.platforms.create(this.w / 2, this.h - 8, 'platform');
        ground.setDisplaySize(this.w, 16);
        ground.refreshBody();
        // Floater A — left-mid.
        var pA = this.platforms.create(this.w * 0.25, this.h * 0.65, 'platform');
        pA.setDisplaySize(140, 14);
        pA.refreshBody();
        // Floater B — right-mid.
        var pB = this.platforms.create(this.w * 0.75, this.h * 0.45, 'platform');
        pB.setDisplaySize(140, 14);
        pB.refreshBody();
        // Floater C — center-top.
        var pC = this.platforms.create(this.w * 0.5, this.h * 0.25, 'platform');
        pC.setDisplaySize(160, 14);
        pC.refreshBody();

        // Player — box body for platformer, feet-anchored spawn near ground.
        var pTexPlat = resolvePlayerTexture('idle', this);
        this.player = this.physics.add.sprite(40, this.h - 48, pTexPlat);
        this.player.setDepth(10);
        this.player.setCollideWorldBounds(true);
        this.player.setBounce(0);
        try { this.player.body.setSize(18, 24); } catch (e) {}
        try { applySpriteScaleTo(this.player); } catch (e) {}
        this.physics.add.collider(this.player, this.platforms);
        this._playerTex = pTexPlat;

        // Enemy + bullet groups
        this.enemies = this.physics.add.group();
        this.bullets = this.physics.add.group();
        this.physics.add.overlap(this.bullets, this.enemies, this.onBulletHit, null, this);
        this.physics.add.overlap(this.enemies, this.player, this.onPlayerHit, null, this);
        // Enemies also collide with platforms so they can stand on them.
        this.physics.add.collider(this.enemies, this.platforms);

        // Input — horizontal, jump, fastfall, pause/menu/restart.
        this.keys = this.input.keyboard.addKeys('A,D,LEFT,RIGHT,SHIFT,CTRL,W,UP,SPACE,S,DOWN,I,O');
        this.restartKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
        this.menuKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M);
        this.pauseKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
        this._demoKeys = { i: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.I), o: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.O) };
        // Track last horizontal intent for alias.
        this._lastDir = 0;

        // Right-click → x-only moveTarget (mirrors assistant-demo scroller: y=null).
        var selfPlat = this;
        this.input.on('pointerdown', function (ptr) {
          if (ptr.rightButtonDown && ptr.rightButtonDown()) {
            // Ignore if over a platform click that started a drag — still set target.
            selfPlat._moveTarget = { x: Math.max(0, Math.min(selfPlat.w - selfPlat.player.displayWidth, ptr.x)) };
          } else if (ptr.leftButtonDown && ptr.leftButtonDown()) {
            // Left-click clears moveTarget (any manual action cancels it — parity with ademoSubstep).
            // Don't clear on left if it's a menu/overlay click — but harmless.
          }
        });

        // Spawn + fire loops
        this.time.addEvent({
          delay: SHARED_SPAWN_INTERVAL, loop: true,
          callback: this.spawnEnemy, callbackScope: this
        });
        this.time.addEvent({
          delay: SHARED_FIRE_INTERVAL, loop: true,
          callback: this.fireAtNearest, callbackScope: this
        });

        // HUD + overlays
        this.hud = this.add.text(10, 8, '', {
          fontFamily: 'monospace', fontSize: '14px', color: '#e8e8e8'
        });
        this.hud.setDepth(50);
        this.dim = this.add.sprite(0, 0, 'panel');
        this.dim.setOrigin(0, 0);
        this.dim.setDisplaySize(this.w, this.h);
        this.dim.setTint(0x0b0e14);
        this.dim.setAlpha(0.62);
        this.dim.setVisible(false);
        this.dim.setDepth(60);
        this.overText = this.add.text(this.w / 2, this.h / 2, '', {
          fontFamily: 'monospace', fontSize: '22px', color: '#ff8a80', align: 'center'
        });
        this.overText.setOrigin(0.5, 0.5);
        this.overText.setVisible(false);
        this.overText.setDepth(61);

        this.bestScore = bestScore;
        if (this.bestScore === null && hostRef && typeof hostRef.loadState === 'function') {
          var sceneLoadP = this;
          try {
            hostRef.loadState().then(function (data) {
              if (data && data.best && typeof data.best.kills === 'number' && typeof data.best.timeSec === 'number') {
                if (sceneLoadP.bestScore === null) {
                  sceneLoadP.bestScore = data.best.kills + Math.floor(data.best.timeSec);
                  bestScore = sceneLoadP.bestScore;
                  sceneLoadP.hudStr = '';
                  sceneLoadP.updateHud();
                }
              }
            }, function () {});
          } catch (e) {}
        }
        this.updateHud();
      }

      // ---- Spawning (platformer: from above, falls onto platforms) -------
      spawnEnemy() {
        if (this.over || this._paused || this.enemies.getChildren().length >= SHARED_MAX_ENEMIES) { return; }
        // Spawn above the stage at a random X, let gravity drop them.
        var x = randInt(24, this.w - 24);
        var y = -24;
        var strong = Math.random() < 0.35;
        var tex = resolveEnemyTexture(strong, this);
        var enemy = this.physics.add.sprite(x, y, tex);
        enemy.hp = strong ? 2 : 1;
        enemy._strong = strong;
        enemy.setDepth(5);
        if (tex === 'enemy1' || tex === 'enemy2') {
          try { enemy.body.setCircle(strong ? 11 : 9); } catch (e) { enemy.body.setSize(20, 20); }
        } else {
          enemy.body.setSize(22, 22);
        }
        // Give a tiny downward nudge so gravity takes over immediately.
        enemy.setVelocityY(40);
        this.enemies.add(enemy);
      }

      // ---- Auto-turret (platformer: nearest in 2D, bullet has gravity) ---
      fireAtNearest() {
        if (this.over || this._paused) { return; }
        var enemies = this.enemies.getChildren();
        if (enemies.length === 0) { return; }
        var px = this.player.x, py = this.player.y;
        var target = null, bestD2 = Infinity;
        for (var i = 0; i < enemies.length; i++) {
          var en = enemies[i];
          var dx = en.x - px, dy = en.y - py;
          var d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; target = en; }
        }
        if (!target) { return; }
        var ang = Math.atan2(target.y - py, target.x - px);
        var bullet = this.physics.add.sprite(
          px + Math.cos(ang) * TOPDOWN_BULLET_OFFSET,
          py + Math.sin(ang) * TOPDOWN_BULLET_OFFSET,
          'bullet'
        );
        bullet.setDepth(5);
        // Bullets in platformer still fly straight (no gravity) for demo simplicity.
        bullet.setVelocity(Math.cos(ang) * TOPDOWN_BULLET_SPEED, Math.sin(ang) * TOPDOWN_BULLET_SPEED);
        bullet.setAngle(ang * 180 / Math.PI);
        this.bullets.add(bullet);
      }

      // ---- Collision callbacks (order-agnostic) ----------------------------
      onBulletHit(a, b) {
        var bullet = this.bullets.contains(a) ? a : b;
        var enemy = this.enemies.contains(a) ? a : b;
        bullet.destroy();
        if (enemy.hp > 1) {
          enemy.hp -= 1;
          if (enemy.texture.key === 'enemy2' || enemy.texture.key === resolveEnemyTexture(true, this)) {
            try { enemy.setTexture(resolveEnemyTexture(false, this)); } catch (e) {}
            try { enemy.body.setCircle(9); } catch (e2) { enemy.body.setSize(20, 20); }
          }
        } else {
          enemy.destroy();
          this.kills += 1;
        }
      }

      onPlayerHit(a, b) {
        var enemy = (a === this.player) ? b : a;
        if (this.time.now < this.invincibleUntil) { return; }
        this.invincibleUntil = this.time.now + INVINCIBLE_MS;
        this.hp -= 1;
        try { enemy.destroy(); } catch (e2) {}
        if (this.hp <= 0) {
          this.hp = 0;
          this.gameOver();
        }
      }

      gameOver() {
        var i;
        this.over = true;
        this.player.setVelocity(0, 0);
        this.player.setAlpha(0.2);
        var enemies = this.enemies.getChildren();
        for (i = 0; i < enemies.length; i++) { try { enemies[i].setVelocity(0, 0); } catch (e2) {} }
        var bullets = this.bullets.getChildren();
        for (i = 0; i < bullets.length; i++) { try { bullets[i].setVelocity(0, 0); } catch (e3) {} }
        var secs = Math.floor(this.timeMs / 1000);
        var score = this.kills + secs;
        if (this.bestScore === null || score > this.bestScore) {
          this.bestScore = score;
          bestScore = score;
          if (!this.saved && hostRef && typeof hostRef.saveState === 'function') {
            this.saved = true;
            try {
              hostRef.saveState({ best: { kills: this.kills, timeSec: secs }, mode: selectedMode })
                .then(function () {}, function () {});
            } catch (e4) {}
          }
        }
        this.dim.setVisible(true);
        this.overText.setText(
          'GAME OVER\n' +
          'Kills: ' + this.kills + '   Time: ' + secs + 's   Best: ' + this.bestScore +
          '\n\nPress R to restart  ·  M for menu'
        );
        this.overText.setVisible(true);
        this.updateHud();
      }

      updateHud() {
        var secs = Math.floor(this.timeMs / 1000);
        var best = this.bestScore === null ? '-' : String(this.bestScore);
        var modeTag = 'Platformer';
        var s = '[' + modeTag + ']  HP: ' + this.hp + '/' + SHARED_START_HP +
          '   Kills: ' + this.kills + '   Time: ' + secs + 's   Best: ' + best;
        if (s !== this.hudStr) { this.hudStr = s; this.hud.setText(s); }
      }

      update(time, delta) {
        var i, en, b;
        if (this.over) {
          if (Phaser.Input.Keyboard.JustDown(this.restartKey)) { this.scene.restart(); return; }
          if (Phaser.Input.Keyboard.JustDown(this.menuKey)) {
            try { this.scene.stop('platformer-scene'); } catch (e) {}
            this.scene.start('menu');
            return;
          }
          return;
        }
        if (this._demoKeys) {
          if (Phaser.Input.Keyboard.JustDown(this._demoKeys.i)) {
            if (this._spriteOverlay) hideSpriteOverlay(this, 'platformer-scene');
            if (this._inputOverlay) hideInputOverlay(this, 'platformer-scene'); else showInputOverlay(this, 'platformer-scene');
            return;
          }
          if (Phaser.Input.Keyboard.JustDown(this._demoKeys.o)) {
            if (this._inputOverlay) hideInputOverlay(this, 'platformer-scene');
            if (this._spriteOverlay) hideSpriteOverlay(this, 'platformer-scene'); else showSpriteOverlay(this, 'platformer-scene');
            return;
          }
        }
        if (this._inputOverlay || this._spriteOverlay) return;
        if (this._paused) {
          if (Phaser.Input.Keyboard.JustDown(this.pauseKey)) { this.togglePause(); }
          if (Phaser.Input.Keyboard.JustDown(this.menuKey)) {
            this.togglePause();
            try { this.scene.stop('platformer-scene'); } catch (e2) {}
            this.scene.start('menu');
          }
          return;
        }
        if (Phaser.Input.Keyboard.JustDown(this.pauseKey)) { this.togglePause(); return; }
        if (Phaser.Input.Keyboard.JustDown(this.menuKey)) {
          try { this.scene.stop('platformer-scene'); } catch (e3) {}
          this.scene.start('menu');
          return;
        }

        this.timeMs += delta;

        // ---- Horizontal intent — manual keys beat right-click moveTarget ----
        var dir = 0;
        if (pressed(this, 'left')) dir -= 1;
        if (pressed(this, 'right')) dir += 1;
        // Any manual horizontal input cancels the right-click target (parity with ademoSubstep).
        if (dir !== 0) {
          this._moveTarget = null;
        } else if (this._moveTarget) {
          var dxT = this._moveTarget.x - this.player.x;
          if (Math.abs(dxT) <= Math.max(2, PLATFORMER_WALK * (delta / 1000))) {
            // Snap to target and clear.
            try { this.player.body.reset(this._moveTarget.x, this.player.y); } catch (e4) {
              this.player.x = this._moveTarget.x;
            }
            this._moveTarget = null;
            dir = 0;
          } else {
            dir = dxT > 0 ? 1 : -1;
          }
        }
        var speed = pressed(this, 'slow') ? PLATFORMER_SLOW
          : (pressed(this, 'run') ? PLATFORMER_RUN : PLATFORMER_WALK);
        // Shift wins over Ctrl already via ternary above (SHIFT checked first).
        this.player.setVelocityX(dir * speed);
        if (dir !== 0) { this._lastDir = dir; }

        // ---- Vertical — gravity + jump + fastfall (physics handles gravity) --
        var onGround = false;
        try { onGround = this.player.body.blocked.down || this.player.body.touching.down; } catch (e5) {}
        // Jump: JustDown on W/UP/SPACE while grounded.
        var jumpDown = false;
        try {
          jumpDown = justPressed(this, 'jump');
        } catch (e6) {}
        if (jumpDown && onGround) {
          this.player.setVelocityY(-PLATFORMER_JUMP_VEL);
          onGround = false;
        }
        // Fastfall: holding S/DOWN while airborne adds extra gravity.
        var isDownHeld = false;
        try { isDownHeld = pressed(this, 'down'); } catch (e7) {}
        if (isDownHeld && !onGround) {
          // Nudge velocity downward — additive so it stacks with world gravity.
          var vy = this.player.body.velocity.y;
          vy += PLATFORMER_FASTFALL * (delta / 1000);
          if (vy > PLATFORMER_TERMINAL) { vy = PLATFORMER_TERMINAL; }
          this.player.setVelocityY(vy);
        } else {
          // Clamp terminal even without fastfall.
          try {
            if (this.player.body.velocity.y > PLATFORMER_TERMINAL) {
              this.player.setVelocityY(PLATFORMER_TERMINAL);
            }
          } catch (e8) {}
        }

        // Assistant sprite selection — platformer motion event.
        var isRun = pressed(this, 'run') && !pressed(this, 'slow');
        var platEvt = motionEventPlatformer(dir, onGround, this.player.body.velocity.y, isRun);
        var desiredTexP = resolvePlayerTexture(platEvt, this);
        if (desiredTexP !== this._playerTex) {
          var canSwitchP = false;
          try { canSwitchP = this.textures.exists(desiredTexP); } catch (e9) { canSwitchP = false; }
          if (canSwitchP) {
            try { this.player.setTexture(desiredTexP); this._playerTex = desiredTexP; applySpriteScaleTo(this.player); } catch (e10) {}
          }
        }

        // Enemies — X-only chase (gravity makes them fall naturally).
        var enemies = this.enemies.getChildren();
        for (i = 0; i < enemies.length; i++) {
          en = enemies[i];
          var ex2 = this.player.x - en.x;
          var chaseDir = ex2 > 0 ? 1 : (ex2 < 0 ? -1 : 0);
          en.setVelocityX(chaseDir * PLATFORMER_WALK * 0.6);
          // Tiny random jitter so enemies don't stack perfectly.
          // No Y chase — physics handles falling.
        }

        // Cull bullets off-field.
        var bullets = this.bullets.getChildren();
        for (i = 0; i < bullets.length; i++) {
          b = bullets[i];
          if (b.x < -TOPDOWN_BULLET_CULL || b.x > this.w + TOPDOWN_BULLET_CULL ||
              b.y < -TOPDOWN_BULLET_CULL || b.y > this.h + TOPDOWN_BULLET_CULL) {
            b.destroy();
          }
        }

        // Invincibility flicker.
        if (this.time.now < this.invincibleUntil) {
          this.player.setAlpha(this.time.now % 90 < 45 ? 0.25 : 1);
        } else if (this.player.alpha !== 1) {
          this.player.setAlpha(1);
        }

        this.updateHud();
      }

      togglePause() {
        if (this._paused) {
          hidePauseOverlay(this, 'platformer-scene');
          this._paused = false;
        } else {
          this._paused = true;
          showPauseOverlay(this, 'platformer-scene');
          try { this.player.setVelocity(0, 0); } catch (e) {}
          var ens = this.enemies.getChildren();
          for (var k = 0; k < ens.length; k++) { try { ens[k].setVelocity(0, 0); } catch (e2) {} }
        }
      }
      shutdown() {
        if (this._inputOverlay) try { hideInputOverlay(this, 'platformer-scene'); } catch (e) {}
        if (this._spriteOverlay) try { hideSpriteOverlay(this, 'platformer-scene'); } catch (e) {}
      }
    };

    // ----------------------------------------------------------------------
    // Phaser.Game — four scenes: boot → menu → (topdown | platformer)
    // ----------------------------------------------------------------------
    var config = {
      type: Phaser.AUTO,
      parent: host.container,
      width: host.width,
      height: host.height,
      backgroundColor: '#0d1117',
      physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
      scene: [BootScene, MenuScene, TopdownScene, PlatformerScene]
    };

    var game = new Phaser.Game(config);
    window.__trgame = { game: game, getState: getState, getMode: getMode, _assistant: function () { return assistantConfig; } };
    return game;
  }

  // Synchronous registration — the host always installs TRGames first.
  if (typeof window.TRGames !== 'undefined' &&
    typeof window.TRGames.register === 'function') {
    window.TRGames.register({
      id: 'survivor',
      title: 'Survivor',
      launch: launch
    });
  }
})();
