// D8 目录牌 + 惰性工具集单测：预算守门 / 目录牌渲染 / describeTool / useTool 转发（node 直跑）
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
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const tmp = mkdtempSync(join(tmpdir(), "lazy-tool-"));
const out = join(tmp, "lazy.mjs");
await esbuild.build({
  entryPoints: [new URL("../packages/app/src/ai/tools/lazy-toolset.ts", import.meta.url).pathname.replace(/^\//, "")],
  bundle: true,
  format: "esm",
  outfile: out,
  platform: "node",
});
const lazy = await import(`file://${out.replaceAll("\\", "/")}`);
const { shouldUseDirectoryMode, buildToolDirectoryBoard, buildLazyToolset, estimateToolsChars } = lazy;

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

// 假工具工厂（模拟已过守卫的真实工具）
const fakeTool = (description, execute) => ({ description, inputSchema: { type: "object", properties: { x: { type: "string" } } }, execute });

// ========== 预算守门 ==========
ok(shouldUseDirectoryMode({}) === false, "空工具集不进目录牌模式");
{
  const many = {};
  for (let i = 0; i < 31; i++) many[`t${i}`] = fakeTool(`工具${i}`, () => ({}));
  ok(shouldUseDirectoryMode(many) === true, "超 30 个触发");
}
{
  const fat = {};
  for (let i = 0; i < 5; i++) fat[`f${i}`] = fakeTool("x".repeat(2800), () => ({}));
  ok(estimateToolsChars(fat) > 12000 && shouldUseDirectoryMode(fat) === true, "schema 超 12k 字符触发");
}
{
  const lean = { a: fakeTool("小工具", () => ({})), b: fakeTool("小工具2", () => ({})) };
  ok(shouldUseDirectoryMode(lean) === false, "小工具集不触发");
}

// ========== 目录牌渲染 ==========
{
  const tools = {
    ragSearch: fakeTool("智能混合检索（BM25 + 向量）。\n详细说明第二行", () => ({})),
    getBooks: fakeTool("查询书籍列表和基本信息", () => ({})),
    mcp_zotero_brain_search: fakeTool("搜索学术文献并返回结果列表", () => ({})),
    mcp_zotero_brain_import: fakeTool("导入条目到 Zotero", () => ({})),
  };
  const board = buildToolDirectoryBoard(tools);
  ok(board.includes("工具目录牌") && board.includes("describeTool") && board.includes("useTool"), "流程指引就位");
  ok(board.includes("ragSearch：智能混合检索（BM25 + 向量）"), "一句话取描述首行");
  ok(!board.includes("详细说明第二行"), "多行描述截到首行");
  ok(board.includes("【内置】") && board.includes("【连接器 zotero】") || board.includes(/【连接器/), "分组渲染");
  ok(board.includes("mcp_zotero_brain_search"), "连接器工具入牌");
  ok(board.length < tools.ragSearch.description.length + 3000, "目录牌体积有界");
}

// ========== 惰性工具集 ==========
{
  const calls = [];
  const tools = {
    getBooks: fakeTool("查书列表", (args) => {
      calls.push(args);
      return { books: ["a"] };
    }),
    boom: fakeTool("会炸的工具", () => {
      throw new Error("炸了");
    }),
  };
  const lazySet = buildLazyToolset(tools);
  ok(typeof lazySet.describeTool.execute === "function" && typeof lazySet.useTool.execute === "function", "双 meta-tool 就位");

  // describeTool 命中
  const d = await lazySet.describeTool.execute({ tool: "getBooks" }, {});
  ok(d.success && d.name === "getBooks" && String(d.input_schema).includes("object"), "describeTool 返回 schema");
  // describeTool 未命中 → 可用清单
  const d2 = await lazySet.describeTool.execute({ tool: "nope" }, {});
  ok(d2.success === false && Array.isArray(d2.available_tools) && d2.available_tools.includes("getBooks"), "未命中返回可用清单");

  // useTool 转发（守卫语义：直接调真实 execute，不加壳）
  const r = await lazySet.useTool.execute({ tool: "getBooks", args: { x: "1" } }, { toolCallId: "t1" });
  ok(r.books[0] === "a" && calls[0]?.x === "1", "useTool 转发参数并透传结果");

  // useTool 未命中 / 执行异常
  const r2 = await lazySet.useTool.execute({ tool: "nope", args: {} }, {});
  ok(r2.success === false, "未命中报错不炸");
  const r3 = await lazySet.useTool.execute({ tool: "boom", args: {} }, {});
  ok(r3.success === false && String(r3.error).includes("炸了") && String(r3.hint).includes("describeTool"), "执行异常带重查提示");
}

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
