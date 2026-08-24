// 全局助手卡顿探针：分场景采样 FPS / 长任务 / 内存
// 场景：空闲基线 → 打字 → 流式回答（真实模型，短问题）
setTimeout(() => { console.error('WATCHDOG'); process.exit(2); }, 150000).unref();
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => (r = res)); pending.set(++mid, { r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
console.log('[step] ws open');
const evalJS = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('[step] injecting');
// 注入采样器：longtask + rAF 帧时长 + 输入延迟
await evalJS(`(() => {
  window.__probe = { longtasks: [], frames: [], inputLat: [], active: false };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (window.__probe.active) window.__probe.longtasks.push({ d: Math.round(e.duration), t: Math.round(e.startTime) }); }).observe({ entryTypes: ['longtask'] });
  let last = 0;
  const loop = (ts) => { if (window.__probe.active && last) window.__probe.frames.push(Math.round(ts - last)); last = ts; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  document.addEventListener('input', (e) => { if (!window.__probe.active) return; const t0 = performance.now(); requestAnimationFrame(() => window.__probe.inputLat.push(Math.round(performance.now() - t0))); }, true);
  'ok';
})()`);

const sample = async (label, seconds) => {
  await evalJS(`window.__probe.active = true; window.__probe.frames = []; window.__probe.longtasks = []; window.__probe.inputLat = []; 'reset'`);
  await sleep(seconds * 1000);
  const r = await evalJS(`(() => { window.__probe.active = false; const f = window.__probe.frames; const lt = window.__probe.longtasks;
    const avg = f.length ? f.reduce((a,b)=>a+b,0)/f.length : 0;
    const p95 = f.length ? f.sort((a,b)=>a-b)[Math.floor(f.length*0.95)] : 0;
    return { frames: f.length, avgMs: Math.round(avg*10)/10, fps: avg? Math.round(1000/avg) : 0, p95Ms: p95, longtasks: lt.length, ltTotalMs: lt.reduce((a,b)=>a+b.d,0), ltMax: lt.length? Math.max(...lt.map(x=>x.d)) : 0, inputLatMax: window.__probe.inputLat.length? Math.max(...window.__probe.inputLat) : 0, inputLatN: window.__probe.inputLat.length, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0)/1048576) }; })()`);
  console.log(label, JSON.stringify(r));
  return r;
};

console.log('[step] sampler injected');
// 到全局助手页
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "ok"`);
for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJS(`!!window.__layout`).catch(() => false)) break; }
await evalJS(`window.__layout.useLayoutStore.getState().navigateToHome(); true`);
await sleep(1500);
console.log('[step] layout ready');
await evalJS(`location.hash = '#/chat'; true`);
console.log('[step] at chat');
await sleep(2500);

console.log('[step] baseline start');
// 场景 1：空闲基线（chat 页静止 5s）
await sample("基线(空闲chat页):", 5);

console.log('[step] baseline done');
// 场景 2：打字（输入框插入 60 字符）
const inputSel = await evalJS(`(() => { const ta = document.querySelector('textarea'); return !!ta; })()`);
console.log("输入框在场:", inputSel);
await evalJS(`(() => { window.__probe.active = true; window.__probe.inputLat = []; window.__probe.frames=[]; window.__probe.longtasks=[]; 'go'; })()`);
for (let i = 0; i < 60; i++) {
  await evalJS(`(() => { const ta = document.querySelector('textarea'); if (!ta) return; ta.focus(); const nv = ta.value + '字'; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, nv); ta.dispatchEvent(new Event('input', { bubbles: true })); true; })()`);
  await sleep(30);
}
console.log("打字:", JSON.stringify(await evalJS(`(() => { window.__probe.active = false; const l = window.__probe.inputLat; const f = window.__probe.frames; const avg = f.length ? f.reduce((a,b)=>a+b,0)/f.length : 0; return { inputN: l.length, inputAvgMs: l.length? Math.round(l.reduce((a,b)=>a+b,0)/l.length) : 0, inputMaxMs: l.length? Math.max(...l) : 0, avgFrameMs: Math.round(avg*10)/10, longtasks: window.__probe.longtasks.length }; })()`)));

console.log('[step] typing done');
// 场景 3：真实流式回答（短问题但长回答）
await evalJS(`(() => { const ta = document.querySelector('textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '用中文写一段约 600 字的散文，主题是冬天。不要使用任何工具。'); ta.dispatchEvent(new Event('input', { bubbles: true })); true; })()`);
await evalJS(`(() => { const btns = Array.from(document.querySelectorAll('button')); const send = btns.find((b) => b.querySelector('svg') && !b.disabled && (b.getAttribute('aria-label')||'').match(/发送|send/i)) ?? btns[btns.length-1]; true; })()`);
// 直接回车提交（PromptInput 惯例 Enter 发送）
await evalJS(`(() => { const ta = document.querySelector('textarea'); ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); true; })()`);
await sleep(1000);
const streaming = await evalJS(`(document.body.textContent ?? '').length`);
console.log("提交后页面字符数:", streaming);
await sample("流式回答(15s):", 15);
await sample("流式回答(续 10s):", 10);

// 打印长任务时间线
console.log("长任务明细:", await evalJS(`JSON.stringify(window.__probe.longtasks.slice(0, 30))`));
ws.close();
console.log("done");
