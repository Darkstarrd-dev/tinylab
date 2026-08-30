// TD.Towers — 10 种塔 × 4 级
(function () {
  'use strict';
  var TD = window.TD;
  // 每塔：id/name/abbr/color/base + levels[4]（L1 建造价，L2~L4 升级价）
  // projectileType: bullet | missile | laserTick | aura | support
  TD.TOWERS = [
    { id:'basic',   name:'基础炮', abbr:'B', color:0x95a5a6, base:{damage:18, range:120, fireRate:780, speed:420, ptype:'bullet'}, levels:[
      {damage:18, range:120, fireRate:780, cost:35, color2:0x95a5a6},
      {damage:28, range:130, fireRate:700, cost:45, color2:0xbdc3c7},
      {damage:42, range:140, fireRate:620, cost:75, color2:0xd5dbdb},
      {damage:62, range:150, fireRate:520, cost:120,color2:0xffffff}
    ]},
    { id:'sniper',  name:'狙击塔', abbr:'S', color:0x3498db, base:{damage:55, range:210, fireRate:1600,speed:900, ptype:'bullet'}, levels:[
      {damage:55, range:210, fireRate:1600,cost:70, color2:0x3498db},
      {damage:85, range:235, fireRate:1500,cost:90, color2:0x5dade2},
      {damage:125,range:260, fireRate:1350,cost:140,color2:0x85c1e9},
      {damage:190,range:290, fireRate:1200,cost:220,color2:0xaed6f1}
    ]},
    { id:'splash',  name:'爆破塔', abbr:'A', color:0xe67e22, base:{damage:26, range:105, fireRate:1100,speed:360, ptype:'missile'}, levels:[
      {damage:26, range:105, fireRate:1100,cost:65, color2:0xe67e22},
      {damage:38, range:115, fireRate:1000,cost:80, color2:0xf0a030},
      {damage:58, range:125, fireRate:900, cost:120,color2:0xf5b041},
      {damage:88, range:135, fireRate:800, cost:190,color2:0xfad7a0}
    ]},
    { id:'frost',   name:'寒冰塔', abbr:'F', color:0x5dade2, base:{damage:12, range:115, fireRate:900, speed:380, ptype:'bullet'}, levels:[
      {damage:12, range:115, fireRate:900, cost:55, color2:0x5dade2},
      {damage:18, range:125, fireRate:820, cost:70, color2:0x85c1e9},
      {damage:26, range:135, fireRate:740, cost:110,color2:0xaed6f1},
      {damage:38, range:145, fireRate:660, cost:170,color2:0xd6eaf8}
    ]},
    { id:'poison',  name:'毒液塔', abbr:'P', color:0x2ecc71, base:{damage:10, range:110, fireRate:700, speed:400, ptype:'bullet'}, levels:[
      {damage:10, range:110, fireRate:700, cost:60, color2:0x2ecc71},
      {damage:15, range:120, fireRate:640, cost:75, color2:0x58d68d},
      {damage:22, range:130, fireRate:580, cost:115,color2:0x82e0aa},
      {damage:34, range:140, fireRate:520, cost:180,color2:0xa9dfbf}
    ]},
    { id:'rapid',   name:'速射塔', abbr:'R', color:0xf1c40f, base:{damage:9,  range:105, fireRate:220, speed:480, ptype:'bullet'}, levels:[
      {damage:9,  range:105, fireRate:220, cost:50, color2:0xf1c40f},
      {damage:13, range:112, fireRate:200, cost:65, color2:0xf4d03f},
      {damage:19, range:120, fireRate:180, cost:100,color2:0xf7dc6f},
      {damage:28, range:128, fireRate:160, cost:160,color2:0xf9e79f}
    ]},
    { id:'laser',   name:'激光塔', abbr:'L', color:0x9b59b6, base:{damage:14, range:130, fireRate:120, speed:0,   ptype:'laserTick'}, levels:[
      {damage:14, range:130, fireRate:120, cost:85, color2:0x9b59b6},
      {damage:22, range:140, fireRate:110, cost:110,color2:0xbb8fce},
      {damage:34, range:150, fireRate:100, cost:165,color2:0xd2b4de},
      {damage:52, range:160, fireRate:90,  cost:260,color2:0xe8daef}
    ]},
    { id:'missile', name:'导弹塔', abbr:'M', color:0xe74c3c, base:{damage:40, range:150, fireRate:1400,speed:300, ptype:'missile'}, levels:[
      {damage:40, range:150, fireRate:1400,cost:80, color2:0xe74c3c},
      {damage:62, range:165, fireRate:1300,cost:105,color2:0xec7063},
      {damage:92, range:180, fireRate:1200,cost:160,color2:0xf1948a},
      {damage:140,range:195, fireRate:1100,cost:250,color2:0xf5b7b1}
    ]},
    { id:'tesla',   name:'电弧塔', abbr:'T', color:0x00cec9, base:{damage:16, range:95,  fireRate:600, speed:0,   ptype:'aura'}, levels:[
      {damage:16, range:95,  fireRate:600, cost:75, color2:0x00cec9},
      {damage:24, range:105, fireRate:540, cost:95, color2:0x48dbfb},
      {damage:36, range:115, fireRate:480, cost:145,color2:0x7fdbff},
      {damage:54, range:125, fireRate:420, cost:230,color2:0xb0eaff}
    ]},
    { id:'support', name:'增幅塔', abbr:'U', color:0xf39c12, base:{damage:0,  range:110, fireRate:0,   speed:0,   ptype:'support'}, levels:[
      {damage:0, range:110, fireRate:0, cost:90, color2:0xf39c12},
      {damage:0, range:120, fireRate:0, cost:110,color2:0xf5b041},
      {damage:0, range:130, fireRate:0, cost:165,color2:0xf8c471},
      {damage:0, range:140, fireRate:0, cost:260,color2:0xfdebd0}
    ]}
  ];
  TD.getTowerDef = function (id) {
    for (var i = 0; i < TD.TOWERS.length; i++) if (TD.TOWERS[i].id === id) return TD.TOWERS[i];
    return null;
  };
  // 升到 lv(2..4) 所需费用；lv=1 返回建造价
  TD.getTowerLevelCost = function (id, lv) {
    var d = TD.getTowerDef(id); if (!d) return 9999;
    var idx = Math.max(0, Math.min(3, lv - 1));
    return d.levels[idx].cost;
  };
  TD.getTowerStatsAt = function (id, lv) {
    var d = TD.getTowerDef(id); if (!d) return null;
    var idx = Math.max(0, Math.min(3, lv - 1));
    return d.levels[idx];
  };
})();
