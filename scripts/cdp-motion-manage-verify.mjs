// 管理态动效视觉验证（第三轮）：切到主页 tab → 图书馆多选 进/出 → 全程截图
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
  if (res?.exceptionDetails) return `EXC: ${res.exceptionDetails.exception?.description?.slice(0, 200) ?? res.exceptionDetails.text}`;
  return res?.result?.value;
};
const shot = async (name) => {
  const res = await call("Page.captureScreenshot", { format: "png" });
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(".tmp-motion-verify", { recursive: true });
  writeFileSync(`.tmp-motion-verify/${name}.png`, Buffer.from(res.data, "base64"));
};

// 切回主页（顶栏 home 图标，包裹在 div.cursor-pointer 内）
console.log("HOME", await evalJs(`(() => {
  const icon = [...document.querySelectorAll("svg.lucide-house")].pop();
  const item = icon?.closest("div.cursor-pointer") ?? icon?.parentElement;
  if (!item) return "no-home-item";
  item.click(); return "clicked";
})()`));
await sleep(700);

const clickBtn = async (text) => evalJs(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
  if (!b) return "no-button";
  b.click(); return "clicked";
})()`);

// 进管理态（full 档），抓动画中段与定稿
console.log("ENTER", await clickBtn("多选"));
await sleep(70);
await shot("lib-enter-mid");
await sleep(400);
console.log("STATE1", await evalJs(`(() => {
  const bar = document.querySelector(".motion-enter-slide-up");
  return JSON.stringify({ bar: !!bar, pops: document.querySelectorAll(".motion-enter-pop").length,
    opacity: bar ? getComputedStyle(bar).opacity : null });
})()`));
await shot("lib-enter-settled");

// 出管理态：无离场动画（设计如此），确认无残影
console.log("EXIT", await clickBtn("退出多选"));
await sleep(150);
console.log("STATE2", await evalJs(`JSON.stringify({ leftovers: document.querySelectorAll(".motion-enter-slide-up, .motion-enter-pop").length })`));
await shot("lib-exited");

// fade-only 档视觉抽查（直接改 attribute 模拟，最后还原）
await evalJs(`document.documentElement.dataset.motion = "fade-only"; "ok"`);
console.log("ENTER2", await clickBtn("多选"));
await sleep(50);
await shot("lib-enter-fade-mid");
await sleep(300);
await clickBtn("退出多选");
await evalJs(`document.documentElement.dataset.motion = "full"; "restored"`);

ws.close(); process.exit(0);
