// wang2024routes 长综述验收：TOC 三级标题 / 图注渲染 / Table 2 KaTeX / 整幅图
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => (r = res)); pending.set(++mid, { r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call("Page.reload", { ignoreCache: true });
await sleep(5000);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "ok"`);
for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJS(`!!window.__layout`).catch(() => false)) break; }
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("13ddaa01b82a3291", "Routes to high-performance"); true`);
await sleep(6000);

// 可见性过滤工具
const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;

// 1) TOC 三级标题（阅读器 TOC 面板数据源）
console.log("TOC 6.2.x:", await evalJS(`(() => {
  const txt = document.body.textContent ?? '';
  return ['6.2.1','6.2.2','6.2.3','6.2.4'].map((k) => txt.includes(k));
})()`));

// 2) 正文里的 6.2.1 是否是 h3 标题元素
console.log("6.2.1 标题元素:", await evalJS(`(() => {
  const hs = Array.from(document.querySelectorAll('h3')).filter((h) => (${VIS})(h) && (h.textContent ?? '').includes('6.2.1'));
  return hs.map((h) => h.textContent.trim().slice(0, 60));
})()`));

// 3) Figure 3 图注渲染（图片后应有完整图注文字）
console.log("Figure 3 区域:", await evalJS(`(() => {
  const img = Array.from(document.querySelectorAll('img')).find((i) => (${VIS})(i) && (i.src.includes('fig3.') || (i.alt ?? '').startsWith('Figure 3')));
  if (!img) return 'img not found';
  const parent = img.closest('p, figure, div');
  return (parent?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160);
})()`));

// 4) Table 2 区域 KaTeX 渲染（找含 NaMgFeMn 化学式的行，看是否 .katex）
console.log("Table 2 KaTeX:", await evalJS(`(() => {
  const kates = Array.from(document.querySelectorAll('.katex')).filter((k) => (${VIS})(k) && (k.textContent ?? '').includes('Na'));
  const rawLeak = (document.body.textContent ?? '').includes('\\\\mathrm{Na}}_{0.7}');
  return { katexNaCount: kates.length, rawLeak };
})()`));

// 5) 图 33/40 整幅与碎图渲染情况
console.log("fig33/40 DOM:", await evalJS(`(() => {
  const imgs = Array.from(document.querySelectorAll('img')).filter((i) => (${VIS})(i) && /fig(33|40)/.test(i.src));
  return imgs.map((i) => i.src.split('/').pop() + ' alt=' + (i.alt ?? '').slice(0, 20));
})()`));

// 6) 控制台错误数
console.log("console errors:", await evalJS(`(window.__errs ?? []).length`));
ws.close();
console.log("done");
