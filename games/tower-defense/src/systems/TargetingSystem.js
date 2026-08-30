// TD.TargetingSystem — 目标选择（first/last/strong/weak/closest）
(function () {
  'use strict';
  var TD = window.TD;
  function TargetingSystem() { this.mode = 'first'; }
  TargetingSystem.prototype.pick = function (tower, enemies) {
    var best = null, bestScore = -Infinity, tx = tower.x, ty = tower.y, r2 = tower.range * tower.range;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i]; if (!e || !e.active) continue;
      var d2 = TD.dist2(tx, ty, e.x, e.y); if (d2 > r2) continue;
      var score = 0;
      if (this.mode === 'first') score = e.pathT;
      else if (this.mode === 'last') score = -e.pathT;
      else if (this.mode === 'strong') score = e.maxHp;
      else if (this.mode === 'weak') score = -e.hp;
      else if (this.mode === 'closest') score = -d2;
      else score = e.pathT;
      if (!best || score > bestScore) { best = e; bestScore = score; }
    }
    return best;
  };
  TD.TargetingSystem = TargetingSystem;
})();
