// TD.WaveManager — 波次调度
(function () {
  'use strict';
  var TD = window.TD;
  function WaveManager(level, scene) {
    this.level = level; this.scene = scene;
    this.waveIndex = -1; // 未开始
    this.spawning = false;
    this.spawnTimer = 0; this.spawnCount = 0;
    this.prepLeft = TD.CFG.PREP_TIME;
    this.autoNext = false;
  }
  WaveManager.prototype.currentWave = function () {
    if (this.waveIndex < 0 || this.waveIndex >= this.level.waves.length) return null;
    return this.level.waves[this.waveIndex];
  };
  WaveManager.prototype.startNextWave = function () {
    if (this.waveIndex + 1 >= this.level.waves.length) return false;
    this.waveIndex++; this.spawning = true; this.spawnCount = 0; this.spawnTimer = 0;
    this.prepLeft = 0;
    return true;
  };
  WaveManager.prototype.isAllWavesDone = function () {
    return this.waveIndex >= this.level.waves.length - 1 && !this.spawning;
  };
  WaveManager.prototype.isWaveInProgress = function () { return this.spawning; };
  WaveManager.prototype.update = function (dt) {
    if (this.waveIndex === -1) {
      this.prepLeft -= dt;
      if (this.prepLeft <= 0) this.startNextWave();
      return;
    }
    if (!this.spawning) return;
    var w = this.currentWave(); if (!w) { this.spawning = false; return; }
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.spawnCount < w.count) {
      this.scene.spawnEnemy(w.enemyId, w.hpMul, w.speedMul, 1);
      this.spawnCount++;
      this.spawnTimer = w.interval;
      if (this.spawnCount >= w.count) this.spawning = false;
    }
  };
  TD.WaveManager = WaveManager;
})();
