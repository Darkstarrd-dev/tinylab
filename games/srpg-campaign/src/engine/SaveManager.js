// SC.SaveManager — 存档槽位（host.saveState 落盘，本地备份）
(function () {
  'use strict';
  var SC = window.SC;
  function SaveManager(host) { this.host = host; this.slots = [null,null,null]; this.autosave = null; this.settings = { bgmVol:0.6, sfxVol:0.8, animSpeed:1 }; }
  SaveManager.prototype.load = function () {
    var self = this;
    var p = Promise.resolve(null);
    try { if (self.host && self.host.loadState) p = self.host.loadState().catch(function(){return null;}); } catch(e){ p=Promise.resolve(null); }
    return p.then(function (s) {
      if (s && s.slots) { self.slots = s.slots; self.autosave = s.autosave || null; self.settings = s.settings || self.settings; }
      // 本地备份键（host 存档失败时兜底）
      try {
        var local = JSON.parse(localStorage.getItem('sc_save') || 'null');
        if (local && !s) { self.slots = local.slots || self.slots; self.autosave = local.autosave || self.autosave; }
      } catch(e){}
      return self;
    });
  };
  SaveManager.prototype._persist = function () {
    var data = { slots:this.slots, autosave:this.autosave, settings:this.settings };
    try { localStorage.setItem('sc_save', JSON.stringify(data)); } catch(e){}
    try { if (this.host && this.host.saveState) this.host.saveState(data).catch(function(){}); } catch(e){}
  };
  SaveManager.prototype.saveSlot = function (idx, state) {
    var snap = { at: Date.now(), chapterId: state.chapterId, flags: JSON.parse(JSON.stringify(state.flags)), roster: JSON.parse(JSON.stringify(state.roster)), cleared: state.cleared, playedChapters: state.playedChapters.slice(0) };
    this.slots[idx] = snap;
    this._persist();
  };
  SaveManager.prototype.loadSlot = function (idx) {
    var s = this.slots[idx]; if (!s) return null;
    return SC.GameState.fromJSON(s);
  };
  SaveManager.prototype.setAutosave = function (state) {
    this.autosave = { at: Date.now(), chapterId: state.chapterId, flags: JSON.parse(JSON.stringify(state.flags)), roster: JSON.parse(JSON.stringify(state.roster)), cleared: state.cleared };
    this._persist();
  };
  SC.SaveManager = SaveManager;
})();
