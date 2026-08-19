// 最终居中验证：shadow 捕获 → reload → 开书 → 定向中文数学 frame → 全量偏移统计
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

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
await call("Page.enable").catch(() => {});
await call("Page.reload");
await new Promise((r) => setTimeout(r, 9000));
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 600));
  if (await evalJS(`!!(window.__layout && document.querySelector("foliate-view"))`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().openBook("e642d3f98615287d7925db0da8712837", "高等数学"); true`);
await new Promise((r) => setTimeout(r, 10000));

const out = await evalJS(`(() => {
  const docs = [];
  for (const { root } of window.__closedRoots ?? []) {
    for (const f of root.querySelectorAll("iframe")) {
      try { if (f.contentDocument?.body) docs.push(f.contentDocument); } catch {}
    }
  }
  // 定向：含大量块级公式的中文 frame
  let target = null;
  for (const d of docs) {
    const n = d.querySelectorAll('math[display="block"]').length;
    const zh = /[\\u4e00-\\u9fff]{4,}/.test(d.body?.innerText ?? "");
    if (n > 20 && zh) { target = d; break; }
  }
  if (!target) return { error: "no math frame", frames: docs.length };
  const doc = target;
  const bodyR = doc.body.getBoundingClientRect();
  const colC = bodyR.left + bodyR.width / 2;
  const maths = [...doc.querySelectorAll('math[display="block"]')].filter((m) => {
    const r = m.getBoundingClientRect();
    return r.height > 5 && r.width > 5;
  });
  const offsets = maths.map((m) => {
    const r = m.getBoundingClientRect();
    return Math.round(r.left + r.width / 2 - colC);
  });
  const centered = offsets.filter((o) => Math.abs(o) <= 3).length;
  return {
    chapter: doc.title.slice(0, 18),
    visible: maths.length,
    centered: centered,
    offCenter: maths.length - centered,
    sampleOffsets: offsets.slice(0, 15),
  };
})()`);
console.log(JSON.stringify(out));
ws.close();
