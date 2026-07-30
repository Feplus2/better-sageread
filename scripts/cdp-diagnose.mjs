// CDP 诊断：连接 WebView2 远程调试端口，收集页面 console 与异常
const LIST_URL = "http://127.0.0.1:9222/json/list";

async function waitForPage(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(LIST_URL);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

const page = await waitForPage(150000);
if (!page) {
  console.log("NO_PAGE_FOUND");
  process.exit(1);
}
console.log("PAGE:", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

ws.onopen = () => {
  send("Runtime.enable");
  send("Log.enable");
  send("Page.enable");
  // 重新加载页面，捕获启动期的全部错误
  send("Page.reload", { ignoreCache: true });
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    const desc = d.exception?.description || d.text;
    console.log("EXCEPTION:", desc?.slice(0, 1500));
    for (const f of d.stackTrace?.callFrames?.slice(0, 6) ?? []) {
      console.log(`  at ${f.functionName} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`);
    }
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const level = msg.params.type;
    if (level === "error" || level === "warning") {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      console.log(`CONSOLE.${level}:`, text.slice(0, 800));
    }
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    if (e.level === "error") console.log("LOG.error:", `${e.text}`.slice(0, 500), e.url ?? "");
  }
};

setTimeout(() => {
  console.log("DONE_COLLECTING");
  ws.close();
  process.exit(0);
}, 25000);
