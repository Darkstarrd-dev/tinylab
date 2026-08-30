// TD.Projectile — 子弹（Rectangle 池，手动位移，无物理体）
(function () {
  'use strict';
  var TD = window.TD;
  function Projectile(scene) {
    this.scene = scene;
    this.active = false;
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.damage = 0; this.speed = 0; this.ptype = 'bullet';
    this.target = null; this.splashR = 0; this.slowMs = 0; this.poisonMs = 0;
    this.life = 0; this.maxLife = 2200;
    this.go = null;
  }
  Projectile.prototype.ensureGO = function () {
    if (this.go) return;
    var sc = this.scene;
    // 4×4 小矩形，tint 区分类型
    this.go = sc.add.rectangle(0, 0, 5, 5, 0xffffff).setDepth(11).setVisible(false).setActive(false);
  };
  Projectile.prototype.fire = function (fromX, fromY, target, def, damage, owner) {
    this.ensureGO();
    this.active = true; this.x = fromX; this.y = fromY; this.target = target;
    this.damage = damage; this.owner = owner || null;
    this.ptype = (def && def.ptype) || 'bullet';
    this.speed = (def && def.speed) || 420;
    this.splashR = 0; this.slowMs = 0; this.poisonMs = 0;
    if (def && def.id === 'splash') this.splashR = 48 + (owner ? (owner.level - 1) * 6 : 0);
    if (def && def.id === 'missile') this.splashR = 56 + (owner ? (owner.level - 1) * 8 : 0);
    if (def && def.id === 'frost') this.slowMs = 1100 + (owner ? (owner.level - 1) * 300 : 0);
    if (def && def.id === 'poison') this.poisonMs = 2800 + (owner ? (owner.level - 1) * 600 : 0);
    // 朝向
    var ang = Math.atan2(target.y - fromY, target.x - fromX);
    this.vx = Math.cos(ang) * this.speed; this.vy = Math.sin(ang) * this.speed;
    this.life = 0;
    // 颜色
    var col = (def && def.color) || 0xffffff;
    if (this.ptype === 'laserTick') col = 0x9b59b6;
    else if (this.ptype === 'aura') col = 0x00cec9;
    this.go.fillColor = col;
    this.go.width = this.splashR ? 7 : 5; this.go.height = this.splashR ? 7 : 5;
    this.go.x = fromX; this.go.y = fromY; this.go.setVisible(true).setActive(true);
    // laserTick 为即时命中，不走飞行
    if (this.ptype === 'laserTick') { this._hitTarget(target); this.recycle(); return; }
    if (this.ptype === 'aura') { this._auraTick(); this.recycle(); return; }
  };
  Projectile.prototype._auraTick = function () {
    // 电弧：范围内全部敌人受击
    var sc = this.scene, r = this.owner ? this.owner.range : 95;
    var r2 = r * r;
    for (var i = 0; i < sc.enemiesAlive.length; i++) {
      var e = sc.enemiesAlive[i]; if (!e || !e.active) continue;
      if (TD.dist2(this.x, this.y, e.x, e.y) <= r2) {
        var dead = e.takeDamage(this.damage);
        if (dead) sc.onEnemyKilled(e, this.owner);
      }
    }
  };
  Projectile.prototype._hitTarget = function (enemy) {
    var sc = this.scene;
    if (!enemy || !enemy.active) return;
    if (this.splashR > 0) {
      var r2 = this.splashR * this.splashR;
      for (var i = 0; i < sc.enemiesAlive.length; i++) {
        var e = sc.enemiesAlive[i]; if (!e || !e.active) continue;
        if (TD.dist2(enemy.x, enemy.y, e.x, e.y) <= r2) {
          var fall = (e === enemy) ? 1 : 0.52;
          var dead2 = e.takeDamage(Math.round(this.damage * fall));
          if (dead2) sc.onEnemyKilled(e, this.owner);
        }
      }
    } else {
      var dead = enemy.takeDamage(this.damage);
      if (this.slowMs) enemy.applySlow(this.slowMs);
      if (this.poisonMs) enemy.applyPoison(this.poisonMs);
      if (dead) sc.onEnemyKilled(enemy, this.owner);
    }
  };
  Projectile.prototype.update = function (dt) {
    if (!this.active) return;
    this.life += dt;
    if (this.life > this.maxLife) { this.recycle(); return; }
    // 追踪（轻度导向）
    if (this.target && this.target.active) {
      var ang = Math.atan2(this.target.y - this.y, this.target.x - this.x);
      var cur = Math.atan2(this.vy, this.vx);
      var diff = ang - cur; while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
      var turn = 0.085; cur += diff * turn;
      this.vx = Math.cos(cur) * this.speed; this.vy = Math.sin(cur) * this.speed;
    }
    this.x += this.vx * dt / 1000; this.y += this.vy * dt / 1000;
    if (this.go) { this.go.x = this.x; this.go.y = this.y; }
    // 命中检测（半径 14）
    if (this.target && this.target.active && TD.dist2(this.x, this.y, this.target.x, this.target.y) < 196) {
      this._hitTarget(this.target); this.recycle(); return;
    }
    // 无目标且超距离也回收
    if (!this.target || !this.target.active) {
      // 找最近活敌兜底命中（距离 < 18）
      var sc = this.scene, best = null, bd2 = 324;
      for (var i = 0; i < sc.enemiesAlive.length; i++) {
        var e = sc.enemiesAlive[i]; if (!e || !e.active) continue;
        var d2 = TD.dist2(this.x, this.y, e.x, e.y);
        if (d2 < bd2) { bd2 = d2; best = e; }
      }
      if (best) { this._hitTarget(best); this.recycle(); }
    }
  };
  Projectile.prototype.recycle = function () {
    this.active = false; this.target = null;
    if (this.go) this.go.setVisible(false).setActive(false);
  };
  TD.Projectile = Projectile;
})();
