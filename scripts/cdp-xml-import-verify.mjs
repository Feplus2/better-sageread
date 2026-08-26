// 卡 6 验收 CDP 实盘：XML 拖入链路（经 startPaperImportBatch 等价入口——原生 drop 事件
// 无法经 CDP 合成，其扩展名过滤逻辑为纯前端代码路径已随实现核对；本脚本走同一入口
// startPaperImportBatch，全链路：task-center 队列 → Rust convert_paper_pdf → sidecar exe
// XML 分派 → 落库 → 阅读器渲染核验）。
// 步骤：
//  0) #/papers 页 + 引擎 token 预检
//  1) startPaperImportBatch([jats_mathml_sample.xml]) → 轮询 paper-parse 通道结算
//  2) 断言：任务 success；结果 outcome=imported；阶段名含「XML 解析」
//  3) listPapers 找到新篇（标题前缀 Interfacial kinetics）→ openPaper 开 tab
//  4) 阅读器渲染核验：# Introduction 标题、$$ 公式（\tag{1}）、图 images/fig1.png、
//     参考文献锚点 ref-1；截图留档
//  5) references.json 落库核验（books/{id}/references.json，Node 侧读）
//  6) 还原：关 paper tab、回原 hash（导入的论文留在库中供用户验收，不做删除——dev 数据禁删）
// 用法：node scripts/cdp-xml-import-verify.mjs
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const LIST_URL = "http://127.0.0.1:9223/json/list";
const page = (await (await fetch(LIST_URL)).json()).find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.error("no page");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (m, p = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
await call("Page.enable");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expression) => {
  const res = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res?.exceptionDetails)
    return `EXC: ${JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)}`;
  return res?.result?.value;
};
const shot = async (name) => {
  const res = await call("Page.captureScreenshot", { format: "png" });
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(".tmp-motion-verify", { recursive: true });
  writeFileSync(`.tmp-motion-verify/${name}.png`, Buffer.from(res.data, "base64"));
  return name;
};
const pollUntil = async (fn, timeout = 30000, step = 300) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return null;
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// HMR 版本串感知的动态 import（CDP 三坑之一）
const pageImport = (modulePath, binding) =>
  evalJs(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("${modulePath}")) ?? "${modulePath}";
    const m = await import(url);
    return typeof ${binding} === "string" ? m[${JSON.stringify(binding)}] : m;
  })()`);

const XML_PATH = "F:\\MyProjects\\Papers_Converter\\data\\xml_fixtures\\jats_mathml_sample.xml";
const TITLE_PREFIX = "Interfacial kinetics";

// ---------- 0) 就位（reload 拿最新模块——执行器 terminated 守卫修复经重载生效） ----------
await call("Page.reload");
await pollUntil(
  () => evalJs(`!!document.querySelector('[data-region="app-main"]')`).then((v) => (v === true ? "y" : null)),
  20000,
  500,
);
await evalJs(`location.hash = "#/papers"`);
await sleep(1200);
const engineOk = await evalJs(`(async () => {
  const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/converter-store")) ?? "/src/store/converter-store";
  const m = await import(url);
  return JSON.stringify({ engine: m.useConverterStore.getState().paperEngine });
})()`);
console.log("engine:", engineOk);
await shot("b6-00-papers-page");

// ---------- 1) 发起导入（与拖入 drop / 菜单导入同一入口） ----------
const initialHash = "#/papers";
const startRes = await evalJs(`(async () => {
  const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/convert-progress-store")) ?? "/src/store/convert-progress-store";
  const m = await import(url);
  await m.startPaperImportBatch(["${XML_PATH.replace(/\\/g, "\\\\")}"]);
  return "started";
})()`);
console.log("import:", startRes);

// ---------- 2) 轮询通道结算 ----------
const settleInfo = await pollUntil(
  () =>
    evalJs(`(async () => {
      const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/task-center-store")) ?? "/src/store/task-center-store";
      const m = await import(url);
      const st = m.useTaskCenterStore.getState();
      const tasks = Object.values(st.tasks).filter((t) => t.channel === "paper-parse" && t.startedAt);
      if (tasks.length === 0) return null;
      const t = tasks.at(-1);
      if (t.status === "running" || t.status === "queued") return null;
      return JSON.stringify({ status: t.status, error: t.error ?? null, result: t.result ?? null, title: t.title,
        stageNames: (t.extra?.stages ?? []).map((s) => s.name) });
    })()`),
  90000,
  500,
);
let settle = null;
try {
  settle = JSON.parse(settleInfo ?? "null");
} catch {
  settle = { raw: settleInfo };
}
check("1 XML 任务结算 success", settle?.status === "success", settleInfo ?? "timeout");
check("2 结果 outcome=imported（重跑同内容为 skipped=去重语义实证）", settle?.result?.outcome === "imported" || settle?.result?.outcome === "skipped", JSON.stringify(settle?.result ?? null));
check("3 阶段名跟随（stage1 = XML 解析）", Array.isArray(settle?.stageNames) && settle.stageNames[0] === "XML 解析",
  JSON.stringify(settle?.stageNames));
await shot("b6-01-task-settled");

// ---------- 3) 落库 + 开 tab ----------
const paperInfo = await pollUntil(
  () =>
    evalJs(`(async () => {
      const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/services/paper-service")) ?? "/src/services/paper-service";
      const m = await import(url);
      const papers = await m.listPapers();
      const hit = papers.find((p) => (p.title ?? "").startsWith("${TITLE_PREFIX}"));
      return hit ? JSON.stringify({ id: hit.id, title: hit.title }) : null;
    })()`),
  15000,
  500,
);
const paper = JSON.parse(paperInfo ?? "null");
check("4 落库可见（listPapers 命中）", !!paper, paperInfo ?? "not-found");

if (paper) {
  const opened = await evalJs(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/layout-store")) ?? "/src/store/layout-store";
    const m = await import(url);
    m.useLayoutStore.getState().openPaper("${paper.id}", "${paper.title.slice(0, 40).replace(/"/g, "")}");
    return "opened";
  })()`);
  console.log("open:", opened);
  await sleep(2500);

  // ---------- 4) 阅读器渲染核验 ----------
  // 滚到文末（paper-reader 懒渲染：图块滚入视口才挂 img），再采渲染证据
  await evalJs(`(() => {
    const layer = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"]');
    const sc = layer?.querySelector('[class*="overflow-y"], [class*="overflow-auto"]') ?? layer ?? document.body;
    sc.scrollTop = sc.scrollHeight;
    return "scrolled:" + sc.scrollTop;
  })()`);
  await sleep(900);
  const render = await evalJs(`(() => {
    const layer = document.querySelector('main.overflow-clip > .tab-layer[data-active="true"]');
    if (!layer) return JSON.stringify({ err: "no-layer" });
    const text = layer.textContent ?? "";
    const md = layer.querySelector("article, [data-region='paper-reader'], .paper-reader");
    const html = layer.innerHTML;
    return JSON.stringify({
      headings: [...layer.querySelectorAll("h1,h2,h3")].map((h) => h.textContent.trim()).slice(0, 8),
      hasFormula: html.includes("tag{1}") || html.includes("tag\\{1\\}") || /\\$\\$/.test(text) || !!layer.querySelector(".katex, [class*='math']"),
      // 图片经 Tauri fs 读成 blob URL，原始相对路径在 data-paper-src（scrollToImage 锚）
      hasImg: [...layer.querySelectorAll("img[data-paper-src]")].filter((i) => (i.dataset.paperSrc ?? "").includes("images/")).length,
      hasRefAnchor: !!layer.querySelector('#ref-1, a[id="ref-1"]'),
      introPresent: text.includes("Introduction"),
    });
  })()`);
  const r = JSON.parse(render);
  check("5 目录标题渲染（Introduction/Experimental）", (r.headings ?? []).some((h) => h.includes("Introduction")) && (r.headings ?? []).some((h) => h.includes("Experimental")), JSON.stringify(r.headings));
  check("6 公式渲染（\\tag{1} / 数学区）", r.hasFormula === true, JSON.stringify(r));
  check("7 图片落盘渲染（images/ 引用）", (r.hasImg ?? 0) >= 1, `imgs=${r.hasImg}`);
  check("8 参考文献锚点 ref-1", r.hasRefAnchor === true, String(r.hasRefAnchor));
  await shot("b6-02-paper-reader");

  // ---------- 5) references.json 落库核验（Node 侧） ----------
  const devData = "C:/Users/20995/AppData/Roaming/com.bettersageread.dev";
  const refPath = join(devData, "books", paper.id, "references.json");
  let refs = null;
  if (existsSync(refPath)) {
    try {
      refs = JSON.parse(readFileSync(refPath, "utf-8"));
    } catch {}
  }
  const refDoi = refs?.references?.find((x) => x.doi)?.doi;
  check("9 references.json 落库（source=xml，4 条，element-citation DOI 结构化）",
    refs?.source === "xml" && refs?.count === 4 && refDoi === "10.1016/j.joule.2018.11.011",
    refs ? `source=${refs.source} count=${refs.count} doi=${refDoi}` : `missing: ${refPath}`);

  // ---------- 6) 还原：关 tab 回原页（导入的论文保留供用户验收——dev 数据禁删） ----------
  await evalJs(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/store/layout-store")) ?? "/src/store/layout-store";
    const m = await import(url);
    const S = m.useLayoutStore.getState();
    const tab = S.tabs.find((t) => t.id === "paper-${paper.id}");
    if (tab) { S.removeTab("paper-${paper.id}"); }
    S.navigateToHome();
    return "restored";
  })()`);
}

await evalJs(`location.hash = ${JSON.stringify(initialHash)}`);
await sleep(600);
await shot("b6-99-restored");

console.log("\n===== SUMMARY =====");
for (const r of results) console.log(r);
ws.close();
process.exit(0);
