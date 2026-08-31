// RS.Buildings — 建筑
(function () {
  'use strict';
  var RS = window.RS;
  RS.BUILDINGS = [
    { id:'base',    name:'基地',   abbr:'BA', color:0x2980b9, hp:520, size:2, sight:7, cost:{gold:0,wood:0}, buildTime:0, produces:['worker'], desc:'人口+8' },
    { id:'barracks',name:'兵营',  abbr:'BR', color:0x7f8c8d, hp:300, size:2, sight:5, cost:{gold:120,wood:40}, buildTime:4200, produces:['rifle','tank','scout'] },
    { id:'archery', name:'靶场',   abbr:'AR', color:0x27ae60, hp:260, size:2, sight:5, cost:{gold:100,wood:60}, buildTime:3800, produces:['archer'] },
    { id:'tower',   name:'塔楼',  abbr:'TO', color:0x8e44ad, hp:200, size:1, sight:8, cost:{gold:80, wood:30}, buildTime:3000, produces:['mage'] },
    { id:'house',   name:'民房',  abbr:'HO', color:0xf39c12, hp:160, size:1, sight:3, cost:{gold:40, wood:24}, buildTime:1800, produces:[], desc:'人口+6' }
  ];
  RS.getBuildingDef = function(id){ for(var i=0;i<RS.BUILDINGS.length;i++) if(RS.BUILDINGS[i].id===id) return RS.BUILDINGS[i]; return null; };
})();
