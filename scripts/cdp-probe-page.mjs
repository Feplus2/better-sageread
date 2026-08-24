// 探测当前页面状态：URL hash、主要文案、可点导航项
const list0 = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page0 = list0.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page0) {
  console.error("实例未就绪");
  process.exit(1);
}
const ws = new WebSocket(page0.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalp = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};

const out = await evalp(`(() => {
  const navCandidates = Array.from(document.querySelectorAll('nav a, nav button, aside a, aside button'))
    .map((el) => el.textContent.trim()).filter(Boolean).slice(0, 30);
  const main = document.querySelector('main');
  return {
    hash: location.hash,
    bodyHead: document.body.innerText.slice(0, 300),
    navCandidates,
    mainExists: !!main,
  };
})()`);
console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
