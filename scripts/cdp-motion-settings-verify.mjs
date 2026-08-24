// 动效批次 1 设置 UI 验证（第二轮）：开设置 → 动效模式下拉 → 逐档切换 → 校验 data-motion 与计算值
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
  if (res?.exceptionDetails) return `EXC: ${res.exceptionDetails.exception?.description?.slice(0, 200) ?? res.exceptionDetails.text}`;
  return res?.result?.value;
};

// 打开设置
console.log("OPEN", await evalJs(`(() => {
  const gear = [...document.querySelectorAll("button")].find((b) => b.querySelector("svg.lucide-settings"));
  if (!gear) return "no-gear";
  gear.click(); return "clicked";
})()`));
await sleep(700);

// 找到「动效模式」行的下拉触发器并点开（触发器文案 = 当前档位 label）。
// radix DropdownMenu 在 pointerdown 打开，el.click() 无效 → 用坐标级鼠标事件。
const openDropdown = async () => {
  const rect = await evalJs(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return "no-dialog";
    const labels = ["完整动效", "仅淡入淡出", "遵循系统"];
    const trigger = [...dlg.querySelectorAll("button")].find((b) => labels.includes((b.textContent || "").trim()));
    if (!trigger) return "no-trigger";
    const r = trigger.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, label: trigger.textContent.trim() });
  })()`);
  if (typeof rect !== "string" || !rect.startsWith("{")) return rect;
  const { x, y, label } = JSON.parse(rect);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(60);
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return "opened:" + label;
};

const pickItem = async (label) => {
  const rect = await evalJs(`(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => (i.textContent || "").trim() === ${JSON.stringify(label)});
    if (!item) return "no-item";
    const r = item.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`);
  if (typeof rect !== "string" || !rect.startsWith("{")) return rect;
  const { x, y } = JSON.parse(rect);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(60);
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return "picked";
};

const state = () => evalJs(`(() => {
  const cs = getComputedStyle(document.documentElement);
  return JSON.stringify({
    attr: document.documentElement.dataset.motion ?? null,
    base: cs.getPropertyValue("--motion-dur-base").trim(),
    slide: cs.getPropertyValue("--motion-slide").trim(),
    pop: cs.getPropertyValue("--motion-pop-scale").trim(),
  });
})()`);

console.log("D1", await openDropdown());
await sleep(400);
console.log("P1", await pickItem("仅淡入淡出"));
await sleep(200);
console.log("S1", await state());

console.log("D2", await openDropdown());
await sleep(400);
console.log("P2", await pickItem("遵循系统"));
await sleep(200);
console.log("S2", await state());

// 模拟系统「减少动态效果」开/关，验证 system 档实时跟随
await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await sleep(250);
console.log("S2R", await state());
await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
await sleep(250);
console.log("S2N", await state());

console.log("D3", await openDropdown());
await sleep(400);
console.log("P3", await pickItem("完整动效"));
await sleep(200);
console.log("S3", await state());

// 关闭对话框（Esc）
await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(400);
console.log("CLOSED", await evalJs(`document.querySelector('[role="dialog"]') ? "still-open" : "closed"`));

ws.close(); process.exit(0);
