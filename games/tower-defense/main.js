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

  function loadScriptsSequential(list, done) {
    var idx = 0;
    function next() {
      if (idx >= list.length) { done(null); return; }
      var url = '/games/tower-defense/' + list[idx] + '?v=' + Date.now() + '_' + idx;
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { idx++; next(); };
      s.onerror = function () { done(new Error('script load failed: ' + url)); };
      document.head.appendChild(s);
    }
    next();
  }

  TD.boot = function (host) {
    TD.hostRef = host;
    var Phaser = host.phaser;
    if (!Phaser) throw new Error('Phaser not loaded (host.phaser missing)');
    if (!TD.BootScene || !TD.GameScene) {
      throw new Error('tower-defense scripts not yet loaded — click Reload to retry');
    }
    var W = host.width || 960, H = host.height || 540;
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.container,
      width: W,
      height: H,
      backgroundColor: '#0e1628',
      physics: { default: 'arcade', arcade: { debug: false } },
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

  // 同步预加载子脚本后再注册（保证 dgLoadGame onload 后 registry 已就绪，首次 Launch 无需 Reload）
  // 失败则仍注册，launch 内抛错提示 Reload（与其它 games 一致的降级）
  loadScriptsSequential(SCRIPTS, function (err) {
    if (err) {
      TD._loadError = err.message;
      console.warn('[TD] preload failed: ' + err.message);
    }
    try {
      window.TRGames.register({
        id: 'tower-defense',
        title: 'Tower Defense',
        launch: function (host) {
          if (TD._loadError) throw new Error(TD._loadError);
          if (!TD.BootScene) throw new Error('tower-defense scripts not yet loaded — click Reload');
          return TD.boot(host);
        }
      });
    } catch (e) {
      // 重复注册等，宿主会捕获
      console.error('[TD] register failed: ' + e.message);
    }
  });

})();
