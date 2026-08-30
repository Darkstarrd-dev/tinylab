// TD.LevelSelectScene — 关卡选择（5 关）
(function () {
  'use strict';
  var TD = window.TD;
  TD.LevelSelectScene = function () { Phaser.Scene.call(this, { key: 'LevelSelect' }); };
  TD.LevelSelectScene.prototype = Object.create(Phaser.Scene.prototype);
  TD.LevelSelectScene.prototype.constructor = TD.LevelSelectScene;
  TD.LevelSelectScene.prototype.create = function () {
    var W = this.scale.width, H = this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    this.add.text(W/2, 32, '选择关卡', { fontSize:'22px', color:'#e6edf3', fontStyle:'bold' }).setOrigin(0.5);
    var self = this;
    var unlocked = (TD.save && TD.save.unlocked) || [1];
    function isUnlocked(id){ return unlocked.indexOf(id) !== -1; }
    var cols = 3, cardW = 260, cardH = 150, gap = 16, startX = (W - (cols * cardW + (cols-1)*gap))/2, startY = 62;
    for (var i = 0; i < TD.LEVELS.length; i++) {
      (function (lv, idx) {
        var col = idx % cols, row = Math.floor(idx / cols);
        var x = startX + col * (cardW + gap), y = startY + row * (cardH + gap);
        var en = isUnlocked(lv.id);
        var bg = self.add.rectangle(x + cardW/2, y + cardH/2, cardW, cardH, en ? 0x1a2332 : 0x111827);
        bg.setStrokeStyle(1.2, en ? 0x2a3a56 : 0x1a2332, 1);
        if (en) bg.setInteractive({useHandCursor:true});
        self.add.text(x + 12, y + 10, 'Lv.' + lv.id + '  ' + lv.name, { fontSize:'13px', color: en ? '#e6edf3' : '#484f58', fontStyle:'bold' });
        self.add.text(x + 12, y + 32, lv.desc, { fontSize:'11px', color: en ? '#8b949e' : '#484f58' });
        // 波次预览
        var waveTxt = lv.waves.length + ' 波  ·  ' + lv.waves.map(function(w){return TD.getEnemyDef(w.enemyId).abbr;}).slice(0,6).join(' ');
        self.add.text(x + 12, y + 52, waveTxt, { fontSize:'10px', color:'#6e7681' });
        var best = TD.save && TD.save.best && TD.save.best[lv.id];
        self.add.text(x + 12, y + 92, best ? ('最佳: ' + best) : '未通关', { fontSize:'11px', color: best ? '#f1c40f' : '#484f58' });
        var badge = self.add.text(x + cardW - 10, y + cardH - 10, en ? '▶ 进入' : '未解锁', { fontSize:'11px', color: en ? '#2ecc71' : '#484f58', fontStyle:'bold' }).setOrigin(1,1);
        if (!en) self.add.text(x + cardW/2, y + cardH/2 + 8, '🔒', { fontSize:'22px', color:'#484f58' }).setOrigin(0.5).setAlpha(0.5);
        if (en) bg.on('pointerdown', function(){ TD.currentLevel = lv.id; self.scene.start('Game', { levelId: lv.id }); });
      })(TD.LEVELS[i], i);
    }
    var back = this.add.rectangle(W/2, H - 26, 140, 32, 0x2a3a56).setInteractive({useHandCursor:true});
    this.add.text(W/2, H - 26, '返回', { fontSize:'13px', color:'#e6edf3' }).setOrigin(0.5);
    back.on('pointerdown', function(){ self.scene.start('Start'); });
    back.on('pointerover', function(){ back.fillColor = 0x34495e; });
    back.on('pointerout', function(){ back.fillColor = 0x2a3a56; });
  };
})();
