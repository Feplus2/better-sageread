// 解剖正文列遮罩链：从 .header-bar 向下找正文容器，逐级打印类名与计算背景
const LIST_URL = "http://127.0.0.1:9223/json/list";
const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => { const id = ++mid; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };

const expression = `
(() => {
  const h = document.querySelector(".header-bar");
  if (!h) return "no header (current page: " + location.hash + ")";
  const lines = [];
  // 顶栏所在的列容器
  const col = h.closest(".rounded-md");
  lines.push("COL: " + String(col?.className).slice(0, 110) + " | bg=" + (col ? getComputedStyle(col).backgroundColor : "?"));
  // 列内的直接子元素（正文容器在其中）
  if (col) {
    for (const child of col.children) {
      const cs = getComputedStyle(child);
      lines.push("child: " + String(child.className).slice(0, 90) + " | bg=" + cs.backgroundColor);
      for (const gc of child.children) {
        const gcs = getComputedStyle(gc);
        lines.push("  gc: " + String(gc.className).slice(0, 80) + " | bg=" + gcs.backgroundColor);
      }
    }
  }
  return lines.join("\\n");
})()
`;

const r = await cdp("Runtime.evaluate", { expression, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r).slice(0, 500));
ws.close();
