// E2E 冒烟：聊天消息公式渲染（prompt-kit/markdown.tsx 接入 remark-math + rehype-katex）+ 提示词检索策略
//   1) Markdown 组件渲染 $E=mc^2$ → .katex 存在；$$…$$ → .katex-display 存在
//   2) 公式内的 [1] 不被吞成引用标注（KaTeX 逐符号分片天然规避）
//   3) 论文提示词含「检索策略」节；reader 系统技能含「查询构造」（v2.3 迁移已验证生效）
// 运行：node scripts/cdp-test-math-render.mjs（需 dev 实例 CDP 9223）
const LIST_URL = "http://127.0.0.1:9223/json/list";

const pages = await (await fetch(LIST_URL)).json();
const page = pages.find((p) => p.type === "page" && p.url?.includes("localhost:1420"));
if (!page) throw new Error("找不到 SageRead 页面（9223 CDP 未连接或未以调试端口启动）");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let mid = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function cdp(method, params = {}) {
  const id = ++mid;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

const expression = `
(async () => {
  const checks = [];
  const check = (name, pass, info) => checks.push({ name, pass: !!pass, info: info == null ? "" : String(info) });
  const origin = location.origin;

  // ---- 1/2. 公式渲染 ----
  const md = await import(origin + "/src/components/prompt-kit/markdown.tsx");
  const ReactNS = await import(origin + "/@id/react");
  const ReactDomNS = await import(origin + "/@id/react-dom");
  const ReactDomClientNS = await import(origin + "/@id/react-dom/client");
  // vite 对 CJS 依赖的 /@id/ 包装：命名导出可能被折进 default
  const createElement = (ReactNS.createElement ?? ReactNS.default.createElement).bind(ReactNS.default ?? ReactNS);
  const flushSync = ReactDomNS.flushSync ?? ReactDomNS.default.flushSync;
  const createRoot = ReactDomClientNS.createRoot ?? ReactDomClientNS.default.createRoot;

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-9999px;top:0;width:600px";
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(createElement(md.Markdown, null,
      "行内公式 $E=mc^2$ 与矩阵元 $x[1]$ 测试。\\n\\n$$\\\\int_0^1 x^2\\\\,dx = \\\\frac{1}{3}$$"));
  });

  const katexCount = host.querySelectorAll(".katex").length;
  const displayCount = host.querySelectorAll(".katex-display").length;
  check("行内公式渲染为 .katex", katexCount >= 2, "katex=" + katexCount);
  check("行间公式渲染为 .katex-display", displayCount === 1, "display=" + displayCount);
  // 引用标注组件（AnnotationMark）的特征是 AnnotationPopover 触发的圆角 chip；公式内 [1] 不应变成 chip
  const chipCount = host.querySelectorAll(".rounded-full.bg-muted").length;
  check("公式内 [1] 未被吞成引用标注", chipCount === 0, "chips=" + chipCount);
  const katexText = host.querySelector(".katex")?.textContent || "";
  check("行内公式内容正确", katexText.includes("E=mc"), katexText.slice(0, 30));
  root.unmount();
  host.remove();

  // ---- 3. 提示词检索策略 ----
  const paperPrompt = await import(origin + "/src/constants/paper-prompt.ts");
  const built = await paperPrompt.buildPaperPrompt({ agentScope: "paper" });
  check("论文提示词: 含检索策略节", built.includes("—— 检索策略 ——"), "");
  check("论文提示词: 含语言对齐/拆分指引", built.includes("英文术语") && built.includes("2-3 个不同措辞"), "");

  const skillSvc = await import(origin + "/src/services/skill-service.ts");
  const skills = await skillSvc.getSkills();
  const sys = skills.find((s) => s.isSystem);
  check("reader 系统提示词: 含查询构造（v2.3）", (sys?.content || "").includes("查询构造"), "");
  check("reader 系统提示词: 含文件工具节（v2.2）", (sys?.content || "").includes("文件工具（笔记整理落盘）"), "");

  return checks;
})()
`;

const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
const checks = result.result?.result?.value;
if (!Array.isArray(checks)) {
  console.error("页面上下文执行失败:", JSON.stringify(result).slice(0, 800));
  process.exit(1);
}

let pass = 0;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.info ? "  | " + c.info : ""}`);
  if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} PASS`);
ws.close();
process.exit(pass === checks.length ? 0 : 1);
