(function () {
  'use strict';
  // =============================================================================
  // stg-horizontal v0.1.0 — 横版STG Gradius 风格
  // =============================================================================
  // 资产清单（文件头）：
  //   纹理：player/option/enemy0/enemy1/enemy2/enemy3/bulletP/bulletE/capsule/
  //         terrainTop/terrainBottom/explosion(4帧)/bossCore/panel
  //         均为 Graphics + generateTexture 纯几何，零外部资源
  //         // TODO: 替换为美术资源时在此清单对应键名替换 generateTexture 块
  //   音频：Sfx.play(type) WebAudio oscillator+gain，首输入 resume，静默降级
  //         // TODO: 替换采样时在 Sfx.play 分支替换 oscillator 参数为 AudioBuffer
  //   存档：host.saveState { hiScore:number, reachedStage:number }
  //
  // 可调参数（顶部集中）：
  //   SCROLL_SPEED / PLAYER_SPEED / BULLET_SPEED / ENEMY_TYPES / STAGE_TIMES
  //   全中文注释，至少2关，标题→循环→结束重开，对象池复用
  //   关卡：STAGE 1 岩窟 / STAGE 2 要塞 — 各末 Boss 大船核心多阶段
  // =============================================================================

  // ---------------------------------------------------------------------------
  // 顶部可调参数
  // ---------------------------------------------------------------------------
  /** 世界右卷轴速度 px/s */
  var SCROLL_SPEED = 120;
  /** 玩家基础速度 px/s */
  var PLAYER_BASE_SPEED = 210;
  /** 每次 SPEED UP 增加 px/s */
  var SPEED_STEP = 32;
  /** 最大 SPEED UP 次数 */
  var SPEED_MAX = 5;
  /** 玩家子弹速度 px/s */
  var BULLET_SPEED = 520;
  /** 敌弹速度 px/s */
  var ENEMY_BULLET_SPEED = 260;
  /** 玩家射击间隔 ms（按住自动连发） */
  var FIRE_INTERVAL = 150;
  /** 无敌时间 ms */
  var INVINCIBLE_MS = 1500;
  /** 地形块宽度 px */
  var TERRAIN_W = 96;
  /** 地形生成间隔 ms */
  var TERRAIN_INTERVAL = 620;
  /** 编队生成间隔 ms */
  var FORMATION_INTERVAL = 2200;
  /** 胶囊下落速度 px/s */
  var CAPSULE_SPEED = 70;
  /** Option 轨迹队列长度（帧数） */
  var OPTION_TRAIL_LEN = 18;
  /** Option 最大数量 */
  var OPTION_MAX = 4;
  /** 爆炸池大小 */
  var EXPLOSION_POOL = 16;

  /** Gradius 能量条定义（≥4格，此处6格） */
  var POWER_NAMES = ['SPEED UP', 'MISSILE', 'DOUBLE', 'LASER', 'OPTION', 'SHIELD'];
  /** 激活所需胶囊数（Gradius 式：格位=消耗） */
  var POWER_COST = [1, 2, 3, 4, 4, 5];

  // ---------------------------------------------------------------------------
  // 存档与状态
  // ---------------------------------------------------------------------------
  var hostRef = null;
  var sceneRef = null;
  var hiScore = 0;
  var reachedStage = 1;

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---------------------------------------------------------------------------
  // Sfx — WebAudio oscillator+gain，首输入 resume，静默降级
  // ---------------------------------------------------------------------------
  var Sfx = {
    ctx: null,
    enabled: true,
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
      var c = this._ensure();
      if (!c) { return; }
      if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    },
    /**
     * 播放音效
     * @param {string} type shoot|explosion|capsule|powerup|bossHit|alarm|hit
     */
    play: function (type) {
      var c = this._ensure();
      if (!c || !this.enabled) { return; }
      this._resume();
      try {
        var o = c.createOscillator();
        var g = c.createGain();
        o.connect(g); g.connect(c.destination);
        var now = c.currentTime;
        // // TODO: 替换采样音频时在此 switch 替换为 decodeAudioData 播放
        if (type === 'shoot') {
          o.type = 'square'; o.frequency.setValueAtTime(880, now);
          o.frequency.exponentialRampToValueAtTime(440, now + 0.08);
          g.gain.setValueAtTime(0.22, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
          o.start(now); o.stop(now + 0.13);
        } else if (type === 'explosion') {
          o.type = 'sawtooth'; o.frequency.setValueAtTime(220, now);
          o.frequency.linearRampToValueAtTime(40, now + 0.25);
          g.gain.setValueAtTime(0.5, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
          o.start(now); o.stop(now + 0.36);
        } else if (type === 'capsule') {
          o.type = 'sine'; o.frequency.setValueAtTime(523, now);
          o.frequency.linearRampToValueAtTime(1046, now + 0.12);
          g.gain.setValueAtTime(0.35, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
          o.start(now); o.stop(now + 0.19);
        } else if (type === 'powerup') {
          o.type = 'square'; o.frequency.setValueAtTime(659, now);
          o.frequency.setValueAtTime(880, now + 0.1); o.frequency.setValueAtTime(1318, now + 0.2);
          g.gain.setValueAtTime(0.3, now); g.gain.linearRampToValueAtTime(0.001, now + 0.35);
          o.start(now); o.stop(now + 0.36);
        } else if (type === 'bossHit') {
          o.type = 'triangle'; o.frequency.setValueAtTime(110, now);
          o.frequency.linearRampToValueAtTime(55, now + 0.15);
          g.gain.setValueAtTime(0.45, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
          o.start(now); o.stop(now + 0.21);
        } else if (type === 'alarm') {
          o.type = 'square'; o.frequency.setValueAtTime(880, now);
          o.frequency.setValueAtTime(660, now + 0.15);
          g.gain.setValueAtTime(0.25, now); g.gain.linearRampToValueAtTime(0.001, now + 0.3);
          o.start(now); o.stop(now + 0.31);
        } else if (type === 'hit') {
          o.type = 'square'; o.frequency.setValueAtTime(180, now);
          o.frequency.exponentialRampToValueAtTime(40, now + 0.18);
          g.gain.setValueAtTime(0.4, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
          o.start(now); o.stop(now + 0.23);
        } else {
          o.type = 'sine'; o.frequency.setValueAtTime(440, now);
          g.gain.setValueAtTime(0.2, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
          o.start(now); o.stop(now + 0.11);
        }
      } catch (e) { /* 静默降级 */ }
    },
    /** BGM 简易循环 — 用定时器触发 alarm 节奏代替真实 BGM，首输入后启动 */
    _bgmTimer: null,
    startBgm: function (scene) {
      this.stopBgm();
      var self = this;
      // // TODO: 替换 BGM 时在此替换为 AudioBufferSource 循环
      this._bgmTimer = scene.time.addEvent({
        delay: 1800, loop: true, callback: function () {
          // 轻量节奏提示，不刷屏
          // 仅在非 Boss 时轻触发
          if (sceneRef && !sceneRef.bossActive) {
            // 不每周期都播，避免吵
          }
        }
      });
    },
    stopBgm: function () {
      if (this._bgmTimer) { try { this._bgmTimer.remove(false); } catch (e) {} this._bgmTimer = null; }
    }
  };

  // ---------------------------------------------------------------------------
  // 纹理生成 — 纯几何 Graphics
  // ---------------------------------------------------------------------------
  function buildTextures(scene) {
    var g;
    function rm(k) { if (scene.textures.exists(k)) { scene.textures.remove(k); } }

    // 玩家：飞机剪影多边形（机头尖、机翼后掠）
    rm('player');
    g = scene.add.graphics();
    g.fillStyle(0x7ec8ff, 1);
    // // 视觉占位：多边形飞机剪影 — 替换点：改为精灵贴图
    g.fillTriangle(28, 14, 0, 4, 0, 24);
    g.fillTriangle(28, 14, 10, 8, 10, 20);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(10, 14, 3);
    g.fillStyle(0x3a7bd5, 1);
    g.fillRect(4, 12, 8, 4);
    g.generateTexture('player', 30, 28);
    g.destroy();

    // Option 子机：小一号飞机，橙色
    rm('option');
    g = scene.add.graphics();
    g.fillStyle(0xffa726, 1);
    g.fillTriangle(22, 10, 0, 2, 0, 18);
    g.fillTriangle(22, 10, 8, 6, 8, 14);
    g.generateTexture('option', 24, 20);
    g.destroy();

    // 敌机0：红色三角 dart
    rm('enemy0');
    g = scene.add.graphics();
    g.fillStyle(0xef5350, 1);
    // 几何敌 — 大色块多边形
    g.fillTriangle(0, 14, 28, 6, 28, 22);
    g.fillStyle(0xffffff, 0.9);
    g.fillCircle(20, 14, 3);
    g.generateTexture('enemy0', 28, 28);
    g.destroy();

    // 敌机1：紫色菱形 + 翼
    rm('enemy1');
    g = scene.add.graphics();
    g.fillStyle(0xab47bc, 1);
    g.fillTriangle(14, 0, 28, 14, 14, 28);
    g.fillTriangle(14, 0, 0, 14, 14, 28);
    g.fillStyle(0xce93d8, 1);
    g.fillRect(12, 6, 4, 16);
    g.generateTexture('enemy1', 28, 28);
    g.destroy();

    // 敌机2：青色六边形重型
    rm('enemy2');
    g = scene.add.graphics();
    g.fillStyle(0x26c6da, 1);
    g.fillPoints([{x:10,y:4},{x:22,y:4},{x:30,y:14},{x:22,y:24},{x:10,y:24},{x:2,y:14}], true);
    g.fillStyle(0xb2ebf2, 1);
    g.fillCircle(16, 14, 4);
    g.generateTexture('enemy2', 32, 28);
    g.destroy();

    // 敌机3：黄色炮塔底座（地形炮塔用）
    rm('enemy3');
    g = scene.add.graphics();
    g.fillStyle(0xffd54f, 1);
    g.fillRect(0, 6, 28, 16);
    g.fillStyle(0x5d4037, 1);
    g.fillRect(8, 0, 12, 10);
    g.fillRect(12, 2, 16, 4);
    g.generateTexture('enemy3', 28, 28);
    g.destroy();

    // 玩家子弹：胶囊形状
    rm('bulletP');
    g = scene.add.graphics();
    g.fillStyle(0xfff176, 1);
    g.fillRoundedRect(0, 0, 14, 6, 3);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(10, 3, 2);
    g.generateTexture('bulletP', 14, 6);
    g.destroy();

    // 导弹：向下胶囊
    rm('missile');
    g = scene.add.graphics();
    g.fillStyle(0xff7043, 1);
    g.fillRoundedRect(0, 0, 6, 14, 3);
    g.generateTexture('missile', 6, 14);
    g.destroy();

    // 敌弹：小红圆
    rm('bulletE');
    g = scene.add.graphics();
    g.fillStyle(0xff5252, 1);
    g.fillCircle(4, 4, 4);
    g.fillStyle(0xff8a80, 1);
    g.fillCircle(4, 4, 2);
    g.generateTexture('bulletE', 8, 8);
    g.destroy();

    // 胶囊：蓝闪胶囊
    rm('capsule');
    g = scene.add.graphics();
    g.fillStyle(0x42a5f5, 1);
    g.fillRoundedRect(0, 0, 18, 18, 6);
    g.fillStyle(0xbbdefb, 1);
    g.fillRoundedRect(2, 2, 14, 6, 3);
    g.fillStyle(0x0d47a1, 1);
    g.fillCircle(9, 13, 3);
    g.generateTexture('capsule', 18, 18);
    g.destroy();

    // 地形上：大色块多边形岩石（上沿）
    rm('terrainTop');
    g = scene.add.graphics();
    g.fillStyle(0x5d4037, 1);
    g.fillPoints([{x:0,y:0},{x:96,y:0},{x:96,y:24},{x:72,y:36},{x:36,y:28},{x:0,y:32}], true);
    g.fillStyle(0x8d6e63, 1);
    g.fillRect(10, 6, 30, 8);
    g.generateTexture('terrainTop', 96, 36);
    g.destroy();

    rm('terrainBottom');
    g = scene.add.graphics();
    g.fillStyle(0x4e342e, 1);
    g.fillPoints([{x:0,y:36},{x:96,y:36},{x:96,y:4},{x:68,y:12},{x:32,y:6},{x:0,y:14}], true);
    g.fillStyle(0x795548, 1);
    g.fillRect(14, 16, 28, 10);
    g.generateTexture('terrainBottom', 96, 36);
    g.destroy();

    // 要塞地形（机械）
    rm('terrainFortTop');
    g = scene.add.graphics();
    g.fillStyle(0x37474f, 1);
    g.fillRect(0, 0, 96, 28);
    g.fillStyle(0x546e7a, 1);
    g.fillRect(0, 0, 96, 6);
    g.fillStyle(0x90a4ae, 1);
    g.fillRect(12, 10, 20, 8);
    g.fillRect(60, 12, 16, 6);
    g.generateTexture('terrainFortTop', 96, 28);
    g.destroy();

    rm('terrainFortBottom');
    g = scene.add.graphics();
    g.fillStyle(0x263238, 1);
    g.fillRect(0, 8, 96, 28);
    g.fillStyle(0x455a64, 1);
    g.fillRect(0, 30, 96, 6);
    g.fillStyle(0x78909c, 1);
    g.fillRect(18, 14, 22, 8);
    g.generateTexture('terrainFortBottom', 96, 36);
    g.destroy();

    // Boss 核心
    rm('bossCore');
    g = scene.add.graphics();
    g.fillStyle(0x263238, 1);
    g.fillRect(0, 0, 90, 70);
    g.fillStyle(0xef5350, 1);
    g.fillCircle(45, 35, 18);
    g.fillStyle(0xff8a80, 1);
    g.fillCircle(45, 35, 10);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(42, 30, 3);
    g.generateTexture('bossCore', 90, 70);
    g.destroy();

    rm('bossHull');
    g = scene.add.graphics();
    g.fillStyle(0x455a64, 1);
    g.fillRect(0, 10, 80, 50);
    g.fillTriangle(80, 10, 110, 35, 80, 60);
    g.fillStyle(0x78909c, 1);
    g.fillRect(10, 18, 30, 8);
    g.fillRect(10, 44, 30, 8);
    g.generateTexture('bossHull', 110, 70);
    g.destroy();

    // 爆炸帧（4帧 扩散圆）
    for (var f = 0; f < 4; f++) {
      var k = 'explosion' + f;
      rm(k);
      g = scene.add.graphics();
      var r = 6 + f * 9;
      var alpha = 1 - f * 0.18;
      g.fillStyle(0xffeb3b, alpha);
      g.fillCircle(16, 16, r);
      g.fillStyle(0xff5722, alpha * 0.9);
      g.fillCircle(16, 16, r * 0.6);
      g.fillStyle(0xffffff, alpha);
      g.fillCircle(16 - f, 16 - f, 3);
      g.generateTexture(k, 32, 32);
      g.destroy();
    }

    // 1x1 白点
    rm('panel');
    g = scene.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 1, 1);
    g.generateTexture('panel', 1, 1);
    g.destroy();
  }

  // ---------------------------------------------------------------------------
  // 存档 I/O
  // ---------------------------------------------------------------------------
  function loadPersist() {
    if (!hostRef || typeof hostRef.loadState !== 'function') { return Promise.resolve(null); }
    try { return hostRef.loadState().then(function (d) { return d; }, function () { return null; }); }
    catch (e) { return Promise.resolve(null); }
  }
  function savePersist() {
    if (!hostRef || typeof hostRef.saveState !== 'function') { return; }
    try { hostRef.saveState({ hiScore: hiScore, reachedStage: reachedStage }).then(function () {}, function () {}); } catch (e) {}
  }

  function getState() {
    var s = sceneRef;
    if (!s) { return { scene: 'menu', stage: reachedStage, score: 0, lives: 3, powerups: [], bossHp: 0 }; }
    // powerups 展示已激活的能量名
    var act = [];
    for (var i = 0; i < POWER_NAMES.length; i++) { if (s.powerActive[i]) { act.push(POWER_NAMES[i]); } }
    var bHp = 0;
    if (s.boss && s.boss.active) { bHp = s.boss.hp; }
    return { scene: s.scene.key, stage: s.stage, score: s.score, lives: s.lives, powerups: act, bossHp: bHp };
  }

  // ---------------------------------------------------------------------------
  // launch
  // ---------------------------------------------------------------------------
  function launch(host) {
    var Phaser = host.phaser;
    hostRef = host;

    // ------------------------------------------------ Boot
    var BootScene = class extends Phaser.Scene {
      constructor() { super({ key: 'boot' }); }
      create() {
        buildTextures(this);
        var self = this;
        loadPersist().then(function (data) {
          if (data) {
            if (typeof data.hiScore === 'number') { hiScore = data.hiScore; }
            if (typeof data.reachedStage === 'number') { reachedStage = data.reachedStage; }
          }
          self.scene.start('menu');
        }).catch(function () { self.scene.start('menu'); });
      }
    };

    // ------------------------------------------------ Menu
    var MenuScene = class extends Phaser.Scene {
      constructor() { super({ key: 'menu' }); }
      create() {
        var w = this.cameras.main.width, h = this.cameras.main.height;
        this.add.text(w / 2, h * 0.22, '横版突击 GRADIUS', { fontFamily: 'monospace', fontSize: '26px', color: '#e3f2fd' }).setOrigin(0.5);
        this.add.text(w / 2, h * 0.22 + 28, 'STG-HORIZONTAL  v0.1.0', { fontFamily: 'monospace', fontSize: '11px', color: '#90a4ae' }).setOrigin(0.5);
        this.add.text(w / 2, h * 0.38, 'Hi-Score: ' + hiScore + '   Reached: Stage ' + reachedStage, { fontFamily: 'monospace', fontSize: '12px', color: '#b0bec5' }).setOrigin(0.5);
        var btn = this.add.text(w / 2, h * 0.56, '  START ▶  ', { fontFamily: 'monospace', fontSize: '18px', color: '#fff', backgroundColor: '#1565c0', padding: { x: 18, y: 10 } }).setOrigin(0.5).setInteractive({ useHandCursor: true });
        var self = this;
        btn.on('pointerdown', function () { Sfx._resume(); self.scene.start('play'); });
        this.add.text(w / 2, h * 0.70, 'WASD/方向键 8向移动 · 空格/J 按住射击 · X 激活能量', { fontFamily: 'monospace', fontSize: '11px', color: '#90a4ae', align: 'center' }).setOrigin(0.5);
        this.add.text(w / 2, h * 0.74, '击坠5架编队掉胶囊 · 拾取光标进格 · R 重开 · ESC 暂停', { fontFamily: 'monospace', fontSize: '11px', color: '#90a4ae', align: 'center' }).setOrigin(0.5);
        this.add.text(w / 2, h - 14, 'ENTER 亦可开始', { fontFamily: 'monospace', fontSize: '10px', color: '#455a64' }).setOrigin(0.5);
        this._enter = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
        this._space = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
      }
      update() {
        if (Phaser.Input.Keyboard.JustDown(this._enter) || Phaser.Input.Keyboard.JustDown(this._space)) { Sfx._resume(); this.scene.start('play'); }
      }
    };

    // ------------------------------------------------ Play
    var PlayScene = class extends Phaser.Scene {
      constructor() { super({ key: 'play' }); }
      create() {
        sceneRef = this;
        try { this.physics.world.gravity.y = 0; } catch (e) {}
        this.w = this.cameras.main.width;
        this.h = this.cameras.main.height;

        // 关卡与分数
        this.stage = 1;
        this.score = 0;
        this.lives = 3;
        this.over = false;
        this.clearing = false;
        this.bossActive = false;
        this.stageTime = 0;
        this.stageDuration = 38000; // Stage1 时长 ms
        this.invincibleUntil = 0;
        this._paused = false;

        // 能量系统
        this.caps = 0; // 已拾取未消耗胶囊数（光标位置）
        this.cursorIdx = -1; // -1 无高亮，否则 0..5
        this.powerActive = [false, false, false, false, false, false];
        this.speedLevel = 0;
        this.shieldHp = 0; // 护盾抵挡次数
        this.optionCount = 0;

        buildTextures(this);
        Sfx.startBgm(this);

        // 玩家
        this.player = this.physics.add.sprite(90, this.h / 2, 'player');
        this.player.setDepth(12);
        try { this.player.body.setSize(22, 14); } catch (e) {}
        this.player.setCollideWorldBounds(false);

        // Option 子机组
        this.options = [];
        this.trail = []; // 最近 N 帧位置历史队列 [{x,y}]
        for (var oi = 0; oi < OPTION_MAX; oi++) {
          var op = this.physics.add.sprite(-100, -100, 'option');
          op.setDepth(11); op.setVisible(false);
          try { op.body.setSize(18, 12); } catch (e2) {}
          this.options.push(op);
        }

        // 分组（池化）
        this.enemies = this.physics.add.group();
        this.bulletsP = this.physics.add.group();
        this.bulletsE = this.physics.add.group();
        this.capsules = this.physics.add.group();
        this.terrains = this.physics.add.group();
        this.explosions = this.add.group();

        // 预创建子弹池 40+20
        for (var bi = 0; bi < 40; bi++) {
          var bp = this.physics.add.sprite(-100, -100, 'bulletP');
          bp.setActive(false).setVisible(false);
          try { bp.body.setSize(10, 4); } catch (e3) {}
          this.bulletsP.add(bp);
        }
        for (var ei = 0; ei < 24; ei++) {
          var be = this.physics.add.sprite(-100, -100, 'bulletE');
          be.setActive(false).setVisible(false);
          try { be.body.setSize(6, 6); } catch (e4) {}
          this.bulletsE.add(be);
        }
        // 爆炸池
        this.explosionPool = [];
        for (var xi = 0; xi < EXPLOSION_POOL; xi++) {
          var ex = this.add.sprite(-100, -100, 'explosion0');
          ex.setVisible(false).setDepth(20);
          this.explosionPool.push(ex);
        }

        // 编队追踪：整波5架击坠才掉胶囊
        this.formations = []; // {id, remaining, total, xs:[], ys:[]}
        this.nextFormationId = 1;

        // 地形与编队计时器（可用 time.addEvent）
        this.time.addEvent({ delay: TERRAIN_INTERVAL, loop: true, callback: this.spawnTerrain, callbackScope: this });
        this.time.addEvent({ delay: FORMATION_INTERVAL, loop: true, callback: this.spawnFormation, callbackScope: this });
        this.time.addEvent({ delay: 900, loop: true, callback: this.enemyShoot, callbackScope: this });

        // 碰撞 — overlap 参数顺序无关（contains 判断）
        this.physics.add.overlap(this.bulletsP, this.enemies, this.onBulletHitEnemy, null, this);
        this.physics.add.overlap(this.bulletsP, this.terrains, this.onBulletHitTerrain, null, this);
        this.physics.add.overlap(this.player, this.capsules, this.onPlayerCapsule, null, this);
        this.physics.add.overlap(this.player, this.enemies, this.onPlayerHit, null, this);
        this.physics.add.overlap(this.player, this.bulletsE, this.onPlayerHitByBullet, null, this);
        this.physics.add.overlap(this.player, this.terrains, this.onPlayerHitTerrain, null, this);
        // 子机也可撞敌（子机无敌但可消灭）
        // Boss 碰撞在 boss 生成后追加

        // 输入
        this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,X,SHIFT');
        this.keyJ = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.J);
        this.keyR = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
        this.keyM = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M);
        this.keyESC = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
        this.input.keyboard.on('keydown', function () { Sfx._resume(); });

        // HUD
        this.hudScore = this.add.text(8, 6, '', { fontFamily: 'monospace', fontSize: '13px', color: '#e3f2fd' }).setDepth(50);
        this.hudStage = this.add.text(this.w - 8, 6, '', { fontFamily: 'monospace', fontSize: '11px', color: '#90a4ae' }).setOrigin(1, 0).setDepth(50);
        this.bossHpBg = this.add.sprite(this.w / 2, 16, 'panel').setOrigin(0.5, 0.5).setDisplaySize(160, 8).setTint(0x263238).setDepth(50).setVisible(false);
        this.bossHpBar = this.add.sprite(this.w / 2 - 80, 16, 'panel').setOrigin(0, 0.5).setDisplaySize(160, 8).setTint(0xef5350).setDepth(51).setVisible(false);
        // 能量条 — 底部 6 格
        this.powerBg = this.add.graphics().setDepth(50);
        this.powerTexts = [];
        var barW = Math.min(420, this.w - 20);
        var segW = barW / 6;
        var barX = (this.w - barW) / 2;
        var barY = this.h - 22;
        this._barX = barX; this._barY = barY; this._segW = segW; this._barW = barW;
        for (var pi = 0; pi < 6; pi++) {
          var tx = this.add.text(barX + segW * pi + segW / 2, barY + 9, POWER_NAMES[pi], { fontFamily: 'monospace', fontSize: '8px', color: '#90a4ae', align: 'center' }).setOrigin(0.5).setDepth(51);
          this.powerTexts.push(tx);
        }
        this.powerBoxes = this.add.graphics().setDepth(51);
        // 提示文字
        this.tipText = this.add.text(this.w / 2, this.h - 38, '', { fontFamily: 'monospace', fontSize: '10px', color: '#ffd54f', align: 'center' }).setOrigin(0.5).setDepth(52);

        // 初始地形铺垫
        for (var ti = 0; ti < 4; ti++) { this.spawnTerrain(true); }

        this._fireCooldown = 0;
        this._stageAnnounced = false;
        this.updateHud();
        this.showStageBanner(1);
      }

      // ---------------------------------------------------------------------
      // HUD 与能量条渲染
      // ---------------------------------------------------------------------
      updateHud() {
        this.hudScore.setText('SCORE ' + this.score + '  HI ' + hiScore + '  ♥ ' + this.lives);
        this.hudStage.setText('STAGE ' + this.stage + (this.bossActive ? '  BOSS!' : ''));
        // 能量条高亮：cursorIdx 为当前光标格，caps 决定是否可激活（caps > cursorIdx）
        var g = this.powerBoxes;
        g.clear();
        for (var i = 0; i < 6; i++) {
          var x = this._barX + this._segW * i;
          var y = this._barY;
          var isCursor = (i === this.cursorIdx);
          var canActive = this.caps > i; // 已有足够胶囊点亮到该格
          var active = this.powerActive[i];
          if (active) {
            g.fillStyle(0x00e676, 1); g.fillRect(x + 1, y + 1, this._segW - 2, 16);
            this.powerTexts[i].setColor('#0d1117');
          } else if (isCursor && canActive) {
            // 闪烁高亮（时间驱动）
            var blink = (Math.floor(this.time.now / 180) % 2 === 0);
            g.fillStyle(blink ? 0xffeb3b : 0xffa000, 1); g.fillRect(x + 1, y + 1, this._segW - 2, 16);
            this.powerTexts[i].setColor('#0d1117');
          } else if (canActive) {
            g.fillStyle(0x37474f, 1); g.fillRect(x + 1, y + 1, this._segW - 2, 16);
            this.powerTexts[i].setColor('#e3f2fd');
          } else {
            g.fillStyle(0x263238, 1); g.fillRect(x + 1, y + 1, this._segW - 2, 16);
            g.lineStyle(1, 0x37474f, 1); g.strokeRect(x + 1, y + 1, this._segW - 2, 16);
            this.powerTexts[i].setColor('#546e7a');
          }
        }
        // Boss 血条
        if (this.bossActive && this.boss) {
          var pct = clamp(this.boss.hp / this.boss.maxHp, 0, 1);
          this.bossHpBg.setVisible(true); this.bossHpBar.setVisible(true);
          this.bossHpBar.setDisplaySize(160 * pct, 8);
        } else {
          this.bossHpBg.setVisible(false); this.bossHpBar.setVisible(false);
        }
      }

      showStageBanner(n) {
        var t = this.add.text(this.w / 2, this.h / 2 - 30, 'STAGE ' + n, { fontFamily: 'monospace', fontSize: '22px', color: '#ffd54f', align: 'center', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(60);
        var sub = this.add.text(this.w / 2, this.h / 2, n === 1 ? '— 岩窟地带 —' : '— 要塞突入 —', { fontFamily: 'monospace', fontSize: '12px', color: '#b0bec5' }).setOrigin(0.5).setDepth(60);
        this.tweens.add({ targets: [t, sub], alpha: 0, duration: 900, delay: 1400, onComplete: function () { t.destroy(); sub.destroy(); } });
        Sfx.play('alarm');
      }

      showTip(msg) {
        this.tipText.setText(msg);
        this.time.delayedCall(1600, function () { if (this.tipText) { this.tipText.setText(''); } }, [], this);
      }

      // ---------------------------------------------------------------------
      // 池化取弹
      // ---------------------------------------------------------------------
      allocBulletP() {
        var b = this.bulletsP.getFirstDead(false);
        if (!b) {
          // 池耗尽则复用最老的活跃弹
          var alive = this.bulletsP.getChildren().filter(function (c) { return c.active; });
          if (alive.length === 0) { return null; }
          b = alive[0];
        }
        b.setActive(true).setVisible(true);
        return b;
      }
      allocBulletE() {
        var b = this.bulletsE.getFirstDead(false);
        if (!b) {
          var alive = this.bulletsE.getChildren().filter(function (c) { return c.active; });
          if (alive.length === 0) { return null; }
          b = alive[0];
        }
        b.setActive(true).setVisible(true);
        return b;
      }
      firePlayer() {
        var y = this.player.y;
        var x = this.player.x + 16;
        // 基础单发
        var b = this.allocBulletP();
        if (b) {
          try { b.body.reset(x, y); } catch (e) { b.x = x; b.y = y; }
          b.setVelocity(SCROLL_SPEED * 0.15 + BULLET_SPEED, 0);
          b._isMissile = false;
          Sfx.play('shoot');
        }
        // DOUBLE：上下双发
        if (this.powerActive[2]) {
          var b2 = this.allocBulletP(); var b3 = this.allocBulletP();
          if (b2) { try { b2.body.reset(x, y - 8); } catch (e2) { b2.x = x; b2.y = y - 8; } b2.setVelocity(SCROLL_SPEED * 0.1 + BULLET_SPEED, -60); b2._isMissile = false; }
          if (b3) { try { b3.body.reset(x, y + 8); } catch (e3) { b3.x = x; b3.y = y + 8; } b3.setVelocity(SCROLL_SPEED * 0.1 + BULLET_SPEED, 60); b3._isMissile = false; }
        }
        // LASER：更长更快（复用同池，仅速度区分）
        if (this.powerActive[3]) {
          var bl = this.allocBulletP();
          if (bl) { try { bl.body.reset(x + 6, y); } catch (e4) { bl.x = x + 6; bl.y = y; } bl.setVelocity(SCROLL_SPEED * 0.15 + BULLET_SPEED + 120, 0); bl.setTint(0x00e5ff); bl._isMissile = false; }
        }
        // MISSILE：向下导弹（独立贴图）
        if (this.powerActive[1]) {
          var m = this.allocBulletP();
          if (m) {
            try { m.body.reset(x - 4, y + 10); } catch (e5) { m.x = x - 4; m.y = y + 10; }
            m.setTexture('missile'); m._isMissile = true;
            m.setVelocity(SCROLL_SPEED * 0.2 + 260, 220);
          }
        }
        // Option 子机同步射击
        for (var oi = 0; oi < this.optionCount; oi++) {
          var op = this.options[oi];
          if (!op.visible) { continue; }
          var ob = this.allocBulletP();
          if (ob) {
            try { ob.body.reset(op.x + 12, op.y); } catch (e6) { ob.x = op.x + 12; ob.y = op.y; }
            ob.setTexture('bulletP'); ob.clearTint(); ob._isMissile = false;
            ob.setVelocity(SCROLL_SPEED * 0.15 + BULLET_SPEED, 0);
          }
        }
        // 若发射了导弹，下次普通弹需还原贴图由碰撞/越界时还原
      }

      spawnExplosion(x, y) {
        var s = null;
        for (var i = 0; i < this.explosionPool.length; i++) { if (!this.explosionPool[i].visible) { s = this.explosionPool[i]; break; } }
        if (!s) { s = this.add.sprite(x, y, 'explosion0').setDepth(20); this.explosionPool.push(s); }
        s.setPosition(x, y).setVisible(true).setAlpha(1).setScale(1);
        s.playAnim = 0;
        var self = this;
        // 扩散圆爆炸：4帧切换
        var frames = ['explosion0', 'explosion1', 'explosion2', 'explosion3'];
        var idx = 0;
        var ev = this.time.addEvent({
          delay: 55, loop: true, callback: function () {
            idx++;
            if (idx >= frames.length) { ev.remove(false); s.setVisible(false); return; }
            try { s.setTexture(frames[idx]); } catch (e) {}
            s.setScale(1 + idx * 0.22);
            s.setAlpha(1 - idx * 0.18);
          }
        });
        Sfx.play('explosion');
      }

      // ---------------------------------------------------------------------
      // 地形生成 — 随卷轴左移，上下岩石
      // ---------------------------------------------------------------------
      spawnTerrain(initial) {
        if (this.over || this._paused) { return; }
        if (this.bossActive) { return; }
        var x = initial ? randInt(0, this.w) : this.w + 48;
        var isFort = (this.stage === 2);
        // 随机高度：保证中间至少留 110px 通道
        var topH = isFort ? 28 : randInt(18, 36);
        var botH = isFort ? 36 : randInt(18, 36);
        // 上岩石
        var topKey = isFort ? 'terrainFortTop' : 'terrainTop';
        var top = this.physics.add.sprite(x, topH / 2, topKey);
        top.setDepth(4);
        top._isTerrain = true;
        try { top.body.setSize(96, topH); } catch (e) {}
        top.body.setAllowGravity(false);
        top.body.setImmovable(true);
        top.setVelocityX(-SCROLL_SPEED);
        this.terrains.add(top);
        // 下岩石
        var botKey = isFort ? 'terrainFortBottom' : 'terrainBottom';
        var bh = botH;
        var bot = this.physics.add.sprite(x, this.h - bh / 2, botKey);
        bot.setDepth(4);
        bot._isTerrain = true;
        try { bot.body.setSize(96, bh); } catch (e2) {}
        bot.body.setAllowGravity(false);
        bot.body.setImmovable(true);
        bot.setVelocityX(-SCROLL_SPEED);
        this.terrains.add(bot);
        // 要塞阶段概率加炮塔
        if (isFort && Math.random() < 0.42 && !initial) {
          var turret = this.physics.add.sprite(x, this.h - bh - 16, 'enemy3');
          turret.setDepth(6);
          turret._type = 3; turret._hp = 3; turret._isTurret = true;
          try { turret.body.setSize(22, 18); } catch (e3) {}
          turret.body.setAllowGravity(false);
          turret.setVelocityX(-SCROLL_SPEED);
          this.enemies.add(turret);
        }
      }

      // ---------------------------------------------------------------------
      // 敌机类型与编队
      //   type0 dart 直线 type1 菱形 正弦 type2 重型 慢速 type3 炮塔 固定
      // ---------------------------------------------------------------------
      makeEnemy(x, y, type, formationId) {
        var key = type === 0 ? 'enemy0' : type === 1 ? 'enemy1' : type === 2 ? 'enemy2' : 'enemy3';
        var e = this.physics.add.sprite(x, y, key);
        e.setDepth(8);
        e._type = type; e._hp = type === 2 ? 3 : type === 3 ? 3 : 1;
        e._formationId = formationId || 0;
        e._phase = Math.random() * Math.PI * 2;
        try { e.body.setSize(22, 20); } catch (err) {}
        e.body.setAllowGravity(false);
        // 基础左移 + 类型特定速度
        var vx = -SCROLL_SPEED - (type === 0 ? 90 : type === 1 ? 60 : type === 2 ? 35 : 0);
        e.setVelocityX(vx);
        if (type === 1) { e.setVelocityY(randInt(-40, 40)); }
        this.enemies.add(e);
        return e;
      }

      spawnFormation() {
        if (this.over || this._paused || this.bossActive) { return; }
        var fid = this.nextFormationId++;
        var type = randInt(0, 2); // 0-2 为编队主力
        var pattern = randInt(0, 3);
        var baseY = randInt(48, this.h - 80);
        var sx = this.w + 30;
        var members = [];
        // // 视觉占位：编队生成器 — 5架一组
        if (pattern === 0) {
          // V字
          members.push([sx, baseY]);
          members.push([sx + 28, baseY - 26]); members.push([sx + 28, baseY + 26]);
          members.push([sx + 56, baseY - 44]); members.push([sx + 56, baseY + 44]);
        } else if (pattern === 1) {
          // 横线
          for (var i2 = 0; i2 < 5; i2++) { members.push([sx + i2 * 32, baseY + randInt(-10, 10)]); }
        } else if (pattern === 2) {
          // 波浪对角
          for (var i3 = 0; i3 < 5; i3++) { members.push([sx + i3 * 24, baseY + (i3 - 2) * 18]); }
        } else {
          // 箭头
          members.push([sx + 40, baseY]);
          members.push([sx, baseY - 18]); members.push([sx, baseY + 18]);
          members.push([sx + 20, baseY - 36]); members.push([sx + 20, baseY + 36]);
        }
        // Stage2 混入重型比例提升
        if (this.stage === 2 && Math.random() < 0.35) { type = 2; }
        for (var mi = 0; mi < members.length; mi++) { this.makeEnemy(members[mi][0], members[mi][1], type, fid); }
        this.formations.push({ id: fid, remaining: 5, total: 5 });
      }

      enemyShoot() {
        if (this.over || this._paused || this.bossActive) { return; }
        var list = this.enemies.getChildren();
        if (list.length === 0) { return; }
        // 随机挑 1-2 个可射击敌
        var shooters = [];
        for (var i = 0; i < list.length; i++) {
          var en = list[i];
          if (en._type === 3 || en._type === 2 || Math.random() < 0.25) { shooters.push(en); }
          if (shooters.length >= 2) { break; }
        }
        for (var si = 0; si < shooters.length; si++) {
          var s = shooters[si];
          if (s.x < -20 || s.x > this.w + 20) { continue; }
          var b = this.allocBulletE();
          if (!b) { continue; }
          try { b.body.reset(s.x - 10, s.y); } catch (e) { b.x = s.x - 10; b.y = s.y; }
          b.setTexture('bulletE'); b.clearTint();
          if (s._type === 3) {
            // 炮塔瞄准玩家
            var ang = Math.atan2(this.player.y - s.y, this.player.x - s.x);
            b.setVelocity(Math.cos(ang) * ENEMY_BULLET_SPEED, Math.sin(ang) * ENEMY_BULLET_SPEED);
          } else {
            b.setVelocity(-ENEMY_BULLET_SPEED - SCROLL_SPEED * 0.3, randInt(-30, 30));
          }
        }
      }

      // ---------------------------------------------------------------------
      // 胶囊与能量激活
      // ---------------------------------------------------------------------
      dropCapsule(x, y) {
        var c = this.physics.add.sprite(x, y, 'capsule');
        c.setDepth(9);
        try { c.body.setSize(16, 16); } catch (e) {}
        c.body.setAllowGravity(false);
        c.setVelocityX(-SCROLL_SPEED * 0.7);
        c.setVelocityY(CAPSULE_SPEED * 0.3);
        this.capsules.add(c);
        // 轻微浮动
        this.tweens.add({ targets: c, y: y + 10, duration: 500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      }

      refreshCursor() {
        if (this.caps <= 0) { this.cursorIdx = -1; }
        else if (this.caps >= 6) { this.cursorIdx = 5; }
        else { this.cursorIdx = this.caps - 1; }
      }

      tryActivatePower() {
        if (this.caps <= 0 || this.cursorIdx < 0) { return; }
        var idx = this.cursorIdx;
        var cost = POWER_COST[idx];
        if (this.caps < cost) {
          this.showTip('能量不足 需要 ' + cost + ' 胶囊');
          return;
        }
        // 已激活的 SPEED/OPTION 可叠加，其余重复激活给予分数
        if (this.powerActive[idx] && idx !== 0 && idx !== 4) {
          this.score += 500;
          this.showTip(POWER_NAMES[idx] + ' 已激活 +500');
          this.caps -= cost;
          this.refreshCursor(); this.updateHud();
          Sfx.play('powerup');
          return;
        }
        this.caps -= cost;
        // 若为一次性消耗后重置光标由 refreshCursor 处理
        if (idx === 0) {
          // SPEED UP
          if (this.speedLevel < SPEED_MAX) {
            this.speedLevel++;
            this.powerActive[0] = true;
            this.showTip('SPEED UP! 速度提升');
          } else { this.showTip('已达最大速度'); }
        } else if (idx === 1) {
          this.powerActive[1] = true; this.showTip('MISSILE 装备!');
        } else if (idx === 2) {
          this.powerActive[2] = true; this.showTip('DOUBLE 双向射击!');
        } else if (idx === 3) {
          this.powerActive[3] = true; this.showTip('LASER 激光!');
        } else if (idx === 4) {
          if (this.optionCount < OPTION_MAX) {
            this.optionCount++;
            for (var oi2 = 0; oi2 < this.optionCount; oi2++) { this.options[oi2].setVisible(true); }
            this.powerActive[4] = true;
            this.showTip('OPTION 子机 +' + this.optionCount);
          } else { this.showTip('子机已满'); }
        } else if (idx === 5) {
          this.powerActive[5] = true;
          this.shieldHp = 2;
          this.showTip('SHIELD 护盾!');
          this.player.setTint(0x80cbc4);
        }
        this.refreshCursor(); this.updateHud();
        Sfx.play('powerup');
      }

      // ---------------------------------------------------------------------
      // 碰撞回调（均 contains 判断，overlap 参数顺序无关）
      // ---------------------------------------------------------------------
      onBulletHitEnemy(a, b) {
        var bullet = this.bulletsP.contains(a) ? a : b;
        var enemy = this.enemies.contains(a) ? a : b;
        if (!bullet.active || !enemy.active) { return; }
        // 导弹贴图还原标记
        var wasMissile = bullet._isMissile;
        // 回池而非 destroy（池化）
        bullet.setActive(false).setVisible(false);
        bullet.setVelocity(0, 0);
        try { bullet.body.reset(-100, -100); } catch (e2) {}
        if (wasMissile) { try { bullet.setTexture('bulletP'); } catch (e3) {} bullet.clearTint(); }
        else { bullet.clearTint(); }
        // Boss 命中单独处理
        if (enemy._isBoss) { this.hitBoss(enemy, 1); return; }
        if (enemy._isBossPart) { this.hitBossPart(enemy, 1); return; }
        enemy._hp -= 1;
        if (enemy._hp > 0) {
          // 闪烁反馈
          enemy.setTint(0xffffff);
          this.time.delayedCall(60, function () { if (enemy.active) { enemy.clearTint(); } });
          return;
        }
        // 击坠
        var ex = enemy.x, ey = enemy.y, fid = enemy._formationId;
        this.spawnExplosion(ex, ey);
        this.score += enemy._type === 2 ? 300 : 100;
        if (enemy._isTurret) { this.score += 50; }
        try { enemy.destroy(); } catch (e4) {}
        hiScore = Math.max(hiScore, this.score);
        // 编队计数 — 整波击坠掉胶囊
        if (fid) {
          for (var fi = 0; fi < this.formations.length; fi++) {
            if (this.formations[fi].id === fid) {
              this.formations[fi].remaining -= 1;
              if (this.formations[fi].remaining <= 0) {
                this.dropCapsule(ex, ey);
                this.formations.splice(fi, 1);
              }
              break;
            }
          }
        } else {
          // 非编队敌小概率掉胶囊
          if (Math.random() < 0.08) { this.dropCapsule(ex, ey); }
        }
      }

      onBulletHitTerrain(a, b) {
        var bullet = this.bulletsP.contains(a) ? a : this.bulletsP.contains(b) ? b : a;
        if (!bullet || !bullet.active) { return; }
        var wasM = bullet._isMissile;
        bullet.setActive(false).setVisible(false);
        bullet.setVelocity(0, 0);
        try { bullet.body.reset(-100, -100); } catch (e) {}
        if (wasM) { try { bullet.setTexture('bulletP'); } catch (e2) {} bullet.clearTint(); }
      }

      onPlayerCapsule(a, b) {
        var cap = this.capsules.contains(a) ? a : b;
        // player 可能是 a 或 b — contains 已区分
        if (!cap.active) { return; }
        try { cap.destroy(); } catch (e) {}
        this.caps = Math.min(6, this.caps + 1);
        this.refreshCursor(); this.updateHud();
        Sfx.play('capsule');
        this.showTip('胶囊 +' + this.caps + '  按 X 激活 [' + (this.cursorIdx >= 0 ? POWER_NAMES[this.cursorIdx] : '-') + ']');
      }

      onPlayerHit(a, b) {
        var enemy = this.enemies.contains(a) ? a : this.enemies.contains(b) ? b : null;
        // Boss 部件亦在此
        if (!enemy) { enemy = (a === this.player ? b : a); }
        this.damagePlayer(enemy);
      }

      onPlayerHitByBullet(a, b) {
        var bullet = this.bulletsE.contains(a) ? a : this.bulletsE.contains(b) ? b : null;
        if (!bullet) { bullet = (a === this.player ? b : a); }
        if (!bullet || !bullet.active) { return; }
        bullet.setActive(false).setVisible(false);
        bullet.setVelocity(0, 0);
        try { bullet.body.reset(-100, -100); } catch (e) {}
        this.damagePlayer(bullet);
      }

      onPlayerHitTerrain(a, b) {
        var terr = this.terrains.contains(a) ? a : this.terrains.contains(b) ? b : null;
        if (!terr) { terr = (a === this.player ? b : a); }
        this.damagePlayer(terr);
      }

      damagePlayer(source) {
        if (this.over) { return; }
        if (this.time.now < this.invincibleUntil) { return; }
        if (this.shieldHp > 0) {
          this.shieldHp -= 1;
          this.spawnExplosion(this.player.x, this.player.y);
          Sfx.play('hit');
          this.invincibleUntil = this.time.now + 400;
          this.player.setAlpha(0.6);
          this.time.delayedCall(400, function () { if (!this.over) { this.player.setAlpha(1); } }, [], this);
          if (this.shieldHp <= 0) { this.powerActive[5] = false; this.player.clearTint(); this.showTip('护盾破碎'); }
          else { this.showTip('护盾抵挡 ' + this.shieldHp + ' 剩余'); }
          this.updateHud();
          // 撞地形不销毁地形，撞敌机则销毁敌
          if (source && source._type !== undefined && !source._isTerrain) {
            try { source.destroy(); } catch (e) {}
            this.spawnExplosion(source.x, source.y);
          }
          return;
        }
        // 掉命
        try { if (source && source._type !== undefined && !source._isTerrain && source.active) { source.destroy(); } } catch (e2) {}
        if (source && source.active && source._isTerrain) {
          // 撞地形：不销毁地形，仅掉命并击退
        }
        this.lives -= 1;
        Sfx.play('hit');
        this.spawnExplosion(this.player.x, this.player.y);
        if (this.lives <= 0) {
          this.lives = 0;
          this.gameOver();
          return;
        }
        // 重生无敌 + 掉部分能力（Gradius 式全掉，此处仅掉护盾与速度保留1级）
        this.invincibleUntil = this.time.now + INVINCIBLE_MS;
        this.player.setAlpha(0.45);
        // 掉一些能力：DOUBLE/LASER/MISSILE 掉，OPTION 掉一个
        if (this.powerActive[2] || this.powerActive[3]) { this.powerActive[2] = false; this.powerActive[3] = false; }
        if (this.optionCount > 0) {
          this.options[this.optionCount - 1].setVisible(false);
          try { this.options[this.optionCount - 1].body.reset(-100, -100); } catch (e3) {}
          this.optionCount -= 1;
          if (this.optionCount === 0) { this.powerActive[4] = false; }
        }
        // 轻微回退
        try { this.player.body.reset(90, this.h / 2); } catch (e4) { this.player.x = 90; this.player.y = this.h / 2; }
        this.trail = [];
        this.updateHud();
        this.showTip('被击中! 剩余 ' + this.lives + ' 机');
      }

      // ---------------------------------------------------------------------
      // Boss 系统
      // ---------------------------------------------------------------------
      spawnBoss() {
        this.bossActive = true;
        Sfx.play('alarm');
        this.showTip(this.stage === 1 ? '警告：岩窟核心出现!' : '警告：要塞核心出现!');
        var y = this.h / 2;
        var x = this.w + 60;
        if (this.stage === 1) {
          // Stage1 Boss：大船 + 核心多阶段（先打两侧炮塔再打核心）
          var hull = this.physics.add.sprite(x, y, 'bossHull');
          hull.setDepth(7); hull._isBoss = true; hull._isBossPart = false;
          hull.hp = 60; hull.maxHp = 60; hull._phase = 0;
          try { hull.body.setSize(80, 50); } catch (e) {}
          hull.body.setAllowGravity(false); hull.setVelocityX(-40);
          this.enemies.add(hull);
          this.boss = hull;
          // 两侧炮塔（Boss部件）
          var t1 = this.physics.add.sprite(x - 18, y - 18, 'enemy3');
          var t2 = this.physics.add.sprite(x - 18, y + 18, 'enemy3');
          [t1, t2].forEach(function (t) {
            t.setDepth(8); t._isBossPart = true; t._parentBoss = hull; t._hp = 10;
            try { t.body.setSize(20, 16); } catch (e2) {}
            t.body.setAllowGravity(false); t.setVelocityX(-40);
          });
          this.enemies.add(t1); this.enemies.add(t2);
          hull._turrets = [t1, t2];
          // 碰撞：Boss部件与玩家/子弹已通过 enemies 组覆盖
          this.bossDir = 1;
        } else {
          // Stage2 Boss：要塞核心 + 4炮塔环绕，更高血量
          var core = this.physics.add.sprite(x, y, 'bossCore');
          core.setDepth(7); core._isBoss = true; core.hp = 90; core.maxHp = 90;
          try { core.body.setSize(60, 50); } catch (e3) {}
          core.body.setAllowGravity(false); core.setVelocityX(-35);
          this.enemies.add(core);
          this.boss = core;
          var turrets = [];
          var offs = [[-36, -24], [-36, 24], [22, -26], [22, 26]];
          for (var ti2 = 0; ti2 < 4; ti2++) {
            var tt = this.physics.add.sprite(x + offs[ti2][0], y + offs[ti2][1], 'enemy3');
            tt.setDepth(8); tt._isBossPart = true; tt._parentBoss = core; tt._hp = 12;
            try { tt.body.setSize(20, 16); } catch (e4) {}
            tt.body.setAllowGravity(false); tt.setVelocityX(-35);
            this.enemies.add(tt);
            turrets.push(tt);
          }
          core._turrets = turrets;
          this.bossDir = 1;
        }
        // Boss 定时射击
        this.bossShootEv = this.time.addEvent({ delay: 420, loop: true, callback: this.bossShoot, callbackScope: this });
      }

      hitBoss(boss, dmg) {
        // 炮塔未清前核心无敌（Stage1）
        if (boss._turrets) {
          var aliveTurret = boss._turrets.some(function (t) { return t.active; });
          if (aliveTurret) {
            // 击中船体无效提示
            boss.setTint(0x78909c);
            this.time.delayedCall(80, function () { if (boss.active) { boss.clearTint(); } });
            return;
          }
        }
        boss.hp -= dmg;
        boss.setTint(0xff8a80);
        this.time.delayedCall(60, function () { if (boss.active) { boss.clearTint(); } });
        Sfx.play('bossHit');
        if (boss.hp <= 0) { this.defeatBoss(boss); }
        this.updateHud();
      }

      hitBossPart(part, dmg) {
        part._hp -= dmg;
        part.setTint(0xffffff);
        this.time.delayedCall(60, function () { if (part.active) { part.clearTint(); } });
        if (part._hp <= 0) {
          var px = part.x, py = part.y;
          try { part.destroy(); } catch (e) {}
          this.spawnExplosion(px, py);
          this.score += 500;
          // 若所属 Boss 炮塔全灭，提示
          var boss = part._parentBoss;
          if (boss && boss.active && boss._turrets) {
            var remain = boss._turrets.filter(function (t) { return t.active; }).length;
            if (remain === 0) { this.showTip('核心暴露! 集中攻击!'); Sfx.play('alarm'); }
          }
        }
      }

      bossShoot() {
        if (!this.bossActive || !this.boss || !this.boss.active) { return; }
        var boss = this.boss;
        // 炮塔射击 + Boss本体
        var shooters = [];
        if (boss._turrets) { boss._turrets.forEach(function (t) { if (t.active) { shooters.push(t); } }); }
        shooters.push(boss);
        for (var i = 0; i < shooters.length; i++) {
          if (Math.random() < 0.55) {
            var s = shooters[i];
            var b = this.allocBulletE();
            if (!b) { continue; }
            try { b.body.reset(s.x - 12, s.y); } catch (e) { b.x = s.x - 12; b.y = s.y; }
            b.setTexture('bulletE');
            var ang = Math.atan2(this.player.y - s.y, this.player.x - s.x);
            // Boss 弹稍快
            b.setVelocity(Math.cos(ang) * (ENEMY_BULLET_SPEED + 60), Math.sin(ang) * (ENEMY_BULLET_SPEED + 60));
          }
        }
      }

      defeatBoss(boss) {
        var bx = boss.x, by = boss.y;
        // 大爆炸
        for (var k = 0; k < 5; k++) {
          this.time.delayedCall(k * 120, function () {
            var rx = bx + randInt(-30, 30), ry = by + randInt(-22, 22);
            this.spawnExplosion(rx, ry);
          }, [], this);
        }
        // 清理炮塔
        if (boss._turrets) {
          boss._turrets.forEach(function (t) { try { if (t.active) { t.destroy(); } } catch (e) {} });
        }
        try { boss.destroy(); } catch (e2) {}
        this.score += 5000;
        hiScore = Math.max(hiScore, this.score);
        this.bossActive = false;
        this.boss = null;
        if (this.bossShootEv) { try { this.bossShootEv.remove(false); } catch (e3) {} this.bossShootEv = null; }
        if (this.stage === 1) {
          this.showTip('STAGE 1 CLEAR! 奖励 +5000');
          // 进入 Stage2
          this.stage = 2;
          reachedStage = Math.max(reachedStage, 2);
          savePersist();
          this.stageTime = 0;
          this.stageDuration = 52000;
          this.showStageBanner(2);
          this.updateHud();
        } else {
          // 通关
          this.showTip('ALL STAGE CLEAR!');
          this.time.delayedCall(1200, function () { this.gameOver(true); }, [], this);
        }
      }

      // ---------------------------------------------------------------------
      // 结束与重开
      // ---------------------------------------------------------------------
      gameOver(isClear) {
        if (this.over) { return; }
        this.over = true;
        this.clearing = !!isClear;
        Sfx.stopBgm();
        hiScore = Math.max(hiScore, this.score);
        savePersist();
        var w = this.w, h = this.h;
        var dim = this.add.sprite(0, 0, 'panel').setOrigin(0, 0).setDisplaySize(w, h).setTint(0x0d1117).setAlpha(0.68).setDepth(70);
        var title = isClear ? 'ALL CLEAR!!' : 'GAME OVER';
        var col = isClear ? '#ffd54f' : '#ef5350';
        this.add.text(w / 2, h / 2 - 36, title, { fontFamily: 'monospace', fontSize: '24px', color: col, align: 'center', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(71);
        this.add.text(w / 2, h / 2 - 4, 'Score ' + this.score + '  Hi ' + hiScore + '  Stage ' + this.stage, { fontFamily: 'monospace', fontSize: '12px', color: '#b0bec5' }).setOrigin(0.5).setDepth(71);
        var btn = this.add.text(w / 2, h / 2 + 32, ' RESTART (R) ', { fontFamily: 'monospace', fontSize: '14px', color: '#fff', backgroundColor: '#1565c0', padding: { x: 14, y: 8 } }).setOrigin(0.5).setDepth(71).setInteractive({ useHandCursor: true });
        var self = this;
        btn.on('pointerdown', function () { self.scene.restart(); });
        var menuBtn = this.add.text(w / 2, h / 2 + 66, ' MENU (M) ', { fontFamily: 'monospace', fontSize: '12px', color: '#90a4ae', backgroundColor: '#263238', padding: { x: 12, y: 6 } }).setOrigin(0.5).setDepth(71).setInteractive({ useHandCursor: true });
        menuBtn.on('pointerdown', function () { try { self.scene.stop('play'); } catch (e) {} self.scene.start('menu'); });
      }

      // ---------------------------------------------------------------------
      // 每帧
      // ---------------------------------------------------------------------
      update(time, delta) {
        if (this.over) {
          if (Phaser.Input.Keyboard.JustDown(this.keyR)) { this.scene.restart(); return; }
          if (Phaser.Input.Keyboard.JustDown(this.keyM)) { try { this.scene.stop('play'); } catch (e) {} this.scene.start('menu'); return; }
          return;
        }
        if (this._paused) {
          if (Phaser.Input.Keyboard.JustDown(this.keyESC)) { this.togglePause(); }
          return;
        }
        if (Phaser.Input.Keyboard.JustDown(this.keyESC)) { this.togglePause(); return; }
        if (Phaser.Input.Keyboard.JustDown(this.keyR)) { this.scene.restart(); return; }
        if (Phaser.Input.Keyboard.JustDown(this.keyM)) { try { this.scene.stop('play'); } catch (e2) {} this.scene.start('menu'); return; }

        // 能量激活
        if (Phaser.Input.Keyboard.JustDown(this.keys.X)) { this.tryActivatePower(); }

        this.stageTime += delta;

        // Boss 调度：时长到且无 Boss 则生成
        if (!this.bossActive && this.stageTime >= this.stageDuration) {
          this.spawnBoss();
        }

        // 8向移动（WASD/方向键），速度受 SPEED UP 影响
        var dx = 0, dy = 0;
        if (this.keys.A.isDown || this.keys.LEFT.isDown) { dx -= 1; }
        if (this.keys.D.isDown || this.keys.RIGHT.isDown) { dx += 1; }
        if (this.keys.W.isDown || this.keys.UP.isDown) { dy -= 1; }
        if (this.keys.S.isDown || this.keys.DOWN.isDown) { dy += 1; }
        var curSpeed = PLAYER_BASE_SPEED + this.speedLevel * SPEED_STEP;
        if (dx !== 0 || dy !== 0) {
          var len = Math.sqrt(dx * dx + dy * dy);
          this.player.setVelocity((dx / len) * curSpeed, (dy / len) * curSpeed);
        } else {
          this.player.setVelocity(0, 0);
        }
        // 限制在屏幕内
        var nx = clamp(this.player.x, 22, this.w - 22);
        var ny = clamp(this.player.y, 18, this.h - 30);
        if (nx !== this.player.x || ny !== this.player.y) {
          try { this.player.body.reset(nx, ny); } catch (e3) { this.player.x = nx; this.player.y = ny; }
          this.player.setVelocity(0, 0);
        }

        // 按住射击
        this._fireCooldown -= delta;
        var firing = this.keys.SPACE.isDown || this.keyJ.isDown;
        if (firing && this._fireCooldown <= 0) {
          this.firePlayer();
          this._fireCooldown = FIRE_INTERVAL;
        }

        // Option 轨迹：记录最近 N 帧位置历史队列，子机依次跟随
        this.trail.push({ x: this.player.x, y: this.player.y });
        if (this.trail.length > OPTION_TRAIL_LEN * OPTION_MAX + 6) { this.trail.shift(); }
        for (var oi3 = 0; oi3 < this.optionCount; oi3++) {
          var op2 = this.options[oi3];
          var delay = (oi3 + 1) * OPTION_TRAIL_LEN;
          var idx2 = this.trail.length - 1 - delay;
          if (idx2 >= 0) {
            var p = this.trail[idx2];
            try { op2.body.reset(p.x - 18 - oi3 * 6, p.y); } catch (e4) { op2.x = p.x - 18; op2.y = p.y; }
          } else {
            try { op2.body.reset(this.player.x - 18 - oi3 * 6, this.player.y); } catch (e5) {}
          }
        }

        // Boss 移动（上下往复）
        if (this.bossActive && this.boss && this.boss.active) {
          var b = this.boss;
          // 保持在右半区
          if (b.x > this.w - 90) { b.setVelocityX(-34); }
          else if (b.x < this.w - 170) { b.setVelocityX(14); }
          // 上下
          if (!b._vy) { b._vy = 42 * this.bossDir; b.setVelocityY(b._vy); }
          if (b.y < 60) { b._vy = Math.abs(b._vy); b.setVelocityY(b._vy); }
          if (b.y > this.h - 70) { b._vy = -Math.abs(b._vy); b.setVelocityY(b._vy); }
          // 炮塔跟随 Boss
          if (b._turrets) {
            for (var tii = 0; tii < b._turrets.length; tii++) {
              var tt2 = b._turrets[tii];
              if (!tt2.active) { continue; }
              // 保持相对偏移跟随
              // 简化：每帧向 Boss 目标相对位置插值
              var offs2 = this.stage === 1
                ? (tii === 0 ? [-18, -18] : [-18, 18])
                : [[-36, -24], [-36, 24], [22, -26], [22, 26]][tii];
              var tx = b.x + offs2[0], ty = b.y + offs2[1];
              try { tt2.body.reset(tx, ty); } catch (e6) { tt2.x = tx; tt2.y = ty; }
              tt2.setVelocity(0, 0);
            }
          }
        }

        // 敌机正弦摆动（type1）
        var ens = this.enemies.getChildren();
        for (var ei2 = 0; ei2 < ens.length; ei2++) {
          var en2 = ens[ei2];
          if (en2._type === 1 && !en2._isBoss && !en2._isBossPart) {
            en2.y += Math.sin(time * 0.003 + en2._phase) * 0.9;
          }
          // 越界回收
          if (en2.x < -60) {
            // 若为编队成员，计为逃脱亦扣 remaining（不掉胶囊）
            if (en2._formationId) {
              for (var fj = 0; fj < this.formations.length; fj++) {
                if (this.formations[fj].id === en2._formationId) {
                  this.formations[fj].remaining -= 1;
                  if (this.formations[fj].remaining <= 0) { this.formations.splice(fj, 1); }
                  break;
                }
              }
            }
            try { en2.destroy(); } catch (e7) {}
          }
        }

        // 子弹越界回池
        var bps = this.bulletsP.getChildren();
        for (var bi2 = 0; bi2 < bps.length; bi2++) {
          var bp2 = bps[bi2];
          if (!bp2.active) { continue; }
          // 导弹向下超出或超出右边界
          if (bp2._isMissile) {
            if (bp2.y > this.h + 20 || bp2.x > this.w + 20) {
              bp2.setActive(false).setVisible(false); bp2.setVelocity(0, 0);
              try { bp2.body.reset(-100, -100); } catch (e8) {}
              try { bp2.setTexture('bulletP'); } catch (e9) {}
              bp2.clearTint(); bp2._isMissile = false;
            } else if (bp2.y >= this.h - 40) {
              // 触地（近地形高度）视为命中地形效果：小爆炸
              this.spawnExplosion(bp2.x, bp2.y);
              bp2.setActive(false).setVisible(false); bp2.setVelocity(0, 0);
              try { bp2.body.reset(-100, -100); } catch (e10) {}
              try { bp2.setTexture('bulletP'); } catch (e11) {}
              bp2.clearTint(); bp2._isMissile = false;
              // 对附近敌人溅射
              var near = this.enemies.getChildren();
              for (var ni = 0; ni < near.length; ni++) {
                var ne = near[ni];
                if (!ne.active || ne._isBoss) { continue; }
                var ddx = ne.x - bp2.x, ddy = ne.y - bp2.y;
                if (ddx * ddx + ddy * ddy < 28 * 28) {
                  ne._hp -= 1;
                  if (ne._hp <= 0) { this.spawnExplosion(ne.x, ne.y); try { ne.destroy(); } catch (e12) {} this.score += 100; }
                }
              }
            }
          } else {
            if (bp2.x > this.w + 24 || bp2.x < -24 || bp2.y < -20 || bp2.y > this.h + 20) {
              bp2.setActive(false).setVisible(false); bp2.setVelocity(0, 0);
              try { bp2.body.reset(-100, -100); } catch (e13) {}
              bp2.clearTint();
            }
          }
        }
        var bes = this.bulletsE.getChildren();
        for (var bei = 0; bei < bes.length; bei++) {
          var be2 = bes[bei];
          if (!be2.active) { continue; }
          if (be2.x < -20 || be2.x > this.w + 20 || be2.y < -20 || be2.y > this.h + 20) {
            be2.setActive(false).setVisible(false); be2.setVelocity(0, 0);
            try { be2.body.reset(-100, -100); } catch (e14) {}
          }
        }
        // 胶囊越界
        var caps = this.capsules.getChildren();
        for (var ci = 0; ci < caps.length; ci++) {
          var ca = caps[ci];
          if (ca.x < -30 || ca.y > this.h + 30) { try { ca.destroy(); } catch (e15) {} }
        }
        // 地形越界
        var ters = this.terrains.getChildren();
        for (var tii2 = 0; tii2 < ters.length; tii2++) {
          var te = ters[tii2];
          if (te.x < -80) { try { te.destroy(); } catch (e16) {} }
        }

        // 无敌闪烁
        if (this.time.now < this.invincibleUntil) {
          this.player.setAlpha(this.time.now % 120 < 60 ? 0.35 : 1);
        } else if (this.player.alpha !== 1) {
          this.player.setAlpha(1);
        }

        this.updateHud();
      }

      togglePause() {
        if (this._paused) {
          this._paused = false;
          if (this._pauseOverlay) {
            this._pauseOverlay.forEach(function (o) { try { o.destroy(); } catch (e) {} });
            this._pauseOverlay = null;
          }
          try { this.scene.resume('play'); } catch (e2) {}
        } else {
          this._paused = true;
          var w = this.w, h = this.h;
          var dim = this.add.sprite(0, 0, 'panel').setOrigin(0, 0).setDisplaySize(w, h).setTint(0x0d1117).setAlpha(0.62).setDepth(70);
          var txt = this.add.text(w / 2, h / 2 - 10, 'PAUSED', { fontFamily: 'monospace', fontSize: '22px', color: '#e3f2fd' }).setOrigin(0.5).setDepth(71);
          var hint = this.add.text(w / 2, h / 2 + 18, 'ESC 继续  ·  R 重开  ·  M 菜单', { fontFamily: 'monospace', fontSize: '11px', color: '#90a4ae' }).setOrigin(0.5).setDepth(71);
          this._pauseOverlay = [dim, txt, hint];
          try { this.scene.pause('play'); } catch (e3) {}
          // Phaser 暂停后仍需手动恢复事件？此处用 scene.pause 需外部恢复；改用标志位更稳，故立即 resume 并用标志位暂停逻辑
          try { this.scene.resume('play'); } catch (e4) {}
        }
      }
    };

    var config = {
      type: Phaser.AUTO,
      parent: host.container,
      width: host.width,
      height: host.height,
      backgroundColor: '#0a0e1a',
      physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
      scene: [BootScene, MenuScene, PlayScene]
    };
    var game = new Phaser.Game(config);
    window.__trgame = { game: game, getState: getState };
    return game;
  }

  if (typeof window.TRGames !== 'undefined' && typeof window.TRGames.register === 'function') {
    window.TRGames.register({ id: 'stg-horizontal', title: '横版突击 Gradius', launch: launch });
  }
})();
