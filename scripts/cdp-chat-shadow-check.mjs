// /chat 页阴影复核：切到 /chat → 截图 + 量 ChatPage 卡片几何（应 == app-main 内缩 4px，且层上 shadow-around 在内层 div）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) throw new Error("未找到 dev 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
};
await new Promise((r) => (ws.onopen = r));
const call = (m, p = {}) =>
  new Promise((r) => {
    const i = ++mid;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
const evalJS = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? "eval 失败").slice(0, 300));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 记住原路径，验证后还原
const origHash = await evalJS(`location.hash`);
await evalJS(`location.hash = "#/chat"; ""`);
await sleep(600); // 等交叉淡入播完

const geo = await evalJS(`(() => {
  const main = document.querySelector('[data-region="app-main"]').getBoundingClientRect();
  const chatLayer = document.querySelector('[data-region="app-main"] > .tab-layer[data-active="true"]');
  const card = chatLayer?.querySelector(':scope > div')?.getBoundingClientRect();
  const shadowOwner = chatLayer?.querySelector(':scope > div')?.className ?? "";
  return {
    main: [main.x, main.y, main.width, main.height].map(Math.round),
    card: card ? [card.x, card.y, card.width, card.height].map(Math.round) : null,
    shadowOnInner: shadowOwner.includes("shadow-around"),
    shadowNotOnLayer: !chatLayer.className.includes("shadow-around"),
  };
})()`);
console.log("几何:", JSON.stringify(geo, null, 2));
const insetOk = geo.card && geo.card[0] - geo.main[0] === 4 && geo.card[1] - geo.main[1] === 4
  && geo.main[2] - geo.card[2] === 8 && geo.main[3] - geo.card[3] === 8;
console.log(insetOk && geo.shadowOnInner && geo.shadowNotOnLayer ? "ok - /chat 卡片内缩 4px 且阴影在内层" : "FAIL - 结构不等价");

const shot = await call("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
writeFileSync(".tmp-motion-verify/b3-chat-shadow-fix.png", Buffer.from(shot.data, "base64"));
console.log("saved .tmp-motion-verify/b3-chat-shadow-fix.png");

await evalJS(`location.hash = ${JSON.stringify(origHash)}; ""`);
ws.close();
process.exit(0);
