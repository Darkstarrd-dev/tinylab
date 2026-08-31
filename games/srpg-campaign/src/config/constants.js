// SC.Config — 顶部可调常量
(function () {
  'use strict';
  var SC = window.SC;
  SC.CFG = {
    TILE: 42,           // 格子 px
    COLS: 14,           // 地图列
    ROWS: 10,           // 地图行
    HUD_H: 44,          // 顶栏
    LOG_H: 22,
    MAX_LEVEL: 20,
    EXP_PER_LEVEL: 100, // 基础经验阈值（配合 growth 曲线）
    CRIT_RATE_BASE: 6,  // 基础暴击%
    HIT_BASE: 82,       // 基础命中
    MOVE_TWEEN_MS: 120  // 每格移动 ms
  };
  SC.COLORS = {
    BG: 0x0e1628, BG2: 0x162040,
    GRID: 0x1e2a44,
    TERRAIN: { '.': 0x2a3a56, 'F': 0x1b4d2e, 'M': 0x5d4037, 'W': 0x1e3a5f, 'H': 0x3a3a5a, 'R': 0x4a3a2a },
    TEXT: '#e6edf3', MUTED: '#8b949e',
    MOVE: 0x2ecc71, ATTACK: 0xe74c3c, SELECT: 0x3498db,
    PLAYER: 0x3498db, ENEMY: 0xe74c3c, NPC: 0xf1c40f
  };
  // 地形消耗与防御/回避（moveCost 99=不可通过）
  SC.TERRAIN_DEF = {
    '.': { name:'平原', moveCost:1, def:0, avoid:0 },
    'F': { name:'森林', moveCost:2, def:1, avoid:12 },
    'M': { name:'山地', moveCost:3, def:2, avoid:18 },
    'W': { name:'水面', moveCost:99,def:0, avoid:0 },
    'H': { name:'房屋', moveCost:1, def:2, avoid:10 },
    'R': { name:'道路', moveCost:1, def:0, avoid:0 }
  };
  SC.VERSION = '0.1.0';
})();
