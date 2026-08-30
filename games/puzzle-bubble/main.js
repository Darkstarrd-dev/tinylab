// =============================================================================
// puzzle-bubble v0.1.0 — Puzzle Bobble 泡泡龙（六边形阵列消除）
// =============================================================================
// 【资产清单 — 将来替换为外部资源时逐项修改】
//   视觉（本文件 buildTextures 段）：
//     bubble_red/blue/green/yellow/purple/cyan — Graphics 圆形 + 高光 + 边框 →
//       this.load.image('bubble_red','assets/bubble_red.png') 等，键名一一对应
//     launcher/cannon — Graphics 圆+管  →  this.load.image('launcher','assets/launcher.png')
//     ceiling — Graphics 矩形条纹  →  this.load.image('ceiling','assets/ceiling.png')
//     bg_tile — Graphics 平铺背景  →  this.load.image('bg_tile','assets/bg_tile.png')
//     点状轨迹：Graphics 运行时画虚线，无纹理
//     坠落：tween 位移+alpha 消失，无额外资源
//     // TODO(资产替换): 在 buildTextures 中将对应 generateTexture 块改为 load.image
//   音频（Sfx 块）：
//     shoot/attach/pop/fall/warning/bgm — WebAudio oscillator+gain  →
//       this.load.audio('pop','assets/pop.wav') + this.sound.play('pop')
//     // TODO(资产替换): 在 Sfx.play 分支替换 oscillator 为 AudioBuffer 播放
//   关卡：
//     STAGES[].layout 字符串/数字矩阵 — 未来可换 Tiled JSON：
//       this.load.tilemapTiledJSON('stage1','assets/stage1.json')
//   存档：host.saveState { bestScore:number, clearedStage:number }
//   池化：flyingPool / bubblePool 复用 Image/Sprite，避免发射/坠落时频繁 create/destroy
// =============================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 顶部可调参数（带单位，中文注释）
  // ---------------------------------------------------------------------------
  /** 列数 */
  var COLS = 8;
  /** 最大行数（可见+缓冲） */
  var MAX_ROWS = 15;
  /** 初始填充行数 */
  var INIT_ROWS = 8;
  /** 泡泡半径 px */
  var BUBBLE_R = 16;
  /** 泡泡直径 px */
  var BUBBLE_D = BUBBLE_R * 2;
  /** 六边形行距 px（≈ R*√3） */
  var ROW_H = 28;
  /** 网格顶部基准 y px */
  var GRID_TOP = 48;
  /** 网格左右起始由舞台宽度居中计算 */
  /** 底部发射器 y */
  var LAUNCHER_Y_OFFSET = 56;
  /** 发射速度 px/s */
  var SHOOT_SPEED = 720;
  /** 瞄准角度限制（与垂直方向夹角的一半，度） */
  var AIM_LIMIT_DEG = 75;
  /** 轨迹预览段数 */
  var TRAJ_SEG = 14;
  /** 轨迹步长 px */
  var TRAJ_STEP = 14;
  /** 消除分数：连体每个 */
  var SCORE_POP = 100;
  /** 悬空坠落每个 */
  var SCORE_FALL = 150;
  /** 底线到发射器上方判定 */
  var GAMEOVER_MARGIN = 12;

  /** 颜色表（索引0开始） */
  var PALETTE = [
    { key: 'bubble_red',    hex: 0xe74c3c, light: 0xff8b8b },
    { key: 'bubble_blue',   hex: 0x3498db, light: 0x8bcfff },
    { key: 'bubble_green',  hex: 0x2ecc71, light: 0xa0ffb0 },
    { key: 'bubble_yellow', hex: 0xf1c40f, light: 0xfff6a0 },
    { key: 'bubble_purple', hex: 0x9b59b6, light: 0xe0a0ff },
    { key: 'bubble_cyan',   hex: 0x1abc9c, light: 0x8fffe8 }
  ];

  /** 关卡定义 — 至少2关，区分颜色数与天花板下压速度 */
  // layout 中 0=空 1..N=对应调色板索引+1（保证两关可通关，手写可解布局）
  var STAGES = [
    {
      id: 1,
      title: 'Stage 1 — 彩虹洞窟',
      colors: 4, // 使用前4色
      ceilingSteps: 8, // 每8发下压一行
      ceilingMs: 16000, // 或每16秒下压一行（取先到）
      // 8行 交错阵，制造可连块（每行同色相邻≥2）
      layout: [
        [1, 1, 2, 2, 3, 3, 4, 4],
        [1, 2, 2, 3, 3, 4, 4, 1],
        [3, 3, 4, 1, 1, 2, 2, 3],
        [4, 1, 1, 2, 2, 3, 3, 4],
        [2, 2, 3, 3, 4, 4, 1, 1],
        [2, 3, 4, 4, 1, 1, 2, 3],
        [1, 1, 2, 2, 3, 3, 4, 4],
        [3, 4, 1, 2, 2, 1, 4, 3]
      ]
    },
    {
      id: 2,
      title: 'Stage 2 — 深渊蜂巢',
      colors: 6, // 6色 更难
      ceilingSteps: 5, // 每5发更快下压
      ceilingMs: 9000,
      layout: [
        [1, 2, 3, 4, 5, 6, 1, 2],
        [3, 3, 4, 4, 5, 5, 6, 6],
        [6, 1, 1, 2, 2, 3, 3, 4],
        [5, 5, 6, 1, 2, 2, 1, 5],
        [2, 3, 4, 5, 6, 1, 2, 3],
        [4, 4, 5, 5, 6, 6, 1, 1],
        [1, 2, 2, 3, 3, 4, 4, 5],
        [6, 6, 1, 1, 2, 3, 5, 5]
      ]
    }
  ];

  // ---------------------------------------------------------------------------
  // 存档与对外状态
  // ---------------------------------------------------------------------------
  var hostRef = null;
  var sceneRef = null;
  var saveData = { bestScore: 0, clearedStage: 0 };

  function getState() {
    var sc = sceneRef;
    if (!sc) { return { scene: 'title', stage: 1, score: 0, rows: INIT_ROWS }; }
    var rows = 0;
    try {
      for (var r = 0; r < sc.grid.length; r++) {
        var has = false;
        for (var c = 0; c < COLS; c++) { if (sc.grid[r][c] !== 0) { has = true; break; } }
        if (has) { rows = r + 1; }
      }
    } catch (e) { rows = INIT_ROWS; }
    return {
      scene: sc.gameState || 'title',
      stage: sc.curStage || 1,
      score: sc.score || 0,
      rows: rows
    };
  }

  function persist() {
    if (!hostRef || !hostRef.saveState) { return; }
    try {
      var p = hostRef.saveState({ bestScore: saveData.bestScore, clearedStage: saveData.clearedStage });
      if (p && typeof p.catch === 'function') { p.catch(function () {}); }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function deg2rad(d) { return d * Math.PI / 180; }
  function dist2(ax, ay, bx, by) { var dx = ax - bx; var dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }

  /** 网格世界坐标：r行c列 → {x,y}（考虑奇行半格偏移与天花板下压） */
  function gridToWorld(r, c, ceilingOffset, gridLeft, gridTop) {
    var x = gridLeft + c * BUBBLE_D + (r % 2 === 1 ? BUBBLE_R : 0) + BUBBLE_R;
    var y = gridTop + ceilingOffset + r * ROW_H + BUBBLE_R;
    return { x: x, y: y };
  }

  /** 六边形邻居偏移（odd-r） */
  function neighborOffsets(r) {
    if (r % 2 === 0) {
      return [[-1, -1], [0, -1], [-1, 0], [1, 0], [-1, 1], [0, 1]];
    } else {
      return [[0, -1], [1, -1], [-1, 0], [1, 0], [0, 1], [1, 1]];
    }
  }

  /** BFS 同色连通块 */
  function bfsCluster(grid, sr, sc, color) {
    var q = [[sr, sc]];
    var seen = {};
    seen[sr + ',' + sc] = true;
    var out = [[sr, sc]];
    var head = 0;
    while (head < q.length) {
      var cur = q[head++]; var r = cur[0]; var c = cur[1];
      var offs = neighborOffsets(r);
      for (var i = 0; i < offs.length; i++) {
        var nr = r + offs[i][0]; var nc = c + offs[i][1];
        if (nr < 0 || nr >= grid.length || nc < 0 || nc >= COLS) { continue; }
        var k = nr + ',' + nc;
        if (seen[k]) { continue; }
        if (grid[nr][nc] !== color) { continue; }
        seen[k] = true; q.push([nr, nc]); out.push([nr, nc]);
      }
    }
    return out;
  }

  /** 顶部连通（非悬空）集合 */
  function topConnectedSet(grid) {
    var q = [];
    var seen = {};
    for (var c = 0; c < COLS; c++) {
      if (grid[0][c] !== 0) { q.push([0, c]); seen['0,' + c] = true; }
    }
    var head = 0;
    while (head < q.length) {
      var cur = q[head++]; var r = cur[0]; var cc = cur[1];
      var offs = neighborOffsets(r);
      for (var i = 0; i < offs.length; i++) {
        var nr = r + offs[i][0]; var nc = cc + offs[i][1];
        if (nr < 0 || nr >= grid.length || nc < 0 || nc >= COLS) { continue; }
        var k = nr + ',' + nc;
        if (seen[k]) { continue; }
        if (grid[nr][nc] === 0) { continue; }
        seen[k] = true; q.push([nr, nc]);
      }
    }
    return seen;
  }

  /** 悬空泡泡列表（非顶连通且非空） */
  function floatingCells(grid) {
    var conn = topConnectedSet(grid);
    var out = [];
    for (var r = 0; r < grid.length; r++) {
      for (var c = 0; c < COLS; c++) {
        if (grid[r][c] !== 0 && !conn[r + ',' + c]) { out.push([r, c]); }
      }
    }
    return out;
  }

  /** 找最近空格（暴力最近距离） */
  function nearestEmpty(grid, wx, wy, ceilingOffset, gridLeft, gridTop) {
    var best = null; var bestD = 1e9;
    for (var r = 0; r < grid.length; r++) {
      for (var c = 0; c < COLS; c++) {
        if (grid[r][c] !== 0) { continue; }
        var p = gridToWorld(r, c, ceilingOffset, gridLeft, gridTop);
        var d = dist2(wx, wy, p.x, p.y);
        if (d < bestD) { bestD = d; best = [r, c]; }
      }
    }
    return best;
  }

  /** 行数统计（用于 getState.rows） */
  function occupiedRows(grid) {
    var max = 0;
    for (var r = 0; r < grid.length; r++) {
      for (var c = 0; c < COLS; c++) { if (grid[r][c] !== 0) { max = r + 1; break; } }
    }
    return max;
  }

  // ---------------------------------------------------------------------------
  // Sfx — WebAudio 振荡器+增益，首输入 resume，静默降级
  // ---------------------------------------------------------------------------
  var Sfx = {
    ctx: null,
    enabled: true,
    bgmTimer: null,
    _ensure: function () {
      if (this.ctx) { return this.ctx; }
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { this.enabled = false; return null; }
        this.ctx = new AC();
      } catch (e) { this.enabled = false; return null; }
      return this.ctx;
    },
    _resume: function () {
      var c = this._ensure(); if (!c) { return; }
      if (c.state === 'suspended') { try { c.resume(); } catch (e2) {} }
    },
    tone: function (freq, dur, type, vol, slideTo) {
      try {
        var c = this._ensure(); if (!c || !this.enabled) { return; }
        this._resume();
        var o = c.createOscillator(); var g = c.createGain();
        o.type = type || 'sine'; o.frequency.value = freq;
        if (slideTo) { o.frequency.linearRampToValueAtTime(slideTo, c.currentTime + dur); }
        g.gain.value = vol != null ? vol : 0.18;
        g.gain.setValueAtTime(g.gain.value, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
        o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + dur);
      } catch (e) {}
    },
    play: function (name) {
      try {
        if (name === 'shoot') { this.tone(700, 0.10, 'square', 0.18, 420); }
        else if (name === 'attach') { this.tone(320, 0.09, 'sine', 0.18, 260); }
        else if (name === 'pop') {
          this.tone(880, 0.11, 'sine', 0.22, 1320);
          var self = this; setTimeout(function () { self.tone(1100, 0.10, 'sine', 0.16); }, 80);
        }
        else if (name === 'fall') { this.tone(220, 0.22, 'triangle', 0.18, 90); }
        else if (name === 'warning') {
          this.tone(440, 0.16, 'sawtooth', 0.20, 440);
          var s = this; setTimeout(function () { s.tone(360, 0.16, 'sawtooth', 0.18); }, 180);
        }
        else if (name === 'clear') {
          this.tone(523, 0.14, 'sine', 0.2); var t = this;
          setTimeout(function () { t.tone(659, 0.14, 'sine', 0.2); }, 130);
          setTimeout(function () { t.tone(784, 0.22, 'sine', 0.22); }, 260);
        }
        else if (name === 'over') { this.tone(300, 0.45, 'sawtooth', 0.22, 70); }
      } catch (e2) {}
    },
    startBgm: function (scene) {
      try {
        this.stopBgm();
        var ctx = this._ensure(); if (!ctx) { return; }
        var notes = [196, 247, 294, 247];
        var idx = 0;
        this.bgmTimer = scene.time.addEvent({
          delay: 420, loop: true, callback: function () {
            try { Sfx.tone(notes[idx % notes.length], 0.16, 'triangle', 0.06); idx++; } catch (e) {}
          }
        });
      } catch (e) {}
    },
    stopBgm: function () { try { if (this.bgmTimer) { this.bgmTimer.remove(false); this.bgmTimer = null; } } catch (e) {} }
  };

  // ---------------------------------------------------------------------------
  // 纹理生成（纯几何，零外部资源）
  // ---------------------------------------------------------------------------
  function buildTextures(scene) {
    function rm(k) { try { if (scene.textures.exists(k)) { scene.textures.remove(k); } } catch (e) {} }
    var g;
    // 泡泡各色 — 圆形主体 + 左上高光 + 边框
    // 将来换：this.load.image('bubble_red','assets/bubble_red.png') 等
    for (var i = 0; i < PALETTE.length; i++) {
      var pal = PALETTE[i];
      rm(pal.key);
      g = scene.add.graphics();
      // 主圆
      g.fillStyle(pal.hex, 1); g.fillCircle(BUBBLE_R, BUBBLE_R, BUBBLE_R - 1);
      // 高光
      g.fillStyle(pal.light, 0.95); g.fillCircle(BUBBLE_R - 5, BUBBLE_R - 6, 5);
      g.fillStyle(0xffffff, 0.55); g.fillCircle(BUBBLE_R - 3, BUBBLE_R - 8, 1.8);
      // 边框
      g.lineStyle(1.5, 0x1a1a1a, 0.35); g.strokeCircle(BUBBLE_R, BUBBLE_R, BUBBLE_R - 1);
      g.generateTexture(pal.key, BUBBLE_D, BUBBLE_D); g.destroy();
    }
    // 发射器底座
    rm('launcher_base');
    g = scene.add.graphics();
    g.fillStyle(0x2c3e50, 1); g.fillRoundedRect(0, 0, 64, 18, 6);
    g.fillStyle(0x5d6d7e, 1); g.fillRoundedRect(0, 0, 64, 6, 6);
    g.lineStyle(1, 0x1a252f, 1); g.strokeRoundedRect(0, 0, 64, 18, 6);
    g.generateTexture('launcher_base', 64, 18); g.destroy();
    // 炮管（竖直，发射时旋转容器）
    rm('launcher_tube');
    g = scene.add.graphics();
    g.fillStyle(0x7f8c8d, 1); g.fillRoundedRect(0, 0, 16, 42, 6);
    g.fillStyle(0xbdc3c7, 1); g.fillRoundedRect(0, 0, 16, 10, 6);
    g.lineStyle(1, 0x34495e, 0.9); g.strokeRoundedRect(0, 0, 16, 42, 6);
    g.generateTexture('launcher_tube', 16, 42); g.destroy();
    // 天花板条
    rm('ceiling');
    g = scene.add.graphics();
    g.fillStyle(0x34495e, 1); g.fillRect(0, 0, 64, 14);
    g.fillStyle(0x5d6d7e, 1); g.fillRect(0, 0, 64, 4);
    g.lineStyle(1, 0x1a252f, 1); g.strokeRect(0, 0, 64, 14);
    g.generateTexture('ceiling', 64, 14); g.destroy();
    // 背景平铺
    rm('bg_tile');
    g = scene.add.graphics();
    g.fillStyle(0x17202a, 1); g.fillRect(0, 0, 64, 64);
    g.fillStyle(0x1e2e3e, 1); g.fillCircle(12, 14, 10); g.fillCircle(40, 30, 14); g.fillCircle(28, 52, 8);
    g.generateTexture('bg_tile', 64, 64); g.destroy();
    // 粒子点（消除用）
    rm('pop_dot');
    g = scene.add.graphics();
    g.fillStyle(0xffffff, 1); g.fillCircle(3, 3, 3);
    g.generateTexture('pop_dot', 6, 6); g.destroy();
  }

  // ---------------------------------------------------------------------------
  // 主场景
  // ---------------------------------------------------------------------------
  var MainScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function MainScene() { Phaser.Scene.call(this, { key: 'Main' }); },

    create: function () {
      sceneRef = this;
      buildTextures(this);

      this.W = this.scale.width || 960;
      this.H = this.scale.height || 540;
      this.GRID_LEFT = Math.floor((this.W - (COLS * BUBBLE_D)) / 2);
      // 奇行半格会超出右边界半格，保持居中视觉
      this.GRID_RIGHT = this.GRID_LEFT + COLS * BUBBLE_D;
      this.BOTTOM_LINE = this.H - LAUNCHER_Y_OFFSET - 8;
      this.LAUNCHER_X = this.W / 2;
      this.LAUNCHER_Y = this.H - 26;

      // 背景
      this.cameras.main.setBackgroundColor('#0d1b2a');
      this.bg = this.add.tileSprite(0, 0, this.W, this.H, 'bg_tile').setOrigin(0, 0).setDepth(-20).setAlpha(0.55);

      // 输入
      this.keys = this.input.keyboard.addKeys('LEFT,RIGHT,A,D,SPACE,ENTER,R,P');
      this.cursors = this.input.keyboard.createCursorKeys();
      // 数字选关键（预创建，避免 update 中重复 addKey 泄漏）
      this.keyOne = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
      this.keyTwo = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
      this.keyNumpadOne = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_ONE);
      this.keyNumpadTwo = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_TWO);

      // 状态
      this.gameState = 'title'; // title | playing | paused | clear | over
      this.curStage = 1;
      this.score = 0;
      this.shots = 0;
      this.aimRad = 0; // 0=垂直向上，负左正右
      this.ceilingOffset = 0;
      this.grid = [];
      this.bubbleSprites = []; // 与 grid 同维度存 Image 引用或 null
      this.canShoot = true;
      this.moveTarget = null; // 预留
      this.warnUntil = 0;

      // 发射器
      this.launcherTube = this.add.image(this.LAUNCHER_X, this.LAUNCHER_Y - 12, 'launcher_tube').setDepth(6).setOrigin(0.5, 0.85);
      this.launcherBase = this.add.image(this.LAUNCHER_X, this.LAUNCHER_Y + 8, 'launcher_base').setDepth(7).setOrigin(0.5, 0.5);
      this.nextPreview = this.add.image(this.LAUNCHER_X, this.LAUNCHER_Y - 12, PALETTE[0].key).setDepth(8).setScale(0.95).setVisible(false);
      this.onDeckPreview = this.add.image(this.LAUNCHER_X + 56, this.LAUNCHER_Y + 2, PALETTE[1].key).setDepth(7).setScale(0.62).setAlpha(0.95).setVisible(false);
      this.onDeckLabel = this.add.text(this.LAUNCHER_X + 56, this.LAUNCHER_Y + 20, 'NEXT', { fontSize: '10px', color: '#aab4c0', fontStyle: 'bold' }).setOrigin(0.5, 0).setDepth(7).setVisible(false);

      // 轨迹虚线（Graphics）+ 瞄准线
      this.trajG = this.add.graphics().setDepth(4);
      this.aimLine = this.add.graphics().setDepth(4);

      // 池：复用飞行泡泡与静态泡泡
      // 飞行泡泡池（Image 池）
      this.flyingPool = [];
      for (var pi = 0; pi < 6; pi++) {
        var pp = this.add.image(-100, -100, PALETTE[0].key).setVisible(false).setDepth(9).setScale(1);
        this.flyingPool.push(pp);
      }
      this.flying = null; // 当前飞行中的泡泡 { spr, vx, vy, colorIdx }

      // 天花板条
      this.ceilingBar = this.add.tileSprite(this.GRID_LEFT, GRID_TOP + this.ceilingOffset - 14, this.GRID_RIGHT - this.GRID_LEFT, 14, 'ceiling').setOrigin(0, 0).setDepth(3);

      // HUD
      this.hudScore = this.add.text(10, 8, 'SCORE 0', { fontSize: '14px', color: '#ffffff', stroke: '#111', strokeThickness: 3, fontStyle: 'bold' }).setDepth(20).setScrollFactor(0);
      this.hudStage = this.add.text(10, 26, 'STAGE 1', { fontSize: '12px', color: '#f1c40f', stroke: '#111', strokeThickness: 3 }).setDepth(20);
      this.hudBest = this.add.text(10, 42, 'BEST 0', { fontSize: '11px', color: '#aab4c0', stroke: '#111', strokeThickness: 2 }).setDepth(20);
      this.hudRows = this.add.text(this.W - 10, 8, 'ROWS 0', { fontSize: '12px', color: '#ffffff', stroke: '#111', strokeThickness: 3 }).setOrigin(1, 0).setDepth(20);
      this.hudShots = this.add.text(this.W - 10, 24, 'SHOTS 0', { fontSize: '11px', color: '#aab4c0' }).setOrigin(1, 0).setDepth(20);
      this.centerText = this.add.text(this.W / 2, this.H / 2 - 10, '', { fontSize: '22px', color: '#ffffff', stroke: '#111', strokeThickness: 5, align: 'center', fontStyle: 'bold' }).setOrigin(0.5).setDepth(50).setVisible(false);
      this.subText = this.add.text(this.W / 2, this.H / 2 + 34, '', { fontSize: '13px', color: '#d5dbdb', stroke: '#111', strokeThickness: 3, align: 'center' }).setOrigin(0.5).setDepth(50).setVisible(false);

      // 标题覆盖
      this.titleText = this.add.text(this.W / 2, this.H / 2 - 40, 'PUZZLE BUBBLE\n泡泡龙', { fontSize: '28px', color: '#ffffff', stroke: '#111', strokeThickness: 6, align: 'center', fontStyle: 'bold' }).setOrigin(0.5).setDepth(60);
      this.titleSub = this.add.text(this.W / 2, this.H / 2 + 28, 'Mouse / ←→ Aim  |  SPACE Shoot  |  P Pause\nMatch 3+  •  Floating bubbles fall  •  Ceiling presses down', { fontSize: '12px', color: '#d5dbdb', stroke: '#111', strokeThickness: 3, align: 'center' }).setOrigin(0.5).setDepth(60);
      this.titleHint = this.add.text(this.W / 2, this.H / 2 + 86, '[SPACE / ENTER] START  —  [1/2] Select Stage', { fontSize: '13px', color: '#f1c40f', stroke: '#111', strokeThickness: 3 }).setOrigin(0.5).setDepth(60);

      // 读取存档
      var self = this;
      if (hostRef && hostRef.loadState) {
        try {
          hostRef.loadState().then(function (d) {
            if (d && typeof d === 'object') {
              if (typeof d.bestScore === 'number') { saveData.bestScore = d.bestScore; }
              if (typeof d.clearedStage === 'number') { saveData.clearedStage = d.clearedStage; }
              self.hudBest.setText('BEST ' + saveData.bestScore);
              self.refreshTitle();
            }
          }, function () {});
        } catch (e) {}
      }

      // 鼠标瞄准
      this.input.on('pointermove', function (pointer) {
        if (self.gameState !== 'playing') { return; }
        var dx = pointer.x - self.LAUNCHER_X;
        var dy = pointer.y - self.LAUNCHER_Y;
        // dy 为负向上；角度 = atan2(dx, -dy)
        var ang = Math.atan2(dx, -dy);
        var lim = deg2rad(AIM_LIMIT_DEG);
        ang = clamp(ang, -lim, lim);
        self.aimRad = ang;
        self.updateAimVisual();
      });
      this.input.on('pointerdown', function (pointer) {
        if (pointer.leftButtonDown && pointer.leftButtonDown()) {} // 兼容
        if (self.gameState === 'title') { self.startStage(self.curStage); return; }
        if (self.gameState === 'over' || self.gameState === 'clear') { self.handleCenterAction(); return; }
        if (self.gameState === 'playing') {
          // 点击即发射
          self.tryShoot();
        }
      });

      // 首输入唤醒音频
      this.input.once('pointerdown', function () { Sfx._ensure(); Sfx._resume(); });
      this.input.keyboard.once('keydown', function () { Sfx._ensure(); Sfx._resume(); });

      // 定时天花板下压
      this.ceilingTimer = this.time.addEvent({
        delay: 1000, loop: true, callback: function () { self.onCeilingTick(); }
      });

      this.refreshTitle();
      this.updateHud();
      this.updateAimVisual();
      Sfx.startBgm(this);
    },

    // -----------------------------------------------------------------------
    // 关卡与网格
    // -----------------------------------------------------------------------
    ensureGridSize: function (rows) {
      this.grid.length = 0;
      this.bubbleSprites.length = 0;
      for (var r = 0; r < rows; r++) {
        var row = []; var srow = [];
        for (var c = 0; c < COLS; c++) { row.push(0); srow.push(null); }
        this.grid.push(row); this.bubbleSprites.push(srow);
      }
    },

    loadStageLayout: function (stageIdx) {
      var st = STAGES[stageIdx - 1] || STAGES[0];
      var rows = Math.max(MAX_ROWS, INIT_ROWS + 6);
      this.ensureGridSize(rows);
      // 清理旧泡泡精灵
      this.clearAllBubbleSprites();
      this.ceilingOffset = 0;
      this.shots = 0;
      this.ceilingAccumMs = 0;
      // 填充初始布局
      for (var r = 0; r < st.layout.length; r++) {
        for (var c = 0; c < COLS; c++) {
          var v = st.layout[r][c] || 0;
          // 限制到该关颜色数
          if (v > st.colors) { v = ((v - 1) % st.colors) + 1; }
          if (v !== 0) { this.setCell(r, c, v); }
        }
      }
      // 随机下一发
      this.nextColor = randInt(1, st.colors);
      this.onDeckColor = randInt(1, st.colors);
      this.updateCeilingBar();
      this.updateNextPreview();
    },

    setCell: function (r, c, colorIdx) {
      if (r < 0 || r >= this.grid.length || c < 0 || c >= COLS) { return; }
      this.grid[r][c] = colorIdx;
      // 创建或复用精灵
      var p = gridToWorld(r, c, this.ceilingOffset, this.GRID_LEFT, GRID_TOP);
      var key = PALETTE[colorIdx - 1].key;
      var spr = this.add.image(p.x, p.y, key).setDepth(2).setScale(1);
      this.bubbleSprites[r][c] = spr;
    },

    clearCellSprite: function (r, c) {
      var spr = this.bubbleSprites[r] && this.bubbleSprites[r][c];
      if (spr) { try { spr.destroy(); } catch (e) {} }
      if (this.bubbleSprites[r]) { this.bubbleSprites[r][c] = null; }
    },

    clearAllBubbleSprites: function () {
      for (var r = 0; r < this.bubbleSprites.length; r++) {
        for (var c = 0; c < COLS; c++) {
          var s = this.bubbleSprites[r][c];
          if (s) { try { s.destroy(); } catch (e2) {} }
        }
      }
    },

    updateCeilingBar: function () {
      if (!this.ceilingBar) { return; }
      this.ceilingBar.y = GRID_TOP + this.ceilingOffset - 14;
      this.ceilingBar.width = this.GRID_RIGHT - this.GRID_LEFT;
      this.ceilingBar.tilePositionX = 0;
    },

    updateNextPreview: function () {
      if (!this.nextPreview || !this.onDeckPreview) { return; }
      if (this.gameState !== 'playing') {
        this.nextPreview.setVisible(false); this.onDeckPreview.setVisible(false); this.onDeckLabel.setVisible(false); return;
      }
      var k1 = PALETTE[this.nextColor - 1].key;
      var k2 = PALETTE[this.onDeckColor - 1].key;
      this.nextPreview.setTexture(k1).setVisible(true);
      this.onDeckPreview.setTexture(k2).setVisible(true);
      this.onDeckLabel.setVisible(true);
      // 发射器内预览跟随炮管角度
      this.nextPreview.setPosition(this.LAUNCHER_X, this.LAUNCHER_Y - 12);
    },

    // -----------------------------------------------------------------------
    // 瞄准与轨迹预览
    // -----------------------------------------------------------------------
    updateAimVisual: function () {
      if (!this.launcherTube) { return; }
      this.launcherTube.setRotation(this.aimRad);
      // 发射器根点
      var lx = this.LAUNCHER_X; var ly = this.LAUNCHER_Y;
      // 瞄准线（短线）
      this.aimLine.clear();
      if (this.gameState === 'playing' && this.canShoot && !this.flying) {
        var len = 44;
        var ex = lx + Math.sin(this.aimRad) * len;
        var ey = ly - Math.cos(this.aimRad) * len;
        this.aimLine.lineStyle(2, 0xffffff, 0.9);
        this.aimLine.beginPath(); this.aimLine.moveTo(lx, ly); this.aimLine.lineTo(ex, ey); this.aimLine.strokePath();
        // 箭头小三角
        this.aimLine.fillStyle(0xffffff, 0.95);
        this.aimLine.fillTriangle(ex, ey, ex - Math.sin(this.aimRad + 0.45) * 8, ey + Math.cos(this.aimRad + 0.45) * 8, ex - Math.sin(this.aimRad - 0.45) * 8, ey + Math.cos(this.aimRad - 0.45) * 8);
      } else {
        this.aimLine.clear();
      }
      this.drawTrajectory();
    },

    drawTrajectory: function () {
      this.trajG.clear();
      if (this.gameState !== 'playing' || !this.canShoot || this.flying) { return; }
      // 预测弹道：模拟小球反弹墙壁，直到碰到顶或已有泡泡区域
      var x = this.LAUNCHER_X;
      var y = this.LAUNCHER_Y - 18;
      var vx = Math.sin(this.aimRad) * SHOOT_SPEED;
      var vy = -Math.cos(this.aimRad) * SHOOT_SPEED;
      var dt = TRAJ_STEP / SHOOT_SPEED; // 时间步
      var points = [{ x: x, y: y }];
      var curX = x; var curY = y;
      var curVx = vx; var curVy = vy;
      // 辅助：检测是否会吸附（与现有泡泡距离 < D 或到顶）
      function willStick(px, py) {
        if (py - BUBBLE_R <= GRID_TOP + this.ceilingOffset + 2) { return true; }
        for (var r = 0; r < this.grid.length; r++) {
          for (var c = 0; c < COLS; c++) {
            if (this.grid[r][c] === 0) { continue; }
            var p = gridToWorld(r, c, this.ceilingOffset, this.GRID_LEFT, GRID_TOP);
            if (dist2(px, py, p.x, p.y) < BUBBLE_D - 2) { return true; }
          }
        }
        return false;
      }
      var willStickBound = willStick.bind(this);
      for (var i = 0; i < TRAJ_SEG; i++) {
        var nx = curX + curVx * dt;
        var ny = curY + curVy * dt;
        // 墙壁反弹
        if (nx - BUBBLE_R < this.GRID_LEFT) { nx = this.GRID_LEFT + BUBBLE_R; curVx = Math.abs(curVx); }
        if (nx + BUBBLE_R > this.GRID_RIGHT) { nx = this.GRID_RIGHT - BUBBLE_R; curVx = -Math.abs(curVx); }
        curX = nx; curY = ny;
        points.push({ x: curX, y: curY });
        if (willStickBound(curX, curY)) { break; }
        if (curY < GRID_TOP - 20 || curY > this.H) { break; }
      }
      // 画虚线
      this.trajG.lineStyle(2, 0xffffff, 0.55);
      for (var s = 0; s < points.length - 1; s++) {
        var a = points[s]; var b = points[s + 1];
        // 每段画虚线：间隔 4px
        var segLen = dist2(a.x, a.y, b.x, b.y);
        var steps = Math.max(1, Math.floor(segLen / 6));
        for (var t = 0; t < steps; t++) {
          if (t % 2 === 0) {
            var f = t / steps; var ff = (t + 1) / steps;
            var sx = a.x + (b.x - a.x) * f; var sy = a.y + (b.y - a.y) * f;
            var ex2 = a.x + (b.x - a.x) * ff; var ey2 = a.y + (b.y - a.y) * ff;
            this.trajG.beginPath(); this.trajG.moveTo(sx, sy); this.trajG.lineTo(ex2, ey2); this.trajG.strokePath();
          }
        }
      }
      // 落点小圈
      if (points.length > 1) {
        var last = points[points.length - 1];
        this.trajG.lineStyle(1.5, 0xf1c40f, 0.95);
        this.trajG.strokeCircle(last.x, last.y, 10);
        this.trajG.fillStyle(0xf1c40f, 0.18); this.trajG.fillCircle(last.x, last.y, 10);
      }
    },

    // -----------------------------------------------------------------------
    // 发射
    // -----------------------------------------------------------------------
    tryShoot: function () {
      if (!this.canShoot || this.flying || this.gameState !== 'playing') { return; }
      var color = this.nextColor;
      var spr = this.flyingPool.pop() || this.add.image(this.LAUNCHER_X, this.LAUNCHER_Y, PALETTE[color - 1].key).setDepth(9);
      spr.setTexture(PALETTE[color - 1].key).setPosition(this.LAUNCHER_X, this.LAUNCHER_Y - 14).setVisible(true).setScale(1).setAlpha(1);
      var vx = Math.sin(this.aimRad) * SHOOT_SPEED;
      var vy = -Math.cos(this.aimRad) * SHOOT_SPEED;
      this.flying = { spr: spr, vx: vx, vy: vy, color: color };
      // 推进队列
      this.nextColor = this.onDeckColor;
      var st = STAGES[this.curStage - 1];
      this.onDeckColor = randInt(1, st.colors);
      this.updateNextPreview();
      this.shots++; this.hudShots.setText('SHOTS ' + this.shots);
      Sfx.play('shoot');
      // 检查步数下压
      this.maybePushCeilingBySteps();
    },

    obtainFlyingSprite: function (color) {
      var spr = this.flyingPool.pop();
      if (!spr) { spr = this.add.image(-100, -100, PALETTE[color - 1].key).setDepth(9); }
      spr.setTexture(PALETTE[color - 1].key);
      return spr;
    },

    recycleFlyingSprite: function (spr) {
      spr.setVisible(false); spr.setPosition(-100, -100);
      if (this.flyingPool.length < 10) { this.flyingPool.push(spr); } else { try { spr.destroy(); } catch (e) {} }
    },

    // -----------------------------------------------------------------------
    // 贴格与消除
    // -----------------------------------------------------------------------
    attachFlying: function (wx, wy) {
      var col = this.flying.color;
      var spr = this.flying.spr;
      this.flying = null;
      // 找最近空格
      var cell = nearestEmpty(this.grid, wx, wy, this.ceilingOffset, this.GRID_LEFT, GRID_TOP);
      if (!cell) {
        // 无空位，判失败
        this.recycleFlyingSprite(spr);
        this.triggerGameOver('堵死了！');
        return;
      }
      var r = cell[0]; var c = cell[1];
      // 贴格
      this.grid[r][c] = col;
      var p = gridToWorld(r, c, this.ceilingOffset, this.GRID_LEFT, GRID_TOP);
      spr.setPosition(p.x, p.y);
      // 将飞行精灵转为静态
      spr.setDepth(2);
      this.bubbleSprites[r][c] = spr;
      Sfx.play('attach');
      // 轻微缩放回弹
      try {
        this.tweens.add({ targets: spr, scale: 1.18, duration: 90, yoyo: true, ease: 'Quad.easeOut' });
      } catch (e) {}
      this.canShoot = false;
      var self = this;
      // 延迟一帧做消除，等待贴合动画
      this.time.delayedCall(110, function () { self.resolveMatch(r, c); });
    },

    resolveMatch: function (sr, sc) {
      var color = this.grid[sr][sc];
      if (!color) { this.canShoot = true; this.updateAimVisual(); this.checkWinOrLose(); return; }
      var cluster = bfsCluster(this.grid, sr, sc, color);
      if (cluster.length >= 3) {
        // 消除同色
        for (var i = 0; i < cluster.length; i++) {
          var r = cluster[i][0]; var c = cluster[i][1];
          this.popBubble(r, c);
        }
        this.score += cluster.length * SCORE_POP;
        Sfx.play('pop');
        this.updateHud();
        // 悬空检测
        var floating = floatingCells(this.grid);
        if (floating.length > 0) {
          for (var f = 0; f < floating.length; f++) {
            var fr = floating[f][0]; var fc = floating[f][1];
            this.fallBubble(fr, fc);
          }
          this.score += floating.length * SCORE_FALL;
          Sfx.play('fall');
          this.updateHud();
        }
        // 分数存档
        if (this.score > saveData.bestScore) { saveData.bestScore = this.score; persist(); this.hudBest.setText('BEST ' + saveData.bestScore); }
        var self = this;
        this.time.delayedCall(420, function () {
          self.canShoot = true; self.updateAimVisual(); self.checkWinOrLose();
        });
      } else {
        // 未消除，仅检查悬空是否因贴格导致？一般不会，但仍检测坠落边界
        this.canShoot = true; this.updateAimVisual(); this.checkWinOrLose();
      }
    },

    popBubble: function (r, c) {
      var spr = this.bubbleSprites[r] && this.bubbleSprites[r][c];
      this.grid[r][c] = 0;
      if (!spr) { return; }
      this.bubbleSprites[r][c] = null;
      // 粒子爆开（零外部资源，生成小点）
      for (var i = 0; i < 5; i++) {
        var dot = this.add.image(spr.x, spr.y, 'pop_dot').setDepth(10).setTint(PALETTE[randInt(0, PALETTE.length - 1)].hex).setScale(1);
        try {
          this.tweens.add({
            targets: dot,
            x: spr.x + randInt(-28, 28),
            y: spr.y + randInt(-28, 28),
            alpha: 0,
            scale: 0.35,
            duration: 280 + randInt(0, 120),
            ease: 'Quad.easeOut',
            onComplete: function (t, targets) { try { targets[0].destroy(); } catch (e2) {} }
          });
        } catch (e) { try { dot.destroy(); } catch (e2) {} }
      }
      // 缩小消失
      try {
        var s = spr;
        this.tweens.add({
          targets: s, scale: 0, alpha: 0, duration: 180, ease: 'Back.easeIn',
          onComplete: function () { try { s.destroy(); } catch (e3) {} }
        });
      } catch (e4) { try { spr.destroy(); } catch (e5) {} }
    },

    fallBubble: function (r, c) {
      var spr = this.bubbleSprites[r] && this.bubbleSprites[r][c];
      this.grid[r][c] = 0;
      if (!spr) { return; }
      this.bubbleSprites[r][c] = null;
      spr.setDepth(8);
      try {
        this.tweens.add({
          targets: spr,
          y: this.H + 24,
          angle: randInt(-180, 180),
          alpha: 0,
          duration: 520 + randInt(0, 220),
          ease: 'Quad.easeIn',
          onComplete: function (t, targets) { try { targets[0].destroy(); } catch (e) {} }
        });
      } catch (e) { try { spr.destroy(); } catch (e2) {} }
    },

    // -----------------------------------------------------------------------
    // 天花板下压与胜负
    // -----------------------------------------------------------------------
    maybePushCeilingBySteps: function () {
      var st = STAGES[this.curStage - 1];
      if (this.shots % st.ceilingSteps === 0) { this.pushCeiling(1); }
    },

    onCeilingTick: function () {
      if (this.gameState !== 'playing') { return; }
      this.ceilingAccumMs = (this.ceilingAccumMs || 0) + 1000;
      var st = STAGES[this.curStage - 1];
      if (this.ceilingAccumMs >= st.ceilingMs) {
        this.ceilingAccumMs = 0;
        this.pushCeiling(1);
      }
      // 预警闪烁：当最低泡泡接近底线
      var lowest = this.lowestBubbleY();
      if (lowest !== null && lowest + BUBBLE_R >= this.BOTTOM_LINE - 42) {
        if (this.time.now > this.warnUntil) {
          this.warnUntil = this.time.now + 900;
          Sfx.play('warning');
          try { this.cameras.main.flash(120, 255, 80, 80); } catch (e) {}
        }
      }
    },

    pushCeiling: function (rows) {
      if (this.gameState !== 'playing') { return; }
      this.ceilingOffset += rows * ROW_H;
      this.updateCeilingBar();
      // 所有泡泡整体下移（同步 grid 世界 y）
      for (var r = 0; r < this.grid.length; r++) {
        for (var c = 0; c < COLS; c++) {
          var spr = this.bubbleSprites[r][c];
          if (spr) {
            var p = gridToWorld(r, c, this.ceilingOffset, this.GRID_LEFT, GRID_TOP);
            try { this.tweens.add({ targets: spr, y: p.y, duration: 260, ease: 'Quad.easeOut' }); } catch (e) { spr.y = p.y; }
          }
        }
      }
      // 顶行新增随机泡泡（可选，避免空顶更压迫）—— 每推一行在顶行空位补 30% 概率
      var st = STAGES[this.curStage - 1];
      // 实际我们已用 offset 模拟下压，不再插入新行到数组头部（避免重索引复杂）；
      // 改为在最高空行的空位随机补色，保持压迫感且不破坏现有索引语义
      // 找到当前最小编号的空行顶附近补几个
      for (var cc = 0; cc < COLS; cc++) {
        if (this.grid[0][cc] === 0 && Math.random() < 0.22) {
          this.setCell(0, cc, randInt(1, st.colors));
        }
      }
      Sfx.play('warning');
      this.updateHud();
      this.checkWinOrLose();
    },

    lowestBubbleY: function () {
      var low = null;
      for (var r = 0; r < this.grid.length; r++) {
        for (var c = 0; c < COLS; c++) {
          if (this.grid[r][c] === 0) { continue; }
          var p = gridToWorld(r, c, this.ceilingOffset, this.GRID_LEFT, GRID_TOP);
          if (low === null || p.y > low) { low = p.y; }
        }
      }
      if (this.gameState === 'playing' && this.flying) { low = Math.max(low || 0, this.flying.spr.y); }
      return low;
    },

    checkWinOrLose: function () {
      if (this.gameState !== 'playing') { return; }
      // 胜利：棋盘无泡泡
      var any = false;
      for (var r = 0; r < this.grid.length; r++) { for (var c = 0; c < COLS; c++) { if (this.grid[r][c] !== 0) { any = true; break; } } if (any) { break; } }
      if (!any) {
        this.handleStageClear();
        return;
      }
      // 失败：最低泡泡压过底线
      var low = this.lowestBubbleY();
      if (low !== null && low + BUBBLE_R >= this.BOTTOM_LINE - GAMEOVER_MARGIN) {
        this.triggerGameOver('天花板压到底线！');
      }
    },

    handleStageClear: function () {
      this.gameState = 'clear';
      this.canShoot = false;
      if (this.flying) { try { this.recycleFlyingSprite(this.flying.spr); } catch (e) {} this.flying = null; }
      Sfx.play('clear');
      Sfx.stopBgm();
      if (this.curStage > saveData.clearedStage) { saveData.clearedStage = this.curStage; persist(); }
      var isLast = this.curStage >= STAGES.length;
      if (isLast) {
        this.showCenter('全部通关！', '总分 ' + this.score + '  |  BEST ' + Math.max(saveData.bestScore, this.score) + '\n[SPACE/R] 重玩  [1/2] 选关', '#2ecc71');
      } else {
        this.showCenter('STAGE ' + this.curStage + ' CLEAR!', '得分 ' + this.score + '  |  按 SPACE 进入下一关\n[R] 重玩本关  [1/2] 选关', '#f1c40f');
      }
      if (this.score > saveData.bestScore) { saveData.bestScore = this.score; this.hudBest.setText('BEST ' + saveData.bestScore); persist(); }
    },

    triggerGameOver: function (reason) {
      if (this.gameState === 'over') { return; }
      this.gameState = 'over';
      this.canShoot = false;
      Sfx.play('over');
      Sfx.stopBgm();
      if (this.score > saveData.bestScore) { saveData.bestScore = this.score; this.hudBest.setText('BEST ' + saveData.bestScore); persist(); }
      this.showCenter('GAME OVER', (reason || '') + '\n得分 ' + this.score + '  BEST ' + saveData.bestScore + '\n[SPACE/R] 重试  [1/2] 选关', '#e74c3c');
    },

    // -----------------------------------------------------------------------
    // UI 辅助
    // -----------------------------------------------------------------------
    showCenter: function (title, sub, color) {
      this.centerText.setText(title).setColor(color || '#ffffff').setVisible(true).setAlpha(0);
      this.subText.setText(sub || '').setVisible(true).setAlpha(0);
      try {
        this.tweens.add({ targets: this.centerText, alpha: 1, scale: 1.05, duration: 220, ease: 'Quad.easeOut', yoyo: false });
        this.tweens.add({ targets: this.subText, alpha: 1, duration: 220, delay: 80 });
      } catch (e) { this.centerText.setAlpha(1); this.subText.setAlpha(1); }
    },

    hideCenter: function () {
      this.centerText.setVisible(false); this.subText.setVisible(false);
    },

    refreshTitle: function () {
      if (this.gameState !== 'title') { return; }
      var extra = '';
      if (saveData.clearedStage > 0) { extra = '\n已通关至 Stage ' + saveData.clearedStage + '  |  最高分 ' + saveData.bestScore; }
      this.titleHint.setText('[SPACE / ENTER / 点击] START  —  [1/2] Select Stage' + extra);
    },

    updateHud: function () {
      this.hudScore.setText('SCORE ' + this.score);
      this.hudStage.setText('STAGE ' + this.curStage + ' — ' + STAGES[this.curStage - 1].title);
      this.hudStage.setColor(this.curStage === 1 ? '#f1c40f' : '#e67e22');
      this.hudBest.setText('BEST ' + saveData.bestScore);
      var rows = occupiedRows(this.grid);
      this.hudRows.setText('ROWS ' + rows);
      this.hudShots.setText('SHOTS ' + this.shots + '  CEIL ' + Math.floor(this.ceilingOffset / ROW_H));
    },

    // -----------------------------------------------------------------------
    // 流程控制
    // -----------------------------------------------------------------------
    startStage: function (idx) {
      this.curStage = clamp(idx, 1, STAGES.length);
      this.score = 0;
      this.loadStageLayout(this.curStage);
      this.gameState = 'playing';
      this.canShoot = true;
      this.aimRad = 0;
      if (this.flying) { try { this.recycleFlyingSprite(this.flying.spr); } catch (e) {} this.flying = null; }
      this.titleText.setVisible(false); this.titleSub.setVisible(false); this.titleHint.setVisible(false);
      this.hideCenter();
      this.updateHud(); this.updateAimVisual(); this.updateNextPreview();
      Sfx.startBgm(this);
    },

    handleCenterAction: function () {
      if (this.gameState === 'clear') {
        if (this.curStage < STAGES.length) { this.startStage(this.curStage + 1); }
        else { this.startStage(1); }
      } else if (this.gameState === 'over') {
        this.startStage(this.curStage);
      }
    },

    togglePause: function () {
      if (this.gameState === 'playing') {
        this.gameState = 'paused';
        this.showCenter('PAUSED', '[P / SPACE] Resume  [R] Restart', '#3498db');
        Sfx.stopBgm();
      } else if (this.gameState === 'paused') {
        this.gameState = 'playing';
        this.hideCenter();
        Sfx.startBgm(this);
      }
    },

    // -----------------------------------------------------------------------
    // 帧循环
    // -----------------------------------------------------------------------
    update: function (time, delta) {
      var dt = delta / 1000;

      // 数字键 1/2 随时切关（标题/游戏中均可）
      if (Phaser.Input.Keyboard.JustDown(this.keyOne) || Phaser.Input.Keyboard.JustDown(this.keyNumpadOne)) {
        this.startStage(1); return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keyTwo) || Phaser.Input.Keyboard.JustDown(this.keyNumpadTwo)) {
        this.startStage(2); return;
      }
      // 标题态按键
      if (this.gameState === 'title') {
        if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER)) {
          this.startStage(this.curStage);
        }
        return;
      }
      // R 重开 / P 暂停
      if (Phaser.Input.Keyboard.JustDown(this.keys.R)) {
        if (this.gameState === 'over' || this.gameState === 'clear' || this.gameState === 'paused') { this.handleCenterAction(); }
        else if (this.gameState === 'playing') { this.startStage(this.curStage); }
        return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.P)) { this.togglePause(); return; }
      if ((this.gameState === 'over' || this.gameState === 'clear') && (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER))) { this.handleCenterAction(); return; }
      if (this.gameState === 'paused') {
        if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER)) { this.togglePause(); return; }
        return;
      }
      if (this.gameState !== 'playing') { return; }

      // 键盘瞄准
      var aimStep = 1.9 * dt; // rad/s
      if (this.keys.LEFT.isDown || this.keys.A.isDown) { this.aimRad -= aimStep; }
      if (this.keys.RIGHT.isDown || this.keys.D.isDown) { this.aimRad += aimStep; }
      this.aimRad = clamp(this.aimRad, deg2rad(-AIM_LIMIT_DEG), deg2rad(AIM_LIMIT_DEG));
      // 键盘发射
      if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER)) { this.tryShoot(); }
      this.updateAimVisual();

      // 飞行泡泡推进
      if (this.flying) {
        var spr2 = this.flying.spr;
        var nx = spr2.x + this.flying.vx * dt;
        var ny = spr2.y + this.flying.vy * dt;
        // 墙壁反弹
        if (nx - BUBBLE_R < this.GRID_LEFT) { nx = this.GRID_LEFT + BUBBLE_R; this.flying.vx = Math.abs(this.flying.vx); Sfx.play('attach'); }
        if (nx + BUBBLE_R > this.GRID_RIGHT) { nx = this.GRID_RIGHT - BUBBLE_R; this.flying.vx = -Math.abs(this.flying.vx); Sfx.play('attach'); }
        spr2.setPosition(nx, ny);
        // 顶碰撞
        if (ny - BUBBLE_R <= GRID_TOP + this.ceilingOffset) {
          this.attachFlying(nx, GRID_TOP + this.ceilingOffset + BUBBLE_R);
          return;
        }
        // 与现有泡泡碰撞（距离判定）
        var hit = false;
        for (var r = 0; r < this.grid.length; r++) {
          for (var c = 0; c < COLS; c++) {
            if (this.grid[r][c] === 0) { continue; }
            var p = gridToWorld(r, c, this.ceilingOffset, this.GRID_LEFT, GRID_TOP);
            if (dist2(nx, ny, p.x, p.y) < BUBBLE_D - 1.2) { hit = true; break; }
          }
          if (hit) { break; }
        }
        if (hit) { this.attachFlying(nx, ny); return; }
        // 飞出底线（异常）
        if (ny > this.H + 40) {
          try { this.recycleFlyingSprite(spr2); } catch (e5) {}
          this.flying = null; this.canShoot = true; this.updateAimVisual();
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  function launch(host) {
    hostRef = host;
    var Phaser = host.phaser;
    if (!Phaser) { throw new Error('Phaser not loaded'); }

    // 键盘数字键兜底：给 keys 补 ONE/TWO
    // host 尺寸
    var W = host.width || 960;
    var H = host.height || 540;

    var config = {
      type: Phaser.AUTO,
      parent: host.container,
      width: W, height: H,
      backgroundColor: '#0d1b2a',
      physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
      scene: [MainScene]
    };
    var game = new Phaser.Game(config);
    // 存档恢复后刷新标题在 create 中处理
    window.__trgame = { game: game, getState: getState, _scene: function () { return sceneRef; } };
    return game;
  }

  if (typeof window.TRGames !== 'undefined' && typeof window.TRGames.register === 'function') {
    window.TRGames.register({ id: 'puzzle-bubble', title: 'Puzzle Bubble 泡泡龙', launch: launch });
  }
})();
