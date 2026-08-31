// TD.GameScene — 核心战场（OOP 编排）
(function () {
  'use strict';
  var TD = window.TD;
  TD.GameScene = function () { Phaser.Scene.call(this, { key: 'Game' }); };
  TD.GameScene.prototype = Object.create(Phaser.Scene.prototype);
  TD.GameScene.prototype.constructor = TD.GameScene;

  TD.GameScene.prototype.init = function (data) {
    this.levelId = (data && data.levelId) || TD.currentLevel || 1;
    this.level = null;
    for (var i = 0; i < TD.LEVELS.length; i++) if (TD.LEVELS[i].id === this.levelId) this.level = TD.LEVELS[i];
    if (!this.level) this.level = TD.LEVELS[0];
    this.paused = false; this.over = false; this.victory = false;
    this.timeScale = 1;
    this.shopPick = null; this.selectedTower = null;
    this.towers = []; this.enemiesAlive = []; this.enemyPool = []; this.bulletPool = [];
    this._gridGfx = null; this._overGfx = null;
  };

  TD.GameScene.prototype.create = function () {
    var W = this.scale.width, H = this.scale.height, CFG = TD.CFG;
    this.cameras.main.setBackgroundColor(this.level.bg);
    TD.currentLevel = this.levelId;
    // 网格与地图
    var playTop = CFG.HUD_H, playH = H - CFG.HUD_H - CFG.SHOP_H;
    // 用 H 归一：tile 按 W/COLS，oy = HUD_H
    var tile = Math.floor(W / CFG.GRID_COLS);
    this.grid = new TD.Grid(CFG.GRID_COLS, CFG.GRID_ROWS, tile, 0, playTop);
    this.mapMgr = new TD.MapManager(this.level, this.grid);
    this.mapMgr.drawPath(this);
    this._drawGrid();
    // 经济/波次/索敌
    this.economy = new TD.EconomyManager(this.level.startGold, this.level.lives);
    this.waveMgr = new TD.WaveManager(this.level, this);
    this.targeting = new TD.TargetingSystem();
    // 子弹池（Rectangle）
    for (var i = 0; i < CFG.BULLET_POOL; i++) {
      var p = new TD.Projectile(this); p.ensureGO(); this.bulletPool.push(p);
    }
    this.nextBullet = 0;
    // 敌人池
    for (var j = 0; j < CFG.ENEMY_POOL; j++) {
      var e = new TD.Enemy(this, TD.ENEMIES[0]); e.go = null; e.active = false;
      this.enemyPool.push(e);
    }
    // HUD
    this.hud = new TD.Hud(this); this.hud.create();
    // 输入：网格点击
    var self = this;
    this.input.on('pointerdown', function (pointer) {
      if (self.over) return;
      // 忽略 HUD 区域
      if (pointer.y < CFG.HUD_H || pointer.y > H - CFG.SHOP_H) return;
      var cell = self.grid.worldToCell(pointer.x, pointer.y);
      // 点到已建塔 -> 选中
      var hit = null;
      for (var k = 0; k < self.towers.length; k++) if (self.towers[k].cell.c === cell.c && self.towers[k].cell.r === cell.r) { hit = self.towers[k]; break; }
      if (hit) { self.selectTower(hit); return; }
      // 空格 -> 建造
      if (self.shopPick) self.tryBuild(cell);
      else { self.selectTower(null); }
    });
    // 暴露测试缝
    TD.sceneRef = this;
    if (window.__trgame) window.__trgame.scene = this;
    // 提示
    this._toast('点击底部商店选塔，再点网格建造', 2200);
  };

  TD.GameScene.prototype._drawGrid = function () {
    var g = this.add.graphics().setDepth(0);
    var cols = this.grid.cols, rows = this.grid.rows, tile = this.grid.tile, ox = this.grid.ox, oy = this.grid.oy;
    g.lineStyle(1, TD.COLORS.GRID, 0.85);
    for (var c = 0; c <= cols; c++) { g.moveTo(ox + c * tile, oy); g.lineTo(ox + c * tile, oy + rows * tile); }
    g.strokePath();
    for (var r = 0; r <= rows; r++) { g.moveTo(ox, oy + r * tile); g.lineTo(ox + cols * tile, oy + r * tile); }
    g.strokePath();
    this._gridGfx = g;
  };

  TD.GameScene.prototype.pickShopTower = function (id) { this.shopPick = id; this._toast('已选 ' + TD.getTowerDef(id).name + '，点空网格建造', 1400); };
  TD.GameScene.prototype.selectTower = function (t) {
    if (this.selectedTower) this.selectedTower.setSelected(false);
    this.selectedTower = t;
    if (t) t.setSelected(true);
  };
  TD.GameScene.prototype.tryBuild = function (cell) {
    if (!this.shopPick) return;
    if (!this.grid.canPlace(cell.c, cell.r)) { this._toast('不可建造', 900); return; }
    if (this.towers.length >= TD.CFG.MAX_TOWERS) { this._toast('塔已达上限', 900); return; }
    var def = TD.getTowerDef(this.shopPick), cost = TD.getTowerLevelCost(def.id, 1);
    if (!this.economy.canAfford(cost)) { this._toast('金币不足', 900); return; }
    this.economy.spend(cost);
    var tw = new TD.Tower(this, def, cell, 1);
    tw.createGO();
    this.towers.push(tw);
    this.grid.place(cell.c, cell.r, tw);
    if (TD.Sfx) TD.Sfx.play('build');
    this.selectTower(tw);
  };
  TD.GameScene.prototype.upgradeSelected = function () {
    var t = this.selectedTower; if (!t || !t.canUpgrade()) return;
    var cost = t.upgradeCost();
    if (!this.economy.canAfford(cost)) { this._toast('金币不足', 800); return; }
    this.economy.spend(cost); t.doUpgrade();
    if (TD.Sfx) TD.Sfx.play('build');
  };
  TD.GameScene.prototype.sellSelected = function () {
    var t = this.selectedTower; if (!t) return;
    var val = t.sellValue();
    this.economy.earn(val);
    // 移除
    this.grid.remove(t.cell.c, t.cell.r);
    t.setSelected(false);
    if (t._rangeGfx) try { t._rangeGfx.destroy(); } catch (e) {}
    if (t.go) try { t.go.destroy(); } catch (e) {}
    var idx = this.towers.indexOf(t); if (idx !== -1) this.towers.splice(idx, 1);
    this.selectedTower = null;
    if (TD.Sfx) TD.Sfx.play('sell');
  };
  TD.GameScene.prototype.cycleTargeting = function () {
    var modes = ['first','last','strong','weak','closest'];
    var cur = modes.indexOf(this.targeting.mode);
    this.targeting.mode = modes[(cur + 1) % modes.length];
  };
  TD.GameScene.prototype.startNextWave = function () {
    if (this.over) return;
    if (this.waveMgr.waveIndex === -1) { this.waveMgr.startNextWave(); if (TD.Sfx) TD.Sfx.play('wave'); return; }
    if (!this.waveMgr.spawning) {
      var ok = this.waveMgr.startNextWave();
      if (ok && TD.Sfx) TD.Sfx.play('wave');
      else if (!ok) this._toast('已是最后一波', 900);
    }
  };
  TD.GameScene.prototype.togglePause = function () { this.paused = !this.paused; };
  TD.GameScene.prototype.toggleSpeed = function () { this.timeScale = this.timeScale === 1 ? 2 : 1; };
  TD.GameScene.prototype.exitToMenu = function () { this.scene.start('LevelSelect'); };
  TD.GameScene.prototype.spawnEnemy = function (enemyId, hpMul, speedMul, rewardMul) {
    var def = TD.getEnemyDef(enemyId); if (!def) return;
    var e = null;
    for (var i = 0; i < this.enemyPool.length; i++) if (!this.enemyPool[i].active) { e = this.enemyPool[i]; break; }
    if (!e) { e = new TD.Enemy(this, def); this.enemyPool.push(e); }
    e.spawn(def, hpMul, speedMul, rewardMul, 0);
    // 起点
    var p0 = this.mapMgr.pathWorld[0];
    e.x = p0.x; e.y = p0.y; if (e.go) { e.go.x = p0.x; e.go.y = p0.y; e.go.setVisible(true).setActive(true); }
    // 分裂：死亡时分裂两个小怪（在 onEnemyKilled 中处理）
    this.enemiesAlive.push(e);
    // 分裂敌标记
    e._isSplitParent = (enemyId === 'split');
  };
  TD.GameScene.prototype.onEnemyKilled = function (enemy, killer) {
    // 奖励
    this.economy.earn(enemy.reward);
    this.economy.kills++;
    if (killer) killer.kills++;
    if (TD.Sfx) TD.Sfx.play('coin');
    // 分裂
    if (enemy._isSplitParent) {
      for (var k = 0; k < 2; k++) {
        var sd = TD.getEnemyDef('grunt');
        this.spawnEnemy('grunt', 0.52, 1.1, 0.5);
        var ne = this.enemiesAlive[this.enemiesAlive.length - 1];
        if (ne) ne.pathT = enemy.pathT;
      }
    }
    this._reapEnemy(enemy);
  };
  TD.GameScene.prototype._reapEnemy = function (enemy) {
    enemy.active = false;
    if (enemy.go) enemy.go.setVisible(false).setActive(false);
    var idx = this.enemiesAlive.indexOf(enemy); if (idx !== -1) this.enemiesAlive.splice(idx, 1);
  };
  TD.GameScene.prototype._toast = function (msg, ms) {
    var t = this.add.text(this.scale.width/2, this.scale.height - 90, msg, { fontSize:'11px', color:'#e6edf3', backgroundColor:'#111827cc' }).setOrigin(0.5).setDepth(30);
    var self = this;
    if (self.time && typeof self.time.delayedCall === 'function') {
      self.time.delayedCall(ms || 1400, function(){ try { t.destroy(); } catch (e) {} });
    } else {
      setTimeout(function(){ try { t.destroy(); } catch (e) {} }, ms || 1400);
    }
  };
  TD.GameScene.prototype._fireTower = function (tower) {
    var target = this.targeting.pick(tower, this.enemiesAlive);
    if (!target) return;
    var p = this.bulletPool[this.nextBullet % this.bulletPool.length];
    this.nextBullet++;
    var dmg = tower.effectiveDamage(this);
    p.fire(tower.x, tower.y, target, tower.def, dmg, tower);
    if (TD.Sfx) TD.Sfx.play('shoot');
  };
  TD.GameScene.prototype.update = function (time, delta) {
    if (this.paused || this.over) { if (this.hud) this.hud.update(); return; }
    var dt = delta * this.timeScale;
    // 波次
    this.waveMgr.update(dt);
    // 敌人
    for (var i = this.enemiesAlive.length - 1; i >= 0; i--) {
      var e = this.enemiesAlive[i];
      var done = e.update(dt, this.mapMgr);
      if (done) {
        if (e._leaked) {
          this.economy.loseLife(1);
          this._reapEnemy(e);
          if (this.economy.lives <= 0) this._gameOver(false);
        } else {
          // 死亡已在 projectile 中处理，此处仅血量归零的兜底
          if (e.hp <= 0) this.onEnemyKilled(e, null);
          else this._reapEnemy(e);
        }
      }
    }
    // 塔索敌射击
    var now = this.time.now;
    for (var ti = 0; ti < this.towers.length; ti++) {
      var tw = this.towers[ti];
      if (tw.canFire(now)) {
        var tgt = this.targeting.pick(tw, this.enemiesAlive);
        if (tgt) { tw.markFired(now); this._fireTower(tw); }
      }
      // tesla aura 每 fireRate 周期自动触发（无弹道）
      if (tw.def.id === 'tesla' && now - tw.lastFire >= tw.fireRate) {
        tw.markFired(now);
        // 触发 aura：用 projectile 的 aura 逻辑复用
        var pp = this.bulletPool[this.nextBullet % this.bulletPool.length];
        this.nextBullet++;
        pp.fire(tw.x, tw.y, {x:tw.x,y:tw.y, active:false}, tw.def, tw.effectiveDamage(this), tw);
      }
    }
    // 子弹
    for (var pi = 0; pi < this.bulletPool.length; pi++) {
      var pr = this.bulletPool[pi]; if (pr.active) pr.update(dt);
    }
    // 胜利判定
    if (!this.over && this.waveMgr.isAllWavesDone() && this.enemiesAlive.length === 0) {
      this._gameOver(true);
    }
    if (this.hud) this.hud.update();
  };
  TD.GameScene.prototype._gameOver = function (victory) {
    if (this.over) return;
    this.over = true; this.victory = !!victory;
    var W = this.scale.width, H = this.scale.height;
    var overlay = this.add.rectangle(W/2, H/2, W, H, 0x000000, 0.62).setDepth(40);
    var title = victory ? '胜利！' : '失败';
    this.add.text(W/2, H/2 - 44, title, { fontSize:'32px', color: victory ? '#2ecc71' : '#e74c3c', fontStyle:'bold' }).setOrigin(0.5).setDepth(41);
    var score = this.economy.score + this.economy.lives * 50 + (this.waveMgr.waveIndex + 1) * 100;
    this.add.text(W/2, H/2 - 10, '分数 ' + score + '  ·  击杀 ' + this.economy.kills + '  ·  剩余 ♥ ' + this.economy.lives, { fontSize:'12px', color:'#e6edf3' }).setOrigin(0.5).setDepth(41);
    if (TD.Sfx) TD.Sfx.play(victory ? 'victory' : 'defeat');
    // 存档：最佳分 + 解锁
    try {
      var best = (TD.save.best && TD.save.best[this.levelId]) || 0;
      if (score > best) { TD.save.best[this.levelId] = score; }
      if (victory) {
        var next = this.levelId + 1;
        if (next <= TD.LEVELS.length && TD.save.unlocked.indexOf(next) === -1) TD.save.unlocked.push(next);
      }
      TD.save.lastLevel = this.levelId;
      if (TD.hostRef && TD.hostRef.saveState) TD.hostRef.saveState(TD.save).catch(function(){});
    } catch (e) {}
    var self = this;
    function mkBtn2(y, label, cb) {
      var bg = self.add.rectangle(W/2, y, 160, 36, 0x2a3a56).setDepth(41).setInteractive({useHandCursor:true});
      var tx = self.add.text(W/2, y, label, { fontSize:'13px', color:'#e6edf3' }).setOrigin(0.5).setDepth(42);
      bg.on('pointerdown', cb);
      bg.on('pointerover', function(){ bg.fillColor = 0x34495e; });
      bg.on('pointerout', function(){ bg.fillColor = 0x2a3a56; });
    }
    mkBtn2(H/2 + 32, '再来一局', function(){ self.scene.restart({ levelId: self.levelId }); });
    mkBtn2(H/2 + 76, '关卡选择', function(){ self.scene.start('LevelSelect'); });
    mkBtn2(H/2 + 120, '返回开始', function(){ self.scene.start('Start'); });
    this._overGfx = overlay;
  };
})();
