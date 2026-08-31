// RS.CombatSystem — 近战/远程 + 弹道池
(function () {
  'use strict';
  var RS = window.RS;
  function CombatSystem(scene){ this.scene=scene; this.bullets=[]; for(var i=0;i<28;i++){ var p=new RS.Projectile(scene); p.ensureGO(); this.bullets.push(p); } this._next=0; }
  CombatSystem.prototype.update=function(dt, units){
    // 攻击 CD 推进与目标搜寻
    for(var i=0;i<units.length;i++){
      var u=units[i]; if(!u.alive) continue;
      if(u.attackCD>0) u.attackCD-=dt;
      if(u.state==='gather') continue; // 采集不接敌
      // 近距索敌（视野内）
      var best=null, bd=999;
      for(var j=0;j<units.length;j++){
        var v=units[j]; if(v===u||!v.alive) continue; if(v.side===u.side) continue;
        var dx=v.x-u.x, dy=v.y-u.y; var d2=dx*dx+dy*dy;
        var rangePx = u.range * 36; if(d2 > rangePx*rangePx + 64) continue;
        var d=Math.sqrt(d2);
        if(d<bd){ bd=d; best=v; }
      }
      if(best && u.attackCD<=0){
        if(u.range<=1){
          // 近战直接伤害
          best.takeDamage(u.atk);
          u.attackCD=RS.CFG.ATTACK_TICK_MS;
          if(!best.alive) u.state='idle';
          if(this.scene.state.pop!==undefined && best.side==='player' && !best.alive) this.scene.state.pop=Math.max(0,this.scene.state.pop-1);
        } else {
          // 远程发射
          var p=this.bullets[this._next++ % this.bullets.length];
          p.fire({x:u.x,y:u.y}, best, u.atk);
          u.attackCD=RS.CFG.ATTACK_TICK_MS + (u.def.id==='mage'?180:0);
        }
      }
    }
    for(var k=0;k<this.bullets.length;k++) if(this.bullets[k].active) this.bullets[k].update(dt);
  };
  RS.CombatSystem = CombatSystem;
})();
