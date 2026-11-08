import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(
  readFileSync(".superpowers/sdd/2026-11-05-release-0.5.0-closure/providers/provider-live-catalog.json", "utf8"),
);
const chat = JSON.parse(
  readFileSync(".superpowers/sdd/2026-11-05-release-0.5.0-closure/providers/provider-live-chat.json", "utf8"),
);
assert.equal(catalog.results.length, 8);
assert.ok(catalog.results.every((result) => result.pass && !result.skipped));
assert.equal(chat.results.length, 8);
assert.ok(chat.results.every((result) => result.pass && !result.skipped));
assert.ok(
  chat.results.every((result) => result.checks.text?.pass && result.checks.stream?.pass && result.checks.history?.pass),
);
assert.ok(chat.results.filter((result) => result.id !== "doubao").every((result) => result.checks.image?.pass));
assert.ok(chat.results.find((result) => result.id === "doubao")?.checks.image?.skipped);
assert.ok(Object.values(chat.configurationPreserved).every(Boolean));
console.log("PASS provider reports: 8 catalogs + 8 text/stream/history + 7 images; Doubao image explicitly unverified");

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
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
const result = await new Promise((resolve) => {
  pending.set(seq + 1, resolve);
  ws.send(
    JSON.stringify({
      id: ++seq,
      method: "Runtime.evaluate",
      params: {
        expression: `(async () => {
        const registry = await import("/src/ai/tools/registry.ts");
        const tools = registry.getToolsForScope("central");
        const doc = "book:e0018649a41bcc985cdd66a9fd2251ff";
        const info = await tools.getDocumentInfo.execute({ doc });
        let total = 0;
        let formulas = 0;
        let figures = 0;
        for (let offset = 0; offset < 60000; offset += 6000) {
          const window = await tools.readDocument.execute({ doc, offset, after: 6000 });
          total = window.total_chars ?? total;
          const pieces = window.text.split("$");
          formulas += Math.floor((pieces.length - 1) / 2);
          figures += window.text.split("![").length - 1;
          if (!window.next_offset || !window.truncated) break;
        }
        return {
          title: info.doc.title,
          outlineCount: info.outline.items.length,
          total,
          formulas,
          figures,
          pass: info.outline.items.length >= 5 && total > 10000 && formulas > 0 && figures >= 4,
        };
      })()`,
        awaitPromise: true,
        returnByValue: true,
      },
    }),
  );
});
console.log(JSON.stringify(result));
const evidence = result?.result?.result?.value;
console.log(JSON.stringify(evidence, null, 2));
ws.close();
assert.ok(evidence?.pass);
