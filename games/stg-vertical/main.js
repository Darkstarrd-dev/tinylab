// =============================================================================
// games/stg-vertical/main.js — 竖版 STG（2 Stage + 2 Boss）
// =============================================================================
// 资产清单（全代码生成，零外部资源）：
//   纹理：player(三角自机+尾焰)/enemyA(倒三角)/enemyB(菱形)/enemyC(六边形)
//         /boss1(大六边形+核心)/boss2(菱形要塞)/pBullet(发光圆)/eBullet(发光圆)
//         /powerP/powerB/star/cloud 均由 Graphics.generateTexture 生成
//         视觉替换点：搜索“视觉替换点”注释，可替换为外部贴图/序列帧
//   音频：WebAudio oscillator+gain 自合成 Sfx.play(type)，首输入 resume，静默降级
//         音频替换点：搜索“音频替换点”
//   存档：host.saveState/loadState 持久化 {hiScore,reachedStage}
//   测试缝：window.__trgame={game,getState()}
//
// 可调参数集中于 CFG 顶部对象；玩法规则与陷阱见内联中文注释
// =============================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 顶部可调参数 — 数值平衡/手感均在此改
  // ---------------------------------------------------------------------------
  /** @const */
  var CFG = {
    W: 480,               // 逻辑宽度（host.width 优先）
    H: 720,               // 逻辑高度（host.height 优先）
    PLAYER_SPEED: 280,    // 自机常速 px/s
    PLAYER_SLOW: 125,     // 低速（Shift） px/s
    PLAYER_RADIUS: 3.5,   // 自机判定半径（小判定，子弹仅撞此圆）
    PLAYER_BULLET_SPEED: 680,
    PLAYER_FIRE_MS: 110,  // 连射间隔 ms
    ENEMY_BULLET_SPEED: 220,
    ENEMY_POOL: 32,       // 敌机池大小
    PBULLET_POOL: 80,     // 自机弹池大小
    EBULLET_POOL: 160,    // 敌弹池大小
    LIVES: 3,
    BOMBS: 2,
    INV_MS: 1500,         // 受击无敌 ms
    BOMB_DAMAGE: 40,      // 炸弹对 Boss 伤害
    CLOUD_COUNT: 10
  };

  // ---------------------------------------------------------------------------
  // 存档/缝 — 闭包持有，跨场景共享
  // ---------------------------------------------------------------------------
  /** @type {object|null} */
  var hostRef = null;
  /** @type {Phaser.Scene|null} */
  var sceneRef = null;
  var hiScore = 0;
  var reachedStage = 1;

  function getState() {
    var s = sceneRef;
    if (!s) return { scene: 'none', stage: 1, score: 0, lives: CFG.LIVES, bombs: CFG.BOMBS, power: 1, bossHp: 0 };
    return {
      scene: s.scene.key || 'stg',
      stage: s.stage || 1,
      score: s.score || 0,
      lives: s.lives || 0,
      bombs: s.bombs || 0,
      power: s.power || 1,
      bossHp: s.boss ? (s.boss.hp || 0) : 0
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
        if (type === 'shoot') {
          o.type = 'square'; o.frequency.setValueAtTime(880, now);
          o.frequency.exponentialRampToValueAtTime(440, now + 0.08);
          g.gain.setValueAtTime(0.12, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
          o.start(now); o.stop(now + 0.13);
        } else if (type === 'hit') {
          o.type = 'square'; o.frequency.setValueAtTime(220, now);
          g.gain.setValueAtTime(0.18, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
          o.start(now); o.stop(now + 0.16);
        } else if (type === 'explode') {
          o.type = 'sawtooth'; o.frequency.setValueAtTime(180, now);
          o.frequency.linearRampToValueAtTime(40, now + 0.35);
          g.gain.setValueAtTime(0.22, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
          o.start(now); o.stop(now + 0.41);
        } else if (type === 'pickup') {
          o.type = 'sine'; o.frequency.setValueAtTime(523, now);
          o.frequency.setValueAtTime(659, now + 0.08);
          o.frequency.setValueAtTime(784, now + 0.16);
          g.gain.setValueAtTime(0.16, now);
          g.gain.linearRampToValueAtTime(0.001, now + 0.28);
          o.start(now); o.stop(now + 0.29);
        } else if (type === 'bomb') {
          o.type = 'triangle'; o.frequency.setValueAtTime(80, now);
          o.frequency.linearRampToValueAtTime(30, now + 0.6);
          g.gain.setValueAtTime(0.3, now);
          g.gain.linearRampToValueAtTime(0.001, now + 0.7);
          o.start(now); o.stop(now + 0.71);
        } else if (type === 'alarm') {
          o.type = 'square'; o.frequency.setValueAtTime(880, now);
          o.frequency.setValueAtTime(660, now + 0.12);
          g.gain.setValueAtTime(0.1, now);
          g.gain.linearRampToValueAtTime(0.001, now + 0.24);
          o.start(now); o.stop(now + 0.25);
        }
      } catch (e) {}
    },
    startBgm: function (scene) {
      if (this.bgmTimer) return;
      this.bgmOn = true;
      var self = this;
      try {
        self.bgmTimer = scene.time.addEvent({
          delay: 420,
          loop: true,
          callback: function () {
            if (!self.bgmOn) return;
            self.play('shoot');
          }
        });
      } catch (e) {}
    },
    stopBgm: function (scene) {
      this.bgmOn = false;
      if (this.bgmTimer) { try { this.bgmTimer.remove(false); } catch (e) {} this.bgmTimer = null; }
    }
  };

  // ---------------------------------------------------------------------------
  // 纹理生成 — 全部 Graphics+generateTexture
  // 视觉替换点：每个 ensureRemoved 块可替换为外部贴图加载
  // ---------------------------------------------------------------------------
  function buildTextures(scene) {
    function rm(k) { if (scene.textures.exists(k)) scene.textures.remove(k); }
    var g;
    // 自机：三角 + 尾焰（青色描边，低速判定点单独绘制）
    rm('player'); g = scene.add.graphics();
    g.fillStyle(0x4fc3f7, 1); g.lineStyle(2, 0xe1f5fe, 1);
    // 视觉替换点：自机三角可换贴图
    g.fillTriangle(16, 2, 4, 30, 28, 30); g.strokeTriangle(16, 2, 4, 30, 28, 30);
    g.fillStyle(0xff7043, 1); g.fillTriangle(16, 30, 10, 36, 22, 36);
    g.generateTexture('player', 32, 38); g.destroy();
    // 敌A：倒三角（直线突进）
    rm('enemyA'); g = scene.add.graphics();
    g.fillStyle(0xef5350, 1); g.lineStyle(1.5, 0xffcdd2, 0.9);
    g.fillTriangle(14, 26, 0, 2, 28, 2); g.strokeTriangle(14, 26, 0, 2, 28, 2);
    g.generateTexture('enemyA', 28, 28); g.destroy();
    // 敌B：菱形（正弦）
    rm('enemyB'); g = scene.add.graphics();
    g.fillStyle(0xab47bc, 1); g.lineStyle(1.5, 0xe1bee7, 0.9);
    g.fillPoints([{ x: 14, y: 0 }, { x: 28, y: 14 }, { x: 14, y: 28 }, { x: 0, y: 14 }], true); g.strokePoints([{ x: 14, y: 0 }, { x: 28, y: 14 }, { x: 14, y: 28 }, { x: 0, y: 14 }], true);
    g.generateTexture('enemyB', 28, 28); g.destroy();
    // 敌C：六边形（停留散射）
    rm('enemyC'); g = scene.add.graphics();
    g.fillStyle(0xffa726, 1); g.lineStyle(1.5, 0xffe0b2, 0.9);
    var cx = 16, cy = 16, r = 14; var pts = [];
    for (var k = 0; k < 6; k++) { var a = Math.PI / 3 * k - Math.PI / 6; pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); }
    g.fillPoints(pts, true); g.strokePoints(pts, true);
    g.generateTexture('enemyC', 32, 32); g.destroy();
    // Boss1：大六边形+核心（Stage1 云海领主）
    rm('boss1'); g = scene.add.graphics();
    g.fillStyle(0xe53935, 1); g.fillCircle(40, 40, 38);
    g.fillStyle(0x263238, 1); g.fillCircle(40, 40, 22);
    g.fillStyle(0xffeb3b, 1); g.fillCircle(40, 40, 10);
    g.lineStyle(2, 0xff8a80, 1); g.strokeCircle(40, 40, 38);
    g.generateTexture('boss1', 80, 80); g.destroy();
    // Boss2：菱形要塞（Stage2 夜间基地）
    rm('boss2'); g = scene.add.graphics();
    g.fillStyle(0x1e88e5, 1); g.fillPoints([{ x: 45, y: 6 }, { x: 90, y: 40 }, { x: 45, y: 74 }, { x: 0, y: 40 }], true);
    g.fillStyle(0x0d47a1, 1); g.fillRect(28, 28, 34, 24);
    g.fillStyle(0xff5252, 1); g.fillCircle(45, 40, 10);
    g.generateTexture('boss2', 90, 80); g.destroy();
    // 自机弹：发光圆（白芯+青晕）
    rm('pBullet'); g = scene.add.graphics();
    g.fillStyle(0x4fc3f7, 0.45); g.fillCircle(6, 12, 6);
    g.fillStyle(0xffffff, 1); g.fillCircle(6, 6, 3.5);
    g.generateTexture('pBullet', 12, 18); g.destroy();
    // 敌弹：发光圆（橙/红）
    rm('eBullet'); g = scene.add.graphics();
    g.fillStyle(0xff7043, 0.45); g.fillCircle(5, 5, 5);
    g.fillStyle(0xfff3e0, 1); g.fillCircle(5, 5, 2.8);
    g.generateTexture('eBullet', 10, 10); g.destroy();
    // 敌弹（蓝，Boss用）
    rm('eBulletB'); g = scene.add.graphics();
    g.fillStyle(0x42a5f5, 0.45); g.fillCircle(6, 6, 6);
    g.fillStyle(0xe3f2fd, 1); g.fillCircle(6, 6, 3);
    g.generateTexture('eBulletB', 12, 12); g.destroy();
    // 道具 P / B
    rm('powerP'); g = scene.add.graphics();
    g.fillStyle(0x66bb6a, 1); g.fillRoundedRect(0, 0, 22, 22, 4);
    g.fillStyle(0xffffff, 1); g.fillCircle(11, 11, 0); // placeholder text via graphics
    // 用线条拼一个 P 字形
    g.lineStyle(2, 0xffffff, 1); g.strokeRect(7, 6, 8, 10); g.strokeCircle(11, 8, 3);
    g.generateTexture('powerP', 22, 22); g.destroy();
    rm('powerB'); g = scene.add.graphics();
    g.fillStyle(0xef5350, 1); g.fillRoundedRect(0, 0, 22, 22, 4);
    g.lineStyle(2, 0xffffff, 1); g.strokeCircle(11, 11, 5); g.strokeRect(9, 5, 4, 12);
    g.generateTexture('powerB', 22, 22); g.destroy();
    // 星星/云（背景）
    rm('star'); g = scene.add.graphics(); g.fillStyle(0xffffff, 1); g.fillCircle(1, 1, 1); g.generateTexture('star', 2, 2); g.destroy();
    rm('cloud'); g = scene.add.graphics(); g.fillStyle(0xffffff, 0.9); g.fillEllipse(24, 14, 40, 18); g.fillEllipse(14, 18, 28, 14); g.fillEllipse(34, 18, 30, 15); g.generateTexture('cloud', 48, 28); g.destroy();
    // 1x1 白像素（血条/遮罩）
    rm('pixel'); g = scene.add.graphics(); g.fillStyle(0xffffff, 1); g.fillRect(0, 0, 1, 1); g.generateTexture('pixel', 1, 1); g.destroy();
  }

  // ---------------------------------------------------------------------------
  // 敌机时间表 — 数据驱动 spawn
  // t: 相对关卡开始 ms，x: 出生 x，type: A/B/C
  // 两关各自独立数组，密度与种类随关递增
  // ---------------------------------------------------------------------------
  /** Stage1：天空云视差，基础敌 A/B 为主，偶发 C */
  var STAGE1_SCHEDULE = [
    { t: 600, x: 120, type: 'A' }, { t: 900, x: 360, type: 'A' },
    { t: 1500, x: 200, type: 'B' }, { t: 1800, x: 300, type: 'A' },
    { t: 2400, x: 240, type: 'B' }, { t: 3000, x: 100, type: 'A' }, { t: 3100, x: 380, type: 'A' },
    { t: 3800, x: 240, type: 'C' },
    { t: 4600, x: 160, type: 'B' }, { t: 4800, x: 320, type: 'B' },
    { t: 5600, x: 80, type: 'A' }, { t: 5700, x: 400, type: 'A' }, { t: 5900, x: 240, type: 'A' },
    { t: 6800, x: 240, type: 'C' },
    { t: 7600, x: 120, type: 'B' }, { t: 7800, x: 360, type: 'B' }, { t: 8100, x: 200, type: 'A' },
    { t: 9000, x: 240, type: 'A' }, { t: 9300, x: 160, type: 'A' }, { t: 9500, x: 320, type: 'A' },
    { t: 10500, x: 240, type: 'C' },
    { t: 11400, x: 100, type: 'B' }, { t: 11600, x: 380, type: 'B' },
    { t: 12400, x: 240, type: 'B' }
  ];
  /** Boss1 在 Stage1 约 14s 后登场（先清场） */

  /** Stage2：夜间基地，更密，C 增多，A/B 更快 */
  var STAGE2_SCHEDULE = [
    { t: 500, x: 80, type: 'A' }, { t: 650, x: 400, type: 'A' }, { t: 800, x: 240, type: 'B' },
    { t: 1300, x: 160, type: 'C' }, { t: 1600, x: 320, type: 'A' }, { t: 1750, x: 120, type: 'B' },
    { t: 2200, x: 240, type: 'A' }, { t: 2350, x: 360, type: 'A' }, { t: 2500, x: 80, type: 'B' },
    { t: 3000, x: 240, type: 'C' }, { t: 3400, x: 140, type: 'B' }, { t: 3550, x: 340, type: 'B' },
    { t: 4000, x: 200, type: 'A' }, { t: 4150, x: 280, type: 'A' }, { t: 4300, x: 240, type: 'C' },
    { t: 4900, x: 100, type: 'B' }, { t: 5050, x: 380, type: 'B' }, { t: 5200, x: 240, type: 'A' },
    { t: 5800, x: 240, type: 'C' }, { t: 6200, x: 160, type: 'A' }, { t: 6350, x: 320, type: 'A' },
    { t: 6800, x: 240, type: 'B' }, { t: 7000, x: 120, type: 'C' }, { t: 7300, x: 360, type: 'B' },
    { t: 7800, x: 240, type: 'A' }, { t: 8000, x: 180, type: 'A' }, { t: 8150, x: 300, type: 'A' },
    { t: 8600, x: 240, type: 'C' }
  ];

  // ---------------------------------------------------------------------------
  // Boot / Menu
  // ---------------------------------------------------------------------------
  var BootScene = function () { Phaser.Scene.call(this, { key: 'boot' }); };
  BootScene.prototype = Object.create(Phaser.Scene.prototype);
  BootScene.prototype.constructor = BootScene;
  BootScene.prototype.create = function () {
    var w = (hostRef && hostRef.width) ? hostRef.width : CFG.W;
    var h = (hostRef && hostRef.height) ? hostRef.height : CFG.H;
    buildTextures(this);
    // 尝试读档
    var self = this;
    if (hostRef && typeof hostRef.loadState === 'function') {
      try {
        hostRef.loadState().then(function (d) {
          if (d) { hiScore = d.hiScore | 0; reachedStage = d.reachedStage | 0; if (reachedStage < 1) reachedStage = 1; }
          self.scene.start('menu');
        }, function () { self.scene.start('menu'); });
        return;
      } catch (e) {}
    }
    this.scene.start('menu');
  };

  var MenuScene = function () { Phaser.Scene.call(this, { key: 'menu' }); };
  MenuScene.prototype = Object.create(Phaser.Scene.prototype);
  MenuScene.prototype.constructor = MenuScene;
  MenuScene.prototype.create = function () {
    buildTextures(this);
    var w = this.scale.width, h = this.scale.height;
    this.cameras.main.setBackgroundColor('#0a1628');
    // 标题
    this.add.text(w / 2, h * 0.26, 'VERTICAL STG', { fontFamily: 'monospace', fontSize: '36px', color: '#e1f5fe', fontStyle: 'bold' }).setOrigin(0.5);
    this.add.text(w / 2, h * 0.33, '— 2 STAGES · 2 BOSSES —', { fontFamily: 'monospace', fontSize: '13px', color: '#90a4ae' }).setOrigin(0.5);
    var lines = [
      'WASD / 方向键  8 向移动（下 2/3 区域）',
      'Shift 低速 + 判定点显示',
      'Z / Space 连射（池化）  X 炸弹清屏',
      'P 提升火力（3档）  B 补炸弹',
      'Stage1: 天空云海  Stage2: 夜间基地'
    ];
    for (var i = 0; i < lines.length; i++) {
      this.add.text(w / 2, h * 0.42 + i * 18, lines[i], { fontFamily: 'monospace', fontSize: '12px', color: '#b0bec5' }).setOrigin(0.5);
    }
    this.add.text(w / 2, h * 0.60, 'HI-SCORE ' + hiScore + '   REACHED STAGE ' + reachedStage, { fontFamily: 'monospace', fontSize: '12px', color: '#ffd54f' }).setOrigin(0.5);
    var btn = this.add.text(w / 2, h * 0.70, '▶  START  (Z / Space / Enter)', { fontFamily: 'monospace', fontSize: '16px', color: '#ffffff', backgroundColor: '#1e88e5', padding: { x: 16, y: 8 } }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    var self = this;
    function go() { Sfx.resume(); Sfx.play('pickup'); self.scene.start('stg'); }
    btn.on('pointerdown', go);
    this.input.keyboard.once('keydown-SPACE', go);
    this.input.keyboard.once('keydown-Z', go);
    this.input.keyboard.once('keydown-ENTER', go);
    this.input.once('pointerdown', go);
  };

  // ---------------------------------------------------------------------------
  // 主关卡场景
  // ---------------------------------------------------------------------------
  var StgScene = function () { Phaser.Scene.call(this, { key: 'stg' }); };
  StgScene.prototype = Object.create(Phaser.Scene.prototype);
  StgScene.prototype.constructor = StgScene;

  StgScene.prototype.create = function () {
    sceneRef = this;
    Sfx.resume();
    this.w = this.scale.width; this.h = this.scale.height;
    buildTextures(this);

    // 背景色按关卡
    this.stage = 1;
    this.score = 0; this.lives = CFG.LIVES; this.bombs = CFG.BOMBS; this.power = 1;
    this.over = false; this.clearAll = false;
    this.stageTime = 0; this.spawnIdx = 0;
    this.boss = null; this.bossHpMax = 0;
    this.invUntil = 0;
    this.nextFireAt = 0;

    // 阶段时间表引用
    this.schedule = STAGE1_SCHEDULE.slice();

    // 背景：Stage1 天空蓝 + 云，Stage2 深蓝夜空 + 星 + 基地几何
    this.bgStars = []; this.bgClouds = []; this.bgBases = [];
    this.cameras.main.setBackgroundColor('#87ceeb');
    this.createBackground();

    // 物理组（池化）
    this.pBullets = this.physics.add.group({ maxSize: CFG.PBULLET_POOL, runChildUpdate: false });
    this.eBullets = this.physics.add.group({ maxSize: CFG.EBULLET_POOL, runChildUpdate: false });
    this.enemies = this.physics.add.group({ maxSize: CFG.ENEMY_POOL, runChildUpdate: false });
    this.powerups = this.physics.add.group();
    // 预创建池对象（inactive）
    for (var pi = 0; pi < CFG.PBULLET_POOL; pi++) {
      var pb = this.physics.add.sprite(-100, -100, 'pBullet'); pb.setActive(false).setVisible(false); pb.body.enable = false; this.pBullets.add(pb);
    }
    for (var ei = 0; ei < CFG.EBULLET_POOL; ei++) {
      var eb = this.physics.add.sprite(-100, -100, 'eBullet'); eb.setActive(false).setVisible(false); eb.body.enable = false; this.eBullets.add(eb);
    }
    for (var eni = 0; eni < CFG.ENEMY_POOL; eni++) {
      var en = this.physics.add.sprite(-100, -100, 'enemyA'); en.setActive(false).setVisible(false); en.body.enable = false; this.enemies.add(en);
    }

    // 自机
    this.player = this.physics.add.sprite(this.w / 2, this.h * 0.82, 'player');
    this.player.setDepth(10);
    try { this.player.body.setCircle(8); } catch (e) { this.player.body.setSize(20, 20); }
    // 判定点（低速时显）
    this.hitDot = this.add.circle(this.player.x, this.player.y, 4, 0xff1744, 1).setDepth(11).setVisible(false);
    this.hitDotStroke = this.add.circle(this.player.x, this.player.y, 6, 0xffffff, 0).setStrokeStyle(1, 0xffffff, 1).setDepth(11).setVisible(false);

    // 爆炸池（复用 circle+ tween）
    this.explosions = this.add.group();

    // 输入
    this.keys = this.input.keyboard.addKeys({
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
      UP: Phaser.Input.Keyboard.KeyCodes.UP,
      DOWN: Phaser.Input.Keyboard.KeyCodes.DOWN,
      LEFT: Phaser.Input.Keyboard.KeyCodes.LEFT,
      RIGHT: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      SHIFT: Phaser.Input.Keyboard.KeyCodes.SHIFT,
      Z: Phaser.Input.Keyboard.KeyCodes.Z,
      SPACE: Phaser.Input.Keyboard.KeyCodes.SPACE,
      X: Phaser.Input.Keyboard.KeyCodes.X,
      R: Phaser.Input.Keyboard.KeyCodes.R,
      P: Phaser.Input.Keyboard.KeyCodes.P
    });
    // 也监听 X 炸弹 JustDown
    this.bombKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.X);

    // HUD
    var pad = 8;
    this.hudScore = this.add.text(pad, pad, '', { fontFamily: 'monospace', fontSize: '13px', color: '#ffffff', stroke: '#000000', strokeThickness: 3 }).setDepth(20);
    this.hudInfo = this.add.text(pad, pad + 18, '', { fontFamily: 'monospace', fontSize: '11px', color: '#e0f7fa', stroke: '#000000', strokeThickness: 3 }).setDepth(20);
    this.stageText = this.add.text(this.w / 2, 26, 'STAGE 1 — 天空云海', { fontFamily: 'monospace', fontSize: '12px', color: '#ffffff', stroke: '#000000', strokeThickness: 3 }).setOrigin(0.5).setDepth(20);
    // Boss 血条
    this.bossBarBg = this.add.image(this.w / 2, 48, 'pixel').setDisplaySize(this.w - 24, 8).setTint(0x263238).setDepth(20).setVisible(false);
    this.bossBar = this.add.image(this.w / 2, 48, 'pixel').setDisplaySize(this.w - 24, 8).setTint(0xef5350).setDepth(21).setVisible(false);
    this.bossBar.setOrigin(0.5, 0.5);
    this.bossName = this.add.text(this.w / 2, 62, '', { fontFamily: 'monospace', fontSize: '11px', color: '#ffccbc' }).setOrigin(0.5).setDepth(20).setVisible(false);

    this.centerText = this.add.text(this.w / 2, this.h / 2, '', { fontFamily: 'monospace', fontSize: '18px', color: '#ffffff', stroke: '#000000', strokeThickness: 4, align: 'center' }).setOrigin(0.5).setDepth(30).setVisible(false);

    this.updateHud();
    // 开场提示
    this.showCenter('STAGE 1\n天空云海', 1400);
    // 首输入唤醒音频
    this.input.once('pointerdown', function () { Sfx.resume(); });
    this.input.keyboard.once('keydown', function () { Sfx.resume(); });
  };

  StgScene.prototype.createBackground = function () {
    // 清理旧
    for (var i = 0; i < this.bgStars.length; i++) { try { this.bgStars[i].destroy(); } catch (e) {} }
    for (var j = 0; j < this.bgClouds.length; j++) { try { this.bgClouds[j].destroy(); } catch (e2) {} }
    for (var k = 0; k < this.bgBases.length; k++) { try { this.bgBases[k].destroy(); } catch (e3) {} }
    this.bgStars = []; this.bgClouds = []; this.bgBases = [];
    var w = this.w, h = this.h;
    if (this.stage === 1) {
      this.cameras.main.setBackgroundColor('#87ceeb');
      for (var c = 0; c < CFG.CLOUD_COUNT; c++) {
        var cl = this.add.image(Phaser.Math.Between(20, w - 20), Phaser.Math.Between(-h, h), 'cloud').setAlpha(0.85).setDepth(0);
        cl.speed = Phaser.Math.Between(40, 90);
        // 视差：大小随机
        var sc = Phaser.Math.FloatBetween(0.7, 1.2); cl.setScale(sc);
        this.bgClouds.push(cl);
      }
    } else {
      this.cameras.main.setBackgroundColor('#0a1628');
      // 星空
      for (var s = 0; s < 60; s++) {
        var st = this.add.image(Phaser.Math.Between(0, w), Phaser.Math.Between(0, h), 'star').setAlpha(Phaser.Math.FloatBetween(0.4, 1)).setDepth(0);
        st.speed = Phaser.Math.Between(10, 30);
        this.bgStars.push(st);
      }
      // 云仍有少量
      for (var c2 = 0; c2 < 6; c2++) {
        var cl2 = this.add.image(Phaser.Math.Between(20, w - 20), Phaser.Math.Between(-h, h), 'cloud').setAlpha(0.35).setDepth(0);
        cl2.speed = Phaser.Math.Between(50, 100);
        this.bgClouds.push(cl2);
      }
      // 向下几何基地（矩形阵列，向下滚动）
      for (var b = 0; b < 4; b++) {
        var bx = (b % 2 === 0) ? 60 : w - 60;
        var by = -120 - b * 180;
        var base = this.add.rectangle(bx, by, 90, 22, 0x1a2733).setDepth(0);
        base.speed = 60;
        // 顶部几何灯
        var light = this.add.rectangle(bx, by - 8, 40, 6, 0x4fc3f7).setDepth(0).setAlpha(0.6);
        light.speed = 60;
        this.bgBases.push(base); this.bgBases.push(light);
      }
    }
  };

  // 池化取弹
  StgScene.prototype.allocPBullet = function (x, y) {
    var b = this.pBullets.getFirstDead(false);
    if (!b) {
      // 池满则复用最旧的活跃弹
      var alive = this.pBullets.getChildren();
      for (var i = 0; i < alive.length; i++) if (alive[i].active) { b = alive[i]; break; }
      if (!b) return null;
    }
    b.setTexture('pBullet'); b.setPosition(x, y);
    b.setActive(true).setVisible(true); b.body.enable = true;
    try { b.body.setCircle(4); } catch (e) { b.body.setSize(8, 8); }
    return b;
  };
  StgScene.prototype.allocEBullet = function (x, y, blue) {
    var b = this.eBullets.getFirstDead(false);
    if (!b) {
      var alive = this.eBullets.getChildren();
      for (var i = 0; i < alive.length; i++) if (alive[i].active) { b = alive[i]; break; }
      if (!b) return null;
    }
    b.setTexture(blue ? 'eBulletB' : 'eBullet'); b.setPosition(x, y);
    b.setActive(true).setVisible(true); b.body.enable = true;
    try { b.body.setCircle(blue ? 5 : 4); } catch (e2) { b.body.setSize(8, 8); }
    return b;
  };
  StgScene.prototype.allocEnemy = function (x, y, type) {
    var e = this.enemies.getFirstDead(false);
    if (!e) {
      var alive = this.enemies.getChildren();
      for (var i = 0; i < alive.length; i++) if (alive[i].active) { e = alive[i]; break; }
      if (!e) return null;
    }
    var tex = type === 'A' ? 'enemyA' : (type === 'B' ? 'enemyB' : 'enemyC');
    e.setTexture(tex); e.setPosition(x, y);
    e.setActive(true).setVisible(true); e.body.enable = true;
    try { e.body.setCircle(10); } catch (ex) { e.body.setSize(22, 22); }
    e.enemyType = type; e.hp = type === 'C' ? 3 : (type === 'B' ? 2 : 1);
    e.phase = Math.random() * Math.PI * 2;
    e.shootCd = 900 + Math.random() * 600;
    e.lastShot = 0;
    e.hoverT = 0; e.vx0 = 0;
    if (type === 'A') e.setVelocity(0, 180 + Math.random() * 40 + (this.stage === 2 ? 60 : 0));
    else if (type === 'B') e.setVelocity(0, 110 + Math.random() * 30 + (this.stage === 2 ? 40 : 0));
    else { e.setVelocity(0, 160); e.hoverY = this.h * 0.28 + Math.random() * 60; }
    return e;
  };
  StgScene.prototype.freeBullet = function (b) {
    b.setActive(false).setVisible(false); b.body.enable = false; b.setPosition(-100, -100); try { b.body.stop(); } catch (e) {}
  };
  StgScene.prototype.freeEnemy = function (e) {
    e.setActive(false).setVisible(false); e.body.enable = false; e.setPosition(-100, -100); try { e.body.stop(); } catch (e2) {}
  };

  // 扇形发射（敌弹幕）
  StgScene.prototype.fireFan = function (x, y, count, spreadDeg, speed, blue) {
    var mid = (count - 1) / 2;
    for (var i = 0; i < count; i++) {
      var ang = 90 + (i - mid) * spreadDeg; // 90° 向下
      var b = this.allocEBullet(x, y, blue);
      if (!b) continue;
      var rad = ang * Math.PI / 180;
      b.setVelocity(Math.cos(rad) * speed, Math.sin(rad) * speed);
    }
  };
  StgScene.prototype.fireAimed = function (x, y, n, speed) {
    var tx = this.player.x, ty = this.player.y;
    var base = Math.atan2(ty - y, tx - x);
    var spread = 12 * Math.PI / 180;
    var mid = (n - 1) / 2;
    for (var i = 0; i < n; i++) {
      var ang = base + (i - mid) * spread;
      var b = this.allocEBullet(x, y, false);
      if (!b) continue;
      b.setVelocity(Math.cos(ang) * speed, Math.sin(ang) * speed);
    }
  };

  StgScene.prototype.spawnPower = function (x, y) {
    var isP = Math.random() < 0.62;
    var p = this.physics.add.sprite(x, y, isP ? 'powerP' : 'powerB');
    p.kind = isP ? 'P' : 'B';
    p.setVelocity(0, 80); p.setDepth(8);
    this.powerups.add(p);
  };

  StgScene.prototype.explode = function (x, y, scale) {
    Sfx.play('explode');
    var c = this.add.circle(x, y, 6, 0xffb74d, 0.9).setDepth(12);
    var self = this;
    this.tweens.add({ targets: c, radius: 6 * (scale || 1) * 4, alpha: 0, duration: 260, onComplete: function () { c.destroy(); } });
    // 额外扩散圆
    var c2 = this.add.circle(x, y, 4, 0xffffff, 0).setStrokeStyle(2, 0xff7043, 1).setDepth(12);
    this.tweens.add({ targets: c2, scale: (scale || 1) * 3, alpha: 0, duration: 300, onComplete: function () { c2.destroy(); } });
  };

  StgScene.prototype.showCenter = function (txt, ms) {
    var self = this;
    this.centerText.setText(txt).setVisible(true).setAlpha(1);
    this.time.delayedCall(ms || 1200, function () {
      self.tweens.add({ targets: self.centerText, alpha: 0, duration: 400, onComplete: function () { self.centerText.setVisible(false).setAlpha(1); } });
    });
  };

  StgScene.prototype.useBomb = function () {
    if (this.bombs <= 0 || this.over) return;
    this.bombs -= 1; Sfx.play('bomb');
    // 全屏消弹
    var ebs = this.eBullets.getChildren();
    for (var i = 0; i < ebs.length; i++) if (ebs[i].active) this.freeBullet(ebs[i]);
    // 对场上敌机与 Boss 伤害 + 爆炸
    var ens = this.enemies.getChildren();
    for (var j = 0; j < ens.length; j++) {
      var en = ens[j]; if (!en.active) continue;
      this.explode(en.x, en.y, 1.2);
      en.hp -= 2;
      if (en.hp <= 0) { this.onEnemyDead(en, true); }
    }
    if (this.boss && this.boss.active) {
      this.damageBoss(CFG.BOMB_DAMAGE);
      this.explode(this.boss.x, this.boss.y, 2);
    }
    // 闪白
    var flash = this.add.rectangle(this.w / 2, this.h / 2, this.w, this.h, 0xffffff, 0.55).setDepth(25);
    this.tweens.add({ targets: flash, alpha: 0, duration: 280, onComplete: function () { flash.destroy(); } });
    this.updateHud();
  };

  StgScene.prototype.onEnemyDead = function (en, noScore) {
    var x = en.x, y = en.y;
    this.freeEnemy(en);
    this.explode(x, y, 1);
    if (!noScore) {
      this.score += 100; if (this.stage === 2) this.score += 20;
      this.updateHud();
      Sfx.play('hit');
      if (Math.random() < 0.22) this.spawnPower(x, y);
    }
  };

  StgScene.prototype.damageBoss = function (dmg) {
    if (!this.boss || !this.boss.active) return;
    this.boss.hp -= dmg;
    if (this.boss.hp < 0) this.boss.hp = 0;
    // 弹幕模式随血量切换：阈值 66% / 33%
    var ratio = this.bossHpMax ? this.boss.hp / this.bossHpMax : 0;
    if (ratio <= 0.33) this.boss.phaseMode = 2;
    else if (ratio <= 0.66) this.boss.phaseMode = 1;
    else this.boss.phaseMode = 0;
    this.updateBossBar();
    if (this.boss.hp <= 0) this.killBoss();
  };

  StgScene.prototype.killBoss = function () {
    var x = this.boss.x, y = this.boss.y;
    for (var k = 0; k < 5; k++) this.explode(x + Phaser.Math.Between(-30, 30), y + Phaser.Math.Between(-20, 20), 1.6);
    Sfx.play('explode');
    try { this.boss.destroy(); } catch (e) { this.boss.setActive(false).setVisible(false); }
    this.boss = null;
    this.bossBar.setVisible(false); this.bossBarBg.setVisible(false); this.bossName.setVisible(false);
    this.score += 2000; this.updateHud();
    if (this.stage === 1) {
      // 进入 Stage2
      this.stage = 2; this.schedule = STAGE2_SCHEDULE.slice(); this.spawnIdx = 0; this.stageTime = 0;
      if (reachedStage < 2) { reachedStage = 2; this.saveProgress(); }
      this.createBackground();
      this.stageText.setText('STAGE 2 — 夜间基地');
      this.showCenter('STAGE 2\n夜间基地', 1600);
      Sfx.play('alarm');
    } else {
      // 通关
      this.onWin();
    }
  };

  StgScene.prototype.onWin = function () {
    this.over = true; this.clearAll = true;
    var best = Math.max(hiScore, this.score);
    if (this.score > hiScore) { hiScore = this.score; this.saveProgress(); }
    this.showCenter('ALL CLEAR!\nSCORE ' + this.score + '  HI ' + best, 999999);
    // 文字常驻
    this.centerText.setVisible(true);
    var self = this;
    this.time.delayedCall(2200, function () {
      self.add.text(self.w / 2, self.h * 0.68, '按 R 重开  /  炸弹已清屏奖励计入分数', { fontFamily: 'monospace', fontSize: '11px', color: '#b0bec5' }).setOrigin(0.5).setDepth(30);
    });
    Sfx.stopBgm(this);
  };

  StgScene.prototype.onPlayerHit = function () {
    if (this.time.now < this.invUntil || this.over) return;
    this.lives -= 1; Sfx.play('hit');
    this.explode(this.player.x, this.player.y, 1.4);
    this.updateHud();
    if (this.lives <= 0) {
      this.lives = 0; this.gameOver(); return;
    }
    this.invUntil = this.time.now + CFG.INV_MS;
    // 掉一级火力
    if (this.power > 1) this.power -= 1;
    // 清附近弹
    var ebs = this.eBullets.getChildren();
    for (var i = 0; i < ebs.length; i++) {
      var b = ebs[i]; if (!b.active) continue;
      var dx = b.x - this.player.x, dy = b.y - this.player.y;
      if (dx * dx + dy * dy < 64 * 64) this.freeBullet(b);
    }
  };

  StgScene.prototype.gameOver = function () {
    this.over = true;
    if (this.score > hiScore) { hiScore = this.score; this.saveProgress(); }
    this.centerText.setText('GAME OVER\nSCORE ' + this.score + '  HI ' + Math.max(hiScore, this.score) + '\n\n按 R 重开').setVisible(true).setAlpha(1);
    Sfx.stopBgm(this);
  };

  StgScene.prototype.saveProgress = function () {
    if (!hostRef || typeof hostRef.saveState !== 'function') return;
    try { hostRef.saveState({ hiScore: hiScore, reachedStage: reachedStage }); } catch (e) {}
  };

  StgScene.prototype.updateHud = function () {
    this.hudScore.setText('SCORE ' + this.score + '  HI ' + Math.max(hiScore, this.score));
    var pStr = this.power === 1 ? '●○○' : (this.power === 2 ? '●●○' : '●●●');
    this.hudInfo.setText('LIVES ' + this.lives + '  BOMBS ' + this.bombs + '  POWER ' + pStr);
  };
  StgScene.prototype.updateBossBar = function () {
    if (!this.boss || !this.bossHpMax) return;
    var r = this.boss.hp / this.bossHpMax;
    if (r < 0) r = 0;
    this.bossBar.setDisplaySize((this.w - 24) * r, 8);
  };

  StgScene.prototype.spawnBoss = function () {
    Sfx.play('alarm');
    if (this.stage === 1) {
      var b1 = this.physics.add.sprite(this.w / 2, -60, 'boss1');
      b1.setDepth(9); b1.hp = 120; b1.phaseMode = 0; b1.shootCd = 0;
      try { b1.body.setCircle(30); } catch (e) { b1.body.setSize(60, 60); }
      b1.setVelocity(0, 90);
      this.boss = b1; this.bossHpMax = 120;
      this.bossName.setText('BOSS 1 — 云海领主').setVisible(true);
    } else {
      var b2 = this.physics.add.sprite(this.w / 2, -60, 'boss2');
      b2.setDepth(9); b2.hp = 180; b2.phaseMode = 0; b2.shootCd = 0;
      try { b2.body.setCircle(30); } catch (e2) { b2.body.setSize(70, 60); }
      b2.setVelocity(0, 90);
      this.boss = b2; this.bossHpMax = 180;
      this.bossName.setText('BOSS 2 — 基地要塞').setVisible(true);
    }
    this.bossBarBg.setVisible(true); this.bossBar.setVisible(true);
    this.bossBar.setDisplaySize(this.w - 24, 8);
    this.showCenter('WARNING — BOSS', 1100);
  };

  // -------------------------------------------------------------------------
  // 每帧更新
  // -------------------------------------------------------------------------
  StgScene.prototype.update = function (time, delta) {
    if (this.over) {
      if (Phaser.Input.Keyboard.JustDown(this.keys.R) || Phaser.Input.Keyboard.JustDown(this.keys.P)) {
        Sfx.stopBgm(this); this.scene.restart(); return;
      }
      // 通关/死亡后也允许炸弹键重开为彩蛋
      if (Phaser.Input.Keyboard.JustDown(this.bombKey)) { Sfx.stopBgm(this); this.scene.restart(); return; }
      return;
    }

    var dt = delta / 1000;
    this.stageTime += delta;

    // ---- 背景滚动（视差向下） ----
    for (var ci = 0; ci < this.bgClouds.length; ci++) {
      var cl = this.bgClouds[ci]; cl.y += cl.speed * dt;
      if (cl.y > this.h + 30) { cl.y = -30; cl.x = Phaser.Math.Between(20, this.w - 20); }
    }
    for (var si = 0; si < this.bgStars.length; si++) {
      var st = this.bgStars[si]; st.y += st.speed * dt;
      if (st.y > this.h + 4) { st.y = -4; st.x = Phaser.Math.Between(0, this.w); }
    }
    for (var bi = 0; bi < this.bgBases.length; bi++) {
      var bs = this.bgBases[bi]; bs.y += bs.speed * dt;
      if (bs.y > this.h + 30) bs.y = -140;
    }

    // ---- 玩家 8 向移动（WAD+方向键），限制在下 2/3 ----
    var dx = 0, dy = 0;
    if (this.keys.A.isDown || this.keys.LEFT.isDown) dx -= 1;
    if (this.keys.D.isDown || this.keys.RIGHT.isDown) dx += 1;
    if (this.keys.W.isDown || this.keys.UP.isDown) dy -= 1;
    if (this.keys.S.isDown || this.keys.DOWN.isDown) dy += 1;
    var slow = this.keys.SHIFT.isDown;
    var len = Math.hypot(dx, dy) || 1;
    if (dx !== 0 || dy !== 0) { dx /= len; dy /= len; }
    var spd = slow ? CFG.PLAYER_SLOW : CFG.PLAYER_SPEED;
    // 直接改坐标（arcade body 跟随），避免速度累计
    this.player.x += dx * spd * dt;
    this.player.y += dy * spd * dt;
    // 下 2/3 限制：y ∈ [H/3, H-12]
    var minY = this.h / 3, maxY = this.h - 12, minX = 12, maxX = this.w - 12;
    if (this.player.x < minX) this.player.x = minX;
    if (this.player.x > maxX) this.player.x = maxX;
    if (this.player.y < minY) this.player.y = minY;
    if (this.player.y > maxY) this.player.y = maxY;
    try { this.player.body.reset(this.player.x, this.player.y); } catch (e) {}
    // 判定点：低速显
    var showDot = !!slow;
    this.hitDot.setPosition(this.player.x, this.player.y).setVisible(showDot);
    this.hitDotStroke.setPosition(this.player.x, this.player.y).setVisible(showDot);
    // 无敌闪烁
    if (time < this.invUntil) this.player.setAlpha(time % 120 < 60 ? 0.35 : 1);
    else if (this.player.alpha !== 1) this.player.setAlpha(1);

    // ---- 连射（Z / Space 池化）----
    var firing = this.keys.Z.isDown || this.keys.SPACE.isDown;
    if (firing && time >= this.nextFireAt) {
      this.nextFireAt = time + CFG.PLAYER_FIRE_MS;
      Sfx.play('shoot');
      var px = this.player.x, py = this.player.y - 14;
      if (this.power === 1) {
        var b0 = this.allocPBullet(px, py); if (b0) b0.setVelocity(0, -CFG.PLAYER_BULLET_SPEED);
      } else if (this.power === 2) {
        var b1 = this.allocPBullet(px - 8, py + 4); if (b1) b1.setVelocity(0, -CFG.PLAYER_BULLET_SPEED);
        var b2 = this.allocPBullet(px + 8, py + 4); if (b2) b2.setVelocity(0, -CFG.PLAYER_BULLET_SPEED);
      } else {
        var bm = this.allocPBullet(px, py); if (bm) bm.setVelocity(0, -CFG.PLAYER_BULLET_SPEED);
        var bl = this.allocPBullet(px - 12, py + 6); if (bl) bl.setVelocity(-70, -CFG.PLAYER_BULLET_SPEED);
        var br = this.allocPBullet(px + 12, py + 6); if (br) br.setVelocity(70, -CFG.PLAYER_BULLET_SPEED);
      }
    }

    // 炸弹
    if (Phaser.Input.Keyboard.JustDown(this.bombKey)) this.useBomb();

    // ---- Spawn 时间表 ----
    if (!this.boss) {
      while (this.spawnIdx < this.schedule.length && this.schedule[this.spawnIdx].t <= this.stageTime) {
        var sp = this.schedule[this.spawnIdx++];
        this.allocEnemy(sp.x, -24, sp.type);
      }
      // 时间表跑完且场上无敌 → 出 Boss
      if (this.spawnIdx >= this.schedule.length && this.enemies.countActive(true) === 0) {
        // 延迟 800ms 再出，避免与最后一批重叠
        if (this.stageTime > this.schedule[this.schedule.length - 1].t + 800) this.spawnBoss();
      }
    }

    // ---- 敌机行为 ----
    var ens = this.enemies.getChildren();
    for (var ei2 = 0; ei2 < ens.length; ei2++) {
      var en2 = ens[ei2]; if (!en2.active) continue;
      if (en2.enemyType === 'B') {
        // 正弦左右摆动
        en2.phase += delta * 0.0035;
        en2.x += Math.sin(en2.phase) * 1.8;
        try { en2.body.reset(en2.x, en2.y); } catch (e3) {}
      } else if (en2.enemyType === 'C') {
        // 停留散射：到 hoverY 后悬停并发射
        if (en2.y >= en2.hoverY && en2.body.velocity.y !== 0) {
          en2.setVelocity(0, 0);
          en2.hoverT = time;
        }
        if (en2.body.velocity.y === 0) {
          // 轻微左右漂移
          en2.x += Math.sin(time * 0.0015 + en2.phase) * 0.9;
          try { en2.body.reset(en2.x, en2.y); } catch (e4) {}
          if (time - en2.hoverT > 900 && time - en2.lastShot > 1100) {
            en2.lastShot = time;
            this.fireFan(en2.x, en2.y + 14, 7, 14, CFG.ENEMY_BULLET_SPEED, false);
          }
        }
      } else {
        // A 直线，偶发单发
        if (time - en2.lastShot > 1400 && en2.y > 40 && en2.y < this.h * 0.6) {
          if (Math.random() < 0.45) {
            en2.lastShot = time;
            var eb1 = this.allocEBullet(en2.x, en2.y + 12, false);
            if (eb1) {
              var ang = Math.atan2(this.player.y - en2.y, this.player.x - en2.x);
              eb1.setVelocity(Math.cos(ang) * CFG.ENEMY_BULLET_SPEED, Math.sin(ang) * CFG.ENEMY_BULLET_SPEED);
            }
          }
        }
      }
      // 出界回收
      if (en2.y > this.h + 40 || en2.x < -40 || en2.x > this.w + 40) this.freeEnemy(en2);
    }

    // ---- Boss 行为（多血多模式随血切）----
    if (this.boss && this.boss.active) {
      var bo = this.boss;
      // 入场到 y=110 后悬停
      if (bo.y < 110 && bo.body.velocity.y > 0) {
        bo.y += bo.body.velocity.y * dt;
        try { bo.body.reset(bo.x, bo.y); } catch (e5) {}
        if (bo.y >= 110) { bo.setVelocity(0, 0); bo.y = 110; try { bo.body.reset(bo.x, bo.y); } catch (e6) {} }
      } else if (bo.y >= 110) {
        // 悬停横移
        bo.x += Math.sin(time * 0.0009 + (this.stage === 2 ? 1 : 0)) * 1.6;
        try { bo.body.reset(bo.x, bo.y); } catch (e7) {}
        // 射击节拍
        if (time - bo.shootCd > 780) {
          bo.shootCd = time;
          if (this.stage === 1) {
            // Boss1：3 阶段 — 0 扇形5、1 瞄准3+扇形、2 环形12
            if (bo.phaseMode === 0) this.fireFan(bo.x, bo.y + 30, 5, 16, 200, false);
            else if (bo.phaseMode === 1) { this.fireAimed(bo.x, bo.y + 30, 3, 230); this.fireFan(bo.x, bo.y + 30, 5, 18, 190, true); }
            else {
              for (var ri = 0; ri < 12; ri++) {
                var ang2 = ri * 30 * Math.PI / 180;
                var rb = this.allocEBullet(bo.x, bo.y + 20, true);
                if (rb) rb.setVelocity(Math.cos(ang2) * 180, Math.sin(ang2) * 180);
              }
            }
          } else {
            // Boss2：更密 — 0 扇形7、1 十字+瞄准、2 螺旋环
            if (bo.phaseMode === 0) this.fireFan(bo.x, bo.y + 30, 7, 14, 210, true);
            else if (bo.phaseMode === 1) {
              this.fireAimed(bo.x, bo.y + 30, 5, 240);
              for (var ci2 = 0; ci2 < 4; ci2++) {
                var a4 = ci2 * 90 * Math.PI / 180;
                var fb = this.allocEBullet(bo.x, bo.y + 20, false);
                if (fb) fb.setVelocity(Math.cos(a4) * 170, Math.sin(a4) * 170);
              }
            } else {
              var baseA = (time * 0.12) % 360;
              for (var si2 = 0; si2 < 10; si2++) {
                var angS = (baseA + si2 * 36) * Math.PI / 180;
                var sb = this.allocEBullet(bo.x, bo.y + 20, si2 % 2 === 0);
                if (sb) sb.setVelocity(Math.cos(angS) * 200, Math.sin(angS) * 200);
              }
            }
          }
        }
      }
    }

    // ---- 自机弹 vs 敌 / Boss（contains 兼容 overlap 顺序陷阱）----
    var pbs = this.pBullets.getChildren();
    for (var pbi = 0; pbi < pbs.length; pbi++) {
      var pb2 = pbs[pbi]; if (!pb2.active) continue;
      if (pb2.y < -20) { this.freeBullet(pb2); continue; }
      // 撞敌
      var hitEn = null;
      for (var ej = 0; ej < ens.length; ej++) {
        var ce = ens[ej]; if (!ce.active) continue;
        var dxh = pb2.x - ce.x, dyh = pb2.y - ce.y;
        if (dxh * dxh + dyh * dyh < 18 * 18) { hitEn = ce; break; }
      }
      if (hitEn) {
        this.freeBullet(pb2);
        hitEn.hp -= 1;
        if (hitEn.hp <= 0) this.onEnemyDead(hitEn, false);
        else Sfx.play('hit');
        continue;
      }
      if (this.boss && this.boss.active) {
        var dxb = pb2.x - this.boss.x, dyb = pb2.y - this.boss.y;
        if (dxb * dxb + dyb * dyb < 32 * 32) {
          this.freeBullet(pb2);
          this.damageBoss(1); Sfx.play('hit');
        }
      }
    }

    // ---- 敌弹 vs 自机（小半径判定：仅撞 PLAYER_RADIUS）----
    var ebs2 = this.eBullets.getChildren();
    for (var ebi = 0; ebi < ebs2.length; ebi++) {
      var eb2 = ebs2[ebi]; if (!eb2.active) continue;
      if (eb2.y > this.h + 20 || eb2.y < -20 || eb2.x < -20 || eb2.x > this.w + 20) { this.freeBullet(eb2); continue; }
      var dxp = eb2.x - this.player.x, dyp = eb2.y - this.player.y;
      var rSum = CFG.PLAYER_RADIUS + 4; // 敌弹半径约 4
      if (dxp * dxp + dyp * dyp < rSum * rSum) {
        this.freeBullet(eb2);
        this.onPlayerHit();
      }
    }

    // ---- 敌机体撞自机（同样小半径）----
    for (var ek = 0; ek < ens.length; ek++) {
      var ekEn = ens[ek]; if (!ekEn.active) continue;
      var dxc = ekEn.x - this.player.x, dyc = ekEn.y - this.player.y;
      if (dxc * dxc + dyc * dyc < (CFG.PLAYER_RADIUS + 12) * (CFG.PLAYER_RADIUS + 12)) {
        this.explode(ekEn.x, ekEn.y, 1.1);
        this.freeEnemy(ekEn);
        this.onPlayerHit();
      }
    }
    // Boss 体撞
    if (this.boss && this.boss.active) {
      var dxbc = this.boss.x - this.player.x, dybc = this.boss.y - this.player.y;
      if (dxbc * dxbc + dybc * dybc < 38 * 38) this.onPlayerHit();
    }

    // ---- 道具拾取（overlap 顺序无关，contains 判断）----
    var pws = this.powerups.getChildren();
    for (var pwk = 0; pwk < pws.length; pwk++) {
      var pw = pws[pwk]; if (!pw.active) continue;
      if (pw.y > this.h + 20) { pw.destroy(); continue; }
      var dxw = pw.x - this.player.x, dyw = pw.y - this.player.y;
      if (Math.abs(dxw) < 18 && Math.abs(dyw) < 18) {
        Sfx.play('pickup');
        if (pw.kind === 'P') { if (this.power < 3) this.power += 1; this.score += 200; }
        else { this.bombs += 1; this.score += 150; }
        this.updateHud();
        pw.destroy();
      }
    }

    // 分数随时间微增（生存奖励）
    if (time % 500 < delta) { this.score += 1; this.updateHud(); }
  };

  // ---------------------------------------------------------------------------
  // Phaser.Game 启动 — 同步注册
  // ---------------------------------------------------------------------------
  function launch(host) {
    hostRef = host;
    var w = host.width || CFG.W, h = host.height || CFG.H;
    // 纵版：若宿主给定横版，按比例取纵向
    var config = {
      type: Phaser.AUTO,
      parent: host.container,
      width: w,
      height: h,
      backgroundColor: '#87ceeb',
      physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: [BootScene, MenuScene, StgScene]
    };
    var game = new Phaser.Game(config);
    window.__trgame = { game: game, getState: getState };
    return game;
  }

  if (typeof window.TRGames !== 'undefined' && typeof window.TRGames.register === 'function') {
    window.TRGames.register({ id: 'stg-vertical', title: 'Vertical STG', launch: launch });
  }
})();
