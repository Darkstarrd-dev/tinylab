// CQ.Shop — 商店（可访问多次，随机陈列装备/士兵/治疗）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.Shop = function (scene, c, r, rng) {
    CQ.Entity.call(this, scene, c, r);
    this.stock = this._rollStock(rng);
  };
  CQ.Shop.prototype = Object.create(CQ.Entity.prototype);
  CQ.Shop.prototype.constructor = CQ.Shop;
  CQ.Shop.prototype._rollStock = function (rng) {
    var n = CQ.CFG.SHOP_ITEMS;
    var pool = CQ.EQUIP.slice();
    var out = [];
    for (var i = 0; i < n; i++) {
      if (rng && rng.next() < 0.3) {
        var st = rng.pick(CQ.SOLDIERS); out.push({ kind: 'soldier', id: st.id, name: st.name, price: 60 + (st.cost || 0) });
      } else {
        var eq = rng ? rng.pick(pool) : pool[i % pool.length]; out.push({ kind: 'equip', id: eq.id, name: eq.name, price: eq.price });
      }
    }
    out.push({ kind: 'heal', id: 'heal', name: '治疗', price: CQ.CFG.HEAL_COST });
    return out;
  };
  CQ.Shop.prototype.createGO = function () {
    var p = this.worldPos();
    var g = this.scene.add.container(p.x, p.y);
    var base = this.scene.add.rectangle(0, 0, 22, 18, 0x3498db).setStrokeStyle(1, 0xffffff);
    var tx = this.scene.add.text(0, 11, '商店', { fontSize: '7px', color: '#fff' }).setOrigin(0.5);
    g.add([base, tx]); this.go = g; return g;
  };
})();
