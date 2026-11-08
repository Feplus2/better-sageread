import { validateBookTranslationSection } from "./book-translation-acceptance.mjs";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const bookId = process.env.BOOK_ID ?? "c6207a35b9b8e0b5396d0b2ffc4f42b9";
const force = process.env.FORCE === "1";
const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error(`找不到隔离 SageRead 页面（${cdpPort}/${appPort}）`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 600000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
const result = await call("Runtime.evaluate", {
  expression: `(async () => {
    const svc = await import("/src/services/book-translation/book-translation-service.ts?chapter=" + Date.now());
    const bookId = ${JSON.stringify(bookId)};
    const { bookDoc } = await svc.openBookDocument(bookId);
    const sections = await svc.collectBookSections(bookDoc);
    const first = sections[0];
    const validate = ${validateBookTranslationSection.toString().replace(/^export\s+/, "")};
    if (!first) return { pass: false, error: "没有可翻译章节" };
    if (!${force}) {
      const indexes = await svc.listBookTranslationSectionIndexes(bookId);
      const existing = indexes.length ? await svc.loadBookTranslationSection(bookId, indexes[0]) : null;
      const { hashBlockText } = await import("/src/services/paper-translation-service.ts");
      const acceptance = await validate(existing, hashBlockText);
      return { pass: true, readOnly: true, bookId, sectionIndex: indexes[0], ...acceptance };
    }
    const controller = new AbortController();
    const started = Date.now();
    const pending = svc.translateBook({ bookId, force: ${force}, signal: controller.signal })
      .catch((error) => ({ cancelled: true, error: String(error) }));
    const lastFormulaIndex = first.sourceTexts.findLastIndex((text) => text.includes("$"));
    let completed = null;
    while (Date.now() - started < 480000) {
      const indexes = await svc.listBookTranslationSectionIndexes(bookId);
      for (const index of indexes) {
        const file = await svc.loadBookTranslationSection(bookId, index);
        const requiredText = file?.blocks?.[String(lastFormulaIndex)]?.text ?? "";
        if (file && Date.parse(file.updatedAt) >= started && /[\\u4e00-\\u9fff]/.test(requiredText)) {
          completed = { index, file };
          break;
        }
      }
      if (completed) {
        controller.abort();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const settled = await pending;
    if (!completed) return { pass: false, error: "超时仍未有真实中文译文落盘", settled };
    const mathOnlyChecks = first.mathOnly.map((isMath, index) => ({
      index,
      pass: !isMath || completed.file.blocks[String(index)]?.text === "",
    }));
    const formulaChecks = [];
    const formulaPattern = /\\$\\$[\\s\\S]+?\\$\\$|\\$[^$\\n]+\\$/g;
    for (let index = 0; index < first.sourceTexts.length; index++) {
      if (first.mathOnly[index]) continue;
      const formulas = first.sourceTexts[index].match(formulaPattern) ?? [];
      const translatedText = completed.file.blocks[String(index)]?.text ?? "";
      for (const formula of formulas) formulaChecks.push({ index, formula, pass: translatedText.includes(formula) });
    }
    const cjkBlocks = Object.values(completed.file.blocks).filter((block) => /[\\u4e00-\\u9fff]/.test(block.text)).length;
    const mathOnlyPass = mathOnlyChecks.every((item) => item.pass);
    const formulasPass = formulaChecks.every((item) => item.pass);
    const { hashBlockText } = await import("/src/services/paper-translation-service.ts");
    const { alignBookTranslation } = await import("/src/services/book-translation/book-alignment.ts");
    await alignBookTranslation({ bookId, mode: "sentence" });
    completed.file = await svc.loadBookTranslationSection(bookId, completed.index);
    const alignment = await validate(completed.file, hashBlockText);
    return {
      pass: settled.cancelled === true && cjkBlocks > 0 && mathOnlyPass && formulasPass && alignment.alignedBlocks > 0,
      alignment,
      bookId,
      sectionIndex: completed.index,
      cjkBlocks,
      totalBlocks: Object.keys(completed.file.blocks).length,
      mathOnlyCount: first.mathOnly.filter(Boolean).length,
      mathOnlyPass,
      formulaCount: formulaChecks.length,
      formulasPass,
      formulaFailures: formulaChecks.filter((item) => !item.pass),
      cancelled: settled.cancelled,
      settled,
      translationFile: completed.file,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
const value = result.result?.result?.value;
if (result.result?.exceptionDetails) {
  throw new Error(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
}
console.log(JSON.stringify(value, null, 2));
ws.close();
if (!value?.pass) process.exit(1);
