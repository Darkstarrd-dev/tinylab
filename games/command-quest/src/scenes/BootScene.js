// CQ.BootScene — 启动、Sfx、存档、跳 Avg 或 World
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.BootScene = function () { Phaser.Scene.call(this, { key: 'Boot' }); };
  CQ.BootScene.prototype = Object.create(Phaser.Scene.prototype);
  CQ.BootScene.prototype.constructor = CQ.BootScene;
  CQ.BootScene.prototype.preload = function () {};
  CQ.BootScene.prototype.create = function () {
    var self = this;
    CQ.Sfx = (function () {
      var ctx = null; var timers = [];
      function ensure() { if (ctx) return ctx; try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); } catch (e) {} return ctx; }
      function tone(f, d, t, v) {
        var c = ensure(); if (!c) return;
        try { if (c.state === 'suspended') c.resume().catch(function(){}); var o = c.createOscillator(), g = c.createGain(); o.type = t || 'sine'; o.frequency.value = f; g.gain.value = v || 0.15; o.connect(g); g.connect(c.destination); o.start(); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + d); o.stop(c.currentTime + d + 0.02); } catch (e) {}
      }
      function sched(fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id; }
      return {
        play: function (name) {
          // TODO(音频替换点): 换成 this.sound.play(name)
          if (name === 'hit') tone(220, 0.08, 'triangle', 0.16);
          else if (name === 'kill') { tone(320, 0.12, 'sine', 0.18); sched(function(){ tone(480, 0.18, 'sine', 0.18); }, 90); }
          else if (name === 'heal') tone(600, 0.14, 'sine', 0.16);
          else if (name === 'coin') tone(900, 0.08, 'sine', 0.14);
          else if (name === 'open') tone(520, 0.1, 'sine', 0.16);
          else if (name === 'talk') tone(440, 0.08, 'sine', 0.12);
        },
        stopBgm: function(){}, shutdown: function(){ for (var i = 0; i < timers.length; i++) try{ clearTimeout(timers[i]); }catch(e){} timers.length = 0; try{ if(ctx&&ctx.close&&ctx.state!=='closed') ctx.close(); else if(ctx&&ctx.suspend&&ctx.state==='running') ctx.suspend(); }catch(e2){} },
        get ctx(){ return ctx; }, set ctx(v){ ctx=v; }, get bgmTimer(){ return null; }, set bgmTimer(v){}
      };
    })();
    try { this.events.on('shutdown', function(){ if(CQ.Sfx&&CQ.Sfx.shutdown) CQ.Sfx.shutdown(); }); } catch(e){}
    try { this.events.on('destroy', function(){ if(CQ.Sfx&&CQ.Sfx.shutdown) CQ.Sfx.shutdown(); }); } catch(e2){}
    var p = Promise.resolve(null);
    try { if (CQ.hostRef && CQ.hostRef.loadState) p = CQ.hostRef.loadState().catch(function(){ return null; }); } catch(e3){ p = Promise.resolve(null); }
    p.then(function (s) {
      if (s && typeof s === 'object') {
        CQ.save = s;
        if (!CQ.save.avgFlags) CQ.save.avgFlags = {};
        if (!CQ.save.mode) CQ.save.mode = 'srpg';
        if (CQ.save.seed == null) CQ.save.seed = CQ.CFG.SEED;
      }
      // 首次进入走序章 AVG，否则直接进 World
      if (!CQ.save.avgFlags.prologueDone) self.scene.start('Avg', { scriptId: 'prologue' });
      else self.scene.start('World', { seed: CQ.save.seed, mode: CQ.save.mode });
    });
  };
})();
