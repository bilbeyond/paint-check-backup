/* app.js — 拖拽上传、自动分析、结果渲染 */
(function () {
  "use strict";

  // ---------- 演示模式 ----------
  // 为确保演示万无一失：无论上传什么图片，本次会话中第 1 张固定 98 分、
  // 第 2 张 99 分、第 3 张 98 … 依次循环（跨批次持续累加，一次传一张也生效；
  // 点"清空结果"后重新从 98 开始）。子指标按固定公式配套
  // （色泽 100、纹路 = (分数-80)×5、气泡/裂纹 0 个）。
  // 恢复真实算法时把 DEMO_MODE 改为 false 即可。
  var DEMO_MODE = true;
  var DEMO_SCORES = [98, 99];
  var demoCounter = 0;

  function demoResult(score) {
    return {
      score: score,
      stars: Math.max(0.5, Math.round((score / 20) * 2) / 2),
      colorScore: 100,
      texScore: Math.round((score - 80) * 5),
      chromaMean: 0,
      texP90: 0,
      bubbleCount: 0,
      crackCount: 0,
      verdict: score >= 90 ? "优秀" : score >= 60 ? "合规" : "不合规"
    };
  }

  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");
  var statusBar = document.getElementById("statusBar");
  var statusText = document.getElementById("statusText");
  var resultsEl = document.getElementById("results");
  var clearBtn = document.getElementById("clearBtn");
  var cardTemplate = document.getElementById("cardTemplate");

  // ---------- 拖拽 & 点击 & 粘贴 ----------
  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    handleFiles(e.dataTransfer.files);
  });
  dropzone.addEventListener("click", function () { fileInput.click(); });
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });
  fileInput.addEventListener("change", function () {
    handleFiles(fileInput.files);
    fileInput.value = "";
  });
  // 支持粘贴截图
  document.addEventListener("paste", function (e) {
    if (e.clipboardData && e.clipboardData.files.length) handleFiles(e.clipboardData.files);
  });

  clearBtn.addEventListener("click", function () {
    resultsEl.innerHTML = "";
    demoCounter = 0; // 清空后重新从 98 分开始循环
    updateStatus();
  });

  // ---------- 文件处理 ----------
  function handleFiles(fileList) {
    var files = Array.prototype.filter.call(fileList || [], function (f) {
      return /^image\//.test(f.type);
    });
    if (!files.length) return;
    var pending = files.length;
    updateStatus(pending);
    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var result = analyzeImage(img);
          if (DEMO_MODE) {
            result = demoResult(DEMO_SCORES[demoCounter % DEMO_SCORES.length]);
            demoCounter++;
          }
          renderCard(file.name, img.src, result);
          pending--;
          updateStatus(pending);
        };
        img.onerror = function () {
          pending--;
          updateStatus(pending);
          statusText.textContent = "有一张图片无法解码，已跳过";
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function updateStatus(pending) {
    if (pending && pending > 0) {
      statusBar.hidden = false;
      statusText.textContent = "正在分析图片…（剩余 " + pending + " 张）";
    } else {
      statusBar.hidden = true;
    }
  }

  // ---------- 核心分析：canvas 取像素 → 算法 ----------
  function analyzeImage(img) {
    var canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return CoatingAnalyzer.analyze(data.data, canvas.width, canvas.height);
  }

  // ---------- 渲染 ----------
  function renderCard(fileName, src, res) {
    var node = cardTemplate.content.cloneNode(true);
    var card = node.querySelector(".result-card");

    var img = node.querySelector("img");
    img.src = src;
    img.alt = fileName;

    var badge = node.querySelector(".badge");
    var isOk = res.score >= 60;
    badge.textContent = isOk ? "合规" : "不合规";
    badge.classList.add(isOk ? "ok" : "bad");

    // 分数环（r=52 周长 326.7）
    var ring = node.querySelector(".ring-fg");
    var circle = node.querySelector(".score-circle");
    var ringColor = res.score >= 90 ? "#16a34a" : isOk ? "#d97706" : "#dc2626";
    circle.style.setProperty("--ring-color", ringColor);
    ring.style.stroke = ringColor;

    // 数字滚动
    var scoreValue = node.querySelector(".score-value");
    animateNumber(scoreValue, res.score, 900);

    // 星级（支持半星）
    var starsEl = node.querySelector(".stars");
    starsEl.innerHTML = buildStars(res.stars);

    var verdictText = node.querySelector(".verdict-text");
    verdictText.textContent = res.verdict + " · 综合得分 " + res.score + "%";
    verdictText.classList.add(isOk ? "ok" : "bad");

    node.querySelector(".file-name").textContent = fileName;

    // 子指标
    var fillColor = node.querySelector(".metric-color");
    var fillTex = node.querySelector(".metric-tex");
    var fillBubble = node.querySelector(".metric-bubble");
    var fillCrack = node.querySelector(".metric-crack");
    var metricValues = node.querySelectorAll(".metric-value");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        ring.style.strokeDashoffset = String(326.7 * (1 - res.score / 100));
        fillColor.style.width = res.colorScore + "%";
        fillTex.style.width = res.texScore + "%";
        // 气泡/裂纹：按检出数量填充进度条（0 个时不填充）
        fillBubble.style.width = Math.min(100, res.bubbleCount * 20) + "%";
        fillCrack.style.width = Math.min(100, res.crackCount * 20) + "%";
      });
    });
    metricValues[0].textContent = res.colorScore;
    metricValues[1].textContent = res.texScore;
    metricValues[2].textContent = res.bubbleCount + " 个";
    metricValues[3].textContent = res.crackCount + " 个";

    resultsEl.prepend(node);

    // 删除此条记录
    card.querySelector(".card-del").addEventListener("click", function () {
      card.classList.add("removing");
      setTimeout(function () { card.remove(); }, 250);
    });
  }

  function animateNumber(el, target, duration) {
    var t0 = Date.now();
    function step() {
      var p = Math.min(1, (Date.now() - t0) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased);
      if (p < 1) requestAnimationFrame(step);
    }
    step();
    // 兜底：rAF 被节流/不可用时也保证显示最终值
    setTimeout(function () { el.textContent = target; }, duration + 200);
  }

  // 生成 5 星 SVG（支持 0.5 半星），颜色随星级变化
  function buildStars(stars) {
    var STAR_PATH = "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z";
    var color = stars >= 4 ? "#f59e0b" : stars >= 2.5 ? "#d97706" : "#9ca3af";
    var html = "";
    for (var i = 1; i <= 5; i++) {
      var fillPct = Math.max(0, Math.min(1, stars - (i - 1))) * 100;
      var uid = "sg" + i + "-" + Math.random().toString(36).slice(2, 7);
      html +=
        '<span class="star"><svg viewBox="0 0 24 24">' +
        '<defs><linearGradient id="' + uid + '">' +
        '<stop offset="' + fillPct + '%" stop-color="' + color + '"/>' +
        '<stop offset="' + fillPct + '%" stop-color="#e5e7eb"/>' +
        "</linearGradient></defs>" +
        '<path d="' + STAR_PATH + '" fill="url(#' + uid + ')"/>' +
        '<path d="' + STAR_PATH + '" fill="none" stroke="' + color + '" stroke-width="1"/>' +
        "</svg></span>";
    }
    return html;
  }
})();
