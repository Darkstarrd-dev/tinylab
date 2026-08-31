// RS.Units — 兵种
(function () {
  'use strict';
  var RS = window.RS;
  RS.UNITS = [
    { id:'worker', name:'工兵', abbr:'W', color:0xf1c40f, hp:52, atk:6,  def:1, spd:84, range:1, sight:5, cost:{gold:48, wood:0}, buildTime:1900, canGather:true },
    { id:'rifle',  name:'步枪兵', abbr:'R', color:0x3498db, hp:68, atk:11, def:2, spd:76, range:3, sight:6, cost:{gold:72, wood:0}, buildTime:2400 },
    { id:'archer', name:'游侠', abbr:'A', color:0x2ecc71, hp:58, atk:13, def:1, spd:80, range:4, sight:6, cost:{gold:64, wood:18}, buildTime:2600 },
    { id:'tank',   name:'重甲', abbr:'T', color:0x95a5a6, hp:120,atk:14, def:6, spd:52, range:1, sight:5, cost:{gold:110,wood:22}, buildTime:3400 },
    { id:'mage',   name:'术士', abbr:'M', color:0x9b59b6, hp:54, atk:18, def:1, spd:70, range:4, sight:6, cost:{gold:90, wood:28}, buildTime:3200 },
    { id:'scout',  name:'斥候', abbr:'S', color:0xe67e22, hp:48, atk:7,  def:1, spd:108,range:2, sight:8, cost:{gold:56, wood:8}, buildTime:2000 }
  ];
  RS.getUnitDef = function(id){ for(var i=0;i<RS.UNITS.length;i++) if(RS.UNITS[i].id===id) return RS.UNITS[i]; return null; };
})();
