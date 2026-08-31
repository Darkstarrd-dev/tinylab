// CQ.AvgScripts — 过场 AVG 剧本（数据驱动）
// 结构：[{ id, title, nodes: [{bg,speaker,text,choices:[{text,next,setFlag,requireFlag}]}] }]
// 引擎见 AvgScene；speaker 为 'narrator' 时作旁白
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.AVG_SCRIPTS = [
    {
      id: 'prologue',
      title: '序章 · 集结',
      nodes: [
        { id:'p0', speaker:'narrator', text:'边境的烽火再次燃起。三位指挥官在古遗迹前集结——每人身后都跟着誓死的士兵。', next:'p1' },
        { id:'p1', speaker:'narrator', text:'你是指挥官们的领主。选择你的道路，同一支队伍将在三种战术形态下作战。', choices:[
          { text:'以战棋之道行军（回合制）', next:'p2', setFlag:'preferredMode', setVal:'srpg' },
          { text:'以突击之势奔袭（ARPG）',   next:'p2', setFlag:'preferredMode', setVal:'arpg' },
          { text:'以统御之姿调度（RTS）',    next:'p2', setFlag:'preferredMode', setVal:'rts' }
        ]},
        { id:'p2', speaker:'艾德里克', text:'士兵即是我们的延伸。指挥官倒下，全队溃散；士兵虽小，却能成势。', next:'p3' },
        { id:'p3', speaker:'莉娅', text:'宝箱、商店、旅人——地图会给我们答案。别漏掉任何一个角落。', next:'p4' },
        { id:'p4', speaker:'欧林', text:'敌人分批而来，越后越强。准备好，就踏上这张随机生成的战场吧。', next:null }
      ]
    },
    {
      id: 'mid',
      title: '中场 · 抉择',
      nodes: [
        { id:'m0', speaker:'narrator', text:'战况胶着，斥候带回情报：敌方增援将至。', next:'m1' },
        { id:'m1', speaker:'narrator', text:'你可以选择切换战术形态，或继续当前形态作战。', choices:[
          { text:'继续当前形态', next:null },
          { text:'切换形态', next:'m2' }
        ]},
        { id:'m2', speaker:'narrator', text:'（在 HUD 点击 SRPG / ARPG / RTS 即可随时切换）', next:null }
      ]
    }
  ];
  CQ.getAvgScript = function (id) {
    for (var i = 0; i < CQ.AVG_SCRIPTS.length; i++) if (CQ.AVG_SCRIPTS[i].id === id) return CQ.AVG_SCRIPTS[i];
    return CQ.AVG_SCRIPTS[0];
  };
})();
