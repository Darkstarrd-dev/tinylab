// SC.GameState — 运行状态
(function () {
  'use strict';
  var SC = window.SC;
  function GameState() {
    this.chapterId = 1;
    this.flags = {}; // route, recruit*, branch choices
    this.roster = {}; // charId -> { level, exp, job, hp, maxHp, atk, def, spd, skills, promoted }
    this.battle = null; // Tactics 运行时
    this.settings = { bgmVol: 0.6, sfxVol: 0.8, animSpeed: 1, autoSave: true };
    this.cleared = {}; // chapterId -> true
    this.playedChapters = [];
  }
  GameState.prototype.reset = function () {
    this.chapterId = 1; this.flags = {}; this.roster = {}; this.cleared = {}; this.playedChapters = [];
  };
  GameState.prototype.ensureRoster = function (charId) {
    if (this.roster[charId]) return this.roster[charId];
    var ch = SC.getChar(charId);
    var job = SC.getClass(ch.job);
    var lv = ch.lv || 1;
    // 成长推算
    var hp = job.base.hp + Math.floor((lv - 1) * job.growth.hp / 100 * 2);
    var atk = job.base.atk + Math.floor((lv - 1) * job.growth.atk / 100 * 1.2);
    var def = job.base.def + Math.floor((lv - 1) * job.growth.def / 100 * 1.1);
    var spd = job.base.spd + Math.floor((lv - 1) * job.growth.spd / 100 * 1.0);
    this.roster[charId] = { charId:charId, job:ch.job, level:lv, exp:0, hp:hp, maxHp:hp, atk:atk, def:def, spd:spd, skills: SC.getJobSkills(ch.job).slice(0,2) };
    return this.roster[charId];
  };
  GameState.prototype.getRosterList = function (chapterId) {
    var ch = SC.CHAPTERS[chapterId - 1];
    var starts = (ch && ch.playerStarts) || [];
    // 分歧额外
    var variant = SC.resolveChapter(chapterId);
    if (variant && variant.extraUnits) starts = starts.concat(variant.extraUnits);
    var list = [];
    for (var i=0;i<starts.length;i++) {
      var sid = starts[i].charId;
      // 分支角色需旗帜
      var cdef = SC.getChar(sid);
      if (cdef && cdef.branch) {
        if (cdef.branch === 'A' && this.flags.route !== 'A') continue;
        if (cdef.branch === 'B' && this.flags.route !== 'B') continue;
        if (cdef.id === 'valdris' && !this.flags.recruitValdris) continue;
        if (cdef.id === 'shade' && this.flags.recruitShade) { /* already */ } // shade 在 B 才出现，已通过 extraUnits 控制
      }
      list.push(this.ensureRoster(sid));
    }
    return list;
  };
  GameState.prototype.toJSON = function () {
    return { chapterId:this.chapterId, flags:this.flags, roster:this.roster, cleared:this.cleared, playedChapters:this.playedChapters, settings:this.settings };
  };
  GameState.fromJSON = function (o) {
    var g = new GameState();
    if (!o) return g;
    g.chapterId = o.chapterId || 1;
    g.flags = o.flags || {};
    g.roster = o.roster || {};
    g.cleared = o.cleared || {};
    g.playedChapters = o.playedChapters || [];
    g.settings = o.settings || g.settings;
    return g;
  };
  SC.GameState = GameState;
})();
