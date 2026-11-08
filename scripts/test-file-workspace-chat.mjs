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
for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Node"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const calls = [];
const { win32 } = await import("node:path");
const invoke = async (command, args = {}) => {
  calls.push({ command, args });
  if (command === "agent_preview_resolve_path") {
    const resolved = args.root ?? "F:/default";
    return { verdict: "in", resolved, exists: true, isDir: true };
  }
  if (command === "agent_workspace_stat") {
    if (/[\\/]\.env$/.test(args.path)) return { results: { success: false, message: "敏感文件不可预览" } };
    return { resolved: win32.normalize(args.path), exists: true, isDirectory: false, size: 0, modifiedMs: 1 };
  }
  if (command === "plugin:path|resolve") return win32.resolve(...args.paths);
  if (command.includes("app_data_dir") || command === "plugin:path|resolve_directory") return "F:/default";
  if (command === "plugin:fs|exists") return false;
  if (command.startsWith("plugin:fs|")) return null;
  throw new Error(`未预期的原生调用: ${command}`);
};
dom.window.__TAURI_INTERNALS__ = { invoke };
globalThis.__TAURI_INTERNALS__ = dom.window.__TAURI_INTERNALS__;

const outDir = mkdtempSync(join(tmpdir(), "file-workspace-chat-"));
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "bundle.mjs");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  [
    `export { useFileWorkspaceChat } from "${posix(join(src, "components/file-workspace/use-file-workspace-chat.ts"))}";`,
    `export { useFileWorkspaceStore } from "${posix(join(src, "store/file-workspace-store.ts"))}";`,
    `export { useTaskWorkspaceStore } from "${posix(join(src, "store/task-workspace-store.ts"))}";`,
    `export { useAgentSettingsStore } from "${posix(join(src, "store/agent-settings-store.ts"))}";`,
    `export { default as React, act } from "react";`,
    `export { createRoot } from "react-dom/client";`,
  ].join("\n"),
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  alias: { "@": src },
  nodePaths: [join(root, "packages/app/node_modules")],
  logLevel: "silent",
});
const {
  useFileWorkspaceChat,
  useFileWorkspaceStore,
  useTaskWorkspaceStore,
  useAgentSettingsStore,
  React,
  act,
  createRoot,
} = await import(pathToFileURL(outfile).href);
const host = document.createElement("div");
document.body.appendChild(host);
const view = {};
function Harness() {
  Object.assign(view, useFileWorkspaceChat("central", "central"));
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "button",
      { onClick: () => void view.openChangedFile({ path: "F:/default/result.csv", kind: "created" }) },
      "open",
    ),
    React.createElement(
      "button",
      { onClick: () => void view.openLocalFile(globalThis.__nextLink ?? "file:///F:/default/linked.txt") },
      "open-link",
    ),
  );
}
const renderer = createRoot(host);
let failed = 0;
try {
  useAgentSettingsStore.setState({ workspaceRoot: "F:/default", perAgentRoots: {}, safetyMode: "full" });
  useFileWorkspaceStore.setState({ hosts: {}, recentRoots: { central: ["F:/recent"] } });
  useTaskWorkspaceStore.setState({ pendingRoots: {}, threadRoots: {} });
  useFileWorkspaceStore.getState().openWorkspace("central", "central", "F:/preview");
  await act(async () => renderer.render(React.createElement(Harness)));
  await act(async () => {
    host.querySelector("button").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const tab = useFileWorkspaceStore.getState().hosts.central.tabs.find((item) => item.type === "file");
  try {
    assert.equal(tab.rootResolved, "F:/default", "预览目录不得替代 Agent 默认任务根");
    console.log("PASS 产物使用 Agent 默认任务根，而不是预览或最近目录");
  } catch (error) {
    failed++;
    console.error(`FAIL 产物使用 Agent 默认任务根 — ${error.message}`);
    console.error(JSON.stringify({ tab, calls }));
  }

  await act(async () => {
    useFileWorkspaceStore.setState({ hosts: {}, recentRoots: { central: ["F:/recent"] } });
    useFileWorkspaceStore.getState().openWorkspace("central", "central", "F:/preview");
    useTaskWorkspaceStore.getState().setTaskWorkspaceRoot("central", null, "F:/task");
  });
  await act(async () => {
    host.querySelector("button").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const taskTab = useFileWorkspaceStore.getState().hosts.central.tabs.find((item) => item.type === "file");
  try {
    assert.equal(taskTab.rootResolved, "F:/task", "单次任务根必须优先于默认任务根");
    console.log("PASS 产物优先使用单次任务根");
  } catch (error) {
    failed++;
    console.error(`FAIL 产物优先使用单次任务根 — ${error.message}`);
  }

  await act(async () => {
    useFileWorkspaceStore.setState({ hosts: {}, recentRoots: {} });
    useTaskWorkspaceStore.setState({ pendingRoots: {}, threadRoots: {} });
  });
  try {
    assert.equal(typeof view.openLocalFile, "function", "应提供聊天本地文件打开入口");
    await act(async () => {
      host.querySelectorAll("button")[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const state = useFileWorkspaceStore.getState().hosts.central;
    const linkedTab = state?.tabs.find((item) => item.type === "file");
    assert.equal(state?.mode, "files");
    assert.equal(linkedTab?.path.replace(/\\/g, "/"), "F:/default/linked.txt");
    assert.equal(linkedTab?.rootResolved, "F:/default");
    assert.ok(calls.some((call) => call.command === "plugin:path|resolve"));

    for (const href of ["../outside.txt", ".env"]) {
      await act(async () => {
        globalThis.__nextLink = href;
        useFileWorkspaceStore.setState({ hosts: {}, recentRoots: {} });
        host.querySelectorAll("button")[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const current = useFileWorkspaceStore.getState().hosts.central;
      assert.equal(current?.mode ?? "chat", "chat", `${href} 不应打开文件工作区`);
      assert.equal(current?.tabs.some((item) => item.type === "file") ?? false, false, `${href} 不应建立标签`);
    }

    await act(async () => {
      globalThis.__nextLink = "file:///F:/outside/allowed.txt";
      host.querySelectorAll("button")[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const externalTab = useFileWorkspaceStore.getState().hosts.central?.tabs.find((item) => item.type === "file");
    assert.equal(externalTab?.path.replace(/\\/g, "/"), "F:/outside/allowed.txt", "绝对路径应交给既有权限链");
    await act(async () => {
      globalThis.__nextLink = "file:///F:/default/100%.md";
      host.querySelectorAll("button")[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const percentTab = useFileWorkspaceStore
      .getState()
      .hosts.central?.tabs.find((item) => item.path.endsWith("100%.md"));
    assert.ok(percentTab, "合法百分号文件名不能因 URI 解码失败而失去打开入口");
    console.log("PASS 本地链接使用规范路径和权限链，拒绝相对越界与敏感文件");
  } catch (error) {
    failed++;
    console.error(
      `FAIL 本地链接使用规范路径和权限链 — ${error instanceof Error ? (error.stack ?? error) : String(error)}`,
    );
  }
} finally {
  await act(async () => renderer.unmount());
  dom.window.close();
}
process.exit(failed ? 1 : 0);
