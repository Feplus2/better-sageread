// 书籍翻译段落枚举 ↔ 注入一致性测试（docs/book-translation-plan.md 的工程不变量）：
// jsdom 中验证 section-blocks 的四条契约——
//   1) 枚举规则：嵌套块取叶子、脚注 aside 排除、纯标点/空块不可翻译；
//   2) 注入幂等：注入译文并序列化往返后，重新枚举的段序号与文本与首次完全一致（译文块不入枚举）；
//   3) 双入口一致：transformer 侧 parseSectionDocument(字符串) 与翻译服务侧 wrapSectionDocument
//      （foliate createDocument 的 Document）枚举结果相同——段序号结构性不错位的根基；
//   4) 烂 XHTML 兜底：HTML 语法（未闭合标签/无引号属性）走 text/html 分支不抛错、枚举照常。
// 运行：node scripts/test-book-section-blocks.mjs
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

const outDir = mkdtempSync(join(tmpdir(), "book-section-blocks-"));
try {
  const outfile = join(outDir, "section-blocks.mjs");
  await esbuild.build({
    entryPoints: [join(root, "packages/app/src/services/book-translation/section-blocks.ts")],
    bundle: true,
    format: "esm",
    outfile,
  });
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.XMLSerializer = dom.window.XMLSerializer;

  const mod = await import(pathToFileURL(outfile).href);
  const {
    parseSectionDocument,
    wrapSectionDocument,
    serializeSectionDocument,
    enumerateSectionBlocks,
    injectSectionTranslations,
    buildBlockTextMap,
    rawOffsetOf,
    rawToNormOffset,
    normToRange,
    TRANSLATION_ATTR,
  } = mod;

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

  const XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/eps">
<head><title>Test</title></head>
<body>
  <h1>Chapter One The Beginning</h1>
  <p id="a">Hello world, this is the first paragraph.</p>
  <div><p id="b">Nested paragraph inside a plain div.</p></div>
  <ul>
    <li id="c">Plain list item text.</li>
    <li><p id="d">List item containing an inner paragraph.</p></li>
  </ul>
  <blockquote><p id="e">A quoted sentence worth translating.</p></blockquote>
  <table><tbody><tr><td id="f">Table cell content here.</td></tr></tbody></table>
  <p>...</p>
  <aside epub:type="footnote"><p id="g">Footnote body text.</p></aside>
  <p id="h">Trailing paragraph after everything.</p>
</body>
</html>`;

  // 1) 枚举规则
  const first = parseSectionDocument(XHTML);
  check("XML 解析成功（isXml=true）", () => assert(first.isXml, "应走 XML 分支"));
  const blocks1 = enumerateSectionBlocks(first);
  check("枚举契约：叶子块/排除嵌套外层/排除脚注/排除纯标点", () => {
    const texts = blocks1.map((b) => b.el.getAttribute("id") ?? b.el.tagName.toLowerCase());
    assert(
      JSON.stringify(texts) ===
        JSON.stringify(["h1", "a", "b", "c", "d", "e", "f", "h"]),
      `枚举结果不符: ${JSON.stringify(texts)}`,
    );
    assert(
      blocks1.every((b, i) => b.index === i),
      "段序号应为 0 起连续",
    );
    assert(blocks1[0].sourceText === "Chapter One The Beginning", "源文本应规范化空白");
  });

  // 2) 注入幂等：注入 → 序列化 → 重解析 → 重枚举，序号与文本不变
  check("注入 → 序列化往返 → 枚举幂等（译文块不入枚举、段序不漂移）", () => {
    const translations = {};
    for (const block of blocks1) translations[String(block.index)] = { hash: "x", text: `译文${block.index}` };
    const injectedCount = injectSectionTranslations(first, blocks1, translations);
    assert(injectedCount === blocks1.length, `注入数应=段数，实际 ${injectedCount}`);
    const roundTrip = parseSectionDocument(serializeSectionDocument(first));
    assert(roundTrip.isXml, "往返后仍应 XML 解析成功");
    const blocks2 = enumerateSectionBlocks(roundTrip);
    assert(blocks2.length === blocks1.length, `往返后段数变化: ${blocks1.length} -> ${blocks2.length}`);
    blocks1.forEach((b, i) =>
      assert(b.sourceText === blocks2[i].sourceText, `第 ${i} 段文本漂移: ${b.sourceText} != ${blocks2[i].sourceText}`),
    );
    const injectedDivs = roundTrip.doc.querySelectorAll(`[${TRANSLATION_ATTR}]`);
    assert(injectedDivs.length === blocks1.length, `译文 div 数不符: ${injectedDivs.length}`);
    const classes = Array.from(injectedDivs).map((el) => el.getAttribute("class") ?? "");
    assert(
      classes.every((c) => c.includes("translation-target") && c.includes("translation-target-block")),
      "译文 div 应带 translation-target 双类",
    );
  });

  // 序列化健康：XHTML 命名空间下不应产生 xmlns="" 污染
  check("序列化无 xmlns 空命名空间污染", () => {
    const again = parseSectionDocument(XHTML);
    injectSectionTranslations(again, enumerateSectionBlocks(again), { "0": { hash: "x", text: "第一章" } });
    const out = serializeSectionDocument(again);
    assert(!out.includes('xmlns=""'), "出现 xmlns=\"\" 污染");
    assert(out.includes("data-book-translation"), "译文标记属性丢失");
  });

  // 3) 双入口一致：字符串入口 vs Document 入口（foliate createDocument 语义）
  check("双入口枚举一致（transformer 字符串 vs 服务 Document）", () => {
    const docEntry = new DOMParser().parseFromString(XHTML, "application/xhtml+xml");
    const viaDoc = enumerateSectionBlocks(wrapSectionDocument(docEntry)).map((b) => b.sourceText);
    const viaStr = blocks1.map((b) => b.sourceText);
    assert(JSON.stringify(viaDoc) === JSON.stringify(viaStr), "两入口枚举文本不一致");
  });

  // 4) 烂 XHTML 兜底（HTML 语法）
  check("烂 XHTML 走 text/html 兜底且枚举照常", () => {
    const broken = `<html><body><p>Unclosed paragraph text<br>with html syntax<p>Second paragraph
    <div><span>inline</span> inside bare div</div></body></html>`;
    const parsed = parseSectionDocument(broken);
    assert(!parsed.isXml, "烂 XHTML 应走 text/html 分支");
    const blocks = enumerateSectionBlocks(parsed);
    assert(blocks.length >= 2, `兜底枚举段数异常: ${blocks.length}`);
    assert(blocks.every((b) => b.sourceText.length >= 2), "兜底分支段文本异常");
  });

  // td 注入位置：表格单元格内 append（而非 tr 间插 div）
  check("td 注入为内部 append（表格结构合法）", () => {
    const table = parseSectionDocument(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><table><tbody><tr><td id="f">Cell text here.</td></tr></tbody></table></body></html>`,
    );
    const blocks = enumerateSectionBlocks(table);
    assert(blocks.length === 1 && blocks[0].el.tagName.toLowerCase() === "td", "表格枚举应得 td");
    injectSectionTranslations(table, blocks, { "0": { hash: "x", text: "单元格" } });
    const injected = table.doc.querySelector(`[${TRANSLATION_ATTR}]`);
    assert(injected && injected.parentElement === blocks[0].el, "译文 div 应在 td 内部");
  });

  // 重入回归：同一活文档二次注入（续翻后 book-translation-updated 再触发场景）——
  // 译文块更新不重复、td 段文本不混入译文（transformer 注入版章节上 DOM 直注入的活场景）
  check("二次注入不重复、td 文本不漂移", () => {
    const parsed = parseSectionDocument(XHTML);
    const blocks1 = enumerateSectionBlocks(parsed);
    const translations = {};
    for (const block of blocks1) translations[String(block.index)] = { hash: "x", text: `译文${block.index}` };
    injectSectionTranslations(parsed, blocks1, translations);
    // 模拟译文更新后再次注入（枚举的是已注入的活文档）
    const blocks2 = enumerateSectionBlocks(parsed);
    const updated = { ...translations, "6": { hash: "x", text: "更新后的单元格译文" } };
    const count2 = injectSectionTranslations(parsed, blocks2, updated);
    const divs = parsed.doc.querySelectorAll(`[${TRANSLATION_ATTR}]`);
    assert(divs.length === blocks1.length, `二次注入后译文块重复: ${divs.length}`);
    assert(count2 === blocks1.length, `二次注入计数异常: ${count2}`);
    assert(
      parsed.doc.querySelector(`[${TRANSLATION_ATTR}][data-block-index="6"]`)?.textContent ===
        "更新后的单元格译文",
      "更新语义未生效",
    );
    const tdSource = enumerateSectionBlocks(parsed).find((b) => b.el.getAttribute("id") === "f")?.sourceText;
    assert(tdSource === "Table cell content here.", `td 段文本混入译文: ${JSON.stringify(tdSource)}`);
  });

  // ─── 批次 4a：段内偏移映射（DOM ↔ 规范化文本，交互层地基） ───
  check("偏移映射：norm 与枚举 sourceText 严格一致（含嵌套 span/多空白/换行）", () => {
    const parsed = parseSectionDocument(XHTML);
    const blocks = enumerateSectionBlocks(parsed);
    for (const block of blocks) {
      const map = buildBlockTextMap(block.el);
      assert(map.norm === block.sourceText, `段 ${block.index} norm 漂移: ${JSON.stringify(map.norm)} != ${JSON.stringify(block.sourceText)}`);
    }
  });

  check("偏移映射：norm→raw→norm 双向往返一致", () => {
    const parsed = parseSectionDocument(XHTML);
    for (const block of enumerateSectionBlocks(parsed)) {
      const map = buildBlockTextMap(block.el);
      for (let i = 0; i < map.norm.length; i++) {
        const rawIdx = map.normToRaw[i];
        assert(map.rawToNorm[rawIdx] === i, `段 ${block.index} 位 ${i} 往返断裂`);
      }
    }
  });

  check("偏移映射：normToRange 取回的文本规范化后 === norm 切片（跨文本节点）", () => {
    // 构造含内联 span 的多节点段落
    const parsed = parseSectionDocument(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="multi">Alpha <span>beta  gamma</span>   delta.</p></body></html>`,
    );
    const [block] = enumerateSectionBlocks(parsed);
    const map = buildBlockTextMap(block.el);
    assert(map.norm === "Alpha beta gamma delta.", `norm 异常: ${JSON.stringify(map.norm)}`);
    for (let start = 0; start < map.norm.length; start += 3) {
      const end = Math.min(start + 7, map.norm.length);
      const range = normToRange(block.el, map, start, end);
      assert(range, `区间 [${start},${end}) 未生成 Range`);
      // Range 在 raw 侧，含被折叠的原始空白——规范化后才与 norm 切片相等
      const rawText = range.toString().replace(/\s+/g, " ").trim();
      assert(rawText === map.norm.slice(start, end), `区间 [${start},${end}) 文本不符: ${rawText}`);
    }
  });

  check("偏移映射：caret 模拟（node+offset → raw → norm 字符正确）", () => {
    const parsed = parseSectionDocument(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="multi">Alpha <span>beta  gamma</span>   delta.</p></body></html>`,
    );
    const [block] = enumerateSectionBlocks(parsed);
    const map = buildBlockTextMap(block.el);
    const span = block.el.querySelector("span");
    const spanText = span.firstChild; // "beta  gamma"
    const rawOff = rawOffsetOf(block.el, spanText, 5); // 'beta '[5] 落在折叠双空格
    assert(rawOff !== null, "caret 节点定位失败");
    const normOff = rawToNormOffset(map, rawOff);
    assert(map.norm[normOff] === " ", `折叠空白吸附异常: ${JSON.stringify(map.norm[normOff])}`);
    const rawOff2 = rawOffsetOf(block.el, spanText, 6); // 'g'（gamma 首字母，前有折叠双空格）
    assert(map.norm[rawToNormOffset(map, rawOff2)] === "g", "普通字符定位异常");
  });

  check("偏移映射：译文子树不参与（td 场景注入后映射不变）", () => {
    const parsed = parseSectionDocument(XHTML);
    const blocks = enumerateSectionBlocks(parsed);
    injectSectionTranslations(parsed, blocks, { "7": { hash: "x", text: "尾段译文" } });
    const tail = blocks.find((b) => b.el.getAttribute("id") === "h");
    const map = buildBlockTextMap(tail.el);
    assert(map.norm === tail.sourceText, "注入后 norm 混入译文");
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error("FAILURES:", failures);
    process.exit(1);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
