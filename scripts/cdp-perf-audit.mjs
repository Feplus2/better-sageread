// 性能审计探针：DOM 规模 + KaTeX 公式分布 + 重复渲染检测
// 用途：回答"页面里到底有多少公式、每个公式多少 span、是否存在重复渲染"，
//      为 P3（消息窗口化）的必要性提供量化依据。
// 用法：node scripts/cdp-perf-audit.mjs
// 前提：应用已以 --remote-debugging-port=9222 启动，且已打开目标对话页面
const LIST_URL = "http://127.0.0.1:9222/json/list";

async function waitForPage(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(LIST_URL);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

const page = await waitForPage(30000);
if (!page) {
  console.log("NO_PAGE_FOUND（请确认应用以 --remote-debugging-port=9222 启动）");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) => {
  const mid = ++seq;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve) => pending.set(mid, resolve));
};
const evaluate = async (expression) => {
  const resp = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (resp.result?.exceptionDetails) {
    throw new Error(resp.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return resp.result?.result?.value;
};

await send("Runtime.enable");

const report = await evaluate(`(() => {
  const all = document.querySelectorAll("*");
  const tags = {};
  for (const el of all) tags[el.tagName] = (tags[el.tagName] ?? 0) + 1;
  const topTags = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // KaTeX 公式：每个 .katex 根 = 一个已渲染的公式实例
  const katexRoots = [...document.querySelectorAll(".katex")];
  const spansPer = [];
  const texCount = new Map();
  let katexSpans = 0;
  for (const k of katexRoots) {
    const n = k.querySelectorAll("span").length;
    spansPer.push(n);
    katexSpans += n;
    const ann = k.querySelector("annotation[encoding='application/x-tex']");
    const tex = ann ? ann.textContent.trim() : "";
    if (tex) texCount.set(tex, (texCount.get(tex) ?? 0) + 1);
  }
  spansPer.sort((a, b) => a - b);
  const dups = [...texCount.entries()]
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tex, count]) => ({ count, tex: tex.slice(0, 70) }));

  // 消息维度：每条消息的元素数与公式数
  const msgs = [...document.querySelectorAll("[data-message-id]")];
  const heaviest = msgs
    .map((m) => ({
      id: m.getAttribute("data-message-id").slice(0, 12),
      elements: m.querySelectorAll("*").length,
      katex: m.querySelectorAll(".katex").length,
    }))
    .sort((a, b) => b.elements - a.elements)
    .slice(0, 6);

  // 公式挂载位置定位：按最近可辨识祖先容器分组
  const locate = (el) => {
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      const marker =
        cur.getAttribute("data-region") ||
        cur.id ||
        (cur.getAttribute("data-message-id") ? "msg:" + cur.getAttribute("data-message-id").slice(0, 8) : "");
      if (marker) return \`\${cur.tagName}[\${marker}]\`;
      cur = cur.parentElement;
    }
    return "(无可辨识祖先)";
  };
  const katexLoc = {};
  for (const k of katexRoots) {
    const key = locate(k);
    katexLoc[key] = (katexLoc[key] ?? 0) + 1;
  }
  const katexLocations = Object.entries(katexLoc).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // 顶层区域 DOM 分布（定位 span 聚集地属于哪个面板）
  const regions = [...document.body.children]
    .map((c) => ({
      label: \`\${c.tagName}\${c.id ? "#" + c.id : ""}.\${(c.className || "").toString().split(" ").slice(0, 2).join(".")}\`,
      elements: c.querySelectorAll("*").length,
    }))
    .sort((a, b) => b.elements - a.elements)
    .slice(0, 6);

  return {
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    totalElements: all.length,
    spanTotal: tags.SPAN ?? 0,
    topTags,
    katex: {
      formulaCount: katexRoots.length,
      spanTotal: katexSpans,
      avgSpans: katexRoots.length ? Math.round(katexSpans / katexRoots.length) : 0,
      medianSpans: spansPer.length ? spansPer[Math.floor(spansPer.length / 2)] : 0,
      maxSpans: spansPer.length ? spansPer[spansPer.length - 1] : 0,
      uniqueTex: texCount.size,
      topDups: dups,
    },
    messages: { count: msgs.length, heaviest },
    katexLocations,
    regions,
  };
})()`);

const { katex, messages } = report;
console.log("=== 性能审计报告 ===");
console.log(`页面: ${page.url}`);
console.log(`JS Heap: ${report.heapMB ?? "?"} MB`);
console.log(`DOM 元素总数: ${report.totalElements}（其中 span: ${report.spanTotal}）`);
console.log(`Top 标签: ${report.topTags.map(([t, n]) => `${t}=${n}`).join("  ")}`);
console.log("");
console.log(`--- KaTeX 公式 ---`);
console.log(`公式实例数: ${katex.formulaCount}，公式占 span 总数: ${katex.spanTotal}`);
console.log(`每公式 span 数: avg=${katex.avgSpans} median=${katex.medianSpans} max=${katex.maxSpans}`);
console.log(`去重后唯一 TeX 数: ${katex.uniqueTex}（实例数 ${katex.formulaCount}）`);
if (katex.topDups.length) {
  console.log("重复出现的公式（Top）:");
  for (const d of katex.topDups) console.log(`  x${d.count}  ${d.tex}`);
}
console.log("");
console.log(`--- 消息 ---`);
console.log(`已挂载消息数: ${messages.count}`);
if (messages.heaviest.length) {
  console.log("最重的消息:");
  for (const m of messages.heaviest) console.log(`  ${m.id}  elements=${m.elements}  katex=${m.katex}`);
}
console.log("");
console.log(`--- 公式挂载位置 ---`);
for (const [loc, n] of report.katexLocations) console.log(`  ${loc}  katex=${n}`);
console.log("");
console.log(`--- 顶层区域 DOM 分布 ---`);
for (const r of report.regions) console.log(`  ${r.label}  elements=${r.elements}`);

// 判定提示
console.log("");
if (katex.formulaCount === 0) {
  console.log("判定: 当前页面没有挂载任何 KaTeX 公式。请打开含公式的对话页面后重跑。");
} else if (katex.avgSpans <= 200) {
  console.log(`判定: 每公式平均 ${katex.avgSpans} span 属正常范围 → DOM 规模由公式数量决定，`);
  console.log("      KaTeX 本身无异常，问题在【全量渲染不封顶】（P3/P4 方向成立）。");
} else {
  console.log(`判定: 每公式平均 ${katex.avgSpans} span 异常偏高（正常 10-200）→ 怀疑重复/异常渲染，`);
  console.log("      优先排查渲染管线 bug，而非急着做窗口化。");
}

ws.close();
process.exit(0);
