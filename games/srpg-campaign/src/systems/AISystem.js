// SC.AISystem — 敌 AI（向最近玩家移动并攻击）
(function () {
  'use strict';
  var SC = window.SC;
  function AISystem(grid){ this.grid=grid; }
  AISystem.prototype.takeTurn = function(units, battleMgr, onAction){
    var self=this;
    var enemies = units.filter(function(u){return u.side==='enemy'&&u.isAlive()&&!u.hasActed;});
    var players = units.filter(function(u){return u.side==='player'&&u.isAlive();});
    if(!players.length || !enemies.length) return Promise.resolve();
    // 依次行动
    var idx=0;
    function next(){
      if(idx>=enemies.length) return Promise.resolve();
      var e=enemies[idx++]; 
      return self._actOne(e, units, players, battleMgr, onAction).then(next);
    }
    return next();
  };
  AISystem.prototype._actOne = function(e, units, players, battleMgr, onAction){
    // 已在攻击范围则直接打
    var target = this._findInRange(e, players);
    if(target){ e.hasActed=true; if(onAction) return onAction({ type:'attack', from:e, to:target }); else return Promise.resolve(); }
    // 否则向最近玩家寻路
    var best=null, bestPath=null, bestDist=999;
    var occ={}; for(var i=0;i<units.length;i++){ var u=units[i]; if(u===e) continue; if(!u.isAlive()) continue; occ[u.c+','+u.r]=true; }
    var moveSet = SC.calcMoveRange(this.grid, {c:e.c,r:e.r}, e.mov, occ);
    for(var pi=0; pi<players.length; pi++){
      var p=players[pi];
      // 找能攻击到 p 的可达格
      for(var k in moveSet){
        var parts=k.split(','), c=parseInt(parts[0],10), r=parseInt(parts[1],10);
        var d = Math.abs(c-p.c)+Math.abs(r-p.r);
        if(d<=e.range && d>0){
          var dist = Math.abs(e.c-c)+Math.abs(e.r-r);
          if(dist<bestDist){ bestDist=dist; best=p; bestPath={c:c,r:r}; }
        }
      }
    }
    if(bestPath){
      var path = SC.findPath(this.grid, {c:e.c,r:e.r}, bestPath, occ);
      if(path && onAction) return onAction({ type:'moveAttack', from:e, path:path, to:best });
      // 回退：直接瞬移
      e.c=bestPath.c; e.r=bestPath.r; e.hasActed=true;
      if(onAction) return onAction({ type:'attack', from:e, to:best });
    } else {
      // 向最近玩家靠近一步
      var nearest=players[0], nd=999;
      for(var j=0;j<players.length;j++){ var pj=players[j]; var dd=Math.abs(e.c-pj.c)+Math.abs(e.r-pj.r); if(dd<nd){nd=dd; nearest=pj;} }
      // 取 moveSet 中最接近 nearest 的格
      var best2=null, bd=999;
      for(var k2 in moveSet){ var pt=k2.split(','); var cc=parseInt(pt[0],10), rr=parseInt(pt[1],10); var d2=Math.abs(cc-nearest.c)+Math.abs(rr-nearest.r); if(d2<bd){bd=d2; best2={c:cc,r:rr}; } }
      if(best2){
        var path2=SC.findPath(this.grid,{c:e.c,r:e.r},best2,occ);
        if(path2 && onAction) return onAction({ type:'move', from:e, path:path2 });
        e.c=best2.c; e.r=best2.r;
      }
      e.hasActed=true;
    }
    return Promise.resolve();
  };
  AISystem.prototype._findInRange = function(e, players){
    for(var i=0;i<players.length;i++){ var p=players[i]; var d=Math.abs(e.c-p.c)+Math.abs(e.r-p.r); if(d<=e.range && d>0) return p; }
    return null;
  };
  SC.AISystem = AISystem;
})();
