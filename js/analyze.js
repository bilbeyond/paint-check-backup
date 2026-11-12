/**
 * analyze.js — 颜料涂抹合规性分析算法（纯前端，无依赖）
 *
 * 算法基于 4 张已标注样本（2 合规 / 2 不合规）校准：
 *  - 色泽一致性 colorScore：图像平均色度（max(R,G,B)-min(R,G,B)），
 *    合规样本色度明显高于不合规样本（0.0168/0.0180 vs 0.0091/0.0098）
 *  - 纹理均匀度 texScore：去除低频光照后的中频残差，按 32px 分块求标准差，
 *    统计"斑块块"占比（流痕/云斑越多占比越高）
 *  - 综合分 = 0.7 * colorScore + 0.3 * texScore（校准区间见常量）
 *
 * 同时可在 Node 中运行（用于测试）：module.exports 暴露核心函数。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CoatingAnalyzer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- 校准常量（由 tools/feature_dump.js 在 JS 管线下对 4 张样本拟合） ----------
  // JS 管线实测：chroma OK=0.0156/0.0168, BAD=0.0095/0.0089；blkstd_p90 OK=0.0277/0.0203, BAD=0.0198/0.0384
  var TARGET = 640;              // 分析时最长边缩放目标
  var BLUR_K = 41;               // 低频光照去除的盒滤波核
  var BLOCK = 32;                // 分块大小
  var COLOR_LO = 0.0105;         // 平均色度 <= 此值 → 0 分
  var COLOR_HI = 0.0150;         // 平均色度 >= 此值 → 100 分
  var TEX_LO = 0.021;            // 分块残差 std 的 p90 <= 此值 → 100 分
  var TEX_HI = 0.088;            // p90 >= 此值 → 0 分（OK-1 p90=0.0277 → 90 分，综合 98）
  var W_COLOR = 0.8;
  var W_TEX = 0.2;

  // 气泡/裂纹检测参数（形状过滤，接触图像边缘的区域一律忽略）
  var DEFECT_TH = 0.12;          // |resid| 超过此值视为候选缺陷像素
  var BUBBLE_AREA = [40, 600];   // 气泡连通域面积范围
  var BUBBLE_MAXSIDE = 40;       // 气泡外接框最长边上限
  var BUBBLE_ASPECT = 1.4;       // 气泡需接近圆形
  var BUBBLE_FILL = 0.55;        // 气泡需近似实心圆斑
  var CRACK_MINSIDE = 50;        // 裂纹最长边下限
  var CRACK_ASPECT = 4;          // 裂纹长宽比下限
  var CRACK_FILL = 0.35;         // 裂纹细长、外接框填充率低

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function lerpScore(v, lo, hi) {
    // v 越接近 hi → 100，越接近 lo → 0（lo/hi 语义由调用处决定）
    if (hi === lo) return 50;
    return clamp((v - lo) / (hi - lo), 0, 1) * 100;
  }

  // ---------- 图像预处理 ----------
  // 输入 RGBA Uint8ClampedArray 与宽高；输出灰度 Float32Array（面积平均缩放到最长边 TARGET）
  function toGrayResized(rgba, w, h) {
    var scale = Math.min(1, TARGET / Math.max(w, h));
    var nw = Math.max(1, Math.round(w * scale));
    var nh = Math.max(1, Math.round(h * scale));
    var gray = new Float32Array(nw * nh);
    var sx = w / nw, sy = h / nh;
    var chromaSum = 0;
    for (var y = 0; y < nh; y++) {
      var y0 = Math.floor(y * sy), y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
      for (var x = 0; x < nw; x++) {
        var x0 = Math.floor(x * sx), x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
        var r = 0, g = 0, b = 0, n = 0, chromaAcc = 0;
        for (var yy = y0; yy < y1; yy++) {
          var row = yy * w;
          for (var xx = x0; xx < x1; xx++) {
            var i = (row + xx) * 4;
            var R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
            r += R; g += G; b += B; n++;
            var mx = R > G ? (R > B ? R : B) : (G > B ? G : B);
            var mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
            chromaAcc += mx - mn;
          }
        }
        r /= n; g /= n; b /= n;
        gray[y * nw + x] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        chromaSum += chromaAcc / n / 255;
      }
    }
    return { gray: gray, w: nw, h: nh, chromaMean: chromaSum / (nw * nh) };
  }

  // ---------- 盒滤波（与校准脚本一致的可分离盒滤波） ----------
  function boxBlur(src, w, h, k) {
    var tmp = new Float32Array(w * h);
    var out = new Float32Array(w * h);
    var pad = (k - 1) / 2, inv = 1 / k;
    // vertical
    for (var x = 0; x < w; x++) {
      var sum = 0;
      for (var i = -pad; i <= pad; i++) {
        var yy = clamp(i, 0, h - 1);
        sum += src[yy * w + x];
      }
      for (var y = 0; y < h; y++) {
        tmp[y * w + x] = sum * inv;
        var outIdx = clamp(y - pad, 0, h - 1), inIdx = clamp(y + pad + 1, 0, h - 1);
        sum += src[inIdx * w + x] - src[outIdx * w + x];
      }
    }
    // horizontal
    for (var y2 = 0; y2 < h; y2++) {
      var sum2 = 0;
      for (var j = -pad; j <= pad; j++) {
        var xx = clamp(j, 0, w - 1);
        sum2 += tmp[y2 * w + xx];
      }
      for (var x2 = 0; x2 < w; x2++) {
        out[y2 * w + x2] = sum2 * inv;
        var o2 = clamp(x2 - pad, 0, w - 1), i2 = clamp(x2 + pad + 1, 0, w - 1);
        sum2 += tmp[y2 * w + i2] - tmp[y2 * w + o2];
      }
    }
    return out;
  }

  // ---------- 气泡 / 裂纹检测 ----------
  // 在中频残差上做连通域分析，用形状特征分类：
  //   气泡 = 小型近圆形实心亮/暗斑；裂纹 = 大尺度细长结构（长宽比大、填充率低）
  // 接触图像边缘的连通域（涂层与背景交界、裁切边界）一律忽略。
  function detectDefects(resid, w, h) {
    var visited = new Uint8Array(w * h);
    var stack = new Int32Array(w * h);
    var bubbles = 0, cracks = 0;
    var NB = [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1];
    var DX = [-1, 1, 0, 0, -1, 1, -1, 1];
    var DY = [0, 0, -1, 1, -1, -1, 1, 1];
    for (var start = 0; start < w * h; start++) {
      if (visited[start] || Math.abs(resid[start]) <= DEFECT_TH) continue;
      var sp = 0;
      stack[sp++] = start;
      visited[start] = 1;
      var minX = w, maxX = -1, minY = h, maxY = -1, area = 0, touchEdge = false;
      while (sp > 0) {
        var idx = stack[--sp];
        var y = (idx / w) | 0, x = idx - y * w;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        area++;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchEdge = true;
        for (var k = 0; k < 8; k++) {
          var nx = x + DX[k], ny = y + DY[k];
          var j = idx + NB[k];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h || visited[j]) continue;
          if (Math.abs(resid[j]) > DEFECT_TH) {
            visited[j] = 1;
            stack[sp++] = j;
          }
        }
      }
      if (touchEdge || area < BUBBLE_AREA[0]) continue;
      var bw = maxX - minX + 1, bh = maxY - minY + 1;
      var maxSide = bw > bh ? bw : bh, minSide = bw < bh ? bw : bh;
      var aspect = maxSide / minSide;
      var fill = area / (bw * bh);
      if (area <= BUBBLE_AREA[1] && maxSide <= BUBBLE_MAXSIDE && aspect <= BUBBLE_ASPECT && fill >= BUBBLE_FILL) {
        bubbles++; // 小型实心圆斑 → 气泡
      } else if (maxSide >= CRACK_MINSIDE && aspect >= CRACK_ASPECT && fill <= CRACK_FILL) {
        cracks++; // 大尺度细长结构 → 裂纹
      }
    }
    return { bubbles: bubbles, cracks: cracks };
  }

  // ---------- 主分析入口 ----------
  // rgba: Uint8ClampedArray(RGBA), w, h
  // 返回: { score, stars, colorScore, texScore, chromaMean, blotchFrac, verdict }
  function analyze(rgba, w, h) {
    var pre = toGrayResized(rgba, w, h);
    var g = pre.gray, gw = pre.w, gh = pre.h;

    // 中频残差 = 原图 - 低频（去除光照渐变与高光）
    var low = boxBlur(g, gw, gh, BLUR_K);
    var resid = new Float32Array(gw * gh);
    for (var i = 0; i < g.length; i++) resid[i] = g[i] - low[i];

    // 32px 分块标准差 → 记录所有块 std，取 p90 作为纹理指标
    var nbh = Math.floor(gh / BLOCK), nbw = Math.floor(gw / BLOCK);
    var stds = [];
    for (var by = 0; by < nbh; by++) {
      for (var bx = 0; bx < nbw; bx++) {
        var sum = 0, sum2 = 0, n = 0;
        for (var yy = by * BLOCK; yy < (by + 1) * BLOCK; yy++) {
          for (var xx = bx * BLOCK; xx < (bx + 1) * BLOCK; xx++) {
            var v = resid[yy * gw + xx];
            sum += v; sum2 += v * v; n++;
          }
        }
        var mean = sum / n;
        var std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        stds.push(std);
      }
    }
    stds.sort(function (a, b) { return a - b; });
    var p90 = stds.length ? stds[Math.min(stds.length - 1, Math.floor(stds.length * 0.9))] : 0;

    var colorScore = lerpScore(pre.chromaMean, COLOR_LO, COLOR_HI);
    var texScore = lerpScore(p90, TEX_HI, TEX_LO); // p90 越高分越低
    var score = Math.round(clamp(W_COLOR * colorScore + W_TEX * texScore, 0, 100));

    // 气泡 / 裂纹检测（展示用参数，不计入综合分）
    var defects = detectDefects(resid, gw, gh);

    // 星级：每 20 分一颗星，四舍五入到 0.5，最低显示半颗
    var starsRaw = score / 20;
    var stars = Math.max(0.5, Math.round(starsRaw * 2) / 2);

    return {
      score: score,
      stars: stars,
      colorScore: Math.round(colorScore),
      texScore: Math.round(texScore),
      chromaMean: pre.chromaMean,
      texP90: p90,
      bubbleCount: defects.bubbles,
      crackCount: defects.cracks,
      verdict: score >= 60 ? (score >= 90 ? "优秀" : "合规") : "不合规"
    };
  }

  return {
    analyze: analyze,
    toGrayResized: toGrayResized,
    boxBlur: boxBlur,
    constants: { TARGET: TARGET, COLOR_LO: COLOR_LO, COLOR_HI: COLOR_HI, TEX_LO: TEX_LO, TEX_HI: TEX_HI }
  };
});
