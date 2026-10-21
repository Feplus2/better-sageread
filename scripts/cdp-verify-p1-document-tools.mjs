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
  const paperTools = registry.getToolsForScope("paper", { paperId: PAPER_A, paperScopeIds: [PAPER_C] });
  check("paper scope 含 readDocument/getDocumentInfo/searchLibrary", !!paperTools.readDocument && !!paperTools.getDocumentInfo && !!paperTools.searchLibrary, Object.keys(paperTools).join(","));

  const info = await paperTools.getDocumentInfo.execute({ reasoning: "L1", doc: "paper:" + PAPER_A }, { toolCallId: "p1", messages: [] });
  check("getDocumentInfo(paper) 标题", String(info.doc.title || "").includes("Rational design"), info.doc.title);
  check("getDocumentInfo(paper) outline>=4", info.outline.total >= 4, info.outline.total);
  check("getDocumentInfo(paper) figures=4", info.counts.figures === 4, info.counts.figures);
  check("getDocumentInfo(paper) citations>0", info.counts.citations > 0, info.counts.citations);

  const cross = await paperTools.readDocument.execute({ reasoning: "L1", doc: "paper:" + PAPER_B, heading: "Results and discussion", after: 3000 }, { toolCallId: "p2", messages: [] });
  check("readDocument 跨论文标题", String(cross.doc.title || "").includes("Dehydration"), cross.doc.title);
  check("readDocument 跨论文正文>500", String(cross.text || "").length > 500, String(cross.text || "").length);
  check("readDocument 跨论文内容匹配", /PB|Prussian|dehydrat/i.test(String(cross.text || "")), "");

  const win = await paperTools.readDocument.execute({ reasoning: "L1", doc: "paper:" + PAPER_A, offset: 1000, after: 600 }, { toolCallId: "p3", messages: [] });
  check("readDocument offset 窗口<=600", String(win.text || "").length <= 600, String(win.text || "").length);
  check("readDocument offset next_offset", typeof win.next_offset === "number", win.next_offset);

  const readerTools = registry.getToolsForScope("reader", { bookId: BOOK });
  const bookRead = await readerTools.readDocument.execute({ reasoning: "L1", doc: "book:" + BOOK, heading: "第三章 政治学", after: 3000 }, { toolCallId: "p4", messages: [] });
  check("readDocument(book) 命中章节", String(bookRead.anchor.heading || "").includes("第三章"), bookRead.anchor.heading);
  check("readDocument(book) 正文匹配", /萨特|政治/.test(String(bookRead.text || "")), String(bookRead.text || "").slice(0, 80));

  const infoBook = await readerTools.getDocumentInfo.execute({ reasoning: "L1", doc: "book:" + BOOK }, { toolCallId: "p5", messages: [] });
  check("getDocumentInfo(book) indexed", infoBook.index.status === "indexed", infoBook.index.status);
  check("getDocumentInfo(book) toc>=10", infoBook.outline.total >= 10, infoBook.outline.total);

  const civilTools = registry.getToolsForScope("reader", { bookId: "718a0d5d6514980ce87dd8b0d39ad2dc" });
  const infoCivil = await civilTools.getDocumentInfo.execute({ reasoning: "L1", doc: "book:718a0d5d6514980ce87dd8b0d39ad2dc" }, { toolCallId: "p5b", messages: [] });
  check("getDocumentInfo(未索引书) 有目录（EPUB TOC 回退）", infoCivil.outline.total >= 5, infoCivil.outline.total + "/" + infoCivil.outline.source);

  window.__SAGEREAD_DOC_TOOL_MODE__ = "new";
  const newModeTools = registry.getToolsForScope("paper", { paperId: PAPER_A, paperScopeIds: [PAPER_C] });
  check("new 模式隐藏旧读工具", !newModeTools.readPaperSection && !newModeTools.getPaperToc && !newModeTools.paperSearch && !!newModeTools.readDocument, Object.keys(newModeTools).length);
  check("new 模式工具数 <= 18", Object.keys(newModeTools).length <= 18, Object.keys(newModeTools).length);
  const newChars = lazy.estimateToolsChars(newModeTools);
  check("new 模式退出目录牌（schema<12k）", lazy.shouldUseDirectoryMode(newModeTools) === false, newChars + " chars");
  check("new 模式隐藏工作区命令工具", !newModeTools.runCommand && !newModeTools.writeFile && !newModeTools.readLocalFile, Object.keys(newModeTools).length);
  window.__SAGEREAD_DOC_TOOL_MODE__ = "legacy";
  const legacyModeTools = registry.getToolsForScope("paper", { paperId: PAPER_A, paperScopeIds: [PAPER_C] });
  check("legacy 模式隐藏新原语", !legacyModeTools.readDocument && !!legacyModeTools.readPaperSection, Object.keys(legacyModeTools).length);
  delete window.__SAGEREAD_DOC_TOOL_MODE__;

  const search = await paperTools.searchLibrary.execute({ reasoning: "L1", query: "environmentally stable interface layered oxide cathode", scope: "all" }, { toolCallId: "p6", messages: [] });
  check("searchLibrary(all) 命中", search.total >= 1, search.total);
  check("searchLibrary 片段<=405", (search.results || []).every((r) => String(r.snippet).length <= 405), (search.results || []).map((r) => String(r.snippet).length).join(","));
  check("searchLibrary doc 锚点", (search.results || []).every((r) => String(r.doc).startsWith("paper:")), "");
  check("searchLibrary 无 citation_guide", !("citation_guide" in search), Object.keys(search).join(","));

  const budgetMod = await import("/src/ai/tools/document/read-budget.ts");
  budgetMod.resetReadBudget();
  let budgetHit = false;
  for (let i = 0; i < 4; i++) {
    const r = await paperTools.readDocument.execute({ reasoning: "L1", doc: "paper:" + PAPER_A, offset: i * 2000, after: 12000 }, { toolCallId: "p8-" + i, messages: [] });
    if (String(r.note || "").includes("预算")) budgetHit = true;
  }
  check("单轮读取预算生效", budgetHit, "");
  budgetMod.resetReadBudget();

  const scoped = await paperTools.searchLibrary.execute({ reasoning: "L1", query: "interface stability", scope: "collection" }, { toolCallId: "p7", messages: [] });
  check("searchLibrary(collection) 只查面板范围", (scoped.results || []).every((r) => r.doc === "paper:" + PAPER_C), (scoped.results || []).map((r) => r.doc).join(","));
  return out;
})()`);

let failed = 0;
for (const c of checks) { if (!c.pass) failed++; console.log((c.pass ? "ok   " : "FAIL ") + c.name + (c.info ? " | " + c.info : "")); }
console.log(failed === 0 ? "PASS (" + checks.length + " checks)" : "FAILED " + failed + "/" + checks.length);
ws.close();
process.exit(failed === 0 ? 0 : 1);
