// RS.Resource — 资源点
(function () {
  'use strict';
  var RS = window.RS;
  function Resource(type, c, r, amount){
    this.type=type; this.c=c; this.r=r; this.amount=amount; this.maxAmount=amount;
    this.go=null;
  }
  Resource.prototype.createGO=function(scene, grid){
    var p=grid.cellToWorld(this.c,this.r);
    var col=this.type==='gold'?0xf1c40f:0x2ecc71;
    var bg=scene.add.rectangle(p.x,p.y,26,26,col);
    bg.setStrokeStyle(1.2,0xffffff,0.85);
    var tx=scene.add.text(p.x,p.y-1,this.type==='gold'?'Au':'Wd',{fontSize:'9px', color:'#0e1628', fontStyle:'bold'}).setOrigin(0.5);
    var barBg=scene.add.rectangle(p.x,p.y+14,26,3,0x000000,0.5);
    var bar=scene.add.rectangle(p.x-13,p.y+14,26,3,col); bar.setOrigin(0,0.5);
    bg.setDepth(8); tx.setDepth(9);
    this.go={ bg:bg, tx:tx, bar:bar, barBg:barBg };
    this._sync();
  };
  Resource.prototype._sync=function(){ if(!this.go) return; this.go.bar.width=26*(this.amount/this.maxAmount); };
  Resource.prototype.extract=function(n){ var got=Math.min(n,this.amount); this.amount-=got; this._sync(); if(this.amount<=0){ if(this.go){ try{this.go.bg.destroy(); this.go.tx.destroy(); this.go.bar.destroy(); this.go.barBg.destroy();}catch(e){}} } return got; };
  Resource.prototype.isDepleted=function(){ return this.amount<=0; };
  RS.Resource = Resource;
})();
