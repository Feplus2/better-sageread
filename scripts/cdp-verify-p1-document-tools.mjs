// L1: P1 文档原语 readDocument / getDocumentInfo / searchLibrary
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) { console.log("FAIL no dev page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m.result); } };
const call = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, { resolve }); ws.send(JSON.stringify({ id, method, params })); });
const evalJS = async (expr) => { const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };

const checks = await evalJS(`(async () => {
  const out = [];
  const check = (name, pass, info) => out.push({ name, pass: !!pass, info: info == null ? "" : String(info).slice(0, 260) });
  const PAPER_A = "a27b187c6bd02d3c";
  const PAPER_B = "43f3adfdea61b6d4";
  const PAPER_C = "09515f7218b81d7f";
  const BOOK = "9f1820c6dcc62250458da69162b72e5d";
  const registry = await import("/src/ai/tools/registry.ts");
  const lazy = await import("/src/ai/tools/lazy-toolset.ts");
  // 2026-10-23：L1 需要跨论文/跨书读取，显式给用户圈定范围「图书馆+论文库」（不设置则默认 current，跨文档会被门禁拒绝）
  const paperTools = registry.getToolsForScope("paper", { paperId: PAPER_A, paperScopeIds: [PAPER_C], retrievalScope: "all" });
  check("paper scope 含 readDocument/getDocumentInfo/searchLibrary", !!paperTools.readDocument && !!paperTools.getDocumentInfo && !!paperTools.searchLibrary, Object.keys(paperTools).join(","));
  check("默认文档工具模式=new（旧工具不暴露）", !!paperTools.readDocument && !paperTools.readPaperSection && !paperTools.ragSearch, Object.keys(paperTools).length);
  check("new 模式含 getCitationGraph", !!paperTools.getCitationGraph, Object.keys(paperTools).length);
  const citationGraph = await paperTools.getCitationGraph.execute({ reasoning: "L1", doc: "paper:" + PAPER_A }, { toolCallId: "p15", messages: [] });
  check("getCitationGraph 参考文献总数>0", (citationGraph.references && citationGraph.references.total) > 0, citationGraph.references && citationGraph.references.total);
  check("getCitationGraph 结构完整", Array.isArray(citationGraph.references && citationGraph.references.in_library) && Array.isArray(citationGraph.cited_by && citationGraph.cited_by.papers), JSON.stringify({ refs: citationGraph.references && citationGraph.references.in_library.length, cited: citationGraph.cited_by && citationGraph.cited_by.total_papers }));

  const info = await paperTools.getDocumentInfo.execute({ reasoning: "L1", doc: "paper:" + PAPER_A }, { toolCallId: "p1", messages: [] });
  check("getDocumentInfo(paper) 标题", String(info.doc.title || "").includes("Rational design"), info.doc.title);
  check("getDocumentInfo(paper) outline>=4", info.outline.total >= 4, info.outline.total);
  check("getDocumentInfo(paper) figures=4", info.counts.figures === 4, info.counts.figures);
  check("getDocumentInfo(paper) citations>0", info.counts.citations > 0, info.counts.citations);
  check("getDocumentInfo(已索引论文) index.status=indexed", info.index.status === "indexed", info.index.status);
  const infoUnindexedPaper = await paperTools.getDocumentInfo.execute({ reasoning: "L1", doc: "paper:" + PAPER_B }, { toolCallId: "p1b", messages: [] });
  check("getDocumentInfo(未索引论文) index.status=not_indexed", infoUnindexedPaper.index.status === "not_indexed", infoUnindexedPaper.index.status + "/" + (infoUnindexedPaper.index.chunk_count ?? ""));
  const unindexedRead = await paperTools.readDocument.execute({ reasoning: "L1", doc: "paper:" + PAPER_B, offset: 0, after: 1200 }, { toolCallId: "p1c", messages: [] });
  check("readDocument(未索引论文) 返回 index=not_indexed", unindexedRead.index && unindexedRead.index.status === "not_indexed", unindexedRead.index && unindexedRead.index.status);

  const cross = await paperTools.readDocument.execute({ reasoning: "L1", doc: "paper:" + PAPER_B, heading: "Results and discussion", after: 3000 }, { toolCallId: "p2", messages: [] });
  check("readDocument 跨论文标题", String(cross.doc.title || "").includes("Dehydration"), cross.doc.title);
  check("readDocument 跨论文正文>500", String(cross.text || "").length > 500, String(cross.text || "").length);
  check("readDocument 跨论文内容匹配", /PB|Prussian|dehydrat/i.test(String(cross.text || "")), "");

  const win = await paperTools.readDocument.execute({ reasoning: "L1", doc: "paper:" + PAPER_A, offset: 1000, after: 600 }, { toolCallId: "p3", messages: [] });
  check("readDocument offset 窗口<=600", String(win.text || "").length <= 600, String(win.text || "").length);
  check("readDocument offset next_offset", typeof win.next_offset === "number", win.next_offset);

  const readerTools = registry.getToolsForScope("reader", { bookId: BOOK, retrievalScope: "all" });
  const bookRead = await readerTools.readDocument.execute({ reasoning: "L1", doc: "book:" + BOOK, heading: "第三章 政治学", after: 3000 }, { toolCallId: "p4", messages: [] });
  check("readDocument(book) 命中章节", String(bookRead.anchor.heading || "").includes("第三章"), bookRead.anchor.heading);
  check("readDocument(book) 正文匹配", /萨特|政治/.test(String(bookRead.text || "")), String(bookRead.text || "").slice(0, 80));

  const infoBook = await readerTools.getDocumentInfo.execute({ reasoning: "L1", doc: "book:" + BOOK }, { toolCallId: "p5", messages: [] });
  check("getDocumentInfo(book) indexed", infoBook.index.status === "indexed", infoBook.index.status);
  check("getDocumentInfo(book) toc>=10", infoBook.outline.total >= 10, infoBook.outline.total);

  const civilTools = registry.getToolsForScope("reader", { bookId: "718a0d5d6514980ce87dd8b0d39ad2dc" });
  const infoCivil = await civilTools.getDocumentInfo.execute({ reasoning: "L1", doc: "book:718a0d5d6514980ce87dd8b0d39ad2dc" }, { toolCallId: "p5b", messages: [] });
  check("getDocumentInfo(未索引书) 目录 5-40 条（EPUB TOC 回退）", infoCivil.outline.total >= 5 && infoCivil.outline.items.length <= 40, infoCivil.outline.total + "/" + infoCivil.outline.source + "/items=" + infoCivil.outline.items.length);

  // 2026-10-23 用户拍板：new 模式恢复文件五件套（readLocalFile/writeFile/editFile/searchFiles/runCommand）
  const FILE_TOOLS = ["readLocalFile", "writeFile", "editFile", "searchFiles", "runCommand"];
  window.__SAGEREAD_DOC_TOOL_MODE__ = "new";
  const newModeTools = registry.getToolsForScope("paper", { paperId: PAPER_A, paperScopeIds: [PAPER_C], retrievalScope: "all" });
  check("new 模式隐藏旧读工具", !newModeTools.readPaperSection && !newModeTools.getPaperToc && !newModeTools.paperSearch && !!newModeTools.readDocument, Object.keys(newModeTools).length);
  check(
    "new 模式恢复文件五件套（write/edit/search/run 不再隐藏）",
    FILE_TOOLS.every((name) => !!newModeTools[name]),
    FILE_TOOLS.filter((name) => !newModeTools[name]).join(",") || Object.keys(newModeTools).join(","),
  );
  check(
    "new 模式 paper 工具数 = 24（shared 16 + paper 专属 8）",
    Object.keys(newModeTools).length === 24,
    Object.keys(newModeTools).length,
  );
  const newChars = lazy.estimateToolsChars(newModeTools);
  // transport 对 reader/paper 的 new 模式本就强制目录牌（forceDirectoryForNewMode），
  // 因此 schema 上涨对请求面影响有限；这里只校验目录牌预算事实（>12k 会触发）。
  check(
    "new 模式 schema 超 12k → 目录牌预算触发（与 transport 强制目录牌一致）",
    lazy.shouldUseDirectoryMode(newModeTools) === true,
    newChars + " chars",
  );
  const readerNewModeTools = registry.getToolsForScope("reader", { bookId: BOOK, retrievalScope: "all" });
  check(
    "reader new 模式恢复文件五件套",
    FILE_TOOLS.every((name) => !!readerNewModeTools[name]),
    FILE_TOOLS.filter((name) => !readerNewModeTools[name]).join(",") || Object.keys(readerNewModeTools).join(","),
  );
  check(
    "reader new 模式工具数 = 21（shared 16 + reader 专属 5）",
    Object.keys(readerNewModeTools).length === 21,
    Object.keys(readerNewModeTools).length,
  );
  const readerChars = lazy.estimateToolsChars(readerNewModeTools);
  check(
    "reader new 模式 schema 超 12k → 目录牌预算触发",
    lazy.shouldUseDirectoryMode(readerNewModeTools) === true,
    readerChars + " chars",
  );
  window.__SAGEREAD_DOC_TOOL_MODE__ = "legacy";
  const legacyModeTools = registry.getToolsForScope("paper", { paperId: PAPER_A, paperScopeIds: [PAPER_C], retrievalScope: "all" });
  check("legacy 模式隐藏新原语", !legacyModeTools.readDocument && !!legacyModeTools.readPaperSection, Object.keys(legacyModeTools).length);
  check("legacy 模式文件五件套仍在", FILE_TOOLS.every((name) => !!legacyModeTools[name]), "");
  delete window.__SAGEREAD_DOC_TOOL_MODE__;

  const search = await paperTools.searchLibrary.execute({ reasoning: "L1", query: "environmentally stable interface layered oxide cathode", scope: "all" }, { toolCallId: "p6", messages: [] });
  check("searchLibrary(all) 命中", search.total >= 1, search.total);
  check("searchLibrary 片段<=405", (search.results || []).every((r) => String(r.snippet).length <= 405), (search.results || []).map((r) => String(r.snippet).length).join(","));
  check("searchLibrary(all) doc 锚点（paper:<id> / book:<id>）", (search.results || []).every((r) => /^(paper|book):/.test(String(r.doc))), (search.results || []).map((r) => r.doc).join(","));
  check("searchLibrary 无 citation_guide", !("citation_guide" in search), Object.keys(search).join(","));

  const figs2 = await paperTools.getFigures.execute({ reasoning: "L1" }, { toolCallId: "p10", messages: [] });
  const imgPath = figs2.figures[0].image_path;
  let imageOk = 0;
  for (let i = 0; i < 4; i++) {
    const r = await paperTools.readImage.execute({ path: imgPath }, { toolCallId: "p10-" + i, messages: [] });
    if (r.type === "content") imageOk += 1;
  }
  check("连续看 4 张图不被每轮张数限制", imageOk === 4, imageOk + "/4");
  const imgLarge = await paperTools.readImage.execute({ path: imgPath, maxEdge: 1536 }, { toolCallId: "p10-large", messages: [] });
  const imgSmall = await paperTools.readImage.execute({ path: imgPath, maxEdge: 512 }, { toolCallId: "p10-small", messages: [] });
  const largeUrl = imgLarge.type === "content" ? (imgLarge.value.find((p) => p.type === "file") || {}).url : "";
  const smallUrl = imgSmall.type === "content" ? (imgSmall.value.find((p) => p.type === "file") || {}).url : "";
  check("maxEdge 可放大到 1536 且 512 更小", String(largeUrl).length > String(smallUrl).length && String(smallUrl).length > 0, String(smallUrl).length + " < " + String(largeUrl).length);
  // 文本读取不再有每轮硬上限：多次 readDocument 都应正常返回
  let readsOk = 0;
  for (let i = 0; i < 5; i++) {
    const r = await paperTools.readDocument.execute({ reasoning: "L1", doc: "paper:" + PAPER_A, offset: i * 1000, after: 3000 }, { toolCallId: "p9-" + i, messages: [] });
    if (String(r.text || "").length > 0) readsOk += 1;
  }
  check("文本读取无每轮硬上限", readsOk === 5, readsOk + "/5");

  // 旧断言用 legacy 的 scope:"collection"（新 searchLibrary 已无此档，schema enum=current/library/all）；
  // 改为验证新原语的范围收窄语义：用户圈 all 时，模型可收窄到 current（只查当前论文）。
  const narrowed = await paperTools.searchLibrary.execute({ reasoning: "L1", query: "interface stability", scope: "current" }, { toolCallId: "p7", messages: [] });
  const bookSearch = await readerTools.searchLibrary.execute({ reasoning: "L1", doc: "book:" + BOOK, query: "政治 知识分子" }, { toolCallId: "p11", messages: [] });
  check("searchLibrary(doc=book) 本书检索命中", bookSearch.total >= 1, bookSearch.total + "/" + String(bookSearch.note || "").slice(0, 60));
  check("searchLibrary(doc=book) 结果锚点是书", (bookSearch.results || []).every((r) => String(r.doc).startsWith("book:")), (bookSearch.results || []).map((r) => r.doc).join(","));
  const paperDocSearch = await paperTools.searchLibrary.execute({ reasoning: "L1", doc: "paper:" + PAPER_C, query: "interface stability" }, { toolCallId: "p12", messages: [] });
  check("searchLibrary(doc=paper) 只查该论文", (paperDocSearch.results || []).every((r) => r.doc === "paper:" + PAPER_C), (paperDocSearch.results || []).map((r) => r.doc).join(","));
  check("searchLibrary(scope=current) 只查当前论文", (narrowed.results || []).every((r) => r.doc === "paper:" + PAPER_A), (narrowed.results || []).map((r) => r.doc).join(","));
  const centralTools = registry.getToolsForScope("central");
  const mergedBooks = await centralTools.searchLibrary.execute({ reasoning: "L1", query: "政治 权力 知识分子", scope: "all", topK: 8 }, { toolCallId: "p13", messages: [] });
  check("searchLibrary(central,all) 跨库含书库结果", (mergedBooks.book_total ?? 0) >= 1, (mergedBooks.book_total ?? 0) + " book / " + (mergedBooks.paper_total ?? 0) + " paper");
  const mergedPapers = await centralTools.searchLibrary.execute({ reasoning: "L1", query: "layered oxide cathode interface stability", scope: "all", topK: 8 }, { toolCallId: "p14", messages: [] });
  check("searchLibrary(central,all) 跨库含论文结果", (mergedPapers.paper_total ?? 0) >= 1, (mergedPapers.paper_total ?? 0) + " paper / " + (mergedPapers.book_total ?? 0) + " book");
  check("searchLibrary(central,all) 结果带 kind 来源标记", (mergedPapers.results || []).every((r) => r.kind === "book" || r.kind === "paper"), (mergedPapers.results || []).map((r) => r.kind).join(","));
  return out;
})()`);

let failed = 0;
for (const c of checks) { if (!c.pass) failed++; console.log((c.pass ? "ok   " : "FAIL ") + c.name + (c.info ? " | " + c.info : "")); }
console.log(failed === 0 ? "PASS (" + checks.length + " checks)" : "FAILED " + failed + "/" + checks.length);
ws.close();
process.exit(failed === 0 ? 0 : 1);
