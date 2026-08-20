// 侧栏底部截图：回主页后截左下角
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "ok"`);
for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJS(`!!window.__layout`).catch(() => false)) break; }
await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`);
await sleep(2000);
console.log("侧栏底部文本:", await evalJS(`(() => {
  const aside = document.querySelector('[data-region="app-sidebar"]');
  return aside ? (aside.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(-120) : null;
})()`));
const shot = await call("Page.captureScreenshot", { format: "png" });
(await import("node:fs")).writeFileSync("F:/MyProjects/SageRead/scripts/.sidebar-manual.png", Buffer.from(shot.data, "base64"));
console.log("saved");
ws.close();
