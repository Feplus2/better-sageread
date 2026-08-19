// P1 链接重建 阅读器侧端到端验证：合成锚点/链接的渲染与点击跳转
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 localhost:1420 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  const id = ++mid;
  pending.set(id, { promise, resolve });
  ws.send(JSON.stringify({ id, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    p.resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 重载页面（丢弃已挂载的旧 paper.md），再打开论文 tab
await call("Page.reload", { ignoreCache: true });
await sleep(4000);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("6c533ac14d2b48e4", "cosmic strings"); true`);

// 等正文与注入链接渲染完成
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  ready = await evalJS(`!!document.querySelector('.paper-content a[href="#ref-1"]')`).catch(() => false);
  if (ready) break;
}
if (!ready) throw new Error("正文/注入链接渲染超时");

// ─── 1. 锚点存活性：行内 <a id> 是否活着到 DOM ───
const anchors = await evalJS(`(() => {
  const out = {};
  for (const id of ["ref-1", "ref-2", "ref-12", "fig-10"]) {
    const el = document.getElementById(id);
    out[id] = el ? { tag: el.tagName, inContent: !!el.closest(".paper-content"), text: el.textContent } : null;
  }
  return out;
})()`);
console.log("1) 锚点元素:", JSON.stringify(anchors));

// ─── 2. 链接渲染形态 ───
const links = await evalJS(`(() => {
  const grab = (href) => {
    const a = document.querySelector('.paper-content a[href="' + href + '"]');
    return a ? { text: a.textContent, tag: a.tagName } : null;
  };
  return { ref1: grab("#ref-1"), ref5: grab("#ref-5"), ref99: grab("#ref-99"), fig10: grab("#fig-10") };
})()`);
console.log("2) 链接元素:", JSON.stringify(links));

const scrollerInfo = `(function(){
  const content = document.querySelector('.paper-content');
  const scroller = content.closest('.overflow-y-auto');
  return { content, scroller };
})()`;

const clickAndMeasure = async (href, probeExpr, label) => {
  await evalJS(`(() => { const s = ${scrollerInfo}.scroller; window.__before = s.scrollTop; document.querySelector('.paper-content a[href="${href}"]').click(); true })()`);
  // 闪烁高亮应在 ~1.3s 窗口内出现
  let flashed = false;
  for (let i = 0; i < 6; i++) {
    await sleep(120);
    flashed = await evalJS(`!!(CSS.highlights && CSS.highlights.has("paper-anno-current"))`);
    if (flashed) break;
  }
  // 平滑滚动落定后再量
  await sleep(1200);
  const result = await evalJS(`(() => {
    const { scroller } = ${scrollerInfo};
    const probe = ${probeExpr};
    return { before: window.__before, after: scroller.scrollTop, probe };
  })()`);
  console.log(`${label}: flashed=${flashed}`, JSON.stringify(result));
  return { flashed, ...result };
};

const inViewport = (expr) => `(() => { const el = ${expr}; if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), vh: window.innerHeight, visible: r.top > 0 && r.top < window.innerHeight }; })()`;

// 3) #ref-1：锚点路径（应滚动到 [1] 条目并闪烁）
await clickAndMeasure("#ref-1", inViewport(`document.getElementById("ref-1")`), "3) 点击 #ref-1");

// 4) #fig-10：图块锚点路径
await clickAndMeasure("#fig-10", inViewport(`document.getElementById("fig-10")`), "4) 点击 #fig-10");

// 5) #ref-5：无锚点 → quote 兜底（应落到 "[5] A. Vilenkin" 条目而不是链接自身）
await clickAndMeasure(
  "#ref-5",
  inViewport(`Array.from(document.querySelectorAll('.paper-content p')).find((p) => p.textContent.startsWith("[5] A. Vilenkin"))`),
  "5) 点击 #ref-5（兜底）",
);

// 6) #ref-99：无锚点且无文本 → 静默不跳
await clickAndMeasure("#ref-99", `null`, "6) 点击 #ref-99（静默）");

// 7) 控制台错误收集（整个过程中不应有报错）
console.log("done");
ws.close();
