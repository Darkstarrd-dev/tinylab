// RS.GatheringSystem — 采集（工兵 -> 资源）
(function () {
  'use strict';
  var RS = window.RS;
  function GatheringSystem(scene){ this.scene=scene; }
  GatheringSystem.prototype.update=function(dt, units, resources){
    for(var i=0;i<units.length;i++){
      var u=units[i]; if(!u.alive||u.def.id!=='worker') continue;
      if(u.state!=='gather') continue;
      var res=u.gatherTarget;
      if(!res || res.isDepleted()){ u.state='idle'; u.gatherTarget=null; continue; }
      var d2=(u.x - (this.scene.grid.ox+res.c*this.scene.grid.tile+this.scene.grid.tile/2));
      var dy2=(u.y - (this.scene.grid.oy+res.r*this.scene.grid.tile+this.scene.grid.tile/2));
      var dist2=d2*d2+dy2*dy2;
      if(dist2 > 900){
        // 靠近
        if(!u.path) u.moveTo({c:res.c,r:res.r}, this.scene.grid, null);
        continue;
      }
      u.gatherCD-=dt;
      if(u.gatherCD<=0){
        u.gatherCD=RS.CFG.GATHER_TICK_MS;
        var got=res.extract(RS.CFG.GATHER_RATE);
        if(res.type==='gold') this.scene.state.addGold(got);
        else this.scene.state.addWood(got);
        if(res.isDepleted()){
          u.state='idle'; u.gatherTarget=null;
          this.scene._toast('资源枯竭', 1000);
        }
      }
    }
  };
  RS.GatheringSystem = GatheringSystem;
})();
