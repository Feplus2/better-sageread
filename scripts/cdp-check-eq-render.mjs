// 验证 cosmic strings 论文公式 (50)/(A2) 在应用内渲染（endsWith 免正则版）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到主实例页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));

const PAGE_SCRIPT = `
(async () => {
  window.__scroller = () => [...document.querySelectorAll("div")]
    .filter(el => el.className && String(el.className).includes("overflow-y-auto"))
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  window.__findEq = (num) => [...document.querySelectorAll(".katex-display .katex-html")]
    .find(el => el.textContent.trimEnd().endsWith("(" + num + ")"));
  window.__scan = () => {
    const errors = [];
    document.querySelectorAll(".katex-error").forEach(el => errors.push(el.textContent.trim().slice(0, 80)));
    return errors;
  };
  if (!location.hash.includes("6c533ac14d2b48e4")) {
    location.hash = "#/reader/6c533ac14d2b48e4";
    await new Promise(r => setTimeout(r, 4000));
  }
  const sc = window.__scroller();
  if (!sc) return { fatal: "no scroller" };
  sc.scrollTop = 0;
  await new Promise(r => setTimeout(r, 400));
  const allErrors = new Set();
  const eqNums = new Set();
  for (let i = 0; i < 200; i++) {
    window.__scan().forEach(e => allErrors.add(e));
    document.querySelectorAll(".katex-display .katex-html").forEach(el => {
      const t = el.textContent.trimEnd();
      const mm = t.match(/\\(([^()]+)\\)$/);
      if (mm && /^[0-9]+[a-z]?|[A-Z][0-9]*$/.test(mm[1])) eqNums.add(mm[1]);
    });
    const before = sc.scrollTop;
    sc.scrollTop = before + sc.clientHeight * 0.85;
    await new Promise(r => setTimeout(r, 120));
    if (sc.scrollTop === before) break;
  }
  window.__scan().forEach(e => allErrors.add(e));
  return {
    scrollerHeight: sc.scrollHeight,
    errorCount: allErrors.size,
    errors: [...allErrors].slice(0, 5),
    eqNumCount: eqNums.size,
    has50: eqNums.has("50"),
    hasA2: eqNums.has("A2"),
    nums: [...eqNums].join(","),
  };
})()
`;

const { result } = await call("Runtime.evaluate", {
  expression: PAGE_SCRIPT,
  awaitPromise: true,
  returnByValue: true,
});
console.log(JSON.stringify(result.value, null, 2));

// 截图取证
const fs = await import("node:fs");
for (const [label, num] of [["50", "50"], ["A2", "A2"]]) {
  await call("Runtime.evaluate", {
    expression: `(async () => {
      const sc = window.__scroller(); sc.scrollTop = 0;
      await new Promise(r => setTimeout(r, 300));
      for (let i = 0; i < 200; i++) {
        const el = window.__findEq(${JSON.stringify(num)});
        if (el) { el.scrollIntoView({ block: "center" }); await new Promise(r => setTimeout(r, 500)); return "found"; }
        const before = sc.scrollTop;
        sc.scrollTop = before + sc.clientHeight * 0.85;
        await new Promise(r => setTimeout(r, 120));
        if (sc.scrollTop === before) return "not-found";
      }
      return "not-found";
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const shot = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`F:/MyProjects/SageRead/.tmp-eq-${label}.png`, Buffer.from(shot.data, "base64"));
  console.log(`screenshot: .tmp-eq-${label}.png`);
}
ws.close();
