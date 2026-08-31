// SC.Chapters — 5章分歧（分支由 flags/选择驱动，非线性）
(function () {
  'use strict';
  var SC = window.SC;
  // 分歧规则：
  // - CH2 结尾 avgChoice flag: route = 'A'(救村) / 'B'(追敌)
  // - CH3 存在 3A/3B 两条地图与剧情，奖励角色不同（3A得瓦尔德，3B得影的进阶道具）
  // - CH4 再按 route + CH3 胜利条件分支：4A/4B
  // - CH5 终章按累计 flags 分真结局/通常结局

  function rows(str) { return str.trim().split('\n').map(function(s){ return s.trim(); }); }

  SC.CHAPTERS = [
    {
      id:1, title:'第一章  星痕觉醒', desc:'领主初阵，熟悉战棋',
      map: rows(
        "..............\n" +
        "..............\n" +
        "..FF....FF....\n" +
        "..FF....FF....\n" +
        "..............\n" +
        "......HH......\n" +
        "..............\n" +
        "...FF....FF...\n" +
        "..............\n" +
        ".............."
      ),
      playerStarts: [{ charId:'aryana', c:4,r:8 },{ charId:'garren', c:5,r:8 },{ charId:'lynn', c:6,r:8 }],
      enemyPlacements: [{ enemyId:'soldier', c:6,r:2 },{ enemyId:'soldier', c:8,r:3 },{ enemyId:'archer_e', c:7,r:2 },{ enemyId:'boss_gale', c:7,r:1 }],
      win: '击败敌将加雷斯',
      avgBefore: [
        { bg:'#1a2332', speaker:'艾莉安娜', text:'星痕在动……父亲的剑，回应我了。' },
        { speaker:'加伦', text:'殿下，前方就是封锁线。敌军不大，但别大意。' },
        { speaker:'琳恩', text:'我在林间架好了射角，殿下下令便可。' },
        { speaker:'', text:'—— 教学：光标移动→选择单位→移动→攻击/待机。地形影响防御与命中。', type:'narration' }
      ],
      avgMid: [
        { speaker:'加雷斯', text:'哼，小丫头也敢持剑？' }
      ],
      avgAfter: [
        { speaker:'艾莉安娜', text:'结束了……但这只是开始。' },
        { speaker:'加伦', text:'殿下，斥候回报：东村告急，西路出现敌影。下一步如何？' },
        { choices:[ { text:'东进救村（路线A）', setFlag:{route:'A'} }, { text:'西追敌踪（路线B）', setFlag:{route:'B'} } ] }
      ]
    },
    {
      id:2, title:'第二章  分歧之路', desc:'AVG分歧：你的选择决定下一章',
      // 实际地图由分支决定（2 共用一张，3 开始分）
      map: rows(
        "WWWWWWWWWWWWWW\n" +
        "W............W\n" +
        "W..FF....FF..W\n" +
        "W..FF....FF..W\n" +
        "W............W\n" +
        "W.....HH.....W\n" +
        "W............W\n" +
        "W..FF....FF..W\n" +
        "W............W\n" +
        "WWWWWWWWWWWWWW"
      ),
      playerStarts: [{ charId:'aryana', c:6,r:7 },{ charId:'garren', c:5,r:7 },{ charId:'lynn', c:7,r:7 },{ charId:'mirelle', c:6,r:8 },{ charId:'brock', c:5,r:8 }],
      // 分支 3A/3B 预示：2 的敌配置相同，剧情不同
      enemyPlacements: [{ enemyId:'soldier', c:6,r:2 },{ enemyId:'archer_e', c:4,r:3 },{ enemyId:'archer_e', c:8,r:3 },{ enemyId:'mage_e', c:6,r:1 },{ enemyId:'soldier', c:5,r:2 }],
      win: '压制敌阵',
      avgBefore: [
        { bg:'#162040', speaker:'米蕾尔', text:'我来支援。星痕的波动……和典籍里的一样。' },
        { speaker:'布洛克', text:'诸位，前线交给我，伤者我来照料。' },
        { cond:'route=A', speaker:'艾莉安娜', text:'先救村庄。不能让百姓为我们的犹豫买单。' },
        { cond:'route=B', speaker:'艾莉安娜', text:'不能放走敌踪。追上去，切断他们的后路。' }
      ],
      avgAfter: [
        { cond:'route=A', speaker:'村长', text:'多谢殿下！我们愿追随星痕。瓦尔德大人也在村中，愿效忠。', setFlag:{recruitValdris:true} },
        { cond:'route=B', speaker:'影', text:'……你追得挺快。雇我吧，我带你穿过密林。', setFlag:{recruitShade:true} },
        { speaker:'', text:'—— 选择已记录，将影响第三章地图与加入角色。', type:'narration' }
      ]
    },
    {
      id:3, title:'第三章  林与山', desc:'分歧章：A 山道 / B 密林',
      variants: {
        A: {
          map: rows(
            "MMMMMMMMMMMMMM\n" +
            "M............M\n" +
            "M..MM....MM..M\n" +
            "M..MM....MM..M\n" +
            "M............M\n" +
            "M.....RR.....M\n" +
            "M............M\n" +
            "M..MM....MM..M\n" +
            "M............M\n" +
            "MMMMMMMMMMMMMM"
          ),
          extraUnits: [{ charId:'valdris', c:6,r:7 }],
          enemyPlacements: [{ enemyId:'soldier', c:6,r:2 },{ enemyId:'soldier', c:4,r:3 },{ enemyId:'mage_e', c:7,r:2 },{ enemyId:'boss_morva', c:6,r:1 }],
          win: '击败莫尔瓦（山道）',
          avgBefore: [
            { bg:'#3a2a1a', speaker:'瓦尔德', text:'山道我熟。殿下跟我来。' },
            { speaker:'莫尔瓦', text:'星痕……终于来了。' }
          ],
          avgAfter: [
            { speaker:'瓦尔德', text:'此战之后，山民皆为殿下所用。' },
            { speaker:'艾莉安娜', text:'下一个战场，定要终结这一切。' }
          ]
        },
        B: {
          map: rows(
            "FFFFFFFFFFFFFF\n" +
            "F............F\n" +
            "F..FF....FF..F\n" +
            "F..FF....FF..F\n" +
            "F............F\n" +
            "F.....WW.....F\n" +
            "F............F\n" +
            "F..FF....FF..F\n" +
            "F............F\n" +
            "FFFFFFFFFFFFFF"
          ),
          extraUnits: [{ charId:'shade', c:6,r:7 }],
          enemyPlacements: [{ enemyId:'soldier', c:6,r:2 },{ enemyId:'archer_e', c:4,r:3 },{ enemyId:'archer_e', c:8,r:3 },{ enemyId:'mage_e', c:6,r:2 },{ enemyId:'boss_morva', c:6,r:1 }],
          win: '击败莫尔瓦（密林）',
          avgBefore: [
            { bg:'#1b4d2e', speaker:'影', text:'密林是我的地盘。别掉队。' },
            { speaker:'莫尔瓦', text:'星痕……终于来了。' }
          ],
          avgAfter: [
            { speaker:'影', text:'报酬记得加倍。——开玩笑的。' },
            { speaker:'艾莉安娜', text:'下一个战场，定要终结这一切。' }
          ]
        }
      }
    },
    {
      id:4, title:'第四章  双城战线', desc:'再分歧：据路线与战果决定 4A/4B',
      variants: {
        A: {
          map: rows(
            "....RR....RR..\n" +
            "....RR....RR..\n" +
            "..FF..HH..FF..\n" +
            "..............\n" +
            "....WWWWWW....\n" +
            "....WWWWWW....\n" +
            "..............\n" +
            "..FF..HH..FF..\n" +
            "....RR....RR..\n" +
            "....RR....RR.."
          ),
          enemyPlacements: [{ enemyId:'soldier', c:5,r:2 },{ enemyId:'soldier', c:8,r:2 },{ enemyId:'archer_e', c:4,r:3 },{ enemyId:'mage_e', c:7,r:3 },{ enemyId:'soldier', c:6,r:1 }],
          win: '压制双城',
          avgBefore: [{ bg:'#1d2a4a', speaker:'艾莉安娜', text:'双城并进，不留退路。' }],
          avgAfter: [{ speaker:'艾莉安娜', text:'只剩下王座了。' }]
        },
        B: {
          map: rows(
            "WW..FF....FF..\n" +
            "WW..FF....FF..\n" +
            "WW............\n" +
            "WW.....HH.....\n" +
            "WW..MM....MM..\n" +
            "WW..MM....MM..\n" +
            "WW............\n" +
            "WW..FF....FF..\n" +
            "WW............\n" +
            "WWWWWWWWWWWWWW"
          ),
          enemyPlacements: [{ enemyId:'soldier', c:6,r:2 },{ enemyId:'archer_e', c:8,r:3 },{ enemyId:'mage_e', c:5,r:2 },{ enemyId:'soldier', c:4,r:3 },{ enemyId:'soldier', c:7,r:1 }],
          win: '压制西城',
          avgBefore: [{ bg:'#2a1a3a', speaker:'艾莉安娜', text:'西城先下，再图王座。' }],
          avgAfter: [{ speaker:'艾莉安娜', text:'只剩下王座了。' }]
        }
      }
    },
    {
      id:5, title:'第五章  星痕王座', desc:'终章：旗帜决定真结局',
      // 终章再按累计旗帜分支演出（地图同，AVG不同）
      map: rows(
        "HHHHHHHHHHHHHH\n" +
        "H............H\n" +
        "H..MM....MM..H\n" +
        "H..MM....MM..H\n" +
        "H............H\n" +
        "H.....RR.....H\n" +
        "H............H\n" +
        "H..FF....FF..H\n" +
        "H............H\n" +
        "HHHHHHHHHHHHHH"
      ),
      playerStarts: [{ charId:'aryana', c:6,r:7 },{ charId:'garren', c:5,r:7 },{ charId:'lynn', c:7,r:7 },{ charId:'mirelle', c:6,r:8 },{ charId:'brock', c:5,r:8 }],
      enemyPlacements: [{ enemyId:'soldier', c:5,r:2 },{ enemyId:'soldier', c:8,r:2 },{ enemyId:'archer_e', c:4,r:3 },{ enemyId:'mage_e', c:7,r:2 },{ enemyId:'boss_karn', c:6,r:1 }],
      win: '击败卡恩',
      avgBefore: [
        { bg:'#0e1a2e', speaker:'卡恩', text:'星痕……归我了。' },
        { cond:'route=A', speaker:'瓦尔德', text:'殿下，山民与我同在。' },
        { cond:'route=B', speaker:'影', text:'殿下，密林的路我已铺好。' }
      ],
      avgAfter: [
        { cond:'allied>=3', speaker:'艾莉安娜', text:'星痕回应了所有人的心意——真结局：群星之誓。' },
        { cond:'allied<3', speaker:'艾莉安娜', text:'星痕回应了我一人——通常结局：孤星之誓。' },
        { speaker:'', text:'—— 通关。战绩已存档，可回章节选择重走分支。', type:'narration' }
      ]
    }
  ];

  // 按 flags 选取变体
  SC.resolveChapter = function (chapterId) {
    var ch = null;
    for (var i=0;i<SC.CHAPTERS.length;i++) if(SC.CHAPTERS[i].id===chapterId) { ch = SC.CHAPTERS[i]; break; }
    if (!ch) return null;
    if (!ch.variants) return ch;
    var route = SC.flags.route || 'A';
    // CH3 直接按 route；CH4 按 route 镜像
    var key = route;
    if (chapterId === 4) {
      // 若 CH3 未记录，仍按 route
      key = route;
    }
    return ch.variants[key] ? Object.assign({}, ch, ch.variants[key], { id: chapterId, title: ch.title }) : ch;
  };
})();
