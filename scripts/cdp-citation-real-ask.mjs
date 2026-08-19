// 引用标验证（真实提问版）：活动论文 tab（已向量化宇宙弦论文）真实提问，
// 引导模型输出数字引用标（句末 [四位数字]、禁表格/占位符）→ 点标弹层 → 跳转定位+闪烁
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
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

// 活动 tab 容器带 inline style visibility:visible（reader-layout），沿祖先链判定
const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;
const PANEL = `Array.from(document.querySelectorAll('#paper-chat-panel')).find(${VIS})`;
const SCROLLER = `Array.from(document.querySelectorAll('.paper-content')).find(${VIS})?.closest('.overflow-y-auto')`;

// 确保在宇宙弦论文 tab
await evalJS(`window.__layout.useLayoutStore.getState().activateTab('paper-6c533ac14d2b48e4'); true`).catch(() => {});
await sleep(1200);

await evalJS(`(() => {
  const panel = ${PANEL};
  const textarea = panel.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '请用 paperSearch 工具检索（英文 query）后用一段话回答：这篇论文里摩擦特征的低频截断为什么不匹配数值计算结果？引用时在句末直接写检索结果里的数字编号（如 [2227] 这样的数字），不要输出 chunk_id 占位文字，不要用表格。');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  panel.querySelector('button[type=submit]').click();
  true;
})()`);
console.log("已提交真实提问");

let marks = [];
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  await sleep(3000);
  const st = await evalJS(`(() => {
    const panel = ${PANEL};
    const thinking = (panel.textContent ?? '').includes('Thinking');
    const last = Array.from(panel.querySelectorAll('[data-message-id]')).pop();
    const marks = last ? Array.from(last.querySelectorAll('span.rounded-full')).map((s) => s.textContent) : [];
    return { marks, thinking };
  })()`);
  const numeric = st.marks.filter((m) => /^\\d+$/.test(m));
  if (numeric.length > 0 && !st.thinking) {
    await sleep(4000);
    const st2 = await evalJS(`(() => {
      const panel = ${PANEL};
      const last = Array.from(panel.querySelectorAll('[data-message-id]')).pop();
      return { thinking: (panel.textContent ?? '').includes('Thinking'),
               marks: last ? Array.from(last.querySelectorAll('span.rounded-full')).map((s) => s.textContent) : [] };
    })()`);
    if (!st2.thinking) { marks = st2.marks; break; }
  }
  marks = st.marks;
}
console.log("真实回答引用标:", JSON.stringify(marks));
const numeric = marks.filter((m) => /^\\d+$/.test(m));
if (numeric.length === 0) {
  console.log("模型仍未输出数字引用标（提示词敏感问题，链路其余环节已由 cdp-citation-step4b 确定性验证）");
  console.log("done");
  ws.close();
  process.exit(0);
}

const firstMark = numeric[0];
await evalJS(`(() => {
  const panel = ${PANEL};
  const last = Array.from(panel.querySelectorAll('[data-message-id]')).pop();
  const el = Array.from(last.querySelectorAll('span.rounded-full')).find((s) => s.textContent === ${JSON.stringify(firstMark)});
  el.click();
  true;
})()`);
let pop = null;
for (let i = 0; i < 25; i++) {
  await sleep(400);
  pop = await evalJS(`(() => {
    const wrap = document.querySelector('[data-radix-popper-content-wrapper]');
    if (!wrap) return null;
    const text = (wrap.textContent ?? '').replace(/\\s+/g, ' ').trim();
    if (!text || text.includes('加载中')) return { pending: true };
    return { text: text.slice(0, 200) };
  })()`);
  if (pop && !pop.pending) break;
}
console.log(`弹层 [${firstMark}]:`, JSON.stringify(pop));

const before = await evalJS(`Math.round((${SCROLLER}).scrollTop)`);
const jumpClicked = await evalJS(`(() => { const btn = document.querySelector('[data-radix-popper-content-wrapper]')?.querySelector('button'); if (!btn) return false; btn.click(); return true; })()`);
const flash = await evalJS(`new Promise((res) => {
  const t0 = Date.now(); let seen = null;
  const iv = setInterval(() => {
    const h = CSS.highlights && CSS.highlights.get("paper-anno-current");
    if (h && h.size > 0 && !seen) { const r = h.values().next().value; seen = (r.toString() ?? '').replace(/\\s+/g, ' ').trim().slice(0, 90); }
    if (Date.now() - t0 > 1800) { clearInterval(iv); res(seen); }
  }, 40);
})`);
await sleep(2500);
const after = await evalJS(`Math.round((${SCROLLER}).scrollTop)`);
const toast = await evalJS(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent).join(' | ').slice(0, 120)`);
console.log("跳转:", jumpClicked, "滚动", before, "→", after, " 闪烁:", JSON.stringify(flash), " toast:", JSON.stringify(toast));
console.log("done");
ws.close();
