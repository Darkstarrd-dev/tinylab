// ===================== RaccoonQR =====================
// 二维码生成（零依赖，供 Free Hub 本地登录页使用）。
//
// 移植自参考实现 ref/deepseek-harness-codearts/src/raccoon-qr.ts（该实现已在
// 插件里被用户真实扫码验证过）。**逻辑逐行对齐，不要"顺手优化"** —— 改错了会
// 产出扫不出来的码，而这种缺陷只能靠手机复现，代价极高。
//
// 实现范围（刻意最小，与参考实现一致）：
//   - byte 模式（UTF-8 字节）
//   - 纠错等级 M
//   - 版本 1–10（上限 213 字节，够编码约 145 字节的登录 URL）
// 不做数字/字母数字模式、不做更高纠错等级、不做版本 11+；超出容量**抛错**
// （由调用方缩短内容），而不是静默产出坏码。
//
// 算法依据 ISO/IEC 18004，结构与 Nayuki 参考实现（MIT）一致。
//
// ⚠️ 为什么放在浏览器端而不是服务端：Free Hub 的登录页是**静态页**（见
// web/static/free-hub-login.html），二维码内容由 /api/jethub/login-page 取回，
// 页面自己渲染。参考实现选择宿主侧渲染是因为它没有服务器；本项目已有 HTTP
// 服务，静态页 + 一个数据端点更简单，也避免在 Go 里重写一遍纠错/掩码逻辑。

var RaccoonQR = (function() {
  'use strict';

  // 各版本（1–10）纠错等级 M 的**数据码字**总数。
  var DATA_CODEWORDS = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];

  // 各版本（1–10）纠错等级 M 的块结构：ecPerBlock + [块数, 每块数据码字数]。
  var EC_BLOCKS_M = [
    undefined,
    { ecPerBlock: 10, groups: [[1, 16]] },
    { ecPerBlock: 16, groups: [[1, 28]] },
    { ecPerBlock: 26, groups: [[1, 44]] },
    { ecPerBlock: 18, groups: [[2, 32]] },
    { ecPerBlock: 24, groups: [[2, 43]] },
    { ecPerBlock: 16, groups: [[4, 27]] },
    { ecPerBlock: 18, groups: [[4, 31]] },
    { ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
    { ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
    { ecPerBlock: 26, groups: [[4, 43], [1, 44]] }
  ];

  // ── GF(256) 运算（本原多项式 0x11D） ──────────────────────────────

  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);
  (function() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if ((x & 0x100) !== 0) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255] || 0;
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[(GF_LOG[a] || 0) + (GF_LOG[b] || 0)] || 0;
  }

  function polyMul(a, b) {
    var result = new Array(a.length + b.length - 1);
    for (var i = 0; i < result.length; i++) result[i] = 0;
    for (var p = 0; p < a.length; p++) {
      for (var q = 0; q < b.length; q++) {
        result[p + q] ^= gfMul(a[p] || 0, b[q] || 0);
      }
    }
    return result;
  }

  // 生成 degree 次 Reed-Solomon 生成多项式（最高次在前）。
  function rsGeneratorPoly(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      poly = polyMul(poly, [1, GF_EXP[i] || 0]);
    }
    return poly;
  }

  // 计算 Reed-Solomon 纠错码字（综合除法取余）。
  function rsEncode(data, ecCount) {
    var gen = rsGeneratorPoly(ecCount);
    var buf = data.slice();
    for (var i = 0; i < ecCount; i++) buf.push(0);
    for (var k = 0; k < data.length; k++) {
      var coef = buf[k] || 0;
      if (coef === 0) continue;
      for (var j = 0; j < gen.length; j++) {
        buf[k + j] ^= gfMul(gen[j] || 0, coef);
      }
    }
    return buf.slice(data.length);
  }

  // ── 数据编码 ──────────────────────────────────────────────────────

  // 选能容纳 byteLength 字节的最小版本；都装不下返回 undefined。
  function pickVersion(byteLength) {
    for (var version = 1; version <= 10; version++) {
      var capacityBits = (DATA_CODEWORDS[version] || 0) * 8;
      // 模式指示符 4 位 + 字符计数（版本 1–9 是 8 位，10 起是 16 位）
      var overheadBits = 4 + (version <= 9 ? 8 : 16);
      if (overheadBits + byteLength * 8 <= capacityBits) return version;
    }
    return undefined;
  }

  // 把字节编码成交织后的完整码字序列（数据 + 纠错，按块交织）。
  function buildCodewords(bytes, version) {
    var blocks = EC_BLOCKS_M[version];
    if (blocks === undefined) throw new Error('raccoon: 不支持的二维码版本 ' + version);

    var totalDataCodewords = DATA_CODEWORDS[version] || 0;
    var capacityBits = totalDataCodewords * 8;

    // 1) 位流：模式 + 计数 + 数据 + 终止符 + 补齐
    var bits = [];
    function pushBits(value, length) {
      for (var i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
    }
    pushBits(0x4, 4); // byte 模式
    pushBits(bytes.length, version <= 9 ? 8 : 16);
    for (var b = 0; b < bytes.length; b++) pushBits(bytes[b], 8);

    // 终止符最多 4 位（容量刚好时可以为 0 位）
    var terminator = Math.min(4, capacityBits - bits.length);
    pushBits(0, terminator);
    // 补齐到字节边界
    while (bits.length % 8 !== 0) bits.push(0);
    // 交替填充字节
    var PAD_BYTES = [0xec, 0x11];
    for (var i = 0; bits.length < capacityBits; i++) {
      pushBits(PAD_BYTES[i % 2] || 0, 8);
    }

    // 2) 位流 → 数据码字
    var dataCodewords = [];
    for (var off = 0; off < bits.length; off += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | (bits[off + j] || 0);
      dataCodewords.push(byte);
    }

    // 3) 切块 + 逐块算纠错
    var dataBlocks = [];
    var ecBlocks = [];
    var offset = 0;
    for (var g = 0; g < blocks.groups.length; g++) {
      var count = blocks.groups[g][0];
      var dataPerBlock = blocks.groups[g][1];
      for (var n = 0; n < count; n++) {
        var block = dataCodewords.slice(offset, offset + dataPerBlock);
        offset += dataPerBlock;
        dataBlocks.push(block);
        ecBlocks.push(rsEncode(block, blocks.ecPerBlock));
      }
    }

    // 4) 交织：先按序取各块的数据码字，再按序取各块的纠错码字
    var result = [];
    var maxDataLen = 0;
    for (var d = 0; d < dataBlocks.length; d++) {
      if (dataBlocks[d].length > maxDataLen) maxDataLen = dataBlocks[d].length;
    }
    for (var idx = 0; idx < maxDataLen; idx++) {
      for (var bi = 0; bi < dataBlocks.length; bi++) {
        if (idx < dataBlocks[bi].length) result.push(dataBlocks[bi][idx] || 0);
      }
    }
    for (var e = 0; e < blocks.ecPerBlock; e++) {
      for (var ei = 0; ei < ecBlocks.length; ei++) {
        result.push(ecBlocks[ei][e] || 0);
      }
    }
    return result;
  }

  // ── 矩阵构造 ──────────────────────────────────────────────────────

  // 对齐图案中心坐标（版本 1 无）。
  function alignmentPositions(version, size) {
    if (version === 1) return [];
    var numAlign = Math.floor(version / 7) + 2;
    var step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  // 画 finder pattern（含分隔符，x/y 是中心）。
  function drawFinderPattern(modules, isFunction, size, x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var xx = x + dx;
        var yy = y + dy;
        if (xx < 0 || xx >= size || yy < 0 || yy >= size) continue;
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        // dist 4 = 分隔符（浅色），2 = 内圈（浅色），其余深色
        var dark = dist !== 2 && dist !== 4;
        modules[yy][xx] = dark;
        isFunction[yy][xx] = true;
      }
    }
  }

  // 画 alignment pattern（x/y 是中心）。
  function drawAlignmentPattern(modules, isFunction, x, y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        var dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
        modules[y + dy][x + dx] = dark;
        isFunction[y + dy][x + dx] = true;
      }
    }
  }

  // 画全部功能图案（timing / finder / alignment / 版本信息）。
  function drawFunctionPatterns(modules, isFunction, size, version) {
    // timing pattern
    for (var i = 0; i < size; i++) {
      var dark = i % 2 === 0;
      modules[6][i] = dark;
      isFunction[6][i] = true;
      modules[i][6] = dark;
      isFunction[i][6] = true;
    }

    // 三个 finder（会覆盖部分 timing，符合规范）
    drawFinderPattern(modules, isFunction, size, 3, 3);
    drawFinderPattern(modules, isFunction, size, size - 4, 3);
    drawFinderPattern(modules, isFunction, size, 3, size - 4);

    // alignment
    var positions = alignmentPositions(version, size);
    var n = positions.length;
    for (var a = 0; a < n; a++) {
      for (var b = 0; b < n; b++) {
        // 跳过三个 finder 角落
        var isCorner = (a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0);
        if (isCorner) continue;
        drawAlignmentPattern(modules, isFunction, positions[a] || 0, positions[b] || 0);
      }
    }

    // 预留格式信息区（稍后写入真实值）
    drawFormatBits(modules, isFunction, size, 0);

    // 版本信息（版本 >= 7）
    if (version >= 7) {
      var rem = version;
      for (var v = 0; v < 12; v++) {
        rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      }
      var bits = (version << 12) | rem;
      for (var k = 0; k < 18; k++) {
        var isDark = ((bits >> k) & 1) === 1;
        var col = size - 11 + (k % 3);
        var row = Math.floor(k / 3);
        modules[row][col] = isDark;
        isFunction[row][col] = true;
        modules[col][row] = isDark;
        isFunction[col][row] = true;
      }
    }
  }

  // 写入格式信息（纠错等级 + 掩码号），两份拷贝。纠错等级 M 的 formatBits 是 0b00。
  function drawFormatBits(modules, isFunction, size, mask) {
    var data = (0x0 << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    var bits = ((data << 10) | rem) ^ 0x5412;

    function set(x, y, dark) {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    }
    function bit(i) { return ((bits >> i) & 1) === 1; }

    // 第一份：第 8 列（行 0..5、7、8）+ 第 8 行（列 8、7、5..0）
    for (var a = 0; a <= 5; a++) set(8, a, bit(a));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (var b = 9; b < 15; b++) set(14 - b, 8, bit(b));

    // 第二份：第 8 行右侧 8 列（bits 0..7）+ 第 8 列底部 **7 行**（bits 8..14）
    //
    // ⚠️ 底部 7 格是 **size-7 到 size-1**（版本 1 即 y=14..20），不是
    // size-15+i（那会写到 y=6..12，把 timing 行与数据格一起污染）。
    // (8, size-8) 是固定的深色模块，不承载格式位。
    for (var c = 0; c < 8; c++) set(size - 1 - c, 8, bit(c));
    for (var d = 8; d < 15; d++) set(8, size - 7 + (d - 8), bit(d));

    // 固定的深色模块
    set(8, size - 8, true);
  }

  // 按 zigzag 从右下向上填充数据位。
  function drawCodewords(modules, isFunction, size, codewords) {
    var i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 跳过 timing 列
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (isFunction[y][x] !== true && i < codewords.length * 8) {
            var byte = codewords[i >>> 3] || 0;
            modules[y][x] = ((byte >> (7 - (i & 7))) & 1) === 1;
            i++;
          }
          // 剩余位（0–7 个）保持构造时的浅色，符合规范
        }
      }
    }
  }

  // 应用掩码（XOR，自逆）。
  function applyMask(modules, isFunction, size, mask) {
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (isFunction[y][x] === true) continue;
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) modules[y][x] = !modules[y][x];
      }
    }
  }

  // 单行/单列的规则 1 与规则 3 惩罚。
  function penaltyForLine(line, size, N1, N3) {
    var result = 0;

    // 规则 1：连续同色
    var runLength = 1;
    for (var i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) {
        runLength++;
      } else {
        if (runLength >= 5) result += N1 + (runLength - 5);
        runLength = 1;
      }
    }
    if (runLength >= 5) result += N1 + (runLength - 5);

    // 规则 3：finder-like 图案（两个方向的 11 位窗口）
    var PATTERN_A = [true, false, true, true, true, false, true, false, false, false, false];
    var PATTERN_B = [false, false, false, false, true, false, true, true, true, false, true];
    for (var s = 0; s + 11 <= size; s++) {
      var matchA = true;
      var matchB = true;
      for (var j = 0; j < 11; j++) {
        if (line[s + j] !== PATTERN_A[j]) matchA = false;
        if (line[s + j] !== PATTERN_B[j]) matchB = false;
        if (!matchA && !matchB) break;
      }
      if (matchA) result += N3;
      if (matchB) result += N3;
    }

    return result;
  }

  // 按规范的 4 条规则计算掩码惩罚分（越小越好）。
  //   N1 = 3：同色连续 5 个以上，每多一个 +1
  //   N2 = 3：2×2 同色块
  //   N3 = 40：出现 finder-like 图案（1011101 前后带 4 个浅色）
  //   N4 = 10：深浅比例偏离 50%（每 5% 一档）
  function computePenalty(modules, size) {
    var N1 = 3;
    var N2 = 3;
    var N3 = 40;
    var N4 = 10;
    var result = 0;

    // 规则 1 + 3：逐行
    for (var y = 0; y < size; y++) {
      result += penaltyForLine(modules[y], size, N1, N3);
    }
    // 规则 1 + 3：逐列
    for (var x = 0; x < size; x++) {
      var col = [];
      for (var yy = 0; yy < size; yy++) col.push(modules[yy][x] === true);
      result += penaltyForLine(col, size, N1, N3);
    }

    // 规则 2：2×2 同色块
    for (var r = 0; r < size - 1; r++) {
      for (var c = 0; c < size - 1; c++) {
        var cell = modules[r][c];
        if (cell === modules[r][c + 1] && cell === modules[r + 1][c] && cell === modules[r + 1][c + 1]) {
          result += N2;
        }
      }
    }

    // 规则 4：深浅比例
    var dark = 0;
    for (var i = 0; i < size; i++) {
      for (var j = 0; j < size; j++) if (modules[i][j]) dark++;
    }
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += Math.max(0, k) * N4;

    return result;
  }

  // 生成 QR 模块矩阵。options: { errorCorrection?: 'M', mask?: 0..7 }
  //
  // ⚠️ options.mask 用于**诊断与交叉验证**（与独立实现逐掩码对齐），生产路径
  // 不传，走自动评分。
  function buildQrMatrix(text, options) {
    options = options || {};
    var level = options.errorCorrection || 'M';
    if (level !== 'M') {
      throw new Error('raccoon: 二维码目前只支持纠错等级 M（收到 ' + level + '）');
    }
    var forcedMask = options.mask;
    if (forcedMask !== undefined &&
        (typeof forcedMask !== 'number' || !isFinite(forcedMask) ||
         Math.floor(forcedMask) !== forcedMask || forcedMask < 0 || forcedMask > 7)) {
      throw new Error('raccoon: 掩码必须是 0..7 的整数（收到 ' + String(forcedMask) + '）');
    }

    var bytes = Array.from(new TextEncoder().encode(text));
    var version = pickVersion(bytes.length);
    if (version === undefined) {
      throw new Error('raccoon: 二维码内容过长（' + bytes.length + ' 字节，上限 213 字节），请缩短内容');
    }

    var size = version * 4 + 17;
    var modules = [];
    var isFunction = [];
    for (var i = 0; i < size; i++) {
      var row = new Array(size);
      var frow = new Array(size);
      for (var j = 0; j < size; j++) { row[j] = false; frow[j] = false; }
      modules.push(row);
      isFunction.push(frow);
    }

    drawFunctionPatterns(modules, isFunction, size, version);
    drawCodewords(modules, isFunction, size, buildCodewords(bytes, version));

    // 选惩罚分最低的掩码。
    var bestMask = 0;
    if (forcedMask !== undefined) {
      bestMask = forcedMask;
    } else {
      var bestPenalty = Number.POSITIVE_INFINITY;
      for (var mask = 0; mask < 8; mask++) {
        applyMask(modules, isFunction, size, mask);
        drawFormatBits(modules, isFunction, size, mask);
        var penalty = computePenalty(modules, size);
        if (penalty < bestPenalty) {
          bestPenalty = penalty;
          bestMask = mask;
        }
        applyMask(modules, isFunction, size, mask); // XOR 自逆，撤销
      }
    }
    applyMask(modules, isFunction, size, bestMask);
    drawFormatBits(modules, isFunction, size, bestMask);

    return { size: size, modules: modules };
  }

  // 把矩阵渲染成内联 SVG 字符串（shape-rendering: crispEdges 保证边缘锐利）。
  function renderQrSvg(text, options) {
    options = options || {};
    var px = options.size === undefined ? 158 : options.size;
    var margin = options.margin === undefined ? 4 : options.margin;
    var dark = options.dark || '#000000';
    var light = options.light || '#ffffff';

    var built = buildQrMatrix(text);
    var size = built.size;
    var modules = built.modules;
    var dim = size + margin * 2;

    var segments = [];
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (modules[y][x] === true) {
          segments.push('M' + (x + margin) + ',' + (y + margin) + 'h1v1h-1z');
        }
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" '
      + 'viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img">'
      + '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>'
      + '<path d="' + segments.join('') + '" fill="' + dark + '"/>'
      + '</svg>';
  }

  return {
    buildQrMatrix: buildQrMatrix,
    renderQrSvg: renderQrSvg
  };
})();

// Node 测试用（web/raccoon-qr.test.js 直接 require 本文件）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RaccoonQR;
}
