// RS.MapConfig — 随机地图参数
(function () {
  'use strict';
  var RS = window.RS;
  RS.MAP_CFG = {
    cols: 44, rows: 30, tile: 36,
    waterRatio: 0.06, forestRatio: 0.10, rockRatio: 0.04,
    goldVeins: 7, woodPatches: 10,
    goldPerVein: 1400, woodPerPatch: 1100,
    seedKey: 'rts-seed' // localStorage 种子键（保证同种子复现）
  };
})();
