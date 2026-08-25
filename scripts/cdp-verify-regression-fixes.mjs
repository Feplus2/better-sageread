// 回归修复实盘验证：
// ① 批量条只有单「翻译」按钮（无「重新翻译」按钮）；
// ② BottomRightPortal 恢复：勾选论文点向量化 → 右下角栈出现向量化通道卡（无 toast 缺失误判也一并记录）；
// ③ 阅读页单篇翻译卡已退役（栈内不出现「翻译中」标题小卡）；
// ④ 引文链接无 super 排版（CSS 已改）。
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
const evalJS = async (expression) => {
  const r = await new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "").slice(0, 300));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error(`FAIL - ${msg}`); } else { console.log(`ok - ${msg}`); }
};

await evalJS(`document.querySelector('a[href="#/papers"]')?.click(); "nav"`);
await sleep(2200);
await evalJS(`(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent ?? "").trim() === "管理"); b?.click(); return 1; })()`);
await sleep(1000);
await evalJS(`(() => { const b = document.querySelectorAll('[role="checkbox"]')[1] ?? document.querySelectorAll('[role="checkbox"]')[0]; b?.click(); return 1; })()`);
await sleep(800);

// ① 批量条按钮集合
const buttons = await evalJS(`Array.from(document.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim()).filter((t) => t === "翻译" || t === "重新翻译")`);
console.log("翻译类按钮:", JSON.stringify(buttons));
assert(buttons.length === 1 && buttons[0] === "翻译", `批量条只有单「翻译」按钮（got ${JSON.stringify(buttons)}）`);

// ② 点向量化 → 栈内出向量化通道卡
await evalJS(`(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent ?? "").trim() === "向量化"); if (b && !b.disabled) b.click(); return b?.disabled; })()`);
let cardSeen = false;
for (let i = 0; i < 12; i++) {
  await sleep(500);
  const stack = await evalJS(`Array.from(document.querySelectorAll("#bottom-right-stack *")).map((d) => (d.textContent ?? "").slice(0, 60)).join(" | ")`);
  if (stack.includes("向量化")) { cardSeen = true; break; }
}
assert(cardSeen, "向量化通道卡出现在右下角栈（BottomRightPortal 恢复生效）");

// ③ 栈内无「翻译中」单篇小卡标题（ReaderTranslateCard 已退役）
const stackText = await evalJS(`Array.from(document.querySelectorAll("#bottom-right-stack *")).map((d) => (d.textContent ?? "")).join(" ")`);
assert(!stackText.includes("翻译中"), "栈内无「翻译中」单篇小卡（ReaderTranslateCard 已退役）");

// ④ 引文链接无 super 排版
const cssCheck = await evalJS(`(() => {
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules ?? []) {
        const t = rule.cssText ?? "";
        if (t.includes('a[href^="#ref-"]') && t.includes("vertical-align: super")) return "STILL-SUPER";
      }
    } catch { /* cross-origin */ }
  }
  return "NO-SUPER";
})()`);
assert(cssCheck === "NO-SUPER", "引文链接无 super 排版（统一 [2,3] 正常大小）");

ws.close();
console.log(failed === 0 ? "\nPASS" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
