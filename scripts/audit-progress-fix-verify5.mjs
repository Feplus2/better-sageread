// (b) 终验：搜索框隔离目标论文 → 状态通知 → 圆点响应式变色（零选择器歧义）；末清检索词
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => { r = res; }); pending.set(++mid, { pr, r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr, to = 20000) => {
  const msg = await Promise.race([call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }), new Promise((_, rej) => setTimeout(() => rej(new Error("eval timeout")), to))]);
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? "exc");
  return msg.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 检索框隔离出唯一目标（"Sodium-ion batteries" 精确标题词 + 作者词双词 AND）
const isolate = await evalJS(`(() => {
  const input = document.querySelector("input[placeholder*='检索标题']");
  if (!input) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "Sodium-ion batteries Hwang");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return "ok";
})()`);
console.log("检索词注入:", isolate);
await sleep(1200);

const dotsOfVisible = `(() => {
  const cards = Array.from(document.querySelectorAll("div.group.flex.cursor-pointer.items-start"));
  return cards.map((card) => {
    const d = card.querySelector(".rounded-full.border-2");
    return d ? (/green/.test(d.className) ? "green" : /red/.test(d.className) ? "red" : "neutral") : "none";
  });
})()`;
console.log("过滤后可见卡圆点:", await evalJS(dotsOfVisible), "（应仅 1 张卡）");

const setAndNotify = async (patch) => evalJS(`(async () => {
  const pe = (await import("/src/services/paper-events.ts"));
  const bs = (await import("/src/services/book-service.ts"));
  await bs.updateBookVectorizationMeta("5e9225b3eca98fbc", ${JSON.stringify(patch)});
  pe.notifyPaperStatusChanged("5e9225b3eca98fbc");
  return "ok";
})()`);

// 磁盘现状 = success（此前写入）。先写 idle+notify → 应转 neutral（响应式证据）
await setAndNotify({ status: "idle", chunkCount: 0 });
await sleep(1100);
console.log("idle+notify 后:", await evalJS(dotsOfVisible), "（期望 neutral）");
// 再写 success+notify → 应转 green（完成即转绿证据）
await setAndNotify({ status: "success", chunkCount: 42, finishedAt: Date.now() });
await sleep(1100);
console.log("success+notify 后:", await evalJS(dotsOfVisible), "（期望 green）");
// 还原 idle
await setAndNotify({ status: "idle", chunkCount: 0 });
await sleep(1100);
console.log("还原 idle 后:", await evalJS(dotsOfVisible), "（期望 neutral）");

// 清检索词
await evalJS(`(() => {
  const input = document.querySelector("input[placeholder*='检索标题']");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return "cleared";
})()`);
console.log("检索词已清");
ws.close();
process.exit(0);
