// 干净环境下复测：条目 5/9/15 的 S2 补全 + 条目 15 的下载链路
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const call = (m, p) => { let r; const pr = new Promise((res) => (r = res)); pending.set(++mid, { r }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); return pr; };
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id).r(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const evalJS = async (expression) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面可能刚重启过，先确认 layout store 可用
await evalJS(`import("/src/store/layout-store.ts").then((m) => { window.__layout = m; }); "ok"`);
for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJS(`!!window.__layout`).catch(() => false)) break; }

// 1) S2 补全直测（条目 5/9/15 的 arxiv_id）
const enrich = await evalJS(`(async () => {
  const svc = await import('/src/services/paper-reference-service.ts');
  const out = [];
  for (const ax of ['hep-th/0312007', 'astro-ph/9607130', '1002.0652']) {
    try {
      const r = await svc.enrichReference({ n: 0, raw: '', arxiv_id: ax });
      out.push({ ax, ok: !!r, source: r?.source, title: (r?.title ?? '').slice(0, 60) });
    } catch (e) { out.push({ ax, ok: false, error: String((e && e.message) || e).slice(0, 120) }); }
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  return out;
})()`);
console.log("S2 补全:", JSON.stringify(enrich, null, 1));

// 2) 条目 15 下载链路直测
await evalJS(`(async () => {
  const m = await import('/src/ai/mcp/mcp-manager.ts');
  const server = m.findZoteroBrainServer();
  window.__dl = (async () => {
    try {
      const raw = await m.callMcpServerTool(server, 'download_paper', { arxiv_id: '1002.0652', title: '' });
      return { ok: true, parsed: m.parseMcpToolJson(raw) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  })();
  return 'fired';
})()`);
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  await evalJS(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /允许|确认/.test(x.textContent ?? '') && x.closest('[role="dialog"], [role="alertdialog"]'));
    if (b) b.click();
    return !!b;
  })()`).catch(() => false);
  const st = await evalJS(`(async () => {
    const p = window.__dl; if (!p) return null;
    let done = false; let val;
    p.then((v) => { done = true; val = v; });
    await Promise.race([p, new Promise((r) => setTimeout(r, 50))]);
    return done ? val : null;
  })()`);
  if (st) { console.log("下载:", JSON.stringify(st)); break; }
}
ws.close();
console.log("done");
