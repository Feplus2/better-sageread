import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
for (const key of ["document", "navigator", "HTMLElement", "Node", "Text", "MutationObserver", "CustomEvent"]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const calls = [];
const normalize = (path) => String(path).replace(/\\/g, "/").replace(/\/+$/, "");
function verdict(root, path) {
  const base = root ? normalize(root) : "F:/default";
  const resolved = path === "." ? base : normalize(path);
  return {
    verdict: resolved === base || resolved.startsWith(`${base}/`) ? "in" : "out",
    resolved,
    exists: !resolved.includes("missing"),
    isDir: !/\.[A-Za-z0-9]+$/.test(resolved),
  };
}
const invoke = async (command, args = {}) => {
  calls.push({ command, args });
  if (command.includes("app_data_dir") || command === "plugin:path|resolve_directory") return "F:/default";
  if (command === "agent_preview_resolve_path" || command === "agent_resolve_path")
    return verdict(args.root, args.path);
  if (command === "agent_workspace_stat") {
    const result = verdict(args.root, args.path);
    if (result.verdict === "out" && args.allowOutside !== true) {
      throw new Error("路径在工作区外且未经用户确认");
    }
    if (result.verdict === "out" && args.expectedResolved !== result.resolved) {
      throw new Error("界外预览的规范化路径已变化，需重新确认");
    }
    return { ...result, size: result.isDir ? 0 : 2, modifiedMs: 1 };
  }
  if (command === "agent_workspace_read_chunk") {
    const result = verdict(args.root, args.path);
    return {
      resolved: result.resolved,
      content: "ok",
      nextOffset: 2,
      truncated: false,
      binary: false,
      totalSize: 2,
      modifiedMs: 1,
    };
  }
  if (command === "agent_workspace_read_binary") return new Uint8Array([1, 2]).buffer;
  if (command === "agent_workspace_list")
    return { resolved: verdict(args.root, args.path).resolved, items: [], nextOffset: 0, truncated: false };
  if (command === "agent_read_file") return { content: "1\tmemory" };
  if (command === "plugin:fs|exists") return false;
  if (command.startsWith("plugin:fs|")) return null;
  throw new Error(`未 mock 的 Tauri 命令: ${command}`);
};
window.__TAURI_INTERNALS__ = { invoke };
globalThis.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__;

const outDir = mkdtempSync(join(tmpdir(), "preview-grants-"));
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "bundle.mjs");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  `export * as confirm from "${posix(join(src, "store/agent-confirm-store.ts"))}";
   export * as files from "${posix(join(src, "services/agent-workspace-files.ts"))}";
   export * as guard from "${posix(join(src, "ai/utils/tool-guard.ts"))}";
   export * as settings from "${posix(join(src, "store/agent-settings-store.ts"))}";
   export * as present from "${posix(join(src, "ai/tools/central/present.ts"))}";`,
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  nodePaths: [join(root, "packages/app/node_modules")],
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  logLevel: "silent",
});
const api = await import(pathToFileURL(outfile).href);
const confirms = api.confirm.useAgentConfirmStore;
const settings = api.settings.useAgentSettingsStore;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let passed = 0;
let failed = 0;
async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} — ${error instanceof Error ? (error.stack ?? error) : String(error)}`);
  }
}
function reset() {
  calls.length = 0;
  confirms.setState({ queue: [], sessionAllowlist: new Set(), previewGrants: {} });
  settings.setState({ workspaceRoot: "F:/default", perAgentRoots: {}, safetyMode: "strict" });
}

await test("preview grant 按 scope/root/target 精确匹配", () => {
  reset();
  const state = confirms.getState();
  assert.equal(typeof state.recordPreviewGrant, "function");
  assert.equal(typeof state.hasPreviewGrant, "function");
  state.recordPreviewGrant("central", "F:/root", "F:/root/file.txt");
  assert.equal(state.hasPreviewGrant("central", "F:/root", "F:/root/file.txt"), true);
  assert.equal(state.hasPreviewGrant("central", "F:/other", "F:/root/file.txt"), false);
  assert.equal(state.hasPreviewGrant("reader", "F:/root", "F:/root/file.txt"), false);
  assert.equal(state.hasPreviewGrant("central", "F:/root", "F:/root/other.txt"), false);
});

async function settlePreview(promise) {
  await flush();
  const pending = confirms.getState().queue.length;
  if (pending > 0) confirms.getState().resolvePending(true, false);
  return { result: await promise, pending };
}

await test("界外 preview 不重复确认，模型 readLocalFile 不继承 grant", async () => {
  reset();
  const first = settlePreview(api.files.readWorkspaceChunk("central", "F:/outside/data.txt"));
  assert.equal((await first).pending, 1);
  assert.equal((await first).result.content, "ok");
  const stat = await settlePreview(api.files.statWorkspaceFile("central", "F:/outside/data.txt"));
  assert.equal(stat.pending, 0);
  const chunk = await settlePreview(api.files.readWorkspaceChunk("central", "F:/outside/data.txt"));
  assert.equal(chunk.pending, 0);
  const modelRead = api.guard
    .wrapToolsWithGuard({ readLocalFile: { execute: async () => ({ results: { success: true } }) } }, "central")
    .readLocalFile.execute({ path: "F:/outside/data.txt" }, { toolCallId: "model-read", messages: [] });
  await flush();
  assert.equal(confirms.getState().queue.length, 1);
  confirms.getState().resolvePending(true, false);
  await modelRead;
});

await test("候选预览根必须存在且走 preview 专用解析", async () => {
  reset();
  const pending = api.files.resolveAgentWorkspaceRoot("central", "F:/missing");
  await flush();
  if (confirms.getState().queue.length > 0) confirms.getState().resolvePending(true, false);
  await assert.rejects(pending, /不存在|不是目录/);
  assert.ok(calls.some((call) => call.command === "agent_preview_resolve_path"));
  assert.equal(confirms.getState().hasPreviewGrant("central", "F:/default", "F:/missing"), false);
});

await test("写入和 verified 命令产物才登记 preview grant", async () => {
  reset();
  const tools = api.guard.wrapToolsWithGuard(
    {
      writeFile: { execute: async () => ({ results: { success: true, path: "F:/outside/write.txt" } }) },
      runCommand: {
        execute: async () => ({
          results: {
            success: true,
            changes: [
              { path: "F:/outside/command.txt", kind: "created", verified: true },
              { path: "F:/outside/deleted.txt", kind: "deleted", verified: true },
              { path: "F:/outside/unverified.txt", kind: "created", verified: false },
            ],
          },
        }),
      },
    },
    "central",
  );
  const write = tools.writeFile.execute({ path: "F:/outside/write.txt" }, { toolCallId: "model-write", messages: [] });
  await flush();
  confirms.getState().resolvePending(true, false);
  await write;
  const command = tools.runCommand.execute({ command: "fixture" }, { toolCallId: "model-command", messages: [] });
  await flush();
  confirms.getState().resolvePending(true, false);
  await command;
  assert.equal(confirms.getState().hasPreviewGrant("central", "F:/default", "F:/outside/write.txt"), true);
  assert.equal(confirms.getState().hasPreviewGrant("central", "F:/default", "F:/outside/command.txt"), true);
  assert.equal(confirms.getState().hasPreviewGrant("central", "F:/default", "F:/outside/deleted.txt"), false);
  assert.equal(confirms.getState().hasPreviewGrant("central", "F:/default", "F:/outside/unverified.txt"), false);
});

await test("预览免打扰不直通模型、其他 scope 或通用 allowlist", async () => {
  reset();
  const first = api.files.readWorkspaceChunk("central", "F:/outside/remember.txt");
  await flush();
  assert.equal(confirms.getState().queue.length, 1);
  confirms.getState().resolvePending(true, true);
  await first;

  const modelRead = api.guard
    .wrapToolsWithGuard({ readLocalFile: { execute: async () => ({ results: { success: true } }) } }, "central")
    .readLocalFile.execute({ path: "F:/outside/remember.txt" }, { toolCallId: "model-read", messages: [] });
  await flush();
  const modelQueued = confirms.getState().queue.length === 1;
  if (modelQueued) confirms.getState().resolvePending(false, false);
  await modelRead;
  assert.equal(modelQueued, true, "模型读取不得继承预览的免打扰");

  const otherScope = api.files.readWorkspaceChunk("reader", "F:/outside/remember.txt");
  await flush();
  const scopeQueued = confirms.getState().queue.length === 1;
  if (scopeQueued) confirms.getState().resolvePending(false, false);
  await assert.rejects(otherScope, /用户已拒绝/);
  assert.equal(scopeQueued, true, "预览授权不得跨 scope");
  assert.equal(confirms.getState().sessionAllowlist.size, 0, "预览不得写入通用免打扰键");
  assert.equal(confirms.getState().hasPreviewGrant("central", "F:/default", "F:/outside/remember.txt"), true);
});

await test("同目标并发确认只中止自己的请求，另一个仍可批准", async () => {
  reset();
  const tools = api.guard.wrapToolsWithGuard(
    { readLocalFile: { execute: async () => ({ results: { success: true } }) } },
    "central",
  );
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const options = (signal, toolCallId) => ({ toolCallId, messages: [], abortSignal: signal });
  const first = tools.readLocalFile.execute(
    { path: "F:/outside/shared.txt" },
    options(firstAbort.signal, "first-read"),
  );
  const second = tools.readLocalFile.execute(
    { path: "F:/outside/shared.txt" },
    options(secondAbort.signal, "second-read"),
  );
  await flush();
  assert.equal(confirms.getState().queue.length, 2);
  firstAbort.abort();
  assert.equal((await first).meta.cancelled, true);
  const remaining = confirms.getState().queue.length;
  if (remaining > 0) confirms.getState().resolvePending(true, false);
  let timer;
  const outcome = await Promise.race([
    second,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), 300);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(remaining, 1, "中止一个请求不得撤掉另一个同 key 的确认");
  assert.equal(outcome?.results?.success, true, "另一个确认 Promise 必须有终态");
});

await test("目标消失后撤销旧授权，重建时必须重新确认", async () => {
  reset();
  const target = "F:/outside/recreated.txt";
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  let exists = true;
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    const result = await originalInvoke(command, args);
    if (
      (command === "agent_preview_resolve_path" || command === "agent_workspace_stat") &&
      normalize(args.path) === target
    ) {
      return { ...result, exists };
    }
    return result;
  };
  try {
    confirms.getState().recordPreviewGrant("central", "F:/default", target);
    exists = false;
    const missing = api.files.statWorkspaceFile("central", target);
    await flush();
    if (confirms.getState().queue.length > 0) confirms.getState().resolvePending(false, false);
    await missing.catch((error) => {
      assert.match(String(error), /用户已拒绝|操作已取消|不存在/);
    });
    assert.equal(confirms.getState().hasPreviewGrant("central", "F:/default", target), false);

    exists = true;
    const recreated = api.files.statWorkspaceFile("central", target);
    await flush();
    assert.equal(confirms.getState().queue.length, 1, "删除后重建不得沿用旧授权");
    confirms.getState().resolvePending(false, false);
    await assert.rejects(recreated, /用户已拒绝|操作已取消/);
  } finally {
    window.__TAURI_INTERNALS__.invoke = originalInvoke;
  }
});

await test("用户拒绝界外预览会返回明确取消错误", async () => {
  reset();
  const pending = api.files.readWorkspaceChunk("central", "F:/outside/reject.txt");
  await flush();
  assert.equal(confirms.getState().queue.length, 1);
  confirms.getState().resolvePending(false, false);
  await assert.rejects(pending, /用户已拒绝/);
  assert.equal(confirms.getState().hasPreviewGrant("central", "F:/default", "F:/outside/reject.txt"), false);
  assert.equal(
    calls.filter((call) => call.command === "agent_workspace_read_chunk" && call.args.allowOutside === true).length,
    0,
  );
});

await test("原生预览读取失败不会被吞成空结果", async () => {
  reset();
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  try {
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "agent_workspace_read_chunk") throw new Error("磁盘读取失败");
      return originalInvoke(command, args);
    };
    const pending = api.files.readWorkspaceChunk("central", "F:/outside/native-error.txt");
    await flush();
    assert.equal(confirms.getState().queue.length, 1);
    confirms.getState().resolvePending(true, false);
    const outcome = await pending.then(
      (value) => ({ value }),
      (error) => ({ error: String(error) }),
    );
    console.log(
      "原生预览失败证据",
      JSON.stringify(outcome),
      calls.filter((call) => call.command === "agent_workspace_read_chunk"),
    );
    assert.ok(outcome.error?.includes("磁盘读取失败"), JSON.stringify(outcome));
    assert.equal(confirms.getState().hasPreviewGrant("central", "F:/default", "F:/outside/native-error.txt"), false);
  } finally {
    window.__TAURI_INTERNALS__.invoke = originalInvoke;
  }
});

await test("免打扰请求中止不得撤掉其他确认卡", async () => {
  reset();
  const other = confirms.getState().requestConfirmation({
    toolName: "other",
    title: "另一会话的确认",
    detail: "不得被本路中止撤掉",
    dontAskKey: "other-session",
  });
  confirms.setState({ sessionAllowlist: new Set(["readLocalFile:F:/outside/allowed.txt"]) });
  const originalConfirmation = confirms.getState().requestConfirmation;
  confirms.setState({
    requestConfirmation: async (req) => {
      console.log("confirmation called", req.dontAskKey);
      return originalConfirmation(req);
    },
  });
  const tools = api.guard.wrapToolsWithGuard(
    {
      readLocalFile: {
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { results: { success: true } };
        },
      },
    },
    "central",
  );
  const controller = new AbortController();
  const queue = confirms.getState().queue;
  const originalAt = queue.at;
  queue.at = (index) => {
    const request = originalAt.call(queue, index);
    console.log("queue.at hook fired");
    queueMicrotask(() => controller.abort());
    return request;
  };
  const pending = tools.readLocalFile.execute(
    { path: "F:/outside/allowed.txt" },
    { toolCallId: "allowlist-abort", messages: [], abortSignal: controller.signal },
  );
  await pending;
  assert.equal(confirms.getState().queue.length, 1, "另一会话的确认卡必须保留");
  confirms.getState().resolvePending(true, false);
  await other;
});

await test("同一路径 modifiedMs 改变后必须重新确认", async () => {
  reset();
  const target = "F:/outside/changed.txt";
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  let modifiedMs = 1;
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    const result = await originalInvoke(command, args);
    if (command === "agent_workspace_stat" && normalize(args.path) === target) {
      return { ...result, modifiedMs };
    }
    return result;
  };
  try {
    const first = api.files.statWorkspaceFile("central", target);
    await flush();
    confirms.getState().resolvePending(true, false);
    await first;
    console.log("grant after first", JSON.stringify(confirms.getState().previewGrants));
    modifiedMs = 2;
    const second = api.files.statWorkspaceFile("central", target);
    await flush();
    assert.equal(confirms.getState().queue.length, 1, "内容变化不得沿用旧授权");
    confirms.getState().resolvePending(false, false);
    await assert.rejects(second, /用户已拒绝/);
  } finally {
    window.__TAURI_INTERNALS__.invoke = originalInvoke;
  }
});

await test("严格模式交付界外文件在确认后绑定原规范化路径", async () => {
  reset();
  const tools = api.guard.wrapToolsWithGuard({ present: api.present.presentTool }, "central");
  const pending = tools.present.execute(
    { reasoning: "验证界外交付授权", path: "F:/outside/present.txt", description: "测试交付物" },
    { toolCallId: "present-outside-strict", messages: [] },
  );
  await flush();
  assert.equal(confirms.getState().queue.length, 1);
  assert.equal(
    calls.some((call) => call.command === "agent_workspace_stat"),
    false,
    "批准前不得读取交付文件元信息",
  );
  confirms.getState().resolvePending(true, false);
  const result = await pending;
  assert.equal(result.results.success, true);
  const stat = calls.find((call) => call.command === "agent_workspace_stat");
  assert.equal(stat?.args.allowOutside, true);
  assert.equal(stat?.args.expectedResolved, "F:/outside/present.txt");
});

console.log(`\n结果：${passed} passed, ${failed} failed`);
window.close();
process.exit(failed === 0 ? 0 : 1);
