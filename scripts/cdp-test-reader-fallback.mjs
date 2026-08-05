// E2E 冒烟：P3 reader 未向量化原文兜底（read_book_section）
//   1) Rust 命令直调：真实 EPUB 按标题读小节（先故意给错误标题拿候选清单，再按清单读成功）
//   2) 工具层：createReadBookSectionTool 工厂 execute（成功 + 未找到返回候选）
//   3) registry 分支：有向量能力 → rag 四件、无 readBookSection；无则相反
//   4) buildReadingPrompt 无向量时含「章节原文直读」注入段
// 运行：node scripts/cdp-test-reader-fallback.mjs（需 dev 实例 CDP 9223）
const LIST_URL = "http://127.0.0.1:9223/json/list";

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
  const checks = [];
  const check = (name, pass, info) => checks.push({ name, pass: !!pass, info: info == null ? "" : String(info) });
  const origin = location.origin;
  const core = await import(origin + "/@id/@tauri-apps/api/core");
  const registry = await import(origin + "/src/ai/tools/registry.ts");
  const promptMod = await import(origin + "/src/constants/prompt.ts");

  // 找一本真实 EPUB（books 表 format=EPUB；优先选公版教科书，避开内容不确定的书目）
  const bookSvc = await import(origin + "/src/services/book-service.ts");
  const books = await bookSvc.getBooks();
  const epubs = (books || []).filter((b) => (b.format || "").toUpperCase() === "EPUB");
  const epub = epubs.find((b) => /physics|crystalline|handbook|textbook|guide/i.test(b.title || "")) ??
    epubs.find((b) => /^[\x20-\x7E]+$/.test(b.title || ""));
  if (!epub) {
    check("存在 EPUB 测试书", false, "书库无 EPUB，全部跳过");
    return checks;
  }
  check("找到 EPUB 测试书", true, epub.title?.slice(0, 30));

  // ---- 1. Rust 命令直调：错误标题 → 候选清单 ----
  let candidates = [];
  try {
    await core.invoke("plugin:epub|read_book_section", { bookId: epub.id, chapterTitle: "不存在的章节XYZ", maxChars: null });
    check("错误标题应报错给候选", false, "未报错");
  } catch (e) {
    const msg = String(e);
    check("错误标题报错含候选清单", msg.includes("可选章节"), msg.slice(0, 90));
    const m = msg.match(/可选章节（前 20 条）：(.+)$/);
    candidates = m ? m[1].split("；").filter(Boolean) : [];
  }

  // ---- 2. 按候选标题读成功（选内容章：避开版权/照片等极短页） ----
  const pickContentChapter = (list) =>
    list.find((t) => /第一章|第.节|Chapter\s*\d|^1\s|^1\./i.test(t)) ?? list[list.length - 1];
  if (candidates.length > 0) {
    const title = pickContentChapter(candidates);
    const res = await core.invoke("plugin:epub|read_book_section", { bookId: epub.id, chapterTitle: title, maxChars: null });
    check("直读成功且正文非空", res?.text?.length > 200, "len=" + (res?.text?.length ?? 0) + " title=" + res?.matchedTitle?.slice(0, 24));
    check("返回结构完整", typeof res?.truncated === "boolean" && res?.pages >= 1 && res?.totalChars > 0, "");
  } else {
    check("直读成功且正文非空", false, "无候选标题可测");
  }

  // ---- 3. 工具层 execute ----
  const toolsMod = await import(origin + "/src/ai/tools/index.ts");
  const tool = toolsMod.createReadBookSectionTool(epub.id);
  if (candidates.length > 0) {
    const title = pickContentChapter(candidates);
    const r = await tool.execute({ reasoning: "smoke", chapterTitle: title }, { toolCallId: "s", messages: [] });
    check("工具 execute 成功", r?.results?.success === true && (r?.results?.content || "").length > 200, (r?.results?.message || "").slice(0, 60));
  }
  const rBad = await tool.execute({ reasoning: "smoke", chapterTitle: "不存在的章节XYZ" }, { toolCallId: "s", messages: [] });
  check("工具未找到时返回候选（success=false）", rBad?.results?.success === false && /可选章节/.test(rBad?.results?.message || ""), "");

  // ---- 4. registry 分支与提示词注入（hasVectorCapability 依赖嵌入模型配置异步加载，先等其稳定） ----
  const llama = await import(origin + "/src/store/llama-store.ts");
  await new Promise((r) => setTimeout(r, 2000));
  const hasVec = llama.useLlamaStore.getState().hasVectorCapability();
  const rt = registry.getToolsForScope("reader", { bookId: epub.id });
  if (hasVec) {
    check("有向量：rag 四件在、readBookSection 不在", !!rt.ragSearch && !!rt.ragToc && !!rt.ragContext && !!rt.ragRange && !rt.readBookSection, "");
  } else {
    check("无向量：readBookSection 在、rag 不在", !!rt.readBookSection && !rt.ragSearch, "");
    const prompt = await promptMod.buildReadingPrompt({ agentScope: "reader", activeBookId: epub.id });
    check("无向量提示词含原文直读段", prompt.includes("章节原文直读"), "");
  }

  return checks;
})()
`;

const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
const checks = result.result?.result?.value;
if (!Array.isArray(checks)) {
  console.error("页面上下文执行失败:", JSON.stringify(result).slice(0, 800));
  process.exit(1);
}

let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.info ? "  | " + c.info : ""}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} PASS`);
ws.close();
process.exit(pass === checks.length ? 0 : 1);
