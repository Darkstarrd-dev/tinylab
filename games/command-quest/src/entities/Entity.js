// CQ.Entity — 实体基类
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.Entity = function (scene, c, r) {
    this.scene = scene; this.c = c; this.r = r; this.alive = true;
    this.go = null; // Phaser GameObject
  };
  CQ.Entity.prototype.worldPos = function () { return this.scene.grid.cellToWorld(this.c, this.r); };
  CQ.Entity.prototype.setCell = function (c, r) { this.c = c; this.r = r; if (this.go) { var p = this.worldPos(); this.go.setPosition(p.x, p.y); } };
  CQ.Entity.prototype.destroyGO = function () { if (this.go) { try { this.go.destroy(); } catch (e) {} this.go = null; } };
})();
