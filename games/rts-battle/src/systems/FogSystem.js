// RS.FogSystem — 迷雾贴图（Graphics 瓦片覆盖）
(function () {
  'use strict';
  var RS = window.RS;
  function FogSystem(scene, grid, fog){
    this.scene=scene; this.grid=grid; this.fog=fog;
    this._gfx=null;
  }
  FogSystem.prototype.ensureGfx=function(){
    if(this._gfx) return;
    this._gfx=this.scene.add.graphics().setDepth(20);
  };
  FogSystem.prototype.update=function(){
    if(!this.scene.state.settings.fog){ if(this._gfx) this._gfx.clear(); return; }
    this.ensureGfx();
    var g=this._gfx;
    g.clear();
    var tile=this.grid.tile, ox=this.grid.ox, oy=this.grid.oy;
    for(var r=0;r<this.grid.rows;r++) for(var c=0;c<this.grid.cols;c++){
      var vis=this.fog.isVisible(c,r);
      var seen=this.fog.isSeen(c,r);
      if(vis) continue; // 可见不盖
      var alpha = seen ? RS.CFG.FOG_ALPHA_SEEN : RS.CFG.FOG_ALPHA_UNSEEN;
      var col = seen ? RS.COLORS.FOG_SEEN : RS.COLORS.FOG_UNSEEN;
      g.fillStyle(col, alpha);
      g.fillRect(ox+c*tile, oy+r*tile, tile, tile);
    }
  };
  FogSystem.prototype.revealFromUnits=function(units, buildings){
    this.fog.resetVisible();
    for(var i=0;i<units.length;i++){
      var u=units[i]; if(!u.alive || u.side!=='player') continue;
      this.fog.reveal(u.c, u.r, u.sight);
    }
    for(var j=0;j<buildings.length;j++){
      var b=buildings[j]; if(!b.alive || b.side!=='player') continue;
      var sight=b.def.sight||5;
      for(var dr=0; dr<b.size; dr++) for(var dc=0; dc<b.size; dc++) this.fog.reveal(b.c+dc, b.r+dr, sight);
    }
    this.update();
  };
  RS.FogSystem = FogSystem;
})();
