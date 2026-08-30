// =============================================================================
// 【资产替换清单】puzzle-match3 / 三消 Puzzle Match3 v0.1.0
// =============================================================================
// 视觉占位（纯几何 + generateTexture，零外部图片）：
//   - 宝石6色：this.add.graphics()+generateTexture('gem0'..'gem5')
//     将来替换：this.load.image('gem0','assets/gem0.png') 等
//     // 宝石几何区分色：圆/方/菱/三角/六边形/星形
//     // 高光：graphics 白色半透明椭圆叠加
//     // 特殊宝石：横条纹/竖条纹/炸弹 → 在 base 上叠加条纹或爆炸图标
//     // 将来换：将 generateTexture 块改为外部贴图，并保留键名
//   - 障碍：iceOverlay / stone 亦为 graphics 生成，替换同上
//   - 背景棋盘格：checker 生成纹理
//   - 粒子：pixel 白点 generateTexture
// 音频占位（WebAudio oscillator+gain）：
//   - Sfx.play('select'/'swap'/'match'/'special'/'fail'/'win'/'bgm')
//     内部 oscillator → 将来替换 this.load.audio + this.sound.play
// 关卡：
//   - LEVELS 数组定义棋盘与目标 → 将来可换 JSON 关卡表
// =============================================================================
(function () {
  'use strict';
  /** 舞台尺寸 px */
  var W = 720;
  var H = 720;
  /** 棋盘行列 */
  var ROWS = 8;
  var COLS = 8;
  /** 单格边长 px */
  var CELL = 56;
  /** 棋盘原点（左上）px */
  var BOARD_X = 136;
  var BOARD_Y = 110;
  /** 宝石种类数 */
  var GEM_TYPES = 6;
  /** 消除分数基数 */
  var SCORE_PER_GEM = 100;
  /** 特殊创建额外分 */
  var SCORE_SPECIAL = 250;
  /** 宝石颜色 6色 */
  var GEM_COLORS = [0xe74c3c, 0x3498db, 0xf1c40f, 0x2ecc71, 0x9b59b6, 0xff8e53];
  /** 宝石颜色名（用于目标描述） */
  var GEM_NAMES = ['红', '蓝', '黄', '绿', '紫', '橙'];

  /** 关卡定义（至少2关，布局与目标区分） */
  var LEVELS = [
    {
      id: 1, title: '第1关 · 入门',
      moves: 20,
      goal: { type: 'score', target: 2500, label: '分数达到 2500' },
      // 无障碍
      ices: [],
      stones: []
    },
    {
      id: 2, title: '第2关 · 寒岩',
      moves: 25,
      // 复合目标：收集蓝色15个 + 清除冰块8块；区分于第1关纯分数
      goal: { type: 'collect', color: 1, count: 15, ice: 8, score: 2000, label: '收集蓝宝石15 + 清冰8 + 分数2000' },
      ices: [
        { r: 2, c: 2, hp: 2 }, { r: 2, c: 5, hp: 2 },
        { r: 3, c: 1, hp: 2 }, { r: 3, c: 6, hp: 2 },
        { r: 4, c: 2, hp: 1 }, { r: 4, c: 5, hp: 1 },
        { r: 5, c: 3, hp: 2 }, { r: 5, c: 4, hp: 2 }
      ],
      stones: [
        { r: 3, c: 3 }, { r: 3, c: 4 },
        { r: 4, c: 3 }, { r: 4, c: 4 }
      ]
    }
  ];

  var hostRef = null;
  var sceneRef = null;
  /** 存档 { bestScore:number, clearedStage:number } */
  var saveData = { bestScore: 0, clearedStage: 0 };

  function loadSave(host) {
    if (!host || !host.loadState) return;
    host.loadState().then(function (d) {
      if (d && typeof d.bestScore === 'number') saveData.bestScore = d.bestScore;
      if (d && typeof d.clearedStage === 'number') saveData.clearedStage = d.clearedStage;
    }).catch(function () {});
  }
  function persist() {
    if (!hostRef || !hostRef.saveState) return;
    try { hostRef.saveState({ bestScore: saveData.bestScore, clearedStage: saveData.clearedStage }); } catch (e) {}
  }

  /** 对外 getState {scene, score, moves, board} */
  function getState() {
    var sc = sceneRef;
    if (!sc) return { scene: 'menu', score: 0, moves: 0, board: null };
    var brd = null;
    try {
      if (sc.board) {
        brd = sc.board.map(function (row) {
          return row.map(function (cell) {
            if (cell.stone) return { stone: true, ice: cell.ice || 0 };
            if (!cell.gem) return { color: -1, special: null, ice: cell.ice || 0, stone: false };
            return { color: cell.gem.color, special: cell.gem.special || null, ice: cell.ice || 0, stone: false };
          });
        });
      }
    } catch (e) {}
    return {
      scene: sc.sceneState || 'menu',
      score: sc.score || 0,
      moves: sc.moves || 0,
      board: brd
    };
  }

  // ---------------------------------------------------------------------------
  // Sfx — WebAudio，静默降级
  // 将来替换：this.load.audio + this.sound.play
  // ---------------------------------------------------------------------------
  var Sfx = {
    ctx: null,
    bgmTimer: null,
    ensure: function () {
      try {
        if (!this.ctx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          this.ctx = new AC();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
      } catch (e) { return null; }
    },
    tone: function (freq, dur, type, vol, slide) {
      try {
        var c = this.ensure();
        if (!c) return;
        var o = c.createOscillator();
        var g = c.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        if (slide) o.frequency.linearRampToValueAtTime(slide, c.currentTime + dur);
        g.gain.value = vol != null ? vol : 0.18;
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
        o.connect(g); g.connect(c.destination);
        o.start(); o.stop(c.currentTime + dur);
      } catch (e) {}
    },
    play: function (name) {
      if (name === 'select') this.tone(600, 0.08, 'sine', 0.15);
      else if (name === 'swap') this.tone(440, 0.09, 'square', 0.13, 520);
      else if (name === 'fail') this.tone(180, 0.18, 'square', 0.18, 120);
      else if (name === 'match') { this.tone(523, 0.10, 'sine', 0.18); setTimeout(function(){ Sfx.tone(659,0.12,'sine',0.18); }, 90); }
      else if (name === 'special') { this.tone(880,0.12,'triangle',0.22,1200); setTimeout(function(){ Sfx.tone(440,0.18,'sawtooth',0.18,80); },120); }
      else if (name === 'win') { this.tone(523,0.12,'sine',0.20); setTimeout(function(){Sfx.tone(659,0.12,'sine',0.20);},120); setTimeout(function(){Sfx.tone(784,0.12,'sine',0.20);},240); setTimeout(function(){Sfx.tone(1046,0.22,'sine',0.22);},360); }
      else if (name === 'lose') this.tone(180,0.35,'sawtooth',0.20,90);
    },
    startBgm: function (scene) {
      this.stopBgm();
      var self=this;
      try { this.bgmTimer = scene.time.addEvent({ delay: 2100, loop:true, callback:function(){ /* 轻量占位BGM心跳 */ }}); } catch(e){}
    },
    stopBgm:function(){ if(this.bgmTimer){ try{this.bgmTimer.remove(false);}catch(e){} this.bgmTimer=null; } }
  };

  // ---------------------------------------------------------------------------
  // 纹理生成 — 纯几何（替换点中文注释）
  // 将来替换：this.load.image('gem0','assets/gem0.png') 等
  // ---------------------------------------------------------------------------
  function buildTextures(scene) {
    var g;
    function rm(k){ if(scene.textures.exists(k)) scene.textures.remove(k); }
    // 棋盘格纹理（可选）
    rm('cell_light'); g=scene.add.graphics(); g.fillStyle(0x1e232b,1); g.fillRoundedRect(0,0,CELL-4,CELL-4,8); g.generateTexture('cell_light',CELL-4,CELL-4); g.destroy();
    rm('cell_dark'); g=scene.add.graphics(); g.fillStyle(0x252e3a,1); g.fillRoundedRect(0,0,CELL-4,CELL-4,8); g.generateTexture('cell_dark',CELL-4,CELL-4); g.destroy();
    // 宝石 6种
    for(var ci=0;ci<GEM_TYPES;ci++){
      var col=GEM_COLORS[ci];
      // base
      rm('gem'+ci);
      g=scene.add.graphics();
      // 底色 + 形状
      g.fillStyle(col,1);
      var cx=28,cy=28,r=22;
      if(ci===0){
        // 圆形 红
        g.fillCircle(cx,cy,r);
      } else if(ci===1){
        // 方块 蓝 圆角矩形
        g.fillRoundedRect(cx-r,cy-r,44,44,8);
      } else if(ci===2){
        // 菱形 黄
        g.fillPoints([{x:cx,y:cy-r},{x:cx+r,y:cy},{x:cx,y:cy+r},{x:cx-r,y:cy}],true);
      } else if(ci===3){
        // 三角 绿
        g.fillTriangle(cx,cy-r+4,cx-r+4,cy+r-6,cx+r-4,cy+r-6);
      } else if(ci===4){
        // 六边形 紫
        var pts=[]; for(var k=0;k<6;k++){ var a=-Math.PI/2+k*Math.PI/3; pts.push({x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r}); } g.fillPoints(pts,true);
      } else {
        // 星形 橙 5角星（简化为五边形+内凹）
        var star=[]; for(var s=0;s<10;s++){ var ang=-Math.PI/2+s*Math.PI/5; var rr=s%2===0?r:r*0.55; star.push({x:cx+Math.cos(ang)*rr,y:cy+Math.sin(ang)*rr}); } g.fillPoints(star,true);
      }
      // 高光 白色半透明椭圆
      g.fillStyle(0xffffff,0.28); g.fillEllipse(cx-7,cy-8,16,10);
      g.fillStyle(0xffffff,0.14); g.fillEllipse(cx-5,cy-5,10,6);
      // 描边
      g.lineStyle(2,0x000000,0.18); if(ci===0) g.strokeCircle(cx,cy,r); else if(ci===1) g.strokeRoundedRect(cx-r,cy-r,44,44,8); else g.strokePoints && g.strokePoints||null;
      g.generateTexture('gem'+ci,56,56);
      g.destroy();
      // 横条纹特殊
      rm('gem'+ci+'_h');
      g=scene.add.graphics();
      // 复用base绘制
      g.fillStyle(col,1);
      if(ci===0) g.fillCircle(cx,cy,r); else if(ci===1) g.fillRoundedRect(cx-r,cy-r,44,44,8); else if(ci===2) g.fillPoints([{x:cx,y:cy-r},{x:cx+r,y:cy},{x:cx,y:cy+r},{x:cx-r,y:cy}],true); else if(ci===3) g.fillTriangle(cx,cy-r+4,cx-r+4,cy+r-6,cx+r-4,cy+r-6); else if(ci===4){ var p=[]; for(var kk=0;kk<6;kk++){ var aa=-Math.PI/2+kk*Math.PI/3; p.push({x:cx+Math.cos(aa)*r,y:cy+Math.sin(aa)*r}); } g.fillPoints(p,true);} else { var st=[]; for(var ss=0;ss<10;ss++){ var ag=-Math.PI/2+ss*Math.PI/5; var rr2=ss%2===0?r:r*0.55; st.push({x:cx+Math.cos(ag)*rr2,y:cy+Math.sin(ag)*rr2}); } g.fillPoints(st,true); }
      g.fillStyle(0xffffff,0.28); g.fillEllipse(cx-7,cy-8,16,10);
      // 横条纹白线
      g.fillStyle(0xffffff,0.92); g.fillRect(6,26,44,4); g.fillStyle(0x000000,0.22); g.fillRect(6,30,44,2);
      g.generateTexture('gem'+ci+'_h',56,56); g.destroy();
      // 竖条纹
      rm('gem'+ci+'_v');
      g=scene.add.graphics();
      g.fillStyle(col,1);
      if(ci===0) g.fillCircle(cx,cy,r); else if(ci===1) g.fillRoundedRect(cx-r,cy-r,44,44,8); else if(ci===2) g.fillPoints([{x:cx,y:cy-r},{x:cx+r,y:cy},{x:cx,y:cy+r},{x:cx-r,y:cy}],true); else if(ci===3) g.fillTriangle(cx,cy-r+4,cx-r+4,cy+r-6,cx+r-4,cy+r-6); else if(ci===4){ var pp=[]; for(var kkk=0;kkk<6;kkk++){ var aaa=-Math.PI/2+kkk*Math.PI/3; pp.push({x:cx+Math.cos(aaa)*r,y:cy+Math.sin(aaa)*r}); } g.fillPoints(pp,true);} else { var sst=[]; for(var sss=0;sss<10;sss++){ var ag2=-Math.PI/2+sss*Math.PI/5; var rr3=sss%2===0?r:r*0.55; sst.push({x:cx+Math.cos(ag2)*rr3,y:cy+Math.sin(ag2)*rr3}); } g.fillPoints(sst,true); }
      g.fillStyle(0xffffff,0.28); g.fillEllipse(cx-7,cy-8,16,10);
      g.fillStyle(0xffffff,0.92); g.fillRect(26,6,4,44); g.fillStyle(0x000000,0.22); g.fillRect(30,6,2,44);
      g.generateTexture('gem'+ci+'_v',56,56); g.destroy();
      // 炸弹（带边框+中心闪光）
      rm('gem'+ci+'_bomb');
      g=scene.add.graphics();
      g.fillStyle(col,1);
      if(ci===0) g.fillCircle(cx,cy,r); else if(ci===1) g.fillRoundedRect(cx-r,cy-r,44,44,8); else if(ci===2) g.fillPoints([{x:cx,y:cy-r},{x:cx+r,y:cy},{x:cx,y:cy+r},{x:cx-r,y:cy}],true); else if(ci===3) g.fillTriangle(cx,cy-r+4,cx-r+4,cy+r-6,cx+r-4,cy+r-6); else if(ci===4){ var ppp=[]; for(var k2=0;k2<6;k2++){ var a2=-Math.PI/2+k2*Math.PI/3; ppp.push({x:cx+Math.cos(a2)*r,y:cy+Math.sin(a2)*r}); } g.fillPoints(ppp,true);} else { var s2=[]; for(var s3=0;s3<10;s3++){ var ag3=-Math.PI/2+s3*Math.PI/5; var rr4=s3%2===0?r:r*0.55; s2.push({x:cx+Math.cos(ag3)*rr4,y:cy+Math.sin(ag3)*rr4}); } g.fillPoints(s2,true); }
      g.fillStyle(0xffffff,0.28); g.fillEllipse(cx-7,cy-8,16,10);
      // 炸弹标识：黑色圆+引线火花
      g.fillStyle(0x111111,1); g.fillCircle(cx,cy+6,10); g.fillStyle(0xffcc00,1); g.fillCircle(cx+6,cy-4,4); g.fillStyle(0xffffff,0.9); g.fillCircle(cx-3,cy+2,3);
      g.generateTexture('gem'+ci+'_bomb',56,56); g.destroy();
    }
    // 冰块覆盖纹理
    rm('ice1'); g=scene.add.graphics(); g.fillStyle(0x7fbfff,0.42); g.fillRoundedRect(0,0,52,52,8); g.lineStyle(2,0xcfe6ff,0.9); g.strokeRoundedRect(1,1,50,50,8); g.fillStyle(0xffffff,0.55); g.fillCircle(14,14,6); g.generateTexture('ice1',52,52); g.destroy();
    rm('ice2'); g=scene.add.graphics(); g.fillStyle(0x3a7bd5,0.55); g.fillRoundedRect(0,0,52,52,8); g.lineStyle(2,0xffffff,0.9); g.strokeRoundedRect(1,1,50,50,8); g.fillStyle(0xffffff,0.65); g.fillCircle(14,14,7); g.lineStyle(1,0xffffff,0.35); g.lineBetween(10,26,42,26); g.lineBetween(26,10,26,42); g.generateTexture('ice2',52,52); g.destroy();
    // 石块纹理
    rm('stone'); g=scene.add.graphics(); g.fillStyle(0x5a6470,1); g.fillRoundedRect(0,0,52,52,10); g.fillStyle(0x7a8794,1); g.fillCircle(16,16,7); g.fillCircle(36,30,9); g.fillStyle(0x3b4450,1); g.fillCircle(28,38,5); g.lineStyle(2,0x2b333d,1); g.strokeRoundedRect(1,1,50,50,10); g.generateTexture('stone',52,52); g.destroy();
    // 选中高光
    rm('select'); g=scene.add.graphics(); g.lineStyle(3,0xfff176,1); g.strokeRoundedRect(0,0,54,54,10); g.lineStyle(1,0xffffff,0.9); g.strokeRoundedRect(2,2,50,50,8); g.generateTexture('select',54,54); g.destroy();
    // 粒子
    rm('particle'); g=scene.add.graphics(); g.fillStyle(0xffffff,1); g.fillCircle(4,4,4); g.generateTexture('particle',8,8); g.destroy();
  }

  // ---------------------------------------------------------------------------
  // 主场景 — 单 Phaser.Scene 承载菜单+游玩
  // ---------------------------------------------------------------------------
  var GameScene = Phaser ? (function(){
    // 兼容 Phaser v4.2.1 的类写法（ES5）
    return class extends Phaser.Scene {
      constructor(){ super('GameScene'); }
      preload(){
        // 无外部资源，仅生成纹理在 create
      }
      create(){
        sceneRef=this;
        this.sceneState='menu';
        this.stageIdx=0;
        this.score=0; this.moves=0;
        this.board=null; // 2D [r][c] { gem:{color,special,sprite,ox,oy}, ice:number, stone:boolean, iceSprite, stoneSprite, bgSprite }
        this.gemPool=[]; // 对象池：回收的 sprite
        this.selected=null; // {r,c}
        this.busy=false;
        this.collected=[0,0,0,0,0,0];
        this.iceCleared=0;
        this.isGameOver=false;
        this.combo=0;
        buildTextures(this);

        // 背景
        this.add.rectangle(W/2,H/2,W,H,0x0f141e).setDepth(-10);
        // 标题与 HUD 将在各状态重建
        this.input.addListener('pointerdown', this.onPointerDown, this);
        this.showMenu();
      }

      // ===================== UI Helpers =====================
      clearUi(){
        if(this.uiGroup) try{ this.uiGroup.destroy(true);}catch(e){}
        this.uiGroup=this.add.group();
        // 保留 board 容器另管
      }
      showMenu(){
        this.sceneState='menu';
        this.clearUi();
        if(this.boardGroup) try{ this.boardGroup.destroy(true);}catch(e){} this.boardGroup=null;
        this.board=null;
        Sfx.stopBgm();
        var title=this.add.text(W/2, 90, '三消 Puzzle Match3', { fontSize:'34px', color:'#fff', fontStyle:'bold'}).setOrigin(0.5);
        var sub=this.add.text(W/2, 132, '8×8 高阶三消 · 步数限制 · 特殊宝石', {fontSize:'15px', color:'#9aadbf'}).setOrigin(0.5);
        this.uiGroup.add(title); this.uiGroup.add(sub);
        var best=this.add.text(W/2, 168, '最高分: '+saveData.bestScore+'   已通关: '+(saveData.clearedStage)+' / '+LEVELS.length, {fontSize:'14px', color:'#7fbfff'}).setOrigin(0.5);
        this.uiGroup.add(best);
        // 关卡按钮
        for(var i=0;i<LEVELS.length;i++){
          (function(idx){
            var lv=LEVELS[idx];
            var locked = idx>0 && saveData.clearedStage < idx;
            var y=220+idx*84;
            var bg=this.add.graphics();
            bg.fillStyle(locked?0x2a3340:0x1e88e5,1); bg.fillRoundedRect(W/2-180,y-30,360,64,12);
            if(!locked){ bg.lineStyle(2,0x64b5f6,0.9); bg.strokeRoundedRect(W/2-180,y-30,360,64,12); }
            bg.setInteractive(new Phaser.Geom.Rectangle(W/2-180,y-30,360,64), Phaser.Geom.Rectangle.Contains);
            bg.on('pointerdown', function(){ if(locked) return; Sfx.play('select'); this.startLevel(idx); }.bind(this));
            bg.on('pointerover', function(){ if(!locked) bg.setAlpha(0.92); });
            bg.on('pointerout', function(){ bg.setAlpha(1); });
            var t=this.add.text(W/2, y-10, lv.title + (locked?'  🔒':''), {fontSize:'18px', color: locked?'#8a96a6':'#fff', fontStyle:'bold'}).setOrigin(0.5);
            var d=this.add.text(W/2, y+12, lv.goal.label + ' · '+(lv.moves)+'步', {fontSize:'12px', color: locked?'#6d7a8a':'#cfe6ff'}).setOrigin(0.5);
            this.uiGroup.add(bg); this.uiGroup.add(t); this.uiGroup.add(d);
          }).call(this,i);
        }
        var tip=this.add.text(W/2, H-46, '拖拽/点击交换相邻宝石 · 无消除则回退 · 炸弹/条纹可连锁', {fontSize:'12px', color:'#6e7f91'}).setOrigin(0.5);
        this.uiGroup.add(tip);
        var repl=this.add.text(W/2, H-24, '【资产替换清单】见文件头注释', {fontSize:'11px', color:'#4a5a6e'}).setOrigin(0.5);
        this.uiGroup.add(repl);
      }

      startLevel(idx){
        this.stageIdx=idx;
        var lv=LEVELS[idx];
        this.score=0; this.moves=lv.moves; this.collected=[0,0,0,0,0,0]; this.iceCleared=0; this.isGameOver=false; this.busy=false; this.selected=null;
        this.sceneState='playing';
        this.clearUi();
        if(this.boardGroup) try{this.boardGroup.destroy(true);}catch(e){}
        this.boardGroup=this.add.group();
        this.buildBoard(lv);
        this.buildHud();
        Sfx.startBgm(this);
        // 初始若有意外三消（由随机生成避免+保险循环消除）
        this.doCascade(true);
      }

      buildHud(){
        var lv=LEVELS[this.stageIdx];
        // 顶部 HUD 条
        var bar=this.add.graphics();
        bar.fillStyle(0x16202e,1); bar.fillRect(0,0,W,62);
        bar.lineStyle(1,0x2a3a50,1); bar.strokeRect(0,0,W,62);
        this.uiGroup.add(bar);
        this.hudScore=this.add.text(16, 14, '分数 0', {fontSize:'18px', color:'#fff', fontStyle:'bold'});
        this.hudMoves=this.add.text(190, 14, '步数 '+this.moves, {fontSize:'18px', color:'#ffd54f', fontStyle:'bold'});
        this.hudGoal=this.add.text(320, 14, lv.goal.label, {fontSize:'13px', color:'#cfe6ff'});
        this.hudProgress=this.add.text(16, 38, this.getGoalProgressText(), {fontSize:'12px', color:'#9aadbf'});
        this.uiGroup.add(this.hudScore); this.uiGroup.add(this.hudMoves); this.uiGroup.add(this.hudGoal); this.uiGroup.add(this.hudProgress);
        // 底部提示
        this.tipText=this.add.text(W/2, H-22, '点击选中一个宝石，再点相邻宝石交换', {fontSize:'12px', color:'#6e7f91'}).setOrigin(0.5);
        this.uiGroup.add(this.tipText);
      }

      getGoalProgressText(){
        var lv=LEVELS[this.stageIdx];
        if(lv.goal.type==='score'){
          return '进度: '+this.score+' / '+lv.goal.target;
        } else {
          var parts=[];
          if(lv.goal.score) parts.push('分数 '+this.score+'/'+lv.goal.score);
          if(lv.goal.count!=null) parts.push(GEM_NAMES[lv.goal.color]+' '+this.collected[lv.goal.color]+'/'+lv.goal.count);
          if(lv.goal.ice!=null) parts.push('冰块 '+(this.iceCleared||0)+'/'+lv.goal.ice);
          return '进度: '+parts.join('  ·  ');
        }
      }
      updateHud(){
        var lv=LEVELS[this.stageIdx];
        if(this.hudScore) this.hudScore.setText('分数 '+this.score);
        if(this.hudMoves){
          this.hudMoves.setText('步数 '+this.moves);
          this.hudMoves.setColor(this.moves<=5 ? '#ff6b6b' : '#ffd54f');
        }
        if(this.hudProgress) this.hudProgress.setText(this.getGoalProgressText());
        // 检查胜利/失败在 cascade 后
      }

      buildBoard(lv){
        // 初始化 2D cell
        this.board=[];
        for(var r=0;r<ROWS;r++){
          var row=[];
          for(var c=0;c<COLS;c++){
            var cell={ r:r,c:c, gem:null, ice:0, stone:false, bg:null, iceSprite:null, stoneSprite:null, selectMark:null };
            // 背景格
            var key=(r+c)%2===0?'cell_light':'cell_dark';
            var bg=this.add.image(BOARD_X+c*CELL+ CELL/2, BOARD_Y+r*CELL+ CELL/2, key);
            bg.setDisplaySize(CELL-6,CELL-6); bg.setAlpha(0.95);
            cell.bg=bg; this.boardGroup.add(bg);
            row.push(cell);
          }
          this.board.push(row);
        }
        // 障碍
        lv.ices.forEach(function(o){
          if(o.r<0||o.r>=ROWS||o.c<0||o.c>=COLS) return;
          this.board[o.r][o.c].ice = o.hp;
        },this);
        lv.stones.forEach(function(o){
          if(o.r<0||o.r>=ROWS||o.c<0||o.c>=COLS) return;
          this.board[o.r][o.c].stone = true;
        },this);
        // 头次填充宝石（避开初始三消）
        this.fillBoardNoMatch();
        this.renderBoardSprites();
      }

      fillBoardNoMatch(){
        // 为每个非石块空位填色，避免初始就有三连
        for(var r=0;r<ROWS;r++) for(var c=0;c<COLS;c++){
          var cell=this.board[r][c];
          if(cell.stone) continue;
          var tries=0;
          while(true){
            var col=Math.floor(Math.random()*GEM_TYPES);
            cell.gem={ color:col, special:null };
            if(!this.wouldCauseMatch(r,c,col) || tries>20) break;
            tries++;
          }
        }
        // 若仍有匹配（障碍边界偶发），循环打散
        var guard=0;
        while(guard<20){
          var m=this.findMatchesRaw();
          if(m.matched.size===0) break;
          // 打散：对匹配区随机重掷
          m.matched.forEach(function(key){
            var p=key.split(','); var rr=parseInt(p[0],10), cc=parseInt(p[1],10);
            var cel=this.board[rr][cc]; if(cel.stone||!cel.gem) return;
            cel.gem.color=Math.floor(Math.random()*GEM_TYPES); cel.gem.special=null;
          },this);
          guard++;
        }
      }
      wouldCauseMatch(r,c,color){
        // 检查以(r,c)为新放色是否形成≥3连（仅看已填的左/上）
        // 横向：向左连续
        var cnt=1;
        for(var cc=c-1;cc>=0;cc--){
          var cel=this.board[r][cc]; if(cel.stone||!cel.gem) break;
          if(cel.gem.color===color) cnt++; else break;
        }
        if(cnt>=3) return true;
        // 纵向向上
        cnt=1;
        for(var rr=r-1;rr>=0;rr--){
          var cel2=this.board[rr][c]; if(cel2.stone||!cel2.gem) break;
          if(cel2.gem.color===color) cnt++; else break;
        }
        if(cnt>=3) return true;
        // 也检查左右夹击：左右各一形成3（当填充非顺序时）
        // 简化仅上面两种已足够顺序填充
        return false;
      }

      renderBoardSprites(){
        // 清旧精灵
        for(var r=0;r<ROWS;r++) for(var c=0;c<COLS;c++){
          var cell=this.board[r][c];
          if(cell.gem && cell.gem.sprite) { try{cell.gem.sprite.destroy();}catch(e){} cell.gem.sprite=null; }
          if(cell.iceSprite) { try{cell.iceSprite.destroy();}catch(e){} cell.iceSprite=null; }
          if(cell.stoneSprite) { try{cell.stoneSprite.destroy();}catch(e){} cell.stoneSprite=null; }
          if(cell.selectMark) { try{cell.selectMark.destroy();}catch(e){} cell.selectMark=null; }
        }
        for(var rr=0;rr<ROWS;rr++) for(var cc=0;cc<COLS;cc++){
          var cel=this.board[rr][cc];
          var px=BOARD_X+cc*CELL+CELL/2, py=BOARD_Y+rr*CELL+CELL/2;
          if(cel.stone){
            var ss=this.add.image(px,py,'stone'); ss.setDisplaySize(52,52); ss.setDepth(3);
            cel.stoneSprite=ss; this.boardGroup.add(ss);
            if(cel.ice>0){
              var ics=this.add.image(px,py, cel.ice>=2?'ice2':'ice1'); ics.setDisplaySize(52,52); ics.setDepth(4);
              cel.iceSprite=ics; this.boardGroup.add(ics);
            }
            continue;
          }
          if(cel.gem){
            var tex='gem'+cel.gem.color + (cel.gem.special ? '_'+cel.gem.special : '');
            var sp=this.add.image(px,py,tex); sp.setDisplaySize(50,50); sp.setDepth(5);
            // // 视觉：宝石几何已在 buildTextures 生成，替换点见文件头
            sp.setInteractive(new Phaser.Geom.Rectangle(-25,-25,50,50), Phaser.Geom.Rectangle.Contains);
            // 存回
            cel.gem.sprite=sp; cel.gem.px=px; cel.gem.py=py;
            this.boardGroup.add(sp);
          }
          if(cel.ice>0){
            var ics2=this.add.image(px,py, cel.ice>=2?'ice2':'ice1'); ics2.setDisplaySize(52,52); ics2.setDepth(6); ics2.setAlpha(0.96);
            cel.iceSprite=ics2; this.boardGroup.add(ics2);
          }
        }
        this.refreshSelectionMark();
      }

      refreshSelectionMark(){
        for(var r=0;r<ROWS;r++) for(var c=0;c<COLS;c++){
          var cel=this.board[r][c];
          if(cel.selectMark){ try{cel.selectMark.destroy();}catch(e){} cel.selectMark=null; }
        }
        if(this.selected){
          var s=this.board[this.selected.r][this.selected.c];
          if(!s.stone){
            var m=this.add.image(BOARD_X+s.c*CELL+CELL/2, BOARD_Y+s.r*CELL+CELL/2,'select');
            m.setDisplaySize(54,54); m.setDepth(7);
            s.selectMark=m; this.boardGroup.add(m);
          }
        }
      }

      // ===================== 输入 =====================
      onPointerDown(pointer){
        if(this.sceneState!=='playing' || this.busy || this.isGameOver) return;
        var c=Math.floor((pointer.x - BOARD_X)/CELL);
        var r=Math.floor((pointer.y - BOARD_Y)/CELL);
        if(r<0||r>=ROWS||c<0||c>=COLS) return;
        var cell=this.board[r][c];
        if(cell.stone) { Sfx.play('fail'); return; }
        if(!cell.gem) return;
        if(!this.selected){
          this.selected={r:r,c:c}; Sfx.play('select'); this.refreshSelectionMark();
          return;
        }
        if(this.selected.r===r && this.selected.c===c){
          this.selected=null; this.refreshSelectionMark(); return;
        }
        var dr=Math.abs(r-this.selected.r), dc=Math.abs(c-this.selected.c);
        if((dr===1&&dc===0)||(dr===0&&dc===1)){
          var r1=this.selected.r,c1=this.selected.c,r2=r,c2=c;
          this.selected=null; this.refreshSelectionMark();
          this.trySwap(r1,c1,r2,c2);
        } else {
          // 非相邻则重选
          this.selected={r:r,c:c}; Sfx.play('select'); this.refreshSelectionMark();
        }
      }

      // ===================== 交换与回退 =====================
      trySwap(r1,c1,r2,c2){
        if(this.busy) return;
        var a=this.board[r1][c1], b=this.board[r2][c2];
        if(a.stone||b.stone) { Sfx.play('fail'); return; }
        if(!a.gem||!b.gem) return;
        this.busy=true;
        // 特例：两特殊相邻交换直接触发（无需匹配）
        var bothSpecial = a.gem.special && b.gem.special;
        if(bothSpecial){
          // 交换后直接触发双方特效
          this.swapGems(a,b);
          this.animateSwap(a,b, function(){
            this.moves=Math.max(0,this.moves-1); this.updateHud();
            Sfx.play('special');
            var set=new Set([r1+','+c1, r2+','+c2]);
            // 额外扩展
            var exp=this.expandSpecials(set);
            this.processClear(exp, this.buildSpecialCreateMap(new Set()), true, function(){
              this.postCascadeCheck();
            }.bind(this));
          }.bind(this));
          return;
        }
        // 特例：特殊+普通交换，若同色则直接触发特殊（简化）
        // 这里仍走通用：交换后若形成匹配则进入cascade，否则回退
        this.swapGems(a,b);
        this.animateSwap(a,b, function(){
          var m=this.findMatchesRaw();
          // 检测特殊触发：若交换的任一是特殊且被匹配包含，也会通过 expandSpecials 处理
          // 但若无任何匹配，是否允许特殊单换触发？按“可被触发”要求，特殊应能被相邻交换触发
          var swappedKeys=new Set([r1+','+c1, r2+','+c2]);
          var hasSpecialSwap = (a.gem.special || b.gem.special);
          // 若有特殊参与，允许无匹配也触发（降低难度）
          if(m.matched.size===0 && hasSpecialSwap){
            var exp2=this.expandSpecials(swappedKeys);
            if(exp2.size>0){
              this.moves=Math.max(0,this.moves-1); this.updateHud();
              Sfx.play('special');
              this.processClear(exp2, this.buildSpecialCreateMap(new Set()), true, function(){ this.postCascadeCheck(); }.bind(this));
              return;
            }
          }
          if(m.matched.size===0){
            Sfx.play('fail');
            // 回退
            this.swapGems(a,b);
            this.animateSwap(a,b, function(){ this.busy=false; }.bind(this));
            return;
          }
          // 有匹配
          this.moves=Math.max(0,this.moves-1); this.updateHud();
          Sfx.play('swap');
          this.doCascade(false);
        }.bind(this));
      }

      swapGems(cellA, cellB){
        var tmp=cellA.gem; cellA.gem=cellB.gem; cellB.gem=tmp;
        // 交换精灵引用也同步更新位置缓存
        if(cellA.gem && cellA.gem.sprite){
          cellA.gem.sprite.setPosition(BOARD_X+cellA.c*CELL+CELL/2, BOARD_Y+cellA.r*CELL+CELL/2);
        }
        if(cellB.gem && cellB.gem.sprite){
          cellB.gem.sprite.setPosition(BOARD_X+cellB.c*CELL+CELL/2, BOARD_Y+cellB.r*CELL+CELL/2);
        }
      }

      animateSwap(a,b, cb){
        var ax=BOARD_X+a.c*CELL+CELL/2, ay=BOARD_Y+a.r*CELL+CELL/2;
        var bx=BOARD_X+b.c*CELL+CELL/2, by=BOARD_Y+b.r*CELL+CELL/2;
        var sa=a.gem? a.gem.sprite:null, sb=b.gem? b.gem.sprite:null;
        if(!sa||!sb){ if(cb) cb(); return; }
        // 即时已在 swapGems 中换位，动画从旧位 tween 到新位需要先回退再 tween；简化：直接 tween 到新位做缩放反馈
        // 由于已瞬移，改用 scale 弹跳作为反馈并延迟回调
        var t=0;
        this.tweens.add({ targets:[sa,sb], scaleX:1.15, scaleY:1.15, duration:90, yoyo:true, onComplete:function(){ if(cb) cb(); }});
      }

      // ===================== 匹配检测 =====================
      findMatchesRaw(){
        var matched=new Set();
        var hRuns=[], vRuns=[];
        // 横向
        for(var r=0;r<ROWS;r++){
          var c=0;
          while(c<COLS){
            var cel=this.board[r][c];
            if(cel.stone||!cel.gem){ c++; continue; }
            var color=cel.gem.color;
            var start=c;
            while(c<COLS){
              var cc=this.board[r][c];
              if(cc.stone||!cc.gem||cc.gem.color!==color) break;
              c++;
            }
            var len=c-start;
            if(len>=3){
              var run=[];
              for(var k=start;k<c;k++){ var key=r+','+k; matched.add(key); run.push({r:r,c:k}); }
              hRuns.push({r:r, start:start, len:len, run:run});
            }
            if(len===0) c++;
          }
        }
        // 纵向
        for(var cc2=0;cc2<COLS;cc2++){
          var rr=0;
          while(rr<ROWS){
            var cel2=this.board[rr][cc2];
            if(cel2.stone||!cel2.gem){ rr++; continue; }
            var col2=cel2.gem.color;
            var start2=rr;
            while(rr<ROWS){
              var ccc=this.board[rr][cc2];
              if(ccc.stone||!ccc.gem||ccc.gem.color!==col2) break;
              rr++;
            }
            var len2=rr-start2;
            if(len2>=3){
              var run2=[];
              for(var k2=start2;k2<rr;k2++){ var key2=k2+','+cc2; matched.add(key2); run2.push({r:k2,c:cc2}); }
              vRuns.push({c:cc2, start:start2, len:len2, run:run2});
            }
            if(len2===0) rr++;
          }
        }
        return { matched:matched, hRuns:hRuns, vRuns:vRuns };
      }

      /** 借当前匹配计算应产生的特殊位 */
      buildSpecialCreateMap(matched){
        var info=this.findMatchesRaw();
        // 使用传入 matched 若非空则以它为准，否则用info.matched
        var mat = (matched && matched.size>0) ? matched : info.matched;
        if(mat.size===0) return new Map();
        // 统计每个格的所属 run 长度
        function hLenAt(r,c){
          for(var i=0;i<info.hRuns.length;i++){ var hr=info.hRuns[i]; if(hr.r!==r) continue; if(c>=hr.start && c<hr.start+hr.len) return hr.len; }
          return 0;
        }
        function vLenAt(r,c){
          for(var i=0;i<info.vRuns.length;i++){ var vr=info.vRuns[i]; if(vr.c!==c) continue; if(r>=vr.start && r<vr.start+vr.len) return vr.len; }
          return 0;
        }
        var specials=new Map(); // key -> 'h'|'v'|'bomb'
        // 先标记十字/T/L 炸弹
        mat.forEach(function(key){
          var sp=key.split(','); var rr=parseInt(sp[0],10), cc=parseInt(sp[1],10);
          var hl=hLenAt(rr,cc), vl=vLenAt(rr,cc);
          if(hl>=3 && vl>=3){ specials.set(key,'bomb'); }
        });
        // 再对剩余长条生成条纹/炸弹
        info.hRuns.forEach(function(hr){
          if(hr.len<4) return;
          // 若该 run 已包含炸弹则跳过
          var hasBomb=false; hr.run.forEach(function(p){ if(specials.has(p.r+','+p.c)) hasBomb=true; });
          if(hasBomb) return;
          var mid=Math.floor(hr.len/2);
          var mp=hr.run[mid];
          var key2=mp.r+','+mp.c;
          if(hr.len>=5) specials.set(key2,'bomb');
          else specials.set(key2,'h');
        });
        info.vRuns.forEach(function(vr){
          if(vr.len<4) return;
          var hasBomb2=false; vr.run.forEach(function(p){ if(specials.has(p.r+','+p.c)) hasBomb2=true; });
          if(hasBomb2) return;
          var mid2=Math.floor(vr.len/2);
          var mp2=vr.run[mid2];
          var key3=mp2.r+','+mp2.c;
          if(specials.has(key3)) return;
          if(vr.len>=5) specials.set(key3,'bomb');
          else specials.set(key3,'v');
        });
        return specials;
      }

      /** 特殊扩展：若匹配包含特殊，则扩展到整行/列/3×3，并连锁 */
      expandSpecials(initialSet){
        var expanded=new Set(initialSet);
        var queue=Array.from(initialSet);
        var visitedSpecial=new Set();
        while(queue.length){
          var key=queue.shift();
          var sp=key.split(','); var r=parseInt(sp[0],10), c=parseInt(sp[1],10);
          var cel=this.board[r][c];
          if(!cel || cel.stone || !cel.gem) continue;
          var spec=cel.gem.special;
          if(!spec || visitedSpecial.has(key)) continue;
          visitedSpecial.add(key);
          if(spec==='h'){
            for(var cc=0;cc<COLS;cc++){
              var k2=r+','+cc; if(expanded.has(k2)) continue;
              var ccCell=this.board[r][cc];
              if(ccCell.stone){ expanded.add(k2); continue; } // 炸掉石头
              expanded.add(k2);
              if(ccCell.gem && ccCell.gem.special && !visitedSpecial.has(k2)) queue.push(k2);
            }
          } else if(spec==='v'){
            for(var rr2=0;rr2<ROWS;rr2++){
              var k3=rr2+','+c; if(expanded.has(k3)) continue;
              var rrCell=this.board[rr2][c];
              if(rrCell.stone){ expanded.add(k3); continue; }
              expanded.add(k3);
              if(rrCell.gem && rrCell.gem.special && !visitedSpecial.has(k3)) queue.push(k3);
            }
          } else if(spec==='bomb'){
            for(var dr=-1;dr<=1;dr++) for(var dc=-1;dc<=1;dc++){
              var nr=r+dr, nc=c+dc; if(nr<0||nr>=ROWS||nc<0||nc>=COLS) continue;
              var k4=nr+','+nc; if(expanded.has(k4)) continue;
              expanded.add(k4);
              var nb=this.board[nr][nc];
              if(nb.gem && nb.gem.special && !visitedSpecial.has(k4)) queue.push(k4);
            }
          }
        }
        // 仅保留棋盘范围内；石头格也保留以便炸掉
        return expanded;
      }

      // ===================== 消除、重力、补新 循环 =====================
      doCascade(isInitial){
        if(this.isGameOver) { this.busy=false; return; }
        this.busy=true;
        var loop=function(){
          var raw=this.findMatchesRaw();
          if(raw.matched.size===0){
            this.busy=false;
            if(!isInitial) this.postCascadeCheck();
            return;
          }
          // 扩展特殊
          var expanded=this.expandSpecials(raw.matched);
          var specialsMap=this.buildSpecialCreateMap(raw.matched);
          this.processClear(expanded, specialsMap, false, function(){
            // 重力补新后继续循环
            this.applyGravityAndRefill(function(){
              // 轻微延迟再检
              this.time.delayedCall(90, loop);
            }.bind(this));
          }.bind(this));
        }.bind(this);
        if(isInitial){
          // 初始仅校正，不计分不耗步
          var guard=0;
          var syncLoop=function(){
            var rr=this.findMatchesRaw();
            if(rr.matched.size===0 || guard>12){ this.busy=false; return; }
            guard++;
            var exp=this.expandSpecials(rr.matched);
            var spm=this.buildSpecialCreateMap(rr.matched);
            this.processClear(exp, spm, false, function(){
              this.applyGravityAndRefill(function(){ this.time.delayedCall(60, syncLoop); }.bind(this));
            }.bind(this));
          }.bind(this);
          syncLoop();
        } else {
          loop();
        }
      }

      processClear(expandedSet, specialsMap, isTriggeredBySpecial, done){
        // 统计与动画
        var toClear=[];
        var toKeepSpecial=[]; // {r,c,type,color}
        var scoreGain=0;
        var hasSpecialTrigger=false;
        expandedSet.forEach(function(key){
          var sp=key.split(','); var r=parseInt(sp[0],10), c=parseInt(sp[1],10);
          if(r<0||r>=ROWS||c<0||c>=COLS) return;
          var cel=this.board[r][c];
          if(cel.stone){
            // 石头仅在特殊扩展中被加入
            toClear.push({r:r,c:c,isStone:true});
            return;
          }
          if(cel.ice>0 && !cel.gem){
            // 只有冰无宝石（不该出现）
          }
          // 若该格被指定生成特殊，则保留
          if(specialsMap.has(key)){
            var stype=specialsMap.get(key);
            var col = cel.gem? cel.gem.color : Math.floor(Math.random()*GEM_TYPES);
            toKeepSpecial.push({r:r,c:c,type:stype,color:col});
            // 不计入立即清除，但会之后转特殊
            hasSpecialTrigger=true;
            return;
          }
          // 普通清除（包含特殊触发的整行等，可能该格本身就是特殊）
          if(cel.gem){
            if(cel.gem.special) hasSpecialTrigger=true;
            toClear.push({r:r,c:c, color:cel.gem.color});
          } else if(cel.ice>0){
            // 冰块格无宝石但被特殊波及
            toClear.push({r:r,c:c, color:-1});
          } else {
            // 石头已处理
          }
        },this);

        // 去重：toKeepSpecial 的格不应在 toClear 中
        var keepKeys=new Set(toKeepSpecial.map(function(o){return o.r+','+o.c;}));
        toClear = toClear.filter(function(o){ return !keepKeys.has(o.r+','+o.c); });

        if(toClear.length===0 && toKeepSpecial.length===0){ if(done) done(); return; }

        // 计分
        var base = toClear.filter(function(o){return !o.isStone;}).length * SCORE_PER_GEM;
        if(toKeepSpecial.length>0) base += toKeepSpecial.length * SCORE_SPECIAL;
        // 连击加成
        this.combo = (this.combo||0)+1;
        var mult = 1 + (this.combo-1)*0.2;
        scoreGain = Math.floor(base * mult);
        this.score += scoreGain;
        // 收集统计
        toClear.forEach(function(o){
          if(o.color>=0) this.collected[o.color]=(this.collected[o.color]||0)+1;
        },this);
        // 冰块清除统计（对每个清除格若原ice>0则递减）
        var iceDelta=0;
        toClear.forEach(function(o){
          var cel=this.board[o.r][o.c];
          if(o.isStone){ return; }
          if(cel.ice>0){ iceDelta++; }
        },this);

        // 音效
        if(hasSpecialTrigger || toKeepSpecial.length>0) Sfx.play('special'); else if(toClear.length>0) Sfx.play('match');

        // 飘字
        if(scoreGain>0){
          var fx=this.add.text(W/2, 78, '+'+scoreGain + (this.combo>1?'  x'+this.combo:'') , {fontSize:'16px', color:'#ffd54f', fontStyle:'bold'}).setOrigin(0.5); fx.setDepth(30);
          this.tweens.add({targets:fx, y:52, alpha:0, duration:700, onComplete:function(){ try{fx.destroy();}catch(e){}}});
        }

        // 粒子与消除动画
        var animCount=0; var total=toClear.length;
        var onOneDone=function(){ animCount++; if(animCount>=total){ finishClear.call(this); } }.bind(this);
        if(total===0){ finishClear.call(this); }
        else {
          toClear.forEach(function(o){
            var cel=this.board[o.r][o.c];
            if(o.isStone){
              // 震动后移除石头
              if(cel.stoneSprite){
                this.tweens.add({targets:cel.stoneSprite, scaleX:1.25, scaleY:1.25, alpha:0, duration:220, onComplete:function(){ try{cel.stoneSprite.destroy();}catch(e){} cel.stoneSprite=null; }});
              }
              // 延迟计入
              this.time.delayedCall(240, onOneDone);
              return;
            }
            var sp2 = cel.gem ? cel.gem.sprite : null;
            if(sp2){
              // 粒子
              this.spawnParticles(BOARD_X+o.c*CELL+CELL/2, BOARD_Y+o.r*CELL+CELL/2, GEM_COLORS[o.color]||0xffffff);
              this.tweens.add({targets:sp2, scaleX:1.35, scaleY:1.35, alpha:0, duration:210, onComplete:function(){ try{sp2.destroy();}catch(e){} }});
            } else {
              // 无宝石（仅冰被波及）
              this.spawnParticles(BOARD_X+o.c*CELL+CELL/2, BOARD_Y+o.r*CELL+CELL/2, 0x7fbfff);
            }
            this.time.delayedCall(230, onOneDone);
          },this);
        }

        function finishClear(){
          // 真正移除数据
          toClear.forEach(function(o){
            var cel=this.board[o.r][o.c];
            if(o.isStone){ cel.stone=false; if(cel.stoneSprite){ try{cel.stoneSprite.destroy();}catch(e){} cel.stoneSprite=null; } return; }
            // 冰递减
            if(cel.ice>0){
              cel.ice = Math.max(0, cel.ice-1);
              if(cel.ice>0){
                // 刷新冰显示
                if(cel.iceSprite){ try{cel.iceSprite.destroy();}catch(e){} }
                var ics=this.add.image(BOARD_X+o.c*CELL+CELL/2, BOARD_Y+o.r*CELL+CELL/2, cel.ice>=2?'ice2':'ice1'); ics.setDisplaySize(52,52); ics.setDepth(6); cel.iceSprite=ics; this.boardGroup.add(ics);
              } else {
                if(cel.iceSprite){ try{cel.iceSprite.destroy();}catch(e){} cel.iceSprite=null; }
                this.iceCleared = (this.iceCleared||0)+1;
              }
            }
            if(cel.gem){
              cel.gem=null;
            }
            // 无论如何清除选中标记由gravity重建时处理
          },this);
          // 生成保留特殊
          toKeepSpecial.forEach(function(k){
            var cel=this.board[k.r][k.c];
            // 若原格是石头则先清石头（不该发生：特殊不会生成在石头上，因为石头无匹配）
            if(cel.stone){ cel.stone=false; if(cel.stoneSprite){ try{cel.stoneSprite.destroy();}catch(e){} cel.stoneSprite=null; } }
            // 冰递减一次（特殊生成也算一次消除）
            if(cel.ice>0){
              cel.ice=Math.max(0,cel.ice-1);
              if(cel.ice===0){ if(cel.iceSprite){ try{cel.iceSprite.destroy();}catch(e){} cel.iceSprite=null; } this.iceCleared=(this.iceCleared||0)+1; }
              else { if(cel.iceSprite){ try{cel.iceSprite.destroy();}catch(e){} } var ics2=this.add.image(BOARD_X+k.c*CELL+CELL/2, BOARD_Y+k.r*CELL+CELL/2, cel.ice>=2?'ice2':'ice1'); ics2.setDisplaySize(52,52); ics2.setDepth(6); cel.iceSprite=ics2; this.boardGroup.add(ics2); }
            }
            // 旧精灵若在需销毁
            if(cel.gem && cel.gem.sprite){ try{cel.gem.sprite.destroy();}catch(e){} }
            // 创建特殊宝石
            var tex='gem'+k.color+'_'+k.type;
            var sp=this.add.image(BOARD_X+k.c*CELL+CELL/2, BOARD_Y+k.r*CELL+CELL/2, tex); sp.setDisplaySize(50,50); sp.setDepth(5);
            cel.gem={ color:k.color, special:k.type, sprite:sp };
            this.boardGroup.add(sp);
            // 生成特效
            this.spawnParticles(BOARD_X+k.c*CELL+CELL/2, BOARD_Y+k.r*CELL+CELL/2, 0xffffff);
            // 弹跳
            this.tweens.add({targets:sp, scaleX:1.25, scaleY:1.25, duration:120, yoyo:true});
          },this);
          // 剩余被清的格 gem 已置 null，无需再动
          // 清理 toClear 中未特殊但有 gem 的 sprite 已在动画销毁
          // 将 kept 以外且被清的 gem sprite 引用已销毁，数据已 null
          // 更新HUD
          this.updateHud();
          if(done) done();
        }
      }

      spawnParticles(x,y,color){
        for(var i=0;i<7;i++){
          var p=this.add.image(x,y,'particle'); p.setTint(color); p.setDepth(20); p.setAlpha(0.95);
          var ang=Math.random()*Math.PI*2, dist=18+Math.random()*28;
          var tx=x+Math.cos(ang)*dist, ty=y+Math.sin(ang)*dist;
          this.tweens.add({targets:p, x:tx, y:ty, alpha:0, scale:0.3, duration:380+Math.random()*220, onComplete:(function(pp){ return function(){ try{pp.destroy();}catch(e){}};})(p)});
        }
      }

      applyGravityAndRefill(cb){
        // 分段重力（石头为障碍分段）
        // 对每列，按段处理
        var moves=[];
        for(var c=0;c<COLS;c++){
          var segments=[]; var segStart=0;
          for(var rr=0;rr<=ROWS;rr++){
            var isStone = rr<ROWS ? this.board[rr][c].stone : true; // 末尾哨兵
            if(isStone){
              if(segStart<=rr-1) segments.push({ start:segStart, end:rr-1 });
              segStart=rr+1;
            }
          }
          segments.forEach(function(seg){
            // 收集该段内非空宝石从底到顶
            var gems=[];
            for(var r=seg.end; r>=seg.start; r--){
              var cel=this.board[r][c];
              if(cel.gem){ gems.push(cel.gem); }
            }
            // 回填到底部
            var idx=0;
            for(var r2=seg.end; r2>=seg.start; r2--){
              var cel2=this.board[r2][c];
              if(idx < gems.length){
                var g=gems[idx++];
                if(cel2.gem !== g){
                  cel2.gem=g;
                  // 记录移动用于 tween
                  moves.push({ gem:g, toR:r2, toC:c });
                }
              } else {
                cel2.gem=null;
              }
            }
          },this);
        }
        // 更新sprite位置与补新空位
        // 先将所有gem的sprite移到目标格（tween坠落）
        var tweenCount=0;
        moves.forEach(function(m){
          var tx=BOARD_X+m.toC*CELL+CELL/2, ty=BOARD_Y+m.toR*CELL+CELL/2;
          if(m.gem.sprite){
            tweenCount++;
            this.tweens.add({targets:m.gem.sprite, x:tx, y:ty, duration:220, ease:'Bounce.Out', onComplete:function(){ tweenCount--; if(tweenCount===0) afterFall.call(this); }.bind(this)});
          }
        },this);
        function afterFall(){
          // 补新：对所有空（非石头）生成新宝石
          for(var r=0;r<ROWS;r++) for(var c2=0;c2<COLS;c2++){
            var cel3=this.board[r][c2];
            if(cel3.stone) continue;
            if(!cel3.gem){
              var col=Math.floor(Math.random()*GEM_TYPES);
              var tex='gem'+col;
              var sp=this.add.image(BOARD_X+c2*CELL+CELL/2, BOARD_Y-40 - Math.random()*60, tex); sp.setDisplaySize(50,50); sp.setDepth(5); sp.setAlpha(0);
              cel3.gem={ color:col, special:null, sprite:sp };
              this.boardGroup.add(sp);
              var ty2=BOARD_Y+r*CELL+CELL/2;
              this.tweens.add({targets:sp, y:ty2, alpha:1, duration:260, ease:'Bounce.Out'});
            } else {
              // 确保纹理与 special 一致（可能之前被改变）
              var needTex='gem'+cel3.gem.color + (cel3.gem.special?'_'+cel3.gem.special:'');
              if(cel3.gem.sprite && cel3.gem.sprite.texture && cel3.gem.sprite.texture.key!==needTex){
                try{ cel3.gem.sprite.setTexture(needTex);}catch(e){}
              }
            }
            // 冰显示保持在上层：若已有iceSprite确保在最前
            if(cel3.ice>0 && !cel3.iceSprite){
              var ics=this.add.image(BOARD_X+c2*CELL+CELL/2, BOARD_Y+r*CELL+CELL/2, cel3.ice>=2?'ice2':'ice1'); ics.setDisplaySize(52,52); ics.setDepth(6); cel3.iceSprite=ics; this.boardGroup.add(ics);
            }
          }
          // 刷新所有图标深度与交互
          this.time.delayedCall(280, function(){ if(cb) cb(); }.bind(this));
        }
        if(tweenCount===0){
          afterFall.call(this);
        }
      }

      postCascadeCheck(){
        // 重置combo延迟清零（下一次玩家操作前）
        // 这里不立即清，留在下次swap前清；此处仅检查胜负
        this.updateHud();
        if(this.checkWin()){
          this.onWin();
        } else if(this.moves<=0){
          this.onLose();
        } else {
          // 若无可走步（死局），洗牌
          if(!this.hasPossibleMove()){
            this.shuffleBoard();
          }
          this.combo=0; // 本轮连击结束
          this.busy=false;
          // 提示可走
        }
      }

      checkWin(){
        var lv=LEVELS[this.stageIdx];
        if(lv.goal.type==='score'){
          return this.score >= lv.goal.target;
        } else {
          var okScore = !lv.goal.score || this.score >= lv.goal.score;
          var okCollect = lv.goal.count==null || (this.collected[lv.goal.color]||0) >= lv.goal.count;
          var okIce = lv.goal.ice==null || (this.iceCleared||0) >= lv.goal.ice;
          return okScore && okCollect && okIce;
        }
      }

      hasPossibleMove(){
        for(var r=0;r<ROWS;r++) for(var c=0;c<COLS;c++){
          if(this.board[r][c].stone) continue;
          // 尝试右、下交换虚拟检测
          var dirs=[[0,1],[1,0]];
          for(var d=0;d<dirs.length;d++){
            var nr=r+dirs[d][0], nc=c+dirs[d][1];
            if(nr<0||nr>=ROWS||nc<0||nc>=COLS) continue;
            if(this.board[nr][nc].stone) continue;
            // 虚拟交换
            var a=this.board[r][c].gem, b=this.board[nr][nc].gem;
            if(!a||!b) continue;
            // 交换颜色
            var ca=a.color, cb=b.color;
            // 快速检查是否会形成匹配：只检查涉及两格的十字
            // 交换后检查
            a.color=cb; b.color=ca;
            var has = this.wouldSwapMakeMatch(r,c,nr,nc);
            a.color=ca; b.color=cb;
            if(has) return true;
            // 若任一是特殊，也算可走（特殊单换可触发）
            if(a.special||b.special) return true;
          }
        }
        return false;
      }
      wouldSwapMakeMatch(r1,c1,r2,c2){
        // 检查以两格为中心是否形成三连
        var pts=[[r1,c1],[r2,c2]];
        for(var i=0;i<pts.length;i++){
          var r=pts[i][0], c=pts[i][1];
          var col=this.board[r][c].gem.color;
          // 横
          var cnt=1;
          for(var cc=c-1;cc>=0;cc--){ var cel=this.board[r][cc]; if(cel.stone||!cel.gem||cel.gem.color!==col) break; cnt++; }
          for(var cc2=c+1;cc2<COLS;cc2++){ var cel2=this.board[r][cc2]; if(cel2.stone||!cel2.gem||cel2.gem.color!==col) break; cnt++; }
          if(cnt>=3) return true;
          cnt=1;
          for(var rr=r-1;rr>=0;rr--){ var cel3=this.board[rr][c]; if(cel3.stone||!cel3.gem||cel3.gem.color!==col) break; cnt++; }
          for(var rr2=r+1;rr2<ROWS;rr2++){ var cel4=this.board[rr2][c]; if(cel4.stone||!cel4.gem||cel4.gem.color!==col) break; cnt++; }
          if(cnt>=3) return true;
        }
        return false;
      }

      shuffleBoard(){
        var cols=[];
        for(var r=0;r<ROWS;r++) for(var c=0;c<COLS;c++){
          var cel=this.board[r][c];
          if(cel.stone||!cel.gem) continue;
          cols.push(cel.gem.color);
        }
        // Fisher
        for(var i=cols.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var tmp=cols[i]; cols[i]=cols[j]; cols[j]=tmp; }
        var idx=0;
        for(var r2=0;r2<ROWS;r2++) for(var c2=0;c2<COLS;c2++){
          var cel2=this.board[r2][c2];
          if(cel2.stone||!cel2.gem) continue;
          cel2.gem.color=cols[idx++]; cel2.gem.special=null;
          var tex='gem'+cel2.gem.color;
          try{ cel2.gem.sprite.setTexture(tex);}catch(e){}
        }
        // 若仍无可走或有初始匹配，再次洗
        var guard=0;
        while(guard<10 && (this.findMatchesRaw().matched.size>0 || !this.hasPossibleMove())){
          for(var k=0;k<cols.length;k++){ var j2=Math.floor(Math.random()*cols.length); var t=cols[k]; cols[k]=cols[j2]; cols[j2]=t; }
          idx=0;
          for(var rr3=0;rr3<ROWS;rr3++) for(var cc3=0;cc3<COLS;cc3++){
            var cel3=this.board[rr3][cc3]; if(cel3.stone||!cel3.gem) continue;
            cel3.gem.color=cols[idx++]; cel3.gem.special=null;
            try{ cel3.gem.sprite.setTexture('gem'+cel3.gem.color);}catch(e){}
          }
          guard++;
        }
        var tip=this.add.text(W/2, H/2, '无可走步 · 已重排', {fontSize:'20px', color:'#ffd54f', fontStyle:'bold', backgroundColor:'#000000aa'}).setOrigin(0.5); tip.setDepth(50);
        this.time.delayedCall(1200, function(){ try{tip.destroy();}catch(e){}});
      }

      onWin(){
        if(this.isGameOver) return; this.isGameOver=true; this.busy=true;
        Sfx.play('win'); Sfx.stopBgm();
        if(this.score>saveData.bestScore) saveData.bestScore=this.score;
        if(this.stageIdx+1 > saveData.clearedStage) saveData.clearedStage=this.stageIdx+1;
        persist();
        var overlay=this.add.graphics(); overlay.fillStyle(0x000000,0.62); overlay.fillRect(0,0,W,H); overlay.setDepth(40);
        var t=this.add.text(W/2, H/2-36, '过关！', {fontSize:'32px', color:'#7fff7f', fontStyle:'bold'}).setOrigin(0.5); t.setDepth(41);
        var d=this.add.text(W/2, H/2+4, '分数 '+this.score+'  步数剩余 '+this.moves, {fontSize:'14px', color:'#fff'}).setOrigin(0.5); d.setDepth(41);
        var btn=this.add.graphics(); btn.fillStyle(0x2ecc71,1); btn.fillRoundedRect(W/2-90,H/2+32,180,44,10); btn.setDepth(41);
        btn.setInteractive(new Phaser.Geom.Rectangle(W/2-90,H/2+32,180,44), Phaser.Geom.Rectangle.Contains);
        var bt=this.add.text(W/2, H/2+54, this.stageIdx+1<LEVELS.length?'下一关':'返回菜单', {fontSize:'16px', color:'#fff', fontStyle:'bold'}).setOrigin(0.5); bt.setDepth(42);
        btn.on('pointerdown', function(){
          try{overlay.destroy(); t.destroy(); d.destroy(); btn.destroy(); bt.destroy();}catch(e){}
          if(this.stageIdx+1<LEVELS.length) this.startLevel(this.stageIdx+1); else this.showMenu();
        }.bind(this));
        this.uiGroup.add(overlay); this.uiGroup.add(t); this.uiGroup.add(d); this.uiGroup.add(btn); this.uiGroup.add(bt);
      }
      onLose(){
        if(this.isGameOver) return; this.isGameOver=true; this.busy=true;
        Sfx.play('lose'); Sfx.stopBgm();
        if(this.score>saveData.bestScore) saveData.bestScore=this.score; persist();
        var overlay=this.add.graphics(); overlay.fillStyle(0x000000,0.62); overlay.fillRect(0,0,W,H); overlay.setDepth(40);
        var t=this.add.text(W/2, H/2-36, '步数用尽', {fontSize:'30px', color:'#ff6b6b', fontStyle:'bold'}).setOrigin(0.5); t.setDepth(41);
        var d=this.add.text(W/2, H/2+4, '分数 '+this.score, {fontSize:'14px', color:'#fff'}).setOrigin(0.5); d.setDepth(41);
        var btn=this.add.graphics(); btn.fillStyle(0xe74c3c,1); btn.fillRoundedRect(W/2-90,H/2+32,180,44,10); btn.setDepth(41);
        btn.setInteractive(new Phaser.Geom.Rectangle(W/2-90,H/2+32,180,44), Phaser.Geom.Rectangle.Contains);
        var bt=this.add.text(W/2, H/2+54, '重玩', {fontSize:'16px', color:'#fff', fontStyle:'bold'}).setOrigin(0.5); bt.setDepth(42);
        btn.on('pointerdown', function(){
          try{overlay.destroy(); t.destroy(); d.destroy(); btn.destroy(); bt.destroy();}catch(e){}
          this.startLevel(this.stageIdx);
        }.bind(this));
        this.uiGroup.add(overlay); this.uiGroup.add(t); this.uiGroup.add(d); this.uiGroup.add(btn); this.uiGroup.add(bt);
      }
    };
  })():null;

  // ---------------------------------------------------------------------------
  // 启动 — IIFE + TRGames.register 同步注册（经典脚本，无 import）
  // ---------------------------------------------------------------------------
  function launch(host){
    hostRef=host;
    loadSave(host);
    var config={
      type: Phaser.AUTO,
      parent: host.container,
      width: W,
      height: H,
      backgroundColor:'#0f141e',
      physics:{ default:'arcade', arcade:{ gravity:{y:0}, debug:false }},
      scene:[GameScene]
    };
    var game=new Phaser.Game(config);
    // 暴露给验收：getState {scene, score, moves, board}
    var getStateBound=getState;
    window.__trgame={ game:game, getState:getStateBound, scene: function(){ return sceneRef; } };
    return game;
  }

  if(typeof window.TRGames!=='undefined' && typeof window.TRGames.register==='function'){
    window.TRGames.register({ id:'puzzle-match3', title:'三消 Puzzle Match3', launch:launch });
  } else {
    // 兜底：延迟重试（宿主后注入）
    var _t=setInterval(function(){ if(typeof window.TRGames!=='undefined'&&window.TRGames.register){ clearInterval(_t); window.TRGames.register({ id:'puzzle-match3', title:'三消 Puzzle Match3', launch:launch }); }}, 200);
    setTimeout(function(){ clearInterval(_t); }, 5000);
  }
})();
