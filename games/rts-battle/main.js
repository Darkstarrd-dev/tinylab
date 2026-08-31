// =============================================================================
// games/rts-battle/main.js — RTS Battle 星际征伐 入口（磁盘插件，不进编译产物）
// =============================================================================
// 【资产替换清单】零外部资源，占位几何：
//   视觉：地形 Graphics 色块 + 单位/建筑 Rectangle+Text abbr + 迷雾瓦片
//     → this.load.image('tile_grass','assets/tile_grass.png')
//       this.load.spritesheet('unit','assets/unit.png',{frameWidth:28,frameHeight:28})
//     // TODO(视觉替换点): 在 MapManager/Unit/Building 的 Graphics 处替换
//   音频：RS.Sfx WebAudio oscillator → this.load.audio + this.sound.play
//     // TODO(音频替换点): 在 Sfx.play 分支替换
//   地图：src/config/map.js 的随机生成参数 → 外部 Tiled JSON
//     // TODO(地图替换点): this.load.tilemapTiledJSON('map','assets/map.json')
//   存档：host.saveState/loadState {best, settings}
//   测试缝：window.__trgame = { game, getState(), getFog(), getUnits() }
// =============================================================================
(function () {
  'use strict';
  var RS = window.RS = window.RS || {};
  RS.VERSION = '0.1.0';
  RS.hostRef = null;
  RS.sceneRef = null;
  RS._loadError = null;

  var SCRIPTS = [
    'src/config/constants.js',
    'src/config/units.js',
    'src/config/buildings.js',
    'src/config/map.js',
    'src/engine/GameState.js',
    'src/engine/RandomMap.js',
    'src/engine/FogOfWar.js',
    'src/utils/grid.js',
    'src/utils/pathfind.js',
    'src/utils/formation.js',
    'src/entities/Unit.js',
    'src/entities/Building.js',
    'src/entities/Resource.js',
    'src/entities/Projectile.js',
    'src/managers/MapManager.js',
    'src/managers/SelectionManager.js',
    'src/managers/EconomyManager.js',
    'src/managers/AIManager.js',
    'src/systems/MovementSystem.js',
    'src/systems/CombatSystem.js',
    'src/systems/GatheringSystem.js',
    'src/systems/FogSystem.js',
    'src/scenes/BootScene.js',
    'src/scenes/StartScene.js',
    'src/scenes/RtsScene.js'
  ];

  function loadScriptsSequential(list, done) {
    var idx = 0;
    function next() {
      if (idx >= list.length) { done(null); return; }
      var url = '/games/rts-battle/' + list[idx] + '?v=' + Date.now() + '_' + idx;
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { idx++; next(); };
      s.onerror = function () { done(new Error('script load failed: ' + url)); };
      document.head.appendChild(s);
    }
    next();
  }

  RS.boot = function (host) {
    RS.hostRef = host;
    var Phaser = host.phaser;
    if (!Phaser) throw new Error('Phaser not loaded');
    if (!RS.BootScene || !RS.RtsScene) throw new Error('rts-battle scripts not yet loaded — click Reload');
    var W = host.width || 960, H = host.height || 540;
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.container,
      width: W, height: H,
      backgroundColor: '#0e1628',
      physics: { default: 'arcade', arcade: { debug: false } },
      scene: [RS.BootScene, RS.StartScene, RS.RtsScene]
    });
    window.__trgame = {
      game: game,
      getState: function () { return RS.getState(); },
      getFog: function () { return RS.sceneRef && RS.sceneRef.fogOfWar ? RS.sceneRef.fogOfWar : null; },
      getUnits: function () { return RS.sceneRef ? RS.sceneRef.units : []; },
      get scene() { return RS.sceneRef; }
    };
    return game;
  };

  RS.getState = function () {
    var s = RS.sceneRef;
    if (!s) return { loaded:false };
    return {
      loaded:true,
      gold: s.economy ? s.economy.gold : 0,
      wood: s.economy ? s.economy.wood : 0,
      units: s.units ? s.units.length : 0,
      buildings: s.buildings ? s.buildings.length : 0,
      selected: s.selection ? s.selection.selected.length : 0,
      fogRevealed: s.fogOfWar ? s.fogOfWar.revealedCount : 0
    };
  };

  loadScriptsSequential(SCRIPTS, function (err) {
    if (err) { RS._loadError = err.message; console.warn('[RS] preload failed: ' + err.message); }
    try {
      window.TRGames.register({
        id: 'rts-battle',
        title: 'RTS Battle — 星际征伐',
        launch: function (host) {
          if (RS._loadError) throw new Error(RS._loadError);
          if (!RS.BootScene) throw new Error('rts-battle scripts not yet loaded — click Reload');
          return RS.boot(host);
        }
      });
    } catch (e) { console.error('[RS] register failed: ' + e.message); }
  });
})();
