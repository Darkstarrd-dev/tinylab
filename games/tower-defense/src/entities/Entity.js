// TD.Entity — 实体基类（非 Phaser 派生）
(function () {
  'use strict';
  var TD = window.TD;
  function Entity(scene, x, y) {
    this.scene = scene;
    this.x = x || 0; this.y = y || 0;
    this.active = true;
    this.go = null; // Phaser GameObject（Rectangle/Text/Container）
  }
  Entity.prototype.init = function () {};
  Entity.prototype.update = function (dt) {};
  Entity.prototype.destroy = function () {
    this.active = false;
    if (this.go && this.go.destroy) { try { this.go.destroy(); } catch (e) {} }
    this.go = null;
  };
  Entity.prototype.setPosition = function (x, y) {
    this.x = x; this.y = y;
    if (this.go) { this.go.x = x; this.go.y = y; }
  };
  TD.Entity = Entity;
})();
