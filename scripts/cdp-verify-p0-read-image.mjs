// L1 工具级校验：readImage 本地路径、getFigures 绝对路径、文献库约定注入（P0）
const cdpPort = process.env.CDP_PORT ?? "9223";
const appPort = process.env.APP_PORT ?? "1420";
const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes(`localhost:${appPort}`));
if (!page) { console.log(`FAIL 找不到 Preview 页面（${cdpPort}/${appPort}）`); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m.result); } };
const call = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, { resolve }); ws.send(JSON.stringify({ id, method, params })); });
const evalJS = async (expr) => { const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
const checks = await evalJS(`(async () => {
  const out = [];
  const modUrl = (suffix) => {
    const entries = performance.getEntriesByType("resource");
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].name.indexOf(suffix) >= 0) return entries[i].name;
    }
    return new URL(suffix, location.origin).href;
  };
  const check = (name, pass, info) => out.push({ name, pass: !!pass, info: info == null ? "" : String(info).slice(0, 260) });
  const PAPER = "a27b187c6bd02d3c";
  const registry = await import("/src/ai/tools/registry.ts");
  const tools = registry.getToolsForScope("paper", { paperId: PAPER });
  check("paper scope 含 getFigures 与 readImage", !!tools.getFigures && !!tools.readImage, Object.keys(tools).join(","));
  const figs = await tools.getFigures.execute({ reasoning: "L1 校验" }, { toolCallId: "l1", messages: [] });
  check("getFigures 返回 >=4 张图", figs.total >= 4, "total=" + figs.total);
  const f0 = figs.figures[0];
  check("figure 带绝对 image_path", !!f0.image_path && /^[A-Za-z]:[\\/]/.test(f0.image_path), f0.image_path);
  const img = await tools.readImage.execute({ path: f0.image_path }, { toolCallId: "l1b", messages: [] });
  check("readImage(本地路径) 返回 content", img.type === "content", img.type);
  const filePart = img.type === "content" ? img.value.find((p) => p.type === "file") : null;
  check("readImage 返回图片 file part", !!filePart && /^image\\//.test(filePart.mediaType || ""), filePart && filePart.mediaType);
  check("file part 是 dataUrl", !!filePart && String(filePart.url).startsWith("data:"), filePart && String(filePart.url).slice(0, 40));
  const textPart = img.type === "content" ? img.value.find((p) => p.type === "text") : null;
  check("信封含 path/type/content", !!textPart && textPart.text.includes("<path>") && textPart.text.includes("<type>image</type>"), textPart && textPart.text.slice(0, 120));
  const small = await tools.readImage.execute({ path: f0.image_path, maxEdge: 512 }, { toolCallId: "l1e", messages: [] });
  const smallFile = small.type === "content" ? small.value.find((p) => p.type === "file") : null;
  check("maxEdge=512 生效（dataUrl 更小）", !!smallFile && String(smallFile.url).length < String(filePart.url).length, String(smallFile ? String(smallFile.url).length : 0) + " < " + String(filePart ? String(filePart.url).length : 0));
  const rel = await tools.readImage.execute({ path: "images/fig3.jpg" }, { toolCallId: "l1c", messages: [] });
  check("相对路径被明确拒绝", rel.type === "error-text", rel.value);
  const paperMdPath = f0.image_path.slice(0, f0.image_path.indexOf("/images/")) + "/paper.md";
  const nonImage = await tools.readImage.execute({ path: paperMdPath }, { toolCallId: "l1d", messages: [] });
  check("非图片文件被拒绝", nonImage.type === "error-text", nonImage.value);
  const promptMod = await import(modUrl("/src/constants/prompt.ts"));
  const prompt = await promptMod.buildPrompt({ agentScope: "reader" });
  check("reader prompt 注入文献库导航约定", prompt.includes("文献库导航约定"), "len=" + prompt.length);
  check("文献库约定含根与探索顺序", prompt.includes("/books") && prompt.includes("探索顺序"), "");
  return out;
})()`);

checks.push(...await evalJS(`(async () => {
  const out = [];
  const check = (name, pass, info) => out.push({ name, pass: !!pass, info: info == null ? "" : String(info).slice(0, 400) });
  const registry = await import("/src/ai/tools/registry.ts");
  const tools = registry.getToolsForScope("central");
  const core = await import("/@id/@tauri-apps/api/core");
  const pathApi = await import("/@id/@tauri-apps/api/path");
  const fsApi = await import("/@id/@tauri-apps/plugin-fs");
  const runId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  const appData = (await pathApi.appDataDir()).replace(/[\\\\/]+$/, "");
  const temp = (await pathApi.tempDir()).replace(/[\\\\/]+$/, "");
  const allowedDir = appData + "/task9-image-" + runId;
  const outsideDir = temp + "/sageread-task9-outside-" + runId;
  const epubDir = appData + "/image-cache/epub/task9-" + runId;
  const junction = allowedDir + "/figure-link";
  const junctionImage = junction + "/figure.png";
  const outsideImage = outsideDir + "/figure.png";
  const outsideAlias = outsideDir + "/nested/../figure.png";
  const epubImage = epubDir + "/figure.png";
  const sensitiveImage = allowedDir + "/model-provider.json";
  const opts = { toolCallId: "task9-p0-" + runId, messages: [] };
  const runCommand = (command) => core.invoke("agent_run_command", { root: null, command, timeoutSecs: 30 });
  let junctionCreated = false;

  if (await fsApi.exists(allowedDir) || await fsApi.exists(outsideDir) || await fsApi.exists(epubDir)) {
    throw new Error("Task 9 唯一测试路径已存在，拒绝覆盖");
  }
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext("2d");
  context.fillStyle = "#4f8f7a";
  context.fillRect(0, 0, 2, 2);
  const dataUrl = canvas.toDataURL("image/png");
  const pngBytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (char) => char.charCodeAt(0));

  try {
    await fsApi.mkdir(allowedDir, { recursive: true });
    await fsApi.mkdir(outsideDir, { recursive: true });
    await fsApi.mkdir(epubDir, { recursive: true });
    await fsApi.writeFile(outsideImage, pngBytes);
    await fsApi.writeFile(epubImage, pngBytes);
    await fsApi.writeFile(sensitiveImage, pngBytes);

    const epubRead = await core.invoke("agent_read_image", {
      root: null, additionalRoots: [], path: epubImage,
      allowOutside: false, expectedPath: null, expectedResolved: null,
    }).catch((error) => error);
    check(
      "agent_read_image 返回 ArrayBuffer 原始字节",
      epubRead instanceof ArrayBuffer && new Uint8Array(epubRead).length === pngBytes.length,
      epubRead instanceof ArrayBuffer ? "bytes=" + epubRead.byteLength : String(epubRead),
    );
    check("agent_read_image 不返回 JSON number 数组", !Array.isArray(epubRead), Object.prototype.toString.call(epubRead));

    const epubToolRead = await tools.readImage.execute({ path: epubImage }, opts);
    check("AppData/image-cache/epub 图片保持可读", epubToolRead.type === "content", epubToolRead.value || epubToolRead.type);

    const outsideResolved = await core.invoke("agent_resolve_path", { root: null, path: outsideAlias });
    const traversalDenied = await core.invoke("agent_read_image", {
      root: null, additionalRoots: [], path: outsideAlias,
      allowOutside: false, expectedPath: null, expectedResolved: null,
    }).then(() => "").catch((error) => String(error));
    check(".. 路径 canonical 判界且未确认不读", traversalDenied.includes("工作区外"), traversalDenied);
    const traversalGranted = await core.invoke("agent_read_image", {
      root: null, additionalRoots: [], path: outsideAlias,
      allowOutside: true, expectedPath: outsideAlias, expectedResolved: outsideResolved.resolved,
    }).catch((error) => error);
    check(
      ".. 路径仅在原始路径与 expectedResolved 同时匹配时放行",
      traversalGranted instanceof ArrayBuffer && new Uint8Array(traversalGranted).length === pngBytes.length,
      traversalGranted instanceof ArrayBuffer ? "bytes=" + traversalGranted.byteLength : String(traversalGranted),
    );

    if (/^[A-Za-z]:[\\\\/]/.test(appData)) {
      const linked = await runCommand('mklink /J "' + junction + '" "' + outsideDir + '"');
      junctionCreated = linked.exitCode === 0;
      check("真实 Windows junction 夹具创建", junctionCreated, JSON.stringify(linked).slice(0, 240));
      if (junctionCreated) {
        const linkedRead = await tools.readImage.execute({ path: junctionImage }, opts);
        check(
          "junction 指向界外时未确认拒绝读取",
          linkedRead.type === "error-text" && String(linkedRead.value).includes("工作区外"),
          linkedRead.value || linkedRead.type,
        );
      }
    } else {
      check("真实 Windows junction（平台跳过）", true, "SKIP: 当前 AppData 不是 Windows 盘符路径；mklink /J 仅适用于 Windows");
    }

    const sensitiveRead = await tools.readImage.execute({ path: sensitiveImage }, opts);
    check(
      "敏感文件名即使内容为 PNG 也拒绝",
      sensitiveRead.type === "error-text" && String(sensitiveRead.value).includes("凭据"),
      sensitiveRead.value || sensitiveRead.type,
    );
  } finally {
    if (junctionCreated) await runCommand('rmdir "' + junction + '"').catch(() => {});
    await fsApi.remove(allowedDir, { recursive: true }).catch(() => {});
    await fsApi.remove(outsideDir, { recursive: true }).catch(() => {});
    await fsApi.remove(epubDir, { recursive: true }).catch(() => {});
  }
  check(
    "P0 仅清理唯一自建图片与 junction",
    !(await fsApi.exists(allowedDir)) && !(await fsApi.exists(outsideDir)) && !(await fsApi.exists(epubDir)),
    allowedDir + " | " + outsideDir + " | " + epubDir,
  );
  return out;
})()`));

let failed = 0;
for (const c of checks) { if (!c.pass) failed++; console.log((c.pass ? "ok   " : "FAIL ") + c.name + (c.info ? ` | ${c.info}` : "")); }
console.log(failed === 0 ? `PASS (${checks.length} checks)` : `FAILED ${failed}/${checks.length}`);
ws.close();
process.exit(failed === 0 ? 0 : 1);