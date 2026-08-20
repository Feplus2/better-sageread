// 脚注验证：[^N] 渲染 / 点击定位+闪烁 / ↩ 回跳 / 降级定义 / TOC 不含 Footnotes
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  pending.set(++mid, { promise, resolve });
  ws.send(JSON.stringify({ id: mid, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call("Page.reload", { ignoreCache: true });
await sleep(4500);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("57ae0a5f29feecb6", "Forecast constraints"); true`);
const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;
const CONTENT = `Array.from(document.querySelectorAll('.paper-content')).find(${VIS})`;
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  ready = await evalJS(`(() => { const c = ${CONTENT}; return c && c.textContent.includes('cusps on loops'); })()`).catch(() => false);
  if (ready) break;
}
if (!ready) throw new Error("正文渲染超时");

// ─── 1. 渲染形态：引用点 sup 链接 + 末尾脚注区 ───
console.log("1) 形态:", await evalJS(`(() => {
  const c = ${CONTENT};
  const ref = c.querySelector('sup a[href="#user-content-fn-1"]');
  const sec = c.querySelector('section[data-footnotes]');
  const lis = sec ? Array.from(sec.querySelectorAll('li')).map((li) => li.id) : [];
  const backlink = sec?.querySelector('a[data-footnote-backref], a[href^="#user-content-fnref"]');
  return JSON.stringify({
    refExists: !!ref, refId: ref?.id ?? null, refText: ref?.textContent ?? null,
    sectionExists: !!sec, liIds: lis,
    backlinkHref: backlink?.getAttribute('href') ?? null,
    fn9Rendered: (sec?.textContent ?? '').includes('degraded form'),
  }, null, 1);
})()`));

// ─── 2. 点击引用点 → 滚动到定义 + 闪烁 ───
const clickAndMeasure = async (selector, expectId, label) => {
  await evalJS(`(() => { const c = ${CONTENT}; const s = c.closest('.overflow-y-auto'); s.scrollTo({ top: 0, behavior: 'instant' }); true })()`);
  await evalJS(`(() => {
    const c = ${CONTENT};
    const el = c.querySelector(${JSON.stringify(selector)});
    const s = c.closest('.overflow-y-auto');
    s.scrollTo({ top: el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 200, behavior: 'instant' });
    el.click();
    true;
  })()`);
  const flash = await evalJS(`new Promise((res) => {
    const t0 = Date.now(); let seen = null;
    const iv = setInterval(() => {
      const h = CSS.highlights && CSS.highlights.get("paper-anno-current");
      if (h && h.size > 0 && !seen) { const r = h.values().next().value; seen = (r.toString() ?? '').replace(/\\s+/g, ' ').trim().slice(0, 70); }
      if (Date.now() - t0 > 1800) { clearInterval(iv); res(seen); }
    }, 40);
  })`);
  await sleep(3600); // 等漂移校正窗口
  const probe = await evalJS(`(() => {
    const el = document.getElementById(${JSON.stringify(expectId)});
    const c = ${CONTENT};
    const s = c.closest('.overflow-y-auto');
    const r = el.getBoundingClientRect();
    return { elTop: Math.round(r.top), inViewport: r.top > 0 && r.top < window.innerHeight, scrollTop: Math.round(s.scrollTop) };
  })()`);
  console.log(`${label}:`, JSON.stringify({ ...probe, flash }));
};

await clickAndMeasure('sup a[href="#user-content-fn-1"]', "user-content-fn-1", "2) 点引用点[^1]→定义");
await clickAndMeasure('section[data-footnotes] a[href="#user-content-fnref-1"]', "user-content-fnref-1", "3) 点↩回跳→引用点");

// ─── 4. TOC 不含 Footnotes 标签 ───
console.log("4) TOC 文本:", await evalJS(`(() => {
  const c = ${CONTENT};
  const hs = Array.from(c.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => h.textContent);
  return JSON.stringify({ hasFootnotesLabelInDom: hs.includes('Footnotes'), headingCount: hs.length });
})()`));
console.log("   顶栏 TOC 状态（应无 Footnotes）:", await evalJS(`(() => {
  // 从 PaperHeaderBar 读 toc 最可靠：直接看 store 不可行，改看 DOM 的 heading 收集结果——
  // 这里验证阅读器 effect 排除后的结果：footnote-label 不应出现在 toc；用标题 DOM 对照
  const c = ${CONTENT};
  const label = c.querySelector('[data-footnotes] h2');
  return JSON.stringify({ labelText: label?.textContent ?? null, labelId: label?.id ?? null, srOnly: label?.className ?? null });
})()`));

console.log("done");
ws.close();
