// SC.Characters — 可加入角色
(function () {
  'use strict';
  var SC = window.SC;
  SC.CHARACTERS = [
    { id:'aryana', name:'艾莉安娜', abbr:'AL', job:'lord',   lv:1, joinChapter:1, desc:'星痕继承者，均衡型领主' },
    { id:'garren',  name:'加伦',     abbr:'GA', job:'knight', lv:1, joinChapter:1, desc:'忠诚骑士，高防高机动' },
    { id:'lynn',    name:'琳恩',     abbr:'LY', job:'archer', lv:1, joinChapter:1, desc:'游击射手，森林特化' },
    { id:'mirelle', name:'米蕾尔',   abbr:'MI', job:'mage',   lv:2, joinChapter:2, desc:'天才法师，范围法术' },
    { id:'brock',   name:'布洛克',   abbr:'BR', job:'cleric', lv:1, joinChapter:2, desc:'随军僧侣，治愈/复活' },
    { id:'shade',   name:'影',       abbr:'SH', job:'thief',  lv:3, joinChapter:2, desc:'影刃盗贼，高速背刺', branch:'B' },
    { id:'valdris', name:'瓦尔德',   abbr:'VA', job:'knight', lv:4, joinChapter:3, desc:'重甲圣骑，分支加入', branch:'A' }
  ];
  SC.getChar = function (id) { for(var i=0;i<SC.CHARACTERS.length;i++) if(SC.CHARACTERS[i].id===id) return SC.CHARACTERS[i]; return null; };
})();
