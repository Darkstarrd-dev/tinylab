// =============================================================================
// Unit04 — 补间与时间（Tweens & Time）
// =============================================================================
// 【这一节学什么】
//   • tweens：把一个对象的属性在一段时间内平滑地“补”过去（移动、缩放、旋转…）
//     参考 C:/omp/Phaser 第 07 节 tweens
//   • time：delayedCall / addEvent 计时器（一次性 vs 循环）
//     参考第 14 节 time；注意 v4 没有 deltaMS，用回调的 time 减去上一次 time
//   • 用 4 个小块并排演示：上下往返 / 缩放旋转 / 网格 stagger / 数字 counter
// =============================================================================
(function () {
  'use strict';
  window.TRGames.register({
    id: 'Unit04',
    title: '示例单元 04 — 补间与时间',
    launch: function (host) {
      var Phaser = host.phaser;
      if (!Phaser) throw new Error('Phaser not loaded');
      var container = host.container, W = host.width || 800, H = host.height || 450;

      var Scene = new (Phaser.Scene)('Tweens');

      Scene.create = function () {
        this.cameras.main.setBackgroundColor('#0f172a');

        // —— 生成贴图 ——
        var gfx = this.make.graphics();
        gfx.fillStyle(0x4a90d9); gfx.fillCircle(20, 20, 18);
        gfx.generateTexture('dot', 40, 40); gfx.clear();
        gfx.fillStyle(0x22c55e); gfx.fillRect(0, 0, 36, 36);
        gfx.generateTexture('box', 36, 36);
        gfx.destroy();

        var midY = Math.round(H * 0.52);
        var xs = [W * 0.22, W * 0.40, W * 0.60, W * 0.80];

        // 1) 上下往返：y 在 700ms 内上下 yoyo，无限循环，缓动用 Sine
        var a = this.add.image(xs[0], midY, 'dot');
        this.tweens.add({
          targets: a, y: midY - 46, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.inOut'
        });

        // 2) 缩放+旋转：把 scale 与 angle 一起补，数组值会在区间内插值
        var b = this.add.image(xs[1], midY, 'box');
        this.tweens.add({
          targets: b, scaleX: 1.5, scaleY: 1.5, angle: 180, duration: 900,
          yoyo: true, repeat: -1, ease: 'Cubic.easeInOut'
        });

        // 3) 网格 stagger：做一个 3×3 的小方格，从中心向外依次延迟出现（stagger）
        var grid = [];
        for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) {
          grid.push(this.add.rectangle(xs[2] + (c - 1) * 18, midY + (r - 1) * 18, 12, 12, 0xeab308));
        }
        this.tweens.add({
          targets: grid, alpha: { from: 0, to: 1 }, scale: { from: 0.2, to: 1 },
          duration: 500, ease: 'Back.out', delay: this.tweens.stagger(60, { from: 'center' })
        });

        // 4) 数字 counter：用 addCounter 把文字从 0 数到 100
        var counterText = this.add.text(xs[3], midY, '0', { color: '#e8e8e8', fontSize: '18px' }).setOrigin(0.5);
        this.tweens.addCounter({
          from: 0, to: 100, duration: 2200, ease: 'Linear',
          onUpdate: function (tween) { counterText.setText(String(Math.round(tween.getValue()))); },
          yoyo: true, repeat: -1, repeatDelay: 300
        });

        // 标签
        var labels = ['yoyo 上下', 'scale+angle', 'stagger 网格', 'counter'];
        for (var i = 0; i < labels.length; i++) {
          this.add.text(xs[i], midY + 54, labels[i], { color: '#64748b', fontSize: '11px' }).setOrigin(0.5, 0);
        }

        // 计时器示例：每 900ms 在顶部闪一条提示（loop 循环）；5 秒后改数字颜色（一次性）
        var hint = this.add.text(W / 2, 16, '时间：每 900ms 闪一次 · 5s 后数字变红', {
          color: '#8b949e', fontSize: '11px'
        }).setOrigin(0.5, 0);
        this.time.addEvent({
          delay: 900, loop: true, callback: function () {
            hint.setAlpha(0.25); this.tweens.add({ targets: hint, alpha: 1, duration: 260 });
          }, callbackScope: this
        });
        this.time.delayedCall(5000, function () { counterText.setColor('#ff6b6b'); });

        this.add.text(W / 2, H - 14, '改 duration/ease 就能调速度与手感 · 点 Run 可反复观察缓动差异', {
          color: '#334155', fontSize: '10px'
        }).setOrigin(0.5, 0.5);

        window.__trgame = { game: this.game, getState: function () { return { id: 'Unit04', running: true }; } };
      };

      return new Phaser.Game({
        type: Phaser.AUTO, parent: container, width: W, height: H,
        backgroundColor: '#0f172a', scene: [Scene]
      });
    }
  });
})();
