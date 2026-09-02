(function(){
'use strict';
var FKO=window.FKO;
FKO.Hud=function(scene){ this.scene=scene; this.objs=[]; };
FKO.Hud.prototype.create=function(){
  var s=this.scene;
  var w=s.scale.width, h=s.scale.height;
  var pad=12;
  // hp bg
  this.hpBgP1=s.add.image(pad, pad, 'pixel').setOrigin(0,0).setDisplaySize(320,18).setTint(0x263238).setDepth(20);
  this.hpBgP2=s.add.image(w-pad-320, pad, 'pixel').setOrigin(0,0).setDisplaySize(320,18).setTint(0x263238).setDepth(20);
  this.hpBarP1=s.add.image(pad, pad, 'pixel').setOrigin(0,0).setDisplaySize(320,18).setTint(0x4caf50).setDepth(21);
  this.hpBarP2=s.add.image(w-pad-320, pad, 'pixel').setOrigin(0,0).setDisplaySize(320,18).setTint(0xef5350).setDepth(21);
  this.hpTextP1=s.add.text(pad+6, pad+2, 'P1 100/100', {fontFamily:'monospace',fontSize:'11px',color:'#ffffff'}).setDepth(22);
  this.hpTextP2=s.add.text(w-pad-6, pad+2, 'P2 100/100', {fontFamily:'monospace',fontSize:'11px',color:'#ffffff'}).setOrigin(1,0).setDepth(22);
  // meter
  this.meterBgP1=s.add.image(pad, pad+22, 'pixel').setOrigin(0,0).setDisplaySize(180,7).setTint(0x1a2332).setDepth(20);
  this.meterBarP1=s.add.image(pad, pad+22, 'pixel').setOrigin(0,0).setDisplaySize(0,7).setTint(0x4fc3f7).setDepth(21);
  this.meterBgP2=s.add.image(w-pad-180, pad+22, 'pixel').setOrigin(0,0).setDisplaySize(180,7).setTint(0x1a2332).setDepth(20);
  this.meterBarP2=s.add.image(w-pad-180, pad+22, 'pixel').setOrigin(0,0).setDisplaySize(0,7).setTint(0xff8a65).setDepth(21);
  // round / wins
  this.roundText=s.add.text(w/2, pad+8, '', {fontFamily:'monospace',fontSize:'12px',color:'#ffffff',stroke:'#000000',strokeThickness:3}).setOrigin(0.5).setDepth(22);
  this.winsText=s.add.text(w/2, pad+28, '', {fontFamily:'monospace',fontSize:'11px',color:'#e0f7fa',stroke:'#000000',strokeThickness:3}).setOrigin(0.5).setDepth(22);
  // combo
  this.comboTextP1=s.add.text(pad, pad+38, '', {fontFamily:'monospace',fontSize:'11px',color:'#ffca28',stroke:'#000000',strokeThickness:3}).setDepth(22);
  this.comboTextP2=s.add.text(w-pad, pad+38, '', {fontFamily:'monospace',fontSize:'11px',color:'#ffca28',stroke:'#000000',strokeThickness:3}).setOrigin(1,0).setDepth(22);
  // center banner
  this.centerText=s.add.text(w/2, h/2-40, '', {fontFamily:'monospace',fontSize:'22px',color:'#ffffff',stroke:'#000000',strokeThickness:5,align:'center'}).setOrigin(0.5).setDepth(30).setVisible(false);
  this.hintText=s.add.text(w/2, h-16, 'O Hitbox  K \u5207\u821E\u53F0  R \u91CD\u5F00  M \u83DC\u5355  Enter \u4E0B\u4E00\u5C40', {fontFamily:'monospace',fontSize:'10px',color:'#90a4ae'}).setOrigin(0.5).setDepth(22);
};
FKO.Hud.prototype.update=function(f1,f2,rm){
  var r1=FKO.clamp(f1.hp/f1.maxHp,0,1);
  var r2=FKO.clamp(f2.hp/f2.maxHp,0,1);
  this.hpBarP1.setDisplaySize(320*r1,18);
  // P2 mirrored: anchor left but shift x
  var w=this.scene.scale.width;
  var pad=12;
  this.hpBarP2.x=(w-pad-320)+320*(1-r2);
  this.hpBarP2.setDisplaySize(320*r2,18);
  // tint thresholds
  var c1=r1<0.3?0xef5350:(r1<0.6?0xffca28:0x4caf50);
  var c2=r2<0.3?0xef5350:(r2<0.6?0xffca28:0xef5350);
  // keep P1 green/red, P2 red
  this.hpBarP1.setTint(c1);
  this.hpBarP2.setTint(c2);
  this.hpTextP1.setText('P1 '+Math.round(f1.hp)+'/'+f1.maxHp + (f1.meter>=FKO.CFG.METER_MAX?'  MAX':''));
  this.hpTextP2.setText('P2 '+Math.round(f2.hp)+'/'+f2.maxHp + (f2.meter>=FKO.CFG.METER_MAX?'  MAX':''));
  var m1=FKO.clamp(f1.meter/FKO.CFG.METER_MAX,0,1);
  var m2=FKO.clamp(f2.meter/FKO.CFG.METER_MAX,0,1);
  this.meterBarP1.setDisplaySize(180*m1,7);
  this.meterBarP2.x=(w-pad-180)+180*(1-m2);
  this.meterBarP2.setDisplaySize(180*m2,7);
  if(rm){
    this.roundText.setText('ROUND '+rm.round);
    this.winsText.setText('P1 '+rm.p1Wins+' - '+rm.p2Wins+' P2');
  }
  this.comboTextP1.setText(f1.comboCount>1? f1.comboCount+' HITS!':'');
  this.comboTextP2.setText(f2.comboCount>1? f2.comboCount+' HITS!':'');
};
FKO.Hud.prototype.showBanner=function(text){
  var self=this;
  this.centerText.setText(text);
  this.centerText.setVisible(true);
  this.scene.time.delayedCall(900, function(){ self.centerText.setVisible(false); });
};
})();
