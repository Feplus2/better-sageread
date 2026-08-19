// 截图：当前高数书视图（含块级公式）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
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
await call("Page.enable").catch(() => {});
const fs = await import("node:fs");

for (const [i, frac] of [0.15, 0.5].entries()) {
  await call("Runtime.evaluate", {
    expression: `(async () => {
      // 翻到公式密集页：用 foliate 视图跳转
      const v = document.querySelector("foliate-view");
      if (v?.renderer?.goTo && ${frac === 0.15}) {
        try { await v.renderer.goTo({ fraction: ${frac} }); } catch {}
      } else if (v?.goToFraction) {
        try { await v.goToFraction(${frac}); } catch {}
      }
      return true;
    })()`,
    awaitPromise: true,
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const shot = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`F:/MyProjects/SageRead/.tmp-math-center-${i}.png`, Buffer.from(shot.data, "base64"));
  console.log(`saved .tmp-math-center-${i}.png`);
}
ws.close();
