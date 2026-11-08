import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((name) => name.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const invoke = async (command, args = {}) => {
  if (command === "agent_resolve_path" || command === "agent_preview_resolve_path") {
    const base = String(args.root ?? "F:/ws").replace(/\\/g, "/");
    const resolved = args.path === "." ? base : String(args.path).replace(/\\/g, "/");
    return { verdict: resolved.startsWith(`${base}/`) ? "in" : "out", resolved, exists: true, isDir: false };
  }
  if (command === "agent_workspace_stat") {
    const resolved = String(args.path).replace(/\\/g, "/");
    if (resolved.endsWith("/.env") || resolved.includes("id_rsa")) throw new Error("敏感路径不可读取");
    if (resolved.includes("outside") && (args.allowOutside !== true || args.expectedResolved !== resolved)) {
      throw new Error("界外路径未经用户确认");
    }
    return {
      resolved,
      exists: !resolved.includes("missing"),
      isDirectory: !/\.[A-Za-z0-9]+$/.test(resolved),
      size: 128,
      modifiedMs: 1,
    };
  }
  return null;
};
dom.window.__TAURI_INTERNALS__ = { invoke };
globalThis.__TAURI_INTERNALS__ = dom.window.__TAURI_INTERNALS__;

const outDir = mkdtempSync(join(tmpdir(), "presented-files-"));
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "bundle.mjs");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  `export { presentTool } from "${posix(join(src, "ai/tools/central/present.ts"))}";
   export { collectPresentedFiles } from "${posix(join(src, "ai/utils/presented-files.ts"))}";
   export { wrapToolsWithGuard } from "${posix(join(src, "ai/utils/tool-guard.ts"))}";
   export { getToolsForScope } from "${posix(join(src, "ai/tools/registry.ts"))}";
   export { useAgentSettingsStore } from "${posix(join(src, "store/agent-settings-store.ts"))}";
   export { useAgentConfirmStore } from "${posix(join(src, "store/agent-confirm-store.ts"))}";`,
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
const {
  presentTool,
  collectPresentedFiles,
  wrapToolsWithGuard,
  getToolsForScope,
  useAgentSettingsStore,
  useAgentConfirmStore,
} = api;
const execute = (input) =>
  presentTool.execute({ reasoning: "明确交付给用户", ...input }, { toolCallId: "present-test", messages: [] });
const asPart = (result) => ({
  type: "tool-present",
  toolCallId: "present-test",
  state: "output-available",
  output: result,
});
const collect = (result) => collectPresentedFiles({ id: "turn-1", parts: [asPart(result)] });
const settleConfirmation = async (promise, approved) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  useAgentConfirmStore.getState().resolvePending(approved, false);
  return promise;
};

useAgentSettingsStore.setState({ workspaceRoot: "F:/ws", perAgentRoots: {}, safetyMode: "strict" });
useAgentConfirmStore.setState({ queue: [], sessionAllowlist: new Set(), previewGrants: {} });

const oldReadme = await execute({ path: "F:/ws/README.md", description: "本轮成果的使用说明" });
assert.equal(oldReadme.results.success, true);
assert.deepEqual(collect(oldReadme), [{ path: "F:/ws/README.md", description: "本轮成果的使用说明" }]);
const duplicated = collectPresentedFiles({ id: "turn-1", parts: [asPart(oldReadme), asPart(oldReadme)] });
assert.equal(duplicated.length, 1);
console.log("PASS 本轮未编辑的旧 README 可以显式交付，重复声明按路径去重");

const incidental = collectPresentedFiles({
  id: "turn-2",
  parts: [
    { type: "text", text: "我声称已经交付 README.md，但没有工具成功结果" },
    {
      type: "tool-writeFile",
      state: "output-available",
      output: { results: { success: true, path: "F:/ws/probe.mjs", created: true } },
    },
  ],
});
assert.deepEqual(incidental, []);
console.log("PASS 新建脚本和模型自述不会自动成为交付物");

for (const path of ["F:/ws/missing.md", "F:/ws/folder", "F:/ws/.env"]) {
  const result = await execute({ path });
  assert.equal(result.results.success, false, `${path} 不应声明成功`);
  assert.deepEqual(collect(result), []);
}
console.log("PASS 不存在、目录和敏感路径均不能进入交付清单");

const wrapped = wrapToolsWithGuard({ present: presentTool }, "central", "F:/ws");
const denied = await settleConfirmation(
  wrapped.present.execute(
    { reasoning: "尝试界外交付", path: "F:/outside/report.md" },
    { toolCallId: "present-denied", messages: [] },
  ),
  false,
);
assert.equal(denied.results.success, false);
assert.deepEqual(collect(denied), []);
useAgentConfirmStore.setState({ queue: [], sessionAllowlist: new Set(), previewGrants: {} });
const allowed = await settleConfirmation(
  wrapped.present.execute(
    { reasoning: "用户批准的界外交付", path: "F:/outside/report.md" },
    { toolCallId: "present-allowed", messages: [] },
  ),
  true,
);
assert.equal(allowed.results.success, true);
assert.deepEqual(collect(allowed), [{ path: "F:/outside/report.md" }]);
console.log("PASS 界外交付沿用文件读取确认，拒绝不产生交付卡，批准后可交付");

useAgentSettingsStore.setState({ safetyMode: "relaxed" });
const relaxedTools = wrapToolsWithGuard({ present: presentTool }, "central", "F:/ws");
const relaxed = await relaxedTools.present.execute(
  { reasoning: "宽松模式下的界外只读交付", path: "F:/outside/report.md" },
  { toolCallId: "present-relaxed", messages: [] },
);
assert.equal(relaxed.results.success, true, "宽松模式也必须绑定用户允许的规范化路径");
assert.deepEqual(collect(relaxed), [{ path: "F:/outside/report.md" }]);
console.log("PASS 宽松模式的界外交付仍绑定规范化路径");

for (const scope of ["central", "reader", "paper"]) {
  assert.equal(getToolsForScope(scope).present, presentTool, `${scope} 应共享同一个交付工具`);
}
console.log("PASS 三个助手共享显式交付工具");
