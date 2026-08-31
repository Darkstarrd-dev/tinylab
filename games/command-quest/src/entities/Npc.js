// CQ.Npc — 事件 NPC（对话、给奖励、触发 AVG、给任务）
(function () {
  'use strict';
  var CQ = window.CQ;
  var NPC_LINES = [
    { text: '前方的路被迷雾笼罩，指挥官，请小心行事。', reward: null },
    { text: '我这里有一份补给，拿去吧。', reward: { type: 'gold', amount: 50 } },
    { text: '这把旧剑或许对你有用。', reward: { type: 'equip', equipId: 'sword_iron' } },
    { text: '愿意加入你们的士兵正在营地等候。', reward: { type: 'soldier', soldierType: 'infantry' } },
    { text: '听说敌人的增援就要到了……', reward: null, triggerAvg: 'mid' }
  ];
  CQ.Npc = function (scene, c, r, rng) {
    CQ.Entity.call(this, scene, c, r);
    this.talked = false;
    this.line = rng ? rng.pick(NPC_LINES) : NPC_LINES[0];
  };
  CQ.Npc.prototype = Object.create(CQ.Entity.prototype);
  CQ.Npc.prototype.constructor = CQ.Npc;
  CQ.Npc.prototype.createGO = function () {
    var p = this.worldPos();
    var g = this.scene.add.container(p.x, p.y);
    var base = this.scene.add.circle(0, 0, 10, 0x2ecc71).setStrokeStyle(1, 0xffffff);
    var tx = this.scene.add.text(0, 12, 'NPC', { fontSize: '7px', color: '#fff' }).setOrigin(0.5);
    g.add([base, tx]); this.go = g; return g;
  };
  CQ.Npc.prototype.talk = function () {
    if (this.talked) return { text: '（已交流过）', reward: null };
    this.talked = true;
    if (this.go) this.go.setAlpha(0.5);
    return this.line;
  };
})();
