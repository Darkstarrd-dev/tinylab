// RS.Config — 顶部可调
(function () {
  'use strict';
  var RS = window.RS;
  RS.CFG = {
    WORLD_W: 1600, WORLD_H: 1100,
    VIEW_W: 960, VIEW_H: 540,
    HUD_H: 42, PANEL_H: 78,
    TILE: 36,
    FOG_TILE: 36,
    SIGHT_RANGE: 5, // 格
    UNIT_RADIUS: 12,
    UNIT_SPEED_BASE: 78, // px/s
    POP_CAP: 28,
    START_GOLD: 420, START_WOOD: 260,
    GATHER_RATE: 8, // 每 tick
    GATHER_TICK_MS: 700,
    ATTACK_TICK_MS: 520,
    FOG_ALPHA_UNSEEN: 0.92, FOG_ALPHA_SEEN: 0.42
  };
  RS.COLORS = {
    BG: 0x0e1628, BG2: 0x162040,
    TERRAIN: { '.':0x2a3a56, 'F':0x1b4d2e, 'M':0x5d4037, 'W':0x1e3a5f, 'G':0x2a4a2e },
    TEXT:'#e6edf3', MUTED:'#8b949e',
    PLAYER:0x3498db, ENEMY:0xe74c3c, RESOURCE_GOLD:0xf1c40f, RESOURCE_WOOD:0x2ecc71,
    FOG_UNSEEN:0x0a0f1e, FOG_SEEN:0x1a2332,
    SELECT:0x2ecc71, SELECT_FILL:0x2ecc71
  };
  RS.TERRAIN_DEF = {
    '.':{ name:'平原', passable:true, cost:1 },
    'F':{ name:'森林', passable:true, cost:1.2 },
    'M':{ name:'山地', passable:false, cost:99 },
    'W':{ name:'水面', passable:false, cost:99 },
    'G':{ name:'草地', passable:true, cost:1 }
  };
})();
