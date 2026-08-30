// =============================================================================
// 【资产替换清单】arpg-zelda / Zelda ARPG v0.1.0
// =============================================================================
// 视觉占位（全部程序化，零外部图片，generateTexture / Graphics 绘制）：
//   - 地砖/墙：Graphics 矩形 + 边框（见 createTileTextures）
//     将来替换：this.load.image('tile_floor','floor.png')
//               this.load.image('tile_wall','wall.png')
//   - 草：绿色小丛 Graphics，可被剑割除
//     将来替换：this.load.image('grass','grass.png')
//   - 宝箱：Graphics 宝箱闭/开两帧
//     将来替换：this.load.spritesheet('chest','chest.png',{frameWidth:32,frameHeight:32})
//   - 俯视小人：generateTexture 16x16 胶囊 + 朝向箭头（player）
//     将来替换：this.load.spritesheet('player','player.png',{frameWidth:16,frameHeight:16})
//   - 剑矩形：攻击帧可见的 Graphics 矩形（16px 剑身），非攻击帧不渲染/无碰撞
//     将来替换：this.load.image('sword','sword.png')
//   - 敌人几何：史莱姆/蝙蝠/骷髅/骑士 纯 Graphics 圆/三角/矩形
//     将来替换：this.load.image('slime','slime.png') 等
//   - 箱子/开关/门：Graphics 方块/圆/门框
//     将来替换：this.load.image('box','box.png') 等
// 音频占位（WebAudio oscillator / noise）：
//   - 将来替换：this.load.audio('bgm_village','bgm_village.ogg')
//               this.load.audio('se_sword','sword.ogg')
//               并用 this.sound.play 替代 Sfx.play
// 地图说明：tile 数组数字含义 0地板 1墙 2草 3宝箱 4锁门 5开关 6箱子 7BOSS门
// =============================================================================
(function () {
  'use strict';
  // ---------------------------------------------------------------------------
  // 可调参数（带单位）
  // ---------------------------------------------------------------------------
  var W = 640; // 舞台宽 px
  var H = 480; // 舞台高 px
  var TILE = 32; // 瓦片边长 px
  var COLS = 20; // 地图列数
  var ROWS = 15; // 地图行数
  var PLAYER_SPEED = 140; // 移动速度 px/s
  var DASH_SPEED = 260; // 冲刺速度 px/s
  var DASH_TIME = 160; // 冲刺持续 ms
  var DASH_COOLDOWN = 420; // 冲刺冷却 ms
  var SWORD_TIME = 220; // 挥剑总时长 ms
  var SWORD_ACTIVE_FROM = 60; // 剑 hitbox 激活起点 ms
  var SWORD_ACTIVE_TO = 150; // 剑 hitbox 激活终点 ms
  var SWORD_LEN = 16; // 剑身长度 px（矩形长边）
  var SWORD_W = 12; // 剑身宽度 px
  var ARROW_SPEED = 240; // 箭速 px/s
  var ARROW_COOLDOWN = 420; // 远程冷却 ms
  var ENEMY_HIT_IFRAME = 420; // 敌人受击无敌 ms
  var PLAYER_IFRAME = 900; // 玩家受击无敌 ms
  var PLAYER_KNOCK = 120; // 玩家受击击退 px
  var ENEMY_KNOCK = 18; // 敌人受击击退 px
  var BGM_VOL = 0.14;


  // ---------------------------------------------------------------------------
  // 存档与状态（闭包）
  // ---------------------------------------------------------------------------
  var hostRef = null;
  var gameRef = null;
  var sceneRef = null; // 当前 GameScene
  var saveData = { chapter: 1, hp: 6, maxHp: 6, keys: 0, unlockedChapter: 1 };
  var curChapter = 1; // 1-indexed

  // 地图：0地板 1墙 2草 3宝箱 4锁门 5开关 6箱子 7BOSS门
  // 20x15，手工小图，便于通关测试
  var MAPS = [
    // 章1 村野：外墙+草丛+宝箱+推箱开关+2锁门+BOSS门
    [
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,0,0,2,0,0,0,1,0,0,0,0,0,1,0,0,2,0,0,1],
      [1,0,0,2,0,3,0,1,0,0,6,0,0,1,0,0,2,0,0,1],
      [1,0,0,0,0,0,0,0,0,0,0,0,5,1,0,0,0,0,0,1],
      [1,1,1,4,1,1,1,1,1,1,1,1,1,1,1,1,1,4,1,1],
      [1,0,0,0,0,2,0,0,0,0,0,0,0,0,0,2,0,0,0,1],
      [1,0,2,0,0,2,0,1,1,1,1,1,1,1,0,2,0,3,0,1],
      [1,0,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1],
      [1,0,0,6,0,0,0,1,0,0,0,0,0,1,0,0,6,0,0,1],
      [1,0,2,0,0,0,0,1,0,5,0,0,0,1,0,2,0,0,0,1],
      [1,1,1,1,1,1,0,1,0,0,0,0,0,1,0,1,1,1,1,1],
      [1,0,0,0,0,1,0,1,0,0,1,1,0,1,0,1,0,0,0,1],
      [1,0,3,0,0,1,0,0,0,0,1,1,0,0,0,1,0,2,0,1],
      [1,0,0,0,0,1,0,0,0,0,1,1,0,0,0,1,7,0,0,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    ],
    // 章2 神殿：更密集解谜
    [
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,0,0,0,1,0,0,2,0,0,0,0,2,0,0,1,0,0,0,1],
      [1,0,3,0,1,0,6,0,0,1,1,1,0,0,6,1,0,3,0,1],
      [1,0,0,0,1,0,0,0,0,1,5,1,0,0,0,1,0,0,0,1],
      [1,1,4,1,1,1,1,4,1,1,0,1,1,1,1,1,1,4,1,1],
      [1,0,0,0,0,0,0,0,0,1,0,1,0,0,0,0,0,0,0,1],
      [1,0,2,2,0,1,1,1,0,1,0,1,0,1,1,1,0,2,0,1],
      [1,0,0,0,0,1,0,0,0,1,0,1,0,0,0,1,0,0,0,1],
      [1,0,6,0,0,1,0,5,0,0,0,0,0,5,0,1,0,6,0,1],
      [1,0,0,0,0,1,0,0,0,1,0,1,0,0,0,1,0,0,0,1],
      [1,1,1,1,1,1,1,1,0,1,0,1,0,1,1,1,1,1,1,1],
      [1,0,0,0,0,0,0,1,0,0,0,1,0,1,0,0,0,0,0,1],
      [1,0,2,0,3,0,0,1,1,1,1,1,1,1,0,0,2,0,0,1],
      [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,7,0,0,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    ]
  ];

  // 敌人初始布局（每章） [{x,y,type}] type: slime/bat/skeleton/knight
  var ENEMY_LAYOUT = [
    // 章1
    [
      { x: 4, y: 2, t: 'slime' }, { x: 9, y: 6, t: 'slime' },
      { x: 6, y: 2, t: 'bat' }, { x: 15, y: 7, t: 'bat' },
      { x: 3, y: 12, t: 'skeleton' },
      { x: 10, y: 8, t: 'knight' },
    ],
    // 章2
    [
      { x: 4, y: 2, t: 'slime' }, { x: 8, y: 8, t: 'slime' }, { x: 14, y: 7, t: 'slime' },
      { x: 6, y: 6, t: 'bat' }, { x: 15, y: 3, t: 'bat' },
      { x: 3, y: 8, t: 'skeleton' }, { x: 16, y: 8, t: 'skeleton' },
      { x: 10, y: 6, t: 'knight' }, { x: 12, y: 12, t: 'knight' },
    ]
  ];

  // ---------------------------------------------------------------------------
  // 音频（WebAudio 占位，中文注释：将来替换为 this.load.audio）
  // ---------------------------------------------------------------------------
  var Sfx = {
    ctx: null, master: null, bgmTimer: null, bgmOn: false, chapter: 1,
    ensure: function () {
      if (this.ctx) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.22;
        this.master.connect(this.ctx.destination);
      } catch (e) {}
    },
    resume: function () { try { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); } catch (e) {} },
    tone: function (freq, dur, type, vol, slide) {
      try {
        if (!this.ctx) this.ensure();
        if (!this.ctx) return;
        var o = this.ctx.createOscillator();
        var g = this.ctx.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        g.gain.value = vol || 0.18;
        o.connect(g); g.connect(this.master);
        o.start();
        if (slide) o.frequency.linearRampToValueAtTime(slide, this.ctx.currentTime + dur);
        g.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
        o.stop(this.ctx.currentTime + dur + 0.02);
      } catch (e) {}
    },
    noise: function (dur, vol) {
      try {
        if (!this.ctx) this.ensure();
        if (!this.ctx) return;
        var len = Math.floor(this.ctx.sampleRate * dur);
        var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        var src = this.ctx.createBufferSource(); src.buffer = buf;
        var g = this.ctx.createGain(); g.gain.value = vol || 0.18;
        var f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200;
        src.connect(f); f.connect(g); g.connect(this.master);
        src.start();
      } catch (e) {}
    },
    play: function (name) {
      if (name === 'sword') { this.tone(720, 0.09, 'square', 0.18, 380); this.tone(520, 0.10, 'sine', 0.10); }
      else if (name === 'hit') { this.tone(180, 0.14, 'square', 0.22, 60); }
      else if (name === 'hurt') { this.tone(220, 0.22, 'sawtooth', 0.20, 120); this.tone(150, 0.24, 'sine', 0.12); }
      else if (name === 'chest') { this.tone(440, 0.12, 'sine', 0.16); var self = this; setTimeout(function () { self.tone(660, 0.14, 'sine', 0.16); }, 120); setTimeout(function () { self.tone(880, 0.18, 'sine', 0.14); }, 240); }
      else if (name === 'puzzle') { this.tone(523, 0.12, 'sine', 0.16); var s = this; setTimeout(function () { s.tone(659, 0.12, 'sine', 0.16); }, 110); setTimeout(function () { s.tone(784, 0.22, 'sine', 0.15); }, 220); }
      else if (name === 'arrow') { this.tone(900, 0.06, 'square', 0.12, 1200); }
      else if (name === 'grass') { this.noise(0.12, 0.12); }
      else if (name === 'door') { this.tone(300, 0.20, 'triangle', 0.16, 180); }
      else if (name === 'key') { this.tone(880, 0.10, 'sine', 0.15); }
      else if (name === 'win') { this.tone(523, 0.18, 'sine', 0.16); var t = this; setTimeout(function () { t.tone(659, 0.18, 'sine', 0.16); }, 160); setTimeout(function () { t.tone(784, 0.30, 'sine', 0.16); }, 320); }
    },
    startBgm: function (chapter) {
      this.stopBgm();
      this.bgmOn = true; this.chapter = chapter;
      var self = this;
      var tick = function () {
        if (!self.bgmOn) return;
        try {
          if (chapter === 1) {
            self.tone(220, 0.45, 'triangle', 0.07); setTimeout(function () { self.tone(277, 0.45, 'triangle', 0.06); }, 260);
            setTimeout(function () { self.tone(330, 0.45, 'triangle', 0.06); }, 520);
          } else {
            self.tone(165, 0.55, 'triangle', 0.08); setTimeout(function () { self.tone(196, 0.55, 'triangle', 0.06); }, 320);
            setTimeout(function () { self.tone(147, 0.55, 'triangle', 0.06); }, 640);
          }
        } catch (e) {}
      };
      tick();
      this.bgmTimer = setInterval(tick, chapter === 1 ? 900 : 1100);
    },
    stopBgm: function () { this.bgmOn = false; if (this.bgmTimer) { clearInterval(this.bgmTimer); this.bgmTimer = null; } }
  };

  // ---------------------------------------------------------------------------
  // 存档 helper
  // ---------------------------------------------------------------------------
  function persist() {
    try { if (hostRef && hostRef.saveState) hostRef.saveState({ chapter: saveData.chapter, hp: saveData.hp, maxHp: saveData.maxHp, keys: saveData.keys, unlockedChapter: saveData.unlockedChapter }); } catch (e) {}
  }
  function loadPersisted() {
    try {
      if (hostRef && hostRef.loadState) hostRef.loadState().then(function (s) {
        if (s && typeof s.chapter === 'number') {
          saveData.chapter = s.chapter; saveData.hp = s.hp || 6; saveData.maxHp = s.maxHp || 6; saveData.keys = s.keys || 0; saveData.unlockedChapter = s.unlockedChapter || 1;
          curChapter = saveData.chapter;
        }
      }, function () {});
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 工具：tile 坐标与像素互转、方向
  // ---------------------------------------------------------------------------
  function tileToPx(c, r) { return { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 }; }
  function pxToTile(x, y) { return { c: Math.floor(x / TILE), r: Math.floor(y / TILE) }; }
  // 4 向量化（剑/箭） 0右 1下 2左 3上
  var DIR4 = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
  function vecForDir4(d) { d = ((d % 4) + 4) % 4; return DIR4[d]; }

  // ---------------------------------------------------------------------------
  // Phaser 纹理生成（程序化几何，注释替换点见顶部清单）
  // ---------------------------------------------------------------------------
  function makeTextures(scene) {
    var g;
    // 地板 32x32
    g = scene.add.graphics();
    g.fillStyle(0x8ecae6, 1); g.fillRect(0, 0, 32, 32);
    g.lineStyle(1, 0x7fb8d8, 1); g.strokeRect(0, 0, 32, 32);
    g.fillStyle(0xa9d6e5, 1); g.fillRect(6, 6, 4, 4); g.fillRect(20, 18, 3, 3);
    g.generateTexture('tile_floor', 32, 32); g.destroy();
    // 墙
    g = scene.add.graphics();
    g.fillStyle(0x415a77, 1); g.fillRect(0, 0, 32, 32);
    g.fillStyle(0x778da9, 1); g.fillRect(0, 0, 32, 6); g.fillRect(0, 6, 6, 26);
    g.lineStyle(1, 0x2b3d53, 1); g.strokeRect(0, 0, 32, 32);
    g.generateTexture('tile_wall', 32, 32); g.destroy();
    // 草（小丛）
    g = scene.add.graphics();
    g.fillStyle(0x2a9d8f, 1); g.fillCircle(16, 16, 12); g.fillStyle(0x3ab795, 1); g.fillCircle(12, 14, 6); g.fillCircle(20, 18, 5);
    g.lineStyle(1, 0x1d6b5a, 0.9); g.strokeCircle(16, 16, 12);
    g.generateTexture('grass', 24, 24); g.destroy();
    // 宝箱闭
    g = scene.add.graphics();
    g.fillStyle(0xc68642, 1); g.fillRoundedRect(2, 8, 28, 18, 3); g.fillStyle(0xe9c46a, 1); g.fillRect(14, 8, 4, 18);
    g.fillStyle(0x8b5a2b, 1); g.fillRect(2, 8, 28, 3);
    g.lineStyle(1, 0x5a3a1a, 1); g.strokeRoundedRect(2, 8, 28, 18, 3);
    g.generateTexture('chest_closed', 32, 32); g.destroy();
    // 宝箱开
    g = scene.add.graphics();
    g.fillStyle(0xc68642, 1); g.fillRoundedRect(2, 12, 28, 14, 2); g.fillStyle(0xf1dca7, 1); g.fillRect(6, 6, 20, 10);
    g.fillStyle(0xffd700, 0.9); g.fillCircle(16, 9, 3);
    g.generateTexture('chest_open', 32, 32); g.destroy();
    // 箱子
    g = scene.add.graphics();
    g.fillStyle(0x9c6644, 1); g.fillRect(2, 2, 28, 28); g.lineStyle(1, 0x6b4423, 1); g.strokeRect(2, 2, 28, 28);
    g.lineStyle(1, 0x5a3a1a, 0.6); g.lineBetween(2, 11, 30, 11); g.lineBetween(2, 21, 30, 21); g.lineBetween(11, 2, 11, 30); g.lineBetween(21, 2, 21, 30);
    g.generateTexture('box', 32, 32); g.destroy();
    // 开关 关/开
    g = scene.add.graphics();
    g.fillStyle(0x888888, 1); g.fillCircle(16, 16, 12); g.fillStyle(0xcc4444, 1); g.fillCircle(16, 16, 7);
    g.generateTexture('switch_off', 32, 32); g.destroy();
    g = scene.add.graphics();
    g.fillStyle(0x888888, 1); g.fillCircle(16, 16, 12); g.fillStyle(0x44cc44, 1); g.fillCircle(16, 16, 7); g.fillStyle(0xffffff, 0.9); g.fillCircle(14, 13, 2);
    g.generateTexture('switch_on', 32, 32); g.destroy();
    // 门
    g = scene.add.graphics();
    g.fillStyle(0x3a3a4a, 1); g.fillRect(0, 0, 32, 32); g.fillStyle(0x66667a, 1); g.fillRect(6, 4, 20, 24);
    g.fillStyle(0xffd700, 1); g.fillCircle(20, 16, 3); g.lineStyle(1, 0x222233, 1); g.strokeRect(6, 4, 20, 24);
    g.generateTexture('door_locked', 32, 32); g.destroy();
    g = scene.add.graphics();
    g.fillStyle(0x1a1a2e, 1); g.fillRect(0, 0, 32, 32); g.lineStyle(2, 0x4a4a6a, 1); g.strokeRect(4, 2, 24, 28);
    g.generateTexture('door_open', 32, 32); g.destroy();
    // 玩家 16x16（俯视小人 + 朝向点）
    g = scene.add.graphics();
    g.fillStyle(0xffbe0b, 1); g.fillCircle(8, 8, 7); g.fillStyle(0xffffff, 1); g.fillCircle(8, 6, 2.2); g.fillStyle(0x222222, 1); g.fillCircle(7, 5.5, 0.9); g.fillCircle(9.2, 5.5, 0.9);
    g.fillStyle(0xfb5607, 1); g.fillRect(6, 11, 4, 3);
    g.generateTexture('player', 16, 16); g.destroy();
    // 敌人：史莱姆 绿椭圆
    g = scene.add.graphics();
    g.fillStyle(0x7ac74f, 1); g.fillEllipse(12, 12, 18, 14); g.fillStyle(0xffffff, 0.9); g.fillCircle(9, 9, 3); g.fillCircle(15, 9, 2); g.fillStyle(0x222222, 1); g.fillCircle(9, 10, 1); g.fillCircle(15, 10, 1);
    g.generateTexture('enemy_slime', 24, 24); g.destroy();
    // 蝙蝠
    g = scene.add.graphics();
    g.fillStyle(0x5a189a, 1); g.fillTriangle(4, 14, 12, 6, 20, 14); g.fillStyle(0x9d4edd, 1); g.fillCircle(12, 12, 5); g.fillStyle(0xff0000, 1); g.fillCircle(10, 11, 1); g.fillCircle(14, 11, 1);
    g.generateTexture('enemy_bat', 24, 24); g.destroy();
    // 骷髅
    g = scene.add.graphics();
    g.fillStyle(0xe0e0e0, 1); g.fillCircle(12, 10, 7); g.fillStyle(0x222222, 1); g.fillCircle(9.5, 10, 1.6); g.fillCircle(14.5, 10, 1.6); g.fillStyle(0xaaaaaa, 1); g.fillRect(8, 16, 8, 6);
    g.generateTexture('enemy_skeleton', 24, 24); g.destroy();
    // 骑士
    g = scene.add.graphics();
    g.fillStyle(0x555555, 1); g.fillRect(6, 6, 12, 12); g.fillStyle(0xcccccc, 1); g.fillRect(8, 8, 8, 8); g.fillStyle(0x444444, 1); g.fillRect(10, 2, 4, 6);
    g.generateTexture('enemy_knight', 24, 24); g.destroy();
    // Boss 纹理
    g = scene.add.graphics();
    g.fillStyle(0x4caf50, 1); g.fillCircle(24, 24, 20); g.fillStyle(0x81c784, 1); g.fillCircle(18, 18, 7); g.fillStyle(0x222222, 1); g.fillCircle(18, 20, 2); g.fillCircle(30, 20, 2);
    g.generateTexture('boss_slime', 48, 48); g.destroy();
    g = scene.add.graphics();
    g.fillStyle(0x2b2d42, 1); g.fillRect(8, 8, 32, 40); g.fillStyle(0x8d99ae, 1); g.fillRect(12, 12, 24, 14); g.fillStyle(0xef233c, 1); g.fillRect(18, 18, 12, 4);
    g.generateTexture('boss_knight', 48, 48); g.destroy();
    // 心、钥匙
    g = scene.add.graphics();
    g.fillStyle(0xff006e, 1); g.fillCircle(8, 8, 6); g.fillCircle(16, 8, 6); g.fillTriangle(2, 12, 22, 12, 12, 22);
    g.generateTexture('heart', 24, 24); g.destroy();
    g = scene.add.graphics();
    g.fillStyle(0xffd700, 1); g.fillCircle(8, 12, 5); g.fillRect(12, 10, 12, 4); g.fillRect(20, 6, 3, 12);
    g.generateTexture('key', 24, 16); g.destroy();
    // 箭
    g = scene.add.graphics();
    g.fillStyle(0x8b5a2b, 1); g.fillRect(0, 3, 14, 2); g.fillStyle(0xcccccc, 1); g.fillTriangle(14, 1, 14, 7, 20, 4);
    g.generateTexture('arrow', 20, 8); g.destroy();
  }


  // ---------------------------------------------------------------------------
  // Boot / Title / GameScene / Boss
  // ---------------------------------------------------------------------------
  function createBootScene(Phaser) {
    var Boot = function () { Phaser.Scene.call(this, { key: 'Boot' }); };
    Boot.prototype = Object.create(Phaser.Scene.prototype);
    Boot.prototype.constructor = Boot;
    Boot.prototype.create = function () {
      makeTextures(this);
      this.scene.start('Title');
    };
    return Boot;
  }

  function createTitleScene(Phaser) {
    var Title = function () { Phaser.Scene.call(this, { key: 'Title' }); };
    Title.prototype = Object.create(Phaser.Scene.prototype);
    Title.prototype.constructor = Title;
    Title.prototype.create = function () {
      var cx = W / 2, cy = H / 2;
      this.add.rectangle(cx, cy, W, H, 0x0b132b, 1);
      this.add.text(cx, 78, 'ZELDA ARPG', { fontFamily: 'Arial', fontSize: '26px', color: '#ffd166', fontStyle: 'bold' }).setOrigin(0.5);
      this.add.text(cx, 110, '俯视即时动作 · 双章节 · 推箱解谜', { fontFamily: 'Arial', fontSize: '12px', color: '#a8dadc' }).setOrigin(0.5);
      this.add.text(cx, 148, '方向键/WASD 移动  Z/空格挥剑  X弓箭/炸弹  Shift冲刺', { fontFamily: 'Arial', fontSize: '11px', color: '#d8e2dc' }).setOrigin(0.5);
      this.add.text(cx, 168, '推箱子压开关开门 · 钥匙开锁门 · 草可割掉心', { fontFamily: 'Arial', fontSize: '11px', color: '#d8e2dc' }).setOrigin(0.5);
      var ch1 = this.add.rectangle(cx, 220, 220, 36, 0x2a9d8f, 1).setStrokeStyle(2, 0x264653, 1).setInteractive({ useHandCursor: true });
      var t1 = this.add.text(cx, 220, '开始游戏（村野）', { fontFamily: 'Arial', fontSize: '14px', color: '#ffffff' }).setOrigin(0.5);
      var ch2 = this.add.rectangle(cx, 268, 220, 36, saveData.unlockedChapter >= 2 ? 0xe76f51 : 0x555555, 1).setStrokeStyle(2, 0x264653, 1).setInteractive({ useHandCursor: saveData.unlockedChapter >= 2 });
      var t2 = this.add.text(cx, 268, saveData.unlockedChapter >= 2 ? '第二章（神殿）' : '第二章（未解锁）', { fontFamily: 'Arial', fontSize: '14px', color: '#ffffff' }).setOrigin(0.5);
      this.add.text(cx, 310, 'R 重启本章  P 暂停  Enter Boss 调试通关', { fontFamily: 'Arial', fontSize: '10px', color: '#8888aa' }).setOrigin(0.5);
      var self = this;
      ch1.on('pointerdown', function () { Sfx.ensure(); Sfx.resume(); curChapter = 1; saveData.chapter = 1; self.scene.start('Game', { chapter: 1 }); });
      if (saveData.unlockedChapter >= 2) ch2.on('pointerdown', function () { Sfx.ensure(); Sfx.resume(); curChapter = 2; saveData.chapter = 2; self.scene.start('Game', { chapter: 2 }); });
      this.input.keyboard.on('keydown-ONE', function () { curChapter = 1; saveData.chapter = 1; self.scene.start('Game', { chapter: 1 }); });
      this.input.keyboard.on('keydown-TWO', function () { if (saveData.unlockedChapter >= 2) { curChapter = 2; saveData.chapter = 2; self.scene.start('Game', { chapter: 2 }); } });
      this.input.keyboard.on('keydown-ENTER', function () { curChapter = 1; saveData.chapter = 1; self.scene.start('Game', { chapter: 1 }); });
    };
    return Title;
  }

  // 标记：哪些 tile 坐标是墙（阻挡），用于碰撞与推箱
  function buildWallSet(map) {
    var s = {};
    for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) if (map[r][c] === 1) s[c + ',' + r] = true;
    return s;
  }

  function createGameScene(Phaser) {
    var GameScene = function () { Phaser.Scene.call(this, { key: 'Game' }); };
    GameScene.prototype = Object.create(Phaser.Scene.prototype);
    GameScene.prototype.constructor = GameScene;

    GameScene.prototype.init = function (data) {
      this.chapter = (data && data.chapter) ? data.chapter : 1;
      curChapter = this.chapter;
      this.map = JSON.parse(JSON.stringify(MAPS[this.chapter - 1]));
      this.wallSet = buildWallSet(this.map);
      this.keysCount = 0;
      this.hp = saveData.maxHp;
      this.maxHp = saveData.maxHp;
      // room 概念：村野/神殿各一个大房间，BOSS 房为子区域（右下角）
      this.room = 'field';
      this.clearedDoors = {}; // "c,r" -> open
      this.switchOn = {}; // "c,r" -> bool
      this.chestsOpened = {};
      this.boxes = []; // {c,r,sprite}
      this.switches = []; // {c,r,sprite}
      this.doors = []; // {c,r,sprite,keyNeed}
      this.grassGroup = null;
    };

    GameScene.prototype.create = function () {
      sceneRef = this;
      Sfx.startBgm(this.chapter);
      this.cameras.main.setBackgroundColor(this.chapter === 1 ? '#b5e48c' : '#caf0f8');
      // 瓦片层（简单用 image 网格）
      this.tileSprites = [];
      this.walls = this.physics.add.staticGroup();
      this.doorSprites = [];
      for (var r = 0; r < ROWS; r++) {
        for (var c = 0; c < COLS; c++) {
          var v = this.map[r][c];
          var px = c * TILE + TILE / 2, py = r * TILE + TILE / 2;
          var key = (v === 1) ? 'tile_wall' : 'tile_floor';
          var t = this.add.image(px, py, key).setDisplaySize(TILE, TILE);
          this.tileSprites.push(t);
          if (v === 1) {
            var wb = this.add.rectangle(px, py, TILE, TILE, 0, 0);
            this.physics.add.existing(wb, true);
            this.walls.add(wb);
          }
        }
      }
      // 对象层：草/宝箱/箱子/开关/锁门/BOSS门
      this.grassGroup = this.physics.add.staticGroup();
      this.chestGroup = this.physics.add.staticGroup();
      this.boxGroup = this.physics.add.group(); // 推箱用动态
      this.chestSprites = [];
      for (var rr = 0; rr < ROWS; rr++) {
        for (var cc = 0; cc < COLS; cc++) {
          var vv = this.map[rr][cc];
          var pxx = cc * TILE + TILE / 2, pyy = rr * TILE + TILE / 2;
          if (vv === 2) {
            var gr = this.add.image(pxx, pyy, 'grass').setDisplaySize(22, 22);
            this.physics.add.existing(gr, true); this.grassGroup.add(gr);
            gr.setData('tile', { c: cc, r: rr });
          } else if (vv === 3) {
            var ch = this.add.image(pxx, pyy, 'chest_closed').setDisplaySize(28, 28);
            this.physics.add.existing(ch, true); this.chestGroup.add(ch);
            ch.setData('tile', { c: cc, r: rr }); ch.setData('opened', false);
            this.chestSprites.push(ch);
          } else if (vv === 6) {
            var bx = this.physics.add.image(pxx, pyy, 'box').setDisplaySize(30, 30);
            bx.setDrag(900, 900); bx.setMaxVelocity(220, 220);
            bx.setCollideWorldBounds(true);
            bx.setData('tile', { c: cc, r: rr });
            this.boxes.push({ c: cc, r: rr, sprite: bx });
            this.boxGroup.add(bx);
          } else if (vv === 5) {
            var sw = this.add.image(pxx, pyy, 'switch_off').setDisplaySize(26, 26);
            sw.setData('tile', { c: cc, r: rr }); sw.setData('on', false);
            this.switches.push({ c: cc, r: rr, sprite: sw });
          } else if (vv === 4 || vv === 7) {
            var dk = this.add.image(pxx, pyy, 'door_locked').setDisplaySize(30, 30);
            this.physics.add.existing(dk, true); this.walls.add(dk);
            dk.setData('tile', { c: cc, r: rr }); dk.setData('locked', true); dk.setData('isBoss', vv === 7);
            this.doors.push({ c: cc, r: rr, sprite: dk });
          }
        }
      }

      // 玩家
      var start = (this.chapter === 1) ? { c: 2, r: 2 } : { c: 2, r: 12 };
      // 找个空地板
      var sp = tileToPx(start.c, start.r);
      this.player = this.physics.add.sprite(sp.x, sp.y, 'player').setDisplaySize(16, 16);
      this.player.setCollideWorldBounds(true);
      this.player.setSize(12, 12);
      this.player.body.setOffset(2, 2);
      this.physics.add.collider(this.player, this.walls);
      this.physics.add.collider(this.boxGroup, this.walls);
      this.physics.add.collider(this.player, this.boxGroup, this.onPlayerPushBox, null, this);
      // 草：仅剑 hitbox 触发（不在这里做玩家碰撞）
      // 宝箱：交互用距离判定，不做物理碰撞

      // 武器系统
      this.dir4 = 0; // 当前面向 0右
      this.isSwinging = false;
      this.swingStart = 0;
      this.swordHitbox = this.add.rectangle(0, 0, SWORD_LEN, SWORD_W, 0xffbe0b, 0.85).setVisible(false).setDepth(5);
      this.physics.add.existing(this.swordHitbox, false);
      this.swordHitbox.body.setAllowGravity(false);
      this.swordHitbox.body.moves = false;
      this.swordActive = false;

      // 远程（弓箭/炸弹复用箭）：对象池
      this.arrows = this.physics.add.group({ maxSize: 16, runChildUpdate: false });
      this.lastArrowAt = -9999;
      this.usingBomb = false; // X 在章1为弓箭，章2也可，后面统一为弓箭（满足"至少1远程"）

      // 敌人池
      this.enemies = this.physics.add.group({ maxSize: 24, runChildUpdate: false });
      this.enemyBullets = this.physics.add.group({ maxSize: 32, runChildUpdate: false });
      this.spawnEnemies();

      // 掉落
      this.drops = this.physics.add.group();

      // 输入
      this.cursors = this.input.keyboard.createCursorKeys();
      this.keyW = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W);
      this.keyA = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);
      this.keyS = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S);
      this.keyD = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D);
      this.keyZ = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Z);
      this.keyX = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.X);
      this.keyShift = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
      this.keySpace = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
      this.keyR = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
      this.keyP = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.P);
      this.keyEnter = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);

      this.dashUntil = 0; this.dashCdUntil = 0;
      this.hurtUntil = 0;
      this.over = false; this.won = false;
      this.boss = null; this.bossHp = 0; this.bossMax = 0;

      // HUD
      this.hudText = this.add.text(8, 8, '', { fontFamily: 'Arial', fontSize: '12px', color: '#1d3557', backgroundColor: '#ffffffcc' }).setDepth(20).setScrollFactor(0);
      this.msgText = this.add.text(W / 2, 22, '', { fontFamily: 'Arial', fontSize: '11px', color: '#1d3557', backgroundColor: '#ffffffcc' }).setDepth(20).setOrigin(0.5).setScrollFactor(0);
      this.msgUntil = 0;

      this.updateHud();
      this.showMsg('村野' + (this.chapter === 1 ? ' · 草可割 宝箱钥匙 推箱压开关' : '神殿 · 更强敌人+ BOSS 需钥匙'), 2200);

      // 暂停
      this.paused = false;
    };

    GameScene.prototype.spawnEnemies = function () {
      var layout = ENEMY_LAYOUT[this.chapter - 1];
      for (var i = 0; i < layout.length; i++) {
        var e = layout[i];
        this.createEnemy(e.x, e.y, e.t);
      }
    };

    GameScene.prototype.createEnemy = function (c, r, type) {
      var px = c * TILE + TILE / 2, py = r * TILE + TILE / 2;
      var key = 'enemy_' + type;
      var sp = this.physics.add.sprite(px, py, key).setDisplaySize(22, 22);
      sp.setCollideWorldBounds(true);
      sp.setData('type', type); // slime/bat/skeleton/knight
      sp.setData('hp', type === 'knight' ? 3 : (type === 'skeleton' ? 2 : 2));
      sp.setData('maxHp', sp.getData('hp'));
      sp.setData('hurtUntil', 0);
      sp.setData('dir', Math.random() * Math.PI * 2);
      sp.setData('shootCd', 0);
      sp.setData('chargeCd', 0);
      sp.setData('patrolA', { x: px - 40, y: py - 32 });
      sp.setData('patrolB', { x: px + 40, y: py + 32 });
      sp.setData('state', 'patrol');
      this.enemies.add(sp);
      this.physics.add.collider(sp, this.walls);
      return sp;
    };

    GameScene.prototype.onPlayerPushBox = function (player, box) {
      // 推箱：限制为 4 向推一格，简化为靠速度推动后吸附到格子
      // 不在此处瞬移，靠 update 里箱子回正
    };

    GameScene.prototype.trySwing = function () {
      if (this.isSwinging || this.over || this.paused) return;
      this.isSwinging = true; this.swingStart = this.time.now; this.swordActive = false;
      Sfx.play('sword');
      // 剑朝向跟随 dir4
      this.updateSwordPos();
      this.swordHitbox.setVisible(true);
    };

    GameScene.prototype.tryShoot = function () {
      var now = this.time.now;
      if (now - this.lastArrowAt < ARROW_COOLDOWN || this.over || this.paused) return;
      this.lastArrowAt = now;
      var v = vecForDir4(this.dir4);
      var arr = this.arrows.get(this.player.x + v.x * 14, this.player.y + v.y * 14, 'arrow');
      if (!arr) return;
      arr.setActive(true).setVisible(true).setDisplaySize(18, 7).setDepth(6);
      arr.setData('life', 900);
      arr.body.setAllowGravity(false);
      arr.setVelocity(v.x * ARROW_SPEED, v.y * ARROW_SPEED);
      arr.setAngle(v.x === 1 ? 0 : v.x === -1 ? 180 : v.y === 1 ? 90 : -90);
      Sfx.play('arrow');
    };

    GameScene.prototype.updateSwordPos = function () {
      var v = vecForDir4(this.dir4);
      // 矩形中心在玩家前方 (8 + SWORD_LEN/2)
      var cx = this.player.x + v.x * (8 + SWORD_LEN / 2);
      var cy = this.player.y + v.y * (8 + SWORD_LEN / 2);
      this.swordHitbox.setPosition(cx, cy);
      // 横竖摆向：用 angle 简化碰撞仍用 AABB
      if (v.x !== 0) { this.swordHitbox.setSize(SWORD_LEN, SWORD_W); this.swordHitbox.setAngle(0); }
      else { this.swordHitbox.setSize(SWORD_W, SWORD_LEN); this.swordHitbox.setAngle(90); }
      try { this.swordHitbox.body.setSize(this.swordHitbox.width, this.swordHitbox.height); } catch (e) {}
    };

    GameScene.prototype.doDash = function () {
      var now = this.time.now;
      if (now < this.dashCdUntil || now < this.dashUntil || this.paused) return;
      var moving = (this.cursors.left.isDown || this.cursors.right.isDown || this.cursors.up.isDown || this.cursors.down.isDown || this.keyW.isDown || this.keyA.isDown || this.keyS.isDown || this.keyD.isDown);
      if (!moving) return;
      this.dashUntil = now + DASH_TIME;
      this.dashCdUntil = now + DASH_COOLDOWN;
    };

    GameScene.prototype.showMsg = function (t, dur) {
      this.msgText.setText(t); this.msgUntil = this.time.now + (dur || 1400);
    };

    GameScene.prototype.updateHud = function () {
      var hearts = '';
      for (var i = 0; i < this.maxHp; i++) hearts += (i < this.hp ? '♥' : '♡');
      this.hudText.setText('章 ' + this.chapter + '  ' + hearts + ' 钥匙:' + this.keysCount + '  房间:' + this.room + (this.boss ? '  BOSS ' + this.bossHp + '/' + this.bossMax : ''));
    };

    GameScene.prototype.tryOpenChest = function (ch) {
      if (ch.getData('opened')) return;
      var d = Phaser.Math.Distance.Between(this.player.x, this.player.y, ch.x, ch.y);
      if (d > 28) return;
      ch.setData('opened', true); ch.setTexture('chest_open');
      // 掉落钥匙（每章至少2宝箱，首个必钥匙）
      var giveKey = true;
      // 已开数量统计
      var opened = 0; for (var i = 0; i < this.chestSprites.length; i++) if (this.chestSprites[i].getData('opened')) opened++;
      if (opened > 1 && Math.random() < 0.5) giveKey = false;
      if (giveKey) { this.keysCount++; Sfx.play('key'); this.showMsg('获得钥匙 x1', 1200); }
      else { this.dropHeart(ch.x, ch.y - 16); }
      Sfx.play('chest');
      this.updateHud();
    };

    GameScene.prototype.dropHeart = function (x, y) {
      var h = this.physics.add.image(x, y, 'heart').setDisplaySize(18, 18);
      h.setData('type', 'heart');
      this.drops.add(h);
    };
    GameScene.prototype.dropKey = function (x, y) {
      var k = this.physics.add.image(x, y, 'key').setDisplaySize(20, 14);
      k.setData('type', 'key');
      this.drops.add(k);
    };

    GameScene.prototype.tryUseDoor = function () {
      for (var i = 0; i < this.doors.length; i++) {
        var d = this.doors[i].sprite;
        if (!d.getData('locked')) continue;
        var dist = Phaser.Math.Distance.Between(this.player.x, this.player.y, d.x, d.y);
        if (dist > 32) continue;
        var isBoss = d.getData('isBoss');
        if (isBoss) {
          if (this.boss) { this.showMsg('BOSS 已在场', 1000); return; }
          if (this.keysCount <= 0) { this.showMsg('BOSS 房需钥匙', 1200); return; }
          this.keysCount--; this.updateHud();
          d.setData('locked', false); d.setTexture('door_open'); d.body.enable = false;
          Sfx.play('door'); Sfx.play('puzzle');
          this.spawnBoss();
          this.room = 'boss';
          this.showMsg('BOSS 房开启！', 1400);
          this.updateHud();
          return;
        }
        // 普通锁门 ≥2处
        if (this.keysCount <= 0) { this.showMsg('需要钥匙', 1100); return; }
        this.keysCount--; d.setData('locked', false); d.setTexture('door_open'); d.body.enable = false;
        Sfx.play('door');
        this.updateHud(); this.showMsg('门已打开', 1000);
        return;
      }
    };

    GameScene.prototype.spawnBoss = function () {
      var center = tileToPx(16, 13);
      if (this.chapter === 1) {
        var b = this.physics.add.sprite(center.x, center.y - 32, 'boss_slime').setDisplaySize(44, 44).setDepth(7);
        b.setData('type', 'boss_slime'); b.setData('hp', 12); b.setData('maxHp', 12); b.setData('hurtUntil', 0);
        b.setData('jumpCd', 0); b.setData('isBoss', true);
        b.setCollideWorldBounds(true);
        this.physics.add.collider(b, this.walls);
        this.boss = b; this.bossHp = 12; this.bossMax = 12;
        this.enemies.add(b);
      } else {
        var b2 = this.physics.add.sprite(center.x, center.y - 32, 'boss_knight').setDisplaySize(42, 42).setDepth(7);
        b2.setData('type', 'boss_knight'); b2.setData('hp', 16); b2.setData('maxHp', 16); b2.setData('hurtUntil', 0);
        b2.setData('chargeCd', 0); b2.setData('shootCd', 0); b2.setData('isBoss', true);
        b2.setCollideWorldBounds(true);
        this.physics.add.collider(b2, this.walls);
        this.boss = b2; this.bossHp = 16; this.bossMax = 16;
        this.enemies.add(b2);
      }
    };

    GameScene.prototype.checkSwitches = function () {
      var anyChange = false;
      for (var i = 0; i < this.switches.length; i++) {
        var sw = this.switches[i];
        var shouldBeOn = false;
        // 箱子压住即开
        for (var j = 0; j < this.boxes.length; j++) {
          var bx = this.boxes[j].sprite;
          var d = Phaser.Math.Distance.Between(bx.x, bx.y, sw.sprite.x, sw.sprite.y);
          if (d < 16) { shouldBeOn = true; break; }
        }
        // 玩家踩也可
        if (!shouldBeOn) {
          var dp = Phaser.Math.Distance.Between(this.player.x, this.player.y, sw.sprite.x, sw.sprite.y);
          if (dp < 14) shouldBeOn = true;
        }
        if (shouldBeOn !== sw.sprite.getData('on')) {
          sw.sprite.setData('on', shouldBeOn);
          sw.sprite.setTexture(shouldBeOn ? 'switch_on' : 'switch_off');
          anyChange = true;
        }
      }
      if (anyChange) {
        var allOn = true; for (var k = 0; k < this.switches.length; k++) if (!this.switches[k].sprite.getData('on')) allOn = false;
        if (allOn) {
          // 解谜成功：打开所有非BOSS锁门之一（或全部）
          var openedAny = false;
          for (var m = 0; m < this.doors.length; m++) {
            var dd = this.doors[m].sprite;
            if (dd.getData('isBoss')) continue;
            if (dd.getData('locked')) { dd.setData('locked', false); dd.setTexture('door_open'); dd.body.enable = false; openedAny = true; }
          }
          if (openedAny) { Sfx.play('puzzle'); this.showMsg('机关解开！门已打开', 1400); }
        }
      }
    };

    GameScene.prototype.damageEnemy = function (enemy, dmg, fromX, fromY) {
      var now = this.time.now;
      if (now < enemy.getData('hurtUntil')) return false;
      var hp = enemy.getData('hp') - dmg;
      enemy.setData('hp', hp);
      enemy.setData('hurtUntil', now + ENEMY_HIT_IFRAME);
      // 击退（论文推算：按方向推离）
      var dx = enemy.x - fromX, dy = enemy.y - fromY;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      enemy.setVelocity((dx / len) * 220, (dy / len) * 220);
      // 闪烁由 update 处理
      if (hp <= 0) {
        var ex = enemy.x, ey = enemy.y;
        var wasBoss = __omp_shell("!enemy.getData('isBoss');")
        enemy.destroy();
        if (wasBoss && this.boss === enemy) this.boss = null;
        // 掉落心（概率）
        if (Math.random() < 0.55) this.dropHeart(ex, ey);
        if (wasBoss) this.onBossDefeated();
        Sfx.play('hit');
      } else {
        Sfx.play('hit');
      }
      return true;
    };

    GameScene.prototype.onBossDefeated = function () {
      if (this.chapter === 1) {
        this.showMsg('章1 BOSS 击败！进入神殿…', 1800); Sfx.play('win');
        saveData.unlockedChapter = Math.max(saveData.unlockedChapter, 2);
        saveData.chapter = 2; saveData.keys = this.keysCount; saveData.hp = this.hp;
        persist();
        var self = this;
        this.time.delayedCall(1400, function () {
          if (self.scene) self.scene.restart({ chapter: 2 });
        });
      } else {
        this.showMsg('通关！按 R 重来', 2000); Sfx.play('win');
        this.won = true; this.over = true;
        saveData.unlockedChapter = 2; saveData.chapter = 2;
        persist();
      }
    };

    GameScene.prototype.damagePlayer = function (dmg, fromX, fromY) {
      if (this.over || this.paused) return;
      var now = this.time.now;
      if (now < this.hurtUntil) return;
      this.hp -= dmg;
      if (this.hp < 0) this.hp = 0;
      this.hurtUntil = now + PLAYER_IFRAME;
      Sfx.play('hurt');
      this.cameras.main.shake(120, 0.006);
      // 击退
      var dx = this.player.x - fromX, dy = this.player.y - fromY;
      var l = Math.sqrt(dx * dx + dy * dy) || 1;
      this.player.setVelocity((dx / l) * 220, (dy / l) * 220);
      this.updateHud();
      if (this.hp <= 0) {
        this.over = true; this.won = false;
        this.showMsg('倒下… 按 R 重试', 2000);
        this.time.delayedCall(900, function () { Sfx.stopBgm(); }, this);
      }
    };

    GameScene.prototype.update = function (time, delta) {
      if (this.paused) {
        if (Phaser.Input.Keyboard.JustDown(this.keyP)) this.togglePause();
        return;
      }
      // 全局按键
      if (Phaser.Input.Keyboard.JustDown(this.keyR)) { Sfx.stopBgm(); this.scene.restart({ chapter: this.chapter }); return; }
      if (Phaser.Input.Keyboard.JustDown(this.keyP)) { this.togglePause(); return; }
      if (Phaser.Input.Keyboard.JustDown(this.keyEnter)) {
        // 调试：直接刷钥匙并开 BOSS
        this.keysCount = Math.max(this.keysCount, 2);
        this.updateHud();
        // 开所有普通门
        for (var od = 0; od < this.doors.length; od++) { var _d = this.doors[od].sprite; if (!_d.getData('isBoss') && _d.getData('locked')) { _d.setData('locked', false); _d.setTexture('door_open'); _d.body.enable = false; } }
        if (!this.boss) {
          // 开 BOSS 门
          for (var bd = 0; bd < this.doors.length; bd++) { var _bd = this.doors[bd].sprite; if (_bd.getData('isBoss') && _bd.getData('locked')) { _bd.setData('locked', false); _bd.setTexture('door_open'); _bd.body.enable = false; } }
          this.spawnBoss(); this.room = 'boss'; this.updateHud();
        }
      }
      if (this.over && this.won) {
        // 通关后按 R 已处理
      }
      // 移动输入（8向）
      var ix = 0, iy = 0;
      if (this.cursors.left.isDown || this.keyA.isDown) ix -= 1;
      if (this.cursors.right.isDown || this.keyD.isDown) ix += 1;
      if (this.cursors.up.isDown || this.keyW.isDown) iy -= 1;
      if (this.cursors.down.isDown || this.keyS.isDown) iy += 1;
      if (ix !== 0 || iy !== 0) {
        var len2 = Math.sqrt(ix * ix + iy * iy);
        ix /= len2; iy /= len2;
        // 面向（4向最接近）
        if (Math.abs(ix) > Math.abs(iy)) this.dir4 = ix > 0 ? 0 : 2;
        else if (iy !== 0) this.dir4 = iy > 0 ? 1 : 3;
      }
      // 冲刺
      if (Phaser.Input.Keyboard.JustDown(this.keyShift)) this.doDash();
      var isDashing = time < this.dashUntil;
      var speed = isDashing ? DASH_SPEED : PLAYER_SPEED;
      if (!this.over) this.player.setVelocity(ix * speed, iy * speed);
      else this.player.setVelocity(0, 0);

      // 挥剑
      if ((Phaser.Input.Keyboard.JustDown(this.keyZ) || Phaser.Input.Keyboard.JustDown(this.keySpace)) && !this.isSwinging) this.trySwing();
      // 远程
      if (Phaser.Input.Keyboard.JustDown(this.keyX)) this.tryShoot();
      // 开箱/开门（靠近按 Z/空格交互）
      if (Phaser.Input.Keyboard.JustDown(this.keyZ) || Phaser.Input.Keyboard.JustDown(this.keySpace)) {
        for (var ci = 0; ci < this.chestSprites.length; ci++) this.tryOpenChest(this.chestSprites[ci]);
        this.tryUseDoor();
        // 割草（靠近挥剑范围内也可，简化：交互键也割附近草）
        var grasses = this.grassGroup.getChildren().slice();
        for (var gi = 0; gi < grasses.length; gi++) {
          var gr2 = grasses[gi];
          var dg = Phaser.Math.Distance.Between(this.player.x, this.player.y, gr2.x, gr2.y);
          if (dg < 30) {
            var gx = gr2.x, gy = gr2.y; gr2.destroy();
            Sfx.play('grass');
            var r = Math.random();
            if (r < 0.22) this.dropHeart(gx, gy);
            else if (r < 0.28) this.dropKey(gx, gy);
          }
        }
      }

      // 剑 hitbox 时序：仅攻击帧激活矩形（帧激活）
      if (this.isSwinging) {
        var t = time - this.swingStart;
        this.updateSwordPos();
        var active = t >= SWORD_ACTIVE_FROM && t <= SWORD_ACTIVE_TO;
        this.swordActive = active;
        this.swordHitbox.setVisible(active);
        // 碰撞检测（AABB 与敌人）
        if (active) {
          var sx = this.swordHitbox.x, sy = this.swordHitbox.y;
          var sw = this.swordHitbox.width, sh = this.swordHitbox.height;
          var sLeft = sx - sw / 2, sRight = sx + sw / 2, sTop = sy - sh / 2, sBot = sy + sh / 2;
          // 敌人
          var ens = this.enemies.getChildren().slice();
          for (var ei = 0; ei < ens.length; ei++) {
            var en = ens[ei];
            var eL = en.x - 11, eR = en.x + 11, eT = en.y - 11, eB = en.y + 11;
            if (sRight > eL && sLeft < eR && sBot > eT && sTop < eB) {
              if (this.damageEnemy(en, 1, this.player.x, this.player.y)) {
                // 命中无敌帧已在 enemy hurtUntil 中
              }
            }
          }
          // 草（剑割）
          var grasses2 = this.grassGroup.getChildren().slice();
          for (var gj = 0; gj < grasses2.length; gj++) {
            var gr3 = grasses2[gj];
            var gL = gr3.x - 11, gR = gr3.x + 11, gT = gr3.y - 11, gB = gr3.y + 11;
            if (sRight > gL && sLeft < gR && sBot > gT && sTop < gB) {
              var gx2 = gr3.x, gy2 = gr3.y; gr3.destroy();
              Sfx.play('grass');
              var rr2 = Math.random();
              if (rr2 < 0.22) this.dropHeart(gx2, gy2);
              else if (rr2 < 0.30) this.dropKey(gx2, gy2);
            }
          }
        }
        if (t >= SWORD_TIME) {
          this.isSwinging = false; this.swordActive = false; this.swordHitbox.setVisible(false);
        }
      }

      // 箭更新
      var arrows = this.arrows.getChildren().slice();
      for (var ai = 0; ai < arrows.length; ai++) {
        var ar = arrows[ai];
        if (!ar.active) continue;
        var life = ar.getData('life') - delta;
        ar.setData('life', life);
        if (life <= 0 || ar.x < -20 || ar.x > W + 20 || ar.y < -20 || ar.y > H + 20) { ar.setActive(false).setVisible(false); ar.setVelocity(0, 0); continue; }
        // 撞墙
        var tp = pxToTile(ar.x, ar.y);
        if (this.wallSet[tp.c + ',' + tp.r]) { ar.setActive(false).setVisible(false); ar.setVelocity(0, 0); continue; }
        // 撞敌
        var ens2 = this.enemies.getChildren().slice();
        for (var ej = 0; ej < ens2.length; ej++) {
          var en2 = ens2[ej];
          var d2 = Phaser.Math.Distance.Between(ar.x, ar.y, en2.x, en2.y);
          if (d2 < 16) {
            ar.setActive(false).setVisible(false); ar.setVelocity(0, 0);
            this.damageEnemy(en2, 1, ar.x, ar.y);
            break;
          }
        }
      }

      // 敌人 AI
      var ensAll = this.enemies.getChildren().slice();
      for (var ek = 0; ek < ensAll.length; ek++) {
        var ee = ensAll[ek];
        if (!ee.active) continue;
        // 受击闪烁
        if (time < ee.getData('hurtUntil')) {
          ee.setAlpha(time % 120 < 60 ? 0.35 : 1);
        } else ee.setAlpha(1);
        // BOSS 特殊
        var et = ee.getData('type');
        if (et === 'boss_slime') {
          var jcd = ee.getData('jumpCd') || 0;
          if (time > jcd) {
            // 跳压：向玩家方向突进
            var jdx = this.player.x - ee.x, jdy = this.player.y - ee.y;
            var jl = Math.sqrt(jdx * jdx + jdy * jdy) || 1;
            ee.setVelocity((jdx / jl) * 140, (jdy / jl) * 140);
            ee.setData('jumpCd', time + 1600);
          } else {
            // 摩擦
            ee.setVelocity(ee.body.velocity.x * 0.96, ee.body.velocity.y * 0.96);
          }
          // 碰玩家
          var db = Phaser.Math.Distance.Between(ee.x, ee.y, this.player.x, this.player.y);
          if (db < 26) this.damagePlayer(1, ee.x, ee.y);
          if (this.boss === ee) { this.bossHp = ee.getData('hp'); this.updateHud(); }
          continue;
        }
        if (et === 'boss_knight') {
          var ccd = ee.getData('chargeCd') || 0, scd = ee.getData('shootCd') || 0;
          if (time > ccd) {
            var cdx = this.player.x - ee.x, cdy = this.player.y - ee.y;
            var cl = Math.sqrt(cdx * cdx + cdy * cdy) || 1;
            ee.setVelocity((cdx / cl) * 170, (cdy / cl) * 170);
            ee.setData('chargeCd', time + 1200);
          } else {
            ee.setVelocity(ee.body.velocity.x * 0.94, ee.body.velocity.y * 0.94);
          }
          if (time > scd) {
            // 射击
            var bdx = this.player.x - ee.x, bdy = this.player.y - ee.y;
            var bl = Math.sqrt(bdx * bdx + bdy * bdy) || 1;
            var bb = this.enemyBullets.get(ee.x, ee.y, 'arrow');
            if (bb) {
              bb.setActive(true).setVisible(true).setDisplaySize(14, 6).setTint(0xff4444);
              bb.setVelocity((bdx / bl) * 180, (bdy / bl) * 180);
              bb.setData('life', 1800);
              bb.body.setAllowGravity(false);
            }
            ee.setData('shootCd', time + 900);
          }
          var db2 = Phaser.Math.Distance.Between(ee.x, ee.y, this.player.x, this.player.y);
          if (db2 < 24) this.damagePlayer(1, ee.x, ee.y);
          if (this.boss === ee) { this.bossHp = ee.getData('hp'); this.updateHud(); }
          continue;
        }
        // 普通敌人
        if (et === 'slime') {
          // 巡逻：来回
          var sp2 = ee.getData('patrolA'), ep2 = ee.getData('patrolB');
          var target = (Math.floor(time / 1800) % 2 === 0) ? ep2 : sp2;
          var sdx = target.x - ee.x, sdy = target.y - ee.y;
          var sl = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
          ee.setVelocity((sdx / sl) * 38, (sdy / sl) * 38);
          var dpl = Phaser.Math.Distance.Between(ee.x, ee.y, this.player.x, this.player.y);
          if (dpl < 18) this.damagePlayer(1, ee.x, ee.y);
        } else if (et === 'bat') {
          // 追踪
          var bdx2 = this.player.x - ee.x, bdy2 = this.player.y - ee.y;
          var bl2 = Math.sqrt(bdx2 * bdx2 + bdy2 * bdy2) || 1;
          ee.setVelocity((bdx2 / bl2) * 76, (bdy2 / bl2) * 76);
          var dpl2 = Phaser.Math.Distance.Between(ee.x, ee.y, this.player.x, this.player.y);
          if (dpl2 < 16) this.damagePlayer(1, ee.x, ee.y);
        } else if (et === 'skeleton') {
          // 射弹：保持距离射击
          var skdx = this.player.x - ee.x, skdy = this.player.y - ee.y;
          var skd = Math.sqrt(skdx * skdx + skdy * skdy) || 1;
          if (skd > 90) { ee.setVelocity((skdx / skd) * 48, (skdy / skd) * 48); }
          else ee.setVelocity(0, 0);
          var scd2 = ee.getData('shootCd') || 0;
          if (time > scd2 && skd < 180) {
            var b3 = this.enemyBullets.get(ee.x, ee.y, 'arrow');
            if (b3) {
              b3.setActive(true).setVisible(true).setDisplaySize(14, 6).setTint(0xffffff);
              b3.setVelocity((skdx / skd) * 150, (skdy / skd) * 150);
              b3.setData('life', 1800); b3.body.setAllowGravity(false);
            }
            ee.setData('shootCd', time + 1100);
          }
          var dpl3 = Phaser.Math.Distance.Between(ee.x, ee.y, this.player.x, this.player.y);
          if (dpl3 < 15) this.damagePlayer(1, ee.x, ee.y);
        } else if (et === 'knight') {
          // 冲锋：cd 后向玩家冲
          var kcd = ee.getData('chargeCd') || 0;
          if (time > kcd) {
            var kdx = this.player.x - ee.x, kdy = this.player.y - ee.y;
            var kl = Math.sqrt(kdx * kdx + kdy * kdy) || 1;
            ee.setVelocity((kdx / kl) * 110, (kdy / kl) * 110);
            ee.setData('chargeCd', time + 1600);
          } else {
            ee.setVelocity(ee.body.velocity.x * 0.93, ee.body.velocity.y * 0.93);
          }
          var dpl4 = Phaser.Math.Distance.Between(ee.x, ee.y, this.player.x, this.player.y);
          if (dpl4 < 20) this.damagePlayer(1, ee.x, ee.y);
        }
      }

      // 敌弹
      var ebs = this.enemyBullets.getChildren().slice();
      for (var bi = 0; bi < ebs.length; bi++) {
        var eb = ebs[bi];
        if (!eb.active) continue;
        var elife = (eb.getData('life') || 1800) - delta;
        eb.setData('life', elife);
        if (elife <= 0 || eb.x < -20 || eb.x > W + 20 || eb.y < -20 || eb.y > H + 20) { eb.setActive(false).setVisible(false); eb.setVelocity(0, 0); continue; }
        var tp2 = pxToTile(eb.x, eb.y);
        if (this.wallSet[tp2.c + ',' + tp2.r]) { eb.setActive(false).setVisible(false); eb.setVelocity(0, 0); continue; }
        var dpe = Phaser.Math.Distance.Between(eb.x, eb.y, this.player.x, this.player.y);
        if (dpe < 14) { eb.setActive(false).setVisible(false); eb.setVelocity(0, 0); this.damagePlayer(1, eb.x, eb.y); }
      }

      // 掉落拾取
      var drops = this.drops.getChildren().slice();
      for (var di = 0; di < drops.length; di++) {
        var dp2 = drops[di];
        var ddp = Phaser.Math.Distance.Between(dp2.x, dp2.y, this.player.x, this.player.y);
        if (ddp < 16) {
          var typ = dp2.getData('type');
          if (typ === 'heart') { if (this.hp < this.maxHp) { this.hp++; this.updateHud(); } }
          else if (typ === 'key') { this.keysCount++; this.updateHud(); this.showMsg('获得钥匙', 900); }
          dp2.destroy();
        }
      }

      // 推箱回正（吸附到最近格子，避免卡墙缝）
      for (var bxI = 0; bxI < this.boxes.length; bxI++) {
        var bxs = this.boxes[bxI].sprite;
        if (!bxs.active) continue;
        var vlen = Math.sqrt(bxs.body.velocity.x * bxs.body.velocity.x + bxs.body.velocity.y * bxs.body.velocity.y);
        if (vlen < 6) { bxs.setVelocity(0, 0); }
      }
      this.checkSwitches();

      // 玩家无敌闪烁
      if (time < this.hurtUntil) this.player.setAlpha(time % 120 < 60 ? 0.45 : 1);
      else this.player.setAlpha(1);

      // 消息淡出
      if (time > this.msgUntil) this.msgText.setText('');

      if (this.over && !this.won && time % 600 < 30) this.updateHud();

      // 章节通关（BOSS 已灭且无 boss 对象）
      // 由 onBossDefeated 驱动重启，无需每帧判定

      // 同步存档（仅章/钥匙/hp）
      saveData.chapter = this.chapter; saveData.hp = this.hp; saveData.keys = this.keysCount;
    };

    GameScene.prototype.togglePause = function () {
      this.paused = __omp_shell("this.paused;")
      if (this.paused) { this.showMsg('暂停 P继续', 999999); try { this.player.setVelocity(0, 0); } catch (e) {} }
      else { this.msgUntil = this.time.now + 900; this.showMsg('继续', 700); }
    };

    return GameScene;
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------
  function launch(host) {
    hostRef = host;
    loadPersisted();
    try { document.addEventListener('click', function f() { Sfx.resume(); document.removeEventListener('click', f); }, { once: true }); } catch (e) {}
    var Phaser = host.phaser;
    var BootScene = createBootScene(Phaser);
    var TitleScene = createTitleScene(Phaser);
    var GameScene = createGameScene(Phaser);
    var config = {
      type: Phaser.AUTO,
      parent: host.container,
      width: W, height: H,
      backgroundColor: '#0b132b',
      physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
      scene: [BootScene, TitleScene, GameScene]
    };
    var game = new Phaser.Game(config);
    gameRef = game;
    // 测试缝：getState / __trgame
    window.__trgame = {
      game: game,
      getState: function () {
        var sc = null;
        try { sc = game.scene.getScene('Game'); } catch (e) {}
        var active = sc && sc.scene && sc.scene.isActive && sc.scene.isActive('Game');
        var sceneName = 'title';
        if (active) sceneName = sc.won ? 'won' : (sc.over ? 'over' : 'game');
        else { try { if (game.scene.isActive('Title')) sceneName = 'title'; else if (game.scene.isActive('Boot')) sceneName = 'boot'; } catch (e2) {} }
        var ch = active ? sc.chapter : curChapter;
        var hp = active ? sc.hp : saveData.hp;
        var keys = active ? sc.keysCount : saveData.keys;
        var room = active ? sc.room : 'field';
        return { scene: sceneName, chapter: ch, hp: hp, keys: keys, room: room };
      }
    };
    return game;
  }

  if (typeof window.TRGames !== 'undefined' && typeof window.TRGames.register === 'function') {
    window.TRGames.register({ id: 'arpg-zelda', title: 'Zelda ARPG', launch: launch });
  } else {
    window.TRGames = window.TRGames || { register: function () {} };
    window.TRGames.register({ id: 'arpg-zelda', title: 'Zelda ARPG', launch: launch });
  }
})();
