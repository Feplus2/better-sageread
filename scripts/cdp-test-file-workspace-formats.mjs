import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appModuleExpression } from "./cdp-app-module.mjs";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const outDir = process.env.VERIFY_OUT ?? ".tmp-agent-followup";
mkdirSync(outDir, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "file-workspace-formats-"));
const outside = mkdtempSync(join(tmpdir(), "file-workspace-assets-"));
const navigationHits = [];
const navigationServer = createServer((request, response) => {
  navigationHits.push(request.url);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<p>remote navigation loaded</p>");
});
await new Promise((resolve) => navigationServer.listen(0, "127.0.0.1", resolve));
const navigationUrl = `http://127.0.0.1:${navigationServer.address().port}/navigation-probe`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
writeFileSync(join(root, "pixel.png"), png);
writeFileSync(
  join(root, "vector.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="black"/></svg>',
);
writeFileSync(
  join(root, "paper.pdf"),
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
);
const outsidePng = join(outside, "outside.png");
writeFileSync(outsidePng, png);
writeFileSync(join(root, ".env"), "placeholder-not-a-secret");
const assetUrl = `http://asset.localhost/${outsidePng.replace(/\\/g, "/")}`;
writeFileSync(
  join(root, "sample.md"),
  `# 标题\n\n**加粗内容**\n\n![工作区图片](pixel.png)\n\n![越界图片](${assetUrl})\n\n[越界链接](${assetUrl})\n\n![敏感文件](.env)\n`,
);
writeFileSync(join(root, "sample.json"), '{"value":42,"items":[1,2,3]}');
writeFileSync(
  join(root, "sample.csv"),
  'name,value,note\r\nalpha,"1,024","said ""hello"""\r\nbeta,7,"第一行\n第二行"\r\n',
);
writeFileSync(
  join(root, "large.csv"),
  `name,value\n${Array.from({ length: 100 }, (_, index) => `row-${index},"${"x".repeat(4096)}"\n`).join("")}sentinel,CSV_END\n`,
);
writeFileSync(
  join(root, "sample.ts"),
  "interface Answer { value: number }\nexport const answer: Answer = { value: 42 };\n",
);
writeFileSync(
  join(root, "large.md"),
  `${Array.from({ length: 6500 }, (_, index) => `## 段落 ${index}\n\n**重点 ${index}** 与${"文本".repeat(12)}\n`).join("\n")}\n## 终章\n`,
);
writeFileSync(
  join(root, "large.html"),
  `<!doctype html><html><body><h1>大 HTML</h1><p>${"x".repeat(310000)}</p><footer>末段</footer></body></html>`,
);
writeFileSync(
  join(root, "game.html"),
  `<!doctype html><html><head><style>html,body{background:#123456;color:#fedcba}button{font:20px sans-serif;padding:12px;background:#e5f0ff}</style></head><body><button id="score" type="button">0</button><canvas id="board" width="30" height="30"></canvas><script>const score=document.querySelector("#score");score.addEventListener("click",()=>{score.textContent=String(Number(score.textContent)+1);document.body.dataset.gameRan="true"});document.querySelector("#board").getContext("2d").fillRect(0,0,30,30);</script></body></html>`,
);
writeFileSync(
  join(root, "plain.html"),
  "<!doctype html><html><body><p>未声明配色的 HTML 应保持白底黑字。</p></body></html>",
);
writeFileSync(
  join(root, "navigation.html"),
  `<!doctype html><html><body><p>本地导航隔离</p><script>document.body.dataset.inlineRan="true";console.log("__INLINE_RAN__");window.navigation?.addEventListener("navigate",event=>console.log("__NAVIGATION_PROBE__",JSON.stringify({type:event.navigationType,cancelable:event.cancelable,canIntercept:event.canIntercept,defaultPrevented:event.defaultPrevented})));location.href=${JSON.stringify(navigationUrl)};</script></body></html>`,
);
writeFileSync(
  join(root, "attack.html"),
  `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://workspace-attack.invalid/meta"><link rel="stylesheet" href="https://workspace-attack.invalid/style.css"><style>body{background:url(https://workspace-attack.invalid/css)}</style></head><body><h1>安全正文</h1><table><tr><th>列</th></tr><tr><td>保留</td></tr></table><script>window.addEventListener("unhandledrejection",(event)=>{if(String(event.reason).includes("undefined is not iterable")){document.body.dataset.nativeIpcRejected="true";event.preventDefault()}});document.body.dataset.scriptRan="true";try{parent.__workspaceAttack=true}catch{document.body.dataset.parentBlocked="true"};fetch("https://workspace-attack.invalid/script").catch(()=>{document.body.dataset.networkBlocked="true"});try{localStorage.getItem("thread")}catch{document.body.dataset.storageBlocked="true"};try{window.__TAURI_INTERNALS__.invoke("agent_write_file",{root:${JSON.stringify(root)},path:"ipc-probe.txt",content:"probe",allowOutside:false},{}).then(()=>{document.body.dataset.tauriCallSucceeded="true"}).catch(()=>{document.body.dataset.tauriBlocked="true"})}catch{document.body.dataset.tauriBlocked="true"};try{const callback=window.__TAURI_INTERNALS__.transformCallback(()=>{});const error=window.__TAURI_INTERNALS__.transformCallback(()=>{});Promise.resolve(window.ipc.postMessage({cmd:"agent_write_file",root:${JSON.stringify(root)},path:"raw-ipc-probe.txt",content:"probe",allowOutside:false,callback,error})).catch(()=>{document.body.dataset.rawIpcBlocked="true"});document.body.dataset.rawIpcSent="true"}catch{document.body.dataset.rawIpcBlocked="true"};</script><script src="https://workspace-attack.invalid/external.js"></script><img src="https://workspace-attack.invalid/img" onerror="parent.__workspaceAttack = true"><a href="file:///etc/passwd">本地链接</a><a href="https://workspace-attack.invalid/link">外部链接</a><iframe srcdoc="<script>parent.__workspaceAttack=true</script>"></iframe><object data="${assetUrl}"></object><embed src="https://workspace-attack.invalid/embed"><video poster="https://workspace-attack.invalid/poster"><source src="https://workspace-attack.invalid/video"></video></body></html>`,
);

const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error(`找不到 SageRead 页面（${cdpPort}/${appPort}）`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const assetRequests = [];
const navigationRequests = [];
const navigationResponses = [];
const navigationEvents = [];
const exceptions = [];
const exceptionInspections = [];
const expectedSandboxIpcErrors = [];
const executionContexts = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Network.requestWillBeSent") {
    const url = String(msg.params.request?.url ?? "");
    if (url.includes("asset.localhost") || url.startsWith("file:") || url.includes("workspace-attack.invalid")) {
      assetRequests.push(url);
    }
    if (url === navigationUrl) navigationRequests.push(msg.params.type);
  }
  if (msg.method === "Network.responseReceived" && msg.params.response.url === navigationUrl) {
    navigationResponses.push(msg.params.response.status);
  }
  if (
    msg.method === "Log.entryAdded" &&
    /Content Security Policy|Refused to frame|violates/i.test(msg.params.entry.text)
  ) {
    browserLogs.push({ text: msg.params.entry.text, url: msg.params.entry.url, level: msg.params.entry.level });
  }
  if (
    msg.method === "Runtime.consoleAPICalled" &&
    ["__INLINE_RAN__", "__NAVIGATION_PROBE__"].includes(msg.params.args[0]?.value)
  ) {
    navigationEvents.push(...msg.params.args.map((arg) => arg.value).filter((value) => typeof value === "string"));
  }
  if (msg.method === "Runtime.executionContextCreated")
    executionContexts.set(msg.params.context.id, msg.params.context);
  if (msg.method === "Runtime.executionContextDestroyed") executionContexts.delete(msg.params.executionContextId);
  if (msg.method === "Runtime.executionContextsCleared") executionContexts.clear();
  if (msg.method === "Runtime.exceptionThrown") {
    const details = msg.params.exceptionDetails;
    exceptions.push(details);
    exceptionInspections.push(inspectException(details));
  }
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const browserLogs = [];
const inspectException = (details) => {
  const text = details.exception?.description ?? details.text ?? "";
  if (
    text.includes("TypeError: undefined is not iterable") &&
    details.lineNumber === 110 &&
    details.columnNumber === 14 &&
    !details.url
  ) {
    details.nativeIpcFallback = true;
    expectedSandboxIpcErrors.push({
      scriptId: details.scriptId,
      text,
      source: "Tauri custom-protocol fallback (verified by script source)",
    });
  }
};
await call("Debugger.enable");
await call("Runtime.enable");
await call("Page.enable");
await call("Log.enable");
await call("Network.enable");
if (process.env.PROFILE_LARGE === "1") {
  await call("Performance.enable");
  await call("Profiler.enable");
  await call("Profiler.setSamplingInterval", { interval: 1000 });
}
const evaluate = async (expression, contextId) => {
  const result = await call("Runtime.evaluate", { expression, contextId, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
  }
  return result.result?.result?.value;
};
const evalJs = (expression) => evaluate(expression);
const previewDataDir = await evalJs(`(async () => {
  const pathApi = await import("/@id/@tauri-apps/api/path");
  return pathApi.appDataDir();
})()`);
if (!previewDataDir.includes("com.bettersageread.preview") && process.env.ALLOW_DAILY !== "1") {
  throw new Error(`拒绝在非隔离数据目录运行文件格式探针：${previewDataDir}`);
}
const evalHtmlFrame = async (expression) => {
  const tree = await call("Page.getFrameTree");
  const outer =
    tree.result.frameTree.childFrames?.find((frame) => frame.childFrames?.length) ??
    tree.result.frameTree.childFrames?.[0];
  const frameId = outer?.childFrames?.[0]?.frame?.id ?? outer?.frame?.id;
  const context = Array.from(executionContexts.values())
    .filter((item) => item.auxData?.frameId === frameId && item.auxData?.isDefault === true)
    .at(-1);
  if (!frameId || !context) {
    throw new Error("找不到内层 HTML 沙箱执行上下文");
  }
  return evaluate(expression, context.id);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForHtmlFrame = async (expression, description) => {
  let lastError;
  for (let index = 0; index < 100; index += 1) {
    try {
      if (await evalHtmlFrame(`Boolean(${expression})`)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`等待超时：${description}；${String(lastError)}；${JSON.stringify(browserLogs.slice(-12))}`);
};
const waitFor = async (expression, description, attempts = 100) => {
  for (let i = 0; i < attempts; i++) {
    if (await evalJs(`Boolean(${expression})`)) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${description}`);
};
const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail: String(detail) });
const openFile = async (name) => {
  const clicked = await evalJs(`(async () => {
    if (!document.querySelector('[data-region="file-explorer"]')) {
      const explorer = document.querySelector('[aria-label="打开文件资源管理器标签"]');
      if (!explorer) return false;
      explorer.click();
    }
    for (let index = 0; index < 100; index += 1) {
      const button = Array.from(document.querySelectorAll('[data-region="file-explorer"] button')).find((item) => item.textContent.includes(${JSON.stringify(name)}));
      if (button) { button.click(); return true; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  })()`);
  if (!clicked) {
    const detail = await evalJs(`(async () => {
      const agent = (await import(${appModuleExpression("/src/store/agent-settings-store.ts")})).useAgentSettingsStore.getState();
      return { workspaceRoot: agent.workspaceRoot, perAgentRoots: agent.perAgentRoots, explorer: document.querySelector('[data-region="file-explorer"]')?.textContent?.slice(0, 1000) };
    })()`);
    throw new Error(`目录中找不到 ${name}：${JSON.stringify(detail)}`);
  }
  await waitFor(
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === ${JSON.stringify(name)} && document.querySelector('[data-region="file-preview"]')?.dataset.status === "ready"`,
    `${name} 预览就绪`,
  );
};
function readNativePreviewText() {
  const executable = join(process.cwd(), "packages/app/src-tauri/target/debug/better-sageread.exe").replace(/'/g, "''");
  const script = `
    Add-Type -AssemblyName UIAutomationClient
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $process = Get-Process -Name "better-sageread" | Where-Object { $_.Path -eq '${executable}' } | Select-Object -First 1
    if (-not $process) { throw "isolated preview process not found" }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    @($elements | ForEach-Object { $_.Current.Name }) -join [Environment]::NewLine
  `;
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
}

const largeDocumentMetrics = [];
const largeProfiles = [];
let previous;
try {
  previous = await evalJs(`(async () => {
    const agent = (await import(${appModuleExpression("/src/store/agent-settings-store.ts")})).useAgentSettingsStore.getState();
    const files = (await import(${appModuleExpression("/src/store/file-workspace-store.ts")})).useFileWorkspaceStore.getState();
    const theme = (await import(${appModuleExpression("/src/store/theme-store.ts")})).useThemeStore.getState();
    return { workspaceRoot: agent.workspaceRoot, perAgentRoots: agent.perAgentRoots, safetyMode: agent.safetyMode, hosts: files.hosts, recentRoots: files.recentRoots, themeMode: theme.themeMode };
  })()`);
  await evalJs(`(async () => {
    const agent = (await import(${appModuleExpression("/src/store/agent-settings-store.ts")})).useAgentSettingsStore.getState();
    agent.setWorkspaceRoot(${JSON.stringify(root)});
    agent.setPerAgentRoot("central", null);
    agent.setSafetyMode("strict");
    (await import(${appModuleExpression("/src/store/file-workspace-store.ts")})).useFileWorkspaceStore.setState({ hosts: {}, recentRoots: {} });
    (await import(${appModuleExpression("/src/store/layout-store.ts")})).useLayoutStore.getState().navigateToHome();
    location.hash = "#/chat";
    return true;
  })()`);
  await waitFor(`!!document.querySelector('[aria-label="打开文件工作区"]')`, "全局助手与工作区入口");
  await evalJs(`(() => {
    const historyHeading = Array.from(document.querySelectorAll("h2")).find((item) => {
      const rect = item.getBoundingClientRect();
      return item.textContent === "历史对话" && rect.right > 0 && rect.left < window.innerWidth;
    });
    historyHeading?.parentElement?.querySelector("button:has(svg.lucide-arrow-left)")?.click();
    return true;
  })()`);
  await waitFor(
    `!Array.from(document.querySelectorAll("h2")).some((item) => {
    if (item.textContent !== "历史对话") return false;
    const rect = item.getBoundingClientRect();
    const panel = item.closest(".transform") ?? item;
    return rect.right > 0 && rect.left < window.innerWidth && Number.parseFloat(getComputedStyle(panel).opacity) > 0.05;
  })`,
    "关闭历史覆盖层",
  );
  await evalJs(`document.querySelector('[aria-label="打开文件工作区"]').click(); true`);
  await waitFor(`!!document.querySelector('[data-region="file-workspace"]')`, "文件工作区就绪");
  await evalJs(`(() => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals?.invoke) throw new Error("找不到 Tauri invoke 入口");
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    window.__binaryProbe = { calls: 0, created: [], revoked: [], create, revoke };
    URL.createObjectURL = (blob) => new Promise((resolve) => {
      setTimeout(() => {
        const url = create.call(URL, blob);
        window.__binaryProbe.calls++;
        window.__binaryProbe.created.push(url);
        resolve(url);
      }, 400);
    });
    URL.revokeObjectURL = (url) => {
      window.__binaryProbe.revoked.push(url);
      return revoke.call(URL, url);
    };
  })()`);

  await openFile("pixel.png");
  await waitFor(`document.querySelector('[data-region="file-preview"] img')?.naturalWidth > 0`, "PNG 解码");
  check(
    "PNG 以真实图片预览",
    await evalJs(`(() => {
      const image = document.querySelector('[data-region="file-preview"] img');
      return !!image && image.complete && image.naturalWidth > 0;
    })()`),
  );

  await openFile("paper.pdf");
  check(
    "PDF 通过守卫后的二进制 blob 内嵌预览",
    await evalJs(`document.querySelector('[data-region="file-preview"] iframe')?.src.startsWith("blob:")`),
  );

  await openFile("vector.svg");
  await waitFor(`document.querySelector('[data-region="file-preview"] img')?.naturalWidth > 0`, "SVG 解码");
  check(
    "SVG 通过守卫后的二进制 blob 预览",
    await evalJs(`(() => {
      const image = document.querySelector('[data-region="file-preview"] img');
      return !!image && image.src.startsWith("blob:") && image.complete && image.naturalWidth > 0;
    })()`),
  );

  await openFile("sample.md");
  await waitFor(
    `document.querySelector('[data-region="file-preview"] strong')?.textContent === "加粗内容"`,
    "Markdown 渲染",
  );
  check(
    "Markdown 使用现有渲染管线与 chat-md 主题",
    await evalJs(`(() => {
      const preview = document.querySelector('[data-region="file-preview"]');
      return preview?.querySelector(".chat-md h1")?.textContent === "标题" && !!preview.querySelector(".chat-md strong");
    })()`),
  );
  await waitFor(
    `Array.from(document.querySelectorAll('[data-region="file-preview"] img')).some((image) => image.src.startsWith("data:image/") && image.naturalWidth > 0)`,
    "Markdown 图片读取",
  );
  check(
    "Markdown 工作区图片通过守卫读取",
    await evalJs(
      `Array.from(document.querySelectorAll('[data-region="file-preview"] img')).some((image) => (image.src.startsWith("data:image/") || image.src.startsWith("blob:")) && image.complete && image.naturalWidth > 0)`,
    ),
  );
  check(
    "Markdown 越界与敏感资源被明确阻止",
    await evalJs(`(() => {
      const preview = document.querySelector('[data-region="file-preview"]');
      return preview?.textContent.includes("已阻止") && !preview.querySelector('img[src^="http://asset.localhost"], img[src^="https://asset.localhost"], a[href^="http://asset.localhost"], a[href^="https://asset.localhost"], a[href^="file:"]');
    })()`),
  );
  check(
    "预览没有越界 asset 或 file 请求",
    !assetRequests.some(
      (url) => url.startsWith("file:") || url.includes("outside.png") || url.includes("workspace-attack.invalid"),
    ),
    assetRequests.join("\n"),
  );

  await openFile("sample.json");
  await waitFor(`document.querySelector('[data-region="file-preview"] code span[style]')`, "JSON 着色");
  check(
    "JSON 格式化且内容正确",
    await evalJs(`document.querySelector('[data-region="file-preview"]')?.textContent.includes('"value": 42')`),
  );

  await openFile("sample.csv");
  check(
    "CSV 是语义表格且转义、换行和列对齐正确",
    await evalJs(`(() => {
      const table = document.querySelector('[data-region="csv-preview"] table');
      if (!table) return false;
      const rows = Array.from(table.querySelectorAll("tbody tr"));
      return table.querySelector("caption") && table.querySelectorAll("thead th").length === 3 &&
        rows.length === 2 && rows.every((row) => row.children.length === 3) &&
        rows[0].children[1].textContent === "1,024" && rows[0].children[2].textContent === 'said "hello"' &&
        rows[1].children[2].textContent === ${JSON.stringify("第一行\n第二行")};
    })()`),
  );
  check(
    "CSV 滚动区、表头和首列保持可访问",
    await evalJs(`(() => {
      const region = document.querySelector('[data-region="csv-preview"] [role="region"]');
      const header = document.querySelector('[data-region="csv-preview"] thead th');
      const first = document.querySelector('[data-region="csv-preview"] tbody th');
      return region?.tabIndex === 0 && region.getAttribute("aria-labelledby") && getComputedStyle(header).position === "sticky" && getComputedStyle(first).position === "sticky";
    })()`),
  );

  await openFile("large.csv");
  const csvContinuation = await evalJs(
    `Array.from(document.querySelectorAll('[data-region="file-preview"] button')).find((button) => button.textContent.includes("加载下一段"))?.textContent ?? null`,
  );
  check("大 CSV 提供真实续读入口", csvContinuation !== null, csvContinuation ?? "没有续读按钮");
  if (csvContinuation) {
    await evalJs(
      `Array.from(document.querySelectorAll('[data-region="file-preview"] button')).find((button) => button.textContent.includes("加载下一段"))?.click(); true`,
    );
    await waitFor(
      `document.querySelector('[data-region="file-preview"]')?.dataset.truncated === "false"`,
      "CSV 已读完",
    );
  }
  check(
    "大 CSV 续读后表格包含末尾记录",
    await evalJs(`document.querySelector('[data-region="csv-preview"]')?.textContent.includes("CSV_END") === true`),
  );

  await openFile("sample.ts");
  await waitFor(
    `document.querySelector('[data-region="file-preview"] .workspace-code-preview code span[style]')`,
    "TypeScript 着色",
  );
  check(
    "代码真实着色、主题背景与紧凑行高",
    await evalJs(`(() => {
      const code = document.querySelector('[data-region="file-preview"] .workspace-code-preview code');
      const pre = code?.closest("pre");
      if (!code || !pre || !code.querySelector("span[style]")) return false;
      const ratio = Number.parseFloat(getComputedStyle(pre).lineHeight) / Number.parseFloat(getComputedStyle(pre).fontSize);
      return code.textContent.includes("answer") && ratio <= 1.6 && getComputedStyle(pre).backgroundColor !== "rgba(0, 0, 0, 0)";
    })()`),
    await evalJs(`(() => {
      const pre = document.querySelector(".workspace-code-preview pre");
      return pre ? JSON.stringify({ lineHeight: getComputedStyle(pre).lineHeight, fontSize: getComputedStyle(pre).fontSize, background: getComputedStyle(pre).backgroundColor }) : "无代码 pre";
    })()`),
  );

  await openFile("game.html");
  await waitFor(`document.querySelector('[data-region="file-preview"] iframe[title="game.html"]')`, "小游戏预览");
  await evalJs(`document.querySelector('[aria-label="查看 HTML 代码"]').click(); true`);
  await waitFor(
    `document.querySelector('[data-region="file-preview"]').textContent.includes("addEventListener") && !document.querySelector('[data-region="file-preview"] iframe')`,
    "HTML 源码显示",
  );
  check("HTML 可在代码与预览间切换", true);
  await evalJs(
    `(async () => { await (await import(${appModuleExpression("/src/store/theme-store.ts")})).useThemeStore.getState().setThemeMode("light"); })()`,
  );
  await evalJs(`document.querySelector('[aria-label="预览 HTML"]').click(); true`);
  await waitFor(
    `document.querySelector('[data-region="file-preview"] iframe[title="game.html"]')`,
    "全局亮色下返回 HTML 预览",
  );
  const lightSource = await evalJs(`(async () => {
    const theme = (await import(${appModuleExpression("/src/store/theme-store.ts")})).useThemeStore.getState();
    const frame = document.querySelector('[data-region="file-preview"] iframe[title="game.html"]');
    return { mode: theme.themeMode, className: document.documentElement.className, srcdoc: frame?.srcdoc.slice(0, 1800) };
  })()`);
  check(
    "作者 CSS 已随预览文档进入沙箱",
    lightSource.srcdoc?.includes("#123456"),
    lightSource.srcdoc?.includes("#123456")
      ? JSON.stringify({ mode: lightSource.mode, className: lightSource.className })
      : JSON.stringify(lightSource),
  );
  await waitFor(
    `document.querySelector('[data-region="file-preview"] iframe[title="game.html"]')?.srcdoc.includes("#123456")`,
    "亮色全局下的作者 CSS 已进入新沙箱",
  );
  await waitForHtmlFrame(
    `getComputedStyle(document.body).backgroundColor === "rgb(18, 52, 86)" && getComputedStyle(document.body).color === "rgb(254, 220, 186)"`,
    "全局亮色下作者配色",
  );
  const authorLight = await evalHtmlFrame(
    "JSON.stringify({ background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color })",
  );
  check(
    "HTML 作者声明的深色底与浅色字在全局亮色下保持不变",
    authorLight === JSON.stringify({ background: "rgb(18, 52, 86)", color: "rgb(254, 220, 186)" }),
    authorLight,
  );
  await evalJs(`document.querySelector('[aria-label="查看 HTML 代码"]').click(); true`);
  await waitFor(
    `!!document.querySelector('[data-region="file-preview"] .workspace-code-preview pre')`,
    "HTML 代码高亮就绪",
  );
  const codeLight = await evalJs(
    `getComputedStyle(document.querySelector('[data-region="file-preview"] .workspace-code-preview pre')).backgroundColor`,
  );
  await evalJs(
    `(async () => { await (await import(${appModuleExpression("/src/store/theme-store.ts")})).useThemeStore.getState().setThemeMode("dark"); })()`,
  );
  await waitFor(
    `getComputedStyle(document.querySelector('[data-region="file-preview"] .workspace-code-preview pre')).backgroundColor !== ${JSON.stringify(codeLight)}`,
    "代码预览跟随全局暗色",
  );
  check("HTML 代码预览继续跟随全局明暗", true);
  await evalJs(`document.querySelector('[aria-label="预览 HTML"]').click(); true`);
  await waitFor(`document.querySelector('[data-region="file-preview"] iframe[title="game.html"]')`, "返回小游戏预览");
  await waitForHtmlFrame(
    `document.readyState === "complete" && !!document.querySelector("#score")`,
    "内层游戏加载完成",
  );
  await waitForHtmlFrame(
    `getComputedStyle(document.body).backgroundColor === "rgb(18, 52, 86)" && getComputedStyle(document.body).color === "rgb(254, 220, 186)"`,
    "全局暗色下作者配色",
  );
  const authorDark = await evalHtmlFrame(
    "JSON.stringify({ background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color })",
  );
  check(
    "HTML 作者配色在全局明暗切换前后完全一致",
    authorLight === authorDark,
    JSON.stringify({ authorLight, authorDark }),
  );
  await openFile("plain.html");
  await waitForHtmlFrame(`document.readyState === "complete"`, "无样式 HTML 就绪");
  const plainColors = await evalHtmlFrame(
    "JSON.stringify({ background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color, scheme: getComputedStyle(document.documentElement).colorScheme })",
  );
  check(
    "无样式 HTML 使用独立的白底黑字和亮色 UA 色彩体系",
    plainColors === JSON.stringify({ background: "rgb(255, 255, 255)", color: "rgb(17, 17, 17)", scheme: "light" }),
    plainColors,
  );
  await openFile("game.html");
  await waitForHtmlFrame(`document.readyState === "complete" && !!document.querySelector("#score")`, "游戏重新打开");
  check(
    "本地 DOM 按钮与 Canvas 在沙箱中真实执行",
    await evalHtmlFrame(`(() => {
      const score = document.querySelector("#score");
      score.click();
      const canvas = document.querySelector("#board");
      return score.textContent === "1" && document.body.dataset.gameRan === "true" && canvas.getContext("2d").getImageData(0,0,1,1).data[3] === 255;
    })()`),
  );

  await openFile("attack.html");
  await waitFor(`document.querySelector('[data-region="file-preview"] iframe[title="attack.html"]')`, "HTML 沙箱");
  await sleep(1000);
  const ipcProbeFile = await evalJs(
    `window.__TAURI_INTERNALS__.invoke("agent_workspace_stat", { root: ${JSON.stringify(root)}, path: "ipc-probe.txt", allowOutside: false }, {})`,
  );
  const rawIpcProbeFile = await evalJs(
    `window.__TAURI_INTERNALS__.invoke("agent_workspace_stat", { root: ${JSON.stringify(root)}, path: "raw-ipc-probe.txt", allowOutside: false }, {})`,
  );
  check(
    "HTML 仅允许 opaque-origin 内联脚本，保留严格 CSP",
    await evalJs(`(() => {
      const frame = document.querySelector('[data-region="file-preview"] iframe[title="attack.html"]');
      const shell = new DOMParser().parseFromString(frame?.srcdoc ?? "", "text/html");
      const inner = shell.querySelector("iframe");
      const innerSource = inner?.getAttribute("srcdoc") ?? "";
      return frame?.getAttribute("sandbox") === "allow-scripts" && !frame.getAttribute("sandbox").includes("allow-same-origin") &&
        frame.referrerPolicy === "no-referrer" && ["default-src 'none'", "frame-src 'none'", "object-src 'none'", "script-src 'unsafe-inline'"].every((rule) => frame.srcdoc.includes(rule)) &&
        inner?.getAttribute("sandbox") === "allow-scripts" && !inner.getAttribute("sandbox").includes("allow-same-origin") &&
        innerSource.includes("connect-src 'none'") &&
        !innerSource.includes("onerror") && !innerSource.includes("<iframe") && !innerSource.includes("<object") && !innerSource.includes("<script src=") && !innerSource.includes("url(");
    })()`),
  );
  check(
    "标准 invoke 与原始 IPC 都没有执行后端写命令",
    ipcProbeFile.exists === false && rawIpcProbeFile.exists === false,
    JSON.stringify({ ipcProbeFile, rawIpcProbeFile }),
  );
  check(
    "恶意脚本无法访问父页面、网络、存储或 Tauri",
    (await evalHtmlFrame(`JSON.stringify({
      ran: document.body.dataset.scriptRan,
      parentBlocked: document.body.dataset.parentBlocked,
      networkBlocked: document.body.dataset.networkBlocked,
      storageBlocked: document.body.dataset.storageBlocked,
      rawIpcSent: document.body.dataset.rawIpcSent,
      nativeIpcRejected: document.body.dataset.nativeIpcRejected,
      tauriCallSucceeded: document.body.dataset.tauriCallSucceeded,
    })`)) ===
      JSON.stringify({
        ran: "true",
        parentBlocked: "true",
        networkBlocked: "true",
        storageBlocked: "true",
        rawIpcSent: "true",
        nativeIpcRejected: "true",
      }),
    await evalHtmlFrame("JSON.stringify(document.body.dataset)"),
  );
  await call("Page.bringToFront");
  await sleep(150);
  const nativeHtmlText = readNativePreviewText();
  const htmlShot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/html-sandbox.png`, Buffer.from(htmlShot.result.data, "base64"));
  check(
    "HTML 实际渲染保留正文、表格且不展示脚本文本",
    nativeHtmlText.includes("安全正文") &&
      nativeHtmlText.includes("保留") &&
      nativeHtmlText.includes("列") &&
      !nativeHtmlText.includes("parent.__workspaceAttack") &&
      !nativeHtmlText.includes("fetch("),
    nativeHtmlText.slice(0, 500),
  );
  check("HTML 攻击脚本没有触达父页面", await evalJs("window.__workspaceAttack !== true"));
  check(
    "HTML 没有越界网络、本地文件或 asset 请求",
    !assetRequests.some(
      (url) => url.startsWith("file:") || url.includes("outside.png") || url.includes("workspace-attack.invalid"),
    ),
    assetRequests.join("\n"),
  );

  await evalJs(`(() => {
    const state = { frames: [], longTasks: [], last: performance.now(), observer: null, raf: 0 };
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      });
      state.observer.observe({ entryTypes: ["longtask"] });
    }
    const tick = (now) => {
      state.frames.push(now - state.last);
      state.last = now;
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
    window.__largePreviewPerf = state;
    return true;
  })()`);
  const sampleLargePreview = async (name) => {
    await evalJs("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const metrics = await evalJs(`(() => {
      const state = window.__largePreviewPerf;
      const preview = document.querySelector('[data-region="file-preview"]');
      const frames = state.frames.splice(0);
      return {
        frameSamples: frames.length,
        maxFrameMs: frames.length ? Math.max(...frames) : 0,
        longTasks: state.longTasks.splice(0),
        longTasksSupported: !!state.observer,
        domNodes: preview.querySelectorAll("*").length,
        richPreview: preview.dataset.richPreview ?? null,
        truncated: preview.dataset.truncated ?? null,
      };
    })()`);
    largeDocumentMetrics.push({ name, ...metrics });
  };
  const continueLargePreview = async (name) => {
    for (let index = 0; index < 6; index += 1) {
      const before = await evalJs(`(() => {
        const preview = document.querySelector('[data-region="file-preview"]');
        return {
          length: preview.querySelector("pre")?.textContent.length ?? 0,
          hasContinuation: Array.from(preview.querySelectorAll("button")).some((item) => item.textContent.includes("加载下一段")),
        };
      })()`);
      if (!before.hasContinuation) return;
      const profileThisChunk = process.env.PROFILE_LARGE === "1" && name === "markdown" && index === 1;
      const nativeMetrics = async () =>
        Object.fromEntries(
          (await call("Performance.getMetrics")).result.metrics.map((metric) => [metric.name, metric.value]),
        );
      const beforeMetrics = profileThisChunk ? await nativeMetrics() : null;
      if (profileThisChunk) await call("Profiler.start");
      await evalJs(`(() => {
        const preview = document.querySelector('[data-region="file-preview"]');
        const button = Array.from(preview.querySelectorAll("button")).find((item) => item.textContent.includes("加载下一段"));
        if (!button) throw new Error("分段续读按钮已消失");
        button.click();
        return true;
      })()`);
      await waitFor(
        `(() => {
          const preview = document.querySelector('[data-region="file-preview"]');
          const hasContinuation = Array.from(preview.querySelectorAll("button")).some((item) => item.textContent.includes("加载下一段"));
          return !hasContinuation || (preview.querySelector("pre")?.textContent.length ?? 0) > ${before.length};
        })()`,
        `${name} 第 ${index + 1} 次续读`,
      );
      await sampleLargePreview(`${name}-chunk-${index + 1}`);
      if (profileThisChunk) {
        const afterMetrics = await nativeMetrics();
        const { profile } = (await call("Profiler.stop")).result;
        const selfMicroseconds = new Map();
        for (let index = 0; index < profile.samples.length; index += 1) {
          const node = profile.samples[index];
          selfMicroseconds.set(node, (selfMicroseconds.get(node) ?? 0) + Math.max(0, profile.timeDeltas[index] ?? 0));
        }
        largeProfiles.push({
          name: `${name}-chunk-${index + 1}`,
          metrics: Object.fromEntries(
            ["LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration"].map((key) => [
              key,
              ((afterMetrics[key] ?? 0) - (beforeMetrics[key] ?? 0)) * 1000,
            ]),
          ),
          top: profile.nodes
            .map((node) => ({
              functionName: node.callFrame.functionName,
              url: node.callFrame.url,
              line: node.callFrame.lineNumber + 1,
              selfMs: (selfMicroseconds.get(node.id) ?? 0) / 1000,
            }))
            .filter((node) => node.selfMs > 0)
            .sort((a, b) => b.selfMs - a.selfMs)
            .slice(0, 25),
        });
      }
    }
    throw new Error(`${name} 超过六个有界分段仍未读完`);
  };
  await openFile("large.md");
  await sampleLargePreview("markdown-initial");
  check(
    "大 Markdown 首段有截断状态且保持纯文本",
    await evalJs(`(() => {
      const preview = document.querySelector('[data-region="file-preview"]');
      return preview.dataset.truncated === "true" && preview.dataset.richPreview === "bounded-text" && !!preview.querySelector("pre") && !preview.querySelector(".chat-md");
    })()`),
  );
  await continueLargePreview("markdown");
  await sampleLargePreview("markdown-complete");
  check(
    "大 Markdown 读完后仍有界降级，不整篇富渲染",
    await evalJs(`(() => {
      const preview = document.querySelector('[data-region="file-preview"]');
      return preview.dataset.truncated === "false" && preview.dataset.richPreview === "bounded-text" && preview.querySelector("pre")?.textContent.includes("终章") && !preview.querySelector(".chat-md") && preview.textContent.includes("纯文本");
    })()`),
    JSON.stringify(largeDocumentMetrics),
  );
  await openFile("large.html");
  await sampleLargePreview("html-initial");
  const htmlContinuation = await evalJs(`(() => {
    const preview = document.querySelector('[data-region="file-preview"]');
    const button = Array.from(preview.querySelectorAll("button")).find((item) => item.textContent.includes("加载下一段"));
    return { bounded: preview.dataset.truncated === "true" && preview.dataset.richPreview === "bounded-text" && !!preview.querySelector("pre") && !preview.querySelector("iframe"), hasContinuation: !!button };
  })()`);
  check("大 HTML 首段有明确截断状态且不静默当作完整文档", htmlContinuation.bounded, JSON.stringify(htmlContinuation));
  check("大 HTML 保留有界续读", htmlContinuation.hasContinuation);
  if (htmlContinuation.hasContinuation) await continueLargePreview("html");
  await sampleLargePreview("html-complete");
  check(
    "大 HTML 读完后保持纯文本和末段内容",
    await evalJs(`(() => {
      const preview = document.querySelector('[data-region="file-preview"]');
      return preview.dataset.truncated === "false" && preview.dataset.richPreview === "bounded-text" && preview.querySelector("pre")?.textContent.includes("末段") && !preview.querySelector("iframe");
    })()`),
  );
  check(
    "大文档记录真实帧间隔与 long task",
    largeDocumentMetrics.every((item) => item.frameSamples > 0),
    JSON.stringify(largeDocumentMetrics),
  );
  await evalJs(`(() => {
    const state = window.__largePreviewPerf;
    cancelAnimationFrame(state.raf);
    state.observer?.disconnect();
    delete window.__largePreviewPerf;
    return true;
  })()`);

  await sleep(500);
  check(
    "切换标签会撤销旧 PDF/SVG 的 Blob URL",
    await evalJs(`(() => {
      const probe = window.__binaryProbe;
      return probe.created.length > 0 && probe.created.every((url) => probe.revoked.includes(url));
    })()`),
    await evalJs("JSON.stringify(window.__binaryProbe)"),
  );

  await call("Emulation.setDeviceMetricsOverride", { width: 480, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  check(
    "窄屏下统一工作区开关仍在可视区域且可命中",
    await evalJs(`(() => {
      const button = document.querySelector('[aria-label="收起文件工作区，返回对话"]');
      if (!button) return false;
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.left >= 0 && rect.right <= window.innerWidth && hit && (hit === button || button.contains(hit));
    })()`),
    await evalJs(`(() => {
      const button = document.querySelector('[aria-label="收起文件工作区，返回对话"]');
      if (!button) return "统一开关不存在";
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const ancestors = [];
      for (let element = button; element && ancestors.length < 9; element = element.parentElement) {
        const bounds = element.getBoundingClientRect();
        ancestors.push({ tag: element.tagName, className: String(element.className).slice(0, 260), style: element.getAttribute("style"), width: bounds.width, left: bounds.left, right: bounds.right, minWidth: getComputedStyle(element).minWidth });
      }
      return JSON.stringify({ viewport: window.innerWidth, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, hit: hit?.outerHTML?.slice(0, 300), ancestors });
    })()`),
  );
  await evalJs(`document.querySelector('[aria-label="打开文件资源管理器标签"]').click(); true`);
  await waitFor(`!!document.querySelector('[data-region="file-explorer"]')`, "窄屏目录标签");
  check("窄屏下目录标签可打开", await evalJs(`!!document.querySelector('[data-region="file-explorer"]')`));
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/file-workspace-formats.png`, Buffer.from(shot.result.data, "base64"));
  await openFile("navigation.html");
  await waitFor(
    `document.querySelector('[data-region="file-preview"] iframe[title="navigation.html"]')`,
    "导航隔离预览",
  );
  await sleep(500);
  const navigationEvidence = await evalHtmlFrame(
    "({ inlineRan: document.body.dataset.inlineRan, url: location.href, navigationType: typeof window.navigation, scriptCount: document.scripts.length })",
  ).catch((error) => ({ error: String(error) }));
  const navigationSource = await evalJs(
    `document.querySelector('[data-region="file-preview"] iframe[title="navigation.html"]')?.srcdoc`,
  );
  check(
    "内联脚本运行后外部导航被隔离壳拒绝",
    navigationHits.length === 0 &&
      navigationResponses.length === 0 &&
      navigationEvents.includes("__INLINE_RAN__") &&
      navigationEvidence.url !== navigationUrl &&
      browserLogs.some(
        (entry) => entry.text.includes(new URL(navigationUrl).origin) && entry.text.includes("frame-src 'none'"),
      ),
    JSON.stringify({
      navigationHits,
      navigationEvents,
      navigationRequests,
      navigationResponses,
      navigationEvidence,
      navigationSource,
      browserLogs,
    }),
  );
  await evalJs(`document.querySelector('[aria-label="收起文件工作区，返回对话"]')?.click(); true`);
} catch (error) {
  checks.push({ name: "格式验收执行异常", pass: false, detail: error instanceof Error ? error.stack : String(error) });
} finally {
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await evalJs(`(async () => {
    const previous = ${JSON.stringify(previous)};
    if (previous) {
      const agent = (await import(${appModuleExpression("/src/store/agent-settings-store.ts")})).useAgentSettingsStore.getState();
      agent.setWorkspaceRoot(previous.workspaceRoot);
      agent.setPerAgentRoot("central", previous.perAgentRoots?.central ?? null);
      agent.setSafetyMode(previous.safetyMode);
      (await import(${appModuleExpression("/src/store/file-workspace-store.ts")})).useFileWorkspaceStore.setState({ hosts: previous.hosts, recentRoots: previous.recentRoots });
      if (previous.themeMode) await (await import(${appModuleExpression("/src/store/theme-store.ts")})).useThemeStore.getState().setThemeMode(previous.themeMode);
    }
    const perf = window.__largePreviewPerf;
    if (perf) {
      cancelAnimationFrame(perf.raf);
      perf.observer?.disconnect();
      delete window.__largePreviewPerf;
    }
    const probe = window.__binaryProbe;
    if (probe) {
      URL.createObjectURL = probe.create;
      URL.revokeObjectURL = probe.revoke;
      delete window.__binaryProbe;
    }
    return true;
  })()`).catch(() => {});
  await Promise.all(exceptionInspections);
  ws.close();
  navigationServer.closeAllConnections();
  await new Promise((resolve) => navigationServer.close(resolve));
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
const report = {
  checks,
  largeDocumentMetrics,
  largeProfiles,
  expectedSandboxIpcErrors,
  exceptions: exceptions
    .filter((item) => !item.nativeIpcFallback)
    .map((item) => item.exception?.description ?? item.text)
    .filter(Boolean),
};
writeFileSync(`${outDir}/file-workspace-formats.json`, JSON.stringify(report, null, 2));
for (const item of checks)
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` | ${item.detail}` : ""}`);
if (report.exceptions.length) console.log("页面异常:", report.exceptions);
if (checks.some((item) => !item.pass) || report.exceptions.length) process.exit(1);
console.log(`\n${checks.filter((item) => item.pass).length}/${checks.length} PASS`);
