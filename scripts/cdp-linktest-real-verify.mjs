// P1 集成验证（最终版）：实际闪烁内容从 CSS.highlights 的 Range 里抓；原文/对照两种模式都测
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 localhost:1420 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (method, params) => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  pending.set(++mid, { promise, resolve });
  ws.send(JSON.stringify({ id: mid, method, params }));
  return promise;
};
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call("Page.reload", { ignoreCache: true });
await sleep(4000);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
await evalJS(`import("/src/store/app-settings-store.ts").then((m) => { window.__appSettings = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout && !!window.__appSettings`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("6c533ac14d2b48e4", "cosmic strings"); true`);
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  ready = await evalJS(`!!document.querySelector('.paper-content a[href^="#ref-"]')`).catch(() => false);
  if (ready) break;
}
if (!ready) throw new Error("正文渲染超时");

const savedMode = await evalJS(`window.__appSettings.useAppSettingsStore.getState().settings.paperViewMode ?? "original"`);
console.log("原 viewMode:", savedMode);
const setMode = async (mode) => {
  await evalJS(`(() => { const s = window.__appSettings.useAppSettingsStore.getState(); s.setSettings({ ...s.settings, paperViewMode: ${JSON.stringify(mode)} }); true })()`);
  await sleep(2500); // 等重渲染
};

const clickAndMeasure = async (href, label) => {
  await evalJS(`(() => {
    document.querySelectorAll('.paper-image-jump-flash').forEach((e) => e.classList.remove('paper-image-jump-flash'));
    document.querySelector('.paper-content').closest('.overflow-y-auto').scrollTo({top: 0, behavior: 'instant'});
    true;
  })()`);
  await sleep(300);
  const clicked = await evalJS(`(() => {
    const a = document.querySelector('.paper-content a[href="${href}"]');
    if (!a) return null;
    a.click();
    return a.textContent;
  })()`);
  if (clicked === null) { console.log(`${label}: 链接不存在`); return; }
  // 页内 40ms 轮询：捕获实际闪烁 Range 的宿主元素信息（Highlight 为 setlike，可 values() 取 Range）
  const flash = await evalJS(`new Promise((res) => {
    const t0 = Date.now();
    let seen = null;
    const iv = setInterval(() => {
      const h = CSS.highlights && CSS.highlights.get("paper-anno-current");
      if (h && h.size > 0 && !seen) {
        const r = h.values().next().value;
        const node = r.commonAncestorContainer;
        const el = node.nodeType === 1 ? node : node.parentElement;
        seen = { tag: el.tagName,
                 text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 55),
                 isTranslation: !!el.closest("[data-translation]"),
                 hasKatex: !!el.querySelector(".katex") };
      }
      if (Date.now() - t0 > 1600) { clearInterval(iv); res(seen); }
    }, 40);
  })`);
  const imgFlashed = await evalJS(`!!document.querySelector('.paper-content img.paper-image-jump-flash')`);
  await sleep(3400); // 校正窗口（600/1500/3000ms）结束后量最终落点
  const probe = await evalJS(`(() => {
    const id = ${JSON.stringify(href)}.slice(1);
    const el = document.getElementById(id);
    const scroller = document.querySelector('.paper-content').closest('.overflow-y-auto');
    const rect = el.getBoundingClientRect();
    return { scrollTop: Math.round(scroller.scrollTop), elTop: Math.round(rect.top),
             expect: Math.round(scroller.getBoundingClientRect().top + scroller.clientHeight / 4),
             inViewport: rect.top >= 0 && rect.top <= window.innerHeight };
  })()`);
  console.log(`${label}: "${clicked}" scrollTop=${probe.scrollTop} elTop=${probe.elTop}/${probe.expect} 视口=${probe.inViewport} 闪烁=${JSON.stringify(flash)} 图闪=${imgFlashed}`);
};

// ─── 原文模式全套 ───
await setMode("original");
await clickAndMeasure("#ref-15", "原文 1a) #ref-15");
await clickAndMeasure("#ref-31", "原文 1b) #ref-31");
await clickAndMeasure("#ref-3", "原文 1c) #ref-3 ");
await clickAndMeasure("#fig-6", "原文 2a) #fig-6 ");
await clickAndMeasure("#fig-1", "原文 2b) #fig-1 ");
await clickAndMeasure("#eq-43", "原文 3a) #eq-43");
await clickAndMeasure("#eq-25", "原文 3b) #eq-25");
await clickAndMeasure("#sec-vi-conclusions", "原文 4)  #sec-vi");

// ─── 对照模式抽查：闪烁目标不得落在译文 div ───
await setMode("bilingual");
await clickAndMeasure("#eq-43", "对照 5a) #eq-43");
await clickAndMeasure("#ref-15", "对照 5b) #ref-15");

// 恢复原 viewMode
await setMode(savedMode);
console.log("viewMode 已恢复为:", savedMode);
console.log("done");
ws.close();
