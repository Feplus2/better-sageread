// D5+D6 工具结果两层瘦身单测：L1 出生截断 + L2 存根活塞（纯函数，node 直跑）
// 用法：node scripts/test-tool-slimming.mjs
import assert from "node:assert";

let esbuildPkgPath;
{
  const { readdirSync } = await import("node:fs");
  const root = new URL("../node_modules/.pnpm/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  for (const dir of readdirSync(root)) {
    if (dir.startsWith("esbuild@")) esbuildPkgPath = new URL(`../node_modules/.pnpm/${dir}/node_modules/esbuild`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  }
}
if (!esbuildPkgPath) {
  console.error("未找到 esbuild，请先 pnpm install");
  process.exit(1);
}
const esbuild = (await import(`file://${esbuildPkgPath}/lib/main.js`)).default ?? (await import(`file://${esbuildPkgPath}`));

const { mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const tmp = mkdtempSync(join(tmpdir(), "tool-slim-"));

// token-estimator 与 tool-result-slimming 无 tauri 依赖，整文件可打包；
// 但 tool-result-slimming import 了 @ai-sdk/react 的类型（仅类型，bundle 时标记 external）
const out = join(tmp, "slim.mjs");
await esbuild.build({
  entryPoints: [new URL("../packages/app/src/ai/utils/tool-result-slimming.ts", import.meta.url).pathname.replace(/^\//, "")],
  bundle: true,
  format: "esm",
  outfile: out,
  external: ["@ai-sdk/react"],
});
const slim = await import(`file://${out.replaceAll("\\", "/")}`);
const { truncateToolResultsForStorage, compactAgedRagResults, agedBoundary } = slim;

let pass = 0;
let fail = 0;
const ok = (v, msg) => {
  try {
    assert.ok(v, msg);
    pass++;
  } catch {
    fail++;
    console.error(`FAIL: ${msg}`);
  }
};
const eq = (a, b, msg) => {
  try {
    assert.strictEqual(a, b, msg);
    pass++;
  } catch {
    fail++;
    console.error(`FAIL: ${msg}（${a} != ${b}）`);
  }
};

const big = (n) => `{"results":[{"chunk_id":118,"related_chapter_titles":"第三章·二节","text":"${"甲".repeat(n)}"},{"chunk_id":119,"related_chapter_titles":"第三章·二节","text":"${"乙".repeat(n)}"}]}`;
const ragPart = (id, output) => ({
  type: "tool-ragSearch",
  toolCallId: id,
  state: "output-available",
  input: { query: "x" },
  output,
});
const textMsg = (id, role, text) => ({ id, role, parts: [{ type: "text", text }] });

// ========== L1 出生截断 ==========
{
  const msgs = [
    textMsg("a1", "assistant", "回答"),
    { id: "a2", role: "assistant", parts: [ragPart("t1", big(1500))] }, // >2000 → 截断
    { id: "a3", role: "assistant", parts: [ragPart("t2", big(10))] }, // 小 → 不动
    { id: "a4", role: "assistant", parts: [{ type: "tool-mindmap", state: "output-available", output: { map: "x".repeat(5000) } }] }, // 排除表 → 不动
  ];
  const r = truncateToolResultsForStorage(msgs);
  const p1 = r[1].parts[0].output;
  ok(p1.__slimPreview === true && p1.preview.length <= 2000, "大结果截为预览");
  ok(String(p1.preview).includes("chunk_id"), "预览头部保留 chunk_id 坐标");
  ok(r[2].parts[0].output === msgs[2].parts[0].output, "小结果原样（引用相等=零拷贝）");
  ok(r[3].parts[0].output.map.length === 5000, "排除表工具（mindmap）不动");
  ok(String(msgs[1].parts[0].output).length > 2000, "原数组未被改动");
  // 幂等
  const r2 = truncateToolResultsForStorage(r);
  ok(r2[1].parts[0].output === p1, "二次截断幂等");
}

// ========== L2 边界公式 ==========
eq(agedBoundary(5), 0, "T=5 → B=0");
eq(agedBoundary(14), 0, "T=14 → B=0（6~14 恒 0）");
eq(agedBoundary(15), 10, "T=15 → B=10");
eq(agedBoundary(24), 10, "T=24 → B=10");
eq(agedBoundary(25), 20, "T=25 → B=20");

// ========== L2 存根 + 引用位 + clear_at_least ==========
// 造 15 轮对话：轮1 有 3 个大 ragSearch 结果（每个约 3000 字符 → 总省 ~8.8k 字符 > 2k tokens 门槛）；
// 轮 2 的回答引用 [118]；其余轮纯文本
{
  const msgs = [];
  for (let t = 1; t <= 15; t++) {
    msgs.push(textMsg(`u${t}`, "user", `问题${t}`));
    if (t === 1) {
      msgs.push({
        id: "a1x",
        role: "assistant",
        parts: [
          ragPart("t1", big(1400)),
          ragPart("t2", big(1400)),
          ragPart("t3", big(1400)),
          { type: "text", text: "答案要点 A[118]" },
        ],
      });
    } else {
      msgs.push(textMsg(`a${t}`, "assistant", `回答${t}`));
    }
  }
  const r = compactAgedRagResults(msgs);
  const a1 = r[1].parts;
  ok(a1[0].output !== msgs[1].parts[0].output, "轮1 结果被降级");
  ok(typeof a1[0].output === "string" && a1[0].output.includes("⟦ragSearch#"), "存根为字符串");
  const allStubs = [a1[0].output, a1[1].output, a1[2].output].join("\n");
  ok(allStubs.includes("已引 118"), "引用位：[118] 判为已引");
  ok(allStubs.includes("未引 119"), "119 未引用判为未引");
  ok(allStubs.includes("来源：第三章·二节"), "来源坐标保留");
  ok(String(msgs[1].parts[0].output).length > 2000, "原数组未被改动");
  // 轮 11-15（>B=10）不该有 rag 结果可降——这里没有 rag，仅验证无越界
}

// clear_at_least：轮 1 只有一个小结果（省不了多少）→ 整批推迟
{
  const msgs = [];
  for (let t = 1; t <= 15; t++) {
    msgs.push(textMsg(`u${t}`, "user", `q${t}`));
    if (t === 1) msgs.push({ id: "a1y", role: "assistant", parts: [ragPart("t9", big(5)), { type: "text", text: "短回答" }] });
    else msgs.push(textMsg(`a${t}`, "assistant", `r${t}`));
  }
  const r = compactAgedRagResults(msgs);
  ok(!String(r[1].parts[0].output).startsWith("⟦"), "收益不足 → 不降级（clear_at_least 推迟）");
}

// 引用窗冻结：结果在轮 1，[118] 出现在轮 9（超出 5 轮窗）→ 不计为已引
{
  const msgs = [];
  for (let t = 1; t <= 15; t++) {
    msgs.push(textMsg(`u${t}`, "user", `q${t}`));
    if (t === 1) msgs.push({ id: "a1z", role: "assistant", parts: [ragPart("tA", big(1400)), ragPart("tB", big(1400)), ragPart("tC", big(1400)), { type: "text", text: "ok" }] });
    else if (t === 9) msgs.push(textMsg(`a9`, "assistant", "很久以后才引用[118]"));
    else msgs.push(textMsg(`a${t}`, "assistant", `r${t}`));
  }
  const r = compactAgedRagResults(msgs);
  const stub = String(r[1].parts[0].output);
  ok(stub.includes("未引 118"), "窗外的晚到引用不回写（冻结语义）");
}

// 单调性：T=15 降级后再追加到 T=16，旧存根内容不变
{
  const msgs = [];
  for (let t = 1; t <= 15; t++) {
    msgs.push(textMsg(`u${t}`, "user", `q${t}`));
    if (t === 1) msgs.push({ id: "a1m", role: "assistant", parts: [ragPart("tM", big(1400)), ragPart("tN", big(1400)), { type: "text", text: "ok" }] });
    else msgs.push(textMsg(`a${t}`, "assistant", `r${t}`));
  }
  const r15 = compactAgedRagResults(msgs);
  const stub15 = String(r15[1].parts[0].output);
  msgs.push(textMsg("u16", "user", "q16"));
  msgs.push(textMsg("a16", "assistant", "后来才提到[118]"));
  const r16 = compactAgedRagResults(msgs);
  ok(String(r16[1].parts[0].output) === stub15, "边界扩张后旧存根逐字节不变（前缀稳定）");
}

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
