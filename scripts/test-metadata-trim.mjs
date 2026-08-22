// D2 metadata 保守档裁剪单测：esbuild 打包 prompt.ts（仅 trimMetadataForPrompt 纯函数路径）
// 用法：node scripts/test-metadata-trim.mjs
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

const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const tmp = mkdtempSync(join(tmpdir(), "meta-trim-"));

// 从 prompt.ts 源文件里抽出 trimMetadataForPrompt（避免整文件打包引入 tauri 依赖）
const src = readFileSync(new URL("../packages/app/src/constants/prompt.ts", import.meta.url), "utf8");
const fnStart = src.indexOf("function trimMetadataForPrompt");
const fnEnd = src.indexOf("\n}", fnStart) + 2;
const fnSource = src.slice(fnStart, fnEnd) + "\nexport { trimMetadataForPrompt };\n";
writeFileSync(join(tmp, "trim.ts"), fnSource);

const out = join(tmp, "trim.mjs");
await esbuild.build({ entryPoints: [join(tmp, "trim.ts")], bundle: true, format: "esm", outfile: out });
const { trimMetadataForPrompt } = await import(`file://${out.replaceAll("\\", "/")}`);

const HINT = "（HINT）";
let pass = 0;
let fail = 0;
const eq = (a, b, msg) => {
  try {
    assert.strictEqual(a, b);
    pass++;
  } catch (e) {
    fail++;
    console.error(`FAIL: ${msg}\n  ${e.message.slice(0, 300)}`);
  }
};
const ok = (v, msg) => {
  assert.ok(v, msg);
  pass++;
};

const MD = `# 测试书

书籍元信息

- 标题: 测试书
- 作者: 张三

## 目录

说明：每项显示章节标题。

- 封面
- 前言
- 第一章 开始
  - 一、起点
  - 二、发展
- 第二章 深入
  - 一、原理
    - 细节甲
    - 细节乙
  - 二、应用
- 第三章 收尾
  - 一、总结
`;

// 1) 无目录标记 → 原样返回
eq(trimMetadataForPrompt("只是元信息没有目录", "第一章", HINT), "只是元信息没有目录", "无目录原样返回");

// 2) 无匹配章节 → 一级平铺（无二级内容）
{
  const r = trimMetadataForPrompt(MD, "第X章", HINT);
  ok(r.includes("- 第一章 开始") && r.includes("- 第三章 收尾"), "一级章节保留");
  ok(!r.includes("一、起点"), "未匹配时二级剔除");
  ok(r.includes("说明：每项显示章节标题"), "目录说明行保留");
  ok(r.endsWith(HINT), "hint 拼接在尾");
}

// 3) 匹配二级（当前章=第二章 一、原理）→ 一级平铺 + 祖先链 + 子树
{
  const r = trimMetadataForPrompt(MD, "一、原理", HINT);
  ok(r.includes("- 第二章 深入"), "匹配项的父章保留");
  ok(r.includes("一、原理"), "匹配项自身保留");
  ok(r.includes("细节甲") && r.includes("细节乙"), "匹配项子树保留");
  ok(!r.includes("二、应用"), "同级兄弟剔除");
  ok(!r.includes("一、起点"), "其他章二级剔除");
}

// 4) 匹配一级（当前章=第二章）→ 该章全部子树保留
{
  const r = trimMetadataForPrompt(MD, "第二章 深入", HINT);
  ok(r.includes("一、原理") && r.includes("二、应用") && r.includes("细节乙"), "整章子树保留");
  ok(!r.includes("一、起点") && !r.includes("一、总结"), "他章二级剔除");
}

// 5) 无 sectionLabel → 一级平铺
{
  const r = trimMetadataForPrompt(MD, undefined, HINT);
  ok(!r.includes("细节甲"), "无标签时深层剔除");
}

// 6) 体积对比：裁剪后显著小于原文
{
  const big = MD.repeat(1);
  const r = trimMetadataForPrompt(MD, "第二章 深入", HINT);
  ok(r.length < MD.length, `裁剪后 ${r.length} < 原 ${MD.length}`);
}

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
