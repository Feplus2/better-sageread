// 「返回上处」按钮验证：转跳出现 / 驻留消失 / 点击返回 / 链式返回 / TOC 转跳纳入 / 条目点击不误触
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

await call("Page.reload", { ignoreCache: true });
await sleep(4500);
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "loading"`);
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await evalJS(`!!window.__layout`).catch(() => false)) break;
}
await evalJS(`window.__layout.useLayoutStore.getState().openPaper("57ae0a5f29feecb6", "Forecast constraints"); true`);
const VIS = `(el) => { let n = el; while (n) { if (n.style && n.style.visibility) return n.style.visibility === 'visible'; n = n.parentElement; } return true; }`;
const SCROLLER = `Array.from(document.querySelectorAll('.paper-content')).find(${VIS})?.closest('.overflow-y-auto')`;
let ready = false;
for (let i = 0; i < 240; i++) {
  await sleep(500);
  ready = await evalJS(`(() => { const s = ${SCROLLER}; return !!(s && s.querySelector('a[href^="#ref-"]')); })()`).catch(() => false);
  if (ready) break;
}
if (!ready) {
  console.log("超时诊断:", await evalJS(`JSON.stringify({ contents: document.querySelectorAll('.paper-content').length, refs: document.querySelectorAll('.paper-content a[href^="#ref-"]').length })`));
  throw new Error("正文渲染超时");
}

const btnVisible = `(() => { const s = ${SCROLLER}; const b = Array.from(s.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes('返回上处')); return b ? b.checkVisibility() : false; })()`;
const scrollTop = `(() => { const s = ${SCROLLER}; return Math.round(s.scrollTop); })()`;
const clickBack = `(() => { const s = ${SCROLLER}; const b = Array.from(s.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes('返回上处')); if (!b) return false; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.click(); return true; })()`;
// 用户滚动模拟：CDP 原生 wheel（trusted input）
const userScrollBy = async (px) => {
  // CDP 原生滚轮（trusted input，真实触发滚动与 React onWheel），分段逼近真实用户滚动
  const point = await evalJS(`(() => {
    const s = ${SCROLLER};
    const r = s.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  for (let done = 0; done < px; done += 120) {
    await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: 120 });
    await sleep(300);
  }
  return evalJS(`(() => { const s = ${SCROLLER}; return Math.round(s.scrollTop); })()`);
};
const clickLink = (href) => `(() => {
  const c = Array.from(document.querySelectorAll('.paper-content')).find(${VIS});
  const a = Array.from(c.querySelectorAll('a[href="${href}"]')).find(${VIS});
  if (!a) return null;
  a.click();
  return a.textContent;
})()`;

// 0) 基线：无按钮
console.log("0) 初始按钮(应 false):", await evalJS(btnVisible));

// 0b) 参考文献条目纯点击（弹卡片，无滚动转跳）不应出按钮
await evalJS(`(() => {
  const c = Array.from(document.querySelectorAll('.paper-content')).find(${VIS});
  const anchor = Array.from(c.querySelectorAll('a[id^="ref-"]')).find(${VIS});
  const block = anchor.closest('p, li');
  block.scrollIntoView({ block: 'center' });
  const r = block.getBoundingClientRect();
  document.elementFromPoint(r.left + 60, r.top + r.height / 2).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  true;
})()`);
await sleep(1200);
console.log("0b) 条目点击后按钮(应 false):", await evalJS(btnVisible));
await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(400);

// 1) 点击文内引用链接 → 按钮出现
await evalJS(`(() => { const s = ${SCROLLER}; s.scrollTo({ top: 0, behavior: 'instant' }); true })()`);
await sleep(300);
const origin1 = await evalJS(scrollTop);
console.log("1) 点击 [[6]](#ref-6):", await evalJS(clickLink("#ref-6")));
await sleep(1500);
const after1 = await evalJS(scrollTop);
console.log("1) 滚动", origin1, "→", after1, " 按钮(应 true):", await evalJS(btnVisible));

// 2) 用户滚动 ~200px → 按钮消失（驻留）
console.log("2) 用户滚动:", await userScrollBy(200));
await sleep(700);
console.log("2) 按钮(应 false):", await evalJS(btnVisible));

// 3) 图链接转跳 → 按钮出现 → 点击返回 → 回到点击前位置
await evalJS(`(() => { const s = ${SCROLLER}; s.scrollTo({ top: 0, behavior: 'instant' }); true })()`);
await sleep(300);
const origin3 = await evalJS(scrollTop);
const figHref = await evalJS(`(() => { const c = Array.from(document.querySelectorAll('.paper-content')).find(${VIS}); const a = c.querySelector('a[href^="#fig-"]'); return a ? a.getAttribute('href') : null; })()`);
console.log("3) 图链接:", figHref, "点击:", await evalJS(clickLink(figHref ?? "#fig-none")));
await sleep(1500);
const after3 = await evalJS(scrollTop);
console.log("3) 滚动", origin3, "→", after3, " 按钮(应 true):", await evalJS(btnVisible));
console.log("3) 点击返回:", await evalJS(clickBack));
await sleep(1500);
const back3 = await evalJS(scrollTop);
console.log("3) 返回后 scrollTop:", back3, "（应≈", origin3, "） 按钮(应 false):", await evalJS(btnVisible));

// 4) 链式：A→B→C，两次返回依次回 B、A
await evalJS(`(() => { const s = ${SCROLLER}; s.scrollTo({ top: 0, behavior: 'instant' }); true })()`);
await sleep(300);
const posA = await evalJS(scrollTop);
await evalJS(clickLink("#ref-6"));
await sleep(1500);
const posB = await evalJS(scrollTop);
await evalJS(clickLink(figHref ?? "#fig-none"));
await sleep(1500);
const posC = await evalJS(scrollTop);
console.log("4) 链式位置:", posA, "→", posB, "→", posC, " 按钮:", await evalJS(btnVisible));
await evalJS(clickBack);
await sleep(1500);
const backB = await evalJS(scrollTop);
console.log("4) 第一次返回:", backB, "（应≈", posB, "） 按钮(应 true):", await evalJS(btnVisible));
await evalJS(clickBack);
await sleep(1500);
const backA = await evalJS(scrollTop);
console.log("4) 第二次返回:", backA, "（应≈", posA, "） 按钮(应 false):", await evalJS(btnVisible));

// 5) TOC 下拉转跳纳入：打开目录点一个条目 → 按钮出现
await evalJS(`(() => { const s = ${SCROLLER}; s.scrollTo({ top: 0, behavior: 'instant' }); true })()`);
await sleep(300);
const tocOpened = await evalJS(`(() => {
  const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.querySelector('svg.lucide-table-of-contents'));
  const btn = btns.find((b) => (${VIS})(b));
  if (!btn) return false;
  for (const type of ['pointerdown', 'pointerup', 'click']) {
    btn.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse' }));
  }
  return true;
})()`);
await sleep(800);
const tocPicked = await evalJS(`(() => {
  const items = Array.from(document.querySelectorAll('[role="menuitem"], [data-radix-popper-content-wrapper] button, [data-slot="dropdown-menu-content"] button'))
    .filter((b) => b.checkVisibility() && (b.textContent ?? '').trim().length > 3);
  if (items.length === 0) return null;
  const item = items[Math.min(4, items.length - 1)];
  const text = (item.textContent ?? '').trim().slice(0, 40);
  item.click();
  return text;
})()`);
await sleep(1500);
console.log("5) TOC 打开:", tocOpened, " 点选:", tocPicked, " 按钮(应 true):", await evalJS(btnVisible));

console.log("done");
ws.close();
