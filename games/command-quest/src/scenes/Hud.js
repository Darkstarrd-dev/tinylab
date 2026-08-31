// CQ.Hud — 顶部状态 + 模式切换 + 日志
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.Hud = function (scene) { this.scene = scene; };
  CQ.Hud.prototype.create = function () {
    var W = this.scene.scale.width;
    var hudY = 14;
    this.bg = this.scene.add.rectangle(W / 2, 20, W - 12, 32, 0x162040).setStrokeStyle(1, 0x243656).setDepth(10);
    this.modeTx = this.scene.add.text(12, hudY, '', { fontSize: '11px', color: '#e6edf3' }).setDepth(11).setOrigin(0, 0.5);
    this.turnTx = this.scene.add.text(160, hudY, '', { fontSize: '11px', color: '#93a1b8' }).setDepth(11).setOrigin(0, 0.5);
    this.goldTx = this.scene.add.text(280, hudY, '', { fontSize: '11px', color: '#f1c40f' }).setDepth(11).setOrigin(0, 0.5);
    this.waveTx = this.scene.add.text(380, hudY, '', { fontSize: '11px', color: '#93a1b8' }).setDepth(11).setOrigin(0, 0.5);
    // 模式按钮
    var self = this;
    var modes = CQ.MODES;
    this.modeBtns = [];
    for (var i = 0; i < modes.length; i++) {
      var btn = this.scene.add.rectangle(W - 180 + i * 62, hudY, 56, 22, 0x2a3a56).setStrokeStyle(1, 0x3498db).setDepth(11).setInteractive({ useHandCursor: true });
      var tx = this.scene.add.text(W - 180 + i * 62, hudY, modes[i].toUpperCase(), { fontSize: '10px', color: '#e6edf3' }).setDepth(11).setOrigin(0.5);
      (function (mode, b) { b.on('pointerdown', function () { self.scene.battleMgr.setMode(mode); self.setMode(mode); if (CQ.Sfx) CQ.Sfx.play('talk'); }); })(modes[i], btn);
      this.modeBtns.push({ mode: modes[i], bg: btn, tx: tx });
    }
    // 结束回合（仅 SRPG 显示）
    this.endBtn = this.scene.add.rectangle(W - 12 - 40, hudY + 26, 80, 18, 0x243656).setStrokeStyle(1, 0x2ecc71).setDepth(11).setInteractive({ useHandCursor: true });
    this.endTx = this.scene.add.text(W - 12 - 40, hudY + 26, '结束回合', { fontSize: '10px', color: '#e6edf3' }).setDepth(11).setOrigin(0.5);
    this.endBtn.on('pointerdown', function () { if (self.scene.battleMgr.mode === 'srpg') self.scene.battleMgr.endPlayerTurn(); });
    // 日志
    this.logTx = this.scene.add.text(12, 44, '', { fontSize: '10px', color: '#93a1b8', wordWrap: { width: W - 24 } }).setDepth(11);
    this.logs = [];
    this.setMode(this.scene.battleMode || 'srpg');
    this.setTurn(1, 'player');
  };
  CQ.Hud.prototype.setMode = function (m) {
    this.modeTx.setText('模式: ' + m.toUpperCase());
    for (var i = 0; i < this.modeBtns.length; i++) {
      var active = this.modeBtns[i].mode === m;
      this.modeBtns[i].bg.setFillStyle(active ? 0x3498db : 0x2a3a56);
    }
    this.endBtn.setVisible(m === 'srpg');
    this.endTx.setVisible(m === 'srpg');
  };
  CQ.Hud.prototype.setTurn = function (turn, phase) { this.turnTx.setText('T' + turn + ' · ' + phase); };
  CQ.Hud.prototype.setGold = function (g) { this.goldTx.setText('金 ' + g); };
  CQ.Hud.prototype.setWave = function (w, max) { this.waveTx.setText('波次 ' + w + '/' + max); };
  CQ.Hud.prototype.log = function (msg) {
    this.logs.unshift(msg);
    if (this.logs.length > 3) this.logs.pop();
    this.logTx.setText(this.logs.join('  |  '));
  };
  CQ.Hud.prototype.showInspect = function (cmd) {
    if (!cmd) { this.log(''); return; }
    var def = CQ.getCommanderDef(cmd.defId);
    var name = def ? def.name : cmd.defId;
    this.log(name + ' Lv' + cmd.level + ' HP' + cmd.hp + '/' + cmd.maxHp + ' 士兵' + cmd.soldiers.length);
  };
})();
