// SC.Pathfind — BFS 移动范围 + A* 路径
(function () {
  'use strict';
  var SC = window.SC;
  // 移动范围：BFS 按 moveCost 累计
  SC.calcMoveRange = function (grid, start, mov, occupiedSet) {
    var key = function(c,r){return c+','+r;};
    var dist = {}; dist[key(start.c,start.r)] = 0;
    var q = [start];
    var visited = {};
    var head = 0;
    while (head < q.length) {
      var cur = q[head++];
      var d = dist[key(cur.c,cur.r)];
      var dirs = [[1,0],[-1,0],[0,1],[0,-1]];
      for (var i=0;i<4;i++){
        var nc=cur.c+dirs[i][0], nr=cur.r+dirs[i][1];
        if (!grid.inBounds(nc,nr)) continue;
        var k=key(nc,nr);
        if (visited[k]) continue;
        var cost = grid.terrainDefAt(nc,nr).moveCost;
        if (cost >= 99) continue;
        if (occupiedSet && occupiedSet[k] && !(nc===start.c&&nr===start.r)) continue;
        var nd = d + cost;
        if (nd > mov) continue;
        if (dist[k] === undefined || nd < dist[k]) dist[k]=nd;
        if (!visited[k]) { q.push({c:nc,r:nr}); visited[k]=true; }
      }
    }
    // dist 的 key 即为可达格（含起点）
    var set = {}; for(var kk in dist) set[kk]=true;
    return set;
  };
  // A* 按 moveCost
  SC.findPath = function (grid, from, to, occupiedSet) {
    var key = function(c,r){return c+','+r;};
    var open=[from], came={};
    var g={}; g[key(from.c,from.r)]=0;
    function h(a,b){ return Math.abs(a.c-b.c)+Math.abs(a.r-b.r); }
    function popMin(){
      var best=0;
      for(var i=1;i<open.length;i++){
        var ki=key(open[i].c,open[i].r), kb=key(open[best].c,open[best].r);
        var fi=(g[ki]||999)+h(open[i],to), fb=(g[kb]||999)+h(open[best],to);
        if(fi<fb) best=i;
      }
      return open.splice(best,1)[0];
    }
    var closed={};
    while(open.length){
      var cur=popMin();
      if(cur.c===to.c&&cur.r===to.r){
        var path=[cur];
        var kk=key(cur.c,cur.r);
        while(came[kk]){ var p=came[kk]; path.unshift(p); kk=key(p.c,p.r); }
        return path;
      }
      closed[key(cur.c,cur.r)]=true;
      var dirs=[[1,0],[-1,0],[0,1],[0,-1]];
      for(var i=0;i<4;i++){
        var nc=cur.c+dirs[i][0], nr=cur.r+dirs[i][1];
        if(!grid.inBounds(nc,nr)) continue;
        var kk2=key(nc,nr);
        if(closed[kk2]) continue;
        if(occupiedSet && occupiedSet[kk2] && !(nc===to.c&&nr===to.r)) continue;
        var cost=grid.terrainDefAt(nc,nr).moveCost;
        if(cost>=99) continue;
        var tg=(g[key(cur.c,cur.r)]||0)+cost;
        if(g[kk2]===undefined || tg<g[kk2]){ g[kk2]=tg; came[kk2]=cur; var exists=false; for(var j=0;j<open.length;j++) if(open[j].c===nc&&open[j].r===nr) exists=true; if(!exists) open.push({c:nc,r:nr}); }
      }
    }
    return null;
  };
  // 攻击范围：由 moveRange 各点外扩 range
  SC.calcAttackRange = function (grid, moveSet, range) {
    var atk={};
    for(var k in moveSet){
      var parts=k.split(','); var c=parseInt(parts[0],10), r=parseInt(parts[1],10);
      for(var dc=-range;dc<=range;dc++) for(var dr=-range;dr<=range;dr++){
        if(Math.abs(dc)+Math.abs(dr)===0) continue;
        if(Math.abs(dc)+Math.abs(dr)>range) continue;
        var nc=c+dc,nr=r+dr;
        if(!grid.inBounds(nc,nr)) continue;
        atk[nc+','+nr]=true;
      }
    }
    return atk;
  };
})();
