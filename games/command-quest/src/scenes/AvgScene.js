// CQ.AvgScene — AVG 过场（数据驱动剧本，点击推进）
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.AvgScene = function () { Phaser.Scene.call(this, { key: 'Avg' }); };
  CQ.AvgScene.prototype = Object.create(Phaser.Scene.prototype);
  CQ.AvgScene.prototype.constructor = CQ.AvgScene;
  CQ.AvgScene.prototype.init = function (data) {
    this.scriptId = (data && data.scriptId) || 'prologue';
    this.script = CQ.getAvgScript(this.scriptId);
    this.nodeId = (this.script.nodes[0] && this.script.nodes[0].id) || null;
  };
  CQ.AvgScene.prototype.create = function () {
    var W = this.scale.width, H = this.scale.height;
    this.cameras.main.setBackgroundColor('#0b0f1e');
    this.add.rectangle(W / 2, H / 2, W - 24, H - 24, 0x162040).setStrokeStyle(1, 0x2a3a56);
    this.titleTx = this.add.text(W / 2, 32, this.script.title, { fontSize: '16px', color: '#e6edf3' }).setOrigin(0.5);
    this.speakerTx = this.add.text(W / 2, 72, '', { fontSize: '13px', color: '#f1c40f' }).setOrigin(0.5);
    this.bodyTx = this.add.text(W / 2, 140, '', { fontSize: '13px', color: '#e6edf3', wordWrap: { width: W - 80 } }).setOrigin(0.5);
    this.hintTx = this.add.text(W / 2, H - 28, '点击 / Space 继续', { fontSize: '11px', color: '#93a1b8' }).setOrigin(0.5);
    this.choiceG = this.add.container(W / 2, 220);
    this.input.on('pointerdown', this._advance.bind(this));
    this.input.keyboard.on('keydown-SPACE', this._advance.bind(this));
    this.input.keyboard.on('keydown-ENTER', this._advance.bind(this));
    this._renderNode();
  };
  CQ.AvgScene.prototype._node = function () {
    for (var i = 0; i < this.script.nodes.length; i++) if (this.script.nodes[i].id === this.nodeId) return this.script.nodes[i];
    return null;
  };
  CQ.AvgScene.prototype._renderNode = function () {
    var n = this._node();
    if (!n) { this._finish(); return; }
    this.speakerTx.setText(n.speaker === 'narrator' ? '' : (n.speaker || ''));
    this.bodyTx.setText(n.text || '');
    this.choiceG.removeAll(true);
    if (n.choices && n.choices.length) {
      this.hintTx.setText('');
      for (var i = 0; i < n.choices.length; i++) {
        var ch = n.choices[i];
        var btn = this.add.rectangle(0, i * 36, 360, 30, 0x2a3a56).setStrokeStyle(1, 0x3498db).setInteractive({ useHandCursor: true });
        var tx = this.add.text(0, i * 36, ch.text, { fontSize: '12px', color: '#e6edf3' }).setOrigin(0.5);
        this.choiceG.add([btn, tx]);
        (function (choice) { btn.on('pointerdown', function () { this._pick(choice); }.bind(this)); }.bind(this))(ch);
      }
    } else {
      this.hintTx.setText(n.next ? '点击 / Space 继续' : '点击 / Space 进入战场');
    }
  };
  CQ.AvgScene.prototype._pick = function (choice) {
    if (choice.setFlag) CQ.save.avgFlags[choice.setFlag] = choice.setVal != null ? choice.setVal : true;
    if (choice.setFlag === 'preferredMode' && choice.setVal) CQ.save.mode = choice.setVal;
    this.nodeId = choice.next; this._renderNode();
  };
  CQ.AvgScene.prototype._advance = function () {
    var n = this._node(); if (!n) return;
    if (n.choices && n.choices.length) return;
    if (!n.next) { this._finish(); return; }
    this.nodeId = n.next; this._renderNode();
  };
  CQ.AvgScene.prototype._finish = function () {
    if (this.scriptId === 'prologue') CQ.save.avgFlags.prologueDone = true;
    CQ.save.seed = CQ.save.seed || CQ.CFG.SEED;
    try { if (CQ.hostRef && CQ.hostRef.saveState) CQ.hostRef.saveState(CQ.save); } catch (e) {}
    this.scene.start('World', { seed: CQ.save.seed, mode: CQ.save.mode || 'srpg' });
  };
})();
