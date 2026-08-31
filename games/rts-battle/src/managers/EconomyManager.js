// RS.EconomyManager — 资源展示代理（实际数值在 GameState）
(function () {
  'use strict';
  var RS = window.RS;
  function EconomyManager(state){ this.state=state; }
  EconomyManager.prototype.canAfford=function(cost){ return this.state.canAfford(cost); };
  EconomyManager.prototype.spend=function(cost){ return this.state.spend(cost); };
  RS.EconomyManager = EconomyManager;
})();
