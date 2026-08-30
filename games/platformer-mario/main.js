// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改：
//   视觉：
//     this.add.graphics()+generateTexture('ground'/'brick'/'question'/'question_used'/
//       'pole'/'flag'/'player_big'/'player_small'/'enemy'/'coin'/'platform_move'/
//       'bg_far'/'bg_near')  →  换成  this.load.image('ground','assets/ground.png')
//       等；本文件所有“生成纹理”段落已用中文注释标出替换点。
//     胶囊角色 this.add.graphics 圆角矩形  → 换成 spritesheet 帧动画：
//       this.load.spritesheet('mario', 'assets/mario.png', {frameWidth:16,frameHeight:32})
//     圆敌 this.add.graphics 圆形         → 换成 this.load.image('enemy','assets/enemy.png'/'goomba.png')
//     砖块纹理 this.add.graphics 线条     → 换成 this.load.image('brick','assets/brick.png')
//     2层视差色块 this.add.tileSprite     → 换成 this.load.image('bg_far'/'bg_near','assets/bg_*.png')
//   音频：
//     Sfx.play('jump'/'coin'/'bump'/'stomp'/'hurt'/'clear'/'die'/'bgm') 内部
//       WebAudio oscillator+gain  → 换成 this.load.audio('jump','assets/jump.wav')+this.sound.play
//       文件顶部 Sfx 块注释已写替换写法。
//   关卡：
//     字符串数组 LEVEL1_MAP / LEVEL2_MAP   → 换成 Tiled JSON：this.load.tilemapTiledJSON('level1','assets/level1.json')
// =============================================================================
(function () {
  'use strict';

  // ==========================================================================
  // 顶部可调参数（带单位）—— 中文注释 + 英文游戏内文本
  // ==========================================================================
  /** 单格边长 px */
  var TILE = 32;
  /** 重力 px/s² */
  var GRAVITY = 1850;
  /** 地面最大行走速度 px/s */
  var MOVE_MAX = 220;
  /** 地面加速 px/s² */
  var MOVE_ACCEL = 2200;
  /** 松键/反向减速 px/s² */
  var MOVE_DECEL = 2600;
  /** 空中加速系数（0~1） */
  var AIR_FACTOR = 0.55;
  /** 起跳初速度 px/s（负值向上） */
  var JUMP_VEL = 540;
  /** 可变跳高截断系数（松键时 vy *= 该值，0~1） */
  var JUMP_CUT = 0.42;
  /** 土狼时间 ms（离开地面后仍可起跳的宽容窗口，~100ms） */
  var COYOTE_MS = 100;
  /** 跳跃缓冲 ms（落地前提前按键的宽容窗口，~120ms） */
  var BUFFER_MS = 120;
  /** 终端下落速度 px/s */
  var TERMINAL_VY = 900;
  /** 巡逻敌速度 px/s */
  var ENEMY_SPEED = 72;
  /** 移动平台速度 px/s */
  var MOVER_SPEED = 70;
  /** 移动平台行程 px */
  var MOVER_RANGE = 96;
  /** 受伤无敌时长 ms */
  var HURT_INV_MS = 1600;
  /** 踩敌反弹速度 px/s */
  var STOMP_BOUNCE = 360;
  /** 金币重力或上抛不需；金币为触发式 tween */
  /** 相机跟随平滑 0~1 */
  var CAM_LERP = 0.12;

  // ==========================================================================
  // 关卡字符串地图
  // 画地图教学：
  //   每个关卡是一个字符串数组，1字符=1格(TILE)，行数=地图高度，列数=地图宽度
  //   字符含义：
  //     ' ' 空气
  //     '#' 地面/实心土（静态 solid）
  //     'B' 砖块（可顶，有 bump 动画）
  //     '?' 问号块（可顶出 1 金币，顶后变空块）
  //     '|' 旗杆（竖直多格，触碰即过关）
  //     'M' 移动平台（悬空，水平往复）
  //     'E' 巡逻敌生成点（该格为空气，敌在该格出生）
  //     'o' 悬空金币（可选装饰，触碰直接收集）
  //     'S' 玩家起点（可选，不写则用默认起點 2TILE 处）
  //   编辑时保持每行等长（用空格补齐），旗杆建议放在最右侧连续多行。
  //   坑：在地面行留空格即为坑，掉坑 y>worldH 即死亡。
  //   将来换 Tiled：把本数组换成 this.load.tilemapTiledJSON + 图块集。
  // ==========================================================================
  var LEVEL1_MAP = [
    '                                                            ',
    '                                                            ',
    '                                                            ',
    '                                                            ',
    '                                                            ',
    '                                                            ',
    '                                                            ',
    '         o                                                  ',
    '        B?B                                                 ',
    '                                                            ',
    '              E      E                                      ',
    '     ?                                                    | ',
    '  #?#B#                                                  | |',
    '  ######   ######   ######   ######   ######   ######   |#|',
    '##########################################################|#'
  ];

  var LEVEL2_MAP = [
    '                                                                  ',
    '                                                                  ',
    '                                                                  ',
    '                                                                  ',
    '     o    o                                                       ',
    '    B?B  B?B                          E                            ',
    '                                                                  ',
    '                                                                  ',
    '        M         M               E         M                      ',
    '                                                                  ',
    '   E           #######      #######           #######             ',
    '  ###?###                                        ?             |  ',
    '            M         #######     E    #######                | | ',
    '  ######   ###   ######       ######   ######   ######   ######|#',
    '############ ####  ############      ############################|#'
  ];

  var LEVELS = [LEVEL1_MAP, LEVEL2_MAP];

  // ==========================================================================
  // 存档与状态缝
  // ==========================================================================
  var hostRef = null;
  var sceneRef = null;
  var saveData = { unlockedLevel: 1, bestCoins: [0, 0] };
  function getState() {
    var sc = sceneRef;
    if (!sc) { return { scene: 'title', level: 1, coins: 0, hp: 2, x: 0, y: 0, dead: false }; }
    return {
      scene: sc.gameState || 'title',
      level: sc.curLevel || 1,
      coins: sc.coins || 0,
      hp: sc.hp || 0,
      x: sc.player ? Math.round(sc.player.x) : 0,
      y: sc.player ? Math.round(sc.player.y) : 0,
      dead: !!sc.isDead
    };
  }

  // ==========================================================================
  // Sfx — WebAudio oscillator+gain 封装
  // 将来换 this.load.audio 写法：
  //   preload() { this.load.audio('jump','assets/jump.wav'); ... }
  //   play(name){ this.sound.play(name); }
  // 现用 WebAudio：首输入时 ctx.resume()，try/catch 静默降级。
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
        if (slideTo) {
          o.frequency.linearRampToValueAtTime(slideTo, ctx.currentTime + dur);
        }
        g.gain.value = vol != null ? vol : 0.18;
        // 包络：起音短，指数衰减，避免爆音
        g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + dur);
      } catch (e) { /* 静默降级 */ }
    },
    play: function (name) {
      try {
        if (name === 'jump') { Sfx.tone(520, 0.12, 'square', 0.18, 880); }
        else if (name === 'coin') { Sfx.tone(880, 0.12, 'sine', 0.22, 1318); setTimeout(function(){ Sfx.tone(1318,0.14,'sine',0.18); }, 90); }
        else if (name === 'bump') { Sfx.tone(180, 0.08, 'square', 0.16, 120); }
        else if (name === 'stomp') { Sfx.tone(300, 0.10, 'square', 0.2, 150); }
        else if (name === 'hurt') { Sfx.tone(200, 0.28, 'sawtooth', 0.2, 90); }
        else if (name === 'die') { Sfx.tone(320, 0.4, 'sawtooth', 0.22, 70); }
        else if (name === 'clear') { Sfx.tone(523,0.16,'sine',0.2); setTimeout(function(){Sfx.tone(659,0.16,'sine',0.2);},140); setTimeout(function(){Sfx.tone(784,0.22,'sine',0.2);},280); }
      } catch (e) {}
    },
    startBgm: function (scene) {
      try {
        Sfx.stopBgm();
        var ctx = Sfx.ensure();
        if (!ctx) { return; }
        // 简易 BGM：每 800ms 播一个低频脉冲，模拟进行曲节奏；暂停/切关时 clear
        var notes = [196, 247, 294, 247];
        var idx = 0;
        Sfx.bgmTimer = scene.time.addEvent({
          delay: 420,
          loop: true,
          callback: function () {
            try {
              var f = notes[idx % notes.length];
              Sfx.tone(f, 0.18, 'triangle', 0.07);
              idx++;
            } catch (e) {}
          }
        });
      } catch (e) {}
    },
    stopBgm: function () {
      try { if (Sfx.bgmTimer) { Sfx.bgmTimer.remove(false); Sfx.bgmTimer = null; } } catch (e) {}
    }
  };

  // ==========================================================================
  // 纹理生成（纯几何体，零外部图片）
  // 每处中文注释写将来换 this.load.image 的改法：见文件头【资产替换清单】
  // ==========================================================================
  function buildTextures(scene) {
    function rm(k) { if (scene.textures.exists(k)) { scene.textures.remove(k); } }
    var g;
    // 地面 # — 深棕底 + 浅线条纹理
    // 将来换：this.load.image('ground','assets/ground.png')
    rm('ground');
    g = scene.add.graphics();
    g.fillStyle(0x8d6b3a, 1); g.fillRect(0, 0, TILE, TILE);
    g.fillStyle(0x7a5a2e, 1); g.fillRect(0, 0, TILE, 4); g.fillRect(0, TILE - 4, TILE, 4);
    g.lineStyle(1, 0x5a401e, 0.9); g.strokeRect(0, 0, TILE, TILE);
    // 砖缝
    g.lineStyle(1, 0x5a401e, 0.5); g.lineBetween(0, 8, TILE, 8); g.lineBetween(0, 16, TILE, 16); g.lineBetween(0, 24, TILE, 24);
    g.generateTexture('ground', TILE, TILE); g.destroy();

    // 砖块 B — 红砖 + 分格
    // 将来换：this.load.image('brick','assets/brick.png')
    rm('brick');
    g = scene.add.graphics();
    g.fillStyle(0xc24a2e, 1); g.fillRect(0, 0, TILE, TILE);
    g.fillStyle(0xd96a4a, 1); g.fillRect(0, 0, TILE, 6);
    g.lineStyle(2, 0x7a2b18, 1); g.strokeRect(0, 0, TILE, TILE);
    g.lineStyle(1, 0x7a2b18, 0.8); g.lineBetween(0, TILE / 2, TILE, TILE / 2); g.lineBetween(TILE / 2, 0, TILE / 2, TILE / 2); g.lineBetween(TILE / 4, TILE / 2, TILE / 4, TILE); g.lineBetween(TILE * 0.75, TILE / 2, TILE * 0.75, TILE);
    g.generateTexture('brick', TILE, TILE); g.destroy();

    // 问号块 ? — 黄底 + 问号
    // 将来换：this.load.image('question','assets/question.png')
    rm('question');
    g = scene.add.graphics();
    g.fillStyle(0xf2c12c, 1); g.fillRect(0, 0, TILE, TILE);
    g.fillStyle(0xf7d86a, 1); g.fillRect(0, 0, TILE, 6); g.fillRect(0, 0, 6, TILE);
    g.lineStyle(2, 0x7a5a12, 1); g.strokeRect(0, 0, TILE, TILE);
    g.fillStyle(0x5a4010, 1);
    // 简易问号：用圆+矩形拼
    g.fillCircle(TILE / 2, 11, 5); g.fillStyle(0xf2c12c, 1); g.fillCircle(TILE / 2, 11, 2.2);
    g.fillStyle(0x5a4010, 1); g.fillRect(TILE / 2 - 2, 17, 4, 6); g.fillRect(TILE / 2 - 2, 25, 4, 4);
    g.generateTexture('question', TILE, TILE); g.destroy();

    // 问号已用 — 深黄变棕
    // 将来换：this.load.image('question_used','assets/question_used.png')
    rm('question_used');
    g = scene.add.graphics();
    g.fillStyle(0x9a7a1e, 1); g.fillRect(0, 0, TILE, TILE);
    g.lineStyle(2, 0x5a4010, 1); g.strokeRect(0, 0, TILE, TILE);
    g.generateTexture('question_used', TILE, TILE); g.destroy();

    // 旗杆 | — 窄白杆
    // 将来换：this.load.image('pole','assets/pole.png')
    rm('pole');
    g = scene.add.graphics();
    g.fillStyle(0xe8e8e8, 1); g.fillRect(0, 0, 8, TILE);
    g.fillStyle(0xc8c8c8, 1); g.fillRect(4, 0, 4, TILE);
    g.generateTexture('pole', 8, TILE); g.destroy();

    // 旗子
    // 将来换：this.load.image('flag','assets/flag.png')
    rm('flag');
    g = scene.add.graphics();
    g.fillStyle(0x2ecc71, 1); g.fillTriangle(0, 0, 20, 8, 0, 16);
    g.generateTexture('flag', 20, 16); g.destroy();

    // 移动平台 — 蓝灰悬空板 + 高光
    // 将来换：this.load.image('platform_move','assets/platform_move.png')
    rm('platform_move');
    g = scene.add.graphics();
    g.fillStyle(0x4a6fa5, 1); g.fillRoundedRect(0, 0, 96, 16, 4);
    g.fillStyle(0x6a8fc2, 1); g.fillRoundedRect(0, 0, 96, 5, 4);
    g.lineStyle(1, 0x2e4a6b, 1); g.strokeRoundedRect(0, 0, 96, 16, 4);
    g.generateTexture('platform_move', 96, 16); g.destroy();

    // 胶囊角色（大）— 圆角矩形胶囊 18x32 红帽+蓝裤
    // 将来换：this.load.spritesheet('mario','assets/mario.png',{frameWidth:16,frameHeight:32})
    rm('player_big');
    g = scene.add.graphics();
    g.fillStyle(0xe74c3c, 1); g.fillRoundedRect(0, 0, 18, 14, 6); // 帽/头
    g.fillStyle(0xf5d6b8, 1); g.fillRoundedRect(2, 8, 14, 10, 3); // 脸
    g.fillStyle(0x2e86de, 1); g.fillRoundedRect(1, 16, 16, 16, 5); // 身
    g.fillStyle(0xf2c12c, 1); g.fillCircle(5, 20, 2); g.fillCircle(13, 20, 2); // 扣子
    g.generateTexture('player_big', 18, 32); g.destroy();

    // 胶囊角色（小）— 16x24
    // 将来换：同上小尺寸帧
    rm('player_small');
    g = scene.add.graphics();
    g.fillStyle(0xe74c3c, 1); g.fillRoundedRect(0, 0, 16, 10, 5);
    g.fillStyle(0xf5d6b8, 1); g.fillRoundedRect(2, 6, 12, 8, 2);
    g.fillStyle(0x2e86de, 1); g.fillRoundedRect(1, 13, 14, 11, 4);
    g.generateTexture('player_small', 16, 24); g.destroy();

    // 圆敌 — 棕圆+眼睛
    // 将来换：this.load.image('enemy','assets/enemy.png')
    rm('enemy');
    g = scene.add.graphics();
    g.fillStyle(0x8e6a3a, 1); g.fillCircle(12, 12, 11);
    g.fillStyle(0xf5e6c8, 1); g.fillCircle(7, 8, 3); g.fillCircle(17, 8, 3);
    g.fillStyle(0x222222, 1); g.fillCircle(7, 9, 1.6); g.fillCircle(17, 9, 1.6);
    g.fillStyle(0x5a3e1e, 1); g.fillRect(4, 16, 16, 4);
    g.generateTexture('enemy', 24, 24); g.destroy();

    // 踩扁敌 — 扁平
    rm('enemy_flat');
    g = scene.add.graphics();
    g.fillStyle(0x8e6a3a, 1); g.fillRoundedRect(0, 8, 24, 10, 4);
    g.fillStyle(0x222222, 1); g.lineStyle(1, 0x222222, 1); g.strokeLineShape(new Phaser.Geom.Line(4, 13, 20, 13));
    g.generateTexture('enemy_flat', 24, 18); g.destroy();

    // 金币 — 金黄圆 + 高光
    // 将来换：this.load.image('coin','assets/coin.png')
    rm('coin');
    g = scene.add.graphics();
    g.fillStyle(0xf2c12c, 1); g.fillCircle(8, 8, 7);
    g.fillStyle(0xf7e08a, 1); g.fillCircle(8, 8, 4);
    g.fillStyle(0xfff7b0, 1); g.fillCircle(6, 6, 1.6);
    g.lineStyle(1, 0x7a5a12, 0.9); g.strokeCircle(8, 8, 7);
    g.generateTexture('coin', 16, 16); g.destroy();

    // 视差远景/近景小纹理（色块平铺）
    // 将来换：this.load.image('bg_far','assets/bg_far.png') 等
    rm('bg_far');
    g = scene.add.graphics();
    g.fillStyle(0x87c6e8, 1); g.fillRect(0, 0, 64, 64);
    g.fillStyle(0xa8dbf0, 1); g.fillCircle(14, 18, 10); g.fillCircle(40, 30, 14);
    g.generateTexture('bg_far', 64, 64); g.destroy();
    rm('bg_near');
    g = scene.add.graphics();
    g.fillStyle(0x6fb86a, 1); g.fillRect(0, 0, 64, 64);
    g.fillStyle(0x8fd48a, 1); g.fillRect(0, 0, 64, 10); g.fillRect(0, 22, 32, 6);
    g.generateTexture('bg_near', 64, 64); g.destroy();
  }

  // ==========================================================================
  // 主场景
  // ==========================================================================
  var MainScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function MainScene() { Phaser.Scene.call(this, { key: 'Main' }); },

    create: function () {
      sceneRef = this;
      buildTextures(this);

      // 背景色
      this.cameras.main.setBackgroundColor('#6ec6f5');

      // 视差：两层 tileSprite，scrollFactor=0，手写视差滚动
      // 将来换：this.load.image 后同样 tileSprite，仅纹理名改变
      this.bgFar = this.add.tileSprite(0, 0, 3000, 180, 'bg_far').setOrigin(0, 0).setScrollFactor(0).setDepth(-20);
      this.bgNear = this.add.tileSprite(0, 120, 3000, 100, 'bg_near').setOrigin(0, 0).setScrollFactor(0).setDepth(-10);
      this.bgFar.setAlpha(0.95);

      // 世界尺寸由关卡决定，临时先给大值，loadLevel 会 setBounds
      this.physics.world.setBounds(0, 0, 4000, 600);

      // 输入
      this.keys = this.input.keyboard.addKeys('W,A,S,D,LEFT,RIGHT,UP,DOWN,SPACE,SHIFT,R');
      this.keys.W2 = this.input.keyboard.addKey('W');
      this.keys.A2 = this.input.keyboard.addKey('A');

      // 状态
      this.curLevel = 1;
      this.coins = 0;
      this.coinsLevel = 0;
      this.hp = 2; // 2=大 1=小
      this.gameState = 'title'; // title | playing | inter | dead | win
      this.isDead = false;
      this.invUntil = 0;
      this.coyoteTimer = 0; // ms 剩余土狼
      this.bufferTimer = 0; // ms 剩余缓冲
      this.jumpHeld = false;
      this.hasJumpCut = false;
      this.worldW = 0;
      this.worldH = 0;

      // Groups
      this.solids = this.physics.add.staticGroup();
      this.bricks = []; // 记录 B/? 的 gameObject 以便顶撞动画
      this.movers = this.physics.add.group();
      this.enemies = this.physics.add.group();
      this.coinsGroup = this.physics.add.group();
      this.flagGroup = this.physics.add.staticGroup();
      this.particles = this.add.group ? this.add.group() : null;

      // HUD
      this.hudCoins = this.add.text(12, 10, 'COINS 0', { fontSize: '14px', color: '#ffffff', stroke: '#222', strokeThickness: 3 }).setScrollFactor(0).setDepth(100);
      this.hudLevel = this.add.text(12, 28, 'WORLD 1-1', { fontSize: '12px', color: '#ffffff', stroke: '#222', strokeThickness: 3 }).setScrollFactor(0).setDepth(100);
      this.hudHp = this.add.text(12, 46, 'SIZE BIG', { fontSize: '12px', color: '#ffffff', stroke: '#222', strokeThickness: 3 }).setScrollFactor(0).setDepth(100);
      this.centerText = this.add.text(0, 0, '', { fontSize: '22px', color: '#ffffff', stroke: '#222', strokeThickness: 5, align: 'center' }).setOrigin(0.5).setScrollFactor(0).setDepth(120).setVisible(false);

      // 标题
      this.titleText = this.add.text(0, 0, 'MARIO PLATFORMER\n\n[SPACE] START  [A/D] MOVE  [W/SPACE] JUMP\nHold jump = higher  |  Stomp enemies  |  Hit ? for coins\nReach the flag to clear!', { fontSize: '16px', color: '#ffffff', stroke: '#222', strokeThickness: 4, align: 'center' }).setOrigin(0.5).setScrollFactor(0).setDepth(110);
      this.updateTitlePos();

      // 玩家（先隐藏，loadLevel 时创建）
      this.player = null;

      // 读取存档
      var self = this;
      if (hostRef && hostRef.loadState) {
        try {
          hostRef.loadState().then(function (d) {
            if (d && typeof d === 'object') {
              if (d.unlockedLevel) { saveData.unlockedLevel = d.unlockedLevel; }
              if (Array.isArray(d.bestCoins)) { saveData.bestCoins = d.bestCoins.slice(0, 2); while (saveData.bestCoins.length < 2) { saveData.bestCoins.push(0); } }
            }
            self.updateTitlePos();
          }, function () {});
        } catch (e) {}
      }

      // 监听首次输入以 resume AudioContext（浏览器策略）
      this.input.once('pointerdown', function () { Sfx.ensure(); });
      this.input.keyboard.once('keydown', function () { Sfx.ensure(); });

      // 窗口尺寸变化时重排标题（host 固定，不跟踪 resize，仅兜底）
      this.scale.on('resize', function () { self.updateTitlePos(); });

      // 暴露 __trgame
      // 已在 launch 外层暴露，此处保持 sceneref 新鲜
    },

    updateTitlePos: function () {
      if (!this.titleText) { return; }
      var w = this.scale.width || 960;
      var h = this.scale.height || 540;
      this.titleText.setPosition(w / 2, h / 2 - 10);
      if (this.centerText) { this.centerText.setPosition(w / 2, h / 2); }
    },

    loadLevel: function (lvl) {
      var map = LEVELS[lvl - 1];
      if (!map) { map = LEVELS[0]; lvl = 1; }
      this.curLevel = lvl;
      // 清理旧关
      this.solids.clear(true, true);
      this.flagGroup.clear(true, true);
      this.movers.clear(true, true);
      this.enemies.clear(true, true);
      this.coinsGroup.clear(true, true);
      this.bricks.length = 0;

      var cols = map[0].length;
      var rows = map.length;
      this.worldW = cols * TILE;
      this.worldH = rows * TILE;
      this.physics.world.setBounds(0, 0, this.worldW, this.worldH);
      this.cameras.main.setBounds(0, 0, this.worldW, this.worldH);
      // 背景 tileSprite 宽度跟随世界
      if (this.bgFar) { this.bgFar.width = this.worldW; this.bgFar.tilePositionX = 0; }
      if (this.bgNear) { this.bgNear.width = this.worldW; this.bgNear.tilePositionX = 0; }

      var startX = TILE * 2 + 12;
      var startY = this.worldH - TILE * 3;
      var hasStart = false;

      for (var r = 0; r < rows; r++) {
        var row = map[r];
        for (var c = 0; c < row.length; c++) {
          var ch = row[c];
          var x = c * TILE + TILE / 2;
          var y = r * TILE + TILE / 2;
          if (ch === '#') {
            var g = this.solids.create(x, y, 'ground');
            g.setOrigin(0.5); g.refreshBody(); g.blockType = '#';
          } else if (ch === 'B') {
            var b = this.solids.create(x, y, 'brick');
            b.setOrigin(0.5); b.refreshBody(); b.blockType = 'B'; b.hasCoin = false; this.bricks.push(b);
          } else if (ch === '?') {
            var q = this.solids.create(x, y, 'question');
            q.setOrigin(0.5); q.refreshBody(); q.blockType = '?'; q.hasCoin = true; q.used = false; this.bricks.push(q);
          } else if (ch === '|') {
            var p = this.flagGroup.create(x, y, 'pole');
            p.setOrigin(0.5); p.refreshBody(); p.blockType = '|';
            // 旗杆顶部加旗子装饰（无碰撞）
            if (r > 0 && map[r - 1][c] !== '|') {
              this.add.image(x + 10, y - 8, 'flag').setDepth(5);
            }
          } else if (ch === 'M') {
            var m = this.physics.add.image(x, y, 'platform_move');
            m.setImmovable(true);
            m.body.allowGravity = false;
            m.body.setSize(96, 16);
            m.moverDir = 1;
            m.startX = x;
            m.startY = y;
            m.range = MOVER_RANGE;
            m.speed = MOVER_SPEED;
            m.setVelocityX(m.speed);
            this.movers.add(m);
          } else if (ch === 'E') {
            var e = this.physics.add.sprite(x, y - 6, 'enemy');
            e.setCollideWorldBounds(false);
            e.body.setSize(20, 20); e.body.setOffset(2, 4);
            e.patrolDir = (Math.random() < 0.5 ? -1 : 1);
            e.setVelocityX(e.patrolDir * ENEMY_SPEED);
            e.alive = true;
            e.body.allowGravity = true;
            this.enemies.add(e);
          } else if (ch === 'o') {
            var co = this.physics.add.sprite(x, y, 'coin');
            co.body.allowGravity = false;
            co.isFloating = true;
            // 浮动动画
            this.tweens.add({ targets: co, y: y - 6, duration: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
            this.coinsGroup.add(co);
          } else if (ch === 'S') {
            startX = x; startY = y; hasStart = true;
          }
        }
      }

      // 玩家：胶囊碰撞体（小/大两档）
      if (this.player) { try { this.player.destroy(); } catch (e) {} }
      var tex = this.hp > 1 ? 'player_big' : 'player_small';
      this.player = this.physics.add.sprite(startX, startY - 10, tex);
      this.player.setCollideWorldBounds(false);
      this.updatePlayerBody();
      this.player.setDepth(10);
      this.player.facing = 1;

      // 碰撞与重叠（全部参数顺序无关：回调内用 group.contains 判断）
      var self = this;
      // solid + player
      this.physics.add.collider(this.player, this.solids, function (a, b) {
        // 参数顺序无关：找出哪一个是 player，哪一个是砖
        var player = (a === self.player ? a : (b === self.player ? b : null));
        var block = (player === a ? b : a);
        if (!player || !block) { return; }
        // 仅当从下方顶撞时触发（player 向上运动且顶到砖底面）
        if (block.blockType === '?' || block.blockType === 'B') {
          // 判定：player 的上沿触顶；arcade 中 blocked.up 为真
          if (player.body.blocked.up || player.body.touching.up) {
            self.hitBlock(block);
          }
        }
      });
      // mover 平台：player 站立跟随
      this.physics.add.collider(this.player, this.movers);
      // 敌人与 solid 碰墙反向
      this.physics.add.collider(this.enemies, this.solids);
      this.physics.add.collider(this.enemies, this.movers);
      // 敌人与敌人互撞反向（可选）
      this.physics.add.collider(this.enemies, this.enemies);

      // 金币拾取 overlap（顺序无关）
      this.physics.add.overlap(this.player, this.coinsGroup, function (a, b) {
        var coin = self.coinsGroup.contains(a) ? a : (self.coinsGroup.contains(b) ? b : null);
        if (!coin) { return; }
        self.collectCoin(coin);
      });
      // 旗杆过关 overlap（顺序无关）
      this.physics.add.overlap(this.player, this.flagGroup, function (a, b) {
        var flag = self.flagGroup.contains(a) ? a : (self.flagGroup.contains(b) ? b : null);
        if (!flag || self.gameState !== 'playing') { return; }
        self.levelClear();
      });
      // 踩敌/受伤 overlap（顺序无关，必须用 contains 判断敌我）
      this.physics.add.overlap(this.player, this.enemies, function (a, b) {
        // v4.2.1 overlap 回调参数顺序与 v3 不同，这里用 contains 判定，顺序无关
        var enemy = self.enemies.contains(a) ? a : (self.enemies.contains(b) ? b : null);
        var player = (enemy === a ? b : a);
        if (!enemy || !player) { return; }
        if (!enemy.alive || self.gameState !== 'playing') { return; }
        self.handleEnemyTouch(player, enemy);
      });

      // 相机跟随
      this.cameras.main.startFollow(this.player, true, CAM_LERP, CAM_LERP);

      // HUD 更新
      this.hudLevel.setText('WORLD 1-' + lvl);
      this.hudCoins.setText('COINS ' + this.coins);
      this.hudHp.setText(this.hp > 1 ? 'SIZE BIG' : 'SIZE SMALL');

      // 关卡内金币计数重置（总金币保留）
      this.coinsLevel = 0;
      this.isDead = false;
      this.invUntil = 0;
      this.coyoteTimer = 0;
      this.bufferTimer = 0;
      this.hasJumpCut = false;
      Sfx.startBgm(this);
    },

    updatePlayerBody: function () {
      if (!this.player) { return; }
      if (this.hp > 1) {
        this.player.setTexture('player_big');
        this.player.body.setSize(14, 30); this.player.body.setOffset(2, 2);
      } else {
        this.player.setTexture('player_small');
        this.player.body.setSize(12, 22); this.player.body.setOffset(2, 2);
      }
    },

    hitBlock: function (block) {
      if (!block || block._bumping) { return; }
      if (block.blockType === '?' && block.used) { return; }
      block._bumping = true;
      var self = this;
      // 顶撞动画：上移 6px 回弹
      var origY = block.y;
      this.tweens.add({
        targets: block,
        y: origY - 6,
        duration: 80,
        yoyo: true,
        onComplete: function () { block._bumping = false; block.y = origY; if (block.body) { block.body.updateFromGameObject(); } }
      });
      if (block.blockType === '?') {
        block.hasCoin = false; block.used = true;
        block.setTexture('question_used');
        this.spawnCoinFromBlock(block.x, block.y - TILE);
        Sfx.play('coin');
      } else {
        Sfx.play('bump');
      }
    },

    spawnCoinFromBlock: function (x, y) {
      var self = this;
      // 对象池化：优先复用死亡 coin，否则新建
      var coin = this.coinsGroup.getFirstDead(false);
      if (coin) {
        coin.setActive(true).setVisible(true);
        coin.x = x; coin.y = y;
        coin.body.enable = true;
      } else {
        coin = this.physics.add.sprite(x, y, 'coin');
        coin.body.allowGravity = false;
        this.coinsGroup.add(coin);
      }
      coin.isBlockCoin = true;
      // 上抛并自动收集
      this.tweens.add({
        targets: coin, y: y - 28, duration: 220, yoyo: true, ease: 'Quad.easeOut',
        onComplete: function () { self.collectCoin(coin); }
      });
    },

    collectCoin: function (coin) {
      if (!coin || !coin.active) { return; }
      coin.setActive(false).setVisible(false);
      try { coin.body.enable = false; } catch (e) {}
      this.coins += 1;
      this.coinsLevel += 1;
      this.hudCoins.setText('COINS ' + this.coins);
      Sfx.play('coin');
      // 轻微粒子：无需外部资源
      var t = this.add.text(coin.x, coin.y - 10, '+1', { fontSize: '12px', color: '#ffd54f', stroke: '#222', strokeThickness: 2 }).setOrigin(0.5).setDepth(50);
      this.tweens.add({ targets: t, y: t.y - 18, alpha: 0, duration: 420, onComplete: function(){ t.destroy(); } });
    },

    handleEnemyTouch: function (player, enemy) {
      if (this.invUntil > this.time.now) { return; }
      // 踩扁判定：玩家下落且在敌人上方
      var vy = player.body.velocity.y;
      var isStomp = vy > 30 && player.y < enemy.y - 4;
      if (isStomp) {
        this.stompEnemy(enemy);
        player.setVelocityY(-STOMP_BOUNCE);
        Sfx.play('stomp');
        // 轻微无敌，避免同帧二次判定
        this.invUntil = this.time.now + 120;
      } else {
        this.hurtPlayer();
      }
    },

    stompEnemy: function (enemy) {
      if (!enemy || !enemy.alive) { return; }
      enemy.alive = false;
      enemy.setVelocity(0, 0);
      enemy.body.enable = false;
      enemy.setTexture('enemy_flat');
      var self = this;
      this.tweens.add({ targets: enemy, alpha: 0, duration: 420, delay: 180, onComplete: function(){ enemy.setActive(false).setVisible(false); } });
      // 加分也算金币？这里仅特效
      var t = this.add.text(enemy.x, enemy.y - 16, '+100', { fontSize: '11px', color: '#ffffff', stroke: '#222', strokeThickness: 2 }).setOrigin(0.5).setDepth(50);
      this.tweens.add({ targets: t, y: t.y - 16, alpha: 0, duration: 420, onComplete: function(){ t.destroy(); } });
    },

    hurtPlayer: function () {
      if (this.invUntil > this.time.now) { return; }
      if (this.hp > 1) {
        this.hp = 1;
        this.updatePlayerBody();
        this.hudHp.setText('SIZE SMALL');
        Sfx.play('hurt');
        this.invUntil = this.time.now + HURT_INV_MS;
        // 受伤无敌闪烁
        var self = this;
        var blink = this.time.addEvent({ delay: 100, loop: true, callback: function () {
          if (!self.player || !self.player.active) { blink.remove(false); return; }
          if (self.time.now > self.invUntil) { self.player.setAlpha(1); blink.remove(false); return; }
          self.player.setAlpha(self.player.alpha === 1 ? 0.25 : 1);
        }});
        // 轻微击退
        var dir = this.player.facing || 1;
        this.player.setVelocityX(-dir * 160);
        this.player.setVelocityY(-220);
      } else {
        this.playerDie();
      }
    },

    playerDie: function () {
      if (this.gameState === 'dead' || this.gameState === 'win') { return; }
      this.gameState = 'dead';
      this.isDead = true;
      Sfx.stopBgm(); Sfx.play('die');
      if (this.player) { this.player.setVelocity(0, -320); this.player.setAlpha(1); }
      this.centerText.setText('YOU DIED\n[ R ] RESTART  [SPACE] TITLE').setVisible(true);
      this.saveProgress();
    },

    levelClear: function () {
      if (this.gameState !== 'playing') { return; }
      this.gameState = 'inter';
      Sfx.stopBgm(); Sfx.play('clear');
      // 记录最佳
      var idx = this.curLevel - 1;
      if (this.coinsLevel > (saveData.bestCoins[idx] || 0)) { saveData.bestCoins[idx] = this.coinsLevel; }
      if (this.curLevel >= saveData.unlockedLevel && this.curLevel < LEVELS.length) {
        saveData.unlockedLevel = this.curLevel + 1;
      }
      this.saveProgress();
      var self = this;
      if (this.curLevel < LEVELS.length) {
        this.centerText.setText('LEVEL ' + this.curLevel + ' CLEAR!\nNEXT...').setVisible(true);
        this.time.delayedCall(1400, function () {
          self.centerText.setVisible(false);
          self.loadLevel(self.curLevel + 1);
          self.gameState = 'playing';
        });
      } else {
        this.gameState = 'win';
        this.centerText.setText('YOU WIN!\nCOINS ' + this.coins + '\n[ R ] RESTART  [SPACE] TITLE').setVisible(true);
      }
    },

    saveProgress: function () {
      try {
        if (hostRef && hostRef.saveState) {
          hostRef.saveState({ unlockedLevel: saveData.unlockedLevel, bestCoins: saveData.bestCoins.slice(0) }).then(function(){}, function(){});
        }
      } catch (e) {}
    },

    update: function (time, delta) {
      // 标题态：按 SPACE 开始
      if (this.gameState === 'title') {
        if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.W) || Phaser.Input.Keyboard.JustDown(this.keys.UP)) {
          Sfx.ensure();
          this.titleText.setVisible(false);
          this.centerText.setVisible(false);
          // 从已解锁最高关或第1关开始；此处默认第1关，关间会自动进第2关
          this.coins = 0; this.hp = 2; this.isDead = false;
          this.loadLevel(1);
          this.gameState = 'playing';
        }
        return;
      }
      // 死亡/胜利：R 重开，SPACE 回标题
      if (this.gameState === 'dead' || this.gameState === 'win') {
        if (Phaser.Input.Keyboard.JustDown(this.keys.R) || Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.W) || Phaser.Input.Keyboard.JustDown(this.keys.UP)) {
          Sfx.ensure();
          this.centerText.setVisible(false);
          this.coins = 0; this.hp = 2; this.isDead = false;
          if (this.player) { this.player.setAlpha(1); }
          // dead 时回当前关，win 时回第1关
          var lvl = (this.gameState === 'dead' ? this.curLevel : 1);
          this.loadLevel(lvl);
          this.gameState = 'playing';
        }
        // 视差仍滚动
        if (this.bgFar) { this.bgFar.tilePositionX += 0.15; }
        if (this.bgNear) { this.bgNear.tilePositionX += 0.35; }
        return;
      }
      if (this.gameState === 'inter') {
        if (this.bgFar) { this.bgFar.tilePositionX += 0.15; }
        if (this.bgNear) { this.bgNear.tilePositionX += 0.35; }
        return;
      }
      if (!this.player || !this.player.active) { return; }

      // ---- 视差滚动（2层色块，scrollFactor=0，手写偏移） ----
      // 将来换：换成 this.load.image 的 tileSprite 后同样 tilePositionX 写法
      if (this.bgFar) { this.bgFar.tilePositionX = this.cameras.main.scrollX * 0.22; }
      if (this.bgNear) { this.bgNear.tilePositionX = this.cameras.main.scrollX * 0.55; }

      // ---- 移动平台往复 ----
      var self = this;
      this.movers.getChildren().forEach(function (m) {
        if (!m.active) { return; }
        // 到达边界反向
        if (m.x >= m.startX + m.range) { m.moverDir = -1; m.setVelocityX(-m.speed); }
        else if (m.x <= m.startX - m.range) { m.moverDir = 1; m.setVelocityX(m.speed); }
        // 玩家站在平台上时跟随平台 delta
        if (self.player && self.player.body && m.body) {
          var onTop = self.player.body.blocked.down && m.body.touching.up;
          // 更宽容：水平重叠且玩家脚部贴近平台顶面
          if (onTop || (Math.abs(self.player.x - m.x) < 56 && Math.abs((self.player.y + self.player.body.halfHeight) - (m.y - 8)) < 6 && self.player.body.velocity.y >= 0)) {
            // 仅当玩家确实在平台上方时跟随
            if (Math.abs(self.player.x - m.x) < 54) {
              self.player.x += m.body.deltaX();
            }
          }
        }
      });

      // ---- 巡逻敌：撞墙/边缘反向 ----
      this.enemies.getChildren().forEach(function (e) {
        if (!e.active || !e.alive) { return; }
        // 撞墙反向
        if (e.body.blocked.left) { e.patrolDir = 1; }
        else if (e.body.blocked.right) { e.patrolDir = -1; }
        e.setVelocityX(e.patrolDir * ENEMY_SPEED);
        // 掉出世界则回收（对象池化：inactive 复用）
        if (e.y > self.worldH + 48) { e.setActive(false).setVisible(false); try{ e.body.enable=false;}catch(ex){} }
        // 精灵朝向
        e.setFlipX(e.patrolDir < 0);
      });

      // ---- 手感核心：左右加减速 + 可变跳高 + 土狼 + 缓冲 ----
      // 输入方向
      var leftDown = this.keys.LEFT.isDown || this.keys.A.isDown || this.keys.A2.isDown;
      var rightDown = this.keys.RIGHT.isDown || this.keys.D.isDown;
      var jumpDown = this.keys.W.isDown || this.keys.UP.isDown || this.keys.SPACE.isDown;
      var jumpJustDown = Phaser.Input.Keyboard.JustDown(this.keys.W) || Phaser.Input.Keyboard.JustDown(this.keys.UP) || Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.W2);
      var jumpJustUp = Phaser.Input.Keyboard.JustUp(this.keys.W) || Phaser.Input.Keyboard.JustUp(this.keys.UP) || Phaser.Input.Keyboard.JustUp(this.keys.SPACE) || Phaser.Input.Keyboard.JustUp(this.keys.W2);

      // 地面判定：blocked.down 或 touching.down
      var onGround = this.player.body.blocked.down || this.player.body.touching.down;

      // 土狼计时：离开地面后 100ms 内仍可跳
      // 实现：onGround 时刷新为 COYOTE_MS，否则每帧递减
      if (onGround) { this.coyoteTimer = COYOTE_MS; }
      else { this.coyoteTimer -= delta; if (this.coyoteTimer < 0) { this.coyoteTimer = 0; } }

      // 跳跃缓冲：落地前 120ms 内按跳，落地瞬间自动起跳
      // 实现：JustDown 时刷新为 BUFFER_MS，否则递减；消费时清零
      if (jumpJustDown) { this.bufferTimer = BUFFER_MS; Sfx.ensure(); }
      else { this.bufferTimer -= delta; if (this.bufferTimer < 0) { this.bufferTimer = 0; } }

      // 可变跳高：按住跳得高，松键早截断上升速度
      // 实现：起跳后若松键且 vy<0，则 vy *= JUMP_CUT（仅一次）
      if (jumpJustDown) { this.hasJumpCut = false; }
      if (jumpJustUp && !this.hasJumpCut && this.player.body.velocity.y < -40) {
        this.player.setVelocityY(this.player.body.velocity.y * JUMP_CUT);
        this.hasJumpCut = true;
      }

      // 跳跃触发：缓冲>0 且（在地面或土狼>0）则起跳
      if (this.bufferTimer > 0 && (onGround || this.coyoteTimer > 0)) {
        this.player.setVelocityY(-JUMP_VEL);
        this.bufferTimer = 0;
        this.coyoteTimer = 0;
        this.hasJumpCut = false;
        Sfx.play('jump');
      }

      // 左右加减速：地面/空中不同加速度，松键滑行减速，反向更快
      var vx = this.player.body.velocity.x;
      var target = 0;
      if (leftDown && !rightDown) { target = -MOVE_MAX; this.player.facing = -1; }
      else if (rightDown && !leftDown) { target = MOVE_MAX; this.player.facing = 1; }
      else { target = 0; }

      var accel = onGround ? MOVE_ACCEL : MOVE_ACCEL * AIR_FACTOR;
      var decel = MOVE_DECEL;
      var step = accel * (delta / 1000);
      var stepDec = decel * (delta / 1000);

      if (target !== 0) {
        // 朝目标加速；若反向则用更大减速
        if (Math.sign(vx) !== Math.sign(target) && vx !== 0) {
          // 反向：先快速减速再加速
          if (Math.abs(vx) < stepDec) { vx = 0; }
          else { vx -= Math.sign(vx) * stepDec; }
        } else {
          if (vx < target) { vx = Math.min(target, vx + step); }
          else if (vx > target) { vx = Math.max(target, vx - step); }
        }
      } else {
        // 松键：滑行减速到 0
        if (Math.abs(vx) < stepDec) { vx = 0; }
        else { vx -= Math.sign(vx) * stepDec; }
      }
      this.player.setVelocityX(vx);

      // 终端速度钳制
      if (this.player.body.velocity.y > TERMINAL_VY) { this.player.setVelocityY(TERMINAL_VY); }

      // 掉坑死亡：y 超世界底
      if (this.player.y > this.worldH + 64) {
        this.playerDie();
        return;
      }

      // 无敌闪烁已在 hurtPlayer 中用 timer 实现；此处补充过期恢复
      if (this.invUntil && time > this.invUntil && this.player.alpha !== 1) {
        this.player.setAlpha(1);
      }

      // 镜头边界已在 loadLevel 用 setBounds 设置；跟随用 startFollow
    }
  });

  // ==========================================================================
  // 注册
  // ==========================================================================
  var hostW = 960, hostH = 540;
  // host 尺寸在 launch 时确定；此处仅占位
  window.TRGames = window.TRGames || { register: function(){}, _r:{} };
  window.TRGames.register({
    id: 'platformer-mario',
    title: 'Mario Platformer',
    launch: function (host) {
      hostRef = host;
      var W = host.width || hostW;
      var H = host.height || hostH;
      // 读取存档（异步，不阻塞创建）
      if (host.loadState) {
        try {
          host.loadState().then(function (d) {
            if (d && typeof d === 'object') {
              if (d.unlockedLevel) { saveData.unlockedLevel = d.unlockedLevel; }
              if (Array.isArray(d.bestCoins)) { saveData.bestCoins = d.bestCoins.slice(0, 2); while (saveData.bestCoins.length < 2) { saveData.bestCoins.push(0); } }
            }
          }, function () {});
        } catch (e) {}
      }
      var game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host.container,
        width: W,
        height: H,
        backgroundColor: '#6ec6f5',
        physics: {
          default: 'arcade',
          arcade: { gravity: { y: GRAVITY, x: 0 }, debug: false }
        },
        scene: [MainScene]
      });
      // 测试缝：与 survivor 一致暴露 game + getState；scene 指向 MainScene
      sceneRef = null;
      // 延迟绑定 sceneRef（create 后才有）
      var tryBind = function () {
        try {
          var s = game.scene.getScene('Main');
          if (s) { sceneRef = s; }
        } catch (e) {}
      };
      setTimeout(tryBind, 400);
      game.events.on('ready', tryBind);
      window.__trgame = {
        game: game,
        getState: getState,
        getScene: function(){ return sceneRef; }
      };
      // 暴露存档快照便于调试
      window.__trgame.getSave = function(){ return { unlockedLevel: saveData.unlockedLevel, bestCoins: saveData.bestCoins.slice(0) }; };
      return game;
    }
  });

})();
