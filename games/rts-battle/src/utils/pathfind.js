// RS.Pathfind — A* + 软避让（Boids 风格排斥）
(function () {
  'use strict';
  var RS = window.RS;
  RS.findPath = function(grid, from, to, occupiedSet){
    var key=function(c,r){return c+','+r;};
    if(!grid.inBounds(to.c,to.r) || !grid.isPassable(to.c,to.r)) {
      // 寻最近可通行邻格
      var dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for(var di=0;di<dirs.length;di++){ var nc=to.c+dirs[di][0], nr=to.r+dirs[di][1]; if(grid.isPassable(nc,nr) && !(occupiedSet&&occupiedSet[key(nc,nr)])){ to={c:nc,r:nr}; break; } }
    }
    var open=[from], g={}; g[key(from.c,from.r)]=0;
    var came={}; var closed={};
    function h(a,b){ return Math.abs(a.c-b.c)+Math.abs(a.r-b.r); }
    function popMin(){
      var best=0;
      for(var i=1;i<open.length;i++){
        var ka=key(open[i].c,open[i].r), kb=key(open[best].c,open[best].r);
        var fa=(g[ka]||999)+h(open[i],to), fb=(g[kb]||999)+h(open[best],to);
        if(fa<fb) best=i;
      }
      return open.splice(best,1)[0];
    }
    while(open.length){
      var cur=popMin();
      if(cur.c===to.c && cur.r===to.r){
        var path=[cur]; var kk=key(cur.c,cur.r);
        while(came[kk]){ var p=came[kk]; path.unshift(p); kk=key(p.c,p.r); }
        return path;
      }
      closed[key(cur.c,cur.r)]=true;
      var dirs2=[[1,0],[-1,0],[0,1],[0,-1]];
      for(var i2=0;i2<4;i2++){
        var nc2=cur.c+dirs2[i2][0], nr2=cur.r+dirs2[i2][1];
        if(!grid.inBounds(nc2,nr2)) continue;
        var kk2=key(nc2,nr2);
        if(closed[kk2]) continue;
        if(!grid.isPassable(nc2,nr2)) continue;
        if(occupiedSet && occupiedSet[kk2]) continue;
        var tg=(g[key(cur.c,cur.r)]||0)+1;
        if(g[kk2]===undefined || tg<g[kk2]){ g[kk2]=tg; came[kk2]=cur; var ex=false; for(var j=0;j<open.length;j++) if(open[j].c===nc2&&open[j].r===nr2) ex=true; if(!ex) open.push({c:nc2,r:nr2}); }
      }
    }
    return null;
  };
  // 多单位朝同一目标时，目标点环形散开（避免堆叠）
  RS.spreadTargets = function(center, count, grid){
    var pts=[];
    for(var i=0;i<count;i++){
      var ang = (i / count) * Math.PI*2 + (i%2?0.2:0);
      var rad = 1 + Math.floor(i/6);
      var c = center.c + Math.round(Math.cos(ang)*rad);
      var r = center.r + Math.round(Math.sin(ang)*rad);
      if(grid.inBounds(c,r) && grid.isPassable(c,r)) pts.push({c:c,r:r});
      else pts.push({c:center.c, r:center.r});
    }
    return pts;
  };
})();
