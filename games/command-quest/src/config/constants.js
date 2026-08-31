// CQ.CFG — 顶部可调常量（单位中文注释）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.CFG = {
    W: 960,              // 逻辑宽度 px
    H: 540,              // 逻辑高度 px
    GRID_COLS: 16,        // 地图列数
    GRID_ROWS: 10,        // 地图行数
    TILE: 48,             // 格子像素（W/COLS 归一，WorldScene 内按实际 W 重算）
    HUD_H: 44,            // 顶部 HUD 高 px
    BOTTOM_H: 0,          // 预留（HUD 用同层按钮行）
    SEED: 1337,           // 地图随机种子
    START_GOLD: 420,      // 初始金币
    START_WAVE: 1,        // 初始波次（敌人多批次）
    WAVE_INTERVAL_MS: 28000, // 敌人批次间隔 ms
    MAX_WAVES: 5,         // 单局最大波次
    SHOP_ITEMS: 4,        // 商店陈列数
    CHEST_MIN: 4,         // 宝箱最少
    CHEST_MAX: 6,
    NPC_MIN: 2,           // 事件 NPC 最少
    NPC_MAX: 4,
    SHOP_COUNT: 2,        // 商店数
    MAX_LEVEL: 10,        // 指挥官/士兵最高等级
    EXP_TABLE: [0, 20, 50, 90, 145, 220, 320, 450, 620, 850], // 升到 lv 的累计 exp（lv1=0）
    RECRUIT_COST: 120,    // 招募士兵消耗
    HEAL_COST: 20,        // 商店治疗单价
    MOVE_RANGE_BASE: 4,   // SRPG 每回合移动格数
    ATK_RANGE_BASE: 1,    // 基础攻击距离（格）
    SKILL_RANGE: 3,       // 技能射程格
    BATCH_ENEMIES: 3      // 每批次新增敌人个数
  };
  CQ.COLORS = {
    BG: 0x0e1424, BG2: 0x162040, GRID: 0x1a2540, WALL: 0x243656,
    TEXT: '#e6edf3', MUTED: '#93a1b8', GOLD: '#f1c40f', HEART: '#e74c3c',
    CHEST: 0xe67e22, SHOP: 0x3498db, NPC: 0x2ecc71, ENEMY: 0xe74c3c,
    SELECT: 0x3498db, RANGE: 0x3498db, WALKABLE: 0x1f3a5f, ENEMY_TINT: 0xff6666
  };
  CQ.MODES = ['srpg', 'arpg', 'rts']; // 三模态
  CQ.VERSION = '0.1.0';
})();
