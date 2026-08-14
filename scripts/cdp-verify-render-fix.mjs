// 最终验证：表格/注/标题公式渲染 + 表格居中 + display 公式居中（书籍+论文两侧）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到主实例页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  const id = ++mid;
  pending.set(id, { promise, resolve });
  ws.send(JSON.stringify({ id, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    p.resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.__cdpError) throw new Error(r.__cdpError);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await call("Page.enable").catch(() => {});

// 1) 注入 shadow 捕获 + reload
await call("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const orig = Element.prototype.attachShadow;
    window.__closedRoots = [];
    Element.prototype.attachShadow = function (init) {
      const root = orig.call(this, init);
      if (init.mode === "closed") window.__closedRoots.push({ host: this, root });
      return root;
    };
  })();`,
});
await call("Page.reload");
await new Promise((r) => setTimeout(r, 9000));
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "importing"`);
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 600));
  const ok = await evalJS(`!!(window.__layout && document.querySelector("foliate-view"))`).catch(() => false);
  if (ok) break;
}

const results = [];
const check = (name, ok, extra = "") =>
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);

// 2) 打开 Standard Model 书
await evalJS(`window.__layout.useLayoutStore.getState().openBook("bf167cc3003e200321fac3eb80c8d804", "QFT Standard Model"); true`);
await new Promise((r) => setTimeout(r, 9000));

// 3) 书籍 iframe 深检
const bookProbe = await evalJS(`(() => {
  const docs = [];
  for (const { root } of window.__closedRoots ?? []) {
    for (const f of root.querySelectorAll("iframe")) {
      try { if (f.contentDocument?.body) docs.push(f.contentDocument); } catch {}
    }
  }
  if (!docs.length) return { error: "no book frame" };
  const doc = docs[0];
  const mathIn = (sel) => [...doc.querySelectorAll(sel)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 5 && r.width > 5;
  });
  const tdMath = doc.querySelectorAll("td math").length;
  const capMath = doc.querySelectorAll("p.no_indent math").length;
  const hMath = doc.querySelectorAll("h1 math, h2 math, h3 math, h4 math, h5 math, h6 math").length;
  const rawDollar = (doc.body.innerText.match(/\\$[^$\\n]{3,}\\$/g) ?? []).length;
  // 表格居中：找一张可见表
  const table = [...doc.querySelectorAll("table")].find((t) => t.getBoundingClientRect().height > 10);
  let tableInfo = null;
  if (table) {
    const tr = table.getBoundingClientRect();
    const body = doc.body.getBoundingClientRect();
    const cs = getComputedStyle(table);
    tableInfo = {
      leftGap: Math.round(tr.left - body.left), rightGap: Math.round(body.right - tr.right),
      width: Math.round(tr.width), margin: cs.marginLeft + "|" + cs.marginRight,
      centered: Math.abs(tr.left - body.left - (body.right - tr.right)) < 12,
    };
  }
  // block math 居中
  const bm = [...doc.querySelectorAll('math[display="block"]')].find((m) => m.getBoundingClientRect().height > 6);
  let mathInfo = null;
  if (bm) {
    const r = bm.getBoundingClientRect();
    const p = (bm.closest("p") ?? bm.parentElement).getBoundingClientRect();
    mathInfo = { centered: Math.abs(r.left - p.left - (p.right - r.right)) < 12 };
  }
  return { chapter: doc.title.slice(0, 30), tdMath, capMath, hMath, rawDollar, tableInfo, mathInfo };
})()`);
console.log("BOOK:", JSON.stringify(bookProbe));
check("B1 书内表格单元格 MathML", bookProbe.tdMath > 0, `td math=${bookProbe.tdMath}`);
check("B2 书内注（图注/表注）MathML", bookProbe.capMath > 0, `cap math=${bookProbe.capMath}`);
check("B3 书内标题 MathML", bookProbe.hMath > 0, `h math=${bookProbe.hMath}`);
check("B4 书内无裸 $ 公式", bookProbe.rawDollar === 0, `raw=$${bookProbe.rawDollar}`);
if (bookProbe.tableInfo) check("B5 书内表格居中", bookProbe.tableInfo.centered, JSON.stringify(bookProbe.tableInfo));
if (bookProbe.mathInfo) check("B6 书内 block math 居中", bookProbe.mathInfo.centered);

// 4) 论文：表格居中
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("6c533ac14d2b48e4", "cosmic strings"); true`);
await new Promise((r) => setTimeout(r, 9000));
const paperProbe = await evalJS(`(() => {
  const table = [...document.querySelectorAll(".paper-content table")].find((t) => t.getBoundingClientRect().height > 10);
  if (!table) return { error: "no table" };
  const tr = table.getBoundingClientRect();
  const p = table.parentElement.getBoundingClientRect();
  const centered = Math.abs(tr.left - p.left - (p.right - tr.right)) < 12;
  const disp = [...document.querySelectorAll(".katex-display")].find((el) => el.getBoundingClientRect().height > 5);
  let mathInfo = null;
  if (disp) {
    const inner = disp.querySelector(".katex")?.getBoundingClientRect();
    const pr = disp.parentElement.getBoundingClientRect();
    mathInfo = { centered: inner ? Math.abs(inner.left - pr.left - (pr.right - inner.right)) < 12 : null };
  }
  return { tableW: Math.round(tr.width), parentW: Math.round(p.width), gapL: Math.round(tr.left - p.left), gapR: Math.round(p.right - tr.right), centered, mathInfo };
})()`);
console.log("PAPER:", JSON.stringify(paperProbe));
if (!paperProbe.error) {
  check("P1 论文表格居中", paperProbe.centered, `w=${paperProbe.tableW}/${paperProbe.parentW} L=${paperProbe.gapL} R=${paperProbe.gapR}`);
  if (paperProbe.mathInfo) check("P2 论文 display 公式居中", paperProbe.mathInfo.centered);
}

console.log(results.join("\n"));
console.log(results.some((r) => r.startsWith("FAIL")) ? "\nHAS FAILURES" : "\nALL PASS");
ws.close();
