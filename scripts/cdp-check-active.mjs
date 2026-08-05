const LIST_URL = "http://127.0.0.1:9222/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
const res = await call("Runtime.evaluate", {
  expression: `(() => {
    const tabs = [...document.querySelectorAll('[data-region="reader-tabs"] *')].map(e => e.textContent).filter(Boolean).slice(0,0);
    const div = document.querySelector('[data-translation]');
    const prose = [...document.querySelectorAll('.prose')].find(el => el.querySelector('[data-translation]'));
    const readerRoot = prose?.closest('[data-region]');
    let vis = [];
    let p = prose;
    while (p) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden') vis.push(p.tagName + '.' + (p.className||'').toString().slice(0,40)); p = p.parentElement; }
    // 标签栏激活态
    const tabEls = [...document.querySelectorAll('button, [role="tab"], a, div')].filter(e => /论文|书籍/.test(e.textContent||'') && (e.textContent||'').length < 12 && e.dataset);
    const activeInfo = tabEls.filter(e => e.getAttribute('data-state') === 'active' || e.className.includes('active')).map(e => e.textContent.trim()).slice(0, 6);
    return JSON.stringify({
      readerRegion: readerRoot?.getAttribute('data-region'),
      hiddenAncestors: vis,
      proseRect: prose ? JSON.parse(JSON.stringify(prose.getBoundingClientRect())) : null,
      activeTabs: activeInfo,
    });
  })()`,
  returnByValue: true,
});
console.log(res?.result?.value);
ws.close();
process.exit(0);
