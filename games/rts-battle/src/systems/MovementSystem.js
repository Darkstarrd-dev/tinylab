// RS.MovementSystem — 移动 + 搞笑避让（Boids 排斥 + 抖动）
(function () {
  'use strict';
  var RS = window.RS;
  function MovementSystem(scene){ this.scene=scene; }
  MovementSystem.prototype.update=function(dt, units, grid){
    var sepRadius=26, sepForce=44;
    for(var i=0;i<units.length;i++){
      var u=units[i]; if(!u.alive) continue;
      if(u.state!=='move' || !u.path) continue;
      var targetCell=u.path[u.pathIdx];
      if(!targetCell){ u.stop(); continue; }
      var tp=grid.cellToWorld(targetCell.c, targetCell.r);
      var dx=tp.x - u.x, dy=tp.y - u.y;
      var dist=Math.sqrt(dx*dx+dy*dy);
      if(dist < 6){
        u.pathIdx++;
        if(u.pathIdx >= u.path.length){ u.c=targetCell.c; u.r=targetCell.r; u.stop(); continue; }
        targetCell=u.path[u.pathIdx]; tp=grid.cellToWorld(targetCell.c,targetCell.r); dx=tp.x-u.x; dy=tp.y-u.y; dist=Math.sqrt(dx*dx+dy*dy);
      }
      // 期望速度
      var spd=u.def.spd || RS.CFG.UNIT_SPEED_BASE;
      var vx=0, vy=0;
      if(dist>0){ vx=dx/dist*spd; vy=dy/dist*spd; }
      // 分离（搞笑夸张）
      var sx=0, sy=0, cnt=0;
      for(var j=0;j<units.length;j++){
        if(i===j) continue; var v=units[j]; if(!v.alive) continue;
        var ddx=u.x - v.x, ddy=u.y - v.y;
        var d2=ddx*ddx+ddy*ddy;
        if(d2>1 && d2<sepRadius*sepRadius){
          var d=Math.sqrt(d2);
          var push=(sepRadius - d)/sepRadius;
          // 随机抖动因子（搞笑）
          var jitter = 0.85 + Math.random()*0.7;
          sx += (ddx/d)*push*sepForce*jitter;
          sy += (ddy/d)*push*sepForce*jitter;
          cnt++;
        }
      }
      vx+=sx; vy+=sy;
      // 限速
      var vm=Math.sqrt(vx*vx+vy*vy);
      if(vm > spd*1.25){ vx=vx/vm*spd*1.25; vy=vy/vm*spd*1.25; }
      // 轻微随机扭动（搞笑寻路）
      if(Math.random()<0.06){ var ang=Math.atan2(vy,vx)+(Math.random()-0.5)*0.6; var m=Math.sqrt(vx*vx+vy*vy); vx=Math.cos(ang)*m; vy=Math.sin(ang)*m; }
      u.vx=vx; u.vy=vy;
      u.x += vx*dt/1000; u.y += vy*dt/1000;
      if(u.go){ u.go.x=u.x; u.go.y=u.y; }
      // 同步格
      var cell=grid.worldToCell(u.x,u.y);
      if(grid.inBounds(cell.c,cell.r)){ u.c=cell.c; u.r=cell.r; }
    }
  };
  RS.MovementSystem = MovementSystem;
})();
