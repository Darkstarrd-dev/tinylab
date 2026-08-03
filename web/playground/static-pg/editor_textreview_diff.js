// editor_textreview_diff.js — 行级决策应用（移植自 novelhelper/frontend/src/utils/alignedDiff.ts::applyLineDecisions）。
// 纯 JS、无依赖、无构建。仅移植 applyLineDecisions；行对齐 diff 复用 editor.js 的 window.editorAlignedDiff。
// 与 editor.js 同风格：顶层 'use strict' + function 声明 + 末尾 window.X = ... 赋值。

'use strict';

/**
 * 应用行级决策生成最终文本。
 * rows 即 window.editorAlignedDiff(oldText, newText) 的输出（DiffRow[]）；
 * decisions 键 = diff 行索引，值 = 行决策。
 *
 * window.TR API（本文件提供）：
 *   TR.applyLineDecisions(rows, decisions) -> string  最终文本
 *
 * @typedef {Object} DiffSide
 *   @property {number|null} num 行号（context/mod/del 为左侧行号，add 为右侧；null 表示无对应侧）
 *   @property {string} text 行文本
 *
 * @typedef {Object} DiffRow 由 window.editorAlignedDiff 产出，字段与 novelhelper alignedDiff.ts::DiffRow 完全一致
 *   @property {'context'|'del'|'add'|'mod'} type
 *   @property {DiffSide|null} left
 *   @property {DiffSide|null} right
 *   @property {{text:string, removed?:boolean}[]} [leftParts]  mod 行的字符级片段（左侧渲染）
 *   @property {{text:string, added?:boolean}[]} [rightParts]  mod 行的字符级片段（右侧渲染）
 *
 * @typedef {Object} LineDecision
 *   @property {'accept'|'reject'|'edit'} action accept（默认）采用清理结果；reject 恢复原文行；edit 用 content 覆盖
 *   @property {string} [content] 仅 action='edit' 时使用
 */

/**
 * 决策键 = diff 行索引。accept（默认）采用清理结果；reject 恢复原文行；edit 用编辑内容。
 * - context：始终采用右侧（清理后）文本。
 * - mod：accept → 右侧；reject → 左侧（原文）；edit → content（缺省回退右侧）。
 * - add：reject → 该行不出现；否则 accept/edit 取右侧或 content。
 * - del：accept（默认）→ 不输出；reject → 恢复左侧原文；edit → content（缺省回退左侧）。
 */
function applyLineDecisions(rows, decisions) {
  var out = [];
  for (var idx = 0; idx < rows.length; idx++) {
    var row = rows[idx];
    var d = decisions ? decisions[idx] : null;
    switch (row.type) {
      case 'context':
        out.push(row.right.text);
        break;
      case 'mod':
        if (d && d.action === 'reject') out.push(row.left.text);
        else if (d && d.action === 'edit') out.push(d.content != null ? d.content : row.right.text);
        else out.push(row.right.text);
        break;
      case 'add':
        if (d && d.action === 'reject') break; // 拒绝新增 → 该行不出现
        out.push((d && d.action === 'edit') ? (d.content != null ? d.content : row.right.text) : row.right.text);
        break;
      case 'del':
        // 接受删除（默认）→ 不输出；拒绝删除 → 恢复原文行
        if (d && d.action === 'reject') out.push(row.left.text);
        else if (d && d.action === 'edit') out.push(d.content != null ? d.content : row.left.text);
        break;
    }
  }
  return out.join('\n');
}

// ===================== exported API =====================

window.TR = window.TR || {};
window.TR.applyLineDecisions = applyLineDecisions;