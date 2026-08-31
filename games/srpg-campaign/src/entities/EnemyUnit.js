// SC.EnemyUnit — 敌方单位
(function () {
  'use strict';
  var SC = window.SC;
  function EnemyUnit(enemyDef, lv, c, r) {
    var job = SC.getClass(enemyDef.job);
    var hp = job.base.hp + Math.floor((lv-1)*job.growth.hp/100*2);
    var atk = job.base.atk + Math.floor((lv-1)*job.growth.atk/100*1.2);
    var def = job.base.def + Math.floor((lv-1)*job.growth.def/100*1.1);
    var spd = job.base.spd + Math.floor((lv-1)*job.growth.spd/100*1.0);
    if(enemyDef.isBoss){ hp+=6; atk+=3; def+=2; }
    SC.Unit.call(this, { id:enemyDef.id+'_'+c+'_'+r, name:enemyDef.name, abbr:enemyDef.abbr, job:enemyDef.job, level:lv, maxHp:hp, hp:hp, atk:atk, def:def, spd:spd, mov:job.mov, range:job.range, c:c, r:r, side:'enemy', skills: SC.getJobSkills(enemyDef.job).slice(0,1) });
    this.enemyDef = enemyDef; this.isBoss = !!enemyDef.isBoss;
  }
  EnemyUnit.prototype = Object.create(SC.Unit.prototype);
  EnemyUnit.prototype.constructor = EnemyUnit;
  SC.EnemyUnit = EnemyUnit;
})();
