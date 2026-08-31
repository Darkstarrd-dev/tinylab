// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改：
//   视觉（全为程序化几何，零外部贴图）：
//     generateTexture('ball')           直径 18 圆 白色描边 → 换成 this.load.image('ball','assets/ball.png')
//     generateTexture('bumper_off/on')  圆 橡皮柱 高光描边 → 换成 this.load.image('bumper','assets/bumper.png') + 亮灯版
//     generateTexture('flipperL/R')     矩形 挡板 圆角胶囊 → 换成 this.load.image('flipper','assets/flipper.png')
//     generateTexture('wall')           1x1 拉伸纯色 挡墙/斜坡占位 → 换成 this.load.image('wall','assets/wall.png')/瓦片
//     generateTexture('lamp_off/on')    小圆 灯珠 熄/亮 → 换成 this.load.spritesheet('lamp','assets/lamp.png',{frameWidth:20,frameHeight:20})
//     generateTexture('hole')           洞口 圆 环形阴影 → 换成 this.load.image('hole','assets/hole.png')
//     台面背景 this.add.graphics 逐台面 fillRect + 装饰线 → 换成 this.load.image('table1_bg','assets/table1.png') / 'table2_bg'
//     台面配色 TABLES[].bg / TABLES[].wallColor 色板 → 换成 不同背景贴图 + CSS 主题
//     挡板翻转注释点见下方“挡板翻转用角度tween”行，当前用 this.tweens.add({angle}) 驱动，将来换成 帧动画/骨骼只需替换该段
//   音频：
//     Sfx.play('hit'/'bumper'/'flipper'/'score'/'drain'/'hole'/'launch'/'bgm')
//       WebAudio oscillator+gain → 换成 this.load.audio('hit','assets/hit.wav')+this.sound.play(name)
//       文件顶部 Sfx 块已写“将来换”注释，BGM 用 time.addEvent 音阶序列，将来换 loop ogg
//   关卡：
//     TABLES 数组（每台面 障碍布局+配色+灯组）→ 换成 this.load.json('tables','assets/tables.json') 外部关卡表
//   纹理生成段落在 create() 中以“生成纹理”中文注释标出替换点。
// =============================================================================
(function () {
  'use strict';

  // ==========================================================================
  // 常量
  // ==========================================================================
  /** 场地像素（竖向台面居中） */
  var FIELD_X = 310;
  var FIELD_Y = 16;
  var FIELD_W = 340;
  var FIELD_H = 480;
  var FIELD_CX = FIELD_X + FIELD_W / 2;
  var FIELD_BOTTOM = FIELD_Y + FIELD_H;
  /** 球半径 px */
  var BALL_R = 9;
  /** 挡板规格 */
  var FLIP_LEN = 84;
  var FLIP_W = 13;
  var FLIP_PIVOT_Y = FIELD_BOTTOM - 68;
  var FLIP_LX = FIELD_X + 72;
  var FLIP_RX = FIELD_X + FIELD_W - 72;
  /** 挡板角度（deg） rest/active，左挡板以水平为0，上为正 */
  var FLIP_L_REST = -28;
  var FLIP_L_ACTIVE = 32;
  var FLIP_R_REST = 208; // 180 - FLIP_L_REST(28) = 208
  var FLIP_R_ACTIVE = 148; // 180 - 32
  var FLIP_TWEEN_MS = 68;
  var FLIP_TWEEN_BACK_MS = 90;
  /** 重力 px/s² 竖向台面 */
  var GRAVITY = 980;
  /** 摩擦/阻尼 每帧系数 */
  var FRICTION = 0.008;
  /** 弹柱半径 */
  var BUMPER_R = 18;
  /** 洞口半径 */
  var HOLE_R = 17;
  /** 灯珠半径 */
  var LAMP_R = 10;
  /** 斜坡厚度（虚拟碰撞厚度） */
  var SLOPE_THICK = 8;

  /** 台面定义：至少2台面，障碍布局与配色区分，台面2更多bumper与灯组
   *  将来换：改从 JSON 加载
   */
  var TABLES = [
    {
      id: 1, name: '台面 1 · 经典', bg: 0x0f2436, wallColor: 0x1e4a6b,
      // 3 bumper
      bumpers: [
        { x: FIELD_CX, y: 140 }, { x: FIELD_CX - 68, y: 210 }, { x: FIELD_CX + 68, y: 210 }
      ],
      // 2 灯
      lamps: [
        { x: FIELD_CX - 36, y: 98 }, { x: FIELD_CX + 36, y: 98 }
      ],
      // 斜坡（线段）
      slopes: [
        { x1: FIELD_X + 22, y1: 118, x2: FIELD_X + 96, y2: 62 },
        { x1: FIELD_X + FIELD_W - 22, y1: 118, x2: FIELD_X + FIELD_W - 96, y2: 62 }
      ],
      hole: { x: FIELD_CX, y: 300 }
    },
    {
      id: 2, name: '台面 2 · 灯阵', bg: 0x2a1430, wallColor: 0x7a2a8a,
      bumpers: [
        { x: FIELD_CX, y: 120 }, { x: FIELD_CX - 78, y: 175 }, { x: FIELD_CX + 78, y: 175 },
        { x: FIELD_CX - 44, y: 250 }, { x: FIELD_CX + 44, y: 250 }
      ],
      lamps: [
        { x: FIELD_CX - 58, y: 82 }, { x: FIELD_CX - 18, y: 82 }, { x: FIELD_CX + 18, y: 82 }, { x: FIELD_CX + 58, y: 82 },
        { x: FIELD_CX - 28, y: 112 }, { x: FIELD_CX + 28, y: 112 }
      ],
      slopes: [
        { x1: FIELD_X + 18, y1: 132, x2: FIELD_X + 90, y2: 58 },
        { x1: FIELD_X + FIELD_W - 18, y1: 132, x2: FIELD_X + FIELD_W - 90, y2: 58 },
        { x1: FIELD_X + 58, y1: 340, x2: FIELD_X + 128, y2: 298 },
        { x1: FIELD_X + FIELD_W - 58, y1: 340, x2: FIELD_X + FIELD_W - 128, y2: 298 }
      ],
      hole: { x: FIELD_CX + 64, y: 322 }
    }
  ];

  // ==========================================================================
  // 存档
  // ==========================================================================
  var hostRef = null;
  var sceneRef = null;
  var saveData = { hiScore: 0 };

  function getState() {
    if (!sceneRef) { return { scene: 'loading', score: 0, balls: 3, table: 1 }; }
    return { scene: sceneRef.phase || 'title', score: sceneRef.score || 0, balls: sceneRef.ballsLeft || 0, table: (sceneRef.curTableIdx || 0) + 1 };
  }

  // ==========================================================================
  // Sfx — WebAudio，将来换 this.load.audio
  // ==========================================================================
  var Sfx = {
    ctx: null, enabled: true,
    ensure: function () {
      if (this.ctx) { return this.ctx; }
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { this.enabled = false; return null; }
        this.ctx = new AC();
      } catch (e) { this.enabled = false; return null; }
      return this.ctx;
    },
    resume: function () {
      var c = this.ensure(); if (!c) { return; }
      if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    },
    play: function (name) {
      var c = this.ensure(); if (!c || !this.enabled) { return; }
      this.resume();
      try {
        var o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        var now = c.currentTime;
        if (name === 'hit') {
          o.type = 'square'; o.frequency.setValueAtTime(220, now);
          o.frequency.linearRampToValueAtTime(120, now + 0.08);
          g.gain.setValueAtTime(0.14, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.10);
          o.start(now); o.stop(now + 0.11);
        } else if (name === 'bumper') {
          o.type = 'sine'; o.frequency.setValueAtTime(680, now);
          o.frequency.linearRampToValueAtTime(1020, now + 0.10);
          g.gain.setValueAtTime(0.32, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
          o.start(now); o.stop(now + 0.27);
        } else if (name === 'flipper') {
          o.type = 'triangle'; o.frequency.setValueAtTime(180, now);
          o.frequency.setValueAtTime(520, now + 0.04);
          g.gain.setValueAtTime(0.20, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
          o.start(now); o.stop(now + 0.13);
        } else if (name === 'score') {
          o.type = 'sine'; o.frequency.setValueAtTime(700, now);
          o.frequency.linearRampToValueAtTime(1100, now + 0.12);
          g.gain.setValueAtTime(0.22, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
          o.start(now); o.stop(now + 0.21);
        } else if (name === 'hole') {
          o.type = 'sine'; o.frequency.setValueAtTime(300, now);
          o.frequency.linearRampToValueAtTime(620, now + 0.18);
          g.gain.setValueAtTime(0.26, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
          o.start(now); o.stop(now + 0.35);
        } else if (name === 'drain') {
          o.type = 'sawtooth'; o.frequency.setValueAtTime(180, now);
          o.frequency.linearRampToValueAtTime(60, now + 0.42);
          g.gain.setValueAtTime(0.28, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.52);
          o.start(now); o.stop(now + 0.53);
        } else if (name === 'launch') {
          o.type = 'square'; o.frequency.setValueAtTime(300, now);
          o.frequency.linearRampToValueAtTime(560, now + 0.14);
          g.gain.setValueAtTime(0.20, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
          o.start(now); o.stop(now + 0.23);
        }
      } catch (e) {}
    },
    _bgmTimer: null,
    startBgm: function (scene) {
      this.stopBgm();
      var self = this;
      // 将来换：this.load.audio('bgm','assets/bgm.ogg') + loop
      var seq = [0, 3, 7, 3, 0, -3, 0, 5];
      var base = 220;
      var idx = 0;
      this._bgmTimer = scene.time.addEvent({
        delay: 340, loop: true, callback: function () {
          var c2 = self.ensure(); if (!c2 || !self.enabled) { return; }
          try {
            var o2 = c2.createOscillator(), g2 = c2.createGain();
            o2.connect(g2); g2.connect(c2.destination);
            var now2 = c2.currentTime;
            var semi = seq[idx % seq.length]; idx++;
            var f = base * Math.pow(2, semi / 12);
            o2.type = 'triangle'; o2.frequency.setValueAtTime(f, now2);
            g2.gain.setValueAtTime(0.055, now2); g2.gain.exponentialRampToValueAtTime(0.001, now2 + 0.22);
            o2.start(now2); o2.stop(now2 + 0.23);
          } catch (e) {}
        }
      });
    },
    stopBgm: function () {
      if (this._bgmTimer) { try { this._bgmTimer.remove(false); } catch (e) {} this._bgmTimer = null; }
    }
  };

  // ==========================================================================
  // 工具：线段最近点 / 反射
  // ==========================================================================
  function closestOnSegment(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    if (len2 < 0.001) { return { x: x1, y: y1, t: 0 }; }
    var t = ((px - x1) * dx + (py - y1) * dy) / len2;
    if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
    return { x: x1 + dx * t, y: y1 + dy * t, t: t };
  }

  function segNormal(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) { return { x: 0, y: -1 }; }
    return { x: -dy / len, y: dx / len };
  }

  // ==========================================================================
  // 主场景
  // ==========================================================================
  var MainScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function MainScene() { Phaser.Scene.call(this, { key: 'Main' }); },

    init: function () {
      this.phase = 'title'; // title | playing | gameover
      this.curTableIdx = 0;
      this.score = 0;
      this.ballsLeft = 3;
      this.ballReady = true;
      this.holeCooldown = 0;
      this.holeCaptured = false;
      this.lampStates = [];
      this.walls = null;
      this.bumpers = null;
      this.bumperBodies = [];
      this.lampSprites = [];
      this.slopeLines = [];
      this.funnelLines = [];
      this.particles = null;
      this.flipperL = null;
      this.flipperR = null;
      this.ball = null;
      this.holeFx = null;
      this.holePos = { x: FIELD_CX, y: 300 };
    },

    create: function () {
      sceneRef = this;
      var W = this.sys.game.config.width;
      var H = this.sys.game.config.height;
      this.W = W; this.H = H;

      // 物理：竖向重力
      this.physics.world.gravity.y = GRAVITY;
      this.physics.world.setBounds(0, 0, W, H);
      this.physics.world.setBoundsCollision(false, false, false, false);

      // 背景
      this.bgRect = this.add.rectangle(W / 2, H / 2, W, H, 0x0a1620).setDepth(-20);
      // 台面底板（视觉几何 将来换贴图）
      this.tableBg = this.add.rectangle(FIELD_CX, FIELD_Y + FIELD_H / 2, FIELD_W, FIELD_H, 0x12314d).setDepth(-10);
      this.tableBg.setStrokeStyle(2, 0x3a6a9a, 1);
      // 台面内部网格线几何（注释替换点）
      this.tableGrid = this.add.graphics().setDepth(-9);

      // ---------------- 生成纹理（注释替换点：generateTexture 纯几何 → 将来换 image 资产） ----------------
      this.buildTextures();

      // 墙组与弹柱组（arcade 池化）
      this.walls = this.physics.add.staticGroup();
      this.bumpers = this.physics.add.staticGroup();
      // 粒子池（池化复用）
      this.particles = this.add.group({ maxSize: 32, runChildUpdate: false });

      // 洞口视觉
      this.holeFx = this.add.image(FIELD_CX, 300, 'hole').setDepth(2).setVisible(false);
      this.holeRing = this.add.graphics().setDepth(3);

      // 挡板（视觉矩形，物理手动）
      this.flipperL = this.add.image(FLIP_LX, FLIP_PIVOT_Y, 'flipper').setOrigin(0.14, 0.5).setDepth(6);
      this.flipperR = this.add.image(FLIP_RX, FLIP_PIVOT_Y, 'flipper').setOrigin(0.86, 0.5).setDepth(6);
      this.flipperL.angle = FLIP_L_REST;
      this.flipperR.angle = FLIP_R_REST;
      // 记录上帧角度用于速度估计
      this.flipLPrev = FLIP_L_REST;
      this.flipRPrev = FLIP_R_REST;
      this.flipLAngVel = 0;
      this.flipRAngVel = 0;

      // 球（arcade 速度+墙反弹+摩擦）
      this.ball = this.physics.add.image(FIELD_CX, FLIP_PIVOT_Y - 86, 'ball');
      this.ball.setCircle(BALL_R);
      this.ball.setBounce(0.78, 0.78);
      this.ball.setCollideWorldBounds(false);
      this.ball.setDepth(5);
      // 轻微线性阻尼模拟摩擦（arcade 无原生，手动每帧衰减）
      try { this.ball.body.setDrag(18, 18); } catch (e) {}
      this.ball.setVisible(false);

      // 碰撞：球 vs 墙 / 弹柱（参数顺序无关 contains 判断）
      var self = this;
      this.physics.add.collider(this.ball, this.walls, function (a, b) {
        // 顺序无关：a/b 任意是球
        var ball = (a === self.ball ? a : (b === self.ball ? b : null));
        if (!ball) {
          // group 情况用 contains 回退
          ball = self.ball;
        }
        Sfx.play('hit');
        self.spawnHitFx(ball.x, ball.y, 0x8ec8ff);
        self.addScore(5);
      });
      this.physics.add.collider(this.ball, this.bumpers, function (a, b) {
        // Phaser v4 overlap/collider 参数顺序与 v3 不同，用 contains 保证无关
        var bumper = null;
        var ball2 = null;
        if (self.bumpers.contains(a)) { bumper = a; ball2 = b; }
        else if (self.bumpers.contains(b)) { bumper = b; ball2 = a; }
        else {
          // 回退：球是 this.ball
          if (a === self.ball) { ball2 = a; bumper = b; } else { ball2 = b; bumper = a; }
        }
        if (!bumper || !ball2 || !ball2.active) { return; }
        self.onBumperHit(bumper, ball2);
      });

      // 输入
      this.keys = this.input.keyboard.addKeys('LEFT,RIGHT,SHIFT,SPACE,ONE,TWO,R,P');
      this.input.keyboard.on('keydown-SPACE', function () { Sfx.resume(); });
      this.input.keyboard.on('keydown-SHIFT', function () { Sfx.resume(); });

      // HUD
      this.hudScore = this.add.text(FIELD_X + FIELD_W + 22, 26, 'SCORE 0', { fontSize: '18px', color: '#e6f0ff', fontStyle: '700' }).setOrigin(0, 0);
      this.hudHi = this.add.text(FIELD_X + FIELD_W + 22, 50, 'HI 0', { fontSize: '13px', color: '#8fb0d0' }).setOrigin(0, 0);
      this.hudBalls = this.add.text(FIELD_X + FIELD_W + 22, 74, 'BALL x3', { fontSize: '14px', color: '#ffd66b' }).setOrigin(0, 0);
      this.hudTable = this.add.text(FIELD_X + FIELD_W + 22, 98, 'TABLE 1', { fontSize: '13px', color: '#9ad8ff' }).setOrigin(0, 0);
      this.hudLamps = this.add.text(FIELD_X + FIELD_W + 22, 122, 'LAMPS 0/0', { fontSize: '12px', color: '#a0ffca' }).setOrigin(0, 0);
      this.tipText = this.add.text(FIELD_CX, H - 14, 'SHIFT / ←→ 翻板  |  SPACE 发球  |  1/2 换台', { fontSize: '11px', color: '#6a8aaa' }).setOrigin(0.5, 0.5);
      this.centerText = this.add.text(W / 2, H / 2 - 10, '', { fontSize: '22px', color: '#ffffff', align: 'center', fontStyle: '800' }).setOrigin(0.5).setDepth(20).setVisible(false);
      this.subText = this.add.text(W / 2, H / 2 + 34, '', { fontSize: '12px', color: '#b7d6f3', align: 'center' }).setOrigin(0.5).setDepth(20).setVisible(false);

      // 遮罩（弹球台上方说明）
      this.dim = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.42).setDepth(15).setVisible(false);

      // 初次建表
      this.buildTable(0);
      this.updateHud();
      this.showTitle();

      // 存档加载
      this.loadHiScore();

      // 启动 BGM（标题也播，playing 切换不重建）
      Sfx.startBgm(this);
    },

    // ----------------------------------------------------------------------
    // 生成纹理（几何占位，将来换位图）
    // ----------------------------------------------------------------------
    buildTextures: function () {
      var g;
      function rm(key) { try { if (this.textures.exists(key)) { this.textures.remove(key); } } catch (e) {} }
      var self = this;
      function rmk(k) { rm.call(self, k); }
      // 球
      rmk('ball'); g = this.add.graphics(); g.fillStyle(0xffffff, 1); g.fillCircle(BALL_R, BALL_R, BALL_R); g.lineStyle(2, 0x8ec8ff, 1); g.strokeCircle(BALL_R, BALL_R, BALL_R); g.fillStyle(0xffffff, 0.95); g.fillCircle(BALL_R - 3, BALL_R - 3, 3); g.generateTexture('ball', BALL_R * 2 + 2, BALL_R * 2 + 2); g.destroy();
      // 橡皮柱 熄
      rmk('bumper_off'); g = this.add.graphics(); g.fillStyle(0xd94a4a, 1); g.fillCircle(BUMPER_R, BUMPER_R, BUMPER_R); g.fillStyle(0xff8a8a, 1); g.fillCircle(BUMPER_R - 5, BUMPER_R - 6, 6); g.lineStyle(3, 0xffffff, 0.9); g.strokeCircle(BUMPER_R, BUMPER_R, BUMPER_R); g.generateTexture('bumper_off', BUMPER_R * 2 + 2, BUMPER_R * 2 + 2); g.destroy();
      // 橡皮柱 亮（高分闪）
      rmk('bumper_on'); g = this.add.graphics(); g.fillStyle(0xffe066, 1); g.fillCircle(BUMPER_R, BUMPER_R, BUMPER_R); g.fillStyle(0xffffff, 1); g.fillCircle(BUMPER_R - 5, BUMPER_R - 5, 5); g.lineStyle(3, 0xffffff, 1); g.strokeCircle(BUMPER_R, BUMPER_R, BUMPER_R); g.generateTexture('bumper_on', BUMPER_R * 2 + 2, BUMPER_R * 2 + 2); g.destroy();
      // 挡板
      rmk('flipper'); g = this.add.graphics(); g.fillStyle(0xffd54f, 1); g.fillRoundedRect(0, 0, FLIP_LEN, FLIP_W, 6); g.fillStyle(0xfff6b0, 1); g.fillRoundedRect(2, 2, FLIP_LEN - 4, 4, 3); g.lineStyle(1.5, 0x7a5a00, 0.95); g.strokeRoundedRect(0, 0, FLIP_LEN, FLIP_W, 6); g.generateTexture('flipper', FLIP_LEN, FLIP_W); g.destroy();
      // 挡墙 1x1
      rmk('wall'); g = this.add.graphics(); g.fillStyle(0xffffff, 1); g.fillRect(0, 0, 1, 1); g.generateTexture('wall', 1, 1); g.destroy();
      // 灯 熄/亮
      rmk('lamp_off'); g = this.add.graphics(); g.fillStyle(0x2a3a4a, 1); g.fillCircle(LAMP_R, LAMP_R, LAMP_R); g.fillStyle(0x3a5166, 1); g.fillCircle(LAMP_R, LAMP_R, LAMP_R - 3); g.lineStyle(1, 0x5a7a96, 1); g.strokeCircle(LAMP_R, LAMP_R, LAMP_R); g.generateTexture('lamp_off', LAMP_R * 2, LAMP_R * 2); g.destroy();
      rmk('lamp_on'); g = this.add.graphics(); g.fillStyle(0xffe066, 1); g.fillCircle(LAMP_R, LAMP_R, LAMP_R); g.fillStyle(0xffffff, 1); g.fillCircle(LAMP_R - 3, LAMP_R - 3, 4); g.lineStyle(1.5, 0xffffff, 1); g.strokeCircle(LAMP_R, LAMP_R, LAMP_R); g.generateTexture('lamp_on', LAMP_R * 2, LAMP_R * 2); g.destroy();
      // 洞口
      rmk('hole'); g = this.add.graphics(); g.fillStyle(0x0a0f18, 1); g.fillCircle(HOLE_R, HOLE_R, HOLE_R); g.lineStyle(2.5, 0x6ecbff, 0.9); g.strokeCircle(HOLE_R, HOLE_R, HOLE_R); g.fillStyle(0x1a2a3a, 0.9); g.fillCircle(HOLE_R, HOLE_R, HOLE_R - 7); g.generateTexture('hole', HOLE_R * 2, HOLE_R * 2); g.destroy();
      // 粒子
      rmk('spark'); g = this.add.graphics(); g.fillStyle(0xffffff, 1); g.fillCircle(3, 3, 3); g.generateTexture('spark', 6, 6); g.destroy();
    },

    // ----------------------------------------------------------------------
    // 建表（按 TABLES 索引重建障碍/配色/灯组）
    // ----------------------------------------------------------------------
    buildTable: function (idx) {
      var t = TABLES[idx];
      this.curTableIdx = idx;
      // 配色
      this.tableBg.setFillStyle(t.bg, 1);
      this.tableBg.setStrokeStyle(2, t.wallColor, 1);
      this.bgRect.setFillStyle(Phaser.Display.Color.IntegerToColor(t.bg).clone().darken(32).color, 1);
      // 网格装饰（几何 将来换贴图）
      this.tableGrid.clear();
      this.tableGrid.lineStyle(1, t.wallColor, 0.22);
      for (var gx = FIELD_X + 24; gx < FIELD_X + FIELD_W; gx += 28) {
        this.tableGrid.moveTo(gx, FIELD_Y + 10); this.tableGrid.lineTo(gx, FIELD_Y + FIELD_H - 10);
      }
      for (var gy = FIELD_Y + 24; gy < FIELD_Y + FIELD_H; gy += 28) {
        this.tableGrid.moveTo(FIELD_X + 10, gy); this.tableGrid.lineTo(FIELD_X + FIELD_W - 10, gy);
      }
      this.tableGrid.strokePath();

      // 清旧墙/柱/灯
      this.walls.clear(true, true);
      this.bumpers.clear(true, true);
      this.bumperBodies = [];
      for (var li = 0; li < this.lampSprites.length; li++) { try { this.lampSprites[li].destroy(); } catch (e) {} }
      this.lampSprites = [];
      this.slopeLines = t.slopes.slice(0);
      this.funnelLines = [];
      this.lampStates = [];

      // 外墙（左/右/顶）—— 静态矩形 arcade
      var wallThick = 10;
      var left = this.walls.create(FIELD_X + wallThick / 2, FIELD_Y + FIELD_H / 2, 'wall');
      left.setDisplaySize(wallThick, FIELD_H); left.refreshBody(); left.setTint(t.wallColor); left.setDepth(1);
      var right = this.walls.create(FIELD_X + FIELD_W - wallThick / 2, FIELD_Y + FIELD_H / 2, 'wall');
      right.setDisplaySize(wallThick, FIELD_H); right.refreshBody(); right.setTint(t.wallColor); right.setDepth(1);
      var top = this.walls.create(FIELD_CX, FIELD_Y + wallThick / 2, 'wall');
      top.setDisplaySize(FIELD_W, wallThick); top.refreshBody(); top.setTint(t.wallColor); top.setDepth(1);
      // 上方两短墙形成发射口两侧（视觉）
      // 下方漏斗斜坡为手动线段（非 arcade，避免旋转 AABB 问题）
      this.funnelLines.push({ x1: FIELD_X + wallThick, y1: FIELD_BOTTOM - 22, x2: FLIP_LX - 10, y2: FLIP_PIVOT_Y + 10 });
      this.funnelLines.push({ x1: FIELD_X + FIELD_W - wallThick, y1: FIELD_BOTTOM - 22, x2: FLIP_RX + 10, y2: FLIP_PIVOT_Y + 10 });
      // 底部排水口两侧短墙（防止球卡墙外）
      var botL = this.walls.create(FIELD_X + 42, FIELD_BOTTOM - 10, 'wall');
      botL.setDisplaySize(84, wallThick); botL.refreshBody(); botL.setTint(t.wallColor); botL.setDepth(1);
      var botR = this.walls.create(FIELD_X + FIELD_W - 42, FIELD_BOTTOM - 10, 'wall');
      botR.setDisplaySize(84, wallThick); botR.refreshBody(); botR.setTint(t.wallColor); botR.setDepth(1);

      // 弹柱（池化静态组）
      for (var bi = 0; bi < t.bumpers.length; bi++) {
        var bp = t.bumpers[bi];
        var b = this.bumpers.create(bp.x, bp.y, 'bumper_off');
        b.setCircle(BUMPER_R); // 圆形体
        b.refreshBody();
        b.setDepth(4);
        b._idx = bi;
        this.bumperBodies.push(b);
      }

      // 灯组
      for (var li2 = 0; li2 < t.lamps.length; li2++) {
        var lp = t.lamps[li2];
        var ls = this.add.image(lp.x, lp.y, 'lamp_off').setDepth(4);
        this.lampSprites.push(ls);
        this.lampStates.push(false);
      }

      // 洞口（视觉+逻辑）
      this.holePos = { x: t.hole.x, y: t.hole.y };
      this.holeFx.setPosition(t.hole.x, t.hole.y).setVisible(true).setDepth(2);
      this.holeRing.clear();
      this.holeRing.lineStyle(2, 0x6ecbff, 0.75);
      this.holeRing.strokeCircle(t.hole.x, t.hole.y, HOLE_R + 3);

      // 刷新 HUD 台面名
      this.hudTable.setText(t.name);
      this.updateHud();
    },

    // ----------------------------------------------------------------------
    // 弹柱命中（高分弹开）
    // ----------------------------------------------------------------------
    onBumperHit: function (bumper, ball) {
      if (this.phase !== 'playing') { return; }
      // 高分
      this.addScore(500);
      Sfx.play('bumper');
      // 视觉闪亮（池化纹理切换）
      try { bumper.setTexture('bumper_on'); } catch (e) {}
      var self = this;
      this.time.delayedCall(140, function () { try { bumper.setTexture('bumper_off'); } catch (e2) {} });
      // 额外弹开：沿法线加脉冲
      var nx = ball.x - bumper.x, ny = ball.y - bumper.y;
      var d = Math.sqrt(nx * nx + ny * ny);
      if (d < 0.001) { nx = 0; ny = -1; d = 1; }
      nx /= d; ny /= d;
      var v = ball.body.velocity;
      var dot = v.x * nx + v.y * ny;
      // 反射并增强
      var boost = 420;
      var nvx = v.x - 2 * dot * nx + nx * boost;
      var nvy = v.y - 2 * dot * ny + ny * boost;
      // 限幅
      var sp = Math.sqrt(nvx * nvx + nvy * nvy);
      var maxSp = 720;
      if (sp > maxSp) { nvx *= maxSp / sp; nvy *= maxSp / sp; }
      ball.setVelocity(nvx, nvy);
      // 轻微位移防粘连：传送用 body.reset（参数顺序无关，坐标传入）
      try { ball.body.reset(ball.x + nx * 3, ball.y + ny * 3); ball.setVelocity(nvx, nvy); } catch (e) {}
      this.spawnHitFx(bumper.x, bumper.y, 0xffe066);
      // 灯组点亮进度
      this.lightNextLamp();
    },

    lightNextLamp: function () {
      for (var i = 0; i < this.lampStates.length; i++) {
        if (!this.lampStates[i]) {
          this.lampStates[i] = true;
          try { this.lampSprites[i].setTexture('lamp_on'); } catch (e) {}
          this.spawnHitFx(this.lampSprites[i].x, this.lampSprites[i].y, 0xa0ffca);
          Sfx.play('score');
          this.addScore(200);
          break;
        }
      }
      // 全部点亮 → 奖励并重置
      var all = true;
      for (var j = 0; j < this.lampStates.length; j++) { if (!this.lampStates[j]) { all = false; break; } }
      if (all && this.lampStates.length > 0) {
        this.addScore(3000);
        Sfx.play('score');
        this.flashLampsBonus();
      }
      this.updateHud();
    },

    flashLampsBonus: function () {
      var self = this;
      var lamps = this.lampSprites.slice(0);
      var count = 0;
      var ev = this.time.addEvent({
        delay: 90, loop: true, callback: function () {
          count++;
          var on = (count % 2 === 0);
          for (var k = 0; k < lamps.length; k++) { try { lamps[k].setTexture(on ? 'lamp_on' : 'lamp_off'); } catch (e) {} }
          if (count >= 6) {
            ev.remove(false);
            for (var k2 = 0; k2 < self.lampStates.length; k2++) { self.lampStates[k2] = false; try { self.lampSprites[k2].setTexture('lamp_off'); } catch (e2) {} }
            self.updateHud();
          }
        }
      });
    },

    // ----------------------------------------------------------------------
    // 粒子（池化）
    // ----------------------------------------------------------------------
    allocParticle: function () {
      var p = this.particles.getFirstDead(false);
      if (!p) {
        if (this.particles.getLength() >= 32) {
          p = this.particles.getFirstAlive(false);
          if (p) { try { p.setVisible(false); p.setActive(false); } catch (e) {} }
          else { return null; }
        } else {
          p = this.add.image(0, 0, 'spark');
          this.particles.add(p);
        }
      }
      p.setActive(true).setVisible(true).setAlpha(1).setScale(1).setDepth(8);
      return p;
    },

    spawnHitFx: function (x, y, color) {
      for (var i = 0; i < 4; i++) {
        var sp = this.allocParticle();
        if (!sp) { break; }
        sp.setPosition(x, y).setTint(color);
        var ang = (Math.PI * 2 * i) / 4 + Math.random() * 0.6;
        var dist = 18 + Math.random() * 18;
        this.tweens.add({ targets: sp, x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist, alpha: 0, scale: 0.4, duration: 260, ease: 'Quad.easeOut', onComplete: function (tw, targets) { var s = targets[0]; try { s.setActive(false).setVisible(false); } catch (e) {} } });
      }
    },

    // ----------------------------------------------------------------------
    // 计分 / HUD
    // ----------------------------------------------------------------------
    addScore: function (v) {
      this.score += v;
      this.updateHud();
      // 轻微分数弹出
      var t = this.add.text(this.ball.x, this.ball.y - 18, '+' + v, { fontSize: '13px', color: '#ffe066', fontStyle: '700' }).setOrigin(0.5).setDepth(9);
      this.tweens.add({ targets: t, y: t.y - 22, alpha: 0, duration: 520, ease: 'Quad.easeOut', onComplete: function () { try { t.destroy(); } catch (e) {} } });
    },

    updateHud: function () {
      if (!this.hudScore) { return; }
      this.hudScore.setText('SCORE ' + this.score);
      if (saveData.hiScore) { this.hudHi.setText('HI ' + saveData.hiScore); }
      this.hudBalls.setText('BALL x' + this.ballsLeft);
      var on = 0; for (var i = 0; i < this.lampStates.length; i++) { if (this.lampStates[i]) { on++; } }
      this.hudLamps.setText('LAMPS ' + on + '/' + this.lampStates.length);
    },

    // ----------------------------------------------------------------------
    // 标题 / 开始 / GameOver
    // ----------------------------------------------------------------------
    showTitle: function () {
      this.phase = 'title';
      this.dim.setVisible(true);
      this.centerText.setText('微软 PINBALL').setVisible(true);
      this.subText.setText('SPACE 发球  |  SHIFT / ←→ 翻板  |  1 / 2 换台面  |  R 重开\n3 球机会 · 洞口吸球加分吐球 · 点亮灯组高分').setVisible(true);
      if (saveData.hiScore) { this.hudHi.setText('HI ' + saveData.hiScore); }
      // 球隐藏在发射位
      this.resetBallToLaunch(false);
      this.ball.setVisible(false);
      Sfx.stopBgm(); Sfx.startBgm(this);
    },

    startPlay: function () {
      if (this.phase === 'playing') { return; }
      this.phase = 'playing';
      this.dim.setVisible(false);
      this.centerText.setVisible(false);
      this.subText.setVisible(false);
      this.score = 0;
      this.ballsLeft = 3;
      this.ballReady = true;
      this.holeCaptured = false;
      this.holeCooldown = 0;
      for (var i = 0; i < this.lampStates.length; i++) { this.lampStates[i] = false; try { this.lampSprites[i].setTexture('lamp_off'); } catch (e) {} }
      this.resetBallToLaunch(true);
      this.updateHud();
      Sfx.startBgm(this);
    },

    doGameOver: function () {
      this.phase = 'gameover';
      this.dim.setVisible(true);
      this.centerText.setText('GAME OVER\nSCORE ' + this.score).setVisible(true);
      this.subText.setText('R 重开  |  1 / 2 换台面  |  SPACE 再来一局\nHI ' + (saveData.hiScore || 0)).setVisible(true);
      try { this.ball.setVelocity(0, 0); } catch (e) {}
      this.saveHi();
      Sfx.stopBgm(); Sfx.play('drain');
    },

    saveHi: function () {
      if (this.score > (saveData.hiScore || 0)) {
        saveData.hiScore = this.score;
        try { if (hostRef && hostRef.saveState) { hostRef.saveState({ hiScore: saveData.hiScore }).then(function () {}, function () {}); } } catch (e) {}
        this.updateHud();
      }
    },

    loadHiScore: function () {
      var self = this;
      if (hostRef && hostRef.loadState) {
        try {
          hostRef.loadState().then(function (d) { if (d && typeof d.hiScore === 'number') { saveData.hiScore = d.hiScore; self.hudHi.setText('HI ' + saveData.hiScore); if (self.phase === 'title') { self.subText.setText('SPACE 发球  |  SHIFT / ←→ 翻板  |  1 / 2 换台面  |  R 重开\n3 球机会 · 洞口吸球加分吐球 · 点亮灯组高分\nHI ' + saveData.hiScore); } } }, function () {});
        } catch (e) {}
      }
    },

    // ----------------------------------------------------------------------
    // 球发射 / 重置（传送均用 body.reset，参数顺序无关 — 坐标为 x,y）
    // ----------------------------------------------------------------------
    resetBallToLaunch: function (visible) {
      var lx = FIELD_CX;
      var ly = FLIP_PIVOT_Y - 56;
      try { this.ball.body.reset(lx, ly); } catch (e) { this.ball.x = lx; this.ball.y = ly; }
      this.ball.setVelocity(0, 0);
      this.ball.setVisible(!!visible);
      this.ballReady = true;
      this.holeCaptured = false;
      this.holeCooldown = 500;
    },

    launchBall: function () {
      if (this.phase !== 'playing' || !this.ballReady) { return; }
      var vx = (Math.random() - 0.5) * 140;
      var vy = -640 - Math.random() * 120;
      this.ball.setVisible(true);
      try { this.ball.body.reset(this.ball.x, this.ball.y); } catch (e) {}
      this.ball.setVelocity(vx, vy);
      this.ballReady = false;
      Sfx.play('launch');
    },

    loseBall: function () {
      Sfx.play('drain');
      this.spawnHitFx(this.ball.x, Math.min(this.ball.y, FIELD_BOTTOM - 6), 0xff6b6b);
      this.ballsLeft--;
      this.updateHud();
      if (this.ballsLeft <= 0) {
        this.doGameOver();
        return;
      }
      // 短暂停再吐球
      var self = this;
      try { this.ball.setVelocity(0, 0); this.ball.setVisible(false); } catch (e) {}
      this.time.delayedCall(520, function () {
        if (self.phase !== 'playing') { return; }
        self.resetBallToLaunch(true);
      });
    },

    // ----------------------------------------------------------------------
    // 洞口吸球→吐球
    // ----------------------------------------------------------------------
    tryHoleCapture: function () {
      if (this.holeCaptured || this.ballReady) { return; }
      if (this.holeCooldown > 0) { return; }
      var dx = this.ball.x - this.holePos.x;
      var dy = this.ball.y - this.holePos.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > HOLE_R + 2) { return; }
      // 吸住：需速度不太大，避免高速穿过误吸？这里阈值放宽保证手感
      var v = this.ball.body.velocity;
      var sp = Math.sqrt(v.x * v.x + v.y * v.y);
      if (sp > 820) { return; }
      // 捕获
      this.holeCaptured = true;
      this.addScore(2000);
      Sfx.play('hole');
      this.spawnHitFx(this.holePos.x, this.holePos.y, 0x6ecbff);
      // 拉向中心
      try { this.ball.setVelocity(0, 0); } catch (e) {}
      var self = this;
      this.tweens.add({
        targets: this.ball, x: this.holePos.x, y: this.holePos.y, scale: 0.72, duration: 220, ease: 'Quad.easeIn',
        onComplete: function () {
          try { self.ball.setVisible(false); } catch (e) {}
          self.time.delayedCall(420, function () {
            // 吐球：从洞口上方吐出，给上抛速度
            var ex = self.holePos.x + (Math.random() - 0.5) * 22;
            var ey = self.holePos.y - 30;
            try { self.ball.body.reset(ex, ey); } catch (e2) { self.ball.x = ex; self.ball.y = ey; }
            self.ball.setScale(1).setVisible(true);
            self.ball.setVelocity((Math.random() - 0.5) * 220, -420 - Math.random() * 120);
            self.holeCaptured = false;
            self.holeCooldown = 900;
            Sfx.play('launch');
          });
        }
      });
    },

    // ----------------------------------------------------------------------
    // 挡板翻转（角度tween 注释替换点）
    // ----------------------------------------------------------------------
    updateFlippers: function () {
      var leftDown = false, rightDown = false;
      try {
        leftDown = !!(this.keys.LEFT.isDown || this.keys.SHIFT.isDown);
        // 右挡板支持 SHIFT 也同时触发，保证单键可玩；左右键分区更精细
        rightDown = !!(this.keys.RIGHT.isDown || this.keys.SHIFT.isDown);
        // 若同时按左右，左右各动；若只按 SHIFT 则双动（街机手感）
        if (this.keys.SHIFT.isDown) { leftDown = true; rightDown = true; }
        if (this.keys.LEFT.isDown && !this.keys.RIGHT.isDown && !this.keys.SHIFT.isDown) { rightDown = false; }
        if (this.keys.RIGHT.isDown && !this.keys.LEFT.isDown && !this.keys.SHIFT.isDown) { leftDown = false; }
      } catch (e) {}

      var targetL = leftDown ? FLIP_L_ACTIVE : FLIP_L_REST;
      var targetR = rightDown ? FLIP_R_ACTIVE : FLIP_R_REST;

      // 挡板翻转用角度tween（注释替换点：将来到帧动画/骨骼只改此处段）
      if (Math.abs(this.flipperL.angle - targetL) > 0.5) {
        var needL = leftDown;
        try { this.tweens.killTweensOf(this.flipperL); } catch (e) {}
        // 将来换：帧动画则改成 this.flipperL.play(needL?'flip_up':'flip_down')
        this.tweens.add({ targets: this.flipperL, angle: targetL, duration: needL ? FLIP_TWEEN_MS : FLIP_TWEEN_BACK_MS, ease: needL ? 'Quad.easeOut' : 'Quad.easeIn' });
        if (needL) { Sfx.play('flipper'); }
      }
      if (Math.abs(this.flipperR.angle - targetR) > 0.5) {
        var needR = rightDown;
        try { this.tweens.killTweensOf(this.flipperR); } catch (e2) {}
        this.tweens.add({ targets: this.flipperR, angle: targetR, duration: needR ? FLIP_TWEEN_MS : FLIP_TWEEN_BACK_MS, ease: needR ? 'Quad.easeOut' : 'Quad.easeIn' });
        // 右挡板音与左共用，避免双次播放
      }

      // 记录角速度（deg/帧 → rad/s 近似）
      this.flipLAngVel = this.flipperL.angle - this.flipLPrev;
      this.flipRAngVel = this.flipperR.angle - this.flipRPrev;
      this.flipLPrev = this.flipperL.angle;
      this.flipRPrev = this.flipperR.angle;
    },

    // 挡板 vs 球 手动碰撞（arcade 无旋转体，手动线段最近点+反射）
    handleFlipperBall: function () {
      if (!this.ball.visible || this.ballReady || this.holeCaptured) { return; }
      this._checkOneFlipper(this.flipperL, this.flipLAngVel);
      this._checkOneFlipper(this.flipperR, this.flipRAngVel);
    },

    _checkOneFlipper: function (flip, angVelDeg) {
      var rad = flip.angle * Math.PI / 180;
      var px, py, len = FLIP_LEN;
      // pivot 按 origin 计算：L origin 0.14，R origin 0.86
      var isLeft = (flip === this.flipperL);
      var ox = isLeft ? 0.14 : 0.86;
      var pivotX = flip.x + (0.5 - ox) * len * Math.cos(rad) + (0) * Math.sin(rad);
      // 简化：pivot 近似为 flip.x, flip.y 附近，利用 origin 近零位移近似，直接以 flip.x,y 为 pivot 做短修正
      // 更稳：直接以翻板中心反推 pivot 误差 < 4px，不影响手感
      var cx = flip.x, cy = flip.y;
      var half = len * 0.5;
      // 用角度求线段两端：从 pivot 端到 tip 端
      var p1x, p1y, p2x, p2y;
      if (isLeft) {
        var offL = (0.5 - 0.14) * len;
        // pivot = center - offL * dir
        var dirx = Math.cos(rad), diry = Math.sin(rad);
        p1x = cx - dirx * offL; p1y = cy - diry * offL;
        p2x = p1x + dirx * len; p2y = p1y + diry * len;
      } else {
        var offR = (0.86 - 0.5) * len;
        var dirx2 = Math.cos(rad), diry2 = Math.sin(rad);
        p1x = cx + dirx2 * offR; p1y = cy + diry2 * offR;
        p2x = p1x - dirx2 * len; p2y = p1y - diry2 * len;
      }
      var bx = this.ball.x, by = this.ball.y;
      var clo = closestOnSegment(bx, by, p1x, p1y, p2x, p2y);
      var dx = bx - clo.x, dy = by - clo.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var need = BALL_R + FLIP_W * 0.5 + 1;
      if (d >= need) { return; }
      var nx, ny;
      if (d < 0.001) { var n = segNormal(p1x, p1y, p2x, p2y); nx = n.x; ny = n.y; d = 1; } else { nx = dx / d; ny = dy / d; }
      // 将球推出穿透
      var push = need - d + 1.2;
      var nbx = bx + nx * push, nby = by + ny * push;
      var v = this.ball.body.velocity;
      var dot = v.x * nx + v.y * ny;
      // 反射 + 挡板角速度加成（翻打瞬间高分弹开手感在）
      var kick = Math.abs(angVelDeg) * 14; // deg→px/s 近似
      if (kick < 60) { kick = 60; }
      // 若挡板正向上翻（angVel 与法线同向），额外加成
      var sign = (angVelDeg > 1.5 || angVelDeg < -1.5) ? 1 : 0.55;
      var newDot = -dot;
      // 弹性系数
      var bounce = 0.92 + sign * 0.38;
      // 计算反射后速度：v' = v - (1+bounce)*dot*n
      var nvx = v.x - (1 + bounce) * dot * nx;
      var nvy = v.y - (1 + bounce) * dot * ny;
      // 追加挡板法向 kick
      nvx += nx * kick * (0.9 + sign * 0.6);
      nvy += ny * kick * (0.9 + sign * 0.6);
      // 轻微切向摩擦
      var tx = -ny, ty = nx;
      var tdot = v.x * tx + v.y * ty;
      nvx += tx * tdot * 0.08;
      nvy += ty * tdot * 0.08;
      // 限幅
      var sp = Math.sqrt(nvx * nvx + nvy * nvy);
      if (sp > 820) { nvx *= 820 / sp; nvy *= 820 / sp; }
      // 传送修正：必须用 body.reset，参数顺序无关（x,y），避免下一帧被 body 覆盖
      try { this.ball.body.reset(nbx, nby); this.ball.setVelocity(nvx, nvy); } catch (e) { this.ball.x = nbx; this.ball.y = nby; this.ball.setVelocity(nvx, nvy); }
      if (Math.abs(angVelDeg) > 1.2) { Sfx.play('hit'); this.spawnHitFx(clo.x, clo.y, 0xffe066); }
    },

    // 斜坡/漏斗 线段碰撞（手动）
    handleSlopeBall: function () {
      if (!this.ball.visible || this.ballReady || this.holeCaptured) { return; }
      var lines = this.slopeLines.concat(this.funnelLines);
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var clo = closestOnSegment(this.ball.x, this.ball.y, ln.x1, ln.y1, ln.x2, ln.y2);
        var dx = this.ball.x - clo.x, dy = this.ball.y - clo.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        var need = BALL_R + SLOPE_THICK * 0.5;
        if (d >= need) { continue; }
        var nx, ny;
        if (d < 0.001) { var n = segNormal(ln.x1, ln.y1, ln.x2, ln.y2); nx = n.x; ny = n.y; d = 1; } else { nx = dx / d; ny = dy / d; }
        var push = need - d + 0.8;
        var nbx = this.ball.x + nx * push, nby = this.ball.y + ny * push;
        var v = this.ball.body.velocity;
        var dot = v.x * nx + v.y * ny;
        if (dot > 0) { continue; } // 远离则不处理
        var bounce = 0.86;
        var nvx = v.x - (1 + bounce) * dot * nx;
        var nvy = v.y - (1 + bounce) * dot * ny;
        try { this.ball.body.reset(nbx, nby); this.ball.setVelocity(nvx, nvy); } catch (e) { this.ball.x = nbx; this.ball.y = nby; this.ball.setVelocity(nvx, nvy); }
        Sfx.play('hit');
        break; // 每帧只处理一条，避免抖动
      }
    },

    // ----------------------------------------------------------------------
    // 每帧
    // ----------------------------------------------------------------------
    update: function (time, delta) {
      // 标题/结束态输入
      if (this.phase === 'title') {
        if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ONE) || Phaser.Input.Keyboard.JustDown(this.keys.TWO) || Phaser.Input.Keyboard.JustDown(this.keys.R)) {
          Sfx.resume();
          if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { this.buildTable(1); }
          else if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { this.buildTable(0); }
          this.startPlay();
          return;
        }
        if (Phaser.Input.Keyboard.JustDown(this.keys.P)) { return; }
        return;
      }
      if (this.phase === 'gameover') {
        if (Phaser.Input.Keyboard.JustDown(this.keys.R) || Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) { Sfx.resume(); this.buildTable(this.curTableIdx); this.startPlay(); return; }
        if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { Sfx.resume(); this.buildTable(0); this.startPlay(); return; }
        if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { Sfx.resume(); this.buildTable(1); this.startPlay(); return; }
        return;
      }
      if (this.phase !== 'playing') { return; }

      // 换台（游戏中按 1/2 切台重开本台）
      if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { Sfx.resume(); this.buildTable(0); this.startPlay(); return; }
      if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { Sfx.resume(); this.buildTable(1); this.startPlay(); return; }
      if (Phaser.Input.Keyboard.JustDown(this.keys.R)) { Sfx.resume(); this.buildTable(this.curTableIdx); this.startPlay(); return; }

      // 发球
      if (this.ballReady && Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) { this.launchBall(); }

      // 挡板翻转
      this.updateFlippers();

      // 若球未发射，不做物理
      if (this.ballReady || !this.ball.visible) {
        // 冷却递减
        if (this.holeCooldown > 0) { this.holeCooldown -= delta; if (this.holeCooldown < 0) { this.holeCooldown = 0; } }
        return;
      }

      // 摩擦（轻微阻尼，已有 drag，再叠加）
      // arcade 速度+墙反弹+摩擦：这里补摩擦系数
      var v = this.ball.body.velocity;
      var damp = Math.pow(1 - FRICTION, delta / 16);
      this.ball.setVelocity(v.x * damp, v.y * damp);

      // 挡板/斜坡 手动碰撞（翻打手感在：角速度→脉冲）
      this.handleFlipperBall();
      this.handleSlopeBall();

      // 洞口吸球（吸球加分后吐球）
      this.tryHoleCapture();
      if (this.holeCaptured) {
        if (this.holeCooldown > 0) { this.holeCooldown -= delta; }
        return;
      }

      // 冷却
      if (this.holeCooldown > 0) { this.holeCooldown -= delta; if (this.holeCooldown < 0) { this.holeCooldown = 0; } }

      // 边界反弹补丁：顶/左右墙穿透时反射（外墙 collider 已有，此处兜底防卡墙外）
      if (this.ball.x < FIELD_X + BALL_R + 4) {
        if (v.x < 0) { this.ball.setVelocity(Math.abs(v.x) * 0.86, v.y); try { this.ball.body.reset(FIELD_X + BALL_R + 6, this.ball.y); this.ball.setVelocity(Math.abs(v.x) * 0.86, v.y); } catch (e) {} Sfx.play('hit'); }
      }
      if (this.ball.x > FIELD_X + FIELD_W - BALL_R - 4) {
        if (v.x > 0) { this.ball.setVelocity(-Math.abs(v.x) * 0.86, v.y); try { this.ball.body.reset(FIELD_X + FIELD_W - BALL_R - 6, this.ball.y); this.ball.setVelocity(-Math.abs(v.x) * 0.86, v.y); } catch (e) {} Sfx.play('hit'); }
      }
      if (this.ball.y < FIELD_Y + BALL_R + 4) {
        if (v.y < 0) { this.ball.setVelocity(v.x, Math.abs(v.y) * 0.86); try { this.ball.body.reset(this.ball.x, FIELD_Y + BALL_R + 6); this.ball.setVelocity(v.x, Math.abs(v.y) * 0.86); } catch (e) {} Sfx.play('hit'); }
      }

      // 掉底洞扣球（球掉底洞判定：y 超过台面底且 x 在排水口区间）
      if (this.ball.y > FIELD_BOTTOM + 26) {
        this.loseBall();
        return;
      }
      // 卡死兜底：球长时间速度过小且不在发射位，轻推
      var sp2 = Math.sqrt(v.x * v.x + v.y * v.y);
      if (sp2 < 18 && !this.ballReady && !this.holeCaptured) {
        this.ball.setVelocity((Math.random() - 0.5) * 120, -80 - Math.random() * 40);
      }
    }
  });

  // ==========================================================================
  // 注册（IIFE+TRGames.register+Phaser v4.2.1，id==目录名）
  // ==========================================================================
  window.TRGames = window.TRGames || { register: function () {}, _r: {} };
  window.TRGames.register({
    id: 'pinball',
    title: '微软 Pinball 弹球',
    launch: function (host) {
      hostRef = host;
      var W = host.width || 960;
      var H = host.height || 540;
      if (host.loadState) {
        try { host.loadState().then(function (d) { if (d && typeof d.hiScore === 'number') { saveData.hiScore = d.hiScore; } }, function () {}); } catch (e) {}
      }
      var game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host.container,
        width: W,
        height: H,
        backgroundColor: '#0a1620',
        physics: { default: 'arcade', arcade: { gravity: { y: GRAVITY }, debug: false } },
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
scene: [MainScene]
      });
      sceneRef = null;
      var tryBind = function () { try { var s = game.scene.getScene('Main'); if (s) { sceneRef = s; } } catch (e) {} };
      setTimeout(tryBind, 400);
      game.events.on('ready', tryBind);
      window.__trgame = { game: game, getState: getState, getScene: function () { return sceneRef; } };
      window.__trgame.getSave = function () { return { hiScore: saveData.hiScore }; };
      return game;
    }
  });

})();
