// ============================================================================
// Survivor — a minimal "Vampire Survivors"-style demo game.
//
// Reference implementation of the TRGames plugin contract:
//   * Classic script (IIFE + 'use strict'); no modules, no imports.
//   * Registers synchronously at load time via window.TRGames.register.
//   * launch(host) creates the Phaser game and returns it; the host tears it
//     down through the returned game's .destroy() when needed.
//   * Uses only the documented host surface: container / width / height /
//     phaser / saveState / loadState — everything else is self-contained.
//   * Zero asset files: every texture is generated at runtime with Phaser
//     Graphics#generateTexture (nothing is fetched outside this game dir).
//   * Exposes window.__trgame = { game, getState } for CDP assertions.
//
// Gameplay: WASD / arrow-key 8-direction movement (diagonals normalized),
// enemies stream in from the screen edges and chase the player, an auto-turret
// shoots the nearest enemy every 0.6s. 3 HP, brief invincibility after each
// hit, HUD with HP / Kills / Time / Best, game over on zero HP (R restarts).
// The best score (kills + time in seconds) is persisted via host.saveState.
// ============================================================================
(function () {
  'use strict';

  // ---- Tunables ------------------------------------------------------------
  var PLAYER_SPEED = 220;      // px per second
  var ENEMY_SPEED = 92;        // px per second (chase)
  var BULLET_SPEED = 380;      // px per second (auto-turret)
  var SPAWN_INTERVAL = 1200;   // ms between enemy spawns
  var FIRE_INTERVAL = 600;     // ms between shots
  var START_HP = 3;
  var INVINCIBLE_MS = 800;     // invulnerable window after being hit
  var MAX_ENEMIES = 80;        // spawn ceiling, keeps the demo light
  var SPAWN_MARGIN = 36;       // how far outside the field enemies spawn
  var BULLET_OFFSET = 18;      // bullets spawn slightly ahead of the player
  var BULLET_CULL = 48;        // destroy misses this far outside the field

  // ---- Test seam -----------------------------------------------------------
  // Closed-over references read by window.__trgame.getState().
  var hostRef = null;
  var sceneRef = null;

  function getState() {
    var s = sceneRef;
    if (!s) {
      return { hp: START_HP, kills: 0, timeSec: 0, over: false };
    }
    return {
      hp: s.hp,
      kills: s.kills,
      timeSec: Math.round(s.timeMs / 1000),
      over: s.over
    };
  }

  // ---- Texture generation ---------------------------------------------------
  // Builds every visual out of Graphics primitives once per scene start.
  // Purely code-generated; nothing is fetched from the network or disk.
  function buildTextures(scene) {
    var g;

    // Player: light-blue disc with a short nose pointing right,
    // so setAngle() makes the facing direction readable.
    g = scene.add.graphics();
    g.fillStyle(0x4fc3f7, 1);
    g.fillCircle(14, 14, 11);
    g.fillTriangle(27, 14, 18, 8, 18, 20);
    g.generateTexture('player', 28, 28);
    g.destroy();

    // Bullet: amber disc with a bright core.
    g = scene.add.graphics();
    g.fillStyle(0xffd54f, 1);
    g.fillCircle(5, 5, 4);
    g.fillStyle(0xfff9c4, 1);
    g.fillCircle(5, 5, 2);
    g.generateTexture('bullet', 10, 10);
    g.destroy();

    // Enemy, 1 HP: red disc.
    g = scene.add.graphics();
    g.fillStyle(0xe57373, 1);
    g.fillCircle(13, 13, 11);
    g.generateTexture('enemy1', 26, 26);
    g.destroy();

    // Enemy, 2 HP: larger purple disc (visually heavier).
    g = scene.add.graphics();
    g.fillStyle(0xba68c8, 1);
    g.fillCircle(16, 16, 14);
    g.generateTexture('enemy2', 32, 32);
    g.destroy();

    // Solid 1x1 white pixel; tinted + stretched for the game-over dim.
    g = scene.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 1, 1);
    g.generateTexture('panel', 1, 1);
    g.destroy();
  }

  // Integer in [min, max] — local helper, no Phaser Math dependency needed.
  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  // ---- Entry point -----------------------------------------------------------
  // launch(host) is called by the TRGames host with the documented host
  // object. The scene class is defined here so its methods close over
  // host.phaser (the contract's Phaser reference, = window.Phaser).
  function launch(host) {
    var Phaser = host.phaser;

    hostRef = host;

    var SurvivorScene = class extends Phaser.Scene {

      constructor() {
        super({ key: 'survivor-scene' });
      }

      create() {
        // Re-point the test seam at the live scene (restart recreates it).
        sceneRef = this;

        this.w = this.cameras.main.width;
        this.h = this.cameras.main.height;

        // Run state (exposed through getState).
        this.hp = START_HP;
        this.kills = 0;
        this.timeMs = 0;
        this.over = false;
        this.invincibleUntil = 0;
        this.saved = false;
        this.bestScore = null; // null until the persisted best is known
        this.hudStr = '';

        buildTextures(this);

        // Player.
        this.player = this.physics.add.sprite(this.w / 2, this.h / 2, 'player');
        this.player.setDepth(10);
        this.player.body.setCircle(10);

        // Groups.
        this.enemies = this.physics.add.group();
        this.bullets = this.physics.add.group();

        // Collisions: bullets vs enemies, enemies vs player.
        this.physics.add.overlap(this.bullets, this.enemies, this.onBulletHit, null, this);
        this.physics.add.overlap(this.enemies, this.player, this.onPlayerHit, null, this);

        // Input: movement keys + the restart key (pressed during the game-over
        // freeze; JustDown polling is stable across Phaser versions).
        this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT');
        this.restartKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);

        // Spawn + fire loops (both no-op while the game is over).
        this.time.addEvent({
          delay: SPAWN_INTERVAL,
          loop: true,
          callback: this.spawnEnemy,
          callbackScope: this
        });
        this.time.addEvent({
          delay: FIRE_INTERVAL,
          loop: true,
          callback: this.fireAtNearest,
          callbackScope: this
        });

        // HUD (top-left) and game-over overlay.
        this.hud = this.add.text(10, 8, '', {
          fontFamily: 'monospace',
          fontSize: '14px',
          color: '#e8e8e8'
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
          fontFamily: 'monospace',
          fontSize: '22px',
          color: '#ff8a80',
          align: 'center'
        });
        this.overText.setOrigin(0.5, 0.5);
        this.overText.setVisible(false);
        this.overText.setDepth(61);

        // Load the persisted best score (async; the host owns the storage).
        // Applied to whichever scene is live when the promise resolves.
        if (hostRef && typeof hostRef.loadState === 'function') {
          try {
            hostRef.loadState().then(function (data) {
              if (data && data.best &&
                typeof data.best.kills === 'number' && typeof data.best.timeSec === 'number') {
                var s = sceneRef;
                s.bestScore = data.best.kills + Math.floor(data.best.timeSec);
                s.hudStr = ''; // force the HUD to redraw with the new best
                s.updateHud();
              }
            }, function () {
              /* storage failures are non-fatal */
            });
          } catch (e) {
            /* ignore */
          }
        }

        this.updateHud();
      }

      // ---- Spawning ---------------------------------------------------------
      spawnEnemy() {
        if (this.over || this.enemies.getChildren().length >= MAX_ENEMIES) {
          return;
        }
        var side = randInt(0, 3);
        var x, y;
        if (side === 0) {
          x = randInt(-SPAWN_MARGIN, this.w + SPAWN_MARGIN);
          y = -SPAWN_MARGIN;
        } else if (side === 1) {
          x = this.w + SPAWN_MARGIN;
          y = randInt(-SPAWN_MARGIN, this.h + SPAWN_MARGIN);
        } else if (side === 2) {
          x = randInt(-SPAWN_MARGIN, this.w + SPAWN_MARGIN);
          y = this.h + SPAWN_MARGIN;
        } else {
          x = -SPAWN_MARGIN;
          y = randInt(-SPAWN_MARGIN, this.h + SPAWN_MARGIN);
        }
        var strong = Math.random() < 0.35; // ~35% of enemies have 2 HP
        var enemy = this.physics.add.sprite(x, y, strong ? 'enemy2' : 'enemy1');
        enemy.hp = strong ? 2 : 1;
        enemy.body.setCircle(strong ? 11 : 9);
        this.enemies.add(enemy);
      }

      // ---- Auto-turret --------------------------------------------------------
      fireAtNearest() {
        if (this.over) {
          return;
        }
        var enemies = this.enemies.getChildren();
        if (enemies.length === 0) {
          return;
        }
        var px = this.player.x;
        var py = this.player.y;
        var target = null;
        var bestD2 = Infinity;
        for (var i = 0; i < enemies.length; i++) {
          var en = enemies[i];
          var dx = en.x - px;
          var dy = en.y - py;
          var d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            target = en;
          }
        }
        if (!target) {
          return;
        }
        var ang = Math.atan2(target.y - py, target.x - px);
        var bullet = this.physics.add.sprite(
          px + Math.cos(ang) * BULLET_OFFSET,
          py + Math.sin(ang) * BULLET_OFFSET,
          'bullet'
        );
        bullet.setDepth(5);
        bullet.setVelocity(Math.cos(ang) * BULLET_SPEED, Math.sin(ang) * BULLET_SPEED);
        bullet.setAngle(ang * 180 / Math.PI);
        this.bullets.add(bullet);
      }

      // ---- Collision callbacks ------------------------------------------------
      // Phaser v4's overlap callback does NOT guarantee the v3 (object1,
      // object2) argument order — overlap(group, obj) arrives as (obj,
      // groupChild) in v4.2.1. Resolve roles via group membership so the
      // callbacks are argument-order agnostic (verified by CDP smoke: a naive
      // (enemy) first-arg assumption destroyed the PLAYER on contact).
      onBulletHit(a, b) {
        var bullet = this.bullets.contains(a) ? a : b;
        var enemy = this.enemies.contains(a) ? a : b;
        bullet.destroy();
        if (enemy.hp > 1) {
          enemy.hp -= 1;
          enemy.setTexture('enemy1');
          enemy.body.setCircle(9);
        } else {
          enemy.destroy();
          this.kills += 1;
        }
      }

      onPlayerHit(a, b) {
        var enemy = (a === this.player) ? b : a;
        if (this.time.now < this.invincibleUntil) {
          return;
        }
        this.invincibleUntil = this.time.now + INVINCIBLE_MS;
        this.hp -= 1;
        enemy.destroy();
        if (this.hp <= 0) {
          this.hp = 0;
          this.gameOver();
        }
      }

      // ---- Game over ------------------------------------------------------------
      gameOver() {
        var i;

        this.over = true;
        this.player.setVelocity(0, 0);
        this.player.setAlpha(0.2);
        var enemies = this.enemies.getChildren();
        for (i = 0; i < enemies.length; i++) {
          enemies[i].setVelocity(0, 0);
        }
        var bullets = this.bullets.getChildren();
        for (i = 0; i < bullets.length; i++) {
          bullets[i].setVelocity(0, 0);
        }

        // Best = kills + survival seconds. Persist only when it beats the known
        // best (or nothing was stored yet); failures must not break the screen.
        var secs = Math.floor(this.timeMs / 1000);
        var score = this.kills + secs;
        if (this.bestScore === null || score > this.bestScore) {
          this.bestScore = score;
          if (!this.saved && hostRef && typeof hostRef.saveState === 'function') {
            this.saved = true;
            try {
              hostRef.saveState({ best: { kills: this.kills, timeSec: secs } })
                .then(function () {}, function () {});
            } catch (e) {
              /* ignore */
            }
          }
        }

        this.dim.setVisible(true);
        this.overText.setText(
          'GAME OVER\n' +
          'Kills: ' + this.kills + '   Time: ' + secs + 's   Best: ' + this.bestScore +
          '\n\nPress R to restart'
        );
        this.overText.setVisible(true);
        this.updateHud();
      }

      // ---- Per-frame update ----------------------------------------------------
      update(time, delta) {
        var i, en, b;

        // Frozen end state: the only live input is the restart key.
        if (this.over) {
          if (Phaser.Input.Keyboard.JustDown(this.restartKey)) {
            this.scene.restart();
          }
          return;
        }

        this.timeMs += delta;

        // 8-direction movement, diagonals normalized to full speed.
        var dx = 0, dy = 0;
        if (this.keys.A.isDown || this.keys.LEFT.isDown) dx -= 1;
        if (this.keys.D.isDown || this.keys.RIGHT.isDown) dx += 1;
        if (this.keys.W.isDown || this.keys.UP.isDown) dy -= 1;
        if (this.keys.S.isDown || this.keys.DOWN.isDown) dy += 1;
        if (dx !== 0 || dy !== 0) {
          var len = Math.sqrt(dx * dx + dy * dy);
          this.player.setVelocity((dx / len) * PLAYER_SPEED, (dy / len) * PLAYER_SPEED);
          this.player.setAngle(Math.atan2(dy, dx) * 180 / Math.PI);
        } else {
          this.player.setVelocity(0, 0);
        }

        // Enemies chase the player.
        var enemies = this.enemies.getChildren();
        for (i = 0; i < enemies.length; i++) {
          en = enemies[i];
          var ex = this.player.x - en.x;
          var ey = this.player.y - en.y;
          var d = Math.sqrt(ex * ex + ey * ey);
          if (d < 1) {
            d = 1;
          }
          en.setVelocity((ex / d) * ENEMY_SPEED, (ey / d) * ENEMY_SPEED);
        }

        // Cull bullets that flew off the field.
        var bullets = this.bullets.getChildren();
        for (i = 0; i < bullets.length; i++) {
          b = bullets[i];
          if (b.x < -BULLET_CULL || b.x > this.w + BULLET_CULL ||
            b.y < -BULLET_CULL || b.y > this.h + BULLET_CULL) {
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

      // ---- HUD -------------------------------------------------------------------
      updateHud() {
        var secs = Math.floor(this.timeMs / 1000);
        var best = this.bestScore === null ? '-' : String(this.bestScore);
        var s = 'HP: ' + this.hp + '/' + START_HP +
          '   Kills: ' + this.kills +
          '   Time: ' + secs + 's' +
          '   Best: ' + best;
        if (s !== this.hudStr) {
          this.hudStr = s;
          this.hud.setText(s);
        }
      }
    };

    var config = {
      type: Phaser.AUTO,
      parent: host.container,
      width: host.width,
      height: host.height,
      backgroundColor: '#0d1117',
      physics: { default: 'arcade' },
      scene: [SurvivorScene]
    };

    var game = new Phaser.Game(config);
    window.__trgame = { game: game, getState: getState };
    return game;
  }

  // Synchronous registration (the host always installs TRGames first).
  if (typeof window.TRGames !== 'undefined' &&
    typeof window.TRGames.register === 'function') {
    window.TRGames.register({
      id: 'survivor',
      title: 'Survivor',
      launch: launch
    });
  }
})();