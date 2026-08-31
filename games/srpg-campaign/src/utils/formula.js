// SC.Formula — 伤害/命中/经验
(function () {
  'use strict';
  var SC = window.SC;
  SC.calcDamage = function (atk, def, power, terrainDef, crit) {
    var base = Math.max(1, atk + power - (def + terrainDef));
    if (crit) base = Math.floor(base * 1.5);
    return base;
  };
  SC.calcHit = function (hitBase, spdDiff, terrainAvoid) {
    var h = hitBase + spdDiff * 2 - terrainAvoid;
    if (h < 45) h = 45; if (h > 98) h = 98;
    return h;
  };
  SC.expForLevel = function (lv) { return SC.CFG.EXP_PER_LEVEL + (lv - 1) * 18; };
  SC.expGain = function (attackerLv, defenderLv, isKill, isBoss) {
    var diff = defenderLv - attackerLv;
    var base = isKill ? 42 : 14;
    if (isBoss) base += 18;
    base += diff * 3;
    if (base < 8) base = 8; if (base > 90) base = 90;
    return base;
  };
})();
