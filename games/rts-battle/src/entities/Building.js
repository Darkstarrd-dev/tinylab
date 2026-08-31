// RS.Building — 建筑
(function () {
  'use strict';
  var RS = window.RS;
  function Building(def, side, c, r){
    this.def=def; this.side=side; this.c=c; this.r=r; this.size=def.size||1;
    this.hp=def.hp; this.maxHp=def.hp;
    this.alive=true;
    this.queue=[]; // 待生产 unitId
    this.building=null; this.buildProgress=0;
    this.go=null;
  }
  Building.prototype.createGO=function(scene, grid){
    var tile=grid.tile;
    var cx=grid.ox + this.c*tile + tile*this.size/2;
    var cy=grid.oy + this.r*tile + tile*this.size/2;
    var w=tile*this.size - 4, h=tile*this.size - 4;
    var col=this.side==='enemy'?0x7f1d1d: this.def.color;
    var bg=scene.add.rectangle(cx,cy,w,h,col);
    bg.setStrokeStyle(1.5,0xffffff,0.9);
    var tx=scene.add.text(cx,cy-2,this.def.abbr,{fontSize:'10px', color:'#ffffff', fontStyle:'bold'}).setOrigin(0.5);
    var barBg=scene.add.rectangle(cx,cy+h/2-6,w,3,0x000000,0.5);
    var bar=scene.add.rectangle(cx-w/2,cy+h/2-6,w,3,0x2ecc71); bar.setOrigin(0,0.5);
    bg.setDepth(9); tx.setDepth(10); bar.setDepth(10); barBg.setDepth(10);
    bg.setInteractive({useHandCursor:true});
    var self=this;
    bg.on('pointerdown', function(){ if(scene.onBuildingPicked) scene.onBuildingPicked(self); });
    this.go={ bg:bg, tx:tx, bar:bar, barBg:barBg, cx:cx, cy:cy, w:w, h:h };
    this._syncHp();
  };
  Building.prototype._syncHp=function(){ if(!this.go) return; var w=this.go.w*(this.hp/this.maxHp); this.go.bar.width=Math.max(0,w); this.go.bar.fillColor=this.hp/this.maxHp>0.5?0x2ecc71:0xf1c40f; };
  Building.prototype.takeDamage=function(n){ this.hp-=n; if(this.hp<=0){ this.hp=0; this.alive=false; if(this.go){ try{this.go.bg.destroy(); this.go.tx.destroy(); this.go.bar.destroy(); this.go.barBg.destroy();}catch(e){}} } this._syncHp(); return !this.alive; };
  Building.prototype.enqueue=function(unitId){ this.queue.push(unitId); };
  Building.prototype.updateQueue=function(dt, scene){
    if(!this.building && this.queue.length){
      var id=this.queue[0];
      var def=RS.getUnitDef(id);
      if(!scene.state.canAfford(def.cost)) return;
      scene.state.spend(def.cost);
      this.building=id; this.buildProgress=0;
    }
    if(this.building){
      var def2=RS.getUnitDef(this.building);
      this.buildProgress+=dt;
      if(this.buildProgress>=def2.buildTime){
        this.building=null; this.buildProgress=0; this.queue.shift();
        // 产出（在建筑旁空地）
        scene.spawnUnit(def2, this.side, this.c+this.size, this.r+Math.floor(this.size/2));
        if(scene.state) { scene.state.pop++; }
      }
    }
  };
  RS.Building = Building;
})();
