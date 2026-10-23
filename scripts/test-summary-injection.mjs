// 前情摘要挪位单测：注入到第一条 user 消息前缀（切点），不改其他消息
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = "F:/MyProjects/SageRead";
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
const esbuild = await import(pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href);

const outDir = mkdtempSync(join(tmpdir(), "summary-inject-"));
const entry = join(outDir, "entry.ts");
const posix = (p) => p.replace(/\\/g, "/");
writeFileSync(
  entry,
  `export { injectConversationSummary, buildSummaryBlock } from "${posix(join(src, "ai/utils/conversation-summary-message.ts"))}";`,
);
const outfile = join(outDir, "summary.mjs");
await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile, alias: { "@": src } });
const lib = await import(pathToFileURL(outfile).href);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail))); }
}

const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });

console.log("[1] 空摘要零改动");
const msgs = [user("问题一"), assistant("回答一")];
check("null 返回原引用", lib.injectConversationSummary(msgs, null) === msgs);
check("空串返回原引用", lib.injectConversationSummary(msgs, "   ") === msgs);

console.log("[2] 字符串 content 前缀注入");
const s1 = lib.injectConversationSummary(msgs, "之前聊了第一章");
check("第一条 user 带摘要前缀", String(s1[0].content).startsWith("【前情摘要】") && String(s1[0].content).includes("之前聊了第一章"));
check("摘要后保留原问题", String(s1[0].content).includes("问题一"));
check("assistant 消息不变", s1[1] === msgs[1]);
check("原数组/原消息未被改写", String(msgs[0].content) === "问题一");

console.log("[3] 数组 content 注入 text part");
const arrMsgs = [user([{ type: "text", text: "带图问题" }, { type: "image", image: "x" }]), assistant("回答")];
const s2 = lib.injectConversationSummary(arrMsgs, "摘要A");
check("数组首部插入 text part", Array.isArray(s2[0].content) && s2[0].content[0].type === "text" && String(s2[0].content[0].text).includes("摘要A"));
check("后续 part 保留", s2[0].content.length === 3 && s2[0].content[2].type === "image");

console.log("[4] 只注入第一条 user（切点语义）");
const many = [user("旧问题"), assistant("旧回答"), user("新问题")];
const s3 = lib.injectConversationSummary(many, "旧历史摘要");
check("只有第一条 user 带摘要", String(s3[0].content).includes("旧历史摘要") && String(s3[2].content) === "新问题");

console.log("\n结果：" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
console.log("PASS summary-injection");
