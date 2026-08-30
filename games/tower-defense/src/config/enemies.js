// TD.Enemies — 10 种敌人
(function () {
  'use strict';
  var TD = window.TD;
  TD.ENEMIES = [
    { id:'grunt',   name:'杂兵',   abbr:'G', color:0xe74c3c, hp:34,  speed:72,  reward:6,  armor:0, slowResist:0,   flying:false },
    { id:'swift',   name:'疾行',   abbr:'S', color:0xf1c40f, hp:20,  speed:145, reward:7,  armor:0, slowResist:0.2, flying:false },
    { id:'tank',    name:'重甲',   abbr:'T', color:0x7f8c8d, hp:140, speed:48,  reward:14, armor:4, slowResist:0.5, flying:false },
    { id:'flyer',   name:'飞蝠',   abbr:'F', color:0x9b59b6, hp:28,  speed:95,  reward:9,  armor:0, slowResist:1,   flying:true  },
    { id:'healer',  name:'祭司',   abbr:'H', color:0x2ecc71, hp:55,  speed:62,  reward:11, armor:0, slowResist:0,   flying:false },
    { id:'split',   name:'分裂',   abbr:'D', color:0xe67e22, hp:50,  speed:68,  reward:10, armor:1, slowResist:0,   flying:false },
    { id:'ghost',   name:'幽灵',   abbr:'W', color:0x5dade2, hp:32,  speed:110, reward:12, armor:0, slowResist:0.8, flying:true  },
    { id:'brute',   name:'蛮牛',   abbr:'B', color:0xc0392b, hp:220, speed:52,  reward:18, armor:6, slowResist:0.4, flying:false },
    { id:'swarm',   name:'虫群',   abbr:'C', color:0x16a085, hp:14,  speed:125, reward:4,  armor:0, slowResist:0,   flying:false },
    { id:'boss',    name:'首领',   abbr:'X', color:0x2c3e50, hp:520, speed:42,  reward:28, armor:8, slowResist:0.6, flying:false }
  ];
  TD.getEnemyDef = function (id) {
    for (var i = 0; i < TD.ENEMIES.length; i++) if (TD.ENEMIES[i].id === id) return TD.ENEMIES[i];
    return null;
  };
})();
