// L2 双图探针：验证同一轮两张图都能被模型看见，并观察请求延迟
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) { console.log("FAIL no dev page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m.result); } };
const call = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, { resolve }); ws.send(JSON.stringify({ id, method, params })); });
const result = await call("Runtime.evaluate", { expression: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const modUrl = (suffix) => { const entries = performance.getEntriesByType("resource"); for (let i = entries.length - 1; i >= 0; i--) { if (entries[i].name.indexOf(suffix) >= 0) return entries[i].name; } return new URL(suffix, location.origin).href; };
  const layout = await import(modUrl("/src/store/layout-store.ts"));
  const threadSvc = await import(modUrl("/src/services/thread-service.ts"));
  const provider = await import(modUrl("/src/store/provider-store.ts"));
  const store = provider.useProviderStore;
  for (let i = 0; i < 30; i++) { const s = store.getState(); if (s.selectedModel && s.modelProviders.length > 0) break; await sleep(300); }
  window.__SAGEREAD_IMAGE_BRIDGE_DEBUG__ = true;
  layout.useLayoutStore.getState().openPaper("a27b187c6bd02d3c", "Rational design");
  await sleep(2500);
  const VIS = (el) => { if (!el) return false; let n = el; while (n) { const cs = getComputedStyle(n); if (cs.display === "none" || cs.visibility === "hidden") return false; n = n.parentElement; } const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const visiblePanel = () => Array.from(document.querySelectorAll("#paper-chat-panel")).filter(VIS)[0] || null;
  let panel = visiblePanel();
  if (!panel) return { error: "no panel" };
  const plus = Array.from(panel.querySelectorAll("button")).find((b) => b.querySelector("svg.lucide-message-circle-plus"));
  if (plus) { plus.click(); await sleep(900); }
  panel = visiblePanel();
  const ta = panel.querySelector("textarea");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "请分别调用 readImage 查看这两张图片（A：C:/Users/20995/AppData/Roaming/com.bettersageread.dev/agent-workspace/vision-probe.png；B：C:/Users/20995/AppData/Roaming/com.bettersageread.dev/agent-workspace/vision-probe-2.png），然后分别回答：A 图里的字符串是什么、红色形状是什么？B 图里的字符串是什么、绿色形状是什么？必须基于图片内容，不要猜测。");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < 240000) {
    await sleep(1500);
    const p = visiblePanel();
    if (!p) continue;
    const submit = p.querySelector("button[type=submit]");
    const msgs = Array.from(p.querySelectorAll("[data-message-id]"));
    const last = msgs[msgs.length - 1];
    const txt = last ? (last.textContent || "").trim() : "";
    if (submit && submit.querySelector("svg") && msgs.length >= 2 && txt.length > 5) { done = true; break; }
  }
  await sleep(1500);
  let thread = null;
  try { thread = await threadSvc.getLatestThreadBybookId("a27b187c6bd02d3c", "book"); } catch (e) {}
  const messages = thread ? thread.messages || [] : [];
  const toolCalls = [];
  let answer = "";
  for (const m of messages) for (const p of (m.parts || [])) { if (String(p.type || "").indexOf("tool-") === 0) toolCalls.push({ name: p.toolName || String(p.type).slice(5), input: p.input || null }); if (m.role === "assistant" && p.type === "text") answer += p.text; }
  const assistants = messages.filter((m) => m.role === "assistant");
  const lastA = assistants[assistants.length - 1];
  const usage = lastA && lastA.metadata ? lastA.metadata.totalUsage : null;
  const bridgeLog = (window.__sagereadImageBridgeLog || []).slice(-14);
  const threadJsonLen = thread ? JSON.stringify(thread.messages || []).length : 0;
  const res = { done, elapsedMs: Date.now() - t0, answer, toolCalls, usage, bridgeLog, threadJsonLen };
  if (thread) { try { await threadSvc.deleteThread(thread.id); } catch (e) {} }
  return res;
})()` , awaitPromise: true, returnByValue: true });
if (result.exceptionDetails) { console.error("page error", result.exceptionDetails.text); process.exit(1); }
const out = result.result.value || {};
const ans = String(out.answer || "");
const hasA = ans.includes("SAGEREAD-VISION-42"), hasB = ans.includes("SECOND-IMAGE-77");
const hasRed = /红/.test(ans), hasGreen = /绿/.test(ans);
const reads = (out.toolCalls || []).filter((t) => t.name === "readImage" || (t.name === "useTool" && t.input && t.input.tool === "readImage")).length;
console.log(JSON.stringify({ done: out.done, elapsedMs: out.elapsedMs, reads, hasA, hasB, hasRed, hasGreen, tokens: out.usage && out.usage.totalTokens, threadJsonLen: out.threadJsonLen, answer: ans.slice(0, 500), bridgeLog: out.bridgeLog }, null, 2));
const pass = out.done && reads >= 2 && hasA && hasB && hasRed && hasGreen;
console.log(pass ? "PASS two-image probe" : "FAIL two-image probe");
ws.close();
process.exit(pass ? 0 : 1);