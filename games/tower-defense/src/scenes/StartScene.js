// TD.StartScene — 开始界面
(function () {
  'use strict';
  var TD = window.TD;
  TD.StartScene = function () { Phaser.Scene.call(this, { key: 'Start' }); };
  TD.StartScene.prototype = Object.create(Phaser.Scene.prototype);
  TD.StartScene.prototype.constructor = TD.StartScene;
  TD.StartScene.prototype.create = function () {
    var W = this.scale.width, H = this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    this.add.rectangle(W/2, H/2, W, H, 0x0e1628);
    // 标题
    this.add.text(W/2, 92, 'TOWER DEFENSE', { fontSize:'42px', color:'#e6edf3', fontStyle:'bold' }).setOrigin(0.5);
    this.add.text(W/2, 126, '塔防演示  ·  10 塔 × 4 级  ·  10 敌  ·  5 关', { fontSize:'13px', color:'#8b949e' }).setOrigin(0.5);
    this.add.text(W/2, 148, '占位色块 + 文字  ·  子弹 Rectangle 池', { fontSize:'11px', color:'#6e7681' }).setOrigin(0.5);
    // 按钮
    var self = this;
    function mkBtn(y, label, cb, enabled) {
      var en = enabled !== false;
      var bg = self.add.rectangle(W/2, y, 220, 44, en ? 0x2a3a56 : 0x1a2332).setInteractive(en ? {useHandCursor:true} : {});
      var tx = self.add.text(W/2, y, label, { fontSize:'16px', color: en ? '#e6edf3' : '#6e7681', fontStyle:'bold' }).setOrigin(0.5);
      if (en) {
        bg.on('pointerover', function(){ bg.fillColor = 0x34495e; });
        bg.on('pointerout', function(){ bg.fillColor = 0x2a3a56; });
        bg.on('pointerdown', cb);
      }
      return { bg:bg, tx:tx };
    }
    mkBtn(210, '开始游戏', function(){ self.scene.start('LevelSelect'); });
    var hasSave = TD.save && TD.save.lastLevel;
    mkBtn(268, '继续游戏', function(){ self.scene.start('Game', { levelId: TD.save.lastLevel || 1 }); }, !!hasSave);
    mkBtn(326, '关卡选择', function(){ self.scene.start('LevelSelect'); });
    // 说明
    var info = [
      '建造：点击空网格或底部商店选塔后点网格',
      '升级/出售：点击已建塔，在面板操作',
      '波次：点击“开始波次”或等待自动开始'
    ];
    for (var i = 0; i < info.length; i++) {
      this.add.text(W/2, 400 + i * 18, info[i], { fontSize:'11px', color:'#8b949e' }).setOrigin(0.5);
    }
    this.add.text(W/2, H - 18, 'v' + TD.VERSION + '  ·  零外部资源  ·  热更新: 改 src/*.js 后点 Reload', { fontSize:'10px', color:'#484f58' }).setOrigin(0.5);
  };
})();
