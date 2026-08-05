// 复现顶栏色块错位：找 resize 手柄 → 拖 80px → 拖拽中/后各截一张顶部区域
const LIST_URL = "http://127.0.0.1:9223/json/list";
const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => { const id = ++mid; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const { writeFileSync } = await import("node:fs");

const handle = await cdp("Runtime.evaluate", {
  expression: `(() => { const hs = [...document.querySelectorAll(".custom-resize-handle")]; return JSON.stringify(hs.map((h) => { const r = h.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })); })()`,
  returnByValue: true,
});
const handles = JSON.parse(handle.result.result.value);
console.log("handles:", handles);
if (!handles.length) { console.log("没有手柄"); process.exit(1); }
const h = handles[0];

async function shot(name) {
  const s = await cdp("Page.captureScreenshot", { format: "png", clip: { x: Math.max(0, h.x - 500), y: 0, width: 1100, height: 90, scale: 1 } });
  writeFileSync(name, Buffer.from(s.result.data, "base64"));
  console.log("saved", name);
}

await shot(".tools/drag-before.png");
await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: h.x, y: h.y, button: "left", clickCount: 1 });
for (let i = 1; i <= 8; i++) {
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: h.x + i * 10, y: h.y, button: "left" });
  await new Promise((r) => setTimeout(r, 40));
}
await shot(".tools/drag-mid.png");
await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: h.x + 80, y: h.y, button: "left", clickCount: 1 });
await new Promise((r) => setTimeout(r, 600));
await shot(".tools/drag-after.png");
ws.close();
