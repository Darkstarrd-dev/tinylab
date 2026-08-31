// SC.BattleScene — 独立战斗动画场景（覆盖式，全屏演出）
(function () {
  'use strict';
  var SC = window.SC;
  SC.BattleScene = function(){ Phaser.Scene.call(this,{key:'Battle'}); };
  SC.BattleScene.prototype = Object.create(Phaser.Scene.prototype);
  SC.BattleScene.prototype.constructor = SC.BattleScene;
  SC.BattleScene.prototype.init = function(data){
    this.atk=data.atk; this.def=data.def; this.grid=data.grid; this.skillId=data.skillId||null;
    this.tacticsScene=data.tacticsScene||null;
  };
  SC.BattleScene.prototype.create = function(){
    SC.sceneRef=this;
    var W=this.scale.width, H=this.scale.height;
    this.cameras.main.setBackgroundColor('#0e1628');
    // 遮罩
    this.add.rectangle(W/2,H/2,W,H,0x0e1628,0.96).setDepth(0);
    var atk=this.atk, def=this.def;
    // 左右立绘占位（色块+abbr）
    var leftColor = SC.getClass(atk.job)?SC.getClass(atk.job).color:0x3498db;
    var rightColor = SC.getClass(def.job)?SC.getClass(def.job).color:0xe74c3c;
    var left=this.add.rectangle(W*0.28, H*0.42, 140, 160, leftColor).setDepth(2);
    left.setStrokeStyle(2,0xffffff,0.9);
    var right=this.add.rectangle(W*0.72, H*0.42, 140, 160, rightColor).setDepth(2);
    right.setStrokeStyle(2,0xffffff,0.9);
    this.add.text(W*0.28, H*0.42, atk.abbr, {fontSize:'36px', color:'#0e1628', fontStyle:'bold'}).setOrigin(0.5).setDepth(3);
    this.add.text(W*0.72, H*0.42, def.abbr, {fontSize:'36px', color:'#0e1628', fontStyle:'bold'}).setOrigin(0.5).setDepth(3);
    this.add.text(W*0.28, H*0.62, atk.name+' Lv'+atk.level, {fontSize:'11px', color:'#e6edf3'}).setOrigin(0.5).setDepth(3);
    this.add.text(W*0.72, H*0.62, def.name+' Lv'+def.level, {fontSize:'11px', color:'#e6edf3'}).setOrigin(0.5).setDepth(3);
    // HP 条
    var hpToBar=function(x,y,unit){
      var bg=this.add.rectangle(x,y,140,8,0x000000,0.6).setDepth(3);
      var fill=this.add.rectangle(x-70,y,140 * (unit.hp/unit.maxHp),8,0x2ecc71).setOrigin(0,0.5).setDepth(4);
      var tx=this.add.text(x,y+12, unit.hp+'/'+unit.maxHp, {fontSize:'10px', color:'#e6edf3'}).setOrigin(0.5).setDepth(3);
      return { bg:bg, fill:fill, tx:tx, unit:unit };
    }.bind(this);
    this.leftHp=hpToBar(W*0.28, H*0.68, atk);
    this.rightHp=hpToBar(W*0.72, H*0.68, def);
    var skillName = this.skillId ? (SC.getSkill(this.skillId).name) : (atk.range>1?'射击':'攻击');
    this.add.text(W/2, 28, skillName, {fontSize:'15px', color:'#f1c40f', fontStyle:'bold'}).setOrigin(0.5).setDepth(3);
    this.hitText=this.add.text(W/2, H*0.78, '', {fontSize:'13px', color:'#e6edf3'}).setOrigin(0.5).setDepth(3);
    // 预览
    var bm=new SC.BattleManager();
    this.preview=bm.preview(atk, def, this.grid, this.skillId);
    if(this.preview.isHeal){
      this.hitText.setText('治愈 ' + (-this.preview.damage) + '  命中 ' + this.preview.hit + '%');
    } else {
      this.hitText.setText('威力 '+this.preview.damage+'  暴击 '+this.preview.crit+'%  命中 '+this.preview.hit+'%');
    }
    this.add.text(W/2, H-14, '点击跳过动画', {fontSize:'10px', color:'#6e7681'}).setOrigin(0.5).setDepth(3);
    var self=this;
    this._done=false;
    this.input.on('pointerdown', function(){ if(!self._done) self._resolve(true); });
    this.input.keyboard.on('keydown-SPACE', function(){ if(!self._done) self._resolve(true); });
    this.time.delayedCall(520, function(){ self._resolve(false); });
  };
  SC.BattleScene.prototype._resolve = function(skip){
    if(this._done) return; this._done=true;
    var atk=this.atk, def=this.def;
    var bm=new SC.BattleManager();
    var result;
    // 治愈分支
    if(this.preview && this.preview.isHeal){
      var h=-this.preview.damage;
      def.heal(h);
      this._flash(this.rightHp, 0x2ecc71);
      this.hitText.setText('回复 +'+h);
      if(SC.Sfx) SC.Sfx.play('heal');
      this._syncHp();
      result={ hit:true, heal:true, damage:-h, exp: 10, preview:this.preview };
      this._finish(result);
      return;
    }
    // 攻击
    var r=bm.resolve(atk, def, this.grid, this.skillId);
    // 演出
    if(!r.hit){
      this.hitText.setText('未命中！');
      this._shake(this.def, false);
    } else if(r.killed){
      this.hitText.setText((r.crit?'暴击！ ':'') + r.damage + '  击破！');
      this._shake(this.def, true);
      if(SC.Sfx) SC.Sfx.play('hit');
    } else {
      this.hitText.setText((r.crit?'暴击！ ':'') + r.damage + (r.crit?'!':''));
      this._shake(this.def, false);
      if(SC.Sfx) SC.Sfx.play('hit');
    }
    this._syncHp();
    // 反击（仅近战且存活）
    var counter=null, counterExp=0, counterKilled=false, counterTarget=null;
    if(r.hit && def.isAlive() && bm.canCounter(def, atk) && this.skillId!=='heal'){
      var cr = bm.resolve(def, atk, this.grid, null);
      if(cr.hit){
        if(cr.killed) this.hitText.setText(this.hitText.text + '  反击 '+cr.damage+' 击破！');
        else this.hitText.setText(this.hitText.text + '  反击 '+cr.damage);
        this._shake(atk, cr.killed);
      } else {
        this.hitText.setText(this.hitText.text + '  反击未命中');
      }
      counter=cr; counterExp=cr.exp; counterKilled=!!cr.killed; counterTarget=cr.killed?atk:null;
      this._syncHp();
    }
    result={ hit:r.hit, crit:r.crit, damage:r.damage, killed:!!r.killed, exp:r.exp, preview:r.preview, counter:counter, counterExp:counterExp, counterKilled:counterKilled, counterTarget:counterTarget };
    this._finish(result);
  };
  SC.BattleScene.prototype._syncHp = function(){
    var sync=function(bar, unit){
      if(!bar) return;
      bar.fill.width = 140 * (unit.hp / unit.maxHp);
      bar.tx.setText(unit.hp+'/'+unit.maxHp);
      bar.fill.fillColor = unit.hp/unit.maxHp>0.5?0x2ecc71:unit.hp/unit.maxHp>0.25?0xf1c40f:0xe74c3c;
    };
    sync(this.leftHp, this.atk); sync(this.rightHp, this.def);
  };
  SC.BattleScene.prototype._shake = function(unit, big){
    if(!unit || !unit.go) return;
    var go=unit.go;
    this.tweens.add({ targets:go, x: go.x + (big?8:4), duration: 60, yoyo:true, repeat: big?4:2 });
  };
  SC.BattleScene.prototype._flash = function(bar, col){
    if(!bar||!bar.fill) return;
    var orig=bar.fill.fillColor;
    bar.fill.fillColor=col;
    var self=this;
    this.time.delayedCall(220, function(){ if(bar.fill) bar.fill.fillColor=orig; });
  };
  SC.BattleScene.prototype._finish = function(result){
    var self=this;
    this.time.delayedCall(680, function(){
      self.scene.stop();
      // 通知 Tactics
      if(self.tacticsScene){
        if(self.tacticsScene._aiBattleDone){ var fn=self.tacticsScene._aiBattleDone; self.tacticsScene._aiBattleDone=null; fn(result); }
        else if(self.tacticsScene.onBattleDone) self.tacticsScene.onBattleDone(result);
        else if(self.tacticsScene.onBattleResult) self.tacticsScene.onBattleResult(result);
        if(self.tacticsScene.scene && self.tacticsScene.scene.isPaused()) self.tacticsScene.scene.resume();
      }
    });
  };
})();
