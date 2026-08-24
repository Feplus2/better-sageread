// 文献库管理态动效 DOM 级验证：进 管理 → 采样工具栏包装层 opacity + 行复选框 pop 类；退出 → 无残影
const LIST_URL = "http://127.0.0.1:9223/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expression) => {
  const res = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res?.exceptionDetails) return `EXC: ${res.exceptionDetails.exception?.description?.slice(0, 300) ?? res.exceptionDetails.text}`;
  return res?.result?.value;
};

// 先回主页（顶栏 home 图标），再点左侧导航「文献库」
console.log("HOME", await evalJs(`(() => {
  const icon = [...document.querySelectorAll("svg.lucide-house")].pop();
  icon?.closest("div.cursor-pointer")?.click(); return 1;
})()`));
await sleep(700);
console.log("NAV", await evalJs(`(() => {
  const link = document.querySelector('a[href="#/papers"]');
  if (!link) return "no-nav";
  link.click(); return "clicked";
})()`));
await sleep(2500); // loadAll 读盘，给足加载时间
// 进入管理模式（工具栏「管理」按钮；可能因无论文不存在）
console.log("ENTER", await evalJs(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "管理");
  if (!b) return "no-manage-btn（列表可能为空）";
  b.click(); return "clicked";
})()`));
const samples = [];
for (let i = 0; i < 6; i++) {
  samples.push(await evalJs(`(() => {
    const bar = document.querySelector(".motion-enter-slide-up");
    return bar ? +getComputedStyle(bar).opacity : null;
  })()`));
  await sleep(35);
}
console.log("TOOLBAR_OPACITY", JSON.stringify(samples));
console.log("POPS", await evalJs(`document.querySelectorAll(".motion-enter-pop").length`));
await sleep(300);
console.log("EXIT", await evalJs(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "完成");
  if (!b) return "no-finish-btn";
  b.click(); return "clicked";
})()`));
await sleep(150);
console.log("LEFTOVERS", await evalJs(`document.querySelectorAll(".motion-enter-slide-up, .motion-enter-pop").length`));
// 回图书馆
await evalJs(`(() => {
  const link = [...document.querySelectorAll("a, button, div")].find((e) => (e.textContent||"").trim() === "图书馆" && e.getBoundingClientRect().x < 200);
  link?.click(); return 1;
})()`);
ws.close(); process.exit(0);
