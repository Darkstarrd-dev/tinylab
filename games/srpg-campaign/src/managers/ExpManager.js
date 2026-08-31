// SC.ExpManager — 经验与升级演出钩子（逻辑在 Character.gainExp）
(function () {
  'use strict';
  var SC = window.SC;
  function ExpManager(){}
  ExpManager.prototype.applyExp = function(unit, amount, onLevelUp){
    var before = unit.level;
    var leveled = unit.gainExp(amount);
    if(leveled && onLevelUp) onLevelUp(unit, before);
    return leveled;
  };
  SC.ExpManager = ExpManager;
})();
