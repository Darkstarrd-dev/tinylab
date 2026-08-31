// CQ.Skills — 技能表（数值驱动，跨三模态共用伤害公式）
(function () {
  'use strict';
  var CQ = window.CQ;
  // 每个技能：id/name/desc/range/costMp/cooldown(回合或秒)/power(系数)/kind
  CQ.SKILLS = [
    { id:'slash',  name:'斩击',   desc:'近战单体',       range:1, costMp:0, cd:0, power:1.0, kind:'melee' },
    { id:'guard',  name:'守护',   desc:'自身+3防1回合', range:0, costMp:4, cd:2, power:0,   kind:'buff' },
    { id:'holy',   name:'圣光',   desc:'治疗+驱散',     range:2, costMp:8, cd:3, power:1.2, kind:'heal' },
    { id:'aim',    name:'瞄准',   desc:'下次攻击必中',   range:0, costMp:3, cd:2, power:0,   kind:'buff' },
    { id:'volley', name:'箭雨',   desc:'范围2格伤害',   range:3, costMp:6, cd:2, power:0.8, kind:'ranged' },
    { id:'snipe',  name:'狙击',   desc:'超远单体高伤',   range:5, costMp:7, cd:3, power:1.5, kind:'ranged' },
    { id:'fire',   name:'火球',   desc:'单体火焰',       range:3, costMp:5, cd:1, power:1.1, kind:'magic' },
    { id:'frost',  name:'寒霜',   desc:'减速+伤害',     range:3, costMp:6, cd:2, power:0.9, kind:'magic' },
    { id:'meteor', name:'陨星',   desc:'范围3格大伤害', range:4, costMp:10,cd:4, power:1.4, kind:'magic' }
  ];
  CQ.getSkill = function (id) {
    for (var i = 0; i < CQ.SKILLS.length; i++) if (CQ.SKILLS[i].id === id) return CQ.SKILLS[i];
    return null;
  };
})();
