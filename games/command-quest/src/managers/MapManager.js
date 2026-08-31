// CQ.MapManager — 单地图随机生成（墙/宝箱/商店/NPC/敌人出生点）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.MapManager = function (scene, rng) {
    this.scene = scene; this.rng = rng;
    this.cols = CQ.CFG.GRID_COLS; this.rows = CQ.CFG.GRID_ROWS;
    this.walls = {}; // key -> true
    this.chests = []; this.shops = []; this.npcs = [];
    this.playerSpawns = []; this.enemySpawns = [];
  };
  CQ.MapManager.prototype.generate = function () {
    var rng = this.rng, cols = this.cols, rows = this.rows;
    // 随机墙（~12%）
    for (var c = 0; c < cols; c++) for (var r = 0; r < rows; r++) {
      if (c < 2 && r < 2) continue; // 玩家出生区不放墙
      if (rng.next() < 0.12) this.walls[c + ',' + r] = true;
    }
    // 玩家出生（左上 2x2）
    this.playerSpawns = [{ c: 0, r: 0 }, { c: 1, r: 0 }, { c: 0, r: 1 }];
    // 敌人出生（右下/右侧带）
    this.enemySpawns = [{ c: cols - 1, r: rows - 1 }, { c: cols - 2, r: rows - 1 }, { c: cols - 1, r: rows - 2 }];
    // 宝箱 4~6
    var nChest = rng.int(CQ.CFG.CHEST_MIN, CQ.CFG.CHEST_MAX);
    this.chests = this._placeEntities(nChest, function (scene, c, r) { return new CQ.Chest(scene, c, r, rng); });
    // 商店 2
    this.shops = this._placeEntities(CQ.CFG.SHOP_COUNT, function (scene, c, r) { return new CQ.Shop(scene, c, r, rng); });
    // NPC 2~4
    var nNpc = rng.int(CQ.CFG.NPC_MIN, CQ.CFG.NPC_MAX);
    this.npcs = this._placeEntities(nNpc, function (scene, c, r) { return new CQ.Npc(scene, c, r, rng); });
  };
  CQ.MapManager.prototype._placeEntities = function (n, factory) {
    var out = [], tries = 0;
    while (out.length < n && tries < 200) {
      tries++;
      var c = this.rng.int(0, this.cols - 1), r = this.rng.int(0, this.rows - 1);
      var key = c + ',' + r;
      if (this.walls[key]) continue;
      var occupied = false;
      for (var i = 0; i < out.length; i++) if (out[i].c === c && out[i].r === r) occupied = true;
      for (var j = 0; j < this.chests.length; j++) if (this.chests[j].c === c && this.chests[j].r === r) occupied = true;
      for (var k = 0; k < this.shops.length; k++) if (this.shops[k].c === c && this.shops[k].r === r) occupied = true;
      for (var l = 0; l < this.npcs.length; l++) if (this.npcs[l].c === c && this.npcs[l].r === r) occupied = true;
      if (occupied) continue;
      // 避开玩家出生点
      var nearSpawn = false;
      for (var s = 0; s < this.playerSpawns.length; s++) if (this.playerSpawns[s].c === c && this.playerSpawns[s].r === r) nearSpawn = true;
      if (nearSpawn) continue;
      out.push(factory(this.scene, c, r));
    }
    return out;
  };
  CQ.MapManager.prototype.isBlocked = function (c, r) {
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return true;
    if (this.walls[c + ',' + r]) return true;
    return false;
  };
  CQ.MapManager.prototype.draw = function () {
    var g = this.scene.grid;
    var gfx = this.scene.add.graphics();
    // 底色
    gfx.fillStyle(CQ.COLORS.WALL, 1);
    for (var key in this.walls) { var parts = key.split(','); var cc = parseInt(parts[0], 10), rr = parseInt(parts[1], 10); var p = g.cellToWorld(cc, rr); gfx.fillRect(p.x - g.tile / 2 + 1, p.y - g.tile / 2 + 1, g.tile - 2, g.tile - 2); }
    // 网格线
    gfx.lineStyle(1, CQ.COLORS.GRID, 0.9);
    for (var c = 0; c <= this.cols; c++) { var x = g.ox + c * g.tile; gfx.moveTo(x, g.oy); gfx.lineTo(x, g.oy + this.rows * g.tile); }
    for (var r = 0; r <= this.rows; r++) { var y = g.oy + r * g.tile; gfx.moveTo(g.ox, y); gfx.lineTo(g.ox + this.cols * g.tile, y); }
    gfx.strokePath();
    // 实体 GO
    for (var i = 0; i < this.chests.length; i++) this.chests[i].createGO();
    for (var j = 0; j < this.shops.length; j++) this.shops[j].createGO();
    for (var k = 0; k < this.npcs.length; k++) this.npcs[k].createGO();
    this._gfx = gfx;
  };
  CQ.MapManager.prototype.findAt = function (c, r) {
    for (var i = 0; i < this.chests.length; i++) if (this.chests[i].c === c && this.chests[i].r === r) return this.chests[i];
    for (var j = 0; j < this.shops.length; j++) if (this.shops[j].c === c && this.shops[j].r === r) return this.shops[j];
    for (var k = 0; k < this.npcs.length; k++) if (this.npcs[k].c === c && this.npcs[k].r === r) return this.npcs[k];
    return null;
  };
})();
