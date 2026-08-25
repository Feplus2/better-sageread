// 文献库管理态失灵复现（稳健版：全部 eval 带超时、分步打印）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  pending.set(++mid, { promise, resolve });
  ws.send(JSON.stringify({ id: mid, method, params }));
  setTimeout(() => { if (pending.has(mid)) { pending.get(mid).resolve(null); pending.delete(mid); } }, 20000);
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (!r) return "__timeout__";
  if (r.exceptionDetails) return "__err__ " + (r.exceptionDetails.exception?.description ?? "").slice(0, 200);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("当前 hash:", await evalJS("location.hash"));
await evalJS(`document.querySelector('a[href="#/papers"]')?.click(); "nav"`);
await sleep(2500);
console.log("导航后 hash:", await evalJS("location.hash"));

console.log("管理按钮点击:", await evalJS(`(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent ?? "").trim() === "管理");
  if (!b) return "not-found";
  b.click();
  return "clicked";
})()`));
await sleep(1200);

console.log("复选框数量:", await evalJS(`document.querySelectorAll('[role="checkbox"], input[type="checkbox"]').length`));
console.log("点第一个复选框:", await evalJS(`(() => {
  const b = document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')[0];
  if (!b) return "none";
  b.click();
  return "clicked";
})()`));
await sleep(800);

console.log("按钮状态:", await evalJS(`(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  const pick = (label) => { const b = btns.find((x) => (x.textContent ?? "").trim() === label); return b ? (b.disabled ? "DISABLED" : "enabled") : "n/a"; };
  return "向量化=" + pick("向量化") + " 翻译=" + pick("翻译") + " 重新解析=" + pick("重新解析");
})()`));

console.log("点击向量化:", await evalJS(`(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent ?? "").trim() === "向量化");
  if (!b || b.disabled) return "skip(disabled/none)";
  b.click();
  return "clicked";
})()`));
await sleep(3000);

console.log("任务栈与 toast:", await evalJS(`(() => {
  const toasts = Array.from(document.querySelectorAll("[data-sonner-toast]")).map((t) => (t.textContent ?? "").slice(0, 50));
  const stack = Array.from(document.querySelectorAll("#bottom-right-stack > *")).map((d) => (d.textContent ?? "").slice(0, 30));
  return JSON.stringify({ toasts, stack });
})()`));

// 控制台最近的报错
console.log("页面错误捕获:", await evalJS(`window.__lastError ?? "（无钩子）"`));

ws.close();
process.exit(0);
