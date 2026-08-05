// 解剖：顶栏所在内容列的所有顶层子元素 + 绝对定位元素的全页扫描（找不随布局变宽的色块）
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
  if (!h) return "no header";
  const hr = h.getBoundingClientRect();
  const out = ["header rect: " + Math.round(hr.left) + "," + Math.round(hr.top) + " " + Math.round(hr.width) + "x" + Math.round(hr.height)];
  // 全页扫描：与顶栏同高带（top 相近、高度 ~40px）且带背景色/毛玻璃的元素
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.height < 30 || r.height > 60) continue;
    if (Math.abs(r.top - hr.top) > 20) continue;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const bd = cs.backdropFilter;
    const hasBg = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
    const hasBd = bd && bd !== "none";
    if (!hasBg && !hasBd) continue;
    out.push(
      (el === h ? "[HEADER] " : "") + el.tagName + " | bg=" + bg + " | bd=" + bd +
      " | pos=" + cs.position + " | rect=" + Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height) +
      " | cls=" + String(el.className).slice(0, 100)
    );
  }
  return out.join("\\n");
})()
`;

const r = await cdp("Runtime.evaluate", { expression, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r).slice(0, 500));
ws.close();
