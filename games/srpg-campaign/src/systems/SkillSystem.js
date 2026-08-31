// SC.SkillSystem — 技能可用性与消耗
(function () {
  'use strict';
  var SC = window.SC;
  function SkillSystem(){}
  SkillSystem.prototype.availableSkills = function(unit){
    var ids = unit.skills || [];
    var res=[];
    for(var i=0;i<ids.length;i++){ var s=SC.getSkill(ids[i]); if(s) res.push(s); }
    return res;
  };
  SkillSystem.prototype.activeSkills = function(unit){
    return this.availableSkills(unit).filter(function(s){return s.type==='active';});
  };
  SkillSystem.prototype.canUse = function(unit, skillId, target){
    var sk=SC.getSkill(skillId); if(!sk) return false;
    if(unit.skills.indexOf(skillId)===-1) return false;
    if(target){
      var d=Math.abs(unit.c-target.c)+Math.abs(unit.r-target.r);
      if(d>sk.range || d===0) return false;
      if(sk.power<0 && target.side!=='player') return false;
      if(sk.power>=0 && target.side==='player' && unit.side==='player') return false;
    }
    return true;
  };
  SC.SkillSystem = SkillSystem;
})();
