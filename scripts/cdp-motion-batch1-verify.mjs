// 动效批次 1 CDP 验证（不改 Rust、不刷新页面，HMR 已应用改动）：
// 1) data-motion 生效链 + token 三档计算值
// 2) 设置 UI 三档切换即时生效（含 system 档模拟 prefers-reduced-motion 实时切换）
// 3) 图书馆管理态：批量条滑入 / 复选框 pop / 退出无残影（截图）
// 用法：node scripts/cdp-motion-batch1-verify.mjs
const LIST_URL = "http://127.0.0.1:9223/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) { console.error("no page"); process.exit(1); }
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
  if (res?.exceptionDetails) return `EXC: ${JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)}`;
  return res?.result?.value;
};
const shot = async (name) => {
  const res = await call("Page.captureScreenshot", { format: "png" });
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(".tmp-motion-verify", { recursive: true });
  writeFileSync(`.tmp-motion-verify/${name}.png`, Buffer.from(res.data, "base64"));
  return name;
};

// ---------- 1) token 生效链 ----------
const tokens = await evalJs(`(() => {
  const cs = getComputedStyle(document.documentElement);
  const pick = () => ({
    attr: document.documentElement.dataset.motion ?? null,
    fast: cs.getPropertyValue("--motion-dur-fast").trim(),
    base: cs.getPropertyValue("--motion-dur-base").trim(),
    slow: cs.getPropertyValue("--motion-dur-slow").trim(),
    ease: cs.getPropertyValue("--motion-ease").trim(),
    slide: cs.getPropertyValue("--motion-slide").trim(),
    scale: cs.getPropertyValue("--motion-scale").trim(),
    pop: cs.getPropertyValue("--motion-pop-scale").trim(),
  });
  const full = pick();
  document.documentElement.dataset.motion = "fade-only";
  const fade = pick();
  document.documentElement.dataset.motion = "reduced";
  const reduced = pick();
  document.documentElement.dataset.motion = full.attr ?? "full"; // 还原 CSS 层直改
  return JSON.stringify({ full, fade, reduced });
})()`);
console.log("TOKENS", tokens);

// ---------- 2) 设置 UI 三档切换 ----------
// 打开设置对话框（顶栏齿轮）
console.log("OPEN_SETTINGS", await evalJs(`(() => {
  const btns = [...document.querySelectorAll("button")];
  const gear = btns.find((b) => b.querySelector("svg.lucide-settings"));
  if (!gear) return "no-gear";
  gear.click();
  return "clicked";
})()`));
await sleep(600);
console.log("DIALOG", await evalJs(`(() => {
  const dlg = document.querySelector('[role="dialog"]');
  return dlg ? (dlg.textContent.includes("动效模式") ? "has-motion-item" : "no-motion-item") : "no-dialog";
})()`));

const pickMotion = async (label) => {
  const r = await evalJs(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return "no-dialog";
    const rows = [...dlg.querySelectorAll("div")].filter((d) => d.textContent.trim().startsWith("动效模式") && d.textContent.length < 60);
    const row = rows.at(-1)?.parentElement;
    const trigger = row?.querySelector("button");
    if (!trigger) return "no-trigger";
    trigger.click();
    return "opened";
  })()`);
  await sleep(400);
  const r2 = await evalJs(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const it = items.find((i) => i.textContent.trim() === ${JSON.stringify(label)});
    if (!it) return "no-item:" + items.map((i) => i.textContent.trim()).join("|");
    it.click();
    return document.documentElement.dataset.motion ?? null;
  })()`);
  await sleep(150);
  const attr = await evalJs(`document.documentElement.dataset.motion ?? null`);
  return `${r}/${r2} attr=${attr}`;
};

console.log("PICK_FADE_ONLY", await pickMotion("仅淡入淡出"));
console.log("FADE_COMPUTED", await evalJs(`getComputedStyle(document.documentElement).getPropertyValue("--motion-dur-base").trim()`));
// system 档 + 模拟系统减少动态效果（实时切换）
console.log("PICK_SYSTEM", await pickMotion("遵循系统"));
await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await sleep(200);
console.log("SYSTEM_REDUCED_ATTR", await evalJs(`document.documentElement.dataset.motion ?? null`));
await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
await sleep(200);
console.log("SYSTEM_RECOVER_ATTR", await evalJs(`document.documentElement.dataset.motion ?? null`));
// 还原为完整动效并关闭对话框
console.log("PICK_FULL", await pickMotion("完整动效"));
await evalJs(`(() => { document.querySelector('[role="dialog"] button:has(svg.lucide-x)')?.click(); return "x"; })()`);
await evalJs(`(() => {
  const dlg = document.querySelector('[role="dialog"]');
  const btn = dlg && [...dlg.querySelectorAll("button")].find((b) => b.querySelector("svg.lucide-x"));
  btn?.click();
  return "closed?" ;
})()`);
await sleep(400);
console.log("DIALOG_CLOSED", await evalJs(`document.querySelector('[role="dialog"]') ? "still-open" : "closed"`));

// ---------- 3) 图书馆管理态 ----------
// 确保在主页/图书馆（hash 路由：#/ 即主页）
console.log("WHERE", await evalJs(`location.hash`));
const hasMultiSelect = await evalJs(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "多选" || x.textContent.trim() === "退出多选");
  if (!b) return "no-button";
  if (b.textContent.trim() === "多选") { b.click(); return "entered"; }
  return "already-in-selection-mode";
})()`);
console.log("MANAGE_ENTER", hasMultiSelect);
await sleep(60); // 动画进行中（base 200ms）
await shot("manage-entering");
await sleep(500);
const manageState = await evalJs(`(() => {
  const bar = document.querySelector(".motion-enter-slide-up");
  const pops = document.querySelectorAll(".motion-enter-pop").length;
  const barOpacity = bar ? getComputedStyle(bar).opacity : null;
  return JSON.stringify({ bar: !!bar, barOpacity, popCount: pops });
})()`);
console.log("MANAGE_STATE", manageState);
await shot("manage-settled");
// 退出管理态：应立即无残影
await evalJs(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "退出多选");
  b?.click();
  return "exited";
})()`);
await sleep(120);
console.log("MANAGE_EXIT", await evalJs(`(() => {
  const leftovers = document.querySelectorAll(".motion-enter-slide-up, .motion-enter-pop").length;
  return leftovers === 0 ? "clean" : \`leftover=\${leftovers}\`;
})()`));
await shot("manage-exited");

ws.close();
process.exit(0);
