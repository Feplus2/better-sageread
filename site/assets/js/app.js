/* Better SageRead 工具箱 · 页面行为
 * 全部增强式：无 JS 时链接与静态数据依然可用。 */
(function () {
  "use strict";
  var CFG = window.SITE_CONFIG || { products: {} };
  var TTL = 30 * 60 * 1000; // GitHub Release 缓存 30 分钟

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- 进场动画 ---------- */
  function initReveal() {
    var els = $all(".reveal");
    if (!("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("visible"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("visible"); io.unobserve(e.target); }
      });
    }, { threshold: 0.08 });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ---------- 截图灯箱 ---------- */
  function initLightbox() {
    var lb = $("#lightbox");
    if (!lb) return;
    var img = $("img", lb), cap = $("figcaption", lb);
    var items = $all(".g-item img");
    var idx = 0;

    function show(i) {
      idx = (i + items.length) % items.length;
      img.src = items[idx].src;
      img.alt = items[idx].alt;
      cap.textContent = items[idx].alt;
    }
    function open(i) { show(i); lb.hidden = false; document.body.style.overflow = "hidden"; }
    function close() { lb.hidden = true; document.body.style.overflow = ""; }

    items.forEach(function (im, i) {
      im.closest(".g-item").addEventListener("click", function () { open(i); });
    });
    $(".lb-close", lb).addEventListener("click", close);
    $(".lb-prev", lb).addEventListener("click", function () { show(idx - 1); });
    $(".lb-next", lb).addEventListener("click", function () { show(idx + 1); });
    lb.addEventListener("click", function (e) { if (e.target === lb) close(); });
    document.addEventListener("keydown", function (e) {
      if (lb.hidden) return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") show(idx - 1);
      if (e.key === "ArrowRight") show(idx + 1);
    });
  }

  /* ---------- 非 Windows 提示 ---------- */
  function initOsNote() {
    if (!/Windows/i.test(navigator.userAgent)) {
      var note = $("[data-os-note]");
      if (note) note.hidden = false;
    }
  }

  /* ---------- 下载计数：仅 GitHub 口径（2026-08-30 用户裁定；KV 边缘函数方案已退役） ---------- */

  /* ---------- GitHub Release 同步 ---------- */
  function cached(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var box = JSON.parse(raw);
      if (Date.now() - box.t > TTL) return null;
      return box.d;
    } catch (e) { return null; }
  }
  function store(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data })); } catch (e) {}
  }

  function fetchRelease(repo) {
    return new Promise(function (resolve) {
      var key = "sageread-site:rel:" + repo;
      var hit = cached(key);
      if (hit) return resolve(hit);
      fetch("https://api.github.com/repos/" + repo + "/releases/latest", {
        headers: { Accept: "application/vnd.github+json" },
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.tag_name) { store(key, d); resolve(d); }
          else resolve(null);
        })
        .catch(function () { resolve(null); });
    });
  }

  function countable(assets) {
    return (assets || []).filter(function (a) {
      return !/\.(sig|json|blockmap|txt)$/i.test(a.name);
    });
  }
  function mb(bytes) {
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function applyProduct(productId, def, release) {
    var total = 0;
    var resolved = {};

    def.assets.forEach(function (assetDef) {
      var dlId = productId + "-" + assetDef.id;
      var asset = null;
      if (release) {
        asset = (release.assets || []).find(function (a) { return a.name.indexOf(assetDef.pick) !== -1; }) || null;
      }
      resolved[dlId] = asset;

      /* 更新按钮：主按钮优先走国内镜像（未配置镜像则维持 GitHub 直连） */
      $all('[data-dl="' + dlId + '"]').forEach(function (btn) {
        if (btn.hasAttribute("data-gh-link")) {
          if (asset) btn.href = asset.browser_download_url;
          return;
        }
        if (CFG.cosBase && asset) {
          btn.href = CFG.cosBase.replace(/\/+$/, "") + "/" + encodeURIComponent(asset.name);
        } else if (asset) {
          btn.href = asset.browser_download_url;
        }
        var meta = $(".btn-meta", btn);
        if (meta && asset) meta.textContent = release.tag_name + " · " + mb(asset.size);
      });

      if (asset) {
        var sizeEl = $('[data-size="' + dlId + '"]');
        if (sizeEl) sizeEl.textContent = mb(asset.size);
      }
    });

    if (release) {
      total = countable(release.assets).reduce(function (s, a) { return s + a.download_count; }, 0);
      $all('[data-version-badge="' + productId + '"]').forEach(function (el) { el.textContent = release.tag_name; });
      $all('[data-version="' + productId + '"]').forEach(function (el) {
        var setup = resolved[productId + "-setup"] || resolved[productId + "-gui"];
        el.textContent = release.tag_name + (setup ? " · " + mb(setup.size) : "");
      });
      $all('[data-gh-count="' + productId + '"]').forEach(function (el) {
        if (total > 0) { el.textContent = total; el.removeAttribute("title"); }
      });
    }
    return total;
  }

  function initDownloads() {
    var grand = 0;
    Object.keys(CFG.products || {}).forEach(function (id) {
      var def = CFG.products[id];
      if (!def.repo) {
        $all('[data-status="' + id + '"]').forEach(function (el) {
          if (def.status) el.textContent = def.status;
        });
        $all('[data-status-text="' + id + '"]').forEach(function (el) {
          if (def.status && def.status.indexOf("准备") === -1) el.textContent = def.status;
        });
        return;
      }
      fetchRelease(def.repo).then(function (release) {
        grand += applyProduct(id, def, release);
        var t = $("[data-total-downloads]");
        if (t && grand > 0) t.textContent = grand;
      });
    });

    /* 镜像通道提示 */
    var hasMirror = !!CFG.cosBase;
    var on = $("[data-mirror-note]"), off = $("[data-no-mirror-note]");
    if (on) on.hidden = !hasMirror;
    if (off) off.hidden = hasMirror;
    if (!hasMirror) {
      /* 无镜像：主按钮直指 GitHub 并改标，隐藏冗余的 GitHub 副按钮（保持整列对齐） */
      $all("[data-gh-link]").forEach(function (b) { b.style.display = "none"; });
      $all("[data-dl-cell] .btn-primary").forEach(function (b) { b.textContent = "GitHub 下载"; });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initReveal();
    initLightbox();
    initOsNote();
    initDownloads();
  });
})();
