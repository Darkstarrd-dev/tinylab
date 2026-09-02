(function(){
'use strict';
var FKO=window.FKO;
FKO.RoundManager=function(scene){
  this.scene=scene;
  this.round=1;
  this.p1Wins=0;
  this.p2Wins=0;
  this.roundOver=false;
  this.matchOver=false;
};
FKO.RoundManager.prototype.startRound=function(){
  this.roundOver=false;
  var s=this.scene;
  if(s.fighter1){ s.fighter1.hp=s.fighter1.maxHp; s.fighter1.meter=0; s.fighter1.isKnocked=false; s.fighter1.hitstun=0; s.fighter1.blockstun=0; s.fighter1.attacking=false; s.fighter1.currentMove=null; }
  if(s.fighter2){ s.fighter2.hp=s.fighter2.maxHp; s.fighter2.meter=0; s.fighter2.isKnocked=false; s.fighter2.hitstun=0; s.fighter2.blockstun=0; s.fighter2.attacking=false; s.fighter2.currentMove=null; }
  s.resetPositions();
  s.showRoundBanner();
};
FKO.RoundManager.prototype.onKO=function(loser){
  if(this.roundOver) return;
  this.roundOver=true;
  var winner=loser===1?2:1;
  if(winner===1) this.p1Wins++; else this.p2Wins++;
  var loserF=winner===1?this.scene.fighter2:this.scene.fighter1;
  if(loserF){
    loserF.isKnocked=true;
    loserF.downUntil=this.scene.time.now+1500;
    loserF.vy=-180;
    loserF.vx=(winner===1?1:-1)*40;
    loserF.hitstun=0;
    loserF.attacking=false;
  }
  try{ if(FKO.Sfx) FKO.Sfx.play('ko'); }catch(e){}
  try{ if(FKO.Sfx) FKO.Sfx.stopBgm(); }catch(e){}
  var self=this;
  if(this.p1Wins>=FKO.CFG.BO3 || this.p2Wins>=FKO.CFG.BO3){
    this.matchOver=true;
    this.scene.showMatchOver(winner);
  } else {
    this.scene.time.delayedCall(FKO.CFG.KO_DELAY_MS+400, function(){
      if(self.matchOver) return;
      self.round++;
      self.startRound();
    });
  }
};
})();
