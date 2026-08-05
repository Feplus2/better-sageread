// 调试：remark-parse + remark-math 对 $$ 块的分词结果
const LIST_URL = "http://127.0.0.1:9223/json/list";
const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => { const id = ++mid; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };

const samples = [
  "$$x^2$$",
  "段落\n\n$$x^2$$",
  "$$\nx^2\n$$",
  "行内 $E=mc^2$ 测试。\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
];

const expression = `
(async () => {
  const origin = location.origin;
  const { unified } = await import(origin + "/@id/unified");
  const remarkParse = (await import(origin + "/@id/remark-parse")).default;
  const remarkMath = (await import(origin + "/@id/remark-math")).default;
  const markedMod = await import(origin + "/@id/marked");
  const samples = ${JSON.stringify(samples)};
  const out = [];
  for (const s of samples) {
    const tree = unified().use(remarkParse).use(remarkMath).parse(s);
    out.push({
      sample: s,
      ast: tree.children.map((c) => ({ type: c.type, kids: (c.children || []).map((x) => x.type) })),
      markedBlocks: markedMod.marked.lexer(s).map((t) => ({ type: t.type, raw: t.raw })),
    });
  }
  return out;
})()
`;

const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.result?.value, null, 2) ?? JSON.stringify(r).slice(0, 500));
ws.close();
