// TD.Levels — 5 关卡（路径 + 波次）
(function () {
  'use strict';
  var TD = window.TD;
  // 网格 16×10，tile 48，HUD 56，PLAY 412
  // 路径点为网格坐标 {c,r}，运行时转 world(px)
  function mkPath(pts) { return pts; }
  function wavesOf(list) { return list; } // {enemyId,count,interval,hpMul,speedMul}

  TD.LEVELS = [
    {
      id:1, name:'绿野小径', desc:'直线为主，熟悉建造与升级', bg:0x0e1628, bg2:0x1a2b4a,
      path: mkPath([{c:0,r:5},{c:5,r:5},{c:5,r:2},{c:11,r:2},{c:11,r:7},{c:16,r:7}]),
      blocked: ['5,5','5,2','11,2','11,7'], // 路径格不可建（示例，其余由 MapManager 自动标记）
      startGold: 280, lives: 20,
      waves: wavesOf([
        {enemyId:'grunt', count:10, interval:650, hpMul:1.0, speedMul:1.0},
        {enemyId:'grunt', count:12, interval:600, hpMul:1.1, speedMul:1.0},
        {enemyId:'swift', count:10, interval:550, hpMul:1.0, speedMul:1.05},
        {enemyId:'tank',  count:4,  interval:900, hpMul:1.0, speedMul:1.0},
        {enemyId:'grunt', count:14, interval:500, hpMul:1.2, speedMul:1.05},
        {enemyId:'swarm', count:18, interval:380, hpMul:1.0, speedMul:1.05},
        {enemyId:'healer',count:6,  interval:700, hpMul:1.2, speedMul:1.0},
        {enemyId:'boss',  count:1,  interval:1200,hpMul:1.0, speedMul:1.0}
      ])
    },
    {
      id:2, name:'寒霜回廊', desc:'S 形弯道，寒冰塔更强', bg:0x0d1b2a, bg2:0x1b2a41,
      path: mkPath([{c:16,r:1},{c:8,r:1},{c:8,r:8},{c:2,r:8},{c:2,r:4},{c:0,r:4}]),
      blocked: [],
      startGold: 300, lives: 22,
      waves: wavesOf([
        {enemyId:'grunt', count:12, interval:600, hpMul:1.1, speedMul:1.0},
        {enemyId:'flyer', count:8,  interval:600, hpMul:1.0, speedMul:1.05},
        {enemyId:'swift', count:12, interval:500, hpMul:1.05,speedMul:1.05},
        {enemyId:'tank',  count:5,  interval:850, hpMul:1.15,speedMul:1.0},
        {enemyId:'ghost', count:10, interval:500, hpMul:1.1, speedMul:1.05},
        {enemyId:'healer',count:8,  interval:650, hpMul:1.2, speedMul:1.0},
        {enemyId:'brute', count:3,  interval:900, hpMul:1.1, speedMul:1.0},
        {enemyId:'swarm', count:22, interval:360, hpMul:1.05,speedMul:1.1},
        {enemyId:'boss',  count:1,  interval:1200,hpMul:1.15,speedMul:1.0}
      ])
    },
    {
      id:3, name:'熔岩裂谷', desc:'长直线+爆破塔主场', bg:0x1a0e0e, bg2:0x3a1a1a,
      path: mkPath([{c:0,r:1},{c:4,r:1},{c:4,r:9},{c:12,r:9},{c:12,r:1},{c:16,r:1}]),
      blocked: [],
      startGold: 320, lives: 22,
      waves: wavesOf([
        {enemyId:'grunt', count:14, interval:550, hpMul:1.15,speedMul:1.0},
        {enemyId:'split', count:8,  interval:700, hpMul:1.1, speedMul:1.0},
        {enemyId:'swift', count:14, interval:480, hpMul:1.1, speedMul:1.08},
        {enemyId:'tank',  count:6,  interval:800, hpMul:1.2, speedMul:1.0},
        {enemyId:'ghost', count:12, interval:480, hpMul:1.15,speedMul:1.08},
        {enemyId:'brute', count:4,  interval:850, hpMul:1.15,speedMul:1.02},
        {enemyId:'flyer', count:10, interval:520, hpMul:1.1, speedMul:1.08},
        {enemyId:'swarm', count:24, interval:340, hpMul:1.1, speedMul:1.12},
        {enemyId:'split', count:6,  interval:650, hpMul:1.2, speedMul:1.05},
        {enemyId:'boss',  count:1,  interval:1200,hpMul:1.25,speedMul:1.0}
      ])
    },
    {
      id:4, name:'幽影密林', desc:'多弯道+幽灵/分裂混合', bg:0x0e1a14, bg2:0x1a2e22,
      path: mkPath([{c:0,r:8},{c:6,r:8},{c:6,r:2},{c:10,r:2},{c:10,r:8},{c:16,r:5}]),
      blocked: [],
      startGold: 340, lives: 24,
      waves: wavesOf([
        {enemyId:'ghost', count:10, interval:520, hpMul:1.15,speedMul:1.05},
        {enemyId:'grunt', count:16, interval:500, hpMul:1.2, speedMul:1.05},
        {enemyId:'split', count:10, interval:600, hpMul:1.15,speedMul:1.05},
        {enemyId:'flyer', count:12, interval:500, hpMul:1.15,speedMul:1.08},
        {enemyId:'tank',  count:7,  interval:750, hpMul:1.25,speedMul:1.0},
        {enemyId:'healer',count:10, interval:580, hpMul:1.25,speedMul:1.02},
        {enemyId:'swarm', count:26, interval:320, hpMul:1.15,speedMul:1.12},
        {enemyId:'brute', count:5,  interval:800, hpMul:1.2, speedMul:1.02},
        {enemyId:'ghost', count:14, interval:460, hpMul:1.2, speedMul:1.08},
        {enemyId:'boss',  count:2,  interval:1400,hpMul:1.2, speedMul:1.0}
      ])
    },
    {
      id:5, name:'王座之路', desc:'终局混合波，首领×2', bg:0x1a1a2e, bg2:0x2a1a3a,
      path: mkPath([{c:8,r:0},{c:8,r:4},{c:2,r:4},{c:2,r:7},{c:14,r:7},{c:14,r:4},{c:8,r:4},{c:8,r:10}]),
      blocked: [],
      startGold: 380, lives: 26,
      waves: wavesOf([
        {enemyId:'grunt', count:16, interval:480, hpMul:1.25,speedMul:1.08},
        {enemyId:'swift', count:16, interval:440, hpMul:1.15,speedMul:1.1},
        {enemyId:'flyer', count:12, interval:480, hpMul:1.2, speedMul:1.1},
        {enemyId:'split', count:12, interval:520, hpMul:1.2, speedMul:1.08},
        {enemyId:'tank',  count:8,  interval:700, hpMul:1.3, speedMul:1.02},
        {enemyId:'ghost', count:16, interval:420, hpMul:1.25,speedMul:1.1},
        {enemyId:'healer',count:12, interval:520, hpMul:1.3, speedMul:1.05},
        {enemyId:'brute', count:6,  interval:760, hpMul:1.25,speedMul:1.05},
        {enemyId:'swarm', count:30, interval:300, hpMul:1.2, speedMul:1.14},
        {enemyId:'tank',  count:6,  interval:650, hpMul:1.35,speedMul:1.02},
        {enemyId:'ghost', count:12, interval:400, hpMul:1.3, speedMul:1.1},
        {enemyId:'boss',  count:2,  interval:1600,hpMul:1.35,speedMul:1.0}
      ])
    }
  ];
})();
