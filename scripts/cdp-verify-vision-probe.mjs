// L2 视觉探针：验证模型真的看见了 readImage 返回的图片（合成图，内容已知）
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) { console.log("FAIL no dev page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let mid = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m.result); } };
const call = (method, params) => new Promise((resolve) => { const id = ++mid; pending.set(id, { resolve }); ws.send(JSON.stringify({ id, method, params })); });
const evalJS = async (expr, timeoutMs) => { const r = await Promise.race([call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }), new Promise((res) => setTimeout(() => res({ __timeout: true }), timeoutMs || 240000))]); if (!r || r.__timeout) throw new Error("CDP timeout"); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
const prompt = "请调用 readImage 工具查看这张图片（绝对路径：" + "C:/Users/20995/AppData/Roaming/com.bettersageread.dev/agent-workspace/vision-probe.png" + "），然后如实回答：1) 图中那行字符串是什么？2) 红色形状是什么？3) 蓝色形状是什么？不要凭猜测，必须基于图片内容回答。";
const MODE = process.argv[2] === "legacy" ? "legacy" : (process.argv[2] === "new" ? "new" : "both");
const KEEP_DIRECTORY = process.argv[3] === "keep-directory";
const out = await evalJS(`(async () => {
  window.__SAGEREAD_DOC_TOOL_MODE__ = "${MODE}";
  window.__SAGEREAD_DISABLE_DIRECTORY__ = ${KEEP_DIRECTORY ? "false" : "true"};
  window.__SAGEREAD_IMAGE_BRIDGE_DEBUG__ = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const modUrl = (suffix) => { const entries = performance.getEntriesByType("resource"); for (let i = entries.length - 1; i >= 0; i--) { if (entries[i].name.indexOf(suffix) >= 0) return entries[i].name; } return new URL(suffix, location.origin).href; };
  const layout = await import(modUrl("/src/store/layout-store.ts"));
  const threadSvc = await import(modUrl("/src/services/thread-service.ts"));
  const provider = await import(modUrl("/src/store/provider-store.ts"));
  const store = provider.useProviderStore;
  for (let i = 0; i < 30; i++) { const s = store.getState(); if (s.selectedModel && s.modelProviders.length > 0) break; await sleep(300); }
  const selected = store.getState().selectedModel;
  const before = { activeTabId: layout.useLayoutStore.getState().activeTabId, tabIds: layout.useLayoutStore.getState().tabs.map((t) => t.id) };
  layout.useLayoutStore.getState().openPaper("a27b187c6bd02d3c", "Rational design");
  await sleep(2500);
  const VIS = (el) => { if (!el) return false; let n = el; while (n) { const cs = getComputedStyle(n); if (cs.display === "none" || cs.visibility === "hidden") return false; n = n.parentElement; } const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const visiblePanel = () => Array.from(document.querySelectorAll("#paper-chat-panel")).filter(VIS)[0] || null;
  let panel = visiblePanel();
  if (!panel) return { error: "no paper chat panel" };
  const plus = panel.querySelector("button:has(svg.lucide-message-circle-plus)") || Array.from(panel.querySelectorAll("button")).find((b) => b.querySelector("svg.lucide-message-circle-plus"));
  if (plus) { plus.click(); await sleep(900); }
  panel = visiblePanel();
  const ta = panel.querySelector("textarea");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "请调用 readImage 工具查看这张图片（绝对路径：C:/Users/20995/AppData/Roaming/com.bettersageread.dev/agent-workspace/vision-probe.png），然后如实回答：1) 图中那行字符串是什么？2) 红色形状是什么？3) 蓝色形状是什么？不要凭猜测，必须基于图片内容回答。");
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
    const text = last ? (last.textContent || "").trim() : "";
    if (submit && submit.querySelector("svg") && msgs.length >= 2 && text.length > 5) { done = true; break; }
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
  const bridgeLog = (window.__sagereadImageBridgeLog || []).slice(-12);
  const result = { done, elapsedMs: Date.now() - t0, answer, toolCalls, usage, model: selected && selected.modelId, bridgeLog };
  if (thread) { try { await threadSvc.deleteThread(thread.id); } catch (e) {} }
  delete window.__SAGEREAD_DOC_TOOL_MODE__;
  delete window.__SAGEREAD_DISABLE_DIRECTORY__;
  try { layout.useLayoutStore.getState().removeTab("paper-a27b187c6bd02d3c"); } catch (e) {}
  if (before.activeTabId) { try { layout.useLayoutStore.getState().activateTab(before.activeTabId); } catch (e) {} }
  return result;
})()`);
const ans = String(out.answer || "");
const hasString = ans.includes("SAGEREAD-VISION-42");
const hasTriangle = /三角|triangle/i.test(ans);
const hasCircle = /圆|circle/i.test(ans);
const hasReadImage = (out.toolCalls || []).some((t) => t.name === "readImage" || (t.name === "useTool" && t.input && t.input.tool === "readImage"));
console.log(JSON.stringify({ mode: process.argv[2], keepDirectory: KEEP_DIRECTORY, done: out.done, elapsedMs: out.elapsedMs, hasReadImage, hasString, hasTriangle, hasCircle, tokens: out.usage && out.usage.totalTokens, answer: ans.slice(0, 600), calls: (out.toolCalls || []).map((t) => t.name), bridgeLog: out.bridgeLog }, null, 2));
const pass = out.done && hasReadImage && hasString && hasTriangle && hasCircle;
console.log(pass ? "PASS vision probe" : "FAIL vision probe");
ws.close();
process.exit(pass ? 0 : 1);