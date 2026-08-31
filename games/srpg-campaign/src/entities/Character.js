// SC.Character — 我方角色（可升级/转职）
(function () {
  'use strict';
  var SC = window.SC;
  function Character(charDef, rosterEntry) {
    var job = SC.getClass(rosterEntry.job);
    SC.Unit.call(this, {
      id: charDef.id, name: charDef.name, abbr: charDef.abbr,
      job: rosterEntry.job, level: rosterEntry.level,
      maxHp: rosterEntry.maxHp, hp: rosterEntry.hp,
      atk: rosterEntry.atk, def: rosterEntry.def, spd: rosterEntry.spd,
      mov: job.mov, range: job.range,
      c:0, r:0, side:'player', exp: rosterEntry.exp, skills: rosterEntry.skills
    });
    this.charDef = charDef;
    this.rosterEntry = rosterEntry;
    this.promoted = !!rosterEntry.promoted;
  }
  Character.prototype = Object.create(SC.Unit.prototype);
  Character.prototype.constructor = Character;
  Character.prototype.syncToRoster = function(){
    var re=this.rosterEntry;
    re.level=this.level; re.exp=this.exp; re.hp=this.hp; re.maxHp=this.maxHp;
    re.atk=this.atk; re.def=this.def; re.spd=this.spd; re.job=this.job; re.skills=this.skills.slice(0);
    re.promoted=this.promoted;
  };
  Character.prototype.gainExp = function(n){
    this.exp += n;
    var leveled=false;
    while(this.exp >= SC.expForLevel(this.level) && this.level < SC.CFG.MAX_LEVEL){
      this.exp -= SC.expForLevel(this.level);
      this.level++;
      leveled=true;
      // 成长掷点
      var job=SC.getClass(this.job);
      var roll = function(rate){ return Math.random()*100 < rate; };
      if(roll(job.growth.hp)) { this.maxHp+=2; this.hp+=2; }
      if(roll(job.growth.atk)) this.atk+=1;
      if(roll(job.growth.def)) this.def+=1;
      if(roll(job.growth.spd)) this.spd+=1;
      // 学技能（每 3 级一被动）
      if(this.level % 3 === 0){
        var pool = SC.getJobSkills(this.job);
        for(var i=0;i<pool.length;i++) if(this.skills.indexOf(pool[i])===-1){ this.skills.push(pool[i]); break; }
      }
      if(this._lvText) this._lvText.setText('Lv'+this.level);
      this._syncHp();
    }
    this.syncToRoster();
    return leveled;
  };
  Character.prototype.canPromoteNow = function(chapterId){
    var opts=SC.canPromote(this, chapterId);
    return opts.length>0;
  };
  Character.prototype.doPromote = function(toJob){
    var job=SC.getClass(toJob); if(!job) return false;
    this.job=toJob; this.mov=job.mov; this.range=job.range;
    // 转职奖励
    this.maxHp+=4; this.hp=Math.min(this.hp+4,this.maxHp);
    this.atk+=2; this.def+=2; this.spd+=1;
    this.promoted=true;
    // 补技能
    var pool=SC.getJobSkills(toJob);
    for(var i=0;i<pool.length;i++) if(this.skills.indexOf(pool[i])===-1) this.skills.push(pool[i]);
    if(this._bg) this._bg.fillColor = job.color;
    this.syncToRoster();
    this._syncHp();
    return true;
  };
  SC.Character = Character;
})();
