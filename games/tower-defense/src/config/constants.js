// TD.Config 常量 — 顶部可调参数（单位中文注释）
(function () {
  'use strict';
  var TD = window.TD;
  // --------------------------------------------------------------------------
  // 画面与网格
  // --------------------------------------------------------------------------
  TD.CFG = {
    W: 960,               // 逻辑宽度 px（host.width 优先）
    H: 540,               // 逻辑高度 px（host.height 优先）
    GRID_COLS: 16,        // 网格列数
    GRID_ROWS: 10,        // 网格行数
    TILE: 48,             // 格子像素 px（W/COLS 归一）
    HUD_H: 56,            // 顶部 HUD 高度 px
    SHOP_H: 72,           // 底部商店高度 px
    PLAY_H: 412,          // 战场高度 = H - HUD_H - SHOP_H
    START_GOLD: 260,      // 初始金币
    START_LIVES: 20,      // 初始生命
    WAVE_INTERVAL: 18000, // 波次间隔 ms（自动）
    PREP_TIME: 3500,      // 首波准备时间 ms
    BULLET_POOL: 140,     // 子弹池上限
    ENEMY_POOL: 70,       // 敌人池上限
    SELL_REFUND: 0.7,     // 出售返还比例
    MAX_TOWERS: 48        // 场上塔上限
  };
  // 颜色
  TD.COLORS = {
    BG: 0x0e1628,
    BG2: 0x162040,
    GRID: 0x1e2a44,
    PATH: 0x2a3a56,
    PATH_EDGE: 0x3a4d6a,
    TEXT: '#e6edf3',
    MUTED: '#8b949e',
    GOLD: '#f1c40f',
    HEART: '#e74c3c',
    BTN: 0x2a3a56,
    BTN_HOVER: 0x34495e,
    SELECT: 0x3498db,
    RANGE: 0x3498db
  };
  TD.VERSION = '0.1.0';
})();
