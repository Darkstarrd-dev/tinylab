// CQ.WorldScene — 单地图探索 + 三模态战斗 + 随机批次 + 宝箱/商店/NPC
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.WorldScene = function () { Phaser.Scene.call(this, { key: 'World' }); };
  CQ.WorldScene.prototype = Object.create(Phaser.Scene.prototype);
  CQ.WorldScene.prototype.constructor = CQ.WorldScene;

  CQ.WorldScene.prototype.init = function (data) {
    this.seed = (data && data.seed) || (CQ.save && CQ.save.seed) || CQ.CFG.SEED;
    this.battleMode = (data && data.mode) || (CQ.save && CQ.save.mode) || 'srpg';
    this.rng = new CQ.RNG(this.seed);
    this.turn = 1; this.phase = 'player'; this.wave = 1; this.gold = CQ.CFG.START_GOLD;
    this.playerUnits = []; this.enemyUnits = [];
    this.chests = []; this.shops = []; this.npcs = [];
    this.selected = null; this._enemyTickAcc = 0; this._arpgKeys = null;
  };

  CQ.WorldScene.prototype.create = function () {
    var W = this.scale.width, H = this.scale.height;
    CQ.sceneRef = this;
    var tile = Math.floor(W / CQ.CFG.GRID_COLS);
    var hudH = CQ.CFG.HUD_H;
    this.grid = new CQ.Grid(CQ.CFG.GRID_COLS, CQ.CFG.GRID_ROWS, tile, 0, hudH);
    this.cameras.main.setBackgroundColor(CQ.COLORS.BG);
    CQ.Skin.build(this);
    // 地图
    this.mapMgr = new CQ.MapManager(this, this.rng);
    this.mapMgr.generate();
    this.mapMgr.draw();
    // 队伍
    var pDefs = CQ.COMMANDERS.slice(0, 2);
    for (var i = 0; i < pDefs.length; i++) {
      var sp = this.mapMgr.playerSpawns[i] || { c: i, r: 0 };
      var cmd = new CQ.Commander(this, sp.c, sp.r, pDefs[i].id, 'player', 1);
      cmd.createGO(); this.playerUnits.push(cmd);
    }
    // 敌人首波
    this._spawnWave();
    // 战斗管理
    this.battleMgr = new CQ.BattleManager(this);
    this.battleMgr.setMode(this.battleMode);
    // HUD
    this.hud = new CQ.Hud(this); this.hud.create();
    this.hud.setGold(this.gold); this.hud.setWave(this.wave, CQ.CFG.MAX_WAVES);
    // 输入：点击格子
    this.input.on('pointerdown', this._onPointerDown.bind(this));
    this.input.keyboard.on('keydown-ONE', function () { this.battleMgr.setMode('srpg'); }.bind(this));
    this.input.keyboard.on('keydown-TWO', function () { this.battleMgr.setMode('arpg'); }.bind(this));
    this.input.keyboard.on('keydown-THREE', function () { this.battleMgr.setMode('rts'); }.bind(this));
    this.input.keyboard.on('keydown-SPACE', function () { if (this.battleMgr.mode === 'srpg') this.battleMgr.endPlayerTurn(); }.bind(this));
    this._arpgKeys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,ENTER');
    // 批次定时
    this._waveTimer = this.time.addEvent({ delay: CQ.CFG.WAVE_INTERVAL_MS, loop: true, callback: this._spawnWave, callbackScope: this });
    this.events.on('shutdown', this._onShutdown.bind(this));
    this.events.on('destroy', this._onShutdown.bind(this));
    this._syncAllGO();
  };

  CQ.WorldScene.prototype.unitAt = function (c, r) {
    for (var i = 0; i < this.playerUnits.length; i++) if (this.playerUnits[i].alive && this.playerUnits[i].c === c && this.playerUnits[i].r === r) return this.playerUnits[i];
    for (var j = 0; j < this.enemyUnits.length; j++) if (this.enemyUnits[j].alive && this.enemyUnits[j].c === c && this.enemyUnits[j].r === r) return this.enemyUnits[j];
    return null;
  };

  CQ.WorldScene.prototype._spawnWave = function () {
    if (this.wave > CQ.CFG.MAX_WAVES) return;
    var aliveEnemies = this.enemyUnits.filter(function (u) { return u.alive; }).length;
    if (aliveEnemies > 6) return; // 场上太多则跳过
    var n = CQ.CFG.BATCH_ENEMIES;
    for (var i = 0; i < n; i++) {
      var def = this.rng.pick(CQ.ENEMY_COMMANDERS);
      var sp = this.rng.pick(this.mapMgr.enemySpawns);
      // 找空位
      var tries = 0, c = sp.c, r = sp.r;
      while (this.unitAt(c, r) && tries < 20) { c = this.rng.int(0, this.grid.cols - 1); r = this.rng.int(0, this.grid.rows - 1); tries++; }
      if (this.mapMgr.isBlocked(c, r) || this.unitAt(c, r)) continue;
      var lv = Math.min(1 + Math.floor(this.wave / 2), 4);
      var cmd = new CQ.Commander(this, c, r, def.id, 'enemy', lv);
      cmd.createGO(); this.enemyUnits.push(cmd);
    }
    if (this.hud) this.hud.setWave(this.wave, CQ.CFG.MAX_WAVES);
    this.wave++;
  };

  CQ.WorldScene.prototype.handleInteract = function (cmd, ent) {
    if (ent instanceof CQ.Chest) {
      var rew = ent.open(cmd);
      if (!rew) return;
      this._applyReward(cmd, rew);
      if (CQ.Sfx) CQ.Sfx.play('open');
      if (this.hud) this.hud.log('宝箱: ' + (rew.type === 'gold' ? '+' + rew.amount + '金' : rew.type === 'equip' ? CQ.getEquip(rew.equipId).name : '新兵 +' + rew.soldierType));
    } else if (ent instanceof CQ.Shop) {
      this._openShop(cmd, ent);
    } else if (ent instanceof CQ.Npc) {
      var line = ent.talk();
      if (line.reward) this._applyReward(cmd, line.reward);
      if (line.triggerAvg) { CQ.save.avgFlags[line.triggerAvg + 'Seen'] = true; this.scene.pause(); this.scene.launch('Avg', { scriptId: line.triggerAvg }); }
      if (CQ.Sfx) CQ.Sfx.play('talk');
      if (this.hud) this.hud.log(line.text.slice(0, 32));
    }
  };

  CQ.WorldScene.prototype._applyReward = function (cmd, rew) {
    if (rew.type === 'gold') this.gold += rew.amount;
    else if (rew.type === 'equip') cmd.equip(rew.equipId);
    else if (rew.type === 'soldier') {
      var sd = CQ.getSoldierDef(rew.soldierType); if (!sd) return;
      cmd.soldiers.push({ type: rew.soldierType, hp: sd.hp, maxHp: sd.hp }); cmd._recalc();
    }
    cmd.syncGO();
    if (this.hud) this.hud.setGold(this.gold);
  };

  CQ.WorldScene.prototype._openShop = function (cmd, shop) {
    var self = this;
    var W = this.scale.width, H = this.scale.height;
    var overlay = this.add.rectangle(W / 2, H / 2, W - 40, H - 40, 0x0e1424, 0.92).setStrokeStyle(1, 0x3498db).setDepth(20);
    var title = this.add.text(W / 2, 70, '商店 — 点击购买（Esc 关闭）', { fontSize: '13px', color: '#e6edf3' }).setDepth(21).setOrigin(0.5);
    var items = [];
    for (var i = 0; i < shop.stock.length; i++) {
      var it = shop.stock[i];
      var y = 110 + i * 30;
      var bg = this.add.rectangle(W / 2, y, 360, 26, 0x243656).setStrokeStyle(1, 0x2a3a56).setDepth(21).setInteractive({ useHandCursor: true });
      var tx = this.add.text(W / 2, y, it.name + '  —  ' + it.price + '金', { fontSize: '11px', color: '#e6edf3' }).setDepth(21).setOrigin(0.5);
      (function (item, b) {
        b.on('pointerdown', function () {
          if (self.gold < item.price) { if (self.hud) self.hud.log('金币不足'); return; }
          self.gold -= item.price;
          if (item.kind === 'equip') cmd.equip(item.id);
          else if (item.kind === 'soldier') { var sd = CQ.getSoldierDef(item.id); if (sd) { cmd.soldiers.push({ type: item.id, hp: sd.hp, maxHp: sd.hp }); cmd._recalc(); } }
          else if (item.kind === 'heal') cmd.heal(12);
          cmd.syncGO(); if (self.hud) self.hud.setGold(self.gold);
          if (CQ.Sfx) CQ.Sfx.play('coin');
        });
      })(it, bg);
      items.push(bg); items.push(tx);
    }
    var close = function () { overlay.destroy(); title.destroy(); for (var k = 0; k < items.length; k++) items[k].destroy(); self.input.keyboard.off('keydown-ESC', close); };
    this.input.keyboard.once('keydown-ESC', close);
    overlay.setInteractive().on('pointerdown', function (p, lx, ly, ev) { ev.stopPropagation(); });
    // 点击空白关闭
    this.input.once('pointerdown', function () { close(); });
  };

  CQ.WorldScene.prototype._onPointerDown = function (pointer) {
    if (pointer.y < CQ.CFG.HUD_H) return;
    var cell = this.grid.worldToCell(pointer.x, pointer.y);
    var unit = this.unitAt(cell.c, cell.r);
    var mode = this.battleMgr.mode;
    // 选中我方
    if (unit && unit.team === 'player') { this.battleMgr.select(unit); if (this.hud) this.hud.showInspect(unit); return; }
    // 攻击敌方
    if (unit && unit.team === 'enemy' && this.battleMgr.selected) {
      var sel = this.battleMgr.selected;
      var res = this.battleMgr.tryAttack(sel, unit, sel.skills[0]);
      if (res && res.ok) { if (this.hud) this.hud.showInspect(unit); this.checkVictory(); }
      return;
    }
    // 空地：移动（SRPG 选中态）
    if (mode === 'srpg' && this.battleMgr.selected) {
      this.battleMgr.tryMove(this.battleMgr.selected, cell.c, cell.r);
      return;
    }
    // ARPG/RTS 空地：移动选中单位
    if ((mode === 'arpg' || mode === 'rts') && this.battleMgr.selected) {
      var c2 = this.battleMgr.selected;
      if (!this.mapMgr.isBlocked(cell.c, cell.r) && !this.unitAt(cell.c, cell.r)) { c2.setCell(cell.c, cell.r); c2.syncGO(); var ent = this.mapMgr.findAt(cell.c, cell.r); if (ent) this.handleInteract(c2, ent); }
      return;
    }
    if (this.hud) this.hud.showInspect(null);
  };

  CQ.WorldScene.prototype.update = function (time, delta) {
    if (!this.battleMgr) return;
    var mode = this.battleMgr.mode;
    // ARPG：WASD 移动主控，其他我方跟随；RTS：选中者 WASD
    var leader = mode === 'arpg' ? this.battleMgr.arpgLeader : this.battleMgr.selected;
    if (leader && leader.alive && this._arpgKeys) {
      var dx = 0, dy = 0;
      if (this._arpgKeys.W.isDown || this._arpgKeys.UP.isDown) dy -= 1;
      if (this._arpgKeys.S.isDown || this._arpgKeys.DOWN.isDown) dy += 1;
      if (this._arpgKeys.A.isDown || this._arpgKeys.LEFT.isDown) dx -= 1;
      if (this._arpgKeys.D.isDown || this._arpgKeys.RIGHT.isDown) dx += 1;
      if (dx || dy) {
        var step = delta / 120; // 格/秒归一
        if (dx && dy) { dx *= 0.707; dy *= 0.707; }
        var nc = leader.c + (dx > 0 ? 1 : dx < 0 ? -1 : 0), nr = leader.r + (dy > 0 ? 1 : dy < 0 ? -1 : 0);
        // 限频：每 120ms 一格
        this._moveAcc = (this._moveAcc || 0) + delta;
        if (this._moveAcc > 120) {
          this._moveAcc = 0;
          if ((nc !== leader.c || nr !== leader.r) && !this.mapMgr.isBlocked(nc, nr) && !this.unitAt(nc, nr)) {
            leader.setCell(nc, nr); leader.syncGO();
            var ent2 = this.mapMgr.findAt(nc, nr); if (ent2) this.handleInteract(leader, ent2);
            // ARPG 其他我方跟随
            if (mode === 'arpg') {
              for (var i = 0; i < this.playerUnits.length; i++) {
                var u = this.playerUnits[i]; if (u === leader || !u.alive) continue;
                var tc = leader.c, tr = leader.r;
                var dc2 = tc - u.c, dr2 = tr - u.r;
                if (Math.abs(dc2) + Math.abs(dr2) > 2) {
                  var mnc = u.c + (dc2 > 0 ? 1 : dc2 < 0 ? -1 : 0), mnr = u.r + (dr2 > 0 ? 1 : dr2 < 0 ? -1 : 0);
                  if (!this.mapMgr.isBlocked(mnc, mnr) && !this.unitAt(mnc, mnr)) { u.setCell(mnc, mnr); u.syncGO(); }
                }
              }
            }
          }
        }
      } else this._moveAcc = 0;
      // Space 攻击相邻敌人
      if (Phaser.Input.Keyboard.JustDown(this._arpgKeys.SPACE) || Phaser.Input.Keyboard.JustDown(this._arpgKeys.ENTER)) {
        var foe = null, best = 1e9;
        for (var j = 0; j < this.enemyUnits.length; j++) { var e = this.enemyUnits[j]; if (!e.alive) continue; var d = Math.abs(e.c - leader.c) + Math.abs(e.r - leader.r); if (d < best) { best = d; foe = e; } }
        if (foe && best <= 1) { this.battleMgr.tryAttack(leader, foe, leader.skills[0]); this.checkVictory(); }
      }
    }
    // 敌人实时：每 500ms 尝试靠近/攻击
    this._enemyTickAcc += delta;
    if (this._enemyTickAcc > 500) {
      this._enemyTickAcc = 0;
      if (mode !== 'srpg') this._enemyRealtimeTick();
    }
    this._syncAllGO();
  };

  CQ.WorldScene.prototype._enemyRealtimeTick = function () {
    var enemies = this.enemyUnits.filter(function (u) { return u.alive; });
    var players = this.playerUnits.filter(function (u) { return u.alive; });
    if (!players.length) return;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      var target = players[0], best = 1e9;
      for (var j = 0; j < players.length; j++) { var d = Math.abs(e.c - players[j].c) + Math.abs(e.r - players[j].r); if (d < best) { best = d; target = players[j]; } }
      if (best <= 1) { this.battleMgr.tryAttack(e, target, e.skills[0]); continue; }
      var dc = target.c - e.c, dr = target.r - e.r;
      var nc = e.c, nr = e.r;
      if (Math.abs(dc) > Math.abs(dr)) nc += dc > 0 ? 1 : -1; else if (dr !== 0) nr += dr > 0 ? 1 : -1; else if (dc !== 0) nc += dc > 0 ? 1 : -1;
      if (!this.mapMgr.isBlocked(nc, nr) && !this.unitAt(nc, nr)) { e.setCell(nc, nr); e.syncGO(); }
    }
  };

  CQ.WorldScene.prototype._syncAllGO = function () {
    for (var i = 0; i < this.playerUnits.length; i++) this.playerUnits[i].syncGO();
    for (var j = 0; j < this.enemyUnits.length; j++) this.enemyUnits[j].syncGO();
  };

  CQ.WorldScene.prototype.checkVictory = function () {
    var aliveE = this.enemyUnits.filter(function (u) { return u.alive; }).length;
    var aliveP = this.playerUnits.filter(function (u) { return u.alive; }).length;
    if (aliveP === 0) { this._showEnd(false); return; }
    if (this.wave > CQ.CFG.MAX_WAVES && aliveE === 0) { this._showEnd(true); return; }
  };

  CQ.WorldScene.prototype._showEnd = function (win) {
    var W = this.scale.width, H = this.scale.height;
    this.add.rectangle(W / 2, H / 2, 320, 120, 0x0e1424, 0.92).setStrokeStyle(2, win ? 0x2ecc71 : 0xe74c3c).setDepth(30);
    this.add.text(W / 2, H / 2 - 16, win ? '胜利！' : '败北……', { fontSize: '20px', color: '#e6edf3' }).setDepth(31).setOrigin(0.5);
    this.add.text(W / 2, H / 2 + 18, 'R 重开  |  点击模式切换继续', { fontSize: '11px', color: '#93a1b8' }).setDepth(31).setOrigin(0.5);
    this.input.keyboard.once('keydown-R', function () { this.scene.restart({ seed: this.rng.int(1, 1e9), mode: this.battleMgr.mode }); }.bind(this));
    CQ.save.gold = this.gold;
    try { if (CQ.hostRef && CQ.hostRef.saveState) CQ.hostRef.saveState(CQ.save); } catch (e) {}
  };

  CQ.WorldScene.prototype._onShutdown = function () {
    if (this._waveTimer) try { this._waveTimer.remove(); } catch (e) {}
    if (CQ.Sfx && CQ.Sfx.shutdown) try { CQ.Sfx.shutdown(); } catch (e2) {}
    // 清 GO 引用
    this.playerUnits.forEach(function (u) { u.destroyGO(); if (u._hpBar) try { u._hpBar.destroy(); } catch (e) {} });
    this.enemyUnits.forEach(function (u) { u.destroyGO(); if (u._hpBar) try { u._hpBar.destroy(); } catch (e) {} });
  };
})();
