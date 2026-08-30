// TD.Tower — 防御塔（4 级，范围圈选中显示）
(function () {
  'use strict';
  var TD = window.TD;
  function Tower(scene, def, cell, level) {
    var wpos = scene.mapMgr ? scene.mapMgr.grid.cellToWorld(cell.c, cell.r) : {x:0,y:0};
    TD.Entity.call(this, scene, wpos.x, wpos.y);
    this.def = def; this.cell = cell; this.level = level || 1;
    this.lastFire = 0; this.kills = 0; this.selected = false;
    this._rangeGfx = null; this._lvText = null;
    this._applyLevel();
  }
  Tower.prototype = Object.create(TD.Entity.prototype);
  Tower.prototype.constructor = Tower;

  Tower.prototype._applyLevel = function () {
    var st = TD.getTowerStatsAt(this.def.id, this.level);
    this.damage = st.damage; this.range = st.range; this.fireRate = st.fireRate; this.color2 = st.color2;
  };
  Tower.prototype.createGO = function () {
    var sc = this.scene, sz = 26 + (this.level - 1) * 3;
    var cont = sc.add.container(this.x, this.y);
    var bg = sc.add.rectangle(0, 0, sz, sz, this.color2);
    bg.setStrokeStyle(this.selected ? 2.5 : 1.2, this.selected ? 0x3498db : 0xffffff, 0.95);
    var ab = sc.add.text(0, -1, this.def.abbr, { fontSize:'11px', color:'#0e1628', fontStyle:'bold' }).setOrigin(0.5);
    var lv = sc.add.text(sz/2 - 2, -sz/2 + 1, 'L'+this.level, { fontSize:'7px', color:'#ffffff', backgroundColor:'#000000aa' }).setOrigin(1, 0);
    cont.add([bg, ab, lv]); cont.setDepth(12);
    bg.setInteractive({ useHandCursor:true });
    var self = this;
    bg.on('pointerdown', function () { if (self.scene.onTowerPicked) self.scene.onTowerPicked(self); });
    this.go = cont; this._bg = bg; this._lvText = lv;
    // 范围圈
    this._rangeGfx = sc.add.graphics().setDepth(5).setVisible(false);
    this._redrawRange();
  };
  Tower.prototype._redrawRange = function () {
    if (!this._rangeGfx) return;
    this._rangeGfx.clear();
    this._rangeGfx.lineStyle(1.2, TD.COLORS.RANGE, 0.35);
    this._rangeGfx.strokeCircle(this.x, this.y, this.range);
    this._rangeGfx.fillStyle(TD.COLORS.RANGE, 0.06);
    this._rangeGfx.fillCircle(this.x, this.y, this.range);
  };
  Tower.prototype.setSelected = function (on) {
    this.selected = !!on;
    if (this._bg) this._bg.setStrokeStyle(on ? 2.5 : 1.2, on ? 0x3498db : 0xffffff, 0.95);
    if (this._rangeGfx) this._rangeGfx.setVisible(!!on);
  };
  Tower.prototype.canFire = function (now) {
    if (this.def.id === 'support') return false;
    if (this.fireRate <= 0) return false;
    return now - this.lastFire >= this.fireRate;
  };
  Tower.prototype.markFired = function (now) { this.lastFire = now; };
  Tower.prototype.canUpgrade = function () { return this.level < 4; };
  Tower.prototype.upgradeCost = function () {
    if (this.level >= 4) return Infinity;
    return TD.getTowerLevelCost(this.def.id, this.level + 1);
  };
  Tower.prototype.doUpgrade = function () {
    if (this.level >= 4) return false;
    this.level++; this._applyLevel();
    // 视觉刷新
    if (this.go) {
      var sz = 26 + (this.level - 1) * 3;
      if (this._bg) { this._bg.width = sz; this._bg.height = sz; this._bg.fillColor = this.color2; }
      if (this._lvText) this._lvText.setText('L' + this.level);
      this._redrawRange();
    }
    return true;
  };
  Tower.prototype.invested = function () {
    var s = 0;
    for (var lv = 1; lv <= this.level; lv++) s += TD.getTowerLevelCost(this.def.id, lv);
    return s;
  };
  Tower.prototype.sellValue = function () { return Math.floor(this.invested() * TD.CFG.SELL_REFUND); };
  Tower.prototype.supportBonus = function () {
    // 增幅塔：按等级 12%/18%/24%/30% 增伤
    var table = [0, 0.12, 0.18, 0.24, 0.30];
    return table[this.level] || 0;
  };
  Tower.prototype.effectiveDamage = function (scene) {
    var d = this.damage;
    if (!scene || !scene.towers) return d;
    // 受周围 support 加成（范围内每座 support 叠加，上限 60%）
    var bonus = 0;
    for (var i = 0; i < scene.towers.length; i++) {
      var t = scene.towers[i]; if (t === this || t.def.id !== 'support') continue;
      var dd2 = TD.dist2(this.x, this.y, t.x, t.y);
      if (dd2 <= t.range * t.range) bonus += t.supportBonus();
    }
    if (bonus > 0.6) bonus = 0.6;
    return Math.round(d * (1 + bonus));
  };
  TD.Tower = Tower;
})();
