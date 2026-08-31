// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改：
//   视觉：
//     buildTextures(scene) 内所有 this.add.graphics()+generateTexture('...')
//       → 换成 this.load.image('tile_soil','assets/tile_soil.png') 等
//       纹理名：tile_empty/tile_tilled/tile_watered/
//               crop_turnip_s0..s2 / crop_potato_s0..s2 / crop_tomato_s0..s2 / crop_wilted / egg_icon
//               chicken_idle / shop_panel / btn_tool_hoe 等
//       每段生成处均有「将来换」中文注释；纯几何占位可无缝换位图/sheet。
//     家畜 现用几何圆+三角 → 换成 spritesheet 序列帧
//       this.load.spritesheet('chicken','assets/chicken.png',{frameWidth:32,frameHeight:32})
//     季节点缀（春樱粉/夏麦黄）现为 tint 数值 → 换成不同季节背景图
//       this.load.image('bg_spring','assets/bg_spring.png')
//   音频：
//     Sfx.play('hoe'/'sow'/'water'/'harvest'/'buy'/'sell'/'sleep'/'noStamina'/'bgm')
//       内部 WebAudio oscillator → 换成 this.load.audio('hoe','assets/hoe.wav')+this.sound.play
//       顶部 Sfx 块已写替换写法；BGM 季区分现用不同和弦进行，将来换不同 ogg。
//   扩展：
//     作物/商店表 CROPS/SHOP_ITEMS 现为内存常量 → 将来可改为外部 JSON 关卡表
//     存档 key 见 SAVE_KEY；季节目标 见 SEASONS[].targetGold
// =============================================================================
(function () {
  'use strict';

  // ==========================================================================
  // 常量
  // ==========================================================================
  /** 网格列数 */
  var COLS = 6;
  /** 网格行数 */
  var ROWS = 8;
  /** 田格边长 px */
  var CELL = 42;
  /** 田地左上偏移 */
  var FIELD_X = 18;
  var FIELD_Y = 58;
  /** 网格总数 */
  var TOTAL = COLS * ROWS;

  /** 工具枚举 */
  var TOOL_HOE = 0, TOOL_SOW = 1, TOOL_WATER = 2, TOOL_HARVEST = 3;

  /** 作物表：至少3种，生长期 3/4/5 天不同，售价不同，季节限定
   *  将来换：可改为外部 JSON
   */
  var CROPS = [
    { id: 'turnip', name: '芜菁',   season: 0,        growDays: 3, seedPrice: 12, sellPrice: 45, color: 0x7ec97a, colorDark: 0x3a8a3a, matureColor: 0x2e7d32 },
    { id: 'potato', name: '土豆',   season: 0,        growDays: 4, seedPrice: 18, sellPrice: 75, color: 0xd8c06a, colorDark: 0x8d7a2b, matureColor: 0xc9a82a },
    { id: 'tomato', name: '番茄',   season: 1,        growDays: 5, seedPrice: 28, sellPrice: 120, color: 0xff6b6b, colorDark: 0x8a2a2a, matureColor: 0xd63031 }
  ];
  // 兼容：跨季作物（土豆夏也可种，体现季节区分但不卡死）
  var CROP_SEASON_ALLOW = { turnip: [0], potato: [0, 1], tomato: [1] };

  /** 季节定义：至少2章节/季节，配色与作物区分，各有目标分数
   *  将来换：外部 JSON
   */
  var SEASONS = [
    { id: 0, name: '春', en: 'SPRING', days: 10, targetGold: 400, bg: 0x8ecae6, fieldTint: 0x7fa67a, bGbmRoot: 261.63 },
    { id: 1, name: '夏', en: 'SUMMER', days: 10, targetGold: 700, bg: 0xf5d76e, fieldTint: 0xb89a3a, bGbmRoot: 329.63 }
  ];

  /** 体力 */
  var MAX_STAMINA = 24;
  var COST_HOE = 2, COST_SOW = 1, COST_WATER = 1, COST_HARVEST = 1, COST_FEED = 1;

  /** 鸡舍 */
  var EGG_PRICE = 40;
  var FEED_PRICE = 6;

  /** 存档 */
  var SAVE_KEY = 'farm_story_save';
  var hostRef = null;
  var sceneRef = null;
  var saveCache = { day: 1, gold: 120, bestHarvest: 0 };

  // ==========================================================================
  // 存档 / getState
  // ==========================================================================
  function loadSave() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (typeof d.day === 'number') { saveCache.day = d.day; }
        if (typeof d.gold === 'number') { saveCache.gold = d.gold; }
        if (typeof d.bestHarvest === 'number') { saveCache.bestHarvest = d.bestHarvest; }
      }
    } catch (e) {}
    if (hostRef && hostRef.loadState) {
      try {
        hostRef.loadState().then(function (d) {
          if (d && typeof d === 'object') {
            if (typeof d.day === 'number') { saveCache.day = Math.max(saveCache.day, d.day); }
            if (typeof d.gold === 'number') { saveCache.gold = Math.max(saveCache.gold, d.gold); }
            if (typeof d.bestHarvest === 'number') { saveCache.bestHarvest = Math.max(saveCache.bestHarvest, d.bestHarvest); }
          }
        }, function () {});
      } catch (e2) {}
    }
  }
  function persistSave() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(saveCache)); } catch (e) {}
    if (hostRef && hostRef.saveState) {
      try { hostRef.saveState({ day: saveCache.day, gold: saveCache.gold, bestHarvest: saveCache.bestHarvest }); } catch (e2) {}
    }
  }
  /** Acceptance 要求：getState {scene, day, gold, crops[], season} */
  function getState() {
    if (!sceneRef) {
      return { scene: 'loading', day: saveCache.day, gold: saveCache.gold, crops: [], season: SEASONS[0].name };
    }
    var crops = [];
    for (var i = 0; i < sceneRef.grid.length; i++) {
      var c = sceneRef.grid[i];
      if (c.crop) {
        crops.push({ idx: i, id: c.crop.typeId, stage: c.crop.stage, daysGrown: c.crop.daysGrown, watered: !!c.crop.wateredToday, wilted: !!c.crop.wilted });
      }
    }
    return {
      scene: sceneRef.phase || 'play',
      day: sceneRef.day,
      gold: sceneRef.gold,
      crops: crops,
      season: SEASONS[sceneRef.seasonIdx].name
    };
  }

  // ==========================================================================
  // Sfx — WebAudio，注释写将来换 this.load.audio
  // 将来换：preload(){ this.load.audio('hoe','assets/hoe.wav'); } play(){ this.sound.play(name); }
  // ==========================================================================
  var Sfx = {
    ctx: null,
    _ensure: function () {
      if (this.ctx) { return; }
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { this.ctx = new AC(); }
      } catch (e) {}
    },
    tone: function (freq, dur, type, gain, slide) {
      this._ensure();
      if (!this.ctx) { return; }
      try {
        var o = this.ctx.createOscillator();
        var g = this.ctx.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        if (slide) {
          o.frequency.linearRampToValueAtTime(slide, this.ctx.currentTime + dur);
        }
        g.gain.value = gain || 0.18;
        g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
        o.connect(g); g.connect(this.ctx.destination);
        o.start(); o.stop(this.ctx.currentTime + dur);
      } catch (e) {}
    },
    play: function (name) {
      if (name === 'hoe') { this.tone(180, 0.12, 'square', 0.22); }
      else if (name === 'sow') { this.tone(520, 0.14, 'sine', 0.16); this.tone(780, 0.14, 'sine', 0.08); }
      else if (name === 'water') { this.tone(900, 0.18, 'sine', 0.12, 600); }
      else if (name === 'harvest') { this.tone(660, 0.12, 'sine', 0.18); setTimeout(function () { Sfx.tone(880, 0.18, 'sine', 0.16); }, 90); }
      else if (name === 'buy') { this.tone(740, 0.10, 'sine', 0.16); }
      else if (name === 'sell') { this.tone(520, 0.10, 'triangle', 0.16); setTimeout(function () { Sfx.tone(660, 0.14, 'triangle', 0.14); }, 80); }
      else if (name === 'sleep') { this.tone(330, 0.5, 'sine', 0.14, 260); }
      else if (name === 'noStamina') { this.tone(140, 0.28, 'sawtooth', 0.18); }
      else if (name === 'egg') { this.tone(700, 0.10, 'sine', 0.15); }
      else if (name === 'feed') { this.tone(400, 0.12, 'triangle', 0.14); }
    },
    bgmTimer: null,
    playBgm: function (seasonIdx) {
      this.stopBgm();
      var root = SEASONS[seasonIdx].bGbmRoot;
      var seq = seasonIdx === 0 ? [0, 4, 7, 4] : [0, 3, 7, 10];
      var idx = 0;
      var self = this;
      // 将来换：this.sound.play('bgm_spring', {loop:true})
      self.bgmTimer = setInterval(function () {
        var semi = seq[idx % seq.length];
        var f = root * Math.pow(2, semi / 12);
        self.tone(f, 0.32, 'sine', 0.06);
        idx++;
      }, 460);
    },
    stopBgm: function () {
      if (this.bgmTimer) { clearInterval(this.bgmTimer); this.bgmTimer = null; }
    }
  };

  // ==========================================================================
  // 工具函数
  // ==========================================================================
  function cropById(id) {
    for (var i = 0; i < CROPS.length; i++) { if (CROPS[i].id === id) { return CROPS[i]; } }
    return null;
  }
  function seasonAllows(cropId, seasonIdx) {
    var arr = CROP_SEASON_ALLOW[cropId];
    if (!arr) { return false; }
    for (var i = 0; i < arr.length; i++) { if (arr[i] === seasonIdx) { return true; } }
    return false;
  }
  function seasonOfDay(day) {
    var d = day;
    for (var i = 0; i < SEASONS.length; i++) {
      if (d <= SEASONS[i].days) { return i; }
      d -= SEASONS[i].days;
    }
    return SEASONS.length - 1;
  }
  function dayInSeason(day) {
    var d = day;
    for (var i = 0; i < SEASONS.length; i++) {
      if (d <= SEASONS[i].days) { return d; }
      d -= SEASONS[i].days;
    }
    return SEASONS[SEASONS.length - 1].days;
  }

  // ==========================================================================
  // Texture 生成（纯几何）
  // ==========================================================================
  function buildTextures(scene) {
    var g;
    function rm(k) { if (scene.textures.exists(k)) { scene.textures.remove(k); } }

    // ——— 将来换：this.load.image('tile_empty','assets/tile_empty.png')
    rm('tile_empty');
    g = scene.add.graphics();
    g.fillStyle(0x6b4a2b, 1); g.fillRect(0, 0, CELL, CELL);
    g.lineStyle(1, 0x4a321d, 0.9); g.strokeRect(0, 0, CELL, CELL);
    // 细纹理点
    g.fillStyle(0x7a5530, 0.5);
    g.fillCircle(10, 10, 1.2); g.fillCircle(28, 14, 1); g.fillCircle(20, 30, 1.4);
    g.generateTexture('tile_empty', CELL, CELL); g.destroy();

    // 将来换：tile_tilled
    rm('tile_tilled');
    g = scene.add.graphics();
    g.fillStyle(0x4a321d, 1); g.fillRect(0, 0, CELL, CELL);
    g.fillStyle(0x5a3d22, 1);
    // 锄痕：三道横沟
    for (var i = 0; i < 3; i++) {
      g.fillRect(4, 10 + i * 9, CELL - 8, 3);
      g.fillStyle(0x3e2a14, 1); g.fillRect(4, 12 + i * 9, CELL - 8, 1); g.fillStyle(0x5a3d22, 1);
    }
    g.lineStyle(1, 0x2e1e10, 0.8); g.strokeRect(0, 0, CELL, CELL);
    g.generateTexture('tile_tilled', CELL, CELL); g.destroy();

    // 将来换：tile_watered（深色+水光）
    rm('tile_watered');
    g = scene.add.graphics();
    g.fillStyle(0x2e1e10, 1); g.fillRect(0, 0, CELL, CELL);
    g.fillStyle(0x3e2f1a, 1);
    for (var j = 0; j < 3; j++) { g.fillRect(4, 10 + j * 9, CELL - 8, 3); }
    g.fillStyle(0x4a90a8, 0.55); g.fillRect(6, 34, CELL - 12, 4);
    g.lineStyle(1, 0x1a1208, 0.9); g.strokeRect(0, 0, CELL, CELL);
    g.generateTexture('tile_watered', CELL, CELL); g.destroy();

    // 枯萎 将来换
    rm('crop_wilted');
    g = scene.add.graphics();
    g.fillStyle(0x5a4a2a, 1); g.fillRect(0, 0, CELL, CELL);
    g.lineStyle(2, 0x8a6a1a, 1); g.lineBetween(10, 30, 32, 12); g.lineBetween(32, 30, 10, 12);
    g.generateTexture('crop_wilted', CELL, CELL); g.destroy();

    // 作物三阶段：将 biology 用几何高度区分
    // 将来换：crop_turnip_s0/s1/s2 换位图
    for (var ci = 0; ci < CROPS.length; ci++) {
      var cr = CROPS[ci];
      // stage0 苗
      rm('crop_' + cr.id + '_s0');
      g = scene.add.graphics();
      // 保留锄痕底
      g.fillStyle(0x4a321d, 1); g.fillRect(0, 0, CELL, CELL);
      for (var k2 = 0; k2 < 3; k2++) { g.fillStyle(0x5a3d22, 1); g.fillRect(4, 10 + k2 * 9, CELL - 8, 3); }
      // 小苗两叶
      g.fillStyle(cr.color, 1);
      g.fillEllipse(16, 26, 6, 10); g.fillEllipse(26, 26, 6, 10);
      g.fillStyle(cr.colorDark, 1); g.fillCircle(21, 24, 2);
      g.generateTexture('crop_' + cr.id + '_s0', CELL, CELL); g.destroy();
      // stage1 生长中
      rm('crop_' + cr.id + '_s1');
      g = scene.add.graphics();
      g.fillStyle(0x4a321d, 1); g.fillRect(0, 0, CELL, CELL);
      for (var k3 = 0; k3 < 3; k3++) { g.fillStyle(0x5a3d22, 1); g.fillRect(4, 10 + k3 * 9, CELL - 8, 3); }
      g.fillStyle(cr.color, 1);
      g.fillEllipse(21, 22, 18, 20);
      g.fillStyle(0xffffff, 0.25); g.fillEllipse(17, 18, 5, 7);
      g.generateTexture('crop_' + cr.id + '_s1', CELL, CELL); g.destroy();
      // stage2 成熟
      rm('crop_' + cr.id + '_s2');
      g = scene.add.graphics();
      g.fillStyle(0x4a321d, 1); g.fillRect(0, 0, CELL, CELL);
      for (var k4 = 0; k4 < 3; k4++) { g.fillStyle(0x5a3d22, 1); g.fillRect(4, 10 + k4 * 9, CELL - 8, 3); }
      g.fillStyle(cr.matureColor, 1);
      g.fillCircle(21, 20, 13);
      g.fillStyle(0xfff6a0, 0.9); g.fillCircle(21, 20, 4);
      // 高光
      g.fillStyle(0xffffff, 0.5); g.fillCircle(16, 14, 3);
      // 成熟闪烁边框
      g.lineStyle(2, 0xffe066, 0.9); g.strokeCircle(21, 20, 13);
      g.generateTexture('crop_' + cr.id + '_s2', CELL, CELL); g.destroy();
    }

    // 鸡 将来换：spritesheet
    rm('chicken_idle');
    g = scene.add.graphics();
    g.fillStyle(0xfff8dc, 1); g.fillCircle(16, 18, 12);
    g.fillStyle(0xff6b6b, 1); g.fillTriangle(16, 4, 12, 10, 20, 10);
    g.fillStyle(0x333333, 1); g.fillCircle(12, 16, 2); g.fillCircle(20, 16, 2);
    g.fillStyle(0xffd23f, 1); g.fillTriangle(16, 18, 13, 22, 19, 22);
    g.generateTexture('chicken_idle', 32, 32); g.destroy();

    rm('egg_icon');
    g = scene.add.graphics();
    g.fillStyle(0xfffbe6, 1); g.fillEllipse(10, 12, 12, 14);
    g.lineStyle(1, 0xd8c06a, 1); g.strokeEllipse(10, 12, 12, 14);
    g.generateTexture('egg_icon', 20, 20); g.destroy();

    // 通用 1x1
    rm('pixel');
    g = scene.add.graphics(); g.fillStyle(0xffffff, 1); g.fillRect(0, 0, 1, 1);
    g.generateTexture('pixel', 1, 1); g.destroy();
  }

  // ==========================================================================
  // FarmScene — 主场景（单场景完成两季）
  // ==========================================================================
  var FarmScene = null;

  function defineScene(Phaser) {
    FarmScene = class extends Phaser.Scene {
      constructor() { super('farm-scene'); }

      init() {
        // 从存档恢复或默认
        this.day = saveCache.day || 1;
        this.gold = (typeof saveCache.gold === 'number') ? saveCache.gold : 120;
        this.seasonIdx = seasonOfDay(this.day);
        this.stamina = MAX_STAMINA;
        this.phase = 'play';
        this.selectedTool = TOOL_HOE;
        this.selectedSeedIdx = 0; // 在 CROPS 中的索引（受季筛选）
        this.grid = [];
        for (var i = 0; i < TOTAL; i++) {
          this.grid.push({ tilled: false, crop: null });
        }
        // 家畜：简化 1 种鸡
        this.hasChicken = true;
        this.chickenFedToday = false;
        this.eggReady = false;
        this.chickenHappy = 0;
        // 背包：种子库存 + 收获物数量
        this.seedBag = {}; // id -> count
        this.harvestBag = {}; // id -> count
        for (var ci2 = 0; ci2 < CROPS.length; ci2++) { this.seedBag[CROPS[ci2].id] = 2; }
        this.totalHarvestGold = 0;
        this.bestHarvest = saveCache.bestHarvest || 0;
        this.shopOpen = false;
        // 池化：tile sprites 复用（静态 6x8 不增删，仅换纹理，避免每帧重建）
        this.tileSprites = [];
        this.tileCropSprites = []; // 叠加层？实际用同一 sprite 换纹理
        this._msgTimer = null;
        this._bgmSeason = -1;
      }

      create() {
        sceneRef = this;
        buildTextures(this);

        var W = this.scale.width, H = this.scale.height;
        this.W = W; this.H = H;

        // 背景（季节 tint）
        this.bg = this.add.image(W / 2, H / 2, 'pixel').setDisplaySize(W, H).setTint(SEASONS[this.seasonIdx].bg).setDepth(0);

        // 顶部 HUD 条
        this.hudBg = this.add.image(W / 2, 14, 'pixel').setDisplaySize(W, 28).setTint(0x1a1a2e).setAlpha(0.92).setDepth(10);
        this.hudText = this.add.text(8, 6, '', { fontSize: '11px', color: '#ffd66b', fontFamily: 'monospace' }).setDepth(11);
        this.msgText = this.add.text(W / 2, 30, '', { fontSize: '11px', color: '#ffffff', fontFamily: 'monospace', backgroundColor: '#00000088' }).setOrigin(0.5, 0).setDepth(12).setVisible(false);

        // 田地容器（点击区）
        this.fieldGroup = this.add.group();
        this._buildField();

        // 工具栏
        this._buildToolbar();
        // 商店按钮 + 睡觉按钮 + 鸡舍
        this._buildSidePanel();
        // 商店弹窗（默认隐藏）
        this._buildShop();

        // 键盘
        this.keys = this.input.keyboard.addKeys('ONE,TWO,THREE,FOUR,B,S,SPACE,ENTER,R');
        this.input.on('pointerdown', this._onPointerDown, this);

        this._refreshSeasonBgm();
        this._updateHud();
        this._refreshField();
        this._syncShopStock();
      }

      // ——— 田块静态池：一次性建 48 个 sprite，后续仅 setTexture
      _buildField() {
        // 田块背景框
        var fw = COLS * CELL, fh = ROWS * CELL;
        this.fieldFrame = this.add.graphics().setDepth(1);
        this.fieldFrame.lineStyle(2, 0x2e1e10, 1);
        this.fieldFrame.strokeRect(FIELD_X - 2, FIELD_Y - 2, fw + 4, fh + 4);
        this.fieldFrame.fillStyle(0x000000, 0.12);
        this.fieldFrame.fillRect(FIELD_X, FIELD_Y, fw, fh);
        // 网格线另画
        var gl = this.add.graphics().setDepth(2);
        gl.lineStyle(1, 0x2e1e10, 0.22);
        for (var c = 1; c < COLS; c++) { gl.lineBetween(FIELD_X + c * CELL, FIELD_Y, FIELD_X + c * CELL, FIELD_Y + fh); }
        for (var r = 1; r < ROWS; r++) { gl.lineBetween(FIELD_X, FIELD_Y + r * CELL, FIELD_X + fw, FIELD_Y + r * CELL); }

        for (var i = 0; i < TOTAL; i++) {
          var col = i % COLS, row = Math.floor(i / COLS);
          var x = FIELD_X + col * CELL, y = FIELD_Y + row * CELL;
          var sp = this.add.image(x, y, 'tile_empty').setOrigin(0, 0).setDepth(3).setInteractive();
          sp._idx = i;
          this.tileSprites.push(sp);
        }
        // 交互：每个 tile 已 interactive，pointerdown 经全局分发，这里仅保留索引
      }

      _buildToolbar() {
        var W = this.W;
        var labels = ['[1]锄地', '[2]播种', '[3]浇水', '[4]收获'];
        var costs = [COST_HOE, COST_SOW, COST_WATER, COST_HARVEST];
        this.toolBtns = [];
        var ty = FIELD_Y + ROWS * CELL + 10;
        for (var i = 0; i < 4; i++) {
          var bx = 12 + i * 84;
          var bg = this.add.image(bx, ty, 'pixel').setOrigin(0, 0).setDisplaySize(80, 22).setTint(0x333344).setDepth(10).setInteractive();
          bg._tool = i;
          bg.on('pointerdown', (function (t) { return function () { this._selectTool(t); }; }).call(this, i).bind(this));
          var tx = this.add.text(bx + 6, ty + 5, labels[i] + ' -' + costs[i], { fontSize: '10px', color: '#ffffff', fontFamily: 'monospace' }).setDepth(11);
          this.toolBtns.push({ bg: bg, tx: tx, idx: i });
        }
        // 种子选择行（仅播种时高亮）
        this.seedRowY = ty + 26;
        this.seedBtns = [];
        for (var si = 0; si < CROPS.length; si++) {
          var sx = 12 + si * 92;
          var sbg = this.add.image(sx, this.seedRowY, 'pixel').setOrigin(0, 0).setDisplaySize(88, 16).setTint(0x2a2a3a).setDepth(10).setInteractive();
          sbg._sidx = si;
          sbg.on('pointerdown', (function (s) { return function () { this.selectedSeedIdx = s; this._selectTool(TOOL_SOW); }; }).call(this, si).bind(this));
          var cr2 = CROPS[si];
          var stx = this.add.text(sx + 4, this.seedRowY + 3, cr2.name + ' ¥' + cr2.seedPrice + ' x' + (this.seedBag[cr2.id] || 0), { fontSize: '9px', color: '#cccccc', fontFamily: 'monospace' }).setDepth(11);
          this.seedBtns.push({ bg: sbg, tx: stx, cr: cr2 });
        }
        this._syncToolUi();
      }

      _buildSidePanel() {
        var W = this.W;
        var px = W - 116;
        var py = FIELD_Y;
        // 右侧面板背景
        this.sideBg = this.add.image(px, py, 'pixel').setOrigin(0, 0).setDisplaySize(104, 220).setTint(0x1e2a1e).setAlpha(0.88).setDepth(10);
        this.sideTitle = this.add.text(px + 6, py + 6, '经营', { fontSize: '11px', color: '#ffd66b', fontFamily: 'monospace' }).setDepth(11);
        // 鸡舍区
        this.chickenSprite = this.add.image(px + 52, py + 38, 'chicken_idle').setDepth(11).setScale(1.15);
        this.chickenLabel = this.add.text(px + 6, py + 60, '', { fontSize: '9px', color: '#e0e0e0', fontFamily: 'monospace', wordWrap: { width: 92 } }).setDepth(11);
        this.btnFeed = this.add.image(px + 6, py + 96, 'pixel').setOrigin(0, 0).setDisplaySize(92, 18).setTint(0x4a6a4a).setDepth(11).setInteractive();
        this.btnFeedTx = this.add.text(px + 10, py + 100, '喂鸡 -1体力 ¥' + FEED_PRICE, { fontSize: '9px', color: '#ffffff', fontFamily: 'monospace' }).setDepth(12);
        this.btnFeed.on('pointerdown', this._onFeed.bind(this));
        this.btnEgg = this.add.image(px + 6, py + 118, 'pixel').setOrigin(0, 0).setDisplaySize(92, 18).setTint(0x6a5a2a).setDepth(11).setInteractive();
        this.btnEggTx = this.add.text(px + 10, py + 122, '收蛋', { fontSize: '9px', color: '#ffffff', fontFamily: 'monospace' }).setDepth(12);
        this.btnEgg.on('pointerdown', this._onCollectEgg.bind(this));
        // 商店/睡觉
        this.btnShop = this.add.image(px + 6, py + 146, 'pixel').setOrigin(0, 0).setDisplaySize(92, 20).setTint(0x3a4a6a).setDepth(11).setInteractive();
        this.btnShopTx = this.add.text(px + 14, py + 151, '[B] 商店', { fontSize: '10px', color: '#ffffff', fontFamily: 'monospace' }).setDepth(12);
        this.btnShop.on('pointerdown', this._toggleShop.bind(this));
        this.btnSleep = this.add.image(px + 6, py + 170, 'pixel').setOrigin(0, 0).setDisplaySize(92, 20).setTint(0x4a3a6a).setDepth(11).setInteractive();
        this.btnSleepTx = this.add.text(px + 14, py + 175, '[S] 睡觉 次日', { fontSize: '10px', color: '#ffffff', fontFamily: 'monospace' }).setDepth(12);
        this.btnSleep.on('pointerdown', this._sleep.bind(this));
        // 库存简览
        this.bagText = this.add.text(px + 6, py + 196, '', { fontSize: '8px', color: '#aaccaa', fontFamily: 'monospace' }).setDepth(11);
      }

      _buildShop() {
        var W = this.W, H = this.H;
        this.shopDim = this.add.image(W / 2, H / 2, 'pixel').setDisplaySize(W, H).setTint(0x000000).setAlpha(0.58).setDepth(19).setInteractive().setVisible(false);
        this.shopDim.on('pointerdown', this._toggleShop.bind(this));
        var sw = 360, sh = 260;
        var sx = (W - sw) / 2, sy = (H - sh) / 2;
        this.shopPanel = this.add.image(sx, sy, 'pixel').setOrigin(0, 0).setDisplaySize(sw, sh).setTint(0x1a2333).setDepth(20).setVisible(false);
        this.shopTitle = this.add.text(sx + 12, sy + 10, '商店 — 买种子 / 卖收获物', { fontSize: '12px', color: '#ffd66b', fontFamily: 'monospace' }).setDepth(21).setVisible(false);
        this.shopHint = this.add.text(sx + 12, sy + 28, '春可买芜菁/土豆，夏可买番茄/土豆', { fontSize: '9px', color: '#8aacc8', fontFamily: 'monospace' }).setDepth(21).setVisible(false);
        this.shopRows = [];
        for (var i = 0; i < CROPS.length; i++) {
          var ry = sy + 48 + i * 38;
          var rowBg = this.add.image(sx + 8, ry, 'pixel').setOrigin(0, 0).setDisplaySize(sw - 16, 32).setTint(0x2a3444).setDepth(21).setVisible(false);
          var cr3 = CROPS[i];
          var nameTx = this.add.text(sx + 16, ry + 4, cr3.name + '  种子¥' + cr3.seedPrice + '  成熟¥' + cr3.sellPrice + '  ' + cr3.growDays + '天', { fontSize: '9px', color: '#e0e0e0', fontFamily: 'monospace' }).setDepth(22).setVisible(false);
          var stockTx = this.add.text(sx + 16, ry + 17, '', { fontSize: '8px', color: '#aaccaa', fontFamily: 'monospace' }).setDepth(22).setVisible(false);
          var buyBtn = this.add.image(sx + sw - 92, ry + 6, 'pixel').setOrigin(0, 0).setDisplaySize(38, 20).setTint(0x3a6a3a).setDepth(22).setInteractive().setVisible(false);
          var buyTx = this.add.text(sx + sw - 84, ry + 11, '买1', { fontSize: '9px', color: '#ffffff', fontFamily: 'monospace' }).setDepth(23).setVisible(false);
          buyBtn._cidx = i; buyBtn.on('pointerdown', (function (idx) { return function () { this._shopBuy(idx); }; }).call(this, i).bind(this));
          var sellBtn = this.add.image(sx + sw - 48, ry + 6, 'pixel').setOrigin(0, 0).setDisplaySize(38, 20).setTint(0x6a4a2a).setDepth(22).setInteractive().setVisible(false);
          var sellTx = this.add.text(sx + sw - 40, ry + 11, '卖1', { fontSize: '9px', color: '#ffffff', fontFamily: 'monospace' }).setDepth(23).setVisible(false);
          sellBtn._cidx = i; sellBtn.on('pointerdown', (function (idx) { return function () { this._shopSell(idx); }; }).call(this, i).bind(this));
          this.shopRows.push({ bg: rowBg, nameTx: nameTx, stockTx: stockTx, buyBtn: buyBtn, buyTx: buyTx, sellBtn: sellBtn, sellTx: sellTx, cr: cr3 });
        }
        // 饲料行
        var fry = sy + 48 + CROPS.length * 38 + 4;
        this.feedRowBg = this.add.image(sx + 8, fry, 'pixel').setOrigin(0, 0).setDisplaySize(sw - 16, 28).setTint(0x2a3444).setDepth(21).setVisible(false);
        this.feedTx = this.add.text(sx + 16, fry + 8, '鸡饲料  ¥' + FEED_PRICE + ' /份', { fontSize: '9px', color: '#e0e0e0', fontFamily: 'monospace' }).setDepth(22).setVisible(false);
        this.feedBuy = this.add.image(sx + sw - 92, fry + 4, 'pixel').setOrigin(0, 0).setDisplaySize(38, 20).setTint(0x3a6a3a).setDepth(22).setInteractive().setVisible(false);
        this.feedBuyTx = this.add.text(sx + sw - 84, fry + 9, '买1', { fontSize: '9px', color: '#ffffff', fontFamily: 'monospace' }).setDepth(23).setVisible(false);
        this.feedBuy.on('pointerdown', this._shopBuyFeed.bind(this));
        // 关闭
        this.shopClose = this.add.image(sx + sw - 28, sy + 8, 'pixel').setOrigin(0, 0).setDisplaySize(20, 16).setTint(0x5a2a2a).setDepth(22).setInteractive().setVisible(false);
        this.shopCloseTx = this.add.text(sx + sw - 22, sy + 10, 'X', { fontSize: '10px', color: '#ffffff', fontFamily: 'monospace' }).setDepth(23).setVisible(false);
        this.shopClose.on('pointerdown', this._toggleShop.bind(this));
        this._shopEls = [this.shopDim, this.shopPanel, this.shopTitle, this.shopHint, this.feedRowBg, this.feedTx, this.feedBuy, this.feedBuyTx, this.shopClose, this.shopCloseTx];
      }

      _selectTool(t) {
        this.selectedTool = t;
        if (t === TOOL_SOW) {
          // 若当前种子当季不可种，自动切到当季第一个可用
          var cur = CROPS[this.selectedSeedIdx];
          if (!seasonAllows(cur.id, this.seasonIdx)) {
            for (var i = 0; i < CROPS.length; i++) {
              if (seasonAllows(CROPS[i].id, this.seasonIdx)) { this.selectedSeedIdx = i; break; }
            }
          }
        }
        this._syncToolUi();
        this._showMsg(['锄地','播种','浇水','收获'][t] + ' 模式', 900);
      }

      _syncToolUi() {
        for (var i = 0; i < this.toolBtns.length; i++) {
          var b = this.toolBtns[i];
          b.bg.setTint(i === this.selectedTool ? 0x6a9a4a : 0x333344);
          b.tx.setColor(i === this.selectedTool ? '#ffffff' : '#aaaaaa');
        }
        for (var si = 0; si < this.seedBtns.length; si++) {
          var sb = this.seedBtns[si];
          var cr = sb.cr;
          var allowed = seasonAllows(cr.id, this.seasonIdx);
          var isSel = (si === this.selectedSeedIdx && this.selectedTool === TOOL_SOW);
          sb.bg.setTint(isSel ? 0x6a9a4a : (allowed ? 0x2a2a3a : 0x2a1a1a));
          sb.bg.setAlpha(allowed ? 1 : 0.55);
          var cnt = this.seedBag[cr.id] || 0;
          sb.tx.setText(cr.name + ' ¥' + cr.seedPrice + ' x' + cnt + (allowed ? '' : ' (非当季)'));
          sb.tx.setColor(isSel ? '#ffffff' : (allowed ? '#cccccc' : '#7a5a5a'));
        }
        this._syncBagText();
      }

      _syncBagText() {
        var parts = [];
        for (var i = 0; i < CROPS.length; i++) {
          var id = CROPS[i].id;
          var h = this.harvestBag[id] || 0;
          if (h > 0) { parts.push(CROPS[i].name + 'x' + h); }
        }
        this.bagText.setText(parts.length ? '收获:' + parts.join(' ') : '收获:—');
      }

      _showMsg(s, dur) {
        var self = this;
        this.msgText.setText(s).setVisible(true).setAlpha(1);
        if (this._msgTimer) { this.time.removeEvent(this._msgTimer); }
        this._msgTimer = this.time.delayedCall(dur || 1400, function () {
          self.tweens.add({ targets: self.msgText, alpha: 0, duration: 260, onComplete: function () { self.msgText.setVisible(false).setAlpha(1); } });
        });
      }

      _onPointerDown(ptr) {
        if (this.shopOpen) { return; }
        // 命中田块？
        var x = ptr.x, y = ptr.y;
        if (x < FIELD_X || x >= FIELD_X + COLS * CELL || y < FIELD_Y || y >= FIELD_Y + ROWS * CELL) { return; }
        var col = Math.floor((x - FIELD_X) / CELL), row = Math.floor((y - FIELD_Y) / CELL);
        var idx = row * COLS + col;
        this._applyTool(idx);
      }

      _consumeStamina(cost) {
        if (this.stamina < cost) {
          Sfx.play('noStamina');
          this._showMsg('体力不足！去睡觉恢复', 1200);
          return false;
        }
        this.stamina -= cost;
        return true;
      }

      _applyTool(idx) {
        var cell = this.grid[idx];
        var tool = this.selectedTool;
        if (tool === TOOL_HOE) {
          if (cell.crop) {
            // 枯萎或已成熟未收？锄掉清空（给一次补救）
            if (cell.crop.wilted || cell.crop.stage === 2) {
              if (!this._consumeStamina(COST_HOE)) { return; }
              cell.crop = null; cell.tilled = false;
              Sfx.play('hoe'); this._showMsg('清除了枯萎/残株', 800);
            } else {
              this._showMsg('作物生长中，不能锄', 800);
              return;
            }
          } else if (!cell.tilled) {
            if (!this._consumeStamina(COST_HOE)) { return; }
            cell.tilled = true;
            Sfx.play('hoe');
          } else {
            this._showMsg('已锄过', 600);
          }
        } else if (tool === TOOL_SOW) {
          if (!cell.tilled || cell.crop) {
            this._showMsg(cell.crop ? '已有作物' : '需先锄地', 700);
            return;
          }
          var cr = CROPS[this.selectedSeedIdx];
          if (!seasonAllows(cr.id, this.seasonIdx)) {
            this._showMsg(cr.name + ' 非当季不可种', 900);
            return;
          }
          var have = this.seedBag[cr.id] || 0;
          if (have <= 0) {
            this._showMsg(cr.name + ' 种子不足，去商店买', 1000);
            return;
          }
          if (!this._consumeStamina(COST_SOW)) { return; }
          this.seedBag[cr.id] = have - 1;
          cell.crop = { typeId: cr.id, stage: 0, daysGrown: 0, wateredToday: false, wilted: false };
          Sfx.play('sow');
        } else if (tool === TOOL_WATER) {
          if (!cell.crop) { this._showMsg('无作物可浇', 600); return; }
          if (cell.crop.wilted) { this._showMsg('已枯萎，锄掉重种', 800); return; }
          if (cell.crop.stage === 2) { this._showMsg('已成熟，快收获', 700); return; }
          if (cell.crop.wateredToday) { this._showMsg('今日已浇过', 700); return; }
          if (!this._consumeStamina(COST_WATER)) { return; }
          cell.crop.wateredToday = true;
          Sfx.play('water');
        } else if (tool === TOOL_HARVEST) {
          if (!cell.crop || cell.crop.stage !== 2) {
            this._showMsg(cell.crop && cell.crop.wilted ? '已枯萎' : '未成熟', 700);
            return;
          }
          if (!this._consumeStamina(COST_HARVEST)) { return; }
          var crH = cropById(cell.crop.typeId);
          var price = crH.sellPrice;
          this.gold += price;
          this.totalHarvestGold += price;
          this.harvestBag[crH.id] = (this.harvestBag[crH.id] || 0) + 1;
          if (this.totalHarvestGold > this.bestHarvest) { this.bestHarvest = this.totalHarvestGold; }
          saveCache.bestHarvest = this.bestHarvest;
          saveCache.gold = this.gold;
          // 不直接清格，保留 tilled 供下一轮播种（收获后土地仍为已锄状态）
          cell.crop = null;
          cell.tilled = true; // 收后仍可直接播种
          Sfx.play('harvest');
          this._showMsg(crH.name + ' +' + price + 'G', 900);
        }
        this._refreshField();
        this._syncToolUi();
        this._updateHud();
      }

      _onFeed() {
        if (this.chickenFedToday) { this._showMsg('今日已喂过', 700); return; }
        if (this.gold < FEED_PRICE) { this._showMsg('金不足', 700); Sfx.play('noStamina'); return; }
        if (!this._consumeStamina(COST_FEED)) { return; }
        this.gold -= FEED_PRICE;
        this.chickenFedToday = true;
        this.chickenHappy = 1;
        Sfx.play('feed');
        this._showMsg('喂鸡成功，明早收蛋', 900);
        this._updateHud();
      }

      _onCollectEgg() {
        if (!this.eggReady) { this._showMsg('暂无蛋（需昨日喂食）', 900); return; }
        this.eggReady = false;
        this.gold += EGG_PRICE;
        this.totalHarvestGold += EGG_PRICE;
        if (this.totalHarvestGold > this.bestHarvest) { this.bestHarvest = this.totalHarvestGold; }
        saveCache.bestHarvest = this.bestHarvest;
        saveCache.gold = this.gold;
        Sfx.play('egg');
        this._showMsg('收蛋 +' + EGG_PRICE + 'G', 800);
        this._updateHud();
      }

      _toggleShop() {
        this.shopOpen = __omp_shell("this.shopOpen;")
        var vis = this.shopOpen;
        for (var i = 0; i < this._shopEls.length; i++) { this._shopEls[i].setVisible(vis); }
        for (var r = 0; r < this.shopRows.length; r++) {
          var row = this.shopRows[r];
          row.bg.setVisible(vis); row.nameTx.setVisible(vis); row.stockTx.setVisible(vis);
          row.buyBtn.setVisible(vis); row.buyTx.setVisible(vis); row.sellBtn.setVisible(vis); row.sellTx.setVisible(vis);
        }
        if (vis) { this._syncShopStock(); }
      }

      _syncShopStock() {
        for (var i = 0; i < this.shopRows.length; i++) {
          var row = this.shopRows[i];
          var cr = row.cr;
          var allowed = seasonAllows(cr.id, this.seasonIdx);
          var haveSeed = this.seedBag[cr.id] || 0;
          var haveHarv = this.harvestBag[cr.id] || 0;
          row.stockTx.setText('种子x' + haveSeed + '  收获x' + haveHarv + (allowed ? '' : '  (非当季不可买种)'));
          row.bg.setTint(allowed ? 0x2a3444 : 0x2a1f1f);
          row.buyBtn.setTint(allowed ? 0x3a6a3a : 0x4a2a2a).setAlpha(allowed ? 1 : 0.5);
          row.sellBtn.setAlpha(haveHarv > 0 ? 1 : 0.45);
        }
      }

      _shopBuy(cidx) {
        var cr = CROPS[cidx];
        if (!seasonAllows(cr.id, this.seasonIdx)) { this._showMsg(cr.name + ' 非当季', 800); Sfx.play('noStamina'); return; }
        if (this.gold < cr.seedPrice) { this._showMsg('金不足', 700); Sfx.play('noStamina'); return; }
        this.gold -= cr.seedPrice;
        this.seedBag[cr.id] = (this.seedBag[cr.id] || 0) + 1;
        Sfx.play('buy');
        this._showMsg('买 ' + cr.name + '种子 -' + cr.seedPrice + 'G', 800);
        this._syncShopStock(); this._syncToolUi(); this._updateHud();
      }

      _shopSell(cidx) {
        var cr = CROPS[cidx];
        var have = this.harvestBag[cr.id] || 0;
        if (have <= 0) { this._showMsg('无可卖的' + cr.name, 700); return; }
        this.harvestBag[cr.id] = have - 1;
        this.gold += cr.sellPrice;
        this.totalHarvestGold += cr.sellPrice;
        if (this.totalHarvestGold > this.bestHarvest) { this.bestHarvest = this.totalHarvestGold; }
        saveCache.bestHarvest = this.bestHarvest;
        Sfx.play('sell');
        this._showMsg('卖 ' + cr.name + ' +' + cr.sellPrice + 'G', 800);
        this._syncShopStock(); this._syncToolUi(); this._updateHud();
      }

      _shopBuyFeed() {
        if (this.gold < FEED_PRICE) { this._showMsg('金不足', 700); Sfx.play('noStamina'); return; }
        // 饲料为消耗品，这里简化：买即视为当日喂食额度？改为仅提示去喂鸡按钮
        // 为简化，买饲料直接等同喂一次（若还没喂）
        if (this.chickenFedToday) { this._showMsg('今日已喂过，无需再买', 800); return; }
        // 不扣体力，仅扣金，标记可喂
        this._showMsg('请点右侧 喂鸡 按钮', 800);
      }

      _sleep() {
        if (this.shopOpen) { this._toggleShop(); }
        // 结算：作物生长与浇水关联 —— 未浇水则枯萎，浇水才 +1 天
        var wiltCount = 0, growCount = 0;
        for (var i = 0; i < this.grid.length; i++) {
          var cell = this.grid[i];
          var cp = cell.crop;
          if (!cp || cp.wilted || cp.stage === 2) { continue; }
          if (!cp.wateredToday) {
            cp.wilted = true;
            wiltCount++;
          } else {
            cp.daysGrown += 1;
            cp.wateredToday = false;
            growCount++;
            var cr = cropById(cp.typeId);
            if (cp.daysGrown >= cr.growDays) { cp.stage = 2; }
            else if (cp.daysGrown >= Math.ceil(cr.growDays / 2)) { cp.stage = 1; }
            else { cp.stage = 0; }
          }
        }
        // 家畜：喂过才产蛋
        if (this.chickenFedToday) {
          this.eggReady = true;
          this.chickenFedToday = false;
          this.chickenHappy = 1;
        } else {
          this.eggReady = false;
          this.chickenHappy = 0;
        }
        this.day += 1;
        var nextSeason = seasonOfDay(this.day);
        if (nextSeason !== this.seasonIdx) {
          this.seasonIdx = nextSeason;
          this._showMsg('进入 ' + SEASONS[this.seasonIdx].name + '季！', 1400);
          this._refreshSeasonBgm();
        } else {
          var msg = '第' + this.day + '天  ';
          if (wiltCount) { msg += wiltCount + '株枯萎 '; }
          if (growCount) { msg += growCount + '株生长 '; }
          if (!wiltCount && !growCount) { msg += '无作物生长'; }
          this._showMsg(msg, 1300);
        }
        this.stamina = MAX_STAMINA;
        saveCache.day = this.day;
        saveCache.gold = this.gold;
        persistSave();
        Sfx.play('sleep');
        // 季节结束检测
        var totalDays = SEASONS[0].days + SEASONS[1].days;
        if (this.day > totalDays) {
          this.phase = 'done';
          this._showMsg('两季结束！总收获¥' + this.totalHarvestGold, 3000);
        }
        this._refreshField();
        this._updateHud();
        this._syncToolUi();
        this._syncShopStock();
      }

      _refreshField() {
        for (var i = 0; i < TOTAL; i++) {
          var cell = this.grid[i];
          var sp = this.tileSprites[i];
          var tex = 'tile_empty';
          if (cell.crop) {
            if (cell.crop.wilted) { tex = 'crop_wilted'; }
            else if (cell.crop.stage === 2) { tex = 'crop_' + cell.crop.typeId + '_s2'; }
            else if (cell.crop.stage === 1) { tex = 'crop_' + cell.crop.typeId + '_s1'; }
            else {
              // stage 0：若已浇水用 watered 底，否则 s0
              tex = cell.crop.wateredToday ? 'tile_watered' : ('crop_' + cell.crop.typeId + '_s0');
              // 已浇水的 s0 需要在 tile_watered 上叠苗？简化：watered 时直接用 tile_watered 纹理，苗用 alpha 叠？此处简化为 tile_watered
              // 为保留苗可见性，s0 已含苗，watered 额外加水光：用 tile_watered 时苗会丢，折中：若浇水则仍用 s0 但加一层水光 sprite
              // 简化实现：直接用 s0，水光由 _waterOverlay 另画
              if (cell.crop.wateredToday) { tex = 'crop_' + cell.crop.typeId + '_s0'; }
            }
          } else if (cell.tilled) {
            tex = 'tile_tilled';
          }
          sp.setTexture(tex);
          // 浇水水光叠加（小蓝条）
          // 用已有 sprite 的 tint 模拟：已浇水且未成熟 → 加蓝 tint
          if (cell.crop && cell.crop.wateredToday && cell.crop.stage !== 2 && !cell.crop.wilted) {
            sp.setTint(0x88ccee);
          } else {
            sp.clearTint();
          }
        }
        // 鸡舍状态
        if (this.chickenLabel) {
          var s = this.hasChicken ? (this.chickenFedToday ? '鸡:已喂 今日会产蛋' : (this.eggReady ? '鸡:有蛋可收！' : '鸡:未喂 不产蛋')) : '无鸡';
          this.chickenLabel.setText(s);
          this.chickenSprite.setTint(this.chickenHappy ? 0xffffff : 0x9a9a9a);
          this.btnEgg.setTint(this.eggReady ? 0x6a9a2a : 0x4a4a4a);
          this.btnEgg.setAlpha(this.eggReady ? 1 : 0.6);
        }
      }

      _refreshSeasonBgm() {
        if (this._bgmSeason === this.seasonIdx) { return; }
        this._bgmSeason = this.seasonIdx;
        if (this.bg) { this.bg.setTint(SEASONS[this.seasonIdx].bg); }
        Sfx.playBgm(this.seasonIdx);
      }

      _updateHud() {
        var s = SEASONS[this.seasonIdx];
        var dIn = dayInSeason(this.day);
        var seasonTag = s.name + '季 ' + dIn + '/' + s.days;
        var toolNames = ['锄', '播', '浇', '收'];
        var crName = CROPS[this.selectedSeedIdx].name;
        var toolInfo = toolNames[this.selectedTool] + (this.selectedTool === TOOL_SOW ? '(' + crName + ')' : '');
        var goldStr = '¥' + this.gold;
        var staminaStr = '体力 ' + this.stamina + '/' + MAX_STAMINA;
        var target = s.targetGold;
        var prog = Math.min(100, Math.floor(this.totalHarvestGold / target * 100));
        var hud = 'Day ' + this.day + ' ' + seasonTag + '  ' + goldStr + '  ' + staminaStr + '  工具:' + toolInfo + '  本季目标¥' + target + '(' + prog + '%)  收获¥' + this.totalHarvestGold + ' 最高¥' + this.bestHarvest;
        if (this.phase === 'done') { hud += '  ★两季完成'; }
        this.hudText.setText(hud);
      }

      update() {
        // 键盘快捷
        if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { this._selectTool(TOOL_HOE); }
        if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { this._selectTool(TOOL_SOW); }
        if (Phaser.Input.Keyboard.JustDown(this.keys.THREE)) { this._selectTool(TOOL_WATER); }
        if (Phaser.Input.Keyboard.JustDown(this.keys.FOUR)) { this._selectTool(TOOL_HARVEST); }
        if (Phaser.Input.Keyboard.JustDown(this.keys.B)) { this._toggleShop(); }
        if (Phaser.Input.Keyboard.JustDown(this.keys.S) || Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.ENTER)) {
          // 避免在输入时误触，shop 开时 S 不睡觉
          if (!this.shopOpen) { this._sleep(); }
        }
      }

      shutdown() {
        Sfx.stopBgm();
        if (this.input) { this.input.off('pointerdown', this._onPointerDown, this); }
      }
    };
  }

  // ==========================================================================
  // launch / register
  // ==========================================================================
  function launch(host) {
    hostRef = host;
    loadSave();
    var Phaser = host.phaser || window.Phaser;
    if (!Phaser) {
      host.container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#e55;font-family:monospace">Phaser 未加载</div>';
      return { dispose: function () {} };
    }
    defineScene(Phaser);
    var W = host.width || 560;
    var H = host.height || 520;
    // 紧凑布局：宽 560 高 520 刚好容纳 6x8 田 + 侧栏 + 工具栏
    var config = {
      type: Phaser.AUTO,
      parent: host.container,
      width: W,
      height: H,
      backgroundColor: '#0f1419',
      physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
      scene: [FarmScene]
    };
    var game = new Phaser.Game(config);
    window.__trgame = { game: game, getState: getState, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: function () { return sceneRef; } };
    return {
      dispose: function () {
        try { Sfx.stopBgm(); } catch (e) {}
        try { game.destroy(true); } catch (e2) {}
        sceneRef = null;
        window.__trgame = null;
      }
    };
  }

  if (typeof window.TRGames !== 'undefined' && typeof window.TRGames.register === 'function') {
    window.TRGames.register({ id: 'farm-story', title: '牧场物语 Farm Story', launch: launch });
  }
})();
