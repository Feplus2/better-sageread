// D7 摘要分 scope 模板单测：三模板小节齐备 + 提示词组装（纯函数，node 直跑）
import assert from "node:assert";

let esbuildPkgPath;
{
  const { readdirSync } = await import("node:fs");
  const root = new URL("../node_modules/.pnpm/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  for (const dir of readdirSync(root)) {
    if (dir.startsWith("esbuild@")) esbuildPkgPath = new URL(`../node_modules/.pnpm/${dir}/node_modules/esbuild`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  }
}
const esbuild = (await import(`file://${esbuildPkgPath}/lib/main.js`)).default ?? (await import(`file://${esbuildPkgPath}`));
const { mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const tmp = mkdtempSync(join(tmpdir(), "sum-tpl-"));
const out = join(tmp, "tpl.mjs");
await esbuild.build({
  entryPoints: [new URL("../packages/app/src/ai/utils/summary-templates.ts", import.meta.url).pathname.replace(/^\//, "")],
  bundle: true,
  format: "esm",
  outfile: out,
});
const { summaryTemplateFor, buildScopedSummaryPrompt } = await import(`file://${out.replaceAll("\\", "/")}`);

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

// 1) 三模板各五节、互不相同、覆盖各自关键小节
const reader = summaryTemplateFor("reader");
const paper = summaryTemplateFor("paper");
const central = summaryTemplateFor("central");
ok(reader.sections.length === 5 && paper.sections.length === 5 && central.sections.length === 5, "三模板各 5 节");
ok(reader.sections.includes("已澄清的疑问与纠偏记录") && reader.sections.includes("用户理解偏好"), "reader 含理解进度专属节");
ok(paper.sections.includes("已解释过的图表/公式/引用") && paper.sections.includes("术语与符号约定"), "paper 含论证结构专属节");
ok(central.sections.join() !== reader.sections.join() && central.sections.includes("已做决定"), "central 用任务五段式");
ok(reader.focus.includes("理解文本") && !central.focus.includes("理解文本"), "侧重说明区分场景");

// 2) 提示词组装：既有摘要/转录/小节清单/字数上限全部就位
const p = buildScopedSummaryPrompt({
  scope: "paper",
  existingText: "旧摘要……",
  transcript: "用户：这篇论文的创新点是？",
  charLimit: 2000,
});
ok(p.includes("旧摘要") && p.includes("这篇论文的创新点是"), "既有摘要与转录拼入");
ok(p.includes("1. 论文与当前小节") && p.includes("5. 待续问题与阅读线索"), "小节清单编号拼入");
ok(p.includes("2000字") && p.includes("无内容的小节写"), "上限与空节规则拼入");
ok(!p.includes("undefined") && !p.includes("null"), "无未定义泄漏");

// 3) 无既有摘要时的（无）占位
const p2 = buildScopedSummaryPrompt({ scope: "central", existingText: undefined, transcript: "x", charLimit: 1000 });
ok(p2.includes("（无）"), "无既有摘要占位");

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
