// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改：
//   视觉（全部 Graphics+generateTexture 纯几何，零外部图片）：
//     generateTexture('player_stand'/'player_crouch'/'player_tank') 胶囊角色
//       → 换成 this.load.spritesheet('player','assets/player.png',{frameWidth:24,frameHeight:32})
//     generateTexture('infantry'/'turret'/'tank_body'/'heli_body') 敌几何
//       → 换成 this.load.image('infantry','assets/infantry.png') 等
//     generateTexture('bullet_p'/'bullet_e'/'shell'/'grenade') 胶囊子弹
//       → 换成 this.load.image('bullet_p','assets/bullet_p.png')
//     generateTexture('ground1'/'ground2'/'trench'/'ruin'/'sky1'/'sky2') 地形/视差
//       → 换成 this.load.image('ground1','assets/ground1.png') 等
//     generateTexture('hostage'/'weapon_h'/'weapon_s'/'vehicle_tank') 道具/载具矩形
//       → 换成 this.load.image('hostage','assets/hostage.png')
//     generateTexture('explosion') 扩散圆 → 换成 spritesheet 爆炸帧
//     爆炸扩散 this.add.graphics 圆形 tween → 换成粒子/帧动画
//     2层视差 tileSprite 色块 → 换成 this.load.image('bg_far'/'bg_near','assets/bg_*.png')
//   音频：
//     Sfx.play('shoot'/'shotgun'/'machine'/'weapon'/'grenade'/'explosion'/'rescue'/'hurt'/'bossHit'/'pickup'/'bgm')
//       内部 WebAudio oscillator+gain → 换成 this.load.audio('shoot','assets/shoot.wav')+this.sound.play
//       文件顶部 Sfx 块已写替换写法注释。
//   关卡：
//     LEVELS 数组（地形分段+敌人生成区+人质/载具/ Boss Anchor）
//       → 换成 Tiled JSON：this.load.tilemapTiledJSON('level1','assets/level1.json')
//   替换点中文注释已在每段 generateTexture / Sfx 分支标出。
// =============================================================================
(function(){
'use strict';
var TILE=32;
var GRAVITY=1900;
var MOVE_SPEED=220;
var JUMP_VEL=560;
var COYOTE_MS=110;
var BUFFER_MS=130;
var TERMINAL_VY=900;
var FIRE_PISTOL_MS=220;
var FIRE_MG_MS=90;
var FIRE_SHOT_MS=480;
var BULLET_SPEED=520;
var GRENADE_SPEED_X=280;
var GRENADE_SPEED_Y= -420;
var GRENADE_GRAV=900;
var ENEMY_SPEED=70;
var ENEMY_SHOOT_MS=1400;
var TURRET_SHOOT_MS=1100;
var CAM_LERP=0.12;
var HURT_INV_MS=1200;
var WORLD_H=540;
var GROUND_Y= 480;

var LEVELS=[
  {
    id:1, name:'野外战壕', bg:'#5a8f3a', sky:'#87c1e8',
    worldW: 5200,
    trenches:[{x:600,w:220},{x:1400,w:260},{x:2300,w:200},{x:3400,w:280}],
    turrets:[{x:900},{x:1800},{x:2700}],
    infantryZones:[{x:500,n:3},{x:1200,n:3},{x:2000,n:4},{x:3000,n:4},{x:4000,n:3}],
    hostages:[{x:700},{x:2200},{x:3800}],
    weapons:[{x:1100,type:1,ammo:150},{x:2500,type:2,ammo:30}],
    vehicle:{x:1600},
    boss:{x:4800,type:'tank'}
  },
  {
    id:2, name:'都市废墟', bg:'#4a4a52', sky:'#6b7a8f',
    worldW: 6000,
    trenches:[{x:800,w:180},{x:1800,w:300},{x:3000,w:220},{x:4200,w:260}],
    turrets:[{x:1100},{x:2200},{x:3400},{x:4500}],
    infantryZones:[{x:600,n:4},{x:1500,n:4},{x:2600,n:5},{x:3800,n:5},{x:5000,n:4}],
    hostages:[{x:900},{x:2800},{x:4600}],
    weapons:[{x:1300,type:1,ammo:180},{x:3200,type:1,ammo:120},{x:4000,type:2,ammo:30}],
    vehicle:{x:2000},
    boss:{x:5600,type:'heli'}
  }
];

var hostRef=null;
var sceneRef=null;
var saveData={hiScore:0,reachedStage:1};
function getState(){
  var sc=sceneRef;
  if(!sc) return {scene:'title',stage:1,score:0,hp:3,weapon:0,grenades:3};
  return {
    scene: sc.gameState||'title',
    stage: sc.curStage||1,
    score: sc.score||0,
    hp: sc.inTank ? sc.tankHp : sc.hp,
    weapon: sc.weapon||0,
    grenades: sc.grenades||0
  };
}

var Sfx={
  ctx:null, bgmTimer:null,
  ensure:function(){
    try{
      if(!Sfx.ctx){ var AC=window.AudioContext||window.webkitAudioContext; if(!AC) return null; Sfx.ctx=new AC(); }
      if(Sfx.ctx.state==='suspended') Sfx.ctx.resume();
      return Sfx.ctx;
    }catch(e){ return null; }
  },
  tone:function(freq,dur,type,vol,slide){
    try{
      var ctx=Sfx.ensure(); if(!ctx) return;
      var o=ctx.createOscillator(), g=ctx.createGain();
      o.type=type||'sine'; o.frequency.value=freq;
      if(slide) o.frequency.linearRampToValueAtTime(slide, ctx.currentTime+dur);
      g.gain.value= vol!=null?vol:0.18;
      g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+dur);
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime+dur);
    }catch(e){}
  },
  play:function(name){
    try{
      if(name==='shoot'){ Sfx.tone(880,0.08,'square',0.2,320); }
      else if(name==='machine'){ Sfx.tone(720,0.06,'square',0.14,520); }
      else if(name==='shotgun'){ Sfx.tone(180,0.14,'square',0.28,80); setTimeout(function(){ Sfx.tone(90,0.08,'square',0.2); },60); }
      else if(name==='weapon'){ Sfx.tone(523,0.12,'sine',0.2,784); setTimeout(function(){ Sfx.tone(784,0.12,'sine',0.18,1046);},110); }
      else if(name==='grenade'){ Sfx.tone(300,0.12,'square',0.18,120); }
      else if(name==='explosion'){ Sfx.tone(120,0.32,'sawtooth',0.42,35); setTimeout(function(){ Sfx.tone(80,0.18,'triangle',0.22);},80); }
      else if(name==='rescue'){ Sfx.tone(659,0.14,'sine',0.22,880); setTimeout(function(){ Sfx.tone(880,0.18,'sine',0.2);},120); }
      else if(name==='hurt'){ Sfx.tone(200,0.28,'sawtooth',0.22,70); }
      else if(name==='bossHit'){ Sfx.tone(160,0.12,'square',0.24,90); }
      else if(name==='pickup'){ Sfx.tone(880,0.1,'sine',0.2,1318); }
      else if(name==='jump'){ Sfx.tone(480,0.1,'square',0.16,720); }
    }catch(e){}
  },
  startBgm:function(scene){
    try{
      Sfx.stopBgm();
      var ctx=Sfx.ensure(); if(!ctx) return;
      var notes=[196,247,294,247];
      var idx=0;
      Sfx.bgmTimer=scene.time.addEvent({delay:420,loop:true,callback:function(){
        try{ Sfx.tone(notes[idx%notes.length],0.18,'triangle',0.06); idx++; }catch(e){}
      }});
    }catch(e){}
  },
  stopBgm:function(){ try{ if(Sfx.bgmTimer){ Sfx.bgmTimer.remove(false); Sfx.bgmTimer=null; } }catch(e){} }
};

function buildTextures(scene){
  function rm(k){ if(scene.textures.exists(k)) scene.textures.remove(k); }
  var g;
  // 地面1 野外绿棕 — 将来换 this.load.image('ground1','assets/ground1.png')
  rm('ground1'); g=scene.add.graphics();
  g.fillStyle(0x7a9a3a,1); g.fillRect(0,0,TILE,TILE);
  g.fillStyle(0x5f7a2a,1); g.fillRect(0,0,TILE,4); g.fillRect(0,TILE-4,TILE,4);
  g.lineStyle(1,0x3d4f1a,0.9); g.strokeRect(0,0,TILE,TILE);
  g.generateTexture('ground1',TILE,TILE); g.destroy();
  // 地面2 都市灰砖 — 将来换 this.load.image('ground2','assets/ground2.png')
  rm('ground2'); g=scene.add.graphics();
  g.fillStyle(0x6b6b6b,1); g.fillRect(0,0,TILE,TILE);
  g.fillStyle(0x8a8a8a,1); g.fillRect(0,0,TILE,3); g.fillRect(0,TILE-3,TILE,3);
  g.lineStyle(1,0x333333,0.9); g.strokeRect(0,0,TILE,TILE);
  g.lineStyle(1,0x444444,0.5); g.lineBetween(0,8,TILE,8); g.lineBetween(0,16,TILE,16); g.lineBetween(8,0,8,32); g.lineBetween(24,0,24,32);
  g.generateTexture('ground2',TILE,TILE); g.destroy();
  // 战壕 — 深色凹陷 — 将来换 image
  rm('trench'); g=scene.add.graphics();
  g.fillStyle(0x3a2f1a,1); g.fillRect(0,0,TILE,TILE);
  g.fillStyle(0x5a4a2a,1); g.fillRect(0,0,TILE,6);
  g.fillStyle(0x2a2010,1); g.fillRect(4,6,TILE-8,16);
  g.generateTexture('trench',TILE,TILE); g.destroy();
  // 废墟 — 破墙 — 将来换 image
  rm('ruin'); g=scene.add.graphics();
  g.fillStyle(0x5a5a5a,1); g.fillRect(0,0,TILE,TILE);
  g.fillStyle(0x3a3a3a,1); g.fillRect(0,0,4,TILE); g.fillRect(TILE-4,0,4,TILE);
  g.fillStyle(0x8a6a4a,0.5); g.fillTriangle(0,0,16,8,0,16);
  g.lineStyle(1,0x222222,0.7); g.strokeRect(0,0,TILE,TILE);
  g.generateTexture('ruin',TILE,TILE); g.destroy();
  // 胶囊站立 20x34 — 将来换 spritesheet
  rm('player_stand'); g=scene.add.graphics();
  g.fillStyle(0x2e7be6,1); g.fillRoundedRect(2,6,16,22,6);
  g.fillStyle(0xf5d6b8,1); g.fillCircle(10,6,7);
  g.fillStyle(0x333333,1); g.fillCircle(7,5,1.5); g.fillCircle(13,5,1.5);
  g.fillStyle(0x1a4fa0,1); g.fillRect(2,16,16,4);
  g.fillStyle(0x444444,1); g.fillRect(4,28,5,4); g.fillRect(11,28,5,4);
  // 枪管示意
  g.fillStyle(0x222222,1); g.fillRect(16,14,8,3);
  g.generateTexture('player_stand',20,34); g.destroy();
  // 下蹲 20x22 — 将来换 spritesheet
  rm('player_crouch'); g=scene.add.graphics();
  g.fillStyle(0x2e7be6,1); g.fillRoundedRect(2,4,16,14,5);
  g.fillStyle(0xf5d6b8,1); g.fillCircle(10,6,6);
  g.fillStyle(0x222222,1); g.fillRect(14,10,10,3);
  g.fillStyle(0x444444,1); g.fillRect(4,18,6,3); g.fillRect(10,18,6,3);
  g.generateTexture('player_crouch',24,22); g.destroy();
  // 坦克载具 64x32 矩形 — 将来换 image
  rm('vehicle_tank'); g=scene.add.graphics();
  g.fillStyle(0x6b7a3a,1); g.fillRoundedRect(0,10,64,22,4);
  g.fillStyle(0x4a5a2a,1); g.fillRect(6,14,52,6);
  g.fillStyle(0x333333,1); g.fillRect(0,30,64,4);
  g.fillStyle(0x8a9a5a,1); g.fillRect(8,6,20,10);
  g.fillStyle(0x222222,1); g.fillRect(24,8,28,4);
  g.fillStyle(0x444444,1); g.fillCircle(14,32,4); g.fillCircle(28,32,4); g.fillCircle(42,32,4); g.fillCircle(54,32,4);
  g.generateTexture('vehicle_tank',64,34); g.destroy();
  // 步兵 18x28 几何 — 将来换 image
  rm('infantry'); g=scene.add.graphics();
  g.fillStyle(0x6b8f3a,1); g.fillRoundedRect(2,6,14,16,4);
  g.fillStyle(0xf5d6b8,1); g.fillCircle(9,5,5);
  g.fillStyle(0x333333,1); g.fillRect(12,10,10,2);
  g.fillStyle(0x4a4a4a,1); g.fillRect(3,22,5,4); g.fillRect(10,22,5,4);
  g.generateTexture('infantry',22,28); g.destroy();
  // 炮台 28x22 — 将来换 image
  rm('turret'); g=scene.add.graphics();
  g.fillStyle(0x5a5a5a,1); g.fillRoundedRect(0,6,28,16,4);
  g.fillStyle(0x333333,1); g.fillRect(10,0,8,10);
  g.fillStyle(0x222222,1); g.fillRect(16,3,14,4);
  g.fillStyle(0x444444,1); g.fillRect(2,20,24,3);
  g.generateTexture('turret',32,22); g.destroy();
  // 坦克Boss 80x40 — 将来换 image
  rm('tank_body'); g=scene.add.graphics();
  g.fillStyle(0x4a5a2a,1); g.fillRoundedRect(0,10,80,28,5);
  g.fillStyle(0x6b7a3a,1); g.fillRect(10,4,30,14);
  g.fillStyle(0x222222,1); g.fillRect(36,8,32,5);
  g.fillStyle(0x333333,1); g.fillRect(0,36,80,5);
  g.fillStyle(0x444444,1); g.fillCircle(16,38,5); g.fillCircle(34,38,5); g.fillCircle(52,38,5); g.fillCircle(68,38,5);
  g.generateTexture('tank_body',80,42); g.destroy();
  // 直升机Boss 72x28 — 将来换 image
  rm('heli_body'); g=scene.add.graphics();
  g.fillStyle(0x4a5a6b,1); g.fillRoundedRect(8,8,48,18,8);
  g.fillStyle(0x87ceeb,0.9); g.fillRoundedRect(36,10,18,10,3);
  g.fillStyle(0x333333,1); g.fillRect(0,14,14,4); g.fillRect(54,14,18,3);
  g.fillStyle(0x6a6a6a,1); g.fillRect(18,2,32,4); g.fillRect(26,4,4,16);
  g.fillStyle(0x222222,1); g.fillCircle(22,26,3); g.fillCircle(40,26,3);
  g.generateTexture('heli_body',72,28); g.destroy();
  // 子弹 玩家黄 — 将来换 image
  rm('bullet_p'); g=scene.add.graphics();
  g.fillStyle(0xffd23f,1); g.fillRoundedRect(0,0,12,6,3);
  g.fillStyle(0xfff7a0,1); g.fillRoundedRect(2,1,6,4,2);
  g.generateTexture('bullet_p',12,6); g.destroy();
  // 敌弹 红 — 将来换 image
  rm('bullet_e'); g=scene.add.graphics();
  g.fillStyle(0xff3b3b,1); g.fillRoundedRect(0,0,10,6,3);
  g.fillStyle(0xff9a9a,1); g.fillCircle(3,3,2);
  g.generateTexture('bullet_e',10,6); g.destroy();
  // 炮弹 灰 — 将来换 image
  rm('shell'); g=scene.add.graphics();
  g.fillStyle(0xaaaaaa,1); g.fillRoundedRect(0,0,14,8,4);
  g.fillStyle(0xdddddd,1); g.fillCircle(10,4,3);
  g.generateTexture('shell',14,8); g.destroy();
  // 手雷 绿 — 将来换 image
  rm('grenade'); g=scene.add.graphics();
  g.fillStyle(0x3a7a2a,1); g.fillCircle(6,6,6);
  g.fillStyle(0x5aaa3a,1); g.fillCircle(4,4,2);
  g.fillStyle(0x333333,1); g.fillRect(5,0,3,4);
  g.generateTexture('grenade',12,12); g.destroy();
  // 人质 14x22
  rm('hostage'); g=scene.add.graphics();
  g.fillStyle(0xf5d6b8,1); g.fillCircle(7,5,5);
  g.fillStyle(0xddddaa,1); g.fillRoundedRect(3,9,8,10,3);
  g.fillStyle(0x4a7a4a,1); g.fillRect(4,12,6,2);
  g.fillStyle(0x333333,1); g.fillCircle(5,5,1); g.fillCircle(9,5,1);
  g.generateTexture('hostage',14,22); g.destroy();
  // 武器拾取 机枪蓝 散弹红
  rm('weapon_h'); g=scene.add.graphics();
  g.fillStyle(0x2a6ae6,1); g.fillRoundedRect(0,0,22,10,3);
  g.fillStyle(0x111111,1); g.fillRect(14,3,10,4);
  g.fillStyle(0xffd23f,1); g.fillCircle(4,5,2);
  g.generateTexture('weapon_h',24,10); g.destroy();
  rm('weapon_s'); g=scene.add.graphics();
  g.fillStyle(0xe63a2a,1); g.fillRoundedRect(0,0,22,10,3);
  g.fillStyle(0x111111,1); g.fillRect(14,3,10,4);
  g.fillStyle(0xffd23f,1); g.fillCircle(4,5,2);
  g.generateTexture('weapon_s',24,10); g.destroy();
  // 爆炸 48 — 将来换 spritesheet
  rm('explosion'); g=scene.add.graphics();
  g.fillStyle(0xffa500,1); g.fillCircle(24,24,18);
  g.fillStyle(0xffff00,1); g.fillCircle(24,24,10);
  g.fillStyle(0xffffff,1); g.fillCircle(22,20,4);
  g.generateTexture('explosion',48,48); g.destroy();
  // 视差远景/近景 — 将来换 image
  rm('sky1'); g=scene.add.graphics();
  g.fillStyle(0x87c6e8,1); g.fillRect(0,0,64,64);
  g.fillStyle(0xa8dbf0,1); g.fillCircle(14,18,10); g.fillCircle(40,30,14);
  g.generateTexture('sky1',64,64); g.destroy();
  rm('sky2'); g=scene.add.graphics();
  g.fillStyle(0x6fb86a,1); g.fillRect(0,0,64,64);
  g.fillStyle(0x8fd48a,1); g.fillRect(0,0,64,10); g.fillRect(0,22,32,6);
  g.generateTexture('sky2',64,64); g.destroy();
}

var MainScene = new Phaser.Class({
Extends: Phaser.Scene,
initialize: function MainScene(){ Phaser.Scene.call(this,{key:'Main'}); },
create: function(){
  sceneRef=this;
  buildTextures(this);
  var isRuins = false;
  this.cameras.main.setBackgroundColor('#87c1e8');
  this.physics.world.setBounds(0,0,6000,WORLD_H);

  // 视差 tileSprite — 将来换贴图仅改纹理名
  this.bgFar=this.add.tileSprite(0,0,6000,180,'sky1').setOrigin(0,0).setScrollFactor(0).setDepth(-20);
  this.bgNear=this.add.tileSprite(0,120,6000,100,'sky2').setOrigin(0,0).setScrollFactor(0).setDepth(-10);

  this.keys=this.input.keyboard.addKeys('LEFT,RIGHT,UP,DOWN,A,D,W,S,SPACE,G,H,R,P,ENTER');
  this.keyC=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.C);
  this.keyX=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.X);
  this.keyG=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.G);

  this.curStage=1;
  this.score=0;
  this.hp=3;
  this.maxHp=3;
  this.grenades=5;
  this.weapon=0; // 0手枪无限 1机枪 2散弹
  this.ammo=0;
  this.facing=1;
  this.isCrouch=false;
  this.inTank=false;
  this.tankHp=12;
  this.tankMaxHp=12;
  this.isDead=false;
  this.gameState='title';
  this.invUntil=0;
  this.coyote=0;
  this.buffer=0;
  this.jumpHeld=false;
  this.hasJumpCut=false;
  this.lastShoot=0;
  this.worldW=5200;
  this.spawnedInfantry=0;
  this.bossSpawned=false;
  this.bossParts=[];
  this.boss=null;
  this.stageCleared=false;
  this.followers=[];

  this.solids=this.physics.add.staticGroup();
  this.enemies=this.physics.add.group();
  this.turrets=this.physics.add.group();
  this.bulletsP=this.physics.add.group();
  this.bulletsE=this.physics.add.group();
  this.grenadesG=this.physics.add.group();
  this.hostages=this.physics.add.group();
  this.weaponsG=this.physics.add.group();
  this.vehicles=this.physics.add.group();
  this.explosions=this.add.group();

  // HUD
  this.hudScore=this.add.text(10,8,'SCORE 0',{fontSize:'13px',color:'#fff',stroke:'#222',strokeThickness:3}).setScrollFactor(0).setDepth(100);
  this.hudHp=this.add.text(10,26,'HP ♥♥♥',{fontSize:'12px',color:'#fff',stroke:'#222',strokeThickness:3}).setScrollFactor(0).setDepth(100);
  this.hudWeapon=this.add.text(10,44,'WPN PISTOL ∞',{fontSize:'11px',color:'#fff',stroke:'#222',strokeThickness:3}).setScrollFactor(0).setDepth(100);
  this.hudStage=this.add.text(10,60,'STAGE 1 野外战壕',{fontSize:'11px',color:'#fff',stroke:'#222',strokeThickness:3}).setScrollFactor(0).setDepth(100);
  this.hudGren=this.add.text(140,44,'GRENADE x5 [G]',{fontSize:'11px',color:'#fff',stroke:'#222',strokeThickness:3}).setScrollFactor(0).setDepth(100);
  this.centerText=this.add.text(0,0,'',{fontSize:'22px',color:'#fff',stroke:'#222',strokeThickness:5,align:'center'}).setOrigin(0.5).setScrollFactor(0).setDepth(120).setVisible(false);
  this.titleText=this.add.text(0,0,'METAL SLUG 横版突击\n\n[SPACE] START  [←→/AD] 移动  [W/SPACE] 跳  [S/↓] 蹲\n[X] 射击  [G] 手雷  炮台/载具多部位可破\n解救人质 + 拾取武器 + 骑坦克  Boss在最右侧',{fontSize:'13px',color:'#fff',stroke:'#222',strokeThickness:4,align:'center'}).setOrigin(0.5).setScrollFactor(0).setDepth(110);
  this.updateTitlePos();

  this.player=null;
  this.playerTankSprite=null;

  var self=this;
  // 存档读取
  if(hostRef && hostRef.loadState){
    try{ hostRef.loadState().then(function(d){
      if(d && typeof d==='object'){
        if(typeof d.hiScore==='number') saveData.hiScore=d.hiScore;
        if(typeof d.reachedStage==='number') saveData.reachedStage=d.reachedStage;
        self.score=Math.max(self.score,0);
        self.updateHud();
      }
    },function(){});}catch(e){}
  }
  this.input.once('pointerdown',function(){ Sfx.ensure(); });
  this.input.keyboard.once('keydown',function(){ Sfx.ensure(); });
  this.scale.on('resize',function(){ self.updateTitlePos(); });
},
updateTitlePos:function(){
  var w=this.scale.width||960, h=this.scale.height||540;
  if(this.titleText) this.titleText.setPosition(w/2,h/2-10);
  if(this.centerText) this.centerText.setPosition(w/2,h/2);
},
loadStage:function(n){
  var cfg=LEVELS[n-1]; if(!cfg) cfg=LEVELS[0];
  this.curStage=n;
  this.worldW=cfg.worldW;
  this.spawnedInfantry=0;
  this.bossSpawned=false;
  this.stageCleared=false;
  this.bossParts=[];
  this.boss=null;
  // 清理
  this.solids.clear(true,true);
  this.enemies.clear(true,true);
  this.turrets.clear(true,true);
  this.bulletsP.clear(true,true);
  this.bulletsE.clear(true,true);
  this.grenadesG.clear(true,true);
  this.hostages.clear(true,true);
  this.weaponsG.clear(true,true);
  this.vehicles.clear(true,true);
  this.followers=[];
  // 世界与相机
  this.physics.world.setBounds(0,0,this.worldW,WORLD_H);
  this.cameras.main.setBounds(0,0,this.worldW,WORLD_H);
  // 背景色与地面纹理
  var isRuins = (n===2);
  this.cameras.main.setBackgroundColor(cfg.sky||'#87c1e8');
  if(this.bgFar) { this.bgFar.width=this.worldW; this.bgFar.setTint(isRuins?0x8888aa:0xffffff); }
  if(this.bgNear) { this.bgNear.width=this.worldW; this.bgNear.setTint(isRuins?0x777777:0xffffff); }
  var groundTex = isRuins?'ground2':'ground1';

  // 地面
  for(var c=0;c* TILE < this.worldW; c++){
    var gx=c*TILE+TILE/2;
    // 检查是否在战壕
    var inTrench=false;
    for(var t=0;t<cfg.trenches.length;t++){ var tr=cfg.trenches[t]; if(gx>=tr.x && gx<=tr.x+tr.w) { inTrench=true; break; } }
    if(inTrench){
      var trench = this.solids.create(gx,GROUND_Y+TILE/2,'trench');
      trench.setOrigin(0.5); trench.refreshBody(); trench.isTrench=true;
      // 战壕底部更低，实际可行走面下沉一格，视觉上凹陷；碰撞仍用同一高度，战壕内加两侧墙
    } else {
      var gtile = this.solids.create(gx,GROUND_Y+TILE/2,groundTex);
      gtile.setOrigin(0.5); gtile.refreshBody();
    }
    // 废墟装饰块（关2上空悬浮）
    if(isRuins && c%18===7){
      var rx=gx, ry=GROUND_Y-80;
      var ruin=this.solids.create(rx,ry,'ruin');
      ruin.setOrigin(0.5); ruin.refreshBody();
    }
  }
  // 战壕两侧墙（避免掉出世界，仅视觉阻挡由地面连续性保证；这里补碰撞墙让战壕有深度感）
  for(var ti=0; ti<cfg.trenches.length; ti++){
    var tr2=cfg.trenches[ti];
    var wx1=tr2.x-8, wx2=tr2.x+tr2.w+8;
    // 用不可见墙补齐战壕两侧立面（用 ground2 小块）
    var wallL=this.solids.create(wx1,GROUND_Y-8,'ground2'); wallL.setOrigin(0.5); wallL.setScale(0.5,1.2); wallL.refreshBody(); wallL.setVisible(false);
    var wallR=this.solids.create(wx2,GROUND_Y-8,'ground2'); wallR.setOrigin(0.5); wallR.setScale(0.5,1.2); wallR.refreshBody(); wallR.setVisible(false);
  }

  // 固定炮台
  for(var pi=0; pi<cfg.turrets.length; pi++){
    var tx=cfg.turrets[pi].x;
    var tur=this.physics.add.image(tx,GROUND_Y-14,'turret');
    tur.setImmovable(true); tur.body.allowGravity=false;
    tur.hp=4; tur.maxHp=4; tur.nextShoot=0; tur.isTurret=true; tur.spawnX=tx;
    this.turrets.add(tur);
  }
  // 人质
  for(var hi=0; hi<cfg.hostages.length; hi++){
    var hx=cfg.hostages[hi].x;
    var hos=this.physics.add.image(hx,GROUND_Y-16,'hostage');
    hos.body.allowGravity=false; hos.body.setSize(14,22);
    hos.rescued=false; hos.followOffset= 14+ hi*10;
    hos.spawnX=hx;
    this.hostages.add(hos);
  }
  // 武器拾取
  for(var wi=0; wi<cfg.weapons.length; wi++){
    var wdat=cfg.weapons[wi];
    var wtex= wdat.type===1?'weapon_h':'weapon_s';
    var wp=this.physics.add.image(wdat.x,GROUND_Y-12,wtex);
    wp.body.allowGravity=false; wp.wType=wdat.type; wp.ammo=wdat.ammo; wp.spawnX=wdat.x;
    this.weaponsG.add(wp);
  }
  // 载具（骑乘坦克）
  if(cfg.vehicle){
    var veh=this.physics.add.image(cfg.vehicle.x,GROUND_Y-18,'vehicle_tank');
    veh.body.allowGravity=false; veh.body.setSize(64,24);
    veh.isVehicle=true; veh.used=false; veh.spawnX=cfg.vehicle.x;
    this.vehicles.add(veh);
  }

  // 玩家生成 — 使用 body.reset 传送（避免 setPosition 失效）
  if(this.player){ try{ this.player.destroy(); }catch(e){} }
  if(this.playerTankSprite){ try{ this.playerTankSprite.destroy(); }catch(e){} this.playerTankSprite=null; }
  var startX=80;
  this.player=this.physics.add.image(startX,GROUND_Y-24,'player_stand');
  this.player.setOrigin(0.5,0.5);
  this.player.body.setSize(14,28);
  this.player.body.setOffset(3,4);
  this.player.setCollideWorldBounds(true);
  this.player.facing=1;
  // 初始传送确保体更新
  try{ this.player.body.reset(startX,GROUND_Y-24); }catch(e){ this.player.setPosition(startX,GROUND_Y-24); }
  this.inTank=false; this.tankHp=this.tankMaxHp;
  this.followers=[];

  // 碰撞：玩家-地面，敌-地面 等
  // 注意：碰撞参数顺序无关，回调内用 contains 判断角色
  var self=this;
  this.physics.add.collider(this.player,this.solids);
  this.physics.add.collider(this.enemies,this.solids);
  this.physics.add.collider(this.hostages,this.solids);
  // 子弹与地面可穿透，无碰撞

  // 敌弹与玩家碰撞 — 顺序无关：回调内辨识
  this.physics.add.overlap(this.bulletsE, this.player, function(a,b){ self.handleEnemyBulletHit(a,b); });
  this.physics.add.overlap(this.player, this.bulletsE, function(a,b){ self.handleEnemyBulletHit(a,b); });
  // 玩家弹与敌人
  this.physics.add.overlap(this.bulletsP, this.enemies, function(a,b){ self.handlePlayerBulletHit(a,b); });
  this.physics.add.overlap(this.enemies, this.bulletsP, function(a,b){ self.handlePlayerBulletHit(a,b); });
  this.physics.add.overlap(this.bulletsP, this.turrets, function(a,b){ self.handlePlayerBulletHit(a,b); });
  this.physics.add.overlap(this.turrets, this.bulletsP, function(a,b){ self.handlePlayerBulletHit(a,b); });
  // 玩家弹与 Boss（Boss parts 另注册）
  // 拾取与救援
  this.physics.add.overlap(this.player, this.hostages, function(a,b){ self.handleHostage(a,b); });
  this.physics.add.overlap(this.hostages, this.player, function(a,b){ self.handleHostage(a,b); });
  this.physics.add.overlap(this.player, this.weaponsG, function(a,b){ self.handleWeaponPickup(a,b); });
  this.physics.add.overlap(this.weaponsG, this.player, function(a,b){ self.handleWeaponPickup(a,b); });
  this.physics.add.overlap(this.player, this.vehicles, function(a,b){ self.handleVehicle(a,b); });
  this.physics.add.overlap(this.vehicles, this.player, function(a,b){ self.handleVehicle(a,b); });

  // 相机跟随
  this.cameras.main.startFollow(this.player,true,CAM_LERP,CAM_LERP);
  this.updateHud();
  Sfx.startBgm(this);
},
handleEnemyBulletHit: function(a,b){
  // 参数顺序无关：找出哪一个是玩家，哪一个是子弹
  var bullet=null, player=null;
  if(a===this.player) { player=a; bullet=b; }
  else if(b===this.player) { player=b; bullet=a; }
  else {
    // 兼容 group 内部回调可能传 image vs sprite
    if(this.bulletsE.contains(a) && b===this.player) { bullet=a; player=b; }
    else if(this.bulletsE.contains(b) && a===this.player) { bullet=b; player=a; }
    else return;
  }
  if(!bullet || !bullet.active) return;
  if(this.isDead) return;
  if(this.inTank){
    try{ bullet.destroy(); }catch(e){ bullet.setActive(false).setVisible(false); }
    this.tankHp -= 1;
    this.spawnExplosion(bullet.x, bullet.y, 0.6);
    Sfx.play('bossHit');
    if(this.tankHp<=0){
      this.exitTank(true);
      this.spawnExplosion(this.player.x, this.player.y, 1.0);
    }
    this.updateHud();
    return;
  }
  // 下蹲可躲高弹：蹲姿时高位弹（y < 玩家中心-6）视为未命中
  if(this.isCrouch && bullet.y < this.player.y - 6){
    return;
  }
  if(this.time.now < this.invUntil) return;
  try{ bullet.destroy(); }catch(e){ bullet.setActive(false).setVisible(false); }
  this.hp -= 1;
  this.invUntil = this.time.now + HURT_INV_MS;
  Sfx.play('hurt');
  this.cameras.main.shake(120,0.008);
  if(this.hp<=0){
    this.playerDie();
  } else {
    // 受击闪烁
    var self=this;
    var t=self.time.addEvent({delay:90,loop:true,callback:function(){
      if(!self.player || self.time.now>=self.invUntil){ self.player.setAlpha(1); t.remove(false); return; }
      self.player.setAlpha(self.player.alpha===1?0.35:1);
    }});
    // 掉落跟随人质
    if(this.followers.length>0){
      var lost=this.followers.pop();
      if(lost && lost.active){ lost.rescued=false; lost.setVelocity(0,0); try{ lost.body.reset(this.player.x-20, GROUND_Y-16);}catch(e){} }
    }
  }
  this.updateHud();
},
handlePlayerBulletHit: function(a,b){
  var bullet=null, target=null, isBulletA=false;
  // 辨识子弹与目标，顺序无关
  if(this.bulletsP.contains(a)){ bullet=a; target=b; isBulletA=true; }
  else if(this.bulletsP.contains(b)){ bullet=b; target=a; isBulletA=false; }
  else return;
  if(!bullet||!bullet.active||!target||!target.active) return;
  // 手雷不算在 bulletsP，手雷另处理
  try{ bullet.destroy(); }catch(e){ bullet.setActive(false).setVisible(false); }
  // 伤害
  var dmg = bullet.dmg || 1;
  // Boss 部位判定
  if(target.isBossPart){
    target.hp -= dmg;
    Sfx.play('bossHit');
    this.spawnExplosion(target.x, target.y, 0.5);
    target.setTint(0xff6666);
    var self=this;
    self.time.delayedCall(90,function(){ if(target.active) target.clearTint(); });
    if(target.hp<=0){
      this.score += target.score||200;
      this.spawnExplosion(target.x, target.y, 0.9);
      Sfx.play('explosion');
      // 部位破坏效果
      target.broken=true; target.setAlpha(0.35);
      target.body.enable=false;
      // 检查是否全部位破坏才算 Boss 死
      var allBroken=true;
      for(var i=0;i<this.bossParts.length;i++){ if(!this.bossParts[i].broken) { allBroken=false; break; } }
      if(allBroken && this.boss){
        this.score += 1000;
        this.spawnExplosion(this.boss.x, this.boss.y, 1.6);
        Sfx.play('explosion');
        this.cameras.main.shake(260,0.012);
        this.bossDead();
      }
    }
    this.updateHud();
    return;
  }
  // 炮台/步兵
  target.hp -= dmg;
  if(target.hp<=0){
    this.score += target.isTurret?150:100;
    this.spawnExplosion(target.x,target.y, target.isTurret?0.9:0.7);
    Sfx.play('explosion');
    try{ target.destroy(); }catch(e){ target.setActive(false).setVisible(false); }
  } else {
    target.setTint(0xffaaaa);
    var s2=this;
    s2.time.delayedCall(70,function(){ if(target.active) target.clearTint(); });
    Sfx.play('bossHit');
  }
  this.updateHud();
},
handleHostage: function(a,b){
  var hos=null;
  if(this.hostages.contains(a)) hos=a;
  else if(this.hostages.contains(b)) hos=b;
  else return;
  if(!hos||!hos.active||hos.rescued) return;
  hos.rescued=true;
  this.score+=500;
  Sfx.play('rescue');
  // 跟随
  this.followers.push(hos);
  hos.body.allowGravity=false;
  this.updateHud();
},
handleWeaponPickup: function(a,b){
  var wp=null;
  if(this.weaponsG.contains(a)) wp=a;
  else if(this.weaponsG.contains(b)) wp=b;
  else return;
  if(!wp||!wp.active) return;
  this.weapon=wp.wType;
  this.ammo=wp.ammo;
  Sfx.play('weapon');
  try{ wp.destroy(); }catch(e){ wp.setActive(false).setVisible(false); }
  this.updateHud();
},
handleVehicle: function(a,b){
  var veh=null;
  if(this.vehicles.contains(a)) veh=a;
  else if(this.vehicles.contains(b)) veh=b;
  else return;
  if(!veh||!veh.active||veh.used) return;
  if(this.inTank) return;
  veh.used=true;
  this.inTank=true;
  this.tankHp=this.tankMaxHp;
  this.weapon=1; this.ammo=999;
  Sfx.play('weapon');
  // 视觉：玩家隐藏，显示坦克贴图跟随
  this.player.setVisible(false);
  this.playerTankSprite=this.add.image(this.player.x,this.player.y,'vehicle_tank').setDepth(5);
  try{ veh.destroy(); }catch(e){ veh.setActive(false).setVisible(false); }
  this.updateHud();
},
exitTank: function(exploded){
  this.inTank=false;
  this.weapon=0; this.ammo=0;
  if(this.playerTankSprite){ try{ this.playerTankSprite.destroy(); }catch(e){} this.playerTankSprite=null; }
  this.player.setVisible(true);
  if(exploded){
    this.hp = Math.max(1, this.hp-1);
    this.invUntil=this.time.now+HURT_INV_MS;
    Sfx.play('hurt');
  }
  this.updateHud();
},
spawnExplosion: function(x,y,scale){
  var sp=this.add.image(x,y,'explosion').setScale(scale||1).setDepth(40).setAlpha(0.95);
  this.tweens.add({targets:sp,scale:scale*1.7,alpha:0,duration:260,ease:'Quad.easeOut',onComplete:function(){ try{ sp.destroy(); }catch(e){} }});
},
tryShoot: function(){
  var now=this.time.now;
  var interval = (this.weapon===1?FIRE_MG_MS:(this.weapon===2?FIRE_SHOT_MS:FIRE_PISTOL_MS));
  if(this.inTank) interval = 140;
  if(now - this.lastShoot < interval) return;
  this.lastShoot=now;
  if(this.weapon!==0 && !this.inTank){
    if(this.ammo<=0){ this.weapon=0; this.ammo=0; this.updateHud(); }
    else {
      if(this.weapon===2) this.ammo = Math.max(0,this.ammo-1);
      else this.ammo = Math.max(0,this.ammo-1);
      if(this.ammo<=0){ this.weapon=0; this.ammo=0; }
    }
  }
  var px=this.player.x, py=this.player.y - (this.isCrouch? -2:4);
  var dir=this.facing;
  if(this.inTank){
    var shell=this.physics.add.image(px+ dir*28, py, 'shell');
    shell.body.allowGravity=false; shell.setVelocityX(dir*BULLET_SPEED*1.15); shell.dmg=3;
    shell.body.setSize(14,8);
    this.bulletsP.add(shell);
    this.time.delayedCall(2000,function(){ if(shell.active) try{shell.destroy();}catch(e){} });
    Sfx.play('machine');
    if(this.playerTankSprite){ this.tweens.add({targets:this.playerTankSprite, x: this.playerTankSprite.x - dir*2, duration:40,yoyo:true}); }
  } else if(this.weapon===2){
    // 散弹 5发扇形
    for(var i=-2;i<=2;i++){
      var b=this.physics.add.image(px+ dir*10, py + i*3, 'bullet_p');
      b.body.allowGravity=false;
      var ang = i*12 * Math.PI/180;
      var vx = dir*BULLET_SPEED*0.92 * Math.cos(ang);
      var vy = BULLET_SPEED*0.45 * Math.sin(ang);
      b.setVelocity(vx, vy);
      b.dmg=1;
      b.body.setSize(12,6);
      this.bulletsP.add(b);
      this.time.delayedCall(1400,function(bb){ return function(){ if(bb.active) try{bb.destroy();}catch(e){} }; }(b));
    }
    Sfx.play('shotgun');
  } else if(this.weapon===1){
    var b2=this.physics.add.image(px+ dir*12, py, 'bullet_p');
    b2.body.allowGravity=false; b2.setVelocityX(dir*BULLET_SPEED*1.12); b2.dmg=1;
    b2.body.setSize(12,6);
    this.bulletsP.add(b2);
    this.time.delayedCall(1600,function(){ if(b2.active) try{b2.destroy();}catch(e){} });
    Sfx.play('machine');
  } else {
    var b3=this.physics.add.image(px+ dir*10, py, 'bullet_p');
    b3.body.allowGravity=false; b3.setVelocityX(dir*BULLET_SPEED); b3.dmg=1;
    b3.body.setSize(12,6);
    this.bulletsP.add(b3);
    this.time.delayedCall(1600,function(){ if(b3.active) try{b3.destroy();}catch(e){} });
    Sfx.play('shoot');
  }
  this.player.setTint(0xffffaa);
  var self=this; self.time.delayedCall(70,function(){ if(self.player) self.player.clearTint(); });
  this.updateHud();
},
throwGrenade: function(){
  if(this.grenades<=0) return;
  if(this.isDead) return;
  this.grenades--;
  var px=this.player.x, py=this.player.y-8;
  var dir=this.facing;
  var g=this.physics.add.image(px+dir*10, py, 'grenade');
  g.body.setSize(10,10);
  g.setVelocity(dir*GRENADE_SPEED_X, GRENADE_SPEED_Y);
  g.body.allowGravity=true; g.body.gravityY=GRENADE_GRAV;
  g.isGrenade=true; g.spawnTime=this.time.now;
  this.grenadesG.add(g);
  Sfx.play('grenade');
  // 2.2秒后爆炸或着地炸
  this.updateHud();
},
explodeGrenade: function(g){
  if(!g||!g.active) return;
  var x=g.x, y=g.y;
  this.spawnExplosion(x,y,1.2);
  Sfx.play('explosion');
  this.cameras.main.shake(160,0.007);
  // 范围伤害：半径 90
  var r=90;
  var allEnemies=this.enemies.getChildren().slice();
  for(var i=0;i<allEnemies.length;i++){ var e=allEnemies[i]; if(Phaser.Math.Distance.Between(x,y,e.x,e.y)<r){ e.hp-=3; if(e.hp<=0){ this.score+=100; this.spawnExplosion(e.x,e.y,0.7); try{e.destroy();}catch(e2){} } } }
  var allTurrets=this.turrets.getChildren().slice();
  for(var j=0;j<allTurrets.length;j++){ var t=allTurrets[j]; if(Phaser.Math.Distance.Between(x,y,t.x,t.y)<r){ t.hp-=3; if(t.hp<=0){ this.score+=150; this.spawnExplosion(t.x,t.y,0.9); try{t.destroy();}catch(e2){} } else { t.setTint(0xffaaaa); } } }
  for(var k=0;k<this.bossParts.length;k++){ var bp=this.bossParts[k]; if(!bp.active||bp.broken) continue; if(Phaser.Math.Distance.Between(x,y,bp.x,bp.y)<r+18){ bp.hp-=3; this.spawnExplosion(bp.x,bp.y,0.6); if(bp.hp<=0){ bp.broken=true; bp.setAlpha(0.35); bp.body.enable=false; this.score+=(bp.score||200); this.spawnExplosion(bp.x,bp.y,0.9); } } }
  // Boss 主体距离判定
  if(this.boss && this.boss.active && Phaser.Math.Distance.Between(x,y,this.boss.x,this.boss.y)<r+30){
    var needAll=true;
    for(var m=0;m<this.bossParts.length;m++){ if(!this.bossParts[m].broken) needAll=false; }
    if(needAll) { /* 主体不直接掉血，靠部位 */ }
  }
  // 检查是否全部位破
  if(this.bossParts.length>0){
    var allB=true; for(var p=0;p<this.bossParts.length;p++){ if(!this.bossParts[p].broken) { allB=false; break; } }
    if(allB && this.boss){ this.bossDead(); }
  }
  try{ g.destroy(); }catch(e){ g.setActive(false).setVisible(false); }
  this.updateHud();
},
bossDead: function(){
  if(!this.boss || this.stageCleared) return;
  this.stageCleared=true;
  this.score+=1000;
  if(this.boss.active) { this.spawnExplosion(this.boss.x,this.boss.y,1.8); try{ this.boss.destroy(); }catch(e){} }
  for(var i=0;i<this.bossParts.length;i++){ try{ this.bossParts[i].destroy(); }catch(e){} }
  this.boss=null; this.bossParts=[];
  Sfx.play('explosion');
  this.cameras.main.shake(300,0.014);
  var self=this;
  self.time.delayedCall(900,function(){
    if(self.curStage<LEVELS.length){
      self.showCenter('STAGE CLEAR!', 900, function(){ self.loadStage(self.curStage+1); self.gameState='playing'; self.centerText.setVisible(false); self.titleText.setVisible(false); });
    } else {
      self.gameState='win';
      self.showCenter('ALL CLEAR!  SCORE '+self.score+'\n[R] 重开', 999999, null);
      self.saveProgress();
    }
  });
  this.updateHud();
},
showCenter: function(msg,dur,cb){
  this.centerText.setText(msg).setVisible(true).setAlpha(1);
  if(cb){
    var self=this;
    self.time.delayedCall(dur, cb);
  }
  this.updateHud();
},
saveProgress: function(){
  if(this.score>saveData.hiScore) saveData.hiScore=this.score;
  if(this.curStage>=saveData.reachedStage) saveData.reachedStage=Math.min(LEVELS.length, this.curStage+ (this.gameState==='win'?0:0));
  if(this.gameState==='win') saveData.reachedStage=LEVELS.length;
  try{ if(hostRef && hostRef.saveState) hostRef.saveState({hiScore:saveData.hiScore, reachedStage:saveData.reachedStage}); }catch(e){}
},
spawnBoss: function(){
  if(this.bossSpawned) return;
  var cfg=LEVELS[this.curStage-1];
  this.bossSpawned=true;
  var bx=cfg.boss.x, by=GROUND_Y-22;
  if(cfg.boss.type==='tank'){
    this.boss=this.physics.add.image(bx,by,'tank_body');
    this.boss.setImmovable(true); this.boss.body.allowGravity=false;
    this.boss.body.setSize(80,28);
    this.bossParts=[];
    // 多部位：炮管 + 机枪口 + 车体
    var partGun=this.physics.add.image(bx+18, by-6, 'turret');
    partGun.setImmovable(true); partGun.body.allowGravity=false; partGun.body.setSize(22,10);
    partGun.isBossPart=true; partGun.hp=10; partGun.maxHp=10; partGun.score=300; partGun.broken=false;
    this.bossParts.push(partGun);
    var partBody=this.physics.add.image(bx-10, by+4, 'turret');
    partBody.setImmovable(true); partBody.body.allowGravity=false; partBody.body.setSize(26,14);
    partBody.isBossPart=true; partBody.hp=14; partBody.maxHp=14; partBody.score=400; partBody.broken=false;
    partBody.setTint(0x88ff88);
    this.bossParts.push(partBody);
    // 车体部位用小坦克图示意
    for(var i=0;i<this.bossParts.length;i++){
      var pp=this.bossParts[i];
      // 玩家弹与部位碰撞
      var self=this;
      (function(part){
        self.physics.add.overlap(self.bulletsP, part, function(a,b){ self.handlePlayerBulletHit(a,b); });
        self.physics.add.overlap(part, self.bulletsP, function(a,b){ self.handlePlayerBulletHit(a,b); });
      })(pp);
    }
    var self2=this;
    self2.boss.nextShoot=0;
    self2.boss.updateBoss=function(time){
      if(!self2.boss.active) return;
      // 炮管部位未破才射击
      if(self2.bossParts[0] && !self2.bossParts[0].broken && time>self2.boss.nextShoot){
        self2.boss.nextShoot=time+950;
        var sx=self2.boss.x-10, sy=self2.boss.y-6;
        var ang = Phaser.Math.Angle.Between(sx,sy, self2.player.x, self2.player.y);
        var sp=240;
        var eb=self2.physics.add.image(sx,sy,'bullet_e');
        eb.body.allowGravity=false; eb.setVelocity(Math.cos(ang)*sp, Math.sin(ang)*sp*0.6);
        eb.body.setSize(10,6);
        self2.bulletsE.add(eb);
        self2.time.delayedCall(2600,function(){ if(eb.active) try{eb.destroy();}catch(e){} });
      }
    };
  } else {
    // 直升机Boss：悬空，上下浮动，多部位：机身+旋翼+机枪
    this.boss=this.physics.add.image(bx, GROUND_Y-110, 'heli_body');
    this.boss.setImmovable(true); this.boss.body.allowGravity=false;
    this.boss.body.setSize(72,22);
    this.bossParts=[];
    var partRotor=this.physics.add.image(bx, GROUND_Y-126, 'turret');
    partRotor.setImmovable(true); partRotor.body.allowGravity=false; partRotor.body.setSize(28,8);
    partRotor.isBossPart=true; partRotor.hp=8; partRotor.maxHp=8; partRotor.score=300; partRotor.broken=false;
    partRotor.setTint(0xffaaaa);
    this.bossParts.push(partRotor);
    var partGun2=this.physics.add.image(bx-18, GROUND_Y-102, 'turret');
    partGun2.setImmovable(true); partGun2.body.allowGravity=false; partGun2.body.setSize(22,10);
    partGun2.isBossPart=true; partGun2.hp=10; partGun2.maxHp=10; partGun2.score=350; partGun2.broken=false;
    this.bossParts.push(partGun2);
    for(var j2=0;j2<this.bossParts.length;j2++){
      var pp2=this.bossParts[j2];
      var self3=this;
      (function(part){ self3.physics.add.overlap(self3.bulletsP, part, function(a,b){ self3.handlePlayerBulletHit(a,b); }); self3.physics.add.overlap(part, self3.bulletsP, function(a,b){ self3.handlePlayerBulletHit(a,b); }); })(pp2);
    }
    var self4=this;
    self4.boss.nextShoot=0; self4.boss.baseY=GROUND_Y-110; self4.boss.floatT=0;
    self4.boss.updateBoss=function(time,delta){
      if(!self4.boss.active) return;
      self4.boss.floatT += delta*0.0015;
      var ny = self4.boss.baseY + Math.sin(self4.boss.floatT*2.2)*18;
      self4.boss.y = ny;
      if(self4.bossParts[0]) self4.bossParts[0].y = ny-16;
      if(self4.bossParts[1]) self4.bossParts[1].y = ny+8;
      if(time>self4.boss.nextShoot){
        // 哪个部位没破就哪个射
        var shooter=null;
        for(var s=0;s<self4.bossParts.length;s++){ if(!self4.bossParts[s].broken){ shooter=self4.bossParts[s]; break; } }
        if(shooter){
          self4.boss.nextShoot=time+780;
          var sx2=shooter.x, sy2=shooter.y;
          var ang2 = Phaser.Math.Angle.Between(sx2,sy2, self4.player.x, self4.player.y);
          var eb2=self4.physics.add.image(sx2,sy2,'bullet_e');
          eb2.body.allowGravity=false; eb2.setVelocity(Math.cos(ang2)*260, Math.sin(ang2)*200);
          eb2.body.setSize(10,6);
          self4.bulletsE.add(eb2);
          self4.time.delayedCall(2600,function(){ if(eb2.active) try{eb2.destroy();}catch(e){} });
        }
      }
    };
  }
  Sfx.play('bossHit');
  this.cameras.main.shake(180,0.01);
},
maybeSpawnInfantry: function(){
  var cfg=LEVELS[this.curStage-1];
  var px=this.player.x;
  for(var i=0;i<cfg.infantryZones.length;i++){
    var z=cfg.infantryZones[i];
    if(z.spawned) continue;
    // 随卷轴生成：玩家接近该区 280px 内生成
    if(px > z.x - 420 && px < z.x + 420){
      z.spawned=true;
      for(var k=0;k<z.n;k++){
        var ex= z.x + (Math.random()*260-60);
        var inf=this.physics.add.image(ex,GROUND_Y-16,'infantry');
        inf.body.setSize(14,22);
        inf.hp=2; inf.maxHp=2; inf.nextShoot= this.time.now + 700 + Math.random()*600;
        inf.dir = (Math.random()<0.5?-1:1);
        inf.patrolL= ex-90; inf.patrolR= ex+90;
        inf.isTurret=false;
        this.enemies.add(inf);
      }
    }
  }
},
updateHud: function(){
  var hearts=''; for(var i=0;i<this.maxHp;i++) hearts+= (i<this.hp?'♥':'♡');
  if(this.inTank) hearts='TANK '+this.tankHp+'/'+this.tankMaxHp;
  this.hudScore.setText('SCORE '+this.score+'  HI '+saveData.hiScore);
  this.hudHp.setText('HP '+hearts);
  var wnames=['PISTOL','MACHINE','SHOTGUN'];
  var wname= wnames[this.weapon]||'PISTOL';
  var ammoStr= this.weapon===0?'∞': String(this.ammo);
  if(this.inTank) ammoStr='∞';
  this.hudWeapon.setText('WPN '+wname+' '+ammoStr);
  this.hudGren.setText('GRENADE x'+this.grenades+' [G]');
  var cfg=LEVELS[this.curStage-1];
  this.hudStage.setText('STAGE '+this.curStage+' '+(cfg?cfg.name:''));
},
playerDie: function(){
  if(this.isDead) return;
  this.isDead=true;
  this.gameState='dead';
  Sfx.play('hurt');
  Sfx.stopBgm();
  this.spawnExplosion(this.player.x,this.player.y,1.3);
  this.player.setVisible(false);
  if(this.playerTankSprite) this.playerTankSprite.setVisible(false);
  this.cameras.main.shake(220,0.012);
  this.saveProgress();
  this.showCenter('MISSION FAILED\n[R] 重试  [ENTER] 标题',999999,null);
},
update: function(time,delta){
  if(this.gameState==='title'){
    this.titleText.setVisible(true);
    this.centerText.setVisible(false);
    if(this.keys.SPACE.isDown || this.keys.ENTER.isDown){
      this.titleText.setVisible(false);
      this.loadStage(1);
      this.gameState='playing';
      this.isDead=false;
      this.hp=this.maxHp;
      this.score=0;
      this.grenades=5;
      this.weapon=0; this.ammo=0;
      // 重置 zones spawned
      for(var s=0;s<LEVELS.length;s++){ var cfg=LEVELS[s]; for(var z2=0;z2<cfg.infantryZones.length;z2++) cfg.infantryZones[z2].spawned=false; }
      this.updateHud();
    }
    return;
  }
  if(this.gameState==='dead' || this.gameState==='win'){
    if(Phaser.Input.Keyboard.JustDown(this.keys.R)){
      for(var s2=0;s2<LEVELS.length;s2++){ var cfg2=LEVELS[s2]; for(var z3=0;z3<cfg2.infantryZones.length;z3++) cfg2.infantryZones[z3].spawned=false; }
      this.scene.restart();
      // restart 会重走 create；为避免状态残留，直接重置关键位
      this.gameState='title'; this.isDead=false;
      return;
    }
    if(Phaser.Input.Keyboard.JustDown(this.keys.ENTER)){
      for(var s3=0;s3<LEVELS.length;s3++){ var cfg3=LEVELS[s3]; for(var z4=0;z4<cfg3.infantryZones.length;z4++) cfg3.infantryZones[z4].spawned=false; }
      this.scene.restart();
      return;
    }
    return;
  }
  if(this.gameState!=='playing') return;
  if(this.isDead) return;
  if(!this.player || !this.player.active) return;

  // 视差滚动
  if(this.bgFar) this.bgFar.tilePositionX = this.cameras.main.scrollX*0.18;
  if(this.bgNear) this.bgNear.tilePositionX = this.cameras.main.scrollX*0.42;

  var left = this.keys.LEFT.isDown||this.keys.A.isDown;
  var right= this.keys.RIGHT.isDown||this.keys.D.isDown;
  var upW  = this.keys.W.isDown||this.keys.UP.isDown||this.keys.SPACE.isDown;
  var down = this.keyC.isDown||this.keys.S.isDown||this.keys.DOWN.isDown;
  var shootHeld = this.keyX.isDown || this.input.activePointer.isDown;
  // 下蹲
  this.isCrouch = down && this.player.body.blocked.down;

  // 左右跑
  var target=0;
  if(left) target=-MOVE_SPEED;
  else if(right) target=MOVE_SPEED;
  if(this.inTank){
    // 坦克移动稍慢但可压制
    if(left) target=-160;
    else if(right) target=160;
    else target=0;
  }
  var vx=this.player.body.velocity.x;
  var step = MOVE_SPEED*0.18;
  if(target!==0){
    this.facing = target>0?1:-1;
    if(Math.sign(vx)!==Math.sign(target) && vx!==0) vx*=0.4;
    if(vx<target) vx=Math.min(target, vx+step*delta/16);
    else if(vx>target) vx=Math.max(target, vx-step*delta/16);
    else vx=target;
  } else {
    if(Math.abs(vx)< 18) vx=0;
    else vx -= Math.sign(vx)* 22*delta/16;
  }
  this.player.setVelocityX(vx);
  // 坦克贴图跟随 — 传送用 body.reset 语义，跟随直接 setPosition 同步
  if(this.inTank && this.playerTankSprite){
    this.playerTankSprite.setPosition(this.player.x, this.player.y+2);
    this.playerTankSprite.setFlipX(this.facing<0);
  }

  // 外观切换
  var wantTex = this.isCrouch? 'player_crouch' : 'player_stand';
  if(this.inTank) wantTex=null;
  if(wantTex && this.player.texture.key!==wantTex){
    this.player.setTexture(wantTex);
    if(this.isCrouch){ this.player.body.setSize(14,16); this.player.body.setOffset(5,6); }
    else { this.player.body.setSize(14,28); this.player.body.setOffset(3,4); }
  }
  if(!this.inTank){
    this.player.setFlipX(this.facing<0);
  }

  // 跳跃 土狼+缓冲
  var onGround=this.player.body.blocked.down;
  if(onGround) this.coyote=COYOTE_MS; else this.coyote=Math.max(0,this.coyote-delta);
  if(upW) this.buffer=BUFFER_MS; else this.buffer=Math.max(0,this.buffer-delta);
  var wantJump=false;
  if(this.buffer>0 && this.coyote>0) wantJump=true;
  // 首次按下才跳，避免按住连跳
  if(wantJump && !this.jumpHeld){
    this.player.setVelocityY(-JUMP_VEL);
    this.coyote=0; this.buffer=0; this.jumpHeld=true; this.hasJumpCut=false;
    Sfx.play('jump');
  }
  if(!upW) this.jumpHeld=false;
  // 可变跳高：松键截断
  if(!upW && this.player.body.velocity.y< -80 && !this.hasJumpCut){
    this.player.setVelocityY(this.player.body.velocity.y*0.42);
    this.hasJumpCut=true;
  }
  if(this.player.body.velocity.y>TERMINAL_VY) this.player.setVelocityY(TERMINAL_VY);

  // 射击
  if(shootHeld) this.tryShoot();
  if(Phaser.Input.Keyboard.JustDown(this.keyG)) this.throwGrenade();

  // 人质跟随：排队跟在玩家身后
  for(var fi=0; fi<this.followers.length; fi++){
    var fol=this.followers[fi];
    if(!fol.active) continue;
    var tx = this.player.x - this.facing* (22+ fi*14);
    var ty = this.player.y;
    var dx= tx - fol.x;
    fol.setVelocityX( Phaser.Math.Clamp(dx*4, -140, 140) );
    // 简单重力跟随：保持在地面
    if(fol.y > GROUND_Y-10) { try{ fol.body.reset(fol.x, GROUND_Y-16); }catch(e){ fol.y=GROUND_Y-16; fol.setVelocityY(0); } }
    // 若掉队太远直接传送
    if(Math.abs(dx)>180) { try{ fol.body.reset(tx, GROUND_Y-16); }catch(e){ fol.x=tx; } }
  }

  // 随卷轴生成步兵
  this.maybeSpawnInfantry();

  // 步兵 AI：左右巡逻 + 射击
  var ens=this.enemies.getChildren();
  for(var ei=0; ei<ens.length; ei++){
    var en=ens[ei];
    if(!en.active) continue;
    // 巡逻
    if(en.x<=en.patrolL) en.dir=1;
    else if(en.x>=en.patrolR) en.dir=-1;
    en.setVelocityX(en.dir*ENEMY_SPEED*0.7);
    en.setFlipX(en.dir<0);
    // 射击：玩家在视距内
    if(time>en.nextShoot && Math.abs(en.x - this.player.x)< 380 && Math.abs(en.y - this.player.y)< 80){
      en.nextShoot=time+ ENEMY_SHOOT_MS + Math.random()*600;
      var dir2 = (this.player.x>en.x?1:-1);
      var eb=en.scene.physics.add.image(en.x+dir2*10, en.y-4, 'bullet_e');
      eb.body.allowGravity=false; eb.setVelocityX(dir2*260); eb.body.setSize(10,6);
      this.bulletsE.add(eb);
      this.time.delayedCall(2200,function(b){ return function(){ if(b.active) try{b.destroy();}catch(e){} }; }(eb));
    }
    // 触碰玩家（非坦克才受伤）
    if(!this.inTank && Phaser.Math.Distance.Between(en.x,en.y,this.player.x,this.player.y)< 22){
      if(time>=this.invUntil){
        this.hp-=1; this.invUntil=time+HURT_INV_MS; Sfx.play('hurt');
        if(this.hp<=0) this.playerDie();
        else {
          var self5=this;
          var t5=self5.time.addEvent({delay:90,loop:true,callback:function(){
            if(!self5.player || self5.time.now>=self5.invUntil){ if(self5.player) self5.player.setAlpha(1); t5.remove(false); return; }
            self5.player.setAlpha(self5.player.alpha===1?0.35:1);
          }});
        }
        this.updateHud();
        // 击退
        en.dir*=-1;
      }
    }
  }

  // 炮台射击
  var turs=this.turrets.getChildren();
  for(var ti2=0; ti2<turs.length; ti2++){
    var tu=turs[ti2];
    if(!tu.active) continue;
    if(time>tu.nextShoot && Math.abs(tu.x - this.player.x)< 520){
      tu.nextShoot=time+ TURRET_SHOOT_MS + Math.random()*400;
      var ang3 = Phaser.Math.Angle.Between(tu.x, tu.y, this.player.x, this.player.y-6);
      var eb3=this.physics.add.image(tu.x, tu.y-4, 'bullet_e');
      eb3.body.allowGravity=false; eb3.setVelocity(Math.cos(ang3)*240, Math.sin(ang3)*160);
      eb3.body.setSize(10,6);
      this.bulletsE.add(eb3);
      this.time.delayedCall(2600,function(b){ return function(){ if(b.active) try{b.destroy();}catch(e){} }; }(eb3));
    }
  }

  // Boss 触发：玩家到达 boss 区 180px 内
  var cfgNow=LEVELS[this.curStage-1];
  if(!this.bossSpawned && this.player.x > cfgNow.boss.x - 260){
    this.spawnBoss();
  }
  if(this.boss && this.boss.active && this.boss.updateBoss){
    this.boss.updateBoss(time,delta);
  }

  // grenade 触地/超时爆炸
  var gs=this.grenadesG.getChildren().slice();
  for(var gi=0; gi<gs.length; gi++){
    var gg=gs[gi];
    if(!gg.active) continue;
    if(gg.body.blocked.down || time - gg.spawnTime>2200){
      this.explodeGrenade(gg);
    }
  }

  // 子弹越界清理
  var bps=this.bulletsP.getChildren().slice();
  for(var bi=0; bi<bps.length; bi++){ var bp=bps[bi]; if(bp.x< this.cameras.main.scrollX-80 || bp.x> this.cameras.main.scrollX+1100) try{bp.destroy();}catch(e){} }
  var bes=this.bulletsE.getChildren().slice();
  for(var be2i=0; be2i<bes.length; be2i++){ var be2=bes[be2i]; if(be2.x< this.cameras.main.scrollX-80 || be2.x> this.cameras.main.scrollX+1100 || be2.y< -40 || be2.y> WORLD_H+40) try{be2.destroy();}catch(e){} }

  // 掉坑死亡（战壕不算坑，真正掉出世界底）
  if(this.player.y > WORLD_H+60) this.playerDie();

  // 阶段推进兜底：若 Boss 已死且玩家走到世界末
  if(this.stageCleared && this.player.x > this.worldW-60){
    if(this.curStage<LEVELS.length){
      // 已在 bossDead 中切关，这里仅防漏
    }
  }

  // 无敌闪烁恢复
  if(this.time.now>=this.invUntil && this.player.alpha!==1) this.player.setAlpha(1);

  this.updateHud();
}
});

var hostW=960, hostH=540;
window.TRGames=window.TRGames||{register:function(){},_r:{}};
window.TRGames.register({
  id:'metalslug',
  title:'Metal Slug 横版突击',
  launch:function(host){
    hostRef=host;
    var W=host.width||hostW, H=host.height||hostH;
    if(host.loadState){
      try{ host.loadState().then(function(d){
        if(d && typeof d==='object'){
          if(typeof d.hiScore==='number') saveData.hiScore=d.hiScore;
          if(typeof d.reachedStage==='number') saveData.reachedStage=d.reachedStage;
        }
      },function(){});}catch(e){}
    }
    var game=new Phaser.Game({
      type:Phaser.AUTO,
      parent:host.container,
      width:W, height:H,
      backgroundColor:'#87c1e8',
      physics:{ default:'arcade', arcade:{ gravity:{y:GRAVITY,x:0}, debug:false } },
      scene:[MainScene]
    });
    sceneRef=null;
    var tryBind=function(){ try{ var s=game.scene.getScene('Main'); if(s) sceneRef=s; }catch(e){} };
    setTimeout(tryBind,400);
    game.events.on('ready',tryBind);
    window.__trgame={ game:game, getState:getState, getScene:function(){ return sceneRef; }, getSave:function(){ return {hiScore:saveData.hiScore, reachedStage:saveData.reachedStage}; } };
    return game;
  }
});
})();
