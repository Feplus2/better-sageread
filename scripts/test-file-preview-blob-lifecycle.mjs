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
assert.ok(esbuildPkg, "未找到 esbuild");
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
const taskChannels = [];
const NativeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NativeMessageChannel {
  constructor() {
    super();
    taskChannels.push(this);
  }
};
for (const key of [
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "Range",
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
window.HTMLElement.prototype.scrollTo = () => {};
window.__TAURI_INTERNALS__ = { invoke: async () => null };

const outDir = mkdtempSync(join(tmpdir(), "preview-blob-lifecycle-"));
const stub = join(outDir, "workspace-files.ts");
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "preview.mjs");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  stub,
  `
export const WORKSPACE_PREVIEW_CHUNK_BYTES = 262144;
export const statCalls = [];
export const statRequests = [];
export function deferNextStat() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  statCalls.push({ promise });
  return (value) => resolve(value);
}
export async function statWorkspaceFile(scope, path, options = {}) {
  statRequests.push({ path, rootResolved: options.rootResolved });
  const pending = statCalls.shift();
  if (pending) return pending.promise;
  return { resolved: path, exists: true, isDirectory: false, size: 1, modifiedMs: 1 };
}
export async function readWorkspaceChunk(scope, path) {
  return { resolved: path, content: '{"value":42}', nextOffset: 1, truncated: false, binary: false, totalSize: 1, modifiedMs: 1 };
}
export async function readWorkspaceImage() { return { dataUrl: "data:image/png;base64,abc" }; }
export async function workspaceFileUrl() {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return URL.createObjectURL(new Blob(["pdf"]));
}
`,
);
writeFileSync(
  entry,
  `
export { FilePreview } from "${posix(join(src, "components/file-workspace/file-preview.tsx"))}";
export * as workspaceFiles from "${posix(stub)}";
export { default as React, act } from "react";
export { createRoot } from "react-dom/client";
`,
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
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".woff": "dataurl", ".woff2": "dataurl" },
  plugins: [
    {
      name: "slow-workspace-preview",
      setup(build) {
        build.onResolve({ filter: /^@\/services\/agent-workspace-files$/ }, () => ({ path: stub }));
      },
    },
  ],
  logLevel: "silent",
});
const { FilePreview, workspaceFiles, React, act, createRoot } = await import(pathToFileURL(outfile).href);
const created = [];
const revoked = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
URL.createObjectURL = () => {
  const url = `blob:test-${created.length + 1}`;
  created.push(url);
  return url;
};
URL.revokeObjectURL = (url) => revoked.push(url);
const host = document.createElement("div");
document.body.appendChild(host);
const rootView = createRoot(host);
try {
  const fresh = {
    id: "fresh",
    scope: "central",
    path: "/tmp/fresh.txt",
    title: "fresh.txt",
    rootResolved: "F:/task-root",
  };
  await act(async () => {
    rootView.render(
      React.createElement(FilePreview, { key: "fresh", tab: fresh, refreshToken: 0, onRefresh: () => {} }),
    );
  });
  const releaseFocus = workspaceFiles.deferNextStat();
  await act(async () => {
    window.dispatchEvent(new window.Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(workspaceFiles.statRequests.length, 2, "慢 focus stat 必须已经开始");
  await act(async () => {
    rootView.render(
      React.createElement(FilePreview, { key: "fresh", tab: fresh, refreshToken: 1, onRefresh: () => {} }),
    );
  });
  assert.equal(host.querySelector('[data-region="file-preview"]').dataset.status, "ready");
  await act(async () => {
    releaseFocus({ resolved: fresh.path, exists: false, isDirectory: false, size: 0, modifiedMs: 0 });
  });
  const preview = host.querySelector('[data-region="file-preview"]');
  assert.equal(preview.dataset.status, "ready", "迟到的 deleted 不得覆盖新加载结果");
  assert.ok(!preview.textContent.includes("磁盘内容已变化"), "迟到的 stale 不得覆盖新加载结果");
  assert.ok(workspaceFiles.statRequests.every((request) => request.rootResolved === "F:/task-root"));
  console.log("PASS focus 的过期 stat 不覆盖刷新后的 ready 状态，且保留守卫根");

  const tab = { id: "pdf", scope: "central", path: "/tmp/paper.pdf", title: "paper.pdf" };
  await act(async () => {
    rootView.render(React.createElement(FilePreview, { key: "pdf", tab, refreshToken: 0, onRefresh: () => {} }));
  });
  const next = { id: "json", scope: "central", path: "/tmp/sample.json", title: "sample.json" };
  await act(async () => {
    rootView.render(React.createElement(FilePreview, { key: "json", tab: next, refreshToken: 0, onRefresh: () => {} }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  assert.ok(created.length > 0, "慢预览没有创建 Blob URL");
  assert.deepEqual(revoked, created, "切换标签后，迟到的旧 Blob URL 未全部撤销");
  console.log("PASS 快速切换标签会撤销迟到的 Blob URL");
} finally {
  try {
    await act(async () => rootView.unmount());
    host.remove();
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    window.close();
    for (const channel of taskChannels) {
      for (const port of [channel.port1, channel.port2]) {
        port.unref();
        port.close();
      }
    }
    globalThis.MessageChannel = NativeMessageChannel;
  }
}
