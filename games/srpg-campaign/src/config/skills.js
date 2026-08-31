// SC.Skills — 职业技能（主动/被动）
(function () {
  'use strict';
  var SC = window.SC;
  SC.SKILLS = [
    { id:'slash',     name:'斩击',   type:'active', range:1, power:8,  hit:95, cost:0,  desc:'基础近战', job:'sword' },
    { id:'pierce',    name:'突刺',   type:'active', range:1, power:10, hit:90, cost:0,  desc:'骑士突击', job:'lance' },
    { id:'volley',    name:'齐射',   type:'active', range:2, power:7,  hit:92, cost:0,  desc:'二连击', job:'bow' },
    { id:'fire',      name:'火球',   type:'active', range:2, power:11, hit:88, cost:2,  desc:'火属性', job:'tome' },
    { id:'heal',      name:'治愈',   type:'active', range:2, power:-12,hit:100,cost:3,  desc:'回复', job:'staff' },
    { id:'backstab',  name:'背刺',   type:'active', range:1, power:14, hit:82, cost:1,  desc:'侧背增伤', job:'sword' },
    { id:'aegis',     name:'盾护',   type:'passive', desc:'受击-3伤害', job:'lance' },
    { id:'focus',     name:'专注',   type:'passive', desc:'命中+10', job:'bow' },
    { id:'arcane',    name:'奥术',   type:'passive', desc:'法术+2威力', job:'tome' },
    { id:'evade',     name:'闪避',   type:'passive', desc:'回避+12', job:'sword' },
    // 进阶
    { id:'astra',     name:'流星',   type:'active', range:1, power:6, hit:88, cost:4, desc:'5连击', job:'sword' },
    { id:'greatshield',name:'圣盾',  type:'active', range:1, power:0, hit:100,cost:3, desc:'本回合防御+6', job:'lance' },
    { id:'deadeye',   name:'狙杀',   type:'active', range:3, power:16,hit:78, cost:4, desc:'远距狙击', job:'bow' },
    { id:'meteor',    name:'陨星',   type:'active', range:2, power:20,hit:75, cost:6, desc:'范围1', job:'tome' },
    { id:'revive',    name:'复苏',   type:'active', range:2, power:-20,hit:100,cost:6, desc:'复活', job:'staff' }
  ];
  // 职业默认技能
  SC.JOB_SKILLS = {
    lord: ['slash','evade'], knight:['pierce','aegis'], archer:['volley','focus'],
    mage:['fire','arcane'], cleric:['heal'], thief:['backstab','evade'],
    paladin:['pierce','aegis','greatshield'], sniper:['volley','focus','deadeye'],
    sage:['fire','arcane','meteor'], bishop:['heal','revive'], assassin:['backstab','evade','astra'],
    greatlord:['slash','evade','astra']
  };
  SC.getSkill = function (id) { for(var i=0;i<SC.SKILLS.length;i++) if(SC.SKILLS[i].id===id) return SC.SKILLS[i]; return null; };
  SC.getJobSkills = function (job) { return SC.JOB_SKILLS[job] || []; };
})();
