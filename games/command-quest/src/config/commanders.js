// CQ.Commanders — 指挥官定义（数据驱动）
// 每指挥官：id/name/abbr/color/base + 成长 + 职业线 + 初始技能
(function () {
  'use strict';
  var CQ = window.CQ;
  // 成长：每级增量
  function growth(hp, atk, def, spd) { return { hp: hp, atk: atk, def: def, spd: spd }; }
  // 职业线：branchId -> {name, reqLv, bonus{hp/atk/def/spd}, skillId}
  CQ.CLASS_BRANCHES = {
    knight:   [
      { id:'squire',  name:'见习骑士', reqLv:1, bonus:{hp:6,atk:3,def:2,spd:0}, skill:'slash' },
      { id:'knight',  name:'骑士',     reqLv:3, bonus:{hp:12,atk:6,def:4,spd:1}, skill:'guard' },
      { id:'paladin', name:'圣骑士',   reqLv:6, bonus:{hp:20,atk:9,def:7,spd:1}, skill:'holy' }
    ],
    ranger:  [
      { id:'scout',   name:'斥候',     reqLv:1, bonus:{hp:4,atk:4,def:1,spd:2}, skill:'aim' },
      { id:'ranger',  name:'游侠',     reqLv:3, bonus:{hp:8,atk:7,def:2,spd:3}, skill:'volley' },
      { id:'sniper',  name:'神射手',   reqLv:6, bonus:{hp:14,atk:11,def:3,spd:4}, skill:'snipe' }
    ],
    mage:    [
      { id:'apprentice', name:'学徒',  reqLv:1, bonus:{hp:3,atk:5,def:1,spd:1}, skill:'fire' },
      { id:'mage',       name:'法师',  reqLv:3, bonus:{hp:7,atk:9,def:2,spd:2}, skill:'frost' },
      { id:'archmage',   name:'大法师',reqLv:6, bonus:{hp:12,atk:14,def:4,spd:3}, skill:'meteor' }
    ]
  };
  CQ.COMMANDERS = [
    { id:'c_aldric', name:'艾德里克', abbr:'A', color:0x3498db,
      branch:'knight', base:{hp:56, atk:13, def:8, spd:4}, grow:growth(7,2,1,0.3), startSkills:['slash','guard'], story:'序章·骑士誓言' },
    { id:'c_lyra',   name:'莉娅',     abbr:'L', color:0x9b59b6,
      branch:'ranger', base:{hp:46, atk:14, def:5, spd:6}, grow:growth(5,2,0.8,0.6), startSkills:['aim','volley'], story:'序章·森林回声' },
    { id:'c_orin',   name:'欧林',     abbr:'O', color:0xe67e22,
      branch:'mage',   base:{hp:42, atk:16, def:4, spd:5}, grow:growth(4,2.2,0.7,0.5), startSkills:['fire','frost'], story:'序章·星火初燃' }
  ];
  // 敌指挥官模板（AI 用，同结构，数值略低）
  CQ.ENEMY_COMMANDERS = [
    { id:'e_grim', name:'格里姆', abbr:'G', color:0xc0392b, branch:'knight', base:{hp:50, atk:12, def:7, spd:3}, grow:growth(6,1.8,1,0.2), startSkills:['slash'] },
    { id:'e_vex',  name:'薇克斯', abbr:'V', color:0x8e44ad, branch:'ranger', base:{hp:42, atk:13, def:5, spd:5}, grow:growth(5,1.9,0.8,0.5), startSkills:['aim'] },
    { id:'e_mork', name:'莫克',   abbr:'M', color:0xd35400, branch:'mage',   base:{hp:38, atk:15, def:4, spd:4}, grow:growth(4,2,0.7,0.4), startSkills:['fire'] }
  ];
  CQ.getCommanderDef = function (id) {
    for (var i = 0; i < CQ.COMMANDERS.length; i++) if (CQ.COMMANDERS[i].id === id) return CQ.COMMANDERS[i];
    for (var j = 0; j < CQ.ENEMY_COMMANDERS.length; j++) if (CQ.ENEMY_COMMANDERS[j].id === id) return CQ.ENEMY_COMMANDERS[j];
    return null;
  };
  CQ.getBranchSteps = function (branch) { return CQ.CLASS_BRANCHES[branch] || []; };
})();
