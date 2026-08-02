import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
// 对齐服务（paper-alignment-service.ts）无头集成测试：
// esbuild 打包真实服务（stub 掉 llama-store / utils-model / translation-service 三个 Tauri 依赖），
// 本地 mock embed 服务器（OpenAI 格式，确定性向量）驱动两相位（句级 + 词级）全链路。
// 覆盖：句词两级自动连算与写回（align/alignW/alignWStatus）、词对内容精确断言、
//       幂等（二次运行零 HTTP 调用）、force 全量重建、词级 embed 全挂不影响句级（partial 可重试）、
//       单片失败仅牵连该片块（分片隔离）、无嵌入能力 skipped、inspectPaperAlignment 覆盖统计。
// 运行：node scripts/test-paper-alignment-service.mjs
import { createServer } from "node:http";
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

// ─── mock embed 服务器：token 文本 → 确定性向量（语义组 → 维度） ───

const DIMS = new Map(
  Object.entries({
    Deep: 0,
    深: 0,
    度: 0,
    learning: 1,
    学: 1,
    习: 1,
    works: 2,
    有: 2,
    效: 2,
    It: 3,
    它: 3,
    is: 4,
    很: 4,
    great: 5,
    好: 5,
  }),
);
const TOKEN_RE = /[A-Za-z0-9]+|[一-鿿]/g;
function vecFor(text) {
  const v = new Array(8).fill(0);
  for (const m of text.matchAll(TOKEN_RE)) {
    const d = DIMS.get(m[0]);
    if (d !== undefined) v[d] += 1;
  }
  return v;
}

let reqCount = 0;
let batchCap = 0; // >0 时模拟供应商批量上限（超出返回 HTTP 400）
const failSet = new Set(); // 全局请求序号（1 起）置 500，模拟分片失败
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    reqCount += 1;
    if (failSet.has(reqCount)) {
      res.writeHead(500).end("boom");
      return;
    }
    const parsed = JSON.parse(body);
    if (batchCap > 0 && parsed.input.length > batchCap) {
      res.writeHead(400).end(JSON.stringify({ error: { message: "batch too large" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: parsed.input.map((t, i) => ({ embedding: vecFor(t), index: i })) }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
globalThis.__EMBED_URL__ = `http://127.0.0.1:${server.address().port}/embed`;

// ─── stub 模块（替代 Tauri 依赖） ───

const stubDir = mkdtempSync(join(tmpdir(), "paper-alignment-service-"));
writeFileSync(
  join(stubDir, "stub-translation-service.mjs"),
  `let store = null;
export function __setFile(f) { store = f ? JSON.parse(JSON.stringify(f)) : null; }
export function __getFile() { return store ? JSON.parse(JSON.stringify(store)) : null; }
export async function loadPaperTranslation() { return __getFile(); }
export async function savePaperTranslation(_id, file) { store = JSON.parse(JSON.stringify(file)); }
export async function hashBlockText(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
`,
);
writeFileSync(
  join(stubDir, "stub-llama-store.mjs"),
  `let capability = true;
export function __setCapability(v) { capability = v; }
export const useLlamaStore = {
  getState: () => ({
    hasVectorCapability: () => capability,
    initializeEmbeddingService: async () => {},
  }),
};
`,
);
writeFileSync(
  join(stubDir, "stub-model.mjs"),
  `export async function getCurrentVectorModelConfig() {
  return { embeddingsUrl: globalThis.__EMBED_URL__, model: "mock-embed", apiKey: "" };
}
`,
);
// zh-tokenizer 桩：默认复刻单字路径（行为与接入前一致）；__ZH_STUB_FAKE_JIEBA__=true 时
// 按两字符一组合模拟 jieba 分词（验证词级相位消费注入的分词器，与单字路径可区分）
writeFileSync(
  join(stubDir, "stub-zh-tokenizer.mjs"),
  `import { tokenizeWords } from "@/pages/paper-reader/paper-cross-anchor";
export async function tokenizeZhBatch(texts) {
  if (globalThis.__ZH_STUB_FAKE_JIEBA__) {
    return texts.map((t) => {
      const chars = tokenizeWords(t);
      const out = [];
      for (let i = 0; i < chars.length; i += 2) {
        const last = chars[Math.min(i + 1, chars.length - 1)];
        out.push({ start: chars[i].start, end: last.end, text: t.slice(chars[i].start, last.end) });
      }
      return out;
    });
  }
  return texts.map((t) => tokenizeWords(t).map((tok) => ({ start: tok.start, end: tok.end, text: t.slice(tok.start, tok.end) })));
}
`,
);
writeFileSync(
  join(stubDir, "entry.mjs"),
  `export { alignPaperTranslation, inspectPaperAlignment } from "@/services/paper-alignment-service";
export { cutPaperBlocks } from "@/pages/paper-reader/paper-blocks";
export { __getFile, __setFile, hashBlockText } from "./stub-translation-service.mjs";
export { __setCapability } from "./stub-llama-store.mjs";
`,
);

const stubPlugin = {
  name: "paper-stubs",
  setup(build) {
    build.onResolve({ filter: /^\.\/paper-translation-service$/ }, () => ({
      path: join(stubDir, "stub-translation-service.mjs"),
    }));
    build.onResolve({ filter: /^\.\/zh-tokenizer$/ }, () => ({ path: join(stubDir, "stub-zh-tokenizer.mjs") }));
    build.onResolve({ filter: /^@\/store\/llama-store$/ }, () => ({ path: join(stubDir, "stub-llama-store.mjs") }));
    build.onResolve({ filter: /^@\/utils\/model$/ }, () => ({ path: join(stubDir, "stub-model.mjs") }));
    build.onResolve({ filter: /^@\/(.*)/ }, (args) => {
      const base = join(root, "packages/app/src", args.path.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, join(base, "index.ts")]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
      }
      return { path: `${base}.ts` }; // 让 esbuild 报出带路径的缺失错误
    });
  },
};

const outfile = join(stubDir, "bundle.mjs");
await esbuild.build({
  entryPoints: [join(stubDir, "entry.mjs")],
  bundle: true,
  format: "esm",
  outfile,
  plugins: [stubPlugin],
});
const { JSDOM } = await import("jsdom");
// remark 链的 decode-named-character-reference 在模块顶层调用 document.createElement，node 下用 jsdom 垫片
globalThis.document = new JSDOM("").window.document;
const {
  alignPaperTranslation,
  inspectPaperAlignment,
  cutPaperBlocks,
  __getFile,
  __setFile,
  __setCapability,
  hashBlockText,
} = await import(pathToFileURL(outfile).href);

// ─── 数据：块 1 小规模确定性（内容断言）；块 2 三百词（撑出多个词级分片） ───
// 注意块 2 词首字母大写：切句器要求终止符后为大写/数字/CJK 才成句界（小写不切）

const para1 = "Deep learning works. It is great.";
const zh1 = "深度学习有效。它很好。";
const para2 = Array.from(
  { length: 10 },
  (_, i) => `${Array.from({ length: 30 }, (_, j) => `W${i}s${j}`).join(" ")}.`,
).join(" ");
const zh2 = Array.from(
  { length: 10 },
  (_, i) => `${Array.from({ length: 30 }, (_, j) => String.fromCodePoint(0x4e00 + i * 30 + j)).join("")}。`,
).join("");
const markdown = `${para1}\n\n${para2}`;

async function seedFile() {
  const blocks = {};
  for (const block of cutPaperBlocks(markdown)) {
    if (!block.translatable) continue;
    blocks[String(block.index)] = { hash: await hashBlockText(block.sourceText), text: block.index === 0 ? zh1 : zh2 };
  }
  __setFile({ version: 1, lang: "zh", updatedAt: new Date().toISOString(), blocks });
  return blocks;
}

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

const resetRequests = () => {
  reqCount = 0;
  failSet.clear();
};

// ─── 全链路：句词两级一次算完并写回 ───

resetRequests();
__setCapability(true);
const seeded = await seedFile();
const index0 = Object.keys(seeded)[0];
const index1 = Object.keys(seeded)[1];
const first = await alignPaperTranslation({ paperId: "p", markdown });

check("全链路：句词两级 status=done 且各算 2 块", () => {
  assert(first.status === "done", `status: ${first.status}`);
  assert(first.computed === 2 && first.reused === 0, `句级: ${JSON.stringify(first)}`);
  assert(first.words.status === "done" && first.words.computed === 2, `词级: ${JSON.stringify(first.words)}`);
});

check("全链路：句对齐写回（内容精确）", () => {
  const entry = __getFile().blocks[index0];
  const got = entry.align.map((p) => `${p.ss},${p.se}->${p.ts},${p.te}`);
  assert(JSON.stringify(got) === JSON.stringify(["0,20->0,7", "21,33->7,11"]), `align: ${JSON.stringify(entry.align)}`);
  assert(entry.alignHash, "alignHash 应写入");
});

check("全链路：词对齐写回（划词内容精确到词/字）", () => {
  const file = __getFile();
  const entry = file.blocks[index0];
  const srcText = para1;
  const got = entry.alignW.map((p) => `${srcText.slice(p.ss, p.se)}→${zh1.slice(p.ts, p.te)}`);
  const expected = ["Deep→深度", "learning→学习", "works→有效", "It→它", "is→很", "great→好"];
  assert(JSON.stringify(got) === JSON.stringify(expected), `alignW: ${JSON.stringify(got)}`);
  assert(entry.alignWHash.startsWith(entry.alignHash), "词级幂等键含同一译文 hash（另有分词器版本后缀）");
  assert(file.alignWStatus === "done", `alignWStatus: ${file.alignWStatus}`);
});

// ─── 幂等：二次运行全部复用、零 HTTP 调用 ───

resetRequests();
const second = await alignPaperTranslation({ paperId: "p", markdown });

check("幂等：二次运行句词全复用且零 embed 请求", () => {
  assert(second.computed === 0 && second.reused === 2, `句级: ${JSON.stringify(second)}`);
  assert(second.words.computed === 0 && second.words.reused === 2, `词级: ${JSON.stringify(second.words)}`);
  assert(reqCount === 0, `不应发起 embed 请求，实际 ${reqCount} 次`);
});

// ─── force：句词两级全量重建 ───

resetRequests();
const forced = await alignPaperTranslation({ paperId: "p", markdown, force: true });

check("force：句词两级全部重算", () => {
  assert(forced.computed === 2 && forced.reused === 0, `句级: ${JSON.stringify(forced)}`);
  assert(forced.words.computed === 2 && forced.words.reused === 0, `词级: ${JSON.stringify(forced.words)}`);
  assert(reqCount === 11, `句 1 片 + 词 10 片共 11 次请求（615 token / 64 条每片），实际 ${reqCount}`);
});

// ─── 降级：词级 embed 全挂不影响句级，恢复后可补齐 ───

await seedFile(); // 重置为无对齐的译本
resetRequests();
failSet.add(2).add(3).add(4); // 句级第 1 片放行，词级前 3 片全挂（两块均沾片→均失败）
const degraded = await alignPaperTranslation({ paperId: "p", markdown });

check("降级：词级 embed 全挂 → 句级 done、词级 partial 且不落 alignW", () => {
  assert(degraded.status === "done" && degraded.computed === 2, `句级: ${JSON.stringify(degraded)}`);
  assert(degraded.words.status === "partial" && degraded.words.failed === 2, `词级: ${JSON.stringify(degraded.words)}`);
  const file = __getFile();
  assert(
    file.alignStatus === "done" && file.alignWStatus === "partial",
    `状态: ${file.alignStatus}/${file.alignWStatus}`,
  );
  assert(file.blocks[index0].align && !file.blocks[index0].alignW, "句级落库、词级不落");
});

resetRequests();
const retried = await alignPaperTranslation({ paperId: "p", markdown });

check("降级恢复：句级复用、词级补齐", () => {
  assert(retried.computed === 0 && retried.reused === 2, `句级复用: ${JSON.stringify(retried)}`);
  assert(retried.words.computed === 2 && retried.words.status === "done", `词级补齐: ${JSON.stringify(retried.words)}`);
  assert(__getFile().alignWStatus === "done", "alignWStatus 回到 done");
});

// ─── 分片隔离：词级第 2 片失败只牵连跨片的大块，小块正常 ───

await seedFile();
resetRequests();
failSet.add(3); // 全局第 3 次请求 = 词级第 2 片（句级 1 片 + 词级片 1/2/3）
const isolated = await alignPaperTranslation({ paperId: "p", markdown });

check("分片隔离：单片失败仅牵连该片覆盖的块", () => {
  assert(isolated.words.status === "partial", `词级: ${JSON.stringify(isolated.words)}`);
  assert(isolated.words.computed === 1 && isolated.words.failed === 1, `词级: ${JSON.stringify(isolated.words)}`);
  const file = __getFile();
  assert(file.blocks[index0].alignW, `小块（全在第 1 片）应算成: ${JSON.stringify(file.blocks[index0])}`);
  assert(!file.blocks[index1].alignW, "大块（跨片含失败片）应跳过且不写 alignWHash");
  assert(!file.blocks[index1].alignWHash, "失败块不写 alignWHash（下次重试）");
});

resetRequests();
const healed = await alignPaperTranslation({ paperId: "p", markdown });

check("分片恢复：失败块补齐、成功块复用", () => {
  assert(healed.words.computed === 1 && healed.words.reused === 1, `词级: ${JSON.stringify(healed.words)}`);
  assert(healed.words.status === "done", `词级: ${JSON.stringify(healed.words)}`);
});

// ─── 自适应分批：供应商上限 10 条（DashScope 级）也能句词两级全部完成 ───

await seedFile();
resetRequests();
batchCap = 10;
const adapted = await alignPaperTranslation({ paperId: "p", markdown });

check("自适应分批：供应商限 10 条时句词两级全部完成", () => {
  assert(adapted.status === "done" && adapted.computed === 2, `句级: ${JSON.stringify(adapted)}`);
  assert(adapted.words.status === "done" && adapted.words.computed === 2, `词级: ${JSON.stringify(adapted.words)}`);
  assert(__getFile().alignWStatus === "done", "alignWStatus 应为 done");
});
batchCap = 0;

// ─── 无嵌入能力：skipped，零 HTTP 调用 ───

await seedFile();
resetRequests();
__setCapability(false);
const skipped = await alignPaperTranslation({ paperId: "p", markdown });

check("无嵌入能力：skipped + 原因 + 零请求（翻译本体不受影响）", () => {
  assert(skipped.status === "skipped" && skipped.reason === "no-vector-capability", JSON.stringify(skipped));
  assert(skipped.words.status === "skipped", `词级: ${JSON.stringify(skipped.words)}`);
  assert(reqCount === 0, `不应发起 embed 请求，实际 ${reqCount}`);
  assert(__getFile().alignStatus === "skipped", "alignStatus=skipped");
});
__setCapability(true);

// ─── inspectPaperAlignment：覆盖统计 ───

const info = await inspectPaperAlignment(markdown, __getFile());

check("inspectPaperAlignment：句/词覆盖统计", () => {
  // 上一用例跳过了对齐（无嵌入能力），此处应为 0/2
  assert(info && info.total === 2 && info.aligned === 0 && info.alignedW === 0, JSON.stringify(info));
});

resetRequests();
await alignPaperTranslation({ paperId: "p", markdown });
const info2 = await inspectPaperAlignment(markdown, __getFile());

check("inspectPaperAlignment：对齐完成后 2/2", () => {
  assert(info2 && info2.total === 2 && info2.aligned === 2 && info2.alignedW === 2, JSON.stringify(info2));
});

// ─── jieba 分词接入：词级相位消费注入的中文分词器（两字符词落入 alignW，区别于单字路径） ───

globalThis.__ZH_STUB_FAKE_JIEBA__ = true;
resetRequests();
await seedFile();
const jiebaRes = await alignPaperTranslation({ paperId: "p", markdown });
check("jieba 分词：alignW 中文区间按注入分词成词（非单字）", () => {
  assert(jiebaRes.words.status === "done", `词级: ${JSON.stringify(jiebaRes.words)}`);
  const entry = __getFile().blocks[index0];
  const tgtTexts = entry.alignW.map((p) => zh1.slice(p.ts, p.te));
  assert(tgtTexts.includes("深度"), `应含两字符词'深度': ${JSON.stringify(tgtTexts)}`);
  assert(tgtTexts.includes("学习"), `应含两字符词'学习': ${JSON.stringify(tgtTexts)}`);
});
globalThis.__ZH_STUB_FAKE_JIEBA__ = false;

// ─── DP 无解兜底：两侧句数比超 maxGroup（5:2）→ 整块单对（low），不是零对齐 ───

const srcUnsolvable = "Alpha one runs. Beta two walks. Gamma three jumps. Delta four swims. Epsilon five flies.";
const tgtUnsolvable = "甲一跑。乙二走。";
const mdUnsolvable = srcUnsolvable;
{
  const blocks = {};
  for (const block of cutPaperBlocks(mdUnsolvable)) {
    if (!block.translatable) continue;
    blocks[String(block.index)] = { hash: await hashBlockText(block.sourceText), text: tgtUnsolvable };
  }
  __setFile({ version: 1, lang: "zh", updatedAt: new Date().toISOString(), blocks });
  resetRequests();
  const res = await alignPaperTranslation({ paperId: "p", markdown: mdUnsolvable });
  check("DP 无解兜底：整块单对（low）而不是空表", () => {
    assert(res.status === "done", `status: ${res.status}`);
    const entry = __getFile().blocks["0"];
    assert(Array.isArray(entry.align) && entry.align.length === 1, `align: ${JSON.stringify(entry.align)}`);
    const p = entry.align[0];
    assert(p.low === true, "兜底对应标 low");
    assert(p.ss === 0 && p.ts === 0, `兜底对从块首开始: ${JSON.stringify(p)}`);
    assert(p.se === srcUnsolvable.length && p.te === tgtUnsolvable.length, `兜底对覆盖整块: ${JSON.stringify(p)}`);
  });
}

server.close();
rmSync(stubDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
