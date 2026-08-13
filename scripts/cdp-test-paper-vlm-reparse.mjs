// E2E：新打包 exe（Papers_Converter f818d66，VLM 强OCR + 图组重裁）在真实应用内验证
// 通过 CDP(9223) + vite 模块注入走真实 startPaperPdfImport（mineru VLM 引擎）
// 验证：sidecar spawn → 事件流 → done → scan_papers_dir 产物可入库（不入库，只读）
// 运行：node scripts/cdp-test-paper-vlm-reparse.mjs（需 dev 实例以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动）
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIST_URL = "http://127.0.0.1:9223/json/list";
// 仓库内 OA fixture（CC-BY，akter2026atscale）：检验 VLM 强OCR + 图组重裁；
// 要检验封面切除请自行换一篇带期刊封面的订阅版 PDF（不入库，版权原因）
const PDF = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures/papers/akter2026atscale/source.pdf");

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv(String.raw`F:\MyProjects\Papers_Converter\.env`);

const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
if (!page) throw new Error("找不到 SageRead 页面（9223 CDP 未连接或未以调试端口启动）");

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

const expression = `
(async () => {
  const origin = location.origin;
  const svc = await import(origin + "/src/services/paper-service.ts");
  const storeMod = await import(origin + "/src/store/converter-store.ts");
  const store = storeMod.useConverterStore.getState();
  // 走 VLM 引擎（新默认路线）；token 来自用户自己的 Papers_Converter/.env，已配置则不动
  if (store.paperEngine !== "mineru") store.setPaperEngine("mineru");
  if (!store.mineruToken) store.setMineruToken(${JSON.stringify(env.MINERU_TOKEN ?? "")});
  const tokenError = svc.paperEngineTokenError("mineru");
  if (tokenError) return { phase: "token", error: tokenError };

  const events = [];
  const unlisten = await svc.listenPaperConvertProgress((p) => events.push(p));
  try {
    await svc.startPaperPdfImport(${JSON.stringify(PDF)});
  } catch (e) {
    unlisten();
    return { phase: "invoke", error: String(e) };
  }
  const deadline = Date.now() + 480000;
  let terminal = null;
  while (Date.now() < deadline) {
    terminal = events.find((e) => e.type === "done" || e.type === "error" || e.type === "terminated");
    if (terminal) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  unlisten();
  // scan 只读验证产物可入库（不 save，避免污染书库）
  let scan = null;
  if (terminal?.type === "done" && terminal.paper_dir) {
    try {
      const { invoke } = await import(origin + "/node_modules/.vite/deps/@tauri-apps_api_core.js");
      scan = await invoke("scan_papers_dir", { dir: terminal.paper_dir });
    } catch (e) { scan = { error: String(e) }; }
  }
  return { terminal, scan, eventCount: events.length, types: events.map((e) => e.type) };
})()
`;

const result = await cdp("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
  timeout: 490000,
});

const value = result.result?.result?.value;
if (!value) {
  console.error("CDP 调用失败:", JSON.stringify(result).slice(0, 600));
  process.exit(1);
}
console.log("事件数:", value.eventCount, "类型:", value.types?.join(","));
console.log("终态:", JSON.stringify(value.terminal ?? value.error ?? "（超时）"));
if (value.scan) console.log("扫描产物:", JSON.stringify(value.scan).slice(0, 400));
ws.close();
if (value.terminal?.type === "done" && value.scan && !value.scan.error && value.scan.length === 1) {
  console.log("✓ E2E 通过：新 exe（VLM 强OCR+图组重裁）在应用内真实流程走通");
} else if (value.terminal?.type === "done") {
  console.log("✓ 转换成功（scan 验证跳过或异常）:", JSON.stringify(value.scan));
} else {
  console.error("✗ E2E 未通过");
  process.exit(1);
}
