// RS.AIManager — 敌 AI（采集→造兵→集结→进攻，简化 FSM）
(function () {
  'use strict';
  var RS = window.RS;
  function AIManager(scene){ this.scene=scene; this.tick=0; this.phase='gather'; }
  AIManager.prototype.update=function(dt){
    if(!this.scene.state.settings.ai) return;
    this.tick+=dt;
    if(this.tick < 1200) return;
    this.tick=0;
    var st=this.scene.state;
    // 1) 工兵不足补工兵
    var myWorkers=this.scene.units.filter(function(u){return u.side==='enemy'&&u.def.id==='worker'&&u.alive;}).length;
    var myBase=this.scene.buildings.filter(function(b){return b.side==='enemy'&&b.def.id==='base'&&b.alive;})[0];
    if(myWorkers<4 && myBase && myBase.queue.length===0) myBase.enqueue('worker');
    // 2) 有钱造兵营/靶场
    if(st.gold>120 && st.wood>40){
      var hasBarracks=this.scene.buildings.some(function(b){return b.side==='enemy'&&b.def.id==='barracks';});
      if(!hasBarracks && myBase) this.scene.aiBuild('barracks');
    }
    // 3) 兵营造步兵
    var barracks=this.scene.buildings.filter(function(b){return b.side==='enemy'&&b.def.id==='barracks'&&b.alive;});
    for(var i=0;i<barracks.length;i++){
      if(barracks[i].queue.length<1){
        var pick = Math.random()<0.5 ? 'rifle' : 'tank';
        if(st.canAfford(RS.getUnitDef(pick).cost)) barracks[i].enqueue(pick);
      }
    }
    // 4) 工兵采集（若 idle）
    var enemyResources=this.scene.resources.filter(function(r){return !r.isDepleted();});
    for(var w=0; w<this.scene.units.length; w++){
      var u=this.scene.units[w];
      if(u.side!=='enemy'||!u.alive||u.def.id!=='worker'||u.state!=='idle') continue;
      if(enemyResources.length){
        var r=enemyResources[Math.floor(Math.random()*enemyResources.length)];
        u.state='gather'; u.gatherTarget=r; u.moveTo({c:r.c,r:r.r}, this.scene.grid, null);
      }
    }
    // 5) 集结进攻
    var fighters=this.scene.units.filter(function(u){return u.side==='enemy'&&u.alive&&u.def.id!=='worker';});
    if(fighters.length>=6){
      var targetBase=this.scene.buildings.filter(function(b){return b.side==='player'&&b.def.id==='base'&&b.alive;})[0];
      if(targetBase){
        for(var f=0;f<fighters.length;f++){
          if(fighters[f].state==='idle'){
            fighters[f].moveTo({c:targetBase.c, r:targetBase.r}, this.scene.grid, null);
          }
        }
      }
    }
    // 6) 接敌自寻（近距自动切 attack 在 CombatSystem）
  };
  RS.AIManager = AIManager;
})();
