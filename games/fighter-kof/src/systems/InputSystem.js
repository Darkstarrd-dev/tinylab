(function(){
'use strict';
var FKO=window.FKO;
FKO.InputSystem={
  sample:function(scene,fighter,keys){
    if(!keys) return;
    var up=keys.up&&keys.up.isDown, down=keys.down&&keys.down.isDown, left=keys.left&&keys.left.isDown, right=keys.right&&keys.right.isDown;
    var dir=5;
    if(down&&left) dir=1;
    else if(down&&right) dir=3;
    else if(up&&left) dir=7;
    else if(up&&right) dir=9;
    else if(down) dir=2;
    else if(up) dir=8;
    else if(left) dir=4;
    else if(right) dir=6;
    var btns={A:keys.A&&keys.A.isDown,B:keys.B&&keys.B.isDown,C:keys.C&&keys.C.isDown,D:keys.D&&keys.D.isDown};
    fighter.inputBuffer.push(dir,btns);

    // crouch / block
    fighter.crouching=!!(down && fighter.onGround);
    var backDir=fighter.facing===1?4:6;
    var isBack=(dir===backDir);
    var isCrouchBack=down && (dir===(fighter.facing===1?1:3));
    fighter.blocking=(isBack||isCrouchBack) && !fighter.attacking;
    fighter.blockIsCrouch=fighter.crouching&&fighter.blocking;

    // movement (only if not in hitstun/blockstun/knocked/attacking)
    var canMove=fighter.hitstun<=0 && fighter.blockstun<=0 && !fighter.isKnocked && !fighter.attacking;
    if(canMove){
      if(!fighter.crouching){
        if(left&&!right) fighter.vx=-fighter.charDef.walkSpeed;
        else if(right&&!left) fighter.vx=fighter.charDef.walkSpeed;
        else fighter.vx*=0.82;
      } else {
        fighter.vx*=0.88;
      }
      // jump
      if(up){
        var justUp=false;
        try{ justUp=Phaser.Input.Keyboard.JustDown(keys.up); }catch(e){ justUp=false; }
        if(justUp && fighter.onGround){
          fighter.vy=-fighter.charDef.jumpVel;
          fighter.onGround=false;
        }
      }
    }

    // move triggers priority: super > special > normal
    var moveset=FKO.getMoveset(fighter.charDef.id);
    var triggered=false;
    // super first
    for(var i=0;i<moveset.length;i++){
      var m=moveset[i];
      if(!m.super) continue;
      if(fighter.inputBuffer.matchCommand(m.input,fighter.facing)){
        if(fighter.startMove(m.id)){ triggered=true; break; }
      }
    }
    if(triggered) return;
    // specials (input length >1 and not super)
    for(var j=0;j<moveset.length;j++){
      var ms=moveset[j];
      if(ms.super) continue;
      if(!ms.input||ms.input.length<=1) continue;
      if(fighter.inputBuffer.matchCommand(ms.input,fighter.facing)){
        if(fighter.startMove(ms.id)){ triggered=true; break; }
      }
    }
    if(triggered) return;
    // normals: use JustDown to avoid hold spam
    for(var k=0;k<moveset.length;k++){
      var mn=moveset[k];
      if(mn.super) continue;
      if(mn.input.length!==1) continue;
      var keyObj=keys[mn.input];
      var just=false;
      try{ just=keyObj && Phaser.Input.Keyboard.JustDown(keyObj); }catch(e){ just=false; }
      // fallback to matchCommand if JustDown not available (e.g. held)
      if(just || fighter.inputBuffer.matchCommand(mn.input,fighter.facing)){
        // for normals require JustDown to trigger, otherwise skip
        if(!just) {
          // if matched via buffer but not JustDown, only trigger if last frame JustDown missed - skip
          continue;
        }
        if(fighter.startMove(mn.id)){ triggered=true; break; }
      }
    }
  }
};
})();
