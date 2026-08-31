// RS.Unit — 单位（移动+采集+战斗）
(function () {
  'use strict';
  var RS = window.RS;
  function Unit(def, side, x, y){
    this.def=def; this.side=side;
    this.x=x; this.y=y;
    this.c=0; this.r=0;
    this.hp=def.hp; this.maxHp=def.hp;
    this.atk=def.atk; this.defStat=def.def||2;
    this.range=def.range; this.sight=def.sight||5;
    this.alive=true;
    this.state='idle'; // idle/move/gather/attack
    this.target=null; // {x,y} or Unit/Building/Resource
    this.path=null; this.pathIdx=0;
    this.gatherCD=0; this.attackCD=0;
    this.go=null; this._hpBar=null;
    this.vx=0; this.vy=0;
  }
  Unit.prototype.setCell=function(c,r,grid){ this.c=c; this.r=r; if(grid){ var p=grid.cellToWorld(c,r); this.x=p.x; this.y=p.y; } };
  Unit.prototype.createGO=function(scene, grid){
    var pos={x:this.x, y:this.y};
    if(grid){ var p=grid.cellToWorld(this.c,this.r); pos=p; this.x=p.x; this.y=p.y; }
    var col=this.side==='enemy'?0xe74c3c: this.def.color;
    var cont=scene.add.container(pos.x,pos.y);
    var bg=scene.add.rectangle(0,0,22,22,col);
    bg.setStrokeStyle(1.4,0xffffff,0.9);
    var tx=scene.add.text(0,-1,this.def.abbr,{fontSize:'9px', color:'#0e1628', fontStyle:'bold'}).setOrigin(0.5);
    var barBg=scene.add.rectangle(0,12,22,3,0x000000,0.5);
    var bar=scene.add.rectangle(-11,12,22,3,0x2ecc71); bar.setOrigin(0,0.5);
    cont.add([bg,tx,barBg,bar]);
    cont.setDepth(12);
    bg.setInteractive({useHandCursor:true});
    var self=this;
    bg.on('pointerdown', function(){ if(scene.onUnitPicked) scene.onUnitPicked(self); });
    this.go=cont; this._bg=bg; this._bar=bar; this._barBg=barBg;
    this._syncHp();
  };
  Unit.prototype._syncHp=function(){
    if(!this._bar) return;
    var w=22*(this.hp/this.maxHp);
    this._bar.width=Math.max(0,w);
    this._bar.fillColor=this.hp/this.maxHp>0.5?0x2ecc71:this.hp/this.maxHp>0.25?0xf1c40f:0xe74c3c;
  };
  Unit.prototype.takeDamage=function(n){
    var dmg=Math.max(1, n - this.defStat);
    this.hp-=dmg; if(this.hp<=0){ this.hp=0; this.alive=false; if(this.go) this.go.setVisible(false); }
    this._syncHp(); return !this.alive;
  };
  Unit.prototype.setSelected=function(on){ if(this._bg) this._bg.setStrokeStyle(on?2.4:1.4, on?0x2ecc71:0xffffff,0.95); };
  Unit.prototype.moveTo=function(targetCell, grid, occupied){
    var path=RS.findPath(grid, {c:this.c,r:this.r}, targetCell, occupied);
    if(!path||path.length<2) return false;
    this.path=path; this.pathIdx=1; this.state='move'; this.target=targetCell;
    return true;
  };
  Unit.prototype.stop=function(){ this.path=null; this.state='idle'; this.vx=0; this.vy=0; };
  RS.Unit = Unit;
})();
