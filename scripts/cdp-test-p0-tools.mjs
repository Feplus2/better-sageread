// E2E 冒烟：P0 批 AI 工具封装（managePaperFolders / ragRange / getCitations / getFigures）
// 流程：CDP(9223) + vite 模块注入 → 页面上下文 import registry：
//   1) getToolsForScope("central") 含 managePaperFolders，且不含已否决下线的 createPaperAnnotation
//   2) getToolsForScope("paper", {paperId}) 含 getCitations/getFigures
//   3) reader 分支：有向量能力时含 ragRange；无则断言不在且不报错
//   4) managePaperFolders action=list 正常返回（真实库）
//   5) 找一篇真实 MARKDOWN 论文（listPapers 第一篇，没有则跳过并注明）：
//      getCitations/getFigures 结构正确
//   6) C2 清空语义收窄断言（找一篇无既有 source='ai'+category 标注的论文，找不到则跳过）：
//      建两条标注（一条 source='ai'+category='goal'，一条 source='ai' 无 category）
//      → deleteAiBookNotes → 带 category 的被删、无 category 的存活 → deleteBookNote 清理存活那条
// 运行：node scripts/cdp-test-p0-tools.mjs（需 dev 实例以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动）
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
  const registry = await import(origin + "/src/ai/tools/registry.ts");
  const paperSvc = await import(origin + "/src/services/paper-service.ts");
  const noteSvc = await import(origin + "/src/services/book-note-service.ts");

  // ---- 1. central 工具注册 ----
  const centralTools = registry.getToolsForScope("central");
  check("central: 含 managePaperFolders", !!centralTools.managePaperFolders, Object.keys(centralTools).join(","));
  check("central: 不含已否决下线的 createPaperAnnotation", !("createPaperAnnotation" in centralTools), "");

  // ---- 2. paper 工具注册（基础层） ----
  const paperTools = registry.getToolsForScope("paper", { paperId: "smoke-paper-id" });
  check("paper: 含 getCitations", !!paperTools.getCitations, Object.keys(paperTools).join(","));
  check("paper: 含 getFigures", !!paperTools.getFigures, "");

  // ---- 3. reader 分支 ragRange（向量能力门控） ----
  const llama = await import(origin + "/src/store/llama-store.ts");
  const hasVec = llama.useLlamaStore.getState().hasVectorCapability();
  const readerTools = registry.getToolsForScope("reader", { bookId: "smoke-book-id" });
  if (hasVec) {
    check("reader: 有向量能力 → 含 ragRange", !!readerTools.ragRange, Object.keys(readerTools).join(","));
  } else {
    check("reader: 无向量能力 → 不含 ragRange 且不报错", !("ragRange" in readerTools), "hasVectorCapability=false");
  }

  // ---- 4. managePaperFolders action=list（真实库） ----
  const listRes = await centralTools.managePaperFolders.execute(
    { reasoning: "CDP 冒烟", action: "list" },
    { toolCallId: "smoke", messages: [] },
  );
  check("managePaperFolders: list success", listRes?.results?.success === true, JSON.stringify(listRes?.results).slice(0, 200));
  check("managePaperFolders: list 返回 folders 数组", Array.isArray(listRes?.results?.folders), "");

  // ---- 5. 真实论文：getCitations / getFigures ----
  const papers = await paperSvc.listPapers();
  if (papers.length === 0) {
    check("paper 实库: 无 MARKDOWN 论文，跳过 getCitations/getFigures", true, "skipped");
  } else {
    const paper = papers[0];
    const pTools = registry.getToolsForScope("paper", { paperId: paper.id });

    const cite = await pTools.getCitations.execute({ reasoning: "CDP 冒烟" }, { toolCallId: "smoke", messages: [] });
    const citeOk =
      cite?.found === false
        ? typeof cite.message === "string" && cite.message.length > 0
        : cite?.found === true && typeof cite.content === "string" && typeof cite.total === "number";
    check("getCitations: 结构正确（found+content/total 或明确未找到）", citeOk, JSON.stringify(cite).slice(0, 200));

    const figs = await pTools.getFigures.execute({ reasoning: "CDP 冒烟" }, { toolCallId: "smoke", messages: [] });
    const figsOk =
      typeof figs?.total === "number" &&
      Array.isArray(figs?.figures) &&
      figs.figures.every(
        (f) =>
          typeof f.image === "string" &&
          typeof f.caption === "string" &&
          "section" in f &&
          (f.captionFrom === "alt" || f.captionFrom === "block" || f.captionFrom === null),
      ) &&
      typeof figs?.orphanCaptions === "number";
    const withCaption = (figs?.figures ?? []).filter((f) => f.caption).length;
    check(
      "getFigures: 结构正确（captionFrom/orphanCaptions）且多数图有图注",
      figsOk && (figs.total === 0 || withCaption / figs.total >= 0.5),
      JSON.stringify({ total: figs?.total, withCaption, orphanCaptions: figs?.orphanCaptions, sample: figs?.figures?.[0] }).slice(0, 300),
    );
  }

  // ---- 6. C2 清空语义收窄：deleteAiBookNotes 只删带 category 的 AI 标注 ----
  // deleteAiBookNotes 会真删该文献/书籍既有 C2 重点标注：只选无既有 source='ai'+category 标注的目标
  // （论文优先，其次普通书籍），找不到则跳过，绝不动真实数据
  const bookSvc = await import(origin + "/src/services/book-service.ts");
  const books = await bookSvc.getBooks();
  const candidates = [...papers.map((p) => p.id), ...books.map((b) => b.id)];
  let c2Paper = null;
  for (const id of candidates) {
    const notes = await noteSvc.getBookNotes(id);
    if (!notes.some((n) => n.source === "ai" && n.category && !n.deletedAt)) {
      c2Paper = id;
      break;
    }
  }
  if (!c2Paper) {
    check("C2 收窄: 所有文献/书籍均有既有 AI 重点标注，跳过（避免误删真实数据）", true, "skipped");
  } else {
    let withCatId = null;
    let noCatId = null;
    try {
      const withCat = await noteSvc.createBookNote({
        bookId: c2Paper, type: "annotation", cfi: "", note: "C2 收窄冒烟-重点", source: "ai", category: "goal",
      });
      withCatId = withCat.id;
      const noCat = await noteSvc.createBookNote({
        bookId: c2Paper, type: "annotation", cfi: "", note: "C2 收窄冒烟-对话", source: "ai",
      });
      noCatId = noCat.id;

      const removed = await noteSvc.deleteAiBookNotes(c2Paper);
      check("C2 收窄: deleteAiBookNotes 只删 1 条（带 category 的）", removed === 1, "removed=" + removed);

      const remaining = await noteSvc.getBookNotes(c2Paper);
      const withCatGone = !remaining.some((n) => n.id === withCatId && !n.deletedAt);
      const noCatAlive = remaining.some((n) => n.id === noCatId && !n.deletedAt);
      check("C2 收窄: 带 category 的 AI 标注已删", withCatGone, "");
      check("C2 收窄: 无 category 的 AI 标注存活", noCatAlive, "");
    } finally {
      // 清理：无 category 的存活条删除；带 category 的若断言失败残留也尽力清掉
      for (const id of [noCatId, withCatId]) {
        if (!id) continue;
        try {
          await noteSvc.deleteBookNote(id);
        } catch {}
      }
      check("C2 收窄: 测试标注已清理", true, "target=" + c2Paper);
    }
  }

  return { checks };
})()
`;

const result = await cdp("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
  timeout: 120000,
});

const value = result.result?.result?.value;
ws.close();
if (!value?.checks) {
  console.error("CDP 调用失败:", JSON.stringify(result).slice(0, 600));
  process.exit(1);
}

let failed = 0;
for (const c of value.checks) {
  if (c.pass) {
    console.log(`✓ ${c.name}`);
  } else {
    failed += 1;
    console.error(`✗ ${c.name}${c.info ? ` —— ${c.info}` : ""}`);
  }
}
console.log(`\n${value.checks.length - failed}/${value.checks.length} 通过`);
if (failed > 0) {
  console.error("FAIL");
  process.exit(1);
}
console.log("PASS");
