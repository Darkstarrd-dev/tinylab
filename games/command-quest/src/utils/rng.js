// CQ.RNG — 可复现随机数（同数值可复现，不同种子不同地图）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.RNG = function (seed) { this.s = (seed >>> 0) || 1; };
  CQ.RNG.prototype.next = function () { this.s = (this.s * 1664525 + 1013904223) >>> 0; return this.s / 4294967296; };
  CQ.RNG.prototype.int = function (a, b) { return Math.floor(this.next() * (b - a + 1)) + a; };
  CQ.RNG.prototype.pick = function (arr) { return arr[this.int(0, arr.length - 1)]; };
  CQ.RNG.prototype.shuffle = function (arr) { var a = arr.slice(); for (var i = a.length - 1; i > 0; i--) { var j = this.int(0, i); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
})();
