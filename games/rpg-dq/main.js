// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改（中文注释为替换点）：
//   视觉：
//     buildTextures() 内所有 this.add.graphics()+generateTexture('t_*'/'hero'/'npc'/'enemy_*'/'boss_*')
//       → 换成 this.load.image('t_grass','assets/grass.png') 等；
//       纹理名：t_grass/t_tree/t_wall/t_house/t_water/hero_down/npc_*
//       敌方正面大图：enemy_slime/enemy_bat/enemy_goblin/enemy_skeleton/enemy_orc/
//                    enemy_ghost/enemy_cavebat/boss_slimeking/boss_dragon
//       每块生成段落已用「将来换」中文注释标出；几何体仅为占位，可无缝替换为位图/sheet。
//     房屋/树/NPC 现用 graphics 矩形+圆形几何 → 换成 spritesheet 帧或 Tiled Object
//       this.load.spritesheet('hero','assets/hero.png',{frameWidth:32,frameHeight:32})
//   音频：
//     Sfx.play('move'/'encounter'/'attack'/'magic'/'victory'/'levelup'/'hurt'/'heal'/'bgm')
//       内部 WebAudio oscillator+gain → 换成 this.load.audio('attack','assets/attack.wav')+this.sound.play
//       文件顶部 Sfx 块注释已写替换写法；BGM 章节区分现用不同音阶序列，将来换不同 ogg。
//   地图：
//     二维数组 CH1_TILES/CH2_TILES (tile id 0草地 1树/墙 2房屋 3水)
//       → 换成 Tiled JSON：this.load.tilemapTiledJSON('ch1','assets/ch1.json')
//       边界传送点 EXITS 数组 → Tiled 的 Object Layer "exits"
//   数值：
//     GROWTH 升级表 / ENEMIES / BOSSES 数据驱动 → 换成 JSON 配置表
// =============================================================================
(function () {
  'use strict';

  // ==========================================================================
  // 常量与数据（中文注释 + 带单位）
  // ==========================================================================
  /** 单格边长 px */
  var TILE = 32;
  /** 地图块尺寸（格）—— CH1 16x12，CH2 16x12，可各自不同 */
  // tile id 含义：0草地(可走+随机遇敌) 1树/墙(阻挡) 2房屋(阻挡) 3水(阻挡)
  // 草地/洞窟地面步数计数触发遇敌；房屋/树/水阻挡移动（tween 撞墙回弹+Sfx）。
  // 章节：CH1 村庄+野外，CH2 洞窟+城堡；边界传送点见 EXITS。

  var GROWTH = [
    { lv: 1, maxHp: 28, maxMp: 12, atk: 10, def: 6, need: 0 },
    { lv: 2, maxHp: 36, maxMp: 16, atk: 12, def: 7, need: 12 },
    { lv: 3, maxHp: 44, maxMp: 20, atk: 14, def: 9, need: 28 },
    { lv: 4, maxHp: 54, maxMp: 24, atk: 17, def: 11, need: 50 },
    { lv: 5, maxHp: 66, maxMp: 28, atk: 20, def: 13, need: 80 },
    { lv: 6, maxHp: 80, maxMp: 34, atk: 24, def: 16, need: 120 },
    { lv: 7, maxHp: 96, maxMp: 40, atk: 28, def: 19, need: 175 },
    { lv: 8, maxHp: 114, maxMp: 46, atk: 32, def: 22, need: 250 },
    { lv: 9, maxHp: 134, maxMp: 52, atk: 36, def: 25, need: 360 },
    { lv: 10, maxHp: 160, maxMp: 60, atk: 42, def: 29, need: 500 }
  ];

  // 敌方配置（随章节变，至少4种/ch，数据驱动）
  var ENEMIES_CH1 = [
    { id: 'slime', name: '史莱姆', hp: 18, atk: 7, def: 2, exp: 6, gold: 7, tex: 'enemy_slime' },
    { id: 'bat', name: '小蝙蝠', hp: 14, atk: 9, def: 1, exp: 7, gold: 6, tex: 'enemy_bat' },
    { id: 'goblin', name: '哥布林', hp: 22, atk: 10, def: 3, exp: 9, gold: 10, tex: 'enemy_goblin' },
    { id: 'skeleton', name: '骷髅兵', hp: 26, atk: 11, def: 4, exp: 11, gold: 12, tex: 'enemy_skeleton' }
  ];
  var ENEMIES_CH2 = [
    { id: 'cavebat', name: '洞窟蝙蝠', hp: 30, atk: 14, def: 5, exp: 14, gold: 14, tex: 'enemy_cavebat' },
    { id: 'orc', name: '兽人', hp: 38, atk: 16, def: 6, exp: 18, gold: 18, tex: 'enemy_orc' },
    { id: 'ghost', name: '幽灵', hp: 34, atk: 18, def: 3, exp: 20, gold: 20, tex: 'enemy_ghost' },
    { id: 'armor', name: '铠甲兵', hp: 44, atk: 15, def: 9, exp: 22, gold: 22, tex: 'enemy_armor' }
  ];
  var BOSSES = [
    { id: 'slimeking', name: '史莱姆王', hp: 88, atk: 16, def: 6, exp: 40, gold: 50, tex: 'boss_slimeking', multi: 2 },
    { id: 'dragon', name: '暗黑龙王', hp: 150, atk: 20, def: 9, exp: 100, gold: 120, tex: 'boss_dragon', multi: 2 }
  ];

  // 两章地图（二维数组 tile id）
  // 将来换 Tiled：this.load.tilemapTiledJSON + 图块集，此处保持二维数组直观可编辑
  var CH1_TILES = [
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1],
    [1,0,2,2,0,0,0,1,0,1,0,2,2,0,0,1],
    [1,0,2,2,0,0,0,1,0,0,0,2,2,0,0,1],
    [1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1],
    [1,0,0,3,3,0,0,0,0,0,1,1,0,0,0,1],
    [1,0,0,3,3,0,0,0,0,0,1,1,0,0,0,0],
    [1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,1],
    [1,0,1,1,0,0,0,0,1,0,2,2,0,1,0,1],
    [1,0,0,0,0,1,0,0,0,0,2,2,0,1,0,1],
    [1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
  ];
  var CH2_TILES = [
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,0,0,1,1,1,0,0,0,1,0,2,2,0,0,1],
    [1,0,0,1,0,0,0,1,0,1,0,2,2,0,0,1],
    [1,0,0,1,0,0,0,1,0,0,0,0,0,0,0,1],
    [1,0,1,1,0,1,0,1,1,1,0,1,1,0,0,1],
    [0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,1],
    [1,0,1,1,0,1,0,3,3,0,0,1,0,1,0,1],
    [1,0,0,0,0,1,0,3,3,0,0,1,0,1,0,1],
    [1,1,1,0,0,1,0,0,0,0,1,1,0,1,0,1],
    [1,0,0,0,1,1,1,1,0,1,1,1,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
  ];

  var MAPS = [
    {
      id: 0, name: '村庄与原野',
      tiles: CH1_TILES, w: 16, h: 12,
      spawn: { x: 2, y: 5 },
      // 边界传送点：走到 (15,6) 的草地 -> CH2 入口 (1,5)
      exits: [{ x: 15, y: 6, to: 1, dest: { x: 1, y: 5 } }],
      npcs: [
        { x: 4, y: 4, tex: 'npc_old', name: '长老', msg: '勇者啊！东边的洞窟封印松动了…先在原野练级，再去挑战史莱姆王！' },
        { x: 11, y: 2, tex: 'npc_girl', name: '少女', msg: '药草可以回血，魔法火球很强但耗蓝！打败史莱姆王就能进入洞窟。' }
      ],
      boss: { x: 13, y: 10, tex: 'boss_slimeking' }
    },
    {
      id: 1, name: '洞窟与城堡',
      tiles: CH2_TILES, w: 16, h: 12,
      spawn: { x: 1, y: 5 },
      exits: [{ x: 0, y: 5, to: 0, dest: { x: 14, y: 6 } }],
      npcs: [
        { x: 2, y: 1, tex: 'npc_guard', name: '守卫', msg: '城堡深处的暗黑龙王苏醒了…只有真正的勇者能击败它！' }
      ],
      boss: { x: 7, y: 10, tex: 'boss_dragon' }
    }
  ];

  var BLOCKED = { 1: true, 2: true, 3: true };
  var SAVE_KEY = 'rpgdq_save';

  // ==========================================================================
  // 存档与状态缝（对应 Acceptance getState 要求）
  // ==========================================================================
  var hostRef = null;
  var sceneRef = null;
  var saveData = { chapter: 1, level: 1, exp: 0, gold: 0, unlockedChapter: 1, bossDefeated: [false, false], herb: 3 };
  function getState() {
    var sc = sceneRef;
    if (!sc) { return { scene: 'field', chapter: saveData.chapter, map: 0, lv: saveData.level, hp: GROWTH[0].maxHp, mp: GROWTH[0].maxMp, gold: saveData.gold }; }
    return {
      scene: sc.state || 'field',
      chapter: (sc.curMapId != null ? sc.curMapId + 1 : saveData.chapter),
      map: sc.curMapId != null ? sc.curMapId : 0,
      lv: sc.p ? sc.p.lv : saveData.level,
      hp: sc.p ? sc.p.hp : 0,
      mp: sc.p ? sc.p.mp : 0,
      gold: sc.p ? sc.p.gold : saveData.gold
    };
  }

  // ==========================================================================
  // Sfx — WebAudio，注释写将来换 this.load.audio 的替换写法
  // 将来换：preload(){ this.load.audio('attack','assets/attack.wav'); } play(){ this.sound.play(name); }
  // ==========================================================================
  var Sfx = {
    ctx: null,
    bgmTimer: null,
    ensure: function () {
      try {
        if (!Sfx.ctx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) { return null; }
          Sfx.ctx = new AC();
        }
        if (Sfx.ctx.state === 'suspended') { Sfx.ctx.resume(); }
        return Sfx.ctx;
      } catch (e) { return null; }
    },
    tone: function (freq, dur, type, vol, slideTo) {
      try {
        var ctx = Sfx.ensure();
        if (!ctx) { return; }
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        if (slideTo) { o.frequency.linearRampToValueAtTime(slideTo, ctx.currentTime + dur); }
        g.gain.value = vol != null ? vol : 0.18;
        g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + dur);
      } catch (e) {}
    },
    play: function (name) {
      try {
        if (name === 'move') { Sfx.tone(420, 0.07, 'square', 0.09, 520); }
        else if (name === 'bump') { Sfx.tone(140, 0.09, 'square', 0.14, 90); }
        else if (name === 'encounter') { Sfx.tone(220, 0.18, 'sawtooth', 0.22, 440); setTimeout(function(){ Sfx.tone(330,0.18,'sawtooth',0.18, 660); }, 120); }
        else if (name === 'attack') { Sfx.tone(180, 0.12, 'square', 0.24, 60); setTimeout(function(){ Sfx.tone(90,0.08,'square',0.18); }, 60); }
        else if (name === 'magic') { Sfx.tone(660,0.14,'sine',0.22,990); setTimeout(function(){ Sfx.tone(880,0.18,'triangle',0.2); }, 110); }
        else if (name === 'hurt') { Sfx.tone(200,0.22,'sawtooth',0.2,80); }
        else if (name === 'heal') { Sfx.tone(523,0.12,'sine',0.18); setTimeout(function(){Sfx.tone(659,0.12,'sine',0.18);},100); setTimeout(function(){Sfx.tone(784,0.16,'sine',0.18);},200); }
        else if (name === 'victory') { Sfx.tone(523,0.14,'sine',0.2); setTimeout(function(){Sfx.tone(659,0.14,'sine',0.2);},130); setTimeout(function(){Sfx.tone(784,0.14,'sine',0.2);},260); setTimeout(function(){Sfx.tone(1046,0.22,'sine',0.22);},390); }
        else if (name === 'levelup') { Sfx.tone(440,0.12,'triangle',0.2); setTimeout(function(){Sfx.tone(550,0.12,'triangle',0.2);},110); setTimeout(function(){Sfx.tone(660,0.12,'triangle',0.2);},220); setTimeout(function(){Sfx.tone(880,0.28,'sine',0.22);},330); }
        else if (name === 'select') { Sfx.tone(700,0.06,'sine',0.12); }
      } catch (e) {}
    },
    startBgm: function (scene, chapter) {
      try {
        Sfx.stopBgm();
        var ctx = Sfx.ensure();
        if (!ctx) { return; }
        // 章节区分：CH1 明亮进行曲，CH2 低沉洞窟
        var seq1 = [196,247,294,330,294,247];
        var seq2 = [110,130,146,130,110,98];
        var seq = chapter === 1 ? seq1 : seq2;
        var delay = chapter === 1 ? 380 : 520;
        var idx = 0;
        Sfx.bgmTimer = scene.time.addEvent({
          delay: delay,
          loop: true,
          callback: function () {
            try { Sfx.tone(seq[idx % seq.length], 0.16, 'triangle', 0.055); idx++; } catch (e) {}
          }
        });
      } catch (e) {}
    },
    stopBgm: function () {
      try { if (Sfx.bgmTimer) { Sfx.bgmTimer.remove(false); Sfx.bgmTimer = null; } } catch (e) {}
    }
  };

  // ==========================================================================
  // 纹理生成（纯几何体，零外部图片）—— 每段注释标将来换 load.image
  // ==========================================================================
  function buildTextures(scene) {
    function rm(k) { if (scene.textures.exists(k)) { try { scene.textures.remove(k); } catch (e) {} } }
    var g;
    // 草地 0 — 绿底+深绿点
    // 将来换：this.load.image('t_grass','assets/grass.png')
    rm('t_grass');
    g = scene.add.graphics();
    g.fillStyle(0x7fbf6a, 1); g.fillRect(0, 0, TILE, TILE);
    g.fillStyle(0x6aa84f, 1); g.fillCircle(8, 8, 2); g.fillCircle(22, 14, 2.2); g.fillCircle(14, 24, 1.8);
    g.fillStyle(0x9be08a, 0.9); g.fillRect(0, 0, TILE, 3);
    g.lineStyle(1, 0x5a8a3a, 0.25); g.strokeRect(0, 0, TILE, TILE);
    g.generateTexture('t_grass', TILE, TILE); g.destroy();
    // 树/墙 1 — CH1为树（棕干绿冠），CH2复用为石墙（灰），共用纹理
    // 将来换：this.load.image('t_tree','assets/tree.png') / 't_wall'
    rm('t_tree');
    g = scene.add.graphics();
    g.fillStyle(0x8d6e63, 1); g.fillRect(10, 18, 12, 14);
    g.fillStyle(0x3a7d44, 1); g.fillCircle(16, 12, 12); g.fillCircle(10, 16, 8); g.fillCircle(22, 16, 8);
    g.fillStyle(0x2e6b36, 1); g.fillCircle(16, 10, 4);
    g.lineStyle(1, 0x3a4a2a, 0.35); g.strokeRect(0, 0, TILE, TILE);
    g.generateTexture('t_tree', TILE, TILE); g.destroy();
    rm('t_wall');
    g = scene.add.graphics();
    g.fillStyle(0x8a8a8a, 1); g.fillRect(0, 0, TILE, TILE);
    g.fillStyle(0x9e9e9e, 1); g.fillRect(2, 2, 12, 12); g.fillRect(18, 4, 12, 10); g.fillRect(4, 18, 24, 10);
    g.lineStyle(1, 0x5a5a5a, 0.9); g.strokeRect(0, 0, TILE, TILE);
    g.lineStyle(1, 0x6a6a6a, 0.7); g.lineBetween(0, 14, TILE, 14); g.lineBetween(14, 0, 14, 14);
    g.generateTexture('t_wall', TILE, TILE); g.destroy();
    // 房屋 2 — 棕墙红顶+门
    // 将来换：this.load.image('t_house','assets/house.png')
    rm('t_house');
    g = scene.add.graphics();
    g.fillStyle(0xc9a86a, 1); g.fillRect(2, 12, 28, 18);
    g.fillStyle(0xa67c3a, 1); g.fillRect(2, 12, 28, 4);
    g.fillStyle(0xb93a2b, 1); g.fillTriangle(0, 12, 16, 0, 32, 12);
    g.fillStyle(0x7a4a1a, 1); g.fillRect(11, 20, 10, 10);
    g.fillStyle(0x3a2a0a, 1); g.fillCircle(18, 25, 1);
    g.lineStyle(1, 0x5a3a0a, 0.8); g.strokeRect(0, 0, TILE, TILE);
    g.generateTexture('t_house', TILE, TILE); g.destroy();
    // 水 3 — 蓝底波纹
    // 将来换：this.load.image('t_water','assets/water.png')
    rm('t_water');
    g = scene.add.graphics();
    g.fillStyle(0x4a90d9, 1); g.fillRect(0, 0, TILE, TILE);
    g.fillStyle(0x7ab8f5, 0.9); g.fillRect(0, 6, TILE, 2); g.fillRect(0, 16, TILE, 2); g.fillRect(0, 26, TILE, 2);
    g.fillStyle(0x2a6ab5, 0.5); g.fillCircle(10, 10, 5); g.fillCircle(22, 22, 4);
    g.generateTexture('t_water', TILE, TILE); g.destroy();

    // 勇者俯视小人（头+身）— 几何
    // 将来换：this.load.spritesheet('hero','assets/hero.png',{frameWidth:32,frameHeight:32})
    rm('hero_down');
    g = scene.add.graphics();
    g.fillStyle(0x2e86de, 1); g.fillRoundedRect(8, 14, 16, 14, 4); // 身
    g.fillStyle(0xf5d6b8, 1); g.fillCircle(16, 10, 8); // 头
    g.fillStyle(0x3a2a1a, 1); g.fillCircle(13, 9, 1.4); g.fillCircle(19, 9, 1.4); // 眼
    g.fillStyle(0xe74c3c, 1); g.fillRoundedRect(6, 2, 20, 6, 3); // 帽/头带
    g.fillStyle(0xf2c12c, 1); g.fillCircle(16, 20, 2); // 扣子
    g.lineStyle(1, 0x1a3a5a, 0.4); g.strokeRoundedRect(8, 14, 16, 14, 4);
    g.generateTexture('hero_down', TILE, TILE); g.destroy();
    // 影子（脚下椭圆）
    rm('shadow');
    g = scene.add.graphics();
    g.fillStyle(0x000000, 0.22); g.fillEllipse(16, 28, 18, 6);
    g.generateTexture('shadow', TILE, TILE); g.destroy();

    // NPC 几何
    // 将来换：this.load.image('npc_old','assets/npc_old.png')
    rm('npc_old'); g = scene.add.graphics();
    g.fillStyle(0x8d6e63, 1); g.fillRoundedRect(7, 13, 18, 15, 5);
    g.fillStyle(0xf5e6c8, 1); g.fillCircle(16, 10, 7);
    g.fillStyle(0xffffff, 1); g.fillCircle(16, 8, 5);
    g.fillStyle(0x5a3a1a, 1); g.fillCircle(13, 11, 1.2); g.fillCircle(19, 11, 1.2);
    g.generateTexture('npc_old', TILE, TILE); g.destroy();
    rm('npc_girl'); g = scene.add.graphics();
    g.fillStyle(0xe57373, 1); g.fillRoundedRect(9, 14, 14, 14, 4);
    g.fillStyle(0xf5d6b8, 1); g.fillCircle(16, 10, 7);
    g.fillStyle(0x3a2a1a, 1); g.fillCircle(16, 6, 7);
    g.fillStyle(0x222222, 1); g.fillCircle(13, 11, 1.2); g.fillCircle(19, 11, 1.2);
    g.generateTexture('npc_girl', TILE, TILE); g.destroy();
    rm('npc_guard'); g = scene.add.graphics();
    g.fillStyle(0x6a6a6a, 1); g.fillRoundedRect(8, 13, 16, 15, 3);
    g.fillStyle(0xb0bec5, 1); g.fillRect(12, 13, 8, 10);
    g.fillStyle(0xf5d6b8, 1); g.fillCircle(16, 9, 7);
    g.generateTexture('npc_guard', TILE, TILE); g.destroy();

    // 敌方正面大图几何（至少4种/ch + 2 Boss）
    function enemyTex(key, bg, eye, deco) {
      rm(key); g = scene.add.graphics();
      var c = Phaser.Display.Color.HexStringToColor(bg);
      g.fillStyle(c.color, 1); g.fillRoundedRect(4, 6, 56, 56, 10);
      g.fillStyle(0xffffff, 0.18); g.fillRoundedRect(4, 6, 56, 24, 10);
      // 眼
      var ec = Phaser.Display.Color.HexStringToColor(eye);
      g.fillStyle(ec.color, 1); g.fillCircle(20, 26, 7); g.fillCircle(44, 26, 7);
      g.fillStyle(0x111111, 1); g.fillCircle(20, 27, 2.5); g.fillCircle(44, 27, 2.5);
      // 装饰
      if (deco === 'slime') { g.fillStyle(0xffffff, 0.85); g.fillCircle(18, 18, 3); g.fillStyle(0x111111,1); g.fillEllipse(32, 42, 18, 6); }
      if (deco === 'bat') { g.fillStyle(0x222222,1); g.fillTriangle(0,28,10,18,10,38); g.fillTriangle(64,28,54,18,54,38); }
      if (deco === 'goblin') { g.fillStyle(0x2e7d32,1); g.fillTriangle(32,8,22,2,42,2); }
      if (deco === 'skeleton') { g.fillStyle(0xeeeeee,1); g.fillCircle(32, 44, 6); g.lineStyle(1,0x222222,1); for(var i=0;i<3;i++){ g.lineBetween(26+i*6,46,26+i*6,52);} }
      if (deco === 'orc') { g.fillStyle(0x8d6e63,1); g.fillRect(10,44,44,8); g.fillStyle(0xcc0000,1); g.fillCircle(32,14,4); }
      if (deco === 'ghost') { g.fillStyle(0xffffff,0.85); g.fillEllipse(32,50,40,14); g.fillStyle(0x90caf9,0.9); g.fillCircle(32,34,10); }
      if (deco === 'armor') { g.fillStyle(0x78909c,1); g.fillRect(14,36,36,14); g.fillStyle(0x37474f,1); g.fillRect(26,10,12,14); }
      if (deco === 'boss_slime') { g.fillStyle(0xffd54f,1); g.fillCircle(32,18,8); g.fillStyle(0x111111,1); g.fillRect(20,44,24,6); }
      if (deco === 'boss_dragon') { g.fillStyle(0x7a1a1a,1); g.fillTriangle(32,4,18,14,46,14); g.fillStyle(0xff5722,1); g.fillTriangle(32,36,22,46,42,46); }
      g.lineStyle(2, 0x222222, 0.5); g.strokeRoundedRect(4, 6, 56, 56, 10);
      g.generateTexture(key, 64, 64); g.destroy();
    }
    enemyTex('enemy_slime', '#4fc3f7', '#01579b', 'slime');
    enemyTex('enemy_bat', '#7e57c2', '#ffeb3b', 'bat');
    enemyTex('enemy_goblin', '#81c784', '#1b5e20', 'goblin');
    enemyTex('enemy_skeleton', '#e0e0e0', '#ff3d00', 'skeleton');
    enemyTex('enemy_cavebat', '#9575cd', '#ffeb3b', 'bat');
    enemyTex('enemy_orc', '#a1887f', '#b71c1c', 'orc');
    enemyTex('enemy_ghost', '#b39ddb', '#311b92', 'ghost');
    enemyTex('enemy_armor', '#90a4ae', '#ff3d00', 'armor');
    enemyTex('boss_slimeking', '#ffd54f', '#e65100', 'boss_slime');
    enemyTex('boss_dragon', '#c62828', '#ffeb3b', 'boss_dragon');

    // 粒子/特效（池化用）
    rm('fx_hit');
    g = scene.add.graphics();
    g.fillStyle(0xffffff, 1); g.fillCircle(8, 8, 8);
    g.fillStyle(0xffeb3b, 1); g.fillCircle(8, 8, 4);
    g.generateTexture('fx_hit', 16, 16); g.destroy();
    rm('fx_fire');
    g = scene.add.graphics();
    g.fillStyle(0xff5722, 1); g.fillCircle(8, 8, 7);
    g.fillStyle(0xffeb3b, 1); g.fillCircle(8, 6, 4);
    g.generateTexture('fx_fire', 16, 16); g.destroy();
  }

  // ==========================================================================
  // 主场景：同一 Scene 状态机 field ↔ battle（注释说明可拆 Scene）
  // 设计说明：为满足 Acceptance“非 Phaser scene 切，用同一 scene 的状态机”，
  // 本实现单 Scene 内用 this.state 切换；若需拆分，可将 field 逻辑迁至 FieldScene、
  // battle 逻辑迁至 BattleScene，通过 scene.start + data 传参，注释处已标迁移点。
  // ==========================================================================
  var MainScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function MainScene() { Phaser.Scene.call(this, { key: 'Main' }); },
    create: function () {
      sceneRef = this;
      buildTextures(this);
      this.cameras.main.setBackgroundColor('#2e3d2a');

      // 输入（键盘/方向键步进）
      this.keys = this.input.keyboard.addKeys('W,A,S,D,LEFT,RIGHT,UP,DOWN,SPACE,ENTER,ESC,R');
      this.input.keyboard.on('keydown', function () { Sfx.ensure(); });
      this.input.once('pointerdown', function () { Sfx.ensure(); });

      // 数据
      this.curMapId = 0;
      this.state = 'field'; // field | battle | victory | ending | gameover
      this.isMoving = false;
      this.steps = 0; // 草地/洞窟步数计数
      this.p = null; // 玩家数值
      this.hero = null;
      this.heroShadow = null;
      this.tileSprites = []; // 二维 sprite 引用便于刷新
      this.npcSprites = [];
      this.bossSprite = null;
      this.battle = null; // {enemy, enemyHp, maxHp, turn, defending, eDefending, menuIdx, isBoss, multiLeft, log}
      this.pendingMove = null;

      // 容器（field ↔ battle 同 Scene 状态机，battle 覆盖层）
      this.fieldRoot = this.add.container(0, 0);
      this.battleRoot = this.add.container(0, 0).setVisible(false).setDepth(50);
      this.hudRoot = this.add.container(0, 0).setDepth(100);
      this.msgRoot = this.add.container(0, 0).setDepth(120);

      // 池化：特效/伤害数字（池化 Avoid 每帧 new）
      this.fxPool = this.add.group({ maxSize: 24 });
      for (var i = 0; i < 16; i++) {
        var fx = this.add.image(-100, -100, 'fx_hit').setVisible(false).setDepth(60);
        this.fxPool.add(fx);
      }
      this.dmgPool = [];
      for (var j = 0; j < 12; j++) {
        var t = this.add.text(-100, -100, '', { fontSize: '14px', color: '#ff3b30', stroke: '#000', strokeThickness: 3 }).setDepth(70).setVisible(false);
        this.dmgPool.push(t);
      }

      // HUD
      var hudBg = this.add.rectangle(0, 0, 800, 36, 0x111111, 0.72).setOrigin(0, 0);
      this.hudRoot.add(hudBg);
      this.hudText = this.add.text(8, 6, '', { fontSize: '13px', color: '#ffffff' });
      this.hudRoot.add(this.hudText);
      this.subHud = this.add.text(8, 20, '', { fontSize: '11px', color: '#ffeb3b' });
      this.hudRoot.add(this.subHud);
      this.helpText = this.add.text(400, 34, '方向键/WASD 移动  空格 对话/确认  ESC 菜单', { fontSize: '10px', color: '#c8e6c9' }).setOrigin(0.5, 0);
      // help 在 field 可见，battle 隐藏
      this.fieldRoot.add(this.helpText);

      // 消息框（底部）
      this.msgBox = this.add.rectangle(400, 430, 760, 70, 0x000000, 0.78).setStrokeStyle(2, 0xffffff, 0.9).setVisible(false);
      this.msgText = this.add.text(400, 430, '', { fontSize: '13px', color: '#ffffff', align: 'center', wordWrap: { width: 720 } }).setOrigin(0.5).setVisible(false);
      this.msgRoot.add([this.msgBox, this.msgText]);

      // Battle UI（覆盖层，field 时隐藏）
      this.battleBg = this.add.rectangle(400, 225, 800, 450, 0x1a1a2e, 0.96).setStrokeStyle(2, 0x7e57c2, 1);
      this.battleTitle = this.add.text(400, 34, '遭遇战！', { fontSize: '18px', color: '#ffd54f', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5);
      this.enemyImage = this.add.image(400, 140, 'enemy_slime').setScale(1.6);
      this.enemyHpText = this.add.text(400, 200, '', { fontSize: '13px', color: '#ff8a65', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5);
      this.playerBattleText = this.add.text(120, 250, '', { fontSize: '12px', color: '#ffffff', lineSpacing: 4 });
      // 指令菜单 攻击/防御/魔法/道具
      this.menuOpts = ['攻击', '防御', '魔法(火球 4MP)', '道具(药草)'];
      this.menuTexts = [];
      for (var mi = 0; mi < this.menuOpts.length; mi++) {
        var mt = this.add.text(520, 250 + mi * 24, (mi === 0 ? '▶ ' : '  ') + this.menuOpts[mi], { fontSize: '14px', color: mi === 0 ? '#ffd54f' : '#ffffff', stroke: '#000', strokeThickness: 3 });
        this.menuTexts.push(mt);
      }
      this.battleLog = this.add.text(400, 380, '', { fontSize: '12px', color: '#e0e0e0', align: 'center', wordWrap: { width: 740 } }).setOrigin(0.5);
      this.battleRoot.add([this.battleBg, this.battleTitle, this.enemyImage, this.enemyHpText, this.playerBattleText].concat(this.menuTexts).concat([this.battleLog]));

      // 读取存档（host.saveState/loadState）
      var self = this;
      this._loaded = false;
      function applySave(d) {
        if (d && typeof d === 'object') {
          if (typeof d.chapter === 'number') { saveData.chapter = d.chapter; }
          if (typeof d.level === 'number') { saveData.level = d.level; }
          if (typeof d.exp === 'number') { saveData.exp = d.exp; }
          if (typeof d.gold === 'number') { saveData.gold = d.gold; }
          if (typeof d.unlockedChapter === 'number') { saveData.unlockedChapter = d.unlockedChapter; }
          if (Array.isArray(d.bossDefeated)) { saveData.bossDefeated = d.bossDefeated.slice(0, 2); while (saveData.bossDefeated.length < 2) { saveData.bossDefeated.push(false); } }
          if (typeof d.herb === 'number') { saveData.herb = d.herb; }
          // 兼容旧 saveData.unlockedLevel
          if (typeof d.unlockedLevel === 'number' && !d.unlockedChapter) { saveData.unlockedChapter = d.unlockedLevel; }
        }
      }
      function initAfterLoad() {
        if (self._loaded) { return; }
        self._loaded = true;
        self.initPlayerFromSave();
        self.loadMap(saveData.chapter - 1 >= 0 ? saveData.chapter - 1 : 0, null);
        Sfx.startBgm(self, saveData.chapter);
        self.showMsg('勇者启程！CH' + saveData.chapter + ' ' + MAPS[self.curMapId].name + '  方向键移动', 2200);
      }
      if (hostRef && hostRef.loadState) {
        try {
          hostRef.loadState().then(function (d) { applySave(d); initAfterLoad(); }, function () { initAfterLoad(); });
        } catch (e) { initAfterLoad(); }
      } else {
        // 本地兜底
        try { var loc = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); applySave(loc); } catch (e) {}
        initAfterLoad();
      }

      // 缩放适配
      this.scale.on('resize', function () { /* host 固定尺寸，无需重排 */ });

      // 暴露 __trgame 测试缝
      window.__trgame = window.__trgame || {};
      window.__trgame.getScene = function () { return sceneRef; };
    },

    initPlayerFromSave: function () {
      var lv = saveData.level || 1;
      var grow = GROWTH[Math.min(lv, GROWTH.length) - 1];
      if (!grow) { grow = GROWTH[0]; }
      this.p = {
        lv: lv,
        exp: saveData.exp || 0,
        gold: saveData.gold || 0,
        maxHp: grow.maxHp,
        maxMp: grow.maxMp,
        hp: grow.maxHp,
        mp: grow.maxMp,
        atk: grow.atk,
        def: grow.def,
        herb: saveData.herb != null ? saveData.herb : 3
      };
    },

    save: function () {
      try {
        saveData.chapter = this.curMapId + 1;
        saveData.level = this.p.lv;
        saveData.exp = this.p.exp;
        saveData.gold = this.p.gold;
        saveData.herb = this.p.herb;
        // unlockedChapter 已在 boss 胜利时更新
        if (hostRef && hostRef.saveState) { try { hostRef.saveState(saveData); } catch (e) {} }
        try { localStorage.setItem(SAVE_KEY, JSON.stringify(saveData)); } catch (e) {}
      } catch (e) {}
    },

    // 地图加载（切图换图，边界传送点）
    loadMap: function (mapId, dest) {
      if (mapId < 0) { mapId = 0; }
      if (mapId >= MAPS.length) { mapId = MAPS.length - 1; }
      this.curMapId = mapId;
      var m = MAPS[mapId];
      // 清理旧瓦片/NPC/Boss
      for (var i = 0; i < this.tileSprites.length; i++) { try { this.tileSprites[i].destroy(); } catch (e) {} }
      this.tileSprites.length = 0;
      for (var n = 0; n < this.npcSprites.length; n++) { try { this.npcSprites[n].destroy(); } catch (e) {} }
      this.npcSprites.length = 0;
      if (this.bossSprite) { try { this.bossSprite.destroy(); } catch (e) {} this.bossSprite = null; }
      if (this.heroShadow) { try { this.heroShadow.destroy(); } catch (e) {} this.heroShadow = null; }
      if (this.hero) { try { this.hero.destroy(); } catch (e) {} this.hero = null; }

      // 生成瓦片
      // 将来换 Tiled：this.make.tilemap + 图块集，此处保持二维数组直观
      var offsetX = (800 - m.w * TILE) / 2;
      var offsetY = 44; // HUD 下
      this.mapOffsetX = offsetX;
      this.mapOffsetY = offsetY;
      this.mapW = m.w;
      this.mapH = m.h;
      this.tiles = m.tiles;
      for (var y = 0; y < m.h; y++) {
        for (var x = 0; x < m.w; x++) {
          var id = m.tiles[y][x];
          var tex = id === 0 ? 't_grass' : id === 1 ? (mapId === 0 ? 't_tree' : 't_wall') : id === 2 ? 't_house' : 't_water';
          var spr = this.add.image(offsetX + x * TILE + TILE / 2, offsetY + y * TILE + TILE / 2, tex);
          this.fieldRoot.add(spr);
          this.tileSprites.push(spr);
        }
      }
      // 边框
      var border = this.add.rectangle(offsetX + m.w * TILE / 2, offsetY + m.h * TILE / 2, m.w * TILE + 4, m.h * TILE + 4, 0x000000, 0).setStrokeStyle(2, 0xffffff, 0.9);
      this.fieldRoot.add(border);
      this.tileSprites.push(border);

      // NPC
      for (var ni = 0; ni < m.npcs.length; ni++) {
        var nd = m.npcs[ni];
        var ns = this.add.image(offsetX + nd.x * TILE + TILE / 2, offsetY + nd.y * TILE + TILE / 2, nd.tex);
        this.fieldRoot.add(ns);
        ns._npc = nd;
        this.npcSprites.push(ns);
      }
      // Boss（若未击败则显示，否则隐藏）
      if (!saveData.bossDefeated[mapId]) {
        var bd = m.boss;
        this.bossSprite = this.add.image(offsetX + bd.x * TILE + TILE / 2, offsetY + bd.y * TILE + TILE / 2, bd.tex).setScale(0.6);
        this.fieldRoot.add(this.bossSprite);
        this.bossSprite._isBoss = true;
        this.bossSprite._mapId = mapId;
      }
      // 传送点标记（箭头）
      for (var ei = 0; ei < m.exits.length; ei++) {
        var ex = m.exits[ei];
        var arrow = this.add.text(offsetX + ex.x * TILE + TILE / 2, offsetY + ex.y * TILE + TILE / 2, ex.to > mapId ? '→' : '←', { fontSize: '18px', color: '#ffd54f', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5);
        this.fieldRoot.add(arrow);
        this.tileSprites.push(arrow);
      }

      // 勇者
      var sp = dest || m.spawn;
      this.gridX = sp.x;
      this.gridY = sp.y;
      this.heroShadow = this.add.image(offsetX + sp.x * TILE + TILE / 2, offsetY + sp.y * TILE + TILE / 2, 'shadow');
      this.hero = this.add.image(offsetX + sp.x * TILE + TILE / 2, offsetY + sp.y * TILE + TILE / 2, 'hero_down');
      this.fieldRoot.add(this.heroShadow);
      this.fieldRoot.add(this.hero);
      this.steps = 0;
      this.updateHud();
      this.save();
      Sfx.startBgm(this, mapId + 1);
    },

    // HUD 刷新
    updateHud: function () {
      if (!this.p) { return; }
      var grow = GROWTH[Math.min(this.p.lv, GROWTH.length) - 1] || GROWTH[0];
      var need = 0;
      if (this.p.lv < GROWTH.length) { need = GROWTH[this.p.lv].need; }
      var expStr = this.p.lv >= GROWTH.length ? 'MAX' : this.p.exp + '/' + need;
      var mapName = MAPS[this.curMapId] ? MAPS[this.curMapId].name : '';
      this.hudText.setText('CH' + (this.curMapId + 1) + ' ' + mapName + '  Lv.' + this.p.lv + '  HP ' + this.p.hp + '/' + this.p.maxHp + '  MP ' + this.p.mp + '/' + this.p.maxMp + '  ATK ' + this.p.atk + ' DEF ' + this.p.def);
      this.subHud.setText('EXP ' + expStr + '  GOLD ' + this.p.gold + '  药草 x' + this.p.herb + (this.state === 'battle' ? '  [战斗中]' : '  [原野]'));
    },

    showMsg: function (text, dur) {
      var self = this;
      this.msgBox.setVisible(true);
      this.msgText.setText(text).setVisible(true);
      if (this._msgTimer) { try { this._msgTimer.remove(false); } catch (e) {} }
      this._msgTimer = this.time.delayedCall(dur || 2000, function () {
        self.msgBox.setVisible(false);
        self.msgText.setVisible(false);
      });
    },

    // 网格移动（tile 32px，键盘步进+平滑插值 tween，撞墙阻挡）
    tryMove: function (dx, dy) {
      if (this.state !== 'field' || this.isMoving) { return; }
      if (this.msgBox.visible) {
        // 有消息时按空格关闭
        return;
      }
      var nx = this.gridX + dx;
      var ny = this.gridY + dy;
      // 越界阻挡（除非是传送点所在边界）
      if (nx < 0 || nx >= this.mapW || ny < 0 || ny >= this.mapH) {
        // 检查是否为传送点（允许越界格为传送）
        var isExit = false;
        var m = MAPS[this.curMapId];
        for (var ei = 0; ei < m.exits.length; ei++) { if (m.exits[ei].x === nx && m.exits[ei].y === ny) { isExit = true; break; } }
        if (!isExit) { Sfx.play('bump'); this.shakeHero(); return; }
      }
      var tileId = 0;
      if (nx >= 0 && nx < this.mapW && ny >= 0 && ny < this.mapH) { tileId = this.tiles[ny][nx]; }
      // 传送点优先（即使 tile 为墙也允许）
      var exit = null;
      var mm = MAPS[this.curMapId];
      for (var e2 = 0; e2 < mm.exits.length; e2++) { if (mm.exits[e2].x === nx && mm.exits[e2].y === ny) { exit = mm.exits[e2]; break; } }
      if (exit) {
        // 跨图
        Sfx.play('move');
        this.doMoveTween(nx, ny, function () {
          this.loadMap(exit.to, exit.dest);
          this.showMsg('来到 ' + MAPS[exit.to].name, 1500);
        }.bind(this));
        return;
      }
      // 阻挡判定：1树/墙 2房屋 3水 均阻挡
      if (BLOCKED[tileId]) {
        Sfx.play('bump');
        this.shakeHero();
        return;
      }
      // NPC 阻挡（不可踩，但可对话）
      for (var ni = 0; ni < this.npcSprites.length; ni++) {
        if (this.npcSprites[ni]._npc.x === nx && this.npcSprites[ni]._npc.y === ny) {
          Sfx.play('bump');
          this.showMsg(this.npcSprites[ni]._npc.name + '：' + this.npcSprites[ni]._npc.msg, 2600);
          return;
        }
      }
      // Boss 固定遭遇（踩上触发）
      if (this.bossSprite && !saveData.bossDefeated[this.curMapId]) {
        var bd = MAPS[this.curMapId].boss;
        if (bd.x === nx && bd.y === ny) {
          Sfx.play('move');
          this.doMoveTween(nx, ny, function () {
            this.startBattle(true);
          }.bind(this));
          return;
        }
      }
      Sfx.play('move');
      var destTileId = tileId;
      this.doMoveTween(nx, ny, function () {
        // 步数计数：草地(0) 在原野与洞窟均计步；房屋/水不计
        // 洞窟地面在 CH2 同样用 0 表示可走地面，故统一按 0 计步
        if (destTileId === 0) {
          this.steps++;
          this.checkRandomEncounter();
        }
        this.checkAutoHealTile();
      }.bind(this));
    },

    doMoveTween: function (nx, ny, onComplete) {
      this.isMoving = true;
      this.gridX = nx;
      this.gridY = ny;
      var tx = this.mapOffsetX + nx * TILE + TILE / 2;
      var ty = this.mapOffsetY + ny * TILE + TILE / 2;
      var self = this;
      this.tweens.add({
        targets: [this.hero, this.heroShadow],
        x: tx, y: ty,
        duration: 110,
        ease: 'Linear',
        onComplete: function () {
          self.isMoving = false;
          if (onComplete) { onComplete(); }
          self.updateHud();
        }
      });
    },

    shakeHero: function () {
      if (!this.hero) { return; }
      var ox = this.hero.x;
      this.tweens.add({ targets: this.hero, x: ox + 4, duration: 40, yoyo: true, repeat: 1, ease: 'Linear', onComplete: function () { this.hero.x = ox; }.bind(this) });
    },

    checkAutoHealTile: function () {
      // 可扩展：特定 tile 自动回血等，此处保留
    },

    // 随机遇敌（草地/洞窟步数计数）
    checkRandomEncounter: function () {
      if (this.state !== 'field') { return; }
      if (saveData.bossDefeated[this.curMapId] && this.steps < 2) { return; }
      // 步数>=3 后概率随步数递增，避免原地刷
      if (this.steps < 3) { return; }
      var p = 0.16 + (this.steps - 3) * 0.04;
      if (p > 0.55) { p = 0.55; }
      if (Math.random() < p) {
        this.steps = 0;
        this.startBattle(false);
      }
    },

    // 回合战斗（同一 scene 状态机 field ↔ battle）
    // 若需拆 Scene，可将本方法+ battle 状态迁至 BattleScene，本 Scene 仅负责 field
    startBattle: function (isBoss) {
      this.state = 'battle';
      Sfx.play('encounter');
      Sfx.stopBgm();
      var pool = this.curMapId === 0 ? ENEMIES_CH1 : ENEMIES_CH2;
      var def = null;
      var isBossBattle = !!isBoss;
      if (isBossBattle) {
        def = BOSSES[this.curMapId];
      } else {
        def = pool[Math.floor(Math.random() * pool.length)];
      }
      this.battle = {
        def: def,
        enemyHp: def.hp,
        maxHp: def.hp,
        turn: 'player',
        defending: false,
        eDefending: false,
        menuIdx: 0,
        isBoss: isBossBattle,
        multiLeft: isBossBattle ? (def.multi || 2) : 1,
        log: isBossBattle ? '遭遇BOSS ' + def.name + '！' : '遭遇 ' + def.name + '！'
      };
      // UI
      this.battleRoot.setVisible(true);
      this.helpText.setVisible(false);
      this.battleTitle.setText(isBossBattle ? '★ BOSS战 ★ ' + def.name : '遭遇战！ ' + def.name);
      try { this.enemyImage.setTexture(def.tex); } catch (e) { this.enemyImage.setTexture('enemy_slime'); }
      // BGM 切战斗
      var seq = isBossBattle ? [98, 110, 130, 146] : [220, 260, 294, 330];
      var idx = 0;
      var self = this;
      Sfx.stopBgm();
      Sfx.bgmTimer = this.time.addEvent({
        delay: isBossBattle ? 300 : 360,
        loop: true,
        callback: function () { try { Sfx.tone(seq[idx % seq.length], 0.14, 'sawtooth', 0.06); idx++; } catch (e) {} }
      });
      this.refreshBattleUi();
    },

    refreshBattleUi: function () {
      if (!this.battle) { return; }
      var b = this.battle;
      var d = b.def;
      this.enemyHpText.setText(d.name + '  HP ' + Math.max(0, b.enemyHp) + ' / ' + b.maxHp);
      this.playerBattleText.setText('勇者  Lv.' + this.p.lv + '\nHP ' + this.p.hp + '/' + this.p.maxHp + '\nMP ' + this.p.mp + '/' + this.p.maxMp + '\nATK ' + this.p.atk + ' DEF ' + this.p.def + '\n药草 x' + this.p.herb);
      for (var i = 0; i < this.menuTexts.length; i++) {
        var isCur = i === b.menuIdx;
        this.menuTexts[i].setText((isCur ? '▶ ' : '  ') + this.menuOpts[i]);
        this.menuTexts[i].setColor(isCur ? '#ffd54f' : '#ffffff');
      }
      this.battleLog.setText(b.log);
      this.updateHud();
    },

    // 敌AI：简单随机+血低防御
    enemyDecide: function () {
      var b = this.battle;
      if (!b) { return 'attack'; }
      if (b.enemyHp < b.maxHp * 0.32 && Math.random() < 0.48) { return 'defend'; }
      return Math.random() < 0.78 ? 'attack' : 'defend';
    },

    // 伤害计算
    calcDamage: function (atk, def, defending, variance) {
      var base = atk - def * 0.5;
      if (base < 1) { base = 1; }
      if (defending) { base *= 0.5; }
      var v = variance != null ? variance : (Math.random() * 4 - 2);
      var dmg = Math.floor(base + v);
      if (dmg < 1) { dmg = 1; }
      return dmg;
    },

    // 池化：取一个 fx
    spawnFx: function (x, y, tex) {
      var fx = this.fxPool.getFirstDead(false);
      if (!fx) {
        fx = this.add.image(x, y, tex || 'fx_hit').setDepth(60);
        this.fxPool.add(fx);
      }
      fx.setTexture(tex || 'fx_hit');
      fx.setPosition(x, y).setVisible(true).setActive(true).setAlpha(1).setScale(1);
      this.tweens.add({
        targets: fx, alpha: 0, scale: 1.6, duration: 260, ease: 'Cubic.easeOut',
        onComplete: function () { fx.setVisible(false).setActive(false); }
      });
    },
    spawnDmg: function (x, y, text, color) {
      var t = null;
      for (var i = 0; i < this.dmgPool.length; i++) { if (!this.dmgPool[i].visible) { t = this.dmgPool[i]; break; } }
      if (!t) { t = this.add.text(x, y, text, { fontSize: '14px', color: color || '#ff3b30', stroke: '#000', strokeThickness: 3 }).setDepth(70); this.dmgPool.push(t); }
      t.setText(text).setPosition(x, y).setColor(color || '#ff3b30').setVisible(true).setAlpha(1);
      this.tweens.add({ targets: t, y: y - 28, alpha: 0, duration: 520, ease: 'Cubic.easeOut', onComplete: function () { t.setVisible(false); } });
    },

    // 玩家指令执行
    playerAction: function (idx) {
      if (!this.battle || this.battle.turn !== 'player') { return; }
      var b = this.battle;
      var d = b.def;
      if (idx === 0) {
        // 攻击
        Sfx.play('attack');
        var dmg = this.calcDamage(this.p.atk, d.def, b.eDefending, null);
        if (b.eDefending) { b.eDefending = false; }
        b.enemyHp -= dmg;
        b.log = '勇者攻击！对' + d.name + '造成 ' + dmg + ' 点伤害！';
        this.spawnFx(this.enemyImage.x, this.enemyImage.y - 10, 'fx_hit');
        this.spawnDmg(this.enemyImage.x + 18, this.enemyImage.y - 18, '-' + dmg, '#ff3b30');
        this.refreshBattleUi();
        if (b.enemyHp <= 0) { this.handleVictory(); return; }
        this.nextTurn();
      } else if (idx === 1) {
        // 防御
        b.defending = true;
        b.log = '勇者摆出防御姿态！下次受击减半。';
        this.refreshBattleUi();
        this.nextTurn();
      } else if (idx === 2) {
        // 魔法 火球 4MP
        if (this.p.mp < 4) {
          b.log = 'MP不足！需要 4 MP。';
          this.refreshBattleUi();
          return;
        }
        this.p.mp -= 4;
        Sfx.play('magic');
        var mdmg = Math.floor(this.p.atk * 1.65 + 5 + (Math.random() * 6 - 3));
        // 魔法无视部分防御（仅 30% 防御生效）
        var effDef = Math.floor(d.def * 0.3);
        mdmg = Math.max(1, mdmg - Math.floor(effDef * 0.5));
        if (b.eDefending) { mdmg = Math.floor(mdmg * 0.65); b.eDefending = false; }
        b.enemyHp -= mdmg;
        b.log = '勇者施放火球！对' + d.name + '造成 ' + mdmg + ' 点魔法伤害！';
        this.spawnFx(this.enemyImage.x, this.enemyImage.y - 8, 'fx_fire');
        this.spawnDmg(this.enemyImage.x + 18, this.enemyImage.y - 18, '-' + mdmg, '#ff6f00');
        this.refreshBattleUi();
        if (b.enemyHp <= 0) { this.handleVictory(); return; }
        this.nextTurn();
      } else if (idx === 3) {
        // 道具 药草 回 22 HP（池化道具用计数）
        if (this.p.herb <= 0) {
          b.log = '药草用完了！击败敌人可获得。';
          this.refreshBattleUi();
          return;
        }
        this.p.herb--;
        var heal = 22;
        this.p.hp += heal;
        if (this.p.hp > this.p.maxHp) { this.p.hp = this.p.maxHp; }
        Sfx.play('heal');
        b.log = '使用药草，恢复 ' + heal + ' HP！';
        this.spawnDmg(160, 270, '+' + heal, '#4caf50');
        this.refreshBattleUi();
        this.nextTurn();
      }
    },

    nextTurn: function () {
      var self = this;
      // 延迟后敌方行动，保持回合制节奏
      this.battle.turn = 'enemy';
      this.refreshBattleUi();
      this.time.delayedCall(620, function () { self.enemyAction(); });
    },

    enemyAction: function () {
      if (!this.battle || this.state !== 'battle') { return; }
      var b = this.battle;
      var d = b.def;
      // 多动（Boss 每回合 2 动）：用 multiLeft 计数
      var loops = b.isBoss ? b.multiLeft : 1;
      // 若普通敌仅 1 动；Boss 2 动连续执行
      var self = this;
      function oneAct() {
        if (self.p.hp <= 0 || b.enemyHp <= 0) { return; }
        var act = self.enemyDecide();
        if (act === 'defend') {
          b.eDefending = true;
          b.log = d.name + '摆出防御！';
          self.refreshBattleUi();
        } else {
          // 攻击
          Sfx.play('attack');
          var dmg = self.calcDamage(d.atk, self.p.def, b.defending, null);
          if (b.defending) { b.defending = false; }
          self.p.hp -= dmg;
          if (self.p.hp < 0) { self.p.hp = 0; }
          b.log = d.name + '攻击！勇者受到 ' + dmg + ' 点伤害！';
          self.spawnFx(140, 270, 'fx_hit');
          self.spawnDmg(140, 250, '-' + dmg, '#ff3b30');
          Sfx.play('hurt');
          self.refreshBattleUi();
          if (self.p.hp <= 0) {
            self.handleDefeat();
            return;
          }
        }
      }
      // 执行 1~2 动
      oneAct();
      if (b.isBoss && loops > 1 && this.p.hp > 0 && b.enemyHp > 0) {
        // 第二动延迟
        this.time.delayedCall(420, function () {
          if (self.state !== 'battle') { return; }
          oneAct();
          if (self.p.hp <= 0) { return; }
          // 回合结束，回玩家
          b.multiLeft = d.multi || 2;
          if (self.battle) { self.battle.turn = 'player'; self.refreshBattleUi(); }
        });
        return;
      }
      if (b.isBoss) { b.multiLeft = d.multi || 2; }
      if (this.p.hp > 0) {
        b.turn = 'player';
        this.refreshBattleUi();
      }
    },

    handleVictory: function () {
      var b = this.battle;
      var d = b.def;
      var isBoss = b.isBoss;
      Sfx.play('victory');
      // 奖励
      var expGain = d.exp;
      var goldGain = d.gold;
      // Boss 额外掉药草
      var herbGain = isBoss ? 2 : (Math.random() < 0.35 ? 1 : 0);
      this.p.exp += expGain;
      this.p.gold += goldGain;
      this.p.herb += herbGain;
      var msg = '胜利！获得 EXP ' + expGain + '  GOLD ' + goldGain + (herbGain ? ' 药草 x' + herbGain : '');
      b.log = msg;
      this.refreshBattleUi();
      var self = this;
      // 升级判定（数据驱动成长表）
      var leveled = false;
      while (self.p.lv < GROWTH.length && self.p.exp >= GROWTH[self.p.lv].need) {
        self.p.lv++;
        var g = GROWTH[self.p.lv - 1];
        self.p.maxHp = g.maxHp;
        self.p.maxMp = g.maxMp;
        self.p.atk = g.atk;
        self.p.def = g.def;
        // 升级回满
        self.p.hp = self.p.maxHp;
        self.p.mp = self.p.maxMp;
        leveled = true;
        Sfx.play('levelup');
        b.log += '  ★ 升至 Lv.' + self.p.lv + '！';
      }
      this.refreshBattleUi();
      this.time.delayedCall(1200, function () {
        self.endBattle();
        self.showMsg(msg + (leveled ? '  升级了！' : ''), 2000);
        if (isBoss) {
          saveData.bossDefeated[self.curMapId] = true;
          saveData.unlockedChapter = Math.max(saveData.unlockedChapter, self.curMapId + 2);
          if (self.curMapId === 0) {
            self.showMsg('★ 第一章通关！史莱姆王被击败！向东穿过边界前往洞窟与城堡…', 3200);
            // 移除 Boss 视效
            if (self.bossSprite) { try { self.bossSprite.destroy(); } catch (e) {} self.bossSprite = null; }
          } else if (self.curMapId === 1) {
            // 通关结局（至少1结局）
            self.showEnding();
            return;
          }
          self.save();
        } else {
          self.save();
        }
        Sfx.startBgm(self, self.curMapId + 1);
      });
    },

    handleDefeat: function () {
      var self = this;
      this.state = 'gameover';
      this.battle.log = '勇者倒下了… 按 R 重生（保留等级，金币减半）';
      this.refreshBattleUi();
      Sfx.stopBgm();
      Sfx.play('hurt');
      this.p.gold = Math.floor(this.p.gold * 0.5);
      // 保留 HP 回半
      this.time.delayedCall(900, function () {
        self.showMsg('按 R 在村庄重生', 3000);
      });
    },

    showEnding: function () {
      var self = this;
      this.state = 'ending';
      this.battleRoot.setVisible(false);
      Sfx.stopBgm();
      Sfx.play('victory');
      setTimeout(function(){ Sfx.play('levelup'); }, 600);
      var overlay = this.add.rectangle(400, 225, 800, 450, 0x000000, 0.88).setDepth(200);
      var t1 = this.add.text(400, 150, '★ 通关 ★', { fontSize: '32px', color: '#ffd54f', stroke: '#000', strokeThickness: 6 }).setOrigin(0.5).setDepth(201);
      var t2 = this.add.text(400, 210, '暗黑龙王被击败！世界恢复和平。\n勇者 Lv.' + this.p.lv + '  GOLD ' + this.p.gold + '\n\n按 R 重新开始冒险', { fontSize: '14px', color: '#ffffff', align: 'center', lineSpacing: 6 }).setOrigin(0.5).setDepth(201);
      this._endingNodes = [overlay, t1, t2];
      this.save();
      // 存档标记通关
      saveData.unlockedChapter = 2;
    },

    endBattle: function () {
      this.battleRoot.setVisible(false);
      this.helpText.setVisible(true);
      this.battle = null;
      this.state = 'field';
      this.steps = 0;
      this.updateHud();
    },

    // 重生/重开
    respawn: function () {
      // 清理结局覆盖
      if (this._endingNodes) { for (var i = 0; i < this._endingNodes.length; i++) { try { this._endingNodes[i].destroy(); } catch (e) {} } this._endingNodes = null; }
      if (this.battleRoot.visible) { this.battleRoot.setVisible(false); }
      this.battle = null;
      this.state = 'field';
      // HP 回满
      this.p.hp = this.p.maxHp;
      if (this.p.mp < Math.floor(this.p.maxMp * 0.5)) { this.p.mp = Math.floor(this.p.maxMp * 0.5); }
      this.loadMap(this.curMapId, MAPS[this.curMapId].spawn);
      this.showMsg('在 ' + MAPS[this.curMapId].name + ' 重生', 1800);
      this.save();
    },

    update: function () {
      // victory/ending/gameover 时仅处理 R 重开
      if (this.state === 'ending' || this.state === 'gameover') {
        if (Phaser.Input.Keyboard.JustDown(this.keys.R)) {
          if (this.state === 'ending') {
            // 通关后重置 Boss 与存档？保留等级但重置 Boss 以便重玩
            saveData.bossDefeated = [false, false];
            saveData.chapter = 1;
            this.curMapId = 0;
            this.p.hp = this.p.maxHp; this.p.mp = this.p.maxMp;
            this.respawn();
            this.loadMap(0, null);
          } else {
            this.respawn();
          }
        }
        return;
      }
      if (this.state !== 'field' && this.state !== 'battle') { return; }
      if (this.state === 'battle') {
        // 战斗菜单导航（方向键步进）
        if (!this.battle || this.battle.turn !== 'player') { return; }
        if (Phaser.Input.Keyboard.JustDown(this.keys.UP) || Phaser.Input.Keyboard.JustDown(this.keys.W)) {
          Sfx.play('select');
          this.battle.menuIdx = (this.battle.menuIdx + this.menuOpts.length - 1) % this.menuOpts.length;
          this.refreshBattleUi();
        } else if (Phaser.Input.Keyboard.JustDown(this.keys.DOWN) || Phaser.Input.Keyboard.JustDown(this.keys.S)) {
          Sfx.play('select');
          this.battle.menuIdx = (this.battle.menuIdx + 1) % this.menuOpts.length;
          this.refreshBattleUi();
        } else if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER)) {
          this.playerAction(this.battle.menuIdx);
        } else if (Phaser.Input.Keyboard.JustDown(this.keys.ESC)) {
          // 战斗中 ESC 不退出，仅提示
          this.battle.log = '战斗中无法逃跑！请选择指令。';
          this.refreshBattleUi();
        }
        return;
      }
      // field 状态：消息框优先按空格关闭
      if (this.msgBox.visible) {
        if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER)) {
          this.msgBox.setVisible(false); this.msgText.setVisible(false);
          if (this._msgTimer) { try { this._msgTimer.remove(false); } catch (e) {} }
        }
        return;
      }
      // 网格移动（平滑插值 tween，撞墙阻挡在 tryMove 内）
      if (this.isMoving) { return; }
      var dx = 0, dy = 0;
      if (Phaser.Input.Keyboard.JustDown(this.keys.LEFT) || Phaser.Input.Keyboard.JustDown(this.keys.A)) { dx = -1; }
      else if (Phaser.Input.Keyboard.JustDown(this.keys.RIGHT) || Phaser.Input.Keyboard.JustDown(this.keys.D)) { dx = 1; }
      else if (Phaser.Input.Keyboard.JustDown(this.keys.UP) || Phaser.Input.Keyboard.JustDown(this.keys.W)) { dy = -1; }
      else if (Phaser.Input.Keyboard.JustDown(this.keys.DOWN) || Phaser.Input.Keyboard.JustDown(this.keys.S)) { dy = 1; }
      if (dx !== 0 || dy !== 0) { this.tryMove(dx, dy); return; }
      // 空格对话：面前一格 NPC
      if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER)) {
        // 检测四方向 NPC
        var dirs = [{x:0,y:-1},{x:0,y:1},{x:-1,y:0},{x:1,y:0}];
        for (var di = 0; di < dirs.length; di++) {
          var nx = this.gridX + dirs[di].x, ny = this.gridY + dirs[di].y;
          for (var ni = 0; ni < this.npcSprites.length; ni++) {
            if (this.npcSprites[ni]._npc.x === nx && this.npcSprites[ni]._npc.y === ny) {
              this.showMsg(this.npcSprites[ni]._npc.name + '：' + this.npcSprites[ni]._npc.msg, 2800);
              return;
            }
          }
          // 同格 NPC 也可对话
          for (var nj = 0; nj < this.npcSprites.length; nj++) {
            if (this.npcSprites[nj]._npc.x === this.gridX && this.npcSprites[nj]._npc.y === this.gridY) {
              this.showMsg(this.npcSprites[nj]._npc.name + '：' + this.npcSprites[nj]._npc.msg, 2800);
              return;
            }
          }
        }
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.ESC)) {
        this.showMsg('菜单：R 重生  方向键移动  空格对话/确认', 2000);
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.R)) {
        this.respawn();
      }
    }
  });

  // ==========================================================================
  // 注册（id 必须 == 目录名 rpg-dq）
  // ==========================================================================
  var hostW = 800, hostH = 450;
  window.TRGames = window.TRGames || { register: function(){}, _r:{} };
  window.TRGames.register({
    id: 'rpg-dq',
    title: '勇者斗恶龙RPG',
    launch: function (host) {
      hostRef = host;
      var W = host.width || hostW;
      var H = host.height || hostH;
      if (host.loadState) {
        try {
          host.loadState().then(function (d) {
            if (d && typeof d === 'object') {
              if (typeof d.chapter === 'number') { saveData.chapter = d.chapter; }
              if (typeof d.level === 'number') { saveData.level = d.level; }
              if (typeof d.exp === 'number') { saveData.exp = d.exp; }
              if (typeof d.gold === 'number') { saveData.gold = d.gold; }
              if (typeof d.unlockedChapter === 'number') { saveData.unlockedChapter = d.unlockedChapter; }
              if (Array.isArray(d.bossDefeated)) { saveData.bossDefeated = d.bossDefeated.slice(0,2); while(saveData.bossDefeated.length<2){saveData.bossDefeated.push(false);} }
              if (typeof d.herb === 'number') { saveData.herb = d.herb; }
            }
          }, function(){});
        } catch (e) {}
      } else {
        try { var loc = JSON.parse(localStorage.getItem(SAVE_KEY)||'null'); if(loc){ if(typeof loc.chapter==='number') saveData.chapter=loc.chapter; if(typeof loc.level==='number') saveData.level=loc.level; if(typeof loc.exp==='number') saveData.exp=loc.exp; if(typeof loc.gold==='number') saveData.gold=loc.gold; if(typeof loc.unlockedChapter==='number') saveData.unlockedChapter=loc.unlockedChapter; if(Array.isArray(loc.bossDefeated)) saveData.bossDefeated=loc.bossDefeated.slice(0,2); if(typeof loc.herb==='number') saveData.herb=loc.herb; } } catch(e){}
      }
      var game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host.container,
        width: W,
        height: H,
        backgroundColor: '#2e3d2a',
        physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
scene: [MainScene]
      });
      sceneRef = null;
      var tryBind = function(){ try{ var s=game.scene.getScene('Main'); if(s) sceneRef=s; }catch(e){} };
      setTimeout(tryBind, 400);
      game.events.on('ready', tryBind);
      window.__trgame = {
        game: game,
        getState: getState,
        getScene: function(){ return sceneRef; },
        getSave: function(){ return JSON.parse(JSON.stringify(saveData)); }
      };
      return game;
    }
  });
})();
