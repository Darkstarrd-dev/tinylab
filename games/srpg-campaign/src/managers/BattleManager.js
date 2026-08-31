// SC.BattleManager — 战斗计算与推演（供 Tactics 与 Battle 场景共用）
(function () {
  'use strict';
  var SC = window.SC;
  function BattleManager(){}
  BattleManager.prototype.preview = function(atk, def, grid, skillId){
    var sk = skillId ? SC.getSkill(skillId) : null;
    var power = sk ? sk.power : 0;
    var hitBase = sk ? sk.hit : SC.CFG.HIT_BASE;
    // 被动
    if(atk.skills.indexOf('focus')!==-1) hitBase+=10;
    if(atk.skills.indexOf('arcane')!==-1 && atk.job==='mage') power+=2;
    var terrainDef = grid ? (grid.terrainDefAt(def.c, def.r).def) : 0;
    var terrainAvoid = grid ? (grid.terrainDefAt(def.c, def.r).avoid) : 0;
    if(def.skills && def.skills.indexOf('aegis')!==-1) terrainDef+=3;
    var spdDiff = atk.spd - def.spd;
    // 治愈
    if(power < 0){
      return { damage: power, hit: 100, crit: 0, isHeal:true };
    }
    var crit = (SC.CFG.CRIT_RATE_BASE + Math.floor((atk.spd - def.spd)/2));
    if(crit<2) crit=2; if(crit>28) crit=28;
    var dmg = SC.calcDamage(atk.atk, def.def, power, terrainDef, false);
    var dmgCrit = SC.calcDamage(atk.atk, def.def, power, terrainDef, true);
    var hit = SC.calcHit(hitBase, spdDiff, terrainAvoid);
    // 闪避被动
    if(def.skills.indexOf('evade')!==-1) hit-=12;
    if(hit<38) hit=38; if(hit>98) hit=98;
    return { damage:dmg, damageCrit:dmgCrit, hit:hit, crit:crit, isHeal:false };
  };
  BattleManager.prototype.roll = function(preview){
    var crit = Math.random()*100 < preview.crit;
    var hit = Math.random()*100 < preview.hit;
    return { hit:hit, crit:crit };
  };
  BattleManager.prototype.resolve = function(atk, def, grid, skillId){
    var pv = this.preview(atk, def, grid, skillId);
    if(pv.isHeal){
      var h = -pv.damage;
      def.heal(h);
      var expH = SC.expGain(atk.level, def.level, false, false);
      return { hit:true, crit:false, damage:-h, preview:pv, exp: Math.floor(expH/2) };
    }
    var r = this.roll(pv);
    if(!r.hit) return { hit:false, crit:false, damage:0, preview:pv, exp: 6 };
    var terrainDef = grid ? grid.terrainDefAt(def.c,def.r).def : 0;
    if(def.skills.indexOf('aegis')!==-1) terrainDef+=3;
    var power = SC.getSkill(skillId) ? SC.getSkill(skillId).power : 0;
    if(atk.skills.indexOf('arcane')!==-1 && atk.job==='mage') power+=2;
    var dmg = SC.calcDamage(atk.atk, def.def, power, terrainDef, r.crit);
    var killed = def.takeDamage(dmg);
    var expG = SC.expGain(atk.level, def.level, killed, !!def.isBoss);
    // 治疗者额外经验在 Tactics 侧处理
    return { hit:true, crit:r.crit, damage:dmg, killed:killed, preview:pv, exp:expG };
  };
  // 需额外判定：反击（距离1、存活、非治愈）
  BattleManager.prototype.canCounter = function(def, atk){ return def.isAlive() && Math.abs(def.c-atk.c)+Math.abs(def.r-atk.r) <= def.range && def.range===1; };
  SC.BattleManager = BattleManager;
})();
