// CQ.BattleCalc — 战斗计算（唯一真相，三模态共用）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.BattleCalc = {
    canAttack: function (attacker, defender) {
      if (!attacker.alive || !defender.alive) return false;
      var d = Math.abs(attacker.c - defender.c) + Math.abs(attacker.r - defender.r);
      return d <= 1;
    },
    skillCanUse: function (user, skillId) {
      var sk = CQ.getSkill(skillId); if (!sk) return false;
      return user.mp >= sk.costMp;
    },
    applyAttack: function (attacker, defender, skillId, rng) {
      var sk = skillId ? CQ.getSkill(skillId) : null;
      var power = sk ? sk.power : 1;
      var cost = sk ? sk.costMp : 0;
      if (cost && attacker.mp < cost) return { ok: false, reason: 'MP不足' };
      if (cost) attacker.mp -= cost;
      if (sk && sk.kind === 'heal') {
        var heal = CQ.Formula.damage(attacker.atk, 0, power, rng);
        defender.heal(heal);
        return { ok: true, heal: heal, kind: 'heal' };
      }
      if (sk && sk.kind === 'buff') {
        attacker._buffDef = 3; attacker._buffTurns = 1; attacker._recalc();
        return { ok: true, kind: 'buff' };
      }
      var dmg = CQ.Formula.damage(attacker.atk, defender.def, power, rng);
      defender.takeDamage(dmg);
      // 士兵也受溅射：一名随机士兵 -1~3
      if (defender.soldiers && defender.soldiers.length) {
        var idx = rng ? rng.int(0, defender.soldiers.length - 1) : 0;
        if (defender.soldiers[idx].hp > 0) defender.soldiers[idx].hp = Math.max(0, defender.soldiers[idx].hp - (rng ? rng.int(1, 3) : 1));
        defender._recalc();
      }
      var leveled = false;
      if (!defender.alive) leveled = attacker.gainExp(12);
      return { ok: true, dmg: dmg, kill: !defender.alive, leveled: leveled, kind: sk ? sk.kind : 'melee' };
    }
  };
})();
