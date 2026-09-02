(function(){
'use strict';
var FKO=window.FKO;
FKO.STAGES=[
  {id:0,name:'道场',bg:'#b8a07a',groundKey:'ground_dojo',bgKey:'bg_dojo',bgm:'dojo'},
  {id:1,name:'霓虹街',bg:'#1a1d2e',groundKey:'ground_city',bgKey:'bg_city',bgm:'city'},
  {id:2,name:'废墟',bg:'#3a2f2f',groundKey:'ground_ruins',bgKey:'bg_ruins',bgm:'ruins'}
];
FKO.getStage=function(id){for(var i=0;i<FKO.STAGES.length;i++) if(FKO.STAGES[i].id===id) return FKO.STAGES[i]; return FKO.STAGES[0];};
})();
