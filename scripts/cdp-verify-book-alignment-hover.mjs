import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { validateBookTranslationSection } from "./book-translation-acceptance.mjs";

const invalid = { alignStatus: "done", blocks: { 0: { text: "已有中文译文", alignHash: "fixture" } } };
await assert.rejects(
  validateBookTranslationSection(invalid, async () => "fixture"),
  /缺少句对齐/,
  "只有译文、没有句对齐时必须拒绝验收",
);
console.log("PASS 未对齐的译文不能冒充双向联动");

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const bookId = process.env.BOOK_ID ?? "c6207a35b9b8e0b5396d0b2ffc4f42b9";
const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/2026-11-06-user-acceptance-followup/translation";
mkdirSync(outDir, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error("找不到隔离 Preview");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails)
    throw new Error(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
  return result.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, label, attempts = 120) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
};
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
};
const shot = async (direction) => {
  const image = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/alignment-hover-${direction}.png`, Buffer.from(image.result.data, "base64"));
};
let previous;
let previousReadingLocation;
let report = {};
try {
  const appDataDir = await evaluate(`(async () => (await import("/src/utils/path.ts")).getFullPathFromAppData("."))()`);
  assert.match(
    String(appDataDir)
      .replace(/\\/g, "/")
      .replace(/[\\/]\.$/, "")
      .replace(/[\\/]+$/, ""),
    /com\.bettersageread\.preview$/,
  );
  report = await evaluate(`(async () => {
    const svc = await import("/src/services/book-translation/book-translation-service.ts?verify=" + Date.now());
    const { hashBlockText } = await import("/src/services/paper-translation-service.ts");
    const indexes = await svc.listBookTranslationSectionIndexes(${JSON.stringify(bookId)});
    if (indexes.length === 0) throw new Error("没有既有章译本，不发起付费翻译");
    const file = await svc.loadBookTranslationSection(${JSON.stringify(bookId)}, indexes[0]);
    const validate = ${validateBookTranslationSection.toString().replace(/^export\s+/, "")};
    const summary = await validate(file, hashBlockText);
    return { sectionIndex: indexes[0], ...summary };
  })()`);
  check(
    "真实中文译文与 72/72 句对齐有效",
    report.translatedBlocks === 72 && report.alignedBlocks === 72,
    JSON.stringify(report),
  );
  previous = await evaluate(`(async () => {
    const settings = (await import("/src/store/app-settings-store.ts")).useAppSettingsStore.getState().settings;
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    return {
      settings,
      layout: { tabs: layout.tabs, activeTabId: layout.activeTabId, isHomeActive: layout.isHomeActive, isChatVisible: layout.isChatVisible, isNotepadVisible: layout.isNotepadVisible, tabOrientation: layout.tabOrientation, isVerticalTabCollapsed: layout.isVerticalTabCollapsed },
    };
  })()`);
  previousReadingLocation = await evaluate(`(async () => {
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    const store = layout.readerStores.get("reader-${bookId}");
    const location = store?.getState().location;
    if (typeof location === "string") return location;
    const view = store?.getState().view;
    const index = view?.renderer?.getContents?.()[0]?.index;
    return view?.book?.sections?.[index]?.href ?? null;
  })()`);
  await evaluate(`(async () => {
    const library = (await import("/src/store/library-store.ts")).useLibraryStore.getState();
    const title = library.booksWithStatus.find((book) => book.id === ${JSON.stringify(bookId)})?.title ?? "验收书籍";
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    await layout.openBook(${JSON.stringify(bookId)}, title);
    const settings = (await import("/src/store/app-settings-store.ts")).useAppSettingsStore;
    const current = settings.getState().settings;
    settings.getState().setSettings({ ...current, globalViewSettings: { ...current.globalViewSettings, bookViewMode: "bilingual" } });
    return true;
  })()`);
  await evaluate(`(async () => {
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    const view = layout.readerStores.get("reader-${bookId}")?.getState().view;
    const href = view?.book?.sections?.[0]?.href;
    if (href) view.goTo(href);
    else await view?.renderer?.goTo?.({ index: 0, anchor: 0 });
    return true;
  })()`);
  await sleep(600);
  await waitFor(
    `(async () => {
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    const view = layout.readerStores.get("reader-${bookId}")?.getState().view;
    return view?.renderer?.getContents?.().some((content) => content.doc?.querySelector("[data-book-translation][data-block-index]"));
  })()`,
    "原文与译文同屏",
  );
  const hover = async (targetSide) => {
    const result = await evaluate(`(async () => {
      const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
      const view = layout.readerStores.get("reader-${bookId}").getState().view;
      const content = view.renderer.getContents().find((item) => item.doc?.querySelector("[data-book-translation][data-block-index]"));
      if (!content) return { error: "没有译文文档" };
      const doc = content.doc;
      const svc = await import("/src/services/book-translation/book-translation-service.ts");
      const file = await svc.loadBookTranslationSection(${JSON.stringify(bookId)}, ${report.sectionIndex});
      const blockIndex = Object.keys(file.blocks).find((key) => /[\\u4e00-\\u9fff]/.test(file.blocks[key].text));
      const source = Array.from(doc.querySelectorAll("[data-block-index]")).find((el) => el.getAttribute("data-block-index") === blockIndex && !el.hasAttribute("data-book-translation"));
      const target = doc.querySelector('[data-book-translation][data-block-index="' + blockIndex + '"]');
      const own = ${targetSide ? "target" : "source"};
      const other = ${targetSide ? "source" : "target"};
      if (!own || !other) return { error: "缺少原文或译文块", blockIndex };
      doc.getSelection()?.removeAllRanges();
      const rect = own.getBoundingClientRect();
      const x = rect.left + Math.min(${targetSide ? 18 : 45}, rect.width / 3);
      const y = rect.top + Math.min(14, rect.height / 2);
      const element = doc.elementFromPoint(x, y) ?? own;
      const win = doc.defaultView;
      doc.dispatchEvent(new win.MouseEvent("mouseleave", { bubbles: false }));
      element.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y, view: win }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const layer = doc.querySelector(".book-align-hover-layer");
      const rects = Array.from(doc.querySelectorAll(".book-align-hover-rect"));
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const covered = (el) => {
        const bounds = el.getBoundingClientRect();
        return rects.some((rect) => intersects(rect.getBoundingClientRect(), bounds));
      };
      const helpers = await import("/src/services/book-translation/section-blocks.ts");
      const caret = doc.caretRangeFromPoint?.(x, y);
      const rawOffset = caret ? helpers.rawOffsetOf(own, caret.startContainer, caret.startOffset) : null;
      const normOffset = rawOffset === null ? null : helpers.rawToNormOffset(helpers.buildBlockTextMap(own), rawOffset);
      const ownRange = helpers.normToRange(own, helpers.buildBlockTextMap(own), ${targetSide ? "file.blocks[blockIndex].align[0].ts" : "file.blocks[blockIndex].align[0].ss"}, ${targetSide ? "file.blocks[blockIndex].align[0].te" : "file.blocks[blockIndex].align[0].se"});
      const otherRange = helpers.normToRange(other, helpers.buildBlockTextMap(other), ${targetSide ? "file.blocks[blockIndex].align[0].ss" : "file.blocks[blockIndex].align[0].ts"}, ${targetSide ? "file.blocks[blockIndex].align[0].se" : "file.blocks[blockIndex].align[0].te"});
      return {
        ownRangeValid: Boolean(ownRange),
        otherRangeValid: Boolean(otherRange),
        ownRangeRects: ownRange?.getClientRects().length,
        otherRangeRects: otherRange?.getClientRects().length,
        ownRangeRect: ownRange?.getClientRects()[0]?.toJSON(),
        otherRangeRect: otherRange?.getClientRects()[0]?.toJSON(),
        blockIndex,
        rawOffset,
        normOffset,
        pair: file.blocks[blockIndex]?.align,
        ownRect: { x, y, width: rect.width, height: rect.height },
        hitTag: element.tagName,
        hitBlock: element.closest("[data-block-index]")?.getAttribute("data-block-index"),
        caretOffset: doc.caretRangeFromPoint?.(x, y)?.startOffset,
        layerPresent: Boolean(layer),
        rects: rects.length,
        ownCovered: covered(own),
        counterpartCovered: covered(other),
        counterpartPresent: Boolean(other),
        ownText: own.textContent.slice(0, 60),
        counterpartText: other.textContent.slice(0, 60),
      };
    })()`);
    check(
      `${targetSide ? "译文" : "原文"} hover 同时覆盖两侧对应句段`,
      result.layerPresent &&
        result.rects >= 2 &&
        result.ownCovered &&
        result.counterpartCovered &&
        result.counterpartPresent,
      JSON.stringify(result),
    );
    await shot(targetSide ? "target" : "source");
    return result;
  };
  report.sourceHover = await hover(false);
  report.targetHover = await hover(true);
} catch (error) {
  check("双向 hover 验收执行异常", false, error instanceof Error ? error.stack : String(error));
} finally {
  await evaluate(`(async () => {
    const previous = ${JSON.stringify(previous ?? {})};
    const previousLocation = ${JSON.stringify(previousReadingLocation ?? null)};
    if (previousLocation) {
      const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
      layout.readerStores.get("reader-${bookId}")?.getState().view?.goTo(previousLocation);
    }
    if (previous.settings) (await import("/src/store/app-settings-store.ts")).useAppSettingsStore.getState().setSettings(previous.settings);
    if (previous.layout) (await import("/src/store/layout-store.ts")).useLayoutStore.setState(previous.layout);
    return true;
  })()`).catch(() => {});
  ws.close();
}
report.exceptions = exceptions.map((item) => item.exception?.description ?? item.text).filter(Boolean);
writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
if (checks.some((item) => !item.pass) || report.exceptions.length) process.exit(1);
console.log(`${checks.length}/${checks.length} PASS`);
