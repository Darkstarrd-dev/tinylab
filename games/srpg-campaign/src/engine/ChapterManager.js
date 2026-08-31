// SC.ChapterManager — 章节流转与旗帜
(function () {
  'use strict';
  var SC = window.SC;
  function ChapterManager(gameState) { this.state = gameState; }
  ChapterManager.prototype.getCurrent = function () { return SC.resolveChapter(this.state.chapterId); };
  ChapterManager.prototype.getChapter = function (id) { return SC.resolveChapter(id); };
  ChapterManager.prototype.setFlag = function (k, v) { this.state.flags[k] = v; };
  ChapterManager.prototype.getFlag = function (k) { return this.state.flags[k]; };
  ChapterManager.prototype.testCond = function (cond) {
    if (!cond) return true;
    // 支持：route=A, route=B, flag:xxx, allied>=N
    if (cond.indexOf('route=') === 0) return this.state.flags.route === cond.slice(6);
    if (cond.indexOf('allied') === 0) {
      var m = cond.match(/allied\s*([<>=]+)\s*(\d+)/);
      if (m) {
        var allied = 0;
        if (this.state.flags.recruitValdris) allied++;
        if (this.state.flags.recruitShade) allied++;
        if (this.state.flags.recruitMirelle !== false) allied++; // 2章默认
        var val = parseInt(m[2],10);
        if (m[1] === '>=') return allied >= val;
        if (m[1] === '<') return allied < val;
      }
    }
    if (cond.indexOf('flag:') === 0) return !!this.state.flags[cond.slice(5)];
    return true;
  };
  ChapterManager.prototype.advance = function () {
    this.state.cleared[this.state.chapterId] = true;
    if (this.state.playedChapters.indexOf(this.state.chapterId) === -1) this.state.playedChapters.push(this.state.chapterId);
    if (this.state.chapterId < SC.CHAPTERS.length) this.state.chapterId++;
  };
  ChapterManager.prototype.canPlay = function (chapterId) {
    if (chapterId === 1) return true;
    // 已通关前一章即可选；分支章需对应 route（软门，UI 提示）
    if (this.state.cleared[chapterId - 1]) return true;
    if (this.state.playedChapters.indexOf(chapterId - 1) !== -1) return true;
    return false;
  };
  SC.ChapterManager = ChapterManager;
})();
