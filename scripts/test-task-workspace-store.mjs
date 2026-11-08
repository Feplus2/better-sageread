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
const outDir = mkdtempSync(join(tmpdir(), "task-workspace-store-"));
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "bundle.mjs");
writeFileSync(entry, `export * as store from "${join(src, "store/task-workspace-store.ts").replace(/\\/g, "/")}";`);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "silent",
});
const api = (await import(pathToFileURL(outfile).href)).store;
const store = api.useTaskWorkspaceStore;
const select = api.selectTaskWorkspaceRoot;
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
const reset = () => store.setState({ pendingRoots: {}, threadRoots: {} });

await test("首轮 pending 建线程绑定，已有线程可立即换根", () => {
  reset();
  const state = store.getState();
  state.setTaskWorkspaceRoot("reader:book-a", null, "F:/once");
  assert.equal(select(store.getState(), "reader:book-a"), "F:/once");
  state.bindPendingWorkspaceRoot("reader:book-a", "thread-a");
  assert.equal(select(store.getState(), "reader:book-a", "thread-a"), "F:/once");
  assert.equal(select(store.getState(), "reader:book-a"), undefined);
  state.setTaskWorkspaceRoot("reader:book-a", "thread-a", "F:/changed");
  assert.equal(select(store.getState(), "reader:book-a", "thread-a"), "F:/changed");
  assert.equal(select(store.getState(), "reader:book-a", "thread-b"), undefined);
});

await test("新对话只清 pending，旧线程绑定和恢复共享语义独立", () => {
  reset();
  const state = store.getState();
  state.setTaskWorkspaceRoot("reader:book-a", null, "F:/new-task");
  state.bindPendingWorkspaceRoot("reader:book-a", "thread-new");
  state.clearPendingWorkspaceRoot("reader:book-a");
  assert.equal(select(store.getState(), "reader:book-a"), undefined);
  assert.equal(select(store.getState(), "reader:book-a", "thread-new"), "F:/new-task");
  state.setTaskWorkspaceRoot("reader:book-a", "thread-old", "F:/old-task");
  state.clearTaskWorkspaceRoot("reader:book-a", "thread-old");
  assert.equal(select(store.getState(), "reader:book-a", "thread-old"), undefined);
  assert.equal(select(store.getState(), "reader:book-a", "thread-new"), "F:/new-task");
});

await test("宿主与线程键完全隔离", () => {
  reset();
  const state = store.getState();
  state.setTaskWorkspaceRoot("reader:book-a", "shared-thread-id", "F:/reader-a");
  state.setTaskWorkspaceRoot("reader:book-b", "shared-thread-id", "F:/reader-b");
  state.setTaskWorkspaceRoot("central", null, "F:/central");
  assert.equal(select(store.getState(), "reader:book-a", "shared-thread-id"), "F:/reader-a");
  assert.equal(select(store.getState(), "reader:book-b", "shared-thread-id"), "F:/reader-b");
  assert.equal(select(store.getState(), "central"), "F:/central");
  assert.equal(select(store.getState(), "paper:p1"), undefined);
});

await test("缺失请求上下文时任务根回默认，不采用其他线程快照", () => {
  reset();
  const state = store.getState();
  state.setTaskWorkspaceRoot("reader:book-a", "thread-a", "F:/changed");
  assert.equal(api.resolveRequestTaskWorkspaceRoot("reader:book-a", "thread-a", false), undefined);
  assert.equal(api.resolveRequestTaskWorkspaceRoot("reader:book-a", "thread-a", true), "F:/changed");
  assert.equal(api.resolveRequestTaskWorkspaceRoot(undefined, "thread-a", true), undefined);
});

await test("显式快照在 pending 删除后仍绑定，后续 pending 不被误清除", () => {
  reset();
  const state = store.getState();
  state.setTaskWorkspaceRoot("central", null, "F:/once-a");
  state.clearPendingWorkspaceRoot("central");
  state.bindPendingWorkspaceRoot("central", "thread-a", "F:/once-a");
  state.setTaskWorkspaceRoot("central", null, "F:/next-b");
  assert.equal(select(store.getState(), "central", "thread-a"), "F:/once-a");
  assert.equal(select(store.getState(), "central"), "F:/next-b");
});

await test("无自定义根的快照不吸收建线程后新增的 pending", () => {
  reset();
  const state = store.getState();
  state.setTaskWorkspaceRoot("central", null, "F:/later-b");
  state.bindPendingWorkspaceRoot("central", "thread-default", null);
  assert.equal(select(store.getState(), "central", "thread-default"), undefined);
  assert.equal(select(store.getState(), "central"), "F:/later-b");
});

await test("显式空快照不会回退到另一个线程的 pending", () => {
  reset();
  const state = store.getState();
  state.setTaskWorkspaceRoot("central", null, "F:/other-thread");
  assert.equal(api.resolveRequestTaskWorkspaceRoot("central", "thread-new", true, null), undefined);
});

console.log(`\n结果：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
