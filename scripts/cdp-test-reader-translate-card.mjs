// 阅读页翻译联动专项 v2：带 ?t= 实例对齐。A=翻译小卡；B=onSettled 即时刷新徽标
const list0 = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page0 = list0.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page0) {
  console.error("实例未就绪");
  process.exit(1);
}
const ws = new WebSocket(page0.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalp = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};

// 实例对齐：从消费方转换源码里抠 ?t= 版本 URL
const storeUrl = await evalp(`(async () => {
  const src = await (await fetch('/src/pages/paper-reader/paper-reader-view.tsx')).text();
  const key = '/src/store/paper-task-store';
  const i = src.indexOf(key);
  return i >= 0 ? src.slice(i, src.indexOf(String.fromCharCode(34), i)) : key + '.ts';
})()`);
console.log("store URL:", storeUrl);

// 进文献库
await evalp(`(async () => {
  const ls = await import('/src/store/layout-store.ts');
  ls.useLayoutStore.setState({ tabs: [], activeTabId: null, isHomeActive: true, sleptTabIds: [] });
  await new Promise((r) => setTimeout(r, 800));
  const navs = Array.from(document.querySelectorAll('nav a, nav button, aside a, aside button'));
  navs.find((t) => t.textContent.trim() === '文献库')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 2500));
  return true;
})()`);

const importStore = `await import(${JSON.stringify(storeUrl)})`;

// A1：设翻译进度 → 卡片应出现在右下角栈
const a1 = await evalp(`(async () => {
  const ts = (${importStore}).usePaperTaskStore;
  window.__probeCancelled = false;
  ts.getState().startReaderTranslate({ paperId: 'probe', title: 'PROBE 翻译卡片标题', done: 3, total: 10 }, () => { window.__probeCancelled = true; });
  await new Promise((r) => setTimeout(r, 700));
  const stack = document.getElementById('bottom-right-stack');
  return { text: stack ? stack.textContent.replace(/\\s+/g, ' ').slice(0, 200) : null };
})()`);
console.log("A1 卡片出现:", JSON.stringify(a1));

// A2：patch 进度与 detail
const a2 = await evalp(`(async () => {
  const ts = (${importStore}).usePaperTaskStore;
  ts.getState().patchReaderTranslate({ done: 5, detail: '句词对齐中…' });
  await new Promise((r) => setTimeout(r, 400));
  const stack = document.getElementById('bottom-right-stack');
  return { text: stack ? stack.textContent.replace(/\\s+/g, ' ').slice(0, 200) : null };
})()`);
console.log("A2 卡片更新:", JSON.stringify(a2));

// A3：取消按钮触发注册的回调；A4：清除后卡片消失
const a3 = await evalp(`(async () => {
  const stack = document.getElementById('bottom-right-stack');
  const btn = stack?.querySelector('button[title^="取消翻译"]');
  if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const cancelled = window.__probeCancelled;
  const ts = (${importStore}).usePaperTaskStore;
  ts.getState().clearReaderTranslate();
  await new Promise((r) => setTimeout(r, 400));
  const gone = !document.getElementById('bottom-right-stack')?.textContent.includes('PROBE');
  return { cancelCallbackFired: cancelled, cardGoneAfterClear: gone };
})()`);
console.log("A3/A4 取消回调+清除:", JSON.stringify(a3));

// B：onSettled 即时刷新徽标（不重载页面）
const fs = await import("node:fs");
const metaPath = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev/books/6c533ac14d2b48e4/metadata.json";
const m = JSON.parse(fs.readFileSync(metaPath, "utf8"));
m.translationRunState = "partial";
fs.writeFileSync(metaPath, JSON.stringify(m, null, 2));

const probeBadge = `(async () => {
  const rows = Array.from(document.querySelectorAll('[class*="cursor-pointer"]'));
  const row = rows.find((r) => r.textContent.includes('Gravitational waves from cosmic strings with friction') || r.textContent.includes('含摩擦宇宙弦'));
  const icon = row?.querySelector('svg.lucide-languages');
  return { found: !!row, amber: !!icon && icon.classList.contains('text-amber-500'), green: !!icon && icon.classList.contains('text-green-600') };
})()`;

const b1 = await evalp(`(async () => {
  const ts = (${importStore}).usePaperTaskStore;
  ts.getState().onSettled?.();
  await new Promise((r) => setTimeout(r, 2500));
  return await (${probeBadge});
})()`);
console.log("B1 注入 partial 后(预期 amber):", JSON.stringify(b1));

delete m.translationRunState;
fs.writeFileSync(metaPath, JSON.stringify(m, null, 2));
const b2 = await evalp(`(async () => {
  const ts = (${importStore}).usePaperTaskStore;
  ts.getState().onSettled?.();
  await new Promise((r) => setTimeout(r, 2500));
  return await (${probeBadge});
})()`);
console.log("B2 移除戳记后(预期 green):", JSON.stringify(b2));

ws.close();
process.exit(0);
