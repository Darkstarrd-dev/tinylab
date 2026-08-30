// TD.EconomyManager — 金币/生命/分数
(function () {
  'use strict';
  var TD = window.TD;
  function EconomyManager(startGold, startLives) {
    this.gold = startGold || TD.CFG.START_GOLD;
    this.lives = startLives || TD.CFG.START_LIVES;
    this.score = 0;
    this.kills = 0;
  }
  EconomyManager.prototype.canAfford = function (n) { return this.gold >= n; };
  EconomyManager.prototype.spend = function (n) {
    if (this.gold < n) return false; this.gold -= n; return true;
  };
  EconomyManager.prototype.earn = function (n) { this.gold += n; this.score += n * 2; };
  EconomyManager.prototype.addScore = function (n) { this.score += n; };
  EconomyManager.prototype.loseLife = function (n) { this.lives -= n; if (this.lives < 0) this.lives = 0; };
  TD.EconomyManager = EconomyManager;
})();
