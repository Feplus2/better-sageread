// Task 5 L1：论文 canonical 半开窗口、绝对 UTF-16 offset 与 canonical-match。
// 运行：node scripts/test-document-window.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) {
  console.error("FAIL 未找到 esbuild");
  process.exit(1);
}
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const outDir = mkdtempSync(join(tmpdir(), "document-window-"));
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));
const asUrl = (path) => pathToFileURL(path).href;
const tsPath = (path) => path.replace(/\\/g, "/");

const STUBS = {
  "@tauri-apps/api/path": "export const appDataDir = async () => globalThis.__SAGEREAD_TEST_APP_DATA__;",
  "@tauri-apps/api/core": `
    export async function invoke(command) {
      if (command === "plugin:epub|paper_index_status") return { indexed: true, chunkCount: 84 };
      throw new Error("unexpected invoke: " + command);
    }
  `,
  "@tauri-apps/plugin-fs": `
    import { existsSync } from "node:fs";
    import { readFile, readdir } from "node:fs/promises";
    export const exists = async (path) => existsSync(path);
    export const readTextFile = (path) => readFile(path, "utf8");
    export const readDir = async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  `,
};

async function bundle(entrySource, name) {
  const entry = join(outDir, `${name}-entry.ts`);
  const outfile = join(outDir, `${name}.mjs`);
  writeFileSync(entry, entrySource);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    alias: { "@": src },
    plugins: [
      {
        name: "document-window-test-stubs",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            STUBS[args.path] ? { path: args.path, namespace: "document-stub" } : null,
          );
          build.onLoad({ filter: /.*/, namespace: "document-stub" }, (args) => ({
            contents: STUBS[args.path],
            loader: "js",
          }));
          build.onResolve({ filter: /^@\/services\/reading-position\/position-service$/ }, () => ({
            path: "position-service",
            namespace: "position-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "position-stub" }, () => ({
            contents: `
              export const resolveLiveReadingPosition = async () => globalThis.__DOCUMENT_POSITION__ ?? null;
              export const readPositionWindow = async (snapshot, options) => {
                if (!globalThis.__DOCUMENT_POSITION_WINDOW__) throw new Error("position not used in this test");
                return globalThis.__DOCUMENT_POSITION_WINDOW__(snapshot, options);
              };
              export const shortMdPath = (path) => path;
            `,
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(asUrl(outfile));
}

const mod = await bundle(
  [
    `export { createReadDocumentTool } from "${tsPath(join(src, "ai/tools/document/read-document.ts"))}";`,
    `export { findSectionHeading, parsePaperSections } from "${tsPath(join(src, "pages/paper-reader/markdown-sections.ts"))}";`,
  ].join("\n"),
  "document-window",
);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    const suffix = detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    console.log(`  FAIL ${name}${suffix}`);
  }
}

let callId = 0;
function execute(tool, args) {
  return tool.execute({ reasoning: "Task 5 window regression", ...args }, { toolCallId: `w${++callId}`, messages: [] });
}
function makeTools(paperId) {
  return mod.createReadDocumentTool({ scope: "paper", currentId: paperId, retrievalScope: "current" });
}
function brief(result) {
  return {
    textLength: String(result?.text ?? "").length,
    textStart: String(result?.text ?? "").slice(0, 60),
    next_offset: result?.next_offset,
    truncated: result?.truncated,
  };
}

const fixtureApp = join(outDir, "fixture-app");
const fixtureId = "window-fixture";
const fixtureDir = join(fixtureApp, "books", fixtureId);
mkdirSync(fixtureDir, { recursive: true });
const sectionText = `${"A".repeat(400)}😀${"0123456789abcdefghijklmnopqrstuvwxyz".repeat(48).slice(0, 1698)}`;
const fixtureMarkdown = `---\ntitle: Window fixture\n---\n# Alpha\n${sectionText}\n# Beta\n12345`;
writeFileSync(join(fixtureDir, "paper.md"), fixtureMarkdown);
globalThis.__SAGEREAD_TEST_APP_DATA__ = fixtureApp;

const parsed = mod.parsePaperSections(fixtureMarkdown);
const alpha = mod.findSectionHeading(parsed, "Alpha");
const beta = mod.findSectionHeading(parsed, "Beta");
const fixtureTools = makeTools(fixtureId);

console.log("[1] heading 连续三窗：绝对 UTF-16 next_offset，无重不漏");
const first = await execute(fixtureTools, { doc: `paper:${fixtureId}`, heading: "Alpha", after: 500 });
const second = await execute(fixtureTools, {
  doc: `paper:${fixtureId}`,
  heading: "Alpha",
  offset: first.next_offset,
  after: 500,
});
const third = await execute(fixtureTools, {
  doc: `paper:${fixtureId}`,
  heading: "Alpha",
  offset: second.next_offset,
  after: 500,
});
check("第一窗精确内容", first.text === sectionText.slice(0, 500), brief(first));
check("第一窗 next_offset=508", first.next_offset === 508, first.next_offset);
check("第二窗精确内容", second.text === sectionText.slice(500, 1000), brief(second));
check("第二窗 next_offset=1008", second.next_offset === 1008, second.next_offset);
check("第三窗精确内容", third.text === sectionText.slice(1000, 1500), brief(third));
check("第三窗 next_offset=1508", third.next_offset === 1508, third.next_offset);
check(
  "三窗拼接等于 canonical 半开区间 [contentStart, contentStart+1500)",
  `${first.text}${second.text}${third.text}` === parsed.body.slice(alpha.contentStart, alpha.contentStart + 1500),
);
check("emoji 在三窗中恰好一次且不丢", `${first.text}${second.text}${third.text}`.split("😀").length === 2);

console.log("[2] before/after、heading 命中扩窗、短节与 EOF");
const early = await execute(fixtureTools, { doc: `paper:${fixtureId}`, offset: 2, before: 10, after: 500 });
check("before>offset 只补实际存在的 before", early.text === parsed.body.slice(0, 502), brief(early));
check("before>offset next_offset=502", early.next_offset === 502, early.next_offset);
const ordinary = await execute(fixtureTools, { doc: `paper:${fixtureId}`, offset: 1000, before: 200, after: 500 });
check(
  "普通 offset 窗口精确为 [800,1500)",
  ordinary.text === parsed.body.slice(800, 1500) && ordinary.next_offset === 1500,
  brief(ordinary),
);
const hitContext = await execute(fixtureTools, {
  doc: `paper:${fixtureId}`,
  heading: "Alpha",
  offset: 1008,
  before: 200,
  after: 500,
});
check("heading+绝对 offset 可叠加 before/after", hitContext.text === parsed.body.slice(808, 1508), brief(hitContext));
const short = await execute(fixtureTools, { doc: `paper:${fixtureId}`, heading: "Beta", after: 6000 });
check("短节不多读", short.text === "12345" && short.next_offset === null && short.truncated === false, brief(short));
const eof = await execute(fixtureTools, {
  doc: `paper:${fixtureId}`,
  offset: parsed.body.length,
  before: 10,
  after: 500,
});
check("EOF before 只读末尾且不续读", eof.text === parsed.body.slice(-10) && eof.next_offset === null, brief(eof));
check("heading contentStart 是正文绝对坐标", alpha.contentStart === 8 && beta.start === 2109, {
  alpha: alpha.contentStart,
  beta: beta.start,
});

console.log("[3] 真实 Rational：旧 REFERENCES next_offset 重放不得为空或跳过");
const appData = process.env.APPDATA;
const rationalId = "a27b187c6bd02d3c";
const rationalDir = appData ? join(appData, "com.bettersageread.dev", "books", rationalId) : "";
check("真实 Rational paper.md 存在", !!rationalDir && existsSync(join(rationalDir, "paper.md")), rationalDir);
if (rationalDir && existsSync(join(rationalDir, "paper.md"))) {
  globalThis.__SAGEREAD_TEST_APP_DATA__ = dirname(dirname(rationalDir));
  const rationalMarkdown = readFileSync(join(rationalDir, "paper.md"), "utf8");
  const rationalParsed = mod.parsePaperSections(rationalMarkdown);
  const references = mod.findSectionHeading(rationalParsed, "REFERENCES AND NOTES");
  const referencesIndex = rationalParsed.headings.indexOf(references);
  const nextHeading = rationalParsed.headings.slice(referencesIndex + 1).find((item) => item.level <= references.level);
  const sectionEnd = nextHeading ? nextHeading.start : rationalParsed.body.length;
  check(
    "Rational canonical 验收坐标 contentStart=18167 / sectionEnd=19914",
    references.contentStart === 18167 && sectionEnd === 19914,
    { contentStart: references.contentStart, sectionEnd },
  );
  const firstEnd = 18667;
  const replayEnd = 19167;
  const rationalTools = makeTools(rationalId);
  const rationalFirst = await execute(rationalTools, {
    doc: `paper:${rationalId}`,
    heading: "REFERENCES AND NOTES",
    after: 500,
  });
  check("Rational 第一窗 next_offset=18667（正文绝对位置）", rationalFirst.next_offset === firstEnd, {
    expected: firstEnd,
    actual: rationalFirst.next_offset,
  });
  const replay = await execute(rationalTools, {
    doc: `paper:${rationalId}`,
    heading: "REFERENCES AND NOTES",
    offset: rationalFirst.next_offset,
    after: 500,
  });
  check("Rational 回归夹具自身确有第二窗", replayEnd > firstEnd, { firstEnd, replayEnd, sectionEnd });
  check("Rational 旧 next_offset 重放非空", String(replay.text || "").length > 0, brief(replay));
  check(
    "Rational 重放精确衔接 canonical，不重复 contentStart",
    replay.text === rationalParsed.body.slice(firstEnd, replayEnd),
    { expectedStart: firstEnd, expectedEnd: replayEnd, actual: brief(replay) },
  );
  check(
    "Rational 第二窗 next_offset 正确",
    replay.next_offset === (replayEnd < sectionEnd ? replayEnd : null),
    replay.next_offset,
  );
}

console.log("[4] canonical-match：空白归一化映射原索引，不确定时降级 section");
let matchMod = null;
let matchLoadError = "";
try {
  const matchSource = join(src, "ai/tools/document/canonical-match.ts");
  if (!existsSync(matchSource)) throw new Error("canonical-match.ts 不存在");
  matchMod = await bundle(`export { findCanonicalMatch } from "${tsPath(matchSource)}";`, "canonical-match");
} catch (error) {
  matchLoadError = error instanceof Error ? error.message : String(error);
}
check("canonical-match 模块可加载", !!matchMod?.findCanonicalMatch, matchLoadError);
const findMatch = (canonical, snippet) => {
  if (!matchMod?.findCanonicalMatch) return null;
  try {
    return matchMod.findCanonicalMatch(canonical, snippet);
  } catch (error) {
    return { error: String(error) };
  }
};
const canonical = "Head\nAlpha   beta\n\tgamma 😀 tail";
const normalized = findMatch(canonical, "  Alpha beta   gamma 😀  ");
check(
  "归一化命中映射到原始 UTF-16 offset=5",
  normalized?.offset === 5 && normalized?.anchor_precision === "exact",
  normalized,
);
check(
  "归一化命中可由原正文直接验证",
  normalized?.offset === 5 && canonical.slice(normalized.offset).startsWith("Alpha   beta\n\tgamma 😀"),
  normalized,
);
const missing = findMatch(canonical, "not present");
check(
  "无法精确验证时返回 section 且无 offset",
  missing?.anchor_precision === "section" && missing?.offset == null,
  missing,
);
const ambiguous = findMatch("same\n\nsame", "same");
check("重复命中不伪造唯一 offset", ambiguous?.anchor_precision === "section" && ambiguous?.offset == null, ambiguous);
const clipped = findMatch("Before cationic   potential after", "cationic potential …");
check("检索省略号前缀可映射且验证原索引", clipped?.offset === 7 && clipped?.anchor_precision === "exact", clipped);

console.log("[5] position 使用全文坐标连续读取：frontmatter + normalized math + emoji");
{
  globalThis.__SAGEREAD_TEST_APP_DATA__ = fixtureApp;
  const positionId = "position-fixture";
  const positionDir = join(fixtureApp, "books", positionId);
  mkdirSync(positionDir, { recursive: true });
  const raw = `---\r\ntitle: Position fixture\r\n---\r\n# Alpha\r\nBefore \\(x^2\\) 😀 tail-${"0123456789abcdef".repeat(100)}`;
  writeFileSync(join(positionDir, "paper.md"), raw);
  const chars = Array.from(raw);
  const slice = (start, end) => chars.slice(start, end).join("");
  const initial = chars.findIndex((char, index) => char === "\\" && chars[index + 1] === "(");
  globalThis.__DOCUMENT_POSITION__ = {
    scope: "paper",
    docId: positionId,
    label: "Alpha",
    labelSource: "toc",
    mdRelPath: "paper.md",
    mdLength: chars.length,
    charOffset: initial,
    percentInDoc: 0,
    chunkRange: null,
    chunkTotal: null,
    overallPercent: 0,
    spineIndex: null,
    spineTotal: null,
    cfi: null,
  };
  globalThis.__DOCUMENT_POSITION_WINDOW__ = async (snapshot, options) => {
    const before = Math.max(0, options?.before ?? 0);
    const after = Math.max(500, options?.after ?? 6000);
    const start = Math.max(0, snapshot.charOffset - before);
    const end = Math.min(chars.length, start + before + after);
    return {
      text: slice(start, end),
      start,
      end,
      totalLength: chars.length,
      mdRelPath: "paper.md",
      nextOffset: end < chars.length ? end : null,
    };
  };
  try {
    const tools = makeTools(positionId);
    const first = await execute(tools, { position: true, after: 500 });
    check("position 首窗来自原始全文而非 canonical body", first.text === slice(initial, initial + 500), {
      expected: slice(initial, initial + 40),
      actual: String(first.text || "").slice(0, 40),
      range: first.range,
    });
    check("position range.end 使用 Rust window.end 且兼容 emoji", first.range?.end === initial + 500, {
      expected: initial + 500,
      actual: first.range,
    });
    const second = await execute(tools, { position: true, offset: first.next_offset, after: 500 });
    check("position+next_offset 仍在全文坐标续读", second.text === slice(initial + 500, initial + 1000), {
      expected: slice(initial + 500, initial + 540),
      actual: String(second.text || "").slice(0, 40),
      range: second.range,
    });
    check("position 续读 range.end 与 replay offset 一致", second.range?.end === initial + 1000 && second.read?.offset === initial + 500 && second.read?.position === true, {
      expected: initial + 1000,
      actual: { range: second.range, read: second.read },
    });
    const joined = first.text + second.text;
    check("frontmatter/CRLF 数学与 emoji 跨窗无重不漏", joined === slice(initial, initial + 1000) && joined.includes("\\(x^2\\) 😀") && !joined.includes("frontmatter"), {
      initial,
      joinedStart: joined.slice(0, 60),
      joinedLength: joined.length,
    });
  } finally {
    globalThis.__DOCUMENT_POSITION__ = undefined;
    globalThis.__DOCUMENT_POSITION_WINDOW__ = undefined;
  }
}

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS document-window Task 5");
