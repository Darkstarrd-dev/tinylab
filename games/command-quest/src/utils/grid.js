// CQ.Grid — 网格坐标换算与寻路占位
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.Grid = function (cols, rows, tile, ox, oy) { this.cols = cols; this.rows = rows; this.tile = tile; this.ox = ox; this.oy = oy; };
  CQ.Grid.prototype.worldToCell = function (x, y) {
    var c = Math.floor((x - this.ox) / this.tile), r = Math.floor((y - this.oy) / this.tile);
    c = Math.max(0, Math.min(this.cols - 1, c)); r = Math.max(0, Math.min(this.rows - 1, r));
    return { c: c, r: r, key: c + ',' + r };
  };
  CQ.Grid.prototype.cellToWorld = function (c, r) { return { x: this.ox + c * this.tile + this.tile / 2, y: this.oy + r * this.tile + this.tile / 2 }; };
  CQ.Grid.prototype.inBounds = function (c, r) { return c >= 0 && c < this.cols && r >= 0 && r < this.rows; };
  CQ.Grid.prototype.manhattan = function (a, b) { return Math.abs(a.c - b.c) + Math.abs(a.r - b.r); };
  CQ.Grid.prototype.neighbors4 = function (c, r) {
    var ds = [[1,0],[-1,0],[0,1],[0,-1]], out = [];
    for (var i = 0; i < ds.length; i++) { var nc = c + ds[i][0], nr = r + ds[i][1]; if (this.inBounds(nc, nr)) out.push({ c: nc, r: nr, key: nc + ',' + nr }); }
    return out;
  };
})();
