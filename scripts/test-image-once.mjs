// D4 图片一次性单测：resolveImageAttachmentsForRequest 的存根/物化分派（node 直跑，纯逻辑路径；
// 磁盘物化分支由 cdp 冒烟覆盖）。用法：node scripts/test-image-once.mjs
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
const tmp = mkdtempSync(join(tmpdir(), "img-once-"));

// 从 message-processor.ts 抽出目标函数（避开 tauri 顶层依赖——该函数内部仅动态 import attachment-service）
const src = readFileSync(new URL("../packages/app/src/ai/utils/message-processor.ts", import.meta.url), "utf8");
const fnStart = src.indexOf("export async function resolveImageAttachmentsForRequest");
const fnEnd = src.indexOf("\n}", fnStart) + 2;
writeFileSync(
  join(tmp, "resolve.ts"),
  "type UIMessage = { id: string; role: string; parts: any[] };\n" + src.slice(fnStart, fnEnd).replace("export async function", "async function") + "\nexport { resolveImageAttachmentsForRequest };\n",
);
const out = join(tmp, "resolve.mjs");
await esbuild.build({ entryPoints: [join(tmp, "resolve.ts")], bundle: true, format: "esm", outfile: out, external: ["@/services/attachment-service"] });
const { resolveImageAttachmentsForRequest } = await import(`file://${out.replaceAll("\\", "/")}`);

let pass = 0;
let fail = 0;
const ok = (v, msg) => {
  try {
    assert.ok(v, msg);
    pass++;
  } catch (e) {
    fail++;
    console.error(`FAIL: ${msg}`);
  }
};

const msg = (id, role, parts) => ({ id, role, parts });

// 场景1：三轮对话，图片在前两轮 → 前两轮降级存根，最后一轮原样
{
  const input = [
    msg("u1", "user", [
      { type: "file", mediaType: "image/png", url: "attachment://img-a.png", filename: "截图A.png" },
      { type: "text", text: "看这张" },
    ]),
    msg("a1", "assistant", [{ type: "text", text: "ok" }]),
    msg("u2", "user", [
      { type: "text", text: "再看这张" },
      { type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AAA", filename: "B.jpg" },
    ]),
    msg("a2", "assistant", [{ type: "text", text: "ok2" }]),
    msg("u3", "user", [{ type: "text", text: "谢谢" }]),
  ];
  const r = await resolveImageAttachmentsForRequest(input);
  const u1Parts = r[0].parts;
  ok(u1Parts.length === 2 && u1Parts[0].type === "text", "u1 图片降级为 text 存根");
  ok(String(u1Parts[0].text).includes("attachment://img-a.png"), "存根保留引用");
  ok(String(u1Parts[0].text).includes("readImage"), "存根指路 readImage");
  const u2Parts = r[2].parts;
  ok(u2Parts.length === 2 && u2Parts[1].type === "text", "u2 存量 dataUrl 同样降级");
  ok(String(u2Parts[1].text).includes("已分析过"), "存量存根文案");
  ok(input[0].parts[0].type === "file", "原数组未被改动（请求期副本语义）");
}

// 场景2：最后一轮带 attachment:// 引用（走物化分支——此处无 Tauri 环境，
// readImageAttachment 动态 import 会失败 → 期望保持原 part 不炸（容错路径））
{
  const input = [
    msg("u1", "user", [{ type: "text", text: "hi" }]),
    msg("a1", "assistant", [{ type: "text", text: "hello" }]),
    msg("u2", "user", [
      { type: "text", text: "新图" },
      { type: "file", mediaType: "image/png", url: "attachment://img-new.png", filename: "新图.png" },
    ]),
  ];
  const r = await resolveImageAttachmentsForRequest(input);
  const u2Parts = r[2].parts;
  ok(u2Parts[1].type === "file", "最后一条 user 的引用 part 结构保留（物化在 Tauri 环境由 CDP 冒烟覆盖）");
  ok(u2Parts[1].url === "attachment://img-new.png", "无 Tauri 时引用原样透传（不炸请求）");
}

// 场景3：无 user 消息 / 无 file part 的数组原样返回
{
  const input = [msg("a1", "assistant", [{ type: "text", text: "x" }])];
  const r = await resolveImageAttachmentsForRequest(input);
  ok(r === input, "无 user 消息原样返回");
}

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
