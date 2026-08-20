// mergeZoteroMetadata 纯函数单测：Zotero 优先 / 提取值兜底的组合矩阵。
// 用法：node scripts/test-zotero-metadata-merge.mjs
// 实现：typescript.transpileModule 即时转译叶模块（仅类型导入，转译后零依赖），node:test 断言。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const SRC = "packages/app/src/services/zotero-metadata-merge.ts";
const TMP = "scripts/.zotero-metadata-merge.compiled.mjs";

const compiled = ts.transpileModule(readFileSync(SRC, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
writeFileSync(TMP, compiled.outputText);
const { mergeZoteroMetadata } = await import(`./.zotero-metadata-merge.compiled.mjs?t=${Date.now()}`);

const PARSED_FULL = {
  title: "Extracted Title (possibly wrong year)",
  author: ["Wang, Xiaoming 🎓", "Second Author", "Third Author"],
  date: "2024",
  doi: "10.1111/extracted",
  "container-title": "Journal of Examples",
  lang: "en",
  abstract: " extracted abstract ",
};

test("Zotero 全字段存在：title/date/doi 全走 Zotero，显示作者 firstAuthor + et al.", () => {
  const { metadata, displayAuthor } = mergeZoteroMetadata(PARSED_FULL, {
    title: "Zotero Title",
    doi: "10.2222/zotero",
    year: "2023",
    firstAuthor: "Wang",
  });
  assert.equal(metadata.title, "Zotero Title");
  assert.equal(metadata.date, "2023");
  assert.equal(metadata.doi, "10.2222/zotero");
  assert.equal(displayAuthor, "Wang et al.");
  // 其余提取字段原样保留；完整作者列表仍保留提取值
  assert.equal(metadata["container-title"], "Journal of Examples");
  assert.equal(metadata.lang, "en");
  assert.equal(metadata.author, PARSED_FULL.author);
});

test("Zotero 全缺位（null/空串/空白）：全走提取值", () => {
  const { metadata, displayAuthor } = mergeZoteroMetadata(PARSED_FULL, {
    title: "   ",
    doi: null,
    year: "",
    firstAuthor: null,
  });
  assert.equal(metadata.title, PARSED_FULL.title);
  assert.equal(metadata.date, "2024");
  assert.equal(metadata.doi, "10.1111/extracted");
  assert.equal(displayAuthor, "Wang, Xiaoming 🎓 et al.");
});

test("单作者 + firstAuthor：显示作者不带 et al.", () => {
  const { displayAuthor } = mergeZoteroMetadata(
    { title: "T", author: ["Only Author"], date: "2024" },
    { title: null, doi: null, year: null, firstAuthor: "Solo" },
  );
  assert.equal(displayAuthor, "Solo");
});

test("垃圾提取作者名（emoji 污染）：显示作者用 Zotero firstAuthor，完整列表保留污染原值", () => {
  const parsed = { title: "T", author: ["Wang 🤖🎓", "Li 🔬"], date: "2024" };
  const { metadata, displayAuthor } = mergeZoteroMetadata(parsed, {
    title: null,
    doi: null,
    year: null,
    firstAuthor: "Wang",
  });
  assert.equal(displayAuthor, "Wang et al.");
  assert.deepEqual(metadata.author, parsed.author);
});

test("部分字段：仅 year 存在时只覆盖 date", () => {
  const { metadata } = mergeZoteroMetadata(PARSED_FULL, {
    title: null,
    doi: undefined,
    year: "2021",
    firstAuthor: null,
  });
  assert.equal(metadata.title, PARSED_FULL.title);
  assert.equal(metadata.date, "2021");
  assert.equal(metadata.doi, "10.1111/extracted");
});

test("提取 title 缺位 + Zotero title 存在：metadata.title 落 Zotero 值", () => {
  const { metadata } = mergeZoteroMetadata(
    { date: "2024" },
    { title: "From Zotero", doi: null, year: null, firstAuthor: null },
  );
  assert.equal(metadata.title, "From Zotero");
});

test("结构化作者（PaperAuthor[]）无 Zotero：兜底取 name + et al.", () => {
  const { displayAuthor } = mergeZoteroMetadata(
    { author: [{ name: "Chen, Alice" }, { name: "Bob" }] },
    {},
  );
  assert.equal(displayAuthor, "Chen, Alice et al.");
});

test("无任何作者信息：displayAuthor 为空串", () => {
  const { displayAuthor } = mergeZoteroMetadata({ title: "T" }, {});
  assert.equal(displayAuthor, "");
});

test("parsed 不被原地修改（不可变入参）", () => {
  const parsed = { title: "Keep", date: "2024", author: ["A", "B"] };
  mergeZoteroMetadata(parsed, { title: "Override", year: "2020", firstAuthor: "Z" });
  assert.equal(parsed.title, "Keep");
  assert.equal(parsed.date, "2024");
});

process.on("exit", () => {
  try {
    unlinkSync(TMP);
  } catch {}
});
