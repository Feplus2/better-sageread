#!/usr/bin/env node
// SageRead Agent 评测 runner v0（UI 驱动，CDP 9223）
// 用法:
//   node evals/runner/run-baseline.mjs --dry --tasks book-locate-ch3,paper-figure-3-rational
//   node evals/runner/run-baseline.mjs --tasks all --repeats 3
// 前置: dev 实例以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 启动（vite 1420）
// 门禁: 旧工具集基线（G1）在 G0 用户过目后运行；--dry 只验证夹具/面板/位置固定，不发消息。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const appRequire = createRequire(path.join(ROOT, "packages/app/package.json"));
const yaml = appRequire("js-yaml");
const TASKS_FILE = path.join(ROOT, "evals/tasks/baseline-10.yaml");
const tasksDoc = yaml.load(fs.readFileSync(TASKS_FILE, "utf8"));

function parseArgs(argv) {
  const out = { tasks: "all", repeats: null, dry: false, keepThreads: false, out: null, docMode: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") out.dry = true;
    else if (a === "--keep-threads") out.keepThreads = true;
    else if (a === "--tasks") out.tasks = argv[++i];
    else if (a === "--repeats") out.repeats = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--doc-mode") out.docMode = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = args.out ? path.resolve(ROOT, args.out) : path.join(ROOT, ".tmp-eval-runs", stamp);
fs.mkdirSync(path.join(outDir, "transcripts"), { recursive: true });

const allTasks = tasksDoc.tasks;
const selected = args.tasks === "all" ? allTasks : allTasks.filter((t) => args.tasks.split(",").map((s) => s.trim()).includes(t.id));
if (selected.length === 0) { console.error("没有匹配的题目: " + args.tasks); process.exit(1); }
const repeats = args.dry ? 1 : (args.repeats || (tasksDoc.harness && tasksDoc.harness.repeats) || 3);
const modelPin = (tasksDoc.harness && tasksDoc.harness.model_pin) || null;
const fixtureMeta = tasksDoc.fixture_meta || {};

function docsForTask(task) {
  const raw = task.docs && task.docs.length > 0 ? task.docs : [task.doc];
  return raw.filter(Boolean).map((d) => {
    const s = String(d);
    const i = s.indexOf(":");
    const kind = s.slice(0, i);
    const id = s.slice(i + 1);
    const meta = fixtureMeta[id] || {};
    return { kind, id, title: meta.title || id };
  });
}

// ---------------- CDP ----------------
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url && t.url.includes("localhost:1420"));
if (!page) { console.error("找不到 SageRead dev 页面（CDP 9223 / localhost:1420）"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); p.resolve(m.result); }
};
function cdp(method, params) {
  const id = ++mid;
  const pr = new Promise((resolve) => pending.set(id, { resolve }));
  ws.send(JSON.stringify({ id, method, params }));
  return pr;
}
async function evalJS(expression, timeoutMs) {
  const timeout = timeoutMs || 480000;
  const r = await Promise.race([
    cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("CDP eval timeout " + timeout)), timeout)),
  ]);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
    throw new Error(d || r.exceptionDetails.text || "page eval error");
  }
  return r.result.value;
}

// ---------------- 页面内执行体（会被 toString 后注入页面） ----------------
async function pageRunner(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const modUrl = (suffix) => {
    const entries = performance.getEntriesByType('resource');
    for (let i = entries.length - 1; i >= 0; i--) {
      const n = entries[i].name;
      if (n.indexOf(suffix) >= 0) return n;
    }
    return new URL(suffix, location.origin).href;
  };
  const result = { ok: false, taskId: cfg.taskId, rep: cfg.rep };
  let openedTabIds = [];
  let before = null;
  let modelBefore = null;
  let settingsStore = null;
  let docModeBefore = null;
  let originalCfi = null;
  let originalView = null;
  try {
    const layout = await import(modUrl('/src/store/layout-store.ts'));
    const provider = await import(modUrl('/src/store/provider-store.ts'));
    const threadSvc = await import(modUrl('/src/services/thread-service.ts'));
    if (cfg.docMode) {
      window.__SAGEREAD_DOC_TOOL_MODE__ = cfg.docMode;
      result.docMode = cfg.docMode;
    }
    const ls = layout.useLayoutStore;
    const st0 = ls.getState();
    before = { activeTabId: st0.activeTabId, tabIds: st0.tabs.map((t) => t.id) };

    if (cfg.modelPin) {
      // 刚启动/刚重载时 provider store 的持久化水合是异步的：等它填好再 pin
      const waitDeadline = Date.now() + 10000;
      while (Date.now() < waitDeadline) {
        const snapshot = provider.useProviderStore.getState();
        if (snapshot.selectedModel && snapshot.modelProviders.length > 0) break;
        await sleep(300);
      }
      const ps = provider.useProviderStore.getState();
      modelBefore = ps.selectedModel ? Object.assign({}, ps.selectedModel) : null;
      if (!modelBefore || modelBefore.providerId !== cfg.modelPin.providerId || modelBefore.modelId !== cfg.modelPin.modelId) {
        const prov = ps.modelProviders.find((p) => p.provider === cfg.modelPin.providerId);
        const mod = prov && (prov.models || []).find((m) => m.id === cfg.modelPin.modelId);
        if (prov && mod) {
          provider.useProviderStore.getState().setSelectedModel({
            providerId: prov.provider, providerName: prov.name, modelId: mod.id, modelName: mod.name || mod.id,
          });
        } else {
          throw new Error('model pin failed: ' + cfg.modelPin.providerId + '/' + cfg.modelPin.modelId);
        }
      }
    }

    for (const d of cfg.docs) {
      const tabId = (d.kind === 'book' ? 'reader-' : 'paper-') + d.id;
      if (before.tabIds.indexOf(tabId) < 0) openedTabIds.push(tabId);
      if (d.kind === 'book') ls.getState().openBook(d.id, d.title);
      else ls.getState().openPaper(d.id, d.title);
      await sleep(400);
    }
    const firstTabId = (cfg.docs[0].kind === 'book' ? 'reader-' : 'paper-') + cfg.docs[0].id;
    ls.getState().activateTab(firstTabId);
    await sleep(400);

    const VIS = (el) => {
      if (!el) return false;
      let n = el;
      while (n) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        n = n.parentElement;
      }
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    };
    const panelSel = cfg.docs[0].kind === 'book' ? '#chat-sidebar' : '#paper-chat-panel';
    const visiblePanel = () => Array.from(document.querySelectorAll(panelSel)).filter(VIS)[0] || null;
    const waitFor = async (fn, timeoutMs, stepMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const v = await fn();
        if (v) return v;
        await sleep(stepMs || 300);
      }
      return null;
    };

    if (cfg.docs[0].kind === 'book') {
      const ready = await waitFor(() => {
        const rs = ls.getState().getReaderStore(firstTabId);
        const s = rs && rs.getState ? rs.getState() : null;
        return s && s.view && s.bookData && s.bookData.bookDoc && s.progress ? s : null;
      }, 60000, 400);
      if (!ready) throw new Error('book reader not ready');
      originalCfi = ready.progress.location || null;
      originalView = ready.view;
      result.readerReady = { progress: ready.progress.sectionLabel, toc: (ready.bookData.bookDoc.toc || []).length };
      if (cfg.positionHeading) {
        const flat = [];
        const walk = (items) => { for (const it of items || []) { flat.push(it); walk(it.subitems); } };
        walk(ready.bookData.bookDoc.toc);
        const want = String(cfg.positionHeading).replace(/\s*(开头|开始)\s*$/, '').trim();
        const item = flat.find((x) => x.label && (String(x.label).trim().indexOf(want) === 0 || want.indexOf(String(x.label).trim()) === 0));
        if (!item) throw new Error('position heading not found: ' + want);
        await ready.view.goTo(item.href);
        const moved = await waitFor(() => {
          const s = ls.getState().getReaderStore(firstTabId).getState();
          return s.progress && String(s.progress.sectionLabel || '').indexOf(want) >= 0 ? s.progress : null;
        }, 20000, 300);
        if (!moved) throw new Error('position pin did not land: ' + want);
        result.position = { label: moved.sectionLabel, cfi: (moved.location || '').slice(0, 80) };
      }
    } else {
      const ready = await waitFor(() => { const p = visiblePanel(); return p && p.querySelector('textarea') ? p : null; }, 60000, 400);
      if (!ready) throw new Error('paper chat panel not ready');
      await sleep(1200);
    }

    let panel = visiblePanel();
    if (!panel) throw new Error('chat panel not visible');
    const plusBtn = () => {
      const p = visiblePanel();
      if (!p) return null;
      return p.querySelector('button:has(svg.lucide-message-circle-plus)') || Array.from(p.querySelectorAll('button')).find((b) => b.querySelector('svg.lucide-message-circle-plus')) || null;
    };
    let plus = plusBtn();
    if (plus) { plus.click(); await sleep(900); }
    let guard = 0;
    while (visiblePanel() && visiblePanel().querySelectorAll('[data-message-id]').length > 0 && guard < 3) {
      const p2 = plusBtn();
      if (p2) { p2.click(); await sleep(900); } else break;
      guard++;
    }
    panel = visiblePanel();
    const remaining = panel ? panel.querySelectorAll('[data-message-id]').length : -1;
    if (remaining !== 0) throw new Error('new thread not empty: ' + remaining);
    result.newThread = true;

    if (cfg.dry) { result.ok = true; result.dry = true; return result; }

    const ta = panel.querySelector('textarea');
    if (!ta) throw new Error('no textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, cfg.prompt);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    const sendAt = Date.now();
    await sleep(800);
    const started = await waitFor(() => {
      const p = visiblePanel();
      if (!p) return null;
      const b = p.querySelector('button[type=submit]');
      const n = p.querySelectorAll('[data-message-id]').length;
      if (n > 0 && b && !b.querySelector('svg')) return true;
      if (n > 1) return true;
      return null;
    }, 25000, 250);
    if (!started) throw new Error('streaming did not start');
    const done = await waitFor(() => {
      const p = visiblePanel();
      if (!p) return null;
      const b = p.querySelector('button[type=submit]');
      const msgs = Array.from(p.querySelectorAll('[data-message-id]'));
      const last = msgs[msgs.length - 1];
      const txt = last ? (last.textContent || '').trim() : '';
      if (b && b.querySelector('svg') && msgs.length >= 2 && txt.length > 5) return { msgs: msgs.length };
      return null;
    }, 420000, 1500);
    if (!done) throw new Error('completion timeout');
    result.elapsedMs = Date.now() - sendAt;
    await sleep(1500);

    let threadId = null;
    if (cfg.docs[0].kind === 'book') {
      const s = ls.getState().getReaderStore(firstTabId).getState();
      threadId = s.currentThread ? s.currentThread.id : null;
    }
    if (!threadId) {
      const latest = await threadSvc.getLatestThreadBybookId(cfg.docs[0].id, 'book');
      threadId = latest ? latest.id : null;
    }
    result.threadId = threadId;
    let thread = null;
    if (threadId) thread = await threadSvc.getThreadById(threadId);
    if (!thread) throw new Error('thread not found');
    result.threadTitle = thread.title;
    const messages = thread.messages || [];
    result.messageCount = messages.length;

    const previewValue = (v) => {
      if (v == null) return null;
      if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + '…' : v;
      let s;
      try { s = JSON.stringify(v); } catch (e) { return String(v); }
      return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
    };
    const toolCalls = [];
    const cleanMessages = [];
    for (const m of messages) {
      const parts = [];
      for (const p of (m.parts || [])) {
        const type = String(p.type || '');
        if (type === 'file') { parts.push({ type: 'file', mediaType: p.mediaType, omitted: true }); continue; }
        if (type.indexOf('tool-') === 0) {
          const name = p.toolName || type.slice(5);
          toolCalls.push({ name, state: p.state || null, input: p.input || null, output: previewValue(p.output) });
          parts.push({ type: 'tool', name, state: p.state || null });
          continue;
        }
        if (type === 'text') { parts.push({ type: 'text', text: p.text }); continue; }
        if (type === 'reasoning') { parts.push({ type: 'reasoning', chars: String(p.text || '').length }); continue; }
        parts.push({ type: type || 'unknown' });
      }
      cleanMessages.push({
        role: m.role,
        parts,
        metadata: {
          provider: m.metadata && m.metadata.provider,
          selectedModel: m.metadata && m.metadata.selectedModel,
          totalUsage: m.metadata && m.metadata.totalUsage,
          createdAt: m.metadata && m.metadata.createdAt,
          updatedAt: m.metadata && m.metadata.updatedAt,
          reasoningTimes: m.metadata && m.metadata.reasoningTimes,
        },
      });
    }
    const assistants = messages.filter((m) => m.role === 'assistant');
    const lastA = assistants[assistants.length - 1];
    result.answer = lastA ? (lastA.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('') : '';
    result.toolCalls = toolCalls;
    result.steps = toolCalls.length;
    result.usage = lastA && lastA.metadata ? lastA.metadata.totalUsage : null;
    result.model = lastA && lastA.metadata ? lastA.metadata.provider : null;
    result.messages = cleanMessages;

    if (!cfg.keepThreads && threadId) {
      try { await threadSvc.deleteThread(threadId); result.threadDeleted = true; }
      catch (e) { result.threadDeleteError = String(e); }
    }
    result.ok = true;
    return result;
  } catch (err) {
    result.ok = false;
    result.error = String(err && err.stack ? err.stack : err);
    return result;
  } finally {
    try {
      const layout = await import(modUrl('/src/store/layout-store.ts'));
      const ls = layout.useLayoutStore;
      if (originalCfi && originalView) {
        try {
          await originalView.goTo(originalCfi);
          await new Promise((r) => setTimeout(r, 1200));
        } catch (e) {}
      }
      for (const tabId of openedTabIds) { try { ls.getState().removeTab(tabId); } catch (e) {} }
      if (before && before.activeTabId) { try { ls.getState().activateTab(before.activeTabId); } catch (e) {} }
      if (modelBefore) {
        const provider = await import(modUrl('/src/store/provider-store.ts'));
        provider.useProviderStore.getState().setSelectedModel(modelBefore);
      }
      try { delete window.__SAGEREAD_DOC_TOOL_MODE__; } catch (e) {}
    } catch (e) { result.cleanupError = String(e); }
  }
}

// ---------------- 主循环 ----------------
const pageRunnerSrc = pageRunner.toString();
const results = [];
async function runOne(task, rep) {
  const payload = {
    taskId: task.id, rep,
    docs: docsForTask(task),
    prompt: task.prompt,
    positionHeading: task.requires && task.requires.position ? task.requires.position : null,
    modelPin, keepThreads: args.keepThreads,
    docMode: args.docMode || null,
    dry: args.dry,
  };
  const expr = "(" + pageRunnerSrc + ")(" + JSON.stringify(payload) + ")";
  const rec = await evalJS(expr, 480000);
  rec.taskId = task.id;
  rec.rep = rep;
  rec.category = task.category;
  results.push(rec);
  const file = path.join(outDir, "transcripts", task.id + "__rep" + rep + ".json");
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  const tag = rec.ok ? (rec.dry ? "DRY-OK" : "OK") : "FAIL";
  const extra = rec.ok
    ? (rec.dry ? "prep " + rec.elapsedPrepMs : "steps=" + rec.steps + " ms=" + rec.elapsedMs + " tokens=" + JSON.stringify(rec.usage && rec.usage.totalTokens))
    : String(rec.error || "").slice(0, 160);
  console.log("[" + tag + "] " + task.id + " rep" + rep + " | " + extra);
  return rec;
}

console.log("runner: out=" + outDir + " tasks=" + selected.length + " repeats=" + repeats + " dry=" + args.dry + " docMode=" + (args.docMode || "current"));
for (const task of selected) {
  for (let rep = 1; rep <= repeats; rep++) {
    try { await runOne(task, rep); }
    catch (e) {
      const rec = { ok: false, taskId: task.id, rep, error: String(e && e.stack ? e.stack : e) };
      results.push(rec);
      fs.writeFileSync(path.join(outDir, "transcripts", task.id + "__rep" + rep + ".json"), JSON.stringify(rec, null, 2));
      console.log("[FAIL] " + task.id + " rep" + rep + " | " + rec.error.slice(0, 200));
    }
  }
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), dry: args.dry, results }, null, 2));
}
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), dry: args.dry, results }, null, 2));
console.log("done: " + path.join(outDir, "results.json"));
ws.close();
process.exit(0);
