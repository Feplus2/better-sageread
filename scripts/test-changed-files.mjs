import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const esbuildPkg = readdirSync(join(root, "node_modules", ".pnpm")).find((d) => d.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(root, "node_modules", ".pnpm", esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
let passed = 0;
let failed = 0;
async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

const outDir = mkdtempSync(join(tmpdir(), "changed-files-"));
const entry = join(outDir, "entry.ts");
const output = join(outDir, "bundle.mjs");
writeFileSync(entry, `export * as changed from "${join(src, "ai/utils/changed-files.ts").replace(/\\/g, "/")}";`);
let api;
await test("changed-files 提供真实消息变更提取器", async () => {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: output,
    logLevel: "silent",
  });
  api = (await import(pathToFileURL(output).href)).changed;
  assert.equal(typeof api.collectChangedFiles, "function");
});
if (!api) {
  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(1);
}

const writeOutput = (path, success = true) => ({ results: { success, path, bytes: 12 } });
const tool = (type, id, input, output, state = "output-available") => ({ type, toolCallId: id, state, input, output });
const message = (id, parts) => ({ id, role: "assistant", parts });

await test("direct writeFile 与 directory useTool 成功结果等价", () => {
  const direct = message("m1", [
    tool("tool-writeFile", "w1", { path: "ignored-input.csv" }, writeOutput("F:/ws/out.csv")),
  ]);
  const directory = message("m1", [
    tool(
      "tool-useTool",
      "u1",
      { tool: "writeFile", args: { path: "ignored-input.csv" } },
      writeOutput("F:/ws/out.csv"),
    ),
  ]);
  for (const item of [direct, directory]) {
    const files = api.collectChangedFiles([item]);
    assert.equal(files.length, 1);
    assert.deepEqual(files[0], {
      path: "F:/ws/out.csv",
      source: "writeFile",
      toolCallId: item.parts[0].toolCallId,
      messageId: "m1",
      kind: "changed",
      verified: true,
      operationCount: 1,
      bytes: 12,
    });
  }
});

await test("editFile、失败结果和读取工具严格分流", () => {
  const files = api.collectChangedFiles([
    message("m1", [
      tool("tool-editFile", "e1", {}, { results: { success: true, path: "F:/ws/a.txt", replacements: 2 } }),
      tool("tool-writeFile", "w-denied", {}, writeOutput("F:/ws/denied.txt", false)),
      tool("tool-readLocalFile", "r1", {}, { results: { success: true, path: "F:/ws/read.txt" } }),
      tool("tool-writeFile", "w-error", {}, { errorText: "failed" }, "output-error"),
      tool("tool-writeFile", "w-missing", {}, { results: { success: true } }),
    ]),
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0].source, "editFile");
  assert.equal(files[0].replacements, 2);
  assert.equal(files[0].verified, true);
});

await test("同路径重复写编辑去重并保留最近来源", () => {
  const files = api.collectChangedFiles([
    message("m1", [tool("tool-writeFile", "w1", {}, writeOutput("F:/ws/same.txt"))]),
    message("m2", [
      tool("tool-editFile", "e2", {}, { results: { success: true, path: "F:/ws/same.txt", replacements: 1 } }),
    ]),
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0].source, "editFile");
  assert.equal(files[0].toolCallId, "e2");
  assert.equal(files[0].messageId, "m2");
  assert.equal(files[0].operationCount, 2);
});

await test("runCommand 只接受结构化 verified 产物，忽略 stdout 声称", () => {
  const output = {
    results: {
      success: false,
      stdout: "已写入 F:/ws/fake.csv",
      changes: [
        { path: "F:/ws/real.csv", kind: "created", verified: true },
        { path: "F:/ws/gone.txt", kind: "deleted", verified: true },
        { path: "F:/ws/unverified.txt", kind: "created", verified: false },
        { path: "", kind: "created", verified: true },
      ],
    },
  };
  const files = api.collectChangedFiles([
    message("m1", [tool("tool-runCommand", "c1", { command: "ignored" }, output)]),
  ]);
  assert.deepEqual(
    files.map((file) => [file.path, file.kind]),
    [
      ["F:/ws/real.csv", "created"],
      ["F:/ws/gone.txt", "deleted"],
    ],
  );
  assert.ok(files.every((file) => file.verified && file.source === "runCommand" && file.messageId === "m1"));
});

await test("输入只含目标线程的完整消息，不受尾部渲染窗口影响", () => {
  const early = message("early", [tool("tool-writeFile", "w1", {}, writeOutput("F:/ws/early.txt"))]);
  const later = message("later", [tool("tool-writeFile", "w2", {}, writeOutput("F:/ws/other.txt"))]);
  assert.deepEqual(
    api.collectChangedFiles([early]).map((file) => file.path),
    ["F:/ws/early.txt"],
  );
  assert.deepEqual(
    api.collectChangedFiles([later]).map((file) => file.path),
    ["F:/ws/other.txt"],
  );
});

await test("后端确认的新建来源在后续编辑中保留，覆盖旧文件不冒充新建", () => {
  const created = message("m1", [
    tool("tool-writeFile", "w-new", {}, { results: { success: true, path: "F:/ws/new.txt", created: true } }),
  ]);
  const overwritten = message("m2", [
    tool("tool-writeFile", "w-old", {}, { results: { success: true, path: "F:/ws/old.txt", created: false } }),
  ]);
  const edited = message("m3", [
    tool("tool-editFile", "e-new", {}, { results: { success: true, path: "F:/ws/new.txt", replacements: 1 } }),
  ]);
  const files = api.collectChangedFiles([created, overwritten, edited]);
  assert.equal(files.find((file) => file.path === "F:/ws/new.txt")?.created, true);
  assert.equal(files.find((file) => file.path === "F:/ws/old.txt")?.created, false);
  assert.equal(files.find((file) => file.path === "F:/ws/new.txt")?.operationCount, 2);
});

await test("整文件覆盖和命令修改不会丢失本次新建来源", () => {
  const files = api.collectChangedFiles([
    message("create-write", [
      tool(
        "tool-writeFile",
        "write-new",
        {},
        { results: { success: true, path: "F:/ws/replaced.txt", created: true } },
      ),
    ]),
    message("overwrite-write", [
      tool(
        "tool-writeFile",
        "write-overwrite",
        {},
        { results: { success: true, path: "F:/ws/replaced.txt", created: false } },
      ),
    ]),
  ]);
  assert.equal(files[0].created, true);
  assert.equal(files[0].operationCount, 2);

  const command = (id, changes) =>
    message(id, [tool("tool-runCommand", id, {}, { results: { success: true, changes } })]);
  const commandFiles = api.collectChangedFiles([
    command("create-command", [{ path: "F:/ws/command.txt", kind: "created", verified: true }]),
    command("modify-command", [{ path: "F:/ws/command.txt", kind: "modified", verified: true }]),
  ]);
  assert.equal(commandFiles[0].created, true);
  assert.equal(commandFiles[0].kind, "modified");
  assert.ok(commandFiles[0].created === true && commandFiles[0].kind !== "deleted");
});

await test("命令创建有明确新建来源，随后删除的文件不再作为新文件展示", () => {
  const command = (id, changes) =>
    message(id, [tool("tool-runCommand", id, {}, { results: { success: true, changes } })]);
  const files = api.collectChangedFiles([
    command("create", [{ path: "F:/ws/temp.txt", kind: "created", verified: true }]),
    command("delete", [{ path: "F:/ws/temp.txt", kind: "deleted", verified: true }]),
  ]);
  assert.equal(files[0].kind, "deleted");
  assert.equal(files[0].created, false);
  assert.ok(!(files[0].created === true && files[0].kind !== "deleted"));
});

console.log(`\n结果：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
