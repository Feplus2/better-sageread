// 验证 chat-md 微交互：真实 Markdown 组件渲染样张并截图
// 用法：node scripts/cdp-shot-chatmd.mjs <theme> [dark|light]
const theme = process.argv[2] || "lianyan";
const mode = process.argv[3] === "dark" ? "dark" : "light";
const LIST_URL = "http://127.0.0.1:9223/json/list";
const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => { const id = ++mid; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };

await cdp("Runtime.evaluate", {
  expression: `localStorage.setItem("globalTheme", ${JSON.stringify(theme)}); localStorage.setItem("themeMode", "${mode}"); "ok"`,
});
await cdp("Page.enable");
await cdp("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 8000));

const expression = `
(async () => {
  const origin = location.origin;
  const md = await import(origin + "/src/components/prompt-kit/markdown.tsx");
  const ReactNS = await import(origin + "/@id/react");
  const ReactDomNS = await import(origin + "/@id/react-dom");
  const ReactDomClientNS = await import(origin + "/@id/react-dom/client");
  const createElement = (ReactNS.createElement ?? ReactNS.default.createElement).bind(ReactNS.default ?? ReactNS);
  const flushSync = ReactDomNS.flushSync ?? ReactDomNS.default.flushSync;
  const createRoot = ReactDomClientNS.createRoot ?? ReactDomClientNS.default.createRoot;

  const sample = [
    "**粗体重点** 与 *斜体强调*，行内代码 \`readBookSection\`，以及[一个链接](https://example.com)。",
    "",
    "> 引用块：尽信书不如无书。",
    "",
    "1. 有序列表第一项",
    "2. 有序列表第二项",
    "",
    "- 无序列表甲",
    "- 无序列表乙",
    "",
    "\`\`\`ts",
    "const answer: number = 42;",
    "\`\`\`",
  ].join("\\n");

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;width:520px;padding:20px;border-radius:12px;background:var(--card);color:var(--card-foreground);box-shadow:0 8px 40px rgba(0,0,0,0.25)";
  host.className = "chat-md prose";
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(md.Markdown, null, sample)));
  await new Promise((r) => setTimeout(r, 400));
  return "rendered";
})()
`;
const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
console.log("render:", r.result?.result?.value);

const shot = await cdp("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
const out = `.tools/chatmd-${theme}-${mode}.png`;
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("saved:", out);
ws.close();
