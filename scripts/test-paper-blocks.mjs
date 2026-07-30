// 切块器（paper-blocks.ts）单测：esbuild 打包 → node 断言
// 覆盖：嵌套列表/引用块/表格/公式/代码/图片/混合内容/CRLF/frontmatter + 译文/对照重建自洽性
// 运行：node scripts/test-paper-blocks.mjs
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) throw new Error("node_modules/.pnpm 下未找到 esbuild，请先 pnpm install");
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const outDir = mkdtempSync(join(tmpdir(), "paper-blocks-"));
const outfile = join(outDir, "paper-blocks.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/pages/paper-reader/paper-blocks.ts")],
  bundle: true,
  format: "esm",
  outfile,
});
const { JSDOM } = await import("jsdom");
// remark 链的 decode-named-character-reference 在模块顶层调用 document.createElement，node 下用 jsdom 垫片
globalThis.document = new JSDOM("").window.document;

const { cutPaperBlocks, buildPaperViewMarkdown, restoreImageRefs } = await import(pathToFileURL(outfile).href);

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL - ${name}: ${error.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected) {
  assert(
    actual.length === expected.length && actual.every((v, i) => v === expected[i]),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}
const kinds = (blocks) => blocks.map((b) => b.kind);
const texts = (blocks) => blocks.map((b) => b.sourceText);

check("段落与 ATX 标题", () => {
  const blocks = cutPaperBlocks("# Title\n\nPara text.");
  eq(kinds(blocks), ["h1", "p"]);
  eq(texts(blocks), ["Title", "Para text."]);
  assert(
    blocks.every((b) => b.translatable),
    "标题/段落应可翻译",
  );
});

check("嵌套列表归入最外层 li", () => {
  const blocks = cutPaperBlocks("- a\n  - b\n  - c\n- d");
  eq(kinds(blocks), ["li", "li"]);
  eq(texts(blocks), ["abc", "d"]); // 与 DOM li.textContent 同口径（无分隔直接拼接）
});

check("有序列表", () => {
  const blocks = cutPaperBlocks("1. one\n2. two\n3. three");
  eq(kinds(blocks), ["li", "li", "li"]);
  eq(texts(blocks), ["one", "two", "three"]);
});

check("引用块多段落归一整块", () => {
  const blocks = cutPaperBlocks("> First\n>\n> Second\n\nAfter");
  eq(kinds(blocks), ["blockquote", "p"]);
  eq(texts(blocks), ["FirstSecond", "After"]);
});

check("表格逐单元格（首行 th，其余 td，DOM 顺序）", () => {
  const blocks = cutPaperBlocks("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
  eq(kinds(blocks), ["th", "th", "td", "td", "td", "td"]);
  eq(texts(blocks), ["A", "B", "1", "2", "3", "4"]);
});

check("$$ 公式与代码块不占块序号", () => {
  const blocks = cutPaperBlocks("Before\n\n$$\nE=mc^2\n$$\n\n```js\nconst x = 1;\n```\n\nAfter");
  eq(kinds(blocks), ["p", "p"]);
  eq(texts(blocks), ["Before", "After"]);
});

check("图片独占段是 image 块（占位但不翻译）", () => {
  const blocks = cutPaperBlocks("Intro\n\n![diagram](images/x.jpg)\n\nOutro");
  eq(kinds(blocks), ["p", "image", "p"]);
  assert(blocks[1].sourceText === "", "image 块文本应为空（img 无 textContent）");
  assert(!blocks[1].translatable, "image 块不可翻译");
});

check("图片+文字段仍是可翻译 p（图片无文本贡献，硬换行为 \\n）", () => {
  const blocks = cutPaperBlocks("Figure A  \n![](images/x.jpg)");
  eq(kinds(blocks), ["p"]);
  eq(texts(blocks), ["Figure A\n"]); // <br> 后的 "\n" 文本节点，与 DOM textContent 同口径
  assert(blocks[0].translatable, "含文字的段落可翻译");
});

check("行内公式保留 $...$", () => {
  const blocks = cutPaperBlocks("Energy $E=mc^2$ here.");
  eq(texts(blocks), ["Energy $E=mc^2$ here."]);
});

check("frontmatter 剥离 + CRLF 归一", () => {
  const blocks = cutPaperBlocks("---\r\ntitle: t\r\n---\r\n\r\n# Head\r\n\r\nPara one.\r\n\r\nPara two.");
  eq(kinds(blocks), ["h1", "p", "p"]);
  eq(texts(blocks), ["Head", "Para one.", "Para two."]);
});

check("空表格单元格占块但不可翻译", () => {
  const blocks = cutPaperBlocks("| A |  |\n| --- | --- |\n| 1 | 2 |");
  eq(kinds(blocks), ["th", "th", "td", "td"]);
  assert(blocks[1].sourceText === "" && !blocks[1].translatable, "空单元格不可翻译");
});

const MIXED = [
  "# H1",
  "",
  "Para one.",
  "",
  "- item one",
  "- item two",
  "",
  "> quote text",
  "",
  "| Ha | Hb |",
  "| --- | --- |",
  "| a | b |",
  "",
  "$$",
  "x+y",
  "$$",
  "",
  "```",
  "code",
  "```",
  "",
  "![img](x.jpg)",
].join("\n");

check("混合内容块序列", () => {
  const blocks = cutPaperBlocks(MIXED);
  eq(kinds(blocks), ["h1", "p", "li", "li", "blockquote", "th", "th", "td", "td", "image"]);
  eq(
    blocks.map((b) => b.index),
    blocks.map((_, i) => i),
  );
});

// ─── 视图重建自洽性：重建产物再切块，块数恒等、文本符合模式预期 ───

function fakeTranslations(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (block.translatable) map.set(block.index, `译文${block.index}`);
  }
  return map;
}

check("译文模式重建：块数/类型不变，可翻译块替换为译文", () => {
  const blocks = cutPaperBlocks(MIXED);
  const rebuilt = buildPaperViewMarkdown(MIXED, fakeTranslations(blocks), "translated");
  const reBlocks = cutPaperBlocks(rebuilt);
  eq(kinds(reBlocks), kinds(blocks));
  for (const block of blocks) {
    const reBlock = reBlocks[block.index];
    if (block.translatable) {
      assert(reBlock.sourceText === `译文${block.index}`, `块 ${block.index} 应为译文，got ${reBlock.sourceText}`);
    } else {
      assert(reBlock.sourceText === block.sourceText, `不可翻译块 ${block.index} 应保持原样`);
    }
  }
});

check("译文模式重建：列表标记保留（有序列表不降级）", () => {
  const md = "1. one\n2. two";
  const blocks = cutPaperBlocks(md);
  const rebuilt = buildPaperViewMarkdown(md, fakeTranslations(blocks), "translated");
  assert(rebuilt.includes("1. 译文0") && rebuilt.includes("2. 译文1"), `有序标记应保留：${rebuilt}`);
});

check("对照模式重建：块数不变、译文 div 不占块（li/td 译文并入块尾、原文偏移不受影响）", () => {
  const blocks = cutPaperBlocks(MIXED);
  const rebuilt = buildPaperViewMarkdown(MIXED, fakeTranslations(blocks), "bilingual");
  const reBlocks = cutPaperBlocks(rebuilt);
  eq(kinds(reBlocks), kinds(blocks));
  for (const block of blocks) {
    const reBlock = reBlocks[block.index];
    if (block.translatable && (block.kind === "li" || block.kind === "th" || block.kind === "td")) {
      // li/单元格内部无法插入独立块级元素，译文 div 追加在块尾（原文部分保持前缀，锚点偏移不受影响）
      assert(
        reBlock.sourceText === `${block.sourceText}译文${block.index}` ||
          reBlock.sourceText === `${block.sourceText} 译文${block.index}`,
        `块 ${block.index} 应为原文+块尾译文，got ${reBlock.sourceText}`,
      );
    } else {
      // p/h/blockquote 的译文 div 是独立兄弟块（html 块，不占块序号），原文逐字不变
      assert(reBlock.sourceText === block.sourceText, `块 ${block.index} 文本应保持原样，got ${reBlock.sourceText}`);
    }
  }
  const divCount = (rebuilt.match(/<div class="paper-translation" data-translation>/g) ?? []).length;
  assert(divCount === blocks.filter((b) => b.translatable).length, "每个可翻译块应各有一个译文 div");
});

check("对照模式重建：译文 HTML 转义", () => {
  const md = "Para one.";
  const evil = 'x<y>&"z"';
  const rebuilt = buildPaperViewMarkdown(md, new Map([[0, evil]]), "bilingual");
  assert(rebuilt.includes('x&lt;y&gt;&amp;"z"'), `译文应转义：${rebuilt}`);
});

check("缺译文的块保持原文", () => {
  const md = "# Head\n\nPara one.\n\nPara two.";
  const blocks = cutPaperBlocks(md);
  const rebuilt = buildPaperViewMarkdown(md, new Map([[1, "译文1"]]), "translated");
  const reBlocks = cutPaperBlocks(rebuilt);
  eq(texts(reBlocks), ["Head", "译文1", "Para two."]);
});

// ─── 译文图片引用补回（restoreImageRefs + 译文模式重建硬保证） ───

check("restoreImageRefs：块首图片补到译文块首", () => {
  const out = restoreImageRefs("![](images/a.jpg)\nCaption text", "说明文字");
  assert(out.startsWith("![](images/a.jpg)\n说明文字"), `应在块首：${out}`);
});

check("restoreImageRefs：块尾图片补到译文块尾", () => {
  const out = restoreImageRefs("Caption text\n![](images/b.jpg)", "说明文字");
  assert(out.endsWith("说明文字\n![](images/b.jpg)"), `应在块尾：${out}`);
});

check("restoreImageRefs：居中图片按字符比例尽量原位", () => {
  const out = restoreImageRefs("AAAA\n![](images/c.jpg)\nBBBB", "一 二 三 四");
  assert(out.includes("![](images/c.jpg)"), `应补回：${out}`);
  const at = out.indexOf("![](images/c.jpg)");
  assert(at > 0 && at + "![](images/c.jpg)".length < out.length, `应大致居中：${out}`);
});

check("restoreImageRefs：译文已含同 URL 图片（alt 被改写）不重复补", () => {
  const translated = "说明 ![图](images/d.jpg)";
  assert(restoreImageRefs("Caption\n![](images/d.jpg)", translated) === translated, "已含同 URL 图片不应再补");
});

check("restoreImageRefs：多图段落全部补回且顺序与源块一致", () => {
  const out = restoreImageRefs("A\n![](1.jpg)\nB\n![](2.jpg)\nC", "甲乙丙丁戊己庚辛壬癸");
  assert(out.includes("![](1.jpg)") && out.includes("![](2.jpg)"), `两图都应补回：${out}`);
  assert(out.indexOf("![](1.jpg)") < out.indexOf("![](2.jpg)"), `顺序应保持：${out}`);
});

check("译文模式重建：图片+图注段落译文丢图时图片补回（块数不变）", () => {
  const md = "Intro\n\nWe show results\n![](images/xx.jpg)\nFig. 1. Overview of the pipeline.\n\nOutro";
  const blocks = cutPaperBlocks(md);
  eq(kinds(blocks), ["p", "p", "p"]);
  // 模型译文丢失了 ![](images/xx.jpg) 引用
  const rebuilt = buildPaperViewMarkdown(md, new Map([[1, "我们展示结果。图 1：流程概览。"]]), "translated");
  assert(rebuilt.includes("![](images/xx.jpg)"), `重建后图片引用应存在：${rebuilt}`);
  const reBlocks = cutPaperBlocks(rebuilt);
  eq(kinds(reBlocks), ["p", "p", "p"]); // 块数/类型不变（不引入新段落）
});

check("译文模式重建：图片在块首/块尾分别补到译文块首/块尾", () => {
  const md = "![](images/top.jpg)\nCaption top\n\nCaption bottom\n![](images/bottom.jpg)";
  const rebuilt = buildPaperViewMarkdown(
    md,
    new Map([
      [0, "顶部说明"],
      [1, "底部说明"],
    ]),
    "translated",
  );
  const topIdx = rebuilt.indexOf("![](images/top.jpg)");
  const bottomIdx = rebuilt.indexOf("![](images/bottom.jpg)");
  assert(topIdx !== -1 && topIdx < rebuilt.indexOf("顶部说明"), `块首图应在译文前：${rebuilt}`);
  assert(bottomIdx !== -1 && bottomIdx > rebuilt.indexOf("底部说明"), `块尾图应在译文后：${rebuilt}`);
});

check("译文模式重建：图片独占段（image 块）不翻译、原样保留（回归）", () => {
  const md = "Intro\n\n![diagram](images/x.jpg)\n\nOutro";
  const rebuilt = buildPaperViewMarkdown(
    md,
    new Map([
      [0, "引言"],
      [2, "结语"],
    ]),
    "translated",
  );
  assert(rebuilt.includes("![diagram](images/x.jpg)"), `image 块应原样保留：${rebuilt}`);
  const reBlocks = cutPaperBlocks(rebuilt);
  eq(kinds(reBlocks), ["p", "image", "p"]);
});

check("对照模式重建：含图段落原块不动（图片本就不丢），译文 div 不补图", () => {
  const md = "We show results\n![](images/xx.jpg)\nFig. 1. Overview.";
  const rebuilt = buildPaperViewMarkdown(md, new Map([[0, "我们展示结果。图 1：概览。"]]), "bilingual");
  const divCount = (rebuilt.match(/<div class="paper-translation" data-translation>/g) ?? []).length;
  assert(divCount === 1, "应只有一个译文 div");
  assert(rebuilt.includes("We show results\n![](images/xx.jpg)"), `原块应保持不变：${rebuilt}`);
  const div = rebuilt.slice(rebuilt.indexOf('<div class="paper-translation"'));
  assert(!div.includes("![]("), `对照模式译文 div 不需要补图：${div}`);
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
