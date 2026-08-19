// 为 README 截图（简化版：不用 Emulation 覆盖，每步先预热模块再截图）
// 运行：node scripts/cdp-readme-shots.mjs（主实例 CDP 9223）
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets");

const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到主实例页面");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    m.error ? pending.get(m.id).rej(new Error(JSON.stringify(m.error))) : pending.get(m.id).res(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));

const evalJs = async (expression, retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { result, exceptionDetails } = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails).slice(0, 400));
      return result?.value;
    } catch (e) {
      if (attempt === retries) throw e;
      console.log(`eval 重试（${attempt}/${retries}）:`, String(e).slice(0, 80));
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
};

const shot = async (name) => {
  const { data } = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name), Buffer.from(data, "base64"));
  console.log("saved", name);
};

// 先预热模块（vite dev 冷模块导入可能触发全量重载，把随后的截图 promise 收走）
await evalJs(`import("/src/services/paper-service.ts").then(()=>import("/src/store/layout-store.ts")).then(()=>"warm")`);
console.log("modules warm");

// 1. 论文阅读器（打开 OA fixture 论文）
const paperId = await evalJs(`(async () => {
  const svc = await import("/src/services/paper-service.ts");
  const list = await svc.listPapers();
  const p = list.find((x) => x.title?.includes("At-Scale"));
  return p ? p.id : null;
})()`);
console.log("paperId:", paperId);
if (paperId) {
  await evalJs(`(async () => {
    const m = await import("/src/store/layout-store.ts");
    m.useLayoutStore.getState().openPaper(${JSON.stringify(paperId)}, "At-Scale");
    return "ok";
  })()`);
  await new Promise((r) => setTimeout(r, 7000));
  await shot("screenshot-paper-reader.png");
}

// 2. 文献库主页
await evalJs(`location.hash = "#/papers"; "ok"`);
await new Promise((r) => setTimeout(r, 3500));
await shot("screenshot-papers.png");

// 3. 使用手册
await evalJs(`location.hash = "#/manual"; "ok"`);
await new Promise((r) => setTimeout(r, 3500));
await shot("screenshot-manual.png");

// 4. AI 中心
await evalJs(`location.hash = "#/skills"; "ok"`);
await new Promise((r) => setTimeout(r, 3500));
await shot("screenshot-ai-hub.png");

ws.close();
console.log("done");
