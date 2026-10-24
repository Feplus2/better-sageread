// 源码契约测试：new 模式必须恢复文件五件套（2026-10-23 用户拍板）。
// 运行：node scripts/test-file-tools-new-mode.mjs
// 说明：行为面（真实工具数/schema/目录牌）由 scripts/cdp-verify-p1-document-tools.mjs 在 dev App 内断言；
// 本脚本无 App 依赖，守住「注册表不再隐藏 + 三个提示词文件不再写不可用」这两条源码契约。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), "utf8");
const FILE_TOOLS = ["readLocalFile", "writeFile", "editFile", "searchFiles", "runCommand"];

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(
      `  FAIL ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`,
    );
  }
}

/** 取以 marker 开头、最长 length 的片段（用于把断言限制在文件工具文案段内） */
function section(source, marker, length = 900) {
  const index = source.indexOf(marker);
  return index < 0 ? "" : source.slice(index, index + length);
}

/** 取从 marker 到所在模板字符串结束（`;）的片段，避免断言串到下一段策略 */
function templateSection(source, marker) {
  const index = source.indexOf(marker);
  if (index < 0) return "";
  const end = source.indexOf("`;", index);
  return source.slice(index, end < 0 ? index + 900 : end);
}

function assertFileToolsAvailable(label, text) {
  const missing = FILE_TOOLS.filter((name) => !text.includes(name));
  check(`${label}：文件五件套齐全`, missing.length === 0, missing.join(","));
  check(`${label}：不再写「不可用/不在工具面」`, !/不可用|不在你的工具面/.test(text), text.slice(0, 260));
}

console.log("[1] registry.ts：new 模式不再隐藏 reader/paper 的 shared 文件工具");
{
  const source = read("packages/app/src/ai/tools/registry.ts");
  check("已删除 NEW_MODE_HIDDEN_SHARED 隐藏表", !source.includes("NEW_MODE_HIDDEN_SHARED"));
  check(
    "已删除按 docToolMode 隐藏 shared 工具的条件",
    !/docToolMode === "new" && agentScope !== "central"/.test(source),
  );
  const sharedBlock = source.slice(
    source.indexOf("// ==================== 共享工具"),
    source.indexOf("// ==================== 全局助手专属工具"),
  );
  check("共享工具段存在", sharedBlock.length > 500, sharedBlock.length);
  for (const name of FILE_TOOLS) {
    check(`registry 注册了 shared 文件工具 ${name}`, new RegExp(`name: "${name}"`).test(sharedBlock));
  }
}

console.log("[2] prompt.ts：阅读助手文件工具段恢复可用文案");
{
  const source = read("packages/app/src/constants/prompt.ts");
  check("旧「在新原语模式下不在你的工具面」已删除", !source.includes("在新原语模式下不在你的工具面"));
  const fileToolsSection = templateSection(source, "const fileTools = ");
  check("文件工具段存在", fileToolsSection.length > 0, fileToolsSection.slice(0, 120));
  assertFileToolsAvailable("阅读助手", fileToolsSection);
  check("强调写/命令走确认卡", /确认卡/.test(fileToolsSection), fileToolsSection.slice(0, 300));
  check("保留 exportNotes 指引", fileToolsSection.includes("exportNotes"), "");
}

console.log("[3] paper-prompt.ts：论文助手 new 策略恢复可用文案");
{
  const source = read("packages/app/src/constants/paper-prompt.ts");
  const newBaseStart = source.indexOf("const PAPER_POLICY_BASE_NEW");
  const vectorNewStart = source.indexOf("const PAPER_POLICY_VECTOR_NEW");
  check("PAPER_POLICY_BASE_NEW 段存在", newBaseStart >= 0 && vectorNewStart > newBaseStart);
  const newBase = source.slice(newBaseStart, vectorNewStart);
  const fileToolsSection = templateSection(newBase, "—— 文件工具 ——");
  check("new 策略含文件工具段", fileToolsSection.length > 0);
  assertFileToolsAvailable("论文 new 策略", fileToolsSection);
  check("new 策略强调写/命令走确认卡", /确认卡/.test(fileToolsSection), fileToolsSection.slice(0, 300));
  check("全文件不再出现「文件工具…本模式不可用」", !/readLocalFile[^\n]{0,160}本模式不可用/.test(source));
  // legacy 策略同样保留可用文案（回退模式不应比 new 更差）
  const legacyBaseStart = source.indexOf("const PAPER_POLICY_BASE =");
  const legacyFileTools = section(source.slice(legacyBaseStart, newBaseStart), "—— 文件工具 ——");
  check(
    "legacy 策略文件工具段仍可用",
    FILE_TOOLS.every((name) => legacyFileTools.includes(name)),
    legacyFileTools.slice(0, 120),
  );
}

console.log("[4] library-guide.ts：不得再出现「文件工具不可用」误导");
{
  const source = read("packages/app/src/ai/prompts/library-guide.ts");
  check("Library guide 无「不可用」表述", !source.includes("不可用"));
  check("Library guide 仍保留文献库只读边界", source.includes("文献库只读") && source.includes("runCommand"), "");
  check("未索引关键词/标题回退与目录读取互补", source.includes("关键词/标题") && source.includes("互补"), "");
  check("不再称未索引只能按目录直读", !source.includes("只能按目录/原文读取"), "");
}

console.log("[5] 模式感知工具说明书收口");
{
  const sciverse = read("packages/app/src/ai/tools/sciverse-search.ts");
  check("sciverseSearch 不固定推荐 ragSearch/paperSearch", !/ragSearch|paperSearch/.test(sciverse), "");
  const local = read("packages/app/src/ai/tools/central/read-local-file.ts");
  check("readLocalFile 不固定推荐 readPaperSection", !local.includes("readPaperSection"), "");
  const devDocs = read("packages/app/src/ai/tools/central/search-dev-docs.ts");
  check("searchDevDocs 不固定推荐 RAG/paperSearch", !/RAG\/paperSearch/.test(devDocs), "");
  const paperPrompt = read("packages/app/src/constants/paper-prompt.ts");
  const noVector = templateSection(paperPrompt, "const PAPER_POLICY_NO_VECTOR_NEW");
  check("paper 无向量时仍提示关键词/标题回退", noVector.includes("关键词/标题"), noVector.slice(0, 220));
  check("paper 无向量时不再称 searchLibrary 不可用", !noVector.includes("searchLibrary 不可用"), noVector.slice(0, 220));
}

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS file-tools-new-mode 源码契约");
