// 居中问题定位：shadow 捕获 → reload → 打开高数书 → 量块级公式几何 + 计算 CSS
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

await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "importing"`);
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 600));
  if (await evalJS(`!!(window.__layout && document.querySelector("foliate-view"))`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().openBook("e642d3f98615287d7925db0da8712837", "高等数学"); true`);
await new Promise((r) => setTimeout(r, 9000));

const probe = await evalJS(`(() => {
  const docs = [];
  for (const { root } of window.__closedRoots ?? []) {
    for (const f of root.querySelectorAll("iframe")) {
      try { if (f.contentDocument?.body) docs.push(f.contentDocument); } catch {}
    }
  }
  if (!docs.length) return { error: "no book frame" };
  const doc = docs[0];
  const maths = [...doc.querySelectorAll('math[display="block"]')].filter((m) => {
    const r = m.getBoundingClientRect();
    return r.height > 5 && r.width > 5;
  });
  const samples = maths.slice(0, 6).map((m) => {
    const r = m.getBoundingClientRect();
    const host = (m.closest("p") ?? m.parentElement).getBoundingClientRect();
    // 公式内容真正的可见主体：mrow 的并集近似取 m 的 scrollWidth 与内容首尾
    const cs = getComputedStyle(m);
    const inner = m.firstElementChild?.getBoundingClientRect();
    return {
      mathLeft: Math.round(r.left), mathW: Math.round(r.width),
      hostLeft: Math.round(host.left), hostW: Math.round(host.width),
      innerLeft: inner ? Math.round(inner.left) : null,
      csDisplay: cs.display, textAlign: cs.textAlign, margin: cs.marginLeft + "|" + cs.marginRight,
      widthCss: cs.width,
    };
  });
  // css 规则
  let rules = [];
  try {
    for (const s of doc.styleSheets) for (const r of s.cssRules) {
      if ((r.selectorText ?? "").includes("math")) rules.push(r.cssText.slice(0, 140));
    }
  } catch (e) { rules = ["inaccessible: " + e.message]; }
  return { chapter: doc.title.slice(0, 24), visibleBlockMath: maths.length, samples, mathRules: rules.slice(0, 4) };
})()`);
console.log(JSON.stringify(probe, null, 2));
ws.close();
