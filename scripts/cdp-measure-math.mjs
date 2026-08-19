// 查块级公式的父级结构 + 完整居中测量
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

for (const frac of [0.35, 0.6]) {
  await evalJS(`(async () => {
    const v = document.querySelector("foliate-view");
    try { await v.goToFraction(${frac}); } catch {}
    return true;
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  const probe = await evalJS(`(() => {
    const docs = [];
    for (const { root } of window.__closedRoots ?? []) {
      for (const f of root.querySelectorAll("iframe")) {
        try { if (f.contentDocument?.body) docs.push(f.contentDocument); } catch {}
      }
    }
    // 定向：找含中文数学教材内容的 frame（其他书的 foliate 视图也在挂载）
    let doc = docs.find((d) => {
      const t = d.body?.innerText ?? "";
      return /[一-鿿]{6,}/.test(t) && !/Jets|Quantum|oxides|nacl|sodium/i.test(t);
    }) ?? docs[0];
    if (!doc) return { error: "no frame" };
    const maths = [...doc.querySelectorAll('math[display="block"]')].filter((m) => {
      const r = m.getBoundingClientRect();
      return r.height > 5 && r.width > 5;
    });
    // 容器：依次找最近块级祖先（p/div/td/body），用它当基准
    // 基准用整页内容列（body），避免收缩包裹容器造成的同义反复
    const bodyR = doc.body.getBoundingClientRect();
    const colC = Math.round(bodyR.left + bodyR.width / 2);
    const detail = maths.slice(0, 10).map((m) => {
      const r = m.getBoundingClientRect();
      const cs = getComputedStyle(m);
      return {
        parentTag: m.parentElement?.tagName,
        mathC: Math.round(r.left + r.width / 2),
        colC,
        offset: Math.round(r.left + r.width / 2 - colC),
        mathW: Math.round(r.width),
        textAlign: cs.textAlign,
        indent: getComputedStyle(m.parentElement).textIndent,
      };
    });
    return { frac: ${frac}, chapter: doc.title.slice(0, 18), count: maths.length, detail };
  })()`);
  console.log(JSON.stringify(probe, null, 1));
}
ws.close();
