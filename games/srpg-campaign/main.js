// =============================================================================
// games/srpg-campaign/main.js — SRPG Campaign 星痕战记 入口（磁盘插件）
// =============================================================================
// 【资产替换清单】零外部资源，占位几何：
//   视觉：
//     - 网格地形 Graphics 色块(TERRAIN) + 单位 Rectangle+Text abbr + HP条
//       → this.load.image('tile_plain','assets/tile_plain.png')
//         this.load.spritesheet('unit','assets/unit.png',{frameWidth:32,frameHeight:32})
//       // TODO(视觉替换点): 搜索本注释，在 MapManager/Unit 处替换
//     - 战斗演出 Graphics 斩击线/弹道 tween → 换粒子/序列帧
//   音频：
//     SC.Sfx WebAudio oscillator 首交互 resume → this.load.audio + this.sound.play
//       // TODO(音频替换点): 在 Sfx.play 分支替换
//   关卡/剧情：
//     src/config/chapters.js 内的 MAP 字符串 + units + AVG nodes
//       → 外部 JSON: this.load.json('ch1','assets/ch1.json')
//   存档：
//     host.saveState/loadState 持久化 {settings, slots:[{chapter,flags,roster}], autosave}
//   测试缝：window.__trgame = { game, getState(), getChapter(), getFlags() }
// =============================================================================
(function () {
  'use strict';
  var SC = window.SC = window.SC || {};
  SC.VERSION = '0.1.0';
  SC.hostRef = null;
  SC.sceneRef = null;
  SC.currentChapter = 1;
  SC.flags = {};
  SC.save = null;
  SC._loadError = null;

  var SCRIPTS = [
    'src/config/constants.js',
    'src/config/classes.js',
    'src/config/skills.js',
    'src/config/characters.js',
    'src/config/enemies.js',
    'src/config/chapters.js',
    'src/engine/GameState.js',
    'src/engine/SaveManager.js',
    'src/engine/ChapterManager.js',
    'src/utils/grid.js',
    'src/utils/pathfind.js',
    'src/utils/formula.js',
    'src/entities/Unit.js',
    'src/entities/Character.js',
    'src/entities/EnemyUnit.js',
    'src/managers/MapManager.js',
    'src/managers/TurnManager.js',
    'src/managers/BattleManager.js',
    'src/managers/ExpManager.js',
    'src/systems/RangeSystem.js',
    'src/systems/AISystem.js',
    'src/systems/SkillSystem.js',
    'src/scenes/BootScene.js',
    'src/scenes/StartScene.js',
    'src/scenes/SettingsScene.js',
    'src/scenes/SaveLoadScene.js',
    'src/scenes/AvgScene.js',
    'src/scenes/TacticsScene.js',
    'src/scenes/BattleScene.js',
    'src/scenes/ChapterEndScene.js'
  ];

  function loadScriptsSequential(list, done) {
    var idx = 0;
    function next() {
      if (idx >= list.length) { done(null); return; }
      var url = '/games/srpg-campaign/' + list[idx] + '?v=' + Date.now() + '_' + idx;
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { idx++; next(); };
      s.onerror = function () { done(new Error('script load failed: ' + url)); };
      document.head.appendChild(s);
    }
    next();
  }

  SC.boot = function (host) {
    SC.hostRef = host;
    var Phaser = host.phaser;
    if (!Phaser) throw new Error('Phaser not loaded');
    if (!SC.BootScene || !SC.TacticsScene) throw new Error('srpg-campaign scripts not yet loaded — click Reload');
    var W = host.width || 960, H = host.height || 540;
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.container,
      width: W, height: H,
      backgroundColor: '#0e1628',
      physics: { default: 'arcade', arcade: { debug: false } },
      scene: [SC.BootScene, SC.StartScene, SC.SettingsScene, SC.SaveLoadScene, SC.AvgScene, SC.TacticsScene, SC.BattleScene, SC.ChapterEndScene]
    });
    window.__trgame = {
      game: game,
      getState: function () { return SC.getState(); },
      getChapter: function () { return SC.currentChapter; },
      getFlags: function () { return SC.flags; },
      get scene() { return SC.sceneRef; }
    };
    return game;
  };

  SC.getState = function () {
    var s = SC.sceneRef;
    var base = { chapter: SC.currentChapter, flags: SC.flags, save: SC.save };
    if (!s) return base;
    base.scene = s.scene ? s.scene.key : (s.sys ? s.sys.settings.key : 'unknown');
    base.turn = s.turnMgr ? s.turnMgr.turn : 0;
    base.phase = s.turnMgr ? s.turnMgr.phase : '';
    return base;
  };

  loadScriptsSequential(SCRIPTS, function (err) {
    if (err) { SC._loadError = err.message; console.warn('[SC] preload failed: ' + err.message); }
    try {
      window.TRGames.register({
        id: 'srpg-campaign',
        title: 'SRPG Campaign — 星痕战记',
        launch: function (host) {
          if (SC._loadError) throw new Error(SC._loadError);
          if (!SC.BootScene) throw new Error('srpg-campaign scripts not yet loaded — click Reload');
          return SC.boot(host);
        }
      });
    } catch (e) { console.error('[SC] register failed: ' + e.message); }
  });
})();
