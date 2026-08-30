// TD.Enemy — 敌人（沿路径前进，手动插值，无物理体）
(function () {
  'use strict';
  var TD = window.TD;
  function Enemy(scene, def) {
    TD.Entity.call(this, scene, 0, 0);
    this.def = def;
    this.maxHp = def.hp; this.hp = def.hp;
    this.speed = def.speed; this.reward = def.reward;
    this.pathT = 0; // 0..1
    this.slowUntil = 0; this.poisonUntil = 0; this.poisonTick = 0;
    this._bar = null; this._label = null; this._bg = null;
    this._leaked = false;
  }
  Enemy.prototype = Object.create(TD.Entity.prototype);
  Enemy.prototype.constructor = Enemy;

  Enemy.prototype.spawn = function (def, hpMul, speedMul, rewardMul, startT) {
    this.def = def;
    this.maxHp = Math.round(def.hp * (hpMul || 1));
    this.hp = this.maxHp;
    this.speed = def.speed * (speedMul || 1);
    this.reward = Math.round(def.reward * (rewardMul || 1));
    this.pathT = startT || 0;
    this.slowUntil = 0; this.poisonUntil = 0; this.poisonTick = 0;
    this.active = true; this._leaked = false;
    if (!this.go) this._createGO();
    this._syncVisual();
    return this;
  };

  Enemy.prototype._createGO = function () {
    var sc = this.scene;
    // 容器：色块 + 文字
    var cont = sc.add.container(0, 0);
    var bg = sc.add.rectangle(0, 0, 28, 28, this.def.color);
    bg.setStrokeStyle(1.5, 0xffffff, 0.9);
    var tx = sc.add.text(0, 0, this.def.abbr, { fontSize:'11px', color:'#ffffff', fontStyle:'bold' }).setOrigin(0.5);
    // 血条
    var barBg = sc.add.rectangle(0, -20, 28, 4, 0x000000, 0.55);
    var bar = sc.add.rectangle(-14, -20, 28, 4, 0x2ecc71);
    bar.setOrigin(0, 0.5);
    cont.add([bg, tx, barBg, bar]);
    cont.setDepth(10);
    this.go = cont; this._bg = bg; this._label = tx; this._bar = bar; this._barBg = barBg;
  };
  Enemy.prototype._syncVisual = function () {
    if (!this.go) return;
    if (this._bg) { this._bg.fillColor = this.def.color; }
    if (this._label) this._label.setText(this.def.abbr);
  };
  Enemy.prototype.updateVisual = function () {
    if (!this.go || !this._bar) return;
    var r = this.hp / this.maxHp;
    this._bar.width = Math.max(0, 28 * r);
    this._bar.fillColor = r > 0.5 ? 0x2ecc71 : r > 0.25 ? 0xf1c40f : 0xe74c3c;
    // 中毒/减速 tint
    if (this._bg) {
      if (this.poisonUntil > this.scene.time.now) this._bg.setStrokeStyle(2, 0x2ecc71, 1);
      else if (this.slowUntil > this.scene.time.now) this._bg.setStrokeStyle(2, 0x5dade2, 1);
      else this._bg.setStrokeStyle(1.5, 0xffffff, 0.9);
    }
  };
  Enemy.prototype.takeDamage = function (n) {
    var armor = this.def.armor || 0;
    var dmg = Math.max(1, n - armor);
    this.hp -= dmg;
    this.updateVisual();
    return this.hp <= 0;
  };
  Enemy.prototype.applySlow = function (ms) {
    if (this.def.flying) return;
    var resist = this.def.slowResist || 0;
    var dur = ms * (1 - resist);
    this.slowUntil = Math.max(this.slowUntil, this.scene.time.now + dur);
  };
  Enemy.prototype.applyPoison = function (ms) {
    this.poisonUntil = Math.max(this.poisonUntil, this.scene.time.now + ms);
  };
  Enemy.prototype.isSlowed = function () { return this.slowUntil > this.scene.time.now; };
  Enemy.prototype.update = function (dt, mapMgr) {
    if (!this.active) return false; // false=无需移除
    var now = this.scene.time.now;
    // 毒
    if (this.poisonUntil > now) {
      this.poisonTick -= dt;
      if (this.poisonTick <= 0) { this.takeDamage(4); this.poisonTick = 520; }
    }
    var spd = this.speed;
    if (this.isSlowed()) spd *= 0.42;
    this.pathT += (spd * dt / 1000) / (mapMgr.totalLen || 1);
    if (this.pathT >= 1) { this.pathT = 1; this._leaked = true; return true; }
    var p = TD.pointAt(mapMgr.pathWorld, mapMgr.totalLen, this.pathT);
    this.x = p.x; this.y = p.y;
    if (this.go) { this.go.x = p.x; this.go.y = p.y; }
    this.updateVisual();
    if (this.hp <= 0) return true; // 死亡待回收
    return false;
  };
  Enemy.prototype.destroy = function () {
    TD.Entity.prototype.destroy.call(this);
    this._bar = null; this._label = null; this._bg = null;
  };
  TD.Enemy = Enemy;
})();
