// L2 四图探针（2026-10-22）：验证「同一批 4 张图」真的能被模型看见并综合。
// 1) 用 Pillow 合成 4 张内容各异的已知图（字符串 + 颜色 + 形状）；
// 2) 在聊天里要求模型一次 viewImages 看全部 4 张（或逐张 readImage 4 次），逐图回答；
// 3) direct（关闭目录牌，工具直挂）与 directory（new 模式强制目录牌，走 useTool + 图片缓存）两条路径。
// 运行：node scripts/cdp-verify-vision-4images.mjs [direct|directory|both]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CDP_LIST = "http://127.0.0.1:9223/json/list";
const MODE = process.argv[2] === "directory" ? "directory" : process.argv[2] === "both" ? "both" : "direct";
const WORKSPACE = (
  process.env.SAGEREAD_AGENT_WORKSPACE ||
  join(
    process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming"),
    "com.bettersageread.dev",
    "agent-workspace",
    "vision-probe-4",
  )
).replace(/\\/g, "/");

const IMAGES = [
  {
    file: "img-1.png",
    code: "ALPHA-731",
    color: "red",
    shape: "triangle",
    colorWord: /红/,
    shapeWord: /三角|triangle/i,
  },
  { file: "img-2.png", code: "BRAVO-264", color: "green", shape: "circle", colorWord: /绿/, shapeWord: /圆|circle/i },
  {
    file: "img-3.png",
    code: "CHARLIE-915",
    color: "blue",
    shape: "square",
    colorWord: /蓝/,
    shapeWord: /正方|方形|square/i,
  },
  {
    file: "img-4.png",
    code: "DELTA-482",
    color: "orange",
    shape: "pentagon",
    colorWord: /橙|橘/,
    shapeWord: /五边|pentagon/i,
  },
];
const PATHS = IMAGES.map((image) => `${WORKSPACE}/${image.file}`);

const PYTHON_SRC = String.raw`
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

spec = json.loads(sys.argv[1])
W, H = 960, 640
font = None
for candidate in [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/seguisb.ttf",
    "C:/Windows/Fonts/consola.ttf",
]:
    if os.path.exists(candidate):
        font = ImageFont.truetype(candidate, 72)
        break
if font is None:
    font = ImageFont.load_default()

COLORS = {
    "red": (214, 40, 40),
    "green": (34, 150, 70),
    "blue": (40, 80, 210),
    "orange": (235, 140, 30),
}

for item in spec["images"]:
    image = Image.new("RGB", (W, H), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    bbox = draw.textbbox((0, 0), item["code"], font=font)
    text_w = bbox[2] - bbox[0]
    draw.text(((W - text_w) // 2, 56), item["code"], fill=(20, 20, 20), font=font)
    color = COLORS[item["color"]]
    cx, cy = W // 2, 390
    shape = item["shape"]
    if shape == "triangle":
        draw.polygon([(cx, cy - 170), (cx - 190, cy + 130), (cx + 190, cy + 130)], fill=color)
    elif shape == "circle":
        draw.ellipse([cx - 180, cy - 180, cx + 180, cy + 180], fill=color)
    elif shape == "square":
        draw.rectangle([cx - 170, cy - 170, cx + 170, cy + 170], fill=color)
    elif shape == "pentagon":
        import math
        pts = []
        for i in range(5):
            angle = math.radians(-90 + i * 72)
            pts.append((cx + 185 * math.cos(angle), cy + 185 * math.sin(angle)))
        draw.polygon(pts, fill=color)
    image.save(item["path"])
    print("wrote", item["path"], image.size, os.path.getsize(item["path"]))
`;

function generateImages() {
  mkdirSync(WORKSPACE, { recursive: true });
  const spec = {
    images: IMAGES.map((image) => ({
      code: image.code,
      color: image.color,
      shape: image.shape,
      path: `${WORKSPACE}/${image.file}`,
    })),
  };
  const pythonCandidates = [process.env.SAGEREAD_PYTHON, "python", "python3"].filter(Boolean);
  let lastError = "";
  for (const python of pythonCandidates) {
    const result = spawnSync(python, ["-c", PYTHON_SRC, JSON.stringify(spec)], { encoding: "utf8" });
    if (result.status === 0) {
      console.log(`[images] ${python} 生成 4 张图：`);
      console.log((result.stdout || "").trim());
      return;
    }
    lastError = (result.stderr || result.error?.message || "").trim();
  }
  throw new Error(`图片生成失败（需要 Python + Pillow）：${lastError}`);
}

function assertImages() {
  for (const image of IMAGES) {
    const path = `${WORKSPACE}/${image.file}`;
    if (!existsSync(path)) throw new Error(`缺少测试图：${path}`);
    if (statSync(path).size < 1000) throw new Error(`测试图过小：${path}`);
  }
}

function makePrompt() {
  return [
    "请查看这 4 张图片（绝对路径）：",
    ...PATHS.map((path, index) => `图${index + 1}：${path}`),
    "",
    "请优先一次调用 viewImages，paths 传这 4 个绝对路径；只有 viewImages 不可用时，才对每张分别调用 readImage。",
    "看完后逐图如实回答：每张图里的字符串是什么？形状是什么颜色、什么形状？",
    "必须基于图片内容回答，不要猜测；4 张都要回答，并标清图号。",
  ].join("\n");
}

const list = await (await fetch(CDP_LIST)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.log("FAIL no dev page");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let mid = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const slot = pending.get(message.id);
  if (slot) {
    pending.delete(message.id);
    slot.resolve(message.result);
  }
};
const call = (method, params) =>
  new Promise((resolve) => {
    const id = ++mid;
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function runOne(profile) {
  const expression = `(async () => {
  const PROMPT = ${JSON.stringify(makePrompt())};
  const DOC_MODE = ${JSON.stringify(profile.docMode)};
  const DISABLE_DIRECTORY = ${profile.disableDirectory};
  window.__SAGEREAD_DOC_TOOL_MODE__ = DOC_MODE;
  window.__SAGEREAD_DISABLE_DIRECTORY__ = DISABLE_DIRECTORY;
  delete window.__sagereadImageBridgeLog;
  delete window.__sagereadLazyImageLog;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const modUrl = (suffix) => { const entries = performance.getEntriesByType("resource"); for (let i = entries.length - 1; i >= 0; i--) { if (entries[i].name.indexOf(suffix) >= 0) return entries[i].name; } return new URL(suffix, location.origin).href; };
  const layout = await import(modUrl("/src/store/layout-store.ts"));
  const threadSvc = await import(modUrl("/src/services/thread-service.ts"));
  const provider = await import(modUrl("/src/store/provider-store.ts"));
  const store = provider.useProviderStore;
  for (let i = 0; i < 30; i++) { const s = store.getState(); if (s.selectedModel && s.modelProviders.length > 0) break; await sleep(300); }
  const selected = store.getState().selectedModel;
  const before = { activeTabId: layout.useLayoutStore.getState().activeTabId };
  layout.useLayoutStore.getState().openPaper("a27b187c6bd02d3c", "Rational design");
  await sleep(2500);
  const VIS = (el) => { if (!el) return false; let n = el; while (n) { const cs = getComputedStyle(n); if (cs.display === "none" || cs.visibility === "hidden") return false; n = n.parentElement; } const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const visiblePanel = () => Array.from(document.querySelectorAll("#paper-chat-panel")).filter(VIS)[0] || null;
  let panel = visiblePanel();
  if (!panel) return { error: "no paper chat panel" };
  const plus = Array.from(panel.querySelectorAll("button")).find((b) => b.querySelector("svg.lucide-message-circle-plus"));
  if (plus) { plus.click(); await sleep(900); }
  panel = visiblePanel();
  const ta = panel.querySelector("textarea");
  if (!ta) return { error: "no textarea" };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, PROMPT);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < 480000) {
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
  const toolFileParts = [];
  const toolOutputs = [];
  let answer = "";
  let bridgeLog = (window.__sagereadImageBridgeLog || []).slice(-16);
  const lazyLog = (window.__sagereadLazyImageLog || []).slice(-8);
  for (const m of messages) for (const p of (m.parts || [])) {
    if (String(p.type || "").indexOf("tool-") === 0) {
      toolCalls.push({ name: p.toolName || String(p.type).slice(5), input: p.input || null });
      const output = p.output;
      if (output && typeof output === "object") {
        const value = Array.isArray(output.value) ? output.value : [];
        for (const part of value) if (part && part.type === "file") toolFileParts.push({ mediaType: part.mediaType, urlLen: String(part.url || "").length });
        const toolName = p.toolName || String(p.type).slice(5);
        // 只留图片通道相关输出（describeTool 的说明书太长，对证据无意义）
        if (toolName === "readImage" || toolName === "viewImages" || toolName === "useTool") {
          toolOutputs.push({ name: toolName, preview: JSON.stringify(output).slice(0, 900) });
        }
      }
    }
    if (m.role === "assistant" && p.type === "text") answer += p.text;
  }
  const assistants = messages.filter((m) => m.role === "assistant");
  const lastA = assistants[assistants.length - 1];
  const usage = lastA && lastA.metadata ? lastA.metadata.totalUsage : null;
  const threadJson = thread ? JSON.stringify(thread.messages || []) : "";
  const threadJsonLen = threadJson.length;
  const threadHasBase64 = threadJson.includes("data:image/");
  const result = { done, elapsedMs: Date.now() - t0, answer, toolCalls, toolFileParts, toolOutputs, usage, model: selected && selected.modelId, bridgeLog, lazyLog, threadJsonLen, threadHasBase64, docMode: DOC_MODE, disableDirectory: DISABLE_DIRECTORY };
  if (thread) { try { await threadSvc.deleteThread(thread.id); } catch (e) {} }
  delete window.__SAGEREAD_DOC_TOOL_MODE__;
  delete window.__SAGEREAD_DISABLE_DIRECTORY__;
  try { layout.useLayoutStore.getState().removeTab("paper-a27b187c6bd02d3c"); } catch (e) {}
  if (before.activeTabId) { try { layout.useLayoutStore.getState().activateTab(before.activeTabId); } catch (e) {} }
  return result;
})()`;
  const result = await Promise.race([
    call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 540000)),
  ]);
  if (!result || result.__timeout) throw new Error("CDP timeout");
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "page exception");
  }
  return result.result.value || {};
}

/** 取「图N」到下一个图号之间的段落（模型回答常见多行项目符号，不能只看同一行） */
function sectionAroundFigure(answer, figureNo) {
  const text = String(answer);
  const marker = new RegExp(`图(?:片)?\\s*${figureNo}(?!\\d)`);
  const matched = marker.exec(text);
  if (!matched) return null;
  const start = matched.index;
  const rest = /图(?:片)?\s*\d+/g;
  rest.lastIndex = start + matched[0].length;
  const next = rest.exec(text);
  const end = next ? next.index : Math.min(text.length, start + 400);
  return text.slice(start, Math.max(end, start + 60));
}

function mappingOk(answer, figureNo, code, colorWord, shapeWord) {
  const text = String(answer);
  const scopes = [];
  const section = sectionAroundFigure(text, figureNo);
  if (section) scopes.push(section);
  scopes.push(...text.split(/\n+/).filter((line) => line.includes(code)));
  const codeIndex = text.indexOf(code);
  if (codeIndex >= 0) scopes.push(text.slice(Math.max(0, codeIndex - 120), codeIndex + 260));
  return scopes.some((scope) => scope.includes(code) && colorWord.test(scope) && shapeWord.test(scope));
}

function judge(out) {
  const answer = String(out.answer || "");
  const calls = out.toolCalls || [];
  const forwarded = (name) =>
    calls.filter((c) => c.name === name || (c.name === "useTool" && c.input && c.input.tool === name));
  const viewCalls = forwarded("viewImages");
  const argsOf = (call) => (call.name === "useTool" ? (call.input?.args ?? {}) : (call.input ?? {}));
  const viewPaths = new Set();
  for (const call of viewCalls) {
    const paths = Array.isArray(argsOf(call).paths) ? argsOf(call).paths : [];
    for (const path of paths) viewPaths.add(String(path).replace(/\\/g, "/").toLowerCase());
  }
  const readCalls = forwarded("readImage");
  const allPathsViewed = PATHS.every((path) => viewPaths.has(path.toLowerCase()));
  const batch4 = viewCalls.some((call) => Array.isArray(argsOf(call).paths) && argsOf(call).paths.length === 4);
  const codes = IMAGES.map((image) => answer.includes(image.code));
  const mappings = IMAGES.map((image, index) =>
    mappingOk(answer, index + 1, image.code, image.colorWord, image.shapeWord),
  );
  const viewedAll = allPathsViewed || readCalls.length + viewCalls.length >= 4;
  const pass = Boolean(out.done) && viewedAll && codes.every(Boolean) && mappings.every(Boolean);
  return {
    pass,
    batch4,
    allPathsViewed,
    viewCalls: viewCalls.length,
    readCalls: readCalls.length,
    codes,
    mappings,
    viewedAll,
  };
}

generateImages();
assertImages();
console.log(`[images] 工作区：${WORKSPACE}`);
for (const image of IMAGES) console.log(`  ${image.file}  ${image.code} / ${image.color} ${image.shape}`);

const profiles =
  MODE === "both"
    ? [
        { label: "direct", docMode: "both", disableDirectory: true },
        { label: "directory", docMode: "new", disableDirectory: false },
      ]
    : MODE === "directory"
      ? [{ label: "directory", docMode: "new", disableDirectory: false }]
      : [{ label: "direct", docMode: "both", disableDirectory: true }];

const results = [];
for (const profile of profiles) {
  console.log(`\n[probe] ${profile.label}：docMode=${profile.docMode} disableDirectory=${profile.disableDirectory}`);
  const out = await runOne(profile);
  if (out.error) {
    console.log(`FAIL ${profile.label}: ${out.error}`);
    results.push({ profile: profile.label, pass: false, error: out.error });
    continue;
  }
  const verdict = judge(out);
  const summary = {
    profile: profile.label,
    pass: verdict.pass,
    done: out.done,
    elapsedMs: out.elapsedMs,
    model: out.model,
    tokens: out.usage?.totalTokens,
    viewCalls: verdict.viewCalls,
    readCalls: verdict.readCalls,
    batch4: verdict.batch4,
    allPathsViewed: verdict.allPathsViewed,
    codes: verdict.codes,
    mappings: verdict.mappings,
    toolCalls: (out.toolCalls || []).map((c) => c.name + (c.input?.tool ? `->${c.input.tool}` : "")),
    toolFileParts: out.toolFileParts,
    threadJsonLen: out.threadJsonLen,
    threadHasBase64: out.threadHasBase64,
    bridgeLog: (out.bridgeLog || []).filter(
      (line) => line.startsWith("plan:") || line.startsWith("done:") || line.startsWith("flush:"),
    ),
    lazyLog: out.lazyLog,
    toolOutputs: out.toolOutputs,
    answer: String(out.answer || "").slice(0, 1200),
  };
  console.log(JSON.stringify(summary, null, 2));
  results.push({ profile: profile.label, pass: verdict.pass, batch4: verdict.batch4, elapsedMs: out.elapsedMs });
}

ws.close();
const pass = results.length > 0 && results.every((r) => r.pass);
console.log(`\n${pass ? "PASS vision 4-image probe" : "FAIL vision 4-image probe"}`);
process.exit(pass ? 0 : 1);
