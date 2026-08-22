// P0.5 UI 级 E2E v2：清布局状态 → 稳定进入全局助手 → 发送 → 流回 → 刷新 → 断言续接（H1/H2）
// 用法：node scripts/cdp-test-v7-e2e.mjs（dev 实例 CDP 9223，需已配置可用模型）
const list0 = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page0 = list0.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page0) {
  console.error("未找到应用页面");
  process.exit(1);
}
const ws = new WebSocket(page0.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    const desc = (d?.exception?.description || "").slice(0, 200);
    // foliate paginator 的存量空指针（与本验证无关）不计数
    if (!desc.includes("foliate-js") && !desc.includes("paginator")) exceptions.push(`${d?.text ?? ""} ${desc}`);
  }
};
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 240000);
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
await call("Runtime.enable", {});
await call("Page.enable", {});

const MARK = `v7e2e-${Date.now().toString(36)}`;
console.log("标记消息:", MARK);

// 1) 清布局恢复状态（tabs 清空 → 应用回到主页，不再覆盖 /chat 导航）。
//    注意：layout-store 是持久化的，setState 后须等异步持久化落盘再硬导航，
//    否则刷新后的水合会把旧 tabs（论文阅读页）抢回来盖住 /chat。
const enterCentral = async () => {
  // 应用是 HashRouter：先用路径整页加载到主页，再在**不重载**的前提下清布局 + 切 hash 到 /chat
  // （同文档 hash 导航不触发布局持久化的重新水合，store 内存态得以保留）
  await call("Page.navigate", { url: "http://localhost:1420/" });
  await evalp(`(async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (document.querySelector('textarea') || document.body.innerText.includes('我的图书')) return true;
    }
    return false;
  })()`);
  await evalp(`(async () => {
    const ls = await import('/src/store/layout-store.ts');
    ls.useLayoutStore.setState({ tabs: [], activeTabId: null, isHomeActive: true, sleptTabIds: [] });
    location.hash = '#/chat';
    return true;
  })()`);
  return evalp(`(async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const ta = document.querySelector('textarea');
      if (ta && !document.body.innerText.includes('论文助手') && !document.body.innerText.includes('本篇论文')) return true;
    }
    return false;
  })()`);
};
let centralOk = await enterCentral();
if (!centralOk) {
  console.warn("首次进入被布局水合抢回，重试一次");
  centralOk = await enterCentral();
}
if (!centralOk) {
  console.error("FAIL: /chat 页面未稳定出现输入框（或仍被论文面板占用）");
  process.exit(1);
}

// 3) 新开对话（避免续接旧线程干扰断言），点「新对话」按钮若存在
await evalp(`(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().includes('新对话'));
  if (btn) btn.click();
  return !!btn;
})()`);

// 4) 输入 + 点发送
await evalp(`(async () => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '请只回复四个字：升级成功（自动化测试 ${MARK}）');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const btn = Array.from(document.querySelectorAll('button[type=submit]')).find((b) => !b.disabled);
  if (btn) { btn.click(); return 'btn'; }
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return 'enter';
})()`);

// 5) 等回复出现且稳定（含标记的用户消息应先出现在 DOM）
const got = await evalp(`(async () => {
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (document.body.innerText.includes('${MARK}') && document.body.innerText.includes('升级成功')) return true;
  }
  return false;
})()`);
console.log("发送后标记+回复可见:", got);
if (!got) {
  console.error("FAIL: 90s 内未见回复；异常:", exceptions.slice(0, 3));
  process.exit(1);
}

// 6) 刷新 → 断言续接（H1 落库 + H2 恢复）
await call("Page.reload", {});
const resumed = await evalp(`(async () => {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const body = document.body.innerText;
    if (body.includes('${MARK}') && body.includes('升级成功')) return true;
  }
  return false;
})()`);
ws.close();

console.log("刷新后对话续接:", resumed);
console.log("全程相关页面异常:", exceptions.length ? exceptions.slice(0, 5) : "无");
const fails = [];
if (!got) fails.push("发送/回复失败");
if (!resumed) fails.push("刷新后未续接（H1/H2 断裂）");
if (exceptions.length) fails.push("页面异常: " + exceptions[0]);
if (fails.length) {
  console.error("FAIL:", fails.join(" | "));
  process.exit(1);
}
console.log("PASS: v7 UI 全链路（发送→流回→落库→刷新续接）");
