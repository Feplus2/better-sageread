// 返回按钮样式截图：开 forecast → 点文内引用链接转跳 → 截图底部按钮区域
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
await sleep(4000);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("57ae0a5f29feecb6", "forecast"); true`);
await sleep(4000);

// 点一个文内引用链接触发转跳
const clicked = await evalJS(`(() => {
  const VIS = (el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; };
  const link = Array.from(document.querySelectorAll('a[href^="#ref-"]')).find((a) => VIS(a));
  if (!link) return false;
  link.scrollIntoView({ block: 'center' });
  link.click();
  return true;
})()`);
console.log("clicked:", clicked);
await sleep(2500); // 等基线定格 + 按钮渲染

console.log("button present:", await evalJS(`!!Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('返回上处'))`));

const shot = await call("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
writeFileSync("F:/MyProjects/SageRead/scripts/.jumpback-style.png", Buffer.from(shot.data, "base64"));
console.log("screenshot saved");
ws.close();
