// CQ.Soldiers — 士兵兵种（数据驱动，算作指挥官属性，按模式表现不同）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.SOLDIERS = [
    { id:'infantry', name:'步兵',   abbr:'I', color:0x95a5a6, hp:18, atk:6, def:3, spd:3, range:1, cost:0 },
    { id:'archer',   name:'弓手',   abbr:'B', color:0x3498db, hp:14, atk:8, def:2, spd:4, range:3, cost:30 },
    { id:'cavalry',  name:'骑兵',   abbr:'C', color:0xf1c40f, hp:22, atk:7, def:4, spd:5, range:1, cost:45 },
    { id:'mage',     name:'术士',   abbr:'W', color:0x9b59b6, hp:12, atk:10,def:1, spd:3, range:2, cost:50 },
    { id:'healer',   name:'医师',   abbr:'H', color:0x2ecc71, hp:14, atk:3, def:2, spd:3, range:1, cost:40 }
  ];
  CQ.getSoldierDef = function (id) {
    for (var i = 0; i < CQ.SOLDIERS.length; i++) if (CQ.SOLDIERS[i].id === id) return CQ.SOLDIERS[i];
    return null;
  };
})();
