// L1: P1 文档原语 readDocument / getDocumentInfo / searchLibrary
const cdpPort = process.env.CDP_PORT ?? "9223";
const appPort = process.env.APP_PORT ?? "1420";
const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes(`localhost:${appPort}`));
if (!page) { console.log(`FAIL no Preview page (${cdpPort}/${appPort})`); process.exit(1); }
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
  const scopeConstants = await import("/src/constants/retrieval-scope.ts");
  const docShared = await import("/src/ai/tools/document/shared.ts");
  check("Task8 默认范围 reader=current/paper=library/central=all", scopeConstants.defaultRetrievalScope?.("reader") === "current" && scopeConstants.defaultRetrievalScope?.("paper") === "library" && scopeConstants.defaultRetrievalScope?.("central") === "all", typeof scopeConstants.defaultRetrievalScope);
  check("Task8 paper 缺省解析为 library 且显式 current 保留", docShared.resolveRetrievalScope({ scope: "paper", currentId: PAPER_A }) === "library" && docShared.resolveRetrievalScope({ scope: "paper", currentId: PAPER_A, retrievalScope: "current" }) === "current", docShared.resolveRetrievalScope({ scope: "paper", currentId: PAPER_A }));
  // L1 需要跨论文/跨书读取，显式给用户圈定范围「图书馆+论文库」覆盖按角色默认范围。
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
  const paperShared = await import("/src/ai/tools/paper/shared.ts");
  const rationalMetadata = JSON.parse(await paperShared.readPaperMetadataJson(PAPER_A));
  const expectedAuthors = rationalMetadata.author.map((author) => author.name);
  check("getDocumentInfo(paper) 作者与原始 JSON 全量等价", JSON.stringify(info.metadata.authors) === JSON.stringify(expectedAuthors), Array.isArray(info.metadata.authors) ? info.metadata.authors.length + "/" + expectedAuthors.length : info.metadata.authors);
  check("getDocumentInfo(paper) date=2020", info.metadata.date === "2020", info.metadata.date);
  check("getDocumentInfo(paper) abstract 非空", typeof info.metadata.abstract === "string" && info.metadata.abstract.length > 100, String(info.metadata.abstract || "").slice(0, 80));
  const paperSections = await import("/src/pages/paper-reader/markdown-sections.ts");
  const rationalParsed = paperSections.parsePaperSections(await paperShared.readPaperMarkdown(PAPER_A));
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
  const earlyWin = await paperTools.readDocument.execute({ reasoning: "L1", doc: "paper:" + PAPER_A, offset: 2, before: 10, after: 500 }, { toolCallId: "p3-early", messages: [] });
  check("readDocument before>offset 不多读", earlyWin.text === rationalParsed.body.slice(0, 502) && earlyWin.next_offset === 502, String(earlyWin.text || "").length + "/" + earlyWin.next_offset);
  const references = paperSections.findSectionHeading(rationalParsed, "REFERENCES AND NOTES");
  const referencesIndex = rationalParsed.headings.indexOf(references);
  const referencesNext = rationalParsed.headings.slice(referencesIndex + 1).find((item) => item.level <= references.level);
  const referencesEnd = referencesNext ? referencesNext.start : rationalParsed.body.length;
  const referencesFirstEnd = Math.min(referencesEnd, references.contentStart + 500);
  const referencesReplayEnd = Math.min(referencesEnd, referencesFirstEnd + 500);
  const referencesFirst = await paperTools.readDocument.execute({ reasoning: "L1", doc: "paper:" + PAPER_A, heading: "REFERENCES AND NOTES", after: 500 }, { toolCallId: "p3-ref-1", messages: [] });
  check("readDocument heading next_offset 绝对坐标", referencesFirst.next_offset === referencesFirstEnd, referencesFirst.next_offset + "/" + referencesFirstEnd);
  const referencesReplay = await paperTools.readDocument.execute({ reasoning: "L1", doc: "paper:" + PAPER_A, heading: "REFERENCES AND NOTES", offset: referencesFirst.next_offset, after: 500 }, { toolCallId: "p3-ref-2", messages: [] });
  check("readDocument Rational 旧 next_offset 重放非空且精确", referencesReplay.text === rationalParsed.body.slice(referencesFirstEnd, referencesReplayEnd), String(referencesReplay.text || "").length + "/" + referencesReplayEnd);

  const readerTools = registry.getToolsForScope("reader", { bookId: BOOK, retrievalScope: "all" });
  const bookRead = await readerTools.readDocument.execute({ reasoning: "L1", doc: "book:" + BOOK, heading: "第三章 政治学", after: 3000 }, { toolCallId: "p4", messages: [] });
  check("readDocument(book) 命中章节", String(bookRead.anchor.heading || "").includes("第三章"), bookRead.anchor.heading);
  check("readDocument(book) 正文匹配", /萨特|政治/.test(String(bookRead.text || "")), String(bookRead.text || "").slice(0, 80));
  check("书籍不注册独立 getFigures/getCitations", !readerTools.getFigures && !readerTools.getCitations, Object.keys(readerTools).filter((k) => k === "getFigures" || k === "getCitations").join(","));

  const bookAdapter = await import("/src/services/book-content/book-reading-adapter.ts").catch((error) => ({ __loadError: String(error) }));
  check("book adapter 两个 canonical 入口可加载", !!bookAdapter.readBookDocumentCanonical && !!bookAdapter.readBookSectionCanonical, bookAdapter.__loadError || "");
  const legacyBookMod = await import("/src/ai/tools/read-book-section.ts");
  const legacyBookTool = legacyBookMod.createReadBookSectionTool(BOOK);
  const newBookChapter = await readerTools.readDocument.execute({ reasoning: "Task6", doc: "book:" + BOOK, heading: "第三章 政治学", after: 8000 }, { toolCallId: "t6-new-chapter", messages: [] });
  const legacyBookChapter = await legacyBookTool.execute({ reasoning: "Task6", chapterTitle: "第三章 政治学", maxChars: 8000 }, { toolCallId: "t6-legacy-chapter", messages: [] });
  check("真实福柯 New/Legacy 同章 canonical 完全一致", legacyBookChapter.results?.success === true && legacyBookChapter.results.content === newBookChapter.text, String(newBookChapter.text || "").length + "/" + String(legacyBookChapter.results?.content || "").length);
  const foucaultImageCount = String(newBookChapter.text || "").split("![picture](").length - 1;
  check("真实福柯章节保留图片 src/alt", foucaultImageCount >= 2 && !String(newBookChapter.text || "").includes("![图]"), foucaultImageCount);
  const foucaultText = String(newBookChapter.text || "");
  const foucaultImageStart = foucaultText.indexOf("![picture](");
  const foucaultPathStart = foucaultImageStart < 0 ? -1 : foucaultImageStart + "![picture](".length;
  const foucaultPathEnd = foucaultPathStart < 0 ? -1 : foucaultText.indexOf(")", foucaultPathStart);
  const foucaultImagePath = foucaultPathEnd < 0 ? "" : foucaultText.slice(foucaultPathStart, foucaultPathEnd);
  let foucaultImageReadable = false;
  let foucaultImageInfo = foucaultImagePath;
  if (foucaultImagePath) {
    try {
      const imageResult = await readerTools.readImage.execute({ path: foucaultImagePath }, { toolCallId: "t6-foucault-image", messages: [] });
      foucaultImageReadable = imageResult.type === "content";
      foucaultImageInfo = foucaultImagePath + "/" + imageResult.type;
    } catch (error) { foucaultImageInfo = String(error); }
  }
  check("福柯窗口图片路径可直接 readImage", foucaultImageReadable, foucaultImageInfo);

  const pathApi = await import("/@id/@tauri-apps/api/path");
  const fsApi = await import("/@id/@tauri-apps/plugin-fs");
  let task6AppData = (await pathApi.appDataDir()).split(String.fromCharCode(92)).join("/");
  while (task6AppData.endsWith("/")) task6AppData = task6AppData.slice(0, -1);
  const task6Hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOOK + String.fromCharCode(0) + "images/00004.jpeg"))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const task6CacheDir = task6AppData + "/image-cache/epub/" + BOOK;
  const task6CachePath = task6CacheDir + "/" + task6Hash + ".jpeg";
  const hadTask6Cache = await fsApi.exists(task6CachePath);
  const hadTask6CacheDir = await fsApi.exists(task6CacheDir);
  let task6MaterializedPath = "";
  let task6CacheReadable = false;
  let task6CacheInfo = task6CachePath;
  try {
    const cacheSource = await bookAdapter.readBookSectionCanonical(BOOK, "第三章 政治学");
    const task6MaterializedText = await bookAdapter.resolveBookWindowImages(BOOK, "![picture](../images/00004.jpeg)", {
      ...cacheSource,
      segments: [{ ...cacheSource.segments[0], mdRelPath: "__task6_missing__/deep/chapter.md" }],
      windowStart: 0,
    });
    task6MaterializedPath = task6MaterializedText.startsWith("![picture](") && task6MaterializedText.endsWith(")")
      ? task6MaterializedText.slice("![picture](".length, -1)
      : task6MaterializedText;
    const cachedImage = await readerTools.readImage.execute({ path: task6MaterializedPath }, { toolCallId: "t6-epub-cache-image", messages: [] });
    task6CacheReadable = cachedImage.type === "content";
    task6CacheInfo = task6MaterializedPath + "/" + cachedImage.type;
  } catch (error) {
    task6CacheInfo = String(error);
  } finally {
    if (!hadTask6Cache) await fsApi.remove(task6CachePath).catch(() => {});
    if (!hadTask6CacheDir) await fsApi.remove(task6CacheDir).catch(() => {});
  }
  check("缺盘 EPUB 图片按确定性 hash 物化", task6MaterializedPath === task6CachePath, task6MaterializedPath + "/" + task6CachePath);
  check("缺盘缓存图片可直接 readImage", task6CacheReadable, task6CacheInfo);
  const task6CacheRestored = (await fsApi.exists(task6CachePath)) === hadTask6Cache && (hadTask6CacheDir || !(await fsApi.exists(task6CacheDir)));
  check("EPUB 缓存验证后仅清理自建产物", task6CacheRestored, "cache=" + hadTask6Cache + ", dir=" + hadTask6CacheDir);

  if (bookAdapter.readBookDocumentCanonical) {
    const fullBook = await bookAdapter.readBookDocumentCanonical(BOOK);
    let plainStart = 0;
    while (plainStart + 1000 < fullBook.text.length && fullBook.text.slice(plainStart, plainStart + 1000).includes("![")) plainStart += 1;
    const absoluteFirst = await readerTools.readDocument.execute({ reasoning: "Task6", doc: "book:" + BOOK, offset: plainStart, after: 500 }, { toolCallId: "t6-abs-1", messages: [] });
    const absoluteSecond = await readerTools.readDocument.execute({ reasoning: "Task6", doc: "book:" + BOOK, offset: absoluteFirst.next_offset, after: 500 }, { toolCallId: "t6-abs-2", messages: [] });
    check("全书绝对 offset 相邻窗口精确衔接", absoluteFirst.text === fullBook.text.slice(plainStart, plainStart + 500) && absoluteSecond.text === fullBook.text.slice(plainStart + 500, plainStart + 1000), plainStart + "/" + absoluteFirst.next_offset + "/" + absoluteSecond.next_offset);
    const imageOffset = fullBook.text.indexOf("![picture]");
    const imageWindowStart = Math.max(0, imageOffset - 20);
    const imageWindow = await readerTools.readDocument.execute({ reasoning: "Task6", doc: "book:" + BOOK, offset: imageWindowStart, after: 500 }, { toolCallId: "t6-abs-image", messages: [] });
    check("绝对图片路径长度不改变 next_offset", imageOffset >= 0 && imageWindow.next_offset === imageWindowStart + 500, imageWindow.next_offset + "/" + (imageWindowStart + 500));
  } else {
    check("全书绝对 offset 相邻窗口精确衔接", false, bookAdapter.__loadError || "adapter unavailable");
    check("绝对图片路径长度不改变 next_offset", false, bookAdapter.__loadError || "adapter unavailable");
  }

  const QFT = "ebf57c55768fa113b1c02f759c1c5487";
  if (bookAdapter.readBookSectionCanonical) {
    const bookOpen = await import("/src/services/book-translation/book-translation-service.ts");
    const qftOpened = await bookOpen.openBookDocument(QFT);
    let qftIndex = qftOpened.bookDoc.sections.findIndex((section) => /chapter_014/.test(section.id || ""));
    let qftDoc = qftIndex >= 0 ? await qftOpened.bookDoc.sections[qftIndex].createDocument() : null;
    if (!qftDoc?.querySelector("td math")) {
      qftIndex = -1;
      for (let i = 0; i < qftOpened.bookDoc.sections.length; i++) {
        const candidate = await qftOpened.bookDoc.sections[i].createDocument();
        if (candidate?.querySelector("td math")) { qftIndex = i; qftDoc = candidate; break; }
      }
    }
    check("复用现有 QFT CDP 书目定位表格公式", qftIndex >= 0 && !!qftDoc?.querySelector("td math"), qftIndex);
    const qftCanonical = qftIndex >= 0 ? await bookAdapter.readBookSectionCanonical(QFT, { spine: qftIndex }) : { text: "" };
    const qftTableLines = String(qftCanonical.text || "").split(String.fromCharCode(10)).filter((line) => line.startsWith("|"));
    check("QFT 表格单元格公式以 inline TeX 保留", qftTableLines.some((line) => line.includes("$") && /frac|left|right|sum|mathcal/.test(line)), qftTableLines.filter((line) => line.includes("$")).slice(0, 2).join(" / ").slice(0, 240));
  } else {
    check("复用现有 QFT CDP 书目定位表格公式", false, bookAdapter.__loadError || "adapter unavailable");
    check("QFT 表格单元格公式以 inline TeX 保留", false, bookAdapter.__loadError || "adapter unavailable");
  }

  const infoBook = await readerTools.getDocumentInfo.execute({ reasoning: "L1", doc: "book:" + BOOK }, { toolCallId: "p5", messages: [] });
  check("getDocumentInfo(book) indexed", infoBook.index.status === "indexed", infoBook.index.status);
  check("getDocumentInfo(book) toc>=10", infoBook.outline.total >= 10, infoBook.outline.total);

  const civilTools = registry.getToolsForScope("reader", { bookId: "718a0d5d6514980ce87dd8b0d39ad2dc" });
  const infoCivil = await civilTools.getDocumentInfo.execute({ reasoning: "L1", doc: "book:718a0d5d6514980ce87dd8b0d39ad2dc" }, { toolCallId: "p5b", messages: [] });
  check("getDocumentInfo(未索引书) 目录 5-40 条（EPUB TOC 回退）", infoCivil.outline.total >= 5 && infoCivil.outline.items.length <= 40, infoCivil.outline.total + "/" + infoCivil.outline.source + "/items=" + infoCivil.outline.items.length);

  // 2026-10-23 用户拍板：new 模式恢复文件五件套（readLocalFile/writeFile/editFile/searchFiles/runCommand）
  const FILE_TOOLS = ["readLocalFile", "writeFile", "editFile", "searchFiles", "runCommand"];
  const hadDocToolMode = Object.prototype.hasOwnProperty.call(window, "__SAGEREAD_DOC_TOOL_MODE__");
  const previousDocToolMode = window.__SAGEREAD_DOC_TOOL_MODE__;
  window.__SAGEREAD_DOC_TOOL_MODE__ = "new";
  const newModeTools = registry.getToolsForScope("paper", { paperId: PAPER_A, paperScopeIds: [PAPER_C], retrievalScope: "all" });
  check("new 模式隐藏旧读工具", !newModeTools.readPaperSection && !newModeTools.getPaperToc && !newModeTools.paperSearch && !!newModeTools.readDocument, Object.keys(newModeTools).length);
  check(
    "new 模式恢复文件五件套（write/edit/search/run 不再隐藏）",
    FILE_TOOLS.every((name) => !!newModeTools[name]),
    FILE_TOOLS.filter((name) => !newModeTools[name]).join(",") || Object.keys(newModeTools).join(","),
  );
  check(
    "new 模式 paper 工具数 = 25（shared 17 + paper 专属 8，含交付工具 present）",
    Object.keys(newModeTools).length === 25,
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
    "reader new 模式工具数 = 22（shared 17 + reader 专属 5，含交付工具 present）",
    Object.keys(readerNewModeTools).length === 22,
    Object.keys(readerNewModeTools).length,
  );
  const readerChars = lazy.estimateToolsChars(readerNewModeTools);
  check(
    "reader new 模式 schema 超 12k → 目录牌预算触发",
    lazy.shouldUseDirectoryMode(readerNewModeTools) === true,
    readerChars + " chars",
  );
  const newCentralModeTools = registry.getToolsForScope("central");
  check("Task8 new central 注册 getFigures/getCitations", !!newCentralModeTools.getFigures && !!newCentralModeTools.getCitations, Object.keys(newCentralModeTools).filter((name) => name === "getFigures" || name === "getCitations").join(","));
  window.__SAGEREAD_DOC_TOOL_MODE__ = "legacy";
  const legacyModeTools = registry.getToolsForScope("paper", { paperId: PAPER_A, paperScopeIds: [PAPER_C], retrievalScope: "all" });
  check("legacy 模式隐藏新原语", !legacyModeTools.readDocument && !!legacyModeTools.readPaperSection, Object.keys(legacyModeTools).length);
  check("legacy 模式文件五件套仍在", FILE_TOOLS.every((name) => !!legacyModeTools[name]), "");
  const legacyCentralModeTools = registry.getToolsForScope("central");
  check("Task8 legacy central 注册 getFigures/getCitations", !!legacyCentralModeTools.getFigures && !!legacyCentralModeTools.getCitations, Object.keys(legacyCentralModeTools).filter((name) => name === "getFigures" || name === "getCitations").join(","));
  for (const invalidMode of ["both", "invalid"]) {
    window.__SAGEREAD_DOC_TOOL_MODE__ = invalidMode;
    const invalidModeTools = registry.getToolsForScope("paper", { paperId: PAPER_A, retrievalScope: "all" });
    check("Task8 " + invalidMode + " override 归一 new 且不产生并集", !!invalidModeTools.readDocument && !invalidModeTools.readPaperSection, Object.keys(invalidModeTools).join(","));
  }
  if (hadDocToolMode) window.__SAGEREAD_DOC_TOOL_MODE__ = previousDocToolMode;
  else delete window.__SAGEREAD_DOC_TOOL_MODE__;
  check("文档模式覆盖已恢复", window.__SAGEREAD_DOC_TOOL_MODE__ === previousDocToolMode && Object.prototype.hasOwnProperty.call(window, "__SAGEREAD_DOC_TOOL_MODE__") === hadDocToolMode, String(window.__SAGEREAD_DOC_TOOL_MODE__));

  const search = await paperTools.searchLibrary.execute({ reasoning: "L1", query: "environmentally stable interface layered oxide cathode", scope: "all" }, { toolCallId: "p6", messages: [] });
  check("searchLibrary(all) 命中", search.total >= 1, search.total);
  check("searchLibrary 片段<=405", (search.results || []).every((r) => String(r.snippet).length <= 405), (search.results || []).map((r) => String(r.snippet).length).join(","));
  check("searchLibrary(all) doc 锚点（paper:<id> / book:<id>）", (search.results || []).every((r) => /^(paper|book):/.test(String(r.doc))), (search.results || []).map((r) => r.doc).join(","));
  check("searchLibrary 无 citation_guide", !("citation_guide" in search), Object.keys(search).join(","));
  check("Task7 每个检索命中都有 source/index/read/anchor_precision", (search.results || []).every((r) => typeof r.source === "string" && typeof r.index?.status === "string" && typeof r.read?.doc === "string" && typeof r.anchor_precision === "string"), JSON.stringify((search.results || [])[0] || {}));

  const paperFallback = await paperTools.searchLibrary.execute({ reasoning: "Task7", doc: "paper:" + PAPER_B, query: "dehydration", topK: 6 }, { toolCallId: "t7-paper-fallback", messages: [] });
  const paperFallbackHit = (paperFallback.results || []).find((r) => r.doc === "paper:" + PAPER_B && r.source === "keyword");
  check("Task7 未索引 Paper B dehydration 关键词命中", paperFallbackHit?.index?.status === "not_indexed" && paperFallbackHit?.anchor_precision === "exact" && typeof paperFallbackHit?.read?.offset === "number", JSON.stringify(paperFallbackHit || paperFallback));
  const paperFallbackRead = paperFallbackHit?.read ? await paperTools.readDocument.execute({ reasoning: "Task7", ...paperFallbackHit.read, before: 80, after: 800 }, { toolCallId: "t7-paper-read", messages: [] }) : null;
  check("Task7 Paper B hit.read 扩窗包含命中且 range/read 可续用", /dehydration/i.test(String(paperFallbackRead?.text || "")) && paperFallbackRead?.range?.unit === "char" && paperFallbackRead?.read?.offset === paperFallbackHit?.read?.offset, JSON.stringify({ range: paperFallbackRead?.range, read: paperFallbackRead?.read }));

  const civilFallback = await civilTools.searchLibrary.execute({ reasoning: "Task7", doc: "book:718a0d5d6514980ce87dd8b0d39ad2dc", query: "意思表示", topK: 6 }, { toolCallId: "t7-book-fallback", messages: [] });
  const civilFallbackHit = (civilFallback.results || []).find((r) => r.doc === "book:718a0d5d6514980ce87dd8b0d39ad2dc" && r.source === "keyword");
  check("Task7 未索引 Book B 意思表示 Rust+canonical 命中", civilFallbackHit?.index?.status === "not_indexed" && typeof civilFallbackHit?.read?.spine === "number" && civilFallbackHit?.anchor_precision === "exact", JSON.stringify(civilFallbackHit || civilFallback));
  const civilFallbackRead = civilFallbackHit?.read ? await civilTools.readDocument.execute({ reasoning: "Task7", ...civilFallbackHit.read, before: 80, after: 800 }, { toolCallId: "t7-book-read", messages: [] }) : null;
  check("Task7 Book B spine 锚点扩窗包含命中", String(civilFallbackRead?.text || "").includes("意思表示") && civilFallbackRead?.read?.spine === civilFallbackHit?.read?.spine && civilFallbackRead?.range?.unit === "char", JSON.stringify({ range: civilFallbackRead?.range, read: civilFallbackRead?.read, text: String(civilFallbackRead?.text || "").slice(0, 100) }));

  const referenceBody = rationalParsed.body.slice(references.contentStart, referencesEnd);
  const beforeReferences = rationalParsed.body.slice(0, references.contentStart).toLowerCase();
  const referenceToken = [...new Set(referenceBody.match(/[A-Za-z][A-Za-z-]{7,}/g) || [])].find((token) => !beforeReferences.includes(token.toLowerCase()) && !/references/i.test(token));
  check("Task7 参考文献专有词夹具可用", !!referenceToken, referenceToken || "none");
  if (referenceToken) {
    const refsExcluded = await paperTools.searchLibrary.execute({ reasoning: "Task7", doc: "paper:" + PAPER_A, query: referenceToken, includeReferences: false }, { toolCallId: "t7-refs-excluded", messages: [] });
    const refsIncluded = await paperTools.searchLibrary.execute({ reasoning: "Task7", doc: "paper:" + PAPER_A, query: referenceToken, includeReferences: true }, { toolCallId: "t7-refs-included", messages: [] });
    const inReferenceRange = (r) => typeof r.read?.offset === "number" && r.read.offset >= references.contentStart && r.read.offset < referencesEnd;
    check("Task7 includeReferences=false/true 真实差异", !(refsExcluded.results || []).some(inReferenceRange) && (refsIncluded.results || []).some((r) => r.source === "keyword" && inReferenceRange(r)), referenceToken + " excluded=" + refsExcluded.total + " included=" + refsIncluded.total);
  }

  const figs2 = await paperTools.getFigures.execute({ reasoning: "L1" }, { toolCallId: "p10", messages: [] });
  const paperCitations = await paperTools.getCitations.execute({ reasoning: "Task8" }, { toolCallId: "t8-paper-citations", messages: [] });
  check("Task8 paper extras 省略 doc 保持绑定当前论文", figs2.total > 0 && paperCitations.found === true, figs2.total + "/" + paperCitations.found);
  const currentPaperTools = registry.getToolsForScope("paper", { paperId: PAPER_A, retrievalScope: "current" });
  let extraScopeError = "";
  try { await currentPaperTools.getFigures.execute({ reasoning: "Task8", doc: "paper:" + PAPER_B }, { toolCallId: "t8-extra-scope", messages: [] }); }
  catch (error) { extraScopeError = String(error && error.message ? error.message : error); }
  check("Task8 paper extras 显式 doc 应用范围门禁", extraScopeError.includes("超出用户划定的检索范围"), extraScopeError || "no error");
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
  for (const extraName of ["getCitations", "getFigures"]) {
    const extraTool = centralTools[extraName];
    check("Task8 central " + extraName + " 已注册", !!extraTool, "missing");
    if (!extraTool) continue;
    let missingDocError = "";
    let bookDocError = "";
    let centralExtraResult = null;
    try { await extraTool.execute({ reasoning: "Task8 missing doc" }, { toolCallId: "t8-central-missing-" + extraName, messages: [] }); }
    catch (error) { missingDocError = String(error && error.message ? error.message : error); }
    try { await extraTool.execute({ reasoning: "Task8 book doc", doc: "book:" + BOOK }, { toolCallId: "t8-central-book-" + extraName, messages: [] }); }
    catch (error) { bookDocError = String(error && error.message ? error.message : error); }
    try { centralExtraResult = await extraTool.execute({ reasoning: "Task8 paper doc", doc: "paper:" + PAPER_A }, { toolCallId: "t8-central-paper-" + extraName, messages: [] }); }
    catch (error) { centralExtraResult = { error: String(error && error.message ? error.message : error) }; }
    check("Task8 central " + extraName + " 缺 doc 可执行报错", /doc\s*=\s*paper:/.test(missingDocError), missingDocError || "no error");
    check("Task8 central " + extraName + " book doc 可执行报错", /仅支持论文|必须是 paper|paper:</.test(bookDocError), bookDocError || "no error");
    check("Task8 central " + extraName + " 显式 paper doc 成功", !!centralExtraResult && !centralExtraResult.error && (extraName === "getCitations" ? centralExtraResult.found === true : centralExtraResult.total > 0), JSON.stringify(centralExtraResult).slice(0, 220));
  }
  const mergedBooks = await centralTools.searchLibrary.execute({ reasoning: "L1", query: "政治 权力 知识分子", scope: "all", topK: 8 }, { toolCallId: "p13", messages: [] });
  check("searchLibrary(central,all) 跨库含书库结果", (mergedBooks.book_total ?? 0) >= 1, (mergedBooks.book_total ?? 0) + " book / " + (mergedBooks.paper_total ?? 0) + " paper");
  const mergedPapers = await centralTools.searchLibrary.execute({ reasoning: "L1", query: "layered oxide cathode interface stability", scope: "all", topK: 8 }, { toolCallId: "p14", messages: [] });
  check("searchLibrary(central,all) 跨库含论文结果", (mergedPapers.paper_total ?? 0) >= 1, (mergedPapers.paper_total ?? 0) + " paper / " + (mergedPapers.book_total ?? 0) + " book");
  check("searchLibrary(central,all) 结果带 kind 来源标记", (mergedPapers.results || []).every((r) => r.kind === "book" || r.kind === "paper"), (mergedPapers.results || []).map((r) => r.kind).join(","));
  return out;
})()`);

let failed = 0;
for (const c of checks) { if (!c.pass) failed++; console.log((c.pass ? "ok   " : "FAIL ") + c.name + (c.info ? ` | ${c.info}` : "")); }
console.log(failed === 0 ? `PASS (${checks.length} checks)` : `FAILED ${failed}/${checks.length}`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
