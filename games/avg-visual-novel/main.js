// =============================================================================
// 【资产替换清单】avg-visual-novel / Echoes of the Signal v0.1.0
// =============================================================================
// 视觉占位（全部程序化生成，零外部图片）：
//   - 背景：this.add.graphics() 填充渐变色块 + 简单几何景物（见 makeBgTextures）
//     将来替换：把对应色块换成 this.load.image('bg_lab', 'bg_lab.png')
//               并在 Scene.create 用 this.add.image(W/2,H/2,'bg_lab') 替代色块
//   - 角色：capsule/圆角矩形 + 换色表情绪（neutral/happy/sad/angry/surprised）
//     将来替换：this.load.image('char_aoi_happy','aoi_happy.png')
//               或 this.load.spritesheet 配合立绘差分
//   - CG/特效：纯 graphics 粒子与遮罩
//     将来替换：this.load.image('cg_ending_a','cg_a.png')
// 音频占位（WebAudio 双振荡和弦垫 + oscillator 滴答）：
//   - 将来替换：this.load.audio('bgm_ch1','bgm_ch1.ogg')
//               this.load.audio('se_tick','tick.ogg')
//               并用 this.sound.add/play 替代 Sfx
// 续写剧本说明：
//   - 顶部 SCRIPT 数组即剧本数据源，引擎与数据分离
//   - 新增章节：在 SCRIPT 推入 {id:'CH3', title:'...', nodes:[...]}
//   - 新增分支：在 node.choices 推入 {text, next, setFlag?, requireFlag?}
//   - 新增结局：在任意节点用 {type:'ending', id:'C', title:'...'} 触发
//   - 文本内 {flag:xxx} 可做条件行（engine 已支持 requireFlag）
//   - 翻译/配音：替换 say 的 text / voice 字段即可，无需改引擎
// =============================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 可调参数（带单位）
  // ---------------------------------------------------------------------------
  var W = 960; // 舞台宽 px
  var H = 540; // 舞台高 px
  var DIALOG_H = 150; // 对话框高 px
  var TYPEWRITER_MS = 28; // 逐字间隔 ms/字
  var AUTO_SKIP_HOLD_MS = 120; // 快进按住阈值 ms
  var FADE_MS = 350; // 场景淡入淡出 ms
  var CHAR_W = 148; // 角色立绘宽 px
  var CHAR_H = 320; // 角色立绘高 px
  var BGM_VOL = 0.18; // BGM 音量 0-1

  // ---------------------------------------------------------------------------
  // 剧本数据：引擎与数据分离，两章，每章≥1 选项分支，分支影响结局（≥2结局）
  // 节点类型：
  //   say: {ch, name, emotion, text, bg}  对话行
  //   choice: {choices:[{text,next,setFlag,addEnding?}]} 分支
  //   jump: {next}            无条件跳转
  //   set: {flag, value}      设flag后继续下一节点
  //   ending: {id,title,text} 结局
  // 索引：SCRIPT[chapterIndex].nodes[nodeIndex]
  // next 可为 "CH1:3" 或 "END_A"（ending id）或同一章内数字索引
  // ---------------------------------------------------------------------------
  var SCRIPT = [
    {
      id: 'CH1',
      title: 'Chapter 1 — The Static Call',
      bg: 'bg_lab',
      nodes: [
        // 0
        { type: 'say', ch: 'aoi', name: 'Aoi', emotion: 'neutral', text: 'You came. The signal has been repeating for 72 hours.', bg: 'bg_lab' },
        { type: 'say', ch: 'aoi', name: 'Aoi', emotion: 'sad', text: 'It carries a voice... it sounds like my sister, but she vanished last winter.', bg: 'bg_lab' },
        { type: 'say', ch: 'you', name: 'You', emotion: 'neutral', text: 'We should verify the source before we answer. Where is it transmitting from?', bg: 'bg_lab' },
        { type: 'say', ch: 'aoi', name: 'Aoi', emotion: 'surprised', text: 'The old relay tower, beyond the frozen lake. No one goes there now.', bg: 'bg_lab' },
        // 4 — 分支1：影响 CH2 可见选项与结局
        { type: 'choice', prompt: 'How do you respond?', choices: [
          { text: 'We go together, now. (Trust)', next: 5, setFlag: 'ch1_trust' },
          { text: 'I will scout alone first. (Caution)', next: 6, setFlag: 'ch1_caution' }
        ]},
        // 5 trust line
        { type: 'say', ch: 'aoi', name: 'Aoi', emotion: 'happy', text: 'Thank you... I was afraid to go alone.', bg: 'bg_lab', setFlag: 'trust_aoi' },
        { type: 'jump', next: 7 },
        // 6 caution line
        { type: 'say', ch: 'aoi', name: 'Aoi', emotion: 'sad', text: 'I understand. But promise you will come back for me.', bg: 'bg_lab', setFlag: 'caution_flag' },
        // 7 converge
        { type: 'say', ch: 'you', name: 'You', emotion: 'neutral', text: 'The snow is getting heavier. We should move before night seals the road.', bg: 'bg_snow' },
        { type: 'say', ch: 'mira', name: 'Mira', emotion: 'angry', text: 'Stop. That tower is quarantined. The signal is not a rescue — it is a lure.', bg: 'bg_snow' },
        { type: 'say', ch: 'mira', name: 'Mira', emotion: 'neutral', text: 'If you answer it, something answers back. Choose carefully.', bg: 'bg_snow' },
        // 10 章末自动进 CH2
        { type: 'jump', next: 'CH2:0' }
      ]
    },
    {
      id: 'CH2',
      title: 'Chapter 2 — The Tower',
      bg: 'bg_tower',
      nodes: [
        // 0
        { type: 'say', ch: 'aoi', name: 'Aoi', emotion: 'neutral', text: 'The door is open... the signal is louder inside.', bg: 'bg_tower' },
        { type: 'say', ch: 'you', name: 'You', emotion: 'neutral', text: 'Stay close. I see two consoles — one to reply, one to cut the power.', bg: 'bg_tower' },
        // 2 — 分支2：不同跳转影响结局；trust 路线额外选项
        { type: 'choice', prompt: 'What do you do?', choices: [
          { text: 'Reply to the signal', next: 3 },
          { text: 'Cut the power', next: 6 },
          { text: 'Let Aoi decide (requires Trust)', next: 9, requireFlag: 'trust_aoi' }
        ]},
        // 3 reply path
        { type: 'say', ch: 'aoi', name: 'Aoi', emotion: 'surprised', text: 'You answered... listen, it is her voice!', bg: 'bg_tower' },
        { type: 'say', ch: 'mira', name: 'Mira', emotion: 'sad', text: 'It mimics what you love most. You have bound yourself to it.', bg: 'bg_tower' },
        { type: 'ending', id: 'A', title: 'Ending A — Echo', text: 'You followed the voice home. In spring, hikers find the tower silent — and two new signals calling from the lake. (Reply Ending)' },
        // 6 cut path
        { type: 'say', ch: 'aoi', name: 'Aoi', emotion: 'sad', text: 'The light... it is dying. Was that really... not her?', bg: 'bg_tower' },
        { type: 'say', ch: 'you', name: 'You', emotion: 'neutral', text: 'We will search for the truth elsewhere — together, in daylight.', bg: 'bg_snow' },
        { type: 'ending', id: 'B', title: 'Ending B — Silence', text: 'The tower goes dark. The snow buries the antenna. Years later, Aoi still watches the horizon — but no voice returns. (Silence Ending)' },
        // 9 trust-only path -> leads to hidden third ending variant (counts as A family but distinct id for backlog)
        { type: 'say', ch: 'aoi', name: 'Aoi', emotion: 'happy', text: 'Then... I want to believe, but not be deceived. We record it and leave.', bg: 'bg_tower' },
        { type: 'say', ch: 'mira', name: 'Mira', emotion: 'happy', text: 'Wise. You kept both hope and caution. That is the rarest answer.', bg: 'bg_tower' },
        { type: 'ending', id: 'C', title: 'Ending C — Record', text: 'You leave with a recording. Back in town, analysis reveals a hidden coordinate — a place no map marks. The story continues... (Secret Ending)' }
      ]
    }
  ];

  // 角色情绪配色表（将来换立绘差分：此映射改为纹理 key 表）
  var EMOTION_COLOR = {
    neutral: 0x7eb8da,
    happy: 0xffc07a,
    sad: 0x8da0c8,
    angry: 0xe07a5f,
    surprised: 0xb8e0a0
  };
  var CHAR_COLOR = {
    aoi: { base: 0x6aa6d6, accent: 0xffffff },
    you: { base: 0x9a8c98, accent: 0xc9ada7 },
    mira: { base: 0xc17c74, accent: 0xf2cc8f }
  };

  // ---------------------------------------------------------------------------
  // 存档结构 {chapter, scriptIndex, flags, unlockedEndings[]}
  // ---------------------------------------------------------------------------
  var hostRef = null;
  var gameRef = null;
  var saveData = { chapter: 0, scriptIndex: 0, flags: {}, unlockedEndings: [] };
  var runtimeFlags = {}; // 本次游玩累积 flag
  var unlockedEndings = []; // 本次解锁结局
  var backlog = []; // {name,text} 历史

  // ---------------------------------------------------------------------------
  // 音频占位：WebAudio oscillator+gain，首输入 resume，try/catch 静默降级
  // 将来换 this.load.audio：Sfx.play -> this.sound.play(key)
  // ---------------------------------------------------------------------------
  var Sfx = {
    ctx: null,
    bgmTimer: null,
    ensure: function () {
      if (Sfx.ctx) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        Sfx.ctx = new AC();
      } catch (e) {}
    },
    resume: function () {
      try { if (Sfx.ctx && Sfx.ctx.state === 'suspended') Sfx.ctx.resume(); } catch (e) {}
    },
    tone: function (freq, dur, type, vol) {
      try {
        Sfx.ensure(); Sfx.resume();
        if (!Sfx.ctx) return;
        var o = Sfx.ctx.createOscillator();
        var g = Sfx.ctx.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        g.gain.value = vol != null ? vol : 0.12;
        o.connect(g); g.connect(Sfx.ctx.destination);
        var now = Sfx.ctx.currentTime;
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + dur);
        o.start(now); o.stop(now + dur);
      } catch (e) {}
    },
    play: function (kind) {
      // 文字滴答/选择/章节切换/BGM双振荡和弦垫
      if (kind === 'tick') { Sfx.tone(1800, 0.06, 'square', 0.06); }
      else if (kind === 'choice') { Sfx.tone(880, 0.12, 'sine', 0.14); setTimeout(function(){ Sfx.tone(1320,0.14,'sine',0.12); }, 90); }
      else if (kind === 'chapter') { Sfx.tone(440,0.5,'sine',0.13); Sfx.tone(554,0.5,'sine',0.10); }
      else if (kind === 'ending') { Sfx.tone(330,0.6,'triangle',0.14); Sfx.tone(415,0.6,'triangle',0.10); }
      else if (kind === 'hit') { Sfx.tone(220,0.18,'sawtooth',0.10); }
    },
    startBgm: function () {
      try {
        Sfx.ensure(); Sfx.resume();
        if (!Sfx.ctx) return;
        clearInterval(Sfx.bgmTimer);
        // 双振荡和弦垫：每 4s 换根音，持续轻量 pad
        var roots = [110, 123, 146, 110];
        var idx = 0;
        Sfx.bgmTimer = setInterval(function () {
          var r = roots[idx % roots.length]; idx++;
          // 将来替换：this.sound.play('bgm_ch1', {loop:true, volume:BGM_VOL})
          Sfx.tone(r, 3.5, 'sine', BGM_VOL * 0.35);
          setTimeout(function(){ Sfx.tone(r*1.5, 3.2, 'triangle', BGM_VOL*0.22); }, 200);
          setTimeout(function(){ Sfx.tone(r*2, 2.8, 'sine', BGM_VOL*0.15); }, 400);
        }, 4200);
        // 立即一次
        Sfx.tone(roots[0], 3.0, 'sine', BGM_VOL*0.35);
      } catch (e) {}
    },
    stopBgm: function () { try { clearInterval(Sfx.bgmTimer); Sfx.bgmTimer=null; } catch(e){} }
  };

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function chapterIndexById(id) {
    for (var i = 0; i < SCRIPT.length; i++) if (SCRIPT[i].id === id) return i;
    return 0;
  }

  function persist() {
    if (!hostRef) return;
    try {
      var payload = { chapter: saveData.chapter, scriptIndex: saveData.scriptIndex, flags: clone(runtimeFlags), unlockedEndings: unlockedEndings.slice() };
      hostRef.saveState(payload).then(function(){}, function(){});
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Phaser Scenes
  // ---------------------------------------------------------------------------

  // 生成占位纹理与背景（零外部图片；注释标将来换 this.load.image）
  function makeBgTextures(scene) {
    // 将来替换：scene.load.image('bg_lab','bg_lab.png') 放在 preload
    // 这里用 graphics.generateTexture 程序化生成
    var g;

    // bg_lab：冷色实验室渐变 + 几何窗框
    g = scene.add.graphics();
    g.fillGradientStyle(0x1d3557, 0x1d3557, 0x457b9d, 0x457b9d, 1);
    g.fillRect(0, 0, W, H);
    g.fillStyle(0xa8dadc, 0.18); g.fillRect(40, 30, W-80, 80);
    g.fillStyle(0xf1faee, 0.12); g.fillRect(60, 50, 120, 40); g.fillRect(220, 50, 120, 40); g.fillRect(380, 50, 120, 40);
    g.lineStyle(2, 0xffffff, 0.18); g.strokeRect(40, 30, W-80, 80);
    g.generateTexture('bg_lab', W, H); g.destroy();

    // bg_snow：雪原夜色 + 远山三角形
    g = scene.add.graphics();
    g.fillGradientStyle(0x0b132b, 0x0b132b, 0x3a506b, 0x3a506b, 1);
    g.fillRect(0, 0, W, H);
    g.fillStyle(0xffffff, 0.85); g.fillTriangle(W*0.15, H*0.55, W*0.28, H*0.22, W*0.41, H*0.55);
    g.fillStyle(0xe0e8ef, 0.9); g.fillTriangle(W*0.45, H*0.58, W*0.62, H*0.18, W*0.79, H*0.58);
    g.fillStyle(0xffffff, 1); g.fillRect(0, H*0.62, W, H*0.38);
    // 雪粒
    g.fillStyle(0xffffff, 0.7);
    for (var i = 0; i < 30; i++) g.fillCircle((i*97)%W, 40 + (i*53)%(H*0.5), 1.2);
    g.generateTexture('bg_snow', W, H); g.destroy();

    // bg_tower：塔内暖色顶光 + 几何控制台
    g = scene.add.graphics();
    g.fillGradientStyle(0x1c1c2b, 0x1c1c2b, 0x3d2b3d, 0x3d2b3d, 1);
    g.fillRect(0, 0, W, H);
    g.fillStyle(0xffb86a, 0.18); g.fillRect(W*0.25, 0, W*0.5, 120);
    g.fillStyle(0x2b2d42, 1); g.fillRect(W*0.18, H*0.52, 220, 90); g.fillRect(W*0.60, H*0.52, 220, 90);
    g.fillStyle(0x8d99ae, 1); g.fillCircle(W*0.28, H*0.60, 18); g.fillCircle(W*0.70, H*0.60, 18);
    g.fillStyle(0x2ec4b6, 0.9); g.fillRect(W*0.22, H*0.56, 40, 14); g.fillRect(W*0.64, H*0.56, 40, 14);
    g.generateTexture('bg_tower', W, H); g.destroy();

    // 角色占位：capsule/圆角矩形，将来换 this.load.image('char_aoi_neutral', ...)
    ['aoi','you','mira'].forEach(function (ch) {
      ['neutral','happy','sad','angry','surprised'].forEach(function (emo) {
        var key = 'char_' + ch + '_' + emo;
        var col = EMOTION_COLOR[emo] || 0x7eb8da;
        var base = (CHAR_COLOR[ch]||CHAR_COLOR.aoi).base;
        // 混合情绪色与角色基色（简易平均）
        var mixed = col; // 占位简化：直接用情绪色，注释说明将来换立绘差分
        var gg = scene.add.graphics();
        gg.fillStyle(mixed, 1);
        // capsule 身体
        gg.fillRoundedRect(0, 0, CHAR_W, CHAR_H, 28);
        // 头
        gg.fillStyle(0xfff6e8, 1); gg.fillCircle(CHAR_W/2, 62, 44);
        // 表情简笔
        gg.fillStyle(0x333333, 1);
        if (emo === 'happy') { gg.fillCircle(CHAR_W/2-14, 62, 4); gg.fillCircle(CHAR_W/2+14, 62, 4); }
        else if (emo === 'sad') { gg.fillCircle(CHAR_W/2-14, 66, 3); gg.fillCircle(CHAR_W/2+14, 66, 3); }
        else if (emo === 'angry') { gg.fillRect(CHAR_W/2-18, 54, 12, 3); gg.fillRect(CHAR_W/2+6, 54, 12, 3); gg.fillCircle(CHAR_W/2-10, 64, 3); gg.fillCircle(CHAR_W/2+10, 64, 3); }
        else { gg.fillCircle(CHAR_W/2-12, 62, 3.5); gg.fillCircle(CHAR_W/2+12, 62, 3.5); }
        // 衣领 accent
        gg.fillStyle((CHAR_COLOR[ch]||CHAR_COLOR.aoi).accent, 1); gg.fillTriangle(CHAR_W/2-18, 110, CHAR_W/2+18, 110, CHAR_W/2, 132);
        gg.generateTexture(key, CHAR_W, CHAR_H); gg.destroy();
      });
    });
  }

  // 标题场景
  function TitleScene() { Phaser.Scene.call(this, { key: 'Title' }); }
  TitleScene.prototype = Object.create(Phaser.Scene.prototype);
  TitleScene.prototype.constructor = TitleScene;
  TitleScene.prototype.create = function () {
    makeBgTextures(this);
    this.cameras.main.setBackgroundColor('#0b132b');
    this.add.image(W/2, H/2, 'bg_lab').setAlpha(0.55);
    // 标题卡
    this.add.text(W/2, 148, 'ECHOES  OF  THE  SIGNAL', { fontFamily:'Georgia, serif', fontSize:'28px', color:'#f1faee', stroke:'#1d3557', strokeThickness:4 }).setOrigin(0.5);
    this.add.text(W/2, 188, 'A  Visual  Novel  —  Two Chapters  /  Choices Matter', { fontFamily:'Arial', fontSize:'12px', color:'#a8dadc' }).setOrigin(0.5);
    this.add.text(W/2, 214, 'Press Start  |  B: Backlog in game  |  Click / Space to advance', { fontFamily:'Arial', fontSize:'11px', color:'#e0e8ef' }).setOrigin(0.5);

    var hasSave = !!(saveData && saveData.unlockedEndings && saveData.unlockedEndings.length >=0 && (saveData.chapter!==0 || saveData.scriptIndex!==0 || (saveData.flags && Object.keys(saveData.flags).length>0)));
    // 按钮
    var btns = [];
    function mkBtn(y, label, enabled, cb) {
      var bg = this.add.rectangle(W/2, y, 260, 38, enabled ? 0xf1faee : 0x3a506b, enabled ? 1 : 0.5).setOrigin(0.5);
      var tx = this.add.text(W/2, y, label, { fontFamily:'Arial', fontSize:'14px', color: enabled ? '#1d3557' : '#8da0c8', fontStyle:'bold' }).setOrigin(0.5);
      if (enabled) { bg.setInteractive({useHandCursor:true}); bg.on('pointerdown', function(){ Sfx.resume(); Sfx.play('choice'); cb(); }); bg.on('pointerover', function(){ bg.setFillStyle(0xffb86a,1); }); bg.on('pointerout', function(){ bg.setFillStyle(0xf1faee,1); }); }
      btns.push(bg);
    }
    mkBtn.call(this, 276, 'Start from Beginning', true, function(){ runtimeFlags={}; backlog=[]; this.scene.start('ChapterCard', { chapter:0, index:0 }); }.bind(this));
    mkBtn.call(this, 324, 'Continue', hasSave, function(){ this.scene.start('ChapterCard', { chapter: saveData.chapter, index: saveData.scriptIndex }); }.bind(this));
    mkBtn.call(this, 372, 'Chapter Select', true, function(){ this.scene.start('ChapterSelect'); }.bind(this));
    // 结局收集提示
    var endings = (saveData.unlockedEndings||[]).join('  ') || '— none yet —';
    this.add.text(W/2, 430, 'Endings unlocked: ' + endings + '   (' + (saveData.unlockedEndings||[]).length + '/3)', { fontFamily:'Arial', fontSize:'11px', color:'#a8dadc' }).setOrigin(0.5);
    this.add.text(W/2, 450, 'Tip: Your choices in CH1 affect options in CH2.', { fontFamily:'Arial', fontSize:'11px', color:'#8da0c8' }).setOrigin(0.5);
    // 键盘 Start
    this.input.keyboard.once('keydown-SPACE', function(){ runtimeFlags={}; backlog=[]; this.scene.start('ChapterCard',{chapter:0,index:0}); }, this);
    this.input.keyboard.once('keydown-ENTER', function(){ runtimeFlags={}; backlog=[]; this.scene.start('ChapterCard',{chapter:0,index:0}); }, this);
  };

  // 章节选择
  function ChapterSelectScene() { Phaser.Scene.call(this, { key: 'ChapterSelect' }); }
  ChapterSelectScene.prototype = Object.create(Phaser.Scene.prototype);
  ChapterSelectScene.prototype.constructor = ChapterSelectScene;
  ChapterSelectScene.prototype.create = function () {
    this.cameras.main.setBackgroundColor('#0b132b');
    this.add.image(W/2, H/2, 'bg_snow').setAlpha(0.35);
    this.add.text(W/2, 70, 'CHAPTER SELECT', { fontFamily:'Georgia, serif', fontSize:'22px', color:'#f1faee' }).setOrigin(0.5);
    this.add.text(W/2, 98, 'Only visited chapters are selectable', { fontFamily:'Arial', fontSize:'11px', color:'#a8dadc' }).setOrigin(0.5);
    // 解锁判定：CH1 始终可进；CH2 需曾到达过（flags 或 chapter>=1 或有结局）
    var reachedCh2 = (saveData.chapter >= 1) || (saveData.flags && (saveData.flags.trust_aoi || saveData.flags.caution_flag)) || (saveData.unlockedEndings && saveData.unlockedEndings.length>0);
    var items = [
      { label: 'Chapter 1 — The Static Call', ch: 0, enabled: true },
      { label: 'Chapter 2 — The Tower' + (reachedCh2 ? '' : '  (locked)'), ch: 1, enabled: reachedCh2 }
    ];
    var self=this;
    items.forEach(function (it, idx) {
      var y = 170 + idx*56;
      var bg = self.add.rectangle(W/2, y, 420, 40, it.enabled ? 0xf1faee : 0x3a506b, it.enabled ? 1 : 0.45).setOrigin(0.5);
      var tx = self.add.text(W/2, y, it.label, { fontFamily:'Arial', fontSize:'13px', color: it.enabled ? '#1d3557' : '#8da0c8' }).setOrigin(0.5);
      if (it.enabled) {
        bg.setInteractive({useHandCursor:true});
        bg.on('pointerdown', function(){ Sfx.play('choice'); self.scene.start('ChapterCard', { chapter: it.ch, index: 0 }); });
        bg.on('pointerover', function(){ bg.setFillStyle(0xffb86a,1); });
        bg.on('pointerout', function(){ bg.setFillStyle(0xf1faee,1); });
      }
    });
    var back = this.add.rectangle(W/2, 320, 180, 34, 0x1d3557, 1).setOrigin(0.5);
    this.add.text(W/2, 320, 'Back to Title', { fontFamily:'Arial', fontSize:'13px', color:'#f1faee' }).setOrigin(0.5);
    back.setInteractive({useHandCursor:true});
    back.on('pointerdown', function(){ self.scene.start('Title'); });
    this.input.keyboard.once('keydown-ESC', function(){ self.scene.start('Title'); }, this);
  };

  // 章标题卡过渡
  function ChapterCardScene() { Phaser.Scene.call(this, { key: 'ChapterCard' }); }
  ChapterCardScene.prototype = Object.create(Phaser.Scene.prototype);
  ChapterCardScene.prototype.constructor = ChapterCardScene;
  ChapterCardScene.prototype.init = function (data) { this.nextChapter = data.chapter||0; this.nextIndex = data.index||0; };
  ChapterCardScene.prototype.create = function () {
    var ch = SCRIPT[this.nextChapter];
    this.cameras.main.setBackgroundColor('#0b132b');
    Sfx.play('chapter');
    var t1 = this.add.text(W/2, H/2-18, ch ? ch.title : 'Chapter', { fontFamily:'Georgia, serif', fontSize:'20px', color:'#f1faee' }).setOrigin(0.5).setAlpha(0);
    var t2 = this.add.text(W/2, H/2+22, 'Click or press Space to begin', { fontFamily:'Arial', fontSize:'11px', color:'#a8dadc' }).setOrigin(0.5).setAlpha(0);
    this.tweens.add({ targets:t1, alpha:1, duration:FADE_MS, ease:'Power2' });
    this.tweens.add({ targets:t2, alpha:1, duration:FADE_MS, delay:FADE_MS, ease:'Power2' });
    var go = function(){
      // 合并存档 flags 到 runtime（Continue 时）
      if (this.nextChapter===saveData.chapter && this.nextIndex===saveData.scriptIndex) {
        runtimeFlags = clone(saveData.flags||{});
        unlockedEndings = (saveData.unlockedEndings||[]).slice();
      } else if (this.nextChapter===0 && this.nextIndex===0) {
        // Start from beginning keeps current unlockedEndings but resets flags progression
        // 保留已解锁结局数用于 ChapterSelect 显示
      }
      this.scene.start('Novel', { chapter:this.nextChapter, index:this.nextIndex });
    }.bind(this);
    this.time.delayedCall(900, function(){
      this.input.once('pointerdown', go, this);
      this.input.keyboard.once('keydown-SPACE', go, this);
      this.input.keyboard.once('keydown-ENTER', go, this);
    }, [], this);
  };

  // 主视觉小说场景
  function NovelScene() { Phaser.Scene.call(this, { key: 'Novel' }); }
  NovelScene.prototype = Object.create(Phaser.Scene.prototype);
  NovelScene.prototype.constructor = NovelScene;
  NovelScene.prototype.init = function (data) {
    this.curChapter = data.chapter || 0;
    this.curIndex = data.index || 0;
    this.isTyping = false;
    this.typeTimer = null;
    this.fullText = '';
    this.charIdx = 0;
    this.choiceActive = false;
    this.endingShown = false;
    this.backlogVisible = false;
  };
  NovelScene.prototype.create = function () {
    this.cameras.main.setBackgroundColor('#0b132b');
    // 背景
    this.bgImage = this.add.image(W/2, H/2, 'bg_lab').setDepth(0);
    // 角色层（对象池化：复用同一 sprite，换 texture）
    // 将来替换：this.charSprite.setTexture('aoi_happy')
    this.charSprite = this.add.image(W/2, H/2 - 10, 'char_aoi_neutral').setDepth(1).setScale(1).setAlpha(0);
    this.charNameBadge = this.add.text(24, H - DIALOG_H - 26, '', { fontFamily:'Arial', fontSize:'12px', color:'#1d3557', backgroundColor:'#f1faee', padding:{left:8,right:8,top:3,bottom:3} }).setDepth(4).setAlpha(0);
    // 对话框
    this.dialogBg = this.add.rectangle(W/2, H - DIALOG_H/2 - 12, W - 24, DIALOG_H, 0x0b132b, 0.86).setDepth(2).setStrokeStyle(1, 0xa8dadc, 0.9);
    this.dialogText = this.add.text(28, H - DIALOG_H + 8, '', { fontFamily:'Georgia, serif', fontSize:'15px', color:'#f1faee', wordWrap:{width: W-64}, lineSpacing:4 }).setDepth(3);
    this.continueHint = this.add.text(W - 32, H - 22, '▶', { fontFamily:'Arial', fontSize:'12px', color:'#a8dadc' }).setDepth(3).setAlpha(0);
    // 选项容器
    this.choiceGroup = this.add.group();
    // backlog 层
    this.backlogBg = this.add.rectangle(W/2, H/2, W-60, H-80, 0x0b132b, 0.92).setDepth(10).setStrokeStyle(1, 0xa8dadc, 0.6).setVisible(false);
    this.backlogTitle = this.add.text(W/2, 58, 'BACKLOG  —  Press B to close', { fontFamily:'Arial', fontSize:'12px', color:'#a8dadc' }).setDepth(11).setOrigin(0.5).setVisible(false);
    this.backlogText = this.add.text(48, 80, '', { fontFamily:'Arial', fontSize:'11px', color:'#e0e8ef', wordWrap:{width: W-96}, lineSpacing:3 }).setDepth(11).setVisible(false);
    this.backlogHint = this.add.text(W/2, H-36, 'Press B to return', { fontFamily:'Arial', fontSize:'11px', color:'#8da0c8' }).setDepth(11).setOrigin(0.5).setVisible(false);

    // 输入：点击/空格快进或推进；B 切换 backlog
    this.input.on('pointerdown', this.onAdvance, this);
    this.input.keyboard.on('keydown-SPACE', this.onAdvance, this);
    this.input.keyboard.on('keydown-ENTER', this.onAdvance, this);
    this.input.keyboard.on('keydown-B', this.toggleBacklog, this);

    Sfx.startBgm();
    this.showNode();
  };
  NovelScene.prototype.shutdown = function(){ if(this.typeTimer) this.typeTimer.remove(false); };
  NovelScene.prototype.onAdvance = function () {
    if (this.backlogVisible) return;
    if (this.endingShown) return;
    if (this.choiceActive) return;
    if (this.isTyping) {
      // 快进：立即显示全文
      if (this.typeTimer) { this.typeTimer.remove(false); this.typeTimer=null; }
      this.isTyping=false;
      this.dialogText.setText(this.fullText);
      this.continueHint.setAlpha(1);
      return;
    }
    // 推进到下一节点
    this.advanceIndex(1);
  };
  NovelScene.prototype.toggleBacklog = function () {
    this.backlogVisible = !this.backlogVisible;
    var v = this.backlogVisible;
    this.backlogBg.setVisible(v); this.backlogTitle.setVisible(v); this.backlogText.setVisible(v); this.backlogHint.setVisible(v);
    if (v) {
      var lines = backlog.slice(-28).map(function (e){ return e.name + ': ' + e.text; }).join('\n\n');
      if (!lines) lines = '(No dialogue yet)';
      this.backlogText.setText(lines);
    }
  };
  NovelScene.prototype.resolveJump = function (next) {
    // next: number | "CH2:3" | ending id handled by caller
    if (typeof next === 'number') return { chapter: this.curChapter, index: next };
    if (typeof next === 'string' && next.indexOf(':') !== -1) {
      var parts = next.split(':');
      return { chapter: chapterIndexById(parts[0]), index: parseInt(parts[1],10)||0 };
    }
    return null;
  };
  NovelScene.prototype.advanceIndex = function (step) {
    var ch = SCRIPT[this.curChapter];
    var nxt = this.curIndex + step;
    if (nxt >= ch.nodes.length) {
      // 章末无显式 jump 则尝试下一章
      if (this.curChapter + 1 < SCRIPT.length) { this.curChapter++; this.curIndex=0; this.showNode(); }
      else { this.showEnding('A','End','The story ends here.'); }
      return;
    }
    this.curIndex = nxt;
    this.saveProgress();
    this.showNode();
  };
  NovelScene.prototype.saveProgress = function () {
    saveData.chapter = this.curChapter;
    saveData.scriptIndex = this.curIndex;
    saveData.flags = clone(runtimeFlags);
    saveData.unlockedEndings = unlockedEndings.slice();
    persist();
  };
  NovelScene.prototype.showNode = function () {
    // 清理选项
    this.choiceGroup.clear(true, true);
    this.choiceActive = false;
    this.continueHint.setAlpha(0);
    if (this.typeTimer) { this.typeTimer.remove(false); this.typeTimer=null; }
    this.isTyping=false;

    var ch = SCRIPT[this.curChapter];
    if (!ch) return;
    // 背景切换（淡入）
    var bgKey = ch.bg;
    var node = ch.nodes[this.curIndex];
    if (node && node.bg) bgKey = node.bg;
    if (bgKey && this.bgImage.texture.key !== bgKey) {
      this.tweens.add({ targets:this.bgImage, alpha:0, duration:180, onComplete:function(){
        this.bgImage.setTexture(bgKey); this.tweens.add({ targets:this.bgImage, alpha:1, duration:180 });
      }, callbackScope:this });
    }

    if (!node) return;
    // set 节点
    if (node.type === 'set') {
      runtimeFlags[node.flag] = node.value != null ? node.value : true;
      this.saveProgress();
      this.advanceIndex(1);
      return;
    }
    if (node.type === 'jump') {
      var j = this.resolveJump(node.next);
      if (j) { this.curChapter=j.chapter; this.curIndex=j.index; this.saveProgress(); this.showNode(); }
      return;
    }
    if (node.type === 'ending') { this.showEnding(node.id, node.title, node.text); return; }
    if (node.type === 'choice') { this.showChoice(node); return; }
    if (node.type === 'say') {
      if (node.setFlag) { runtimeFlags[node.setFlag]=true; this.saveProgress(); }
      // 角色与名牌
      var texKey = 'char_' + node.ch + '_' + (node.emotion || 'neutral');
      // 对象池化：复用 charSprite，仅换纹理（零新建）
      if (this.textures.exists(texKey)) this.charSprite.setTexture(texKey);
      this.charSprite.setAlpha(1);
      this.charNameBadge.setText(node.name || '').setAlpha(1);
      // 对话历史
      backlog.push({ name: node.name || '', text: node.text });
      if (backlog.length > 120) backlog.shift();
      // 逐字打字机
      this.fullText = node.text;
      this.charIdx = 0;
      this.dialogText.setText('');
      this.isTyping = true;
      Sfx.resume();
      var self=this;
      this.typeTimer = this.time.addEvent({
        delay: TYPEWRITER_MS,
        loop: true,
        callback: function(){
          if (self.charIdx < self.fullText.length) {
            self.charIdx++;
            self.dialogText.setText(self.fullText.slice(0, self.charIdx));
            // 每 3 字一个滴答（文字滴答占位）
            // 将来替换：this.sound.play('se_tick')
            if (self.charIdx % 3 === 0) Sfx.play('tick');
          } else {
            if (self.typeTimer) { self.typeTimer.remove(false); self.typeTimer=null; }
            self.isTyping=false;
            self.continueHint.setAlpha(1);
          }
        }
      });
    }
  };
  NovelScene.prototype.showChoice = function (node) {
    this.choiceActive = true;
    this.dialogText.setText(node.prompt || 'Choose:');
    Sfx.play('choice');
    var choices = node.choices || [];
    // 过滤 requireFlag
    var visible = [];
    for (var i=0;i<choices.length;i++) {
      var c=choices[i];
      if (c.requireFlag && !runtimeFlags[c.requireFlag]) continue;
      visible.push(c);
    }
    var self=this;
    visible.forEach(function (c, idx) {
      var y = H - DIALOG_H/2 - 12 - (visible.length-1)*26 + idx*52;
      // 若选项过多则纵向偏移
      var yy = H - 56 - (visible.length-1-idx)*46;
      var bg = self.add.rectangle(W/2, yy, 520, 36, 0xf1faee, 1).setDepth(5).setStrokeStyle(1, 0x1d3557, 0.9);
      var tx = self.add.text(W/2, yy, c.text, { fontFamily:'Arial', fontSize:'13px', color:'#1d3557' }).setDepth(6).setOrigin(0.5);
      bg.setInteractive({useHandCursor:true});
      (function (choice){
        bg.on('pointerdown', function(){
          Sfx.play('choice');
          if (choice.setFlag) { runtimeFlags[choice.setFlag]=true; }
          // next 解析
          if (typeof choice.next === 'number') { self.curIndex = choice.next; self.saveProgress(); self.showNode(); }
          else if (typeof choice.next === 'string' && choice.next.indexOf(':')!==-1) {
            var j=self.resolveJump(choice.next); self.curChapter=j.chapter; self.curIndex=j.index; self.saveProgress(); self.showNode();
          } else { self.advanceIndex(1); }
        });
        bg.on('pointerover', function(){ bg.setFillStyle(0xffb86a,1); });
        bg.on('pointerout', function(){ bg.setFillStyle(0xf1faee,1); });
      })(c);
      self.choiceGroup.add(bg); self.choiceGroup.add(tx);
    });
    if (visible.length===0) {
      // 无可见选项（理论上不应发生）则自动推进
      this.choiceActive=false;
      this.advanceIndex(1);
    }
  };
  NovelScene.prototype.showEnding = function (id, title, text) {
    this.endingShown = true;
    if (this.typeTimer) { this.typeTimer.remove(false); this.typeTimer=null; }
    this.isTyping=false;
    Sfx.play('ending');
    // 解锁结局
    if (unlockedEndings.indexOf(id)===-1) unlockedEndings.push(id);
    saveData.unlockedEndings = unlockedEndings.slice();
    // 结局也算进度，便于 Continue 回到结局页
    saveData.chapter=this.curChapter; saveData.scriptIndex=this.curIndex; saveData.flags=clone(runtimeFlags);
    persist();
    this.choiceGroup.clear(true,true);
    this.cameras.main.flash(420, 255, 184, 106);
    this.dialogText.setText('');
    this.charSprite.setAlpha(0.35);
    // 结局卡
    var card = this.add.rectangle(W/2, H/2 - 10, W-80, 260, 0xf1faee, 0.98).setDepth(7).setStrokeStyle(2, 0x1d3557, 1);
    this.add.text(W/2, H/2 - 86, title, { fontFamily:'Georgia, serif', fontSize:'18px', color:'#1d3557', fontStyle:'bold' }).setDepth(8).setOrigin(0.5);
    this.add.text(W/2, H/2 - 24, text, { fontFamily:'Georgia, serif', fontSize:'13px', color:'#3a3a4a', wordWrap:{width: W-140}, align:'center', lineSpacing:4 }).setDepth(8).setOrigin(0.5);
    var hint = this.add.text(W/2, H/2 + 76, 'Click or press Space — Title  |  R: Restart Chapter', { fontFamily:'Arial', fontSize:'11px', color:'#6a7a8a' }).setDepth(8).setOrigin(0.5);
    var self=this;
    var goTitle = function(){ Sfx.stopBgm(); self.scene.start('Title'); };
    var goRestart = function(){ Sfx.stopBgm(); self.scene.start('ChapterCard', {chapter:self.curChapter, index:0}); };
    this.input.once('pointerdown', goTitle, this);
    this.input.keyboard.once('keydown-SPACE', goTitle, this);
    this.input.keyboard.once('keydown-ENTER', goTitle, this);
    this.input.keyboard.once('keydown-R', goRestart, this);
  };

  // ---------------------------------------------------------------------------
  // 启动：加载存档后建 Phaser.Game
  // ---------------------------------------------------------------------------
  var BootScene = (function(){
    function Boot(){ Phaser.Scene.call(this,{key:'Boot'}); }
    Boot.prototype = Object.create(Phaser.Scene.prototype);
    Boot.prototype.constructor = Boot;
    Boot.prototype.create = function(){ this.scene.start('Title'); };
    return Boot;
  })();

  window.TRGames = window.TRGames || { register:function(){} };
  window.TRGames.register({
    id: 'avg-visual-novel',
    title: 'Echoes of the Signal',
    launch: function (host) {
      hostRef = host;
      // 同步读取存档（异步则先用默认值，回调后修正）
      try {
        host.loadState().then(function (s){
          if (s && typeof s.chapter === 'number') {
            saveData.chapter = s.chapter;
            saveData.scriptIndex = s.scriptIndex || 0;
            saveData.flags = s.flags || {};
            saveData.unlockedEndings = s.unlockedEndings || [];
            runtimeFlags = clone(saveData.flags);
            unlockedEndings = (saveData.unlockedEndings||[]).slice();
          }
        }, function(){});
      } catch (e) {}
      // 首次点击恢复 AudioContext（浏览器策略）
      try { document.addEventListener('click', function f(){ Sfx.resume(); document.removeEventListener('click', f); }, {once:true}); } catch(e){}

      var game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host.container,
        width: W,
        height: H,
        backgroundColor: '#0b132b',
        scene: [BootScene, TitleScene, ChapterSelectScene, ChapterCardScene, NovelScene]
      });
      gameRef = game;

      // 测试缝与存档语义：Continue 恢复 Chapter Select 仅已达
      window.__trgame = {
        game: game,
        getState: function () {
          var sc = null; try { sc = game.scene.getScene('Novel'); } catch(e){}
          var isNovel = sc && sc.scene && sc.scene.isActive && sc.scene.isActive('Novel');
          return {
            scene: isNovel ? 'novel' : (game.scene.isActive('Title') ? 'title' : 'other'),
            chapter: isNovel ? sc.curChapter : saveData.chapter,
            index: isNovel ? sc.curIndex : saveData.scriptIndex,
            flags: clone(isNovel ? runtimeFlags : saveData.flags),
            endings: (unlockedEndings||[]).slice()
          };
        }
      };
      return game;
    }
  });
})();
