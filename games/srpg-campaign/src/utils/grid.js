// SC.Grid — 网格与地形
(function () {
  'use strict';
  var SC = window.SC;
  function Grid(mapRows, tile, ox, oy) {
    this.map = mapRows; // string[] 每行 cols
    this.tile = tile; this.ox = ox; this.oy = oy;
    this.rows = mapRows.length; this.cols = (mapRows[0] || '').length;
  }
  Grid.prototype.inBounds = function (c,r){ return c>=0&&c<this.cols&&r>=0&&r<this.rows; };
  Grid.prototype.cellToWorld = function (c,r){ return { x:this.ox + c*this.tile + this.tile/2, y:this.oy + r*this.tile + this.tile/2 }; };
  Grid.prototype.worldToCell = function (x,y){ return { c:Math.floor((x-this.ox)/this.tile), r:Math.floor((y-this.oy)/this.tile)}; };
  Grid.prototype.terrainAt = function (c,r){ if(!this.inBounds(c,r)) return 'W'; return this.map[r][c] || '.'; };
  Grid.prototype.terrainDefAt = function (c,r){ var t=this.terrainAt(c,r); return SC.TERRAIN_DEF[t] || SC.TERRAIN_DEF['.']; };
  Grid.prototype.isPassable = function (c,r){ return this.terrainDefAt(c,r).moveCost < 99; };
  SC.Grid = Grid;
})();
