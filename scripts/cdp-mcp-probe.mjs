// 探针：经 app 真实链路直调 zotero-brain download_paper，分离「垃圾输入」vs「网络不通」
// 用法：node scripts/cdp-mcp-probe.mjs（dev 实例 CDP 9223）
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
const evalJS = async (expr, timeout) => {
  const r = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 确认 server 可见
console.log("server:", await evalJS(`(async () => {
  const m = await import('/src/ai/mcp/mcp-manager.ts');
  const s = m.findZoteroBrainServer();
  return s ? { name: s.name, command: s.command, dir: (s.args||[]).join(' ') } : null;
})()`));

// 发起调用（不 await，先挂到 window），轮询处理 stdio 启动确认卡
const fire = (key, args) => evalJS(`(async () => {
  const m = await import('/src/ai/mcp/mcp-manager.ts');
  const server = m.findZoteroBrainServer();
  window[${JSON.stringify(key)}] = (async () => {
    try {
      const raw = await m.callMcpServerTool(server, 'download_paper', ${JSON.stringify(args)});
      return { ok: true, parsed: m.parseMcpToolJson(raw) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  })();
  return 'fired';
})()`);

const waitResult = async (key, maxMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    // 有启动确认卡就点允许
    await evalJS(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find((x) => /允许|确认|启动|同意/.test(x.textContent ?? '') && x.closest('[role="dialog"], [data-radix-popper-content-wrapper], .fixed'));
      if (b) b.click();
      return !!b;
    })()`).catch(() => false);
    const st = await evalJS(`(async () => {
      const p = window[${JSON.stringify(key)}];
      if (!p) return null;
      let done = false; let val;
      p.then((v) => { done = true; val = v; });
      await Promise.race([p, new Promise((r) => setTimeout(r, 50))]);
      return done ? val : null;
    })()`);
    if (st) return st;
    await sleep(2000);
  }
  return { timeout: true };
};

const probes = process.argv[2]
  ? JSON.parse(process.argv[2])
  : [
      ["探针1：forecast ref[3] 的垃圾 title（复现用户输入）", { title: "[3] S. Sarangi and S. H. H. Tye, Phys. Lett. B 536, 185 (2002) [arXiv:" }],
      ["探针2：干净 arXiv 输入（Attention Is All You Need）", { title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762" }],
    ];
for (let i = 0; i < probes.length; i++) {
  const [label, args] = probes[i];
  console.log(`--- ${label} ---`);
  const key = `__p${i}`;
  await fire(key, args);
  console.log(JSON.stringify(await waitResult(key, 200000)));
}

ws.close();
console.log("done");
