(function () {
  'use strict';
  // =============================================================================
  // racing-pseudo3d v0.1.0 — 伪3D纵深赛车（马里奥卡丁车纵深路感）
  // =============================================================================
  // 资产清单（中文注释为替换点）：
  //   视觉：
  //     buildTextures() 内 Graphics + generateTexture 生成：
  //       car_player(玩家车 矩形+轮+尾翼) / car_opp0,1,2(对手车 不同配色) /
  //       item_boost(加速带) / item_coin(能量星) / deco_tree(景物占位几何可替)
  //       // 替换点：改为 this.load.image('car_player','assets/car.png') 等；
  //       // 路几何/景物现为 Graphics 梯形+几何，替换时在 drawRoad/drawDecor 换贴图
  //   音频：
  //     Sfx.play(type) WebAudio oscillator+gain  // 替换点：分支内换 AudioBuffer
  //     类型：engine/boost/crash/overtake/coin/bgmTick/countdown/finish
  //   关卡：
  //     TRACKS[0] 绿野赛道 / TRACKS[1] 荒漠峡谷（曲率、起伏、配色、对手速度区分）
  //     每赛道 segments[] {curve,hill,decor} 驱动伪3D
  //   存档：
  //     host.saveState {bestTime:number, bestRank:number}
  //     getState() -> {scene, lap, speed, pos, rank}
  // =============================================================================

  // ---------------------------------------------------------------------------
  // 可调参数
  // ---------------------------------------------------------------------------
  var W = 800, H = 600;
  var SEG_LEN = 200;           // 每段长度 world 单位
  var DRAW_N = 40;             // 每帧重绘段数（近30+远10）
  var ROAD_W = 4;              // 路宽 world 单位（-2..2）
  var CAM_DEPTH = 130;         // 透视深度
  var CAM_HEIGHT = 950;        // 相机高于路面
  var HORIZON = H * 0.38;      // 地平线 Y
  var X_SCALE = 520;           // worldX -> screenX 放大
  var W_FACTOR = 210;          // 路宽缩放
  var Y_FACTOR = 0.92;         // 高度缩放
  var MAX_SPEED = 620;         // 玩家极速
  var ACCEL = 260;             // 油门加速度
  var BRAKE = 420;             // 刹车减速度
  var DRAG = 55;               // 自然阻力
  var STEER_SPEED = 1.65;      // 横移速度 (lane单位/s)
  var LAPS = 3;
  var N_OPP = 4;               // 对手数

  var hostRef = null;
  var bestTime = Infinity;
  var bestRank = 99;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---------------------------------------------------------------------------
  // Sfx — WebAudio，首输入 resume，静默降级
  // ---------------------------------------------------------------------------
  var Sfx = {
    ctx: null, enabled: true, _bgmTimer: null,
    _ensure: function () {
      if (this.ctx) return this.ctx;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { this.enabled = false; return null; }
        this.ctx = new AC();
      } catch (e) { this.enabled = false; return null; }
      return this.ctx;
    },
    _resume: function () {
      var c = this._ensure(); if (!c) return;
      if (c.state === 'suspended') try { c.resume(); } catch (e) {}
    },
    // // 替换点：采样音频时将此 switch 换为 decodeAudioData + BufferSource
    play: function (type) {
      var c = this._ensure(); if (!c || !this.enabled) return;
      this._resume();
      try {
        var o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        var now = c.currentTime;
        if (type === 'engine') {
          // 引擎嗡鸣 — 随速度由调用方变调，此处短促嗡
          o.type = 'sawtooth'; o.frequency.setValueAtTime(80, now);
          o.frequency.linearRampToValueAtTime(140, now + 0.12);
          g.gain.setValueAtTime(0.08, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
          o.start(now); o.stop(now + 0.15);
        } else if (type === 'boost') {
          o.type = 'square'; o.frequency.setValueAtTime(440, now);
          o.frequency.exponentialRampToValueAtTime(880, now + 0.2);
          g.gain.setValueAtTime(0.3, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
          o.start(now); o.stop(now + 0.31);
        } else if (type === 'crash') {
          o.type = 'square'; o.frequency.setValueAtTime(180, now);
          o.frequency.exponentialRampToValueAtTime(40, now + 0.25);
          g.gain.setValueAtTime(0.5, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
          o.start(now); o.stop(now + 0.36);
        } else if (type === 'overtake') {
          o.type = 'sine'; o.frequency.setValueAtTime(660, now);
          o.frequency.setValueAtTime(990, now + 0.08);
          g.gain.setValueAtTime(0.32, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
          o.start(now); o.stop(now + 0.23);
        } else if (type === 'coin') {
          o.type = 'sine'; o.frequency.setValueAtTime(880, now);
          o.frequency.linearRampToValueAtTime(1318, now + 0.1);
          g.gain.setValueAtTime(0.28, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
          o.start(now); o.stop(now + 0.19);
        } else if (type === 'countdown') {
          o.type = 'square'; o.frequency.setValueAtTime(700, now);
          g.gain.setValueAtTime(0.25, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
          o.start(now); o.stop(now + 0.21);
        } else if (type === 'finish') {
          o.type = 'triangle'; o.frequency.setValueAtTime(523, now);
          o.frequency.setValueAtTime(659, now + 0.15); o.frequency.setValueAtTime(784, now + 0.3);
          g.gain.setValueAtTime(0.35, now); g.gain.linearRampToValueAtTime(0.001, now + 0.55);
          o.start(now); o.stop(now + 0.56);
        } else {
          o.type = 'sine'; o.frequency.setValueAtTime(440, now);
          g.gain.setValueAtTime(0.15, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
          o.start(now); o.stop(now + 0.11);
        }
      } catch (e) {}
    },
    startBgm: function (scene) {
      this.stopBgm();
      var self = this;
      // // 替换点：换为循环 AudioBufferSource
      this._bgmTimer = scene.time.addEvent({ delay: 520, loop: true, callback: function () {
        if (scene.sceneState !== 'racing') return;
        // 引擎节奏感：轻量 tick，按速度偶发
        if (scene.speed > 80 && Math.random() < 0.3) self.play('engine');
      }});
    },
    stopBgm: function () { if (this._bgmTimer) { try { this._bgmTimer.remove(false); } catch (e) {} this._bgmTimer = null; } }
  };

  // ---------------------------------------------------------------------------
  // 纹理 — 纯几何占位
  // ---------------------------------------------------------------------------
  function buildTextures(scene) {
    var g;
    function rm(k) { if (scene.textures.exists(k)) scene.textures.remove(k); }

    // 玩家车：矩形车身+驾驶舱+四轮 // 替换点：换位图 car.png
    rm('car_player');
    g = scene.add.graphics();
    g.fillStyle(0x1a1a1a, 1); g.fillRoundedRect(2, 24, 10, 18, 2); g.fillRoundedRect(52, 24, 10, 18, 2);
    g.fillRoundedRect(2, 58, 10, 14, 2); g.fillRoundedRect(52, 58, 10, 14, 2);
    g.fillStyle(0xff3b30, 1); g.fillRoundedRect(8, 6, 48, 62, 6);
    g.fillStyle(0x222222, 1); g.fillRoundedRect(14, 14, 36, 22, 3);
    g.fillStyle(0x7ec8ff, 1); g.fillRoundedRect(16, 16, 32, 14, 2);
    g.fillStyle(0xffcc00, 1); g.fillCircle(16, 68, 4); g.fillCircle(48, 68, 4);
    g.fillStyle(0xffffff, 0.9); g.fillRect(20, 42, 24, 4);
    g.generateTexture('car_player', 64, 76); g.destroy();

    // 对手车三配色
    var oppCols = [0x2e7cff, 0xff9500, 0x34c759];
    for (var k = 0; k < 3; k++) {
      var key = 'car_opp' + k;
      rm(key);
      g = scene.add.graphics();
      g.fillStyle(0x1a1a1a, 1); g.fillRoundedRect(1, 18, 8, 14, 2); g.fillRoundedRect(41, 18, 8, 14, 2);
      g.fillRoundedRect(1, 44, 8, 11, 2); g.fillRoundedRect(41, 44, 8, 11, 2);
      g.fillStyle(oppCols[k], 1); g.fillRoundedRect(6, 4, 38, 50, 5);
      g.fillStyle(0x111111, 1); g.fillRoundedRect(11, 10, 28, 16, 2);
      g.fillStyle(0xc7e3ff, 1); g.fillRoundedRect(13, 12, 24, 10, 1);
      g.generateTexture(key, 50, 58); g.destroy();
    }

    // 加速带：黄黑条纹
    rm('item_boost');
    g = scene.add.graphics();
    g.fillStyle(0xffcc00, 1); g.fillRoundedRect(0, 0, 48, 18, 3);
    g.fillStyle(0x1a1a1a, 1);
    for (var i = 0; i < 4; i++) g.fillRect(i * 12 + 2, 3, 8, 12);
    g.fillStyle(0xffffff, 1); g.fillTriangle(36, 9, 28, 3, 28, 15);
    g.generateTexture('item_boost', 48, 18); g.destroy();

    // 能量星
    rm('item_coin');
    g = scene.add.graphics();
    g.fillStyle(0xffd60a, 1); g.fillCircle(14, 14, 13);
    g.fillStyle(0xff9500, 1); g.fillCircle(14, 14, 9);
    g.fillStyle(0xffffff, 1); g.fillCircle(11, 11, 3);
    g.lineStyle(2, 0xffffff, 0.9); g.strokeCircle(14, 14, 13);
    g.generateTexture('item_coin', 28, 28); g.destroy();

    // 淡色占位：树/岩石用代码绘制，不另生成纹理（drawDecor 中几何）
  }

  // ---------------------------------------------------------------------------
  // 赛道定义 — 至少2关，曲率/起伏/配色区分
  // ---------------------------------------------------------------------------
  function makeTrack0() {
    var n = 90;
    var segs = [];
    for (var i = 0; i < n; i++) {
      var curve = 0, hill = 0, decor = null;
      // 布局：0-20直道 20-35右弯 35-55直 55-75左弯 75-90直
      if (i >= 20 && i < 35) curve = 0.18;
      else if (i >= 55 && i < 75) curve = -0.16;
      // 微起伏
      if (i >= 40 && i < 50) hill = 6;
      else if (i >= 50 && i < 60) hill = -6;
      else if (i >= 10 && i < 16) hill = 4;
      // 景物：道路两侧交替树
      if (i % 6 === 2) decor = (i % 12 === 2) ? 'tree' : 'rock';
      segs.push({ curve: curve, hill: hill, decor: decor, decorOff: (i % 2 === 0 ? 1 : -1) });
    }
    return {
      id: 0, name: '绿野环道',
      segments: segs,
      colors: {
        skyTop: 0x87ceeb, skyBot: 0xc7e8ff,
        ground: 0x3a9e4a, roadDark: 0x3a3a3a, roadLight: 0x4a4a4a,
        line: 0xffffff, barrier: 0xffffff, hillTint: 0x2d7a36
      },
      oppSpeeds: [190, 210, 225, 175],
      bgHill: 0
    };
  }
  function makeTrack1() {
    var n = 100;
    var segs = [];
    for (var i = 0; i < n; i++) {
      var curve = 0, hill = 0;
      // 更弯：S形 + 急弯
      if (i >= 10 && i < 22) curve = 0.28;
      else if (i >= 22 && i < 34) curve = -0.26;
      else if (i >= 45 && i < 58) curve = 0.32;
      else if (i >= 58 && i < 70) curve = -0.30;
      else if (i >= 78 && i < 92) curve = 0.22;
      // 起伏更大
      if (i >= 12 && i < 20) hill = 9;
      else if (i >= 20 && i < 28) hill = -9;
      else if (i >= 48 && i < 56) hill = 11;
      else if (i >= 56 && i < 64) hill = -11;
      else if (i >= 80 && i < 88) hill = 7;
      var decor = null;
      if (i % 5 === 1) decor = (i % 3 === 0 ? 'cactus' : 'rock2');
      segs.push({ curve: curve, hill: hill, decor: decor, decorOff: (Math.random() < 0.5 ? 1 : -1) });
    }
    return {
      id: 1, name: '荒漠峡谷',
      segments: segs,
      colors: {
        skyTop: 0xffb86c, skyBot: 0xffe4b5,
        ground: 0xc2a35a, roadDark: 0x3d2e22, roadLight: 0x4e3d2e,
        line: 0xffeb3b, barrier: 0xff3b30, hillTint: 0x8a6a2e
      },
      oppSpeeds: [260, 285, 300, 245],
      bgHill: 14
    };
  }
  var TRACKS = [makeTrack0(), makeTrack1()];

  // ---------------------------------------------------------------------------
  // Phaser Scene
  // ---------------------------------------------------------------------------
  function createSceneClass(Phaser) {
    return new Phaser.Class({
      Extends: Phaser.Scene,
      initialize: function () { Phaser.Scene.call(this, { key: 'racing' }); },

      create: function () {
        hostRef = this.hostRef || hostRef;
        buildTextures(this);
        this.cursors = this.input.keyboard.createCursorKeys();
        this.wasd = this.input.keyboard.addKeys('W,A,S,D');
        this.keyR = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
        this.keyOne = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
        this.keyTwo = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
        this.keySpace = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

        // Graphics 层：天空/地面由 bgG，道路由 roadG，景物/道具/对手由 sprite 层 + overlay
        this.bgG = this.add.graphics();
        this.roadG = this.add.graphics();
        this.decorG = this.add.graphics();
        this.roadG.setDepth(2);
        this.decorG.setDepth(3);

        // 玩家车精灵（固定画面下中）
        this.playerSpr = this.add.image(W / 2, H - 62, 'car_player');
        this.playerSpr.setDepth(10); this.playerSpr.setScale(1.15);
        this.playerSpr.setVisible(false);

        // 对手与道具对象池（Image 池）
        this.oppPool = [];
        this.itemPool = [];
        for (var oi = 0; oi < 8; oi++) {
          var im = this.add.image(-100, -100, 'car_opp0'); im.setVisible(false); im.setDepth(5);
          this.oppPool.push(im);
        }
        for (var ii = 0; ii < 10; ii++) {
          var it = this.add.image(-100, -100, 'item_coin'); it.setVisible(false); it.setDepth(4);
          this.itemPool.push(it);
        }

        // HUD
        var hudStyle = { fontFamily: 'monospace', fontSize: '14px', color: '#ffffff', stroke: '#000000', strokeThickness: 3 };
        var titleStyle = { fontFamily: 'monospace', fontSize: '28px', color: '#ffffff', stroke: '#000000', strokeThickness: 5, fontStyle: 'bold' };
        this.hudBg = this.add.rectangle(W / 2, 22, W, 44, 0x000000, 0.45).setDepth(20).setVisible(false);
        this.hudLap = this.add.text(14, 10, '', hudStyle).setDepth(21);
        this.hudSpeed = this.add.text(170, 10, '', hudStyle).setDepth(21);
        this.hudRank = this.add.text(320, 10, '', hudStyle).setDepth(21);
        this.hudTime = this.add.text(470, 10, '', hudStyle).setDepth(21);
        this.hudScore = this.add.text(620, 10, '', hudStyle).setDepth(21);
        this.hudMsg = this.add.text(W / 2, H * 0.42, '', { fontFamily: 'monospace', fontSize: '18px', color: '#ffeb3b', stroke: '#000', strokeThickness: 4, align: 'center' }).setOrigin(0.5).setDepth(21);

        this.titleText = this.add.text(W / 2, 88, '伪 3D 极速', titleStyle).setOrigin(0.5).setDepth(21);
        this.subText = this.add.text(W / 2, 126, 'WASD / 方向键  移动  |  空格 刹车  |  1/2 选赛道  |  回车 开始', { fontFamily: 'monospace', fontSize: '13px', color: '#e0e0e0', stroke: '#000', strokeThickness: 3, align: 'center' }).setOrigin(0.5).setDepth(21);
        this.trackText = this.add.text(W / 2, 170, '', { fontFamily: 'monospace', fontSize: '15px', color: '#ffffff', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(21);
        this.tipText = this.add.text(W / 2, H - 28, '左右 横移  上下 油门/刹车  超车加分  碰撞减速  能量/加速带顶取', { fontFamily: 'monospace', fontSize: '12px', color: '#ffffff', stroke: '#000', strokeThickness: 2 }).setOrigin(0.5).setDepth(21);
        this.bestText = this.add.text(W / 2, 200, '', { fontFamily: 'monospace', fontSize: '13px', color: '#ffeb3b', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(21);
        this.resultText = this.add.text(W / 2, H / 2, '', { fontFamily: 'monospace', fontSize: '20px', color: '#ffffff', stroke: '#000', strokeThickness: 4, align: 'center' }).setOrigin(0.5).setDepth(21).setVisible(false);

        // 状态
        this.sceneState = 'title'; // title | racing | result
        this.trackIdx = 0;
        this.pos = 0;          // 绝对 Z
        this.speed = 0;
        this.laneX = 0;        // -1.45..1.45
        this.lap = 1;
        this.timeMs = 0;
        this.score = 0;
        this.rank = 1;
        this.boostMs = 0;
        this.crashMs = 0;
        this.overtakeFlash = 0;
        this.opponents = [];   // {pos,lane,speed,texIdx,passed}
        this.items = [];       // {pos,lane,type,collected}
        this.trackLen = 0;
        this.countdown = 0;
        this.prevRank = 1;

        // 存档加载
        var self = this;
        if (hostRef && hostRef.loadState) {
          hostRef.loadState().then(function (s) {
            if (s) {
              if (typeof s.bestTime === 'number') bestTime = s.bestTime;
              if (typeof s.bestRank === 'number') bestRank = s.bestRank;
            }
            self.refreshTitle();
          }).catch(function () { self.refreshTitle(); });
        } else self.refreshTitle();

        this.input.keyboard.on('keydown-ENTER', function () { self.handleEnter(); });
        this.refreshTitle();
        Sfx.startBgm(this);

        // 暴露 getState 供验收/宿主
        this.getState = function () {
          return { scene: self.sceneState, lap: self.lap, speed: Math.round(self.speed), pos: Math.round(self.pos), rank: self.rank };
        };
        // 全局便于验收脚本读取
        window.__pseudo3D_getState = this.getState; // 兼容旧命名
        window.__trgame = { game: this.game, getState: this.getState }; // 宿主契约测试缝
      },

      refreshTitle: function () {
        var t = TRACKS[this.trackIdx];
        this.trackText.setText('赛道 ' + (this.trackIdx + 1) + '  ' + t.name + '  [' + (this.trackIdx === 0 ? '绿野·缓弯' : '峡谷·急弯') + ']   按 1/2 切换');
        var bt = isFinite(bestTime) ? (bestTime / 1000).toFixed(2) + 's' : '--';
        this.bestText.setText('最佳纪录  时间 ' + bt + '   名次 ' + (bestRank <= 4 ? bestRank : '--') + '   |   回车/点击 开始  空格刹车演示');
        this.hudBg.setVisible(false); this.hudLap.setVisible(false); this.hudSpeed.setVisible(false);
        this.hudRank.setVisible(false); this.hudTime.setVisible(false); this.hudScore.setVisible(false);
        this.playerSpr.setVisible(false);
        this.resultText.setVisible(false);
        this.hudMsg.setText('');
        // 背景预览
        this.drawPreview();
      },

      handleEnter: function () {
        if (this.sceneState === 'title') this.startRace();
        else if (this.sceneState === 'result') { this.sceneState = 'title'; this.refreshTitle(); }
      },

      startRace: function () {
        var t = TRACKS[this.trackIdx];
        this.trackLen = t.segments.length * SEG_LEN;
        this.pos = 0; this.speed = 0; this.laneX = 0; this.lap = 1; this.timeMs = 0;
        this.score = 0; this.rank = N_OPP + 1; this.prevRank = this.rank;
        this.boostMs = 0; this.crashMs = 0; this.overtakeFlash = 0;
        this.countdown = 0;
        this.sceneState = 'racing';

        // 生成对手：沿赛道均匀分布，不同速度
        this.opponents = [];
        for (var i = 0; i < N_OPP; i++) {
          var off = ((i + 1) * this.trackLen) / (N_OPP + 1);
          this.opponents.push({
            pos: off + (Math.random() * 600 - 300),
            lane: (Math.random() * 1.2 - 0.6),
            speed: t.oppSpeeds[i % t.oppSpeeds.length] + (Math.random() * 30 - 15),
            texIdx: i % 3,
            passed: false
          });
        }
        // 生成道具：每 ~8 段一个，能量/加速交替
        this.items = [];
        var totalSeg = t.segments.length * LAPS + 10;
        for (var s = 6; s < totalSeg; s += 7 + Math.floor(Math.random() * 4)) {
          if (s % 13 === 0) continue;
          this.items.push({
            pos: s * SEG_LEN + SEG_LEN * 0.5,
            lane: (Math.random() * 1.4 - 0.7),
            type: (Math.random() < 0.55 ? 'coin' : 'boost'),
            collected: false
          });
        }

        this.titleText.setVisible(false); this.subText.setVisible(false);
        this.trackText.setVisible(false); this.bestText.setVisible(false); this.tipText.setVisible(false);
        this.resultText.setVisible(false);
        this.hudBg.setVisible(true); this.hudLap.setVisible(true); this.hudSpeed.setVisible(true);
        this.hudRank.setVisible(true); this.hudTime.setVisible(true); this.hudScore.setVisible(true);
        this.playerSpr.setVisible(true);
        this.hudMsg.setText('GO!');
        var self = this;
        this.time.delayedCall(900, function () { if (self.sceneState === 'racing') self.hudMsg.setText(''); });
        Sfx.play('countdown');
      },

      update: function (time, delta) {
        var dt = delta / 1000;
        if (dt > 0.05) dt = 0.05;

        // 标题态：1/2 切换赛道预览
        if (this.sceneState === 'title') {
          if (Phaser.Input.Keyboard.JustDown(this.keyOne)) { this.trackIdx = 0; this.refreshTitle(); Sfx.play('coin'); }
          if (Phaser.Input.Keyboard.JustDown(this.keyTwo)) { this.trackIdx = 1; this.refreshTitle(); Sfx.play('coin'); }
          this.drawPreview();
          return;
        }
        if (this.sceneState === 'result') {
          if (Phaser.Input.Keyboard.JustDown(this.keyR) || Phaser.Input.Keyboard.JustDown(this.keySpace)) {
            this.sceneState = 'title'; this.refreshTitle();
          }
          return;
        }

        // ---- racing ----
        var t = TRACKS[this.trackIdx];
        var up = this.cursors.up.isDown || this.wasd.W.isDown;
        var down = this.cursors.down.isDown || this.wasd.S.isDown || this.keySpace.isDown;
        var left = this.cursors.left.isDown || this.wasd.A.isDown;
        var right = this.cursors.right.isDown || this.wasd.D.isDown;

        // 竞速：速度物理（油门/刹车/阻力），boost/crash 计时
        var effMax = MAX_SPEED + (this.boostMs > 0 ? 160 : 0);
        if (this.crashMs > 0) { this.crashMs -= delta; effMax = Math.min(effMax, 180); }
        if (this.boostMs > 0) this.boostMs -= delta;

        if (up && this.crashMs <= 0) this.speed += ACCEL * dt;
        else if (down) this.speed -= BRAKE * dt;
        else this.speed -= DRAG * dt;

        // 路肩/越野减速
        var offRoad = Math.abs(this.laneX) > 1.0;
        if (offRoad) this.speed -= 110 * dt;
        // 弯道侧向力：高速过弯若不修正会外抛（轻微把车推向弯外）
        var segIdxNow = Math.floor(this.pos / SEG_LEN) % t.segments.length;
        var curNow = t.segments[segIdxNow].curve;
        if (Math.abs(curNow) > 0.1 && this.speed > 200) {
          this.laneX += curNow * 0.55 * (this.speed / MAX_SPEED) * dt;
        }

        this.speed = clamp(this.speed, 0, effMax);
        // 推进
        this.pos += this.speed * dt;
        this.timeMs += delta;

        // 横移（速度相关，高速更灵敏但受弯影响）
        var steer = 0;
        if (left) steer -= 1;
        if (right) steer += 1;
        // 低速时转向打折
        var steerFactor = 0.45 + 0.75 * (this.speed / MAX_SPEED);
        this.laneX += steer * STEER_SPEED * steerFactor * dt;
        this.laneX = clamp(this.laneX, -1.45, 1.45);
        // 轻微回中（无输入时）
        if (steer === 0 && this.speed > 40) this.laneX *= (1 - 0.9 * dt);

        // 对手推进（恒速巡航，轻微蛇行）
        for (var oi2 = 0; oi2 < this.opponents.length; oi2++) {
          var o = this.opponents[oi2];
          o.pos += o.speed * dt;
          o.lane += Math.sin(this.timeMs * 0.001 + oi2 * 1.7) * 0.15 * dt;
          o.lane = clamp(o.lane, -0.95, 0.95);
          // 跑完多圈后整体提速一点（关2更快已在 oppSpeeds 体现）
        }

        // 道具拾取：近距离 + 横向重叠
        for (var ii2 = 0; ii2 < this.items.length; ii2++) {
          var it2 = this.items[ii2];
          if (it2.collected) continue;
          var dz = it2.pos - this.pos;
          // 处理绕圈：道具只在未来一圈内有效，超后即忽略
          if (dz < -300 || dz > 900) continue;
          if (Math.abs(dz) < 90 && Math.abs(it2.lane - this.laneX) < 0.42) {
            it2.collected = true;
            if (it2.type === 'boost') {
              this.speed = Math.min(this.speed + 110, effMax + 60);
              this.boostMs = 1600; Sfx.play('boost'); this.hudMsg.setText('BOOST!');
              var self2 = this; this.time.delayedCall(420, function(){ if(self2.sceneState==='racing' && self2.hudMsg.text==='BOOST!') self2.hudMsg.setText('');});
            } else {
              this.score += 120; Sfx.play('coin'); this.hudMsg.setText('+120');
              var self3 = this; this.time.delayedCall(260, function(){ if(self3.sceneState==='racing' && self3.hudMsg.text==='+120') self3.hudMsg.setText('');});
            }
          }
        }

        // 碰撞：与对手纵向 <90 且横向 <0.38 视为撞
        for (var ci = 0; ci < this.opponents.length; ci++) {
          var oc = this.opponents[ci];
          var dzc = oc.pos - this.pos;
          if (Math.abs(dzc) < 75 && Math.abs(oc.lane - this.laneX) < 0.40) {
            if (this.crashMs <= 0) {
              this.speed *= 0.52; this.crashMs = 700; this.laneX += (this.laneX < oc.lane ? -0.22 : 0.22);
              Sfx.play('crash');
              this.hudMsg.setText('CRASH!');
              var selfC = this; this.time.delayedCall(380, function(){ if(selfC.hudMsg.text==='CRASH!') selfC.hudMsg.setText('');});
            }
          }
        }

        // 超车判定：对手从前方变为后方（pos 超越）
        for (var pi = 0; pi < this.opponents.length; pi++) {
          var op = this.opponents[pi];
          // 若玩家刚超过该对手（上一帧在后，这一帧在前，距离穿越）
          // 简化：当对手落后 <600 且标记未超车时，一次性加分
          var behind = op.pos < this.pos && (this.pos - op.pos) < 900 && (this.pos - op.pos) > 0;
          if (behind && !op.passed) {
            // 需确认之前确实在前方过：用 pos 差穿越阈值，首次超越即算
            // 只要落后且距离很近且速度我们更快，算一次
            if (this.speed > op.speed - 10) {
              op.passed = true; this.score += 250; Sfx.play('overtake'); this.overtakeFlash = 260;
            }
          }
          // 若对手重新超越玩家，撤销标记（可反复超车刷分，但控制频率）
          if (!behind && op.passed && (op.pos - this.pos) < 400 && (op.pos - this.pos) > 0) {
            op.passed = false;
          }
        }

        // 圈数
        var newLap = Math.floor(this.pos / this.trackLen) + 1;
        if (newLap !== this.lap) {
          this.lap = newLap; Sfx.play('countdown');
          if (this.lap <= LAPS) { this.hudMsg.setText('LAP ' + this.lap + '/' + LAPS); var selfL=this; this.time.delayedCall(500,function(){ if(selfL.hudMsg.text.indexOf('LAP')===0) selfL.hudMsg.setText('');}); }
        }

        // 名次：按绝对 pos 排序（含对手）
        var allPos = [{ isPlayer: true, pos: this.pos }].concat(this.opponents.map(function(o){ return {isPlayer:false,pos:o.pos}; }));
        allPos.sort(function(a,b){ return b.pos - a.pos; });
        for (var ri = 0; ri < allPos.length; ri++) if (allPos[ri].isPlayer) { this.rank = ri + 1; break; }
        if (this.rank < this.prevRank) { Sfx.play('overtake'); }
        this.prevRank = this.rank;

        // 比赛结束：完成 LAPS 圈
        if (this.pos >= this.trackLen * LAPS) {
          this.finishRace();
          return;
        }

        // HUD
        var lapShow = Math.min(this.lap, LAPS);
        this.hudLap.setText('LAP ' + lapShow + '/' + LAPS);
        this.hudSpeed.setText('SPD ' + Math.round(this.speed));
        this.hudRank.setText('RANK ' + this.rank + '/' + (N_OPP + 1));
        this.hudTime.setText('TIME ' + (this.timeMs / 1000).toFixed(1) + 's');
        this.hudScore.setText('SCORE ' + this.score);
        if (this.overtakeFlash > 0) { this.overtakeFlash -= delta; this.hudRank.setColor(this.overtakeFlash % 200 < 100 ? '#ffeb3b' : '#ffffff'); } else this.hudRank.setColor('#ffffff');

        // 玩家车倾斜：按转向与弯道
        var tilt = steer * 0.18 + curNow * 0.6;
        this.playerSpr.setScale(1.15 + this.speed * 0.00012, 1.15);
        this.playerSpr.rotation = tilt * 0.55;
        this.playerSpr.x = W / 2 + this.laneX * 72;
        // 轻微上下颠簸随 hill
        this.playerSpr.y = H - 62 + Math.sin(this.timeMs * 0.012) * (this.speed > 200 ? 1.2 : 0.4);

        // 绘制伪3D
        this.drawRoad();
      },

      finishRace: function () {
        this.sceneState = 'result';
        Sfx.stopBgm(); Sfx.play('finish');
        var secs = (this.timeMs / 1000).toFixed(2);
        var rankTxt = this.rank === 1 ? '冠军！' : this.rank === 2 ? '亚军' : this.rank === 3 ? '季军' : '第' + this.rank + '名';
        var isBest = false;
        if (this.timeMs < bestTime) { bestTime = this.timeMs; isBest = true; }
        if (this.rank < bestRank) bestRank = this.rank;
        // 存档
        if (hostRef && hostRef.saveState) {
          hostRef.saveState({ bestTime: bestTime, bestRank: bestRank }).catch(function(){});
        }
        var msg = '完赛！  ' + rankTxt + '\n赛道：' + TRACKS[this.trackIdx].name +
          '\n圈数 ' + LAPS + '/' + LAPS + '   用时 ' + secs + 's' + (isBest ? '  ★新纪录' : '') +
          '\n得分 ' + this.score + '   名次 ' + this.rank + '/' + (N_OPP + 1) +
          '\n最佳 ' + (isFinite(bestTime) ? (bestTime/1000).toFixed(2) + 's' : '--') + '  /  ' + (bestRank <= N_OPP+1 ? 'P'+bestRank : '--') +
          '\n\n[R] 返回标题   [1/2] 换赛道重开   回车亦可';
        this.resultText.setText(msg); this.resultText.setVisible(true);
        this.hudMsg.setText('');
        this.playerSpr.setVisible(false);
        // 隐藏池
        for (var i = 0; i < this.oppPool.length; i++) this.oppPool[i].setVisible(false);
        for (var j = 0; j < this.itemPool.length; j++) this.itemPool[j].setVisible(false);
      },

      // 标题预览：静态远景 + 一段路示意
      drawPreview: function () {
        var t = TRACKS[this.trackIdx];
        var col = t.colors;
        this.bgG.clear();
        // 天空渐变（分层矩形模拟）
        for (var y = 0; y < HORIZON; y += 8) {
          var f = y / HORIZON;
          var r = lerp((col.skyTop >> 16) & 0xff, (col.skyBot >> 16) & 0xff, f);
          var g2 = lerp((col.skyTop >> 8) & 0xff, (col.skyBot >> 8) & 0xff, f);
          var b = lerp(col.skyTop & 0xff, col.skyBot & 0xff, f);
          this.bgG.fillStyle((r << 16) | (g2 << 8) | b, 1);
          this.bgG.fillRect(0, y, W, 8);
        }
        // 远山剪影
        this.bgG.fillStyle(col.hillTint, 1);
        this.bgG.beginPath();
        this.bgG.moveTo(0, HORIZON);
        for (var x = 0; x <= W; x += 18) {
          var h = Math.sin(x * 0.012 + t.bgHill) * 22 + Math.cos(x * 0.028) * 14 + 18;
          this.bgG.lineTo(x, HORIZON - h);
        }
        this.bgG.lineTo(W, HORIZON); this.bgG.closePath(); this.bgG.fillPath();
        this.bgG.fillStyle(col.ground, 1); this.bgG.fillRect(0, HORIZON, W, 40);
      },

      // 核心：伪3D梯形路段绘制 + 景物/道具/对手投影
      drawRoad: function () {
        var t = TRACKS[this.trackIdx];
        var segs = t.segments;
        var nSeg = segs.length;
        var col = t.colors;
        var baseIdx = Math.floor(this.pos / SEG_LEN) % nSeg;
        var baseHillAcc = 0; // 相机处 hill 累积仅作相对
        // 预计算相机 hill（用于相对高度）—— 简化用 0 基准，绘制时用增量相对

        this.roadG.clear();
        this.decorG.clear();
        this.bgG.clear();

        // 背景天空+远山（随赛道配色）
        for (var yy = 0; yy < HORIZON; yy += 8) {
          var ff = yy / HORIZON;
          var rr = lerp((col.skyTop >> 16) & 0xff, (col.skyBot >> 16) & 0xff, ff);
          var gg = lerp((col.skyTop >> 8) & 0xff, (col.skyBot >> 8) & 0xff, ff);
          var bb = lerp(col.skyTop & 0xff, col.skyBot & 0xff, ff);
          this.bgG.fillStyle((rr << 16) | (gg << 8) | bb, 1);
          this.bgG.fillRect(0, yy, W, 8);
        }
        this.bgG.fillStyle(col.hillTint, 1);
        this.bgG.beginPath(); this.bgG.moveTo(0, HORIZON);
        for (var bx = 0; bx <= W; bx += 16) {
          var bh = Math.sin(bx * 0.011 + this.pos * 0.0006) * 18 + Math.cos(bx * 0.022) * 12 + 16;
          // 峡谷赛道山更高
          if (this.trackIdx === 1) bh *= 1.25;
          this.bgG.lineTo(bx, HORIZON - bh);
        }
        this.bgG.lineTo(W, HORIZON); this.bgG.closePath(); this.bgG.fillPath();

        // 隐藏所有池先
        for (var pi0 = 0; pi0 < this.oppPool.length; pi0++) this.oppPool[pi0].setVisible(false);
        for (var pj0 = 0; pj0 < this.itemPool.length; pj0++) this.itemPool[pj0].setVisible(false);

        // 收集需绘制的精灵（对手/道具）按 relZ 远近排序，远先画
        var sprites = [];
        for (var oi = 0; oi < this.opponents.length; oi++) {
          var o = this.opponents[oi];
          var relO = o.pos - this.pos;
          // 处理跨圈：若对手在玩家身后很远（已落后一圈多），rel 为负大，不画
          if (relO < 60 || relO > DRAW_N * SEG_LEN - 20) continue;
          sprites.push({ kind: 'opp', ref: o, rel: relO });
        }
        for (var ii = 0; ii < this.items.length; ii++) {
          var it = this.items[ii];
          if (it.collected) continue;
          var relI = it.pos - this.pos;
          if (relI < 20 || relI > DRAW_N * SEG_LEN - 20) continue;
          sprites.push({ kind: 'item', ref: it, rel: relI });
        }
        sprites.sort(function(a,b){ return b.rel - a.rel; });

        // 逐段投影数据缓存，供 sprite 插值
        var projCache = []; // {x,y,w,scale,curveAcc,hillAcc}
        var curAcc = 0, hillAcc = 0;
        for (var i3 = 0; i3 <= DRAW_N; i3++) {
          var idx3 = (baseIdx + i3) % nSeg;
          if (i3 > 0) { curAcc += segs[idx3].curve; hillAcc += segs[idx3].hill; }
          var relZ3 = i3 * SEG_LEN;
          var scale3 = CAM_DEPTH / (CAM_DEPTH + relZ3);
          var sx3 = W / 2 + (curAcc - this.laneX * 2.4) * scale3 * X_SCALE * 0.18;
          // 镜头跟随路面起伏：相机高度抵消 hillAcc 基准
          var sy3 = HORIZON + (CAM_HEIGHT - hillAcc) * scale3 * Y_FACTOR * 0.42;
          // 视差侧移：弯道累积已含在 curAcc
          var sw3 = scale3 * ROAD_W * W_FACTOR;
          projCache.push({ x: sx3, y: sy3, w: sw3, scale: scale3, cur: curAcc, hill: hillAcc });
        }

        // 自远及近绘制梯形
        for (var i = DRAW_N - 1; i >= 0; i--) {
          var p1 = projCache[i], p2 = projCache[i + 1];
          // p1 近，p2 远？实际 i 小近，i+1 远一点，保证 y 近大远小
          // p1 是近端（y 更大），p2 远端（y 更小）
          var x1 = p1.x, y1 = p1.y, w1 = p1.w;
          var x2 = p2.x, y2 = p2.y, w2 = p2.w;
          if (y1 <= HORIZON && y2 <= HORIZON) continue;
          if (y1 >= H) y1 = H; if (y2 < HORIZON) y2 = HORIZON;

          // 路面两侧地面
          // 底色：交替深浅区分段
          var isDark = ( (baseIdx + i) % 2 === 0 );
          var roadCol = isDark ? col.roadDark : col.roadLight;
          var groundCol = col.ground;
          // 地面（路外）
          this.roadG.fillStyle(groundCol, 1);
          this.roadG.beginPath();
          this.roadG.moveTo(0, y1); this.roadG.lineTo(W, y1); this.roadG.lineTo(W, y2); this.roadG.lineTo(0, y2);
          this.roadG.closePath(); this.roadG.fillPath();

          // 路面梯形
          this.roadG.fillStyle(roadCol, 1);
          this.roadG.beginPath();
          this.roadG.moveTo(x1 - w1, y1); this.roadG.lineTo(x1 + w1, y1);
          this.roadG.lineTo(x2 + w2, y2); this.roadG.lineTo(x2 - w2, y2);
          this.roadG.closePath(); this.roadG.fillPath();

          // 路肩/护栏（红白相间）
          var shoulder = w1 * 0.07;
          this.roadG.fillStyle(i % 2 === 0 ? 0xffffff : 0xff3b30, 1);
          this.roadG.beginPath();
          this.roadG.moveTo(x1 - w1 - shoulder, y1); this.roadG.lineTo(x1 - w1, y1);
          this.roadG.lineTo(x2 - w2, y2); this.roadG.lineTo(x2 - w2 - shoulder * (w2/w1), y2);
          this.roadG.closePath(); this.roadG.fillPath();
          this.roadG.beginPath();
          this.roadG.moveTo(x1 + w1, y1); this.roadG.lineTo(x1 + w1 + shoulder, y1);
          this.roadG.lineTo(x2 + w2 + shoulder * (w2/w1), y2); this.roadG.lineTo(x2 + w2, y2);
          this.roadG.closePath(); this.roadG.fillPath();

          // 正中虚线（每2段一条）
          if (i % 2 === 0) {
            var lw = Math.max(2, w1 * 0.04);
            this.roadG.fillStyle(col.line, 1);
            this.roadG.beginPath();
            this.roadG.moveTo(x1 - lw, y1); this.roadG.lineTo(x1 + lw, y1);
            this.roadG.lineTo(x2 + lw * (w2/w1), y2); this.roadG.lineTo(x2 - lw * (w2/w1), y2);
            this.roadG.closePath(); this.roadG.fillPath();
          }

          // 几何景物视差滚动（路两侧，位于该段）
          var segIdx = (baseIdx + i) % nSeg;
          var d = segs[segIdx].decor;
          if (d) {
            var side = segs[segIdx].decorOff;
            // 世界横坐标：路沿外 1.8~2.6
            var wx = side * (ROAD_W / 2 + 1.9 + (d === 'rock2' ? 0.6 : 0));
            var sx = W / 2 + (p1.cur + wx - this.laneX * 2.4) * p1.scale * X_SCALE * 0.18;
            var sy = y1;
            var sc = p1.scale;
            // 视差：护栏/景物随 scale 缩放，近大远小
            if (d === 'tree') {
              var hTr = 42 * sc * 260; var wTr = 28 * sc * 260;
              // 树干
              this.decorG.fillStyle(0x6b4423, 1);
              this.decorG.fillRect(sx - wTr * 0.12, sy - hTr * 0.35, wTr * 0.24, hTr * 0.35);
              // 树冠 三角
              this.decorG.fillStyle(0x1a6b2a, 1);
              this.decorG.beginPath();
              this.decorG.moveTo(sx, sy - hTr); this.decorG.lineTo(sx - wTr * 0.5, sy - hTr * 0.35); this.decorG.lineTo(sx + wTr * 0.5, sy - hTr * 0.35);
              this.decorG.closePath(); this.decorG.fillPath();
              this.decorG.fillStyle(0x2d8a3e, 1);
              this.decorG.beginPath();
              this.decorG.moveTo(sx, sy - hTr * 0.78); this.decorG.lineTo(sx - wTr * 0.38, sy - hTr * 0.25); this.decorG.lineTo(sx + wTr * 0.38, sy - hTr * 0.25);
              this.decorG.closePath(); this.decorG.fillPath();
            } else if (d === 'rock' || d === 'rock2') {
              var hr = (d === 'rock2' ? 26 : 18) * sc * 260; var wr = (d === 'rock2' ? 30 : 22) * sc * 260;
              this.decorG.fillStyle(d === 'rock2' ? 0x8d6e63 : 0x8a8a8a, 1);
              this.decorG.beginPath();
              this.decorG.moveTo(sx - wr * 0.5, sy); this.decorG.lineTo(sx - wr * 0.3, sy - hr); this.decorG.lineTo(sx + wr * 0.35, sy - hr * 0.9); this.decorG.lineTo(sx + wr * 0.5, sy);
              this.decorG.closePath(); this.decorG.fillPath();
              this.decorG.fillStyle(0xffffff, 0.18); this.decorG.fillCircle(sx - wr * 0.1, sy - hr * 0.55, wr * 0.12);
            } else if (d === 'cactus') {
              var hc = 36 * sc * 260; var wc = 14 * sc * 260;
              this.decorG.fillStyle(0x2e7d32, 1);
              this.decorG.fillRoundedRect(sx - wc * 0.5, sy - hc, wc, hc, 3);
              this.decorG.fillRoundedRect(sx - wc * 1.1, sy - hc * 0.62, wc * 0.7, hc * 0.38, 3);
              this.decorG.fillRoundedRect(sx + wc * 0.4, sy - hc * 0.55, wc * 0.7, hc * 0.32, 3);
            }
          }
        }

        // 叠加精灵（对手/道具）按远近已排序，远先画所以近覆盖
        var poolOppIdx = 0, poolItemIdx = 0;
        for (var si = sprites.length - 1; si >= 0; si--) {
          var sp = sprites[si];
          // 找到对应段的投影插值
          var segOff = Math.floor(sp.rel / SEG_LEN);
          segOff = clamp(segOff, 0, DRAW_N - 1);
          var pc = projCache[segOff];
          var t2 = (sp.rel % SEG_LEN) / SEG_LEN;
          // 插值曲率/高度（线性）
          var curSp = lerp(pc.cur, projCache[segOff + 1] ? projCache[segOff + 1].cur : pc.cur, t2);
          var hillSp = lerp(pc.hill, projCache[segOff + 1] ? projCache[segOff + 1].hill : pc.hill, t2);
          var scaleSp = CAM_DEPTH / (CAM_DEPTH + sp.rel);
          var sxSp = W / 2 + (curSp + sp.ref.lane * (ROAD_W * 0.45) - this.laneX * 2.4) * scaleSp * X_SCALE * 0.18;
          var sySp = HORIZON + (CAM_HEIGHT - hillSp) * scaleSp * Y_FACTOR * 0.42;
          // 路面 Y 需向下拉到路面上（微调）
          sySp -= scaleSp * 8;

          if (sp.kind === 'opp') {
            var img = this.oppPool[poolOppIdx % this.oppPool.length]; poolOppIdx++;
            var key2 = 'car_opp' + sp.ref.texIdx;
            if (img.texture.key !== key2) img.setTexture(key2);
            img.setVisible(true); img.setPosition(sxSp, sySp);
            var sScale = scaleSp * 260 * 0.55; // 基础缩放
            sScale = clamp(sScale, 0.12, 1.35);
            img.setScale(sScale);
            img.setDepth(6 + (DRAW_N - segOff));
          } else {
            var itImg = this.itemPool[poolItemIdx % this.itemPool.length]; poolItemIdx++;
            var k3 = sp.ref.type === 'boost' ? 'item_boost' : 'item_coin';
            if (itImg.texture.key !== k3) itImg.setTexture(k3);
            itImg.setVisible(true); itImg.setPosition(sxSp, sySp - 10 * scaleSp * 60);
            var sc2 = scaleSp * 260 * 0.42;
            if (k3 === 'item_boost') sc2 *= 0.95;
            sc2 = clamp(sc2, 0.18, 1.1);
            itImg.setScale(sc2);
            itImg.setDepth(6 + (DRAW_N - segOff));
            // 浮动动画
            itImg.y += Math.sin(this.timeMs * 0.005 + sp.ref.pos * 0.01) * 4 * scaleSp * 10;
          }
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------
  function launch(host) {
    hostRef = host;
    var Phaser = host.phaser || window.Phaser;
    if (!Phaser) throw new Error('Phaser not found on host');
    var SceneClass = createSceneClass(Phaser);
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      width: W, height: H,
      parent: host.container,
      backgroundColor: '#87ceeb',
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
scene: SceneClass,
      physics: { default: 'arcade' },
      render: { antialias: true }
    });
    // 场景内通过 hostRef 闭包读取宿主，无需额外注入；延迟兜底确保 ready 后可读
    game.events.once('ready', function () {
      try { var sc = game.scene.getScene('racing'); if (sc) sc.hostRef = host; } catch (e) {}
    });

    return {
      dispose: function () { try { Sfx.stopBgm(); } catch(e){} try { game.destroy(true); } catch(e){} },
      getState: function(){
        try { var sc = game.scene.getScene('racing'); if (sc && sc.getState) return sc.getState(); } catch(e){}
        return { scene: 'unknown', lap: 1, speed: 0, pos: 0, rank: 1 };
      }
    };
  }

  window.TRGames = window.TRGames || {};
  // 简单注册表兼容
  if (window.TRGames.register) window.TRGames.register({ id: 'racing-pseudo3d', title: '伪3D极速', launch: launch });
  else { window.TRGames['racing-pseudo3d'] = { id: 'racing-pseudo3d', title: '伪3D极速', launch: launch }; }
})();
