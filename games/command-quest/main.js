// =============================================================================
// games/command-quest/main.js — 指挥官三态演示入口（磁盘插件，不进编译产物）
// =============================================================================
// 【资产替换清单】（零外部资源，全部占位几何）：
//   视觉：CQSkin（src/scenes/Skin.js）内 Graphics→generateTexture 批次
//     角色/士兵/建筑/宝箱/商店/NPC：cs_commander/cs_soldier/cs_chest/... 等
//     → 替换为 this.load.image('cs_commander','assets/commander.png')
//        this.load.spritesheet('cs_soldier','assets/soldier.png',{frameWidth:16,frameHeight:16})
//     // TODO(视觉替换点): 搜索本注释，在对应 createGO/buildTextures 处替换
//   地图：WorldScene + MapManager 的 Graphics 路径/网格占位
//     → 替换为 Tiled JSON：this.load.tilemapTiledJSON('world','assets/world.json')
//   粒子/命中：Graphics 圆点 tween，可换 particle 贴图
//   音频：CQ.Sfx（BootScene 内 WebAudio oscillator+gain 自合成，首交互 resume 静默降级）
//     → 替换为 this.load.audio('cq_attack','assets/attack.wav') + this.sound.play('cq_attack')
//     // TODO(音频替换点): 搜索本注释，在 Sfx.play 分支替换
//   数值：src/config/*.js 的指挥官/士兵/装备/技能/AVG 剧本 → 外部 JSON
//   存档：host.saveState/loadState 持久化 { chapter, avgFlags, roster, gold, mode, seed }
//   测试缝：window.__trgame = { game:Phaser.Game, getState(), getWorld():WorldScene, mode }
// =============================================================================
(function () {
  'use strict';

  var CQ = window.CQ = window.CQ || {};
  CQ.VERSION = CQ.VERSION || '0.1.0';
  CQ.hostRef = null;
  CQ.sceneRef = null;   // WorldScene | AvgScene
  CQ.save = CQ.save || { chapter: 0, avgFlags: {}, roster: null, gold: 0, mode: 'srpg', seed: 1337 };
  CQ._loadError = null;
  CQ._scriptsLoaded = false;
  CQ._scriptsLoading = null;

  var SCRIPTS = [
    'src/config/constants.js',
    'src/config/commanders.js',
    'src/config/soldiers.js',
    'src/config/equipment.js',
    'src/config/skills.js',
    'src/config/avgScripts.js',
    'src/utils/rng.js',
    'src/utils/grid.js',
    'src/utils/formula.js',
    'src/entities/Entity.js',
    'src/entities/Commander.js',
    'src/entities/Soldier.js',
    'src/entities/Chest.js',
    'src/entities/Shop.js',
    'src/entities/Npc.js',
    'src/systems/BattleCalc.js',
    'src/managers/MapManager.js',
    'src/managers/BattleManager.js',
    'src/scenes/Skin.js',
    'src/scenes/BootScene.js',
    'src/scenes/AvgScene.js',
    'src/scenes/WorldScene.js',
    'src/scenes/Hud.js'
  ];

  function loadScriptsSequential(list) {
    var idx = 0;
    return new Promise(function (resolve, reject) {
      function next() {
        if (idx >= list.length) { CQ._scriptsLoaded = true; resolve(); return; }
        var url = '/games/command-quest/' + list[idx] + '?v=' + Date.now() + '_' + idx;
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
    if (CQ._scriptsLoaded && CQ.BootScene && CQ.WorldScene) return Promise.resolve();
    if (CQ._scriptsLoading) return CQ._scriptsLoading;
    CQ._scriptsLoading = loadScriptsSequential(SCRIPTS).then(function () {
      CQ._scriptsLoaded = true;
    }).catch(function (err) {
      CQ._loadError = err.message;
      CQ._scriptsLoading = null;
      throw err;
    });
    return CQ._scriptsLoading;
  }

  CQ.boot = function (host) {
    CQ.hostRef = host;
    var Phaser = host.phaser;
    if (!Phaser) throw new Error('Phaser not loaded (host.phaser missing)');
    if (!CQ.BootScene || !CQ.WorldScene) throw new Error('command-quest scripts not yet loaded');
    var W = host.width || 960, H = host.height || 540;
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.container,
      width: W, height: H,
      backgroundColor: '#0e1424',
      physics: { default: 'arcade', arcade: { debug: false } },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: [CQ.BootScene, CQ.AvgScene, CQ.WorldScene]
    });
    window.__trgame = {
      game: game,
      getState: function () { return CQ.getState(); },
      getWorld: function () { return CQ.sceneRef; },
      get mode() { var s = CQ.sceneRef; return s && s.battleMode ? s.battleMode : (CQ.save && CQ.save.mode) || 'srpg'; }
    };
    return game;
  };

  CQ.getState = function () {
    var sc = CQ.sceneRef;
    if (!sc || sc.scene.key !== 'World') {
      return { mode: (CQ.save && CQ.save.mode) || 'srpg', turn: 0, phase: 'idle', gold: (CQ.save && CQ.save.gold) || 0, chapters: 0, flags: (CQ.save && CQ.save.avgFlags) || {} };
    }
    return {
      mode: sc.battleMode,
      turn: sc.turn || 0,
      phase: sc.phase || 'explore',
      gold: sc.gold || 0,
      chapters: sc.enemiesSpawned || 0,
      flags: (CQ.save && CQ.save.avgFlags) || {},
      playerAlive: sc.playerUnits ? sc.playerUnits.filter(function (u) { return u.alive; }).length : 0,
      enemyAlive: sc.enemyUnits ? sc.enemyUnits.filter(function (u) { return u.alive; }).length : 0
    };
  };

  try {
    window.TRGames.register({
      id: 'command-quest',
      title: 'Command Quest',
      launch: function (host) {
        if (CQ._loadError) throw new Error(CQ._loadError);
        if (CQ._scriptsLoaded && CQ.BootScene && CQ.WorldScene) return CQ.boot(host);
        return ensureScripts().then(function () {
          if (CQ._loadError) throw new Error(CQ._loadError);
          if (!CQ.BootScene) throw new Error('command-quest scripts not yet loaded');
          return CQ.boot(host);
        });
      }
    });
  } catch (e) { console.error('[CQ] register failed: ' + e.message); }

  ensureScripts().catch(function (err) { console.warn('[CQ] preload failed: ' + err.message); });
})();
