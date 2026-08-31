// CQ.Soldier — 士兵（数值归属指挥官，战棋下视为独立可控单位的视觉/战斗延伸）
(function () {
  'use strict';
  var CQ = window.CQ;
  // 士兵不单独寻路：位置跟随其指挥官；战斗时计入指挥官面板
  CQ.SoldierView = function (scene, commander, soldierIndex) {
    this.scene = scene; this.cmd = commander; this.idx = soldierIndex;
    this.go = null;
  };
  CQ.SoldierView.prototype.createGO = function () {
    var sd = CQ.getSoldierDef(this.cmd.soldiers[this.idx].type);
    var offs = CQ.Formula.soldierOffsets(this.cmd.soldiers.length);
    var o = offs[this.idx] || { dx: 0, dy: 0 };
    var p = this.cmd.worldPos();
    var g = this.scene.add.circle(p.x + o.dx, p.y + o.dy, 5, sd ? sd.color : 0xffffff).setStrokeStyle(1, 0x000000);
    this.go = g; return g;
  };
  CQ.SoldierView.prototype.sync = function () {
    if (!this.go || !this.cmd.alive) { if (this.go) this.go.setVisible(false); return; }
    var offs = CQ.Formula.soldierOffsets(this.cmd.soldiers.length);
    var o = offs[this.idx] || { dx: 0, dy: 0 };
    var p = this.cmd.worldPos();
    this.go.setPosition(p.x + o.dx, p.y + o.dy);
    this.go.setVisible(this.cmd.soldiers[this.idx].hp > 0);
  };
})();
