// =============================================================================
// games/breakout/main.js — 打砖块 Breakout（2 关卡 + 4 道具 + 轨迹）
// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改：
//   视觉（本文件 buildTextures 段，全部 Graphics+generateTexture 纯几何）：
//     paddle       — Graphics 圆角矩形+高光  → this.load.image('paddle','assets/paddle.png')
//     ball         — Graphics 圆形+高光      → this.load.image('ball','assets/ball.png')
//     brick_*      — Graphics 矩形+耐久色/描边+高光条  → this.load.image('brick_red','assets/brick_red.png') 等
//     brick_metal  — Graphics 金属灰+铆钉  → this.load.image('brick_metal','assets/brick_metal.png')
//     powerup_*    — Graphics 几何图标（E/3/P/S） → this.load.image('power_expand','assets/power_expand.png') 等
//     bg_tile      — Graphics 平铺背景      → this.load.image('bg_tile','assets/bg_tile.png')
//     粒子/轨迹： Graphics 圆点 + tween，无纹理，可换 particle 贴图
//     // TODO(视觉替换点): 在 buildTextures 中将对应 generateTexture 块改为 load.image
//   音频（Sfx 块）：
//     hit/break/powerup/lose/bgm — WebAudio oscillator+gain → this.load.audio('hit','assets/hit.wav')+this.sound.play
//     // TODO(音频替换点): 在 Sfx.play 分支替换 oscillator 为 AudioBuffer 播放
//   关卡：
//     STAGES[].layout 数字矩阵（0空 1耐久1 2耐久2 9金属 M移动）— 未来可换 Tiled JSON：
//       this.load.tilemapTiledJSON('stage1','assets/stage1.json')
//   存档：host.saveState { bestScore:number, clearedStage:number }
//   池化：ballPool / powerupPool / particlePool 复用，避免频繁 create/destroy
// =============================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 顶部可调参数（带单位，中文注释）
  // ---------------------------------------------------------------------------
  var CFG = {
    W: 960,               // 逻辑宽度（host.width 优先）
    H: 540,               // 逻辑高度（host.height 优先）
    PADDLE_W: 110,        // 挡板宽 px
    PADDLE_H: 14,         // 挡板高 px
    PADDLE_SPEED: 520,    // 挡板键盘速度 px/s
    PADDLE_MIN_W: 70,     // 最窄
    PADDLE_MAX_W: 170,    // 最宽（加长道具后）
    BALL_R: 7,            // 球半径 px
    BALL_SPEED: 300,      // 发球初速 px/s
    BALL_SPEED_MAX: 520,  // 球速上限（防止道具/反弹叠加后过快）
    BALL_LAUNCH_Y: -1,    // 发球方向 y 分量符号
    LIVES: 3,             // 初始命数
    BRICK_W: 58,          // 砖宽
    BRICK_H: 20,          // 砖高
    BRICK_GAP: 4,         // 砖缝
    BRICK_COLS: 8,        // 列数（自适应居中，保持此列数）
    BRICK_TOP: 72,        // 砖阵顶 y
    WALL_THICK: 12,       // 左右/顶墙厚度
    POWERUP_FALL: 140,    // 道具下落速度 px/s
    POWERUP_CHANCE: 0.22, // 击碎掉落概率
    PIERCE_MS: 5200,      // 穿透时长 ms
    SLOW_MS: 5000,        // 减速时长 ms
    EXPAND_MS: 9000,      // 加长时长 ms
    SCORE_HIT: 10,        // 击中得分（耐久砖第一次）
    SCORE_BREAK: 100      // 击碎得分
  };

  // 左右墙内边界（运行时由 w/h 计算，CFG.W/H 仅默认值）
  // 关卡 — 至少2关，布局与配色区分；关2含金属不可破坏砖与移动砖
  var STAGES = [
    {
      id: 1,
      title: 'STAGE 1 — 彩虹壁垒',
      bg: '#0f1e3a',
      bg2: '#1a2f5a',
      // layout: 5行 x 8列，0空 1耐久1 2耐久2（需2击，首击变色）
      // 行配色映射见 ROW_COLORS[0]
      layout: [
        [1,1,1,1,1,1,1,1],
        [1,2,1,2,2,1,2,1],
        [2,2,1,1,1,1,2,2],
        [1,1,2,2,2,2,1,1],
        [1,1,1,1,1,1,1,1]
      ],
      moving: [] // 无移动砖
    },
    {
      id: 2,
      title: 'STAGE 2 — 钢铁回廊',
      bg: '#1a1a2e',
      bg2: '#2d1b3a',
      // 9=金属不可破坏，2=耐久2；第0行顶排金属，第4行夹一条金属带
      layout: [
        [9,9,9,9,9,9,9,9],
        [2,2,1,1,1,1,2,2],
        [1,2,2,1,1,2,2,1],
        [2,1,1,2,2,1,1,2],
        [9,1,9,1,1,9,1,9],
        [1,1,2,2,2,2,1,1]
      ],
      // 移动砖：指定若干坐标（row,col）的砖会水平往复（hp 取 layout 对应值）
      moving: [{r:1,c:2},{r:1,c:5},{r:5,c:2},{r:5,c:5}]
    }
  ];

  // 每关行配色（与 layout 行索引对应，关卡间区分）
  var ROW_COLORS = [
    // stage1 五彩
    [0xe74c3c, 0xe67e22, 0xf1c40f, 0x2ecc71, 0x3498db],
    // stage2 暗金+紫调，金属行单独色
    [0x7f8c8d, 0x9b59b6, 0x3498db, 0xe67e22, 0x95a5a6, 0x2ecc71]
  ];
  var METAL_COLOR = 0x5d6d7e;
  var METAL_STROKE = 0x95a5a6;

  // 道具类型
  var POWER_TYPES = ['expand','multiball','pierce','slow'];
  var POWER_LABEL = { expand:'E', multiball:'3', pierce:'P', slow:'S' };
  var POWER_COLOR = { expand:0x2ecc71, multiball:0xf39c12, pierce:0xe74c3c, slow:0x3498db };

  // ---------------------------------------------------------------------------
  // 存档/缝 — 闭包持有，跨场景共享
  // ---------------------------------------------------------------------------
  var hostRef = null;
  var sceneRef = null;
  var saveData = { bestScore: 0, clearedStage: 0 };

  function getState() {
    var s = sceneRef;
    if (!s) return { scene: 'title', score: 0, stage: 1, lives: CFG.LIVES, bricks: 0 };
    var bricks = 0;
    try {
      if (s.bricks) {
        var ch = s.bricks.getChildren();
        for (var i=0;i<ch.length;i++){ if(ch[i].active && ch[i].hp>0 && ch[i].hp!==99) bricks++; }
      }
    } catch(e){}
    return {
      scene: s.scene.key || 'breakout',
      score: s.score || 0,
      stage: s.stage || 1,
      lives: s.lives != null ? s.lives : CFG.LIVES,
      bricks: bricks
    };
  }


  // ---------------------------------------------------------------------------
  // 音频 — WebAudio 自合成，首输入 resume，失败静默降级
  // 音频替换点：把 Sfx.play 内 oscillator 换成 AudioBuffer/HTMLAudio 即可
  // ---------------------------------------------------------------------------
  var Sfx = {
    ctx: null,
    bgmTimer: null,
    bgmOn: false,
    ensure: function () {
      if (this.ctx) return this.ctx;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      } catch (e) { this.ctx = null; }
      return this.ctx;
    },
    resume: function () {
      var c = this.ensure();
      if (c && c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    },
    // 音频替换点：type 分支即替换点，可接入外部资源
    play: function (type) {
      var c = this.ensure();
      if (!c) return;
      if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
      try {
        var o = c.createOscillator();
        var g = c.createGain();
        o.connect(g); g.connect(c.destination);
        var now = c.currentTime;
        if (type === 'hit') {
          // 挡板/墙反弹 — 短促方波
          o.type = 'square'; o.frequency.setValueAtTime(520, now);
          o.frequency.exponentialRampToValueAtTime(260, now + 0.06);
          g.gain.setValueAtTime(0.10, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.10);
          o.start(now); o.stop(now + 0.11);
        } else if (type === 'break') {
          // 碎砖 — 明亮正弦上行
          o.type = 'sine'; o.frequency.setValueAtTime(440, now);
          o.frequency.linearRampToValueAtTime(880, now + 0.12);
          g.gain.setValueAtTime(0.14, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
          o.start(now); o.stop(now + 0.17);
          // 二谐波
          var o2 = c.createOscillator(), g2 = c.createGain();
          o2.type='sine'; o2.frequency.setValueAtTime(660, now);
          o2.frequency.linearRampToValueAtTime(1100, now + 0.12);
          g2.gain.setValueAtTime(0.08, now);
          g2.gain.exponentialRampToValueAtTime(0.001, now+0.16);
          o2.connect(g2); g2.connect(c.destination);
          o2.start(now); o2.stop(now+0.17);
        } else if (type === 'powerup') {
          o.type = 'sine'; o.frequency.setValueAtTime(523, now);
          o.frequency.setValueAtTime(659, now + 0.07);
          o.frequency.setValueAtTime(784, now + 0.14);
          g.gain.setValueAtTime(0.14, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
          o.start(now); o.stop(now + 0.29);
        } else if (type === 'lose') {
          o.type = 'sawtooth'; o.frequency.setValueAtTime(220, now);
          o.frequency.linearRampToValueAtTime(70, now + 0.4);
          g.gain.setValueAtTime(0.16, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
          o.start(now); o.stop(now + 0.46);
        } else if (type === 'clear') {
          o.type='square'; o.frequency.setValueAtTime(392, now);
          g.gain.setValueAtTime(0.13, now);
          g.gain.exponentialRampToValueAtTime(0.001, now+0.4);
          o.start(now); o.stop(now+0.42);
          var self=this;
          setTimeout(function(){
            var c2=self.ensure(); if(!c2) return;
            var o3=c2.createOscillator(), g3=c2.createGain();
            o3.connect(g3); g3.connect(c2.destination);
            o3.type='square'; o3.frequency.setValueAtTime(523, c2.currentTime);
            g3.gain.setValueAtTime(0.13,c2.currentTime);
            g3.gain.exponentialRampToValueAtTime(0.001,c2.currentTime+0.5);
            o3.start(c2.currentTime); o3.stop(c2.currentTime+0.52);
          }, 180);
        }
      } catch (e) {}
    },
    startBgm: function (scene) {
      if (this.bgmTimer) return;
      this.bgmOn = true;
      var self = this;
      try {
        self.bgmTimer = scene.time.addEvent({
          delay: 520,
          loop: true,
          callback: function () {
            if (!self.bgmOn) return;
            self.play('hit');
          }
        });
      } catch (e) {}
    },
    stopBgm: function () {
      this.bgmOn = false;
      if (this.bgmTimer) { try { this.bgmTimer.remove(false); } catch (e) {} this.bgmTimer = null; }
    }
  };

  // ---------------------------------------------------------------------------
  // 纹理生成 — 全部 Graphics+generateTexture
  // 视觉替换点：每个 rm+Graphics 块可替换为外部贴图加载
  // ---------------------------------------------------------------------------
  function buildTextures(scene) {
    function rm(k) { if (scene.textures.exists(k)) scene.textures.remove(k); }
    var g;
    // 挡板 — 圆角矩形 + 高光条
    rm('paddle'); g = scene.add.graphics();
    // 视觉替换点：挡板可换贴图
    g.fillStyle(0x85c1ff, 1);
    g.fillRoundedRect(0, 0, CFG.PADDLE_MAX_W+10, CFG.PADDLE_H, 6);
    g.fillStyle(0xffffff, 0.55);
    g.fillRoundedRect(2, 1, CFG.PADDLE_MAX_W+6, 4, 3);
    g.lineStyle(1.2, 0x3a7bd5, 1);
    g.strokeRoundedRect(0, 0, CFG.PADDLE_MAX_W+10, CFG.PADDLE_H, 6);
    g.generateTexture('paddle', CFG.PADDLE_MAX_W+10, CFG.PADDLE_H); g.destroy();
    // 球 — 圆形 + 高光圆
    rm('ball'); g = scene.add.graphics();
    g.fillStyle(0xffffff, 1); g.fillCircle(CFG.BALL_R+1, CFG.BALL_R+1, CFG.BALL_R);
    g.fillStyle(0xc0e8ff, 0.55); g.fillCircle(CFG.BALL_R-1, CFG.BALL_R-1, 3);
    g.lineStyle(1, 0x5aa9e6, 0.9); g.strokeCircle(CFG.BALL_R+1, CFG.BALL_R+1, CFG.BALL_R);
    g.generateTexture('ball', CFG.BALL_R*2+2, CFG.BALL_R*2+2); g.destroy();
    // 轨迹点 — 小圆点半透明
    rm('trail'); g = scene.add.graphics();
    g.fillStyle(0xffffff, 0.95); g.fillCircle(3, 3, 3);
    g.generateTexture('trail', 6, 6); g.destroy();
    // 普通砖（每种耐久色由 tint 区分，这里做中性白砖，tint 上色）
    rm('brick'); g = scene.add.graphics();
    g.fillStyle(0xffffff, 1); g.fillRect(0, 0, CFG.BRICK_W, CFG.BRICK_H);
    g.fillStyle(0xffffff, 0.45); g.fillRect(1, 1, CFG.BRICK_W-2, 5);
    g.fillStyle(0x000000, 0.12); g.fillRect(1, CFG.BRICK_H-4, CFG.BRICK_W-2, 3);
    g.lineStyle(1, 0x000000, 0.18); g.strokeRect(0, 0, CFG.BRICK_W, CFG.BRICK_H);
    g.generateTexture('brick', CFG.BRICK_W, CFG.BRICK_H); g.destroy();
    // 金属砖 — 深灰 + 铆钉 + 斜纹
    rm('brick_metal'); g = scene.add.graphics();
    g.fillStyle(METAL_COLOR, 1); g.fillRect(0, 0, CFG.BRICK_W, CFG.BRICK_H);
    g.fillStyle(0xffffff, 0.22); g.fillRect(1, 1, CFG.BRICK_W-2, 4);
    g.fillStyle(0x000000, 0.28); g.fillRect(1, CFG.BRICK_H-5, CFG.BRICK_W-2, 4);
    g.lineStyle(1, METAL_STROKE, 1); g.strokeRect(0, 0, CFG.BRICK_W, CFG.BRICK_H);
    // 铆钉四角
    g.fillStyle(0xd5dbdb, 1);
    g.fillCircle(5, 5, 2); g.fillCircle(CFG.BRICK_W-5, 5, 2);
    g.fillCircle(5, CFG.BRICK_H-5, 2); g.fillCircle(CFG.BRICK_W-5, CFG.BRICK_H-5, 2);
    // 对角斜纹
    g.lineStyle(1, 0x85929e, 0.35);
    g.lineBetween(10, 2, 24, CFG.BRICK_H-2);
    g.lineBetween(28, 2, 42, CFG.BRICK_H-2);
    g.generateTexture('brick_metal', CFG.BRICK_W, CFG.BRICK_H); g.destroy();
    // 耐久裂纹覆盖（半透明裂纹，耐久2→1时叠加）
    rm('brick_crack'); g = scene.add.graphics();
    g.lineStyle(1.4, 0x000000, 0.55);
    g.lineBetween(8, 4, 18, 10); g.lineBetween(18, 10, 14, 15);
    g.lineBetween(30, 6, 42, 12); g.lineBetween(42, 12, 36, 16);
    g.generateTexture('brick_crack', CFG.BRICK_W, CFG.BRICK_H); g.destroy();
    // 道具几何 — 四种 20x20 菱形/圆底
    var defs = [
      { key:'power_expand', col:POWER_COLOR.expand, label:'E' },
      { key:'power_multiball', col:POWER_COLOR.multiball, label:'3' },
      { key:'power_pierce', col:POWER_COLOR.pierce, label:'P' },
      { key:'power_slow', col:POWER_COLOR.slow, label:'S' }
    ];
    for (var di=0; di<defs.length; di++){
      var d = defs[di];
      rm(d.key); g = scene.add.graphics();
      g.fillStyle(d.col, 1);
      g.fillRoundedRect(0, 0, 26, 22, 5);
      g.fillStyle(0xffffff, 0.9);
      g.fillRoundedRect(2, 2, 22, 6, 2);
      g.lineStyle(1, 0xffffff, 0.95); g.strokeRoundedRect(0, 0, 26, 22, 5);
      // 文字用 Graphics 画简易几何替代：E 为三横，3 为两半圆，P 为圈+竖，S 为S形
      g.lineStyle(1.6, 0xffffff, 1);
      if (d.label==='E'){ g.lineBetween(7,8,17,8); g.lineBetween(7,11,15,11); g.lineBetween(7,14,17,14); }
      else if (d.label==='3'){ g.strokeCircle(13, 9, 4); g.strokeCircle(13, 14, 4); }
      else if (d.label==='P'){ g.strokeCircle(11, 10, 4); g.lineBetween(11, 14, 11, 18); }
      else if (d.label==='S'){ g.strokeCircle(13, 9, 3.5); g.strokeCircle(13, 14.5, 3.5); }
      g.generateTexture(d.key, 26, 22); g.destroy();
    }
    // 破碎粒子 — 小方块 4x4
    rm('particle'); g = scene.add.graphics();
    g.fillStyle(0xffffff, 1); g.fillRect(0, 0, 4, 4);
    g.generateTexture('particle', 4, 4); g.destroy();
  }


  // ---------------------------------------------------------------------------
  // 场景 — 单 Scene 承载 title→playing→clear→gameover，通过 gameState 切换
  // ---------------------------------------------------------------------------
  var BootScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function BootScene(){ Phaser.Scene.call(this,{key:'Boot'}); },
    create: function(){
      this.scene.start('Breakout');
    }
  });

  var BreakoutScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function BreakoutScene(){ Phaser.Scene.call(this,{key:'Breakout'}); },

    create: function(){
      sceneRef = this;
      // 尺寸：优先宿主给定，否则 CFG 默认
      var w = (hostRef && hostRef.width) || CFG.W;
      var h = (hostRef && hostRef.height) || CFG.H;
      this.w = w; this.h = h;
      this.cameras.main.setBackgroundColor(STAGES[0].bg);
      // 存档加载（异步）
      var self = this;
      if (hostRef && hostRef.loadState){
        try{ hostRef.loadState().then(function(d){
          if(d && typeof d==='object'){
            if(typeof d.bestScore==='number') saveData.bestScore=d.bestScore;
            if(typeof d.clearedStage==='number') saveData.clearedStage=d.clearedStage;
            self.updateHud();
            if(self.gameState==='title') self.renderTitle();
          }
        }, function(){});}catch(e){}
      }

      buildTextures(this);

      // 背景平铺（几何）
      this.bg = this.add.rectangle(w/2, h/2, w, h, 0x0f1e3a).setDepth(-10);
      this.bg2 = this.add.rectangle(w/2, 0, w, 180, 0x1a2f5a).setAlpha(0.35).setDepth(-9);
      // 墙：Graphics 线条
      this.walls = this.physics.add.staticGroup();
      // 左
      var left = this.add.rectangle(CFG.WALL_THICK/2, h/2, CFG.WALL_THICK, h, 0x24344e);
      this.physics.add.existing(left, true); this.walls.add(left);
      // 右
      var right = this.add.rectangle(w - CFG.WALL_THICK/2, h/2, CFG.WALL_THICK, h, 0x24344e);
      this.physics.add.existing(right, true); this.walls.add(right);
      // 顶
      var top = this.add.rectangle(w/2, CFG.WALL_THICK/2, w, CFG.WALL_THICK, 0x24344e);
      this.physics.add.existing(top, true); this.walls.add(top);

      // 边界计算
      this.leftBound = CFG.WALL_THICK;
      this.rightBound = w - CFG.WALL_THICK;
      this.topBound = CFG.WALL_THICK;

      // 分数/关卡/生命 HUD
      this.score = 0; this.stage = 1; this.lives = CFG.LIVES;
      this.gameState = 'title'; // title|ready|playing|stageClear|gameover
      this.hudScore = this.add.text(14, 8, '', {fontFamily:'monospace', fontSize:'13px', color:'#cfe8ff'}).setDepth(10).setScrollFactor(0);
      this.hudStage = this.add.text(w/2, 8, '', {fontFamily:'monospace', fontSize:'13px', color:'#ffe9a8'}).setOrigin(0.5,0).setDepth(10);
      this.hudLives = this.add.text(w - 14, 8, '', {fontFamily:'monospace', fontSize:'13px', color:'#ffb3b3'}).setOrigin(1,0).setDepth(10);
      this.hudHi = this.add.text(w - 14, 26, '', {fontFamily:'monospace', fontSize:'11px', color:'#9ecfff'}).setOrigin(1,0).setDepth(10);

      // 居中大字
      this.centerText = this.add.text(w/2, h/2 - 40, '', {fontFamily:'monospace', fontSize:'28px', color:'#ffffff', align:'center', stroke:'#000000', strokeThickness:4}).setOrigin(0.5).setDepth(20).setVisible(false);
      this.subText = this.add.text(w/2, h/2 + 22, '', {fontFamily:'monospace', fontSize:'13px', color:'#cfe8ff', align:'center'}).setOrigin(0.5).setDepth(20).setVisible(false);
      this.hintText = this.add.text(w/2, h - 22, '', {fontFamily:'monospace', fontSize:'11px', color:'#8fb8e0', align:'center'}).setOrigin(0.5).setDepth(10);

      // 挡板
      this.paddle = this.physics.add.image(w/2, h - 42, 'paddle');
      this.paddle.setImmovable(true);
      this.paddle.body.allowGravity = false;
      this.paddle.setCollideWorldBounds(false);
      this.paddleW = CFG.PADDLE_W;
      this.updatePaddleSize(this.paddleW);
      // 挡板显示裁剪：用 displayWidth 控制
      this.paddle.baseW = CFG.PADDLE_W;

      // 球组（池化，多球用组）
      this.balls = this.physics.add.group({ collideWorldBounds:false });
      // 道具组
      this.powerups = this.physics.add.group();
      // 砖组
      this.bricks = this.physics.add.staticGroup();
      // 移动砖引用
      this.movingBricks = [];

      // 粒子/轨迹容器
      this.trailPts = []; // {x,y,life}
      this.trailTime = 0;

      // 道具状态计时
      this.expandUntil = 0;
      this.pierceUntil = 0;
      this.slowUntil = 0;
      this.isPiercing = false;
      this.isSlow = false;

      // 键盘
      this.keys = this.input.keyboard.addKeys('LEFT,RIGHT,A,D,SPACE,ENTER,P,R,ONE,TWO,ESC');
      this.cursors = this.input.keyboard.createCursorKeys();

      // 鼠标/触摸跟随
      var self2 = this;
      this.input.on('pointermove', function(pointer){
        if(self2.gameState==='title' || self2.gameState==='gameover' || self2.gameState==='stageClear') return;
        self2.paddleTargetX = pointer.x;
      });
      this.input.on('pointerdown', function(){
        if(self2.gameState==='ready'){ self2.launchBall(); }
        else if(self2.gameState==='title'){ Sfx.resume(); self2.startStage(1); }
        else if(self2.gameState==='stageClear'){ self2.advanceStage(); }
        else if(self2.gameState==='gameover'){ self2.goTitle(); }
      });

      // 键盘发射
      this.input.keyboard.on('keydown-SPACE', function(){
        if(self.gameState==='ready'){ self.launchBall(); }
      });

      // 碰撞：球-挡板（手动处理以做 offset→角度）
      // 挡板改为 immovable，球弹角在 update 中做 AABB 检测（避免 arcade 与 immovable 的 vy 翻转丢失 offset 信息）
      // 墙：球-墙 自动反弹（用 physics collider + bounce）
      // 砖：球-砖 overlap 参数顺序无关（contains 判断）

      this.updateHud();
      this.renderTitle();

      // 轻量背景 tween
      this.tweens.add({ targets: this.bg2, alpha: 0.52, duration: 1600, yoyo:true, repeat:-1, ease:'Sine.easeInOut' });
    },

    // -----------------------------------------------------------------------
    // HUD
    // -----------------------------------------------------------------------
    updateHud: function(){
      this.hudScore.setText('SCORE ' + this.score);
      this.hudStage.setText('STAGE ' + this.stage + ' / ' + STAGES.length);
      var hearts = '';
      for(var i=0;i<this.lives;i++) hearts += '\u2665 ';
      this.hudLives.setText(hearts + '('+this.lives+')');
      this.hudHi.setText('HI ' + (saveData.bestScore||0) + '  CLEAR ' + (saveData.clearedStage||0));
    },

    renderTitle: function(){
      var w=this.w, h=this.h;
      this.centerText.setText('BREAKOUT\n\u6253\u7816\u5757').setVisible(true);
      this.subText.setText(
        'ARROWS / A D  MOVE   MOUSE  FOLLOW\nSPACE / CLICK  LAUNCH   P  PAUSE   R  RESTART\n1 / 2  SELECT STAGE   ENTER  START'
        + '\nHI ' + (saveData.bestScore||0) + '  CLEAR ' + (saveData.clearedStage||0)
      ).setVisible(true);
      this.hintText.setText('HIT BRICKS  COLLECT  E(EXPAND)  3(MULTI)  P(PIERCE)  S(SLOW)');
    },
    hideCenter: function(){ this.centerText.setVisible(false); this.subText.setVisible(false); },

    // -----------------------------------------------------------------------
    // 关卡加载
    // -----------------------------------------------------------------------
    startStage: function(n){
      n = Math.max(1, Math.min(n, STAGES.length));
      this.stage = n;
      var st = STAGES[n-1];
      this.cameras.main.setBackgroundColor(st.bg);
      this.bg.setFillStyle(st.bg);
      this.bg2.setFillStyle(st.bg2);
      this.score = this.score || 0; // 标题进第一关分数归零由 goTitle/startStage 区分
      // 从标题进则清分，关内进阶保留分
      if(this.gameState==='title' || this.gameState==='gameover'){ this.score = 0; this.lives = CFG.LIVES; }
      this.resetPowerups();
      this.buildLevel(n);
      this.resetPaddleAndBall();
      this.gameState = 'ready';
      this.hideCenter();
      this.centerText.setText(st.title).setVisible(true);
      this.subText.setText('PRESS  SPACE  OR  CLICK  TO LAUNCH').setVisible(true);
      this.time.delayedCall(900, function(){
        if(this.gameState==='ready'){ this.centerText.setVisible(false); this.subText.setVisible(false); }
      }, [], this);
      this.hintText.setText('STAGE ' + n + '  ' + st.title + '   [1/2 SWITCH  R RESTART  P PAUSE]');
      this.updateHud();
      Sfx.resume(); Sfx.stopBgm(); Sfx.startBgm(this);
    },

    buildLevel: function(n){
      // 清旧砖
      this.bricks.clear(true, true);
      this.movingBricks = [];
      var st = STAGES[n-1];
      var layout = st.layout;
      var rows = layout.length;
      var cols = CFG.BRICK_COLS;
      var totalW = cols * CFG.BRICK_W + (cols-1)*CFG.BRICK_GAP;
      var startX = Math.floor((this.w - totalW)/2) + CFG.BRICK_W/2;
      var top = CFG.BRICK_TOP;
      var rowColors = ROW_COLORS[n-1] || ROW_COLORS[0];
      for(var r=0;r<rows;r++){
        for(var c=0;c<cols;c++){
          var v = layout[r][c];
          if(!v) continue;
          var x = startX + c*(CFG.BRICK_W+CFG.BRICK_GAP);
          var y = top + r*(CFG.BRICK_H+CFG.BRICK_GAP);
          var isMetal = (v===9);
          var hp = isMetal ? 99 : v; // 99=不可破坏
          var key = isMetal ? 'brick_metal' : 'brick';
          var b = this.physics.add.image(x, y, key);
          // staticGroup 会自动加 static body
          this.bricks.add(b);
          b.hp = hp;
          b.maxHp = hp;
          b.isMetal = isMetal;
          b.row = r; b.col = c;
          b.baseX = x; b.baseY = y;
          // 染色：非金属按行配色，耐久2的先深一档
          if(!isMetal){
            var col = rowColors[r % rowColors.length];
            if(hp===2){
              // 耐久2：加深（与 1 区分，首击后变浅）
              col = Phaser.Display.Color.Interpolate.ColorWithColor(
                Phaser.Display.Color.ValueToColor(col),
                Phaser.Display.Color.ValueToColor(0x000000),
                100, 28
              );
              // 上式返回对象，取 color
              b.setTint(col.color != null ? col.color : col);
            } else {
              b.setTint(col);
            }
            b.baseTint = col;
            // 耐久2叠裂纹
            if(hp===2){
              b.crack = this.add.image(x, y, 'brick_crack').setDepth(1).setAlpha(0.95);
            }
          } else {
            b.setTint(0xffffff);
          }
          // 移动砖标记
          var isMoving = false;
          for(var mi=0; mi<st.moving.length; mi++){
            if(st.moving[mi].r===r && st.moving[mi].c===c){ isMoving=true; break; }
          }
          if(isMoving){
            b.isMoving = true;
            b.moveDir = (c%2===0)?1:-1;
            b.moveRange = 48;
            b.moveSpeed = 42;
            this.movingBricks.push(b);
          }
        }
      }
      // 刷新物理
      this.physics.world.update(0,0);
    },

    resetPaddleAndBall: function(){
      // 挡板回中
      this.paddle.x = this.w/2;
      this.paddle.y = this.h - 42;
      this.paddleTargetX = this.paddle.x;
      this.updatePaddleSize(CFG.PADDLE_W);
      this.paddle.setVelocityX(0);
      // 清球
      var old = this.balls.getChildren().slice(0);
      for(var i=0;i<old.length;i++){ old[i].destroy(); }
      this.balls.clear(true, true);
      // 道具清屏
      var pws = this.powerups.getChildren().slice(0);
      for(var j=0;j<pws.length;j++){ pws[j].destroy(); }
      this.powerups.clear(true,true);
      this.trailPts = [];
      // 新球（粘在挡板上，ready 态跟随）
      this.spawnBall(this.paddle.x, this.paddle.y - 18, 0, 0, true);
    },

    spawnBall: function(x, y, vx, vy, stuck){
      var ball = this.physics.add.image(x, y, 'ball');
      ball.setCircle(CFG.BALL_R, 1, 1);
      ball.setBounce(1,1);
      ball.body.allowGravity = false;
      ball.setCollideWorldBounds(false);
      ball.stuck = __omp_shell("!stuck;")
      ball.trailCooldown = 0;
      if(!stuck){
        // 钳制速度
        var sp = Math.sqrt(vx*vx+vy*vy) || CFG.BALL_SPEED;
        var scale = CFG.BALL_SPEED / sp;
        if(sp > CFG.BALL_SPEED_MAX){ scale = CFG.BALL_SPEED_MAX/sp; }
        ball.setVelocity(vx*scale, vy*scale);
      } else {
        ball.setVelocity(0,0);
      }
      this.balls.add(ball);
      return ball;
    },

    launchBall: function(){
      var balls = this.balls.getChildren();
      var anyStuck=false;
      for(var i=0;i<balls.length;i++){
        var b=balls[i];
        if(!b.active || !b.stuck) continue;
        anyStuck=true;
        // 随机偏角 ±28°
        var ang = (Math.random()*56 - 28) * Math.PI/180;
        var sp = CFG.BALL_SPEED;
        var vx = Math.sin(ang)*sp;
        var vy = -Math.cos(ang)*sp;
        b.stuck=false;
        b.setVelocity(vx, vy);
      }
      if(anyStuck){ Sfx.play('hit'); this.gameState='playing'; this.hideCenter(); }
    },

    updatePaddleSize: function(w){
      w = Math.max(CFG.PADDLE_MIN_W, Math.min(CFG.PADDLE_MAX_W, w));
      this.paddleW = w;
      // 用 displayWidth 裁剪纹理宽度（纹理本身是 MAX_W+10 宽，居中裁）
      this.paddle.displayWidth = w;
      this.paddle.displayHeight = CFG.PADDLE_H;
      // 同步物理 body 宽度（arcade body 大小跟 displayWidth 不自动同步，需手动）
      if(this.paddle.body){
        this.paddle.body.setSize(w, CFG.PADDLE_H);
        this.paddle.body.updateFromGameObject();
      }
    },

    resetPowerups: function(){
      this.expandUntil=0; this.pierceUntil=0; this.slowUntil=0;
      this.isPiercing=false; this.isSlow=false;
    },


    // -----------------------------------------------------------------------
    // 砖块受伤/破碎
    // -----------------------------------------------------------------------
    hitBrick: function(brick, ball){
      if(!brick.active) return;
      if(brick.isMetal){
        Sfx.play('hit');
        this.shakeBrick(brick);
        this.spawnParticles(brick.x, brick.y, brick.tintTopLeft || 0xaaaaaa, 4);
        // 金属砖反弹球（仅翻转法线分量，简化：取入射方向反向）
        if(ball && !this.isPiercing){
          this.bounceOffBrick(ball, brick);
        }
        return;
      }
      // 穿透态：直接击碎不反弹
      if(this.isPiercing){
        this.breakBrick(brick, ball);
        return;
      }
      if(brick.hp===2){
        // 2→1：变色+去裂纹
        brick.hp=1;
        var rowColors = ROW_COLORS[this.stage-1] || ROW_COLORS[0];
        var col = rowColors[brick.row % rowColors.length];
        brick.setTint(col);
        if(brick.crack){ brick.crack.destroy(); brick.crack=null; }
        // 轻微抖动
        this.shakeBrick(brick);
        this.spawnParticles(brick.x, brick.y, col, 6);
        Sfx.play('hit');
        this.score += CFG.SCORE_HIT;
        this.updateHud();
        this.bounceOffBrick(ball, brick);
      } else {
        this.breakBrick(brick, ball);
      }
    },

    breakBrick: function(brick, ball){
      var col = brick.tintTopLeft || 0xffffff;
      this.spawnParticles(brick.x, brick.y, col, 10);
      // 掉落道具
      if(Math.random() < CFG.POWERUP_CHANCE){
        this.dropPowerup(brick.x, brick.y);
      }
      if(brick.crack){ brick.crack.destroy(); brick.crack=null; }
      brick.destroy();
      Sfx.play('break');
      this.score += CFG.SCORE_BREAK;
      this.updateHud();
      if(!this.isPiercing && ball){
        this.bounceOffBrick(ball, brick);
      }
      // 检查清关（仅可破坏砖）
      this.checkClear();
    },

    shakeBrick: function(brick){
      var ox=brick.x, oy=brick.y;
      this.tweens.add({ targets:brick, x:ox+2, duration:40, yoyo:true, repeat:1, ease:'Sine.easeInOut',
        onComplete: function(){ brick.x=ox; brick.y=oy; } });
    },

    spawnParticles: function(x, y, color, count){
      for(var i=0;i<count;i++){
        var pt = this.add.image(x, y, 'particle').setTint(color).setDepth(5);
        var ang = Math.random()*Math.PI*2;
        var sp = 80 + Math.random()*160;
        var vx=Math.cos(ang)*sp, vy=Math.sin(ang)*sp - 20;
        this.tweens.add({ targets:pt, x:x+vx*0.28, y:y+vy*0.28, alpha:0, duration:320+Math.random()*200, ease:'Cubic.easeOut',
          onComplete: function(){ pt.destroy(); } });
      }
    },

    bounceOffBrick: function(ball, brick){
      // 简化：根据球与砖中心差判断法线，翻转对应分量
      if(!ball || !ball.body) return;
      var dx = ball.x - brick.x;
      var dy = ball.y - brick.y;
      // 砖半尺寸
      var hw = CFG.BRICK_W/2, hh = CFG.BRICK_H/2;
      // 近似：比较 |dx|/hw 与 |dy|/hh，大的为主法线
      var nx = Math.abs(dx)/hw, ny = Math.abs(dy)/hh;
      if(nx > ny){
        ball.setVelocityX(-ball.body.velocity.x);
      } else {
        ball.setVelocityY(-ball.body.velocity.y);
      }
      // 钳制速度
      var vx=ball.body.velocity.x, vy=ball.body.velocity.y;
      var sp=Math.sqrt(vx*vx+vy*vy);
      if(sp > CFG.BALL_SPEED_MAX){
        var s=CFG.BALL_SPEED_MAX/sp; ball.setVelocity(vx*s, vy*s);
      } else if(sp < 40){
        ball.setVelocity(vx||60, vy||-CFG.BALL_SPEED);
      }
      // 轻微防粘连：推出
      if(nx > ny){
        ball.x += Math.sign(dx)*2;
      } else {
        ball.y += Math.sign(dy)*2;
      }
    },

    dropPowerup: function(x, y){
      var kind = POWER_TYPES[Math.floor(Math.random()*POWER_TYPES.length)];
      var key = 'power_' + kind;
      var pu = this.physics.add.image(x, y, key);
      pu.kind = kind;
      pu.body.allowGravity = false;
      pu.setVelocityY(CFG.POWERUP_FALL);
      pu.setDepth(6);
      this.powerups.add(pu);
      // 轻微左右摆动
      this.tweens.add({ targets:pu, x: x + (Math.random()<0.5? -10:10), duration:520, yoyo:true, repeat:-1, ease:'Sine.easeInOut' });
    },

    // -----------------------------------------------------------------------
    // 道具拾取（overlap 参数顺序无关：contains 判断）
    // -----------------------------------------------------------------------
    collectPowerup: function(a, b){
      // 参数顺序无关：哪个是 powerup 哪个是 paddle 不确定
      var pu = null, paddle = null;
      // 兼容：a/b 可能是 paddle 或 powerup
      if(a && a.kind && POWER_TYPES.indexOf(a.kind)!==-1) pu=a;
      else if(b && b.kind && POWER_TYPES.indexOf(b.kind)!==-1) pu=b;
      // 兜底：用 group.contains 判断（v4 回调首参为 group 外对象）
      if(!pu){
        try{
          if(this.powerups.contains(a)) pu=a;
          else if(this.powerups.contains(b)) pu=b;
          else if(a && a.getData) pu=a;
          else pu=b;
        }catch(e){ pu = a && a.kind ? a : b; }
      }
      if(!pu || !pu.active) return;
      // 确认 paddle 参与（可选）
      try{
        var isPaddleA = (a===this.paddle), isPaddleB=(b===this.paddle);
        if(!isPaddleA && !isPaddleB){
          // 若回调未包含 paddle，退化为距离判定
          if(Math.abs(pu.x - this.paddle.x) > this.paddleW/2 + 14) return;
          if(Math.abs(pu.y - this.paddle.y) > 22) return;
        }
      }catch(e){}
      var kind = pu.kind;
      pu.destroy();
      Sfx.play('powerup');
      this.applyPowerup(kind);
      this.updateHud();
    },

    applyPowerup: function(kind){
      if(kind==='expand'){
        this.updatePaddleSize(this.paddleW + 36);
        this.expandUntil = this.time.now + CFG.EXPAND_MS;
      } else if(kind==='multiball'){
        var balls=this.balls.getChildren().slice(0);
        // 以第一个活动球为模板分裂
        var src=null;
        for(var i=0;i<balls.length;i++){ if(balls[i].active && !balls[i].stuck){ src=balls[i]; break; } }
        if(!src && balls.length) src=balls[0];
        if(src){
          var vx=src.body ? src.body.velocity.x : 120;
          var vy=src.body ? src.body.velocity.y : -CFG.BALL_SPEED;
          var sp=Math.sqrt(vx*vx+vy*vy) || CFG.BALL_SPEED;
          // 两枚新球 ±32° 偏转
          var baseAng=Math.atan2(vy,vx);
          for(var k=0;k<2;k++){
            var ang = baseAng + (k===0 ? 0.56 : -0.56);
            var nsp = sp * (0.96 + Math.random()*0.08);
            this.spawnBall(src.x, src.y, Math.cos(ang)*nsp, Math.sin(ang)*nsp, false);
          }
        } else {
          // 无球时补一枚
          this.spawnBall(this.paddle.x, this.paddle.y-18, 0, 0, true);
        }
      } else if(kind==='pierce'){
        this.pierceUntil = this.time.now + CFG.PIERCE_MS;
        this.isPiercing = true;
        // 球染色
        var bs=this.balls.getChildren();
        for(var bi=0;bi<bs.length;bi++){ if(bs[bi].active) bs[bi].setTint(0xff8b8b); }
      } else if(kind==='slow'){
        this.slowUntil = this.time.now + CFG.SLOW_MS;
        this.isSlow = true;
        var bss=this.balls.getChildren();
        for(var bj=0;bj<bss.length;bj++){
          var bb=bss[bj];
          if(!bb.active || !bb.body) continue;
          bb.body.velocity.x *= 0.58;
          bb.body.velocity.y *= 0.58;
        }
      }
    },

    checkClear: function(){
      var ch=this.bricks.getChildren();
      var remain=0;
      for(var i=0;i<ch.length;i++){
        var br=ch[i];
        if(!br.active) continue;
        if(br.isMetal) continue;
        if(br.hp>0) remain++;
      }
      if(remain===0){
        this.onStageClear();
      }
    },

    onStageClear: function(){
      if(this.gameState==='stageClear') return;
      this.gameState='stageClear';
      Sfx.play('clear');
      Sfx.stopBgm();
      var isLast = (this.stage >= STAGES.length);
      if(isLast){
        this.centerText.setText('ALL CLEAR!\nSCORE ' + this.score).setVisible(true);
        this.subText.setText('PRESS  R  RESTART  |  1 / 2  SELECT STAGE').setVisible(true);
        this.saveProgress();
      } else {
        this.centerText.setText('STAGE ' + this.stage + ' CLEAR!').setVisible(true);
        this.subText.setText('PRESS  SPACE / CLICK  NEXT STAGE  |  R  RESTART').setVisible(true);
      }
      // 存档：最高分与通关
      this.saveProgress();
    },

    advanceStage: function(){
      if(this.stage < STAGES.length){
        this.startStage(this.stage+1);
      } else {
        this.goTitle();
      }
    },

    saveProgress: function(){
      if(this.score > (saveData.bestScore||0)) saveData.bestScore=this.score;
      if(this.stage > (saveData.clearedStage||0) && this.gameState==='stageClear'){
        // 仅当非最终关的 clear 也记，final clear 记全关
        var cleared = this.stage;
        // 若最后一关 clear，记为 STAGES.length
        saveData.clearedStage = Math.max(saveData.clearedStage||0, cleared);
      }
      try{
        if(hostRef && hostRef.saveState){
          hostRef.saveState({ bestScore: saveData.bestScore, clearedStage: saveData.clearedStage }).then(function(){}, function(){});
        }
      }catch(e){}
      this.updateHud();
    },

    onLifeLost: function(){
      this.lives--;
      Sfx.play('lose');
      this.updateHud();
      // 清道具残留
      var pws=this.powerups.getChildren().slice(0);
      for(var i=0;i<pws.length;i++) pws[i].destroy();
      this.cameras.main.shake(160, 0.006);
      if(this.lives <= 0){
        this.doGameOver();
        return;
      }
      // 扣命后重置挡板与单球（保留得分与关卡砖状态不重置，仅球与挡板）
      this.resetPowerups();
      this.updatePaddleSize(CFG.PADDLE_W);
      // 清多球留一枚 stuck
      var balls=this.balls.getChildren().slice(0);
      for(var bi=0; bi<balls.length; bi++) balls[bi].destroy();
      this.balls.clear(true,true);
      this.trailPts=[];
      this.spawnBall(this.paddle.x, this.paddle.y - 18, 0, 0, true);
      this.paddle.x = this.w/2; this.paddleTargetX=this.w/2;
      this.gameState='ready';
      this.centerText.setText('BALL LOST  \u2665 x' + this.lives).setVisible(true);
      this.subText.setText('PRESS  SPACE  TO LAUNCH').setVisible(true);
      this.time.delayedCall(900, function(){
        if(this.gameState==='ready'){ this.centerText.setVisible(false); this.subText.setVisible(false); }
      }, [], this);
    },

    doGameOver: function(){
      this.gameState='gameover';
      Sfx.stopBgm();
      Sfx.play('lose');
      this.saveProgress();
      this.centerText.setText('GAME OVER\nSCORE ' + this.score).setVisible(true);
      this.subText.setText('PRESS  R  RESTART  |  1 / 2  SELECT STAGE  |  ENTER  TITLE').setVisible(true);
    },

    goTitle: function(){
      // 回标题不立即清砖，保留视觉；下一次 startStage 会重建
      this.gameState='title';
      Sfx.stopBgm();
      this.resetPowerups();
      this.updatePaddleSize(CFG.PADDLE_W);
      // 清球与道具
      var balls=this.balls.getChildren().slice(0);
      for(var i=0;i<balls.length;i++) balls[i].destroy();
      this.balls.clear(true,true);
      var pws=this.powerups.getChildren().slice(0);
      for(var i=0;i<pws.length;i++) pws[i].destroy();
      this.powerups.clear(true,true);
      this.trailPts=[];
      // 重建第一关砖阵作标题背景（不清分，仅展示）
      this.buildLevel(1);
      this.paddle.x=this.w/2; this.paddle.y=this.h-42;
      this.spawnBall(this.paddle.x, this.paddle.y-18, 0, 0, true);
      this.renderTitle();
      this.updateHud();
    },


    // -----------------------------------------------------------------------
    // 每帧更新：输入 / 挡板 / 球物理 / 道具过期 / 移动砖 / 轨迹
    // -----------------------------------------------------------------------
    update: function(time, delta){
      // 标题态
      if(this.gameState==='title'){
        if(Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { Sfx.resume(); this.startStage(1); return; }
        if(Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { Sfx.resume(); this.startStage(2); return; }
        if(Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER)) { Sfx.resume(); this.startStage(1); return; }
        // 标题砖阵微动
        this.updateMovingBricks(delta);
        return;
      }
      if(this.gameState==='stageClear'){
        if(Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER)) { this.advanceStage(); return; }
        if(Phaser.Input.Keyboard.JustDown(this.keys.R)) { Sfx.resume(); this.startStage(this.stage); return; }
        if(Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { Sfx.resume(); this.startStage(1); return; }
        if(Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { Sfx.resume(); this.startStage(2); return; }
        return;
      }
      if(this.gameState==='gameover'){
        if(Phaser.Input.Keyboard.JustDown(this.keys.R) || Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER)) { Sfx.resume(); this.startStage(1); return; }
        if(Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { Sfx.resume(); this.startStage(1); return; }
        if(Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { Sfx.resume(); this.startStage(2); return; }
        if(Phaser.Input.Keyboard.JustDown(this.keys.ESC)) { this.goTitle(); return; }
        return;
      }
      // 暂停
      if(Phaser.Input.Keyboard.JustDown(this.keys.P)){
        if(this.gameState==='playing' || this.gameState==='ready'){
          this.gameState='paused';
          Sfx.stopBgm();
          this.centerText.setText('PAUSED').setVisible(true);
          this.subText.setText('PRESS  P  RESUME  |  R  RESTART').setVisible(true);
          return;
        } else if(this.gameState==='paused'){
          this.gameState='playing';
          // 若无活动球则回 ready
          var hasLive=false;
          var bs=this.balls.getChildren();
          for(var bi=0;bi<bs.length;bi++){ if(bs[bi].active && !bs[bi].stuck) hasLive=true; }
          if(!hasLive) this.gameState='ready';
          this.centerText.setVisible(false); this.subText.setVisible(false);
          Sfx.resume(); Sfx.startBgm(this);
          return;
        }
      }
      if(this.gameState==='paused'){
        if(Phaser.Input.Keyboard.JustDown(this.keys.R)){ Sfx.resume(); this.startStage(this.stage); }
        return;
      }
      // 关卡内 R 重开，1/2 切关
      if(Phaser.Input.Keyboard.JustDown(this.keys.R)){ Sfx.resume(); this.startStage(this.stage); return; }
      if(Phaser.Input.Keyboard.JustDown(this.keys.ONE)){ Sfx.resume(); this.startStage(1); return; }
      if(Phaser.Input.Keyboard.JustDown(this.keys.TWO)){ Sfx.resume(); this.startStage(2); return; }

      // 道具过期
      if(this.expandUntil && time > this.expandUntil){
        this.expandUntil=0;
        this.updatePaddleSize(CFG.PADDLE_W);
      }
      if(this.pierceUntil && time > this.pierceUntil){
        this.pierceUntil=0; this.isPiercing=false;
        var bss=this.balls.getChildren();
        for(var k=0;k<bss.length;k++){ if(bss[k].active) bss[k].clearTint(); }
      }
      if(this.slowUntil && time > this.slowUntil){
        this.slowUntil=0; this.isSlow=false;
        var bss2=this.balls.getChildren();
        for(var k2=0;k2<bss2.length;k2++){
          var bb=bss2[k2];
          if(!bb.active || !bb.body) continue;
          // 恢复：提速回正常（1/0.58）
          bb.body.velocity.x /= 0.58;
          bb.body.velocity.y /= 0.58;
          var sp=Math.sqrt(bb.body.velocity.x*bb.body.velocity.x+bb.body.velocity.y*bb.body.velocity.y);
          if(sp > CFG.BALL_SPEED_MAX){ var s=CFG.BALL_SPEED_MAX/sp; bb.body.velocity.x*=s; bb.body.velocity.y*=s; }
        }
      }

      // 移动砖
      this.updateMovingBricks(delta);

      // 挡板移动（键盘 + 鼠标跟随，键盘优先）
      var leftDown = this.keys.LEFT.isDown || this.keys.A.isDown || (this.cursors && this.cursors.left.isDown);
      var rightDown = this.keys.RIGHT.isDown || this.keys.D.isDown || (this.cursors && this.cursors.right.isDown);
      var targetX = this.paddle.x;
      var hasKeyboard = leftDown || rightDown;
      if(hasKeyboard){
        var dir = leftDown ? -1 : 1;
        targetX = this.paddle.x + dir * CFG.PADDLE_SPEED * delta / 1000;
      } else if(this.paddleTargetX != null){
        // 鼠标跟随：平滑趋近
        var diff = this.paddleTargetX - this.paddle.x;
        var maxStep = CFG.PADDLE_SPEED * delta / 1000;
        if(Math.abs(diff) <= maxStep) targetX = this.paddleTargetX;
        else targetX = this.paddle.x + Math.sign(diff)*maxStep;
      }
      var halfW = this.paddleW/2;
      targetX = Math.max(this.leftBound + halfW, Math.min(this.rightBound - halfW, targetX));
      this.paddle.x = targetX;
      if(this.paddle.body) this.paddle.body.updateFromGameObject();

      // ready 态球粘挡板
      if(this.gameState==='ready'){
        var stickBalls=this.balls.getChildren();
        for(var si=0; si<stickBalls.length; si++){
          var sb=stickBalls[si];
          if(!sb.active) continue;
          if(sb.stuck){
            sb.x = this.paddle.x;
            sb.y = this.paddle.y - 18;
            if(sb.body) sb.body.updateFromGameObject();
          }
        }
      }

      // 球物理：墙反弹 + 挡板 offset→角度 + 砖击 + 掉底 + 轨迹
      var balls=this.balls.getChildren().slice(0);
      for(var bi2=0; bi2<balls.length; bi2++){
        var ball=balls[bi2];
        if(!ball.active) continue;
        if(ball.stuck) continue;

        // 顶/左右墙反弹
        if(ball.y - CFG.BALL_R <= this.topBound){
          ball.y = this.topBound + CFG.BALL_R;
          ball.setVelocityY(Math.abs(ball.body.velocity.y));
          Sfx.play('hit');
        }
        if(ball.x - CFG.BALL_R <= this.leftBound){
          ball.x = this.leftBound + CFG.BALL_R;
          ball.setVelocityX(Math.abs(ball.body.velocity.x));
          Sfx.play('hit');
        } else if(ball.x + CFG.BALL_R >= this.rightBound){
          ball.x = this.rightBound - CFG.BALL_R;
          ball.setVelocityX(-Math.abs(ball.body.velocity.x));
          Sfx.play('hit');
        }

        // 挡板碰撞：AABB 检测，offset→角度（仅当球向下运动且进入挡板矩形）
        var vy = ball.body.velocity.y;
        if(vy > 0){
          var padL = this.paddle.x - this.paddleW/2;
          var padR = this.paddle.x + this.paddleW/2;
          var padT = this.paddle.y - CFG.PADDLE_H/2;
          var padB = this.paddle.y + CFG.PADDLE_H/2;
          if(ball.y + CFG.BALL_R >= padT && ball.y - CFG.BALL_R <= padB && ball.x >= padL - 2 && ball.x <= padR + 2){
            // 命中：按 offset 计算反弹角
            var offset = (ball.x - this.paddle.x) / (this.paddleW/2); // -1..1
            offset = Math.max(-1, Math.min(1, offset));
            // 最大偏角 62°
            var maxAng = 62 * Math.PI/180;
            var ang = offset * maxAng;
            var sp2 = Math.sqrt(ball.body.velocity.x*ball.body.velocity.x + ball.body.velocity.y*ball.body.velocity.y) || CFG.BALL_SPEED;
            // 减速态下 sp2 较小，保持之；否则钳制到 BALL_SPEED~MAX
            if(!this.isSlow) sp2 = Math.max(CFG.BALL_SPEED*0.92, Math.min(CFG.BALL_SPEED_MAX, sp2));
            var nvx = Math.sin(ang) * sp2;
            var nvy = -Math.cos(ang) * sp2;
            // 极端 0 附近给最小 x
            if(Math.abs(nvx) < 28) nvx = (offset>=0?28:-28);
            ball.setVelocity(nvx, nvy);
            ball.y = padT - CFG.BALL_R - 1;
            Sfx.play('hit');
            // 轨迹闪一下
            this.spawnTrailBurst(ball.x, ball.y);
          }
        }

        // 砖击：遍历（砖数≤48，开销可接受；用 AABB 粗判）
        var bricks=this.bricks.getChildren().slice(0);
        for(var r2=0; r2<bricks.length; r2++){
          var br=bricks[r2];
          if(!br.active) continue;
          // AABB
          var bw=CFG.BRICK_W/2, bh=CFG.BRICK_H/2;
          if(ball.x + CFG.BALL_R < br.x - bw) continue;
          if(ball.x - CFG.BALL_R > br.x + bw) continue;
          if(ball.y + CFG.BALL_R < br.y - bh) continue;
          if(ball.y - CFG.BALL_R > br.y + bh) continue;
          // 命中
          this.hitBrick(br, ball);
          // 穿透态可穿多砖，不 break；非穿透每帧只撞一块
          if(!this.isPiercing) break;
        }

        // 掉底（y 超 paddle 下方一定距离）
        if(ball.y - CFG.BALL_R > this.h + 24){
          ball.destroy();
        }

        // 轨迹点（每 34ms 一个）
        ball.trailCooldown = (ball.trailCooldown||0) - delta;
        if(ball.trailCooldown <= 0){
          ball.trailCooldown = 34;
          this.spawnTrail(ball.x, ball.y);
        }
      }

      // 道具下落与拾取
      var pus=this.powerups.getChildren().slice(0);
      for(var pi=0; pi<pus.length; pi++){
        var pu=pus[pi];
        if(!pu.active) continue;
        if(pu.y > this.h + 20){ pu.destroy(); continue; }
        // 拾取：与挡板 overlap（参数顺序无关，collectPowerup 内 contains 判断）
        var padL2 = this.paddle.x - this.paddleW/2;
        var padR2 = this.paddle.x + this.paddleW/2;
        var padT2 = this.paddle.y - CFG.PADDLE_H/2;
        var padB2 = this.paddle.y + CFG.PADDLE_H/2;
        if(pu.x >= padL2 - 10 && pu.x <= padR2 + 10 && pu.y + 11 >= padT2 && pu.y - 11 <= padB2){
          this.collectPowerup(pu, this.paddle);
        }
      }

      // 轨迹生命周期
      this.updateTrails(delta);

      // 若所有球掉光
      if(this.gameState==='playing' || this.gameState==='ready'){
        var alive=0, stuckCnt=0;
        var allB=this.balls.getChildren();
        for(var ai=0; ai<allB.length; ai++){
          if(!allB[ai].active) continue;
          alive++;
          if(allB[ai].stuck) stuckCnt++;
        }
        if(alive===0){
          this.onLifeLost();
        } else if(alive>0 && stuckCnt===alive && this.gameState==='playing'){
          // 全 stuck 但 state 仍 playing（极少），回 ready
          this.gameState='ready';
        }
      }
    },

    updateMovingBricks: function(delta){
      for(var i=0;i<this.movingBricks.length;i++){
        var b=this.movingBricks[i];
        if(!b.active) continue;
        b.x += b.moveDir * b.moveSpeed * delta/1000;
        if(b.x < b.baseX - b.moveRange){ b.x = b.baseX - b.moveRange; b.moveDir=1; }
        else if(b.x > b.baseX + b.moveRange){ b.x = b.baseX + b.moveRange; b.moveDir=-1; }
        if(b.body) b.body.updateFromGameObject();
        if(b.crack){ b.crack.x=b.x; b.crack.y=b.y; }
      }
    },

    spawnTrail: function(x, y){
      var t=this.add.image(x, y, 'trail').setDepth(4).setAlpha(0.42).setScale(0.75);
      this.trailPts.push({ spr:t, life: 220 });
    },
    spawnTrailBurst: function(x, y){
      for(var i=0;i<4;i++){
        var ang=Math.random()*Math.PI*2, r=2+Math.random()*6;
        var p=this.add.image(x+Math.cos(ang)*r, y+Math.sin(ang)*r, 'trail').setDepth(4).setAlpha(0.55).setScale(0.6);
        this.trailPts.push({ spr:p, life: 180 });
      }
    },
    updateTrails: function(delta){
      for(var i=this.trailPts.length-1; i>=0; i--){
        var tp=this.trailPts[i];
        tp.life -= delta;
        if(tp.life <= 0){ tp.spr.destroy(); this.trailPts.splice(i,1); }
        else { tp.spr.setAlpha( (tp.life/220)*0.42 ); tp.spr.setScale(0.75 * (0.5 + 0.5*tp.life/220)); }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 注册 — IIFE 末尾同步注册
  // ---------------------------------------------------------------------------
  function launch(host){
    hostRef = host;
    var w = host.width || CFG.W;
    var h = host.height || CFG.H;
    if(host.loadState){
      try{
        host.loadState().then(function(d){
          if(d && typeof d==='object'){
            if(typeof d.bestScore==='number') saveData.bestScore=d.bestScore;
            if(typeof d.clearedStage==='number') saveData.clearedStage=d.clearedStage;
          }
        }, function(){});
      }catch(e){}
    }
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.container,
      width: w,
      height: h,
      backgroundColor: STAGES[0].bg,
      physics: { default:'arcade', arcade:{ gravity:{y:0}, debug:false } },
      scene: [BootScene, BreakoutScene]
    });
    window.__trgame = { game: game, getState: getState, getScene: function(){ return sceneRef; } };
    window.__trgame.getSave = function(){ return { bestScore: saveData.bestScore, clearedStage: saveData.clearedStage }; };
    var tryBind=function(){
      try{
        var s=game.scene.getScene('Breakout');
        if(s) sceneRef=s;
      }catch(e){}
    };
    setTimeout(tryBind, 400);
    game.events.on('ready', tryBind);
    return game;
  }

  window.TRGames = window.TRGames || { register:function(){}, _r:{} };
  window.TRGames.register({ id:'breakout', title:'打砖块 Breakout', launch: launch });

})();
