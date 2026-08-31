// SC.Enemies — 敌人模板
(function () {
  'use strict';
  var SC = window.SC;
  SC.ENEMIES = [
    { id:'soldier',  name:'士兵',  abbr:'SO', job:'knight', lv:1, color:0xe74c3c },
    { id:'archer_e', name:'敌弓',  abbr:'EA', job:'archer', lv:1, color:0xc0392b },
    { id:'mage_e',   name:'敌法',  abbr:'EM', job:'mage',   lv:2, color:0x8e44ad },
    { id:'boss_gale',name:'加雷斯',abbr:'GB', job:'knight', lv:3, color:0x2c3e50, isBoss:true },
    { id:'boss_morva',name:'莫尔瓦',abbr:'MV', job:'mage',  lv:6, color:0x1a1a2e, isBoss:true },
    { id:'boss_karn', name:'卡恩', abbr:'KA', job:'lord',   lv:8, color:0x4a0e0e, isBoss:true }
  ];
  SC.getEnemy = function (id) { for(var i=0;i<SC.ENEMIES.length;i++) if(SC.ENEMIES[i].id===id) return SC.ENEMIES[i]; return null; };
})();
