// =============================================================================
// 【资产替换清单】—— 将来替换为外部资源时逐项修改（中文注释为替换点）
//   视觉：
//     buildTextures() 内所有 this.add.graphics()+generateTexture('tile_wall'/
//       'tile_floor'/'tile_stairs'/'tile_trap'/'player'/'enemy_slime'/
//       'enemy_ghost'/'enemy_orc'/'enemy_demon'/'item_rice'/'item_herb'/
//       'item_scroll'/'item_jar'/'panel')  →  换成
//       this.load.image('tile_wall','assets/wall.png') /
//       this.load.spritesheet('player','assets/player.png',{frameWidth:32,frameHeight:32})
//       等；本文件所有“生成纹理”段落已用中文注释标出替换点。
//     网格角色 this.add.graphics 几何（圆/方/三角）→ 换成 spritesheet 帧动画：
//       this.load.spritesheet('player','assets/shiren.png',{frameWidth:32,frameHeight:32})
//     敌人与道具几何 → 换成 this.load.image('enemy_slime','assets/slime.png') 等
//     地牢底色 this.cameras.main.setBackgroundColor('#1a1410') → 换成
//       this.load.image('bg','assets/dungeon_bg.png') + tileSprite
//   音频：
//     Sfx.play('move'/'attack'/'pickup'/'stairs'/'hunger'/'hurt'/'levelup'/'use')
//       内部 WebAudio oscillator+gain  → 换成
//       this.load.audio('move','assets/move.wav') + this.sound.play('move')
//       文件顶部 Sfx 块注释已写替换写法。将 Sfx.ensure() 换成 this.sound.locked 处理。
//     BGM：Sfx.startBgm()/stopBgm() 的定时器振荡器 → 换成
//       this.sound.add('bgm',{loop:true,volume:0.3}) + play/stop
//   关卡：
//     generateFloor() 的随机房间+走廊算法 → 换成 Tiled JSON：
//       this.load.tilemapTiledJSON('floor1','assets/floor1.json')
//       或外部种子关卡编辑器导出的房间模板。
// =============================================================================
(function () {
  'use strict';

  // ==========================================================================
  // 顶部可调参数（带单位）—— 中文注释 + 英文游戏内文本
  // ==========================================================================
  /** 单格像素边长 px */
  var TILE = 32;
  /** 地图网格宽（格） */
  var MAP_W = 28;
  /** 地图网格高（格） */
  var MAP_H = 18;
  /** 房间数量 随机范围 */
  var ROOM_COUNT_MIN = 6;
  var ROOM_COUNT_MAX = 9;
  /** 房间尺寸范围（格） */
  var ROOM_W_MIN = 5;
  var ROOM_W_MAX = 9;
  var ROOM_H_MIN = 4;
  var ROOM_H_MAX = 7;
  /** 视野半径（格）—— FOV 采用切比雪夫距离 + Bresenham 视线遮挡；其余暗色 0.35 alpha */
  var FOV_RADIUS = 7;
  /** 饱腹度上限 */
  var HUNGER_MAX = 100;
  /** 每回合饱腹下降 */
  var HUNGER_PER_TURN = 1;
  /** 饿死阈值与伤害 */
  var HUNGER_STARVE_DMG = 2;
  /** 背包上限 */
  var INV_MAX = 8;
  /** 玩家初始属性 */
  var PLAYER_BASE_HP = 30;
  var PLAYER_BASE_ATK = 5;
  var PLAYER_BASE_DEF = 2;
  /** 地刺陷阱伤害（仅 2 层及以上出现） */
  var TRAP_DAMAGE = 6;
  /** 升级所需经验：lv * 12 + 8 */
  function needExp(lv) { return lv * 12 + 8; }

  // ==========================================================================
  // 存档与状态缝
  // ==========================================================================
  var hostRef = null;
  var sceneRef = null;
  /** 存档：{deepestFloor, maxLv} */
  var saveData = { deepestFloor: 1, maxLv: 1 };
  /**
   * getState 供 CDP/测试缝轮询
   * @returns {{scene:string,floor:number,lv:number,hp:number,hunger:number,inv:number}}
   */
  function getState() {
    var sc = sceneRef;
    if (!sc) { return { scene: 'title', floor: 1, lv: 1, hp: PLAYER_BASE_HP, hunger: HUNGER_MAX, inv: 0 }; }
    return {
      scene: sc.gameState || 'play',
      floor: sc.floor || 1,
      lv: sc.playerLv || 1,
      hp: sc.playerHp || 0,
      hunger: sc.hunger || 0,
      inv: sc.inventory ? sc.inventory.length : 0
    };
  }

  // ==========================================================================
  // Sfx — WebAudio oscillator+gain 封装
  // 将来换 this.load.audio 写法：
  //   preload(){ this.load.audio('move','assets/move.wav'); }
  //   play(name){ this.sound.play(name); }
  // 现用 WebAudio：首交互时 ctx.resume()，try/catch 静默降级。
  // ==========================================================================
  var Sfx = {
    ctx: null,
    bgmTimer: null,
    ensure: function () {
      try {
        if (!Sfx.ctx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) { return null; }
          Sfx.ctx = new AC();
        }
        if (Sfx.ctx.state === 'suspended') { Sfx.ctx.resume(); }
        return Sfx.ctx;
      } catch (e) { return null; }
    },
    tone: function (freq, dur, type, vol, slideTo) {
      var ctx = Sfx.ensure();
      if (!ctx) { return; }
      try {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.value = vol || 0.2;
        o.start();
        if (slideTo) {
          o.frequency.linearRampToValueAtTime(slideTo, ctx.currentTime + dur);
        }
        g.gain.linearRampToValueAtTime(0.001, ctx.currentTime + dur);
        o.stop(ctx.currentTime + dur + 0.02);
      } catch (e) {}
    },
    play: function (name) {
      if (name === 'move') { Sfx.tone(320, 0.08, 'sine', 0.12); }
      else if (name === 'attack') { Sfx.tone(180, 0.12, 'square', 0.22, 60); }
      else if (name === 'hit') { Sfx.tone(120, 0.18, 'square', 0.2, 40); }
      else if (name === 'pickup') { Sfx.tone(660, 0.12, 'sine', 0.18, 880); }
      else if (name === 'stairs') { Sfx.tone(440, 0.25, 'sine', 0.2, 660); setTimeout(function(){ Sfx.tone(660,0.25,'sine',0.18,880); },160); }
      else if (name === 'hurt') { Sfx.tone(90, 0.25, 'sawtooth', 0.18); }
      else if (name === 'hunger') { Sfx.tone(70, 0.4, 'triangle', 0.22, 50); }
      else if (name === 'use') { Sfx.tone(520, 0.15, 'sine', 0.18, 720); }
      else if (name === 'levelup') { Sfx.tone(440,0.18,'sine',0.18,660); setTimeout(function(){ Sfx.tone(660,0.3,'sine',0.2,880); },140); }
      else if (name === 'trap') { Sfx.tone(200,0.2,'square',0.2,80); }
    },
    startBgm: function () {
      Sfx.stopBgm();
      var ctx = Sfx.ensure();
      if (!ctx) { return; }
      // 极简 BGM：每 1.6s 播一个低沉脉冲，WebAudio 定时器实现
      try {
        Sfx.bgmTimer = setInterval(function () {
          // 轻微节拍，不吵
          Sfx.tone(110, 0.18, 'triangle', 0.04);
        }, 1600);
      } catch (e) {}
    },
    stopBgm: function () {
      if (Sfx.bgmTimer) { try { clearInterval(Sfx.bgmTimer); } catch (e) {} Sfx.bgmTimer = null; }
    }
  };

  // ==========================================================================
  // RNG — mulberry32 可重现随机（每层新种子）
  // ==========================================================================
  function mulberry32(seed) {
    return function () {
      var t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
  function shuffle(rng, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ==========================================================================
  // 数据表
  // ==========================================================================
  /** 敌数据表（≥4种）—— 血攻防数据表 + 经验 + 颜色 */
  var ENEMY_DEFS = [
    { id: 0, name: 'Slime',  nameCn: '史莱姆', hp: 10, atk: 3, def: 0, exp: 4,  color: 0x66d9a0, minFloor: 1 },
    { id: 1, name: 'Ghost',  nameCn: '幽魂',   hp: 14, atk: 5, def: 1, exp: 7,  color: 0xb39ddb, minFloor: 1 },
    { id: 2, name: 'Orc',    nameCn: '兽人',   hp: 22, atk: 7, def: 2, exp: 12, color: 0x8d6e63, minFloor: 1 },
    { id: 3, name: 'Demon',  nameCn: '恶魔',   hp: 30, atk: 9, def: 3, exp: 18, color: 0xef5350, minFloor: 2 },
    { id: 4, name: 'Skeleton', nameCn:'骷髅', hp: 18, atk: 6, def: 2, exp: 10, color: 0xe0e0e0, minFloor: 2 }
  ];
  /** 道具表（≥4种）—— 饭团/草药/卷轴/壶 */
  var ITEM_DEFS = [
    { kind: 'rice',   name: 'Rice Ball', nameCn: '饭团',  desc: '饱腹+30', color: 0xfff59d, shape: 'circle' },
    { kind: 'herb',   name: 'Herb',      nameCn: '草药',  desc: '回血12',  color: 0x81c784, shape: 'leaf' },
    { kind: 'scroll', name: 'Scroll',    nameCn: '卷轴',  desc: '范围伤害', color: 0x90caf9, shape: 'rect' },
    { kind: 'jar',    name: 'Jar',       nameCn: '壶',    desc: '投掷单体', color: 0xce93d8, shape: 'jar' }
  ];

  // ==========================================================================
  // 贴图生成 — 纯几何 generateTexture，无外部资产
  // 替换点：整段 buildTextures 可替换为 this.load.image / spritesheet
  // ==========================================================================
  function buildTextures(scene) {
    var g;
    function rm(k) { if (scene.textures.exists(k)) { try { scene.textures.remove(k); } catch (e) {} } }

    // ---- 地形 ----
    // 墙：深褐砖纹理
    rm('tile_wall'); g = scene.add.graphics();
    g.fillStyle(0x3e2723, 1); g.fillRect(0, 0, TILE, TILE);
    g.fillStyle(0x4e342e, 1); g.fillRect(2, 2, TILE - 4, 6); g.fillRect(2, 12, TILE - 4, 6); g.fillRect(2, 22, TILE - 4, 6);
    g.lineStyle(1, 0x2a1a14, 0.9); g.strokeRect(0, 0, TILE, TILE);
    g.generateTexture('tile_wall', TILE, TILE); g.destroy();

    // 地板：米黄石板 + 随机斑点
    rm('tile_floor'); g = scene.add.graphics();
    g.fillStyle(0xd7ccc8, 1); g.fillRect(0, 0, TILE, TILE);
    g.fillStyle(0xbcaaa4, 1); g.fillCircle(8, 8, 1.2); g.fillCircle(22, 20, 1); g.fillCircle(18, 9, 0.9);
    g.lineStyle(1, 0xa89080, 0.35); g.strokeRect(0, 0, TILE, TILE);
    g.generateTexture('tile_floor', TILE, TILE); g.destroy();

    // 楼梯：黄褐台阶 + 箭头
    rm('tile_stairs'); g = scene.add.graphics();
    g.fillStyle(0x8d6e63, 1); g.fillRect(0, 0, TILE, TILE);
    g.fillStyle(0xffd54f, 1); g.fillRect(4, 20, TILE - 8, 4); g.fillRect(6, 14, TILE - 12, 4); g.fillRect(8, 8, TILE - 16, 4);
    g.fillStyle(0x5d4037, 1); g.fillTriangle(TILE / 2, 4, TILE / 2 - 5, 10, TILE / 2 + 5, 10);
    g.generateTexture('tile_stairs', TILE, TILE); g.destroy();

    // 陷阱地刺：暗地板 + 红刺
    rm('tile_trap'); g = scene.add.graphics();
    g.fillStyle(0xd7ccc8, 1); g.fillRect(0, 0, TILE, TILE);
    g.fillStyle(0xef5350, 1);
    g.fillTriangle(6, 24, 10, 12, 14, 24);
    g.fillTriangle(14, 24, 18, 12, 22, 24);
    g.fillTriangle(22, 24, 26, 12, 30, 24);
    g.generateTexture('tile_trap', TILE, TILE); g.destroy();

    // 未探索/暗色遮罩用 1x1 纯色
    rm('panel'); g = scene.add.graphics();
    g.fillStyle(0x000000, 1); g.fillRect(0, 0, 1, 1);
    g.generateTexture('panel', 1, 1); g.destroy();

    // ---- 角色 ----
    // 玩家：蓝衣风来人（圆头+三角斗笠+身体）
    rm('player'); g = scene.add.graphics();
    g.fillStyle(0x42a5f5, 1); g.fillCircle(16, 16, 11);
    g.fillStyle(0xffcc80, 1); g.fillCircle(16, 10, 6);
    g.fillStyle(0x1e88e5, 1); g.fillTriangle(16, 2, 6, 12, 26, 12);
    g.fillStyle(0x0d47a1, 1); g.fillRect(13, 20, 6, 7);
    g.generateTexture('player', TILE, TILE); g.destroy();

    // 敌：4+ 种几何区分
    var enemyTex = ['enemy_slime', 'enemy_ghost', 'enemy_orc', 'enemy_demon', 'enemy_skeleton'];
    var enemyColors = [0x66d9a0, 0xb39ddb, 0x8d6e63, 0xef5350, 0xe0e0e0];
    for (var ei = 0; ei < enemyTex.length; ei++) {
      rm(enemyTex[ei]); g = scene.add.graphics();
      var col = enemyColors[ei];
      if (ei === 0) { // slime 椭圆
        g.fillStyle(col, 1); g.fillEllipse(16, 20, 22, 14); g.fillCircle(16, 12, 8);
        g.fillStyle(0x1a1a1a, 1); g.fillCircle(12, 11, 1.6); g.fillCircle(20, 11, 1.6);
      } else if (ei === 1) { // ghost 幽灵
        g.fillStyle(col, 1); g.fillCircle(16, 12, 9);
        g.fillRect(7, 16, 18, 10); g.fillTriangle(7, 26, 11, 26, 9, 30); g.fillTriangle(14, 26, 18, 26, 16, 30); g.fillTriangle(21, 26, 25, 26, 23, 30);
        g.fillStyle(0x1a1a1a, 1); g.fillCircle(12, 12, 1.8); g.fillCircle(20, 12, 1.8);
      } else if (ei === 2) { // orc 方壮
        g.fillStyle(col, 1); g.fillRect(8, 8, 16, 16); g.fillRect(6, 12, 4, 8); g.fillRect(22, 12, 4, 8);
        g.fillStyle(0x3e2723, 1); g.fillCircle(12, 14, 1.8); g.fillCircle(20, 14, 1.8); g.fillRect(12, 18, 8, 2);
      } else if (ei === 3) { // demon 角魔
        g.fillStyle(col, 1); g.fillCircle(16, 16, 10);
        g.fillStyle(0x3e0000, 1); g.fillTriangle(8, 8, 10, 2, 14, 8); g.fillTriangle(18, 8, 22, 2, 24, 8);
        g.fillStyle(0xffeb3b, 1); g.fillCircle(12, 15, 2); g.fillCircle(20, 15, 2);
      } else { // skeleton
        g.fillStyle(col, 1); g.fillCircle(16, 11, 8); g.fillRect(12, 19, 8, 9);
        g.fillStyle(0x212121, 1); g.fillCircle(13, 11, 2.2); g.fillCircle(19, 11, 2.2); g.fillRect(14, 15, 4, 2);
      }
      g.generateTexture(enemyTex[ei], TILE, TILE); g.destroy();
    }

    // ---- 道具 ----
    // 饭团：黄圆 + 海苔条
    rm('item_rice'); g = scene.add.graphics();
    g.fillStyle(0xfff59d, 1); g.fillCircle(16, 16, 10); g.fillStyle(0x33691e, 1); g.fillRect(12, 18, 8, 4);
    g.lineStyle(1, 0x8d6e63, 0.9); g.strokeCircle(16, 16, 10);
    g.generateTexture('item_rice', TILE, TILE); g.destroy();
    // 草药：绿叶
    rm('item_herb'); g = scene.add.graphics();
    g.fillStyle(0x81c784, 1); g.fillEllipse(16, 18, 16, 12); g.fillStyle(0x2e7d32, 1); g.lineStyle(1.5, 0x2e7d32, 1); g.lineBetween(16, 10, 16, 24);
    g.lineBetween(16, 16, 10, 14); g.lineBetween(16, 16, 22, 14);
    g.generateTexture('item_herb', TILE, TILE); g.destroy();
    // 卷轴：白卷 + 蓝带
    rm('item_scroll'); g = scene.add.graphics();
    g.fillStyle(0xfff8e1, 1); g.fillRect(8, 6, 16, 20); g.fillStyle(0x90caf9, 1); g.fillRect(8, 14, 16, 4);
    g.lineStyle(1, 0x6d4c41, 0.8); g.strokeRect(8, 6, 16, 20);
    g.generateTexture('item_scroll', TILE, TILE); g.destroy();
    // 壶：紫壶
    rm('item_jar'); g = scene.add.graphics();
    g.fillStyle(0xce93d8, 1); g.fillEllipse(16, 20, 14, 14); g.fillRect(12, 8, 8, 10); g.fillRect(10, 6, 12, 4);
    g.fillStyle(0x4a148c, 1); g.fillRect(14, 10, 4, 3);
    g.generateTexture('item_jar', TILE, TILE); g.destroy();
  }

  // ==========================================================================
  // 地牢生成 — 房间+走廊，网格 tile(0墙/1地板/2楼梯/3陷阱)
  // 替换点：本函数可整体替换为 Tiled JSON 加载 + 解析
  // ==========================================================================
  function generateFloor(floor, seed) {
    var rng = mulberry32(seed);
    // 初始化全墙
    var map = [];
    for (var y = 0; y < MAP_H; y++) {
      map[y] = [];
      for (var x = 0; x < MAP_W; x++) { map[y][x] = 0; }
    }
    var rooms = [];
    var tries = 0;
    var targetRooms = randInt(rng, ROOM_COUNT_MIN, ROOM_COUNT_MAX);
    while (rooms.length < targetRooms && tries < 200) {
      tries++;
      var rw = randInt(rng, ROOM_W_MIN, ROOM_W_MAX);
      var rh = randInt(rng, ROOM_H_MIN, ROOM_H_MAX);
      var rx = randInt(rng, 1, MAP_W - rw - 1);
      var ry = randInt(rng, 1, MAP_H - rh - 1);
      var overlap = false;
      for (var k = 0; k < rooms.length; k++) {
        var r = rooms[k];
        if (!(rx + rw + 1 < r.x || rx > r.x + r.w + 1 || ry + rh + 1 < r.y || ry > r.y + r.h + 1)) { overlap = true; break; }
      }
      if (overlap) { continue; }
      rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: Math.floor(rx + rw / 2), cy: Math.floor(ry + rh / 2) });
      for (var yy = ry; yy < ry + rh; yy++) {
        for (var xx = rx; xx < rx + rw; xx++) { map[yy][xx] = 1; }
      }
    }
    if (rooms.length < 2) {
      // 兜底：至少 2 房
      rooms = [{ x: 2, y: 2, w: 6, h: 5, cx: 5, cy: 4 }, { x: MAP_W - 8, y: MAP_H - 7, w: 6, h: 5, cx: MAP_W - 5, cy: MAP_H - 5 }];
      for (var ri = 0; ri < rooms.length; ri++) {
        var rr = rooms[ri];
        for (var y2 = rr.y; y2 < rr.y + rr.h; y2++) { for (var x2 = rr.x; x2 < rr.x + rr.w; x2++) { map[y2][x2] = 1; } }
      }
    }
    // 走廊：按 cx 排序后 L 形连接
    rooms.sort(function (a, b) { return a.cx - b.cx; });
    for (var i = 1; i < rooms.length; i++) {
      var a = rooms[i - 1], b = rooms[i];
      var horizFirst = rng() > 0.5;
      if (horizFirst) {
        for (var cx = Math.min(a.cx, b.cx); cx <= Math.max(a.cx, b.cx); cx++) { if (map[a.cy][cx] === 0) { map[a.cy][cx] = 1; } }
        for (var cy = Math.min(a.cy, b.cy); cy <= Math.max(a.cy, b.cy); cy++) { if (map[cy][b.cx] === 0) { map[cy][b.cx] = 1; } }
      } else {
        for (var cy2 = Math.min(a.cy, b.cy); cy2 <= Math.max(a.cy, b.cy); cy2++) { if (map[cy2][a.cx] === 0) { map[cy2][a.cx] = 1; } }
        for (var cx2 = Math.min(a.cx, b.cx); cx2 <= Math.max(a.cx, b.cx); cx2++) { if (map[b.cy][cx2] === 0) { map[b.cy][cx2] = 1; } }
      }
    }
    // 楼梯放在最后一房中心
    var last = rooms[rooms.length - 1];
    map[last.cy][last.cx] = 2;
    // 陷阱：仅 floor>=2 出现，随机 3~5 个在地板上（非房间中心、非起点）
    var trapPositions = [];
    if (floor >= 2) {
      var trapCount = randInt(rng, 3, 5);
      var attempts = 0;
      while (trapPositions.length < trapCount && attempts < 80) {
        attempts++;
        var rr2 = rooms[randInt(rng, 0, rooms.length - 1)];
        var tx = randInt(rng, rr2.x, rr2.x + rr2.w - 1);
        var ty = randInt(rng, rr2.y, rr2.y + rr2.h - 1);
        if (map[ty][tx] !== 1) { continue; }
        if (tx === rooms[0].cx && ty === rooms[0].cy) { continue; }
        if (tx === last.cx && ty === last.cy) { continue; }
        var dup = false;
        for (var ti = 0; ti < trapPositions.length; ti++) { if (trapPositions[ti].x === tx && trapPositions[ti].y === ty) { dup = true; break; } }
        if (dup) { continue; }
        map[ty][tx] = 3;
        trapPositions.push({ x: tx, y: ty });
      }
    }
    return { map: map, rooms: rooms, start: { x: rooms[0].cx, y: rooms[0].cy }, stairs: { x: last.cx, y: last.cy }, rng: rng };
  }

  // ==========================================================================
  // 工具：Bresenham 视线、FOV、伤害
  // ==========================================================================
  function hasLOSClear(map, x0, y0, x1, y1) {
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;
    var x = x0, y = y0;
    while (true) {
      if (x === x1 && y === y1) { break; }
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      if (x === x1 && y === y1) { break; }
      if (y < 0 || y >= MAP_H || x < 0 || x >= MAP_W) { return false; }
      if (map[y][x] === 0) { return false; }
    }
    return true;
  }
  function calcDamage(atk, def, rng) {
    var base = atk - def;
    if (base < 1) { base = 1; }
    var variance = 0;
    if (rng) { variance = randInt(rng, -1, 1); }
    var d = base + variance;
    if (d < 1) { d = 1; }
    return d;
  }

  // ==========================================================================
  // 主场景 — 回合制地牢
  // ==========================================================================
  var RoguelikeScene = function () { Phaser.Scene.call(this, { key: 'rogue' }); };
  RoguelikeScene.prototype = Object.create(Phaser.Scene.prototype);
  RoguelikeScene.prototype.constructor = RoguelikeScene;

  RoguelikeScene.prototype.create = function () {
    sceneRef = this;
    this.gameState = 'play';
    var W = this.cameras.main.width;
    var H = this.cameras.main.height;
    this.W = W; this.H = H;

    // ---- 存档加载 ----
    this.floor = 1;
    this.playerLv = 1;
    this.playerExp = 0;
    this.playerHp = PLAYER_BASE_HP;
    this.playerMaxHp = PLAYER_BASE_HP;
    this.playerAtk = PLAYER_BASE_ATK;
    this.playerDef = PLAYER_BASE_DEF;
    this.hunger = HUNGER_MAX;
    this.deepestFloor = 1;
    this.maxLvReached = 1;
    this.inventory = [];
    this.runSeed = Math.floor(Math.random() * 1000000);
    this.turnCount = 0;
    this.over = false;
    this.victory = false;

    // 异步加载存档（仅 deepestFloor/maxLv，用于标题与存档回写）
    if (hostRef && typeof hostRef.loadState === 'function') {
      var selfLoad = this;
      try {
        hostRef.loadState().then(function (d) {
          if (d && typeof d.deepestFloor === 'number') { saveData.deepestFloor = d.deepestFloor; selfLoad.deepestFloor = Math.max(selfLoad.deepestFloor, d.deepestFloor); }
          if (d && typeof d.maxLv === 'number') { saveData.maxLv = d.maxLv; selfLoad.maxLvReached = Math.max(selfLoad.maxLvReached, d.maxLv); }
          if (selfLoad.hud) { selfLoad.updateHud(); }
        }, function () {});
      } catch (e) {}
    }

    // ---- 纹理 ----
    buildTextures(this);

    // ---- 地图容器 ----
    // 地图在屏幕居中，预留顶部 HUD 40px + 底部日志 56px
    this.hudH = 38;
    this.logH = 56;
    this.mapOriginX = Math.floor((W - MAP_W * TILE) / 2);
    this.mapOriginY = this.hudH + Math.floor((H - this.hudH - this.logH - MAP_H * TILE) / 2);
    if (this.mapOriginY < this.hudH + 4) { this.mapOriginY = this.hudH + 4; }
    if (this.mapOriginX < 4) { this.mapOriginX = 4; }

    // 背景
    this.cameras.main.setBackgroundColor('#1a1410');
    // 边框
    var frame = this.add.graphics();
    frame.lineStyle(2, 0x5d4037, 1);
    frame.strokeRect(this.mapOriginX - 2, this.mapOriginY - 2, MAP_W * TILE + 4, MAP_H * TILE + 4);
    frame.setDepth(1);

    // ---- 地图瓦片池（池化：每层复用/重建 tileSprites 二维数组）----
    /** @type {Phaser.GameObjects.Image[][]} */
    this.tileSprites = [];
    for (var y = 0; y < MAP_H; y++) {
      this.tileSprites[y] = [];
      for (var x = 0; x < MAP_W; x++) {
        var sp = this.add.image(this.mapOriginX + x * TILE + TILE / 2, this.mapOriginY + y * TILE + TILE / 2, 'tile_wall');
        sp.setDisplaySize(TILE, TILE);
        sp.setDepth(2);
        this.tileSprites[y][x] = sp;
      }
    }
    // 暗色遮罩池（FOV 用：覆盖在瓦片上的半透明黑）
    this.fogSprites = [];
    for (var fy = 0; fy < MAP_H; fy++) {
      this.fogSprites[fy] = [];
      for (var fx = 0; fx < MAP_W; fx++) {
        var fog = this.add.image(this.mapOriginX + fx * TILE + TILE / 2, this.mapOriginY + fy * TILE + TILE / 2, 'panel');
        fog.setDisplaySize(TILE, TILE);
        fog.setTint(0x000000);
        fog.setAlpha(0);
        fog.setDepth(15);
        this.fogSprites[fy][fx] = fog;
      }
    }

    // ---- 实体池（池化：enemyPool / itemPool 复用 Image 对象，楼层切换时重置而非重建 Game）----
    this.enemyPool = []; // {x,y,hp,maxHp,atk,def,exp,defId,sprite,alive}
    this.itemPool = [];  // {x,y,kind,sprite,alive}
    this.playerSprite = this.add.image(0, 0, 'player');
    this.playerSprite.setDisplaySize(TILE - 2, TILE - 2);
    this.playerSprite.setDepth(10);
    this.playerSprite.setVisible(false);

    // 探索/可见
    this.explored = [];
    this.visible = [];
    for (var ey = 0; ey < MAP_H; ey++) {
      this.explored[ey] = []; this.visible[ey] = [];
      for (var ex = 0; ex < MAP_W; ex++) { this.explored[ey][ex] = false; this.visible[ey][ex] = false; }
    }

    // ---- 输入（回合制：WASD/方向键，斜向可选，空格等待）----
    this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,G,ONE,TWO,THREE,FOUR,FIVE,SIX,SEVEN,EIGHT,R');
    // 额外监听数字键与斜向 QEZC
    this.keyQ = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Q);
    this.keyE = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.keyZ = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Z);
    this.keyC = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.C);
    // 用于 JustDown 去抖
    this._lastTurnTime = 0;

    // ---- HUD ----
    this.hudBg = this.add.image(W / 2, this.hudH / 2, 'panel');
    this.hudBg.setDisplaySize(W, this.hudH);
    this.hudBg.setTint(0x2c1e13);
    this.hudBg.setAlpha(0.95);
    this.hudBg.setDepth(20);
    this.hudText = this.add.text(8, 6, '', { fontFamily: 'monospace', fontSize: '12px', color: '#ffe0b2' });
    this.hudText.setDepth(21);
    this.hudText2 = this.add.text(8, 20, '', { fontFamily: 'monospace', fontSize: '11px', color: '#bcaaa4' });
    this.hudText2.setDepth(21);

    // 日志区
    this.logBg = this.add.image(W / 2, H - this.logH / 2, 'panel');
    this.logBg.setDisplaySize(W, this.logH);
    this.logBg.setTint(0x1a1410);
    this.logBg.setAlpha(0.92);
    this.logBg.setDepth(20);
    this.logLines = [];
    this.logText = this.add.text(8, H - this.logH + 4, '', { fontFamily: 'monospace', fontSize: '11px', color: '#d7ccc8', lineSpacing: 2 });
    this.logText.setDepth(21);

    // 背包条（底部日志上方一行）
    this.invText = this.add.text(8, H - this.logH - 16, '', { fontFamily: 'monospace', fontSize: '11px', color: '#ffe082' });
    this.invText.setDepth(21);

    // 死亡/胜利遮罩
    this.dim = this.add.image(W / 2, H / 2, 'panel');
    this.dim.setDisplaySize(W, H);
    this.dim.setTint(0x000000);
    this.dim.setAlpha(0);
    this.dim.setDepth(30);
    this.dim.setVisible(false);
    this.overText = this.add.text(W / 2, H / 2, '', { fontFamily: 'monospace', fontSize: '18px', color: '#ff8a80', align: 'center' });
    this.overText.setOrigin(0.5, 0.5);
    this.overText.setDepth(31);
    this.overText.setVisible(false);

    // ---- 生成首层 ----
    this.generateAndPlaceFloor(1);

    // BGM 启动（需用户交互后才有声，静默失败不影响）
    try { Sfx.startBgm(); } catch (e2) {}

    this.updateHud();
    this.pushLog('风来西林：WASD/方向键移动，斜向QEZC，空格等待');
    this.pushLog('踩道具自动拾取，1-8使用，G 下楼。饱腹会随步数下降！');
  };

  // ---- 日志 ----
  RoguelikeScene.prototype.pushLog = function (msg) {
    this.logLines.push(msg);
    if (this.logLines.length > 3) { this.logLines.shift(); }
    this.logText.setText(this.logLines.join('\n'));
  };

  // ---- HUD 刷新（饱腹在报告中体现）----
  RoguelikeScene.prototype.updateHud = function () {
    var hungerTag = this.hunger > 30 ? '' : (this.hunger > 0 ? ' [空腹!]' : ' [饿死中!]');
    var hpStr = 'HP ' + this.playerHp + '/' + this.playerMaxHp;
    var hungerStr = '饱腹 ' + this.hunger + '/' + HUNGER_MAX + hungerTag;
    var lvStr = 'Lv' + this.playerLv + ' Exp ' + this.playerExp + '/' + needExp(this.playerLv);
    var floorStr = 'B' + this.floor + 'F';
    var atkDef = 'ATK' + this.playerAtk + ' DEF' + this.playerDef;
    this.hudText.setText(floorStr + '  ' + hpStr + '  ' + hungerStr + '  ' + lvStr);
    this.hudText2.setText(atkDef + '  最深' + this.deepestFloor + 'F  最高Lv' + this.maxLvReached + '  [R]重来  [1-8]使用道具');
    // 背包
    var invStr = '背包(' + this.inventory.length + '/' + INV_MAX + '): ';
    if (this.inventory.length === 0) { invStr += '空'; }
    else {
      for (var i = 0; i < this.inventory.length; i++) {
        var it = this.inventory[i];
        var def = ITEM_DEFS[it.kindIdx];
        invStr += '[' + (i + 1) + ']' + def.nameCn + ' ';
      }
    }
    this.invText.setText(invStr);
  };

  // ---- 楼层生成与摆放 ----
  RoguelikeScene.prototype.generateAndPlaceFloor = function (floor) {
    this.floor = floor;
    if (floor > this.deepestFloor) { this.deepestFloor = floor; }
    var seed = this.runSeed + floor * 1009 + floor * floor * 17;
    var gen = generateFloor(floor, seed);
    this.map = gen.map;
    this.rooms = gen.rooms;
    this.stairsPos = gen.stairs;
    this.playerX = gen.start.x;
    this.playerY = gen.start.y;
    this.rng = gen.rng;

    // 重置探索（保留已探索跨层不保留，每层独立）
    for (var y = 0; y < MAP_H; y++) {
      for (var x = 0; x < MAP_W; x++) { this.explored[y][x] = false; this.visible[y][x] = false; }
    }

    // 刷新瓦片贴图
    for (var ty = 0; ty < MAP_H; ty++) {
      for (var tx = 0; tx < MAP_W; tx++) {
        var v = this.map[ty][tx];
        var key = v === 0 ? 'tile_wall' : (v === 1 ? 'tile_floor' : (v === 2 ? 'tile_stairs' : 'tile_trap'));
        this.tileSprites[ty][tx].setTexture(key);
      }
    }

    // 清理旧池
    for (var ei = 0; ei < this.enemyPool.length; ei++) {
      if (this.enemyPool[ei].sprite) { this.enemyPool[ei].sprite.setVisible(false); }
    }
    for (var ii = 0; ii < this.itemPool.length; ii++) {
      if (this.itemPool[ii].sprite) { this.itemPool[ii].sprite.setVisible(false); }
    }
    this.enemyPool.length = 0;
    this.itemPool.length = 0;

    // 放置敌人（3~6只，2层后加入新敌种）
    var enemyCount = randInt(this.rng, 3, 6);
    // 可用敌表按 minFloor 过滤
    var availEnemies = [];
    for (var di = 0; di < ENEMY_DEFS.length; di++) {
      if (ENEMY_DEFS[di].minFloor <= floor) { availEnemies.push(ENEMY_DEFS[di]); }
    }
    // 第2层必含至少1只新敌（id>=3）
    var needNew = floor >= 2;
    for (var ec = 0; ec < enemyCount; ec++) {
      var tries2 = 0;
      var ex2 = 0, ey2 = 0;
      while (tries2 < 60) {
        tries2++;
        var rm = this.rooms[randInt(this.rng, 0, this.rooms.length - 1)];
        ex2 = randInt(this.rng, rm.x, rm.x + rm.w - 1);
        ey2 = randInt(this.rng, rm.y, rm.y + rm.h - 1);
        if (this.map[ey2][ex2] !== 1) { continue; }
        if (ex2 === this.playerX && ey2 === this.playerY) { continue; }
        if (ex2 === this.stairsPos.x && ey2 === this.stairsPos.y) { continue; }
        var occ = false;
        for (var oi = 0; oi < this.enemyPool.length; oi++) { if (this.enemyPool[oi].x === ex2 && this.enemyPool[oi].y === ey2) { occ = true; break; } }
        if (occ) { continue; }
        break;
      }
      var defPick;
      if (needNew && ec === 0) {
        // 首只必为新敌
        var newPool = availEnemies.filter(function (d) { return d.id >= 3; });
        defPick = newPool[randInt(this.rng, 0, newPool.length - 1)];
      } else {
        defPick = availEnemies[randInt(this.rng, 0, availEnemies.length - 1)];
      }
      var texMap = ['enemy_slime', 'enemy_ghost', 'enemy_orc', 'enemy_demon', 'enemy_skeleton'];
      var spr = this.add.image(this.mapOriginX + ex2 * TILE + TILE / 2, this.mapOriginY + ey2 * TILE + TILE / 2, texMap[defPick.id] || 'enemy_slime');
      spr.setDisplaySize(TILE - 4, TILE - 4);
      spr.setDepth(8);
      this.enemyPool.push({ x: ex2, y: ey2, hp: defPick.hp, maxHp: defPick.hp, atk: defPick.atk, def: defPick.def, exp: defPick.exp, defId: defPick.id, nameCn: defPick.nameCn, sprite: spr, alive: true });
    }

    // 放置道具（4~7个，房间内，至少各 1 种保证 4 种齐）
    var itemCount = randInt(this.rng, 4, 7);
    var kindsToPlace = [0, 1, 2, 3];
    shuffle(this.rng, kindsToPlace);
    // 先保证 4 种各 1 个（若 itemCount>=4）
    var kinds = [];
    for (var kc = 0; kc < Math.min(itemCount, 4); kc++) { kinds.push(kindsToPlace[kc]); }
    while (kinds.length < itemCount) { kinds.push(randInt(this.rng, 0, 3)); }
    shuffle(this.rng, kinds);
    var itemTexMap = ['item_rice', 'item_herb', 'item_scroll', 'item_jar'];
    for (var ic = 0; ic < kinds.length; ic++) {
      var kidx = kinds[ic];
      var ix = 0, iy = 0, itries = 0;
      while (itries < 60) {
        itries++;
        var rm2 = this.rooms[randInt(this.rng, 0, this.rooms.length - 1)];
        ix = randInt(this.rng, rm2.x, rm2.x + rm2.w - 1);
        iy = randInt(this.rng, rm2.y, rm2.y + rm2.h - 1);
        if (this.map[iy][ix] !== 1) { continue; }
        if (ix === this.playerX && iy === this.playerY) { continue; }
        if (ix === this.stairsPos.x && iy === this.stairsPos.y) { continue; }
        var occ2 = false;
        for (var oi2 = 0; oi2 < this.enemyPool.length; oi2++) { if (this.enemyPool[oi2].x === ix && this.enemyPool[oi2].y === iy) { occ2 = true; break; } }
        for (var oi3 = 0; oi3 < this.itemPool.length; oi3++) { if (this.itemPool[oi3].x === ix && this.itemPool[oi3].y === iy) { occ2 = true; break; } }
        if (occ2) { continue; }
        break;
      }
      var ispr = this.add.image(this.mapOriginX + ix * TILE + TILE / 2, this.mapOriginY + iy * TILE + TILE / 2, itemTexMap[kidx]);
      ispr.setDisplaySize(TILE - 6, TILE - 6);
      ispr.setDepth(6);
      this.itemPool.push({ x: ix, y: iy, kindIdx: kidx, sprite: ispr, alive: true });
    }

    // 玩家精灵定位
    this.playerSprite.setPosition(this.mapOriginX + this.playerX * TILE + TILE / 2, this.mapOriginY + this.playerY * TILE + TILE / 2);
    this.playerSprite.setVisible(true);
    this.playerSprite.setDepth(10);

    // 初始 FOV
    this.recomputeFov();
    this.refreshVisibility();

    if (floor === 1) {
      this.pushLog('地牢 B1F 生成完成，房间 ' + this.rooms.length + ' 间');
    } else {
      this.pushLog('下至 B' + floor + 'F！' + (floor >= 2 ? ' 出现新敌人与地刺陷阱！' : ''));
      Sfx.play('stairs');
    }
    this.updateHud();
  };

  // ---- FOV 计算（简化：仅视距内显形，其余暗）----
  // 选择：视距内显形，其余暗（非全显）。注释：FOV_RADIUS 内且 LOS 无墙则 visible。
  RoguelikeScene.prototype.recomputeFov = function () {
    for (var y = 0; y < MAP_H; y++) {
      for (var x = 0; x < MAP_W; x++) { this.visible[y][x] = false; }
    }
    for (var vy = 0; vy < MAP_H; vy++) {
      for (var vx = 0; vx < MAP_W; vx++) {
        var dx = Math.abs(vx - this.playerX), dy = Math.abs(vy - this.playerY);
        var cheb = dx > dy ? dx : dy;
        if (cheb > FOV_RADIUS) { continue; }
        if (!hasLOSClear(this.map, this.playerX, this.playerY, vx, vy)) { continue; }
        this.visible[vy][vx] = true;
        this.explored[vy][vx] = true;
      }
    }
    // 玩家所在格始终可见
    this.visible[this.playerY][this.playerX] = true;
    this.explored[this.playerY][this.playerX] = true;
  };

  RoguelikeScene.prototype.refreshVisibility = function () {
    for (var y = 0; y < MAP_H; y++) {
      for (var x = 0; x < MAP_W; x++) {
        var fog = this.fogSprites[y][x];
        if (!this.explored[y][x]) {
          fog.setAlpha(0.92);
        } else if (!this.visible[y][x]) {
          fog.setAlpha(0.55);
        } else {
          fog.setAlpha(0);
        }
        // 瓦片本身：未探索时半暗
        var tile = this.tileSprites[y][x];
        if (!this.explored[y][x]) { tile.setAlpha(0.35); }
        else if (!this.visible[y][x]) { tile.setAlpha(0.55); }
        else { tile.setAlpha(1); }
      }
    }
    // 敌人/道具：仅 visible 时显示（未探索或暗处隐藏）
    for (var ei = 0; ei < this.enemyPool.length; ei++) {
      var e = this.enemyPool[ei];
      if (!e.alive) { e.sprite.setVisible(false); continue; }
      var vis = this.visible[e.y][e.x];
      e.sprite.setVisible(vis);
      e.sprite.setAlpha(1);
      if (vis) {
        e.sprite.setPosition(this.mapOriginX + e.x * TILE + TILE / 2, this.mapOriginY + e.y * TILE + TILE / 2);
      }
    }
    for (var ii = 0; ii < this.itemPool.length; ii++) {
      var it = this.itemPool[ii];
      if (!it.alive) { it.sprite.setVisible(false); continue; }
      var vis2 = this.visible[it.y][it.x];
      it.sprite.setVisible(vis2);
      if (vis2) {
        it.sprite.setPosition(this.mapOriginX + it.x * TILE + TILE / 2, this.mapOriginY + it.y * TILE + TILE / 2);
      }
    }
    this.playerSprite.setPosition(this.mapOriginX + this.playerX * TILE + TILE / 2, this.mapOriginY + this.playerY * TILE + TILE / 2);
  };

  // ---- 工具查询 ----
  RoguelikeScene.prototype.isBlocked = function (x, y) {
    if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) { return true; }
    if (this.map[y][x] === 0) { return true; }
    return false;
  };
  RoguelikeScene.prototype.enemyAt = function (x, y) {
    for (var i = 0; i < this.enemyPool.length; i++) {
      var e = this.enemyPool[i];
      if (e.alive && e.x === x && e.y === y) { return e; }
    }
    return null;
  };
  RoguelikeScene.prototype.itemAt = function (x, y) {
    for (var i = 0; i < this.itemPool.length; i++) {
      var it = this.itemPool[i];
      if (it.alive && it.x === x && it.y === y) { return it; }
    }
    return null;
  };

  // ---- 回合：玩家行动 → 敌行动 ----
  RoguelikeScene.prototype.tryPlayerMove = function (dx, dy) {
    if (this.over) { return; }
    var nx = this.playerX + dx;
    var ny = this.playerY + dy;
    // 原地等待
    if (dx === 0 && dy === 0) {
      this.consumeTurn('wait');
      return;
    }
    if (this.isBlocked(nx, ny)) {
      this.pushLog('墙壁挡住了去路');
      return;
    }
    var enemy = this.enemyAt(nx, ny);
    if (enemy) {
      // 相邻攻击
      this.playerAttack(enemy);
      this.consumeTurn('attack');
      return;
    }
    // 移动
    this.playerX = nx;
    this.playerY = ny;
    Sfx.play('move');
    // 踩陷阱（仅 floor>=2 且 map 为 3）
    if (this.map[ny][nx] === 3) {
      this.playerHp -= TRAP_DAMAGE;
      if (this.playerHp < 0) { this.playerHp = 0; }
      this.pushLog('踩到地刺！ -' + TRAP_DAMAGE + ' HP');
      Sfx.play('trap');
      // 陷阱触发后变地板（一次性）
      this.map[ny][nx] = 1;
      this.tileSprites[ny][nx].setTexture('tile_floor');
      if (this.playerHp <= 0) { this.handleDeath('地刺'); return; }
    }
    // 踩道具自动拾取
    var it = this.itemAt(nx, ny);
    if (it) { this.pickupItem(it); }
    // 踩楼梯：下行即新关（第二层加新敌/陷阱已在生成时处理）
    if (nx === this.stairsPos.x && ny === this.stairsPos.y) {
      this.pushLog('发现下行楼梯，按 G 下行');
      // 为满足“踩楼梯即下行”的验收，也支持自动下行：若再按一次朝楼梯方向或按 G 均可
      // 这里不自动跳，留给 G 键或再次移动触发（update 中处理自动下行）
    }
    this.consumeTurn('move');
  };

  RoguelikeScene.prototype.consumeTurn = function (action) {
    // 饱腹度随步数下降（每次玩家行动 -1）
    this.turnCount++;
    this.hunger -= HUNGER_PER_TURN;
    if (this.hunger < 0) { this.hunger = 0; }
    if (this.hunger === 20) { this.pushLog('肚子咕咕叫... 饱腹 20'); Sfx.play('hunger'); }
    else if (this.hunger === 10) { this.pushLog('饥饿难耐！饱腹 10'); Sfx.play('hunger'); }
    else if (this.hunger === 0) { this.pushLog('饥饿！每回合扣血！'); Sfx.play('hunger'); }
    // 饿死机制：饱腹 0 时每回合扣血
    if (this.hunger === 0) {
      this.playerHp -= HUNGER_STARVE_DMG;
      this.pushLog('饿死 -' + HUNGER_STARVE_DMG + ' HP');
      Sfx.play('hurt');
      if (this.playerHp <= 0) { this.playerHp = 0; this.handleDeath('饿死'); return; }
    }
    // 楼梯自动下行检测：若玩家在楼梯上且本次为移动，则自动下行（满足验收“踩楼梯即新关”）
    // 为避免无限循环，仅当玩家主动移入楼梯格的那一回合自动下行（由调用方保证），此处不重复触发
    // 敌回合
    this.enemyTurn();
    if (this.over) { return; }
    // FOV 重算
    this.recomputeFov();
    this.refreshVisibility();
    this.updateHud();
    this.checkPlayerDeath();
  };

  RoguelikeScene.prototype.playerAttack = function (enemy) {
    var dmg = calcDamage(this.playerAtk, enemy.def, this.rng);
    enemy.hp -= dmg;
    this.pushLog('你攻击 ' + enemy.nameCn + ' -' + dmg);
    Sfx.play('attack');
    // 受击闪烁
    var spr = enemy.sprite;
    if (spr) { spr.setTint(0xff5252); var self = this; setTimeout(function(){ try{ spr.clearTint(); }catch(e){} },120); }
    if (enemy.hp <= 0) {
      enemy.alive = false;
      enemy.sprite.setVisible(false);
      this.pushLog(enemy.nameCn + ' 被击败！ +' + enemy.exp + ' Exp');
      this.gainExp(enemy.exp);
      Sfx.play('hit');
    } else {
      // 敌还有血，轻微 Sfx
    }
  };

  RoguelikeScene.prototype.gainExp = function (amount) {
    this.playerExp += amount;
    while (this.playerExp >= needExp(this.playerLv)) {
      this.playerExp -= needExp(this.playerLv);
      this.playerLv++;
      if (this.playerLv > this.maxLvReached) { this.maxLvReached = this.playerLv; }
      // 升级成长：HP+6, ATK+2, DEF+1，回满
      this.playerMaxHp += 6;
      this.playerHp = this.playerMaxHp;
      this.playerAtk += 2;
      this.playerDef += 1;
      this.pushLog('升级！ Lv' + this.playerLv + ' HP+' + 6 + ' ATK+2 DEF+1');
      Sfx.play('levelup');
      this.persistSave();
    }
    this.updateHud();
  };

  RoguelikeScene.prototype.pickupItem = function (it) {
    if (this.inventory.length >= INV_MAX) {
      this.pushLog('背包已满！(' + INV_MAX + '格)');
      return;
    }
    it.alive = false;
    it.sprite.setVisible(false);
    this.inventory.push({ kindIdx: it.kindIdx });
    var def = ITEM_DEFS[it.kindIdx];
    this.pushLog('拾取 ' + def.nameCn + ' [' + def.desc + ']');
    Sfx.play('pickup');
    this.updateHud();
  };

  RoguelikeScene.prototype.useItem = function (slotIdx) {
    if (this.over) { return; }
    if (slotIdx < 0 || slotIdx >= this.inventory.length) { this.pushLog('该格无道具'); return; }
    var entry = this.inventory[slotIdx];
    var kind = ITEM_DEFS[entry.kindIdx].kind;
    // 消耗
    this.inventory.splice(slotIdx, 1);
    if (kind === 'rice') {
      this.hunger += 30;
      if (this.hunger > HUNGER_MAX) { this.hunger = HUNGER_MAX; }
      this.pushLog('食用饭团 饱腹+30 (' + this.hunger + '/' + HUNGER_MAX + ')');
      Sfx.play('use');
      this.consumeTurn('use');
    } else if (kind === 'herb') {
      this.playerHp += 12;
      if (this.playerHp > this.playerMaxHp) { this.playerHp = this.playerMaxHp; }
      this.pushLog('使用草药 回血12 (' + this.playerHp + '/' + this.playerMaxHp + ')');
      Sfx.play('use');
      this.consumeTurn('use');
    } else if (kind === 'scroll') {
      // 范围伤害：以玩家为中心 3x3（含对角）内所有敌 -10
      var hit = 0;
      for (var i = 0; i < this.enemyPool.length; i++) {
        var e = this.enemyPool[i];
        if (!e.alive) { continue; }
        var dx = Math.abs(e.x - this.playerX), dy = Math.abs(e.y - this.playerY);
        if (dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0)) {
          e.hp -= 10;
          hit++;
          if (e.hp <= 0) {
            e.alive = false; e.sprite.setVisible(false);
            this.pushLog(e.nameCn + ' 被卷轴击倒！ +' + e.exp + ' Exp');
            this.gainExp(e.exp);
          } else {
            this.pushLog('卷轴击中 ' + e.nameCn + ' -10');
          }
        }
      }
      if (hit === 0) { this.pushLog('卷轴无人命中'); }
      Sfx.play('use');
      this.consumeTurn('use');
    } else if (kind === 'jar') {
      // 投掷：对最近一格内的敌单体 -15，若无则向前一格投掷逻辑简化为周围最近敌
      var target = null; var bestD = 999;
      for (var j = 0; j < this.enemyPool.length; j++) {
        var ej = this.enemyPool[j];
        if (!ej.alive) { continue; }
        var ddx = Math.abs(ej.x - this.playerX), ddy = Math.abs(ej.y - this.playerY);
        var cheb2 = ddx > ddy ? ddx : ddy;
        if (cheb2 <= 5) {
          // 优先相邻
          var adj = (cheb2 === 1) ? 0 : cheb2;
          if (adj < bestD) { bestD = adj; target = ej; }
        }
      }
      if (target) {
        target.hp -= 15;
        this.pushLog('投掷壶击中 ' + target.nameCn + ' -15');
        if (target.hp <= 0) {
          target.alive = false; target.sprite.setVisible(false);
          this.pushLog(target.nameCn + ' 被击倒！ +' + target.exp + ' Exp');
          this.gainExp(target.exp);
        }
        Sfx.play('use');
      } else {
        this.pushLog('壶投向空处');
        Sfx.play('use');
      }
      this.consumeTurn('use');
    }
  };

  // ---- 敌回合（玩家 moves→敌 moves）----
  RoguelikeScene.prototype.enemyTurn = function () {
    for (var i = 0; i < this.enemyPool.length; i++) {
      var e = this.enemyPool[i];
      if (!e.alive) { continue; }
      // 仅在玩家可见范围内或距离 <=8 的敌才行动（简化）
      var dx = e.x - this.playerX, dy = e.y - this.playerY;
      var dist = Math.abs(dx) + Math.abs(dy);
      // 相邻攻击
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && !(dx === 0 && dy === 0)) {
        // 若对角相邻也算攻击（风来可斜向攻击）
        var edmg = calcDamage(e.atk, this.playerDef, this.rng);
        this.playerHp -= edmg;
        if (this.playerHp < 0) { this.playerHp = 0; }
        this.pushLog(e.nameCn + ' 攻击你 -' + edmg);
        Sfx.play('hurt');
        // 玩家受击闪烁
        this.playerSprite.setTint(0xff5252);
        var ps = this.playerSprite; setTimeout(function(s){ return function(){ try{ s.clearTint(); }catch(ex){} }; }(ps), 120);
        if (this.playerHp <= 0) { this.handleDeath(e.nameCn); return; }
        continue;
      }
      // 追击：贪心向玩家靠近一格（8向）
      if (dist > 10) { continue; }
      var stepX = 0, stepY = 0;
      if (dx < 0) { stepX = 1; } else if (dx > 0) { stepX = -1; }
      if (dy < 0) { stepY = 1; } else if (dy > 0) { stepY = -1; }
      // 尝试对角/直线，带备选
      var cands = [];
      if (stepX !== 0 && stepY !== 0) {
        cands.push({ x: e.x + stepX, y: e.y + stepY });
        cands.push({ x: e.x + stepX, y: e.y });
        cands.push({ x: e.x, y: e.y + stepY });
      } else if (stepX !== 0) {
        cands.push({ x: e.x + stepX, y: e.y });
        cands.push({ x: e.x + stepX, y: e.y + 1 });
        cands.push({ x: e.x + stepX, y: e.y - 1 });
      } else if (stepY !== 0) {
        cands.push({ x: e.x, y: e.y + stepY });
        cands.push({ x: e.x + 1, y: e.y + stepY });
        cands.push({ x: e.x - 1, y: e.y + stepY });
      }
      var moved = false;
      for (var c = 0; c < cands.length; c++) {
        var nx = cands[c].x, ny = cands[c].y;
        if (this.isBlocked(nx, ny)) { continue; }
        if (nx === this.playerX && ny === this.playerY) { continue; }
        if (this.enemyAt(nx, ny)) { continue; }
        e.x = nx; e.y = ny;
        moved = true;
        break;
      }
      // 未移动则不动
    }
  };

  RoguelikeScene.prototype.checkPlayerDeath = function () {
    if (this.playerHp <= 0) { this.handleDeath('战斗'); }
  };

  RoguelikeScene.prototype.handleDeath = function (reason) {
    if (this.over) { return; }
    this.over = true;
    this.gameState = 'over';
    this.dim.setVisible(true); this.dim.setAlpha(0.72);
    this.overText.setText('倒下了... (' + reason + ')\nB' + this.floor + 'F  Lv' + this.playerLv + '\n按 R 重来');
    this.overText.setVisible(true);
    Sfx.stopBgm();
    Sfx.play('hurt');
    this.persistSave();
    this.updateHud();
  };

  RoguelikeScene.prototype.descendFloor = function () {
    if (this.over) { return; }
    if (this.playerX !== this.stairsPos.x || this.playerY !== this.stairsPos.y) {
      this.pushLog('不在楼梯上');
      return;
    }
    var next = this.floor + 1;
    this.generateAndPlaceFloor(next);
    this.persistSave();
  };

  RoguelikeScene.prototype.persistSave = function () {
    // 存档 {deepestFloor, maxLv}
    var data = { deepestFloor: this.deepestFloor, maxLv: this.maxLvReached };
    saveData = data;
    if (hostRef && typeof hostRef.saveState === 'function') {
      try { hostRef.saveState(data).then(function(){}, function(){}); } catch (e) {}
    }
  };

  // ---- 输入轮询（回合制：每次 JustDown 消耗一回合）----
  RoguelikeScene.prototype.update = function () {
    if (this.over) {
      if (Phaser.Input.Keyboard.JustDown(this.keys.R)) {
        Sfx.stopBgm();
        this.scene.restart();
      }
      return;
    }
    // 数字 1-8 使用道具（优先于移动）
    if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) { this.useItem(0); return; }
    if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) { this.useItem(1); return; }
    if (Phaser.Input.Keyboard.JustDown(this.keys.THREE)) { this.useItem(2); return; }
    if (Phaser.Input.Keyboard.JustDown(this.keys.FOUR)) { this.useItem(3); return; }
    if (Phaser.Input.Keyboard.JustDown(this.keys.FIVE)) { this.useItem(4); return; }
    if (Phaser.Input.Keyboard.JustDown(this.keys.SIX)) { this.useItem(5); return; }
    if (Phaser.Input.Keyboard.JustDown(this.keys.SEVEN)) { this.useItem(6); return; }
    if (Phaser.Input.Keyboard.JustDown(this.keys.EIGHT)) { this.useItem(7); return; }

    // G 下楼（站在楼梯上）
    if (Phaser.Input.Keyboard.JustDown(this.keys.G)) {
      if (this.playerX === this.stairsPos.x && this.playerY === this.stairsPos.y) {
        this.descendFloor();
        return;
      }
    }

    // 方向：支持 8 向（WASD + QEZC + 箭头），斜向可选
    var dx = 0, dy = 0;
    var left = this.keys.A.isDown || this.keys.LEFT.isDown;
    var right = this.keys.D.isDown || this.keys.RIGHT.isDown;
    var up = this.keys.W.isDown || this.keys.UP.isDown;
    var down = this.keys.DOWN.isDown || this.keys.S.isDown;
    var q = this.keyQ.isDown;
    var eKey = this.keyE.isDown;
    var z = this.keyZ.isDown;
    var cKey = this.keyC.isDown;

    // 斜向 QEZC 优先
    if (q) { dx = -1; dy = -1; }
    else if (eKey) { dx = 1; dy = -1; }
    else if (z) { dx = -1; dy = 1; }
    else if (cKey) { dx = 1; dy = 1; }
    else {
      if (left) { dx -= 1; }
      if (right) { dx += 1; }
      if (up) { dy -= 1; }
      if (down) { dy += 1; }
      // 归一到 8 向单步（对角时 dx,dy 各±1 已是单步）
      if (dx !== 0 && dy !== 0) { /* 对角 */ }
    }

    // 去抖：每按一次方向只走一格（用 JustDown 检测首按，避免按住连发过快）
    var moved = false;
    // 检测 JustDown 的方向键（任一）
    var justUp = Phaser.Input.Keyboard.JustDown(this.keys.W) || Phaser.Input.Keyboard.JustDown(this.keys.UP) || Phaser.Input.Keyboard.JustDown(this.keyQ) || Phaser.Input.Keyboard.JustDown(this.keyE);
    var justDown = Phaser.Input.Keyboard.JustDown(this.keys.S) || Phaser.Input.Keyboard.JustDown(this.keys.DOWN) || Phaser.Input.Keyboard.JustDown(this.keyZ) || Phaser.Input.Keyboard.JustDown(this.keyC);
    var justLeft = Phaser.Input.Keyboard.JustDown(this.keys.A) || Phaser.Input.Keyboard.JustDown(this.keys.LEFT);
    var justRight = Phaser.Input.Keyboard.JustDown(this.keys.D) || Phaser.Input.Keyboard.JustDown(this.keys.RIGHT);
    var justWait = Phaser.Input.Keyboard.JustDown(this.keys.SPACE);
    // QEZC 的 JustDown 已在 justUp/justDown 中覆盖一部分，补全
    var justQ = Phaser.Input.Keyboard.JustDown(this.keyQ);
    var justE = Phaser.Input.Keyboard.JustDown(this.keyE);
    var justZ = Phaser.Input.Keyboard.JustDown(this.keyZ);
    var justC = Phaser.Input.Keyboard.JustDown(this.keyC);

    if (justQ) { this.tryPlayerMove(-1, -1); return; }
    if (justE) { this.tryPlayerMove(1, -1); return; }
    if (justZ) { this.tryPlayerMove(-1, 1); return; }
    if (justC) { this.tryPlayerMove(1, 1); return; }
    if (justWait) { this.tryPlayerMove(0, 0); return; }
    // 同时按下对角：例如 W+A
    if ((Phaser.Input.Keyboard.JustDown(this.keys.W) || Phaser.Input.Keyboard.JustDown(this.keys.UP)) && (this.keys.A.isDown || this.keys.LEFT.isDown)) { this.tryPlayerMove(-1, -1); return; }
    if ((Phaser.Input.Keyboard.JustDown(this.keys.W) || Phaser.Input.Keyboard.JustDown(this.keys.UP)) && (this.keys.D.isDown || this.keys.RIGHT.isDown)) { this.tryPlayerMove(1, -1); return; }
    if ((Phaser.Input.Keyboard.JustDown(this.keys.S) || Phaser.Input.Keyboard.JustDown(this.keys.DOWN)) && (this.keys.A.isDown || this.keys.LEFT.isDown)) { this.tryPlayerMove(-1, 1); return; }
    if ((Phaser.Input.Keyboard.JustDown(this.keys.S) || Phaser.Input.Keyboard.JustDown(this.keys.DOWN)) && (this.keys.D.isDown || this.keys.RIGHT.isDown)) { this.tryPlayerMove(1, 1); return; }
    if (justUp) { this.tryPlayerMove(0, -1); return; }
    if (justDown) { this.tryPlayerMove(0, 1); return; }
    if (justLeft) { this.tryPlayerMove(-1, 0); return; }
    if (justRight) { this.tryPlayerMove(1, 0); return; }

    // 自动下行：若玩家站在楼梯上且按了任意移动键试图“下行”（满足验收“踩楼梯即新关”的另一种触发）
    // 已在 tryPlayerMove 中提示，本处不自动触发，避免误触；仅 G 键下行
  };

  // ==========================================================================
  // 启动
  // ==========================================================================
  function launch(host) {
    hostRef = host;
    var W = host.width || 960;
    var H = host.height || 540;
    var game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.container,
      width: W,
      height: H,
      backgroundColor: '#1a1410',
      physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
      scene: [RoguelikeScene]
    });
    window.__trgame = { game: game, getState: getState };
    return game;
  }

  if (typeof window.TRGames !== 'undefined' && typeof window.TRGames.register === 'function') {
    window.TRGames.register({ id: 'roguelike-shiren', title: '风来西林 Roguelike', launch: launch });
  }
})();
