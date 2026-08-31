// =============================================================================
// 【资产替换清单】fighter-sf / Fighter SF — 1v1 横版格斗（StreetFighter-like）
// =============================================================================
// 视觉占位（零外部资源，全部程序化生成）：
//   - 角色：胶囊圆角矩形 (generateTexture 'fighter_p1'/'fighter_p2')
//     将来替换：this.load.spritesheet('ryu','assets/ryu.png',{frameWidth:64,frameHeight:96})
//              或 this.load.image('fighter_p1','assets/p1.png')
//     位置：buildTextures() 内 “胶囊角色” 段，搜索“视觉替换点：角色”
//   - 飞行道具：胶囊横向椭圆 'hadouken_p1'/'hadouken_p2'
//     将来替换：this.load.image('hadouken','assets/hadouken.png')
//     位置：buildTextures() 内 “波动拳” 段，搜索“视觉替换点：波动”
//   - Hitbox 调试：Graphics 矩形叠层 hitDebugP1/hitDebugP2，为 Graphics 非纹理
//     开关：O 键 toggleHitDebug，视觉替换点保留 debug 层便于接 hitbox 编辑器
//   - 血条/能量条：1x1 'pixel' 拉伸为血条，'pixel' 已生成
//     将来替换：this.load.image('hpbar','assets/hpbar.png')
//   - 舞台：地面 'ground_dojo'/'ground_city' + 远景 'bg_dojo'/'bg_city' (Graphics)
//     将来替换：this.load.image('ground_dojo','assets/stage1_ground.png')
//              this.load.image('bg_city','assets/stage2_bg.png')
//     位置：buildTextures() 内 “舞台” 段，每舞台色块+地面几何不同，BGM 区分
//   - 特效：受击闪白、KO 文字、Hit 数字 — 纯 text+Graphics
//     将来替换：this.load.image('hit_fx','assets/hit.png') + particles
// 音频占位（WebAudio oscillator+gain 自合成）：
//   顶层 Sfx.play('punch'/'kick'/'hadouken'/'shoryu'/'hit'/'ko'/'block')
//   将来替换：preload() { this.load.audio('punch','assets/punch.wav'); }
//            Sfx.play = (k)=> this.sound.play(k)
//   每处 Sfx 注释均已标 “音频替换点”
// 存档：host.saveState/loadState 持久化 {wins, unlockedStage}
// 关卡/舞台：STAGES 数组驱动，2 舞台，解锁与 BGM 按 stage 区分
// 测试缝：window.__trgame = { game, getState():{scene, round, p1hp, p2hp, stage}, getSave() }
// 陷阱：body.reset 传送 / overlap 参数顺序无关（contains 判断） / Phaser v4.2.1 overlap 回调签名注意
// =============================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 可调参数（带单位）— 平衡集中一处，中文注释
  // ---------------------------------------------------------------------------
  var CFG = {
    W: 960,               // 逻辑宽 px（host.width 优先）
    H: 540,               // 逻辑高 px
    GROUND_Y: 462,        // 地面顶面 y（角色脚 y）
    GRAVITY: 1800,        // 重力 px/s²
    WALK_SPEED: 220,      // 行走 px/s
    JUMP_VEL: 560,        // 起跳初速 px/s（向上为负）
    BACKDASH_SPEED: 300,  // 后撤步
    FRICTION: 2200,       // 地面摩擦
    MAX_HP: 100,          // 单局血量
    HADOU_SPEED: 380,     // 波动飞行速度 px/s
    HADOU_POOL: 6,        // 每人波动池大小
    BO3: 2,               // BO3 两胜
    HITSTOP_MS: 90,       // 命中停顿 ms（简易 freeze）
    KO_DELAY_MS: 900,     // KO 到下一局延迟
    STAGE_COUNT: 2
  };

  // 攻击表：damage / hitstun ms / blockstun ms / push px / startup/active/recovery ms / knockdown?
  // 轻拳/重拳/轻腿/重腿 + 波动/升龙
  var ATK = {
    lp: { name: 'LP', dmg: 6,  chip: 1, hs: 260, bs: 140, push: 10, startup: 80,  active: 90,  rec: 160, kd: false, range: 42, height: 18, yOff: -32 },
    hp: { name: 'HP', dmg: 10, chip: 2, hs: 420, bs: 200, push: 22, startup: 130, active: 100, rec: 260, kd: false, range: 48, height: 20, yOff: -30 },
    lk: { name: 'LK', dmg: 7,  chip: 1, hs: 300, bs: 150, push: 12, startup: 90,  active: 100, rec: 180, kd: false, range: 46, height: 22, yOff: -16 },
    hk: { name: 'HK', dmg: 12, chip: 3, hs: 500, bs: 220, push: 28, startup: 160, active: 110, rec: 300, kd: true,  range: 54, height: 24, yOff: -14 },
    hadou: { name: 'Hadouken', dmg: 14, chip: 4, hs: 400, bs: 200, push: 18, startup: 180, active: 0, rec: 320, kd: false },
    shoryu:{ name: 'Shoryuken', dmg: 16, chip: 2, hs: 600, bs: 180, push: 30, startup: 90,  active: 240, rec: 420, kd: true,  range: 44, height: 36, yOff: -28 }
  };

  // 舞台定义：至少 2 关，背景换色+地面几何不同，BGM区分
  var STAGES = [
    { id: 0, name: '道场',  bg: '#b8a07a', groundKey: 'ground_dojo', bgKey: 'bg_dojo', bgm: 'dojo' },
    { id: 1, name: '霓虹街', bg: '#1a1d2e', groundKey: 'ground_city', bgKey: 'bg_city', bgm: 'city' }
  ];

  // ---------------------------------------------------------------------------
  // 存档与状态缝 — 闭包持有，跨场景共享
  // ---------------------------------------------------------------------------
  var hostRef = null;
  var sceneRef = null;
  var saveData = { wins: 0, unlockedStage: 0 }; // wins 总胜场用于展示，unlockedStage 解锁到第几关
  function getState() {
    var s = sceneRef;
    if (!s || s.scene.key !== 'fight') {
      return { scene: s ? s.scene.key : 'none', round: 0, p1hp: CFG.MAX_HP, p2hp: CFG.MAX_HP, stage: saveData.unlockedStage, wins: saveData.wins, p1wins: 0, p2wins: 0 };
    }
    return {
      scene: 'fight',
      round: s.round || 1,
      p1hp: Math.round(s.p1 ? s.p1.hp : CFG.MAX_HP),
      p2hp: Math.round(s.p2 ? s.p2.hp : CFG.MAX_HP),
      stage: s.curStage || 0,
      wins: saveData.wins,
      p1wins: s.p1wins | 0,
      p2wins: s.p2wins | 0
    };
  }


  // ---------------------------------------------------------------------------
  // Sfx — WebAudio 自合成，首输入 resume，失败静默降级
  // 音频替换点：把 tone 换成 this.load.audio + this.sound.play 即可
  // ---------------------------------------------------------------------------
  var Sfx = {
    ctx: null,
    bgmTimer: null,
    bgmStage: 0,
    ensure: function () {
      try {
        if (!Sfx.ctx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          Sfx.ctx = new AC();
        }
        if (Sfx.ctx.state === 'suspended') Sfx.ctx.resume();
        return Sfx.ctx;
      } catch (e) { return null; }
    },
    tone: function (freq, dur, type, vol, slideTo) {
      try {
        var ctx = Sfx.ensure();
        if (!ctx) return;
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        if (slideTo) o.frequency.linearRampToValueAtTime(slideTo, ctx.currentTime + dur);
        g.gain.value = vol != null ? vol : 0.18;
        g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + dur);
      } catch (e) {}
    },
    play: function (name) {
      try {
        // 音频替换点：每分支可换 this.sound.play(name)
        if (name === 'punch') Sfx.tone(180, 0.08, 'square', 0.2, 90);
        else if (name === 'kick') Sfx.tone(140, 0.10, 'square', 0.2, 70);
        else if (name === 'hit') Sfx.tone(220, 0.14, 'square', 0.28, 110);
        else if (name === 'block') Sfx.tone(300, 0.07, 'triangle', 0.12, 300);
        else if (name === 'hadouken') { Sfx.tone(260, 0.22, 'sawtooth', 0.22, 180); setTimeout(function(){ Sfx.tone(520,0.12,'square',0.14); }, 80); }
        else if (name === 'shoryu') { Sfx.tone(320, 0.16, 'sawtooth', 0.24, 640); setTimeout(function(){ Sfx.tone(440,0.18,'square',0.2); }, 120); }
        else if (name === 'ko') { Sfx.tone(150, 0.4, 'sawtooth', 0.28, 60); setTimeout(function(){ Sfx.tone(100,0.35,'triangle',0.2); }, 180); }
        else if (name === 'jump') Sfx.tone(320, 0.10, 'square', 0.14, 480);
        else if (name === 'down') Sfx.tone(120, 0.25, 'triangle', 0.18, 60);
      } catch (e) {}
    },
    startBgm: function (scene, stage) {
      try {
        Sfx.stopBgm();
        var ctx = Sfx.ensure();
        if (!ctx) return;
        Sfx.bgmStage = stage | 0;
        // BGM区分：道场 低沉太鼓节奏 / 霓虹街 快节奏方波
        var notesA = [110, 138, 165, 138];
        var notesB = [196, 247, 294, 330, 294, 247];
        var notes = (Sfx.bgmStage === 0) ? notesA : notesB;
        var delay = (Sfx.bgmStage === 0) ? 420 : 300;
        var idx = 0;
        Sfx.bgmTimer = scene.time.addEvent({
          delay: delay, loop: true,
          callback: function () {
            try {
              var f = notes[idx % notes.length];
              Sfx.tone(f, 0.14, (Sfx.bgmStage===0?'triangle':'square'), 0.05);
              idx++;
            } catch (e) {}
          }
        });
      } catch (e) {}
    },
    stopBgm: function () {
      try { if (Sfx.bgmTimer) { Sfx.bgmTimer.remove(false); Sfx.bgmTimer = null; } } catch (e) {}
    }
  };

  // ---------------------------------------------------------------------------
  // 纹理生成 — 纯几何体 Graphics+generateTexture，零外部资源
  // 视觉替换点：每处中文注释已标 将来换 this.load.image 的写法
  // ---------------------------------------------------------------------------
  function buildTextures(scene) {
    function rm(k) { if (scene.textures.exists(k)) scene.textures.remove(k); }
    var g;
    // 胶囊角色 P1 — 蓝胴+白道服裤，红手套（可开关 hitbox 调试叠层另绘）
    // 视觉替换点：角色 -> this.load.spritesheet('fighter_p1','assets/p1.png',{frameWidth:64,frameHeight:96})
    rm('fighter_p1'); g = scene.add.graphics();
    g.fillStyle(0x1e88e5, 1); g.fillRoundedRect(0, 0, 44, 78, 10);
    g.fillStyle(0xf5d6b8, 1); g.fillCircle(22, 14, 12); // 头
    g.fillStyle(0x222222, 1); g.fillRect(14, 8, 16, 4); // 头带
    g.fillStyle(0xffffff, 1); g.fillRoundedRect(6, 26, 32, 28, 4); // 道服
    g.fillStyle(0xef5350, 1); g.fillCircle(8, 34, 7); g.fillCircle(36, 34, 7); // 拳套
    g.fillStyle(0xffffff, 1); g.fillRect(10, 54, 10, 20); g.fillRect(24, 54, 10, 20); // 腿
    g.generateTexture('fighter_p1', 44, 78); g.destroy();
    // 胶囊角色 P2 — 红胴+黑裤，黄手套，便于区分
    // 视觉替换点：同上换 'fighter_p2'
    rm('fighter_p2'); g = scene.add.graphics();
    g.fillStyle(0xe53935, 1); g.fillRoundedRect(0, 0, 44, 78, 10);
    g.fillStyle(0xf5d6b8, 1); g.fillCircle(22, 14, 12);
    g.fillStyle(0x222222, 1); g.fillRect(14, 8, 16, 4);
    g.fillStyle(0x333333, 1); g.fillRoundedRect(6, 26, 32, 28, 4);
    g.fillStyle(0xffee58, 1); g.fillCircle(8, 34, 7); g.fillCircle(36, 34, 7);
    g.fillStyle(0x333333, 1); g.fillRect(10, 54, 10, 20); g.fillRect(24, 54, 10, 20);
    g.generateTexture('fighter_p2', 44, 78); g.destroy();

    // 波动拳 — 胶囊横向光弹（发光核心）
    // 视觉替换点：波动 -> this.load.image('hadouken','assets/hadouken.png')
    rm('hadouken_p1'); g = scene.add.graphics();
    // 外晕+内核
    g.fillStyle(0x4fc3f7, 0.45); g.fillRoundedRect(0, 2, 28, 18, 9);
    g.fillStyle(0xffffff, 1); g.fillRoundedRect(6, 6, 16, 10, 5);
    g.fillStyle(0x0288d1, 1); g.fillCircle(14, 11, 3);
    g.generateTexture('hadouken_p1', 28, 22); g.destroy();
    rm('hadouken_p2'); g = scene.add.graphics();
    g.fillStyle(0xff7043, 0.45); g.fillRoundedRect(0, 2, 28, 18, 9);
    g.fillStyle(0xfff3e0, 1); g.fillRoundedRect(6, 6, 16, 10, 5);
    g.fillStyle(0xe65100, 1); g.fillCircle(14, 11, 3);
    g.generateTexture('hadouken_p2', 28, 22); g.destroy();

    // 舞台 — 道场：木质地面+远景富士/道场屋
    // 视觉替换点：舞台 -> this.load.image('ground_dojo','assets/stage1_ground.png')
    rm('ground_dojo'); g = scene.add.graphics();
    g.fillStyle(0x8d6e63, 1); g.fillRect(0, 0, 64, 32);
    g.fillStyle(0xa1887f, 1); g.fillRect(0, 0, 64, 6);
    g.lineStyle(1, 0x5d4037, 0.6); for (var i=0;i<64;i+=16) g.lineBetween(i,0,i,32);
    g.generateTexture('ground_dojo', 64, 32); g.destroy();
    rm('bg_dojo'); g = scene.add.graphics();
    g.fillStyle(0xd7ccc8, 1); g.fillRect(0, 0, 128, 96);
    g.fillStyle(0xa1887f, 1); g.fillRect(0, 64, 128, 32); // 远景屋檐
    g.fillStyle(0xffffff, 0.9); g.fillTriangle(64, 10, 44, 40, 84, 40); // 富士
    g.generateTexture('bg_dojo', 128, 96); g.destroy();

    // 舞台 — 霓虹街：沥青地面+霓虹远景
    // 视觉替换点：同上 'ground_city'/'bg_city'
    rm('ground_city'); g = scene.add.graphics();
    g.fillStyle(0x37474f, 1); g.fillRect(0, 0, 64, 32);
    g.fillStyle(0x546e7a, 1); g.fillRect(0, 0, 64, 4);
    g.lineStyle(2, 0xffeb3b, 0.9); g.lineBetween(0, 16, 64, 16); // 路中黄线
    g.generateTexture('ground_city', 64, 32); g.destroy();
    rm('bg_city'); g = scene.add.graphics();
    g.fillStyle(0x1a1d2e, 1); g.fillRect(0, 0, 128, 96);
    g.fillStyle(0x263238, 1); g.fillRect(8, 24, 32, 40); g.fillRect(50, 16, 28, 56); g.fillRect(88, 30, 32, 34);
    g.fillStyle(0x00e5ff, 0.8); g.fillRect(10, 32, 28, 3); g.fillRect(52, 40, 24, 3);
    g.fillStyle(0xff4081, 0.8); g.fillRect(90, 38, 28, 3);
    g.generateTexture('bg_city', 128, 96); g.destroy();

    // 1x1 白像素 — 血条/遮罩拉伸用
    rm('pixel'); g = scene.add.graphics(); g.fillStyle(0xffffff, 1); g.fillRect(0,0,1,1); g.generateTexture('pixel',1,1); g.destroy();
  }


  // ---------------------------------------------------------------------------
  // 玩家状态机辅助
  // ---------------------------------------------------------------------------
  function createFighterState(hp) {
    return {
      hp: hp, maxHp: hp,
      x: 0, y: 0, vx: 0, vy: 0,
      facing: 1, // 1 右 -1 左
      onGround: true,
      crouching: false,
      blocking: false,   // 防御中
      blockIsCrouch: false,
      attacking: false,
      atkKey: null,      // lp/hp/lk/hk/hadou/shoryu
      atkPhase: 0,       // 0 startup 1 active 2 recovery
      atkTimer: 0,
      hitstun: 0,        // 受击硬直剩余 ms
      blockstun: 0,      // 防御硬直
      invUntil: 0,       // 无敌帧 until (ms)
      downUntil: 0,      // 倒地起身 until
      isKnocked: false,  // 是否倒地中
      superFlash: 0,     // 必杀闪光剩余
      hadouCd: 0,        // 波动CD
      shoryuCd: 0,
      meter: 0           // 能量槽（简化版：命中/受击涨，满可放强化，暂仅显示）
    };
  }

  // ---------------------------------------------------------------------------
  // Boot / Menu
  // ---------------------------------------------------------------------------
  var BootScene = function () { Phaser.Scene.call(this, { key: 'boot' }); };
  BootScene.prototype = Object.create(Phaser.Scene.prototype);
  BootScene.prototype.constructor = BootScene;
  BootScene.prototype.create = function () {
    buildTextures(this);
    var self = this;
    if (hostRef && typeof hostRef.loadState === 'function') {
      try {
        hostRef.loadState().then(function (d) {
          if (d) {
            if (typeof d.wins === 'number') saveData.wins = d.wins | 0;
            if (typeof d.unlockedStage === 'number') saveData.unlockedStage = d.unlockedStage | 0;
            if (saveData.unlockedStage < 0) saveData.unlockedStage = 0;
            if (saveData.unlockedStage >= CFG.STAGE_COUNT) saveData.unlockedStage = CFG.STAGE_COUNT - 1;
          }
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
    this.cameras.main.setBackgroundColor('#0f1117');
    // 标题
    this.add.text(w/2, h*0.18, 'FIGHTER SF', { fontFamily: 'monospace', fontSize: '42px', color: '#ffffff', fontStyle: 'bold', stroke: '#e53935', strokeThickness: 4 }).setOrigin(0.5);
    this.add.text(w/2, h*0.26, '— 1v1 STREET FIGHTER-LIKE · BO3 两局两胜 —', { fontFamily: 'monospace', fontSize: '12px', color: '#90a4ae' }).setOrigin(0.5);
    // 输入说明
    var lines = [
      'P1: WASD 移动/跳/蹲  F 轻拳  G 重拳  H 轻腿  J 重腿  |  V 波动拳  B 升龙拳  |  S 蹲防  A 站防(后退防御)',
      'P2: 方向键 移动  小键盘 1 轻拳  2 重拳  3 轻腿  6 重腿  |  0 波动  5 升龙  | 下/后 防御',
      '单人：P1 vs AI（AI 追踪+随机出招，见 FightScene.updateAI 注释）  O 开关 Hitbox  K 切换舞台',
      '舞台：道场 / 霓虹街（地面几何与BGM不同，K 切换）  能量槽：命中涨，能量满下次波动伤害+30%',
      '存档：wins / 解锁舞台  |  Enter/Z 开始  1 单人  2 双人'
    ];
    for (var i=0;i<lines.length;i++) {
      this.add.text(w/2, h*0.34 + i*17, lines[i], { fontFamily: 'monospace', fontSize: '10px', color: '#b0bec5' }).setOrigin(0.5);
    }
    var winTxt = 'WINS ' + saveData.wins + '   UNLOCKED STAGE ' + (saveData.unlockedStage + 1) + '/' + CFG.STAGE_COUNT;
    this.add.text(w/2, h*0.58, winTxt, { fontFamily: 'monospace', fontSize: '12px', color: '#ffd54f' }).setOrigin(0.5);
    // 模式选择
    this.mode = 1; // 1 单人 2 双人
    var self = this;
    this.modeText = this.add.text(w/2, h*0.64, 'MODE: [1] 单人 vs AI  (按 1/2 切换)', { fontFamily:'monospace', fontSize:'13px', color:'#4fc3f7' }).setOrigin(0.5);
    this.stageText = this.add.text(w/2, h*0.68, 'STAGE: ' + STAGES[saveData.unlockedStage].name + '  (K 切换预览)', { fontFamily:'monospace', fontSize:'11px', color:'#aed581' }).setOrigin(0.5);
    this.curStagePreview = saveData.unlockedStage;
    var btn = this.add.text(w/2, h*0.76, '▶  FIGHT!  (Enter / Z / Space)', { fontFamily:'monospace', fontSize:'16px', color:'#ffffff', backgroundColor:'#e53935', padding:{x:16,y:8} }).setOrigin(0.5).setInteractive({useHandCursor:true});
    function go() { Sfx.ensure(); Sfx.play('punch'); self.scene.start('fight', { mode: self.mode, stage: self.curStagePreview }); }
    btn.on('pointerdown', go);
    this.input.keyboard.on('keydown-ENTER', go);
    this.input.keyboard.on('keydown-SPACE', go);
    this.input.keyboard.on('keydown-Z', go);
    this.input.keyboard.on('keydown-ONE', function(){ self.mode=1; self.modeText.setText('MODE: [1] 单人 vs AI  (按 1/2 切换)'); Sfx.play('block'); });
    this.input.keyboard.on('keydown-TWO', function(){ self.mode=2; self.modeText.setText('MODE: [2] 双人对战  (按 1/2 切换)'); Sfx.play('block'); });
    // 也支持 Numpad 1/2
    this.input.keyboard.on('keydown-NUMPAD_ONE', function(){ self.mode=1; self.modeText.setText('MODE: [1] 单人 vs AI'); Sfx.play('block'); });
    this.input.keyboard.on('keydown-NUMPAD_TWO', function(){ self.mode=2; self.modeText.setText('MODE: [2] 双人对战'); Sfx.play('block'); });
    this.input.keyboard.on('keydown-K', function(){
      self.curStagePreview = (self.curStagePreview + 1) % CFG.STAGE_COUNT;
      self.stageText.setText('STAGE: ' + STAGES[self.curStagePreview].name + '  (K 切换预览)');
      var bg = STAGES[self.curStagePreview].bg;
      self.cameras.main.setBackgroundColor(bg);
      Sfx.play('block');
    });
    this.input.once('pointerdown', function(){ Sfx.ensure(); });
    this.input.keyboard.once('keydown', function(){ Sfx.ensure(); });
  };


  // ---------------------------------------------------------------------------
  // 对战场景 FightScene — 核心
  // ---------------------------------------------------------------------------
  var FightScene = function () { Phaser.Scene.call(this, { key: 'fight' }); };
  FightScene.prototype = Object.create(Phaser.Scene.prototype);
  FightScene.prototype.constructor = FightScene;

  FightScene.prototype.init = function (data) {
    this.reqMode = (data && data.mode) ? data.mode : 1;
    this.reqStage = (data && typeof data.stage === 'number') ? data.stage : saveData.unlockedStage;
    if (this.reqStage < 0) this.reqStage = 0;
    if (this.reqStage >= CFG.STAGE_COUNT) this.reqStage = CFG.STAGE_COUNT - 1;
  };

  FightScene.prototype.create = function () {
    sceneRef = this;
    Sfx.ensure(); Sfx.resume && Sfx.resume();
    buildTextures(this);
    this.w = this.scale.width; this.h = this.scale.height;
    this.curStage = this.reqStage;
    this.stageInfo = STAGES[this.curStage];
    this.cameras.main.setBackgroundColor(this.stageInfo.bg);
    this.mode = this.reqMode; // 1 vs AI, 2 双人
    this.round = 1;
    this.p1wins = 0; this.p2wins = 0;
    this.over = false; // 整场 BO3 结束？
    this.roundOver = false;
    this.hitStopUntil = 0;
    this.showHitbox = false;
    this.winner = 0; // 0 none 1 p1 2 p2

    // ---- 舞台地面 + 远景 ----
    // 地面为 tileSprite，平铺 ground_*，地面几何差异由纹理本身体现
    // 远景为单张 image 置顶下方
    this.bgImg = this.add.image(this.w/2, this.h*0.42, this.stageInfo.bgKey).setOrigin(0.5).setDepth(0).setAlpha(1);
    // 拉伸到近满宽
    try { this.bgImg.setDisplaySize(this.w * 0.92, 180); } catch(e) {}
    this.ground = this.add.tileSprite(0, CFG.GROUND_Y, this.w, this.h - CFG.GROUND_Y, this.stageInfo.groundKey).setOrigin(0,0).setDepth(1);
    // 地面碰撞线（仅 y 钳制，不用 tilemap）

    // ---- 物理组：波动池（每人独立，便于计数） ----
    // 全部碰撞用“参数顺序无关”的矩形相交判断（display list），不依赖 Arcade overlap 顺序陷阱
    this.p1Hadoukens = this.physics.add.group({ maxSize: CFG.HADOU_POOL });
    this.p2Hadoukens = this.physics.add.group({ maxSize: CFG.HADOU_POOL });
    for (var i=0;i<CFG.HADOU_POOL;i++) {
      var h1 = this.physics.add.sprite(-100,-100,'hadouken_p1'); h1.setActive(false).setVisible(false); try{ h1.body.enable=false;}catch(e){} h1.owner=1; h1.dmg=ATK.hadou.dmg; this.p1Hadoukens.add(h1);
      var h2 = this.physics.add.sprite(-100,-100,'hadouken_p2'); h2.setActive(false).setVisible(false); try{ h2.body.enable=false;}catch(e2){} h2.owner=2; h2.dmg=ATK.hadou.dmg; this.p2Hadoukens.add(h2);
    }

    // ---- 角色精灵（sprite 仅做视觉，逻辑由 state 驱动） ----
    this.p1 = this.physics.add.sprite(0,0,'fighter_p1'); this.p1.setOrigin(0.5,1); this.p1.setDepth(10);
    this.p2 = this.physics.add.sprite(0,0,'fighter_p2'); this.p2.setOrigin(0.5,1); this.p2.setDepth(10);
    // Arcade body 以脚为基准，大小与胶囊一致
    try { this.p1.body.setSize(36, 72); this.p1.body.setOffset(4, 6); } catch(e){}
    try { this.p2.body.setSize(36, 72); this.p2.body.setOffset(4, 6); } catch(e2){}
    try { this.p1.body.allowGravity = false; this.p2.body.allowGravity = false; } catch(e){}

    // 状态机
    this.s1 = createFighterState(CFG.MAX_HP);
    this.s2 = createFighterState(CFG.MAX_HP);
    // 初始位置：左右各 1/3，y 贴地
    this.resetPositions();
    this.updateFacing();

    // Hitbox 调试叠层（Graphics，非交互）
    this.hitDebugP1 = this.add.graphics().setDepth(11);
    this.hitDebugP2 = this.add.graphics().setDepth(11);
    // 受击闪白用 tint，不额外资源
    this.flashUntilP1 = 0; this.flashUntilP2 = 0;

    // 输入映射
    // P1: WASD+FGH + V 波动 B 升龙（两种必杀键位，便于单手）
    // P2: 方向键 + 小键盘 1/2/3/6/0/5；同时也支持 IJKL 备用（若无小键盘）
    this.keysP1 = this.input.keyboard.addKeys({
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
      F: Phaser.Input.Keyboard.KeyCodes.F,
      G: Phaser.Input.Keyboard.KeyCodes.G,
      H: Phaser.Input.Keyboard.KeyCodes.H,
      J: Phaser.Input.Keyboard.KeyCodes.J,
      V: Phaser.Input.Keyboard.KeyCodes.V,
      B: Phaser.Input.Keyboard.KeyCodes.B
    });
    this.keysP2 = this.input.keyboard.addKeys({
      UP: Phaser.Input.Keyboard.KeyCodes.UP,
      DOWN: Phaser.Input.Keyboard.KeyCodes.DOWN,
      LEFT: Phaser.Input.Keyboard.KeyCodes.LEFT,
      RIGHT: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      NUM1: Phaser.Input.Keyboard.KeyCodes.NUMPAD_ONE,
      NUM2: Phaser.Input.Keyboard.KeyCodes.NUMPAD_TWO,
      NUM3: Phaser.Input.Keyboard.KeyCodes.NUMPAD_THREE,
      NUM6: Phaser.Input.Keyboard.KeyCodes.NUMPAD_SIX,
      NUM0: Phaser.Input.Keyboard.KeyCodes.NUMPAD_ZERO,
      NUM5: Phaser.Input.Keyboard.KeyCodes.NUMPAD_FIVE,
      I: Phaser.Input.Keyboard.KeyCodes.I,
      O: Phaser.Input.Keyboard.KeyCodes.O,
      K: Phaser.Input.Keyboard.KeyCodes.K,
      L: Phaser.Input.Keyboard.KeyCodes.L
    });
    // 通用：R 重开本局，M 回菜单，O 调试，K 切舞台将在 update 响应 JustDown
    this.keyR = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
    this.keyM = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M);
    this.keyO = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.O);
    this.keyK = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.K);
    this.keyENTER = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
    this.keySPACE = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    // 也监听数字 1/2 用于菜单（本场景不用）

    // ---- HUD：血条+能量槽+回合数 ----
    var pad = 12;
    // P1 血条背景+前景
    this.hpBgP1 = this.add.image(pad, pad, 'pixel').setOrigin(0,0).setDisplaySize(320, 18).setTint(0x263238).setDepth(20);
    this.hpBarP1 = this.add.image(pad, pad, 'pixel').setOrigin(0,0).setDisplaySize(320, 18).setTint(0x4caf50).setDepth(21);
    this.hpTextP1 = this.add.text(pad+6, pad+2, 'P1', {fontFamily:'monospace', fontSize:'12px', color:'#ffffff'}).setDepth(22);
    // P2 血条（右对齐）
    this.hpBgP2 = this.add.image(this.w - pad - 320, pad, 'pixel').setOrigin(0,0).setDisplaySize(320, 18).setTint(0x263238).setDepth(20);
    this.hpBarP2 = this.add.image(this.w - pad - 320, pad, 'pixel').setOrigin(0,0).setDisplaySize(320, 18).setTint(0xef5350).setDepth(21);
    this.hpTextP2 = this.add.text(this.w - pad - 6, pad+2, 'P2', {fontFamily:'monospace', fontSize:'12px', color:'#ffffff'}).setOrigin(1,0).setDepth(22);
    // 能量槽（简化版：命中涨，满 100 后下次波动增伤并清空）
    this.meterBgP1 = this.add.image(pad, pad+22, 'pixel').setOrigin(0,0).setDisplaySize(180, 7).setTint(0x1a2332).setDepth(20);
    this.meterBarP1 = this.add.image(pad, pad+22, 'pixel').setOrigin(0,0).setDisplaySize(0, 7).setTint(0x4fc3f7).setDepth(21);
    this.meterBgP2 = this.add.image(this.w - pad - 180, pad+22, 'pixel').setOrigin(0,0).setDisplaySize(180, 7).setTint(0x1a2332).setDepth(20);
    this.meterBarP2 = this.add.image(this.w - pad - 180, pad+22, 'pixel').setOrigin(0,0).setDisplaySize(0, 7).setTint(0xff8a65).setDepth(21);
    // 回合/舞台标识
    this.roundText = this.add.text(this.w/2, pad+8, '', {fontFamily:'monospace', fontSize:'13px', color:'#ffffff', stroke:'#000000', strokeThickness:3}).setOrigin(0.5).setDepth(22);
    this.stageLabel = this.add.text(this.w/2, pad+28, this.stageInfo.name + '  ROUND ' + this.round, {fontFamily:'monospace', fontSize:'11px', color:'#ffd54f', stroke:'#000000', strokeThickness:3}).setOrigin(0.5).setDepth(22);
    this.winsText = this.add.text(this.w/2, pad+44, 'P1 0 - 0 P2', {fontFamily:'monospace', fontSize:'11px', color:'#e0f7fa'}).setOrigin(0.5).setDepth(22);
    // 胜负横幅
    this.centerText = this.add.text(this.w/2, this.h/2 - 40, '', {fontFamily:'monospace', fontSize:'22px', color:'#ffffff', stroke:'#000000', strokeThickness:5, align:'center'}).setOrigin(0.5).setDepth(30).setVisible(false);
    this.hintText = this.add.text(this.w/2, this.h - 18, 'O Hitbox  K 切舞台  R 重开  M 菜单  Enter/SPACE 下一局', {fontFamily:'monospace', fontSize:'10px', color:'#90a4ae'}).setOrigin(0.5).setDepth(22);

    // 受击数字池
    this.hitNums = [];

    // BGM 启动（按舞台区分）
    Sfx.startBgm(this, this.curStage);
    // 首输入 resume
    this.input.once('pointerdown', function(){ Sfx.ensure(); if (Sfx.ctx && Sfx.ctx.state==='suspended') try{Sfx.ctx.resume();}catch(e){} });
    this.input.keyboard.once('keydown', function(){ Sfx.ensure(); });

    this.updateHud();
    this.showRoundBanner();
  };


  // ---------------------------------------------------------------------------
  // FightScene 原型方法
  // ---------------------------------------------------------------------------
  FightScene.prototype.resetPositions = function () {
    var gx = CFG.GROUND_Y;
    var cx = this.w / 2;
    this.s1.x = cx - 180; this.s1.y = gx; this.s1.vx = 0; this.s1.vy = 0;
    this.s1.onGround = true; this.s1.crouching = false; this.s1.blocking = false;
    this.s1.hitstun = 0; this.s1.blockstun = 0; this.s1.attacking = false; this.s1.atkKey = null;
    this.s1.downUntil = 0; this.s1.isKnocked = false;
    this.s2.x = cx + 180; this.s2.y = gx; this.s2.vx = 0; this.s2.vy = 0;
    this.s2.onGround = true; this.s2.crouching = false; this.s2.blocking = false;
    this.s2.hitstun = 0; this.s2.blockstun = 0; this.s2.attacking = false; this.s2.atkKey = null;
    this.s2.downUntil = 0; this.s2.isKnocked = false;
    // 视觉坐标同步用 body.reset 传送（Phaser 陷阱：setPosition 会被下一帧 physics 覆盖）
    if (this.p1 && this.p1.body) try { this.p1.body.reset(this.s1.x, this.s1.y); } catch(e) { this.p1.x=this.s1.x; this.p1.y=this.s1.y; }
    if (this.p2 && this.p2.body) try { this.p2.body.reset(this.s2.x, this.s2.y); } catch(e2) { this.p2.x=this.s2.x; this.p2.y=this.s2.y; }
    this.updateFacing();
  };

  FightScene.prototype.updateFacing = function () {
    // 始终面向对手
    if (!this.s1 || !this.s2) return;
    if (this.s1.x < this.s2.x) { this.s1.facing = 1; this.s2.facing = -1; }
    else { this.s1.facing = -1; this.s2.facing = 1; }
    if (this.p1) this.p1.setFlipX(this.s1.facing < 0);
    if (this.p2) this.p2.setFlipX(this.s2.facing < 0);
  };

  FightScene.prototype.showRoundBanner = function () {
    var self = this;
    var fi = this.round === 1 ? 'ROUND 1' : (this.round === 2 ? 'ROUND 2' : 'FINAL ROUND');
    this.centerText.setText(fi + '\n' + this.stageInfo.name + '  —  FIGHT!').setVisible(true);
    this.roundOver = true; // banner 期间冻结输入
    this.time.delayedCall(900, function(){
      self.centerText.setVisible(false);
      self.roundOver = false;
    });
  };

  FightScene.prototype.allocHadou = function (owner) {
    var grp = (owner === 1) ? this.p1Hadoukens : this.p2Hadoukens;
    var b = grp.getFirstDead(false);
    if (!b) {
      // 池满复用最旧活跃弹（池化复用，不额外 alloc）
      var alive = grp.getChildren();
      for (var i=0;i<alive.length;i++) if (alive[i].active) { b = alive[i]; break; }
      if (!b) return null;
    }
    return b;
  };

  FightScene.prototype.fireHadouken = function (owner) {
    var s = (owner === 1) ? this.s1 : this.s2;
    var other = (owner === 1) ? this.s2 : this.s1;
    if (s.hadouCd > 0) return;
    Sfx.play('hadouken');
    var b = this.allocHadou(owner);
    if (!b) return;
    var boosted = (s.meter >= 100);
    if (boosted) { s.meter = 0; }
    // 起点在胸前
    var sx = s.x + s.facing * 30;
    var sy = s.y - 34;
    b.setTexture(owner === 1 ? 'hadouken_p1' : 'hadouken_p2');
    b.setPosition(sx, sy);
    b.setActive(true).setVisible(true);
    try { b.body.enable = true; } catch(e){}
    try { b.body.setCircle(9); } catch(e2) { try{ b.body.setSize(20,16);}catch(e3){} }
    // 速度朝 facing
    var vx = s.facing * CFG.HADOU_SPEED;
    b.setVelocity(vx, 0);
    b.dmg = boosted ? Math.round(ATK.hadou.dmg * 1.3) : ATK.hadou.dmg;
    b.boosted = boosted;
    // 胶囊视觉大小
    b.setScale(boosted ? 1.15 : 1);
    s.hadouCd = 900; // ms 冷却
    // 攻击状态后摇
    s.attacking = true; s.atkKey = 'hadou';
    s.atkPhase = 2; s.atkTimer = ATK.hadou.rec;
  };

  FightScene.prototype.startAttack = function (owner, key) {
    var s = (owner === 1) ? this.s1 : this.s2;
    if (s.hitstun > 0 || s.blockstun > 0 || s.isKnocked) return;
    if (s.attacking) return; // 简化：不 cancel
    if (key === 'hadou' || key === 'shoryu') {
      if (key === 'hadou') { this.fireHadouken(owner); return; }
      // 升龙：上冲 + 无敌帧
      if (s.shoryuCd > 0) return;
      Sfx.play('shoryu');
      s.attacking = true; s.atkKey = 'shoryu';
      s.atkPhase = 0; s.atkTimer = ATK.shoryu.startup;
      s.invUntil = this.time.now + 260; // 升龙前半段无敌（inv 帧）
      s.onGround = false;
      s.vy = -520; // 上冲速度
      s.vx = s.facing * 90;
      s.shoryuCd = 1800;
      s.superFlash = 160;
      return;
    }
    // 普通拳脚
    var atk = ATK[key];
    if (!atk) return;
    if (key === 'hp' || key === 'hk') Sfx.play(key === 'hp' ? 'punch' : 'kick');
    else if (key === 'lp') Sfx.play('punch');
    else Sfx.play('kick');
    s.attacking = true; s.atkKey = key;
    s.atkPhase = 0; s.atkTimer = atk.startup;
  };

  FightScene.prototype.tryHit = function (atkOwner, atkKey) {
    // 计算受击判定：攻击 hitbox 与受击 hurtbox 相交（参数顺序无关，矩形相交）
    var aS = (atkOwner === 1) ? this.s1 : this.s2;
    var dS = (atkOwner === 1) ? this.s2 : this.s1;
    var dOwner = (atkOwner === 1) ? 2 : 1;
    if (dS.isKnocked) return false; // 倒地无敌
    if (this.time.now < dS.invUntil) return false;
    var atk = ATK[atkKey];
    if (!atk) return false;
    // 攻击 hitbox（仅 active 帧有效）
    if (aS.atkPhase !== 1) return false;
    // 升龙 active 期间 hitbox 随升龙位置
    var range = atk.range, height = atk.height, yOff = atk.yOff;
    // 升龙 yOff 需跟踪实际 y（空中）
    var ax, ay, aw, ah;
    if (atkKey === 'shoryu') {
      // 升龙拳身周围大 hitbox
      ax = aS.x + aS.facing * 10 - range/2;
      ay = aS.y + yOff - height/2;
      aw = range; ah = height;
      // 上冲时 ay 跟随 vy
      ay = aS.y - 40 - height/2;
    } else {
      ax = aS.x + aS.facing * (range/2 + 10) - range/2;
      ay = (aS.crouching ? aS.y - 18 : aS.y + yOff) - height/2;
      aw = range; ah = height;
    }
    // 受击 hurtbox（胶囊近似矩形）
    var hurtW = dS.crouching ? 32 : 30;
    var hurtH = dS.crouching ? 48 : 68;
    var hx = dS.x - hurtW/2;
    var hy = (dS.crouching ? dS.y - hurtH : dS.y - hurtH + 4);
    var hw = hurtW, hh = hurtH;
    // 相交检测（顺序无关）
    var hit = __omp_shell("(ax + aw < hx || hx + hw < ax || ay + ah < hy || hy + hh < ay);")
    if (!hit) return false;
    // 判定防御：站防（后退键）与蹲防（下+后 或蹲状态+后）
    var isBlocking = false;
    var crouchBlock = false;
    if (dS.blocking) {
      // 防御需面向错误方向（即按后退），已在输入中计算 blocking
      // 轻/重腿对蹲防判定：蹲防可防中下段，站防不可防蹲姿攻击？简化：蹲防减伤相同，但下段攻击对站防仍有 chip
      // 本作简化：所有攻击站防/蹲防均可防御，仅蹲姿重腿对站防额外 2 伤害由 chip 体现
      isBlocking = true;
      crouchBlock = dS.blockIsCrouch;
    }
    // 若防御但 atacante 为升龙且为下段蹲姿命中，站防破防（可选简化：升龙不可防御）
    // 本作：升龙对防御 chip 减半但仍可防
    if (isBlocking) {
      var chip = atk.chip;
      if (crouchBlock && (atkKey === 'hp' || atkKey === 'lp')) chip = Math.max(0, chip - 1);
      dS.hp -= chip;
      if (dS.hp < 0) dS.hp = 0;
      dS.blockstun = atk.bs;
      // 击退
      dS.vx = aS.facing * (atk.push * 0.6);
      if (dS.onGround) dS.x += aS.facing * (atk.push * 0.6) * 0.18;
      Sfx.play('block');
      this.spawnHitNum(dS.x, dS.y - 60, 'BLOCK', '#90caf9');
      // 防御不涨 meter 给防御方，仅攻击方微涨
      aS.meter = Math.min(100, aS.meter + 2);
    } else {
      dS.hp -= atk.dmg;
      if (dS.hp < 0) dS.hp = 0;
      // 受击硬直 + 击退
      dS.hitstun = atk.hs;
      dS.vx = aS.facing * atk.push * 1.1;
      dS.vy = atk.kd ? -160 : 0;
      // 倒地判定：hk/shoryu 且血量触发或 hk 总倒地
      var shouldKnock = false;
      if (atk.kd) {
        if (atkKey === 'hk' || atkKey === 'shoryu') shouldKnock = true;
        // 也可用血量阈值，但为保证 至少可 KO，hk 必倒地
      }
      if (shouldKnock && dS.hp > 0) {
        // 非 KO 的击倒：倒地起身 700ms
        dS.isKnocked = true;
        dS.downUntil = this.time.now + 700;
        dS.hitstun = 0;
        dS.vy = -220;
        dS.vx = aS.facing * 120;
      }
      // KO 将在外层检测后处理倒地
      Sfx.play('hit');
      this.spawnHitNum(dS.x, dS.y - 62, '-' + atk.dmg, '#ff8a80');
      // hitstop
      this.hitStopUntil = this.time.now + CFG.HITSTOP_MS;
      // meter
      aS.meter = Math.min(100, aS.meter + (atkKey==='hp'||atkKey==='hk'?6:4));
      dS.meter = Math.min(100, dS.meter + 3);
      // 闪白
      if (dOwner === 1) this.flashUntilP1 = this.time.now + 80;
      else this.flashUntilP2 = this.time.now + 80;
    }
    // 同一 active 帧内不重复命中同一目标，由外层清 atkPhase 控制（命中后留在 active 不重复）
    return true;
  };

  FightScene.prototype.spawnHitNum = function (x, y, text, color) {
    var t = this.add.text(x, y, text, { fontFamily:'monospace', fontSize:'14px', color: color, stroke:'#000', strokeThickness:3 }).setOrigin(0.5).setDepth(25);
    this.tweens.add({ targets: t, y: y - 28, alpha: 0, duration: 420, onComplete: function(){ t.destroy(); } });
  };

  FightScene.prototype.applyDamage = function (victimOwner, dmg, isBlock) {
    var s = (victimOwner === 1) ? this.s1 : this.s2;
    if (this.time.now < s.invUntil) return;
    if (isBlock) { s.hp -= Math.max(0, Math.round(dmg * 0.15)); s.blockstun = 180; Sfx.play('block'); }
    else { s.hp -= dmg; s.hitstun = 420; s.vx = (victimOwner===1? -1:1) * 90; Sfx.play('hit'); this.hitStopUntil = this.time.now + 80;
      if (victimOwner===1) this.flashUntilP1=this.time.now+90; else this.flashUntilP2=this.time.now+90;
      s.meter = Math.min(100, s.meter+3);
    }
    if (s.hp < 0) s.hp = 0;
  };

  FightScene.prototype.onKO = function (loserOwner) {
    if (this.roundOver) return;
    this.roundOver = true;
    var loser = (loserOwner===1)? this.s1:this.s2;
    var winner = (loserOwner===1)? 2:1;
    this.winner = winner;
    // 倒地状态
    loser.isKnocked = true;
    loser.downUntil = this.time.now + 1500;
    loser.hitstun = 0; loser.blockstun = 0; loser.attacking = false;
    loser.vy = -180; loser.vx = (winner===1?1:-1) * 40;
    if (winner===1) this.p1wins++; else this.p2wins++;
    this.updateHud();
    Sfx.play('ko');
    Sfx.stopBgm();
    var text = 'K.O.!';
    if (this.p1wins >= CFG.BO3 || this.p2wins >= CFG.BO3) {
      var champ = (this.p1wins >= CFG.BO3) ? 'P1 WINS' : 'P2 WINS';
      this.centerText.setText(text + '\n' + champ + '  ' + this.p1wins + '-' + this.p2wins + '\n[Enter] 重赛  [M] 菜单  [K] 换舞台').setVisible(true);
      this.over = true;
      // 存档：总胜场累加，解锁下一舞台
      saveData.wins += 1;
      if (this.curStage + 1 < CFG.STAGE_COUNT && this.curStage >= saveData.unlockedStage) {
        saveData.unlockedStage = this.curStage + 1;
      }
      this.saveProgress();
    } else {
      this.centerText.setText(text + '  ' + (winner===1?'P1':'P2') + ' 得分  ' + this.p1wins + '-' + this.p2wins + '\n下一局...').setVisible(true);
      var self = this;
      this.time.delayedCall(CFG.KO_DELAY_MS + 400, function(){
        if (self.over) return;
        self.startNextRound();
      });
    }
  };

  FightScene.prototype.startNextRound = function () {
    this.round += 1;
    this.roundOver = false;
    this.winner = 0;
    this.hitStopUntil = 0;
    this.s1.hp = CFG.MAX_HP; this.s2.hp = CFG.MAX_HP;
    this.s1.meter = 0; this.s2.meter = 0;
    // 清波动
    var self=this;
    this.p1Hadoukens.getChildren().forEach(function(b){ b.setActive(false).setVisible(false); try{b.body.enable=false;}catch(e){} b.setVelocity(0,0); });
    this.p2Hadoukens.getChildren().forEach(function(b){ b.setActive(false).setVisible(false); try{b.body.enable=false;}catch(e){} b.setVelocity(0,0); });
    this.resetPositions();
    this.centerText.setVisible(false);
    this.stageLabel.setText(this.stageInfo.name + '  ROUND ' + this.round);
    this.updateHud();
    Sfx.startBgm(this, this.curStage);
    this.showRoundBanner();
  };

  FightScene.prototype.saveProgress = function () {
    try {
      if (hostRef && hostRef.saveState) hostRef.saveState({ wins: saveData.wins, unlockedStage: saveData.unlockedStage }).then(function(){}, function(){});
    } catch(e){}
  };

  // ---------------------------------------------------------------------------
  // AI — 简单追踪+随机出招（注释说明）
  // 注释：AI 输入映射与玩家一致，逻辑为：
  //  1) 追踪：保持理想距离 ideal~90，若远则前进，若近则后退/下蹲
  //  2) 随机节拍：每 ~400-900ms 评估一次出招概率，
  //     距离近→拳脚，距离中→波动，贴身→升龙/重腿为终结
  //  3) 防御：当对手 active 帧且在范围内，按概率进入防御（站防/蹲防）
  //  为保证可KO，不做完美防御与无敌滥用
  // ---------------------------------------------------------------------------
  FightScene.prototype.updateAI = function (time, delta) {
    // 仅在单人模式且本帧为 AI 角色（P2）时调用
    var ai = this.s2, pl = this.s1;
    if (!ai || !pl) return;
    if (ai.hitstun > 0 || ai.blockstun > 0 || ai.isKnocked || this.roundOver || this.over) return;
    if (ai.attacking) return;
    var dist = Math.abs(pl.x - ai.x);
    var dx = pl.x - ai.x; // 正则：pl 在 ai 右边为 +
    // 防御：对手正在攻击且距离近
    var oppAttacking = pl.attacking && pl.atkPhase === 1;
    if (oppAttacking && dist < 64 && Math.random() < 0.55) {
      // 按对手 yOff 推断上/下段，随机站防/蹲防
      var wantCrouch = Math.random() < 0.4;
      ai.blocking = true;
      ai.blockIsCrouch = wantCrouch;
      ai.crouching = wantCrouch;
      // 防御时不移动
      ai.vx = 0;
      return;
    } else {
      // 非防御帧清空防御
      // 保留蹲姿由移动逻辑决定
    }
    // 移动追踪
    var ideal = 90;
    var move = 0;
    if (dist > ideal + 22) move = Math.sign(dx); // 靠近
    else if (dist < ideal - 30) move = -Math.sign(dx) * 0.7; // 拉开
    else move = (Math.random()<0.5? Math.sign(dx)*0.3 : 0);
    // 偶发蹲下
    ai.crouching = (Math.random() < 0.06) && ai.onGround;
    ai.blocking = false;
    // 应用速度（追踪速度略低于玩家，保持可拉扯）
    if (!ai.crouching) {
      ai.vx = move * CFG.WALK_SPEED * 0.82;
    } else ai.vx = 0;

    // 出招节拍
    if (!this._aiNextAt) this._aiNextAt = time + 500;
    if (time >= this._aiNextAt) {
      this._aiNextAt = time + Phaser.Math.Between(350, 900);
      var facingToPlayer = (Math.sign(dx) === ai.facing);
      if (!facingToPlayer) { this.updateFacing(); }
      // 距离分段选招
      if (dist < 70) {
        var r = Math.random();
        if (r < 0.22) this.startAttack(2, 'lp');
        else if (r < 0.44) this.startAttack(2, 'lk');
        else if (r < 0.64) this.startAttack(2, 'hp');
        else if (r < 0.82) this.startAttack(2, 'hk');
        else if (r < 0.92 && ai.shoryuCd <= 0) this.startAttack(2, 'shoryu');
        else if (ai.hadouCd <= 0) this.startAttack(2, 'hadou');
      } else if (dist < 160) {
        var r2 = Math.random();
        if (r2 < 0.45 && ai.hadouCd <= 0) this.startAttack(2, 'hadou');
        else if (r2 < 0.7) this.startAttack(2, 'hk');
        else if (r2 < 0.85) this.startAttack(2, 'hp');
        else this.startAttack(2, 'lk');
      } else {
        if (Math.random() < 0.65 && ai.hadouCd <= 0) this.startAttack(2, 'hadou');
        else if (Math.random() < 0.3) {
          // 远距离靠近后再打
        }
      }
    }
  };


  // ---------------------------------------------------------------------------
  // FightScene.update — 每帧驱动
  // ---------------------------------------------------------------------------
  FightScene.prototype.update = function (time, delta) {
    var dt = delta / 1000;
    if (!this.s1 || !this.s2) return;

    // 全局按键：R/M/O/K/Enter（KO 后流程）
    if (Phaser.Input.Keyboard.JustDown(this.keyR)) {
      // 重开当前 BO3（重置比分）
      this.p1wins=0; this.p2wins=0; this.round=1; this.over=false; this.roundOver=false;
      this.s1.hp=CFG.MAX_HP; this.s2.hp=CFG.MAX_HP; this.s1.meter=0; this.s2.meter=0;
      this.s1.isKnocked=false; this.s2.isKnocked=false;
      this.centerText.setVisible(false);
      this.resetPositions();
      this.updateHud();
      Sfx.startBgm(this, this.curStage);
      this.showRoundBanner();
      return;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyM)) {
      Sfx.stopBgm(); this.scene.start('menu'); return;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyO)) {
      this.showHitbox = __omp_shell("this.showHitbox;")
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyK)) {
      // 切舞台（仅非 KO 中，切换后保留比分与血量，仅换 skin+BGM）
      this.curStage = (this.curStage + 1) % CFG.STAGE_COUNT;
      this.stageInfo = STAGES[this.curStage];
      this.cameras.main.setBackgroundColor(this.stageInfo.bg);
      try { this.bgImg.setTexture(this.stageInfo.bgKey); } catch(e) {}
      try { this.ground.setTexture(this.stageInfo.groundKey); } catch(e2) {}
      this.stageLabel.setText(this.stageInfo.name + '  ROUND ' + this.round);
      Sfx.startBgm(this, this.curStage);
      // 存档解锁若切到已解锁外则不额外解锁
      Sfx.play('block');
    }
    // KO 后 Enter/SPACE 处理
    if (this.over) {
      if (Phaser.Input.Keyboard.JustDown(this.keyENTER) || Phaser.Input.Keyboard.JustDown(this.keySPACE)) {
        // 整场结束后的重赛
        this.p1wins=0; this.p2wins=0; this.round=1; this.over=false; this.roundOver=false;
        this.s1.hp=CFG.MAX_HP; this.s2.hp=CFG.MAX_HP; this.s1.meter=0; this.s2.meter=0;
        this.s1.isKnocked=false; this.s2.isKnocked=false;
        this.centerText.setVisible(false);
        this.resetPositions();
        this.updateHud();
        Sfx.startBgm(this, this.curStage);
        this.showRoundBanner();
      }
      return;
    }
    if (this.roundOver) {
      // banner 期间仍更新位置同步与 HUD，但冻结输入与物理
      this.syncSprites();
      this.drawHitDebug();
      return;
    }
    // hitstop：冻结逻辑 dt，但仍绘制
    if (time < this.hitStopUntil) {
      this.drawHitDebug();
      return;
    }

    // 冷却递减
    if (this.s1.hadouCd > 0) { this.s1.hadouCd -= delta; if (this.s1.hadouCd<0) this.s1.hadouCd=0; }
    if (this.s2.hadouCd > 0) { this.s2.hadouCd -= delta; if (this.s2.hadouCd<0) this.s2.hadouCd=0; }
    if (this.s1.shoryuCd > 0) { this.s1.shoryuCd -= delta; if (this.s1.shoryuCd<0) this.s1.shoryuCd=0; }
    if (this.s2.shoryuCd > 0) { this.s2.shoryuCd -= delta; if (this.s2.shoryuCd<0) this.s2.shoryuCd=0; }
    if (this.s1.superFlash > 0) this.s1.superFlash -= delta;
    if (this.s2.superFlash > 0) this.s2.superFlash -= delta;

    // 倒地起身计时（isKnocked 期间冻结输入，downUntil 后起身并给短无敌）
    for (var ko=1; ko<=2; ko++) {
      var sk = (ko===1)?this.s1:this.s2;
      if (sk.isKnocked && time >= sk.downUntil) {
        sk.isKnocked = false;
        sk.invUntil = time + 220;
        sk.hitstun = 0; sk.blockstun = 0;
        // 起身位置微调避免穿墙
        if (sk.x < 30) sk.x = 30;
        if (sk.x > this.w - 30) sk.x = this.w - 30;
      }
    }

    // 受击/防御硬直递减
    if (this.s1.hitstun > 0) { this.s1.hitstun -= delta; if (this.s1.hitstun<=0) {this.s1.hitstun=0; this.s1.attacking=false; this.s1.atkKey=null;}}
    if (this.s2.hitstun > 0) { this.s2.hitstun -= delta; if (this.s2.hitstun<=0) {this.s2.hitstun=0; this.s2.attacking=false; this.s2.atkKey=null;}}
    if (this.s1.blockstun > 0) { this.s1.blockstun -= delta; if (this.s1.blockstun<=0) this.s1.blockstun=0; }
    if (this.s2.blockstun > 0) { this.s2.blockstun -= delta; if (this.s2.blockstun<=0) this.s2.blockstun=0; }

    // 攻击状态机（startup->active->recovery）
    for (var a=1;a<=2;a++) {
      var sa = (a===1)?this.s1:this.s2;
      if (!sa.attacking || !sa.atkKey) continue;
      var atk = ATK[sa.atkKey];
      if (!atk) { sa.attacking=false; continue; }
      sa.atkTimer -= delta;
      if (sa.atkTimer <= 0) {
        if (sa.atkPhase === 0) {
          sa.atkPhase = 1; sa.atkTimer = atk.active > 0 ? atk.active : 90;
          // 波动的 active 已在 fireHadouken 中处理，此处仅拳脚进入 active
          if (sa.atkKey === 'hadou') { sa.atkPhase = 2; sa.atkTimer = atk.rec; }
        } else if (sa.atkPhase === 1) {
          sa.atkPhase = 2; sa.atkTimer = atk.rec;
        } else {
          sa.attacking = false; sa.atkKey = null; sa.atkPhase = 0;
        }
      }
    }

    // ---- 输入采样（双人映射；单人时 P2 由 AI 驱动） ----
    // P1 输入（两种必杀：V 波动 B 升龙；方向采用 A/D 与 W/S）
    if (!this.s1.isKnocked && this.s1.hitstun<=0 && this.s1.blockstun<=0) {
      var s1 = this.s1;
      // 方向：A/D 走，W 跳，S 蹲；后退=防御（A 当 facing=1 时后退，反之 D）
      var p1Left = this.keysP1.A.isDown, p1Right = this.keysP1.D.isDown;
      var p1Up = this.keysP1.W.isDown, p1Down = this.keysP1.S.isDown;
      // 蹲
      s1.crouching = __omp_shell("!p1Down && s1.onGround;")
      // 防御判定：按住后退键（相对于 facing）
      var p1Back = (s1.facing===1 && p1Left) || (s1.facing===-1 && p1Right);
      // 蹲防需同时蹲+后退
      if (p1Back && !s1.attacking) { s1.blocking = true; s1.blockIsCrouch = !!s1.crouching; } else s1.blocking = false;

      // 移动（硬直/攻击中不走；蹲中不走；blockstun 不走）
      var canMove = __omp_shell("s1.attacking && s1.hitstun<=0 && s1.blockstun<=0 && !s1.crouching && !s1.blocking;")
      if (canMove) {
        var dir1 = 0;
        if (p1Left) dir1 -= 1;
        if (p1Right) dir1 += 1;
        s1.vx = dir1 * CFG.WALK_SPEED;
        // 跳：JustDown 且在地面
        var jump1 = false;
        try { jump1 = Phaser.Input.Keyboard.JustDown(this.keysP1.W); } catch(e){}
        if (jump1 && s1.onGround) {
          s1.vy = -CFG.JUMP_VEL; s1.onGround = false; Sfx.play('jump');
        }
      } else if (s1.attacking || s1.crouching || s1.blocking) {
        // 攻击/蹲/防时横向速度归零（保留被击退速度则由 hit 覆盖）
        if (s1.attacking) { /* 保留升龙 vx */ if (s1.atkKey!=='shoryu') s1.vx *= 0.6; }
        else s1.vx = 0;
      }

      // 出招（JustDown）
      try {
        if (Phaser.Input.Keyboard.JustDown(this.keysP1.F)) this.startAttack(1, 'lp');
        if (Phaser.Input.Keyboard.JustDown(this.keysP1.G)) this.startAttack(1, 'hp');
        if (Phaser.Input.Keyboard.JustDown(this.keysP1.H)) this.startAttack(1, 'lk');
        if (Phaser.Input.Keyboard.JustDown(this.keysP1.J)) this.startAttack(1, 'hk');
        if (Phaser.Input.Keyboard.JustDown(this.keysP1.V)) this.startAttack(1, 'hadou');
        if (Phaser.Input.Keyboard.JustDown(this.keysP1.B)) this.startAttack(1, 'shoryu');
      } catch(e){}
    } else if (this.s1.hitstun>0 || this.s1.blockstun>0) {
      // 受击中按后退仍可进入防御（简化不立即切）
      this.s1.blocking = false;
    }

    // P2 输入：双人模式下读键；单人由 AI
    if (this.mode === 2) {
      if (!this.s2.isKnocked && this.s2.hitstun<=0 && this.s2.blockstun<=0) {
        var s2 = this.s2;
        var p2Left = this.keysP2.LEFT.isDown, p2Right = this.keysP2.RIGHT.isDown;
        var p2Up = this.keysP2.UP.isDown, p2Down = this.keysP2.DOWN.isDown;
        s2.crouching = __omp_shell("!p2Down && s2.onGround;")
        var p2Back = (s2.facing===1 && p2Left) || (s2.facing===-1 && p2Right);
        if (p2Back && !s2.attacking) { s2.blocking = true; s2.blockIsCrouch = !!s2.crouching; } else s2.blocking = false;
        var canMove2 = __omp_shell("s2.attacking && s2.hitstun<=0 && s2.blockstun<=0 && !s2.crouching && !s2.blocking;")
        if (canMove2) {
          var dir2 = 0;
          if (p2Left) dir2 -= 1;
          if (p2Right) dir2 += 1;
          s2.vx = dir2 * CFG.WALK_SPEED;
          var jump2=false; try{ jump2=Phaser.Input.Keyboard.JustDown(this.keysP2.UP);}catch(e){}
          if (jump2 && s2.onGround) { s2.vy = -CFG.JUMP_VEL; s2.onGround=false; Sfx.play('jump'); }
        } else { if (s2.attacking) { if (s2.atkKey!=='shoryu') s2.vx*=0.6; } else s2.vx=0; }
        try {
          var k1=false,k2=false,k3=false,k6=false,k0=false,k5=false;
          try{ k1=Phaser.Input.Keyboard.JustDown(this.keysP2.NUM1) || Phaser.Input.Keyboard.JustDown(this.keysP2.I);}catch(e){}
          try{ k2=Phaser.Input.Keyboard.JustDown(this.keysP2.NUM2);}catch(e){}
          try{ k3=Phaser.Input.Keyboard.JustDown(this.keysP2.NUM3) || Phaser.Input.Keyboard.JustDown(this.keysP2.K);}catch(e){}
          try{ k6=Phaser.Input.Keyboard.JustDown(this.keysP2.NUM6) || Phaser.Input.Keyboard.JustDown(this.keysP2.L);}catch(e){}
          try{ k0=Phaser.Input.Keyboard.JustDown(this.keysP2.NUM0) || Phaser.Input.Keyboard.JustDown(this.keysP2.O);}catch(e){}
          try{ k5=Phaser.Input.Keyboard.JustDown(this.keysP2.NUM5);}catch(e){}
          if (k1) this.startAttack(2,'lp');
          if (k2) this.startAttack(2,'hp');
          if (k3) this.startAttack(2,'lk');
          if (k6) this.startAttack(2,'hk');
          if (k0) this.startAttack(2,'hadou');
          if (k5) this.startAttack(2,'shoryu');
        } catch(e){}
      } else this.s2.blocking=false;
    } else {
      // 单人 AI 驱动 P2
      this.updateAI(time, delta);
    }

    // ---- 物理积分（简易：x+=vx*dt, y+=vy*dt, vy+=g*dt） ----
    for (var pi=1; pi<=2; pi++) {
      var sp = (pi===1)?this.s1:this.s2;
      if (sp.isKnocked) {
        // 倒地时仍受重力与摩擦
        sp.vy += CFG.GRAVITY * dt;
        sp.x += sp.vx * dt;
        sp.y += sp.vy * dt;
        // 地面反弹一次后躺平
        if (sp.y >= CFG.GROUND_Y) {
          sp.y = CFG.GROUND_Y;
          if (sp.vy > 0) {
            sp.vy = -sp.vy * 0.22;
            sp.vx *= 0.65;
            if (Math.abs(sp.vy) < 40) { sp.vy = 0; sp.vx *= 0.92; }
          }
          sp.onGround = true;
        } else sp.onGround = false;
        // 轻摩擦
        sp.vx *= (sp.onGround ? 0.88 : 0.99);
        if (Math.abs(sp.vx) < 2) sp.vx = 0;
        continue;
      }
      // 硬直中速度由命中设定，此时不再施加输入速度，仅做重力与摩擦
      var inHit = (sp.hitstun>0 || sp.blockstun>0);
      if (!inHit && !sp.attacking) {
        // vx 已由输入设定
      } else if (sp.attacking && sp.atkKey==='shoryu') {
        // 升龙已有 vx/vy
      } else if (inHit) {
        // 受击击退速度自然衰减
        sp.vx *= 0.96;
      }
      // 重力
      if (!sp.onGround) sp.vy += CFG.GRAVITY * dt;
      // 积分
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      // 地面
      if (sp.y >= CFG.GROUND_Y) {
        sp.y = CFG.GROUND_Y; sp.vy = 0; sp.onGround = true;
        // 地面摩擦（非硬直时）
        if (!inHit) sp.vx *= 0.82;
        else sp.vx *= 0.94;
        if (Math.abs(sp.vx) < 1) sp.vx = 0;
      } else {
        sp.onGround = false;
      }
      // 墙壁边界
      var minX = 24, maxX = this.w - 24;
      if (sp.x < minX) { sp.x = minX; sp.vx = 0; }
      if (sp.x > maxX) { sp.x = maxX; sp.vx = 0; }
    }

    // 角色互推（防止重叠穿透，简易分离）
    var sep = 28; // 胶囊半径和
    var dxSep = this.s2.x - this.s1.x;
    if (Math.abs(dxSep) < sep) {
      var push = (sep - Math.abs(dxSep)) * 0.5 + 0.6;
      if (dxSep >= 0) { this.s1.x -= push; this.s2.x += push; }
      else { this.s1.x += push; this.s2.x -= push; }
      // 速度对消一点
      this.s1.vx *= 0.9; this.s2.vx *= 0.9;
    }

    // 面向更新
    this.updateFacing();

    // ---- 波动拳移动 + 碰撞（参数顺序无关矩形相交） ----
    var allHadou = [];
    this.p1Hadoukens.getChildren().forEach(function(b){ if(b.active) allHadou.push(b); });
    this.p2Hadoukens.getChildren().forEach(function(b){ if(b.active) allHadou.push(b); });
    for (var hi=0; hi<allHadou.length; hi++) {
      var hb = allHadou[hi];
      // 越界回收（池化，不 destroy）
      if (hb.x < -40 || hb.x > this.w + 40) {
        hb.setActive(false).setVisible(false); try{hb.body.enable=false;}catch(e){} hb.setVelocity(0,0); continue;
      }
      // 命中对手（胶囊矩形相交，含蹲姿高度）
      var owner = hb.owner, victim = (owner===1)? this.s2: this.s1;
      var vOwner = (owner===1)?2:1;
      if (victim.isKnocked || time < victim.invUntil) continue;
      // 波动 hitbox：以 hb 为中心 22x14
      var hbx = hb.x - 11, hby = hb.y - 7, hbw = 22, hbh = 14;
      var vw = victim.crouching ? 32 : 30, vh = victim.crouching ? 48 : 68;
      var vx0 = victim.x - vw/2, vy0 = (victim.crouching ? victim.y - vh : victim.y - vh + 4);
      var hitHadou = __omp_shell("(hbx + hbw < vx0 || vx0 + vw < hbx || hby + hbh < vy0 || vy0 + vh < hby);")
      if (hitHadou) {
        // 波动对碰消除：若与对方波动相交则双方回收（乒乓消除）
        var otherGrp = (owner===1)? this.p2Hadoukens : this.p1Hadoukens;
        var clashed = false;
        var others = otherGrp.getChildren();
        for (var oi=0; oi<others.length; oi++) {
          var ob = others[oi]; if (!ob.active) continue;
          var oxx = ob.x - 11, oyy = ob.y - 7;
          if (!(hbx + hbw < oxx || oxx + 22 < hbx || hby + hbh < oyy || oyy + 14 < hby)) {
            // 对消
            hb.setActive(false).setVisible(false); try{hb.body.enable=false;}catch(e){} hb.setVelocity(0,0);
            ob.setActive(false).setVisible(false); try{ob.body.enable=false;}catch(e2){} ob.setVelocity(0,0);
            this.spawnHitNum((hb.x+ob.x)/2, (hb.y+ob.y)/2 - 10, 'CLASH', '#fff59d');
            Sfx.play('block');
            clashed = true; break;
          }
        }
        if (clashed) continue;
        // 命中人：判定防御
        var vIsBlock = __omp_shell("!victim.blocking;")
        if (vIsBlock) {
          victim.hp -= Math.max(1, Math.round(hb.dmg * 0.22));
          victim.blockstun = 220;
          victim.vx = (owner===1?1:-1) * 70;
          Sfx.play('block');
          this.spawnHitNum(victim.x, victim.y - 56, 'BLOCK', '#90caf9');
          var atkM = (owner===1)?this.s1:this.s2;
          atkM.meter = Math.min(100, atkM.meter + 2);
        } else {
          victim.hp -= hb.dmg;
          victim.hitstun = 380;
          victim.vx = (owner===1?1:-1) * 110;
          victim.vy = -60;
          Sfx.play('hit');
          this.hitStopUntil = time + 70;
          if (vOwner===1) this.flashUntilP1=time+90; else this.flashUntilP2=time+90;
          this.spawnHitNum(victim.x, victim.y - 60, '-' + hb.dmg, hb.boosted ? '#ffca28' : '#ff8a80');
          var atkM2 = (owner===1)?this.s1:this.s2;
          atkM2.meter = Math.min(100, atkM2.meter + 5);
          victim.meter = Math.min(100, victim.meter + 3);
        }
        if (victim.hp < 0) victim.hp = 0;
        // 回收波动
        hb.setActive(false).setVisible(false); try{hb.body.enable=false;}catch(e){} hb.setVelocity(0,0);
        if (victim.hp <= 0 && !this.roundOver) this.onKO(vOwner);
      }
    }

    // ---- 近战命中（仅 active 帧，且双方未倒地） ----
    for (var atkOwner2=1; atkOwner2<=2; atkOwner2++) {
      var aSS = (atkOwner2===1)?this.s1:this.s2;
      if (!aSS.attacking || !aSS.atkKey || aSS.atkPhase!==1) continue;
      var hitAny = this.tryHit(atkOwner2, aSS.atkKey);
      if (hitAny) {
        // 同帧只命中一次，命中后该 active 仍保留但外层 tryHit 会因已进入 blockstun/hitstun 自然不再判定
        // 为避免同帧多次，命中后将 active 剩余裁半
        if (aSS.atkTimer > 40) aSS.atkTimer = 40;
        // 检查 KO
        var dOwn = (atkOwner2===1)?2:1;
        var dS2 = (dOwn===1)?this.s1:this.s2;
        if (dS2.hp <= 0 && !this.roundOver) this.onKO(dOwn);
      }
    }

    // KO 检测（波动/连续命中后也可能刚好归零，但未走 tryHit 分支）
    if (!this.roundOver) {
      if (this.s1.hp <= 0) this.onKO(1);
      else if (this.s2.hp <= 0) this.onKO(2);
    }

    this.syncSprites();
    this.updateHud();
    this.drawHitDebug();
  };


  FightScene.prototype.syncSprites = function () {
    if (!this.p1 || !this.p2 || !this.s1 || !this.s2) return;
    try { this.p1.body.reset(this.s1.x, this.s1.y); } catch(e) { this.p1.x=this.s1.x; this.p1.y=this.s1.y; }
    try { this.p2.body.reset(this.s2.x, this.s2.y); } catch(e2) { this.p2.x=this.s2.x; this.p2.y=this.s2.y; }
    // 蹲姿压扁视觉
    this.p1.setScale(1, this.s1.crouching ? 0.72 : 1);
    this.p2.setScale(1, this.s2.crouching ? 0.72 : 1);
    // 受击/防御色
    var now = this.time ? this.time.now : 0;
    // P1 tint
    if (now < this.flashUntilP1) this.p1.setTint(0xffffff);
    else if (this.s1.hitstun > 0) this.p1.setTint(0xff8a80);
    else if (this.s1.blockstun > 0) this.p1.setTint(0x90caf9);
    else if (this.s1.isKnocked) this.p1.setTint(0x78909c);
    else if (this.s1.superFlash > 0) this.p1.setTint(0xffff00);
    else this.p1.clearTint();
    if (now < this.flashUntilP2) this.p2.setTint(0xffffff);
    else if (this.s2.hitstun > 0) this.p2.setTint(0xff8a80);
    else if (this.s2.blockstun > 0) this.p2.setTint(0x90caf9);
    else if (this.s2.isKnocked) this.p2.setTint(0x78909c);
    else if (this.s2.superFlash > 0) this.p2.setTint(0xffff00);
    else this.p2.clearTint();
    // 攻击前伸微位移（仅视觉，不改逻辑 x）
    // 由 tryHit 的 range 已体现，此处不额外偏移
  };

  FightScene.prototype.drawHitDebug = function () {
    if (!this.hitDebugP1 || !this.hitDebugP2) return;
    this.hitDebugP1.clear(); this.hitDebugP2.clear();
    if (!this.showHitbox) return;
    // hurtbox（绿）
    for (var pi=1; pi<=2; pi++) {
      var s = (pi===1)?this.s1:this.s2;
      var g = (pi===1)?this.hitDebugP1:this.hitDebugP2;
      var hw = s.crouching ? 32 : 30, hh = s.crouching ? 48 : 68;
      var hx = s.x - hw/2, hy = (s.crouching ? s.y - hh : s.y - hh + 4);
      g.lineStyle(1, 0x66bb6a, 0.9); g.strokeRect(hx, hy, hw, hh);
      g.fillStyle(0x66bb6a, 0.12); g.fillRect(hx, hy, hw, hh);
      // 攻击 hitbox（红）仅 active 帧
      if (s.attacking && s.atkPhase===1 && s.atkKey) {
        var atk = ATK[s.atkKey];
        if (atk) {
          var range = atk.range, height = atk.height, yOff = atk.yOff;
          var ax, ay;
          if (s.atkKey==='shoryu') { ax = s.x + s.facing*10 - range/2; ay = s.y - 40 - height/2; }
          else { ax = s.x + s.facing*(range/2+10) - range/2; ay = (s.crouching ? s.y - 18 : s.y + yOff) - height/2; }
          g.lineStyle(2, 0xef5350, 1); g.strokeRect(ax, ay, range, height);
          g.fillStyle(0xef5350, 0.18); g.fillRect(ax, ay, range, height);
        }
      }
      // 波动 hitbox（青）
      var grp = (pi===1)?this.p1Hadoukens:this.p2Hadoukens;
      grp.getChildren().forEach(function(b){
        if (!b.active) return;
        g.lineStyle(1, 0x4fc3f7, 0.9); g.strokeRect(b.x-11, b.y-7, 22, 14);
      });
    }
  };

  FightScene.prototype.updateHud = function () {
    if (!this.hpBarP1) return;
    var r1 = this.s1 ? (this.s1.hp / CFG.MAX_HP) : 1;
    var r2 = this.s2 ? (this.s2.hp / CFG.MAX_HP) : 1;
    if (r1<0) r1=0; if (r1>1) r1=1;
    if (r2<0) r2=0; if (r2>1) r2=1;
    this.hpBarP1.setDisplaySize(320 * r1, 18);
    this.hpBarP2.setDisplaySize(320 * r2, 18);
    // 血量低变红，黄，绿
    this.hpBarP1.setTint(r1 < 0.3 ? 0xef5350 : (r1 < 0.6 ? 0xffca28 : 0x4caf50));
    this.hpBarP2.setTint(r2 < 0.3 ? 0xef5350 : (r2 < 0.6 ? 0xffca28 : 0x4caf50));
    // 镜像 P2 血条从右向左缩：用 displaySize 仍左对齐，故重设 x 使右对齐视觉
    try { this.hpBarP2.x = (this.w - 12 - 320) + 320 * (1 - r2); } catch(e){}
    // 文字
    if (this.hpTextP1) this.hpTextP1.setText('P1 ' + (this.s1?this.s1.hp:0) + '/' + CFG.MAX_HP + (this.s1 && this.s1.meter>=100?'  MAX':'')) ;
    if (this.hpTextP2) this.hpTextP2.setText('P2 ' + (this.s2?this.s2.hp:0) + '/' + CFG.MAX_HP + (this.s2 && this.s2.meter>=100?'  MAX':''));
    // 能量条
    var m1 = this.s1 ? (this.s1.meter/100) : 0;
    var m2 = this.s2 ? (this.s2.meter/100) : 0;
    if (this.meterBarP1) this.meterBarP1.setDisplaySize(180 * m1, 7);
    if (this.meterBarP2) { this.meterBarP2.setDisplaySize(180 * m2, 7); try{ this.meterBarP2.x = (this.w - 12 - 180) + 180*(1-m2); }catch(e){} }
    if (this.roundText) this.roundText.setText('ROUND ' + this.round + '  ' + (this.mode===1?'P1 vs AI':'P1 vs P2'));
    if (this.winsText) this.winsText.setText('P1 ' + this.p1wins + ' - ' + this.p2wins + ' P2   |  ' + this.stageInfo.name + '  ' + (this.showHitbox?'[Hitbox ON]':''));
    if (this.stageLabel) this.stageLabel.setText(this.stageInfo.name + '  ROUND ' + this.round + '  ' + (this.over?'— FINISH':'— FIGHT'));
  };

  // ---------------------------------------------------------------------------
  // 注册 — 同 Phaser v4.2.1 侧 host 注入，同步注册
  // ---------------------------------------------------------------------------
  function launch(host) {
    hostRef = host;
    var W = host.width || CFG.W;
    var H = host.height || CFG.H;
    if (host.loadState) {
      try {
        host.loadState().then(function(d){
          if (d) {
            if (typeof d.wins==='number') saveData.wins=d.wins|0;
            if (typeof d.unlockedStage==='number') saveData.unlockedStage=d.unlockedStage|0;
          }
        }, function(){});
      } catch(e){}
    }
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.container,
      width: W, height: H,
      backgroundColor: STAGES[saveData.unlockedStage] ? STAGES[saveData.unlockedStage].bg : '#0f1117',
      physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
scene: [BootScene, MenuScene, FightScene]
    });
    sceneRef = null;
    // 延迟绑定 sceneRef 便于 getState 指向 FightScene
    var tryBind = function(){
      try {
        var s = game.scene.getScene('fight');
        if (s) sceneRef = s;
        else {
          var m = game.scene.getScene('menu');
          if (m) sceneRef = m;
        }
      } catch(e){}
    };
    setTimeout(tryBind, 450);
    try { game.events.on('ready', tryBind); } catch(e){}
    window.__trgame = {
      game: game,
      getState: getState,
      getScene: function(){ return sceneRef; },
      getSave: function(){ return { wins: saveData.wins, unlockedStage: saveData.unlockedStage }; }
    };
    return game;
  }

  if (typeof window.TRGames !== 'undefined' && typeof window.TRGames.register === 'function') {
    window.TRGames.register({ id: 'fighter-sf', title: 'Fighter SF', launch: launch });
  }
})();
