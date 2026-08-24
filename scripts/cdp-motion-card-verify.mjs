// MotionStackCard 隔离验证：用页面内同一组 vite deps（react/react-dom）建独立 React root，
// 渲染 <MotionStackCard>（portal 进 #bottom-right-stack），驱动 show true→false，
// 验证进场类、closing 延迟卸载（数据快照定格）、最终卸载无残留。
const LIST_URL = "http://127.0.0.1:9223/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await call("Page.enable");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expression) => {
  const res = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res?.exceptionDetails) return `EXC: ${res.exceptionDetails.exception?.description?.slice(0, 400) ?? res.exceptionDetails.text}`;
  return res?.result?.value;
};
const shot = async (name) => {
  const res = await call("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`.tmp-motion-verify/${name}.png`, Buffer.from(res.data, "base64"));
};

console.log("MOUNT", await evalJs(`(async () => {
  const names = performance.getEntriesByType("resource").map((r) => r.name);
  const latest = (inc) => names.filter((n) => n.includes(inc)).at(-1);
  const reactUrl = latest("deps/react.js");
  const domUrl = latest("deps/react-dom_client.js");
  const stackUrl = latest("bottom-right-stack.tsx");
  if (!reactUrl || !domUrl || !stackUrl) return JSON.stringify({ reactUrl, domUrl, stackUrl });
  const reactMod = await import(reactUrl);
  const domMod = await import(domUrl);
  const React = reactMod.default ?? reactMod;
  const createRoot = (domMod.default ?? domMod).createRoot;
  // 资源列表里的 ?t= 可能是旧版本（无 MotionStackCard 导出）——用无参 URL 取当前代码，
  // 其内部 react 引用与 deps 同 v=，实例一致
  const mod = await import("/src/components/ui/bottom-right-stack.tsx");
  const MotionStackCard = mod.MotionStackCard;
  if (!MotionStackCard) return "no-export:" + Object.keys(mod).join(",");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  window.__motionTest = { React, root, MotionStackCard };
  const render = (show, text) => root.render(
    React.createElement(MotionStackCard, { show },
      show ? React.createElement("div", { className: "w-80 rounded-xl border bg-background p-3.5 shadow-lg" }, text) : null)
  );
  window.__motionTest.render = render;
  render(true, "动效验证卡 · 进度 3/10");
  return "mounted";
})()`));
await sleep(100);
console.log("ENTER_MID", await evalJs(`(() => {
  const item = document.querySelector(".motion-stack-item");
  if (!item) return "no-card";
  return JSON.stringify({ closing: item.classList.contains("motion-closing"), opacity: getComputedStyle(item).opacity });
})()`));
await shot("card-enter-mid");
await sleep(400);
// 数据更新（show 仍 true，应实时刷新）
await evalJs(`window.__motionTest.render(true, "动效验证卡 · 进度 9/10"); 1`);
await sleep(150);
console.log("LIVE_UPDATE", await evalJs(`document.querySelector(".motion-stack-item")?.textContent ?? "none"`));
// show → false：closing 期应定格最后数据
await evalJs(`window.__motionTest.render(false); 1`);
await sleep(80);
console.log("CLOSING", await evalJs(`(() => {
  const item = document.querySelector(".motion-stack-item");
  if (!item) return "already-unmounted-BAD";
  return JSON.stringify({ closing: item.classList.contains("motion-closing"),
    opacity: getComputedStyle(item).opacity, text: (item.textContent||"").slice(0, 40) });
})()`));
await shot("card-closing");
await sleep(500);
console.log("AFTER_EXIT", await evalJs(`(() => {
  const item = document.querySelector(".motion-stack-item");
  return JSON.stringify({ unmounted: !item });
})()`));
await shot("card-exited");
// 清理测试 root
await evalJs(`window.__motionTest.root.unmount(); delete window.__motionTest; 1`);
ws.close(); process.exit(0);
