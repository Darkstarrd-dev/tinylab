// CQ.Formula — 数值驱动公式（唯一真相，三模态共用）
(function () {
  'use strict';
  var CQ = window.CQ;
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  CQ.Formula = {
    // 等级→累计 exp 阈值
    levelFromExp: function (exp) {
      var t = CQ.CFG.EXP_TABLE;
      for (var lv = t.length; lv >= 1; lv--) if (exp >= t[lv - 1]) return lv;
      return 1;
    },
    expToNext: function (exp) {
      var lv = this.levelFromExp(exp);
      if (lv >= CQ.CFG.MAX_LEVEL) return 0;
      return CQ.CFG.EXP_TABLE[lv] - exp;
    },
    // 指挥官当前面板（含成长、转职、装备、士兵加成）
    commanderStats: function (cmd) {
      var def = CQ.getCommanderDef(cmd.defId);
      var lv = cmd.level || 1;
      var grow = def ? def.grow : { hp: 5, atk: 2, def: 1, spd: 0.3 };
      var base = def ? def.base : { hp: 50, atk: 12, def: 6, spd: 4 };
      var br = CQ.getBranchSteps(def ? def.branch : 'knight');
      var classBonus = { hp: 0, atk: 0, def: 0, spd: 0 };
      for (var i = 0; i < br.length; i++) if (lv >= br[i].reqLv) { classBonus.hp += br[i].bonus.hp; classBonus.atk += br[i].bonus.atk; classBonus.def += br[i].bonus.def; classBonus.spd += br[i].bonus.spd; }
      var eqBonus = { hp: 0, atk: 0, def: 0, spd: 0 };
      for (var k = 0; k < (cmd.equips || []).length; k++) { var e = CQ.getEquip(cmd.equips[k]); if (!e) continue; eqBonus.atk += e.atk; eqBonus.def += e.def; eqBonus.spd += e.spd; }
      // 士兵算作属性：每名存活士兵按兵种提供固定加成（梦战式）
      var solBonus = { hp: 0, atk: 0, def: 0, spd: 0 };
      for (var s = 0; s < (cmd.soldiers || []).length; s++) { var sd = CQ.getSoldierDef(cmd.soldiers[s].type); if (!sd || cmd.soldiers[s].hp <= 0) continue; solBonus.hp += Math.floor(sd.hp * 0.25); solBonus.atk += Math.floor(sd.atk * 0.35); solBonus.def += Math.floor(sd.def * 0.35); }
      return {
        maxHp: Math.floor(base.hp + grow.hp * (lv - 1) + classBonus.hp + eqBonus.hp + solBonus.hp),
        atk: Math.floor(base.atk + grow.atk * (lv - 1) + classBonus.atk + eqBonus.atk + solBonus.atk),
        def: Math.floor(base.def + grow.def * (lv - 1) + classBonus.def + eqBonus.def + solBonus.def),
        spd: +(base.spd + grow.spd * (lv - 1) + classBonus.spd + eqBonus.spd).toFixed(1),
        range: 1
      };
    },
    // 伤害 = max(1, atk - def) * skillPower * 随机0.9~1.1
    damage: function (atk, def, power, rng) {
      var base = Math.max(1, atk - def) * (power || 1);
      var jitter = rng ? (0.9 + rng.next() * 0.2) : 1;
      return Math.max(1, Math.floor(base * jitter));
    },
    // 士兵跟随偏移（ARPG/RTS 士兵环绕指挥官）
    soldierOffsets: function (count) {
      var out = [];
      for (var i = 0; i < count; i++) { var a = (i / Math.max(1, count)) * Math.PI * 2; out.push({ dx: Math.cos(a) * 22, dy: Math.sin(a) * 22 }); }
      return out;
    }
  };
})();
