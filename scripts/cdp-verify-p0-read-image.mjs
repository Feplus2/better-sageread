// L1 工具级校验：readImage 本地路径、getFigures 绝对路径、文献库约定注入（P0）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) { console.log("FAIL 找不到 dev 页面（9223）"); process.exit(1); }
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
let failed = 0;
for (const c of checks) { if (!c.pass) failed++; console.log((c.pass ? "ok   " : "FAIL ") + c.name + (c.info ? " | " + c.info : "")); }
console.log(failed === 0 ? "PASS (" + checks.length + " checks)" : "FAILED " + failed + "/" + checks.length);
ws.close();
process.exit(failed === 0 ? 0 : 1);