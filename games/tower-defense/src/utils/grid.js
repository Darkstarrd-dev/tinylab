// TD.Grid — 网格与占位
(function () {
  'use strict';
  var TD = window.TD;
  function Grid(cols, rows, tile, ox, oy) {
    this.cols = cols; this.rows = rows; this.tile = tile;
    this.ox = ox || 0; this.oy = oy || 0;
    this.blocked = {};  // key->true（路径格）
    this.occupied = {}; // key->towerRef
  }
  Grid.prototype.key = function (c, r) { return c + ',' + r; };
  Grid.prototype.worldToCell = function (x, y) {
    return { c: Math.floor((x - this.ox) / this.tile), r: Math.floor((y - this.oy) / this.tile) };
  };
  Grid.prototype.cellToWorld = function (c, r) {
    return { x: this.ox + c * this.tile + this.tile / 2, y: this.oy + r * this.tile + this.tile / 2 };
  };
  Grid.prototype.cellBounds = function (c, r) {
    return { x: this.ox + c * this.tile, y: this.oy + r * this.tile, w: this.tile, h: this.tile };
  };
  Grid.prototype.isBlocked = function (c, r) { return !!this.blocked[this.key(c, r)]; };
  Grid.prototype.isOccupied = function (c, r) { return !!this.occupied[this.key(c, r)]; };
  Grid.prototype.canPlace = function (c, r) {
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return false;
    if (this.isBlocked(c, r)) return false;
    if (this.isOccupied(c, r)) return false;
    return true;
  };
  Grid.prototype.place = function (c, r, ref) { this.occupied[this.key(c, r)] = ref; };
  Grid.prototype.remove = function (c, r) { delete this.occupied[this.key(c, r)]; };
  TD.Grid = Grid;
})();
