// Table 2 速跳实盘验证 v2：quote 路径（无 tab 锚点论文）
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

await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "ok"`);
for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJS(`!!window.__layout`).catch(() => false)) break; }
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("13ddaa01b82a3291", "Routes"); true`);
await sleep(5000);
// 回文首模拟远距跳转
await evalJS(`(() => { const s = document.querySelector('.paper-content')?.closest('.overflow-y-auto'); if (s) s.scrollTo({top: 0}); true; })()`);
await sleep(600);

const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;

// 开图表 tab（若已开则跳过）
console.log("图表tab:", await evalJS(`(() => {
  const b = Array.from(document.querySelectorAll('button, [role="tab"]')).filter((x) => (${VIS})(x) && (x.textContent ?? '').trim() === '图表')[0];
  if (!b) return 'no-tab-btn';
  const selected = b.getAttribute('aria-selected') === 'true' || b.dataset.state === 'active';
  if (!selected) b.click();
  return selected ? 'already-active' : 'clicked';
})()`));
await sleep(1500);

// 在图表列表面板里找 Table 2 行（.space-y-2 直接子 div.group，徽章文本精确 Table 2）
console.log("点 Table 2:", await evalJS(`(() => {
  const rows = Array.from(document.querySelectorAll('.space-y-2 > div.group')).filter((x) => (${VIS})(x));
  const row = rows.find((x) => (x.querySelector('span')?.textContent ?? '').trim() === 'Table 2');
  if (!row) return 'row-not-found（行数 ' + rows.length + '）';
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return 'clicked';
})()`));

// 落点测量：正文里 Table 2 caption 块相对滚动容器顶部的距离（目标 ≈ clientHeight/3）
for (const wait of [700, 1500, 3000, 5000]) {
  await sleep(wait);
  console.log(`落点(${wait}ms):`, await evalJS(`(() => {
    const s = document.querySelector('.paper-content')?.closest('.overflow-y-auto');
    if (!s) return 'no-scroller';
    const blocks = Array.from(s.querySelectorAll('p, div, td, caption, h1,h2,h3,h4')).filter((x) => {
      const t = (x.textContent ?? '').replace(/\\s+/g, ' ').trim();
      return (${VIS})(x) && t.startsWith('Table 2 Summary of the properties');
    });
    if (!blocks.length) return 'caption-not-rendered';
    const el = blocks[0];
    return { delta: Math.round(el.getBoundingClientRect().top - s.getBoundingClientRect().top), expect: Math.round(s.clientHeight / 3), scrollTop: Math.round(s.scrollTop) };
  })()`));
}
ws.close();
console.log("done");
