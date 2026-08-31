// =============================================================================
// 大富翁 Monopoly v0.1.0 — 环形棋盘模拟经营
// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改：
//   视觉（本文件 buildTextures 段，中文注释“生成纹理”标出）：
//     generateTexture('tile_start'/'tile_property'/'tile_chance'/'tile_tax'/'tile_jail') 纯色几何+边框+图标
//       → 换成 this.load.image('tile_start','assets/tile_start.png') 等
//     generateTexture('pawn_p0'/'pawn_p1'/'pawn_p2') 棋子圆形+描边 → load.image
//     generateTexture('house_lv1'/'house_lv2'/'house_lv3') 房产等级小屋几何（三角形屋顶+矩形墙+星星）→ load.image
//     generateTexture('dice_bg'/'dice_dot') 骰子背景+点数 → load.image
//     generateTexture('board_bg') 棋盘背景 → load.image('board_bg','assets/board_bg.png')
//     棋盘格：Graphics 矩形描边+文字 → 换成 tileSprite 贴图
//   音频（Sfx 块，WebAudio oscillator+gain）：
//     Sfx.play('dice'/'move'/'buy'/'rent'/'bankrupt'/'win'/'jail'/'chance'/'bgm')
//       → 换成 this.load.audio('dice','assets/dice.wav') + this.sound.play('dice')
//       顶部 Sfx 块已写替换注释。
//   关卡：
//     MAPS 数组（两张地图：经典/豪宅区，不同价格与格子布局）→ 换成 this.load.json('maps','assets/maps.json')
//   存档：host.saveState { wins:number, bestWealth:number }
//   池化：骰子点动画/浮动文字/小屋精灵 复用，避免每回合 create/destroy
// =============================================================================
(function(){
'use strict';

// 顶部可调参数（带单位）—— 中文注释 + 英文 HUD
/** 单格边长 px */
var TILE_SIZE = 64;
/** 起点经过奖金 $ */
var START_BONUS = 200;
/** 初始资金 $ */
var START_MONEY = 1500;
/** 税金格固定金额 $ */
var TAX_AMOUNT = 150;
/** 税金格2金额 $ */
var TAX_AMOUNT2 = 200;
/** 掷骰动画时长 ms */
var DICE_ANIM_MS = 620;
/** 单步移动时长 ms */
var MOVE_STEP_MS = 220;
/** AI思考延迟 ms */
var AI_DELAY = 600;
/** 浮动文字时长 ms */
var FLOAT_MS = 900;

// 颜色表
var COLORS = {
  boardBg: 0x0f1e2e,
  tileStart: 0xFFD166,
  tileProperty: 0x118AB2,
  tileChance: 0xEF476F,
  tileTax: 0xFF9F1C,
  tileJail: 0x9CA3AF,
  pawn: [0x06D6A0, 0xFF6B6B, 0x4CC9F0],
  house: 0xFFBE0B,
  diceBg: 0xFFFFFF
};

// -----------------------------------------------------------------------------
// 地图定义 — 至少2张，格子布局与房产价格区分
// tile.type: start/property/chance/tax/jail
// property: price(购买价) rentBase(基础租金) houseCost(升级费)
// 租金递增：Lv0=base, Lv1=base*2, Lv2=base*4, Lv3=base*7
// -----------------------------------------------------------------------------
var MAPS = [
  {
    id: 0, name: '经典街区 Classic', bg: 0x0f172a, tileCount: 24,
    tiles: [
      { type:'start', name:'起点 START' },
      { type:'property', name:'旧城区', price:120, rentBase:18, houseCost:80, color:0xE76F51 },
      { type:'chance', name:'机会 CHANCE' },
      { type:'property', name:'花园路', price:140, rentBase:22, houseCost:90, color:0xE9C46A },
      { type:'tax', name:'所得税 TAX', amount: TAX_AMOUNT },
      { type:'property', name:'中央街', price:160, rentBase:26, houseCost:100, color:0x2A9D8F },
      { type:'chance', name:'命运 FATE' },
      { type:'property', name:'湖畔区', price:180, rentBase:30, houseCost:110, color:0x264653 },
      { type:'jail', name:'监狱 JAIL' },
      { type:'property', name:'商业街', price:200, rentBase:34, houseCost:120, color:0xF4A261 },
      { type:'chance', name:'机会 CHANCE' },
      { type:'property', name:'科技园', price:220, rentBase:38, houseCost:130, color:0x457B9D },
      { type:'tax', name:'奢侈税 LUX TAX', amount: TAX_AMOUNT2 },
      { type:'property', name:'金融区', price:240, rentBase:42, houseCost:140, color:0x6A4C93 },
      { type:'chance', name:'命运 FATE' },
      { type:'property', name:'海景湾', price:260, rentBase:46, houseCost:150, color:0x06D6A0 },
      { type:'property', name:'度假村', price:180, rentBase:30, houseCost:110, color:0x118AB2 },
      { type:'property', name:'机场路', price:200, rentBase:34, houseCost:120, color:0xFF006E },
      { type:'tax', name:'过路费 TOLL', amount: 100 },
      { type:'property', name:'大学城', price:220, rentBase:38, houseCost:130, color:0x8338EC },
      { type:'chance', name:'机会 CHANCE' },
      { type:'property', name:'博物馆', price:160, rentBase:26, houseCost:100, color:0xFB5607 },
      { type:'property', name:'体育馆', price:140, rentBase:22, houseCost:90, color:0xFFBE0B },
      { type:'property', name:'艺术区', price:180, rentBase:30, houseCost:110, color:0x3A86FF }
    ]
  },
  {
    id: 1, name: '豪宅湾 Luxury Bay', bg: 0x1a102e, tileCount: 28,
    tiles: [
      { type:'start', name:'起点 START' },
      { type:'property', name:'钻石湾', price:280, rentBase:46, houseCost:160, color:0xE76F51 },
      { type:'property', name:'翡翠岛', price:260, rentBase:42, houseCost:150, color:0xE9C46A },
      { type:'chance', name:'机会 CHANCE' },
      { type:'tax', name:'所得税 TAX', amount: 200 },
      { type:'property', name:'黄金海岸', price:320, rentBase:52, houseCost:180, color:0x2A9D8F },
      { type:'property', name:'私人码头', price:300, rentBase:48, houseCost:170, color:0x264653 },
      { type:'chance', name:'命运 FATE' },
      { type:'jail', name:'监狱 JAIL' },
      { type:'property', name:'空中花园', price:350, rentBase:58, houseCost:200, color:0xF4A261 },
      { type:'property', name:'云端塔', price:330, rentBase:54, houseCost:190, color:0x457B9D },
      { type:'chance', name:'机会 CHANCE' },
      { type:'property', name:'星光大道', price:360, rentBase:60, houseCost:210, color:0x6A4C93 },
      { type:'tax', name:'奢侈税 LUX TAX', amount: 250 },
      { type:'property', name:'皇家园林', price:380, rentBase:64, houseCost:220, color:0x06D6A0 },
      { type:'chance', name:'命运 FATE' },
      { type:'property', name:'海神殿', price:300, rentBase:48, houseCost:170, color:0x118AB2 },
      { type:'property', name:'珊瑚礁', price:280, rentBase:46, houseCost:160, color:0xFF006E },
      { type:'property', name:'游艇会', price:340, rentBase:56, houseCost:195, color:0x8338EC },
      { type:'chance', name:'机会 CHANCE' },
      { type:'property', name:'度假天堂', price:360, rentBase:60, houseCost:210, color:0xFB5607 },
      { type:'property', name:'温泉谷', price:260, rentBase:42, houseCost:150, color:0xFFBE0B },
      { type:'tax', name:'过路费 TOLL', amount: 120 },
      { type:'property', name:'滑雪场', price:320, rentBase:52, houseCost:180, color:0x3A86FF },
      { type:'property', name:'森林庄园', price:380, rentBase:64, houseCost:220, color:0x06D6A0 },
      { type:'property', name:'古堡', price:400, rentBase:68, houseCost:240, color:0x9D4EDD },
      { type:'chance', name:'命运 FATE' },
      { type:'property', name:'王座厅', price:420, rentBase:72, houseCost:250, color:0xFFD166 }
    ]
  }
];

// 机会/命运事件池
var CHANCE_EVENTS = [
  { text: '银行利息 +120', money: 120 },
  { text: '医疗账单 -150', money: -150 },
  { text: '彩票中奖 +200', money: 200 },
  { text: '车辆维修 -100', money: -100 },
  { text: '投资分红 +180', money: 180 },
  { text: '罚款 -80', money: -80 },
  { text: '奖学金 +100', money: 100 },
  { text: '前进到起点', toStart: true },
  { text: '直接进监狱', toJail: true },
  { text: '慈善捐款 -60  获得好运 +60', money: 0 },
  { text: '房屋维修 每栋 -40', perHouse: -40 },
  { text: '环游世界 +250', money: 250 }
];

function rentFor(tile, level){
  if(!tile || tile.type!=='property') return 0;
  var base=tile.rentBase||20;
  if(level===0) return base;
  if(level===1) return base*2;
  if(level===2) return base*4;
  return base*7;
}

var hostRef=null;
var sceneRef=null;
var saveData={ wins:0, bestWealth:0 };

function getState(){
  try{
    var s=sceneRef;
    if(!s || !s.curMap) return { scene:'menu', map:0, pos:[0,0,0], money:[START_MONEY,START_MONEY,START_MONEY], owned:[] };
    return {
      scene: s.phase==='gameover' ? 'gameover' : 'game',
      map: s.curMap.id,
      pos: s.pos.slice(),
      money: s.money.slice(),
      owned: s.owned.map(function(o){ return { owner:o.owner, level:o.level }; }),
      turn: s.turnIdx,
      phase: s.phase
    };
  }catch(e){ return { scene:'menu', map:0, pos:[0,0,0], money:[START_MONEY,START_MONEY,START_MONEY], owned:[] }; }
}

// -----------------------------------------------------------------------------
// 音频 — WebAudio 振荡器，后续可替换为 this.load.audio + this.sound.play
// 替换点：Sfx.play('dice'|'move'|'buy'|'rent'|'bankrupt'|'win'|'jail'|'chance'|'bgm')
//   → this.load.audio('dice','assets/dice.wav') / this.sound.play
// -----------------------------------------------------------------------------
var Sfx={ ctx:null, enabled:true, bgmTimer:null,
  ensure:function(){
    if(this.ctx) return;
    try{ var AC=window.AudioContext||window.webkitAudioContext; if(AC) this.ctx=new AC(); }catch(e){}
  },
  tone:function(freq,dur,type,vol){
    try{
      this.ensure();
      if(!this.ctx) return;
      var o=this.ctx.createOscillator(), g=this.ctx.createGain();
      o.type=type||'sine'; o.frequency.value=freq;
      g.gain.value=vol||0.18;
      o.connect(g); g.connect(this.ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime+dur);
      o.stop(this.ctx.currentTime+dur);
    }catch(e){}
  },
  play:function(name){
    if(!this.enabled) return;
    this.ensure();
    if(name==='dice'){ this.tone(520,0.08,'square',0.2); setTimeout(()=>this.tone(680,0.08,'square',0.18),90); }
    else if(name==='move'){ this.tone(440,0.07,'sine',0.15); }
    else if(name==='buy'){ this.tone(660,0.12,'sine',0.2); setTimeout(()=>this.tone(880,0.15,'sine',0.18),110); }
    else if(name==='rent'){ this.tone(220,0.18,'sawtooth',0.14); }
    else if(name==='bankrupt'){ this.tone(180,0.4,'sawtooth',0.22); setTimeout(()=>this.tone(120,0.5,'sawtooth',0.2),180); }
    else if(name==='win'){ this.tone(523,0.15,'sine',0.2); setTimeout(()=>this.tone(659,0.15,'sine',0.2),160); setTimeout(()=>this.tone(784,0.3,'sine',0.22),320); }
    else if(name==='jail'){ this.tone(150,0.3,'square',0.18); }
    else if(name==='chance'){ this.tone(600,0.1,'triangle',0.18); setTimeout(()=>this.tone(500,0.1,'triangle',0.16),120); }
    else if(name==='tax'){ this.tone(300,0.2,'triangle',0.15); }
    else if(name==='bgm'){ /* 轻量循环背景：每4秒触发一次 */ }
  },
  startBgm:function(scene){
    this.stopBgm();
    var self=this;
    function loop(){
      if(!self.enabled) return;
      self.tone(196,0.35,'sine',0.06);
      setTimeout(function(){ self.tone(246,0.35,'sine',0.05); },400);
    }
    loop();
    this.bgmTimer=setInterval(loop, 4200);
    if(scene && scene.events) scene.events.once('shutdown', function(){ self.stopBgm(); });
  },
  stopBgm:function(){ if(this.bgmTimer){ clearInterval(this.bgmTimer); this.bgmTimer=null; } }
};

function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function formatMoney(v){ return '$'+v; }

// 棋盘坐标：环形顺时针，起点在底部中间偏左，依次绕圈
function getTileXY(idx, total, ox, oy, bw, bh){
  // 将总格子按四边分配：底边(东南→西南)、左边(南→北)、顶边(西→东)、右边(北→南)
  // 为了保证 24/28 都能均分，动态计算每边数量
  var perSide;
  if(total===24){ perSide=[7,5,7,5]; } // 底、右、顶、左 (含起点，顺时针)
  else if(total===28){ perSide=[8,6,8,6]; }
  else { // 通用：尽量均分
    var base=Math.floor(total/4), rem=total%4;
    perSide=[base,base,base,base];
    for(var i=0;i<rem;i++) perSide[i]++;
  }
  // 重新定义顺时针：起点(0)在底边最左侧，然后向右为底边，向上为右边，向左为顶边，向下为左边
  // 实际布局：底边 y=bh, 顶边 y=0, 左边 x=0, 右边 x=bw
  // 我们按底(0..b-1)→右→顶→左 顺序
  var b=perSide[0], r=perSide[1], t=perSide[2], l=perSide[3];
  if(idx < b){
    // 底边：从左到右
    var bx = ox + (idx+0.5)*(bw/b);
    var by = oy + bh - TILE_SIZE/2;
    return { x:bx, y:by };
  } else if(idx < b+r){
    var j=idx-b;
    var rx = ox + bw - TILE_SIZE/2;
    var ry = oy + bh - TILE_SIZE - (j+0.5)*((bh - TILE_SIZE*2)/Math.max(1,r));
    // 若右侧只有少量，分布在中段
    return { x:rx, y:ry };
  } else if(idx < b+r+t){
    var k=idx-b-r;
    // 顶边：从右到左
    var tx = ox + bw - (k+0.5)*(bw/t);
    var ty = oy + TILE_SIZE/2;
    return { x:tx, y:ty };
  } else {
    var m=idx-b-r-t;
    var lx = ox + TILE_SIZE/2;
    var ly = oy + TILE_SIZE + (m+0.5)*((bh - TILE_SIZE*2)/Math.max(1,l));
    return { x:lx, y:ly };
  }
}

// 生成纹理 — 中文注释标出替换点
function buildTextures(scene){
  var g;
  // 顶部注释：以下所有 generateTexture 均为几何占位，后续替换为外部贴图
  // --- 生成纹理：棋盘背景 ---
  g=scene.make.graphics({x:0,y:0,add:false});
  g.fillStyle(0x0b1220,1); g.fillRoundedRect(0,0,64,64,6);
  g.lineStyle(1,0x1e293b,0.6); g.strokeRoundedRect(0,0,64,64,6);
  g.generateTexture('board_bg',64,64);

  // --- 生成纹理：各类格子 ---
  function tileTex(key, bg, stripe){
    var gg=scene.make.graphics({x:0,y:0,add:false});
    gg.fillStyle(bg,1); gg.fillRoundedRect(0,0,64,64,6);
    gg.lineStyle(2,0xffffff,0.15); gg.strokeRoundedRect(1,1,62,62,6);
    if(stripe){ gg.fillStyle(stripe,0.95); gg.fillRect(0,50,64,8); }
    // 中心图标占位：小圆
    gg.fillStyle(0xffffff,0.12); gg.fillCircle(32,26,14);
    gg.generateTexture(key,64,64);
  }
  tileTex('tile_start', 0xFFD166, 0xFF9F1C);
  tileTex('tile_property', 0x118AB2, 0x06D6A0);
  tileTex('tile_chance', 0xEF476F, 0xFF6B9D);
  tileTex('tile_tax', 0xFF9F1C, 0xE76F51);
  tileTex('tile_jail', 0x6B7280, 0x374151);

  // --- 生成纹理：棋子 ---
  for(var pi=0; pi<3; pi++){
    var pg=scene.make.graphics({x:0,y:0,add:false});
    pg.fillStyle(COLORS.pawn[pi],1); pg.fillCircle(16,16,13);
    pg.lineStyle(2,0xffffff,1); pg.strokeCircle(16,16,13);
    pg.fillStyle(0xffffff,0.9); pg.fillCircle(12,11,3);
    pg.generateTexture('pawn_p'+pi,32,32);
  }
  // --- 生成纹理：房产等级小屋 ---
  // Lv1: 单层小屋 Lv2: 双层 Lv3: 带星星的豪宅
  function houseTex(key, level){
    var hg=scene.make.graphics({x:0,y:0,add:false});
    var w=32,h=24;
    // 墙体
    hg.fillStyle(COLORS.house,1);
    if(level===1){ hg.fillRect(6,12,20,10); }
    else if(level===2){ hg.fillRect(4,10,24,12); hg.fillStyle(0xE8A800,1); hg.fillRect(4,15,24,2); }
    else { hg.fillRect(3,8,26,14); hg.fillStyle(0xE8A800,1); hg.fillRect(3,14,26,2); }
    // 屋顶三角形
    hg.fillStyle(0xC0392B,1);
    if(level===1){ hg.fillTriangle(16,4, 4,12, 28,12); }
    else if(level===2){ hg.fillTriangle(16,2, 2,10, 30,10); }
    else { hg.fillTriangle(16,1, 1,8, 31,8);
      // 星星装饰
      hg.fillStyle(0xFFFFFF,1); hg.fillStar(26,4, 4, 5, 2.5, 0xffffff);
      hg.fillStar(6,4, 4, 5, 2.5, 0xffffff);
    }
    // 门窗
    hg.fillStyle(0x5D4037,1); hg.fillRect(13,16,6,6);
    hg.generateTexture(key,32,24);
  }
  houseTex('house_lv1',1); houseTex('house_lv2',2); houseTex('house_lv3',3);

  // --- 生成纹理：骰子 ---
  var dg=scene.make.graphics({x:0,y:0,add:false});
  dg.fillStyle(0xffffff,1); dg.fillRoundedRect(0,0,56,56,8);
  dg.lineStyle(2,0x1e293b,1); dg.strokeRoundedRect(0,0,56,56,8);
  dg.generateTexture('dice_bg',56,56);
  var dotg=scene.make.graphics({x:0,y:0,add:false});
  dotg.fillStyle(0x1e293b,1); dotg.fillCircle(6,6,6);
  dotg.generateTexture('dice_dot',12,12);

  // --- 生成纹理：按钮高光 ---
  var bg2=scene.make.graphics({x:0,y:0,add:false});
  bg2.fillStyle(0x1e293b,0.85); bg2.fillRoundedRect(0,0,120,36,8);
  bg2.generateTexture('btn_bg',120,36);
}

function launch(host){
  var Phaser=host.phaser;
  if(!Phaser) throw new Error('Phaser not loaded');
  hostRef=host;

  // ---------------------------------------------------------------------------
  // BootScene — 生成纹理、读档
  // ---------------------------------------------------------------------------
  var BootScene = class extends Phaser.Scene {
    constructor(){ super({key:'Boot'}); }
    create(){
      buildTextures(this);
      var self=this;
      var done=function(){
        self.scene.start('Menu');
      };
      if(hostRef && typeof hostRef.loadState==='function'){
        try{
          hostRef.loadState().then(function(d){
            if(d){
              if(typeof d.wins==='number') saveData.wins=d.wins;
              if(typeof d.bestWealth==='number') saveData.bestWealth=d.bestWealth;
            }
            done();
          }, function(){ done(); });
        }catch(e){ done(); }
      } else { done(); }
    }
  };

  // ---------------------------------------------------------------------------
  // MenuScene — 地图选择 + 人数选择 + 开始
  // ---------------------------------------------------------------------------
  var MenuScene = class extends Phaser.Scene {
    constructor(){ super({key:'Menu'}); }
    create(){
      sceneRef=this;
      this.cameras.main.setBackgroundColor('#0b1220');
      var w=this.cameras.main.width, h=this.cameras.main.height;
      var curMapIdx=0;
      var playerCount=2; // 2=1vs1AI, 3=1vs2AI

      var title=this.add.text(w/2, 36, '大富翁 MONOPOLY', { fontFamily:'monospace', fontSize:'22px', color:'#FFD166' }).setOrigin(0.5,0.5);
      this.add.text(w/2, 56, 'Classic Board Tycoon  ·  2 Maps  ·  3 Levels Rent', { fontFamily:'monospace', fontSize:'10px', color:'#8b949e' }).setOrigin(0.5,0.5);

      var bestLine=this.add.text(w/2, 76, 'Wins: '+saveData.wins+'   Best Wealth: $'+saveData.bestWealth, { fontFamily:'monospace', fontSize:'11px', color:'#06D6A0' }).setOrigin(0.5,0.5);

      // 地图选择
      var mapTitle=this.add.text(w/2, 102, '', { fontFamily:'monospace', fontSize:'13px', color:'#e8e8e8', align:'center' }).setOrigin(0.5,0.5);
      var mapInfo=this.add.text(w/2, 122, '', { fontFamily:'monospace', fontSize:'10px', color:'#8b949e', align:'center' }).setOrigin(0.5,0.5);
      function refreshMap(){
        var m=MAPS[curMapIdx];
        mapTitle.setText('地图 Map: '+m.name+'  ('+m.tiles.length+'格)');
        var propCount=m.tiles.filter(function(t){return t.type==='property';}).length;
        mapInfo.setText(propCount+' 处房产  ·  起点奖金 $'+START_BONUS+'  ·  房产均价 $'+Math.round(m.tiles.filter(function(t){return t.type==='property';}).reduce(function(s,t){return s+t.price;},0)/propCount));
      }
      refreshMap();

      var btnPrev=this.add.text(w/2-110, 148, '◀ 上一张', { fontFamily:'monospace', fontSize:'12px', color:'#e8e8e8', backgroundColor:'#1a2332', padding:{x:10,y:6} }).setOrigin(0.5,0.5).setInteractive({useHandCursor:true});
      var btnNext=this.add.text(w/2+110, 148, '下一张 ▶', { fontFamily:'monospace', fontSize:'12px', color:'#e8e8e8', backgroundColor:'#1a2332', padding:{x:10,y:6} }).setOrigin(0.5,0.5).setInteractive({useHandCursor:true});
      btnPrev.on('pointerdown', function(){ Sfx.play('move'); curMapIdx=(curMapIdx-1+MAPS.length)%MAPS.length; refreshMap(); refreshPreview(); });
      btnNext.on('pointerdown', function(){ Sfx.play('move'); curMapIdx=(curMapIdx+1)%MAPS.length; refreshMap(); refreshPreview(); });

      // 人数选择
      var pcTitle=this.add.text(w/2, 182, '', { fontFamily:'monospace', fontSize:'11px', color:'#8b949e' }).setOrigin(0.5,0.5);
      var btn2p=this.add.text(w/2-56, 206, '1 vs 1 AI', { fontFamily:'monospace', fontSize:'12px', color:'#e8e8e8', backgroundColor:'#1f6feb', padding:{x:10,y:6} }).setOrigin(0.5,0.5).setInteractive({useHandCursor:true});
      var btn3p=this.add.text(w/2+56, 206, '1 vs 2 AI', { fontFamily:'monospace', fontSize:'12px', color:'#e8e8e8', backgroundColor:'#1a2332', padding:{x:10,y:6} }).setOrigin(0.5,0.5).setInteractive({useHandCursor:true});
      function refreshPC(){
        pcTitle.setText(playerCount===2 ? '2人局 (你 + 1 AI)' : '3人局 (你 + 2 AI)');
        btn2p.setBackgroundColor(playerCount===2 ? '#1f6feb' : '#1a2332');
        btn3p.setBackgroundColor(playerCount===3 ? '#1f6feb' : '#1a2332');
      }
      refreshPC();
      btn2p.on('pointerdown', function(){ Sfx.play('move'); playerCount=2; refreshPC(); });
      btn3p.on('pointerdown', function(){ Sfx.play('move'); playerCount=3; refreshPC(); });

      // 预览条
      var previewG=this.add.graphics();
      var previewTexts=[];
      function refreshPreview(){
        previewG.clear();
        previewTexts.forEach(function(t){ try{ t.destroy(); }catch(e){} });
        previewTexts=[];
        var m=MAPS[curMapIdx];
        var px= w/2 - 220, py= 240;
        var cellW= 440 / m.tiles.length;
        // 背景条
        previewG.fillStyle(0x1e293b,1); previewG.fillRoundedRect(px, py, 440, 28, 6);
        for(var i=0;i<m.tiles.length;i++){
          var t=m.tiles[i];
          var cx=px + i*cellW + cellW/2;
          var col=0x118AB2;
          if(t.type==='start') col=0xFFD166;
          else if(t.type==='chance') col=0xEF476F;
          else if(t.type==='tax') col=0xFF9F1C;
          else if(t.type==='jail') col=0x9CA3AF;
          else if(t.type==='property') col=t.color||0x118AB2;
          previewG.fillStyle(col,1); previewG.fillCircle(cx, py+14, 7);
          if(t.type==='property'){
            var lvDot=previewG;
          }
        }
        var legend=['▣房产','#FFD166起点','#EF476F机会','#FF9F1C税','#9CA3AF监狱'];
      }
      refreshPreview();

      // 开始按钮
      var startBtn=this.add.text(w/2, 300, '掷骰开始 ROLL ▶', { fontFamily:'monospace', fontSize:'16px', color:'#ffffff', backgroundColor:'#238636', padding:{x:18,y:10} }).setOrigin(0.5,0.5).setInteractive({useHandCursor:true});
      var keyR=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
      var keyEnter=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
      var keyZ=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Z);
      var self=this;
      function doStart(){
        Sfx.ensure(); Sfx.play('dice');
        self.scene.start('Game', { mapIdx: curMapIdx, playerCount: playerCount });
      }
      startBtn.on('pointerdown', doStart);
      this._doStart=doStart;
      this._keyR=keyR; this._keyEnter=keyEnter; this._keyZ=keyZ;

      // 说明
      this.add.text(w/2, 350, '骰子1-6走格  房产3级租金递增  机会/税/监狱  破产淘汰  最后一人胜', { fontFamily:'monospace', fontSize:'9px', color:'#484f58' }).setOrigin(0.5,0.5);
      this.add.text(w/2, 365, '操作: SPACE/点击 ROLL  Buy/Upgrade/Pass  R重开  M回菜单  1/2切图', { fontFamily:'monospace', fontSize:'9px', color:'#484f58' }).setOrigin(0.5,0.5);
    }
    update(){
      if(this._keyR && Phaser.Input.Keyboard.JustDown(this._keyR)) this._doStart();
      if(this._keyEnter && Phaser.Input.Keyboard.JustDown(this._keyEnter)) this._doStart();
      if(this._keyZ && Phaser.Input.Keyboard.JustDown(this._keyZ)) this._doStart();
    }
  };

  // ---------------------------------------------------------------------------
  // GameScene — 核心对局
  // ---------------------------------------------------------------------------
  var GameScene = class extends Phaser.Scene {
    constructor(){ super({key:'Game'}); }
    init(data){
      this.mapIdx = (data && typeof data.mapIdx==='number') ? data.mapIdx : 0;
      this.playerCount = (data && typeof data.playerCount==='number') ? data.playerCount : 2;
      this.curMap = MAPS[this.mapIdx] || MAPS[0];
      this.tileCount = this.curMap.tiles.length;
      this.pos = []; // 每人位置 0..tileCount-1
      this.money = [];
      this.owned = []; // per tile: {owner:-1, level:0}
      this.alive = [];
      this.jailTurns = [];
      this.turnIdx = 0;
      this.phase = 'roll'; // roll,moving,decision,chance,gameover
      this.diceVal = 1;
      this.isMoving = false;
      this.winner = -1;
      this._aiTimer = 0;
      this._diceRolling = false;
      for(var i=0;i<this.playerCount;i++){ this.pos.push(0); this.money.push(START_MONEY); this.alive.push(true); this.jailTurns.push(0); }
      for(var j=0;j<this.tileCount;j++){ this.owned.push({ owner:-1, level:0 }); }
    }
    create(){
      sceneRef=this;
      this.phase='roll';
      this.cameras.main.setBackgroundColor('#0b1220');
      var W=this.cameras.main.width, H=this.cameras.main.height;
      this.W=W; this.H=H;

      // 棋盘区域
      this.boardX= 16;
      this.boardY= 44;
      this.boardW= 620;
      this.boardH= 420;

      // 状态
      this.phase='roll';
      this.isMoving=false;
      this.turnIdx=0;
      this._aiTimer=0;

      // --- 背景 ---
      this.add.rectangle(W/2, H/2, W, H, 0x0b1220);
      // 棋盘底板
      this.boardBg=this.add.rectangle(this.boardX+this.boardW/2, this.boardY+this.boardH/2, this.boardW, this.boardH, 0x111c2e);
      this.boardBg.setStrokeStyle(2, 0x1e293b);

      // 格子容器
      this.tilesG=[];
      this.tileLabels=[];
      this.tilePriceLabels=[];
      this.houseSprites=[]; // per tile house sprite
      for(var i=0;i<this.tileCount;i++){
        var coord=getTileXY(i, this.tileCount, this.boardX, this.boardY, this.boardW, this.boardH);
        var tile=this.curMap.tiles[i];
        var key='tile_property';
        if(tile.type==='start') key='tile_start';
        else if(tile.type==='chance') key='tile_chance';
        else if(tile.type==='tax') key='tile_tax';
        else if(tile.type==='jail') key='tile_jail';
        var sz=TILE_SIZE;
        // 小图时缩
        if(this.tileCount>=28) sz=52;
        var img=this.add.image(coord.x, coord.y, key);
        img.setDisplaySize(sz, sz);
        img.setDepth(1);
        this.tilesG.push(img);
        // 名称
        var label=this.add.text(coord.x, coord.y-6, (tile.name||'') , { fontFamily:'monospace', fontSize: (sz>=60?'7px':'6px'), color:'#ffffff', align:'center', wordWrap:{width:sz-4} }).setOrigin(0.5,0.5).setDepth(2);
        label.setLineSpacing(-2);
        this.tileLabels.push(label);
        // 价格/租金
        if(tile.type==='property'){
          var pl=this.add.text(coord.x, coord.y+18, '$'+tile.price+'→'+tile.rentBase, { fontFamily:'monospace', fontSize:'7px', color:'#FFD166', align:'center' }).setOrigin(0.5,0.5).setDepth(2);
          this.tilePriceLabels.push(pl);
        } else {
          this.tilePriceLabels.push(null);
        }
        // 小屋占位（隐藏，购买后显示）
        var hs=this.add.image(coord.x, coord.y-24, 'house_lv1').setDepth(3).setVisible(false).setScale(0.7);
        this.houseSprites.push(hs);
      }

      // 棋子 — 池化，每个玩家一个 image，叠放偏移
      this.pawns=[];
      for(var pi=0; pi<this.playerCount; pi++){
        var c0=getTileXY(0, this.tileCount, this.boardX, this.boardY, this.boardW, this.boardH);
        var offsetX=(pi-1)*10;
        var offsetY=(pi===1?6:(pi===2?-6:0));
        var pawn=this.add.image(c0.x+offsetX, c0.y+12+offsetY, 'pawn_p'+pi).setDepth(10).setScale(0.85);
        // 玩家标签
        var tag=this.add.text(c0.x+offsetX, c0.y+28+offsetY, 'P'+(pi+1), { fontFamily:'monospace', fontSize:'7px', color:'#ffffff', backgroundColor: Phaser.Display.Color.IntegerToColor(COLORS.pawn[pi]).rgba }).setOrigin(0.5,0.5).setDepth(11);
        pawn._tag=tag;
        pawn._pi=pi;
        this.pawns.push(pawn);
      }

      // --- 右侧面板 ---
      var panelX = this.boardX+this.boardW+12;
      var panelW = W - panelX - 12;

      // 顶部信息
      this.infoBg=this.add.rectangle(panelX+panelW/2, 30, panelW, 36, 0x1a2332).setStrokeStyle(1, 0x334155);
      this.turnText=this.add.text(panelX+panelW/2, 22, '', { fontFamily:'monospace', fontSize:'11px', color:'#FFD166', align:'center' }).setOrigin(0.5,0.5);
      this.phaseText=this.add.text(panelX+panelW/2, 36, '', { fontFamily:'monospace', fontSize:'9px', color:'#8b949e', align:'center' }).setOrigin(0.5,0.5);

      // 骰子区
      this.diceBg=this.add.image(panelX+panelW/2, 74, 'dice_bg').setScale(0.85);
      this.diceText=this.add.text(panelX+panelW/2, 74, '1', { fontFamily:'monospace', fontSize:'22px', color:'#1e293b' }).setOrigin(0.5,0.5);
      // 点数容器
      this.diceDots=[];
      for(var di=0; di<6; di++){
        var dot=this.add.image(0,0,'dice_dot').setVisible(false).setScale(0.6);
        this.diceDots.push(dot);
      }

      // ROLL 按钮
      this.rollBtn=this.add.text(panelX+panelW/2, 118, 'ROLL 🎲', { fontFamily:'monospace', fontSize:'13px', color:'#ffffff', backgroundColor:'#238636', padding:{x:14,y:7} }).setOrigin(0.5,0.5).setInteractive({useHandCursor:true});
      this.rollBtn.on('pointerdown', ()=>{ if(this.phase==='roll' && this.turnIdx===0 && !this.isMoving) this.doRoll(); });

      // 事件/消息行
      this.msgBg=this.add.rectangle(panelX+panelW/2, 150, panelW, 28, 0x0f172a).setStrokeStyle(1, 0x1e293b);
      this.msgText=this.add.text(panelX+panelW/2, 150, '掷骰开始！', { fontFamily:'monospace', fontSize:'9px', color:'#e8e8e8', align:'center', wordWrap:{width:panelW-12} }).setOrigin(0.5,0.5);

      // 房产操作按钮（购买/升级/跳过）
      this.actionRowY=178;
      this.btnBuy=this.add.text(panelX+16, this.actionRowY, '购买 BUY', { fontFamily:'monospace', fontSize:'10px', color:'#ffffff', backgroundColor:'#1f6feb', padding:{x:8,y:6} }).setOrigin(0,0.5).setInteractive({useHandCursor:true}).setVisible(false);
      this.btnUpgrade=this.add.text(panelX+16, this.actionRowY, '升级 UP', { fontFamily:'monospace', fontSize:'10px', color:'#ffffff', backgroundColor:'#9D4EDD', padding:{x:8,y:6} }).setOrigin(0,0.5).setInteractive({useHandCursor:true}).setVisible(false);
      this.btnPass=this.add.text(panelX+panelW-16, this.actionRowY, '跳过 PASS', { fontFamily:'monospace', fontSize:'10px', color:'#e8e8e8', backgroundColor:'#334155', padding:{x:8,y:6} }).setOrigin(1,0.5).setInteractive({useHandCursor:true}).setVisible(false);
      this.btnBuy.on('pointerdown', ()=> this.doBuy());
      this.btnUpgrade.on('pointerdown', ()=> this.doUpgrade());
      this.btnPass.on('pointerdown', ()=> this.doPass());

      // 玩家资金面板
      this.playerRows=[];
      for(var ri=0; ri<this.playerCount; ri++){
        var ry= 210 + ri*58;
        var rowBg=this.add.rectangle(panelX+panelW/2, ry, panelW, 52, ri===0?0x1a2332:0x151e30).setStrokeStyle(1, ri===0?0x238636:0x334155);
        var dotColor=Phaser.Display.Color.IntegerToColor(COLORS.pawn[ri]).rgba;
        var dotG=this.add.circle(panelX+14, ry-10, 6, COLORS.pawn[ri]);
        var nameTx=this.add.text(panelX+26, ry-14, (ri===0?'你 YOU':'AI '+(ri))+'  P'+(ri+1), { fontFamily:'monospace', fontSize:'10px', color:'#e8e8e8' }).setOrigin(0,0.5);
        var moneyTx=this.add.text(panelX+26, ry+2, '$'+this.money[ri], { fontFamily:'monospace', fontSize:'11px', color:'#06D6A0' }).setOrigin(0,0.5);
        var posTx=this.add.text(panelX+panelW-10, ry-10, '格'+this.pos[ri], { fontFamily:'monospace', fontSize:'9px', color:'#8b949e' }).setOrigin(1,0.5);
        var propTx=this.add.text(panelX+26, ry+16, '房产:0  Lv:0', { fontFamily:'monospace', fontSize:'8px', color:'#8b949e' }).setOrigin(0,0.5);
        var statusTx=this.add.text(panelX+panelW-10, ry+16, '', { fontFamily:'monospace', fontSize:'8px', color:'#FF6B6B' }).setOrigin(1,0.5);
        this.playerRows.push({ bg:rowBg, moneyTx:moneyTx, posTx:posTx, propTx:propTx, statusTx:statusTx, dot:dotG, nameTx:nameTx });
      }

      // 底部操作提示
      this.hintText=this.add.text(panelX+panelW/2, H-14, 'SPACE=掷骰  R=重开  M=菜单  1/2切图', { fontFamily:'monospace', fontSize:'8px', color:'#484f58' }).setOrigin(0.5,0.5);

      // 浮动文字池
      this.floatPool=[];

      // 键盘
      this.keyRoll=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
      this.keyR=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
      this.keyM=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M);
      this.keyOne=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
      this.keyTwo=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);

      this.updateHud();
      this.refreshHouses();
      this.refreshTurnHighlight();
      if(this.turnIdx!==0){
        this.phase='roll';
        this.updateHud();
      }
      Sfx.startBgm(this);
    }

    showFloat(x,y,text,color){
      var t=this.add.text(x, y, text, { fontFamily:'monospace', fontSize:'12px', color:color||'#FFD166', stroke:'#000000', strokeThickness:2 }).setOrigin(0.5,0.5).setDepth(20);
      this.tweens.add({ targets:t, y: y-28, alpha:0, duration: FLOAT_MS, ease:'Cubic.easeOut', onComplete:()=>{ try{ t.destroy(); }catch(e){} } });
    }

    // HUD
    updateHud(){
      var curP=this.turnIdx+1;
      var isHumanTurn=this.turnIdx===0;
      var phaseMap={ roll:'掷骰', moving:'移动中', decision:'选择', chance:'事件', gameover:'结束' };
      this.turnText.setText('回合 P'+curP+(isHumanTurn?' (你)':'(AI)')+'  $'+this.money[this.turnIdx]);
      this.phaseText.setText(phaseMap[this.phase]||this.phase);
      // roll按钮可用性
      var canRoll=this.phase==='roll' && this.turnIdx===0 && !this.isMoving && this.alive[this.turnIdx] && this.phase!=='gameover';
      this.rollBtn.setAlpha(canRoll?1:0.45);
      // 资金行
      for(var i=0;i<this.playerCount;i++){
        var row=this.playerRows[i];
        row.moneyTx.setText('$'+this.money[i]);
        row.posTx.setText('格'+this.pos[i]+'/'+this.tileCount);
        var ownedCount=0, totalLv=0;
        for(var k=0;k<this.tileCount;k++){ if(this.owned[k].owner===i){ ownedCount++; totalLv+=this.owned[k].level; } }
        row.propTx.setText('房产:'+ownedCount+'  Lv合计:'+totalLv);
        if(!this.alive[i]){ row.statusTx.setText('破产'); row.statusTx.setColor('#FF6B6B'); }
        else if(this.jailTurns[i]>0){ row.statusTx.setText('监狱'+this.jailTurns[i]); row.statusTx.setColor('#9CA3AF'); }
        else if(i===this.turnIdx && this.phase!=='gameover'){ row.statusTx.setText('● 行动中'); row.statusTx.setColor('#FFD166'); }
        else { row.statusTx.setText(this.alive[i]?'':''); }
      }
      this.refreshTurnHighlight();
    }

    refreshTurnHighlight(){
      for(var i=0;i<this.playerCount;i++){
        var row=this.playerRows[i];
        var isTurn=i===this.turnIdx && this.phase!=='gameover';
        row.bg.setStrokeStyle(1, isTurn?0xFFD166:(i===0?0x238636:0x334155));
      }
    }

    refreshHouses(){
      for(var i=0;i<this.tileCount;i++){
        var hs=this.houseSprites[i];
        var own=this.owned[i];
        if(own.owner>=0 && own.level>0){
          hs.setVisible(true);
          hs.setTexture('house_lv'+own.level);
          hs.setTint(COLORS.pawn[own.owner]);
        } else if(own.owner>=0){
          // 已购买但未升级：显示小点
          hs.setVisible(true);
          hs.setTexture('house_lv1');
          hs.setTint(COLORS.pawn[own.owner]);
          hs.setAlpha(0.55);
        } else {
          hs.setVisible(false);
          hs.setAlpha(1);
        }
      }
    }

    // 骰子点数布局（3x3格）
    renderDiceDots(val){
      var cx=this.diceBg.x, cy=this.diceBg.y;
      var off=14;
      var positions=[
        [], //0
        [[0,0]],
        [[-off,-off],[off,off]],
        [[-off,-off],[0,0],[off,off]],
        [[-off,-off],[-off,off],[off,-off],[off,off]],
        [[-off,-off],[-off,off],[0,0],[off,-off],[off,off]],
        [[-off,-off],[-off,0],[-off,off],[off,-off],[off,0],[off,off]]
      ];
      var pts=positions[val]||[];
      for(var i=0;i<this.diceDots.length;i++){
        var d=this.diceDots[i];
        if(i<pts.length){
          d.setPosition(cx+pts[i][0], cy+pts[i][1]);
          d.setVisible(true).setDepth(6);
        } else d.setVisible(false);
      }
      this.diceText.setVisible(false);
    }

    // 掷骰
    doRoll(){
      if(this.phase!=='roll' || this.isMoving) return;
      if(this._diceRolling) return;
      this._diceRolling=true;
      Sfx.play('dice');
      var self=this;
      var start=Date.now();
      var tick=0;
      var intv=setInterval(function(){
        tick++;
        var fake=1+Math.floor(Math.random()*6);
        self.renderDiceDots(fake);
        if(Date.now()-start >= DICE_ANIM_MS){
          clearInterval(intv);
          var val=1+Math.floor(Math.random()*6);
          self.diceVal=val;
          self.renderDiceDots(val);
          self._diceRolling=false;
          self.startMove(val);
        }
      }, 70);
    }

    startMove(steps){
      this.phase='moving';
      this.isMoving=true;
      this.updateHud();
      this.hideDecision();
      var self=this;
      var cur=this.pos[this.turnIdx];
      var total=this.tileCount;
      var seq=[];
      for(var s=1;s<=steps;s++) seq.push((cur+s)%total);
      var idx=0;
      function step(){
        if(idx>=seq.length){
          self.isMoving=false;
          self.onLand();
          return;
        }
        var next=seq[idx];
        var from=self.pos[self.turnIdx];
        // 经过起点奖金（跨越 0 点）
        var willPassStart=false;
        if(from+1 >= total && next===0) willPassStart=true;
        if(from < next && next===0) willPassStart=true; // 已处理
        // 通用经过起点判定：from+1..from+steps 是否跨越 total
        // 简化：若 next < from 且 from!==next，则跨越
        if(next < from) willPassStart=true;
        // 但只有跨越起点格才给奖（起点为0）
        // 上述 next<from 即跨越环
        if(willPassStart && next===0){
          // 给奖时会在最后一步后处理；此处也可即时
        }
        // tween 移动
        var coord=getTileXY(next, total, self.boardX, self.boardY, self.boardW, self.boardH);
        var pawn=self.pawns[self.turnIdx];
        var offX=(self.turnIdx-1)*10;
        var offY=(self.turnIdx===1?6:(self.turnIdx===2?-6:0));
        self.tweens.add({
          targets: pawn,
          x: coord.x+offX,
          y: coord.y+12+offY,
          duration: MOVE_STEP_MS,
          ease: 'Sine.easeInOut',
          onComplete: function(){
            // 同步标签
            try{ pawn._tag.setPosition(coord.x+offX, coord.y+28+offY); }catch(e){}
            Sfx.play('move');
            // 经过起点即时奖励（每跨越一次）
            if(willPassStart){
              self.money[self.turnIdx]+=START_BONUS;
              self.showFloat(coord.x, coord.y-36, '+$'+START_BONUS+' 起点奖金', '#06D6A0');
              Sfx.play('buy');
            }
            self.pos[self.turnIdx]=next;
            self.updateHud();
            idx++;
            // 额外小延迟再下一步
            self.time.delayedCall(60, step);
          }
        });
      }
      step();
    }

    onLand(){
      var idx=this.pos[this.turnIdx];
      var tile=this.curMap.tiles[idx];
      var pid=this.turnIdx;
      if(tile.type==='property'){
        var own=this.owned[idx];
        if(own.owner===-1){
          // 无主：可买
          this.showDecision('buy', tile, idx);
        } else if(own.owner===pid){
          // 自己的：可升级
          if(own.level<3){
            var cost=tile.houseCost;
            if(this.money[pid]>=cost) this.showDecision('upgrade', tile, idx);
            else { this.msgText.setText('房产 Lv'+own.level+'  升级需 $'+cost+' 资金不足'); this.time.delayedCall(900, ()=> this.nextTurn()); }
          } else {
            this.msgText.setText('已满级 Lv3'); this.time.delayedCall(800, ()=> this.nextTurn());
          }
        } else {
          // 他人的：收租
          var rent=rentFor(tile, own.level);
          this.payRent(pid, own.owner, rent, idx);
        }
      } else if(tile.type==='chance'){
        this.doChance();
      } else if(tile.type==='tax'){
        var tax=tile.amount||TAX_AMOUNT;
        this.payTax(pid, tax);
      } else if(tile.type==='jail'){
        this.jailTurns[pid]=1;
        this.msgText.setText('入狱！下回合停掷');
        Sfx.play('jail');
        this.showFloat(this.pawns[pid].x, this.pawns[pid].y-40, '监狱', '#9CA3AF');
        this.time.delayedCall(900, ()=> this.nextTurn());
      } else if(tile.type==='start'){
        this.msgText.setText('起点！');
        this.time.delayedCall(700, ()=> this.nextTurn());
      } else {
        this.time.delayedCall(600, ()=> this.nextTurn());
      }
      this.updateHud();
    }

    showDecision(kind, tile, idx){
      var pid=this.turnIdx;
      var isHuman=pid===0;
      if(kind==='buy'){
        this.msgText.setText(tile.name+'  售价 $'+tile.price+'  租金 $'+tile.rentBase+'  升级 $'+tile.houseCost);
        if(isHuman){
          this.phase='decision';
          this.pendingDecision={ kind:'buy', idx:idx, price:tile.price };
          this.btnBuy.setText('购买 $'+tile.price).setVisible(true);
          this.btnPass.setVisible(true);
          this.btnUpgrade.setVisible(false);
          this.updateHud();
        } else {
          // AI：有钱就买（超过价格+保留200）
          var self=this;
          this.time.delayedCall(AI_DELAY, function(){
            if(self.money[pid] >= tile.price + 150) self.doBuy();
            else self.doPass();
          });
        }
      } else if(kind==='upgrade'){
        this.msgText.setText(tile.name+' Lv'+this.owned[idx].level+'→'+(this.owned[idx].level+1)+'  费用 $'+tile.houseCost+'  新租金 $'+rentFor(tile, this.owned[idx].level+1));
        if(isHuman){
          this.phase='decision';
          this.pendingDecision={ kind:'upgrade', idx:idx, cost:tile.houseCost };
          this.btnUpgrade.setText('升级 $'+tile.houseCost).setVisible(true);
          this.btnPass.setVisible(true);
          this.btnBuy.setVisible(false);
          this.updateHud();
        } else {
          var self2=this;
          this.time.delayedCall(AI_DELAY, function(){
            if(self2.money[pid] >= tile.houseCost + 120) self2.doUpgrade();
            else self2.doPass();
          });
        }
      }
    }

    hideDecision(){
      this.btnBuy.setVisible(false);
      this.btnUpgrade.setVisible(false);
      this.btnPass.setVisible(false);
      this.pendingDecision=null;
    }

    doBuy(){
      if(this.phase!=='decision' && this.turnIdx!==0) {
        // AI路径：phase可能仍为moving后的decision等待，此处允许
      }
      var d=this.pendingDecision;
      // AI调用时可能未设 pending，用当前位置推导
      if(!d){
        var curIdx=this.pos[this.turnIdx];
        var t=this.curMap.tiles[curIdx];
        if(t.type==='property' && this.owned[curIdx].owner===-1) d={ kind:'buy', idx:curIdx, price:t.price };
        else return;
      }
      if(d.kind!=='buy') return;
      var pid=this.turnIdx;
      var price=d.price;
      if(this.money[pid] < price){ this.msgText.setText('资金不足 $'+price); this.hideDecision(); this.nextTurn(); return; }
      this.money[pid]-=price;
      this.owned[d.idx].owner=pid;
      this.owned[d.idx].level=0;
      Sfx.play('buy');
      this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, '购入! -$'+price, '#FFD166');
      this.msgText.setText('购入 '+this.curMap.tiles[d.idx].name+'！');
      this.hideDecision();
      this.refreshHouses();
      this.updateHud();
      this.time.delayedCall(700, ()=> this.nextTurn());
    }

    doUpgrade(){
      var d=this.pendingDecision;
      if(!d){
        var curIdx2=this.pos[this.turnIdx];
        var t2=this.curMap.tiles[curIdx2];
        if(t2.type==='property' && this.owned[curIdx2].owner===this.turnIdx && this.owned[curIdx2].level<3) d={ kind:'upgrade', idx:curIdx2, cost:t2.houseCost };
        else return;
      }
      if(d.kind!=='upgrade') return;
      var pid=this.turnIdx;
      var cost=d.cost;
      if(this.money[pid] < cost){ this.msgText.setText('资金不足 $'+cost); this.hideDecision(); this.nextTurn(); return; }
      this.money[pid]-=cost;
      this.owned[d.idx].level++;
      Sfx.play('buy');
      this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, '升级 Lv'+this.owned[d.idx].level+'! -$'+cost, '#9D4EDD');
      this.msgText.setText('升级到 Lv'+this.owned[d.idx].level+'  租金 $'+rentFor(this.curMap.tiles[d.idx], this.owned[d.idx].level));
      this.hideDecision();
      this.refreshHouses();
      this.updateHud();
      this.time.delayedCall(700, ()=> this.nextTurn());
    }

    doPass(){
      this.hideDecision();
      this.msgText.setText('跳过');
      this.time.delayedCall(500, ()=> this.nextTurn());
    }

    payRent(payer, owner, amount, tileIdx){
      if(this.money[payer] < amount){
        // 破产：全部房产归还，标记死亡
        var pay=Math.max(0, this.money[payer]);
        this.money[owner]+=pay;
        this.money[payer]=0;
        this.doBankrupt(payer);
        this.showFloat(this.pawns[payer].x, this.pawns[payer].y-36, '破产! 付 $'+pay+'/'+amount, '#FF6B6B');
        Sfx.play('bankrupt');
        this.msgText.setText('P'+(payer+1)+' 无力支付 $'+amount+' 破产！');
      } else {
        this.money[payer]-=amount;
        this.money[owner]+=amount;
        Sfx.play('rent');
        this.showFloat(this.pawns[owner].x, this.pawns[owner].y-36, '+$'+amount+' 租金', '#06D6A0');
        this.showFloat(this.pawns[payer].x, this.pawns[payer].y-36, '-$'+amount+' 租金', '#FF6B6B');
        this.msgText.setText('P'+(payer+1)+' 支付租金 $'+amount+' 给 P'+(owner+1)+' (Lv'+this.owned[tileIdx].level+')');
      }
      this.updateHud();
      this.time.delayedCall(1100, ()=> this.nextTurn());
    }

    payTax(pid, amount){
      if(this.money[pid] < amount){
        var pay=Math.max(0, this.money[pid]);
        this.money[pid]=0;
        this.doBankrupt(pid);
        Sfx.play('bankrupt');
        this.msgText.setText('税金 $'+amount+' 无力支付 破产！');
        this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, '破产 税 $'+pay, '#FF6B6B');
      } else {
        this.money[pid]-=amount;
        Sfx.play('tax');
        this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, '-$'+amount+' 税金', '#FF9F1C');
        this.msgText.setText('缴纳税金 $'+amount);
      }
      this.updateHud();
      this.time.delayedCall(900, ()=> this.nextTurn());
    }

    doChance(){
      var ev=CHANCE_EVENTS[Math.floor(Math.random()*CHANCE_EVENTS.length)];
      var pid=this.turnIdx;
      Sfx.play('chance');
      this.msgText.setText('机会: '+ev.text);
      if(ev.toJail){
        this.jailTurns[pid]=1;
        this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, '入狱', '#9CA3AF');
        Sfx.play('jail');
        this.time.delayedCall(900, ()=> this.nextTurn());
        return;
      }
      if(ev.toStart){
        // 移动到起点并给奖
        this.money[pid]+=START_BONUS;
        this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, '飞往起点 +$'+START_BONUS, '#06D6A0');
        // 动画飞回起点
        var coord=getTileXY(0, this.tileCount, this.boardX, this.boardY, this.boardW, this.boardH);
        var pawn=this.pawns[pid];
        var offX=(pid-1)*10, offY=(pid===1?6:(pid===2?-6:0));
        this.tweens.add({ targets:pawn, x:coord.x+offX, y:coord.y+12+offY, duration:380, ease:'Sine.easeInOut',
          onComplete:()=>{ try{ pawn._tag.setPosition(coord.x+offX, coord.y+28+offY); }catch(e){} this.pos[pid]=0; this.updateHud(); this.time.delayedCall(600, ()=> this.nextTurn()); }
        });
        return;
      }
      if(typeof ev.perHouse==='number'){
        var cnt=0;
        for(var i=0;i<this.tileCount;i++) if(this.owned[i].owner===pid) cnt+= this.owned[i].level>0?1:1;
        // 简化：每处房产计一次
        var fee=cnt * Math.abs(ev.perHouse);
        if(ev.perHouse<0){
          if(this.money[pid] < fee){
            this.money[pid]=0; this.doBankrupt(pid); Sfx.play('bankrupt');
            this.msgText.setText(ev.text+' 破产！');
          } else { this.money[pid]-=fee; this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, '-$'+fee, '#FF9F1C'); }
        } else { this.money[pid]+=fee; this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, '+$'+fee, '#06D6A0'); }
        this.updateHud();
        this.time.delayedCall(900, ()=> this.nextTurn());
        return;
      }
      if(typeof ev.money==='number' && ev.money!==0){
        if(ev.money<0){
          if(this.money[pid] < Math.abs(ev.money)){
            var pay2=Math.max(0, this.money[pid]);
            this.money[pid]=0; this.doBankrupt(pid); Sfx.play('bankrupt');
            this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, '破产', '#FF6B6B');
          } else { this.money[pid]+=ev.money; this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, (ev.money>0?'+':'')+'$'+ev.money, ev.money>0?'#06D6A0':'#FF9F1C'); }
        } else { this.money[pid]+=ev.money; this.showFloat(this.pawns[pid].x, this.pawns[pid].y-36, '+$'+ev.money, '#06D6A0'); }
        this.updateHud();
        this.time.delayedCall(900, ()=> this.nextTurn());
        return;
      }
      // money 0 的展示类
      this.time.delayedCall(900, ()=> this.nextTurn());
    }

    doBankrupt(pid){
      this.alive[pid]=false;
      // 房产释放
      for(var i=0;i<this.tileCount;i++) if(this.owned[i].owner===pid){ this.owned[i].owner=-1; this.owned[i].level=0; }
      this.pawns[pid].setAlpha(0.25);
      this.refreshHouses();
      this.checkGameOver();
    }

    checkGameOver(){
      var aliveCount=0, lastAlive=-1;
      for(var i=0;i<this.playerCount;i++) if(this.alive[i]){ aliveCount++; lastAlive=i; }
      if(aliveCount<=1){
        this.phase='gameover';
        this.winner=lastAlive;
        var winName=lastAlive>=0 ? ('P'+(lastAlive+1)+(lastAlive===0?' 你':' AI')) : '平局';
        this.msgText.setText('游戏结束 胜者: '+winName);
        if(lastAlive===0){
          saveData.wins++;
          if(this.money[0] > saveData.bestWealth) saveData.bestWealth=this.money[0];
          if(hostRef && typeof hostRef.saveState==='function'){
            try{ hostRef.saveState({ wins:saveData.wins, bestWealth:saveData.bestWealth }); }catch(e){}
          }
          Sfx.play('win');
        } else if(lastAlive>=0){
          Sfx.play('bankrupt');
        }
        // 结算遮罩
        var W=this.W, H=this.H;
        var overlay=this.add.rectangle(W/2, H/2, W, H, 0x000000, 0.62).setDepth(30);
        var title2=(lastAlive===0?'胜利 Victory!':'失败 Defeat');
        var col2=(lastAlive===0? '#06D6A0':'#FF6B6B');
        this.add.text(W/2, H/2-36, title2, { fontFamily:'monospace', fontSize:'20px', color:col2 }).setOrigin(0.5,0.5).setDepth(31);
        this.add.text(W/2, H/2-10, '胜者: '+winName+'   剩余 $'+(lastAlive>=0?this.money[lastAlive]:0), { fontFamily:'monospace', fontSize:'11px', color:'#FFD166' }).setOrigin(0.5,0.5).setDepth(31);
        var btnAgain=this.add.text(W/2-70, H/2+22, '再来一局 R', { fontFamily:'monospace', fontSize:'11px', color:'#ffffff', backgroundColor:'#238636', padding:{x:10,y:6} }).setOrigin(0.5,0.5).setDepth(31).setInteractive({useHandCursor:true});
        var btnMenu=this.add.text(W/2+70, H/2+22, '返回菜单 M', { fontFamily:'monospace', fontSize:'11px', color:'#e8e8e8', backgroundColor:'#334155', padding:{x:10,y:6} }).setOrigin(0.5,0.5).setDepth(31).setInteractive({useHandCursor:true});
        btnAgain.on('pointerdown', ()=> this.scene.restart({ mapIdx:this.mapIdx, playerCount:this.playerCount }));
        btnMenu.on('pointerdown', ()=> this.scene.start('Menu'));
        this._overlay=overlay;
        return true;
      }
      return false;
    }

    nextTurn(){
      if(this.phase==='gameover') return;
      if(this.checkGameOver()) return;
      // 轮转到下一存活玩家，跳过破产
      var start=this.turnIdx;
      var nxt=(this.turnIdx+1)%this.playerCount;
      var guard=0;
      while(!this.alive[nxt] && guard<10){ nxt=(nxt+1)%this.playerCount; guard++; }
      this.turnIdx=nxt;
      // 监狱停一回合
      if(this.jailTurns[this.turnIdx]>0){
        this.jailTurns[this.turnIdx]--;
        this.msgText.setText('P'+(this.turnIdx+1)+' 监狱中 跳过本回合');
        this.phase='roll';
        this.updateHud();
        this.time.delayedCall(900, ()=> this.nextTurn());
        return;
      }
      this.phase='roll';
      this.updateHud();
      // AI 自动掷骰
      if(this.turnIdx!==0 && this.alive[this.turnIdx]){
        var self=this;
        this.time.delayedCall(AI_DELAY, function(){ if(self.phase==='roll' && self.alive[self.turnIdx]) self.doRoll(); });
      }
    }

    update(time, delta){
      // 输入
      if(Phaser.Input.Keyboard.JustDown(this.keyRoll)){
        if(this.phase==='roll' && this.turnIdx===0 && !this.isMoving) this.doRoll();
      }
      if(Phaser.Input.Keyboard.JustDown(this.keyR)){
        if(this.phase==='gameover') this.scene.restart({ mapIdx:this.mapIdx, playerCount:this.playerCount });
        else { Sfx.play('move'); this.scene.restart({ mapIdx:this.mapIdx, playerCount:this.playerCount }); }
      }
      if(Phaser.Input.Keyboard.JustDown(this.keyM)){
        Sfx.stopBgm(); this.scene.start('Menu');
      }
      if(Phaser.Input.Keyboard.JustDown(this.keyOne)){
        Sfx.stopBgm(); this.scene.restart({ mapIdx:0, playerCount:this.playerCount });
      }
      if(Phaser.Input.Keyboard.JustDown(this.keyTwo)){
        Sfx.stopBgm(); this.scene.restart({ mapIdx:1, playerCount:this.playerCount });
      }
    }

    shutdown(){
      Sfx.stopBgm();
    }
  };

  // ---------------------------------------------------------------------------
  // 注册
  // ---------------------------------------------------------------------------
  var config={
    type: Phaser.AUTO,
    parent: host.container,
    width: host.width||960,
    height: host.height||540,
    backgroundColor: '#0b1220',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [BootScene, MenuScene, GameScene]
  };
  var game=new Phaser.Game(config);
  window.__trgame={
    game: game,
    getState: getState,
    getScene: function(){ return sceneRef; },
    _saveData: function(){ return saveData; }
  };
  return game;
}

window.TRGames=window.TRGames||{ register:function(){}, _r:{} };
window.TRGames.register({ id:'monopoly', title:'大富翁 Monopoly', launch: launch });

})();
