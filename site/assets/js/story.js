/* ============================================================
   叙事引擎：tab 架构 + 帧序列 scrub + 倒带切换
   素材：frames/seg_*（121 帧/段 @24fps 1080p，seedream+seedance 生成）
   共享首帧 = seg_open f000（所有 tab 的空闲帧，切换零跳变）
   ============================================================ */
(function () {
"use strict";

/* ---------- 降级：移动端 / 减弱动效 → 静态页 ---------- */
if (matchMedia("(prefers-reduced-motion: reduce)").matches || innerWidth < 820) {
  document.body.classList.add("flat");
  window.__ready = true;
  return;
}

var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
var N = 121; // 每段帧数

/* ---------- tab 分镜表 ---------- */
var TABS = {
  sageread: {
    trackVh: 1000,
    dirs: ["seg_open", "seg_flip"],
    segs: [
      { dir: "seg_open", from: .050, to: .130 },
      { dir: "seg_flip", from: .250, to: .285 },
      { dir: "seg_flip", from: .400, to: .435 },
      { dir: "seg_flip", from: .550, to: .585 },
      { dir: "seg_flip", from: .700, to: .735 },
      { dir: "seg_flip", from: .850, to: .885 },
      { dir: "seg_open", from: .950, to: 1.0, rev: true }, // 合书回环（倒放）
    ],
    blocks: [
      { el: "blk-hero",    hold: true, outA: .050, outB: .085 },
      { el: "blk-lib",     inA: .140, inB: .175, outA: .250, outB: .285 },
      { el: "blk-reader",  inA: .295, inB: .330, outA: .400, outB: .435 },
      { el: "blk-figures", inA: .445, inB: .480, outA: .550, outB: .585 },
      { el: "blk-notes",   inA: .595, inB: .630, outA: .700, outB: .735 },
      { el: "blk-rag",     inA: .745, inB: .780, outA: .850, outB: .885 },
      { el: "blk-vault",   inA: .895, inB: .930, outA: .940, outB: .970 },
    ],
  },
  papers: {
    trackVh: 450, dirs: ["seg_scroll"],
    segs: [{ dir: "seg_scroll", from: .08, to: .30 }],
    blocks: [
      { el: "blk-p-hero",    hold: true, outA: .05, outB: .10 },
      { el: "blk-p-quality", inA: .32, inB: .36, outA: .60, outB: .64 },
      { el: "blk-p-feat",    inA: .66, inB: .70, outA: .97, outB: 1.01 },
    ],
  },
  books: {
    trackVh: 450, dirs: ["seg_open", "seg_write"],
    segs: [
      { dir: "seg_open",  from: .08, to: .26 },
      { dir: "seg_write", from: .52, to: .66 },
    ],
    blocks: [
      { el: "blk-b-hero",    hold: true, outA: .05, outB: .10 },
      { el: "blk-b-compare", inA: .28, inB: .32, outA: .52, outB: .56 },
      { el: "blk-b-feat",    inA: .68, inB: .72, outA: .97, outB: 1.01 },
    ],
  },
  mcp: {
    trackVh: 400, dirs: ["seg_bloom"],
    segs: [{ dir: "seg_bloom", from: .08, to: .30 }],
    blocks: [
      { el: "blk-m-hero",  hold: true, outA: .05, outB: .10 },
      { el: "blk-m-tools", inA: .32, inB: .36, outA: .60, outB: .64 },
      { el: "blk-m-setup", inA: .66, inB: .70, outA: .97, outB: 1.01 },
    ],
  },
  zotero: {
    trackVh: 400, dirs: ["seg_card"],
    segs: [{ dir: "seg_card", from: .08, to: .30 }],
    blocks: [
      { el: "blk-z-hero",  hold: true, outA: .05, outB: .10 },
      { el: "blk-z-flow",  inA: .32, inB: .36, outA: .60, outB: .64 },
      { el: "blk-z-setup", inA: .66, inB: .70, outA: .97, outB: 1.01 },
    ],
  },
};

/* ---------- 帧资源（渐进加载：首帧立即，其余 6 路队列闲时续载） ---------- */
var imgs = {}, queue = [], activeJobs = 0;
function frameSrc(dir, i) { return "frames/" + dir + "/f" + String(i).padStart(3, "0") + ".jpg"; }
function ensureDir(dir) {
  if (imgs[dir]) return;
  imgs[dir] = new Array(N);
  var im0 = new Image(); // 首帧不等队列
  im0.onload = function () { imgs[dir][0] = im0; };
  im0.src = frameSrc(dir, 0);
  var jobs = [];
  for (var i = 1; i < N; i++) jobs.push([dir, i]);
  queue = jobs.concat(queue); // 新激活 tab 的段插队优先
  pump();
}
function pump() {
  while (activeJobs < 6 && queue.length) {
    var job = queue.shift(); activeJobs++;
    (function (dir, i) {
      var im = new Image();
      im.onload = function () { imgs[dir][i] = im; activeJobs--; pump(); };
      im.onerror = function () { activeJobs--; pump(); };
      im.src = frameSrc(dir, i);
    })(job[0], job[1]);
  }
}
function pick(arr, i) { /* 邻近帧兜底：±24 帧内找已加载的 */
  if (!arr) return null;
  for (var d = 0; d <= 24; d++) {
    var a = arr[i + d], b = arr[i - d];
    if (a && a.naturalWidth) return a;
    if (b && b.naturalWidth) return b;
  }
  return null;
}

/* ---------- 画布 ---------- */
var canvas = $("#seq"), ctx = canvas.getContext("2d");
function fit() { canvas.width = innerWidth; canvas.height = innerHeight; }
fit(); addEventListener("resize", fit);
var lastKey = "";
function draw(dir, idx) {
  idx = Math.max(0, Math.min(N - 1, Math.round(idx)));
  var key = dir + ":" + idx;
  if (key === lastKey) return;
  var im = pick(imgs[dir], idx);
  if (!im) return;
  lastKey = key;
  var s = Math.max(canvas.width / im.naturalWidth, canvas.height / im.naturalHeight);
  var w = im.naturalWidth * s, h = im.naturalHeight * s;
  ctx.drawImage(im, (canvas.width - w) * 0.15, (canvas.height - h) * 0.5, w, h); // 焦点偏左
}

/* ---------- 分镜求值 ---------- */
function seg01(p, a, b) { var t = (p - a) / (b - a); return t < 0 ? 0 : t > 1 ? 1 : t; }
function frameAt(spec, p) {
  var S = spec.segs;
  if (p < S[0].from) return { si: 0, pos: 0 };
  for (var i = 0; i < S.length; i++) {
    var s = S[i];
    if (p <= s.to) {
      if (p >= s.from) return { si: i, pos: seg01(p, s.from, s.to) * (N - 1) };
      return { si: i - 1, pos: N - 1 }; // 段间驻留 = 前段末帧
    }
  }
  return { si: S.length - 1, pos: N - 1 };
}
function drawSeg(spec, si, pos) {
  var s = spec.segs[si];
  draw(s.dir, s.rev ? N - 1 - pos : pos);
}

/* ---------- 状态 ---------- */
var cur = "sageread", spec = TABS.sageread;
var track = $("#track"), veil = $("#veil"), hint = $("#hint");
var target = 0, curP = 0, switching = false;
var lastSi = 0, lastPos = 0;

function applyTrack() { track.style.height = TABS[cur].trackVh + "vh"; }

function render(p) {
  var fr = frameAt(spec, p);
  lastSi = fr.si; lastPos = fr.pos;
  drawSeg(spec, fr.si, fr.pos);

  var maxOp = 0;
  spec.blocks.forEach(function (b) {
    var op = b.hold
      ? 1 - seg01(p, b.outA, b.outB)
      : seg01(p, b.inA, b.inB) - seg01(p, b.outA, b.outB);
    op = Math.max(0, Math.min(1, op));
    if (op > maxOp) maxOp = op;
    var el = document.getElementById(b.el);
    var rise = b.hold ? -26 * seg01(p, b.outA, b.outB)
      : 22 * (1 - seg01(p, b.inA, b.inB)) - 18 * seg01(p, b.outA, b.outB);
    el.style.opacity = op;
    el.style.visibility = op <= 0.01 ? "hidden" : "visible";
    el.style.transform = "translateY(calc(-50% + " + rise.toFixed(1) + "px))";
  });
  veil.style.opacity = (0.25 + 0.75 * maxOp).toFixed(3);
  hint.style.opacity = String(1 - seg01(p, .005, .03));
}

/* ---------- 滚动 ---------- */
function onScroll() {
  if (switching) return;
  var max = track.offsetHeight - innerHeight;
  target = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
}
addEventListener("scroll", onScroll, { passive: true });
(function loop() {
  if (!switching) {
    curP += (target - curP) * .09;
    if (Math.abs(target - curP) < .0004) curP = target;
    render(curP);
  }
  requestAnimationFrame(loop);
})();

/* ---------- tab 切换（先回共享首帧） ---------- */
function rewind(cb) {
  if (lastSi === 0 && lastPos < 1) { cb(); return; }
  var segs = spec.segs;
  var visited = [];
  if (segs[lastSi].rev) { /* 处于合书段：快进到末帧即是首帧 */
    var f0 = lastPos;
    (function ff() {
      f0 += 4;
      if (f0 >= N - 1) { window.__dbgRewind = visited; cb(); return; }
      visited.push(lastSi);
      drawSeg(spec, lastSi, f0);
      requestAnimationFrame(ff);
    })();
    return;
  }
  /* 倒带至多两段：当前段一次 + 首页段一次——不复读中间的重复翻页段 */
  var chain = lastSi === 0 ? [0] : [lastSi, 0];
  var ci = 0, f = lastPos;
  (function step() {
    f -= 4;
    if (f < 0) {
      ci++;
      if (ci >= chain.length) { window.__dbgRewind = chain; cb(); return; }
      f = N - 1;
    }
    drawSeg(spec, chain[ci], f);
    requestAnimationFrame(step);
  })();
}
function switchTab(name) {
  if (name === cur || switching || !TABS[name]) return;
  switching = true;
  /* 文字层先撤 */
  $$("#panel-" + cur + " .blk").forEach(function (el) { el.style.opacity = 0; el.style.visibility = "hidden"; });
  rewind(function () {
    $("#panel-" + cur).classList.remove("on");
    $("#panel-" + name).classList.add("on");
    $$("#tabrail button").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === name); });
    $$(".acq").forEach(function (a) { a.classList.toggle("on", a.dataset.for === name); });
    cur = name; spec = TABS[name];
    applyTrack();
    spec.dirs.forEach(ensureDir);
    scrollTo(0, 0); target = curP = 0; lastSi = 0; lastPos = 0; lastKey = "";
    render(0);
    switching = false;
  });
}
$$("#tabrail button").forEach(function (b) {
  b.addEventListener("click", function () { switchTab(b.dataset.tab); });
});

/* ---------- 命令卡 ---------- */
document.addEventListener("click", function (e) {
  var b = e.target.closest ? e.target.closest(".copybtn") : null;
  if (!b) return;
  var go = b.getAttribute("data-goto");
  if (go) { var t = $(go); if (t) t.scrollIntoView({ behavior: "smooth" }); return; }
  var text = b.getAttribute("data-copy");
  if (!text) return;
  var done = function () { b.textContent = "已复制"; setTimeout(function () { b.textContent = "复制"; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
  } else { fallbackCopy(text); done(); }
});
function fallbackCopy(text) {
  var ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta);
}

/* ---------- 初始化 ---------- */
applyTrack();
spec.dirs.forEach(ensureDir);
render(0);

/* 截图探针 */
window.__setP = function (p) { target = curP = Math.max(0, Math.min(1, p)); render(curP); };
window.__tab = function (n) { switchTab(n); };
window.__ready = true;
})();
