// 上下文经济性审计：实测某 scope 单条请求的 system prompt 构成与布局（D1/D3 验证用）
// 用法：node scripts/cdp-context-audit.mjs [bookId]（dev 实例 CDP 9223）
// 断言：①无【语义上下文】；②静态优先顺序（metadata 在 工作区/记忆 之前，动态段最尾）；
//       ③工具 schema 体积（P4 目录牌的前后对比基准）
const bookId = process.argv[2] || "210b093441669653de55a5109238fc67";
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.error("未找到应用页面（localhost:1420）——dev 实例未启动或 CDP 口不对");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
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
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 90000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

const expr = `(async () => {
  const out = { fails: [] };
  // 1) system prompt 三段（含 transport 尾部的动态状态段——直接复刻 transport 组装顺序）
  const promptMod = await import('/src/constants/prompt.ts');
  const sys = await promptMod.buildPrompt({ activeBookId: '${bookId}', activeSectionLabel: '第三章·二节', agentScope: 'reader' });
  const wsCtx = await import('/src/ai/utils/workspace-context.ts');
  const workspace = await wsCtx.loadWorkspaceSection('reader');
  const memory = await wsCtx.loadMemorySection('reader');
  const tct = await import('/src/ai/custom-chat-transport.ts');
  // transport 未导出 buildDynamicStateSection，直接内联同款拼装模拟完整 system
  const llama = await import('/src/store/llama-store.ts');
  out.hasVectorCapability = llama.useLlamaStore.getState().hasVectorCapability();
  const full = sys + workspace + memory + '\\n\\n【当前阅读章节】\\n第三章·二节';
  out.systemPromptChars = sys.length;
  out.fullSystemChars = full.length;
  // 布局断言（D3 静态优先）
  const idx = (m) => full.indexOf(m);
  const marks = ['【当前阅读图书元信息与目录】', '—— 当前工作区 ——', '【长期记忆 memory.md】', '【当前阅读章节】'];
  const positions = marks.map(idx);
  out.sectionPositions = Object.fromEntries(marks.map((m, i) => [m, positions[i]]));
  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1];
    const cur = positions[i];
    // 允许 -1（段缺位，如无 memory.md），存在者必须严格递增
    if (cur !== -1 && prev !== -1 && cur < prev) out.fails.push('布局乱序: ' + marks[i]);
  }
  // D1 断言：语义上下文彻底消失
  if (full.includes('【语义上下文】') || sys.includes('语义上下文')) out.fails.push('D1: 语义上下文残留');
  // 基词断言（DB 技能内容，migration v2.5 后应无该行）
  const skillMod = await import('/src/services/skill-service.ts');
  const skills = await skillMod.getSkills();
  const base = (skills.find((s) => s.isSystem && s.isActive) || {}).content || '';
  out.baseSkillChars = base.length;
  if (base.includes('【语义上下文】')) out.fails.push('D1: DB 基词仍含【语义上下文】行（migration v2.5 未生效？）');
  // 2) 工具 schema（P4 前基准）
  const reg = await import('/src/ai/tools/registry.ts');
  const tools = reg.getToolsForScope('reader', { bookId: '${bookId}' });
  let total = 0;
  for (const [, t] of Object.entries(tools)) total += JSON.stringify({ d: t.description, p: t.inputSchema }).length;
  out.builtinToolCount = Object.keys(tools).length;
  out.builtinToolsTotalChars = total;
  return out;
})()`;

const res = await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
ws.close();
const out = res.result?.result?.value;
if (!out) {
  console.error("无返回值:", JSON.stringify(res).slice(0, 1500));
  process.exit(1);
}
console.log("=== cdp-context-audit ===");
console.log(`向量能力: ${out.hasVectorCapability}`);
console.log(`system prompt（buildPrompt 静态部分）: ${out.systemPromptChars} 字符`);
console.log(`完整 system（含工作区/记忆/动态段模拟）: ${out.fullSystemChars} 字符`);
console.log(`DB 基词: ${out.baseSkillChars} 字符`);
console.log("段落位置（字节序，须递增）:", out.sectionPositions);
console.log(`内置工具: ${out.builtinToolCount} 个 / schema ${out.builtinToolsTotalChars} 字符`);
if (out.fails.length) {
  console.error("FAIL:", out.fails.join("; "));
  process.exit(1);
}
console.log("PASS: D1 无语义上下文 + D3 布局静态优先");
