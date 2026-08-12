// 翻译服务批次容错单测（paper-translation-service.ts）：esbuild 打包 + 打桩 tauri/ai 依赖 → node 断言
// 覆盖：单批解析失败 → 严格 JSON 措辞重试 1 次 → 仍失败跳过该批并计数、继续后续批次（不整体中止）；
//       重试成功不计失败；被跳过的块不落盘，续翻（force=false）自动补齐。
// 运行：node scripts/test-paper-translation-tolerance.mjs
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

const outDir = mkdtempSync(join(tmpdir(), "paper-translation-"));
const dataDir = join(outDir, "appdata"); // 模拟 appDataDir（books/{paperId}/translation-zh.json 落在这里）
globalThis.__testDataDir = dataDir;

// 模型行为开关（并发安全：按 prompt 内容判定，不依赖调用顺序——服务 3 路并发处理批次，
// 早期 FIFO 行为队列会被 worker 调度打乱，是 2026-08 测试漂移的根因）：
// alwaysFailIfIncludes：命中文本的批次首次+重试都返回垃圾；failOnceIfIncludes：命中批次仅首次（非严格措辞）失败
let alwaysFailIfIncludes = null;
let failOnceIfIncludes = null;
const calls = [];
// 术语表通道：独立记录（不占批次行为开关，calls 语义不变=批次调用）
const glossaryCalls = [];
let glossaryBehavior = "ok"; // "ok" 返回两条术语；"bad" 返回垃圾（验证抽取失败不阻断翻译）
globalThis.__mockGenerateText = async ({ prompt }) => {
  if (prompt.includes("学术翻译术语专家")) {
    glossaryCalls.push(prompt);
    if (glossaryBehavior === "bad") return { text: "这不是合法 JSON……" };
    return {
      text: JSON.stringify([
        { src: "rock-salt", tgt: "岩盐" },
        { src: "spinel", tgt: "尖晶石" },
      ]),
    };
  }
  calls.push(prompt);
  const strict = prompt.includes("严格合法的 JSON");
  if (alwaysFailIfIncludes && prompt.includes(alwaysFailIfIncludes)) {
    return { text: "这不是合法 JSON（bad control character in string literal …）" };
  }
  if (!strict && failOnceIfIncludes && prompt.includes(failOnceIfIncludes)) {
    return { text: "这不是合法 JSON（bad control character in string literal …）" };
  }
  const jsonText = prompt.slice(prompt.indexOf("待翻译内容：") + "待翻译内容：".length).trim();
  const batch = JSON.parse(jsonText);
  return { text: JSON.stringify(batch.map((b) => ({ index: b.index, text: `译文${b.index}` }))) };
};

// 打桩：tauri path/fs（node fs 实现到临时目录）、模型工厂、ai.generateText
const STUBS = {
  "@/ai/providers/factory": `
    export const getUtilityModel = () => ({ providerId: "mock", modelId: "mock" });
    export const createModelInstance = () => ({});
    export const createUtilityModelInstance = () => ({});
    export const utilityTaskProviderOptions = () => undefined;
  `,
  ai: `
    export const generateText = (...args) => globalThis.__mockGenerateText(...args);
  `,
  "@tauri-apps/api/path": `
    export const appDataDir = async () => globalThis.__testDataDir;
    export const join = async (...parts) => parts.join("/");
  `,
  "@tauri-apps/plugin-fs": `
    import { access, readFile, writeFile } from "node:fs/promises";
    export const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
    export const readTextFile = (path) => readFile(path, "utf8");
    export const writeTextFile = (path, contents) => writeFile(path, contents, "utf8");
  `,
};
const stubPlugin = {
  name: "test-stubs",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => (STUBS[args.path] ? { path: args.path, namespace: "stub" } : null));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
  },
};

const outfile = join(outDir, "paper-translation-service.mjs");
await esbuild.build({
  entryPoints: [join(root, "packages/app/src/services/paper-translation-service.ts")],
  bundle: true,
  format: "esm",
  platform: "node", // 打桩里的 node:fs/promises 需要按 node 内置模块外部化
  outfile,
  alias: { "@": join(root, "packages/app/src") },
  plugins: [stubPlugin],
});
const { JSDOM } = await import("jsdom");
// remark 链的 decode-named-character-reference 在模块顶层调用 document.createElement，node 下用 jsdom 垫片
globalThis.document = new JSDOM("").window.document;

const { translatePaper, loadPaperTranslation } = await import(pathToFileURL(outfile).href);

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
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

/** 30 个短段落 → 3 批（12/12/6，BATCH_MAX_BLOCKS=12） */
const MD30 = Array.from({ length: 30 }, (_, i) => `Paragraph number ${i} with some content to translate.`).join("\n\n");
/** 12 个短段落 → 1 批 */
const MD12 = Array.from({ length: 12 }, (_, i) => `Single batch paragraph ${i} to translate.`).join("\n\n");

const paperDir = (paperId) => join(dataDir, "books", paperId);

await check("坏批次：重试 1 次仍失败 → 跳过该批并计数，继续后续批次（不整体中止）", async () => {
  mkdirSync(paperDir("p1"), { recursive: true });
  alwaysFailIfIncludes = "Paragraph number 12 with some content"; // 批2（块 12–23）首次+重试都坏
  calls.length = 0;
  try {
    const result = await translatePaper({ paperId: "p1", markdown: MD30 });
    assert(result.cancelled === false, "不应被中止");
    assert(result.total === 30, `total 应为 30，got ${result.total}`);
    assert(result.failedBatches === 1, `失败批次应为 1，got ${result.failedBatches}`);
    assert(result.translated === 18, `应新翻 18 块（12+6），got ${result.translated}`);
    assert(result.skipped === 0, `首次翻译 skipped 应为 0，got ${result.skipped}`);
    assert(calls.length === 4, `generateText 应调用 4 次（1+2+1），got ${calls.length}`);
    const strictCalls = calls.filter((p) => p.includes("严格合法的 JSON"));
    assert(
      strictCalls.length === 1 && strictCalls[0].includes("Paragraph number 12"),
      `重试应带"严格 JSON"措辞且针对批2，got ${strictCalls.length} 次严格调用`,
    );
    // 被跳过的块不落盘（续翻才能识别缺口）
    const file = await loadPaperTranslation("p1");
    const keys = Object.keys(file?.blocks ?? {});
    assert(keys.length === 18, `落盘应为 18 块，got ${keys.length}`);
    assert(file.blocks["0"] && file.blocks["24"], "批1/批3的块应落盘");
    assert(!file.blocks["12"] && !file.blocks["23"], "失败批次的块不应落盘");
  } finally {
    alwaysFailIfIncludes = null;
  }
});

await check("续翻（force=false）：只补翻缺口批次，完成后译本齐全", async () => {
  const result = await translatePaper({ paperId: "p1", markdown: MD30 });
  assert(result.failedBatches === 0, `续翻不应有失败批次，got ${result.failedBatches}`);
  assert(result.translated === 12, `应只补翻 12 块，got ${result.translated}`);
  assert(result.skipped === 18, `应跳过已翻 18 块，got ${result.skipped}`);
  const file = await loadPaperTranslation("p1");
  assert(Object.keys(file?.blocks ?? {}).length === 30, "续翻后 30 块应齐全");
});

await check("重试成功：不计失败批次，批次正常落盘", async () => {
  mkdirSync(paperDir("p2"), { recursive: true });
  failOnceIfIncludes = "Single batch paragraph 0"; // 首次坏，重试好
  calls.length = 0;
  try {
    const result = await translatePaper({ paperId: "p2", markdown: MD12 });
    assert(result.failedBatches === 0, `重试成功不应计失败，got ${result.failedBatches}`);
    assert(result.translated === 12, `12 块应全部翻译，got ${result.translated}`);
    assert(calls.length === 2, `应调用 2 次（首次+重试），got ${calls.length}`);
    const file = await loadPaperTranslation("p2");
    assert(Object.keys(file?.blocks ?? {}).length === 12, "12 块应全部落盘");
  } finally {
    failOnceIfIncludes = null;
  }
});

await check("全部批次失败：结果正常返回（不抛错），failedBatches 汇总", async () => {
  mkdirSync(paperDir("p3"), { recursive: true });
  alwaysFailIfIncludes = "Single batch paragraph 0"; // 1 批，首次+重试都坏
  try {
    const result = await translatePaper({ paperId: "p3", markdown: MD12 });
    assert(
      result.cancelled === false && result.failedBatches === 1,
      `应平静收尾并计 1 个失败批次：${JSON.stringify(result)}`,
    );
    assert(result.translated === 0, "不应有块被翻译");
    const file = await loadPaperTranslation("p3");
    assert(Object.keys(file?.blocks ?? {}).length === 0, "失败块不应落盘");
  } finally {
    alwaysFailIfIncludes = null;
  }
});

// ─── 动态术语表 ───

await check("术语表：首轮抽取 → 注入全部批次 prompt → 随译本落盘", async () => {
  mkdirSync(paperDir("p4"), { recursive: true });
  glossaryCalls.length = 0;
  calls.length = 0;
  const result = await translatePaper({ paperId: "p4", markdown: MD12 });
  assert(result.translated === 12, `12 块应全部翻译，got ${result.translated}`);
  assert(glossaryCalls.length === 1, `术语表应抽取 1 次，got ${glossaryCalls.length}`);
  assert(glossaryCalls[0].includes("标题") === false, "无 frontmatter 的 fixture 不应含标题段");
  const injected = calls.every(
    (p) => p.includes("术语表（以下术语必须严格采用给定译法") && p.includes("rock-salt → 岩盐"),
  );
  assert(injected, "全部批次 prompt 应注入术语表");
  const file = await loadPaperTranslation("p4");
  assert(file?.glossary?.length === 2, `术语表应随译本落盘 2 条，got ${file?.glossary?.length}`);
  assert(file.glossary[0].src === "rock-salt" && file.glossary[0].tgt === "岩盐", "落盘术语表内容应正确");
});

await check("术语表续翻复用（force=false 不重抽），force=true 重新抽取", async () => {
  glossaryCalls.length = 0;
  // p4 已全部翻完：续翻 pending=0 → 不抽取不调用
  await translatePaper({ paperId: "p4", markdown: MD12 });
  assert(glossaryCalls.length === 0, "全部已翻时不应再抽取术语表");
  // 手动制造缺口：改一块内容使 hash 失配 → 续翻只翻该块且复用既有术语表
  const mdChanged = MD12.replace("paragraph 3", "paragraph three changed");
  const result = await translatePaper({ paperId: "p4", markdown: mdChanged });
  assert(result.translated === 1, `应只补翻 1 块，got ${result.translated}`);
  assert(glossaryCalls.length === 0, "续翻应复用既有术语表不重抽");
  // force=true：重新抽取并重翻
  const forced = await translatePaper({ paperId: "p4", markdown: mdChanged, force: true });
  assert(forced.translated === 12, `force 应全量重翻 12 块，got ${forced.translated}`);
  assert(glossaryCalls.length === 1, "force 应重新抽取术语表");
});

await check("术语表抽取失败：不阻断翻译，批次 prompt 无术语表段", async () => {
  mkdirSync(paperDir("p6"), { recursive: true });
  glossaryBehavior = "bad";
  glossaryCalls.length = 0;
  calls.length = 0;
  try {
    const result = await translatePaper({ paperId: "p6", markdown: MD12 });
    assert(result.translated === 12, `抽取失败仍应翻完 12 块，got ${result.translated}`);
    assert(glossaryCalls.length === 1, "抽取应尝试过 1 次");
    assert(
      calls.every((p) => !p.includes("术语表（以下术语")),
      "批次 prompt 不应含术语表段",
    );
    const file = await loadPaperTranslation("p6");
    assert(!file?.glossary, "抽取失败不应落盘术语表");
  } finally {
    glossaryBehavior = "ok";
  }
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
