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
const channels = [];
const NativeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NativeMessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
};
for (const key of [
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "NodeFilter",
  "Event",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLSelectElement",
  "MutationObserver",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.getComputedStyle = window.getComputedStyle;
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = Observer;
globalThis.IntersectionObserver = Observer;
window.ResizeObserver = Observer;
window.IntersectionObserver = Observer;
window.HTMLElement.prototype.scrollIntoView = () => {};

const outDir = mkdtempSync(join(tmpdir(), "workspace-directory-dialog-"));
const dialogStub = join(outDir, "dialog.ts");
const entry = join(outDir, "entry.tsx");
const outfile = join(outDir, "bundle.mjs");
writeFileSync(
  dialogStub,
  `export async function open(options) {
    globalThis.__dialogOptions = options;
    return globalThis.__nextDirectory === undefined ? "F:/Research/chosen" : globalThis.__nextDirectory;
  }`,
);
writeFileSync(
  entry,
  `export { WorkspaceDirectoryDialog } from "${join(src, "components/file-workspace/workspace-directory-dialog.tsx").replace(/\\/g, "/")}";
   export { default as React, act } from "react";
   export { createRoot } from "react-dom/client";`,
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  alias: { "@tauri-apps/plugin-dialog": dialogStub },
  nodePaths: [join(root, "packages/app/node_modules")],
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  logLevel: "silent",
});
const { WorkspaceDirectoryDialog, React, act, createRoot } = await import(pathToFileURL(outfile).href);
const host = document.createElement("div");
document.body.appendChild(host);
const rootView = createRoot(host);
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
function button(text) {
  const result = Array.from(document.querySelectorAll("button")).find((item) => item.textContent.includes(text));
  assert.ok(result, `找不到按钮 ${text}`);
  return result;
}
async function click(text) {
  await act(async () => button(text).click());
}
function render(props) {
  return act(async () => {
    rootView.render(React.createElement(WorkspaceDirectoryDialog, props));
  });
}

await test("系统目录选择器使用目录模式并回填，提交仍由用户确认", async () => {
  const submitted = [];
  await render({
    open: true,
    onOpenChange: () => {},
    title: "更换预览目录",
    initialPath: "F:/default",
    recentPaths: ["F:/recent"],
    onSubmit: (path, mode) => submitted.push({ path, mode }),
  });
  assert.ok(document.querySelector("[role='dialog']"));
  const form = document.querySelector("[role='dialog'] form");
  assert.ok(form.classList.contains("px-4"), "表单应有水平留白，不能贴住窗口边缘");
  assert.ok(form.classList.contains("pb-4"), "底部按钮与窗口之间应有留白");
  await click("系统目录选择");
  assert.equal(globalThis.__dialogOptions.directory, true);
  assert.equal(globalThis.__dialogOptions.multiple, false);
  assert.equal(document.querySelector("input").value, "F:/Research/chosen");
  assert.equal(submitted.length, 0);
  await click("F:/recent");
  await click("打开目录");
  assert.deepEqual(submitted, [{ path: "F:/recent", mode: "remember" }]);
});

await test("任务目录支持仅本次、记住默认与恢复共享", async () => {
  const submitted = [];
  let resetCount = 0;
  await render({
    open: true,
    onOpenChange: () => {},
    title: "选择任务工作区",
    initialPath: "F:/once",
    mode: "task",
    defaultMode: "once",
    onSubmit: (path, mode) => submitted.push({ path, mode }),
    onReset: () => {
      resetCount++;
    },
  });
  await act(async () => document.querySelector("input[value='remember']").click());
  await click("保存选择");
  assert.deepEqual(submitted, [{ path: "F:/once", mode: "remember" }]);
  await click("恢复共享工作区");
  assert.equal(resetCount, 1);
});

await test("空路径被拒绝，取消系统选择不改变原路径", async () => {
  let submitCount = 0;
  globalThis.__nextDirectory = null;
  await render({
    open: true,
    onOpenChange: () => {},
    title: "更换预览目录",
    initialPath: "F:/default",
    onSubmit: () => {
      submitCount++;
    },
  });
  await click("系统目录选择");
  assert.equal(document.querySelector("input").value, "F:/default");
  await act(async () => {
    const input = document.querySelector("input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "   ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("打开目录");
  assert.equal(submitCount, 0);
  assert.ok(document.querySelector("[role='alert']"));
});

console.log(`\n结果：${passed} passed, ${failed} failed`);
try {
  await act(async () => rootView.unmount());
  host.remove();
} finally {
  window.close();
  for (const channel of channels) {
    for (const port of [channel.port1, channel.port2]) {
      port.unref();
      port.close();
    }
  }
  globalThis.MessageChannel = NativeMessageChannel;
}
process.exit(failed === 0 ? 0 : 1);
