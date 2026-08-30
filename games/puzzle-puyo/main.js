// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改：
//   视觉：
//     buildTextures() 内的 this.add.graphics()+generateTexture('puyo_*')
//       → 换成 this.load.image('puyo_red','assets/puyo_red.png') 等；
//       纹理名：puyo_red/puyo_green/puyo_blue/puyo_yellow/puyo_purple/
//              puyo_garbage（垃圾Puyo 灰色石纹）、puyo_shine（连体高光遮罩可选）、bg_cell/bg_frame
//       每块生成段落已用「将来换」中文注释标出；几何体仅为占位，可无缝替换为位图/sheet。
//     眼睛/高光 现用 graphics 椭圆/圆形 → 换成 spritesheet 帧或序列动画
//       this.load.spritesheet('puyo_anim','assets/puyo.png',{frameWidth:32,frameHeight:32})
//   音频：
//     Sfx.play('rotate'/'move'/'lock'/'pop'/'chain'/'garbage'/'gameover'/'bgm')
//       内部 WebAudio oscillator+gain → 换成 this.load.audio('pop','assets/pop.wav')+this.sound.play
//       文件顶部 Sfx 块已写替换写法；BGM 章节区分现用不同音阶序列，将来换不同 ogg。
//   扩展：
//     对战垃圾 Puyo 预告条 → 换成网络对战时服务端推送的 garbageQueue，此处仅本地单机简化版
//     关卡色种/下落速度见 LEVELS；地图为动态生成，无外部 JSON
// =============================================================================
(function () {
  'use strict';

  // ==========================================================================
  // 常量
  // ==========================================================================
  /** 场宽 列 */
  var W = 6;
  /** 场高 行（12 行，可见 12，顶部 2 行为隐藏生成区但本实现全部可见，叠顶即GameOver） */
  var H = 12;
  /** 单格边长 px */
  var CELL = 30;
  /** 场地左上角在 scene 内的偏移 px */
  var OFF_X = 86;
  var OFF_Y = 36;
  /** Puyo 颜色 id：1..5 正常色，6 垃圾(灰) —— 垃圾永不消除，仅重力下落 */
  var COLORS = [1, 2, 3, 4, 5];
  /** 垃圾 id */
  var GARBAGE = 6;
  /** 颜色调色板（含垃圾） */
  var PALETTE = {
    1: 0xff4444, 2: 0x44d24a, 3: 0x4488ff, 4: 0xffd23f, 5: 0xc44dff, 6: 0x8a8a8a
  };
  var PALETTE_DARK = {
    1: 0xcc2222, 2: 0x2e9a32, 3: 0x2a5fcc, 4: 0xc9a820, 5: 0x8a2fbf, 6: 0x5a5a5a
  };
  var COLOR_NAMES = { 1: '红', 2: '绿', 3: '蓝', 4: '黄', 5: '紫', 6: '灰' };

  /** 关卡定义：至少2关，色种与下落速度区分
   *  将来换：可改为外部 JSON 关卡表
   */
  var LEVELS = [
    { id: 1, name: '关卡 1 · 轻松', colors: 4, fallMs: 700, title: 'EASY' },
    { id: 2, name: '关卡 2 · 挑战', colors: 5, fallMs: 420, title: 'HARD' }
  ];
  /** 软降每格加速 ms（按住↓） */
  var SOFT_DROP_MS = 70;
  /** 锁定前摇 ms（触底后给一小段时间可横移/旋转） */
  var LOCK_DELAY = 320;
  /** 消除动画时长 ms */
  var POP_MS = 380;
  /** 下落补位 tween 时长 ms */
  var FALL_MS = 130;

  /** 计分常量：简化版 Puyo 计分
   *  base = 10 * 消除块数
   *  bonus = chainBonus + groupBonus + colorBonus
   *  chainBonus: [0,8,16,32,64,128,256,512,999]  — chain 从1开始，chain=1→0
   *  groupBonus: 每组 (n-4) 累加，n>=5 时 (n-4) 额外
   *  colorBonus: 使用色种数-1 映射 (1种0, 2种3, 3种6, 4种12, 5种24)
   *  最终得分 += base * max(1, bonus)
   */
  var CHAIN_POW = [0, 0, 8, 16, 32, 64, 128, 256, 512, 999];
  var COLOR_POW = [0, 0, 3, 6, 12, 24];

  // ==========================================================================
  // 存档与状态（对应 Acceptance getState + hiScore/maxChain）
  // ==========================================================================
  var hostRef = null;
  var sceneRef = null;
  var SAVE_KEY = 'puzzle_puyo_save';
  var saveCache = { hiScore: 0, maxChain: 0 };

  function loadSave() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (typeof d.hiScore === 'number') { saveCache.hiScore = d.hiScore; }
        if (typeof d.maxChain === 'number') { saveCache.maxChain = d.maxChain; }
      }
    } catch (e) {}
    // host 存档优先（若可用）
    if (hostRef && hostRef.loadState) {
      try {
        hostRef.loadState().then(function (d) {
          if (d && typeof d === 'object') {
            if (typeof d.hiScore === 'number') { saveCache.hiScore = Math.max(saveCache.hiScore, d.hiScore); }
            if (typeof d.maxChain === 'number') { saveCache.maxChain = Math.max(saveCache.maxChain, d.maxChain); }
          }
        }, function () {});
      } catch (e2) {}
    }
  }
  function persistSave() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(saveCache)); } catch (e) {}
    if (hostRef && hostRef.saveState) {
      try { hostRef.saveState({ hiScore: saveCache.hiScore, maxChain: saveCache.maxChain }); } catch (e2) {}
    }
  }
  function getState() {
    if (!sceneRef) { return { scene: 'loading', score: 0, chain: 0, board: null }; }
    return {
      scene: sceneRef.phase || 'menu',
      score: sceneRef.score || 0,
      chain: sceneRef.chainLast || 0,
      board: sceneRef.board ? JSON.parse(JSON.stringify(sceneRef.board)) : null
    };
  }

  // ==========================================================================
  // Sfx — WebAudio，注释写将来换 this.load.audio
  // 将来换：preload(){ this.load.audio('pop','assets/pop.wav'); } play(){ this.sound.play(name); }
  // ==========================================================================
  var Sfx = {
    ctx: null, enabled: true,
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
      if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    },
    play: function (name) {
      var c = this._ensure(); if (!c || !this.enabled) { return; }
      this._resume();
      try {
        var o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        var now = c.currentTime;
        // 将来换采样：switch 内每分支换成 AudioBufferSource
        if (name === 'rotate') {
          o.type = 'square'; o.frequency.setValueAtTime(620, now);
          o.frequency.linearRampToValueAtTime(880, now + 0.06);
          g.gain.setValueAtTime(0.14, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
          o.start(now); o.stop(now + 0.13);
        } else if (name === 'move') {
          o.type = 'sine'; o.frequency.setValueAtTime(300, now);
          g.gain.setValueAtTime(0.10, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
          o.start(now); o.stop(now + 0.09);
        } else if (name === 'lock') {
          o.type = 'triangle'; o.frequency.setValueAtTime(180, now);
          o.frequency.linearRampToValueAtTime(120, now + 0.12);
          g.gain.setValueAtTime(0.22, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
          o.start(now); o.stop(now + 0.19);
        } else if (name === 'pop') {
          o.type = 'sine'; o.frequency.setValueAtTime(700, now);
          o.frequency.linearRampToValueAtTime(1050, now + 0.14);
          g.gain.setValueAtTime(0.28, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
          o.start(now); o.stop(now + 0.29);
        } else if (name === 'chain') {
          o.type = 'square'; o.frequency.setValueAtTime(523, now);
          o.frequency.setValueAtTime(659, now + 0.10); o.frequency.setValueAtTime(784, now + 0.20);
          g.gain.setValueAtTime(0.22, now); g.gain.linearRampToValueAtTime(0.001, now + 0.38);
          o.start(now); o.stop(now + 0.39);
        } else if (name === 'garbage') {
          o.type = 'sawtooth'; o.frequency.setValueAtTime(120, now);
          o.frequency.linearRampToValueAtTime(80, now + 0.22);
          g.gain.setValueAtTime(0.20, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
          o.start(now); o.stop(now + 0.27);
        } else if (name === 'gameover') {
          o.type = 'sawtooth'; o.frequency.setValueAtTime(200, now);
          o.frequency.linearRampToValueAtTime(50, now + 0.6);
          g.gain.setValueAtTime(0.30, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
          o.start(now); o.stop(now + 0.71);
        } else if (name === 'select') {
          o.type = 'sine'; o.frequency.setValueAtTime(520, now);
          g.gain.setValueAtTime(0.16, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
          o.start(now); o.stop(now + 0.12);
        }
      } catch (e) {}
    },
    _bgmTimer: null,
    startBgm: function (scene, stage) {
      this.stopBgm();
      var self = this;
      // 将来换 BGM：换成 this.load.audio('bgm1','assets/bgm1.ogg') + loop
      var base = stage === 2 ? 440 : 330;
      var seq = stage === 2 ? [0, 4, 7, 4, 0, -5, 0, 7] : [0, 2, 4, 7, 4, 2, 0, -2];
      var idx = 0;
      this._bgmTimer = scene.time.addEvent({
        delay: stage === 2 ? 260 : 360, loop: true, callback: function () {
          var c2 = self._ensure(); if (!c2 || !self.enabled) { return; }
          try {
            var o2 = c2.createOscillator(), g2 = c2.createGain();
            o2.connect(g2); g2.connect(c2.destination);
            var now2 = c2.currentTime;
            var semi = seq[idx % seq.length]; idx++;
            var f = base * Math.pow(2, semi / 12);
            o2.type = 'triangle'; o2.frequency.setValueAtTime(f, now2);
            g2.gain.setValueAtTime(0.06, now2); g2.gain.exponentialRampToValueAtTime(0.001, now2 + 0.22);
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
  // 纯逻辑：board / 消除 / 重力 / 计分 —— 零依赖，可单测 / node --check 校验
  // board[y][x]  y=0 顶，y=H-1 底。0 空，1..5 色，6 垃圾
  // ==========================================================================

  /** 新空板 HxW */
  function makeEmptyBoard() {
    var b = [];
    for (var y = 0; y < H; y++) {
      var row = [];
      for (var x = 0; x < W; x++) { row.push(0); }
      b.push(row);
    }
    return b;
  }

  /** 深拷 board */
  function cloneBoard(b) {
    var c = [];
    for (var y = 0; y < H; y++) { c.push(b[y].slice(0)); }
    return c;
  }

  /** 随机色（按关卡色种数） */
  function randomColor(colorCount) {
    return 1 + Math.floor(Math.random() * colorCount);
  }

  /** 组大小奖励：(n-4) 的累计，但 n<5 时0；用于得分 bonus */
  function groupBonusForSize(n) {
    if (n < 5) { return 0; }
    if (n === 5) { return 2; }
    if (n === 6) { return 3; }
    if (n === 7) { return 4; }
    if (n === 8) { return 5; }
    if (n === 9) { return 6; }
    if (n === 10) { return 7; }
    return 10; // 11+
  }

  /**
   * 在 board 上找所有 >=4 同色连通组（4方向，垃圾永不参与）
   * @returns {{groups:Array<Array<{x:number,y:number}>>, cells:Set<string>, colors:Set<number>}}
   */
  function findGroups(board) {
    var visited = [];
    for (var y = 0; y < H; y++) { visited.push([]); for (var x = 0; x < W; x++) { visited[y].push(false); } }
    var groups = [];
    var allCells = [];
    var colors = {};
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var sy = 0; sy < H; sy++) {
      for (var sx = 0; sx < W; sx++) {
        if (visited[sy][sx]) { continue; }
        var col = board[sy][sx];
        if (col === 0 || col === GARBAGE) { visited[sy][sx] = true; continue; }
        // BFS
        var q = [{ x: sx, y: sy }];
        visited[sy][sx] = true;
        var comp = [{ x: sx, y: sy }];
        var qi = 0;
        while (qi < q.length) {
          var cur = q[qi++];
          for (var d = 0; d < 4; d++) {
            var nx = cur.x + dirs[d][0], ny = cur.y + dirs[d][1];
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) { continue; }
            if (visited[ny][nx]) { continue; }
            if (board[ny][nx] !== col) { continue; }
            visited[ny][nx] = true;
            q.push({ x: nx, y: ny });
            comp.push({ x: nx, y: ny });
          }
        }
        if (comp.length >= 4) {
          groups.push(comp);
          colors[col] = true;
          for (var ci = 0; ci < comp.length; ci++) { allCells.push(comp[ci]); }
        }
        // 孤块已标记 visited，不再重复
        // 但 visited 标记在 BFS 内已完成；未加入 allCells 的单块不会消除
        // 需额外标记：BFS 已把连通块都 visited，这里无需额外处理
      }
    }
    // 标记非连通 >=4 的已访问，避免重复扫描：上面 visited 已覆盖所有块
    // 补：已访问的所有格在循环中都 visited，下一轮会自动跳过
    return { groups: groups, cells: allCells, colors: colors };
  }

  /** 在 board 上抹掉 cells（置0），返回消除数 */
  function eraseCells(board, cells) {
    for (var i = 0; i < cells.length; i++) { board[cells[i].y][cells[i].x] = 0; }
    return cells.length;
  }

  /** 重力：每列向下压实，返回每列的下落映射用于动画（可选）
   *  原地修改 board，空隙上浮填0
   */
  function applyGravity(board) {
    for (var x = 0; x < W; x++) {
      var write = H - 1;
      for (var y = H - 1; y >= 0; y--) {
        if (board[y][x] !== 0) {
          var v = board[y][x];
          board[y][x] = 0;
          board[write][x] = v;
          write--;
        }
      }
    }
  }

  /** 计分：按 Puyo 计分简化版
   *  @param {number} chain  — 当前连锁数（1开始）
   *  @param {Array<Array<{x,y}>>} groups
   *  @param {Object} colorsMap  — 颜色集合
   *  @returns {{score:number, bonus:number, chainPow:number, groupPow:number, colorPow:number}}
   */
  function scoreForPop(chain, groups, colorsMap) {
    var totalCells = 0;
    var groupPow = 0;
    for (var i = 0; i < groups.length; i++) {
      totalCells += groups[i].length;
      groupPow += groupBonusForSize(groups[i].length);
    }
    var colorCount = 0;
    for (var k in colorsMap) { if (colorsMap.hasOwnProperty(k)) { colorCount++; } }
    var colorPow = colorCount <= 1 ? 0 : COLOR_POW[Math.min(colorCount, 5)];
    var cPow = CHAIN_POW[Math.min(chain, CHAIN_POW.length - 1)];
    var bonus = cPow + groupPow + colorPow;
    if (bonus < 1) { bonus = 1; }
    var score = 10 * totalCells * bonus;
    return { score: score, bonus: bonus, chainPow: cPow, groupPow: groupPow, colorPow: colorPow, cells: totalCells };
  }

  /**
   * 垃圾行：在底部插入1行垃圾 Puyo（带1随机缺口，便于化解）
   *  全板上移1行，若顶行非空则溢出判 GameOver（由调用方检测）
   *  @param {number[][]} board
   *  @returns {boolean} 是否溢出顶
   */
  function pushGarbageRow(board) {
    // 顶行有块则上移会溢出
    for (var x = 0; x < W; x++) { if (board[0][x] !== 0) { return true; } }
    // 上移
    for (var y = 0; y < H - 1; y++) { for (var x2 = 0; x2 < W; x2++) { board[y][x2] = board[y + 1][x2]; } }
    var gap = Math.floor(Math.random() * W);
    for (var x3 = 0; x3 < W; x3++) { board[H - 1][x3] = (x3 === gap ? 0 : GARBAGE); }
    return false;
  }

  /**
   * 完整连锁结算（同步逻辑版，供测试/校验用）
   *  输入 board 已固定完本次落子，循环：找组→计分→消除→重力，直到无组
   *  @returns {{chain:number, score:number, steps:Array<{groups,cells,scoreInfo}>}}
   */
  function resolveChains(board) {
    var b = cloneBoard(board);
    var chain = 0;
    var totalScore = 0;
    var steps = [];
    while (true) {
      var res = findGroups(b);
      if (res.groups.length === 0) { break; }
      chain++;
      var si = scoreForPop(chain, res.groups, res.colors);
      totalScore += si.score;
      steps.push({ chain: chain, groups: res.groups, cells: res.cells.slice(0), scoreInfo: si });
      eraseCells(b, res.cells);
      applyGravity(b);
    }
    // 将最终板写回原 board（若需要）
    for (var y = 0; y < H; y++) { for (var x = 0; x < W; x++) { board[y][x] = b[y][x]; } }
    return { chain: chain, score: totalScore, steps: steps };
  }

  // ==========================================================================
  // 视觉纹理（纯几何体）—— 将来换 load.image
  // ==========================================================================
  function buildTextures(scene) {
    function rm(k) { if (scene.textures.exists(k)) { try { scene.textures.remove(k); } catch (e) {} } }
    var g, i;

    // 单元格背景格子（棋盘淡灰）—— 将来换 bg_cell.png
    rm('bg_cell');
    g = scene.add.graphics();
    g.fillStyle(0x242a36, 1); g.fillRect(0, 0, CELL, CELL);
    g.lineStyle(1, 0x2f3748, 1); g.strokeRect(0, 0, CELL, CELL);
    g.generateTexture('bg_cell', CELL, CELL); g.destroy();

    // 场地边框（描边矩形）—— 将来换 bg_frame.png（九宫格）
    rm('bg_frame');
    g = scene.add.graphics();
    g.lineStyle(4, 0x6b7a99, 1); g.strokeRect(0, 0, W * CELL, H * CELL);
    g.lineStyle(2, 0x9fb4d8, 1); g.strokeRect(2, 2, W * CELL - 4, H * CELL - 4);
    g.generateTexture('bg_frame', W * CELL, H * CELL); g.destroy();

    // 各色 Puyo 圆 — 将来换 puyo_*.png
    var ids = [1, 2, 3, 4, 5, 6];
    for (i = 0; i < ids.length; i++) {
      var id = ids[i];
      var col = PALETTE[id];
      var dark = PALETTE_DARK[id];
      var key = 'puyo_' + id;
      rm(key);
      g = scene.add.graphics();
      var r = Math.floor(CELL * 0.44);
      var cx = CELL / 2, cy = CELL / 2;
      // 阴影底
      g.fillStyle(dark, 1); g.fillCircle(cx + 1, cy + 1.5, r);
      // 主体
      g.fillStyle(col, 1); g.fillCircle(cx, cy, r);
      // 连体高光——上左小圆高光（视觉占位，将来可换贴图高光层）
      g.fillStyle(0xffffff, 0.88); g.fillCircle(cx - r * 0.38, cy - r * 0.42, r * 0.28);
      g.fillStyle(0xffffff, 0.40); g.fillCircle(cx - r * 0.18, cy - r * 0.52, r * 0.12);
      // 眼睛（两只）—— 将来换眼睛贴图
      var eyeR = 3.2, eyeY = cy - 0.5;
      g.fillStyle(0xffffff, 1); g.fillCircle(cx - 6, eyeY, eyeR); g.fillCircle(cx + 6, eyeY, eyeR);
      g.fillStyle(0x222222, 1); g.fillCircle(cx - 6, eyeY + 0.8, 1.7); g.fillCircle(cx + 6, eyeY + 0.8, 1.7);
      // 下嘴线（可选）
      g.fillStyle(0x222222, 0.55); g.fillEllipse(cx, cy + 6, 4, 2);
      // 垃圾纹理额外加斜线石纹
      if (id === GARBAGE) {
        g.lineStyle(1.5, 0x444444, 0.45);
        g.lineBetween(4, 10, CELL - 4, CELL - 10);
        g.lineBetween(6, CELL - 6, CELL - 6, 6);
      }
      g.generateTexture(key, CELL, CELL); g.destroy();
    }

    // 预览用小 Puyo（半尺寸）
    for (i = 0; i < ids.length; i++) {
      var id2 = ids[i];
      var k2 = 'puyo_s_' + id2;
      rm(k2);
      g = scene.add.graphics();
      var rr = 9;
      g.fillStyle(PALETTE_DARK[id2], 1); g.fillCircle(12, 12, rr);
      g.fillStyle(PALETTE[id2], 1); g.fillCircle(11, 11, rr);
      g.fillStyle(0xffffff, 0.75); g.fillCircle(8, 8, rr * 0.28);
      g.generateTexture(k2, 24, 24); g.destroy();
    }

    // 粒子（4色小圆）—— 爆炸粒子池，将来换 particle.png
    rm('particle');
    g = scene.add.graphics();
    g.fillStyle(0xffffff, 1); g.fillCircle(3, 3, 3);
    g.generateTexture('particle', 6, 6); g.destroy();
  }

  // ==========================================================================
  // 主场景
  // ==========================================================================
  var MainScene = new Phaser.Class({
    Extends: Phaser.Scene,
    initialize: function MainScene() { Phaser.Scene.call(this, { key: 'Main' }); },

    init: function () {
      this.W = W; this.H = H; this.CELL = CELL;
      this.board = makeEmptyBoard();
      this.score = 0;
      this.chainLast = 0;
      this.phase = 'menu'; // menu | playing | resolving | paused | gameover
      this.levelIdx = 0; // 0:EASY 1:HARD（选关后）
      this.piece = null; // { x,y, ori, c1,c2 }  ori 0:上 1:右 2:下 3:左（c1为轴，c2绕轴）
      this.nextPiece = null; // { c1,c2 }
      this.ghostY = 0;
      this.dropTimer = 0;
      this.lockTimer = 0;
      this.previewGarbageRows = 0; // 预告垃圾行数（对战扩展：对方消除多时推送，此处单机按阈值自产）
      this._pendingGarbage = 0; // 本次连锁后待插入的垃圾行（结算后在下一子生成前插入）
      this._keys = null;
      this._softDrop = false;
      this._animating = false;
      this._particlePool = [];
    },

    create: function () {
      sceneRef = this;
      loadSave();
      buildTextures(this);
      this.cameras.main.setBackgroundColor('#0f1420');

      // ---- 场地背景 ----
      this.add.image(OFF_X, OFF_Y, 'bg_cell').setOrigin(0).setDisplaySize(W * CELL, H * CELL).setDepth(0);
      // 棋盘格子叠一层（用 tileSprite 复用 bg_cell）
      for (var gy = 0; gy < H; gy++) {
        for (var gx = 0; gx < W; gx++) {
          this.add.image(OFF_X + gx * CELL + CELL / 2, OFF_Y + gy * CELL + CELL / 2, 'bg_cell').setDepth(1).setAlpha(0.55);
        }
      }
      this.add.image(OFF_X, OFF_Y, 'bg_frame').setOrigin(0).setDepth(10);

      // 顶栏标题
      this.titleText = this.add.text(240, 10, 'PUYO PUYO', { fontSize: '20px', color: '#cfe0ff', fontStyle: 'bold', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5, 0).setDepth(11);
      this.subText = this.add.text(240, 30, '', { fontSize: '11px', color: '#8ea2c4' }).setOrigin(0.5, 0).setDepth(11);

      // 分数/Hi/Chain HUD
      this.hudScore = this.add.text(12, 46, '', { fontSize: '12px', color: '#ffd54f', stroke: '#000', strokeThickness: 3 }).setDepth(11);
      this.hudTop = this.add.text(12, 64, '', { fontSize: '11px', color: '#cfe0ff', stroke: '#000', strokeThickness: 3 }).setDepth(11);
      this.hudChain = this.add.text(12, 82, '', { fontSize: '11px', color: '#7af0a0', stroke: '#000', strokeThickness: 3 }).setDepth(11);

      // 右侧信息区（NEXT + 操作提示 + 垃圾预告）
      this.hudRight = this.add.text(290, 48, '', { fontSize: '11px', color: '#cfe0ff', lineSpacing: 4, stroke: '#000', strokeThickness: 3 }).setDepth(11);
      this.garbageWarn = this.add.text(290, 176, '', { fontSize: '12px', color: '#ff6b6b', stroke: '#000', strokeThickness: 3 }).setDepth(11);
      this.hudHelp = this.add.text(290, 206, '方向键 移动/旋转\n↑/X 旋转  Z 逆旋\n↓ 软降  空格 硬降\nP 暂停  R 重开', { fontSize: '10px', color: '#8ea2c4', lineSpacing: 3 }).setDepth(11);

      // NEXT 预览容器（右侧）
      this.nextIcons = [];
      for (var ni = 0; ni < 2; ni++) {
        var ico = this.add.image(316 + ni * 26, 120, 'puyo_s_1').setDepth(11).setVisible(false);
        this.nextIcons.push(ico);
      }
      this.nextLabel = this.add.text(290, 98, 'NEXT', { fontSize: '10px', color: '#9fb4d8' }).setDepth(11);

      // 场地内 Puyo 容器（board 渲染）
      this.cellSprites = [];
      for (var y = 0; y < H; y++) {
        this.cellSprites[y] = [];
        for (var x = 0; x < W; x++) { this.cellSprites[y][x] = null; }
      }

      // 活动双子精灵（2个） + 幽灵影子（2个半透明）
      this.activeSprites = [this.add.image(0, 0, 'puyo_1').setDepth(6).setVisible(false), this.add.image(0, 0, 'puyo_1').setDepth(6).setVisible(false)];
      this.ghostSprites = [this.add.image(0, 0, 'puyo_1').setDepth(3).setVisible(false).setAlpha(0.28), this.add.image(0, 0, 'puyo_1').setDepth(3).setVisible(false).setAlpha(0.28)];

      // 粒子池（对象池复用）
      for (var pi = 0; pi < 40; pi++) {
        var p = this.add.image(-100, -100, 'particle').setDepth(20).setVisible(false);
        this._particlePool.push(p);
      }

      // 连锁/得分浮字
      this.floatText = this.add.text(240, 200, '', { fontSize: '18px', color: '#fff', stroke: '#000', strokeThickness: 4, align: 'center' }).setOrigin(0.5).setDepth(30).setVisible(false);

      // 覆盖层（菜单/暂停/结束）
      this.overlay = this.add.rectangle(240, 240, 480, 480, 0x000000, 0.72).setDepth(40).setVisible(false);
      this.overlayText = this.add.text(240, 180, '', { fontSize: '14px', color: '#fff', align: 'center', lineSpacing: 6, stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(41).setVisible(false);
      this.overlayHint = this.add.text(240, 320, '', { fontSize: '11px', color: '#9fb4d8', align: 'center' }).setOrigin(0.5).setDepth(41).setVisible(false);

      // 输入
      this._keys = this.input.keyboard.addKeys({
        LEFT: Phaser.Input.Keyboard.KeyCodes.LEFT,
        RIGHT: Phaser.Input.Keyboard.KeyCodes.RIGHT,
        UP: Phaser.Input.Keyboard.KeyCodes.UP,
        DOWN: Phaser.Input.Keyboard.KeyCodes.DOWN,
        X: Phaser.Input.Keyboard.KeyCodes.X,
        Z: Phaser.Input.Keyboard.KeyCodes.Z,
        SPACE: Phaser.Input.Keyboard.KeyCodes.SPACE,
        P: Phaser.Input.Keyboard.KeyCodes.P,
        R: Phaser.Input.Keyboard.KeyCodes.R,
        ENTER: Phaser.Input.Keyboard.KeyCodes.ENTER,
        A: Phaser.Input.Keyboard.KeyCodes.A,
        D: Phaser.Input.Keyboard.KeyCodes.D,
        S: Phaser.Input.Keyboard.KeyCodes.S,
        W: Phaser.Input.Keyboard.KeyCodes.W
      });
      // 额外数字键（addKeys 不支持 ONE/TWO 别名，这里单独加）
      this._keyOne = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
      this._keyTwo = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
      this._keyNumOne = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_ONE);
      this._keyNumTwo = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.NUMPAD_TWO);
      this._keyEsc = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
      var self = this;
      this.input.keyboard.on('keydown', function (e) { if (e.code === 'Space') { e.preventDefault(); } });

      this.showMenu();
      this.updateHud();
    },

    // -----------------------------------------------------------------------
    // 菜单 / 暂停 / 结束
    // -----------------------------------------------------------------------
    showMenu: function () {
      this.phase = 'menu';
      this.board = makeEmptyBoard();
      this.score = 0; this.chainLast = 0;
      this.previewGarbageRows = 0; this._pendingGarbage = 0;
      this.clearBoardSprites();
      this.hideActive();
      Sfx.stopBgm();
      var hi = saveCache.hiScore, mc = saveCache.maxChain;
      this.overlay.setVisible(true);
      this.overlayText.setVisible(true); this.overlayHint.setVisible(true);
      this.overlayText.setText('★ PUYO PUYO ★\n\n6×12 场地  双子下落\n4连消除  坠落连锁\n\n[1] ' + LEVELS[0].name + '  (' + LEVELS[0].colors + '色  ' + (LEVELS[0].fallMs) + 'ms)\n[2] ' + LEVELS[1].name + '  (' + LEVELS[1].colors + '色  ' + (LEVELS[1].fallMs) + 'ms)');
      this.overlayHint.setText('按 1 / 2 选关开始  |  方向键也会开始(默认关1)\nHI ' + hi + '  MAX CHAIN ' + mc + '\n\n操作：←→移动  ↑/X旋转  Z逆旋  ↓软降  空格硬降');
      this.titleText.setText('PUYO PUYO');
      this.subText.setText('按 1/2 选关  |  P暂停  R重开');
      this.updateHud();
      this.drawBoard();
    },

    startLevel: function (idx) {
      this.levelIdx = idx;
      this.board = makeEmptyBoard();
      this.score = 0; this.chainLast = 0;
      this.previewGarbageRows = 0; this._pendingGarbage = 0;
      this.clearBoardSprites();
      this.phase = 'playing';
      this.overlay.setVisible(false); this.overlayText.setVisible(false); this.overlayHint.setVisible(false);
      this.spawnNext(); this.spawnPiece();
      Sfx.startBgm(this, LEVELS[idx].id);
      this.updateHud();
    },

    togglePause: function () {
      if (this.phase === 'playing' || this.phase === 'resolving') {
        this._pausedPhase = this.phase;
        this.phase = 'paused';
        this.overlay.setVisible(true); this.overlayText.setVisible(true); this.overlayHint.setVisible(true);
        this.overlayText.setText('— 暂停 —');
        this.overlayHint.setText('按 P 继续  |  R 重开  |  ESC 返回菜单');
        Sfx.stopBgm();
      } else if (this.phase === 'paused') {
        this.overlay.setVisible(false); this.overlayText.setVisible(false); this.overlayHint.setVisible(false);
        this.phase = this._pausedPhase || 'playing';
        Sfx.startBgm(this, LEVELS[this.levelIdx].id);
      }
    },

    restart: function () {
      if (this.phase === 'menu') { return; }
      Sfx.stopBgm();
      this.showMenu();
    },

    gameOver: function () {
      this.phase = 'gameover';
      this.hideActive();
      Sfx.stopBgm(); Sfx.play('gameover');
      var isNewHi = false, isNewChain = false;
      if (this.score > saveCache.hiScore) { saveCache.hiScore = this.score; isNewHi = true; }
      if (this.chainLast > saveCache.maxChain) { saveCache.maxChain = this.chainLast; isNewChain = true; }
      if (isNewHi || isNewChain) { persistSave(); }
      this.overlay.setVisible(true); this.overlayText.setVisible(true); this.overlayHint.setVisible(true);
      var extra = '';
      if (isNewHi) { extra += '  ★ 新纪录!'; }
      if (isNewChain) { extra += '  ★ 新连锁!'; }
      this.overlayText.setText('GAME OVER\n\n得分 ' + this.score + '  连锁 ' + this.chainLast + extra + '\nHI ' + saveCache.hiScore + '  MAX CHAIN ' + saveCache.maxChain);
      this.overlayHint.setText('按 R 返回菜单  |  1/2 直接重开本关');
      this.updateHud();
    },

    // -----------------------------------------------------------------------
    // HUD
    // -----------------------------------------------------------------------
    updateHud: function () {
      var lvl = LEVELS[this.levelIdx] || LEVELS[0];
      this.hudScore.setText('SCORE  ' + this.score);
      this.hudTop.setText('HI ' + saveCache.hiScore + '   CHAIN ' + this.chainLast + '   MAX ' + saveCache.maxChain);
      this.hudChain.setText('Lv ' + lvl.name + '  预告垃圾 ' + this.previewGarbageRows + '行');
      // 右侧 NEXT 与模式提示
      var modeStr = this.phase === 'menu' ? '选关 1/2 开始' : (this.phase === 'paused' ? '暂停中' : (this.phase === 'gameover' ? '结束' : lvl.title + '  ' + lvl.colors + '色'));
      this.hudRight.setText('模式: ' + modeStr + '\n下落 ' + lvl.fallMs + 'ms\n\nNEXT:');
      if (this.nextPiece) {
        this.nextIcons[0].setTexture('puyo_s_' + this.nextPiece.c1).setVisible(true);
        this.nextIcons[1].setTexture('puyo_s_' + this.nextPiece.c2).setVisible(true);
        // 将来换：NEXT 用 generateTexture 的 puyo_s_* 已预留替换点，直接换贴图即可
      } else {
        this.nextIcons[0].setVisible(false); this.nextIcons[1].setVisible(false);
      }
      this.garbageWarn.setText(this.previewGarbageRows > 0 ? '▲ 垃圾预告 ' + this.previewGarbageRows + ' 行' : '');
      this.garbageWarn.setVisible(this.previewGarbageRows > 0);
      this.subText.setText(this.phase === 'playing' ? (lvl.name + '  分数 ' + this.score) : this.subText.text);
    },

    // -----------------------------------------------------------------------
    // Board 渲染
    // -----------------------------------------------------------------------
    clearBoardSprites: function () {
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          if (this.cellSprites[y][x]) { try { this.cellSprites[y][x].destroy(); } catch (e) {} this.cellSprites[y][x] = null; }
        }
      }
    },
    drawBoard: function () {
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var v = this.board[y][x];
          if (this.cellSprites[y][x]) { try { this.cellSprites[y][x].destroy(); } catch (e) {} this.cellSprites[y][x] = null; }
          if (v !== 0) {
            var px = OFF_X + x * CELL + CELL / 2;
            var py = OFF_Y + y * CELL + CELL / 2;
            var sp = this.add.image(px, py, 'puyo_' + v).setDepth(5);
            this.cellSprites[y][x] = sp;
          }
        }
      }
    },
    /** 仅重绘有变化的格，做简单全量重绘（12x6 很小，无性能问题，将来可改差异重绘） */
    refreshBoardSprites: function () { this.drawBoard(); },

    hideActive: function () {
      this.activeSprites[0].setVisible(false); this.activeSprites[1].setVisible(false);
      this.ghostSprites[0].setVisible(false); this.ghostSprites[1].setVisible(false);
    },

    // -----------------------------------------------------------------------
    // 双子 Puyo 逻辑
    // -----------------------------------------------------------------------
    spawnNext: function () {
      var cc = LEVELS[this.levelIdx].colors;
      this.nextPiece = { c1: randomColor(cc), c2: randomColor(cc) };
    },
    spawnPiece: function () {
      // 先插入待结算的垃圾行（单机简化版：每当 chain>=2 时预告，下一次出子前插入）
      if (this._pendingGarbage > 0) {
        for (var gi = 0; gi < this._pendingGarbage; gi++) {
          var overflow = pushGarbageRow(this.board);
          if (overflow) { this.refreshBoardSprites(); this.gameOver(); return; }
          Sfx.play('garbage');
        }
        this._pendingGarbage = 0;
        this.previewGarbageRows = 0;
        this.refreshBoardSprites();
        this.updateHud();
      }
      if (!this.nextPiece) { this.spawnNext(); }
      var c1 = this.nextPiece.c1, c2 = this.nextPiece.c2;
      this.spawnNext();
      // 生成位置：x=2,y=0 轴，另一块在上方(ori=0)
      this.piece = { x: 2, y: 0, ori: 0, c1: c1, c2: c2 };
      this.dropTimer = 0; this.lockTimer = 0;
      // 若生成即重叠顶则 GameOver
      if (this.collides(this.piece.x, this.piece.y, this.piece.ori)) {
        this.refreshBoardSprites(); this.gameOver(); return;
      }
      this.updateActiveSprites();
      this.updateHud();
    },

    /** 计算双子两块的格坐标 */
    pieceCells: function (x, y, ori) {
      var ax = x, ay = y;
      var bx = x, by = y;
      if (ori === 0) { by = y - 1; } // 上
      else if (ori === 1) { bx = x + 1; } // 右
      else if (ori === 2) { by = y + 1; } // 下
      else { bx = x - 1; } // 左
      return [{ x: ax, y: ay }, { x: bx, y: by }];
    },

    collides: function (x, y, ori) {
      var cells = this.pieceCells(x, y, ori);
      for (var i = 0; i < 2; i++) {
        var cx = cells[i].x, cy = cells[i].y;
        if (cx < 0 || cx >= W) { return true; }
        if (cy >= H) { return true; }
        if (cy >= 0 && this.board[cy][cx] !== 0) { return true; }
        // cy<0 允许（顶部生成区）
      }
      return false;
    },

    /** 尝试平移 */
    tryMove: function (dx) {
      if (!this.piece || this.phase !== 'playing' || this._animating) { return false; }
      var nx = this.piece.x + dx;
      if (!this.collides(nx, this.piece.y, this.piece.ori)) {
        this.piece.x = nx;
        this.lockTimer = 0;
        this.updateActiveSprites(); Sfx.play('move');
        return true;
      }
      return false;
    },

    /** 旋转（dir 1 顺时针, -1 逆时针），带简易踢墙 */
    tryRotate: function (dir) {
      if (!this.piece || this.phase !== 'playing' || this._animating) { return false; }
      var ori2 = (this.piece.ori + dir + 4) % 4;
      // 先原地试
      if (!this.collides(this.piece.x, this.piece.y, ori2)) {
        this.piece.ori = ori2; this.lockTimer = 0; this.updateActiveSprites(); Sfx.play('rotate'); return true;
      }
      // 踢墙：左右各试1格
      var kicks = [1, -1];
      for (var k = 0; k < kicks.length; k++) {
        var kx = this.piece.x + kicks[k];
        if (!this.collides(kx, this.piece.y, ori2)) {
          this.piece.x = kx; this.piece.ori = ori2; this.lockTimer = 0; this.updateActiveSprites(); Sfx.play('rotate'); return true;
        }
      }
      // 特殊：贴地踢
      if (!this.collides(this.piece.x, this.piece.y - 1, ori2)) {
        this.piece.y -= 1; this.piece.ori = ori2; this.lockTimer = 0; this.updateActiveSprites(); Sfx.play('rotate'); return true;
      }
      return false;
    },

    /** 计算幽灵落地 y（硬降预览） */
    computeGhostY: function () {
      if (!this.piece) { return 0; }
      var gy = this.piece.y;
      while (!this.collides(this.piece.x, gy + 1, this.piece.ori)) { gy++; }
      return gy;
    },

    updateActiveSprites: function () {
      if (!this.piece) { this.hideActive(); return; }
      var cells = this.pieceCells(this.piece.x, this.piece.y, this.piece.ori);
      var gy = this.computeGhostY();
      var ghostCells = this.pieceCells(this.piece.x, gy, this.piece.ori);
      var colors = [this.piece.c1, this.piece.c2];
      for (var i = 0; i < 2; i++) {
        var ax = OFF_X + cells[i].x * CELL + CELL / 2;
        var ay = OFF_Y + cells[i].y * CELL + CELL / 2;
        this.activeSprites[i].setTexture('puyo_' + colors[i]).setPosition(ax, ay).setVisible(cells[i].y >= 0);
        var gax = OFF_X + ghostCells[i].x * CELL + CELL / 2;
        var gay = OFF_Y + ghostCells[i].y * CELL + CELL / 2;
        this.ghostSprites[i].setTexture('puyo_' + colors[i]).setPosition(gax, gay).setVisible(true).setAlpha(0.22);
      }
    },

    /** 锁定当前双子到 board */
    lockPiece: function () {
      if (!this.piece) { return; }
      var cells = this.pieceCells(this.piece.x, this.piece.y, this.piece.ori);
      var cols = [this.piece.c1, this.piece.c2];
      for (var i = 0; i < 2; i++) {
        var cx = cells[i].x, cy = cells[i].y;
        if (cy >= 0 && cy < H && cx >= 0 && cx < W) { this.board[cy][cx] = cols[i]; }
      }
      this.piece = null;
      this.hideActive();
      this.refreshBoardSprites();
      Sfx.play('lock');
      // 顶溢检测（顶行有块即结束取决规则；这里用“锁定后顶行被占且无法生成下一子”在 spawnPiece 中判，此处若顶行已满也直接结束）
      // 若本次锁定导致顶行满则不立即结束，待连锁后仍满则下一子生成时结束，更符合 Puyo 规则
      this.startResolve();
    },

    hardDrop: function () {
      if (!this.piece || this.phase !== 'playing' || this._animating) { return; }
      var gy = this.computeGhostY();
      this.piece.y = gy;
      this.updateActiveSprites();
      this.lockPiece();
    },

    // -----------------------------------------------------------------------
    // 连锁结算（异步动画版）
    // -----------------------------------------------------------------------
    startResolve: function () {
      this.phase = 'resolving';
      this._animating = true;
      var self = this;
      // 使用逻辑 resolveChains 预计算步数，再逐步动画
      var simBoard = cloneBoard(this.board);
      var result = resolveChains(simBoard);
      if (result.chain === 0) {
        // 无消除，直接出下一子
        this._animating = false;
        this.phase = 'playing';
        this.spawnPiece();
        return;
      }
      // 按步动画：每步 消除→计分→重力 tween
      var chain = 0;
      var stepIdx = 0;
      var steps = result.steps; // [{chain, groups, cells, scoreInfo}]
      // 为了动画，需要回放：从当前 board 起逐次应用
      function doStep() {
        if (stepIdx >= steps.length) {
          // 结算结束：更新分数/连锁/存档/垃圾预告
          self.chainLast = result.chain;
          self.score += result.score;
          if (self.score > saveCache.hiScore) { saveCache.hiScore = self.score; persistSave(); }
          if (self.chainLast > saveCache.maxChain) { saveCache.maxChain = self.chainLast; persistSave(); }
          // 对战简化版：连锁越高，垃圾越多 — 预告并在下一子前插入
          // 单机自产垃圾：chain>=2 时预告 chain-1 行，上限 3 行（对战扩展：此处改为向对手发送）
          // 注释说明对战扩展见文件头与本段注释
          if (result.chain >= 2) {
            var garbageRows = Math.min(3, result.chain - 1);
            // 单机：预告在自己场（演示用）；对战版应改为：对手.board.pushGarbageRow(...)
            // 将来对战扩展：host.sendGarbage(garbageRows) 或通过 WebSocket 推送给对手
            self.previewGarbageRows = garbageRows;
            self._pendingGarbage = garbageRows;
          }
          self.updateHud();
          // 轻微延迟后出下一子
          self.time.delayedCall(220, function () {
            self._animating = false;
            self.phase = 'playing';
            self.spawnPiece();
          });
          return;
        }
        var step = steps[stepIdx];
        chain = step.chain;
        // 1) 高亮并粒子
        var cells = step.cells;
        for (var ci = 0; ci < cells.length; ci++) {
          var sp = self.cellSprites[cells[ci].y][cells[ci].x];
          if (sp) { self.burstParticles(sp.x, sp.y, PALETTE[self.board[cells[ci].y][cells[ci].x]] || 0xffffff); }
        }
        // 2) 消除动画：缩放消失
        for (var cj = 0; cj < cells.length; cj++) {
          var sp2 = self.cellSprites[cells[cj].y][cells[cj].x];
          if (sp2) { self.tweens.add({ targets: sp2, scaleX: 0, scaleY: 0, alpha: 0, duration: POP_MS, ease: 'Back.easeIn' }); }
        }
        if (chain === 1) { Sfx.play('pop'); } else { Sfx.play('chain'); }
        // 浮字
        var si = step.scoreInfo;
        self.showFloat(chain, si);

        self.time.delayedCall(POP_MS + 40, function () {
          // 真正从 board 抹掉并重力
          eraseCells(self.board, cells);
          applyGravity(self.board);
          // 刷新精灵：销毁旧的，重新生成并做下落 tween（池化：复用/新建 image）
          // 记录旧精灵位置用于 tween 起点
          var oldSprites = [];
          for (var y2 = 0; y2 < H; y2++) { for (var x2 = 0; x2 < W; x2++) { if (self.cellSprites[y2][x2]) { oldSprites.push(self.cellSprites[y2][x2]); } } }
          // 全清后重建，初位置设为上方偏移再 tween 下来（坠落tween，视觉落地感）
          for (var y3 = 0; y3 < H; y3++) { for (var x3 = 0; x3 < W; x3++) { if (self.cellSprites[y3][x3]) { try { self.cellSprites[y3][x3].destroy(); } catch (e) {} self.cellSprites[y3][x3] = null; } } }
          for (var yy = 0; yy < H; yy++) {
            for (var xx = 0; xx < W; xx++) {
              var v = self.board[yy][xx];
              if (v !== 0) {
                var px2 = OFF_X + xx * CELL + CELL / 2;
                var py2 = OFF_Y + yy * CELL + CELL / 2;
                var spr = self.add.image(px2, py2 - 10, 'puyo_' + v).setDepth(5);
                spr.setAlpha(0.9);
                self.cellSprites[yy][xx] = spr;
                self.tweens.add({ targets: spr, y: py2, alpha: 1, duration: FALL_MS, ease: 'Bounce.easeOut' });
              }
            }
          }
          self.score += si.score;
          self.chainLast = chain;
          self.updateHud();
          stepIdx++;
          self.time.delayedCall(FALL_MS + 50, doStep);
        });
      }
      doStep();
    },

    burstParticles: function (x, y, tint) {
      for (var i = 0; i < 6; i++) {
        var p = null;
        for (var k = 0; k < this._particlePool.length; k++) {
          if (!this._particlePool[k].visible) { p = this._particlePool[k]; break; }
        }
        if (!p) { p = this.add.image(x, y, 'particle').setDepth(20); this._particlePool.push(p); }
        p.setPosition(x, y).setVisible(true).setAlpha(1).setScale(1).setTint(tint);
        var ang = Math.random() * Math.PI * 2;
        var dist = 16 + Math.random() * 22;
        var tx = x + Math.cos(ang) * dist;
        var ty = y + Math.sin(ang) * dist;
        this.tweens.add({ targets: p, x: tx, y: ty, alpha: 0, scale: 0.2, duration: 360 + Math.random() * 140, ease: 'Cubic.easeOut', onComplete: (function (pp) { return function () { pp.setVisible(false); }; })(p) });
      }
    },

    showFloat: function (chain, si) {
      var t = chain === 1 ? ('POP +' + si.score) : ('CHAIN ' + chain + ' +' + si.score + '  (bonus x' + si.bonus + ')');
      this.floatText.setText(t).setVisible(true).setAlpha(1).setY(120);
      this.tweens.add({ targets: this.floatText, y: 86, alpha: 0, duration: 700, ease: 'Cubic.easeOut', onComplete: (function (self) { return function () { self.floatText.setVisible(false); }; })(this) });
    },

    // -----------------------------------------------------------------------
    // 输入 + 主循环
    // -----------------------------------------------------------------------
    update: function (time, delta) {
      if (this.phase === 'menu') {
        if (Phaser.Input.Keyboard.JustDown(this._keyOne) || Phaser.Input.Keyboard.JustDown(this._keyNumOne)) { this.startLevel(0); return; }
        if (Phaser.Input.Keyboard.JustDown(this._keyTwo) || Phaser.Input.Keyboard.JustDown(this._keyNumTwo)) { this.startLevel(1); return; }
        if (Phaser.Input.Keyboard.JustDown(this._keys.ENTER) || Phaser.Input.Keyboard.JustDown(this._keys.SPACE)) { this.startLevel(0); return; }
        // 方向键也进关1（方便手柄/方向键用户）
        if (Phaser.Input.Keyboard.JustDown(this._keys.LEFT) || Phaser.Input.Keyboard.JustDown(this._keys.RIGHT) ||
            Phaser.Input.Keyboard.JustDown(this._keys.UP) || Phaser.Input.Keyboard.JustDown(this._keys.DOWN)) { this.startLevel(0); return; }
        return;
      }
      if (this.phase === 'paused') {
        if (Phaser.Input.Keyboard.JustDown(this._keys.P)) { this.togglePause(); return; }
        if (Phaser.Input.Keyboard.JustDown(this._keys.ENTER) || Phaser.Input.Keyboard.JustDown(this._keys.SPACE)) { this.togglePause(); return; }
        if (Phaser.Input.Keyboard.JustDown(this._keyEsc) || Phaser.Input.Keyboard.JustDown(this._keys.R)) {
          this.overlay.setVisible(false); this.overlayText.setVisible(false); this.overlayHint.setVisible(false);
          Sfx.stopBgm(); this.showMenu(); return;
        }
        return;
      }
      if (this.phase === 'gameover') {
        if (Phaser.Input.Keyboard.JustDown(this._keyOne) || Phaser.Input.Keyboard.JustDown(this._keyNumOne)) { this.startLevel(0); return; }
        if (Phaser.Input.Keyboard.JustDown(this._keyTwo) || Phaser.Input.Keyboard.JustDown(this._keyNumTwo)) { this.startLevel(1); return; }
        if (Phaser.Input.Keyboard.JustDown(this._keys.R) || Phaser.Input.Keyboard.JustDown(this._keyEsc) ||
            Phaser.Input.Keyboard.JustDown(this._keys.ENTER) || Phaser.Input.Keyboard.JustDown(this._keys.SPACE)) {
          Sfx.stopBgm(); this.showMenu(); return;
        }
        return;
      }
      // 全局：P 暂停 / R 重开（playing/resolving 均可）
      if (Phaser.Input.Keyboard.JustDown(this._keys.P)) { this.togglePause(); return; }
      if (Phaser.Input.Keyboard.JustDown(this._keys.R)) { Sfx.stopBgm(); this.showMenu(); return; }
      if (this.phase !== 'playing') { return; }
      if (!this.piece) { return; }

      // 活动块输入（JustDown 单次）
      if (Phaser.Input.Keyboard.JustDown(this._keys.LEFT) || Phaser.Input.Keyboard.JustDown(this._keys.A)) { this.tryMove(-1); }
      if (Phaser.Input.Keyboard.JustDown(this._keys.RIGHT) || Phaser.Input.Keyboard.JustDown(this._keys.D)) { this.tryMove(1); }
      if (Phaser.Input.Keyboard.JustDown(this._keys.UP) || Phaser.Input.Keyboard.JustDown(this._keys.X) || Phaser.Input.Keyboard.JustDown(this._keys.W)) { this.tryRotate(1); }
      if (Phaser.Input.Keyboard.JustDown(this._keys.Z)) { this.tryRotate(-1); }
      if (Phaser.Input.Keyboard.JustDown(this._keys.SPACE)) { this.hardDrop(); return; }

      // 软降（按住↓加速）
      var softHeld = this._keys.DOWN.isDown || this._keys.S.isDown;
      var fallMs = softHeld ? SOFT_DROP_MS : LEVELS[this.levelIdx].fallMs;

      // 自动下落
      this.dropTimer += delta;
      if (this.dropTimer >= fallMs) {
        this.dropTimer = 0;
        if (!this.collides(this.piece.x, this.piece.y + 1, this.piece.ori)) {
          this.piece.y += 1;
          this.lockTimer = 0;
          this.updateActiveSprites();
        }
        // 触底时不在此累 lockTimer，下方统一按 delta 累加更精确
      }
      // 触底锁定倒计时（触底才计，期间可横移/旋转重置）
      var onGround = this.collides(this.piece.x, this.piece.y + 1, this.piece.ori);
      if (onGround) {
        this.lockTimer += delta;
        if (this.lockTimer >= LOCK_DELAY) { this.lockPiece(); }
      } else {
        this.lockTimer = 0;
      }
      // 持续刷新幽灵
      if (!this._animating) { this.updateActiveSprites(); }
    }
  });

  // ==========================================================================
  // 暴露纯逻辑给测试（node --check 校验用）
  // ==========================================================================
  var PureLogic = {
    W: W, H: H, GARBAGE: GARBAGE,
    makeEmptyBoard: makeEmptyBoard,
    cloneBoard: cloneBoard,
    findGroups: findGroups,
    eraseCells: eraseCells,
    applyGravity: applyGravity,
    scoreForPop: scoreForPop,
    pushGarbageRow: pushGarbageRow,
    resolveChains: resolveChains
  };

  // ==========================================================================
  // 注册（id 必须 == 目录名 puzzle-puyo）
  // ==========================================================================
  var hostW = 480, hostH = 480;
  window.TRGames = window.TRGames || { register: function(){}, _r:{} };
  window.TRGames.register({
    id: 'puzzle-puyo',
    title: 'Puzzle PuyoPuyo',
    launch: function (host) {
      hostRef = host;
      var Wpx = host.width || hostW;
      var Hpx = host.height || hostH;
      if (host.loadState) {
        try {
          host.loadState().then(function (d) {
            if (d && typeof d === 'object') {
              if (typeof d.hiScore === 'number') { saveCache.hiScore = Math.max(saveCache.hiScore, d.hiScore); }
              if (typeof d.maxChain === 'number') { saveCache.maxChain = Math.max(saveCache.maxChain, d.maxChain); }
              if (sceneRef) { sceneRef.updateHud(); }
            }
          }, function(){});
        } catch (e) {}
      }
      var game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host.container,
        width: Wpx,
        height: Hpx,
        backgroundColor: '#0f1420',
        physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
        scene: [MainScene]
      });
      sceneRef = null;
      var tryBind = function(){ try{ var s=game.scene.getScene('Main'); if(s) sceneRef=s; }catch(e){} };
      setTimeout(tryBind, 400);
      game.events.on('ready', tryBind);
      window.__trgame = { game: game, getState: getState, PureLogic: PureLogic, getSave: function(){ return { hiScore: saveCache.hiScore, maxChain: saveCache.maxChain }; } };
      return game;
    }
  });

  // Node 环境暴露（node --check / 单测）
  if (typeof module !== 'undefined' && module.exports) { module.exports = PureLogic; }
})();
