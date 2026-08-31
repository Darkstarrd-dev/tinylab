// RS.Projectile — 弹道（Rectangle 池）
(function () {
  'use strict';
  var RS = window.RS;
  function Projectile(scene){
    this.scene=scene; this.active=false;
    this.x=0; this.y=0; this.vx=0; this.vy=0;
    this.damage=0; this.target=null; this.life=0;
    this.go=null;
  }
  Projectile.prototype.ensureGO=function(){
    if(this.go) return;
    this.go=this.scene.add.rectangle(0,0,4,4,0xffffff).setDepth(13).setVisible(false).setActive(false);
  };
  Projectile.prototype.fire=function(from, toUnit, damage){
    this.ensureGO();
    this.active=true; this.x=from.x; this.y=from.y; this.damage=damage; this.target=toUnit; this.life=0;
    var ang=Math.atan2(toUnit.y - from.y, toUnit.x - from.x);
    var speed=360;
    this.vx=Math.cos(ang)*speed; this.vy=Math.sin(ang)*speed;
    this.go.x=from.x; this.go.y=from.y; this.go.setVisible(true).setActive(true);
    this.go.fillColor = toUnit.side==='enemy' ? 0xf1c40f : 0xe74c3c;
  };
  Projectile.prototype.update=function(dt){
    if(!this.active) return;
    this.life+=dt; if(this.life>1700){ this.recycle(); return; }
    if(this.target && this.target.alive){
      var ang=Math.atan2(this.target.y - this.y, this.target.x - this.x);
      var cur=Math.atan2(this.vy,this.vx);
      var d=ang-cur; while(d>Math.PI) d-=Math.PI*2; while(d<-Math.PI) d+=Math.PI*2;
      cur+=d*0.09; var sp=Math.sqrt(this.vx*this.vx+this.vy*this.vy); this.vx=Math.cos(cur)*sp; this.vy=Math.sin(cur)*sp;
    }
    this.x+=this.vx*dt/1000; this.y+=this.vy*dt/1000;
    if(this.go){ this.go.x=this.x; this.go.y=this.y; }
    if(this.target && this.target.alive){
      var dx=this.x-this.target.x, dy=this.y-this.target.y;
      if(dx*dx+dy*dy < 144){ this.target.takeDamage(this.damage); this.recycle(); }
    } else if(!this.target||!this.target.alive){ this.recycle(); }
  };
  Projectile.prototype.recycle=function(){ this.active=false; this.target=null; if(this.go) this.go.setVisible(false).setActive(false); };
  RS.Projectile = Projectile;
})();
