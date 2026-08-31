// =============================================================================
// games/srpg-fe/main.js — 火焰纹章风格 SRPG（10×10 网格回合战术，2章）
// =============================================================================
// 资产清单（全代码生成，零外部资源）：
//   视觉：
//     - 网格线 + 地形色块（平原/森/山/水）由 Graphics 绘制，格子填充色见 TERRAIN
//       视觉替换点：搜索“视觉替换点”—— 把 Graphics 填色/贴图替换为
//         this.load.image('tile_plain','assets/tile_plain.png') 等瓦片集；
//         网格可替换为 Tiled JSON：this.load.tilemapTiledJSON('ch1','assets/ch1.json')
//     - 单位几何 + generateTexture：
//         Graphics→generateTexture('u_sword'/'u_lance'/'u_axe'/'u_bow'/'u_mage'/'u_pegasus')
//         及阴影/血条/选中框；敌方同形叠红色描边或 tint 区分
//       视觉替换点：把 generateTexture 块换成 spritesheet 帧动画：
//         this.load.spritesheet('sword','assets/sword.png',{frameWidth:32,frameHeight:32})
//     - 攻击弹道/命中特效：Graphics 圆/线 + tween，池化复用
//       视觉替换点：命中特效可换粒子贴图/序列帧
//   音频：
//     Sfx.play('move'/'attack'/'hit'/'death'/'victory'/'select'/'cancel'/'bgm')
//       内部 WebAudio oscillator+gain 自合成，首交互 resume，失败静默降级
//       音频替换点：搜索“音频替换点”—— 把 oscillator 分支换成
//         this.load.audio('attack','assets/attack.wav') + this.sound.play('attack')
//   关卡：
//     CHAPTERS 数组内 Map 字符串（'.'平原 'F'森 'M'山 'W'水）+ 玩家/敌方单位表
//       替换点：可替换为外部 JSON 关卡：this.load.json('ch2','assets/ch2.json')
//   存档：
//     host.saveState/loadState 持久化 {clearedChapter:number}
//   测试缝：
//     window.__trgame = { game:Phaser.Game, getState():{scene,chapter,turn,units[]} }
// =============================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 可调参数
  // ---------------------------------------------------------------------------
  var GRID_W = 10;
  var GRID_H = 10;
  var TILE = 42; // 格子像素，随 host 尺寸自适应缩放时仍以此为逻辑基准
  var TILE_GAP = 1;

  // 职业数据表 — HP/攻防速/移动力/射程/武器类型/飞行
  // 数值来源：FE 常见区间压缩，确保一击约 7-12 伤害、2-3 击倒
  var CLASS_DATA = {
    sword:   { name: '剑士', hp: 24, atk: 9, def: 6, spd: 8, mov: 5, range: [1, 1], weapon: 'sword', flying: false, color: 0x42a5f5 },
    lance:   { name: '枪兵', hp: 26, atk: 8, def: 7, spd: 6, mov: 5, range: [1, 1], weapon: 'lance', flying: false, color: 0x66bb6a },
    axe:     { name: '斧兵', hp: 28, atk: 10, def: 5, spd: 5, mov: 5, range: [1, 1], weapon: 'axe', flying: false, color: 0xff7043 },
    bow:     { name: '弓兵', hp: 22, atk: 9, def: 4, spd: 7, mov: 5, range: [2, 2], weapon: 'bow', flying: false, color: 0xffee58 },
    mage:    { name: '法师', hp: 20, atk: 11, def: 3, spd: 7, mov: 4, range: [1, 2], weapon: 'tome', flying: false, color: 0xab47bc },
    pegasus: { name: '天马', hp: 23, atk: 8, def: 5, spd: 9, mov: 6, range: [1, 1], weapon: 'lance', flying: true, color: 0xf48fb1 }
  };

  // 地形表 — 防御加成/回避加成/移动消耗/是否阻挡
  var TERRAIN = {
    plain:   { key: '.', name: '平原', color: 0xb8e6a3, color2: 0xa5d6a7, def: 0, avo: 0,  cost: 1, block: false },
    forest:  { key: 'F', name: '森林', color: 0x4a7c2e, color2: 0x38681e, def: 2, avo: 15, cost: 2, block: false },
    mountain:{ key: 'M', name: '山地', color: 0x8d6e63, color2: 0x7a5f55, def: 3, avo: 20, cost: 3, block: false },
    water:   { key: 'W', name: '河水', color: 0x64b5f6, color2: 0x4a90c4, def: 0, avo: 0,  cost: 99, block: true }
  };
  var TERRAIN_BY_KEY = { '.': TERRAIN.plain, 'F': TERRAIN.forest, 'M': TERRAIN.mountain, 'W': TERRAIN.water };

  // 武器三角克制：剑克斧克枪克剑；弓额外克飞行（天马）
  // 返回 {dmg: ±4, hit: ±15}
  function triangleBonus(atkWeapon, defWeapon, defFlying) {
    var dmg = 0, hit = 0;
    if (atkWeapon === 'sword' && defWeapon === 'axe') { dmg = 4; hit = 15; }
    else if (atkWeapon === 'axe' && defWeapon === 'lance') { dmg = 4; hit = 15; }
    else if (atkWeapon === 'lance' && defWeapon === 'sword') { dmg = 4; hit = 15; }
    else if (atkWeapon === 'axe' && defWeapon === 'sword') { dmg = -4; hit = -15; }
    else if (atkWeapon === 'lance' && defWeapon === 'axe') { dmg = -4; hit = -15; }
    else if (atkWeapon === 'sword' && defWeapon === 'lance') { dmg = -4; hit = -15; }
    // 弓克飞行
    if (atkWeapon === 'bow' && defFlying) { dmg += 5; hit += 10; }
    return { dmg: dmg, hit: hit };
  }

  // 章节定义 — 地图与敌配置不同，章2加入地形与新职业
  var CHAPTERS = [
    {
      id: 1,
      name: '第一章  草原遭遇',
      desc: '平原为主，熟悉移动与三角克制',
      // 10 行×10 列，'.'平原 'F'森林 其余隐式平原
      map: [
        '..........',
        '....F.....',
        '.....F....',
        '..........',
        '...F..F...',
        '..........',
        '....F.....',
        '..........',
        '.....F....',
        '..........'
      ],
      player: [
        { cls: 'sword', x: 1, y: 8 },
        { cls: 'lance', x: 3, y: 9 },
        { cls: 'axe',   x: 5, y: 9 },
        { cls: 'bow',   x: 2, y: 9 }
      ],
      enemy: [
        { cls: 'axe',   x: 4, y: 2 },
        { cls: 'lance', x: 6, y: 2 },
        { cls: 'sword', x: 5, y: 1 },
        { cls: 'bow',   x: 7, y: 3 }
      ]
    },
    {
      id: 2,
      name: '第二章  密林山隘',
      desc: '森林与山地交错，新职业法师登场',
      map: [
        '..FMMF....',
        '..FMMF.W..',
        '..FFF..W..',
        '...F...W..',
        'F..F..FF..',
        'FF..MFFFF.',
        '..W.MMMM..',
        '..W.MFFM..',
        '...W.FF...',
        '....W.....'
      ],
      player: [
        { cls: 'sword',   x: 1, y: 8 },
        { cls: 'lance',   x: 3, y: 9 },
        { cls: 'axe',     x: 5, y: 9 },
        { cls: 'bow',     x: 2, y: 9 },
        { cls: 'mage',    x: 4, y: 8 }
      ],
      enemy: [
        { cls: 'sword',   x: 5, y: 1 },
        { cls: 'mage',    x: 6, y: 2 },
        { cls: 'axe',     x: 4, y: 2 },
        { cls: 'pegasus', x: 7, y: 2 },
        { cls: 'bow',     x: 3, y: 3 }
      ]
    }
  ];

  // ---------------------------------------------------------------------------
  // 存档与全局
  // ---------------------------------------------------------------------------
  var hostRef = null;
  var sceneRef = null;
  var saveData = { clearedChapter: 0 };
  var curChapterId = 1;

  function getState() {
    var s = sceneRef;
    if (!s) return { scene: 'none', chapter: curChapterId, turn: 0, units: [] };
    var units = [];
    if (s.units) {
      for (var i = 0; i < s.units.length; i++) {
        var u = s.units[i];
        units.push({ x: u.x, y: u.y, hp: u.hp, maxHp: u.maxHp, team: u.team, cls: u.cls, alive: u.alive, acted: !!u.acted });
      }
    }
    return {
      scene: (s.scene && s.scene.key) ? s.scene.key : 'battle',
      chapter: s.chapterId || curChapterId,
      turn: s.turnCount || 0,
      units: units
    };
  }

  // ---------------------------------------------------------------------------
  // 音频 — WebAudio 自合成
  // 音频替换点：把 Sfx.play 各 type 分支的 oscillator 换成 AudioBuffer 即可
  // ---------------------------------------------------------------------------
  var Sfx = {
    ctx: null,
    bgmTimer: null,
    enabled: true,
    ensure: function () {
      if (this.ctx) return this.ctx;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { this.enabled = false; return null; }
        this.ctx = new AC();
      } catch (e) { this.enabled = false; return null; }
      return this.ctx;
    },
    resume: function () {
      var c = this.ensure();
      if (!c) return;
      if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    },
    play: function (type) {
      var c = this.ensure();
      if (!c || !this.enabled) return;
      this.resume();
      try {
        var o = c.createOscillator();
        var g = c.createGain();
        o.connect(g); g.connect(c.destination);
        var now = c.currentTime;
        // 音频替换点：每个 type 即替换点，可接入外部采样
        if (type === 'select') {
          o.type = 'sine'; o.frequency.setValueAtTime(660, now);
          g.gain.setValueAtTime(0.14, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
          o.start(now); o.stop(now + 0.13);
        } else if (type === 'move') {
          o.type = 'sine'; o.frequency.setValueAtTime(440, now);
          o.frequency.linearRampToValueAtTime(550, now + 0.12);
          g.gain.setValueAtTime(0.12, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
          o.start(now); o.stop(now + 0.17);
        } else if (type === 'cancel') {
          o.type = 'sine'; o.frequency.setValueAtTime(380, now);
          o.frequency.linearRampToValueAtTime(280, now + 0.12);
          g.gain.setValueAtTime(0.12, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
          o.start(now); o.stop(now + 0.17);
        } else if (type === 'attack') {
          o.type = 'square'; o.frequency.setValueAtTime(220, now);
          o.frequency.exponentialRampToValueAtTime(110, now + 0.12);
          g.gain.setValueAtTime(0.18, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
          o.start(now); o.stop(now + 0.19);
        } else if (type === 'hit') {
          o.type = 'square'; o.frequency.setValueAtTime(880, now);
          o.frequency.setValueAtTime(660, now + 0.06);
          g.gain.setValueAtTime(0.2, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
          o.start(now); o.stop(now + 0.23);
        } else if (type === 'death') {
          o.type = 'sawtooth'; o.frequency.setValueAtTime(180, now);
          o.frequency.linearRampToValueAtTime(40, now + 0.45);
          g.gain.setValueAtTime(0.22, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
          o.start(now); o.stop(now + 0.51);
        } else if (type === 'victory') {
          o.type = 'sine'; o.frequency.setValueAtTime(523, now);
          o.frequency.setValueAtTime(659, now + 0.15);
          o.frequency.setValueAtTime(784, now + 0.30);
          o.frequency.setValueAtTime(1046, now + 0.45);
          g.gain.setValueAtTime(0.18, now); g.gain.linearRampToValueAtTime(0.001, now + 0.7);
          o.start(now); o.stop(now + 0.71);
        } else {
          o.type = 'sine'; o.frequency.setValueAtTime(440, now);
          g.gain.setValueAtTime(0.1, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
          o.start(now); o.stop(now + 0.11);
        }
      } catch (e) {}
    },
    startBgm: function (scene) {
      this.stopBgm();
      var self = this;
      // 简易 BGM：定时轻敲 select 音，避免吵闹
      this.bgmTimer = scene.time.addEvent({ delay: 2400, loop: true, callback: function () {
        if (sceneRef && sceneRef.phase === 'player' && !sceneRef.isAnimating) {
          // 极轻节奏，不主动播，避免干扰
        }
      }});
    },
    stopBgm: function () {
      if (this.bgmTimer) { try { this.bgmTimer.remove(false); } catch (e) {} this.bgmTimer = null; }
    }
  };

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // BFS 移动范围 — 曼哈顿距离按地形消耗累计≤移动力，避障碍/所有单位（起格除外）
  // 返回 Map "x,y" -> cost
  function bfsReachable(sx, sy, mov, board, units, team) {
    var key = function (x, y) { return x + ',' + y; };
    var visited = {};
    var queue = [{ x: sx, y: sy, c: 0 }];
    visited[key(sx, sy)] = 0;
    var head = 0;
    // 占据集合：所有存活单位（起点除外），不可踏入也不可穿过
    var occupied = {};
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!u.alive) continue;
      if (u.x === sx && u.y === sy) continue;
      occupied[key(u.x, u.y)] = true;
    }
    while (head < queue.length) {
      var cur = queue[head++];
      var dirs = [[1,0],[-1,0],[0,1],[0,-1]];
      for (var d = 0; d < 4; d++) {
        var nx = cur.x + dirs[d][0];
        var ny = cur.y + dirs[d][1];
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
        var k = key(nx, ny);
        if (visited.hasOwnProperty(k)) continue;
        var terr = TERRAIN_BY_KEY[board[ny][nx]] || TERRAIN.plain;
        if (terr.block) continue;
        if (occupied[k]) continue; // 任何单位格子不可踏入/穿过
        var nc = cur.c + terr.cost;
        if (nc > mov) continue;
        visited[k] = nc;
        queue.push({ x: nx, y: ny, c: nc });
      }
    }
    return visited;
  }

  // 计算命中/伤害
  function computeCombat(atk, def, board) {
    var atkData = CLASS_DATA[atk.cls];
    var defData = CLASS_DATA[def.cls];
    var atkW = atkData.weapon;
    var defW = defData.weapon;
    var tri = triangleBonus(atkW, defW, !!defData.flying);
    var defTerr = TERRAIN_BY_KEY[board[def.y][def.x]] || TERRAIN.plain;
    var defBonus = defTerr.def;
    var avoBonus = defTerr.avo;
    var hit = 75 + (atk.spd - def.spd) * 3 + tri.hit - avoBonus;
    hit = clamp(hit, 40, 95);
    var dmg = atk.atk + tri.dmg - (def.def + defBonus);
    if (dmg < 1) dmg = 1;
    // 弓对飞行已在 tri
    var isAdv = tri.dmg > 0;
    var isDis = tri.dmg < 0;
    return { hit: hit, dmg: dmg, adv: isAdv, dis: isDis, triDmg: tri.dmg, triHit: tri.hit, terrDef: defBonus, terrAvo: avoBonus };
  }

  function manhattan(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }

  function inRange(attacker, target) {
    var d = manhattan(attacker.x, attacker.y, target.x, target.y);
    var rg = CLASS_DATA[attacker.cls].range;
    return d >= rg[0] && d <= rg[1];
  }

  // 寻找最近可攻击目标的 BFS 路径（用于敌 AI）
  // 尝试每一个可达格子，找能攻击任一玩家的格子中距起点代价最小的
  function enemyFindMove(enemy, board, units) {
    var mov = CLASS_DATA[enemy.cls].mov;
    var reach = bfsReachable(enemy.x, enemy.y, mov, board, units, 'enemy');
    var players = [];
    for (var i = 0; i < units.length; i++) if (units[i].alive && units[i].team === 'player') players.push(units[i]);
    if (players.length === 0) return null;
    var best = null;
    var bestDist = 1e9;
    var bestTarget = null;
    // 枚举所有可达格子
    var keys = Object.keys(reach);
    for (var ki = 0; ki < keys.length; ki++) {
      var parts = keys[ki].split(',');
      var rx = parseInt(parts[0], 10);
      var ry = parseInt(parts[1], 10);
      var cost = reach[keys[ki]];
      for (var pi = 0; pi < players.length; pi++) {
        var p = players[pi];
        var fake = { x: rx, y: ry, cls: enemy.cls };
        if (!inRange(fake, p)) continue;
        var d = manhattan(rx, ry, p.x, p.y);
        // 优先能攻击，其次代价小
        var score = cost * 10 + d;
        if (score < bestDist) {
          bestDist = score;
          best = { x: rx, y: ry, cost: cost };
          bestTarget = p;
        }
      }
    }
    // 如果没有可攻击位，则向最近玩家靠近（选可达格子中曼哈顿最近的）
    if (!best) {
      var nearest = null; var nd = 1e9;
      for (var ki2 = 0; ki2 < keys.length; ki2++) {
        var pr2 = keys[ki2].split(',');
        var rx2 = parseInt(pr2[0], 10); var ry2 = parseInt(pr2[1], 10);
        for (var pi2 = 0; pi2 < players.length; pi2++) {
          var p2 = players[pi2];
          var md = manhattan(rx2, ry2, p2.x, p2.y);
          if (md < nd) { nd = md; nearest = { x: rx2, y: ry2 }; }
        }
      }
      if (nearest) best = nearest;
    }
    // 计算最近玩家用于攻击抉择
    if (!bestTarget && best) {
      var mdBest = 1e9;
      for (var pi3 = 0; pi3 < players.length; pi3++) {
        var pp = players[pi3];
        if (!inRange({ x: best.x, y: best.y, cls: enemy.cls }, pp)) continue;
        var dd = manhattan(best.x, best.y, pp.x, pp.y);
        if (dd < mdBest) { mdBest = dd; bestTarget = pp; }
      }
      if (!bestTarget) {
        // 攻击范围内没有，则找相邻最近的玩家（仅用于显示）
        var closest = null; var cd2 = 1e9;
        for (var pi4 = 0; pi4 < players.length; pi4++) {
          var ppp = players[pi4];
          var ddd = manhattan(best.x, best.y, ppp.x, ppp.y);
          if (ddd < cd2) { cd2 = ddd; closest = ppp; }
        }
        // 若贴身距离在射程内才设为目标
        if (closest && inRange({ x: best.x, y: best.y, cls: enemy.cls }, closest)) bestTarget = closest;
      }
    }
    return { move: best, target: bestTarget, reach: reach };
  }

  // ---------------------------------------------------------------------------
  // 纹理生成 — 纯几何 Graphics
  // 视觉替换点：所有 generateTexture 块可替换为外部贴图加载
  // ---------------------------------------------------------------------------
  function buildTextures(scene) {
    var g;
    function rm(k) { try { if (scene.textures.exists(k)) scene.textures.remove(k); } catch (e) {} }

    // 单位纹理 — 每职业一个 32x32
    var classes = ['sword', 'lance', 'axe', 'bow', 'mage', 'pegasus'];
    for (var ci = 0; ci < classes.length; ci++) {
      var cls = classes[ci];
      var cd = CLASS_DATA[cls];
      var key = 'u_' + cls;
      rm(key);
      g = scene.add.graphics();
      // 阴影椭圆
      g.fillStyle(0x000000, 0.22);
      g.fillEllipse(16, 28, 18, 6);
      // 主体几何
      // 视觉替换点：以下 fill 几何可替换为精灵帧
      if (cls === 'sword') {
        g.fillStyle(cd.color, 1);
        g.fillRoundedRect(6, 6, 20, 20, 4);
        g.fillStyle(0xffffff, 1);
        // 剑竖线
        g.fillRect(14, 4, 4, 18);
        g.fillTriangle(16, 1, 11, 8, 21, 8);
        g.fillStyle(0x263238, 1);
        g.fillRect(11, 20, 10, 3);
      } else if (cls === 'lance') {
        g.fillStyle(cd.color, 1);
        g.fillRoundedRect(7, 8, 18, 18, 5);
        g.fillStyle(0xe0e0e0, 1);
        g.fillRect(14, 2, 4, 22);
        g.fillTriangle(16, 0, 10, 6, 22, 6);
        g.fillStyle(0x37474f, 1);
        g.fillCircle(16, 24, 2);
      } else if (cls === 'axe') {
        g.fillStyle(cd.color, 1);
        g.fillRoundedRect(8, 10, 16, 16, 3);
        g.fillStyle(0x78909c, 1);
        // 斧头
        g.fillTriangle(20, 6, 10, 9, 20, 14);
        g.fillRect(18, 12, 4, 12);
        g.fillStyle(0x3e2723, 1);
        g.fillRect(16, 14, 3, 10);
      } else if (cls === 'bow') {
        g.fillStyle(cd.color, 1);
        g.fillRoundedRect(6, 9, 20, 16, 6);
        g.fillStyle(0x5d4037, 1);
        // 弓弧
        g.lineStyle(2, 0x5d4037, 1);
        g.strokeCircle(16, 16, 10);
        g.fillStyle(0xffcc02, 1);
        g.fillTriangle(22, 16, 16, 13, 16, 19);
      } else if (cls === 'mage') {
        g.fillStyle(cd.color, 1);
        g.fillCircle(16, 16, 11);
        g.fillStyle(0xfff9c4, 1);
        g.fillTriangle(16, 4, 10, 14, 22, 14);
        g.fillStyle(0x4a148c, 1);
        g.fillCircle(16, 18, 3);
        g.fillStyle(0xffffff, 1);
        g.fillCircle(18, 12, 2);
      } else if (cls === 'pegasus') {
        g.fillStyle(cd.color, 1);
        g.fillEllipse(16, 18, 20, 14);
        g.fillStyle(0xffffff, 1);
        g.fillEllipse(16, 12, 14, 10);
        g.fillTriangle(6, 14, 2, 10, 4, 18);
        g.fillTriangle(26, 14, 30, 10, 28, 18);
        g.fillStyle(0x263238, 1);
        g.fillCircle(13, 13, 1.5); g.fillCircle(19, 13, 1.5);
      }
      g.generateTexture(key, 32, 32);
      g.destroy();
    }

    // 选中框/网格高亮用不到贴图，运行时 Graphics 绘制

    // 弹道小圆
    rm('proj');
    g = scene.add.graphics();
    g.fillStyle(0xffff00, 1);
    g.fillCircle(4, 4, 4);
    g.fillStyle(0xffffff, 0.9);
    g.fillCircle(4, 4, 2);
    g.generateTexture('proj', 8, 8);
    g.destroy();

    // 粒子星
    rm('star');
    g = scene.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillCircle(3, 3, 3);
    g.generateTexture('star', 6, 6);
    g.destroy();

    rm('pixel');
    g = scene.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 1, 1);
    g.generateTexture('pixel', 1, 1);
    g.destroy();
  }

  // ---------------------------------------------------------------------------
  // 场景：Boot
  // ---------------------------------------------------------------------------
  var BootScene = function () { Phaser.Scene.call(this, { key: 'boot' }); };
  BootScene.prototype = Object.create(Phaser.Scene.prototype);
  BootScene.prototype.constructor = BootScene;
  BootScene.prototype.create = function () {
    buildTextures(this);
    var self = this;
    if (hostRef && typeof hostRef.loadState === 'function') {
      try {
        hostRef.loadState().then(function (d) {
          if (d && typeof d.clearedChapter === 'number') saveData.clearedChapter = d.clearedChapter;
          self.scene.start('menu');
        }, function () { self.scene.start('menu'); });
        return;
      } catch (e) {}
    }
    this.scene.start('menu');
  };

  // ---------------------------------------------------------------------------
  // 场景：Menu
  // ---------------------------------------------------------------------------
  var MenuScene = function () { Phaser.Scene.call(this, { key: 'menu' }); };
  MenuScene.prototype = Object.create(Phaser.Scene.prototype);
  MenuScene.prototype.constructor = MenuScene;
  MenuScene.prototype.create = function () {
    buildTextures(this);
    var w = this.scale.width, h = this.scale.height;
    this.cameras.main.setBackgroundColor('#1a2332');
    // 标题
    this.add.text(w / 2, h * 0.18, '火焰纹章 SRPG', { fontFamily: 'monospace', fontSize: '30px', color: '#e3f2fd', fontStyle: 'bold' }).setOrigin(0.5);
    this.add.text(w / 2, h * 0.26, '网格回合战术 · 武器三角 · 地形加成', { fontFamily: 'monospace', fontSize: '12px', color: '#90a4ae' }).setOrigin(0.5);
    this.add.text(w / 2, h * 0.31, '已通关 ' + saveData.clearedChapter + ' / ' + CHAPTERS.length + ' 章', { fontFamily: 'monospace', fontSize: '12px', color: '#ffd54f' }).setOrigin(0.5);

    var lines = [
      '选单位→ 蓝格可移动(BFS避障碍/友军) → 移动 → 邻敌可攻击 → 待机',
      '剑克斧 斧克枪 枪克剑  弓克飞行  森+防 山+防+回避',
      '点击格子操作  右键/ESC 取消  回车结束回合'
    ];
    for (var i = 0; i < lines.length; i++) {
      this.add.text(w / 2, h * 0.40 + i * 16, lines[i], { fontFamily: 'monospace', fontSize: '11px', color: '#b0bec5' }).setOrigin(0.5);
    }

    var btnY = h * 0.60;
    for (var ci = 0; ci < CHAPTERS.length; ci++) {
      (function (idx) {
        var ch = CHAPTERS[idx];
        var unlocked = idx === 0 || saveData.clearedChapter >= idx;
        var btnW = 380, btnH = 48;
        var bx = w / 2 - btnW / 2;
        var by = btnY + idx * 60;
        var bg = sceneRef ? null : null;
        var rect = this.add.graphics();
        rect.fillStyle(unlocked ? 0x1e88e5 : 0x37474f, 1);
        rect.fillRoundedRect(bx, by, btnW, btnH, 8);
        rect.lineStyle(2, unlocked ? 0x90caf9 : 0x546e7a, 1);
        rect.strokeRoundedRect(bx, by, btnW, btnH, 8);
        var title = ch.name + (unlocked ? '' : ' (未解锁)');
        var t = this.add.text(w / 2, by + 14, title, { fontFamily: 'monospace', fontSize: '13px', color: unlocked ? '#ffffff' : '#90a4ae', fontStyle: 'bold' }).setOrigin(0.5, 0.5);
        var d = this.add.text(w / 2, by + 30, ch.desc, { fontFamily: 'monospace', fontSize: '10px', color: '#b0bec5' }).setOrigin(0.5, 0.5);
        if (unlocked) {
          rect.setInteractive(new Phaser.Geom.Rectangle(bx, by, btnW, btnH), Phaser.Geom.Rectangle.Contains);
          rect.on('pointerdown', function () { Sfx.resume(); Sfx.play('select'); curChapterId = ch.id; this.scene.start('battle', { chapter: ch.id }); }, this);
          rect.on('pointerover', function () { rect.clear(); rect.fillStyle(0x42a5f5, 1); rect.fillRoundedRect(bx, by, btnW, btnH, 8); rect.lineStyle(2, 0xffffff, 1); rect.strokeRoundedRect(bx, by, btnW, btnH, 8); });
          rect.on('pointerout', function () { rect.clear(); rect.fillStyle(0x1e88e5, 1); rect.fillRoundedRect(bx, by, btnW, btnH, 8); rect.lineStyle(2, 0x90caf9, 1); rect.strokeRoundedRect(bx, by, btnW, btnH, 8); });
          t.setInteractive({ useHandCursor: true });
          t.on('pointerdown', function () { Sfx.resume(); Sfx.play('select'); curChapterId = ch.id; this.scene.start('battle', { chapter: ch.id }); }, this);
        }
      }).call(this, ci);
    }

    // 底部提示
    this.add.text(w / 2, h - 18, '点击章节点击开始 · 通关存档自动保存', { fontFamily: 'monospace', fontSize: '10px', color: '#546e7a' }).setOrigin(0.5);
  };

  // ---------------------------------------------------------------------------
  // 场景：Battle
  // ---------------------------------------------------------------------------
  var BattleScene = function () { Phaser.Scene.call(this, { key: 'battle' }); };
  BattleScene.prototype = Object.create(Phaser.Scene.prototype);
  BattleScene.prototype.constructor = BattleScene;

  BattleScene.prototype.init = function (data) {
    this.chapterId = (data && data.chapter) ? data.chapter : 1;
    curChapterId = this.chapterId;
  };

  BattleScene.prototype.create = function () {
    sceneRef = this;
    Sfx.resume();
    this.isAnimating = false;
    buildTextures(this);
    var w = this.scale.width, h = this.scale.height;
    this.cameras.main.setBackgroundColor('#0d1b2a');

    // 章节数据
    var chIdx = this.chapterId - 1;
    if (chIdx < 0) chIdx = 0;
    if (chIdx >= CHAPTERS.length) chIdx = CHAPTERS.length - 1;
    this.chapter = CHAPTERS[chIdx];
    this.board = [];
    for (var r = 0; r < GRID_H; r++) {
      var row = [];
      var line = this.chapter.map[r] || '..........';
      for (var c = 0; c < GRID_W; c++) {
        var ch = line.charAt(c) || '.';
        if (!TERRAIN_BY_KEY[ch]) ch = '.';
        row.push(ch);
      }
      this.board.push(row);
    }

    // 棋盘原点（居中，顶部留 HUD）
    var boardW = GRID_W * TILE;
    var boardH = GRID_H * TILE;
    this.ox = Math.floor((w - boardW) / 2);
    this.oy = Math.floor((h - boardH) / 2) + 18;
    if (this.oy < 50) this.oy = 52;

    // 单位列表
    this.units = [];
    this.nextUid = 1;
    var mkUnit = function (def, team) {
      var cd = CLASS_DATA[def.cls];
      return {
        uid: this.nextUid++,
        team: team,
        cls: def.cls,
        x: def.x, y: def.y,
        ox: def.x, oy: def.y, // 动画用
        maxHp: cd.hp,
        hp: cd.hp,
        atk: cd.atk,
        def: cd.def,
        spd: cd.spd,
        mov: cd.mov,
        weapon: cd.weapon,
        flying: !!cd.flying,
        alive: true,
        acted: false,
        sprite: null,
        hpBar: null,
        hpBg: null,
        label: null
      };
    }.bind(this);
    for (var pi = 0; pi < this.chapter.player.length; pi++) this.units.push(mkUnit(this.chapter.player[pi], 'player'));
    for (var ei = 0; ei < this.chapter.enemy.length; ei++) this.units.push(mkUnit(this.chapter.enemy[ei], 'enemy'));

    this.turnCount = 1;
    this.phase = 'player'; // player | enemy | gameover
    this.selected = null; // 选中的我方单位
    this.reachable = null; // Map "x,y"->cost
    this.attackTargets = []; // 可攻击敌
    this.awaitAttackChoice = false;

    // 图层
    this.terrainLayer = this.add.group();
    this.highlightLayer = this.add.graphics().setDepth(5);
    this.unitSprites = this.add.group();

    // 绘制地形与网格
    this.drawBoard();

    // 创建单位精灵
    for (var ui = 0; ui < this.units.length; ui++) this.createUnitSprite(this.units[ui]);

    // 命中特效池（复用 Graphics/ Text）
    this.fxGroup = this.add.group();
    this.dmgPool = [];
    for (var di = 0; di < 12; di++) {
      var t = this.add.text(-100, -100, '', { fontFamily: 'monospace', fontSize: '14px', color: '#ffffff', stroke: '#000000', strokeThickness: 3, fontStyle: 'bold' }).setOrigin(0.5).setDepth(50).setVisible(false);
      this.dmgPool.push(t);
    }
    this.dmgIdx = 0;
    // 弹道池
    this.projPool = this.add.group();
    for (var pj = 0; pj < 8; pj++) {
      var pr = this.add.image(-100, -100, 'proj').setDepth(40).setVisible(false);
      this.projPool.add(pr);
    }

    // HUD
    this.hudBg = this.add.graphics().setDepth(90);
    this.hudBg.fillStyle(0x0f2438, 0.92);
    this.hudBg.fillRoundedRect(0, 0, w, 44, 0);
    this.hudText = this.add.text(10, 8, '', { fontFamily: 'monospace', fontSize: '13px', color: '#e3f2fd', fontStyle: 'bold' }).setDepth(91);
    this.hudSub = this.add.text(10, 26, '', { fontFamily: 'monospace', fontSize: '10px', color: '#90a4ae' }).setDepth(91);
    this.turnText = this.add.text(w - 10, 8, '', { fontFamily: 'monospace', fontSize: '12px', color: '#ffd54f' }).setOrigin(1, 0).setDepth(91);
    this.phaseText = this.add.text(w - 10, 26, '', { fontFamily: 'monospace', fontSize: '10px', color: '#ffab40' }).setOrigin(1, 0).setDepth(91);

    // 结束回合按钮
    var btnW2 = 96, btnH2 = 28;
    this.endBtnBg = this.add.graphics().setDepth(91);
    this.endBtnBg.fillStyle(0x2e7d32, 1);
    this.endBtnBg.fillRoundedRect(w - btnW2 - 10, h - 36, btnW2, btnH2, 6);
    this.endBtnBg.lineStyle(1, 0x81c784, 1);
    this.endBtnBg.strokeRoundedRect(w - btnW2 - 10, h - 36, btnW2, btnH2, 6);
    this.endBtn = this.add.text(w - 10 - btnW2 / 2, h - 22, '结束回合', { fontFamily: 'monospace', fontSize: '12px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0.5).setDepth(92).setInteractive({ useHandCursor: true });
    this.endBtnBg.setInteractive(new Phaser.Geom.Rectangle(w - btnW2 - 10, h - 36, btnW2, btnH2), Phaser.Geom.Rectangle.Contains);
    var self = this;
    var endHandler = function () {
      if (self.phase !== 'player' || self.isAnimating) return;
      Sfx.play('select');
      self.endPlayerPhase();
    };
    this.endBtn.on('pointerdown', endHandler);
    this.endBtnBg.on('pointerdown', endHandler);
    this.endBtnBg.on('pointerover', function () { self.endBtnBg.clear(); self.endBtnBg.fillStyle(0x388e3c, 1); self.endBtnBg.fillRoundedRect(w - btnW2 - 10, h - 36, btnW2, btnH2, 6); self.endBtnBg.lineStyle(1, 0xaed581, 1); self.endBtnBg.strokeRoundedRect(w - btnW2 - 10, h - 36, btnW2, btnH2, 6); });
    this.endBtnBg.on('pointerout', function () { self.endBtnBg.clear(); self.endBtnBg.fillStyle(0x2e7d32, 1); self.endBtnBg.fillRoundedRect(w - btnW2 - 10, h - 36, btnW2, btnH2, 6); self.endBtnBg.lineStyle(1, 0x81c784, 1); self.endBtnBg.strokeRoundedRect(w - btnW2 - 10, h - 36, btnW2, btnH2, 6); });

    // 菜单返回
    this.menuBtn = this.add.text(10, h - 20, '‹ 菜单', { fontFamily: 'monospace', fontSize: '11px', color: '#90a4ae' }).setDepth(92).setInteractive({ useHandCursor: true });
    this.menuBtn.on('pointerdown', function () { Sfx.play('cancel'); self.scene.start('menu'); });

    // 提示条
    this.tipText = this.add.text(w / 2, h - 22, '点击我方单位选择', { fontFamily: 'monospace', fontSize: '11px', color: '#b0bec5', backgroundColor: '#263238', padding: { x: 8, y: 4 } }).setOrigin(0.5).setDepth(91);

    // 胜利/失败遮罩
    this.overlay = this.add.graphics().setDepth(100).setVisible(false);
    this.overlay.fillStyle(0x000000, 0.62);
    this.overlay.fillRect(0, 0, w, h);
    this.centerText = this.add.text(w / 2, h / 2 - 20, '', { fontFamily: 'monospace', fontSize: '22px', color: '#ffffff', fontStyle: 'bold', align: 'center', stroke: '#000000', strokeThickness: 4 }).setOrigin(0.5).setDepth(101).setVisible(false);
    this.centerSub = this.add.text(w / 2, h / 2 + 24, '', { fontFamily: 'monospace', fontSize: '12px', color: '#b0bec5', align: 'center' }).setOrigin(0.5).setDepth(101).setVisible(false);

    // 输入
    this.input.on('pointerdown', function (pointer) {
      if (pointer.rightButtonDown && pointer.rightButtonDown()) { /* 右键取消在 pointerup 处理 */ }
      self.handleBoardClick(pointer);
    });
    // 右键取消
    this.input.on('pointerup', function (pointer) {
      if (pointer.rightButtonReleased && pointer.rightButtonReleased()) {
        if (self.phase === 'player' && !self.isAnimating) self.cancelSelection();
      }
    });
    this.input.keyboard.on('keydown-ESC', function () { if (self.phase === 'player' && !self.isAnimating) self.cancelSelection(); });
    this.input.keyboard.on('keydown-ENTER', function () { if (self.phase === 'player' && !self.isAnimating) self.endPlayerPhase(); });
    this.input.keyboard.on('keydown-SPACE', function () { if (self.phase === 'player' && !self.isAnimating) self.endPlayerPhase(); });

    // 初始 HUD
    this.updateHud();
    this.showTip('玩家回合：点击我方单位（深蓝描边为可行动）');
    Sfx.startBgm(this);
    this.updateHighlights();

    // 测试缝
    window.__trgame = window.__trgame || {};
    window.__trgame.game = window.__trgame.game || null;
  };

  BattleScene.prototype.drawBoard = function () {
    // 清理旧地形
    var kids = this.terrainLayer.getChildren();
    for (var i = kids.length - 1; i >= 0; i--) { try { kids[i].destroy(); } catch (e) {} }
    this.terrainLayer.clear(true, true);
    // 视觉替换点：地形色块可替换为瓦片贴图
    for (var y = 0; y < GRID_H; y++) {
      for (var x = 0; x < GRID_W; x++) {
        var k = this.board[y][x];
        var terr = TERRAIN_BY_KEY[k] || TERRAIN.plain;
        var px = this.ox + x * TILE;
        var py = this.oy + y * TILE;
        var g = this.add.graphics().setDepth(1);
        // 棋盘格底色
        g.fillStyle(terr.color, 1);
        g.fillRoundedRect(px + 0.5, py + 0.5, TILE - TILE_GAP, TILE - TILE_GAP, 4);
        // 内纹理（第二色小矩形模拟地形细节）
        if (k === 'F') {
          g.fillStyle(0x2e5a14, 0.9);
          g.fillCircle(px + TILE * 0.35, py + TILE * 0.5, 6);
          g.fillCircle(px + TILE * 0.65, py + TILE * 0.42, 7);
          g.fillCircle(px + TILE * 0.5, py + TILE * 0.68, 5);
        } else if (k === 'M') {
          g.fillStyle(0x5d4037, 0.95);
          g.fillTriangle(px + TILE * 0.5, py + 8, px + 8, py + TILE - 8, px + TILE - 8, py + TILE - 8);
          g.fillStyle(0xbcaaa4, 0.9);
          g.fillTriangle(px + TILE * 0.5, py + 12, px + 18, py + TILE - 12, px + TILE - 18, py + TILE - 12);
        } else if (k === 'W') {
          g.fillStyle(0x81d4fa, 0.85);
          // 波纹线
          g.lineStyle(1.5, 0xffffff, 0.45);
          g.strokeCircle(px + TILE * 0.3, py + TILE * 0.5, 4);
          g.strokeCircle(px + TILE * 0.7, py + TILE * 0.5, 5);
        }
        // 网格线
        g.lineStyle(1, 0x1a2332, 0.22);
        g.strokeRoundedRect(px + 0.5, py + 0.5, TILE - TILE_GAP, TILE - TILE_GAP, 4);
        this.terrainLayer.add(g);
      }
    }
    // 外框
    var ob = this.add.graphics().setDepth(2);
    ob.lineStyle(2, 0x90a4ae, 0.9);
    ob.strokeRoundedRect(this.ox - 2, this.oy - 2, GRID_W * TILE + 4, GRID_H * TILE + 4, 8);
    this.terrainLayer.add(ob);
  };

  BattleScene.prototype.createUnitSprite = function (u) {
    var px = this.ox + u.x * TILE + TILE / 2;
    var py = this.oy + u.y * TILE + TILE / 2;
    var key = 'u_' + u.cls;
    var spr = this.add.image(px, py, key).setDepth(10).setScale(1);
    // 敌方加红描边区分
    if (u.team === 'enemy') {
      spr.setTint(0xffcccc);
    }
    u.sprite = spr;
    // 血条背景
    var barW = 28, barH = 4;
    var bg = this.add.graphics().setDepth(11);
    bg.fillStyle(0x000000, 0.72);
    bg.fillRoundedRect(px - barW / 2, py + 14, barW, barH, 2);
    u.hpBg = bg;
    var fg = this.add.graphics().setDepth(12);
    u.hpBar = fg;
    this.refreshHpBar(u);
    // 名字小标签
    var cd = CLASS_DATA[u.cls];
    var lbl = this.add.text(px, py - 18, cd.name, { fontFamily: 'monospace', fontSize: '7px', color: u.team === 'player' ? '#e3f2fd' : '#ffcdd2', backgroundColor: u.team === 'player' ? '#1e3a5f' : '#4a1a1a', padding: { x: 3, y: 1 } }).setOrigin(0.5).setDepth(11);
    // 飞行单位角标
    if (cd.flying) {
      var fly = this.add.text(px + 12, py - 12, '飞', { fontFamily: 'monospace', fontSize: '7px', color: '#ffffff', backgroundColor: '#7b1fa2', padding: { x: 2, y: 1 } }).setOrigin(0.5).setDepth(12);
      u.flyTag = fly;
    }
    u.label = lbl;
    // 已行动灰化标记（初始不灰）
    this.refreshUnitVisual(u);
  };

  BattleScene.prototype.refreshHpBar = function (u) {
    if (!u.hpBar) return;
    var barW = 28, barH = 4;
    var px = this.ox + u.x * TILE + TILE / 2;
    var py = this.oy + u.y * TILE + TILE / 2;
    u.hpBar.clear();
    if (!u.alive) { u.hpBar.setVisible(false); return; }
    u.hpBar.setVisible(true);
    var ratio = clamp(u.hp / u.maxHp, 0, 1);
    var fillW = Math.floor(barW * ratio);
    var col = ratio > 0.5 ? 0x66bb6a : ratio > 0.25 ? 0xffca28 : 0xef5350;
    u.hpBar.fillStyle(col, 1);
    u.hpBar.fillRoundedRect(px - barW / 2, py + 14, fillW, barH, 2);
    // 边框
    u.hpBar.lineStyle(1, 0xffffff, 0.35);
    u.hpBar.strokeRoundedRect(px - barW / 2, py + 14, barW, barH, 2);
    // 数值
    if (u.label) {
      // 标签不动，仅血条变
    }
  };

  BattleScene.prototype.refreshUnitVisual = function (u) {
    if (!u.sprite) return;
    var posX = this.ox + u.x * TILE + TILE / 2;
    var posY = this.oy + u.y * TILE + TILE / 2;
    u.sprite.setPosition(posX, posY);
    if (u.hpBg) {
      var barW = 28;
      u.hpBg.clear();
      if (u.alive) {
        u.hpBg.fillStyle(0x000000, 0.72);
        u.hpBg.fillRoundedRect(posX - barW / 2, posY + 14, barW, 4, 2);
        u.hpBg.setVisible(true);
      } else {
        u.hpBg.setVisible(false);
      }
    }
    this.refreshHpBar(u);
    if (u.label) {
      u.label.setPosition(posX, posY - 18);
      u.label.setVisible(!!u.alive);
    }
    if (u.flyTag) { u.flyTag.setPosition(posX + 12, posY - 12); u.flyTag.setVisible(!!u.alive); }
    // 已行动：半透明+灰
    if (u.team === 'player' && u.acted && u.alive) {
      u.sprite.setAlpha(0.55);
      u.sprite.setTint(0x90a4ae);
    } else if (u.alive) {
      u.sprite.setAlpha(1);
      if (u.team === 'enemy') u.sprite.setTint(0xffcccc);
      else u.sprite.clearTint();
    }
    // 选中高亮：外发光由 highlight 层绘制
  };

  BattleScene.prototype.gridFromPointer = function (pointer) {
    var x = Math.floor((pointer.x - this.ox) / TILE);
    var y = Math.floor((pointer.y - this.oy) / TILE);
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return null;
    return { x: x, y: y };
  };

  BattleScene.prototype.unitAt = function (x, y) {
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i];
      if (!u.alive) continue;
      if (u.x === x && u.y === y) return u;
    }
    return null;
  };

  BattleScene.prototype.updateHud = function () {
    var ch = this.chapter;
    this.hudText.setText(ch.name + '  Turn ' + this.turnCount);
    this.hudSub.setText(ch.desc);
    var pAlive = 0, eAlive = 0;
    for (var i = 0; i < this.units.length; i++) {
      if (!this.units[i].alive) continue;
      if (this.units[i].team === 'player') pAlive++; else eAlive++;
    }
    this.turnText.setText('我方 ' + pAlive + '  敌方 ' + eAlive);
    this.phaseText.setText(this.phase === 'player' ? '▶ 玩家阶段' : this.phase === 'enemy' ? '▼ 敌方阶段' : '— 结束 —');
  };

  BattleScene.prototype.showTip = function (msg) {
    this.tipText.setText(msg);
  };

  BattleScene.prototype.updateHighlights = function () {
    var g = this.highlightLayer;
    g.clear();
    if (this.phase !== 'player') return;
    // 可行动单位微发光
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i];
      if (!u.alive || u.team !== 'player' || u.acted) continue;
      var px = this.ox + u.x * TILE + 1;
      var py = this.oy + u.y * TILE + 1;
      g.lineStyle(2, 0x42a5f5, 0.95);
      g.strokeRoundedRect(px, py, TILE - 2, TILE - 2, 6);
    }
    // 选中单位
    if (this.selected && this.selected.alive) {
      var sx = this.ox + this.selected.x * TILE + 1;
      var sy = this.oy + this.selected.y * TILE + 1;
      g.lineStyle(3, 0xffee58, 1);
      g.strokeRoundedRect(sx, sy, TILE - 2, TILE - 2, 6);
      // 可移动格
      if (this.reachable) {
        var keys = Object.keys(this.reachable);
        for (var k = 0; k < keys.length; k++) {
          var parts = keys[k].split(',');
          var rx = parseInt(parts[0], 10), ry = parseInt(parts[1], 10);
          var occ = this.unitAt(rx, ry);
          // 起点本身不画填充
          if (rx === this.selected.x && ry === this.selected.y) continue;
          // 若有敌方占据，不算可移动（但可以显示攻击范围）
          if (occ && occ.team === 'enemy') continue;
          var px2 = this.ox + rx * TILE;
          var py2 = this.oy + ry * TILE;
          g.fillStyle(0x42a5f5, 0.28);
          g.fillRoundedRect(px2 + 2, py2 + 2, TILE - 4, TILE - 4, 4);
          g.lineStyle(1, 0x90caf9, 0.7);
          g.strokeRoundedRect(px2 + 2, py2 + 2, TILE - 4, TILE - 4, 4);
        }
      }
      // 可攻击目标红框（含移动后可攻击的格子需额外计算）
      var atkList = this.getAttackableFrom(this.selected, this.selected.x, this.selected.y);
      // 若已选移动预览位，则基于预览位算
      var preview = this._movePreview;
      if (preview) atkList = this.getAttackableFrom(this.selected, preview.x, preview.y);
      for (var a = 0; a < atkList.length; a++) {
        var en = atkList[a];
        var ex = this.ox + en.x * TILE + 1;
        var ey = this.oy + en.y * TILE + 1;
        g.lineStyle(3, 0xef5350, 1);
        g.strokeRoundedRect(ex, ey, TILE - 2, TILE - 2, 4);
        // 内斜线
        g.lineStyle(1, 0xef5350, 0.35);
        g.lineBetween(ex + 4, ey + 4, ex + TILE - 6, ey + TILE - 6);
        g.lineBetween(ex + TILE - 6, ey + 4, ex + 4, ey + TILE - 6);
      }
      // 单独标出当前预选移动格
      if (preview) {
        g.lineStyle(3, 0xffee58, 1);
        g.strokeRoundedRect(this.ox + preview.x * TILE + 1, this.oy + preview.y * TILE + 1, TILE - 2, TILE - 2, 6);
      }
    }
    // 待攻击选择：闪烁由 tween 外部处理，这里已画红框
  };

  BattleScene.prototype.getAttackableFrom = function (attacker, ax, ay) {
    var out = [];
    var fake = { x: ax, y: ay, cls: attacker.cls };
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i];
      if (!u.alive || u.team === attacker.team) continue;
      if (inRange(fake, u)) out.push(u);
    }
    return out;
  };

  BattleScene.prototype.handleBoardClick = function (pointer) {
    if (this.phase !== 'player' || this.isAnimating) return;
    var g = this.gridFromPointer(pointer);
    if (!g) return;
    var clickedUnit = this.unitAt(g.x, g.y);

    // 若正等待攻击选择：只响应敌方目标或取消
    if (this.awaitAttackChoice) {
      if (clickedUnit && clickedUnit.team === 'enemy') {
        // 检查是否在可攻击列表
        var ok = false;
        for (var ai = 0; ai < this.attackTargets.length; ai++) if (this.attackTargets[ai] === clickedUnit) { ok = true; break; }
        if (ok) {
          this.executeCombat(this.selected, clickedUnit);
          return;
        }
      }
      // 点空白=放弃攻击直接待机
      if (!clickedUnit || clickedUnit.team !== 'enemy') {
        this.finishUnitTurn();
        return;
      }
      return;
    }

    // 已选中且点可移动格 → 移动
    if (this.selected && this.reachable) {
      var key = g.x + ',' + g.y;
      var isReachable = this.reachable.hasOwnProperty(key);
      var occ = this.unitAt(g.x, g.y);
      // 敌方格不可移动进入
      if (occ && occ.team === 'enemy') isReachable = false;
      // 点到自己的攻击目标？先处理移动再处理攻击
      if (isReachable) {
        // 若点的是另一我方单位格子，不移动
        if (occ && occ.team === 'player' && occ !== this.selected) {
          // 切换选中
          if (!occ.acted) this.selectUnit(occ);
          return;
        }
        this.moveSelectedTo(g.x, g.y);
        return;
      }
      // 点到可攻击敌但不在移动范围：若已在攻击范围内直接攻击（不移动）
      if (clickedUnit && clickedUnit.team === 'enemy') {
        var atkList = this.getAttackableFrom(this.selected, this.selected.x, this.selected.y);
        for (var ci = 0; ci < atkList.length; ci++) if (atkList[ci] === clickedUnit) {
          this.executeCombat(this.selected, clickedUnit);
          return;
        }
      }
    }

    // 未选中或点其他：选中逻辑
    if (clickedUnit) {
      if (clickedUnit.team === 'player') {
        if (clickedUnit.acted) {
          this.showTip(clickedUnit.cls + ' 已待机');
          Sfx.play('cancel');
          return;
        }
        this.selectUnit(clickedUnit);
      } else if (clickedUnit.team === 'enemy') {
        // 显示敌情报
        var terr = TERRAIN_BY_KEY[this.board[g.y][g.x]] || TERRAIN.plain;
        var cd2 = CLASS_DATA[clickedUnit.cls];
        this.showTip('敌 ' + cd2.name + ' HP ' + clickedUnit.hp + '/' + clickedUnit.maxHp + '  ' + terr.name + ' 防+' + terr.def + ' 避+' + terr.avo);
        // 高亮该敌的攻击范围预览（可选）
      }
    } else {
      // 点空白：若有选中则只是更新预览，不取消（右键才取消）
      if (this.selected && this.reachable) {
        // 点击空白但不在可达内，提示
        // 不自动取消，保留选择
      }
    }
  };

  BattleScene.prototype.selectUnit = function (u) {
    this.selected = u;
    this._movePreview = null;
    this.awaitAttackChoice = false;
    this.attackTargets = [];
    // BFS 计算可移动
    this.reachable = bfsReachable(u.x, u.y, u.mov, this.board, this.units, 'player');
    Sfx.play('select');
    var cd = CLASS_DATA[u.cls];
    var terr = TERRAIN_BY_KEY[this.board[u.y][u.x]] || TERRAIN.plain;
    this.showTip(cd.name + ' 移动力' + u.mov + ' 射程' + cd.range[0] + '-' + cd.range[1] + '  地形' + terr.name + ' — 蓝格移动，红框为可攻击');
    this.updateHighlights();
  };

  BattleScene.prototype.cancelSelection = function () {
    if (!this.selected) return;
    Sfx.play('cancel');
    this.selected = null;
    this.reachable = null;
    this.attackTargets = [];
    this.awaitAttackChoice = false;
    this._movePreview = null;
    this.showTip('已取消选择');
    this.updateHighlights();
  };

  BattleScene.prototype.moveSelectedTo = function (nx, ny) {
    if (!this.selected) return;
    var u = this.selected;
    if (u.x === nx && u.y === ny) {
      // 原地：直接进入攻击抉择
      this.promptAttackOrWait();
      return;
    }
    this.isAnimating = true;
    Sfx.play('move');
    var self = this;
    var sx = this.ox + u.x * TILE + TILE / 2;
    var sy = this.oy + u.y * TILE + TILE / 2;
    var ex = this.ox + nx * TILE + TILE / 2;
    var ey = this.oy + ny * TILE + TILE / 2;
    // 临时用 tween 移动精灵
    this.tweens.add({
      targets: u.sprite,
      x: ex, y: ey,
      duration: 180,
      ease: 'Quad.easeOut',
      onComplete: function () {
        // 更新逻辑坐标
        u.x = nx; u.y = ny;
        self.refreshUnitVisual(u);
        self.isAnimating = false;
        self.reachable = null;
        self._movePreview = { x: nx, y: ny };
        self.promptAttackOrWait();
      }
    });
    // 血条/标签跟随用 update 钩子补一次，这里先隐藏避免拖影，下帧再刷新
    // 简化：不做平滑跟随，移动结束统一刷新
    // 期间保持 reachable 高亮，移动时淡化
    this.highlightLayer.clear();
  };

  BattleScene.prototype.promptAttackOrWait = function () {
    var u = this.selected;
    if (!u || !u.alive) { this.finishUnitTurn(); return; }
    var list = this.getAttackableFrom(u, u.x, u.y);
    this.attackTargets = list;
    if (list.length > 0) {
      this.awaitAttackChoice = true;
      this.showTip('选择红框敌方攻击，或点击空白待机');
      Sfx.play('select');
      this.updateHighlights();
    } else {
      // 无可攻击，直接待机
      this.finishUnitTurn();
    }
  };

  BattleScene.prototype.finishUnitTurn = function () {
    if (this.selected) {
      this.selected.acted = true;
      this.refreshUnitVisual(this.selected);
    }
    this.selected = null;
    this.reachable = null;
    this.attackTargets = [];
    this.awaitAttackChoice = false;
    this._movePreview = null;
    this.updateHighlights();
    this.updateHud();
    if (this.checkGameOver()) return;
    // 检查是否全部待机
    var any = false;
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i];
      if (u.alive && u.team === 'player' && !u.acted) { any = true; break; }
    }
    if (!any) {
      this.showTip('我方全部待机，自动进入敌方回合');
      var self = this;
      this.time.delayedCall(500, function () { self.endPlayerPhase(); });
    } else {
      this.showTip('继续选择下一个可行动单位');
    }
  };

  BattleScene.prototype.endPlayerPhase = function () {
    if (this.phase !== 'player') return;
    // 未行动单位自动待机
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i];
      if (u.alive && u.team === 'player') u.acted = true;
    }
    this.selected = null; this.reachable = null; this.attackTargets = []; this.awaitAttackChoice = false;
    this.updateHighlights();
    for (var j = 0; j < this.units.length; j++) this.refreshUnitVisual(this.units[j]);
    this.phase = 'enemy';
    this.updateHud();
    this.showTip('敌方回合思考中…');
    var self = this;
    this.time.delayedCall(400, function () { self.runEnemyPhase(); });
  };

  BattleScene.prototype.runEnemyPhase = function () {
    if (this.phase !== 'enemy') return;
    var enemies = [];
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i];
      if (u.alive && u.team === 'enemy') enemies.push(u);
    }
    var self = this;
    var idx = 0;
    function nextEnemy() {
      if (self.phase === 'gameover') return;
      if (idx >= enemies.length) {
        // 敌回合结束，切回玩家回合
        self.startPlayerTurn();
        return;
      }
      var en = enemies[idx++];
      if (!en.alive) { nextEnemy(); return; }
      var plan = enemyFindMove(en, self.board, self.units);
      var dest = plan && plan.move ? plan.move : null;
      // 若无可动位则跳过
      if (!dest || (dest.x === en.x && dest.y === en.y)) {
        // 原地看能否攻击
        var atkList = self.getAttackableFrom(en, en.x, en.y);
        if (atkList.length > 0) {
          // 选 HP 最低的
          var tgt = atkList[0];
          for (var k = 1; k < atkList.length; k++) if (atkList[k].hp < tgt.hp) tgt = atkList[k];
          self.executeCombat(en, tgt, nextEnemy);
          return;
        }
        self.time.delayedCall(220, nextEnemy);
        return;
      }
      // 移动动画
      self.isAnimating = true;
      Sfx.play('move');
      var ex = self.ox + dest.x * TILE + TILE / 2;
      var ey = self.oy + dest.y * TILE + TILE / 2;
      self.tweens.add({
        targets: en.sprite,
        x: ex, y: ey,
        duration: 200,
        ease: 'Quad.easeOut',
        onComplete: function () {
          en.x = dest.x; en.y = dest.y;
          self.refreshUnitVisual(en);
          self.isAnimating = false;
          if (self.checkGameOver()) return;
          // 移动后尝试攻击
          var atkList2 = self.getAttackableFrom(en, en.x, en.y);
          if (atkList2.length > 0) {
            var tgt2 = atkList2[0];
            for (var k2 = 1; k2 < atkList2.length; k2++) if (atkList2[k2].hp < tgt2.hp) tgt2 = atkList2[k2];
            self.executeCombat(en, tgt2, nextEnemy);
          } else {
            self.time.delayedCall(280, nextEnemy);
          }
        }
      });
    }
    nextEnemy();
  };

  BattleScene.prototype.startPlayerTurn = function () {
    if (this.checkGameOver()) return;
    this.turnCount++;
    this.phase = 'player';
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i];
      if (u.alive && u.team === 'player') u.acted = false;
    }
    for (var j = 0; j < this.units.length; j++) this.refreshUnitVisual(this.units[j]);
    this.updateHud();
    this.updateHighlights();
    this.showTip('玩家回合 Turn ' + this.turnCount + '：选择单位行动');
  };

  // 战斗演出 — 双方对砍数值弹出，弹道几何，死亡移除
  BattleScene.prototype.executeCombat = function (attacker, defender, onDone) {
    var self = this;
    // 若任一已死则跳过
    if (!attacker.alive || !defender.alive) { if (onDone) onDone(); return; }
    this.isAnimating = true;
    this.awaitAttackChoice = false;
    Sfx.play('attack');
    // 计算攻方命中伤害
    var atkInfo = computeCombat(attacker, defender, this.board);
    var hitRoll = Math.random() * 100;
    var isHit = hitRoll < atkInfo.hit;
    var dmg = isHit ? atkInfo.dmg : 0;

    // 弹道：弓/法师为投射物，近战为突进抖动
    var atkCd = CLASS_DATA[attacker.cls];
    var isRanged = atkCd.range[0] >= 2;
    var aSpr = attacker.sprite;
    var dSpr = defender.sprite;
    var ax = this.ox + attacker.x * TILE + TILE / 2;
    var ay = this.oy + attacker.y * TILE + TILE / 2;
    var dx = this.ox + defender.x * TILE + TILE / 2;
    var dy = this.oy + defender.y * TILE + TILE / 2;

    var doHitFx = function (cb) {
      if (!isHit) {
        self.spawnDamageNumber(dx, dy - 10, 'MISS', '#90a4ae');
        Sfx.play('cancel');
        if (cb) cb();
        return;
      }
      // 命中闪白 + 震动
      try { dSpr.setTint(0xffffff); } catch (e) {}
      self.tweens.add({ targets: dSpr, x: dx + 3, duration: 40, yoyo: true, repeat: 2, onComplete: function () {
        try { dSpr.clearTint(); if (defender.team === 'enemy') dSpr.setTint(0xffcccc); } catch (e2) {}
        dSpr.setPosition(dx, dy);
      }});
      defender.hp -= dmg;
      if (defender.hp < 0) defender.hp = 0;
      self.refreshHpBar(defender);
      self.spawnDamageNumber(dx, dy - 10, '-' + dmg, '#ff5252');
      Sfx.play('hit');
      // 克制/地形小字
      var extra = '';
      if (atkInfo.adv) extra = '克制!';
      else if (atkInfo.dis) extra = '被克制';
      if (extra) self.spawnDamageNumber(dx, dy - 28, extra, atkInfo.adv ? '#ffd54f' : '#90a4ae');
      // 死亡
      if (defender.hp <= 0) {
        defender.alive = false;
        self.time.delayedCall(220, function () {
          Sfx.play('death');
          self.tweens.add({ targets: dSpr, alpha: 0, scale: 1.4, duration: 300, onComplete: function () {
            dSpr.setVisible(false);
            if (defender.hpBg) defender.hpBg.setVisible(false);
            if (defender.hpBar) defender.hpBar.setVisible(false);
            if (defender.label) defender.label.setVisible(false);
            if (defender.flyTag) defender.flyTag.setVisible(false);
            self.spawnDamageNumber(dx, dy - 6, '击破', '#ffab40');
            if (cb) cb();
          }});
        });
      } else {
        if (cb) self.time.delayedCall(280, cb);
      }
    };

    var afterAttackerStrike = function () {
      // 若防守方存活且处于射程内则反击一次（近战互砍，弓不反击近战？简化：距离满足就反击）
      if (!defender.alive) { finishBout(); return; }
      var canCounter = inRange(defender, attacker);
      if (!canCounter) { finishBout(); return; }
      // 反击
      self.time.delayedCall(280, function () {
        if (!defender.alive || !attacker.alive) { finishBout(); return; }
        var counterInfo = computeCombat(defender, attacker, self.board);
        var cRoll = Math.random() * 100;
        var cHit = cRoll < counterInfo.hit;
        var cDmg = cHit ? counterInfo.dmg : 0;
        Sfx.play('attack');
        // 弹道或抖动
        if (CLASS_DATA[defender.cls].range[0] >= 2) {
          self.fireProjectile(dx, dy, ax, ay, function () {
            if (!cHit) {
              self.spawnDamageNumber(ax, ay - 10, 'MISS', '#90a4ae');
              Sfx.play('cancel');
              finishBout();
              return;
            }
            try { aSpr.setTint(0xffffff); } catch (e) {}
            self.tweens.add({ targets: aSpr, x: ax + 3, duration: 40, yoyo: true, repeat: 2, onComplete: function () {
              try { aSpr.clearTint(); if (attacker.team === 'enemy') aSpr.setTint(0xffcccc); } catch (e2) {}
              aSpr.setPosition(ax, ay);
            }});
            attacker.hp -= cDmg;
            if (attacker.hp < 0) attacker.hp = 0;
            self.refreshHpBar(attacker);
            self.spawnDamageNumber(ax, ay - 10, '-' + cDmg, '#ff5252');
            Sfx.play('hit');
            if (attacker.hp <= 0) {
              attacker.alive = false;
              self.time.delayedCall(220, function () {
                Sfx.play('death');
                self.tweens.add({ targets: aSpr, alpha: 0, scale: 1.4, duration: 300, onComplete: function () {
                  aSpr.setVisible(false);
                  if (attacker.hpBg) attacker.hpBg.setVisible(false);
                  if (attacker.hpBar) attacker.hpBar.setVisible(false);
                  if (attacker.label) attacker.label.setVisible(false);
                  if (attacker.flyTag) attacker.flyTag.setVisible(false);
                  self.spawnDamageNumber(ax, ay - 6, '击破', '#ffab40');
                  finishBout();
                }});
              });
            } else {
              self.time.delayedCall(280, finishBout);
            }
          });
        } else {
          // 近战抖动
          self.tweens.add({ targets: dSpr, x: dx + 6, duration: 70, yoyo: true, repeat: 1 });
          self.time.delayedCall(120, function () {
            if (!cHit) {
              self.spawnDamageNumber(ax, ay - 10, 'MISS', '#90a4ae');
              Sfx.play('cancel');
              finishBout();
              return;
            }
            try { aSpr.setTint(0xffffff); } catch (e3) {}
            self.tweens.add({ targets: aSpr, x: ax + 3, duration: 40, yoyo: true, repeat: 2, onComplete: function () {
              try { aSpr.clearTint(); if (attacker.team === 'enemy') aSpr.setTint(0xffcccc); } catch (e4) {}
              aSpr.setPosition(ax, ay);
            }});
            attacker.hp -= cDmg;
            if (attacker.hp < 0) attacker.hp = 0;
            self.refreshHpBar(attacker);
            self.spawnDamageNumber(ax, ay - 10, '-' + cDmg, '#ff5252');
            Sfx.play('hit');
            if (counterInfo.adv) self.spawnDamageNumber(ax, ay - 28, '克制!', '#ffd54f');
            if (attacker.hp <= 0) {
              attacker.alive = false;
              self.time.delayedCall(220, function () {
                Sfx.play('death');
                self.tweens.add({ targets: aSpr, alpha: 0, scale: 1.4, duration: 300, onComplete: function () {
                  aSpr.setVisible(false);
                  if (attacker.hpBg) attacker.hpBg.setVisible(false);
                  if (attacker.hpBar) attacker.hpBar.setVisible(false);
                  if (attacker.label) attacker.label.setVisible(false);
                  if (attacker.flyTag) attacker.flyTag.setVisible(false);
                  self.spawnDamageNumber(ax, ay - 6, '击破', '#ffab40');
                  finishBout();
                }});
              });
            } else {
              self.time.delayedCall(280, finishBout);
            }
          });
        }
      });
    };

    var finishBout = function () {
      self.isAnimating = false;
      // 若是玩家发起的战斗，结束该单位回合
      if (attacker.team === 'player') {
        attacker.acted = true;
        self.refreshUnitVisual(attacker);
        self.selected = null; self.reachable = null; self.attackTargets = []; self._movePreview = null;
        self.updateHighlights();
        self.updateHud();
        if (self.checkGameOver()) { if (onDone) onDone(); return; }
        // 检查是否全部待机
        var any = false;
        for (var i = 0; i < self.units.length; i++) {
          var uu = self.units[i];
          if (uu.alive && uu.team === 'player' && !uu.acted) { any = true; break; }
        }
        if (!any) {
          self.showTip('我方回合结束');
          self.time.delayedCall(500, function () { self.endPlayerPhase(); });
        } else {
          self.showTip('战斗结束，继续行动');
        }
      } else {
        // 敌方发起
        self.updateHud();
        if (self.checkGameOver()) { if (onDone) onDone(); return; }
      }
      if (onDone && attacker.team === 'enemy') onDone();
    };

    // 发起弹道
    if (isRanged) {
      this.fireProjectile(ax, ay, dx, dy, function () { doHitFx(afterAttackerStrike); });
    } else {
      // 近战突进
      this.tweens.add({ targets: aSpr, x: ax + (dx > ax ? 8 : dx < ax ? -8 : 0), y: ay + (dy > ay ? 8 : dy < ay ? -8 : 0), duration: 90, yoyo: true, repeat: 0, onComplete: function () {
        aSpr.setPosition(ax, ay);
        doHitFx(afterAttackerStrike);
      }});
    }
  };

  BattleScene.prototype.fireProjectile = function (sx, sy, ex, ey, cb) {
    var pool = this.projPool.getChildren();
    var proj = null;
    for (var i = 0; i < pool.length; i++) if (!pool[i].visible) { proj = pool[i]; break; }
    if (!proj) { proj = this.add.image(sx, sy, 'proj').setDepth(40); this.projPool.add(proj); }
    proj.setPosition(sx, sy).setVisible(true).setAlpha(1).setScale(1);
    var self = this;
    this.tweens.add({
      targets: proj,
      x: ex, y: ey,
      duration: 180,
      ease: 'Quad.easeOut',
      onComplete: function () {
        // 命中炸开小星
        proj.setVisible(false);
        for (var k = 0; k < 4; k++) {
          var star = self.add.image(ex, ey, 'star').setDepth(41).setScale(0.6);
          self.tweens.add({ targets: star, x: ex + (Math.random() - 0.5) * 28, y: ey + (Math.random() - 0.5) * 28, alpha: 0, scale: 0.2, duration: 280, onComplete: function () { star.destroy(); } });
        }
        if (cb) cb();
      }
    });
  };

  BattleScene.prototype.spawnDamageNumber = function (x, y, text, color) {
    var t = this.dmgPool[this.dmgIdx % this.dmgPool.length];
    this.dmgIdx++;
    t.setText(text);
    t.setColor(color);
    t.setPosition(x, y);
    t.setVisible(true);
    t.setAlpha(1);
    t.setScale(1);
    var self = this;
    this.tweens.add({ targets: t, y: y - 28, alpha: 0, duration: 700, ease: 'Quad.easeOut', onComplete: function () { t.setVisible(false); } });
  };

  BattleScene.prototype.checkGameOver = function () {
    var pAlive = 0, eAlive = 0;
    for (var i = 0; i < this.units.length; i++) {
      if (!this.units[i].alive) continue;
      if (this.units[i].team === 'player') pAlive++; else eAlive++;
    }
    if (eAlive === 0) {
      this.onVictory();
      return true;
    }
    if (pAlive === 0) {
      this.onDefeat();
      return true;
    }
    return false;
  };

  BattleScene.prototype.onVictory = function () {
    this.phase = 'gameover';
    this.isAnimating = false;
    this.selected = null; this.reachable = null;
    this.updateHighlights();
    Sfx.play('victory');
    // 存档：clearedChapter = max
    if (this.chapterId > saveData.clearedChapter) {
      saveData.clearedChapter = this.chapterId;
      if (hostRef && typeof hostRef.saveState === 'function') {
        try { hostRef.saveState({ clearedChapter: saveData.clearedChapter }); } catch (e) {}
      }
    }
    var w = this.scale.width, h = this.scale.height;
    this.overlay.setVisible(true);
    this.centerText.setText('胜利！').setVisible(true);
    this.centerSub.setText(this.chapter.name + ' 通关\n点击返回菜单  ·  已解锁 ' + saveData.clearedChapter + '/' + CHAPTERS.length + ' 章').setVisible(true);
    // 交互返回菜单
    var self = this;
    this.input.once('pointerdown', function () { self.scene.start('menu'); });
    this.input.keyboard.once('keydown-SPACE', function () { self.scene.start('menu'); });
    this.input.keyboard.once('keydown-ENTER', function () { self.scene.start('menu'); });
    Sfx.stopBgm();
  };

  BattleScene.prototype.onDefeat = function () {
    this.phase = 'gameover';
    this.isAnimating = false;
    Sfx.play('death');
    this.overlay.setVisible(true);
    this.centerText.setText('败北…').setColor('#ff8a80').setVisible(true);
    this.centerSub.setText('我方全灭\n点击重试  ·  按 R 重开本章').setVisible(true);
    var self = this;
    function retry() { self.scene.restart({ chapter: self.chapterId }); }
    this.input.once('pointerdown', retry);
    this.input.keyboard.once('keydown-SPACE', retry);
    this.input.keyboard.once('keydown-ENTER', retry);
    this.input.keyboard.once('keydown-R', retry);
    Sfx.stopBgm();
  };

  BattleScene.prototype.update = function () {
    // 血条/标签跟随（移动 tween 期间位置已由 tween 驱动，这里每帧校正）
    if (!this.units) return;
    for (var i = 0; i < this.units.length; i++) {
      var u = this.units[i];
      if (!u.alive || !u.sprite) continue;
      // 若正在 tween，则跟随精灵位置同步血条
      var px = u.sprite.x;
      var py = u.sprite.y;
      // 推导格子坐标应等于 sprite 位置，但 tween 期间渐变，这里用 sprite 实际位置画血条
      // 用临时覆盖：在 refresh 时已按逻辑格画过，tween 期间短暂偏移也可接受，不每帧重绘 Graphics（开销）
    }
  };

  // ---------------------------------------------------------------------------
  // 启动 — IIFE 注册
  // ---------------------------------------------------------------------------
  function launch(host) {
    hostRef = host;
    var Phaser = host.phaser;
    if (!Phaser) throw new Error('Phaser not loaded');
    var W = host.width || 960;
    var H = host.height || 540;

    // 暴露旧 save 兼容：若 host 无 loadState，用 localStorage 兜底（不影响主流程）
    var config = {
      type: Phaser.AUTO,
      parent: host.container,
      width: W,
      height: H,
      backgroundColor: '#0d1b2a',
      physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: [BootScene, MenuScene, BattleScene]
    };
    var game = new Phaser.Game(config);
    // 测试缝 — 供 node --check 之后与 CDP 验证使用
    window.__trgame = { game: game, getState: getState, _save: function () { return saveData; } };
    return game;
  }

  if (typeof window.TRGames !== 'undefined' && typeof window.TRGames.register === 'function') {
    window.TRGames.register({ id: 'srpg-fe', title: '火焰纹章 SRPG', launch: launch });
  }
})();
