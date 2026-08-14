// E2E 验证：全局转换进度层（不跑真实转换，用 store 假状态驱动）
// 场景：A 论文卡全局可见+三页豁免+恢复；B 图书弹层点外最小化+小卡还原；C 双卡不重叠
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
    // CDP 错误也走 resolve（reject 会触发 undici 的 "Promise was collected" 崩溃）
    p.resolve(msg.error ? { __cdpError: msg.error.message } : msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));

const results = [];
const check = (name, ok, extra = "") =>
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);

const evalJS = async (expr) => {
  const r = await call("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r?.__cdpError) throw new Error(`CDP error: ${r.__cdpError}`);
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
  return r.result.value;
};

// 页面刷新由 scripts/cdp-reload-wait.mjs 预先完成；此处注册 page 侧工具
// （动态 import 的 Promise 在 awaitPromise 下可能被 GC 回收——分两步：先挂 window 再同步用）
await evalJS(`import("/src/store/convert-progress-store.ts").then((m) => { window.__store = m; }); "importing"`);
await new Promise((r) => setTimeout(r, 400));
await evalJS(`(() => {
  window.__probe = () => {
    const cards = [...document.querySelectorAll(".fixed.right-4.bottom-4 > div")];
    const paper = cards.find((c) => c.textContent.includes("fake-paper.pdf"));
    const book = cards.find((c) => c.textContent.includes("PDF 转 EPUB"));
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left) };
    };
    return {
      hash: location.hash,
      paperCard: !!paper, bookCard: !!book,
      paperRect: rect(paper), bookRect: rect(book),
      dialogOpen: !!document.querySelector('[data-region="dialog"]'),
    };
  };
  return true;
})()`);

// ---- 场景 A：论文卡全局可见 + 豁免 + 恢复 ----
await evalJS(`location.hash = "#/papers"; true`);
await new Promise((r) => setTimeout(r, 800));
await evalJS(`window.__store.useConvertProgressStore.setState({ paperImport: {
  status: "running", fileName: "fake-paper.pdf", percent: 42, detail: "内容处理…",
  stages: [{ n: 1, name: "OCR 解析", status: "done" }, { n: 2, name: "元数据提取", status: "done" }, { n: 3, name: "内容处理", status: "active" }, { n: 4, name: "渲染装订", status: "pending" }],
  index: 1, total: 2, importedCount: 0, skippedCount: 0, failedCount: 0, failedNames: [],
} }); true`);
await new Promise((r) => setTimeout(r, 300));
let p = await evalJS("window.__probe()");
check("A1 论文页卡片可见", p.paperCard);

await evalJS(`location.hash = "#/statistics"; true`);
await new Promise((r) => setTimeout(r, 800));
p = await evalJS("window.__probe()");
check("A2 统计页卡片仍可见（全局）", p.paperCard);

await evalJS(`location.hash = "#/chat"; true`);
await new Promise((r) => setTimeout(r, 800));
p = await evalJS("window.__probe()");
check("A3 全局助手聊天页豁免（卡片隐藏）", !p.paperCard);

await evalJS(`location.hash = "#/papers"; true`);
await new Promise((r) => setTimeout(r, 800));
p = await evalJS("window.__probe()");
check("A4 退出聊天页卡片恢复", p.paperCard);

// 阅读器 tab 豁免：开一个论文阅读 tab
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "importing"`);
await new Promise((r) => setTimeout(r, 500));
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("6c533ac14d2b48e4", "cosmic strings"); true`);
await new Promise((r) => setTimeout(r, 1200));
p = await evalJS("window.__probe()");
check("A5 论文阅读器页豁免（卡片隐藏）", !p.paperCard);
await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`);
await new Promise((r) => setTimeout(r, 800));
p = await evalJS("window.__probe()");
check("A6 退出阅读器卡片恢复（状态保留）", p.paperCard);

// ---- 场景 B：图书转换弹层点外最小化 + 小卡点击还原 ----
await evalJS(`location.hash = "#/"; true`);
await new Promise((r) => setTimeout(r, 1000));
// 打开弹层并伪造转换中状态
await evalJS(`(async () => {
  const s = window.__store.useConvertProgressStore.getState();
  s.setBookConvertConfig({ pdfPath: "C:\\\\tmp\\\\fake-book.pdf" });
  s.openBookConvertDialog();
  window.__store.useConvertProgressStore.setState((st) => ({
    bookConvert: { ...st.bookConvert, status: "converting", percent: 30,
      stages: [{ n: 1, name: "MinerU 解析", status: "active" }, { n: 2, name: "Hybrid 结构重建", status: "pending" }, { n: 3, name: "EPUB 生成", status: "pending" }] },
  }));
  return true;
})()`);
await new Promise((r) => setTimeout(r, 600));
p = await evalJS("window.__probe()");
check("B1 弹层打开（转换中）", p.dialogOpen);
check("B2 转换中最小化前无小卡", !p.bookCard);

// 模拟点击窗口外（对话框居中，点左下角必然在窗外）→ Radix onOpenChange(false) → 最小化
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: 30, y: 600, button: "left", clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 30, y: 600, button: "left", clickCount: 1 });
await new Promise((r) => setTimeout(r, 800));
p = await evalJS("window.__probe()");
const st1 = await evalJS("window.__store.useConvertProgressStore.getState().bookConvertMinimized");
check("B3 点窗外弹层关闭", !p.dialogOpen, `minimized=${st1}`);
check("B4 右下角小卡出现", p.bookCard);
check("B5 双卡并存且都在（论文+图书）", p.paperCard && p.bookCard);

// 防重叠：两卡 bottom 不应相等（gap-2 堆叠）
if (p.paperRect && p.bookRect) {
  const gap = Math.abs(p.paperRect.bottom - p.bookRect.bottom);
  check("B6 双卡不重叠（纵向堆叠）", gap > 50, `paperBottom=${p.paperRect.bottom} bookBottom=${p.bookRect.bottom}`);
}

// 点击小卡 → 还原大窗口
const posStr = await evalJS(`(() => {
  const cards = [...document.querySelectorAll(".fixed.right-4.bottom-4 > div")];
  const book = cards.find((c) => c.textContent.includes("PDF 转 EPUB"));
  if (!book) return "no-card";
  const r = book.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + 20 });
})()`);
if (posStr === "no-card") {
  check("B7 点击小卡还原大窗口", false, "no card found");
} else {
  const pos = JSON.parse(posStr);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 800));
  p = await evalJS("window.__probe()");
  check("B7 点击小卡还原大窗口", p.dialogOpen && !p.bookCard);
}

// 关闭弹层（idle 态应彻底关闭而非最小化）
await evalJS(`window.__store.useConvertProgressStore.getState().resetBookConvert(); true`);
await new Promise((r) => setTimeout(r, 300));
await evalJS(`window.__store.useConvertProgressStore.getState().closeBookConvertDialog(); true`);
await new Promise((r) => setTimeout(r, 600));
p = await evalJS("window.__probe()");
check("B8 idle 态关闭直接消失（不最小化）", !p.dialogOpen && !p.bookCard);

// 清理假状态
await evalJS(`window.__store.useConvertProgressStore.setState({ paperImport: null }); true`);

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
