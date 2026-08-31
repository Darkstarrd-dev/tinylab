// TD.BootScene — 首场景：初始化存档与 Sfx，跳转 Start
(function () {
  'use strict';
  var TD = window.TD;
  TD.BootScene = function () { Phaser.Scene.call(this, { key: 'Boot' }); };
  TD.BootScene.prototype = Object.create(Phaser.Scene.prototype);
  TD.BootScene.prototype.constructor = TD.BootScene;
  TD.BootScene.prototype.preload = function () { /* 零外部资源；TODO(视觉替换点): this.load.image(...) */ };
  TD.BootScene.prototype.create = function () {
    var self = this;
    // 简易 Sfx（WebAudio oscillator）— 统一可被宿主静默关闭
    TD.Sfx = (function () {
      var ctx = null;
      var pendingTimers = [];
      function ensure() {
        if (ctx) return ctx;
        try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); } catch (e) {}
        return ctx;
      }
      function tone(freq, dur, type, vol) {
        var c = ensure(); if (!c) return;
        try {
          if (c.state === 'suspended') c.resume().catch(function(){});
          var o = c.createOscillator(), g = c.createGain();
          o.type = type || 'sine'; o.frequency.value = freq;
          g.gain.value = vol || 0.18; o.connect(g); g.connect(c.destination);
          o.start(); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
          o.stop(c.currentTime + dur + 0.02);
        } catch (e) {}
      }
      function sched(fn, ms) {
        var id = setTimeout(fn, ms);
        pendingTimers.push(id);
        return id;
      }
      return {
        play: function (name) {
          // TODO(音频替换点): 换成 this.sound.play(name)
          if (name === 'build') tone(520, 0.12, 'sine', 0.2);
          else if (name === 'shoot') tone(880, 0.06, 'square', 0.12);
          else if (name === 'hit') tone(220, 0.08, 'triangle', 0.18);
          else if (name === 'coin') tone(1200, 0.1, 'sine', 0.18);
          else if (name === 'sell') tone(360, 0.12, 'sine', 0.15);
          else if (name === 'wave') tone(660, 0.18, 'sine', 0.2);
          else if (name === 'victory') { tone(523, 0.2, 'sine', 0.2); sched(function(){ tone(659,0.2,'sine',0.2); },140); sched(function(){ tone(784,0.35,'sine',0.22); },300); }
          else if (name === 'defeat') tone(180, 0.5, 'sawtooth', 0.15);
        },
        stopBgm: function () { /* 兼容宿主 dgKillAudio 的 stopBgm 调用 */ },
        shutdown: function () {
          for (var i = 0; i < pendingTimers.length; i++) try { clearTimeout(pendingTimers[i]); } catch (e) {}
          pendingTimers.length = 0;
          try { if (ctx && typeof ctx.close === 'function' && ctx.state !== 'closed') ctx.close(); else if (ctx && typeof ctx.suspend === 'function' && ctx.state === 'running') ctx.suspend(); } catch (e2) {}
        },
        get ctx() { return ctx; },
        set ctx(v) { ctx = v; },
        get bgmTimer() { return null; },
        set bgmTimer(v) {}
      };
    })();
    // 游戏销毁时静默：宿主 Phaser.Game.destroy(true) 会触发 scene shutdown
    try { this.events.on('shutdown', function(){ if (TD.Sfx && typeof TD.Sfx.shutdown === 'function') TD.Sfx.shutdown(); }); } catch (e) {}
    try { this.events.on('destroy', function(){ if (TD.Sfx && typeof TD.Sfx.shutdown === 'function') TD.Sfx.shutdown(); }); } catch (e2) {}
    // 存档
    TD.save = TD.save || { best:{}, unlocked:[1], lastLevel:1 };
    var p = Promise.resolve(null);
    try { if (TD.hostRef && TD.hostRef.loadState) p = TD.hostRef.loadState().catch(function(){ return null; }); } catch (e) { p = Promise.resolve(null); }
    p.then(function (s) {
      if (s && typeof s === 'object') {
        TD.save = s;
        if (!TD.save.best) TD.save.best = {};
        if (!TD.save.unlocked || !TD.save.unlocked.length) TD.save.unlocked = [1];
      }
      self.scene.start('Start');
    });
  };
})();
