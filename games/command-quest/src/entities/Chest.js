// CQ.Chest — 宝箱（可开一次，随机奖励金币/装备/士兵）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.Chest = function (scene, c, r, rng) {
    CQ.Entity.call(this, scene, c, r);
    this.opened = false;
    this.reward = this._rollReward(rng);
  };
  CQ.Chest.prototype = Object.create(CQ.Entity.prototype);
  CQ.Chest.prototype.constructor = CQ.Chest;
  CQ.Chest.prototype._rollReward = function (rng) {
    var roll = rng ? rng.next() : Math.random();
    if (roll < 0.45) return { type: 'gold', amount: rng ? rng.int(40, 90) : 60 };
    if (roll < 0.75) { var eq = rng ? rng.pick(CQ.EQUIP) : CQ.EQUIP[0]; return { type: 'equip', equipId: eq.id }; }
    var st = rng ? rng.pick(CQ.SOLDIERS) : CQ.SOLDIERS[0]; return { type: 'soldier', soldierType: st.id };
  };
  CQ.Chest.prototype.createGO = function () {
    var p = this.worldPos();
    var g = this.scene.add.container(p.x, p.y);
    var box = this.scene.add.rectangle(0, 0, 20, 16, 0xe67e22).setStrokeStyle(1, 0xffffff);
    var lid = this.scene.add.rectangle(0, -6, 20, 6, 0xd35400).setStrokeStyle(1, 0xffffff);
    var tx = this.scene.add.text(0, 10, '宝箱', { fontSize: '7px', color: '#fff' }).setOrigin(0.5);
    g.add([box, lid, tx]); this.go = g; this._lid = lid; return g;
  };
  CQ.Chest.prototype.open = function (commander) {
    if (this.opened) return null;
    this.opened = true;
    if (this.go && this._lid) this._lid.setFillStyle(0x7f8c8d);
    if (this.go) this.go.setAlpha(0.5);
    return this.reward;
  };
})();
