(function(){
'use strict';
var FKO=window.FKO;
FKO.FightScene=function(){ Phaser.Scene.call(this,{key:'Fight'}); };
FKO.FightScene.prototype=Object.create(Phaser.Scene.prototype);
FKO.FightScene.prototype.constructor=FKO.FightScene;

FKO.FightScene.prototype.create=function(){
  FKO.sceneRef=this;
  try{ if(FKO.Sfx) FKO.Sfx.ensure(); }catch(e){}
  var w=this.scale.width, h=this.scale.height;
  // 1x1 pixel 纹理
  try{
    if(!this.textures.exists('pixel')){
      var g=this.add.graphics();
      g.fillStyle(0xffffff,1); g.fillRect(0,0,1,1);
      g.generateTexture('pixel',1,1); g.destroy();
    }
  }catch(e){}
  this.w=w; this.h=h;
  this.stageMgr=new FKO.StageManager(this, FKO.save.stageId);
  try{ this.cameras.main.setBackgroundColor(this.stageMgr.stageDef.bg); }catch(e){}
  // 远景拉伸 pixel
  var stageColorHex=this.stageMgr.stageDef.bg;
  var stageCol=0xffffff;
  try{ stageCol=Phaser.Display.Color.HexStringToColor(stageColorHex).color; }catch(e){ stageCol=0xb8a07a; }
  this.bgImg=this.add.image(w/2, h*0.42, 'pixel').setOrigin(0.5).setDepth(0);
  try{ this.bgImg.setDisplaySize(w*0.92, 180); }catch(e){}
  try{ this.bgImg.setTint(stageCol); }catch(e){}
  this.bgImg.setAlpha(0.95);
  // 地面
  var groundH=h - FKO.CFG.GROUND_Y;
  this.ground=this.add.tileSprite(0, FKO.CFG.GROUND_Y, w, groundH, 'pixel').setOrigin(0,0).setDepth(1);
  try{ this.ground.setTint(0x3a3a4a); }catch(e){}
  // 角色
  this.fighter1=new FKO.FighterEntity(this, FKO.save.p1CharId, 1);
  this.fighter2=new FKO.FighterEntity(this, FKO.save.p2CharId, 2);
  this.fighter1.createRagdoll();
  this.fighter2.createRagdoll();
  this.resetPositions();
  this.updateFacing();
  this.roundMgr=new FKO.RoundManager(this);
  // hit debug
  this.hitDebugP1=this.add.graphics().setDepth(11);
  this.hitDebugP2=this.add.graphics().setDepth(11);
  this.showHitbox=false;
  // 输入
  this.keysP1=this.input.keyboard.addKeys({
    W: Phaser.Input.Keyboard.KeyCodes.W,
    A: Phaser.Input.Keyboard.KeyCodes.A,
    S: Phaser.Input.Keyboard.KeyCodes.S,
    D: Phaser.Input.Keyboard.KeyCodes.D,
    F: Phaser.Input.Keyboard.KeyCodes.F,
    G: Phaser.Input.Keyboard.KeyCodes.G,
    H: Phaser.Input.Keyboard.KeyCodes.H,
    J: Phaser.Input.Keyboard.KeyCodes.J
  });
  this.keysP2=this.input.keyboard.addKeys({
    UP: Phaser.Input.Keyboard.KeyCodes.UP,
    DOWN: Phaser.Input.Keyboard.KeyCodes.DOWN,
    LEFT: Phaser.Input.Keyboard.KeyCodes.LEFT,
    RIGHT: Phaser.Input.Keyboard.KeyCodes.RIGHT,
    NUM1: Phaser.Input.Keyboard.KeyCodes.NUMPAD_ONE,
    NUM2: Phaser.Input.Keyboard.KeyCodes.NUMPAD_TWO,
    NUM3: Phaser.Input.Keyboard.KeyCodes.NUMPAD_THREE,
    NUM6: Phaser.Input.Keyboard.KeyCodes.NUMPAD_SIX
  });
  // 映射为 InputSystem 期望的键名
  this.keysP1.up=this.keysP1.W; this.keysP1.down=this.keysP1.S; this.keysP1.left=this.keysP1.A; this.keysP1.right=this.keysP1.D;
  this.keysP1.A=this.keysP1.F; this.keysP1.B=this.keysP1.G; this.keysP1.C=this.keysP1.H; this.keysP1.D=this.keysP1.J;
  this.keysP2.up=this.keysP2.UP; this.keysP2.down=this.keysP2.DOWN; this.keysP2.left=this.keysP2.LEFT; this.keysP2.right=this.keysP2.RIGHT;
  this.keysP2.A=this.keysP2.NUM1; this.keysP2.B=this.keysP2.NUM2; this.keysP2.C=this.keysP2.NUM3; this.keysP2.D=this.keysP2.NUM6;

  this.keyR=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
  this.keyM=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.M);
  this.keyO=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.O);
  this.keyK=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.K);
  this.keyEnter=this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);

  this.hud=new FKO.Hud(this);
  this.hud.create();
  this.hud.update(this.fighter1, this.fighter2, this.roundMgr);

  this.hitStopUntil=0;
  try{ if(FKO.Sfx) FKO.Sfx.startBgm(this, this.stageMgr.stageId); }catch(e){}
  this.showRoundBanner();
};

FKO.FightScene.prototype.resetPositions=function(){
  var cx=this.w/2, gy=FKO.CFG.GROUND_Y;
  var f1=this.fighter1, f2=this.fighter2;
  if(f1){ f1.x=cx-180; f1.y=gy; f1.vx=0; f1.vy=0; f1.onGround=true; f1.crouching=false; f1.blocking=false; f1.hitstun=0; f1.blockstun=0; f1.attacking=false; f1.currentMove=null; f1.movePhase=0; f1.moveTimer=0; f1.isKnocked=false; f1.downUntil=0; }
  if(f2){ f2.x=cx+180; f2.y=gy; f2.vx=0; f2.vy=0; f2.onGround=true; f2.crouching=false; f2.blocking=false; f2.hitstun=0; f2.blockstun=0; f2.attacking=false; f2.currentMove=null; f2.movePhase=0; f2.moveTimer=0; f2.isKnocked=false; f2.downUntil=0; }
  this.updateFacing();
};

FKO.FightScene.prototype.updateFacing=function(){
  if(!this.fighter1||!this.fighter2) return;
  if(this.fighter1.x < this.fighter2.x){ this.fighter1.facing=1; this.fighter2.facing=-1; }
  else { this.fighter1.facing=-1; this.fighter2.facing=1; }
};

FKO.FightScene.prototype.showRoundBanner=function(){
  var stageName=this.stageMgr?this.stageMgr.stageDef.name:'';
  var text='ROUND '+this.roundMgr.round+'\n'+stageName+'\n\u2014 FIGHT! \u2014';
  this.hud.showBanner(text);
  this.roundMgr.roundOver=true;
  var self=this;
  this.time.delayedCall(900, function(){ self.roundMgr.roundOver=false; });
};

FKO.FightScene.prototype.showMatchOver=function(winner){
  var text='K.O.!\n'+(winner===1?'P1 WINS':'P2 WINS')+'  '+this.roundMgr.p1Wins+'-'+this.roundMgr.p2Wins+'\n[Enter] \u91CD\u8D5B  [M] \u83DC\u5355';
  this.hud.showBanner(text);
  FKO.save.wins=(FKO.save.wins||0)+1;
  this.saveProgress();
};

FKO.FightScene.prototype.saveProgress=function(){
  try{ if(FKO.hostRef&&FKO.hostRef.saveState) FKO.hostRef.saveState(FKO.save).then(function(){},function(){}); }catch(e){}
};

FKO.FightScene.prototype.spawnHitNum=function(x,y,text,color){
  var t=this.add.text(x, y, text, {fontFamily:'monospace',fontSize:'14px',color:color,stroke:'#000000',strokeThickness:3}).setOrigin(0.5).setDepth(25);
  try{ this.tweens.add({targets:t,y:y-28,alpha:0,duration:420,onComplete:function(){ try{t.destroy();}catch(e){}}}); }catch(e){ setTimeout(function(){ try{t.destroy();}catch(e2){} },420); }
};

FKO.FightScene.prototype.update=function(time,delta){
  // 全局键
  try{
    if(Phaser.Input.Keyboard.JustDown(this.keyR)){
      // 重开 BO3
      this.roundMgr.round=1; this.roundMgr.p1Wins=0; this.roundMgr.p2Wins=0; this.roundMgr.matchOver=false; this.roundMgr.roundOver=false;
      this.fighter1.hp=this.fighter1.maxHp; this.fighter2.hp=this.fighter2.maxHp;
      this.fighter1.meter=0; this.fighter2.meter=0;
      this.fighter1.isKnocked=false; this.fighter2.isKnocked=false;
      this.fighter1.hitstun=0; this.fighter1.blockstun=0; this.fighter2.hitstun=0; this.fighter2.blockstun=0;
      this.fighter1.attacking=false; this.fighter2.attacking=false;
      this.resetPositions();
      this.hud.update(this.fighter1,this.fighter2,this.roundMgr);
      try{ if(FKO.Sfx) FKO.Sfx.startBgm(this,this.stageMgr.stageId); }catch(e){}
      this.showRoundBanner();
    }
  }catch(e){}
  try{
    if(Phaser.Input.Keyboard.JustDown(this.keyM)){
      try{ if(FKO.Sfx) FKO.Sfx.stopBgm(); }catch(e){}
      this.scene.start('CharacterSelect');
      return;
    }
  }catch(e){}
  try{
    if(Phaser.Input.Keyboard.JustDown(this.keyO)){
      this.showHitbox=!this.showHitbox;
      if(!this.showHitbox){ try{ this.hitDebugP1.clear(); this.hitDebugP2.clear(); }catch(e){} }
    }
  }catch(e){}
  try{
    if(Phaser.Input.Keyboard.JustDown(this.keyK)){
      var next=(this.stageMgr.stageId+1)%FKO.STAGES.length;
      this.stageMgr.setStage(next);
      FKO.save.stageId=next;
      var colHex=this.stageMgr.stageDef.bg;
      var col=0xffffff;
      try{ col=Phaser.Display.Color.HexStringToColor(colHex).color; }catch(e){}
      try{ this.bgImg.setTint(col); }catch(e){}
      try{ if(FKO.Sfx) FKO.Sfx.startBgm(this, next); }catch(e){}
    }
  }catch(e){}

  if(this.roundMgr.matchOver){
    try{
      if(Phaser.Input.Keyboard.JustDown(this.keyEnter)){
        this.roundMgr.round=1; this.roundMgr.p1Wins=0; this.roundMgr.p2Wins=0; this.roundMgr.matchOver=false;
        this.fighter1.hp=this.fighter1.maxHp; this.fighter2.hp=this.fighter2.maxHp;
        this.fighter1.meter=0; this.fighter2.meter=0;
        this.fighter1.isKnocked=false; this.fighter2.isKnocked=false;
        this.resetPositions();
        this.hud.update(this.fighter1,this.fighter2,this.roundMgr);
        try{ if(FKO.Sfx) FKO.Sfx.startBgm(this,this.stageMgr.stageId); }catch(e){}
        this.showRoundBanner();
      }
    }catch(e){}
    this.fighter1.syncVisual(); this.fighter2.syncVisual();
    this.drawHitDebug();
    this.hud.update(this.fighter1,this.fighter2,this.roundMgr);
    return;
  }
  if(this.roundMgr.roundOver){
    this.fighter1.syncVisual(); this.fighter2.syncVisual();
    this.drawHitDebug();
    this.hud.update(this.fighter1,this.fighter2,this.roundMgr);
    return;
  }
  if(time < this.hitStopUntil){
    this.drawHitDebug();
    return;
  }

  //  fighter update
  this.fighter1.update(time, delta);
  this.fighter2.update(time, delta);

  // InputSystem sample
  FKO.InputSystem.sample(this, this.fighter1, this.keysP1);
  FKO.InputSystem.sample(this, this.fighter2, this.keysP2);

  // 物理积分
  var dt=delta/1000;
  var fighters=[this.fighter1,this.fighter2];
  for(var i=0;i<fighters.length;i++){
    var f=fighters[i];
    if(f.isKnocked){
      f.vy+=FKO.CFG.GRAVITY*dt;
      f.x+=f.vx*dt;
      f.y+=f.vy*dt;
      if(f.y>=FKO.CFG.GROUND_Y){
        f.y=FKO.CFG.GROUND_Y;
        f.vy=-f.vy*0.22;
        f.vx*=0.65;
        if(Math.abs(f.vy)<30) f.vy=0;
      }
      // 墙
      if(f.x<24) { f.x=24; f.vx=0; }
      if(f.x>this.w-24) { f.x=this.w-24; f.vx=0; }
      continue;
    }
    // 非倒地
    if(f.hitstun>0){
      f.vx*=0.96;
    }
    // dp 上冲保留
    if(f.currentMove && f.currentMove.motion==='dp' && f.movePhase===0){
      // vy 已在 startMove 设置，随重力继续
      f.vy+=FKO.CFG.GRAVITY*dt*0.6;
    } else {
      if(!f.onGround){
        f.vy+=FKO.CFG.GRAVITY*dt;
      } else {
        // 地面摩擦在下方处理
      }
    }
    if(!f.onGround){
      f.y+=f.vy*dt;
      f.x+=f.vx*dt;
      if(f.y>=FKO.CFG.GROUND_Y){
        f.y=FKO.CFG.GROUND_Y;
        f.vy=0;
        f.onGround=true;
        f.vx*=0.82;
      } else {
        f.vx*=0.99;
        // 空中水平摩擦
        f.vx*=0.99;
      }
    } else {
      // 地面：若未受击且可移动时 InputSystem 已设 vx，此处仅摩擦
      f.x+=f.vx*dt;
      // 地面摩擦
      if(f.attacking) f.vx*=0.94;
      else f.vx*=0.88;
    }
    // 墙
    if(f.x<24) { f.x=24; f.vx=0; }
    if(f.x>this.w-24) { f.x=this.w-24; f.vx=0; }
  }

  // 互推
  var dx=this.fighter2.x - this.fighter1.x;
  var adx=Math.abs(dx);
  var sep=28;
  if(adx < sep && adx>0.01){
    var push=(sep - adx)*0.5 + 0.6;
    if(dx>0){ this.fighter1.x-=push; this.fighter2.x+=push; }
    else { this.fighter1.x+=push; this.fighter2.x-=push; }
  }

  this.updateFacing();

  // 判定
  FKO.HitSystem.checkHit(this, this.fighter1, this.fighter2);
  FKO.HitSystem.checkHit(this, this.fighter2, this.fighter1);

  // KO 检测
  if(!this.roundMgr.roundOver && !this.roundMgr.matchOver){
    if(this.fighter1.hp<=0){
      this.roundMgr.onKO(1);
    } else if(this.fighter2.hp<=0){
      this.roundMgr.onKO(2);
    }
  }

  this.fighter1.syncVisual();
  this.fighter2.syncVisual();
  this.drawHitDebug();
  this.hud.update(this.fighter1, this.fighter2, this.roundMgr);
};

FKO.FightScene.prototype.drawHitDebug=function(){
  try{ this.hitDebugP1.clear(); }catch(e){}
  try{ this.hitDebugP2.clear(); }catch(e){}
  if(!this.showHitbox) return;
  var now=this.time.now;
  var pairs=[[this.fighter1,this.hitDebugP1],[this.fighter2,this.hitDebugP2]];
  for(var i=0;i<pairs.length;i++){
    var f=pairs[i][0], g=pairs[i][1];
    if(!f||!g) continue;
    // hurt
    var hurt=FKO.calcHurtbox(f);
    g.lineStyle(1, 0x66bb6a, 0.9);
    g.fillStyle(0x66bb6a, 0.12);
    g.fillRect(hurt.x, hurt.y, hurt.w, hurt.h);
    g.strokeRect(hurt.x, hurt.y, hurt.w, hurt.h);
    // push
    var push=FKO.calcPushbox(f);
    g.lineStyle(1, 0x3498db, 0.7);
    g.strokeRect(push.x, push.y, push.w, push.h);
    // hit
    if(f.attacking && f.movePhase===1 && f.currentMove && f.currentMove.hitboxes && f.currentMove.hitboxes.length){
      var hb=f.currentMove.hitboxes[0];
      var atkBox=FKO.calcHitbox(f,hb);
      g.lineStyle(2, 0xef5350, 0.95);
      g.fillStyle(0xef5350, 0.18);
      g.fillRect(atkBox.x, atkBox.y, atkBox.w, atkBox.h);
      g.strokeRect(atkBox.x, atkBox.y, atkBox.w, atkBox.h);
    }
    // inv
    if(now < f.invUntil){
      var hb2=FKO.calcHurtbox(f);
      g.lineStyle(2, 0xffffff, 0.9);
      g.strokeRect(hb2.x-2, hb2.y-2, hb2.w+4, hb2.h+4);
    }
  }
};
})();
