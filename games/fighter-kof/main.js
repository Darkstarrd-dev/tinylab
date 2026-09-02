// =============================================================================
// games/fighter-kof/main.js — Fighter KOF 成熟格斗框架入口（磁盘插件）
// =============================================================================
// 【资产替换清单】（零外部资源，全部占位几何，后续替换时逐项修改）：
//   视觉：
//     - 角色 ragdoll：FighterEntity.createRagdoll 的 Graphics box 拼接
//       → 替换为 this.load.spritesheet('kyo','assets/kyo.png',{frameWidth:64,frameHeight:96})
//       // TODO(视觉替换点): 搜索本注释，在 FighterEntity.createRagdoll 处替换
//     - 舞台：FightScene 的 pixel 拉伸 bgImg/ground tint 占位
//       → 替换为 this.load.image('bg_dojo','assets/bg_dojo.png')
//       // TODO(视觉替换点): 搜索本注释，在 FightScene.create 的舞台段替换
//     - Hitbox 调试：FightScene.drawHitDebug 的 Graphics 线框，无需纹理
//       开关：O 键 toggleHitDebug，保留 debug 层便于接 hitbox 编辑器
//     - 血条/能量条：1x1 pixel 拉伸，'pixel' 已生成
//   音频：
//     FKO.Sfx（BootScene 内 WebAudio oscillator+gain 自合成）
//       → 替换为 this.load.audio('punch','assets/punch.wav') + this.sound.play
//       // TODO(音频替换点): 搜索本注释，在 FKO.Sfx.play 分支替换
//   配置：FKO.CHARACTERS / FKO.MOVES / FKO.STAGES 数据驱动，改数值后热重载生效
//   存档：host.saveState/loadState 持久化 {wins,p1CharId,p2CharId,stageId}
//   测试缝：window.__trgame = { game, getState(), getScene(), getSave() }
// =============================================================================
(function () {
  'use strict';

  var FKO = window.FKO = window.FKO || {};
  FKO.VERSION = '0.1.0';
  FKO.hostRef = null;
  FKO.sceneRef = null;
  FKO.save = { wins: 0, p1CharId: 'kyo', p2CharId: 'iori', stageId: 0 };
  FKO._loadError = null;
  FKO._scriptsLoaded = false;
  FKO._scriptsLoading = null;

  var SCRIPTS = [
    'src/config/constants.js',
    'src/config/characters.js',
    'src/config/moves.js',
    'src/config/stages.js',
    'src/utils/math.js',
    'src/utils/hitbox.js',
    'src/utils/inputBuffer.js',
    'src/entities/FighterEntity.js',
    'src/systems/HitSystem.js',
    'src/systems/InputSystem.js',
    'src/systems/ComboSystem.js',
    'src/managers/RoundManager.js',
    'src/managers/StageManager.js',
    'src/scenes/BootScene.js',
    'src/scenes/CharacterSelectScene.js',
    'src/scenes/StageSelectScene.js',
    'src/scenes/Hud.js',
    'src/scenes/FightScene.js'
  ];

  function loadScriptsSequential(list) {
    var idx = 0;
    return new Promise(function (resolve, reject) {
      function next() {
        if (idx >= list.length) { FKO._scriptsLoaded = true; resolve(); return; }
        var url = '/games/fighter-kof/' + list[idx] + '?v=' + Date.now() + '_' + idx;
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
    if (FKO._scriptsLoaded && FKO.BootScene) return Promise.resolve();
    if (FKO._scriptsLoading) return FKO._scriptsLoading;
    FKO._scriptsLoading = loadScriptsSequential(SCRIPTS).then(function () {
      FKO._scriptsLoaded = true;
    }).catch(function (err) {
      FKO._loadError = err.message;
      FKO._scriptsLoading = null;
      throw err;
    });
    return FKO._scriptsLoading;
  }

  FKO.boot = function (host) {
    FKO.hostRef = host;
    var Phaser = host.phaser;
    if (!Phaser) throw new Error('Phaser not loaded (host.phaser missing)');
    if (!FKO.BootScene) throw new Error('fighter-kof scripts not yet loaded');
    var W = host.width || 960, H = host.height || 540;
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.container,
      width: W,
      height: H,
      backgroundColor: '#0f1117',
      physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: [FKO.BootScene, FKO.CharacterSelectScene, FKO.StageSelectScene, FKO.FightScene]
    });
    window.__trgame = {
      game: game,
      getState: function () { return FKO.getState(); },
      getScene: function () { return FKO.sceneRef; },
      getSave: function () { return FKO.save; }
    };
    return game;
  };

  FKO.getState = function () {
    var s = FKO.sceneRef;
    if (!s || s.scene.key !== 'Fight') return { scene: s ? s.scene.key : 'none', round: 0, p1hp: 100, p2hp: 100, stage: FKO.save.stageId, wins: FKO.save.wins };
    return {
      scene: 'Fight',
      round: s.roundMgr ? s.roundMgr.round : 1,
      p1hp: Math.round(s.fighter1 ? s.fighter1.hp : 0),
      p2hp: Math.round(s.fighter2 ? s.fighter2.hp : 0),
      stage: s.stageMgr ? s.stageMgr.stageId : 0,
      wins: FKO.save.wins,
      p1wins: s.roundMgr ? s.roundMgr.p1Wins : 0,
      p2wins: s.roundMgr ? s.roundMgr.p2Wins : 0
    };
  };

  // 同步注册：满足宿主 dgLoadGame 的同步检查；脚本后台预加载，launch 内按需等待。
  try {
    window.TRGames.register({
      id: 'fighter-kof',
      title: 'Fighter KOF',
      launch: function (host) {
        if (FKO._loadError) throw new Error(FKO._loadError);
        if (FKO._scriptsLoaded && FKO.BootScene) return FKO.boot(host);
        return ensureScripts().then(function () {
          if (FKO._loadError) throw new Error(FKO._loadError);
          if (!FKO.BootScene) throw new Error('fighter-kof scripts not yet loaded');
          return FKO.boot(host);
        });
      }
    });
  } catch (e) {
    console.error('[FKO] register failed: ' + e.message);
  }

  // 后台预加载，首次 Launch 前尽量就绪（失败不抛，launch 时重试）
  ensureScripts().catch(function (err) {
    console.warn('[FKO] preload failed: ' + err.message);
  });

})();
