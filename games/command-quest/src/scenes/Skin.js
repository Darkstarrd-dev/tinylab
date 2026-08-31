// CQ.Skin — 占位纹理生成（零外部资源）
// TODO(视觉替换点): 将本文件 generateTexture 批次替换为 this.load.image/spritesheet
(function () {
  'use strict';
  var CQ = window.CQ;
  CQ.Skin = {
    build: function (scene) {
      // 指挥官/士兵已在 Commander.createGO 内用 container+矩形占位，无需额外纹理
      // 预留：若后续改 Sprite，用 scene.textures.generate('cs_commander', {data, width, height})
    }
  };
})();
