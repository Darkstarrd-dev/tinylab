// SC.Classes — 职业 + 转职树
(function () {
  'use strict';
  var SC = window.SC;
  // 每职业：id/name/abbr/color, base{hp,atk,def,spd,mov,range}, growth{hp,atk,def,spd}, weapon
  SC.CLASSES = [
    { id:'lord',   name:'领主', abbr:'LD', color:0x3498db, mov:5, range:1, weapon:'sword', base:{hp:18,atk:7,def:4,spd:6}, growth:{hp:72,atk:45,def:28,spd:40} },
    { id:'knight', name:'骑士', abbr:'KN', color:0x95a5a6, mov:6, range:1, weapon:'lance', base:{hp:20,atk:8,def:7,spd:4}, growth:{hp:80,atk:42,def:48,spd:25} },
    { id:'archer', name:'弓手', abbr:'AR', color:0x2ecc71, mov:5, range:2, weapon:'bow',   base:{hp:16,atk:7,def:3,spd:7}, growth:{hp:64,atk:48,def:22,spd:45} },
    { id:'mage',   name:'法师', abbr:'MG', color:0x9b59b6, mov:5, range:2, weapon:'tome',  base:{hp:14,atk:9,def:2,spd:6}, growth:{hp:58,atk:52,def:18,spd:38} },
    { id:'cleric', name:'僧侣', abbr:'CL', color:0xf1c40f, mov:5, range:2, weapon:'staff', base:{hp:15,atk:4,def:3,spd:5}, growth:{hp:62,atk:28,def:24,spd:32} },
    { id:'thief',  name:'盗贼', abbr:'TH', color:0xe67e22, mov:6, range:1, weapon:'sword', base:{hp:15,atk:6,def:3,spd:9}, growth:{hp:60,atk:38,def:20,spd:55} },
    // 进阶（转职后）
    { id:'paladin',  name:'圣骑士', abbr:'PL', color:0xbdc3c7, mov:7, range:1, weapon:'lance', base:{hp:24,atk:10,def:9,spd:6}, growth:{hp:82,atk:44,def:50,spd:30} },
    { id:'sniper',   name:'狙击手', abbr:'SN', color:0x27ae60, mov:5, range:3, weapon:'bow',   base:{hp:19,atk:11,def:4,spd:8}, growth:{hp:66,atk:50,def:24,spd:48} },
    { id:'sage',     name:'贤者',   abbr:'SA', color:0x8e44ad, mov:5, range:2, weapon:'tome',  base:{hp:18,atk:12,def:4,spd:7}, growth:{hp:62,atk:54,def:22,spd:40} },
    { id:'bishop',   name:'主教',   abbr:'BS', color:0xf39c12, mov:5, range:2, weapon:'staff', base:{hp:19,atk:7, def:5,spd:6}, growth:{hp:68,atk:32,def:30,spd:34} },
    { id:'assassin', name:'暗杀者', abbr:'AS', color:0xd35400, mov:7, range:1, weapon:'sword', base:{hp:18,atk:10,def:4,spd:11},growth:{hp:64,atk:44,def:22,spd:58} },
    { id:'greatlord',name:'大领主', abbr:'GL', color:0x2980b9, mov:6, range:1, weapon:'sword', base:{hp:26,atk:12,def:8,spd:8}, growth:{hp:78,atk:48,def:36,spd:44} }
  ];
  // 转职树：base -> [advanced]，Lv10 可转职，需满足 chapter>=阈值
  SC.PROMOTIONS = {
    lord:   [{ to:'greatlord', needLv:10, needChapter:3 }],
    knight: [{ to:'paladin',   needLv:10, needChapter:2 }],
    archer: [{ to:'sniper',    needLv:10, needChapter:2 }],
    mage:   [{ to:'sage',      needLv:10, needChapter:3 }],
    cleric: [{ to:'bishop',    needLv:10, needChapter:3 }],
    thief:  [{ to:'assassin',  needLv:10, needChapter:2 }]
  };
  SC.getClass = function (id) { for (var i=0;i<SC.CLASSES.length;i++) if(SC.CLASSES[i].id===id) return SC.CLASSES[i]; return null; };
  SC.getPromotions = function (classId) { return SC.PROMOTIONS[classId] || []; };
  SC.canPromote = function (unit, chapterId) {
    var opts = SC.getPromotions(unit.job);
    var res = [];
    for (var i=0;i<opts.length;i++) { var o=opts[i]; if(unit.level>=o.needLv && chapterId>=o.needChapter) res.push(o); }
    return res;
  };
})();
