// SC.TurnManager — 回合/阶段
(function () {
  'use strict';
  var SC = window.SC;
  function TurnManager(){ this.turn=1; this.phase='player'; } // player / enemy
  TurnManager.prototype.isPlayerPhase = function(){ return this.phase==='player'; };
  TurnManager.prototype.startPlayerPhase = function(units){
    this.phase='player';
    for(var i=0;i<units.length;i++) if(units[i].side==='player') units[i].resetTurn();
  };
  TurnManager.prototype.allPlayerActed = function(units){
    for(var i=0;i<units.length;i++) if(units[i].side==='player'&&units[i].isAlive()&&!units[i].hasActed) return false;
    return true;
  };
  TurnManager.prototype.startEnemyPhase = function(units){
    this.phase='enemy';
    for(var i=0;i<units.length;i++) if(units[i].side==='enemy') units[i].resetTurn();
  };
  TurnManager.prototype.nextTurn = function(units){
    this.turn++; this.startPlayerPhase(units);
  };
  SC.TurnManager = TurnManager;
})();
