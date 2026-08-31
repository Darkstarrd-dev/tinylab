// CQ.Commander — 指挥官实体（数值驱动，士兵算作属性）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.Commander = function (scene, c, r, defId, team, level) {
    CQ.Entity.call(this, scene, c, r);
    this.defId = defId; this.team = team; // 'player' | 'enemy'
    this.level = level || 1; this.exp = 0; this.hp = 0; this.maxHp = 0;
    this.mp = 10; this.maxMp = 10;
    this.equips = []; // equip ids
    this.skills = []; // skill ids
    this.soldiers = []; // {type, hp, maxHp}
    this.side = team === 'player' ? 0 : 1;
    this._initSoldiers();
    this._recalc();
    this.hp = this.maxHp;
    this._buffDef = 0; this._buffTurns = 0;
  };
  CQ.Commander.prototype = Object.create(CQ.Entity.prototype);
  CQ.Commander.prototype.constructor = CQ.Commander;
  CQ.Commander.prototype._initSoldiers = function () {
    var def = CQ.getCommanderDef(this.defId);
    var start = (def && def.startSkills) ? def.startSkills.slice() : ['slash'];
    this.skills = start.slice();
    // 每指挥官带 2~3 名士兵（首关固定 infantry+archer）
    var types = ['infantry', 'archer'];
    if (this.team === 'player') types.push('healer');
    for (var i = 0; i < types.length; i++) {
      var sd = CQ.getSoldierDef(types[i]); if (!sd) continue;
      this.soldiers.push({ type: types[i], hp: sd.hp, maxHp: sd.hp });
    }
  };
  CQ.Commander.prototype._recalc = function () {
    var s = CQ.Formula.commanderStats(this);
    this.maxHp = s.maxHp; this.atk = s.atk; this.def = s.def + this._buffDef; this.spd = s.spd; this.range = s.range;
    if (this.hp > this.maxHp) this.hp = this.maxHp;
    this.maxMp = 10 + Math.floor(this.level * 1.2);
    if (this.mp > this.maxMp) this.mp = this.maxMp;
  };
  CQ.Commander.prototype.gainExp = function (n) {
    this.exp += n;
    var nl = CQ.Formula.levelFromExp(this.exp);
    if (nl > this.level) {
      this.level = Math.min(nl, CQ.CFG.MAX_LEVEL);
      this._recalc(); this.hp = this.maxHp;
      // 解锁职业技能
      var def = CQ.getCommanderDef(this.defId);
      var steps = CQ.getBranchSteps(def ? def.branch : 'knight');
      for (var i = 0; i < steps.length; i++) if (steps[i].reqLv === this.level && this.skills.indexOf(steps[i].skill) === -1) this.skills.push(steps[i].skill);
      return true;
    }
    return false;
  };
  CQ.Commander.prototype.takeDamage = function (n) {
    this.hp -= n; if (this.hp <= 0) { this.hp = 0; this.alive = false; }
  };
  CQ.Commander.prototype.heal = function (n) { this.hp = Math.min(this.maxHp, this.hp + n); };
  CQ.Commander.prototype.canAct = function () { return this.alive; };
  CQ.Commander.prototype.equip = function (equipId) {
    var eq = CQ.getEquip(equipId); if (!eq) return false;
    // 同 slot 替换
    for (var i = 0; i < this.equips.length; i++) { var cur = CQ.getEquip(this.equips[i]); if (cur && cur.slot === eq.slot) { this.equips.splice(i, 1); break; } }
    this.equips.push(equipId); this._recalc(); return true;
  };
  CQ.Commander.prototype.createGO = function () {
    var p = this.worldPos();
    var def = CQ.getCommanderDef(this.defId);
    var color = def ? def.color : (this.team === 'player' ? 0x3498db : 0xe74c3c);
    var g = this.scene.add.container(p.x, p.y);
    var bg = this.scene.add.rectangle(0, 0, 28, 28, color).setStrokeStyle(2, 0xffffff);
    var tx = this.scene.add.text(0, 0, def ? def.abbr : '?', { fontSize: '12px', color: '#fff' }).setOrigin(0.5);
    g.add([bg, tx]);
    // 士兵小点（跟随显示）
    var offs = CQ.Formula.soldierOffsets(this.soldiers.length);
    for (var i = 0; i < this.soldiers.length; i++) {
      var sd = CQ.getSoldierDef(this.soldiers[i].type);
      var dot = this.scene.add.circle(offs[i].dx, offs[i].dy, 4, sd ? sd.color : 0xffffff).setStrokeStyle(1, 0x000000);
      g.add(dot);
    }
    if (this.team === 'enemy') g.setAlpha(0.95);
    this.go = g;
    this._hpBar = this.scene.add.graphics();
    this._updateHpBar();
    return g;
  };
  CQ.Commander.prototype._updateHpBar = function () {
    if (!this._hpBar || !this.go) return;
    var p = this.worldPos();
    this._hpBar.clear();
    var w = 28, h = 4, y = p.y - 20;
    this._hpBar.fillStyle(0x000000, 0.6).fillRect(p.x - w / 2, y, w, h);
    var pct = this.maxHp ? this.hp / this.maxHp : 0;
    this._hpBar.fillStyle(pct > 0.5 ? 0x2ecc71 : pct > 0.25 ? 0xf1c40f : 0xe74c3c, 1).fillRect(p.x - w / 2, y, w * pct, h);
  };
  CQ.Commander.prototype.syncGO = function () {
    if (!this.go) return;
    var p = this.worldPos(); this.go.setPosition(p.x, p.y); this._updateHpBar();
    this.go.setVisible(this.alive);
    if (this._hpBar) this._hpBar.setVisible(this.alive);
  };
  CQ.Commander.prototype.onTurnStart = function () { if (this._buffTurns > 0) { this._buffTurns--; if (this._buffTurns === 0) { this._buffDef = 0; this._recalc(); } } };
})();
