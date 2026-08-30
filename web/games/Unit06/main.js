// =============================================================================
// Unit06 — 小游戏综合（Mini Survivor）
// =============================================================================
// 【这一节学什么】
//   • 把前 5 节串起来做一个可玩的小游戏：WASD 移动 + 敌人追击 + 自动射击 +
//     overlap 碰撞判定 + 计分与结束（R 重开）
//   • 参考 C:/omp/Phaser 的 05-physics-arcade / 06-input / 07-tweens / 13-groups
//     但全部改写为适配 TRGames host 容器、中文注释、零外部资源的精简版
//   • 重点坑：v4 overlap 回调参数顺序已变，用 contains 判断组员更稳；传送用
//     body.reset 而非 setPosition
// =============================================================================
(function () {
  'use strict';
  window.TRGames.register({
    id: 'Unit06',
    title: '示例单元 06 — 小游戏综合',
    launch: function (host) {
      var Phaser = host.phaser;
      if (!Phaser) throw new Error('Phaser not loaded');
      var container = host.container, W = host.width || 800, H = host.height || 450;

      // 可调参数：改数字再点 Run 立刻生效
      var PLAYER_SPEED = 220;   // 玩家移动速度（像素/秒）
      var ENEMY_SPEED = 78;     // 敌人追击速度
      var BULLET_SPEED = 380;   // 子弹速度
      var SPAWN_INTERVAL = 1100;// 刷怪间隔（毫秒）
      var FIRE_INTERVAL = 520;  // 自动开火间隔

      var Scene = new (Phaser.Scene)('Survivor');

      Scene.create = function () {
        this.cameras.main.setBackgroundColor('#0f172a');

        // —— 贴图：程序生成，不依赖外网 ——
        var g = this.make.graphics();
        g.fillStyle(0x22c55e); g.fillCircle(10, 10, 10); g.generateTexture('player', 20, 20); g.clear();
        g.fillStyle(0xef4444); g.fillRect(0, 0, 16, 16); g.generateTexture('enemy', 16, 16); g.clear();
        g.fillStyle(0xf59e0b); g.fillCircle(4, 4, 4); g.generateTexture('bullet', 8, 8);
        g.destroy();

        // 玩家：Arcade 精灵，可撞墙反弹边界
        this.player = this.physics.add.sprite(W / 2, H / 2, 'player');
        this.player.setCollideWorldBounds(true);
        this.player.setDepth(2);

        // 输入：方向键 + WASD（兼容两种习惯）
        this.cursors = this.input.keyboard.createCursorKeys();
        this.wasd = this.input.keyboard.addKeys('W,A,S,D');
        this.keyR = this.input.keyboard.addKey('R');

        // 组：敌人与子弹（便于批量管理与 overlap 检测）
        this.enemies = this.physics.add.group();
        this.bullets = this.physics.add.group();

        // 状态
        this.score = 0; this.alive = true;
        this.scoreText = this.add.text(10, 10, '得分 0', { color: '#e8e8e8', fontSize: '14px', fontFamily: 'monospace' });
        this.hintText = this.add.text(W / 2, 16, 'WASD/方向键 移动 · 自动射击最近敌人 · 被碰到结束，按 R 重开', {
          color: '#8b949e', fontSize: '11px'
        }).setOrigin(0.5, 0);

        // 定时器：刷怪与开火（记得在关卡结束时通过 scene 事件清理，或依赖 game.destroy）
        var self = this;
        this.spawnTimer = this.time.addEvent({
          delay: SPAWN_INTERVAL, loop: true, callback: function () {
            if (!self.alive) return;
            // 在舞台四周随机刷一个敌人
            var side = Phaser.Math.Between(0, 3), x, y, m = 20;
            if (side === 0) { x = Phaser.Math.Between(0, W); y = -m; }
            else if (side === 1) { x = W + m; y = Phaser.Math.Between(0, H); }
            else if (side === 2) { x = Phaser.Math.Between(0, W); y = H + m; }
            else { x = -m; y = Phaser.Math.Between(0, H); }
            var e = self.enemies.create(x, y, 'enemy');
            e.setDepth(1);
          }
        });
        this.fireTimer = this.time.addEvent({
          delay: FIRE_INTERVAL, loop: true, callback: function () {
            if (!self.alive) return;
            // 找最近的敌人射一发
            var nearest = null, best = Infinity;
            self.enemies.children.iterate(function (en) {
              if (!en || !en.active) return;
              var d = Phaser.Math.Distance.Between(self.player.x, self.player.y, en.x, en.y);
              if (d < best) { best = d; nearest = en; }
            });
            if (!nearest) return;
            var ang = Phaser.Math.Angle.Between(self.player.x, self.player.y, nearest.x, nearest.y);
            var b = self.bullets.create(self.player.x + Math.cos(ang) * 14, self.player.y + Math.sin(ang) * 14, 'bullet');
            if (b && b.body) b.body.setVelocity(Math.cos(ang) * BULLET_SPEED, Math.sin(ang) * BULLET_SPEED);
          }
        });

        // 碰撞：子弹 ↔ 敌人（参数顺序无关写法）
        this.physics.add.overlap(this.bullets, this.enemies, function (a, b) {
          // v4 overlap 的回调参数顺序与 v3 不同，这里用 contains 判断谁是子弹
          var bullet = self.bullets.contains(a) ? a : b;
          var enemy = (bullet === a ? b : a);
          if (!bullet.active || !enemy.active) return;
          bullet.destroy(); enemy.destroy();
          self.score += 10;
          self.scoreText.setText('得分 ' + self.score);
        });
        // 碰撞：玩家 ↔ 敌人（碰到即结束）
        this.physics.add.overlap(this.player, this.enemies, function (playerObj, enemyObj) {
          if (!self.alive) return;
          // 同样用 contains 兼容参数顺序差异
          var hitEnemy = (playerObj === self.player ? enemyObj : playerObj);
          if (!hitEnemy.active) return;
          self.alive = false;
          self.spawnTimer.paused = true; self.fireTimer.paused = true;
          self.physics.pause(); // 冻结物理世界
          var over = self.add.text(W / 2, H / 2, '结束！得分 ' + self.score + '  按 R 重开', {
            color: '#fecaca', fontSize: '18px', fontFamily: 'monospace', backgroundColor: '#1f2937', padding: { x: 10, y: 8 }
          }).setOrigin(0.5);
          over.setDepth(10);
          // 轻微震动提示被击中
          self.cameras.main.shake(220, 0.008);
        });

        window.__trgame = {
          game: this.game,
          getState: function () { return { id: 'Unit06', score: self.score, alive: self.alive }; }
        };
      };

      Scene.update = function () {
        if (!this.alive) {
          // 结束界面：R 重开（JustDown 防连发）
          if (Phaser.Input.Keyboard.JustDown(this.keyR)) this.scene.restart();
          return;
        }
        // 玩家移动：WASD/方向键 → 速度向量，注意斜向归一
        var left = (this.cursors.left.isDown || this.wasd.A.isDown);
        var right = (this.cursors.right.isDown || this.wasd.D.isDown);
        var up = (this.cursors.up.isDown || this.wasd.W.isDown);
        var down = (this.cursors.down.isDown || this.wasd.S.isDown);
        var vx = 0, vy = 0;
        if (left) vx -= PLAYER_SPEED; if (right) vx += PLAYER_SPEED;
        if (up) vy -= PLAYER_SPEED; if (down) vy += PLAYER_SPEED;
        if (vx !== 0 && vy !== 0) { vx *= 0.7071; vy *= 0.7071; }
        this.player.setVelocity(vx, vy);

        // 敌人追击：每帧把速度指向玩家
        var self = this;
        this.enemies.children.iterate(function (en) {
          if (!en || !en.active || !en.body) return;
          var ang = Phaser.Math.Angle.Between(en.x, en.y, self.player.x, self.player.y);
          en.body.setVelocity(Math.cos(ang) * ENEMY_SPEED, Math.sin(ang) * ENEMY_SPEED);
        });

        // 子弹越界清理
        this.bullets.children.iterate(function (b) {
          if (!b || !b.active) return;
          if (b.x < -40 || b.x > W + 40 || b.y < -40 || b.y > H + 40) b.destroy();
        });
      };

      return new Phaser.Game({
        type: Phaser.AUTO, parent: container, width: W, height: H,
        backgroundColor: '#0f172a',
        physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
        scene: [Scene]
      });
    }
  });
})();
