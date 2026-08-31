// RS.GameState — 局内状态
(function () {
  'use strict';
  var RS = window.RS;
  function GameState() {
    this.seed = Math.floor(Math.random()*1e9);
    this.gold = RS.CFG.START_GOLD; this.wood = RS.CFG.START_WOOD;
    this.pop = 0; this.popCap = 8;
    this.units=[]; this.buildings=[]; this.resources=[];
    this.startedAt=0; this.ended=false; this.victory=false;
    this.settings={ fog:true, ai:true, animSpeed:1 };
  }
  GameState.prototype.canAfford = function(cost){ return this.gold>=(cost.gold||0) && this.wood>=(cost.wood||0); };
  GameState.prototype.spend = function(cost){ if(!this.canAfford(cost)) return false; this.gold-=(cost.gold||0); this.wood-=(cost.wood||0); return true; };
  GameState.prototype.addGold = function(n){ this.gold+=n; };
  GameState.prototype.addWood = function(n){ this.wood+=n; };
  GameState.prototype.toJSON = function(){ return { seed:this.seed, gold:this.gold, wood:this.wood, pop:this.pop, popCap:this.popCap, settings:this.settings }; };
  RS.GameState = GameState;
})();
