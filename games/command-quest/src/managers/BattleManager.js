// CQ.BattleManager — 战斗调度（SRPG 回合 / ARPG 实时 / RTS 选中）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.BattleManager = function (scene) {
    this.scene = scene;
    this.mode = 'srpg'; // srpg | arpg | rts
    this.turn = 1;
    this.phase = 'player'; // player | enemy
    this.selected = null; // 选中的我方 Commander
    this.rtsSelected = []; // RTS 多选（本期单选，预留）
    this.arpgLeader = null; // ARPG 当前主控
  };
  CQ.BattleManager.prototype.setMode = function (m) {
    if (CQ.MODES.indexOf(m) === -1) return;
    this.mode = m;
    this.selected = null; this.rtsSelected.length = 0;
    if (m === 'arpg') this.arpgLeader = this.scene.playerUnits[0] || null;
    else this.arpgLeader = null;
    if (this.scene.hud) this.scene.hud.setMode(m);
  };
  CQ.BattleManager.prototype.select = function (cmd) {
    if (!cmd || cmd.team !== 'player' || !cmd.alive) return;
    this.selected = cmd;
    if (this.mode === 'rts') this.rtsSelected = [cmd];
    if (this.mode === 'arpg') this.arpgLeader = cmd;
  };
  // SRPG：移动到相邻可走格
  CQ.BattleManager.prototype.tryMove = function (cmd, c, r) {
    if (this.mode !== 'srpg') return false;
    if (this.phase !== 'player') return false;
    if (cmd !== this.selected) return false;
    var d = Math.abs(cmd.c - c) + Math.abs(cmd.r - r);
    if (d !== 1) return false;
    if (this.scene.mapMgr.isBlocked(c, r)) return false;
    if (this.scene.unitAt(c, r)) return false;
    cmd.setCell(c, r); cmd.syncGO();
    var ent = this.scene.mapMgr.findAt(c, r);
    if (ent) this.scene.handleInteract(cmd, ent);
    return true;
  };
  CQ.BattleManager.prototype.tryAttack = function (attacker, defender, skillId) {
    if (!attacker.alive || !defender.alive) return null;
    if (attacker.team === defender.team) return null;
    var d = Math.abs(attacker.c - defender.c) + Math.abs(attacker.r - defender.r);
    var sk = skillId ? CQ.getSkill(skillId) : null;
    var range = sk ? sk.range : 1;
    if (d > range) return null;
    var res = CQ.BattleCalc.applyAttack(attacker, defender, skillId, this.scene.rng);
    attacker.syncGO(); defender.syncGO();
    if (this.scene.hud) this.scene.hud.log(res.kind === 'heal' ? ('治疗 +' + res.heal) : ('伤害 ' + res.dmg + (res.kill ? ' 击破' : '')));
    if (CQ.Sfx) CQ.Sfx.play(res.kill ? 'kill' : res.kind === 'heal' ? 'heal' : 'hit');
    return res;
  };
  CQ.BattleManager.prototype.endPlayerTurn = function () {
    if (this.mode !== 'srpg') return;
    this.phase = 'enemy';
    this._enemyTurn();
  };
  CQ.BattleManager.prototype._enemyTurn = function () {
    var self = this;
    var enemies = this.scene.enemyUnits.filter(function (u) { return u.alive; });
    var players = this.scene.playerUnits.filter(function (u) { return u.alive; });
    if (!players.length) return;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      // 向最近玩家移动一格
      var target = players[0], best = 1e9;
      for (var j = 0; j < players.length; j++) { var dd = Math.abs(e.c - players[j].c) + Math.abs(e.r - players[j].r); if (dd < best) { best = dd; target = players[j]; } }
      var dc = target.c - e.c, dr = target.r - e.r;
      var nc = e.c, nr = e.r;
      if (Math.abs(dc) > Math.abs(dr)) nc += dc > 0 ? 1 : -1; else if (dr !== 0) nr += dr > 0 ? 1 : -1;
      else if (dc !== 0) nc += dc > 0 ? 1 : -1;
      if (!this.scene.mapMgr.isBlocked(nc, nr) && !this.scene.unitAt(nc, nr)) { e.setCell(nc, nr); e.syncGO(); }
      // 若相邻则攻击
      if (Math.abs(e.c - target.c) + Math.abs(e.r - target.r) <= 1) {
        var sk = e.skills[0] || null;
        this.tryAttack(e, target, sk);
      }
    }
    // 回合结束
    for (var k = 0; k < this.scene.playerUnits.length; k++) if (this.scene.playerUnits[k].alive) this.scene.playerUnits[k].onTurnStart();
    for (var k2 = 0; k2 < this.scene.enemyUnits.length; k2++) if (this.scene.enemyUnits[k2].alive) this.scene.enemyUnits[k2].onTurnStart();
    this.turn++; this.phase = 'player';
    if (this.scene.hud) this.scene.hud.setTurn(this.turn, this.phase);
    this.scene.checkVictory();
  };
  // ARPG/RTS：实时 tick（由 WorldScene.update 驱动）
  CQ.BattleManager.prototype.tickRealtime = function (delta) {
    if (this.mode === 'srpg') return;
    // 敌人 AI：向最近玩家缓慢靠近
    var enemies = this.scene.enemyUnits.filter(function (u) { return u.alive; });
    var players = this.scene.playerUnits.filter(function (u) { return u.alive; });
    if (!players.length || !enemies.length) return;
    // 简化：每 ~600ms 敌人尝试移动/攻击一次（由 WorldScene 限频调用）
  };
})();
