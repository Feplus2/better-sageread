// 解剖论文顶栏色块：header 本体/伪元素/父链的算样式
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
  const header = document.querySelector(".header-bar");
  if (!header) return "header not found";
  const dump = (el, label) => {
    if (!el) return label + ": null";
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return label + " | bg=" + cs.backgroundColor + " | bd=" + cs.backdropFilter + " | pos=" + cs.position +
      " | rect=" + Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height) +
      " | cls=" + String(el.className).slice(0, 90);
  };
  const lines = [];
  lines.push(dump(header, "header"));
  const before = getComputedStyle(header, "::before");
  const after = getComputedStyle(header, "::after");
  lines.push("header::before | content=" + before.content + " | bg=" + before.backgroundColor + " | w=" + before.width + " | pos=" + before.position + " | inset=" + before.inset);
  lines.push("header::after | content=" + after.content + " | bg=" + after.backgroundColor + " | w=" + after.width + " | pos=" + after.position + " | inset=" + after.inset);
  let p = header.parentElement;
  for (let i = 1; i <= 4 && p; i++) { lines.push(dump(p, "parent" + i)); p = p.parentElement; }
  // 伪元素也常挂在容器上
  const gp = header.parentElement?.parentElement;
  if (gp) {
    const b = getComputedStyle(gp, "::before");
    const a = getComputedStyle(gp, "::after");
    lines.push("grandparent::before | content=" + b.content + " | bg=" + b.backgroundColor + " | w=" + b.width + " | pos=" + b.position + " | inset=" + b.inset + " | z=" + b.zIndex);
    lines.push("grandparent::after | content=" + a.content + " | bg=" + a.backgroundColor + " | w=" + a.width + " | pos=" + a.position + " | inset=" + a.inset + " | z=" + a.zIndex);
  }
  return lines.join("\\n");
})()
`;

const r = await cdp("Runtime.evaluate", { expression, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r).slice(0, 400));
ws.close();
