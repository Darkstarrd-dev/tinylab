// RS.MapManager — 地图绘制（世界坐标系 + 相机由 Scene 控）
(function () {
  'use strict';
  var RS = window.RS;
  function MapManager(mapRows, grid){ this.mapRows=mapRows; this.grid=grid; this._gfx=null; this._gridGfx=null; }
  MapManager.prototype.draw=function(scene){
    var grid=this.grid, tile=grid.tile;
    var g=scene.add.graphics().setDepth(0);
    for(var r=0;r<grid.rows;r++) for(var c=0;c<grid.cols;c++){
      var t=grid.terrainAt(c,r);
      var col=RS.COLORS.TERRAIN[t]||RS.COLORS.TERRAIN['.'];
      g.fillStyle(col,1);
      g.fillRect(grid.ox + c*tile, grid.oy + r*tile, tile, tile);
    }
    this._gfx=g;
    var gg=scene.add.graphics().setDepth(1);
    gg.lineStyle(1, 0x1e2a44, 0.35);
    for(var c2=0;c2<=grid.cols;c2++) gg.lineBetween(grid.ox+c2*tile, grid.oy, grid.ox+c2*tile, grid.oy+grid.rows*tile);
    for(var r2=0;r2<=grid.rows;r2++) gg.lineBetween(grid.ox, grid.oy+r2*tile, grid.ox+grid.cols*tile, grid.oy+r2*tile);
    this._gridGfx=gg;
  };
  MapManager.prototype.worldToCell=function(x,y){ return this.grid.worldToCell(x,y); };
  MapManager.prototype.cellToWorld=function(c,r){ return this.grid.cellToWorld(c,r); };
  RS.MapManager = MapManager;
})();
