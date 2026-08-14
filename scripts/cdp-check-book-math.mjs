// 应用内验证：打开修复后的 QFT 书，检查 iframe 内 MathML 是否渲染
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到主实例页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  const id = ++mid;
  pending.set(id, { promise, resolve });
  ws.send(JSON.stringify({ id, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    p.resolve(msg.error ? { __cdpError: msg.error.message } : msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Page.enable").catch(() => {});

const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.__cdpError) throw new Error(r.__cdpError);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

// 布局模块已在前次测试中挂到 window.__layout（若无则重新导入）
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "ok"`);
await new Promise((r) => setTimeout(r, 300));

for (const [bookId, title] of [
  ["bf167cc3003e200321fac3eb80c8d804", "QFT Standard Model"],
  ["e82fb55ed6580bdae874187e9160d567", "Modern Intro QFT"],
]) {
  await evalJS(`window.__layout.useLayoutStore.getState().openBook(${JSON.stringify(bookId)}, ${JSON.stringify(title)}); true`);
  await new Promise((r) => setTimeout(r, 6000));
  const probe = await evalJS(`(() => {
    const iframe = document.querySelector("iframe");
    if (!iframe) return { error: "no iframe" };
    const doc = iframe.contentDocument;
    if (!doc) return { error: "no contentDocument（跨源）" };
    const maths = [...doc.querySelectorAll("math")];
    const rendered = maths.filter((m) => m.getBoundingClientRect().height > 6).length;
    const codeFallback = doc.querySelectorAll('code[class*="latex"]').length;
    const rawText = doc.body.innerText.includes("\\\\frac") || doc.body.innerText.includes("\\\\omega");
    return {
      mathCount: maths.length,
      renderedWithLayout: rendered,
      codeFallback,
      rawLatexVisible: rawText,
    };
  })()`);
  console.log(`${title}:`, JSON.stringify(probe));
}

const shot = await call("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("F:/MyProjects/SageRead/.tmp-qft-math-verify.png", Buffer.from(shot.data, "base64"));
console.log("screenshot saved");
ws.close();
