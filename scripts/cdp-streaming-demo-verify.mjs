import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const outFile = process.env.VERIFY_OUT ?? ".tmp-agent-followup/streaming-demo-verify.json";
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
const exceptions = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") exceptions.push(msg.params.exceptionDetails);
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 60000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
await call("Page.enable");
const { identifier } = await call("Page.addScriptToEvaluateOnNewDocument", {
  source: `
(() => {
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const pending = new Set();
  window.__demoRaf = { pending };
  window.requestAnimationFrame = (callback) => {
    let id = 0;
    id = nativeRaf((time) => {
      pending.delete(id);
      callback(time);
    });
    pending.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    pending.delete(id);
    nativeCancel(id);
  };
})();
`,
});
const initialUrl = page.url;
const demoPath = pathToFileURL(`${process.cwd()}/demos/streaming-effects-preview.html`).pathname.slice(1);
await call("Page.navigate", { url: `http://localhost:${appPort}/@fs/${demoPath}` });
await new Promise((resolve) => setTimeout(resolve, 1500));
const evalJs = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails)
    throw new Error(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
  return result.result?.result?.value;
};
await evalJs(`document.getElementById("sample").click(); true`);
await new Promise((resolve) => setTimeout(resolve, 150));
await evalJs(`document.getElementById("sample").click(); true`);
await new Promise((resolve) => setTimeout(resolve, 300));
const sample = await evalJs(`(() => {
  const text = currentText();
  return {
    sampleCount: SAMPLES.length,
    sampleLabel: document.getElementById("sample").textContent,
    codePoints: Array.from(text).length,
    emojiPreserved: text.includes("👨‍👩‍👧‍👦") && Array.from(document.querySelectorAll(".ch")).some((span) => span.textContent === "👨‍👩‍👧‍👦"),
    replacementCharacters: Array.from(document.querySelectorAll(".ch")).filter((span) => span.textContent.includes("�")).length,
  };
})()`);
await evalJs(`(() => {
  sharedSched?.stop();
  for (const card of cards) card.sched?.stop();
  const total = cards[0].body.querySelectorAll(".ch").length;
  for (const card of cards) card.effect.chunk(total);
  return total;
})()`);
for (let i = 0; i < 360; i++) {
  const stopped = await evalJs("window.__demoRaf.pending.size === 0");
  if (stopped) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const final = await evalJs(`({
  pendingRaf: window.__demoRaf.pending.size,
  bodyHasEmoji: document.body.textContent.includes("👨‍👩‍👧‍👦"),
  cards: cards.map((card) => {
    const body = card.body;
    const id = card.cfg.id;
    const actual = body.textContent;
    const expected = currentText();
    let differenceIndex = 0;
    while (differenceIndex < actual.length && differenceIndex < expected.length && actual[differenceIndex] === expected[differenceIndex]) differenceIndex++;
    return {
      id,
      difference: actual === expected ? null : {
        index: differenceIndex,
        expectedCodes: Array.from(expected.slice(0, 24), (char) => char.codePointAt(0).toString(16)),
        actualCodes: Array.from(actual.slice(0, 24), (char) => char.codePointAt(0).toString(16)),
        expected: expected.slice(Math.max(0, differenceIndex - 20), differenceIndex + 80),
        actual: actual.slice(Math.max(0, differenceIndex - 20), differenceIndex + 80),
      },
      spans: body.querySelectorAll(".ch").length,
      textComplete: body.textContent === currentText(),
      effectSettled: typeof card.effect.settled === "function" && card.effect.settled(),
      visualSettled: id === "mist"
        ? Array.from(body.querySelectorAll(".ch")).every((el) => !el.style.filter && !el.style.color)
        : id === "type"
          ? !!body.querySelector(".caret.gone")
          : id === "scrword"
            ? body.querySelectorAll(".scr").length === 0
            : body.querySelectorAll(".ch:not(.on)").length === 0,
    };
  }),
})`);
const screenshot = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile.replace(/\.json$/, ".png"), Buffer.from(screenshot.result.data, "base64"));
const report = {
  ...sample,
  ...final,
  exceptions: exceptions.map((item) => item.exception?.description ?? item.text).filter(Boolean),
};
report.pass =
  report.sampleCount >= 3 &&
  report.codePoints > 720 &&
  report.emojiPreserved &&
  report.replacementCharacters === 0 &&
  report.pendingRaf === 0 &&
  report.cards.every((card) => card.textComplete && card.effectSettled && card.visualSettled) &&
  report.exceptions.length === 0;
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
await call("Page.navigate", { url: initialUrl });
ws.close();
if (!report.pass) process.exit(1);
