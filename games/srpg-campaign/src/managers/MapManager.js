// SC.MapManager — 地图与网格绘制
(function () {
  'use strict';
  var SC = window.SC;
  function MapManager(mapRows, grid) { this.mapRows = mapRows; this.grid = grid; this._gfx=null; this._gridGfx=null; }
  MapManager.prototype.draw = function(scene){
    var grid=this.grid, tile=grid.tile, ox=grid.ox, oy=grid.oy;
    var g=scene.add.graphics().setDepth(0);
    for(var r=0;r<grid.rows;r++) for(var c=0;c<grid.cols;c++){
      var t=grid.terrainAt(c,r);
      var col = SC.COLORS.TERRAIN[t] || SC.COLORS.TERRAIN['.'];
      g.fillStyle(col, 1);
      g.fillRect(ox+c*tile, oy+r*tile, tile, tile);
    }
    this._gfx=g;
    var gg=scene.add.graphics().setDepth(1);
    gg.lineStyle(1, SC.COLORS.GRID, 0.7);
    for(var c2=0;c2<=grid.cols;c2++) gg.lineBetween(ox+c2*tile, oy, ox+c2*tile, oy+grid.rows*tile);
    for(var r2=0;r2<=grid.rows;r2++) gg.lineBetween(ox, oy+r2*tile, ox+grid.cols*tile, oy+r2*tile);
    this._gridGfx=gg;
  };
  MapManager.prototype.destroy = function(){ if(this._gfx) try{this._gfx.destroy();}catch(e){}; if(this._gridGfx) try{this._gridGfx.destroy();}catch(e){}; };
  SC.MapManager = MapManager;
})();
