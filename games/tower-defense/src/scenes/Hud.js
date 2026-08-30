// TD.Hud — 顶部状态 + 底部商店 + 选中塔面板
(function () {
  'use strict';
  var TD = window.TD;
  function Hud(scene) {
    this.scene = scene;
    this.objs = [];
  }
  Hud.prototype.create = function () {
    var sc = this.scene, W = sc.scale.width, H = sc.scale.height;
    var CFG = TD.CFG;
    // 顶栏
    var topBg = sc.add.rectangle(W/2, CFG.HUD_H/2, W, CFG.HUD_H, 0x111827).setDepth(20);
    this.goldText = sc.add.text(14, CFG.HUD_H/2, '', { fontSize:'13px', color:'#f1c40f', fontStyle:'bold' }).setOrigin(0,0.5).setDepth(21);
    this.livesText = sc.add.text(150, CFG.HUD_H/2, '', { fontSize:'13px', color:'#e74c3c', fontStyle:'bold' }).setOrigin(0,0.5).setDepth(21);
    this.waveText = sc.add.text(270, CFG.HUD_H/2, '', { fontSize:'12px', color:'#e6edf3' }).setOrigin(0,0.5).setDepth(21);
    this.scoreText = sc.add.text(420, CFG.HUD_H/2, '', { fontSize:'12px', color:'#8b949e' }).setOrigin(0,0.5).setDepth(21);
    // 按钮：开始波次 / 暂停 / 加速 / 返回
    var self = this;
    function btn(x, label, cb) {
      var bg = sc.add.rectangle(x, CFG.HUD_H/2, 72, 28, 0x2a3a56).setDepth(21).setInteractive({useHandCursor:true});
      var tx = sc.add.text(x, CFG.HUD_H/2, label, { fontSize:'11px', color:'#e6edf3' }).setOrigin(0.5).setDepth(22);
      bg.on('pointerdown', cb);
      bg.on('pointerover', function(){ bg.fillColor = 0x34495e; });
      bg.on('pointerout', function(){ bg.fillColor = 0x2a3a56; });
      return { bg:bg, tx:tx };
    }
    this.waveBtn = btn(W - 280, '开始波次', function(){ self.scene.startNextWave(); });
    this.pauseBtn = btn(W - 200, '暂停', function(){ self.scene.togglePause(); });
    this.speedBtn = btn(W - 120, '×1', function(){ self.scene.toggleSpeed(); });
    this.backBtn = btn(W - 44, '退出', function(){ self.scene.exitToMenu(); });
    // 商店（底部）
    var shopY = H - CFG.SHOP_H/2, shopBg = sc.add.rectangle(W/2, shopY, W, CFG.SHOP_H, 0x111827).setDepth(20);
    sc.add.text(10, shopY - 18, '商店（选塔后点空网格建造）', { fontSize:'10px', color:'#6e7681' }).setDepth(21);
    this.shopBtns = [];
    var startX = 10, bw = 72, bh = 36, gap = 8;
    for (var i = 0; i < TD.TOWERS.length; i++) {
      (function (def, idx) {
        var x = startX + idx * (bw + gap) + bw/2, y = shopY + 6;
        var bg2 = sc.add.rectangle(x, y, bw, bh, def.color).setDepth(21).setInteractive({useHandCursor:true});
        bg2.setStrokeStyle(1, 0xffffff, 0.85);
        var ab = sc.add.text(x, y - 6, def.abbr, { fontSize:'11px', color:'#0e1628', fontStyle:'bold' }).setOrigin(0.5).setDepth(22);
        var pr = sc.add.text(x, y + 8, '$' + def.levels[0].cost, { fontSize:'9px', color:'#0e1628' }).setOrigin(0.5).setDepth(22);
        bg2.on('pointerdown', function(){ self.scene.pickShopTower(def.id); self._hiliteShop(def.id); });
        self.shopBtns.push({ id:def.id, bg:bg2, ab:ab, pr:pr });
      })(TD.TOWERS[i], i);
    }
    // 选中塔面板（右侧浮层）
    this.panel = sc.add.container(W - 170, H/2).setDepth(23).setVisible(false);
    var pbg = sc.add.rectangle(0, 0, 160, 220, 0x0e1628, 0.96);
    pbg.setStrokeStyle(1, 0x2a3a56, 1);
    var title = sc.add.text(0, -96, '', { fontSize:'12px', color:'#e6edf3', fontStyle:'bold' }).setOrigin(0.5);
    var stats = sc.add.text(-72, -72, '', { fontSize:'10px', color:'#8b949e' }).setOrigin(0,0);
    var upBg = sc.add.rectangle(0, 18, 130, 30, 0x2a3a56).setInteractive({useHandCursor:true});
    var upTx = sc.add.text(0, 18, '升级', { fontSize:'11px', color:'#e6edf3' }).setOrigin(0.5);
    var sellBg = sc.add.rectangle(0, 56, 130, 30, 0x7f1d1d).setInteractive({useHandCursor:true});
    var sellTx = sc.add.text(0, 56, '出售', { fontSize:'11px', color:'#fecaca' }).setOrigin(0.5);
    var stratTx = sc.add.text(0, 88, '', { fontSize:'10px', color:'#6e7681' }).setOrigin(0.5);
    this.panel.add([pbg, title, stats, upBg, upTx, sellBg, sellTx, stratTx]);
    this.panelTitle = title; this.panelStats = stats; this.panelUpBg = upBg; this.panelUpTx = upTx; this.panelSellBg = sellBg; this.panelSellTx = sellTx; this.panelStrat = stratTx;
    var self2 = this;
    upBg.on('pointerdown', function(){ self2.scene.upgradeSelected(); });
    sellBg.on('pointerdown', function(){ self2.scene.sellSelected(); });
    // 策略切换（点击循环）
    stratTx.setInteractive({useHandCursor:true});
    stratTx.on('pointerdown', function(){ self2.scene.cycleTargeting(); });
    this.objs = [topBg, shopBg, this.goldText, this.livesText, this.waveText, this.scoreText, this.panel];
  };
  Hud.prototype._hiliteShop = function (id) {
    for (var i = 0; i < this.shopBtns.length; i++) {
      var b = this.shopBtns[i];
      b.bg.setStrokeStyle(b.id === id ? 2.5 : 1, b.id === id ? 0x3498db : 0xffffff, 1);
    }
  };
  Hud.prototype.update = function () {
    var sc = this.scene, em = sc.economy, wm = sc.waveMgr;
    if (!em) return;
    this.goldText.setText('金币 ' + em.gold);
    this.livesText.setText('♥ ' + em.lives);
    var w = wm ? wm.waveIndex + 1 : 0, total = wm ? wm.level.waves.length : 0;
    this.waveText.setText('波次 ' + w + '/' + total);
    this.scoreText.setText('分数 ' + em.score);
    if (this.waveBtn) {
      var canNext = wm && wm.waveIndex < wm.level.waves.length - 1 && !wm.spawning;
      this.waveBtn.bg.fillColor = canNext ? 0x1a7a3a : 0x1a2332;
      this.waveBtn.tx.setColor(canNext ? '#e6edf3' : '#484f58');
    }
    if (this.speedBtn) this.speedBtn.tx.setText('×' + (sc.timeScale || 1));
    if (this.pauseBtn) this.pauseBtn.tx.setText(sc.paused ? '继续' : '暂停');
    // 金币不足置灰商店
    for (var i = 0; i < this.shopBtns.length; i++) {
      var b = this.shopBtns[i], cost = TD.getTowerLevelCost(b.id, 1);
      b.bg.setAlpha(em.gold >= cost ? 1 : 0.45);
    }
    // 选中面板
    var sel = sc.selectedTower;
    if (sel) {
      this.panel.setVisible(true);
      this.panelTitle.setText(sel.def.name + '  L' + sel.level);
      var eff = sel.effectiveDamage(sc);
      this.panelStats.setText('伤害 ' + eff + ' (基' + sel.damage + ')\n范围 ' + sel.range + '\n射速 ' + sel.fireRate + 'ms\n击杀 ' + sel.kills);
      var canUp = sel.canUpgrade();
      var cost2 = canUp ? sel.upgradeCost() : 0;
      this.panelUpTx.setText(canUp ? ('升级 $' + cost2) : '已满级');
      this.panelUpBg.fillColor = canUp && em.gold >= cost2 ? 0x2a3a56 : 0x1a2332;
      this.panelSellTx.setText('出售 +$' + sel.sellValue());
      this.panelStrat.setText('目标: ' + (sc.targeting ? sc.targeting.mode : 'first') + ' (点击切换)');
    } else {
      this.panel.setVisible(false);
    }
  };
  Hud.prototype.destroy = function () { /* 由 scene 统一清理 */ };
  TD.Hud = Hud;
})();
