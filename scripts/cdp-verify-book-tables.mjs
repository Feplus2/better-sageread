// 书籍跳转到表格章节复测（chapter_014 附近有 $\left(\frac{1}{2},0\right)$ 单元格公式）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
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
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "");
  return r.result.value;
};

await evalJS(`document.querySelector("foliate-view")?.goToFraction?.(0.22); "going"`).catch((e) =>
  console.log("goTo err:", e.message),
);
await new Promise((r) => setTimeout(r, 5000));

const probe = await evalJS(`(() => {
  const docs = [];
  for (const { root } of window.__closedRoots ?? []) {
    for (const f of root.querySelectorAll("iframe")) {
      try { if (f.contentDocument?.body) docs.push(f.contentDocument); } catch {}
    }
  }
  const out = [];
  const rawDollarRe = new RegExp("\\\\$[^\\\\$\\\\n]{3,}\\\\$");
  for (const doc of docs) {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.height > 5 && r.width > 5;
    };
    out.push({
      chapter: doc.title.slice(0, 28),
      tdMath: [...doc.querySelectorAll("td math")].filter(visible).length,
      capMath: [...doc.querySelectorAll("p.no_indent math")].filter(visible).length,
      rawDollar: (doc.body.innerText.match(/\\$[^$\\n]{3,}\\$/g) ?? []).length,
      table: (() => {
        const t = [...doc.querySelectorAll("table")].find(visible);
        if (!t) return null;
        const tr = t.getBoundingClientRect();
        const b = doc.body.getBoundingClientRect();
        return { gapL: Math.round(tr.left - b.left), gapR: Math.round(b.right - tr.right), w: Math.round(tr.width) };
      })(),
    });
  }
  return out;
})()`);
console.log(JSON.stringify(probe, null, 2));
ws.close();
