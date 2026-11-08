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
const outDir = mkdtempSync(join(tmpdir(), "file-workspace-store-"));
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "bundle.mjs");
writeFileSync(entry, `export * as store from "${join(src, "store/file-workspace-store.ts").replace(/\\/g, "/")}";`);
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
  key: (index) => Array.from(storage.keys())[index] ?? null,
};
let api;
await test("file-workspace store 可加载", async () => {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  api = (await import(pathToFileURL(outfile).href)).store;
  assert.equal(typeof api.useFileWorkspaceStore?.getState, "function");
});
if (!api) {
  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(1);
}
const store = api.useFileWorkspaceStore;
const reset = () => store.setState({ hosts: {}, recentRoots: {} });
const host = (id) => store.getState().hosts[id];

await test("打开工作区、多个独立标签与重复打开去重", () => {
  reset();
  const state = store.getState();
  state.openWorkspace("central", "central", "F:/ws");
  state.openFile("central", "central", "F:/ws", { path: "F:/ws/a.csv", title: "a.csv" });
  state.openFile("central", "central", "F:/ws", { path: "F:/ws/b.txt", title: "b.txt" });
  state.openFile("central", "central", "F:/ws", { path: "F:/ws/a.csv", title: "a.csv" });
  assert.equal(host("central").mode, "files");
  assert.equal(host("central").tabs.length, 3);
  assert.equal(host("central").tabs[0].type, "explorer");
  assert.equal(host("central").tabs[1].type, "file");
  assert.equal(host("central").activeTabId, "F:/ws/a.csv");
  assert.ok(!("content" in host("central").tabs[0]));
});

await test("关闭活动标签选择邻居，关闭工作区保留标签", () => {
  reset();
  const state = store.getState();
  state.openFile("central", "central", "F:/ws", { path: "F:/ws/a.csv", title: "a.csv" });
  state.openFile("central", "central", "F:/ws", { path: "F:/ws/b.txt", title: "b.txt" });
  const first = host("central").tabs[0].id;
  const second = host("central").tabs[1].id;
  state.setActiveTab("central", first);
  state.closeTab("central", first);
  assert.equal(host("central").tabs.length, 1);
  assert.equal(host("central").activeTabId, second);
  state.closeWorkspace("central");
  assert.equal(host("central").mode, "chat");
  assert.equal(host("central").tabs.length, 1);
  state.openWorkspace("central", "central", "F:/ws");
  assert.equal(host("central").mode, "files");
  assert.equal(host("central").activeTabId, second);
});

await test("不同宿主与 scope 根完全隔离", () => {
  reset();
  const state = store.getState();
  state.openFile("reader:book-a", "reader", "F:/reader-a", { path: "F:/reader-a/a.txt", title: "a.txt" });
  state.openFile("reader:book-b", "reader", "F:/reader-b", { path: "F:/reader-b/b.txt", title: "b.txt" });
  state.openFile("paper:p1", "paper", "F:/paper", { path: "F:/paper/p.txt", title: "p.txt" });
  assert.equal(host("reader:book-a").tabs[0].scope, "reader");
  assert.equal(host("reader:book-b").tabs[0].rootResolved, "F:/reader-b");
  assert.equal(host("paper:p1").tabs[0].rootResolved, "F:/paper");
  state.closeWorkspace("reader:book-a");
  assert.equal(host("reader:book-a").mode, "chat");
  assert.equal(host("reader:book-b").mode, "files");
});

await test("换预览根保留文件标签及其各自守卫根", () => {
  reset();
  const state = store.getState();
  state.openFile("reader:book-a", "reader", "F:/old", { path: "F:/old/a.txt", title: "a.txt" });
  state.openExplorer("reader:book-a", "reader", "F:/old");
  state.openWorkspace("reader:book-a", "reader", "F:/new");
  assert.equal(host("reader:book-a").tabs.length, 2);
  assert.equal(host("reader:book-a").rootResolved, "F:/new");
  assert.equal(host("reader:book-a").explorerPath, "F:/new");
  assert.equal(host("reader:book-a").tabs.find((tab) => tab.type === "file").rootResolved, "F:/old");
});

await test("目录可选、关闭目录不影响文件、关闭全部不清空文件数据", () => {
  reset();
  const state = store.getState();
  state.openFile("central", "central", "F:/ws", { path: "F:/ws/a.txt", title: "a.txt" });
  assert.equal(host("central").tabs.length, 1);
  assert.equal(host("central").tabs[0].type, "file");
  state.openExplorer("central", "central", "F:/ws");
  assert.equal(host("central").tabs.length, 2);
  assert.equal(host("central").activeTabId, "explorer");
  state.closeTab("central", "explorer");
  assert.equal(host("central").tabs.length, 1);
  assert.equal(host("central").tabs[0].type, "file");
  state.closeAllTabs("central");
  assert.equal(host("central").tabs.length, 0);
  assert.equal(host("central").mode, "files");
  assert.equal(host("central").rootResolved, "F:/ws");
});

await test("最近目录按 scope 去重持久化，不保存文件标签", async () => {
  reset();
  const state = store.getState();
  state.setPreviewRoot("central", "central", "F:/preview-a");
  state.setPreviewRoot("reader:book-a", "reader", "F:/preview-reader");
  state.setPreviewRoot("central", "central", "F:/preview-a2");
  assert.equal(store.getState().recentRoots.central[0], "F:/preview-a2");
  assert.equal(store.getState().recentRoots.central[1], "F:/preview-a");
  assert.equal(store.getState().recentRoots.reader[0], "F:/preview-reader");
  assert.equal(host("central").rootResolved, "F:/preview-a2");
  assert.equal(host("central").explorerPath, "F:/preview-a2");
  assert.ok(storage.get("sageread-file-workspace-preview-v1").includes("F:/preview-a2"));
  for (let index = 0; index < 8; index += 1) state.setPreviewRoot("central", "central", `F:/preview-${index}`);
  assert.equal(store.getState().recentRoots.central.length, 6);
  assert.ok(storage.get("sageread-file-workspace-preview-v1").includes("F:/preview-7"));
  const saved = storage.get("sageread-file-workspace-preview-v1");
  store.setState({ hosts: {}, recentRoots: {} });
  storage.set("sageread-file-workspace-preview-v1", saved);
  await store.persist.rehydrate();
  assert.equal(store.getState().recentRoots.central[0], "F:/preview-7");
  assert.equal(host("central"), undefined);
});

await test("Windows 驱动器根保持绝对路径", () => {
  reset();
  const state = store.getState();
  state.setPreviewRoot("central", "central", "F:/");
  assert.equal(host("central").rootResolved, "F:/");
  state.setExplorerPath("central", "F:/data");
  assert.equal(host("central").explorerPath, "F:/data");
});

console.log(`\n结果：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
