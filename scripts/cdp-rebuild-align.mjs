// CDP 驱动真实 app：翻译下拉 → 重建对齐（force 句词两级全量重算，走真实嵌入 API）
// 轮询 translation-zh.json mtime 变化判定完成，输出新对齐覆盖统计
import { readFileSync, statSync } from "node:fs";

const LIST_URL = "http://127.0.0.1:9222/json/list";
const TR_PATH = "C:/Users/20995/AppData/Roaming/com.xincmm.sageread.dev/books/a27b187c6bd02d3c/translation-zh.json";

async function getPage(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
const page = await getPage();
if (!page) {
  console.log("NO_PAGE");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");

const evalJs = async (expression) => {
  const res = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res?.exceptionDetails) {
    console.log("EVAL_EXCEPTION:", JSON.stringify(res.exceptionDetails).slice(0, 400));
  }
  return res?.result?.value;
};

const mtimeBefore = statSync(TR_PATH).mtimeMs;
console.log("重建前 mtime:", new Date(mtimeBefore).toISOString());

// 1. 打开翻译下拉（Radix trigger 在 pointerdown 时展开）
const opened = await evalJs(`(() => {
  const btn = document.querySelector('button:has(svg.lucide-languages)');
  if (!btn) return "NO_TRIGGER";
  btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  btn.click();
  return "CLICKED";
})()`);
console.log("触发下拉:", opened);
await new Promise((r) => setTimeout(r, 800));

// 2. 点击“重建对齐”菜单项
const clicked = await evalJs(`(() => {
  const items = [...document.querySelectorAll('[role="menuitem"], [data-radix-collection-item]')];
  const labels = items.map(i => (i.textContent || '').trim());
  const item = items.find(i => (i.textContent || '').includes('重建对齐'));
  if (!item) return "NO_ITEM | 可见菜单项: " + JSON.stringify(labels);
  if (item.getAttribute('aria-disabled') === 'true' || item.dataset.disabled !== undefined) return "ITEM_DISABLED";
  item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  item.click();
  return "OK";
})()`);
console.log("点击重建对齐:", clicked);
if (clicked !== "OK") {
  ws.close();
  process.exit(1);
}

// 3. 轮询完成：mtime 变化 + 页面 toast
const start = Date.now();
let done = false;
while (Date.now() - start < 10 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 5000));
  const mtime = statSync(TR_PATH).mtimeMs;
  const toast = await evalJs(`(() => {
    const els = [...document.querySelectorAll('[data-sonner-toast], [role="status"], li[data-type]')];
    return els.map(e => (e.textContent || '').trim()).filter(Boolean).join(' | ');
  })()`);
  const elapsed = Math.round((Date.now() - start) / 1000);
  if (mtime > mtimeBefore) {
    // 文件已写回——对齐服务在结束时一次性落盘
    console.log(`[${elapsed}s] 文件已更新:`, new Date(mtime).toISOString(), toast ? `| toast: ${toast}` : "");
    done = true;
    break;
  }
  if (elapsed % 30 === 0 || elapsed < 30) console.log(`[${elapsed}s] 计算中…`, toast ? `toast: ${toast}` : "");
}

if (!done) {
  console.log("TIMEOUT: 10 分钟内文件未更新");
  ws.close();
  process.exit(1);
}

// 4. 统计新对齐数据
await new Promise((r) => setTimeout(r, 1000));
const f = JSON.parse(readFileSync(TR_PATH, "utf-8"));
const blocks = Object.entries(f.blocks).map(([k, v]) => ({ idx: +k, ...v })).sort((a, b) => a.idx - b.idx);
const withAlign = blocks.filter((b) => Array.isArray(b.align) && b.align.length > 0);
const withAlignW = blocks.filter((b) => Array.isArray(b.alignW) && b.alignW.length > 0);
let pairs = 0, low = 0, wpairs = 0, wlow = 0;
for (const b of withAlign) for (const p of b.align) { pairs++; if (p.low) low++; }
for (const b of withAlignW) for (const p of b.alignW) { wpairs++; if (p.low) wlow++; }
console.log("\n===== 重建后对齐统计 =====");
console.log("alignStatus:", f.alignStatus, "| alignWStatus:", f.alignWStatus);
console.log(`句对齐块: ${withAlign.length}/${blocks.length} | 句对 ${pairs}（low ${low}）`);
console.log(`词对齐块: ${withAlignW.length}/${blocks.length} | 词对 ${wpairs}（low ${wlow}）`);
const b200 = blocks.find((b) => b.idx === 200);
console.log("块200: align", b200?.align?.length ?? "无", "| alignW", b200?.alignW?.length ?? "无");
ws.close();
