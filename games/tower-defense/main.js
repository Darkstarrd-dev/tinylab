// =============================================================================
// games/tower-defense/main.js — 塔防演示入口（磁盘插件，不进编译产物）
// =============================================================================
// 【资产替换清单】（零外部资源，全部占位几何，后续替换时逐项修改）：
//   视觉：
//     - 塔/敌人/子弹：Rectangle + Text 占位（Tower.js/Enemy.js/Projectile.js）+ 血条 Graphics
//       → 替换为 this.load.image/spritesheet：
//         this.load.image('tower_basic','assets/tower_basic.png')
//         this.load.spritesheet('enemy_grunt','assets/enemy_grunt.png',{frameWidth:28,frameHeight:28})
//       // TODO(视觉替换点): 搜索本注释，在对应 createGO/buildTextures 处替换
//     - 路径/网格：MapManager.drawPath + GameScene._drawGrid 的 Graphics 线条
//       → 替换为 Tiled JSON：this.load.tilemapTiledJSON('lv1','assets/lv1.json')
//     - 粒子/命中特效：预留 Sfx + Graphics 圆点 tween，可换 particle 贴图
//   音频：
//     TD.Sfx（BootScene 内 WebAudio oscillator+gain 自合成，首交互 resume 静默降级）
//       → 替换为 this.load.audio('shoot','assets/shoot.wav') + this.sound.play('shoot')
//       // TODO(音频替换点): 搜索本注释，在 Sfx.play 分支替换
//   关卡：
//     TD.LEVELS（src/config/levels.js 的 path+waves 数组）
//       → 替换为外部 JSON：this.load.json('levels','assets/levels.json')
//   存档：host.saveState/loadState 持久化 {best:{[levelId]:score}, unlocked:[], lastLevel}
//   测试缝：window.__trgame = { game:Phaser.Game, getState(), getLevel(), scene:GameScene }
// =============================================================================
(function () {
  'use strict';

  var TD = window.TD = window.TD || {};
  TD.VERSION = TD.VERSION || '0.1.0';
  TD.hostRef = null;
  TD.sceneRef = null;
  TD.currentLevel = 1;
  TD.save = { best:{}, unlocked:[1], lastLevel:1 };
  TD._loadError = null;
  TD._scriptsLoaded = false;
  TD._scriptsLoading = null;

  var SCRIPTS = [
    'src/config/constants.js',
    'src/config/towers.js',
    'src/config/enemies.js',
    'src/config/levels.js',
    'src/utils/math.js',
    'src/utils/grid.js',
    'src/entities/Entity.js',
    'src/entities/Enemy.js',
    'src/entities/Tower.js',
    'src/entities/Projectile.js',
    'src/managers/EconomyManager.js',
    'src/managers/WaveManager.js',
    'src/managers/MapManager.js',
    'src/systems/TargetingSystem.js',
    'src/scenes/BootScene.js',
    'src/scenes/StartScene.js',
    'src/scenes/LevelSelectScene.js',
    'src/scenes/Hud.js',
    'src/scenes/GameScene.js'
  ];

  function loadScriptsSequential(list) {
    var idx = 0;
    return new Promise(function (resolve, reject) {
      function next() {
        if (idx >= list.length) { TD._scriptsLoaded = true; resolve(); return; }
        var url = '/games/tower-defense/' + list[idx] + '?v=' + Date.now() + '_' + idx;
        var s = document.createElement('script');
        s.src = url;
        s.onload = function () { idx++; next(); };
        s.onerror = function () { reject(new Error('script load failed: ' + url)); };
        document.head.appendChild(s);
      }
      next();
    });
  }

  function ensureScripts() {
    if (TD._scriptsLoaded && TD.BootScene && TD.GameScene) return Promise.resolve();
    if (TD._scriptsLoading) return TD._scriptsLoading;
    TD._scriptsLoading = loadScriptsSequential(SCRIPTS).then(function () {
      TD._scriptsLoaded = true;
    }).catch(function (err) {
      TD._loadError = err.message;
      TD._scriptsLoading = null;
      throw err;
    });
    return TD._scriptsLoading;
  }

  TD.boot = function (host) {
    TD.hostRef = host;
    var Phaser = host.phaser;
    if (!Phaser) throw new Error('Phaser not loaded (host.phaser missing)');
    if (!TD.BootScene || !TD.GameScene) {
      throw new Error('tower-defense scripts not yet loaded');
    }
    var W = host.width || 960, H = host.height || 540;
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.container,
      width: W,
      height: H,
      backgroundColor: '#0e1628',
      physics: { default: 'arcade', arcade: { debug: false } },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: [TD.BootScene, TD.StartScene, TD.LevelSelectScene, TD.GameScene]
    });
    window.__trgame = {
      game: game,
      getState: function () { return TD.getState(); },
      getLevel: function () { return TD.currentLevel; },
      get scene() { return TD.sceneRef; }
    };
    return game;
  };

  TD.getState = function () {
    var sc = TD.sceneRef;
    if (!sc) return { level: TD.currentLevel, gold: 0, lives: 0, wave: 0, enemies: 0, towers: 0, paused: false, over: false, best: (TD.save && TD.save.best) || {} };
    return {
      level: sc.levelId || TD.currentLevel,
      gold: sc.economy ? sc.economy.gold : 0,
      lives: sc.economy ? sc.economy.lives : 0,
      wave: sc.waveMgr ? sc.waveMgr.waveIndex + 1 : 0,
      enemies: sc.enemiesAlive ? sc.enemiesAlive.length : 0,
      towers: sc.towers ? sc.towers.length : 0,
      paused: !!sc.paused,
      over: !!sc.over,
      victory: !!sc.victory,
      best: (TD.save && TD.save.best) || {}
    };
  };

  // 同步注册：满足宿主 dgLoadGame 的同步检查；脚本后台预加载，launch 内按需等待。
  try {
    window.TRGames.register({
      id: 'tower-defense',
      title: 'Tower Defense',
      launch: function (host) {
        if (TD._loadError) throw new Error(TD._loadError);
        // 若脚本已就绪，同步启动；否则返回 Promise，宿主会等待
        if (TD._scriptsLoaded && TD.BootScene && TD.GameScene) {
          return TD.boot(host);
        }
        return ensureScripts().then(function () {
          if (TD._loadError) throw new Error(TD._loadError);
          if (!TD.BootScene) throw new Error('tower-defense scripts not yet loaded');
          return TD.boot(host);
        });
      }
    });
  } catch (e) {
    console.error('[TD] register failed: ' + e.message);
  }

  // 后台预加载，首次 Launch 前尽量就绪（失败不抛，launch 时重试）
  ensureScripts().catch(function (err) {
    console.warn('[TD] preload failed: ' + err.message);
  });

})();
