// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改：
//   视觉：
//     generateTexture('block_I'/'block_O'/'block_T'/'block_S'/'block_Z'/'block_J'/'block_L'/'block_G') 纯色+高光描边纹理
//       → 换成  this.load.image('block_I','assets/block_I.png')  等 7 种方块贴图 + 垃圾行贴图
//     generateTexture('block_ghost') 半透明虚影
//       → 换成  this.load.image('block_ghost','assets/block_ghost.png')
//     场网格 add.graphics 网格线 + 背景矩形
//       → 换成  this.load.image('board_bg','assets/board_bg.png') + tileSprite 网格
//     关卡配色 STAGES[].bg / STAGES[].grid 双档位色板
//       → 换成  this.load.image('bg_stage1','assets/bg_stage1.png') / 'bg_stage2'
//   音频：
//     Sfx.play('move'/'rotate'/'lock'/'soft'/'hard'/'clear'/'tetris'/'hold'/'bgm') 内部
//       WebAudio oscillator+gain → 换成 this.load.audio('move','assets/move.wav')+this.sound.play
//       文件顶部 Sfx 块已写替换写法注释。
//   关卡：
//     STAGES 数组 + GARBAGE 行随机生成 → 换成 Tiled/JSON 关卡配置：this.load.json('stages','assets/stages.json')
//   纹理生成段落在 create() 中以“生成纹理”中文注释标出替换点。
// =============================================================================
(function () {
  'use strict';

  // ==========================================================================
  // 顶部可调参数（带单位）—— 中文注释 + 英文 HUD 文本
  // ==========================================================================
  /** 列数 10 */
  var COLS = 10;
  /** 行数 20 */
  var ROWS = 20;
  /** 单格边长 px */
  var CELL = 24;
  /** 棋盘像素宽 px */
  var BOARD_W = COLS * CELL;
  /** 棋盘像素高 px */
  var BOARD_H = ROWS * CELL;
  /** 棋盘左上角 x（居中） px — host 960 宽时约 360 */
  var BOARD_X = 360;
  /** 棋盘左上角 y px */
  var BOARD_Y = 28;
  /** 锁定延迟 ms（触底后仍可微调） */
  var LOCK_DELAY = 420;
  /** 行消除闪烁时长 ms */
  var CLEAR_FLASH_MS = 180;
  /** DAS 延迟 ms（长按左右首响） */
  var DAS_DELAY = 160;
  /** ARR 重复间隔 ms（长按左右连发） */
  var ARR_INTERVAL = 48;
  /** 软降重复间隔 ms */
  var SOFT_INTERVAL = 42;

  // ==========================================================================
  // 方块定义：7种 + 垃圾行，形状为 4 旋转状态每状态 4 个 [x,y]（4x4 坐标系）
  //  坐标系说明：每块在一个 4x4 盒内定义，(0,0) 为盒左上角，x→右 y→下
  //  围墙踢：简化 SRS，仅在 x±1 / y±1 的 1 格范围内尝试
  // ==========================================================================
  var PIECE_TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  // 颜色（十六进制）
  var COLORS = {
    I: 0x00E5FF,
    O: 0xFFD500,
    T: 0xA259FF,
    S: 0x00E676,
    Z: 0xFF3D57,
    J: 0x2979FF,
    L: 0xFF9100,
    G: 0x5F6B7A // 垃圾行
  };
  // 形状：每种 4 个旋转
  var SHAPES = {
    I: [
      [[0, 1], [1, 1], [2, 1], [3, 1]],
      [[2, 0], [2, 1], [2, 2], [2, 3]],
      [[0, 2], [1, 2], [2, 2], [3, 2]],
      [[1, 0], [1, 1], [1, 2], [1, 3]]
    ],
    O: [
      [[1, 1], [2, 1], [1, 2], [2, 2]],
      [[1, 1], [2, 1], [1, 2], [2, 2]],
      [[1, 1], [2, 1], [1, 2], [2, 2]],
      [[1, 1], [2, 1], [1, 2], [2, 2]]
    ],
    T: [
      [[1, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [1, 1], [2, 1], [1, 2]],
      [[0, 1], [1, 1], [2, 1], [1, 2]],
      [[1, 0], [0, 1], [1, 1], [1, 2]]
    ],
    S: [
      [[1, 0], [2, 0], [0, 1], [1, 1]],
      [[1, 0], [1, 1], [2, 1], [2, 2]],
      [[1, 0], [2, 0], [0, 1], [1, 1]],
      [[1, 0], [1, 1], [2, 1], [2, 2]]
    ],
    Z: [
      [[0, 0], [1, 0], [1, 1], [2, 1]],
      [[2, 0], [1, 1], [2, 1], [1, 2]],
      [[0, 0], [1, 0], [1, 1], [2, 1]],
      [[2, 0], [1, 1], [2, 1], [1, 2]]
    ],
    J: [
      [[0, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [2, 0], [1, 1], [1, 2]],
      [[0, 1], [1, 1], [2, 1], [2, 2]],
      [[1, 0], [1, 1], [0, 2], [1, 2]]
    ],
    L: [
      [[2, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [1, 1], [1, 2], [2, 2]],
      [[0, 1], [1, 1], [2, 1], [0, 2]],
      [[0, 0], [1, 0], [1, 1], [1, 2]]
    ]
  };

  // 围墙踢偏移表（简化 SRS：1 格尝试）—— 按优先级尝试
  var KICKS = [
    [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1]
  ];

  // 关卡/段位配置：速度档位 + 配色区分
  var STAGES = [
    { id: 1, name: 'STAGE 1', bg: 0x0f172a, grid: 0x1e293b, wall: 0x334155, label: 'STAGE 1  NORMAL', startLevel: 1, garbage: 0, dropBase: 760 },
    { id: 2, name: 'STAGE 2', bg: 0x1e0f1a, grid: 0x3a1a2e, wall: 0x6b2d4a, label: 'STAGE 2  FAST+GARBAGE', startLevel: 3, garbage: 4, dropBase: 420 }
  ];

  // ==========================================================================
  // 存档与宿主
  // ==========================================================================
  var hostRef = null;
  var sceneRef = null;
  var saveData = { hiScore: 0 };

  function getState() {
    if (!sceneRef) { return { scene: 'title', score: 0, level: 1, lines: 0, board: [] }; }
    // 深拷贝 board 供外部检查
    var b = [];
    try {
      for (var r = 0; r < ROWS; r++) { b[r] = sceneRef.board[r].slice(0); }
    } catch (e) { b = []; }
    return {
      scene: sceneRef.gameState,
      score: sceneRef.score,
      level: sceneRef.level,
      lines: sceneRef.lines,
      board: b
    };
  }

  // ==========================================================================
  // 音频：WebAudio 振荡器 — 将来替换为 this.load.audio + this.sound.play
  //  替换写法：
  //    this.load.audio('move','assets/move.wav');
  //    this.sound.play('move');
  // ==========================================================================
  var Sfx = {
    ctx: null,
    bgmTimer: null,
    ensure: function () {
      if (this.ctx) { return; }
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { this.ctx = new AC(); }
      } catch (e) {}
    },
    tone: function (freq, durMs, type, vol, slideTo) {
      try {
        this.ensure();
        if (!this.ctx) { return; }
        var ctx = this.ctx;
        if (ctx.state === 'suspended') { ctx.resume(); }
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        if (slideTo) {
          o.frequency.linearRampToValueAtTime(slideTo, ctx.currentTime + durMs / 1000);
        }
        g.gain.value = vol != null ? vol : 0.18;
        g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + durMs / 1000);
        o.connect(g); g.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + durMs / 1000);
      } catch (e) {}
    },
    play: function (name) {
      // 保证 AudioContext 已创建（需用户手势后）
      this.ensure();
      if (name === 'move') { this.tone(320, 70, 'square', 0.08); }
      else if (name === 'rotate') { this.tone(520, 80, 'square', 0.10); }
      else if (name === 'soft') { this.tone(180, 60, 'sine', 0.06); }
      else if (name === 'hard') { this.tone(260, 120, 'square', 0.13); this.tone(380, 120, 'square', 0.10); }
      else if (name === 'lock') { this.tone(140, 100, 'triangle', 0.12); }
      else if (name === 'hold') { this.tone(420, 90, 'sine', 0.11); }
      else if (name === 'clear') { this.tone(480, 110, 'sine', 0.14); this.tone(640, 140, 'sine', 0.12); }
      else if (name === 'tetris') { this.tone(520, 130, 'square', 0.14); var self=this; setTimeout(function(){ self.tone(680,160,'square',0.14); },110); setTimeout(function(){ self.tone(880,220,'square',0.15); },260); }
      else if (name === 'gameover') { this.tone(220, 400, 'sawtooth', 0.13, 80); }
      else if (name === 'levelup') { this.tone(600, 140, 'sine', 0.13); var s2=this; setTimeout(function(){ s2.tone(800,180,'sine',0.13); },150); }
    },
    startBgm: function () {
      this.stopBgm();
      var self = this;
      // 简易循环 BGM：每 1.9s 播放一段小旋律
      var pattern = [220, 260, 330, 260, 294, 330, 392, 330];
      var idx = 0;
      this.bgmTimer = setInterval(function () {
        if (!self.ctx) { return; }
        var f = pattern[idx % pattern.length];
        self.tone(f, 160, 'triangle', 0.045);
        idx++;
      }, 190);
    },
    stopBgm: function () {
      if (this.bgmTimer) { clearInterval(this.bgmTimer); this.bgmTimer = null; }
    }
  };

  // ==========================================================================
  // 主场景
  // ==========================================================================
  var MainScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function MainScene() {
      Phaser.Scene.call(this, { key: 'Main' });
    },

    preload: function () {
      // 纯几何，无需 preload；纹理在 create 中生成
    },

    create: function () {
      sceneRef = this;
      this.gameState = 'title'; // title | playing | clearFlash | paused | gameover
      this.curStageIdx = 0; // 0->STAGE1, 1->STAGE2
      this.score = 0;
      this.level = 1;
      this.lines = 0;
      this.combo = -1; // -1 表示无连消
      this.board = [];
      this.active = null; // {type, rot, x, y}
      this.ghostY = 0;
      this.nextQueue = [];
      this.bag = [];
      this.holdType = null;
      this.holdUsed = false;
      this.dropTimer = 0;
      this.lockTimer = 0;
      this.dropInterval = 760;
      this.clearRows = [];
      this.flashTween = null;

      // 长按计时
      this.dasDir = 0;
      this.dasTimer = 0;
      this.arrTimer = 0;
      this.softTimer = 0;

      // 棋盘像素原点（居中）
      this.bx = BOARD_X;
      this.by = BOARD_Y;

      // 背景
      this.cameras.main.setBackgroundColor('#0b1220');
      this.bgRect = this.add.rectangle(480, 270, 960, 540, STAGES[0].bg).setDepth(-10);
      // 棋盘外框与网格（几何）
      this.boardBg = this.add.rectangle(this.bx + BOARD_W / 2, this.by + BOARD_H / 2, BOARD_W + 4, BOARD_H + 4, 0x0a0f1e).setStrokeStyle(2, STAGES[0].wall).setDepth(-2);
      this.gridGfx = this.add.graphics().setDepth(-1);
      this.drawGrid(STAGES[0].grid);

      // ======================================================================
      // 生成纹理 — 方块纯色+高光描边 + 方块纹理 场网格几何（替换点中文注释）
      //   将来替换：把本段 generateTexture 全部换成 this.load.image('block_I','assets/block_I.png') 等
      // ======================================================================
      this.createBlockTextures();

      // 池化：棋盘块池 + 活动块 + 影子 + 预览
      //  用 Group 池化复用 Image，避免每帧新建
      this.blockPool = this.add.group();
      this.activeImages = [];
      this.ghostImages = [];
      for (var i = 0; i < 4; i++) {
        var ai = this.add.image(0, 0, 'block_T').setOrigin(0).setVisible(false).setDepth(5);
        var gi = this.add.image(0, 0, 'block_ghost').setOrigin(0).setVisible(false).setDepth(2).setAlpha(0.38);
        this.activeImages.push(ai);
        this.ghostImages.push(gi);
      }
      // 预创建棋盘池 200 个
      this.poolCells = [];
      for (var p = 0; p < 200; p++) {
        var img = this.add.image(-100, -100, 'block_I').setOrigin(0).setVisible(false).setDepth(3);
        this.blockPool.add(img);
        this.poolCells.push(img);
      }
      // 闪烁覆盖层（行消除闪烁 tween）
      this.flashRects = [];
      for (var fr = 0; fr < ROWS; fr++) {
        var r = this.add.rectangle(this.bx + BOARD_W / 2, this.by + fr * CELL + CELL / 2, BOARD_W, CELL, 0xffffff, 0).setDepth(6).setVisible(false);
        this.flashRects.push(r);
      }

      // HUD 文本（英文游戏内文本，中文注释）
      var tf = { fontFamily: 'monospace', fontSize: '14px', color: '#e2e8f0' };
      var tfDim = { fontFamily: 'monospace', fontSize: '12px', color: '#94a3b8' };
      var tfBig = { fontFamily: 'monospace', fontSize: '18px', color: '#f8fafc', fontStyle: 'bold' };
      // 左侧信息栏
      this.hudHoldLabel = this.add.text(28, 22, 'HOLD', tfDim);
      this.hudHoldBox = this.add.rectangle(86, 76, 88, 64, 0x111827).setStrokeStyle(1, 0x334155);
      this.holdPreview = [];
      for (var h = 0; h < 4; h++) { this.holdPreview.push(this.add.image(0, 0, 'block_T').setOrigin(0).setVisible(false).setDepth(4).setScale(0.62)); }
      this.hudScore = this.add.text(28, 132, 'SCORE  0', tfBig);
      this.hudLines = this.add.text(28, 158, 'LINES  0', tf);
      this.hudLevel = this.add.text(28, 180, 'LEVEL  1', tf);
      this.hudStage = this.add.text(28, 202, 'STAGE 1', tf);
      this.hudHi = this.add.text(28, 224, 'HI  0', tfDim);
      // 右侧 NEXT 队列 3 个预览
      this.hudNextLabel = this.add.text(742, 22, 'NEXT', tfDim);
      this.nextBoxes = [];
      this.nextPreviews = []; // 3 组每组 4 块
      for (var n = 0; n < 3; n++) {
        var ny = 52 + n * 78;
        var box = this.add.rectangle(812, ny + 26, 88, 64, 0x111827).setStrokeStyle(1, 0x334155);
        this.nextBoxes.push(box);
        var grp = [];
        for (var k = 0; k < 4; k++) { grp.push(this.add.image(0, 0, 'block_T').setOrigin(0).setVisible(false).setDepth(4).setScale(0.62)); }
        this.nextPreviews.push(grp);
      }
      // 操作提示
      this.hudHelp = this.add.text(28, 500, 'ARROWS MOVE  UP/Z ROT  DOWN SOFT  SPACE HARD  C HOLD  P PAUSE', { fontFamily: 'monospace', fontSize: '11px', color: '#64748b' });
      this.hudHelp2 = this.add.text(742, 500, '1:STAGE1  2:STAGE2', { fontFamily: 'monospace', fontSize: '11px', color: '#64748b' });

      // 居中大字
      this.centerText = this.add.text(480, 270, '', { fontFamily: 'monospace', fontSize: '22px', color: '#f8fafc', align: 'center', fontStyle: 'bold', stroke: '#0f172a', strokeThickness: 4 }).setOrigin(0.5).setDepth(20).setVisible(false);
      this.subText = this.add.text(480, 308, '', { fontFamily: 'monospace', fontSize: '12px', color: '#cbd5e1', align: 'center' }).setOrigin(0.5).setDepth(20).setVisible(false);

      // 输入
      this.keys = this.input.keyboard.addKeys({
        LEFT: Phaser.Input.Keyboard.KeyCodes.LEFT,
        RIGHT: Phaser.Input.Keyboard.KeyCodes.RIGHT,
        DOWN: Phaser.Input.Keyboard.KeyCodes.DOWN,
        UP: Phaser.Input.Keyboard.KeyCodes.UP,
        A: Phaser.Input.Keyboard.KeyCodes.A,
        D: Phaser.Input.Keyboard.KeyCodes.D,
        S: Phaser.Input.Keyboard.KeyCodes.S,
        W: Phaser.Input.Keyboard.KeyCodes.W,
        Z: Phaser.Input.Keyboard.KeyCodes.Z,
        X: Phaser.Input.Keyboard.KeyCodes.X,
        SPACE: Phaser.Input.Keyboard.KeyCodes.SPACE,
        C: Phaser.Input.Keyboard.KeyCodes.C,
        SHIFT: Phaser.Input.Keyboard.KeyCodes.SHIFT,
        P: Phaser.Input.Keyboard.KeyCodes.P,
        R: Phaser.Input.Keyboard.KeyCodes.R,
        ONE: Phaser.Input.Keyboard.KeyCodes.ONE,
        TWO: Phaser.Input.Keyboard.KeyCodes.TWO
      });
      // 额外捕获：防止浏览器滚动
      try { this.input.keyboard.addCapture('SPACE,UP,DOWN,LEFT,RIGHT'); } catch (e) {}

      // 初始棋盘
      this.initBoardEmpty();
      this.refreshNextQueue();
      // 读取存档 hiScore
      this.loadHiScore();

      // 标题
      this.showTitle();

      // 点击聚焦以确保键盘有效
      this.input.on('pointerdown', function () { Sfx.ensure(); });
    },

    // ----------------------------------------------------------------------
    // 网格绘制（几何）
    // ----------------------------------------------------------------------
    drawGrid: function (gridColor) {
      var g = this.gridGfx;
      g.clear();
      g.lineStyle(1, gridColor, 0.9);
      for (var c = 0; c <= COLS; c++) {
        var x = this.bx + c * CELL;
        g.lineBetween(x, this.by, x, this.by + BOARD_H);
      }
      for (var r = 0; r <= ROWS; r++) {
        var y = this.by + r * CELL;
        g.lineBetween(this.bx, y, this.bx + BOARD_W, y);
      }
    },

    // ----------------------------------------------------------------------
    // 生成纹理：方块纯色+高光描边 + 纹理细节（可替换为外部贴图）
    // ----------------------------------------------------------------------
    createBlockTextures: function () {
      var keys = ['I', 'O', 'T', 'S', 'Z', 'J', 'L', 'G'];
      var self = this;
      keys.forEach(function (k) {
        var col = COLORS[k];
        // 若已存在则不再生成（热重载/重进关）
        if (self.textures.exists('block_' + k)) { return; }
        var g = self.add.graphics();
        // 底色
        g.fillStyle(col, 1);
        g.fillRoundedRect(0, 0, CELL, CELL, 3);
        // 高光上边缘（左上亮）
        var hi = Phaser.Display.Color.IntegerToColor(col);
        hi.brighten(38);
        g.fillStyle(hi.color, 0.72);
        g.fillRoundedRect(1, 1, CELL - 2, 7, 2);
        // 内描边
        g.lineStyle(1, 0x0f172a, 0.28);
        g.strokeRoundedRect(0.5, 0.5, CELL - 1, CELL - 1, 3);
        // 纹理：小斜线/点（几何纹理）
        g.lineStyle(1, 0xffffff, 0.10);
        g.lineBetween(4, CELL - 6, CELL - 6, 4);
        g.lineBetween(4, CELL - 9, CELL - 9, 4);
        g.generateTexture('block_' + k, CELL, CELL);
        g.destroy();
      });
      if (!this.textures.exists('block_ghost')) {
        var gg = this.add.graphics();
        gg.fillStyle(0xffffff, 1);
        gg.fillRoundedRect(0, 0, CELL, CELL, 3);
        gg.lineStyle(2, 0xffffff, 0.95);
        gg.strokeRoundedRect(1, 1, CELL - 2, CELL - 2, 3);
        gg.generateTexture('block_ghost', CELL, CELL);
        gg.destroy();
      }
    },

    // ----------------------------------------------------------------------
    // 棋盘初始化 + 关2垃圾行
    // ----------------------------------------------------------------------
    initBoardEmpty: function () {
      this.board = [];
      for (var r = 0; r < ROWS; r++) {
        this.board[r] = [];
        for (var c = 0; c < COLS; c++) { this.board[r][c] = null; }
      }
    },

    fillGarbageRows: function (n) {
      // 在底部 n 行填充垃圾行，每行留 1 个随机空洞
      for (var i = 0; i < n; i++) {
        var row = ROWS - 1 - i;
        var hole = Math.floor(Math.random() * COLS);
        for (var c = 0; c < COLS; c++) {
          if (c === hole) { this.board[row][c] = null; }
          else { this.board[row][c] = 'G'; }
        }
      }
    },

    // ----------------------------------------------------------------------
    // 袋随机 + 队列
    // ----------------------------------------------------------------------
    shuffleBag: function () {
      var arr = PIECE_TYPES.slice(0);
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      this.bag = arr;
    },

    refreshNextQueue: function () {
      while (this.nextQueue.length < 5) {
        if (this.bag.length === 0) { this.shuffleBag(); }
        this.nextQueue.push(this.bag.pop());
      }
    },

    // ----------------------------------------------------------------------
    // 工具：取形状
    // ----------------------------------------------------------------------
    getCells: function (type, rot) {
      return SHAPES[type][rot % 4];
    },

    canPlace: function (type, rot, x, y) {
      var cells = this.getCells(type, rot);
      for (var i = 0; i < cells.length; i++) {
        var cx = x + cells[i][0];
        var cy = y + cells[i][1];
        if (cx < 0 || cx >= COLS || cy >= ROWS) { return false; }
        if (cy < 0) { continue; } // 顶部上方允许
        if (this.board[cy][cx] !== null) { return false; }
      }
      return true;
    },

    // ----------------------------------------------------------------------
    // 生成/重生
    // ----------------------------------------------------------------------
    resetGame: function (stageIdx) {
      this.curStageIdx = stageIdx != null ? stageIdx : 0;
      var st = STAGES[this.curStageIdx];
      this.level = st.startLevel;
      this.lines = 0;
      this.score = 0;
      this.combo = -1;
      this.holdType = null;
      this.holdUsed = false;
      this.gameState = 'playing';
      this.dropTimer = 0;
      this.lockTimer = 0;
      this.clearRows = [];
      this.dasDir = 0; this.dasTimer = 0; this.arrTimer = 0; this.softTimer = 0;
      // 棋盘
      this.initBoardEmpty();
      if (st.garbage > 0) { this.fillGarbageRows(st.garbage); }
      // 队列
      this.bag = []; this.nextQueue = [];
      this.refreshNextQueue();
      this.updateDropInterval();
      this.applyStageVisual();
      this.spawnPiece();
      this.hideCenter();
      Sfx.ensure(); Sfx.startBgm();
      this.updateHud();
      this.renderAll();
    },

    applyStageVisual: function () {
      var st = STAGES[this.curStageIdx];
      this.bgRect.setFillStyle(st.bg);
      this.boardBg.setStrokeStyle(2, st.wall);
      this.drawGrid(st.grid);
      this.hudStage.setText(st.label + '  LV' + this.level);
    },

    spawnPiece: function () {
      this.refreshNextQueue();
      var type = this.nextQueue.shift();
      this.refreshNextQueue();
      this.active = { type: type, rot: 0, x: 3, y: 0 };
      // I 初始居中微调（已在形状中处理，这里 y 保持 0；若顶部冲突则上移）
      if (!this.canPlace(type, 0, 3, 0)) {
        // 尝试上移 1 格生成（避免开局即判死）
        if (this.canPlace(type, 0, 3, -1)) { this.active.y = -1; }
        else {
          // 真正的顶部堵塞 -> 游戏结束
          this.doGameOver();
          return;
        }
      }
      this.holdUsed = false;
      this.lockTimer = 0;
      this.dropTimer = 0;
      this.updateGhost();
      this.updateNextHud();
      this.updateHoldHud();
    },

    // ----------------------------------------------------------------------
    // 重力与关卡加速
    // ----------------------------------------------------------------------
    updateDropInterval: function () {
      var st = STAGES[this.curStageIdx];
      // 每级约 -62ms，保底 78ms
      var v = st.dropBase - (this.level - st.startLevel) * 62 - Math.floor(this.lines / 10) * 8;
      // 额外按总等级递减
      v -= (this.level - 1) * 10;
      if (v < 78) { v = 78; }
      this.dropInterval = v;
    },

    // ----------------------------------------------------------------------
    // 影子计算
    // ----------------------------------------------------------------------
    updateGhost: function () {
      if (!this.active) { this.ghostY = 0; return; }
      var y = this.active.y;
      while (this.canPlace(this.active.type, this.active.rot, this.active.x, y + 1)) { y++; }
      this.ghostY = y;
    },

    // ----------------------------------------------------------------------
    // 移动/旋转/Hold/软降/硬降（含 SRS 1格踢墙）
    // ----------------------------------------------------------------------
    tryMove: function (dx) {
      if (!this.active || this.gameState !== 'playing') { return false; }
      var nx = this.active.x + dx;
      if (this.canPlace(this.active.type, this.active.rot, nx, this.active.y)) {
        this.active.x = nx;
        this.updateGhost();
        this.lockTimer = 0; // 触底时移动重置锁定计时
        Sfx.play('move');
        return true;
      }
      return false;
    },

    tryRotate: function (dir) {
      if (!this.active || this.gameState !== 'playing') { return false; }
      var from = this.active.rot;
      var to = (from + dir + 4) % 4;
      // O 块无需踢墙
      if (this.active.type === 'O') {
        this.active.rot = to;
        Sfx.play('rotate');
        return true;
      }
      for (var k = 0; k < KICKS.length; k++) {
        var dx = KICKS[k][0], dy = KICKS[k][1];
        var nx = this.active.x + dx;
        var ny = this.active.y + dy;
        if (this.canPlace(this.active.type, to, nx, ny)) {
          this.active.x = nx; this.active.y = ny; this.active.rot = to;
          this.updateGhost();
          this.lockTimer = 0;
          Sfx.play('rotate');
          return true;
        }
      }
      return false;
    },

    doSoftDrop: function () {
      if (!this.active || this.gameState !== 'playing') { return false; }
      if (this.canPlace(this.active.type, this.active.rot, this.active.x, this.active.y + 1)) {
        this.active.y++;
        this.score += 1;
        this.updateGhost();
        this.updateHud();
        Sfx.play('soft');
        return true;
      } else {
        // 触底：开始锁定计时
        return false;
      }
    },

    doHardDrop: function () {
      if (!this.active || this.gameState !== 'playing') { return; }
      var dist = 0;
      while (this.canPlace(this.active.type, this.active.rot, this.active.x, this.active.y + 1)) {
        this.active.y++; dist++;
      }
      if (dist > 0) {
        this.score += dist * 2;
        this.updateHud();
      }
      Sfx.play('hard');
      this.lockPiece();
    },

    doHold: function () {
      if (!this.active || this.gameState !== 'playing' || this.holdUsed) { return; }
      Sfx.play('hold');
      if (this.holdType === null) {
        this.holdType = this.active.type;
        this.spawnPiece();
      } else {
        var tmp = this.holdType;
        this.holdType = this.active.type;
        this.active = { type: tmp, rot: 0, x: 3, y: 0 };
        if (!this.canPlace(this.active.type, 0, 3, 0)) {
          if (this.canPlace(this.active.type, 0, 3, -1)) { this.active.y = -1; }
          else { this.doGameOver(); return; }
        }
        this.updateGhost();
      }
      this.holdUsed = true;
      this.updateHoldHud();
      this.updateNextHud();
    },

    // ----------------------------------------------------------------------
    // 锁定 + 消行 + 坠落（正确下落）
    // ----------------------------------------------------------------------
    lockPiece: function () {
      if (!this.active) { return; }
      var cells = this.getCells(this.active.type, this.active.rot);
      var overTop = false;
      for (var i = 0; i < cells.length; i++) {
        var cx = this.active.x + cells[i][0];
        var cy = this.active.y + cells[i][1];
        if (cy < 0) { overTop = true; continue; }
        this.board[cy][cx] = this.active.type;
      }
      Sfx.play('lock');
      if (overTop) {
        // 仍写入可见部分，但若顶部越界过多则判负（已在 spawn 判，这里宽容）
      }
      this.active = null;
      // 消行检测
      var full = [];
      for (var r = 0; r < ROWS; r++) {
        var isFull = true;
        for (var c = 0; c < COLS; c++) { if (this.board[r][c] === null) { isFull = false; break; } }
        if (isFull) { full.push(r); }
      }
      if (full.length > 0) {
        this.clearRows = full;
        this.doLineClearFlash(full);
        // 分数与连消
        this.combo++;
        var base = [0, 100, 300, 500, 800];
        var b = base[full.length] || 0;
        var add = b * this.level;
        // 连消加分
        if (this.combo > 0) { add += this.combo * 50 * this.level; }
        // 四消额外
        if (full.length === 4) { Sfx.play('tetris'); } else { Sfx.play('clear'); }
        this.score += add;
        this.lines += full.length;
        // 关卡随消行数加速：每 10 行升一级
        var newLevel = STAGES[this.curStageIdx].startLevel + Math.floor(this.lines / 10);
        if (newLevel !== this.level) {
          this.level = newLevel;
          this.updateDropInterval();
          Sfx.play('levelup');
          this.applyStageVisual();
        } else {
          this.updateDropInterval();
        }
        this.updateHud();
        this.saveHi();
        // 闪烁结束后再真正移除行并坠落
      } else {
        this.combo = -1;
        this.saveHi();
        this.spawnPiece();
        this.renderAll();
      }
    },

    doLineClearFlash: function (rows) {
      var self = this;
      this.gameState = 'clearFlash';
      // 显示闪烁矩形
      rows.forEach(function (r) {
        var rect = self.flashRects[r];
        rect.setVisible(true).setAlpha(0.0);
      });
      // 闪烁 tween：白块淡入淡出
      this.tweens.killAll();
      var flashObjs = rows.map(function (r) { return self.flashRects[r]; });
      this.tweens.add({
        targets: flashObjs,
        alpha: 0.92,
        duration: CLEAR_FLASH_MS / 2,
        yoyo: true,
        repeat: 1,
        ease: 'Sine.easeInOut',
        onComplete: function () {
          flashObjs.forEach(function (o) { o.setVisible(false).setAlpha(0); });
          self.applyLineClearFall();
        }
      });
      // 同步让棋盘上对应行的块做缩放闪烁（池化块）
      //  找到池中处于这些行的块，做 scale tween
    },

    applyLineClearFall: function () {
      // 正确坠落：从下往上压缩，消除行上面的所有行下移
      var rowsSet = {};
      for (var i = 0; i < this.clearRows.length; i++) { rowsSet[this.clearRows[i]] = true; }
      var newBoard = [];
      for (var r = 0; r < ROWS; r++) { newBoard[r] = null; }
      // 收集非消除行，从底向上填充
      var write = ROWS - 1;
      for (var read = ROWS - 1; read >= 0; read--) {
        if (rowsSet[read]) { continue; }
        newBoard[write] = this.board[read].slice(0);
        write--;
      }
      // 顶部补空
      for (var f = write; f >= 0; f--) {
        newBoard[f] = [];
        for (var c = 0; c < COLS; c++) { newBoard[f][c] = null; }
      }
      this.board = newBoard;
      this.clearRows = [];
      this.gameState = 'playing';
      this.spawnPiece();
      this.renderAll();
    },

    // ----------------------------------------------------------------------
    // HUD
    // ----------------------------------------------------------------------
    updateHud: function () {
      this.hudScore.setText('SCORE  ' + this.score);
      this.hudLines.setText('LINES  ' + this.lines);
      this.hudLevel.setText('LEVEL  ' + this.level);
      this.hudHi.setText('HI  ' + (saveData.hiScore || 0));
      this.hudStage.setText(STAGES[this.curStageIdx].label + '  LV' + this.level);
    },

    updateNextHud: function () {
      // 显示 nextQueue 前 3 个的缩略图（几何块）
      for (var n = 0; n < 3; n++) {
        var type = this.nextQueue[n];
        var grp = this.nextPreviews[n];
        var box = this.nextBoxes[n];
        var bx = box.x, by = box.y;
        if (!type) {
          for (var k = 0; k < 4; k++) { grp[k].setVisible(false); }
          continue;
        }
        var cells = this.getCells(type, 0);
        // 计算包围盒以居中
        var minX = 10, minY = 10, maxX = -10, maxY = -10;
        for (var i = 0; i < cells.length; i++) { minX = Math.min(minX, cells[i][0]); minY = Math.min(minY, cells[i][1]); maxX = Math.max(maxX, cells[i][0]); maxY = Math.max(maxY, cells[i][1]); }
        var w = (maxX - minX + 1) * CELL * 0.62;
        var h = (maxY - minY + 1) * CELL * 0.62;
        var ox = bx - w / 2 + 1;
        var oy = by - h / 2 + 1;
        for (var j = 0; j < 4; j++) {
          var cx = cells[j][0], cy = cells[j][1];
          var px = ox + (cx - minX) * CELL * 0.62;
          var py = oy + (cy - minY) * CELL * 0.62;
          grp[j].setTexture('block_' + type).setPosition(px, py).setVisible(true);
        }
        // 超出 4 格的只显示 4 个，已覆盖
      }
    },

    updateHoldHud: function () {
      var box = this.hudHoldBox;
      if (!this.holdType) {
        for (var k = 0; k < 4; k++) { this.holdPreview[k].setVisible(false); }
        return;
      }
      var cells = this.getCells(this.holdType, 0);
      var minX = 10, minY = 10, maxX = -10, maxY = -10;
      for (var i = 0; i < cells.length; i++) { minX = Math.min(minX, cells[i][0]); minY = Math.min(minY, cells[i][1]); maxX = Math.max(maxX, cells[i][0]); maxY = Math.max(maxY, cells[i][1]); }
      var w = (maxX - minX + 1) * CELL * 0.62;
      var h = (maxY - minY + 1) * CELL * 0.62;
      var ox = box.x - w / 2 + 1;
      var oy = box.y - h / 2 + 1;
      for (var j = 0; j < 4; j++) {
        var cx = cells[j][0], cy = cells[j][1];
        var px = ox + (cx - minX) * CELL * 0.62;
        var py = oy + (cy - minY) * CELL * 0.62;
        this.holdPreview[j].setTexture('block_' + this.holdType).setPosition(px, py).setVisible(true).setAlpha(this.holdUsed ? 0.42 : 1.0);
      }
    },

    // ----------------------------------------------------------------------
    // 渲染：棋盘 + 影子 + 活动块（池化复用）
    // ----------------------------------------------------------------------
    renderAll: function () {
      // 1) 棋盘格：池化块复用
      var idx = 0;
      for (var r = 0; r < ROWS; r++) {
        for (var c = 0; c < COLS; c++) {
          var v = this.board[r][c];
          if (v !== null) {
            var img = this.poolCells[idx];
            // 若池不够则新建（理论上 200 足够 10x20）
            if (!img) {
              img = this.add.image(0, 0, 'block_' + v).setOrigin(0).setDepth(3);
              this.poolCells.push(img);
            }
            img.setTexture('block_' + v)
              .setPosition(this.bx + c * CELL, this.by + r * CELL)
              .setVisible(true);
            idx++;
          }
        }
      }
      // 隐藏多余池块
      for (var h = idx; h < this.poolCells.length; h++) { this.poolCells[h].setVisible(false); }

      // 2) 影子（ghost）
      for (var g = 0; g < 4; g++) { this.ghostImages[g].setVisible(false); }
      if (this.active && this.gameState === 'playing') {
        var gcells = this.getCells(this.active.type, this.active.rot);
        for (var gi = 0; gi < gcells.length; gi++) {
          var gx = this.active.x + gcells[gi][0];
          var gy = this.ghostY + gcells[gi][1];
          if (gy < 0) { continue; }
          this.ghostImages[gi].setPosition(this.bx + gx * CELL, this.by + gy * CELL).setVisible(true);
        }
      }

      // 3) 活动块
      for (var a = 0; a < 4; a++) { this.activeImages[a].setVisible(false); }
      if (this.active && (this.gameState === 'playing' || this.gameState === 'clearFlash')) {
        var acells = this.getCells(this.active.type, this.active.rot);
        for (var ai = 0; ai < acells.length; ai++) {
          var ax = this.active.x + acells[ai][0];
          var ay = this.active.y + acells[ai][1];
          if (ay < 0) { continue; }
          this.activeImages[ai].setTexture('block_' + this.active.type)
            .setPosition(this.bx + ax * CELL, this.by + ay * CELL)
            .setVisible(true);
        }
      }
    },

    // ----------------------------------------------------------------------
    // 标题 / 暂停 / 结束
    // ----------------------------------------------------------------------
    showTitle: function () {
      this.gameState = 'title';
      Sfx.stopBgm();
      this.centerText.setText('TETRIS  PUZZLE\n' + STAGES[0].label + '  /  ' + STAGES[1].label).setVisible(true);
      this.subText.setText('PRESS  1  STAGE 1  |  2  STAGE 2 (FAST+GARBAGE)\nARROWS / WASD  MOVE   UP/Z  ROTATE   SPACE HARD   C HOLD   P PAUSE\nHI SCORE ' + (saveData.hiScore || 0)).setVisible(true);
      // 预览一个空棋盘
      this.initBoardEmpty();
      this.renderAll();
      this.updateHud();
      this.updateNextHud();
      this.updateHoldHud();
    },

    doPause: function () {
      if (this.gameState === 'playing') {
        this.gameState = 'paused';
        Sfx.stopBgm();
        this.centerText.setText('PAUSED').setVisible(true);
        this.subText.setText('PRESS  P  RESUME  |  R  RESTART').setVisible(true);
      } else if (this.gameState === 'paused') {
        this.gameState = 'playing';
        this.hideCenter();
        Sfx.ensure(); Sfx.startBgm();
      }
    },

    hideCenter: function () {
      this.centerText.setVisible(false);
      this.subText.setVisible(false);
    },

    doGameOver: function () {
      this.gameState = 'gameover';
      Sfx.stopBgm(); Sfx.play('gameover');
      this.saveHi();
      this.centerText.setText('GAME OVER\nSCORE ' + this.score + '  LINES ' + this.lines).setVisible(true);
      this.subText.setText('PRESS  R  RESTART  |  1 / 2  STAGE SELECT  |  TOP ' + (saveData.hiScore || 0)).setVisible(true);
      // 隐藏活动块
      for (var i = 0; i < 4; i++) { this.activeImages[i].setVisible(false); this.ghostImages[i].setVisible(false); }
    },

    // ----------------------------------------------------------------------
    // 存档
    // ----------------------------------------------------------------------
    saveHi: function () {
      if (this.score > (saveData.hiScore || 0)) {
        saveData.hiScore = this.score;
        try {
          if (hostRef && hostRef.saveState) { hostRef.saveState({ hiScore: saveData.hiScore }).then(function(){}, function(){}); }
        } catch (e) {}
        this.updateHud();
      }
    },

    loadHiScore: function () {
      var self = this;
      if (hostRef && hostRef.loadState) {
        try {
          hostRef.loadState().then(function (d) {
            if (d && typeof d.hiScore === 'number') { saveData.hiScore = d.hiScore; self.hudHi.setText('HI  ' + saveData.hiScore); if (self.gameState === 'title') { self.subText.setText('PRESS  1  STAGE 1  |  2  STAGE 2 (FAST+GARBAGE)\nARROWS / WASD  MOVE   UP/Z  ROTATE   SPACE HARD   C HOLD   P PAUSE\nHI SCORE ' + saveData.hiScore); } }
          }, function () {});
        } catch (e) {}
      }
    },

    // ----------------------------------------------------------------------
    // 每帧更新：输入 DAS/ARR + 重力 + 锁定
    // ----------------------------------------------------------------------
    update: function (time, delta) {
      // 标题态：选关
      if (this.gameState === 'title') {
        if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { Sfx.ensure(); this.resetGame(0); return; }
        if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { Sfx.ensure(); this.resetGame(1); return; }
        if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) { Sfx.ensure(); this.resetGame(0); return; }
        return;
      }
      // 游戏结束：R 重开，1/2 选关
      if (this.gameState === 'gameover') {
        if (Phaser.Input.Keyboard.JustDown(this.keys.R)) { Sfx.ensure(); this.resetGame(this.curStageIdx); return; }
        if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { Sfx.ensure(); this.resetGame(0); return; }
        if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { Sfx.ensure(); this.resetGame(1); return; }
        if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) { Sfx.ensure(); this.resetGame(this.curStageIdx); return; }
        return;
      }
      // 暂停
      if (Phaser.Input.Keyboard.JustDown(this.keys.P)) { this.doPause(); return; }
      if (this.gameState === 'paused') {
        if (Phaser.Input.Keyboard.JustDown(this.keys.R)) { Sfx.ensure(); this.resetGame(this.curStageIdx); }
        return;
      }
      if (this.gameState === 'clearFlash') {
        // 闪烁期间忽略操作，仅允许重开
        if (Phaser.Input.Keyboard.JustDown(this.keys.R)) { this.tweens.killAll(); this.flashRects.forEach(function(r){ r.setVisible(false); }); this.resetGame(this.curStageIdx); }
        return;
      }
      if (!this.active || this.gameState !== 'playing') { return; }

      // 单次按键：旋转 / 暂存 / 硬降
      if (Phaser.Input.Keyboard.JustDown(this.keys.UP) || Phaser.Input.Keyboard.JustDown(this.keys.W) || Phaser.Input.Keyboard.JustDown(this.keys.X)) {
        if (this.tryRotate(1)) { this.renderAll(); }
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.Z)) {
        if (this.tryRotate(-1)) { this.renderAll(); }
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.C) || Phaser.Input.Keyboard.JustDown(this.keys.SHIFT)) {
        this.doHold(); this.renderAll(); return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) {
        this.doHardDrop(); this.renderAll(); return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.R)) { Sfx.ensure(); this.resetGame(this.curStageIdx); return; }
      // 选关快捷（游戏中也可切关重开）
      if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { Sfx.ensure(); this.resetGame(0); return; }
      if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { Sfx.ensure(); this.resetGame(1); return; }

      // 长按左右：DAS + ARR
      var leftDown = this.keys.LEFT.isDown || this.keys.A.isDown;
      var rightDown = this.keys.RIGHT.isDown || this.keys.D.isDown;
      var dir = 0;
      if (leftDown && !rightDown) { dir = -1; }
      else if (rightDown && !leftDown) { dir = 1; }
      else { dir = 0; }

      if (dir !== 0) {
        if (this.dasDir !== dir) {
          // 首次按下立即移动一次
          this.dasDir = dir; this.dasTimer = 0; this.arrTimer = 0;
          if (this.tryMove(dir)) { this.renderAll(); }
        } else {
          this.dasTimer += delta;
          if (this.dasTimer >= DAS_DELAY) {
            this.arrTimer += delta;
            while (this.arrTimer >= ARR_INTERVAL) {
              this.arrTimer -= ARR_INTERVAL;
              if (this.tryMove(dir)) { this.renderAll(); } else { this.arrTimer = 0; break; }
            }
          }
        }
      } else {
        this.dasDir = 0; this.dasTimer = 0; this.arrTimer = 0;
      }

      // 软降长按
      var downDown = this.keys.DOWN.isDown || this.keys.S.isDown;
      if (downDown) {
        this.softTimer += delta;
        while (this.softTimer >= SOFT_INTERVAL) {
          this.softTimer -= SOFT_INTERVAL;
          if (!this.doSoftDrop()) { break; }
          this.renderAll();
          // 触底则进入锁定计时
          if (!this.canPlace(this.active.type, this.active.rot, this.active.x, this.active.y + 1)) { break; }
        }
      } else {
        this.softTimer = 0;
      }

      // 重力下落
      this.dropTimer += delta;
      if (this.dropTimer >= this.dropInterval) {
        this.dropTimer = 0;
        if (this.canPlace(this.active.type, this.active.rot, this.active.x, this.active.y + 1)) {
          this.active.y++;
          this.updateGhost();
          this.lockTimer = 0;
          this.renderAll();
        }
      }

      // 触底锁定计时（每帧累加，触底后 420ms 自动锁定；移动/旋转会重置）
      if (!this.canPlace(this.active.type, this.active.rot, this.active.x, this.active.y + 1)) {
        this.lockTimer += delta;
        if (this.lockTimer >= LOCK_DELAY) {
          this.lockPiece();
          this.renderAll();
          return;
        }
      } else {
        this.lockTimer = 0;
      }

      // 轻量渲染节流：仅在位置变化时已 render；此处兜底不每帧重绘
    }
  });

  // ==========================================================================
  // 注册
  // ==========================================================================
  window.TRGames = window.TRGames || { register: function(){}, _r:{} };
  window.TRGames.register({
    id: 'puzzle-tetris',
    title: '俄罗斯方块 Puzzle Tetris',
    launch: function (host) {
      hostRef = host;
      var W = host.width || 960;
      var H = host.height || 540;
      if (host.loadState) {
        try {
          host.loadState().then(function (d) {
            if (d && typeof d.hiScore === 'number') { saveData.hiScore = d.hiScore; }
          }, function () {});
        } catch (e) {}
      }
      var game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host.container,
        width: W,
        height: H,
        backgroundColor: '#0b1220',
        physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
        scene: [MainScene]
      });
      sceneRef = null;
      var tryBind = function () {
        try { var s = game.scene.getScene('Main'); if (s) { sceneRef = s; } } catch (e) {}
      };
      setTimeout(tryBind, 400);
      game.events.on('ready', tryBind);
      window.__trgame = {
        game: game,
        getState: getState,
        getScene: function () { return sceneRef; }
      };
      window.__trgame.getSave = function () { return { hiScore: saveData.hiScore }; };
      return game;
    }
  });

})();
