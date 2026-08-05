// 一次性验证：无向量能力分支（registry else + prompt 注入段）
const LIST_URL = "http://127.0.0.1:9223/json/list";
const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let mid = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => { const id = ++mid; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };

const expression = `
(async () => {
  const origin = location.origin;
  const regSrc = await (await fetch(origin + "/src/ai/tools/registry.ts")).text();
  const llamaUrl = regSrc.match(new RegExp('"(/src/store/llama-store\\\\.ts[^"]*)"'))[1];
  const registry = await import(origin + "/src/ai/tools/registry.ts");
  const promptMod = await import(origin + "/src/constants/prompt.ts");
  const llama = await import(origin + llamaUrl);
  const st = llama.useLlamaStore.getState();
  const orig = st.hasVectorCapability;
  llama.useLlamaStore.setState({ hasVectorCapability: () => false });
  const rt = registry.getToolsForScope("reader", { bookId: "02fd672f414d0cc3521d433d5fe63093" });
  const prompt = await promptMod.buildReadingPrompt({ agentScope: "reader", activeBookId: "02fd672f414d0cc3521d433d5fe63093" });
  llama.useLlamaStore.setState({ hasVectorCapability: orig });
  return {
    fallbackRegistered: !!rt.readBookSection,
    ragAbsent: !rt.ragSearch && !rt.ragToc,
    promptHasSection: prompt.includes("章节原文直读"),
    promptNoRag: !prompt.includes("RAG 工具使用策略"),
  };
})()
`;

const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.result?.value ?? r, null, 2));
ws.close();
