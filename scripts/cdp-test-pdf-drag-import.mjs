// CDP 冒烟：模拟 Tauri 拖放事件，验证文献库页拖入链路（遮罩 → runPdfImport → 失败态兜底）
// 用不存在的 PDF 路径——sidecar 快速失败，不污染书库；验证事件流与 UI 状态即可。
// 运行：node scripts/cdp-test-pdf-drag-import.mjs（dev 实例需 CDP 9223）
const LIST_URL = "http://127.0.0.1:9223/json/list";

const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
if (!page) throw new Error("找不到 SageRead 页面（9223 CDP 未连接）");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function cdp(method, params = {}) {
  const id = ++mid;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
async function evalJs(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error(`页面内异常: ${JSON.stringify(result.result.exceptionDetails).slice(0, 300)}`);
  return result.result?.result?.value;
}

// 0. 确认当前在文献库页
const url = await evalJs("location.hash || location.pathname");
console.log("当前路由:", url);

// 1. drag-enter → 应出现页面遮罩
await evalJs(`
  (async () => {
    const { emit } = await import(location.origin + "/node_modules/.vite/deps/@tauri-apps_api_event.js");
    await emit("tauri://drag-enter", { paths: ["C:/fake/test.pdf"], position: { x: 200, y: 200 } });
  })()
`);
await new Promise((r) => setTimeout(r, 600));
const overlay = await evalJs(`!![...document.querySelectorAll("span")].find((el) => el.textContent.includes("松开导入 PDF 并解析"))`);
console.log("drag-enter 遮罩:", overlay ? "✓ 出现" : "✗ 未出现");

// 2. drag-drop（不存在的 PDF）→ runPdfImport 启动 → sidecar 快速失败 → 错误态兜底
await evalJs(`
  (async () => {
    const { emit } = await import(location.origin + "/node_modules/.vite/deps/@tauri-apps_api_event.js");
    await emit("tauri://drag-drop", { paths: ["C:/fake/nonexistent-paper.pdf"], position: { x: 200, y: 200 } });
  })()
`);
let outcome = "timeout";
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const state = await evalJs(`
    (() => {
      const card = document.querySelector(".absolute.right-4.bottom-4");
      if (!card) return "no-card";
      const text = card.textContent ?? "";
      if (text.includes("PDF 不存在") || text.includes("解析失败") || text.includes("error")) return "error-shown";
      if (text.includes("启动解析") || text.includes("%")) return "running";
      return "other:" + text.slice(0, 60);
    })()
  `);
  if (state === "error-shown" || state === "no-card") {
    outcome = state;
    break;
  }
  if (i === 39) outcome = state;
}
console.log("drop 后状态:", outcome);

// 3. 清理错误卡
await evalJs(`
  (() => {
    const card = document.querySelector(".absolute.right-4.bottom-4");
    card?.querySelector("button")?.click();
    return true;
  })()
`);
ws.close();

if (overlay && outcome === "error-shown") {
  console.log("✓ 拖入链路验证通过（遮罩正常 + 启动正常 + 失败兜底正常）");
} else {
  console.error("✗ 验证未通过");
  process.exit(1);
}
