// CQ.Equipment — 武器/防具/饰品（数据驱动，可购买/宝箱）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.EQUIP = [
    { id:'sword_iron',  name:'铁剑',     slot:'weapon', atk:4, def:0, spd:0, price:80,  desc:'基础近战武器' },
    { id:'sword_steel', name:'钢剑',     slot:'weapon', atk:8, def:1, spd:0, price:160, desc:'更锋利的剑' },
    { id:'bow_short',   name:'短弓',     slot:'weapon', atk:6, def:0, spd:1, price:90,  desc:'射程+1（ARPG/RTS 有效）' },
    { id:'staff_fire',  name:'火纹法杖', slot:'weapon', atk:9, def:0, spd:0, price:180, desc:'法术威力提升' },
    { id:'armor_leather', name:'皮甲',   slot:'armor',  atk:0, def:4, spd:0, price:70,  desc:'轻便护甲' },
    { id:'armor_plate',   name:'板甲',   slot:'armor',  atk:0, def:8, spd:-1, price:150, desc:'重甲，高防-1速' },
    { id:'ring_swift',    name:'疾风指环', slot:'acc',  atk:1, def:0, spd:2, price:120, desc:'移动更灵活' },
    { id:'amulet_guard',  name:'守护护符', slot:'acc',  atk:0, def:3, spd:0, price:110, desc:'额外护佑' }
  ];
  CQ.getEquip = function (id) {
    for (var i = 0; i < CQ.EQUIP.length; i++) if (CQ.EQUIP[i].id === id) return CQ.EQUIP[i];
    return null;
  };
})();
