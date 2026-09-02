(function(){
'use strict';
var FKO=window.FKO;
FKO.HitSystem={
  checkHit:function(scene,attacker,victim){
    if(!attacker.attacking||attacker.movePhase!==1) return false;
    if(victim.isKnocked||scene.time.now<victim.invUntil) return false;
    var move=attacker.currentMove;
    if(!move||!move.hitboxes||!move.hitboxes.length) return false;
    var hbox=move.hitboxes[0];
    var atkBox=FKO.calcHitbox(attacker,hbox);
    var hurtBox=FKO.calcHurtbox(victim);
    if(FKO.rectIntersects(atkBox.x,atkBox.y,atkBox.w,atkBox.h,hurtBox.x,hurtBox.y,hurtBox.w,hurtBox.h)){
      var result=victim.takeDamage(0,move,attacker);
      if(result==='hit'||result==='block'){
        scene.hitStopUntil=scene.time.now+FKO.CFG.HITSTOP_MS;
        scene.spawnHitNum(victim.x,victim.y-60,result==='block'?'BLOCK':'-'+move.dmg,result==='block'?'#90caf9':'#ff8a80');
        if(result==='hit'){
          try{ if(FKO.Sfx) FKO.Sfx.play('hit'); }catch(e){}
        } else {
          try{ if(FKO.Sfx) FKO.Sfx.play('block'); }catch(e){}
        }
        // prevent multi-hit in same active window: go to recovery
        attacker.movePhase=2;
        attacker.moveTimer=attacker.currentMove ? attacker.currentMove.rec : 160;
        return true;
      }
    }
    return false;
  }
};
})();
