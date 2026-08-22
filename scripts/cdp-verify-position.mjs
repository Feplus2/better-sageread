// E3 终验沉淀：单实例四连跳位置感知（可见层 header 观察）。用法：node scripts/cdp-verify-position.mjs
// 前提：dev 实例 CDP 9223；脚本自动清 tab → store API 开 Routes 论文 → 四次跳转 → 每次读可见层 header。
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.error("实例未就绪");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
    }, 120000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalp = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};

// 1) 清 tab → store API 开论文（绕过 DOM 点击不稳定）
const opened = await evalp(`(async () => {
  const ls = await import('/src/store/layout-store.ts');
  ls.useLayoutStore.setState({ tabs: [], activeTabId: null, isHomeActive: true, sleptTabIds: [] });
  const ps = await import('/src/services/paper-service.ts');
  const papers = await ps.listPapers();
  const p = papers.find((x) => x.title.includes('Routes')) ?? papers[0];
  if (!p) return null;
  ls.useLayoutStore.getState().openPaper(p.id, p.title);
  return p.title.slice(0, 40);
})()`);
if (!opened) {
  console.error("无论文可开");
  process.exit(1);
}
console.log("论文:", opened);
await evalp(`(async () => { for (let i = 0; i < 60; i++) { await new Promise(r=>setTimeout(r,500)); if (document.querySelectorAll('.paper-content h2').length >= 3) return true; } return false; })()`);

const readVis = `(() => {
  const spans = Array.from(document.querySelectorAll('span.max-w-100'));
  for (const s of spans) {
    let el = s;
    let hidden = false;
    while (el) {
      if (el.style && el.style.visibility === 'hidden') { hidden = true; break; }
      el = el.parentElement;
    }
    if (!hidden) return s.textContent.trim().slice(0, 40);
  }
  return null;
})()`;
const jump = (frac) =>
  evalp(`(async () => {
    const el = document.querySelector('div.relative.h-full.min-h-0.overflow-y-auto');
    el.scrollTo({ top: el.scrollHeight * ${frac} });
    await new Promise((r) => setTimeout(r, 1800));
    return 1;
  })()`);

const initial = await evalp(readVis);
await jump(0.3);
const at30 = await evalp(readVis);
await jump(0.65);
const at65 = await evalp(readVis);
await jump(0.05);
const at5 = await evalp(readVis);
ws.close();

console.log(`初始: ${initial}`);
console.log(`跳 30%: ${at30}`);
console.log(`跳 65%: ${at65}`);
console.log(`回 5%: ${at5}`);
const fails = [];
if (!initial || !at30 || !at65 || !at5) fails.push("header 读取失败");
if (at30 === initial && at65 === initial) fails.push("跳转后位置未更新（仍停初始值）");
if (fails.length) {
  console.error("FAIL:", fails.join(" | "));
  process.exit(1);
}
console.log("PASS: 单实例位置感知随跳转更新");
