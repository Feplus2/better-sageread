// CDP 状态检查：论文 tab 是否打开、显示模式、译文 div 是否渲染
const LIST_URL = "http://127.0.0.1:9222/json/list";

async function getPage(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(LIST_URL);
      const page = (await res.json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

const page = await getPage();
if (!page) {
  console.log("NO_PAGE");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log("EXCEPTION:", (d.exception?.description || d.text || "").slice(0, 400));
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await new Promise((r) => setTimeout(r, 3000));

const res = await call("Runtime.evaluate", {
  expression: `JSON.stringify({
    url: location.href,
    tabBar: (document.body.innerText.match(/书籍|论文/g) || []).slice(0,4),
    hasPaperReader: !!document.querySelector('.prose'),
    translationDivs: document.querySelectorAll('[data-translation]').length,
    modeLabel: (() => {
      const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => ['原文','译文','逐段对照'].includes(t));
      return btns;
    })(),
    bodySample: (document.body.innerText || '').slice(0, 300),
  })`,
  returnByValue: true,
});
console.log(res?.result?.value);
ws.close();
process.exit(0);
