// TD.Math 工具
(function () {
  'use strict';
  var TD = window.TD;
  TD.dist2 = function (ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  TD.dist = function (ax, ay, bx, by) { return Math.sqrt(TD.dist2(ax, ay, bx, by)); };
  TD.clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  TD.lerp = function (a, b, t) { return a + (b - a) * t; };
  // 折线总长
  TD.polylineLength = function (pts) {
    var s = 0; for (var i = 1; i < pts.length; i++) s += TD.dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
    return s;
  };
  // t∈[0,1] 插值
  TD.pointAt = function (pts, totalLen, t) {
    if (!pts.length) return {x:0,y:0};
    if (t <= 0) return {x:pts[0].x, y:pts[0].y};
    if (t >= 1) return {x:pts[pts.length-1].x, y:pts[pts.length-1].y};
    var target = totalLen * t, acc = 0;
    for (var i = 1; i < pts.length; i++) {
      var seg = TD.dist(pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y);
      if (acc + seg >= target) {
        var r = (target - acc) / (seg || 1);
        return {x: TD.lerp(pts[i-1].x, pts[i].x, r), y: TD.lerp(pts[i-1].y, pts[i].y, r)};
      }
      acc += seg;
    }
    return {x:pts[pts.length-1].x, y:pts[pts.length-1].y};
  };
})();
