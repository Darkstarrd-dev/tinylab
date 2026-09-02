(function(){
'use strict';
var FKO=window.FKO;
FKO.FighterEntity=function(scene,charId,playerId){
  this.scene=scene;
  this.charDef=FKO.getCharacter(charId)||FKO.CHARACTERS[0];
  this.playerId=playerId;
  this.x=0;this.y=0;this.vx=0;this.vy=0;
  this.facing=playerId===1?1:-1;
  this.hp=this.charDef.hp;
  this.maxHp=this.charDef.hp;
  this.meter=0;
  this.onGround=true;
  this.crouching=false;
  this.blocking=false;
  this.blockIsCrouch=false;
  this.attacking=false;
  this.currentMove=null;
  this.movePhase=0;
  this.moveTimer=0;
  this.hitstun=0;
  this.blockstun=0;
  this.invUntil=0;
  this.isKnocked=false;
  this.downUntil=0;
  this.comboCount=0;
  this.lastHitTime=0;
  this.inputBuffer=new FKO.InputBuffer();
  this.container=null;
  this.ragdollParts={};
};
FKO.FighterEntity.prototype.update=function(time,delta){
  var now=time;
  if(this.isKnocked && now>=this.downUntil){
    this.isKnocked=false;
    this.invUntil=now+220;
    this.hitstun=0;
    this.blockstun=0;
    this.vx*=0.5;
  }
  if(this.hitstun>0){
    this.hitstun-=delta;
    if(this.hitstun<=0){ this.hitstun=0; this.attacking=false; }
  }
  if(this.blockstun>0){
    this.blockstun-=delta;
    if(this.blockstun<=0) this.blockstun=0;
  }
  if(this.attacking && this.currentMove){
    this.moveTimer-=delta;
    if(this.movePhase===0){
      if(this.moveTimer<=0){
        this.movePhase=1;
        var act=this.currentMove.active||90;
        this.moveTimer=Math.min(act,90);
      }
    } else if(this.movePhase===1){
      if(this.moveTimer<=0){
        this.movePhase=2;
        this.moveTimer=this.currentMove.rec||160;
      }
    } else if(this.movePhase===2){
      if(this.moveTimer<=0){
        this.attacking=false;
        this.currentMove=null;
        this.movePhase=0;
        this.moveTimer=0;
      }
    }
  }
  if(this.comboCount>0 && (now - this.lastHitTime) > FKO.CFG.COMBO_WINDOW_MS){
    this.comboCount=0;
    this.lastHitTime=0;
  }
};
FKO.FighterEntity.prototype.startMove=function(moveId){
  if(this.hitstun>0||this.blockstun>0||this.isKnocked||this.attacking) return false;
  var move=FKO.getMove(this.charDef.id, moveId);
  if(!move) return false;
  if(move.meterCost && this.meter < move.meterCost) return false;
  if(move.meterCost) this.meter-=move.meterCost;
  this.attacking=true;
  this.currentMove=move;
  this.movePhase=0;
  this.moveTimer=move.startup||80;
  var now=this.scene.time ? this.scene.time.now : Date.now();
  if(move.motion==='dp'){
    this.invUntil=now+260;
    this.onGround=false;
    this.vy=-520;
    this.vx=this.facing*90;
  } else if(move.super){
    this.invUntil=now+120;
  }
  try{ if(FKO.Sfx) FKO.Sfx.play(move.super?'super': move.motion==='dp'?'shoryu':'punch'); }catch(e){}
  return true;
};
FKO.FighterEntity.prototype.takeDamage=function(damage,move,attacker){
  var now=this.scene.time ? this.scene.time.now : Date.now();
  if(now < this.invUntil || this.isKnocked) return false;
  var isBlocked=this.blocking;
  if(isBlocked){
    this.hp-= (move.chip||0);
    if(this.hp<0) this.hp=0;
    this.blockstun=move.bs||140;
    this.vx=attacker.facing*(move.push||10)*0.6;
    this.meter=Math.min(FKO.CFG.METER_MAX, this.meter+2);
    return 'block';
  } else {
    this.hp-= (move.dmg||6);
    if(this.hp<0) this.hp=0;
    this.hitstun=move.hs||260;
    this.vx=attacker.facing*(move.push||10)*1.1;
    this.vy= move.kd ? -160 : 0;
    if(move.kd && this.hp>0){
      this.isKnocked=true;
      this.downUntil=now+700;
      this.hitstun=0;
      this.vy=-220;
      this.vx=attacker.facing*120;
    }
    this.meter=Math.min(FKO.CFG.METER_MAX, this.meter+3);
    if(attacker){
      attacker.meter=Math.min(FKO.CFG.METER_MAX, attacker.meter+(move.meterGain||0));
      attacker.comboCount=(attacker.comboCount||0)+1;
      attacker.lastHitTime=now;
    }
    return 'hit';
  }
};
FKO.FighterEntity.prototype.createRagdoll=function(){
  var scene=this.scene;
  var def=this.charDef;
  this.container=scene.add.container(this.x, this.y);
  try{ this.container.setDepth(10); }catch(e){}
  var parts=def.ragdoll||{};
  var keys=['head','torso','armL','armR','legL','legR'];
  for(var i=0;i<keys.length;i++){
    var k=keys[i];
    var p=parts[k];
    if(!p) continue;
    var g=scene.add.graphics();
    g.fillStyle(p.color||0xffffff, 1);
    g.fillRoundedRect(p.ox - p.w/2, p.oy - p.h/2, p.w, p.h, 3);
    this.container.add(g);
    this.ragdollParts[k]=g;
  }
};
FKO.FighterEntity.prototype.syncVisual=function(){
  if(!this.container) return;
  this.container.x=this.x;
  this.container.y=this.y;
  try{
    this.container.setScale(this.facing, this.crouching?0.72:1);
  }catch(e){
    try{ this.container.scaleX=this.facing; this.container.scaleY=this.crouching?0.72:1; }catch(e2){}
  }
  var alpha=1;
  if(this.hitstun>0) alpha=0.8;
  else if(this.blockstun>0) alpha=0.9;
  try{ this.container.setAlpha(alpha); }catch(e){ try{ this.container.alpha=alpha; }catch(e2){} }
};
FKO.FighterEntity.prototype.destroy=function(){
  if(this.container) try{ this.container.destroy(); }catch(e){}
  this.container=null;
};
})();
