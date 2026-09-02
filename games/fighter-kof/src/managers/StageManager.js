(function(){
'use strict';
var FKO=window.FKO;
FKO.StageManager=function(scene,stageId){
  this.scene=scene;
  this.stageId=stageId||0;
  this.stageDef=FKO.getStage(this.stageId);
};
FKO.StageManager.prototype.setStage=function(stageId){
  this.stageId=stageId;
  this.stageDef=FKO.getStage(stageId);
  try{ this.scene.cameras.main.setBackgroundColor(this.stageDef.bg); }catch(e){}
};
})();
