// TD.MapManager — 路径与网格
(function () {
  'use strict';
  var TD = window.TD;
  function MapManager(level, grid) {
    this.level = level; this.grid = grid;
    this.pathWorld = [];
    this.totalLen = 0;
    this._buildPath();
    this._markBlocked();
  }
  MapManager.prototype._buildPath = function () {
    var pts = this.level.path, tile = this.grid.tile, ox = this.grid.ox, oy = this.grid.oy;
    this.pathWorld = pts.map(function (p) { return { x: ox + p.c * tile, y: oy + p.r * tile }; });
    this.totalLen = TD.polylineLength(this.pathWorld);
  };
  MapManager.prototype._markBlocked = function () {
    // 路径经过的格子不可建
    var g = this.grid;
    for (var i = 0; i < this.pathWorld.length - 1; i++) {
      var a = this.pathWorld[i], b = this.pathWorld[i + 1];
      var ca = g.worldToCell(a.x, a.y), cb = g.worldToCell(b.x, b.y);
      var dc = cb.c - ca.c, dr = cb.r - ca.r;
      var steps = Math.max(Math.abs(dc), Math.abs(dr));
      for (var s = 0; s <= steps; s++) {
        var c = ca.c + Math.round(dc * s / (steps || 1));
        var r = ca.r + Math.round(dr * s / (steps || 1));
        g.blocked[g.key(c, r)] = true;
      }
    }
    // 关卡额外 blocked
    var extra = this.level.blocked || [];
    for (var k = 0; k < extra.length; k++) g.blocked[extra[k]] = true;
  };
  MapManager.prototype.drawPath = function (scene) {
    var g = scene.add.graphics().setDepth(1);
    g.lineStyle(18, TD.COLORS.PATH, 1);
    g.beginPath(); g.moveTo(this.pathWorld[0].x, this.pathWorld[0].y);
    for (var i = 1; i < this.pathWorld.length; i++) g.lineTo(this.pathWorld[i].x, this.pathWorld[i].y);
    g.strokePath();
    g.lineStyle(2, TD.COLORS.PATH_EDGE, 0.9);
    g.beginPath(); g.moveTo(this.pathWorld[0].x, this.pathWorld[0].y);
    for (var j = 1; j < this.pathWorld.length; j++) g.lineTo(this.pathWorld[j].x, this.pathWorld[j].y);
    g.strokePath();
    // 起终点标记
    var s = this.pathWorld[0], e = this.pathWorld[this.pathWorld.length - 1];
    var a = scene.add.text(s.x, s.y, '入口', { fontSize:'9px', color:'#8b949e' }).setOrigin(0.5).setDepth(2);
    var b = scene.add.text(e.x, e.y, '出口', { fontSize:'9px', color:'#e74c3c' }).setOrigin(0.5).setDepth(2);
    this._pathGfx = g; this._pathLabels = [a, b];
  };
  MapManager.prototype.destroy = function () {
    if (this._pathGfx) { try { this._pathGfx.destroy(); } catch (e) {} }
    if (this._pathLabels) for (var i = 0; i < this._pathLabels.length; i++) try { this._pathLabels[i].destroy(); } catch (e) {}
  };
  TD.MapManager = MapManager;
})();
